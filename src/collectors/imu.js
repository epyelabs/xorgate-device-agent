/**
 * IMU collector (x / y / z acceleration).
 *
 * P5 STUB. New for Xorgate (the PoC had no IMU). Real implementation reads an
 * I2C accelerometer (e.g. MPU-6050/LSM6DS3) at the model's declared rateHz.
 */
export function createImuCollector() {
  return {
    group: 'imu',
    async read() {
      return {}; // TODO(P5): return { x:{value,unit:'m/s^2'}, y:{value,unit:'m/s^2'}, z:{value,unit:'m/s^2'} }
    },
  };
}
