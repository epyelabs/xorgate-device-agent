/**
 * High-level daemon control used identically by the CLI commands and the
 * monitor's keybindings: inspect()/start()/stop()/restart(). Keeping one
 * implementation means `xorgate stop` and pressing `x` in the monitor behave
 * exactly the same.
 */
import { closeSync, openSync, readFileSync } from "node:fs";
import { loadConfig } from "../agent/config.js";
import type { StateSnapshot } from "../agent/telemetry.js";
import {
  ensureHome,
  logPath,
  resolveWorkerSpawn,
  runtimeHome,
  workerPath,
} from "./runtime.js";
import {
  type PidRecord,
  readLock,
  readPidfile,
  removeLock,
  removePidfile,
  tryCreateLock,
  writePidfile,
} from "./pidfile.js";
import {
  type Identity,
  type ProcRunner,
  classifyIdentity,
  inspectProcess,
  isAlive,
  signal,
  spawnDetached,
} from "./process.js";
import { isFresh, readState } from "./state.js";

export type DaemonStatus =
  | {
      kind: "running";
      record: PidRecord;
      identity: Identity;
      state: StateSnapshot | null;
      stateFresh: boolean;
    }
  | { kind: "stale"; record: PidRecord; reason: "no-process" | "pid-reused" }
  | { kind: "stopped" };

export interface StartResult {
  ok: boolean;
  pid?: number;
  alreadyRunning?: PidRecord;
  cleanedStale?: boolean;
  crashed?: boolean;
  logTail?: string[];
  message: string;
}

export interface StopResult {
  ok: boolean;
  wasRunning: boolean;
  forced?: boolean;
  message: string;
}

const STOP_TIMEOUT_MS = Number(process.env.XORGATE_STOP_TIMEOUT_MS) || 5000;
const START_CONFIRM_MS = 400;
/** A start lock older than this (or owned by a dead launcher) is stealable. */
const LOCK_STALE_MS = 30_000;

/**
 * Acquire the exclusive start lock so the inspect→spawn→write critical section
 * can't be run by two `start`s at once (which would launch two workers sharing
 * one MQTT clientId). Steals a lock left by a dead/crashed launcher.
 */
export function acquireStartLock(now: number): boolean {
  if (tryCreateLock({ pid: process.pid, at: now })) return true;
  const held = readLock();
  if (!held || !isAlive(held.pid) || now - held.at > LOCK_STALE_MS) {
    removeLock();
    return tryCreateLock({ pid: process.pid, at: now });
  }
  return false;
}

function intervalMsOf(record: PidRecord): number {
  return Math.round(1000 / (record.rateHz > 0 ? record.rateHz : 1));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the last `maxLines` of the daemon log (for crash diagnostics / logs cmd). */
export function readLogTail(maxLines = 200, path: string = logPath()): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

/** Full status check: pidfile + liveness + identity + state freshness. */
export async function inspect(
  now: number = Date.now(),
  runner?: ProcRunner,
): Promise<DaemonStatus> {
  const record = readPidfile();
  if (!record) return { kind: "stopped" };
  if (!isAlive(record.pid)) return { kind: "stale", record, reason: "no-process" };

  const info = await inspectProcess(record.pid, runner);
  const identity = classifyIdentity(record, info, now);
  if (identity === "reused") return { kind: "stale", record, reason: "pid-reused" };

  const state = readState();
  const stateFresh = state ? isFresh(state, now, intervalMsOf(record)) : false;
  return { kind: "running", record, identity, state, stateFresh };
}

/**
 * Start the detached worker. `argv` is the agent flag slice (e.g. ['--offline'])
 * passed through to the worker and recorded in the pidfile. Fails fast if the
 * config/creds are invalid (so we never spawn a crash-looper).
 */
export async function start(argv: string[], now: number = Date.now()): Promise<StartResult> {
  let config;
  try {
    config = loadConfig(argv);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  let cleanedStale = false;
  const status = await inspect(now);
  if (status.kind === "running") {
    return {
      ok: false,
      alreadyRunning: status.record,
      message: `already running (pid ${status.record.pid})`,
    };
  }
  if (status.kind === "stale") {
    removePidfile();
    cleanedStale = true;
  }

  ensureHome();

  // Reserve the lock BEFORE spawning, so a concurrent start never launches a
  // second worker. The loser aborts here without having forked anything.
  if (!acquireStartLock(now)) {
    return { ok: false, cleanedStale, message: "another start is in progress; aborted" };
  }

  try {
    const fd = openSync(logPath(), "a");
    let child;
    try {
      const { command, args } = resolveWorkerSpawn(argv);
      // XORGATE_MANAGED_BY tells the worker the CLI owns its pidfile, so it
      // won't self-register and race this writer. (A worker launched directly,
      // e.g. by systemd, has no such flag and registers itself.)
      child = spawnDetached(command, args, fd, {
        ...process.env,
        XORGATE_HOME: runtimeHome(),
        XORGATE_MANAGED_BY: "cli",
      });
    } finally {
      closeSync(fd); // the child holds its own dup'd fd
    }

    if (typeof child.pid !== "number") {
      return { ok: false, cleanedStale, message: "failed to spawn worker (no pid)" };
    }

    // Stamp startedAt at the real fork time (not the top-of-function `now`) so
    // the identity age check isn't biased.
    const record: PidRecord = {
      pid: child.pid,
      startedAt: Date.now(),
      deviceId: config.deviceId,
      mode: config.mode,
      rateHz: config.rateHz,
      offline: config.offline,
      worker: workerPath(),
      argv,
      nodeVersion: process.version,
    };
    writePidfile(record);

    // Brief confirmation: catch instant crashes (bad creds, unreachable endpoint).
    await sleep(START_CONFIRM_MS);
    if (!isAlive(child.pid)) {
      removePidfile();
      return {
        ok: false,
        cleanedStale,
        crashed: true,
        logTail: readLogTail(15),
        message: `worker exited immediately (pid ${child.pid}); see log`,
      };
    }

    return {
      ok: true,
      pid: child.pid,
      cleanedStale,
      message: `started (pid ${child.pid}${config.offline ? ", offline" : ""})`,
    };
  } finally {
    removeLock(); // release the critical section
  }
}

/** Stop the worker: SIGTERM, wait for graceful exit, SIGKILL backstop. */
export async function stop(
  now: number = Date.now(),
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<StopResult> {
  const status = await inspect(now);
  if (status.kind === "stopped") return { ok: true, wasRunning: false, message: "not running" };
  if (status.kind === "stale") {
    removePidfile();
    return { ok: true, wasRunning: false, message: "removed stale pidfile" };
  }

  const { pid } = status.record;
  const sent = signal(pid, "SIGTERM");
  if (sent === "gone") {
    removePidfile();
    return { ok: true, wasRunning: true, message: "already exited" };
  }

  // Poll for graceful exit (the worker publishes offline + closes mqtt first).
  const steps = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let i = 0; i < steps; i++) {
    await sleep(100);
    if (!isAlive(pid)) {
      removePidfile();
      return { ok: true, wasRunning: true, message: `stopped (pid ${pid})` };
    }
  }

  // Backstop: force kill.
  signal(pid, "SIGKILL");
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!isAlive(pid)) break;
  }
  if (isAlive(pid)) {
    // Still alive — e.g. SIGKILL returned EPERM (not our process). Keep the
    // pidfile so the process stays trackable, and report the failure honestly.
    return {
      ok: false,
      wasRunning: true,
      message: `could not kill pid ${pid} (still alive — permission denied?)`,
    };
  }
  removePidfile();
  return { ok: true, wasRunning: true, forced: true, message: `force-killed (pid ${pid})` };
}

/** restart = stop, then start with the same (or new) flags. */
export async function restart(argv: string[], now: number = Date.now()): Promise<StartResult> {
  await stop(now);
  return start(argv, Date.now());
}
