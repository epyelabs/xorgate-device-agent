import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildConfigReport,
  buildEffective,
  buildStatus,
  CONFIG_APPLY_CLASSES,
  ConfigSync,
  configSyncPath,
  loadConfigSyncState,
  readModemBias,
  saveConfigSyncState,
  shouldApplyRev,
  type ConfigReport,
  type DesiredSnapshot,
  type ModemBiasSample,
} from "../src/agent/config-sync.js";
import { parseCloudMessage } from "../src/agent/cloud-config.js";
import { settingsPath } from "../src/daemon/settings.js";
import { cleanup, delay, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const FRESH: ModemBiasSample = { value: true, fresh: true };
const NO_MODEM: ModemBiasSample = { value: null, fresh: false, detail: "modem telemetry unavailable" };

/** Build a desired snapshot the way the worker does: from a real wire message. */
function desiredFrom(message: Record<string, unknown>): DesiredSnapshot {
  const parsed = parseCloudMessage(JSON.stringify({ v: 1, ...message }));
  if (parsed === null) throw new Error("test message did not parse");
  return { rev: parsed.config.rev ?? 0, raw: parsed.raw, parsed: parsed.config };
}

describe("config-sync.json state file", () => {
  it("round-trips and defaults to zeros when absent", () => {
    expect(loadConfigSyncState()).toEqual({ lastAppliedRev: 0, lastReportTs: 0 });
    expect(saveConfigSyncState({ lastAppliedRev: 42, lastReportTs: 1700 })).toBe(true);
    expect(loadConfigSyncState()).toEqual({ lastAppliedRev: 42, lastReportTs: 1700 });
  });

  it("treats a corrupt or mistyped file as never-applied", () => {
    writeFileSync(configSyncPath(), "{not json");
    expect(loadConfigSyncState()).toEqual({ lastAppliedRev: 0, lastReportTs: 0 });
    writeFileSync(configSyncPath(), JSON.stringify({ lastAppliedRev: "12" }));
    expect(loadConfigSyncState()).toEqual({ lastAppliedRev: 0, lastReportTs: 0 });
  });

  it("lives beside settings.json, never inside it", () => {
    // The allowlist rewriter in daemon/settings.ts would destroy this state on
    // the next save by any writer, and the modem daemon greps settings.json.
    expect(configSyncPath()).toBe(join(home, "config-sync.json"));
    expect(configSyncPath()).not.toBe(settingsPath());
  });

  it("reports a failed persist instead of throwing", () => {
    // A directory that does not exist: an unwritable home must not be able to
    // break config delivery, only reset the rev guard.
    expect(
      saveConfigSyncState({ lastAppliedRev: 1, lastReportTs: 0 }, "/nope/does/not/exist.json"),
    ).toBe(false);
  });
});

describe("the rev guard", () => {
  it("always applies when the backend sends no rev (pre-Phase-2 compat)", () => {
    expect(shouldApplyRev(undefined, 0)).toBe(true);
    expect(shouldApplyRev(undefined, 99)).toBe(true);
    expect(shouldApplyRev(0, 99)).toBe(true);
  });

  it("applies a newer rev and skips one already applied", () => {
    expect(shouldApplyRev(43, 42)).toBe(true);
    expect(shouldApplyRev(42, 42)).toBe(false);
    expect(shouldApplyRev(41, 42)).toBe(false);
  });
});

describe("parseCloudMessage", () => {
  it("returns the raw document alongside the normalized config", () => {
    const msg = parseCloudMessage(
      JSON.stringify({ v: 1, rev: 7, gnssAntBias: true, recording: { telemetry: { rateHz: 999 } } }),
    );
    expect(msg?.config.rev).toBe(7);
    // Raw is what the cloud asked for; config is what the device will hold.
    expect((msg?.raw.recording as Record<string, unknown>)).toEqual({
      telemetry: { rateHz: 999 },
    });
    expect(msg?.config.recording).toEqual({ telemetry: { rateHz: 20 } });
  });

  it("ignores a non-positive or mistyped rev (treated as absent)", () => {
    expect(parseCloudMessage(JSON.stringify({ v: 1, rev: 0 }))?.config.rev).toBeUndefined();
    expect(parseCloudMessage(JSON.stringify({ v: 1, rev: "3" }))?.config.rev).toBeUndefined();
  });

  it("still rejects a non-v1 payload", () => {
    expect(parseCloudMessage(JSON.stringify({ v: 2, rev: 1 }))).toBeNull();
    expect(parseCloudMessage("[]")).toBeNull();
  });
});

describe("effective values", () => {
  it("omits namespaces the device is not holding (absent = device defaults)", () => {
    expect(buildEffective({}, NO_MODEM)).toEqual({});
  });

  it("sources gnssAntBias from the modem, not from settings.json", () => {
    // settings.json says the bias was REQUESTED on; the modem says it is off.
    // The reported value must be the applied one — that is the whole point.
    const effective = buildEffective({ gnssAntBias: true }, { value: false, fresh: true });
    expect(effective.gnssAntBias).toBe(false);
  });

  it("omits gnssAntBias entirely when the modem has never reported one", () => {
    expect(buildEffective({ gnssAntBias: true }, NO_MODEM)).not.toHaveProperty("gnssAntBias");
  });

  it("carries the other namespaces verbatim from settings.json", () => {
    const settings = {
      imuMount: { enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: 90 },
      recording: { video: { enabled: true } },
      timeSync: { offlineSources: true },
    };
    expect(buildEffective(settings, NO_MODEM)).toEqual(settings);
  });
});

describe("per-namespace status", () => {
  const at = 1_700_000_000_000;

  it("says nothing about namespaces the cloud never sent", () => {
    const desired = desiredFrom({ rev: 1, gnssAntBias: true });
    const status = buildStatus(desired, { gnssAntBias: true }, FRESH, at);
    expect(Object.keys(status)).toEqual(["gnssAntBias"]);
  });

  it("applied when the delivered value survived the parser and is in force", () => {
    const desired = desiredFrom({ rev: 1, timeSync: { offlineSources: true } });
    const status = buildStatus(desired, { timeSync: { offlineSources: true } }, NO_MODEM, at);
    expect(status.timeSync).toEqual({ state: "applied", at });
  });

  it("adjusted when the device clamped the delivered value", () => {
    const desired = desiredFrom({ rev: 1, recording: { telemetry: { rateHz: 999 } } });
    const status = buildStatus(
      desired,
      { recording: { telemetry: { rateHz: 20 } } },
      NO_MODEM,
      at,
    );
    expect(status.recording.state).toBe("adjusted");
    expect(status.recording.detail).toMatch(/clamped or normalized/);
  });

  it("adjusted when the device is holding something else (a local edit)", () => {
    const desired = desiredFrom({ rev: 1, timeSync: { offlineSources: true } });
    const status = buildStatus(desired, { timeSync: { offlineSources: false } }, NO_MODEM, at);
    expect(status.timeSync.state).toBe("adjusted");
    expect(status.timeSync.detail).toMatch(/changed locally/);
  });

  it("rejected when an object namespace parsed to nothing", () => {
    const desired = desiredFrom({ rev: 1, imuMount: { enabled: "yes" } });
    const status = buildStatus(desired, {}, NO_MODEM, at);
    expect(status.imuMount.state).toBe("rejected");
    expect(status.imuMount.reason).toMatch(/imuMount/);
  });

  it("rejected when a scalar namespace arrived with the wrong type", () => {
    const desired = desiredFrom({ rev: 1, gnssAntBias: "on" });
    const status = buildStatus(desired, {}, NO_MODEM, at);
    expect(status.gnssAntBias).toEqual({
      state: "rejected",
      at,
      reason: "gnssAntBias: not a valid boolean",
    });
  });

  it("explains a bias the modem has not applied yet", () => {
    const desired = desiredFrom({ rev: 1, gnssAntBias: true });
    // Fresh telemetry, but the daemon's ~30 s poll has not come round yet.
    const status = buildStatus(desired, { gnssAntBias: false }, { value: false, fresh: true }, at);
    expect(status.gnssAntBias.state).toBe("adjusted");
    expect(status.gnssAntBias.detail).toMatch(/has not applied it yet/);
  });

  it("explains a bias whose modem telemetry is missing or stale", () => {
    const desired = desiredFrom({ rev: 1, gnssAntBias: true });
    const status = buildStatus(desired, {}, NO_MODEM, at);
    expect(status.gnssAntBias.state).toBe("adjusted");
    expect(status.gnssAntBias.detail).toMatch(/modem telemetry unavailable/);
  });

  it("stays honest about latched boot state instead of claiming a clean applied", () => {
    const recording = { video: { enabled: true } };
    const desired = desiredFrom({ rev: 1, recording });
    const gated = buildStatus(desired, { recording }, NO_MODEM, at, { bootDefer: "gating" });
    expect(gated.recording.state).toBe("applied");
    expect(gated.recording.detail).toMatch(/GPS\/LTE gate/);

    const shed = buildStatus(desired, { recording }, NO_MODEM, at, { powerShed: "live-parked" });
    expect(shed.recording.detail).toMatch(/load shedding is active \(live-parked\)/);

    // A released gate is not a caveat — no detail at all.
    const released = buildStatus(desired, { recording }, NO_MODEM, at, {
      bootDefer: "released:connected",
    });
    expect(released.recording).toEqual({ state: "applied", at });
  });

  it("notes a clock stepper that stood down for the boot", () => {
    const timeSync = { offlineSources: true };
    const desired = desiredFrom({ rev: 1, timeSync });
    const status = buildStatus(desired, { timeSync }, NO_MODEM, at, { clockStepperArmed: false });
    expect(status.timeSync.detail).toMatch(/stood down for this boot/);
  });
});

describe("the report document", () => {
  it("matches the shape the mirror Lambda validates", () => {
    const report = buildConfigReport({
      deviceId: "dev-1",
      ts: 1234,
      origin: "cloud",
      lastAppliedRev: 9,
      settings: { recording: { video: { enabled: true } } },
      modem: FRESH,
      desired: desiredFrom({ rev: 9, recording: { video: { enabled: true } } }),
    });
    expect(report).toEqual({
      v: 1,
      deviceId: "dev-1",
      ts: 1234,
      rev: 9,
      origin: "cloud",
      effective: { gnssAntBias: true, recording: { video: { enabled: true } } },
      status: { recording: { state: "applied", at: 1234 } },
    });
  });

  it("reports rev 0 and an empty status when no desired doc has arrived", () => {
    const report = buildConfigReport({
      deviceId: "dev-1",
      ts: 1,
      origin: "boot",
      lastAppliedRev: 0,
      settings: {},
      modem: NO_MODEM,
      desired: null,
    });
    expect(report.rev).toBe(0);
    expect(report.status).toEqual({});
  });
});

describe("readModemBias", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  const file = (): string => join(home, "lte-telemetry.json");

  it("returns the applied bias from a fresh snapshot", async () => {
    writeFileSync(
      file(),
      JSON.stringify({ timestamp: "2026-08-06T11:59:40Z", gnss_ant_bias: 1 }),
    );
    expect(await readModemBias(now, file())).toEqual({ value: true, fresh: true });
  });

  it("marks a stale snapshot unfresh but keeps its last-known value", async () => {
    writeFileSync(
      file(),
      JSON.stringify({ timestamp: "2026-08-06T11:00:00Z", gnss_ant_bias: 0 }),
    );
    const sample = await readModemBias(now, file());
    expect(sample.value).toBe(false);
    expect(sample.fresh).toBe(false);
    expect(sample.detail).toMatch(/stale/);
  });

  it("degrades to unknown when the daemon has written nothing", async () => {
    expect(await readModemBias(now, join(home, "missing.json"))).toEqual({
      value: null,
      fresh: false,
      detail: "modem telemetry unavailable",
    });
  });

  it("degrades to unknown when the daemon has not asserted a bias yet", async () => {
    writeFileSync(
      file(),
      JSON.stringify({ timestamp: "2026-08-06T11:59:40Z", gnss_ant_bias: null }),
    );
    const sample = await readModemBias(now, file());
    expect(sample.value).toBeNull();
    expect(sample.fresh).toBe(false);
  });
});

describe("ConfigSync", () => {
  function harness(): { sync: ConfigSync; sent: ConfigReport[] } {
    const sent: ConfigReport[] = [];
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "xorgate/devices/dev-1/config/reported",
      publish: (_topic, payload) => sent.push(JSON.parse(payload) as ConfigReport),
      settings: () => ({ gnssAntBias: true }),
      modem: async () => FRESH,
      debounceMs: 1,
    });
    return { sync, sent };
  }

  it("coalesces a connect and the retained message that follows into one report", async () => {
    const { sync, sent } = harness();
    sync.request("boot");
    sync.request("cloud");
    sync.request("boot");
    await delay(30);
    expect(sent).toHaveLength(1);
    // `cloud` outranks `boot` — the cloud cares that this echoes an apply.
    expect(sent[0].origin).toBe("cloud");
    sync.stop();
  });

  it("publishes to the reported topic, unretained", async () => {
    const topics: { topic: string }[] = [];
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "xorgate/devices/dev-1/config/reported",
      publish: (topic) => topics.push({ topic }),
      settings: () => ({}),
      modem: async () => NO_MODEM,
      debounceMs: 1,
    });
    sync.request("boot");
    await delay(30);
    expect(topics).toEqual([{ topic: "xorgate/devices/dev-1/config/reported" }]);
    sync.stop();
  });

  it("advances and persists lastAppliedRev only for an applied document", () => {
    const { sync } = harness();
    const desired = desiredFrom({ rev: 5, gnssAntBias: true });
    expect(sync.shouldApply(5)).toBe(true);

    // An apply that threw: the doc is remembered for the report, the rev is not.
    sync.noteCloudConfig(5, desired.raw, desired.parsed, false);
    expect(sync.lastAppliedRev).toBe(0);

    sync.noteCloudConfig(5, desired.raw, desired.parsed, true);
    expect(sync.lastAppliedRev).toBe(5);
    expect(sync.shouldApply(5)).toBe(false);
    expect(sync.shouldApply(6)).toBe(true);
    // Survives a restart — a fresh instance reads the same file.
    expect(loadConfigSyncState().lastAppliedRev).toBe(5);
    sync.stop();
  });

  it("carries the last desired doc into the report even when the apply was skipped", async () => {
    const { sync, sent } = harness();
    const desired = desiredFrom({ rev: 3, gnssAntBias: true });
    sync.noteCloudConfig(3, desired.raw, desired.parsed, true);
    // Reconnect: the retained doc is redelivered, the guard skips the apply,
    // but the cloud still needs the verdict.
    sync.noteCloudConfig(3, desired.raw, desired.parsed, false);
    sync.request("cloud");
    await delay(30);
    expect(sent[0].rev).toBe(3);
    expect(sent[0].status.gnssAntBias).toEqual({ state: "applied", at: sent[0].ts });
    sync.stop();
  });

  it("re-reports a modem-poll namespace that has not settled yet", async () => {
    // The daemon applies the antenna bias on its own ~30 s poll, so the report
    // built at apply time necessarily reads "adjusted". Without this follow-up
    // the cloud would keep that verdict until the hourly heartbeat even though
    // the bias landed half a minute later (bench, 2026-08-06).
    const sent: ConfigReport[] = [];
    let biasApplied = false;
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "t",
      publish: (_t, payload) => sent.push(JSON.parse(payload) as ConfigReport),
      settings: () => ({ gnssAntBias: true }),
      // The modem catches up between the first report and the settle report.
      modem: async () => ({ value: biasApplied, fresh: true }),
      debounceMs: 1,
      settleMs: 5,
    });
    const desired = desiredFrom({ rev: 4, gnssAntBias: true });
    sync.noteCloudConfig(4, desired.raw, desired.parsed, true);
    sync.request("cloud");
    await delay(30);
    expect(sent[0].status.gnssAntBias.state).toBe("adjusted");

    biasApplied = true;
    await delay(60);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[sent.length - 1].status.gnssAntBias).toEqual({
      state: "applied",
      at: sent[sent.length - 1].ts,
    });
    sync.stop();
  });

  it("bounds the settle re-reports so a refused value cannot loop forever", async () => {
    const sent: ConfigReport[] = [];
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "t",
      publish: (_t, payload) => sent.push(JSON.parse(payload) as ConfigReport),
      settings: () => ({ gnssAntBias: true }),
      // Never settles: the modem keeps insisting the bias is off.
      modem: async () => ({ value: false, fresh: true }),
      debounceMs: 1,
      settleMs: 5,
      settleReports: 2,
    });
    const desired = desiredFrom({ rev: 4, gnssAntBias: true });
    sync.noteCloudConfig(4, desired.raw, desired.parsed, true);
    sync.request("cloud");
    await delay(120);
    // 1 apply report + at most 2 settle reports.
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent[sent.length - 1].status.gnssAntBias.state).toBe("adjusted");
    sync.stop();
  });

  it("does not re-report an agent-poll namespace that is merely divergent", async () => {
    // agent-poll namespaces are in force the instant settings.json is written,
    // so a difference there is a real divergence, not a settling window.
    const sent: ConfigReport[] = [];
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "t",
      publish: (_t, payload) => sent.push(JSON.parse(payload) as ConfigReport),
      settings: () => ({ timeSync: { offlineSources: false } }),
      modem: async () => NO_MODEM,
      debounceMs: 1,
      settleMs: 5,
    });
    const desired = desiredFrom({ rev: 4, timeSync: { offlineSources: true } });
    sync.noteCloudConfig(4, desired.raw, desired.parsed, true);
    sync.request("cloud");
    await delay(120);
    expect(sent).toHaveLength(1);
    expect(sent[0].status.timeSync.state).toBe("adjusted");
    sync.stop();
  });

  it("swallows a publish failure rather than throwing into the apply path", async () => {
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "t",
      publish: () => {
        throw new Error("broker gone");
      },
      settings: () => ({}),
      modem: async () => NO_MODEM,
      debounceMs: 1,
    });
    await expect(sync.publishReport("boot")).resolves.toBeUndefined();
    sync.stop();
  });

  it("stops queueing once stopped", async () => {
    const { sync, sent } = harness();
    sync.stop();
    sync.request("cloud");
    await delay(30);
    expect(sent).toHaveLength(0);
  });
});

describe("apply classes", () => {
  it("declares one for every namespace the worker applies", () => {
    expect(CONFIG_APPLY_CLASSES).toEqual({
      gnssAntBias: "modem-poll",
      imuMount: "agent-poll",
      recording: "agent-poll",
      lteRecovery: "modem-poll",
      timeSync: "agent-poll",
    });
  });
});
