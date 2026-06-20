import { Text } from "ink";
import { Panel } from "../Panel.js";
import { leaf } from "../format.js";
import type { MetricLeaf, TelemetryMetrics } from "../../agent/telemetry.js";

/** 6-dp coordinate, null-safe for a partial/missing fix. */
function coord(l: MetricLeaf | undefined): string {
  return typeof l?.value === "number" ? l.value.toFixed(6) : "—";
}

export function GpsPanel({ gps }: { gps?: TelemetryMetrics["gps"] }) {
  return (
    <Panel title="GPS" flexGrow={1}>
      {gps ? (
        <>
          <Text>{coord(gps.lat)}</Text>
          <Text>{coord(gps.lon)}</Text>
          <Text color="gray">
            alt {leaf(gps.alt, 1)} · {leaf(gps.speed, 1)}
          </Text>
        </>
      ) : (
        <Text color="gray">—</Text>
      )}
    </Panel>
  );
}
