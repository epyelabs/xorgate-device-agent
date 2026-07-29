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
import { parseImuMount, type ImuMount } from "../lib/orientation.js";
import type { RunMode } from "../agent/telemetry.js";

/**
 * On-device recording config (plan D7) — the `recording` namespace persisted in
 * settings.json. Every field is optional; defaults live in
 * `src/recording/config.ts` (resolveRecordingConfig). Set via `xorgate set
 * recording.* <value>` for Phases 1–4; Phase 5 delivers the same shape from the
 * cloud. Applied LIVE by the worker's recording manager, which re-reads this
 * file on a slow poll — no agent restart.
 */
export interface RecordingSettings {
  telemetry?: { enabled?: boolean; rateHz?: number };
  video?: {
    enabled?: boolean;
    preset?: string;
    segmentSeconds?: number;
    /**
     * Boot power staging (optimize-system-process-cycle plan, Phase 2):
     * "auto" (default) defers heavy encoders at boot only when the negotiated
     * PSU budget is below bootDeferMinBudgetMa; "always" defers every boot;
     * "off" is today's start-everything behavior.
     */
    bootDefer?: "auto" | "always" | "off";
    /** Hard cap on the boot defer, seconds (default 90; 0 = feature off). */
    bootDeferMaxSecs?: number;
    /** `auto` skips the defer at/above this negotiated budget in mA (default 5000). */
    bootDeferMinBudgetMa?: number;
    /** Inter-camera spawn delay, seconds (default 4; 0 = simultaneous as before). */
    spawnStaggerSecs?: number;
  };
  upload?: { mode?: "auto" | "off" };
  retention?: { maxBytes?: number; minFreeBytes?: number };
}

/**
 * LTE recovery policy (lte_gnss_recovery plan, R8) — the `lteRecovery`
 * namespace in settings.json, read LIVE by the sim7600-lte daemon at each
 * recovery decision (no restart needed). Both keys optional; the daemon
 * resolves anything missing/unknown to the safe default (defer / balanced).
 * CRITICAL: this must stay in AgentSettings parse+persist — loadSettings
 * drops unknown keys on every rewrite, so omitting it here would silently
 * delete cloud-delivered policy on the next agent-side settings write.
 */
export interface LteRecoverySettings {
  /** What a live GNSS fix means for a modem reset: defer (default) or fully veto dead-zone resets. */
  gpsFixResetPolicy?: "defer" | "veto-deadzone";
  /** Dead-zone nudge pacing preset (default balanced). */
  deadZoneProfile?: "conservative" | "balanced" | "aggressive";
}

/**
 * Validate an untrusted `lteRecovery` value, dropping unknown/mistyped keys
 * (same forgiving philosophy as parseRecordingSettings). Returns undefined
 * when nothing valid remains.
 */
export function parseLteRecoverySettings(v: unknown): LteRecoverySettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const src = v as Record<string, unknown>;
  const out: LteRecoverySettings = {};
  const policy = src.gpsFixResetPolicy;
  if (policy === "defer" || policy === "veto-deadzone") out.gpsFixResetPolicy = policy;
  const profile = src.deadZoneProfile;
  if (profile === "conservative" || profile === "balanced" || profile === "aggressive") {
    out.deadZoneProfile = profile;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
  /**
   * IMU mounting correction (how the sensor is rotated relative to the
   * vehicle). Set from the web device settings page (retained MQTT config ->
   * worker); applied LIVE by the IMU collector, which re-reads this file each
   * tick — no restart needed. Absent = publish sensor-frame euler as-is.
   */
  imuMount?: ImuMount;
  /** On-device recording config (see RecordingSettings); absent = all defaults (off). */
  recording?: RecordingSettings;
  /**
   * LTE recovery policy (see LteRecoverySettings). Set from the web device
   * settings page (retained MQTT config -> worker) or `xorgate set`; read
   * LIVE by the sim7600-lte daemon at each recovery decision. Absent = the
   * daemon's safe defaults (gpsFixResetPolicy defer, deadZoneProfile balanced).
   */
  lteRecovery?: LteRecoverySettings;
}

/** Clamp `rateHz` to what the collectors can produce (IMU caps at 20 Hz). */
export const RECORDING_RATE_HZ_MIN = 1;
export const RECORDING_RATE_HZ_MAX = 20;

/**
 * Validate an untrusted `recording` value into RecordingSettings, dropping
 * anything mistyped (same forgiving philosophy as the rest of loadSettings:
 * a partially-valid object still applies). Numbers are clamped, not rejected,
 * so an out-of-range rateHz degrades to the nearest supported rate. Returns
 * undefined when nothing valid remains.
 */
export function parseRecordingSettings(v: unknown): RecordingSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const src = v as Record<string, unknown>;
  const out: RecordingSettings = {};

  const tel = src.telemetry;
  if (tel && typeof tel === "object") {
    const t: NonNullable<RecordingSettings["telemetry"]> = {};
    const enabled = (tel as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") t.enabled = enabled;
    const rateHz = (tel as { rateHz?: unknown }).rateHz;
    if (typeof rateHz === "number" && Number.isFinite(rateHz)) {
      t.rateHz = Math.min(RECORDING_RATE_HZ_MAX, Math.max(RECORDING_RATE_HZ_MIN, Math.round(rateHz)));
    }
    if (Object.keys(t).length > 0) out.telemetry = t;
  }

  const vid = src.video;
  if (vid && typeof vid === "object") {
    const o: NonNullable<RecordingSettings["video"]> = {};
    const enabled = (vid as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") o.enabled = enabled;
    const preset = (vid as { preset?: unknown }).preset;
    if (typeof preset === "string" && preset.length > 0) o.preset = preset;
    const segmentSeconds = (vid as { segmentSeconds?: unknown }).segmentSeconds;
    if (typeof segmentSeconds === "number" && Number.isFinite(segmentSeconds)) {
      o.segmentSeconds = Math.min(600, Math.max(10, Math.round(segmentSeconds)));
    }
    const bootDefer = (vid as { bootDefer?: unknown }).bootDefer;
    if (bootDefer === "auto" || bootDefer === "always" || bootDefer === "off") {
      o.bootDefer = bootDefer;
    }
    const bootDeferMaxSecs = (vid as { bootDeferMaxSecs?: unknown }).bootDeferMaxSecs;
    if (typeof bootDeferMaxSecs === "number" && Number.isFinite(bootDeferMaxSecs)) {
      // 0 stays meaningful (feature off); the cap keeps "recording is the
      // product" honest — no defer may be configured past 10 minutes.
      o.bootDeferMaxSecs = Math.min(600, Math.max(0, Math.round(bootDeferMaxSecs)));
    }
    const bootDeferMinBudgetMa = (vid as { bootDeferMinBudgetMa?: unknown }).bootDeferMinBudgetMa;
    if (typeof bootDeferMinBudgetMa === "number" && Number.isFinite(bootDeferMinBudgetMa)) {
      o.bootDeferMinBudgetMa = Math.min(10_000, Math.max(0, Math.round(bootDeferMinBudgetMa)));
    }
    const spawnStaggerSecs = (vid as { spawnStaggerSecs?: unknown }).spawnStaggerSecs;
    if (typeof spawnStaggerSecs === "number" && Number.isFinite(spawnStaggerSecs)) {
      o.spawnStaggerSecs = Math.min(30, Math.max(0, Math.round(spawnStaggerSecs)));
    }
    if (Object.keys(o).length > 0) out.video = o;
  }

  const up = src.upload;
  if (up && typeof up === "object") {
    const mode = (up as { mode?: unknown }).mode;
    if (mode === "auto" || mode === "off") out.upload = { mode };
  }

  const ret = src.retention;
  if (ret && typeof ret === "object") {
    const r: NonNullable<RecordingSettings["retention"]> = {};
    const maxBytes = (ret as { maxBytes?: unknown }).maxBytes;
    if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0) {
      r.maxBytes = Math.round(maxBytes);
    }
    const minFreeBytes = (ret as { minFreeBytes?: unknown }).minFreeBytes;
    if (typeof minFreeBytes === "number" && Number.isFinite(minFreeBytes) && minFreeBytes >= 0) {
      r.minFreeBytes = Math.round(minFreeBytes);
    }
    if (Object.keys(r).length > 0) out.retention = r;
  }

  return Object.keys(out).length > 0 ? out : undefined;
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
      const imuMount = parseImuMount((obj as { imuMount?: unknown }).imuMount);
      if (imuMount) out.imuMount = imuMount;
      const recording = parseRecordingSettings((obj as { recording?: unknown }).recording);
      if (recording) out.recording = recording;
      const lteRecovery = parseLteRecoverySettings((obj as { lteRecovery?: unknown }).lteRecovery);
      if (lteRecovery) out.lteRecovery = lteRecovery;
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
