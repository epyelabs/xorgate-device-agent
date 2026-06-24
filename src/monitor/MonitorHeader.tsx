/**
 * Monitor title bar: app identity + host, plus a single status line —
 * connectivity (left) and daemon stats (right). Connectivity shows a colored
 * circle for each network interface's ACTUAL internet reachability (per NIC,
 * daemon-independent) plus an `mqtt` circle for the cloud/MQTT connection.
 * Device CPU/RAM/etc. live in the "System" module, so they're not duplicated here.
 */
import { Box, Text } from "ink";
import { osInfo } from "../hardware/system.js";
import { hostLabel, isMock } from "../lib/platform.js";
import { uptimeLabel } from "../lib/format.js";
import type { DaemonStatus } from "../daemon/manager.js";
import type { IfaceStatus, IfaceState } from "../hardware/network.js";
import type { ConnectionState } from "../agent/telemetry.js";

/** Internet-status circle color per interface state. */
const IFACE_COLOR: Record<IfaceState, string> = {
  online: "green",
  offline: "red",
  down: "gray",
};

/** MQTT/cloud circle color per connection state. */
const MQTT_COLOR: Record<ConnectionState, string> = {
  connected: "green",
  connecting: "yellow",
  reconnecting: "yellow",
  closed: "gray",
  error: "red",
};

/** Color for the mqtt circle: gray when the daemon is down, yellow when stale. */
function mqttColor(status: DaemonStatus): string {
  if (status.kind !== "running") return "gray";
  if (!status.stateFresh) return "yellow";
  return MQTT_COLOR[status.state?.connection ?? "connecting"];
}

export function MonitorHeader({
  status,
  now,
  interfaces = [],
}: {
  status: DaemonStatus;
  now: number;
  interfaces?: IfaceStatus[];
}) {
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

      {/* One line when the terminal is wide; if narrow, the stats wrap below
          while the connectivity row stays intact (never split mid-indicators). */}
      <Box flexWrap="wrap" justifyContent="space-between">
        <ConnectivityRow interfaces={interfaces} mqtt={mqttColor(status)} />
        {status.kind === "running" ? (
          <DaemonStats status={status} now={now} />
        ) : (
          <NotRunningStat stale={status.kind === "stale"} />
        )}
      </Box>
    </Box>
  );
}

/**
 * Compact connectivity line: a colored circle per interface + an `mqtt` circle
 * for the cloud link, each with a light label. flexShrink=0 keeps the whole group
 * intact on one line (the parent wraps the stats below instead of splitting this).
 */
function ConnectivityRow({ interfaces, mqtt }: { interfaces: IfaceStatus[]; mqtt: string }) {
  return (
    <Box flexShrink={0}>
      <Text color="gray">Connectivity </Text>
      {interfaces.length === 0 ? (
        <Text color="gray" dimColor>
          {"checking…  "}
        </Text>
      ) : (
        interfaces.map((i) => (
          <Text key={i.name}>
            <Text color={IFACE_COLOR[i.state]}>●</Text>
            <Text color="white">{` ${i.name}  `}</Text>
          </Text>
        ))
      )}
      <Text>
        <Text color={mqtt}>●</Text>
        <Text color="white">{" mqtt  "}</Text>
      </Text>
    </Box>
  );
}

function DaemonStats({
  status,
  now,
}: {
  status: Extract<DaemonStatus, { kind: "running" }>;
  now: number;
}) {
  const { record, state, stateFresh } = status;
  return (
    <Box flexShrink={0}>
      {record.offline ? <Text color="gray">offline · </Text> : null}
      <Text color="gray">pid </Text>
      <Text>{record.pid}</Text>
      <Text color="gray">{` · up ${uptimeLabel(now - record.startedAt)} · ${record.mode} ${record.rateHz}Hz`}</Text>
      {state && state.publishErrors > 0 ? (
        <Text color="red">{` · err ${state.publishErrors}`}</Text>
      ) : null}
      {!stateFresh ? <Text color="yellow">{" · stale"}</Text> : null}
    </Box>
  );
}

function NotRunningStat({ stale }: { stale: boolean }) {
  return (
    <Box flexShrink={0}>
      <Text color={stale ? "yellow" : "gray"}>
        {stale ? "◌ daemon stopped (stale pidfile)" : "○ daemon stopped"}
      </Text>
    </Box>
  );
}
