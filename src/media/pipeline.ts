/**
 * Per-channel GStreamer pipeline resolution for the KVS WebRTC runtime.
 *
 * Each camera/channel can have its own pipeline (e.g. a different libcamerasrc
 * `camera-name=...` per sensor), so the media collector resolves a pipeline file
 * per stream key rather than using one global `KVS_GST_PIPELINE`. Convention:
 * `<pipelineDir>/<streamKey>.gst` (e.g. cam0.gst, cam1.gst). Managed by
 * `xorgate pipeline set|show|clear|list`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The per-stream pipeline file path (whether or not it exists). */
export function pipelineFileFor(pipelineDir: string, streamKey: string): string {
  return join(pipelineDir, `${streamKey}.gst`);
}

/**
 * Bridged-mode companions to the .gst (offline recording plan D1, Phase 3).
 * `<streamKey>.camera` stores the libcamera camera-name the capture daemon
 * opens; `<streamKey>.gst.direct` is the backup of the direct pipeline taken
 * when `xorgate pipeline bridge` rewrites the .gst to a shmsrc consumer.
 */
export function cameraFileFor(pipelineDir: string, streamKey: string): string {
  return join(pipelineDir, `${streamKey}.camera`);
}

export function directBackupFor(pipelineDir: string, streamKey: string): string {
  return join(pipelineDir, `${streamKey}.gst.direct`);
}

/**
 * Is this stream in bridged mode? Ground truth is the .gst the KVS master will
 * actually load: bridged pipelines read from shmsrc instead of owning a camera.
 */
export function isBridgedPipeline(pipelineDir: string, streamKey: string): boolean {
  try {
    return readFileSync(pipelineFileFor(pipelineDir, streamKey), "utf8").includes("shmsrc");
  } catch {
    return false;
  }
}

/** Pull `camera-name=...` out of a gst-launch string (libcamera names have no spaces). */
export function extractCameraName(gst: string): string | null {
  const m = /camera-name=(\S+)/.exec(gst);
  return m ? m[1].replace(/^"(.*)"$/, "$1") : null;
}

/**
 * The libcamera camera-name the capture daemon should open for a stream:
 * the `.camera` file if present, else parsed out of the direct-pipeline backup,
 * else out of the current .gst (covers a hand-rolled direct setup).
 */
export function resolveCameraName(pipelineDir: string, streamKey: string): string | null {
  try {
    const v = readFileSync(cameraFileFor(pipelineDir, streamKey), "utf8").trim();
    if (v.length > 0) return v;
  } catch {
    /* fall through */
  }
  for (const path of [directBackupFor(pipelineDir, streamKey), pipelineFileFor(pipelineDir, streamKey)]) {
    try {
      const name = extractCameraName(readFileSync(path, "utf8"));
      if (name) return name;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Resolve the pipeline a given channel's master should use:
 *   1. `<pipelineDir>/<streamKey>.gst` if present (per-camera),
 *   2. else the global fallback (the `KVS_GST_PIPELINE` env path), if any,
 *   3. else undefined (the runtime uses its built-in default for the source).
 */
export function resolveChannelPipeline(
  pipelineDir: string,
  streamKey: string,
  globalFallback?: string,
): string | undefined {
  const perChannel = pipelineFileFor(pipelineDir, streamKey);
  if (existsSync(perChannel)) return perChannel;
  return globalFallback;
}
