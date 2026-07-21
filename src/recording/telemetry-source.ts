/**
 * Telemetry SegmentSource for the uploader: closed `.jsonl.gz` segments under
 * recordings/telemetry/<sessionId>/, oldest-first.
 *
 * S3 key contract (README): telemetry/v1/<deviceId>/<sessionId>/<startTsMs>-<seq>.jsonl.gz
 * — the on-disk name minus its `seg-` prefix. Sessions are UUIDv7 so plain
 * lexicographic session order IS chronological order; within a session the
 * fixed-width zero-padded seq keeps name order chronological too.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SegmentSource, UploadSegment } from "./uploader.js";

const SEGMENT_NAME = /^seg-(\d+)-(\d+)\.jsonl\.gz$/;

export function createTelemetrySource(deviceId: string, telemetryRoot: string): SegmentSource {
  return {
    kind: "telemetry",
    priority: 0,
    contentType: "application/gzip",
    listClosed(): UploadSegment[] {
      let sessions: string[];
      try {
        sessions = readdirSync(telemetryRoot).sort();
      } catch {
        return []; // no tree yet
      }
      const out: UploadSegment[] = [];
      for (const session of sessions) {
        const dir = join(telemetryRoot, session);
        let names: string[];
        try {
          if (!statSync(dir).isDirectory()) continue;
          names = readdirSync(dir).sort();
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".jsonl.gz")) continue;
          out.push({ path: join(dir, name), name: `${session}/${name}` });
        }
      }
      return out;
    },
    s3KeyFor(seg: UploadSegment): string | null {
      const [session, name] = seg.name.split("/");
      if (!session || !name) return null;
      const m = SEGMENT_NAME.exec(name);
      if (!m) return null;
      return `telemetry/v1/${deviceId}/${session}/${m[1]}-${m[2]}.jsonl.gz`;
    },
  };
}
