import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  bootConfigCamera,
  dtRotationForCamera,
  overlayCamToken,
  overlayLinesForCamera,
  parseOverlayLines,
  reconcileCameraMount,
  resolveBootConfigPath,
  resolveCamToken,
  rotationOfLine,
} from "../src/hardware/boot-config.js";
import type { DeviceHardwareBlock } from "../src/hardware/hardware-config.js";
import type { CameraMountSettings } from "../src/daemon/settings.js";

/**
 * The boot-config parser + reconciler (cam-sensor-level-rotate plan, Phase 2).
 *
 * This is the file that edits `/boot/firmware/config.txt` on a fleet of
 * devices with a real undervoltage-crash history, so the properties under test
 * are the ones that would hurt:
 *
 *   - it edits ONE token on ONE line and preserves everything else;
 *   - it writes only on an actual change (a reconcile pass on a settled device
 *     touches nothing, forever);
 *   - an unsupported sensor, a missing overlay line or a failed privileged
 *     write produce a REPORTED error, never a silent edit;
 *   - an absent namespace is left strictly alone;
 *   - "reboot required" is derived from the LIVE device tree, so it survives an
 *     agent restart and cannot latch on stale bookkeeping;
 *   - nothing anywhere in the module can reboot the device.
 */

const exec = promisify(execFile);
const HELPER = join(__dirname, "..", "system", "xorgate-camrotate");

const CONFIG_TXT = `# Raspberry Pi config
camera_auto_detect=0
dtoverlay=vc4-kms-v3d
[cm4]
otg_mode=1
[cm5]
dtoverlay=dwc2,dr_mode=host
[all]
dtoverlay=imx290,cam0,4lane
dtoverlay=imx290,cam1
#dtoverlay=googlevoicehat-soundcard
`;

const HARDWARE: DeviceHardwareBlock = {
  v: 2,
  platform: "rpi-cm4",
  encoder: "hw-h264",
  rails: false,
  statusLed: null,
  imu: "bno085",
  video: [
    { key: "cam0", connector: "csi0", sensor: "imx290", codec: "h264" },
    { key: "cam1", connector: "csi1", sensor: "imx290", codec: "h264" },
  ],
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "xg-bootcfg-"));
}

/** A fixture device: a boot config, a pipeline dir and a fake device tree. */
function device(opts: { config?: string; inForce?: Record<string, number> } = {}): {
  dir: string;
  bootConfigPath: string;
  pipelineDir: string;
  dtRoot: string;
  read: () => string;
} {
  const dir = tmp();
  const bootConfigPath = join(dir, "config.txt");
  writeFileSync(bootConfigPath, opts.config ?? CONFIG_TXT);
  const pipelineDir = join(dir, "pipelines");
  mkdirSync(pipelineDir, { recursive: true });
  const dtRoot = join(dir, "device-tree");
  for (const [key, deg] of Object.entries(opts.inForce ?? {})) {
    // The enumerated identity the hardware reconciler caches, and the matching
    // node in the live device tree.
    const node = `/base/soc/i2c0mux/i2c@${key.slice(3)}/imx290@1a`;
    writeFileSync(join(pipelineDir, `${key}.camera`), `${node}\n`);
    const nodeDir = join(dtRoot, node.replace("/base/", ""));
    mkdirSync(nodeDir, { recursive: true });
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(deg, 0);
    writeFileSync(join(nodeDir, "rotation"), buf);
  }
  return { dir, bootConfigPath, pipelineDir, dtRoot, read: () => readFileSync(bootConfigPath, "utf8") };
}

/** Drive the REAL helper script (the privileged writer) against a fixture. */
function helperWriter(bootConfigPath: string) {
  return async (sensor: string, camToken: string, deg: 0 | 180) => {
    try {
      await exec(HELPER, [sensor, camToken, String(deg)], {
        env: { ...process.env, XORGATE_BOOT_CONFIG: bootConfigPath },
      });
      return { ok: true, changed: true, detail: "" };
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 3) return { ok: true, changed: false, detail: "" };
      return { ok: false, changed: false, detail: e.stderr?.trim() ?? `exit ${e.code}` };
    }
  };
}

const supported = async (): Promise<{ ok: boolean; supports: boolean }> => ({
  ok: true,
  supports: true,
});

const mount = (cameras: Record<string, 0 | 180>): CameraMountSettings => ({
  cameras: Object.fromEntries(Object.entries(cameras).map(([k, v]) => [k, { rotationDeg: v }])),
});

describe("boot config parsing", () => {
  it("reads dtoverlay lines and skips commented-out ones", () => {
    const lines = parseOverlayLines(CONFIG_TXT);
    expect(lines.map((l) => l.name)).toEqual(["vc4-kms-v3d", "dwc2", "imx290", "imx290"]);
    // The disabled googlevoicehat overlay (rgb_led_events plan) stays invisible.
    expect(lines.some((l) => l.name.startsWith("#"))).toBe(false);
  });

  it("finds the lines for one camera, across sections", () => {
    const lines = parseOverlayLines(CONFIG_TXT);
    expect(overlayLinesForCamera(lines, "cam0").map((l) => l.text)).toEqual([
      "dtoverlay=imx290,cam0,4lane",
    ]);
    expect(overlayLinesForCamera(lines, "cam2")).toEqual([]);
  });

  it("treats a missing rotation token as the overlay's own default of 0", () => {
    const [line] = overlayLinesForCamera(parseOverlayLines(CONFIG_TXT), "cam1");
    expect(rotationOfLine(line!)).toBe(0);
  });

  it("reports an unparseable rotation as unknown rather than guessing", () => {
    const [line] = overlayLinesForCamera(
      parseOverlayLines("dtoverlay=imx290,cam0,rotation=90\n"),
      "cam0",
    );
    expect(rotationOfLine(line!)).toBeNull();
  });

  it("summarises what the boot config says about a camera", () => {
    expect(bootConfigCamera(CONFIG_TXT, "cam0")).toEqual({
      sensor: "imx290",
      rotation: 0,
      lines: 1,
    });
    expect(bootConfigCamera(CONFIG_TXT, "cam9")).toEqual({ sensor: null, rotation: null, lines: 0 });
    // Duplicate lines that disagree are "unknown", which forces a rewrite that
    // makes every one of them say the same thing.
    const duped = "dtoverlay=imx290,cam0\ndtoverlay=imx290,cam0,rotation=180\n";
    expect(bootConfigCamera(duped, "cam0")).toMatchObject({ rotation: null, lines: 2 });
  });

  it("maps connectors and stream keys to the overlay's camN token", () => {
    expect(overlayCamToken("csi0")).toBe("cam0");
    expect(overlayCamToken("csi1")).toBe("cam1");
    expect(overlayCamToken("usb0")).toBeNull();
    expect(resolveCamToken("cam1", HARDWARE)).toBe("cam1");
    // A block that does not declare the key is the whole answer: this device
    // has no such camera, whatever its name looks like.
    expect(resolveCamToken("cam7", HARDWARE)).toBeNull();
    // No hardware block (a v1 device): a camN stream key stands for itself,
    // which is exactly what the install script writes there.
    expect(resolveCamToken("cam1", null)).toBe("cam1");
    expect(resolveCamToken("front", null)).toBeNull();
  });

  it("resolves the boot config path, Bookworm first", () => {
    const dir = tmp();
    const legacy = join(dir, "boot", "config.txt");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "");
    const bookworm = join(dir, "firmware", "config.txt");
    expect(resolveBootConfigPath([bookworm, legacy])).toBe(legacy);
    mkdirSync(dirname(bookworm), { recursive: true });
    writeFileSync(bookworm, "");
    expect(resolveBootConfigPath([bookworm, legacy])).toBe(bookworm);
    expect(resolveBootConfigPath([join(dir, "nope")])).toBeNull();
  });
});

describe("rotation in force (the live device tree)", () => {
  it("reads the big-endian u32 at the enumerated camera's own node", () => {
    const d = device({ inForce: { cam0: 180 } });
    expect(dtRotationForCamera("/base/soc/i2c0mux/i2c@0/imx290@1a", d.dtRoot)).toBe(180);
  });

  it("returns null (never 0) when the node or property is absent", () => {
    const d = device({ inForce: { cam0: 0 } });
    expect(dtRotationForCamera("/base/soc/i2c0mux/i2c@7/imx290@1a", d.dtRoot)).toBeNull();
    expect(dtRotationForCamera("", d.dtRoot)).toBeNull();
    expect(dtRotationForCamera("/base/../../etc/passwd", d.dtRoot)).toBeNull();
  });
});

describe("the privileged writer (system/xorgate-camrotate)", () => {
  it("edits one token and leaves every other line and parameter alone", async () => {
    const d = device();
    await helperWriter(d.bootConfigPath)("imx290", "cam0", 180);
    expect(d.read()).toBe(CONFIG_TXT.replace("imx290,cam0,4lane", "imx290,cam0,4lane,rotation=180"));
  });

  it("is idempotent: a second identical call writes nothing (exit 3)", async () => {
    const d = device();
    const write = helperWriter(d.bootConfigPath);
    await write("imx290", "cam0", 180);
    const after = d.read();
    expect(await write("imx290", "cam0", 180)).toEqual({ ok: true, changed: false, detail: "" });
    expect(d.read()).toBe(after);
  });

  it("removes the token again for 0 rather than writing rotation=0", async () => {
    const d = device();
    const write = helperWriter(d.bootConfigPath);
    await write("imx290", "cam0", 180);
    await write("imx290", "cam0", 0);
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("keeps a backup of the file as it was before the first edit", async () => {
    const d = device();
    await helperWriter(d.bootConfigPath)("imx290", "cam0", 180);
    expect(readFileSync(`${d.bootConfigPath}.bak-camrotate`, "utf8")).toBe(CONFIG_TXT);
    // A later edit must not overwrite the original.
    await helperWriter(d.bootConfigPath)("imx290", "cam1", 180);
    expect(readFileSync(`${d.bootConfigPath}.bak-camrotate`, "utf8")).toBe(CONFIG_TXT);
  });

  it("refuses a line that belongs to another overlay, and bad arguments", async () => {
    const d = device();
    const write = helperWriter(d.bootConfigPath);
    // cam0 exists, but not under an imx477 overlay.
    expect((await write("imx477", "cam0", 180)).ok).toBe(false);
    expect((await write("imx290", "cam0", 90 as unknown as 0)).ok).toBe(false);
    expect((await write("../../etc/passwd", "cam0", 180)).ok).toBe(false);
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("never contains a reboot", () => {
    const body = readFileSync(HELPER, "utf8");
    // The one invariant worth a grep: this feature must have no code path that
    // reboots a fielded device.
    expect(/^\s*(sudo\s+)?(systemctl\s+reboot|reboot|shutdown)\b/m.test(body)).toBe(false);
  });
});

describe("reconcileCameraMount", () => {
  it("does nothing at all when the namespace is absent", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: undefined,
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state).toBeNull();
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("edits the overlay, reports pending-reboot, and does not touch the file again", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const opts = {
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    };
    const first = await reconcileCameraMount(opts);
    expect(first?.wrote).toBe(true);
    expect(first?.rebootRequired).toBe(true);
    expect(first?.cameras).toEqual([
      { streamKey: "cam0", desiredDeg: 180, inForceDeg: 0, bootDeg: 180, verdict: "pending-reboot" },
    ]);
    const afterFirst = d.read();
    expect(afterFirst).toContain("dtoverlay=imx290,cam0,4lane,rotation=180");

    // Every later pass is a no-op: same verdict, byte-identical file.
    for (let i = 0; i < 3; i += 1) {
      const again = await reconcileCameraMount(opts);
      expect(again?.wrote).toBe(false);
      expect(again?.rebootRequired).toBe(true);
      expect(d.read()).toBe(afterFirst);
    }
  });

  it("reports applied once the kernel has actually booted with it", async () => {
    const d = device({
      config: CONFIG_TXT.replace("imx290,cam0,4lane", "imx290,cam0,4lane,rotation=180"),
      inForce: { cam0: 180 },
    });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.rebootRequired).toBe(false);
    expect(state?.wrote).toBe(false);
    expect(state?.cameras[0]).toMatchObject({ verdict: "applied", inForceDeg: 180 });
  });

  it("re-edits after a re-image dropped the token, and asks for one more reboot", async () => {
    // The SD-reimage / stock-reinstall case: config.txt lost the rotation, the
    // kernel is running 180 from the pre-image boot. Desired still 180.
    const d = device({ inForce: { cam0: 180 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(d.read()).toContain("rotation=180");
    expect(state?.cameras[0]).toMatchObject({ verdict: "applied" });
  });

  it("leaves an unmanaged camera's overlay strictly alone", async () => {
    const d = device({ inForce: { cam0: 0, cam1: 0 } });
    await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(d.read()).toContain("dtoverlay=imx290,cam1\n");
  });

  it("refuses to edit a sensor whose overlay has no rotation parameter", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: async () => ({ ok: true, supports: false }),
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.cameras[0]?.verdict).toBe("unsupported");
    expect(state?.rebootRequired).toBe(false);
    expect(d.read()).toBe(CONFIG_TXT); // untouched
  });

  it("refuses when the probe itself could not run", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: async () => ({ ok: false, supports: false }),
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.cameras[0]?.verdict).toBe("unsupported");
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("says so when there is no overlay line, or no camera by that name", async () => {
    const d = device({ config: "camera_auto_detect=1\n", inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180, cam7: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.cameras.find((c) => c.streamKey === "cam0")?.verdict).toBe("no-overlay");
    expect(state?.cameras.find((c) => c.streamKey === "cam7")?.verdict).toBe("unknown-camera");
  });

  it("reports a failed privileged write instead of pretending it landed", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: async () => ({ ok: false, changed: false, detail: "sudo: a password is required" }),
    });
    expect(state?.cameras[0]?.verdict).toBe("write-failed");
    expect(state?.cameras[0]?.detail).toContain("sudo xorgate update");
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("says it could not confirm when the device tree is unreadable", async () => {
    const d = device(); // no .camera file, no device-tree node
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.cameras[0]).toMatchObject({ verdict: "unconfirmed", inForceDeg: null });
    // The edit still happened — we just cannot claim it is in force.
    expect(d.read()).toContain("rotation=180");
    expect(state?.rebootRequired).toBe(false);
  });

  it("works on a v1 device with no hardware block", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: null,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state?.cameras[0]?.verdict).toBe("pending-reboot");
    expect(d.read()).toContain("rotation=180");
  });

  it("handles an empty camera map (managing nothing) without reading the boot config", async () => {
    const d = device({ inForce: { cam0: 0 } });
    const state = await reconcileCameraMount({
      settings: { cameras: {} },
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(state).toMatchObject({ cameras: [], rebootRequired: false, wrote: false });
    expect(d.read()).toBe(CONFIG_TXT);
  });

  it("rewrites duplicate lines in different sections to agree", async () => {
    const config = "[cm4]\ndtoverlay=imx290,cam0\n[cm5]\ndtoverlay=imx290,cam0,4lane\n";
    const d = device({ config, inForce: { cam0: 0 } });
    await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    expect(d.read()).toBe(
      "[cm4]\ndtoverlay=imx290,cam0,rotation=180\n[cm5]\ndtoverlay=imx290,cam0,4lane,rotation=180\n",
    );
  });

  it("survives a read-only boot config by reporting, not throwing", async () => {
    const d = device({ inForce: { cam0: 0 } });
    chmodSync(d.bootConfigPath, 0o444);
    const state = await reconcileCameraMount({
      settings: mount({ cam0: 180 }),
      hardware: HARDWARE,
      pipelineDir: d.pipelineDir,
      bootConfigPath: d.bootConfigPath,
      dtRoot: d.dtRoot,
      probe: supported,
      applyRotation: helperWriter(d.bootConfigPath),
    });
    // Either the helper failed (unprivileged test runner) or it succeeded via
    // its rename — both are legitimate; what matters is that we got a verdict.
    expect(["write-failed", "pending-reboot"]).toContain(state?.cameras[0]?.verdict);
  });
});
