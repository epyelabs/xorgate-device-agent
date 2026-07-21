import type { Collector } from "./index.js";
import { streamGps, GPS_NMEA_PORT, type GpsStreamHandle } from "../../hardware/gps.js";
import { hasPosition, type GpsFix } from "../../lib/nmea.js";

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
 */
export function createGpsCollector(reopenSilentMs: number = REOPEN_SILENT_MS): Collector {
  let started = false;
  let latest: GpsFix | null = null;
  let lastFixAt = 0;
  let lastFixMono = 0n;
  let warned = false;
  let handle: GpsStreamHandle | null = null;
  let openedAt = 0;
  // Generation guard: callbacks from a stream we already replaced (a destroyed
  // stream's close event can land after the reopen) must not touch the state
  // of its successor.
  let gen = 0;

  function start(): void {
    started = true; // set before opening so reads don't double-start
    openedAt = Date.now();
    const myGen = ++gen;
    handle = streamGps(GPS_NMEA_PORT, {
      onFix: (fix) => {
        if (myGen !== gen) return;
        latest = fix;
        lastFixAt = Date.now();
        lastFixMono = process.hrtime.bigint();
        warned = false; // streaming again — allow a fresh warning if it drops
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

  function mapLatest(fix: GpsFix): Record<string, unknown> {
    const out: Record<string, unknown> = {
      fix_quality: { value: typeof fix.fixQuality === "number" ? fix.fixQuality : 0 },
    };
    if (typeof fix.satellites === "number") out.satellites = { value: fix.satellites };
    if (typeof fix.satellitesInView === "number") {
      out.satellites_in_view = { value: fix.satellitesInView };
    }
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
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
