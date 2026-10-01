import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import {
  claimCommand,
  executeCommand,
  isExpired,
  ledgerPath,
  parseCommand,
  MAX_TTL_MS,
  type DeviceCommandName,
} from "../src/agent/commands.js";
import type { RunResult } from "../src/lib/exec.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const T0 = 1750000000000;
const msg = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    requestId: "req-1",
    command: "reboot",
    ts: T0,
    expiresAt: T0 + 60_000,
    ...over,
  });

describe("parseCommand", () => {
  it("parses both v1 commands", () => {
    expect(parseCommand(Buffer.from(msg()))).toEqual({
      requestId: "req-1",
      command: "reboot",
      ts: T0,
      expiresAt: T0 + 60_000,
    });
    expect(parseCommand(msg({ command: "power_off" }))?.command).toBe("power_off");
    expect(parseCommand(msg({ command: "refresh" }))?.command).toBe("refresh");
    expect(parseCommand(msg({ command: "update" }))?.command).toBe("update");
  });

  it("rejects malformed payloads and wrong versions", () => {
    expect(parseCommand("not json")).toBeNull();
    expect(parseCommand("42")).toBeNull();
    expect(parseCommand(JSON.stringify(null))).toBeNull();
    expect(parseCommand(msg({ v: 2 }))).toBeNull();
    expect(parseCommand(JSON.stringify({ requestId: "r", command: "reboot" }))).toBeNull();
  });

  it("rejects unknown or non-string commands", () => {
    expect(parseCommand(msg({ command: "rm -rf /" }))).toBeNull();
    expect(parseCommand(msg({ command: "restart" }))).toBeNull();
    expect(parseCommand(msg({ command: 7 }))).toBeNull();
  });

  it("rejects a missing/blank requestId — it is the replay key", () => {
    expect(parseCommand(msg({ requestId: "" }))).toBeNull();
    expect(parseCommand(msg({ requestId: undefined }))).toBeNull();
    expect(parseCommand(msg({ requestId: 42 }))).toBeNull();
  });

  it("rejects a command with no usable timestamps", () => {
    expect(parseCommand(msg({ ts: undefined }))).toBeNull();
    expect(parseCommand(msg({ expiresAt: undefined }))).toBeNull();
    expect(parseCommand(msg({ ts: "now" }))).toBeNull();
    expect(parseCommand(msg({ expiresAt: Number.NaN }))).toBeNull();
    expect(parseCommand(msg({ expiresAt: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it("clamps an over-long TTL to the device's own ceiling", () => {
    // A publisher asking for a 24h window must not get one.
    const far = parseCommand(msg({ expiresAt: T0 + 86_400_000 }));
    expect(far?.expiresAt).toBe(T0 + MAX_TTL_MS);
    // A shorter cloud-side TTL is honoured as-is.
    expect(parseCommand(msg({ expiresAt: T0 + 5_000 }))?.expiresAt).toBe(T0 + 5_000);
  });
});

describe("isExpired", () => {
  const cmd = parseCommand(msg())!;

  it("accepts a fresh command and refuses a stale one", () => {
    expect(isExpired(cmd, T0)).toBe(false);
    expect(isExpired(cmd, T0 + 59_000)).toBe(false);
    expect(isExpired(cmd, T0 + 61_000)).toBe(true);
  });

  it("refuses a command that outlived the clamped ceiling", () => {
    const forever = parseCommand(msg({ expiresAt: T0 + 86_400_000 }))!;
    expect(isExpired(forever, T0 + MAX_TTL_MS + 1)).toBe(true);
  });
});

describe("claimCommand", () => {
  it("claims once and refuses the redelivery", () => {
    expect(claimCommand("req-1", T0)).toBe(true);
    expect(claimCommand("req-1", T0 + 1000)).toBe(false);
    expect(claimCommand("req-2", T0 + 1000)).toBe(true);
  });

  it("persists across a restart — the ledger outlives the reboot it guards", () => {
    expect(claimCommand("req-1", T0)).toBe(true);
    // Nothing cached in-process: a fresh read of the file must still refuse it.
    expect(claimCommand("req-1", T0 + 90_000, ledgerPath())).toBe(false);
  });

  it("survives a corrupt ledger (treated as empty)", () => {
    writeFileSync(ledgerPath(), "not json");
    expect(claimCommand("req-1", T0)).toBe(true);
    expect(claimCommand("req-1", T0)).toBe(false);
  });

  it("prunes entries older than the retention window", () => {
    claimCommand("old", T0);
    claimCommand("new", T0 + 3_600_001);
    // `old` aged out, so its id is free again; `new` is still held.
    expect(claimCommand("old", T0 + 3_600_002)).toBe(true);
    expect(claimCommand("new", T0 + 3_600_002)).toBe(false);
  });

  it("caps the ledger so a command flood cannot grow it without bound", () => {
    for (let i = 0; i < 150; i++) claimCommand(`req-${i}`, T0 + i);
    const entries = (JSON.parse(readFileSync(ledgerPath(), "utf8")) as { executed: unknown[] })
      .executed;
    expect(entries.length).toBe(100);
    // The most recent claims are the ones retained.
    expect(claimCommand("req-149", T0 + 200)).toBe(false);
  });
});

describe("executeCommand", () => {
  const okResult: RunResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    failed: false,
    notFound: false,
  };

  it("maps each command to a non-interactive systemctl call", async () => {
    const calls: Array<[string, string[]]> = [];
    const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, args]);
      return okResult;
    };
    await executeCommand("reboot", runner);
    await executeCommand("power_off", runner);
    expect(calls).toEqual([
      ["sudo", ["-n", "systemctl", "reboot"]],
      ["sudo", ["-n", "systemctl", "poweroff"]],
    ]);
  });

  it("starts the updater unit with the EXACT argv the sudoers grant allows", async () => {
    // /etc/sudoers.d/022_xorgate-update grants exactly
    //   <user> ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block xorgate-updater.service
    // — an exact-args match. Any drift here (a reordered flag, a --tag, a
    // different unit name) is refused by sudo at runtime, so pin it.
    // `--no-block` is not decoration either: without it the blocking start
    // would wait for a oneshot that finishes by restarting this very agent.
    const calls: Array<[string, string[]]> = [];
    const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, args]);
      return okResult;
    };
    await executeCommand("update", runner);
    expect(calls).toEqual([
      ["sudo", ["-n", "systemctl", "start", "--no-block", "xorgate-updater.service"]],
    ]);
  });

  it("surfaces a refused sudo rather than throwing", async () => {
    const runner = async (): Promise<RunResult> => ({
      stdout: "",
      stderr: "sudo: a password is required",
      exitCode: 1,
      failed: true,
      notFound: false,
    });
    const res = await executeCommand("reboot" as DeviceCommandName, runner);
    expect(res.failed).toBe(true);
    expect(res.stderr).toContain("password is required");
  });
});

describe("replay container exit codes (device-simulator Phase 2)", async () => {
  const { containerExitCode, REPLAY_EXIT_CODES } = await import("../src/agent/commands.js");
  it("reboot restarts (0), power_off parks (3) — the host reads these", () => {
    expect(containerExitCode("reboot")).toBe(0);
    expect(containerExitCode("power_off")).toBe(3);
    expect(REPLAY_EXIT_CODES).toEqual({ reboot: 0, power_off: 3 });
  });
});
