/**
 * Power health readers — throttle state, PMIC rail ADC, negotiated PSU limit.
 *
 * Everything here answers one question: "is this device browning out?" The
 * throttle mask is the firmware's own verdict, the PMIC ADC gives the analog
 * view (the EXT5V input rail), and the device-tree max_current node records
 * what the firmware negotiated with the PSU at boot (5000 mA on a proper
 * 5V/5A PD supply, 3000 mA on anything else).
 *
 * Availability varies by hardware: get_throttled works on all Pis,
 * pmic_read_adc and /proc/device-tree/chosen/power are Pi 5 family only, and
 * none exist on a dev box — every reader returns null rather than throwing,
 * matching the rest of the HAL. Parsers are pure and exported for tests.
 */
import { readFile } from "node:fs/promises";
import { run } from "../lib/exec.js";

/** Bits 0–3 of the mask (same legend for current and sticky). */
export const THROTTLE_BITS = [
  { bit: 0x1, label: "undervoltage" },
  { bit: 0x2, label: "freq capped" },
  { bit: 0x4, label: "throttled" },
  { bit: 0x8, label: "soft temp limit" },
] as const;

export interface ThrottleState {
  /** Bits 0–3 of the raw mask: what is happening right now. */
  current: number;
  /** Bits 16–19 shifted down: what has happened since boot (clears only on reboot). */
  sticky: number;
}

/** Pure: parse `vcgencmd get_throttled` output ("throttled=0x50005"). */
export function parseThrottled(stdout: string): ThrottleState | null {
  const m = stdout.match(/throttled=0x([0-9a-fA-F]+)/);
  if (!m) return null;
  const mask = parseInt(m[1], 16);
  return { current: mask & 0xf, sticky: (mask >> 16) & 0xf };
}

/** Throttle state via `vcgencmd get_throttled`; null off-Pi or on failure. */
export async function readThrottled(): Promise<ThrottleState | null> {
  const res = await run("vcgencmd", ["get_throttled"], { timeoutMs: 3000 });
  if (res.failed) return null;
  return parseThrottled(res.stdout);
}

/** One PMIC rail, keyed by name with the _A/_V suffix stripped (e.g. VDD_CORE). */
export type PmicAdc = Record<string, { amps?: number; volts?: number }>;

/**
 * Pure: parse the no-arg `vcgencmd pmic_read_adc` dump. Lines look like
 * "  VDD_CORE_A current(7)=0.95551000A" / " EXT5V_V volt(24)=5.13756000V".
 * Returns null when no channels parse (Pi 4 firmware answers an error string).
 */
export function parsePmicAdc(stdout: string): PmicAdc | null {
  const out: PmicAdc = {};
  for (const line of stdout.split("\n")) {
    const a = line.match(/^\s*(\S+)_A current\(\d+\)=([\d.]+)A/);
    if (a) {
      (out[a[1]] ??= {}).amps = Number(a[2]);
      continue;
    }
    const v = line.match(/^\s*(\S+)_V volt\(\d+\)=([\d.]+)V/);
    if (v) (out[v[1]] ??= {}).volts = Number(v[2]);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One-shot PMIC ADC dump (all channels, ~3 ms); null off Pi 5 / on failure. */
export async function readPmicAdc(): Promise<PmicAdc | null> {
  const res = await run("vcgencmd", ["pmic_read_adc"], { timeoutMs: 3000 });
  if (res.failed) return null;
  return parsePmicAdc(res.stdout);
}

/** Pure: the EXT5V (5V input rail) voltage from a parsed ADC dump. */
export function rail5vFrom(adc: PmicAdc): number | null {
  return adc.EXT5V?.volts ?? null;
}

/**
 * PSU max current negotiated at boot, in mA (5000 on a 5V/5A PD supply, 3000
 * otherwise). Device-tree u32s are big-endian. Static per boot — read once.
 * Null when the node is absent (pre-Pi 5, dev box).
 */
export async function readMaxCurrentMa(
  path = "/proc/device-tree/chosen/power/max_current",
): Promise<number | null> {
  try {
    const buf = await readFile(path);
    if (buf.length < 4) return null;
    return buf.readUInt32BE(0);
  } catch {
    return null;
  }
}
