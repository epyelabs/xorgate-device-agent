/**
 * Telemetry "modules" for the master-detail monitor (argus-cli style): each has
 * a compact one-line status for the left sidebar and a full detail view for the
 * right pane. All are pure renderers of the daemon's state snapshot.
 */
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { LevelMeter } from "../components/LevelMeter.js";
import { type Status } from "../components/StatusBadge.js";
import { signedFixed, toHexAddr } from "../lib/format.js";
import { gauge, leaf } from "./format.js";
import {
  detectModem,
  readModemTelemetry,
  type ModemPresence,
  type ModemTelemetry,
} from "../hardware/modem.js";
import { detectImu, IMU, type ImuDetect } from "../hardware/imu.js";
import { GPS_NMEA_PORT } from "../hardware/gps.js";
import type { WifiPresence } from "../hardware/network.js";
import type {
  ActivityEvent,
  MediaStream,
  MetricLeaf,
  RunMode,
  StateSnapshot,
} from "../agent/telemetry.js";

export interface ModuleStatus {
  label: string;
  status: Status;
}

export interface DetailProps {
  snapshot: StateSnapshot | null;
  now: number;
}

export interface Module {
  id: string;
  title: string;
  status: (s: StateSnapshot | null) => ModuleStatus;
  Detail: React.FC<DetailProps>;
}

const UNKNOWN: ModuleStatus = { label: "…", status: "unknown" };
const val = (l?: MetricLeaf): number | undefined =>
  typeof l?.value === "number" ? l.value : undefined;
const axis = (l?: MetricLeaf): string => (val(l) !== undefined ? signedFixed(l!.value, 3) : "—");
const angle = (l?: MetricLeaf): string => (val(l) !== undefined ? `${signedFixed(l!.value, 1)}°` : "—");
const coord = (l?: MetricLeaf): string => (val(l) !== undefined ? l!.value.toFixed(6) : "—");
const FIX_QUALITY: Record<number, string> = { 0: "none", 1: "GPS", 2: "DGPS" };
const fixLabel = (l?: MetricLeaf): string => {
  const v = val(l);
  return v === undefined ? "—" : (FIX_QUALITY[v] ?? String(v));
};
/** Daemon link status → text color. */
const LINK_COLOR: Record<string, string> = {
  connected: "green",
  connecting: "yellow",
  disconnected: "yellow",
  dead_zone: "red",
};
/** Daemon gnss.health → text color (taxonomy: lte_gnss_recovery Phase 5). */
const GNSS_HEALTH_COLOR: Record<string, string> = {
  ok: "green",
  acquiring: "yellow",
  degraded: "yellow",
  unhealthy: "red",
};

function DetailTitle({ children }: { children: React.ReactNode }) {
  return (
    <Box marginBottom={1}>
      <Text bold color="cyan">
        {children}
      </Text>
    </Box>
  );
}

function NoData() {
  return <Text color="gray">no data yet</Text>;
}

/**
 * IMU detail — probes the I2C bus on-demand (argus-cli style): i2cdetect runs
 * once when this pane opens (real mode only), never on the worker's hot path.
 * i2c probing is read-only and safe to run alongside the worker's reader.
 * Motion data below comes from the live snapshot metrics.
 */
function ImuDetail({ snapshot }: DetailProps) {
  const m = snapshot?.latest?.metrics?.imu;
  const real = snapshot?.mode === "real";
  const [detect, setDetect] = useState<ImuDetect | null>(null);

  useEffect(() => {
    if (!real) return;
    let alive = true;
    void detectImu().then((d) => alive && setDetect(d)); // i2cdetect once on open
    return () => {
      alive = false;
    };
  }, [real]);

  const addrList = IMU.addresses.map((a) => toHexAddr(a)).join(" / ");

  return (
    <Box flexDirection="column">
      <DetailTitle>IMU · orientation + acceleration</DetailTitle>

      {real ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Sensor</Text>
          {!detect ? (
            <Text>
              <Spinner type="dots" /> detecting (i2cdetect)…
            </Text>
          ) : !detect.available ? (
            <Text color="red">⚠ {detect.reason}</Text>
          ) : detect.imuPresent && detect.imuAddress !== null ? (
            <Text>
              <Text color="green">● </Text>
              BNO085 @ {addrList} — present (found at {toHexAddr(detect.imuAddress)})
            </Text>
          ) : (
            <Text color="red">
              ● BNO085 @ {addrList} — not detected on I2C bus {IMU.i2cBus}
            </Text>
          )}
        </Box>
      ) : null}

      {m ? (
        <Box flexDirection="column">
          <Text>
            <Text color="gray">quat </Text>r {axis(m.quat_r)} i {axis(m.quat_i)} j{" "}
            {axis(m.quat_j)} k {axis(m.quat_k)}
          </Text>
          <Text>
            <Text color="gray">euler </Text>roll {angle(m.euler_roll)} pitch{" "}
            {angle(m.euler_pitch)} yaw {angle(m.euler_yaw)}
          </Text>
          <Text>
            <Text color="gray">accel </Text>x {axis(m.accel_x)} y {axis(m.accel_y)} z{" "}
            {axis(m.accel_z)} <Text color="gray">m/s²</Text>
          </Text>
        </Box>
      ) : real ? (
        <Text color="gray">no samples yet</Text>
      ) : (
        <NoData />
      )}
    </Box>
  );
}

const imu: Module = {
  id: "imu",
  title: "IMU",
  status: (s) => {
    const yaw = val(s?.latest?.metrics?.imu?.euler_yaw);
    return yaw === undefined ? UNKNOWN : { label: `yaw ${yaw.toFixed(0)}°`, status: "ok" };
  },
  Detail: ImuDetail,
};

const gps: Module = {
  id: "gps",
  title: "GPS",
  status: (s) => {
    const g = s?.latest?.metrics?.gps;
    const lat = val(g?.lat);
    const lon = val(g?.lon);
    if (lat !== undefined && lon !== undefined) {
      return { label: `${lat.toFixed(2)},${lon.toFixed(2)}`, status: "ok" };
    }
    // Group present without a position = NMEA streaming but no lock yet.
    if (g) return { label: "acquiring", status: "warn" };
    return UNKNOWN;
  },
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.gps;
    const hasFix = val(m?.lat) !== undefined && val(m?.lon) !== undefined;
    return (
      <Box flexDirection="column">
        <DetailTitle>GPS · position</DetailTitle>
        <Text color="gray">NMEA on {GPS_NMEA_PORT}</Text>
        {hasFix ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">lat </Text>
              {coord(m?.lat)}
            </Text>
            <Text>
              <Text color="gray">lon </Text>
              {coord(m?.lon)}
            </Text>
            <Text color="gray">
              alt {leaf(m?.alt, 1)} · speed {leaf(m?.speed, 1)}
            </Text>
            <Text color="gray">
              sats {leaf(m?.satellites, 0)}/{leaf(m?.satellites_in_view, 0)} in view · hdop{" "}
              {leaf(m?.hdop, 1)} · fix {fixLabel(m?.fix_quality)}
              {val(m?.ttff_s) !== undefined ? ` · ttff ${leaf(m?.ttff_s, 1)}s` : ""}
            </Text>
          </Box>
        ) : m ? (
          // metrics.gps present (fix_quality emitted) but no lock — NMEA is
          // streaming, just no satellites yet (e.g. indoors).
          <Box flexDirection="column">
            <Text color="yellow">○ Receiving NMEA but no position fix yet.</Text>
            <Text color="gray">
              sats {leaf(m?.satellites, 0)}/{leaf(m?.satellites_in_view, 0)} in view · waiting
              for satellite lock.
            </Text>
          </Box>
        ) : (
          <Text color="gray">○ no NMEA — waiting for GNSS stream.</Text>
        )}
      </Box>
    );
  },
};

/**
 * LTE detail — the one pane that probes hardware on-demand (argus-cli style):
 * detection runs only while this pane is mounted (i.e. selected in `manage`),
 * never on the worker's telemetry path. lsusb fires once on open; the daemon's
 * link JSON is polled lightly while the pane stays open. rssi/quality come from
 * the live snapshot metrics. Sim mode skips probing and just shows the bar.
 */
function LteDetail({ snapshot }: DetailProps) {
  const m = snapshot?.latest?.metrics?.lte;
  const real = snapshot?.mode === "real";
  const [modem, setModem] = useState<ModemPresence | null>(null);
  const [link, setLink] = useState<ModemTelemetry | null>(null);

  useEffect(() => {
    if (!real) return;
    let alive = true;
    void detectModem().then((d) => alive && setModem(d)); // lsusb once on open
    const poll = (): void => {
      void readModemTelemetry().then((t) => alive && setLink(t));
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [real]);

  return (
    <Box flexDirection="column">
      <DetailTitle>LTE · cellular signal</DetailTitle>

      {real ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Modem</Text>
          {!modem ? (
            <Text>
              <Spinner type="dots" /> detecting (lsusb)…
            </Text>
          ) : modem.present ? (
            <Box flexDirection="column">
              <Text>
                <Text color="green">● </Text>
                Present{modem.usbId ? ` — ${modem.usbId}` : ""}
                {modem.description ? <Text color="gray"> {modem.description}</Text> : null}
              </Text>
              <Text color="gray">
                ports: {modem.ttyPorts.length ? modem.ttyPorts.join(" ") : "none"}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="red">● not detected on USB</Text>
              {modem.ttyPorts.length ? (
                <Text color="gray">ports: {modem.ttyPorts.join(" ")}</Text>
              ) : null}
            </Box>
          )}
        </Box>
      ) : null}

      <Text bold>
        Signal &amp; link
        {link ? <Text color="gray"> (live from daemon)</Text> : null}
      </Text>
      {link ? <Text color={LINK_COLOR[link.status] ?? "white"}>● {link.status}</Text> : null}
      {m ? (
        <Box flexDirection="column">
          <Text>
            <Text color="gray">rssi </Text>
            {leaf(m.rssi, 0)}
            <Text color="gray"> · quality </Text>
            {leaf(m.quality, 0)}
          </Text>
          <Box marginTop={1}>
            <LevelMeter level={gauge(m.quality.value, 0, 31)} width={24} label="signal" />
          </Box>
        </Box>
      ) : link ? (
        <Text color="gray">waiting for signal…</Text>
      ) : real ? (
        <Text color="gray">no telemetry yet</Text>
      ) : (
        <NoData />
      )}
      {link ? (
        <Text color="gray">
          {link.iface} · ip {link.ip ?? "—"} · {link.timestamp}
        </Text>
      ) : null}
      {link?.gnss || link?.recovery ? (
        // GNSS/recovery observability from the daemon file (lte_gnss_recovery
        // Phase 5). health is last-knowledge — stale while LTE is down.
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="gray">gnss </Text>
            <Text color={GNSS_HEALTH_COLOR[link.gnss?.health ?? ""] ?? "gray"}>
              {link.gnss?.health ?? "unknown"}
            </Text>
            <Text color="gray">
              {typeof link.gnss?.ttff_s === "number" ? ` · ttff ${link.gnss.ttff_s}s` : ""}
              {link.gnss?.standalone_fallback ? " · standalone fallback" : ""}
            </Text>
          </Text>
          <Text color="gray">
            resets 24h {link.recovery?.resets_24h ?? 0}
            {link.recovery?.last_reset
              ? ` · last ${link.recovery.last_reset.path} @ ${link.recovery.last_reset.ts}`
              : " · no reset this run"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

const lte: Module = {
  id: "lte",
  title: "LTE",
  status: (s) => {
    const rssi = val(s?.latest?.metrics?.lte?.rssi);
    const q = val(s?.latest?.metrics?.lte?.quality);
    if (rssi === undefined) return UNKNOWN;
    const status: Status = q === undefined ? "unknown" : q >= 15 ? "ok" : q >= 10 ? "warn" : "error";
    return { label: `rssi ${rssi}`, status };
  },
  Detail: LteDetail,
};

const system: Module = {
  id: "system",
  title: "System",
  status: (s) => {
    const cpu = val(s?.latest?.metrics?.system?.cpu_usage);
    if (cpu === undefined) return UNKNOWN;
    const status: Status = cpu < 70 ? "ok" : cpu < 90 ? "warn" : "error";
    return { label: `cpu ${Math.round(cpu)}%`, status };
  },
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.system;
    return (
      <Box flexDirection="column">
        <DetailTitle>System · device health</DetailTitle>
        {m ? (
          <Box flexDirection="column">
            <LevelMeter level={gauge(m.cpu_usage.value, 0, 100)} width={24} label="cpu " />
            <LevelMeter level={gauge(m.ram_usage.value, 0, 100)} width={24} label="ram " />
            <LevelMeter level={gauge(m.disk_usage.value, 0, 100)} width={24} label="disk" />
            <Text color="gray">temp {leaf(m.cpu_temp, 1)}</Text>
          </Box>
        ) : (
          <NoData />
        )}
      </Box>
    );
  },
};

/** KVS master per-channel lifecycle state → text color. */
const STREAM_STATE_COLOR: Record<MediaStream["state"], string> = {
  starting: "yellow",
  running: "green",
  retrying: "yellow",
  failed: "red",
  stopped: "gray",
};

const media: Module = {
  id: "media",
  title: "Media",
  status: (s) => {
    const md = s?.latest?.media;
    if (!md) return UNKNOWN;
    if (md.streams.length === 0) {
      const live = md.kvs.value || md.recording.value;
      return { label: live ? "live" : "idle", status: live ? "ok" : "unknown" };
    }
    const running = md.streams.filter((x) => x.state === "running").length;
    const failed = md.streams.some((x) => x.state === "failed");
    if (running > 0) return { label: `${running}/${md.streams.length} live`, status: "ok" };
    if (failed) return { label: "failed", status: "error" };
    return { label: "starting", status: "warn" };
  },
  Detail: ({ snapshot }) => {
    const md = snapshot?.latest?.media;
    return (
      <Box flexDirection="column">
        <DetailTitle>Media · KVS WebRTC</DetailTitle>
        {md ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">KVS </Text>
              {md.kvs.value ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
              <Text color="gray"> · recording </Text>
              {md.recording.value ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
            </Text>
            {md.streams.length === 0 ? (
              <Text color="gray" dimColor>
                no channels (run `xorgate set media on`, then check kvs.json)
              </Text>
            ) : (
              md.streams.map((stream) => (
                <Text key={stream.channelName} wrap="truncate-end">
                  <Text color={STREAM_STATE_COLOR[stream.state]}>● </Text>
                  <Text color="white">{stream.streamKey}</Text>
                  <Text color="gray"> {stream.channelName} </Text>
                  <Text color={STREAM_STATE_COLOR[stream.state]}>{stream.state}</Text>
                </Text>
              ))
            )}
          </Box>
        ) : (
          <NoData />
        )}
      </Box>
    );
  },
};

/**
 * Settings detail — the one interactive pane. A small form: run mode (sim/real)
 * and the WiFi radio. Key handling (move row, toggle value, apply + restart)
 * lives in MonitorApp, which passes the in-progress choices, the focused `row`,
 * and the `operating` flag down. Extra props are optional so this still
 * satisfies the generic `Module.Detail` (React.FC<DetailProps>) signature.
 *
 * The KVS media row was removed with the `mediaEnabled` setting
 * (settings-management plan, Phase 4): cameras are now turned off individually,
 * from the cloud or `xorgate set recording.video.cameras.<key> off`.
 */
interface SettingsDetailProps extends DetailProps {
  modeChoice?: RunMode;
  /** Focused row while operating: 0 = run mode, 1 = wifi. */
  row?: number;
  operating?: boolean;
  /** Live WiFi presence/state for the wifi row (null while probing). */
  wifi?: WifiPresence | null;
  wifiBusy?: boolean;
  /** True after a risky first toggle press, asking to confirm the cutoff. */
  wifiConfirm?: boolean;
}

export function SettingsDetail({
  snapshot,
  modeChoice,
  row = 0,
  operating,
  wifi,
  wifiBusy,
  wifiConfirm,
}: SettingsDetailProps) {
  const curMode = snapshot?.mode ?? "sim";
  const valMode = operating ? (modeChoice ?? curMode) : curMode;

  const rows = [{ label: "run mode", value: valMode, changed: valMode !== curMode }];

  return (
    <Box flexDirection="column">
      <DetailTitle>Settings</DetailTitle>
      <Text color="gray">Run mode (sim/real) and the WiFi radio.</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) => {
          const focused = !!operating && row === i;
          return (
            <Text key={r.label} color={focused ? "cyan" : "white"}>
              {focused ? "▶ " : "  "}
              <Text color="gray">{r.label.padEnd(9)}</Text> {r.value}
              {r.changed ? (
                <Text color="yellow" dimColor>
                  {" *"}
                </Text>
              ) : null}
            </Text>
          );
        })}
        <WifiRow
          wifi={wifi}
          focused={!!operating && row === rows.length}
          busy={!!wifiBusy}
          confirm={!!wifiConfirm}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {operating
            ? row === rows.length
              ? "↑↓ field · space/↵ toggle wifi · ←/q back"
              : "↑↓ field · space toggle · ↵ apply & restart · ←/q back"
            : "↵ to edit settings"}
        </Text>
      </Box>
    </Box>
  );
}

/** Settings row for the WiFi radio: live on/off, "not present", or "applying…". */
function WifiRow({
  wifi,
  focused,
  busy,
  confirm,
}: {
  wifi?: WifiPresence | null;
  focused: boolean;
  busy: boolean;
  confirm: boolean;
}) {
  if (wifi && !wifi.present) {
    return (
      <Text color="gray" dimColor>
        {"  "}
        {"wifi".padEnd(9)} — not present
      </Text>
    );
  }
  const value = !wifi ? "…" : busy ? "applying…" : wifi.enabled ? "on" : "off";
  return (
    <Text color={focused ? "cyan" : "white"}>
      {focused ? "▶ " : "  "}
      <Text color="gray">{"wifi".padEnd(9)}</Text> {value}
      {confirm ? (
        <Text color="yellow"> · press again to confirm cutoff</Text>
      ) : null}
    </Text>
  );
}

const settings: Module = {
  id: "settings",
  title: "Settings",
  status: (s) => (s?.mode ? { label: s.mode, status: "ok" } : UNKNOWN),
  Detail: SettingsDetail,
};

const LEVEL_COLOR: Record<ActivityEvent["level"], string> = {
  info: "gray",
  warn: "yellow",
  error: "red",
};

function clock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

const activity: Module = {
  id: "activity",
  title: "Activity",
  status: (s) => {
    const events = s?.recentEvents ?? [];
    if (events.length === 0) return UNKNOWN;
    const last = events[events.length - 1];
    const status: Status = last.level === "error" ? "error" : last.level === "warn" ? "warn" : "ok";
    return { label: `${events.length} ev`, status };
  },
  Detail: ({ snapshot }) => {
    const events = (snapshot?.recentEvents ?? []).slice(-14);
    return (
      <Box flexDirection="column">
        <DetailTitle>Activity · recent events</DetailTitle>
        {events.length === 0 ? (
          <Text color="gray" dimColor>
            (no events yet)
          </Text>
        ) : (
          events.map((e, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color="gray">{clock(e.ts)} </Text>
              <Text color={LEVEL_COLOR[e.level]}>{e.msg}</Text>
            </Text>
          ))
        )}
      </Box>
    );
  },
};

/** Sidebar order = navigation order. */
export const MODULES: Module[] = [activity, system, lte, gps, imu, media, settings];
