/**
 * The single pipeline-builder (cm4-support plan, Phase 2): every rendered
 * GStreamer artifact — the bridged KVS `.gst`, the direct `.gst.direct`
 * backup, and the recording pipeline's encode stage — comes from ONE tested
 * template per encoder token. Templates are code, not data, on purpose: the
 * CM4 bring-up showed one missing caps token produces a silently-black
 * stream, so pipeline semantics ship typechecked and vitest-pinned in the
 * agent, and the device model only names a token.
 *
 * - `sw-h264` — x264enc, byte-for-byte today's CM5 pipelines (D4: zero CM5
 *   behavior change is an acceptance gate).
 * - `hw-h264` — v4l2h264enc per README Appendix A, bench-measured on the CM4
 *   (3%/core vs 53%). Two load-bearing details, both cost real debugging
 *   time: a convert element is MANDATORY before v4l2h264enc (without it the
 *   pipeline goes PLAYING and produces zero bytes forever, no error), and
 *   `profile=(string)constrained-baseline` caps are MANDATORY for WebRTC
 *   (without them the encoder emits High profile and the browser renders
 *   black). `repeat_sequence_header=1` puts SPS/PPS on every IDR so
 *   mid-stream viewer joins work. No `name=sampleVideoEncoder` on the HW
 *   encoder: it has no kbps `bitrate` gobject property, so TWCC adaptation
 *   is deliberately skipped (D5 — fixed bitrate for v1; the lookup is
 *   null-guarded in the runtime).
 */
import type { EncoderToken } from "../hardware/hardware-config.js";

/** Fixed low-res bridge caps — MUST match the capture daemon's shmsink caps. */
export const SHM_BRIDGE_CAPS = "video/x-raw,format=I420,width=1280,height=720,framerate=15/1";

/** KVS-side H.264 output caps per encoder (WebRTC-compatible profiles). */
const SW_H264_OUT_CAPS = "video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline";
const HW_H264_OUT_CAPS =
  "video/x-h264,profile=(string)constrained-baseline,level=(string)4," +
  "stream-format=(string)byte-stream,alignment=(string)au";

/** The x264enc stage of today's BRIDGED CM5 pipeline (TWCC-named encoder). */
const SW_ENCODE =
  "x264enc name=sampleVideoEncoder bframes=0 speed-preset=ultrafast bitrate=1000 " +
  "byte-stream=TRUE tune=zerolatency threads=2";

/**
 * The DIRECT variant historically written by the install script — identical
 * but for the missing `name=sampleVideoEncoder` (so TWCC never adapted in
 * direct mode; kept byte-for-byte rather than "fixed", D4).
 */
const SW_ENCODE_DIRECT =
  "x264enc bframes=0 speed-preset=ultrafast bitrate=1000 " +
  "byte-stream=TRUE tune=zerolatency threads=2";

/**
 * The output caps `v4l2h264enc` needs to negotiate at all — NOT a consumer
 * preference (cam-sensor-level-rotate plan, Phase 4).
 *
 * Isolated on a CM4 bench with `videotestsrc`, the same pipeline twice:
 * without these caps it dies with `streaming stopped, reason error (-5)` /
 * `pipeline doesn't want to preroll`; with them it runs clean. The KVS `.gst`
 * carried them from the start, which is why LIVE video always worked on a CM4
 * while recording never did.
 */
const HW_RECORD_OUT_CAPS = "video/x-h264,profile=(string)constrained-baseline,level=(string)4";

/** Appendix A's v4l2h264enc stage (1 Mbps, SPS/PPS on every IDR, IDR every 30 frames). */
const HW_ENCODE =
  "v4l2h264enc extra-controls=controls,video_bitrate=1000000,repeat_sequence_header=1,h264_i_frame_period=30";

const APPSINK = "appsink sync=TRUE emit-signals=TRUE name=appsink-video";

/**
 * Bridged KVS `.gst`: shmsrc consumer the master loads while the capture
 * daemon owns the camera. sw-h264 output is byte-for-byte the pipeline
 * `xorgate pipeline bridge` has always written.
 */
export function buildBridgedKvsPipeline(encoder: EncoderToken, shmSocketPath: string): string {
  const src = `shmsrc socket-path=${shmSocketPath} is-live=true do-timestamp=true`;
  if (encoder === "hw-h264") {
    // videoconvert is ~free here: shm delivers I420 and I420→I420 is
    // passthrough — but the element itself is what makes v4l2h264enc's
    // negotiation actually produce bytes (Appendix A gotcha #1).
    return `${src} ! ${SHM_BRIDGE_CAPS} ! videoconvert ! ${HW_ENCODE} ! ${HW_H264_OUT_CAPS} ! ${APPSINK}`;
  }
  return `${src} ! ${SHM_BRIDGE_CAPS} ! ${SW_ENCODE} ! ${SW_H264_OUT_CAPS} ! ${APPSINK}`;
}

/**
 * Direct `.gst` (the `.gst.direct` backup `xorgate pipeline direct` restores):
 * the KVS master owns the camera itself. sw-h264 matches the install script's
 * historical default byte-for-byte.
 */
export function buildDirectKvsPipeline(
  encoder: EncoderToken,
  streamKey: string,
  cameraName: string,
): string {
  const src = `libcamerasrc name=${streamKey} camera-name=${cameraName}`;
  if (encoder === "hw-h264") {
    return `${src} ! ${SHM_BRIDGE_CAPS} ! videoconvert ! ${HW_ENCODE} ! ${HW_H264_OUT_CAPS} ! ${APPSINK}`;
  }
  return `${src} ! ${SHM_BRIDGE_CAPS} ! ${SW_ENCODE_DIRECT} ! ${SW_H264_OUT_CAPS} ! ${APPSINK}`;
}

/**
 * The recording pipeline's encode stage as gst-launch argv tokens (D6: the
 * recorder follows the model's encoder token too). Slots between the tee'd
 * `queue` and `h264parse` in buildCapturePipelineArgs.
 *
 * sw-h264 is today's exact x264enc argv. hw-h264 mirrors Appendix A's control
 * set with the preset's bitrate/GOP; the convert element is as load-bearing
 * here as on the KVS side, and so — it turns out — are the output caps.
 *
 * This used to end at the encoder, on the reasoning that constrained-baseline
 * is a BROWSER decode constraint and a disk fragment has no such consumer.
 * That reasoning was wrong about the mechanism: on a CM4, `v4l2h264enc`
 * without those caps fails to negotiate at all (`Failed to process frame`,
 * then the shm bridge collapses behind it), so enabling recording took the
 * whole capture process down — live video with it. See HW_RECORD_OUT_CAPS.
 */
export function buildRecordEncodeArgs(
  encoder: EncoderToken,
  bitrateKbps: number,
  keyIntMax: number,
): string[] {
  if (encoder === "hw-h264") {
    return [
      "videoconvert",
      "!",
      "v4l2h264enc",
      `extra-controls=controls,video_bitrate=${bitrateKbps * 1000},repeat_sequence_header=1,h264_i_frame_period=${keyIntMax}`,
      "!",
      HW_RECORD_OUT_CAPS,
    ];
  }
  return [
    "x264enc",
    // ultrafast, not veryfast: measured 65% vs 98% of a core per camera at
    // 1080p15-2mbps (spike) — dual-camera headroom + the PSU brownout margin
    // outweigh the compression-efficiency loss for dashcam footage.
    "speed-preset=ultrafast",
    "tune=zerolatency",
    // Pin the encoder thread pool like the KVS side does (threads=2 there):
    // unpinned, x264 spawns ~1.5x logical cores worth of threads per camera —
    // 6 per encoder on the Pi 5 — and dual-camera boot bursts all of them at
    // once. Two threads comfortably cover every preset in the table at
    // ultrafast and bound the worst-case simultaneous demand.
    "threads=2",
    `bitrate=${bitrateKbps}`,
    `key-int-max=${keyIntMax}`,
  ];
}

/**
 * Does this `.gst` content look like something THIS builder (or its
 * predecessors — the install script and `xorgate pipeline bridge`) rendered?
 * The reconciler only overwrites files it recognizes as renders, so an
 * operator's hand-tuned pipeline is never clobbered by a re-render.
 */
export function isRecognizedBridgedRender(content: string, shmSocketPath: string): boolean {
  const t = content.trim();
  return (
    t === buildBridgedKvsPipeline("sw-h264", shmSocketPath) ||
    t === buildBridgedKvsPipeline("hw-h264", shmSocketPath)
  );
}

export function isRecognizedDirectRender(
  content: string,
  streamKey: string,
  cameraName: string,
): boolean {
  const t = content.trim();
  if (
    t === buildDirectKvsPipeline("sw-h264", streamKey, cameraName) ||
    t === buildDirectKvsPipeline("hw-h264", streamKey, cameraName)
  ) {
    return true;
  }
  // The install script's historical direct pipeline differs from
  // buildDirectKvsPipeline only in element order details across releases —
  // recognize any single-line libcamerasrc→x264enc→appsink render for THIS
  // camera so legacy installs adopt cleanly.
  return (
    !t.includes("\n") &&
    t.startsWith("libcamerasrc") &&
    t.includes(`camera-name=${cameraName}`) &&
    t.includes("x264enc") &&
    t.includes("appsink")
  );
}
