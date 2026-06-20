/**
 * Synthetic telemetry generator. Produces schema-valid payloads matching the
 * seeded `XG-RPI-REF-1` capability set (imu/gps/lte/system + media flags) so the
 * whole ingestion → storage → live-view pipeline is testable without hardware.
 *
 * Each metric is a gentle bounded random walk, so live charts look realistic and
 * the GPS marker drifts smoothly. Values are clamped to plausible ranges.
 */

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// A bounded random-walk channel: holds its own value across ticks.
function channel(initial, step, min, max) {
  let value = initial;
  return () => {
    value = clamp(value + (Math.random() * 2 - 1) * step, min, max);
    return value;
  };
}

export function createSimulator() {
  // IMU around gravity (z ≈ 9.81 m/s^2), small jitter on x/y.
  const imuX = channel(0, 0.15, -2, 2);
  const imuY = channel(0, 0.15, -2, 2);
  const imuZ = channel(9.81, 0.1, 9.2, 10.4);

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

  return function next() {
    const spd = speed();
    // Nudge position proportional to speed so the map track is coherent.
    const drift = (spd / 25) * 0.0004;
    lat = clamp(lat + (Math.random() * 2 - 1) * drift, 37.7, 37.83);
    lon = clamp(lon + (Math.random() * 2 - 1) * drift, -122.52, -122.36);

    return {
      metrics: {
        imu: {
          x: { value: round(imuX(), 3), unit: "m/s^2" },
          y: { value: round(imuY(), 3), unit: "m/s^2" },
          z: { value: round(imuZ(), 3), unit: "m/s^2" },
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

function round(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
