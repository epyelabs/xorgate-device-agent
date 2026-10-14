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
| `status` | `state` in {connecting, pairing, probing, live, ecu_silent, backoff, stopped, adapter_not_found}, `link` in {0,1,2} | `detail`, `ts` (epoch s); emitted on every transition, and again with the same state when only the detail changed (the agent updates `detail` without an event). Helper 0.2.0: `ecu_silent` and the voltage hold (`stopped`) carry link 1, the RFCOMM link stays open (section 7) |
| `profile` | — | `adapter{mac,ati,at1}`, `protocol{dpn,dp}`, `responders[]`, `pids_by_ecu{}`, `supported_fields[]`, `unsupported_fields[]`, `powertrain`, `rate_req_s`; after each probe |
| `sample` | `fields` object | only supported fields, numbers only; `link` always inside; once per poll cycle |
| `audit` | `counters` object | `inventory{cmd:count}`, `last_stop{ts,reason}|null`; every 60 s and on stop. Counters: requests, ok, no_data, timeouts, err_adapter, err_protocol, err_identity, err_voltage, reconnects, forbidden_attempts, budget_violations, bytes_tx, `voltage_low_events` (0.2.0: low-voltage episodes, both power sources) |
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
budget_violations, voltage = latest `module_voltage` else `adapter_voltage`,
`voltageLowEvents` (counter), `auditSeq` (audit lines received from the current
helper run, reset on spawn), `lastStop` (the helper's `last_stop.reason`).

Every audit line is also ONE journal line, `[obd] audit #N: req R (x.x req/s)
ok O no_data D timeouts T err E forbidden F reconnects C voltage_low V inventory
K last_stop <reason|—>` (`auditLine`, pure). Config-report trigger
(`obdReportDue`, pure): a link move, a park/exit flip, the FIRST audit line of a
run (`auditSeq` 0 → 1: the report published at `live` predates it), every
`REPORT_EVERY_AUDITS` (10) audit lines after that, and any change in errors /
forbidden / voltageLowEvents / lastStop. Never on rate or voltage changes.

`report()` (= `effective.obd`): `{ status, link, adapter:{mac[,serial]},
profile?, audit?:{counters, inventory (<= 200 heaviest keys), last_stop},
helper_version?, allowlist_sha256? }`. Reported-only: never a config
namespace, no `status` entry in the report.

## 7. Start-stop awareness and the voltage policy (helper 0.2.0)

Field finding (2026-10-14 Taos drive, `plans/obd2-bluetooth-integration/
phase-1/evidence/fix-startstop.md`): with engine start-stop the ECU keeps
answering at rpm 0 while the battery discharges (12.1 → 11.72 V over 50 s) and
each restart cranks it to ~9.8 V for one sample. Rule 5 as first implemented
(one sample below 11.8 V → ATZ, close, 600 s backoff) fired twice in 24 min and
cost two 10 min blind windows. The policy is now, in `python/obd/session.py`:

- rpm 0 with the ECU answering is `live` link 2. Nothing keys on rpm for
  ignition state; ignition off is still `ECU_MISS_LIMIT` (3) consecutive
  misses after the ECU had answered.
- `ecu_silent` (link 1): the RFCOMM link STAYS OPEN. One probe `010C1` per
  `ecu_silent_probe_interval(elapsed)`: 10 s for the first 600 s, 60 s until
  3600 s, 300 s after. The first answered probe resumes the poll loop with the
  session's plan (the `answered` / `dropped` PID sets survive). A silent bus at
  connect time (`_wait_for_ecu`, 0100 unanswered) is the same state with `0100`
  as the probe. The link is torn down only by transport errors (`LinkLost`),
  stop strings (`StopCondition`), an identity change or a signal.
- Voltage, by `--power-source`:
  - episode tracking on both: below `V_STOP` (11.8 V) opens an episode (counter
    `voltage_low_events` += 1, audit record `voltage_low`, stderr line), back
    above `V_RESUME` (12.4 V) closes it (hysteresis; a reading between the two
    does not re-count).
  - `switched`: never stops. The status detail is refreshed with the same
    `live` state (no agent event).
  - `constant`: `VoltageLow` only when the consecutive-low run is >=
    `VOLTAGE_SUSTAIN_S` (30 s) AND >= `VOLTAGE_SUSTAIN_CYCLES` (3 cycles) AND
    rpm is 0 or unknown (rpm > 0 resets the run: an alternator is running). PID
    0C joins the plan on constant power even when `rpm` is not requested, like
    PID 42. The hold (`_voltage_hold_wait`): counter `err_voltage` += 1,
    `last_stop` set, audit `voltage_hold`, status `stopped` link 1, link kept
    open, ONE request per `VOLTAGE_RECHECK_S` (60 s): PID 42 while the ECU
    answers, ATRV (+0.85 V) when it did not, alternating back to PID 42 so a
    returning ECU is seen; resume at >= 12.4 V (audit `voltage_resume`, then
    `live`). A link loss during a hold reconnects with the normal backoff,
    capped at `VOLTAGE_BACKOFF_CAP_S` (300 s), never 600 s.
- The sample is emitted BEFORE the voltage gate runs, so the dip sample itself
  is published (module_voltage 9.82 V shows in the console).
- `OBD_TEST_TIMESCALE` (env, 0.001..1, default 1) scales every interval above
  plus the audit/identity/ATRV cadences; tests only.

Audit record kinds added: `voltage_low`, `voltage_hold`, `voltage_resume`,
`ecu_silent`, `ecu_resumed`. Emulator scenarios: `taos-2022-crank`,
`taos-2022-lowbatt`, `taos-2022-ignoff` (`python/obd/emulator/README.md`);
tests: `python/tests/test_session_policy.py` (pure gate + schedule) and
`test_integration_emulator.py` (end to end over a pty).

Agent side (same commit): `src/agent/clock-trust.ts` holds the live telemetry
publish and the telemetry recorder until the wall clock is trusted (NTP, or a
GPS/NITZ step; 5 min cap, then flagged) — not an OBD seam, but the port must
mirror it or every boot republishes the pre-NTP window under a wrong time.

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
| gear | A4 (B bits 7-4 when A bit 0 is set; 0 = park/neutral, 1..n; C,D ratio ignored, ratio-only ECU = miss) | — |
| distance_since_clear | 31 | km |
| mil | 01 bit A7 | 0/1 |
| dtc_count | 01 A & 0x7F | — |
| link | — | 0 none, 1 adapter only, 2 ECU answering |

## 5. Env (phase 1, now the fallback) and the `xorgate status` line

`XORGATE_OBD_ADAPTER` (MAC, required unless serial), `XORGATE_OBD_SERIAL`
(overrides), `XORGATE_OBD_PIN` (1234), `XORGATE_OBD_POLL_HZ` (1, max 20),
`XORGATE_OBD_FIELDS` (csv), `XORGATE_OBD_POWER_SOURCE` (switched|constant).
A malformed MAC counts as not configured. Since P3 these apply ONLY when
settings.json holds no `obd` namespace (section 6); `XORGATE_OBD_SERIAL`
still overrides the adapter in both cases.

Status line, exact format (`test/obd.test.ts`, `obdStatusLine`):
`obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V  adapter 10:21:3E:4F:33:65`;
unknown rate/voltage print as `—`, the `adapter` column is omitted when none is
configured. req/s = Δrequests/Δts between the last two audit lines, seeded from
`profile.rate_req_s` until two exist, null while no helper runs.

## 6. The `obd` settings namespace and the commands (P3)

Namespace (cloud contract `test/config-contract.json`, apply class `agent-poll`;
parser `parseObdSettings` + `OBD_DEFAULTS` in `src/daemon/settings.ts`, marker
`RUST-PORT: settings seam`): `{ enabled: false, adapterMac: null, pin: "1234",
pollHz: 1 (clamp 0.2..2), fields: [] (= all), powerSource: "switched" }`, every
field optional, replace-whole-namespace from the cloud (`src/agent/cloud-config.ts`),
`null` clears it. Malformed MAC/PIN are DROPPED, never repaired (they reach
bluetoothctl).

Resolution (`resolveObdConfig` in `src/hardware/obd.ts`, marker `RUST-PORT:
settings → helper-config seam`): namespace present → `run = enabled &&
(adapterMac || serial)`, `off` = `disabled` | `not_configured`; absent → the env
seam. The collector (`applySettings`, marker `RUST-PORT: settings-apply seam`)
re-resolves every second and on `reapply()` (after a cloud message), and compares
`{run, off, helper argv}`: unchanged → nothing; `run` false → SIGINT the helper,
state `off`, link 0, sample dropped, one event; `run` true with a helper alive →
SIGINT + respawn on exit with the new argv (no backoff; state `starting`); no
helper → spawn now (pending retry/park timers cancelled). `forget()` latches the
current MAC: the same MAC resolves to `not_configured` until the namespace moves.

New collector states: `disabled`, `not_configured` (replaces `unconfigured`).
Event dedup: `adapter_not_found` warns once per absence episode, then every
`ADAPTER_ABSENT_REWARN_MS` (10 min); an episode closes on pairing/probing/live/
ecu_silent (one "adapter found again" info) or on a reconfigure, not on a helper
exit.

`effective.obd` = `{ ...resolved namespace (6 keys), status, link, source:
"settings"|"env", adapter:{mac[,serial]}, profile?, audit?, scan?: { ts,
candidates: [{mac,name,rssi}], error? }, helper_version?, allowlist_sha256? }`.
`status.obd` verdict (`obdStatus` in `src/agent/config-sync.ts`): no collector →
rejected; settings.json ≠ desired → adjusted; resolved namespace ≠ desired
(defaults filled) → adjusted ("next tick" / "env seam"); else applied, with a
detail for adapter_not_found/backoff, parked, forgotten (`not_configured` with a
MAC), or enabled without an adapter. The `{}` revert checks settings.json, not
`effective.obd` (which always exists with a collector).

Commands (`src/agent/commands.ts` names `obd_scan`, `obd_forget`; in-process in
the worker, ack `accepted` then run, `rejected: no OBD peripheral` without the
collector): scan = `python/obd_scan.py --seconds 25` → one JSON array line,
normalized by `normalizeScanCandidates` (uppercase MAC, dedup, unnamed/MAC-named
dropped, rssi desc with null last, cap 20) → `report().scan` → config report
re-requested; concurrent scans join. forget = stop helper, `bluetoothctl remove
<MAC>` ("not available" = success), profile and audit.last_stop cleared, event,
report re-requested. Python: `python/obd/scan.py` (`parse_transcript` is pure,
`python/tests/test_scan.py`).
