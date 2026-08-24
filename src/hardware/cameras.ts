/**
 * Camera enumeration (cm4-support plan): the agent asks libcamera what is
 * actually attached instead of trusting install-time `.camera` files. The
 * hardware block says which CONNECTOR each stream key expects (`csi0`/`csi1`);
 * this module maps enumerated libcamera identity paths onto those connectors,
 * per platform — the path is what the kernel calls a connector THIS boot and
 * is therefore never stored anywhere.
 *
 * Platform → connector mapping (the "enumeration strategy" the platform enum
 * selects; bench-verified identities):
 * - rpi-cm5 (RP1):    /base/axi/pcie@…/rp1/i2c@88000/… = csi0 (CAM0),
 *                     …/i2c@70000/… = csi1 (CAM1). NOTE the i2c addresses do
 *                     NOT sort numerically in connector order.
 * - rpi-cm4 (Unicam): /base/soc/i2c0mux/i2c@0/… = csi0, …/i2c@1/… = csi1.
 */
import { run, type RunResult } from "../lib/exec.js";
import type { Platform } from "./hardware-config.js";

export interface EnumeratedCamera {
  /** libcamera identity path, e.g. /base/soc/i2c0mux/i2c@0/imx290@1a. */
  cameraName: string;
  /** Sensor model libcamera reports (imx290). */
  sensor: string;
  /** Carrier connector this path maps to (csi0/csi1), or null when unknown. */
  connector: string | null;
}

const CM5_CONNECTORS: ReadonlyArray<readonly [string, string]> = [
  ["/i2c@88000/", "csi0"],
  ["/i2c@70000/", "csi1"],
];

const CM4_CONNECTORS: ReadonlyArray<readonly [string, string]> = [
  ["/i2c@0/", "csi0"],
  ["/i2c@1/", "csi1"],
];

export function connectorForPath(platform: Platform, cameraName: string): string | null {
  const table = platform === "rpi-cm5" ? CM5_CONNECTORS : CM4_CONNECTORS;
  for (const [needle, connector] of table) {
    if (cameraName.includes(needle)) return connector;
  }
  return null;
}

/**
 * Parse `rpicam-hello --list-cameras` output. Camera lines look like:
 *   `0 : imx290 [1920x1080 12-bit RGGB] (/base/soc/i2c0mux/i2c@0/imx290@1a)`
 * Mode detail lines are indented and ignored.
 */
export function parseCameraList(output: string, platform: Platform): EnumeratedCamera[] {
  const out: EnumeratedCamera[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*\d+\s*:\s*(\S+)\s.*\((\S+)\)\s*$/.exec(line);
    if (!m) continue;
    const sensor = m[1];
    const cameraName = m[2];
    out.push({ cameraName, sensor, connector: connectorForPath(platform, cameraName) });
  }
  return out;
}

export type CameraListExec = () => Promise<RunResult>;

const defaultExec: CameraListExec = () =>
  run("rpicam-hello", ["--list-cameras"], { timeoutMs: 10_000 });

/**
 * Enumerate attached cameras. `rpicam-hello --list-cameras` exits non-zero
 * when no camera is present — that is a valid empty result, not a failure.
 * A missing tool returns null so the caller can tell "cannot enumerate"
 * (keep whatever pipelines exist) apart from "enumerated zero cameras".
 */
export async function enumerateCameras(
  platform: Platform,
  exec: CameraListExec = defaultExec,
): Promise<EnumeratedCamera[] | null> {
  const res = await exec();
  if (res.notFound) return null;
  const cams = parseCameraList(res.stdout, platform);
  if (cams.length === 0) {
    // Zero cameras is a real state (fresh install, overlays not bound until
    // the next boot) — rpicam-hello then prints "No cameras available!" and
    // exits non-zero. Only an error WITHOUT any recognizable listing output
    // is "cannot enumerate" (broken libcamera stack).
    const text = res.stdout + res.stderr;
    const recognizable =
      text.includes("Available cameras") || /no cameras available/i.test(text);
    if (!recognizable) return null;
  }
  return cams;
}
