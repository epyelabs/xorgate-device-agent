/**
 * Who we are running as, and who owns the files we write.
 *
 * The agent runs unprivileged on purpose — as the provisioning user (`pi` on
 * the bench, set by the systemd drop-in `xorgate-agent.service.d/10-user.conf`)
 * — while the CLI and the installer are routinely run under `sudo`. Two callers
 * care about the mismatch:
 *
 * - `atomicWriteJson`, which must hand a file's ownership back after a root-run
 *   write. Without that, `sudo xorgate set …` leaves settings.json `root:root`
 *   and the agent is locked out of its own settings until a human chowns it.
 * - `xorgate set`, which says once that sudo isn't needed here.
 *
 * Everything in here is best-effort and never throws: the uid accessors don't
 * exist on non-POSIX platforms, and on a fresh install the state dir may not
 * exist yet. Callers get `undefined` and carry on.
 */
import { readFileSync, statSync } from "node:fs";

/** Our effective uid, or undefined on a platform without the notion. */
export function effectiveUid(): number | undefined {
  const get = process.geteuid ?? process.getuid;
  return typeof get === "function" ? get.call(process) : undefined;
}

/** True only when we can ask and the answer is 0. */
export function isRoot(): boolean {
  return effectiveUid() === 0;
}

export interface FileOwner {
  uid: number;
  gid: number;
  /** Permission bits only (mode & 0o7777), ready to hand to chmod. */
  mode: number;
}

/** uid/gid/permission bits of `path`, or undefined if it can't be stat'd. */
export function fileOwner(path: string): FileOwner | undefined {
  try {
    const st = statSync(path);
    return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
  } catch {
    return undefined;
  }
}

/**
 * uid → login name, read straight out of /etc/passwd. Node has no getpwuid, and
 * a subprocess (`id`/`getent`) is not worth spawning for one advisory line — an
 * unresolvable uid is simply reported as a number by the caller.
 */
export function usernameForUid(uid: number): string | undefined {
  let passwd: string;
  try {
    passwd = readFileSync("/etc/passwd", "utf8");
  } catch {
    return undefined;
  }
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    // name:x:uid:gid:… — guard the empty field so a malformed line can't
    // Number("") === 0 its way into matching root.
    if (f.length >= 3 && f[0] && f[2] !== "" && Number(f[2]) === uid) return f[0];
  }
  return undefined;
}
