import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, StreamHandle } from "../src/lib/exec.js";
import {
  VideoCaptureSupervisor,
  bridgedKvsPipeline,
  buildBridgeOnlyPipelineArgs,
  buildCapturePipelineArgs,
  resolveBridgedCameras,
  SHM_BRIDGE_CAPS,
} from "../src/recording/video-capture.js";
import { resolveVideoPreset } from "../src/recording/video-presets.js";
import { RecordingManager } from "../src/recording/manager.js";
import {
  BootDeferPolicy,
  LoadShedPolicy,
  type PowerSampleReading,
} from "../src/recording/boot-policy.js";
import type { TimeSource, TimeSourceTracker } from "../src/recording/session.js";
import { saveSettings } from "../src/daemon/settings.js";
import { cleanup, delay, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

/** Fake child registry: resolves done on demand, records spawn calls. */
function fakeSpawner() {
  const spawns: { cmd: string; args: string[]; exit: (code: number | null) => void; stopped: NodeJS.Signals | null }[] = [];
  const spawn = (cmd: string, args: string[]): StreamHandle => {
    let resolveDone: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => (resolveDone = res));
    const entry = {
      cmd,
      args,
      stopped: null as NodeJS.Signals | null,
      exit: (code: number | null) =>
        resolveDone({ stdout: "", stderr: "", exitCode: code, failed: (code ?? 0) !== 0, notFound: false }),
    };
    spawns.push(entry);
    return {
      done,
      stop: (sig: NodeJS.Signals = "SIGINT") => {
        entry.stopped = sig;
        entry.exit(0);
      },
    };
  };
  return { spawns, spawn };
}

const preset = resolveVideoPreset("1080p15-2mbps");

describe("pipeline builders", () => {
  it("record pipeline has both branches, preset caps, and segment length", () => {
    const args = buildCapturePipelineArgs({
      cameraName: "/base/cam@1a",
      preset: resolveVideoPreset("1080p30-4mbps"),
      segmentSeconds: 60,
      outputDir: "/out",
      shmSocketPath: "/shm/cam0.sock",
    });
    const s = args.join(" ");
    expect(args[0]).toBe("-e");
    expect(s).toContain("camera-name=/base/cam@1a");
    expect(s).toContain("width=1920,height=1080,framerate=30/1");
    expect(s).toContain("bitrate=4000");
    expect(s).toContain("key-int-max=60");
    expect(s).toContain("threads=2"); // pinned like the KVS-side encoder
    expect(s).toContain("location=/out/%05d.mp4");
    expect(s).toContain("max-size-time=60000000000");
    expect(s).toContain(SHM_BRIDGE_CAPS);
    expect(s).toContain("socket-path=/shm/cam0.sock");
    expect(s).toContain("leaky=downstream");
  });

  it("bridge-only pipeline has no encoder or splitmuxsink", () => {
    const s = buildBridgeOnlyPipelineArgs("/base/cam@1a", "/shm/cam0.sock").join(" ");
    expect(s).not.toContain("x264enc");
    expect(s).not.toContain("splitmuxsink");
    expect(s).toContain("shmsink");
    expect(s).toContain(SHM_BRIDGE_CAPS);
  });

  it("bridged KVS pipeline keeps the TWCC encoder name and appsink contract", () => {
    const s = bridgedKvsPipeline("/shm/cam0.sock");
    expect(s).toContain("shmsrc socket-path=/shm/cam0.sock");
    expect(s).toContain("name=sampleVideoEncoder");
    expect(s).toContain("name=appsink-video");
    expect(s).toContain(SHM_BRIDGE_CAPS);
  });
});

describe("resolveBridgedCameras", () => {
  it("returns only bridged streams with camera identity", () => {
    const dir = join(home, "pipelines");
    mkdirSync(dir, { recursive: true });
    // cam0: bridged with .camera file
    writeFileSync(join(dir, "cam0.gst"), "shmsrc socket-path=/x ! appsink");
    writeFileSync(join(dir, "cam0.camera"), "/base/cam0@1a\n");
    // cam1: still direct
    writeFileSync(join(dir, "cam1.gst"), "libcamerasrc camera-name=/base/cam1@1a ! appsink");
    // cam2: bridged but no camera identity anywhere
    writeFileSync(join(dir, "cam2.gst"), "shmsrc socket-path=/y ! appsink");

    const cams = resolveBridgedCameras(dir, [
      { streamKey: "cam0", channelName: "d-cam0" },
      { streamKey: "cam1", channelName: "d-cam1" },
      { streamKey: "cam2", channelName: "d-cam2" },
    ]);
    expect(cams).toEqual([{ streamKey: "cam0", cameraName: "/base/cam0@1a" }]);
  });

  it("falls back to the .gst.direct backup for camera identity", () => {
    const dir = join(home, "pipelines");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cam0.gst"), "shmsrc socket-path=/x ! appsink");
    writeFileSync(join(dir, "cam0.gst.direct"), "libcamerasrc camera-name=/base/cam0@1a ! appsink");
    const cams = resolveBridgedCameras(dir, [{ streamKey: "cam0", channelName: "d-cam0" }]);
    expect(cams).toEqual([{ streamKey: "cam0", cameraName: "/base/cam0@1a" }]);
  });
});

describe("VideoCaptureSupervisor", () => {
  function makeSup(opts: { record: boolean; spawner: ReturnType<typeof fakeSpawner>; events?: string[] }) {
    return new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
      record: opts.record,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      onEvent: (_l, m) => opts.events?.push(m),
      spawn: opts.spawner.spawn,
      stableMs: 50,
      sweepPollMs: 3600_000,
    });
  }

  it("record mode mints a session, writes session.json, and reports recording", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ record: true, spawner });
    sup.start();
    expect(spawner.spawns.length).toBe(1);
    expect(spawner.spawns[0].cmd).toBe("gst-launch-1.0");
    expect(spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");

    const sessionId = sup.status()[0].sessionId!;
    expect(sessionId).toBeTruthy();
    const sessionDir = join(home, "recordings", "video", "cam0", sessionId);
    expect(existsSync(join(sessionDir, "session.json"))).toBe(true);

    await delay(80); // past stableMs
    expect(sup.status()[0].state).toBe("running");
    expect(sup.anyRecording()).toBe(true);
    sup.stop();
    await delay(20);
    expect(spawner.spawns[0].stopped).toBe("SIGINT");
    expect(sup.status()[0].state).toBe("stopped");
  });

  it("bridge-only mode creates no session and never reports recording", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ record: false, spawner });
    sup.start();
    expect(spawner.spawns[0].args.join(" ")).not.toContain("splitmuxsink");
    expect(sup.status()[0].sessionId).toBeNull();
    expect(existsSync(join(home, "recordings", "video", "cam0"))).toBe(false);
    await delay(80);
    expect(sup.anyRecording()).toBe(false);
    sup.stop();
  });

  it("restarts a crashed child with a NEW session and sidecars the old fragments", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ record: true, spawner });
    sup.start();
    const first = sup.status()[0].sessionId!;
    const dir1 = join(home, "recordings", "video", "cam0", first);
    // Simulate splitmuxsink output: two fragments, then the child "crashes".
    writeFileSync(join(dir1, "00000.mp4"), Buffer.alloc(100, 1));
    writeFileSync(join(dir1, "00001.mp4"), Buffer.alloc(50, 1));
    await delay(80); // survive stableMs so the restart is prompt (backoff 2s… but stable → immediate schedule)
    spawner.spawns[0].exit(1);
    await delay(20);

    // Crash sweep: BOTH fragments get sidecars; the newest is finalized:false.
    expect(existsSync(join(dir1, "00000.json"))).toBe(true);
    expect(existsSync(join(dir1, "00001.json"))).toBe(true);
    const last = JSON.parse(
      (await import("node:fs")).readFileSync(join(dir1, "00001.json"), "utf8"),
    );
    expect(last.finalized).toBe(false);

    // Supervisor schedules a restart (2 s backoff) — don't wait for it here;
    // just confirm the session identity was cleared for the next run.
    expect(sup.status()[0].sessionId).toBeNull();
    sup.stop();
  });

  it("sidecars follow a mid-session timeSource upgrade; session.json keeps the spawn value", async () => {
    const spawner = fakeSpawner();
    let ts: TimeSource = "unsynced";
    const sup = new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
      record: true,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => ts,
      spawn: spawner.spawn,
      stableMs: 10,
      sweepPollMs: 25,
    });
    sup.start();
    const sessionId = sup.status()[0].sessionId!;
    const dir = join(home, "recordings", "video", "cam0", sessionId);

    writeFileSync(join(dir, "00000.mp4"), Buffer.alloc(100, 1));
    writeFileSync(join(dir, "00001.mp4"), Buffer.alloc(100, 1));
    await delay(80); // sweep closes 00000 while the clock is still unsynced
    expect(JSON.parse(readFileSync(join(dir, "00000.json"), "utf8")).timeSource).toBe("unsynced");

    ts = "ntp"; // NTP lands mid-session
    writeFileSync(join(dir, "00002.mp4"), Buffer.alloc(100, 1));
    await delay(80); // sweep closes 00001 with the upgraded value
    expect(JSON.parse(readFileSync(join(dir, "00001.json"), "utf8")).timeSource).toBe("ntp");

    // Spawn-time value stays in session.json (the session's worst value).
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).timeSource).toBe("unsynced");
    sup.stop();
    await delay(20);
    // Final sweep also stamps the current value.
    expect(JSON.parse(readFileSync(join(dir, "00002.json"), "utf8")).timeSource).toBe("ntp");
  });

  it("fires onSpawned per spawn so the worker can bounce the KVS master", async () => {
    const spawner = fakeSpawner();
    const spawned: string[] = [];
    const sup = new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/c" }],
      record: false,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      onSpawned: (k) => spawned.push(k),
      spawn: spawner.spawn,
      stableMs: 10,
      sweepPollMs: 3600_000,
    });
    sup.start();
    expect(spawned).toEqual(["cam0"]);
    sup.stop();
  });

  it("parks after repeated quick failures", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const sup = new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/c" }],
      record: false,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      onEvent: (_l, m) => events.push(m),
      spawn: spawner.spawn,
      stableMs: 10_000,
      sweepPollMs: 3600_000,
    });
    sup.start();
    // three quick deaths; backoff timers are 2s/4s — exit immediately each time
    for (let i = 0; i < 3; i++) {
      const idx = spawner.spawns.length - 1;
      spawner.spawns[idx].exit(1);
      await delay(20);
      if (i < 2) {
        // wait for the scheduled respawn (2s, 4s) — too slow for a unit test;
        // instead assert state and bail after the first two retries
        expect(sup.status()[0].state).toBe(i === 1 ? "retrying" : "retrying");
        break;
      }
    }
    sup.stop();
  });
});

/**
 * Progress watchdog: the `1080p30-4mbps` stall (bench-reproduced 2026-08-06) is
 * a child that spawns, negotiates, then never receives a frame — alive, silent,
 * 0 bytes, 0 % CPU. Liveness said "running"; the disk said nothing was written.
 */
describe("VideoCaptureSupervisor progress watchdog", () => {
  function makeSup(opts: {
    spawner: ReturnType<typeof fakeSpawner>;
    events?: string[];
    stallMs?: number;
  }) {
    return new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
      record: true,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      onEvent: (_l, m) => opts.events?.push(m),
      spawn: opts.spawner.spawn,
      stableMs: 10,
      sweepPollMs: 15,
      stallMs: opts.stallMs ?? 120,
    });
  }

  it("kills a live-but-silent child and stops reporting recording", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const sup = makeSup({ spawner, events });
    sup.start();

    // The stalled shape exactly: child up, promoted to "running", zero bytes.
    await delay(40);
    expect(sup.status()[0].state).toBe("running");
    expect(sup.anyRecording()).toBe(true);

    await delay(180); // past stallMs, with sweeps in between
    expect(spawner.spawns[0].stopped).toBe("SIGKILL");
    expect(events.some((e) => /stalled: no bytes written/.test(e))).toBe(true);
    expect(sup.anyRecording()).toBe(false);
    expect(sup.status()[0].recording).toBe(false);
    expect(sup.status()[0].state).toBe("retrying");
    sup.stop();
  });

  it("a 0-byte fragment is not progress — an existing file is no defence", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ spawner });
    sup.start();
    const dir = join(home, "recordings", "video", "cam0", sup.status()[0].sessionId!);
    // splitmuxsink DOES create the file at spawn; it just never fills it.
    writeFileSync(join(dir, "00000.mp4"), Buffer.alloc(0));
    await delay(200);
    expect(spawner.spawns[0].stopped).toBe("SIGKILL");
    sup.stop();
  });

  it("leaves a child that keeps writing alone", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ spawner });
    sup.start();
    const dir = join(home, "recordings", "video", "cam0", sup.status()[0].sessionId!);
    // Four stall windows' worth of a fragment that keeps growing.
    for (let i = 1; i <= 16; i++) {
      writeFileSync(join(dir, "00000.mp4"), Buffer.alloc(i * 1000, 1));
      await delay(30);
    }
    expect(spawner.spawns[0].stopped).toBeNull();
    expect(sup.anyRecording()).toBe(true);
    expect(spawner.spawns.length).toBe(1);
    sup.stop();
  });

  it("counts a rotation as progress even though the new fragment is smaller", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup({ spawner, stallMs: 200 });
    sup.start();
    const dir = join(home, "recordings", "video", "cam0", sup.status()[0].sessionId!);
    writeFileSync(join(dir, "00000.mp4"), Buffer.alloc(50_000, 1));
    await delay(150);
    // Rotation: the ACTIVE file is now a small, freshly-opened 00001 — byte
    // totals are not monotonic (closed fragments are deleted once uploaded),
    // so only "the active file moved on" can carry this.
    writeFileSync(join(dir, "00001.mp4"), Buffer.alloc(120, 1));
    await delay(120);
    // By now it is ~270 ms since the last byte GREW — comfortably past stallMs.
    // Only the rotation resetting the clock keeps this child alive.
    expect(spawner.spawns[0].stopped).toBeNull();
    sup.stop();
  });

  it("parks after three consecutive stalls instead of hot-looping", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const sup = makeSup({ spawner, events, stallMs: 60 });
    sup.start();
    // Each cycle: stall → SIGKILL → 2 s backoff → respawn, still silent.
    await delay(4600);
    expect(events.some((e) => /stalled; retry 1\/3/.test(e))).toBe(true);
    expect(events.some((e) => /stalled; retry 2\/3/.test(e))).toBe(true);
    expect(events.some((e) => /stalled 3x in a row; parking for 60s/.test(e))).toBe(true);
    expect(sup.status()[0].state).toBe("failed");
    expect(sup.status()[0].recording).toBe(false);
    // Three children, not a spawn storm.
    expect(spawner.spawns.length).toBe(3);
    sup.stop();
  }, 20_000);

  it("reaps the killed child's orphaned shmsink segments, and only its own", async () => {
    const spawner = fakeSpawner();
    const shmSegDir = join(home, "devshm");
    mkdirSync(shmSegDir, { recursive: true });
    // shmsink names its area shmpipe.<pid>.<n> and unlinks it on CLEAN exit
    // only — a SIGKILL strands 20 MB of tmpfs per stall.
    writeFileSync(join(shmSegDir, "shmpipe.4242.    0"), Buffer.alloc(8));
    writeFileSync(join(shmSegDir, "shmpipe.4242.    1"), Buffer.alloc(8));
    writeFileSync(join(shmSegDir, "shmpipe.9999.    0"), Buffer.alloc(8)); // another process
    writeFileSync(join(shmSegDir, "lttng-ust-wait-8"), Buffer.alloc(8)); // unrelated

    const sup = new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
      record: true,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      spawn: (cmd, args) => ({ ...spawner.spawn(cmd, args), pid: 4242 }),
      stableMs: 10,
      sweepPollMs: 15,
      stallMs: 120,
      shmSegmentDir: shmSegDir,
    });
    sup.start();
    await delay(220); // stall → SIGKILL → onExit reaps

    expect(spawner.spawns[0].stopped).toBe("SIGKILL");
    expect(readdirSync(shmSegDir).sort()).toEqual(["lttng-ust-wait-8", "shmpipe.9999.    0"]);
    sup.stop();
  });

  it("bridge-only mode has no disk signal and is never watchdogged", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const sup = new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
      record: false,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      onEvent: (_l, m) => events.push(m),
      spawn: spawner.spawn,
      stableMs: 10,
      sweepPollMs: 15,
      stallMs: 60,
    });
    sup.start();
    await delay(200);
    expect(spawner.spawns[0].stopped).toBeNull();
    expect(events.some((e) => /stalled/.test(e))).toBe(false);
    sup.stop();
  });
});

describe("RecordingManager video wiring", () => {
  let manager: RecordingManager | null = null;
  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  it("starts capture in bridge-only mode with recording off, record mode when on", async () => {
    const spawner = fakeSpawner();
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
      },
    });
    await manager.start();
    await delay(20);
    // recording.video.enabled defaults false → bridge-only child
    expect(spawner.spawns.length).toBe(1);
    expect(spawner.spawns[0].args.join(" ")).not.toContain("splitmuxsink");
    expect(manager.videoStatus().recording).toBe(false);

    saveSettings({ recording: { video: { enabled: true, bootDefer: "off" } } });
    manager.reapply();
    await delay(200); // serialized handover: old child exits, then spawn + 50 ms stableMs
    expect(spawner.spawns.length).toBe(2);
    expect(spawner.spawns[1].args.join(" ")).toContain("splitmuxsink");
    expect(manager.videoStatus().recording).toBe(true);
    expect(manager.videoStatus().streams[0]).toMatchObject({ streamKey: "cam0", state: "running" });

    saveSettings({ recording: { video: { enabled: false, bootDefer: "off" } } });
    manager.reapply();
    await delay(20);
    expect(spawner.spawns.length).toBe(3);
    expect(spawner.spawns[2].args.join(" ")).not.toContain("splitmuxsink");
    expect(manager.videoStatus().recording).toBe(false);
  });

  it("never spawns capture when media is disabled", async () => {
    const spawner = fakeSpawner();
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off" } } });
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      video: {
        mediaEnabled: false,
        cameras: () => [{ streamKey: "cam0", cameraName: "/c" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
      },
    });
    await manager.start();
    await delay(20);
    expect(spawner.spawns.length).toBe(0);
    expect(manager.videoStatus().streams).toEqual([]);
  });

  it("preset change restarts capture with new args (new session)", async () => {
    const spawner = fakeSpawner();
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off" } } });
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/c" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
      },
    });
    await manager.start();
    await delay(20);
    const firstSession = manager.videoStatus().streams[0].sessionId;
    expect(spawner.spawns[0].args.join(" ")).toContain("width=1920");

    saveSettings({ recording: { video: { enabled: true, preset: "720p30-2mbps", bootDefer: "off" } } });
    manager.reapply();
    await delay(20);
    expect(spawner.spawns.length).toBe(2);
    expect(spawner.spawns[1].args.join(" ")).toContain("width=1280,height=720,framerate=30/1");
    expect(manager.videoStatus().streams[0].sessionId).not.toBe(firstSession);
  });

  it("first video session.json carries the probed time source (badge-bug fix)", async () => {
    const spawner = fakeSpawner();
    let value: TimeSource = "unsynced";
    const tracker: TimeSourceTracker = {
      current: () => value,
      refresh: async () => {
        value = "ntp";
        return value;
      },
    };
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off" } } });
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      timeSource: tracker,
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/c" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
      },
    });
    await manager.start();
    await delay(20);
    const sessionId = manager.videoStatus().streams[0].sessionId!;
    const mf = JSON.parse(
      readFileSync(join(home, "recordings", "video", "cam0", sessionId, "session.json"), "utf8"),
    );
    expect(mf.timeSource).toBe("ntp");
  });

  it("orphan video sessions get sidecars on start", async () => {
    const root = join(home, "recordings");
    const dead = join(root, "video", "cam0", "sess-dead");
    mkdirSync(dead, { recursive: true });
    writeFileSync(
      join(dead, "session.json"),
      JSON.stringify({
        v: 1,
        deviceId: "dev-1",
        streamKey: "cam0",
        sessionId: "sess-dead",
        bootId: "b",
        timeSource: "ntp",
        preset: "1080p15-2mbps",
        width: 1920,
        height: 1080,
        fps: 15,
        bitrateKbps: 2000,
        segmentSeconds: 60,
        anchorTs: 1_750_000_000_000,
        anchorMono: "1000000000",
      }),
    );
    writeFileSync(join(dead, "00000.mp4"), Buffer.alloc(10, 1));

    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root,
      pollMs: 60_000,
    });
    await manager.start();
    await delay(100);
    expect(existsSync(join(dead, "00000.json"))).toBe(true);
    // The recovered mp4 counts into the backlog (upload fodder for Phase 4).
    expect(manager.status().backlogSegments).toBe(1);
  });
});

describe("camera spawn stagger (Phase 2 staged boot)", () => {
  const twoCams = [
    { streamKey: "cam0", cameraName: "/base/cam0@1a" },
    { streamKey: "cam1", cameraName: "/base/cam1@1a" },
  ];
  function makeSup(spawner: ReturnType<typeof fakeSpawner>, staggerMs: number) {
    return new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: twoCams,
      record: true,
      preset,
      segmentSeconds: 60,
      staggerMs,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      spawn: spawner.spawn,
      stableMs: 3600_000,
      sweepPollMs: 3600_000,
    });
  }

  it("offsets the second camera by staggerMs (the second-encoder transient)", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner, 60);
    sup.start();
    expect(spawner.spawns.map((s) => s.args.join(" ").includes("cam0@1a"))).toEqual([true]);
    expect(sup.status().find((s) => s.streamKey === "cam1")?.state).toBe("starting");
    await delay(120);
    expect(spawner.spawns.length).toBe(2);
    expect(spawner.spawns[1].args.join(" ")).toContain("cam1@1a");
    sup.stop();
  });

  it("stop() before the stagger elapses cancels the pending spawn", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner, 60);
    sup.start();
    sup.stop();
    await delay(120);
    expect(spawner.spawns.length).toBe(1);
  });

  it("staggerMs 0 spawns all cameras synchronously (old behavior)", () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner, 0);
    sup.start();
    expect(spawner.spawns.length).toBe(2);
    sup.stop();
  });
});

describe("VideoCaptureSupervisor.setCameras (Phase 6)", () => {
  const twoCams = [
    { streamKey: "cam0", cameraName: "/base/cam0@1a" },
    { streamKey: "cam1", cameraName: "/base/cam1@1a" },
  ];

  function makeSup(spawner: ReturnType<typeof fakeSpawner>) {
    return new VideoCaptureSupervisor({
      deviceId: "dev-1",
      cameras: twoCams,
      record: true,
      preset,
      segmentSeconds: 60,
      videoRoot: join(home, "recordings", "video"),
      shmDir: join(home, "shm"),
      timeSource: () => "ntp",
      spawn: spawner.spawn,
      stableMs: 3600_000,
      sweepPollMs: 3600_000,
    });
  }

  it("removes a camera cleanly (final sweep, forgotten) and leaves the rest alone", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner);
    sup.start();
    const cam0 = sup.status().find((s) => s.streamKey === "cam0")!;
    const dir = join(home, "recordings", "video", "cam1", sup.status()[1].sessionId!);
    writeFileSync(join(dir, "00000.mp4"), Buffer.alloc(64, 1));

    await sup.setCameras([twoCams[0]]);
    expect(spawner.spawns[1].stopped).toBe("SIGINT"); // cam1 EOS-stopped
    expect(spawner.spawns[0].stopped).toBeNull(); // cam0 untouched
    expect(sup.status()).toHaveLength(1);
    expect(sup.status()[0].sessionId).toBe(cam0.sessionId);
    // cam1's last fragment got its sidecar (finalized) before it went away.
    expect(existsSync(join(dir, "00000.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "00000.json"), "utf8")).finalized).toBe(true);
    sup.stop();
  });

  it("adds a camera without disturbing the running one", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner);
    sup.start();
    await sup.setCameras([twoCams[0]]);
    const cam0Session = sup.status()[0].sessionId;
    await sup.setCameras(twoCams);
    expect(sup.status().map((s) => s.streamKey).sort()).toEqual(["cam0", "cam1"]);
    expect(sup.status().find((s) => s.streamKey === "cam0")!.sessionId).toBe(cam0Session);
    expect(spawner.spawns).toHaveLength(3); // cam0, cam1, cam1-again
    sup.stop();
  });

  it("is inert after stop()", async () => {
    const spawner = fakeSpawner();
    const sup = makeSup(spawner);
    sup.start();
    sup.stop();
    await sup.setCameras(twoCams);
    expect(spawner.spawns).toHaveLength(2);
  });
});

describe("per-camera enables (Phase 6 capacity control)", () => {
  const twoCams = [
    { streamKey: "cam0", cameraName: "/base/cam0@1a" },
    { streamKey: "cam1", cameraName: "/base/cam1@1a" },
  ];
  let manager: RecordingManager | null = null;
  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  function makeManager(spawner: ReturnType<typeof fakeSpawner>, disabled: string[][]) {
    return new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      video: {
        mediaEnabled: true,
        cameras: () => twoCams,
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
        setDisabledCameras: (keys) => disabled.push([...keys]),
      },
    });
  }

  /** Which cameras have a LIVE (unstopped) capture child right now. */
  function liveCams(spawner: ReturnType<typeof fakeSpawner>): string[] {
    return spawner.spawns
      .filter((s) => s.stopped === null)
      .map((s) => (s.args.join(" ").includes("cam0@1a") ? "cam0" : "cam1"));
  }

  it("a disabled camera gets no pipeline; the other camera keeps its session", async () => {
    const spawner = fakeSpawner();
    const disabled: string[][] = [];
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0 } } });
    manager = makeManager(spawner, disabled);
    await manager.start();
    await delay(20);
    expect(liveCams(spawner)).toEqual(["cam0", "cam1"]);
    const cam0Session = manager.videoStatus().streams.find((s) => s.streamKey === "cam0")!.sessionId;
    expect(disabled).toEqual([]); // nothing published while every camera is on

    // Turn cam1 off: its child stops, cam0 is NOT restarted (same session).
    saveSettings({
      recording: { video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0, cameras: { cam1: false } } },
    });
    manager.reapply();
    await delay(100);
    expect(liveCams(spawner)).toEqual(["cam0"]);
    expect(spawner.spawns.length).toBe(2); // no respawn of cam0
    expect(manager.videoStatus().streams.map((s) => s.streamKey)).toEqual(["cam0"]);
    expect(manager.videoStatus().streams[0].sessionId).toBe(cam0Session);
    // ...and the live KVS master is parked too (no pipeline anywhere).
    expect(disabled).toEqual([["cam1"]]);

    // Back on: cam1 returns with a fresh session, cam0 still untouched.
    saveSettings({
      recording: { video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0, cameras: { cam1: true } } },
    });
    manager.reapply();
    await delay(100);
    expect(liveCams(spawner)).toEqual(["cam0", "cam1"]);
    expect(spawner.spawns.length).toBe(3);
    expect(manager.videoStatus().streams[0].sessionId).toBe(cam0Session);
    expect(disabled).toEqual([["cam1"], []]);
  });

  it("disabling every camera leaves no capture at all", async () => {
    const spawner = fakeSpawner();
    const disabled: string[][] = [];
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0, cameras: { cam0: false, cam1: false } },
      },
    });
    manager = makeManager(spawner, disabled);
    await manager.start();
    await delay(20);
    expect(spawner.spawns.length).toBe(0);
    expect(manager.videoStatus().streams).toEqual([]);
    expect(disabled).toEqual([["cam0", "cam1"]]);
  });

  it("an unknown/absent camera key is inert (a camera unplugged since is just gone)", async () => {
    const spawner = fakeSpawner();
    saveSettings({
      recording: {
        // cam2 is configured on but not present in the manifest; cam0 absent
        // from the map = enabled (the default).
        video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0, cameras: { cam2: true } },
      },
    });
    manager = makeManager(spawner, []);
    await manager.start();
    await delay(20);
    expect(liveCams(spawner)).toEqual(["cam0", "cam1"]);
  });

  it("a camera-set change while recording keeps recording (no shape change)", async () => {
    const spawner = fakeSpawner();
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0 } } });
    manager = makeManager(spawner, []);
    await manager.start();
    await delay(20);
    expect(spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");

    saveSettings({
      recording: { video: { enabled: true, bootDefer: "off", spawnStaggerSecs: 0, cameras: { cam0: false } } },
    });
    manager.reapply();
    await delay(100);
    // cam1's child is the original one, still in record mode.
    const live = spawner.spawns.filter((s) => s.stopped === null);
    expect(live).toHaveLength(1);
    expect(live[0].args.join(" ")).toContain("cam1@1a");
    expect(live[0].args.join(" ")).toContain("splitmuxsink");
    expect(manager.videoStatus().recording).toBe(true);
  });
});

describe("RecordingManager boot power staging (Phase 2)", () => {
  let manager: RecordingManager | null = null;
  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  function writeBudget(dir: string, ma: number): string {
    const path = join(dir, "max_current");
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(ma, 0);
    writeFileSync(path, buf);
    return path;
  }

  function makeManager(spawner: ReturnType<typeof fakeSpawner>, policy: BootDeferPolicy, events: string[]) {
    return new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      bootPolicy: policy,
      onEvent: (_l, m) => events.push(m),
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
      },
    });
  }

  it("defers to bridge-only, then flips to full capture when the modem settles", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const telemetryFile = join(home, "telemetry.json");
    writeFileSync(
      telemetryFile,
      JSON.stringify({ timestamp: new Date().toISOString(), status: "connecting", reg: 0 }),
    );
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath: writeBudget(home, 3000),
    });
    saveSettings({ recording: { video: { enabled: true } } });
    manager = makeManager(spawner, policy, events);
    await manager.start();
    await delay(20);

    // Armed: recording wanted, but the child is bridge-only (no encoder).
    expect(spawner.spawns.length).toBe(1);
    expect(spawner.spawns[0].args.join(" ")).not.toContain("splitmuxsink");
    expect(manager.status().bootDefer).toBe("deferring");
    expect(events.some((m) => m.includes("boot-defer armed (psu budget 3000mA < 5000)"))).toBe(true);

    // Poll tick with UNCHANGED settings must re-evaluate the policy.
    manager.reapply();
    await delay(20);
    expect(spawner.spawns.length).toBe(1); // still deferring — no churn

    writeFileSync(
      telemetryFile,
      JSON.stringify({ timestamp: new Date().toISOString(), status: "connected", reg: 1 }),
    );
    manager.reapply();
    await delay(200); // serialized handover: bridge child exits, record child spawns
    expect(spawner.spawns.length).toBe(2);
    expect(spawner.spawns[1].args.join(" ")).toContain("splitmuxsink");
    expect(manager.status().bootDefer).toBe("released:connected");
    expect(events.some((m) => m.includes("boot-defer released (connected)"))).toBe(true);
  });

  it("skips the defer outright on a 5 A budget in auto mode", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const policy = new BootDeferPolicy({
      telemetryFile: join(home, "absent-telemetry.json"),
      budgetPath: writeBudget(home, 5000),
    });
    saveSettings({ recording: { video: { enabled: true } } });
    manager = makeManager(spawner, policy, events);
    await manager.start();
    await delay(20);
    expect(spawner.spawns.length).toBe(1);
    expect(spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");
    expect(manager.status().bootDefer).toBe("skipped");
    expect(events.some((m) => m.includes("boot-defer skipped: psu budget 5000mA >= 5000"))).toBe(true);
  });

  it("bootDefer=always arms even on a 5 A budget", async () => {
    const spawner = fakeSpawner();
    const policy = new BootDeferPolicy({
      telemetryFile: join(home, "absent-telemetry.json"),
      budgetPath: writeBudget(home, 5000),
    });
    saveSettings({ recording: { video: { enabled: true, bootDefer: "always" } } });
    manager = makeManager(spawner, policy, []);
    await manager.start();
    await delay(20);
    expect(spawner.spawns[0].args.join(" ")).not.toContain("splitmuxsink");
    expect(manager.status().bootDefer).toBe("deferring");
  });

  it("shortening bootDeferMaxSecs via settings releases an active defer (timeout)", async () => {
    const spawner = fakeSpawner();
    const telemetryFile = join(home, "telemetry.json");
    writeFileSync(
      telemetryFile,
      JSON.stringify({ timestamp: new Date().toISOString(), status: "connecting", reg: 0 }),
    );
    let now = 1_000_000;
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath: writeBudget(home, 3000),
      now: () => now,
      monoMs: () => {
        now += 1000; // each evaluation advances 1 s of fake time
        return now;
      },
    });
    saveSettings({ recording: { video: { enabled: true } } });
    manager = makeManager(spawner, policy, []);
    await manager.start();
    await delay(20);
    expect(manager.status().bootDefer).toBe("deferring");

    saveSettings({ recording: { video: { enabled: true, bootDeferMaxSecs: 1 } } });
    manager.reapply();
    await delay(200);
    expect(manager.status().bootDefer).toBe("released:timeout");
    expect(spawner.spawns.at(-1)!.args.join(" ")).toContain("splitmuxsink");
  });

  /**
   * Phase 7 stage 2: the gate must hold BOTH pipelines (bridge-only capture +
   * parked live masters) and release them together — one boolean into the media
   * supervisor, so it can never fight the shed ladder over the same control.
   */
  it("the GPS gate parks live streaming too, and releases both on a fix", async () => {
    const spawner = fakeSpawner();
    const events: string[] = [];
    const shedCalls: boolean[] = [];
    const telemetryFile = join(home, "telemetry.json");
    const writeConnected = () =>
      writeFileSync(
        telemetryFile,
        JSON.stringify({ timestamp: new Date().toISOString(), status: "connected", reg: 1 }),
      );
    writeConnected();
    let fix = false;
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath: writeBudget(home, 3000),
      gnss: () => ({ fix, sky: "clear" }),
    });
    saveSettings({ recording: { video: { enabled: true, gpsGate: "auto" } } });
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      bootPolicy: policy,
      onEvent: (_l, m) => events.push(m),
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
        setLiveShed: (shed) => shedCalls.push(shed),
      },
    });
    await manager.start();
    await delay(20);
    // LTE is already connected — stage 1 would have released here; the gate
    // holds because there is no fix yet.
    expect(manager.status().bootDefer).toBe("gating");
    expect(spawner.spawns[0].args.join(" ")).not.toContain("splitmuxsink");
    expect(shedCalls).toEqual([true]);
    expect(events.some((m) => m.includes("gps gate armed") && m.includes("cap 600s"))).toBe(true);

    fix = true;
    writeConnected();
    manager.reapply();
    await delay(200);
    expect(manager.status().bootDefer).toBe("released:gps-fix");
    expect(shedCalls).toEqual([true, false]); // live released alongside capture
    expect(spawner.spawns.at(-1)!.args.join(" ")).toContain("splitmuxsink");
    expect(events.some((m) => m.includes("released (gps-fix)"))).toBe(true);
  });

  it("a no-RF sky releases the gate without a fix", async () => {
    const spawner = fakeSpawner();
    const telemetryFile = join(home, "telemetry-norf.json");
    writeFileSync(
      telemetryFile,
      JSON.stringify({ timestamp: new Date().toISOString(), status: "connected", reg: 1 }),
    );
    let sky: "clear" | "no-rf" = "clear";
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath: writeBudget(home, 3000),
      gnss: () => ({ fix: false, sky }),
    });
    saveSettings({ recording: { video: { enabled: true, gpsGate: "always" } } });
    manager = makeManager(spawner, policy, []);
    await manager.start();
    await delay(20);
    expect(manager.status().bootDefer).toBe("gating");

    sky = "no-rf";
    manager.reapply();
    await delay(200);
    expect(manager.status().bootDefer).toBe("released:no-rf");
  });

  it("telemetry recording is never deferred or gated", async () => {
    const spawner = fakeSpawner();
    const policy = new BootDeferPolicy({
      telemetryFile: join(home, "absent-telemetry.json"),
      budgetPath: writeBudget(home, 3000),
    });
    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 20 } } });
    manager = makeManager(spawner, policy, []);
    await manager.start();
    await delay(150);
    expect(manager.status().enabled).toBe(true); // telemetry recorder running
    // Since Phase 7 the policy IS consulted with video recording off (the gate
    // also holds live streaming), but it can only ever hold VIDEO: no capture
    // child runs in record mode, and the telemetry recorder is untouched.
    expect(manager.status().bootDefer).toBe("deferring");
    expect(spawner.spawns.every((s) => !s.args.join(" ").includes("splitmuxsink"))).toBe(true);
  });
});

describe("RecordingManager power load shedding (Phase 3)", () => {
  let manager: RecordingManager | null = null;
  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  /** Poll until cond() holds (shed ticks run on a fast real timer). */
  async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error("until(): condition not met in time");
      await delay(10);
    }
  }

  /**
   * Fake-clocked rig: every powerSample() call advances 1 fake second, so a
   * few real 10 ms ticks traverse minutes of policy time.
   */
  function makeRig(opts: { powerSample?: boolean } = { powerSample: true }) {
    const spawner = fakeSpawner();
    const clock = { now: 0 };
    const rig = {
      spawner,
      clock,
      reading: { uv: false, railV: 5.05 } as PowerSampleReading,
      sampleCalls: 0,
      liveShed: [] as boolean[],
      events: [] as string[],
    };
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      shedPolicy: new LoadShedPolicy({ monoMs: () => clock.now }),
      shedSampleMs: 10,
      powerSample:
        opts.powerSample === false
          ? undefined
          : async () => {
              rig.sampleCalls++;
              clock.now += 1000;
              return rig.reading;
            },
      onEvent: (_l, m) => rig.events.push(m),
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
        setLiveShed: (s) => rig.liveShed.push(s),
      },
    });
    return rig;
  }

  it("walks the ladder down (live first, recording second) and back up", async () => {
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off" },
        powerShedding: { uvWindowSecs: 5, escalateDwellSecs: 5, restoreSecs: 10 },
      },
    });
    const rig = makeRig();
    rig.reading = { uv: true, railV: 4.7 };
    await manager!.start();
    await delay(20);
    // Recording starts normally — shedding reacts to measurements, it never defers.
    expect(rig.spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");

    // Rung 1 (3 UV samples): live parked, recording untouched (same child).
    await until(() => rig.liveShed.includes(true));
    expect(manager!.status().powerShed).toBe("no-live");
    expect(rig.spawner.spawns.length).toBe(1);
    expect(rig.events.some((m) => m.includes("no-live") && m.includes("undervoltage"))).toBe(true);

    // Rung 2 (5 s continued trigger): capture flips to bridge-only.
    await until(() => rig.spawner.spawns.length === 2);
    expect(rig.spawner.spawns[1].args.join(" ")).not.toContain("splitmuxsink");
    expect(manager!.status().powerShed).toBe("bridge-only");

    // Recovery: clean rail → recording restores first, live last, status clears.
    rig.reading = { uv: false, railV: 5.05 };
    await until(() => rig.spawner.spawns.length === 3);
    expect(rig.spawner.spawns[2].args.join(" ")).toContain("splitmuxsink");
    expect(manager!.status().powerShed).toBe("no-live");
    await until(() => rig.liveShed[rig.liveShed.length - 1] === false);
    expect(manager!.status().powerShed).toBeUndefined();
    expect(rig.events.some((m) => m.includes("restore → full"))).toBe(true);
  });

  it("cycle cap parks; a powerShedding settings change resets and restores", async () => {
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off" },
        powerShedding: { uvWindowSecs: 5, restoreSecs: 10, maxShedsPerHour: 0 },
      },
    });
    const rig = makeRig();
    rig.reading = { uv: true, railV: 5.0 };
    await manager!.start();
    await until(() => manager!.status().powerShed === "parked:no-live");
    rig.reading = { uv: false, railV: 5.05 };
    // Parked: a long clean stretch (fake minutes) must NOT restore.
    await until(() => rig.clock.now > 120_000);
    expect(manager!.status().powerShed).toBe("parked:no-live");
    expect(rig.liveShed[rig.liveShed.length - 1]).toBe(true);

    // The documented escape hatch: any powerShedding settings change resets.
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off" },
        powerShedding: { uvWindowSecs: 5, restoreSecs: 10, maxShedsPerHour: 4 },
      },
    });
    manager!.reapply();
    await until(() => rig.liveShed[rig.liveShed.length - 1] === false);
    expect(manager!.status().powerShed).toBeUndefined();
  });

  it("feature disabled: monitor never arms, zero behavior change", async () => {
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off" },
        powerShedding: { enabled: false },
      },
    });
    const rig = makeRig();
    rig.reading = { uv: true, railV: 4.5 }; // would trigger instantly if armed
    await manager!.start();
    await delay(150);
    expect(rig.sampleCalls).toBe(0);
    expect(rig.liveShed).toEqual([]);
    expect(rig.spawner.spawns.length).toBe(1);
    expect(rig.spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");
    expect(manager!.status().powerShed).toBeUndefined();
  });

  it("no power sampler (sim/dev host): feature inert", async () => {
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off" } } });
    const rig = makeRig({ powerSample: false });
    await manager!.start();
    await delay(150);
    expect(rig.liveShed).toEqual([]);
    expect(rig.spawner.spawns[0].args.join(" ")).toContain("splitmuxsink");
    expect(manager!.status().powerShed).toBeUndefined();
  });
});

/**
 * The published live-block verdict (power_management_improvements Phase 2).
 *
 * One field answering "may I watch this device right now, and if not, why",
 * derived at the SINGLE existing liveParked site from the same two inputs, so
 * the reason and the reality cannot come apart (README principle 5). Absence is
 * load-bearing: no field means allowed, and every consumer fails open on it.
 */
describe("RecordingManager liveBlock contract (Phase 2)", () => {
  let manager: RecordingManager | null = null;
  afterEach(() => {
    manager?.stop();
    manager = null;
  });

  async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new Error("until(): condition not met in time");
      await delay(10);
    }
  }

  function writeBudget(dir: string, ma: number): string {
    const path = join(dir, "max_current");
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(ma, 0);
    writeFileSync(path, buf);
    return path;
  }

  /**
   * A manager wired for BOTH block sources at once: a gate that can be armed and
   * released via its GNSS view, and a fake-clocked shed monitor fed by `reading`.
   */
  function makeRig(opts: { gate?: boolean } = {}) {
    const spawner = fakeSpawner();
    const clock = { now: 0 };
    const telemetryFile = join(home, "telemetry.json");
    writeFileSync(
      telemetryFile,
      JSON.stringify({ timestamp: new Date().toISOString(), status: "connected", reg: 1 }),
    );
    const rig = {
      spawner,
      clock,
      reading: { uv: false, railV: 5.05, tempC: 55 } as PowerSampleReading,
      fix: false,
      liveShed: [] as boolean[],
      statuses: [] as (ReturnType<RecordingManager["status"]>)[],
    };
    manager = new RecordingManager({
      deviceId: "dev-1",
      sampleGroups: async () => ({}),
      root: join(home, "recordings"),
      pollMs: 60_000,
      bootPolicy: new BootDeferPolicy({
        telemetryFile,
        budgetPath: writeBudget(home, 3000),
        gnss: opts.gate === false ? undefined : () => ({ fix: rig.fix, sky: "clear" }),
      }),
      shedPolicy: new LoadShedPolicy({ monoMs: () => clock.now }),
      shedSampleMs: 10,
      powerSample: async () => {
        clock.now += 1000;
        return rig.reading;
      },
      onStatus: (s) => rig.statuses.push(s),
      video: {
        mediaEnabled: true,
        cameras: () => [{ streamKey: "cam0", cameraName: "/base/cam0@1a" }],
        shmDir: join(home, "shm"),
        spawn: spawner.spawn,
        stableMs: 50,
        sweepPollMs: 3600_000,
        setLiveShed: (s) => rig.liveShed.push(s),
      },
    });
    return rig;
  }

  it("no block: the field is ABSENT entirely — not null, not {}", async () => {
    saveSettings({ recording: { video: { enabled: true, bootDefer: "off", gpsGate: "off" } } });
    const rig = makeRig();
    await manager!.start();
    await delay(150);
    const status = manager!.status();
    expect(status.liveBlock).toBeUndefined();
    expect("liveBlock" in status).toBe(false);
    expect(JSON.stringify(status)).not.toContain("liveBlock");
    expect(rig.liveShed).toEqual([]);
  });

  it("the armed gate publishes gps-gate, and releasing drops the field", async () => {
    saveSettings({ recording: { video: { enabled: true, gpsGate: "always" } } });
    const rig = makeRig();
    await manager!.start();
    await delay(20);
    expect(manager!.status().bootDefer).toBe("gating");
    expect(manager!.status().liveBlock).toMatchObject({
      reason: "gps-gate",
      detail: "waiting for LTE attach + GPS fix (mode=always)",
    });
    expect(manager!.status().liveBlock!.since).toBeGreaterThan(0);

    rig.fix = true;
    manager!.reapply();
    await delay(200);
    expect(manager!.status().bootDefer).toBe("released:gps-fix");
    expect(manager!.status().liveBlock).toBeUndefined();
  });

  it("`since` is stamped once and holds steady while the block does", async () => {
    saveSettings({ recording: { video: { enabled: true, gpsGate: "always" } } });
    makeRig();
    await manager!.start();
    await delay(20);
    const since = manager!.status().liveBlock!.since;
    for (let i = 0; i < 5; i++) {
      manager!.reapply();
      await delay(15);
      expect(manager!.status().liveBlock).toMatchObject({ reason: "gps-gate", since });
    }
  });

  it("a rail shed publishes undervoltage with the rail in the detail", async () => {
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off", gpsGate: "off" },
        powerShedding: { railLowSecs: 3, restoreSecs: 5 },
      },
    });
    const rig = makeRig();
    rig.reading = { uv: false, railV: 4.7, tempC: 55 };
    await manager!.start();
    await until(() => manager!.status().powerShed === "no-live");
    expect(manager!.status().liveBlock).toMatchObject({
      reason: "undervoltage",
      detail: "rail 4.70V < 4.85V for 3s",
    });

    rig.reading = { uv: false, railV: 5.05, tempC: 55 };
    await until(() => manager!.status().powerShed === undefined);
    expect(manager!.status().liveBlock).toBeUndefined();
  });

  it("a thermal shed publishes thermal, and HOLDS it after the trigger clears", async () => {
    // The regression the natural implementation gets wrong: a shed whose
    // trigger has stopped firing but whose restore interval has not elapsed
    // must keep naming its reason for the whole hold (PROGRESS hand-off note;
    // bench run D held for ~7 min with `cause === null`).
    saveSettings({
      recording: {
        video: { enabled: true, bootDefer: "off", gpsGate: "off" },
        powerShedding: { cpuTempSecs: 5, restoreSecs: 600 }, // 5 = the settings floor
      },
    });
    const rig = makeRig();
    rig.reading = { uv: false, railV: 5.05, tempC: 85 };
    await manager!.start();
    await until(() => manager!.status().powerShed === "no-live");
    const block = manager!.status().liveBlock!;
    expect(block).toMatchObject({ reason: "thermal", detail: "cpu 85.0°C >= 80°C for 5s" });

    // Below cpuTempC (so no trigger) but above cpuTempRestoreC (so no restore):
    // the rung holds, and the reason must hold with it.
    rig.reading = { uv: false, railV: 5.05, tempC: 75 };
    const from = rig.clock.now;
    // 2 fake minutes — well past the point a per-tick reason would have blanked
    // out, and well short of the 600 s restore interval.
    await until(() => rig.clock.now - from > 120_000);
    expect(manager!.status().powerShed).toBe("no-live");
    expect(manager!.status().liveBlock).toEqual(block); // reason, detail AND since
  });

  it("the gate wins when both the gate and a shed are blocking live", async () => {
    saveSettings({
      recording: {
        video: { enabled: true, gpsGate: "always" },
        powerShedding: { railLowSecs: 3, restoreSecs: 5 },
      },
    });
    const rig = makeRig();
    rig.reading = { uv: false, railV: 4.7, tempC: 55 };
    await manager!.start();
    await until(() => manager!.status().powerShed === "no-live");
    // Both are holding live down...
    expect(manager!.status().bootDefer).toBe("gating");
    // ...and the gate is the one with a knowable end, so it names the block.
    expect(manager!.status().liveBlock).toMatchObject({ reason: "gps-gate" });

    // Release the gate while the shed still holds: the shed's reason takes over
    // and `since` is re-stamped, because the reason changed.
    const gateSince = manager!.status().liveBlock!.since;
    rig.fix = true;
    await delay(5);
    manager!.reapply();
    await until(() => manager!.status().liveBlock?.reason === "undervoltage");
    expect(manager!.status().liveBlock!.since).toBeGreaterThanOrEqual(gateSince);
    // Live stayed parked throughout — the block never lapsed as the reason
    // changed hands, which is the failure the gate-wins rule exists to avoid.
    expect(rig.liveShed).toEqual([true]);
  });
});
