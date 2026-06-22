import type { Collector } from "./index.js";
import { streamGps, GPS_NMEA_PORT } from "../../hardware/gps.js";
import { hasPosition, type GpsFix } from "../../lib/nmea.js";

/**
 * GPS collector — NMEA from the SIM7600 GNSS port (/dev/ttyUSB1).
 *
 * The connection-manager enables GNSS (AT+CGPS) so sentences stream on the
 * port; we open it lazily on the first read, keep the latest aggregated fix,
 * and map it on each ~1 Hz tick. Self-gates like the IMU collector: until a
 * position fix lands (or if the port is missing / unreadable) `read()` returns
 * {} and the worker omits the `gps` group. If the stream ends (tty vanished /
 * EOF) we flag a re-open on the next tick while keeping the last known fix.
 */
export function createGpsCollector(): Collector {
  let started = false;
  let latest: GpsFix | null = null;
  let warned = false;

  function start(): void {
    started = true; // set before opening so reads don't double-start
    streamGps(GPS_NMEA_PORT, {
      onFix: (fix) => {
        latest = fix;
      },
      onError: (msg) => {
        if (!warned) {
          console.warn(`[gps] ${msg}`);
          warned = true;
        }
      },
      onEnd: () => {
        // Allow a re-open next tick (recovers when the modem re-enumerates), but
        // keep `latest` so we keep reporting the last known position meanwhile.
        started = false;
      },
    });
  }

  return {
    group: "gps",
    async read() {
      if (!started) start();
      if (!latest || !hasPosition(latest)) return {};

      const fix = latest;
      const out: Record<string, unknown> = {
        lat: { value: round(fix.latitude!, 6) },
        lon: { value: round(fix.longitude!, 6) },
      };
      if (typeof fix.altitude === "number") out.alt = { value: round(fix.altitude, 1), unit: "m" };
      if (typeof fix.speedKmh === "number") out.speed = { value: round(fix.speedKmh, 1), unit: "km/h" };
      if (typeof fix.satellites === "number") out.satellites = { value: fix.satellites };
      if (typeof fix.fixQuality === "number") out.fix_quality = { value: fix.fixQuality };
      return out;
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
