/**
 * The pidfile records the detached worker's identity as JSON (not a bare pid) so
 * status/monitor can render rich info and so liveness can be cross-checked
 * against process start time (see process.ts). Written with O_EXCL as a soft
 * double-start lock.
 */
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { RunMode } from "../agent/telemetry.js";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { pidPath } from "./runtime.js";

export function lockPath(): string {
  return `${pidPath()}.lock`;
}

/** Launcher's claim while it spawns: { pid, at } so a dead/old lock can be stolen. */
export interface LockRecord {
  pid: number;
  at: number;
}

export interface PidRecord {
  /** The detached worker's pid (not the launcher's). */
  pid: number;
  /** Epoch ms the launcher recorded at spawn — anchors the identity check. */
  startedAt: number;
  deviceId: string;
  mode: RunMode;
  rateHz: number;
  offline: boolean;
  /** Absolute path of the worker entry, used as a corroborating identity hint. */
  worker: string;
  argv: string[];
  nodeVersion: string;
}

/** Parse + validate a pidfile body. Garbage / old bare-int formats → null. */
export function parsePidRecord(text: string): PidRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.startedAt !== "number") return null;
  if (typeof r.deviceId !== "string") return null;
  return {
    pid: r.pid,
    startedAt: r.startedAt,
    deviceId: r.deviceId,
    mode: r.mode === "real" ? "real" : "sim",
    rateHz: typeof r.rateHz === "number" ? r.rateHz : 1,
    offline: r.offline === true,
    worker: typeof r.worker === "string" ? r.worker : "",
    argv: Array.isArray(r.argv) ? (r.argv as unknown[]).map(String) : [],
    nodeVersion: typeof r.nodeVersion === "string" ? r.nodeVersion : "",
  };
}

/** Read the pidfile, or null if missing/unreadable/garbage. */
export function readPidfile(path: string = pidPath()): PidRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // ENOENT and friends → not running
  }
  return parsePidRecord(text);
}

/**
 * Create the pidfile exclusively (O_EXCL). Returns false if it already exists
 * (lost a double-start race / a live daemon already owns it). Caller decides
 * what to do with the loss (abort + reap its child).
 */
export function writePidfileExclusive(record: PidRecord, path: string = pidPath()): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Atomically (over)write the pidfile — used to stamp the real pid after spawn. */
export function writePidfile(record: PidRecord, path: string = pidPath()): void {
  atomicWriteJson(path, record);
}

/** Remove the pidfile, ignoring "already gone". */
export function removePidfile(path: string = pidPath()): void {
  unlinkIgnoring(path);
}

// --- start lock (held only during the inspect→spawn→write critical section) ---

/** Create the lock exclusively. Returns false if it already exists. */
export function tryCreateLock(record: LockRecord, path: string = lockPath()): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function readLock(path: string = lockPath()): LockRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.pid === "number" && typeof obj.at === "number") return obj as LockRecord;
    return null;
  } catch {
    return null;
  }
}

export function removeLock(path: string = lockPath()): void {
  unlinkIgnoring(path);
}

function unlinkIgnoring(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
