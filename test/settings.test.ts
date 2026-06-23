import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { loadSettings, saveSettings, settingsPath } from "../src/daemon/settings.js";
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

  it("round-trips the media toggle alongside the mode", () => {
    saveSettings({ mode: "real", mediaEnabled: true });
    expect(loadSettings()).toEqual({ mode: "real", mediaEnabled: true });
    saveSettings({ mode: "real", mediaEnabled: false });
    expect(loadSettings()).toEqual({ mode: "real", mediaEnabled: false });
  });

  it("ignores a non-boolean mediaEnabled", () => {
    writeFileSync(settingsPath(), JSON.stringify({ mode: "real", mediaEnabled: "yes" }));
    expect(loadSettings()).toEqual({ mode: "real" });
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
