import type { Collector } from "./index.js";
import {
  sampleCpu,
  computeCpuLoad,
  readMemory,
  readCpuTemp,
  readDisk,
  type CpuSample,
} from "../../hardware/system.js";
import {
  readThrottled,
  readPmicAdc,
  rail5vFrom,
  readMaxCurrentMa,
} from "../../hardware/power.js";
import { commandExists } from "../../lib/exec.js";

/**
 * System metrics collector — CPU usage/temp, RAM/disk usage, and power health
 * (throttle bitmask, 5V rail, negotiated PSU limit).
 *
 * Pure Node reads of /proc, /sys, `df` and `vcgencmd` (no I2C/Python/detection);
 * the non-root agent can read all of them (vcgencmd needs /dev/vcio — video
 * group). CPU% needs a delta, so we keep the previous tick's CPU sample in the
 * closure and diff it each read (~1 Hz). Every reader degrades gracefully:
 * off-Pi (e.g. macOS dev) cpu_temp/disk/power return null and we omit those
 * fields, so the worker drops them from the `system` group rather than emitting
 * 0s; a Pi 4's unsupported pmic_read_adc is latched off after one probe while
 * throttled (all-Pi) keeps working. cpu_usage + ram_usage are always present
 * (readMemory/os fallback never fails).
 */
export function createSystemCollector(opts: { rails?: boolean } = {}): Collector {
  // Seeded at creation; the first read() diffs against it. If that read fires
  // immediately, cpu_usage may read ~0 for one tick (benign — same first-tick
  // behavior as the IMU collector returning {}).
  let prev: CpuSample = sampleCpu();

  // Power-health gates: vcgencmd presence is checked once (dev boxes never
  // exec it per tick), and a Pi 4's unsupported pmic_read_adc latches
  // pmicUnsupported after the first null so we stop retrying a failing exec.
  // A hardware block declaring `rails: false` (cm4-support — no PMIC ADC on
  // the CM4) pre-latches it, so the doomed probe is never even attempted;
  // omitted/true keeps the probe-and-latch behavior (legacy devices).
  const hasVcgencmd = commandExists("vcgencmd");
  let pmicUnsupported = opts.rails === false;
  // PSU max current is negotiated once at boot (device-tree is immutable per
  // boot) — read once here, re-emit every tick so recorded sessions carry it.
  const psuMaxCurrentMa = opts.rails === false ? Promise.resolve(null) : readMaxCurrentMa();

  async function compute(prevSample: CpuSample): Promise<{
    fields: Record<string, unknown>;
    curr: CpuSample;
  }> {
    const curr = sampleCpu();
    const { overall } = computeCpuLoad(prevSample, curr);

    const fields: Record<string, unknown> = {
      cpu_usage: { value: round(overall, 1), unit: "%" },
      ram_usage: { value: round(readMemory().usedPct, 1), unit: "%" },
    };

    const temp = await readCpuTemp();
    if (temp !== null) fields.cpu_temp = { value: round(temp, 1), unit: "°C" };

    const disk = await readDisk("/");
    if (disk !== null) fields.disk_usage = { value: round(disk.usedPct, 1), unit: "%" };

    if (await hasVcgencmd) {
      const throttle = await readThrottled();
      if (throttle !== null) fields.throttled = { value: throttle.current };

      if (!pmicUnsupported) {
        const adc = await readPmicAdc();
        if (adc === null) {
          pmicUnsupported = true;
        } else {
          const rail5v = rail5vFrom(adc);
          if (rail5v !== null) fields.rail_5v = { value: round(rail5v, 3), unit: "V" };
        }
      }
    }

    const maxMa = await psuMaxCurrentMa;
    if (maxMa !== null) fields.psu_max_current = { value: maxMa, unit: "mA" };

    return { fields, curr };
  }

  // Recorder-side cache with its OWN CpuSample chain: sharing `prev` with
  // read() would split the CPU-delta window between two consumers and make
  // both readings noise. Recomputes at most once per second (native cadence),
  // so a 10–20 Hz recorder costs one extra df/meminfo read per second.
  let recPrev: CpuSample | null = null;
  let recCache: { fields: Record<string, unknown>; updatedMono: bigint } | null = null;
  let recLastAt = 0;

  return {
    group: "system",
    async read() {
      const { fields, curr } = await compute(prev);
      prev = curr;
      return fields;
    },
    async sample() {
      const now = Date.now();
      if (now - recLastAt >= 1000) {
        recLastAt = now;
        const { fields, curr } = await compute(recPrev ?? sampleCpu());
        recPrev = curr;
        recCache = { fields, updatedMono: process.hrtime.bigint() };
      }
      return recCache;
    },
  };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
