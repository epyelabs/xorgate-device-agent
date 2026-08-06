import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { migrateMediaEnabled } from "../src/daemon/settings-migrate.js";
import { loadSettings, saveSettings, settingsPath } from "../src/daemon/settings.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

/** Write settings.json with keys the current allowlist would refuse to keep. */
function writeRaw(obj: Record<string, unknown>): void {
  writeFileSync(settingsPath(), JSON.stringify(obj));
}

function raw(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
}

describe("mediaEnabled upgrade migration", () => {
  it("does nothing when the legacy key was never there", () => {
    saveSettings({ mode: "real", gnssAntBias: true });
    expect(migrateMediaEnabled(["cam0"])).toEqual({ result: "none" });
    expect(raw()).toEqual({ mode: "real", gnssAntBias: true });
  });

  it("does nothing on a missing or corrupt file", () => {
    expect(migrateMediaEnabled(["cam0"])).toEqual({ result: "none" });
    writeFileSync(settingsPath(), "{not json");
    expect(migrateMediaEnabled(["cam0"])).toEqual({ result: "none" });
  });

  it("drops an explicit `true` without touching anything else", () => {
    writeRaw({ mode: "real", mediaEnabled: true, gnssAntBias: true });
    expect(migrateMediaEnabled(["cam0", "cam1"])).toEqual({ result: "dropped" });
    expect(raw()).toEqual({ mode: "real", gnssAntBias: true });
  });

  it("converts an explicit `false` into every camera disabled", () => {
    // The deliberate opt-out that must survive: without this the default flips
    // from "off unless enabled" to "streaming unless cameras are disabled".
    writeRaw({ mode: "real", mediaEnabled: false });
    expect(migrateMediaEnabled(["cam0", "cam1"])).toEqual({
      result: "cameras-disabled",
      cameras: ["cam0", "cam1"],
    });
    expect(loadSettings().recording?.video?.cameras).toEqual({ cam0: false, cam1: false });
    expect(raw()).not.toHaveProperty("mediaEnabled");
  });

  it("forces cameras off even where one was explicitly on", () => {
    writeRaw({
      mediaEnabled: false,
      recording: { video: { enabled: true, cameras: { cam0: true } } },
    });
    migrateMediaEnabled(["cam0", "cam1"]);
    const video = loadSettings().recording?.video;
    expect(video?.cameras).toEqual({ cam0: false, cam1: false });
    // Only the camera map moves — the rest of the namespace is preserved.
    expect(video?.enabled).toBe(true);
  });

  it("just drops the key when the manifest lists no channels", () => {
    // No channels means no streams to disable and nothing that could start
    // streaming, so there is no opt-out left to preserve.
    writeRaw({ mode: "sim", mediaEnabled: false });
    expect(migrateMediaEnabled([])).toEqual({ result: "cameras-disabled", cameras: [] });
    expect(raw()).toEqual({ mode: "sim" });
  });

  it("is idempotent — a second run is a no-op", () => {
    writeRaw({ mediaEnabled: false });
    migrateMediaEnabled(["cam0"]);
    const after = raw();
    expect(migrateMediaEnabled(["cam0"])).toEqual({ result: "none" });
    expect(raw()).toEqual(after);
  });
});
