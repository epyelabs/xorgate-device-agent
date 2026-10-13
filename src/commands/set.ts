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
 *
 * `obd.*` keys (obd2-bluetooth-integration P3) are read live by the OBD
 * collector each tick (~1 s; no restart). Cloud-delivered `obd` config
 * overwrites local edits on the next retained delivery, and a local edit is
 * reported back to the cloud as a local change like every other namespace:
 *   obd.enabled <on|off>            obd.adapter <AA:BB:CC:DD:EE:FF|none>
 *   obd.pin <4-6 digits>            obd.poll-hz <0.2-2>
 *   obd.fields <csv|all>            obd.power-source <switched|constant>
 * (`xorgate obd scan` lists candidate MACs; nothing here ever pairs by name.)
 *
 * `cameraMount.<streamKey>.rotationDeg <0|180>` (cam-sensor-level-rotate plan)
 * is the odd one out: the worker's reconciler picks it up within a minute and
 * edits the `rotation` parameter on that camera's `dtoverlay=` line in
 * /boot/firmware/config.txt, which the sensor only reads at boot. So this one
 * needs a REBOOT — the agent will never do it for you, by design.
 */
import {
  APN_RE,
  loadSettings,
  OBD_POLL_HZ_MAX,
  OBD_POLL_HZ_MIN,
  parseCameraMountSettings,
  parseObdSettings,
  parseRecordingSettings,
  parseTimeSyncSettings,
  saveSettings,
  settingsPath,
  RECORDING_RATE_HZ_MAX,
  RECORDING_RATE_HZ_MIN,
  STREAM_KEY_RE,
  type AgentSettings,
  type CameraRotationDeg,
  type ObdSettings,
  type RecordingSettings,
  type TimeSyncSettings,
} from "../daemon/settings.js";
import { parseApnTelemetry } from "../agent/config-sync.js";
import { readModemTelemetry } from "../hardware/modem.js";
import type { ModemCellularTelemetry } from "../hardware/modem.js";
import { pidPath, runtimeHome } from "../daemon/runtime.js";
import { fileOwner, isRoot, usernameForUid } from "../lib/privilege.js";
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
  "usage: xorgate set <key> <value>   (supported: mode <sim|real>, gps-antenna <active|passive>, gps-fix-reset-policy <defer|veto-deadzone>, deadzone-profile <conservative|balanced|aggressive>, apn <value|\"\"> [--no-wait], wifi <on|off> [--force], recording.<group>.<field> <value>, timeSync.<field> <value>, cameraMount.<streamKey>.rotationDeg <0|180>, obd.<enabled|adapter|pin|poll-hz|fields|power-source> <value>)";

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
 * `xorgate set cameraMount.<streamKey>.rotationDeg <0|180>` — declare that a
 * camera is mounted upside down (or is not).
 *
 * Writes settings.json only. The worker's boot-config reconciler is the single
 * writer of config.txt (it needs root, via the xorgate-camrotate helper), and
 * it picks this up within a minute. The image itself does not change until the
 * device is REBOOTED, which the agent will never do on its own — so the note
 * printed here is the whole user-facing contract of this setting.
 */
function setCameraMountCommand(key: string, value: string | undefined): void {
  const parts = key.split(".");
  const [, streamKey, field] = parts;
  if (parts.length !== 3 || !streamKey || field !== "rotationDeg") {
    console.error(
      "cameraMount keys are dotted paths, e.g. xorgate set cameraMount.cam0.rotationDeg 180",
    );
    process.exitCode = 1;
    return;
  }
  if (!STREAM_KEY_RE.test(streamKey)) {
    console.error(`'${streamKey}' is not a valid stream key (see kvs.json channels)`);
    process.exitCode = 1;
    return;
  }
  if (value !== "0" && value !== "180") {
    console.error(`${key} must be 0 or 180, got '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }
  const rotationDeg: CameraRotationDeg = value === "180" ? 180 : 0;

  // Same validator loadSettings uses, so a CLI write can never persist
  // something the worker would drop on read.
  const patch = parseCameraMountSettings({ cameras: { [streamKey]: { rotationDeg } } });
  if (!patch?.cameras?.[streamKey]) {
    console.error(`unknown or invalid cameraMount setting '${key}' = '${value ?? ""}'`);
    process.exitCode = 1;
    return;
  }

  const settings: AgentSettings = { ...loadSettings() };
  const current = settings.cameraMount?.cameras ?? {};
  settings.cameraMount = { cameras: { ...current, [streamKey]: { rotationDeg } } };
  saveSettings(settings);
  console.log(`✓ ${key} = ${rotationDeg} (persisted to settings.json)`);
  console.log(
    "  the agent updates the camera overlay in /boot/firmware/config.txt within ~a minute,",
  );
  console.log(
    "  then a REBOOT is required before the image changes (the agent never reboots itself).",
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

/** The CLI spelling of each `obd` namespace field (plan D3: `xorgate set obd.adapter <MAC>`). */
const OBD_CLI_KEYS: Readonly<Record<string, keyof ObdSettings>> = {
  enabled: "enabled",
  adapter: "adapterMac",
  adapterMac: "adapterMac",
  pin: "pin",
  "poll-hz": "pollHz",
  pollHz: "pollHz",
  fields: "fields",
  "power-source": "powerSource",
  powerSource: "powerSource",
};

/**
 * `xorgate set obd.<field> <value>` — validate one field through the SAME
 * parser loadSettings uses (so the CLI can never persist what the collector
 * would drop), merge it into the persisted `obd` namespace, and let the
 * collector's 1 s settings poll apply it (restarting the helper when the
 * adapter/PIN/rate/fields/power source moved). Exported for tests.
 */
export function setObdCommand(key: string, value: string | undefined): void {
  const parts = key.split(".");
  const field = parts.length === 2 ? OBD_CLI_KEYS[parts[1] ?? ""] : undefined;
  if (!field) {
    console.error(
      `unknown obd setting '${key}' (supported: obd.enabled, obd.adapter, obd.pin, obd.poll-hz, obd.fields, obd.power-source)`,
    );
    process.exitCode = 1;
    return;
  }
  let raw: unknown;
  if (field === "enabled") {
    const bool = parseBoolValue(value);
    if (bool === undefined) {
      console.error(`${key} must be on|off, got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = bool;
  } else if (field === "adapterMac") {
    if (value === undefined || value === "" || value === "none" || value === "null") raw = null;
    else raw = value;
  } else if (field === "pollHz") {
    const num = value !== undefined && value !== "" ? Number(value) : NaN;
    if (!Number.isFinite(num) || num < OBD_POLL_HZ_MIN || num > OBD_POLL_HZ_MAX) {
      console.error(`${key} must be a number in [${OBD_POLL_HZ_MIN}, ${OBD_POLL_HZ_MAX}], got '${value ?? ""}'`);
      process.exitCode = 1;
      return;
    }
    raw = num;
  } else if (field === "fields") {
    raw = value === undefined || value === "" || value === "all" ? [] : value.split(",").map((f) => f.trim());
  } else {
    raw = value; // pin, powerSource: validated by the parser below
  }
  const patch = parseObdSettings({ [field]: raw });
  if (patch === undefined || !(field in patch)) {
    const hint =
      field === "adapterMac"
        ? " (expected AA:BB:CC:DD:EE:FF or none)"
        : field === "pin"
          ? " (expected 4 to 6 digits)"
          : field === "powerSource"
            ? " (expected switched|constant)"
            : field === "fields"
              ? " (expected a csv of field names, or all)"
              : "";
    console.error(`invalid obd setting '${key}' = '${value ?? ""}'${hint}`);
    process.exitCode = 1;
    return;
  }
  const settings: AgentSettings = { ...loadSettings() };
  settings.obd = { ...settings.obd, ...patch };
  saveSettings(settings);
  const shown = JSON.stringify((patch as Record<string, unknown>)[field]);
  console.log(`✓ ${key} = ${shown} (persisted to settings.json)`);
  console.log("  the agent's OBD collector reads it live within ~1 s (no restart needed; the helper restarts itself when the adapter changes)");
  if (field === "adapterMac" && patch.adapterMac && settings.obd.enabled !== true) {
    console.log("  note: obd.enabled is off — nothing is polled until: xorgate set obd.enabled on");
  }
}

/**
 * Say once that `sudo` is not needed here (settings-sync-hardening plan, phase
 * 1, Q1 → "warn and continue").
 *
 * Running the CLI as root used to leave settings.json `root:root` and lock the
 * unprivileged agent out of its own file. `atomicWriteJson` now hands ownership
 * back, so this is purely educational — it warns and the write proceeds
 * normally, because a refusal would break existing runbooks for no remaining
 * benefit.
 *
 * The agent's identity comes from the filesystem, in preference to shelling out
 * to `systemctl show xorgate-agent -p User`: the CLI has to keep working on a
 * non-systemd install. Nothing here throws — an install with no state dir yet
 * simply gets no note.
 */
function warnIfNeedlessSudo(): void {
  if (!isRoot()) return;
  const owner = fileOwner(pidPath()) ?? fileOwner(runtimeHome()) ?? fileOwner(settingsPath());
  if (!owner || owner.uid === 0) return; // agent runs as root too, or we can't tell
  const who = usernameForUid(owner.uid) ?? `uid ${owner.uid}`;
  console.error(`note: the xorgate agent runs as '${who}' — you don't need sudo for settings.`);
  console.error(`  writing anyway; settings.json keeps its '${who}' ownership.`);
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

  // Everything from here down writes settings.json. `wifi` is deliberately
  // above this line: it is an OS-level toggle that genuinely may need root.
  warnIfNeedlessSudo();

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

  // cameraMount keys are picked up by the worker's boot-config reconciler —
  // no restart, but a reboot before the picture changes.
  if (key.startsWith("cameraMount.")) {
    setCameraMountCommand(key, value);
    return;
  }

  // obd keys are read live by the OBD collector's settings poll — no restart.
  if (key.startsWith("obd.")) {
    setObdCommand(key, value);
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
  } else if (key === "apn") {
    await setApnCommand(value, rest.includes("--no-wait"));
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
      `unknown setting '${key}' (supported: mode, gps-antenna, gps-fix-reset-policy, deadzone-profile, apn, wifi, recording.*, timeSync.*, cameraMount.*, obd.*)`,
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

/** Poll cadence + overall patience for the APN outcome watch. */
const APN_WATCH_POLL_MS = 3000;
const APN_WATCH_MAX_MS = 8 * 60_000;
/** How long a silent telemetry file means "this daemon predates the feature". */
const APN_WATCH_OLD_DAEMON_MS = 90_000;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readApnBlock(): Promise<ModemCellularTelemetry | undefined> {
  const tel = await readModemTelemetry();
  return parseApnTelemetry(tel?.cellular);
}

/**
 * `xorgate set apn <value|"">` — the LOCAL path, and the one that actually
 * recovers a stranded device (Phase 2 §4c): on an LTE-only box a wrong APN
 * means no data, so no cloud, so the corrective setting can never arrive over
 * MQTT — a tech on site with SSH or console is the recovery story, and this is
 * their command.
 *
 * Same conduit as every sibling: write settings.json, the sim7600-lte daemon
 * polls it (~30 s) and applies with confirm-and-rollback; the agent's watcher
 * then reports the local change upstream so it becomes the cloud's desired
 * value instead of being reverted on reconnect.
 *
 * Unlike every other `set` key this one takes minutes to prove itself, so the
 * command WATCHES the outcome by default: a silent "✓ saved" that quietly
 * rolls back 90 s later is the worst possible ergonomics for someone standing
 * in a parking lot. `--no-wait` skips the watch; Ctrl-C is always safe (the
 * daemon's apply is autonomous).
 *
 * There is deliberately NO danger gate here: that guard exists to warn about
 * losing REMOTE access, and someone at the console has none to lose.
 */
async function setApnCommand(value: string | undefined, noWait: boolean): Promise<void> {
  if (value === undefined) {
    console.error('usage: xorgate set apn <value>   (or "" to leave the modem\'s stored APN alone)');
    process.exitCode = 1;
    return;
  }
  if (!APN_RE.test(value)) {
    console.error(
      `apn must be at most 100 letters, digits, dots or hyphens, got '${value}'`,
    );
    process.exitCode = 1;
    return;
  }

  const before = await readApnBlock();

  const next: AgentSettings = { ...loadSettings() };
  next.cellular = { ...next.cellular, apn: value };
  saveSettings(next);

  if (value === "") {
    console.log("✓ apn cleared (persisted to settings.json)");
    console.log("  the modem's stored APN is left untouched — nothing will be written to it");
    return;
  }
  console.log(`✓ apn = "${value}" (persisted to settings.json)`);

  if (before?.apn_applied === value && before.state === "in-force") {
    console.log("  already in force — the modem's data context holds this APN.");
    return;
  }
  if (before?.state === "rejected" && before.apn_requested === value) {
    console.error(
      `✗ this exact value has already failed ${before.fails ?? "several"} times and is rejected — ` +
        "the daemon will not retry it. Change the value to get another attempt.",
    );
    process.exitCode = 1;
    return;
  }
  if (noWait) {
    console.log(
      "  the modem daemon applies it with confirm-and-rollback within a few minutes " +
        "(journalctl -u sim7600-lte)",
    );
    return;
  }

  console.log(
    "  waiting for the modem daemon to apply and confirm (cellular will drop briefly; " +
      "Ctrl-C is safe — the apply continues on its own)...",
  );
  const started = Date.now();
  const baseline = JSON.stringify(before ?? null);
  let sawApplying = false;
  while (Date.now() - started < APN_WATCH_MAX_MS) {
    await sleepMs(APN_WATCH_POLL_MS);
    const cur = await readApnBlock();
    if (cur === undefined) {
      if (Date.now() - started > APN_WATCH_OLD_DAEMON_MS) {
        console.error(
          "✗ the modem daemon is not reporting any APN machinery — it likely predates this " +
            "feature and will NEVER apply the change. Update the agent (xorgate update).",
        );
        process.exitCode = 1;
        return;
      }
      continue;
    }
    // Only fresh news counts: a rolled-back/rejected verdict identical to the
    // pre-save block is history, not the outcome of THIS save.
    if (JSON.stringify(cur) === baseline) continue;
    if (cur.state === "applying" && cur.apn_requested === value) {
      if (!sawApplying) {
        console.log("  applying — confirming with real traffic over the cellular link...");
        sawApplying = true;
      }
      continue;
    }
    if (cur.state === "in-force" && cur.apn_applied === value) {
      console.log(`✓ confirmed: "${value}" is in force (data verified end-to-end).`);
      return;
    }
    if (cur.state === "rolled-back" && cur.apn_requested === value) {
      console.error(
        `✗ rolled back: "${value}" passed no traffic${cur.last_error ? ` (${cur.last_error})` : ""}. ` +
          `The device restored "${cur.apn_applied ?? "the previous APN"}" and is recovering. ` +
          `Attempt ${cur.fails ?? "?"}/${3}; the daemon retries the value until it is rejected.`,
      );
      process.exitCode = 1;
      return;
    }
    if (cur.state === "rejected" && cur.apn_requested === value) {
      console.error(
        `✗ rejected: "${value}" failed ${cur.fails ?? "too many"} times${cur.last_error ? ` (${cur.last_error})` : ""}. ` +
          "Change the value to get another attempt.",
      );
      process.exitCode = 1;
      return;
    }
  }
  console.log(
    "  no verdict after 8 minutes — the apply may be deferred (device unregistered?). " +
      "Watch journalctl -u sim7600-lte, or re-run `xorgate set apn` later.",
  );
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
