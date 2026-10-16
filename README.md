# xorgate-device-agent

Productionized device telemetry agent for Xorgate (replaces the PoC
`prototyping/alc-hw-tracker-pro`), packaged as the **`xorgate`** CLI. It runs the
telemetry agent as a managed **background daemon** (start/stop/status/restart)
and ships a live terminal **manage** UI ([ink](https://github.com/vadimdemedes/ink)).

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
  manage     Live ink dashboard — sidebar of telemetry modules + Settings (↑↓ select,
             ↵/→ open); Connection/Daemon in the header; start/stop/restart from inside
  set        Persist a setting and apply it — `set mode <sim|real>` or
             `set media <on|off>` (--no-restart to persist without restarting)
  sms        Read the modem's stored SMS, newest first, without marking them read
             (`sms [--limit N] [--json]`, N 1..50; bench tool, prints text);
             `sms clear [--yes]` deletes them all (counts only)
  logs       Print the daemon log   (-f follow, -n N lines, --clear truncate)
  update     Fetch the latest build, install it, and restart the service (sudo;
             on-device only — --tag <version> pins a build, --from <url> the bucket)
```

`monitor` is a deprecated alias for `manage` (still works, prints a hint).

**Run mode** (`sim` = synthetic telemetry, `real` = hardware collectors) is a
persisted setting. Change it from the `manage` UI's **Settings** pane or with
`xorgate set mode <sim|real>`; the choice is written to `settings.json` under
`XORGATE_HOME` and applied on the next (re)start. Precedence: an explicit
`--mode` flag wins, then `settings.json`, then the `MODE` env var, then `sim`.

The agent runs in one of **two supervision models** (see
[Two ways it runs](#two-ways-it-runs)): a self-managed detached daemon for
local/dev use, or under **systemd** on a provisioned device. The CLI lifecycle
verbs (`start`/`stop`/`restart`) drive the self-managed daemon; on a device you
use `systemctl` instead and the CLI is mainly for inspection (`status`/`manage`)
and `update`.

In the self-managed model, `start` forks the agent as a detached process and
tracks it via files under `~/.xorgate/` (override with `XORGATE_HOME`):

| File            | Purpose                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `agent.pid`     | JSON pid record (pid, startedAt, deviceId, mode…) — also used to detect a recycled pid via process start-time |
| `agent.log`     | append-only stdout/stderr of the worker (`xorgate logs`)                                                      |
| `state.json`    | atomic live snapshot the manage/status read (connection, latest telemetry, counters)                          |
| `settings.json` | persisted operator settings (`mode`, `mediaEnabled`) read by loadConfig                                       |

`status` / `manage` report **running** (pid alive + identity verified + state
fresh), **stale** (pidfile left by a crashed/recycled process — auto-cleaned on
next start/stop), or **stopped**. Quitting `manage` with `q` never stops the
daemon — it's detached and independent.

## Quick try (no AWS, no hardware)

`--offline` swaps in a network-free stub for AWS IoT, so the whole daemon +
manage stack runs on a bare checkout with no creds:

```sh
npm install
npm run build
node dist/cli.js --offline start     # or, installed: xorgate --offline start
node dist/cli.js status              # ● running … connected … (fresh)
node dist/cli.js manage              # live dashboard; press q to leave (daemon keeps running)
node dist/cli.js stop
```

During development you can skip the build and run the TypeScript directly:

```sh
npm run dev -- --offline start       # spawns the worker via tsx
npm run dev -- manage
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
xorgate manage
```

Open `/devices/<uuid>/live` in the web app while it runs. `xorgate stop` flips the
device to `offline` immediately; an ungraceful kill is covered by the MQTT
Last-Will and the cloud sweeper (~60 s).

### Getting an idToken

In the web app's browser devtools console (while logged in):

```js
const cid = "7v9p61d6286ap4gbfj0psfu9h6"; // VITE_COGNITO_CLIENT_ID
const u = localStorage.getItem(
  `CognitoIdentityServiceProvider.${cid}.LastAuthUser`,
);
copy(
  localStorage.getItem(`CognitoIdentityServiceProvider.${cid}.${u}.idToken`),
);
```

It's now on your clipboard (`copy()` is a devtools helper). Tokens expire after
~1 h — re-grab if provisioning returns 401.

### Setup (manual)

1. **Provision the device** (gets a one-shot cert bundle):

   ```
   POST /devices/{id}/provision     # owner/admin
   ```

   From the JSON response, populate `./creds`:

   | Response field         | File                  |
   | ---------------------- | --------------------- |
   | `iot.certificatePem`   | `./creds/cert.crt`    |
   | `iot.privateKey`       | `./creds/private.key` |
   | (download `iot.caUrl`) | `./creds/ca.pem`      |

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

Agent flags can be passed to `start`/`restart`/`manage` (e.g.
`xorgate start --rate 2`) or set as env vars:

| Env                 | Flag          | Default                         | Notes                                                                                                                                                                                                                                  |
| ------------------- | ------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_ID`         | `--device-id` | — (required unless `--offline`) | Canonical `devices.id` (uuid). Also the MQTT clientId/thing name.                                                                                                                                                                      |
| `IOT_DATA_ENDPOINT` | `--endpoint`  | — (required unless `--offline`) | `iot:Data-ATS` endpoint (`iot.dataEndpoint` from provisioning).                                                                                                                                                                        |
| `OFFLINE`           | `--offline`   | off                             | Network-free stub mqtt + simulator. No creds needed.                                                                                                                                                                                   |
| `MODE`              | `--mode`      | `sim`                           | `sim` = synthetic telemetry; `real` = hardware collectors (IMU, system, GPS, LTE) **and** the KVS WebRTC media runtime. Overridden by a persisted `settings.json` (set via `manage`/`xorgate set mode`); the `--mode` flag still wins. |
| `RATE_HZ`           | `--rate`      | `1`                             | Publish rate.                                                                                                                                                                                                                          |
| `CERT_PATH`         | `--cert`      | `./creds/cert.crt`              |                                                                                                                                                                                                                                        |
| `KEY_PATH`          | `--key`       | `./creds/private.key`           |                                                                                                                                                                                                                                        |
| `CA_PATH`           | `--ca`        | `./creds/ca.pem`                | Amazon Root CA1.                                                                                                                                                                                                                       |

Other env: `XORGATE_HOME` (runtime dir, default `~/.xorgate`),
`XORGATE_STOP_TIMEOUT_MS` (graceful-stop timeout before SIGKILL, default 5000),
`XORGATE_PYTHON_DIR` (override the `python/` helper dir; defaults to the package root).

OBD2 env (see the **OBD peripheral** section below): `XORGATE_OBD_SERIAL` (emulator
override) and, only as a fallback when settings.json holds no `obd` namespace,
`XORGATE_OBD_ADAPTER`, `XORGATE_OBD_PIN`, `XORGATE_OBD_POLL_HZ`, `XORGATE_OBD_FIELDS`,
`XORGATE_OBD_POWER_SOURCE`.

Media-runtime env (see the **Media runtime (KVS WebRTC)** section below):
`MEDIA_ENABLED` (or `xorgate set media on`), `KVS_MANIFEST` (default `./creds/kvs.json`,
`/etc/xorgate/kvs.json` on a device), `KVS_PIPELINE_DIR` (default `/etc/xorgate/pipelines`),
`KVS_CACERT_PATH` (default `<binary-dir>/cert.pem`), `KVS_RUNTIME_BIN`, `KVS_RUNTIME_LIB_DIR`,
`MEDIA_SOURCE` (default `testsrc`), `KVS_GST_PIPELINE`, `AWS_KVS_LOG_LEVEL` (default `3`).

## Layout

```
src/
  cli.tsx            # `xorgate` dispatcher → commands/* (only `manage` loads ink)
  worker.ts          # detached daemon entry: 1 Hz publish loop + state-file writer
  commands/          # start, stop, restart, status, logs, manage, set, update, pipeline,
                     #   recording, led
  daemon/            # process manager (no React): runtime, pidfile, process, state, manager, settings
  agent/             # telemetry core: config (+offline), mqtt (+stub), simulator, collectors
  monitor/           # ink master/detail dashboard: MonitorHeader, modules, hooks
  hardware/led.ts    # RGB status LED driver (pinctrl; pins hardcoded for Argus CM5 Rev1)
  lib/led-state.ts   # the LED ladder + PURE resolveLedState(signals) — no clocks, no I/O
  agent/led-manager.ts  # ticks the LED off the worker's 1 Hz loop; owns the flash overlay
  components/ lib/ hardware/ dashboard/   # reusable UI (shared with argus-cli)
test/                # vitest: pidfile/state/process/manager logic + monitor UI smoke
```

Under `MODE=real` **all four collectors are live** — IMU (BNO085 over I2C — see
below), system (CPU usage/temp, RAM, disk via pure `/proc` + `/sys` +
`df` reads, no privileges needed; `cpu_temp`/`disk_usage` are omitted off-Pi
hosts that lack a thermal zone), GPS (NMEA off the SIM7600 — see the
**GPS / GNSS** section below) and LTE (the connection-manager's telemetry
JSON). The UI scaffolding (ink components, host-metrics readers) and the IMU
read path are adapted from `argus-test-bench/argus-cli`.

The monitor is a master/detail dashboard (argus-cli style): the header shows the
daemon's **Connection** and **Daemon** stats, the left sidebar lists the telemetry
modules (IMU/GPS/LTE/System/Media/Activity) with live status, and `↑↓`/`↵` open a
module's detail on the right. The values shown are what the **daemon publishes**
(simulated in `sim`/`--offline`; hardware reads in `real`).

## Two ways it runs

The same binary supports two supervision models. Most of the sections above
(`xorgate start`, `~/.xorgate`, `--offline`) describe the **dev/local** model.
On a real device it runs under **systemd**, set up by the provisioning flow.

|                        | Dev / local (`xorgate start`) | Device (provisioned)                                     |
| ---------------------- | ----------------------------- | -------------------------------------------------------- |
| Supervisor             | self-managed detached process | systemd (`xorgate-agent.service`)                        |
| Runs as                | you                           | the provisioning user (e.g. `pi`)                        |
| Runtime dir            | `~/.xorgate`                  | `/var/lib/xorgate`                                       |
| Who writes the pidfile | `xorgate start` (the manager) | the worker self-registers on boot                        |
| Lifecycle              | `xorgate start/stop/restart`  | `sudo systemctl … xorgate-agent` (never `xorgate start`) |
| Logs                   | `xorgate logs` (`agent.log`)  | `journalctl -u xorgate-agent`                            |

The worker writes its own pidfile when launched directly (so `status`/`manage`
can see a systemd-run agent). It skips that when the CLI manager started it — the
manager sets `XORGATE_MANAGED_BY=cli` and owns the pidfile itself. Don't drop
that guard or you'll get two writers racing.

## Deploying to a device (provisioning)

You don't run `xorgate start` by hand on a device. The agent is installed and
supervised by systemd via a one-command flow driven from the web app:

1. Web app → **Devices → Provision device** mints a short-lived code and shows a
   copy-paste command.
2. On the device, paste it:

   ```sh
   curl -s https://<api>/get/<code> -o install.sh
   sudo bash install.sh
   ```

`install.sh` (rendered per-request by the backend — see
`xorgate/backend/xorgate-core-service/src/assets/install-script.ts`) installs
Node + deps, **claims the code** (the server creates the `devices` row and mints
the device's IoT X.509 cert), drops the cert bundle, downloads this agent's build
tarball from S3, installs the systemd unit + a `User=` drop-in, and starts it.
The device then appears in the web app and starts streaming.

The installer needs root (apt, `/etc`, `/opt`, systemd), but it captures
`$SUDO_USER` and runs the **service as that user**. So provision as the operator
account you want to own the agent (e.g. `pi`) **via `sudo`** — not from a root
login (which falls back to running as root).

## Permissions model (sudo vs no sudo)

Important and easy to trip over — read this before touching collectors.

- The agent **runs as the provisioning user** (from `$SUDO_USER`, e.g. `pi`), not
  root, via `/etc/systemd/system/xorgate-agent.service.d/10-user.conf`. It only
  opens an outbound mTLS connection, so it doesn't need root.
- Its files are owned by that user: certs + `agent.env` in `/etc/xorgate`
  (`0600`); pidfile + `state.json` in `/var/lib/xorgate` (`0700`, a systemd
  `StateDirectory`). `XORGATE_HOME=/var/lib/xorgate` is set in the unit, and the
  `/usr/local/bin/xorgate` wrapper defaults to the same path.
- So **as that user, inspection needs no sudo**: `xorgate status`, `xorgate manage`.
- **`sudo` is required only for**: lifecycle (`sudo systemctl restart xorgate-agent`)
  and `sudo xorgate update` (writes `/opt`, `/usr/local/bin`, `/etc/systemd`).
- A different user (or a root-fallback install inspected by `pi`) can't read the
  state dir; `xorgate status` then prints "unreadable — try sudo" instead of the
  misleading "stopped / xorgate start". Never run `xorgate start` on a systemd
  device — it spawns a second worker that fights the first for the IoT clientId.
- **Logs:** under systemd the worker's stdout goes to the journal
  (`journalctl -u xorgate-agent -f`). `xorgate logs` reads `agent.log`, which only
  the dev/self-managed daemon writes.

## On-device layout

| Path                                            | Owner    | What                                                                                                                           |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/opt/xorgate`                                  | root     | the build: `dist/`, `node_modules`, `systemd/`, `package.json` (root-owned but world-readable, so the svc user can execute it) |
| `/usr/local/bin/xorgate`                        | root     | wrapper → `node /opt/xorgate/dist/cli.js`, defaults `XORGATE_HOME=/var/lib/xorgate`                                            |
| `/etc/xorgate`                                  | svc user | `device.cert.pem`, `device.key.pem`, `root-ca.pem`, `agent.env` (all `0600`)                                                   |
| `/var/lib/xorgate`                              | svc user | `agent.pid`, `state.json` (`0700`)                                                                                             |
| `…/xorgate-agent.service` (+ `.d/10-user.conf`) | root     | systemd unit + the `User=`/`Group=` drop-in                                                                                    |

`agent.env` holds `DEVICE_ID`, `IOT_DATA_ENDPOINT`, `CERT_PATH`/`KEY_PATH`/`CA_PATH`,
`MODE`, plus `DEVICE_DIST_BUCKET_URL`/`DEVICE_DIST_VERSION` (where `xorgate update`
pulls builds from). systemd reads `agent.env` as root before dropping to the svc
user, so it doesn't need to be world-readable.

## Updating the agent

```sh
sudo xorgate update                 # pull `latest` from the dist bucket + restart
sudo xorgate update --tag v1.2.3    # pin a specific build
sudo xorgate update --from https://<bucket>   # override the source
```

`update` stages the new tarball on the `/opt` filesystem, validates it, runs
`npm ci`, **atomically swaps** `/opt/xorgate` (rolling back on failure),
reinstalls the unit + wrapper (your `User=` drop-in and certs are left intact),
refreshes the SIM7600 modem assets when the daemon is installed (applied on
next boot — the LTE daemon is not restarted mid-update; see the GPS section),
and restarts the agent. The CLI ships in the tarball, so this upgrades the CLI too. The
source is `DEVICE_DIST_BUCKET_URL` from `agent.env`; builds are published to S3 by
`.github/workflows/device-deploy-{dev,prod}.yml` (dev on push to `main`, prod on
release).

## IMU collector (BNO085, `MODE=real`)

The IMU collector (`src/agent/collectors/imu.ts`) is a real read. It detects a
BNO085 with `i2cdetect -y 1` (address `0x4a`/`0x4b`) and, when present, spawns
`python/bno085_read.py` to stream the rotation vector + linear acceleration as
line-delimited JSON (`src/hardware/imu.ts`). It publishes the raw quaternion
(`imu.quat_{r,i,j,k}`), the derived Tait-Bryan euler angles
(`imu.euler_{roll,pitch,yaw}`, degrees, via `src/lib/orientation.ts`), and the
gravity-removed linear acceleration (`imu.accel_{x,y,z}`, m/s²). With no sensor
on the bus the collector self-gates (emits nothing) and the daemon stays healthy.

The SHTP protocol + the BNO085's clock-stretching quirks make a pure-Node reader
impractical, so the read leans on the proven CircuitPython stack.

**Provisioned devices get this for free** — the backend install script
(`GET /get/:code` in `xorgate-core-service`) installs `i2c-tools` + the Adafruit
Python libs, enables the I2C bus, and adds the agent user to the `i2c` group. For
a manual / non-provisioned install, do it by hand:

```sh
sudo apt-get install -y i2c-tools python3-pip python3-dev   # i2cdetect + pip
sudo python3 -m pip install --break-system-packages adafruit-circuitpython-bno08x adafruit-blinka
sudo raspi-config nonint do_i2c 0                            # enable /dev/i2c-1
sudo usermod -aG i2c "$USER"                                 # non-root bus access
```

Iterate off-hardware with `XORGATE_MOCK=1` (or any non-Linux host): detection
reports a synthetic sensor and the stream emits a slowly-rotating mock signal.

## OBD peripheral (ELM327 over Bluetooth SPP, `MODE=real`)

Devices whose hardware block (`/etc/xorgate/hardware.json`, delivered from the
device model) declares `"peripherals": { "obd": { "adapter": "elm327", "transport": "bt-spp" } }`
get an `obd` collector (`src/agent/collectors/obd.ts`) that supervises the
stdlib-only helper `python/obd_read.py` (`src/hardware/obd.ts`, same JSON-lines
pattern as the IMU helper) and publishes `metrics.obd.*`: `link` (0 no adapter,
1 adapter only, 2 ECU answering; always present) plus `rpm`, `speed`,
`coolant_temp`, `engine_load`, `throttle`, `pedal`, `intake_temp`,
`ambient_temp`, `intake_map`, `baro`, `fuel_level`, `fuel_rate`,
`module_voltage`, `adapter_voltage`, `run_time`, `odometer`, `gear`,
`distance_since_clear`, `mil`, `dtc_count`, `engine_torque_pct` (PID 62, %),
`reference_torque` (PID 63, Nm) and the derived `engine_torque` (Nm, only when
both answered in the same cycle), each only when the car supports the
PID and the helper's last sample is under 5 s old (never a null leaf). Without
the block nothing changes. The helper owns the one allowlist gate every byte to
the car passes through, its own reconnect backoff, and the append-only audit log
under `$XORGATE_HOME/obd/audit/`; the collector only supervises it (2 s backoff,
30 s cap, 3 quick failures park 60 s; exit 6 = helper software bug, parked with
an `error` event; exit 4 = protocol refused, parked 10 min).

Start-stop and voltage (helper 0.2.0, after the 2026-10-14 Taos drive): rpm 0
with the ECU answering is a normal `live` state. Ignition off is three
consecutive misses; the helper then keeps the RFCOMM link open, reports
`ecu_silent` (link 1) and sends ONE `010C1` probe every 10 s for 10 min, then
every 60 s, then every 300 s, resuming on the first answer (a silent bus at
connect time probes `0100` the same way). The link is torn down only on
transport errors, stop strings or a signal. Rule 5 (voltage) follows
`obd.powerSource`: `switched` never stops on voltage (the socket dies with the
ignition anyway); each episode below 11.8 V is counted in the audit counter
`voltage_low_events`, logged, and shown in the status detail. `constant` stops
only after 30 s AND 3 consecutive cycles below 11.8 V with rpm 0 or unknown (a
single crank dip never stops; a running engine never stops), then reports
`stopped` (link 1) and sends one request a minute (PID 42, or ATRV when the ECU
is silent) until 12.4 V, keeping the link; the old 600 s blind backoff is gone.
The collector logs one `[obd] audit #N: ...` journal line per helper audit line
(60 s) and re-publishes the config report on the first audit of a run, every
10th after it, and on any error / forbidden / voltage-low / last-stop change, so
`effective.obd.audit` reaches the cloud within a minute of an incident.
`xorgate obd status` prints the audit counter line. Tests: `OBD_TEST_TIMESCALE=0.1`
scales every helper interval (test-only; never set on a device).

The adapter is a per-vehicle **setting**: the `obd` namespace in settings.json
(cloud contract `test/config-contract.json`, delivered on the retained config topic
only to devices whose model declares `peripherals.obd`; local writer `xorgate set
obd.*`). Fields and defaults: `enabled` false (the kill switch), `adapterMac` null
(`AA:BB:CC:DD:EE:FF`, stored uppercase; never paired by name), `pin` `"1234"`,
`pollHz` 1 (0.2..2), `fields` `[]` (= every declared field), `powerSource`
`"switched"` (`constant` turns the battery policy on). Apply class `agent-poll`: the
collector re-reads the file every second and after each cloud message; a changed
adapter/PIN/rate/fields/power source SIGINTs the helper (ATZ, close) and respawns it
with the new argv, `enabled: false` stops it (`status: disabled`, `link 0`), a null
adapter reports `not_configured`. Each of those is one activity event per transition.
The config report echoes the namespace as the collector resolved it under
`effective.obd` (plus the runtime half below) and `status.obd` says
applied / adjusted / rejected like every other namespace (rejected = the hardware
block declares no OBD peripheral, so nothing reads the key).

Precedence:

1. settings.json `obd` present: it is the truth; `XORGATE_OBD_ADAPTER/_PIN/_POLL_HZ/
   _FIELDS/_POWER_SOURCE` are ignored.
2. `obd` absent (dev/offline box, or `PATCH {obd: null}`): the env seam below applies
   exactly as in Phase 1 (`XORGATE_OBD_ADAPTER` set = run).
3. `XORGATE_OBD_SERIAL=/dev/pts/N` (emulator) overrides the adapter in both cases
   (the helper talks to the pty; `enabled: false` still stops it).

| Env                        | Default    | Notes                                                                 |
| -------------------------- | ---------- | --------------------------------------------------------------------- |
| `XORGATE_OBD_SERIAL`       | —          | Emulator pty (`/dev/pts/N`); overrides the adapter.                   |
| `XORGATE_OBD_ADAPTER`      | —          | Fallback adapter MAC when the namespace is absent. Unset = `not_configured`, `link 0`. |
| `XORGATE_OBD_PIN`          | `1234`     | Fallback legacy pairing PIN (SSP adapters ignore it).                 |
| `XORGATE_OBD_POLL_HZ`      | `1`        | Fallback poll cycle (hard cap 20 req/s inside the helper).            |
| `XORGATE_OBD_FIELDS`       | all        | Fallback CSV of field names to poll.                                  |
| `XORGATE_OBD_POWER_SOURCE` | `switched` | Fallback `switched` (ignition-switched 12 V) or `constant`.           |

Clock trust gate (`src/agent/clock-trust.ts`, `MODE=real` only): a battery-less
CM5 boots on the fake-hwclock / timesyncd restore stamp (58 s to 13 h early on
the bench) until NTP or a GPS/NITZ clock step lands, and everything stamped in
that window (the live telemetry `ts`, the recorder's session id and header)
carried that wrong time into the cloud (REPORT-P1-CAR open issue 1). The agent
now HOLDS the live telemetry publish and the telemetry recorder until
`timedatectl` reports `NTPSynchronized=yes` (polled every 5 s) or the clock
stepper applies a GPS/NITZ step, for at most 5 min; past that it publishes
anyway with a warn event and `hints.clockTrust = "fallback"` in the config
report (`status.timeSync.detail` names it), clearing the flag when a sync
lands. state.json, the monitor and `xorgate status` keep updating during the
hold; `recording.clockHold: true` says the recorder is waiting. An agent in
`sim`/`replay` mode has no gate (host clock).

Commands (`xorgate/devices/{id}/command`, acked on `.../command/response` like the
others, TTL + replay ledger): `obd_scan` runs a 25 s BlueZ discovery via the stdlib
`python/obd_scan.py` (never pairs; the Pi is forced non-pairable/non-discoverable
before and after) and re-publishes the config report with `effective.obd.scan =
{ ts, candidates: [{ mac, name, rssi }] }` (strongest first, unnamed BLE randoms
dropped, max 20); `obd_forget` stops the helper, runs `bluetoothctl remove <MAC>`,
clears the vehicle profile and the audit `last_stop`, and holds `not_configured`
until the namespace changes (the console pairs it with `PATCH {obd: null}`; the
latch is in memory, so an agent restart with the same namespace pairs again).
A device without the peripheral acks both `rejected: no OBD peripheral`.

CLI: `xorgate set obd.enabled on|off`, `obd.adapter <MAC>|none`, `obd.pin <digits>`,
`obd.poll-hz <0.2-2>`, `obd.fields <csv|all>`, `obd.power-source switched|constant`
(same precedence as the other `set` keys: the cloud's next retained delivery
overwrites a local edit, and the local edit is reported back as a local change);
`xorgate obd scan [--seconds N] [--json]` prints the candidate table; `xorgate obd
status` prints the obd status line plus the last vehicle profile summary.

Where it shows: `xorgate status` prints
`obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V  adapter 10:21:3E:4F:33:65`
(req/s is seeded from the probe's measured rate until two audit lines exist; the
`adapter_not_found` event is raised once per absence, then at most every 10 min);
the monitor has an **OBD** module; the config report's `effective.obd` carries the
resolved namespace plus the runtime half (state, link, `source` settings|env,
adapter, the helper's vehicle profile, audit counters, the distinct-command
inventory capped at 200 keys, last stop, scan candidates, helper version and
allowlist hash). `forbidden` must stay 0: a non-zero value is a software bug,
not a vehicle problem.

Run against the emulator on any Linux/macOS box (no car, no Bluetooth):

```sh
pip install ELM327-emulator
elm -b out -s taos-2022            # prints the pty it created, e.g. /dev/pts/4
XORGATE_OBD_SERIAL=/dev/pts/4 MODE=real xorgate start --offline
xorgate status                     # obd line; `xorgate monitor` → OBD module
```

Off-hardware with `XORGATE_MOCK=1` (or any non-Linux host) and the adapter env
set, the helper is replaced by a synthetic stream (idle ~900 rpm, slow fuel
drain). A `sim` run of a model with `peripherals.obd` emits a plausible `obd`
group too. The helper's own tests run with `npm run test:python` (separate from
`npm test`). Porting notes for the Rust agent: `docs/PORTING-obd.md`.

## GPS / GNSS (SIM7600, `MODE=real`)

Two processes cooperate. The **connection-manager daemon**
(`modem/sim7600-lte.sh`, installed as `sim7600-lte.service` by the provisioning
flow) owns the modem's AT port (`/dev/ttyUSB2`): it configures and starts the
GNSS engine, keeps its assistance data fresh, and brings up the LTE link. The
**agent's gps collector** only ever reads the NMEA stream on `/dev/ttyUSB1`
(never writes AT), parses GGA/RMC/GSA/GSV into a rolling fix
(`src/lib/nmea.ts`), and publishes it each tick.

### LTE link: reconnection & recovery

The modem runs in RNDIS mode (USB PID `9011`): the LTE data call is dialed by
the modem firmware itself, and `usb0`'s DHCP lease comes from the modem's
**internal** NAT (`192.168.225.1`) — so a lease proves nothing about the WAN.
The daemon therefore verifies connectivity **end-to-end** (interface-bound
ping) before declaring the link up, and recovers at the modem level when
retries stop working:

- **Registration-aware connect** — good RSSI alone never triggers a connect;
  the modem must also be attached (`AT+CEREG`, exposed as `reg` in the
  telemetry JSON: 1 home / 5 roaming / 2 searching).
- **Escalating recovery ladder** on consecutive failed connect cycles: plain
  retry → PS re-attach (`AT+CGATT` 0/1 + `AT+COPS` 2/0) → radio cycle
  (`AT+CFUN` 0/1) → full modem reset (`AT+CRESET`), then repeats. A healthy
  ping heals the ladder. Losing signal (dead zone) is *not* punished — the
  ladder only escalates when the network is reachable but the link won't come
  back.
- **Wedge detection while waiting for signal**: no usable service for 10 min
  (`SIM7600_DEADZONE_NUDGE_SECS`) nudges the radio, then resets the modem —
  SIM7600 firmware can stop cell-searching entirely after a prolonged outage.
- **Exclusive interface ownership** — `usb0` must be unmanaged by
  NetworkManager (`modem/99-sim7600-unmanaged.conf` →
  `/etc/NetworkManager/conf.d/`). Otherwise NM races the daemon's dhclient
  for the modem's DHCP lease and leaves stale duplicate addresses behind
  after an outage; traffic then sources from an address the modem's NAT no
  longer maps, and the link never recovers until a reboot wipes host state.
  The daemon also flushes stale addresses around every cycle and re-installs
  the default route at metric 100 so WiFi (metric 50) keeps uplink priority.

### Why TTFF is fast (assistance, not luck)

A bare standalone GNSS start must demodulate ephemeris from the satellites at
50 bit/s, which needs a strong signal — exactly what urban canyons deny, giving
multi-minute (or never) first fixes. The daemon instead sets up, once and
idempotently (re-checked every boot, one `AT+CRESET` only when a setting
actually changed):

- **All constellations** — `AT+CGNSSMODE=15,0`: GPS + GLONASS + BeiDou +
  Galileo + QZSS, DPO power-saving off. Roughly doubles satellites in view, so
  a narrow slot of sky still yields workable geometry. Needs LE20-era firmware
  (`AT+CGMR`); on older firmware the daemon logs a warning and continues.
- **XTRA predicted ephemeris** — `AT+CGPSXE=1` + `AT+CGPSXDAUTO=1`: a ~40 kB
  file downloaded over LTE (valid ~7 days, stored in module flash, survives
  reboots and even `AT+CGPSDEL`). Re-checked every 6 h while connected,
  re-downloaded under 1 day of validity; result exposed as `xtra_valid_min` in
  the telemetry JSON. Needs an accurate module clock — NITZ normally provides
  it; HTP sync is only attempted when the clock is obviously bogus (some
  SIMs/carriers just `ERROR` on `AT+CHTPUPDATE`).
- **SUPL UE-based AGPS** — `AT+CGPSURL="supl.google.com:7276"` +
  `AT+CGPS=1,2`; the modem auto-falls back to standalone when the server is
  unreachable. (Mode 3 / UE-assisted is broken with public SUPL servers —
  don't use it.)
- **Early coarse fixes** — `AT+CGPSHOR=100` (factory 50): reports an early
  ~100 m fix in bad geometry that then refines; for a tracker an early rough
  position beats a late precise one.
- The engine is **re-asserted every 10 min** while connected (a modem reset
  otherwise comes back with GNSS off, since `AT+CGPSAUTO=0`).

Measured on the reference device (SIM7600G-H-M2, LE20B04): assisted cold start
(aiding wiped, XTRA valid) ≈ **90 s**; warm starts far less. Tune via
`SIM7600_GNSS_MODE` / `SIM7600_GNSS_DPO` / `SIM7600_GNSS_XTRA` /
`SIM7600_SUPL_URL` / `SIM7600_GNSS_ACCURACY` env (see the unit file's override
notes).

**GPS antenna power (active antenna)** is a device setting, not an env knob:
`gnssAntBias` in the agent's `settings.json`, set from the web device settings
page ("Power the GPS antenna") or `xorgate set gps-antenna <active|passive>`.
`true`/active powers an **active antenna's** LNA from the module's VDD_AUX LDO
(3.05 V, `AT+CVAUXV=3050` then `AT+CVAUXS=1`); an absent key means passive
(bias off), the hardware-safe default. The modem daemon asserts the state at
boot and re-reads the file live (~30 s) — no service restart, no LTE drop.
Current state is exposed as `gnss_ant_bias` in the daemon's telemetry JSON.

### What the collector publishes

Beyond `lat/lon/alt/speed/satellites/fix_quality`:

- `gps.satellites_in_view` (GSV, summed across constellations) vs
  `gps.satellites` used (GGA) separates "bad sky view / antenna problem" from
  "seeing plenty, solution still converging".
- `gps.hdop` (GSA) is the fix-confidence number — lower is better, <2 is good.
  A "fix" with hdop 5+ in urban multipath can be tens of meters off.
- **Stale positions are cleared, not frozen**: on lock loss (GGA quality 0 /
  void RMC) the aggregator drops position + hdop, so a published lat/lon is
  always current. `fix_quality: 0` with no lat/lon = "acquiring".
- SIM7600 quirk baked into the parser: GSA arrives once per constellation, and
  a no-fix one (`$BDGSA,A,1` with empty DOPs) must not clobber the combined
  fix's hdop — `fixType 1` GSA sentences are ignored.

### Troubleshooting

```sh
journalctl -u sim7600-lte -f | grep -E "GNSS|XTRA"   # config + assistance log
cat /run/sim7600-lte/telemetry.json                   # incl. xtra_valid_min
```

The daemon owns `/dev/ttyUSB2` — never open it from another process while the
service runs (stop it first for manual AT debugging). A full SIM SMS inbox
spams `+SMS FULL` on the AT port (clear with `AT+CMGD=1,4`). GNSS/LTE config
changes ship in the agent tarball (`modem/`) and are installed by provisioning
**and** refreshed by `sudo xorgate update` — but update deliberately does not
restart `sim7600-lte` (it would drop the LTE link mid-update); the new script
applies on next boot or a manual `systemctl restart sim7600-lte`.

The deeper reference — AT flows, hardware quirks (XTRA/HTP/GSA gotchas),
device verification + TTFF measurement procedure, telemetry interpretation,
and antenna selection — is in
[`docs/gnss-bringup.md`](docs/gnss-bringup.md).

## SMS inbox (`read_sms` command, `xorgate sms`)

The cloud's `read_sms` command (plans/device-sms-inbox) and the local
`xorgate sms [--limit N] [--json]` share one reader
(`src/hardware/sms-modem.ts` + the pure PDU decoder `src/hardware/sms-pdu.ts`).
It reads every stored message from **both** stores (SIM `SM` and modem `ME`;
the newest are usually on the SIM, the oldest in a full `ME`), joins
concatenated parts, sorts newest first, then cuts to N (default 10, max 50).
The result goes to `xorgate/devices/{id}/sms` (QoS 1, one message per
`requestId`); the config report advertises `effective.agent.capabilities:
["sms.read", "sms.clear"]`.

**Why `/dev/ttyUSB3`.** The LTE daemon owns `ttyUSB2` (interface 04) with no
lock, so a second writer there would interleave with its probes. The SIM7600
exposes an independent AT parser on interface 05 (the PPP "modem" port), which
nothing uses because data rides RNDIS `usb0`. The reader finds it **by
identity** (the `ttyUSB*` whose `bInterfaceNumber` is `05` under USB vendor
`1e0e`; override with `XORGATE_SMS_PORT`), checks it is a character device
(never creates it), and never writes to `ttyUSB2`.

**Non-destructive.** Reads use `AT+CMGRO` (SIMCom "read only"), so unread
messages stay unread; `CMGR`/`CMGL` (which mark them read) are never sent, and
`CMGD` only by an explicit clear (below). `CMGF` and `CPMS` mem1 are read first and restored afterwards. Limits:
3 s per AT command, 20 s per sweep (then `partial: true`), one sweep at a time
(concurrent requests join it, a repeat within 5 s reuses it), and a lock file
in `XORGATE_HOME` keeps `xorgate sms` and the agent from interleaving.

**Clear all (`clear_sms`, `xorgate sms clear [--yes]`).** The one destructive
operation (plans/device-sms-clear), for a full store (e.g. `ME 23/23`), which
makes the SIM7600 refuse new SMS. Same port, lock and single-flight guard:
`AT+CPMS="SM"` + `AT+CMGD=0,4`, then the same for `ME` (25 s per delete, a
store already at 0 is skipped), mem1 restored in `finally`, then a normal
sweep on the same port. The reply is a normal sms payload with
`action: "clear"` and `cleared: { SM, ME }` (counts before the delete); a
failed delete gives `status: "error"`, `error: "delete ME failed (…)"`. Reads
now carry `action: "read"`. A clear never joins an in-flight read and drops
the cached read; capability `sms.clear`. The CLI needs `--yes` or a y/N
answer and prints counts only.

**Privacy.** Message text and sender numbers are never logged; the agent logs
`read_sms <requestId>: status=… total=… sent=… unread=… durationMs=…` only
(`clear_sms` adds `cleared=SM:n,ME:n`).
`sim`/`replay` modes answer from a fixed synthetic inbox (no modem needed); a
`clear_sms` empties it until the process restarts.

## Media runtime (KVS WebRTC, `MODE=real`)

The media collector (`src/agent/collectors/media.ts`) supervises the compiled
`xorgate-kvs-webrtc` master runtime — **one process per KVS signaling channel** —
so the device streams live video to the web app's **Streams tab** viewer. It is the
agent-managed replacement for the standalone `xorgate-synthetic-master` rig: same
contract (connect as MASTER to `${deviceId}-${streamKey}`, IoT-cert creds, H.264),
just supervised in-process with restart-on-crash. A device with multiple cameras
(`cam0`, `cam1`, …) gets one master per channel automatically.

- **Control is local and off by default.** Toggle it from the `manage` UI's
  **Settings** pane (the `media` row, alongside run mode) or with
  `xorgate set media <on|off>`. Either persists `mediaEnabled` to `settings.json`
  and applies on the next (re)start; precedence is `--media` flag >
  `settings.json` > `MEDIA_ENABLED` env > off, and it is forced off when `--offline`.
- **Credentials reuse the device's IoT cert.** The runtime authenticates with the
  IoT credential-provider (`AWS_IOT_CORE_*`) using the device's existing
  `/etc/xorgate` cert + key — no static AWS keys. The region, credential endpoint,
  role alias (`XorgateDeviceCreds`/`…Dev`), and channel list come from the on-device
  manifest `kvs.json` (`src/media/manifest.ts`), written by the install script from
  the claim response. Shape:
  ```json
  {
    "deviceId": "...",
    "region": "us-east-1",
    "credentialEndpoint": "xxxx.credentials.iot.us-east-1.amazonaws.com",
    "roleAlias": "XorgateDeviceCredsDev",
    "channels": [{ "streamKey": "cam0", "channelName": "<deviceId>-cam0" }]
  }
  ```
- **CA bundle (gotcha).** The runtime verifies TLS to the IoT credential provider
  AND the KVS endpoints against the SDK's `cert.pem` (Starfield Services Root CA G2),
  shipped at `media/cert.pem` and used via `KVS_CACERT_PATH` (default
  `<binary-dir>/cert.pem`). The device's `root-ca.pem` (Amazon Root CA 1) validates
  MQTT but NOT the KVS plane, so it is **not** reused here.
- **Binary must be the IoT-capable build.** The shipped binary must be built from
  `xorgate-kvs-webrtc` at/after the "flexible switch on static vs IoT core mode"
  change (credential mode chosen at runtime from `AWS_IOT_CORE_CREDENTIAL_ENDPOINT`).
  An older build with the credential code behind `#ifdef IOT_CORE_ENABLE_CREDENTIALS`
  (CMake not defining it) compiles to static-keys-only and fails with
  `AWS_ACCESS_KEY_ID must be set`.
- **Binary + libs.** The aarch64 binary ships in `media/` (in the agent tarball).
  Its KVS SDK `.so` libraries (plus the SDK's vendored OpenSSL 1.1 and
  libwebsockets) are **supplied separately** into `media/lib/` (`LD_LIBRARY_PATH`)
  — pull them off the build Pi with `media/fetch-kvs-libs.sh`; see
  [`media/README.md`](media/README.md). GStreamer + glib come from apt via the
  install script.
- **Per-camera pipelines.** Each channel resolves its GStreamer pipeline from
  `<KVS_PIPELINE_DIR>/<streamKey>.gst` (default dir `/etc/xorgate/pipelines`), so
  `cam0.gst` and `cam1.gst` drive the `cam0`/`cam1` masters with their own
  `libcamerasrc camera-name=...`. Falls back to a global `KVS_GST_PIPELINE` file,
  then the runtime's built-in default (`testsrc`). Manage them with the CLI:
  `xorgate pipeline list`, `xorgate pipeline set cam0 ./cam0.gst`,
  `xorgate pipeline show cam0`, `xorgate pipeline clear cam0` (restart to apply).
  A pipeline should end in `appsink ... name=appsink-video`; see
  [`xorgate-kvs-webrtc/pipeline.example`](../xorgate-kvs-webrtc/pipeline.example).
- **Self-gating.** Off a 64-bit Linux device, or with the binary/manifest/libs
  missing, the collector stays inert and reports `media` idle — the daemon stays
  healthy. A runtime that keeps exiting before it stabilizes (typically missing
  `.so` libs) is parked as `failed` after a few quick crashes rather than
  tight-looped; fix the cause and restart the daemon.

Status shows in the monitor's **Media** pane (per-channel state) and in the
telemetry payload's `media.kvs` / `media.streams`.

## RGB status LED (`MODE=real`, Argus carrier)

The carrier's user-facing RGB LED is the **only indicator visible from outside
the enclosure**, so it is driven as a status light: someone looking at the box
can tell whether it is working, waiting, or broken. Printable operator card:
[`plans/done/rgb_led_events/LEGEND.md`](../../plans/done/rgb_led_events/LEGEND.md).

**Strict priority — first match wins.** The single definition is `LED_LADDER` in
[`src/lib/led-state.ts`](src/lib/led-state.ts); `xorgate led test` walks that
same array, so the table below and the code cannot drift.

| Pri | Colour | Pattern | Means | Resolved from |
| --- | ------ | ------- | ----- | ------------- |
| 0 | white | solid | Starting up (no real state yet) | `starting` |
| 1 | red | solid | **Agent not running** | systemd `ExecStopPost`, not the resolver |
| 2 | red | blink-fast (~4 Hz) | Power fault — undervoltage / shedding | `liveBlock.reason === "undervoltage"`, else a bare `powerShed` |
| 4 | cyan | blink-slow (~1 Hz) | Running hot — thermal shed, still recording | `liveBlock.reason === "thermal"` |
| 5 | purple | blink-fast | Network trouble — LTE/cloud down, recovering | `lte.status` + `connection` |
| 6 | blue | blink-slow | Waiting for a GPS fix | `gnss.fix`, or `liveBlock.reason === "gps-gate"` |
| 7 | green | heartbeat (double-pulse / 5.5 s) | Healthy | everything else |
| — | white | flash2 | Settings applied / command accepted | worker event, pre-empts all |

**There is no rung 3.** "Data loss" was designed and deferred: `droppedSegments`
is a *lifetime* counter, so consuming it would latch a permanent false alarm.
It returns when `DiskManager` publishes a debounced "evicting now" verdict.

**The LED is a renderer, not a policy engine.** `resolveLedState()` is pure — no
I/O, no clocks — and only *ranks* verdicts other modules already publish. It
never re-derives one; a second evaluation is how the reason and the reality come
apart. Unknowns fail open: a null LTE feed, a missing GNSS receiver or an
unrecognised `liveBlock.reason` all resolve toward *healthy*, never to red.

Two rules that look like bugs but are not:

- **A declared LTE `dead_zone` is green, not purple.** Purple means "trying and
  failing"; settled no-coverage is not a fault, and `boot-policy.ts` already
  treats `dead_zone` as resolved. It also suppresses the cloud-link clause —
  otherwise "dead zone is green" could never hold, since the cloud is
  necessarily down there.
- **A thermal shed is cyan even though it sets `powerShed` exactly like a power
  shed does.** Both walk the same ladder, so `liveBlock.reason` is consulted
  first. Keying off `powerShed` alone paints overheating boxes red and sends
  someone to check the power supply.

**No yellow/amber.** Measured on real hardware: the red die is weak on this
package, so r+g reads as "yellowish, leaning green" and cannot be identified on
its own. Everything amber would have carried is purple.

```
src/hardware/led.ts       # driver: pinctrl, colour+pattern → pins (r=12 g=21 b=16, active high)
src/lib/led-state.ts      # LED_LADDER + pure resolveLedState(signals)
src/agent/led-manager.ts  # ticks off the worker's 1 Hz loop; owns the flash overlay
src/commands/led.ts       # xorgate led <colour> [pattern] | off | test | boot | exit-state
```

Bench use — `test` is the one to run with someone watching the device:

```sh
xorgate led test                 # walk every rung, printing each label
xorgate led purple blink-fast    # hold one state (Ctrl-C leaves it dark)
xorgate led off
```

Pins are **hardcoded** for Argus CM5 Rev1 in `STATUS_LED_MAP`; a device-model
driven map is a later plan and only that constant's *source* changes. The driver
self-gates: off a Pi, without `pinctrl`, or with a pin already held by another
driver, it goes inert and everything else stays healthy. `pinctrl` needs no root
— do not add `sudo`. See also the Audio warning below: an audio overlay can
steal GPIO16/21 out from under it.

The unit drives the two states the agent cannot report about itself:

```
ExecStartPre=-/usr/local/bin/xorgate led boot        # white while coming up
ExecStopPost=-/usr/local/bin/xorgate led exit-state  # $SERVICE_RESULT: clean stop → dark, crash → solid red
```

Both are `-` prefixed so a failing LED can never stop the agent.

## Audio (I2S mic) — present on the board, not used

The Argus carrier has an input-only I2S MEMS microphone (GPIO18/19/20), but
nothing in this product uses it: no `audio0` channel in `kvs.json`, no audio
pipeline, and the agent never opens the card. The `audio0` entry in the device
model's `io_capabilities` is aspirational.

⚠️ **Do not enable it with `dtoverlay=googlevoicehat-soundcard`.** That overlay
describes a mic **plus speaker-amplifier** board, so it also reserves GPIO16
and GPIO21 — which on this carrier are the **blue and green status LEDs**.
GPIO16 in particular gets a real gpiod consumer (`sdmode`), so libgpiod refuses
the line and the LED driver cannot own it. Use `dtoverlay=audioinjector-bare-i2s`
instead: same three mic pins, no GPIO claims. Details, evidence and the
device-tree alternative are in [`docs/audio-i2s.md`](docs/audio-i2s.md).

## Build & test

```sh
npm run build     # tsc → dist/   (also the typecheck)
npm run typecheck # tsc --noEmit (CI also runs this)
npm test          # vitest
```
