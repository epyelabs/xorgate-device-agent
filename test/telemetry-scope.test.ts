import { describe, expect, it } from "vitest";
import {
  TelemetryScope,
  scopedTelemetryTopic,
  type ScopeChange,
  type TenantScope,
} from "../src/agent/telemetry-scope.js";

/**
 * The unscoped-topic fallback (transfer-device-ownership Phase 1.1).
 *
 * The regression this pins is the 2026-09-18 outage: a thing attribute moved to
 * a new tenancy ahead of the retained config, the running agent stayed pinned to
 * the old scoped topic, and every publish got the connection closed — ~3.3 s
 * apart, for 50 minutes, with no remote exit. See `src/agent/telemetry-scope.ts`.
 */

const DEVICE = "ca4b1c5d-0000-4000-8000-000000000001";
const UNSCOPED = `xorgate/devices/${DEVICE}/telemetry`;
const WS_A: TenantScope = { organizationId: "org-1", workspaceId: "ws-a" };
const WS_B: TenantScope = { organizationId: "org-1", workspaceId: "ws-b" };

function make(overrides = {}): TelemetryScope {
  return new TelemetryScope({ deviceId: DEVICE, unscopedTopic: UNSCOPED, ...overrides });
}

/**
 * One refused-topic cycle: connect, publish, broker closes ~1.3 s later (2 s of
 * mqtt reconnectPeriod separates them, matching the observed 3.3 s loop).
 * Returns the clock and any change the close produced.
 */
function badCycle(s: TelemetryScope, at: number): { next: number; change: ScopeChange | null } {
  s.noteConnect(at);
  s.notePublish();
  const change = s.noteClose(at + 1_300);
  return { next: at + 3_300, change };
}

describe("telemetry scope: normal life", () => {
  it("starts on the unscoped topic, which the device policy always permits", () => {
    expect(make().topic).toBe(UNSCOPED);
    expect(make().fallenBack).toBe(false);
  });

  it("moves to the scoped topic when the cloud names a tenancy", () => {
    const s = make();
    const change = s.applyScope(WS_A, 1_000);
    expect(change).toMatchObject({ kind: "scoped", reason: "cloud" });
    expect(s.topic).toBe(scopedTelemetryTopic(WS_A, DEVICE));
  });

  it("is silent when the retained message replays the same scope", () => {
    // This message is RETAINED, so the broker replays it on EVERY connect.
    // Reporting a change here would flood the journal once per reconnect.
    const s = make();
    s.applyScope(WS_A, 1_000);
    expect(s.applyScope(WS_A, 2_000)).toBeNull();
    expect(s.applyScope(WS_A, 3_000)).toBeNull();
  });

  it("follows a transfer to a new workspace", () => {
    const s = make();
    s.applyScope(WS_A, 1_000);
    const change = s.applyScope(WS_B, 2_000);
    expect(change).toMatchObject({ kind: "scoped", scope: WS_B });
    expect(s.topic).toBe(scopedTelemetryTopic(WS_B, DEVICE));
  });

  it("never falls back on healthy long-lived connections", () => {
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
      s.noteConnect(t);
      for (let p = 0; p < 600; p += 1) s.notePublish();
      expect(s.noteClose(t + 600_000)).toBeNull();
      t += 602_000;
    }
    expect(s.fallenBack).toBe(false);
  });

  it("never falls back while still on the unscoped topic", () => {
    // A device that has never been told a tenancy cannot be refused for one.
    const s = make();
    let t = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = badCycle(s, t);
      expect(r.change).toBeNull();
      t = r.next;
    }
    expect(s.topic).toBe(UNSCOPED);
  });
});

describe("telemetry scope: the 2026-09-18 loop", () => {
  it("falls back to the unscoped topic once the loop is unmistakable", () => {
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    let fallback: ScopeChange | null = null;
    // 50 minutes of the real loop, except it does not get 50 minutes.
    for (let i = 0; i < 1000 && !fallback; i += 1) {
      const r = badCycle(s, t);
      t = r.next;
      fallback = r.change;
    }
    expect(fallback).toMatchObject({ kind: "fallback", topic: UNSCOPED, scope: WS_A });
    expect(s.topic).toBe(UNSCOPED);
    expect(s.fallenBack).toBe(true);
    // Bounded, and bounded TIGHTLY: the grace period is 30 s, not 50 minutes.
    expect(t).toBeLessThan(60_000);
    expect(t).toBeGreaterThanOrEqual(30_000);
  });

  it("does not fall back for a correctly-ordered transfer with a slow gap", () => {
    // Tacloban 03, 2026-09-18: config published, thing attribute 12 s later.
    // The device flapped for those 12 s and then settled. Falling back there
    // would be a regression — it was converging.
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    while (t < 12_000) {
      const r = badCycle(s, t);
      expect(r.change).toBeNull();
      t = r.next;
    }
    // Attribute lands; the very next connection is healthy.
    s.noteConnect(t);
    for (let p = 0; p < 300; p += 1) s.notePublish();
    expect(s.noteClose(t + 300_000)).toBeNull();
    expect(s.fallenBack).toBe(false);
    expect(s.topic).toBe(scopedTelemetryTopic(WS_A, DEVICE));
  });

  it("resets the run when a healthy connection interrupts it", () => {
    const s = make({ graceMs: 0 });
    s.applyScope(WS_A, 0);
    let t = 0;
    ({ next: t } = badCycle(s, t));
    ({ next: t } = badCycle(s, t));
    // One good connection in the middle: not the loop.
    s.noteConnect(t);
    s.notePublish();
    expect(s.noteClose(t + 120_000)).toBeNull();
    t += 122_000;
    const r = badCycle(s, t);
    expect(r.change).toBeNull(); // run restarted at 1, not continued at 3
    expect(s.fallenBack).toBe(false);
  });

  it("ignores a short connection that never published", () => {
    // Nothing was offered to the broker, so nothing was refused.
    const s = make({ graceMs: 0 });
    s.applyScope(WS_A, 0);
    let t = 0;
    for (let i = 0; i < 10; i += 1) {
      s.noteConnect(t);
      expect(s.noteClose(t + 1_300)).toBeNull();
      t += 3_300;
    }
    expect(s.fallenBack).toBe(false);
  });
});

describe("telemetry scope: getting back", () => {
  it("stays down when the retained message replays the scope it fell back from", () => {
    // THE flap guard. The retained config arrives ~0.5 s after every connect;
    // re-arming on it would put us straight back into the loop.
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    let fallback: ScopeChange | null = null;
    while (!fallback) {
      const r = badCycle(s, t);
      t = r.next;
      fallback = r.change;
    }
    for (let i = 0; i < 10; i += 1) {
      expect(s.applyScope(WS_A, t + i * 3_300)).toBeNull();
      expect(s.topic).toBe(UNSCOPED);
    }
  });

  it("re-arms immediately when a config message carries a DIFFERENT scope", () => {
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    while (!badCycle(s, t).change) t += 3_300;
    expect(s.fallenBack).toBe(true);
    const change = s.applyScope(WS_B, t + 10_000);
    expect(change).toMatchObject({ kind: "scoped", scope: WS_B, reason: "cloud" });
    expect(s.fallenBack).toBe(false);
    expect(s.topic).toBe(scopedTelemetryTopic(WS_B, DEVICE));
  });

  it("re-probes on the backoff, so a fixed thing attribute is noticed", () => {
    // The case the "different scope" rule cannot see: an operator repairs the
    // THING ATTRIBUTE to match the scope the device already has. No config
    // message is published, because nothing about the config changed.
    const s = make({ reprobeAfterMs: 30 * 60_000 });
    s.applyScope(WS_A, 0);
    let t = 0;
    let fb: ScopeChange | null = null;
    while (!fb) {
      const r = badCycle(s, t);
      t = r.next;
      fb = r.change;
    }
    expect(fb).toMatchObject({ reprobeInMs: 30 * 60_000 });
    const fellBackAt = t;

    // Quiet for the whole backoff.
    expect(s.noteTick(fellBackAt + 29 * 60_000)).toBeNull();
    expect(s.topic).toBe(UNSCOPED);

    const probe = s.noteTick(fellBackAt + 30 * 60_000 + 1);
    expect(probe).toMatchObject({ kind: "scoped", scope: WS_A, reason: "reprobe" });
    expect(s.topic).toBe(scopedTelemetryTopic(WS_A, DEVICE));
  });

  it("a failed probe costs ONE cycle, then backs off further", () => {
    const s = make({ reprobeAfterMs: 60_000, maxReprobeMs: 240_000 });
    s.applyScope(WS_A, 0);
    let t = 0;
    let fb: ScopeChange | null = null;
    while (!fb) {
      const r = badCycle(s, t);
      t = r.next;
      fb = r.change;
    }
    const delays: number[] = [(fb as { reprobeInMs: number }).reprobeInMs];
    for (let i = 0; i < 4; i += 1) {
      t += delays[delays.length - 1] + 1;
      // Probe, still connected: the cycle restarts from the arming instant, so
      // one refused connection is enough to settle it back down.
      s.noteConnect(t);
      expect(s.noteTick(t)).toMatchObject({ reason: "reprobe" });
      s.notePublish();
      const change = s.noteClose(t + 1_300);
      expect(change).toMatchObject({ kind: "fallback", cycles: 1 });
      delays.push((change as { reprobeInMs: number }).reprobeInMs);
      t += 3_300;
    }
    // Doubling, capped.
    expect(delays).toEqual([60_000, 120_000, 240_000, 240_000, 240_000]);
    expect(s.topic).toBe(UNSCOPED);
  });

  it("measures a mid-connection re-arm from the arming instant, not the connect", () => {
    // A long-lived healthy unscoped connection must not make a refused probe
    // look like a 40-minute-old, therefore healthy, cycle.
    const s = make({ reprobeAfterMs: 60_000 });
    s.applyScope(WS_A, 0);
    let t = 0;
    while (!badCycle(s, t).change) t += 3_300;
    // Forty quiet minutes on the unscoped plane, one connection throughout.
    s.noteConnect(t);
    for (let p = 0; p < 2_400; p += 1) s.notePublish();
    t += 2_400_000;
    expect(s.noteTick(t)).toMatchObject({ reason: "reprobe" });
    s.notePublish();
    expect(s.noteClose(t + 1_300)).toMatchObject({ kind: "fallback" });
  });
});

describe("telemetry scope: what the cloud is told", () => {
  it("reports the unscoped topic and no fallback block at boot", () => {
    expect(make().report()).toEqual({ topic: UNSCOPED, scoped: false });
  });

  it("reports the tenancy once scoped, still with no fallback block", () => {
    const s = make();
    s.applyScope(WS_A, 0);
    expect(s.report()).toEqual({
      topic: scopedTelemetryTopic(WS_A, DEVICE),
      scoped: true,
      organizationId: "org-1",
      workspaceId: "ws-a",
    });
  });

  it("reports the fallback, which is the cloud's only sight of it", () => {
    const s = make();
    s.applyScope(WS_A, 0);
    let t = 0;
    while (!badCycle(s, t).change) t += 3_300;
    const report = s.report();
    expect(report.scoped).toBe(false);
    expect(report.topic).toBe(UNSCOPED);
    // The tenancy it WANTED is still named — that is what makes the report
    // actionable rather than just "this device looks legacy".
    expect(report.workspaceId).toBe("ws-a");
    expect(report.fallback).toMatchObject({ count: 1 });
  });
});
