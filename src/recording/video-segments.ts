/**
 * Video segment sidecars (plan D2/D6): splitmuxsink writes `%05d.mp4` fragments
 * into `recordings/video/<streamKey>/<sessionId>/`; this module turns each
 * CLOSED fragment into an upload-ready pair by writing the `.json` sidecar next
 * to it. "mp4 + sidecar exist" IS the pending-upload state (no journal), same
 * stance as telemetry segments.
 *
 * Timestamps (anchor method, recorded in the sidecar as `anchor`): the capture
 * daemon stamps a wall/mono anchor at spawn and writes it to a per-session
 * `session.json`; each segment's startTs comes from the mp4's birthtime (falling
 * back to `anchor + seq × segmentSeconds` when the fs gives no birthtime) and
 * durationMs from mtime − birthtime (last write ≈ fragment close). Accuracy is
 * well inside the plan's ±1 s MVP bound — splitmuxsink opens the file at
 * fragment start and last-writes it at finalize. startMono is derived from a
 * wall/mono pair read AT SIDECAR-WRITE TIME (Phase 8 — not from the session
 * anchor, which predates any clock correction this boot) so cloud-side
 * re-anchoring (D6) stays possible.
 *
 * Clock steps (Phase 8, field-analysed): a correction between capture start
 * and finalize costs no footage. Fragment 0 is anchored to the 0→1 rotation
 * boundary and every later fragment to its own birthtime, so all of them read
 * their timestamps from the CURRENT clock — after a +7m52s NTP step at
 * T+37 s, the 2026-07-30 boot's fragment 0 landed within 1.5 s of the truth
 * and the session was contiguous. The residue is a mid-session discontinuity
 * (fragments either side of a late step disagree by the step size), which
 * `startMono` + `bootId` exist to let the cloud repair.
 *
 * Crash recovery: on startup, any `.mp4` without a sidecar in a non-active
 * session gets a best-effort sidecar from `session.json` + file stats — playable
 * footage is never discarded. A fragment splitmuxsink was mid-writing when the
 * process died has no moov and may be unplayable; it still gets a sidecar and
 * rides to the cloud (tagged `finalized:false`) rather than being deleted —
 * remux salvage is possible offline, deletion isn't.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { monotonicMs } from "./boot-policy.js";
import type { TimeSource } from "./session.js";

/** Per-session capture metadata, written once at capture-daemon spawn. */
export interface VideoSessionManifest {
  v: 1;
  deviceId: string;
  streamKey: string;
  sessionId: string;
  bootId: string;
  timeSource: TimeSource;
  preset: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  segmentSeconds: number;
  /** Wall-clock epoch ms at capture-daemon spawn. */
  anchorTs: number;
  /** process.hrtime.bigint() ns at capture-daemon spawn (stringified bigint). */
  anchorMono: string;
}

export const SESSION_MANIFEST_NAME = "session.json";

/** README contract + `anchor`/`finalized` provenance fields. */
export interface VideoSidecar {
  v: 1;
  deviceId: string;
  streamKey: string;
  sessionId: string;
  seq: number;
  startTs: number;
  /**
   * Monotonic-clock ms of the fragment start, in this boot's frame
   * (`session.json.bootId` scopes it). Derived from a wall/mono pair read at
   * SIDECAR-WRITE time, not from the session's spawn anchor: both readings
   * then sit on the same side of any clock correction, so a step between
   * spawn and finalize can no longer make this nonsense (Phase 8; the field
   * produced values like −1686357360550). This is the primitive cloud-side
   * re-anchoring (D6) would use, so it has to survive exactly the case that
   * re-anchoring exists for.
   */
  startMono: number;
  durationMs: number;
  sizeBytes: number;
  timeSource: TimeSource;
  codec: "h264";
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /**
   * How startTs was derived: mp4 birthtime ("fstat"), anchor+seq arithmetic
   * ("computed"), or — for a session's fragment 0 — the NEXT fragment's
   * birthtime minus the nominal segment length ("boundary", Phase 6.6):
   * fragment 0's own birthtime is the capture-process spawn (~2 s before real
   * frames), while the 0→1 rotation boundary is media-accurate (soak-measured
   * rotation jitter ≈ ±25 ms), so walking back from it is the honest anchor.
   */
  anchor: "fstat" | "computed" | "boundary";
  /** False when the fragment was cut off by a crash (may lack its moov atom). */
  finalized: boolean;
}

export function sidecarPathFor(mp4Path: string): string {
  return mp4Path.replace(/\.mp4$/, ".json");
}

/** Parse splitmuxsink's fragment number out of `<dir>/00042.mp4`. */
export function segmentSeq(name: string): number | null {
  const m = /^(\d{5,})\.mp4$/.exec(name);
  return m ? Number(m[1]) : null;
}

export function writeSessionManifest(dir: string, manifest: VideoSessionManifest): void {
  atomicWriteJson(join(dir, SESSION_MANIFEST_NAME), manifest);
}

export function readSessionManifest(dir: string): VideoSessionManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SESSION_MANIFEST_NAME), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const m = raw as VideoSessionManifest;
    if (m.v !== 1 || typeof m.sessionId !== "string" || typeof m.anchorTs !== "number") return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Build the sidecar for one closed fragment from the session manifest + file
 * stats. Pure given the stat result — unit-testable without a filesystem.
 */
export function buildSidecar(
  manifest: VideoSessionManifest,
  seq: number,
  stat: { sizeBytes: number; birthtimeMs: number; mtimeMs: number },
  opts: {
    finalized: boolean;
    /**
     * Birthtime of the NEXT fragment (the seq→seq+1 rotation point), passed by
     * the sweep for fragment 0 only. Fragment 0's own birthtime is the file
     * open at capture spawn — ~2 s of pipeline startup before real frames — so
     * anchoring to the boundary and walking back one nominal segment is far
     * closer to the first real frame (Phase 6.6).
     */
    boundaryEndMs?: number;
    /**
     * Time provenance AT SIDECAR-WRITE time (optimize-system-process-cycle
     * Phase 1): the live sweep passes the tracker's current value so segments
     * cut after an unsynced→ntp transition carry the upgraded value — the video
     * twin of telemetry's noteTimeSource. Absent (crash recovery of a dead
     * session), the manifest's spawn-time value is the best we know.
     */
    timeSource?: TimeSource;
    /**
     * Wall/monotonic pair read at sidecar-write time — `startMono` is derived
     * from THIS, not from the manifest's spawn anchor (Phase 8). Both halves
     * are read within microseconds of each other, so the pair is internally
     * consistent no matter how the clock has moved since spawn. Test seam;
     * defaults to reading both clocks now.
     */
    clockPair?: { wallMs: number; monoMs: number };
  },
): VideoSidecar {
  // ext4 gives real birthtimes; a zero/bogus one (some tmpfs, copied trees)
  // falls back to anchor arithmetic — that's exactly what `anchor` records.
  const nominalStart = manifest.anchorTs + seq * manifest.segmentSeconds * 1000;
  const haveBirth = stat.birthtimeMs > 1_000_000_000_000; // sanity: after 2001
  const haveBoundary =
    opts.boundaryEndMs !== undefined && opts.boundaryEndMs > 1_000_000_000_000;
  let startTs: number;
  let durationMs: number;
  let anchor: VideoSidecar["anchor"];
  if (haveBoundary) {
    durationMs = manifest.segmentSeconds * 1000;
    startTs = Math.round(opts.boundaryEndMs! - durationMs);
    anchor = "boundary";
  } else if (haveBirth) {
    startTs = Math.round(stat.birthtimeMs);
    const endTs = stat.mtimeMs > startTs ? stat.mtimeMs : startTs;
    durationMs = Math.round(endTs - startTs);
    anchor = "fstat";
  } else {
    startTs = nominalStart;
    durationMs = manifest.segmentSeconds * 1000;
    anchor = "computed";
  }
  // startMono from a fresh wall/mono PAIR, never from the spawn anchor: the
  // manifest's anchorTs was stamped under whatever clock the boot started
  // with, so `anchorMono + (startTs − anchorTs)` charged every clock
  // correction since spawn into a monotonic field. startTs itself is a wall
  // reading (file birthtime), so pairing it with a wall reading taken now and
  // converting through the mono reading taken now keeps both sides in one
  // frame — a step BEFORE this sweep is absorbed entirely, and a step during
  // the sweep costs at most that sweep's own duration.
  const pair = opts.clockPair ?? { wallMs: Date.now(), monoMs: monotonicMs() };
  return {
    v: 1,
    deviceId: manifest.deviceId,
    streamKey: manifest.streamKey,
    sessionId: manifest.sessionId,
    seq,
    startTs,
    startMono: Math.round(pair.monoMs - (pair.wallMs - startTs)),
    durationMs,
    sizeBytes: stat.sizeBytes,
    timeSource: opts.timeSource ?? manifest.timeSource,
    codec: "h264",
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    bitrateKbps: manifest.bitrateKbps,
    anchor,
    finalized: opts.finalized,
  };
}

export interface SweepResult {
  /** Sidecars written this sweep (mp4 paths). */
  closed: string[];
  /** The newest (active) fragment path, or null when the dir has no mp4s. */
  activePath: string | null;
}

/**
 * One pass over a session dir: every `.mp4` except the newest is closed — write
 * missing sidecars; the newest is the fragment splitmuxsink is still writing.
 * With `includeNewest` (capture stopped: EOS finalized the last fragment, or
 * orphan recovery of a dead session) the newest is closed too.
 *
 * Idempotent and cheap (one readdir + stats), so it doubles as the fs.watch
 * fallback poll and the crash-recovery scan.
 */
export function sweepSessionDir(
  dir: string,
  manifest: VideoSessionManifest,
  opts: {
    includeNewest: boolean;
    finalized?: boolean;
    timeSource?: TimeSource;
    /** Wall/mono pair for startMono (test seam); read once per sweep. */
    clockPair?: { wallMs: number; monoMs: number };
  },
): SweepResult {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { closed: [], activePath: null };
  }
  const frags = names
    .map((n) => ({ name: n, seq: segmentSeq(n) }))
    .filter((f): f is { name: string; seq: number } => f.seq !== null)
    .sort((a, b) => a.seq - b.seq);
  if (frags.length === 0) return { closed: [], activePath: null };

  const sidecars = new Set(names.filter((n) => n.endsWith(".json")));
  const newest = frags[frags.length - 1];
  const closed: string[] = [];
  // One pair for the whole sweep — every sidecar written in this pass shares
  // the same wall↔mono frame.
  const clockPair = opts.clockPair ?? { wallMs: Date.now(), monoMs: monotonicMs() };

  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    const isNewest = f.name === newest.name;
    if (isNewest && !opts.includeNewest) continue;
    const mp4Path = join(dir, f.name);
    if (sidecars.has(f.name.replace(/\.mp4$/, ".json"))) continue;
    let st;
    try {
      st = statSync(mp4Path);
    } catch {
      continue; // raced an eviction — skip
    }
    // Fragment 0's boundary anchor (Phase 6.6): its own birthtime is the file
    // open at capture spawn (~2 s before real frames), but the 0→1 rotation
    // point — the NEXT fragment's birthtime — is media-accurate. Only seq 0
    // suffers the spawn skew; later fragments' birthtimes ARE rotation points.
    let boundaryEndMs: number | undefined;
    if (f.seq === 0 && i + 1 < frags.length) {
      try {
        boundaryEndMs = statSync(join(dir, frags[i + 1].name)).birthtimeMs;
      } catch {
        /* next fragment raced an eviction — fall back to fstat anchoring */
      }
    }
    // A 0-byte fragment has two known causes and this sweep cannot tell them
    // apart: a power cut (data died in the page cache — observed on hardware)
    // and a source that never delivered a frame (observed 2026-08-06 —
    // `1080p30-4mbps` on the bench IMX290; the capture supervisor's progress
    // watchdog is what distinguishes THAT case, while the run is still alive).
    // Either way there is nothing to salvage and a sidecar would send garbage
    // through the Phase 4 uploader. Only reap it when the session is closed
    // (includeNewest) — live, the newest is still filling.
    if (st.size === 0) {
      if (opts.includeNewest) {
        try {
          unlinkSync(mp4Path);
          console.warn(`[recording] dropped empty fragment ${mp4Path}`);
        } catch {
          /* best effort */
        }
      }
      continue;
    }
    const sidecar = buildSidecar(
      manifest,
      f.seq,
      { sizeBytes: st.size, birthtimeMs: st.birthtimeMs, mtimeMs: st.mtimeMs },
      // The newest fragment of a dead session may have been cut mid-write; all
      // others were finalized by splitmuxsink before it opened the next one.
      {
        finalized: opts.finalized ?? !isNewest,
        boundaryEndMs,
        timeSource: opts.timeSource,
        clockPair,
      },
    );
    try {
      atomicWriteJson(sidecarPathFor(mp4Path), sidecar);
      closed.push(mp4Path);
    } catch (err) {
      console.error(`[recording] sidecar write failed for ${mp4Path}: ${(err as Error).message}`);
    }
  }
  return {
    closed,
    activePath: opts.includeNewest ? null : join(dir, newest.name),
  };
}

/**
 * Startup crash recovery for the video tree: every session dir that isn't in
 * `activeSessionIds` belongs to a previous run — sidecar-backfill all of its
 * fragments (newest tagged `finalized:false`). Sessions without a readable
 * session.json are left untouched (can't attribute metadata; the disk manager
 * will age them out). Returns the number of sidecars written.
 */
export function recoverOrphanVideoSessions(
  videoRoot: string,
  activeSessionIds: ReadonlySet<string> = new Set(),
): number {
  let recovered = 0;
  let streamKeys: string[];
  try {
    streamKeys = readdirSync(videoRoot);
  } catch {
    return 0; // no video tree yet
  }
  for (const streamKey of streamKeys) {
    const streamDir = join(videoRoot, streamKey);
    let sessions: string[];
    try {
      if (!statSync(streamDir).isDirectory()) continue;
      sessions = readdirSync(streamDir);
    } catch {
      continue;
    }
    for (const sessionId of sessions) {
      if (activeSessionIds.has(sessionId)) continue;
      const dir = join(streamDir, sessionId);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = readSessionManifest(dir);
      if (!manifest) continue;
      recovered += sweepSessionDir(dir, manifest, { includeNewest: true }).closed.length;
    }
  }
  return recovered;
}
