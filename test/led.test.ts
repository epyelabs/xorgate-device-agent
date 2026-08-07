/**
 * RGB status LED — pure logic only. No hardware, no `pinctrl`: the pin writer is
 * injected so every test asserts on recorded writes.
 */
import { describe, expect, it } from "vitest";
import {
  LED_COLOURS,
  LedDriver,
  STATUS_LED_MAP,
  ledTimeline,
  parseBusyPins,
  validatePinMap,
  type LedColour,
  type LedPinMap,
} from "../src/hardware/led.js";

/** Records writes and always succeeds; `map` fixes pin → channel for assertions. */
function recorder(map: LedPinMap = STATUS_LED_MAP) {
  const writes: string[] = [];
  const driver = new LedDriver({
    map,
    log: () => {},
    probe: async () => ({ ok: true }),
    write: async (pin, high) => {
      writes.push(`${pin}=${high ? 1 : 0}`);
      return true;
    },
  });
  return { driver, writes };
}

/** The three writes a colour should produce on the hardcoded Argus map. */
function triple(colour: LedColour): string[] {
  const { r, g, b } = LED_COLOURS[colour];
  return [`12=${+r}`, `21=${+g}`, `16=${+b}`];
}

describe("colour → channels", () => {
  it("maps the six measured colours plus off", () => {
    expect(LED_COLOURS.red).toEqual({ r: true, g: false, b: false });
    expect(LED_COLOURS.green).toEqual({ r: false, g: true, b: false });
    expect(LED_COLOURS.blue).toEqual({ r: false, g: false, b: true });
    expect(LED_COLOURS.purple).toEqual({ r: true, g: false, b: true });
    expect(LED_COLOURS.cyan).toEqual({ r: false, g: true, b: true });
    expect(LED_COLOURS.white).toEqual({ r: true, g: true, b: true });
    expect(LED_COLOURS.off).toEqual({ r: false, g: false, b: false });
  });

  it("has no yellow/amber — r+g is not identifiable on this LED", () => {
    expect(Object.keys(LED_COLOURS)).not.toContain("yellow");
    expect(Object.keys(LED_COLOURS)).not.toContain("amber");
  });

  it("writes each colour to the hardcoded Argus pins, active high", async () => {
    for (const colour of ["red", "green", "blue", "purple", "cyan", "white", "off"] as const) {
      const { driver, writes } = recorder();
      await driver.init();
      await driver.set(colour);
      expect(writes, colour).toEqual(triple(colour));
    }
  });

  it("inverts the channels when the map is active low", async () => {
    const { driver, writes } = recorder({ ...STATUS_LED_MAP, activeHigh: false });
    await driver.init();
    await driver.set("red");
    expect(writes).toEqual(["12=0", "21=1", "16=1"]);
  });
});

describe("pattern → timeline", () => {
  it("holds solid indefinitely (ms 0 = until stopped)", () => {
    expect(ledTimeline("solid")).toEqual({ steps: [{ on: true, ms: 0 }], repeat: false });
  });

  it("blinks fast at ~4 Hz and slow at ~1 Hz, both 50% duty", () => {
    const fast = ledTimeline("blink-fast");
    const slow = ledTimeline("blink-slow");
    for (const tl of [fast, slow]) {
      expect(tl.repeat).toBe(true);
      expect(tl.steps.map((s) => s.on)).toEqual([true, false]);
      expect(tl.steps[0].ms).toBe(tl.steps[1].ms); // 50% duty
    }
    expect(1000 / (fast.steps[0].ms + fast.steps[1].ms)).toBeCloseTo(4, 1);
    expect(1000 / (slow.steps[0].ms + slow.steps[1].ms)).toBeCloseTo(1, 1);
  });

  it("heartbeat double-pulses, then stays dark for the rest of a 5–6 s cycle", () => {
    const tl = ledTimeline("heartbeat");
    expect(tl.repeat).toBe(true);
    expect(tl.steps.map((s) => s.on)).toEqual([true, false, true, false]);
    const cycle = tl.steps.reduce((sum, s) => sum + s.ms, 0);
    expect(cycle).toBeGreaterThanOrEqual(5000);
    expect(cycle).toBeLessThanOrEqual(6000);
    const dark = tl.steps[3].ms;
    expect(dark / cycle).toBeGreaterThan(0.9); // dark ~95% of the time
  });

  it("flash2 is two quick flashes and does not repeat", () => {
    const tl = ledTimeline("flash2");
    expect(tl.repeat).toBe(false);
    expect(tl.steps.map((s) => s.on)).toEqual([true, false, true]);
    expect(tl.steps.reduce((sum, s) => sum + s.ms, 0)).toBeLessThan(2000); // the 2 s overlay
  });
});

describe("pattern playback", () => {
  it("ends a non-repeating pattern dark rather than latched on its last flash", async () => {
    const { driver, writes } = recorder();
    await driver.init();
    await driver.play("white", "flash2");
    expect(writes.slice(-3)).toEqual(triple("off"));
  });

  it("leaves solid lit — it is only cancelled by stop()", async () => {
    const { driver, writes } = recorder();
    await driver.init();
    const running = driver.play("red", "solid");
    await new Promise((r) => setTimeout(r, 10));
    driver.stop();
    await running;
    expect(writes).toEqual(triple("red"));
  });

  it("stops a repeating pattern and blanks on demand", async () => {
    const { driver, writes } = recorder();
    await driver.init();
    const running = driver.play("purple", "blink-fast");
    await new Promise((r) => setTimeout(r, 300));
    driver.stop();
    await running;
    await driver.blank();
    expect(writes.length).toBeGreaterThan(3); // it actually toggled
    expect(writes.slice(-3)).toEqual(triple("off"));
  });
});

describe("pin-map validation", () => {
  it("accepts the hardcoded Argus CM5 Rev1 map", () => {
    expect(STATUS_LED_MAP.pins).toEqual({ r: 12, g: 21, b: 16 });
    expect(STATUS_LED_MAP.activeHigh).toBe(true);
    expect(validatePinMap(STATUS_LED_MAP)).toEqual({ ok: true });
  });

  it("rejects an unimplemented kind", () => {
    const res = validatePinMap({ ...STATUS_LED_MAP, kind: "pwm-rgb" });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unimplemented/);
  });

  it("rejects pins outside the RP1 range", () => {
    expect(validatePinMap({ ...STATUS_LED_MAP, pins: { r: 12, g: 21, b: 54 } }).ok).toBe(false);
    expect(validatePinMap({ ...STATUS_LED_MAP, pins: { r: -1, g: 21, b: 16 } }).ok).toBe(false);
    expect(validatePinMap({ ...STATUS_LED_MAP, pins: { r: 12.5, g: 21, b: 16 } }).ok).toBe(false);
  });

  it("rejects a map that reuses a pin", () => {
    const res = validatePinMap({ ...STATUS_LED_MAP, pins: { r: 12, g: 12, b: 16 } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/distinct/);
  });

  it("rejects a pin already held by another driver (the Phase 0 sdmode case)", () => {
    // Exactly what `gpioinfo gpiochip0` printed while the voiceHAT overlay owned
    // GPIO16 as the amplifier's `sdmode` line.
    const busy = parseBusyPins(
      [
        '\tline  12:      "GPIO12"       unused   input  active-high ',
        '\tline  16:      "GPIO16"       "sdmode"  output  active-high [used]',
        '\tline  21:      "GPIO21"       unused   input  active-high ',
      ].join("\n"),
    );
    expect(busy).toEqual([16]);
    const res = validatePinMap(STATUS_LED_MAP, busy);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/GPIO16/);
  });

  it("parses no busy pins from an all-free chip", () => {
    expect(parseBusyPins('\tline  16:      "GPIO16"       unused  output  active-high ')).toEqual(
      [],
    );
    expect(parseBusyPins("")).toEqual([]);
  });
});

describe("failure posture", () => {
  it("blanks all three channels when a write fails rather than latching", async () => {
    const writes: string[] = [];
    const logs: string[] = [];
    const driver = new LedDriver({
      map: STATUS_LED_MAP,
      log: (m) => logs.push(m),
      probe: async () => ({ ok: true }),
      // The green channel is broken; red has already been driven high by then.
      write: async (pin, high) => {
        writes.push(`${pin}=${high ? 1 : 0}`);
        return pin !== 21;
      },
    });
    await driver.init();
    const failures = (): string[] => logs.filter((m) => m.includes("failed"));
    await driver.set("white");
    expect(writes.slice(-3)).toEqual(["12=0", "21=0", "16=0"]);
    expect(failures()).toHaveLength(1);

    // Logged once, not once per write and not once per call.
    await driver.set("white");
    expect(failures()).toHaveLength(1);
  });

  it("aborts a running pattern on a write failure", async () => {
    let fail = false;
    const writes: string[] = [];
    const driver = new LedDriver({
      map: STATUS_LED_MAP,
      log: () => {},
      probe: async () => ({ ok: true }),
      write: async (pin, high) => {
        writes.push(`${pin}=${high ? 1 : 0}`);
        return !fail;
      },
    });
    await driver.init();
    const running = driver.play("green", "blink-fast");
    await new Promise((r) => setTimeout(r, 60));
    fail = true;
    await running; // resolves because the failure cancelled the pattern
    const after = writes.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(writes.length).toBe(after); // nothing kept toggling
    expect(writes.slice(-3)).toEqual(triple("off"));
  });

  it("survives a writer that throws", async () => {
    const driver = new LedDriver({
      map: STATUS_LED_MAP,
      log: () => {},
      probe: async () => ({ ok: true }),
      write: async () => {
        throw new Error("pinctrl exploded");
      },
    });
    await driver.init();
    await expect(driver.set("red")).resolves.toBeUndefined();
  });
});

describe("self-gating off-device", () => {
  it("is inert and writes nothing when the probe fails", async () => {
    const writes: string[] = [];
    const driver = new LedDriver({
      map: STATUS_LED_MAP,
      log: () => {},
      probe: async () => ({ ok: false, reason: "not a Raspberry Pi" }),
      write: async (pin) => {
        writes.push(String(pin));
        return true;
      },
    });
    const init = await driver.init();
    expect(init.ok).toBe(false);
    expect(driver.available).toBe(false);
    await driver.set("red");
    await driver.play("white", "flash2");
    await driver.blank();
    expect(writes).toEqual([]);
  });

  it("logs the resolved map exactly once", async () => {
    const logs: string[] = [];
    const driver = new LedDriver({
      map: STATUS_LED_MAP,
      log: (m) => logs.push(m),
      probe: async () => ({ ok: true }),
      write: async () => true,
    });
    await driver.init();
    await driver.init();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("r=GPIO12");
    expect(logs[0]).toContain("g=GPIO21");
    expect(logs[0]).toContain("b=GPIO16");
  });
});
