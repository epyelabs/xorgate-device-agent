/**
 * Video SegmentSource for the uploader (plan D2/D3, Phase 4): closed fragment
 * pairs under recordings/video/<streamKey>/<sessionId>/, oldest-first across
 * streams (mp4 mtime ≈ fragment close time — sessions record concurrently on
 * dual-camera devices, so cross-stream order can't come from names alone).
 *
 * A fragment is closed ⇔ its `.json` sidecar exists (video-segments.ts writes
 * it on rotation/finalize); the pair is the upload unit. The uploader PUTs the
 * sidecar first, then the mp4, and deletes BOTH locally only after the mp4 PUT
 * succeeds — so the cloud ingest event for an mp4 always finds its sidecar,
 * and a crash mid-pair re-uploads idempotently.
 *
 * Housekeeping owned by this scan (documented in the phase plan):
 *  - `session.json` deletion: the manifest is deleted (with its dir) once the
 *    session is fully drained — i.e. the dir holds no mp4s, the session is not
 *    owned by a live capture, and the manifest is old enough that a just-minted
 *    session can't be hit. Fully-EVICTED sessions (Phase 3 leaves a lone
 *    session.json behind) are reaped by the same rule.
 *  - Orphan sidecars (mp4 already uploaded+deleted, crash before the sidecar
 *    unlink) are removed — a sidecar is only ever written next to an existing
 *    mp4, so a pairless one is always a leftover.
 */
import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SegmentSource, UploadSegment } from "./uploader.js";
import { SESSION_MANIFEST_NAME } from "./video-segments.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FRAGMENT_RE = /^\d{5,}\.mp4$/;
const STREAM_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** Don't reap an empty session dir younger than this — its capture daemon may
 *  still be starting (first fragment lands ~segmentSeconds after spawn) or
 *  flushing a short first fragment at EOS during a config handover. */
const REAP_MIN_AGE_MS = 10 * 60_000;

export interface VideoSourceOptions {
  /** True while a live capture daemon owns this session (never reap it). */
  isSessionActive(sessionId: string): boolean;
  /** Clock override for tests. */
  now?: () => number;
}

export function createVideoSource(
  deviceId: string,
  videoRoot: string,
  opts: VideoSourceOptions,
): SegmentSource {
  const now = opts.now ?? Date.now;

  function keyFor(streamKey: string, sessionId: string, fragment: string): string | null {
    if (!STREAM_KEY_RE.test(streamKey)) return null;
    if (!UUID_RE.test(sessionId)) return null;
    if (!FRAGMENT_RE.test(fragment)) return null;
    return `media-sessions/v1/${deviceId}/${streamKey}/${sessionId}/${fragment}`;
  }

  /** Reap a fully-drained session dir (manifest + dir), best-effort. */
  function reapSession(dir: string, names: string[]): void {
    for (const n of names) {
      if (n === SESSION_MANIFEST_NAME || n.endsWith(".json")) {
        try {
          unlinkSync(join(dir, n));
        } catch {
          /* raced — fine */
        }
      }
    }
    try {
      rmdirSync(dir);
    } catch {
      /* non-json stragglers — leave for the disk manager */
    }
  }

  return {
    kind: "video",
    priority: 1, // telemetry (0) always drains first — README upload order
    contentType: "video/mp4",
    listClosed(): UploadSegment[] {
      let streamKeys: string[];
      try {
        streamKeys = readdirSync(videoRoot);
      } catch {
        return []; // no video tree yet
      }
      const out: (UploadSegment & { mtimeMs: number })[] = [];
      for (const streamKey of streamKeys.sort()) {
        const streamDir = join(videoRoot, streamKey);
        let sessions: string[];
        try {
          if (!statSync(streamDir).isDirectory()) continue;
          sessions = readdirSync(streamDir).sort();
        } catch {
          continue;
        }
        for (const sessionId of sessions) {
          const dir = join(streamDir, sessionId);
          let names: string[];
          try {
            if (!statSync(dir).isDirectory()) continue;
            names = readdirSync(dir);
          } catch {
            continue;
          }
          const mp4s = new Set(names.filter((n) => n.endsWith(".mp4")));

          // Orphan sidecars: the mp4 was uploaded+deleted but the sidecar
          // unlink didn't happen (crash/eviction race). Both copies are in S3
          // (or gone with the eviction) — drop the leftover.
          for (const n of names) {
            if (!n.endsWith(".json") || n === SESSION_MANIFEST_NAME) continue;
            if (!mp4s.has(n.replace(/\.json$/, ".mp4"))) {
              try {
                unlinkSync(join(dir, n));
              } catch {
                /* raced — fine */
              }
            }
          }

          if (mp4s.size === 0) {
            if (!opts.isSessionActive(sessionId)) {
              let manifestAge = Infinity;
              try {
                manifestAge = now() - statSync(join(dir, SESSION_MANIFEST_NAME)).mtimeMs;
              } catch {
                /* no manifest — an empty husk; age stays Infinity (reap) */
              }
              if (manifestAge >= REAP_MIN_AGE_MS) reapSession(dir, names);
            }
            continue;
          }

          for (const mp4 of mp4s) {
            if (!FRAGMENT_RE.test(mp4)) continue;
            const sidecarName = mp4.replace(/\.mp4$/, ".json");
            if (!names.includes(sidecarName)) continue; // active or not yet swept
            const mp4Path = join(dir, mp4);
            let mtimeMs: number;
            try {
              mtimeMs = statSync(mp4Path).mtimeMs;
            } catch {
              continue; // raced an eviction
            }
            const s3Key = keyFor(streamKey, sessionId, mp4);
            out.push({
              path: mp4Path,
              name: `${streamKey}/${sessionId}/${mp4}`,
              mtimeMs,
              ...(s3Key
                ? {
                    sidecar: {
                      path: join(dir, sidecarName),
                      s3Key: s3Key.replace(/\.mp4$/, ".json"),
                      contentType: "application/json",
                    },
                  }
                : {}), // unparseable name → s3KeyFor also nulls; uploader skips
            });
          }
        }
      }
      out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
      return out.map(({ mtimeMs: _m, ...seg }) => seg);
    },
    s3KeyFor(seg: UploadSegment): string | null {
      const parts = seg.name.split("/");
      if (parts.length !== 3) return null;
      return keyFor(parts[0], parts[1], parts[2]);
    },
  };
}
