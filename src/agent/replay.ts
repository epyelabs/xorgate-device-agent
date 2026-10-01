/**
 * Replay data source (plans/xorgate-device-simulator, Phase 2): the agent's
 * third run mode. Sensors are fed from a recorded telemetry trace and the
 * camera from a recorded clip, cut from real prod sessions into the scenario
 * asset pack (`scripts/build-scenario.mjs` → `demo-assets/v1/<scenarioId>/`).
 * Everything else — MQTT, config, commands, recording, sidecars, uploads, the
 * KVS masters — is the unchanged real agent.
 *
 * One LAP = one pass over the scenario: the capture supervisor plays
 * `cam0/lap.h264` at real time through the normal capture pipeline (a file
 * head in front of the unchanged tee → x264 → splitmuxsink / shmsink), and
 * this source answers `read()` / `sampleGroups()` from the trace at the same
 * offset. The lap clock is anchored to the moment gst-launch reports PLAYING
 * (frames start flowing), so video and telemetry are stamped by one wall clock
 * exactly as on hardware (README §2). A lap ends when the file hits EOS; then a
 * parked GAP (`simulation.gapSeconds`: last position, speed 0), then the next
 * lap — or parked for good when `simulation.loop` is false. Each lap is a
 * capture spawn, so with recording on every lap is one clean media + telemetry
 * session pair (the telemetry session is rotated at each lap start).
 *
 * Without a capture child (no media, cameras disabled) the lap clock runs on
 * its own timer so the map still moves — telemetry-only replay.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ReplayConfig } from "./config.js";
import type { GroupSample } from "./collectors/index.js";
import type { MediaSupervisor } from "./collectors/media.js";
import type { TelemetryMedia, TelemetryReading } from "./telemetry.js";
import type { CaptureCamera } from "../recording/video-capture.js";
import type { SimulationSettings } from "../daemon/settings.js";
import { monotonicMs } from "../recording/boot-policy.js";

// ---------------------------------------------------------------- assets ----

/** `catalog.json` at the root of the asset pack (build-scenario.mjs). */
export interface ReplayCatalog {
  v: 1;
  home?: { lat: number; lon: number; label?: string };
  /** Scenario ids seeded as past sessions on first boot (README Q9), in order. */
  seedSet: string[];
  scenarios: { id: string; title: string; durationMs: number; originalStartTs: number }[];
}

/** `<scenarioId>/scenario.json` — the fields the replay source needs. */
export interface ScenarioManifest {
  v: 1;
  id: string;
  title: string;
  durationMs: number;
  originalStartTs: number;
  originalEndTs: number;
  streams: {
    streamKey: string;
    lap: string;
    width: number;
    height: number;
    fps: number;
    fragments: string;
    fragmentCount: number;
    mediaDurationMs: number | null;
  }[];
  telemetry: { trace: string; rateHz: number; samples: number; tMin: number; tMax: number };
}

/** One normalized trace sample: `t` = ms since the lap's first frame. */
export interface TraceSample {
  t: number;
  seq: number;
  metrics: Record<string, Record<string, unknown>>;
}

export interface LoadedScenario {
  manifest: ScenarioManifest;
  /** Absolute scenario directory. */
  dir: string;
  /** Sorted by `t`, strictly increasing. */
  samples: TraceSample[];
  /** How long one lap of video plays (frames / fps when known, else the sidecar window). */
  lapMs: number;
}

export function loadCatalog(assetsDir: string): ReplayCatalog {
  const raw = JSON.parse(readFileSync(join(assetsDir, "catalog.json"), "utf8")) as ReplayCatalog;
  if (raw.v !== 1 || !Array.isArray(raw.scenarios)) {
    throw new Error(`${join(assetsDir, "catalog.json")}: not a v1 catalog`);
  }
  return { ...raw, seedSet: Array.isArray(raw.seedSet) ? raw.seedSet : [] };
}

export function loadScenario(assetsDir: string, scenarioId: string): LoadedScenario {
  const dir = resolve(assetsDir, scenarioId);
  const manifestPath = join(dir, "scenario.json");
  if (!existsSync(manifestPath)) throw new Error(`scenario ${scenarioId}: ${manifestPath} missing`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ScenarioManifest;
  if (manifest.v !== 1 || manifest.id !== scenarioId || !manifest.streams?.length) {
    throw new Error(`scenario ${scenarioId}: scenario.json is not a v1 manifest for ${scenarioId}`);
  }
  for (const st of manifest.streams) {
    if (!existsSync(join(dir, st.lap))) throw new Error(`scenario ${scenarioId}: ${st.lap} missing`);
  }
  const samples: TraceSample[] = [];
  const text = gunzipSync(readFileSync(join(dir, manifest.telemetry.trace))).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    const o = JSON.parse(line) as TraceSample;
    if (typeof o.t !== "number" || !o.metrics || typeof o.metrics !== "object") continue;
    samples.push(o);
  }
  samples.sort((a, b) => a.t - b.t);
  if (samples.length === 0) throw new Error(`scenario ${scenarioId}: empty trace`);
  const first = manifest.streams[0];
  const lapMs =
    first.mediaDurationMs && first.mediaDurationMs > 0 ? first.mediaDurationMs : manifest.durationMs;
  return { manifest, dir, samples, lapMs };
}

// --------------------------------------------------------------- sampler ----

/**
 * Nearest sample at or before `offsetMs` (binary search), or null when the lap
 * has not reached the first sample yet — the city trace starts 1.7 s after its
 * first frame (Phase 1 surprise 5), and a device that has no reading yet
 * publishes nothing for that group rather than a guess.
 */
export function sampleAt(samples: readonly TraceSample[], offsetMs: number): TraceSample | null {
  if (samples.length === 0 || offsetMs < samples[0].t) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= offsetMs) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo];
}

/** The parked view of a sample: same position, zero speed. */
export function parkedMetrics(
  metrics: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const gps = metrics.gps;
  if (!gps) return metrics;
  const speed = gps.speed as { value?: unknown; unit?: string } | undefined;
  return {
    ...metrics,
    gps: { ...gps, speed: { value: 0, ...(speed?.unit ? { unit: speed.unit } : {}) } },
  };
}

/** The gst-launch pipeline HEAD that plays a lap file at real time (Phase 0 recipe). */
export function replayCaptureHead(lapPath: string, fps: number): string[] {
  return [
    "filesrc",
    `location=${lapPath}`,
    "!",
    "h264parse",
    "!",
    // Explicit framerate caps are what make `identity sync=true` pace a raw
    // Annex-B stream (Phase 0): without them the file plays as fast as it decodes.
    `video/x-h264,framerate=${fps}/1`,
    "!",
    "avdec_h264",
    "!",
    "identity",
    "sync=true",
    "!",
    "videoconvert",
    "!",
    "videorate",
  ];
}

// ------------------------------------------------------------- lap clock ----

export type ReplayPhase = "idle" | "lap" | "gap" | "parked";

/**
 * The lap/gap state machine, pure over an injected monotonic clock so the
 * worker, the tests and the telemetry-only fallback timer all drive the same
 * object. `offsetMs()` is the trace position; `read*` answer from it.
 */
export class ReplayPlayer {
  private scenario: LoadedScenario;
  private phase: ReplayPhase = "idle";
  private lapStartMono = 0;
  private lapStartWall = 0;
  /** ns, in the recorder's `updatedMono` frame: hrtime at lap start. */
  private lapStartMonoNs = 0n;
  private lapIndex = 0;
  private lastSample: TraceSample | null = null;
  private phaseSinceMono: number;
  private readonly monoMs: () => number;
  private readonly hrtime: () => bigint;

  constructor(
    scenario: LoadedScenario,
    clocks: { monoMs?: () => number; hrtime?: () => bigint } = {},
  ) {
    this.scenario = scenario;
    this.monoMs = clocks.monoMs ?? monotonicMs;
    this.hrtime = clocks.hrtime ?? (() => process.hrtime.bigint());
    this.phaseSinceMono = this.monoMs();
  }

  current(): LoadedScenario {
    return this.scenario;
  }

  /** Swap the scenario; the running lap (if any) keeps playing until ended. */
  setScenario(scenario: LoadedScenario): void {
    this.scenario = scenario;
  }

  state(): { phase: ReplayPhase; lapIndex: number; offsetMs: number; lapStartWall: number } {
    return {
      phase: this.phase,
      lapIndex: this.lapIndex,
      offsetMs: this.phase === "lap" ? this.offsetMs() : 0,
      lapStartWall: this.lapStartWall,
    };
  }

  phaseName(): ReplayPhase {
    return this.phase;
  }

  /** ms since the current phase began. */
  phaseAgeMs(): number {
    return this.monoMs() - this.phaseSinceMono;
  }

  /** Trace position in the current lap (ms since first frame). */
  offsetMs(): number {
    return this.monoMs() - this.lapStartMono;
  }

  /** The lap's video has (nominally) played out — only meaningful in `lap`. */
  lapElapsed(): boolean {
    return this.phase === "lap" && this.offsetMs() >= this.scenario.lapMs;
  }

  /** Frames are flowing from `wallMs` (gst PLAYING, or the self-timer). */
  startLap(wallMs: number): void {
    this.lapStartMono = this.monoMs();
    this.lapStartMonoNs = this.hrtime();
    this.lapStartWall = wallMs;
    this.lapIndex += 1;
    this.phase = "lap";
    this.phaseSinceMono = this.lapStartMono;
  }

  /** The lap's video ended; park (looping or not decides what comes next). */
  endLap(loop: boolean): void {
    if (this.phase === "lap") {
      // Hold the last position reached so the gap parks where the lap stopped.
      this.lastSample = sampleAt(this.scenario.samples, this.offsetMs()) ?? this.lastSample;
    }
    this.phase = loop ? "gap" : "parked";
    this.phaseSinceMono = this.monoMs();
  }

  /** Live metrics for the publish loop. */
  readMetrics(): Record<string, Record<string, unknown>> {
    if (this.phase === "lap") {
      const s = sampleAt(this.scenario.samples, this.offsetMs());
      if (s) this.lastSample = s;
      return s ? s.metrics : {};
    }
    if ((this.phase === "gap" || this.phase === "parked") && this.lastSample) {
      return parkedMetrics(this.lastSample.metrics);
    }
    return {};
  }

  /**
   * Recorder view: each group with a REAL `updatedMono` — the trace sample's
   * own time in the lap's hrtime frame — so the recorder's freshness gate
   * writes a sample exactly once (README gotcha 19). Parked: the same fields
   * stamped "now", capped to 1 Hz by the recorder's native cadence, like a GPS
   * cache that refreshes every second with the same fix.
   */
  sampleGroups(): Record<string, GroupSample> {
    const out: Record<string, GroupSample> = {};
    if (this.phase === "lap") {
      const s = sampleAt(this.scenario.samples, this.offsetMs());
      if (!s) return out;
      this.lastSample = s;
      const updatedMono = this.lapStartMonoNs + BigInt(Math.round(s.t * 1e6));
      for (const [group, fields] of Object.entries(s.metrics)) out[group] = { fields, updatedMono };
      return out;
    }
    if ((this.phase === "gap" || this.phase === "parked") && this.lastSample) {
      const updatedMono = this.hrtime();
      for (const [group, fields] of Object.entries(parkedMetrics(this.lastSample.metrics))) {
        out[group] = { fields, updatedMono };
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- source ----

const IDLE_MEDIA: TelemetryMedia = { kvs: { value: false }, recording: { value: false }, streams: [] };

/** What the replay source needs from the recording manager (set after construction). */
export interface ReplayHost {
  /** End every camera's lap cleanly now; the supervisor respawns after `respawnHoldMs`. */
  cycleVideo(): void;
  /** Close the telemetry session and open a new one (one pair per lap). */
  rotateTelemetrySession(why: string): void;
}

export interface ReplaySourceOptions {
  config: ReplayConfig;
  /** Live view of settings.json's `simulation` namespace. */
  settings: () => SimulationSettings | undefined;
  /** The KVS master supervisor (the media block), or null without media. */
  media: MediaSupervisor | null;
  onEvent?: (level: "info" | "warn", msg: string) => void;
  /** Test seams. */
  monoMs?: () => number;
  hrtime?: () => bigint;
  now?: () => number;
  /** Self-timer period for the telemetry-only fallback; 0 disables the timer (tests drive tick()). */
  tickMs?: number;
}

/**
 * Grace after a gap (or at boot) before the self-timer assumes there is no
 * capture child coming and starts the lap clock by itself: a respawn reaches
 * PLAYING in ~2–3 s (Phase 0), the crash backoff ladder tops out at 30 s.
 */
const VIDEO_GRACE_MS = 45_000;
const SETTINGS_POLL_TICKS = 5;

export interface ReplaySource {
  read(): Promise<TelemetryReading>;
  sampleGroups(): Promise<Record<string, GroupSample>>;
  stop(): void;
  restartMediaChannel(streamKey: string): void;
  setLiveShed(shed: boolean): void;
  setDisabledStreams(streamKeys: readonly string[]): void;
  /** Capture-supervisor hooks (RecordingVideoOptions). */
  sourceHead(cam: CaptureCamera): string[];
  onPlaying(streamKey: string, wallMs: number): void;
  onEnded(streamKey: string, clean: boolean): void;
  respawnHoldMs(streamKey: string): number | null;
  /** Spawn guard: streams the scenario has no footage for get no master. */
  streamGuard(streamKey: string): "ok" | "no-pipeline";
  attachHost(host: ReplayHost): void;
  /** Re-read `simulation` settings; a changed scenario ends the lap in place. */
  reapply(): void;
  /** One clock tick (the self-timer); public for tests. */
  tick(): void;
  scenario(): LoadedScenario;
  catalog(): ReplayCatalog;
  status(): { scenarioId: string; phase: ReplayPhase; lapIndex: number; offsetMs: number; videoDriven: boolean };
}

export function createReplaySource(opts: ReplaySourceOptions): ReplaySource {
  const log = (level: "info" | "warn", msg: string): void => opts.onEvent?.(level, `replay: ${msg}`);
  const now = opts.now ?? Date.now;
  const catalog = loadCatalog(opts.config.assetsDir);
  if (catalog.scenarios.length === 0) throw new Error("replay: the catalog has no scenarios");

  const resolveScenarioId = (): string => {
    const wanted = opts.settings()?.scenarioId ?? opts.config.defaultScenarioId ?? undefined;
    if (wanted && catalog.scenarios.some((s) => s.id === wanted)) return wanted;
    if (wanted) log("warn", `scenario "${wanted}" is not in the catalog — using ${catalog.scenarios[0].id}`);
    return catalog.scenarios[0].id;
  };

  let scenarioId = resolveScenarioId();
  const player = new ReplayPlayer(loadScenario(opts.config.assetsDir, scenarioId), {
    monoMs: opts.monoMs,
    hrtime: opts.hrtime,
  });
  log("info", `scenario ${scenarioId} loaded (${player.current().samples.length} samples, lap ${Math.round(player.current().lapMs / 1000)} s)`);

  let host: ReplayHost | null = null;
  let stopped = false;
  /** The stream whose capture child drives the lap clock (the scenario's first). */
  const clockStream = (): string => player.current().manifest.streams[0].streamKey;
  /** A capture child has reported PLAYING at least once this process. */
  let videoDriven = false;
  /** A scenario switch is waiting for the respawn: hold 0 instead of the gap. */
  let switchPending = false;
  let ticks = 0;

  const loop = (): boolean => opts.settings()?.loop ?? true;
  const gapMs = (): number => (opts.settings()?.gapSeconds ?? 30) * 1000;

  function beginLap(wallMs: number, how: string): void {
    player.startLap(wallMs);
    switchPending = false;
    const st = player.state();
    log("info", `lap ${st.lapIndex} of ${player.current().manifest.id} started (${how})`);
    host?.rotateTelemetrySession(`replay lap ${st.lapIndex}`);
  }

  function finishLap(how: string): void {
    const willLoop = loop();
    player.endLap(willLoop);
    log(
      "info",
      switchPending
        ? `lap ended (${how}); switching to ${player.current().manifest.id}`
        : willLoop
          ? `lap ended (${how}); parked for ${Math.round(gapMs() / 1000)} s`
          : `lap ended (${how}); parked — loop is off`,
    );
  }

  const source: ReplaySource = {
    async read(): Promise<TelemetryReading> {
      return {
        metrics: player.readMetrics() as TelemetryReading["metrics"],
        media: opts.media ? opts.media.read() : IDLE_MEDIA,
      };
    },
    async sampleGroups(): Promise<Record<string, GroupSample>> {
      return player.sampleGroups();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      opts.media?.stop();
    },
    restartMediaChannel: (streamKey) => opts.media?.restartChannel(streamKey),
    setLiveShed: (shed) => opts.media?.setShed(shed),
    setDisabledStreams: (streamKeys) => opts.media?.setDisabledStreams(streamKeys),

    sourceHead(cam: CaptureCamera): string[] {
      const sc = player.current();
      const stream = sc.manifest.streams.find((s) => s.streamKey === cam.streamKey) ?? sc.manifest.streams[0];
      return replayCaptureHead(join(sc.dir, stream.lap), stream.fps);
    },
    onPlaying(streamKey: string, wallMs: number): void {
      if (stopped || streamKey !== clockStream()) return;
      videoDriven = true;
      beginLap(wallMs, "video playing");
    },
    onEnded(streamKey: string, clean: boolean): void {
      if (stopped || streamKey !== clockStream()) return;
      if (player.phaseName() !== "lap") return;
      finishLap(clean ? "video EOS" : "capture exited");
    },
    respawnHoldMs(streamKey: string): number | null {
      if (streamKey !== clockStream()) return 0;
      if (switchPending) return 0;
      return loop() ? gapMs() : null;
    },
    streamGuard(streamKey: string): "ok" | "no-pipeline" {
      return player.current().manifest.streams.some((s) => s.streamKey === streamKey) ? "ok" : "no-pipeline";
    },
    attachHost(h: ReplayHost): void {
      host = h;
    },
    reapply(): void {
      if (stopped) return;
      const next = resolveScenarioId();
      if (next === scenarioId) return;
      let loaded: LoadedScenario;
      try {
        loaded = loadScenario(opts.config.assetsDir, next);
      } catch (err) {
        log("warn", `scenario ${next} failed to load (${(err as Error).message}); keeping ${scenarioId}`);
        return;
      }
      scenarioId = next;
      player.setScenario(loaded);
      switchPending = true;
      log("info", `scenario switched to ${next} — ending the current lap`);
      if (videoDriven && host) {
        host.cycleVideo(); // → onEnded → respawnHoldMs()=0 → new child → onPlaying
      } else {
        // Telemetry-only: no child to cycle, restart the lap clock right away.
        if (player.phaseName() === "lap") finishLap("scenario switch");
        beginLap(now(), "scenario switch");
      }
    },
    tick(): void {
      if (stopped) return;
      ticks += 1;
      if (ticks % SETTINGS_POLL_TICKS === 0) source.reapply();
      const phase = player.phaseName();
      if (videoDriven) {
        // The capture child owns the lap clock. The timer only steps in when a
        // respawn is overdue (parked beyond the gap + grace with no PLAYING).
        if (phase === "gap" && player.phaseAgeMs() > gapMs() + VIDEO_GRACE_MS) {
          log("warn", "no capture child came back after the gap — running the lap clock without video");
          videoDriven = false;
          beginLap(now(), "timer fallback");
        }
        return;
      }
      if (phase === "idle" && player.phaseAgeMs() > VIDEO_GRACE_MS) {
        log("info", "no capture child reported PLAYING — telemetry-only replay");
        beginLap(now(), "timer, no video");
      } else if (phase === "lap" && player.lapElapsed()) {
        finishLap("lap time elapsed");
      } else if (phase === "gap" && player.phaseAgeMs() >= gapMs()) {
        beginLap(now(), "timer");
      }
    },
    scenario: () => player.current(),
    catalog: () => catalog,
    status() {
      const st = player.state();
      return { scenarioId, phase: st.phase, lapIndex: st.lapIndex, offsetMs: st.offsetMs, videoDriven };
    },
  };

  const tickMs = opts.tickMs ?? 1000;
  const timer = tickMs > 0 ? setInterval(() => source.tick(), tickMs) : null;
  timer?.unref();
  return source;
}
