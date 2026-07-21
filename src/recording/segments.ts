/**
 * Telemetry segment files (plan D2): rotated JSONL, gzipped on close.
 *
 * A segment is the unit of upload/retry/loss/eviction. The active segment is a
 * plain `.jsonl` being appended to; on rotation it is fsynced, gzipped to
 * `.jsonl.gz` (written via temp+rename so a half-written gz can never be
 * mistaken for an upload-ready one), and the plain file is deleted. "A closed
 * segment exists" IS the pending-upload state — there is no journal.
 *
 * Layout (under the recordings root): telemetry/<sessionId>/seg-<startTsMs>-<seq>.jsonl[.gz]
 *
 * Durability stance: lines are written through a plain fd (no fsync per line —
 * a power cut may cost the tail of the ACTIVE segment only); rotation fsyncs
 * both the gz file and its directory. Crash tolerance: on startup,
 * finalizeOrphanSegments() gzips any leftover `.jsonl` from a previous run,
 * truncating a torn last line.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fsyncDir } from "../lib/atomicWrite.js";
import type { TimeSource } from "./session.js";

/** Rotate on whichever comes first: ~1 MB of JSONL or 60 s of age (plan: min(60 s, ~1 MB)). */
export const SEGMENT_MAX_BYTES = 1024 * 1024;
export const SEGMENT_MAX_AGE_MS = 60_000;

export interface SegmentHeader {
  type: "header";
  v: 1;
  deviceId: string;
  sessionId: string;
  bootId: string;
  timeSource: TimeSource;
  rateHz: number;
  startedAt: number;
}

export interface SampleLine {
  ts: number;
  mono: number;
  seq: number;
  metrics: Record<string, unknown>;
}

export interface SegmentWriterOptions {
  /** Session directory, e.g. <root>/telemetry/<sessionId>. Created on first write. */
  dir: string;
  /** Header for each newly-opened segment (called at open so timeSource is current). */
  header: () => SegmentHeader;
  maxBytes?: number;
  maxAgeMs?: number;
  /** Fired with the closed .jsonl.gz path after each rotation (disk-manager hook). */
  onSegmentClosed?: (gzPath: string) => void;
}

/**
 * Append-only writer for one session's telemetry segments. All methods are
 * synchronous (small writes on a local fs); the recorder calls writeLine() at
 * up to 20 Hz and maybeRotate() every tick.
 */
export class SegmentWriter {
  private readonly opts: Required<Pick<SegmentWriterOptions, "maxBytes" | "maxAgeMs">> &
    SegmentWriterOptions;
  private fd: number | null = null;
  private path: string | null = null;
  private bytes = 0;
  private sampleLines = 0;
  private openedAt = 0;
  private segSeq = 0;
  private lastTimeSource: TimeSource | null = null;

  constructor(opts: SegmentWriterOptions) {
    // ?? per field (not a spread) so an explicitly-undefined option can never
    // clobber a default — { maxAgeMs: undefined, ...defaults-first } did once.
    this.opts = {
      ...opts,
      maxBytes: opts.maxBytes ?? SEGMENT_MAX_BYTES,
      maxAgeMs: opts.maxAgeMs ?? SEGMENT_MAX_AGE_MS,
    };
  }

  /** Path of the active plain .jsonl, or null when no segment is open. */
  activePath(): string | null {
    return this.path;
  }

  /** Segments are opened lazily on the first sample, so idle sessions leave no files. */
  writeLine(line: SampleLine, now: number = Date.now()): void {
    if (this.fd !== null && this.shouldRotate(now)) this.rotate();
    if (this.fd === null) this.open(now);
    this.append(JSON.stringify(line));
    this.sampleLines++;
  }

  /**
   * Record a time-provenance change mid-segment by re-emitting a header line
   * (plan D6 — simplest transition encoding; readers treat the latest header
   * as current). No-op when nothing is open or the value is unchanged.
   */
  noteTimeSource(ts: TimeSource): void {
    if (this.fd === null || this.lastTimeSource === ts) {
      this.lastTimeSource = ts;
      return;
    }
    this.lastTimeSource = ts;
    this.append(JSON.stringify({ ...this.opts.header(), timeSource: ts }));
  }

  /** Age/size check without a write — lets an idle recorder still close segments on time. */
  maybeRotate(now: number = Date.now()): void {
    if (this.fd !== null && this.shouldRotate(now)) this.rotate();
  }

  /** Close + gzip the active segment (shutdown / recording-off path). Safe to re-call. */
  finalize(): void {
    if (this.fd !== null) this.rotate();
  }

  private shouldRotate(now: number): boolean {
    return this.bytes >= this.opts.maxBytes || now - this.openedAt >= this.opts.maxAgeMs;
  }

  private open(now: number): void {
    mkdirSync(this.opts.dir, { recursive: true });
    const header = this.opts.header();
    this.path = join(this.opts.dir, `seg-${now}-${String(this.segSeq).padStart(5, "0")}.jsonl`);
    this.segSeq++;
    this.fd = openSync(this.path, "w", 0o600);
    this.bytes = 0;
    this.sampleLines = 0;
    this.openedAt = now;
    this.lastTimeSource = header.timeSource;
    this.append(JSON.stringify(header));
  }

  private append(json: string): void {
    if (this.fd === null) return;
    const buf = Buffer.from(json + "\n");
    writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  private rotate(): void {
    if (this.fd === null || this.path === null) return;
    const plain = this.path;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = null;
    this.path = null;
    // A segment that never got a sample (header only) carries no data — drop it
    // rather than shipping empty gz files through the whole upload pipeline.
    if (this.sampleLines === 0) {
      unlinkSync(plain);
      return;
    }
    const gzPath = gzipFinalize(plain);
    this.opts.onSegmentClosed?.(gzPath);
  }
}

/**
 * Gzip a plain segment into `<plain>.gz` (temp + fsync + rename + dir fsync)
 * and delete the plain file. Returns the gz path.
 */
function gzipFinalize(plain: string, content?: Buffer): string {
  const data = content ?? readFileSync(plain);
  const gzPath = `${plain}.gz`;
  const tmp = `${gzPath}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, gzipSync(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, gzPath);
  fsyncDir(dirname(plain));
  unlinkSync(plain);
  return gzPath;
}

/**
 * Startup crash recovery: finalize any plain `.jsonl` left behind by a
 * previous run (crash/power cut mid-segment). A torn last line (no trailing
 * newline) is truncated away; a segment with no complete sample line is
 * deleted. Leftover gzip temp files are removed. Returns the finalized count.
 *
 * Safe to run before the new session starts writing (session dirs are per-run,
 * so nothing here can race the active writer).
 */
export function finalizeOrphanSegments(telemetryRoot: string): number {
  let finalized = 0;
  let sessions: string[];
  try {
    sessions = readdirSync(telemetryRoot);
  } catch {
    return 0; // no tree yet
  }
  for (const session of sessions) {
    const dir = join(telemetryRoot, session);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (name.includes(".gz.tmp.")) {
        try {
          unlinkSync(path);
        } catch {
          /* best effort */
        }
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      try {
        const raw = readFileSync(path);
        const lastNl = raw.lastIndexOf(0x0a);
        const whole = lastNl === -1 ? Buffer.alloc(0) : raw.subarray(0, lastNl + 1);
        // Need at least a header AND one sample to be worth keeping.
        const lines = whole.toString("utf8").split("\n").filter((l) => l.length > 0);
        if (lines.length < 2) {
          unlinkSync(path);
          continue;
        }
        gzipFinalize(path, whole);
        finalized++;
      } catch (err) {
        console.error(`[recording] orphan finalize failed for ${path}: ${(err as Error).message}`);
      }
    }
  }
  return finalized;
}
