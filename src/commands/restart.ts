/** `xorgate restart [agent flags]` — stop then start. */
import { restart } from "../daemon/manager.js";

export async function restartCommand(argv: string[]): Promise<void> {
  const res = await restart(argv, Date.now());
  if (res.ok) {
    console.log(`✓ restarted — ${res.message}`);
    return;
  }
  console.error(`✗ ${res.message}`);
  if (res.logTail?.length) {
    console.error("  --- last log lines ---");
    for (const l of res.logTail) console.error(`  ${l}`);
  }
  process.exitCode = 1;
}
