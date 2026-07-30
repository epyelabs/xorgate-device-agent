import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uploader } from "../src/recording/uploader.js";
import { createVideoSource } from "../src/recording/video-source.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
let root: string;
let uploader: Uploader | null = null;

const S1 = "0198aaaa-0000-7000-8000-000000000001";
const S2 = "0198bbbb-0000-7000-8000-000000000002";

beforeEach(() => {
  home = tempHome();
  root = join(home, "recordings", "video");
});
afterEach(() => {
  uploader?.stop();
  uploader = null;
  cleanup(home);
});

/** Write an mp4(+sidecar) fragment; mtime settable for cross-stream ordering. */
function frag(
  streamKey: string,
  session: string,
  seq: number,
  opts: { sidecar?: boolean; mtimeMs?: number } = {},
): string {
  const dir = join(root, streamKey, session);
  mkdirSync(dir, { recursive: true });
  const name = `${String(seq).padStart(5, "0")}.mp4`;
  const path = join(dir, name);
  writeFileSync(path, `mp4-${streamKey}-${seq}`);
  if (opts.sidecar !== false) {
    writeFileSync(join(dir, name.replace(".mp4", ".json")), `{"seq":${seq}}`);
  }
  if (opts.mtimeMs !== undefined) {
    utimesSync(path, new Date(opts.mtimeMs), new Date(opts.mtimeMs));
  }
  return path;
}

function manifest(streamKey: string, session: string, mtimeMs?: number): string {
  const dir = join(root, streamKey, session);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.json");
  writeFileSync(path, `{"v":1,"sessionId":"${session}"}`);
  if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

const src = (active: string[] = [], now?: number) =>
  createVideoSource("dev-1", root, {
    isSessionActive: (id) => active.includes(id),
    ...(now !== undefined ? { now: () => now } : {}),
  });

describe("video segment source", () => {
  it("lists only sidecar'd pairs, with S3 keys and sidecar descriptors", () => {
    manifest("cam0", S1);
    const closed = frag("cam0", S1, 0);
    frag("cam0", S1, 1, { sidecar: false }); // active fragment — not listed
    const listed = src([S1]).listClosed();
    expect(listed.map((s) => s.path)).toEqual([closed]);
    expect(listed[0].name).toBe(`cam0/${S1}/00000.mp4`);
    expect(src().s3KeyFor(listed[0])).toBe(`media-sessions/v1/dev-1/cam0/${S1}/00000.mp4`);
    expect(listed[0].sidecar).toEqual({
      path: closed.replace(".mp4", ".json"),
      s3Key: `media-sessions/v1/dev-1/cam0/${S1}/00000.json`,
      contentType: "application/json",
    });
  });

  it("orders chronologically across streams by mtime, not by name", () => {
    manifest("cam0", S1);
    manifest("cam1", S2);
    frag("cam0", S1, 0, { mtimeMs: 1000 });
    frag("cam1", S2, 0, { mtimeMs: 2000 });
    frag("cam0", S1, 1, { mtimeMs: 3000 });
    const names = src([S1, S2]).listClosed().map((s) => s.name);
    expect(names).toEqual([
      `cam0/${S1}/00000.mp4`,
      `cam1/${S2}/00000.mp4`,
      `cam0/${S1}/00001.mp4`,
    ]);
  });

  it("returns null keys for unparseable names and skips bad path segments", () => {
    const s = src();
    expect(s.s3KeyFor({ path: "/x", name: "cam0/not-a-uuid/00000.mp4" })).toBeNull();
    expect(s.s3KeyFor({ path: "/x", name: `cam0/${S1}/evil.mp4` })).toBeNull();
    expect(s.s3KeyFor({ path: "/x", name: "no-slashes" })).toBeNull();
    expect(s.s3KeyFor({ path: "/x", name: `bad key/${S1}/00000.mp4` })).toBeNull();
  });

  it("reaps orphan sidecars (mp4 already uploaded) but never session.json", () => {
    manifest("cam0", S1);
    const dir = join(root, "cam0", S1);
    writeFileSync(join(dir, "00000.json"), "{}"); // pairless sidecar
    frag("cam0", S1, 1);
    src([S1]).listClosed();
    expect(existsSync(join(dir, "00000.json"))).toBe(false);
    expect(existsSync(join(dir, "session.json"))).toBe(true);
    expect(existsSync(join(dir, "00001.mp4"))).toBe(true);
  });

  it("reaps a drained, inactive, old session dir (manifest included)", () => {
    const path = manifest("cam0", S1, 1_000);
    const dir = join(root, "cam0", S1);
    expect(src([], 10 * 60_000 + 2_000).listClosed()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("reaps a drained session whose manifest mtime is in the FUTURE (Phase 8)", () => {
    // The 2026-07-29 NITZ excursion stamped four session dirs "Jan 5 2080".
    // Signed age went negative, so `age >= 10 min` was never true and the
    // husks were immortal — still on the bench disk a day later.
    const path = manifest("cam0", S1, Date.UTC(2080, 0, 5));
    src([], Date.UTC(2026, 6, 30)).listClosed();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(root, "cam0", S1))).toBe(false);
  });

  it("does NOT reap empty sessions that are active or too young", () => {
    manifest("cam0", S1, 1_000); // old but active
    manifest("cam0", S2, 5_000); // inactive but young
    const now = 10 * 60_000 + 2_000;
    src([S1], now).listClosed();
    expect(existsSync(join(root, "cam0", S1, "session.json"))).toBe(true);
    expect(existsSync(join(root, "cam0", S2, "session.json"))).toBe(true);
  });
});

describe("uploader with video pairs", () => {
  function run(sources = [src()]) {
    const calls: { key: string; body: string; ct: string }[] = [];
    let failNext: string | null = null;
    const up = new Uploader({
      sources,
      isOnline: () => true,
      mode: () => "auto",
      backoffMinMs: 5,
      backoffMaxMs: 10,
      put: async (key, body, ct) => {
        if (failNext && key.endsWith(failNext)) {
          failNext = null;
          throw new Error("boom");
        }
        calls.push({ key, body: body.toString("utf8"), ct });
      },
    });
    uploader = up;
    return { up, calls, fail: (suffix: string) => (failNext = suffix) };
  }

  it("PUTs sidecar before mp4 and deletes both only on mp4 success", async () => {
    manifest("cam0", S1);
    const mp4 = frag("cam0", S1, 0);
    const { up, calls } = run();
    up.kick();
    await up.settled();
    expect(calls.map((c) => c.key)).toEqual([
      `media-sessions/v1/dev-1/cam0/${S1}/00000.json`,
      `media-sessions/v1/dev-1/cam0/${S1}/00000.mp4`,
    ]);
    expect(calls[0].ct).toBe("application/json");
    expect(calls[1].ct).toBe("video/mp4");
    expect(existsSync(mp4)).toBe(false);
    expect(existsSync(mp4.replace(".mp4", ".json"))).toBe(false);
  });

  it("keeps both files and re-PUTs the sidecar when the mp4 PUT fails", async () => {
    manifest("cam0", S1);
    const mp4 = frag("cam0", S1, 0);
    const { up, calls, fail } = run();
    fail("00000.mp4"); // sidecar succeeds, mp4 fails once
    up.kick();
    await up.settled();
    expect(existsSync(mp4)).toBe(true);
    expect(existsSync(mp4.replace(".mp4", ".json"))).toBe(true);
    // Backoff retry re-PUTs the sidecar too, then the mp4.
    await new Promise((r) => setTimeout(r, 50));
    await up.settled();
    expect(calls.map((c) => c.key.split("/").pop())).toEqual([
      "00000.json",
      "00000.json",
      "00000.mp4",
    ]);
    expect(existsSync(mp4)).toBe(false);
  });
});
