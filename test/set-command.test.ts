import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCommand } from "../src/commands/set.js";
import { loadSettings, saveSettings } from "../src/daemon/settings.js";
import { cleanup, tempHome } from "./helpers.js";

/**
 * `xorgate set` paths that neither restart the daemon nor touch the OS:
 * `recording.*` is applied live by the recording manager's 5 s settings poll,
 * so the command is pure "validate + merge into settings.json".
 */
let home: string;
beforeEach(() => {
  home = tempHome();
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  cleanup(home);
});

describe("xorgate set recording.powerShedding.*", () => {
  it("accepts the thermal trio (cloud-settable but CLI-invisible until Phase 4)", async () => {
    for (const [field, value] of [
      ["cpuTempC", "82"],
      ["cpuTempRestoreC", "73"],
      ["cpuTempSecs", "20"],
    ] as const) {
      await setCommand([`recording.powerShedding.${field}`, value]);
      expect(process.exitCode).toBeUndefined();
    }
    expect(loadSettings().recording?.powerShedding).toEqual({
      cpuTempC: 82,
      cpuTempRestoreC: 73,
      cpuTempSecs: 20,
    });
  });

  it("clamps through the same validator loadSettings uses", async () => {
    await setCommand(["recording.powerShedding.cpuTempC", "999"]);
    expect(loadSettings().recording?.powerShedding?.cpuTempC).toBe(90);
  });

  it("merges rather than replacing the namespace", async () => {
    saveSettings({ recording: { powerShedding: { enabled: true } } });
    await setCommand(["recording.powerShedding.cpuTempSecs", "15"]);
    expect(loadSettings().recording?.powerShedding).toEqual({
      enabled: true,
      cpuTempSecs: 15,
    });
  });
});

describe("the retired `media` setting", () => {
  it("fails with a pointer to per-camera enables instead of writing anything", async () => {
    await setCommand(["media", "off"]);
    expect(process.exitCode).toBe(1);
    expect(loadSettings()).toEqual({});
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toMatch(
      /recording\.video\.cameras/,
    );
  });
});
