import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunMode } from "./telemetry.js";
import { loadSettings } from "../daemon/settings.js";

/**
 * Agent configuration from env vars, overridable by `--flag value` CLI args.
 * The cert/key/CA defaults match the one-shot bundle from
 * `POST /devices/{id}/provision` (see README): drop the cert, key, and Amazon
 * Root CA1 into ./creds.
 *
 * `--offline` (or OFFLINE=1) runs the whole agent without AWS: no creds are
 * loaded and mqtt.ts swaps in a stub client. This lets the daemon + monitor be
 * exercised end-to-end on a bare checkout (the project is simulator-first).
 */

export interface CredBundle {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

/**
 * KVS WebRTC media-runtime config. `enabled` is simply "not offline" since
 * Phase 4 of the settings-management plan — the operator switch it used to
 * follow is gone, and per-camera enables (`recording.video.cameras`) are the
 * supported way to turn media off. The channels + IoT endpoints come from the
 * on-device manifest (kvs.json), not from here.
 */
export interface MediaConfig {
  enabled: boolean;
  /** Compiled `xorgate-kvs-webrtc` binary (shipped in the agent tarball under media/). */
  binaryPath: string;
  /** Directory holding the user-supplied KVS SDK `.so` libs (LD_LIBRARY_PATH). */
  libDir: string;
  /** kvs.json manifest path (region, IoT cred endpoint, role alias, channels). */
  manifestPath: string;
  /** GStreamer source kind passed as argv[3]: testsrc (default) | devicesrc | rtspsrc. */
  source: string;
  /** Media type argv[2]: video-only (default) | audio-video. */
  mediaType: string;
  /** Directory of per-stream pipeline files (`<streamKey>.gst`); see media/pipeline.ts. */
  pipelineDir: string;
  /** Optional global KVS_GST_PIPELINE file (fallback when no per-stream file exists). */
  pipelinePath?: string;
  /** AWS_KVS_LOG_LEVEL for the runtime (default "3" = INFO). */
  logLevel: string;
  /**
   * KVS_IDLE_TEARDOWN_SECS for the runtime (default "30"): seconds with no viewer after which
   * the master stops its x264 encoder pipeline and returns to bridge-idle CPU, restarting on the
   * next viewer. "0" disables it (pre-Phase-9 behavior: encode forever after the first viewer).
   * Env-only for now — a live stream nobody is watching has no legitimate reason to keep
   * encoding, so this is a safety valve rather than a product setting.
   */
  idleTeardownSecs: string;
  /** The device IoT cert + key the runtime authenticates with (AWS_IOT_CORE_CERT/PRIVATE_KEY). */
  certPath: string;
  keyPath: string;
  /**
   * CA bundle for the runtime's TLS to the IoT credential provider AND the KVS
   * control/signaling plane (AWS_KVS_CACERT_PATH). This is NOT the device's
   * root-ca.pem: that single Amazon root validates MQTT but not the KVS endpoints
   * (which chain to a different root). We ship the SDK's `cert.pem` bundle next to
   * the binary (media/cert.pem) and point here by default.
   */
  caCertPath: string;
}

export interface AgentConfig {
  deviceId: string;
  endpoint: string;
  mode: RunMode;
  rateHz: number;
  intervalMs: number;
  /**
   * MQTT keepalive (seconds). Controls Last-Will latency: the broker fires the
   * LWT ~1.5x keepalive after the device goes silent, which is what distinguishes
   * a true power-off from a brief tunnel. Lower = faster power-off detection,
   * slightly more MQTT overhead. See kvs-webrtc-lts plan §4.2 / §6.
   */
  mqttKeepaliveSec: number;
  offline: boolean;
  telemetryTopic: string;
  statusTopic: string;
  /** Retained cloud->device config messages (e.g. gnssAntBias) arrive here. */
  configTopic: string;
  /**
   * Device->cloud echo of what was actually applied (settings-management plan,
   * Phase 3). Published QoS 1 and NOT retained — Postgres is the durable
   * mirror. Covered by the existing device IoT policy, which grants publish on
   * `xorgate/devices/${thingName}/*`.
   */
  configReportedTopic: string;
  /** Non-retained one-shot cloud->device commands (reboot, power_off) arrive here. */
  commandTopic: string;
  /** Accept/reject/fail acks for commandTopic are published here. */
  commandResponseTopic: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  /** Loaded cert material, or null in offline mode. */
  creds: CredBundle | null;
  /** KVS WebRTC media-runtime config. */
  media: MediaConfig;
}

/** Flags that take no value. Everything else consumes the following token. */
export const BOOLEAN_FLAGS = new Set(["offline"]);

/**
 * Parse `--flag value` and boolean `--flag` out of an argv slice. Boolean flags
 * (BOOLEAN_FLAGS) never consume a value; every other flag consumes the next
 * token as its value — even if that token starts with `--`, so a typo like
 * `--rate --mode sim` surfaces as an invalid value downstream rather than
 * silently falling back to the default.
 */
export function parseArgs(
  argv: string[],
  booleanFlags: Set<string> = BOOLEAN_FLAGS,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function truthy(v: string | boolean | undefined): boolean {
  return v === true || v === "1" || v === "true";
}

/**
 * Build the agent config from a CLI argv slice (subcommand already stripped)
 * plus env vars. Throws with an actionable message if a required field or cred
 * file is missing — callers (e.g. `start`) use this to fail fast before
 * spawning a worker that would only crash-loop.
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): AgentConfig {
  const args = parseArgs(argv);
  const get = (cliKey: string, envKey: string, fallback?: string): string | undefined =>
    (typeof args[cliKey] === "string" ? (args[cliKey] as string) : undefined) ??
    process.env[envKey] ??
    fallback;

  const offline = truthy(args.offline) || truthy(process.env.OFFLINE);
  const settings = loadSettings();

  // Mode precedence: explicit --mode flag > persisted settings.json (operator's
  // UI/`set` choice) > MODE env (provisioning default) > "sim". settings.json
  // intentionally overrides env so the `manage`/`set` toggle takes effect on
  // provisioned devices, while an explicit flag still wins.
  const flagMode = typeof args.mode === "string" ? (args.mode as string) : undefined;
  const mode = (flagMode ?? settings.mode ?? process.env.MODE ?? "sim") as RunMode;
  const rateHz = Number(get("rate", "RATE_HZ", "1"));
  const mqttKeepaliveSec = Number(get("mqtt-keepalive", "MQTT_KEEPALIVE_SEC", "60"));

  // Offline mode needs no real device identity / endpoint; give it placeholders
  // so the simulator + topics still resolve coherently.
  const deviceId = get("device-id", "DEVICE_ID", offline ? "sim-local" : undefined);
  const endpoint = get("endpoint", "IOT_DATA_ENDPOINT", offline ? "offline" : undefined);

  const certPath = resolve(get("cert", "CERT_PATH", "./creds/cert.crt")!);
  const keyPath = resolve(get("key", "KEY_PATH", "./creds/private.key")!);
  const caPath = resolve(get("ca", "CA_PATH", "./creds/ca.pem")!);

  if (!deviceId) throw new Error("DEVICE_ID (or --device-id) is required (or pass --offline)");
  if (!endpoint) throw new Error("IOT_DATA_ENDPOINT (or --endpoint) is required (or pass --offline)");
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error(`RATE_HZ must be a positive number, got ${rateHz}`);
  }
  if (!Number.isFinite(mqttKeepaliveSec) || mqttKeepaliveSec <= 0) {
    throw new Error(`MQTT_KEEPALIVE_SEC must be a positive number, got ${mqttKeepaliveSec}`);
  }
  if (mode !== "sim" && mode !== "real") {
    throw new Error(`MODE must be "sim" or "real", got "${mode}"`);
  }

  let creds: CredBundle | null = null;
  if (!offline) {
    try {
      creds = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        ca: readFileSync(caPath),
      };
    } catch (err) {
      throw new Error(
        `failed to read creds (${(err as Error).message}). ` +
          `Provision the device into ./creds, or run with --offline.`,
      );
    }
  }

  // Media runtime: on for any provisioned device, off when offline (the KVS
  // runtime needs real AWS). There is no operator switch any more — the
  // `mediaEnabled` setting, its `--media` flag and its MEDIA_ENABLED env were
  // removed in Phase 4 of the settings-management plan (Q4): they were
  // redundant with the per-camera enables in `recording.video.cameras`, which
  // are cloud-managed and per-device precise. Like the collectors, the runtime
  // then self-gates on arch/binary/manifest, so "on" is safe on a host that
  // cannot actually start it, and KVS idle teardown makes a viewer-less stream
  // ~free.
  const mediaEnabled = !offline;
  const mediaBin = resolve(
    get("media-bin", "KVS_RUNTIME_BIN", "/opt/xorgate/media/xorgate-kvs-webrtc")!,
  );
  const media: MediaConfig = {
    enabled: mediaEnabled,
    binaryPath: mediaBin,
    libDir: resolve(get("media-lib", "KVS_RUNTIME_LIB_DIR", "/opt/xorgate/media/lib")!),
    manifestPath: resolve(get("media-manifest", "KVS_MANIFEST", "./creds/kvs.json")!),
    source: get("media-source", "MEDIA_SOURCE", "testsrc")!,
    mediaType: get("media-type", "MEDIA_TYPE", "video-only")!,
    pipelineDir: resolve(get("media-pipeline-dir", "KVS_PIPELINE_DIR", "/etc/xorgate/pipelines")!),
    pipelinePath: process.env.KVS_GST_PIPELINE
      ? resolve(process.env.KVS_GST_PIPELINE)
      : undefined,
    logLevel: get("media-log", "AWS_KVS_LOG_LEVEL", "3")!,
    idleTeardownSecs: get("media-idle-teardown", "KVS_IDLE_TEARDOWN_SECS", "30")!,
    certPath,
    keyPath,
    // KVS CA bundle ships next to the binary (media/cert.pem); override with KVS_CACERT_PATH.
    caCertPath: resolve(get("media-cacert", "KVS_CACERT_PATH", join(dirname(mediaBin), "cert.pem"))!),
  };

  return {
    deviceId,
    endpoint,
    mode,
    rateHz,
    intervalMs: Math.round(1000 / rateHz),
    mqttKeepaliveSec,
    offline,
    telemetryTopic: `xorgate/devices/${deviceId}/telemetry`,
    statusTopic: `xorgate/devices/${deviceId}/status`,
    configTopic: `xorgate/devices/${deviceId}/config`,
    configReportedTopic: `xorgate/devices/${deviceId}/config/reported`,
    commandTopic: `xorgate/devices/${deviceId}/command`,
    commandResponseTopic: `xorgate/devices/${deviceId}/command/response`,
    certPath,
    keyPath,
    caPath,
    creds,
    media,
  };
}
