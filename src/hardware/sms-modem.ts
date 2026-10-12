/**
 * SMS reader over the SIM7600's spare AT port (device-sms-inbox plan §2.1-2.2).
 *
 * Why ttyUSB3 and not the AT port: `modem/sim7600-lte.sh` (root) owns
 * `/dev/ttyUSB2` (interface 04) with no lock — its guarantee is "one process,
 * one loop", and a second writer there would interleave with its probes. The
 * modem exposes a second, independent AT parser on interface 05 (the PPP
 * "modem" port), which nothing uses because data rides RNDIS `usb0`. So this
 * module resolves THAT port by USB identity and never touches ttyUSB2.
 *
 * Reads are non-destructive by construction:
 *   - reads use `AT+CMGRO` (SIMCom "read only"), which leaves REC UNREAD as is;
 *     `AT+CMGR`/`AT+CMGL` would flip messages to REC READ, so they are never
 *     sent. A read deletes nothing and writes nothing to the SIM.
 *   - the only settings touched are `CMGF` (per channel on SIMCom) and `CPMS`
 *     mem1; both are read first and restored in `finally`.
 *
 * The one destructive operation is the explicit clear (`clear_sms`,
 * plans/device-sms-clear): `AT+CMGD=0,4` per store, then a normal sweep. It
 * runs only through `SmsReader.clear()` / `clearTransport()`, never from a read.
 *
 * Privacy (contract §6): this module never logs. Callers log counts/status only.
 */
import {
  closeSync,
  constants as fsc,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { run } from "../lib/exec.js";
import { assembleMessages, type SmsMessage, type SmsStorage, type StoredPdu } from "./sms-pdu.js";

export type SmsReadStatus = "ok" | "no_modem" | "no_sim" | "modem_busy" | "error";

export interface StoreCount {
  used: number;
  total: number;
}

/** A finished sweep, before any per-request `limit` cut. */
export interface SmsSweep {
  status: SmsReadStatus;
  error: string | null;
  /** Epoch ms the sweep finished. */
  finishedAt: number;
  durationMs: number;
  storage: Partial<Record<SmsStorage, StoreCount>>;
  skipped: number;
  partial: boolean;
  /** All messages, newest first. */
  messages: SmsMessage[];
  /**
   * Clear only (device-sms-clear contract §2): messages present in each store
   * right before its delete. A store the modem does not have is absent.
   */
  cleared?: Partial<Record<SmsStorage, number>>;
}

// ---------------------------------------------------------------------------
// Port resolution
// ---------------------------------------------------------------------------

export const SIMCOM_VENDOR_ID = "1e0e";
export const SMS_INTERFACE_NUMBER = "05";

export interface ResolvePortOptions {
  sysClassTty?: string;
  devDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The `ttyUSB*` whose USB interface is 05 on a SIMCom (1e0e) device, or the
 * `XORGATE_SMS_PORT` override. Null when there is no such port.
 *
 * By identity, not name: ttyUSB numbering follows enumeration order, and a
 * modem that re-enumerates in another composition would otherwise point us
 * at the daemon's port.
 */
export function resolveSmsPort(opts: ResolvePortOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const override = env.XORGATE_SMS_PORT?.trim();
  if (override) return override;
  const sys = opts.sysClassTty ?? "/sys/class/tty";
  const dev = opts.devDir ?? "/dev";
  let names: string[];
  try {
    names = readdirSync(sys).filter((n) => /^ttyUSB\d+$/.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  for (const n of names) {
    try {
      const ifnum = readFileSync(`${sys}/${n}/device/../bInterfaceNumber`, "utf8").trim();
      const vid = readFileSync(`${sys}/${n}/device/../../idVendor`, "utf8").trim().toLowerCase();
      if (ifnum === SMS_INTERFACE_NUMBER && vid === SIMCOM_VENDOR_ID) return `${dev}/${n}`;
    } catch {
      /* not a USB serial with the attributes we need */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transport + AT session
// ---------------------------------------------------------------------------

/** Line-oriented serial I/O. Injectable so the sweep is testable with a fake modem. */
export interface AtTransport {
  write(data: string): Promise<void>;
  /** Register the single line consumer; lines arrive without CR/LF, blanks dropped. */
  onLine(cb: (line: string) => void): void;
  close(): Promise<void>;
}

export class SmsReadError extends Error {
  constructor(
    readonly status: Exclude<SmsReadStatus, "ok">,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Open the tty for AT traffic. Never creates the node: it must already exist
 * as a character device (the daemon's `[[ -c ]]` lesson; opening a missing
 * /dev path with a create flag would leave a regular file behind).
 *
 * `min 0 time 1` makes each read() return after at most 100 ms, so the read
 * loop can notice `close()` and exit instead of leaving a libuv threadpool
 * thread parked in a blocking read forever.
 */
export async function openSerialTransport(path: string): Promise<AtTransport> {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new SmsReadError("no_modem", "sms port not present");
  }
  if (!st.isCharacterDevice()) throw new SmsReadError("no_modem", "sms port is not a character device");
  const stty = await run("stty", ["-F", path, "raw", "-echo", "min", "0", "time", "1"], { timeoutMs: 3000 });
  if (stty.failed) {
    if (/busy/i.test(stty.stderr)) throw new SmsReadError("modem_busy", "sms port busy");
    if (/no such/i.test(stty.stderr)) throw new SmsReadError("no_modem", "sms port vanished");
    throw new SmsReadError("error", `stty failed: ${stty.stderr.trim().slice(0, 120)}`);
  }
  let fh: FileHandle;
  try {
    fh = await open(path, fsc.O_RDWR | fsc.O_NOCTTY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENODEV" || code === "ENXIO") throw new SmsReadError("no_modem", "sms port vanished");
    if (code === "EBUSY") throw new SmsReadError("modem_busy", "sms port busy");
    if (code === "EACCES") throw new SmsReadError("error", "permission denied on sms port");
    throw new SmsReadError("error", `open failed: ${code ?? "unknown"}`);
  }

  let consumer = null as ((line: string) => void) | null;
  let closed = false;
  let buf = "";
  const loop = (async () => {
    const chunk = Buffer.alloc(4096);
    while (!closed) {
      let n: number;
      try {
        ({ bytesRead: n } = await fh.read(chunk, 0, chunk.length, null));
      } catch {
        break; // node vanished (modem reset): the session times out and reports error
      }
      if (n === 0) continue; // VTIME tick, no data
      buf += chunk.toString("latin1", 0, n);
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const l of parts) if (l.trim().length > 0) consumer?.(l.trim());
    }
  })();

  return {
    async write(data: string) {
      if (closed) throw new SmsReadError("error", "transport closed");
      await fh.write(data, null, "latin1");
    },
    onLine(cb) {
      consumer = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      await loop;
      await fh.close().catch(() => {});
    },
  };
}

export interface AtResponse {
  ok: boolean;
  /** Final result line (`OK`, `ERROR`, `+CMS ERROR: 321`, …). */
  final: string;
  /** Lines that belong to this command (see `command`). */
  lines: string[];
}

export class AtTimeoutError extends Error {}

const FINAL_RE = /^(OK|ERROR|\+CM[SE] ERROR:.*|NO CARRIER)$/;

/**
 * Serialises AT commands over a transport and keeps only the lines that belong
 * to the command in flight. Everything else — `+CMTI:`, `+SMS FULL`, `RDY`,
 * `SMS DONE`, echoes — is dropped: a response line must start with the
 * caller's `prefix`, and for `+CMGRO` the hex line right after the header is
 * taken as its PDU.
 */
export class AtSession {
  private pending: {
    prefix: string | null;
    withPdu: boolean;
    lines: string[];
    expectPdu: boolean;
    resolve: (r: AtResponse) => void;
  } | null = null;

  constructor(
    private readonly transport: AtTransport,
    private readonly timeoutMs = 3000,
  ) {
    transport.onLine((line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const p = this.pending;
    if (!p) return; // unsolicited, nobody asked
    if (FINAL_RE.test(line)) {
      this.pending = null;
      p.resolve({ ok: line === "OK", final: line, lines: p.lines });
      return;
    }
    if (p.expectPdu) {
      p.expectPdu = false;
      if (/^[0-9A-Fa-f]+$/.test(line)) {
        p.lines.push(line);
        return;
      }
    }
    if (p.prefix !== null && line.startsWith(p.prefix)) {
      p.lines.push(line);
      if (p.withPdu) p.expectPdu = true;
    }
  }

  /**
   * Send `cmd` and wait for its final result code. Rejects with AtTimeoutError
   * after `timeoutMs` (default: the session's), e.g. longer for a slow CMGD.
   */
  async command(
    cmd: string,
    prefix: string | null = null,
    withPdu = false,
    timeoutMs: number = this.timeoutMs,
  ): Promise<AtResponse> {
    if (this.pending) throw new Error("AT command already in flight");
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<AtResponse>((resolve, reject) => {
      this.pending = { prefix, withPdu, lines: [], expectPdu: false, resolve };
      timer = setTimeout(() => {
        this.pending = null;
        reject(new AtTimeoutError(`timeout on ${cmd.split("=")[0]}`));
      }, timeoutMs);
    });
    try {
      await this.transport.write(`${cmd}\r`);
      return await done;
    } catch (err) {
      this.pending = null;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** `+CPMS: "SR",0,0,"ME",23,23,"ME",23,23` -> three (mem, used, total) triples. */
export function parseCpmsQuery(line: string): { mem: string; used: number; total: number }[] {
  const body = line.replace(/^\+CPMS:\s*/, "");
  const out: { mem: string; used: number; total: number }[] = [];
  const re = /"([A-Z]+)"\s*,\s*(\d+)\s*,\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push({ mem: m[1]!, used: Number(m[2]), total: Number(m[3]) });
  return out;
}

/** `+CPMS: 7,40,23,23,23,23` (answer to a set) -> mem1 used/total. */
function parseCpmsSet(line: string): StoreCount | null {
  const m = /^\+CPMS:\s*(\d+)\s*,\s*(\d+)/.exec(line);
  return m ? { used: Number(m[1]), total: Number(m[2]) } : null;
}

/** SIM-absent / SIM-not-ready errors (27.005 +CMS 310-315, 27.007 +CME 10/13/14). */
function isNoSim(final: string): boolean {
  const m = /^\+(CMS|CME) ERROR:\s*(\d+)/.exec(final);
  if (!m) return /SIM not inserted|SIM failure|SIM busy/i.test(final);
  const code = Number(m[2]);
  return m[1] === "CMS" ? code >= 310 && code <= 315 : code === 10 || code === 13 || code === 14;
}

export interface SweepOptions {
  /** Per-command timeout (plan: 3 s). */
  commandTimeoutMs?: number;
  /** Whole-sweep budget before returning `partial` (plan: 20 s). */
  budgetMs?: number;
  now?: () => number;
}

export const SWEEP_STORES: readonly SmsStorage[] = ["SM", "ME"];

/**
 * Run §2.2's sequence over an open transport. Does not close it.
 * Throws SmsReadError for whole-sweep failures; returns a partial result when
 * the budget runs out mid-scan.
 */
export async function sweepTransport(
  transport: AtTransport,
  opts: SweepOptions = {},
): Promise<Omit<SmsSweep, "finishedAt" | "durationMs" | "status" | "error">> {
  const now = opts.now ?? Date.now;
  const start = now();
  const budget = opts.budgetMs ?? 20_000;
  const at = new AtSession(transport, opts.commandTimeoutMs ?? 3000);

  try {
    await at.command("ATE0");
  } catch (err) {
    if (err instanceof AtTimeoutError) throw new SmsReadError("modem_busy", "no response on sms port");
    throw err;
  }

  const cmgf = await at.command("AT+CMGF?", "+CMGF:");
  const origCmgf = cmgf.ok ? Number(/\+CMGF:\s*(\d)/.exec(cmgf.lines[0] ?? "")?.[1] ?? NaN) : NaN;
  const cpms = await at.command("AT+CPMS?", "+CPMS:");
  if (!cpms.ok) {
    if (isNoSim(cpms.final)) throw new SmsReadError("no_sim", "sim not ready");
    throw new SmsReadError("error", `CPMS? failed: ${cpms.final}`);
  }
  const triples = parseCpmsQuery(cpms.lines[0] ?? "");
  if (triples.length === 0) throw new SmsReadError("error", "unparseable CPMS? answer");
  const origMem1 = triples[0]!.mem;

  const storage: Partial<Record<SmsStorage, StoreCount>> = {};
  // mem1..mem3 can repeat a store; any mention gives its counts.
  for (const t of triples) {
    if (t.mem === "SM" || t.mem === "ME") storage[t.mem] = { used: t.used, total: t.total };
  }

  const records: StoredPdu[] = [];
  let partial = false;
  let mem1Changed = false;
  let cmgfChanged = false;
  try {
    if (origCmgf !== 0) {
      const set = await at.command("AT+CMGF=0");
      if (!set.ok) throw new SmsReadError("error", `CMGF=0 failed: ${set.final}`);
      cmgfChanged = true;
    }
    scan: for (const mem of SWEEP_STORES) {
      if (now() - start > budget) {
        partial = true;
        break;
      }
      const known = storage[mem];
      if (known && known.used === 0) continue;
      const sel = await at.command(`AT+CPMS="${mem}"`, "+CPMS:");
      mem1Changed = true;
      if (!sel.ok) {
        // SM missing on a SIM-less modem is not fatal while ME is readable.
        if (mem === "SM" && isNoSim(sel.final)) continue;
        throw new SmsReadError("error", `CPMS="${mem}" failed: ${sel.final}`);
      }
      const counts = parseCpmsSet(sel.lines[0] ?? "") ?? known;
      if (!counts) continue;
      storage[mem] = counts;
      if (counts.used === 0) continue;
      let found = 0;
      // Indexes are 0-based on the SIM7600; one extra probe covers a 1-based
      // store at negligible cost (an empty slot answers ERROR in ~50 ms).
      for (let i = 0; i <= counts.total && found < counts.used; i++) {
        if (now() - start > budget) {
          partial = true;
          break scan;
        }
        let r: AtResponse;
        try {
          r = await at.command(`AT+CMGRO=${i}`, "+CMGRO:", true);
        } catch (err) {
          if (err instanceof AtTimeoutError) {
            partial = true;
            break scan;
          }
          throw err;
        }
        if (!r.ok || r.lines.length < 2) continue; // empty slot
        const hm = /^\+CMGRO:\s*(\d+)\s*,[^,]*,\s*(\d+)/.exec(r.lines[0]!);
        found++;
        records.push({
          storage: mem,
          index: i,
          stat: hm ? Number(hm[1]) : 1,
          length: hm ? Number(hm[2]) : undefined,
          pdu: r.lines[1]!,
        });
      }
    }
  } finally {
    // Restore what the daemon and any other user of the modem expect. Errors
    // here must not mask the sweep's own outcome.
    if (mem1Changed) await at.command(`AT+CPMS="${origMem1}"`, "+CPMS:").catch(() => undefined);
    if (cmgfChanged && Number.isFinite(origCmgf)) {
      await at.command(`AT+CMGF=${origCmgf}`).catch(() => undefined);
    }
  }

  const { messages, skipped } = assembleMessages(records);
  return { storage, skipped, partial, messages };
}

// ---------------------------------------------------------------------------
// The clear (plans/device-sms-clear)
// ---------------------------------------------------------------------------

/**
 * Per-store delete timeout. `AT+CMGD=0,4` erases flash/SIM records one by
 * one; a full ME (23) or SIM (40) store can take several seconds, so the 3 s
 * read timeout would cut a delete that is still working.
 */
export const SMS_DELETE_TIMEOUT_MS = 25_000;

export interface ClearOptions {
  /** Per-command timeout for everything but the delete (plan: 3 s). */
  commandTimeoutMs?: number;
  /** Timeout for each `AT+CMGD=0,4` (default SMS_DELETE_TIMEOUT_MS). */
  deleteTimeoutMs?: number;
}

export interface ClearOutcome {
  /** Messages present in each store right before its delete. */
  cleared: Partial<Record<SmsStorage, number>>;
  /** Null when every store that had messages answered CMGD with OK. */
  deleteError: string | null;
}

/**
 * Delete every message in SM, then ME, over an open transport. Does not
 * close it and does not sweep (the caller runs `sweepTransport` next on the
 * same transport, so the reply proves the stores are empty).
 *
 * Throws SmsReadError ONLY before anything was deleted (no answer, no SIM,
 * unreadable CPMS?), which maps to the contract's "nothing was deleted"
 * statuses. Once deleting starts, a failing store is recorded in
 * `deleteError` (naming the store) and the next store is still tried; a
 * timed-out delete stops the phase, since a late OK could otherwise be taken
 * as the answer to the next command.
 *
 * A store already known to be empty is not selected or deleted (cleared 0).
 * `CMGD` with delflag 4 works in text and PDU mode alike, so CMGF is never
 * changed here; CPMS mem1 is restored in `finally` even when a delete fails.
 */
export async function clearTransport(transport: AtTransport, opts: ClearOptions = {}): Promise<ClearOutcome> {
  const at = new AtSession(transport, opts.commandTimeoutMs ?? 3000);
  const deleteTimeout = opts.deleteTimeoutMs ?? SMS_DELETE_TIMEOUT_MS;

  try {
    await at.command("ATE0");
  } catch (err) {
    if (err instanceof AtTimeoutError) throw new SmsReadError("modem_busy", "no response on sms port");
    throw err;
  }
  const cpms = await at.command("AT+CPMS?", "+CPMS:");
  if (!cpms.ok) {
    if (isNoSim(cpms.final)) throw new SmsReadError("no_sim", "sim not ready");
    throw new SmsReadError("error", `CPMS? failed: ${cpms.final}`);
  }
  const triples = parseCpmsQuery(cpms.lines[0] ?? "");
  if (triples.length === 0) throw new SmsReadError("error", "unparseable CPMS? answer");
  const origMem1 = triples[0]!.mem;
  const known: Partial<Record<SmsStorage, StoreCount>> = {};
  for (const t of triples) {
    if (t.mem === "SM" || t.mem === "ME") known[t.mem] = { used: t.used, total: t.total };
  }

  const cleared: Partial<Record<SmsStorage, number>> = {};
  const failures: string[] = [];
  let mem1Changed = false;
  try {
    for (const mem of SWEEP_STORES) {
      if (known[mem]?.used === 0) {
        cleared[mem] = 0;
        continue;
      }
      let sel: AtResponse;
      try {
        sel = await at.command(`AT+CPMS="${mem}"`, "+CPMS:");
      } catch (err) {
        if (!(err instanceof AtTimeoutError)) throw err;
        mem1Changed = true; // it may have switched before going quiet
        failures.push(`delete ${mem} failed (select timeout)`);
        break;
      }
      mem1Changed = true;
      if (!sel.ok) {
        // SM missing on a SIM-less modem: nothing there to clear.
        if (mem === "SM" && isNoSim(sel.final)) continue;
        failures.push(`delete ${mem} failed (select: ${sel.final})`);
        continue;
      }
      const counts = parseCpmsSet(sel.lines[0] ?? "") ?? known[mem];
      cleared[mem] = counts?.used ?? 0;
      // An unparseable select answer gives no count: delete anyway, it is
      // what the operator asked for and CMGD on an empty store is harmless.
      if (counts && counts.used === 0) continue;
      let del: AtResponse;
      try {
        del = await at.command("AT+CMGD=0,4", null, false, deleteTimeout);
      } catch (err) {
        if (!(err instanceof AtTimeoutError)) throw err;
        failures.push(`delete ${mem} failed (timeout)`);
        break;
      }
      if (!del.ok) failures.push(`delete ${mem} failed (${del.final})`);
    }
  } finally {
    if (mem1Changed) await at.command(`AT+CPMS="${origMem1}"`, "+CPMS:").catch(() => undefined);
  }
  return { cleared, deleteError: failures.length > 0 ? failures.join("; ") : null };
}

// ---------------------------------------------------------------------------
// Reader: single in-flight sweep + reuse window
// ---------------------------------------------------------------------------

export const SMS_REUSE_WINDOW_MS = 5000;

/**
 * Cross-process lock so `xorgate sms` on the box and the agent's `read_sms`
 * never interleave commands on the same tty. `wx` create + pid; a lock whose
 * pid is gone is stale and taken over. Returns a release fn, or null when a
 * live process holds it.
 */
export function acquireSmsLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return () => {}; // can't lock: proceed unlocked
      let pid = NaN;
      try {
        pid = Number(readFileSync(path, "utf8").trim());
      } catch {
        /* raced with a release */
      }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) return null;
      try {
        unlinkSync(path);
      } catch {
        /* someone else cleaned it */
      }
    }
  }
  return null;
}

export interface SmsReaderDeps {
  /** Cross-process lock file; null/undefined = no lock (tests). */
  lockPath?: string | null;
  resolvePort?: () => string | null;
  openTransport?: (path: string) => Promise<AtTransport>;
  now?: () => number;
  sweep?: SweepOptions;
  clear?: ClearOptions;
  reuseWindowMs?: number;
}

type SmsOp = "read" | "clear";
type OpResult = Partial<SmsSweep> & Pick<SmsSweep, "status" | "error">;

/**
 * One modem operation at a time per process (plus the cross-process lock).
 *
 * Reads: concurrent callers join the running read, and a caller within
 * `reuseWindowMs` of the last read's finish gets that result instead of a
 * fresh modem round (the plan's "one sweep per 5 s" rate limit).
 *
 * Clears: concurrent clears join the running (or queued) clear, same effect.
 * A clear never joins a running READ (its result predates the delete): it
 * queues behind the read and runs next. A read arriving while a clear is
 * running or queued waits for it and then sweeps afresh. A clear drops the
 * cached read (when requested and again when it starts), so nothing from
 * before the delete is ever served again.
 */
export class SmsReader {
  private inflight: { op: SmsOp; p: Promise<SmsSweep> } | null = null;
  private last: SmsSweep | null = null;

  constructor(private readonly deps: SmsReaderDeps = {}) {}

  read(): Promise<SmsSweep> {
    const cur = this.inflight;
    if (cur?.op === "read") return cur.p;
    // A clear is running or queued: wait for it, then sweep afresh.
    if (cur) return cur.p.then(() => this.read());
    const now = this.deps.now ?? Date.now;
    const window = this.deps.reuseWindowMs ?? SMS_REUSE_WINDOW_MS;
    if (this.last && now() - this.last.finishedAt < window) return Promise.resolve(this.last);
    return this.track("read", this.runOp("read", (t) => this.sweepBody(t)));
  }

  /** Delete every stored message (SM, then ME), then sweep. Destructive. */
  clear(): Promise<SmsSweep> {
    const cur = this.inflight;
    if (cur?.op === "clear") return cur.p;
    this.last = null;
    // Queued behind a running read, the clear becomes the in-flight tail at
    // once, so a read requested meanwhile waits for it instead of joining
    // the (pre-clear) read.
    const run = (): Promise<SmsSweep> => {
      this.last = null; // the read we waited for may have just cached itself
      return this.runOp("clear", (t) => this.clearBody(t));
    };
    return this.track("clear", cur ? cur.p.then(run) : run());
  }

  private track(op: SmsOp, run: Promise<SmsSweep>): Promise<SmsSweep> {
    const p: Promise<SmsSweep> = run.finally(() => {
      if (this.inflight?.p === p) this.inflight = null;
    });
    this.inflight = { op, p };
    return p;
  }

  private async sweepBody(t: AtTransport): Promise<OpResult> {
    const r = await sweepTransport(t, { now: this.deps.now, ...this.deps.sweep });
    return { status: "ok", error: null, ...r };
  }

  /**
   * Delete, then sweep on the same transport and lock. Once a delete may have
   * happened, every failure is `error` (contract §2: no_modem/no_sim/
   * modem_busy mean nothing was deleted), and a failed delete wins over a
   * clean sweep: the reply still carries the post-delete storage counts.
   */
  private async clearBody(t: AtTransport): Promise<OpResult> {
    const { cleared, deleteError } = await clearTransport(t, this.deps.clear);
    try {
      const r = await sweepTransport(t, { now: this.deps.now, ...this.deps.sweep });
      return { ...r, status: deleteError ? "error" : "ok", error: deleteError, cleared };
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 120) : "unknown";
      return { status: "error", error: deleteError ?? `post-clear read failed: ${why}`, cleared };
    }
  }

  private async runOp(op: SmsOp, body: (t: AtTransport) => Promise<OpResult>): Promise<SmsSweep> {
    const now = this.deps.now ?? Date.now;
    const start = now();
    const finish = (r: OpResult): SmsSweep => {
      const end = now();
      const sweep: SmsSweep = {
        storage: {},
        skipped: 0,
        partial: false,
        messages: [],
        ...(op === "clear" ? { cleared: {} } : {}),
        ...r,
        finishedAt: end,
        durationMs: end - start,
      };
      // Only reads feed the reuse window; a clear's result is never replayed
      // as the answer to a later read.
      if (op === "read") this.last = sweep;
      return sweep;
    };
    const port = (this.deps.resolvePort ?? resolveSmsPort)();
    if (!port) return finish({ status: "no_modem", error: "no SIMCom interface 05 tty" });
    const release = this.deps.lockPath ? acquireSmsLock(this.deps.lockPath) : () => {};
    if (!release) return finish({ status: "modem_busy", error: "another sms read is running" });
    let transport: AtTransport | null = null;
    try {
      transport = await (this.deps.openTransport ?? openSerialTransport)(port);
      return finish(await body(transport));
    } catch (err) {
      if (err instanceof SmsReadError) return finish({ status: err.status, error: err.message });
      if (err instanceof AtTimeoutError) return finish({ status: "error", error: err.message });
      return finish({ status: "error", error: (err as Error).message?.slice(0, 120) ?? "unknown" });
    } finally {
      await transport?.close().catch(() => {});
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// Wire payload (contract §2)
// ---------------------------------------------------------------------------

export const SMS_LIMIT_DEFAULT = 10;
export const SMS_LIMIT_MAX = 50;

/** Contract §1: integer 1..50, missing/invalid -> 10. */
export function clampSmsLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return SMS_LIMIT_DEFAULT;
  return Math.min(SMS_LIMIT_MAX, Math.max(1, Math.trunc(v)));
}

export type SmsAction = "read" | "clear";

export interface SmsResultPayload {
  v: 1;
  deviceId: string;
  requestId: string;
  ts: number;
  /** device-sms-clear contract §2; absent means "read" for older agents. */
  action: SmsAction;
  status: SmsReadStatus;
  error: string | null;
  durationMs: number;
  storage: Partial<Record<SmsStorage, StoreCount>>;
  total: number;
  skipped: number;
  partial: boolean;
  messages: SmsMessage[];
  /** Clear only: messages present in each store before its delete. */
  cleared?: Partial<Record<SmsStorage, number>>;
}

/**
 * Serialized-size ceiling for one result. AWS IoT rejects messages over
 * 128 KB; 50 messages x 4000 chars of multi-byte text can exceed that (a
 * 4000-unit emoji body is 8 KB of UTF-8), so the oldest messages are dropped
 * from the cut until it fits, and `partial` is set (contract §2 note).
 * In practice the modem holds ~63 PDUs and real payloads are a few KB.
 */
export const SMS_PAYLOAD_MAX_BYTES = 120 * 1024;

export interface SmsPayloadRequest {
  deviceId: string;
  requestId: string;
  limit: number;
  /** Default "read". */
  action?: SmsAction;
}

export function buildSmsPayload(sweep: SmsSweep, req: SmsPayloadRequest): SmsResultPayload {
  const p = buildUncapped(sweep, req);
  let size = Buffer.byteLength(JSON.stringify(p));
  while (size > SMS_PAYLOAD_MAX_BYTES && p.messages.length > 0) {
    const dropped = p.messages.pop()!;
    size -= Buffer.byteLength(JSON.stringify(dropped)) + 1;
    p.partial = true;
  }
  return p;
}

function buildUncapped(sweep: SmsSweep, req: SmsPayloadRequest): SmsResultPayload {
  const ok = sweep.status === "ok";
  const action = req.action ?? "read";
  return {
    v: 1,
    deviceId: req.deviceId,
    requestId: req.requestId,
    ts: sweep.finishedAt,
    action,
    status: sweep.status,
    error: ok ? null : sweep.error ?? sweep.status,
    durationMs: sweep.durationMs,
    storage: sweep.storage,
    total: ok ? sweep.messages.length : 0,
    skipped: sweep.skipped,
    partial: sweep.partial,
    messages: ok ? sweep.messages.slice(0, clampSmsLimit(req.limit)) : [],
    ...(action === "clear" ? { cleared: sweep.cleared ?? {} } : {}),
  };
}

/**
 * Fixed inbox for `--mode sim` / `--mode replay` (no modem), so cloud dev E2E
 * runs without hardware. Synthetic content only. Timestamps are relative to
 * `now` so the newest message always looks recent.
 */
export function fixtureSmsSweep(now: number = Date.now()): SmsSweep {
  const iso = (msAgo: number): string => {
    const d = new Date(now - msAgo);
    return `${d.toISOString().slice(0, 19)}+00:00`;
  };
  const H = 3_600_000;
  const messages: SmsMessage[] = [
    {
      id: "SM:2",
      storage: "SM",
      indexes: [2],
      from: "XORGATE",
      fromType: "alphanumeric",
      sentAt: iso(0.5 * H),
      unread: true,
      text: "Simulated device: this is a fixture inbox, not a real modem.",
      binary: false,
      incomplete: false,
      truncated: false,
    },
    {
      id: "SM:0+SM:1",
      storage: "SM",
      indexes: [0, 1],
      from: "+15550100001",
      fromType: "international",
      sentAt: iso(26 * H),
      unread: false,
      text:
        "Your data plan renews tomorrow. This fixture message was split in two parts " +
        "and joined on the device, the way a long carrier notice would be.",
      binary: false,
      incomplete: false,
      truncated: false,
    },
    {
      id: "ME:4",
      storage: "ME",
      indexes: [4],
      from: "5550100",
      fromType: "national",
      sentAt: iso(9 * 24 * H),
      unread: false,
      text: "Fixture with unicode: café, 東京, 👍",
      binary: false,
      incomplete: false,
      truncated: false,
    },
    {
      id: "ME:1",
      storage: "ME",
      indexes: [1],
      from: "+15550100002",
      fromType: "international",
      sentAt: iso(40 * 24 * H),
      unread: false,
      text: "Oldest fixture message.",
      binary: false,
      incomplete: false,
      truncated: false,
    },
  ];
  return {
    status: "ok",
    error: null,
    finishedAt: now,
    durationMs: 0,
    storage: { SM: { used: 3, total: 40 }, ME: { used: 2, total: 23 } },
    skipped: 0,
    partial: false,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Fixture inbox state for sim/replay (device-sms-clear)
// ---------------------------------------------------------------------------

/**
 * Module-level: a `clear_sms` empties the fixture inbox for the rest of this
 * process, so cloud E2E in sim/replay sees the same "clear, then empty list"
 * flow as hardware. A restart (or `resetFixtureSmsInbox`) refills it.
 */
let fixtureInboxCleared = false;

const FIXTURE_TOTALS = { SM: 40, ME: 23 } as const;

function emptyFixture(now: number): SmsSweep {
  return {
    status: "ok",
    error: null,
    finishedAt: now,
    durationMs: 0,
    storage: { SM: { used: 0, total: FIXTURE_TOTALS.SM }, ME: { used: 0, total: FIXTURE_TOTALS.ME } },
    skipped: 0,
    partial: false,
    messages: [],
  };
}

/** What a read answers off hardware: the fixture inbox, or empty after a clear. */
export function fixtureSmsRead(now: number = Date.now()): SmsSweep {
  return fixtureInboxCleared ? emptyFixture(now) : fixtureSmsSweep(now);
}

/** A clear off hardware: reports the fixture's counts, then empties it. */
export function fixtureSmsClear(now: number = Date.now()): SmsSweep {
  const before = fixtureSmsRead(now).storage;
  fixtureInboxCleared = true;
  return { ...emptyFixture(now), cleared: { SM: before.SM?.used ?? 0, ME: before.ME?.used ?? 0 } };
}

/** Tests only: refill the fixture inbox. */
export function resetFixtureSmsInbox(): void {
  fixtureInboxCleared = false;
}
