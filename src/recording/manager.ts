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
import {
  recordingsRoot,
  resolveRecordingConfig,
  shmDir,
  telemetryRoot,
  videoRoot,
  type ResolvedRecordingConfig,
} from "./config.js";
import { DiskManager } from "./disk.js";
import { finalizeOrphanSegments } from "./segments.js";
import { TelemetryRecorder } from "./telemetry-recorder.js";
import {
  BootDeferPolicy,
  LoadShedPolicy,
  type BootDeferVerdict,
  type PowerSampleReading,
  type ShedLevel,
  type ShedVerdict,
} from "./boot-policy.js";
import {
  createTimeSourceTracker,
  mintSessionId,
  readBootId,
  type TimeSourceTracker,
} from "./session.js";
import { createTelemetrySource } from "./telemetry-source.js";
import { createVideoSource } from "./video-source.js";
import { Uploader, type PutFn, type SegmentSource } from "./uploader.js";
import {
  VideoCaptureSupervisor,
  type CaptureCamera,
  type CaptureSpawn,
  type CaptureStatus,
} from "./video-capture.js";
import { resolveVideoPreset } from "./video-presets.js";
import { recoverOrphanVideoSessions } from "./video-segments.js";

/** How often settings.json is re-checked for recording changes. */
const SETTINGS_POLL_MS = 5_000;
/**
 * Cap on the startup timeSource probe await: a hung timedatectl must not delay
 * recording start — on timeout we proceed with the tracker's current
 * (pessimistic) value and the probe finishes in the background.
 */
const TIME_PROBE_TIMEOUT_MS = 2_000;
/** Slow disk-pressure sweep; rotations also trigger enforcement directly. */
const DISK_ENFORCE_MS = 60_000;
/**
 * Load-shedding power sample cadence (Phase 3). Matches the system collector's
 * native 1 Hz sample cache, so this tick reuses the same vcgencmd reads as the
 * telemetry recorder rather than adding a second poller.
 */
const SHED_SAMPLE_MS = 1_000;

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

/**
 * Video capture plumbing injected by the worker (Phase 3). Absent on hosts
 * without cameras/media. `cameras()` is re-resolved on every (re)start of the
 * capture supervisor — it reads the pipeline dir, so a `xorgate pipeline
 * bridge` still needs the usual agent restart to be picked up.
 */
export interface RecordingVideoOptions {
  /** The worker's media-enabled snapshot; false = never spawn capture daemons. */
  mediaEnabled: boolean;
  /** Bridged streams with resolvable camera identity (see resolveBridgedCameras). */
  cameras(): CaptureCamera[];
  /** Bounce a stream's KVS master after its capture child (re)spawns. */
  onCaptureSpawned?: (streamKey: string) => void;
  /**
   * Shed rung 1 (Phase 3): park (true) / release (false) the live KVS masters.
   * The worker wires this to the media supervisor; parked masters are held
   * down until released. Absent on hosts without live streaming.
   */
  setLiveShed?: (shed: boolean) => void;
  /** Overrides for tests. */
  shmDir?: string;
  spawn?: CaptureSpawn;
  stableMs?: number;
  sweepPollMs?: number;
}

/** Video state for the payload/state.json media block. */
export interface VideoRecordingStatus {
  /** True while ≥1 camera is actively capturing to disk (media.recording flag). */
  recording: boolean;
  streams: CaptureStatus[];
}

export interface RecordingManagerOptions {
  deviceId: string;
  sampleGroups(): Promise<Record<string, GroupSample>>;
  /** Video capture plumbing; omit to disable video entirely (telemetry-only). */
  video?: RecordingVideoOptions;
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
  timeSource?: TimeSourceTracker;
  timeProbeTimeoutMs?: number;
  /** Boot power staging policy override (tests inject fake telemetry/budget). */
  bootPolicy?: BootDeferPolicy;
  /**
   * ~1 Hz power reading for load shedding (Phase 3); the worker wires the
   * system collector's cached sampler. null = no reading this tick (off-Pi,
   * vcgencmd absent/failed) — the policy then simply never triggers.
   */
  powerSample?: () => Promise<PowerSampleReading | null>;
  /** Load-shedding policy override (tests inject a fake clock). */
  shedPolicy?: LoadShedPolicy;
  shedSampleMs?: number;
}

export class RecordingManager {
  private readonly opts: RecordingManagerOptions;
  private readonly root: string;
  private readonly timeSource: TimeSourceTracker;
  private stopRequested = false;
  private cfg: ResolvedRecordingConfig;
  private recorder: TelemetryRecorder | null = null;
  private sessionId: string | null = null;
  private disk: DiskManager | null = null;
  private uploader: Uploader | null = null;
  private videoCapture: VideoCaptureSupervisor | null = null;
  private videoKey = "";
  /** Boot power staging (Phase 2): may heavy encoders start yet? */
  private readonly bootPolicy: BootDeferPolicy;
  /** Last boot-defer status string that was logged/published (dedupe key). */
  private bootDeferStatus: string | null = null;
  /** Runtime undervoltage load shedding (Phase 3). */
  private readonly shedPolicy: LoadShedPolicy;
  private shedTimer: NodeJS.Timeout | null = null;
  /** Current rung as published in status(); null = full operation / inert. */
  private shedStatus: string | null = null;
  private shedLevel: ShedLevel = 0;
  /** Whether the live KVS masters are currently parked by rung 1. */
  private liveShed = false;
  /** powerShedding namespace fingerprint — a change resets the policy (clears park). */
  private shedCfgKey: string;
  /** Serializes capture stop→start handovers (see applyVideo). */
  private videoTransition: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private lastSettingsKey = "";

  constructor(opts: RecordingManagerOptions) {
    this.opts = opts;
    this.timeSource = opts.timeSource ?? createTimeSourceTracker();
    this.bootPolicy = opts.bootPolicy ?? new BootDeferPolicy();
    this.shedPolicy = opts.shedPolicy ?? new LoadShedPolicy();
    this.root = opts.root ?? recordingsRoot();
    this.cfg = resolveRecordingConfig(loadSettings().recording);
    this.shedCfgKey = JSON.stringify(this.cfg.powerShedding);
    if (opts.upload) this.uploader = this.buildUploader(opts.upload);
  }

  private buildUploader(upload: RecordingUploadOptions): Uploader {
    return new Uploader({
      sources: [
        createTelemetrySource(this.opts.deviceId, telemetryRoot(this.root)),
        // Video pairs (Phase 4). Registered even on camera-less hosts — with
        // no video tree it lists nothing, and it still drains leftovers if
        // video is later disabled/unbridged.
        createVideoSource(this.opts.deviceId, videoRoot(this.root), {
          isSessionActive: (sessionId) =>
            this.videoCapture?.activeSessionIds().has(sessionId) ?? false,
        }),
        ...(upload.extraSources ?? []),
      ],
      put: upload.put,
      isOnline: upload.isOnline,
      mode: () => this.cfg.upload.mode,
      backoffMinMs: upload.backoffMinMs,
      backoffMaxMs: upload.backoffMaxMs,
      onStatus: () => this.notifyStatus(),
      onEvent: (level, msg) => this.opts.onEvent?.(level, msg),
      onUploaded: () => {
        // Refresh backlog gauges (and let eviction see the freed space).
        void this.runEnforce();
      },
    });
  }

  /**
   * Arm (or re-arm) segment uploads live — the Phase 6.2 uploadBucket backfill:
   * a device that booted without a bucket in kvs.json gets one over the
   * retained config message and must start uploading without a restart. A
   * previously armed uploader is stopped and replaced (its PUT closure captured
   * the old bucket). No-op when the worker still has no upload target.
   */
  setUpload(upload: RecordingUploadOptions | undefined): void {
    if (!upload) return;
    this.uploader?.stop();
    this.uploader = this.buildUploader(upload);
    this.uploader.kick();
  }

  /**
   * Startup: crash-recover any earlier run's segments, probe the time source,
   * then apply current settings. The probe is awaited BEFORE the first apply()
   * so the first session headers/manifests carry the real provenance instead of
   * the tracker's pessimistic initial "unsynced" — but bounded by
   * TIME_PROBE_TIMEOUT_MS so a hung timedatectl can never delay recording.
   */
  async start(): Promise<void> {
    // Only touch the tree if a previous run created it — a device that has
    // never recorded stays byte-identical to today (no dirs, no counters).
    if (existsSync(this.root)) {
      const finalized = finalizeOrphanSegments(telemetryRoot(this.root));
      if (finalized > 0) {
        this.opts.onEvent?.("info", `recording: finalized ${finalized} orphan segment(s) from previous run`);
      }
      // Video crash recovery runs before any capture spawns, so every session
      // on disk belongs to a previous run — sidecar-backfill all of them.
      const recovered = recoverOrphanVideoSessions(videoRoot(this.root));
      if (recovered > 0) {
        this.opts.onEvent?.("info", `recording: backfilled ${recovered} video sidecar(s) from previous run`);
      }
      this.ensureDisk();
    }
    this.lastSettingsKey = this.settingsKey();
    await Promise.race([
      this.timeSource.refresh().catch(() => {}),
      new Promise<void>((res) => {
        setTimeout(res, this.opts.timeProbeTimeoutMs ?? TIME_PROBE_TIMEOUT_MS).unref();
      }),
    ]);
    if (this.stopRequested) return; // stopped while awaiting the probe
    this.apply();
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
    if (key !== this.lastSettingsKey) {
      this.lastSettingsKey = key;
      this.cfg = resolveRecordingConfig(loadSettings().recording);
      this.apply();
      return;
    }
    // Settings unchanged, but the boot-defer verdict can still flip on its own
    // (modem settled, telemetry gone stale, hard cap elapsed) — re-run the
    // video diff, which no-ops unless the effective tuple actually changed.
    this.applyVideo();
  }

  /** Sync shutdown: finalize the active segment, stop all timers. */
  stop(): void {
    this.stopRequested = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    if (this.shedTimer) clearInterval(this.shedTimer);
    this.pollTimer = null;
    this.diskTimer = null;
    this.shedTimer = null;
    this.uploader?.stop();
    this.stopRecorder("agent shutdown");
    this.videoCapture?.stop();
    this.videoCapture = null;
    this.videoKey = "";
  }

  /** Video state for the worker's media block + state.json. */
  videoStatus(): VideoRecordingStatus {
    return {
      recording: this.videoCapture?.anyRecording() ?? false,
      streams: this.videoCapture?.status() ?? [],
    };
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
      // Boot power staging verdict (Phase 2); absent until the video path
      // first consulted the policy (video off / no cameras / telemetry-only).
      ...(this.bootDeferStatus !== null ? { bootDefer: this.bootDeferStatus } : {}),
      // Load-shedding rung (Phase 3); absent at full operation.
      ...(this.shedStatus !== null ? { powerShed: this.shedStatus } : {}),
    };
  }

  private settingsKey(): string {
    return JSON.stringify(loadSettings().recording ?? null);
  }

  private apply(): void {
    this.disk?.setRetention(this.cfg.retention);

    // A powerShedding settings change resets the ladder (clears park + the
    // cycle cap) — the documented operator escape hatch short of a reboot.
    const shedKey = JSON.stringify(this.cfg.powerShedding);
    if (shedKey !== this.shedCfgKey) {
      this.shedCfgKey = shedKey;
      this.shedPolicy.reset();
    }

    const want = this.cfg.telemetry.enabled;
    const rateChanged =
      this.recorder !== null && this.activeRateHz !== this.cfg.telemetry.rateHz;

    if (this.recorder && (!want || rateChanged)) {
      this.stopRecorder(rateChanged ? "rateHz changed" : "recording disabled");
    }
    if (want && !this.recorder) this.startRecorder();

    this.applyVideo();

    this.notifyStatus();
    this.uploader?.kick(); // upload.mode may have flipped to auto
  }

  /**
   * (Re)start capture daemons to match config. Any change in the effective
   * video tuple (cameras, record on/off, preset, segmentSeconds) replaces the
   * whole supervisor — a config change is a new session by construction, and
   * the KVS children crash-restart onto the new shm feed (brief stream blip,
   * accepted by the plan).
   */
  private applyVideo(): void {
    const vo = this.opts.video;
    if (!vo) return;
    const cameras = vo.mediaEnabled ? vo.cameras() : [];
    // Runtime undervoltage shedding (Phase 3): armed only while a bridged
    // camera exists (the heavy-load case this protects); null = feature inert,
    // behave exactly as today.
    const shed = this.updateShedMonitor(cameras.length > 0);
    const shedLive = shed !== null && shed.level >= 1;
    if (shedLive !== this.liveShed) {
      this.liveShed = shedLive;
      vo.setLiveShed?.(shedLive);
    }
    // Boot power staging (Phase 2): while the modem is still bringing up LTE
    // on a constrained supply budget, run bridge-only (record=false) so live
    // streaming can attach but no x264 encoder competes with the attach/TX
    // power draw. The policy latches its first allow — after that this is a
    // plain pass-through of recording.video.enabled.
    let record = this.cfg.video.enabled;
    if (record && cameras.length > 0) {
      const verdict = this.bootPolicy.evaluate({
        mode: this.cfg.video.bootDefer,
        maxSecs: this.cfg.video.bootDeferMaxSecs,
        minBudgetMa: this.cfg.video.bootDeferMinBudgetMa,
      });
      record = verdict.allow;
      this.noteBootDefer(verdict);
    }
    // Shed rung 2: recording off, bridge-only (telemetry recording — the
    // crash evidence — keeps running; it is not touched by the ladder).
    if (record && shed !== null && shed.level >= 2) record = false;
    const preset = resolveVideoPreset(this.cfg.video.preset);
    const key = JSON.stringify({
      cameras,
      record,
      preset: preset.name,
      seg: this.cfg.video.segmentSeconds,
      stagger: this.cfg.video.spawnStaggerSecs,
    });
    if (key === this.videoKey) return;
    this.videoKey = key;

    const prev = this.videoCapture;
    this.videoCapture = null;
    if (cameras.length === 0) {
      if (prev) this.videoTransition = this.videoTransition.then(() => prev.stopAndWait());
      if (record) {
        this.opts.onEvent?.(
          "warn",
          "recording.video.enabled is on but no bridged camera is available " +
            "(media off, or no `xorgate pipeline bridge <streamKey>` run) — video recording idle",
        );
      }
      return;
    }
    if (record) this.ensureDisk();
    // Serialize the handover: the old children MUST be gone before the new
    // ones bind the shm sockets (an exiting shmsink unlinks its socket path,
    // which would tear the fresh one down — hardware-verified race).
    this.videoTransition = this.videoTransition.then(async () => {
      if (prev) await prev.stopAndWait();
      if (this.videoKey !== key) return; // superseded by a newer config change
      this.startVideo(cameras, record, preset);
    });
  }

  /**
   * Arm/disarm the shed monitor and evaluate the ladder for this apply pass.
   * Armed: a 1 s sample tick feeds the policy (reusing the system collector's
   * cached power reads). Disarmed (no cameras, feature disabled, no sampler):
   * everything resets — fail open, zero behavior change vs. today.
   */
  private updateShedMonitor(camerasPresent: boolean): ShedVerdict | null {
    const armed =
      camerasPresent && this.cfg.powerShedding.enabled && this.opts.powerSample !== undefined;
    if (!armed) {
      if (this.shedTimer) {
        clearInterval(this.shedTimer);
        this.shedTimer = null;
      }
      this.shedPolicy.reset();
      this.shedLevel = 0;
      if (this.shedStatus !== null) {
        this.shedStatus = null;
        this.opts.onEvent?.("info", "power shedding disarmed — restoring full operation");
        this.notifyStatus();
      }
      return null;
    }
    if (!this.shedTimer) {
      this.shedTimer = setInterval(() => {
        void this.shedTick();
      }, this.opts.shedSampleMs ?? SHED_SAMPLE_MS);
      this.shedTimer.unref();
    }
    return this.evaluateShed();
  }

  /** One shed-monitor tick: sample power, evaluate, re-apply on a rung change. */
  private async shedTick(): Promise<void> {
    if (this.stopRequested) return;
    try {
      const reading = await this.opts.powerSample!();
      if (reading) this.shedPolicy.push(reading);
    } catch {
      /* fail open: no sample, no shed */
    }
    if (this.stopRequested) return;
    const before = this.shedLevel;
    const verdict = this.evaluateShed();
    // A rung change flows through applyVideo — the same choke point as every
    // other lifecycle change (it re-evaluates; transitions are idempotent).
    if (verdict.level !== before) this.applyVideo();
  }

  /** Evaluate the ladder, logging transitions and publishing the rung status. */
  private evaluateShed(): ShedVerdict {
    const verdict = this.shedPolicy.evaluate(this.cfg.powerShedding);
    this.shedLevel = verdict.level;
    if (verdict.event) this.opts.onEvent?.(verdict.event.level, verdict.event.msg);
    const status = this.shedPolicy.statusString();
    if (status !== this.shedStatus) {
      this.shedStatus = status;
      this.notifyStatus();
    }
    return verdict;
  }

  /**
   * Log + publish boot-defer transitions exactly once per state change so a
   * field drive can be audited from the journal/state.json afterwards.
   */
  private noteBootDefer(verdict: BootDeferVerdict): void {
    const status = verdict.state === "released" ? `released:${verdict.why}` : verdict.state;
    if (status === this.bootDeferStatus) return;
    this.bootDeferStatus = status;
    const msg =
      verdict.state === "deferring"
        ? `video boot-defer armed (${verdict.why}) — bridge-only until the modem settles ` +
          `(cap ${this.cfg.video.bootDeferMaxSecs}s)`
        : verdict.state === "skipped"
          ? `video boot-defer skipped: ${verdict.why}`
          : verdict.state === "released"
            ? `video boot-defer released (${verdict.why}) — starting full capture`
            : `video boot-defer off (${verdict.why})`;
    this.opts.onEvent?.("info", msg);
    this.notifyStatus();
  }

  private startVideo(
    cameras: CaptureCamera[],
    record: boolean,
    preset: ReturnType<typeof resolveVideoPreset>,
  ): void {
    const vo = this.opts.video!;
    this.videoCapture = new VideoCaptureSupervisor({
      deviceId: this.opts.deviceId,
      cameras,
      record,
      preset,
      segmentSeconds: this.cfg.video.segmentSeconds,
      staggerMs: this.cfg.video.spawnStaggerSecs * 1000,
      videoRoot: videoRoot(this.root),
      shmDir: vo.shmDir ?? shmDir(),
      timeSource: () => this.timeSource.current(),
      onSegmentClosed: () => {
        void this.runEnforce();
      },
      onActiveSegment: (streamKey, path) => {
        this.disk?.setActivePath(`video:${streamKey}`, path);
      },
      onStatus: () => this.notifyStatus(),
      onEvent: (level, msg) => this.opts.onEvent?.(level, msg),
      onSpawned: (streamKey) => vo.onCaptureSpawned?.(streamKey),
      spawn: vo.spawn,
      stableMs: vo.stableMs,
      sweepPollMs: vo.sweepPollMs,
    });
    this.videoCapture.start();
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
