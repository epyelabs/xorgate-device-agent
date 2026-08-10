import { describe, expect, it } from "vitest";
import { formatBuildInfo, loadBuildInfo, resetBuildInfoCache } from "../src/lib/build-info.js";

describe("loadBuildInfo", () => {
  it("falls back to the package version on channel 'local' when no manifest is baked", () => {
    // Vitest runs from src/, where CI never writes build-info.json — this IS the
    // hand-deployed-tree case, and it must read honestly rather than guess a sha.
    resetBuildInfoCache();
    const info = loadBuildInfo();
    expect(info.channel).toBe("local");
    expect(info.version).toBe(info.packageVersion);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.builtAt).toBeNull();
  });

  it("caches — repeated calls are the same object, no repeated disk reads", () => {
    resetBuildInfoCache();
    expect(loadBuildInfo()).toBe(loadBuildInfo());
  });

  it("formats as '<pkg> (<version>, <channel>)'", () => {
    expect(
      formatBuildInfo({
        version: "a1b2c3d",
        channel: "dev",
        builtAt: "2026-08-10T00:00:00Z",
        packageVersion: "0.2.0",
      }),
    ).toBe("0.2.0 (a1b2c3d, dev)");
  });
});
