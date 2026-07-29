import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BootDeferPolicy,
  decideBootDefer,
  LoadShedPolicy,
  TELEMETRY_STALE_MS,
  type BootDeferConfig,
  type BootDeferInputs,
  type PowerSampleReading,
  type ShedConfig,
  type ShedVerdict,
} from "../src/recording/boot-policy.js";
import { cleanup, tempHome } from "./helpers.js";

const CFG: BootDeferConfig = { mode: "auto", maxSecs: 90, minBudgetMa: 5000 };

/** Inputs for a freshly-armed defer: constrained budget, fresh connecting telemetry. */
function inputs(over: Partial<BootDeferInputs> = {}): BootDeferInputs {
  const now = 1_000_000_000_000;
  return {
    budgetMa: 3000,
    telemetry: { timestamp: new Date(now - 1000).toISOString(), status: "connecting", reg: 0 },
    nowMs: now,
    elapsedMs: 10_000,
    staleMs: TELEMETRY_STALE_MS,
    ...over,
  };
}

describe("decideBootDefer", () => {
  it("mode=off and maxSecs=0 both disable the feature (today's behavior)", () => {
    expect(decideBootDefer({ ...CFG, mode: "off" }, inputs())).toMatchObject({
      allow: true,
      state: "off",
    });
    expect(decideBootDefer({ ...CFG, maxSecs: 0 }, inputs())).toMatchObject({
      allow: true,
      state: "off",
    });
  });

  it("auto skips at/above the budget threshold, arms below it", () => {
    const skip = decideBootDefer(CFG, inputs({ budgetMa: 5000 }));
    expect(skip).toMatchObject({ allow: true, state: "skipped" });
    expect(skip.why).toBe("psu budget 5000mA >= 5000");

    const arm = decideBootDefer(CFG, inputs({ budgetMa: 3000 }));
    expect(arm).toMatchObject({ allow: false, state: "deferring" });
    expect(arm.why).toBe("psu budget 3000mA < 5000");
  });

  it("auto honors an EEPROM-override threshold (>= semantics, not == 5000)", () => {
    expect(
      decideBootDefer({ ...CFG, minBudgetMa: 4000 }, inputs({ budgetMa: 4000 })),
    ).toMatchObject({ allow: true, state: "skipped" });
    expect(decideBootDefer(CFG, inputs({ budgetMa: 4000 }))).toMatchObject({
      allow: false,
      state: "deferring",
    });
  });

  it("unreadable budget keeps the defer armed in auto (cap still bounds it)", () => {
    const v = decideBootDefer(CFG, inputs({ budgetMa: null }));
    expect(v).toMatchObject({ allow: false, state: "deferring" });
    expect(v.why).toBe("psu budget unknown < 5000");
  });

  it("always arms regardless of a 5 A budget", () => {
    const v = decideBootDefer({ ...CFG, mode: "always" }, inputs({ budgetMa: 5000 }));
    expect(v).toMatchObject({ allow: false, state: "deferring", why: "mode=always" });
  });

  it("releases on connected and dead_zone (terminal modem verdicts)", () => {
    for (const status of ["connected", "dead_zone"]) {
      const v = decideBootDefer(
        CFG,
        inputs({ telemetry: { ...inputs().telemetry, status } as BootDeferInputs["telemetry"] }),
      );
      expect(v).toMatchObject({ allow: true, state: "released", why: status });
    }
  });

  it("releases on reg 1/5 while connecting, keeps deferring otherwise", () => {
    const t = inputs().telemetry!;
    expect(decideBootDefer(CFG, inputs({ telemetry: { ...t, reg: 1 } }))).toMatchObject({
      allow: true,
      why: "reg",
    });
    expect(decideBootDefer(CFG, inputs({ telemetry: { ...t, reg: 5 } }))).toMatchObject({
      allow: true,
      why: "reg",
    });
    // reg 2 (searching) / 99 (unknown) do not release
    expect(decideBootDefer(CFG, inputs({ telemetry: { ...t, reg: 2 } })).allow).toBe(false);
    // reg 1 with a status that is not "connecting" does not release either
    expect(
      decideBootDefer(CFG, inputs({ telemetry: { ...t, status: "disconnected", reg: 1 } })).allow,
    ).toBe(false);
  });

  it("fails open when telemetry.json is stale (>60 s) or has a bad timestamp", () => {
    const now = inputs().nowMs;
    const staleTs = new Date(now - TELEMETRY_STALE_MS - 5000).toISOString();
    expect(
      decideBootDefer(
        CFG,
        inputs({ telemetry: { timestamp: staleTs, status: "connecting", reg: 0 } }),
      ),
    ).toMatchObject({ allow: true, state: "released", why: "stale" });
    expect(
      decideBootDefer(CFG, inputs({ telemetry: { timestamp: 42, status: "connecting" } })),
    ).toMatchObject({ allow: true, why: "stale" });
  });

  it("missing file gets the stale grace window, then fails open", () => {
    expect(decideBootDefer(CFG, inputs({ telemetry: null, elapsedMs: 30_000 }))).toMatchObject({
      allow: false,
      state: "deferring",
    });
    expect(decideBootDefer(CFG, inputs({ telemetry: null, elapsedMs: 61_000 }))).toMatchObject({
      allow: true,
      state: "released",
      why: "stale",
    });
  });

  it("hard cap releases with 'timeout' even against fresh connecting telemetry", () => {
    const v = decideBootDefer(CFG, inputs({ elapsedMs: 90_000 }));
    expect(v).toMatchObject({ allow: true, state: "released", why: "timeout" });
  });

  it("a shortened maxSecs releases an active defer (live-tunable cap)", () => {
    expect(decideBootDefer(CFG, inputs({ elapsedMs: 20_000 })).allow).toBe(false);
    expect(decideBootDefer({ ...CFG, maxSecs: 15 }, inputs({ elapsedMs: 20_000 }))).toMatchObject({
      allow: true,
      why: "timeout",
    });
  });
});

describe("BootDeferPolicy", () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = tempHome();
    dir = join(home, "policy");
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => cleanup(home));

  function writeBudget(ma: number): string {
    const path = join(dir, "max_current");
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(ma, 0);
    writeFileSync(path, buf);
    return path;
  }

  function writeTelemetry(obj: Record<string, unknown>): string {
    const path = join(dir, "telemetry.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  }

  it("reads budget + telemetry from disk and defers, then releases and LATCHES", () => {
    let now = 1_000_000;
    const budgetPath = writeBudget(3000);
    const telemetryFile = writeTelemetry({
      timestamp: new Date(now).toISOString(),
      status: "connecting",
      reg: 0,
    });
    const policy = new BootDeferPolicy({ telemetryFile, budgetPath, now: () => now });

    expect(policy.evaluate(CFG).allow).toBe(false);
    expect(policy.statusString()).toBe("deferring");

    now += 10_000;
    writeTelemetry({ timestamp: new Date(now).toISOString(), status: "connected", reg: 1 });
    expect(policy.evaluate(CFG)).toMatchObject({ allow: true, why: "connected" });
    expect(policy.statusString()).toBe("released:connected");

    // Latched: even if the file regresses to connecting, the verdict stands.
    writeTelemetry({ timestamp: new Date(now).toISOString(), status: "connecting", reg: 0 });
    expect(policy.evaluate(CFG).allow).toBe(true);
  });

  it("skips on a 5 A budget without ever reading telemetry", () => {
    const budgetPath = writeBudget(5000);
    const policy = new BootDeferPolicy({
      telemetryFile: join(dir, "does-not-exist.json"),
      budgetPath,
    });
    expect(policy.evaluate(CFG)).toMatchObject({ allow: true, state: "skipped" });
    expect(policy.statusString()).toBe("skipped");
  });

  it("missing budget node (dev box) arms; corrupt telemetry counts as missing", () => {
    let now = 5_000_000;
    const telemetryFile = join(dir, "telemetry.json");
    writeFileSync(telemetryFile, "{not json");
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath: join(dir, "absent"),
      now: () => now,
    });
    expect(policy.evaluate(CFG).allow).toBe(false);
    // ...and the missing-file grace still fails open at the stale window.
    now += TELEMETRY_STALE_MS + 1000;
    expect(policy.evaluate(CFG)).toMatchObject({ allow: true, why: "stale" });
  });

  it("statusString is null before the first evaluation", () => {
    const policy = new BootDeferPolicy({ budgetPath: join(dir, "absent") });
    expect(policy.statusString()).toBeNull();
  });
});

describe("LoadShedPolicy (Phase 3 runtime undervoltage shedding)", () => {
  /** The Q4 starting values (mirrors RECORDING_DEFAULTS.powerShedding). */
  const CFG: ShedConfig = {
    enabled: true,
    uvSamples: 3,
    uvWindowSecs: 30,
    railLowVolts: 4.85,
    railLowSecs: 15,
    escalateDwellSecs: 60,
    restoreSecs: 120,
    railRestoreVolts: 4.95,
    maxShedsPerHour: 4,
  };

  /** Fake-clocked policy + a tick() that mimics the manager's 1 Hz loop. */
  function makePolicy() {
    const clock = { now: 0 };
    const policy = new LoadShedPolicy({ now: () => clock.now });
    const tick = (secs: number, reading: PowerSampleReading, cfg: ShedConfig = CFG) => {
      let last!: ShedVerdict;
      const events: string[] = [];
      for (let i = 0; i < secs; i++) {
        clock.now += 1000;
        policy.push(reading);
        last = policy.evaluate(cfg);
        if (last.event) events.push(last.event.msg);
      }
      return { last, events };
    };
    return { clock, policy, tick };
  }

  it("healthy samples never shed", () => {
    const { policy, tick } = makePolicy();
    const { last } = tick(120, { uv: false, railV: 5.05 });
    expect(last.level).toBe(0);
    expect(policy.statusString()).toBeNull();
  });

  it("sheds live (rung 1) on the 3rd UV sample in the window, not before", () => {
    const { policy, tick } = makePolicy();
    tick(1, { uv: true, railV: 5.0 });
    tick(10, { uv: false, railV: 5.0 });
    let r = tick(1, { uv: true, railV: 5.0 });
    expect(r.last.level).toBe(0);
    r = tick(1, { uv: true, railV: 5.0 });
    expect(r.last.level).toBe(1);
    expect(r.events[0]).toContain("no-live");
    expect(r.events[0]).toContain("undervoltage 3x");
    expect(policy.statusString()).toBe("no-live");
  });

  it("UV positives age out of the window (sparse UV never sheds)", () => {
    const { tick } = makePolicy();
    for (let i = 0; i < 3; i++) {
      const r = tick(1, { uv: true, railV: 5.0 });
      expect(r.last.level).toBe(0);
      tick(40, { uv: false, railV: 5.0 });
    }
  });

  it("sustained rail low sheds; a brief sag does not", () => {
    const brief = makePolicy();
    brief.tick(10, { uv: false, railV: 4.8 });
    brief.tick(1, { uv: false, railV: 5.0 }); // healthy reading resets the run
    const r1 = brief.tick(14, { uv: false, railV: 4.8 });
    expect(r1.last.level).toBe(0);

    const sustained = makePolicy();
    const r2 = sustained.tick(16, { uv: false, railV: 4.8 });
    expect(r2.last.level).toBe(1);
    expect(r2.events[0]).toContain("rail 4.80V < 4.85V");
  });

  it("rail trigger requires fresh samples (a dead sampler cannot shed)", () => {
    const { clock, policy, tick } = makePolicy();
    tick(14, { uv: false, railV: 4.7 });
    clock.now += 60_000; // sampler dies; the low run now spans >15 s but is stale
    expect(policy.evaluate(CFG).level).toBe(0);
  });

  it("escalates to bridge-only (rung 2) only after the dwell of continued trigger", () => {
    const { policy, tick } = makePolicy();
    let r = tick(3, { uv: true, railV: 4.7 });
    expect(r.last.level).toBe(1);
    r = tick(59, { uv: true, railV: 4.7 });
    expect(r.last.level).toBe(1); // 59 s after the shed — one short
    r = tick(2, { uv: true, railV: 4.7 });
    expect(r.last.level).toBe(2);
    expect(r.events[0]).toContain("bridge-only");
    expect(policy.statusString()).toBe("bridge-only");
  });

  it("a trigger break resets the escalation dwell", () => {
    const { tick } = makePolicy();
    tick(3, { uv: true, railV: 5.0 }); // shed
    tick(35, { uv: false, railV: 5.0 }); // trigger drops (UV ages out), <120 s so no restore
    let r = tick(3, { uv: true, railV: 5.0 }); // trigger returns
    expect(r.last.level).toBe(1); // still rung 1 — dwell restarted
    r = tick(61, { uv: true, railV: 5.0 });
    expect(r.last.level).toBe(2);
  });

  it("restores one rung per clean interval; a sub-restore rail blocks it", () => {
    const { policy, tick } = makePolicy();
    tick(3, { uv: true, railV: 4.7 });
    tick(62, { uv: true, railV: 4.7 });
    expect(policy.statusString()).toBe("bridge-only");
    // 4.90 V: above the trigger threshold but below restore — hysteresis holds.
    let r = tick(130, { uv: false, railV: 4.9 });
    expect(r.last.level).toBe(2);
    r = tick(119, { uv: false, railV: 5.02 });
    expect(r.last.level).toBe(2); // one second short of the clean interval
    r = tick(2, { uv: false, railV: 5.02 });
    expect(r.last.level).toBe(1);
    expect(r.events[0]).toContain("restore → no-live");
    r = tick(121, { uv: false, railV: 5.02 });
    expect(r.last.level).toBe(0);
    expect(r.events[0]).toContain("restore → full");
    expect(policy.statusString()).toBeNull();
  });

  it("shed-cycle cap parks at the shed level (no flapping)", () => {
    const cfg: ShedConfig = { ...CFG, maxShedsPerHour: 1, restoreSecs: 10 };
    const { policy, tick } = makePolicy();
    tick(3, { uv: true, railV: 5.0 }, cfg); // cycle 1
    expect(policy.statusString()).toBe("no-live");
    tick(45, { uv: false, railV: 5.02 }, cfg); // UV ages out + clean interval → restored
    expect(policy.statusString()).toBeNull();
    const r = tick(3, { uv: true, railV: 5.0 }, cfg); // cycle 2 exceeds the 1/h cap
    expect(r.last).toMatchObject({ level: 1, parked: true });
    expect(r.events[0]).toContain("parked until reboot or settings change");
    tick(600, { uv: false, railV: 5.05 }, cfg);
    expect(policy.statusString()).toBe("parked:no-live"); // parked: never restores
  });

  it("disabling via settings restores immediately and reports once", () => {
    const { policy, tick } = makePolicy();
    tick(3, { uv: true, railV: 4.7 });
    const off: ShedConfig = { ...CFG, enabled: false };
    let v = policy.evaluate(off);
    expect(v).toMatchObject({ level: 0, parked: false });
    expect(v.event?.msg).toContain("disabled");
    v = policy.evaluate(off);
    expect(v.event).toBeNull();
  });

  it("fails open: a shed device whose sampler dies restores on the clean interval", () => {
    const { clock, policy, tick } = makePolicy();
    tick(3, { uv: true, railV: 4.7 });
    clock.now += 121_000; // no samples at all for 2 minutes
    expect(policy.evaluate(CFG).level).toBe(0);
  });

  it("reset() clears park and level (settings-change escape hatch)", () => {
    const cfg: ShedConfig = { ...CFG, maxShedsPerHour: 0 };
    const { policy, tick } = makePolicy();
    const r = tick(3, { uv: true, railV: 5.0 }, cfg);
    expect(r.last.parked).toBe(true);
    policy.reset();
    expect(policy.evaluate(cfg)).toMatchObject({ level: 0, parked: false });
    expect(policy.statusString()).toBeNull();
  });
});
