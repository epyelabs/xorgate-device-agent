/**
 * System metrics collector (cpu_usage / cpu_temp / ram_usage / disk_usage).
 *
 * P5 STUB. Real implementation (Raspberry Pi class) reads:
 *  - cpu_temp:  /sys/class/thermal/thermal_zone0/temp  (millidegrees → °C)
 *  - cpu_usage: delta of /proc/stat jiffies between ticks
 *  - ram_usage: MemAvailable vs MemTotal from /proc/meminfo
 *  - disk_usage: statvfs of the root mount (used vs total blocks → %)
 * (cf. prototyping/alc-hw-tracker-pro/spawn.js for the temp/usage approach.)
 */
export function createSystemCollector() {
  return {
    group: 'system',
    async read() {
      return {}; // TODO(P5): return { cpu_usage:{value,unit:'%'}, cpu_temp:{value,unit:'°C'}, ram_usage:{value,unit:'%'}, disk_usage:{value,unit:'%'} }
    },
  };
}
