/**
 * `xorgate status` — rich, scriptable status. Exits non-zero when the daemon is
 * not running so callers can branch on `$?`.
 */
import { accessSync, constants } from "node:fs";
import { inspect, type DaemonStatus } from "../daemon/manager.js";
import { logPath, runtimeHome } from "../daemon/runtime.js";
import { ageLabel, formatBytes, uptimeLabel } from "../lib/format.js";
import { formatBuildInfo } from "../lib/build-info.js";
import type { ObdStatus } from "../agent/telemetry.js";

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

  // The installed build, read from this tree's baked manifest — the same string
  // the agent reports to the cloud, so a field report and the web UI agree.
  console.log(`  build      ${formatBuildInfo()}`);

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
    // Video capture (Phase 3): per-stream daemon state rides the media block.
    const capture = (state.latest?.media?.streams ?? []).filter((s) => s.recording !== undefined);
    if (capture.length > 0) {
      const parts = capture.map((s) => `${s.streamKey} ${s.recording ? green("recording") : gray("idle")}`);
      console.log(`  video      ${parts.join("   ")}`);
    }
    if (state.obd) console.log(`  ${obdStatusLine(state.obd)}`);
    if (state.lastError) console.log(`  last error ${yellow(state.lastError)}`);
  } else {
    console.log(gray("  (no state snapshot yet)"));
  }
  console.log(dim(`  log        ${logPath()}`));
}

/**
 * The `obd` status line (obd2 P1, plan 7.5), e.g.
 * `obd        live  link 2  10.0 req/s  err 0  forbidden 0  14.1 V`.
 * Pure and colorless so it is testable and greppable; the label column
 * matches the other rows (`telemetry  …`).
 * RUST-PORT: status-line seam — same columns, same order.
 */
export function obdStatusLine(obd: ObdStatus): string {
  const rate = obd.reqPerSec === null ? "— req/s" : `${obd.reqPerSec.toFixed(1)} req/s`;
  const volts = obd.voltage === null ? "— V" : `${obd.voltage.toFixed(1)} V`;
  return `obd        ${obd.state}  link ${obd.link}  ${rate}  err ${obd.errors}  forbidden ${obd.forbidden}  ${volts}`;
}
