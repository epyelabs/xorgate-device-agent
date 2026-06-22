/**
 * Modem signal telemetry — read from the connection-manager daemon's output.
 *
 * The connection-manager (modem/sim7600-lte.sh) owns the modem AT port, polls
 * AT+CSQ, and writes an atomic JSON snapshot to a tmpfs file. We just read that
 * file: no serial access, so no contention with the daemon. The shape mirrors
 * `write_telemetry` in the daemon script.
 */
import { readFile } from "node:fs/promises";

/** Atomic telemetry JSON published by the daemon. Override for local testing. */
export const LTE_TELEMETRY_FILE = process.env.LTE_TELEMETRY_FILE ?? "/run/sim7600-lte/telemetry.json";

export interface ModemTelemetry {
  timestamp: string;
  /** AT+CSQ value 0–31, or 99 when unknown. Doubles as ASU. */
  csq: number;
  /** Derived dBm (-113 + csq*2), or null when csq is unknown. */
  rssi_dbm: number | null;
  csq_interval: number;
  /** "connected" | "connecting" | "disconnected" | "dead_zone". */
  status: string;
  iface: string;
  ip: string | null;
}

/**
 * Read the daemon's telemetry JSON. Returns null when the daemon hasn't written
 * it yet (file absent) or the file is unreadable/unparseable — the caller then
 * simply omits the `lte` group for that tick.
 */
export async function readModemTelemetry(
  file: string = LTE_TELEMETRY_FILE,
): Promise<ModemTelemetry | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as ModemTelemetry;
  } catch {
    return null;
  }
}
