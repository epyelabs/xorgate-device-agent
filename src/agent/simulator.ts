/**
 * Synthetic telemetry generator. Produces schema-valid payloads matching the
 * seeded `XG-RPI-REF-1` capability set (imu/gps/lte/system + media flags) so the
 * whole ingestion → storage → live-view pipeline is testable without hardware.
 *
 * Each metric is a gentle bounded random walk, so live charts look realistic and
 * the GPS marker drifts smoothly. Values are clamped to plausible ranges.
 */
import type { TelemetryReading } from "./telemetry.js";
import { quatToEuler } from "../lib/orientation.js";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Scale a quaternion to unit length so euler conversion stays well-defined. */
function normalizeQuat(q: { r: number; i: number; j: number; k: number }): {
  r: number;
  i: number;
  j: number;
  k: number;
} {
  const n = Math.hypot(q.r, q.i, q.j, q.k) || 1;
  return { r: q.r / n, i: q.i / n, j: q.j / n, k: q.k / n };
}

// A bounded random-walk channel: holds its own value across ticks.
function channel(initial: number, step: number, min: number, max: number): () => number {
  let value = initial;
  return () => {
    value = clamp(value + (Math.random() * 2 - 1) * step, min, max);
    return value;
  };
}

export interface SimulatorOptions {
  /**
   * Emit a plausible `obd` group (obd2 P1): the device's hardware block
   * declares `peripherals.obd`, so a sim run of that model should look like
   * the real thing — idle rpm, a slowly draining tank, an odometer that
   * follows the simulated speed, ECU answering (link 2).
   */
  obd?: boolean;
}

export function createSimulator(opts: SimulatorOptions = {}): () => TelemetryReading {
  // IMU: a slowly rotating orientation quaternion (mirrors the BNO085 rotation
  // vector) plus small linear-accel jitter around zero — the BNO085 reports
  // gravity-removed acceleration, so z hovers near 0 rather than ~9.81.
  let imuT = 0;
  const accelX = channel(0, 0.05, -0.6, 0.6);
  const accelY = channel(0, 0.05, -0.6, 0.6);
  const accelZ = channel(0, 0.05, -0.6, 0.6);

  // GPS: drift around a seed coordinate (San Francisco) as if slowly moving.
  let lat = 37.7749;
  let lon = -122.4194;
  // Heading (deg true) drives the drift direction so the track and the course
  // arrow stay coherent; it wanders slowly and wraps 0-360.
  let heading = 45;
  const alt = channel(20, 0.5, 0, 120);
  const speed = channel(0, 1.5, 0, 25); // km/h
  const satellites = channel(9, 0.6, 4, 14); // count used in the fix
  const satellitesInView = channel(16, 0.8, 8, 28); // GSV: visible across constellations
  const hdop = channel(1.1, 0.1, 0.6, 3.5); // GSA: fix confidence

  // LTE signal.
  const rssi = channel(-67, 1.5, -110, -50); // dBm
  const quality = channel(18, 0.8, 0, 31); // asu

  // System.
  const cpuUsage = channel(31, 3, 1, 100); // %
  const cpuTemp = channel(54, 0.6, 35, 85); // °C
  const ramUsage = channel(47, 1.5, 10, 95); // %
  const diskUsage = channel(38, 0.3, 5, 95); // %

  // OBD (opt-in): a warm idling engine. Odometer integrates the GPS sim speed
  // over wall time so a 10 Hz recorder and a 1 Hz publisher agree on distance.
  const rpmJitter = channel(0, 8, -40, 40);
  const engineLoad = channel(22, 1.5, 10, 45); // % at idle
  const throttle = channel(11, 0.6, 8, 18); // %
  const moduleVoltage = channel(14.1, 0.03, 13.6, 14.5); // V, alternator running
  let coolant = 42; // °C, warms toward 90
  let fuel = 61.2; // %, drains slowly
  let odometer = 48213.4; // km
  let runTime = 0; // s
  let obdLastMs = Date.now();

  return function next(): TelemetryReading {
    const spd = speed();
    // Wander the heading slowly, then step position along it so the track and
    // the course arrow point the same way.
    heading = (heading + (Math.random() * 2 - 1) * 12 + 360) % 360;
    const bearing = (heading * Math.PI) / 180;
    const drift = (spd / 25) * 0.0004;
    lat = clamp(lat + Math.cos(bearing) * drift, 37.7, 37.83);
    lon = clamp(lon + Math.sin(bearing) * drift, -122.52, -122.36);

    imuT += 0.05;
    const quat = normalizeQuat({
      r: Math.cos(imuT / 2),
      i: Math.sin(imuT / 2),
      j: Math.sin(imuT / 3) * 0.3,
      k: Math.cos(imuT / 4) * 0.2,
    });
    const euler = quatToEuler(quat);

    let obd: TelemetryReading["metrics"]["obd"] | undefined;
    if (opts.obd) {
      const nowMs = Date.now();
      const dtS = Math.max(0, Math.min(5, (nowMs - obdLastMs) / 1000));
      obdLastMs = nowMs;
      runTime += dtS;
      coolant = Math.min(90, coolant + dtS * 0.08);
      fuel = Math.max(5, fuel - dtS * 0.0004);
      odometer += (spd / 3600) * dtS;
      obd = {
        link: { value: 2 },
        rpm: { value: Math.round(900 + spd * 45 + rpmJitter()), unit: "rpm" },
        speed: { value: Math.round(spd), unit: "km/h" },
        coolant_temp: { value: Math.round(coolant), unit: "°C" },
        engine_load: { value: round(engineLoad(), 1), unit: "%" },
        throttle: { value: round(throttle() + spd * 0.8, 1), unit: "%" },
        fuel_level: { value: round(fuel, 1), unit: "%" },
        module_voltage: { value: round(moduleVoltage(), 2), unit: "V" },
        run_time: { value: Math.round(runTime), unit: "s" },
        odometer: { value: round(odometer, 1), unit: "km" },
        gear: { value: spd < 1 ? 0 : Math.min(6, 1 + Math.floor(spd / 12)) },
        mil: { value: 0 },
        dtc_count: { value: 0 },
      };
    }

    return {
      metrics: {
        imu: {
          quat_r: { value: round(quat.r, 4) },
          quat_i: { value: round(quat.i, 4) },
          quat_j: { value: round(quat.j, 4) },
          quat_k: { value: round(quat.k, 4) },
          euler_roll: { value: round(euler.roll, 1), unit: "°" },
          euler_pitch: { value: round(euler.pitch, 1), unit: "°" },
          euler_yaw: { value: round(euler.yaw, 1), unit: "°" },
          accel_x: { value: round(accelX(), 3), unit: "m/s^2" },
          accel_y: { value: round(accelY(), 3), unit: "m/s^2" },
          accel_z: { value: round(accelZ(), 3), unit: "m/s^2" },
        },
        gps: {
          lat: { value: round(lat, 6) },
          lon: { value: round(lon, 6) },
          alt: { value: round(alt(), 1), unit: "m" },
          speed: { value: round(spd, 1), unit: "km/h" },
          course: { value: round(heading, 1), unit: "°" },
          satellites: { value: Math.round(satellites()) },
          fix_quality: { value: 1 }, // 1 = GPS fix
          satellites_in_view: { value: Math.round(satellitesInView()) },
          hdop: { value: round(hdop(), 1) },
        },
        lte: {
          rssi: { value: round(rssi(), 0), unit: "dBm" },
          quality: { value: round(quality(), 0), unit: "asu" },
        },
        system: {
          cpu_usage: { value: round(cpuUsage(), 1), unit: "%" },
          cpu_temp: { value: round(cpuTemp(), 1), unit: "°C" },
          ram_usage: { value: round(ramUsage(), 1), unit: "%" },
          disk_usage: { value: round(diskUsage(), 1), unit: "%" },
        },
        ...(obd ? { obd } : {}),
      },
      media: {
        kvs: { value: false },
        recording: { value: false },
        streams: [],
      },
    };
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
