import type { Collector } from "./index.js";
import type { StreamHandle } from "../../lib/exec.js";
import type { MetricLeaf, ObdStatus } from "../telemetry.js";
import {
  OBD_EXIT,
  OBD_SCAN_SECONDS,
  removeObdBond,
  resolveObdConfig,
  scanObdAdapters,
  streamObdData,
  type ObdAuditCounters,
  type ObdLink,
  type ObdMessage,
  type ObdProfile,
  type ObdResolvedConfig,
  type ObdScanCandidate,
  type ObdScanner,
  type ObdSpawn,
  type ObdUnbonder,
} from "../../hardware/obd.js";
import { loadSettings, type ObdSettings } from "../../daemon/settings.js";

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
 * Settings (P3): the `obd` namespace in settings.json is the source of truth
 * (`resolveObdConfig`, with the P1 env seam as fallback when the namespace is
 * absent). It is re-read on every tick (`agent-poll`) and on `reapply()` after
 * a cloud config message; a changed adapter/PIN/rate/fields/power source
 * SIGINTs the helper and respawns it with the new argv, `enabled:false` or no
 * adapter stops it and reports `disabled` / `not_configured` with link 0.
 * Every one of those is an activity event once per transition, never per tick.
 *
 * Commands (P3): `scan()` runs a 25 s BlueZ discovery (never pairs) and parks
 * the candidates in `effective.obd.scan`; `forget()` stops the helper, drops
 * the bond and holds `not_configured` until the namespace changes (the
 * console pairs the command with `PATCH {obd: null}`).
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
/** settings.json is re-read at most this often from the tick path (reapply() forces it). */
const SETTINGS_POLL_MS = 1_000;
/** While the adapter stays absent, re-warn at most this often (WP3 nit: ~8 s of feed noise). */
export const ADAPTER_ABSENT_REWARN_MS = 600_000;
/** Bound on `effective.obd.audit.inventory` (the distinct-command table). */
export const MAX_INVENTORY_KEYS = 200;
/**
 * While the helper runs, re-publish the config report every Nth audit line
 * (N x 60 s) so the cloud's `effective.obd.audit` counters stay within ~10
 * min of the device without waiting for the hourly heartbeat (REPORT-P1-CAR
 * open issue 3: the report published at `live` predates the first audit line).
 */
export const REPORT_EVERY_AUDITS = 10;

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
  engine_torque_pct: "%",
  reference_torque: "Nm",
  engine_torque: "Nm",
};

/** Supervisor-side states, beyond the helper's own (hardware/obd.ts). */
export type ObdCollectorState =
  | "disabled"
  | "not_configured"
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

/** Result of an `obd_scan`, as `effective.obd.scan` carries it. */
export interface ObdScanResult {
  /** Epoch ms the scan finished. */
  ts: number;
  candidates: ObdScanCandidate[];
  /** Present when the scan helper failed (candidates then empty). */
  error?: string;
}

/**
 * `effective.obd` in the config report (contract 2 + P3). The six namespace
 * fields are the `obd` settings AS THE COLLECTOR RESOLVED THEM (defaults
 * filled; the env seam's values when `source` is "env"), which is what the
 * cloud compares against its desired document (config-sync `obdStatus`);
 * everything else is reported-only runtime state.
 */
export interface ObdEffectiveReport extends Required<ObdSettings> {
  status: ObdCollectorState;
  link: ObdLink;
  /** Where the six namespace fields came from. */
  source: "settings" | "env";
  adapter: { mac: string | null; serial?: string };
  profile?: ObdProfile;
  audit?: {
    counters: Partial<ObdAuditCounters>;
    inventory: Record<string, number>;
    last_stop: { ts?: number; reason?: string } | null;
  };
  scan?: ObdScanResult;
  helper_version?: string;
  allowlist_sha256?: string;
}

export type ObdEventLevel = "info" | "warn" | "error";

export interface ObdCollectorOptions {
  /** Environment to read XORGATE_OBD_* from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** The `obd` settings namespace (default: settings.json's). Test seam. */
  settings?: () => ObdSettings | undefined;
  /** Helper spawner (default: the real/mock stream in hardware/obd.ts). Test seam. */
  spawn?: ObdSpawn;
  /** Bluetooth discovery (default: python/obd_scan.py). Test seam. */
  scanner?: ObdScanner;
  /** Bond removal (default: `bluetoothctl remove`). Test seam. */
  unbond?: ObdUnbonder;
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
  /** Re-read the settings namespace NOW (the worker calls it after a cloud config message). */
  reapply(): void;
  /** `obd_scan`: discover nearby adapters; the result lands in `report().scan`. Never pairs. */
  scan(): Promise<ObdScanResult>;
  /**
   * `obd_forget`: stop the helper, drop the bond, forget the vehicle profile
   * and last stop, and hold `not_configured` until the namespace changes.
   */
  forget(): Promise<{ mac: string | null }>;
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

/**
 * Pure: does this status change warrant a fresh config report? The report's
 * `effective.obd` is a snapshot read at publish time, so without a trigger
 * the cloud would keep the boot-time `connecting / link 0` until the hourly
 * heartbeat (WP3 bench finding). A link move (0/1/2) or a park/exit is the
 * signal; the chatty connect/backoff cycle on a missing adapter is not.
 *
 * Audit follow-up (start-stop fix): the FIRST audit line of a helper run
 * (the report published at `live` carried no `audit` block at all), every
 * REPORT_EVERY_AUDITS-th line after it, and any change in the error /
 * forbidden / voltage-low counters or the last stop reason also re-publish,
 * so an incident is in the console within a minute and the counters within
 * ten, without SSH.
 */
export function obdReportDue(prev: ObdStatus | null, next: ObdStatus | null): boolean {
  if (!prev || !next) return prev !== next;
  if (prev.link !== next.link) return true;
  const terminal = (s: string): boolean => s === "parked" || s === "exited";
  if (terminal(prev.state) !== terminal(next.state)) return true;
  const pa = prev.auditSeq ?? 0;
  const na = next.auditSeq ?? 0;
  if (na !== pa && (pa === 0 || na % REPORT_EVERY_AUDITS === 0)) return true;
  if (prev.errors !== next.errors || prev.forbidden !== next.forbidden) return true;
  if ((prev.voltageLowEvents ?? 0) !== (next.voltageLowEvents ?? 0)) return true;
  return (prev.lastStop ?? null) !== (next.lastStop ?? null);
}

/** One line for `xorgate obd status`: protocol · responders · supported/total fields · powertrain. */
export function profileSummary(profile: ObdProfile | null): string | null {
  if (!profile) return null;
  const supported = profile.supported_fields ?? [];
  const total = supported.length + (profile.unsupported_fields ?? []).length;
  const parts = [
    profile.protocol?.dp ?? profile.protocol?.dpn ?? "protocol ?",
    `ECUs ${(profile.responders ?? []).join(",") || "none"}`,
    `${supported.length}/${total} fields`,
    profile.powertrain ?? "unknown",
  ];
  if (profile.adapter?.ati) parts.push(profile.adapter.ati);
  return parts.join(" · ");
}

/** The journal's 60 s audit line — pure, exported for tests. */
export function auditLine(seq: number, audit: AuditSnapshot, rate: number | null): string {
  const c = audit.counters;
  const n = (v: number | undefined): number => v ?? 0;
  const errors = n(c.err_adapter) + n(c.err_protocol) + n(c.err_identity) + n(c.err_voltage);
  const forbidden = n(c.forbidden_attempts) + n(c.budget_violations);
  return (
    `audit #${seq}: req ${n(c.requests)} (${rate === null ? "—" : rate.toFixed(1)} req/s) ok ${n(c.ok)} ` +
    `no_data ${n(c.no_data)} timeouts ${n(c.timeouts)} err ${errors} forbidden ${forbidden} ` +
    `reconnects ${n(c.reconnects)} voltage_low ${n(c.voltage_low_events)} ` +
    `inventory ${Object.keys(audit.inventory).length} last_stop ${audit.last_stop?.reason ?? "—"}`
  );
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
  const scanner = opts.scanner ?? scanObdAdapters;
  const unbond = opts.unbond ?? removeObdBond;
  const env = opts.env ?? process.env;
  const readSettings = opts.settings ?? (() => loadSettings().obd);

  let started = false;
  let stopped = false;
  let state: ObdCollectorState = "starting";
  let since = now();
  let detail: string | null = null;
  let link: ObdLink = 0;

  /** What settings (or the env seam) say we should be doing. */
  let resolved: ObdResolvedConfig = resolveObdConfig(undefined, { XORGATE_OBD_SERIAL: "" });
  let resolvedKey = "";
  let settingsReadAt = -Infinity;
  /** `obd_forget` latch: this MAC is treated as not configured until the namespace moves. */
  let forgottenMac: string | null = null;
  /** A reconfigure SIGINTed the helper; respawn as soon as it exits (no backoff). */
  let restartPending = false;

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
  /** Audit lines received from the CURRENT helper run (reset on spawn). */
  let auditSeq = 0;
  /** Last `error` line (or stderr) from the current helper run, for the exit event. */
  let lastError: string | null = null;
  /** Open "adapter absent" episode (dedup of the adapter_not_found event). */
  let absent: { since: number; lastWarnAt: number } | null = null;
  let scan: ObdScanResult | null = null;
  let scanInFlight: Promise<ObdScanResult> | null = null;

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

  function describe(r: ObdResolvedConfig): string {
    const h = r.helper;
    return `${h.serial ? `serial ${h.serial}` : `adapter ${h.adapter}`}, ${h.pollHz} Hz, ${
      h.fields ? h.fields.length + " fields" : "all fields"
    }, ${h.powerSource} power, from ${r.source}`;
  }

  /** Go to an off state (disabled / not_configured), stopping the helper if it runs. */
  function goOff(off: "disabled" | "not_configured", why: string, level: ObdEventLevel): void {
    clearTimers();
    restartPending = false;
    sample = null;
    absent = null;
    const changed = setState(off, null);
    setLink(0);
    if (handle) handle.stop("SIGINT"); // onExit sees !resolved.run and stays off
    if (changed) event(level, why);
  }

  /**
   * Re-resolve the namespace (settings first, env fallback) and act on a
   * change: stop, start, or restart the helper. The `forgottenMac` latch
   * turns the adapter `obd_forget` removed into "not configured" until the
   * operator (or the console's `PATCH {obd:null}`) changes the namespace.
   *
   * RUST-PORT: settings-apply seam (docs/PORTING-obd.md §6).
   */
  function applySettings(force: boolean): void {
    if (stopped) return;
    const t = now();
    if (!force && t - settingsReadAt < SETTINGS_POLL_MS) return;
    settingsReadAt = t;
    let next: ObdResolvedConfig;
    try {
      next = resolveObdConfig(readSettings(), env);
    } catch (err) {
      console.warn(`[obd] settings read failed: ${(err as Error).message}`);
      return;
    }
    if (forgottenMac !== null && next.helper.adapter !== forgottenMac) forgottenMac = null;
    if (forgottenMac !== null && next.run && !next.helper.serial) {
      next = { ...next, run: false, off: "not_configured" };
    }
    const key = JSON.stringify({ run: next.run, off: next.off, helper: next.helper });
    const first = resolvedKey === "";
    if (key === resolvedKey) return;
    const wasRunning = resolved.run;
    resolved = next;
    resolvedKey = key;

    if (!next.run) {
      goOff(
        next.off ?? "not_configured",
        next.off === "disabled"
          ? "disabled by settings (obd.enabled=false); helper stopped, link 0"
          : forgottenMac !== null
            ? `adapter ${forgottenMac} forgotten; waiting for new obd settings (link 0)`
            : `adapter not configured (set obd.adapterMac or XORGATE_OBD_ADAPTER); link 0`,
        next.off === "disabled" ? "info" : "warn",
      );
      return;
    }
    absent = null;
    if (handle) {
      // A live helper: SIGINT it (ATZ + close) and respawn with the new argv
      // the moment it exits. No backoff — the operator asked for this.
      restartPending = true;
      clearTimers();
      event("info", `settings changed (${describe(next)}); restarting helper`);
      setState("starting", null);
      handle.stop("SIGINT");
      return;
    }
    clearTimers();
    quickFailures = 0;
    backoffMs = BASE_BACKOFF_MS;
    if (!first || wasRunning) event("info", `starting helper (${describe(next)})`);
    else console.log(`[obd] starting helper (${describe(next)})`);
    spawn();
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
        if (msg.state === "adapter_not_found") {
          // Once per absence episode, then at most every 10 min: the helper
          // cycles connect → adapter_not_found → backoff every few seconds
          // while the dongle is unplugged, and each cycle is a transition.
          const t = now();
          if (!absent) {
            absent = { since: t, lastWarnAt: t };
            event("warn", `adapter not found${d}`);
          } else if (t - absent.lastWarnAt >= ADAPTER_ABSENT_REWARN_MS) {
            absent.lastWarnAt = t;
            event("warn", `adapter still not found after ${Math.round((t - absent.since) / 60_000)} min${d}`);
          } else {
            console.log(`[obd] adapter_not_found${d}`);
          }
          return;
        }
        if (
          absent &&
          (msg.state === "pairing" || msg.state === "probing" || msg.state === "live" || msg.state === "ecu_silent")
        ) {
          const mins = Math.round((now() - absent.since) / 60_000);
          absent = null;
          event("info", `adapter found again after ${mins} min`);
        }
        if (msg.state === "live") event("info", `live, ECU answering${d}`);
        else if (msg.state === "ecu_silent") event("info", `ECU silent, polling stopped${d}`);
        else if (msg.state === "stopped") event("warn", `helper stopped${d}`);
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
        auditSeq += 1;
        // The 60 s audit line in the journal (REPORT-P1-CAR open issue 3):
        // one compact line per helper audit, so `journalctl` alone answers
        // "was it polling, how fast, any errors, any low-voltage episodes".
        console.log(`[obd] ${auditLine(auditSeq, audit, requestRate(prevAudit, audit))}`);
        return;
      }
      case "error":
        lastError = `exit ${msg.code}: ${msg.error}`;
        console.error(`[obd] helper error ${lastError}`);
        return;
    }
  }

  function spawn(): void {
    if (stopped || !resolved.run) return;
    lastError = null;
    auditSeq = 0;
    startedAt = now();
    setState("connecting", null);
    handle = spawnHelper(resolved.helper, {
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
    if (!resolved.run) {
      // We asked it to stop (disabled / not configured / forgotten): stay off.
      setState(resolved.off ?? "not_configured", null);
      setLink(0);
      return;
    }
    if (restartPending) {
      // Reconfigure: fresh argv, fresh backoff, right now.
      restartPending = false;
      quickFailures = 0;
      backoffMs = BASE_BACKOFF_MS;
      spawn();
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

  /** Lazy start on the first read, then a settings poll on every read. */
  function tick(): void {
    const first = !started;
    started = true;
    applySettings(first);
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

  function reqPerSec(): number | null {
    if (!handle) return null; // nothing is polling; the last run's rate is history, not status
    const measured = requestRate(prevAudit, audit);
    if (measured !== null) return measured;
    // Seed from the probe's measured rate until two audit lines exist (WP3
    // nit: the line read "—" for the first ~2 min of every session).
    const seed = profile?.rate_req_s;
    if (handle && typeof seed === "number" && Number.isFinite(seed) && seed >= 0) {
      return Math.round(seed * 10) / 10;
    }
    return null;
  }

  return {
    group: "obd",
    async read() {
      tick();
      return mapLatest();
    },
    async sample() {
      tick();
      return { fields: mapLatest(), updatedMono: changedMono };
    },
    status(): ObdStatus {
      const c = audit?.counters ?? {};
      return {
        state,
        link: currentLink(),
        reqPerSec: reqPerSec(),
        errors:
          (c.err_adapter ?? 0) + (c.err_protocol ?? 0) + (c.err_identity ?? 0) + (c.err_voltage ?? 0),
        forbidden: (c.forbidden_attempts ?? 0) + (c.budget_violations ?? 0),
        voltage: voltage(),
        detail,
        since,
        helperVersion,
        adapter: resolved.helper.serial ?? resolved.helper.adapter,
        profile: profileSummary(profile),
        voltageLowEvents: c.voltage_low_events ?? 0,
        auditSeq,
        lastStop: audit?.last_stop?.reason ?? null,
      };
    },
    // RUST-PORT: config-report seam — this object is `effective.obd` verbatim.
    report(): ObdEffectiveReport {
      const h = resolved.helper;
      const out: ObdEffectiveReport = {
        ...resolved.settings,
        fields: [...resolved.settings.fields],
        status: state,
        link: currentLink(),
        source: resolved.source,
        adapter: { mac: h.adapter, ...(h.serial ? { serial: h.serial } : {}) },
      };
      if (profile) out.profile = profile;
      if (audit) {
        out.audit = {
          counters: audit.counters,
          inventory: audit.inventory,
          last_stop: audit.last_stop,
        };
      }
      if (scan) out.scan = scan;
      if (helperVersion) out.helper_version = helperVersion;
      if (allowlistSha) out.allowlist_sha256 = allowlistSha;
      return out;
    },
    reapply(): void {
      if (!started) return; // the first read starts it anyway
      applySettings(true);
    },
    scan(): Promise<ObdScanResult> {
      if (scanInFlight) return scanInFlight; // a second request joins the running discovery
      scanInFlight = (async () => {
        event("info", `scanning for Bluetooth adapters (${OBD_SCAN_SECONDS} s, never pairs)`);
        try {
          const candidates = await scanner(OBD_SCAN_SECONDS);
          scan = { ts: now(), candidates };
          event("info", `scan done: ${candidates.length} named device(s)`);
        } catch (err) {
          const msg = (err as Error).message;
          scan = { ts: now(), candidates: [], error: msg };
          event("warn", `scan failed: ${msg}`);
        } finally {
          scanInFlight = null;
        }
        return scan;
      })();
      return scanInFlight;
    },
    async forget(): Promise<{ mac: string | null }> {
      const mac = resolved.helper.adapter;
      forgottenMac = mac;
      profile = null;
      if (audit) audit = { ...audit, last_stop: null };
      resolved = { ...resolved, run: false, off: "not_configured" };
      resolvedKey = JSON.stringify({ run: false, off: "not_configured", helper: resolved.helper });
      goOff(
        "not_configured",
        mac ? `adapter ${mac} forgotten; helper stopped, bond removed, waiting for new obd settings` : "forget: no adapter was configured",
        "info",
      );
      if (mac) {
        try {
          await unbond(mac);
        } catch (err) {
          event("warn", `forget: bond removal failed for ${mac}: ${(err as Error).message}`);
        }
      }
      return { mac };
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
