/**
 * Offline clock stepper (optimize-system-process-cycle plan, Phase 4, Q5).
 *
 * A battery-less CM5 boots with a wrong wall clock and stays wrong until NTP
 * lands over LTE (4–5 min on a good drive; never in a dead zone / underground
 * garage). This service shrinks that window using time the device already
 * has: GPS UTC from the NMEA stream (preferred — stratum-0 when a fix is
 * valid) or the modem's NITZ-disciplined clock exported by the sim7600-lte
 * daemon (fallback — carrier-dependent, second granularity, needs only
 * network registration, not a data path).
 *
 * Guards (all mandatory, Q5):
 *  - Kill switch: `timeSync.offlineSources` device setting (default on).
 *  - Self-disarm: steps only while timedatectl reports NTPSynchronized=no;
 *    the first probe that sees "yes" stands the stepper down for the rest of
 *    the boot (the kernel flag never reverts within a boot, so this also
 *    survives agent restarts). A future battery-backed RTC boots inside the
 *    offset threshold, making the whole feature a natural no-op.
 *  - Threshold: steps only when |offset| > `stepThresholdSecs` (default 10 s).
 *  - Hold-off + cap: after any attempt (success or failure) the next check
 *    waits HOLD_OFF_MS; at most `maxStepsPerBoot` successful steps per boot.
 *  - Plausibility: a target outside [2025, 2100) is never applied (rejects a
 *    never-NITZ'd modem clock at 1980 and garbled parses).
 *  - NITZ trust gate (Phase 8, after the field 2080 incident): the modem's
 *    clock is trusted only while the modem is network-REGISTERED, and CCLK
 *    2-digit years 80–99 map to 19xx so the SIM7600's factory default
 *    (1980-01-06, the GPS epoch) fails plausibility on its own. Either guard
 *    alone would have prevented the incident; both ship.
 *
 * The step itself runs via `sudo -n /usr/local/bin/xorgate-setclock <epoch>` —
 * the agent runs as the provisioning user, not root (systemd drop-in
 * 10-user.conf), so a dedicated sudoers entry (021_xorgate-clock, installed by
 * install.sh / `xorgate update`) grants exactly this helper, which validates
 * its argument, sets the system clock, and persists it to the RTC +
 * fake-hwclock so a warm reboot inherits the corrected time.
 *
 * Failure posture: this feature must never keep the device from recording —
 * every tick error is caught, a missing helper/sudoers logs loudly and backs
 * off, and stale/absent GPS/NITZ data simply means no step.
 */
import { run } from "../lib/exec.js";
import { readModemTelemetry } from "../hardware/modem.js";
import { probeTimeSource, type SteppedClockSource } from "../recording/session.js";
import type { TimeSyncSettings } from "../daemon/settings.js";
import type { GpsClockReading } from "./collectors/gps.js";

export interface TimeSyncConfig {
  offlineSources: boolean;
  stepThresholdSecs: number;
  maxStepsPerBoot: number;
}

export const TIME_SYNC_DEFAULTS: TimeSyncConfig = {
  offlineSources: true,
  stepThresholdSecs: 10,
  maxStepsPerBoot: 4,
};

export function resolveTimeSyncConfig(s?: TimeSyncSettings): TimeSyncConfig {
  const d = TIME_SYNC_DEFAULTS;
  return {
    offlineSources: s?.offlineSources ?? d.offlineSources,
    stepThresholdSecs: s?.stepThresholdSecs ?? d.stepThresholdSecs,
    maxStepsPerBoot: s?.maxStepsPerBoot ?? d.maxStepsPerBoot,
  };
}

/** Check cadence while armed; hold-off after any step attempt ("re-check every few minutes"). */
const CHECK_INTERVAL_MS = 30_000;
const HOLD_OFF_MS = 5 * 60_000;

/** Reject NITZ readings older than this (daemon refreshes every ~60 s). */
const MODEM_CLOCK_FRESH_MS = 5 * 60_000;

/** Plausibility window for a step target: [2025-01-01, 2100-01-01) UTC. */
const MIN_PLAUSIBLE_MS = Date.UTC(2025, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

export const SETCLOCK_HELPER = "/usr/local/bin/xorgate-setclock";

/**
 * Registration <stat> values that mean "attached to a network" (3GPP 27.007):
 * 1 = registered home, 5 = registered roaming. NITZ is a network-originated
 * message, so a modem that has never been registered CANNOT have a
 * NITZ-disciplined clock — whatever AT+CCLK? returns then is its own RTC.
 */
const REGISTERED_STATS = new Set([1, 5]);

/**
 * Parse an AT+CCLK? value ("yy/MM/dd,hh:mm:ss±zz", zz = zone offset in
 * quarter hours, time is LOCAL) into UTC epoch ms. Returns null on any
 * malformation — including a missing zone, without which local time cannot be
 * anchored to UTC (SIM7600 includes it once NITZ has ever landed).
 *
 * Century mapping (Phase 8, field-proven): 2-digit years 80–99 map to 19xx,
 * 00–79 to 20xx — the POSIX/RFC 2822 sliding-window convention. This matters
 * because a cold-power-cut SIM7600 serves its factory default 80/01/06 (the
 * GPS epoch, 1980-01-06) until network attach; mapping that to **2080** made
 * it pass the [2025, 2100) plausibility window and step a correct clock
 * +53 years, twice, on the 2026-07-29 drive. As 1980 it fails plausibility on
 * its own — half of the defence in depth, the other half being the
 * registration gate in readModemClock().
 */
export function parseCclkUtcMs(cclk: string): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-]\d{1,2})$/.exec(cclk.trim());
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss, zone] = m;
  const month = Number(mo);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 60) return null;
  const year = Number(yy) >= 80 ? 1900 + Number(yy) : 2000 + Number(yy);
  const localAsUtc = Date.UTC(year, month - 1, day, Number(hh), Number(mi), Number(ss));
  return localAsUtc - Number(zone) * 15 * 60_000;
}

/** A usable modem (NITZ) clock reading: the clock offset it implies, in ms. */
export interface ModemClockReading {
  /** parse(cclk) − read_at·1000: add to the current wall clock to correct it. */
  offsetMs: number;
}

/**
 * Read the daemon's modem_clock export and reduce it to a clock offset.
 * Freshness is judged with the same (possibly wrong) device clock that
 * stamped read_at, so the comparison is consistent; a read_at in the future
 * (we stepped the clock backwards since the read) is treated as stale.
 *
 * Trust gate (Phase 8): the reading is used ONLY when the modem was
 * network-registered — `modem_clock.reg` (captured at the CCLK read instant by
 * daemons from Phase 8 on), falling back to the snapshot's top-level `reg` for
 * older daemons. This is deliberately fail-CLOSED, unlike the plan's usual
 * fail-open stance: "no evidence of registration" is exactly the state in
 * which the modem serves its un-NITZ'd factory clock, so trusting it is the
 * bug. The cost of being wrong here is only "no NITZ step" — GPS and NTP are
 * untouched.
 */
export async function readModemClock(
  now: number = Date.now(),
  read = readModemTelemetry,
): Promise<ModemClockReading | null> {
  const t = await read();
  const mc = t?.modem_clock;
  if (!mc || typeof mc.cclk !== "string" || typeof mc.read_at !== "number") return null;
  const reg = typeof mc.reg === "number" ? mc.reg : t?.reg;
  if (typeof reg !== "number" || !REGISTERED_STATS.has(reg)) return null;
  const readAtMs = mc.read_at * 1000;
  const age = now - readAtMs;
  if (age < -5_000 || age > MODEM_CLOCK_FRESH_MS) return null;
  const utcMs = parseCclkUtcMs(mc.cclk);
  if (utcMs === null) return null;
  return { offsetMs: utcMs - readAtMs };
}

export interface ClockStepperOptions {
  /** Live-resolved timeSync config (re-read from settings.json each tick). */
  config: () => TimeSyncConfig;
  gpsClock: () => GpsClockReading | null;
  modemClock?: (now: number) => Promise<ModemClockReading | null>;
  /** NTPSynchronized probe; injectable for tests. */
  probeNtpSynced?: () => Promise<boolean>;
  /** Apply the step (default: sudo xorgate-setclock). Injectable for tests. */
  applyStep?: (targetMs: number) => Promise<{ ok: boolean; detail: string }>;
  /** A step landed: source + applied offset (worker feeds the timeSource tracker). */
  onStepped?: (source: SteppedClockSource, offsetMs: number) => void;
  onEvent?: (level: "info" | "warn", msg: string) => void;
  now?: () => number;
  /** Monotonic ms clock (test seam — hold-off must survive the step itself). */
  monoMs?: () => number;
  checkIntervalMs?: number;
  holdOffMs?: number;
}

export interface ClockStepperStatus {
  /** false once NTP has been seen synchronized this boot (stood down for good). */
  armed: boolean;
  steps: number;
  lastStep: { source: SteppedClockSource; offsetMs: number; at: number } | null;
}

async function defaultProbeNtpSynced(): Promise<boolean> {
  return (await probeTimeSource()) === "ntp";
}

async function defaultApplyStep(targetMs: number): Promise<{ ok: boolean; detail: string }> {
  const res = await run("sudo", ["-n", SETCLOCK_HELPER, String(Math.round(targetMs / 1000))]);
  if (res.notFound) return { ok: false, detail: "sudo not found" };
  if (res.failed) {
    return { ok: false, detail: res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}` };
  }
  return { ok: true, detail: "" };
}

export function createClockStepper(opts: ClockStepperOptions): {
  start(): void;
  stop(): void;
  /** One evaluation pass (the timer calls this; exposed for tests). */
  tick(): Promise<void>;
  status(): ClockStepperStatus;
} {
  const now = opts.now ?? Date.now;
  const monoMs = opts.monoMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const probeNtp = opts.probeNtpSynced ?? defaultProbeNtpSynced;
  const applyStep = opts.applyStep ?? defaultApplyStep;
  const modemClock = opts.modemClock ?? ((t: number) => readModemClock(t));
  const checkIntervalMs = opts.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const holdOffMs = opts.holdOffMs ?? HOLD_OFF_MS;
  const event = (level: "info" | "warn", msg: string): void => opts.onEvent?.(level, msg);

  let timer: NodeJS.Timeout | null = null;
  let armed = true;
  let steps = 0;
  let lastStep: ClockStepperStatus["lastStep"] = null;
  let holdUntilMono = 0;
  let capWarned = false;
  let ticking = false;

  function disarm(): void {
    armed = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function evaluate(): Promise<void> {
    if (!armed) return;
    if (await probeNtp()) {
      // Once NTP has synced this boot the kernel flag stays set — this is the
      // permanent per-boot stand-down, agent restarts included.
      disarm();
      event("info", "[clock] NTP synchronized — offline clock stepping stood down for this boot");
      return;
    }
    const cfg = opts.config();
    if (!cfg.offlineSources) return; // kill switch — stay armed, do nothing
    if (monoMs() < holdUntilMono) return;
    if (steps >= cfg.maxStepsPerBoot) {
      if (!capWarned) {
        capWarned = true;
        event("warn", `[clock] step cap reached (${steps}/${cfg.maxStepsPerBoot} this boot) — no further offline steps`);
      }
      return;
    }

    // GPS preferred; NITZ only when no valid fresh GPS time exists.
    let source: SteppedClockSource;
    let targetMs: number;
    const gps = opts.gpsClock();
    if (gps && gps.valid) {
      source = "gps";
      targetMs = gps.utcMs + gps.ageMs;
    } else {
      const modem = await modemClock(now());
      if (!modem) return; // neither source usable — nothing to do this tick
      source = "nitz";
      targetMs = now() + modem.offsetMs;
    }

    if (targetMs < MIN_PLAUSIBLE_MS || targetMs >= MAX_PLAUSIBLE_MS) {
      event("warn", `[clock] ignoring implausible ${source} time ${new Date(targetMs).toISOString()}`);
      holdUntilMono = monoMs() + holdOffMs; // don't re-log a bad source every 30 s
      return;
    }

    const offsetMs = targetMs - now();
    if (Math.abs(offsetMs) <= cfg.stepThresholdSecs * 1000) return;

    // Hold off after ANY attempt, success or failure — a broken sudoers must
    // not be retried (and re-logged) every 30 seconds.
    holdUntilMono = monoMs() + holdOffMs;
    const res = await applyStep(targetMs);
    if (!res.ok) {
      event("warn", `[clock] step from ${source} failed: ${res.detail}`);
      return;
    }
    steps += 1;
    lastStep = { source, offsetMs, at: now() };
    const secs = (offsetMs / 1000).toFixed(1);
    event(
      "info",
      `[clock] stepped system clock ${offsetMs >= 0 ? "+" : ""}${secs}s from ${source} ` +
        `(NTP unsynced; step ${steps}/${cfg.maxStepsPerBoot} this boot)`,
    );
    opts.onStepped?.(source, offsetMs);
  }

  return {
    start(): void {
      if (timer || !armed) return;
      timer = setInterval(() => void this.tick(), checkIntervalMs);
      timer.unref();
      void this.tick(); // first evaluation immediately — the boot window is the point
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async tick(): Promise<void> {
      if (ticking) return; // a slow probe/apply must not stack evaluations
      ticking = true;
      try {
        await evaluate();
      } catch (err) {
        event("warn", `[clock] tick failed: ${(err as Error).message}`);
      } finally {
        ticking = false;
      }
    },
    status(): ClockStepperStatus {
      return { armed, steps, lastStep };
    },
  };
}
