/**
 * KVS WebRTC master runtime — the compiled `xorgate-kvs-webrtc` binary.
 *
 * This is the device-agent equivalent of one `run-master.sh` loop body from the
 * `xorgate-synthetic-master` rig: it launches the AWS KVS WebRTC C SDK master for
 * a single signaling channel, authenticating with the device's existing IoT cert
 * via the IoT credential-provider (no static AWS keys). The browser viewer on the
 * device's Streams tab connects as VIEWER to the same channel.
 *
 * Detection self-gates: the prebuilt binary is ARM aarch64, so it only runs on a
 * 64-bit Linux device. Off that (dev macOS, x86), the media collector stays inert
 * exactly like the IMU collector when no sensor is present.
 */
import { existsSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { commandExists, runStream, type StreamHandle } from "../lib/exec.js";

export interface KvsRuntimeDetect {
  available: boolean;
  /** True when `gst-launch-1.0` is on PATH (a proxy for the GStreamer runtime). */
  gstreamer: boolean;
  /** Human-readable reason when `available` is false. */
  reason?: string;
}

/** Per-channel launch environment, mirroring run-master.sh's exported vars. */
export interface KvsRuntimeEnv {
  region: string;
  credentialEndpoint: string;
  roleAlias: string;
  /** IoT thing name == the device id (also the signaling clientId base). */
  thingName: string;
  certPath: string;
  keyPath: string;
  /** CA bundle for TLS to the IoT credential provider + KVS plane (AWS_KVS_CACERT_PATH). */
  caCertPath: string;
  /** Directory holding the user-supplied KVS SDK `.so` libs (LD_LIBRARY_PATH). */
  libDir: string;
  /** Optional KVS_GST_PIPELINE file (custom camera pipeline). */
  pipelinePath?: string;
  /** AWS_KVS_LOG_LEVEL (1 verbose … 7 silent); default 3 = INFO, like run-master.sh. */
  logLevel?: string;
  /**
   * KVS_IDLE_TEARDOWN_SECS — seconds with zero viewers after which the runtime stops its x264
   * encoder pipeline (it restarts transparently on the next viewer offer). `"0"` keeps the
   * pre-Phase-9 behavior, where the encoder runs from the first viewer until the process exits.
   */
  idleTeardownSecs?: string;
}

/**
 * Is the runtime even runnable on this host? Hard gates: 64-bit Linux + the
 * binary present. GStreamer presence is reported but not required (the binary
 * links libgstreamer directly; a missing `gst-launch-1.0` is only a hint).
 */
export async function detectRuntime(binaryPath: string): Promise<KvsRuntimeDetect> {
  if (platform() !== "linux") {
    return { available: false, gstreamer: false, reason: "media runtime needs Linux (aarch64 device)" };
  }
  if (arch() !== "arm64") {
    return {
      available: false,
      gstreamer: false,
      reason: `media runtime binary is aarch64; host arch is ${arch()}`,
    };
  }
  if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
    return { available: false, gstreamer: false, reason: `runtime binary not found at ${binaryPath}` };
  }
  const gstreamer = await commandExists("gst-launch-1.0");
  return { available: true, gstreamer };
}

/**
 * Launch one master for `channelName`, argv `<channel> <mediaType> <source>`
 * (e.g. `<channel> video-only testsrc`). The IoT creds + LD_LIBRARY_PATH go in
 * via the environment. Returns a StreamHandle whose `stop()` sends SIGINT — the
 * runtime's graceful-shutdown signal.
 */
export function streamChannel(
  channelName: string,
  mediaType: string,
  source: string,
  binaryPath: string,
  env: KvsRuntimeEnv,
  handlers: { onStdout?: (line: string) => void; onStderr?: (line: string) => void } = {},
): StreamHandle {
  const ldPath = [env.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  const childEnv: Record<string, string> = {
    AWS_DEFAULT_REGION: env.region,
    AWS_IOT_CORE_CREDENTIAL_ENDPOINT: env.credentialEndpoint,
    AWS_IOT_CORE_CERT: env.certPath,
    AWS_IOT_CORE_PRIVATE_KEY: env.keyPath,
    AWS_IOT_CORE_ROLE_ALIAS: env.roleAlias,
    AWS_IOT_CORE_THING_NAME: env.thingName,
    AWS_KVS_CACERT_PATH: env.caCertPath,
    AWS_KVS_LOG_LEVEL: env.logLevel ?? "3",
    LD_LIBRARY_PATH: ldPath,
  };
  if (env.pipelinePath) childEnv.KVS_GST_PIPELINE = env.pipelinePath;
  if (env.idleTeardownSecs !== undefined) childEnv.KVS_IDLE_TEARDOWN_SECS = env.idleTeardownSecs;

  return runStream(binaryPath, [channelName, mediaType, source], handlers, { env: childEnv });
}
