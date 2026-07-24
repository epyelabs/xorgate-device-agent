import type { Collector } from "./index.js";
import { readModemTelemetry } from "../../hardware/modem.js";

/**
 * LTE signal collector (rssi / quality).
 *
 * Reads the connection-manager daemon's atomic telemetry JSON each tick (the
 * daemon owns the AT port and polls AT+CSQ; see hardware/modem.ts). Maps the
 * CSQ 0–31 value to `quality` (ASU) and the daemon-derived dBm to `rssi`.
 * Self-gates: returns {} when the daemon hasn't published yet or the signal is
 * unknown (CSQ 99), so the worker omits the `lte` group.
 */
export function createLteCollector(): Collector {
  let warned = false;

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
    return out;
  }

  return {
    group: "lte",
    async read() {
      const t = await readModemTelemetry();
      if (!t) {
        if (!warned) {
          console.warn("[lte] no telemetry yet — is sim7600-lte.service running?");
          warned = true;
        }
        return {};
      }
      warned = false; // recovered; allow a fresh warning if it drops again
      return mapTelemetry(t) ?? {};
    },
    async sample() {
      const now = Date.now();
      if (now - lastPollAt >= 1000) {
        lastPollAt = now;
        const t = await readModemTelemetry();
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
