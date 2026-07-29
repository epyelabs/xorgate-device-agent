import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecordingManager } from "../src/recording/manager.js";
import { saveSettings } from "../src/daemon/settings.js";
import type { GroupSample } from "../src/agent/collectors/index.js";
import type { TimeSource, TimeSourceTracker } from "../src/recording/session.js";
import { cleanup, delay, tempHome } from "./helpers.js";

let home: string;
let root: string;
let manager: RecordingManager | null = null;

beforeEach(() => {
  home = tempHome();
  root = join(home, "recordings");
});
afterEach(() => {
  manager?.stop();
  manager = null;
  cleanup(home);
});

let mono = 0n;
const sampleGroups = async (): Promise<Record<string, GroupSample>> => ({
  imu: { fields: { a: { value: 1 } }, updatedMono: ++mono },
});

describe("RecordingManager", () => {
  it("creates nothing when recording is disabled (disabled-by-default regression)", async () => {
    manager = new RecordingManager({ deviceId: "d", sampleGroups, root, pollMs: 60_000 });
    await manager.start();
    await delay(150);
    expect(existsSync(root)).toBe(false);
    expect(manager.status()).toMatchObject({ enabled: false, sessionId: null });
  });

  it("starts and stops the recorder live from settings changes", async () => {
    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 20 } } });
    manager = new RecordingManager({ deviceId: "d", sampleGroups, root, pollMs: 60_000 });
    await manager.start();
    await delay(300); // a few 50 ms ticks

    const st = manager.status();
    expect(st.enabled).toBe(true);
    expect(st.sessionId).not.toBeNull();
    const sessionDir = join(root, "telemetry", st.sessionId!);
    expect(readdirSync(sessionDir).some((n) => n.endsWith(".jsonl"))).toBe(true);

    // Flip off via settings.json + reapply (what the worker's poll does).
    saveSettings({ recording: { telemetry: { enabled: false } } });
    manager.reapply();
    expect(manager.status().enabled).toBe(false);
    expect(manager.status().sessionId).toBeNull();
    // Active segment was finalized into an upload-ready gz.
    expect(readdirSync(sessionDir).every((n) => n.endsWith(".jsonl.gz"))).toBe(true);
  });

  it("mints a new session when rateHz changes", async () => {
    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 20 } } });
    manager = new RecordingManager({ deviceId: "d", sampleGroups, root, pollMs: 60_000 });
    await manager.start();
    await delay(120);
    const first = manager.status().sessionId;
    expect(first).not.toBeNull();

    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 5 } } });
    manager.reapply();
    const second = manager.status().sessionId;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("stamps the first session with the PROBED time source, not the placeholder", async () => {
    // Tracker that starts at the pessimistic placeholder and only learns the
    // truth from the probe — exactly the boot shape of the badge bug.
    let value: TimeSource = "unsynced";
    const tracker: TimeSourceTracker = {
      current: () => value,
      refresh: async () => {
        await delay(20);
        value = "ntp";
        return value;
      },
    };
    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 20 } } });
    manager = new RecordingManager({
      deviceId: "d",
      sampleGroups,
      root,
      pollMs: 60_000,
      timeSource: tracker,
    });
    await manager.start();
    await delay(150); // a few ticks so the first segment opens

    const sessionDir = join(root, "telemetry", manager.status().sessionId!);
    const seg = readdirSync(sessionDir).find((n) => n.endsWith(".jsonl"))!;
    const header = JSON.parse(readFileSync(join(sessionDir, seg), "utf8").split("\n")[0]);
    expect(header.timeSource).toBe("ntp");
  });

  it("a hung probe cannot delay start beyond the bound (proceeds pessimistic)", async () => {
    const tracker: TimeSourceTracker = {
      current: () => "unsynced",
      refresh: () => new Promise<TimeSource>(() => {}), // never resolves
    };
    saveSettings({ recording: { telemetry: { enabled: true, rateHz: 20 } } });
    manager = new RecordingManager({
      deviceId: "d",
      sampleGroups,
      root,
      pollMs: 60_000,
      timeSource: tracker,
      timeProbeTimeoutMs: 50,
    });
    const t0 = Date.now();
    await manager.start();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(manager.status().enabled).toBe(true);
    await delay(120);
    const sessionDir = join(root, "telemetry", manager.status().sessionId!);
    const seg = readdirSync(sessionDir).find((n) => n.endsWith(".jsonl"))!;
    const header = JSON.parse(readFileSync(join(sessionDir, seg), "utf8").split("\n")[0]);
    expect(header.timeSource).toBe("unsynced");
  });

  it("finalizes orphans from a previous run on start, even with recording off", async () => {
    const oldDir = join(root, "telemetry", "prev-session");
    mkdirSync(oldDir, { recursive: true });
    const head = JSON.stringify({ type: "header", v: 1, sessionId: "prev-session" });
    const sample = JSON.stringify({ ts: 1, mono: 1, seq: 0, metrics: {} });
    writeFileSync(join(oldDir, "seg-1-00000.jsonl"), `${head}\n${sample}\n{"torn`);

    manager = new RecordingManager({ deviceId: "d", sampleGroups, root, pollMs: 60_000 });
    await manager.start();
    await delay(150); // let the initial disk enforce run

    expect(readdirSync(oldDir)).toEqual(["seg-1-00000.jsonl.gz"]);
    expect(manager.status()).toMatchObject({ enabled: false, backlogSegments: 1 });
  });
});
