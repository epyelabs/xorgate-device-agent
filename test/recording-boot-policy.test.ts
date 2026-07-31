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
