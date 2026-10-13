import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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
    // An all-invalid OBJECT now maps to null ("clear this namespace"), the same
    // as recording/lteRecovery/timeSync. It used to parse to absent ("leave the
    // local value alone"), which made imuMount the one namespace an empty
    // object could not revert — settings_sync_hardening finding 2.
    expect(
      parseCloudConfig(JSON.stringify({ v: 1, imuMount: { enabled: true, rollDeg: "90" } })),
    ).toEqual({ imuMount: null });
    // Non-object values are still ignored entirely.
    expect(parseCloudConfig(JSON.stringify({ v: 1, imuMount: "on" }))).toEqual({});
    expect(parseCloudConfig(JSON.stringify({ v: 1, imuMount: [1] }))).toEqual({});
  });

  it("maps an empty imuMount object to null (the cloud's revert marker)", () => {
    expect(parseCloudConfig(JSON.stringify({ v: 1, imuMount: {} }))).toEqual({
      imuMount: null,
    });
    // Absent key stays absent (not null) — leaves local settings alone.
    expect(parseCloudConfig(JSON.stringify({ v: 1 }))).toEqual({});
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

  it("parses a tenant scope, and takes it only when BOTH halves are present", () => {
    const ORG = "1d2b4514-7408-4234-af5f-83b9451575ea";
    const WS = "c2e2a967-6dbe-464c-b45d-c6ef6087875b";
    expect(
      parseCloudConfig(
        JSON.stringify({ v: 1, scope: { organizationId: ORG, workspaceId: WS } }),
      ),
    ).toEqual({ scope: { organizationId: ORG, workspaceId: WS } });

    // A half-populated scope would build a topic with an empty segment, which
    // the broker refuses — so the device would silently stop reporting. Dropping
    // the field keeps it on the unscoped topic, which is still ingested.
    for (const bad of [
      { organizationId: ORG },
      { workspaceId: WS },
      { organizationId: ORG, workspaceId: "" },
      { organizationId: 42, workspaceId: WS },
      "nope",
      [ORG, WS],
      null,
    ]) {
      expect(parseCloudConfig(JSON.stringify({ v: 1, scope: bad }))).toEqual({});
    }
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
    saveSettings({ mode: "real", timeSync: { offlineSources: false } });
    applyCloudConfig({ gnssAntBias: true });
    expect(loadSettings()).toEqual({
      mode: "real",
      timeSync: { offlineSources: false },
      gnssAntBias: true,
    });
  });

  // settings_sync_hardening finding 2: `PATCH {"imuMount": null}` reaches the
  // device as `imuMount: {}`, and it has to actually revert.
  it("clears imuMount when the cloud sends the revert marker", () => {
    saveSettings({ mode: "real", imuMount: { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 } });
    expect(applyCloudConfig({ imuMount: null })).toEqual({ changed: true });
    // The KEY is gone, not set to a zeroed mount — absent is what "device
    // defaults" means on this side of the wire.
    expect(loadSettings()).toEqual({ mode: "real" });
  });

  it("leaves imuMount alone when the cloud never mentions it", () => {
    const mount = { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 };
    saveSettings({ mode: "real", imuMount: mount });
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ mode: "real", imuMount: mount, gnssAntBias: true });
  });

  it("is a no-op when the revert marker arrives and there is nothing to clear", () => {
    // The retained message redelivers on every connect; a cleared namespace
    // stays `{}` on the wire forever, so this is the common path.
    saveSettings({ mode: "real" });
    expect(applyCloudConfig({ imuMount: null })).toEqual({ changed: false });
    expect(loadSettings()).toEqual({ mode: "real" });
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

  // Phase 6 of the settings-management plan, found on the bench: a file we
  // cannot READ still holds the operator's settings, and merging onto the `{}`
  // that loadSettings answers with would write them away — `mode` included.
  // Corrupt self-heals (above), unreadable must not.
  it("refuses to overwrite a settings file it cannot read", () => {
    saveSettings({ mode: "real", timeSync: { offlineSources: false } });
    chmodSync(settingsPath(), 0o000);
    try {
      // Root ignores the mode bits, so only assert when the chmod really bites.
      let readable = true;
      try {
        readFileSync(settingsPath());
      } catch {
        readable = false;
      }
      if (readable) return;
      expect(() => applyCloudConfig({ gnssAntBias: true })).toThrow(/cannot be read/);
    } finally {
      chmodSync(settingsPath(), 0o600);
    }
    // …and the operator's settings are still there.
    expect(loadSettings()).toEqual({ mode: "real", timeSync: { offlineSources: false } });
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

  it("replaces the timeSync namespace with the cloud value (Phase 4 kill-switch conduit)", () => {
    saveSettings({ mode: "real", timeSync: { stepThresholdSecs: 30 } });
    expect(applyCloudConfig({ timeSync: { offlineSources: false } })).toEqual({ changed: true });
    // REPLACE, not merge: the locally-set threshold is gone, cloud is authoritative.
    expect(loadSettings()).toEqual({ mode: "real", timeSync: { offlineSources: false } });
    expect(applyCloudConfig({ timeSync: { offlineSources: false } })).toEqual({ changed: false });
    // null clears; absent leaves alone.
    expect(applyCloudConfig({ timeSync: null })).toEqual({ changed: true });
    expect(loadSettings().timeSync).toBeUndefined();
    expect(applyCloudConfig({})).toEqual({ changed: false });
  });

  it("parses a timeSync namespace (clamped numbers; all-invalid → null)", () => {
    expect(
      parseCloudConfig(
        JSON.stringify({ v: 1, timeSync: { offlineSources: true, stepThresholdSecs: 1 } }),
      ),
    ).toEqual({ timeSync: { offlineSources: true, stepThresholdSecs: 2 } });
    expect(parseCloudConfig(JSON.stringify({ v: 1, timeSync: { offlineSources: "yes" } }))).toEqual(
      { timeSync: null },
    );
    expect(parseCloudConfig(JSON.stringify({ v: 1, timeSync: [] }))).toEqual({});
  });
});

describe("simulation namespace (device-simulator Phase 2)", () => {
  it("parses, clamps and drops like its siblings; empty object clears", () => {
    expect(parseCloudConfig(JSON.stringify({ v: 1, simulation: { scenarioId: "city-2026-09-27", loop: false, gapSeconds: 5000 } }))?.simulation)
      .toEqual({ scenarioId: "city-2026-09-27", loop: false, gapSeconds: 3600 });
    expect(parseCloudConfig(JSON.stringify({ v: 1, simulation: { scenarioId: "../etc", loop: "yes" } }))?.simulation).toBeNull();
    expect(parseCloudConfig(JSON.stringify({ v: 1, simulation: {} }))?.simulation).toBeNull();
    expect(parseCloudConfig(JSON.stringify({ v: 1 }))?.simulation).toBeUndefined();
  });
  it("replaces the whole namespace, clears on null, leaves it alone when absent", () => {
    saveSettings({ mode: "replay", simulation: { scenarioId: "a-1", gapSeconds: 10 } });
    expect(applyCloudConfig({ simulation: { scenarioId: "b-2" } })).toEqual({ changed: true });
    expect(loadSettings().simulation).toEqual({ scenarioId: "b-2" });
    expect(applyCloudConfig({ simulation: { scenarioId: "b-2" } })).toEqual({ changed: false });
    expect(applyCloudConfig({ recording: { telemetry: { enabled: true } } })).toEqual({ changed: true });
    expect(loadSettings().simulation).toEqual({ scenarioId: "b-2" });
    expect(applyCloudConfig({ simulation: null })).toEqual({ changed: true });
    expect(loadSettings().simulation).toBeUndefined();
    expect(loadSettings().mode).toBe("replay");
  });
});

describe("obd namespace (obd2-bluetooth-integration P3)", () => {
  const MSG = (obd: unknown) => JSON.stringify({ v: 1, rev: 51, obd });

  it("parses the namespace normalized like local settings; all-invalid → null; wrong type → ignored", () => {
    expect(parseCloudConfig(MSG({ enabled: true, adapterMac: "10:21:3e:4f:33:65", powerSource: "switched" }))).toEqual({
      rev: 51,
      obd: { enabled: true, adapterMac: "10:21:3E:4F:33:65", powerSource: "switched" },
    });
    expect(parseCloudConfig(MSG({}))).toEqual({ rev: 51, obd: null });
    expect(parseCloudConfig(MSG({ pin: "x" }))).toEqual({ rev: 51, obd: null });
    expect(parseCloudConfig(MSG("10:21:3E:4F:33:65"))).toEqual({ rev: 51 });
    expect(parseCloudConfig(MSG([1]))).toEqual({ rev: 51 });
  });

  it("replaces the whole namespace, no-ops on an identical redelivery, clears on null, leaves alone when absent", () => {
    saveSettings({ mode: "real", obd: { enabled: false, adapterMac: null, pollHz: 2 } });
    const cloud = { enabled: true, adapterMac: "10:21:3E:4F:33:65", powerSource: "switched" as const };
    expect(applyCloudConfig({ obd: cloud })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ mode: "real", obd: cloud }); // pollHz 2 did NOT survive: replace, not merge
    expect(applyCloudConfig({ obd: { ...cloud } })).toEqual({ changed: false });
    expect(applyCloudConfig({ gnssAntBias: true })).toEqual({ changed: true });
    expect(loadSettings().obd).toEqual(cloud);
    expect(applyCloudConfig({ obd: null })).toEqual({ changed: true });
    expect(loadSettings()).toEqual({ mode: "real", gnssAntBias: true });
    expect(applyCloudConfig({ obd: null })).toEqual({ changed: false });
  });
});
