import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

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
 */
let tmpCounter = 0;

export function atomicWriteJson(path: string, obj: unknown): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${pathBase(path)}.tmp.${process.pid}.${tmpCounter++}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(obj));
    fsyncSync(fd);
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
