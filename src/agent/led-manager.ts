/**
 * RGB status LED — the moving parts around the pure policy.
 *
 * Split of responsibility:
 *   lib/led-state.ts    decides WHAT to show (pure, no clocks)
 *   hardware/led.ts     knows HOW to show it (pinctrl)
 *   this file           when to ask, and what to do about time
 *
 * Everything time-based lives here precisely so `resolveLedState` can stay pure:
 * the "config applied" overlay and the re-render-on-change latch.
 *
 * No pollers, no subprocesses, no extra reads — `tick()` is called from the
 * worker's existing 1 Hz loop with snapshots it already holds.
 */
import { LedDriver } from "../hardware/led.js";
import { resolveLedState, rung, type LedSignals, type LedState } from "../lib/led-state.js";

export interface LedManagerOptions {
  /** Signals pulled on each tick. Must not do I/O — pass what the worker holds. */
  signals: () => LedSignals;
  /** Injected in tests. */
  driver?: LedDriver;
  log?: (msg: string) => void;
}

export class LedManager {
  private readonly driver: LedDriver;
  private readonly signals: () => LedSignals;
  private readonly log: (msg: string) => void;

  private current: LedState | null = null;
  private overlayRunning = false;
  private stopped = false;

  constructor(opts: LedManagerOptions) {
    this.driver = opts.driver ?? new LedDriver();
    this.signals = opts.signals;
    this.log = opts.log ?? ((msg) => console.log(`[led] ${msg}`));
  }

  get available(): boolean {
    return this.driver.available;
  }

  /**
   * Probe the hardware. When the driver is inert (dev box, missing pinctrl, a
   * pin held by another driver) every method below is a silent no-op and the
   * agent is unaffected — the same posture as the IMU collector with no BNO085.
   */
  async start(): Promise<void> {
    const init = await this.driver.init();
    if (!init.ok) {
      this.log(`inert: ${init.reason}`);
      return;
    }
    // Something is lit from the moment we take over, so the gap between
    // ExecStartPre's white and the first tick is never mistaken for unpowered.
    this.render(rung("starting"));
  }

  /** Called from the worker's 1 Hz loop. Re-renders only on a real change. */
  tick(): void {
    if (this.stopped || !this.driver.available) return;
    // The overlay owns the LED until its flashes finish; a state change during
    // it is picked up by the re-render that follows.
    if (this.overlayRunning) return;
    let next: LedState;
    try {
      next = resolveLedState(this.signals());
    } catch (err) {
      // Fail open (README principle 1): a signal-gathering bug must not light
      // red and must not take the worker down with it.
      this.log(`signal read failed, holding: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.render(next);
  }

  /**
   * Two white flashes acknowledging an applied config / accepted command.
   * Pre-empts whatever is showing, then snaps back.
   *
   * The plan called this "a 2 s overlay". It is implemented as *exactly the two
   * flashes* (~0.5 s) followed by an immediate return to the resolved state,
   * because holding the slot for a further 1.5 s would leave the LED dark — and
   * with no other visible indicator on the enclosure, dark is indistinguishable
   * from unpowered (plan §2). Acknowledging is not worth going dark for.
   */
  configApplied(): void {
    if (this.stopped || !this.driver.available || this.overlayRunning) return;
    this.overlayRunning = true;
    const { colour, pattern } = rung("config-applied");
    void this.driver
      .play(colour, pattern)
      .catch(() => {})
      .finally(() => {
        this.overlayRunning = false;
        this.current = null; // force a re-render even if the state is unchanged
        if (!this.stopped) this.tick();
      });
  }

  /**
   * Blank on shutdown. Best-effort and deliberately not awaited by the worker's
   * synchronous shutdown() — systemd's `ExecStopPost=xorgate led exit-state` is
   * the actual guarantee, and it also knows whether we crashed.
   */
  stop(): void {
    this.stopped = true;
    this.driver.stop();
    void this.driver.blank().catch(() => {});
  }

  private render(next: LedState): void {
    if (
      this.current &&
      this.current.colour === next.colour &&
      this.current.pattern === next.pattern
    ) {
      return; // already showing it; restarting the pattern would stutter it
    }
    const from = this.current?.reason ?? "none";
    this.current = next;
    this.log(`${from} → ${next.reason} (${next.colour} ${next.pattern})`);
    // Not awaited: play() only resolves when the pattern ends or is superseded,
    // which for every repeating rung is never.
    void this.driver.play(next.colour, next.pattern).catch(() => {});
  }
}
