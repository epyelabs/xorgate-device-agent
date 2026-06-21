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

export function createSimulator(): () => TelemetryReading {
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
  const alt = channel(20, 0.5, 0, 120);
  const speed = channel(0, 1.5, 0, 25); // km/h

  // LTE signal.
  const rssi = channel(-67, 1.5, -110, -50); // dBm
  const quality = channel(18, 0.8, 0, 31); // asu

  // System.
  const cpuUsage = channel(31, 3, 1, 100); // %
  const cpuTemp = channel(54, 0.6, 35, 85); // °C
  const ramUsage = channel(47, 1.5, 10, 95); // %
  const diskUsage = channel(38, 0.3, 5, 95); // %

  return function next(): TelemetryReading {
    const spd = speed();
    // Nudge position proportional to speed so the map track is coherent.
    const drift = (spd / 25) * 0.0004;
    lat = clamp(lat + (Math.random() * 2 - 1) * drift, 37.7, 37.83);
    lon = clamp(lon + (Math.random() * 2 - 1) * drift, -122.52, -122.36);

    imuT += 0.05;
    const quat = normalizeQuat({
      r: Math.cos(imuT / 2),
      i: Math.sin(imuT / 2),
      j: Math.sin(imuT / 3) * 0.3,
      k: Math.cos(imuT / 4) * 0.2,
    });
    const euler = quatToEuler(quat);

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
