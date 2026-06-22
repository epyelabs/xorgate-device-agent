import type { Collector } from "./index.js";
import { detectImu, streamImuData, type ImuSample } from "../../hardware/imu.js";
import { quatToEuler } from "../../lib/orientation.js";
import { toHexAddr } from "../../lib/format.js";
import type { StreamHandle } from "../../lib/exec.js";

/**
 * IMU collector — BNO085 over I2C (quaternion + euler + linear acceleration).
 *
 * The sensor streams ~20 Hz via the bundled Python helper, while the worker
 * pulls at ~1 Hz, so we keep the latest sample and map it on demand. Detection
 * and stream start happen lazily on the first read and self-gate: if i2cdetect
 * is missing, no BNO085 is on the bus, or no sample has landed yet, `read()`
 * returns {} and the worker simply omits the `imu` group. Euler is derived from
 * the quaternion here so consumers stay pure renderers.
 */
export function createImuCollector(): Collector {
  let started = false;
  let stream: StreamHandle | null = null;
  let latest: ImuSample | null = null;
  let everSampled = false;
  let warned = false;

  function reset(): void {
    started = false;
    stream = null;
    latest = null;
    everSampled = false;
  }

  // Detect once and, if a BNO085 is present, start the streaming helper. Failures
  // stay inert (the worker omits the group). Detection runs once at startup; if a
  // live stream later dies (cable yank, helper crash) we reset so the next tick
  // re-detects and can recover.
  async function start(): Promise<void> {
    started = true; // set before the first await so reads don't double-start
    const detect = await detectImu();
    if (!detect.available) {
      if (!warned) {
        console.warn(`[imu] ${detect.reason}`);
        warned = true;
      }
      return;
    }
    if (!detect.imuPresent || detect.imuAddress === null) {
      if (!warned) {
        console.warn("[imu] BNO085 not detected on I2C bus 1 (0x4a/0x4b)");
        warned = true;
      }
      return;
    }
    console.log(`[imu] BNO085 detected at ${toHexAddr(detect.imuAddress)} — streaming`);
    stream = streamImuData(detect.imuAddress, {
      onSample: (s) => {
        latest = s;
        everSampled = true;
      },
      onError: (msg) => console.error(`[imu] ${msg}`),
    });
    // If the reader exits after it had been producing samples, treat it as a
    // transient drop (cable/helper hiccup) and re-detect on the next tick. If it
    // never produced a sample, it's a setup problem (missing helper, no python3,
    // missing adafruit libs) — log it once and stay inert rather than respawn in
    // a tight loop. Fix the cause + restart the daemon to retry.
    void stream.done.then((res) => {
      if (everSampled) {
        console.warn("[imu] reader stream ended; will re-detect");
        reset();
      } else {
        console.error(
          `[imu] reader exited before any sample (exit ${res.exitCode ?? "?"}); IMU disabled. ` +
            "Check: i2cdetect -y 1, python3 + adafruit-circuitpython-bno08x, and python/bno085_read.py.",
        );
      }
    });
  }

  return {
    group: "imu",
    async read() {
      if (!started) {
        // Kick off detection/streaming without blocking the tick; the first
        // sample lands on a later read.
        void start();
        return {};
      }
      if (!latest) return {};

      const { quat, linaccel } = latest;
      const euler = quatToEuler(quat);
      return {
        quat_r: { value: round(quat.r, 4) },
        quat_i: { value: round(quat.i, 4) },
        quat_j: { value: round(quat.j, 4) },
        quat_k: { value: round(quat.k, 4) },
        euler_roll: { value: round(euler.roll, 1), unit: "°" },
        euler_pitch: { value: round(euler.pitch, 1), unit: "°" },
        euler_yaw: { value: round(euler.yaw, 1), unit: "°" },
        accel_x: { value: round(linaccel.x, 3), unit: "m/s^2" },
        accel_y: { value: round(linaccel.y, 3), unit: "m/s^2" },
        accel_z: { value: round(linaccel.z, 3), unit: "m/s^2" },
      };
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
