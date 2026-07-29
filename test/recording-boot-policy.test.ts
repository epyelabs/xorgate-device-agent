import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BootDeferPolicy,
  decideBootDefer,
  TELEMETRY_STALE_MS,
  type BootDeferConfig,
  type BootDeferInputs,
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
