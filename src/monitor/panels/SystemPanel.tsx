import { Text } from "ink";
import { Panel } from "../Panel.js";
import { LevelMeter } from "../../components/LevelMeter.js";
import { leaf, gauge } from "../format.js";
import type { TelemetryMetrics } from "../../agent/telemetry.js";

export function SystemPanel({ system }: { system?: TelemetryMetrics["system"] }) {
  return (
    <Panel title="System (device)" flexGrow={1}>
      {system ? (
        <>
          <LevelMeter level={gauge(system.cpu_usage.value, 0, 100)} width={10} label="cpu " />
          <LevelMeter level={gauge(system.ram_usage.value, 0, 100)} width={10} label="ram " />
          <LevelMeter level={gauge(system.disk_usage.value, 0, 100)} width={10} label="disk" />
          <Text color="gray">temp {leaf(system.cpu_temp, 1)}</Text>
        </>
      ) : (
        <Text color="gray">—</Text>
      )}
    </Panel>
  );
}
