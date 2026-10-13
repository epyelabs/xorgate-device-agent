import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildObdHelperArgs,
  isObdConfigured,
  parseObdLine,
  readObdEnvConfig,
  type ObdHelperConfig,
  type ObdSpawn,
  type ObdStreamHandlers,
} from "../src/hardware/obd.js";
import {
  boundInventory,
  createObdCollector,
  MAX_INVENTORY_KEYS,
  requestRate,
  type ObdEventLevel,
} from "../src/agent/collectors/obd.js";
import { createCollector } from "../src/agent/collectors/index.js";
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

  it("without an adapter configured: link 0 only, no helper, warned once", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: {}, spawn: h.spawn, onEvent });
    expect(await c.read()).toEqual({ link: { value: 0 } });
    expect(await c.read()).toEqual({ link: { value: 0 } });
    expect(h.runs).toHaveLength(0);
    expect(c.status().state).toBe("unconfigured");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(c.report()).toEqual({ status: "unconfigured", link: 0, adapter: { mac: null } });
  });

  it("maps a fresh sample to numeric leaves with units, link always present", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent, mono: () => mono++ });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    });
    expect(typeof st.since).toBe("number");
  });

  it("report(): effective.obd with profile, bounded audit inventory, helper identity", async () => {
    const h = fakeHelper();
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
    const c = createObdCollector({ env: ENV, spawn: h.spawn, onEvent });
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
});
