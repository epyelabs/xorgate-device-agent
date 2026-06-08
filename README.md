# xorgate-device-agent

Productionized device telemetry agent for Xorgate (replaces the PoC
`prototyping/alc-hw-tracker-pro`). **Simulator-first:** it ships a working
synthetic-telemetry mode so the cloud pipeline (IoT Rule → ingestion Lambda →
Postgres → live web view) can be exercised end-to-end without hardware.

It connects to AWS IoT Core over mTLS (MQTT v5) and publishes the §1.3 telemetry
payload at 1 Hz to `xorgate/devices/{deviceId}/telemetry`.

## Quick test from your laptop (no hardware)

The simulator is just a Node process that talks to AWS IoT over the internet, so
it runs on any machine — including the one running the web app.

```sh
npm install
# ID_TOKEN = a Cognito idToken for an owner/admin user (grab it from the web app;
# see "Getting an idToken" below). Creates + provisions a fresh device and writes
# ./creds, then prints the run command:
ID_TOKEN="<idToken>" node scripts/provision-test-device.mjs
# → DEVICE_ID=<uuid> IOT_DATA_ENDPOINT=<...-ats.iot...> npm start
```

Open `/devices/<uuid>/live` in the web app while it runs. Ctrl-C stops it; the
device flips to `offline` ~60 s later (the cloud sweeper).

### Getting an idToken
In the web app's browser devtools console (while logged in):

```js
const cid = "7v9p61d6286ap4gbfj0psfu9h6" // VITE_COGNITO_CLIENT_ID
const u = localStorage.getItem(`CognitoIdentityServiceProvider.${cid}.LastAuthUser`)
copy(localStorage.getItem(`CognitoIdentityServiceProvider.${cid}.${u}.idToken`))
```

It's now on your clipboard (`copy()` is a devtools helper). Tokens expire after
~1 h — re-grab if provisioning returns 401.

## Setup (manual)

1. **Provision the device** (gets a one-shot cert bundle):

   ```
   POST /devices/{id}/provision     # owner/admin
   ```

   From the JSON response, populate `./creds`:

   | Response field        | File                |
   |-----------------------|---------------------|
   | `iot.certificatePem`  | `./creds/cert.crt`  |
   | `iot.privateKey`      | `./creds/private.key` |
   | (download `iot.caUrl`)| `./creds/ca.pem`    |

   ```sh
   mkdir -p creds
   curl -s https://www.amazontrust.com/repository/AmazonRootCA1.pem -o creds/ca.pem
   # paste certificatePem → creds/cert.crt, privateKey → creds/private.key
   ```

2. **Install + run** (set the device id and the IoT data endpoint from the same
   provision response — `device.id` and `iot.dataEndpoint`):

   ```sh
   npm install
   DEVICE_ID=<uuid> IOT_DATA_ENDPOINT=<xxxx-ats.iot.us-east-1.amazonaws.com> npm start
   ```

   You should see `[agent] connected …` then a periodic `published N messages`.

## Configuration

All settings come from env vars (or `--flag value` overrides):

| Env | Flag | Default | Notes |
|-----|------|---------|-------|
| `DEVICE_ID` | `--device-id` | — (required) | Canonical `devices.id` (uuid). Also the MQTT clientId/thing name. |
| `IOT_DATA_ENDPOINT` | `--endpoint` | — (required) | `iot:Data-ATS` endpoint (`iot.dataEndpoint` from provisioning). |
| `MODE` | `--mode` | `sim` | `sim` = synthetic telemetry; `real` = hardware collectors (P5 skeleton, inert). |
| `RATE_HZ` | `--rate` | `1` | Publish rate. |
| `CERT_PATH` | `--cert` | `./creds/cert.crt` | |
| `KEY_PATH` | `--key` | `./creds/private.key` | |
| `CA_PATH` | `--ca` | `./creds/ca.pem` | Amazon Root CA1. |

## Layout

```
src/
  index.js          # connect + 1 Hz publish loop, status/LWT on the status topic
  config.js         # env/CLI config + cert loading
  mqtt.js           # mqtt@5 mTLS connect (clientId == thing name)
  simulator.js      # bounded random-walk synthetic telemetry (XG-RPI-REF-1 caps)
  collectors/       # P5 skeleton: capability-driven gps/lte/system/imu reads (stubs)
```

`MODE=real` and the `collectors/` reads (serial GPS/LTE, /proc + /sys system
metrics, I2C IMU) are intentionally inert stubs in P2 — the real firmware lands
in **P5 (device firmware)**.
