import { describe, expect, it } from "vitest";
import {
  createTimeSourceTracker,
  mintSessionId,
  probeTimeSource,
  readBootId,
} from "../src/recording/session.js";

describe("mintSessionId", () => {
  it("produces valid UUIDv7-shaped ids", () => {
    const id = mintSessionId(1_800_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts by mint time (oldest-first upload/eviction ordering)", () => {
    const a = mintSessionId(1_000_000);
    const b = mintSessionId(2_000_000);
    const c = mintSessionId(1_800_000_000_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it("is unique across calls at the same ms", () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintSessionId(12345)));
    expect(ids.size).toBe(100);
  });
});

describe("boot id + time source", () => {
  it("returns a stable per-process boot id", () => {
    const a = readBootId();
    expect(a).toBeTruthy();
    expect(readBootId()).toBe(a);
  });

  it("probes to one of the three provenance values without throwing", async () => {
    const ts = await probeTimeSource();
    expect(["ntp", "rtc", "unsynced"]).toContain(ts);
  });
});

describe("timeSource tracker with offline clock steps (Phase 4)", () => {
  it("reports the stepped source over a weaker probe value, immediately and across refreshes", async () => {
    const tracker = createTimeSourceTracker(60_000, async () => "rtc");
    expect(await tracker.refresh()).toBe("rtc");
    tracker.noteStep("gps");
    expect(tracker.current()).toBe("gps"); // immediate — no probe round-trip
    expect(await tracker.refresh()).toBe("gps"); // probe still rtc; step wins
  });

  it("lets NTP supersede a step for good", async () => {
    let probed: "ntp" | "rtc" | "unsynced" = "unsynced";
    const tracker = createTimeSourceTracker(60_000, async () => probed);
    tracker.noteStep("nitz");
    expect(await tracker.refresh()).toBe("nitz");
    probed = "ntp";
    expect(await tracker.refresh()).toBe("ntp");
    // Back to a degraded probe (can't happen within a boot; belt-and-braces):
    // the stepped state was discarded when NTP landed.
    probed = "rtc";
    expect(await tracker.refresh()).toBe("rtc");
  });

  it("never downgrades a current ntp value on a late noteStep", async () => {
    const tracker = createTimeSourceTracker(60_000, async () => "ntp");
    expect(await tracker.refresh()).toBe("ntp");
    tracker.noteStep("gps");
    expect(tracker.current()).toBe("ntp");
  });
});
