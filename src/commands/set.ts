/**
 * `xorgate set <key> <value>` — persist an agent setting and apply it.
 *
 * Supported keys: `mode` (<sim|real>), `media` (<on|off>, the KVS WebRTC
 * runtime toggle), and `gps-antenna` (<active|passive>, the GNSS antenna bias).
 * The value is merged into settings.json (read by loadConfig with precedence
 * flag > settings > env), then the daemon is restarted to apply — reusing its
 * recorded launch flags so creds / --offline are preserved. `--no-restart`
 * persists without restarting. `gps-antenna` needs no restart at all: the
 * sim7600-lte daemon polls settings.json and applies the bias live.
 *
 * `wifi` (<on|off>) is different: it toggles the OS WiFi device at runtime via
 * NetworkManager (not settings.json, no daemon restart). It refuses to cut the
 * uplink you're connected over unless `--force` is given.
 */
import { loadSettings, saveSettings, type AgentSettings } from "../daemon/settings.js";
import { inspect, restart } from "../daemon/manager.js";
import { setWifi } from "../daemon/radios.js";
import {
  detectWifi,
  ifaceForIp,
  interfaceStatuses,
  sshServerIp,
} from "../hardware/network.js";

const USAGE =
  "usage: xorgate set <key> <value>   (supported: mode <sim|real>, media <on|off>, gps-antenna <active|passive>, wifi <on|off> [--force])";

export async function setCommand(rest: string[]): Promise<void> {
  const noRestart = rest.includes("--no-restart");
  const force = rest.includes("--force");
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const key = positionals[0];
  const value = positionals[1];

  if (!key) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // WiFi is an OS-level runtime toggle: handle it before the settings.json path.
  if (key === "wifi") {
    await setWifiCommand(value, force);
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
  } else if (key === "gps-antenna") {
    if (value !== "active" && value !== "passive") {
      console.error(`gps-antenna must be 'active' or 'passive', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.gnssAntBias = value === "active";
    saveSettings(next);
    // No daemon restart: the sim7600-lte daemon polls settings.json and toggles
    // the antenna bias live (and asserts it at boot).
    console.log(
      `✓ GPS antenna set to ${value} (bias ${value === "active" ? "on" : "off"}, persisted to settings.json)`,
    );
    console.log("  the modem daemon applies it live within ~a minute (journalctl -u sim7600-lte)");
    return;
  } else {
    console.error(`unknown setting '${key}' (supported: mode, media, gps-antenna, wifi)`);
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

/**
 * `xorgate set wifi <on|off> [--force]`. Toggles the WiFi device at runtime via
 * NetworkManager. Without `--force`, refuses to turn it off when doing so would
 * cut your own session — i.e. the WiFi device carries your SSH connection, or it
 * is currently the only interface with internet.
 */
async function setWifiCommand(value: string | undefined, force: boolean): Promise<void> {
  if (value !== "on" && value !== "off") {
    console.error(`wifi must be 'on' or 'off', got '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const wifi = await detectWifi();
  if (!wifi.present) {
    console.error("wifi: no WiFi adapter detected on this device");
    process.exitCode = 1;
    return;
  }
  const device = wifi.device ?? "wlan0";

  if (value === "off" && !force) {
    const sshIface = ifaceForIp(sshServerIp(process.env.SSH_CONNECTION));
    const overSsh = sshIface === device;
    const online = (await interfaceStatuses()).filter((s) => s.state === "online");
    const onlyUplink = online.length === 1 && online[0].name === device;
    if (overSsh || onlyUplink) {
      const why = overSsh
        ? `your SSH session is over ${device}`
        : `${device} is currently your only internet connection`;
      console.error(`refusing to turn WiFi off: ${why}.`);
      console.error("re-run with --force if you're sure (you may lose connectivity).");
      process.exitCode = 1;
      return;
    }
  }

  const res = await setWifi(value === "on");
  if (res.ok) {
    console.log(`✓ ${res.message}`);
  } else {
    console.error(res.message);
    process.exitCode = 1;
  }
}
