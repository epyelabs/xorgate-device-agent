/**
 * `xorgate obd scan [--seconds N] [--json]` — list nearby Bluetooth devices
 * (never pairs; the operator reads the MAC off the table and sets it with
 * `xorgate set obd.adapter <MAC>` or from the console).
 * `xorgate obd status` — the agent's obd status line plus the last vehicle
 * profile summary, read from state.json (no helper is spawned).
 *
 * obd2-bluetooth-integration P3 (plan D3: "a CLI helper lists candidates,
 * never auto-pairs; parking lots are full of dongles"). Bench tool: the scan
 * runs the same `python/obd_scan.py` the `obd_scan` cloud command runs, so
 * what the console shows and what the terminal shows are the same list.
 */
import { OBD_SCAN_SECONDS, scanObdAdapters } from "../hardware/obd.js";
import { readState } from "../daemon/state.js";
import type { ObdStatus } from "../agent/telemetry.js";
import { obdStatusLine } from "./status.js";

const USAGE = `Usage: xorgate obd scan [--seconds N] [--json]
       xorgate obd status

scan    Bluetooth discovery for N seconds (default ${OBD_SCAN_SECONDS}, 1..120), strongest
        signal first, unnamed devices dropped. Never pairs. --json prints the
        exact candidate list the agent publishes in effective.obd.scan.
status  The agent's obd line (state, link, req/s, errors, forbidden, voltage,
        adapter) and the last vehicle profile the helper reported.`;

/** Pure: parse `obd` subcommand args. Exported for tests. */
export function parseObdArgs(rest: string[]):
  | { cmd: "scan"; seconds: number; json: boolean }
  | { cmd: "status" }
  | { cmd: "help" }
  | { cmd: "error"; message: string } {
  const [sub, ...args] = rest;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return { cmd: "help" };
  if (sub === "status") return { cmd: "status" };
  if (sub !== "scan") return { cmd: "error", message: `unknown obd subcommand '${sub}'` };
  let seconds = OBD_SCAN_SECONDS;
  const json = args.includes("--json");
  const i = args.indexOf("--seconds");
  const eq = args.find((a) => a.startsWith("--seconds="));
  const raw = i >= 0 ? args[i + 1] : eq?.slice("--seconds=".length);
  if (i >= 0 || eq !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 120) {
      return { cmd: "error", message: `--seconds must be 1..120, got '${raw ?? ""}'` };
    }
    seconds = n;
  }
  return { cmd: "scan", seconds, json };
}

/** Pure: the candidate table. Exported for tests. */
export function formatScanTable(candidates: { mac: string; name: string; rssi: number | null }[]): string {
  if (candidates.length === 0) return "no named Bluetooth devices found (is the adapter powered? ELM327 dongles need the car's OBD port live)";
  const lines = ["MAC                RSSI   NAME"];
  for (const c of candidates) {
    const rssi = c.rssi === null ? "   —" : `${c.rssi}`.padStart(4);
    lines.push(`${c.mac}  ${rssi}   ${c.name}`);
  }
  lines.push("", "pick the adapter by its label, then: xorgate set obd.adapter <MAC>   (never pairs by name)");
  return lines.join("\n");
}

function readObdStatus(): ObdStatus | null {
  try {
    return readState()?.obd ?? null;
  } catch {
    return null;
  }
}

export async function obdCommand(rest: string[]): Promise<void> {
  const parsed = parseObdArgs(rest);
  if (parsed.cmd === "help") {
    console.log(USAGE);
    return;
  }
  if (parsed.cmd === "error") {
    console.error(`obd: ${parsed.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (parsed.cmd === "status") {
    const obd = readObdStatus();
    if (!obd) {
      console.log("obd        (no obd collector: agent not running, or the hardware block declares no peripherals.obd)");
      return;
    }
    console.log(obdStatusLine(obd));
    if (obd.detail) console.log(`  detail     ${obd.detail}`);
    console.log(`  since      ${new Date(obd.since).toISOString()}`);
    console.log(`  helper     ${obd.helperVersion ?? "—"}`);
    if (obd.profile) console.log(`  profile    ${obd.profile}`);
    else console.log("  profile    — (no vehicle probed yet)");
    return;
  }
  console.error(`scanning for ${parsed.seconds} s (never pairs)…`);
  let candidates;
  try {
    candidates = await scanObdAdapters(parsed.seconds);
  } catch (err) {
    console.error(`obd scan failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.json) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  console.log(formatScanTable(candidates));
}
