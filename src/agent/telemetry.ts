/**
 * Telemetry payload + daemon state types — the single source of truth shared by
 * the worker (writer) and the monitor/status (readers). Keeping the shape here
 * makes the file-based IPC type-safe end to end.
 *
 * The metric shape mirrors the simulator output and the §1.3 cloud payload:
 * every leaf is `{ value, unit? }`. In MODE=real only the declared groups are
 * present, so `metrics` is Partial.
 */

export interface MetricLeaf {
  value: number;
  unit?: string;
}

export interface TelemetryMetrics {
  /**
   * BNO085 IMU: rotation quaternion (r/i/j/k, unitless), Tait-Bryan euler angles
   * derived from it (roll/pitch/yaw, degrees), and gravity-removed linear
   * acceleration (x/y/z, m/s²). Flattens to `imu.quat_*` / `imu.euler_*` /
   * `imu.accel_*` metric keys.
   */
  imu: {
    quat_r: MetricLeaf;
    quat_i: MetricLeaf;
    quat_j: MetricLeaf;
    quat_k: MetricLeaf;
    euler_roll: MetricLeaf;
    euler_pitch: MetricLeaf;
    euler_yaw: MetricLeaf;
    accel_x: MetricLeaf;
    accel_y: MetricLeaf;
    accel_z: MetricLeaf;
  };
  gps: {
    lat: MetricLeaf;
    lon: MetricLeaf;
    alt: MetricLeaf;
    speed: MetricLeaf;
    /** Satellites used in the fix (GGA). */
    satellites: MetricLeaf;
    /** GGA fix quality: 0 = none, 1 = GPS, 2 = DGPS. */
    fix_quality: MetricLeaf;
  };
  lte: { rssi: MetricLeaf; quality: MetricLeaf };
  system: {
    cpu_usage: MetricLeaf;
    cpu_temp: MetricLeaf;
    ram_usage: MetricLeaf;
    disk_usage: MetricLeaf;
  };
}

export interface TelemetryMedia {
  kvs: { value: boolean };
  recording: { value: boolean };
  streams: unknown[];
}

/** The §1.3 payload published to `xorgate/devices/{deviceId}/telemetry`. */
export interface TelemetryPayload {
  v: 1;
  deviceId: string;
  ts: number;
  seq: number;
  metrics: Partial<TelemetryMetrics>;
  media: TelemetryMedia;
}

/** One reading produced per tick by the simulator or a real collector. */
export interface TelemetryReading {
  metrics: Partial<TelemetryMetrics>;
  media: TelemetryMedia;
}

export type RunMode = "sim" | "real";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface ActivityEvent {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

/**
 * Atomic snapshot the worker writes to `state.json` every tick (throttled). The
 * monitor polls it for live data and `status` prints from it. `latest` carries
 * the whole payload so panels are pure renderers; `recentEvents` is a small ring
 * buffer feeding the activity tail without parsing the log file.
 */
export interface StateSnapshot {
  v: 1;
  /** Package version that wrote this snapshot (forward-compat hint). */
  writtenBy: string;
  deviceId: string;
  mode: RunMode;
  rateHz: number;
  endpoint: string;
  offline: boolean;
  pid: number;
  startedAt: number;
  /** Epoch ms of this snapshot — the freshness anchor the readers check. */
  lastWriteAt: number;
  connection: ConnectionState;
  /** Epoch ms the current connection state began (for "connected since"). */
  connectionSince: number;
  seq: number;
  published: number;
  publishErrors: number;
  lastPublishAt: number | null;
  lastError: string | null;
  latest: TelemetryPayload | null;
  recentEvents: ActivityEvent[];
}
