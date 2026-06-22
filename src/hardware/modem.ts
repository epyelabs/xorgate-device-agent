/**
 * Modem signal telemetry — read from the connection-manager daemon's output.
 *
 * The connection-manager (modem/sim7600-lte.sh) owns the modem AT port, polls
 * AT+CSQ, and writes an atomic JSON snapshot to a tmpfs file. We just read that
 * file: no serial access, so no contention with the daemon. The shape mirrors
 * `write_telemetry` in the daemon script.
 *
 * Presence detection (lsusb + tty enumeration) backs the monitor's "Modem"
 * panel and is run on-demand by that pane (not on the telemetry path), so it
 * needs no caching here.
 */
import { readFile, readdir } from "node:fs/promises";
import { run } from "../lib/exec.js";

/** SimCom SIM7600 USB ids as seen by lsusb (also reported as "SimTech"). */
const MODEM_USB_VENDOR = "1e0e";
const MODEM_USB_PRODUCTS = ["9011", "9001"];

/** Modem USB presence + enumerated tty ports, for the monitor's Modem panel. */
export interface ModemPresence {
  present: boolean;
  /** USB vendor:product from lsusb, e.g. "1e0e:9011". */
  usbId?: string;
  description?: string;
  /** Enumerated /dev/ttyUSB* nodes. */
  ttyPorts: string[];
}

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

/** Pure: find the modem line in `lsusb` output by vendor/product id. */
export function findModemLine(
  stdout: string,
  vendorId: string = MODEM_USB_VENDOR,
  productIds: readonly string[] = MODEM_USB_PRODUCTS,
): { usbId: string; description: string } | null {
  for (const line of stdout.split("\n")) {
    const m = line.match(/ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)/i);
    if (!m) continue;
    const [, vid, pid, desc] = m;
    if (vid.toLowerCase() === vendorId.toLowerCase() && productIds.includes(pid.toLowerCase())) {
      return { usbId: `${vid}:${pid}`, description: desc.trim() };
    }
  }
  return null;
}

async function listTtyUsb(): Promise<string[]> {
  try {
    const entries = await readdir("/dev");
    return entries
      .filter((e) => /^ttyUSB\d+$/.test(e))
      .map((e) => `/dev/${e}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Probe lsusb + /dev for the modem. Spawns a process, so the monitor calls it
 * once when the LTE pane opens (not on a loop). Falls back to tty-only presence
 * when lsusb is unavailable (e.g. a dev box).
 */
export async function detectModem(): Promise<ModemPresence> {
  const ttyPorts = await listTtyUsb();
  const res = await run("lsusb");
  if (res.failed) {
    return { present: ttyPorts.length > 0, ttyPorts };
  }
  const m = findModemLine(res.stdout);
  return { present: !!m, usbId: m?.usbId, description: m?.description, ttyPorts };
}
