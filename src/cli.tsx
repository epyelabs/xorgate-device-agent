#!/usr/bin/env node
/**
 * `xorgate` CLI dispatcher. Routes a subcommand to commands/*. Only `manage`
 * pulls in ink/React (dynamic import) so status/start/stop/set stay fast and
 * scriptable.
 *
 * The subcommand may appear before or after agent flags, so `xorgate --offline
 * start` and `xorgate start --offline` both work. Everything that isn't the
 * subcommand is forwarded to the agent (config flags like --device-id, --offline).
 */
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { updateCommand } from "./commands/update.js";
import { setCommand } from "./commands/set.js";
import { pipelineCommand } from "./commands/pipeline.js";
import { recordingCommand } from "./commands/recording.js";

const VERSION = "0.2.0";
/** Flags that take a value — skipped when locating the subcommand token. */
const VALUE_FLAGS = new Set([
  "--device-id",
  "--endpoint",
  "--mode",
  "--rate",
  "--cert",
  "--key",
  "--ca",
  "--tag",
  "--from",
]);

const argv = process.argv.slice(2);
const { cmd, rest } = splitCommand(argv);

/**
 * The subcommand is the first bare (non-flag) token that isn't the value of a
 * value-flag. This means `xorgate --device-id status start` correctly resolves
 * to `start` with device-id "status", instead of mistaking the flag value for
 * the command.
 */
function splitCommand(av: string[]): { cmd: string | undefined; rest: string[] } {
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value too
      continue;
    }
    if (a.startsWith("-")) continue; // boolean/unknown flag
    return { cmd: a, rest: [...av.slice(0, i), ...av.slice(i + 1)] };
  }
  return { cmd: undefined, rest: av };
}

async function main(): Promise<void> {
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(VERSION);
    return;
  }
  switch (cmd) {
    case "start":
      await startCommand(rest);
      break;
    case "stop":
      await stopCommand();
      break;
    case "restart":
      await restartCommand(rest);
      break;
    case "status":
      await statusCommand();
      break;
    case "logs":
      await logsCommand(rest);
      break;
    case "update":
      await updateCommand(rest);
      break;
    case "set":
      await setCommand(rest);
      break;
    case "pipeline":
      await pipelineCommand(rest);
      break;
    case "recording":
      await recordingCommand(rest);
      break;
    case "monitor": // deprecated alias for `manage`, kept working for one release
    case "manage": {
      if (cmd === "monitor") console.error("[xorgate] 'monitor' is deprecated; use 'manage'");
      const { manageCommand } = await import("./commands/manage.js");
      await manageCommand(rest);
      break;
    }
    case undefined:
    case "help":
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}

function usage(): void {
  console.log(`xorgate ${VERSION} — device telemetry agent + manager

Usage: xorgate <command> [agent flags]

Commands:
  start      Launch the telemetry agent as a background daemon
  stop       Gracefully stop the daemon
  restart    Stop then start
  status     Show whether the daemon is running (pid, uptime, connection, telemetry)
  manage     Open the live ink dashboard (start/stop/restart + Settings from inside)
  set        Persist a setting and apply it: 'set mode <sim|real>',
             'set wifi <on|off> [--force]' (runtime WiFi toggle via NetworkManager), or
             'set recording.<section>.<field> <value>' (on-device recording, applied live —
             e.g. 'set recording.telemetry.enabled on', 'set recording.telemetry.rateHz 10')
  pipeline   Manage per-stream KVS pipelines: 'pipeline list|show|set|clear <streamKey> [file]'
  recording  On-device recording maintenance: 'recording reset-counters' zeroes the
             cumulative droppedSegments counter (applied live, no restart)
  logs       Print the daemon log   (-f follow, -n N lines, --clear truncate)
  update     Fetch the latest agent build, install it, and restart the service
             (sudo; --tag <version> pins a build, --from <url> overrides the bucket)

Agent flags (forwarded to start/restart/manage):
  --offline              Run without AWS (stub mqtt + simulator) — no creds needed
  --device-id <uuid>     DEVICE_ID
  --endpoint <host>      IOT_DATA_ENDPOINT
  --mode <sim|real>      telemetry source (default sim)
  --rate <hz>            publish rate (default 1)

Env: XORGATE_HOME (runtime dir, default ~/.xorgate), DEVICE_ID, IOT_DATA_ENDPOINT,
     MODE, RATE_HZ, CERT_PATH, KEY_PATH, CA_PATH, OFFLINE.

Examples:
  xorgate --offline start && xorgate manage
  xorgate set mode real
  DEVICE_ID=<uuid> IOT_DATA_ENDPOINT=<host> xorgate start
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
