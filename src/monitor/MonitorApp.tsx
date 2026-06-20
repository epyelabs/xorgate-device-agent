/**
 * Live monitor for the telemetry daemon (adapted from argus's DashboardScreen:
 * all panels mounted, responsive two-column collapse). Polls the daemon state
 * file via useDaemonState and drives start/stop/restart via useDaemonControls —
 * the SAME manager calls the CLI uses. Quitting the monitor never stops the
 * daemon (it's detached and independent).
 */
import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { Header } from "../components/Header.js";
import { KeyHints, type Hint } from "../components/KeyHints.js";
import { LogView } from "../components/LogView.js";
import { useTerminalSize } from "../lib/useTerminalSize.js";
import { useDaemonState, type Inspector } from "./useDaemonState.js";
import { useDaemonControls } from "./useDaemonControls.js";
import { useLogTail } from "./useLogTail.js";
import { ConnectionPanel } from "./panels/ConnectionPanel.js";
import { DaemonPanel } from "./panels/DaemonPanel.js";
import { ImuPanel } from "./panels/ImuPanel.js";
import { GpsPanel } from "./panels/GpsPanel.js";
import { LtePanel } from "./panels/LtePanel.js";
import { SystemPanel } from "./panels/SystemPanel.js";
import { MediaPanel } from "./panels/MediaPanel.js";
import { ActivityPanel } from "./panels/ActivityPanel.js";

const WIDE_THRESHOLD = 100;

const BUSY_LABEL = {
  starting: "starting daemon…",
  stopping: "stopping daemon…",
  restarting: "restarting daemon…",
} as const;

export function MonitorApp({
  agentArgs = [],
  inspector,
}: {
  agentArgs?: string[];
  /** Test seam: override the daemon-status source (defaults to the real inspect). */
  inspector?: Inspector;
}) {
  const { exit } = useApp();
  const { columns } = useTerminalSize();
  const wide = columns >= WIDE_THRESHOLD;
  const { status, now, refresh } = useDaemonState(1000, inspector);
  const controls = useDaemonControls(agentArgs, refresh);
  const [showLogs, setShowLogs] = useState(false);
  const logLines = useLogTail(showLogs);

  const running = status.kind === "running";

  useInput((input) => {
    if (input === "q" || input === "Q") exit();
    else if ((input === "s" || input === "S") && !running) controls.start();
    else if ((input === "x" || input === "X") && running) controls.stop();
    else if (input === "r" || input === "R") controls.restart();
    else if (input === "l" || input === "L") setShowLogs((v) => !v);
  });

  const hints: Hint[] = running
    ? [
        { keys: "x", label: "stop" },
        { keys: "r", label: "restart" },
        { keys: "l", label: showLogs ? "hide log" : "log" },
        { keys: "q", label: "quit (daemon keeps running)" },
      ]
    : [
        { keys: "s", label: "start" },
        { keys: "r", label: "restart" },
        { keys: "q", label: "quit" },
      ];

  const row = (children: React.ReactNode) => (
    <Box flexDirection={wide ? "row" : "column"} gap={wide ? 1 : 0}>
      {children}
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Header title="XORGATE Monitor" />

      {controls.busy ? (
        <Box marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {BUSY_LABEL[controls.busy]}
          </Text>
        </Box>
      ) : null}

      {running ? (
        <Body status={status} now={now} wide={wide} row={row} />
      ) : (
        <NotRunning status={status} />
      )}

      {showLogs ? (
        <Box marginTop={1}>
          <LogView lines={logLines} maxLines={12} title="Daemon log" />
        </Box>
      ) : null}

      {controls.lastMsg ? (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            {controls.lastMsg}
          </Text>
        </Box>
      ) : null}

      <KeyHints hints={hints} />
    </Box>
  );
}

function Body({
  status,
  now,
  wide,
  row,
}: {
  status: Extract<ReturnType<typeof useDaemonState>["status"], { kind: "running" }>;
  now: number;
  wide: boolean;
  row: (children: React.ReactNode) => React.ReactNode;
}) {
  const { record, state: snapshot, stateFresh } = status;
  const latest = snapshot?.latest ?? null;
  const metrics = latest?.metrics;

  return (
    <Box flexDirection="column">
      {row(
        <>
          <ConnectionPanel
            connection={snapshot?.connection ?? "connecting"}
            endpoint={snapshot?.endpoint ?? record.deviceId}
            connectionSince={snapshot?.connectionSince ?? record.startedAt}
            fresh={stateFresh}
            now={now}
          />
          <DaemonPanel record={record} snapshot={snapshot} now={now} />
        </>,
      )}

      {latest ? (
        <>
          {row(
            <>
              <ImuPanel imu={metrics?.imu} />
              <GpsPanel gps={metrics?.gps} />
              <LtePanel lte={metrics?.lte} />
              <SystemPanel system={metrics?.system} />
            </>,
          )}
          {row(
            <>
              <MediaPanel media={latest.media} />
              <ActivityPanel events={snapshot?.recentEvents ?? []} />
            </>,
          )}
        </>
      ) : (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> waiting for first telemetry tick…
          </Text>
        </Box>
      )}
    </Box>
  );
}

function NotRunning({
  status,
}: {
  status: ReturnType<typeof useDaemonState>["status"];
}) {
  const stale = status.kind === "stale";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={stale ? "yellow" : "gray"}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Text bold color={stale ? "yellow" : "white"}>
        {stale ? "◌ Daemon not running (stale pidfile)" : "○ Daemon not running"}
      </Text>
      {stale && status.kind === "stale" ? (
        <Text color="gray">
          pidfile for pid {status.record.pid} —{" "}
          {status.reason === "pid-reused" ? "pid was recycled" : "process is gone"}; start cleans it.
        </Text>
      ) : null}
      <Text color="gray">
        Press <Text color="cyan">s</Text> to start the telemetry agent.
      </Text>
    </Box>
  );
}
