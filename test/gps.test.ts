import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../src/agent/collectors/index.js";

const NMEA =
  [
    "$GPGGA,083745.000,1430.1234,N,12101.5678,E,1,08,0.9,545.4,M,46.9,M,,*56",
    "$GPRMC,083745.000,A,1430.1234,N,12101.5678,E,0.06,31.66,130626,,,A*5A",
  ].join("\n") + "\n";

type Leaf = { value: number; unit?: string };

/** Poll the collector until a fix lands (the NMEA stream is read async). */
async function readUntilFix(collector: Collector, tries = 50): Promise<Record<string, Leaf>> {
  for (let i = 0; i < tries; i++) {
    const fields = (await collector.read()) as Record<string, Leaf>;
    if (Object.keys(fields).length > 0) return fields;
    await new Promise((r) => setTimeout(r, 10));
  }
  return {};
}

describe("createGpsCollector", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("emits a mapped fix incl. satellites + fix_quality from an NMEA source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xorgate-gps-"));
    const file = join(dir, "nmea.txt");
    await writeFile(file, NMEA);

    vi.stubEnv("GPS_NMEA_PORT", file);
    vi.resetModules();
    const { createGpsCollector } = await import("../src/agent/collectors/gps.js");
    const collector = createGpsCollector();
    expect(collector.group).toBe("gps");

    const fields = await readUntilFix(collector);
    expect(fields.lat.value).toBeCloseTo(14.50206, 4);
    expect(fields.lon.value).toBeCloseTo(121.02613, 4);
    expect(fields.alt).toEqual({ value: 545.4, unit: "m" });
    expect(fields.satellites.value).toBe(8);
    expect(fields.fix_quality.value).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports an acquiring state (fix_quality, no position) when NMEA streams without a lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xorgate-gps-"));
    const file = join(dir, "nmea.txt");
    // GGA with empty lat/lon, fix quality 0, 0 satellites — the indoor case.
    await writeFile(file, "$GPGGA,083745.000,,,,,0,00,,,M,,M,,\n");

    vi.stubEnv("GPS_NMEA_PORT", file);
    vi.resetModules();
    const { createGpsCollector } = await import("../src/agent/collectors/gps.js");
    const collector = createGpsCollector();

    const fields = await readUntilFix(collector);
    expect(fields.fix_quality).toEqual({ value: 0 });
    expect(fields.satellites).toEqual({ value: 0 });
    expect(fields.lat).toBeUndefined();
    expect(fields.lon).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when the NMEA port is absent", async () => {
    vi.stubEnv("GPS_NMEA_PORT", join(tmpdir(), "xorgate-no-such-nmea-port"));
    vi.resetModules();
    const { createGpsCollector } = await import("../src/agent/collectors/gps.js");
    const collector = createGpsCollector();
    // First read kicks off the (failing) open; it must never throw and stays {}.
    expect(await collector.read()).toEqual({});
    await new Promise((r) => setTimeout(r, 30));
    expect(await collector.read()).toEqual({});
  });
});
