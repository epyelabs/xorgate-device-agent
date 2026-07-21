/**
 * `xorgate status` — rich, scriptable status. Exits non-zero when the daemon is
 * not running so callers can branch on `$?`.
 */
import { accessSync, constants } from "node:fs";
import { inspect, type DaemonStatus } from "../daemon/manager.js";
import { logPath, runtimeHome } from "../daemon/runtime.js";
import { ageLabel, formatBytes, uptimeLabel } from "../lib/format.js";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const gray = (s: string) => c("90", s);
const dim = (s: string) => c("2", s);

/** True when XORGATE_HOME exists but isn't readable by us (EACCES), not absent. */
function homePermissionDenied(): boolean {
  try {
    accessSync(runtimeHome(), constants.R_OK | constants.X_OK);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EACCES";
  }
}

export async function statusCommand(): Promise<void> {
  const now = Date.now();
  const st = await inspect(now);
  print(st, now);
  process.exitCode = st.kind === "running" ? 0 : 1;
}

function print(st: DaemonStatus, now: number): void {
  if (st.kind === "stopped") {
    // Distinguish "genuinely not running" from "running but its state dir is
    // owned by another user we can't read" (e.g. a root-managed systemd agent
    // inspected by a non-root user). The latter must NOT advise `xorgate start`
    // — that would spawn a second worker fighting the running one.
    if (homePermissionDenied()) {
      console.log(
        `${yellow("○")} unreadable ${dim(`— ${runtimeHome()} is owned by another user`)}`,
      );
      console.log(dim(`  the agent likely runs under systemd as root — try: sudo xorgate status`));
      return;
    }
    console.log(`${gray("○")} stopped ${dim("— daemon not running")}`);
    console.log(dim(`  start it with: xorgate start`));
    return;
  }

  if (st.kind === "stale") {
    const why = st.reason === "pid-reused" ? "pid was recycled" : "process is gone";
    console.log(`${yellow("◌")} stale ${dim(`— pidfile for pid ${st.record.pid}, but ${why}`)}`);
    console.log(dim(`  it will be cleaned on the next start/stop`));
    return;
  }

  const { record, identity, state, stateFresh } = st;
  const idNote =
    identity === "verified"
      ? gray("(identity verified)")
      : yellow("(identity unverified — ps unavailable)");
  console.log(
    `${green("●")} running   pid ${record.pid}   up ${uptimeLabel(now - record.startedAt)}   ${idNote}`,
  );
  console.log(
    `  device     ${record.deviceId}   mode ${record.mode}   rate ${record.rateHz} Hz${
      record.offline ? gray("   offline") : ""
    }`,
  );

  if (state) {
    console.log(`  endpoint   ${state.endpoint}`);
    const connColor = state.connection === "connected" ? green : yellow;
    console.log(
      `  connection ${connColor(state.connection)}   ${gray(
        `since ${ageLabel(state.connectionSince, now)}`,
      )}`,
    );
    const last = state.lastPublishAt ? ageLabel(state.lastPublishAt, now) : "never";
    const fresh = stateFresh ? gray("(fresh)") : yellow("(stale — worker may be wedged)");
    console.log(
      `  telemetry  seq ${state.seq}  published ${state.published}  errors ${state.publishErrors}  last ${last}  ${fresh}`,
    );
    if (state.recording) {
      const r = state.recording;
      if (r.enabled) {
        const session = r.sessionId ? `session ${r.sessionId.slice(0, 8)}…` : "";
        const backlog = `backlog ${r.backlogSegments} seg / ${formatBytes(r.backlogBytes)}`;
        const dropped = r.droppedSegments > 0 ? `  ${yellow(`dropped ${r.droppedSegments}`)}` : "";
        console.log(`  recording  ${green("on")}   ${session}  ${backlog}${dropped}`);
      } else if (r.backlogSegments > 0 || r.droppedSegments > 0) {
        // Off but with a leftover backlog (awaiting Phase 2 upload) — still worth showing.
        console.log(
          `  recording  off  ${gray(
            `backlog ${r.backlogSegments} seg / ${formatBytes(r.backlogBytes)}${
              r.droppedSegments > 0 ? `, dropped ${r.droppedSegments}` : ""
            }`,
          )}`,
        );
      }
    }
    if (state.lastError) console.log(`  last error ${yellow(state.lastError)}`);
  } else {
    console.log(gray("  (no state snapshot yet)"));
  }
  console.log(dim(`  log        ${logPath()}`));
}
