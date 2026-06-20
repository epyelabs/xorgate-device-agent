/**
 * Low-level process primitives for the daemon: spawn-detached, signal/liveness,
 * and PID-reuse-resistant identity verification.
 *
 * A bare `kill(pid, 0)` only proves *some* process owns that pid — pids get
 * recycled on long-running Pis. We corroborate identity by comparing the OS
 * process's elapsed run time (`ps -o etime`) against the pidfile's recorded
 * `startedAt`: a recycled pid is meaningfully *younger* than the record. `ps`
 * (not /proc) keeps this uniform across macOS and Linux. The exec runner is
 * injectable so the logic is unit-testable without spawning a real `ps`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { run } from "../lib/exec.js";
import type { PidRecord } from "./pidfile.js";

export type ProcRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; failed: boolean; notFound: boolean }>;

const defaultRunner: ProcRunner = (cmd, args) =>
  run(cmd, args).then((r) => ({ stdout: r.stdout, failed: r.failed, notFound: r.notFound }));

/** Tolerance for the elapsed-vs-recorded-age comparison (ps has 1 s granularity). */
export const IDENTITY_TOLERANCE_SEC = 5;

/**
 * If the recorded age exceeds the process's elapsed run time by more than this,
 * it's almost certainly a wall-clock step (RTC-less Pi + NTP jump) rather than a
 * real pid reuse. In that case we degrade to "unverified" (trust isAlive) rather
 * than declaring a healthy daemon dead. Only consulted when `ps` gave no command
 * line to corroborate against.
 */
export const CLOCK_STEP_GUARD_SEC = 3600;

export interface ProcInfo {
  /** Did `ps` find the pid? */
  exists: boolean;
  /** Elapsed run time in seconds, or null if `ps` was missing/unparseable. */
  elapsedSec: number | null;
  /** Full command line, or null. */
  command: string | null;
}

export type Identity = "verified" | "reused" | "unverified";

/** Send a signal; classify the outcome rather than throwing for the common cases. */
export function signal(pid: number, sig: NodeJS.Signals | 0): "sent" | "gone" | "eperm" {
  try {
    process.kill(pid, sig);
    return "sent";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "eperm"; // exists, just not signalable by us
    throw err;
  }
}

/** Is a process with this pid alive (regardless of whether it's *ours*)? */
export function isAlive(pid: number): boolean {
  const r = signal(pid, 0);
  return r === "sent" || r === "eperm";
}

/** Spawn the worker fully detached, wired to a log fd, and release it. */
export function spawnDetached(
  command: string,
  args: string[],
  logFd: number,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  return child;
}

/**
 * Parse a `ps -o etime` value (`[[DD-]HH:]MM:SS`, used by both BSD and GNU ps)
 * into seconds. Returns null on anything unexpected.
 */
export function parseEtimeSeconds(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  let days = 0;
  let rest = s;
  const dash = s.indexOf("-");
  if (dash !== -1) {
    const d = s.slice(0, dash);
    if (!/^\d+$/.test(d)) return null; // Number("") === 0 — reject empty/garbage explicitly
    days = Number(d);
    rest = s.slice(dash + 1);
  }
  const tokens = rest.split(":");
  // Each colon-separated field must be a run of digits (rejects "::", ":30", …).
  if (!tokens.every((t) => /^\d+$/.test(t))) return null;
  const parts = tokens.map(Number);
  let h = 0;
  let m = 0;
  let sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else return null;
  return days * 86400 + h * 3600 + m * 60 + sec;
}

/** Query a pid's elapsed time + command via `ps` (degrades to unverified). */
export async function inspectProcess(
  pid: number,
  runner: ProcRunner = defaultRunner,
): Promise<ProcInfo> {
  const r = await runner("ps", ["-o", "etime=,command=", "-p", String(pid)]);
  if (r.notFound || r.failed) {
    // ps missing → can't verify; ps "failed" (non-zero) usually means no such pid.
    // Either way we can't assert existence here (liveness comes from isAlive).
    return { exists: false, elapsedSec: null, command: null };
  }
  const line = r.stdout.trim();
  if (!line) return { exists: false, elapsedSec: null, command: null };
  const sp = line.indexOf(" ");
  const etimeTok = sp === -1 ? line : line.slice(0, sp);
  const command = sp === -1 ? null : line.slice(sp + 1).trim();
  return { exists: true, elapsedSec: parseEtimeSeconds(etimeTok), command };
}

/** Does this command line look like our worker entry? */
export function looksLikeWorker(command: string, worker: string): boolean {
  if (worker && command.includes(worker)) return true;
  const base = worker.slice(worker.lastIndexOf("/") + 1); // worker.js / worker.ts
  if (base && command.includes(base)) return true;
  return command.includes("worker");
}

/**
 * Decide whether the live pid is really the worker the pidfile describes.
 *
 * The command line (`ps -o command`) is the strongest, clock-independent signal,
 * so it wins when available: if it references our worker the pid is ours
 * ("verified"); if it's some other program the pid was recycled ("reused").
 * Only when ps gave no command do we fall back to the elapsed-vs-recorded-age
 * heuristic — and there we guard against wall-clock steps (RTC-less Pi + NTP),
 * which would otherwise make a healthy daemon look "reused".
 */
export function classifyIdentity(
  record: PidRecord,
  info: ProcInfo,
  now: number,
  toleranceSec: number = IDENTITY_TOLERANCE_SEC,
): Identity {
  if (info.command) {
    return looksLikeWorker(info.command, record.worker) ? "verified" : "reused";
  }
  // No command from ps → age heuristic.
  if (info.elapsedSec === null) return "unverified";
  const expectedAgeSec = (now - record.startedAt) / 1000;
  if (info.elapsedSec + toleranceSec < expectedAgeSec) {
    // Implausibly large gap → almost certainly a clock step, not a reuse.
    if (expectedAgeSec - info.elapsedSec > CLOCK_STEP_GUARD_SEC) return "unverified";
    return "reused";
  }
  return "verified";
}
