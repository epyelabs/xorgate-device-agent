import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadManifest, persistUploadBucket } from "../src/media/manifest.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xg-kvs-"));
  path = join(dir, "kvs.json");
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const valid = {
  deviceId: "dev-1",
  region: "us-east-1",
  credentialEndpoint: "abc.credentials.iot.us-east-1.amazonaws.com",
  roleAlias: "XorgateDeviceCreds",
  channels: [
    { streamKey: "cam0", channelName: "dev-1-cam0" },
    { streamKey: "cam1", channelName: "dev-1-cam1" },
  ],
};

describe("loadManifest", () => {
  it("parses a valid manifest", () => {
    writeFileSync(path, JSON.stringify(valid));
    expect(loadManifest(path)).toEqual(valid);
  });

  it("returns null when the file is missing", () => {
    expect(loadManifest(join(dir, "nope.json"))).toBeNull();
  });

  it("returns null on unparseable content", () => {
    writeFileSync(path, "not json");
    expect(loadManifest(path)).toBeNull();
  });

  it("returns null when a required field is missing or empty", () => {
    writeFileSync(path, JSON.stringify({ ...valid, region: "" }));
    expect(loadManifest(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...valid, credentialEndpoint: undefined }));
    expect(loadManifest(path)).toBeNull();
  });

  it("accepts an empty channel list (provisioned, no video streams)", () => {
    writeFileSync(path, JSON.stringify({ ...valid, channels: [] }));
    expect(loadManifest(path)).toEqual({ ...valid, channels: [] });
  });

  it("drops malformed channel entries", () => {
    writeFileSync(
      path,
      JSON.stringify({
        ...valid,
        channels: [
          { streamKey: "cam0", channelName: "dev-1-cam0" },
          { streamKey: "cam1" }, // missing channelName
          "garbage",
        ],
      }),
    );
    expect(loadManifest(path)?.channels).toEqual([
      { streamKey: "cam0", channelName: "dev-1-cam0" },
    ]);
  });
});

describe("persistUploadBucket", () => {
  it("backfills a manifest without an uploadBucket", () => {
    writeFileSync(path, JSON.stringify(valid));
    expect(persistUploadBucket(path, "core-bucket")).toBe("applied");
    expect(loadManifest(path)?.uploadBucket).toBe("core-bucket");
  });

  it("no-ops when the bucket already matches (retained redelivery)", () => {
    writeFileSync(path, JSON.stringify({ ...valid, uploadBucket: "core-bucket" }));
    expect(persistUploadBucket(path, "core-bucket")).toBe("unchanged");
  });

  it("overwrites a different existing bucket (cloud is authoritative)", () => {
    writeFileSync(path, JSON.stringify({ ...valid, uploadBucket: "old-bucket" }));
    expect(persistUploadBucket(path, "new-bucket")).toBe("applied");
    expect(loadManifest(path)?.uploadBucket).toBe("new-bucket");
  });

  it("preserves every other field verbatim, including unknown ones", () => {
    writeFileSync(path, JSON.stringify({ ...valid, futureKey: { nested: true } }));
    persistUploadBucket(path, "core-bucket");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.futureKey).toEqual({ nested: true });
    expect(raw.channels).toEqual(valid.channels);
  });

  it("returns no-manifest when kvs.json is absent or unparseable", () => {
    expect(persistUploadBucket(join(dir, "nope.json"), "b")).toBe("no-manifest");
    writeFileSync(path, "not json");
    expect(persistUploadBucket(path, "b")).toBe("no-manifest");
  });
});
