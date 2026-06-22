/**
 * Telemetry "modules" for the master-detail monitor (argus-cli style): each has
 * a compact one-line status for the left sidebar and a full detail view for the
 * right pane. All are pure renderers of the daemon's state snapshot.
 */
import { Box, Text } from "ink";
import { LevelMeter } from "../components/LevelMeter.js";
import { type Status } from "../components/StatusBadge.js";
import { signedFixed } from "../lib/format.js";
import { gauge, leaf } from "./format.js";
import type { ActivityEvent, MetricLeaf, RunMode, StateSnapshot } from "../agent/telemetry.js";

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

const imu: Module = {
  id: "imu",
  title: "IMU",
  status: (s) => {
    const yaw = val(s?.latest?.metrics?.imu?.euler_yaw);
    return yaw === undefined ? UNKNOWN : { label: `yaw ${yaw.toFixed(0)}°`, status: "ok" };
  },
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.imu;
    return (
      <Box flexDirection="column">
        <DetailTitle>IMU · orientation + acceleration</DetailTitle>
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
        ) : (
          <NoData />
        )}
      </Box>
    );
  },
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
        {!m ? (
          <NoData />
        ) : hasFix ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">lat </Text>
              {coord(m.lat)}
            </Text>
            <Text>
              <Text color="gray">lon </Text>
              {coord(m.lon)}
            </Text>
            <Text color="gray">
              alt {leaf(m.alt, 1)} · speed {leaf(m.speed, 1)}
            </Text>
            <Text color="gray">
              sats {leaf(m.satellites, 0)} · fix {fixLabel(m.fix_quality)}
            </Text>
          </Box>
        ) : (
          // NMEA is flowing (fix_quality is being parsed) but no position lock —
          // e.g. indoors. Distinct from the "no data yet" no-NMEA case above.
          <Box flexDirection="column">
            <Text color="yellow">acquiring fix · NMEA streaming</Text>
            <Text color="gray">
              sats {leaf(m.satellites, 0)} · fix {fixLabel(m.fix_quality)}
            </Text>
          </Box>
        )}
      </Box>
    );
  },
};

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
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.lte;
    return (
      <Box flexDirection="column">
        <DetailTitle>LTE · cellular signal</DetailTitle>
        {m ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">rssi </Text>
              {leaf(m.rssi, 0)}
            </Text>
            <Text>
              <Text color="gray">quality </Text>
              {leaf(m.quality, 0)}
            </Text>
            <Box marginTop={1}>
              <LevelMeter level={gauge(m.quality.value, 0, 31)} width={24} label="signal" />
            </Box>
          </Box>
        ) : (
          <NoData />
        )}
      </Box>
    );
  },
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

const media: Module = {
  id: "media",
  title: "Media",
  status: (s) => {
    const md = s?.latest?.media;
    if (!md) return UNKNOWN;
    const live = md.kvs.value || md.recording.value || md.streams.length > 0;
    return { label: live ? "live" : "idle", status: live ? "ok" : "unknown" };
  },
  Detail: ({ snapshot }) => {
    const md = snapshot?.latest?.media;
    return (
      <Box flexDirection="column">
        <DetailTitle>Media · streaming</DetailTitle>
        {md ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">KVS </Text>
              {md.kvs.value ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
            </Text>
            <Text>
              <Text color="gray">recording </Text>
              {md.recording.value ? <Text color="green">on</Text> : <Text color="gray">off</Text>}
            </Text>
            <Text color="gray">streams {md.streams.length}</Text>
          </Box>
        ) : (
          <NoData />
        )}
      </Box>
    );
  },
};

/**
 * Settings detail — the one interactive pane. It renders the run-mode chooser;
 * key handling (toggle + apply) lives in MonitorApp, which passes the in-progress
 * `choice` and `operating` flag down. Extra props are optional so this still
 * satisfies the generic `Module.Detail` (React.FC<DetailProps>) signature.
 */
interface SettingsDetailProps extends DetailProps {
  choice?: RunMode;
  operating?: boolean;
}

export function SettingsDetail({ snapshot, choice, operating }: SettingsDetailProps) {
  const current = snapshot?.mode ?? null;
  const highlight = operating ? (choice ?? current) : current;
  return (
    <Box flexDirection="column">
      <DetailTitle>Settings · run mode</DetailTitle>
      <Text color="gray">Synthetic telemetry (sim) vs. real hardware collectors (real).</Text>
      <Box marginTop={1} flexDirection="column">
        {(["sim", "real"] as const).map((m) => {
          const on = m === highlight;
          return (
            <Text key={m} color={on ? "cyan" : "white"}>
              {on ? "▶ " : "  "}
              {m}
              {m === current ? <Text color="green"> ● active</Text> : null}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {operating ? "↑↓ choose · ↵ apply & restart · ←/q back" : "↵ to change the run mode"}
        </Text>
      </Box>
    </Box>
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
