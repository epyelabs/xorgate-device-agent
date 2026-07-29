/**
 * Recording session identity + time provenance (plan decision D5/D6).
 *
 * A session is one continuous run of recording: minted when recording turns on
 * (including agent boot with recording enabled), never reused across restarts —
 * a new bootId always means a new session. Segment files and (later) uploads
 * are grouped under the sessionId, so it must sort roughly by start time for
 * oldest-first upload/eviction; we use a UUIDv7 (48-bit epoch-ms prefix).
 *
 * Time provenance: devices may boot with a bad clock (not every unit has a
 * charged RTC), so every segment header records where wall-clock time came
 * from: `ntp` (systemd-timesyncd reports synchronized), `rtc` (not NTP-synced
 * but an RTC exists — time plausibly restored from it at boot), or `unsynced`
 * (neither — timestamps may be bogus and need cloud-side re-anchoring via
 * mono+bootId). The check shells out to timedatectl, so it is cached and
 * refreshed on a slow interval by the tracker.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { run } from "../lib/exec.js";

/** UUIDv7: 48-bit big-endian epoch ms, then random, with version/variant bits. */
export function mintSessionId(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(now)));
  b[0] = Number((ms >> 40n) & 0xffn);
  b[1] = Number((ms >> 32n) & 0xffn);
  b[2] = Number((ms >> 24n) & 0xffn);
  b[3] = Number((ms >> 16n) & 0xffn);
  b[4] = Number((ms >> 8n) & 0xffn);
  b[5] = Number(ms & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

let cachedBootId: string | null = null;

/**
 * The kernel's boot UUID — the mono-clock epoch marker (D6): mono values are
 * only comparable within one bootId. Off-Linux (dev box) there is no boot_id;
 * a random per-process UUID keeps the contract (new process = new "boot").
 */
export function readBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    cachedBootId = readFileSync(BOOT_ID_FILE, "utf8").trim();
  } catch {
    cachedBootId = randomUUID();
  }
  return cachedBootId;
}

export type TimeSource = "ntp" | "rtc" | "unsynced";

/** One uncached probe of the current time provenance. */
export async function probeTimeSource(): Promise<TimeSource> {
  const res = await run("timedatectl", ["show", "-p", "NTPSynchronized", "--value"]);
  if (!res.notFound && !res.failed && res.stdout.trim() === "yes") return "ntp";
  try {
    if (existsSync("/sys/class/rtc/rtc0")) return "rtc";
  } catch {
    /* fall through */
  }
  return "unsynced";
}

export interface TimeSourceTracker {
  /** Last known value (never blocks; kicks a refresh when stale). */
  current(): TimeSource;
  /**
   * Force a probe now. The manager AWAITS this (bounded) before its first
   * apply(), so the first session headers/manifests carry the probed value
   * rather than the pessimistic initial "unsynced".
   */
  refresh(): Promise<TimeSource>;
}

/**
 * Cached timeSource with slow refresh — the recorder reads this every tick at
 * up to 20 Hz, but the underlying probe execs timedatectl, so `current()`
 * returns the cache and re-probes at most every `refreshMs`.
 */
export function createTimeSourceTracker(refreshMs = 60_000): TimeSourceTracker {
  let value: TimeSource = "unsynced";
  let lastProbeAt = 0;
  let probing = false;

  async function refresh(): Promise<TimeSource> {
    probing = true;
    try {
      value = await probeTimeSource();
      lastProbeAt = Date.now();
    } finally {
      probing = false;
    }
    return value;
  }

  return {
    current(): TimeSource {
      if (!probing && Date.now() - lastProbeAt >= refreshMs) {
        lastProbeAt = Date.now(); // claim the slot before the async probe lands
        void refresh().catch(() => {});
      }
      return value;
    },
    refresh,
  };
}
