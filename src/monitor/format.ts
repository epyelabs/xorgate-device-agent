/** Monitor-specific formatters that map telemetry into display strings/badges. */
import type { ConnectionState, MetricLeaf } from "../agent/telemetry.js";
import type { Status } from "../components/StatusBadge.js";

/** Render a `{ value, unit }` leaf, or "—" when absent. */
export function leaf(l: MetricLeaf | undefined, dp = 2): string {
  if (!l || typeof l.value !== "number") return "—";
  const v = Number.isInteger(l.value) ? String(l.value) : l.value.toFixed(dp);
  return l.unit ? `${v} ${l.unit}` : v;
}

/** Map a connection state to a StatusBadge kind. */
export function connectionStatus(c: ConnectionState): Status {
  switch (c) {
    case "connected":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "busy";
    case "closed":
      return "warn";
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

/** Clamp a value into 0..1 for a LevelMeter from a [min,max] range. */
export function gauge(value: number | undefined, min: number, max: number): number {
  if (typeof value !== "number") return 0;
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}
