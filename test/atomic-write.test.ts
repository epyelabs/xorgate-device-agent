import {
  chmodSync,
  chownSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "./helpers.js";

/**
 * `atomicWriteJson` ownership preservation (settings-sync-hardening plan,
 * phase 1). A temp file created by a root process belongs to root, so before
 * this fix any root-run write turned settings.json into `root:root 0600` and
 * locked the unprivileged agent out of it.
 *
 * The suite is NOT required to run as root. Two knobs make the root-only branch
 * testable anyway: `ctl.forceRoot` makes the helper believe it is root, and
 * `ctl.chownError` injects a chown failure. Where an assertion genuinely needs
 * real root (that a chown to *another* user actually took), it is guarded by
 * `SUITE_IS_ROOT` and the test name says so.
 */
const ctl = vi.hoisted(() => ({
  forceRoot: false,
  chownError: null as Error | null,
  chownCalls: 0,
}));

vi.mock("../src/lib/privilege.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/privilege.js")>();
  return { ...actual, isRoot: () => ctl.forceRoot || actual.isRoot() };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    fchownSync: (fd: number, uid: number, gid: number) => {
      ctl.chownCalls++;
      if (ctl.chownError) throw ctl.chownError;
      return actual.fchownSync(fd, uid, gid);
    },
  };
});

const { atomicWriteJson } = await import("../src/lib/atomicWrite.js");

const SUITE_IS_ROOT = typeof process.geteuid === "function" && process.geteuid() === 0;
/** nobody:nogroup on Debian/Raspberry Pi OS — a uid we are certain isn't ours. */
const NOBODY = 65534;

let dir: string;
let target: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xg-atomic-"));
  target = join(dir, "settings.json");
  ctl.forceRoot = false;
  ctl.chownError = null;
  ctl.chownCalls = 0;
});
afterEach(() => cleanup(dir));

/** Temp files are dotfiles named `.<base>.tmp.<pid>.<n>` — none may survive. */
const leftoverTemps = (): string[] => readdirSync(dir).filter((f) => f.includes(".tmp."));

describe("atomicWriteJson — behaviour shared by every caller", () => {
  it("writes the object and leaves no temp file behind", () => {
    atomicWriteJson(target, { gnssAntBias: false, mode: "real" });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ gnssAntBias: false, mode: "real" });
    expect(leftoverTemps()).toEqual([]);
  });

  it("creates a brand-new file 0600 and does not chown it, even as root", () => {
    // Nothing to preserve on a first write — that is the installer's job, and
    // the installer sets ownership itself.
    ctl.forceRoot = true;
    atomicWriteJson(target, { v: 1 });
    expect(statSync(target).mode & 0o7777).toBe(0o600);
    expect(ctl.chownCalls).toBe(0);
  });
});

describe("atomicWriteJson — non-root callers are untouched", () => {
  it.skipIf(SUITE_IS_ROOT)(
    "makes no ownership syscall at all, and still narrows an existing file to 0600 as before (skipped when the suite runs as root)",
    () => {
      writeFileSync(target, "{}");
      chmodSync(target, 0o644);
      atomicWriteJson(target, { kept: true });

      expect(ctl.chownCalls).toBe(0);
      // Today's behaviour, deliberately unchanged: a non-root rewrite lands the
      // temp file's own 0600, it does not carry the old 0644 across.
      expect(statSync(target).mode & 0o7777).toBe(0o600);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ kept: true });
    },
  );
});

describe("atomicWriteJson — root preserves the existing target's ownership", () => {
  it("carries the target's mode across the rename (uid/gid assertion no-ops unless the suite runs as root)", () => {
    writeFileSync(target, "{}");
    chmodSync(target, 0o640);
    if (SUITE_IS_ROOT) {
      // Only real root can hand a file to somebody else; without it the chown
      // is a no-op onto our own uid and only the mode assertion has teeth.
      chownSync(target, NOBODY, NOBODY);
    }
    const before = statSync(target);

    ctl.forceRoot = true;
    atomicWriteJson(target, { gnssAntBias: false });

    const after = statSync(target);
    expect(ctl.chownCalls).toBe(1);
    expect(after.mode & 0o7777).toBe(0o640); // NOT the temp file's 0600
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ gnssAntBias: false });
    expect(leftoverTemps()).toEqual([]);
    if (SUITE_IS_ROOT) expect(after.uid).toBe(NOBODY);
  });
});

describe("atomicWriteJson — a chown failure must not fail the write", () => {
  it("still writes durably, and still leaves no temp file, when chown throws (failure is injected, so this asserts at any privilege)", () => {
    writeFileSync(target, "{}");
    chmodSync(target, 0o640);
    ctl.forceRoot = true;
    ctl.chownError = Object.assign(new Error("EPERM: operation not permitted, fchown"), {
      code: "EPERM",
    });

    expect(() => atomicWriteJson(target, { survived: true })).not.toThrow();

    expect(ctl.chownCalls).toBe(1);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ survived: true });
    expect(leftoverTemps()).toEqual([]);
    // chmod runs independently of the chown outcome, so the mode still lands.
    expect(statSync(target).mode & 0o7777).toBe(0o640);
  });
});
