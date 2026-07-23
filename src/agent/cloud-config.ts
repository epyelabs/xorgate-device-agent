/**
 * Cloud -> device config channel. The backend publishes a retained JSON
 * message to `xorgate/devices/{deviceId}/config` whenever a cloud-managed
 * device setting changes; the worker receives it (on change, and re-delivered
 * on every connect because it is retained) and persists it into settings.json,
 * where the consumer picks it up — e.g. the sim7600-lte daemon polls the file
 * and applies `gnssAntBias` live, and the IMU collector re-reads `imuMount`
 * each tick.
 *
 * Payload shape (full config object, not a delta — idempotent by design):
 *   { "v": 1, "gnssAntBias": boolean,
 *     "imuMount": { enabled, rollDeg, pitchDeg, yawDeg },
 *     "recording": { telemetry, video, upload, retention }, "ts": <epoch ms> }
 * Future cloud-configurable knobs slot in as additional keys.
 *
 * `recording` (offline recording plan, Phase 5 / D7) is REPLACE, not
 * per-field merge: when the message carries the key, settings.json's whole
 * `recording` namespace becomes exactly the cloud value (the cloud publishes
 * its complete stored config, and it is authoritative once set — a local
 * `xorgate set recording.*` tweak is expected to be overwritten on the next
 * retained redelivery). When the key is absent (recording never configured
 * from the cloud), local settings are left untouched. The worker re-reads
 * settings after every apply (RecordingManager.reapply), so changes take
 * effect live without a restart.
 */
import {
  loadSettings,
  parseRecordingSettings,
  saveSettings,
  settingsPath,
  type RecordingSettings,
} from "../daemon/settings.js";
import { parseImuMount, type ImuMount } from "../lib/orientation.js";

export interface CloudConfig {
  gnssAntBias?: boolean;
  imuMount?: ImuMount;
  /**
   * null = the message carried a `recording` object with no valid fields
   * ("cloud manages recording, all defaults") — applied by removing the local
   * key. Absent (undefined) = message had no recording key; leave local alone.
   */
  recording?: RecordingSettings | null;
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
  const imuMount = parseImuMount((obj as { imuMount?: unknown }).imuMount);
  if (imuMount) out.imuMount = imuMount;
  const recording = (obj as { recording?: unknown }).recording;
  if (recording && typeof recording === "object" && !Array.isArray(recording)) {
    // parseRecordingSettings normalizes (clamps numbers, drops mistyped keys)
    // exactly like a local settings.json read, so cloud and local values
    // compare structurally equal. An all-invalid/empty object → null.
    out.recording = parseRecordingSettings(recording) ?? null;
  }
  return out;
}

function imuMountEqual(a: ImuMount | undefined, b: ImuMount | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.enabled === b.enabled &&
    a.rollDeg === b.rollDeg &&
    a.pitchDeg === b.pitchDeg &&
    a.yawDeg === b.yawDeg
  );
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
  const next: AgentSettingsPatch = {};
  if (config.gnssAntBias !== undefined && config.gnssAntBias !== current.gnssAntBias) {
    next.gnssAntBias = config.gnssAntBias;
  }
  if (config.imuMount !== undefined && !imuMountEqual(config.imuMount, current.imuMount)) {
    next.imuMount = config.imuMount;
  }
  // Replace-whole-namespace semantics (see file header). Both sides are
  // normalized by parseRecordingSettings (fixed key order), so JSON equality
  // is a sound change check.
  let recordingChange: "set" | "clear" | undefined;
  if (config.recording !== undefined) {
    const target = config.recording ?? undefined;
    if (JSON.stringify(target) !== JSON.stringify(current.recording)) {
      recordingChange = target ? "set" : "clear";
    }
  }
  if (Object.keys(next).length === 0 && recordingChange === undefined) {
    return { changed: false };
  }
  const merged = { ...current, ...next };
  if (recordingChange === "set") merged.recording = config.recording as RecordingSettings;
  else if (recordingChange === "clear") delete merged.recording;
  saveSettings(merged, path);
  return { changed: true };
}

type AgentSettingsPatch = { gnssAntBias?: boolean; imuMount?: ImuMount };
