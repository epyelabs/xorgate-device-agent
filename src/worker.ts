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
