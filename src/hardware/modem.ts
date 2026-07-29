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

/** Coarse GNSS health taxonomy published by the daemon (lte_gnss_recovery plan, Phase 5). */
export type GnssHealth = "ok" | "acquiring" | "degraded" | "unhealthy";

/**
 * GNSS observability block (daemon `write_telemetry` `gnss` object). All
 * LAST-KNOWLEDGE values: the daemon probes fix state only on healthy-LTE
 * health ticks (~10 min) and at the CRESET gate, so while LTE is down these
 * go stale rather than null — judge freshness by `fix_checked_at`.
 */
export interface ModemGnssTelemetry {
  engine_on?: 0 | 1 | null;
  has_fix?: 0 | 1 | null;
  fix_checked_at?: string | null;
  /** Coarse daemon-side TTFF (engine start → first fix-probe success), secs. */
  ttff_s?: number | null;
  last_engine_start?: string | null;
  last_engine_restart?: { ts: string; reason: "off" | "wedge" | "post-reset" } | null;
  /** 1 while the engine runs the plain-standalone fallback (SUPL start failed). */
  standalone_fallback?: 0 | 1;
  no_fix_since?: string | null;
  wedge_restarts_1h?: number;
  health?: GnssHealth | null;
}

/** LTE recovery-machinery observability block (daemon `recovery` object). */
export interface ModemRecoveryTelemetry {
  connect_fails?: number;
  radio_cycles_since_ok?: number;
  resets_24h?: number;
  last_reset?: { ts: string; path: "ladder" | "deadzone" | "config-drift" } | null;
  last_gate_skip?: { ts: string; context: string; reason: string } | null;
  last_lte_ok?: string | null;
}

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
  /** Modem PMU temperature in °C (AT+CPMUTEMP), or null/absent when never read. */
  modem_temp?: number | null;
  /**
   * Modem clock export for the offline NITZ clock step (Phase 4): the raw
   * AT+CCLK? value ("yy/MM/dd,hh:mm:ss±zz", local time + zone in quarter
   * hours) and the daemon-clock epoch seconds at the instant it was read.
   * Consumers compute the clock offset as parse(cclk) − read_at·1000 — both
   * sides captured at the same instant, so the device clock's own error
   * cancels out. Absent/null on daemons predating Phase 4 or before the
   * first successful read.
   */
  modem_clock?: { cclk: string; read_at: number } | null;
  /** GNSS observability (absent on daemons predating the lte_gnss_recovery plan). */
  gnss?: ModemGnssTelemetry;
  /** Recovery observability (absent on daemons predating the lte_gnss_recovery plan). */
  recovery?: ModemRecoveryTelemetry;
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
