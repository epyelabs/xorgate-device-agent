import { describe, expect, it } from "vitest";
import {
  applyMountCorrection,
  eulerToQuat,
  parseImuMount,
  quatConjugate,
  quatMultiply,
  quatToEuler,
  type ImuMount,
  type Quat,
} from "../src/lib/orientation.js";

function mount(partial: Partial<ImuMount>): ImuMount {
  return { enabled: true, rollDeg: 0, pitchDeg: 0, yawDeg: 0, ...partial };
}

function expectEulerClose(
  q: Quat,
  e: { roll: number; pitch: number; yaw: number },
  digits = 6,
): void {
  const got = quatToEuler(q);
  expect(got.roll).toBeCloseTo(e.roll, digits);
  expect(got.pitch).toBeCloseTo(e.pitch, digits);
  expect(got.yaw).toBeCloseTo(e.yaw, digits);
}

describe("eulerToQuat", () => {
  it("is the inverse of quatToEuler", () => {
    const cases = [
      { rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
      { rollDeg: 30, pitchDeg: -20, yawDeg: 115 },
      { rollDeg: -90, pitchDeg: 45, yawDeg: -170 },
      { rollDeg: 179, pitchDeg: -89, yawDeg: 1 },
    ];
    for (const c of cases) {
      expectEulerClose(eulerToQuat(c), {
        roll: c.rollDeg,
        pitch: c.pitchDeg,
        yaw: c.yawDeg,
      });
    }
  });

  it("produces unit quaternions", () => {
    const q = eulerToQuat({ rollDeg: 33, pitchDeg: 12, yawDeg: -140 });
    expect(q.r ** 2 + q.i ** 2 + q.j ** 2 + q.k ** 2).toBeCloseTo(1, 10);
  });
});

describe("quatMultiply / quatConjugate", () => {
  it("q ⊗ q⁻¹ = identity", () => {
    const q = eulerToQuat({ rollDeg: 25, pitchDeg: -40, yawDeg: 60 });
    const id = quatMultiply(q, quatConjugate(q));
    expect(id.r).toBeCloseTo(1, 10);
    expect(id.i).toBeCloseTo(0, 10);
    expect(id.j).toBeCloseTo(0, 10);
    expect(id.k).toBeCloseTo(0, 10);
  });

  it("composes rotations in ZYX order", () => {
    // Rz(90)·Rx(90) as separate factors must equal the single ZYX euler.
    const rz = eulerToQuat({ rollDeg: 0, pitchDeg: 0, yawDeg: 90 });
    const rx = eulerToQuat({ rollDeg: 90, pitchDeg: 0, yawDeg: 0 });
    const composed = quatMultiply(rz, rx);
    expectEulerClose(composed, { roll: 90, pitch: 0, yaw: 90 });
  });
});

describe("applyMountCorrection", () => {
  it("no-ops for an identity mount", () => {
    const q = eulerToQuat({ rollDeg: 10, pitchDeg: 5, yawDeg: -30 });
    expectEulerClose(applyMountCorrection(q, mount({})), {
      roll: 10,
      pitch: 5,
      yaw: -30,
    });
  });

  it("un-swaps roll and pitch for a sideways (yaw 90°) mount", () => {
    // Vehicle rolls 15°; the sensor is bolted in yawed 90°, so the sensor's
    // world orientation is Rx_vehicle(15)·Rz_mount(90) and its own euler shows
    // the roll as (mostly) pitch. Correction must recover pure vehicle roll.
    const vehicle = eulerToQuat({ rollDeg: 15, pitchDeg: 0, yawDeg: 0 });
    const sensor = quatMultiply(vehicle, eulerToQuat({ rollDeg: 0, pitchDeg: 0, yawDeg: 90 }));
    const sensorEuler = quatToEuler(sensor);
    expect(Math.abs(sensorEuler.pitch)).toBeGreaterThan(10); // symptom: swapped
    expectEulerClose(applyMountCorrection(sensor, mount({ yawDeg: 90 })), {
      roll: 15,
      pitch: 0,
      yaw: 0,
    });
  });

  it("removes a 180° yaw offset for a backwards mount", () => {
    const vehicle = eulerToQuat({ rollDeg: 0, pitchDeg: 0, yawDeg: 40 });
    const sensor = quatMultiply(vehicle, eulerToQuat({ rollDeg: 0, pitchDeg: 0, yawDeg: 180 }));
    expectEulerClose(applyMountCorrection(sensor, mount({ yawDeg: 180 })), {
      roll: 0,
      pitch: 0,
      yaw: 40,
    });
  });

  it("corrects a rolled (90°) mount", () => {
    const vehicle = eulerToQuat({ rollDeg: 0, pitchDeg: 12, yawDeg: 0 });
    const sensor = quatMultiply(vehicle, eulerToQuat({ rollDeg: 90, pitchDeg: 0, yawDeg: 0 }));
    expectEulerClose(applyMountCorrection(sensor, mount({ rollDeg: 90 })), {
      roll: 0,
      pitch: 12,
      yaw: 0,
    });
  });

  it("corrects a compound mount (rolled and yawed)", () => {
    const vehicle = eulerToQuat({ rollDeg: 5, pitchDeg: -8, yawDeg: 120 });
    const m = mount({ rollDeg: 90, pitchDeg: 0, yawDeg: 90 });
    const sensor = quatMultiply(
      vehicle,
      eulerToQuat({ rollDeg: m.rollDeg, pitchDeg: m.pitchDeg, yawDeg: m.yawDeg }),
    );
    expectEulerClose(applyMountCorrection(sensor, m), {
      roll: 5,
      pitch: -8,
      yaw: 120,
    });
  });
});

describe("parseImuMount", () => {
  it("accepts a well-formed mount", () => {
    expect(
      parseImuMount({ enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: -180 }),
    ).toEqual({ enabled: true, rollDeg: 90, pitchDeg: 0, yawDeg: -180 });
  });

  it("rejects malformed values wholesale", () => {
    expect(parseImuMount(null)).toBeNull();
    expect(parseImuMount("90")).toBeNull();
    expect(parseImuMount({ enabled: true })).toBeNull();
    expect(parseImuMount({ enabled: "yes", rollDeg: 0, pitchDeg: 0, yawDeg: 0 })).toBeNull();
    expect(parseImuMount({ enabled: true, rollDeg: NaN, pitchDeg: 0, yawDeg: 0 })).toBeNull();
    expect(parseImuMount({ enabled: true, rollDeg: "90", pitchDeg: 0, yawDeg: 0 })).toBeNull();
  });
});
