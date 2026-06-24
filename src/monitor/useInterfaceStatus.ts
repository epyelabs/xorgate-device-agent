/**
 * Polls per-interface internet reachability for the monitor header. Runs only
 * while `manage` is open (this hook is mounted), on a slow cadence, off the
 * agent's telemetry path. Mirrors LteDetail's alive-guarded interval pattern.
 */
import { useEffect, useState } from "react";
import { interfaceStatuses, type IfaceStatus } from "../hardware/network.js";

export function useInterfaceStatus(pollMs = 10000): IfaceStatus[] {
  const [statuses, setStatuses] = useState<IfaceStatus[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      void interfaceStatuses().then((s) => alive && setStatuses(s));
    };
    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs]);
  return statuses;
}
