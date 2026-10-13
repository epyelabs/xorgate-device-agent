import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import {
  loadSettings,
  OBD_POLL_HZ_MAX,
  OBD_POLL_HZ_MIN,
  parseObdSettings,
  saveSettings,
  settingsPath,
} from "../src/daemon/settings.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

describe("settings persistence", () => {
  it("round-trips the run mode", () => {
    saveSettings({ mode: "real" });
    expect(loadSettings()).toEqual({ mode: "real" });
    saveSettings({ mode: "sim" });
    expect(loadSettings()).toEqual({ mode: "sim" });
  });

  // `mediaEnabled` was retired in Phase 4 of the settings-management plan. The
  // allowlist rewriter drops it like any other unknown key, which is what makes
  // the one-shot conversion in daemon/settings-migrate.ts necessary — by the
  // time loadSettings has run, the operator's choice is already gone.
  it("drops the retired mediaEnabled key", () => {
    writeFileSync(settingsPath(), JSON.stringify({ mode: "real", mediaEnabled: false }));
    expect(loadSettings()).toEqual({ mode: "real" });
  });

  it("round-trips the GNSS antenna bias alongside other keys", () => {
    saveSettings({ mode: "real", gnssAntBias: true });
    expect(loadSettings()).toEqual({ mode: "real", gnssAntBias: true });
    saveSettings({ mode: "real", gnssAntBias: false });
    expect(loadSettings()).toEqual({ mode: "real", gnssAntBias: false });
  });

  it("ignores a non-boolean gnssAntBias", () => {
    writeFileSync(settingsPath(), JSON.stringify({ mode: "real", gnssAntBias: 1 }));
    expect(loadSettings()).toEqual({ mode: "real" });
  });

  it("round-trips the lteRecovery policy namespace (loadSettings must not drop it)", () => {
    const lteRecovery = {
      gpsFixResetPolicy: "veto-deadzone" as const,
      deadZoneProfile: "aggressive" as const,
    };
    saveSettings({ mode: "real", lteRecovery });
    expect(loadSettings()).toEqual({ mode: "real", lteRecovery });
  });

  it("drops mistyped/unknown lteRecovery values but keeps the valid ones", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ lteRecovery: { gpsFixResetPolicy: "sometimes", deadZoneProfile: 3 } }),
    );
    expect(loadSettings()).toEqual({});
    writeFileSync(
      settingsPath(),
      JSON.stringify({ lteRecovery: { deadZoneProfile: "conservative", gpsFixResetPolicy: 1 } }),
    );
    expect(loadSettings()).toEqual({ lteRecovery: { deadZoneProfile: "conservative" } });
  });

  it("round-trips the timeSync namespace (loadSettings must not drop it)", () => {
    const timeSync = { offlineSources: false, stepThresholdSecs: 30, maxStepsPerBoot: 2 };
    saveSettings({ mode: "real", timeSync });
    expect(loadSettings()).toEqual({ mode: "real", timeSync });
  });

  it("clamps timeSync numbers and drops mistyped keys", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        timeSync: { offlineSources: "yes", stepThresholdSecs: 0.4, maxStepsPerBoot: 999 },
      }),
    );
    // threshold clamps up to the 2 s floor, cap clamps down to 20; the
    // mistyped boolean is dropped.
    expect(loadSettings()).toEqual({ timeSync: { stepThresholdSecs: 2, maxStepsPerBoot: 20 } });
    writeFileSync(settingsPath(), JSON.stringify({ timeSync: { offlineSources: 1 } }));
    expect(loadSettings()).toEqual({});
  });

  it("returns {} when the file is missing", () => {
    expect(loadSettings()).toEqual({});
  });

  it("returns {} on corrupt or invalid content", () => {
    writeFileSync(settingsPath(), "not json");
    expect(loadSettings()).toEqual({});
    writeFileSync(settingsPath(), JSON.stringify({ mode: "bogus" }));
    expect(loadSettings()).toEqual({});
  });
});

describe("obd namespace (obd2-bluetooth-integration P3)", () => {
  it("parses the contract shape: MAC uppercased, null kept, pin 4-6 digits, pollHz clamped, fields deduped, enum power", () => {
    expect(
      parseObdSettings({
        enabled: true,
        adapterMac: " 10:21:3e:4f:33:65 ",
        pin: "123456",
        pollHz: 0.5,
        fields: ["rpm", "speed", "rpm", "Bad Name", 7],
        powerSource: "constant",
      }),
    ).toEqual({
      enabled: true,
      adapterMac: "10:21:3E:4F:33:65",
      pin: "123456",
      pollHz: 0.5,
      fields: ["rpm", "speed"],
      powerSource: "constant",
    });
    expect(parseObdSettings({ adapterMac: null, fields: [] })).toEqual({ adapterMac: null, fields: [] });
    expect(parseObdSettings({ pollHz: 50 })).toEqual({ pollHz: OBD_POLL_HZ_MAX });
    expect(parseObdSettings({ pollHz: 0 })).toEqual({ pollHz: OBD_POLL_HZ_MIN });
  });

  it("DROPS (never repairs) a malformed MAC or PIN, and mistyped keys; nothing valid → undefined", () => {
    expect(parseObdSettings({ adapterMac: "10:21:3E:4F:33", pin: "12", powerSource: "solar", enabled: "yes" })).toBeUndefined();
    expect(parseObdSettings({ adapterMac: "10-21-3E-4F-33-65", enabled: true })).toEqual({ enabled: true });
    expect(parseObdSettings({ pin: "abcd", enabled: false })).toEqual({ enabled: false });
    expect(parseObdSettings(null)).toBeUndefined();
    expect(parseObdSettings([])).toBeUndefined();
    expect(parseObdSettings({})).toBeUndefined();
  });

  it("is kept by the allowlist rewriter alongside the other namespaces (unknown keys inside dropped)", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        mode: "real",
        obd: { enabled: true, adapterMac: "10:21:3e:4f:33:65", powerSource: "switched", bogus: 1 },
      }),
    );
    expect(loadSettings()).toEqual({
      mode: "real",
      obd: { enabled: true, adapterMac: "10:21:3E:4F:33:65", powerSource: "switched" },
    });
    saveSettings({ ...loadSettings(), gnssAntBias: true });
    expect(loadSettings().obd).toEqual({ enabled: true, adapterMac: "10:21:3E:4F:33:65", powerSource: "switched" });
  });
});
