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
import {
  claimCommand,
  executeCommand,
  isExpired,
  parseCommand,
  type DeviceCommandName,
} from "./agent/commands.js";
import { connect } from "./agent/mqtt.js";
import { createSimulator } from "./agent/simulator.js";
import { createCollector } from "./agent/collectors/index.js";
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
const source: { read: () => Promise<TelemetryReading>; stop?: () => void } =
  config.mode === "real"
    ? createCollector(
        { sensors: { imu: true }, system: true, comm: { gps: true, signal: true } },
        config.media,
      )
    : (() => {
        const next = createSimulator();
        return { read: async () => next() };
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
  try {
    const { changed } = applyCloudConfig(parsed);
    if (changed) {
      console.log(`[agent] cloud config applied: gnssAntBias=${parsed.gnssAntBias}`);
      store.event("info", `cloud config applied: gnssAntBias=${parsed.gnssAntBias}`, now);
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
      const payload: TelemetryPayload = {
        v: 1,
        deviceId: config.deviceId,
        ts,
        seq: seq++,
        metrics,
        media,
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
