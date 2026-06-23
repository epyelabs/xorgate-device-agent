/**
 * `xorgate set <key> <value>` — persist an agent setting and apply it.
 *
 * Supported keys: `mode` (<sim|real>) and `media` (<on|off>, the KVS WebRTC
 * runtime toggle). The value is merged into settings.json (read by loadConfig
 * with precedence flag > settings > env), then the daemon is restarted to apply
 * — reusing its recorded launch flags so creds / --offline are preserved.
 * `--no-restart` persists without restarting.
 */
import { loadSettings, saveSettings, type AgentSettings } from "../daemon/settings.js";
import { inspect, restart } from "../daemon/manager.js";

const USAGE = "usage: xorgate set <key> <value>   (supported: mode <sim|real>, media <on|off>)";

export async function setCommand(rest: string[]): Promise<void> {
  const noRestart = rest.includes("--no-restart");
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const key = positionals[0];
  const value = positionals[1];

  if (!key) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Merge onto existing settings so toggling one key never clobbers the other.
  const next: AgentSettings = { ...loadSettings() };
  let applied: string;

  if (key === "mode") {
    if (value !== "sim" && value !== "real") {
      console.error(`mode must be 'sim' or 'real', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.mode = value;
    applied = `mode set to ${value}`;
  } else if (key === "media") {
    if (value !== "on" && value !== "off") {
      console.error(`media must be 'on' or 'off', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.mediaEnabled = value === "on";
    applied = `media ${value} (KVS WebRTC runtime)`;
  } else {
    console.error(`unknown setting '${key}' (supported: mode, media)`);
    process.exitCode = 1;
    return;
  }

  saveSettings(next);
  console.log(`✓ ${applied} (persisted to settings.json)`);

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
