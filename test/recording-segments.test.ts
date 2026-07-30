import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  finalizeOrphanSegments,
  SegmentWriter,
  type SegmentHeader,
} from "../src/recording/segments.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const header = (): SegmentHeader => ({
  type: "header",
  v: 1,
  deviceId: "dev-1",
  sessionId: "session-a",
  bootId: "boot-1",
  timeSource: "ntp",
  rateHz: 10,
  startedAt: 1000,
});

function sessionDir(): string {
  return join(home, "recordings", "telemetry", "session-a");
}

function gzLines(path: string): Record<string, unknown>[] {
  return gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("SegmentWriter", () => {
  it("opens lazily, writes a header first, and rotates by age into a gz", () => {
    const closed: string[] = [];
    let mono = 1000; // rotation age is monotonic (Phase 8), naming stays wall
    const w = new SegmentWriter({
      dir: sessionDir(),
      header,
      maxAgeMs: 1000,
      monoMs: () => mono,
      onSegmentClosed: (p) => closed.push(p),
    });
    expect(existsSync(sessionDir())).toBe(false); // nothing until the first sample

    w.writeLine({ ts: 1000, mono: 1, seq: 0, metrics: { imu: { a: 1 } } }, 1000);
    mono = 1100;
    w.writeLine({ ts: 1100, mono: 2, seq: 1, metrics: { imu: { a: 2 } } }, 1100);
    expect(w.activePath()).toMatch(/seg-1000-00000\.jsonl$/);

    // Crossing maxAgeMs rotates BEFORE the next write, which opens segment #2.
    mono = 2500;
    w.writeLine({ ts: 2500, mono: 3, seq: 2, metrics: { imu: { a: 3 } } }, 2500);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/seg-1000-00000\.jsonl\.gz$/);

    const lines = gzLines(closed[0]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "header", v: 1, sessionId: "session-a", rateHz: 10 });
    expect(lines[1]).toMatchObject({ seq: 0 });
    expect(lines[2]).toMatchObject({ seq: 1 });
    // Plain file of the closed segment is gone; segment #2 is the active plain.
    const names = readdirSync(sessionDir()).sort();
    expect(names).toEqual(["seg-1000-00000.jsonl.gz", "seg-2500-00001.jsonl"]);
  });

  it("applies default rotation limits when options are passed as undefined (manager path)", () => {
    const closed: string[] = [];
    let mono = 1000;
    const w = new SegmentWriter({
      dir: sessionDir(),
      header,
      maxBytes: undefined, // exactly how RecordingManager forwards absent overrides
      maxAgeMs: undefined,
      monoMs: () => mono,
      onSegmentClosed: (p) => closed.push(p),
    });
    w.writeLine({ ts: 1000, mono: 1, seq: 0, metrics: { imu: { a: 1 } } }, 1000);
    mono = 62_000;
    w.writeLine({ ts: 62_000, mono: 2, seq: 1, metrics: { imu: { a: 2 } } }, 62_000); // > default 60 s
    expect(closed).toHaveLength(1);
  });

  it("keeps rolling after the wall clock jumps backwards (Phase 8)", () => {
    // Field case (2026-07-29): the stepper put the clock in 2080, then NTP
    // rewound it 53 years mid-segment. With wall-clock age, `now - openedAt`
    // went hugely negative and the roller never rolled again for the rest of
    // the boot — one segment per drive instead of ~18.
    const closed: string[] = [];
    let mono = 0;
    const w = new SegmentWriter({
      dir: sessionDir(),
      header,
      maxAgeMs: 60_000,
      monoMs: () => mono,
      onSegmentClosed: (p) => closed.push(p),
    });
    const future = Date.UTC(2080, 0, 6, 0, 0, 52);
    w.writeLine({ ts: future, mono: 1, seq: 0, metrics: { imu: { a: 1 } } }, future);
    // 60 s of real time later the clock has been rewound to 2026.
    mono = 60_000;
    const rewound = Date.UTC(2026, 6, 29, 23, 24, 54);
    w.writeLine({ ts: rewound, mono: 2, seq: 1, metrics: { imu: { a: 2 } } }, rewound);
    expect(closed).toHaveLength(1);
    // ...and it keeps rolling on the monotonic cadence afterwards.
    mono = 120_000;
    w.writeLine({ ts: rewound + 60_000, mono: 3, seq: 2, metrics: { imu: { a: 3 } } }, rewound + 60_000);
    expect(closed).toHaveLength(2);
  });

  it("rotates by size", () => {
    const closed: string[] = [];
    const w = new SegmentWriter({
      dir: sessionDir(),
      header,
      maxBytes: 200,
      maxAgeMs: 60_000,
      onSegmentClosed: (p) => closed.push(p),
    });
    for (let i = 0; i < 10; i++) {
      w.writeLine({ ts: 1000 + i, mono: i, seq: i, metrics: { imu: { a: i } } }, 1000 + i);
    }
    expect(closed.length).toBeGreaterThan(0);
    // Every closed segment decodes and starts with a header.
    for (const gz of closed) expect(gzLines(gz)[0].type).toBe("header");
  });

  it("finalize() closes the active segment and discards sample-less ones", () => {
    const closed: string[] = [];
    const w = new SegmentWriter({ dir: sessionDir(), header, onSegmentClosed: (p) => closed.push(p) });
    w.writeLine({ ts: 1, mono: 1, seq: 0, metrics: { gps: { lat: 1 } } }, 1000);
    w.finalize();
    w.finalize(); // idempotent
    expect(closed).toHaveLength(1);
    expect(readdirSync(sessionDir())).toEqual(["seg-1000-00000.jsonl.gz"]);
  });

  it("re-emits a header line when the time source changes mid-segment", () => {
    const w = new SegmentWriter({ dir: sessionDir(), header });
    w.writeLine({ ts: 1, mono: 1, seq: 0, metrics: { imu: { a: 1 } } }, 1000);
    w.noteTimeSource("ntp"); // unchanged — no extra line
    w.noteTimeSource("unsynced"); // changed — header re-emitted
    w.writeLine({ ts: 2, mono: 2, seq: 1, metrics: { imu: { a: 2 } } }, 1001);
    w.finalize();
    const lines = gzLines(join(sessionDir(), "seg-1000-00000.jsonl.gz"));
    expect(lines.map((l) => l.type ?? "sample")).toEqual(["header", "sample", "header", "sample"]);
    expect(lines[2].timeSource).toBe("unsynced");
  });
});

describe("finalizeOrphanSegments", () => {
  it("gzips leftover plain segments, truncating a torn last line", () => {
    const dir = join(home, "recordings", "telemetry", "old-session");
    mkdirSync(dir, { recursive: true });
    const head = JSON.stringify(header());
    const good = JSON.stringify({ ts: 1, mono: 1, seq: 0, metrics: {} });
    writeFileSync(join(dir, "seg-500-00000.jsonl"), `${head}\n${good}\n{"ts":2,"mo`); // torn tail

    const n = finalizeOrphanSegments(join(home, "recordings", "telemetry"));
    expect(n).toBe(1);
    const names = readdirSync(dir);
    expect(names).toEqual(["seg-500-00000.jsonl.gz"]);
    const lines = gzLines(join(dir, "seg-500-00000.jsonl.gz"));
    expect(lines).toHaveLength(2); // torn third line dropped
    expect(lines[1]).toMatchObject({ seq: 0 });
  });

  it("deletes segments with no complete sample and stray gzip temps", () => {
    const dir = join(home, "recordings", "telemetry", "old-session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "seg-1-00000.jsonl"), `${JSON.stringify(header())}\n`); // header only
    writeFileSync(join(dir, "seg-2-00001.jsonl"), `{"ts":1,"mo`); // torn only
    writeFileSync(join(dir, "seg-3-00002.jsonl.gz.tmp.123"), "junk");

    const n = finalizeOrphanSegments(join(home, "recordings", "telemetry"));
    expect(n).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is a no-op when the tree does not exist", () => {
    expect(finalizeOrphanSegments(join(home, "recordings", "telemetry"))).toBe(0);
    expect(existsSync(join(home, "recordings"))).toBe(false);
  });
});
