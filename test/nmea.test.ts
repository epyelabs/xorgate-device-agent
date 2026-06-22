import { describe, expect, it } from "vitest";
import { aggregateFix, checksumValid, hasPosition, parseSentence } from "../src/lib/nmea.js";

// Sample NMEA burst with a valid fix (ported from the argus-cli bench fixtures).
const NMEA_LINES = [
  "$GPGGA,083745.000,1430.1234,N,12101.5678,E,1,08,0.9,545.4,M,46.9,M,,*56",
  "$GPRMC,083745.000,A,1430.1234,N,12101.5678,E,0.06,31.66,130626,,,A*5A",
  "$GPGSV,3,1,11,03,03,111,00,04,15,270,00*7F",
];

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

  it("parses RMC validity and speed", () => {
    const fix = parseSentence(NMEA_LINES[1])!;
    expect(fix.valid).toBe(true);
    expect(fix.speedKmh).toBeCloseTo(0.06 * 1.852, 4);
  });

  it("returns null for non-NMEA input", () => {
    expect(parseSentence("hello")).toBeNull();
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
