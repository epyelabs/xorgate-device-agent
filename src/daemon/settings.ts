/**
 * Persisted agent settings (settings.json under XORGATE_HOME).
 *
 * Distinct from the pidfile (per-run) and state.json (live snapshot): this holds
 * operator choices that should survive restarts. Written by `xorgate set`, the
 * `manage` UI's Settings screen, and the worker (cloud config messages), read by
 * loadConfig() so a restart (manual or systemd) picks up the choice. loadSettings
 * NEVER throws: a missing/corrupt file is treated as "no overrides".
 *
 * Apply semantics differ per key: `mode` and `mediaEnabled` take effect on the
 * next agent (re)start via loadConfig; `gnssAntBias` is instead applied LIVE by
 * the sim7600-lte daemon, which re-reads this file in its health loop and
 * toggles the antenna bias without a restart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { runtimeHome } from "./runtime.js";
import type { RunMode } from "../agent/telemetry.js";

export interface AgentSettings {
  mode?: RunMode;
  /** Operator toggle for the KVS WebRTC media runtime (off unless explicitly enabled). */
  mediaEnabled?: boolean;
  /**
   * GNSS antenna bias: true powers an active GPS antenna's LNA over the coax
   * (modem AT+CVAUXV/AT+CVAUXS). Absent/false = passive antenna, bias off (the
   * hardware-safe default). Set from the web device settings page (retained
   * MQTT config -> worker) or `xorgate set gps-antenna`; applied live by the
   * sim7600-lte daemon.
   */
  gnssAntBias?: boolean;
}

export function settingsPath(): string {
  return join(runtimeHome(), "settings.json");
}

/** Read persisted settings, or {} when absent/unreadable/invalid. */
export function loadSettings(path: string = settingsPath()): AgentSettings {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (obj && typeof obj === "object") {
      const out: AgentSettings = {};
      const mode = (obj as { mode?: unknown }).mode;
      if (mode === "sim" || mode === "real") out.mode = mode;
      const mediaEnabled = (obj as { mediaEnabled?: unknown }).mediaEnabled;
      if (typeof mediaEnabled === "boolean") out.mediaEnabled = mediaEnabled;
      const gnssAntBias = (obj as { gnssAntBias?: unknown }).gnssAntBias;
      if (typeof gnssAntBias === "boolean") out.gnssAntBias = gnssAntBias;
      return out;
    }
  } catch {
    /* missing / corrupt — fall through to no overrides */
  }
  return {};
}

/** Persist settings atomically (durable across power loss on the Pi). */
export function saveSettings(settings: AgentSettings, path: string = settingsPath()): void {
  atomicWriteJson(path, settings);
}
