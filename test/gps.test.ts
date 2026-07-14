import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Collector } from "../src/agent/collectors/index.js";

const NMEA =
  [
    "$GPGGA,083745.000,1430.1234,N,12101.5678,E,1,08,0.9,545.4,M,46.9,M,,*56",
    "$GPRMC,083745.000,A,1430.1234,N,12101.5678,E,0.06,31.66,130626,,,A*5A",
    "$GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1*39",
    "$GPGSV,3,1,11,03,03,111,00,04,15,270,00*7F",
    "$GLGSV,2,1,08,65,50,100,40,66,30,200,35*6A",
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
    expect(fields.hdop).toEqual({ value: 1.3 });
    expect(fields.satellites_in_view).toEqual({ value: 19 }); // 11 GPS + 8 GLONASS

    await rm(dir, { recursive: true, force: true });
  });

  it("drops the stale position (not the group) after the lock is lost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xorgate-gps-"));
    const file = join(dir, "nmea.txt");
    // A good fix, then the lock drops (GGA quality 0, empty position fields).
    await writeFile(file, NMEA + "$GPGGA,083750.000,,,,,0,00,,,M,,M,,*71\n");

    vi.stubEnv("GPS_NMEA_PORT", file);
    vi.resetModules();
    const { createGpsCollector } = await import("../src/agent/collectors/gps.js");
    const collector = createGpsCollector();

    // Poll until the final (lock-lost) state lands: quality 0 and no position.
    let fields: Record<string, Leaf> = {};
    for (let i = 0; i < 50; i++) {
      fields = (await collector.read()) as Record<string, Leaf>;
      if (fields.fix_quality?.value === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fields.fix_quality).toEqual({ value: 0 });
    expect(fields.lat).toBeUndefined();
    expect(fields.lon).toBeUndefined();
    expect(fields.alt).toBeUndefined();
    expect(fields.speed).toBeUndefined();
    // Diagnostics survive so the UI can show a meaningful "acquiring" state.
    expect(fields.satellites_in_view).toEqual({ value: 19 });

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

  it("destroys and reopens a silently-dead stream (modem USB re-enumeration)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xorgate-gps-"));
    const fifo = join(dir, "nmea.fifo");
    // A FIFO with no writer: the open never completes and no data/error/close
    // ever arrives — the same observable behavior as a tty fd orphaned by a
    // modem USB re-enumeration.
    execFileSync("mkfifo", [fifo]);

    vi.stubEnv("GPS_NMEA_PORT", fifo);
    vi.resetModules();
    const { createGpsCollector } = await import("../src/agent/collectors/gps.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collector = createGpsCollector(40); // reopen after 40 ms of silence
      expect(await collector.read()).toEqual({}); // opens the (silent) stream
      await new Promise((r) => setTimeout(r, 60));
      expect(await collector.read()).toEqual({}); // watchdog: destroy
      expect(warn).toHaveBeenCalledWith("[gps] NMEA silent too long — reopening the port");
      warn.mockClear();
      expect(await collector.read()).toEqual({}); // next tick: reopen
      // The reopened stream is silent again — the watchdog must fire again
      // (proves the reopen actually re-armed rather than wedged).
      await new Promise((r) => setTimeout(r, 60));
      expect(await collector.read()).toEqual({});
      expect(warn).toHaveBeenCalledWith("[gps] NMEA silent too long — reopening the port");
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
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
