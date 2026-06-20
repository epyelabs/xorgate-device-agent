# xorgate-device-agent

Productionized device telemetry agent for Xorgate (replaces the PoC
`prototyping/alc-hw-tracker-pro`), packaged as the **`xorgate`** CLI. It runs the
telemetry agent as a managed **background daemon** (start/stop/status/restart)
and ships a live terminal **monitor** UI ([ink](https://github.com/vadimdemedes/ink)).

**Simulator-first:** it ships a working synthetic-telemetry mode so the cloud
pipeline (IoT Rule → ingestion Lambda → Postgres → live web view) can be exercised
end-to-end without hardware. It connects to AWS IoT Core over mTLS (MQTT v5) and
publishes the §1.3 telemetry payload at 1 Hz to
`xorgate/devices/{deviceId}/telemetry`.

## CLI

```
xorgate <command> [agent flags]

  start      Launch the telemetry agent as a background daemon
  stop       Gracefully stop the daemon (publishes offline first)
  restart    Stop then start
  status     Is it running? pid, uptime, connection, last-telemetry age, counters
  monitor    Live ink dashboard — sidebar of telemetry modules (↑↓ select, ↵/→ open),
             Connection/Daemon in the header; start/stop/restart from inside
  logs       Print the daemon log   (-f follow, -n N lines, --clear truncate)
```

The daemon is self-contained (no PM2/systemd). `start` forks the agent as a
detached process and tracks it via files under `~/.xorgate/` (override with
`XORGATE_HOME`):

| File | Purpose |
|------|---------|
| `agent.pid` | JSON pid record (pid, startedAt, deviceId, mode…) — also used to detect a recycled pid via process start-time |
| `agent.log` | append-only stdout/stderr of the worker (`xorgate logs`) |
| `state.json` | atomic live snapshot the monitor/status read (connection, latest telemetry, counters) |

`status` / `monitor` report **running** (pid alive + identity verified + state
fresh), **stale** (pidfile left by a crashed/recycled process — auto-cleaned on
next start/stop), or **stopped**. Quitting the monitor with `q` never stops the
daemon — it's detached and independent.

## Quick try (no AWS, no hardware)

`--offline` swaps in a network-free stub for AWS IoT, so the whole daemon +
monitor stack runs on a bare checkout with no creds:

```sh
npm install
npm run build
node dist/cli.js --offline start     # or, installed: xorgate --offline start
node dist/cli.js status              # ● running … connected … (fresh)
node dist/cli.js monitor             # live dashboard; press q to leave (daemon keeps running)
node dist/cli.js stop
```

During development you can skip the build and run the TypeScript directly:

```sh
npm run dev -- --offline start       # spawns the worker via tsx
npm run dev -- monitor
```

Install it as the `xorgate` command with `npm link` (or `npm i -g .`).

## Real run (AWS IoT, simulator telemetry)

The simulator is just a Node process that talks to AWS IoT over the internet, so
it runs on any machine — including the one running the web app.

```sh
npm install && npm run build
# ID_TOKEN = a Cognito idToken for an owner/admin user (grab it from the web app;
# see "Getting an idToken" below). Creates + provisions a fresh device and writes
# ./creds, then prints the run command:
ID_TOKEN="<idToken>" node scripts/provision-test-device.mjs
# → start the daemon with the printed DEVICE_ID + IOT_DATA_ENDPOINT:
DEVICE_ID=<uuid> IOT_DATA_ENDPOINT=<...-ats.iot...> xorgate start
xorgate monitor
```

Open `/devices/<uuid>/live` in the web app while it runs. `xorgate stop` flips the
device to `offline` immediately; an ungraceful kill is covered by the MQTT
Last-Will and the cloud sweeper (~60 s).

### Getting an idToken
In the web app's browser devtools console (while logged in):

```js
const cid = "7v9p61d6286ap4gbfj0psfu9h6" // VITE_COGNITO_CLIENT_ID
const u = localStorage.getItem(`CognitoIdentityServiceProvider.${cid}.LastAuthUser`)
copy(localStorage.getItem(`CognitoIdentityServiceProvider.${cid}.${u}.idToken`))
```

It's now on your clipboard (`copy()` is a devtools helper). Tokens expire after
~1 h — re-grab if provisioning returns 401.

### Setup (manual)

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

2. **Run** (set the device id and IoT data endpoint from the same provision
   response — `device.id` and `iot.dataEndpoint`):

   ```sh
   DEVICE_ID=<uuid> IOT_DATA_ENDPOINT=<xxxx-ats.iot.us-east-1.amazonaws.com> xorgate start
   xorgate status   # should show "connected"
   ```

## Configuration

Agent flags can be passed to `start`/`restart`/`monitor` (e.g.
`xorgate start --rate 2`) or set as env vars:

| Env | Flag | Default | Notes |
|-----|------|---------|-------|
| `DEVICE_ID` | `--device-id` | — (required unless `--offline`) | Canonical `devices.id` (uuid). Also the MQTT clientId/thing name. |
| `IOT_DATA_ENDPOINT` | `--endpoint` | — (required unless `--offline`) | `iot:Data-ATS` endpoint (`iot.dataEndpoint` from provisioning). |
| `OFFLINE` | `--offline` | off | Network-free stub mqtt + simulator. No creds needed. |
| `MODE` | `--mode` | `sim` | `sim` = synthetic telemetry; `real` = hardware collectors (P5 skeleton, inert). |
| `RATE_HZ` | `--rate` | `1` | Publish rate. |
| `CERT_PATH` | `--cert` | `./creds/cert.crt` | |
| `KEY_PATH` | `--key` | `./creds/private.key` | |
| `CA_PATH` | `--ca` | `./creds/ca.pem` | Amazon Root CA1. |

Other env: `XORGATE_HOME` (runtime dir, default `~/.xorgate`),
`XORGATE_STOP_TIMEOUT_MS` (graceful-stop timeout before SIGKILL, default 5000).

## Layout

```
src/
  cli.tsx            # `xorgate` dispatcher → commands/* (only `monitor` loads ink)
  worker.ts          # detached daemon entry: 1 Hz publish loop + state-file writer
  commands/          # start, stop, restart, status, logs, monitor
  daemon/            # process manager (no React): runtime, pidfile, process, state, manager
  agent/             # telemetry core: config (+offline), mqtt (+stub), simulator, collectors
  monitor/           # ink master/detail dashboard: MonitorHeader, modules, hooks
  components/ lib/ hardware/ dashboard/   # reusable UI (shared with argus-cli)
test/                # vitest: pidfile/state/process/manager logic + monitor UI smoke
```

`MODE=real` and the `agent/collectors/` reads (serial GPS/LTE, /proc + /sys system
metrics, I2C IMU) are intentionally inert stubs — the real firmware lands in
**P5 (device firmware)**. The UI scaffolding (ink components, host-metrics
readers) is adapted from `argus-test-bench/argus-cli`.

The monitor is a master/detail dashboard (argus-cli style): the header shows the
daemon's **Connection** and **Daemon** stats, the left sidebar lists the telemetry
modules (IMU/GPS/LTE/System/Media/Activity) with live status, and `↑↓`/`↵` open a
module's detail on the right. The values shown are what the **daemon publishes**
(simulated in `sim`/`--offline`; real reads land in P5).

## Build & test

```sh
npm run build     # tsc → dist/   (also the typecheck)
npm test          # vitest
```
