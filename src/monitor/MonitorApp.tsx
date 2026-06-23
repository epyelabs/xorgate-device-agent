/**
 * Live monitor for the telemetry daemon — argus-cli-style master/detail: a left
 * sidebar lists the telemetry modules with live status; ↑/↓ select and ↵/→ open
 * the selected module's detail on the right. Connection/Daemon stats live in the
 * header. Daemon controls (start/stop/restart) are driven by the SAME manager
 * the CLI uses, so the keybindings behave identically. Quitting never stops the
 * detached daemon.
 */
import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { KeyHints, type Hint } from "../components/KeyHints.js";
import { LogView } from "../components/LogView.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { PanelFrame } from "../dashboard/PanelFrame.js";
import { useTerminalSize } from "../lib/useTerminalSize.js";
import { MonitorHeader } from "./MonitorHeader.js";
import { MODULES, SettingsDetail } from "./modules.js";
import { useDaemonState, type Inspector } from "./useDaemonState.js";
import { useDaemonControls } from "./useDaemonControls.js";
import { useLogTail } from "./useLogTail.js";
import { loadSettings, saveSettings } from "../daemon/settings.js";
import type { RunMode } from "../agent/telemetry.js";

const LIST_WIDTH = 22;
const NARROW_THRESHOLD = 80;

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
  const twoCol = columns >= NARROW_THRESHOLD;
  const detailWidth = twoCol ? columns - LIST_WIDTH - 1 : undefined;

  const { status, now, refresh } = useDaemonState(1000, inspector);
  const controls = useDaemonControls(agentArgs, refresh);
  const [selected, setSelected] = useState(0);
  const [operating, setOperating] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [modeChoice, setModeChoice] = useState<RunMode | null>(null);
  const [mediaChoice, setMediaChoice] = useState<boolean | null>(null);
  const [settingsRow, setSettingsRow] = useState(0);
  const logLines = useLogTail(showLogs);

  const running = status.kind === "running";
  const snapshot = running ? status.state : null;
  const selectedModule = MODULES[selected];
  const onSettings = selectedModule.id === "settings";
  // The snapshot doesn't carry the media toggle, so read the persisted value for
  // the Settings form (only when that pane is active to avoid a per-tick file read).
  const mediaEnabled = onSettings ? (loadSettings().mediaEnabled ?? false) : false;

  useInput((input, key) => {
    if (operating) {
      if (input === "q" || input === "Q" || key.escape || key.leftArrow) {
        setOperating(false);
        return;
      }
      if (onSettings) {
        if (key.upArrow || key.downArrow || input === "j" || input === "k") {
          setSettingsRow((r) => (r === 0 ? 1 : 0)); // move between run mode / media
        } else if (input === " ") {
          // Toggle the focused row's pending value.
          if (settingsRow === 0) {
            setModeChoice((c) => ((c ?? snapshot?.mode ?? "sim") === "sim" ? "real" : "sim"));
          } else {
            setMediaChoice((c) => !(c ?? mediaEnabled));
          }
        } else if (key.return || input === "a" || input === "A") {
          // Persist both choices, then restart so loadConfig picks them up.
          saveSettings({
            ...loadSettings(),
            mode: modeChoice ?? snapshot?.mode ?? "sim",
            mediaEnabled: mediaChoice ?? mediaEnabled,
          });
          controls.restart();
          setOperating(false);
        }
      }
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((i) => (i - 1 + MODULES.length) % MODULES.length);
    } else if (key.downArrow || input === "j") {
      setSelected((i) => (i + 1) % MODULES.length);
    } else if ((key.return || key.rightArrow) && running) {
      if (onSettings) {
        const persisted = loadSettings();
        setModeChoice(snapshot?.mode ?? persisted.mode ?? "sim");
        setMediaChoice(persisted.mediaEnabled ?? false);
        setSettingsRow(0);
      }
      setOperating(true);
    } else if ((input === "s" || input === "S") && !running) {
      controls.start();
    } else if ((input === "x" || input === "X") && running) {
      controls.stop();
    } else if (input === "r" || input === "R") {
      controls.restart();
    } else if (input === "l" || input === "L") {
      setShowLogs((v) => !v);
    } else if (input === "q" || input === "Q") {
      exit();
    }
  });

  const Detail = selectedModule.Detail;

  const list = (
    <Box flexDirection="column" width={twoCol ? LIST_WIDTH : undefined}>
      {MODULES.map((m, i) => {
        const st = m.status(snapshot);
        return (
          <PanelFrame key={m.id} title={m.title} isFocused={i === selected}>
            <StatusBadge status={running ? st.status : "unknown"}>
              {running ? st.label : "—"}
            </StatusBadge>
          </PanelFrame>
        );
      })}
    </Box>
  );

  const detail = (
    <Box
      flexGrow={twoCol ? 0 : 1}
      width={detailWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor={operating ? "cyan" : "gray"}
      paddingX={1}
      marginLeft={twoCol ? 1 : 0}
      marginTop={twoCol ? 0 : 1}
    >
      {onSettings ? (
        <SettingsDetail
          snapshot={snapshot}
          now={now}
          modeChoice={modeChoice ?? undefined}
          mediaChoice={mediaChoice ?? undefined}
          mediaEnabled={mediaEnabled}
          row={settingsRow}
          operating={operating}
        />
      ) : (
        <Detail snapshot={snapshot} now={now} />
      )}
    </Box>
  );

  const hints: Hint[] = !running
    ? [
        { keys: "s", label: "start" },
        { keys: "r", label: "restart" },
        { keys: "q", label: "quit" },
      ]
    : operating
      ? onSettings
        ? [
            { keys: "↑↓", label: "field" },
            { keys: "space", label: "toggle" },
            { keys: "↵", label: "apply & restart" },
            { keys: "←/q", label: "back" },
          ]
        : [{ keys: "←/q", label: "back" }]
      : [
          { keys: "↑↓", label: "select" },
          { keys: "↵", label: "open" },
          { keys: "x", label: "stop" },
          { keys: "r", label: "restart" },
          { keys: "l", label: showLogs ? "hide log" : "log" },
          { keys: "q", label: "quit (daemon keeps running)" },
        ];

  return (
    <Box flexDirection="column">
      <MonitorHeader status={status} now={now} />

      {controls.busy ? (
        <Box marginBottom={1}>
          <Text color="cyan">
            <Spinner type="dots" /> {BUSY_LABEL[controls.busy]}
          </Text>
        </Box>
      ) : null}

      {running ? (
        <Box flexDirection={twoCol ? "row" : "column"}>
          {list}
          {detail}
        </Box>
      ) : (
        <NotRunning stale={status.kind === "stale"} />
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

function NotRunning({ stale }: { stale: boolean }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={stale ? "yellow" : "gray"}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={stale ? "yellow" : "white"}>
        {stale ? "◌ Daemon not running (stale pidfile)" : "○ Daemon not running"}
      </Text>
      <Text color="gray">
        Press <Text color="cyan">s</Text> to start the telemetry agent
        {stale ? " (the stale pidfile is cleaned automatically)" : ""}.
      </Text>
    </Box>
  );
}
