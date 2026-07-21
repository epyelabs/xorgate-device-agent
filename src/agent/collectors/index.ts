import type { TelemetryReading } from "../telemetry.js";
import type { MediaConfig } from "../config.js";
import { createImuCollector } from "./imu.js";
import { createGpsCollector } from "./gps.js";
import { createLteCollector } from "./lte.js";
import { createSystemCollector } from "./system.js";
import { createMediaCollector, type MediaSupervisor } from "./media.js";

/** One group's cached reading + when the underlying data last changed. */
export interface GroupSample {
  fields: Record<string, unknown>;
  /** process.hrtime.bigint() at the last real data change — the recorder's freshness key. */
  updatedMono: bigint;
}

/** A capability-driven metric source for one telemetry group (P5 skeleton). */
export interface Collector {
  group: string;
  read(): Promise<Record<string, unknown>>;
  /**
   * Additive cache view for the telemetry recorder (offline recording plan,
   * Phase 1): the latest fields plus a monotonic changed-at stamp, WITHOUT
   * disturbing read()'s per-tick state (e.g. the system collector's CPU delta).
   * null when the group is inert/stale (same condition as read() → {}).
   * Collectors without it are simply not recorded.
   */
  sample?(): Promise<GroupSample | null>;
}

/** Minimal shape of a device model's declared I/O capabilities. */
export interface IoCapabilities {
  sensors?: { imu?: boolean };
  comm?: { gps?: boolean; signal?: boolean };
  system?: boolean;
}

/**
 * Capability-driven collector registry (P5 skeleton).
 *
 * Given a device model's `io_capabilities`, instantiate only the collectors the
 * hardware declares, then merge their per-group reads into a `metrics` map
 * shaped exactly like the simulator output. In `MODE=real` the agent calls
 * `collector.read()` each tick instead of the simulator.
 *
 * For now this is wired but inert (every collector returns {}); the real serial
 * / /proc / I2C reads land in P5 (device firmware).
 */
export function createCollector(
  ioCapabilities: IoCapabilities = {},
  mediaConfig?: MediaConfig,
): {
  read(): Promise<TelemetryReading>;
  /** Recorder view: latest per-group samples with freshness stamps (see GroupSample). */
  sampleGroups(): Promise<Record<string, GroupSample>>;
  /** Stop any supervised subprocesses (the media runtime). No-op otherwise. */
  stop(): void;
} {
  const collectors: Collector[] = [];
  if (ioCapabilities.sensors?.imu) collectors.push(createImuCollector());
  if (ioCapabilities.comm?.gps) collectors.push(createGpsCollector());
  if (ioCapabilities.comm?.signal) collectors.push(createLteCollector());
  if (ioCapabilities.system) collectors.push(createSystemCollector());

  // The media collector supervises the KVS WebRTC runtime; it produces the
  // `media` field (and self-gates when off/unavailable). When disabled, media
  // stays inert/idle just like the old hardcoded value.
  const media: MediaSupervisor | null =
    mediaConfig?.enabled ? createMediaCollector(mediaConfig) : null;

  return {
    async read(): Promise<TelemetryReading> {
      const metrics: Record<string, unknown> = {};
      for (const c of collectors) {
        const fields = await c.read();
        if (fields && Object.keys(fields).length > 0) metrics[c.group] = fields;
      }
      return {
        metrics: metrics as TelemetryReading["metrics"],
        media: media
          ? media.read()
          : { kvs: { value: false }, recording: { value: false }, streams: [] },
      };
    },
    async sampleGroups(): Promise<Record<string, GroupSample>> {
      const out: Record<string, GroupSample> = {};
      for (const c of collectors) {
        if (!c.sample) continue;
        try {
          const s = await c.sample();
          if (s && Object.keys(s.fields).length > 0) out[c.group] = s;
        } catch {
          /* a collector hiccup must not kill the recorder tick */
        }
      }
      return out;
    },
    stop(): void {
      media?.stop();
    },
  };
}
