/**
 * First-boot seeding (plans/xorgate-device-simulator, README §3.4 / Q9): on a
 * replay container's first start, lay the catalog's seed set into
 * `recordings/` as ready-to-upload sessions so the console shows history
 * within minutes. The ordinary uploader then ships them through the device's
 * own credentials (sidecar first, telemetry priority 0) and ingest builds the
 * rows, thumbnails and overviews exactly as for a backlog upload from hardware.
 *
 * Every seeded session is the ORIGINAL footage byte-for-byte (the fragments
 * are symlinked into the recordings tree — the uploader reads through the
 * link, the disk manager's Dirent scan skips links, so seeds are never
 * evicted or double-counted) with FRESH UUIDv7 ids and every timestamp moved
 * by ONE delta: the newest scenario ends `endBeforeMs` before now and the
 * others keep their real spacing (README §2 consequences 1–2; verified in the
 * Phase 0 shifted-copy gate).
 *
 * Idempotent: a marker in XORGATE_HOME records the seed; restarts never seed
 * twice.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { mintSessionId } from "../recording/session.js";
import { monotonicMs } from "../recording/boot-policy.js";
import type { VideoSidecar } from "../recording/video-segments.js";
import type { LoadedScenario, ReplayCatalog } from "./replay.js";

export const SEED_MARKER = "replay-seeded.json";
/** The newest seeded session ends this long before the seed (README §3.4: 1 h). */
export const SEED_END_BEFORE_MS = 3_600_000;
/** Samples per seeded telemetry segment (the real writer rotates at 60 s / 1 Hz). */
const SEED_SEGMENT_SAMPLES = 60;

export interface SeedSession {
  scenarioId: string;
  mediaSessionId: string;
  telemetrySessionId: string;
  streamKey: string;
  /** Shifted wall window of the video. */
  startTs: number;
  endTs: number;
  fragments: number;
  samples: number;
}

export interface SeedPlan {
  /** Added to every original timestamp. */
  deltaMs: number;
  sessions: SeedSession[];
}

export interface SeedOptions {
  catalog: ReplayCatalog;
  /** Loader for each seed-set scenario (missing ones are skipped with a warning). */
  loadScenario: (scenarioId: string) => LoadedScenario;
  /** XORGATE_HOME/recordings. */
  recordingsRoot: string;
  /** Where the marker lives (XORGATE_HOME). */
  home: string;
  deviceId: string;
  bootId: string;
  /** `symlink` (default: zero copy, the assets mount stays the only copy) or `copy`. */
  link?: "symlink" | "copy";
  endBeforeMs?: number;
  now?: () => number;
  /** Test seam: session-id minter (UUIDv7 of the shifted start by default). */
  mint?: (ms: number) => string;
  onEvent?: (level: "info" | "warn", msg: string) => void;
}

export interface SeedResult {
  seeded: boolean;
  /** Why nothing was written (`seeded:false`). */
  reason?: "already-seeded" | "empty-seed-set";
  plan?: SeedPlan;
}

/** Pure: pick the delta and mint the ids. */
export function planSeed(
  scenarios: LoadedScenario[],
  opts: { now: number; endBeforeMs: number; mint: (ms: number) => string },
): SeedPlan {
  const newestEnd = Math.max(...scenarios.map((s) => s.manifest.originalEndTs));
  const deltaMs = Math.round(opts.now - opts.endBeforeMs - newestEnd);
  const sessions = scenarios.map((sc) => {
    const startTs = sc.manifest.originalStartTs + deltaMs;
    const endTs = sc.manifest.originalEndTs + deltaMs;
    const stream = sc.manifest.streams[0];
    return {
      scenarioId: sc.manifest.id,
      mediaSessionId: opts.mint(startTs),
      // The telemetry session starts at its first (possibly pre-video) sample.
      telemetrySessionId: opts.mint(startTs + sc.samples[0].t),
      streamKey: stream.streamKey,
      startTs,
      endTs,
      fragments: stream.fragmentCount,
      samples: sc.samples.length,
    };
  });
  return { deltaMs, sessions };
}

function readSidecars(dir: string): { name: string; sc: VideoSidecar }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{5}\.json$/.test(f))
    .sort()
    .map((name) => ({ name, sc: JSON.parse(readFileSync(join(dir, name), "utf8")) as VideoSidecar }));
}

/** Write one scenario's seeded media + telemetry session into the recordings tree. */
export function writeSeedSession(
  sc: LoadedScenario,
  session: SeedSession,
  plan: SeedPlan,
  opts: Pick<SeedOptions, "recordingsRoot" | "deviceId" | "bootId" | "link">,
): void {
  const stream = sc.manifest.streams[0];
  const segDir = join(sc.dir, stream.fragments);
  const videoDir = join(opts.recordingsRoot, "video", session.streamKey, session.mediaSessionId);
  mkdirSync(videoDir, { recursive: true });
  // One wall/mono pair for the whole session — startMono derived exactly like
  // buildSidecar does for a live fragment, so a seed is indistinguishable
  // downstream from a session this device recorded itself.
  const pair = { wallMs: Date.now(), monoMs: monotonicMs() };
  for (const { name, sc: orig } of readSidecars(segDir)) {
    const base = name.replace(/\.json$/, "");
    const mp4Src = join(segDir, `${base}.mp4`);
    const mp4Dst = join(videoDir, `${base}.mp4`);
    if (opts.link === "copy") copyFileSync(mp4Src, mp4Dst);
    else symlinkSync(mp4Src, mp4Dst);
    const startTs = orig.startTs + plan.deltaMs;
    const sidecar: VideoSidecar = {
      ...orig,
      deviceId: opts.deviceId,
      sessionId: session.mediaSessionId,
      startTs,
      startMono: Math.round(pair.monoMs - (pair.wallMs - startTs)),
      timeSource: "ntp",
    };
    atomicWriteJson(join(videoDir, name), sidecar);
  }

  const telDir = join(opts.recordingsRoot, "telemetry", session.telemetrySessionId);
  mkdirSync(telDir, { recursive: true });
  const startedAt = session.startTs + sc.samples[0].t;
  const header = {
    type: "header",
    v: 1,
    deviceId: opts.deviceId,
    sessionId: session.telemetrySessionId,
    bootId: opts.bootId,
    timeSource: "ntp",
    rateHz: sc.manifest.telemetry.rateHz,
    startedAt,
  };
  for (let i = 0, seg = 0; i < sc.samples.length; i += SEED_SEGMENT_SAMPLES, seg += 1) {
    const chunk = sc.samples.slice(i, i + SEED_SEGMENT_SAMPLES);
    const firstTs = session.startTs + chunk[0].t;
    const lines = [JSON.stringify(header)];
    for (const s of chunk) {
      lines.push(
        JSON.stringify({
          ts: session.startTs + s.t,
          // The live writer stamps hrtime ns; the cloud never reads it, but the
          // field is part of the on-disk sample shape, so keep it coherent.
          mono: Math.round((pair.monoMs + s.t) * 1e6),
          seq: s.seq,
          metrics: s.metrics,
        }),
      );
    }
    const name = `seg-${firstTs}-${String(seg).padStart(5, "0")}.jsonl.gz`;
    writeFileSync(join(telDir, name), gzipSync(Buffer.from(`${lines.join("\n")}\n`)));
  }
}

/**
 * Seed once. Loads every seed-set scenario, plans one delta, writes the
 * sessions, then the marker. Throws only on a filesystem failure; a scenario
 * missing from the pack is skipped with a warning.
 */
export function seedOnce(opts: SeedOptions): SeedResult {
  const markerPath = join(opts.home, SEED_MARKER);
  if (existsSync(markerPath)) return { seeded: false, reason: "already-seeded" };
  const scenarios: LoadedScenario[] = [];
  for (const id of opts.catalog.seedSet) {
    try {
      scenarios.push(opts.loadScenario(id));
    } catch (err) {
      opts.onEvent?.("warn", `replay seed: skipping ${id}: ${(err as Error).message}`);
    }
  }
  if (scenarios.length === 0) {
    atomicWriteJson(markerPath, { v: 1, at: (opts.now ?? Date.now)(), sessions: [] });
    return { seeded: false, reason: "empty-seed-set" };
  }
  const plan = planSeed(scenarios, {
    now: (opts.now ?? Date.now)(),
    endBeforeMs: opts.endBeforeMs ?? SEED_END_BEFORE_MS,
    mint: opts.mint ?? mintSessionId,
  });
  for (const session of plan.sessions) {
    const sc = scenarios.find((s) => s.manifest.id === session.scenarioId)!;
    writeSeedSession(sc, session, plan, opts);
    opts.onEvent?.(
      "info",
      `replay seed: ${session.scenarioId} → media ${session.mediaSessionId.slice(0, 8)}… ` +
        `(${session.fragments} fragments) + telemetry ${session.telemetrySessionId.slice(0, 8)}… ` +
        `(${session.samples} samples) at ${new Date(session.startTs).toISOString()}`,
    );
  }
  atomicWriteJson(markerPath, { v: 1, at: (opts.now ?? Date.now)(), deltaMs: plan.deltaMs, sessions: plan.sessions });
  return { seeded: true, plan };
}
