/**
 * Boot power policy (optimize-system-process-cycle plan, Phase 2): answers ONE
 * question — may heavy encoders start yet? — so the recording manager can run
 * the near-zero-CPU bridge-only pipeline while the modem is still enumerating,
 * possibly CRESET-ing, and cold-acquiring GNSS (the worst-case simultaneous
 * PSU draw on a marginal supply), then flip to full capture the moment the
 * modem reaches a verdict.
 *
 * The decision is deliberately separable from the manager wiring: this module
 * is the home for all "power says no" logic. It holds two independent
 * evaluators:
 *  - BootDeferPolicy (Phase 2): one-shot boot staging, LATCHES its first allow.
 *  - LoadShedPolicy (Phase 3): runtime undervoltage load shedding — fully
 *    reversible (never latches), fed measured power samples at ~1 Hz.
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
 *
 * TIME (Phase 6, 2026-07-30): every INTERVAL in this module is measured on a
 * monotonic clock. Wall-clock interval math is a field-proven hazard here — a
 * device that boots from a stale fake-hwclock and then gets an NTP (or GPS/NITZ)
 * step forward saw its boot-defer timers "expire" instantly (iteration 1: a
 * +53 y step made the defer release `timeout` at real +33 s and `stale` at real
 * +64 s). Wall clock is used for exactly one thing: comparing telemetry.json's
 * own wall-clock stamp, and even there the staleness verdict additionally
 * requires that the file stopped CHANGING for the stale window (measured
 * monotonically), so a clock step can no longer forge a dead daemon.
 */
import { readFileSync } from "node:fs";
import { LTE_TELEMETRY_FILE } from "../hardware/modem.js";

/** Monotonic milliseconds (never steps; see the TIME note above). */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

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
  /** Wall clock (for telemetry.json's own wall-clock stamp). */
  nowMs: number;
  /** MONOTONIC time since the policy started watching (missing-file grace + hard cap). */
  elapsedMs: number;
  /**
   * MONOTONIC time since telemetry.json's `timestamp` last CHANGED (null = no
   * file / never seen a stamp). The clock-step guard: a daemon that keeps
   * rewriting the file is alive no matter what the wall clock claims.
   */
  telemetryUnchangedMs: number | null;
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
    // "Old" needs BOTH arms: the stamp reads old in wall-clock terms AND the
    // file has not been rewritten for the stale window (monotonic). A clock
    // step forward trips only the first arm, so it can no longer forge a dead
    // daemon; a genuinely dead daemon trips both within the same window.
    const ts = typeof t.timestamp === "string" ? Date.parse(t.timestamp) : NaN;
    const stale =
      !Number.isFinite(ts) ||
      (input.nowMs - ts > input.staleMs &&
        (input.telemetryUnchangedMs ?? Number.POSITIVE_INFINITY) > input.staleMs);
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
  /** Wall clock — telemetry.json's own stamp only. */
  now?: () => number;
  /** Monotonic clock — every interval (grace window, hard cap, file freshness). */
  monoMs?: () => number;
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
  private readonly monoMs: () => number;
  private readonly startMono: number;
  /** undefined = not read yet; null = unreadable (non-Pi / dev box). */
  private budgetMa: number | null | undefined;
  /** Last telemetry.json stamp seen + when (monotonic) it changed to that value. */
  private lastStamp: string | null | undefined;
  private lastStampMono = 0;
  private latched: BootDeferVerdict | null = null;
  private last: BootDeferVerdict | null = null;

  constructor(opts: BootDeferPolicyOptions = {}) {
    this.telemetryFile = opts.telemetryFile ?? LTE_TELEMETRY_FILE;
    this.budgetPath = opts.budgetPath ?? MAX_CURRENT_PATH;
    this.staleMs = opts.staleMs ?? TELEMETRY_STALE_MS;
    this.now = opts.now ?? Date.now;
    this.monoMs = opts.monoMs ?? monotonicMs;
    this.startMono = this.monoMs();
  }

  /**
   * May heavy encoders start yet? Cheap (two tmpfs/procfs reads worst case);
   * safe to call every poll tick. Any allow latches permanently.
   */
  evaluate(cfg: BootDeferConfig): BootDeferVerdict {
    if (this.latched) return this.latched;
    if (this.budgetMa === undefined) this.budgetMa = this.readBudgetMa();
    const mono = this.monoMs();
    const telemetry = this.readTelemetry();
    const verdict = decideBootDefer(cfg, {
      budgetMa: this.budgetMa,
      telemetry,
      nowMs: this.now(),
      elapsedMs: mono - this.startMono,
      telemetryUnchangedMs: this.noteStamp(telemetry, mono),
      staleMs: this.staleMs,
    });
    this.last = verdict;
    if (verdict.allow) this.latched = verdict;
    return verdict;
  }

  /**
   * Track how long (monotonically) telemetry.json has carried the SAME stamp.
   * A file we have only just started watching counts as fresh — same grace the
   * missing-file path gets, and the hard cap still bounds it.
   */
  private noteStamp(t: PolicyTelemetry | null, mono: number): number | null {
    if (t === null) {
      this.lastStamp = undefined;
      return null;
    }
    const stamp = typeof t.timestamp === "string" ? t.timestamp : null;
    if (stamp !== this.lastStamp) {
      this.lastStamp = stamp;
      this.lastStampMono = mono;
    }
    return mono - this.lastStampMono;
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

// ---------------------------------------------------------------------------
// Runtime undervoltage load shedding (Phase 3)
// ---------------------------------------------------------------------------
//
// When the 5 V rail is measurably failing, shed CPU load in value order —
// live streaming (a convenience) before recording (the product) — and restore
// in reverse with hysteresis once the rail is healthy. Triggers only on the
// firmware's own measurements (the CURRENT undervoltage bit / EXT5V rail
// voltage the agent already samples); sticky bits are history and never
// trigger. A rolling-hour cycle cap parks a genuinely bad supply at its shed
// level instead of letting it flap all day (Q4/README principle 4).

/** Shed ladder rungs (Q3: 2-rung, preset downgrade scrapped). Extensible by design. */
export type ShedLevel = 0 | 1 | 2;

/** Human names per rung: 0 = everything on, 1 = live KVS off, 2 = recording off too. */
export const SHED_LEVELS = ["full", "no-live", "bridge-only"] as const;

/**
 * The Phase 3 knobs (device setting `recording.powerShedding.*`) — Q4: the
 * defaults are STARTING values; every one is cloud-tunable so the Phase 5
 * field loop needs no redeploy.
 */
export interface ShedConfig {
  enabled: boolean;
  /** Shed when this many undervoltage samples land within uvWindowSecs. */
  uvSamples: number;
  uvWindowSecs: number;
  /** ... OR the rail stays below this for railLowSecs straight. */
  railLowVolts: number;
  railLowSecs: number;
  /** Trailing window evaluated for escalation to the next rung. */
  escalateDwellSecs: number;
  /**
   * Phase 6 (2026-07-30): escalate when the supply was bad for at least this
   * percentage of the trailing `escalateDwellSecs` window — "bad" being the
   * shed trigger OR an individual unhealthy sample (see ShedSignals.dirty).
   * 100 reproduces the old "continuously bad for the whole dwell" semantics,
   * which the field proved unreachable on a real sagging rail (the samples
   * bounce back above any usable threshold every few seconds).
   */
  escalateDutyPct: number;
  /** Clean interval (no UV, rail at/above railRestoreVolts) per restored rung. */
  restoreSecs: number;
  railRestoreVolts: number;
  /** Shed cycles per rolling hour before parking at the shed level. */
  maxShedsPerHour: number;
}

/** One ~1 Hz power reading (see agent/collectors samplePower). */
export interface PowerSampleReading {
  /** CURRENT undervoltage bit (0x1) of the throttle mask. */
  uv: boolean;
  /** EXT5V rail voltage; null when the PMIC ADC is unavailable (Pi 4). */
  railV: number | null;
}

interface PowerSample extends PowerSampleReading {
  /** MONOTONIC ms at the reading (see the module TIME note). */
  tMs: number;
}

/**
 * Rail-trigger freshness guard: the sustained-low check infers "still low"
 * from the absence of a healthy reading, so it must not fire off a dead
 * sampler. UV positives need no guard — they age out of their window.
 */
export const POWER_SAMPLE_STALE_MS = 5_000;

/** What the sample window currently says (pure, exported for tests). */
export interface ShedSignals {
  trigger: boolean;
  /**
   * Is the NEWEST sample itself unhealthy by the trigger's own thresholds (UV
   * bit set, or rail below railLowVolts)? This is the escalation duty-cycle's
   * input (Phase 6): the debounced `trigger` drops out on every bounce back
   * over the threshold, while the samples themselves stay predominantly bad —
   * which is exactly the field state that crashed the device at rung 1.
   */
  dirty: boolean;
  /** Trigger rationale for the transition log; null when not triggering. */
  why: string | null;
  /** Newest "dirty" sample (UV, or rail below railRestoreVolts); null if none in window. */
  lastDirtyMs: number | null;
}

export function computeShedSignals(
  samples: readonly PowerSample[],
  cfg: ShedConfig,
  nowMs: number,
): ShedSignals {
  const newest = samples[samples.length - 1];
  const fresh = newest !== undefined && nowMs - newest.tMs <= POWER_SAMPLE_STALE_MS;

  const uvCount = samples.filter((s) => s.uv && nowMs - s.tMs <= cfg.uvWindowSecs * 1000).length;

  // Sustained rail low: the low run since the last healthy (>= threshold)
  // reading must span railLowSecs. Only meaningful while sampling is live.
  let lowRunStartMs: number | null = null;
  let lastRail: number | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const r = samples[i].railV;
    if (r === null) continue;
    if (lastRail === null) lastRail = r;
    if (r >= cfg.railLowVolts) break;
    lowRunStartMs = samples[i].tMs;
  }
  const railLow =
    fresh && lowRunStartMs !== null && nowMs - lowRunStartMs >= cfg.railLowSecs * 1000;

  let lastDirtyMs: number | null = null;
  for (const s of samples) {
    if (s.uv || (s.railV !== null && s.railV < cfg.railRestoreVolts)) lastDirtyMs = s.tMs;
  }

  const dirty =
    fresh &&
    newest !== undefined &&
    (newest.uv || (newest.railV !== null && newest.railV < cfg.railLowVolts));

  const why =
    uvCount >= cfg.uvSamples
      ? `undervoltage ${uvCount}x in ${cfg.uvWindowSecs}s`
      : railLow
        ? `rail ${lastRail?.toFixed(2)}V < ${cfg.railLowVolts}V for ${cfg.railLowSecs}s`
        : null;
  return { trigger: why !== null, dirty, why, lastDirtyMs };
}

/**
 * One trigger-state edge: the trigger became `on` at `tMs` and stayed that way
 * until the next entry (or now). Only EDGES are stored, so a steady state costs
 * one entry no matter how long it lasts.
 */
export interface TriggerEdge {
  tMs: number;
  on: boolean;
}

/** Ladder state — plain data so the transition core stays pure. */
export interface ShedState {
  level: ShedLevel;
  /** Cycle cap exhausted: no more restores until reboot/settings change. */
  parked: boolean;
  /** Last level transition (restore/escalate interval anchor). */
  lastChangeMs: number;
  /** Trigger history over (at least) the trailing escalation window. */
  triggerLog: TriggerEdge[];
  /** Shed cycle starts (level 0 → 1) within the rolling hour. */
  shedStartsMs: number[];
}

export function initialShedState(nowMs: number): ShedState {
  return { level: 0, parked: false, lastChangeMs: nowMs, triggerLog: [], shedStartsMs: [] };
}

/**
 * Append this tick's trigger state, coalescing runs (only edges are kept), and
 * drop history older than the trailing window — keeping the one entry that
 * straddles the window start, since it describes the state at that instant.
 */
function appendTrigger(
  log: readonly TriggerEdge[],
  on: boolean,
  nowMs: number,
  windowMs: number,
): TriggerEdge[] {
  const out =
    log.length > 0 && log[log.length - 1].on === on ? [...log] : [...log, { tMs: nowMs, on }];
  const cutoff = nowMs - windowMs;
  let keepFrom = 0;
  for (let i = 0; i < out.length; i++) if (out[i].tMs <= cutoff) keepFrom = i;
  return keepFrom > 0 ? out.slice(keepFrom) : out;
}

/**
 * Fraction of the trailing `windowMs` during which the trigger was active
 * (time-weighted, so an irregular evaluation cadence can't skew it). Returns
 * null while the window is not yet fully covered since `sinceMs` (the rung
 * change) — a rung must always be observed for a full window before the next
 * one engages, exactly as the old continuous dwell required.
 */
export function triggerDutyCycle(
  log: readonly TriggerEdge[],
  sinceMs: number,
  nowMs: number,
  windowMs: number,
): number | null {
  if (windowMs <= 0) return 1;
  const start = nowMs - windowMs;
  if (start < sinceMs) return null;
  let onMs = 0;
  for (let i = 0; i < log.length; i++) {
    const from = Math.max(log[i].tMs, start);
    const to = i + 1 < log.length ? log[i + 1].tMs : nowMs;
    // Time before the first edge counts as "not triggered" (unknown = clean).
    if (to > from && log[i].on) onMs += to - from;
  }
  return onMs / windowMs;
}

export interface ShedEvent {
  level: "info" | "warn";
  msg: string;
}

const HOUR_MS = 3_600_000;

/**
 * Pure ladder transition core: one evaluation tick.
 *
 * Escalation (Phase 6) is DUTY-CYCLE based: the trigger must have been active
 * for at least `escalateDutyPct` of the trailing `escalateDwellSecs`, measured
 * from the rung change — so a long-standing trigger still cannot skip past a
 * rung, but a bouncing rail (the field reality: 74 % low samples, longest
 * unbroken low run 40 s) does reach the next rung instead of crashing at the
 * first one. The check runs on triggered ticks only, which at worst delays an
 * escalation to the next dirty sample.
 */
export function decideShedTransition(
  cfg: ShedConfig,
  prev: ShedState,
  sig: ShedSignals,
  nowMs: number,
): { state: ShedState; event: ShedEvent | null } {
  const dwellMs = cfg.escalateDwellSecs * 1000;
  // What counts as "still bad" for escalation: the debounced trigger OR a
  // single unhealthy sample. The rail arm's 15 s debounce is right for DECIDING
  // to shed and wrong for measuring how bad the supply stays afterwards.
  const s: ShedState = {
    ...prev,
    shedStartsMs: prev.shedStartsMs.filter((t) => nowMs - t <= HOUR_MS),
    triggerLog: appendTrigger(prev.triggerLog, sig.trigger || sig.dirty, nowMs, dwellMs),
  };

  if (sig.trigger) {
    if (s.level === 0) {
      s.level = 1;
      s.lastChangeMs = nowMs;
      s.shedStartsMs = [...s.shedStartsMs, nowMs];
      let msg = `power shed → no-live (${sig.why}): live streaming off, recording continues`;
      if (s.shedStartsMs.length > cfg.maxShedsPerHour) {
        s.parked = true;
        msg += `; shed-cycle cap (${cfg.maxShedsPerHour}/h) exhausted — parked until reboot or settings change`;
      }
      return { state: s, event: { level: "warn", msg } };
    }
    if (s.level === 1) {
      const duty = triggerDutyCycle(s.triggerLog, s.lastChangeMs, nowMs, dwellMs);
      if (duty !== null && duty * 100 >= cfg.escalateDutyPct) {
        s.level = 2;
        s.lastChangeMs = nowMs;
        return {
          state: s,
          event: {
            level: "warn",
            msg:
              `power shed → bridge-only (${sig.why}, triggered ${Math.round(duty * 100)}% of the ` +
              `last ${cfg.escalateDwellSecs}s past no-live): video recording off, telemetry recording continues`,
          },
        };
      }
    }
    return { state: s, event: null };
  }

  if (s.level > 0 && !s.parked) {
    // Fail open: with no dirty sample on record (sampler gone quiet), the
    // clean interval alone restores — shedding must never strand a healthy
    // device below full operation.
    const anchor = Math.max(s.lastChangeMs, sig.lastDirtyMs ?? 0);
    if (nowMs - anchor >= cfg.restoreSecs * 1000) {
      s.level = (s.level - 1) as ShedLevel;
      s.lastChangeMs = nowMs;
      return {
        state: s,
        event: {
          level: "info",
          msg: `power shed restore → ${SHED_LEVELS[s.level]} (rail clean for ${cfg.restoreSecs}s)`,
        },
      };
    }
  }
  return { state: s, event: null };
}

export interface ShedVerdict {
  level: ShedLevel;
  parked: boolean;
  /** Log-worthy transition this evaluation produced; null when steady. */
  event: ShedEvent | null;
}

export interface LoadShedPolicyOptions {
  /**
   * Monotonic clock (test seam). EVERY timestamp this policy stores — sample
   * ages, rung changes, the escalation window, the rolling-hour cap — lives on
   * this clock, so an NTP/GPS clock step mid-drive cannot expire a dwell or
   * age out the cycle cap.
   */
  monoMs?: () => number;
}

/**
 * Stateful wrapper the recording manager holds: buffers pushed power samples,
 * evaluates the ladder on the manager's shed tick, and — unlike
 * BootDeferPolicy — never latches (shedding is reversible by design). All
 * decisions are made from data already pushed; evaluate() itself never probes
 * hardware.
 */
export class LoadShedPolicy {
  private readonly now: () => number;
  private samples: PowerSample[] = [];
  private state: ShedState;

  constructor(opts: LoadShedPolicyOptions = {}) {
    this.now = opts.monoMs ?? monotonicMs;
    this.state = initialShedState(this.now());
  }

  /** Record one power reading (manager's ~1 Hz tick). */
  push(reading: PowerSampleReading): void {
    this.samples.push({ ...reading, tMs: this.now() });
    // Backstop prune so a caller that only pushes can never grow unbounded;
    // evaluate() prunes precisely per config.
    if (this.samples.length > 4000) this.samples.splice(0, this.samples.length - 4000);
  }

  /** Evaluate the ladder for this tick. Never latches; safe to call often. */
  evaluate(cfg: ShedConfig): ShedVerdict {
    const nowMs = this.now();
    if (!cfg.enabled) {
      const wasActive = this.state.level > 0 || this.state.parked;
      this.reset();
      return {
        level: 0,
        parked: false,
        event: wasActive
          ? { level: "info", msg: "power shedding disabled by settings — restoring full operation" }
          : null,
      };
    }
    const horizonMs =
      Math.max(cfg.uvWindowSecs, cfg.railLowSecs, cfg.restoreSecs) * 1000 + POWER_SAMPLE_STALE_MS;
    this.samples = this.samples.filter((s) => nowMs - s.tMs <= horizonMs);
    const signals = computeShedSignals(this.samples, cfg, nowMs);
    const { state, event } = decideShedTransition(cfg, this.state, signals, nowMs);
    this.state = state;
    return { level: state.level, parked: state.parked, event };
  }

  /** Forget everything (settings change / monitor disarm — clears park + cap). */
  reset(): void {
    this.samples = [];
    this.state = initialShedState(this.now());
  }

  /** Current rung as a state.json-friendly string; null at full operation. */
  statusString(): string | null {
    if (this.state.level === 0 && !this.state.parked) return null;
    const name = SHED_LEVELS[this.state.level];
    return this.state.parked ? `parked:${name}` : name;
  }
}
