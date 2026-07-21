/**
 * Recording manager — the worker's single entry point for on-device recording.
 * Owns the lifecycle: resolves the `recording` settings namespace, starts and
 * stops the telemetry recorder as config changes (LIVE — no agent restart;
 * settings.json is re-read on a slow poll and after every cloud-config apply),
 * runs startup crash recovery, and drives the disk manager.
 *
 * Session rules (plan D5): a sessionId is minted whenever the recorder
 * (re)starts — recording toggled on, agent boot with recording enabled, or a
 * rateHz change (restart = new session, so a session's header rateHz always
 * matches its samples).
 *
 * Disabled-by-default guarantee (DoD 6): when recording is off and no
 * recordings tree exists, this module creates no files and no directories.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GroupSample } from "../agent/collectors/index.js";
import { loadSettings } from "../daemon/settings.js";
import type { RecordingStatus } from "../agent/telemetry.js";
import { recordingsRoot, resolveRecordingConfig, telemetryRoot, type ResolvedRecordingConfig } from "./config.js";
import { DiskManager } from "./disk.js";
import { finalizeOrphanSegments } from "./segments.js";
import { TelemetryRecorder } from "./telemetry-recorder.js";
import { createTimeSourceTracker, mintSessionId, readBootId } from "./session.js";
import { createTelemetrySource } from "./telemetry-source.js";
import { Uploader, type PutFn, type SegmentSource } from "./uploader.js";

/** How often settings.json is re-checked for recording changes. */
const SETTINGS_POLL_MS = 5_000;
/** Slow disk-pressure sweep; rotations also trigger enforcement directly. */
const DISK_ENFORCE_MS = 60_000;

/**
 * Upload plumbing injected by the worker (Phase 2). Absent when the device has
 * no upload target (offline mode, no manifest/bucket) — recording still works,
 * segments just accumulate under the retention quota.
 */
export interface RecordingUploadOptions {
  /** Performs one S3 PUT (creds + SigV4 live behind this in the worker). */
  put: PutFn;
  /** MQTT-connected gate, read before/during every transfer. */
  isOnline(): boolean;
  /** Phase 4 registers the video source here. */
  extraSources?: SegmentSource[];
  /** Backoff overrides for tests. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface RecordingManagerOptions {
  deviceId: string;
  sampleGroups(): Promise<Record<string, GroupSample>>;
  /** Called whenever recording status (enabled/session/backlog) may have changed. */
  onStatus?: (status: RecordingStatus) => void;
  /** Surface a notable transition into the worker's event trail. */
  onEvent?: (level: "info" | "warn", msg: string) => void;
  /** Segment upload plumbing; omit to disable uploads entirely. */
  upload?: RecordingUploadOptions;
  /** Overrides for tests. */
  root?: string;
  pollMs?: number;
  segmentMaxBytes?: number;
  segmentMaxAgeMs?: number;
}

export class RecordingManager {
  private readonly opts: RecordingManagerOptions;
  private readonly root: string;
  private readonly timeSource = createTimeSourceTracker();
  private cfg: ResolvedRecordingConfig;
  private recorder: TelemetryRecorder | null = null;
  private sessionId: string | null = null;
  private disk: DiskManager | null = null;
  private uploader: Uploader | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private lastSettingsKey = "";

  constructor(opts: RecordingManagerOptions) {
    this.opts = opts;
    this.root = opts.root ?? recordingsRoot();
    this.cfg = resolveRecordingConfig(loadSettings().recording);
    if (opts.upload) {
      this.uploader = new Uploader({
        sources: [
          createTelemetrySource(opts.deviceId, telemetryRoot(this.root)),
          ...(opts.upload.extraSources ?? []),
        ],
        put: opts.upload.put,
        isOnline: opts.upload.isOnline,
        mode: () => this.cfg.upload.mode,
        backoffMinMs: opts.upload.backoffMinMs,
        backoffMaxMs: opts.upload.backoffMaxMs,
        onStatus: () => this.notifyStatus(),
        onEvent: (level, msg) => this.opts.onEvent?.(level, msg),
        onUploaded: () => {
          // Refresh backlog gauges (and let eviction see the freed space).
          void this.runEnforce();
        },
      });
    }
  }

  /** Startup: crash-recover any earlier run's segments, then apply current settings. */
  start(): void {
    // Only touch the tree if a previous run created it — a device that has
    // never recorded stays byte-identical to today (no dirs, no counters).
    if (existsSync(this.root)) {
      const finalized = finalizeOrphanSegments(telemetryRoot(this.root));
      if (finalized > 0) {
        this.opts.onEvent?.("info", `recording: finalized ${finalized} orphan segment(s) from previous run`);
      }
      this.ensureDisk();
    }
    this.lastSettingsKey = this.settingsKey();
    this.apply();
    void this.timeSource.refresh().catch(() => {});
    this.pollTimer = setInterval(() => this.reapply(), this.opts.pollMs ?? SETTINGS_POLL_MS);
    this.pollTimer.unref();
    // Drain any backlog left by earlier runs (crash-recovered segments included).
    this.uploader?.kick();
  }

  /**
   * Worker-driven connectivity edge (MQTT connect/close). Online → try to
   * drain; offline → abort the in-flight PUT immediately (README: pause on
   * disconnect, don't let a dead socket hold a transfer open).
   */
  notifyConnectivity(online: boolean): void {
    if (online) this.uploader?.kick();
    else this.uploader?.pause();
  }

  /** Re-read settings.json and apply if the recording namespace changed. */
  reapply(): void {
    const key = this.settingsKey();
    if (key === this.lastSettingsKey) return;
    this.lastSettingsKey = key;
    this.cfg = resolveRecordingConfig(loadSettings().recording);
    this.apply();
  }

  /** Sync shutdown: finalize the active segment, stop all timers. */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.pollTimer = null;
    this.diskTimer = null;
    this.uploader?.stop();
    this.stopRecorder("agent shutdown");
  }

  status(): RecordingStatus {
    const disk = this.disk?.stats();
    const upload = this.uploader?.status();
    return {
      enabled: this.recorder !== null,
      sessionId: this.sessionId,
      backlogBytes: disk?.backlogBytes ?? 0,
      backlogSegments: disk?.backlogSegments ?? 0,
      droppedSegments: disk?.droppedSegments ?? 0,
      uploading: upload?.uploading ?? false,
      lastUploadAt: upload?.lastUploadAt ?? null,
    };
  }

  private settingsKey(): string {
    return JSON.stringify(loadSettings().recording ?? null);
  }

  private apply(): void {
    this.disk?.setRetention(this.cfg.retention);

    const want = this.cfg.telemetry.enabled;
    const rateChanged =
      this.recorder !== null && this.activeRateHz !== this.cfg.telemetry.rateHz;

    if (this.recorder && (!want || rateChanged)) {
      this.stopRecorder(rateChanged ? "rateHz changed" : "recording disabled");
    }
    if (want && !this.recorder) this.startRecorder();

    this.notifyStatus();
    this.uploader?.kick(); // upload.mode may have flipped to auto
  }

  private activeRateHz: number | null = null;

  private startRecorder(): void {
    const sessionId = mintSessionId();
    const rateHz = this.cfg.telemetry.rateHz;
    const dir = join(telemetryRoot(this.root), sessionId);
    this.ensureDisk();

    this.recorder = new TelemetryRecorder({
      rateHz,
      sampleGroups: this.opts.sampleGroups,
      timeSource: this.timeSource,
      writer: {
        dir,
        maxBytes: this.opts.segmentMaxBytes,
        maxAgeMs: this.opts.segmentMaxAgeMs,
        header: () => ({
          type: "header",
          v: 1,
          deviceId: this.opts.deviceId,
          sessionId,
          bootId: readBootId(),
          timeSource: this.timeSource.current(),
          rateHz,
          startedAt: Date.now(),
        }),
        onSegmentClosed: () => {
          void this.runEnforce();
        },
      },
    });
    this.sessionId = sessionId;
    this.activeRateHz = rateHz;
    this.recorder.start();
    this.opts.onEvent?.("info", `telemetry recording started (session ${sessionId.slice(0, 8)}…, ${rateHz} Hz)`);
  }

  private stopRecorder(why: string): void {
    if (!this.recorder) return;
    this.recorder.stop();
    this.recorder = null;
    this.activeRateHz = null;
    this.opts.onEvent?.("info", `telemetry recording stopped (${why})`);
    this.sessionId = null;
  }

  private ensureDisk(): void {
    if (this.disk) return;
    this.disk = new DiskManager({ root: this.root, retention: this.cfg.retention });
    void this.runEnforce();
    this.diskTimer = setInterval(() => {
      void this.runEnforce();
    }, DISK_ENFORCE_MS);
    this.diskTimer.unref();
  }

  private async runEnforce(): Promise<void> {
    if (!this.disk) return;
    this.disk.setActivePath("telemetry", this.recorder?.activePath() ?? null);
    await this.disk.enforce();
    this.notifyStatus();
    // A fresh closed segment (or freed space) is the uploader's cue; the slow
    // disk timer doubles as its retry-safety net.
    this.uploader?.kick();
  }

  private notifyStatus(): void {
    this.opts.onStatus?.(this.status());
  }
}
