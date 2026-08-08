/**
 * RGB status LED — channel driver.
 *
 * Drives the Argus carrier's user-facing RGB LED: colour + pattern in, three
 * GPIO writes out. This file is a RENDERER only — it decides nothing about what
 * the device is doing. The state ladder and its wiring into the agent are
 * Phase 2 (see plans/rgb_led_events).
 *
 * Like the rest of the HAL it shells out (`pinctrl set <pin> op dh|dl`, ~1 ms a
 * call, measured); there is deliberately no GPIO binding or native module.
 * `pinctrl` needs no root — do NOT add sudo here, the agent itself runs as the
 * provisioning user (`pi`), not root.
 */
import { commandExists, run } from "../lib/exec.js";
import { isMock, isRaspberryPi } from "../lib/platform.js";

/**
 * Argus CM5 Rev1 carrier. HARDCODED deliberately (see plans/rgb_led_events
 * §Scope): the device-model-driven pin map is a separate, later plan. When it
 * lands this becomes the fallback default and nothing downstream changes.
 *
 * Active high — `1` = LED on (board guide Rev B, I/O and Interface Table).
 * GPIO16/21 were reserved by the voiceHAT audio overlay until Phase 0; see
 * docs/audio-i2s.md before re-enabling any audio overlay.
 */
const STATUS_LED_PINS = { r: 12, g: 21, b: 16 } as const;
const ACTIVE_HIGH = true;

/** Highest BCM line on the RP1 (gpiochip0 reports 54 lines: 0–53). */
const MAX_GPIO = 53;

/**
 * The one seam the deferred device-model work replaces. Only the *source* of
 * this value changes then — every consumer below takes it as a parameter.
 */
export interface LedPinMap {
  /** Wiring topology. Only "rgb-gpio" (three plain GPIOs) is implemented. */
  kind: string;
  pins: { r: number; g: number; b: number };
  /** `true` = driving the pin high lights the channel. */
  activeHigh: boolean;
}

export const STATUS_LED_MAP: LedPinMap = {
  kind: "rgb-gpio",
  pins: { ...STATUS_LED_PINS },
  activeHigh: ACTIVE_HIGH,
};

/**
 * The six colours measured as distinguishable on real hardware, plus `off`.
 *
 * `yellow` (r+g) is deliberately absent: the red die is weak on this package, so
 * r+g reads as "yellowish, leaning green" and cannot be identified on its own.
 * Do not add it back — this was judged by eye on the bench LED.
 */
export type LedColour = "red" | "green" | "blue" | "purple" | "cyan" | "white" | "off";

export interface LedChannels {
  r: boolean;
  g: boolean;
  b: boolean;
}

/** red 100 · green 010 · blue 001 · purple 101 · cyan 011 · white 111 */
export const LED_COLOURS: Record<LedColour, LedChannels> = {
  off: { r: false, g: false, b: false },
  red: { r: true, g: false, b: false },
  green: { r: false, g: true, b: false },
  blue: { r: false, g: false, b: true },
  purple: { r: true, g: false, b: true },
  cyan: { r: false, g: true, b: true },
  white: { r: true, g: true, b: true },
};

export const LED_COLOUR_NAMES = Object.keys(LED_COLOURS) as LedColour[];

export function isLedColour(v: string): v is LedColour {
  return Object.prototype.hasOwnProperty.call(LED_COLOURS, v);
}

export type LedPattern =
  | "solid"
  | "blink-fast" // ~4 Hz, 50% duty
  | "blink-slow" // ~1 Hz, 50% duty
  | "heartbeat" // double-pulse, then dark for the rest of a 5.5 s cycle
  | "flash2"; // 2 quick flashes then done (the 2 s overlay)

export const LED_PATTERN_NAMES: LedPattern[] = [
  "solid",
  "blink-fast",
  "blink-slow",
  "heartbeat",
  "flash2",
];

export function isLedPattern(v: string): v is LedPattern {
  return (LED_PATTERN_NAMES as string[]).includes(v);
}

/** One leg of a pattern. `ms: 0` means "hold here until stopped" (terminal). */
export interface LedStep {
  on: boolean;
  ms: number;
}

export interface LedTimeline {
  steps: LedStep[];
  /** Loop the steps forever. A non-repeating timeline blanks when it ends. */
  repeat: boolean;
}

/**
 * Pure: pattern → the on/off timeline it should produce. Timings are named here
 * rather than inlined in the runner so the ladder stays reviewable in one place.
 */
export function ledTimeline(pattern: LedPattern): LedTimeline {
  switch (pattern) {
    case "solid":
      return { steps: [{ on: true, ms: 0 }], repeat: false };
    case "blink-fast":
      return {
        steps: [
          { on: true, ms: 125 },
          { on: false, ms: 125 },
        ],
        repeat: true,
      };
    case "blink-slow":
      return {
        steps: [
          { on: true, ms: 500 },
          { on: false, ms: 500 },
        ],
        repeat: true,
      };
    case "heartbeat":
      return {
        steps: [
          { on: true, ms: 120 },
          { on: false, ms: 180 },
          { on: true, ms: 120 },
          { on: false, ms: 5080 },
        ],
        repeat: true,
      };
    case "flash2":
      return {
        steps: [
          { on: true, ms: 150 },
          { on: false, ms: 200 },
          { on: true, ms: 150 },
        ],
        repeat: false,
      };
  }
}

export interface PinMapCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate the map even though it is hardcoded (plan §6). `busyPins` comes from
 * `gpioinfo` — refusing a line that already has a gpiod consumer is exactly the
 * check that would have caught the GPIO16 `sdmode` case in Phase 0 by itself.
 */
export function validatePinMap(map: LedPinMap, busyPins: readonly number[] = []): PinMapCheck {
  if (map.kind !== "rgb-gpio") {
    return { ok: false, reason: `unimplemented LED kind '${map.kind}'` };
  }
  const entries = Object.entries(map.pins) as [keyof LedPinMap["pins"], number][];
  for (const [ch, pin] of entries) {
    if (!Number.isInteger(pin) || pin < 0 || pin > MAX_GPIO) {
      return { ok: false, reason: `${ch} pin ${pin} is outside the RP1 range 0–${MAX_GPIO}` };
    }
  }
  const pins = entries.map(([, pin]) => pin);
  if (new Set(pins).size !== pins.length) {
    return { ok: false, reason: `pins ${pins.join(",")} are not distinct` };
  }
  const busy = entries.filter(([, pin]) => busyPins.includes(pin));
  if (busy.length > 0) {
    const list = busy.map(([ch, pin]) => `${ch}=GPIO${pin}`).join(", ");
    return { ok: false, reason: `${list} already held by another driver (gpioinfo: [used])` };
  }
  return { ok: true };
}

/**
 * Pure: BCM lines that `gpioinfo` reports as `[used]`, i.e. claimed by a kernel
 * driver or another process. Lines look like:
 *   `line  16:  "GPIO16"  "sdmode"  output  active-high  [used]`
 */
export function parseBusyPins(gpioinfoOutput: string): number[] {
  const busy: number[] = [];
  for (const line of gpioinfoOutput.split("\n")) {
    if (!line.includes("[used]")) continue;
    const m = /^\s*line\s+(\d+):/.exec(line);
    if (m) busy.push(Number(m[1]));
  }
  return busy;
}

/**
 * Drives one or more lines to the SAME level in a single call. Resolves `false`
 * on any failure — never throws.
 *
 * Batched deliberately: every call is a process spawn, and `blink-fast` runs 8
 * transitions a second forever. Writing per-channel made a two-channel colour
 * (purple, cyan) cost 16 spawns/s — measured at ~3.7% of one core on the bench,
 * and worst exactly when the device is already in trouble, since the fast
 * blinks are the fault states. `pinctrl` takes a pin list, so a transition is
 * now one spawn (two only when some channels rise while others fall).
 */
export type PinWriter = (pins: readonly number[], high: boolean) => Promise<boolean>;

export const pinctrlWriter: PinWriter = async (pins, high) => {
  if (pins.length === 0) return true;
  const res = await run("pinctrl", ["set", pins.join(","), "op", high ? "dh" : "dl"], {
    timeoutMs: 2000,
  });
  return !res.failed;
};

export interface LedDriverOptions {
  map?: LedPinMap;
  /** Injected in tests so writes can be recorded without hardware. */
  write?: PinWriter;
  log?: (msg: string) => void;
  /** Injected in tests; defaults to probing the host for pinctrl/gpioinfo. */
  probe?: () => Promise<PinMapCheck>;
}

export interface LedInit extends PinMapCheck {
  map: LedPinMap;
}

/**
 * Colour + pattern → pins.
 *
 * Two rules are load-bearing:
 *  - **Fail safe, not fail-lit.** A frozen LED actively lies, which is worse
 *    than a dark one, so any write failure blanks all three channels.
 *  - **Self-gating.** Off a Pi, without `pinctrl`, or with an invalid map, the
 *    driver goes inert and every call is a silent no-op. Nothing else breaks.
 */
export class LedDriver {
  readonly map: LedPinMap;
  private readonly write: PinWriter;
  private readonly log: (msg: string) => void;
  private readonly probe: () => Promise<PinMapCheck>;

  private ready = false;
  private initialised = false;
  private loggedFailure = false;
  /** Bumped by stop()/set() so an in-flight pattern knows it was superseded. */
  private generation = 0;
  private wake: (() => void) | null = null;
  /** Last levels we know we wrote; null = unknown, write everything. */
  private lastLevels: LedChannels | null = null;

  constructor(opts: LedDriverOptions = {}) {
    this.map = opts.map ?? STATUS_LED_MAP;
    this.write = opts.write ?? pinctrlWriter;
    this.log = opts.log ?? ((msg) => console.error(`[led] ${msg}`));
    this.probe = opts.probe ?? (() => probeHost(this.map));
  }

  /** True once init() has found a usable map and toolchain. */
  get available(): boolean {
    return this.ready;
  }

  /**
   * Validate the map, probe the host, and log the resolved map once — a wrong
   * map should be visible in the journal rather than silent. Going inert is not
   * logged here: it is routine off-device, and the caller gets `reason` to
   * report in whatever way suits it.
   */
  async init(): Promise<LedInit> {
    if (this.initialised) return { ok: this.ready, map: this.map };
    this.initialised = true;
    const check = await this.probe();
    this.ready = check.ok;
    if (check.ok) {
      const { r, g, b } = this.map.pins;
      this.log(
        `${this.map.kind} r=GPIO${r} g=GPIO${g} b=GPIO${b} ` +
          `(active ${this.map.activeHigh ? "high" : "low"})`,
      );
    }
    return { ...check, map: this.map };
  }

  /** Show a colour and hold it. Cancels any running pattern. */
  async set(colour: LedColour): Promise<void> {
    this.stop();
    await this.apply(colour);
  }

  /**
   * Drive every channel low. Safe to call when inert or already dark.
   *
   * `quiet` suppresses the write-failure log. Use it on the shutdown path: that
   * blank is best-effort and races `process.exit`, so a killed `pinctrl` child
   * is the EXPECTED outcome, not a fault — logging it would put an alarming
   * "pin write failed" line in the journal on every single restart.
   */
  async blank(opts: { quiet?: boolean } = {}): Promise<void> {
    this.stop();
    await this.apply("off", opts.quiet === true);
  }

  /** Cancel a running pattern. Leaves the LED wherever the pattern left it. */
  stop(): void {
    this.generation++;
    // Every new colour/pattern starts from "levels unknown", so the first write
    // of a state always drives all three pins even if we think one matches.
    this.lastLevels = null;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /**
   * Run `pattern` in `colour`. Resolves when the pattern finishes (`flash2`),
   * or when stop() is called — repeating patterns and `solid` never finish on
   * their own, so the caller stays in control of the lifetime.
   */
  async play(colour: LedColour, pattern: LedPattern): Promise<void> {
    this.stop();
    const gen = this.generation;
    const { steps, repeat } = ledTimeline(pattern);
    do {
      for (const step of steps) {
        if (gen !== this.generation) return;
        await this.apply(step.on ? colour : "off");
        if (gen !== this.generation) return;
        await this.sleep(step.ms, gen);
      }
    } while (repeat && gen === this.generation);
    // A non-repeating timeline whose last step held indefinitely (`solid`) has
    // already been cancelled by stop(); anything else ends dark rather than
    // latched on its final flash.
    if (gen === this.generation) await this.apply("off");
  }

  /** Write one colour to the three channels, blanking on any failure. */
  private async apply(colour: LedColour, quiet = false): Promise<void> {
    if (!this.ready) return;
    const want = LED_COLOURS[colour];

    // Two reductions, both about process spawns rather than GPIO cost:
    //
    //  1. Skip channels already at the wanted level. The cache is dropped on
    //     every stop() (i.e. every new colour/pattern), so it only elides
    //     toggles WITHIN one running pattern; anything that moves the pins
    //     behind our back is corrected by the next state change.
    //  2. Batch what remains by target level, so a transition is ONE spawn
    //     instead of one per channel.
    const last = this.lastLevels;
    const rise: number[] = [];
    const fall: number[] = [];
    for (const ch of ["r", "g", "b"] as const) {
      if (last && last[ch] === want[ch]) continue;
      (want[ch] ? rise : fall).push(this.map.pins[ch]);
    }

    const ok = (await this.writeGroup(rise, true)) && (await this.writeGroup(fall, false));
    if (ok) {
      this.lastLevels = { ...want };
      return;
    }
    this.lastLevels = null; // the pins are in an unknown state; trust nothing

    // Fail safe: a half-written colour is a lie. Stop, dark, log once. All
    // three go low in one call, cache ignored — we no longer know their state.
    this.generation++;
    this.wake?.();
    this.wake = null;
    await this.writeGroup([this.map.pins.r, this.map.pins.g, this.map.pins.b], false);
    if (!quiet && !this.loggedFailure) {
      this.loggedFailure = true;
      this.log("pin write failed — LED blanked (further failures not logged)");
    }
  }

  /** Drive a set of channels to one lit/dark state. No pins = nothing to do. */
  private async writeGroup(pins: readonly number[], lit: boolean): Promise<boolean> {
    if (pins.length === 0) return true;
    try {
      return await this.write(pins, this.map.activeHigh ? lit : !lit);
    } catch {
      return false;
    }
  }

  /** Cancellable sleep. `ms: 0` waits forever, i.e. until stop(). */
  private sleep(ms: number, gen: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (gen !== this.generation) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        if (this.wake === finish) this.wake = null;
        resolve();
      };
      this.wake = finish;
      if (ms > 0) timer = setTimeout(finish, ms);
    });
  }
}

/** Host probe: right board, tools present, map free. Never throws. */
async function probeHost(map: LedPinMap): Promise<PinMapCheck> {
  const shape = validatePinMap(map);
  if (!shape.ok) return shape;
  if (isMock()) return { ok: false, reason: "mock mode (XORGATE_MOCK)" };
  if (!isRaspberryPi()) return { ok: false, reason: "not a Raspberry Pi" };
  if (!(await commandExists("pinctrl"))) return { ok: false, reason: "pinctrl is not installed" };
  // gpioinfo is optional: when it is missing we simply skip the busy check
  // rather than refusing to drive an LED that is probably fine.
  if (await commandExists("gpioinfo")) {
    const res = await run("gpioinfo", ["gpiochip0"], { timeoutMs: 2000 });
    if (!res.failed) return validatePinMap(map, parseBusyPins(res.stdout));
  }
  return { ok: true };
}
