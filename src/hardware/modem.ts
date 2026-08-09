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

/** What the modem says about the card in the slot (manage_sim_card_info, Phase 1). */
export type SimState = "ready" | "locked" | "not-detected" | "error" | "unknown";

/** 3GPP registration <stat>, as a label the daemon has already resolved. */
export type SimRegistration =
  | "home"
  | "roaming"
  | "searching"
  /** The network REJECTED this SIM — a deprovisioned or unpaid account. */
  | "denied"
  | "not-searching"
  | "unknown";

/**
 * SIM identity + registration (daemon `write_telemetry` `sim` object).
 *
 * READ-ONLY, and the whole block is ABSENT until the daemon's first probe
 * reaches the modem — a daemon predating this plan writes none at all. An
 * absent block means "nothing is known", which every reader must render as
 * UNKNOWN and never as "no SIM": those are the two states the 2026-08-08
 * outage proved cost a day to tell apart.
 *
 * IMSI is deliberately absent: ICCID + carrier + number answer the operational
 * questions, and IMSI is the identifier used for SIM-swap attacks.
 */
export interface ModemSimTelemetry {
  /** 1 present, 0 the modem says no card is inserted, null we cannot tell. */
  present?: 0 | 1 | null;
  state?: SimState;
  /** Card serial (AT+CICCID). Absent until read. */
  iccid?: string;
  /** Subscriber number (AT+CNUM). ABSENT is normal — many carriers never write EF_MSISDN. */
  msisdn?: string;
  carrier?: string;
  /** Access-technology generation from AT+COPS? <AcT>. */
  act?: string;
  /**
   * LAST-KNOWN registration, not live: it comes from the same `<stat>` as the
   * top-level `reg`, which the daemon refreshes in its signal-wait loop and on
   * the health loop's FAILURE path — so on a healthy link it holds the value
   * from before the dial. The daemon forces it to `unknown` whenever `state`
   * is not `ready`, so a pulled card can never report a stale `home`.
   */
  registration?: SimRegistration;
  /** ISO ts of the last probe that reached the modem. */
  checked_at?: string | null;
}

/** APN apply-machinery state as the daemon reports it (Phase 2). */
export type ApnState = "in-force" | "applying" | "rolled-back" | "rejected";

/**
 * APN apply machinery (daemon `write_telemetry` `cellular` object, Phase 2).
 *
 * ABSENT on a daemon predating Phase 2 — and that absence is LOAD-BEARING: it
 * means the device has no confirm-and-rollback safety net, so a UI must refuse
 * to write the `cellular` namespace to it. `apn_applied` is the modem's NV
 * truth (AT+CGDCONT? context 1), which is what `effective.cellular.apn`
 * mirrors — never the requested value.
 */
export interface ModemCellularTelemetry {
  state?: ApnState;
  /** The APN in the modem's data context. Absent while never read / NV empty. */
  apn_applied?: string;
  /** Last non-empty desired value seen. Absent when nothing was ever asked. */
  apn_requested?: string;
  /** Why the last apply rolled back / was rejected. Absent after a clean apply. */
  last_error?: string;
  /** Failed applies of apn_requested — capped, keyed on the value. */
  fails?: number;
  /** ISO ts of the last state transition. */
  changed_at?: string | null;
}

/**
 * Which interface carries the default route (Phase 1). Cheap `ip route` reads,
 * no AT traffic. Phase 2 scales its confirm-before-apply friction off
 * `modem_only`, and on its own it answers "is this box on wifi or cellular?".
 */
export interface ModemUplinkTelemetry {
  /** Interface from the kernel's own route lookup, or null when there is none. */
  primary?: string | null;
  /** 1 when the modem interface is the ONLY default route — losing LTE loses the device. */
  modem_only?: 0 | 1;
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
  /**
   * Last seen 3GPP registration <stat>: 1 home, 5 roaming, 2 searching,
   * 3 denied, 0 none, 99 unknown. Written at telemetry-snapshot time.
   */
  reg?: number;
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
   *
   * `reg` is the registration <stat> AT THE READ INSTANT (optimize-system-
   * process-cycle Phase 8): NITZ only exists after network attach, so the
   * stepper refuses a reading that is not 1/5. Absent on daemons predating
   * Phase 8 — consumers fall back to the top-level `reg`.
   */
  modem_clock?: { cclk: string; read_at: number; reg?: number } | null;
  /** GNSS observability (absent on daemons predating the lte_gnss_recovery plan). */
  gnss?: ModemGnssTelemetry;
  /** Recovery observability (absent on daemons predating the lte_gnss_recovery plan). */
  recovery?: ModemRecoveryTelemetry;
  /** SIM identity (absent on daemons predating manage_sim_card_info Phase 1, or before the first probe). */
  sim?: ModemSimTelemetry | null;
  /** APN apply machinery (absent on daemons predating Phase 2 = no rollback net). */
  cellular?: ModemCellularTelemetry | null;
  /** Default-route uplink (absent on daemons predating manage_sim_card_info Phase 1). */
  uplink?: ModemUplinkTelemetry;
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
