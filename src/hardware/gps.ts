/**
 * GPS — NMEA off the SIM7600's dedicated GNSS port (/dev/ttyUSB1).
 *
 * The connection-manager daemon (modem/sim7600-lte.sh) owns the AT port and
 * enables GNSS with AT+CGPS, after which the modem streams NMEA sentences on a
 * separate read-only tty. This module opens a persistent read stream on that
 * tty and keeps a rolling aggregated fix in memory; the gps collector pulls the
 * latest at ~1 Hz (mirrors the IMU "stream + cache latest" pattern). No serial
 * writes happen here, so there's no contention with the daemon's AT polling.
 */
import { createReadStream, type ReadStream } from "node:fs";
import { parseSentence, type GpsFix } from "../lib/nmea.js";

/** NMEA GPS port. Override with GPS_NMEA_PORT (handy for local testing). */
export const GPS_NMEA_PORT = process.env.GPS_NMEA_PORT ?? "/dev/ttyUSB1";

export interface GpsStreamHandlers {
  /** Called with a fresh copy of the rolling fix whenever a sentence updates it. */
  onFix?: (fix: GpsFix) => void;
  onError?: (message: string) => void;
  /** Stream ended/closed (EOF on a file, or the tty vanished). */
  onEnd?: () => void;
}

export interface GpsStreamHandle {
  stop: () => void;
}

function describeError(err: NodeJS.ErrnoException, port: string): string {
  if (err.code === "ENOENT") return `GPS port ${port} not present (is the modem enumerated and GNSS enabled?)`;
  if (err.code === "EACCES") return `permission denied on ${port} (add the agent user to the 'dialout' group)`;
  return err.message;
}

/**
 * Open the NMEA port and feed each parsed sentence into a rolling fix. Never
 * throws: open failures surface via onError + onEnd so the collector can retry.
 */
export function streamGps(port: string = GPS_NMEA_PORT, handlers: GpsStreamHandlers): GpsStreamHandle {
  let buf = "";
  const fix: GpsFix = {};

  let stream: ReadStream;
  try {
    stream = createReadStream(port, { encoding: "utf8" });
  } catch (err) {
    handlers.onError?.(describeError(err as NodeJS.ErrnoException, port));
    handlers.onEnd?.();
    return { stop: () => {} };
  }

  stream.on("data", (chunk: string | Buffer) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    let updated = false;
    for (const line of parts) {
      const partial = parseSentence(line);
      if (!partial) continue;
      for (const [k, v] of Object.entries(partial)) {
        // Merge only defined, non-NaN values (mirrors nmea.aggregateFix), so a
        // sentence missing a field never clobbers a good prior value.
        if (v !== undefined && !Number.isNaN(v as number)) {
          (fix as Record<string, unknown>)[k] = v;
          updated = true;
        }
      }
    }
    if (updated) handlers.onFix?.({ ...fix });
  });

  stream.on("error", (err) => handlers.onError?.(describeError(err as NodeJS.ErrnoException, port)));
  stream.on("close", () => handlers.onEnd?.());

  return { stop: () => stream.destroy() };
}
