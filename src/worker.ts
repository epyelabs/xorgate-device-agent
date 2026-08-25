#!/usr/bin/env node
/**
 * Detached daemon entry — the actual telemetry agent. Spawned by `xorgate start`
 * (never run by users directly, though `node dist/worker.js` works for debugging).
 *
 *   MODE=sim  (default) — emit synthetic, schema-valid telemetry at RATE_HZ.
 *   MODE=real           — read declared collectors (P5 skeleton; inert for now).
 *   --offline           — no AWS: a stub mqtt client, simulator only.
 *
 * Publishes the §1.3 payload to `xorgate/devices/{deviceId}/telemetry` over mTLS
 * AND mirrors live state to XORGATE_HOME/state.json so the monitor/status can
 * read it. This file must NOT import ink/React — keep the detached process lean.
 */
import { loadConfig } from "./agent/config.js";
import { applyCloudConfig, parseCloudMessage } from "./agent/cloud-config.js";
import { ConfigSync, ensureConfigSyncBaseline } from "./agent/config-sync.js";
import { reconcileCameraMount, type CameraMountState } from "./hardware/boot-config.js";
import { migrateMediaEnabled } from "./daemon/settings-migrate.js";
import { createClockStepper, resolveTimeSyncConfig } from "./agent/clock-step.js";
import type { GpsClockReading } from "./agent/collectors/gps.js";
import type { GnssView } from "./lib/sky-state.js";
import { createTimeSourceTracker } from "./recording/session.js";
import { loadSettings } from "./daemon/settings.js";
import {
  claimCommand,
  executeCommand,
  isExpired,
  parseCommand,
  type DeviceCommandName,
} from "./agent/commands.js";
import { connect } from "./agent/mqtt.js";
import { createSimulator } from "./agent/simulator.js";
import { createCollector, type GroupSample } from "./agent/collectors/index.js";
import { loadManifest, persistUploadBucket } from "./media/manifest.js";
import { IotCredentialsProvider } from "./recording/iot-creds.js";
import { s3Put } from "./recording/s3-put.js";
import { RecordingManager, type RecordingUploadOptions } from "./recording/manager.js";
import { LedManager } from "./agent/led-manager.js";
import { LedDriver } from "./hardware/led.js";
import {
  hardwareBlocksEqual,
  loadHardwareBlock,
  saveHardwareBlock,
} from "./hardware/hardware-config.js";
import { reconcileHardware, type StreamHardwareStatus } from "./media/hardware-reconcile.js";
import { resolveChannelPipeline } from "./media/pipeline.js";
import { shmSocketPathFor } from "./recording/config.js";
import type { PowerSampleReading } from "./recording/boot-policy.js";
import { resolveBridgedCameras } from "./recording/video-capture.js";
import type {
  RecordingStatus,
  StateSnapshot,
  TelemetryPayload,
  TelemetryReading,
} from "./agent/telemetry.js";
import { StateStore } from "./daemon/state.js";
import { ensureHome, runtimeHome, workerPath } from "./daemon/runtime.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePidfile, writePidfile } from "./daemon/pidfile.js";
import { loadBuildInfo } from "./lib/build-info.js";

const WRITTEN_BY = `xorgate-device-agent@${loadBuildInfo().packageVersion}`;

const config = loadConfig();
ensureHome();

// settings.json upgrades, before ANY other reader or writer touches the file.
//
// Order matters twice over. The config-sync baseline is captured FIRST so that
// a first boot after upgrade adopts the file as-is rather than reporting every
// namespace as a local edit; the `mediaEnabled` conversion then runs as a real
// local change, which is exactly right — an operator's media opt-out has to
// reach the cloud, or the next retained document (which replaces the whole
// `recording` namespace) would turn the cameras straight back on.
ensureConfigSyncBaseline();
{
  const streamKeys = (loadManifest(config.media.manifestPath)?.channels ?? []).map(
    (c) => c.streamKey,
  );
  const migration = migrateMediaEnabled(streamKeys);
  if (migration.result === "cameras-disabled") {
    console.log(
      `[agent] mediaEnabled:false migrated to disabled cameras: ${migration.cameras.join(", ") || "(none in manifest)"}`,
    );
  } else if (migration.result === "dropped") {
    console.log("[agent] dropped the retired mediaEnabled setting from settings.json");
  }
}

/**
 * Device hardware block (cm4-support plan): platform facts from the device's
 * model — seeded at install (hardware.json from the claim response), refreshed
 * from the retained config message. Null = legacy device / v1 model: every
 * gate below then falls back to the exact pre-plan behavior (hardcoded CM5
 * wiring, sw-h264 pipelines, all collectors self-gating).
 */
let hardwareBlock = loadHardwareBlock(config.hardwarePath);
if (hardwareBlock) {
  console.log(
    `[agent] hardware block: ${hardwareBlock.platform} encoder=${hardwareBlock.encoder} ` +
      `cameras=${hardwareBlock.video.map((v) => `${v.key}@${v.connector}`).join(",") || "none"} ` +
      `rails=${hardwareBlock.rails} led=${hardwareBlock.statusLed ? "yes" : "no"} imu=${hardwareBlock.imu ?? "none"}`,
  );
}

/**
 * Per-stream reconcile verdicts, feeding the media spawn guard. Armed only
 * after a reconcile pass that could actually enumerate cameras — when
 * enumeration is unavailable the guard stays open rather than holding down
 * streams it knows nothing about.
 */
const streamHardware = new Map<string, StreamHardwareStatus>();
let streamGuardArmed = false;

async function reconcileHardwareNow(): Promise<string[]> {
  if (!hardwareBlock || config.mode !== "real" || config.offline) return [];
  const res = await reconcileHardware(hardwareBlock, {
    pipelineDir: config.media.pipelineDir,
    shmSocketPathFor,
    log: (level, msg) => {
      const t = Date.now();
      console[level === "warn" ? "warn" : "log"](`[hardware] ${msg}`);
      store.event(level, `hardware: ${msg}`, t);
      store.flush(t, true);
    },
  });
  if (res.cameras !== null) {
    streamHardware.clear();
    for (const [key, status] of res.statuses) streamHardware.set(key, status);
    streamGuardArmed = true;
  }
  return res.changedStreams;
}

/**
 * Camera mounting rotation (cam-sensor-level-rotate plan): make the boot
 * config's `rotation` parameter agree with the `cameraMount` namespace.
 *
 * Runs at startup (after the hardware reconcile, whose `.camera` files are how
 * we read the rotation actually in force), on every cloud config message, and
 * on a slow poll so a local `xorgate set` lands too. It writes config.txt only
 * when the value genuinely differs, and — the invariant this whole feature
 * hangs on — it NEVER reboots: it reports `rebootRequired` and leaves the
 * decision to a human.
 */
let cameraMountState: CameraMountState | null = null;
/**
 * Set once the report plane exists. The first reconcile runs BEFORE it (so the
 * very first report is already truthful), and reaching for `configSync` there
 * would be a temporal-dead-zone throw on the startup path.
 */
let requestConfigReport: ((origin: "boot") => void) | null = null;

async function reconcileCameraMountNow(): Promise<void> {
  if (config.mode !== "real") return;
  try {
    const next = await reconcileCameraMount({
      settings: loadSettings().cameraMount,
      hardware: hardwareBlock,
      pipelineDir: config.media.pipelineDir,
      log: (level, msg) => {
        const t = Date.now();
        console[level === "warn" ? "warn" : "log"](`[camera-mount] ${msg}`);
        store.event(level, `camera mount: ${msg}`, t);
        store.flush(t, true);
      },
    });
    const before = cameraMountState;
    cameraMountState = next;
    // Tell the cloud as soon as the answer moves — a "reboot required" an
    // operator only learns about at the hourly heartbeat is a setting that
    // looks broken for an hour.
    if (JSON.stringify(summariseCameraMount(before)) !== JSON.stringify(summariseCameraMount(next))) {
      requestConfigReport?.("boot");
    }
  } catch (err) {
    // A reconcile failure must never touch the rest of the agent: no camera
    // rotation is worth a dead worker.
    console.warn(`[agent] camera mount reconcile failed: ${(err as Error).message}`);
  }
}

/** The parts of the verdict worth re-reporting on (ignores the timestamp). */
function summariseCameraMount(state: CameraMountState | null): unknown {
  return state?.cameras.map((c) => [c.streamKey, c.desiredDeg, c.inForceDeg, c.bootDeg, c.verdict]);
}

// Spawn guard for the media supervisor (see MediaConfig.streamGuard): a
// manifest channel the model does not declare (an orphan channel row), or one
// whose camera did not enumerate, gets NO master — never the runtime's
// built-in test pipeline.
config.media.streamGuard = (streamKey) => {
  if (!hardwareBlock || !streamGuardArmed) return "ok";
  const status = streamHardware.get(streamKey);
  if (status === undefined || status === "no-camera") return "no-camera";
  return resolveChannelPipeline(config.media.pipelineDir, streamKey, config.media.pipelinePath)
    ? "ok"
    : "no-pipeline";
};

// Real mode enables every self-detecting collector; each one stays inert when
// its hardware is absent, so the worker is healthy with or without it:
//   - IMU    — runs i2cdetect, emits nothing when no BNO085 is on the bus.
//   - system — pure /proc + /sys + `df` reads, always available on Linux.
//   - gps    — reads NMEA off the SIM7600 GNSS port, {} until a fix lands.
//   - lte    — reads the connection-manager daemon's telemetry JSON, {} if absent.
// Wiring the exact set from per-device io_capabilities (instead of enabling all)
// is a later step; enabling all is safe because each collector self-gates.
const source: {
  read: () => Promise<TelemetryReading>;
  sampleGroups: () => Promise<Record<string, GroupSample>>;
  stop?: () => void;
  restartMediaChannel?: (streamKey: string) => void;
  setLiveShed?: (shed: boolean) => void;
  setDisabledStreams?: (streamKeys: readonly string[]) => void;
  samplePower?: () => Promise<PowerSampleReading | null>;
  gpsClock?: () => GpsClockReading | null;
  gnssView?: () => GnssView | null;
} =
  config.mode === "real"
    ? createCollector(
        {
          // Hardware-block gating (cm4-support): a model that declares no IMU
          // skips the collector (and its i2cdetect probe) outright; rails:false
          // pre-latches the PMIC reads off. No block = enable-all + self-gate,
          // the exact pre-plan behavior.
          sensors: { imu: hardwareBlock ? hardwareBlock.imu !== null : true },
          system: hardwareBlock ? { rails: hardwareBlock.rails } : true,
          comm: { gps: true, signal: true },
        },
        config.media,
      )
    : (() => {
        const next = createSimulator();
        return {
          read: async () => next(),
          // Recorder view of the simulator: every group counts as freshly
          // updated each call; the recorder's native-cadence caps still hold
          // non-IMU groups to ~1 Hz, so sim recordings look like real ones.
          sampleGroups: async () => {
            const { metrics } = next();
            const mono = process.hrtime.bigint();
            const out: Record<string, GroupSample> = {};
            for (const [group, fields] of Object.entries(metrics)) {
              out[group] = { fields: fields as Record<string, unknown>, updatedMono: mono };
            }
            return out;
          },
        };
      })();

const now0 = Date.now();

// When launched directly (e.g. by systemd's `node dist/worker.js`) rather than
// by `xorgate start`, self-register a pidfile so `xorgate status`/`monitor` can
// see this worker. The CLI manager sets XORGATE_MANAGED_BY=cli and writes the
// pidfile itself, so we skip here to avoid two writers racing.
const selfManaged = !process.env.XORGATE_MANAGED_BY;
if (selfManaged) {
  writePidfile({
    pid: process.pid,
    startedAt: now0,
    deviceId: config.deviceId,
    mode: config.mode,
    rateHz: config.rateHz,
    offline: config.offline,
    worker: workerPath(),
    argv: process.argv.slice(2),
    nodeVersion: process.version,
  });
}

const initial: StateSnapshot = {
  v: 1,
  writtenBy: WRITTEN_BY,
  deviceId: config.deviceId,
  mode: config.mode,
  mediaEnabled: config.media.enabled,
  rateHz: config.rateHz,
  endpoint: config.endpoint,
  offline: config.offline,
  pid: process.pid,
  startedAt: now0,
  lastWriteAt: now0,
  connection: "connecting",
  connectionSince: now0,
  seq: 0,
  published: 0,
  publishErrors: 0,
  lastPublishAt: null,
  lastError: null,
  latest: null,
  recentEvents: [{ ts: now0, level: "info", msg: `agent starting (mode=${config.mode})` }],
};
const store = new StateStore(initial);
store.flush(now0, true); // publish "connecting" immediately for status/monitor

/**
 * Segment-upload plumbing (offline recording plan, Phase 2). The kvs.json
 * manifest supplies the IoT credential endpoint + role alias (already used by
 * the KVS runtime) and — from Phase 2 provisioning — the upload bucket;
 * XORGATE_UPLOAD_BUCKET overrides for dev/test devices. Missing pieces mean
 * uploads are simply off: recording still works, segments accumulate under the
 * retention quota.
 */
function buildUploadOptions(): RecordingUploadOptions | undefined {
  if (config.offline) return undefined;
  const manifest = loadManifest(config.media.manifestPath);
  const bucket = process.env.XORGATE_UPLOAD_BUCKET || manifest?.uploadBucket;
  if (!manifest || !bucket) {
    console.log(
      `[agent] segment upload disabled (${!manifest ? "no kvs.json manifest" : "no upload bucket configured"})`,
    );
    return undefined;
  }
  const creds = new IotCredentialsProvider({
    credentialEndpoint: manifest.credentialEndpoint,
    roleAlias: manifest.roleAlias,
    thingName: config.deviceId,
    certPath: config.certPath,
    keyPath: config.keyPath,
  });
  return {
    put: async (key, body, contentType, signal) => {
      const credentials = await creds.get();
      await s3Put({ region: manifest.region, bucket, key, body, contentType, credentials, signal });
    },
    isOnline: () => store.snapshot().connection === "connected",
  };
}

// Shared time-provenance tracker: the recording manager stamps sessions and
// sidecars from it, and the offline clock stepper (Phase 4) feeds GPS/NITZ
// steps into it so post-step segments carry the honest "gps"/"nitz" value.
const timeSource = createTimeSourceTracker();

// Reconcile pipelines against the hardware block BEFORE anything reads them:
// the recording manager's camera set and the media masters both consume the
// files this (re)renders. Awaited — enumeration is one bounded rpicam exec.
await reconcileHardwareNow();

// Camera rotation: after the hardware reconcile (it needs this boot's
// enumerated camera identities) and before the report plane comes up, so the
// first report already carries an honest verdict.
await reconcileCameraMountNow();

// On-device recording (offline telemetry plan, Phase 1). Runs independently of
// MQTT connectivity — its own sampling interval, applied live from settings.json.
const recording = new RecordingManager({
  deviceId: config.deviceId,
  timeSource,
  upload: buildUploadOptions(),
  // Video capture (Phase 3): only bridged streams are eligible — a stream
  // whose .gst still owns its camera directly is left to the KVS master
  // (rollout safety; see `xorgate pipeline bridge`).
  video: {
    mediaEnabled: config.media.enabled,
    cameras: () =>
      resolveBridgedCameras(
        config.media.pipelineDir,
        loadManifest(config.media.manifestPath)?.channels ?? [],
      ),
    // Recording follows the model's encoder token (cm4-support D6): hw-h264
    // on the CM4, sw-h264 (today's exact argv) everywhere else / no block.
    encoder: () => hardwareBlock?.encoder ?? "sw-h264",
    // A KVS master attached to a dead shm writer wedges instead of crashing
    // (shmsrc shm_open loop, black stream) — bounce it onto the new socket.
    onCaptureSpawned: (streamKey) => source.restartMediaChannel?.(streamKey),
    // Load shedding rung 1 (Phase 3): park/release the live KVS masters.
    setLiveShed: (shed) => source.setLiveShed?.(shed),
    // Per-camera capacity (Phase 6): a camera turned off in settings keeps no
    // pipeline at all — its live master is held down alongside its capture.
    setDisabledCameras: (streamKeys) => source.setDisabledStreams?.(streamKeys),
  },
  sampleGroups: () => source.sampleGroups(),
  // ~1 Hz power reading for the shed policy — the system collector's cached
  // sampler, so the recorder and the shedder share one vcgencmd stream.
  // Absent in sim mode (no real power to measure → shedding inert).
  powerSample: source.samplePower ? () => source.samplePower!() : undefined,
  // GNSS view for the Phase 7 video gate (fix + sky visibility). Absent in sim
  // mode and on GPS-less hosts, which leaves the gate disarmed.
  gnss: source.gnssView ? () => source.gnssView!() : undefined,
  onStatus: (status) => {
    store.setRecording(status);
    store.flush(Date.now());
  },
  onEvent: (level, msg) => {
    const t = Date.now();
    console.log(`[agent] ${msg}`);
    store.event(level, msg, t);
    store.flush(t, true);
  },
});
// Awaited: the bounded (≤2 s) time-source probe inside start() must land
// before the first capture spawn so first sessions aren't stamped "unsynced".
await recording.start();

// Offline clock stepper (Phase 4): while NTP is unsynced this boot, step the
// wall clock from GPS (preferred) or the modem's NITZ clock, then persist to
// RTC/fake-hwclock via the sudo helper. Self-disarms once NTP syncs; the
// timeSync.offlineSources setting is the kill switch. Real mode only — the
// simulator has no GPS/modem, and a dev box must never have its clock touched.
let clockStepper: ReturnType<typeof createClockStepper> | null = null;
if (config.mode === "real") {
  clockStepper = createClockStepper({
    config: () => resolveTimeSyncConfig(loadSettings().timeSync),
    gpsClock: () => source.gpsClock?.() ?? null,
    onStepped: (stepSource) => {
      // Stamp future segment finalizations honestly; kick a probe so the
      // cached value stays coherent if NTP happens to land at the same time.
      timeSource.noteStep(stepSource);
      void timeSource.refresh().catch(() => {});
    },
    onEvent: (level, msg) => {
      const t = Date.now();
      console[level === "warn" ? "warn" : "log"](`[agent] ${msg}`);
      store.event(level, msg, t);
      store.flush(t, true);
    },
  });
  clockStepper.start();
}

let seq = 0;
let shuttingDown = false;
let timer: NodeJS.Timeout | null = null;

/**
 * RGB status LED (plans/rgb_led_events). A pure renderer over verdicts other
 * modules already publish — it derives nothing of its own, and goes inert on
 * any host without the hardware. All three reads below are cached accessors,
 * so this adds no I/O and no poller.
 */
let ledStarting = true;

/**
 * `recording.status()` re-reads the persisted counters file on every call, and
 * DiskManager budgets for that explicitly: *"Tiny file at ~1 Hz call rate —
 * negligible"*. The publish loop below already spends that 1 Hz, so the LED
 * reuses its value instead of doubling the rate; it only reads for itself when
 * that value has gone stale, which happens exactly when the publish loop is not
 * running (no cloud connection) and nothing else is reading the file at all.
 *
 * The LED can afford the staleness: every verdict it consumes is already
 * hysteresis-debounced over seconds, so a 2 s-old snapshot changes nothing.
 */
let lastRecordingStatus: { at: number; value: RecordingStatus } | null = null;
function noteRecordingStatus(value: RecordingStatus): void {
  lastRecordingStatus = { at: Date.now(), value };
}
function recordingStatusForLed(): RecordingStatus {
  const now = Date.now();
  if (!lastRecordingStatus || now - lastRecordingStatus.at >= 2000) {
    noteRecordingStatus(recording.status());
  }
  return lastRecordingStatus!.value;
}

const led = new LedManager({
  // Pin map from the hardware block (cm4-support): a model that declares no
  // status LED gets an inert driver (never drives pins blind on an unknown
  // carrier); a declared map replaces the hardcoded Argus CM5 default. No
  // block = the hardcoded default, exactly as before.
  ...(hardwareBlock
    ? {
        driver: hardwareBlock.statusLed
          ? new LedDriver({
              map: { kind: "rgb-gpio", pins: hardwareBlock.statusLed, activeHigh: true },
            })
          : new LedDriver({
              probe: async () => ({ ok: false, reason: "model declares no status LED" }),
            }),
      }
    : {}),
  signals: () => ({
    connection: store.snapshot().connection,
    recording: recordingStatusForLed(),
    gnss: source.gnssView?.() ?? null,
    starting: ledStarting,
  }),
});
// Deliberately NOT awaited: init() shells out to `which`/`gpioinfo`, and worker
// startup must never wait on — or be blocked by — an indicator light. Ticks
// before it resolves are no-ops (the driver reports unavailable).
void led.start().catch(() => {});

// Heartbeat: while not yet connected (or reconnecting/closed), force a state
// flush so a healthy-but-still-connecting daemon never shows as "stale".
//
// The LED ticks from HERE and not from the publish loop below, because that
// loop only starts on a successful mqtt connect — a device that never reaches
// the cloud is exactly the device that most needs to say so.
const heartbeat = setInterval(() => {
  if (shuttingDown) return;
  led.tick();
  ledStarting = false;
  if (store.snapshot().connection !== "connected") store.flush(Date.now(), true);
}, 1000);

/**
 * Camera-rotation poll. The cloud path reconciles on delivery; this is what
 * catches a LOCAL edit (`xorgate set cameraMount…`, a hand-edited
 * settings.json) and re-reads the boot config after someone has changed it by
 * hand. Slow on purpose — a rotation is an install-time decision, the pass is
 * two small file reads when nothing has moved, and it must never contend with
 * the second-by-second work above.
 */
const cameraMountPoll = setInterval(() => {
  if (shuttingDown) return;
  void reconcileCameraMountNow();
}, 60_000);
cameraMountPoll.unref?.();

// Last-resort net so a stray rejection (e.g. a P5 collector read) doesn't crash
// the detached daemon silently with a frozen state file.
process.on("unhandledRejection", (reason) => {
  const t = Date.now();
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[agent] unhandledRejection", msg);
  store.setError(`unhandledRejection: ${msg}`, t);
  store.flush(t, true);
});

const client = connect(config);

/**
 * The reported half of the config plane (settings-management plan, Phase 3):
 * owns the rev guard, `config-sync.json`, and the debounced publisher that
 * echoes what this device actually holds back to the cloud.
 *
 * Deliberately constructed with only READ hooks into the running agent —
 * `recording.status()` and the clock stepper's `status()` are already-published
 * snapshots. Nothing below may be awaited by, or able to block, an apply path
 * (design.md §7): every call into it is fire-and-forget and swallows its own
 * errors, so a broken report path degrades to pre-Phase-3 behaviour.
 */
const configSync = new ConfigSync({
  deviceId: config.deviceId,
  topic: config.configReportedTopic,
  publish: (topic, payload) => client.publish(topic, payload, { qos: 1, retain: false }),
  // Reported-only (Q4): `effective.agent.mode` lets the cloud show a field
  // device stuck in `sim`. There is deliberately no cloud-writable counterpart.
  mode: config.mode,
  // Gates retiring a local change: a report published into a dead link never
  // reached the mirror, so it must stay pending and be re-sent on connect.
  online: () => store.snapshot().connection === "connected",
  // The boot-config reconciler's latest verdict (cam-sensor-level-rotate).
  // A read of a snapshot the worker already holds — the report path never
  // triggers a reconcile, and certainly never a privileged write.
  cameraMount: () => cameraMountState,
  hints: () => {
    const status = recording.status();
    return {
      bootDefer: status.bootDefer ?? null,
      powerShed: status.powerShed ?? null,
      clockStepperArmed: clockStepper?.status().armed,
    };
  },
  onEvent: (level, msg) => {
    const t = Date.now();
    console[level === "warn" ? "warn" : "log"](`[agent] ${msg}`);
    store.event(level, msg, t);
    store.flush(t, true);
  },
});

// The local half of the config plane (Phase 4): fingerprint settings.json and
// report anything this worker did not write — `xorgate set`, the manage TUI, a
// hand-edit with vim. Started before MQTT connects on purpose: an edit made
// while the agent was stopped is just as real, and `config-sync.json` carries
// the baseline that makes it detectable.
requestConfigReport = (origin) => configSync.request(origin);

configSync.startWatcher();

// APN-machinery watch (Phase 2): an apply's confirm/rollback lands on the
// daemon's own timetable, minutes after the save — this is what carries the
// outcome to the cloud instead of the hourly heartbeat.
configSync.startApnWatch();

// Cloud config messages (retained; re-delivered on every connect). Persist into
// settings.json — the sim7600-lte daemon polls the file and applies gnssAntBias
// live.
/**
 * The telemetry topic in force right now (platform-auth Phase 4).
 *
 * Starts as the unscoped `xorgate/devices/{deviceId}/telemetry` and switches to
 * the tenant-scoped topic the moment the cloud tells this device which
 * organization and workspace it is in. That message is RETAINED, so the switch
 * happens within a second or so of every connect and needs nothing persisted
 * locally: the handful of samples published before it arrives go to the
 * unscoped topic, which the cloud still ingests.
 *
 * Deliberately mutable rather than a restart-time constant. The cloud can move
 * a device between workspaces, and a device that had to be rebooted to notice
 * would keep publishing where its new tenant cannot see it and its old tenant
 * still can.
 */
let telemetryTopic = config.telemetryTopic;

function scopedTelemetryTopic(scope: { organizationId: string; workspaceId: string }): string {
  return `xorgate/orgs/${scope.organizationId}/ws/${scope.workspaceId}/devices/${config.deviceId}/telemetry`;
}

function handleConfigMessage(payload: Buffer): void {
  const now = Date.now();
  const message = parseCloudMessage(payload);
  if (message === null) {
    console.error("[agent] ignoring malformed config message");
    store.event("warn", "ignoring malformed cloud config message", now);
    store.flush(now, true);
    return;
  }
  const { raw, config: parsed } = message;
  // uploadBucket backfill (Phase 6.2): devices fielded before Phase 2 have no
  // uploadBucket in kvs.json and silently cannot upload; the retained config
  // message now carries it. Persist + re-arm the uploader live (the retained
  // redelivery on every reconnect returns "unchanged" and no-ops).
  if (parsed.uploadBucket && !config.offline) {
    try {
      const res = persistUploadBucket(config.media.manifestPath, parsed.uploadBucket);
      if (res === "applied") {
        console.log(`[agent] uploadBucket persisted into kvs.json: ${parsed.uploadBucket}`);
        store.event("info", `uploadBucket backfilled: ${parsed.uploadBucket}`, now);
        store.flush(now, true);
        recording.setUpload(buildUploadOptions());
      }
    } catch (err) {
      console.error("[agent] uploadBucket persist failed", (err as Error).message);
      store.event("warn", `uploadBucket persist failed: ${(err as Error).message}`, now);
      store.flush(now, true);
    }
  }
  // Tenant scope (platform-auth Phase 4). Handled OUTSIDE the rev guard below,
  // on purpose and for the same reason `uploadBucket` is: the guard exists to
  // stop a redelivered document from reverting local SETTINGS the device has
  // since changed, and the topic a device reports on is not a setting anybody
  // can change locally. Putting it behind the guard would mean a device that
  // had already applied this rev — which, after a restart, is every device —
  // never learned where to publish.
  if (parsed.scope) {
    const next = scopedTelemetryTopic(parsed.scope);
    if (next !== telemetryTopic) {
      telemetryTopic = next;
      console.log(`[agent] telemetry topic -> ${next}`);
      store.event("info", `telemetry topic scoped to ws ${parsed.scope.workspaceId}`, now);
      store.flush(now, true);
    }
  }
  // Hardware block (cm4-support): envelope data like `scope`/`uploadBucket`,
  // handled OUTSIDE the rev guard for the same reason — it is a fact about the
  // hardware, not a setting anyone edits locally, and after a restart the
  // rev-guarded path would never re-deliver it. A CHANGED block is persisted
  // (next boot seeds from it) and pipelines re-render live: changed .gst files
  // bounce their masters, and reapply() picks up a changed camera set/encoder.
  if (parsed.hardware === null) {
    console.warn("[agent] config message carried an invalid hardware block — keeping current");
    store.event("warn", "invalid hardware block on config message — keeping current", now);
    store.flush(now, true);
  } else if (parsed.hardware && !hardwareBlocksEqual(parsed.hardware, hardwareBlock)) {
    hardwareBlock = parsed.hardware;
    try {
      saveHardwareBlock(config.hardwarePath, hardwareBlock);
    } catch (err) {
      console.warn(`[agent] hardware block persist failed: ${(err as Error).message}`);
    }
    console.log(
      `[agent] hardware block updated from cloud (${hardwareBlock.platform}, ${hardwareBlock.encoder}) — re-rendering pipelines`,
    );
    store.event("info", `hardware block updated: ${hardwareBlock.platform}/${hardwareBlock.encoder}`, now);
    store.flush(now, true);
    void reconcileHardwareNow()
      .then((changedStreams) => {
        for (const streamKey of changedStreams) source.restartMediaChannel?.(streamKey);
        recording.reapply();
      })
      .catch((err) => {
        console.error("[agent] hardware reconcile failed", (err as Error).message);
      });
  }

  // Rev guard (Phase 3): this message is RETAINED, so the broker replays it on
  // every single connect. Re-applying a document the device has already applied
  // is what makes local state revert on reconnect; skipping it here is what
  // stops that. `rev` absent/0 means a pre-Phase-2 backend — apply
  // unconditionally, exactly as before.
  const shouldApply = configSync.shouldApply(parsed.rev);
  let applied = false;
  try {
    if (shouldApply) {
      const { changed } = applyCloudConfig(parsed);
      applied = true;
      if (changed) {
        const summary = JSON.stringify(parsed);
        console.log(`[agent] cloud config applied: ${summary}`);
        store.event("info", `cloud config applied: ${summary}`, now);
        store.flush(now, true);
        // Two white flashes. Gated on `changed` on purpose: this message is
        // RETAINED, so the broker replays it on every reconnect, and flashing
        // for a no-op re-delivery would make the acknowledgement meaningless.
        led.configApplied();
      }
    } else {
      console.log(`[agent] cloud config rev ${parsed.rev} already applied — not re-applying`);
    }
    // Cloud config can (from Phase 5) carry the recording namespace; re-reading
    // settings here is how a cloud change applies without an agent restart.
    // Called on the skipped path too, so the apply machinery's cadence is
    // byte-identical to pre-Phase-3 (it is a no-op re-read when nothing moved).
    recording.reapply();
    // ... and the same for `cameraMount`: reconcile the boot config against
    // whatever settings.json now holds. Not awaited — an apply path may never
    // block on a subprocess (design.md §7) — and idempotent, so the skipped
    // redelivery path costs two file reads.
    void reconcileCameraMountNow();
  } catch (err) {
    console.error("[agent] cloud config apply failed", (err as Error).message);
    store.event("warn", `cloud config apply failed: ${(err as Error).message}`, now);
    store.flush(now, true);
  }
  // Echo the verdict to the cloud even when the apply FAILED — a failure the
  // cloud never hears about is exactly the divergence this plane exists to end.
  // `applied` gates only whether the rev advances.
  configSync.noteCloudConfig(parsed.rev, raw, parsed, applied);
  configSync.request("cloud");
}

/** How long to wait for the ack's PUBACK before going down anyway. */
const ACK_FLUSH_TIMEOUT_MS = 3000;

/** Device-side floor between honoured refresh commands (Phase 2 §4d). */
const REFRESH_MIN_INTERVAL_MS = 30_000;
/** How long after the flag before the re-probed values are re-reported. */
const REFRESH_REPROBE_REPORT_MS = 45_000;
let lastRefreshAt = 0;

/**
 * Publish a command ack and resolve once the broker has PUBACKed it — or once
 * ACK_FLUSH_TIMEOUT_MS elapses, so a slow broker cannot wedge the command.
 * Awaited before executing: a reboot severs the connection, so an unflushed ack
 * would be lost and the cloud would never learn the command landed.
 */
function publishCommandAck(ack: {
  requestId: string;
  command: DeviceCommandName;
  status: "accepted" | "rejected" | "failed";
  reason?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    client.publish(
      config.commandResponseTopic,
      JSON.stringify({ v: 1, deviceId: config.deviceId, ts: Date.now(), ...ack }),
      { qos: 1 },
      done,
    );
    setTimeout(done, ACK_FLUSH_TIMEOUT_MS).unref();
  });
}

/**
 * One-shot cloud commands (non-retained). Guarded twice over, because a stray
 * reboot on a fielded device is expensive: an `expiresAt` TTL rejects anything
 * delayed in flight, and a disk-backed ledger rejects a redelivery even across
 * the reboot it triggered.
 *
 * On success this function does not return in any meaningful sense — systemd
 * stops the unit, our SIGTERM handler runs the normal shutdown (offline status,
 * KVS teardown), and the box goes down. It only falls through to the failure ack
 * when the privileged call itself was refused, in which case the device is still
 * very much alive and the operator needs to know why nothing happened.
 */
async function handleCommandMessage(payload: Buffer): Promise<void> {
  const now = Date.now();
  const cmd = parseCommand(payload);
  if (cmd === null) {
    // No trustworthy requestId to ack against — drop it with a local trail.
    console.error("[agent] ignoring malformed command message");
    store.event("warn", "ignoring malformed command message", now);
    store.flush(now, true);
    return;
  }

  if (isExpired(cmd, now)) {
    const age = Math.round((now - cmd.ts) / 1000);
    console.warn(`[agent] rejecting expired ${cmd.command} command (issued ${age}s ago)`);
    store.event("warn", `rejected expired ${cmd.command} command (${age}s old)`, now);
    store.flush(now, true);
    await publishCommandAck({ ...cmd, status: "rejected", reason: "expired" });
    return;
  }

  // Claim BEFORE executing. `systemctl reboot` tears the process down, so an
  // execute-then-record ordering would record nothing at all.
  let claimed: boolean;
  try {
    claimed = claimCommand(cmd.requestId, now);
  } catch (err) {
    // Can't write the ledger => can't promise this won't replay => don't do it.
    const reason = `ledger write failed: ${(err as Error).message}`;
    console.error(`[agent] refusing ${cmd.command}: ${reason}`);
    store.event("warn", `refused ${cmd.command}: ${reason}`, now);
    store.flush(now, true);
    await publishCommandAck({ ...cmd, status: "failed", reason });
    return;
  }
  if (!claimed) {
    console.warn(`[agent] ignoring duplicate ${cmd.command} command ${cmd.requestId}`);
    store.event("warn", `ignored duplicate ${cmd.command} command`, now);
    store.flush(now, true);
    await publishCommandAck({ ...cmd, status: "rejected", reason: "duplicate" });
    return;
  }

  console.log(`[agent] ${cmd.command} command accepted (${cmd.requestId})`);
  store.event("info", `${cmd.command} command accepted`, now);
  store.flush(now, true);

  // `refresh` (Phase 2 §4d) is read-only and handled in-process — it never
  // reaches the sudo path. Rate-limited device-side: a hammered UI button must
  // not turn into unbounded AT traffic (the daemon re-probes on every flag).
  if (cmd.command === "refresh") {
    if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
      await publishCommandAck({ ...cmd, status: "rejected", reason: "rate-limited" });
      return;
    }
    lastRefreshAt = now;
    await publishCommandAck({ ...cmd, status: "accepted" });
    try {
      // The daemon (root) polls for this flag in both its loops and re-arms
      // its SIM/APN/bias probe throttles, then deletes it. The agent owns the
      // directory, so no privilege is needed to ask.
      writeFileSync(join(runtimeHome(), "refresh-modem.flag"), String(now));
    } catch (err) {
      console.warn(`[agent] refresh flag write failed: ${(err as Error).message}`);
    }
    // Two reports: NOW (closes the report-staleness half — most of the ~70 min
    // worst case is the hourly heartbeat, not the probe) and again after the
    // daemon has had time to honour the flag, so the re-probed values land.
    configSync.request("boot");
    setTimeout(() => configSync.request("boot"), REFRESH_REPROBE_REPORT_MS).unref();
    return;
  }

  await publishCommandAck({ ...cmd, status: "accepted" });

  const res = await executeCommand(cmd.command);
  if (!res.failed) {
    // reboot/power_off: going down, systemd's SIGTERM drives shutdown().
    // update: the oneshot updater was STARTED (--no-block returns at once); it
    // runs outside our cgroup and restarts this unit when it is done, which is
    // how the cloud learns the outcome — a fresh boot report carrying the new
    // build. Nothing more to do here but leave a trail for journalctl.
    if (cmd.command === "update") {
      const t = Date.now();
      console.log("[agent] updater started; this process will be replaced when it finishes");
      store.event("info", "agent self-update started", t);
      store.flush(t, true);
    }
    return;
  }
  const t = Date.now();
  const reason = res.notFound
    ? "sudo not found"
    : res.stderr.trim() || `exit ${res.exitCode}`;
  console.error(`[agent] ${cmd.command} failed: ${reason}`);
  store.event("warn", `${cmd.command} failed: ${reason}`, t);
  store.flush(t, true);
  await publishCommandAck({ ...cmd, status: "failed", reason });
}

// Registered once; the subscriptions themselves are (re)made on each connect
// because the session is clean.
client.on("message", (topic: string, payload: Buffer) => {
  if (topic === config.configTopic) {
    handleConfigMessage(payload);
    return;
  }
  if (topic === config.commandTopic) {
    void handleCommandMessage(payload).catch((err: Error) => {
      const t = Date.now();
      console.error("[agent] command handler crashed", err.message);
      store.event("warn", `command handler crashed: ${err.message}`, t);
      store.flush(t, true);
    });
  }
});

client.on("connect", () => {
  const now = Date.now();
  console.log(
    `[agent] connected as ${config.deviceId} → ${config.endpoint} ` +
      `(mode=${config.mode}, ${config.rateHz} Hz${config.offline ? ", offline" : ""})`,
  );
  store.setConnection("connected", now);
  store.event("info", `connected to ${config.endpoint}`, now);
  store.flush(now, true);
  recording.notifyConnectivity(true); // resume any pending segment uploads

  client.publish(
    config.statusTopic,
    JSON.stringify({ v: 1, deviceId: config.deviceId, ts: now, online: true }),
    { qos: 0 },
  );

  // Clean session: re-subscribe on every connect. The broker then replays the
  // retained config message, so a device that was offline through a settings
  // change converges right here. Commands are NOT retained, so there is nothing
  // to replay — a command issued while we were away is gone, by design.
  for (const [label, topic] of [
    ["config", config.configTopic],
    ["command", config.commandTopic],
  ] as const) {
    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        const t = Date.now();
        console.error(`[agent] ${label} subscribe failed`, err.message);
        store.event("warn", `${label} subscribe failed: ${err.message}`, t);
        store.flush(t, true);
      }
    });
  }

  // Assert current config state to the cloud. Coalesced with the report the
  // retained config message triggers ~0.5 s from now, so a connect costs one
  // report, not two. The hourly heartbeat is the repair backstop for a report
  // published into a link that was already gone.
  configSync.request("boot");
  configSync.startHeartbeat();

  if (timer) return; // already running across a reconnect
  timer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const { metrics, media } = await source.read();
      if (shuttingDown) return; // shutdown happened during the await
      const ts = Date.now();
      // Video capture state (Phase 3): the capture daemons — not the KVS
      // masters — are what "recording" means; merge their state into the
      // media block (flips the once-hardcoded media.recording placeholder).
      const video = recording.videoStatus();
      const activeCapture = new Set(
        video.streams.filter((s) => s.recording).map((s) => s.streamKey),
      );
      // Published fresh, exactly as before; also handed to the LED so it never
      // needs a second read of the counters file (see recordingStatusForLed).
      const recordingStatus = recording.status();
      noteRecordingStatus(recordingStatus);
      const payload: TelemetryPayload = {
        v: 1,
        deviceId: config.deviceId,
        ts,
        seq: seq++,
        metrics,
        media: {
          ...media,
          recording: { value: video.recording },
          // Annotate streams under capture supervision (bridged) with their
          // disk-recording state; untouched streams stay byte-identical.
          streams: media.streams.map((s) =>
            video.streams.some((v) => v.streamKey === s.streamKey)
              ? { ...s, recording: activeCapture.has(s.streamKey) }
              : s,
          ),
        },
        // Phase 2: recording/backlog status rides the live payload (cloud
        // schemas carry the matching optional block; D4 keys the live/batch
        // authority split off recording.enabled).
        recording: recordingStatus,
      };
      store.setLatest(payload);
      client.publish(telemetryTopic, JSON.stringify(payload), { qos: 0 }, (err) => {
        if (shuttingDown) return; // don't re-write state after the final flush
        const t = Date.now();
        if (err) store.recordPublishError(err.message, t);
        else store.recordPublish(t);
        store.flush(t);
      });
    } catch (err) {
      // A collector/read failure must not crash the daemon (P5 real collectors).
      const t = Date.now();
      store.setError(`read error: ${(err as Error).message}`, t);
      store.flush(t, true);
    }
  }, config.intervalMs);
});

client.on("reconnect", () => {
  const now = Date.now();
  console.log("[agent] reconnecting…");
  store.setConnection("reconnecting", now);
  store.event("warn", "reconnecting…", now);
  store.flush(now, true);
});

client.on("error", (err: Error) => {
  const now = Date.now();
  console.error("[agent] mqtt error", err.message);
  store.setError(err.message, now);
  store.flush(now, true);
});

client.on("close", () => {
  const now = Date.now();
  console.log("[agent] connection closed");
  store.setConnection("closed", now);
  store.event("warn", "connection closed", now);
  store.flush(now, true);
  recording.notifyConnectivity(false); // abort any in-flight segment upload
});

setInterval(
  () => console.log(`[agent] published ${store.snapshot().published} messages`),
  10_000,
).unref();

function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const now = Date.now();
  console.log(`\n[agent] shutting down (${sig})…`);
  if (timer) clearInterval(timer);
  clearInterval(heartbeat);
  clearInterval(cameraMountPoll);
  // Best-effort blank (pinctrl is ~1 ms/call, and this runs well before the
  // exit below). systemd's ExecStopPost=`xorgate led exit-state` is the actual
  // guarantee — and unlike us it can tell a clean stop from a crash.
  led.stop();
  configSync.stop(); // no report may be queued into a client we are about to end
  // Finalize the active recording segment (sync) so a clean stop never leaves
  // an orphan .jsonl for the next boot's crash recovery to mop up.
  recording.stop();
  store.setRecording(recording.status());
  // SIGINT any KVS master subprocesses so they deregister from their channels
  // cleanly instead of being orphaned/force-killed.
  source.stop?.();
  // Only remove the pidfile if we wrote it (direct/systemd launch); when started
  // by `xorgate stop` the manager owns pidfile removal.
  if (selfManaged) removePidfile();
  store.setConnection("closed", now);
  store.event("info", `shutting down (${sig})`, now);
  store.flush(now, true);
  client.publish(
    config.statusTopic,
    JSON.stringify({ v: 1, deviceId: config.deviceId, ts: now, online: false }),
    { qos: 0 },
    () => client.end(false, {}, () => process.exit(0)),
  );
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// SIGHUP: the GNSS tty (/dev/ttyUSB1) is opened without O_NOCTTY by a session
// leader (systemd service), so it becomes our controlling terminal — when the
// SIM7600 drops off the USB bus the tty hangup delivers SIGHUP here. The
// default disposition is instant death with zero logging, which systemd counts
// as a CLEAN exit ("Deactivated successfully" — HUP is in its default
// SuccessExitStatus), so every modem bounce looked like a silent exit-0
// (observed 2026-07-20 bench AT+CRESET, 2026-07-23 spontaneously mid-drill).
// Ignore it: the GPS collector reopens the port on its own when the modem
// re-enumerates (onEnd → reopen next tick + a silent-fd watchdog), so nothing
// needs restarting and recording/telemetry continue uninterrupted.
process.on("SIGHUP", () => {
  const now = Date.now();
  console.warn("[agent] SIGHUP ignored (tty hangup — likely modem USB drop/re-enumeration)");
  store.event("warn", "SIGHUP ignored (likely modem USB re-enumeration)", now);
  store.flush(now, true);
});
