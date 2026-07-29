/**
 * Fully-resolved recording config: RecordingSettings (all-optional, persisted)
 * merged over the plan's defaults. The worker's recording manager resolves on
 * every settings re-read, so "no `recording` key at all" and "explicitly all
 * defaults" behave identically (recording off, standard retention).
 */
import { join } from "node:path";
import type { RecordingSettings } from "../daemon/settings.js";
import { runtimeHome } from "../daemon/runtime.js";

export interface ResolvedRecordingConfig {
  telemetry: { enabled: boolean; rateHz: number };
  video: {
    enabled: boolean;
    preset: string;
    segmentSeconds: number;
    /** Boot power staging knobs (Phase 2) — see RecordingSettings.video. */
    bootDefer: "auto" | "always" | "off";
    bootDeferMaxSecs: number;
    bootDeferMinBudgetMa: number;
    spawnStaggerSecs: number;
  };
  upload: { mode: "auto" | "off" };
  retention: { maxBytes: number; minFreeBytes: number };
}

export const RECORDING_DEFAULTS: ResolvedRecordingConfig = {
  telemetry: { enabled: false, rateHz: 10 },
  video: {
    enabled: false,
    preset: "1080p15-2mbps",
    segmentSeconds: 60,
    bootDefer: "auto",
    bootDeferMaxSecs: 90,
    bootDeferMinBudgetMa: 5000,
    spawnStaggerSecs: 4,
  },
  upload: { mode: "auto" },
  retention: { maxBytes: 10 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3 },
};

export function resolveRecordingConfig(s?: RecordingSettings): ResolvedRecordingConfig {
  const d = RECORDING_DEFAULTS;
  return {
    telemetry: {
      enabled: s?.telemetry?.enabled ?? d.telemetry.enabled,
      rateHz: s?.telemetry?.rateHz ?? d.telemetry.rateHz,
    },
    video: {
      enabled: s?.video?.enabled ?? d.video.enabled,
      preset: s?.video?.preset ?? d.video.preset,
      segmentSeconds: s?.video?.segmentSeconds ?? d.video.segmentSeconds,
      bootDefer: s?.video?.bootDefer ?? d.video.bootDefer,
      bootDeferMaxSecs: s?.video?.bootDeferMaxSecs ?? d.video.bootDeferMaxSecs,
      bootDeferMinBudgetMa: s?.video?.bootDeferMinBudgetMa ?? d.video.bootDeferMinBudgetMa,
      spawnStaggerSecs: s?.video?.spawnStaggerSecs ?? d.video.spawnStaggerSecs,
    },
    upload: { mode: s?.upload?.mode ?? d.upload.mode },
    retention: {
      maxBytes: s?.retention?.maxBytes ?? d.retention.maxBytes,
      minFreeBytes: s?.retention?.minFreeBytes ?? d.retention.minFreeBytes,
    },
  };
}

/** Root of the on-device recording tree: XORGATE_HOME/recordings. */
export function recordingsRoot(): string {
  return join(runtimeHome(), "recordings");
}

/** Telemetry segment tree: recordings/telemetry/<sessionId>/seg-*.jsonl[.gz]. */
export function telemetryRoot(root: string = recordingsRoot()): string {
  return join(root, "telemetry");
}

/** Video segment tree: recordings/video/<streamKey>/<sessionId>/%05d.mp4 + .json. */
export function videoRoot(root: string = recordingsRoot()): string {
  return join(root, "video");
}

/**
 * Where capture daemons put their shm bridge sockets (Phase 3, D1). Outside the
 * recordings tree on purpose: the disk manager must never scan/evict sockets.
 * Both the capture pipeline and the bridged .gst embed this path, and the CLI
 * (`xorgate pipeline bridge`) + agent resolve it the same way via XORGATE_HOME.
 */
export function shmDir(): string {
  return join(runtimeHome(), "shm");
}

export function shmSocketPathFor(streamKey: string): string {
  return join(shmDir(), `${streamKey}.sock`);
}
