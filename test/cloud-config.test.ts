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
});
