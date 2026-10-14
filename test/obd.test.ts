import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildObdHelperArgs,
  isObdConfigured,
  normalizeScanCandidates,
  parseObdLine,
  readObdEnvConfig,
  resolveObdConfig,
  type ObdHelperConfig,
  type ObdSpawn,
  type ObdStreamHandlers,
} from "../src/hardware/obd.js";
import {
  auditLine,
  boundInventory,
  createObdCollector,
  MAX_INVENTORY_KEYS,
  obdReportDue,
  REPORT_EVERY_AUDITS,
  requestRate,
  type ObdEventLevel,
} from "../src/agent/collectors/obd.js";
import { createCollector } from "../src/agent/collectors/index.js";
import { OBD_DEFAULTS, type ObdSettings } from "../src/daemon/settings.js";
import { createSimulator } from "../src/agent/simulator.js";
import { obdStatusLine } from "../src/commands/status.js";
import type { RunResult } from "../src/lib/exec.js";
import type { ObdStatus } from "../src/agent/telemetry.js";

// ---------------------------------------------------------------------------
// Contract 1 line parser — one vector per message type, plus the garbage cases.
// ---------------------------------------------------------------------------

const LINES = {
  ready: '{"type":"ready","helper":"obd_read","version":"0.1.0","allowlist_sha256":"abc123"}',
  statusLive: '{"type":"status","state":"live","link":2,"detail":"7E8 answering","ts":1760000000}',
  statusSilent: '{"type":"status","state":"ecu_silent","link":1,"detail":"3 misses","ts":1760000100}',
  profile:
    '{"type":"profile","ts":1760000001,"adapter":{"mac":"AA:BB:CC:DD:EE:FF","ati":"ELM327 v1.5","at1":"OBDII to RS232"},' +
    '"protocol":{"dpn":"A6","dp":"AUTO, ISO 15765-4 (CAN 11/500)"},"responders":["7E8","7E9"],' +
    '"pids_by_ecu":{"7E8":["04","05","0C"]},"supported_fields":["rpm","speed"],"unsupported_fields":["fuel_rate"],' +
    '"powertrain":"ice","rate_req_s":28.1}',
  sample:
    '{"type":"sample","ts":1760000002,"fields":{"rpm":926,"speed":0,"coolant_temp":88,"fuel_level":61.5,"module_voltage":14.12,"odometer":48213.4,"mil":0,"link":2}}',
  audit:
    '{"type":"audit","ts":1760000060,"counters":{"requests":600,"ok":598,"no_data":2,"timeouts":0,"err_adapter":0,"err_protocol":0,' +
    '"err_identity":0,"err_voltage":0,"reconnects":1,"forbidden_attempts":0,"budget_violations":0,"bytes_tx":3600},' +
    '"inventory":{"010C1":100,"010D1":100},"last_stop":{"ts":1760000030,"reason":"BUS ERROR"}}',
  error: '{"type":"error","code":6,"error":"forbidden command ATSH7E0"}',
};

describe("parseObdLine", () => {
  it("parses every contract message type", () => {
    expect(parseObdLine(LINES.ready)).toEqual({
      type: "ready",
      helper: "obd_read",
      version: "0.1.0",
      allowlist_sha256: "abc123",
    });
    expect(parseObdLine(LINES.statusLive)).toEqual({
      type: "status",
      state: "live",
      link: 2,
      detail: "7E8 answering",
      ts: 1760000000,
    });
    const profile = parseObdLine(LINES.profile);
    expect(profile).toMatchObject({ type: "profile", protocol: { dpn: "A6" }, responders: ["7E8", "7E9"] });
    const sample = parseObdLine(LINES.sample);
    expect(sample).toEqual({
      type: "sample",
      ts: 1760000002,
      fields: { rpm: 926, speed: 0, coolant_temp: 88, fuel_level: 61.5, module_voltage: 14.12, odometer: 48213.4, mil: 0, link: 2 },
    });
    const audit = parseObdLine(LINES.audit);
    expect(audit).toMatchObject({
      type: "audit",
      counters: { requests: 600, ok: 598, reconnects: 1 },
      inventory: { "010C1": 100, "010D1": 100 },
      last_stop: { ts: 1760000030, reason: "BUS ERROR" },
    });
    expect(parseObdLine(LINES.error)).toEqual({ type: "error", code: 6, error: "forbidden command ATSH7E0" });
  });

  it("filters non-numeric sample fields at the edge (cloud C1: no null/string leaves)", () => {
    const msg = parseObdLine('{"type":"sample","fields":{"rpm":900,"vin":"WVG","gear":null,"speed":"12","nan":null,"link":2}}');
    expect(msg).toEqual({ type: "sample", fields: { rpm: 900, link: 2 } });
  });

  it("audit with a null last_stop and no inventory still parses", () => {
    expect(parseObdLine('{"type":"audit","ts":1,"counters":{"requests":1},"last_stop":null}')).toEqual({
      type: "audit",
      ts: 1,
      counters: { requests: 1 },
      inventory: {},
      last_stop: null,
    });
  });

  it("returns null for garbage, partial JSON, unknown types and malformed known types", () => {
    expect(parseObdLine("Traceback (most recent call last):")).toBeNull();
    expect(parseObdLine('{"type":"sample","fields":{"rpm":9')).toBeNull();
    expect(parseObdLine('{"type":"telemetry_v2"}')).toBeNull();
    expect(parseObdLine('{"type":"status","state":"flying","link":2}')).toBeNull();
    expect(parseObdLine('{"type":"status","state":"live","link":3}')).toBeNull();
    expect(parseObdLine('{"type":"sample"}')).toBeNull();
    expect(parseObdLine('{"type":"audit"}')).toBeNull();
    expect(parseObdLine('{"type":"error","error":"no code"}')).toBeNull();
    expect(parseObdLine("")).toBeNull();
    expect(parseObdLine("[1,2]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env config + argv (P1: adapter from env)
// ---------------------------------------------------------------------------

describe("readObdEnvConfig / buildObdHelperArgs", () => {
  it("defaults: not configured, pin 1234, 1 Hz, all fields, switched power", () => {
    const cfg = readObdEnvConfig({});
    expect(cfg).toEqual({ adapter: null, serial: null, pin: "1234", pollHz: 1, fields: null, powerSource: "switched" });
    expect(isObdConfigured(cfg)).toBe(false);
  });

  it("reads the adapter + options and builds the contract argv", () => {
    const cfg = readObdEnvConfig({
      XORGATE_OBD_ADAPTER: "aa:bb:cc:dd:ee:ff",
      XORGATE_OBD_PIN: "0000",
      XORGATE_OBD_POLL_HZ: "2",
      XORGATE_OBD_FIELDS: "rpm, speed,coolant_temp",
      XORGATE_OBD_POWER_SOURCE: "constant",
    });
    expect(cfg.adapter).toBe("AA:BB:CC:DD:EE:FF");
    expect(isObdConfigured(cfg)).toBe(true);
    expect(buildObdHelperArgs(cfg)).toEqual([
      "--adapter", "AA:BB:CC:DD:EE:FF", "--pin", "0000",
      "--poll-hz", "2",
      "--fields", "rpm,speed,coolant_temp",
      "--power-source", "constant",
    ]);
  });

  it("serial (emulator) overrides the adapter; bad values fall back", () => {
    const cfg = readObdEnvConfig({
      XORGATE_OBD_ADAPTER: "not-a-mac",
      XORGATE_OBD_SERIAL: "/dev/pts/7",
      XORGATE_OBD_POLL_HZ: "500",
      XORGATE_OBD_POWER_SOURCE: "solar",
    });
    expect(cfg.adapter).toBeNull();
    expect(cfg.serial).toBe("/dev/pts/7");
    expect(cfg.pollHz).toBe(1);
    expect(cfg.powerSource).toBe("switched");
    expect(buildObdHelperArgs(cfg)).toEqual(["--serial", "/dev/pts/7", "--poll-hz", "1", "--power-source", "switched"]);
  });
});

// ---------------------------------------------------------------------------
// Collector: a fake helper fed with contract lines (no python involved)
// ---------------------------------------------------------------------------

interface FakeRun {
  cfg: ObdHelperConfig;
  handlers: ObdStreamHandlers;
  stopped: string | null;
  exit(code: number | null): void;
}

function fakeHelper() {
  const runs: FakeRun[] = [];
  const spawn: ObdSpawn = (cfg, handlers) => {
    let resolveDone!: (r: RunResult) => void;
    const done = new Promise<RunResult>((r) => (resolveDone = r));
    const run: FakeRun = {
      cfg,
      handlers,
      stopped: null,
      exit: (code) =>
        resolveDone({ stdout: "", stderr: "", exitCode: code, failed: code !== 0, notFound: false }),
    };
    runs.push(run);
    return { done, stop: (sig) => (run.stopped = sig ?? "SIGINT") };
  };
  /** Feed one stdout line to the CURRENT helper run, through the real parser. */
  const feed = (line: string): void => {
    const msg = parseObdLine(line);
    if (!msg) throw new Error(`test line did not parse: ${line}`);
    runs[runs.length - 1]!.handlers.onMessage(msg);
  };
  return { spawn, runs, feed };
}

/** Let the `done.then` exit handler run (a few microtask turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const ENV = { XORGATE_OBD_ADAPTER: "AA:BB:CC:DD:EE:FF" };

describe("createObdCollector", () => {
  let events: Array<{ level: ObdEventLevel; msg: string }>;
  const onEvent = (level: ObdEventLevel, msg: string) => events.push({ level, msg });

  beforeEach(() => {
    events = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("without an adapter configured (no namespace, no env): link 0 only, no helper, warned once", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: {}, settings: () => undefined, spawn: h.spawn, onEvent });
    expect(await c.read()).toEqual({ link: { value: 0 } });
    vi.advanceTimersByTime(5_000);
    expect(await c.read()).toEqual({ link: { value: 0 } });
    expect(h.runs).toHaveLength(0);
    expect(c.status().state).toBe("not_configured");
    expect(c.status().adapter).toBeNull();
    // One activity event for the transition, not one per tick.
    expect(events).toEqual([{ level: "warn", msg: expect.stringContaining("adapter not configured") }]);
    expect(c.report()).toEqual({
      ...OBD_DEFAULTS,
      status: "not_configured",
      link: 0,
      source: "env",
      adapter: { mac: null },
    });
  });

  it("maps a fresh sample to numeric leaves with units, link always present", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    expect(await c.read()).toEqual({ link: { value: 0 } }); // lazy start, nothing yet
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.cfg.adapter).toBe("AA:BB:CC:DD:EE:FF");

    h.feed(LINES.ready);
    h.feed('{"type":"status","state":"connecting","link":0,"ts":1}');
    expect(await c.read()).toEqual({ link: { value: 0 } });
    h.feed('{"type":"status","state":"probing","link":1,"ts":2}');
    expect(await c.read()).toEqual({ link: { value: 1 } });
    h.feed(LINES.profile);
    h.feed(LINES.statusLive);
    h.feed(LINES.sample);

    const fields = await c.read();
    expect(fields).toEqual({
      link: { value: 2 },
      rpm: { value: 926, unit: "rpm" },
      speed: { value: 0, unit: "km/h" },
      coolant_temp: { value: 88, unit: "°C" },
      fuel_level: { value: 61.5, unit: "%" },
      module_voltage: { value: 14.12, unit: "V" },
      odometer: { value: 48213.4, unit: "km" },
      mil: { value: 0 },
    });
    for (const leaf of Object.values(fields) as Array<{ value: unknown }>) {
      expect(typeof leaf.value).toBe("number");
      expect(Number.isFinite(leaf.value)).toBe(true);
    }
    // No `link` duplicated inside the fields; no nulls anywhere.
    expect(JSON.stringify(fields)).not.toContain("null");
  });

  it("drops a stale sample (>= 5 s) but keeps link", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.statusLive);
    h.feed(LINES.sample);
    vi.advanceTimersByTime(4_999);
    expect(Object.keys(await c.read())).toContain("rpm");
    vi.advanceTimersByTime(2);
    expect(await c.read()).toEqual({ link: { value: 2 } });
    // A new sample revives the fields.
    h.feed(LINES.sample);
    expect(Object.keys(await c.read())).toContain("rpm");
  });

  it("sample() carries a freshness stamp that advances on new data only", async () => {
    const h = fakeHelper();
    let mono = 1n;
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent, mono: () => mono++ });
    await c.read();
    h.feed(LINES.statusLive);
    h.feed(LINES.sample);
    const a = await c.sample();
    const b = await c.sample();
    expect(a?.updatedMono).toBe(b?.updatedMono);
    expect(a?.fields.rpm).toEqual({ value: 926, unit: "rpm" });
    h.feed(LINES.sample);
    const d = await c.sample();
    expect(d!.updatedMono > a!.updatedMono).toBe(true);
  });

  it("emits activity events on the transitions that matter only", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed('{"type":"status","state":"connecting","link":0}');
    h.feed('{"type":"status","state":"pairing","link":0}');
    h.feed('{"type":"status","state":"probing","link":1}');
    expect(events).toEqual([]);
    h.feed(LINES.statusLive);
    h.feed(LINES.statusLive); // repeated status = no new event
    h.feed(LINES.statusSilent);
    h.feed('{"type":"status","state":"stopped","link":1,"detail":"LV RESET"}');
    h.feed('{"type":"status","state":"adapter_not_found","link":0}');
    expect(events.map((e) => `${e.level}:${e.msg}`)).toEqual([
      "info:obd: live, ECU answering (7E8 answering)",
      "info:obd: ECU silent, polling stopped (3 misses)",
      "warn:obd: helper stopped (LV RESET)",
      "warn:obd: adapter not found",
    ]);
    expect(c.status()).toMatchObject({ state: "adapter_not_found", link: 0 });
  });

  it("exit 6 (software bug): parks 60 s with an error event, then respawns", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.statusLive);
    h.feed(LINES.sample);
    h.feed(LINES.error);
    h.runs[0]!.exit(6);
    await settle();
    expect(c.status()).toMatchObject({ state: "parked", link: 0 });
    expect(await c.read()).toEqual({ link: { value: 0 } }); // nothing polling → no fields
    expect(events.at(-1)).toEqual({
      level: "error",
      msg: "obd: helper reported a software bug (exit 6) — exit 6: forbidden command ATSH7E0; parked for 60 s",
    });
    vi.advanceTimersByTime(59_999);
    expect(h.runs).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(h.runs).toHaveLength(2);
    expect(c.status().state).toBe("connecting");
  });

  it("exit 4 (protocol refused): parks 10 min", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed('{"type":"error","code":4,"error":"ATDPN A1 is not ISO 15765-4"}');
    h.runs[0]!.exit(4);
    await settle();
    expect(c.status().state).toBe("parked");
    expect(events.at(-1)?.level).toBe("error");
    expect(events.at(-1)?.msg).toContain("parked for 600 s");
    vi.advanceTimersByTime(599_000);
    expect(h.runs).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(h.runs).toHaveLength(2);
  });

  it("media-style backoff: 2 s, 4 s, then the third quick failure parks for 60 s", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.runs[0]!.exit(2);
    await settle();
    expect(c.status().state).toBe("retrying");
    expect(events).toEqual([]); // a single quick exit is log-only
    vi.advanceTimersByTime(1_999);
    expect(h.runs).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(h.runs).toHaveLength(2);
    h.runs[1]!.exit(2);
    await settle();
    vi.advanceTimersByTime(3_999);
    expect(h.runs).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(h.runs).toHaveLength(3);
    h.runs[2]!.exit(2);
    await settle();
    expect(c.status().state).toBe("parked");
    expect(events.at(-1)?.level).toBe("error");
    expect(events.at(-1)?.msg).toContain("before stabilizing 3x");
    vi.advanceTimersByTime(60_001);
    expect(h.runs).toHaveLength(4);
  });

  it("a helper that ran >= 15 s then exited restarts promptly with a warn event", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.statusLive);
    vi.advanceTimersByTime(20_000);
    h.runs[0]!.exit(3);
    await settle();
    expect(c.status().state).toBe("retrying");
    expect(events.at(-1)).toMatchObject({ level: "warn" });
    expect(events.at(-1)?.msg).toContain("(code 3) after 20 s");
    vi.advanceTimersByTime(2_001);
    expect(h.runs).toHaveLength(2);
  });

  it("status(): req/s from audit deltas, error and forbidden sums, voltage", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.ready);
    h.feed(LINES.statusLive);
    h.feed(LINES.sample);
    expect(c.status().reqPerSec).toBeNull();
    h.feed('{"type":"audit","ts":1000,"counters":{"requests":0,"err_adapter":0,"forbidden_attempts":0}}');
    expect(c.status().reqPerSec).toBeNull(); // one audit = no rate yet
    h.feed(
      '{"type":"audit","ts":1060,"counters":{"requests":600,"err_adapter":1,"err_protocol":0,"err_identity":0,"err_voltage":2,"forbidden_attempts":0,"budget_violations":1}}',
    );
    const st = c.status();
    expect(st).toMatchObject({
      state: "live",
      link: 2,
      reqPerSec: 10,
      errors: 3,
      forbidden: 1,
      voltage: 14.12,
      helperVersion: "0.1.0",
      detail: "7E8 answering",
      voltageLowEvents: 0,
      auditSeq: 2,
      lastStop: null,
    });
    expect(typeof st.since).toBe("number");
    // start-stop fix: the new counter and the last stop reason surface in the status
    h.feed(
      '{"type":"audit","ts":1120,"counters":{"requests":1200,"voltage_low_events":2},"last_stop":{"ts":1100,"reason":"voltage: 11.50 V"}}',
    );
    expect(c.status()).toMatchObject({ voltageLowEvents: 2, auditSeq: 3, lastStop: "voltage: 11.50 V" });
  });

  it("logs one compact journal line per audit line (REPORT-P1-CAR issue 3) and resets auditSeq per helper run", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.statusLive);
    h.feed(LINES.audit);
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((a) => String(a[0]));
    const line = logged.find((l) => l.includes("audit #1"));
    expect(line).toBe(
      "[obd] audit #1: req 600 (— req/s) ok 598 no_data 2 timeouts 0 err 0 forbidden 0 reconnects 1 voltage_low 0 inventory 2 last_stop BUS ERROR",
    );
    h.feed('{"type":"audit","ts":1760000120,"counters":{"requests":1200,"voltage_low_events":1}}');
    expect(c.status().auditSeq).toBe(2);
    expect(logged.concat((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((a) => String(a[0]))).some((l) => l.includes("audit #2: req 1200 (10.0 req/s)") && l.includes("voltage_low 1"))).toBe(true);
    // a helper restart starts the count over
    h.runs[0]!.exit(0);
    await settle();
    vi.advanceTimersByTime(2_000);
    expect(h.runs).toHaveLength(2);
    expect(c.status().auditSeq).toBe(0);
  });

  it("report(): effective.obd with profile, bounded audit inventory, helper identity", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.ready);
    h.feed(LINES.profile);
    h.feed(LINES.statusLive);
    const inventory: Record<string, number> = {};
    for (let i = 0; i < 350; i++) inventory[`01${i.toString(16).padStart(2, "0")}1`] = i;
    h.feed(JSON.stringify({ type: "audit", ts: 5, counters: { requests: 9 }, inventory, last_stop: null }));
    const r = c.report();
    expect(r.status).toBe("live");
    expect(r.link).toBe(2);
    expect(r.adapter).toEqual({ mac: "AA:BB:CC:DD:EE:FF" });
    expect(r.profile?.protocol?.dpn).toBe("A6");
    expect(r.profile?.supported_fields).toEqual(["rpm", "speed"]);
    expect(r.helper_version).toBe("0.1.0");
    expect(r.allowlist_sha256).toBe("abc123");
    expect(Object.keys(r.audit!.inventory)).toHaveLength(MAX_INVENTORY_KEYS);
    expect(r.audit!.inventory["0115d1"]).toBe(349); // the heaviest entries survive
    expect(r.audit!.inventory["01001"]).toBeUndefined(); // the lightest do not
    expect(r.audit!.counters).toEqual({ requests: 9 });
    expect(r.audit!.last_stop).toBeNull();
    expect(JSON.stringify(r).length).toBeLessThan(8_000);
  });

  it("stop(): SIGINTs the helper, cancels restarts, link 0", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, settings: () => undefined, spawn: h.spawn, onEvent });
    await c.read();
    h.feed(LINES.statusLive);
    c.stop();
    expect(h.runs[0]!.stopped).toBe("SIGINT");
    expect(c.status()).toMatchObject({ state: "stopped", link: 0 });
    h.runs[0]!.exit(0);
    await settle();
    vi.advanceTimersByTime(120_000);
    expect(h.runs).toHaveLength(1); // no respawn after stop
    expect(await c.read()).toEqual({ link: { value: 0 } });
  });
});

describe("pure helpers", () => {
  it("auditLine renders every counter, the rate and the last stop (null-safe)", () => {
    const snap = { counters: { requests: 10, ok: 9, no_data: 1 }, inventory: { "010C1": 10 }, last_stop: null, ts: 1 };
    expect(auditLine(3, snap, 1.25)).toBe(
      "audit #3: req 10 (1.3 req/s) ok 9 no_data 1 timeouts 0 err 0 forbidden 0 reconnects 0 voltage_low 0 inventory 1 last_stop —",
    );
    expect(auditLine(1, { ...snap, counters: { err_voltage: 1, forbidden_attempts: 1, voltage_low_events: 3 }, last_stop: { reason: "voltage: x" } }, null)).toBe(
      "audit #1: req 0 (— req/s) ok 0 no_data 0 timeouts 0 err 1 forbidden 1 reconnects 0 voltage_low 3 inventory 1 last_stop voltage: x",
    );
  });

  it("boundInventory keeps the heaviest keys and copies when under the cap", () => {
    expect(boundInventory({ a: 1, b: 5, c: 3 }, 2)).toEqual({ b: 5, c: 3 });
    const small = { x: 1 };
    const out = boundInventory(small, 10);
    expect(out).toEqual(small);
    expect(out).not.toBe(small);
  });

  it("requestRate needs two audits with increasing requests and time", () => {
    const a = { counters: { requests: 10 }, inventory: {}, last_stop: null, ts: 100 };
    const b = { counters: { requests: 70 }, inventory: {}, last_stop: null, ts: 106 };
    expect(requestRate(a, b)).toBe(10);
    expect(requestRate(null, b)).toBeNull();
    expect(requestRate(b, a)).toBeNull(); // helper restarted (counter went down) / time went back
    expect(requestRate(a, { ...b, ts: 100 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry gating: no block → identical output; block → obd group (mock stream)
// ---------------------------------------------------------------------------

describe("createCollector obd gating", () => {
  const TODAY = '{"metrics":{},"media":{"kvs":{"value":false},"recording":{"value":false},"streams":[]}}';

  it("without peripherals.obd the collector list and telemetry output are byte-identical to today", async () => {
    const before = createCollector({});
    const noHw = createCollector({}, undefined, {});
    const noObd = createCollector({}, undefined, { peripherals: {} });
    for (const c of [before, noHw, noObd]) {
      expect(JSON.stringify(await c.read())).toBe(TODAY);
      expect(await c.sampleGroups()).toEqual({});
      expect(c.obdStatus()).toBeNull();
      expect(c.obdReport()).toBeNull();
      c.stop();
    }
  });

  it("with peripherals.obd the obd group appears with link (mock helper stream)", async () => {
    const prev = { mock: process.env.XORGATE_MOCK, adapter: process.env.XORGATE_OBD_ADAPTER };
    process.env.XORGATE_MOCK = "1";
    process.env.XORGATE_OBD_ADAPTER = "AA:BB:CC:DD:EE:FF";
    try {
      const events: string[] = [];
      const c = createCollector({}, undefined, {
        peripherals: { obd: { adapter: "elm327", transport: "bt-spp" } },
        onEvent: (level, msg) => events.push(`${level}:${msg}`),
      });
      const first = await c.read();
      expect(first.metrics.obd).toEqual({ link: { value: 0 } });
      await new Promise((r) => setTimeout(r, 1_300)); // mock: live at 0.6 s, first 1 Hz sample at 1 s
      const later = await c.read();
      expect(later.metrics.obd?.link).toEqual({ value: 2 });
      expect(later.metrics.obd?.rpm?.value).toBeGreaterThan(800);
      expect(c.obdStatus()?.state).toBe("live");
      expect(c.obdReport()?.profile?.protocol?.dpn).toBe("A6");
      expect(events.some((e) => e.startsWith("info:obd: live"))).toBe(true);
      c.stop();
      expect(c.obdStatus()?.state).toBe("stopped");
    } finally {
      if (prev.mock === undefined) delete process.env.XORGATE_MOCK;
      else process.env.XORGATE_MOCK = prev.mock;
      if (prev.adapter === undefined) delete process.env.XORGATE_OBD_ADAPTER;
      else process.env.XORGATE_OBD_ADAPTER = prev.adapter;
    }
  });
});

// ---------------------------------------------------------------------------
// Simulator + status line
// ---------------------------------------------------------------------------

describe("simulator obd group", () => {
  it("is absent by default and plausible when opted in", () => {
    expect(createSimulator()().metrics.obd).toBeUndefined();
    const next = createSimulator({ obd: true });
    const a = next().metrics.obd!;
    expect(a.link).toEqual({ value: 2 });
    expect(a.rpm!.value).toBeGreaterThanOrEqual(800);
    expect(a.rpm!.value).toBeLessThan(2500);
    expect(a.fuel_level!.value).toBeGreaterThan(0);
    for (const leaf of Object.values(a) as Array<{ value: unknown } | undefined>) {
      expect(typeof leaf?.value).toBe("number");
    }
    // Odometer never goes backwards; fuel never goes up.
    let last = a;
    for (let i = 0; i < 20; i++) {
      const cur = next().metrics.obd!;
      expect(cur.odometer!.value).toBeGreaterThanOrEqual(last.odometer!.value);
      expect(cur.fuel_level!.value).toBeLessThanOrEqual(last.fuel_level!.value);
      last = cur;
    }
  });
});

describe("obdStatusLine", () => {
  const base: ObdStatus = {
    state: "live",
    link: 2,
    reqPerSec: 10,
    errors: 0,
    forbidden: 0,
    voltage: 14.12,
    detail: null,
    since: 0,
    helperVersion: "0.1.0",
  };
  it("formats the contract line", () => {
    expect(obdStatusLine(base)).toBe("obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V");
  });
  it("renders unknowns as dashes", () => {
    expect(obdStatusLine({ ...base, state: "connecting", link: 0, reqPerSec: null, voltage: null })).toBe(
      "obd        connecting  link 0  — req/s  err 0  forbidden 0  — V",
    );
  });
  it("appends the configured adapter (P3) and omits the column when there is none", () => {
    expect(obdStatusLine({ ...base, adapter: "10:21:3E:4F:33:65" })).toBe(
      "obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V  adapter 10:21:3E:4F:33:65",
    );
    expect(obdStatusLine({ ...base, state: "disabled", link: 0, reqPerSec: null, voltage: null, adapter: null })).toBe(
      "obd        disabled  link 0  — req/s  err 0  forbidden 0  — V",
    );
  });
});

// ---------------------------------------------------------------------------
// P3: the `obd` settings namespace drives the collector (fake helper stream)
// ---------------------------------------------------------------------------

describe("resolveObdConfig (settings over env, serial override)", () => {
  it("absent namespace = the P1 env seam, reported as source env", () => {
    const r = resolveObdConfig(undefined, { XORGATE_OBD_ADAPTER: "aa:bb:cc:dd:ee:ff", XORGATE_OBD_POLL_HZ: "2" });
    expect(r).toMatchObject({ run: true, off: null, source: "env" });
    expect(r.helper).toMatchObject({ adapter: "AA:BB:CC:DD:EE:FF", pollHz: 2, serial: null });
    expect(r.settings).toEqual({ ...OBD_DEFAULTS, enabled: true, adapterMac: "AA:BB:CC:DD:EE:FF", pollHz: 2 });
    expect(resolveObdConfig(undefined, {})).toMatchObject({ run: false, off: "not_configured", source: "env" });
  });

  it("present namespace: settings win over env, defaults fill the gaps, enabled is the kill switch", () => {
    const env = { XORGATE_OBD_ADAPTER: "AA:BB:CC:DD:EE:FF", XORGATE_OBD_PIN: "9999", XORGATE_OBD_POLL_HZ: "2" };
    const on = resolveObdConfig({ enabled: true, adapterMac: "10:21:3E:4F:33:65", powerSource: "switched" }, env);
    expect(on).toMatchObject({ run: true, off: null, source: "settings" });
    expect(on.helper).toEqual({
      adapter: "10:21:3E:4F:33:65",
      serial: null,
      pin: "1234",
      pollHz: 1,
      fields: null,
      powerSource: "switched",
    });
    expect(on.settings).toEqual({ ...OBD_DEFAULTS, enabled: true, adapterMac: "10:21:3E:4F:33:65" });
    expect(resolveObdConfig({ enabled: false, adapterMac: "10:21:3E:4F:33:65" }, env)).toMatchObject({
      run: false,
      off: "disabled",
    });
    expect(resolveObdConfig({ enabled: true, adapterMac: null }, env)).toMatchObject({
      run: false,
      off: "not_configured",
    });
    expect(resolveObdConfig({ enabled: true }, env)).toMatchObject({ run: false, off: "not_configured" });
    // fields [] = all (helper default); a non-empty list restricts.
    expect(resolveObdConfig({ enabled: true, adapterMac: "10:21:3E:4F:33:65", fields: ["rpm", "speed"] }, env).helper.fields)
      .toEqual(["rpm", "speed"]);
  });

  it("XORGATE_OBD_SERIAL overrides the adapter in both cases but still obeys enabled", () => {
    const env = { XORGATE_OBD_SERIAL: "/dev/pts/4" };
    expect(resolveObdConfig(undefined, env)).toMatchObject({ run: true, helper: { serial: "/dev/pts/4", adapter: null } });
    expect(resolveObdConfig({ enabled: true, adapterMac: null }, env)).toMatchObject({ run: true, helper: { serial: "/dev/pts/4" } });
    expect(resolveObdConfig({ enabled: false, adapterMac: null }, env)).toMatchObject({ run: false, off: "disabled" });
  });
});

describe("normalizeScanCandidates", () => {
  it("drops unnamed/malformed entries, dedups, sorts by rssi desc and caps at 20", () => {
    const raw = [
      { mac: "10:21:3e:4f:33:65", name: "OBDII", rssi: -58 },
      { mac: "10:21:3E:4F:33:65", name: "OBDII dup", rssi: -10 },
      { mac: "6C:3B:00:00:00:01", name: "6C-3B-00-00-00-01", rssi: -40 }, // BLE random, no name
      { mac: "6C:3B:00:00:00:02", name: "", rssi: -40 },
      { mac: "not a mac", name: "x", rssi: -1 },
      { mac: "00:1D:A5:68:98:8B", name: "V-LINK" }, // no rssi → last
      { mac: "AA:AA:AA:AA:AA:01", name: "TV", rssi: -70.4 },
      ...Array.from({ length: 25 }, (_, i) => ({
        mac: `BB:BB:BB:BB:BB:${(i + 10).toString(16).padStart(2, "0").toUpperCase()}`,
        name: `dev${i}`,
        rssi: -80 - i,
      })),
    ];
    const out = normalizeScanCandidates(raw);
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual({ mac: "10:21:3E:4F:33:65", name: "OBDII", rssi: -58 });
    expect(out[1]).toEqual({ mac: "AA:AA:AA:AA:AA:01", name: "TV", rssi: -70 });
    expect(out.some((c) => c.mac.startsWith("6C:3B"))).toBe(false);
    expect(out.some((c) => c.name === "V-LINK")).toBe(false); // null rssi sorts after the 20 strongest
    expect(normalizeScanCandidates("garbage")).toEqual([]);
    expect(normalizeScanCandidates([{ mac: "00:1D:A5:68:98:8B", name: "V-LINK" }])).toEqual([
      { mac: "00:1D:A5:68:98:8B", name: "V-LINK", rssi: null },
    ]);
  });
});

describe("createObdCollector + obd settings namespace (P3)", () => {
  let events: Array<{ level: ObdEventLevel; msg: string }>;
  const onEvent = (level: ObdEventLevel, msg: string) => events.push({ level, msg });
  const MAC = "10:21:3E:4F:33:65";
  const ENABLED: ObdSettings = { enabled: true, adapterMac: MAC, powerSource: "switched" };

  beforeEach(() => {
    events = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A collector whose namespace the test can flip between reads. */
  function rig(initial: ObdSettings | undefined, env: NodeJS.ProcessEnv = { XORGATE_OBD_ADAPTER: "AA:BB:CC:DD:EE:FF" }) {
    const h = fakeHelper();
    let settings = initial;
    let reads = 0;
    const c = createObdCollector({
      env,
      settings: () => {
        reads += 1;
        return settings;
      },
      spawn: h.spawn,
      onEvent,
      scanner: async () => [{ mac: "00:1D:A5:68:98:8B", name: "V-LINK", rssi: -61 }],
      unbond: async (mac) => {
        unbonded.push(mac);
      },
    });
    const unbonded: string[] = [];
    return {
      h,
      c,
      unbonded,
      set(next: ObdSettings | undefined) {
        settings = next;
      },
      get reads() {
        return reads;
      },
    };
  }

  it("starts the helper from the namespace (env ignored) and reports the resolved namespace", async () => {
    const r = rig(ENABLED);
    expect(await r.c.read()).toEqual({ link: { value: 0 } });
    expect(r.h.runs).toHaveLength(1);
    expect(r.h.runs[0]!.cfg).toEqual({
      adapter: MAC,
      serial: null,
      pin: "1234",
      pollHz: 1,
      fields: null,
      powerSource: "switched",
    });
    expect(r.c.status().adapter).toBe(MAC);
    expect(r.c.report()).toMatchObject({
      ...OBD_DEFAULTS,
      enabled: true,
      adapterMac: MAC,
      status: "connecting",
      link: 0,
      source: "settings",
      adapter: { mac: MAC },
    });
    expect(r.c.report().fields).toEqual([]);
  });

  it("re-reads the namespace about once a second, not on every read", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    await r.c.read();
    await r.c.sample();
    expect(r.reads).toBe(1);
    vi.advanceTimersByTime(1_000);
    await r.c.read();
    expect(r.reads).toBe(2);
    r.c.reapply();
    expect(r.reads).toBe(3);
  });

  it("enabled:false stops the helper → disabled/link 0 with ONE event; true again restarts it", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    r.h.feed(LINES.ready);
    r.h.feed(LINES.statusLive);
    r.h.feed(LINES.sample);
    expect((await r.c.read()).rpm).toBeDefined();
    events = [];

    r.set({ ...ENABLED, enabled: false });
    r.c.reapply();
    expect(r.h.runs[0]!.stopped).toBe("SIGINT");
    expect(await r.c.read()).toEqual({ link: { value: 0 } });
    expect(r.c.status()).toMatchObject({ state: "disabled", link: 0 });
    r.h.runs[0]!.exit(0);
    await settle();
    expect(r.c.status().state).toBe("disabled"); // the exit does not restart it
    vi.advanceTimersByTime(60_000);
    expect(r.h.runs).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      await r.c.read();
    }
    expect(events).toEqual([{ level: "info", msg: expect.stringContaining("disabled by settings") }]);
    expect(r.c.report()).toMatchObject({ status: "disabled", enabled: false, link: 0 });

    r.set(ENABLED);
    vi.advanceTimersByTime(1_000);
    await r.c.read();
    expect(r.h.runs).toHaveLength(2);
    expect(r.c.status().state).toBe("connecting");
    expect(events.at(-1)).toEqual({ level: "info", msg: expect.stringContaining("starting helper") });
  });

  it("adapterMac null → not_configured (one warn event), link 0; a MAC appearing starts it", async () => {
    const r = rig({ enabled: true, adapterMac: null });
    await r.c.read();
    expect(r.h.runs).toHaveLength(0);
    expect(r.c.status()).toMatchObject({ state: "not_configured", link: 0, adapter: null });
    vi.advanceTimersByTime(3_000);
    await r.c.read();
    expect(events).toEqual([{ level: "warn", msg: expect.stringContaining("adapter not configured") }]);
    r.set(ENABLED);
    r.c.reapply();
    expect(r.h.runs).toHaveLength(1);
    expect(r.c.status().state).toBe("connecting");
  });

  it("a changed adapter / pin / pollHz / fields / powerSource SIGINTs the helper and respawns with the new argv, no backoff", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    r.h.feed(LINES.statusLive);
    events = [];
    r.set({ ...ENABLED, adapterMac: "AA:BB:CC:DD:EE:01", pin: "4321", pollHz: 0.5, fields: ["rpm"], powerSource: "constant" });
    r.c.reapply();
    expect(r.h.runs[0]!.stopped).toBe("SIGINT");
    expect(r.c.status().state).toBe("starting");
    expect(events).toEqual([{ level: "info", msg: expect.stringContaining("settings changed (adapter AA:BB:CC:DD:EE:01, 0.5 Hz, 1 fields, constant power") }]);
    expect(r.h.runs).toHaveLength(1); // not before the old one exits
    r.h.runs[0]!.exit(0);
    await settle();
    expect(r.h.runs).toHaveLength(2);
    expect(r.h.runs[1]!.cfg).toEqual({
      adapter: "AA:BB:CC:DD:EE:01",
      serial: null,
      pin: "4321",
      pollHz: 0.5,
      fields: ["rpm"],
      powerSource: "constant",
    });
    expect(r.c.status().state).toBe("connecting");
    // An identical re-delivery is a no-op.
    r.c.reapply();
    expect(r.h.runs[1]!.stopped).toBeNull();
  });

  it("a settings change while parked/retrying cancels the timer and starts right away", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    r.h.runs[0]!.exit(2);
    await settle();
    expect(r.c.status().state).toBe("retrying");
    r.set({ ...ENABLED, pollHz: 2 });
    r.c.reapply();
    expect(r.h.runs).toHaveLength(2);
    expect(r.h.runs[1]!.cfg.pollHz).toBe(2);
    vi.advanceTimersByTime(30_000);
    expect(r.h.runs).toHaveLength(2); // the old retry timer did not fire a third run
  });

  it("namespace removed → falls back to the env seam", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    r.set(undefined);
    r.c.reapply();
    r.h.runs[0]!.exit(0);
    await settle();
    expect(r.h.runs[1]!.cfg.adapter).toBe("AA:BB:CC:DD:EE:FF");
    expect(r.c.report().source).toBe("env");
    const r2 = rig(ENABLED, {});
    await r2.c.read();
    r2.set(undefined);
    r2.c.reapply();
    r2.h.runs[0]!.exit(0);
    await settle();
    expect(r2.c.status().state).toBe("not_configured");
    expect(r2.h.runs).toHaveLength(1);
  });

  it("adapter_not_found warns once per absence episode, then every 10 min, and says when it is back", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    const cycle = (ts: number) => {
      r.h.feed(`{"type":"status","state":"connecting","link":0,"ts":${ts}}`);
      r.h.feed(`{"type":"status","state":"adapter_not_found","link":0,"detail":"Host is down","ts":${ts}}`);
      r.h.feed(`{"type":"status","state":"backoff","link":0,"ts":${ts}}`);
    };
    for (let i = 0; i < 20; i++) {
      cycle(i);
      vi.advanceTimersByTime(8_000);
    }
    const warns = events.filter((e) => e.level === "warn");
    expect(warns).toEqual([{ level: "warn", msg: "obd: adapter not found (Host is down)" }]);
    vi.advanceTimersByTime(600_000);
    cycle(99);
    expect(events.filter((e) => e.level === "warn")).toHaveLength(2);
    expect(events.at(-1)!.msg).toMatch(/adapter still not found after 1[23] min/);
    // Back: one info event, and the next absence is a fresh episode.
    r.h.feed('{"type":"status","state":"probing","link":1,"ts":100}');
    expect(events.at(-1)).toEqual({ level: "info", msg: expect.stringContaining("adapter found again") });
    cycle(101);
    expect(events.filter((e) => e.level === "warn")).toHaveLength(3);
    // A helper restart (exit 3 after its own 10 min) keeps the episode open: no extra warn.
    r.h.runs[0]!.exit(3);
    await settle();
    vi.advanceTimersByTime(2_000);
    cycle(102);
    expect(events.filter((e) => e.level === "warn").filter((e) => e.msg.includes("not found"))).toHaveLength(3);
  });

  it("req/s is seeded from profile.rate_req_s until two audit lines exist", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    expect(r.c.status().reqPerSec).toBeNull();
    r.h.feed(LINES.profile); // rate_req_s 28.1
    expect(r.c.status().reqPerSec).toBe(28.1);
    r.h.feed('{"type":"audit","ts":1000,"counters":{"requests":0}}');
    expect(r.c.status().reqPerSec).toBe(28.1);
    r.h.feed('{"type":"audit","ts":1060,"counters":{"requests":600}}');
    expect(r.c.status().reqPerSec).toBe(10);
    r.h.runs[0]!.exit(0);
    await settle();
    expect(r.c.status().reqPerSec).toBeNull(); // not running → no seed either
  });

  it("scan(): runs the scanner once (a second call joins), parks the result in report().scan", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    expect(r.c.report().scan).toBeUndefined();
    const p1 = r.c.scan();
    const p2 = r.c.scan();
    expect(p2).toBe(p1);
    const res = await p1;
    expect(res).toEqual({ ts: Date.now(), candidates: [{ mac: "00:1D:A5:68:98:8B", name: "V-LINK", rssi: -61 }] });
    expect(r.c.report().scan).toEqual(res);
    expect(events.map((e) => e.msg)).toEqual([
      expect.stringContaining("scanning for Bluetooth adapters (25 s"),
      "obd: scan done: 1 named device(s)",
    ]);
    // The helper kept running the whole time.
    expect(r.h.runs[0]!.stopped).toBeNull();
  });

  it("scan(): a scanner failure lands as an empty result with an error, warn event", async () => {
    const h = fakeHelper();
    const c = createObdCollector({
      env: {},
      settings: () => ENABLED,
      spawn: h.spawn,
      onEvent,
      scanner: async () => {
        throw new Error("bluetoothctl not found");
      },
    });
    await c.read();
    const res = await c.scan();
    expect(res).toEqual({ ts: Date.now(), candidates: [], error: "bluetoothctl not found" });
    expect(events.at(-1)).toEqual({ level: "warn", msg: "obd: scan failed: bluetoothctl not found" });
  });

  it("forget(): stops the helper, unbonds, clears profile + last_stop, holds not_configured until the namespace changes", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    r.h.feed(LINES.profile);
    r.h.feed(LINES.statusLive);
    r.h.feed(LINES.audit);
    expect(r.c.report().audit?.last_stop).toEqual({ ts: 1760000030, reason: "BUS ERROR" });
    events = [];
    const res = await r.c.forget();
    expect(res).toEqual({ mac: MAC });
    expect(r.unbonded).toEqual([MAC]);
    expect(r.h.runs[0]!.stopped).toBe("SIGINT");
    r.h.runs[0]!.exit(0);
    await settle();
    expect(r.c.status()).toMatchObject({ state: "not_configured", link: 0 });
    const rep = r.c.report();
    expect(rep.profile).toBeUndefined();
    expect(rep.audit?.last_stop).toBeNull();
    expect(rep).toMatchObject({ status: "not_configured", adapterMac: MAC, enabled: true });
    expect(events).toEqual([{ level: "info", msg: expect.stringContaining(`adapter ${MAC} forgotten`) }]);
    // Same namespace re-read (retained redelivery, 1 s poll): still off.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1_000);
      await r.c.read();
    }
    r.c.reapply();
    expect(r.h.runs).toHaveLength(1);
    // The console's PATCH {obd:null} → namespace cleared → env seam / defaults.
    r.set({ enabled: true, adapterMac: null });
    r.c.reapply();
    expect(r.c.status().state).toBe("not_configured");
    // A NEW adapter pairs afresh.
    r.set({ ...ENABLED, adapterMac: "AA:BB:CC:DD:EE:01" });
    r.c.reapply();
    expect(r.h.runs).toHaveLength(2);
    expect(r.h.runs[1]!.cfg.adapter).toBe("AA:BB:CC:DD:EE:01");
  });

  it("forget(): the same MAC set again after a clear pairs afresh (the latch follows the namespace)", async () => {
    const r = rig(ENABLED);
    await r.c.read();
    await r.c.forget();
    r.h.runs[0]!.exit(0);
    await settle();
    r.set({ enabled: true, adapterMac: null });
    r.c.reapply();
    r.set(ENABLED);
    r.c.reapply();
    expect(r.h.runs).toHaveLength(2);
  });
});

describe("obdReportDue (WP3: effective.obd follows the helper)", () => {
  const st = (link: 0 | 1 | 2, state = "live"): ObdStatus =>
    ({ state, link, reqPerSec: null, errors: 0, forbidden: 0, voltage: null, detail: null, since: 0, helperVersion: null }) as ObdStatus;
  it("fires on a link move and when the collector appears/disappears, not on a same-link state churn", () => {
    expect(obdReportDue(null, null)).toBe(false);
    expect(obdReportDue(null, st(0, "connecting"))).toBe(true);
    expect(obdReportDue(st(0, "connecting"), null)).toBe(true);
    expect(obdReportDue(st(0, "connecting"), st(0, "adapter_not_found"))).toBe(false);
    expect(obdReportDue(st(0, "adapter_not_found"), st(0, "backoff"))).toBe(false);
    expect(obdReportDue(st(1, "probing"), st(2, "live"))).toBe(true);
    expect(obdReportDue(st(2, "live"), st(1, "ecu_silent"))).toBe(true);
  });
  it("fires when the supervisor parks or gives up, and when it resumes", () => {
    expect(obdReportDue(st(0, "retrying"), st(0, "parked"))).toBe(true);
    expect(obdReportDue(st(0, "parked"), st(0, "parked"))).toBe(false);
    expect(obdReportDue(st(0, "parked"), st(0, "starting"))).toBe(true);
    expect(obdReportDue(st(0, "retrying"), st(0, "exited"))).toBe(true);
  });
  it("fires on the first audit line of a run, then every REPORT_EVERY_AUDITS-th (start-stop fix: audit reaches the cloud)", () => {
    const live = (auditSeq: number, extra: Partial<ObdStatus> = {}): ObdStatus => ({ ...st(2, "live"), auditSeq, ...extra });
    expect(obdReportDue(live(0), live(1))).toBe(true); // the `live` report carried no audit block
    expect(obdReportDue(live(1), live(2))).toBe(false);
    expect(obdReportDue(live(9), live(REPORT_EVERY_AUDITS))).toBe(true);
    expect(obdReportDue(live(REPORT_EVERY_AUDITS), live(REPORT_EVERY_AUDITS + 1))).toBe(false);
    expect(obdReportDue(live(19), live(20))).toBe(true);
    expect(obdReportDue(live(5), live(5))).toBe(false);
    // older state.json without the field: same as 0 → 0, no churn
    expect(obdReportDue(st(2, "live"), st(2, "live"))).toBe(false);
  });
  it("fires on an error / forbidden / voltage-low / last-stop change, not on a rate change", () => {
    const base = (extra: Partial<ObdStatus>): ObdStatus => ({ ...st(2, "live"), auditSeq: 3, ...extra });
    expect(obdReportDue(base({ errors: 0 }), base({ errors: 1 }))).toBe(true);
    expect(obdReportDue(base({ forbidden: 0 }), base({ forbidden: 1 }))).toBe(true);
    expect(obdReportDue(base({ voltageLowEvents: 0 }), base({ voltageLowEvents: 1 }))).toBe(true);
    expect(obdReportDue(base({ lastStop: null }), base({ lastStop: "voltage: 11.5 V" }))).toBe(true);
    expect(obdReportDue(base({ reqPerSec: 17 }), base({ reqPerSec: 18 }))).toBe(false);
    expect(obdReportDue(base({ voltage: 12 }), base({ voltage: 9.8 }))).toBe(false);
  });
});
