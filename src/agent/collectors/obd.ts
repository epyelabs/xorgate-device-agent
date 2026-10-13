import type { Collector } from "./index.js";
import type { StreamHandle } from "../../lib/exec.js";
import type { MetricLeaf, ObdStatus } from "../telemetry.js";
import {
  isObdConfigured,
  OBD_EXIT,
  readObdEnvConfig,
  streamObdData,
  type ObdAuditCounters,
  type ObdHelperConfig,
  type ObdLink,
  type ObdMessage,
  type ObdProfile,
  type ObdSpawn,
} from "../../hardware/obd.js";

/**
 * OBD2 collector (obd2-bluetooth-integration P1, plan D4/D7) — supervises the
 * `python/obd_read.py` helper and maps its latest sample into the `obd`
 * telemetry group.
 *
 * Shape: the IMU collector (helper spawn, latest-sample cache, lazy start on
 * the first read) plus the media collector's supervision (2 s base backoff,
 * 30 s cap, three quick failures park for 60 s, a slow retry instead of a
 * permanent death). Two exits are special per contract 1: code 6 is a
 * software bug in the helper (forbidden command / budget) and parks with an
 * `error` event; code 4 is a protocol the helper refuses to talk (not ISO
 * 15765-4 CAN) and parks for 10 minutes — retrying faster cannot change the
 * car.
 *
 * Output rules (contract 2, cloud constraint C1): `link` is ALWAYS present
 * while the collector exists; every other leaf comes only from a sample less
 * than 5 s old, is a finite number, and is never null — a stale helper, a
 * silent ECU or an unsupported PID all mean "leaf absent", never "leaf null".
 *
 * RUST-PORT: collector seam. The port's obd collector is this file's state
 * machine (docs/PORTING-obd.md, "State machine") over the same helper lines;
 * the supervision constants below are the contract, not an implementation
 * detail.
 */

const STABLE_MS = 15_000; // a helper alive this long is up; resets backoff
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUICK_FAILURES = 3;
const PARKED_RETRY_MS = 60_000; // 3 quick failures, or exit 6
const PROTOCOL_PARK_MS = 600_000; // exit 4: the car's protocol will not change in a minute
const SAMPLE_FRESH_MS = 5_000;
/** Bound on `effective.obd.audit.inventory` (the distinct-command table). */
export const MAX_INVENTORY_KEYS = 200;

/** Units per field (plan D4). Fields without a unit are plain counts/codes. */
export const OBD_FIELD_UNITS: Readonly<Record<string, string>> = {
  rpm: "rpm",
  speed: "km/h",
  coolant_temp: "°C",
  engine_load: "%",
  throttle: "%",
  pedal: "%",
  intake_temp: "°C",
  ambient_temp: "°C",
  intake_map: "kPa",
  baro: "kPa",
  fuel_level: "%",
  fuel_rate: "L/h",
  module_voltage: "V",
  adapter_voltage: "V",
  run_time: "s",
  odometer: "km",
  distance_since_clear: "km",
};

/** Supervisor-side states, beyond the helper's own (hardware/obd.ts). */
export type ObdCollectorState =
  | "unconfigured"
  | "starting"
  | "retrying"
  | "parked"
  | "stopped"
  | "connecting"
  | "pairing"
  | "probing"
  | "live"
  | "ecu_silent"
  | "backoff"
  | "adapter_not_found";

/** `effective.obd` in the config report (contract 2). */
export interface ObdEffectiveReport {
  status: ObdCollectorState;
  link: ObdLink;
  adapter: { mac: string | null; serial?: string };
  profile?: ObdProfile;
  audit?: {
    counters: Partial<ObdAuditCounters>;
    inventory: Record<string, number>;
    last_stop: { ts?: number; reason?: string } | null;
  };
  helper_version?: string;
  allowlist_sha256?: string;
}

export type ObdEventLevel = "info" | "warn" | "error";

export interface ObdCollectorOptions {
  /** Environment to read XORGATE_OBD_* from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Helper spawner (default: the real/mock stream in hardware/obd.ts). Test seam. */
  spawn?: ObdSpawn;
  /** Activity-event sink (the worker passes store.event). */
  onEvent?: (level: ObdEventLevel, msg: string) => void;
  /** Wall clock, ms (freshness + state timestamps). Test seam. */
  now?: () => number;
  /** Monotonic stamp for the recorder's freshness key. Test seam. */
  mono?: () => bigint;
}

export interface ObdCollector extends Collector {
  /** Health snapshot for `xorgate status` / the monitor. */
  status(): ObdStatus;
  /** The config report's `effective.obd` section. */
  report(): ObdEffectiveReport;
  /** SIGINT the helper (it ATZs and closes) and cancel pending restarts. */
  stop(): void;
}

interface AuditSnapshot {
  counters: Partial<ObdAuditCounters>;
  inventory: Record<string, number>;
  last_stop: { ts?: number; reason?: string } | null;
  /** Helper's own stamp (epoch s) if present, else our receive time in s. */
  ts: number;
}

/** Keep the `max` most-used commands (ties broken by key) — pure, exported for tests. */
export function boundInventory(
  inventory: Record<string, number>,
  max: number = MAX_INVENTORY_KEYS,
): Record<string, number> {
  const entries = Object.entries(inventory);
  if (entries.length <= max) return { ...inventory };
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(entries.slice(0, max));
}

/** Requests per second between two audit snapshots — pure, exported for tests. */
export function requestRate(prev: AuditSnapshot | null, cur: AuditSnapshot | null): number | null {
  if (!cur || typeof cur.counters.requests !== "number") return null;
  if (!prev || typeof prev.counters.requests !== "number") return null;
  const dt = cur.ts - prev.ts;
  if (!(dt > 0)) return null;
  const dr = cur.counters.requests - prev.counters.requests;
  if (dr < 0) return null; // helper restarted between audits
  return Math.round((dr / dt) * 10) / 10;
}

export function createObdCollector(opts: ObdCollectorOptions = {}): ObdCollector {
  const now = opts.now ?? Date.now;
  const mono = opts.mono ?? (() => process.hrtime.bigint());
  const spawnHelper = opts.spawn ?? streamObdData;
  const cfg: ObdHelperConfig = readObdEnvConfig(opts.env ?? process.env);
  const configured = isObdConfigured(cfg);

  let started = false;
  let stopped = false;
  let state: ObdCollectorState = configured ? "starting" : "unconfigured";
  let since = now();
  let detail: string | null = null;
  let link: ObdLink = 0;
  let warnedUnconfigured = false;

  let handle: StreamHandle | null = null;
  let startedAt = 0;
  let backoffMs = BASE_BACKOFF_MS;
  let quickFailures = 0;
  let stableTimer: NodeJS.Timeout | null = null;
  let restartTimer: NodeJS.Timeout | null = null;

  let helperVersion: string | null = null;
  let allowlistSha: string | null = null;
  let profile: ObdProfile | null = null;
  let sample: { fields: Record<string, number>; atMs: number } | null = null;
  let changedMono = mono();
  let audit: AuditSnapshot | null = null;
  let prevAudit: AuditSnapshot | null = null;
  /** Last `error` line (or stderr) from the current helper run, for the exit event. */
  let lastError: string | null = null;

  function event(level: ObdEventLevel, msg: string): void {
    (level === "info" ? console.log : level === "warn" ? console.warn : console.error)(`[obd] ${msg}`);
    opts.onEvent?.(level, `obd: ${msg}`);
  }

  function setState(next: ObdCollectorState, nextDetail: string | null = detail): boolean {
    detail = nextDetail;
    if (next === state) return false;
    state = next;
    since = now();
    return true;
  }

  function setLink(next: ObdLink): void {
    if (next === link) return;
    link = next;
    changedMono = mono();
  }

  function clearTimers(): void {
    if (stableTimer) clearTimeout(stableTimer);
    if (restartTimer) clearTimeout(restartTimer);
    stableTimer = null;
    restartTimer = null;
  }

  function onMessage(msg: ObdMessage): void {
    switch (msg.type) {
      case "ready":
        helperVersion = msg.version ?? helperVersion;
        allowlistSha = msg.allowlist_sha256 ?? allowlistSha;
        console.log(
          `[obd] helper ready (${msg.helper ?? "obd_read"} ${msg.version ?? "?"}, allowlist ${
            (msg.allowlist_sha256 ?? "?").slice(0, 12)
          })`,
        );
        return;
      case "status": {
        setLink(msg.link);
        const changed = setState(msg.state, msg.detail ?? null);
        if (!changed) return;
        const d = msg.detail ? ` (${msg.detail})` : "";
        // Transitions that matter get an activity event; the chatty ones
        // (connecting/pairing/probing/backoff) stay in the log.
        if (msg.state === "live") event("info", `live, ECU answering${d}`);
        else if (msg.state === "ecu_silent") event("info", `ECU silent, polling stopped${d}`);
        else if (msg.state === "stopped") event("warn", `helper stopped${d}`);
        else if (msg.state === "adapter_not_found") event("warn", `adapter not found${d}`);
        else console.log(`[obd] ${msg.state}${d}`);
        return;
      }
      case "profile": {
        const { type: _t, ...rest } = msg;
        profile = rest;
        console.log(
          `[obd] profile: ${profile.protocol?.dp ?? "?"} responders=${
            (profile.responders ?? []).join(",") || "none"
          } supported=${(profile.supported_fields ?? []).length} powertrain=${profile.powertrain ?? "?"}`,
        );
        return;
      }
      case "sample": {
        const { link: sampleLink, ...fields } = msg.fields;
        sample = { fields, atMs: now() };
        changedMono = mono();
        if (sampleLink === 0 || sampleLink === 1 || sampleLink === 2) setLink(sampleLink);
        return;
      }
      case "audit": {
        prevAudit = audit;
        audit = {
          counters: msg.counters,
          inventory: boundInventory(msg.inventory ?? {}),
          last_stop: msg.last_stop ?? null,
          ts: typeof msg.ts === "number" ? msg.ts : now() / 1000,
        };
        return;
      }
      case "error":
        lastError = `exit ${msg.code}: ${msg.error}`;
        console.error(`[obd] helper error ${lastError}`);
        return;
    }
  }

  function spawn(): void {
    if (stopped || !configured) return;
    lastError = null;
    startedAt = now();
    setState(state === "parked" || state === "retrying" ? "connecting" : state);
    handle = spawnHelper(cfg, {
      onMessage,
      onStderr: (line) => {
        console.error(`[obd] python: ${line}`);
        if (!lastError) lastError = line;
      },
    });
    stableTimer = setTimeout(() => {
      stableTimer = null;
      if (stopped || !handle) return;
      quickFailures = 0;
      backoffMs = BASE_BACKOFF_MS;
    }, STABLE_MS);
    const h = handle;
    void h.done.then((res) => {
      if (handle !== h) return; // a stale exit from a handle we already replaced
      onExit(res.exitCode);
    });
  }

  function park(ms: number, why: string, level: ObdEventLevel): void {
    setState("parked", why);
    setLink(0);
    quickFailures = 0;
    backoffMs = BASE_BACKOFF_MS;
    event(level, `${why}; parked for ${Math.round(ms / 1000)} s`);
    scheduleRestart(ms);
  }

  function onExit(exitCode: number | null): void {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
    handle = null;
    sample = null; // whatever it last said, nothing is polling now
    if (stopped) {
      setState("stopped", null);
      setLink(0);
      return;
    }
    const ranMs = now() - startedAt;
    const code = exitCode ?? "?";
    const err = lastError ? ` — ${lastError}` : "";

    if (exitCode === OBD_EXIT.SOFTWARE_BUG) {
      park(PARKED_RETRY_MS, `helper reported a software bug (exit 6)${err}`, "error");
      return;
    }
    if (exitCode === OBD_EXIT.PROTOCOL_REFUSED) {
      park(PROTOCOL_PARK_MS, `vehicle protocol refused (exit 4, not ISO 15765-4 CAN)${err}`, "error");
      return;
    }
    if (ranMs >= STABLE_MS) {
      // Was up, then dropped (adapter unreachable after its own 10 min of
      // backoff, a stop condition, a clean exit we did not ask for): restart
      // promptly with a fresh backoff.
      quickFailures = 0;
      backoffMs = BASE_BACKOFF_MS;
      setState("retrying", null);
      setLink(0);
      event("warn", `helper exited (code ${code}) after ${Math.round(ranMs / 1000)} s${err}; restarting in ${BASE_BACKOFF_MS / 1000} s`);
      scheduleRestart(BASE_BACKOFF_MS);
      return;
    }
    quickFailures += 1;
    if (quickFailures >= MAX_QUICK_FAILURES) {
      park(
        PARKED_RETRY_MS,
        `helper exited (code ${code}) before stabilizing ${quickFailures}x${err}`,
        "error",
      );
      return;
    }
    setState("retrying", null);
    setLink(0);
    console.warn(
      `[obd] helper exited (code ${code})${err}; retry ${quickFailures}/${MAX_QUICK_FAILURES} in ${backoffMs} ms`,
    );
    scheduleRestart(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  function scheduleRestart(delayMs: number): void {
    if (stopped) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawn();
    }, delayMs);
  }

  function start(): void {
    started = true;
    if (!configured) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.warn(
          "[obd] adapter not configured (set XORGATE_OBD_ADAPTER=<MAC> or XORGATE_OBD_SERIAL=/dev/pts/N) — publishing obd.link=0",
        );
      }
      return;
    }
    console.log(
      `[obd] starting helper (${cfg.serial ? `serial ${cfg.serial}` : `adapter ${cfg.adapter}`}, ${cfg.pollHz} Hz, ${cfg.powerSource} power)`,
    );
    spawn();
  }

  function currentLink(): ObdLink {
    if (!handle) return 0; // not running → no adapter link, whatever it last said
    return link;
  }

  function freshFields(): Record<string, number> | null {
    if (!sample || !handle) return null;
    return now() - sample.atMs < SAMPLE_FRESH_MS ? sample.fields : null;
  }

  function mapLatest(): Record<string, MetricLeaf> {
    const out: Record<string, MetricLeaf> = { link: { value: currentLink() } };
    const fields = freshFields();
    if (!fields) return out;
    for (const [key, value] of Object.entries(fields)) {
      if (key === "link" || typeof value !== "number" || !Number.isFinite(value)) continue;
      const unit = OBD_FIELD_UNITS[key];
      out[key] = unit ? { value, unit } : { value };
    }
    return out;
  }

  function voltage(): number | null {
    const f = sample?.fields;
    if (!f) return null;
    const v = f.module_voltage ?? f.adapter_voltage;
    return typeof v === "number" ? v : null;
  }

  return {
    group: "obd",
    async read() {
      if (!started) start();
      return mapLatest();
    },
    async sample() {
      if (!started) start();
      return { fields: mapLatest(), updatedMono: changedMono };
    },
    status(): ObdStatus {
      const c = audit?.counters ?? {};
      return {
        state,
        link: currentLink(),
        reqPerSec: requestRate(prevAudit, audit),
        errors:
          (c.err_adapter ?? 0) + (c.err_protocol ?? 0) + (c.err_identity ?? 0) + (c.err_voltage ?? 0),
        forbidden: (c.forbidden_attempts ?? 0) + (c.budget_violations ?? 0),
        voltage: voltage(),
        detail,
        since,
        helperVersion,
      };
    },
    // RUST-PORT: config-report seam — this object is `effective.obd` verbatim.
    report(): ObdEffectiveReport {
      const out: ObdEffectiveReport = {
        status: state,
        link: currentLink(),
        adapter: { mac: cfg.adapter, ...(cfg.serial ? { serial: cfg.serial } : {}) },
      };
      if (profile) out.profile = profile;
      if (audit) {
        out.audit = {
          counters: audit.counters,
          inventory: audit.inventory,
          last_stop: audit.last_stop,
        };
      }
      if (helperVersion) out.helper_version = helperVersion;
      if (allowlistSha) out.allowlist_sha256 = allowlistSha;
      return out;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimers();
      setState("stopped", null);
      setLink(0);
      handle?.stop("SIGINT"); // the helper ATZs and closes on SIGINT (contract 1)
    },
  };
}
