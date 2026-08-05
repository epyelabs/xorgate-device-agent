import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BootDeferPolicy,
  computeShedSignals,
  decideBootDefer,
  LoadShedPolicy,
  TELEMETRY_STALE_MS,
  type BootDeferConfig,
  type BootDeferInputs,
  type PowerSampleReading,
  type ShedConfig,
  type ShedVerdict,
} from "../src/recording/boot-policy.js";
import { powerReadingFromFields } from "../src/agent/collectors/index.js";
import { cleanup, tempHome } from "./helpers.js";

// Stage 1 only: the Phase 7 gate has its own describe block below.
const CFG: BootDeferConfig = {
  mode: "auto",
  maxSecs: 90,
  minBudgetMa: 5000,
  gateMode: "off",
  gateMaxSecs: 600,
  gateNoProgressSecs: 0,
};

/** Inputs for a freshly-armed defer: constrained budget, fresh connecting telemetry. */
function inputs(over: Partial<BootDeferInputs> = {}): BootDeferInputs {
  const now = 1_000_000_000_000;
  return {
    budgetMa: 3000,
    telemetry: { timestamp: new Date(now - 1000).toISOString(), status: "connecting", reg: 0 },
    nowMs: now,
    elapsedMs: 10_000,
    // Freshly-rewritten file by default: the clock-step guard is exercised
    // explicitly in its own cases below.
    telemetryUnchangedMs: 0,
    staleMs: TELEMETRY_STALE_MS,
    // No GNSS view by default — the gate cases below supply one.
    gnss: null,
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
        inputs({
          telemetry: { timestamp: staleTs, status: "connecting", reg: 0 },
          telemetryUnchangedMs: TELEMETRY_STALE_MS + 5000,
        }),
      ),
    ).toMatchObject({ allow: true, state: "released", why: "stale" });
    expect(
      decideBootDefer(CFG, inputs({ telemetry: { timestamp: 42, status: "connecting" } })),
    ).toMatchObject({ allow: true, why: "stale" });
  });

  it("a clock STEP cannot forge a dead daemon (Phase 6 monotonic guard)", () => {
    // The iteration-1 field case: the wall clock jumped decades forward, so
    // telemetry.json's stamp reads ancient — but the daemon is alive and keeps
    // rewriting it, which the monotonic arm sees.
    const now = inputs().nowMs;
    const ancient = new Date(now - 53 * 365 * 24 * 3600_000).toISOString();
    expect(
      decideBootDefer(
        CFG,
        inputs({
          telemetry: { timestamp: ancient, status: "connecting", reg: 0 },
          telemetryUnchangedMs: 2_000,
        }),
      ),
    ).toMatchObject({ allow: false, state: "deferring" });
    // Same file, now genuinely stagnant → the daemon really is gone.
    expect(
      decideBootDefer(
        CFG,
        inputs({
          telemetry: { timestamp: ancient, status: "connecting", reg: 0 },
          telemetryUnchangedMs: TELEMETRY_STALE_MS + 1,
        }),
      ),
    ).toMatchObject({ allow: true, state: "released", why: "stale" });
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

/**
 * Stage 2 — the GPS/LTE video gate (Phase 7 / Q8). Arms like stage 1 and, while
 * armed, SUPERSEDES it: a gated boot never releases on `reg` or the stage-1 cap.
 */
describe("decideBootDefer — GPS/LTE gate (Phase 7)", () => {
  const GATE: BootDeferConfig = {
    mode: "auto",
    maxSecs: 90,
    minBudgetMa: 5000,
    gateMode: "auto",
    gateMaxSecs: 600,
    // Off by default in this block so the pre-existing cases keep testing the
    // arms they were written for; the escape hatch has its own cases below.
    gateNoProgressSecs: 0,
  };
  /** Constrained budget, LTE connected, no fix yet, sky says be patient. */
  function gateInputs(over: Partial<BootDeferInputs> = {}): BootDeferInputs {
    const now = 1_000_000_000_000;
    return {
      budgetMa: 3000,
      telemetry: { timestamp: new Date(now - 1000).toISOString(), status: "connected", reg: 1 },
      nowMs: now,
      elapsedMs: 30_000,
      telemetryUnchangedMs: 0,
      staleMs: TELEMETRY_STALE_MS,
      gnss: { fix: false, sky: "clear" },
      ...over,
    };
  }

  it("holds video AND live while LTE is up but the fix has not landed", () => {
    expect(decideBootDefer(GATE, gateInputs())).toMatchObject({
      allow: false,
      state: "gating",
      holdLive: true,
      why: "psu budget 3000mA < 5000",
    });
  });

  it("releases on LTE connected + GPS fix (the happy path)", () => {
    expect(
      decideBootDefer(GATE, gateInputs({ gnss: { fix: true, sky: "clear" } })),
    ).toMatchObject({ allow: true, state: "released", why: "gps-fix", holdLive: false });
  });

  it("a fix alone does not release while LTE is still connecting", () => {
    const stillAttaching = gateInputs({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "connecting", reg: 1 },
      gnss: { fix: true, sky: "clear" },
    });
    // This is exactly the input stage 1 alone WOULD have released on (`reg`) —
    // which is the point: the gate supersedes it.
    expect(decideBootDefer({ ...GATE, gateMode: "off" }, stillAttaching)).toMatchObject({
      allow: true,
      why: "reg",
    });
    expect(decideBootDefer(GATE, stillAttaching)).toMatchObject({ allow: false, state: "gating" });
  });

  it("releases on a declared dead zone (the modem gave up on LTE)", () => {
    const dead = gateInputs({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "dead_zone" },
    });
    expect(decideBootDefer(GATE, dead)).toMatchObject({ allow: true, why: "dead_zone" });
  });

  it("releases on a sustained no-RF sky (a fix is not coming)", () => {
    expect(
      decideBootDefer(GATE, gateInputs({ gnss: { fix: false, sky: "no-rf" } })),
    ).toMatchObject({ allow: true, why: "no-rf" });
    // An obstructed or unknown sky is NOT a release — only the confirmed verdict.
    for (const sky of ["obstructed", "unknown"] as const) {
      expect(decideBootDefer(GATE, gateInputs({ gnss: { fix: false, sky } })).allow).toBe(false);
    }
  });

  it("releases at the give-up cap, and never on the stage-1 cap", () => {
    // Well past bootDeferMaxSecs (90 s) — the gate keeps holding.
    expect(decideBootDefer(GATE, gateInputs({ elapsedMs: 120_000 })).allow).toBe(false);
    expect(decideBootDefer(GATE, gateInputs({ elapsedMs: 600_000 }))).toMatchObject({
      allow: true,
      why: "gate-timeout",
    });
  });

  it("gateMaxSecs 0 means no time cap at all (Q8)", () => {
    const noCap = { ...GATE, gateMaxSecs: 0 };
    expect(decideBootDefer(noCap, gateInputs({ elapsedMs: 86_400_000 })).allow).toBe(false);
    // ... but the other release paths still bound it.
    expect(
      decideBootDefer(noCap, gateInputs({ elapsedMs: 86_400_000, gnss: { fix: false, sky: "no-rf" } })),
    ).toMatchObject({ allow: true, why: "no-rf" });
  });

  it("fails open when the modem daemon is gone", () => {
    expect(decideBootDefer(GATE, gateInputs({ telemetry: null, elapsedMs: 61_000 }))).toMatchObject({
      allow: true,
      why: "stale",
    });
  });

  it("auto is budget-gated; always gates a 5 A device; off is pre-Phase-7 behavior", () => {
    expect(decideBootDefer(GATE, gateInputs({ budgetMa: 5000 }))).toMatchObject({
      allow: true,
      state: "skipped",
    });
    expect(
      decideBootDefer({ ...GATE, gateMode: "always" }, gateInputs({ budgetMa: 5000 })),
    ).toMatchObject({ allow: false, state: "gating", why: "mode=always" });
    // Gate off + stage 1 armed → the plain Phase 2 release on `connected`.
    expect(decideBootDefer({ ...GATE, gateMode: "off" }, gateInputs())).toMatchObject({
      allow: true,
      why: "connected",
      holdLive: false,
    });
  });

  it("arms on its own when the stage-1 defer is switched off", () => {
    expect(
      decideBootDefer({ ...GATE, mode: "off" }, gateInputs()),
    ).toMatchObject({ allow: false, state: "gating" });
  });

  it("cannot arm without a GNSS view — a receiver-less host is never held", () => {
    expect(
      decideBootDefer({ ...GATE, gateMode: "always" }, gateInputs({ gnss: null })),
    ).toMatchObject({ allow: true, why: "connected" });
    expect(
      decideBootDefer({ ...GATE, mode: "off", gateMode: "always" }, gateInputs({ gnss: null })),
    ).toMatchObject({ allow: true, state: "off" });
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
    const policy = new BootDeferPolicy({
      telemetryFile,
      budgetPath,
      now: () => now,
      monoMs: () => now,
    });

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
      monoMs: () => now,
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
    escalateDutyPct: 70,
    cpuTempC: 80,
    cpuTempRestoreC: 70,
    cpuTempSecs: 15,
    restoreSecs: 120,
    railRestoreVolts: 4.95,
    maxShedsPerHour: 4,
  };

  /** Fake-clocked policy + a tick() that mimics the manager's 1 Hz loop. */
  function makePolicy() {
    const clock = { now: 0 };
    const policy = new LoadShedPolicy({ monoMs: () => clock.now });
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

  it("a mostly-clean rung does not escalate (duty stays under the threshold)", () => {
    const { tick } = makePolicy();
    tick(3, { uv: true, railV: 5.0 }); // shed
    tick(35, { uv: false, railV: 5.0 }); // trigger drops (UV ages out), <120 s so no restore
    let r = tick(3, { uv: true, railV: 5.0 }); // trigger returns
    expect(r.last.level).toBe(1);
    // 60 s after the shed the trailing window is only ~⅓ triggered — under 70 %.
    r = tick(20, { uv: true, railV: 5.0 });
    expect(r.last.level).toBe(1);
    // Once the dirty stretch dominates the window again, it escalates.
    r = tick(30, { uv: true, railV: 5.0 });
    expect(r.last.level).toBe(2);
  });

  /**
   * The Phase 6 safety fix, against the 2026-07-30 field evidence: rung 1
   * engaged and the device crashed 13 min later without ever escalating,
   * because the rail bounced back over the threshold every few seconds
   * (recorded 1 Hz samples: ~74 % of samples low, longest UNBROKEN low run
   * 40 s < the 60 s continuous dwell, peaks to 4.96 V so no threshold makes it
   * continuous). This trace reproduces those statistics.
   */
  function bouncingRailTrace(): PowerSampleReading[] {
    const LOW = { uv: false, railV: 4.78 }; // below railLowVolts
    const HIGH = { uv: false, railV: 4.93 }; // bounces back above it
    const out: PowerSampleReading[] = [];
    for (const [low, high] of [
      [40, 11],
      [30, 11],
      [23, 10],
    ] as const) {
      for (let i = 0; i < low; i++) out.push(LOW);
      for (let i = 0; i < high; i++) out.push(HIGH);
    }
    return out; // 125 samples: 93 low (74 %), longest unbroken low run 40 s
  }

  it("escalates on a BOUNCING rail (duty cycle) — the iteration-2 crash case", () => {
    const { policy, tick } = makePolicy();
    // Rung 1 the way the field drive got there: sustained low past railLowSecs.
    const shed = tick(16, { uv: false, railV: 4.78 });
    expect(shed.last.level).toBe(1);

    let level = 1;
    for (const s of bouncingRailTrace()) {
      const r = tick(1, s);
      level = r.last.level;
      if (level === 2) break;
    }
    expect(level).toBe(2);
    expect(policy.statusString()).toBe("bridge-only");
  });

  it("escalateDutyPct=100 reproduces the old continuous-dwell semantics", () => {
    const strict: ShedConfig = { ...CFG, escalateDutyPct: 100 };

    // Same bouncing rail: never escalates, exactly as the field observed.
    const bouncing = makePolicy();
    bouncing.tick(16, { uv: false, railV: 4.78 }, strict);
    for (const s of bouncingRailTrace()) bouncing.tick(1, s, strict);
    expect(bouncing.policy.statusString()).toBe("no-live");

    // A genuinely continuous trigger still escalates at the dwell.
    const steady = makePolicy();
    expect(steady.tick(16, { uv: false, railV: 4.78 }, strict).last.level).toBe(1);
    expect(steady.tick(59, { uv: false, railV: 4.78 }, strict).last.level).toBe(1);
    expect(steady.tick(2, { uv: false, railV: 4.78 }, strict).last.level).toBe(2);
  });

  it("a rung is always observed for a full window before the next one engages", () => {
    // Even a trigger that has been continuously true for ten minutes cannot
    // skip a rung: the duty window is anchored on the rung change.
    const { tick } = makePolicy();
    const r = tick(600, { uv: false, railV: 4.7 });
    expect(r.last.level).toBe(2);
    // rung 1 at ~t=15, rung 2 no earlier than t=75.
    const events = r.events.filter((m) => m.includes("power shed →"));
    expect(events).toHaveLength(2);
    expect(events[1]).toContain("triggered 100% of the last 60s");
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

/**
 * Thermal arm (power_management_improvements plan, Phase 1). A third trigger
 * beside the UV bit and the rail: the SoC at/above `cpuTempC` for
 * `cpuTempSecs`, or the firmware's own soft-temp-limit bit (0x8).
 *
 * NOTE ON THE REGRESSION GUARD: every reading in the Phase 3 suite above omits
 * `tempC`/`softTemp` entirely, which normalizes to `tempC: null` /
 * `softTemp: false`. That whole suite passing unchanged IS the "thermal arm
 * inert, UV/rail behave exactly as on main" guard; the explicit test below
 * covers the case where a host reports a temperature that is simply never hot.
 */
describe("LoadShedPolicy — thermal arm (Phase 1)", () => {
  const CFG: ShedConfig = {
    enabled: true,
    uvSamples: 3,
    uvWindowSecs: 30,
    railLowVolts: 4.85,
    railLowSecs: 15,
    escalateDwellSecs: 60,
    escalateDutyPct: 70,
    cpuTempC: 80,
    cpuTempRestoreC: 70,
    cpuTempSecs: 15,
    restoreSecs: 120,
    railRestoreVolts: 4.95,
    maxShedsPerHour: 4,
  };

  /** A healthy supply, so only the thermal fields can move the ladder. */
  const cool = (tempC: number): PowerSampleReading => ({ uv: false, railV: 5.05, tempC });

  function makePolicy() {
    const clock = { now: 0 };
    const policy = new LoadShedPolicy({ monoMs: () => clock.now });
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

  it("sustained heat sheds live at exactly cpuTempSecs, not before", () => {
    const { policy, tick } = makePolicy();
    const short = tick(15, cool(85));
    expect(short.last.level).toBe(0); // the run spans 14 s — one second short
    const r = tick(1, cool(85));
    expect(r.last.level).toBe(1);
    expect(r.events[0]).toContain("no-live");
    expect(r.events[0]).toContain("cpu 85.0°C >= 80°C for 15s");
    expect(policy.statusString()).toBe("no-live");
  });

  it("a single spike inside the window does not shed", () => {
    const { tick } = makePolicy();
    tick(10, cool(85));
    tick(1, cool(75)); // one reading below the threshold resets the run
    const r = tick(14, cool(85));
    expect(r.last.level).toBe(0);
  });

  it("hysteresis: shedding at 80 does not restore at 79 — it needs cpuTempRestoreC", () => {
    const { policy, tick } = makePolicy();
    expect(tick(16, cool(85)).last.level).toBe(1);
    // 79 °C: below the trigger, above the restore point. Not triggering is not
    // the same as cool enough, so the restore anchor keeps being refreshed.
    let r = tick(400, cool(79));
    expect(r.last.level).toBe(1);
    expect(policy.statusString()).toBe("no-live");
    // Genuinely cool now: restore after a full restoreSecs of it.
    r = tick(119, cool(69));
    expect(r.last.level).toBe(1);
    r = tick(2, cool(69));
    expect(r.last.level).toBe(0);
    expect(r.events[0]).toContain("restore → full");
    expect(policy.statusString()).toBeNull();
  });

  it("thermal trigger requires fresh samples (a dead sampler cannot shed)", () => {
    const { clock, policy, tick } = makePolicy();
    tick(14, cool(85));
    clock.now += 60_000; // sampler dies; the hot run now spans >15 s but is stale
    expect(policy.evaluate(CFG).level).toBe(0);
  });

  it("a host that reports a cool temperature behaves exactly as it does with none", () => {
    // Same rail trace as the Phase 3 "sustained rail low sheds" case, with a
    // temperature present throughout: the thermal arm must not alter it.
    const withTemp = makePolicy();
    const r = withTemp.tick(16, { uv: false, railV: 4.8, tempC: 55, softTemp: false });
    expect(r.last.level).toBe(1);
    expect(r.events[0]).toContain("rail 4.80V < 4.85V");

    const nullTemp = makePolicy();
    const r2 = nullTemp.tick(120, { uv: false, railV: 5.05, tempC: null, softTemp: false });
    expect(r2.last.level).toBe(0);
  });

  it("throttle bit 0x8 sheds on its own; 0x2 and 0x4 never do (Q3)", () => {
    // 0x8 is the firmware's own thermal verdict, so it needs no dwell — but it
    // must name itself, not a temperature it did not measure.
    const soft = makePolicy();
    const r = soft.tick(1, { uv: false, railV: 5.05, tempC: 62, softTemp: true });
    expect(r.last.level).toBe(1);
    expect(r.events[0]).toContain("cpu soft temp limit (throttle bit 0x8)");

    // 0x2 (freq capped) / 0x4 (throttled) are consequences of EITHER cause, so
    // the decoder never sets uv/softTemp for them and the ladder stays at 0.
    for (const mask of [0x2, 0x4, 0x6]) {
      const reading = powerReadingFromFields({ throttled: { value: mask }, cpu_temp: { value: 62 } });
      expect(reading).toMatchObject({ uv: false, softTemp: false });
      const p = makePolicy();
      expect(p.tick(300, reading!).last.level).toBe(0);
    }
  });

  /**
   * D4/Q2 — THE regression test of this phase. The natural implementation (add
   * a trigger, touch nothing else) escalates a merely-hot device to rung 2 and
   * stops recording, which is the trade the plan explicitly rejects: heat is
   * self-limiting, so degraded footage beats no footage.
   */
  it("a thermal-only trigger NEVER escalates past rung 1, however long it runs", () => {
    const { policy, tick } = makePolicy();
    expect(tick(16, cool(88)).last.level).toBe(1);
    // 100 % duty for ten full escalation dwells. On `main`'s ladder this would
    // have reached rung 2 at ~60 s past the shed.
    const r = tick(600, cool(88));
    expect(r.last.level).toBe(1);
    expect(r.events.filter((m) => m.includes("bridge-only"))).toHaveLength(0);
    expect(policy.statusString()).toBe("no-live");
  });

  it("the firmware's 0x8 bit is capped the same way (it is still thermal)", () => {
    const { policy, tick } = makePolicy();
    const hot: PowerSampleReading = { uv: false, railV: 5.05, tempC: 62, softTemp: true };
    expect(tick(1, hot).last.level).toBe(1);
    expect(tick(600, hot).last.level).toBe(1);
    expect(policy.statusString()).toBe("no-live");
  });

  it("thermal PLUS a concurrent power trigger does escalate — the cap is cause-scoped", () => {
    // Undervoltage while hot: `cause` is "power" by precedence, so the
    // escalation branch proceeds exactly as it does today.
    const uv = makePolicy();
    const hotAndUv: PowerSampleReading = { uv: true, railV: 4.7, tempC: 88 };
    expect(uv.tick(3, hotAndUv).last.level).toBe(1);
    expect(uv.tick(59, hotAndUv).last.level).toBe(1); // one second short of the dwell
    const r = uv.tick(2, hotAndUv);
    expect(r.last.level).toBe(2);
    expect(r.events[0]).toContain("bridge-only");
    expect(r.events[0]).toContain("undervoltage");

    // Same for the rail arm, with the UV bit clear.
    const rail = makePolicy();
    const hotAndSagging: PowerSampleReading = { uv: false, railV: 4.78, tempC: 88 };
    expect(rail.tick(16, hotAndSagging).last.level).toBe(1);
    expect(rail.tick(61, hotAndSagging).last.level).toBe(2);
  });

  it("a power shed that cools into a thermal-only one stops escalating", () => {
    // The supply recovers but the SoC stays hot: the device must hold at rung 1
    // rather than riding the power arm's duty history into rung 2.
    const { policy, tick } = makePolicy();
    expect(tick(16, { uv: false, railV: 4.78, tempC: 88 }).last.level).toBe(1);
    tick(30, { uv: false, railV: 4.78, tempC: 88 });
    const r = tick(600, cool(88)); // rail healthy again, still hot
    expect(r.last.level).toBe(1);
    expect(policy.statusString()).toBe("no-live");
  });

  it("a thermal-only shed still counts toward maxShedsPerHour and still parks", () => {
    const cfg: ShedConfig = { ...CFG, maxShedsPerHour: 1, restoreSecs: 10 };
    const { policy, tick } = makePolicy();
    tick(16, cool(85), cfg); // cycle 1
    expect(policy.statusString()).toBe("no-live");
    tick(12, cool(65), cfg); // cool → restored
    expect(policy.statusString()).toBeNull();
    const r = tick(16, cool(85), cfg); // cycle 2 exceeds the 1/h cap
    expect(r.last).toMatchObject({ level: 1, parked: true });
    expect(r.events[0]).toContain("parked until reboot or settings change");
    tick(600, cool(60), cfg);
    expect(policy.statusString()).toBe("parked:no-live");
  });

  it("undervoltage names the event when both arms fire (precedence)", () => {
    const { tick } = makePolicy();
    const r = tick(3, { uv: true, railV: 5.0, tempC: 88 });
    expect(r.events[0]).toContain("undervoltage 3x");
    expect(r.events[0]).not.toContain("cpu 88");
  });

  it("computeShedSignals reports the cause discriminant Phase 2 will publish", () => {
    /** 16 identical 1 Hz samples (a full cpuTempSecs run) + the matching now. */
    function window(reading: PowerSampleReading) {
      const samples = Array.from({ length: 16 }, (_, i) => ({
        ...reading,
        tempC: reading.tempC ?? null,
        softTemp: reading.softTemp ?? false,
        tMs: (i + 1) * 1000,
      }));
      return { samples, nowMs: 16_000 };
    }
    const signals = (reading: PowerSampleReading) => {
      const w = window(reading);
      return computeShedSignals(w.samples, CFG, w.nowMs);
    };

    expect(signals(cool(85))).toMatchObject({ trigger: true, cause: "thermal" });
    expect(signals({ uv: false, railV: 5.05, tempC: 62, softTemp: true })).toMatchObject({
      trigger: true,
      cause: "thermal",
    });
    expect(signals({ uv: false, railV: 4.78, tempC: 88 })).toMatchObject({
      trigger: true,
      cause: "power",
    });
    expect(signals({ uv: true, railV: 5.05, tempC: 88 })).toMatchObject({
      trigger: true,
      cause: "power", // precedence: undervoltage names it even while hot
    });
    expect(signals(cool(55))).toMatchObject({ trigger: false, cause: null, why: null });
  });

  /**
   * The LATCH (power_management_improvements Phase 2). `ShedVerdict.reason` is
   * the `liveBlock.reason` input, so it must name the shed for the WHOLE time
   * the rung is held — including the stretch after the trigger has cleared but
   * before `restoreSecs` of clean has elapsed. Bench run D (2026-08-05) spent
   * ~7 of its ~8½ shed minutes in exactly that stretch.
   */
  describe("ShedVerdict.reason — the latch Phase 2 publishes", () => {
    it("holds the reason through a cleared trigger, and only drops it on restore", () => {
      const { tick } = makePolicy();
      let r = tick(16, cool(85));
      expect(r.last).toMatchObject({
        level: 1,
        reason: "thermal",
        detail: "cpu 85.0°C >= 80°C for 15s",
      });
      // Trigger gone (79 °C is below cpuTempC) but still above cpuTempRestoreC,
      // so the rung holds — and so must the reason. Read per tick it would be
      // null here for every one of these 400 seconds.
      r = tick(400, cool(79));
      expect(r.last).toMatchObject({
        level: 1,
        reason: "thermal",
        detail: "cpu 85.0°C >= 80°C for 15s", // the detail that STARTED it, unchanged
      });
      // Genuinely cool: restore to full clears the latch with the rung.
      r = tick(121, cool(60));
      expect(r.last).toMatchObject({ level: 0, reason: null, detail: null });
    });

    it("names undervoltage for the UV bit AND for the rail (one published case)", () => {
      const uv = makePolicy();
      expect(uv.tick(3, { uv: true, railV: 5.05, tempC: 60 }).last).toMatchObject({
        level: 1,
        reason: "undervoltage",
        detail: "undervoltage 3x in 30s",
      });
      const rail = makePolicy();
      expect(rail.tick(16, { uv: false, railV: 4.7, tempC: 60 }).last).toMatchObject({
        level: 1,
        reason: "undervoltage",
        detail: "rail 4.70V < 4.85V for 15s",
      });
    });

    it("the firmware's 0x8 bit is thermal too", () => {
      const { tick } = makePolicy();
      expect(tick(1, { uv: false, railV: 5.05, tempC: 62, softTemp: true }).last).toMatchObject({
        level: 1,
        reason: "thermal",
        detail: "cpu soft temp limit (throttle bit 0x8)",
      });
    });

    it("a shed that changes cause is re-latched, and rung 2 → 1 keeps it", () => {
      const { tick } = makePolicy();
      // Hot first: rung 1, thermal.
      expect(tick(16, cool(85)).last).toMatchObject({ level: 1, reason: "thermal" });
      // Now the supply goes bad as well. Precedence makes the cause "power",
      // which both re-latches the reason and unlocks escalation (D4/Q2).
      const r = tick(70, { uv: true, railV: 4.7, tempC: 85 });
      expect(r.last).toMatchObject({
        level: 2,
        reason: "undervoltage",
        detail: "undervoltage 3x in 30s",
      });
      // Restoring 2 → 1 is still the SAME shed, so the latch survives it; only
      // reaching full operation clears it.
      const back = tick(121, cool(60));
      expect(back.last).toMatchObject({ level: 1, reason: "undervoltage" });
      expect(tick(121, cool(60)).last).toMatchObject({ level: 0, reason: null, detail: null });
    });

    it("a parked shed keeps its reason indefinitely (no restore to clear it)", () => {
      const { tick } = makePolicy();
      const cfg: ShedConfig = { ...CFG, maxShedsPerHour: 0 };
      expect(tick(16, cool(85), cfg).last).toMatchObject({ level: 1, parked: true });
      expect(tick(600, cool(50), cfg).last).toMatchObject({
        level: 1,
        parked: true,
        reason: "thermal",
      });
    });

    it("disabling power shedding drops the reason with the ladder", () => {
      const { tick } = makePolicy();
      expect(tick(16, cool(85)).last).toMatchObject({ level: 1, reason: "thermal" });
      expect(tick(1, cool(85), { ...CFG, enabled: false }).last).toMatchObject({
        level: 0,
        reason: null,
        detail: null,
      });
    });
  });
});

/**
 * No-progress escape hatch (Phase 10 iteration 2). The 2026-07-30 garage drive
 * found every other gate release blind at once — no LTE, CSQ 99 (so
 * `disconnected`, not `dead_zone`), and a module reporting a constant 4
 * satellites with no fix (so `clear`, never `no-rf`) — leaving only the 600 s
 * cap and costing 5 min 37 s of footage.
 */
describe("decideBootDefer — gate no-progress escape hatch", () => {
  const CFG_NP: BootDeferConfig = {
    mode: "auto",
    maxSecs: 90,
    minBudgetMa: 5000,
    gateMode: "auto",
    gateMaxSecs: 600,
    gateNoProgressSecs: 120,
  };
  /** The exact garage state: no LTE, no fix, and a sky that reads `clear`. */
  function garage(over: Partial<BootDeferInputs> = {}): BootDeferInputs {
    const now = 1_000_000_000_000;
    return {
      budgetMa: 3000,
      telemetry: {
        timestamp: new Date(now - 1000).toISOString(),
        status: "disconnected",
        reg: 99,
      },
      nowMs: now,
      elapsedMs: 130_000,
      telemetryUnchangedMs: 0,
      staleMs: TELEMETRY_STALE_MS,
      gnss: { fix: false, sky: "clear" },
      ...over,
    };
  }

  it("releases once neither a fix nor LTE has arrived for the window", () => {
    const v = decideBootDefer(CFG_NP, garage());
    expect(v).toMatchObject({ allow: true, state: "released", why: "no-progress" });
  });

  it("keeps gating before the window elapses", () => {
    const v = decideBootDefer(CFG_NP, garage({ elapsedMs: 119_000 }));
    expect(v).toMatchObject({ allow: false, state: "gating", holdLive: true });
  });

  it("never fires while LTE IS connected — that is the acquiring case", () => {
    // Connected + no fix + open sky: genuinely acquiring, so stay patient and
    // let gateMaxSecs bound it.
    const v = decideBootDefer(CFG_NP, garage({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "connected", reg: 1 },
      elapsedMs: 500_000,
    }));
    expect(v).toMatchObject({ allow: false, state: "gating" });
    // ...and the cap still applies.
    const capped = decideBootDefer(CFG_NP, garage({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "connected", reg: 1 },
      elapsedMs: 600_000,
    }));
    expect(capped).toMatchObject({ allow: true, why: "gate-timeout" });
  });

  it("does not pre-empt a fix that did arrive", () => {
    const v = decideBootDefer(CFG_NP, garage({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "connected", reg: 1 },
      gnss: { fix: true, sky: "clear" },
    }));
    expect(v).toMatchObject({ allow: true, why: "gps-fix" });
  });

  it("0 disables it, restoring cap-only behavior", () => {
    const off = { ...CFG_NP, gateNoProgressSecs: 0 };
    expect(decideBootDefer(off, garage())).toMatchObject({ allow: false, state: "gating" });
    expect(decideBootDefer(off, garage({ elapsedMs: 600_000 }))).toMatchObject({
      allow: true,
      why: "gate-timeout",
    });
  });

  it("more specific arms still win — dead_zone and no-rf name the cause", () => {
    const dz = decideBootDefer(CFG_NP, garage({
      telemetry: { timestamp: new Date(1_000_000_000_000 - 1000).toISOString(), status: "dead_zone", reg: 0 },
    }));
    expect(dz.why).toBe("dead_zone");
    const norf = decideBootDefer(CFG_NP, garage({ gnss: { fix: false, sky: "no-rf" } }));
    expect(norf.why).toBe("no-rf");
  });
});
