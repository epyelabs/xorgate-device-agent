/**
 * Wraps the same manager.start/stop/restart the CLI uses behind a busy flag, so
 * the monitor's keybindings drive the daemon identically to the command line.
 */
import { useCallback, useState } from "react";
import { restart, start, stop } from "../daemon/manager.js";

export type Busy = null | "starting" | "stopping" | "restarting";

export interface Controls {
  busy: Busy;
  lastMsg: string | null;
  start: () => void;
  stop: () => void;
  restart: () => void;
}

export function useDaemonControls(agentArgs: string[], onSettled: () => void): Controls {
  const [busy, setBusy] = useState<Busy>(null);
  const [lastMsg, setLastMsg] = useState<string | null>(null);

  const run = useCallback(
    (phase: Busy, op: () => Promise<{ message: string }>) => {
      if (busy) return;
      setBusy(phase);
      void op()
        .then((res) => setLastMsg(res.message))
        .catch((err: unknown) => setLastMsg(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          setBusy(null);
          onSettled();
        });
    },
    [busy, onSettled],
  );

  return {
    busy,
    lastMsg,
    start: useCallback(() => run("starting", () => start(agentArgs, Date.now())), [run, agentArgs]),
    stop: useCallback(() => run("stopping", () => stop(Date.now())), [run]),
    restart: useCallback(
      () => run("restarting", () => restart(agentArgs, Date.now())),
      [run, agentArgs],
    ),
  };
}
