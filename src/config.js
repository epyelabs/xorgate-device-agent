import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Agent configuration from env vars, overridable by CLI flags. The cert/key/CA
 * defaults match the layout of the one-shot bundle returned by
 * `POST /devices/{id}/provision` (see README): drop `iot.certificatePem`,
 * `iot.privateKey`, and the Amazon Root CA1 into ./creds.
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const get = (cliKey, envKey, fallback) =>
  args[cliKey] ?? process.env[envKey] ?? fallback;

export function loadConfig() {
  const deviceId = get('device-id', 'DEVICE_ID');
  const endpoint = get('endpoint', 'IOT_DATA_ENDPOINT');
  const mode = get('mode', 'MODE', 'sim'); // 'sim' | 'real'
  const rateHz = Number(get('rate', 'RATE_HZ', '1'));

  const certPath = resolve(get('cert', 'CERT_PATH', './creds/cert.crt'));
  const keyPath = resolve(get('key', 'KEY_PATH', './creds/private.key'));
  const caPath = resolve(get('ca', 'CA_PATH', './creds/ca.pem'));

  if (!deviceId) throw new Error('DEVICE_ID (or --device-id) is required');
  if (!endpoint) throw new Error('IOT_DATA_ENDPOINT (or --endpoint) is required');
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error(`RATE_HZ must be a positive number, got ${rateHz}`);
  }

  return {
    deviceId,
    endpoint,
    mode,
    rateHz,
    intervalMs: Math.round(1000 / rateHz),
    telemetryTopic: `xorgate/devices/${deviceId}/telemetry`,
    statusTopic: `xorgate/devices/${deviceId}/status`,
    creds: {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      ca: readFileSync(caPath),
    },
  };
}
