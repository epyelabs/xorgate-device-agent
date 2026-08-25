import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEncoderForPlatform,
  hardwareBlocksEqual,
  loadHardwareBlock,
  parseHardwareBlock,
  saveHardwareBlock,
  type DeviceHardwareBlock,
} from "../src/hardware/hardware-config.js";
import { connectorForPath, parseCameraList } from "../src/hardware/cameras.js";
import {
  buildBridgedKvsPipeline,
  buildDirectKvsPipeline,
  buildRecordEncodeArgs,
  isRecognizedBridgedRender,
} from "../src/media/pipeline-builder.js";
import { bridgedKvsPipeline, buildCapturePipelineArgs } from "../src/recording/video-capture.js";
import { reconcileHardware } from "../src/media/hardware-reconcile.js";

const CM4_BLOCK: DeviceHardwareBlock = {
  v: 2,
  platform: "rpi-cm4",
  encoder: "hw-h264",
  rails: false,
  statusLed: null,
  imu: "bno085",
  video: [
    { key: "cam0", connector: "csi0", sensor: "imx290", codec: "h264", label: "Front" },
  ],
};

/** README Appendix A, joined to the single line the .gst file carries. */
const APPENDIX_A =
  "shmsrc socket-path=/var/lib/xorgate/shm/cam0.sock is-live=true do-timestamp=true ! " +
  "video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! " +
  "videoconvert ! " +
  "v4l2h264enc extra-controls=controls,video_bitrate=1000000,repeat_sequence_header=1,h264_i_frame_period=30 ! " +
  "video/x-h264,profile=(string)constrained-baseline,level=(string)4,stream-format=(string)byte-stream,alignment=(string)au ! " +
  "appsink sync=TRUE emit-signals=TRUE name=appsink-video";

describe("parseHardwareBlock", () => {
  it("parses a CM4 block and derives defaults", () => {
    expect(parseHardwareBlock(CM4_BLOCK)).toEqual(CM4_BLOCK);
    const noEncoder = { ...CM4_BLOCK, encoder: undefined };
    expect(parseHardwareBlock(noEncoder)?.encoder).toBe("hw-h264");
    expect(defaultEncoderForPlatform("rpi-cm5")).toBe("sw-h264");
  });

  it("rejects unknown enums and malformed shapes loudly (null)", () => {
    expect(parseHardwareBlock({ ...CM4_BLOCK, platform: "jetson" })).toBeNull();
    expect(parseHardwareBlock({ ...CM4_BLOCK, encoder: "av1" })).toBeNull();
    expect(parseHardwareBlock({ ...CM4_BLOCK, v: 1 })).toBeNull();
    expect(parseHardwareBlock({ ...CM4_BLOCK, statusLed: { r: 12 } })).toBeNull();
    expect(parseHardwareBlock({ ...CM4_BLOCK, video: [{ key: "cam0" }] })).toBeNull();
    expect(parseHardwareBlock(null)).toBeNull();
    expect(parseHardwareBlock("nope")).toBeNull();
  });

  it("round-trips through save/load and compares structurally", () => {
    const dir = mkdtempSync(join(tmpdir(), "xg-hw-"));
    const path = join(dir, "hardware.json");
    try {
      expect(loadHardwareBlock(path, () => {})).toBeNull(); // absent = silent null
      saveHardwareBlock(path, CM4_BLOCK);
      const loaded = loadHardwareBlock(path, () => {});
      expect(loaded).toEqual(CM4_BLOCK);
      expect(hardwareBlocksEqual(loaded, CM4_BLOCK)).toBe(true);
      writeFileSync(path, "{ not json");
      expect(loadHardwareBlock(path, () => {})).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("camera enumeration parsing", () => {
  const CM5_LISTING = `Available cameras
-----------------
0 : imx290 [1920x1080 12-bit RGGB] (/base/axi/pcie@1000120000/rp1/i2c@88000/imx290@1a)
    Modes: 'SRGGB10_CSI2P' : 1280x720 [30.00 fps]
1 : imx290 [1920x1080 12-bit RGGB] (/base/axi/pcie@1000120000/rp1/i2c@70000/imx290@1a)
    Modes: 'SRGGB10_CSI2P' : 1280x720 [60.00 fps]
`;

  it("parses the CM5 bench listing with RP1 connector order (88000=csi0, 70000=csi1)", () => {
    const cams = parseCameraList(CM5_LISTING, "rpi-cm5");
    expect(cams).toEqual([
      {
        cameraName: "/base/axi/pcie@1000120000/rp1/i2c@88000/imx290@1a",
        sensor: "imx290",
        connector: "csi0",
      },
      {
        cameraName: "/base/axi/pcie@1000120000/rp1/i2c@70000/imx290@1a",
        sensor: "imx290",
        connector: "csi1",
      },
    ]);
  });

  it("maps CM4 Unicam paths", () => {
    expect(connectorForPath("rpi-cm4", "/base/soc/i2c0mux/i2c@0/imx290@1a")).toBe("csi0");
    expect(connectorForPath("rpi-cm4", "/base/soc/i2c0mux/i2c@1/imx290@1a")).toBe("csi1");
    expect(connectorForPath("rpi-cm4", "/weird/path")).toBeNull();
  });
});

describe("pipeline templates", () => {
  it("hw-h264 bridged .gst reproduces README Appendix A exactly", () => {
    expect(buildBridgedKvsPipeline("hw-h264", "/var/lib/xorgate/shm/cam0.sock")).toBe(APPENDIX_A);
  });

  it("sw-h264 bridged .gst is byte-for-byte the historical pipeline", () => {
    expect(buildBridgedKvsPipeline("sw-h264", "/shm/cam0.sock")).toBe(
      "shmsrc socket-path=/shm/cam0.sock is-live=true do-timestamp=true ! " +
        "video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! " +
        "x264enc name=sampleVideoEncoder bframes=0 speed-preset=ultrafast bitrate=1000 " +
        "byte-stream=TRUE tune=zerolatency threads=2 ! " +
        "video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! " +
        "appsink sync=TRUE emit-signals=TRUE name=appsink-video",
    );
    // and the legacy entry point still returns it
    expect(bridgedKvsPipeline("/shm/cam0.sock")).toBe(buildBridgedKvsPipeline("sw-h264", "/shm/cam0.sock"));
  });

  it("hw templates never name the encoder sampleVideoEncoder (TWCC skip, D5)", () => {
    expect(buildBridgedKvsPipeline("hw-h264", "/s")).not.toContain("sampleVideoEncoder");
    expect(buildDirectKvsPipeline("hw-h264", "cam0", "/cam/path")).not.toContain(
      "sampleVideoEncoder",
    );
  });

  it("direct sw template matches the install script's historical bytes (no TWCC name)", () => {
    expect(buildDirectKvsPipeline("sw-h264", "cam0", "/base/soc/i2c0mux/i2c@0/imx290@1a")).toBe(
      "libcamerasrc name=cam0 camera-name=/base/soc/i2c0mux/i2c@0/imx290@1a ! " +
        "video/x-raw,format=I420,width=1280,height=720,framerate=15/1 ! " +
        "x264enc bframes=0 speed-preset=ultrafast bitrate=1000 " +
        "byte-stream=TRUE tune=zerolatency threads=2 ! " +
        "video/x-h264,stream-format=byte-stream,alignment=au,profile=baseline ! " +
        "appsink sync=TRUE emit-signals=TRUE name=appsink-video",
    );
  });

  it("recording encode stage follows the encoder token (D6)", () => {
    const sw = buildRecordEncodeArgs("sw-h264", 2000, 30);
    expect(sw[0]).toBe("x264enc");
    expect(sw).toContain("bitrate=2000");
    const hw = buildRecordEncodeArgs("hw-h264", 2000, 30);
    expect(hw).toEqual([
      "videoconvert",
      "!",
      "v4l2h264enc",
      "extra-controls=controls,video_bitrate=2000000,repeat_sequence_header=1,h264_i_frame_period=30",
    ]);
  });

  it("buildCapturePipelineArgs swaps only the encoder stage on hw-h264", () => {
    const base = {
      cameraName: "/cam",
      preset: { name: "720p15-1mbps", width: 1280, height: 720, fps: 15, bitrateKbps: 1000 },
      segmentSeconds: 60,
      outputDir: "/out",
      shmSocketPath: "/shm/cam0.sock",
    };
    const sw = buildCapturePipelineArgs(base as never);
    const hw = buildCapturePipelineArgs({ ...base, encoder: "hw-h264" } as never);
    expect(sw).toContain("x264enc");
    expect(sw).not.toContain("v4l2h264enc");
    expect(hw).toContain("v4l2h264enc");
    expect(hw).toContain("videoconvert");
    expect(hw).not.toContain("x264enc");
    // shared skeleton unchanged
    for (const token of ["-e", "libcamerasrc", "tee", "h264parse", "shmsink"]) {
      expect(sw).toContain(token);
      expect(hw).toContain(token);
    }
  });
});

describe("reconcileHardware", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const CM4_LISTING = `Available cameras
-----------------
0 : imx290 [1920x1080 12-bit RGGB] (/base/soc/i2c0mux/i2c@0/imx290@1a)
    Modes: whatever
`;

  const opts = (listing: string | null) => ({
    pipelineDir: dir,
    shmSocketPathFor: (key: string) => `/var/lib/xorgate/shm/${key}.sock`,
    log: () => {},
    listExec: async () =>
      listing === null
        ? { stdout: "", stderr: "", exitCode: null, failed: true, notFound: true }
        : { stdout: listing, stderr: "", exitCode: 0, failed: false, notFound: false },
  });

  it("renders the trio for a matched camera and reports changed streams", async () => {
    dir = mkdtempSync(join(tmpdir(), "xg-rec-"));
    const res = await reconcileHardware(CM4_BLOCK, opts(CM4_LISTING));
    expect(res.statuses.get("cam0")).toBe("rendered");
    expect(res.changedStreams).toEqual(["cam0"]);
    expect(readFileSync(join(dir, "cam0.gst"), "utf8").trim()).toBe(APPENDIX_A);
    expect(readFileSync(join(dir, "cam0.camera"), "utf8").trim()).toBe(
      "/base/soc/i2c0mux/i2c@0/imx290@1a",
    );
    expect(readFileSync(join(dir, "cam0.gst.direct"), "utf8")).toContain("libcamerasrc");

    // Second pass: everything current — nothing rewritten, no bounces.
    const again = await reconcileHardware(CM4_BLOCK, opts(CM4_LISTING));
    expect(again.statuses.get("cam0")).toBe("ok");
    expect(again.changedStreams).toEqual([]);
  });

  it("re-renders a recognized render on encoder change, but never a custom pipeline", async () => {
    dir = mkdtempSync(join(tmpdir(), "xg-rec-"));
    // Start from the sw render (what the install script/bridge wrote).
    writeFileSync(
      join(dir, "cam0.gst"),
      `${buildBridgedKvsPipeline("sw-h264", "/var/lib/xorgate/shm/cam0.sock")}\n`,
    );
    const res = await reconcileHardware(CM4_BLOCK, opts(CM4_LISTING));
    expect(res.statuses.get("cam0")).toBe("rendered");
    expect(readFileSync(join(dir, "cam0.gst"), "utf8").trim()).toBe(APPENDIX_A);

    // A hand-tuned pipeline is respected.
    writeFileSync(join(dir, "cam0.gst"), "videotestsrc ! my custom thing ! appsink\n");
    const custom = await reconcileHardware(CM4_BLOCK, opts(CM4_LISTING));
    expect(custom.statuses.get("cam0")).toBe("custom");
    expect(readFileSync(join(dir, "cam0.gst"), "utf8")).toContain("my custom thing");
  });

  it("reports no-camera when the connector is empty, touching nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "xg-rec-"));
    const twoCam = {
      ...CM4_BLOCK,
      video: [
        ...CM4_BLOCK.video,
        { key: "cam1", connector: "csi1", sensor: "imx290", codec: "h264" },
      ],
    };
    const res = await reconcileHardware(twoCam, opts(CM4_LISTING));
    expect(res.statuses.get("cam0")).toBe("rendered");
    expect(res.statuses.get("cam1")).toBe("no-camera");
    expect(existsSync(join(dir, "cam1.gst"))).toBe(false);
  });

  it("touches nothing when enumeration is unavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "xg-rec-"));
    const res = await reconcileHardware(CM4_BLOCK, opts(null));
    expect(res.cameras).toBeNull();
    expect(res.statuses.size).toBe(0);
    expect(existsSync(join(dir, "cam0.gst"))).toBe(false);
  });

  it("recognizes both encoder renders as overwritable", () => {
    const sock = "/var/lib/xorgate/shm/cam0.sock";
    expect(isRecognizedBridgedRender(buildBridgedKvsPipeline("sw-h264", sock), sock)).toBe(true);
    expect(isRecognizedBridgedRender(buildBridgedKvsPipeline("hw-h264", sock), sock)).toBe(true);
    expect(isRecognizedBridgedRender("something else", sock)).toBe(false);
  });
});
