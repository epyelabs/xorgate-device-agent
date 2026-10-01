/**
 * `xorgate sms [--limit N] [--json]` — read the modem's stored SMS locally.
 *
 * The same reader the agent's `read_sms` command uses (device-sms-inbox plan
 * §2.4), for bench work: non-destructive (`AT+CMGRO`, unread stays unread),
 * over the spare AT port, with CMGF / CPMS mem1 restored afterwards. It shares
 * the agent's lock file, so it never interleaves with a cloud-triggered sweep.
 *
 * This is a local operator tool and DOES print senders and text to the
 * terminal. Nothing here goes to journald.
 */
import { join } from "node:path";
import { runtimeHome } from "../daemon/runtime.js";
import {
  buildSmsPayload,
  clampSmsLimit,
  resolveSmsPort,
  SmsReader,
} from "../hardware/sms-modem.js";

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
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`Usage: xorgate sms [--limit N] [--json]

Read the SIM7600's stored SMS (SIM + modem storage), newest first, without
marking anything read. N is 1..50 (default 10). --json prints the exact
payload the agent publishes for a cloud read_sms request.
Port: the SIMCom interface-05 tty (override with XORGATE_SMS_PORT).`);
    return;
  }
  const raw = flagValue(rest, "--limit");
  const limit = clampSmsLimit(raw === undefined ? undefined : Number(raw));
  const json = rest.includes("--json");

  const reader = new SmsReader({ lockPath: join(runtimeHome(), "sms-reader.lock") });
  const sweep = await reader.read();
  const payload = buildSmsPayload(sweep, { deviceId: "local", requestId: "cli", limit });

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    if (payload.status !== "ok") process.exitCode = 1;
    return;
  }

  const port = resolveSmsPort() ?? "(none)";
  const stores = Object.entries(payload.storage)
    .map(([k, v]) => `${k} ${v.used}/${v.total}`)
    .join(", ");
  console.log(
    `sms: ${payload.status}${payload.error ? ` (${payload.error})` : ""} · port ${port} · ` +
      `${stores || "no stores"} · ${payload.total} message(s)` +
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
