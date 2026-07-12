import type { Collector } from "./index.js";
import { streamGps, GPS_NMEA_PORT } from "../../hardware/gps.js";
import { hasPosition, type GpsFix } from "../../lib/nmea.js";

/**
 * If no NMEA sentence has been parsed within this window we treat GNSS as not
 * streaming (link down / GNSS disabled), so the group disappears rather than
 * showing a stale "acquiring"/position. NMEA is ~1 Hz, so this is generous.
 */
const NMEA_STALE_MS = 10_000;

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
export function createGpsCollector(): Collector {
  let started = false;
  let latest: GpsFix | null = null;
  let lastFixAt = 0;
  let warned = false;

  function start(): void {
    started = true; // set before opening so reads don't double-start
    streamGps(GPS_NMEA_PORT, {
      onFix: (fix) => {
        latest = fix;
        lastFixAt = Date.now();
        warned = false; // streaming again — allow a fresh warning if it drops
      },
      onError: (msg) => {
        if (!warned) {
          console.warn(`[gps] ${msg}`);
          warned = true;
        }
      },
      onEnd: () => {
        // Allow a re-open next tick (recovers when the modem re-enumerates). The
        // staleness check below handles the "stream died" case on its own.
        started = false;
      },
    });
  }

  return {
    group: "gps",
    async read() {
      if (!started) start();
      // Require *fresh* NMEA: a stale stream means GNSS isn't actually emitting.
      if (!latest || Date.now() - lastFixAt > NMEA_STALE_MS) return {};

      const fix = latest;
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
      }
      return out;
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
