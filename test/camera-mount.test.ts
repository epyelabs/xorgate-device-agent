import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigReport,
  buildEffective,
  buildStatus,
  type DesiredSnapshot,
  type ModemBiasSample,
} from "../src/agent/config-sync.js";
import { applyCloudConfig, parseCloudMessage } from "../src/agent/cloud-config.js";
import { loadSettings, parseCameraMountSettings, saveSettings } from "../src/daemon/settings.js";
import type { CameraMountState } from "../src/hardware/boot-config.js";

/**
 * The `cameraMount` namespace end to end on the device side
 * (cam-sensor-level-rotate plan, Phase 2): parse → settings.json → report.
 *
 * The reporting half is the load-bearing part. The rotation is written to the
 * boot config immediately and reaches the sensor only at the next boot, so for
 * most of its life this namespace is in a state neither "applied" nor
 * "rejected" — and the ONE reported shape that renders truthfully in both
 * xorgate-web and alocate's generic badge is `adjusted` + `detail`. A green
 * tick over a device whose picture is still upside down is the failure mode
 * this file exists to prevent.
 */

const modem: ModemBiasSample = { value: true, fresh: true };

function tmpSettings(): string {
  return join(mkdtempSync(join(tmpdir(), "xg-cammount-")), "settings.json");
}

function desiredDoc(cameraMount: unknown): DesiredSnapshot {
  const msg = parseCloudMessage(JSON.stringify({ v: 1, rev: 4, cameraMount }))!;
  return { rev: 4, raw: msg.raw, parsed: msg.config };
}

function state(over: Partial<CameraMountState> = {}): CameraMountState {
  return {
    at: 1,
    cameras: [
      { streamKey: "cam0", desiredDeg: 180, inForceDeg: 0, bootDeg: 180, verdict: "pending-reboot" },
    ],
    rebootRequired: true,
    wrote: false,
    ...over,
  };
}

describe("cameraMount settings parsing", () => {
  it("keeps valid per-camera rotations and drops nothing else", () => {
    expect(
      parseCameraMountSettings({ cameras: { cam0: { rotationDeg: 180 }, cam1: { rotationDeg: 0 } } }),
    ).toEqual({ cameras: { cam0: { rotationDeg: 180 }, cam1: { rotationDeg: 0 } } });
  });

  it("drops an impossible rotation rather than rounding it to a legal one", () => {
    // Deliberately unlike the clamping siblings: 90 is not "almost 180", and
    // the value ends up in a boot config.
    for (const deg of [90, 270, 360, -180, "180", null, true, 180.5]) {
      expect(parseCameraMountSettings({ cameras: { cam0: { rotationDeg: deg } } })).toEqual({
        cameras: {},
      });
    }
  });

  it("drops a key that could never name a camera", () => {
    expect(
      parseCameraMountSettings({ cameras: { "cam 0": { rotationDeg: 180 }, "": { rotationDeg: 0 } } }),
    ).toEqual({ cameras: {} });
  });

  it("maps the cloud's erase marker to undefined, and keeps an empty camera map", () => {
    expect(parseCameraMountSettings({})).toBeUndefined();
    expect(parseCameraMountSettings(null)).toBeUndefined();
    expect(parseCameraMountSettings("cam0")).toBeUndefined();
    // `{cameras:{}}` is a value, not an erase: "the cloud manages this device's
    // rotation and no camera is turned".
    expect(parseCameraMountSettings({ cameras: {} })).toEqual({ cameras: {} });
  });

  it("survives a settings.json round trip", () => {
    const path = tmpSettings();
    saveSettings({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, path);
    expect(loadSettings(path).cameraMount).toEqual({ cameras: { cam0: { rotationDeg: 180 } } });
  });
});

describe("cameraMount over the retained cloud config", () => {
  it("persists a delivered namespace and is a no-op on redelivery", () => {
    const path = tmpSettings();
    saveSettings({ gnssAntBias: false }, path);
    const msg = parseCloudMessage(
      JSON.stringify({ v: 1, rev: 2, cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }),
    )!;
    expect(applyCloudConfig(msg.config, path)).toEqual({ changed: true });
    expect(loadSettings(path)).toEqual({
      gnssAntBias: false,
      cameraMount: { cameras: { cam0: { rotationDeg: 180 } } },
    });
    expect(applyCloudConfig(msg.config, path)).toEqual({ changed: false });
  });

  it("clears the local key when the cloud reverts the namespace", () => {
    const path = tmpSettings();
    saveSettings({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, path);
    // `PATCH {cameraMount: null}` travels as `{}` on the wire.
    const msg = parseCloudMessage(JSON.stringify({ v: 1, rev: 3, cameraMount: {} }))!;
    expect(applyCloudConfig(msg.config, path)).toEqual({ changed: true });
    expect(loadSettings(path).cameraMount).toBeUndefined();
  });

  it("leaves the local value alone when the message does not carry the namespace", () => {
    const path = tmpSettings();
    saveSettings({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, path);
    const msg = parseCloudMessage(JSON.stringify({ v: 1, rev: 3, gnssAntBias: true }))!;
    applyCloudConfig(msg.config, path);
    expect(loadSettings(path).cameraMount).toEqual({ cameras: { cam0: { rotationDeg: 180 } } });
  });

  it("does not write settings.json for a namespace it cannot parse", () => {
    const path = tmpSettings();
    saveSettings({ gnssAntBias: false }, path);
    const before = readFileSync(path, "utf8");
    const msg = parseCloudMessage(JSON.stringify({ v: 1, rev: 3, cameraMount: "180" }))!;
    expect(msg.config.cameraMount).toBeUndefined();
    applyCloudConfig(msg.config, path);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("what the device reports", () => {
  it("reports the rotation IN FORCE, with the written one as pending", () => {
    const effective = buildEffective(
      { cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } },
      modem,
      undefined,
      state(),
    );
    expect(effective.cameraMount).toEqual({
      cameras: { cam0: { rotationDeg: 0 } },
      pending: { cam0: { rotationDeg: 180 } },
      rebootRequired: true,
    });
  });

  it("never grows an effective block on a device that was never configured", () => {
    expect(buildEffective({}, modem, undefined, null).cameraMount).toBeUndefined();
  });

  it("says a reboot is required, in a state both frontends badge honestly", () => {
    const effective = buildEffective(
      { cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } },
      modem,
      undefined,
      state(),
    );
    const status = buildStatus(
      desiredDoc({ cameras: { cam0: { rotationDeg: 180 } } }),
      effective,
      modem,
      99,
      {},
      state(),
    );
    // `adjusted` on purpose: alocate's generic namespace badge falls through to
    // "applied" for any state it does not know, so a new `pending-reboot`
    // state would show a green tick over an upside-down picture.
    expect(status.cameraMount).toEqual({
      state: "adjusted",
      at: 99,
      detail: "written to the boot config — REBOOT REQUIRED to apply: cam0 180° (running 0°)",
    });
  });

  it("reads applied once the device has actually booted with it", () => {
    const settled = state({
      cameras: [
        { streamKey: "cam0", desiredDeg: 180, inForceDeg: 180, bootDeg: 180, verdict: "applied" },
      ],
      rebootRequired: false,
    });
    const effective = buildEffective(
      { cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } },
      modem,
      undefined,
      settled,
    );
    expect(effective.cameraMount).toEqual({
      cameras: { cam0: { rotationDeg: 180 } },
      rebootRequired: false,
    });
    const status = buildStatus(
      desiredDoc({ cameras: { cam0: { rotationDeg: 180 } } }),
      effective,
      modem,
      99,
      {},
      settled,
    );
    expect(status.cameraMount).toEqual({ state: "applied", at: 99 });
  });

  it("rejects — loudly — what the device cannot do at all", () => {
    for (const verdict of ["unsupported", "no-overlay", "unknown-camera", "write-failed"] as const) {
      const blocked = state({
        cameras: [
          {
            streamKey: "cam0",
            desiredDeg: 180,
            inForceDeg: 0,
            bootDeg: 0,
            verdict,
            detail: `cannot: ${verdict}`,
          },
        ],
        rebootRequired: false,
      });
      const status = buildStatus(
        desiredDoc({ cameras: { cam0: { rotationDeg: 180 } } }),
        buildEffective({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, modem, undefined, blocked),
        modem,
        99,
        {},
        blocked,
      );
      expect(status.cameraMount).toMatchObject({ state: "rejected" });
      expect(status.cameraMount?.reason).toContain(`cam0: cannot: ${verdict}`);
    }
  });

  it("admits it when the reconciler has not run yet", () => {
    const status = buildStatus(
      desiredDoc({ cameras: { cam0: { rotationDeg: 180 } } }),
      buildEffective({ cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } }, modem, undefined, null),
      modem,
      99,
      {},
      null,
    );
    expect(status.cameraMount).toMatchObject({
      state: "adjusted",
      detail: "saved; the device has not reconciled its boot config yet",
    });
  });

  it("carries the whole thing through a built report", () => {
    const report = buildConfigReport({
      deviceId: "dev-1",
      ts: 7,
      origin: "cloud",
      lastAppliedRev: 4,
      settings: { cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } },
      modem,
      desired: desiredDoc({ cameras: { cam0: { rotationDeg: 180 } } }),
      cameraMount: state(),
    });
    expect(report.effective.cameraMount).toMatchObject({ rebootRequired: true });
    expect(report.status?.cameraMount?.state).toBe("adjusted");
  });

  it("says nothing about a namespace the cloud never mentioned", () => {
    const status = buildStatus(
      desiredDoc(undefined),
      buildEffective({}, modem, undefined, null),
      modem,
      99,
      {},
      null,
    );
    expect(status.cameraMount).toBeUndefined();
  });

  it("still reports the value it holds before the first reconcile", () => {
    const effective = buildEffective(
      { cameraMount: { cameras: { cam0: { rotationDeg: 180 } } } },
      modem,
      undefined,
      null,
    );
    expect(effective.cameraMount).toEqual({
      cameras: { cam0: { rotationDeg: 180 } },
      reconciled: false,
    });
  });
});
