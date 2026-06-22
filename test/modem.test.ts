import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModemTelemetry } from "../src/hardware/modem.js";

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
