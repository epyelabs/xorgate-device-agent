#!/usr/bin/env node
import { loadConfig } from './config.js';
import { connect } from './mqtt.js';
import { createSimulator } from './simulator.js';
import { createCollector } from './collectors/index.js';

/**
 * Xorgate device telemetry agent (simulator-first).
 *
 *   MODE=sim  (default) — emit synthetic, schema-valid telemetry at RATE_HZ.
 *   MODE=real           — read declared collectors (P5 skeleton; inert in P2).
 *
 * Publishes the §1.3 payload to `xorgate/devices/{deviceId}/telemetry` over mTLS.
 */
const config = loadConfig();
const source =
  config.mode === 'real'
    ? createCollector(/* io_capabilities — fetch from the API in P5 */)
    : { read: (() => { const next = createSimulator(); return async () => next(); })() };

let seq = 0;
let published = 0;
let timer = null;

const client = connect(config);

client.on('connect', () => {
  console.log(
    `[agent] connected as ${config.deviceId} → ${config.endpoint} (mode=${config.mode}, ${config.rateHz} Hz)`,
  );
  client.publish(
    config.statusTopic,
    JSON.stringify({ v: 1, deviceId: config.deviceId, ts: Date.now(), online: true }),
    { qos: 0 },
  );

  if (timer) return; // already running across a reconnect
  timer = setInterval(async () => {
    const { metrics, media } = await source.read();
    const payload = {
      v: 1,
      deviceId: config.deviceId,
      ts: Date.now(),
      seq: seq++,
      metrics,
      media,
    };
    client.publish(config.telemetryTopic, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) console.error('[agent] publish error', err.message);
      else published++;
    });
  }, config.intervalMs);
});

setInterval(() => console.log(`[agent] published ${published} messages`), 10_000).unref();

client.on('reconnect', () => console.log('[agent] reconnecting…'));
client.on('error', (err) => console.error('[agent] mqtt error', err.message));
client.on('close', () => console.log('[agent] connection closed'));

function shutdown() {
  console.log('\n[agent] shutting down…');
  if (timer) clearInterval(timer);
  client.publish(
    config.statusTopic,
    JSON.stringify({ v: 1, deviceId: config.deviceId, ts: Date.now(), online: false }),
    { qos: 0 },
    () => client.end(false, {}, () => process.exit(0)),
  );
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
