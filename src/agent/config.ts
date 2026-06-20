import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunMode } from "./telemetry.js";

/**
 * Agent configuration from env vars, overridable by `--flag value` CLI args.
 * The cert/key/CA defaults match the one-shot bundle from
 * `POST /devices/{id}/provision` (see README): drop the cert, key, and Amazon
 * Root CA1 into ./creds.
 *
 * `--offline` (or OFFLINE=1) runs the whole agent without AWS: no creds are
 * loaded and mqtt.ts swaps in a stub client. This lets the daemon + monitor be
 * exercised end-to-end on a bare checkout (the project is simulator-first).
 */

export interface CredBundle {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

export interface AgentConfig {
  deviceId: string;
  endpoint: string;
  mode: RunMode;
  rateHz: number;
  intervalMs: number;
  offline: boolean;
  telemetryTopic: string;
  statusTopic: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  /** Loaded cert material, or null in offline mode. */
  creds: CredBundle | null;
}

/** Flags that take no value. Everything else consumes the following token. */
export const BOOLEAN_FLAGS = new Set(["offline"]);

/**
 * Parse `--flag value` and boolean `--flag` out of an argv slice. Boolean flags
 * (BOOLEAN_FLAGS) never consume a value; every other flag consumes the next
 * token as its value — even if that token starts with `--`, so a typo like
 * `--rate --mode sim` surfaces as an invalid value downstream rather than
 * silently falling back to the default.
 */
export function parseArgs(
  argv: string[],
  booleanFlags: Set<string> = BOOLEAN_FLAGS,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function truthy(v: string | boolean | undefined): boolean {
  return v === true || v === "1" || v === "true";
}

/**
 * Build the agent config from a CLI argv slice (subcommand already stripped)
 * plus env vars. Throws with an actionable message if a required field or cred
 * file is missing — callers (e.g. `start`) use this to fail fast before
 * spawning a worker that would only crash-loop.
 */
export function loadConfig(argv: string[] = process.argv.slice(2)): AgentConfig {
  const args = parseArgs(argv);
  const get = (cliKey: string, envKey: string, fallback?: string): string | undefined =>
    (typeof args[cliKey] === "string" ? (args[cliKey] as string) : undefined) ??
    process.env[envKey] ??
    fallback;

  const offline = truthy(args.offline) || truthy(process.env.OFFLINE);

  const mode = (get("mode", "MODE", "sim") as RunMode) ?? "sim";
  const rateHz = Number(get("rate", "RATE_HZ", "1"));

  // Offline mode needs no real device identity / endpoint; give it placeholders
  // so the simulator + topics still resolve coherently.
  const deviceId = get("device-id", "DEVICE_ID", offline ? "sim-local" : undefined);
  const endpoint = get("endpoint", "IOT_DATA_ENDPOINT", offline ? "offline" : undefined);

  const certPath = resolve(get("cert", "CERT_PATH", "./creds/cert.crt")!);
  const keyPath = resolve(get("key", "KEY_PATH", "./creds/private.key")!);
  const caPath = resolve(get("ca", "CA_PATH", "./creds/ca.pem")!);

  if (!deviceId) throw new Error("DEVICE_ID (or --device-id) is required (or pass --offline)");
  if (!endpoint) throw new Error("IOT_DATA_ENDPOINT (or --endpoint) is required (or pass --offline)");
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error(`RATE_HZ must be a positive number, got ${rateHz}`);
  }
  if (mode !== "sim" && mode !== "real") {
    throw new Error(`MODE must be "sim" or "real", got "${mode}"`);
  }

  let creds: CredBundle | null = null;
  if (!offline) {
    try {
      creds = {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
        ca: readFileSync(caPath),
      };
    } catch (err) {
      throw new Error(
        `failed to read creds (${(err as Error).message}). ` +
          `Provision the device into ./creds, or run with --offline.`,
      );
    }
  }

  return {
    deviceId,
    endpoint,
    mode,
    rateHz,
    intervalMs: Math.round(1000 / rateHz),
    offline,
    telemetryTopic: `xorgate/devices/${deviceId}/telemetry`,
    statusTopic: `xorgate/devices/${deviceId}/status`,
    certPath,
    keyPath,
    caPath,
    creds,
  };
}
