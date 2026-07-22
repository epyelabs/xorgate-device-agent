/**
 * Video capture daemon (plan D1): one supervised `gst-launch-1.0` child per
 * camera that OWNS the camera whenever video recording is enabled. It tees raw
 * frames: high-quality x264 → splitmuxsink ~60 s MP4 fragments on disk;
 * low-res raw → shmsink, which the (unchanged) KVS master consumes via a
 * `shmsrc` .gst — so live streaming keeps working, viewers or not, online or
 * not, and TWCC keeps mutating the KVS-side encoder.
 *
 * Supervision mirrors the KVS channel supervisor (agent/collectors/media.ts):
 * crash → backoff 2→30 s; 3 quick deaths (<15 s) → park with a 60 s slow
 * retry; stop = SIGINT (with gst-launch's `-e` this forces EOS so splitmuxsink
 * finalizes the current fragment with a clean moov).
 *
 * Shm bridge contract (spike-verified caps — shmsrc does NO caps negotiation,
 * both sides must state these EXACTLY): I420 1280x720 @ 15/1, the same shape
 * today's direct .gst pipelines stream. The record branch's caps come from the
 * preset; the bridge branch scales/rates down to the fixed contract.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { runStream, type StreamHandle } from "../lib/exec.js";
import { isBridgedPipeline, resolveCameraName } from "../media/pipeline.js";
import type { KvsChannel } from "../media/manifest.js";
import type { TimeSource } from "./session.js";
import { mintSessionId, readBootId } from "./session.js";
import type { VideoPreset } from "./video-presets.js";
import {
  sweepSessionDir,
  writeSessionManifest,
  type VideoSessionManifest,
} from "./video-segments.js";

/** Fixed low-res bridge caps — MUST match the bridged .gst's shmsrc caps. */
export const SHM_BRIDGE_CAPS = "video/x-raw,format=I420,width=1280,height=720,framerate=15/1";

const STABLE_MS = 15_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUICK_FAILURES = 3;
const PARKED_RETRY_MS = 60_000;
/** fs.watch fallback: a slow sweep still closes fragments if events are missed. */
const SWEEP_POLL_MS = 10_000;

export interface CaptureCamera {
  streamKey: string;
  /** libcamera camera-name (e.g. /base/axi/pcie@…/imx290@1a). */
  cameraName: string;
}

/**
 * The channels the capture daemon may own: bridged .gst (the KVS master reads
 * shm, so the camera is free for us) AND a resolvable camera identity. A
 * channel whose .gst is still direct is left alone — the KVS master owns that
 * camera (rollout safety, plan D1/DoD 8).
 */
export function resolveBridgedCameras(
  pipelineDir: string,
  channels: readonly KvsChannel[],
): CaptureCamera[] {
  const out: CaptureCamera[] = [];
  for (const ch of channels) {
    if (!isBridgedPipeline(pipelineDir, ch.streamKey)) continue;
    const cameraName = resolveCameraName(pipelineDir, ch.streamKey);
    if (!cameraName) {
      console.warn(
        `[video-capture] ${ch.streamKey}: bridged .gst but no camera identity ` +
          `(missing ${ch.streamKey}.camera) — skipping`,
      );
      continue;
    }
    out.push({ streamKey: ch.streamKey, cameraName });
  }
  return out;
}

export interface CapturePipelineSpec {
  cameraName: string;
  preset: VideoPreset;
  segmentSeconds: number;
  /** Session dir splitmuxsink writes fragments into. */
  outputDir: string;
  shmSocketPath: string;
}

/**
 * BRIDGE-ONLY pipeline (bridged .gst installed but recording.video.enabled
 * false): the daemon still owns the camera and feeds the shm socket so live
 * streaming keeps working — just no encode, no disk. Near-zero CPU (raw
 * 720p15 passthrough at the camera's native 720p mode).
 */
export function buildBridgeOnlyPipelineArgs(cameraName: string, shmSocketPath: string): string[] {
  return [
    "libcamerasrc",
    `camera-name=${cameraName}`,
    "!",
    SHM_BRIDGE_CAPS,
    "!",
    "shmsink",
    `socket-path=${shmSocketPath}`,
    "wait-for-connection=false",
    "sync=false",
    "shm-size=20971520",
  ];
}

/**
 * The capture pipeline as gst-launch argv tokens (argv, not a shell string —
 * no quoting hazards; camera names contain no spaces).
 */
export function buildCapturePipelineArgs(spec: CapturePipelineSpec): string[] {
  const { preset } = spec;
  const keyIntMax = preset.fps * 2; // one keyframe ≈ every 2 s → seekable fragments
  return [
    "-e", // EOS-on-shutdown: SIGINT finalizes the active fragment (clean moov)
    "libcamerasrc",
    `camera-name=${spec.cameraName}`,
    "!",
    `video/x-raw,format=I420,width=${preset.width},height=${preset.height},framerate=${preset.fps}/1`,
    "!",
    "tee",
    "name=t",
    "t.",
    "!",
    "queue",
    "!",
    "x264enc",
    // ultrafast, not veryfast: measured 65% vs 98% of a core per camera at
    // 1080p15-2mbps (spike) — dual-camera headroom + the PSU brownout margin
    // outweigh the compression-efficiency loss for dashcam footage.
    "speed-preset=ultrafast",
    "tune=zerolatency",
    `bitrate=${preset.bitrateKbps}`,
    `key-int-max=${keyIntMax}`,
    "!",
    "h264parse",
    "!",
    "splitmuxsink",
    // Fragmented MP4 (moov up front + a moof per second): a fragment cut off
    // by a crash/power-loss stays playable up to ~1 s before the cut, instead
    // of being a moov-less brick (hardware-verified: SIGKILL mid-fragment →
    // ffprobe reads it). One argv token: gst-launch rejoins argv with spaces
    // and its parser applies fragment-duration to the mp4mux child.
    "muxer=mp4mux fragment-duration=1000",
    `location=${join(spec.outputDir, "%05d.mp4")}`,
    `max-size-time=${BigInt(spec.segmentSeconds) * 1_000_000_000n}`,
    "t.",
    "!",
    // Leaky queue: a stalled/absent shm consumer must never back-pressure the
    // recording branch — drop bridge frames instead.
    "queue",
    "leaky=downstream",
    "max-size-buffers=5",
    "!",
    // videorate BEFORE videoscale: drop to the bridge's 15 fps first so the
    // software scaler never touches frames that would be discarded anyway
    // (matters at the 30 fps presets; measured 177%/core the wrong way round).
    "videorate",
    "!",
    "video/x-raw,framerate=15/1",
    "!",
    "videoscale",
    "!",
    SHM_BRIDGE_CAPS,
    "!",
    "shmsink",
    `socket-path=${spec.shmSocketPath}`,
    "wait-for-connection=false",
    "sync=false",
    "shm-size=20971520",
  ];
}

/**
 * Content of a BRIDGED per-stream .gst (the KVS master's pipeline when the
 * capture daemon owns the camera). Same encoder settings as today's direct
 * pipelines; `name=sampleVideoEncoder` keeps TWCC's live bitrate mutation
 * working because this encoder still lives inside the KVS process.
 */
export function bridgedKvsPipeline(shmSocketPath: string): string {
  return (
    `shmsrc socket-path=${shmSocketPath} is-live=true do-timestamp=true ! ` +
    `${SHM_BRIDGE_CAPS} ! ` +
    `x264enc name=sampleVideoEncoder bframes=0 speed-preset=ultrafast bitrate=1000 ` +
    `byte-stream=TRUE tune=zerolatency threads=2 ! ` +
    `video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! ` +
    `appsink sync=TRUE emit-signals=TRUE name=appsink-video`
  );
}

export type CaptureState = "starting" | "running" | "retrying" | "failed" | "stopped";

/** Injectable process spawner (test seam). */
export type CaptureSpawn = typeof runStream;

export interface CaptureStatus {
  streamKey: string;
  state: CaptureState;
  sessionId: string | null;
  /** True only in record mode while the child is up — NOT in bridge-only mode. */
  recording: boolean;
}

export interface VideoCaptureOptions {
  deviceId: string;
  cameras: CaptureCamera[];
  /**
   * False = bridge-only mode: bridged streams keep live-streaming (daemon owns
   * the camera, feeds shm) but nothing is written to disk and no session is
   * minted. True adds the tee → x264 → splitmuxsink branch.
   */
  record: boolean;
  preset: VideoPreset;
  segmentSeconds: number;
  /** recordings/video root; sessions land at <root>/<streamKey>/<sessionId>/. */
  videoRoot: string;
  /** Directory for shm sockets (created; sockets are <dir>/<streamKey>.sock). */
  shmDir: string;
  timeSource: () => TimeSource;
  /** A fragment closed (sidecar written) — disk-enforce/upload cue. */
  onSegmentClosed?: (mp4Path: string) => void;
  /** The active (still-being-written) fragment changed; null = none. */
  onActiveSegment?: (streamKey: string, path: string | null) => void;
  /** Any supervisor state or session change (state.json/payload cue). */
  onStatus?: () => void;
  onEvent?: (level: "info" | "warn", msg: string) => void;
  /**
   * A capture child was just spawned for this stream. The worker bounces the
   * stream's KVS master here: a master pipeline attached to the PREVIOUS shm
   * writer wedges silently when that writer dies (shmsrc shm_open loop, black
   * stream — hardware-verified), so it must be restarted onto the new socket.
   */
  onSpawned?: (streamKey: string) => void;
  /** Test seams. */
  spawn?: CaptureSpawn;
  stableMs?: number;
  sweepPollMs?: number;
}

interface CameraRun {
  cam: CaptureCamera;
  state: CaptureState;
  handle: StreamHandle | null;
  sessionId: string | null;
  sessionDir: string | null;
  manifest: VideoSessionManifest | null;
  startedAt: number;
  backoffMs: number;
  quickFailures: number;
  stableTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  watcher: FSWatcher | null;
  sweepTimer: NodeJS.Timeout | null;
  sweeping: boolean;
}

/**
 * Supervises one capture child per camera. Lifecycle: created + started when
 * `recording.video.enabled` flips on (or at boot), stopped on disable/config
 * change (the manager creates a fresh instance per config — a preset change is
 * a new session by construction, matching Phase 1's rateHz rule).
 */
export class VideoCaptureSupervisor {
  private readonly opts: VideoCaptureOptions;
  private readonly runs = new Map<string, CameraRun>();
  private stopped = false;

  constructor(opts: VideoCaptureOptions) {
    this.opts = opts;
  }

  start(): void {
    mkdirSync(this.opts.shmDir, { recursive: true });
    for (const cam of this.opts.cameras) {
      this.runs.set(cam.streamKey, {
        cam,
        state: "starting",
        handle: null,
        sessionId: null,
        sessionDir: null,
        manifest: null,
        startedAt: 0,
        backoffMs: BASE_BACKOFF_MS,
        quickFailures: 0,
        stableTimer: null,
        restartTimer: null,
        watcher: null,
        sweepTimer: null,
        sweeping: false,
      });
      this.spawn(cam.streamKey);
    }
  }

  /** SIGINT every child (EOS → clean fragment finalize), close watchers. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const run of this.runs.values()) {
      if (run.stableTimer) clearTimeout(run.stableTimer);
      if (run.restartTimer) clearTimeout(run.restartTimer);
      run.stableTimer = null;
      run.restartTimer = null;
      this.stopWatching(run);
      run.state = "stopped";
      run.handle?.stop("SIGINT");
      // Final sweep happens in onExit (the child needs a moment to finalize);
      // onExit sees this.stopped and closes out the last fragment.
    }
  }

  /**
   * Stop and WAIT for every child to actually exit (escalating to SIGKILL
   * after `graceMs`). Required before spawning a replacement supervisor: an
   * exiting shmsink unlinks its socket path on cleanup, so an old child
   * overlapping a new one deletes the NEW socket out from under it (verified
   * on hardware — consumers then fail with "Error reading control data: -4").
   */
  async stopAndWait(graceMs = 10_000): Promise<void> {
    const handles = [...this.runs.values()]
      .map((r) => r.handle)
      .filter((h): h is StreamHandle => h !== null);
    this.stop();
    if (handles.length === 0) return;
    const grace = new Promise<"timeout">((res) => {
      const t = setTimeout(() => res("timeout"), graceMs);
      t.unref();
    });
    const all = Promise.all(handles.map((h) => h.done));
    if ((await Promise.race([all, grace])) === "timeout") {
      for (const h of handles) h.stop("SIGKILL");
      await all;
    }
  }

  /** Session ids currently owned by running captures (orphan-recovery exclusion). */
  activeSessionIds(): Set<string> {
    const out = new Set<string>();
    for (const r of this.runs.values()) if (r.sessionId) out.add(r.sessionId);
    return out;
  }

  /** True while any camera is actively capturing TO DISK (payload media.recording flag). */
  anyRecording(): boolean {
    if (!this.opts.record) return false;
    return [...this.runs.values()].some((r) => r.state === "running" || r.state === "starting");
  }

  status(): CaptureStatus[] {
    return [...this.runs.values()].map((r) => ({
      streamKey: r.cam.streamKey,
      state: r.state,
      sessionId: r.sessionId,
      recording:
        this.opts.record && (r.state === "running" || r.state === "starting"),
    }));
  }

  shmSocketPath(streamKey: string): string {
    return join(this.opts.shmDir, `${streamKey}.sock`);
  }

  private spawn(streamKey: string): void {
    const run = this.runs.get(streamKey);
    if (!run || this.stopped) return;

    let args: string[];
    if (this.opts.record) {
      const sessionId = mintSessionId();
      const sessionDir = join(this.opts.videoRoot, streamKey, sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const manifest: VideoSessionManifest = {
        v: 1,
        deviceId: this.opts.deviceId,
        streamKey,
        sessionId,
        bootId: readBootId(),
        timeSource: this.opts.timeSource(),
        preset: this.opts.preset.name,
        width: this.opts.preset.width,
        height: this.opts.preset.height,
        fps: this.opts.preset.fps,
        bitrateKbps: this.opts.preset.bitrateKbps,
        segmentSeconds: this.opts.segmentSeconds,
        anchorTs: Date.now(),
        anchorMono: process.hrtime.bigint().toString(),
      };
      writeSessionManifest(sessionDir, manifest);

      run.sessionId = sessionId;
      run.sessionDir = sessionDir;
      run.manifest = manifest;
      args = buildCapturePipelineArgs({
        cameraName: run.cam.cameraName,
        preset: this.opts.preset,
        segmentSeconds: this.opts.segmentSeconds,
        outputDir: sessionDir,
        shmSocketPath: this.shmSocketPath(streamKey),
      });
    } else {
      run.sessionId = null;
      run.sessionDir = null;
      run.manifest = null;
      args = buildBridgeOnlyPipelineArgs(run.cam.cameraName, this.shmSocketPath(streamKey));
    }
    run.state = "starting";
    run.startedAt = Date.now();

    // A socket file left by a killed predecessor makes the new shmsink accept
    // nothing ("Connection refused" on the KVS side) — verified on hardware.
    try {
      unlinkSync(this.shmSocketPath(streamKey));
    } catch {
      /* absent — fine */
    }

    const spawn = this.opts.spawn ?? runStream;
    run.handle = spawn("gst-launch-1.0", args, {
      onStderr: (line) => {
        if (line.trim()) console.error(`[video-capture ${streamKey}] ${line}`);
      },
    });

    if (this.opts.record) this.watchSession(run);

    run.stableTimer = setTimeout(() => {
      if (this.stopped) return;
      if (run.handle) {
        run.state = "running";
        run.quickFailures = 0;
        run.backoffMs = BASE_BACKOFF_MS;
        this.opts.onStatus?.();
      }
    }, this.opts.stableMs ?? STABLE_MS);

    this.opts.onEvent?.(
      "info",
      this.opts.record
        ? `video capture started: ${streamKey} ${this.opts.preset.name} (session ${run.sessionId!.slice(0, 8)}…)`
        : `video bridge started: ${streamKey} (streaming only, recording off)`,
    );
    this.opts.onStatus?.();
    this.opts.onSpawned?.(streamKey);

    void run.handle.done.then((res) => this.onExit(streamKey, res.exitCode, res.notFound));
  }

  private onExit(streamKey: string, exitCode: number | null, notFound: boolean): void {
    const run = this.runs.get(streamKey);
    if (!run) return;
    if (run.stableTimer) {
      clearTimeout(run.stableTimer);
      run.stableTimer = null;
    }
    run.handle = null;
    this.stopWatching(run);

    // Close out whatever the child left: clean stop (EOS ran) → the last
    // fragment is finalized; crash → it may be truncated. Either way it gets a
    // sidecar; `finalized` records which case we believe we're in.
    const cleanStop = this.stopped;
    this.finalSweep(run, cleanStop);
    const endedSession = run.sessionId;
    run.sessionId = null;
    run.sessionDir = null;
    run.manifest = null;
    this.opts.onActiveSegment?.(streamKey, null);

    if (this.stopped) {
      run.state = "stopped";
      this.opts.onStatus?.();
      return;
    }

    const ranMs = Date.now() - run.startedAt;
    if (notFound) {
      run.state = "failed";
      this.opts.onEvent?.("warn", `video capture ${streamKey}: gst-launch-1.0 not found; parking`);
      this.scheduleRestart(run, PARKED_RETRY_MS);
      this.opts.onStatus?.();
      return;
    }
    if (ranMs >= (this.opts.stableMs ?? STABLE_MS)) {
      this.opts.onEvent?.(
        "warn",
        `video capture ${streamKey} exited (code ${exitCode ?? "?"}, session ${endedSession?.slice(0, 8) ?? "?"}…); restarting`,
      );
      run.quickFailures = 0;
      run.backoffMs = BASE_BACKOFF_MS;
      this.scheduleRestart(run);
      this.opts.onStatus?.();
      return;
    }

    run.quickFailures += 1;
    if (run.quickFailures >= MAX_QUICK_FAILURES) {
      run.state = "failed";
      this.opts.onEvent?.(
        "warn",
        `video capture ${streamKey} exited (code ${exitCode ?? "?"}) before stabilizing ` +
          `${run.quickFailures}x; parking for ${PARKED_RETRY_MS / 1000}s (camera in use? libcamera error?)`,
      );
      run.quickFailures = 0;
      run.backoffMs = BASE_BACKOFF_MS;
      this.scheduleRestart(run, PARKED_RETRY_MS);
    } else {
      run.state = "retrying";
      this.opts.onEvent?.(
        "warn",
        `video capture ${streamKey} exited (code ${exitCode ?? "?"}); retry ${run.quickFailures}/${MAX_QUICK_FAILURES} in ${run.backoffMs}ms`,
      );
      this.scheduleRestart(run);
      run.backoffMs = Math.min(run.backoffMs * 2, MAX_BACKOFF_MS);
    }
    this.opts.onStatus?.();
  }

  private scheduleRestart(run: CameraRun, delayMs = run.backoffMs): void {
    if (this.stopped) return;
    run.restartTimer = setTimeout(() => {
      run.restartTimer = null;
      this.spawn(run.cam.streamKey);
    }, delayMs);
  }

  /** fs.watch + slow poll → sweep: sidecar closed fragments, track the active one. */
  private watchSession(run: CameraRun): void {
    const dir = run.sessionDir!;
    try {
      run.watcher = watch(dir, () => this.sweep(run));
    } catch {
      run.watcher = null; // poll still covers us
    }
    run.sweepTimer = setInterval(() => this.sweep(run), this.opts.sweepPollMs ?? SWEEP_POLL_MS);
    run.sweepTimer.unref();
  }

  private stopWatching(run: CameraRun): void {
    run.watcher?.close();
    run.watcher = null;
    if (run.sweepTimer) clearInterval(run.sweepTimer);
    run.sweepTimer = null;
  }

  private sweep(run: CameraRun): void {
    if (!run.sessionDir || !run.manifest || run.sweeping) return;
    run.sweeping = true;
    try {
      const res = sweepSessionDir(run.sessionDir, run.manifest, { includeNewest: false });
      this.opts.onActiveSegment?.(run.cam.streamKey, res.activePath);
      for (const mp4 of res.closed) this.opts.onSegmentClosed?.(mp4);
      // splitmuxsink never fsyncs; on a hard power cut the ACTIVE fragment's
      // data dies in the page cache (hardware-observed: 0-byte file after a
      // brownout). Syncing it on the sweep cadence bounds that loss to
      // ~SWEEP_POLL_MS instead of a whole fragment. (Same data volume reaches
      // the flash either way — this only moves it earlier.)
      if (res.activePath) {
        try {
          const fd = openSync(res.activePath, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          /* rotated away mid-sweep — fine */
        }
      }
    } finally {
      run.sweeping = false;
    }
  }

  private finalSweep(run: CameraRun, cleanStop: boolean): void {
    if (!run.sessionDir || !run.manifest) return;
    // Clean stop: EOS finalized everything, newest included. Crash: only the
    // newest is suspect — the per-fragment default (finalized = !isNewest)
    // already encodes that, so don't override it.
    const res = sweepSessionDir(run.sessionDir, run.manifest, {
      includeNewest: true,
      ...(cleanStop ? { finalized: true } : {}),
    });
    for (const mp4 of res.closed) this.opts.onSegmentClosed?.(mp4);
  }
}
