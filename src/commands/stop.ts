/** `xorgate stop` — gracefully stop the daemon (idempotent). */
import { stop } from "../daemon/manager.js";

export async function stopCommand(): Promise<void> {
  const res = await stop(Date.now());
  console.log(`${res.ok ? "✓" : "✗"} ${res.message}`);
  if (!res.ok) process.exitCode = 1;
}
