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

  it("resolves boot staging defaults (auto / 90 s / 5000 mA / 4 s stagger)", () => {
    const cfg = resolveRecordingConfig(undefined);
    expect(cfg.video).toMatchObject({
      bootDefer: "auto",
      bootDeferMaxSecs: 90,
      bootDeferMinBudgetMa: 5000,
      spawnStaggerSecs: 4,
    });
    expect(RECORDING_DEFAULTS.video.bootDefer).toBe("auto");
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
