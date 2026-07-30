/**
 * Fully-resolved recording config: RecordingSettings (all-optional, persisted)
 * merged over the plan's defaults. The worker's recording manager resolves on
 * every settings re-read, so "no `recording` key at all" and "explicitly all
 * defaults" behave identically (recording off, standard retention).
 */
import { join } from "node:path";
import type { RecordingSettings } from "../daemon/settings.js";
import { runtimeHome } from "../daemon/runtime.js";
import type { ShedConfig } from "./boot-policy.js";

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
    /**
     * GPS/LTE video gate (Phase 7) — stage 2 of the boot policy. Armed like
     * bootDefer (`auto` is budget-gated on bootDeferMinBudgetMa).
     */
    gpsGate: "auto" | "always" | "off";
    /** Gate give-up cap, seconds; 0 = no time cap (Q8). */
    gpsGateMaxSecs: number;
    spawnStaggerSecs: number;
    /**
     * Per-camera enable (Phase 6), keyed by streamKey. ABSENT KEY = ENABLED,
     * so `{}` (the default) means "every detected camera", and a camera added
     * to the manifest later is on without a config change. Only an explicit
     * `false` turns a camera off — and then it gets no pipeline at all.
     */
    cameras: Record<string, boolean>;
  };
  upload: { mode: "auto" | "off" };
  retention: { maxBytes: number; minFreeBytes: number };
  /** Runtime undervoltage load shedding (Phase 3) — see RecordingSettings.powerShedding. */
  powerShedding: ShedConfig;
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
    gpsGate: "auto",
    gpsGateMaxSecs: 600,
    spawnStaggerSecs: 4,
    cameras: {},
  },
  upload: { mode: "auto" },
  retention: { maxBytes: 10 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3 },
  // Q4 STARTING values (2026-07-28) — tune from the field via settings, not code.
  powerShedding: {
    enabled: true,
    uvSamples: 3,
    uvWindowSecs: 30,
    railLowVolts: 4.85,
    railLowSecs: 15,
    escalateDwellSecs: 60,
    escalateDutyPct: 70,
    restoreSecs: 120,
    railRestoreVolts: 4.95,
    maxShedsPerHour: 4,
  },
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
      gpsGate: s?.video?.gpsGate ?? d.video.gpsGate,
      gpsGateMaxSecs: s?.video?.gpsGateMaxSecs ?? d.video.gpsGateMaxSecs,
      spawnStaggerSecs: s?.video?.spawnStaggerSecs ?? d.video.spawnStaggerSecs,
      cameras: s?.video?.cameras ?? d.video.cameras,
    },
    upload: { mode: s?.upload?.mode ?? d.upload.mode },
    retention: {
      maxBytes: s?.retention?.maxBytes ?? d.retention.maxBytes,
      minFreeBytes: s?.retention?.minFreeBytes ?? d.retention.minFreeBytes,
    },
    powerShedding: {
      enabled: s?.powerShedding?.enabled ?? d.powerShedding.enabled,
      uvSamples: s?.powerShedding?.uvSamples ?? d.powerShedding.uvSamples,
      uvWindowSecs: s?.powerShedding?.uvWindowSecs ?? d.powerShedding.uvWindowSecs,
      railLowVolts: s?.powerShedding?.railLowVolts ?? d.powerShedding.railLowVolts,
      railLowSecs: s?.powerShedding?.railLowSecs ?? d.powerShedding.railLowSecs,
      escalateDwellSecs: s?.powerShedding?.escalateDwellSecs ?? d.powerShedding.escalateDwellSecs,
      escalateDutyPct: s?.powerShedding?.escalateDutyPct ?? d.powerShedding.escalateDutyPct,
      restoreSecs: s?.powerShedding?.restoreSecs ?? d.powerShedding.restoreSecs,
      railRestoreVolts: s?.powerShedding?.railRestoreVolts ?? d.powerShedding.railRestoreVolts,
      maxShedsPerHour: s?.powerShedding?.maxShedsPerHour ?? d.powerShedding.maxShedsPerHour,
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
