import { describe, expect, it } from "vitest";
import { mintSessionId, probeTimeSource, readBootId } from "../src/recording/session.js";

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
