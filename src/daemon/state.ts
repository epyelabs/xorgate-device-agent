/**
 * The state file is the daemon→reader IPC channel: the worker writes an atomic
 * JSON snapshot, the monitor/status read it. This mirrors how argus's LteScreen
 * reads its modem daemon's `/run/sim7600-lte/telemetry.json` — but we add a
 * freshness rule so a crashed daemon doesn't show ghost telemetry forever.
 */
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import type {
  ActivityEvent,
  ConnectionState,
  StateSnapshot,
  TelemetryPayload,
} from "../agent/telemetry.js";
import { statePath } from "./runtime.js";

/** Max wall-clock between state-file flushes regardless of publish rate. */
export const STATE_THROTTLE_MS = 250;
const MAX_EVENTS = 20;

/** Validate the fields the readers actually dereference (cheap structural gate). */
function isStateSnapshot(o: unknown): o is StateSnapshot {
  if (!o || typeof o !== "object") return false;
  const s = o as Record<string, unknown>;
  return (
    s.v === 1 &&
    typeof s.deviceId === "string" &&
    typeof s.lastWriteAt === "number" &&
    typeof s.connection === "string" &&
    typeof s.connectionSince === "number" &&
    typeof s.seq === "number" &&
    typeof s.published === "number" &&
    Array.isArray(s.recentEvents)
  );
}

/** Read the snapshot, or null if missing/unreadable/garbage/schema-mismatched. */
export function readState(path: string = statePath()): StateSnapshot | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const obj: unknown = JSON.parse(text);
    return isStateSnapshot(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** Snapshot is "live" only if written within ~3 ticks (plus the throttle slack). */
export function staleThresholdMs(intervalMs: number, throttleMs: number = STATE_THROTTLE_MS): number {
  return Math.max(3000, intervalMs * 3 + throttleMs);
}

export function isFresh(snap: StateSnapshot, now: number, intervalMs: number): boolean {
  return now - snap.lastWriteAt < staleThresholdMs(intervalMs);
}

/**
 * Mutable, write-throttling wrapper the worker holds for the life of the
 * process. Mutators update the in-memory snapshot; `flush()` persists it at most
 * every STATE_THROTTLE_MS (use `force` for connection/error/shutdown events).
 */
export class StateStore {
  private snap: StateSnapshot;
  private lastFlushAt = 0;
  private readonly path: string;

  constructor(initial: StateSnapshot, path: string = statePath()) {
    this.snap = initial;
    this.path = path;
  }

  snapshot(): StateSnapshot {
    return this.snap;
  }

  setConnection(connection: ConnectionState, now: number): void {
    if (this.snap.connection !== connection) {
      this.snap.connection = connection;
      this.snap.connectionSince = now;
    }
  }

  setLatest(payload: TelemetryPayload): void {
    this.snap.latest = payload;
    this.snap.seq = payload.seq;
  }

  recordPublish(now: number): void {
    this.snap.published += 1;
    this.snap.lastPublishAt = now;
  }

  recordPublishError(msg: string, now: number): void {
    this.snap.publishErrors += 1;
    this.snap.lastError = msg;
    this.event("error", `publish error: ${msg}`, now);
  }

  setError(msg: string, now: number): void {
    this.snap.lastError = msg;
    this.event("error", msg, now);
  }

  event(level: ActivityEvent["level"], msg: string, now: number): void {
    this.snap.recentEvents.push({ ts: now, level, msg });
    if (this.snap.recentEvents.length > MAX_EVENTS) {
      this.snap.recentEvents = this.snap.recentEvents.slice(-MAX_EVENTS);
    }
  }

  /** Persist if forced or the throttle window has elapsed. */
  flush(now: number, force = false): void {
    if (!force && now - this.lastFlushAt < STATE_THROTTLE_MS) return;
    this.snap.lastWriteAt = now;
    this.lastFlushAt = now;
    atomicWriteJson(this.path, this.snap);
  }
}
