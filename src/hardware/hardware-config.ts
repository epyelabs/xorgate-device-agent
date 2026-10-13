/**
 * Device hardware block (cm4-support plan): the projection of this device's
 * model that the cloud tells it about — platform, encoder token,
 * connector/sensor list, LED pin map, rails, IMU part. The agent turns these
 * FACTS into MECHANISM (camera enumeration strategy, tested pipeline
 * templates, collector gating); the block itself never carries libcamera paths
 * or pipeline strings.
 *
 * Delivery: seeded at install as /etc/xorgate/hardware.json (claim response;
 * env HARDWARE_MANIFEST) and kept live by the `hardware` key on the retained
 * cloud-config envelope — the worker persists an updated block back to the
 * same file and re-renders pipelines.
 *
 * ABSENT or INVALID block = legacy behavior (the hardcoded CM5 wiring every
 * fielded device runs today). An unknown enum is a validation FAILURE, not a
 * guess: a typo'd encoder must fall back loudly to sw-h264/CM5 behavior, never
 * render an untested pipeline (README: a bogus caps string fails as a black
 * tile; a bogus enum must fail as a log line).
 */
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../lib/atomicWrite.js";

export const PLATFORMS = ["rpi-cm5", "rpi-cm4"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ENCODERS = ["sw-h264", "hw-h264"] as const;
export type EncoderToken = (typeof ENCODERS)[number];

export interface HardwareVideo {
  key: string;
  /** Carrier connector (csi0, csi1) — NOT a libcamera path (those are enumerated). */
  connector: string;
  /** Sensor part on that connector (imx290). */
  sensor: string;
  codec: string;
  label?: string;
  maxWidth?: number;
  maxHeight?: number;
  maxFps?: number;
}

/**
 * OBD2 peripheral declaration (obd2-bluetooth-integration, P1): an ELM327
 * adapter reached over Bluetooth SPP. The only shape v1 accepts; anything else
 * under `peripherals.obd` is ignored with a warning (see parseHardwareBlock).
 */
export interface HardwareObdPeripheral {
  adapter: "elm327";
  transport: "bt-spp";
}

/** Optional peripherals a model declares beyond its own board. */
export interface HardwarePeripherals {
  obd?: HardwareObdPeripheral;
}

export interface DeviceHardwareBlock {
  v: 2;
  platform: Platform;
  encoder: EncoderToken;
  rails: boolean;
  statusLed: { r: number; g: number; b: number } | null;
  /** IMU part number, or null when the model declares no IMU. */
  imu: string | null;
  video: HardwareVideo[];
  /**
   * Present ONLY when at least one recognised peripheral is declared, so a
   * block without peripherals serialises exactly as it did before this key
   * existed (hardwareBlocksEqual compares the JSON).
   */
  peripherals?: HardwarePeripherals;
}

function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

function isEncoder(v: unknown): v is EncoderToken {
  return typeof v === "string" && (ENCODERS as readonly string[]).includes(v);
}

/** The CM5 has no hardware H.264 encoder — software is a SoC fact there. */
export function defaultEncoderForPlatform(platform: Platform): EncoderToken {
  return platform === "rpi-cm4" ? "hw-h264" : "sw-h264";
}

function pin(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * `peripherals` is the ONE lenient key of the block (obd2 P1 contract 2): an
 * invalid or unknown peripheral entry is dropped with a single warning and the
 * rest of the block stays valid. A peripheral is additive (a collector that
 * runs or does not), never a fact the camera/encoder path depends on, so a typo
 * here must not knock a fielded device back to legacy wiring the way a bad
 * encoder token rightly does.
 *
 * RUST-PORT: hardware-block parse seam. The Rust port's block struct gains the
 * same optional `peripherals.obd {adapter, transport}` with the same leniency;
 * see docs/PORTING-obd.md.
 */
function parsePeripherals(
  raw: unknown,
  warn: (msg: string) => void,
): HardwarePeripherals | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("peripherals is not an object — ignoring it (rest of the block kept)");
    return undefined;
  }
  const out: HardwarePeripherals = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "obd") {
      warn(`peripherals.${key} is not a known peripheral — ignoring it`);
      continue;
    }
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (e && e.adapter === "elm327" && e.transport === "bt-spp") {
      out.obd = { adapter: "elm327", transport: "bt-spp" };
    } else {
      warn(
        `peripherals.obd ${JSON.stringify(entry)} is not {adapter:"elm327",transport:"bt-spp"} — ignoring it`,
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a hardware block. Returns null (and the caller logs + falls back to
 * legacy behavior) on ANY unrecognized enum or malformed required field —
 * tolerant only about truly optional extras (and, by design, `peripherals`:
 * see parsePeripherals).
 */
export function parseHardwareBlock(
  obj: unknown,
  warn: (msg: string) => void = (m) => console.warn(`[hardware] ${m}`),
): DeviceHardwareBlock | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 2) return null;
  if (!isPlatform(o.platform)) return null;
  const encoder = o.encoder === undefined ? defaultEncoderForPlatform(o.platform) : o.encoder;
  if (!isEncoder(encoder)) return null;

  let statusLed: DeviceHardwareBlock["statusLed"] = null;
  if (o.statusLed !== null && o.statusLed !== undefined) {
    const led = o.statusLed as Record<string, unknown>;
    const r = pin(led.r);
    const g = pin(led.g);
    const b = pin(led.b);
    if (r === null || g === null || b === null) return null;
    statusLed = { r, g, b };
  }

  const videoIn = Array.isArray(o.video) ? o.video : [];
  const video: HardwareVideo[] = [];
  for (const entry of videoIn) {
    if (!entry || typeof entry !== "object") return null;
    const v = entry as Record<string, unknown>;
    if (typeof v.key !== "string" || v.key.length === 0) return null;
    if (typeof v.connector !== "string" || v.connector.length === 0) return null;
    if (typeof v.sensor !== "string" || v.sensor.length === 0) return null;
    video.push({
      key: v.key,
      connector: v.connector,
      sensor: v.sensor,
      codec: typeof v.codec === "string" ? v.codec : "h264",
      ...(typeof v.label === "string" ? { label: v.label } : {}),
      ...(typeof v.maxWidth === "number" ? { maxWidth: v.maxWidth } : {}),
      ...(typeof v.maxHeight === "number" ? { maxHeight: v.maxHeight } : {}),
      ...(typeof v.maxFps === "number" ? { maxFps: v.maxFps } : {}),
    });
  }

  const peripherals = parsePeripherals(o.peripherals, warn);

  return {
    v: 2,
    platform: o.platform,
    encoder,
    rails: o.rails === true,
    statusLed,
    imu: typeof o.imu === "string" && o.imu.length > 0 ? o.imu : null,
    video,
    ...(peripherals ? { peripherals } : {}),
  };
}

/**
 * Load the persisted hardware block. Missing file → null silently (v1-model
 * devices simply have none); unreadable/invalid → null with a warning, because
 * that is a real misconfiguration someone should see in the journal.
 */
export function loadHardwareBlock(
  path: string,
  log: (msg: string) => void = (m) => console.warn(`[hardware] ${m}`),
): DeviceHardwareBlock | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // absent — legacy device or v1 model
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    log(`${path} is not valid JSON — ignoring; using legacy hardware behavior`);
    return null;
  }
  const block = parseHardwareBlock(obj, log);
  if (block === null) {
    log(`${path} failed validation — ignoring; using legacy hardware behavior`);
  }
  return block;
}

/** Persist a cloud-delivered block so the next boot seeds from it. */
export function saveHardwareBlock(path: string, block: DeviceHardwareBlock): void {
  atomicWriteJson(path, block);
}

/** Structural equality — gates the persist + re-render on cloud redelivery. */
export function hardwareBlocksEqual(
  a: DeviceHardwareBlock | null,
  b: DeviceHardwareBlock | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
