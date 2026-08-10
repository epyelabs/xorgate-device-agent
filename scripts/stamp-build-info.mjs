#!/usr/bin/env node
/**
 * Stamp `dist/build-info.json` for a hand-deployed (rsync'd) bench build —
 * the deploy path that bypasses CI, which is the only other producer of this
 * manifest (device_update_management, Phase 1).
 *
 * Run AFTER `npm run build`, before rsyncing dist/ to /opt/xorgate:
 *   npm run build && node scripts/stamp-build-info.mjs && rsync -a dist/ …
 *
 * Marks the build `channel: "bench"` and suffixes `-dirty` on an unclean tree,
 * so a bench build can never be mistaken for the CI artifact of the same sha.
 * Skipping this is fine — the agent's fallback then reports `(local)`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const sha = git(["rev-parse", "--short", "HEAD"]) || "unknown";
const dirty = git(["status", "--porcelain"]).length > 0 ? "-dirty" : "";
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const info = {
  version: `${sha}${dirty}`,
  channel: "bench",
  builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  packageVersion,
};

const out = join(root, "dist", "build-info.json");
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${out}: ${info.packageVersion} (${info.version}, ${info.channel})`);
