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
 *
 * STAGE 2 — the GPS/LTE video gate (Phase 7, Q8, 2026-07-30). On a constrained
 * budget the boot window is not over when the modem attaches: GNSS is still
 * cold-acquiring, and the field showed ~25 min TTFF on 3 A drives where video
 * took the power back after 90 s. So `recording.video.gpsGate` extends the same
 * policy to hold video (recording AND live) until the modem stops converting
 * power into value — releasing on LTE-connected + GPS fix, a declared dead
 * zone, a sustained no-RF sky (a fix is not coming), the `gpsGateMaxSecs`
 * give-up cap (0 = no time cap), or the same fail-open rules. Stage 2 arms
 * exactly like stage 1 (budget-gated `auto` / `always` / `off`) and supersedes
 * stage 1 while armed — this is ONE policy with two stages, deliberately not a
 * second policy fighting over applyVideo().
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
import type { GnssView } from "../lib/sky-state.js";

/** Monotonic milliseconds (never steps; see the TIME note above). */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Arming mode for the boot defer (device setting `recording.video.bootDefer`). */
export type BootDeferMode = "auto" | "always" | "off";

/** The Q1/Q2 knobs plus the Q8 gate knobs, resolved from settings per evaluation. */
export interface BootDeferConfig {
  mode: BootDeferMode;
  /** Hard cap on the stage-1 defer, seconds; <=0 = stage 1 off (today's behavior). */
  maxSecs: number;
  /** `auto` arms only below this negotiated budget (mA); shared by both stages. */
  minBudgetMa: number;
  /**
   * Stage 2 arming (device setting `recording.video.gpsGate`, Phase 7/Q8):
   * hold video until the modem has finished converting power into value.
   */
  gateMode: BootDeferMode;
  /** Stage-2 give-up cap, seconds; 0 = no time cap (Q8: both behaviors required). */
  gateMaxSecs: number;
  /**
   * Stage-2 NO-PROGRESS escape hatch, seconds; 0 = off (Phase 10 iteration 2).
   *
   * Every other gate release asks a subsystem to report on itself, and the
   * 2026-07-30 garage drive found all of them blind at once: no LTE (so the
   * `gps-fix` arm cannot fire), CSQ 99 rather than 1–9 (so the daemon wrote
   * `disconnected`, not `dead_zone`), and a module reporting a constant 4
   * satellites at ~36 dBHz with no fix (so the sky read `clear`, never
   * `no-rf`). Only the 600 s cap was left, and 5 min 37 s of garage video was
   * lost to it — recovered only because the exit ramp happened to produce
   * CSQ=2.
   *
   * This arm keys on the ABSENCE OF PROGRESS instead: GNSS has not produced a
   * fix AND LTE has not connected, for this long. If neither has moved, the
   * modem is by definition not converting power into value, whatever any
   * individual signal claims. Deliberately cannot fire while LTE IS connected
   * — that is the genuinely-acquiring case where patience is right, and the
   * `gateMaxSecs` cap still bounds it.
   */
  gateNoProgressSecs: number;
}

export type BootDeferState = "off" | "skipped" | "deferring" | "gating" | "released";

export interface BootDeferVerdict {
  /** May heavy encoders start yet? */
  allow: boolean;
  state: BootDeferState;
  /**
   * Stable detail: the release reason ("connected" | "dead_zone" | "reg" |
   * "stale" | "timeout" | "gps-fix" | "no-rf" | "no-progress" |
   * "gate-timeout"), the skip/arm rationale (budget comparison), or
   * "disabled". Kept tick-stable so callers can log on change.
   */
  why: string;
  /**
   * Should live streaming be held down too? True only while STAGE 2 is what is
   * deferring: the GPS/LTE gate covers recording AND live (Q8), whereas the
   * stage-1 modem-settle defer deliberately leaves live alone (Phase 2 — the
   * KVS masters start lazily after MQTT anyway).
   */
  holdLive: boolean;
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
  /**
   * GNSS view for stage 2 (Phase 7). null = no GNSS collector on this host, in
   * which case the gate cannot arm: a device with no receiver would otherwise
   * hold video for the whole give-up cap on every boot, waiting for a fix that
   * is not coming (README principle 5, fail open).
   */
  gnss: GnssView | null;
}

/**
 * Pure decision core (exported for tests). Evaluates one tick; latching is the
 * caller's job.
 *
 * Two stages of one policy (Phase 7 supersedes the Phase 2 shape rather than
 * adding a second policy that would fight over applyVideo()):
 *  - stage 1, "deferring": the modem-settle defer — hold heavy encoders while
 *    the modem enumerates/attaches, bounded by `maxSecs`.
 *  - stage 2, "gating": the GPS/LTE gate — hold video (recording AND live)
 *    until the modem stops converting power into value, bounded by
 *    `gateMaxSecs` (0 = unbounded by time; the other release paths still hold).
 *
 * When stage 2 is armed it SUPERSEDES stage 1 outright — a gated boot never
 * releases on `reg` or the stage-1 cap, because those mean "LTE is coming up",
 * which is precisely what the gate is waiting through.
 */
export function decideBootDefer(cfg: BootDeferConfig, input: BootDeferInputs): BootDeferVerdict {
  const budgetText = input.budgetMa === null ? "psu budget unknown" : `psu budget ${input.budgetMa}mA`;
  const highBudget = input.budgetMa !== null && input.budgetMa >= cfg.minBudgetMa;

  const settleOff = cfg.mode === "off" || cfg.maxSecs <= 0;
  const settleArmed = !settleOff && !(cfg.mode === "auto" && highBudget);
  const gateOff = cfg.gateMode === "off" || input.gnss === null;
  const gateArmed = !gateOff && !(cfg.gateMode === "auto" && highBudget);

  if (!settleArmed && !gateArmed) {
    return settleOff && gateOff
      ? { allow: true, state: "off", why: "disabled", holdLive: false }
      : {
          allow: true,
          state: "skipped",
          why: `${budgetText} >= ${cfg.minBudgetMa}`,
          holdLive: false,
        };
  }

  const t = input.telemetry;
  // "Stale" needs BOTH arms: the stamp reads old in wall-clock terms AND the
  // file has not been rewritten for the stale window (monotonic). A clock step
  // forward trips only the first arm, so it can no longer forge a dead daemon;
  // a genuinely dead daemon trips both within the same window. With no file at
  // all, the daemon gets the same grace — it writes telemetry.json only once it
  // reaches its signal loop, so absence right after boot is normal.
  let stale: boolean;
  if (t !== null) {
    const ts = typeof t.timestamp === "string" ? Date.parse(t.timestamp) : NaN;
    stale =
      !Number.isFinite(ts) ||
      (input.nowMs - ts > input.staleMs &&
        (input.telemetryUnchangedMs ?? Number.POSITIVE_INFINITY) > input.staleMs);
  } else {
    stale = input.elapsedMs > input.staleMs;
  }

  const armText = gateArmed
    ? cfg.gateMode === "always"
      ? "mode=always"
      : `${budgetText} < ${cfg.minBudgetMa}`
    : cfg.mode === "always"
      ? "mode=always"
      : `${budgetText} < ${cfg.minBudgetMa}`;

  if (gateArmed) {
    // Release on the FIRST of (Q8, in order): the modem gave up on LTE; LTE is
    // up AND the fix landed; the daemon is gone (fail open); the sky says a fix
    // is not coming; the give-up cap.
    if (t !== null && t.status === "dead_zone") {
      return { allow: true, state: "released", why: "dead_zone", holdLive: false };
    }
    if (t !== null && t.status === "connected" && input.gnss?.fix === true) {
      return { allow: true, state: "released", why: "gps-fix", holdLive: false };
    }
    if (stale) {
      return { allow: true, state: "released", why: "stale", holdLive: false };
    }
    if (input.gnss?.sky === "no-rf") {
      return { allow: true, state: "released", why: "no-rf", holdLive: false };
    }
    // No-progress escape hatch: nothing on EITHER side has moved. Checked after
    // the specific arms (they are cheaper and name the cause better) and before
    // the blind cap.
    if (
      cfg.gateNoProgressSecs > 0 &&
      input.elapsedMs >= cfg.gateNoProgressSecs * 1000 &&
      input.gnss?.fix !== true &&
      (t === null || t.status !== "connected")
    ) {
      return { allow: true, state: "released", why: "no-progress", holdLive: false };
    }
    if (cfg.gateMaxSecs > 0 && input.elapsedMs >= cfg.gateMaxSecs * 1000) {
      return { allow: true, state: "released", why: "gate-timeout", holdLive: false };
    }
    return { allow: false, state: "gating", why: armText, holdLive: true };
  }

  if (t !== null) {
    // A terminal status wins over freshness either way.
    if (t.status === "connected" || t.status === "dead_zone") {
      return { allow: true, state: "released", why: t.status, holdLive: false };
    }
    if (stale) {
      return { allow: true, state: "released", why: "stale", holdLive: false };
    }
    if (t.status === "connecting" && (t.reg === 1 || t.reg === 5)) {
      return { allow: true, state: "released", why: "reg", holdLive: false };
    }
  } else if (stale) {
    // Absence past the stale window means the daemon isn't there at all (unit
    // disabled, modem never enumerated).
    return { allow: true, state: "released", why: "stale", holdLive: false };
  }

  if (input.elapsedMs >= cfg.maxSecs * 1000) {
    return { allow: true, state: "released", why: "timeout", holdLive: false };
  }

  return { allow: false, state: "deferring", why: armText, holdLive: false };
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
  /**
   * GNSS view for the stage-2 gate (Phase 7). Omit on hosts without a GPS
   * collector: the gate then never arms (see BootDeferInputs.gnss).
   */
  gnss?: () => GnssView | null;
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
  private readonly gnss: () => GnssView | null;
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
    this.gnss = opts.gnss ?? (() => null);
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
      gnss: this.gnss(),
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
  /**
   * ... OR the SoC runs at/above this for cpuTempSecs straight (°C).
   *
   * Thermal arm (power_management_improvements plan, Phase 1). A STARTING value
   * of 80: the Pi hard-throttles at 85 °C, so this sheds with a 5 °C margin
   * before the firmware caps clocks on its own. Deliberately NOT justified by
   * any assumed firmware soft-limit default — `vcgencmd get_config
   * temp_soft_limit` reads 0 (unset) on the CM5, so the effective point cannot
   * be read off the device (PROGRESS Q1).
   */
  cpuTempC: number;
  /** Restore needs the SoC at/below this — the anti-flap margin (°C). */
  cpuTempRestoreC: number;
  cpuTempSecs: number;
  /** Clean interval (no UV, rail at/above railRestoreVolts) per restored rung. */
  restoreSecs: number;
  railRestoreVolts: number;
  /** Shed cycles per rolling hour before parking at the shed level. */
  maxShedsPerHour: number;
}

/**
 * One ~1 Hz power reading (see agent/collectors samplePower).
 *
 * The two thermal fields are OPTIONAL on purpose: absent means "this host has
 * no thermal reading", which resolves to no-shed (README principle 1, fail
 * open). Producers that predate the thermal arm therefore keep their exact
 * pre-Phase-1 behavior with no change at all — which is also what makes the
 * untouched Phase-3 test suite a regression guard for it.
 */
export interface PowerSampleReading {
  /** CURRENT undervoltage bit (0x1) of the throttle mask. */
  uv: boolean;
  /** EXT5V rail voltage; null when the PMIC ADC is unavailable (Pi 4). */
  railV: number | null;
  /** SoC temperature in °C; null/absent when /sys/class/thermal is unreadable. */
  tempC?: number | null;
  /**
   * CURRENT soft-temperature-limit bit (0x8) of the throttle mask — the
   * firmware's own thermal verdict. Bits 0x2 (arm frequency capped) and 0x4
   * (currently throttled) are deliberately NOT read: they are consequences the
   * firmware sets for EITHER undervoltage or heat, so triggering on them would
   * make the shed reason unattributable (PROGRESS Q3).
   */
  softTemp?: boolean;
}

interface PowerSample extends PowerSampleReading {
  /** MONOTONIC ms at the reading (see the module TIME note). */
  tMs: number;
  /** Normalized at push(): null = no thermal reading on this host. */
  tempC: number | null;
  softTemp: boolean;
}

/**
 * Rail-trigger freshness guard: the sustained-low check infers "still low"
 * from the absence of a healthy reading, so it must not fire off a dead
 * sampler. UV positives need no guard — they age out of their window.
 */
export const POWER_SAMPLE_STALE_MS = 5_000;

/**
 * Which KIND of condition is triggering. `"power"` covers both power arms (the
 * UV bit and the rail), `"thermal"` covers both thermal ones (our own sustained
 * temperature and the firmware's 0x8 bit). Derived by the same precedence as
 * `why`, so when a hot device is ALSO on a bad supply the cause is `"power"`.
 *
 * Two consumers: the rung 1 → 2 escalation cap below (D4/Q2 — thermal must
 * never cost recording), and Phase 2's `liveBlock.reason`.
 */
export type ShedCause = "power" | "thermal";

/**
 * The same two cases as `ShedCause`, under the names the PUBLISHED contract
 * uses (`liveBlock.reason`, power_management_improvements Phase 2). `"power"`
 * covers the UV bit AND the rail arm, which is exactly what an operator reads
 * as undervoltage — so this is a rename at the boundary, not a second
 * discriminant. Never split it; never rename `ShedCause` to match.
 */
export type ShedBlockReason = "undervoltage" | "thermal";

/** What the sample window currently says (pure, exported for tests). */
export interface ShedSignals {
  trigger: boolean;
  /**
   * Is the NEWEST sample itself unhealthy by the trigger's own thresholds (UV
   * bit set, rail below railLowVolts, or SoC at/above cpuTempC)? This is the
   * escalation duty-cycle's input (Phase 6): the debounced `trigger` drops out
   * on every bounce back over the threshold, while the samples themselves stay
   * predominantly bad — which is exactly the field state that crashed the
   * device at rung 1.
   */
  dirty: boolean;
  /** Trigger rationale for the transition log; null when not triggering. */
  why: string | null;
  /** What is triggering (see ShedCause); null when not triggering. */
  cause: ShedCause | null;
  /**
   * Newest "dirty" sample — UV, rail below railRestoreVolts, or SoC at/above
   * cpuTempRestoreC. Null if none in window. This is the restore anchor, so it
   * uses the RESTORE thresholds, not the trigger ones: coming back down to
   * "not triggering" is not the same as being cool/clean enough to restore.
   */
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

  // Sustained SoC heat — the same run-walk as the rail, mirrored (at/above a
  // threshold rather than below one). Samples with no temperature are skipped,
  // not treated as a break: a host that loses its thermal zone for one tick
  // must not silently restart the run.
  let highRunStartMs: number | null = null;
  let lastTemp: number | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const t = samples[i].tempC;
    if (t === null) continue;
    if (lastTemp === null) lastTemp = t;
    if (t < cfg.cpuTempC) break;
    highRunStartMs = samples[i].tMs;
  }
  const tempHigh =
    fresh && highRunStartMs !== null && nowMs - highRunStartMs >= cfg.cpuTempSecs * 1000;
  // The firmware's own thermal verdict (0x8). Needs the freshness guard for the
  // same reason the rail run does: it is a level, not an event that ages out of
  // a window, so a dead sampler would otherwise hold the trigger on forever and
  // block restore. Measured 2026-08-05 on the bench CM5: 0x8 appears at ~82 °C,
  // i.e. the 80 °C threshold above fires first and this is the backstop.
  const softTemp = fresh && newest !== undefined && newest.softTemp;

  let lastDirtyMs: number | null = null;
  for (const s of samples) {
    if (
      s.uv ||
      (s.railV !== null && s.railV < cfg.railRestoreVolts) ||
      (s.tempC !== null && s.tempC >= cfg.cpuTempRestoreC) ||
      s.softTemp
    ) {
      lastDirtyMs = s.tMs;
    }
  }

  const dirty =
    fresh &&
    newest !== undefined &&
    (newest.uv ||
      (newest.railV !== null && newest.railV < cfg.railLowVolts) ||
      (newest.tempC !== null && newest.tempC >= cfg.cpuTempC) ||
      newest.softTemp);

  // Precedence: undervoltage, then rail, then thermal. Undervoltage is the one
  // that crashes the device, so it names the event.
  const why =
    uvCount >= cfg.uvSamples
      ? `undervoltage ${uvCount}x in ${cfg.uvWindowSecs}s`
      : railLow
        ? `rail ${lastRail?.toFixed(2)}V < ${cfg.railLowVolts}V for ${cfg.railLowSecs}s`
        : tempHigh
          ? `cpu ${lastTemp?.toFixed(1)}°C >= ${cfg.cpuTempC}°C for ${cfg.cpuTempSecs}s`
          : softTemp
            ? `cpu soft temp limit (throttle bit 0x8)`
            : null;
  const cause: ShedCause | null =
    why === null ? null : uvCount >= cfg.uvSamples || railLow ? "power" : "thermal";
  return { trigger: why !== null, dirty, why, cause, lastDirtyMs };
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
  /**
   * LATCHED cause of the shed currently in force; null at full operation
   * (power_management_improvements Phase 2).
   *
   * This has to be latched, not read from the live signals, because
   * `ShedSignals.cause` is null on every tick the trigger is not *currently*
   * firing while the ladder stays at its rung until the whole restore interval
   * elapses. Bench run D (2026-08-05) sat shed for ~7 minutes with the trigger
   * cleared after ~90 s — a reason derived per tick would blank out for the
   * other 5½ minutes while the block visibly persisted.
   */
  cause: ShedCause | null;
  /** The `ShedSignals.why` string that latched `cause`; null at full operation. */
  causeDetail: string | null;
}

export function initialShedState(nowMs: number): ShedState {
  return {
    level: 0,
    parked: false,
    lastChangeMs: nowMs,
    triggerLog: [],
    shedStartsMs: [],
    cause: null,
    causeDetail: null,
  };
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
    // Latch the cause + its rationale for `liveBlock.reason` (Phase 2). Written
    // on the level 0 → 1 edge and re-written only when the CAUSE itself changes
    // — a thermal shed that then acquires a bad supply becomes "power" and
    // escalates as power. Holding `causeDetail` steady while the cause is steady
    // is what keeps the manager's `since` stamp stable across ticks.
    if (sig.cause !== null && sig.cause !== s.cause) {
      s.cause = sig.cause;
      s.causeDetail = sig.why;
    }
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
    // D4/Q2: THERMAL CAPS AT RUNG 1 and must never reach rung 2. Undervoltage
    // is existential — a sagging rail hard-resets the Pi, which corrupts the
    // in-flight recording and wedges GNSS (the 2026-07-28 finding) — so trading
    // recording away to survive it is a good trade. Heat is self-limiting: the
    // firmware throttles clocks at ~85 °C and the device keeps running, so
    // killing recording would cost the product's actual output to avert a
    // condition that was never fatal. Degraded footage beats no footage.
    //
    // Scoped to the CAUSE, not a blanket disable: a hot device on a bad supply
    // has `cause === "power"` by the precedence in computeShedSignals, so it
    // escalates exactly as it does today. A merely-hot device holds at rung 1
    // for as long as it stays hot, still refreshing the restore anchor.
    if (s.level === 1 && sig.cause === "power") {
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
      // Back at full operation: nothing is blocked, so the latch clears. Above
      // rung 0 it is deliberately kept — rung 2 → 1 is still the same shed.
      if (s.level === 0) {
        s.cause = null;
        s.causeDetail = null;
      }
      return {
        state: s,
        event: {
          level: "info",
          // "clean" spans every arm: no UV, rail at/above railRestoreVolts, AND
          // the SoC at/below cpuTempRestoreC for the whole interval.
          msg: `power shed restore → ${SHED_LEVELS[s.level]} (clean for ${cfg.restoreSecs}s)`,
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
  /**
   * LATCHED reason for the shed in force, under its published name — the
   * `liveBlock.reason` input (Phase 2). Null at full operation; non-null for
   * the whole time `level >= 1`, including the stretch after the trigger has
   * cleared but before the restore interval elapses.
   */
  reason: ShedBlockReason | null;
  /** The trigger rationale that latched `reason` (tooltip detail); null at full operation. */
  detail: string | null;
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
    // Normalize the optional thermal halves once, here, so the pure decision
    // core only ever sees "a reading, or an explicit null".
    this.samples.push({
      ...reading,
      tempC: reading.tempC ?? null,
      softTemp: reading.softTemp ?? false,
      tMs: this.now(),
    });
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
        reason: null,
        detail: null,
      };
    }
    const horizonMs =
      Math.max(cfg.uvWindowSecs, cfg.railLowSecs, cfg.cpuTempSecs, cfg.restoreSecs) * 1000 +
      POWER_SAMPLE_STALE_MS;
    this.samples = this.samples.filter((s) => nowMs - s.tMs <= horizonMs);
    const signals = computeShedSignals(this.samples, cfg, nowMs);
    const { state, event } = decideShedTransition(cfg, this.state, signals, nowMs);
    this.state = state;
    return {
      level: state.level,
      parked: state.parked,
      event,
      // The one place the internal discriminant is renamed for the wire (see
      // ShedBlockReason). "power" covers the UV bit and the rail alike.
      reason:
        state.cause === null ? null : state.cause === "power" ? "undervoltage" : "thermal",
      detail: state.causeDetail,
    };
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
