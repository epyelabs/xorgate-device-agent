/**
 * `xorgate led …` — drive the RGB status LED by hand.
 *
 * Phase 1 of plans/rgb_led_events is a MANUAL INSTRUMENT only: no policy, no
 * agent state, no systemd hooks. Its reason to exist is `xorgate led test`,
 * which walks the whole ladder printing each label — the LED can only be judged
 * by eye (the cameras face outward), so this turns a dozen round-trips with the
 * person in front of the box into a single pass.
 *
 * `pinctrl` needs no root; do NOT add sudo here (the agent does not run as root
 * either — the installer's 10-user.conf drop-in overrides `User=root`).
 */
import {
  isLedColour,
  isLedPattern,
  LED_COLOUR_NAMES,
  LED_PATTERN_NAMES,
  LedDriver,
  type LedColour,
  type LedPattern,
} from "../hardware/led.js";
import { LED_LADDER, rung } from "../lib/led-state.js";

/**
 * How long to hold rungs that need more than the default to judge, keyed by
 * machine reason. `healthy` needs to repeat — the point of the heartbeat is
 * that it is dark ~95% of the time, and one cycle alone does not show that.
 */
const HOLD_OVERRIDES: Record<string, number> = {
  healthy: 12_000,
  "config-applied": 2_500,
};

const HOLD_MS = 4000;
const GAP_MS = 700;

export async function ledCommand(rest: string[]): Promise<void> {
  const pos = rest.filter((a) => !a.startsWith("-"));
  const sub = pos[0];

  if (!sub || sub === "help") {
    usage();
    return;
  }
  const isHook = sub === "boot" || sub === "exit-state";
  if (sub !== "test" && !isHook && !isLedColour(sub)) {
    console.error(`unknown colour or subcommand '${sub}'`);
    usage();
    process.exitCode = 1;
    return;
  }
  if (sub !== "test" && !isHook && pos[1] !== undefined && !isLedPattern(pos[1])) {
    console.error(`unknown pattern '${pos[1]}'`);
    usage();
    process.exitCode = 1;
    return;
  }

  const driver = new LedDriver({ log: (msg) => console.error(`[led] ${msg}`) });
  const init = await driver.init();
  if (!init.ok) {
    // Off-device this is normal, not an error: exit 0 so the same command line
    // is harmless on a dev box.
    console.log(`led: inert — ${init.reason}; nothing to drive`);
    return;
  }

  // A pattern only exists while this process does, so hand the LED back dark on
  // any signalled exit. SIGKILL cannot be caught — the accepted gap.
  const shutdown = (): void => {
    driver.stop();
    void driver.blank().finally(() => process.exit(0));
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, shutdown);

  if (sub === "test") {
    await walkLadder(driver);
    return;
  }
  if (isHook) {
    await runHook(driver, sub);
    return;
  }

  const colour = sub;
  const pattern: LedPattern = (pos[1] as LedPattern | undefined) ?? "solid";
  if (colour === "off") {
    await driver.blank();
    console.log("led: off");
    return;
  }
  if (pattern === "solid") {
    // Latched on purpose: `xorgate led red` is for walking over and looking at
    // it. `xorgate led off` puts it back.
    await driver.set(colour);
    console.log(`led: ${colour} solid — stays on until 'xorgate led off'`);
    return;
  }
  console.log(
    pattern === "flash2"
      ? `led: ${colour} flash2 — two flashes, then dark`
      : `led: ${colour} ${pattern} — Ctrl-C to stop (goes dark on exit)`,
  );
  await driver.play(colour, pattern);
  await driver.blank();
}

/**
 * systemd lifecycle hooks. `$SERVICE_RESULT` already distinguishes a deliberate
 * stop from a crash, so neither of these guesses at anything.
 *
 * These run as the service user (`pi`), not root — the installer's 10-user.conf
 * drop-in overrides the unit's `User=root`. `pinctrl` needs no sudo.
 */
async function runHook(driver: LedDriver, hook: "boot" | "exit-state"): Promise<void> {
  if (hook === "boot") {
    // ExecStartPre: something is lit from the moment systemd starts us, so the
    // window before LedManager takes over is never mistaken for "unpowered".
    await driver.set(rung("starting").colour);
    console.log("led: boot (white)");
    return;
  }

  // ExecStopPost. `success` covers `systemctl stop`/`restart` and machine
  // reboot — our SIGTERM path exits 0 — and is NOT a fault. Everything else
  // (exit-code, signal, core-dump, watchdog, timeout) is a crash, and solid red
  // is correct to latch: Restart=always retries, and once StartLimitBurst is
  // exhausted systemd gives up with the LED still red.
  const result = process.env.SERVICE_RESULT ?? "success";
  if (result === "success") {
    await driver.blank();
    console.log("led: off (clean stop)");
    return;
  }
  await driver.set(rung("agent-down").colour);
  console.log(`led: red solid (SERVICE_RESULT=${result})`);
}

/** Show every rung long enough to judge, with a dark gap between them. */
async function walkLadder(driver: LedDriver): Promise<void> {
  console.log("Walking the LED ladder — watch the device.\n");
  for (const state of LED_LADDER) {
    console.log(`  [${state.pri}] ${pad(`${state.colour} ${state.pattern}`)} ${state.label}`);
    await show(driver, state.colour, state.pattern, HOLD_OVERRIDES[state.reason] ?? HOLD_MS);
    await driver.blank();
    await delay(GAP_MS);
  }
  await driver.blank();
  console.log("\nDone — LED is dark.");
}

/** Run one pattern for `ms`, then cancel it and wait for the runner to unwind. */
async function show(
  driver: LedDriver,
  colour: LedColour,
  pattern: LedPattern,
  ms: number,
): Promise<void> {
  const running = driver.play(colour, pattern);
  await delay(ms);
  driver.stop();
  await running;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(s: string): string {
  return s.padEnd(18);
}

function usage(): void {
  console.log(`usage: xorgate led <colour> [pattern] | led off | led test

  <colour>   ${LED_COLOUR_NAMES.filter((c) => c !== "off").join(" | ")}
             (no yellow/amber: r+g reads as green on this LED and cannot be
             told apart from it — measured, not assumed)
  [pattern]  ${LED_PATTERN_NAMES.join(" | ")}   (default: solid)

  led off    turn the LED off
  led test   walk every state in the status ladder, printing each label —
             this is the one to run with someone watching the device

  led boot        systemd ExecStartPre hook — white while the agent comes up
  led exit-state  systemd ExecStopPost hook — blank on a clean stop, solid red
                  on a crash (reads $SERVICE_RESULT)

  'solid' stays lit after the command exits; every other pattern lasts as long
  as the process (Ctrl-C leaves the LED dark). No settings, no cloud, no policy:
  this is a manual instrument.

Examples:
  xorgate led purple blink-fast
  xorgate led white
  xorgate led test`);
}
