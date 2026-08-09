import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigReport,
  buildEffective,
  ConfigSync,
  parseApnTelemetry,
  type ConfigReport,
  type DesiredSnapshot,
  type ModemBiasSample,
} from "../src/agent/config-sync.js";
import { parseCloudMessage, applyCloudConfig } from "../src/agent/cloud-config.js";
import { loadSettings, parseCellularSettings, saveSettings } from "../src/daemon/settings.js";
import type { ModemCellularTelemetry } from "../src/hardware/modem.js";

/**
 * The `cellular` namespace + reported-only `apn` block (manage_sim_card_info,
 * Phase 2). What matters here:
 *
 *  - the report carries the APPLIED APN, never an echo of the requested one;
 *  - a rollback / rejection is legible in `status.cellular`, not a green tick;
 *  - an unconfigured device never grows an `effective.cellular` (that would
 *    badge the whole fleet as diverged);
 *  - the APN machinery's outcome reaches the cloud without waiting for the
 *    hourly heartbeat (checkApnChange).
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const APN_INFORCE: ModemCellularTelemetry = {
  state: "in-force",
  apn_applied: "sp.mb.com",
  fails: 0,
};

function sample(apn?: ModemCellularTelemetry): ModemBiasSample {
  return { value: true, fresh: true, apn };
}

function desired(raw: Record<string, unknown>): DesiredSnapshot {
  const parsed = parseCloudMessage(JSON.stringify({ v: 1, ...raw }))!;
  return { rev: 1, raw: parsed.raw, parsed: parsed.config };
}

describe("parseCellularSettings (the agent-side allowlist)", () => {
  it("keeps a valid apn, including the explicit empty string", () => {
    expect(parseCellularSettings({ apn: "sp.mb.com" })).toEqual({ apn: "sp.mb.com" });
    expect(parseCellularSettings({ apn: "" })).toEqual({ apn: "" });
  });

  it("DROPS an invalid apn instead of repairing it — a fixed APN is a different APN", () => {
    expect(parseCellularSettings({ apn: 'a";+CFUN=0' })).toBeUndefined();
    expect(parseCellularSettings({ apn: "a b" })).toBeUndefined();
    expect(parseCellularSettings({ apn: "a".repeat(101) })).toBeUndefined();
    expect(parseCellularSettings({ apn: 5 })).toBeUndefined();
    expect(parseCellularSettings("sp.mb.com")).toBeUndefined();
  });

  it("survives a settings.json round trip (the allowlist rewriter knows it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cellular-"));
    const file = join(dir, "settings.json");
    saveSettings({ cellular: { apn: "new.apn" } }, file);
    expect(loadSettings(file).cellular).toEqual({ apn: "new.apn" });
  });
});

describe("parseApnTelemetry", () => {
  it("keeps a full block", () => {
    expect(
      parseApnTelemetry({
        state: "rolled-back",
        apn_applied: "sp.mb.com",
        apn_requested: "wrong.apn",
        last_error: "no data session within 300s (ping and tcp both failed)",
        fails: 2,
        changed_at: "2026-08-09T18:00:00Z",
      }),
    ).toEqual({
      state: "rolled-back",
      apn_applied: "sp.mb.com",
      apn_requested: "wrong.apn",
      last_error: "no data session within 300s (ping and tcp both failed)",
      fails: 2,
      changed_at: "2026-08-09T18:00:00Z",
    });
  });

  it("drops the whole block on an unknown state (fail open = no rollback net)", () => {
    expect(parseApnTelemetry({ state: "confused" })).toBeUndefined();
    expect(parseApnTelemetry(null)).toBeUndefined();
    expect(parseApnTelemetry("in-force")).toBeUndefined();
  });

  it("drops APN fields that fail the charset check, and keeps a full-length one intact", () => {
    const long = "a".repeat(100);
    const out = parseApnTelemetry({
      state: "in-force",
      apn_applied: long,
      apn_requested: 'evil";x',
    })!;
    expect(out.apn_applied).toBe(long); // never truncated — a shorter APN is a different APN
    expect(out).not.toHaveProperty("apn_requested");
  });
});

describe("buildEffective — cellular + the reported-only apn block", () => {
  it("an unconfigured device reports the machinery but NEVER an effective.cellular", () => {
    const eff = buildEffective({}, sample(APN_INFORCE));
    expect(eff).not.toHaveProperty("cellular");
    expect(eff.apn).toEqual(APN_INFORCE);
  });

  it("carries the APPLIED apn, not the requested one, while a change is in flight", () => {
    const eff = buildEffective(
      { cellular: { apn: "wrong.apn" } },
      sample({ state: "applying", apn_applied: "sp.mb.com", apn_requested: "wrong.apn" }),
    );
    expect(eff.cellular).toEqual({ apn: "sp.mb.com" });
  });

  it("echoes the empty apn as-is — 'don't touch' needs no modem confirmation", () => {
    const eff = buildEffective({ cellular: { apn: "" } }, sample(undefined));
    expect(eff.cellular).toEqual({ apn: "" });
  });

  it("omits effective.cellular when the modem has never reported an applied APN", () => {
    const eff = buildEffective({ cellular: { apn: "new.apn" } }, sample(undefined));
    expect(eff).not.toHaveProperty("cellular");
    expect(eff).not.toHaveProperty("apn");
  });
});

describe("status.cellular — the verdict comes from the apply machinery", () => {
  function statusFor(
    apn: ModemCellularTelemetry | undefined,
    wanted = "wrong.apn",
  ): ConfigReport["status"][string] {
    const report = buildConfigReport({
      deviceId: "d",
      ts: 1,
      origin: "cloud",
      lastAppliedRev: 1,
      settings: { cellular: { apn: wanted } },
      modem: sample(apn),
      desired: desired({ cellular: { apn: wanted } }),
    });
    return report.status.cellular;
  }

  it("applying reads as adjusted with an 'applying' detail, never a tick", () => {
    const s = statusFor({ state: "applying", apn_applied: "sp.mb.com", apn_requested: "wrong.apn" });
    expect(s.state).toBe("adjusted");
    expect(s.detail).toContain("applying");
  });

  it("a rollback is fully legible: what was tried, what is running, and why", () => {
    const s = statusFor({
      state: "rolled-back",
      apn_applied: "sp.mb.com",
      apn_requested: "wrong.apn",
      last_error: "no data session within 300s (ping and tcp both failed)",
      fails: 1,
    });
    expect(s.state).toBe("adjusted");
    expect(s.detail).toContain('"wrong.apn"');
    expect(s.detail).toContain('rolled back to "sp.mb.com"');
    expect(s.detail).toContain("no data session");
  });

  it("the give-up lands as REJECTED with the reason", () => {
    const s = statusFor({
      state: "rejected",
      apn_applied: "sp.mb.com",
      apn_requested: "wrong.apn",
      last_error: "no data session within 300s (ping and tcp both failed)",
      fails: 3,
    });
    expect(s.state).toBe("rejected");
    expect(s.reason).toContain("3 failed applies");
    expect(s.reason).toContain("change the value");
  });

  it("a confirmed apply reads applied", () => {
    const s = statusFor({ state: "in-force", apn_applied: "new.apn", fails: 0 }, "new.apn");
    expect(s.state).toBe("applied");
  });

  it("an empty apn is applied by definition", () => {
    const s = statusFor(undefined, "");
    expect(s.state).toBe("applied");
  });

  it("a daemon with no APN machinery is called out — the change will never apply", () => {
    const s = statusFor(undefined);
    expect(s.state).toBe("adjusted");
    expect(s.detail).toContain("predate");
  });

  it("an injection attempt is rejected by the tolerant parse before any verdict", () => {
    const report = buildConfigReport({
      deviceId: "d",
      ts: 1,
      origin: "cloud",
      lastAppliedRev: 1,
      settings: {},
      modem: sample(APN_INFORCE),
      desired: desired({ cellular: { apn: 'a";+CFUN=0' } }),
    });
    expect(report.status.cellular.state).toBe("rejected");
  });
});

describe("cloud-config: the cellular namespace applies and clears", () => {
  it("parses a cellular namespace out of a v1 message", () => {
    const msg = parseCloudMessage(JSON.stringify({ v: 1, cellular: { apn: "new.apn" } }))!;
    expect(msg.config.cellular).toEqual({ apn: "new.apn" });
  });

  it("an all-invalid cellular object parses to null (clear), not to a repaired value", () => {
    const msg = parseCloudMessage(JSON.stringify({ v: 1, cellular: { apn: "bad apn" } }))!;
    expect(msg.config.cellular).toBeNull();
  });

  it("applyCloudConfig sets and clears the local key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cellular-apply-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ mode: "real" }));

    expect(applyCloudConfig({ cellular: { apn: "new.apn" } }, file).changed).toBe(true);
    expect(loadSettings(file).cellular).toEqual({ apn: "new.apn" });
    // mode survives — the merge touches only the cloud-managed namespace.
    expect(loadSettings(file).mode).toBe("real");

    expect(applyCloudConfig({ cellular: null }, file).changed).toBe(true);
    expect(loadSettings(file)).not.toHaveProperty("cellular");

    // Absent = never spoken about: leave local alone.
    writeFileSync(file, JSON.stringify({ cellular: { apn: "keep.me" } }));
    expect(applyCloudConfig({ gnssAntBias: true }, file).changed).toBe(true);
    expect(loadSettings(file).cellular).toEqual({ apn: "keep.me" });
  });
});

describe("checkApnChange — the outcome must not wait for the heartbeat", () => {
  function harness(modem: () => Promise<ModemBiasSample>): {
    sync: ConfigSync;
    sent: ConfigReport[];
  } {
    const sent: ConfigReport[] = [];
    const sync = new ConfigSync({
      deviceId: "dev-1",
      topic: "t",
      publish: (_t, p) => sent.push(JSON.parse(p) as ConfigReport),
      settings: () => ({}),
      modem,
      debounceMs: 1,
    });
    return { sync, sent };
  }

  it("requests a report when the machinery moves, and stays quiet when it does not", async () => {
    let block: ModemCellularTelemetry = { state: "applying", apn_requested: "new.apn" };
    const { sync, sent } = harness(async () => sample(block));

    await sync.publishReport("boot");
    expect(sent).toHaveLength(1);

    // No movement: a tick must not produce a report.
    await sync.checkApnChange();
    await delay(30);
    expect(sent).toHaveLength(1);

    // The apply confirms: the next tick reports it.
    block = { state: "in-force", apn_applied: "new.apn", fails: 0 };
    await sync.checkApnChange();
    await delay(30);
    sync.stop();
    expect(sent).toHaveLength(2);
    expect(sent[1].effective.apn).toMatchObject({ state: "in-force", apn_applied: "new.apn" });
  });

  it("says nothing on a device with no APN machinery at all", async () => {
    const { sync, sent } = harness(async () => ({ value: true, fresh: true }));
    await sync.publishReport("boot");
    await sync.checkApnChange();
    await delay(30);
    sync.stop();
    expect(sent).toHaveLength(1);
  });
});
