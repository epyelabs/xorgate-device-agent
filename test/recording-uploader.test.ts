import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Uploader, type SegmentSource, type UploadSegment } from "../src/recording/uploader.js";
import { createTelemetrySource } from "../src/recording/telemetry-source.js";
import { cleanup, delay, tempHome } from "./helpers.js";

let home: string;
let uploader: Uploader | null = null;

beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  uploader?.stop();
  uploader = null;
  cleanup(home);
});

/** Write a closed telemetry segment and return its path. */
function seg(root: string, session: string, startTs: number, seq: number): string {
  const dir = join(root, session);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `seg-${startTs}-${String(seq).padStart(5, "0")}.jsonl.gz`);
  writeFileSync(path, `payload-${session}-${seq}`);
  return path;
}

interface PutCall {
  key: string;
  body: string;
}

function makeUploader(
  sources: SegmentSource[],
  opts: {
    online?: () => boolean;
    mode?: () => "auto" | "off";
    fail?: (call: PutCall) => Error | null;
    onPut?: (call: PutCall, signal: AbortSignal) => Promise<void>;
  } = {},
): { up: Uploader; calls: PutCall[]; events: string[] } {
  const calls: PutCall[] = [];
  const events: string[] = [];
  const up = new Uploader({
    sources,
    isOnline: opts.online ?? (() => true),
    mode: opts.mode ?? (() => "auto"),
    backoffMinMs: 20,
    backoffMaxMs: 100,
    onEvent: (_l, msg) => events.push(msg),
    put: async (key, body, _ct, signal) => {
      const call = { key, body: body.toString("utf8") };
      if (opts.onPut) await opts.onPut(call, signal);
      const err = opts.fail?.(call);
      if (err) throw err;
      calls.push(call);
    },
  });
  uploader = up;
  return { up, calls, events };
}

describe("telemetry segment source", () => {
  it("derives the S3 key from the segment name (seg- prefix stripped)", () => {
    const root = join(home, "recordings", "telemetry");
    const path = seg(root, "0198aaaa-0000-7000-8000-000000000001", 1753000000000, 3);
    const src = createTelemetrySource("dev-1", root);
    const listed = src.listClosed();
    expect(listed.map((s) => s.path)).toEqual([path]);
    expect(src.s3KeyFor(listed[0])).toBe(
      "telemetry/v1/dev-1/0198aaaa-0000-7000-8000-000000000001/1753000000000-00003.jsonl.gz",
    );
  });

  it("lists sessions and segments oldest-first, ignoring active .jsonl files", () => {
    const root = join(home, "recordings", "telemetry");
    seg(root, "0198bbbb-0000-7000-8000-000000000002", 2000, 0);
    seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 1);
    seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    writeFileSync(join(root, "0198aaaa-0000-7000-8000-000000000001", "seg-999-00009.jsonl"), "active");
    const names = createTelemetrySource("d", root)
      .listClosed()
      .map((s) => s.name);
    expect(names).toEqual([
      "0198aaaa-0000-7000-8000-000000000001/seg-1000-00000.jsonl.gz",
      "0198aaaa-0000-7000-8000-000000000001/seg-1000-00001.jsonl.gz",
      "0198bbbb-0000-7000-8000-000000000002/seg-2000-00000.jsonl.gz",
    ]);
  });

  it("returns null keys for unrecognized names", () => {
    const src = createTelemetrySource("d", join(home, "none"));
    expect(src.s3KeyFor({ path: "/x", name: "sess/whatever.jsonl.gz" })).toBeNull();
    expect(src.s3KeyFor({ path: "/x", name: "no-slash" })).toBeNull();
  });
});

describe("Uploader", () => {
  it("drains oldest-first and deletes each file only after a successful PUT", async () => {
    const root = join(home, "recordings", "telemetry");
    const p1 = seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    const p2 = seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 1);
    const src = createTelemetrySource("d", root);
    const { up, calls } = makeUploader([src]);
    up.kick();
    await up.settled();
    expect(calls.map((c) => c.key)).toEqual([
      "telemetry/v1/d/0198aaaa-0000-7000-8000-000000000001/1000-00000.jsonl.gz",
      "telemetry/v1/d/0198aaaa-0000-7000-8000-000000000001/1000-00001.jsonl.gz",
    ]);
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(false);
    expect(up.status().uploading).toBe(false);
    expect(up.status().lastUploadAt).not.toBeNull();
  });

  it("orders sources by priority (telemetry before video)", async () => {
    const order: string[] = [];
    const fake = (kind: string, priority: number, n: number): SegmentSource => {
      let files: UploadSegment[] = Array.from({ length: n }, (_, i) => {
        const path = join(home, `${kind}-${i}`);
        writeFileSync(path, kind);
        return { path, name: `${kind}-${i}` };
      });
      return {
        kind,
        priority,
        contentType: "application/octet-stream",
        listClosed: () => files,
        s3KeyFor: (s) => {
          // Simulate delete-on-success by dropping uploaded entries next scan.
          files = files.filter((f) => existsSync(f.path));
          return s.name;
        },
      };
    };
    const video = fake("video", 1, 1);
    const telem = fake("telemetry", 0, 2);
    const { up } = makeUploader([video, telem], {
      onPut: async (call) => {
        order.push(call.key);
      },
    });
    up.kick();
    await up.settled();
    expect(order).toEqual(["telemetry-0", "telemetry-1", "video-0"]);
  });

  it("does not run while offline or when upload mode is off", async () => {
    const root = join(home, "recordings", "telemetry");
    seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    const src = createTelemetrySource("d", root);

    let online = false;
    let mode: "auto" | "off" = "auto";
    const { up, calls } = makeUploader([src], { online: () => online, mode: () => mode });

    up.kick(); // offline — no-op
    await up.settled();
    expect(calls).toHaveLength(0);

    online = true;
    mode = "off";
    up.kick(); // mode off — no-op
    await up.settled();
    expect(calls).toHaveLength(0);

    mode = "auto";
    up.kick();
    await up.settled();
    expect(calls).toHaveLength(1);
  });

  it("backs off on failure and retries until success", async () => {
    const root = join(home, "recordings", "telemetry");
    const p = seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    const src = createTelemetrySource("d", root);
    let failures = 2;
    const { up, calls, events } = makeUploader([src], {
      fail: () => (failures-- > 0 ? new Error("boom") : null),
    });
    up.kick();
    await delay(300); // 2 backoff rounds at 20/40 ms + the successful attempt
    expect(calls).toHaveLength(1);
    expect(existsSync(p)).toBe(false);
    expect(events.filter((e) => e.includes("retrying")).length).toBeGreaterThanOrEqual(2);
  });

  it("pause() aborts the in-flight PUT and a later kick resumes", async () => {
    const root = join(home, "recordings", "telemetry");
    const p = seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    const src = createTelemetrySource("d", root);
    let online = true;
    let abortedSeen = false;
    let block = true;
    const { up, calls } = makeUploader([src], {
      online: () => online,
      onPut: async (_call, signal) => {
        if (!block) return;
        await new Promise<void>((_res, rej) => {
          signal.addEventListener("abort", () => {
            abortedSeen = true;
            rej(new Error("aborted"));
          });
        });
      },
    });
    up.kick();
    await delay(30); // let the PUT start and block
    online = false;
    up.pause();
    await up.settled();
    expect(abortedSeen).toBe(true);
    expect(existsSync(p)).toBe(true); // not deleted — PUT never confirmed
    expect(calls).toHaveLength(0);

    block = false;
    online = true;
    up.kick();
    await up.settled();
    expect(calls).toHaveLength(1);
    expect(existsSync(p)).toBe(false);
  });

  it("skips unparseable segment names without blocking the queue", async () => {
    const root = join(home, "recordings", "telemetry");
    const dir = join(root, "0198aaaa-0000-7000-8000-000000000001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "weird.jsonl.gz"), "x");
    seg(root, "0198aaaa-0000-7000-8000-000000000001", 1000, 0);
    const src = createTelemetrySource("d", root);
    const { up, calls, events } = makeUploader([src]);
    up.kick();
    await up.settled();
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.includes("unrecognized"))).toBe(true);
    // The weird file is left alone (never deleted, never uploaded).
    expect(existsSync(join(dir, "weird.jsonl.gz"))).toBe(true);
  });
});
