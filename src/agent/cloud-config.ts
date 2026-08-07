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
 *   { "v": 1, "rev": <monotonic desired revision, optional>,
 *     "gnssAntBias": boolean,
 *     "imuMount": { enabled, rollDeg, pitchDeg, yawDeg },
 *     "recording": { telemetry, video, upload, retention },
 *     "lteRecovery": { gpsFixResetPolicy, deadZoneProfile },
 *     "timeSync": { offlineSources, stepThresholdSecs, maxStepsPerBoot },
 *     "ts": <epoch ms> }
 * Future cloud-configurable knobs slot in as additional keys.
 *
 * `rev` (settings-management plan, Phase 2/3) is the cloud's monotonic
 * `devices.config_rev`. It is metadata, not config: nothing here ever writes it
 * into settings.json. The worker uses it as a guard (skip a document already
 * applied) and echoes it back on the reported topic — see `config-sync.ts`,
 * which is the other half of this seam.
 *
 * `lteRecovery` (lte_gnss_recovery plan, R8) follows the same REPLACE
 * semantics as `recording`: present → settings.json's `lteRecovery` becomes
 * exactly the cloud value (the sim7600-lte daemon re-reads it at each
 * recovery decision, no restart); absent → local settings untouched.
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
  readSettingsFile,
  parseLteRecoverySettings,
  parseRecordingSettings,
  parseTimeSyncSettings,
  saveSettings,
  settingsPath,
  type LteRecoverySettings,
  type RecordingSettings,
  type TimeSyncSettings,
} from "../daemon/settings.js";
import { parseImuMount, type ImuMount } from "../lib/orientation.js";

export interface CloudConfig {
  /**
   * Monotonic desired-config revision (`devices.config_rev`), added additively
   * in Phase 2 of the settings-management plan. ABSENT or 0 means the backend
   * predates it — the worker then applies unconditionally, exactly like it did
   * before, which is what keeps a new agent working against an old backend.
   * When present, the worker skips a document whose rev it has already applied
   * (see `agent/config-sync.ts`), so reconnect redelivery stops reverting
   * state the device already holds.
   */
  rev?: number;
  gnssAntBias?: boolean;
  imuMount?: ImuMount;
  /**
   * null = the message carried a `recording` object with no valid fields
   * ("cloud manages recording, all defaults") — applied by removing the local
   * key. Absent (undefined) = message had no recording key; leave local alone.
   */
  recording?: RecordingSettings | null;
  /**
   * LTE recovery policy (lte_gnss_recovery plan, R8). Same replace-whole-
   * namespace semantics as `recording`: null = carried but nothing valid →
   * remove the local key (daemon falls back to defaults); absent = never
   * cloud-configured, leave local settings alone.
   */
  lteRecovery?: LteRecoverySettings | null;
  /**
   * Offline time sources (optimize-system-process-cycle plan, Phase 4). Same
   * replace-whole-namespace semantics as `recording`: null = carried but
   * nothing valid → remove the local key (stepper falls back to defaults);
   * absent = never cloud-configured, leave local settings alone.
   */
  timeSync?: TimeSyncSettings | null;
  /**
   * Segment-upload S3 bucket (Phase 6.2 backfill for devices fielded before
   * Phase 2 provisioning). Persisted into kvs.json — NOT settings.json — by
   * the worker (see persistUploadBucket); carried here so parsing stays in
   * one place.
   */
  uploadBucket?: string;
}

/**
 * A parsed config message plus the RAW object it came from.
 *
 * The reported plane (Phase 3) needs both halves: `config` is what the device
 * will actually hold, `raw` is what the cloud asked for, and the difference
 * between them is exactly the `adjusted` verdict the cloud can otherwise never
 * see (two different cloud payloads can clamp to one stored value, and today
 * nothing says so).
 */
export interface CloudConfigMessage {
  /** Every top-level key as delivered, before the tolerant parse. */
  raw: Record<string, unknown>;
  config: CloudConfig;
}

/**
 * Parse a config message into its raw + normalized halves. Returns null when
 * the payload is not a v1 config object.
 */
export function parseCloudMessage(payload: Buffer | string): CloudConfigMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if ((obj as { v?: unknown }).v !== 1) return null;
  const config = parseNamespaces(obj as Record<string, unknown>);
  return { raw: obj as Record<string, unknown>, config };
}

/**
 * Parse + validate a config message payload. Returns null when the payload is
 * not a v1 config object; unknown keys are ignored, known keys with the wrong
 * type are dropped (a partial-but-valid message still applies).
 */
export function parseCloudConfig(payload: Buffer | string): CloudConfig | null {
  return parseCloudMessage(payload)?.config ?? null;
}

function parseNamespaces(obj: Record<string, unknown>): CloudConfig {
  const out: CloudConfig = {};
  // Additive Phase 2 field. Anything not a positive finite integer is treated
  // as absent, i.e. "always apply" — the compat path, never a hard failure.
  const rev = (obj as { rev?: unknown }).rev;
  if (typeof rev === "number" && Number.isFinite(rev) && rev > 0) out.rev = Math.floor(rev);
  const gnssAntBias = (obj as { gnssAntBias?: unknown }).gnssAntBias;
  if (typeof gnssAntBias === "boolean") out.gnssAntBias = gnssAntBias;
  const imuMount = parseImuMount((obj as { imuMount?: unknown }).imuMount);
  if (imuMount) out.imuMount = imuMount;
  const uploadBucket = (obj as { uploadBucket?: unknown }).uploadBucket;
  if (typeof uploadBucket === "string" && uploadBucket.length > 0) {
    out.uploadBucket = uploadBucket;
  }
  const recording = (obj as { recording?: unknown }).recording;
  if (recording && typeof recording === "object" && !Array.isArray(recording)) {
    // parseRecordingSettings normalizes (clamps numbers, drops mistyped keys)
    // exactly like a local settings.json read, so cloud and local values
    // compare structurally equal. An all-invalid/empty object → null.
    out.recording = parseRecordingSettings(recording) ?? null;
  }
  const lteRecovery = (obj as { lteRecovery?: unknown }).lteRecovery;
  if (lteRecovery && typeof lteRecovery === "object" && !Array.isArray(lteRecovery)) {
    out.lteRecovery = parseLteRecoverySettings(lteRecovery) ?? null;
  }
  const timeSync = (obj as { timeSync?: unknown }).timeSync;
  if (timeSync && typeof timeSync === "object" && !Array.isArray(timeSync)) {
    out.timeSync = parseTimeSyncSettings(timeSync) ?? null;
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
  // Merging onto `{}` because the file could not be READ would write a
  // settings.json containing only what this message carried — silently dropping
  // `mode` and every namespace the cloud does not manage. Found live in phase 6
  // of the settings-management plan: `sudo xorgate set …` leaves the file
  // root-owned, the agent runs as the provisioning user, and the next retained
  // redelivery flattened it.
  //
  // ONLY `unreadable` refuses. An ABSENT file has nothing to lose, and a
  // CORRUPT one has already lost it — overwriting both is the self-heal that
  // keeps a torn write from wedging config delivery forever.
  const read = readSettingsFile(path);
  if (!read.ok && read.reason === "unreadable") {
    throw new Error(
      `settings.json exists but cannot be read — refusing to overwrite it (check owner/permissions on ${path})`,
    );
  }
  const current = read.ok ? read.settings : {};
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
  // Same replace semantics for the LTE recovery policy namespace.
  let lteRecoveryChange: "set" | "clear" | undefined;
  if (config.lteRecovery !== undefined) {
    const target = config.lteRecovery ?? undefined;
    if (JSON.stringify(target) !== JSON.stringify(current.lteRecovery)) {
      lteRecoveryChange = target ? "set" : "clear";
    }
  }
  // ... and for the offline time-sync namespace.
  let timeSyncChange: "set" | "clear" | undefined;
  if (config.timeSync !== undefined) {
    const target = config.timeSync ?? undefined;
    if (JSON.stringify(target) !== JSON.stringify(current.timeSync)) {
      timeSyncChange = target ? "set" : "clear";
    }
  }
  if (
    Object.keys(next).length === 0 &&
    recordingChange === undefined &&
    lteRecoveryChange === undefined &&
    timeSyncChange === undefined
  ) {
    return { changed: false };
  }
  const merged = { ...current, ...next };
  if (recordingChange === "set") merged.recording = config.recording as RecordingSettings;
  else if (recordingChange === "clear") delete merged.recording;
  if (lteRecoveryChange === "set") merged.lteRecovery = config.lteRecovery as LteRecoverySettings;
  else if (lteRecoveryChange === "clear") delete merged.lteRecovery;
  if (timeSyncChange === "set") merged.timeSync = config.timeSync as TimeSyncSettings;
  else if (timeSyncChange === "clear") delete merged.timeSync;
  saveSettings(merged, path);
  return { changed: true };
}

type AgentSettingsPatch = { gnssAntBias?: boolean; imuMount?: ImuMount };
