import { Text } from "ink";
import { Panel } from "../Panel.js";
import { ageLabel, uptimeLabel } from "../../lib/format.js";
import type { PidRecord } from "../../daemon/pidfile.js";
import type { StateSnapshot } from "../../agent/telemetry.js";

export function DaemonPanel({
  record,
  snapshot,
  now,
}: {
  record: PidRecord;
  snapshot: StateSnapshot | null;
  now: number;
}) {
  return (
    <Panel title="Daemon" flexGrow={1}>
      <Text>
        <Text color="gray">pid </Text>
        {record.pid}
        <Text color="gray"> · up </Text>
        {uptimeLabel(now - record.startedAt)}
      </Text>
      <Text>
        <Text color="gray">mode </Text>
        {record.mode}
        <Text color="gray"> · </Text>
        {record.rateHz} Hz
        {record.offline ? <Text color="gray"> · offline</Text> : null}
      </Text>
      {snapshot ? (
        <Text>
          <Text color="gray">seq </Text>
          {snapshot.seq}
          <Text color="gray"> · pub </Text>
          {snapshot.published}
          <Text color={snapshot.publishErrors > 0 ? "red" : "gray"}>
            {" "}
            · err {snapshot.publishErrors}
          </Text>
        </Text>
      ) : null}
      {snapshot?.lastPublishAt ? (
        <Text color="gray">last publish {ageLabel(snapshot.lastPublishAt, now)}</Text>
      ) : null}
    </Panel>
  );
}
