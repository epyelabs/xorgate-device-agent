import type { TelemetryReading } from "../telemetry.js";
import type { MediaConfig } from "../config.js";
import type { PowerSampleReading } from "../../recording/boot-policy.js";
import { createImuCollector } from "./imu.js";
import { createGpsCollector, type GpsClockReading } from "./gps.js";
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
  /** Bounce one KVS master (bridged capture respawned — see MediaSupervisor). */
  restartMediaChannel(streamKey: string): void;
  /** Park/release the live KVS masters (load shedding rung 1 — see MediaSupervisor). */
  setLiveShed(shed: boolean): void;
  /** Hold down the masters of cameras disabled in settings (Phase 6 per-camera capacity). */
  setDisabledStreams(streamKeys: readonly string[]): void;
  /**
   * Power reading for the shed policy, from the system collector's 1 Hz sample
   * cache (shared with the telemetry recorder — no extra vcgencmd poller).
   * null when the system group is off or vcgencmd is unavailable (dev box).
   */
  samplePower(): Promise<PowerSampleReading | null>;
  /**
   * Latest fresh GPS UTC time for the offline clock stepper (Phase 4), from
   * the gps collector's NMEA stream (which it keeps open). null when the gps
   * capability is off or no fresh RMC time exists.
   */
  gpsClock(): GpsClockReading | null;
} {
  const collectors: Collector[] = [];
  const system = ioCapabilities.system ? createSystemCollector() : null;
  const gps = ioCapabilities.comm?.gps ? createGpsCollector() : null;
  if (ioCapabilities.sensors?.imu) collectors.push(createImuCollector());
  if (gps) collectors.push(gps);
  if (ioCapabilities.comm?.signal) collectors.push(createLteCollector());
  if (system) collectors.push(system);

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
    restartMediaChannel(streamKey: string): void {
      media?.restartChannel(streamKey);
    },
    setLiveShed(shed: boolean): void {
      media?.setShed(shed);
    },
    setDisabledStreams(streamKeys: readonly string[]): void {
      media?.setDisabledStreams(streamKeys);
    },
    async samplePower(): Promise<PowerSampleReading | null> {
      if (!system?.sample) return null;
      try {
        const s = await system.sample();
        const throttled = (s?.fields.throttled as { value?: unknown } | undefined)?.value;
        if (typeof throttled !== "number") return null; // no vcgencmd → feature inert
        const rail = (s?.fields.rail_5v as { value?: unknown } | undefined)?.value;
        return { uv: (throttled & 0x1) !== 0, railV: typeof rail === "number" ? rail : null };
      } catch {
        return null;
      }
    },
    gpsClock(): GpsClockReading | null {
      return gps?.clock() ?? null;
    },
  };
}
