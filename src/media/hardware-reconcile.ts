/**
 * Hardware reconciler (cm4-support plan, Phase 2): make the on-disk pipeline
 * artifacts match what the hardware block declares and the hardware actually
 * has.
 *
 * At startup (and again whenever the cloud delivers a changed block) the
 * worker calls reconcile(): enumerate cameras, pair them to the block's
 * `video` entries by CONNECTOR (the block never stores libcamera paths — the
 * enumeration is the source of truth for those), and write/refresh the
 * pipeline trio per matched camera from the encoder token's tested templates:
 *
 *   <key>.gst         bridged shmsrc consumer the KVS master loads
 *   <key>.camera      enumerated libcamera identity the capture daemon opens
 *   <key>.gst.direct  direct pipeline `xorgate pipeline direct` restores
 *
 * Overwrite policy: a file is only ever replaced when it is ABSENT or when
 * its content is RECOGNIZED as a render of the known templates (this
 * builder's, the install script's, or `xorgate pipeline bridge`'s). An
 * operator's hand-tuned pipeline is respected and reported, never clobbered.
 *
 * The returned per-stream statuses feed the media collector's spawn guard:
 * a stream whose camera is missing (`no-camera`) must not get a master at
 * all — the silent fallback to the runtime's default test pipeline is the
 * fleet hazard this plan kills (inventory #5).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  cameraFileFor,
  directBackupFor,
  pipelineFileFor,
} from "./pipeline.js";
import {
  buildBridgedKvsPipeline,
  buildDirectKvsPipeline,
  isRecognizedBridgedRender,
  isRecognizedDirectRender,
} from "./pipeline-builder.js";
import { enumerateCameras, type CameraListExec, type EnumeratedCamera } from "../hardware/cameras.js";
import type { DeviceHardwareBlock } from "../hardware/hardware-config.js";

/** Per-stream verdict after a reconcile pass. */
export type StreamHardwareStatus =
  /** Trio rendered/refreshed this pass (content changed on disk). */
  | "rendered"
  /** Camera present and artifacts already current — nothing written. */
  | "ok"
  /** Pipeline exists but is operator-customized — left alone. */
  | "custom"
  /** The model expects a camera on this connector and none enumerated. */
  | "no-camera";

export interface ReconcileResult {
  /** Verdict per stream key from the hardware block's video list. */
  statuses: Map<string, StreamHardwareStatus>;
  /** Streams whose .gst CONTENT changed — their KVS masters must be bounced. */
  changedStreams: string[];
  /** What enumeration saw (null = could not enumerate). */
  cameras: EnumeratedCamera[] | null;
}

export interface ReconcileOptions {
  pipelineDir: string;
  shmSocketPathFor: (streamKey: string) => string;
  log?: (level: "info" | "warn", msg: string) => void;
  /** Test seam for the rpicam-hello exec. */
  listExec?: CameraListExec;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function reconcileHardware(
  block: DeviceHardwareBlock,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const log = opts.log ?? ((level, msg) => console[level === "warn" ? "warn" : "log"](`[hardware] ${msg}`));
  const statuses = new Map<string, StreamHardwareStatus>();
  const changedStreams: string[] = [];

  const cameras = await enumerateCameras(block.platform, opts.listExec);
  if (cameras === null) {
    log(
      "warn",
      "camera enumeration unavailable (rpicam-hello missing or libcamera broken) — leaving pipelines untouched",
    );
    return { statuses, changedStreams, cameras };
  }

  const byConnector = new Map<string, EnumeratedCamera>();
  for (const cam of cameras) {
    if (cam.connector !== null && !byConnector.has(cam.connector)) {
      byConnector.set(cam.connector, cam);
    }
  }
  const unmapped = cameras.filter((c) => c.connector === null);
  if (unmapped.length > 0) {
    log(
      "warn",
      `enumerated camera(s) on unrecognized path(s): ${unmapped.map((c) => c.cameraName).join(", ")}`,
    );
  }

  mkdirSync(opts.pipelineDir, { recursive: true });

  for (const video of block.video) {
    const cam = byConnector.get(video.connector);
    if (!cam) {
      statuses.set(video.key, "no-camera");
      log(
        "warn",
        `${video.key}: no camera enumerated on ${video.connector} (expected ${video.sensor}) — ` +
          "stream held down until one appears (check the ribbon + overlays, reboot after install)",
      );
      continue;
    }
    if (cam.sensor !== video.sensor) {
      // The model says what SHOULD be there; the bus says what IS. Use the
      // real sensor (the pipelines reference the enumerated identity), but say
      // so — a mismatched sensor usually means a mis-seeded model row.
      log(
        "warn",
        `${video.key}: model expects ${video.sensor} on ${video.connector}, enumerated ${cam.sensor} — using it anyway`,
      );
    }

    const sock = opts.shmSocketPathFor(video.key);
    const gstPath = pipelineFileFor(opts.pipelineDir, video.key);
    const camPath = cameraFileFor(opts.pipelineDir, video.key);
    const directPath = directBackupFor(opts.pipelineDir, video.key);

    const desiredGst = `${buildBridgedKvsPipeline(block.encoder, sock)}\n`;
    const desiredCam = `${cam.cameraName}\n`;
    const desiredDirect = `${buildDirectKvsPipeline(block.encoder, video.key, cam.cameraName)}\n`;

    let wrote = false;
    let custom = false;

    const currentGst = readIfExists(gstPath);
    if (currentGst === null || isRecognizedBridgedRender(currentGst, sock)) {
      if (currentGst?.trim() !== desiredGst.trim()) {
        writeFileSync(gstPath, desiredGst);
        changedStreams.push(video.key);
        wrote = true;
      }
    } else {
      custom = true;
      log(
        "info",
        `${video.key}: .gst is not a recognized render (operator-customized?) — leaving it alone`,
      );
    }

    // .camera is a cache of THIS boot's enumeration — always ground-truthed.
    if (readIfExists(camPath)?.trim() !== desiredCam.trim()) {
      writeFileSync(camPath, desiredCam);
      wrote = true;
    }

    const currentDirect = readIfExists(directPath);
    if (
      currentDirect === null ||
      isRecognizedDirectRender(currentDirect, video.key, cam.cameraName)
    ) {
      if (currentDirect?.trim() !== desiredDirect.trim()) {
        writeFileSync(directPath, desiredDirect);
        wrote = true;
      }
    }

    statuses.set(video.key, custom ? "custom" : wrote ? "rendered" : "ok");
    if (wrote && !custom) {
      log("info", `${video.key}: pipelines rendered (${block.encoder}, ${cam.cameraName})`);
    }
  }

  return { statuses, changedStreams, cameras };
}
