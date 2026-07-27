import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModemLine, readModemTelemetry } from "../src/hardware/modem.js";

const SAMPLE = {
  timestamp: "2026-06-13T08:21:45Z",
  csq: 18,
  rssi_dbm: -77,
  csq_interval: 30,
  status: "connected",
  iface: "usb0",
  ip: "10.164.20.3",
};

async function withTelemetryFile(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xorgate-lte-"));
  const file = join(dir, "telemetry.json");
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("findModemLine", () => {
  const LSUSB = [
    "Bus 003 Device 002: ID 1e0e:9011 Qualcomm / Option SimTech, Incorporated",
    "Bus 004 Device 003: ID 32e4:2210 USB Cam Manufacturer HD USB Camera",
    "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub",
  ].join("\n");

  it("finds the SIM7600 by vendor/product id", () => {
    const m = findModemLine(LSUSB);
    expect(m?.usbId).toBe("1e0e:9011");
    expect(m?.description).toContain("SimTech");
  });

  it("returns null when no modem line matches", () => {
    expect(findModemLine("Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub")).toBeNull();
  });
});

describe("readModemTelemetry", () => {
  it("parses the daemon's telemetry JSON", async () => {
    const file = await withTelemetryFile(SAMPLE);
    const t = await readModemTelemetry(file);
    expect(t?.csq).toBe(18);
    expect(t?.rssi_dbm).toBe(-77);
    expect(t?.status).toBe("connected");
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("returns null when the file is absent", async () => {
    const missing = join(tmpdir(), "xorgate-no-such-telemetry.json");
    expect(await readModemTelemetry(missing)).toBeNull();
  });

  it("returns null on unparseable JSON", async () => {
    const file = await withTelemetryFile("{ not json");
    expect(await readModemTelemetry(file)).toBeNull();
    await rm(join(file, ".."), { recursive: true, force: true });
  });
});

describe("createLteCollector", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Load a fresh collector bound to the given telemetry file via env override. */
  async function collectorFor(body: unknown) {
    const file = await withTelemetryFile(body);
    vi.stubEnv("LTE_TELEMETRY_FILE", file);
    vi.resetModules();
    const { createLteCollector } = await import("../src/agent/collectors/lte.js");
    return { collector: createLteCollector(), file };
  }

  it("maps daemon telemetry to rssi (dBm) + quality (asu) leaves", async () => {
    const { collector, file } = await collectorFor(SAMPLE);
    expect(collector.group).toBe("lte");
    const fields = (await collector.read()) as Record<string, { value: number; unit?: string }>;
    expect(fields.quality).toEqual({ value: 18, unit: "asu" });
    expect(fields.rssi).toEqual({ value: -77, unit: "dBm" });
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("emits modem_temp (°C) when the daemon reports one", async () => {
    const { collector, file } = await collectorFor({ ...SAMPLE, modem_temp: 39 });
    const fields = (await collector.read()) as Record<string, { value: number; unit?: string }>;
    expect(fields.modem_temp).toEqual({ value: 39, unit: "°C" });
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("omits modem_temp when the daemon reports null (never read / unsupported)", async () => {
    const { collector, file } = await collectorFor({ ...SAMPLE, modem_temp: null });
    const fields = (await collector.read()) as Record<string, unknown>;
    expect(fields.modem_temp).toBeUndefined();
    expect(fields.quality).toBeDefined();
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("maps the daemon's gnss.health + recovery.resets_24h to numeric leaves", async () => {
    const { collector, file } = await collectorFor({
      ...SAMPLE,
      gnss: { engine_on: 1, has_fix: 0, health: "degraded" },
      recovery: { connect_fails: 0, resets_24h: 2 },
    });
    const fields = (await collector.read()) as Record<string, { value: number }>;
    expect(fields.gnss_health).toEqual({ value: 2 }); // degraded, per GNSS_HEALTH_CODES
    expect(fields.resets_24h).toEqual({ value: 2 });
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("codes every gnss health state by severity (0 ok … 3 unhealthy)", async () => {
    for (const [health, code] of [
      ["ok", 0],
      ["acquiring", 1],
      ["degraded", 2],
      ["unhealthy", 3],
    ] as const) {
      const { collector, file } = await collectorFor({ ...SAMPLE, gnss: { health } });
      const fields = (await collector.read()) as Record<string, { value: number }>;
      expect(fields.gnss_health).toEqual({ value: code });
      await rm(join(file, ".."), { recursive: true, force: true });
    }
  });

  it("omits gnss_health/resets_24h before first daemon knowledge or on old daemons", async () => {
    // New daemon, no knowledge yet: health null, recovery block without counters.
    let made = await collectorFor({ ...SAMPLE, gnss: { health: null }, recovery: {} });
    let fields = (await made.collector.read()) as Record<string, unknown>;
    expect(fields.gnss_health).toBeUndefined();
    expect(fields.resets_24h).toBeUndefined();
    expect(fields.quality).toBeDefined();
    await rm(join(made.file, ".."), { recursive: true, force: true });
    // Old daemon: no gnss/recovery blocks at all.
    made = await collectorFor(SAMPLE);
    fields = (await made.collector.read()) as Record<string, unknown>;
    expect(fields.gnss_health).toBeUndefined();
    expect(fields.resets_24h).toBeUndefined();
    await rm(join(made.file, ".."), { recursive: true, force: true });
  });

  it("omits the group when the signal is unknown (csq 99)", async () => {
    const { collector, file } = await collectorFor({ ...SAMPLE, csq: 99, rssi_dbm: null });
    expect(await collector.read()).toEqual({});
    await rm(join(file, ".."), { recursive: true, force: true });
  });

  it("omits the group when the daemon hasn't published", async () => {
    vi.stubEnv("LTE_TELEMETRY_FILE", join(tmpdir(), "xorgate-absent-telemetry.json"));
    vi.resetModules();
    const { createLteCollector } = await import("../src/agent/collectors/lte.js");
    expect(await createLteCollector().read()).toEqual({});
  });
});
