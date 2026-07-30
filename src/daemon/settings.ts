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
    /**
     * Per-camera enable, keyed by streamKey (optimize-system-process-cycle
     * plan, Phase 6): `{"cam1": false}` turns camera 1 off entirely — no
     * capture, no shm bridge, no KVS master, sensor path cold. An ABSENT key
     * means enabled, so the default (`{}` / no key at all) is today's "every
     * detected camera runs". Camera count is a deliberate install-time
     * capacity choice (1 camera on a 3 A supply, 2 on 5 A), never something
     * the load-shedding ladder toggles (Q9, 2026-07-30).
     */
    cameras?: Record<string, boolean>;
  };
  upload?: { mode?: "auto" | "off" };
  retention?: { maxBytes?: number; minFreeBytes?: number };
  /**
   * Runtime undervoltage load shedding (optimize-system-process-cycle plan,
   * Phase 3): when the 5 V rail measurably fails, shed live streaming first,
   * then recording (bridge-only), and restore with hysteresis. All thresholds
   * are Q4 STARTING values, cloud-tunable for the Phase 5 field loop;
   * defaults live in `src/recording/config.ts`.
   */
  powerShedding?: {
    enabled?: boolean;
    /** Shed when this many CURRENT-undervoltage samples land within uvWindowSecs. */
    uvSamples?: number;
    uvWindowSecs?: number;
    /** ... OR the 5 V rail stays below this for railLowSecs straight. */
    railLowVolts?: number;
    railLowSecs?: number;
    /** Trailing window (seconds) evaluated for escalation to the next rung. */
    escalateDwellSecs?: number;
    /**
     * Escalate when the supply was bad (triggered, or an unhealthy sample) for
     * at least this % of the trailing escalateDwellSecs window (Phase 6;
     * default 70, clamp 50–100). 100 is the old "continuously bad" rule, which
     * a bouncing rail never satisfies — the 2026-07-30 crash.
     */
    escalateDutyPct?: number;
    /** Clean interval (no UV, rail ≥ railRestoreVolts) per restored rung. */
    restoreSecs?: number;
    railRestoreVolts?: number;
    /** Shed cycles per rolling hour before parking at the shed level. */
    maxShedsPerHour?: number;
  };
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

/**
 * Offline time sources (optimize-system-process-cycle plan, Phase 4) — the
 * `timeSync` namespace in settings.json, read LIVE by the worker's clock
 * stepper each tick. All optional; defaults in `src/agent/clock-step.ts`
 * (offlineSources on, 10 s threshold, 4 steps/boot). `offlineSources: false`
 * is the Q5 kill switch: the stepper never touches the clock. The stepper
 * additionally self-disarms for the whole boot once NTP has ever synchronized
 * (a future battery-backed RTC boots inside the threshold, making the feature
 * a natural no-op with no config change).
 */
export interface TimeSyncSettings {
  /** Master enable for GPS/NITZ clock stepping while NTP is unsynced (default on). */
  offlineSources?: boolean;
  /** Step only when |clock offset| exceeds this many seconds (default 10). */
  stepThresholdSecs?: number;
  /** Hard cap on clock steps per boot (default 4; caps a flapping source). */
  maxStepsPerBoot?: number;
}

/**
 * Validate an untrusted `timeSync` value, clamping numbers and dropping
 * mistyped keys (same forgiving philosophy as parseRecordingSettings).
 * Returns undefined when nothing valid remains.
 */
export function parseTimeSyncSettings(v: unknown): TimeSyncSettings | undefined {
  if (!v || typeof v !== "object") return undefined;
  const src = v as Record<string, unknown>;
  const out: TimeSyncSettings = {};
  if (typeof src.offlineSources === "boolean") out.offlineSources = src.offlineSources;
  const threshold = src.stepThresholdSecs;
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    // Floor 2 s: below NITZ/NMEA-arrival granularity a threshold would flap.
    out.stepThresholdSecs = Math.min(600, Math.max(2, Math.round(threshold)));
  }
  const maxSteps = src.maxStepsPerBoot;
  if (typeof maxSteps === "number" && Number.isFinite(maxSteps)) {
    out.maxStepsPerBoot = Math.min(20, Math.max(1, Math.round(maxSteps)));
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
  /**
   * Offline time sources (see TimeSyncSettings). Set from the web device
   * settings page (retained MQTT config -> worker) or `xorgate set`; read
   * LIVE by the worker's clock stepper each tick. Absent = defaults
   * (stepping on, 10 s threshold).
   */
  timeSync?: TimeSyncSettings;
}

/** Clamp `rateHz` to what the collectors can produce (IMU caps at 20 Hz). */
export const RECORDING_RATE_HZ_MIN = 1;
export const RECORDING_RATE_HZ_MAX = 20;

/**
 * Accepted `recording.video.cameras` keys: KVS stream keys (kvs.json
 * `streamKey`, e.g. `cam0`). Same shape the pipeline/shm-socket filenames use,
 * so anything outside it could never name a real camera anyway.
 */
export const STREAM_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;

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
    // Per-camera enables (Phase 6): a map of streamKey -> boolean. Non-boolean
    // values and implausible keys are dropped rather than rejected, and an
    // absent key means enabled — a typo can never silently blind a camera.
    const cams = (vid as { cameras?: unknown }).cameras;
    if (cams && typeof cams === "object" && !Array.isArray(cams)) {
      const c: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(cams as Record<string, unknown>)) {
        if (typeof value === "boolean" && STREAM_KEY_RE.test(key)) c[key] = value;
      }
      if (Object.keys(c).length > 0) o.cameras = c;
    }
    if (Object.keys(o).length > 0) out.video = o;
  }

  const up = src.upload;
  if (up && typeof up === "object") {
    const mode = (up as { mode?: unknown }).mode;
    if (mode === "auto" || mode === "off") out.upload = { mode };
  }

  const shed = src.powerShedding;
  if (shed && typeof shed === "object") {
    const p: NonNullable<RecordingSettings["powerShedding"]> = {};
    const enabled = (shed as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") p.enabled = enabled;
    // Integer knobs, clamped (forgiving posture — a bad value degrades to the
    // nearest sane one rather than disabling protection).
    const ints: [keyof typeof p, number, number][] = [
      ["uvSamples", 1, 60],
      ["uvWindowSecs", 5, 300],
      ["railLowSecs", 3, 120],
      ["escalateDwellSecs", 5, 600],
      // 50 % floor: below "more triggered than not" the ladder would escalate
      // off noise; 100 = the pre-Phase-6 continuous-dwell rule.
      ["escalateDutyPct", 50, 100],
      ["restoreSecs", 10, 3600],
      ["maxShedsPerHour", 0, 60],
    ];
    for (const [field, min, max] of ints) {
      const v = (shed as Record<string, unknown>)[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        (p as Record<string, unknown>)[field] = Math.min(max, Math.max(min, Math.round(v)));
      }
    }
    // Voltage thresholds keep their decimals; bounds bracket plausible 5 V rails.
    const volts: [keyof typeof p, number, number][] = [
      ["railLowVolts", 4.0, 5.2],
      ["railRestoreVolts", 4.0, 5.4],
    ];
    for (const [field, min, max] of volts) {
      const v = (shed as Record<string, unknown>)[field];
      if (typeof v === "number" && Number.isFinite(v)) {
        (p as Record<string, unknown>)[field] = Math.min(max, Math.max(min, v));
      }
    }
    if (Object.keys(p).length > 0) out.powerShedding = p;
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
      const timeSync = parseTimeSyncSettings((obj as { timeSync?: unknown }).timeSync);
      if (timeSync) out.timeSync = timeSync;
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
