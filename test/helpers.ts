import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Create a scratch XORGATE_HOME and point the env at it. */
export function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "xg-test-"));
  process.env.XORGATE_HOME = dir;
  return dir;
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** A pid that is guaranteed dead: spawn a no-op node process and wait for exit. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise<void>((res) => child.on("exit", () => res()));
  await new Promise((r) => setTimeout(r, 50)); // let the OS reap it
  return pid;
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
