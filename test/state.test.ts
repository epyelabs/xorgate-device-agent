import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../src/lib/atomicWrite.js";
import {
  StateStore,
  isFresh,
  readState,
  staleThresholdMs,
} from "../src/daemon/state.js";
import { statePath } from "../src/daemon/runtime.js";
import type { StateSnapshot } from "../src/agent/telemetry.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const snap = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  v: 1,
  writtenBy: "test",
  deviceId: "d",
  mode: "sim",
  rateHz: 1,
  endpoint: "offline",
  offline: true,
  pid: 1,
  startedAt: 0,
  lastWriteAt: 0,
  connection: "connected",
  connectionSince: 0,
  seq: 0,
  published: 0,
  publishErrors: 0,
  lastPublishAt: null,
  lastError: null,
  latest: null,
  recentEvents: [],
  ...over,
});

describe("freshness", () => {
  it("staleThresholdMs has a 3s floor and scales with interval", () => {
    expect(staleThresholdMs(1000)).toBe(3250); // 3*1000 + 250
    expect(staleThresholdMs(100)).toBe(3000); // floor
  });

  it("isFresh just inside / just outside the window", () => {
    const now = 1_000_000;
    expect(isFresh(snap({ lastWriteAt: now }), now, 1000)).toBe(true);
    expect(isFresh(snap({ lastWriteAt: now - 3000 }), now, 1000)).toBe(true);
    expect(isFresh(snap({ lastWriteAt: now - 5000 }), now, 1000)).toBe(false);
  });
});

describe("atomicWriteJson + readState", () => {
  it("writes valid JSON and leaves no temp files", () => {
    atomicWriteJson(statePath(), snap({ seq: 7 }));
    const back = readState();
    expect(back?.seq).toBe(7);
    const leftovers = readdirSync(home).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("readState returns null on missing, garbage, and schema-mismatch", () => {
    expect(readState()).toBeNull();
    atomicWriteJson(join(home, "state.json"), { not: "a snapshot" });
    expect(readState()).toBeNull(); // missing v:1
    // carries v:1 but is missing required reader fields (lastWriteAt, connection…)
    atomicWriteJson(statePath(), { v: 1, deviceId: "d" });
    expect(readState()).toBeNull();
  });
});

describe("StateStore throttling", () => {
  it("only flushes once per throttle window unless forced", () => {
    const store = new StateStore(snap(), statePath());
    store.flush(1000, true); // forced
    expect(readState()?.lastWriteAt).toBe(1000);

    store.recordPublish(1100);
    store.flush(1100); // within 250ms window → no write
    expect(readState()?.lastWriteAt).toBe(1000);

    store.flush(1300); // window elapsed → writes
    expect(readState()?.lastWriteAt).toBe(1300);
  });

  it("trims the event ring buffer", () => {
    const store = new StateStore(snap(), statePath());
    for (let i = 0; i < 30; i++) store.event("info", `e${i}`, i);
    store.flush(10_000, true);
    const back = readState();
    expect(back?.recentEvents.length).toBe(20);
    expect(back?.recentEvents[0].msg).toBe("e10"); // oldest 10 dropped
  });
});
