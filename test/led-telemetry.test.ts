/**
 * LED state in telemetry (plans/include-led-status-in-telemetry, P1):
 * the frozen code table + bitmask, the encoder over every rung and
 * representative flag mixes, the live-payload merge, and the recorder path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  HEALTH_FLAG_BITS,
  LED_LADDER,
  LED_STATE_CODES,
  encodeLedTelemetry,
  resolveLedState,
  rung,
  type LedSignals,
} from "../src/lib/led-state.js";
import {
  LED_TELEMETRY_SIM,
  LED_TELEMETRY_STARTING,
  withLedLeaves,
  withLedSampleGroups,
} from "../src/agent/led-telemetry.js";
import type { RecordingStatus, TelemetryMetrics } from "../src/agent/telemetry.js";
import type { GroupSample } from "../src/agent/collectors/index.js";
import { TelemetryRecorder } from "../src/recording/telemetry-recorder.js";
import type { SegmentHeader } from "../src/recording/segments.js";
import { cleanup, tempHome } from "./helpers.js";

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

function rec(over: Partial<RecordingStatus>): RecordingStatus {
  return { ...RECORDING, ...over };
}
function block(reason: string): Partial<RecordingStatus> {
  return { liveBlock: { reason, detail: "", since: 0 } as never };
}

/** Resolve + encode, the way LedManager.telemetry() does. */
const encode = (s: LedSignals) => encodeLedTelemetry(resolveLedState(s), s);

const F = HEALTH_FLAG_BITS;

describe("frozen contract tables", () => {
  it("codes are severity-ascending and exactly the agreed numbers", () => {
    expect(LED_STATE_CODES).toEqual({
      healthy: 0,
      starting: 1,
      "gps-wait": 2,
      network: 3,
      thermal: 4,
      undervoltage: 5,
      "agent-down": 6,
    });
  });

  it("covers every ladder state; the config-applied overlay has no code", () => {
    for (const r of LED_LADDER) {
      if (r.reason === "config-applied") expect(LED_STATE_CODES[r.reason]).toBeUndefined();
      else expect(typeof LED_STATE_CODES[r.reason]).toBe("number");
    }
  });

  it("flag bits are exactly the agreed masks", () => {
    expect(F).toEqual({
      undervoltage: 1,
      thermal: 2,
      lte_down: 4,
      mqtt_down: 8,
      gps_no_fix: 16,
      gps_gate_hold: 32,
      dead_zone: 64,
      power_shed: 128,
      live_block: 256,
    });
  });
});

describe("encodeLedTelemetry — one case per rung", () => {
  it("healthy → 0 / 0", () => {
    expect(encode(healthy())).toEqual({ led_state: 0, health_flags: 0 });
  });

  it("starting → 1 (flags still describe the inputs)", () => {
    expect(encode(healthy({ starting: true }))).toEqual({ led_state: 1, health_flags: 0 });
    expect(encode(healthy({ starting: true, connection: "connecting" }))).toEqual({
      led_state: 1,
      health_flags: F.mqtt_down,
    });
  });

  it("gps-wait from an unfixed receiver → 2 + gps_no_fix", () => {
    expect(encode(healthy({ gnss: { fix: false, sky: "open" } }))).toEqual({
      led_state: 2,
      health_flags: F.gps_no_fix,
    });
  });

  it("gps-wait from the GPS gate → 2 + gps_gate_hold + live_block", () => {
    expect(encode(healthy({ recording: rec(block("gps-gate")) }))).toEqual({
      led_state: 2,
      health_flags: F.gps_gate_hold | F.live_block,
    });
  });

  it("network from LTE disconnected / connecting → 3 + lte_down", () => {
    for (const status of ["disconnected", "connecting"]) {
      expect(encode(healthy({ lte: { status } }))).toEqual({ led_state: 3, health_flags: F.lte_down });
    }
  });

  it("network from the cloud link alone → 3 + mqtt_down", () => {
    for (const connection of ["connecting", "reconnecting", "closed", "error"] as const) {
      expect(encode(healthy({ connection }))).toEqual({ led_state: 3, health_flags: F.mqtt_down });
    }
  });

  it("thermal → 4 + thermal + live_block, and the shed it carries", () => {
    expect(encode(healthy({ recording: rec(block("thermal")) }))).toEqual({
      led_state: 4,
      health_flags: F.thermal | F.live_block,
    });
    expect(encode(healthy({ recording: rec({ ...block("thermal"), powerShed: "no-live" }) }))).toEqual({
      led_state: 4,
      health_flags: F.thermal | F.live_block | F.power_shed,
    });
  });

  it("undervoltage from the verdict → 5 + undervoltage + live_block", () => {
    expect(encode(healthy({ recording: rec(block("undervoltage")) }))).toEqual({
      led_state: 5,
      health_flags: F.undervoltage | F.live_block,
    });
  });

  it("undervoltage from a bare power shed → 5 + power_shed only", () => {
    expect(encode(healthy({ recording: rec({ powerShed: "no-live" }) }))).toEqual({
      led_state: 5,
      health_flags: F.power_shed,
    });
  });

  it("agent-down encodes as 6 (reserved: never resolved in-process)", () => {
    expect(encodeLedTelemetry({ ...rung("agent-down") }, healthy()).led_state).toBe(6);
  });
});

describe("encodeLedTelemetry — concurrent conditions", () => {
  it("a network outage masks an unfixed GPS in the code, not in the flags", () => {
    expect(
      encode(healthy({ connection: "reconnecting", lte: { status: "disconnected" }, gnss: { fix: false, sky: "open" } })),
    ).toEqual({ led_state: 3, health_flags: F.lte_down | F.mqtt_down | F.gps_no_fix });
  });

  it("a power shed on a GPS-gated device shows red; the gate stays visible in flags", () => {
    expect(
      encode(healthy({ recording: rec({ ...block("gps-gate"), powerShed: "no-live" }), gnss: { fix: false, sky: "open" } })),
    ).toEqual({
      led_state: 5,
      health_flags: F.gps_gate_hold | F.live_block | F.power_shed | F.gps_no_fix,
    });
  });

  it("a dead zone is green with the cloud down; both facts are flagged", () => {
    expect(encode(healthy({ connection: "closed", lte: { status: "dead_zone" } }))).toEqual({
      led_state: 0,
      health_flags: F.dead_zone | F.mqtt_down,
    });
  });

  it("an unknown liveBlock reason sets only live_block and stays green", () => {
    expect(encode(healthy({ recording: rec(block("kvs-master-failed")) }))).toEqual({
      led_state: 0,
      health_flags: F.live_block,
    });
  });

  it("no receiver (gnss null) and an unreadable LTE file are clear, not faults", () => {
    expect(encode(healthy({ gnss: null, lte: null }))).toEqual({ led_state: 0, health_flags: 0 });
  });

  it("every flag at once", () => {
    // undervoltage + thermal cannot both be the liveBlock reason, so assert the
    // rest of the mask and each verdict separately.
    const t = encode(
      healthy({
        connection: "closed",
        lte: { status: "connecting" },
        gnss: { fix: false, sky: "blocked" as never },
        recording: rec({ ...block("thermal"), powerShed: "parked:no-live" }),
      }),
    );
    expect(t).toEqual({
      led_state: 4,
      health_flags: F.thermal | F.lte_down | F.mqtt_down | F.gps_no_fix | F.power_shed | F.live_block,
    });
  });

  it("an unknown reason encodes as 0 (fail open)", () => {
    expect(encodeLedTelemetry({ colour: "green", pattern: "heartbeat", reason: "nope" }, healthy()).led_state).toBe(0);
  });
});

describe("live payload merge (withLedLeaves)", () => {
  const metrics: Partial<TelemetryMetrics> = {
    system: {
      cpu_usage: { value: 12.3, unit: "%" },
      cpu_temp: { value: 61.2, unit: "°C" },
      ram_usage: { value: 40, unit: "%" },
      disk_usage: { value: 50, unit: "%" },
      throttled: { value: 0 },
    },
    gps: { fix_quality: { value: 1 } } as never,
  };

  it("adds both leaves to system, unit-less like system.throttled", () => {
    const out = withLedLeaves(metrics, { led_state: 3, health_flags: 12 });
    expect(out.system?.led_state).toEqual({ value: 3 });
    expect(out.system?.health_flags).toEqual({ value: 12 });
    expect(out.system?.cpu_usage).toEqual({ value: 12.3, unit: "%" });
    expect(out.gps).toBe(metrics.gps);
    // Numbers only — a string leaf rejects the whole cloud frame.
    const json = JSON.parse(JSON.stringify(out)) as { system: Record<string, { value: unknown }> };
    expect(typeof json.system.led_state.value).toBe("number");
    expect(typeof json.system.health_flags.value).toBe("number");
    expect("unit" in json.system.led_state).toBe(false);
  });

  it("never mutates the collector's object", () => {
    withLedLeaves(metrics, { led_state: 0, health_flags: 0 });
    expect(metrics.system).not.toHaveProperty("led_state");
  });

  it("creates the system group when the collector produced none", () => {
    expect(withLedLeaves({}, LED_TELEMETRY_STARTING).system).toEqual({
      led_state: { value: 1 },
      health_flags: { value: 0 },
    });
  });

  it("replay (null) passes recorded system.* through untouched", () => {
    const recorded = { system: { ...metrics.system!, led_state: { value: 4 }, health_flags: { value: 2 } } };
    expect(withLedLeaves(recorded, null)).toBe(recorded);
  });

  it("the simulator is healthy", () => {
    expect(withLedLeaves({}, LED_TELEMETRY_SIM).system).toEqual({
      led_state: { value: 0 },
      health_flags: { value: 0 },
    });
  });
});

describe("recorder path (withLedSampleGroups)", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup(home);
  });

  it("keeps the system sample's freshness stamp and copies, never mutates", () => {
    const sys: GroupSample = { fields: { cpu_usage: { value: 1, unit: "%" } }, updatedMono: 7n };
    const out = withLedSampleGroups({ system: sys }, { led_state: 2, health_flags: 16 });
    expect(out.system.updatedMono).toBe(7n);
    expect(out.system.fields).toEqual({
      cpu_usage: { value: 1, unit: "%" },
      led_state: { value: 2 },
      health_flags: { value: 16 },
    });
    expect(sys.fields).not.toHaveProperty("led_state");
    const groups = { system: sys };
    expect(withLedSampleGroups(groups, null)).toBe(groups);
  });

  it("every recorded system line carries both leaves at the 1 Hz system cadence", async () => {
    const dir = join(home, "recordings", "telemetry", "session-x");
    const header = (): SegmentHeader => ({
      type: "header",
      v: 1,
      deviceId: "dev-1",
      sessionId: "session-x",
      bootId: "boot-1",
      timeSource: "ntp",
      rateHz: 10,
      startedAt: Date.now(),
    });
    let mono = 0n;
    let state = { led_state: 0, health_flags: 0 };
    const recorder = new TelemetryRecorder({
      rateHz: 10,
      // The system collector refreshes ~1/s; imu every call.
      sampleGroups: async () => {
        mono += 1n;
        const sysMono = BigInt(Math.floor(Date.now() / 1000));
        return withLedSampleGroups(
          {
            imu: { fields: { a: { value: Number(mono) } }, updatedMono: mono },
            system: { fields: { cpu_usage: { value: 5, unit: "%" } }, updatedMono: sysMono },
          },
          state,
        );
      },
      timeSource: { current: () => "ntp", refresh: async () => "ntp" },
      monoMs: () => Date.now(),
      writer: { dir, header, maxAgeMs: 3_600_000 },
    });

    for (let i = 0; i < 30; i++) {
      if (i === 5) state = { led_state: 3, health_flags: 8 };
      await recorder.tick();
      vi.setSystemTime(10_000 + (i + 1) * 100);
    }
    recorder.stop();

    const gz = readdirSync(dir).filter((n) => n.endsWith(".jsonl.gz"));
    expect(gz).toHaveLength(1);
    const lines = gunzipSync(readFileSync(join(dir, gz[0])))
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { metrics?: Record<string, Record<string, { value: number }>> });
    const systemLines = lines.filter((l) => l.metrics?.system).map((l) => l.metrics!.system);
    // 3 s of ticks → one system sample per second.
    expect(systemLines).toHaveLength(3);
    for (const s of systemLines) {
      expect(typeof s.led_state.value).toBe("number");
      expect(typeof s.health_flags.value).toBe("number");
      expect(s.cpu_usage.value).toBe(5);
    }
    expect(systemLines.map((s) => [s.led_state.value, s.health_flags.value])).toEqual([
      [0, 0],
      [3, 8],
      [3, 8],
    ]);
  });
});
