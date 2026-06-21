import { describe, expect, it } from "vitest";
import { findImuAddress, parseI2cDetect, parseImuLine } from "../src/hardware/imu.js";
import { quatToEuler } from "../src/lib/orientation.js";

describe("parseImuLine", () => {
  it("parses a sample message", () => {
    const msg = parseImuLine(
      '{"type":"sample","quat":{"r":0.853,"i":-0.162,"j":-0.331,"k":-0.370},"linaccel":{"x":0.01,"y":0,"z":0}}',
    );
    expect(msg).toMatchObject({ type: "sample" });
    if (msg?.type === "sample") {
      expect(msg.quat.r).toBeCloseTo(0.853, 3);
      expect(msg.linaccel.x).toBeCloseTo(0.01, 3);
    }
  });

  it("parses ready and error messages", () => {
    expect(parseImuLine('{"type":"ready","address":"0x4b"}')).toMatchObject({ type: "ready" });
    expect(parseImuLine('{"type":"error","error":"import failed"}')).toMatchObject({
      type: "error",
      error: "import failed",
    });
  });

  it("ignores non-JSON / partial lines", () => {
    expect(parseImuLine("Traceback (most recent call last):")).toBeNull();
    expect(parseImuLine('{"type":"unknown"}')).toBeNull();
    expect(parseImuLine("")).toBeNull();
  });
});

describe("parseI2cDetect", () => {
  // A real `i2cdetect -y 1` grid: BNO085 acked at 0x4b, BMS at 0x6b.
  const grid = [
    "     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f",
    "00:                         -- -- -- -- -- -- -- --",
    "10: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --",
    "20: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --",
    "30: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --",
    "40: -- -- -- -- -- -- -- -- -- -- -- 4b -- -- -- --",
    "50: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --",
    "60: -- -- -- -- -- -- -- -- -- -- -- 6b -- -- -- --",
    "70: -- -- -- -- -- -- -- --",
  ].join("\n");

  it("extracts acked addresses from the grid", () => {
    const found = parseI2cDetect(grid);
    expect(found).toContain(0x4b);
    expect(found).toContain(0x6b);
    expect(found).not.toContain(0x4a);
  });

  it("findImuAddress picks the first present BNO085 candidate", () => {
    expect(findImuAddress(parseI2cDetect(grid))).toBe(0x4b);
    expect(findImuAddress([0x4a, 0x4b])).toBe(0x4a);
    expect(findImuAddress([0x6b])).toBeNull();
  });
});

describe("quatToEuler", () => {
  it("identity quaternion is level", () => {
    const e = quatToEuler({ r: 1, i: 0, j: 0, k: 0 });
    expect(e.roll).toBeCloseTo(0, 5);
    expect(e.pitch).toBeCloseTo(0, 5);
    expect(e.yaw).toBeCloseTo(0, 5);
  });

  it("90° rotation about Z reads as yaw 90", () => {
    const e = quatToEuler({ r: Math.SQRT1_2, i: 0, j: 0, k: Math.SQRT1_2 });
    expect(e.yaw).toBeCloseTo(90, 3);
    expect(e.roll).toBeCloseTo(0, 5);
    expect(e.pitch).toBeCloseTo(0, 5);
  });
});
