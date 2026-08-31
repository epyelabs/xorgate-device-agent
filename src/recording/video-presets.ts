/**
 * Video recording presets (plan D7): a named table, not free-form, so CPU cost
 * stays bounded (Pi 5 has NO hardware H.264 encoder — every pixel is software
 * x264) and the cloud can validate `recording.video.preset` against a closed
 * set in Phase 5.
 *
 * Measured on the test Pi (README hardware facts, 2026-07-21):
 *   1080p30 @ 4 Mbps x264 veryfast ≈ 69 % of one core per camera
 *   720p15  @ 1.5 Mbps            ≈ 23 % of one core per camera
 * Dual-camera on the shipped pipeline (ultrafast/zerolatency), static bench
 * scene, 30 s segments (2026-07-25):
 *   720p30 @ 2 Mbps ≈ 38 % of one core per camera — 7.2 MB/segment
 *   720p15 @ 2 Mbps ≈ 24 %                        — 7.1 MB/segment
 *   720p15 @ 1 Mbps ≈ 21 %                        — 3.4 MB/segment
 * i.e. halving fps at the same bitrate buys CPU, not disk; the 1 Mbps rung is
 * the one that halves bytes on disk and the upload backlog. Default stays
 * mid-range (1080p15) so dual-camera record + live stream keeps comfortable
 * headroom on 4 cores.
 * With the Phase 2 hardening (x264enc pinned to threads=2 + child at nice 10,
 * optimize-system-process-cycle plan), dual-camera 720p15 @ 1 Mbps measured
 * ≈ 18.5 % of one core per camera on the test Pi (2026-07-29) — no regression
 * vs the unpinned 21 %, with the worst-case simultaneous thread demand now
 * bounded at 2 encoder threads per camera.
 */

export interface VideoPreset {
  /** Settings value, e.g. "1080p15-2mbps". */
  name: string;
  width: number;
  height: number;
  fps: number;
  /** x264enc `bitrate` property unit (kbit/s). */
  bitrateKbps: number;
}

export const VIDEO_PRESETS: readonly VideoPreset[] = [
  { name: "1080p30-4mbps", width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 },
  { name: "1080p15-2mbps", width: 1920, height: 1080, fps: 15, bitrateKbps: 2000 },
  { name: "720p30-2mbps", width: 1280, height: 720, fps: 30, bitrateKbps: 2000 },
  { name: "720p15-2mbps", width: 1280, height: 720, fps: 15, bitrateKbps: 2000 },
  { name: "720p15-1mbps", width: 1280, height: 720, fps: 15, bitrateKbps: 1000 },
];

/** Default preset name — must exist in VIDEO_PRESETS (see RECORDING_DEFAULTS). */
export const DEFAULT_VIDEO_PRESET = "720p15-1mbps";

export function findVideoPreset(name: string): VideoPreset | undefined {
  return VIDEO_PRESETS.find((p) => p.name === name);
}

/** Resolve a preset name, falling back to the default for unknown values. */
export function resolveVideoPreset(name: string): VideoPreset {
  const p = findVideoPreset(name);
  if (p) return p;
  // Settings are forgiving everywhere else (parse-and-clamp, never reject) —
  // an unknown preset degrades to the default rather than disabling recording.
  return findVideoPreset(DEFAULT_VIDEO_PRESET)!;
}

export function videoPresetNames(): string[] {
  return VIDEO_PRESETS.map((p) => p.name);
}
