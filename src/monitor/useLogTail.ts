/** Polls the daemon log tail while the in-monitor log view is open. */
import { useEffect, useState } from "react";
import { readLogTail } from "../daemon/manager.js";

export function useLogTail(active: boolean, maxLines = 12, pollMs = 1000): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = () => {
      const l = readLogTail(maxLines);
      if (alive) setLines(l);
    };
    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, maxLines, pollMs]);
  return lines;
}
