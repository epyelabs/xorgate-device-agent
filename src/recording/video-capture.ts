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
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { setPriority } from "node:os";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { runStream, type StreamHandle } from "../lib/exec.js";
import { isBridgedPipeline, resolveCameraName } from "../media/pipeline.js";
import {
  buildBridgedKvsPipeline,
  buildRecordEncodeArgs,
  SHM_BRIDGE_CAPS,
} from "../media/pipeline-builder.js";
import type { EncoderToken } from "../hardware/hardware-config.js";
import type { KvsChannel } from "../media/manifest.js";
import type { TimeSource } from "./session.js";
import { mintSessionId, readBootId } from "./session.js";
import type { VideoPreset } from "./video-presets.js";
import {
  sweepSessionDir,
  writeSessionManifest,
  type VideoSessionManifest,
} from "./video-segments.js";

/** Fixed low-res bridge caps — re-exported from the pipeline-builder (cm4-support). */
export { SHM_BRIDGE_CAPS };

const STABLE_MS = 15_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUICK_FAILURES = 3;
const PARKED_RETRY_MS = 60_000;
/** fs.watch fallback: a slow sweep still closes fragments if events are missed. */
const SWEEP_POLL_MS = 10_000;
/**
 * Progress watchdog (hardware-reproduced 2026-08-06, `1080p30-4mbps` on the
 * bench IMX290): a capture child can spawn cleanly, negotiate its stream, and
 * then never receive a single frame — every thread parked in futex/poll,
 * 0.3 s of CPU in 25 s, a 0-byte fragment, and NOTHING on stderr. The process
 * never exits, so crash/backoff/quickFailures never fire and the run sits at
 * "running" forever while the device reports `recording: true`. Liveness is
 * therefore not evidence of capture: a run that has put no bytes on disk for
 * this long is treated as failed.
 *
 * Deliberately generous — a false positive kills a HEALTHY capture. mp4mux
 * (fragment-duration=1000) lands real bytes within ~2-4 s of the first frame
 * even at the cheapest preset, so 45 s is ~10x margin, and the check rides
 * the 10 s sweep so detection costs at most one extra tick.
 */
const STALL_MS = 45_000;
/** Consecutive stalls before the camera parks on the slow retry. */
const MAX_STALL_FAILURES = 3;
/**
 * Where shmsink's POSIX shared-memory areas land (`shm_open` → tmpfs on Linux).
 * It names them `shmpipe.<pid>.<n>` and unlinks them in its OWN cleanup — which
 * a SIGKILL skips, stranding `shm-size` (20 MB) of RAM until reboot.
 */
const SHM_SEGMENT_DIR = "/dev/shm";

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

/**
 * The pipeline HEAD — the element(s) that produce raw frames for the tee.
 * Today that is `libcamerasrc camera-name=<cam>`; the device-simulator plan's
 * Phase 0 spike replaces it, in a container with no camera, with a real-time
 * paced file decode (`filesrc … ! avdec_h264 ! identity sync=true ! … !
 * videorate`) via XORGATE_CAPTURE_SOURCE_HEAD. Whitespace-split into argv
 * tokens (no quoting hazards: paths and element names carry no spaces).
 * Everything after the head — caps, tee, x264enc → splitmuxsink, shmsink —
 * is untouched. Absent the env var: byte-for-byte today's head.
 */
function captureSourceHead(cameraName: string, head?: string[]): string[] {
  // Replay mode (device-simulator Phase 2) hands the head in explicitly; the
  // env override below stays as the Phase 0 test seam. Neither is set on a Pi.
  if (head && head.length > 0) return head;
  const override = process.env.XORGATE_CAPTURE_SOURCE_HEAD?.trim();
  if (override) return override.split(/\s+/);
  return ["libcamerasrc", `camera-name=${cameraName}`];
}

/**
 * gst-launch-1.0 prints these on STDOUT. "New clock:" is logged the instant
 * the pipeline reaches PLAYING — for a file source that is when frames start
 * flowing at real time, i.e. the replay lap's true start. "Got EOS" is the
 * natural end of a file source (the lap's end); a SIGINT stop with `-e` logs it
 * too, which the supervisor already treats as clean.
 */
const GST_PLAYING_RE = /New clock:/;
const GST_EOS_RE = /Got EOS from element/;

export interface CapturePipelineSpec {
  cameraName: string;
  /** Explicit pipeline head (replay mode); absent = libcamerasrc for `cameraName`. */
  head?: string[];
  preset: VideoPreset;
  segmentSeconds: number;
  /** Session dir splitmuxsink writes fragments into. */
  outputDir: string;
  shmSocketPath: string;
  /**
   * Encoder token from the device's hardware block (cm4-support D6): the
   * recording branch follows the model — `hw-h264` (v4l2h264enc) on the CM4,
   * `sw-h264` (x264enc, today's exact argv) everywhere else. Absent = sw.
   */
  encoder?: EncoderToken;
}

/**
 * BRIDGE-ONLY pipeline (bridged .gst installed but recording.video.enabled
 * false): the daemon still owns the camera and feeds the shm socket so live
 * streaming keeps working — just no encode, no disk. Near-zero CPU (raw
 * 720p15 passthrough at the camera's native 720p mode).
 */
export function buildBridgeOnlyPipelineArgs(
  cameraName: string,
  shmSocketPath: string,
  head?: string[],
): string[] {
  return [
    ...captureSourceHead(cameraName, head),
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
    ...captureSourceHead(spec.cameraName, spec.head),
    "!",
    `video/x-raw,format=I420,width=${preset.width},height=${preset.height},framerate=${preset.fps}/1`,
    "!",
    "tee",
    "name=t",
    "t.",
    "!",
    "queue",
    "!",
    // Encoder stage from the tested per-token template (cm4-support D6):
    // x264enc argv byte-identical to the pre-plan pipeline for sw-h264, the
    // Appendix-A v4l2h264enc control set (preset bitrate/GOP) for hw-h264.
    ...buildRecordEncodeArgs(spec.encoder ?? "sw-h264", preset.bitrateKbps, keyIntMax),
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
 * capture daemon owns the camera). Delegates to the single pipeline-builder
 * (cm4-support): sw-h264 stays byte-for-byte what this function has always
 * returned; pass the device's encoder token for the hardware variant.
 */
export function bridgedKvsPipeline(
  shmSocketPath: string,
  encoder: EncoderToken = "sw-h264",
): string {
  return buildBridgedKvsPipeline(encoder, shmSocketPath);
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
  /** Recording encoder token (cm4-support D6); absent = sw-h264 (today's argv). */
  encoder?: EncoderToken;
  /**
   * Inter-camera spawn delay (Phase 2 staged boot): camera N starts N*staggerMs
   * after start(). The 2026-07-21 bench brownouts fired within seconds of the
   * SECOND encoder starting — the start-up transient matters, so offset it.
   * 0/absent = spawn all cameras synchronously (old behavior). Applies on
   * every supervisor (re)start, not just boot.
   */
  staggerMs?: number;
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
  // --- replay-mode hooks (device-simulator plan, Phase 2). All optional; a
  // real device sets none of them and every path below is byte-for-byte the
  // pre-plan behaviour. ---
  /**
   * Pipeline HEAD per camera (the element(s) producing raw frames for the
   * tee); absent = `libcamerasrc camera-name=<cam>`. Re-evaluated on EVERY
   * spawn, so a scenario switch takes effect at the next lap.
   */
  sourceHead?: (cam: CaptureCamera) => string[];
  /** gst-launch reported PLAYING ("New clock:") — frames are flowing from `wallMs`. */
  onPlaying?: (streamKey: string, wallMs: number) => void;
  /** A capture child exited and its session was swept; `clean` = EOS ran (last fragment finalized). */
  onEnded?: (streamKey: string, clean: boolean) => void;
  /**
   * Treat a child that printed "Got EOS" before exiting as a CLEAN stop: the
   * last fragment is `finalized:true` and the respawn is scheduled through
   * `respawnHoldMs` instead of the crash backoff. A file source ends every lap
   * this way (Phase 0 surprise 5: EOF exits with code 1 because shmsink's
   * teardown complains, which read as a crash). Off = today's behaviour.
   */
  eosIsClean?: boolean;
  /**
   * Delay before respawning after a clean EOS end or a `cycle()` — the parked
   * gap between laps. null = do not respawn (park as `stopped`) until the next
   * `cycle()`. Only consulted when `eosIsClean` or `cycle()` made the stop clean.
   */
  respawnHoldMs?: (streamKey: string) => number | null;
  /** Test seams. */
  spawn?: CaptureSpawn;
  stableMs?: number;
  sweepPollMs?: number;
  /** Progress-watchdog patience; defaults to STALL_MS. */
  stallMs?: number;
  /** Where to reap orphaned shmsink segments; defaults to SHM_SEGMENT_DIR. */
  shmSegmentDir?: string;
}

interface CameraRun {
  cam: CaptureCamera;
  state: CaptureState;
  /** Being removed by setCameras: stop cleanly, never respawn, then forget. */
  retiring: boolean;
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
  /** Progress watchdog: the fragment last seen growing, its size, and when. */
  progressPath: string | null;
  progressBytes: number;
  progressAt: number;
  /** This run is being torn down by the progress watchdog (not a crash). */
  stalled: boolean;
  /**
   * Consecutive stalls. Unlike `quickFailures` this is NOT cleared by the
   * stable timer — a stalled child stays up well past STABLE_MS, so anything
   * the liveness timer resets would never accumulate. Only observed bytes
   * clear it.
   */
  stallFailures: number;
  /** gst-launch printed "Got EOS" (the file source ran out, or `-e` + SIGINT finalized). */
  eosSeen: boolean;
  /** Being ended on purpose by `cycle()`: clean stop, respawn after the hold. */
  cycling: boolean;
  /** `onPlaying` already fired for this child. */
  playingReported: boolean;
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
    this.launch(this.opts.cameras);
  }

  /**
   * Per-camera capacity changes (Phase 6): bring the running set to exactly
   * `cameras` WITHOUT disturbing the cameras that stay. A removed camera is
   * SIGINT-ed (EOS → its last fragment finalizes and sweeps like any clean
   * stop) and forgotten; an added one spawns fresh. The manager uses this
   * instead of replacing the supervisor so toggling cam1 never cuts cam0's
   * session — everything else about the video tuple (preset, record, segment
   * length) still means a full replacement.
   */
  async setCameras(cameras: readonly CaptureCamera[]): Promise<void> {
    if (this.stopped) return;
    mkdirSync(this.opts.shmDir, { recursive: true });
    const wanted = new Map(cameras.map((c) => [c.streamKey, c]));
    const retired: Promise<unknown>[] = [];
    for (const [streamKey, run] of [...this.runs]) {
      if (wanted.has(streamKey)) continue;
      run.retiring = true;
      if (run.stableTimer) clearTimeout(run.stableTimer);
      if (run.restartTimer) clearTimeout(run.restartTimer);
      run.stableTimer = null;
      run.restartTimer = null;
      this.stopWatching(run);
      if (run.handle) {
        // onExit finalizes + sweeps, then drops the run from the map.
        retired.push(run.handle.done);
        run.handle.stop("SIGINT");
      } else {
        this.finalSweep(run, true);
        this.runs.delete(streamKey);
      }
      this.opts.onEvent?.("info", `video capture stopped: ${streamKey} (camera disabled)`);
    }
    this.launch(cameras.filter((c) => !this.runs.has(c.streamKey)));
    this.opts.onStatus?.();
    await Promise.all(retired);
  }

  /** Create + (staggered) spawn a set of runs. Shared by start() and setCameras(). */
  private launch(cameras: readonly CaptureCamera[]): void {
    const staggerMs = this.opts.staggerMs ?? 0;
    let index = 0;
    for (const cam of cameras) {
      const run: CameraRun = {
        cam,
        state: "starting",
        retiring: false,
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
        progressPath: null,
        progressBytes: 0,
        progressAt: 0,
        stalled: false,
        stallFailures: 0,
        eosSeen: false,
        cycling: false,
        playingReported: false,
      };
      this.runs.set(cam.streamKey, run);
      const delayMs = index * staggerMs;
      index += 1;
      if (delayMs <= 0) {
        this.spawn(cam.streamKey);
      } else {
        // Staggered bring-up rides the restart-timer slot so stop() cancels a
        // still-pending first spawn the same way it cancels a retry.
        run.restartTimer = setTimeout(() => {
          run.restartTimer = null;
          this.spawn(cam.streamKey);
        }, delayMs);
      }
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

  /**
   * End this camera's current child CLEANLY and respawn it after
   * `respawnHoldMs` (replay mode: a scenario switch, or "power on" after a
   * parked `loop:false`). SIGINT with `-e` finalizes the active fragment; the
   * respawn is a new session with a freshly evaluated `sourceHead`. A parked
   * or retrying camera (no child) is simply spawned now.
   */
  cycle(streamKey: string): void {
    const run = this.runs.get(streamKey);
    if (!run || this.stopped || run.retiring) return;
    if (run.restartTimer) {
      clearTimeout(run.restartTimer);
      run.restartTimer = null;
    }
    if (run.handle) {
      run.cycling = true;
      run.handle.stop("SIGINT");
      return;
    }
    this.spawn(streamKey);
  }

  /** `cycle()` every camera. */
  cycleAll(): void {
    for (const streamKey of [...this.runs.keys()]) this.cycle(streamKey);
  }

  /** True while any camera is actively capturing TO DISK (payload media.recording flag). */
  anyRecording(): boolean {
    if (!this.opts.record) return false;
    return [...this.runs.values()].some((r) => this.isRecording(r));
  }

  status(): CaptureStatus[] {
    return [...this.runs.values()].map((r) => ({
      streamKey: r.cam.streamKey,
      state: r.state,
      sessionId: r.sessionId,
      recording: this.opts.record && this.isRecording(r),
    }));
  }

  /**
   * "Recording" = the child is up AND we still have reason to believe it is
   * writing. Being up is reason enough only until this camera has stalled
   * once; after that the claim must be earned by observed bytes. Without that
   * second clause a permanently stalled camera would keep reporting
   * `recording: true` for the ~45 s of every kill/retry cycle — the very lie
   * this watchdog exists to stop — while still being honest about the couple
   * of seconds a healthy child needs before its first fragment appears.
   */
  private isRecording(r: CameraRun): boolean {
    if (r.state !== "running" && r.state !== "starting") return false;
    return r.stallFailures === 0 || r.progressBytes > 0;
  }

  shmSocketPath(streamKey: string): string {
    return join(this.opts.shmDir, `${streamKey}.sock`);
  }

  private spawn(streamKey: string): void {
    const run = this.runs.get(streamKey);
    if (!run || this.stopped || run.retiring) return;

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
        head: this.opts.sourceHead?.(run.cam),
        preset: this.opts.preset,
        segmentSeconds: this.opts.segmentSeconds,
        outputDir: sessionDir,
        shmSocketPath: this.shmSocketPath(streamKey),
        ...(this.opts.encoder ? { encoder: this.opts.encoder } : {}),
      });
    } else {
      run.sessionId = null;
      run.sessionDir = null;
      run.manifest = null;
      args = buildBridgeOnlyPipelineArgs(
        run.cam.cameraName,
        this.shmSocketPath(streamKey),
        this.opts.sourceHead?.(run.cam),
      );
    }
    run.state = "starting";
    run.startedAt = Date.now();
    // Fresh watchdog baseline per child; `stallFailures` deliberately survives
    // the respawn so a camera that stalls every time eventually parks.
    run.progressPath = null;
    run.progressBytes = 0;
    run.progressAt = run.startedAt;
    run.stalled = false;
    run.eosSeen = false;
    run.cycling = false;
    run.playingReported = false;

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
      // gst-launch's own progress lines ride stdout. Consumed always (an
      // unread pipe could block a chatty child); ACTED on only by the replay
      // hooks, which a real device never installs.
      onStdout: (line) => {
        if (GST_EOS_RE.test(line)) run.eosSeen = true;
        if (!run.playingReported && GST_PLAYING_RE.test(line)) {
          run.playingReported = true;
          this.opts.onPlaying?.(streamKey, Date.now());
        }
      },
    });

    // Phase 2 hardening: encoders run at nice 10 so the agent / modem-daemon
    // control paths stay responsive when x264 saturates cores. Record mode
    // only — the bridge-only pipeline is near-zero CPU and feeds live view.
    if (this.opts.record && run.handle.pid !== undefined) {
      try {
        setPriority(run.handle.pid, 10);
      } catch {
        /* child already exited, or platform refuses — normal priority is fine */
      }
    }

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
    const pid = run.handle?.pid;
    run.handle = null;
    const stalled = run.stalled;
    run.stalled = false;
    this.stopWatching(run);
    // The child is gone (its `done` has resolved), so anything of its still
    // sitting in the shm tmpfs is orphaned by definition.
    this.reapShmSegments(pid);

    // Close out whatever the child left: clean stop (EOS ran) → the last
    // fragment is finalized; crash → it may be truncated. Either way it gets a
    // sidecar; `finalized` records which case we believe we're in. A replay
    // lap ends by EOF (eosSeen) or by cycle(): both are clean by construction.
    const eosEnd = run.eosSeen && this.opts.eosIsClean === true;
    const cycled = run.cycling;
    run.cycling = false;
    const cleanStop = this.stopped || run.retiring || cycled || eosEnd;
    this.finalSweep(run, cleanStop);
    const endedSession = run.sessionId;
    run.sessionId = null;
    run.sessionDir = null;
    run.manifest = null;
    this.opts.onActiveSegment?.(streamKey, null);
    this.opts.onEnded?.(streamKey, cleanStop);

    if (run.retiring) {
      // Disabled camera (setCameras): its session is finalized and swept —
      // drop it entirely so status() stops reporting a stream that has no
      // pipeline at all.
      this.runs.delete(streamKey);
      this.opts.onStatus?.();
      return;
    }
    if (this.stopped) {
      run.state = "stopped";
      this.opts.onStatus?.();
      return;
    }

    // Replay lap boundary: a clean end is not a failure. Respawn after the
    // parked gap (a new lap = a new session), or park when told not to loop.
    if ((cycled || eosEnd) && this.opts.respawnHoldMs) {
      run.quickFailures = 0;
      run.backoffMs = BASE_BACKOFF_MS;
      const hold = this.opts.respawnHoldMs(streamKey);
      if (hold === null) {
        run.state = "stopped";
        this.opts.onEvent?.("info", `video capture ${streamKey} ended cleanly; parked (no loop)`);
      } else {
        run.state = "retrying";
        this.opts.onEvent?.(
          "info",
          `video capture ${streamKey} ended cleanly${endedSession ? ` (session ${endedSession.slice(0, 8)}…)` : ""}; next lap in ${Math.round(hold / 1000)}s`,
        );
        this.scheduleRestart(run, hold);
      }
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
    // Watchdog kill: accounted separately from crashes. A stall always outlives
    // STABLE_MS, so the branch below would read it as "ran fine, then exited"
    // and restart forever at 2 s — a hot loop against a camera that may simply
    // be unable to deliver this mode.
    if (stalled) {
      run.stallFailures += 1;
      if (run.stallFailures >= MAX_STALL_FAILURES) {
        run.state = "failed";
        this.opts.onEvent?.(
          "warn",
          `video capture ${streamKey} stalled ${run.stallFailures}x in a row; ` +
            `parking for ${PARKED_RETRY_MS / 1000}s (sensor mode unsupported? camera wedged?)`,
        );
        this.scheduleRestart(run, PARKED_RETRY_MS);
      } else {
        run.state = "retrying";
        this.opts.onEvent?.(
          "warn",
          `video capture ${streamKey} stalled; ` +
            `retry ${run.stallFailures}/${MAX_STALL_FAILURES} in ${BASE_BACKOFF_MS}ms`,
        );
        this.scheduleRestart(run, BASE_BACKOFF_MS);
      }
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

  /**
   * Unlink the shm areas belonging to a child that has just exited.
   *
   * shmsink unlinks its own `shmpipe.<pid>.<n>` on clean shutdown, so for an
   * EOS/SIGINT stop this finds nothing. It matters for the SIGKILL paths — the
   * progress watchdog (which CANNOT use SIGINT: with `-e` that is an EOS
   * request, and EOS has to travel the pipeline that has stopped moving) and
   * stopAndWait()'s grace-period escalation. Without it a camera that stalls
   * repeatedly strands 20 MB per kill until reboot; bench-observed 2026-08-06,
   * 104 orphaned segments totalling 286 MB of a 4 GB device.
   *
   * Matched on the dead child's OWN pid, and only once it has exited. pid reuse
   * is theoretically possible but would need the wrapped-around pid to also be
   * a shmsink writer in the same instant.
   */
  private reapShmSegments(pid: number | undefined): void {
    if (pid === undefined) return;
    const dir = this.opts.shmSegmentDir ?? SHM_SEGMENT_DIR;
    const prefix = `shmpipe.${pid}.`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // no shm tmpfs (non-Linux dev box, restricted container) — nothing to do
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* raced another reaper, or not ours to remove — best effort */
      }
    }
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
      // Sidecars carry the CURRENT time provenance, not the spawn-time value in
      // session.json — so segments cut after NTP lands mid-session say "ntp"
      // (the video twin of telemetry's noteTimeSource re-emit).
      const res = sweepSessionDir(run.sessionDir, run.manifest, {
        includeNewest: false,
        timeSource: this.opts.timeSource(),
      });
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
      this.checkProgress(run, res.activePath);
    } finally {
      run.sweeping = false;
    }
  }

  /**
   * Progress watchdog tick, riding the sweep cadence. Progress is "the active
   * fragment moved on, or grew" — NOT "a fragment closed". splitmuxsink cuts
   * at `segmentSeconds` (60 s by default), so segment closure is far too
   * coarse a heartbeat to tell a stalled source from a fragment still filling;
   * the active file's size is the signal that moves every second.
   */
  private checkProgress(run: CameraRun, activePath: string | null): void {
    if (!this.opts.record || this.stopped || run.retiring || run.stalled) return;
    if (!run.handle) return;
    let bytes = 0;
    if (activePath !== null) {
      try {
        bytes = statSync(activePath).size;
      } catch {
        bytes = 0; // evicted/rotated mid-sweep — the next tick re-reads
      }
    }
    // A rotation counts as progress even though the new fragment starts small:
    // closed fragments are deleted once uploaded, so byte TOTALS are not
    // monotonic and only the active file can be compared against itself.
    const advanced =
      activePath !== null &&
      bytes > 0 &&
      (activePath !== run.progressPath || bytes > run.progressBytes);
    if (advanced) {
      run.progressPath = activePath;
      run.progressBytes = bytes;
      run.progressAt = Date.now();
      run.stallFailures = 0;
      return;
    }
    const stallMs = this.opts.stallMs ?? STALL_MS;
    if (Date.now() - run.progressAt < stallMs) return;

    run.stalled = true;
    run.state = "failed";
    this.stopWatching(run);
    this.opts.onEvent?.(
      "warn",
      `video capture ${run.cam.streamKey} stalled: no bytes written for ` +
        `${Math.round(stallMs / 1000)}s (session ${run.sessionId?.slice(0, 8) ?? "?"}…) — ` +
        `killing and restarting`,
    );
    this.opts.onStatus?.();
    // SIGKILL, not the usual SIGINT: `-e` turns SIGINT into an EOS request, and
    // EOS has to travel the very pipeline that has stopped moving (observed:
    // every thread parked in futex/poll), so the child would never exit. The
    // active fragment is 0 bytes by definition here — there is nothing an
    // orderly finalize could save.
    run.handle.stop("SIGKILL");
  }

  private finalSweep(run: CameraRun, cleanStop: boolean): void {
    if (!run.sessionDir || !run.manifest) return;
    // Clean stop: EOS finalized everything, newest included. Crash: only the
    // newest is suspect — the per-fragment default (finalized = !isNewest)
    // already encodes that, so don't override it.
    const res = sweepSessionDir(run.sessionDir, run.manifest, {
      includeNewest: true,
      timeSource: this.opts.timeSource(),
      ...(cleanStop ? { finalized: true } : {}),
    });
    for (const mp4 of res.closed) this.opts.onSegmentClosed?.(mp4);
  }
}
