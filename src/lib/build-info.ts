/**
 * Which build is this? (device_update_management, Phase 1)
 *
 * CI bakes `dist/build-info.json` into the tarball post-`npm run build`, so a
 * published build carries its own identity — the short sha (dev) or release tag
 * (prod) that until now lived ONLY in the S3 key and was discarded on extract.
 * The agent reports it (`effective.agent.build`), the CLI prints it, and the web
 * UI compares it against `latest.json` in the dist bucket.
 *
 * Deliberately honest about hand-deployed trees: when the manifest is missing or
 * unreadable we fall back to `channel: "local"` with the package version rather
 * than to a stale sha, so a bench rsync never masquerades as a CI build.
 *
 * Synchronous, cached, never throws — every consumer sits on a hot path
 * (startup, report builder, CLI banner) and none of them can afford to care.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  /** Short sha (dev CI), release tag (prod CI), or the package version locally. */
  version: string;
  /** "dev" | "prod" from CI; "bench" from scripts/stamp-build-info.mjs; else "local". */
  channel: string;
  /** ISO build timestamp; null when there is no manifest to read it from. */
  builtAt: string | null;
  /** package.json version — the human-facing release line, independent of the sha. */
  packageVersion: string;
}

// <root>/{src|dist}/lib/build-info.js -> <root>/{src|dist}
const moduleDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_ROOT = dirname(moduleDir);

let cached: BuildInfo | null = null;

/** The running build's identity. Cached after the first call. */
export function loadBuildInfo(): BuildInfo {
  if (cached) return cached;
  cached = readManifest();
  return cached;
}

/** Test seam — drops the cache so a fixture manifest can be re-read. */
export function resetBuildInfoCache(): void {
  cached = null;
}

/** `0.2.0 (a1b2c3d, dev)` — the one-line form for CLI banners and status output. */
export function formatBuildInfo(info: BuildInfo = loadBuildInfo()): string {
  return `${info.packageVersion} (${info.version}, ${info.channel})`;
}

function readManifest(): BuildInfo {
  const packageVersion = readPackageVersion();
  // Sits beside the compiled output (dist/build-info.json), NOT at the package
  // root: `npm run build` owns dist/, so a stale manifest cannot outlive the
  // build it describes. Under tsx (src/) it is simply absent -> "local".
  const raw = readJson(join(moduleDir, "build-info.json"));
  if (!raw) return { version: packageVersion, channel: "local", builtAt: null, packageVersion };
  const version = str(raw.version);
  if (!version) return { version: packageVersion, channel: "local", builtAt: null, packageVersion };
  return {
    version,
    channel: str(raw.channel) ?? "unknown",
    builtAt: str(raw.builtAt) ?? null,
    packageVersion: str(raw.packageVersion) ?? packageVersion,
  };
}

function readPackageVersion(): string {
  const pkg = readJson(join(PACKAGE_ROOT, "package.json"));
  return str(pkg?.version) ?? "0.0.0";
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
