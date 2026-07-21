/**
 * Telemetry recorder — samples the collectors' caches at `rateHz` and appends
 * JSONL sample lines to the session's segment writer. Fully decoupled from the
 * live 1 Hz publish loop AND from connectivity: it runs its own interval, so a
 * device that boots offline (MQTT never connects, live loop never starts)
 * still records.
 *
 * Freshness gating (plan): a group is written only when its cache advanced
 * (`updatedMono`) since the last written sample AND its native cadence allows
 * another write — so at rateHz=10, IMU (20 Hz native) lands ~10×/s while
 * GPS/LTE/system (1 Hz native) land ~1×/s instead of 10 duplicated rows.
 */
import type { GroupSample } from "../agent/collectors/index.js";
import { SegmentWriter, type SegmentWriterOptions } from "./segments.js";
import type { TimeSourceTracker } from "./session.js";

/** How fast each group's underlying data actually refreshes (Hz). */
const NATIVE_CADENCE_HZ: Record<string, number> = {
  imu: 20,
  gps: 1,
  lte: 1,
  system: 1,
};

/** Tolerance so a tick landing a few ms early still counts as the next period. */
const CADENCE_SLACK = 0.9;

export interface TelemetryRecorderOptions {
  rateHz: number;
  sampleGroups(): Promise<Record<string, GroupSample>>;
  timeSource: TimeSourceTracker;
  /** Segment writer config (dir, header factory, rotation limits, close hook). */
  writer: SegmentWriterOptions;
  /** Unknown groups fall back to being capped at rateHz; override for tests. */
  nativeCadenceHz?: Record<string, number>;
}

export class TelemetryRecorder {
  private readonly opts: TelemetryRecorderOptions;
  private readonly writer: SegmentWriter;
  private readonly cadence: Record<string, number>;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private seq = 0;
  private lastWrittenMono = new Map<string, bigint>();
  private lastWriteAtMs = new Map<string, number>();

  constructor(opts: TelemetryRecorderOptions) {
    this.opts = opts;
    this.writer = new SegmentWriter(opts.writer);
    this.cadence = opts.nativeCadenceHz ?? NATIVE_CADENCE_HZ;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.round(1000 / this.opts.rateHz));
  }

  /** Stop ticking and finalize the active segment (sync — safe from shutdown handlers). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.writer.finalize();
  }

  /** Path of the active plain segment (disk-manager protection), or null. */
  activePath(): string | null {
    return this.writer.activePath();
  }

  /** One sampling tick; also drives time-based rotation. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return; // a slow tick must not overlap the next
    this.ticking = true;
    try {
      const groups = await this.opts.sampleGroups();
      if (this.stopped) return; // stop() ran during the await — segment is finalized
      const now = Date.now();
      const metrics: Record<string, unknown> = {};

      for (const [group, s] of Object.entries(groups)) {
        const lastMono = this.lastWrittenMono.get(group);
        if (lastMono !== undefined && s.updatedMono <= lastMono) continue;
        const nativeHz = this.cadence[group] ?? this.opts.rateHz;
        const minGapMs = (1000 / Math.min(nativeHz, this.opts.rateHz)) * CADENCE_SLACK;
        const lastAt = this.lastWriteAtMs.get(group);
        if (lastAt !== undefined && now - lastAt < minGapMs) continue;
        metrics[group] = s.fields;
        this.lastWrittenMono.set(group, s.updatedMono);
        this.lastWriteAtMs.set(group, now);
      }

      this.writer.noteTimeSource(this.opts.timeSource.current());
      if (Object.keys(metrics).length > 0) {
        this.writer.writeLine(
          { ts: now, mono: Number(process.hrtime.bigint()), seq: this.seq++, metrics },
          now,
        );
      }
      this.writer.maybeRotate(now);
    } catch (err) {
      console.error(`[recording] tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
