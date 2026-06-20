import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStartLock, inspect } from "../src/daemon/manager.js";
import {
  readLock,
  removeLock,
  tryCreateLock,
  writePidfileExclusive,
  type PidRecord,
} from "../src/daemon/pidfile.js";
import { atomicWriteJson } from "../src/lib/atomicWrite.js";
import { statePath } from "../src/daemon/runtime.js";
import type { ProcRunner } from "../src/daemon/process.js";
import type { StateSnapshot } from "../src/agent/telemetry.js";
import { cleanup, deadPid, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const now = 2_000_000_000_000;

// A ps runner reporting a process `elapsedSec` seconds old with `command`.
const psRunner =
  (elapsedSec: number, command = "node /x/worker.js"): ProcRunner =>
  async () => ({
    stdout: `${fmtEtime(elapsedSec)} ${command}\n`,
    failed: false,
    notFound: false,
  });

function fmtEtime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const rec = (over: Partial<PidRecord> = {}): PidRecord => ({
  pid: process.pid,
  startedAt: now,
  deviceId: "d",
  mode: "sim",
  rateHz: 1,
  offline: true,
  worker: "/x/worker.js",
  argv: [],
  nodeVersion: "v20",
  ...over,
});

const stateSnap = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
  v: 1,
  writtenBy: "test",
  deviceId: "d",
  mode: "sim",
  rateHz: 1,
  endpoint: "offline",
  offline: true,
  pid: process.pid,
  startedAt: now,
  lastWriteAt: now,
  connection: "connected",
  connectionSince: now,
  seq: 5,
  published: 5,
  publishErrors: 0,
  lastPublishAt: now,
  lastError: null,
  latest: null,
  recentEvents: [],
  ...over,
});

describe("inspect()", () => {
  it("reports stopped with no pidfile", async () => {
    expect((await inspect(now, psRunner(1))).kind).toBe("stopped");
  });

  it("reports running + identity verified for our own live pid", async () => {
    writePidfileExclusive(rec());
    const st = await inspect(now, psRunner(1));
    expect(st.kind).toBe("running");
    if (st.kind === "running") expect(st.identity).toBe("verified");
  });

  it("reports stale (no-process) for a dead pid", async () => {
    const pid = await deadPid();
    writePidfileExclusive(rec({ pid }));
    const st = await inspect(now, psRunner(1));
    expect(st.kind).toBe("stale");
    if (st.kind === "stale") expect(st.reason).toBe("no-process");
  });

  it("reports stale (pid-reused) when the live pid runs some other program", async () => {
    // pid is alive but its command line is not our worker → recycled pid.
    writePidfileExclusive(rec({ startedAt: now - 100_000 }));
    const st = await inspect(now, psRunner(3, "vim notes.txt"));
    expect(st.kind).toBe("stale");
    if (st.kind === "stale") expect(st.reason).toBe("pid-reused");
  });

  it("reports running but not fresh when the state file is old", async () => {
    writePidfileExclusive(rec());
    atomicWriteJson(statePath(), stateSnap({ lastWriteAt: now - 999_999 }));
    const st = await inspect(now, psRunner(1));
    expect(st.kind).toBe("running");
    if (st.kind === "running") {
      expect(st.stateFresh).toBe(false);
      expect(st.state?.seq).toBe(5);
    }
  });
});

describe("acquireStartLock", () => {
  const t = 2_000_000_000_000;

  it("grants the lock once, then refuses while a live launcher holds it", () => {
    expect(acquireStartLock(t)).toBe(true); // we (this process) now hold it
    expect(acquireStartLock(t)).toBe(false); // held by a live pid (us) within window
    removeLock();
    expect(acquireStartLock(t)).toBe(true); // released → grantable again
    removeLock();
  });

  it("steals a stale lock left by a dead launcher", async () => {
    const dead = await deadPid();
    expect(tryCreateLock({ pid: dead, at: t })).toBe(true);
    expect(readLock()?.pid).toBe(dead);
    expect(acquireStartLock(t)).toBe(true); // dead holder → stolen
    expect(readLock()?.pid).toBe(process.pid);
    removeLock();
  });

  it("steals an expired lock even from a live launcher", () => {
    expect(tryCreateLock({ pid: process.pid, at: t - 60_000 })).toBe(true); // old
    expect(acquireStartLock(t)).toBe(true); // older than LOCK_STALE_MS → stolen
    removeLock();
  });
});
