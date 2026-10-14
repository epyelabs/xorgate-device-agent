/**
 * Clock trust gate (obd2-bluetooth-integration follow-up, 2026-10-14 drive;
 * REPORT-P1-CAR open issue 1).
 *
 * A battery-less CM5 boots on the fake-hwclock / timesyncd restore stamp and
 * stays there until NTP (or a GPS/NITZ step, clock-step.ts) lands: 67 s on
 * the drive's boot, 51 min of error on the next (the Pi was off that long),
 * 13 h on the overnight boot that produced the bogus 13 h session 01a137b5.
 * Everything stamped in that window — the live telemetry payload's `ts`, the
 * recorder's session id (UUIDv7) and header — carries a wrong wall-clock
 * time, and the cloud builds sessions and history from exactly those stamps.
 *
 * Decision: HOLD rather than re-stamp. Re-stamping would need a queue in
 * front of the MQTT publish and a rewrite of on-disk segments after the
 * step; holding is a one-line gate at each of the two producers and loses
 * nothing the cloud could have used (a sample with a wrong time is worse
 * than no sample). The hold is bounded: after `graceMs` (5 min) the clock is
 * used anyway, flagged — `fallback` here, a warn event, `hints.clockTrust`
 * "fallback" in the config report — so a device in a dead zone with no GPS
 * still reports, and the operator can see why the first minutes look odd.
 *
 * Trust sources, any of which latches for the process:
 *  - `timedatectl NTPSynchronized=yes` (the kernel flag never reverts within
 *    a boot; polled every `pollMs` until seen, cheap exec, bounded by the
 *    grace window);
 *  - a GPS or NITZ step applied by the clock stepper (`noteStep`), which the
 *    plan already ranks as honest provenance for sessions.
 * "rtc" from the probe is NOT trust: the CM5's RTC has no battery and the
 * restore stamp is exactly the problem.
 *
 * Real mode only (the worker does not construct it in sim/replay: the
 * container clock is the host's, and a dev box has no timedatectl).
 */
import { probeTimeSource } from "../recording/session.js";

export type ClockTrustSource = "ntp" | "gps" | "nitz";

/** One word for the config report hint and the status line. */
export type ClockTrustState = "trusted" | "held" | "fallback";

export interface ClockTrustStatus {
  /** Producers may stamp with the wall clock (synced, or past the grace window). */
  trusted: boolean;
  state: ClockTrustState;
  /** How trust was established; null while held or in fallback. */
  source: ClockTrustSource | null;
  /** Telemetry publishes withheld so far this process. */
  held: number;
  /** Monotonic ms the hold lasted (frozen once trusted). */
  heldMs: number;
}

export interface ClockTrustOptions {
  /** NTPSynchronized probe; injectable for tests. */
  probe?: () => Promise<"ntp" | "rtc" | "unsynced">;
  /** Hold at most this long without a sync (default 5 min). */
  graceMs?: number;
  /** Probe cadence while held (default 5 s). */
  pollMs?: number;
  /** Probe cadence in fallback, to clear the flag when NTP finally lands (default 30 s). */
  slowPollMs?: number;
  /** Monotonic ms clock (test seam — a clock step must not shorten the grace). */
  monoMs?: () => number;
  onEvent?: (level: "info" | "warn", msg: string) => void;
}

export const CLOCK_TRUST_DEFAULTS = {
  graceMs: 5 * 60_000,
  pollMs: 5_000,
  slowPollMs: 30_000,
} as const;

export interface ClockTrust {
  start(): void;
  stop(): void;
  /** One probe pass (the timer calls this; exposed for tests). */
  tick(): Promise<void>;
  /** The gate: true once synced, or once the grace window has elapsed (fallback). */
  trusted(): boolean;
  /** Count a withheld telemetry publish (for the event + status). */
  noteHeld(): void;
  /** The clock stepper applied a GPS/NITZ step: that is trust. */
  noteStep(source: "gps" | "nitz"): void;
  status(): ClockTrustStatus;
}

export function createClockTrust(opts: ClockTrustOptions = {}): ClockTrust {
  const probe = opts.probe ?? probeTimeSource;
  const graceMs = opts.graceMs ?? CLOCK_TRUST_DEFAULTS.graceMs;
  const pollMs = opts.pollMs ?? CLOCK_TRUST_DEFAULTS.pollMs;
  const slowPollMs = opts.slowPollMs ?? CLOCK_TRUST_DEFAULTS.slowPollMs;
  const monoMs = opts.monoMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const event = (level: "info" | "warn", msg: string): void => opts.onEvent?.(level, msg);

  const startedMono = monoMs();
  let source: ClockTrustSource | null = null;
  let fallback = false;
  let held = 0;
  let heldMs = 0;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let stopped = false;

  function secs(ms: number): string {
    return (ms / 1000).toFixed(0);
  }

  function establish(src: ClockTrustSource): void {
    if (source !== null) return;
    source = src;
    const was = fallback;
    fallback = false;
    if (!was) heldMs = monoMs() - startedMono;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    event(
      "info",
      was
        ? `[clock] ${src} synchronized ${secs(monoMs() - startedMono)} s after boot — clock trusted (published ${secs(monoMs() - startedMono - heldMs)} s on an untrusted clock)`
        : `[clock] ${src} synchronized — clock trusted (telemetry held ${secs(heldMs)} s, ${held} sample(s))`,
    );
  }

  /** Grace check: flips to fallback once, with its warn event. */
  function checkGrace(): void {
    if (source !== null || fallback) return;
    const elapsed = monoMs() - startedMono;
    if (elapsed < graceMs) return;
    fallback = true;
    heldMs = elapsed;
    event(
      "warn",
      `[clock] no NTP/GPS/NITZ sync ${secs(elapsed)} s after start — publishing on an UNTRUSTED clock (${held} sample(s) held); timestamps may be early until a sync lands`,
    );
    if (timer) {
      clearInterval(timer);
      timer = setInterval(() => void tick(), slowPollMs);
      timer.unref();
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped || source !== null) return;
    ticking = true;
    try {
      if ((await probe()) === "ntp") establish("ntp");
      else checkGrace();
    } catch (err) {
      event("warn", `[clock] trust probe failed: ${(err as Error).message}`);
      checkGrace();
    } finally {
      ticking = false;
    }
  }

  return {
    start(): void {
      if (timer || stopped || source !== null) return;
      timer = setInterval(() => void tick(), pollMs);
      timer.unref();
      void tick(); // the boot window is the point
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    trusted(): boolean {
      if (source !== null) return true;
      checkGrace();
      return fallback;
    },
    noteHeld(): void {
      held += 1;
    },
    noteStep(src: "gps" | "nitz"): void {
      establish(src);
    },
    status(): ClockTrustStatus {
      const trusted = this.trusted();
      return {
        trusted,
        state: source !== null ? "trusted" : fallback ? "fallback" : "held",
        source,
        held,
        heldMs: source !== null || fallback ? heldMs : monoMs() - startedMono,
      };
    },
  };
}
