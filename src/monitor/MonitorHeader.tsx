/**
 * Monitor title bar: app identity + host, plus the daemon's Connection (left)
 * and Daemon stats (right). Replaces the old live host-metrics header — device
 * CPU/RAM/etc. live in the "System" module, so they're not duplicated here.
 */
import { Box, Text } from "ink";
import { StatusBadge } from "../components/StatusBadge.js";
import { osInfo } from "../hardware/system.js";
import { hostLabel, isMock } from "../lib/platform.js";
import { ageLabel, uptimeLabel } from "../lib/format.js";
import { connectionStatus } from "./format.js";
import type { DaemonStatus } from "../daemon/manager.js";

export function MonitorHeader({ status, now }: { status: DaemonStatus; now: number }) {
  const os = osInfo();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          XORGATE Manager
        </Text>
        <Box>
          <Text color={isMock() ? "yellow" : "gray"}>{hostLabel()}</Text>
          <Text color="gray">{`  ${os.pretty} ${os.arch}`}</Text>
        </Box>
      </Box>

      <Box
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      />

      {status.kind === "running" ? (
        <RunningRow status={status} now={now} />
      ) : (
        <NotRunningRow stale={status.kind === "stale"} />
      )}
    </Box>
  );
}

function RunningRow({
  status,
  now,
}: {
  status: Extract<DaemonStatus, { kind: "running" }>;
  now: number;
}) {
  const { record, state, stateFresh } = status;
  const conn = state?.connection ?? "connecting";
  const since = state?.connectionSince ?? record.startedAt;
  return (
    <Box justifyContent="space-between">
      <Box>
        <StatusBadge status={stateFresh ? connectionStatus(conn) : "warn"}>{conn}</StatusBadge>
        {record.offline ? <Text color="gray"> · offline</Text> : null}
        <Text color="gray"> · {ageLabel(since, now)}</Text>
        {!stateFresh ? <Text color="yellow"> · stale</Text> : null}
      </Box>
      <Box>
        <Text color="gray">pid </Text>
        <Text>{record.pid}</Text>
        <Text color="gray">{` · up ${uptimeLabel(now - record.startedAt)} · ${record.mode} ${record.rateHz}Hz`}</Text>
        {state ? (
          <Text color="gray">
            {` · seq ${state.seq} pub ${state.published}`}
            {state.publishErrors > 0 ? <Text color="red">{` err ${state.publishErrors}`}</Text> : ""}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function NotRunningRow({ stale }: { stale: boolean }) {
  return (
    <Text color={stale ? "yellow" : "gray"}>
      {stale ? "◌ daemon not running (stale pidfile)" : "○ daemon not running"}
    </Text>
  );
}
