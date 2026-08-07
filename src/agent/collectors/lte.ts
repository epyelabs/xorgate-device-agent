import type { Collector } from "./index.js";
import { readModemTelemetry, type GnssHealth } from "../../hardware/modem.js";

/**
 * Numeric coding for the daemon's coarse GNSS health (cloud telemetry leaves
 * are numbers-only — backend telemetry schema rejects string values). Ordered
 * by severity so dashboard thresholds ("alert when >= 2") stay meaningful.
 * The web app (telemetry-meta) and the monitor decode with the same table.
 */
export const GNSS_HEALTH_CODES: Record<GnssHealth, number> = {
  ok: 0,
  acquiring: 1,
  degraded: 2,
  unhealthy: 3,
};

/**
 * LTE signal collector (rssi / quality).
 *
 * Reads the connection-manager daemon's atomic telemetry JSON each tick (the
 * daemon owns the AT port and polls AT+CSQ; see hardware/modem.ts). Maps the
 * CSQ 0–31 value to `quality` (ASU) and the daemon-derived dBm to `rssi`.
 * Since the lte_gnss_recovery plan (Phase 5) it also surfaces the daemon's
 * GNSS/recovery observability: `gnss_health` (coded per GNSS_HEALTH_CODES)
 * and `resets_24h`, so an unhealthy GNSS engine is visible from the cloud.
 * Self-gates: returns {} when the daemon hasn't published yet or the signal is
 * unknown (CSQ 99), so the worker omits the `lte` group.
 */
export function createLteCollector(): Collector & { lastStatus: () => string | null } {
  let warned = false;

  // The daemon's `status` string ("connected"/"connecting"/"disconnected"/
  // "dead_zone") is NOT publishable — cloud telemetry leaves are numbers-only —
  // but the status LED needs it (rung 5, and `dead_zone` is what keeps a
  // settled no-coverage device green). Captured from the read this collector
  // already performs each tick, so nothing re-reads the file: "no new pollers".
  let lastStatus: string | null = null;

  // Recorder-side cache: the daemon file updates on its own slow cadence, so
  // sample() re-reads it at most once per second and stamps updatedMono only
  // when the content actually changed (the daemon's `timestamp` string is the
  // change key). Keeps a 10–20 Hz recorder from re-reading the file per tick.
  let cached: { fields: Record<string, unknown>; updatedMono: bigint } | null = null;
  let lastKey: string | null = null;
  let lastPollAt = 0;

  function mapTelemetry(t: NonNullable<Awaited<ReturnType<typeof readModemTelemetry>>>):
    | Record<string, unknown>
    | null {
    if (typeof t.csq !== "number" || t.csq === 99) return null; // unknown signal
    const out: Record<string, unknown> = { quality: { value: t.csq, unit: "asu" } };
    if (typeof t.rssi_dbm === "number") out.rssi = { value: t.rssi_dbm, unit: "dBm" };
    if (typeof t.modem_temp === "number" && Number.isFinite(t.modem_temp))
      out.modem_temp = { value: t.modem_temp, unit: "°C" };
    // GNSS/recovery observability — absent until the daemon has knowledge
    // (nulls in the file) or on daemons predating the gnss/recovery blocks.
    const health = t.gnss?.health;
    if (typeof health === "string" && health in GNSS_HEALTH_CODES) {
      out.gnss_health = { value: GNSS_HEALTH_CODES[health as GnssHealth] };
    }
    const resets = t.recovery?.resets_24h;
    if (typeof resets === "number" && Number.isFinite(resets)) {
      out.resets_24h = { value: resets };
    }
    return out;
  }

  return {
    group: "lte",
    /** Daemon link status for the status LED; null when the file is unreadable. */
    lastStatus: () => lastStatus,
    async read() {
      const t = await readModemTelemetry();
      if (!t) {
        lastStatus = null;
        if (!warned) {
          console.warn("[lte] no telemetry yet — is sim7600-lte.service running?");
          warned = true;
        }
        return {};
      }
      // Captured BEFORE the CSQ gate: an unknown signal (csq 99) still has a
      // meaningful link status, and dropping it would light the LED purple on a
      // device the daemon considers settled.
      lastStatus = typeof t.status === "string" ? t.status : null;
      warned = false; // recovered; allow a fresh warning if it drops again
      return mapTelemetry(t) ?? {};
    },
    async sample() {
      const now = Date.now();
      if (now - lastPollAt >= 1000) {
        lastPollAt = now;
        const t = await readModemTelemetry();
        if (t) lastStatus = typeof t.status === "string" ? t.status : null;
        const fields = t ? mapTelemetry(t) : null;
        if (!fields) {
          cached = null;
        } else {
          const key = `${t!.timestamp}|${t!.csq}`;
          if (key !== lastKey || !cached) {
            cached = { fields, updatedMono: process.hrtime.bigint() };
            lastKey = key;
          } else {
            cached = { ...cached, fields };
          }
        }
      }
      return cached;
    },
  };
}
