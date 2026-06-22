import type { Collector } from "./index.js";
import {
  sampleCpu,
  computeCpuLoad,
  readMemory,
  readCpuTemp,
  readDisk,
  type CpuSample,
} from "../../hardware/system.js";

/**
 * System metrics collector — CPU usage/temp, RAM and disk usage from the host.
 *
 * Pure Node reads of /proc, /sys and `df` (no I2C/Python/detection); the non-root
 * agent can read all of them. CPU% needs a delta, so we keep the previous tick's
 * CPU sample in the closure and diff it each read (~1 Hz). Every reader degrades
 * gracefully: off-Pi (e.g. macOS dev) cpu_temp/disk return null and we omit those
 * fields, so the worker drops them from the `system` group rather than emitting 0s.
 * cpu_usage + ram_usage are always present (readMemory/os fallback never fails).
 */
export function createSystemCollector(): Collector {
  // Seeded at creation; the first read() diffs against it. If that read fires
  // immediately, cpu_usage may read ~0 for one tick (benign — same first-tick
  // behavior as the IMU collector returning {}).
  let prev: CpuSample = sampleCpu();

  return {
    group: "system",
    async read() {
      const curr = sampleCpu();
      const { overall } = computeCpuLoad(prev, curr);
      prev = curr;

      const fields: Record<string, unknown> = {
        cpu_usage: { value: round(overall, 1), unit: "%" },
        ram_usage: { value: round(readMemory().usedPct, 1), unit: "%" },
      };

      const temp = await readCpuTemp();
      if (temp !== null) fields.cpu_temp = { value: round(temp, 1), unit: "°C" };

      const disk = await readDisk("/");
      if (disk !== null) fields.disk_usage = { value: round(disk.usedPct, 1), unit: "%" };

      return fields;
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
