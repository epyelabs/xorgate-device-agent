/**
 * Persisted agent settings (settings.json under XORGATE_HOME).
 *
 * Distinct from the pidfile (per-run) and state.json (live snapshot): this holds
 * operator choices that should survive restarts — currently just the run mode.
 * Written by `xorgate set` and the `manage` UI's Settings screen, read by
 * loadConfig() so a restart (manual or systemd) picks up the choice. loadSettings
 * NEVER throws: a missing/corrupt file is treated as "no overrides".
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
