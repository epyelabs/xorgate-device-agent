/** Quaternion math for the IMU collector: euler conversion + mount correction. */

export interface Euler {
  /** Rotation about X, degrees. */
  roll: number;
  /** Rotation about Y, degrees. */
  pitch: number;
  /** Rotation about Z, degrees. */
  yaw: number;
}

export interface Quat {
  r: number;
  i: number;
  j: number;
  k: number;
}

/**
 * How the IMU is physically mounted relative to the vehicle, as ZYX euler
 * degrees (the same convention as the published euler stream). A box mounted
 * sideways is `yawDeg: 90` (which is what makes roll/pitch appear swapped),
 * one facing backwards is `yawDeg: 180`, one on its side is `rollDeg: 90`,
 * and combinations compose. Cloud-managed per device (settings.json
 * `imuMount`, delivered over the retained config topic).
 */
export interface ImuMount {
  enabled: boolean;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

/**
 * Validate an unknown value as an ImuMount. Shared by the settings loader and
 * the cloud-config parser so both sides accept exactly the same shape. Angles
 * must be finite; anything else rejects the whole object (a half-valid mount
 * would silently corrupt the published orientation).
 */
export function parseImuMount(v: unknown): ImuMount | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return null;
  const angles = [o.rollDeg, o.pitchDeg, o.yawDeg];
  if (!angles.every((a) => typeof a === "number" && Number.isFinite(a))) return null;
  return {
    enabled: o.enabled,
    rollDeg: o.rollDeg as number,
    pitchDeg: o.pitchDeg as number,
    yawDeg: o.yawDeg as number,
  };
}

/**
 * Convert a unit quaternion (r = scalar) to Tait-Bryan ZYX Euler angles in
 * degrees. Lets the live view show roll/pitch/yaw without re-deriving the math
 * downstream — the collector publishes euler alongside the raw quaternion.
 */
export function quatToEuler(q: { r: number; i: number; j: number; k: number }): Euler {
  const { r, i, j, k } = q;
  const toDeg = 180 / Math.PI;

  const roll = Math.atan2(2 * (r * i + j * k), 1 - 2 * (i * i + j * j));
  const sinPitch = Math.max(-1, Math.min(1, 2 * (r * j - k * i)));
  const pitch = Math.asin(sinPitch);
  const yaw = Math.atan2(2 * (r * k + i * j), 1 - 2 * (j * j + k * k));

  return { roll: roll * toDeg, pitch: pitch * toDeg, yaw: yaw * toDeg };
}

/** ZYX euler degrees → unit quaternion; the exact inverse of quatToEuler. */
export function eulerToQuat(e: { rollDeg: number; pitchDeg: number; yawDeg: number }): Quat {
  const toRad = Math.PI / 360; // half-angles, so deg → rad/2
  const [cr, sr] = [Math.cos(e.rollDeg * toRad), Math.sin(e.rollDeg * toRad)];
  const [cp, sp] = [Math.cos(e.pitchDeg * toRad), Math.sin(e.pitchDeg * toRad)];
  const [cy, sy] = [Math.cos(e.yawDeg * toRad), Math.sin(e.yawDeg * toRad)];
  // Rz(yaw)·Ry(pitch)·Rx(roll)
  return {
    r: cy * cp * cr + sy * sp * sr,
    i: cy * cp * sr - sy * sp * cr,
    j: cy * sp * cr + sy * cp * sr,
    k: sy * cp * cr - cy * sp * sr,
  };
}

/** Hamilton product a⊗b (r = scalar part). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    r: a.r * b.r - a.i * b.i - a.j * b.j - a.k * b.k,
    i: a.r * b.i + a.i * b.r + a.j * b.k - a.k * b.j,
    j: a.r * b.j - a.i * b.k + a.j * b.r + a.k * b.i,
    k: a.r * b.k + a.i * b.j - a.j * b.i + a.k * b.r,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { r: q.r, i: -q.i, j: -q.j, k: -q.k };
}

/**
 * Rotate a sensor-frame orientation into the vehicle frame. The BNO085 reports
 * the SENSOR's orientation in the world (q_ws); with the sensor mounted at a
 * fixed rotation inside the vehicle (q_vs, from the mount config), the vehicle's
 * orientation is q_wv = q_ws ⊗ q_vs⁻¹. This is what makes a sideways-mounted
 * box report vehicle roll as roll again instead of pitch. Purely a frame
 * change — the sensor's factory calibration is untouched.
 */
export function applyMountCorrection(qSensor: Quat, mount: ImuMount): Quat {
  return quatMultiply(qSensor, quatConjugate(eulerToQuat(mount)));
}
