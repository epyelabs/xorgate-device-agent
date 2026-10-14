/**
 * OBD2 — ELM327 adapter over Bluetooth SPP (obd2-bluetooth-integration, P1).
 *
 * The vehicle is read by the bundled `python/obd_read.py` helper (stdlib-only
 * Python: RFCOMM socket by MAC, no root, no /dev/rfcomm node), which owns the
 * ONE gate every byte to the adapter passes through, keeps the append-only
 * audit log, and streams JSON lines back to us — the same pattern as the IMU's
 * `bno085_read.py`. This module is the transport half: build the argv from the
 * env, spawn, parse lines into typed messages. Supervision and the telemetry
 * mapping live in `src/agent/collectors/obd.ts`.
 *
 * Helper contract ("Frozen contract 1", plans/obd2-bluetooth-integration/
 * phase-1/BRIEF.md): stdout JSON lines of type ready/status/profile/sample/
 * audit/error; exit codes 2 no Bluetooth controller, 3 adapter unreachable
 * after 10 min of backoff, 4 protocol refused, 5 stop condition needing a
 * restart, 6 software bug (forbidden/budget). The helper reconnects on its own
 * (status `backoff`); it only exits on those codes or on SIGINT/SIGTERM.
 */
import { run, runStream, type RunResult, type StreamHandle } from "../lib/exec.js";
import { pythonScript } from "../lib/paths.js";
import { isMock } from "../lib/platform.js";
import { OBD_DEFAULTS, OBD_MAC_RE, type ObdPowerSource, type ObdSettings } from "../daemon/settings.js";

/** Helper states, verbatim from the contract's `status` line. */
export const OBD_HELPER_STATES = [
  "connecting",
  "pairing",
  "probing",
  "live",
  "ecu_silent",
  "backoff",
  "stopped",
  "adapter_not_found",
] as const;
export type ObdHelperState = (typeof OBD_HELPER_STATES)[number];

export type ObdLink = 0 | 1 | 2;

/** Helper exit codes (contract 1). 0 = clean exit on SIGINT/SIGTERM. */
export const OBD_EXIT = {
  NO_BLUETOOTH: 2,
  ADAPTER_UNREACHABLE: 3,
  PROTOCOL_REFUSED: 4,
  STOP_CONDITION: 5,
  SOFTWARE_BUG: 6,
} as const;

export interface ObdAuditCounters {
  requests: number;
  ok: number;
  no_data: number;
  timeouts: number;
  err_adapter: number;
  err_protocol: number;
  err_identity: number;
  err_voltage: number;
  reconnects: number;
  forbidden_attempts: number;
  budget_violations: number;
  bytes_tx: number;
  /** Low-voltage EPISODES (below 11.8 V until back above 12.4 V), both power sources (helper >= 0.2.0). */
  voltage_low_events: number;
}

export interface ObdProfile {
  ts?: number;
  adapter?: { mac?: string; ati?: string; at1?: string };
  protocol?: { dpn?: string; dp?: string };
  responders?: string[];
  pids_by_ecu?: Record<string, string[]>;
  supported_fields?: string[];
  unsupported_fields?: string[];
  powertrain?: "ice" | "hybrid" | "ev" | "unknown";
  rate_req_s?: number;
  [extra: string]: unknown;
}

/** A line emitted by the helper, typed per contract 1. */
export type ObdMessage =
  | { type: "ready"; helper?: string; version?: string; allowlist_sha256?: string }
  | { type: "status"; state: ObdHelperState; link: ObdLink; detail?: string; ts?: number }
  | ({ type: "profile" } & ObdProfile)
  | { type: "sample"; ts?: number; fields: Record<string, number> }
  | {
      type: "audit";
      ts?: number;
      counters: Partial<ObdAuditCounters>;
      inventory?: Record<string, number>;
      last_stop?: { ts?: number; reason?: string } | null;
    }
  | { type: "error"; code: number; error: string };

function isLink(v: unknown): v is ObdLink {
  return v === 0 || v === 1 || v === 2;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Pure: parse one stdout line into a typed message, or null for anything that
 * is not a well-formed contract line (partial JSON, a stray print, an unknown
 * type, a known type missing its required fields). The collector ignores
 * nulls, as the contract says it must — a helper that grows a new line type
 * never breaks an older agent.
 *
 * Numeric hygiene for `sample`: only finite numbers survive. A null or string
 * field would drop the whole telemetry frame in the cloud (constraint C1), so
 * it is filtered HERE, at the edge, not at every consumer.
 */
export function parseObdLine(line: string): ObdMessage | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!isRecord(obj) || typeof obj.type !== "string") return null;
  switch (obj.type) {
    case "ready":
      return {
        type: "ready",
        ...(typeof obj.helper === "string" ? { helper: obj.helper } : {}),
        ...(typeof obj.version === "string" ? { version: obj.version } : {}),
        ...(typeof obj.allowlist_sha256 === "string"
          ? { allowlist_sha256: obj.allowlist_sha256 }
          : {}),
      };
    case "status": {
      if (!(OBD_HELPER_STATES as readonly string[]).includes(obj.state as string)) return null;
      if (!isLink(obj.link)) return null;
      return {
        type: "status",
        state: obj.state as ObdHelperState,
        link: obj.link,
        ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
        ...(typeof obj.ts === "number" ? { ts: obj.ts } : {}),
      };
    }
    case "profile": {
      const { type: _t, ...rest } = obj;
      return { type: "profile", ...(rest as ObdProfile) };
    }
    case "sample": {
      if (!isRecord(obj.fields)) return null;
      const fields: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj.fields)) {
        if (typeof v === "number" && Number.isFinite(v)) fields[k] = v;
      }
      return {
        type: "sample",
        fields,
        ...(typeof obj.ts === "number" ? { ts: obj.ts } : {}),
      };
    }
    case "audit": {
      if (!isRecord(obj.counters)) return null;
      const counters: Partial<ObdAuditCounters> = {};
      for (const [k, v] of Object.entries(obj.counters)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          (counters as Record<string, number>)[k] = v;
        }
      }
      const inventory: Record<string, number> = {};
      if (isRecord(obj.inventory)) {
        for (const [k, v] of Object.entries(obj.inventory)) {
          if (typeof v === "number" && Number.isFinite(v)) inventory[k] = v;
        }
      }
      const ls = obj.last_stop;
      const last_stop = isRecord(ls)
        ? {
            ...(typeof ls.ts === "number" ? { ts: ls.ts } : {}),
            ...(typeof ls.reason === "string" ? { reason: ls.reason } : {}),
          }
        : null;
      return {
        type: "audit",
        counters,
        inventory,
        last_stop,
        ...(typeof obj.ts === "number" ? { ts: obj.ts } : {}),
      };
    }
    case "error": {
      if (typeof obj.code !== "number") return null;
      return {
        type: "error",
        code: obj.code,
        error: typeof obj.error === "string" ? obj.error : "",
      };
    }
    default:
      return null;
  }
}

// --- helper config: the `obd` settings namespace, with the P1 env seam as fallback ---

export type { ObdPowerSource };

export interface ObdHelperConfig {
  /** Adapter MAC (AA:BB:CC:DD:EE:FF). Required unless `serial` is set. */
  adapter: string | null;
  /** Emulator pty (`/dev/pts/N`): overrides `adapter`. */
  serial: string | null;
  pin: string;
  pollHz: number;
  /** Restrict the polled fields; null = the helper's default (all). */
  fields: string[] | null;
  powerSource: ObdPowerSource;
}

const MAC_RE = OBD_MAC_RE;
const MAX_POLL_HZ = 20; // the helper's hard request cap; above it is a bug, not a setting

/**
 * Pure: read the P1 adapter configuration from the environment. Lenient on
 * optional keys (a bad poll rate falls back to 1 Hz, a bad power source to
 * `switched`), strict on the adapter: a malformed MAC is treated as not
 * configured so the collector says so instead of spawning a helper that can
 * only fail. Since P3 this is the FALLBACK for a device whose settings.json
 * holds no `obd` namespace (dev/offline boxes); see resolveObdConfig.
 */
export function readObdEnvConfig(env: NodeJS.ProcessEnv = process.env): ObdHelperConfig {
  const rawMac = (env.XORGATE_OBD_ADAPTER ?? "").trim().toUpperCase();
  const adapter = MAC_RE.test(rawMac) ? rawMac : null;
  const rawSerial = (env.XORGATE_OBD_SERIAL ?? "").trim();
  const serial = rawSerial.length > 0 ? rawSerial : null;
  const pin = (env.XORGATE_OBD_PIN ?? "").trim() || "1234";
  const hz = Number(env.XORGATE_OBD_POLL_HZ ?? "");
  const pollHz = Number.isFinite(hz) && hz > 0 && hz <= MAX_POLL_HZ ? hz : 1;
  const fieldsRaw = (env.XORGATE_OBD_FIELDS ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => /^[a-z_][a-z0-9_]*$/.test(f));
  const fields = fieldsRaw.length > 0 ? fieldsRaw : null;
  const ps = (env.XORGATE_OBD_POWER_SOURCE ?? "").trim();
  const powerSource: ObdPowerSource = ps === "constant" ? "constant" : "switched";
  return { adapter, serial, pin, pollHz, fields, powerSource };
}

/** True when the helper has somewhere to connect to. */
export function isObdConfigured(cfg: ObdHelperConfig): boolean {
  return cfg.serial !== null || cfg.adapter !== null;
}

/**
 * What the collector should be doing, resolved from the `obd` settings
 * namespace (the source of truth since P3) with the P1 env seam as fallback.
 *
 * Precedence (README "OBD peripheral"):
 *   1. settings.json `obd` present → it is authoritative: `enabled` is the
 *      kill switch, `adapterMac` the transport, every absent field = its
 *      `OBD_DEFAULTS` value. `XORGATE_OBD_ADAPTER/_PIN/_POLL_HZ/_FIELDS/
 *      _POWER_SOURCE` are IGNORED.
 *   2. settings.json `obd` absent → the env seam exactly as in P1 (`run`
 *      iff an adapter or serial is set).
 *   3. `XORGATE_OBD_SERIAL` (emulator) overrides the adapter in BOTH cases:
 *      the helper talks to the pty, the adapter MAC is only reported. With
 *      settings present it still obeys `enabled`.
 *
 * `off` says why the helper must not run: "disabled" (kill switch) or
 * "not_configured" (nothing to connect to). The `settings` echo is the
 * namespace as resolved (defaults filled), which `effective.obd` reports so
 * the cloud can compare it against what it asked for.
 *
 * RUST-PORT: settings → helper-config seam (docs/PORTING-obd.md §6).
 */
export interface ObdResolvedConfig {
  run: boolean;
  off: "disabled" | "not_configured" | null;
  source: "settings" | "env";
  helper: ObdHelperConfig;
  settings: Required<ObdSettings>;
}

export function resolveObdConfig(
  settings: ObdSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ObdResolvedConfig {
  const rawSerial = (env.XORGATE_OBD_SERIAL ?? "").trim();
  const serial = rawSerial.length > 0 ? rawSerial : null;
  if (settings === undefined) {
    const helper = readObdEnvConfig(env);
    const run = isObdConfigured(helper);
    return {
      run,
      off: run ? null : "not_configured",
      source: "env",
      helper,
      settings: {
        ...OBD_DEFAULTS,
        enabled: run,
        adapterMac: helper.adapter,
        pin: helper.pin,
        pollHz: helper.pollHz,
        fields: helper.fields ?? [],
        powerSource: helper.powerSource,
      },
    };
  }
  const resolved: Required<ObdSettings> = {
    enabled: settings.enabled ?? OBD_DEFAULTS.enabled,
    adapterMac: settings.adapterMac === undefined ? OBD_DEFAULTS.adapterMac : settings.adapterMac,
    pin: settings.pin ?? OBD_DEFAULTS.pin,
    pollHz: settings.pollHz ?? OBD_DEFAULTS.pollHz,
    fields: settings.fields ?? OBD_DEFAULTS.fields,
    powerSource: settings.powerSource ?? OBD_DEFAULTS.powerSource,
  };
  const helper: ObdHelperConfig = {
    adapter: resolved.adapterMac,
    serial,
    pin: resolved.pin,
    pollHz: resolved.pollHz,
    fields: resolved.fields.length > 0 ? [...resolved.fields] : null,
    powerSource: resolved.powerSource,
  };
  const off = !resolved.enabled ? "disabled" : isObdConfigured(helper) ? null : "not_configured";
  return { run: off === null, off, source: "settings", helper, settings: resolved };
}

// --- one-shot Bluetooth actions (obd_scan / obd_forget commands, P3) ---

/** One discovered device, as `effective.obd.scan.candidates[]` carries it. */
export interface ObdScanCandidate {
  mac: string;
  name: string;
  rssi: number | null;
}

/** Discovery window the scan helper runs (BlueZ `scan on` ... `scan off`). */
export const OBD_SCAN_SECONDS = 25;
/** Cap on candidates in the report; the strongest signals win. */
export const OBD_SCAN_MAX_CANDIDATES = 20;

/**
 * Pure: normalize the scan helper's output (an array of {mac,name,rssi}) into
 * at most OBD_SCAN_MAX_CANDIDATES well-formed candidates, strongest RSSI
 * first, unnamed devices (BLE randoms that only ever show their address)
 * dropped. Garbage in → empty list, never a throw: the command path acks
 * before this runs and reports whatever came back.
 */
export function normalizeScanCandidates(raw: unknown): ObdScanCandidate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ObdScanCandidate[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.mac !== "string") continue;
    const mac = item.mac.trim().toUpperCase();
    if (!MAC_RE.test(mac) || seen.has(mac)) continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 64) : "";
    if (name.length === 0 || name.toUpperCase() === mac || name.toUpperCase() === mac.replace(/:/g, "-")) {
      continue;
    }
    const rssi =
      typeof item.rssi === "number" && Number.isFinite(item.rssi) ? Math.round(item.rssi) : null;
    seen.add(mac);
    out.push({ mac, name, rssi });
  }
  out.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity) || (a.mac < b.mac ? -1 : 1));
  return out.slice(0, OBD_SCAN_MAX_CANDIDATES);
}

/** Scanner seam: the collector takes one of these so tests inject a fake. */
export type ObdScanner = (seconds: number) => Promise<ObdScanCandidate[]>;

/**
 * Run `python/obd_scan.py` (stdlib, BlueZ over bluetoothctl): a timed
 * discovery that never pairs and leaves the controller non-pairable and
 * non-discoverable. Off hardware (mock mode) it answers with one synthetic
 * dongle so the command path is demoable. Rejects on a helper failure; the
 * caller turns that into an event + a report with no `scan`.
 */
export async function scanObdAdapters(seconds: number = OBD_SCAN_SECONDS): Promise<ObdScanCandidate[]> {
  if (isMock()) {
    return [
      { mac: "10:21:3E:4F:33:65", name: "OBDII", rssi: -58 },
      { mac: "00:1D:A5:68:98:8B", name: "V-LINK", rssi: -71 },
    ];
  }
  const res = await run("python3", [pythonScript("obd_scan.py"), "--seconds", String(seconds)]);
  if (res.notFound) throw new Error("python3 not found");
  if (res.failed) throw new Error(res.stderr.trim().split("\n").pop() || `exit ${res.exitCode}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error("scan helper printed no JSON");
  }
  return normalizeScanCandidates(parsed);
}

/** Unbonder seam (obd_forget). */
export type ObdUnbonder = (mac: string) => Promise<void>;

/**
 * `bluetoothctl remove <MAC>`: drop the bond so the next helper start (with a
 * new adapter) pairs afresh and the old dongle can never reconnect silently.
 * "Device not available" (never bonded) is a success — the goal state holds.
 * The MAC is validated here AGAIN before it reaches a subprocess argv.
 */
export async function removeObdBond(mac: string): Promise<void> {
  if (!MAC_RE.test(mac)) throw new Error(`refusing to unbond malformed MAC ${JSON.stringify(mac)}`);
  if (isMock()) return;
  const res = await run("bluetoothctl", ["remove", mac]);
  if (res.notFound) throw new Error("bluetoothctl not found");
  const text = `${res.stdout}\n${res.stderr}`;
  if (/Device has been removed/i.test(text) || /not available/i.test(text)) return;
  if (res.failed) throw new Error(text.trim().split("\n").pop() || `exit ${res.exitCode}`);
}

/** Pure: the helper argv for a config (contract 1 flags). */
export function buildObdHelperArgs(cfg: ObdHelperConfig): string[] {
  const args: string[] = [];
  if (cfg.serial) args.push("--serial", cfg.serial);
  else if (cfg.adapter) args.push("--adapter", cfg.adapter, "--pin", cfg.pin);
  args.push("--poll-hz", String(cfg.pollHz));
  if (cfg.fields) args.push("--fields", cfg.fields.join(","));
  args.push("--power-source", cfg.powerSource);
  return args;
}

export interface ObdStreamHandlers {
  onMessage: (msg: ObdMessage) => void;
  /** Python's own stderr (tracebacks, import errors) and spawn failures. */
  onStderr?: (line: string) => void;
}

/** Spawn seam type: the collector takes one of these so tests inject a fake. */
export type ObdSpawn = (cfg: ObdHelperConfig, handlers: ObdStreamHandlers) => StreamHandle;

/**
 * Spawn the helper and stream its lines. Returns the stop handle; the
 * collector supervises exits. Mock mode (dev box / XORGATE_MOCK=1) returns a
 * synthetic stream so the whole path is demoable without a car.
 */
export function streamObdData(cfg: ObdHelperConfig, handlers: ObdStreamHandlers): StreamHandle {
  if (isMock()) return mockObdStream(cfg, handlers);

  const handle = runStream(
    "python3",
    [pythonScript("obd_read.py"), ...buildObdHelperArgs(cfg)],
    {
      onStdout: (line) => {
        const msg = parseObdLine(line);
        if (msg) handlers.onMessage(msg);
      },
      onStderr: (line) => {
        const t = line.trim();
        if (t) handlers.onStderr?.(t);
      },
    },
  );
  void handle.done.then((res) => {
    if (res.notFound) handlers.onStderr?.("python3 not found — install Python 3.11+.");
  });
  return handle;
}

/**
 * Synthetic helper: connects, probes, then idles at ~900 rpm with a slow fuel
 * drain, exactly the line types the real helper emits, so the collector,
 * monitor and config report can be exercised end-to-end off-hardware.
 */
export function mockObdStream(cfg: ObdHelperConfig, handlers: ObdStreamHandlers): StreamHandle {
  let resolveDone!: () => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = () =>
      resolve({ stdout: "", stderr: "", exitCode: 0, failed: false, notFound: false });
  });
  const timers: NodeJS.Timeout[] = [];
  const at = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms));
  };
  const nowS = (): number => Date.now() / 1000;
  const mac = cfg.adapter ?? "00:00:00:00:00:00";

  handlers.onMessage({ type: "ready", helper: "obd_read", version: "mock", allowlist_sha256: "mock" });
  handlers.onMessage({ type: "status", state: "connecting", link: 0, detail: "mock", ts: nowS() });
  at(300, () => handlers.onMessage({ type: "status", state: "probing", link: 1, detail: "mock", ts: nowS() }));
  at(600, () => {
    handlers.onMessage({
      type: "profile",
      ts: nowS(),
      adapter: { mac, ati: "ELM327 v1.5 (mock)", at1: "mock" },
      protocol: { dpn: "A6", dp: "AUTO, ISO 15765-4 (CAN 11/500)" },
      responders: ["7E8"],
      pids_by_ecu: { "7E8": ["0C", "0D", "05", "2F", "42", "A6"] },
      supported_fields: ["rpm", "speed", "coolant_temp", "fuel_level", "module_voltage", "odometer"],
      unsupported_fields: [],
      powertrain: "ice",
      rate_req_s: 10,
    });
    handlers.onMessage({ type: "status", state: "live", link: 2, detail: "mock", ts: nowS() });
  });

  let t = 0;
  let fuel = 61.2;
  let odometer = 48213.4;
  let requests = 0;
  const periodMs = Math.max(50, Math.round(1000 / cfg.pollHz));
  const sampler = setInterval(() => {
    t += periodMs / 1000;
    if (t < 0.6) return; // not live yet
    fuel = Math.max(0, fuel - 0.0005);
    odometer += 0.0001;
    requests += 6;
    handlers.onMessage({
      type: "sample",
      ts: nowS(),
      fields: {
        rpm: Math.round(900 + Math.sin(t) * 25),
        speed: 0,
        coolant_temp: Math.round(Math.min(90, 40 + t * 0.5)),
        fuel_level: Math.round(fuel * 10) / 10,
        module_voltage: Math.round((14.1 + Math.sin(t / 3) * 0.05) * 100) / 100,
        odometer: Math.round(odometer * 10) / 10,
        link: 2,
      },
    });
  }, periodMs);
  const auditor = setInterval(() => {
    handlers.onMessage({
      type: "audit",
      ts: nowS(),
      counters: {
        requests,
        ok: requests,
        no_data: 0,
        timeouts: 0,
        err_adapter: 0,
        err_protocol: 0,
        err_identity: 0,
        err_voltage: 0,
        reconnects: 0,
        forbidden_attempts: 0,
        budget_violations: 0,
        bytes_tx: requests * 6,
      },
      inventory: { "010C1": requests / 6, "010D1": requests / 6 },
      last_stop: null,
    });
  }, 10_000);

  return {
    done,
    stop: () => {
      for (const tm of timers) clearTimeout(tm);
      clearInterval(sampler);
      clearInterval(auditor);
      resolveDone();
    },
  };
}
