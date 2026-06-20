import { Box, Text } from "ink";
import { Panel } from "../Panel.js";
import type { ActivityEvent } from "../../agent/telemetry.js";

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

export function ActivityPanel({
  events,
  maxLines = 6,
}: {
  events: ActivityEvent[];
  maxLines?: number;
}) {
  const tail = events.slice(-maxLines);
  return (
    <Panel title="Activity" flexGrow={2}>
      <Box flexDirection="column">
        {tail.length === 0 ? (
          <Text color="gray" dimColor>
            (no events yet)
          </Text>
        ) : (
          tail.map((e, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color="gray">{clock(e.ts)} </Text>
              <Text color={LEVEL_COLOR[e.level]}>{e.msg}</Text>
            </Text>
          ))
        )}
      </Box>
    </Panel>
  );
}
