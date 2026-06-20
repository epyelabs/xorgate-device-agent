/**
 * Polls the daemon status (pidfile + liveness + identity + state-file freshness)
 * on an interval, mirroring argus's screen poll pattern (interval + `alive`
 * unmount guard). `bump` is a manual re-poll trigger the controls fire after a
 * start/stop so the UI reflects the new state without waiting a full tick.
 */
import { useCallback, useEffect, useState } from "react";
import { inspect as defaultInspect, type DaemonStatus } from "../daemon/manager.js";

export interface DaemonView {
  status: DaemonStatus;
  now: number;
  refresh: () => void;
}

export type Inspector = (now: number) => Promise<DaemonStatus>;

export function useDaemonState(pollMs = 1000, inspectFn: Inspector = defaultInspect): DaemonView {
  const [status, setStatus] = useState<DaemonStatus>({ kind: "stopped" });
  const [now, setNow] = useState(() => Date.now());
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const t = Date.now();
      const st = await inspectFn(t);
      if (!alive) return;
      setStatus(st);
      setNow(t);
    };
    void poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs, nonce, inspectFn]);

  return { status, now, refresh };
}
