/**
 * Runtime locations + worker spawn resolution for the daemon.
 *
 * Everything the daemon persists lives under XORGATE_HOME (default ~/.xorgate):
 * the pidfile, the append-only log, and the atomic state snapshot. The home is
 * created 0700 and the files 0600 — they carry a deviceId, not secrets, but
 * there's no reason to make them world-readable.
 *
 * Paths are computed lazily (per call) so tests can point XORGATE_HOME at a
 * scratch dir between cases.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url); // <root>/{src|dist}/daemon/runtime.{ts|js}
export const PACKAGE_ROOT = dirname(dirname(dirname(here)));

export function runtimeHome(): string {
  return process.env.XORGATE_HOME || join(homedir(), ".xorgate");
}

export function pidPath(): string {
  return join(runtimeHome(), "agent.pid");
}

export function logPath(): string {
  return join(runtimeHome(), "agent.log");
}

export function statePath(): string {
  return join(runtimeHome(), "state.json");
}

/** Create the runtime dir if needed (idempotent). Returns the dir. */
export function ensureHome(): string {
  const home = runtimeHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * How to launch the detached worker process. After a build we run the compiled
 * `dist/worker.js` with node; in dev (running the CLI via tsx) we run the TS
 * source through tsx so `xorgate start` works without a build step.
 *
 * We pick by what actually exists on disk (not just the loader's extension), so
 * a repo copied to a device and run with `npm ci --omit=dev` (no tsx) still works
 * if it was built, and gives a clear error instead of spawning a missing binary.
 */
export function resolveWorkerSpawn(extraArgs: string[]): { command: string; args: string[] } {
  const distWorker = join(PACKAGE_ROOT, "dist", "worker.js");
  const srcWorker = join(PACKAGE_ROOT, "src", "worker.ts");
  const tsxBin = join(PACKAGE_ROOT, "node_modules", ".bin", "tsx");
  const canTsx = existsSync(tsxBin) && existsSync(srcWorker);
  const isDev = here.endsWith(".ts");

  if (isDev && canTsx) return { command: tsxBin, args: [srcWorker, ...extraArgs] };
  if (existsSync(distWorker)) return { command: process.execPath, args: [distWorker, ...extraArgs] };
  if (canTsx) return { command: tsxBin, args: [srcWorker, ...extraArgs] };

  throw new Error(
    "cannot locate the worker entry: no dist/worker.js (run 'npm run build') and tsx is not installed",
  );
}

/** Absolute path of the worker entry, recorded in the pidfile for identity. */
export function workerPath(): string {
  return here.endsWith(".ts")
    ? join(PACKAGE_ROOT, "src", "worker.ts")
    : join(PACKAGE_ROOT, "dist", "worker.js");
}
