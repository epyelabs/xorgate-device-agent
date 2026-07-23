import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSidecar,
  readSessionManifest,
  recoverOrphanVideoSessions,
  segmentSeq,
  sidecarPathFor,
  sweepSessionDir,
  writeSessionManifest,
  type VideoSessionManifest,
} from "../src/recording/video-segments.js";
import { DEFAULT_VIDEO_PRESET, findVideoPreset, resolveVideoPreset, videoPresetNames } from "../src/recording/video-presets.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const T0 = 1_750_000_000_000; // fixed epoch-ms anchor well after 2001

function manifest(overrides: Partial<VideoSessionManifest> = {}): VideoSessionManifest {
  return {
    v: 1,
    deviceId: "dev-1",
    streamKey: "cam0",
    sessionId: "sess-1",
    bootId: "boot-1",
    timeSource: "ntp",
    preset: "1080p15-2mbps",
    width: 1920,
    height: 1080,
    fps: 15,
    bitrateKbps: 2000,
    segmentSeconds: 60,
    anchorTs: T0,
    anchorMono: String(500n * 1_000_000_000n), // 500 s of uptime, in ns
    ...overrides,
  };
}

/** Session dir with n fragments whose file times mimic splitmuxsink rotation. */
function sessionDir(streamKey: string, sessionId: string, fragments: number): string {
  const dir = join(home, "recordings", "video", streamKey, sessionId);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fragments; i++) {
    const p = join(dir, `${String(i).padStart(5, "0")}.mp4`);
    writeFileSync(p, Buffer.alloc(1000 + i, 1));
    // birthtime can't be set portably; utimes sets mtime (fragment close).
    utimesSync(p, (T0 + i * 60_000) / 1000, (T0 + (i + 1) * 60_000) / 1000);
  }
  return dir;
}

describe("video presets", () => {
  it("resolves known presets and falls back to the default", () => {
    expect(findVideoPreset("1080p30-4mbps")).toMatchObject({ width: 1920, fps: 30, bitrateKbps: 4000 });
    expect(resolveVideoPreset("nope").name).toBe(DEFAULT_VIDEO_PRESET);
    expect(videoPresetNames()).toContain(DEFAULT_VIDEO_PRESET);
  });

  it("settings default preset exists in the table", async () => {
    const { RECORDING_DEFAULTS } = await import("../src/recording/config.js");
    expect(findVideoPreset(RECORDING_DEFAULTS.video.preset)).toBeDefined();
  });
});

describe("segmentSeq / sidecarPathFor", () => {
  it("parses splitmuxsink fragment names only", () => {
    expect(segmentSeq("00007.mp4")).toBe(7);
    expect(segmentSeq("session.json")).toBeNull();
    expect(segmentSeq("00007.json")).toBeNull();
    expect(segmentSeq("notes.mp4")).toBeNull();
    expect(sidecarPathFor("/a/b/00007.mp4")).toBe("/a/b/00007.json");
  });
});

describe("buildSidecar", () => {
  it("uses file birthtime when sane (anchor=fstat)", () => {
    const sc = buildSidecar(
      manifest(),
      2,
      { sizeBytes: 123, birthtimeMs: T0 + 120_000, mtimeMs: T0 + 180_000 },
      { finalized: true },
    );
    expect(sc).toMatchObject({
      seq: 2,
      startTs: T0 + 120_000,
      durationMs: 60_000,
      sizeBytes: 123,
      anchor: "fstat",
      finalized: true,
      codec: "h264",
      width: 1920,
    });
    // startMono derives from the anchor pair: 500 s + (startTs - anchorTs).
    expect(sc.startMono).toBe(500_000 + 120_000);
  });

  it("falls back to anchor arithmetic when birthtime is bogus (anchor=computed)", () => {
    const sc = buildSidecar(
      manifest(),
      3,
      { sizeBytes: 5, birthtimeMs: 0, mtimeMs: T0 + 240_000 },
      { finalized: false },
    );
    expect(sc).toMatchObject({
      startTs: T0 + 180_000,
      durationMs: 60_000,
      anchor: "computed",
      finalized: false,
    });
  });

  it("anchors fragment 0 to the next fragment's birthtime (anchor=boundary, Phase 6.6)", () => {
    // Fragment 0's own birthtime is the capture spawn — ~2 s before real
    // frames. The 0→1 rotation happened at T0+62 s; walking back one nominal
    // segment puts startTs at T0+2 s, not the spawn-time T0.
    const sc = buildSidecar(
      manifest(),
      0,
      { sizeBytes: 9, birthtimeMs: T0, mtimeMs: T0 + 62_000 },
      { finalized: true, boundaryEndMs: T0 + 62_000 },
    );
    expect(sc).toMatchObject({
      startTs: T0 + 2_000,
      durationMs: 60_000,
      anchor: "boundary",
    });
    expect(sc.startMono).toBe(500_000 + 2_000);
  });

  it("ignores a bogus boundary and falls back to fstat", () => {
    const sc = buildSidecar(
      manifest(),
      0,
      { sizeBytes: 9, birthtimeMs: T0, mtimeMs: T0 + 60_000 },
      { finalized: true, boundaryEndMs: 0 },
    );
    expect(sc.anchor).toBe("fstat");
    expect(sc.startTs).toBe(T0);
  });
});

describe("sweepSessionDir", () => {
  it("sidecars all but the newest fragment and reports it active", () => {
    const dir = sessionDir("cam0", "sess-1", 3);
    const res = sweepSessionDir(dir, manifest(), { includeNewest: false });
    expect(res.closed.length).toBe(2);
    expect(res.activePath).toBe(join(dir, "00002.mp4"));
    expect(existsSync(join(dir, "00000.json"))).toBe(true);
    expect(existsSync(join(dir, "00001.json"))).toBe(true);
    expect(existsSync(join(dir, "00002.json"))).toBe(false);
  });

  it("gives fragment 0 a boundary anchor when fragment 1 exists (Phase 6.6)", () => {
    const dir = sessionDir("cam0", "sess-b", 3);
    sweepSessionDir(dir, manifest(), { includeNewest: false });
    const sc0 = JSON.parse(readFileSync(join(dir, "00000.json"), "utf8")) as {
      anchor: string;
      startTs: number;
      durationMs: number;
    };
    expect(sc0.anchor).toBe("boundary");
    // startTs + durationMs lands exactly on fragment 1's birthtime.
    const sc1 = JSON.parse(readFileSync(join(dir, "00001.json"), "utf8")) as {
      startTs: number;
    };
    expect(Math.abs(sc0.startTs + sc0.durationMs - sc1.startTs)).toBeLessThanOrEqual(1);
  });

  it("is idempotent — a second sweep writes nothing new", () => {
    const dir = sessionDir("cam0", "sess-1", 3);
    sweepSessionDir(dir, manifest(), { includeNewest: false });
    const again = sweepSessionDir(dir, manifest(), { includeNewest: false });
    expect(again.closed.length).toBe(0);
  });

  it("includeNewest closes the last fragment (stop path)", () => {
    const dir = sessionDir("cam0", "sess-1", 2);
    sweepSessionDir(dir, manifest(), { includeNewest: false });
    const res = sweepSessionDir(dir, manifest(), { includeNewest: true, finalized: true });
    expect(res.closed).toEqual([join(dir, "00001.mp4")]);
    expect(res.activePath).toBeNull();
    const sc = JSON.parse(readFileSync(join(dir, "00001.json"), "utf8"));
    expect(sc.finalized).toBe(true);
  });

  it("reaps 0-byte power-cut fragments at session close instead of sidecaring them", () => {
    const dir = sessionDir("cam0", "sess-1", 2);
    writeFileSync(join(dir, "00002.mp4"), Buffer.alloc(0)); // power-cut artifact
    // Live sweep: the empty newest is left alone (still filling, in theory);
    // the two real fragments get sidecars.
    const live = sweepSessionDir(dir, manifest(), { includeNewest: false });
    expect(live.closed.length).toBe(2);
    expect(existsSync(join(dir, "00002.mp4"))).toBe(true);
    // Final/recovery sweep: reaped, no sidecar.
    const res = sweepSessionDir(dir, manifest(), { includeNewest: true });
    expect(existsSync(join(dir, "00002.mp4"))).toBe(false);
    expect(existsSync(join(dir, "00002.json"))).toBe(false);
    expect(res.closed).toEqual([]);
  });

  it("handles an empty/missing dir", () => {
    expect(sweepSessionDir(join(home, "nope"), manifest(), { includeNewest: true })).toEqual({
      closed: [],
      activePath: null,
    });
  });
});

describe("session manifest round-trip", () => {
  it("writes and reads back", () => {
    const dir = join(home, "recordings", "video", "cam0", "sess-1");
    mkdirSync(dir, { recursive: true });
    writeSessionManifest(dir, manifest());
    expect(readSessionManifest(dir)).toMatchObject({ sessionId: "sess-1", anchorTs: T0 });
  });

  it("returns null for missing or invalid manifests", () => {
    const dir = join(home, "x");
    mkdirSync(dir, { recursive: true });
    expect(readSessionManifest(dir)).toBeNull();
    writeFileSync(join(dir, "session.json"), "{broken");
    expect(readSessionManifest(dir)).toBeNull();
  });
});

describe("recoverOrphanVideoSessions", () => {
  it("backfills sidecars for dead sessions, marks the newest unfinalized", () => {
    const dir = sessionDir("cam0", "sess-dead", 3);
    writeSessionManifest(dir, manifest({ sessionId: "sess-dead" }));
    const n = recoverOrphanVideoSessions(join(home, "recordings", "video"));
    expect(n).toBe(3);
    const last = JSON.parse(readFileSync(join(dir, "00002.json"), "utf8"));
    expect(last.finalized).toBe(false);
    const first = JSON.parse(readFileSync(join(dir, "00000.json"), "utf8"));
    expect(first.finalized).toBe(true);
  });

  it("skips active sessions and sessions without a manifest", () => {
    const active = sessionDir("cam0", "sess-active", 2);
    writeSessionManifest(active, manifest({ sessionId: "sess-active" }));
    sessionDir("cam1", "sess-nomanifest", 2);
    const n = recoverOrphanVideoSessions(
      join(home, "recordings", "video"),
      new Set(["sess-active"]),
    );
    expect(n).toBe(0);
    expect(existsSync(join(active, "00000.json"))).toBe(false);
  });

  it("no-ops without a video tree", () => {
    expect(recoverOrphanVideoSessions(join(home, "recordings", "video"))).toBe(0);
  });
});
