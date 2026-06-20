/** `xorgate start [agent flags]` — launch the detached telemetry daemon. */
import { start } from "../daemon/manager.js";

export async function startCommand(argv: string[]): Promise<void> {
  const res = await start(argv, Date.now());
  if (res.cleanedStale) console.log("(removed stale pidfile)");

  if (res.ok) {
    console.log(`✓ ${res.message}`);
    console.log(`  status:  xorgate status`);
    console.log(`  monitor: xorgate monitor`);
    return;
  }

  console.error(`✗ ${res.message}`);
  if (res.alreadyRunning) {
    console.error(`  (pid ${res.alreadyRunning.pid}; use 'xorgate restart' to replace it)`);
  }
  if (res.logTail?.length) {
    console.error("  --- last log lines ---");
    for (const l of res.logTail) console.error(`  ${l}`);
  }
  process.exitCode = 1;
}
