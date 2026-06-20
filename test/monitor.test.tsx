import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MonitorApp } from "../src/monitor/MonitorApp.js";
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
          x: { value: 0.01, unit: "m/s^2" },
          y: { value: -0.02, unit: "m/s^2" },
          z: { value: 9.81, unit: "m/s^2" },
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
    expect(frame).toContain("XORGATE Monitor");
    expect(frame).toContain("connected"); // connection moved to the header
    for (const title of ["IMU", "GPS", "LTE", "System", "Media", "Activity"]) {
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
