import { describe, expect, it } from "vitest";
import {
  computeCpuLoad,
  parseDf,
  parseMemAvailable,
  type CpuSample,
} from "../src/hardware/system.js";
import { createSystemCollector } from "../src/agent/collectors/system.js";

/** Build a single-core CpuSample with the given tick counters. */
function core(times: Partial<CpuSample[number]["times"]>): CpuSample {
  return [
    {
      model: "test",
      speed: 1000,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
    },
  ];
}

describe("parseMemAvailable", () => {
  it("extracts MemTotal/MemAvailable in bytes", () => {
    const parsed = parseMemAvailable(
      "MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\n",
    );
    expect(parsed).toEqual({
      totalBytes: 8000000 * 1024,
      availableBytes: 6000000 * 1024,
    });
  });

  it("returns null when MemAvailable is missing", () => {
    expect(parseMemAvailable("MemTotal:        8000000 kB\n")).toBeNull();
  });
});

describe("computeCpuLoad", () => {
  it("computes busy% from two snapshots (half-busy single core)", () => {
    // prev: all idle (total 100). curr: +50 user, +50 idle (total 200) →
    // busy = (Δtotal − Δidle)/Δtotal = (100 − 50)/100 = 50%.
    const prev = core({ idle: 100 });
    const curr = core({ user: 50, idle: 150 });
    const load = computeCpuLoad(prev, curr);
    expect(load.overall).toBe(50);
    expect(load.perCore).toEqual([50]);
  });

  it("reports 0 when no ticks elapsed", () => {
    const sample = core({ user: 10, idle: 90 });
    expect(computeCpuLoad(sample, sample).overall).toBe(0);
  });

  it("averages across cores", () => {
    const prev: CpuSample = [...core({ idle: 100 }), ...core({ idle: 100 })];
    // core 0 fully busy (+100 user), core 1 fully idle (+100 idle).
    const curr: CpuSample = [...core({ user: 100, idle: 100 }), ...core({ idle: 200 })];
    expect(computeCpuLoad(prev, curr).overall).toBe(50);
  });
});

describe("parseDf", () => {
  it("computes usedPct from a df -kP block", () => {
    const out =
      "Filesystem     1024-blocks    Used Available Capacity Mounted on\n" +
      "/dev/root         100000   25000     75000      25% /\n";
    const info = parseDf(out);
    expect(info?.usedPct).toBe(25);
    expect(info?.totalBytes).toBe(100000 * 1024);
    expect(info?.usedBytes).toBe(25000 * 1024);
  });

  it("returns null on a header-only / malformed block", () => {
    expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
    expect(parseDf("")).toBeNull();
  });
});

describe("createSystemCollector", () => {
  it("emits cpu_usage and ram_usage as percent leaves on every host", async () => {
    const collector = createSystemCollector();
    expect(collector.group).toBe("system");

    const fields = (await collector.read()) as Record<
      string,
      { value: number; unit?: string }
    >;

    // cpu_usage + ram_usage are guaranteed cross-platform (os fallback never
    // fails). cpu_temp/disk_usage are host-dependent, so we don't assert them.
    expect(fields.cpu_usage.unit).toBe("%");
    expect(Number.isFinite(fields.cpu_usage.value)).toBe(true);
    expect(fields.cpu_usage.value).toBeGreaterThanOrEqual(0);
    expect(fields.cpu_usage.value).toBeLessThanOrEqual(100);

    expect(fields.ram_usage.unit).toBe("%");
    expect(Number.isFinite(fields.ram_usage.value)).toBe(true);
    expect(fields.ram_usage.value).toBeGreaterThanOrEqual(0);
    expect(fields.ram_usage.value).toBeLessThanOrEqual(100);
  });
});
