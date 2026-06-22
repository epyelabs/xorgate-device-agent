/**
 * IMU — BNO085 over I2C.
 *
 * Detection uses `i2cdetect` (sensor at 0x4A or 0x4B, plus the BMS at 0x6B).
 * Live motion data (rotation vector + linear acceleration) is read by spawning
 * the bundled `python/bno085_read.py` helper, which drives the Adafruit BNO08x
 * library and streams line-delimited JSON back to us. The SHTP protocol and
 * the BNO085's clock-stretching quirks make a pure-Node reader impractical, so
 * we lean on the proven CircuitPython stack (ported from the argus-cli bench).
 */
import { commandExists, run, runStream, type RunResult, type StreamHandle } from "../lib/exec.js";
import { toHexAddr } from "../lib/format.js";
import { pythonScript } from "../lib/paths.js";
import { isMock } from "../lib/platform.js";

/** BNO085 on I2C1, sharing the bus with the BMS/charger (matches the argus board map). */
export const IMU = {
  i2cBus: 1,
  /** 7-bit address is strap-selectable via ADR/SA0: 0x4A (default) or 0x4B. */
  addresses: [0x4a, 0x4b],
  /** Battery charger / BMS on the same bus — reported, not used. */
  bmsAddress: 0x6b,
} as const;

export interface ImuDetect {
  bus: number;
  addresses: number[];
  /** The BNO085 address actually found (0x4A or 0x4B), or null if absent. */
  imuAddress: number | null;
  imuPresent: boolean;
  bmsPresent: boolean;
  /** False when i2cdetect itself is missing/failed (a tooling problem, not "no sensor"). */
  available: boolean;
  /** Human-readable reason when `available` is false. */
  reason?: string;
}

export interface ImuSample {
  /** Unit rotation quaternion (r = real/scalar). */
  quat: { r: number; i: number; j: number; k: number };
  /** Linear acceleration with gravity removed, m/s². */
  linaccel: { x: number; y: number; z: number };
}

/** A line emitted by the Python helper. */
export type ImuMessage =
  | { type: "ready"; address?: string }
  | { type: "sample"; quat: ImuSample["quat"]; linaccel: ImuSample["linaccel"] }
  | { type: "error"; error: string };

/** Pure: parse one JSON line from the helper into a typed message, or null. */
export function parseImuLine(line: string): ImuMessage | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && (obj.type === "ready" || obj.type === "sample" || obj.type === "error")) {
      return obj as ImuMessage;
    }
  } catch {
    /* partial / non-JSON line */
  }
  return null;
}

/** First candidate BNO085 address present on the bus, or null. */
export function findImuAddress(
  present: number[],
  candidates: readonly number[] = IMU.addresses,
): number | null {
  return candidates.find((addr) => present.includes(addr)) ?? null;
}

/**
 * Pure parser for `i2cdetect -y N` grids.
 *
 * The grid is fixed-width: 3 chars per column after the "NN:" row label.
 * A cell is "--" (absent), "UU" (present but claimed by a kernel driver),
 * blank (reserved), or the hex address. We treat the printed hex and "UU"
 * alike: both mean a device acked, and the address is rowBase + columnIndex.
 */
export function parseI2cDetect(stdout: string): number[] {
  const addresses: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{2}):(.*)$/i);
    if (!m) continue;
    const base = parseInt(m[1], 16);
    const rest = m[2];
    for (let col = 0; col < 16; col++) {
      const cell = rest.slice(col * 3, col * 3 + 3).trim();
      if (!cell || cell === "--") continue;
      addresses.push(base + col);
    }
  }
  return addresses;
}

function buildDetect(addresses: number[]): ImuDetect {
  const imuAddress = findImuAddress(addresses);
  return {
    bus: IMU.i2cBus,
    addresses,
    imuAddress,
    imuPresent: imuAddress !== null,
    bmsPresent: addresses.includes(IMU.bmsAddress),
    available: true,
  };
}

/** Detection result for the "i2cdetect unavailable" case (tooling, not sensor). */
function unavailableDetect(reason: string): ImuDetect {
  return {
    bus: IMU.i2cBus,
    addresses: [],
    imuAddress: null,
    imuPresent: false,
    bmsPresent: false,
    available: false,
    reason,
  };
}

export async function detectImu(): Promise<ImuDetect> {
  // On a dev box (macOS / XORGATE_MOCK) pretend a BNO085 is wired at 0x4B so the
  // collector + monitor can be exercised end-to-end without real hardware.
  if (isMock()) {
    return { ...buildDetect([0x4b, IMU.bmsAddress]), imuAddress: 0x4b };
  }

  if (!(await commandExists("i2cdetect"))) {
    return unavailableDetect("i2cdetect not found — install i2c-tools.");
  }
  const res = await run("i2cdetect", ["-y", String(IMU.i2cBus)]);
  if (res.failed) {
    return unavailableDetect(res.stderr.trim() || `i2cdetect failed on bus ${IMU.i2cBus}`);
  }
  return buildDetect(parseI2cDetect(res.stdout));
}

export interface ImuStreamHandlers {
  onSample?: (sample: ImuSample) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

/**
 * Stream live motion data by spawning the Python helper. Returns a stop handle.
 * `address` should be the value detection found (0x4A or 0x4B).
 */
export function streamImuData(address: number, handlers: ImuStreamHandlers): StreamHandle {
  if (isMock()) return mockStream(handlers);

  const handle = runStream("python3", [pythonScript("bno085_read.py"), "--address", toHexAddr(address)], {
    onStdout: (line) => {
      const msg = parseImuLine(line);
      if (!msg) return;
      if (msg.type === "sample") handlers.onSample?.({ quat: msg.quat, linaccel: msg.linaccel });
      else if (msg.type === "ready") handlers.onReady?.();
      else if (msg.type === "error") handlers.onError?.(msg.error);
    },
    // Surface Python's own stderr (missing helper file, tracebacks, import errors)
    // so a broken setup is visible in the daemon log instead of a silent no-op.
    onStderr: (line) => {
      const t = line.trim();
      if (t) handlers.onError?.(t);
    },
  });

  // Surface a missing interpreter as a clean error rather than a silent exit.
  void handle.done.then((res) => {
    if (res.notFound) {
      handlers.onError?.("python3 not found — install Python 3 and adafruit-circuitpython-bno08x.");
    }
  });

  return handle;
}

/** Synthetic slowly-rotating data so the live view is demoable off-hardware. */
function mockStream(handlers: ImuStreamHandlers): StreamHandle {
  let resolveDone!: () => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = () =>
      resolve({ stdout: "", stderr: "", exitCode: 0, failed: false, notFound: false });
  });
  handlers.onReady?.();
  let t = 0;
  const timer = setInterval(() => {
    t += 0.05;
    const r = Math.cos(t / 2);
    const i = Math.sin(t / 2);
    handlers.onSample?.({
      quat: { r, i, j: Math.sin(t / 3) * 0.3, k: Math.cos(t / 4) * 0.2 },
      linaccel: { x: Math.sin(t) * 0.4, y: Math.cos(t) * 0.4, z: Math.sin(t / 2) * 0.2 },
    });
  }, 80);
  return {
    done,
    stop: () => {
      clearInterval(timer);
      resolveDone();
    },
  };
}
