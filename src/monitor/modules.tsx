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
import type { ActivityEvent, MetricLeaf, StateSnapshot } from "../agent/telemetry.js";

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
const coord = (l?: MetricLeaf): string => (val(l) !== undefined ? l!.value.toFixed(6) : "—");

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
    const z = val(s?.latest?.metrics?.imu?.z);
    return z === undefined ? UNKNOWN : { label: `z ${z.toFixed(1)}`, status: "ok" };
  },
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.imu;
    return (
      <Box flexDirection="column">
        <DetailTitle>IMU · linear acceleration</DetailTitle>
        {m ? (
          <Box flexDirection="column">
            <Text>
              <Text color="gray">x </Text>
              {axis(m.x)} <Text color="gray">m/s²</Text>
            </Text>
            <Text>
              <Text color="gray">y </Text>
              {axis(m.y)} <Text color="gray">m/s²</Text>
            </Text>
            <Text>
              <Text color="gray">z </Text>
              {axis(m.z)} <Text color="gray">m/s²</Text>
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
    const lat = val(s?.latest?.metrics?.gps?.lat);
    const lon = val(s?.latest?.metrics?.gps?.lon);
    return lat === undefined || lon === undefined
      ? UNKNOWN
      : { label: `${lat.toFixed(2)},${lon.toFixed(2)}`, status: "ok" };
  },
  Detail: ({ snapshot }) => {
    const m = snapshot?.latest?.metrics?.gps;
    return (
      <Box flexDirection="column">
        <DetailTitle>GPS · position</DetailTitle>
        {m ? (
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
          </Box>
        ) : (
          <NoData />
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
export const MODULES: Module[] = [activity, system, lte, gps, imu, media];
