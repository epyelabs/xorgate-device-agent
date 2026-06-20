import type { Collector } from "./index.js";

/**
 * System metrics collector (cpu_usage / cpu_temp / ram_usage / disk_usage).
 *
 * P5 STUB. Real implementation (Raspberry Pi class) reads:
 *  - cpu_temp:  /sys/class/thermal/thermal_zone0/temp  (millidegrees → °C)
 *  - cpu_usage: delta of /proc/stat jiffies between ticks
 *  - ram_usage: MemAvailable vs MemTotal from /proc/meminfo
 *  - disk_usage: statvfs of the root mount (used vs total blocks → %)
 *
 * NOTE: src/hardware/system.ts already implements most of these host readers
 * (reused by the monitor header) and is the natural basis for the P5 wiring.
 */
export function createSystemCollector(): Collector {
  return {
    group: "system",
    async read() {
      return {}; // TODO(P5): { cpu_usage:{value,unit:'%'}, cpu_temp:{value,unit:'°C'}, ram_usage:{value,unit:'%'}, disk_usage:{value,unit:'%'} }
    },
  };
}
