import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Collector } from "./index.js";
import { streamGps, GPS_NMEA_PORT, type GpsStreamHandle } from "../../hardware/gps.js";
import { hasPosition, type GpsFix } from "../../lib/nmea.js";
import { createSkyTracker, SKY_STATE_CODES, type SkySnapshot } from "../../lib/sky-state.js";
import { atomicWriteJson } from "../../lib/atomicWrite.js";
import { runtimeHome } from "../../daemon/runtime.js";

/**
 * If no NMEA sentence has been parsed within this window we treat GNSS as not
 * streaming (link down / GNSS disabled), so the group disappears rather than
 * showing a stale "acquiring"/position. NMEA is ~1 Hz, so this is generous.
 */
const NMEA_STALE_MS = 10_000;

/**
 * If the open stream stays silent this long, assume the fd is dead and reopen.
 * A modem reset (AT+CRESET or a crash) re-enumerates the USB serial ports and
 * can leave the old tty fd open but permanently silent — no data, no error,
 * no close — so onEnd never fires and the collector would wait forever.
 * Longer than NMEA_STALE_MS so the "group omitted" signal always fires first.
 */
const REOPEN_SILENT_MS = 30_000;

/**
 * GPS collector — NMEA from the SIM7600 GNSS port (/dev/ttyUSB1).
 *
 * The connection-manager enables GNSS (AT+CGPS) so sentences stream on the
 * port; we open it lazily on the first read, keep the latest aggregated fix,
 * and map it on each ~1 Hz tick. Self-gates like the IMU collector.
 *
 * `read()` reports three distinguishable states so the UI can tell "no GPS at
 * all" apart from "GPS streaming, just no fix yet" (e.g. indoors):
 *   - no fresh NMEA            → {}                       (group omitted)
 *   - NMEA streaming, no lock  → { fix_quality[, satellites, satellites_in_view] }
 *   - position lock            → { lat, lon, alt, speed, satellites,
 *                                  satellites_in_view, hdop, fix_quality }
 * `fix_quality` is always present while NMEA flows (GGA carries it even with no
 * lock), so its presence is the "GNSS is live" signal; the absence of lat/lon
 * is what marks the acquiring state. The aggregator clears position + hdop on
 * lock loss, so lat/lon here are always current, never a frozen last-known.
 * `satellites_in_view` (GSV) vs `satellites` used (GGA) separates "bad sky
 * view / antenna" from "seeing plenty, geometry still converging"; `hdop`
 * (GSA) is the fix-confidence number (lower is better, <2 is good).
 *
 * `ttff_s` (lte_gnss_recovery plan, Phase 5 / Q6): time-to-first-fix measured
 * at the NMEA fix-quality 0→nonzero transition — the accurate TTFF (the
 * daemon publishes a coarse probe-cadence-bound one in its own telemetry).
 * The clock arms when quality-0 sentences appear (acquisition observed) and
 * publishes from lock until the next acquisition begins. It never spans a
 * silent-stream gap: a reopen re-arms on the first quality-0 sentence, so an
 * engine restart's dead air isn't billed as acquisition time. Null when the
 * collector never saw the acquiring state (e.g. agent started under a fix).
 */
/**
 * A GPS UTC clock reading for the offline clock stepper (Phase 4): the last
 * RMC-carried date+time, its mono-measured age (wall-clock-independent — the
 * whole point is that the wall clock may be wrong), and whether the receiver
 * reported a valid fix at that instant. Stratum-0 quality when valid.
 */
export interface GpsClockReading {
  /** UTC epoch ms as reported by RMC, at the instant it arrived. */
  utcMs: number;
  /** Monotonic age of that reading, ms. */
  ageMs: number;
  /** RMC status was "A" (valid fix) on the sentence that carried this time. */
  valid: boolean;
}

/** How old an RMC time reading may be before clock() reports none (NMEA is ~1 Hz). */
const CLOCK_FRESH_MS = 10_000;

/**
 * Sky state for the sim7600-lte daemon (Phase 7, Part A, consumer 1). The
 * daemon owns the NMEA port config and the GNSS recovery ladder but parses no
 * NMEA itself; rather than teach a bash script GSV, the agent publishes the
 * verdict it already computes to this small atomic file and the daemon reads
 * one field. Its own `timestamp` is the freshness contract — a stale file (or
 * a dead agent) means "no opinion", and the daemon behaves exactly as before.
 */
export const SKY_STATE_FILENAME = "gnss-sky.json";
/** Refresh cadence for that file when nothing changes (state changes write immediately). */
const SKY_PUBLISH_MS = 15_000;

export interface GpsCollector extends Collector {
  /**
   * Latest fresh RMC UTC time, or null when none/stale. Also keeps the NMEA
   * stream open (like read()/sample()), so the clock stepper alone sustains
   * GPS input on a device that is offline with recording off.
   */
  clock(): GpsClockReading | null;
  /**
   * Sky visibility from GSV (Phase 7). Also keeps the NMEA stream open, so the
   * video gate alone sustains GPS input on a device booted offline.
   */
  sky(): SkySnapshot;
  /** Does the receiver currently report a position lock (fresh NMEA)? */
  hasFix(): boolean;
}

export interface GpsCollectorOptions {
  reopenSilentMs?: number;
  /** Where the daemon-facing sky file goes; omit for the runtime home default. */
  skyStatePath?: string;
}

export function createGpsCollector(
  optsOrReopenMs: number | GpsCollectorOptions = {},
): GpsCollector {
  const opts: GpsCollectorOptions =
    typeof optsOrReopenMs === "number" ? { reopenSilentMs: optsOrReopenMs } : optsOrReopenMs;
  const reopenSilentMs = opts.reopenSilentMs ?? REOPEN_SILENT_MS;
  const skyStatePath = opts.skyStatePath ?? join(runtimeHome(), SKY_STATE_FILENAME);
  const skyTracker = createSkyTracker();
  let skyPublishedState = "";
  let skyPublishedAt = 0;
  let started = false;
  let latest: GpsFix | null = null;
  let lastFixAt = 0;
  let lastFixMono = 0n;
  // Clock-step view: the last distinct RMC utcMs + its mono arrival stamp.
  // utcMs advances every RMC (1 Hz), so "changed" is the fresh-RMC signal.
  let clockUtcMs: number | null = null;
  let clockMono = 0n;
  let clockValid = false;
  let warned = false;
  let handle: GpsStreamHandle | null = null;
  let openedAt = 0;
  // Generation guard: callbacks from a stream we already replaced (a destroyed
  // stream's close event can land after the reopen) must not touch the state
  // of its successor.
  let gen = 0;
  // TTFF clock: epoch when the current acquiring (quality 0) streak started,
  // and the measured seconds for the current lock (see doc comment above).
  let acquiringSince: number | null = null;
  let ttffS: number | null = null;

  function noteFixQuality(fix: GpsFix, now: number): void {
    const q = fix.fixQuality;
    if (typeof q !== "number") return; // no GGA yet — no quality knowledge
    if (q === 0) {
      if (acquiringSince === null) {
        acquiringSince = now;
        ttffS = null; // a new acquisition cycle invalidates the old measurement
      }
    } else if (acquiringSince !== null) {
      ttffS = (now - acquiringSince) / 1000;
      acquiringSince = null;
    }
  }

  function start(): void {
    started = true; // set before opening so reads don't double-start
    openedAt = Date.now();
    // Fresh stream = fresh acquisition observation; never bill the silent gap.
    acquiringSince = null;
    const myGen = ++gen;
    handle = streamGps(GPS_NMEA_PORT, {
      onFix: (fix) => {
        if (myGen !== gen) return;
        latest = fix;
        lastFixAt = Date.now();
        lastFixMono = process.hrtime.bigint();
        if (typeof fix.utcMs === "number" && fix.utcMs !== clockUtcMs) {
          clockUtcMs = fix.utcMs;
          clockMono = lastFixMono;
          clockValid = fix.valid === true;
        }
        noteFixQuality(fix, lastFixAt);
        warned = false; // streaming again — allow a fresh warning if it drops
      },
      onGsv: (msg) => {
        if (myGen !== gen) return;
        skyTracker.note(msg);
        // A GSV sentence is proof the stream is alive and carries NEW sky data
        // even when the rolling fix is unchanged. Without this the group goes
        // quiet exactly when it matters most: while acquiring, this module emits
        // GGA with an EMPTY time field, so a quality-0 GGA changes nothing and
        // the aggregate can sit static past NMEA_STALE_MS — freshFix() then
        // reported nothing and `sky_state`/`sats_heard`/`snr_max` disappeared
        // from telemetry (cold-boot-observed 2026-07-30: sky read `clear, 11
        // heard` while the whole gps group was absent), while the silent-fd
        // watchdog could reopen a perfectly healthy port at 30 s.
        // Deliberately NOT applied under a position lock: a held position must
        // keep its freshness from the sentences that actually carry it, so a
        // stalled GGA/RMC can never leave a frozen last-known position standing.
        if (latest !== null && !hasPosition(latest)) {
          lastFixAt = Date.now();
          lastFixMono = process.hrtime.bigint();
        }
      },
      onError: (msg) => {
        if (myGen !== gen) return;
        if (!warned) {
          console.warn(`[gps] ${msg}`);
          warned = true;
        }
      },
      onEnd: () => {
        if (myGen !== gen) return;
        // Allow a re-open next tick (recovers when the modem re-enumerates). The
        // staleness check below handles the "stream died" case on its own.
        started = false;
      },
    });
  }

  // Shared by read() and sample(): lazy open + the silent-fd watchdog. Either
  // caller (live loop or recorder) keeps the stream alive — recording can run
  // with the live loop idle (e.g. booted offline, MQTT never connects).
  function ensureStreaming(): void {
    if (!started) {
      start();
    } else if (Date.now() - Math.max(lastFixAt, openedAt) > reopenSilentMs) {
      // Silent-fd watchdog: the stream is "open" but nothing has arrived for
      // far too long — a dead tty from a modem USB re-enumeration. Destroy it
      // and reopen on the next tick, picking up the fresh device node.
      console.warn("[gps] NMEA silent too long — reopening the port");
      handle?.stop();
      handle = null;
      started = false;
    }
  }

  /**
   * Evaluate the sky tracker and keep the daemon-facing file fresh. Called from
   * every entry point, so the contract stays current for as long as the agent
   * is alive — and goes stale (daemon falls back to today's behavior) the
   * moment it isn't.
   */
  function skyNow(): SkySnapshot {
    const snap = skyTracker.snapshot();
    const changed = snap.state !== skyPublishedState;
    const now = Date.now();
    if (changed || now - skyPublishedAt >= SKY_PUBLISH_MS) {
      skyPublishedState = snap.state;
      skyPublishedAt = now;
      try {
        // Only if the runtime home already exists — a unit test or a CLI run on
        // a box that has never started the agent must not create it.
        if (existsSync(dirname(skyStatePath))) {
          atomicWriteJson(skyStatePath, {
            v: 1,
            timestamp: new Date(now).toISOString(),
            state: snap.state,
            heard: snap.heard,
            usable: snap.usable,
            in_view: snap.inView,
            max_snr: snap.maxSnr,
            hold_s: Math.round(snap.holdMs / 1000),
          });
        }
      } catch {
        /* the sky file is an optimization; never let it break the collector */
      }
    }
    return snap;
  }

  function mapLatest(fix: GpsFix): Record<string, unknown> {
    const out: Record<string, unknown> = {
      fix_quality: { value: typeof fix.fixQuality === "number" ? fix.fixQuality : 0 },
    };
    if (typeof fix.satellites === "number") out.satellites = { value: fix.satellites };
    if (typeof fix.satellitesInView === "number") {
      out.satellites_in_view = { value: fix.satellitesInView };
    }
    // Sky visibility (Phase 7). `sats_heard` is the RF evidence (a C/N0 was
    // reported at all) as opposed to `satellites_in_view`, which the receiver
    // lists from almanac even with the antenna in a bag; `snr_max` is the raw
    // number behind the state, and the field lever for the open
    // rail-vs-antenna question. `sky_state` is coded 0 best → 2 worst, like
    // `lte.gnss_health`, and omitted while the state is unknown.
    const sky = skyNow();
    out.sats_heard = { value: sky.heard };
    if (sky.maxSnr !== null) out.snr_max = { value: sky.maxSnr, unit: "dBHz" };
    if (sky.state !== "unknown") out.sky_state = { value: SKY_STATE_CODES[sky.state] };
    if (typeof fix.hdop === "number") out.hdop = { value: round(fix.hdop, 1) };
    if (hasPosition(fix)) {
      out.lat = { value: round(fix.latitude!, 6) };
      out.lon = { value: round(fix.longitude!, 6) };
      if (typeof fix.altitude === "number") out.alt = { value: round(fix.altitude, 1), unit: "m" };
      if (typeof fix.speedKmh === "number") {
        out.speed = { value: round(fix.speedKmh, 1), unit: "km/h" };
      }
      // Course over ground (direction of travel). Present only while moving;
      // held from the last movement otherwise (the aggregator clears it on
      // lock loss), so it's always tied to the current position.
      if (typeof fix.course === "number") {
        out.course = { value: round(fix.course, 1), unit: "°" };
      }
      // TTFF of the current lock; absent when acquisition was never observed.
      if (ttffS !== null) {
        out.ttff_s = { value: round(ttffS, 1), unit: "s" };
      }
    }
    return out;
  }

  // Require *fresh* NMEA: a stale stream means GNSS isn't actually emitting.
  function freshFix(): GpsFix | null {
    if (!latest || Date.now() - lastFixAt > NMEA_STALE_MS) return null;
    return latest;
  }

  return {
    group: "gps",
    async read() {
      ensureStreaming();
      const fix = freshFix();
      return fix ? mapLatest(fix) : {};
    },
    async sample() {
      ensureStreaming();
      const fix = freshFix();
      return fix ? { fields: mapLatest(fix), updatedMono: lastFixMono } : null;
    },
    clock() {
      ensureStreaming();
      if (clockUtcMs === null) return null;
      const ageMs = Number((process.hrtime.bigint() - clockMono) / 1_000_000n);
      if (ageMs > CLOCK_FRESH_MS) return null;
      return { utcMs: clockUtcMs, ageMs, valid: clockValid };
    },
    sky() {
      ensureStreaming();
      return skyNow();
    },
    hasFix() {
      const fix = freshFix();
      // GGA quality > 0 is the receiver's own "I have a solution" statement;
      // requiring lat/lon on top keeps a quality-1-but-position-less sentence
      // from counting (the aggregator clears position on lock loss).
      return fix !== null && (fix.fixQuality ?? 0) > 0 && hasPosition(fix);
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
