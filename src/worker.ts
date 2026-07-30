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
import { applyCloudConfig, parseCloudConfig } from "./agent/cloud-config.js";
import { createClockStepper, resolveTimeSyncConfig } from "./agent/clock-step.js";
import type { GpsClockReading } from "./agent/collectors/gps.js";
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
import type { PowerSampleReading } from "./recording/boot-policy.js";
import { resolveBridgedCameras } from "./recording/video-capture.js";
import type { StateSnapshot, TelemetryPayload, TelemetryReading } from "./agent/telemetry.js";
import { StateStore } from "./daemon/state.js";
import { ensureHome, workerPath } from "./daemon/runtime.js";
import { removePidfile, writePidfile } from "./daemon/pidfile.js";

const WRITTEN_BY = "xorgate-device-agent@0.2.0";

const config = loadConfig();
ensureHome();

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
} =
  config.mode === "real"
    ? createCollector(
        { sensors: { imu: true }, system: true, comm: { gps: true, signal: true } },
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
if (config.mode === "real") {
  const clockStepper = createClockStepper({
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

// Heartbeat: while not yet connected (or reconnecting/closed), force a state
// flush so a healthy-but-still-connecting daemon never shows as "stale".
const heartbeat = setInterval(() => {
  if (shuttingDown) return;
  if (store.snapshot().connection !== "connected") store.flush(Date.now(), true);
}, 1000);

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

// Cloud config messages (retained; re-delivered on every connect). Persist into
// settings.json — the sim7600-lte daemon polls the file and applies gnssAntBias
// live.
function handleConfigMessage(payload: Buffer): void {
  const now = Date.now();
  const parsed = parseCloudConfig(payload);
  if (parsed === null) {
    console.error("[agent] ignoring malformed config message");
    store.event("warn", "ignoring malformed cloud config message", now);
    store.flush(now, true);
    return;
  }
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
  try {
    const { changed } = applyCloudConfig(parsed);
    // Cloud config can (from Phase 5) carry the recording namespace; re-reading
    // settings here is how a cloud change applies without an agent restart.
    recording.reapply();
    if (changed) {
      const summary = JSON.stringify(parsed);
      console.log(`[agent] cloud config applied: ${summary}`);
      store.event("info", `cloud config applied: ${summary}`, now);
      store.flush(now, true);
    }
  } catch (err) {
    console.error("[agent] cloud config apply failed", (err as Error).message);
    store.event("warn", `cloud config apply failed: ${(err as Error).message}`, now);
    store.flush(now, true);
  }
}

/** How long to wait for the ack's PUBACK before going down anyway. */
const ACK_FLUSH_TIMEOUT_MS = 3000;

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
  await publishCommandAck({ ...cmd, status: "accepted" });

  const res = await executeCommand(cmd.command);
  if (!res.failed) return; // going down; systemd's SIGTERM drives shutdown()
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
        recording: recording.status(),
      };
      store.setLatest(payload);
      client.publish(config.telemetryTopic, JSON.stringify(payload), { qos: 0 }, (err) => {
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
