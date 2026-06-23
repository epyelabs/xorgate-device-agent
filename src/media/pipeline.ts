/**
 * Per-channel GStreamer pipeline resolution for the KVS WebRTC runtime.
 *
 * Each camera/channel can have its own pipeline (e.g. a different libcamerasrc
 * `camera-name=...` per sensor), so the media collector resolves a pipeline file
 * per stream key rather than using one global `KVS_GST_PIPELINE`. Convention:
 * `<pipelineDir>/<streamKey>.gst` (e.g. cam0.gst, cam1.gst). Managed by
 * `xorgate pipeline set|show|clear|list`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The per-stream pipeline file path (whether or not it exists). */
export function pipelineFileFor(pipelineDir: string, streamKey: string): string {
  return join(pipelineDir, `${streamKey}.gst`);
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
