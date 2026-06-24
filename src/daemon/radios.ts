/**
 * Radio control — the one code path that turns WiFi on/off, shared by the CLI
 * (`xorgate set wifi`) and the `manage` Settings screen so both behave the same.
 *
 * Runtime-only by design: `nmcli device connect|disconnect` changes the live
 * state but NetworkManager auto-connects again on reboot (the device returns to
 * its default state). It's idempotent — a no-op when already in the target state
 * — so nmcli never errors with "already (dis)connected". Needs root; the CLI/TUI
 * run as `pi`, which has passwordless sudo on the device.
 */
import { detectWifi } from "../hardware/network.js";
import { run } from "../lib/exec.js";

export interface RadioResult {
  ok: boolean;
  message: string;
}

/** Turn the WiFi device on (connect) or off (disconnect) via NetworkManager. */
export async function setWifi(on: boolean): Promise<RadioResult> {
  const wifi = await detectWifi();
  if (!wifi.present) return { ok: false, message: "no WiFi adapter detected" };
  const device = wifi.device ?? "wlan0";
  if (wifi.enabled === on) {
    return { ok: true, message: `wifi already ${on ? "on" : "off"} (${device})` };
  }
  const res = await run("sudo", ["nmcli", "device", on ? "connect" : "disconnect", device]);
  if (res.failed) {
    const why = res.stderr.trim() || (res.notFound ? "sudo/nmcli not found" : `exit ${res.exitCode}`);
    return { ok: false, message: `wifi ${on ? "on" : "off"} failed: ${why}` };
  }
  return { ok: true, message: `wifi ${on ? "on" : "off"} (${device})` };
}
