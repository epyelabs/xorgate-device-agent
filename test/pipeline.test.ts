import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cameraFileFor,
  directBackupFor,
  extractCameraName,
  isBridgedPipeline,
  pipelineFileFor,
  resolveCameraName,
  resolveChannelPipeline,
} from "../src/media/pipeline.js";
import { pipelineCommand } from "../src/commands/pipeline.js";

let dir: string;
let src: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xg-pipe-"));
  src = join(dir, "src.gst");
  writeFileSync(src, "videotestsrc ! appsink name=appsink-video\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("resolveChannelPipeline", () => {
  it("prefers a per-stream <streamKey>.gst file", () => {
    const f = pipelineFileFor(dir, "cam0");
    writeFileSync(f, "x");
    expect(resolveChannelPipeline(dir, "cam0")).toBe(f);
  });

  it("falls back to the global pipeline, then undefined", () => {
    expect(resolveChannelPipeline(dir, "cam1", "/global.gst")).toBe("/global.gst");
    expect(resolveChannelPipeline(dir, "cam1")).toBeUndefined();
  });
});

describe("xorgate pipeline", () => {
  it("set then clear round-trips a stream pipeline", async () => {
    const pdir = join(dir, "pipelines");
    await pipelineCommand(["set", "cam0", src, "--dir", pdir]);
    const dest = pipelineFileFor(pdir, "cam0");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("appsink");

    await pipelineCommand(["clear", "cam0", "--dir", pdir]);
    expect(existsSync(dest)).toBe(false);
  });

  it("rejects an invalid streamKey (no path traversal)", async () => {
    const pdir = join(dir, "p2");
    await pipelineCommand(["set", "../evil", src, "--dir", pdir]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(pdir)).toBe(false);
  });

  it("fails when the source file is missing", async () => {
    await pipelineCommand(["set", "cam0", join(dir, "nope.gst"), "--dir", join(dir, "p3")]);
    expect(process.exitCode).toBe(1);
  });
});

describe("bridged mode helpers", () => {
  it("extractCameraName parses libcamerasrc pipelines", () => {
    expect(extractCameraName("libcamerasrc camera-name=/base/i2c@88000/imx290@1a ! caps")).toBe(
      "/base/i2c@88000/imx290@1a",
    );
    expect(extractCameraName("videotestsrc ! appsink")).toBeNull();
  });

  it("isBridgedPipeline keys off shmsrc in the .gst", () => {
    writeFileSync(pipelineFileFor(dir, "cam0"), "shmsrc socket-path=/x ! appsink");
    writeFileSync(pipelineFileFor(dir, "cam1"), "libcamerasrc camera-name=/c ! appsink");
    expect(isBridgedPipeline(dir, "cam0")).toBe(true);
    expect(isBridgedPipeline(dir, "cam1")).toBe(false);
    expect(isBridgedPipeline(dir, "cam2")).toBe(false);
  });

  it("resolveCameraName prefers .camera, then backup, then .gst", () => {
    writeFileSync(pipelineFileFor(dir, "camA"), "libcamerasrc camera-name=/from-gst ! x");
    expect(resolveCameraName(dir, "camA")).toBe("/from-gst");
    writeFileSync(directBackupFor(dir, "camA"), "libcamerasrc camera-name=/from-backup ! x");
    expect(resolveCameraName(dir, "camA")).toBe("/from-backup");
    writeFileSync(cameraFileFor(dir, "camA"), "/from-camera-file\n");
    expect(resolveCameraName(dir, "camA")).toBe("/from-camera-file");
    expect(resolveCameraName(dir, "nope")).toBeNull();
  });
});

describe("xorgate pipeline bridge/direct", () => {
  it("bridge backs up the direct .gst, writes .camera, installs shmsrc pipeline", async () => {
    const pdir = join(dir, "pb");
    const direct = "libcamerasrc camera-name=/base/cam0@1a ! video/x-raw ! appsink name=appsink-video\n";
    writeFileSync(src, direct);
    await pipelineCommand(["set", "cam0", src, "--dir", pdir]);

    await pipelineCommand(["bridge", "cam0", "--dir", pdir]);
    expect(readFileSync(pipelineFileFor(pdir, "cam0"), "utf8")).toContain("shmsrc");
    expect(readFileSync(pipelineFileFor(pdir, "cam0"), "utf8")).toContain("name=sampleVideoEncoder");
    expect(readFileSync(directBackupFor(pdir, "cam0"), "utf8")).toBe(direct);
    expect(readFileSync(cameraFileFor(pdir, "cam0"), "utf8").trim()).toBe("/base/cam0@1a");

    // Idempotent: bridging again is a no-op, not a double-backup of shmsrc.
    await pipelineCommand(["bridge", "cam0", "--dir", pdir]);
    expect(readFileSync(directBackupFor(pdir, "cam0"), "utf8")).toBe(direct);

    await pipelineCommand(["direct", "cam0", "--dir", pdir]);
    expect(readFileSync(pipelineFileFor(pdir, "cam0"), "utf8")).toBe(direct);
    expect(existsSync(directBackupFor(pdir, "cam0"))).toBe(false);
  });

  it("bridge fails without a resolvable camera identity", async () => {
    const pdir = join(dir, "pb2");
    writeFileSync(src, "videotestsrc ! appsink name=appsink-video\n");
    await pipelineCommand(["set", "cam0", src, "--dir", pdir]);
    await pipelineCommand(["bridge", "cam0", "--dir", pdir]);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(pipelineFileFor(pdir, "cam0"), "utf8")).not.toContain("shmsrc");
  });

  it("direct fails without a backup", async () => {
    await pipelineCommand(["direct", "cam9", "--dir", join(dir, "pb3")]);
    expect(process.exitCode).toBe(1);
  });
});
