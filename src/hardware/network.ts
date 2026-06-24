/**
 * Network interfaces — discovery + per-interface internet reachability, plus the
 * WiFi radio presence/state behind `xorgate set wifi`.
 *
 * The monitor header probes each interface's ACTUAL internet reachability, not
 * just its link state: a default route can sit on a dead uplink (e.g. the modem
 * with its antenna unplugged keeps a metric-100 route, so the kernel black-holes
 * traffic into it). The only reliable way to test a SPECIFIC interface is to bind
 * the probe to it — `ping -I <iface>` does exactly that (unprivileged on Linux).
 *
 * Discovery is zero-subprocess (readdir /sys/class/net + os.networkInterfaces);
 * we only spawn a ping for interfaces that actually carry an IPv4 address, and
 * the monitor polls this on a slow cadence while the TUI is open. Nothing here
 * runs on the agent's telemetry hot path.
 */
import { readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { run } from "../lib/exec.js";

/** A network interface's internet reachability. */
export type IfaceState = "online" | "offline" | "down";

export interface IfaceStatus {
  name: string;
  state: IfaceState;
}

const SYS_CLASS_NET = "/sys/class/net";

/**
 * Interfaces we never show: loopback, software/virtual devices, and the
 * macOS-only pseudo-interfaces (awdl/llw/utun/…) so a dev box isn't noisy.
 */
const VIRTUAL_IFACE =
  /^(lo|p2p-|veth|docker|br-|bridge|virbr|tun|tap|utun|bond|dummy|wg|ifb|sit|awdl|llw|anpi|gif|stf|ap\d)/;

/** Pure: should this interface be hidden from the internet-status row? */
export function isVirtualIface(name: string): boolean {
  return VIRTUAL_IFACE.test(name);
}

/** Sort rank so the header order is stable: eth*, usb*, wlan*, then the rest. */
function ifaceRank(name: string): number {
  if (name.startsWith("eth")) return 0;
  if (name.startsWith("usb")) return 1;
  if (name.startsWith("wlan")) return 2;
  return 3;
}

/** Pure: order interface names for display (rank, then lexical). */
export function sortInterfaces(names: string[]): string[] {
  return [...names].sort((a, b) => ifaceRank(a) - ifaceRank(b) || a.localeCompare(b));
}

/** Real, non-virtual interface names from /sys/class/net (sorted for display). */
export async function listInterfaces(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(SYS_CLASS_NET);
  } catch {
    // Non-Linux dev box: fall back to whatever os.networkInterfaces() knows.
    entries = Object.keys(networkInterfaces());
  }
  return sortInterfaces(entries.filter((n) => !isVirtualIface(n)));
}

/** First non-internal IPv4 of an interface, or null when it has none. */
export function ipv4Of(name: string): string | null {
  for (const a of networkInterfaces()[name] ?? []) {
    // node <18 reported a numeric family (4); >=18 uses the string "IPv4".
    const isV4 = a.family === "IPv4" || (a.family as unknown) === 4;
    if (isV4 && !a.internal) return a.address;
  }
  return null;
}

/** Reachability probe target — a well-known ICMP responder (Cloudflare). */
export const PROBE_HOST = process.env.XORGATE_PROBE_HOST ?? "1.1.1.1";

/**
 * Probe one interface's internet reachability. An interface with no IPv4 is
 * "down" (nothing to test); otherwise a single interface-bound ping decides
 * online vs offline. `ping -I <iface>` forces egress out that interface, which
 * is what distinguishes a working uplink from a black-holed one.
 */
export async function probeInterface(name: string): Promise<IfaceState> {
  if (!ipv4Of(name)) return "down";
  const res = await run("ping", ["-c", "1", "-W", "2", "-I", name, PROBE_HOST], {
    timeoutMs: 3000,
  });
  return res.failed ? "offline" : "online";
}

/** Discover interfaces and probe them all in parallel. */
export async function interfaceStatuses(): Promise<IfaceStatus[]> {
  const names = await listInterfaces();
  return Promise.all(names.map(async (name) => ({ name, state: await probeInterface(name) })));
}

// --- WiFi radio (for `set wifi on|off`) -------------------------------------

export interface WifiPresence {
  present: boolean;
  enabled: boolean;
  /** NetworkManager device name (e.g. "wlan0") when present. */
  device?: string;
}

/** Pure: first wifi DEVICE in `nmcli -t -f DEVICE,TYPE device status`, or null. */
export function parseWifiDevice(nmcliStatus: string): string | null {
  for (const line of nmcliStatus.split("\n")) {
    const [device, type] = line.split(":");
    if (type === "wifi" && device) return device;
  }
  return null;
}

/** Pure: from `nmcli -t -f DEVICE,STATE device status`, is `device` up? */
export function parseDeviceEnabled(nmcliStatus: string, device: string): boolean {
  for (const line of nmcliStatus.split("\n")) {
    const [dev, state] = line.split(":");
    if (dev === device) return state === "connected" || state === "connecting";
  }
  return false;
}

/**
 * Detect the WiFi adapter and whether its device is currently up. Uses
 * NetworkManager (the active stack on the Pi); falls back to a wlan* netdev for
 * presence when nmcli is unavailable.
 */
export async function detectWifi(): Promise<WifiPresence> {
  const dev = await run("nmcli", ["-t", "-f", "DEVICE,TYPE", "device", "status"]);
  const device = dev.failed ? null : parseWifiDevice(dev.stdout);
  if (!device) {
    const fallback = (await listInterfaces()).find((n) => n.startsWith("wlan")) ?? null;
    return { present: !!fallback, enabled: !!fallback && !!ipv4Of(fallback), device: fallback ?? undefined };
  }
  const st = await run("nmcli", ["-t", "-f", "DEVICE,STATE", "device", "status"]);
  const enabled = !st.failed && parseDeviceEnabled(st.stdout, device);
  return { present: true, enabled, device };
}

// --- Self-cutoff guard helpers ----------------------------------------------

/** Pure: server-side IP from $SSH_CONNECTION ("clientIp clientPort serverIp serverPort"). */
export function sshServerIp(sshConnection: string | undefined): string | null {
  if (!sshConnection) return null;
  const parts = sshConnection.trim().split(/\s+/);
  return parts.length >= 3 ? parts[2] : null;
}

/** The interface owning a given IPv4 address, or null. */
export function ifaceForIp(ip: string | null): string | null {
  if (!ip) return null;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      const isV4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (isV4 && a.address === ip) return name;
    }
  }
  return null;
}
