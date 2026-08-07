import {
  closeSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileOwner, isRoot, type FileOwner } from "./privilege.js";

/**
 * Atomically and durably write JSON to `path`: write a temp file in the SAME
 * directory, fsync it, rename over the target, then fsync the directory. rename(2)
 * is atomic within one filesystem on macOS (APFS/HFS+) and Linux (ext4/overlay),
 * so a concurrent reader never sees a half-written file. The temp MUST live in
 * the target's own directory — a cross-filesystem rename silently degrades to a
 * non-atomic copy (or throws EXDEV).
 *
 * The trailing directory fsync persists the rename's metadata so a power-cut
 * (the normal Raspberry Pi failure mode) can't lose it on ext4; it's a no-op /
 * harmless error on macOS, hence best-effort.
 *
 * The pid + a monotonic-ish counter in the temp name keep two writers from
 * colliding. (Date.now() is avoided so this stays usable in any context.)
 *
 * OWNERSHIP. The rename is also how this helper used to lock the agent out of
 * its own settings: a temp file created by a root process belongs to root, and
 * a rename needs only directory write permission, so `sudo xorgate set …` left
 * `settings.json` as `root:root 0600` while the agent runs as the provisioning
 * user. Reads then failed with EACCES and cloud↔device sync stalled in both
 * directions (settings-sync-hardening plan, phase 1). So: when we are root and
 * the target already exists, the temp file is handed back to that target's
 * owner and mode before the rename. Non-root callers make no extra syscall —
 * this helper is on the hot path for state.json and every segment sidecar.
 */
let tmpCounter = 0;

export function atomicWriteJson(path: string, obj: unknown): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${pathBase(path)}.tmp.${process.pid}.${tmpCounter++}`);
  // Root only, and only when there is an existing owner to preserve: a first
  // write is the installer's job and the installer sets ownership itself.
  const prior = isRoot() ? fileOwner(path) : undefined;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(obj));
    if (prior) preserveOwnership(fd, prior);
    fsyncSync(fd); // after the chown/chmod, so the metadata is durable too
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Leave no temp turds behind if the rename fails.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  fsyncDir(dir);
}

/**
 * Give the temp file the owner and mode of the target it is about to replace.
 * Called only when we are root AND the target exists.
 *
 * Deliberately best-effort: a durable write that is cosmetically root-owned is
 * a far better outcome than a write that throws, so a chown/chmod failure is
 * swallowed and the rename proceeds. chown first, then chmod — chown(2) clears
 * the set-user-ID/set-group-ID bits, which would undo a mode set before it.
 */
function preserveOwnership(fd: number, prior: FileOwner): void {
  try {
    fchownSync(fd, prior.uid, prior.gid);
  } catch {
    /* never fail a settings write over ownership */
  }
  try {
    fchmodSync(fd, prior.mode);
  } catch {
    /* ditto */
  }
}

/** Best-effort fsync of a directory so a rename survives a power loss on Linux. */
export function fsyncDir(dir: string): void {
  let dfd: number;
  try {
    dfd = openSync(dir, "r");
  } catch {
    return; // can't open dir for fsync (e.g. some platforms) — skip
  }
  try {
    fsyncSync(dfd);
  } catch {
    /* EINVAL/EISDIR/EPERM on macOS and some FSes — durability is best-effort */
  } finally {
    closeSync(dfd);
  }
}

function pathBase(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
