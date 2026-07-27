import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { applyCloudConfig, parseCloudConfig } from "../src/agent/cloud-config.js";
import { loadSettings, saveSettings, settingsPath } from "../src/daemon/settings.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

describe("parseCloudConfig", () => {
  it("parses a v1 config message", () => {
    const msg = JSON.stringify({ v: 1, gnssAntBias: true, ts: 1750000000000 });
    expect(parseCloudConfig(Buffer.from(msg))).toEqual({ gnssAntBias: true });
    expect(parseCloudConfig(JSON.stringify({ v: 1, gnssAntBias: false }))).toEqual({
      gnssAntBias: false,
    });
  });

  it("rejects malformed payloads and wrong versions", () => {
    expect(parseCloudConfig("not json")).toBeNull();
    expect(parseCloudConfig("42")).toBeNull();
    expect(parseCloudConfig(JSON.stringify(null))).toBeNull();
    expect(parseCloudConfig(JSON.stringify({ gnssAntBias: true }))).toBeNull();
    expect(parseCloudConfig(JSON.stringify({ v: 2, gnssAntBias: true }))).toBeNull();
  });

  it("drops known keys with the wrong type", () => {
    expect(parseCloudConfig(JSON.stringify({ v: 1, gnssAntBias: "on" }))).toEqual({});
  });

  it("parses an imuMount object and drops malformed ones", () => {
    const m = { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 180 };
    expect(parseCloudConfig(JSON.stringify({ v: 1, imuMount: m }))).toEqual({ imuMount: m });
    expect(
      parseCloudConfig(JSON.stringify({ v: 1, imuMount: { enabled: true, rollDeg: "90" } })),
    ).toEqual({});
  });

  it("parses a recording namespace (normalized like local settings)", () => {
    const rec = {
      telemetry: { enabled: true, rateHz: 10 },
      video: { enabled: true, preset: "1080p15-2mbps", segmentSeconds: 60 },
      upload: { mode: "auto" },
      retention: { maxBytes: 10737418240, minFreeBytes: 2147483648 },
    };
    expect(parseCloudConfig(JSON.stringify({ v: 1, recording: rec }))).toEqual({
      recording: rec,
    });
    // Out-of-range numbers clamp (device posture), mistyped fields drop.
    expect(
      parseCloudConfig(
        JSON.stringify({ v: 1, recording: { telemetry: { rateHz: 99, enabled: "yes" } } }),
      ),
    ).toEqual({ recording: { telemetry: { rateHz: 20 } } });
  });

  it("parses an lteRecovery namespace (all-invalid → null, mistyped → ignored)", () => {
    expect(
      parseCloudConfig(
        JSON.stringify({ v: 1, lteRecovery: { gpsFixResetPolicy: "veto-deadzone" } }),
      ),
    ).toEqual({ lteRecovery: { gpsFixResetPolicy: "veto-deadzone" } });
    // Carried but nothing valid → null ("cloud manages it, all defaults").
    expect(
      parseCloudConfig(JSON.stringify({ v: 1, lteRecovery: { gpsFixResetPolicy: "bogus" } })),
    ).toEqual({ lteRecovery: null });
    // Mistyped container → key absent (local settings untouched).
    expect(parseCloudConfig(JSON.stringify({ v: 1, lteRecovery: [] }))).toEqual({});
    expect(parseCloudConfig(JSON.stringify({ v: 1, lteRecovery: "defer" }))).toEqual({});
  });

  it("parses uploadBucket and drops empty/mistyped values", () => {
    expect(
      parseCloudConfig(JSON.stringify({ v: 1, uploadBucket: "core-bucket" })),
    ).toEqual({ uploadBucket: "core-bucket" });
    expect(parseCloudConfig(JSON.stringify({ v: 1, uploadBucket: "" }))).toEqual({});
    expect(parseCloudConfig(JSON.stringify({ v: 1, uploadBucket: 42 }))).toEqual({});
  });

  it("maps an empty/all-invalid recording object to null (cloud-managed defaults)", () => {
    expect(parseCloudConfig(JSON.stringify({ v: 1, recording: {} }))).toEqual({
      recording: null,
    });
    // Absent key stays absent (not null) — leaves local settings alone.
    expect(parseCloudConfig(JSON.stringify({ v: 1 }))).toEqual({});
    // Non-object recording values are ignored entirely.
    expect(parseCloudConfig(JSON.stringify({ v: 1, recording: "on" }))).toEqual({});
    expect(parseCloudConfig(JSON.stringify({ v: 1, recording: [1] }))).toEqual({});
  });
});

describe("applyCloudConfig", () => {
  it("persists gnssAntBias into settings.json", () => {
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ gnssAntBias: true });
    expect(applyCloudConfig({ gnssAntBias: false })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ gnssAntBias: false });
  });

  it("merges without clobbering other operator settings", () => {
    saveSettings({ mode: "real", mediaEnabled: true });
    applyCloudConfig({ gnssAntBias: true });
    expect(loadSettings()).toEqual({ mode: "real", mediaEnabled: true, gnssAntBias: true });
  });

  it("is a no-op when the value is unchanged (retained re-delivery)", () => {
    saveSettings({ gnssAntBias: true });
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: false });
    expect(applyCloudConfig({})).toEqual({ changed: false });
    expect(loadSettings()).toEqual({ gnssAntBias: true });
  });

  it("survives a corrupt settings file (treated as empty)", () => {
    writeFileSync(settingsPath(), "not json");
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ gnssAntBias: true });
  });

  it("persists imuMount and no-ops on an identical re-delivery", () => {
    const m = { enabled: true, rollDeg: 0, pitchDeg: 0, yawDeg: 90 };
    expect(applyCloudConfig({ imuMount: m })).toEqual({ changed: true });
    expect(loadSettings().imuMount).toEqual(m);
    expect(applyCloudConfig({ imuMount: { ...m } })).toEqual({ changed: false });
    expect(applyCloudConfig({ imuMount: { ...m, yawDeg: 180 } })).toEqual({ changed: true });
    expect(loadSettings().imuMount?.yawDeg).toBe(180);
  });

  it("replaces the whole recording namespace with the cloud value", () => {
    // Local tweak (e.g. xorgate set) that the cloud config doesn't carry…
    saveSettings({ mode: "real", recording: { telemetry: { enabled: true, rateHz: 20 } } });
    const cloud = { video: { enabled: true, preset: "720p30-2mbps" } };
    expect(applyCloudConfig({ recording: cloud })).toEqual({ changed: true });
    // …is gone after apply: cloud is authoritative for the full namespace.
    expect(loadSettings()).toEqual({ mode: "real", recording: cloud });
  });

  it("no-ops on an identical recording re-delivery (retained replay)", () => {
    const cloud = { telemetry: { enabled: true, rateHz: 10 } };
    expect(applyCloudConfig({ recording: cloud })).toEqual({ changed: true });
    expect(applyCloudConfig({ recording: { telemetry: { enabled: true, rateHz: 10 } } })).toEqual(
      { changed: false },
    );
    expect(loadSettings().recording).toEqual(cloud);
  });

  it("recording: null clears the local namespace; absent leaves it alone", () => {
    saveSettings({ recording: { video: { enabled: true } }, gnssAntBias: true });
    // Absent key: untouched (cloud never configured recording).
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: false });
    expect(loadSettings().recording).toEqual({ video: { enabled: true } });
    // null (empty cloud object): local key removed → device defaults.
    expect(applyCloudConfig({ recording: null })).toEqual({ changed: true });
    expect(loadSettings().recording).toBeUndefined();
    // …and clearing again is a no-op.
    expect(applyCloudConfig({ recording: null })).toEqual({ changed: false });
  });

  it("replaces the lteRecovery namespace with the cloud value (R8 policy conduit)", () => {
    saveSettings({ mode: "real", lteRecovery: { deadZoneProfile: "aggressive" } });
    expect(
      applyCloudConfig({ lteRecovery: { gpsFixResetPolicy: "veto-deadzone" } }),
    ).toEqual({ changed: true });
    // REPLACE, not merge: the locally-set profile is gone, cloud is authoritative.
    expect(loadSettings()).toEqual({
      mode: "real",
      lteRecovery: { gpsFixResetPolicy: "veto-deadzone" },
    });
    // Identical retained re-delivery no-ops.
    expect(
      applyCloudConfig({ lteRecovery: { gpsFixResetPolicy: "veto-deadzone" } }),
    ).toEqual({ changed: false });
  });

  it("lteRecovery: null clears the local namespace; absent leaves it alone", () => {
    saveSettings({ lteRecovery: { gpsFixResetPolicy: "veto-deadzone" }, gnssAntBias: true });
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: false });
    expect(loadSettings().lteRecovery).toEqual({ gpsFixResetPolicy: "veto-deadzone" });
    expect(applyCloudConfig({ lteRecovery: null })).toEqual({ changed: true });
    expect(loadSettings().lteRecovery).toBeUndefined();
    expect(applyCloudConfig({ lteRecovery: null })).toEqual({ changed: false });
  });
});
