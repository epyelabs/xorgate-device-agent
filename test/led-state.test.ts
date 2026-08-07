/**
 * LED policy — one test per ladder rung, the precedence cases, and the
 * fail-open cases. Pure: no hardware, no clocks.
 */
import { describe, expect, it } from "vitest";
import { LED_LADDER, resolveLedState, rung, type LedSignals } from "../src/lib/led-state.js";
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

/** A device with nothing wrong: connected, LTE up, GPS fixed, no liveBlock. */
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

function block(reason: string): Partial<LedSignals> {
  return {
    recording: { ...RECORDING, liveBlock: { reason, detail: "", since: 0 } as never },
  };
}

describe("the ladder table", () => {
  it("has no rung 3 — data loss is deferred, not silently dropped", () => {
    expect(LED_LADDER.map((r) => r.pri)).toEqual(["0", "1", "2", "4", "5", "6", "7", "—"]);
    expect(LED_LADDER.some((r) => r.reason === "data-loss")).toBe(false);
  });

  it("uses only colours the hardware can actually distinguish", () => {
    for (const r of LED_LADDER) {
      expect(["red", "green", "blue", "purple", "cyan", "white"]).toContain(r.colour);
    }
  });

  it("gives every rung a unique reason and a human label", () => {
    const reasons = LED_LADDER.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const r of LED_LADDER) expect(r.label.length).toBeGreaterThan(0);
  });
});

describe("each rung", () => {
  it("0 — starting: white solid", () => {
    expect(resolveLedState(healthy({ starting: true }))).toMatchObject({
      colour: "white",
      pattern: "solid",
      reason: "starting",
    });
  });

  it("1 — agent-down is systemd's to render, never resolved here", () => {
    expect(rung("agent-down")).toMatchObject({ colour: "red", pattern: "solid" });
    // No combination of live signals may produce it: the agent is running.
    const combos: LedSignals[] = [
      healthy(),
      healthy(block("undervoltage")),
      healthy(block("thermal")),
      healthy({ connection: "closed" }),
      healthy({ gnss: { fix: false, sky: "open" } }),
    ];
    for (const s of combos) expect(resolveLedState(s).reason).not.toBe("agent-down");
  });

  it("2 — undervoltage: red blink-fast", () => {
    expect(resolveLedState(healthy(block("undervoltage")))).toMatchObject({
      colour: "red",
      pattern: "blink-fast",
      reason: "undervoltage",
    });
  });

  it("2 — a powerShed rung is a power fault even with no liveBlock", () => {
    const s = healthy({ recording: { ...RECORDING, powerShed: "no-live" } });
    expect(resolveLedState(s).reason).toBe("undervoltage");
    const parked = healthy({ recording: { ...RECORDING, powerShed: "parked:bridge-only" } });
    expect(resolveLedState(parked).reason).toBe("undervoltage");
  });

  it("4 — thermal: cyan blink-slow, milder than power by design", () => {
    expect(resolveLedState(healthy(block("thermal")))).toMatchObject({
      colour: "cyan",
      pattern: "blink-slow",
      reason: "thermal",
    });
  });

  it("5 — network: purple blink-fast for a trying-and-failing modem", () => {
    for (const status of ["disconnected", "connecting"]) {
      expect(resolveLedState(healthy({ lte: { status } })).reason).toBe("network");
    }
  });

  it("5 — network: a down cloud link counts even with LTE connected", () => {
    for (const connection of ["connecting", "reconnecting", "closed", "error"] as const) {
      expect(resolveLedState(healthy({ connection })).reason).toBe("network");
    }
  });

  it("6 — gps-wait: blue blink-slow when the receiver has no fix", () => {
    expect(resolveLedState(healthy({ gnss: { fix: false, sky: "open" } }))).toMatchObject({
      colour: "blue",
      pattern: "blink-slow",
      reason: "gps-wait",
    });
  });

  it("6 — gps-wait also covers the boot video gate", () => {
    expect(resolveLedState(healthy(block("gps-gate"))).reason).toBe("gps-wait");
  });

  it("7 — healthy: green heartbeat", () => {
    expect(resolveLedState(healthy())).toMatchObject({
      colour: "green",
      pattern: "heartbeat",
      reason: "healthy",
    });
  });
});

describe("precedence — first match wins", () => {
  it("power beats thermal, network and gps together", () => {
    const s = healthy({
      ...block("undervoltage"),
      connection: "closed",
      lte: { status: "disconnected" },
      gnss: { fix: false, sky: "open" },
    });
    expect(resolveLedState(s).reason).toBe("undervoltage");
  });

  it("thermal beats network and gps", () => {
    const s = healthy({
      ...block("thermal"),
      connection: "closed",
      gnss: { fix: false, sky: "open" },
    });
    expect(resolveLedState(s).reason).toBe("thermal");
  });

  it("network beats gps", () => {
    const s = healthy({ connection: "closed", gnss: { fix: false, sky: "open" } });
    expect(resolveLedState(s).reason).toBe("network");
  });

  it("starting beats everything, including a power fault", () => {
    const s = healthy({ ...block("undervoltage"), starting: true });
    expect(resolveLedState(s).reason).toBe("starting");
  });
});

describe("folded into green on purpose", () => {
  it("a declared dead zone is settled, not a fault", () => {
    expect(resolveLedState(healthy({ lte: { status: "dead_zone" } })).reason).toBe("healthy");
  });

  it("a dead zone ALSO suppresses the cloud-link clause", () => {
    // In a dead zone the cloud link is necessarily down. If `connection` alone
    // could light purple, "dead zone is green" would be a rule that never holds
    // — boot-policy.ts releases the video gate on `dead_zone` exactly because
    // the agent treats it as resolved, and the LED must not disagree.
    const s = healthy({ lte: { status: "dead_zone" }, connection: "closed" });
    expect(resolveLedState(s).reason).toBe("healthy");
  });

  it("recording vs idle is not distinguished", () => {
    const idle = healthy({ recording: { ...RECORDING, enabled: false, sessionId: null } });
    expect(resolveLedState(idle).reason).toBe("healthy");
  });

  it("an upload backlog is healthy — it is working, not failing", () => {
    const s = healthy({
      recording: { ...RECORDING, backlogSegments: 400, backlogBytes: 9e8, uploading: true },
    });
    expect(resolveLedState(s).reason).toBe("healthy");
  });

  it("historical dropped segments do NOT light the LED (rung 3 deferred)", () => {
    // The counter is lifetime and only an operator can zero it, so consuming it
    // would latch a permanent false alarm. See the phase-2 plan file.
    const s = healthy({ recording: { ...RECORDING, droppedSegments: 5000 } });
    expect(resolveLedState(s).reason).toBe("healthy");
  });
});

describe("fail open — unknown never means fault", () => {
  it("null LTE is unavailable, not down", () => {
    expect(resolveLedState(healthy({ lte: null })).reason).toBe("healthy");
  });

  it("null GNSS is no receiver, not 'no fix'", () => {
    expect(resolveLedState(healthy({ gnss: null })).reason).toBe("healthy");
  });

  it("an absent liveBlock means live is allowed", () => {
    const s = healthy();
    expect(s.recording.liveBlock).toBeUndefined();
    expect(resolveLedState(s).reason).toBe("healthy");
  });

  it("an unrecognised liveBlock reason degrades to healthy, not to red", () => {
    // liveBlock.reason is an OPEN SET by contract — a newer device against an
    // older build is normal, and guessing at severity is how the LED lies.
    expect(resolveLedState(healthy(block("kvs-master-failed"))).reason).toBe("healthy");
    expect(resolveLedState(healthy(block("decommissioned"))).reason).toBe("healthy");
  });

  it("a malformed liveBlock is ignored rather than trusted", () => {
    const s = healthy({
      recording: { ...RECORDING, liveBlock: { reason: 42 } as never },
    });
    expect(resolveLedState(s).reason).toBe("healthy");
  });

  it("a malformed lte block is ignored rather than trusted", () => {
    expect(resolveLedState(healthy({ lte: { status: undefined } })).reason).toBe("healthy");
    expect(resolveLedState(healthy({ lte: {} })).reason).toBe("healthy");
  });

  it("an unknown lte status is not a fault", () => {
    expect(resolveLedState(healthy({ lte: { status: "wedged-somehow" } })).reason).toBe("healthy");
  });
});
