import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { TelemetryRecorder } from "../src/recording/telemetry-recorder.js";
import type { GroupSample } from "../src/agent/collectors/index.js";
import type { SegmentHeader } from "../src/recording/segments.js";
import type { TimeSource, TimeSourceTracker } from "../src/recording/session.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup(home);
});

function fakeTimeSource(initial: TimeSource = "ntp"): TimeSourceTracker & { set(v: TimeSource): void } {
  let value = initial;
  return {
    current: () => value,
    refresh: async () => value,
    set: (v) => {
      value = v;
    },
  };
}

function makeRecorder(samples: Record<string, GroupSample>, timeSource = fakeTimeSource()) {
  const dir = join(home, "recordings", "telemetry", "session-x");
  const header = (): SegmentHeader => ({
    type: "header",
    v: 1,
    deviceId: "dev-1",
    sessionId: "session-x",
    bootId: "boot-1",
    timeSource: timeSource.current(),
    rateHz: 10,
    startedAt: Date.now(),
  });
  const rec = new TelemetryRecorder({
    rateHz: 10,
    sampleGroups: async () => ({ ...samples }),
    timeSource,
    writer: { dir, header, maxAgeMs: 3_600_000 }, // no time rotation unless a test forces it
  });
  return { rec, dir };
}

function lines(dir: string): Record<string, unknown>[] {
  const gz = readdirSync(dir).filter((n) => n.endsWith(".jsonl.gz"));
  expect(gz).toHaveLength(1);
  return gunzipSync(readFileSync(join(dir, gz[0])))
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("TelemetryRecorder freshness gating", () => {
  it("writes a group only when its cache advanced, at its native cadence", async () => {
    const samples: Record<string, GroupSample> = {
      imu: { fields: { a: { value: 1 } }, updatedMono: 1n },
      gps: { fields: { lat: { value: 9 } }, updatedMono: 1n },
    };
    const { rec, dir } = makeRecorder(samples);

    await rec.tick(); // t=10000: both groups fresh → both written

    vi.setSystemTime(10_100);
    samples.imu = { ...samples.imu, updatedMono: 2n }; // imu advanced, gps did not
    await rec.tick(); // → imu only

    vi.setSystemTime(10_200);
    await rec.tick(); // nothing advanced → no line at all

    vi.setSystemTime(10_300);
    samples.gps = { ...samples.gps, updatedMono: 2n }; // gps advanced but 1 Hz cadence forbids (300ms < 900ms)
    await rec.tick();

    vi.setSystemTime(11_200);
    await rec.tick(); // now the gps gap (1.2s) clears the 1 Hz floor → gps written

    rec.stop();
    const all = lines(dir);
    expect(all[0]).toMatchObject({ type: "header", sessionId: "session-x" });
    const sampleLines = all.slice(1);
    expect(sampleLines.map((l) => Object.keys(l.metrics as object).sort())).toEqual([
      ["gps", "imu"], // t=10000
      ["imu"], // t=10100
      ["gps"], // t=11200 (10300 write was cadence-suppressed)
    ]);
    expect(sampleLines.map((l) => l.seq)).toEqual([0, 1, 2]); // monotonic, no gaps
    expect(sampleLines.map((l) => l.ts)).toEqual([10_000, 10_100, 11_200]);
  });

  it("caps a fast group at the recorder rate", async () => {
    // IMU cache updates every tick (native 20 Hz) but rateHz=10 → min gap 90 ms.
    const samples: Record<string, GroupSample> = {
      imu: { fields: { a: { value: 1 } }, updatedMono: 1n },
    };
    const { rec, dir } = makeRecorder(samples);
    let mono = 1n;
    for (let t = 0; t < 10; t++) {
      vi.setSystemTime(10_000 + t * 50); // ticking twice as fast as rateHz
      samples.imu = { fields: { a: { value: t } }, updatedMono: ++mono };
      await rec.tick();
    }
    rec.stop();
    const sampleLines = lines(dir).slice(1);
    // 10 ticks over 450 ms at a 90 ms floor → 5 writes (t=0,100,200,300,400ms).
    expect(sampleLines).toHaveLength(5);
  });

  it("re-emits a header when the time source flips mid-segment", async () => {
    const ts = fakeTimeSource("unsynced");
    const samples: Record<string, GroupSample> = {
      imu: { fields: { a: { value: 1 } }, updatedMono: 1n },
    };
    const { rec, dir } = makeRecorder(samples, ts);
    await rec.tick();

    vi.setSystemTime(10_100);
    samples.imu = { ...samples.imu, updatedMono: 2n };
    ts.set("ntp"); // NTP sync landed mid-segment
    await rec.tick();

    rec.stop();
    const all = lines(dir);
    expect(all.map((l) => l.type ?? "sample")).toEqual(["header", "sample", "header", "sample"]);
    expect(all[0].timeSource).toBe("unsynced");
    expect(all[2].timeSource).toBe("ntp");
  });

  it("rotates an idle open segment by age via tick()", async () => {
    const samples: Record<string, GroupSample> = {
      imu: { fields: { a: { value: 1 } }, updatedMono: 1n },
    };
    const dir = join(home, "recordings", "telemetry", "session-x");
    const rec = new TelemetryRecorder({
      rateHz: 10,
      sampleGroups: async () => ({ ...samples }),
      timeSource: fakeTimeSource(),
      writer: {
        dir,
        maxAgeMs: 500,
        header: () => ({
          type: "header",
          v: 1,
          deviceId: "d",
          sessionId: "session-x",
          bootId: "b",
          timeSource: "ntp",
          rateHz: 10,
          startedAt: Date.now(),
        }),
      },
    });
    await rec.tick(); // opens the segment
    vi.setSystemTime(10_600); // idle past maxAgeMs; imu not advanced
    await rec.tick(); // no write, but the age rotation must still fire
    expect(readdirSync(dir).some((n) => n.endsWith(".jsonl.gz"))).toBe(true);
    rec.stop();
  });
});
