import { describe, expect, it } from "vitest";
import {
  aggregateFix,
  checksumValid,
  createFixAggregator,
  hasPosition,
  parseGsvInView,
  parseSentence,
} from "../src/lib/nmea.js";

// Sample NMEA burst with a valid fix (ported from the argus-cli bench fixtures).
const NMEA_LINES = [
  "$GPGGA,083745.000,1430.1234,N,12101.5678,E,1,08,0.9,545.4,M,46.9,M,,*56",
  "$GPRMC,083745.000,A,1430.1234,N,12101.5678,E,0.06,31.66,130626,,,A*5A",
  "$GPGSV,3,1,11,03,03,111,00,04,15,270,00*7F",
];

const GSA_3D = "$GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1*39";
const GSA_NO_FIX = "$GNGSA,A,1,,,,,,,,,,,,,,*2C";
const GLONASS_GSV = "$GLGSV,2,1,08,65,50,100,40,66,30,200,35*6A";
const GGA_NO_LOCK = "$GPGGA,083745.000,,,,,0,00,,,M,,M,,*75";
const RMC_VOID = "$GPRMC,083746.000,V,,,,,,,130626,,,N*43";

describe("nmea checksum", () => {
  it("validates correct checksums", () => {
    for (const line of NMEA_LINES) expect(checksumValid(line)).toBe(true);
  });
  it("rejects a corrupted sentence", () => {
    expect(checksumValid("$GPGGA,083745.000,1430.1234,N*00")).toBe(false);
  });
  it("tolerates a sentence with no checksum", () => {
    expect(checksumValid("$GPGGA,083745.000")).toBe(true);
  });
});

describe("parseSentence", () => {
  it("parses GGA position, altitude and satellites", () => {
    const fix = parseSentence(NMEA_LINES[0])!;
    expect(fix.latitude).toBeCloseTo(14.50206, 4);
    expect(fix.longitude).toBeCloseTo(121.02613, 4);
    expect(fix.altitude).toBe(545.4);
    expect(fix.satellites).toBe(8);
    expect(fix.fixQuality).toBe(1);
  });

  it("parses RMC validity, speed and course", () => {
    const fix = parseSentence(NMEA_LINES[1])!;
    expect(fix.valid).toBe(true);
    expect(fix.speedKmh).toBeCloseTo(0.06 * 1.852, 4);
    expect(fix.course).toBeCloseTo(31.66, 2);
  });

  it("leaves course undefined for a stationary RMC (empty track field)", () => {
    // Field 8 empty — the receiver reports no direction of travel when stopped.
    // Captured verbatim off the SIM7600 so the checksum validates.
    const fix = parseSentence("$GPRMC,153342.00,A,4339.799299,N,07931.163812,W,0.0,,170726,7.7,W,A*17")!;
    expect(fix.speedKmh).toBeCloseTo(0, 4);
    expect(fix.course).toBeUndefined();
  });

  it("parses GSA fix type and hdop", () => {
    const fix = parseSentence(GSA_3D)!;
    expect(fix.fixType).toBe(3);
    expect(fix.hdop).toBeCloseTo(1.3, 4);
  });

  it("returns null for non-NMEA input", () => {
    expect(parseSentence("hello")).toBeNull();
  });
});

describe("parseGsvInView", () => {
  it("extracts talker + satellites in view from a GSV header", () => {
    expect(parseGsvInView(NMEA_LINES[2])).toEqual({ talker: "GP", inView: 11 });
    expect(parseGsvInView(GLONASS_GSV)).toEqual({ talker: "GL", inView: 8 });
  });

  it("returns null for non-GSV sentences", () => {
    expect(parseGsvInView(NMEA_LINES[0])).toBeNull();
    expect(parseGsvInView("hello")).toBeNull();
  });
});

describe("aggregateFix", () => {
  it("merges sentences into a usable fix", () => {
    const fix = aggregateFix(NMEA_LINES);
    expect(hasPosition(fix)).toBe(true);
    expect(fix.altitude).toBe(545.4);
    expect(fix.satellites).toBe(8);
    expect(fix.valid).toBe(true);
  });
});

describe("createFixAggregator", () => {
  it("sums satellites in view across constellations", () => {
    const agg = createFixAggregator();
    for (const line of [...NMEA_LINES, GLONASS_GSV, GSA_3D]) agg.update(line);
    expect(agg.fix.satellitesInView).toBe(11 + 8);
    expect(agg.fix.hdop).toBeCloseTo(1.3, 4);
    expect(agg.fix.fixType).toBe(3);
  });

  it("clears position and hdop when the lock is lost, keeping liveness fields", () => {
    const agg = createFixAggregator();
    for (const line of [...NMEA_LINES, GSA_3D]) agg.update(line);
    expect(hasPosition(agg.fix)).toBe(true);
    expect(agg.fix.course).toBeCloseTo(31.66, 2);

    // Lock drops: GGA quality 0 + void RMC.
    expect(agg.update(GGA_NO_LOCK)).toBe(true);
    agg.update(RMC_VOID);

    expect(hasPosition(agg.fix)).toBe(false);
    expect(agg.fix.altitude).toBeUndefined();
    expect(agg.fix.speedKmh).toBeUndefined();
    expect(agg.fix.course).toBeUndefined();
    expect(agg.fix.hdop).toBeUndefined();
    // Liveness/diagnostic fields survive so the UI can still show "acquiring".
    expect(agg.fix.fixQuality).toBe(0);
    expect(agg.fix.valid).toBe(false);
    expect(agg.fix.satellites).toBe(0);
  });

  it("ignores a no-fix GSA from one constellation while the overall lock holds", () => {
    // The SIM7600 emits one GSA per constellation: $BDGSA,A,1 (no BeiDou fix,
    // empty DOPs) must not wipe the hdop/fixType the GPS GSA just reported.
    const agg = createFixAggregator();
    for (const line of [...NMEA_LINES, GSA_3D]) agg.update(line);
    expect(agg.update(GSA_NO_FIX)).toBe(false);
    expect(agg.fix.hdop).toBeCloseTo(1.3, 4);
    expect(agg.fix.fixType).toBe(3);
    expect(hasPosition(agg.fix)).toBe(true);
  });

  it("recovers the position when the lock returns", () => {
    const agg = createFixAggregator();
    agg.update(GGA_NO_LOCK);
    for (const line of NMEA_LINES) agg.update(line);
    expect(hasPosition(agg.fix)).toBe(true);
    expect(agg.fix.fixQuality).toBe(1);
  });
});
