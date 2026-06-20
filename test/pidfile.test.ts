import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parsePidRecord,
  readPidfile,
  removePidfile,
  writePidfileExclusive,
  type PidRecord,
} from "../src/daemon/pidfile.js";
import { pidPath } from "../src/daemon/runtime.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const sample = (): PidRecord => ({
  pid: 4321,
  startedAt: 1_700_000_000_000,
  deviceId: "dev-uuid",
  mode: "sim",
  rateHz: 1,
  offline: true,
  worker: "/x/worker.js",
  argv: ["--offline"],
  nodeVersion: "v20.0.0",
});

describe("parsePidRecord", () => {
  it("parses a valid record", () => {
    const r = parsePidRecord(JSON.stringify(sample()));
    expect(r?.pid).toBe(4321);
    expect(r?.deviceId).toBe("dev-uuid");
    expect(r?.offline).toBe(true);
  });

  it("rejects a bare integer (old format)", () => {
    expect(parsePidRecord("4321")).toBeNull();
  });

  it("rejects garbage and non-positive pids", () => {
    expect(parsePidRecord("{not json")).toBeNull();
    expect(parsePidRecord(JSON.stringify({ pid: 0, startedAt: 1, deviceId: "x" }))).toBeNull();
    expect(parsePidRecord(JSON.stringify({ startedAt: 1, deviceId: "x" }))).toBeNull();
  });
});

describe("pidfile round-trip", () => {
  it("writes exclusively then reads back", () => {
    expect(writePidfileExclusive(sample())).toBe(true);
    const r = readPidfile();
    expect(r?.pid).toBe(4321);
    expect(r?.argv).toEqual(["--offline"]);
  });

  it("the O_EXCL guard rejects a second write", () => {
    expect(writePidfileExclusive(sample())).toBe(true);
    expect(writePidfileExclusive({ ...sample(), pid: 9999 })).toBe(false);
    // original is untouched
    expect(readPidfile()?.pid).toBe(4321);
  });

  it("readPidfile returns null when absent", () => {
    expect(readPidfile()).toBeNull();
  });

  it("removePidfile is idempotent", () => {
    writePidfileExclusive(sample());
    removePidfile(pidPath());
    expect(readPidfile()).toBeNull();
    expect(() => removePidfile(pidPath())).not.toThrow();
  });
});
