/**
 * Boot power policy (optimize-system-process-cycle plan, Phase 2): answers ONE
 * question — may heavy encoders start yet? — so the recording manager can run
 * the near-zero-CPU bridge-only pipeline while the modem is still enumerating,
 * possibly CRESET-ing, and cold-acquiring GNSS (the worst-case simultaneous
 * PSU draw on a marginal supply), then flip to full capture the moment the
 * modem reaches a verdict.
 *
 * The decision is deliberately separable from the manager wiring: Phase 3's
 * runtime undervoltage shedding reuses this module as the home for
 * "power says no" logic.
 *
 * Semantics (Q1/Q2, resolved 2026-07-28/29):
 *  - Arming (`recording.video.bootDefer`): "auto" arms only when the firmware
 *    negotiated a supply budget below `bootDeferMinBudgetMa` (a true 5 V/5 A
 *    PD supply is in-spec for simultaneous start — defer would only cost
 *    footage); "always" arms every boot; "off" is today's behavior
 *    (`bootDeferMaxSecs` 0 keeps working as off too).
 *  - Release on the FIRST of: daemon status connected/dead_zone; reg 1/5 while
 *    connecting; telemetry.json stale/missing >60 s (fail open — daemon absent
 *    or dead must never keep a healthy device from recording); the
 *    `bootDeferMaxSecs` hard cap.
 *  - One-shot per process: any allow verdict LATCHES. Once encoders were
 *    allowed to start, the boot window is over — runtime reactions are
 *    Phase 3's job, not this module's.
 *
 * Everything fails open: unreadable budget arms the defer (the cap still
 * bounds it), unreadable/stale telemetry releases it.
 */
import { readFileSync } from "node:fs";
import { LTE_TELEMETRY_FILE } from "../hardware/modem.js";

/** Arming mode for the boot defer (device setting `recording.video.bootDefer`). */
export type BootDeferMode = "auto" | "always" | "off";

/** The three Q1/Q2 knobs, resolved from settings on every evaluation. */
export interface BootDeferConfig {
  mode: BootDeferMode;
  /** Hard cap on the defer, seconds; <=0 = feature off (today's behavior). */
  maxSecs: number;
  /** `auto` arms only below this negotiated budget (mA). */
  minBudgetMa: number;
}

export type BootDeferState = "off" | "skipped" | "deferring" | "released";

export interface BootDeferVerdict {
  /** May heavy encoders start yet? */
  allow: boolean;
  state: BootDeferState;
  /**
   * Stable detail: the release reason ("connected" | "dead_zone" | "reg" |
   * "stale" | "timeout"), the skip/arm rationale (budget comparison), or
   * "disabled". Kept tick-stable so callers can log on change.
   */
  why: string;
}

/** Q2: telemetry.json older (or absent longer) than this = daemon dead → fail open. */
export const TELEMETRY_STALE_MS = 60_000;

/** Firmware-negotiated PSU budget node (see hardware/power.ts readMaxCurrentMa). */
const MAX_CURRENT_PATH = "/proc/device-tree/chosen/power/max_current";

/** Subset of the daemon's telemetry.json this policy reads. */
interface PolicyTelemetry {
  timestamp?: unknown;
  status?: unknown;
  reg?: unknown;
}

export interface BootDeferInputs {
  /** Negotiated supply budget in mA; null = unreadable (non-Pi) → keep the defer. */
  budgetMa: number | null;
  /** Parsed telemetry.json; null = file missing or unparseable. */
  telemetry: PolicyTelemetry | null;
  /** Wall clock (for telemetry.json age). */
  nowMs: number;
  /** Time since the policy started watching (missing-file grace + hard cap). */
  elapsedMs: number;
  staleMs: number;
}

/**
 * Pure decision core (exported for tests). Evaluates one tick; latching is the
 * caller's job.
 */
export function decideBootDefer(cfg: BootDeferConfig, input: BootDeferInputs): BootDeferVerdict {
  if (cfg.mode === "off" || cfg.maxSecs <= 0) {
    return { allow: true, state: "off", why: "disabled" };
  }
  const budgetText = input.budgetMa === null ? "psu budget unknown" : `psu budget ${input.budgetMa}mA`;
  if (cfg.mode === "auto" && input.budgetMa !== null && input.budgetMa >= cfg.minBudgetMa) {
    return { allow: true, state: "skipped", why: `${budgetText} >= ${cfg.minBudgetMa}` };
  }

  const t = input.telemetry;
  if (t !== null) {
    // Freshness first only for the DEAD-daemon shape (old timestamp while the
    // status still claims activity); a terminal status wins either way.
    const ts = typeof t.timestamp === "string" ? Date.parse(t.timestamp) : NaN;
    const stale = !Number.isFinite(ts) || input.nowMs - ts > input.staleMs;
    if (t.status === "connected" || t.status === "dead_zone") {
      return { allow: true, state: "released", why: t.status };
    }
    if (stale) {
      return { allow: true, state: "released", why: "stale" };
    }
    if (t.status === "connecting" && (t.reg === 1 || t.reg === 5)) {
      return { allow: true, state: "released", why: "reg" };
    }
  } else if (input.elapsedMs > input.staleMs) {
    // The daemon writes telemetry.json only once it reaches its signal loop —
    // absence right after boot is normal. Absence past the stale window means
    // the daemon isn't there at all (unit disabled, modem never enumerated).
    return { allow: true, state: "released", why: "stale" };
  }

  if (input.elapsedMs >= cfg.maxSecs * 1000) {
    return { allow: true, state: "released", why: "timeout" };
  }

  const armText = cfg.mode === "always" ? "mode=always" : `${budgetText} < ${cfg.minBudgetMa}`;
  return { allow: false, state: "deferring", why: armText };
}

export interface BootDeferPolicyOptions {
  /** Test seams / overrides. */
  telemetryFile?: string;
  budgetPath?: string;
  staleMs?: number;
  now?: () => number;
}

/**
 * Stateful wrapper the recording manager holds: reads the budget once (static
 * per boot), re-reads telemetry.json on every evaluation (the manager's 5 s
 * settings poll is the tick — no timers here), and latches the first allow
 * verdict for the life of the process.
 */
export class BootDeferPolicy {
  private readonly telemetryFile: string;
  private readonly budgetPath: string;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly startMs: number;
  /** undefined = not read yet; null = unreadable (non-Pi / dev box). */
  private budgetMa: number | null | undefined;
  private latched: BootDeferVerdict | null = null;
  private last: BootDeferVerdict | null = null;

  constructor(opts: BootDeferPolicyOptions = {}) {
    this.telemetryFile = opts.telemetryFile ?? LTE_TELEMETRY_FILE;
    this.budgetPath = opts.budgetPath ?? MAX_CURRENT_PATH;
    this.staleMs = opts.staleMs ?? TELEMETRY_STALE_MS;
    this.now = opts.now ?? Date.now;
    this.startMs = this.now();
  }

  /**
   * May heavy encoders start yet? Cheap (two tmpfs/procfs reads worst case);
   * safe to call every poll tick. Any allow latches permanently.
   */
  evaluate(cfg: BootDeferConfig): BootDeferVerdict {
    if (this.latched) return this.latched;
    if (this.budgetMa === undefined) this.budgetMa = this.readBudgetMa();
    const verdict = decideBootDefer(cfg, {
      budgetMa: this.budgetMa,
      telemetry: this.readTelemetry(),
      nowMs: this.now(),
      elapsedMs: this.now() - this.startMs,
      staleMs: this.staleMs,
    });
    this.last = verdict;
    if (verdict.allow) this.latched = verdict;
    return verdict;
  }

  /** Last verdict as a state.json-friendly string; null before first evaluate. */
  statusString(): string | null {
    if (!this.last) return null;
    return this.last.state === "released" ? `released:${this.last.why}` : this.last.state;
  }

  private readBudgetMa(): number | null {
    try {
      const buf = readFileSync(this.budgetPath);
      if (buf.length < 4) return null;
      return buf.readUInt32BE(0); // device-tree u32s are big-endian
    } catch {
      return null;
    }
  }

  private readTelemetry(): PolicyTelemetry | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.telemetryFile, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as PolicyTelemetry;
    } catch {
      return null;
    }
  }
}
