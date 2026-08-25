import { describe, expect, it } from "vitest";
import contract from "./config-contract.json";
import { RECORDING_DEFAULTS } from "../src/recording/config.js";
import { TIME_SYNC_DEFAULTS } from "../src/agent/clock-step.js";
import { videoPresetNames, DEFAULT_VIDEO_PRESET } from "../src/recording/video-presets.js";
import { parseRecordingSettings, parseTimeSyncSettings } from "../src/daemon/settings.js";
import { CONFIG_APPLY_CLASSES } from "../src/agent/config-sync.js";

/**
 * Contract test against `config-contract.json` — the artifact the CLOUD's
 * config registry generates (backend/xorgate-core-service:
 * `npm run contract:generate`, which rewrites this copy) and the web app
 * imports for its defaults.
 *
 * Test-only: no runtime code in this repo reads the artifact. The agent keeps
 * its own independent, tolerant parser — clamp-don't-reject is correct on a
 * device, which must never brick on a config document. What this test enforces
 * is that the two ends agree about the things they MUST agree about:
 *
 *   1. defaults — the cloud UI renders them for an unconfigured device, so a
 *      mismatch means the web app shows something the device is not doing;
 *   2. the preset table — a closed set on both sides;
 *   3. clamp vs bounds — the cloud REJECTS out-of-range values while the device
 *      CLAMPS them. That only stays coherent while the device's clamp range
 *      CONTAINS the cloud's accepted range: anything the cloud can deliver must
 *      pass through the device parser unchanged. (The reverse is fine and
 *      intended — the device tolerates more than the cloud will send.)
 *
 * When this fails, fix the side that is wrong and re-run
 * `npm run contract:generate` in the backend; do not edit the JSON by hand.
 */

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  enum?: string[];
  minimum?: number;
  maximum?: number;
};

const recording = contract.namespaces.recording;
const recordingSchema = recording.jsonSchema as JsonSchema;

function bounds(path: string[]): { minimum: number; maximum: number } {
  let node: JsonSchema = recordingSchema;
  for (const key of path) {
    node = node.properties?.[key] as JsonSchema;
    expect(node, `contract is missing recording.${path.join(".")}`).toBeDefined();
  }
  expect(node.minimum, `recording.${path.join(".")} has no minimum`).toBeTypeOf("number");
  expect(node.maximum, `recording.${path.join(".")} has no maximum`).toBeTypeOf("number");
  return { minimum: node.minimum as number, maximum: node.maximum as number };
}

/** Build a `recording` value carrying one leaf, then read it back post-clamp. */
function roundTrip(path: string[], value: number): number | undefined {
  const body: Record<string, unknown> = {};
  let node = body;
  for (const key of path.slice(0, -1)) {
    node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
  const parsed = parseRecordingSettings(body) as Record<string, unknown> | undefined;
  let out: unknown = parsed;
  for (const key of path) {
    out = (out as Record<string, unknown> | undefined)?.[key];
  }
  return out as number | undefined;
}

describe("config contract: the agent matches the cloud registry", () => {
  it("is the artifact version this test understands", () => {
    expect(contract.version).toBe(1);
    // The retained config message the worker parses (`v` must be 1).
    expect(contract.wireVersion).toBe(1);
  });

  it("declares exactly the namespaces the worker applies", () => {
    // No `agent` namespace: `mode` is reported-only and `mediaEnabled` is not a
    // cloud setting (design Q4). If one appears here, the worker needs to learn
    // about it.
    expect(Object.keys(contract.namespaces).sort()).toEqual([
      "cameraMount",
      "cellular",
      "gnssAntBias",
      "imuMount",
      "lteRecovery",
      "recording",
      "timeSync",
    ]);
  });

  it("RECORDING_DEFAULTS match the published defaults", () => {
    expect(RECORDING_DEFAULTS).toEqual(recording.defaults);
  });

  it("TIME_SYNC_DEFAULTS match the published defaults", () => {
    expect(TIME_SYNC_DEFAULTS).toEqual(contract.namespaces.timeSync.defaults);
  });

  it("the preset table is the same closed set", () => {
    const published = (
      recordingSchema.properties?.video?.properties?.preset as JsonSchema
    ).enum;
    expect(published?.slice().sort()).toEqual(videoPresetNames().slice().sort());
    expect(published).toContain(DEFAULT_VIDEO_PRESET);
    expect(DEFAULT_VIDEO_PRESET).toBe(RECORDING_DEFAULTS.video.preset);
  });

  it("gnssAntBias default matches the hardware-safe state", () => {
    expect(contract.namespaces.gnssAntBias.defaults).toBe(false);
  });

  it("imuMount default is the no-correction identity", () => {
    expect(contract.namespaces.imuMount.defaults).toEqual({
      enabled: false,
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: 0,
    });
  });

  // The whole point of the clamp/reject asymmetry: every value the cloud is
  // willing to send must survive the device parser untouched.
  it.each([
    ["telemetry.rateHz", ["telemetry", "rateHz"]],
    ["video.segmentSeconds", ["video", "segmentSeconds"]],
    ["video.bootDeferMaxSecs", ["video", "bootDeferMaxSecs"]],
    ["video.bootDeferMinBudgetMa", ["video", "bootDeferMinBudgetMa"]],
    ["video.gpsGateMaxSecs", ["video", "gpsGateMaxSecs"]],
    ["video.gpsGateNoProgressSecs", ["video", "gpsGateNoProgressSecs"]],
    ["video.spawnStaggerSecs", ["video", "spawnStaggerSecs"]],
    ["powerShedding.uvSamples", ["powerShedding", "uvSamples"]],
    ["powerShedding.uvWindowSecs", ["powerShedding", "uvWindowSecs"]],
    ["powerShedding.railLowSecs", ["powerShedding", "railLowSecs"]],
    ["powerShedding.escalateDwellSecs", ["powerShedding", "escalateDwellSecs"]],
    ["powerShedding.escalateDutyPct", ["powerShedding", "escalateDutyPct"]],
    ["powerShedding.restoreSecs", ["powerShedding", "restoreSecs"]],
    ["powerShedding.maxShedsPerHour", ["powerShedding", "maxShedsPerHour"]],
    ["powerShedding.railLowVolts", ["powerShedding", "railLowVolts"]],
    ["powerShedding.railRestoreVolts", ["powerShedding", "railRestoreVolts"]],
    ["powerShedding.cpuTempC", ["powerShedding", "cpuTempC"]],
    ["powerShedding.cpuTempRestoreC", ["powerShedding", "cpuTempRestoreC"]],
    ["powerShedding.cpuTempSecs", ["powerShedding", "cpuTempSecs"]],
  ])("%s: the device clamp range contains the cloud bounds", (_label, path) => {
    const { minimum, maximum } = bounds(path as string[]);
    expect(roundTrip(path as string[], minimum)).toBe(minimum);
    expect(roundTrip(path as string[], maximum)).toBe(maximum);
  });

  it("timeSync bounds survive the device parser too", () => {
    const schema = contract.namespaces.timeSync.jsonSchema as JsonSchema;
    for (const key of ["stepThresholdSecs", "maxStepsPerBoot"] as const) {
      const node = schema.properties?.[key] as JsonSchema;
      for (const v of [node.minimum as number, node.maximum as number]) {
        expect(parseTimeSyncSettings({ [key]: v })).toEqual({ [key]: v });
      }
    }
  });

  it("the thermal-arm keys the cloud can send are accepted by the device", () => {
    // These three were delivered for two releases while missing from the
    // cloud's own type, docs and CLI allowlist. The contract now pins them.
    const shed = (recordingSchema.properties?.powerShedding as JsonSchema).properties!;
    expect(Object.keys(shed)).toEqual(expect.arrayContaining([
      "cpuTempC",
      "cpuTempRestoreC",
      "cpuTempSecs",
    ]));
    const value = { powerShedding: { cpuTempC: 82, cpuTempRestoreC: 73, cpuTempSecs: 20 } };
    expect(parseRecordingSettings(value)).toEqual(value);
  });

  // The reported plane (Phase 3) tells the cloud HOW a namespace reaches the
  // hardware, so the cloud can say whether "saved" already means "in force".
  // That only means anything while both ends classify the namespaces the same
  // way — and the agent's map is what a namespace added cloud-side has to pass
  // through before the worker can honestly report on it.
  it("the agent's apply classes match the published ones", () => {
    const published = Object.fromEntries(
      Object.entries(contract.namespaces).map(([key, ns]) => [key, ns.applyClass]),
    );
    expect(CONFIG_APPLY_CLASSES).toEqual(published);
  });
});
