/**
 * Cloud -> device config channel. The backend publishes a retained JSON
 * message to `xorgate/devices/{deviceId}/config` whenever a cloud-managed
 * device setting changes; the worker receives it (on change, and re-delivered
 * on every connect because it is retained) and persists it into settings.json,
 * where the consumer picks it up — e.g. the sim7600-lte daemon polls the file
 * and applies `gnssAntBias` live.
 *
 * Payload shape (full config object, not a delta — idempotent by design):
 *   { "v": 1, "gnssAntBias": boolean, "ts": <epoch ms> }
 * Future cloud-configurable knobs slot in as additional keys.
 */
import { loadSettings, saveSettings, settingsPath } from "../daemon/settings.js";

export interface CloudConfig {
  gnssAntBias?: boolean;
}

/**
 * Parse + validate a config message payload. Returns null when the payload is
 * not a v1 config object; unknown keys are ignored, known keys with the wrong
 * type are dropped (a partial-but-valid message still applies).
 */
export function parseCloudConfig(payload: Buffer | string): CloudConfig | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if ((obj as { v?: unknown }).v !== 1) return null;
  const out: CloudConfig = {};
  const gnssAntBias = (obj as { gnssAntBias?: unknown }).gnssAntBias;
  if (typeof gnssAntBias === "boolean") out.gnssAntBias = gnssAntBias;
  return out;
}

/**
 * Persist a cloud config into settings.json, merging ONLY the cloud-managed
 * keys. Re-reads the file immediately before writing to keep the window for
 * clobbering a concurrent writer (`xorgate set`, the manage UI) as small as
 * possible — atomicWriteJson prevents torn reads but not lost updates; that
 * residual race is accepted (writes are rare, and the retained message
 * re-delivers on the next reconnect). Skips the write when nothing changes,
 * so the retained re-delivery on every reconnect is a no-op.
 */
export function applyCloudConfig(
  config: CloudConfig,
  path: string = settingsPath(),
): { changed: boolean } {
  const current = loadSettings(path);
  if (config.gnssAntBias === undefined || current.gnssAntBias === config.gnssAntBias) {
    return { changed: false };
  }
  saveSettings({ ...current, gnssAntBias: config.gnssAntBias }, path);
  return { changed: true };
}
