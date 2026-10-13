# Porting the OBD2 peripheral to the Rust agent

Breadcrumbs left by the JS implementation (obd2-bluetooth-integration, phase 1).
The Rust port is a parity port; nothing here is implemented there yet. Every
seam in the JS tree is marked with a `// RUST-PORT:` comment, listed below, and
the Python helper is shared as-is (the Rust plan keeps the "Python helper +
JSON lines" pattern for the IMU; the OBD helper is the same shape).

## 1. Helper contract (frozen, contract 1)

Spawn: `python3 python/obd_read.py --adapter AA:BB:CC:DD:EE:FF [--pin 1234]
[--poll-hz 1] [--fields rpm,speed,...] [--power-source switched|constant]
[--audit-dir DIR] [--serial /dev/pts/N]` (`--serial` is the emulator and is
mutually exclusive with `--adapter`). JS argv builder: `buildObdHelperArgs` in
`src/hardware/obd.ts`.

stdout is JSON lines, one object per line, flushed. Unknown lines (and known
types missing required fields) are ignored. Types:

| type | required | notes |
|---|---|---|
| `ready` | — | `helper`, `version`, `allowlist_sha256` |
| `status` | `state` in {connecting, pairing, probing, live, ecu_silent, backoff, stopped, adapter_not_found}, `link` in {0,1,2} | `detail`, `ts` (epoch s); emitted on every transition |
| `profile` | — | `adapter{mac,ati,at1}`, `protocol{dpn,dp}`, `responders[]`, `pids_by_ecu{}`, `supported_fields[]`, `unsupported_fields[]`, `powertrain`, `rate_req_s`; after each probe |
| `sample` | `fields` object | only supported fields, numbers only; `link` always inside; once per poll cycle |
| `audit` | `counters` object | `inventory{cmd:count}`, `last_stop{ts,reason}|null`; every 60 s and on stop |
| `error` | `code` number | `error` text; followed by exit with that code |

Exit codes: 0 clean (SIGINT/SIGTERM: the helper sends ATZ, closes, exits),
2 no Bluetooth controller, 3 adapter unreachable after 10 min of its own
backoff, 4 protocol refused (not ISO 15765-4 CAN), 5 stop condition needing a
restart, 6 software bug (forbidden command / budget violation). The helper
reconnects on its own (status `backoff`); the agent never retries faster than
the table in section 3.

Test vectors: `test/obd.test.ts`, `LINES` constant (one line per type) and the
"garbage" cases (`parseObdLine` returns null for a partial line, an unknown
type, a status with an unknown state or a link outside 0..2, a sample without
`fields`, an audit without `counters`, an error without `code`). A sample field
that is not a finite number is dropped at parse time (cloud constraint C1: a
null or string leaf drops the whole telemetry frame).

## 2. Seams in the JS tree

| Seam | File | Marker |
|---|---|---|
| Hardware-block parse (`peripherals.obd`, lenient) | `src/hardware/hardware-config.ts`, `parsePeripherals` | `RUST-PORT: hardware-block parse seam` |
| Collector creation (gated on the block) | `src/agent/collectors/index.ts`, `createCollector` | `RUST-PORT: collector-creation seam` |
| Collector state machine | `src/agent/collectors/obd.ts`, header comment | `RUST-PORT: collector seam` |
| Telemetry type (`metrics.obd`) | `src/agent/telemetry.ts`, `TelemetryMetrics.obd` | `RUST-PORT: telemetry type seam` |
| Config report (`effective.obd`) | `src/agent/config-sync.ts`, `buildEffective`; `report()` in the collector | `RUST-PORT: config-report seam` |
| Status line | `src/commands/status.ts`, `obdStatusLine` | `RUST-PORT: status-line seam` |

Line parser + env config: `src/hardware/obd.ts` (`parseObdLine`,
`readObdEnvConfig`, `buildObdHelperArgs`, `mockObdStream`). Monitor module:
`src/monitor/modules.tsx` (`obd`).

## 3. Collector state machine

States: the helper's own (above) plus the supervisor's `unconfigured`
(no `XORGATE_OBD_ADAPTER`/`XORGATE_OBD_SERIAL`), `starting` (spawn pending),
`retrying` (backoff timer running), `parked` (long hold), `stopped` (agent
shutdown).

Supervision constants (contract, not implementation detail): `STABLE_MS` 15 s,
`BASE_BACKOFF_MS` 2 s doubling to `MAX_BACKOFF_MS` 30 s, `MAX_QUICK_FAILURES`
3, `PARKED_RETRY_MS` 60 s, `PROTOCOL_PARK_MS` 600 s, `SAMPLE_FRESH_MS` 5 s,
`MAX_INVENTORY_KEYS` 200.

On helper exit:

| condition | action | activity event |
|---|---|---|
| agent stopping | state `stopped`, link 0 | none |
| exit 6 | park 60 s | `error` ("software bug") |
| exit 4 | park 600 s | `error` ("protocol refused") |
| ran >= 15 s (any other code, incl. 0/3/5) | restart in 2 s, backoff reset | `warn` |
| quick exit, failures < 3 | restart after backoff (2, 4 s), backoff doubles | log only |
| quick exit, 3rd | park 60 s | `error` |

On `status` lines: `live` and `ecu_silent` emit `info`, `stopped` and
`adapter_not_found` emit `warn`, the rest log only. Repeated identical states do
not re-emit.

Output: `link` always (0 whenever no helper process is alive, otherwise the last
`status`/`sample` link); every other leaf only from a `sample` younger than 5 s
AND from a live helper; units from `OBD_FIELD_UNITS`; `link` inside `fields` is
consumed, not re-emitted as a field. The recorder's native cadence for `obd` is
1 Hz; `sample()` returns the same mapping plus a monotonic stamp that advances
on every sample or link change.

`status()`: state, link, req/s = Δrequests/Δts between the last two audit
lines (null until two exist, or on a counter reset), errors = err_adapter +
err_protocol + err_identity + err_voltage, forbidden = forbidden_attempts +
budget_violations, voltage = latest `module_voltage` else `adapter_voltage`.

`report()` (= `effective.obd`): `{ status, link, adapter:{mac[,serial]},
profile?, audit?:{counters, inventory (<= 200 heaviest keys), last_stop},
helper_version?, allowlist_sha256? }`. Reported-only: never a config
namespace, no `status` entry in the report.

## 4. Field table (plan D4)

| field | PID | unit |
|---|---|---|
| rpm | 0C | rpm |
| speed | 0D | km/h |
| coolant_temp | 05 | °C |
| engine_load | 04 | % |
| throttle | 11 | % |
| pedal | 49 | % |
| intake_temp | 68 (first sensor) else 0F | °C |
| ambient_temp | 46 | °C |
| intake_map | 0B | kPa |
| baro | 33 | kPa |
| fuel_level | 2F | % |
| fuel_rate | 9D (A,B × 0.02 g/s → L/h at 0.745 kg/L) else 5E | L/h |
| module_voltage | 42 | V |
| adapter_voltage | ATRV | V |
| run_time | 1F | s |
| odometer | A6 | km |
| gear | A4 (C,D / 1000; 0 = park/neutral) | — |
| distance_since_clear | 31 | km |
| mil | 01 bit A7 | 0/1 |
| dtc_count | 01 A & 0x7F | — |
| link | — | 0 none, 1 adapter only, 2 ECU answering |

## 5. Env (phase 1) and the `xorgate status` line

`XORGATE_OBD_ADAPTER` (MAC, required unless serial), `XORGATE_OBD_SERIAL`
(overrides), `XORGATE_OBD_PIN` (1234), `XORGATE_OBD_POLL_HZ` (1, max 20),
`XORGATE_OBD_FIELDS` (csv), `XORGATE_OBD_POWER_SOURCE` (switched|constant).
A malformed MAC counts as not configured.

Status line, exact format (`test/obd.test.ts`, `obdStatusLine`):
`obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V`; unknown
rate/voltage print as `—`.
