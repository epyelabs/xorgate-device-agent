/**
 * LedManager — the time-based half of the LED (overlay, change latch, shutdown).
 * Uses a real LedDriver with an injected writer, so no hardware is touched.
 */
import { describe, expect, it, vi } from "vitest";
import { LedManager } from "../src/agent/led-manager.js";
import { LedDriver } from "../src/hardware/led.js";
import type { LedSignals } from "../src/lib/led-state.js";
import type { RecordingStatus } from "../src/agent/telemetry.js";

const RECORDING: RecordingStatus = {
  enabled: true,
  sessionId: "s1",
  backlogBytes: 0,
  backlogSegments: 0,
  droppedSegments: 0,
  uploading: false,
  lastUploadAt: null,
};

function healthy(over: Partial<LedSignals> = {}): LedSignals {
  return {
    connection: "connected",
    recording: { ...RECORDING },
    lte: { status: "connected" },
    gnss: { fix: true, sky: "open" },
    starting: false,
    ...over,
  };
}

/** `pin=level` writes, and a driver that is available unless told otherwise. */
function harness(signals: () => LedSignals, ok = true) {
  const writes: string[] = [];
  const logs: string[] = [];
  const driver = new LedDriver({
    log: () => {},
    probe: async () => (ok ? { ok: true } : { ok: false, reason: "not a Raspberry Pi" }),
    write: async (pin, high) => {
      writes.push(`${pin}=${high ? 1 : 0}`);
      return true;
    },
  });
  const led = new LedManager({ signals, driver, log: (m) => logs.push(m) });
  return { led, driver, writes, logs };
}

/** Let queued microtasks + timers settle. */
const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LedManager", () => {
  it("shows the starting rung as soon as it takes over", async () => {
    const { led, writes } = harness(() => healthy());
    await led.start();
    await settle();
    expect(writes.slice(0, 3)).toEqual(["12=1", "21=1", "16=1"]); // white
  });

  it("re-renders only when the resolved state actually changes", async () => {
    let signals = healthy();
    const { led, writes, logs } = harness(() => signals);
    await led.start();
    await settle();

    led.tick(); // starting -> healthy
    await settle();
    const afterFirst = writes.length;
    expect(logs.some((l) => l.includes("→ healthy"))).toBe(true);

    // Three more ticks with unchanged signals must not re-drive the pins; the
    // heartbeat is mid-cycle and restarting it would visibly stutter.
    led.tick();
    led.tick();
    led.tick();
    expect(writes.length).toBe(afterFirst);

    signals = healthy({ connection: "closed" });
    led.tick();
    await settle();
    expect(writes.length).toBeGreaterThan(afterFirst);
    expect(logs.some((l) => l.includes("healthy → network"))).toBe(true);
  });

  it("drives the colour the ladder picked for the signals", async () => {
    let signals = healthy({ starting: false, gnss: { fix: false, sky: "open" } });
    const { led, writes } = harness(() => signals);
    await led.start();
    await settle();
    writes.length = 0;
    led.tick();
    await settle();
    expect(writes.slice(0, 3)).toEqual(["12=0", "21=0", "16=1"]); // blue

    signals = healthy({
      recording: { ...RECORDING, liveBlock: { reason: "thermal", detail: "", since: 0 } },
    });
    writes.length = 0;
    led.tick();
    await settle();
    expect(writes.slice(0, 3)).toEqual(["12=0", "21=1", "16=1"]); // cyan
  });

  it("flashes white for an applied config, then returns to the real state", async () => {
    const { led, writes, logs } = harness(() => healthy());
    await led.start();
    await settle();
    led.tick(); // settle on green heartbeat
    await settle();

    writes.length = 0;
    led.configApplied();
    await settle(40);
    expect(writes.slice(0, 3)).toEqual(["12=1", "21=1", "16=1"]); // white flash

    // flash2 is ~500 ms; afterwards the heartbeat must be running again, NOT
    // left dark. Assert the green triple appears rather than that it is last —
    // the heartbeat is dark ~95% of the time, so the final write usually IS off.
    await settle(700);
    expect(writes.join(",")).toContain("12=0,21=1,16=0"); // green pulsed again
    expect(logs.some((l) => l.includes("→ healthy"))).toBe(true);
  });

  it("ignores ticks while the overlay is running", async () => {
    let signals = healthy();
    const { led } = harness(() => signals);
    await led.start();
    await settle();
    led.configApplied();
    signals = healthy({ connection: "closed" });
    led.tick(); // swallowed by the overlay
    await settle(40);
    // The change is picked up by the re-render the overlay triggers on finish.
    await settle(700);
    expect(signals.connection).toBe("closed");
  });

  it("holds its current state when signal gathering throws, and never dies", async () => {
    let boom = false;
    const { led, logs } = harness(() => {
      if (boom) throw new Error("collector exploded");
      return healthy();
    });
    await led.start();
    led.tick();
    await settle();
    boom = true;
    expect(() => led.tick()).not.toThrow();
    expect(logs.some((l) => l.includes("signal read failed"))).toBe(true);
  });

  it("blanks on stop and ignores everything afterwards", async () => {
    const { led, writes } = harness(() => healthy());
    await led.start();
    await settle();
    writes.length = 0;
    led.stop();
    await settle();
    expect(writes.slice(-3)).toEqual(["12=0", "21=0", "16=0"]);

    writes.length = 0;
    led.tick();
    led.configApplied();
    await settle(40);
    expect(writes).toEqual([]);
  });

  it("is a total no-op when the driver is inert (dev box)", async () => {
    const { led, writes, logs } = harness(() => healthy(), false);
    await led.start();
    led.tick();
    led.configApplied();
    led.stop();
    await settle(40);
    expect(writes).toEqual([]);
    expect(led.available).toBe(false);
    expect(logs.some((l) => l.includes("inert"))).toBe(true);
  });

  it("never calls the signal function when inert — no wasted work", async () => {
    const signals = vi.fn(() => healthy());
    const { led } = harness(signals, false);
    await led.start();
    led.tick();
    expect(signals).not.toHaveBeenCalled();
  });
});
