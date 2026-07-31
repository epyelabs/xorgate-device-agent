import type { MediaConfig } from "../config.js";
import type { MediaStream, TelemetryMedia } from "../telemetry.js";
import { loadManifest, type KvsManifest } from "../../media/manifest.js";
import { resolveChannelPipeline } from "../../media/pipeline.js";
import { detectRuntime, streamChannel } from "../../hardware/kvs-webrtc.js";
import type { StreamHandle } from "../../lib/exec.js";

/**
 * Media collector — supervises the `xorgate-kvs-webrtc` master runtime, one
 * process per KVS signaling channel, so the device streams live video to the
 * frontend's Streams-tab viewer. This is the agent-managed equivalent of the
 * `xorgate-synthetic-master` rig's `run-master.sh` (one supervised master per
 * channel, restart on crash), wired into the telemetry loop so `media.kvs` and
 * the per-channel stream list reflect reality.
 *
 * Self-gating mirrors the IMU collector: detection + manifest load happen lazily
 * on the first read and return inert state when the runtime can't run (off-Pi,
 * missing binary, no manifest/channels). A master that keeps exiting *before it
 * stabilizes* (e.g. the user-supplied KVS SDK `.so` libs are missing, or the LTE
 * link is down) is parked as `failed` after a few quick crashes rather than
 * tight-looped, then re-attempted on a slow cadence so a transient cause (network
 * outage) heals itself without a daemon restart.
 */

const STABLE_MS = 15_000; // a master alive this long is considered up; resets backoff
const BASE_BACKOFF_MS = 2_000; // matches run-master.sh's `sleep 2`
const MAX_BACKOFF_MS = 30_000;
const MAX_QUICK_FAILURES = 3; // quick crashes before we park the channel as failed
const PARKED_RETRY_MS = 60_000; // parked channels re-attempt this often instead of staying dead

interface ChannelSupervisor {
  streamKey: string;
  channelName: string;
  /** Camera turned off by `recording.video.cameras` — held down like a shed. */
  disabled: boolean;
  state: MediaStream["state"];
  handle: StreamHandle | null;
  startedAt: number;
  backoffMs: number;
  quickFailures: number;
  stableTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
}

export interface MediaSupervisor {
  /** Current snapshot for the telemetry payload (also kicks off lazy startup). */
  read(): TelemetryMedia;
  /** Stop every master (SIGINT) and cancel pending restarts — called on shutdown. */
  stop(): void;
  /**
   * Bounce one channel's master (offline recording plan, Phase 3): the shm
   * capture daemon feeding a bridged stream was (re)spawned, and a master
   * whose pipeline already attached to the OLD shm writer does NOT crash when
   * that writer dies — its shmsrc wedges silently (`shm_open failed` loop,
   * viewers see black; hardware-verified). SIGINT it; the supervisor's normal
   * restart path brings it back against the new socket.
   */
  restartChannel(streamKey: string): void;
  /**
   * Power load shedding rung 1 (optimize-system-process-cycle plan, Phase 3):
   * true parks EVERY master (SIGINT + no respawn — unlike a plain stop, the
   * supervisor holds them down until released); false releases and respawns.
   * Reversible, unlike stop().
   */
  setShed(shed: boolean): void;
  /**
   * Per-camera capacity (optimize-system-process-cycle plan, Phase 6): stream
   * keys whose camera the operator turned off in `recording.video.cameras`.
   * Those masters are parked (SIGINT, no respawn) so a disabled camera has no
   * pipeline at all — the sensor path stays cold instead of feeding a live
   * encoder nobody asked for. Every other channel is unaffected. Remembered
   * even when called before the runtime has started (lazy first read).
   */
  setDisabledStreams(streamKeys: readonly string[]): void;
}

const IDLE: TelemetryMedia = {
  kvs: { value: false },
  recording: { value: false },
  streams: [],
};

export function createMediaCollector(cfg: MediaConfig): MediaSupervisor {
  let started = false;
  let stopped = false;
  /** Load-shedding park: while true, nothing spawns (see setShed). */
  let shed = false;
  /** Per-camera park: stream keys disabled by settings (see setDisabledStreams). */
  let disabledStreams = new Set<string>();
  let warned = false;
  let manifest: KvsManifest | null = null;
  const channels = new Map<string, ChannelSupervisor>();

  function warnOnce(msg: string): void {
    if (!warned) {
      console.warn(`[media] ${msg}`);
      warned = true;
    }
  }

  function snapshot(): TelemetryMedia {
    const streams: MediaStream[] = [...channels.values()].map((c) => ({
      streamKey: c.streamKey,
      channelName: c.channelName,
      state: c.state,
    }));
    const live = streams.some((s) => s.state === "running" || s.state === "starting");
    return { kvs: { value: live }, recording: { value: false }, streams };
  }

  // Detect the runtime + load the manifest once, then launch a supervised master
  // per channel. Inert (logs once) when nothing can run.
  async function start(): Promise<void> {
    started = true; // set before the first await so reads don't double-start
    const detect = await detectRuntime(cfg.binaryPath);
    if (!detect.available) {
      warnOnce(detect.reason ?? "media runtime unavailable");
      return;
    }
    if (!detect.gstreamer) {
      console.warn("[media] gst-launch-1.0 not found; GStreamer may be missing (continuing)");
    }
    manifest = loadManifest(cfg.manifestPath);
    if (!manifest) {
      warnOnce(`no KVS manifest at ${cfg.manifestPath}; media disabled`);
      return;
    }
    if (manifest.channels.length === 0) {
      warnOnce("KVS manifest has no channels; nothing to stream");
      return;
    }
    console.log(
      `[media] starting ${manifest.channels.length} KVS master(s) ` +
        `(region=${manifest.region}, source=${cfg.source}) for ${manifest.deviceId}`,
    );
    for (const ch of manifest.channels) {
      channels.set(ch.channelName, {
        streamKey: ch.streamKey,
        channelName: ch.channelName,
        disabled: disabledStreams.has(ch.streamKey),
        state: shed || disabledStreams.has(ch.streamKey) ? "stopped" : "starting",
        handle: null,
        startedAt: 0,
        backoffMs: BASE_BACKOFF_MS,
        quickFailures: 0,
        stableTimer: null,
        restartTimer: null,
      });
      spawn(ch.channelName);
    }
  }

  function spawn(channelName: string): void {
    const c = channels.get(channelName);
    if (!c || stopped || shed || c.disabled || !manifest) return;

    // Each channel/camera gets its own pipeline: <pipelineDir>/<streamKey>.gst,
    // falling back to the global KVS_GST_PIPELINE, then the runtime's default.
    const pipelinePath = resolveChannelPipeline(cfg.pipelineDir, c.streamKey, cfg.pipelinePath);

    c.state = "starting";
    c.startedAt = Date.now();
    c.handle = streamChannel(
      channelName,
      cfg.mediaType,
      cfg.source,
      cfg.binaryPath,
      {
        region: manifest.region,
        credentialEndpoint: manifest.credentialEndpoint,
        roleAlias: manifest.roleAlias,
        thingName: manifest.deviceId,
        certPath: cfg.certPath,
        keyPath: cfg.keyPath,
        caCertPath: cfg.caCertPath,
        libDir: cfg.libDir,
        pipelinePath,
        logLevel: cfg.logLevel,
        idleTeardownSecs: cfg.idleTeardownSecs,
      },
      {
        // Forward the runtime's diagnostics (the KVS SDK's "error while loading
        // shared libraries" lands here, which is the key signal when libs are missing).
        onStderr: (line) => {
          if (line.trim()) console.error(`[media ${channelName}] ${line}`);
        },
        // The SDK's own DLOG* output rides STDOUT. It MUST be consumed: with no
        // listener the 64 KB pipe fills and BLOCKS the master mid-operation
        // (near-silent at the default log level, fatal at verbose). Forwarding
        // also makes AWS_KVS_LOG_LEVEL debugging actually observable.
        onStdout: (line) => {
          if (line.trim()) console.log(`[media ${channelName}] ${line}`);
        },
      },
    );

    // Promote to "running" only after it survives the grace window — a fast exit
    // is a setup failure, not a healthy start.
    c.stableTimer = setTimeout(() => {
      if (stopped) return;
      const cur = channels.get(channelName);
      if (cur && cur.handle) {
        cur.state = "running";
        cur.quickFailures = 0;
        cur.backoffMs = BASE_BACKOFF_MS;
      }
    }, STABLE_MS);

    void c.handle.done.then((res) => onExit(channelName, res.exitCode));
  }

  function onExit(channelName: string, exitCode: number | null): void {
    const c = channels.get(channelName);
    if (!c) return;
    if (c.stableTimer) {
      clearTimeout(c.stableTimer);
      c.stableTimer = null;
    }
    c.handle = null;
    if (stopped || shed || c.disabled) {
      c.state = "stopped";
      return;
    }

    const ranMs = Date.now() - c.startedAt;
    if (ranMs >= STABLE_MS) {
      // Was healthy, then dropped (cred refresh, network blip) — restart promptly.
      console.warn(`[media ${channelName}] master exited (code ${exitCode ?? "?"}); restarting`);
      c.quickFailures = 0;
      c.backoffMs = BASE_BACKOFF_MS;
      scheduleRestart(c);
      return;
    }

    c.quickFailures += 1;
    if (c.quickFailures >= MAX_QUICK_FAILURES) {
      // Park with a slow retry rather than permanently: quick-crash streaks also
      // happen transiently (LTE interface torn down mid-outage, creds endpoint
      // unreachable at boot), and a permanently parked channel would stay dead
      // after the network recovers until someone restarts the daemon.
      c.state = "failed";
      console.error(
        `[media ${channelName}] master exited (code ${exitCode ?? "?"}) before stabilizing ` +
          `${c.quickFailures}x; parking for ${PARKED_RETRY_MS / 1000}s. Check: KVS SDK .so libs ` +
          `in ${cfg.libDir}, GStreamer install, and IoT creds.`,
      );
      c.quickFailures = 0;
      c.backoffMs = BASE_BACKOFF_MS;
      scheduleRestart(c, PARKED_RETRY_MS);
      return;
    }
    c.state = "retrying";
    console.warn(
      `[media ${channelName}] master exited (code ${exitCode ?? "?"}); ` +
        `retry ${c.quickFailures}/${MAX_QUICK_FAILURES} in ${c.backoffMs}ms`,
    );
    scheduleRestart(c);
    c.backoffMs = Math.min(c.backoffMs * 2, MAX_BACKOFF_MS);
  }

  function scheduleRestart(c: ChannelSupervisor, delayMs = c.backoffMs): void {
    if (stopped) return;
    c.restartTimer = setTimeout(() => {
      c.restartTimer = null;
      spawn(c.channelName);
    }, delayMs);
  }

  return {
    read(): TelemetryMedia {
      if (stopped) return IDLE;
      if (!started) {
        void start(); // non-blocking kick-off; first snapshot is empty
        return IDLE;
      }
      return snapshot();
    },
    setShed(on: boolean): void {
      if (stopped || shed === on) return;
      shed = on;
      if (on) {
        // Park: SIGINT every master and cancel pending restarts. onExit sees
        // `shed` and marks the channel stopped instead of rescheduling.
        for (const c of channels.values()) {
          if (c.stableTimer) clearTimeout(c.stableTimer);
          if (c.restartTimer) clearTimeout(c.restartTimer);
          c.stableTimer = null;
          c.restartTimer = null;
          c.state = "stopped";
          c.handle?.stop("SIGINT");
        }
        // Two callers share this control (load shedding rung 1 and the Phase 7
        // GPS/LTE gate), so the message names the effect, not the cause — the
        // cause is logged by whichever policy asked, at the same instant.
        if (channels.size > 0) console.warn("[media] live masters parked (power policy)");
        return;
      }
      // Release: respawn everything from a clean slate (fresh backoff — the
      // previous exits were ours, not failures).
      for (const c of channels.values()) {
        if (c.disabled) continue; // a disabled camera stays down, shed or not
        c.quickFailures = 0;
        c.backoffMs = BASE_BACKOFF_MS;
        if (!c.handle && !c.restartTimer) spawn(c.channelName);
      }
      if (channels.size > 0) console.log("[media] live masters released (power policy cleared)");
    },
    setDisabledStreams(streamKeys: readonly string[]): void {
      if (stopped) return;
      const next = new Set(streamKeys);
      disabledStreams = next;
      for (const c of channels.values()) {
        const want = next.has(c.streamKey);
        if (want === c.disabled) continue;
        c.disabled = want;
        if (want) {
          if (c.stableTimer) clearTimeout(c.stableTimer);
          if (c.restartTimer) clearTimeout(c.restartTimer);
          c.stableTimer = null;
          c.restartTimer = null;
          c.state = "stopped";
          c.handle?.stop("SIGINT");
          console.warn(`[media ${c.channelName}] master stopped (camera disabled in settings)`);
        } else {
          c.quickFailures = 0;
          c.backoffMs = BASE_BACKOFF_MS;
          console.log(`[media ${c.channelName}] camera re-enabled in settings; starting master`);
          if (!shed && !c.handle && !c.restartTimer) spawn(c.channelName);
        }
      }
    },
    restartChannel(streamKey: string): void {
      if (stopped || shed) return;
      for (const c of channels.values()) {
        if (c.streamKey !== streamKey) continue;
        if (c.handle) {
          console.log(`[media ${c.channelName}] restarting master (capture daemon respawned)`);
          c.handle.stop("SIGINT"); // onExit schedules the respawn
        }
        // No handle (parked/retrying): the pending restart picks up the new
        // socket by itself — nothing to do.
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const c of channels.values()) {
        if (c.stableTimer) clearTimeout(c.stableTimer);
        if (c.restartTimer) clearTimeout(c.restartTimer);
        c.stableTimer = null;
        c.restartTimer = null;
        c.state = "stopped";
        c.handle?.stop("SIGINT");
        c.handle = null;
      }
    },
  };
}
