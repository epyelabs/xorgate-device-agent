/**
 * Device -> cloud REPORTED config plane (improve_device_settings_management,
 * Phase 3). The mirror image of `cloud-config.ts`: that module takes the
 * retained desired document off `xorgate/devices/{id}/config` and persists it
 * into settings.json; this one publishes what the device ACTUALLY holds back
 * to `xorgate/devices/{id}/config/reported`, so the cloud can say
 * applied / adjusted / rejected instead of only "saved".
 *
 * Payload (design.md §4):
 *   { "v": 1, "deviceId": "...", "ts": <epoch ms>,
 *     "rev": <last applied desired rev; 0 = never received one>,
 *     "origin": "cloud" | "local" | "boot",
 *     "effective": { <namespace>: <value actually in force>, ... },
 *     "status":    { <namespace>: { state, at, detail?, reason? }, ... } }
 *
 * QoS 1, retain FALSE — Postgres is the durable mirror, and a retained report
 * would only add a stale-clear lifecycle. No IAM change is needed: the device
 * policy already grants publish on `topic/xorgate/devices/${ThingName}/*`.
 *
 * ⚠️ BLAST RADIUS (design.md §7 — a rule, not an observation). This module is
 * one-directionally isolated from the apply machinery: it READS settings.json,
 * the modem's telemetry file and already-published status objects, and it
 * never writes settings.json, never restarts anything, and is never awaited by
 * an apply path. Every entry point swallows its own errors. A completely
 * broken report path must degrade to pre-Phase-3 behaviour — config still
 * delivers, the cloud just shows "no report yet".
 *
 * Sync bookkeeping lives in its OWN file, `XORGATE_HOME/config-sync.json`, and
 * never inside settings.json: `loadSettings()` is an allowlist rewriter
 * (daemon/settings.ts) that destroys unknown keys on the next save by any
 * writer, and the sim7600-lte daemon greps settings.json by exact path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { runtimeHome } from "../daemon/runtime.js";
import { loadSettings, type AgentSettings } from "../daemon/settings.js";
import { readModemTelemetry, LTE_TELEMETRY_FILE } from "../hardware/modem.js";
import type { CloudConfig } from "./cloud-config.js";

/**
 * How a namespace reaches the hardware once settings.json holds it. Mirrors
 * the cloud registry's `applyClass` (config-contract.json), which the contract
 * test pins — the two ends must agree, because the cloud uses this to say
 * whether "saved" means "already in force".
 *
 *  - `modem-poll`    the sim7600-lte daemon re-reads settings.json on its own
 *                    cadence (~30 s for the antenna bias; at each recovery
 *                    decision for the policy knobs). NEVER restart that
 *                    service to apply a setting — it drops LTE.
 *  - `agent-poll`    our own pollers pick it up (recording 5 s + forced on
 *                    every cloud message, timeSync ~30 s, imuMount per sample).
 *  - `agent-restart` no namespace uses it today (Q4); kept so a future
 *                    restart-applied key has somewhere to declare itself.
 */
export type ApplyClass = "modem-poll" | "agent-poll" | "agent-restart";

/**
 * Why this report is being sent. The cloud's mirror Lambda only distinguishes
 * `local` (a device-originated edit it must fold back into the desired doc —
 * Phase 4) from everything else; `boot` covers both the on-connect state
 * assertion and the periodic heartbeat, which are the same claim ("here is
 * what I hold right now") made for different reasons.
 */
export type ReportOrigin = "cloud" | "local" | "boot";

/** Per-namespace verdict. Cloud-side `pending` is COMPUTED, never reported. */
export type NamespaceState = "applied" | "adjusted" | "rejected";

export interface NamespaceStatus {
  state: NamespaceState;
  /** Epoch ms this verdict was determined (the report's own timestamp). */
  at: number;
  /** Why an `adjusted` value differs from what the cloud asked for. */
  detail?: string;
  /** Why a namespace was `rejected` outright. */
  reason?: string;
}

export interface ConfigReport {
  v: 1;
  deviceId: string;
  ts: number;
  rev: number;
  origin: ReportOrigin;
  effective: Record<string, unknown>;
  status: Record<string, NamespaceStatus>;
}

/**
 * Apply class per namespace. Same five keys as the cloud registry; the
 * contract test asserts the two lists stay identical, so a namespace added
 * cloud-side fails here until the agent learns about it.
 */
export const CONFIG_APPLY_CLASSES: Readonly<Record<string, ApplyClass>> = {
  gnssAntBias: "modem-poll",
  imuMount: "agent-poll",
  recording: "agent-poll",
  lteRecovery: "modem-poll",
  timeSync: "agent-poll",
};

/** Namespace keys in publish order (matches the cloud registry's order). */
export const CONFIG_NAMESPACE_KEYS = Object.keys(CONFIG_APPLY_CLASSES);

// --- sync state -------------------------------------------------------------

export interface ConfigSyncState {
  /** Highest desired `rev` this device has applied. 0 = never received one. */
  lastAppliedRev: number;
  /** Epoch ms of the last report we published (diagnostics only). */
  lastReportTs: number;
}

const EMPTY_SYNC_STATE: ConfigSyncState = { lastAppliedRev: 0, lastReportTs: 0 };

export function configSyncPath(): string {
  return join(runtimeHome(), "config-sync.json");
}

/**
 * Read the sync state, or zeros when absent/unreadable/invalid. NEVER throws:
 * a lost file must degrade to "never applied anything", which makes the worker
 * apply every retained document exactly like it did before Phase 3.
 */
export function loadConfigSyncState(path: string = configSyncPath()): ConfigSyncState {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (obj && typeof obj === "object") {
      const src = obj as Record<string, unknown>;
      const rev = src.lastAppliedRev;
      const ts = src.lastReportTs;
      return {
        lastAppliedRev:
          typeof rev === "number" && Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : 0,
        lastReportTs: typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0,
      };
    }
  } catch {
    /* missing / corrupt — fall through to zeros */
  }
  return { ...EMPTY_SYNC_STATE };
}

/**
 * Persist the sync state. Returns false instead of throwing when the write
 * fails: an unwritable home must not break config delivery, it only means the
 * rev guard resets to "apply everything" on the next boot.
 */
export function saveConfigSyncState(
  state: ConfigSyncState,
  path: string = configSyncPath(),
): boolean {
  try {
    atomicWriteJson(path, state);
    return true;
  } catch {
    return false;
  }
}

/**
 * The rev guard. A retained document is applied when it is NEWER than the last
 * one we applied; redelivery of an already-applied rev is skipped, which is
 * what stops every reconnect from reverting state the device holds.
 *
 * `rev` absent or 0 means the backend predates Phase 2 (or the message is the
 * bare v1 shape) — always apply, exactly like today. That compatibility branch
 * is what lets an upgraded agent run against an un-upgraded backend.
 */
export function shouldApplyRev(rev: number | undefined, lastAppliedRev: number): boolean {
  if (rev === undefined || rev <= 0) return true;
  return rev > lastAppliedRev;
}

// --- effective values -------------------------------------------------------

/**
 * The applied antenna-bias state, read from the sim7600-lte daemon's telemetry
 * file (`gnss_ant_bias`) rather than from settings.json. This is the whole
 * point of the reported plane for this key: settings.json only says what was
 * REQUESTED, while the modem's own snapshot says what the daemon actually
 * pushed to the hardware — the first time the cloud can verify its oldest
 * config knob.
 */
export interface ModemBiasSample {
  /** Applied bias, or null when the daemon has never reported one. */
  value: boolean | null;
  /** False when the telemetry file is missing, unparseable or stale. */
  fresh: boolean;
  /** Human-readable cause when `fresh` is false. */
  detail?: string;
}

/**
 * How old the modem's telemetry snapshot may be before we stop trusting it.
 * The daemon rewrites it every CSQ poll — 30 s when the signal is stable, less
 * when it isn't — so 180 s is six stable cycles: long enough that a busy
 * daemon never looks stale, short enough that a dead one is obvious.
 */
export const MODEM_TELEMETRY_STALE_MS = 180_000;

export async function readModemBias(
  now: number = Date.now(),
  file: string = LTE_TELEMETRY_FILE,
): Promise<ModemBiasSample> {
  const telemetry = await readModemTelemetry(file);
  if (telemetry === null) {
    return { value: null, fresh: false, detail: "modem telemetry unavailable" };
  }
  const raw = (telemetry as { gnss_ant_bias?: unknown }).gnss_ant_bias;
  const value = raw === 1 || raw === true ? true : raw === 0 || raw === false ? false : null;
  const stampedMs = Date.parse(`${String(telemetry.timestamp ?? "")}`);
  if (!Number.isFinite(stampedMs) || now - stampedMs > MODEM_TELEMETRY_STALE_MS) {
    return { value, fresh: false, detail: "modem telemetry is stale" };
  }
  if (value === null) {
    return { value, fresh: false, detail: "modem has not applied a bias state yet" };
  }
  return { value, fresh: true };
}

/**
 * Read-only hints about latched boot state, so a namespace that is genuinely
 * persisted but not yet ACTING can say so instead of claiming a clean
 * "applied" (design.md §6 caveat). Every field is supplied by an object that
 * already publishes it — nothing here reaches into the apply machinery.
 */
export interface ReportHints {
  /** `RecordingManager.status().bootDefer` — "deferring" / "gating" / … */
  bootDefer?: string | null;
  /** `RecordingManager.status().powerShed` — the current shed rung, if any. */
  powerShed?: string | null;
  /** `ClockStepper.status().armed` — false once NTP synced this boot. */
  clockStepperArmed?: boolean;
}

/**
 * Effective config: what settings.json actually holds right now, with
 * `gnssAntBias` overridden by the modem's applied value.
 *
 * An ABSENT namespace means "device defaults" — the exact convention the
 * desired document uses — so `effective` and the desired doc are directly
 * comparable and the UI resolves defaults for both the same way. Resolving
 * defaults into the report instead would freeze today's values into every
 * stored report and hide the difference between "configured to the default"
 * and "never configured".
 */
export function buildEffective(
  settings: AgentSettings,
  modem: ModemBiasSample,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The APPLIED bias, not the requested one; omitted entirely when the modem
  // has not told us (the status entry carries the reason).
  if (modem.value !== null) out.gnssAntBias = modem.value;
  if (settings.imuMount !== undefined) out.imuMount = settings.imuMount;
  if (settings.recording !== undefined) out.recording = settings.recording;
  if (settings.lteRecovery !== undefined) out.lteRecovery = settings.lteRecovery;
  if (settings.timeSync !== undefined) out.timeSync = settings.timeSync;
  return out;
}

// --- status -----------------------------------------------------------------

/** Key-order-insensitive structural equality (JSON.stringify is not sound here). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
  );
}

/**
 * The last desired document this session saw on the config topic. Held in
 * memory only: it is meaningful exactly as long as the connection that
 * delivered it, and the retained message is redelivered on every connect
 * anyway, so persisting it would buy nothing.
 */
export interface DesiredSnapshot {
  /** The message's `rev` (0 when the backend predates Phase 2). */
  rev: number;
  /** The raw namespaces as they arrived, BEFORE the device's tolerant parse. */
  raw: Record<string, unknown>;
  /** The same message after parseCloudConfig — i.e. post-clamp. */
  parsed: CloudConfig;
}

/** Pull one namespace's post-parse value out of a CloudConfig. */
function parsedNamespace(parsed: CloudConfig, key: string): unknown {
  return (parsed as unknown as Record<string, unknown>)[key];
}

/**
 * Per-namespace verdicts, for every namespace the cloud actually spoke about.
 * Namespaces the desired document never carried get no entry — the device has
 * nothing to say about a setting it was never asked to hold.
 *
 * Order of tests matters:
 *   1. the tolerant parser dropped it entirely      -> rejected
 *   2. the parser changed it (clamp / unknown keys) -> adjusted
 *   3. what we hold differs from what was asked     -> adjusted
 *   4. otherwise                                    -> applied (+ boot-latch detail)
 *
 * (3) is what makes a local edit visible in Phase 3: the rev guard now lets a
 * hand-edited settings.json survive reconnect, and without this the cloud
 * would show a stale "applied" for a value the device no longer holds. Folding
 * such an edit back into the desired doc is Phase 4's job.
 */
export function buildStatus(
  desired: DesiredSnapshot | null,
  effective: Record<string, unknown>,
  modem: ModemBiasSample,
  at: number,
  hints: ReportHints = {},
): Record<string, NamespaceStatus> {
  const out: Record<string, NamespaceStatus> = {};
  if (desired === null) return out;

  for (const key of CONFIG_NAMESPACE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(desired.raw, key)) continue;
    const raw = desired.raw[key];
    const parsed = parsedNamespace(desired.parsed, key);

    if (parsed === undefined || parsed === null) {
      // null = the namespace arrived as an object the tolerant parser emptied;
      // undefined = it arrived as the wrong type outright.
      out[key] = {
        state: "rejected",
        at,
        reason:
          parsed === null
            ? `${key}: no valid fields in the delivered value`
            : `${key}: not a valid ${key === "gnssAntBias" ? "boolean" : "object"}`,
      };
      continue;
    }

    if (!deepEqual(raw, parsed)) {
      out[key] = {
        state: "adjusted",
        at,
        detail: "the device clamped or normalized the delivered value",
      };
      continue;
    }

    const inForce = effective[key];
    if (!deepEqual(inForce, parsed)) {
      out[key] = { state: "adjusted", at, detail: divergenceDetail(key, modem, inForce) };
      continue;
    }

    const detail = latchDetail(key, hints);
    out[key] = detail ? { state: "applied", at, detail } : { state: "applied", at };
  }
  return out;
}

/** Why what we hold differs from what the cloud asked for. */
function divergenceDetail(key: string, modem: ModemBiasSample, inForce: unknown): string {
  if (key === "gnssAntBias") {
    if (!modem.fresh) {
      return `${modem.detail ?? "modem state unknown"} — the bias is saved and will be asserted by the modem daemon`;
    }
    return "saved; the modem daemon has not applied it yet (it re-checks about every 30 s)";
  }
  if (inForce === undefined) {
    return "saved, but the device is not holding this namespace yet";
  }
  return "the device is holding a different value (changed locally?)";
}

/**
 * Honest caveats for a namespace that IS persisted but whose effect is latched
 * for this boot. We deliberately report these rather than trying to un-latch
 * anything — the latches are load-bearing (design.md §6) and out of scope.
 */
function latchDetail(key: string, hints: ReportHints): string | undefined {
  if (key === "recording") {
    const parts: string[] = [];
    const boot = hints.bootDefer ?? null;
    if (boot === "deferring" || boot === "gating") {
      parts.push(
        boot === "deferring"
          ? "video is held by the boot power staging gate and starts when it releases"
          : "video is held by the GPS/LTE gate and starts when it releases",
      );
    }
    if (hints.powerShed) parts.push(`load shedding is active (${hints.powerShed})`);
    return parts.length > 0 ? `in force, but ${parts.join("; ")}` : undefined;
  }
  if (key === "timeSync" && hints.clockStepperArmed === false) {
    return "in force, but the clock stepper stood down for this boot (NTP is synchronized)";
  }
  return undefined;
}

// --- report builder ---------------------------------------------------------

export interface ReportInput {
  deviceId: string;
  ts: number;
  origin: ReportOrigin;
  /** Sync state at build time — `lastAppliedRev` becomes the report's `rev`. */
  lastAppliedRev: number;
  /** settings.json, re-read AFTER any apply completed. */
  settings: AgentSettings;
  modem: ModemBiasSample;
  desired: DesiredSnapshot | null;
  hints?: ReportHints;
}

/** Assemble a complete report. Pure — every input is supplied by the caller. */
export function buildConfigReport(input: ReportInput): ConfigReport {
  const effective = buildEffective(input.settings, input.modem);
  return {
    v: 1,
    deviceId: input.deviceId,
    ts: input.ts,
    rev: input.lastAppliedRev,
    origin: input.origin,
    effective,
    status: buildStatus(input.desired, effective, input.modem, input.ts, input.hints),
  };
}

// --- the worker-facing sync object ------------------------------------------

export interface ConfigSyncOptions {
  deviceId: string;
  /** Publish topic — `xorgate/devices/{deviceId}/config/reported`. */
  topic: string;
  /** QoS 1, retain false. Supplied by the worker, which owns the MQTT client. */
  publish: (topic: string, payload: string) => void;
  settings?: () => AgentSettings;
  modem?: (now: number) => Promise<ModemBiasSample>;
  hints?: () => ReportHints;
  onEvent?: (level: "info" | "warn", msg: string) => void;
  now?: () => number;
  statePath?: string;
  /**
   * Coalescing window. A connect and the retained config message that follows
   * it ~0.5 s later are one event as far as the cloud is concerned; without
   * this they would be two reports a blink apart.
   */
  debounceMs?: number;
  /** Repair backstop for a report that was published while the link was down. */
  heartbeatMs?: number;
  /**
   * How long to wait before re-reporting a `modem-poll` namespace that is not
   * in force yet (see SETTLE_* below).
   */
  settleMs?: number;
  settleReports?: number;
}

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_HEARTBEAT_MS = 3_600_000;

/**
 * The settle re-report, and why it exists.
 *
 * A report is built the moment an apply completes — but a `modem-poll`
 * namespace is not in force then: the sim7600-lte daemon re-reads settings.json
 * on its own ~30 s cadence, and `effective.gnssAntBias` comes from the modem's
 * telemetry file, so the honest verdict at apply time is `adjusted` ("saved,
 * the daemon has not applied it yet"). Without a follow-up the cloud would sit
 * on that verdict until the hourly heartbeat, even though the antenna bias
 * actually landed ~30 s later. Observed on the bench 2026-08-06: the daemon
 * logged `AT+CVAUXS=0` 28 s after the apply, and the cloud still read
 * "adjusted" two minutes on.
 *
 * So: re-report a few times, spaced past the daemon's poll, and stop. The
 * budget is per-rev and small — a value the hardware genuinely refuses settles
 * into `adjusted` and stays there rather than re-reporting forever.
 */
const DEFAULT_SETTLE_MS = 40_000;
const DEFAULT_SETTLE_REPORTS = 3;

/** `cloud` outranks `boot` when both are pending in the same window. */
const ORIGIN_RANK: Record<ReportOrigin, number> = { boot: 0, cloud: 1, local: 2 };

/**
 * Owns the device's half of the config plane: the rev guard, the sync file and
 * the debounced report publisher.
 *
 * Every public method is total — nothing here throws into a caller, because
 * every caller is on the config-delivery path and design.md §7 forbids this
 * module from being able to break it.
 */
export class ConfigSync {
  private readonly opts: ConfigSyncOptions;
  private state: ConfigSyncState;
  private desired: DesiredSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  /** Settle re-reports left for the current desired rev (see DEFAULT_SETTLE_*). */
  private settleBudget = 0;
  private pendingOrigin: ReportOrigin | null = null;
  private stopped = false;

  constructor(opts: ConfigSyncOptions) {
    this.opts = opts;
    this.state = loadConfigSyncState(opts.statePath ?? configSyncPath());
  }

  get lastAppliedRev(): number {
    return this.state.lastAppliedRev;
  }

  /** Should the worker apply a retained document carrying this `rev`? */
  shouldApply(rev: number | undefined): boolean {
    return shouldApplyRev(rev, this.state.lastAppliedRev);
  }

  /**
   * Record the desired document the worker just handled. Called for a SKIPPED
   * document too (`applied: false`), so a redelivery still produces a fully
   * informed report — the cloud needs to hear the current verdict on every
   * connect, not only when something changed.
   */
  noteCloudConfig(
    rev: number | undefined,
    raw: Record<string, unknown>,
    parsed: CloudConfig,
    applied: boolean,
  ): void {
    this.desired = { rev: rev ?? 0, raw, parsed };
    // A new document gets a fresh settle budget: whatever the previous rev
    // failed to settle into is no longer the question being asked.
    this.settleBudget = this.opts.settleReports ?? DEFAULT_SETTLE_REPORTS;
    if (!applied) return;
    if (rev !== undefined && rev > this.state.lastAppliedRev) {
      this.state = { ...this.state, lastAppliedRev: rev };
      if (!saveConfigSyncState(this.state, this.opts.statePath ?? configSyncPath())) {
        // In-memory only from here: the guard still holds for this run, and a
        // restart simply falls back to pre-Phase-3 "apply every redelivery".
        this.opts.onEvent?.("warn", "config sync state could not be persisted");
      }
    }
  }

  /** Queue a report. Coalesces with anything already queued in the window. */
  request(origin: ReportOrigin): void {
    if (this.stopped) return;
    if (this.pendingOrigin === null || ORIGIN_RANK[origin] > ORIGIN_RANK[this.pendingOrigin]) {
      this.pendingOrigin = origin;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pendingOrigin ?? "boot";
      this.pendingOrigin = null;
      void this.publishReport(next);
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Arm the low-frequency repair backstop. Idempotent. */
  startHeartbeat(): void {
    if (this.heartbeat || this.stopped) return;
    this.heartbeat = setInterval(
      () => this.request("boot"),
      this.opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    this.heartbeat.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.timer = null;
    this.heartbeat = null;
    this.settleTimer = null;
  }

  /**
   * Build and publish one report. Never rejects: a failure here is a lost
   * report, and a lost report must cost the device nothing.
   */
  async publishReport(origin: ReportOrigin): Promise<void> {
    if (this.stopped) return;
    try {
      const now = (this.opts.now ?? Date.now)();
      const settings = (this.opts.settings ?? loadSettings)();
      const modem = await (this.opts.modem ?? readModemBias)(now);
      const report = buildConfigReport({
        deviceId: this.opts.deviceId,
        ts: now,
        origin,
        lastAppliedRev: this.state.lastAppliedRev,
        settings,
        modem,
        desired: this.desired,
        hints: this.opts.hints?.(),
      });
      this.opts.publish(this.opts.topic, JSON.stringify(report));
      this.state = { ...this.state, lastReportTs: now };
      saveConfigSyncState(this.state, this.opts.statePath ?? configSyncPath());
      this.scheduleSettleReport(report);
    } catch (err) {
      this.opts.onEvent?.("warn", `config report failed: ${(err as Error).message}`);
    }
  }

  /**
   * Queue one more report when a `modem-poll` namespace is saved but not yet in
   * force — the daemon applies it on its own ~30 s cadence, well after this
   * report was built. Bounded by `settleBudget` (see DEFAULT_SETTLE_*).
   */
  private scheduleSettleReport(report: ConfigReport): void {
    if (this.stopped || this.settleTimer || this.settleBudget <= 0) return;
    const unsettled = Object.entries(report.status).some(
      ([ns, s]) => s.state === "adjusted" && CONFIG_APPLY_CLASSES[ns] === "modem-poll",
    );
    if (!unsettled) return;
    this.settleBudget -= 1;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.request(report.origin === "local" ? "local" : "boot");
    }, this.opts.settleMs ?? DEFAULT_SETTLE_MS);
    this.settleTimer.unref?.();
  }
}
