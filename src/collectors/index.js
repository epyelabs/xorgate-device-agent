import { createImuCollector } from './imu.js';
import { createGpsCollector } from './gps.js';
import { createLteCollector } from './lte.js';
import { createSystemCollector } from './system.js';

/**
 * Capability-driven collector registry (P5 skeleton).
 *
 * Given a device model's `io_capabilities` object, instantiate only the
 * collectors the hardware actually declares, then merge their per-group reads
 * into a `metrics` map shaped exactly like the simulator output. In `MODE=real`
 * the agent calls `collector.read()` each tick instead of the simulator.
 *
 * For P2 this is wired but inert (every collector returns {}); the real serial /
 * /proc / I2C reads land in P5 (device firmware).
 */
export function createCollector(ioCapabilities = {}) {
  const collectors = [];
  if (ioCapabilities.sensors?.imu) collectors.push(createImuCollector());
  if (ioCapabilities.comm?.gps) collectors.push(createGpsCollector());
  if (ioCapabilities.comm?.signal) collectors.push(createLteCollector());
  if (ioCapabilities.system) collectors.push(createSystemCollector());

  return {
    async read() {
      const metrics = {};
      for (const c of collectors) {
        const fields = await c.read();
        if (fields && Object.keys(fields).length > 0) metrics[c.group] = fields;
      }
      return { metrics, media: { kvs: { value: false }, recording: { value: false }, streams: [] } };
    },
  };
}
