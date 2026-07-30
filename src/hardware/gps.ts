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
import { createFixAggregator, parseGsv, type GpsFix, type GsvMessage } from "../lib/nmea.js";

/** NMEA GPS port. Override with GPS_NMEA_PORT (handy for local testing). */
export const GPS_NMEA_PORT = process.env.GPS_NMEA_PORT ?? "/dev/ttyUSB1";

export interface GpsStreamHandlers {
  /** Called with a fresh copy of the rolling fix whenever a sentence updates it. */
  onFix?: (fix: GpsFix) => void;
  /**
   * Called for every GSV sentence, whether or not it changed the rolling fix
   * (optimize-system-process-cycle plan, Phase 7): the sky-visibility tracker
   * needs per-satellite C/N0, and it must keep ticking precisely when nothing
   * changes — a garage repeats the same "listed, silent" sky every second.
   */
  onGsv?: (msg: GsvMessage) => void;
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
  // Rolling merged fix; also clears stale position/HDOP when the lock drops
  // and sums GSV satellites-in-view across constellations (see lib/nmea.ts).
  const agg = createFixAggregator();

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
      if (agg.update(line)) updated = true;
      if (handlers.onGsv && line.includes("GSV")) {
        const gsv = parseGsv(line);
        if (gsv) handlers.onGsv(gsv);
      }
    }
    if (updated) handlers.onFix?.({ ...agg.fix });
  });

  stream.on("error", (err) => handlers.onError?.(describeError(err as NodeJS.ErrnoException, port)));
  stream.on("close", () => handlers.onEnd?.());

  return { stop: () => stream.destroy() };
}
