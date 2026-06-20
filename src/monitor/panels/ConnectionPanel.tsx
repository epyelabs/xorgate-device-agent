import { Text } from "ink";
import { Panel } from "../Panel.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ageLabel } from "../../lib/format.js";
import { connectionStatus } from "../format.js";
import type { ConnectionState } from "../../agent/telemetry.js";

export function ConnectionPanel({
  connection,
  endpoint,
  connectionSince,
  fresh,
  now,
}: {
  connection: ConnectionState;
  endpoint: string;
  connectionSince: number;
  fresh: boolean;
  now: number;
}) {
  return (
    <Panel title="Connection" flexGrow={1}>
      <StatusBadge status={fresh ? connectionStatus(connection) : "warn"}>
        {connection}
        {!fresh ? <Text color="yellow"> (stale)</Text> : null}
      </StatusBadge>
      <Text color="gray" wrap="truncate-end">
        {endpoint}
      </Text>
      <Text color="gray">since {ageLabel(connectionSince, now)}</Text>
    </Panel>
  );
}
