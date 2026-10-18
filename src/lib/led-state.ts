/**
 * RGB status LED — the policy, as one pure function.
 *
 * **The LED is a renderer, not a policy engine.** Every condition below is
 * already computed and already published by the module that owns it; this file
 * only ranks them. That is enforced doctrine, not a preference —
 * `plans/done/power_management_improvements/README.md` §Principles:
 *
 *   > 5. One choke point. Live-stream parking flows through the single boolean
 *   > in `manager.ts`. Do not add a second control path.
 *
 * and at the site itself in `src/recording/manager.ts`: *"A second evaluation
 * anywhere else is how the reason and the reality come apart."* If the ladder
 * ever needs a fact nobody publishes, compute it once in the owning module and
 * publish it — never work it out here.
 *
 * Pure by contract: no I/O, no clocks, no randomness, so every rung is unit
 * testable with no hardware. The 2 s "config applied" overlay is deliberately
 * NOT here — it is time-based, so `LedManager` owns it.
 */
import type { ConnectionState, RecordingStatus } from "../agent/telemetry.js";
import type { GnssView } from "./sky-state.js";
import type { LedColour, LedPattern } from "../hardware/led.js";

export interface LedSignals {
  /** Cloud link, from StateStore. */
  connection: ConnectionState;
  /** `recording.status()` — carries liveBlock and powerShed. */
  recording: RecordingStatus;
  /** `/run/sim7600-lte/telemetry.json`. `null` = unavailable, NOT down. */
  lte: { status?: string } | null;
  /** `source.gnssView()`. `null` = no receiver, NOT "no fix". */
  gnss: GnssView | null;
  /** Agent still coming up — before real state exists. */
  starting: boolean;
}

export interface LedState {
  colour: LedColour;
  pattern: LedPattern;
  /** Stable machine reason; also the key into LED_LADDER. */
  reason: string;
}

export interface LedRung extends LedState {
  /** Priority as written in the plan's ladder table. */
  pri: string;
  /** Human label — drives `xorgate led test` and the Phase 3 legend card. */
  label: string;
}

/**
 * The agreed ladder (plan §5), in the order `xorgate led test` walks it. This is
 * the SINGLE definition: `resolveLedState` returns rungs from here and the CLI
 * walks the same array, so the two can never drift.
 *
 * Rung 3 (red blink-slow, "data loss") is deliberately absent — `droppedSegments`
 * is a lifetime counter, so consuming it would latch the LED into a permanent
 * false alarm. Deferred until DiskManager publishes an "evicting now" verdict;
 * see plans/rgb_led_events/phase-2-policy-and-wiring.md.
 */
export const LED_LADDER: readonly LedRung[] = [
  {
    pri: "0",
    reason: "starting",
    label: "Starting up (no real state yet)",
    colour: "white",
    pattern: "solid",
  },
  {
    pri: "1",
    reason: "agent-down",
    label: "Agent not running",
    colour: "red",
    pattern: "solid",
  },
  {
    pri: "2",
    reason: "undervoltage",
    label: "Power fault — undervoltage / shedding",
    colour: "red",
    pattern: "blink-fast",
  },
  {
    pri: "4",
    reason: "thermal",
    label: "Running hot — thermal shed, still recording",
    colour: "cyan",
    pattern: "blink-slow",
  },
  {
    pri: "5",
    reason: "network",
    label: "Network trouble — LTE/cloud down, recovering",
    colour: "purple",
    pattern: "blink-fast",
  },
  {
    pri: "6",
    reason: "gps-wait",
    label: "Waiting for a GPS fix",
    colour: "blue",
    pattern: "blink-slow",
  },
  {
    pri: "7",
    reason: "healthy",
    label: "Healthy",
    colour: "green",
    pattern: "heartbeat",
  },
  {
    pri: "—",
    reason: "config-applied",
    label: "Settings applied / command accepted",
    colour: "white",
    pattern: "flash2",
  },
];

const BY_REASON = new Map(LED_LADDER.map((r) => [r.reason, r]));

/** Look a rung up by machine reason. Throws only on a typo in this file. */
export function rung(reason: string): LedRung {
  const found = BY_REASON.get(reason);
  if (!found) throw new Error(`no LED ladder rung for reason '${reason}'`);
  return found;
}

function state(reason: string): LedState {
  const { colour, pattern } = rung(reason);
  return { colour, pattern, reason };
}

/**
 * Strict priority, first match wins.
 *
 * Every unknown resolves toward *fine* (README principle 1, fail open). A stale
 * feed, a missing collector or a `liveBlock.reason` this build has never heard
 * of must never light red: an LED crying wolf on missing information is worse
 * than the problem the rule was written about.
 */
export function resolveLedState(s: LedSignals): LedState {
  if (s.starting) return state("starting");

  // `liveBlock` is ABSENT (never null, never {}) whenever live is allowed, and
  // its `reason` is an OPEN SET by contract — parse it as a plain string and
  // ignore values we do not recognise rather than guessing at severity.
  const block = s.recording?.liveBlock;
  const blockReason = typeof block?.reason === "string" ? block.reason : null;

  // Rungs 2 and 4 — power vs thermal.
  //
  // `liveBlock.reason` is the ADJUDICATED verdict and is consulted first, both
  // of them, before `powerShed` is considered at all. That ordering is
  // load-bearing: a thermal shed sets `powerShed` ("no-live") exactly like a
  // power shed does, because both walk the same ladder. Treating any
  // `powerShed` as a power fault therefore painted real thermal events red —
  // observed on the bench, `liveBlock.reason: "thermal"` with
  // `powerShed: "no-live"` lighting rung 2 — which defeats the whole reason the
  // two are different colours (plan §5: "so no one has to time a blink to know
  // which repair to make"). Sending someone to check the PSU of an overheating
  // box is worse than saying nothing.
  if (blockReason === "undervoltage") return state("undervoltage");

  // Rung 4 — thermal. Milder than power by design: shedding caps at rung 1 and
  // never stops recording, which is why it is cyan rather than red.
  if (blockReason === "thermal") return state("thermal");

  // A shed with no verdict explaining it: nothing has claimed the cause, and
  // power is both the likelier one and the more urgent to get wrong in the
  // safe direction.
  if (typeof s.recording?.powerShed === "string") return state("undervoltage");

  // Rung 5 — network.
  //
  // `dead_zone` is a SETTLED verdict, not a fault: boot-policy.ts releases the
  // video gate on daemon status `connected` OR `dead_zone`, so the agent already
  // treats it as resolved and the LED must not disagree (plan §4). It therefore
  // suppresses the cloud-link clause as well — in a declared dead zone the cloud
  // link is necessarily down, and lighting purple for that would make "dead zone
  // is green" a rule that never actually holds.
  const lteStatus = typeof s.lte?.status === "string" ? s.lte.status : null;
  if (lteStatus !== "dead_zone") {
    const lteTrying = lteStatus === "disconnected" || lteStatus === "connecting";
    // `lte: null` means the telemetry file is unavailable, NOT that the modem is
    // down — fail open and let the cloud-link clause speak for itself.
    const cloudDown = s.connection !== "connected";
    if (lteTrying || cloudDown) return state("network");
  }

  // Rung 6 — waiting on the sky. `gnss: null` means no receiver at all, which is
  // not "no fix yet"; only a receiver that is present and unfixed waits in blue.
  if (blockReason === "gps-gate" || (s.gnss !== null && s.gnss.fix === false)) {
    return state("gps-wait");
  }

  return state("healthy");
}

// ---------------------------------------------------------------------------
// Telemetry encoding (plans/include-led-status-in-telemetry, D2/D3).
//
// FROZEN CONTRACT: the core service, @xorgate/react, xorgate-web, alocate-web
// and alocate-mobile all decode these two numbers. Never renumber; only append.
//
// RUST-PORT: telemetry type seam — `system.led_state` / `system.health_flags`
// were added after the parity pin (JS 89b5c64); port with the js-to-rust
// catch-up, alongside the Phase 4 LED manager.
// ---------------------------------------------------------------------------

/**
 * `system.led_state` — a SEVERITY-ASCENDING code, deliberately NOT the ladder's
 * `pri` numbering (which is precedence, descending). Ascending means `max` is
 * the right bucket aggregate ("worst state in the bucket") and `> 0` means
 * "struggling", the same convention as `lte.gnss_health`.
 *
 * Keyed by `LedState.reason`. `config-applied` is absent on purpose: it is a
 * ~0.5 s overlay, not a state, and telemetry reports the state underneath it.
 * `agent-down` (6) is reserved — painted by systemd after a crash, so the agent
 * can never observe itself in it; the cloud may synthesise it.
 */
export const LED_STATE_CODES: Readonly<Record<string, number>> = Object.freeze({
  healthy: 0,
  starting: 1,
  "gps-wait": 2,
  network: 3,
  thermal: 4,
  undervoltage: 5,
  "agent-down": 6,
});

/**
 * `system.health_flags` — bitmask of the RAW inputs the ladder sees, so the
 * conditions a first-match-wins ladder collapses stay visible (a network outage
 * hides an unfixed GPS; a power shed hides the GPS gate). Several bits may be
 * set while `led_state` shows only one state. Values are the bit's mask.
 */
export const HEALTH_FLAG_BITS = Object.freeze({
  /** `recording.liveBlock.reason === "undervoltage"`. */
  undervoltage: 1 << 0,
  /** `recording.liveBlock.reason === "thermal"`. */
  thermal: 1 << 1,
  /** LTE daemon status `disconnected` or `connecting`. */
  lte_down: 1 << 2,
  /** Cloud (MQTT) link not `connected`. */
  mqtt_down: 1 << 3,
  /** GNSS receiver present and without a fix (`gnss: null` = no receiver = clear). */
  gps_no_fix: 1 << 4,
  /** `recording.liveBlock.reason === "gps-gate"`. */
  gps_gate_hold: 1 << 5,
  /** LTE daemon status `dead_zone` (a settled verdict: suppresses the network rung). */
  dead_zone: 1 << 6,
  /** `recording.powerShed` is set (any stage, any cause). */
  power_shed: 1 << 7,
  /** `recording.liveBlock` is present (any reason, including ones we do not know). */
  live_block: 1 << 8,
} as const);

export interface LedTelemetry {
  led_state: number;
  health_flags: number;
}

/**
 * Encode a resolved state plus the signals it was resolved from as the two
 * numeric telemetry leaves. Pure. The flags are read from the same inputs the
 * ladder consumed — no new facts are derived here (see the doctrine at the top
 * of this file).
 *
 * An unknown reason (only possible via a typo or a future rung this build does
 * not know) encodes as 0 — fail open, like the ladder itself.
 */
export function encodeLedTelemetry(state: LedState, s: LedSignals): LedTelemetry {
  const led_state = LED_STATE_CODES[state.reason] ?? 0;

  const block = s.recording?.liveBlock;
  const blockReason = typeof block?.reason === "string" ? block.reason : null;
  const lteStatus = typeof s.lte?.status === "string" ? s.lte.status : null;

  let flags = 0;
  if (blockReason === "undervoltage") flags |= HEALTH_FLAG_BITS.undervoltage;
  if (blockReason === "thermal") flags |= HEALTH_FLAG_BITS.thermal;
  if (lteStatus === "disconnected" || lteStatus === "connecting") flags |= HEALTH_FLAG_BITS.lte_down;
  if (s.connection !== "connected") flags |= HEALTH_FLAG_BITS.mqtt_down;
  if (s.gnss != null && s.gnss.fix === false) flags |= HEALTH_FLAG_BITS.gps_no_fix;
  if (blockReason === "gps-gate") flags |= HEALTH_FLAG_BITS.gps_gate_hold;
  if (lteStatus === "dead_zone") flags |= HEALTH_FLAG_BITS.dead_zone;
  if (typeof s.recording?.powerShed === "string") flags |= HEALTH_FLAG_BITS.power_shed;
  if (block != null && typeof block === "object") flags |= HEALTH_FLAG_BITS.live_block;

  return { led_state, health_flags: flags };
}
