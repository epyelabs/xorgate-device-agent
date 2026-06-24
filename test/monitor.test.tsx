import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MonitorApp } from "../src/monitor/MonitorApp.js";
import { MODULES } from "../src/monitor/modules.js";
import type { DaemonStatus } from "../src/daemon/manager.js";
import type { PidRecord } from "../src/daemon/pidfile.js";
import type { StateSnapshot } from "../src/agent/telemetry.js";
import { cleanup, delay, tempHome } from "./helpers.js";

let home: string;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => cleanup(home));

const record: PidRecord = {
  pid: 4242,
  startedAt: Date.now(),
  deviceId: "dev-abc-123",
  mode: "sim",
  rateHz: 1,
  offline: true,
  worker: "/x/dist/worker.js",
  argv: ["--offline"],
  nodeVersion: "v20",
};

function snapshot(): StateSnapshot {
  const now = Date.now();
  return {
    v: 1,
    writtenBy: "test",
    deviceId: "dev-abc-123",
    mode: "sim",
    rateHz: 1,
    endpoint: "offline",
    offline: true,
    pid: 4242,
    startedAt: now,
    lastWriteAt: now,
    connection: "connected",
    connectionSince: now,
    seq: 12,
    published: 12,
    publishErrors: 0,
    lastPublishAt: now,
    lastError: null,
    latest: {
      v: 1,
      deviceId: "dev-abc-123",
      ts: now,
      seq: 12,
      metrics: {
        imu: {
          quat_r: { value: 0.92 },
          quat_i: { value: 0.33 },
          quat_j: { value: 0.07 },
          quat_k: { value: 0.19 },
          euler_roll: { value: 40.1, unit: "°" },
          euler_pitch: { value: -0.3, unit: "°" },
          euler_yaw: { value: 23.6, unit: "°" },
          accel_x: { value: 0.01, unit: "m/s^2" },
          accel_y: { value: -0.02, unit: "m/s^2" },
          accel_z: { value: 0.03, unit: "m/s^2" },
        },
        gps: {
          lat: { value: 37.7749 },
          lon: { value: -122.4194 },
          alt: { value: 20, unit: "m" },
          speed: { value: 0, unit: "km/h" },
        },
        lte: { rssi: { value: -67, unit: "dBm" }, quality: { value: 18, unit: "asu" } },
        system: {
          cpu_usage: { value: 31, unit: "%" },
          cpu_temp: { value: 54, unit: "°C" },
          ram_usage: { value: 47, unit: "%" },
          disk_usage: { value: 38, unit: "%" },
        },
      },
      media: { kvs: { value: false }, recording: { value: false }, streams: [] },
    },
    recentEvents: [{ ts: now, level: "info", msg: "connected to offline" }],
  };
}

describe("MonitorApp", () => {
  it("renders header + sidebar and opens a module detail on navigation", async () => {
    const running: DaemonStatus = {
      kind: "running",
      record,
      identity: "verified",
      state: snapshot(),
      stateFresh: true,
    };
    const { lastFrame, stdin, unmount } = render(
      <MonitorApp agentArgs={["--offline"]} inspector={async () => running} />,
    );
    await delay(150); // let the first poll land

    let frame = lastFrame() ?? "";
    expect(frame).toContain("XORGATE Manager");
    expect(frame).toContain("Connectivity"); // per-interface + mqtt status row
    expect(frame).toContain("mqtt"); // cloud/MQTT indicator restored
    expect(frame).toContain("pid"); // daemon stats live on the header status line
    for (const title of ["IMU", "GPS", "LTE", "System", "Media", "Activity", "Settings"]) {
      expect(frame).toContain(title); // sidebar lists every module
    }
    expect(frame).toContain("recent events"); // default selection = Activity detail
    expect(frame).toContain("stop"); // running → control hint

    // Navigate down to GPS (index 3) → its detail (coordinates) shows on the right.
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    await delay(80);
    frame = lastFrame() ?? "";
    expect(frame).toContain("37.774900");

    unmount();
  });

  it("opens Settings and edits the run mode + media rows", async () => {
    const running: DaemonStatus = {
      kind: "running",
      record,
      identity: "verified",
      state: snapshot(), // mode: "sim"
      stateFresh: true,
    };
    const { lastFrame, stdin, unmount } = render(
      <MonitorApp agentArgs={["--offline"]} inspector={async () => running} />,
    );
    await delay(150);

    // Settings is the last nav item — jump to it.
    const settingsIdx = MODULES.findIndex((m) => m.id === "settings");
    for (let i = 0; i < settingsIdx; i++) stdin.write("j");
    await delay(80);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("run mode"); // setting rows render
    expect(frame).toContain("media");
    expect(frame).toContain("wifi"); // wifi row present (on/off or "not present")

    stdin.write("\r"); // open (enter operating); row 0 = run mode focused
    await delay(60);
    frame = lastFrame() ?? "";
    expect(frame).toContain("▶ run mode");

    stdin.write(" "); // space toggles the focused row (sim -> real)
    await delay(60);
    frame = lastFrame() ?? "";
    expect(frame).toContain("real");

    stdin.write("j"); // move focus to the media row
    await delay(60);
    frame = lastFrame() ?? "";
    expect(frame).toContain("▶ media");

    unmount();
  });

  it("shows the not-running call-to-action when no daemon is present", async () => {
    const { lastFrame, unmount } = render(
      <MonitorApp agentArgs={[]} inspector={async () => ({ kind: "stopped" })} />,
    );
    await delay(150);
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("Daemon not running");
    expect(frame).toContain("start");
  });
});
