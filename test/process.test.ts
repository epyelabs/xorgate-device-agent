import { describe, expect, it } from "vitest";
import {
  classifyIdentity,
  inspectProcess,
  isAlive,
  parseEtimeSeconds,
  signal,
  type ProcRunner,
} from "../src/daemon/process.js";
import type { PidRecord } from "../src/daemon/pidfile.js";
import { deadPid } from "./helpers.js";

const record = (over: Partial<PidRecord> = {}): PidRecord => ({
  pid: 1,
  startedAt: 0,
  deviceId: "d",
  mode: "sim",
  rateHz: 1,
  offline: true,
  worker: "/x/worker.js",
  argv: [],
  nodeVersion: "v20",
  ...over,
});

describe("parseEtimeSeconds", () => {
  it("parses MM:SS / HH:MM:SS / DD-HH:MM:SS (BSD + GNU)", () => {
    expect(parseEtimeSeconds("00:42")).toBe(42);
    expect(parseEtimeSeconds("   00:00")).toBe(0);
    expect(parseEtimeSeconds("01:02:03")).toBe(3723);
    expect(parseEtimeSeconds("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });
  it("returns null on junk and empty segments (Number('') === 0 trap)", () => {
    expect(parseEtimeSeconds("")).toBeNull();
    expect(parseEtimeSeconds("nope")).toBeNull();
    expect(parseEtimeSeconds("::")).toBeNull();
    expect(parseEtimeSeconds(":30")).toBeNull();
    expect(parseEtimeSeconds("-3:04:05")).toBeNull(); // empty days field
  });
});

describe("isAlive / signal", () => {
  it("reports the test process alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it("reports a reaped pid dead", async () => {
    const pid = await deadPid();
    expect(signal(pid, 0)).toBe("gone");
    expect(isAlive(pid)).toBe(false);
  });
});

describe("classifyIdentity (command-primary, age fallback)", () => {
  const now = 1_000_000;

  it("verifies when the command line references our worker, regardless of age", () => {
    const rec = record({ startedAt: now - 100_000, worker: "/x/dist/worker.js" });
    expect(
      classifyIdentity(
        rec,
        { exists: true, elapsedSec: 1, command: "node /x/dist/worker.js --offline" },
        now,
      ),
    ).toBe("verified");
  });

  it("flags reuse when the command line is some other program", () => {
    const rec = record({ startedAt: now - 5_000, worker: "/x/dist/worker.js" });
    expect(
      classifyIdentity(rec, { exists: true, elapsedSec: 9999, command: "vim notes.txt" }, now),
    ).toBe("reused");
  });

  it("falls back to the age heuristic when ps gave no command", () => {
    const rec = record({ startedAt: now - 10_000 }); // expected age 10s
    expect(classifyIdentity(rec, { exists: true, elapsedSec: 6, command: null }, now, 5)).toBe(
      "verified", // 6 + 5 >= 10
    );
    expect(classifyIdentity(rec, { exists: true, elapsedSec: 4, command: null }, now, 5)).toBe(
      "reused", // 4 + 5 < 10
    );
  });

  it("is unverified when ps gave neither command nor elapsed time", () => {
    expect(classifyIdentity(record(), { exists: true, elapsedSec: null, command: null }, now)).toBe(
      "unverified",
    );
  });

  it("treats an implausibly large age gap (clock step) as unverified, not reused", () => {
    const rec = record({ startedAt: now - 7_200_000 }); // 'recorded' 2h ago (wall clock jumped)
    // live worker only 30s old per ps, no command to corroborate → don't kill it
    expect(classifyIdentity(rec, { exists: true, elapsedSec: 30, command: null }, now, 5)).toBe(
      "unverified",
    );
  });
});

describe("inspectProcess (injected ps)", () => {
  it("parses etime + command", async () => {
    const runner: ProcRunner = async () => ({
      stdout: "   00:05 node /x/worker.js\n",
      failed: false,
      notFound: false,
    });
    const info = await inspectProcess(1234, runner);
    expect(info).toEqual({ exists: true, elapsedSec: 5, command: "node /x/worker.js" });
  });

  it("degrades to unverified when ps is missing", async () => {
    const runner: ProcRunner = async () => ({ stdout: "", failed: true, notFound: true });
    const info = await inspectProcess(1234, runner);
    expect(info.exists).toBe(false);
    expect(info.elapsedSec).toBeNull();
  });
});
