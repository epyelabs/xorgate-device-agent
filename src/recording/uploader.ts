/**
 * Generic segment uploader (plan D3, Phase 2) — a single-flight queue that
 * drains closed recording segments to S3 while the device is online.
 *
 * Generic on purpose: Phase 4 registers a video SegmentSource next to the
 * telemetry one. Ordering across sources is by `priority` (telemetry first —
 * tiny, high value), within a source chronological oldest-first (the source
 * returns its list sorted).
 *
 * Rules (README shared contracts):
 *  - one transfer at a time (single-flight);
 *  - delete the local file only on confirmed PUT success (S3 = durable copy);
 *  - run only while online AND `recording.upload.mode === "auto"`;
 *  - pause immediately on disconnect (abort the in-flight PUT);
 *  - exponential backoff on failure (2 s → 5 min), reset on success/reconnect.
 */
import { readFileSync, unlinkSync } from "node:fs";

export interface UploadSegment {
  /** Absolute path of the closed segment file. */
  path: string;
  /** Basename, e.g. seg-1753000000000-00003.jsonl.gz. */
  name: string;
  /**
   * Companion object PUT immediately BEFORE the main file and deleted with it
   * only after the main PUT succeeds (Phase 4 video sidecars: the mp4's cloud
   * ingest event must always find its sidecar already in S3). A failure between
   * the two PUTs re-PUTs the sidecar on retry — S3 PUTs are idempotent.
   */
  sidecar?: { path: string; s3Key: string; contentType: string };
}

export interface SegmentSource {
  /** "telemetry" (Phase 2) | "video" (Phase 4). */
  kind: string;
  /** Lower priority uploads first across sources. */
  priority: number;
  contentType: string;
  /** Closed segments, sorted oldest-first. Re-scanned before every pick. */
  listClosed(): UploadSegment[];
  /** S3 object key for a segment, or null when the name doesn't parse (skipped). */
  s3KeyFor(seg: UploadSegment): string | null;
}

export type PutFn = (
  key: string,
  body: Buffer,
  contentType: string,
  signal: AbortSignal,
) => Promise<void>;

export interface UploaderStatus {
  uploading: boolean;
  lastUploadAt: number | null;
}

export interface UploaderOptions {
  sources: SegmentSource[];
  put: PutFn;
  /** MQTT-connected gate (README: the primary connectivity signal). */
  isOnline(): boolean;
  /** Live view of recording.upload.mode. */
  mode(): "auto" | "off";
  /** Fired when uploading/lastUploadAt changed. */
  onStatus?(status: UploaderStatus): void;
  /** Fired after each confirmed upload+delete (manager refreshes backlog stats). */
  onUploaded?(seg: UploadSegment, s3Key: string): void;
  onEvent?(level: "info" | "warn", msg: string): void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class Uploader {
  private readonly opts: UploaderOptions;
  private readonly sources: SegmentSource[];
  private running = false;
  private stopped = false;
  private uploading = false;
  private lastUploadAt: number | null = null;
  private aborter: AbortController | null = null;
  private backoffMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Segment paths with unparseable names — warned once, never retried. */
  private readonly skipped = new Set<string>();

  constructor(opts: UploaderOptions) {
    this.opts = opts;
    this.sources = [...opts.sources].sort((a, b) => a.priority - b.priority);
    this.backoffMs = opts.backoffMinMs ?? BACKOFF_MIN_MS;
  }

  status(): UploaderStatus {
    return { uploading: this.uploading, lastUploadAt: this.lastUploadAt };
  }

  /**
   * Try to start (or continue) draining. Cheap and idempotent — called on
   * connect, on segment close, on settings change, and by the slow timer.
   */
  kick(): void {
    if (this.stopped || this.running) return;
    if (!this.opts.isOnline() || this.opts.mode() !== "auto") return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.drain();
  }

  /** Offline/disconnect: abort any in-flight PUT and reset backoff for the reconnect. */
  pause(): void {
    this.backoffMs = this.opts.backoffMinMs ?? BACKOFF_MIN_MS;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.aborter?.abort();
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }

  /** Drain loop promise — exposed so tests can await quiescence. */
  private drainPromise: Promise<void> | null = null;

  /** Await the current drain (tests). */
  async settled(): Promise<void> {
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.drainPromise = (async () => {
      try {
        while (!this.stopped && this.opts.isOnline() && this.opts.mode() === "auto") {
          const next = this.next();
          if (!next) break;
          const { source, seg } = next;

          const key = source.s3KeyFor(seg);
          if (key === null) {
            this.skipped.add(seg.path);
            this.opts.onEvent?.("warn", `upload: skipping unrecognized segment ${seg.name}`);
            continue;
          }

          let body: Buffer;
          let sidecarBody: Buffer | null = null;
          try {
            body = readFileSync(seg.path);
            if (seg.sidecar) sidecarBody = readFileSync(seg.sidecar.path);
          } catch {
            // Evicted or already gone — not an error, just move on.
            this.skipped.add(seg.path);
            continue;
          }

          // One controller covers the whole segment unit (sidecar + main PUT)
          // so pause() aborts whichever transfer is in flight.
          this.aborter = new AbortController();
          this.setUploading(true);
          try {
            if (seg.sidecar && sidecarBody) {
              await this.opts.put(
                seg.sidecar.s3Key,
                sidecarBody,
                seg.sidecar.contentType,
                this.aborter.signal,
              );
            }
            await this.opts.put(key, body, source.contentType, this.aborter.signal);
          } finally {
            this.aborter = null;
          }

          try {
            unlinkSync(seg.path);
          } catch {
            /* deleted concurrently (eviction) — S3 copy exists, fine */
          }
          if (seg.sidecar) {
            try {
              unlinkSync(seg.sidecar.path);
            } catch {
              /* same */
            }
          }
          this.lastUploadAt = Date.now();
          this.backoffMs = this.opts.backoffMinMs ?? BACKOFF_MIN_MS;
          this.setUploading(false);
          this.opts.onUploaded?.(seg, key);
        }
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (this.stopped || !this.opts.isOnline()) {
          // pause()/stop() aborted the in-flight PUT — the reconnect kick resumes.
          this.opts.onEvent?.("info", "upload paused (offline)");
        } else {
          this.opts.onEvent?.("warn", `upload failed, retrying in ${Math.round(this.backoffMs / 1000)}s: ${msg}`);
          this.scheduleRetry();
        }
      } finally {
        this.setUploading(false);
        this.running = false;
      }
    })();
    await this.drainPromise;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoffMaxMs ?? BACKOFF_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
    this.retryTimer.unref?.();
  }

  private next(): { source: SegmentSource; seg: UploadSegment } | null {
    for (const source of this.sources) {
      for (const seg of source.listClosed()) {
        if (!this.skipped.has(seg.path)) return { source, seg };
      }
    }
    return null;
  }

  private setUploading(v: boolean): void {
    if (this.uploading === v) return;
    this.uploading = v;
    this.opts.onStatus?.(this.status());
  }
}
