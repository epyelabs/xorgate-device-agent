/**
 * Merge the LED state into telemetry (plans/include-led-status-in-telemetry).
 *
 * `system.led_state` + `system.health_flags` ride the EXISTING `system` group on
 * every live payload and every recorded `system` sample. They are merged here,
 * in the worker's path, and deliberately NOT inside `createCollector`: the
 * collector set is byte-checked by the OBD tests, and the LED's inputs (MQTT
 * link, recording verdicts) belong to the worker, not to any collector.
 *
 * Pure helpers so the live payload and the recorder wrapper are unit-testable
 * without booting a worker.
 */
import type { GroupSample } from "./collectors/index.js";
import type { TelemetryMetrics } from "./telemetry.js";
import type { LedTelemetry } from "../lib/led-state.js";

/** Before the first LED tick the state is, by definition, "starting". */
export const LED_TELEMETRY_STARTING: LedTelemetry = Object.freeze({ led_state: 1, health_flags: 0 });
/** The simulator is always healthy (plan P1 step 4). */
export const LED_TELEMETRY_SIM: LedTelemetry = Object.freeze({ led_state: 0, health_flags: 0 });

function leaves(t: LedTelemetry): Record<string, { value: number }> {
  // No unit on purpose: frontends print a label, not a number with a unit
  // (same as `system.throttled`).
  return { led_state: { value: t.led_state }, health_flags: { value: t.health_flags } };
}

/**
 * Live path: return `metrics` with the two leaves merged into `system`. A null
 * `t` (replay mode: the recorded `system.*` wins, untouched) returns `metrics`
 * as-is. Never mutates its input — collector caches are shared.
 */
export function withLedLeaves(
  metrics: Partial<TelemetryMetrics>,
  t: LedTelemetry | null,
): Partial<TelemetryMetrics> {
  if (!t) return metrics;
  const system = { ...(metrics.system ?? {}), ...leaves(t) } as TelemetryMetrics["system"];
  return { ...metrics, system };
}

/**
 * Recorder path: same merge over `sampleGroups()`. The leaves reuse the system
 * sample's `updatedMono`, so they land exactly when (and as often as) the
 * system group does: 1 Hz by its native cadence. With no system sample at all
 * (a host where the collector reads nothing) a group is synthesised with a
 * fresh stamp; the recorder's 1 Hz `system` cadence gate still caps it.
 */
export function withLedSampleGroups(
  groups: Record<string, GroupSample>,
  t: LedTelemetry | null,
  nowMono: () => bigint = () => process.hrtime.bigint(),
): Record<string, GroupSample> {
  if (!t) return groups;
  const sys = groups.system;
  return {
    ...groups,
    system: sys
      ? { fields: { ...sys.fields, ...leaves(t) }, updatedMono: sys.updatedMono }
      : { fields: leaves(t), updatedMono: nowMono() },
  };
}
