import type { TelemetryReading } from "../telemetry.js";
import type { MediaConfig } from "../config.js";
import type { PowerSampleReading } from "../../recording/boot-policy.js";
import { createImuCollector } from "./imu.js";
import { createGpsCollector, type GpsClockReading } from "./gps.js";
import type { GnssView } from "../../lib/sky-state.js";
import { createLteCollector } from "./lte.js";
import { createSystemCollector } from "./system.js";
import { createMediaCollector, type MediaSupervisor } from "./media.js";
import {
  createObdCollector,
  type ObdCollector,
  type ObdEffectiveReport,
  type ObdEventLevel,
  type ObdScanResult,
} from "./obd.js";
import type { HardwarePeripherals } from "../../hardware/hardware-config.js";
import type { ObdStatus } from "../telemetry.js";

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

/**
 * Decode one `system` group sample into a load-shed power reading (pure,
 * exported for tests).
 *
 * Returns a reading when EITHER the throttle mask OR the SoC temperature is
 * readable (power_management_improvements Phase 1). Before the thermal arm this
 * bailed unless `throttled` was a number, which would have made thermal
 * shedding inert on any host without `vcgencmd`; now the absent half simply
 * stays at `uv: false` / `railV: null` / `tempC: null`, so the arms that depend
 * on it remain inert exactly as before. With neither half readable (a dev box)
 * the answer is still null and the whole feature stays off.
 */
export function powerReadingFromFields(
  fields: Record<string, unknown> | undefined,
): PowerSampleReading | null {
  const throttled = (fields?.throttled as { value?: unknown } | undefined)?.value;
  const temp = (fields?.cpu_temp as { value?: unknown } | undefined)?.value;
  const hasThrottle = typeof throttled === "number";
  const hasTemp = typeof temp === "number";
  if (!hasThrottle && !hasTemp) return null;
  const rail = (fields?.rail_5v as { value?: unknown } | undefined)?.value;
  return {
    uv: hasThrottle && (throttled & 0x1) !== 0,
    railV: typeof rail === "number" ? rail : null,
    tempC: hasTemp ? temp : null,
    // 0x8 = soft temperature limit — the firmware's own thermal verdict. 0x2
    // (freq capped) and 0x4 (throttled) are consequences of EITHER cause and
    // are deliberately not read: a shed triggered on them could not tell an
    // operator whether to fix the supply or the cooling (PROGRESS Q3).
    softTemp: hasThrottle && (throttled & 0x8) !== 0,
  };
}

/** Minimal shape of a device model's declared I/O capabilities. */
export interface IoCapabilities {
  sensors?: { imu?: boolean };
  comm?: { gps?: boolean; signal?: boolean };
  /** `{ rails: false }` (cm4-support) gates the PMIC 5V-rail/PSU reads off. */
  system?: boolean | { rails?: boolean };
}

/**
 * Hardware-block facts the registry gates PERIPHERAL collectors on (obd2 P1).
 * Separate from `IoCapabilities` because these come from the device hardware
 * block (`/etc/xorgate/hardware.json`), not the model's io_capabilities, and
 * because absence must mean "exactly today's collector list".
 */
export interface CollectorHardware {
  peripherals?: HardwarePeripherals;
  /** Activity-event sink for supervised peripherals (the worker's store.event). */
  onEvent?: (level: ObdEventLevel, msg: string) => void;
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
  hardware: CollectorHardware = {},
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
  /**
   * GNSS view for the Phase 7 video gate: does the receiver have a fix, and
   * what does the sky look like (see lib/sky-state.ts)? null when the gps
   * capability is off — the gate then stays disarmed rather than holding video
   * on a device that can never satisfy it.
   */
  gnssView(): GnssView | null;
  /** OBD collector health (obd2 P1); null when the hardware block declares no `peripherals.obd`. */
  obdStatus(): ObdStatus | null;
  /** The config report's `effective.obd`; null without the peripheral. */
  obdReport(): ObdEffectiveReport | null;
  /** Re-read the `obd` settings namespace now (after a cloud config message, P3). */
  obdReapply(): void;
  /** `obd_scan` (P3): Bluetooth discovery; null without the peripheral. */
  obdScan(): Promise<ObdScanResult> | null;
  /** `obd_forget` (P3): stop + unbond; null without the peripheral. */
  obdForget(): Promise<{ mac: string | null }> | null;
} {
  const collectors: Collector[] = [];
  const system = ioCapabilities.system
    ? createSystemCollector(
        typeof ioCapabilities.system === "object" ? ioCapabilities.system : {},
      )
    : null;
  const gps = ioCapabilities.comm?.gps ? createGpsCollector() : null;
  if (ioCapabilities.sensors?.imu) collectors.push(createImuCollector());
  if (gps) collectors.push(gps);
  if (ioCapabilities.comm?.signal) collectors.push(createLteCollector());
  if (system) collectors.push(system);
  // RUST-PORT: collector-creation seam (obd2 P1). Gated ONLY on the hardware
  // block's `peripherals.obd`; with it absent the collector list — and so the
  // telemetry payload — is byte-for-byte what it was before (test asserts it).
  const obd: ObdCollector | null = hardware.peripherals?.obd
    ? createObdCollector({ onEvent: hardware.onEvent })
    : null;
  if (obd) collectors.push(obd);

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
      obd?.stop();
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
        return powerReadingFromFields((await system.sample())?.fields);
      } catch {
        return null;
      }
    },
    gpsClock(): GpsClockReading | null {
      return gps?.clock() ?? null;
    },
    gnssView(): GnssView | null {
      if (!gps) return null;
      return { fix: gps.hasFix(), sky: gps.sky().state };
    },
    obdStatus(): ObdStatus | null {
      return obd?.status() ?? null;
    },
    obdReport(): ObdEffectiveReport | null {
      return obd?.report() ?? null;
    },
    obdReapply(): void {
      obd?.reapply();
    },
    obdScan(): Promise<ObdScanResult> | null {
      return obd ? obd.scan() : null;
    },
    obdForget(): Promise<{ mac: string | null }> | null {
      return obd ? obd.forget() : null;
    },
  };
}
