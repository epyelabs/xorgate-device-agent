/**
 * `xorgate sms [--limit N] [--json]` — read the modem's stored SMS locally.
 * `xorgate sms clear [--yes]` — delete them all (device-sms-clear plan).
 *
 * The same reader the agent's `read_sms` command uses (device-sms-inbox plan
 * §2.4), for bench work: non-destructive (`AT+CMGRO`, unread stays unread),
 * over the spare AT port, with CMGF / CPMS mem1 restored afterwards. It shares
 * the agent's lock file, so it never interleaves with a cloud-triggered sweep.
 *
 * This is a local operator tool and DOES print senders and text to the
 * terminal. Nothing here goes to journald. `clear` prints counts only.
 */
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runtimeHome } from "../daemon/runtime.js";
import {
  buildSmsPayload,
  clampSmsLimit,
  resolveSmsPort,
  SmsReader,
} from "../hardware/sms-modem.js";

function readerForCli(): SmsReader {
  return new SmsReader({ lockPath: join(runtimeHome(), "sms-reader.lock") });
}

function storesLine(storage: Record<string, { used: number; total: number }>): string {
  return (
    Object.entries(storage)
      .map(([k, v]) => `${k} ${v.used}/${v.total}`)
      .join(", ") || "no stores"
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * `xorgate sms clear [--yes]`: AT+CMGD=0,4 on SM then ME, then a sweep to
 * show the stores are empty. Irreversible, so it needs `--yes` or an
 * interactive y/N; without a TTY and without `--yes` it refuses.
 */
async function smsClearCommand(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: xorgate sms clear [--yes]

Delete EVERY stored SMS on the SIM7600 (SIM store SM, then modem store ME)
with AT+CMGD=0,4, then re-read the stores to show they are empty. Use it when
a full store (e.g. ME 23/23) stops new messages arriving. Irreversible.
Asks for confirmation unless --yes is given. Prints counts only.`);
    return;
  }
  if (!rest.includes("--yes") && !rest.includes("-y")) {
    if (!process.stdin.isTTY) {
      console.error("sms clear: refusing without --yes (no terminal to confirm on)");
      process.exitCode = 1;
      return;
    }
    if (!(await confirm("Delete ALL stored SMS on this modem (SIM and modem storage)? [y/N] "))) {
      console.log("sms clear: cancelled");
      return;
    }
  }
  const sweep = await readerForCli().clear();
  const payload = buildSmsPayload(sweep, { deviceId: "local", requestId: "cli", limit: 1, action: "clear" });
  const cleared =
    Object.entries(payload.cleared ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "nothing";
  console.log(
    `sms clear: ${payload.status}${payload.error ? ` (${payload.error})` : ""} · cleared ${cleared} · ` +
      `now ${storesLine(payload.storage)} · ${payload.durationMs} ms`,
  );
  if (payload.status !== "ok") process.exitCode = 1;
}

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i >= 0) return rest[i + 1];
  const eq = rest.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/[\r\n\f\t]+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function smsCommand(rest: string[]): Promise<void> {
  if (rest[0] === "clear") return smsClearCommand(rest.slice(1));
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: xorgate sms [--limit N] [--json]
       xorgate sms clear [--yes]

Read the SIM7600's stored SMS (SIM + modem storage), newest first, without
marking anything read. N is 1..50 (default 10). --json prints the exact
payload the agent publishes for a cloud read_sms request.
'clear' deletes every stored SMS (see 'xorgate sms clear --help').
Port: the SIMCom interface-05 tty (override with XORGATE_SMS_PORT).`);
    return;
  }
  const raw = flagValue(rest, "--limit");
  const limit = clampSmsLimit(raw === undefined ? undefined : Number(raw));
  const json = rest.includes("--json");

  const sweep = await readerForCli().read();
  const payload = buildSmsPayload(sweep, { deviceId: "local", requestId: "cli", limit });

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    if (payload.status !== "ok") process.exitCode = 1;
    return;
  }

  const port = resolveSmsPort() ?? "(none)";
  console.log(
    `sms: ${payload.status}${payload.error ? ` (${payload.error})` : ""} · port ${port} · ` +
      `${storesLine(payload.storage)} · ${payload.total} message(s)` +
      `${payload.skipped ? `, ${payload.skipped} skipped` : ""}` +
      `${payload.partial ? " · PARTIAL (budget ran out)" : ""} · ${payload.durationMs} ms`,
  );
  if (payload.status !== "ok") {
    process.exitCode = 1;
    return;
  }
  if (payload.messages.length === 0) return;

  const width = Math.max(40, (process.stdout.columns ?? 120) - 70);
  const rows = payload.messages.map((m) => [
    m.id,
    m.unread ? "unread" : "read",
    m.sentAt ?? "?",
    oneLine(m.from, 18),
    oneLine(
      `${m.binary ? "[binary] " : ""}${m.incomplete ? "[incomplete] " : ""}${m.text}${m.truncated ? " [truncated]" : ""}`,
      width,
    ),
  ]);
  const head = ["ID", "STATUS", "SENT", "FROM", "TEXT"];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const fmt = (r: string[]): string =>
    r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join("  ");
  console.log(fmt(head));
  for (const r of rows) console.log(fmt(r));
  if (payload.total > payload.messages.length) {
    console.log(`(${payload.total - payload.messages.length} older not shown; --limit up to 50)`);
  }
}
