import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  ReplayPlayer,
  createReplaySource,
  loadCatalog,
  loadScenario,
  parkedMetrics,
  replayCaptureHead,
  sampleAt,
  type LoadedScenario,
  type TraceSample,
} from "../src/agent/replay.js";
import { SEED_MARKER, planSeed, seedOnce } from "../src/agent/replay-seed.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
let assets: string;
beforeEach(() => {
  home = tempHome();
  assets = join(home, "assets");
});
afterEach(() => cleanup(home));

/** A tiny two-scenario asset pack in the real on-disk shape (build-scenario.mjs). */
function writePack(opts: { scenarios: { id: string; lapMs: number; samples: TraceSample[]; startTs: number; fragments?: number }[] }): void {
  mkdirSync(assets, { recursive: true });
  const catalog = {
    v: 1,
    home: { lat: 43.66, lon: -79.52 },
    seedSet: opts.scenarios.map((s) => s.id),
    scenarios: opts.scenarios.map((s) => ({ id: s.id, title: s.id, durationMs: s.lapMs, originalStartTs: s.startTs })),
  };
  writeFileSync(join(assets, "catalog.json"), JSON.stringify(catalog));
  for (const s of opts.scenarios) {
    const dir = join(assets, s.id);
    mkdirSync(join(dir, "cam0", "seg"), { recursive: true });
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(join(dir, "cam0", "lap.h264"), "h264");
    const fragments = s.fragments ?? 2;
    for (let i = 0; i < fragments; i += 1) {
      const name = String(i).padStart(5, "0");
      writeFileSync(join(dir, "cam0", "seg", `${name}.mp4`), `mp4-${s.id}-${i}`);
      writeFileSync(
        join(dir, "cam0", "seg", `${name}.json`),
        JSON.stringify({
          v: 1, deviceId: "src-device", streamKey: "cam0", sessionId: "src-session", seq: i,
          startTs: s.startTs + i * 60_000, startMono: 1000 + i, durationMs: 60_000, sizeBytes: 10,
          timeSource: "ntp", codec: "h264", width: 1280, height: 720, fps: 15, bitrateKbps: 1000,
          anchor: i === 0 ? "boundary" : "fstat", finalized: true,
        }),
      );
    }
    writeFileSync(join(dir, "telemetry", "trace.jsonl.gz"), gzipSync(Buffer.from(s.samples.map((x) => JSON.stringify(x)).join("\n") + "\n")));
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({
        v: 1, id: s.id, title: s.id, description: "", durationMs: s.lapMs,
        originalStartTs: s.startTs, originalEndTs: s.startTs + fragments * 60_000,
        streams: [{ streamKey: "cam0", lap: "cam0/lap.h264", width: 1280, height: 720, fps: 15, fragments: "cam0/seg/", fragmentCount: fragments, mediaDurationMs: s.lapMs }],
        telemetry: { trace: "telemetry/trace.jsonl.gz", rateHz: 1, samples: s.samples.length, tMin: s.samples[0].t, tMax: s.samples.at(-1)!.t },
      }),
    );
  }
}

const gps = (lat: number, speed: number) => ({ gps: { lat: { value: lat }, lon: { value: -79 }, speed: { value: speed, unit: "km/h" }, fix_quality: { value: 1 } }, system: { cpu_usage: { value: 10 } } });
const trace = (n: number, t0 = 0): TraceSample[] => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 1000, seq: i, metrics: gps(43 + i / 1000, i) }));

describe("replay sampler", () => {
  const samples = trace(5, 1700); // t = 1700, 2700, … (the city trace starts 1.7 s in)
  it("returns the nearest sample at or before the offset, and null before the first", () => {
    expect(sampleAt(samples, 0)).toBeNull();
    expect(sampleAt(samples, 1699)).toBeNull();
    expect(sampleAt(samples, 1700)!.seq).toBe(0);
    expect(sampleAt(samples, 2699)!.seq).toBe(0);
    expect(sampleAt(samples, 2700)!.seq).toBe(1);
    expect(sampleAt(samples, 999_999)!.seq).toBe(4);
  });
  it("parked metrics keep the position and zero the speed with its unit", () => {
    const p = parkedMetrics(gps(43.5, 88));
    expect(p.gps.lat).toEqual({ value: 43.5 });
    expect(p.gps.speed).toEqual({ value: 0, unit: "km/h" });
    expect(p.system).toEqual({ cpu_usage: { value: 10 } });
  });
  it("the capture head is the Phase 0 recipe with the scenario's framerate", () => {
    const head = replayCaptureHead("/a/lap.h264", 15).join(" ");
    expect(head).toBe("filesrc location=/a/lap.h264 ! h264parse ! video/x-h264,framerate=15/1 ! avdec_h264 ! identity sync=true ! videoconvert ! videorate");
  });
});

describe("ReplayPlayer lap clock", () => {
  function fakeScenario(samples: TraceSample[], lapMs: number): LoadedScenario {
    return { manifest: { v: 1, id: "x", title: "x", durationMs: lapMs, originalStartTs: 0, originalEndTs: lapMs, streams: [{ streamKey: "cam0", lap: "cam0/lap.h264", width: 1280, height: 720, fps: 15, fragments: "cam0/seg/", fragmentCount: 1, mediaDurationMs: lapMs }], telemetry: { trace: "t", rateHz: 1, samples: samples.length, tMin: samples[0].t, tMax: samples.at(-1)!.t } }, dir: "/x", samples, lapMs };
  }
  it("reads nothing before the lap, the trace during it, parked after it; updatedMono is the sample's own time", () => {
    let mono = 10_000;
    let hr = 5_000_000_000n;
    const player = new ReplayPlayer(fakeScenario(trace(4), 4000), { monoMs: () => mono, hrtime: () => hr });
    expect(player.readMetrics()).toEqual({});
    expect(player.sampleGroups()).toEqual({});
    player.startLap(1_700_000_000_000);
    const lapHr = hr;
    expect(player.readMetrics().gps.speed).toEqual({ value: 0, unit: "km/h" });
    mono += 2500; hr += 2_500_000_000n;
    expect(player.readMetrics().gps.speed).toEqual({ value: 2, unit: "km/h" });
    const g = player.sampleGroups();
    expect(g.gps.updatedMono).toBe(lapHr + 2_000_000_000n); // sample t=2000 ms, NOT the read time
    expect(g.system.updatedMono).toBe(lapHr + 2_000_000_000n);
    mono += 300; hr += 300_000_000n;
    expect(player.sampleGroups().gps.updatedMono).toBe(lapHr + 2_000_000_000n); // same sample → same stamp
    mono += 1500;
    expect(player.lapElapsed()).toBe(true);
    player.endLap(true);
    expect(player.phaseName()).toBe("gap");
    expect(player.readMetrics().gps.lat).toEqual({ value: 43.003 }); // last sample reached (t=3000)
    expect(player.readMetrics().gps.speed).toEqual({ value: 0, unit: "km/h" });
    const parked1 = player.sampleGroups().gps.updatedMono;
    hr += 1_000_000_000n;
    expect(player.sampleGroups().gps.updatedMono).toBeGreaterThan(parked1); // parked samples refresh
    player.endLap(false);
    expect(player.phaseName()).toBe("parked");
    player.startLap(1_700_000_010_000);
    expect(player.state().lapIndex).toBe(2);
  });
});

describe("createReplaySource", () => {
  function pack(): void {
    writePack({ scenarios: [
      { id: "city-a", lapMs: 3000, samples: trace(3), startTs: 1_700_000_000_000 },
      { id: "hwy-b", lapMs: 2000, samples: trace(2, -1000), startTs: 1_700_500_000_000 },
    ] });
  }
  it("loads the settings scenario (falling back to the catalog's first) and drives laps from capture callbacks", async () => {
    pack();
    let mono = 0;
    let settings: { scenarioId?: string; loop?: boolean; gapSeconds?: number } | undefined = { scenarioId: "hwy-b", gapSeconds: 7 };
    const events: string[] = [];
    const host = { cycles: 0, rotations: [] as string[], cycleVideo() { this.cycles += 1; }, rotateTelemetrySession(why: string) { this.rotations.push(why); } };
    const src = createReplaySource({
      config: { assetsDir: assets, defaultScenarioId: "nope" }, settings: () => settings, media: null,
      monoMs: () => mono, hrtime: () => BigInt(mono) * 1_000_000n, now: () => 1_800_000_000_000 + mono, tickMs: 0,
      onEvent: (_l, m) => events.push(m),
    });
    src.attachHost(host);
    expect(src.scenario().manifest.id).toBe("hwy-b");
    expect(src.sourceHead({ streamKey: "cam0", cameraName: "replay" })[1]).toBe(`location=${join(assets, "hwy-b", "cam0", "lap.h264")}`);
    expect(src.streamGuard("cam0")).toBe("ok");
    expect(src.streamGuard("cam1")).toBe("no-pipeline");
    expect((await src.read()).metrics).toEqual({});
    expect((await src.read()).media.streams).toEqual([]);

    src.onPlaying("cam1", 1); // not the clock stream
    expect(src.status().phase).toBe("idle");
    src.onPlaying("cam0", 1_800_000_000_000);
    expect(src.status()).toMatchObject({ phase: "lap", lapIndex: 1, videoDriven: true });
    expect(host.rotations).toEqual(["replay lap 1"]);
    expect((await src.read()).metrics.gps?.lat).toEqual({ value: 43.001 }); // t=-1000 sample at offset 0 → seq 1? no: samples at -1000 and 0 → offset 0 → seq 1
    mono += 1500;
    expect((await src.sampleGroups()).gps.fields).toEqual(gps(43.001, 1).gps);
    src.onEnded("cam0", true);
    expect(src.status().phase).toBe("gap");
    expect(src.respawnHoldMs("cam0")).toBe(7000);
    expect(src.respawnHoldMs("cam1")).toBe(0);
    expect((await src.read()).metrics.gps?.speed).toEqual({ value: 0, unit: "km/h" });
    settings = { scenarioId: "hwy-b", loop: false };
    expect(src.respawnHoldMs("cam0")).toBeNull();

    // Scenario switch via settings: ends the lap through the host, hold 0, next spawn gets the new lap.
    settings = { scenarioId: "city-a" };
    src.reapply();
    expect(host.cycles).toBe(1);
    expect(src.respawnHoldMs("cam0")).toBe(0);
    expect(src.sourceHead({ streamKey: "cam0", cameraName: "replay" })[1]).toContain("city-a");
    src.onPlaying("cam0", 1_800_000_010_000);
    expect(src.status()).toMatchObject({ phase: "lap", lapIndex: 2, scenarioId: "city-a" });
    expect(src.respawnHoldMs("cam0")).toBe(30_000); // default gap, switch no longer pending
    src.reapply(); // unchanged → no-op
    expect(host.cycles).toBe(1);
    settings = { scenarioId: "missing" };
    src.reapply();
    expect(src.status().scenarioId).toBe("city-a"); // unknown id → warned, catalog first… which IS city-a
    src.stop();
    expect(events.some((e) => e.includes("scenario switched to city-a"))).toBe(true);
  });

  it("runs the lap clock on its own timer when no capture child ever reports PLAYING", () => {
    pack();
    let mono = 0;
    const src = createReplaySource({
      config: { assetsDir: assets, defaultScenarioId: "city-a" }, settings: () => ({ gapSeconds: 2 }), media: null,
      monoMs: () => mono, hrtime: () => BigInt(mono) * 1_000_000n, now: () => mono, tickMs: 0,
    });
    src.tick();
    expect(src.status().phase).toBe("idle");
    mono = 46_000;
    src.tick();
    expect(src.status()).toMatchObject({ phase: "lap", lapIndex: 1, videoDriven: false });
    mono += 3000; // lapMs
    src.tick();
    expect(src.status().phase).toBe("gap");
    mono += 2000;
    src.tick();
    expect(src.status()).toMatchObject({ phase: "lap", lapIndex: 2 });
    src.stop();
  });
});

describe("first-boot seeding", () => {
  it("plans one delta so the newest scenario ends 1 h before now and spacing is kept; ids are fresh", () => {
    writePack({ scenarios: [
      { id: "old", lapMs: 120_000, samples: trace(3, -2000), startTs: 1_700_000_000_000 },
      { id: "new", lapMs: 120_000, samples: trace(3), startTs: 1_700_900_000_000 },
    ] });
    const cat = loadCatalog(assets);
    const scenarios = cat.seedSet.map((id) => loadScenario(assets, id));
    const now = 1_800_000_000_000;
    const plan = planSeed(scenarios, { now, endBeforeMs: 3_600_000, mint: (ms) => `id-${ms}` });
    const newest = scenarios[1].manifest.originalEndTs;
    expect(plan.deltaMs).toBe(now - 3_600_000 - newest);
    expect(plan.sessions[1].endTs).toBe(now - 3_600_000);
    expect(plan.sessions[0].startTs - plan.sessions[1].startTs).toBe(1_700_000_000_000 - 1_700_900_000_000);
    expect(plan.sessions[0].mediaSessionId).toBe(`id-${1_700_000_000_000 + plan.deltaMs}`);
    expect(plan.sessions[0].telemetrySessionId).toBe(`id-${1_700_000_000_000 + plan.deltaMs - 2000}`);
  });

  it("writes symlinked fragments, rewritten sidecars and telemetry segments once, then never again", () => {
    writePack({ scenarios: [{ id: "city-a", lapMs: 120_000, samples: trace(70), startTs: 1_700_000_000_000, fragments: 2 }] });
    const root = join(home, "recordings");
    const opts = {
      catalog: loadCatalog(assets), loadScenario: (id: string) => loadScenario(assets, id),
      recordingsRoot: root, home, deviceId: "sim-device", bootId: "boot-1",
      now: () => 1_800_000_000_000, mint: (ms: number) => `0000${ms}`.slice(-36).padStart(36, "a"),
    };
    const first = seedOnce(opts);
    expect(first.seeded).toBe(true);
    expect(existsSync(join(home, SEED_MARKER))).toBe(true);
    const s = first.plan!.sessions[0];
    const videoDir = join(root, "video", "cam0", s.mediaSessionId);
    expect(readdirSync(videoDir).sort()).toEqual(["00000.json", "00000.mp4", "00001.json", "00001.mp4"]);
    expect(lstatSync(join(videoDir, "00000.mp4")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(videoDir, "00001.mp4"), "utf8")).toBe("mp4-city-a-1"); // reads through the link
    const sc = JSON.parse(readFileSync(join(videoDir, "00001.json"), "utf8"));
    expect(sc).toMatchObject({ deviceId: "sim-device", sessionId: s.mediaSessionId, seq: 1, startTs: 1_700_000_060_000 + first.plan!.deltaMs, timeSource: "ntp", finalized: true, anchor: "fstat", sizeBytes: 10 });
    expect(existsSync(join(videoDir, "session.json"))).toBe(false);
    const telDir = join(root, "telemetry", s.telemetrySessionId);
    const segs = readdirSync(telDir).sort();
    expect(segs).toHaveLength(2); // 70 samples → 60 + 10
    expect(segs[0]).toBe(`seg-${s.startTs}-00000.jsonl.gz`);
    const lines = gunzipSync(readFileSync(join(telDir, segs[0]))).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "header", deviceId: "sim-device", sessionId: s.telemetrySessionId, bootId: "boot-1", timeSource: "ntp", rateHz: 1, startedAt: s.startTs });
    expect(lines).toHaveLength(61);
    expect(lines[1]).toMatchObject({ ts: s.startTs, seq: 0 });
    expect(lines[60].ts).toBe(s.startTs + 59_000);
    expect(lines[60].metrics.gps.lat).toEqual({ value: 43.059 });

    const second = seedOnce(opts);
    expect(second).toEqual({ seeded: false, reason: "already-seeded" });
    expect(readdirSync(join(root, "video", "cam0"))).toHaveLength(1);
  });
});
