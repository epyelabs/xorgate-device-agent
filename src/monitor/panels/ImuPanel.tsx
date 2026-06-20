import { Text } from "ink";
import { Panel } from "../Panel.js";
import { signedFixed } from "../../lib/format.js";
import type { MetricLeaf, TelemetryMetrics } from "../../agent/telemetry.js";

/** Signed 3-dp axis, null-safe for a partial/missing read. */
function axis(l: MetricLeaf | undefined): string {
  return typeof l?.value === "number" ? signedFixed(l.value, 3) : "—";
}

export function ImuPanel({ imu }: { imu?: TelemetryMetrics["imu"] }) {
  return (
    <Panel title="IMU" flexGrow={1}>
      {imu ? (
        <>
          <Text>
            <Text color="gray">x </Text>
            {axis(imu.x)}
          </Text>
          <Text>
            <Text color="gray">y </Text>
            {axis(imu.y)}
          </Text>
          <Text>
            <Text color="gray">z </Text>
            {axis(imu.z)}
          </Text>
          <Text color="gray">m/s²</Text>
        </>
      ) : (
        <Text color="gray">—</Text>
      )}
    </Panel>
  );
}
