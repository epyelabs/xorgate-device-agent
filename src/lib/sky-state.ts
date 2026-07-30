/**
 * Sky-visibility tracker (optimize-system-process-cycle plan, Phase 7, Part A).
 *
 * "The device has no clear view of the sky" did not exist as a signal before
 * this module; the only proxy was the daemon's 1200 s no-fix timer, which
 * cannot tell a garage from a wedged GNSS engine. GSV can: a receiver lists
 * satellites it merely EXPECTS (from almanac/ephemeris) with a blank C/N0
 * field, and fills that field in only for satellites it is actually HEARING.
 * So `heard` (satellites with a numeric C/N0) — not `inView` — is the RF
 * signal, and a sustained `heard === 0` means the antenna sees nothing.
 *
 * Three states, plus an honest fourth:
 *  - `clear`      — enough usable-strength satellites; a fix is expected soon,
 *                   so it is worth being patient with the modem.
 *  - `obstructed` — GSV is flowing but the sky is poor (weak signals, too few
 *                   usable satellites). Also the transitional state on the way
 *                   into `no-rf`: nothing heard is only CALLED `no-rf` once it
 *                   has held for the sustain window.
 *  - `no-rf`      — nothing heard at all for a sustained window: garage,
 *                   covered/disconnected antenna, RF front-end failure. Stop
 *                   hoping for a fix.
 *  - `unknown`    — no fresh GSV at all. NOT `no-rf`: a silenced NMEA stream is
 *                   the brownout/wedge signature (2026-07-28), the exact case
 *                   where the daemon's wedge restart SHOULD still fire. Every
 *                   consumer must treat unknown as "no opinion".
 *
 * Hysteresis is mandatory here: single sentences flap (a satellite drops below
 * the C/N0 threshold for one cycle constantly), and both consumers — the
 * daemon's wedge suppression and Phase 7's video gate — make expensive,
 * hard-to-reverse decisions.
 *
 * TIME: every window is measured on a monotonic clock (Phase 6 rule; the
 * `monoMs` option is the test seam). A morning NTP step over a stale
 * fake-hwclock restore must not expire a sustain window.
 */
import type { GsvMessage } from "./nmea.js";
import { monotonicMs } from "../recording/boot-policy.js";

export type SkyState = "clear" | "obstructed" | "no-rf" | "unknown";

/**
 * Windows and thresholds. Deliberately code constants rather than device
 * settings: unlike the power thresholds (which the Phase 5 field loop tunes),
 * these describe GNSS physics, not this vehicle's supply. The knobs the field
 * loop does need for Phase 7 are the gate's own (`recording.video.gpsGate*`).
 */
export interface SkyThresholds {
  /**
   * C/N0 at or above which a satellite counts as usable, dBHz. Open sky puts
   * good satellites at 35–45; the bench window measures 20–30 through glass,
   * so 20 is the "genuinely tracking something" line rather than a quality bar.
   */
  usableSnrDb: number;
  /** Usable satellites required for `clear` (4 = the minimum for a 3D fix). */
  clearMinSats: number;
  /** `clear` must hold this long before it is published (fast — it's good news). */
  clearHoldMs: number;
  /** Leaving `clear` needs this long of not-clear, so one bad cycle can't flap it. */
  leaveClearMs: number;
  /** Nothing heard must persist this long before `no-rf` is claimed. */
  noRfHoldMs: number;
  /** Hearing something again leaves `no-rf` after this long (short: the sky is back). */
  leaveNoRfMs: number;
  /** A talker's satellite set older than this is dropped; none fresh ⇒ `unknown`. */
  dataStaleMs: number;
}

export const SKY_DEFAULTS: SkyThresholds = {
  usableSnrDb: 20,
  clearMinSats: 4,
  clearHoldMs: 5_000,
  leaveClearMs: 15_000,
  // 60 s of complete silence. Long enough that an underpass or a tree tunnel
  // never claims it, short enough to be a small fraction of the video gate's
  // 600 s give-up cap (a garage start must not wait out the whole cap).
  noRfHoldMs: 60_000,
  leaveNoRfMs: 5_000,
  dataStaleMs: 15_000,
};

/** Coded form for telemetry — 0 is best, matching `lte.gnss_health`. */
export const SKY_STATE_CODES: Record<Exclude<SkyState, "unknown">, number> = {
  clear: 0,
  obstructed: 1,
  "no-rf": 2,
};

export interface SkySnapshot {
  state: SkyState;
  /** Satellites reporting a C/N0 at all — the actual RF evidence. */
  heard: number;
  /** Satellites at or above `usableSnrDb`. */
  usable: number;
  /** Satellites LISTED in view; almanac-driven, so not by itself an RF signal. */
  inView: number;
  /** Best C/N0 this cycle, dBHz; null when nothing is heard. */
  maxSnr: number | null;
  /** How long (monotonic ms) the published state has held. */
  holdMs: number;
}

/**
 * What the GPS/LTE video gate (Phase 7, Part B) needs to know about GNSS: has
 * the receiver converted power into a fix yet, and — if not — is there any
 * point in waiting? `null` from a provider means "no GNSS view at all", which
 * disarms the gate rather than holding video hostage to a signal that can
 * never arrive.
 */
export interface GnssView {
  fix: boolean;
  sky: SkyState;
}

export interface SkyTracker {
  /** Feed one parsed GSV sentence (any talker, any position in its cycle). */
  note(msg: GsvMessage): void;
  /** Evaluate + return the current state. Cheap; safe to call per tick. */
  snapshot(): SkySnapshot;
}

export interface SkyTrackerOptions {
  thresholds?: Partial<SkyThresholds>;
  /** Monotonic clock (test seam). */
  monoMs?: () => number;
}

/** A talker's most recently COMPLETED message cycle. */
interface TalkerView {
  inView: number;
  heard: number;
  usable: number;
  maxSnr: number | null;
  atMs: number;
}

export function createSkyTracker(opts: SkyTrackerOptions = {}): SkyTracker {
  const cfg = { ...SKY_DEFAULTS, ...opts.thresholds };
  const monoMs = opts.monoMs ?? monotonicMs;

  /** In-flight cycles keyed by talker (msgNum 1 … numMsgs). */
  const pending = new Map<string, { sats: Map<number, number | null>; inView: number; next: number }>();
  /** Last completed cycle per talker. */
  const views = new Map<string, TalkerView>();

  let state: SkyState = "unknown";
  let stateSinceMs = monoMs();
  /** Raw (un-hysteresised) classification and when it last changed. */
  let raw: SkyState | null = null;
  let rawSinceMs = stateSinceMs;

  function commit(talker: string, sats: Map<number, number | null>, inView: number, now: number): void {
    let heard = 0;
    let usable = 0;
    let maxSnr: number | null = null;
    for (const snr of sats.values()) {
      if (snr === null || snr <= 0) continue;
      heard++;
      if (snr >= cfg.usableSnrDb) usable++;
      if (maxSnr === null || snr > maxSnr) maxSnr = snr;
    }
    views.set(talker, { inView, heard, usable, maxSnr, atMs: now });
  }

  function classify(heard: number, usable: number): SkyState {
    if (usable >= cfg.clearMinSats) return "clear";
    if (heard === 0) return "no-rf";
    return "obstructed";
  }

  /**
   * Fold the fresh talker views into one sky reading and advance the state
   * machine. Called both when data ARRIVES and when a consumer asks: hold times
   * must accrue on the NMEA cadence, not on whoever happens to be polling, and
   * the drop to `unknown` has to happen even when nothing arrives at all.
   */
  function evaluate(now: number): SkySnapshot {
    let heard = 0;
    let usable = 0;
    let inView = 0;
    let maxSnr: number | null = null;
    let fresh = false;
    for (const [talker, v] of views) {
      if (now - v.atMs > cfg.dataStaleMs) {
        views.delete(talker);
        continue;
      }
      fresh = true;
      heard += v.heard;
      usable += v.usable;
      inView += v.inView;
      if (v.maxSnr !== null && (maxSnr === null || v.maxSnr > maxSnr)) maxSnr = v.maxSnr;
    }

    const next = fresh ? classify(heard, usable) : null;
    if (next !== raw) {
      raw = next;
      rawSinceMs = now;
    }
    const held = now - rawSinceMs;

    let want = state;
    if (next === null) {
      // No fresh GSV: we have no opinion. Never claim `no-rf` here — a silent
      // NMEA stream is the wedge signature, not a missing sky.
      want = "unknown";
    } else if (state === "clear") {
      if (next !== "clear" && held >= cfg.leaveClearMs) want = "obstructed";
    } else if (state === "no-rf") {
      if (next !== "no-rf" && held >= cfg.leaveNoRfMs) want = next === "clear" ? "clear" : "obstructed";
    } else if (next === "clear" && held >= cfg.clearHoldMs) {
      want = "clear";
    } else if (next === "no-rf" && held >= cfg.noRfHoldMs) {
      want = "no-rf";
    } else {
      // Includes "heard nothing, but not for long enough to call it": honest,
      // and it is exactly what `obstructed` means (fix uncertain).
      want = "obstructed";
    }
    if (want !== state) {
      state = want;
      stateSinceMs = now;
    }
    return { state, heard, usable, inView, maxSnr, holdMs: now - stateSinceMs };
  }

  return {
    note(msg: GsvMessage): void {
      const now = monoMs();
      // Start a cycle on message 1; join one already in flight only if this is
      // the message we expect next (a stream joined mid-cycle is skipped until
      // its next message 1 — one second of patience beats a half-read sky).
      let cur = pending.get(msg.talker);
      if (msg.msgNum === 1) {
        cur = { sats: new Map(), inView: msg.inView, next: 1 };
        pending.set(msg.talker, cur);
      } else if (!cur || cur.next !== msg.msgNum) {
        pending.delete(msg.talker);
        return;
      }
      for (const sat of msg.satellites) cur.sats.set(sat.prn, sat.snr);
      cur.inView = msg.inView;
      cur.next = msg.msgNum + 1;
      if (msg.msgNum >= msg.numMsgs) {
        commit(msg.talker, cur.sats, cur.inView, now);
        pending.delete(msg.talker);
        evaluate(now);
      }
    },

    snapshot(): SkySnapshot {
      return evaluate(monoMs());
    },
  };
}
