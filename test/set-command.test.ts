import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, tempHome } from "./helpers.js";

/**
 * The sudo note (settings-sync-hardening plan, phase 1, Q1 → warn and continue)
 * needs to look like "root running a CLI whose agent is somebody else". Rather
 * than requiring a root suite, stub the two filesystem facts it reads.
 */
const priv = vi.hoisted(() => ({ root: false, agentUid: null as number | null }));
vi.mock("../src/lib/privilege.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/privilege.js")>();
  return {
    ...actual,
    isRoot: () => priv.root || actual.isRoot(),
    fileOwner: (p: string) =>
      priv.agentUid === null
        ? actual.fileOwner(p)
        : { uid: priv.agentUid, gid: priv.agentUid, mode: 0o600 },
    usernameForUid: (uid: number) => (priv.agentUid === uid ? "pi" : actual.usernameForUid(uid)),
  };
});

const { setCommand } = await import("../src/commands/set.js");
const { loadSettings, saveSettings } = await import("../src/daemon/settings.js");

/**
 * `xorgate set` paths that neither restart the daemon nor touch the OS:
 * `recording.*` is applied live by the recording manager's 5 s settings poll,
 * so the command is pure "validate + merge into settings.json".
 */
let home: string;
beforeEach(() => {
  home = tempHome();
  priv.root = false;
  priv.agentUid = null;
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

describe("running `xorgate set` under sudo", () => {
  const stderr = (): string => vi.mocked(console.error).mock.calls.flat().join(" ");

  it("warns that the agent runs as somebody else, and still performs the write", async () => {
    priv.root = true;
    priv.agentUid = 1000;
    await setCommand(["gps-antenna", "passive"]);

    expect(process.exitCode).toBeUndefined();
    expect(loadSettings().gnssAntBias).toBe(false); // warn AND continue
    expect(stderr()).toMatch(/agent runs as 'pi'.*don't need sudo/);
  });

  it("says nothing when the agent runs as root too", async () => {
    priv.root = true;
    priv.agentUid = 0;
    await setCommand(["timeSync.offlineSources", "off"]);

    expect(loadSettings().timeSync?.offlineSources).toBe(false);
    expect(stderr()).not.toMatch(/sudo/);
  });

  it("says nothing for an ordinary unprivileged run", async () => {
    await setCommand(["recording.telemetry.rateHz", "5"]);

    expect(loadSettings().recording?.telemetry?.rateHz).toBe(5);
    expect(stderr()).not.toMatch(/sudo/);
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

describe("xorgate set cameraMount.<streamKey>.rotationDeg", () => {
  const stdout = (): string => vi.mocked(console.log).mock.calls.flat().join(" ");

  it("persists a rotation and merges into the camera map", async () => {
    await setCommand(["cameraMount.cam0.rotationDeg", "180"]);
    expect(loadSettings().cameraMount).toEqual({ cameras: { cam0: { rotationDeg: 180 } } });

    await setCommand(["cameraMount.cam1.rotationDeg", "0"]);
    expect(loadSettings().cameraMount).toEqual({
      cameras: { cam0: { rotationDeg: 180 }, cam1: { rotationDeg: 0 } },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("says out loud that a REBOOT is needed — the whole contract of this setting", async () => {
    await setCommand(["cameraMount.cam0.rotationDeg", "180"]);
    expect(stdout()).toMatch(/REBOOT is required/);
    expect(stdout()).toMatch(/never reboots itself/);
  });

  it("takes only 0 and 180, and only a real stream key", async () => {
    for (const args of [
      ["cameraMount.cam0.rotationDeg", "90"],
      ["cameraMount.cam0.rotationDeg", "true"],
      ["cameraMount.cam0.rotationDeg"],
      ["cameraMount.cam 0.rotationDeg", "180"],
      ["cameraMount.cam0.rotation", "180"],
      ["cameraMount.cam0", "180"],
    ]) {
      process.exitCode = undefined;
      await setCommand(args);
      expect(process.exitCode, args.join(" ")).toBe(1);
      expect(loadSettings().cameraMount, args.join(" ")).toBeUndefined();
    }
  });

  it("leaves the other namespaces alone", async () => {
    saveSettings({ gnssAntBias: true, recording: { telemetry: { rateHz: 5 } } });
    await setCommand(["cameraMount.cam0.rotationDeg", "180"]);
    const settings = loadSettings();
    expect(settings.gnssAntBias).toBe(true);
    expect(settings.recording?.telemetry?.rateHz).toBe(5);
    expect(settings.cameraMount?.cameras?.cam0?.rotationDeg).toBe(180);
  });
});
