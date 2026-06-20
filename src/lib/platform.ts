/**
 * Platform detection and mock-mode gating.
 *
 * We develop on macOS and deploy to the Pi, so the app must know when it is
 * NOT on real hardware. Mock mode is on automatically off-Linux, and can be
 * forced anywhere with XORGATE_MOCK=1. It only affects the cosmetic host label
 * in the monitor header; the system-metrics readers degrade on their own.
 */
import { readFileSync } from "node:fs";
import { platform } from "node:os";

let cachedModel: string | null | undefined;

/** Reads the device-tree model string, or null when it cannot be read. */
export function deviceTreeModel(): string | null {
  if (cachedModel !== undefined) return cachedModel;
  let model: string | null;
  try {
    // The trailing NUL is stripped so comparisons/printing stay clean.
    model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim();
  } catch {
    model = null;
  }
  cachedModel = model;
  return model;
}

export function isRaspberryPi(): boolean {
  const model = deviceTreeModel();
  return model !== null && /raspberry pi/i.test(model);
}

/**
 * True when we are not on real device hardware (dev box).
 * Forced by XORGATE_MOCK=1 (any value), and on by default on non-Linux hosts.
 */
export function isMock(): boolean {
  const flag = process.env.XORGATE_MOCK;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return platform() !== "linux";
}

/** Short human label for the host, shown in the header. */
export function hostLabel(): string {
  if (isMock()) return "mock";
  return deviceTreeModel() ?? `${platform()} host`;
}
