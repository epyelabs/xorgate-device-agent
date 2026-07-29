import { describe, expect, it } from "vitest";
import {
  createClockStepper,
  parseCclkUtcMs,
  readModemClock,
  resolveTimeSyncConfig,
  TIME_SYNC_DEFAULTS,
  type ClockStepperOptions,
  type ModemClockReading,
  type TimeSyncConfig,
} from "../src/agent/clock-step.js";
import type { GpsClockReading } from "../src/agent/collectors/gps.js";
import type { ModemTelemetry } from "../src/hardware/modem.js";

describe("parseCclkUtcMs", () => {
  it("converts local time + quarter-hour zone to UTC (EDT example)", () => {
    // 2026-07-29 15:26:30 local, zone -16 quarter hours = UTC-4 → 19:26:30Z.
    expect(parseCclkUtcMs("26/07/29,15:26:30-16")).toBe(Date.UTC(2026, 6, 29, 19, 26, 30));
  });

  it("handles positive zones and strips surrounding whitespace", () => {
    // +08 quarter hours = UTC+2 → local minus 2 h.
    expect(parseCclkUtcMs(" 26/01/02,01:00:00+08 ")).toBe(Date.UTC(2026, 0, 1, 23, 0, 0));
  });

  it("rejects a zone-less value (local time can't be anchored to UTC)", () => {
    expect(parseCclkUtcMs("26/07/29,15:26:30")).toBeNull();
  });

  it("rejects malformed fields", () => {
    expect(parseCclkUtcMs("")).toBeNull();
    expect(parseCclkUtcMs("garbage")).toBeNull();
    expect(parseCclkUtcMs("26/13/29,15:26:30-16")).toBeNull(); // month 13
    expect(parseCclkUtcMs("26/07/29,24:26:30-16")).toBeNull(); // hour 24
  });

  it("parses a never-NITZ'd 1980 clock (plausibility rejection is the stepper's)", () => {
    // The SIM7600 default epoch parses fine — year 80 maps into 2080, which
    // the stepper's [2025, 2100) window happens to allow numerically; the
    // stepper additionally never sees it because the offset would be decades.
    expect(parseCclkUtcMs("80/01/06,00:00:00+00")).toBe(Date.UTC(2080, 0, 6));
  });
});

describe("readModemClock", () => {
  const NOW = Date.UTC(2026, 6, 29, 19, 30, 0);
  const telemetryWith = (mc: ModemTelemetry["modem_clock"]): (() => Promise<ModemTelemetry | null>) =>
    async () =>
      ({ timestamp: "", csq: 20, rssi_dbm: -73, csq_interval: 30, status: "connected", iface: "usb0", ip: null, modem_clock: mc }) as ModemTelemetry;

  it("reduces a fresh cclk + read_at pair to a clock offset", async () => {
    // Modem says 19:26:35Z at device-clock 19:26:30 → offset +5 s.
    const readAt = Math.floor(Date.UTC(2026, 6, 29, 19, 26, 30) / 1000);
    const r = await readModemClock(NOW, telemetryWith({ cclk: "26/07/29,15:26:35-16", read_at: readAt }));
    expect(r?.offsetMs).toBe(5000);
  });

  it("returns null when the reading is stale, from the future, absent, or unparseable", async () => {
    const staleAt = Math.floor((NOW - 6 * 60_000) / 1000);
    expect(await readModemClock(NOW, telemetryWith({ cclk: "26/07/29,15:26:35-16", read_at: staleAt }))).toBeNull();
    const futureAt = Math.floor((NOW + 60_000) / 1000);
    expect(await readModemClock(NOW, telemetryWith({ cclk: "26/07/29,15:26:35-16", read_at: futureAt }))).toBeNull();
    expect(await readModemClock(NOW, telemetryWith(null))).toBeNull();
    expect(await readModemClock(NOW, async () => null)).toBeNull();
    expect(await readModemClock(NOW, telemetryWith({ cclk: "garbage", read_at: Math.floor(NOW / 1000) }))).toBeNull();
  });
});

describe("resolveTimeSyncConfig", () => {
  it("applies defaults and overrides", () => {
    expect(resolveTimeSyncConfig()).toEqual(TIME_SYNC_DEFAULTS);
    expect(resolveTimeSyncConfig({ offlineSources: false, stepThresholdSecs: 30 })).toEqual({
      offlineSources: false,
      stepThresholdSecs: 30,
      maxStepsPerBoot: TIME_SYNC_DEFAULTS.maxStepsPerBoot,
    });
  });
});

/** Harness: a stepper with everything faked and a manually advanced clock pair. */
function makeHarness(over: {
  config?: Partial<TimeSyncConfig>;
  /** Static config overrides win; this makes config() fully dynamic instead. */
  liveConfig?: () => TimeSyncConfig;
  gps?: (wallNow: () => number) => GpsClockReading | null;
  modem?: ModemClockReading | null;
  ntpSynced?: () => boolean;
  applyOk?: boolean;
  startWallMs?: number;
} = {}) {
  let wall = over.startWallMs ?? Date.UTC(2026, 6, 29, 12, 0, 0);
  let mono = 100_000;
  const wallNow = (): number => wall;
  const applied: number[] = [];
  const stepped: Array<{ source: string; offsetMs: number }> = [];
  const events: string[] = [];
  const opts: ClockStepperOptions = {
    config: over.liveConfig ?? (() => ({ ...TIME_SYNC_DEFAULTS, ...over.config })),
    gpsClock: () => over.gps?.(wallNow) ?? null,
    modemClock: async () => over.modem ?? null,
    probeNtpSynced: async () => over.ntpSynced?.() ?? false,
    applyStep: async (targetMs) => {
      applied.push(targetMs);
      if (over.applyOk === false) return { ok: false, detail: "sudo: a password is required" };
      wall = targetMs; // a real step moves the wall clock
      return { ok: true, detail: "" };
    },
    onStepped: (source, offsetMs) => stepped.push({ source, offsetMs }),
    onEvent: (_level, msg) => events.push(msg),
    now: wallNow,
    monoMs: () => mono,
  };
  const stepper = createClockStepper(opts);
  return {
    stepper,
    applied,
    stepped,
    events,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    wallNow,
  };
}

const GPS_AHEAD =
  (aheadMs: number, base: number, valid = true) =>
  (): GpsClockReading => ({ utcMs: base + aheadMs, ageMs: 0, valid });

describe("createClockStepper", () => {
  const BASE = Date.UTC(2026, 6, 29, 12, 0, 0);

  it("steps from a valid GPS time when the offset exceeds the threshold", async () => {
    const h = makeHarness({ gps: GPS_AHEAD(5 * 60_000, BASE), startWallMs: BASE });
    await h.stepper.tick();
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toBe(BASE + 5 * 60_000);
    expect(h.stepped).toEqual([{ source: "gps", offsetMs: 5 * 60_000 }]);
    expect(h.stepper.status().steps).toBe(1);
    expect(h.events.some((e) => e.includes("stepped system clock +300.0s from gps"))).toBe(true);
  });

  it("ignores GPS below the threshold and an invalid-fix GPS time", async () => {
    const below = makeHarness({ gps: GPS_AHEAD(5_000, BASE), startWallMs: BASE });
    await below.stepper.tick();
    expect(below.applied).toHaveLength(0);

    // Invalid fix + no modem clock → nothing to act on.
    const invalid = makeHarness({ gps: GPS_AHEAD(5 * 60_000, BASE, false), startWallMs: BASE });
    await invalid.stepper.tick();
    expect(invalid.applied).toHaveLength(0);
  });

  it("falls back to NITZ when GPS is absent or fixless", async () => {
    const h = makeHarness({
      gps: GPS_AHEAD(5 * 60_000, BASE, false),
      modem: { offsetMs: -2 * 60_000 },
      startWallMs: BASE,
    });
    await h.stepper.tick();
    expect(h.applied).toEqual([BASE - 2 * 60_000]);
    expect(h.stepped).toEqual([{ source: "nitz", offsetMs: -2 * 60_000 }]);
  });

  it("disarms permanently once NTP reports synchronized", async () => {
    let synced = false;
    const h = makeHarness({ gps: GPS_AHEAD(5 * 60_000, BASE), ntpSynced: () => synced, startWallMs: BASE });
    synced = true;
    await h.stepper.tick();
    expect(h.applied).toHaveLength(0);
    expect(h.stepper.status().armed).toBe(false);
    expect(h.events.some((e) => e.includes("stood down"))).toBe(true);
    // Even if the flag were to lie later, a disarmed stepper never re-evaluates.
    synced = false;
    await h.stepper.tick();
    expect(h.applied).toHaveLength(0);
  });

  it("does nothing while the kill switch is off but stays armed for a live re-enable", async () => {
    let enabled = false;
    const h = makeHarness({
      liveConfig: () => ({ ...TIME_SYNC_DEFAULTS, offlineSources: enabled }),
      gps: GPS_AHEAD(5 * 60_000, BASE),
      startWallMs: BASE,
    });
    await h.stepper.tick();
    expect(h.applied).toHaveLength(0);
    expect(h.stepper.status().armed).toBe(true);
    enabled = true; // settings.json flips on — the next tick acts
    await h.stepper.tick();
    expect(h.applied).toHaveLength(1);
  });

  it("holds off after a step and enforces the per-boot cap with a single warn", async () => {
    // GPS reads a constant +5 min ahead of the MOVING wall clock, so every
    // evaluation wants to step — only hold-off and the cap prevent it.
    const h = makeHarness({
      config: { maxStepsPerBoot: 2 },
      gps: (wallNow) => ({ utcMs: wallNow() + 5 * 60_000, ageMs: 0, valid: true }),
      startWallMs: BASE,
    });

    await h.stepper.tick();
    expect(h.applied).toHaveLength(1);
    // Immediately after: held off despite the source still reporting drift.
    await h.stepper.tick();
    expect(h.applied).toHaveLength(1);
    // Past the hold-off: second step allowed (cap 2).
    h.advance(6 * 60_000);
    await h.stepper.tick();
    expect(h.applied).toHaveLength(2);
    // Past further hold-offs: cap reached — no third step, one warn only.
    h.advance(6 * 60_000);
    await h.stepper.tick();
    h.advance(6 * 60_000);
    await h.stepper.tick();
    expect(h.applied).toHaveLength(2);
    expect(h.events.filter((e) => e.includes("step cap reached"))).toHaveLength(1);
  });

  it("rejects an implausible target and backs off instead of spamming", async () => {
    // A never-NITZ'd modem clock stuck in 1980 → target far before 2025.
    const h = makeHarness({
      modem: { offsetMs: Date.UTC(1980, 0, 6) - BASE },
      startWallMs: BASE,
    });
    await h.stepper.tick();
    await h.stepper.tick();
    expect(h.applied).toHaveLength(0);
    expect(h.events.filter((e) => e.includes("implausible"))).toHaveLength(1);
  });

  it("logs a failed apply (missing sudoers) without counting a step, then holds off", async () => {
    const h = makeHarness({ gps: GPS_AHEAD(5 * 60_000, BASE), applyOk: false, startWallMs: BASE });
    await h.stepper.tick();
    expect(h.stepper.status().steps).toBe(0);
    expect(h.stepped).toHaveLength(0);
    expect(h.events.some((e) => e.includes("step from gps failed"))).toBe(true);
    // Held off — no immediate retry hammering sudo.
    await h.stepper.tick();
    expect(h.applied).toHaveLength(1);
  });

  it("survives a throwing dependency (fail open, logged)", async () => {
    const stepper = createClockStepper({
      config: () => TIME_SYNC_DEFAULTS,
      gpsClock: () => {
        throw new Error("boom");
      },
      probeNtpSynced: async () => false,
      onEvent: () => {},
      now: () => BASE,
      monoMs: () => 0,
    });
    await expect(stepper.tick()).resolves.toBeUndefined();
    expect(stepper.status().steps).toBe(0);
  });
});
