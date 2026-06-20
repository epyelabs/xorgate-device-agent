import { Text } from "ink";
import { Panel } from "../Panel.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { TelemetryMedia } from "../../agent/telemetry.js";

export function MediaPanel({ media }: { media?: TelemetryMedia }) {
  const kvs = media?.kvs.value ?? false;
  const rec = media?.recording.value ?? false;
  const streams = media?.streams.length ?? 0;
  return (
    <Panel title="Media" flexGrow={1}>
      <StatusBadge status={kvs ? "ok" : "unknown"}>KVS {kvs ? "on" : "off"}</StatusBadge>
      <StatusBadge status={rec ? "ok" : "unknown"}>rec {rec ? "on" : "off"}</StatusBadge>
      <Text color="gray">streams {streams}</Text>
    </Panel>
  );
}
