/**
 * `xorgate set <key> <value>` — persist an agent setting and apply it.
 *
 * Supported keys: `mode` (<sim|real>),
 * `gps-antenna` (<active|passive>, the GNSS antenna bias),
 * `gps-fix-reset-policy` (<defer|veto-deadzone>) and `deadzone-profile`
 * (<conservative|balanced|aggressive>) — the two lteRecovery policy knobs
 * (lte_gnss_recovery plan R8), applied live by the sim7600-lte daemon at its
 * next recovery decision (no restart). Note: cloud-delivered lteRecovery
 * config overwrites local edits on the next retained config delivery.
 * The value is merged into settings.json (read by loadConfig with precedence
 * flag > settings > env), then the daemon is restarted to apply — reusing its
 * recorded launch flags so creds / --offline are preserved. `--no-restart`
 * persists without restarting. `gps-antenna` needs no restart at all: the
 * sim7600-lte daemon polls settings.json and applies the bias live.
 *
 * `wifi` (<on|off>) is different: it toggles the OS WiFi device at runtime via
 * NetworkManager (not settings.json, no daemon restart). It refuses to cut the
 * uplink you're connected over unless `--force` is given.
 *
 * `recording.*` dotted keys (offline recording plan D7) also need no restart:
 * the worker's recording manager polls settings.json and applies changes live
 * (telemetry recorder start/stop, retention limits). Supported paths:
 *   recording.telemetry.enabled <on|off>     recording.telemetry.rateHz <1-20>
 *   recording.video.enabled <on|off>         recording.video.preset <name>
 *   recording.video.segmentSeconds <10-600>  recording.upload.mode <auto|off>
 *   recording.retention.maxBytes <n>         recording.retention.minFreeBytes <n>
 *   recording.video.bootDefer <auto|always|off>
 *   recording.video.bootDeferMaxSecs <0-600> recording.video.bootDeferMinBudgetMa <0-10000>
 *   recording.video.spawnStaggerSecs <0-30>
 *   recording.video.gpsGate <auto|always|off>
 *   recording.video.gpsGateMaxSecs <0-3600>   (0 = no time cap)
 *   recording.video.gpsGateNoProgressSecs <0-3600>  (0 = off)
 * (bootDefer* / spawnStaggerSecs are the Phase 2 boot power staging knobs —
 * optimize-system-process-cycle plan.)
 *   recording.video.cameras.<streamKey> <on|off>
 * (Phase 6 per-camera capacity: `off` gives that camera NO pipeline at all —
 * no capture, no shm bridge, no KVS master. Absent = on.)
 *   recording.powerShedding.enabled <on|off>
 *   recording.powerShedding.uvSamples <1-60>        recording.powerShedding.uvWindowSecs <5-300>
 *   recording.powerShedding.railLowVolts <4-5.2>    recording.powerShedding.railLowSecs <3-120>
 *   recording.powerShedding.escalateDwellSecs <5-600>
 *   recording.powerShedding.escalateDutyPct <50-100>
 *   recording.powerShedding.restoreSecs <10-3600>   recording.powerShedding.railRestoreVolts <4-5.4>
 *   recording.powerShedding.maxShedsPerHour <0-60>
 *   recording.powerShedding.cpuTempC <50-90>      recording.powerShedding.cpuTempRestoreC <40-85>
 *   recording.powerShedding.cpuTempSecs <5-120>
 * (powerShedding.* is the Phase 3 runtime undervoltage load-shedding ladder —
 * live streaming sheds first, recording last, restore with hysteresis;
 * escalateDutyPct is the Phase 6 duty-cycle escalation rule.)
 *
 * `timeSync.*` dotted keys (Phase 4 offline time sources) are read live by the
 * worker's clock stepper each tick (~30 s; no restart):
 *   timeSync.offlineSources <on|off>       timeSync.stepThresholdSecs <2-600>
 *   timeSync.maxStepsPerBoot <1-20>
 */
import {
  loadSettings,
  parseRecordingSettings,
  parseTimeSyncSettings,
  saveSettings,
  RECORDING_RATE_HZ_MAX,
  RECORDING_RATE_HZ_MIN,
  STREAM_KEY_RE,
  type AgentSettings,
  type RecordingSettings,
  type TimeSyncSettings,
} from "../daemon/settings.js";
import { inspect, restart } from "../daemon/manager.js";
import { setWifi } from "../daemon/radios.js";
import { findVideoPreset, videoPresetNames } from "../recording/video-presets.js";
import {
  detectWifi,
  ifaceForIp,
  interfaceStatuses,
  sshServerIp,
} from "../hardware/network.js";

const USAGE =
  "usage: xorgate set <key> <value>   (supported: mode <sim|real>, gps-antenna <active|passive>, gps-fix-reset-policy <defer|veto-deadzone>, deadzone-profile <conservative|balanced|aggressive>, wifi <on|off> [--force], recording.<group>.<field> <value>, timeSync.<field> <value>)";

/** Parse an on/off/true/false/1/0 CLI value; undefined when unrecognizable. */
function parseBoolValue(v: string | undefined): boolean | undefined {
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return undefined;
}

/**
 * `xorgate set recording.<section>.<field> <value>` — validate one dotted path,
 * merge it into the persisted `recording` namespace, and let the running
 * worker's settings poll apply it live (~5 s; no restart).
 */
function setRecordingCommand(key: string, value: string | undefined): void {
  const parts = key.split(".");
  const [, section, field] = parts;
  // Per-camera enables are one level deeper: recording.video.cameras.<streamKey>.
  if (parts.length === 4 && section === "video" && field === "cameras") {
    setCameraEnable(key, parts[3], value);
    return;
  }
  if (parts.length !== 3 || !section || !field) {
    console.error(
      "recording keys are dotted paths, e.g. xorgate set recording.telemetry.enabled on",
    );
    process.exitCode = 1;
    return;
  }

  // Build a single-path patch, then push it through the same validator that
  // loadSettings uses so CLI writes can never persist something the daemon
  // would drop on read.
  let raw: unknown;
  const bool = parseBoolValue(value);
  const num = value !== undefined && value !== "" ? Number(value) : NaN;
  if (field === "enabled") {
    if (bool === undefined) {
      console.error(`${key} must be on|off, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = bool;
  } else if (field === "rateHz") {
    if (!Number.isFinite(num) || num < RECORDING_RATE_HZ_MIN || num > RECORDING_RATE_HZ_MAX) {
      console.error(
        `${key} must be a number in [${RECORDING_RATE_HZ_MIN}, ${RECORDING_RATE_HZ_MAX}], got '${value ?? ""}'`,
      );
      process.exitCode = 1;
      return;
    }
    raw = num;
  } else if (
    field === "segmentSeconds" ||
    field === "maxBytes" ||
    field === "minFreeBytes" ||
    field === "bootDeferMaxSecs" ||
    field === "bootDeferMinBudgetMa" ||
    field === "gpsGateMaxSecs" ||
    field === "gpsGateNoProgressSecs" ||
    field === "spawnStaggerSecs" ||
    field === "uvSamples" ||
    field === "uvWindowSecs" ||
    field === "railLowVolts" ||
    field === "railLowSecs" ||
    field === "escalateDwellSecs" ||
    field === "escalateDutyPct" ||
    field === "restoreSecs" ||
    field === "railRestoreVolts" ||
    field === "maxShedsPerHour" ||
    // Thermal trio: cloud-settable since the power-management plan but
    // CLI-invisible until now (settings-management plan, phase-4 §4).
    field === "cpuTempC" ||
    field === "cpuTempRestoreC" ||
    field === "cpuTempSecs"
  ) {
    if (!Number.isFinite(num) || num < 0) {
      console.error(`${key} must be a non-negative number, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = num;
  } else if (field === "bootDefer" || field === "gpsGate") {
    if (value !== "auto" && value !== "always" && value !== "off") {
      console.error(`${key} must be auto|always|off, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = value;
  } else if (field === "preset") {
    // Presets are a closed table (bounded CPU on a Pi with software-only
    // encoding); reject unknowns here with the list rather than letting the
    // agent silently fall back to the default.
    if (!value || !findVideoPreset(value)) {
      console.error(
        `${key} must be one of: ${videoPresetNames().join(", ")} (got '${value ?? ""}')`,
      );
      process.exitCode = 1;
      return;
    }
    raw = value;
  } else {
    raw = value; // string fields (mode) — validated below
  }

  const patch = parseRecordingSettings({ [section]: { [field]: raw } });
  const patchedSection = patch?.[section as keyof RecordingSettings] as
    | Record<string, unknown>
    | undefined;
  if (!patchedSection || !(field in patchedSection)) {
    console.error(`unknown or invalid recording setting '${key}' = '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const settings: AgentSettings = { ...loadSettings() };
  const current = settings.recording ?? {};
  settings.recording = {
    ...current,
    [section]: { ...(current[section as keyof RecordingSettings] as object | undefined), ...patchedSection },
  };
  saveSettings(settings);
  console.log(`✓ ${key} = ${JSON.stringify(patchedSection[field])} (persisted to settings.json)`);
  console.log("  the agent applies recording changes live within ~5 s (no restart needed)");
}

/**
 * `xorgate set recording.video.cameras.<streamKey> <on|off>` (Phase 6) — the
 * install-time capacity choice. `off` leaves that camera with no pipeline at
 * all; the value is merged into the map (other cameras untouched) and applied
 * live by the recording manager's 5 s poll.
 */
function setCameraEnable(key: string, streamKey: string, value: string | undefined): void {
  const bool = parseBoolValue(value);
  if (!STREAM_KEY_RE.test(streamKey)) {
    console.error(`'${streamKey}' is not a valid stream key (see kvs.json channels)`);
    process.exitCode = 1;
    return;
  }
  if (bool === undefined) {
    console.error(`${key} must be on|off, got '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const settings: AgentSettings = { ...loadSettings() };
  const recording = settings.recording ?? {};
  const video = recording.video ?? {};
  settings.recording = {
    ...recording,
    video: { ...video, cameras: { ...video.cameras, [streamKey]: bool } },
  };
  saveSettings(settings);
  console.log(`✓ ${key} = ${bool} (persisted to settings.json)`);
  console.log(
    bool
      ? "  the agent applies recording changes live within ~5 s (no restart needed)"
      : "  camera disabled: no capture, no live stream, no recording (live within ~5 s)",
  );
}

/**
 * `xorgate set timeSync.<field> <value>` — validate one offline-time-sync knob,
 * merge it into the persisted `timeSync` namespace, and let the worker's clock
 * stepper pick it up on its next tick (~30 s; no restart). Cloud-delivered
 * timeSync config overwrites local edits on the next retained delivery.
 */
function setTimeSyncCommand(key: string, value: string | undefined): void {
  const parts = key.split(".");
  const field = parts[1];
  if (parts.length !== 2 || !field) {
    console.error("timeSync keys are dotted paths, e.g. xorgate set timeSync.offlineSources off");
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  if (field === "offlineSources") {
    const bool = parseBoolValue(value);
    if (bool === undefined) {
      console.error(`${key} must be on|off, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = bool;
  } else if (field === "stepThresholdSecs" || field === "maxStepsPerBoot") {
    const num = value !== undefined && value !== "" ? Number(value) : NaN;
    if (!Number.isFinite(num) || num < 0) {
      console.error(`${key} must be a non-negative number, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = num;
  } else {
    console.error(
      `unknown timeSync setting '${key}' (supported: offlineSources, stepThresholdSecs, maxStepsPerBoot)`,
    );
    process.exitCode = 1;
    return;
  }

  // Same validator loadSettings uses, so CLI writes never persist something
  // the worker would drop on read (numbers come back clamped).
  const patch = parseTimeSyncSettings({ [field]: raw });
  const applied = patch?.[field as keyof TimeSyncSettings];
  if (patch === undefined || applied === undefined) {
    console.error(`unknown or invalid timeSync setting '${key}' = '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const settings: AgentSettings = { ...loadSettings() };
  settings.timeSync = { ...settings.timeSync, ...patch };
  saveSettings(settings);
  console.log(`✓ ${key} = ${JSON.stringify(applied)} (persisted to settings.json)`);
  console.log("  the agent's clock stepper reads it live within ~30 s (no restart needed)");
}

export async function setCommand(rest: string[]): Promise<void> {
  const noRestart = rest.includes("--no-restart");
  const force = rest.includes("--force");
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const key = positionals[0];
  const value = positionals[1];

  if (!key) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // WiFi is an OS-level runtime toggle: handle it before the settings.json path.
  if (key === "wifi") {
    await setWifiCommand(value, force);
    return;
  }

  // Recording keys are applied live by the worker's settings poll — no restart.
  if (key.startsWith("recording.")) {
    setRecordingCommand(key, value);
    return;
  }

  // timeSync keys are read live by the worker's clock stepper — no restart.
  if (key.startsWith("timeSync.")) {
    setTimeSyncCommand(key, value);
    return;
  }

  // Merge onto existing settings so toggling one key never clobbers the other.
  const next: AgentSettings = { ...loadSettings() };
  let applied: string;

  if (key === "mode") {
    if (value !== "sim" && value !== "real") {
      console.error(`mode must be 'sim' or 'real', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.mode = value;
    applied = `mode set to ${value}`;
  } else if (key === "media") {
    // Removed in Phase 4 of the settings-management plan (Q4). Answered
    // explicitly rather than falling into the generic "unknown setting" error,
    // because it lived in muscle memory and in older docs.
    console.error(
      "'media' was removed: turn cameras off individually instead, e.g. " +
        "xorgate set recording.video.cameras.cam0 off",
    );
    process.exitCode = 1;
    return;
  } else if (key === "gps-antenna") {
    if (value !== "active" && value !== "passive") {
      console.error(`gps-antenna must be 'active' or 'passive', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.gnssAntBias = value === "active";
    saveSettings(next);
    // No daemon restart: the sim7600-lte daemon polls settings.json and toggles
    // the antenna bias live (and asserts it at boot).
    console.log(
      `✓ GPS antenna set to ${value} (bias ${value === "active" ? "on" : "off"}, persisted to settings.json)`,
    );
    console.log("  the modem daemon applies it live within ~a minute (journalctl -u sim7600-lte)");
    return;
  } else if (key === "gps-fix-reset-policy") {
    if (value !== "defer" && value !== "veto-deadzone") {
      console.error(`gps-fix-reset-policy must be 'defer' or 'veto-deadzone', got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    next.lteRecovery = { ...next.lteRecovery, gpsFixResetPolicy: value };
    saveSettings(next);
    // No restart: the sim7600-lte daemon re-reads settings.json at each
    // recovery decision (CRESET gate / dead-zone nudge).
    console.log(`✓ GPS fix reset policy set to ${value} (persisted to settings.json)`);
    console.log("  the modem daemon reads it live at its next recovery decision (journalctl -u sim7600-lte)");
    return;
  } else if (key === "deadzone-profile") {
    if (value !== "conservative" && value !== "balanced" && value !== "aggressive") {
      console.error(
        `deadzone-profile must be 'conservative', 'balanced' or 'aggressive', got '${value ?? ""}'`,
      );
      process.exitCode = 1;
      return;
    }
    next.lteRecovery = { ...next.lteRecovery, deadZoneProfile: value };
    saveSettings(next);
    console.log(`✓ Dead-zone profile set to ${value} (persisted to settings.json)`);
    console.log("  the modem daemon reads it live at its next dead-zone nudge (journalctl -u sim7600-lte)");
    return;
  } else {
    console.error(
      `unknown setting '${key}' (supported: mode, gps-antenna, gps-fix-reset-policy, deadzone-profile, wifi, recording.*, timeSync.*)`,
    );
    process.exitCode = 1;
    return;
  }

  saveSettings(next);
  console.log(`✓ ${applied} (persisted to settings.json)`);

  if (noRestart) {
    console.log("  --no-restart: applies on the next daemon start");
    return;
  }

  const status = await inspect();
  if (status.kind !== "running") {
    console.log("  daemon not running — applies on next start (xorgate start)");
    return;
  }

  // Restart with the running daemon's own launch flags so identity/creds/offline
  // carry over; loadConfig re-reads settings.json for the new mode.
  const res = await restart(status.record.argv);
  if (res.ok) {
    console.log(`  restarted to apply (pid ${res.pid})`);
  } else {
    console.error(`  could not restart automatically: ${res.message}`);
    console.error("  on systemd installs, run: sudo systemctl restart xorgate-agent");
    process.exitCode = 1;
  }
}

/**
 * `xorgate set wifi <on|off> [--force]`. Toggles the WiFi device at runtime via
 * NetworkManager. Without `--force`, refuses to turn it off when doing so would
 * cut your own session — i.e. the WiFi device carries your SSH connection, or it
 * is currently the only interface with internet.
 */
async function setWifiCommand(value: string | undefined, force: boolean): Promise<void> {
  if (value !== "on" && value !== "off") {
    console.error(`wifi must be 'on' or 'off', got '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const wifi = await detectWifi();
  if (!wifi.present) {
    console.error("wifi: no WiFi adapter detected on this device");
    process.exitCode = 1;
    return;
  }
  const device = wifi.device ?? "wlan0";

  if (value === "off" && !force) {
    const sshIface = ifaceForIp(sshServerIp(process.env.SSH_CONNECTION));
    const overSsh = sshIface === device;
    const online = (await interfaceStatuses()).filter((s) => s.state === "online");
    const onlyUplink = online.length === 1 && online[0].name === device;
    if (overSsh || onlyUplink) {
      const why = overSsh
        ? `your SSH session is over ${device}`
        : `${device} is currently your only internet connection`;
      console.error(`refusing to turn WiFi off: ${why}.`);
      console.error("re-run with --force if you're sure (you may lose connectivity).");
      process.exitCode = 1;
      return;
    }
  }

  const res = await setWifi(value === "on");
  if (res.ok) {
    console.log(`✓ ${res.message}`);
  } else {
    console.error(res.message);
    process.exitCode = 1;
  }
}
