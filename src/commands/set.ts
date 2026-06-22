/**
 * `xorgate set <key> <value>` — persist an agent setting and apply it.
 *
 * Currently the only key is `mode` (<sim|real>). The value is written to
 * settings.json (read by loadConfig with precedence flag > settings > env), then
 * the daemon is restarted to apply — reusing its recorded launch flags so creds
 * / --offline are preserved. `--no-restart` persists without restarting.
 */
import { saveSettings } from "../daemon/settings.js";
import { inspect, restart } from "../daemon/manager.js";

export async function setCommand(rest: string[]): Promise<void> {
  const noRestart = rest.includes("--no-restart");
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const key = positionals[0];
  const value = positionals[1];

  if (!key) {
    console.error("usage: xorgate set <key> <value>   (supported: mode <sim|real>)");
    process.exitCode = 1;
    return;
  }
  if (key !== "mode") {
    console.error(`unknown setting '${key}' (supported: mode)`);
    process.exitCode = 1;
    return;
  }
  if (value !== "sim" && value !== "real") {
    console.error(`mode must be 'sim' or 'real', got '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  saveSettings({ mode: value });
  console.log(`✓ mode set to ${value} (persisted to settings.json)`);

  if (noRestart) {
    console.log("  --no-restart: applies on the next daemon start");
    return;
  }

  const status = await inspect();
  if (status.kind !== "running") {
    console.log("  daemon not running — applies on next start (xorgate start)");
    return;
  }

  // Restart with the running daemon's own launch flags so identity/creds/offline
  // carry over; loadConfig re-reads settings.json for the new mode.
  const res = await restart(status.record.argv);
  if (res.ok) {
    console.log(`  restarted to apply (pid ${res.pid})`);
  } else {
    console.error(`  could not restart automatically: ${res.message}`);
    console.error("  on systemd installs, run: sudo systemctl restart xorgate-agent");
    process.exitCode = 1;
  }
}
