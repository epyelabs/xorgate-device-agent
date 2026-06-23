import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipelineFileFor, resolveChannelPipeline } from "../src/media/pipeline.js";
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
