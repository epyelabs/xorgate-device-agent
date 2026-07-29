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
    /** Course over ground in degrees true, 0-360 (RMC). Direction of travel, present only while moving. */
    course?: MetricLeaf;
    /** Satellites used in the fix (GGA). */
    satellites: MetricLeaf;
    /** GGA fix quality: 0 = none, 1 = GPS, 2 = DGPS. */
    fix_quality: MetricLeaf;
    /** Satellites in view across constellations (GSV) — sky-view/antenna diagnostic. */
    satellites_in_view?: MetricLeaf;
    /** Horizontal dilution of precision (GSA) — fix confidence, lower is better. */
    hdop?: MetricLeaf;
    /**
     * Time-to-first-fix in seconds: NMEA fix-quality 0→nonzero transition
     * measured by the gps collector (the accurate TTFF; the daemon's
     * telemetry `gnss.ttff_s` is the coarse self-contained one). Present only
     * once a fix has been acquired after an observed acquiring period.
     */
    ttff_s?: MetricLeaf;
  };
  lte: {
    rssi: MetricLeaf;
    quality: MetricLeaf;
    /** Modem PMU temperature (°C) from the daemon's AT+CPMUTEMP poll. */
    modem_temp?: MetricLeaf;
    /**
     * Coarse GNSS health from the daemon (lte_gnss_recovery Phase 5, R9),
     * coded numerically because cloud telemetry leaves are numbers-only:
     * 0 ok · 1 acquiring · 2 degraded (standalone fallback) · 3 unhealthy
     * (engine off / wedge). Absent while the daemon has no knowledge yet.
     */
    gnss_health?: MetricLeaf;
    /** CRESETs fired in the daemon's rolling 24 h budget window. */
    resets_24h?: MetricLeaf;
  };
  system: {
    cpu_usage: MetricLeaf;
    cpu_temp: MetricLeaf;
    ram_usage: MetricLeaf;
    disk_usage: MetricLeaf;
    /** Throttle bits 0–3, CURRENT state: 1 undervoltage, 2 freq capped, 4 throttled, 8 soft temp limit. */
    throttled?: MetricLeaf;
    /** EXT5V input rail voltage (V), Pi 5 family only. */
    rail_5v?: MetricLeaf;
    /** PSU max current negotiated at boot (mA): 5000 on a 5V/5A PD supply, 3000 otherwise. */
    psu_max_current?: MetricLeaf;
  };
}

/** One KVS WebRTC master the media runtime supervises (one per signaling channel). */
export interface MediaStream {
  /** Stream key from the device model's media capabilities (e.g. "cam0"). */
  streamKey: string;
  /** Signaling channel the master connects to as MASTER (`${deviceId}-${streamKey}`). */
  channelName: string;
  /** Supervisor lifecycle state for this channel's master process. */
  state: "starting" | "running" | "retrying" | "failed" | "stopped";
  /**
   * True while this stream's capture daemon is writing segments to disk
   * (offline recording plan, Phase 3). Optional: absent on devices without
   * video recording; cloud schemas tolerate (strip) it until Phase 5 mirrors it.
   */
  recording?: boolean;
}

export interface TelemetryMedia {
  kvs: { value: boolean };
  recording: { value: boolean };
  streams: MediaStream[];
}

/** The §1.3 payload published to `xorgate/devices/{deviceId}/telemetry`. */
export interface TelemetryPayload {
  v: 1;
  deviceId: string;
  ts: number;
  seq: number;
  metrics: Partial<TelemetryMetrics>;
  media: TelemetryMedia;
  /**
   * On-device recording status (offline recording plan, Phase 2). Optional so
   * sim/offline payload fixtures stay valid; the worker includes it every tick.
   * The cloud schemas (backend src/schemas/telemetry.ts, frontend
   * src/lib/schemas.ts) mirror this shape — change all three together.
   */
  recording?: RecordingStatus;
}

/** One reading produced per tick by the simulator or a real collector. */
export interface TelemetryReading {
  metrics: Partial<TelemetryMetrics>;
  media: TelemetryMedia;
}

/**
 * On-device recording status (offline recording plan). Phase 1 surfaced it in
 * state.json; Phase 2 also publishes it as the payload's `recording` block
 * (deploy ordering: land the cloud schema change before an agent build that
 * publishes it reaches a shared environment).
 */
export interface RecordingStatus {
  enabled: boolean;
  sessionId: string | null;
  backlogBytes: number;
  backlogSegments: number;
  droppedSegments: number;
  uploading: boolean;
  lastUploadAt: number | null;
  /**
   * Boot power staging verdict (optimize-system-process-cycle plan, Phase 2):
   * "off" | "skipped" | "deferring" | "released:<why>". Absent until the video
   * path first consulted the policy (and on agents predating the feature).
   */
  bootDefer?: string;
  /**
   * Runtime load-shedding rung (optimize-system-process-cycle plan, Phase 3):
   * "no-live" | "bridge-only", prefixed "parked:" when the shed-cycle cap is
   * exhausted. Absent at full operation (and on agents predating the feature).
   */
  powerShed?: string;
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
  /** Effective media-runtime enabled state for this run (config.media.enabled). */
  mediaEnabled?: boolean;
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
  /** On-device recording status; absent on agents predating the recording feature. */
  recording?: RecordingStatus;
}
