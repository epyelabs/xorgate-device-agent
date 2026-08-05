import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import {
  loadSettings,
  parseRecordingSettings,
  saveSettings,
  settingsPath,
} from "../src/daemon/settings.js";
import { RECORDING_DEFAULTS, resolveRecordingConfig } from "../src/recording/config.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

describe("parseRecordingSettings", () => {
  it("accepts a full valid shape", () => {
    const s = parseRecordingSettings({
      telemetry: { enabled: true, rateHz: 10 },
      video: { enabled: false, preset: "1080p15-2mbps", segmentSeconds: 60 },
      upload: { mode: "off" },
      retention: { maxBytes: 5_000_000, minFreeBytes: 1_000_000 },
    });
    expect(s).toEqual({
      telemetry: { enabled: true, rateHz: 10 },
      video: { enabled: false, preset: "1080p15-2mbps", segmentSeconds: 60 },
      upload: { mode: "off" },
      retention: { maxBytes: 5_000_000, minFreeBytes: 1_000_000 },
    });
  });

  it("clamps rateHz into [1, 20]", () => {
    expect(parseRecordingSettings({ telemetry: { rateHz: 50 } })).toEqual({
      telemetry: { rateHz: 20 },
    });
    expect(parseRecordingSettings({ telemetry: { rateHz: 0.2 } })).toEqual({
      telemetry: { rateHz: 1 },
    });
    expect(parseRecordingSettings({ telemetry: { rateHz: 7.6 } })).toEqual({
      telemetry: { rateHz: 8 },
    });
  });

  it("accepts and clamps the Phase 2 boot staging knobs", () => {
    expect(
      parseRecordingSettings({
        video: {
          bootDefer: "always",
          bootDeferMaxSecs: 120,
          bootDeferMinBudgetMa: 4000,
          spawnStaggerSecs: 5,
        },
      }),
    ).toEqual({
      video: {
        bootDefer: "always",
        bootDeferMaxSecs: 120,
        bootDeferMinBudgetMa: 4000,
        spawnStaggerSecs: 5,
      },
    });
    // 0 is meaningful (feature off / no stagger) and must survive parsing.
    expect(parseRecordingSettings({ video: { bootDeferMaxSecs: 0, spawnStaggerSecs: 0 } })).toEqual(
      { video: { bootDeferMaxSecs: 0, spawnStaggerSecs: 0 } },
    );
    // Clamps + enum rejection.
    expect(
      parseRecordingSettings({
        video: {
          bootDefer: "sometimes",
          bootDeferMaxSecs: 10_000,
          bootDeferMinBudgetMa: 99_999,
          spawnStaggerSecs: 300,
        },
      }),
    ).toEqual({
      video: { bootDeferMaxSecs: 600, bootDeferMinBudgetMa: 10_000, spawnStaggerSecs: 30 },
    });
  });

  it("accepts and clamps the Phase 7 GPS gate knobs", () => {
    expect(parseRecordingSettings({ video: { gpsGate: "always", gpsGateMaxSecs: 900 } })).toEqual({
      video: { gpsGate: "always", gpsGateMaxSecs: 900 },
    });
    // 0 = "no time cap" (Q8) — it must survive parsing, not be dropped.
    expect(parseRecordingSettings({ video: { gpsGateMaxSecs: 0 } })).toEqual({
      video: { gpsGateMaxSecs: 0 },
    });
    expect(
      parseRecordingSettings({ video: { gpsGate: "maybe", gpsGateMaxSecs: 99_999 } }),
    ).toEqual({ video: { gpsGateMaxSecs: 3600 } });
    expect(parseRecordingSettings({ video: { gpsGateMaxSecs: -5 } })).toEqual({
      video: { gpsGateMaxSecs: 0 },
    });
    // Phase 10 iter 2: the no-progress escape hatch clamps the same way, and 0
    // (= off, cap-only behavior) must survive parsing rather than be dropped.
    expect(parseRecordingSettings({ video: { gpsGateNoProgressSecs: 180 } })).toEqual({
      video: { gpsGateNoProgressSecs: 180 },
    });
    expect(parseRecordingSettings({ video: { gpsGateNoProgressSecs: 0 } })).toEqual({
      video: { gpsGateNoProgressSecs: 0 },
    });
    expect(parseRecordingSettings({ video: { gpsGateNoProgressSecs: 99_999 } })).toEqual({
      video: { gpsGateNoProgressSecs: 3600 },
    });
  });

  it("resolves boot staging defaults (auto / 90 s / 5000 mA / 4 s stagger / gate auto 600 s)", () => {
    const cfg = resolveRecordingConfig(undefined);
    expect(cfg.video).toMatchObject({
      bootDefer: "auto",
      bootDeferMaxSecs: 90,
      bootDeferMinBudgetMa: 5000,
      spawnStaggerSecs: 4,
      gpsGate: "auto",
      gpsGateMaxSecs: 600,
    });
    expect(RECORDING_DEFAULTS.video.bootDefer).toBe("auto");
  });

  it("accepts and clamps the Phase 3 powerShedding knobs", () => {
    const full = {
      enabled: true,
      uvSamples: 3,
      uvWindowSecs: 30,
      railLowVolts: 4.85,
      railLowSecs: 15,
      escalateDwellSecs: 60,
      escalateDutyPct: 70,
      restoreSecs: 120,
      railRestoreVolts: 4.95,
      maxShedsPerHour: 4,
    };
    expect(parseRecordingSettings({ powerShedding: full })).toEqual({ powerShedding: full });
    // Clamps: integers round + clamp, voltages clamp without rounding.
    expect(
      parseRecordingSettings({
        powerShedding: {
          uvSamples: 0,
          uvWindowSecs: 9999,
          railLowVolts: 6,
          railLowSecs: 1,
          escalateDwellSecs: 0,
          restoreSecs: 100_000,
          railRestoreVolts: 3,
          maxShedsPerHour: -5,
        },
      }),
    ).toEqual({
      powerShedding: {
        uvSamples: 1,
        uvWindowSecs: 300,
        railLowVolts: 5.2,
        railLowSecs: 3,
        escalateDwellSecs: 5,
        restoreSecs: 3600,
        railRestoreVolts: 4.0,
        maxShedsPerHour: 0,
      },
    });
    // Mistyped leaves drop; valid siblings survive; enabled=false persists.
    expect(
      parseRecordingSettings({ powerShedding: { enabled: false, uvSamples: "three" } }),
    ).toEqual({ powerShedding: { enabled: false } });
  });

  it("accepts and clamps the thermal-arm thresholds (Phase 1)", () => {
    // Temperatures keep their decimals, like the rail voltages; the window is
    // an integer second count.
    expect(
      parseRecordingSettings({
        powerShedding: { cpuTempC: 72.5, cpuTempRestoreC: 64.5, cpuTempSecs: 20 },
      }),
    ).toEqual({ powerShedding: { cpuTempC: 72.5, cpuTempRestoreC: 64.5, cpuTempSecs: 20 } });
    // Out of range clamps rather than disabling protection (device posture).
    expect(
      parseRecordingSettings({
        powerShedding: { cpuTempC: 200, cpuTempRestoreC: 0, cpuTempSecs: 9999 },
      }),
    ).toEqual({ powerShedding: { cpuTempC: 90, cpuTempRestoreC: 40, cpuTempSecs: 120 } });
    expect(parseRecordingSettings({ powerShedding: { cpuTempC: "hot" } })).toBeUndefined();
  });

  it("resolves powerShedding defaults (on, Q4 starting thresholds)", () => {
    const cfg = resolveRecordingConfig(undefined);
    expect(cfg.powerShedding).toEqual({
      enabled: true,
      uvSamples: 3,
      uvWindowSecs: 30,
      railLowVolts: 4.85,
      railLowSecs: 15,
      escalateDwellSecs: 60,
      escalateDutyPct: 70,
      cpuTempC: 80,
      cpuTempRestoreC: 70,
      cpuTempSecs: 15,
      restoreSecs: 120,
      railRestoreVolts: 4.95,
      maxShedsPerHour: 4,
    });
    // Partial overlay keeps the rest of the defaults.
    expect(resolveRecordingConfig({ powerShedding: { railLowVolts: 4.75 } }).powerShedding).toEqual(
      { ...RECORDING_DEFAULTS.powerShedding, railLowVolts: 4.75 },
    );
  });

  it("drops mistyped leaves but keeps valid siblings", () => {
    const s = parseRecordingSettings({
      telemetry: { enabled: "yes", rateHz: 5 },
      upload: { mode: "wifi-only" },
      retention: { maxBytes: -1, minFreeBytes: 1024 },
    });
    expect(s).toEqual({
      telemetry: { rateHz: 5 },
      retention: { minFreeBytes: 1024 },
    });
  });

  it("returns undefined for junk", () => {
    expect(parseRecordingSettings(undefined)).toBeUndefined();
    expect(parseRecordingSettings("on")).toBeUndefined();
    expect(parseRecordingSettings({ bogus: true })).toBeUndefined();
    expect(parseRecordingSettings({ telemetry: { enabled: "x" } })).toBeUndefined();
  });

  it("clamps escalateDutyPct into [50, 100] (Phase 6 duty-cycle escalation)", () => {
    expect(parseRecordingSettings({ powerShedding: { escalateDutyPct: 10 } })).toEqual({
      powerShedding: { escalateDutyPct: 50 },
    });
    expect(parseRecordingSettings({ powerShedding: { escalateDutyPct: 250 } })).toEqual({
      powerShedding: { escalateDutyPct: 100 },
    });
    expect(resolveRecordingConfig(undefined).powerShedding.escalateDutyPct).toBe(70);
  });

  it("keeps per-camera enables keyed by streamKey, drops junk keys/values", () => {
    expect(
      parseRecordingSettings({
        video: { cameras: { cam0: true, cam1: false, "bad key!": true, cam2: "off" } },
      }),
    ).toEqual({ video: { cameras: { cam0: true, cam1: false } } });
    // Absent map = every detected camera enabled (today's behavior).
    expect(resolveRecordingConfig(undefined).video.cameras).toEqual({});
    expect(parseRecordingSettings({ video: { cameras: {} } })).toBeUndefined();
    expect(parseRecordingSettings({ video: { cameras: [true] } })).toBeUndefined();
  });

  it("clamps segmentSeconds into [10, 600]", () => {
    expect(parseRecordingSettings({ video: { segmentSeconds: 5 } })).toEqual({
      video: { segmentSeconds: 10 },
    });
    expect(parseRecordingSettings({ video: { segmentSeconds: 10_000 } })).toEqual({
      video: { segmentSeconds: 600 },
    });
  });
});

describe("settings round-trip with recording", () => {
  it("persists and reloads the recording namespace alongside other keys", () => {
    saveSettings({
      mode: "real",
      recording: { telemetry: { enabled: true, rateHz: 10 } },
    });
    expect(loadSettings()).toEqual({
      mode: "real",
      recording: { telemetry: { enabled: true, rateHz: 10 } },
    });
  });

  it("drops an invalid recording key without losing the rest of the file", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ mode: "real", recording: "on" }),
    );
    expect(loadSettings()).toEqual({ mode: "real" });
  });
});

describe("resolveRecordingConfig", () => {
  it("returns pure defaults when nothing is set (recording off)", () => {
    const cfg = resolveRecordingConfig(undefined);
    expect(cfg).toEqual(RECORDING_DEFAULTS);
    expect(cfg.telemetry.enabled).toBe(false);
  });

  it("overlays partial settings on defaults", () => {
    const cfg = resolveRecordingConfig({ telemetry: { enabled: true } });
    expect(cfg.telemetry).toEqual({ enabled: true, rateHz: RECORDING_DEFAULTS.telemetry.rateHz });
    expect(cfg.retention).toEqual(RECORDING_DEFAULTS.retention);
  });
});
