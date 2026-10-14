import { describe, expect, it } from "vitest";
import { CLOCK_TRUST_DEFAULTS, createClockTrust } from "../src/agent/clock-trust.js";

/**
 * Clock trust gate (REPORT-P1-CAR open issue 1): the live publish and the
 * recorder are held until NTP (or a GPS/NITZ step) lands, for at most the
 * grace window; after that the clock is used, flagged.
 */
describe("createClockTrust", () => {
  function rig(probeAnswers: Array<"ntp" | "rtc" | "unsynced">, graceMs = 300_000) {
    let mono = 1_000;
    const events: Array<{ level: string; msg: string }> = [];
    let probes = 0;
    const trust = createClockTrust({
      probe: async () => {
        probes += 1;
        return probeAnswers[Math.min(probes, probeAnswers.length) - 1]!;
      },
      graceMs,
      monoMs: () => mono,
      onEvent: (level, msg) => events.push({ level, msg }),
    });
    return {
      trust,
      events,
      advance: (ms: number) => {
        mono += ms;
      },
      get probes() {
        return probes;
      },
    };
  }

  it("holds until the probe reports NTP, then latches trusted with one info event", async () => {
    const r = rig(["unsynced", "unsynced", "ntp"]);
    expect(r.trust.trusted()).toBe(false);
    expect(r.trust.status()).toMatchObject({ trusted: false, state: "held", source: null, held: 0 });
    r.trust.noteHeld();
    r.trust.noteHeld();
    await r.trust.tick();
    r.advance(5_000);
    await r.trust.tick();
    expect(r.trust.trusted()).toBe(false);
    expect(r.events).toEqual([]);
    r.advance(5_000);
    await r.trust.tick();
    expect(r.trust.trusted()).toBe(true);
    expect(r.trust.status()).toMatchObject({ trusted: true, state: "trusted", source: "ntp", held: 2, heldMs: 10_000 });
    expect(r.events).toEqual([{ level: "info", msg: expect.stringMatching(/ntp synchronized.*held 10 s, 2 sample/) }]);
    // latched: later probes are not consulted and nothing re-logs
    const before = r.probes;
    await r.trust.tick();
    expect(r.probes).toBe(before);
    expect(r.events).toHaveLength(1);
  });

  it("an rtc answer is NOT trust (battery-less CM5), a GPS/NITZ step is", async () => {
    const r = rig(["rtc"]);
    await r.trust.tick();
    expect(r.trust.trusted()).toBe(false);
    r.trust.noteStep("gps");
    expect(r.trust.trusted()).toBe(true);
    expect(r.trust.status().source).toBe("gps");
    expect(r.events[0]!.msg).toMatch(/gps synchronized/);
  });

  it("falls back after the grace window with a warn event, never blocking telemetry for good", async () => {
    const r = rig(["unsynced"], 60_000);
    await r.trust.tick();
    r.trust.noteHeld();
    r.advance(59_999);
    expect(r.trust.trusted()).toBe(false);
    r.advance(1);
    expect(r.trust.trusted()).toBe(true);
    expect(r.trust.status()).toMatchObject({ trusted: true, state: "fallback", source: null, held: 1, heldMs: 60_000 });
    expect(r.events).toEqual([{ level: "warn", msg: expect.stringMatching(/UNTRUSTED clock.*1 sample\(s\) held/) }]);
    // the flag is repeated nowhere; trusted() stays true
    r.advance(100_000);
    expect(r.trust.trusted()).toBe(true);
    expect(r.events).toHaveLength(1);
  });

  it("NTP landing after a fallback clears the flag and says how long it published untrusted", async () => {
    const r = rig(["unsynced", "ntp"], 60_000);
    await r.trust.tick();
    r.advance(60_000);
    expect(r.trust.trusted()).toBe(true);
    expect(r.trust.status().state).toBe("fallback");
    r.advance(30_000);
    await r.trust.tick();
    expect(r.trust.status()).toMatchObject({ state: "trusted", source: "ntp", heldMs: 60_000 });
    expect(r.events.map((e) => e.level)).toEqual(["warn", "info"]);
    expect(r.events[1]!.msg).toMatch(/published 30 s on an untrusted clock/);
  });

  it("a throwing probe counts toward the grace window instead of wedging the gate", async () => {
    let mono = 0;
    const events: string[] = [];
    const trust = createClockTrust({
      probe: async () => {
        throw new Error("timedatectl: boom");
      },
      graceMs: 1_000,
      monoMs: () => mono,
      onEvent: (_l, msg) => events.push(msg),
    });
    await trust.tick();
    expect(trust.trusted()).toBe(false);
    mono = 1_000;
    await trust.tick();
    expect(trust.trusted()).toBe(true);
    expect(events[0]).toMatch(/trust probe failed/);
  });

  it("defaults: 5 min grace, 5 s poll, 30 s slow poll", () => {
    expect(CLOCK_TRUST_DEFAULTS).toEqual({ graceMs: 300_000, pollMs: 5_000, slowPollMs: 30_000 });
  });
});
