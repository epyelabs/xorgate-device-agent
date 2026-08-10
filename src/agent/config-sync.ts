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
 *     "status":    { <namespace>: { state, at, detail?, reason? }, ... },
 *     "changed":   { <namespace>: <value|null> }   // origin "local" only }
 *
 * Phase 4 adds the LOCAL half: a fingerprint watcher over settings.json spots a
 * change this module did not make (`xorgate set`, the manage TUI, a human with
 * vim) and publishes `origin: "local"` carrying `changed` — the namespaces that
 * moved, as the device now holds them. The mirror Lambda folds those into
 * `devices.config`, so a local tweak stops being reverted on the next reconnect
 * and starts showing up in the web UI instead.
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { loadBuildInfo } from "../lib/build-info.js";
import { runtimeHome } from "../daemon/runtime.js";
import {
  loadSettings,
  readSettingsFile,
  settingsPath,
  type AgentSettings,
  type SettingsReadResult,
} from "../daemon/settings.js";
import {
  readModemTelemetry,
  LTE_TELEMETRY_FILE,
  type ApnState,
  type ModemCellularTelemetry,
  type ModemSimTelemetry,
  type ModemUplinkTelemetry,
  type SimRegistration,
  type SimState,
} from "../hardware/modem.js";
import type { CellularSettings } from "../daemon/settings.js";
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
  /**
   * `origin: "local"` ONLY: the namespaces that moved since the cloud last knew,
   * as settings.json now holds them (`null` = the namespace was removed locally,
   * i.e. revert it to device defaults). The mirror Lambda merges exactly this
   * into `devices.config` — never `effective`, which for `gnssAntBias` carries
   * the modem's APPLIED value and can still be the pre-edit one for ~30 s after
   * a local change (mirroring that would republish the old value and undo the
   * very edit we are reporting).
   */
  changed?: Record<string, unknown>;
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
  cellular: "modem-poll",
};

/** Namespace keys in publish order (matches the cloud registry's order). */
export const CONFIG_NAMESPACE_KEYS = Object.keys(CONFIG_APPLY_CLASSES);

// --- sync state -------------------------------------------------------------

export interface ConfigSyncState {
  /** Highest desired `rev` this device has applied. 0 = never received one. */
  lastAppliedRev: number;
  /** Epoch ms of the last report we published (diagnostics only). */
  lastReportTs: number;
  /**
   * sha256 of settings.json as of the last time we looked at it (Phase 4). The
   * cheap "has anything at all touched this file" gate for the watcher — a
   * mismatch costs one parse, a match costs nothing.
   */
  settingsHash?: string;
  /**
   * The synced namespaces as the CLOUD is believed to know them: advanced after
   * every write this worker performs (from the file, post-`loadSettings`) and
   * after a local report actually goes out. A local edit is exactly
   * `diffNamespaces(namespaces, current)`.
   *
   * Absent means "never baselined" — a fresh device, or the first boot after
   * upgrading from Phase 3. It must be INITIALIZED from the current file, never
   * treated as `{}`: an empty baseline would report every namespace as a local
   * change and merge the device's clamped values over the cloud's desired
   * document.
   */
  namespaces?: Record<string, unknown>;
  /**
   * A detected local change whose report has not gone out on a live link yet
   * (agent started offline, LTE down, crash between detect and publish).
   * Survives a restart, so the edit converges on the next connect instead of
   * being silently lost.
   */
  localPending?: boolean;
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
      const out: ConfigSyncState = {
        lastAppliedRev:
          typeof rev === "number" && Number.isFinite(rev) && rev > 0 ? Math.floor(rev) : 0,
        lastReportTs: typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0,
      };
      // Phase 4 fields. Each is independently optional: a Phase-3 file simply
      // has none of them, which reads as "never baselined" and self-heals on
      // the first watcher tick.
      const hash = src.settingsHash;
      if (typeof hash === "string" && hash.length > 0) out.settingsHash = hash;
      const ns = src.namespaces;
      if (ns && typeof ns === "object" && !Array.isArray(ns)) {
        out.namespaces = ns as Record<string, unknown>;
      }
      if (src.localPending === true) out.localPending = true;
      return out;
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

// --- local-writer detection (Phase 4) ---------------------------------------

/**
 * Fingerprint of settings.json — sha256 of the raw bytes, or "" when the file
 * is missing/unreadable.
 *
 * This is the cheap gate, not the decision: the file is rewritten wholesale by
 * `atomicWriteJson`, so key reordering or a re-save of identical values changes
 * the hash without changing any setting. Only the namespace diff below decides
 * whether the cloud hears about it.
 */
export function readSettingsHash(path: string = settingsPath()): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

/**
 * The synced namespaces out of a parsed settings object, in registry order.
 * Deliberately post-`loadSettings`: the allowlist rewriter normalizes and
 * clamps, so this is what the device WILL hold — not what a writer typed.
 * `mode` is excluded (reported-only, never part of the desired document).
 */
export function namespacesOf(settings: AgentSettings): Record<string, unknown> {
  const src = settings as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_NAMESPACE_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/**
 * Namespaces that moved from `base` to `next`. A namespace that disappeared
 * maps to `null` — the same "revert to device defaults" erase the cloud PATCH
 * API uses, so a `xorgate set`-then-delete round trip is expressible.
 */
export function diffNamespaces(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_NAMESPACE_KEYS) {
    const before = base[key];
    const after = next[key];
    if (before === undefined && after === undefined) continue;
    if (after === undefined) out[key] = null;
    else if (!deepEqual(before, after)) out[key] = after;
  }
  return out;
}

/**
 * Give the sync file a namespace baseline if it has none, from settings.json as
 * it stands right now.
 *
 * Call this at startup BEFORE anything else writes settings.json (notably the
 * `mediaEnabled` upgrade migration), and never later: the whole point is that a
 * first boot after upgrade adopts the current file silently, while every write
 * that follows is a change the cloud deserves to hear about. Without it, the
 * first watcher tick would diff against nothing and either report every
 * namespace as "locally changed" or (worse) adopt the file and never notice a
 * genuine edit.
 */
export function ensureConfigSyncBaseline(
  statePath: string = configSyncPath(),
  file: string = settingsPath(),
): ConfigSyncState {
  const state = loadConfigSyncState(statePath);
  if (state.namespaces !== undefined) return state;
  const next: ConfigSyncState = {
    ...state,
    namespaces: namespacesOf(loadSettings(file)),
    settingsHash: readSettingsHash(file),
  };
  saveConfigSyncState(next, statePath);
  return next;
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
  /**
   * Reported-only modem facts riding the SAME snapshot (manage_sim_card_info,
   * Phase 1). They are carried here rather than fetched separately so there is
   * one read and one freshness judgment; both are absent unless the snapshot
   * was fresh AND the daemon actually published them.
   *
   * `fresh` above is NOT the gate for these: it also goes false for "the modem
   * has not applied a bias yet", which says nothing about the SIM.
   */
  sim?: ModemSimTelemetry;
  uplink?: ModemUplinkTelemetry;
  /**
   * The daemon's APN apply machinery (Phase 2), riding the same snapshot.
   * ABSENT = the daemon predates the rollback net (or the snapshot is stale) —
   * which the cloud must read as "do not write `cellular` to this device".
   */
  apn?: ModemCellularTelemetry;
}

/** Cap on a device-authored string before it enters `reportedConfig`. */
const MAX_REPORTED_STRING = 64;

/** A non-empty, length-capped string, or undefined. Control chars are dropped. */
function reportedString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  let clean = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) clean += ch;
  }
  clean = clean.trim().slice(0, MAX_REPORTED_STRING);
  return clean.length > 0 ? clean : undefined;
}

const SIM_STATES: readonly SimState[] = [
  "ready",
  "locked",
  "not-detected",
  "error",
  "unknown",
];
const SIM_REGISTRATIONS: readonly SimRegistration[] = [
  "home",
  "roaming",
  "searching",
  "denied",
  "not-searching",
  "unknown",
];

/**
 * Sanitize the daemon's `sim` block for the wire. Returns undefined for
 * anything that is not a usable block — the fail-open posture Phase 1 requires:
 * an unreadable, missing or malformed block must OMIT `sim` entirely, never
 * synthesise `present: 0`, which would report "no SIM" for what is actually
 * "no daemon".
 *
 * A block with no recognizable `state` is dropped for the same reason.
 */
export function parseSimTelemetry(raw: unknown): ModemSimTelemetry | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const state = SIM_STATES.includes(src.state as SimState)
    ? (src.state as SimState)
    : undefined;
  if (state === undefined) return undefined;
  const out: ModemSimTelemetry = { state };
  out.present = src.present === 1 || src.present === true
    ? 1
    : src.present === 0 || src.present === false
      ? 0
      : null;
  // Digits only: an ICCID or a phone number is the one place a rogue value
  // would be rendered verbatim to an operator as an identifier.
  const iccid = reportedString(src.iccid);
  if (iccid !== undefined && /^[0-9]{10,22}$/.test(iccid)) out.iccid = iccid;
  const msisdn = reportedString(src.msisdn);
  if (msisdn !== undefined && /^\+?[0-9]{3,20}$/.test(msisdn)) out.msisdn = msisdn;
  const carrier = reportedString(src.carrier);
  if (carrier !== undefined) out.carrier = carrier;
  const act = reportedString(src.act);
  if (act !== undefined) out.act = act;
  if (SIM_REGISTRATIONS.includes(src.registration as SimRegistration)) {
    out.registration = src.registration as SimRegistration;
  }
  const checkedAt = reportedString(src.checked_at);
  if (checkedAt !== undefined) out.checked_at = checkedAt;
  return out;
}

const APN_STATES: readonly ApnState[] = ["in-force", "applying", "rolled-back", "rejected"];

/**
 * An APN-shaped field: full value or nothing. Deliberately NOT `reportedString`
 * (which caps at 64 chars): a truncated APN would still pass the charset test
 * and report a value the modem does not hold — for this field, a repaired
 * string is a different string.
 */
const apnField = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9.-]{1,100}$/.test(v) ? v : undefined;

/**
 * Sanitize the daemon's `cellular` (APN machinery) block for the wire. Same
 * fail-open posture as the SIM block: anything unusable OMITS the block, and an
 * absent block downstream means "no rollback net on this device" — the safe
 * reading, since it makes the cloud refuse to write the namespace.
 */
export function parseApnTelemetry(raw: unknown): ModemCellularTelemetry | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const state = APN_STATES.includes(src.state as ApnState) ? (src.state as ApnState) : undefined;
  if (state === undefined) return undefined;
  const out: ModemCellularTelemetry = { state };
  const applied = apnField(src.apn_applied);
  if (applied !== undefined) out.apn_applied = applied;
  const requested = apnField(src.apn_requested);
  if (requested !== undefined) out.apn_requested = requested;
  const lastError = reportedString(src.last_error);
  if (lastError !== undefined) out.last_error = lastError;
  if (typeof src.fails === "number" && Number.isFinite(src.fails) && src.fails >= 0) {
    out.fails = Math.min(99, Math.floor(src.fails));
  }
  const changedAt = reportedString(src.changed_at);
  if (changedAt !== undefined) out.changed_at = changedAt;
  return out;
}

/** Sanitize the daemon's `uplink` block. Undefined when nothing is usable. */
export function parseUplinkTelemetry(raw: unknown): ModemUplinkTelemetry | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const primary = reportedString(src.primary);
  const modemOnly = src.modem_only === 1 || src.modem_only === true ? 1 : 0;
  if (primary === undefined && src.modem_only === undefined) return undefined;
  return { primary: primary ?? null, modem_only: modemOnly };
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
    // A stale snapshot takes the reported-only blocks down with it: a dead
    // daemon's last word about the SIM is not evidence about the SIM NOW, and
    // "unknown" is the honest render for it.
    return { value, fresh: false, detail: "modem telemetry is stale" };
  }
  const sim = parseSimTelemetry(telemetry.sim);
  const uplink = parseUplinkTelemetry(telemetry.uplink);
  const apn = parseApnTelemetry(telemetry.cellular);
  if (value === null) {
    // Unfresh for the BIAS only — the snapshot itself is current, so the
    // reported-only blocks still ride along.
    return {
      value,
      fresh: false,
      detail: "modem has not applied a bias state yet",
      sim,
      uplink,
      apn,
    };
  }
  return { value, fresh: true, sim, uplink, apn };
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
 *
 * `agent.mode` (Phase 4, Q4) is the one REPORTED-ONLY key: it rides `effective`
 * so the cloud can show a field device stuck in `sim`, it never appears in the
 * desired document, and it never gets a `status` entry (`buildStatus` walks the
 * namespace list, which does not contain it). Flipping a fielded device to sim
 * remotely would silently replace real data with synthetic data, so there is
 * deliberately no cloud-writable path.
 *
 * `sim` and `uplink` (manage_sim_card_info, Phase 1) follow `agent.mode`
 * exactly, for the same reason arrived at from the other direction: you cannot
 * SET an ICCID, so there is no desired value to compare against and a `status`
 * badge could only ever read "in force". They are NOT config namespaces —
 * nothing about them belongs in `CONFIG_APPLY_CLASSES`, in the generated
 * contract, or in the database.
 *
 * FAIL OPEN: unreadable, stale, missing or malformed telemetry omits them
 * entirely. Synthesising `present: 0` out of a failed READ would report "no
 * SIM" for what is actually "no daemon" — the exact confusion this phase
 * exists to end.
 */
export function buildEffective(
  settings: AgentSettings,
  modem: ModemBiasSample,
  mode?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // The APPLIED bias, not the requested one; omitted entirely when the modem
  // has not told us (the status entry carries the reason).
  if (modem.value !== null) out.gnssAntBias = modem.value;
  if (settings.imuMount !== undefined) out.imuMount = settings.imuMount;
  if (settings.recording !== undefined) out.recording = settings.recording;
  if (settings.lteRecovery !== undefined) out.lteRecovery = settings.lteRecovery;
  if (settings.timeSync !== undefined) out.timeSync = settings.timeSync;
  // `cellular` follows the namespace convention (absent = defaults = "don't
  // touch"), with `apn` overridden by the modem's APPLIED value — mirroring
  // gnssAntBias, because a report that echoes the requested APN cannot tell
  // the cloud whether it worked. Emitted ONLY when settings.json holds the
  // namespace: every fielded device has an NV APN and no `cellular` key, and
  // reporting the NV value as a held namespace would badge the whole fleet as
  // "device differs from defaults".
  const cellular = effectiveCellular(settings.cellular, modem.apn);
  if (cellular !== undefined) out.cellular = cellular;
  // `build` rides alongside `mode` for the same reason and with the same rules:
  // reported-only, not a config namespace, so it never appears in the desired
  // document, never gets a `status` entry, and the local-edit fold-back cannot
  // write it into `devices.config`. The cloud mirrors it into `agent_version`
  // and the web UI polls it to confirm a remote update landed.
  if (mode !== undefined) out.agent = { mode, build: loadBuildInfo() };
  if (modem.sim !== undefined) out.sim = modem.sim;
  if (modem.uplink !== undefined) out.uplink = modem.uplink;
  // The APN machinery itself is reported-only, like `sim` — it is what the UI
  // reads for "what APN is this device actually on" (configured or not), and
  // its ABSENCE is how the cloud spots a device with no rollback net.
  if (modem.apn !== undefined) out.apn = modem.apn;
  return out;
}

/**
 * The `cellular` namespace as in force. Three cases:
 *  - namespace absent           -> undefined (device defaults, "don't touch")
 *  - apn empty                  -> echoed as-is: "don't touch" is trivially in
 *                                  force, no modem confirmation needed
 *  - apn non-empty              -> the modem's APPLIED APN substituted in; when
 *                                  the daemon has never reported one, the whole
 *                                  key is omitted ("not holding this yet") so
 *                                  the verdict cannot claim an apply that never
 *                                  happened
 */
function effectiveCellular(
  settings: CellularSettings | undefined,
  apn: ModemCellularTelemetry | undefined,
): Record<string, unknown> | undefined {
  if (settings === undefined) return undefined;
  const desired = settings.apn ?? "";
  if (desired === "") return { ...settings };
  if (apn?.apn_applied === undefined) return undefined;
  return { ...settings, apn: apn.apn_applied };
}

// --- status -----------------------------------------------------------------

/** `{}` — the cloud's on-the-wire marker for "revert this namespace". */
function isEmptyObject(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0
  );
}

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

    if (parsed === null && isEmptyObject(raw)) {
      // The cloud sent this namespace as an EMPTY object, which is its
      // "revert to device defaults" marker (`PATCH {ns: null}` —
      // settings_sync_hardening finding 2). The apply dropped the local key and
      // the device is back on defaults: that is the revert SUCCEEDING. Calling
      // it "rejected", as the all-invalid case below does, would put a red
      // badge on a change that worked exactly as asked.
      out[key] =
        effective[key] === undefined
          ? { state: "applied", at }
          : {
              state: "adjusted",
              at,
              detail: "asked to revert to defaults, but the device is still holding a value",
            };
      continue;
    }

    if (parsed === undefined || parsed === null) {
      // null = the namespace arrived as a non-empty object the tolerant parser
      // emptied (nothing in it was usable);
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

    if (key === "cellular") {
      // The APN's verdict comes from the modem daemon's own apply machinery,
      // not from a value comparison: "applying", "rolled back" and "gave up"
      // are states a generic inForce-vs-desired diff cannot express, and the
      // whole point of this phase is that the cloud can tell them apart.
      out[key] = cellularStatus(parsed as CellularSettings, modem.apn, at);
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

/**
 * The `cellular` namespace's verdict, read off the modem daemon's own apply
 * machinery. A rollback or a rejection must be VISIBLE — a green tick over a
 * device that quietly reverted is the worst outcome this feature could have.
 */
function cellularStatus(
  desired: CellularSettings,
  apn: ModemCellularTelemetry | undefined,
  at: number,
): NamespaceStatus {
  const wanted = desired.apn ?? "";
  if (wanted === "") {
    // "Don't touch the modem" needs no confirmation — the daemon writing
    // nothing IS the request being honoured.
    return { state: "applied", at };
  }
  if (apn === undefined) {
    return {
      state: "adjusted",
      at,
      detail:
        "saved, but this device's modem daemon has not reported its APN machinery — " +
        "it may predate the rollback-capable agent and will never apply this",
    };
  }
  if (apn.state === "rejected" && apn.apn_requested === wanted) {
    return {
      state: "rejected",
      at,
      reason:
        `the device gave up on "${wanted}" after ${apn.fails ?? "repeated"} failed applies` +
        `${apn.last_error ? ` (${apn.last_error})` : ""} — change the value to try again`,
    };
  }
  if (apn.state === "applying" && apn.apn_requested === wanted) {
    return {
      state: "adjusted",
      at,
      detail:
        "applying — the modem daemon is confirming the new APN with real traffic " +
        "over the cellular link (allow a few minutes)",
    };
  }
  if (apn.apn_applied === wanted) {
    return { state: "applied", at };
  }
  if (apn.state === "rolled-back" && apn.apn_requested === wanted) {
    return {
      state: "adjusted",
      at,
      detail:
        `the device applied "${wanted}", could not pass data, and rolled back to ` +
        `"${apn.apn_applied ?? "the previous APN"}"` +
        `${apn.last_error ? ` (${apn.last_error})` : ""}`,
    };
  }
  return {
    state: "adjusted",
    at,
    detail: "saved; the modem daemon has not applied it yet (it re-checks about every 30 s)",
  };
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
  /** The run mode in force (`config.mode`) — reported-only, see buildEffective. */
  mode?: string;
  /** Locally-changed namespaces; only meaningful on an `origin: "local"` report. */
  changed?: Record<string, unknown>;
}

/** Assemble a complete report. Pure — every input is supplied by the caller. */
export function buildConfigReport(input: ReportInput): ConfigReport {
  const effective = buildEffective(input.settings, input.modem, input.mode);
  const report: ConfigReport = {
    v: 1,
    deviceId: input.deviceId,
    ts: input.ts,
    rev: input.lastAppliedRev,
    origin: input.origin,
    effective,
    status: buildStatus(input.desired, effective, input.modem, input.ts, input.hints),
  };
  // Only a local report carries `changed`; on any other origin the cloud is the
  // author of the desired document and has nothing to learn from us about it.
  if (input.origin === "local" && input.changed && Object.keys(input.changed).length > 0) {
    report.changed = input.changed;
  }
  return report;
}

// --- the worker-facing sync object ------------------------------------------

export interface ConfigSyncOptions {
  deviceId: string;
  /** Publish topic — `xorgate/devices/{deviceId}/config/reported`. */
  topic: string;
  /** QoS 1, retain false. Supplied by the worker, which owns the MQTT client. */
  publish: (topic: string, payload: string) => void;
  settings?: () => AgentSettings;
  /**
   * Settings reader that keeps the failure reason. Defaults to
   * `readSettingsFile`; `settings` (which cannot express a failure) is still
   * honoured for the many tests that only need a value.
   */
  readSettings?: () => SettingsReadResult;
  modem?: (now: number) => Promise<ModemBiasSample>;
  hints?: () => ReportHints;
  onEvent?: (level: "info" | "warn", msg: string) => void;
  now?: () => number;
  statePath?: string;
  /** settings.json — watched for writes this module did not make. */
  settingsFile?: string;
  /** The run mode in force; rides `effective.agent.mode` (reported-only). */
  mode?: string;
  /**
   * Is the MQTT link up? A local report published into a dead link is lost, so
   * `localPending` is only cleared when this says the report actually went
   * somewhere. Absent = assume connected (tests, offline stub).
   */
  online?: () => boolean;
  /** Fingerprint poll interval; aligned with the recording settings poll. */
  watchMs?: number;
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
  /** Boot-race re-check cadence (see armModemArrivalWatch). */
  modemArrivalMs?: number;
  /** APN-machinery watch cadence (see startApnWatch). */
  apnWatchMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_HEARTBEAT_MS = 3_600_000;

/**
 * How often to fingerprint settings.json. Matched to the recording manager's
 * own settings poll: a local edit is already live on the device within ~5 s, so
 * anything slower would leave the cloud lagging the hardware for no reason, and
 * anything faster buys nothing (the check is a stat + hash of a few KB).
 */
const DEFAULT_WATCH_MS = 5000;

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

/**
 * Boot-race watch (armModemArrivalWatch). 30 s x 20 = a 10-minute window, which
 * covers a cold modem boot including a `configure_gnss` CRESET, then gives up.
 * Each tick is one tmpfs read of a file the lte collector already reads every
 * second, so the cost is nil next to being an hour stale.
 */
const DEFAULT_MODEM_ARRIVAL_MS = 30_000;
const MODEM_ARRIVAL_TRIES = 20;

/**
 * APN-machinery watch (startApnWatch). An APN apply confirms or rolls back on
 * the daemon's own timetable — up to the confirm window (~5 min), far past the
 * settle re-reports — and the outcome MUST reach the cloud promptly: a device
 * that rolled back while the UI shows "applying" forever is this feature
 * failing at its own job. One tmpfs read per tick, report only on change.
 */
const DEFAULT_APN_WATCH_MS = 30_000;

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
  /** Boot-race watch: armed only until the modem daemon first speaks. */
  private modemArrivalTimer: NodeJS.Timeout | null = null;
  private modemArrivalTries = 0;
  private modemSeen = false;
  /** APN-machinery watch (standing): fingerprint of the last REPORTED block. */
  private apnWatchTimer: NodeJS.Timeout | null = null;
  private lastReportedApn: string | undefined;
  private watcher: NodeJS.Timeout | null = null;
  /** Settle re-reports left for the current desired rev (see DEFAULT_SETTLE_*). */
  private settleBudget = 0;
  private pendingOrigin: ReportOrigin | null = null;
  private stopped = false;
  /** Latched so an unreadable settings.json warns once, not every 5 s. */
  private unreadableSettings = false;

  constructor(opts: ConfigSyncOptions) {
    this.opts = opts;
    this.state = loadConfigSyncState(opts.statePath ?? configSyncPath());
  }

  get lastAppliedRev(): number {
    return this.state.lastAppliedRev;
  }

  /** Test/diagnostic view of the persisted sync bookkeeping. */
  get syncState(): ConfigSyncState {
    return { ...this.state };
  }

  private get statePath(): string {
    return this.opts.statePath ?? configSyncPath();
  }

  private get settingsFile(): string {
    return this.opts.settingsFile ?? settingsPath();
  }

  /**
   * Read settings, keeping the failure REASON.
   *
   * Everything that consumes a setting is happy with `loadSettings`'s "{} when
   * we could not read it". The watcher is not: `{}` from an unreadable file
   * looks exactly like "the operator deleted every namespace", and the mirror
   * Lambda would then erase the cloud's desired document (phase 6 found this
   * live — `sudo xorgate set …` leaves settings.json root-owned and the agent
   * runs as the provisioning user, so the very next poll wiped the cloud).
   */
  private readSettings(): SettingsReadResult {
    if (this.opts.readSettings) return this.opts.readSettings();
    if (this.opts.settings) return { ok: true, settings: this.opts.settings() };
    return readSettingsFile(this.settingsFile);
  }

  private loadSettings(): AgentSettings {
    const res = this.readSettings();
    return res.ok ? res.settings : {};
  }

  /** Merge into the sync state and persist. Never throws (see saveConfigSyncState). */
  private persist(patch: Partial<ConfigSyncState>): void {
    this.state = { ...this.state, ...patch };
    saveConfigSyncState(this.state, this.statePath);
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
    // The worker just wrote settings.json (or confirmed it needed no write).
    // Re-baseline the namespaces this document actually carried, so its own
    // write is never mistaken for a local edit — and, just as important, so a
    // namespace the document did NOT carry keeps whatever local change is still
    // waiting to be reported.
    this.noteSettingsWritten(Object.keys(raw));
    if (rev !== undefined && rev > this.state.lastAppliedRev) {
      this.state = { ...this.state, lastAppliedRev: rev };
      if (!saveConfigSyncState(this.state, this.statePath)) {
        // In-memory only from here: the guard still holds for this run, and a
        // restart simply falls back to pre-Phase-3 "apply every redelivery".
        this.opts.onEvent?.("warn", "config sync state could not be persisted");
      }
    }
  }

  /**
   * Re-baseline after a write the WORKER performed, for the namespaces that
   * write could have touched.
   *
   * Read back from the FILE, never from the value we meant to write:
   * `loadSettings()` is an allowlist rewriter that clamps and normalizes, so
   * baselining our intent would leave a permanent phantom diff and the watcher
   * would report our own write as a local change on every poll.
   *
   * The residual race (a local writer landing between `applyCloudConfig`'s write
   * and this read) adopts the local value as the baseline, so the cloud never
   * hears about it as a local change — but the very next report still says
   * `adjusted`/"changed locally?" because effective ≠ desired, so it is visible
   * rather than silently lost.
   */
  noteSettingsWritten(touched: readonly string[]): void {
    try {
      // Same rule as the watcher: an unreadable file must not be read as an
      // empty one, or the next tick diffs against a baseline that says the
      // operator deleted everything.
      const read = this.readSettings();
      if (!read.ok && read.reason !== "absent") return;
      const current = namespacesOf(read.ok ? read.settings : {});
      const base = { ...(this.state.namespaces ?? current) };
      for (const key of touched) {
        if (!CONFIG_NAMESPACE_KEYS.includes(key)) continue;
        if (current[key] === undefined) delete base[key];
        else base[key] = current[key];
      }
      this.persist({ namespaces: base, settingsHash: readSettingsHash(this.settingsFile) });
    } catch {
      /* bookkeeping only — an unreadable file must never break config delivery */
    }
  }

  /**
   * Start the settings.json fingerprint watcher (design.md §5) — the mechanism
   * that makes `xorgate set`, the manage TUI and a hand-edit with vim
   * first-class writers without any of them learning about MQTT.
   *
   * Checks once immediately: an edit made while the agent was stopped is
   * exactly as real as one made while it was running, and the persisted
   * baseline is what makes it detectable.
   */
  startWatcher(): void {
    if (this.watcher || this.stopped) return;
    this.checkLocalChange();
    this.watcher = setInterval(
      () => this.checkLocalChange(),
      this.opts.watchMs ?? DEFAULT_WATCH_MS,
    );
    this.watcher.unref?.();
  }

  /**
   * One watcher tick. Cheap path first: an unchanged hash means nobody has
   * written the file at all.
   *
   * The hash advances even when no namespace moved, so the same edit is never
   * re-examined; the namespace BASELINE deliberately does not, so a change
   * detected while offline keeps accumulating into one honest diff until a
   * report actually goes out.
   */
  checkLocalChange(): void {
    if (this.stopped) return;
    try {
      const hash = readSettingsHash(this.settingsFile);
      if (hash === this.state.settingsHash) return;
      // A file we cannot READ is not a file the operator emptied. Reporting the
      // difference would tell the cloud every namespace was deleted, and the
      // mirror would erase the desired document — the whole fleet's settings,
      // lost to a chmod. Skip the tick entirely: no baseline advance, no report.
      // The next successful read diffs correctly against the untouched baseline.
      const read = this.readSettings();
      if (!read.ok && read.reason !== "absent") {
        if (!this.unreadableSettings) {
          this.unreadableSettings = true;
          this.opts.onEvent?.(
            "warn",
            `settings.json is ${read.reason} — local-change sync paused (check owner/permissions on ${this.settingsFile})`,
          );
        }
        return;
      }
      this.unreadableSettings = false;
      const current = namespacesOf(read.ok ? read.settings : {});
      if (this.state.namespaces === undefined) {
        // Never baselined (fresh device, or a sync file written by Phase 3).
        // Adopt the file silently — see ensureConfigSyncBaseline.
        this.persist({ namespaces: current, settingsHash: hash });
        return;
      }
      const changed = diffNamespaces(this.state.namespaces, current);
      const keys = Object.keys(changed);
      if (keys.length === 0) {
        // A rewrite that moved nothing we sync — `mode`, key reordering, or the
        // cloud apply we already baselined.
        this.persist({ settingsHash: hash });
        return;
      }
      this.persist({ settingsHash: hash, localPending: true });
      this.opts.onEvent?.("info", `local settings change detected: ${keys.join(", ")}`);
      this.request("local");
    } catch {
      /* a failed check is a missed poll, never a thrown error */
    }
  }

  /**
   * Queue a report. Coalesces with anything already queued in the window.
   *
   * A pending local change upgrades a `boot` request to `local`: the connect
   * assertion and the hourly heartbeat then double as the retry path for a
   * local report that was published into a link that turned out to be down.
   */
  request(origin: ReportOrigin): void {
    if (this.stopped) return;
    if (origin === "boot" && this.state.localPending) origin = "local";
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
    if (this.modemArrivalTimer) clearTimeout(this.modemArrivalTimer);
    if (this.apnWatchTimer) clearInterval(this.apnWatchTimer);
    if (this.watcher) clearInterval(this.watcher);
    this.timer = null;
    this.heartbeat = null;
    this.settleTimer = null;
    this.modemArrivalTimer = null;
    this.apnWatchTimer = null;
    this.watcher = null;
  }

  /**
   * Watch the modem's APN apply machinery and re-report when it moves (Phase
   * 2). The settle re-reports cover the first ~2 min after a save; an apply's
   * confirm-or-rollback can land later than that (the confirm window is ~5
   * min, a deferred apply is unbounded), and without this the outcome would
   * wait for the HOURLY heartbeat while the UI showed "applying". Standing
   * watch, one telemetry read per tick, and a report is requested only when
   * the block differs from the last one actually reported.
   */
  startApnWatch(): void {
    if (this.apnWatchTimer || this.stopped) return;
    this.apnWatchTimer = setInterval(() => {
      void this.checkApnChange();
    }, this.opts.apnWatchMs ?? DEFAULT_APN_WATCH_MS);
    this.apnWatchTimer.unref?.();
  }

  /** One APN-watch tick. Public for tests; never throws. */
  async checkApnChange(): Promise<void> {
    if (this.stopped) return;
    try {
      const sample = await (this.opts.modem ?? readModemBias)((this.opts.now ?? Date.now)());
      const fp = sample.apn === undefined ? undefined : JSON.stringify(sample.apn);
      if (fp === this.lastReportedApn) return;
      if (this.timer) return; // a report is already queued and will carry it
      this.opts.onEvent?.("info", "modem APN state changed — re-reporting");
      this.request("boot");
    } catch {
      /* a failed probe is a missed tick, never a thrown error */
    }
  }

  /**
   * Build and publish one report. Never rejects: a failure here is a lost
   * report, and a lost report must cost the device nothing.
   */
  async publishReport(origin: ReportOrigin): Promise<void> {
    if (this.stopped) return;
    try {
      const now = (this.opts.now ?? Date.now)();
      const settings = this.loadSettings();
      const modem = await (this.opts.modem ?? readModemBias)(now);

      // The local diff is computed HERE, not when the change was detected, so
      // several edits between two reports collapse into one honest statement of
      // "what moved since the cloud last knew".
      const current = namespacesOf(settings);
      let changed: Record<string, unknown> | undefined;
      if (origin === "local") {
        changed = diffNamespaces(this.state.namespaces ?? current, current);
        if (Object.keys(changed).length === 0) {
          // The edit was reverted (or overwritten by a cloud apply) before this
          // report went out. There is nothing for the cloud to merge, so send a
          // plain state assertion instead of an empty local claim.
          origin = "boot";
          changed = undefined;
          this.persist({ localPending: false });
        }
      }

      const report = buildConfigReport({
        deviceId: this.opts.deviceId,
        ts: now,
        origin,
        lastAppliedRev: this.state.lastAppliedRev,
        settings,
        modem,
        desired: this.desired,
        hints: this.opts.hints?.(),
        mode: this.opts.mode,
        changed,
      });
      this.opts.publish(this.opts.topic, JSON.stringify(report));

      const patch: Partial<ConfigSyncState> = { lastReportTs: now };
      // Only a report that actually left the device retires the local change.
      // Published into a dead link it stays pending, and the next connect (or
      // the hourly heartbeat) re-sends it — see `request`.
      if (origin === "local" && (this.opts.online?.() ?? true)) {
        patch.namespaces = current;
        patch.localPending = false;
      }
      this.persist(patch);
      const apnBlock = report.effective.apn;
      this.lastReportedApn = apnBlock === undefined ? undefined : JSON.stringify(apnBlock);
      this.scheduleSettleReport(report);
      this.watchForModemArrival(report);
    } catch (err) {
      this.opts.onEvent?.("warn", `config report failed: ${(err as Error).message}`);
    }
  }

  /**
   * The BOOT RACE, observed on the bench 2026-08-09 after a power cycle.
   *
   * The agent connects and reports long before the modem daemon has anything to
   * say. Measured on a cold boot: device up at 17:25:03, agent report at
   * 17:25:59, the daemon's first SIM probe at **17:27:13** — 74 s too late. The
   * report therefore carried no `sim`, and the next scheduled report is the
   * HOURLY heartbeat, so the cloud showed "this device has not reported its SIM
   * yet" for an hour after every reboot while the device held the answer all
   * along.
   *
   * `scheduleSettleReport` does not cover this: it watches `status`, and `sim`
   * is reported-only so it never has one. The daemon's start-up cost is also
   * unbounded in practice — `configure_gnss` can issue a CRESET, adding minutes
   * — so a couple of 40 s retries would not be enough either.
   *
   * So: poll the telemetry file on a slow cadence and fire exactly one extra
   * report the moment the modem has something to say. One-shot per process —
   * once seen, this never runs again. Bounded by MODEM_ARRIVAL_TRIES so a device
   * with no modem, or an agent paired with a daemon predating this plan, gives
   * up instead of polling forever.
   */
  private armModemArrivalWatch(): void {
    if (this.stopped || this.modemArrivalTimer || this.modemSeen) return;
    if (this.modemArrivalTries >= MODEM_ARRIVAL_TRIES) return;
    this.modemArrivalTimer = setTimeout(() => {
      this.modemArrivalTimer = null;
      void (async () => {
        if (this.stopped || this.modemSeen) return;
        this.modemArrivalTries += 1;
        try {
          const sample = await (this.opts.modem ?? readModemBias)(
            (this.opts.now ?? Date.now)(),
          );
          if (sample.sim !== undefined || sample.uplink !== undefined) {
            this.modemSeen = true;
            this.opts.onEvent?.(
              "info",
              "modem telemetry arrived after the boot report — re-reporting",
            );
            this.request("boot");
            return;
          }
        } catch {
          /* a failed probe is a missed tick, never a thrown error */
        }
        this.armModemArrivalWatch();
      })();
    }, this.opts.modemArrivalMs ?? DEFAULT_MODEM_ARRIVAL_MS);
    this.modemArrivalTimer.unref?.();
  }

  /** Latch once the modem has spoken; otherwise keep watching for it. */
  private watchForModemArrival(report: ConfigReport): void {
    const eff = report.effective;
    if (eff.sim !== undefined || eff.uplink !== undefined) {
      this.modemSeen = true;
      return;
    }
    this.armModemArrivalWatch();
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
