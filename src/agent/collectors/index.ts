import type { TelemetryReading } from "../telemetry.js";
import type { MediaConfig } from "../config.js";
import { createImuCollector } from "./imu.js";
import { createGpsCollector } from "./gps.js";
import { createLteCollector } from "./lte.js";
import { createSystemCollector } from "./system.js";
import { createMediaCollector, type MediaSupervisor } from "./media.js";

/** A capability-driven metric source for one telemetry group (P5 skeleton). */
export interface Collector {
  group: string;
  read(): Promise<Record<string, unknown>>;
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
    stop(): void {
      media?.stop();
    },
  };
}
