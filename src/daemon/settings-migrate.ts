/**
 * One-shot settings.json upgrades (settings-management plan, Phase 4).
 *
 * Kept out of `settings.ts` on purpose: `loadSettings` is a pure, never-throwing
 * reader that half the codebase calls, and a reader that writes is a trap. This
 * module is the opposite — it is called deliberately, once, at agent startup,
 * BEFORE anything else touches the file.
 */
import { readFileSync } from "node:fs";
import { loadSettings, saveSettings, settingsPath, type AgentSettings } from "./settings.js";

export type MediaEnabledMigration =
  /** No legacy key present — nothing to do (the steady state). */
  | { result: "none" }
  /** The key was `true`/absent-but-present; dropped, no behaviour change. */
  | { result: "dropped" }
  /** The key was explicitly `false`; converted to per-camera disables. */
  | { result: "cameras-disabled"; cameras: string[] };

/**
 * Retire the `mediaEnabled` setting (Q4, resolved 2026-08-06).
 *
 * Removing the key flips the default: media used to be OFF unless explicitly
 * enabled, and is now ON unless the cameras are individually disabled. For a
 * device whose operator deliberately set `mediaEnabled: false` that flip would
 * silently start streaming — not acceptable — so this converts the intent
 * instead of dropping it: every KVS stream key in the manifest is written into
 * `recording.video.cameras` as `false`.
 *
 * That is a behaviour-preserving conversion, not an approximation: today's
 * `mediaEnabled: false` already suppresses video capture as well as live
 * streaming (`RecordingManager` builds its camera list only when media is
 * enabled), and a camera marked `false` gets no capture, no shm bridge and no
 * KVS master either.
 *
 * With no manifest there are no channels, so there is nothing to disable and
 * nothing that could start streaming — the key is simply dropped.
 *
 * The write is deliberately visible to the config-sync watcher: it is a real
 * local change to the `recording` namespace, and it MUST reach the cloud, or
 * the next retained document (which replaces the whole namespace) would put the
 * cameras straight back on.
 *
 * Reads the raw file rather than `loadSettings()` because the key is no longer
 * in the allowlist — by the time `loadSettings` has run, the operator's choice
 * is already gone.
 */
export function migrateMediaEnabled(
  streamKeys: readonly string[],
  path: string = settingsPath(),
): MediaEnabledMigration {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { result: "none" }; // missing or corrupt — loadSettings ignores it too
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { result: "none" };
  const legacy = (raw as { mediaEnabled?: unknown }).mediaEnabled;
  if (typeof legacy !== "boolean") return { result: "none" };

  // `loadSettings` has already dropped the key; saving is what makes it stick.
  const settings: AgentSettings = loadSettings(path);

  if (legacy !== false) {
    saveSettings(settings, path);
    return { result: "dropped" };
  }

  const cameras = [...streamKeys];
  if (cameras.length === 0) {
    saveSettings(settings, path);
    return { result: "cameras-disabled", cameras };
  }

  const recording = settings.recording ?? {};
  const video = recording.video ?? {};
  settings.recording = {
    ...recording,
    video: {
      ...video,
      // Existing explicit choices are preserved as keys but forced off: the
      // operator's master switch is the stronger statement of intent.
      cameras: { ...video.cameras, ...Object.fromEntries(cameras.map((k) => [k, false])) },
    },
  };
  saveSettings(settings, path);
  return { result: "cameras-disabled", cameras };
}
