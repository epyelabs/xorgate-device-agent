import { Text } from "ink";
import { Panel } from "../Panel.js";
import { LevelMeter } from "../../components/LevelMeter.js";
import { leaf, gauge } from "../format.js";
import type { TelemetryMetrics } from "../../agent/telemetry.js";

export function LtePanel({ lte }: { lte?: TelemetryMetrics["lte"] }) {
  return (
    <Panel title="LTE" flexGrow={1}>
      {lte ? (
        <>
          <Text>
            <Text color="gray">rssi </Text>
            {leaf(lte.rssi, 0)}
          </Text>
          <Text>
            <Text color="gray">qual </Text>
            {leaf(lte.quality, 0)}
          </Text>
          <LevelMeter level={gauge(lte.quality.value, 0, 31)} width={12} />
        </>
      ) : (
        <Text color="gray">—</Text>
      )}
    </Panel>
  );
}
