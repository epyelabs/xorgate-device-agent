/**
 * Minimal NMEA 0183 parser — just enough for the GPS collector.
 *
 * The SIM7600 emits standard sentences on its NMEA port (/dev/ttyUSB1) once
 * GNSS is enabled (the connection manager configures + starts the engine).
 * We parse GGA (fix + altitude + satellites), RMC (lat/lon + speed +
 * date/time), GSA (fix type + HDOP — the fix-confidence signal) and GSV
 * (satellites in view per constellation — the antenna/sky-view diagnostic).
 * No native serialport dependency: the GPS hardware module reads raw lines
 * off the tty and feeds them here.
 *
 * Originally ported from argus-test-bench/argus-cli/src/lib/nmea.ts.
 */

export interface GpsFix {
  /** Decimal degrees, north positive. */
  latitude?: number;
  /** Decimal degrees, east positive. */
  longitude?: number;
  /** Metres above mean sea level (GGA). */
  altitude?: number;
  /** GGA fix quality: 0 = none, 1 = GPS, 2 = DGPS. */
  fixQuality?: number;
  /** Satellites used in the fix (GGA). */
  satellites?: number;
  /** Speed over ground in km/h (from RMC knots). */
  speedKmh?: number;
  /**
   * Course over ground in degrees true, 0-360 (RMC track angle). This is the
   * direction of travel, not device heading — the modem only reports it while
   * moving, so a stationary receiver leaves the field empty and the last value
   * persists until the next movement (or clears on lock loss).
   */
  course?: number;
  /** RMC status: true = "A" (valid), false = "V" (void). */
  valid?: boolean;
  /** UTC time HH:MM:SS as reported. */
  utcTime?: string;
  /**
   * Full UTC date+time from RMC (time-of-day + ddmmyy date fields) as epoch
   * milliseconds — the offline clock-step source (optimize-system-process-cycle
   * plan, Phase 4). GGA alone can't provide this (no date field). NMEA years
   * are two-digit; they map to 2000–2099 (GNSS won't report pre-2000 dates,
   * and the consumer's plausibility bounds reject anything outside its own
   * window anyway). Present on every RMC that carries both fields, valid fix
   * or not — gating on fix validity is the consumer's job.
   */
  utcMs?: number;
  /** GSA fix type: 1 = none, 2 = 2D, 3 = 3D. */
  fixType?: number;
  /** Horizontal dilution of precision (GSA); lower = tighter geometry. */
  hdop?: number;
  /** Satellites in view summed across constellations (GSV). */
  satellitesInView?: number;
}

/** Convert NMEA ddmm.mmmm + hemisphere to signed decimal degrees. */
function nmeaCoordToDecimal(value: string, hemisphere: string): number | undefined {
  if (!value) return undefined;
  const dot = value.indexOf(".");
  if (dot < 3) return undefined;
  const degLen = dot - 2; // minutes are always 2 integer digits
  const degrees = parseInt(value.slice(0, degLen), 10);
  const minutes = parseFloat(value.slice(degLen));
  if (Number.isNaN(degrees) || Number.isNaN(minutes)) return undefined;
  let dec = degrees + minutes / 60;
  if (hemisphere === "S" || hemisphere === "W") dec = -dec;
  return dec;
}

function formatUtc(raw: string): string | undefined {
  if (!raw || raw.length < 6) return undefined;
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4, 6)}`;
}

/**
 * RMC hhmmss[.sss] time + ddmmyy date → UTC epoch ms, or undefined when either
 * field is missing/malformed. Two-digit years map to 2000+yy (see GpsFix.utcMs).
 */
function parseRmcUtcMs(time: string, date: string): number | undefined {
  if (!time || time.length < 6 || !date || date.length !== 6) return undefined;
  const hh = Number(time.slice(0, 2));
  const mi = Number(time.slice(2, 4));
  const ss = Number(time.slice(4)); // seconds incl. optional fraction
  const dd = Number(date.slice(0, 2));
  const mo = Number(date.slice(2, 4));
  const yy = Number(date.slice(4, 6));
  if ([hh, mi, ss, dd, mo, yy].some(Number.isNaN)) return undefined;
  // Bounds catch field-slot corruption (e.g. a coordinate landing in the date
  // slot). ss < 61 tolerates a leap second.
  if (hh > 23 || mi > 59 || ss >= 61 || dd < 1 || dd > 31 || mo < 1 || mo > 12) return undefined;
  return Date.UTC(2000 + yy, mo - 1, dd, hh, mi, 0) + Math.round(ss * 1000);
}

/** Verify the `*HH` checksum when present; tolerate sentences without one. */
export function checksumValid(sentence: string): boolean {
  const star = sentence.indexOf("*");
  if (star === -1) return true; // no checksum provided
  const body = sentence.slice(sentence.startsWith("$") ? 1 : 0, star);
  const expected = parseInt(sentence.slice(star + 1, star + 3), 16);
  if (Number.isNaN(expected)) return false;
  let cs = 0;
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
  return cs === expected;
}

/** Parse a single sentence into a partial fix, or null if unsupported/invalid. */
export function parseSentence(line: string): Partial<GpsFix> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("$")) return null;
  if (!checksumValid(trimmed)) return null;

  const star = trimmed.indexOf("*");
  const body = star === -1 ? trimmed : trimmed.slice(0, star);
  const fields = body.split(",");
  const type = fields[0].slice(3); // drop the $GP / $GN / $GL talker id

  if (type === "GGA") {
    return {
      utcTime: formatUtc(fields[1]),
      latitude: nmeaCoordToDecimal(fields[2], fields[3]),
      longitude: nmeaCoordToDecimal(fields[4], fields[5]),
      fixQuality: fields[6] ? parseInt(fields[6], 10) : undefined,
      satellites: fields[7] ? parseInt(fields[7], 10) : undefined,
      altitude: fields[9] ? parseFloat(fields[9]) : undefined,
    };
  }

  if (type === "RMC") {
    const knots = fields[7] ? parseFloat(fields[7]) : NaN;
    // Field 8 = track angle / course over ground (degrees true). Empty when the
    // receiver is stationary (no meaningful direction of travel).
    const course = fields[8] ? parseFloat(fields[8]) : NaN;
    return {
      utcTime: formatUtc(fields[1]),
      utcMs: parseRmcUtcMs(fields[1], fields[9]),
      valid: fields[2] === "A",
      latitude: nmeaCoordToDecimal(fields[3], fields[4]),
      longitude: nmeaCoordToDecimal(fields[5], fields[6]),
      speedKmh: Number.isNaN(knots) ? undefined : knots * 1.852,
      course: Number.isNaN(course) ? undefined : course,
    };
  }

  if (type === "GSA") {
    // $GNGSA,<mode>,<fixType>,<sv x12>,<pdop>,<hdop>,<vdop>[,<systemId>]
    return {
      fixType: fields[2] ? parseInt(fields[2], 10) : undefined,
      hdop: fields[16] ? parseFloat(fields[16]) : undefined,
    };
  }

  return null;
}

/** One satellite block of a GSV sentence. */
export interface GsvSatellite {
  /** Satellite id (PRN / slot), as reported by the constellation's talker. */
  prn: number;
  /** Elevation in degrees, or null when the field is blank. */
  elevation: number | null;
  /** Azimuth in degrees true, or null when the field is blank. */
  azimuth: number | null;
  /**
   * Carrier-to-noise density in dBHz, or null when the field is BLANK — which
   * is the whole point of this parser: a receiver lists satellites it merely
   * expects from almanac/ephemeris with an empty C/N0 field, and only fills it
   * in for satellites it is actually HEARING. "Listed but silent" is a garage
   * or a dead antenna; "listed and heard" is RF (see lib/sky-state.ts).
   */
  snr: number | null;
}

/** One parsed GSV sentence (satellites arrive split across numMsgs of them). */
export interface GsvMessage {
  /** Talker id without the `$` — GP, GL, BD/GB, GA, GQ … (one per constellation). */
  talker: string;
  msgNum: number;
  numMsgs: number;
  /** Satellites in view for THIS talker (repeated on every message of the cycle). */
  inView: number;
  satellites: GsvSatellite[];
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a GSV sentence — the sky-visibility source (optimize-system-process-cycle
 * plan, Phase 7). Kept separate from parseSentence because GSV is per
 * constellation ($GPGSV, $GLGSV, $BDGSV, …) and multi-sentence: only the
 * consumer that reassembles a full cycle across talkers can say anything, so
 * this returns the raw message and owns no state.
 *
 * Field layout: `$xxGSV,numMsgs,msgNum,inView,{prn,elev,azim,snr}×≤4[,…]`.
 * Trailing extras are tolerated by construction — satellite blocks are read as
 * complete quadruples only, so the NMEA 4.10 `signalId` suffix (and the extra
 * pair the SIM7600 appends to $BDGSV) is simply left unread.
 */
export function parseGsv(line: string): GsvMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("$") || !checksumValid(trimmed)) return null;
  const star = trimmed.indexOf("*");
  const body = star === -1 ? trimmed : trimmed.slice(0, star);
  const fields = body.split(",");
  if (fields[0].slice(3) !== "GSV") return null;
  const numMsgs = parseInt(fields[1], 10);
  const msgNum = parseInt(fields[2], 10);
  const inView = parseInt(fields[3], 10);
  if (Number.isNaN(numMsgs) || Number.isNaN(msgNum) || Number.isNaN(inView)) return null;
  const satellites: GsvSatellite[] = [];
  for (let i = 4; i + 3 < fields.length; i += 4) {
    const prn = parseInt(fields[i], 10);
    // A non-numeric id means we're reading trailing fields, not a satellite.
    if (Number.isNaN(prn) || prn <= 0) continue;
    satellites.push({
      prn,
      elevation: numOrNull(fields[i + 1]),
      azimuth: numOrNull(fields[i + 2]),
      snr: numOrNull(fields[i + 3]),
    });
  }
  return { talker: fields[0].slice(1, 3), msgNum, numMsgs, inView, satellites };
}

/**
 * Parse a GSV header into its talker + total satellites in view, or null for
 * anything else. In-view counts come per constellation and only make sense
 * summed — the aggregator owns that state.
 */
export function parseGsvInView(line: string): { talker: string; inView: number } | null {
  const msg = parseGsv(line);
  return msg === null ? null : { talker: msg.talker, inView: msg.inView };
}

export interface FixAggregator {
  /** Feed one raw NMEA line; true if the rolling fix changed. */
  update(line: string): boolean;
  /** The current rolling fix (live reference — copy before sharing). */
  fix: GpsFix;
}

// Fields that must not outlive the lock that produced them.
const POSITION_KEYS = ["latitude", "longitude", "altitude", "speedKmh", "course", "hdop"] as const;

/**
 * Rolling multi-sentence fix. Merges only defined, non-NaN values so a
 * sentence missing a field never clobbers a good prior one — with one
 * deliberate exception: a GGA reporting no lock (quality 0) or a void RMC
 * clears the position fields, so consumers never see a stale last-known
 * position presented as current. GSV in-view counts are tracked per talker
 * and exposed summed.
 */
export function createFixAggregator(): FixAggregator {
  const fix: GpsFix = {};
  const inView = new Map<string, number>();

  return {
    fix,
    update(line: string): boolean {
      const gsv = parseGsvInView(line);
      if (gsv) {
        if (inView.get(gsv.talker) === gsv.inView) return false;
        inView.set(gsv.talker, gsv.inView);
        let total = 0;
        for (const n of inView.values()) total += n;
        fix.satellitesInView = total;
        return true;
      }

      const partial = parseSentence(line);
      if (!partial) return false;

      // GSA comes once per constellation; one without a fix (fixType 1, empty
      // DOPs — e.g. $BDGSA,A,1 while GPS holds a solid lock) says nothing
      // about the overall solution, so don't let it clobber fixType/hdop.
      // True lock loss is signalled by GGA quality 0 / void RMC below.
      if (partial.fixType === 1) return false;

      let updated = false;
      if (partial.fixQuality === 0 || partial.valid === false) {
        for (const k of POSITION_KEYS) {
          if (fix[k] !== undefined) {
            delete fix[k];
            updated = true;
          }
        }
      }
      for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined && !Number.isNaN(v as number)) {
          if ((fix as Record<string, unknown>)[k] !== v) updated = true;
          (fix as Record<string, unknown>)[k] = v;
        }
      }
      return updated;
    },
  };
}

/** Merge a burst of sentences into a single best-effort fix. */
export function aggregateFix(lines: string[]): GpsFix {
  const agg = createFixAggregator();
  for (const line of lines) agg.update(line);
  return agg.fix;
}

export function hasPosition(fix: GpsFix): boolean {
  return typeof fix.latitude === "number" && typeof fix.longitude === "number";
}
