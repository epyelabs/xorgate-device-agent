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
      if (typeof t.csq !== "number" || t.csq === 99) return {}; // unknown signal

      const out: Record<string, unknown> = { quality: { value: t.csq, unit: "asu" } };
      if (typeof t.rssi_dbm === "number") out.rssi = { value: t.rssi_dbm, unit: "dBm" };
      return out;
    },
  };
}
