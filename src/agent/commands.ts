/**
 * Cloud -> device command channel. The backend publishes a NON-retained JSON
 * message to `xorgate/devices/{deviceId}/command` when an operator triggers a
 * one-shot action from the web UI; the worker validates it, acks on
 * `xorgate/devices/{deviceId}/command/response`, then executes.
 *
 * Payload shape:
 *   { "v": 1, "requestId": <uuid>, "command": "reboot"|"power_off",
 *     "ts": <epoch ms issued>, "expiresAt": <epoch ms> }
 *
 * This is deliberately NOT the config plane (see plans/two-way-sync-config).
 * Config is desired state and is retained so an offline device converges on
 * reconnect. A command is a one-shot imperative: retaining it would replay the
 * reboot on every single reconnect, i.e. a boot loop. Non-retained + clean
 * session means a command published while the device is offline is simply
 * dropped, which is the correct semantics — you only reboot a device that is
 * online right now.
 *
 * Two independent guards stop a stale command from causing a surprise reboot:
 *
 *   1. TTL (`expiresAt`, clamped to MAX_TTL_MS past `ts` so the cloud cannot
 *      grant an unbounded window). Catches a command delayed in flight by a
 *      degraded link. Depends on the device clock being sane — it is NTP-synced.
 *   2. A replay ledger of executed requestIds, persisted to disk. Catches QoS-1
 *      redelivery and does NOT depend on any clock.
 *
 * The ledger has to be on disk rather than in memory precisely because the
 * command it guards against reboots the process that would hold the memory.
 * It is written BEFORE the reboot fires, so a redelivered command that arrives
 * after the device comes back up is still recognised as already-executed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { runtimeHome } from "../daemon/runtime.js";
import { run, type RunResult } from "../lib/exec.js";

/**
 * `refresh` (manage_sim_card_info plan, Phase 2 §4d) is the one READ-ONLY
 * command: re-probe what the device can (SIM identity, applied APN, antenna
 * bias) and publish a fresh config report now. It reuses this module's TTL +
 * ledger guards unchanged — they cost nothing and a QoS-1 redelivery storm
 * re-probing the modem repeatedly is still worth suppressing — but it is
 * executed in-process by the worker (touch a flag file + re-report), never via
 * `executeCommand`'s sudo path.
 */
export type DeviceCommandName = "reboot" | "power_off" | "refresh";

const COMMANDS: ReadonlySet<string> = new Set<DeviceCommandName>([
  "reboot",
  "power_off",
  "refresh",
]);

/**
 * Hard ceiling on how long a command stays valid, measured from the issuing
 * timestamp. The cloud sends its own (shorter) expiresAt; this caps it so a
 * buggy or hostile publisher cannot mint a command that stays armed for hours.
 */
export const MAX_TTL_MS = 120_000;

/** Executed requestIds are remembered this long — well past MAX_TTL_MS. */
const LEDGER_RETENTION_MS = 3_600_000;

/** Backstop so a flood of commands cannot grow the ledger without bound. */
const LEDGER_MAX_ENTRIES = 100;

export interface DeviceCommand {
  requestId: string;
  command: DeviceCommandName;
  /** Epoch ms the cloud issued the command. */
  ts: number;
  /** Epoch ms after which the device must refuse it. Already TTL-clamped. */
  expiresAt: number;
}

export type RejectReason = "expired" | "duplicate";

/**
 * Parse + validate a command payload. Returns null when it is not a well-formed
 * v1 command for a known action — the worker cannot meaningfully ack those
 * (there may be no requestId to ack against), so they are dropped with a log.
 *
 * `expiresAt` is clamped to `ts + MAX_TTL_MS` here, so every downstream expiry
 * check is against a bound this device controls.
 */
export function parseCommand(payload: Buffer | string): DeviceCommand | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.requestId !== "string" || o.requestId.length === 0) return null;
  if (typeof o.command !== "string" || !COMMANDS.has(o.command)) return null;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return null;
  return {
    requestId: o.requestId,
    command: o.command as DeviceCommandName,
    ts: o.ts,
    expiresAt: Math.min(o.expiresAt, o.ts + MAX_TTL_MS),
  };
}

export function isExpired(cmd: DeviceCommand, now: number = Date.now()): boolean {
  return now > cmd.expiresAt;
}

interface LedgerEntry {
  requestId: string;
  at: number;
}

interface Ledger {
  v: 1;
  executed: LedgerEntry[];
}

export function ledgerPath(): string {
  return join(runtimeHome(), "commands.json");
}

/** Read the replay ledger, or an empty one when absent/unreadable/invalid. */
function loadLedger(path: string): Ledger {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (obj && typeof obj === "object" && (obj as Ledger).v === 1) {
      const executed = (obj as { executed?: unknown }).executed;
      if (Array.isArray(executed)) {
        return {
          v: 1,
          executed: executed.filter(
            (e): e is LedgerEntry =>
              !!e &&
              typeof e === "object" &&
              typeof (e as LedgerEntry).requestId === "string" &&
              typeof (e as LedgerEntry).at === "number",
          ),
        };
      }
    }
  } catch {
    /* missing / corrupt — treat as nothing executed yet */
  }
  return { v: 1, executed: [] };
}

/**
 * Atomically record `requestId` as executed. Returns false when it was already
 * there, meaning this is a redelivery and the caller must NOT execute.
 *
 * Call this BEFORE executing, never after: `systemctl reboot` does not return,
 * so an "execute then record" ordering would leave no record at all and let the
 * same command fire again on the next connect.
 */
export function claimCommand(
  requestId: string,
  now: number = Date.now(),
  path: string = ledgerPath(),
): boolean {
  const ledger = loadLedger(path);
  if (ledger.executed.some((e) => e.requestId === requestId)) return false;
  const kept = ledger.executed.filter((e) => now - e.at < LEDGER_RETENTION_MS);
  kept.push({ requestId, at: now });
  atomicWriteJson(path, {
    v: 1,
    executed: kept.slice(-LEDGER_MAX_ENTRIES),
  } satisfies Ledger);
  return true;
}

/**
 * The privileged action itself. `sudo -n` (non-interactive) so a device whose
 * sudoers drop-in is missing fails fast and loudly instead of hanging on a
 * password prompt no one can answer — the agent runs as the provisioning user
 * (`pi`), not root.
 *
 * `reboot`/`poweroff` live in /usr/sbin, which is not on the service user's
 * PATH; `systemctl` is on PATH and is the same call underneath.
 */
export function executeCommand(
  command: DeviceCommandName,
  runner: (cmd: string, args: string[]) => Promise<RunResult> = run,
): Promise<RunResult> {
  if (command === "refresh") {
    // Never reaches sudo: the worker handles refresh in-process. Guarded here
    // so a future caller cannot accidentally route it into systemctl.
    return Promise.resolve<RunResult>({
      failed: true,
      notFound: false,
      exitCode: 1,
      stdout: "",
      stderr: "refresh is handled in-process, not via executeCommand",
    });
  }
  const verb = command === "reboot" ? "reboot" : "poweroff";
  return runner("sudo", ["-n", "systemctl", verb]);
}
