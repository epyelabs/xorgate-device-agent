/**
 * `xorgate pipeline <list|show|set|clear>` — manage per-stream GStreamer
 * pipelines for the KVS WebRTC media runtime.
 *
 * Each camera/channel can have its own pipeline file at `<dir>/<streamKey>.gst`
 * (e.g. cam0.gst, cam1.gst with different `libcamerasrc camera-name=...`). The
 * media collector resolves them per channel (see media/pipeline.ts). Changing a
 * pipeline takes effect on the next daemon restart.
 *
 * Dir/manifest resolve from `--dir`/`--manifest`, then the KVS_PIPELINE_DIR /
 * KVS_MANIFEST env, then the on-device defaults — so on a provisioned device the
 * bare `xorgate pipeline ...` targets /etc/xorgate without extra flags.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  cameraFileFor,
  directBackupFor,
  extractCameraName,
  isBridgedPipeline,
  pipelineFileFor,
  resolveCameraName,
} from "../media/pipeline.js";
import { loadManifest } from "../media/manifest.js";
import { bridgedKvsPipeline } from "../recording/video-capture.js";
import { shmSocketPathFor } from "../recording/config.js";

const DEFAULT_DIR = "/etc/xorgate/pipelines";
const DEFAULT_MANIFEST = "/etc/xorgate/kvs.json";
const VALUE_FLAGS = new Set(["--dir", "--manifest"]);
const RESTART_HINT = "  restart to apply: sudo systemctl restart xorgate-agent  (or: xorgate restart)";

export async function pipelineCommand(rest: string[]): Promise<void> {
  const { pos, flags } = parse(rest);
  const dir = resolve(flags["--dir"] ?? process.env.KVS_PIPELINE_DIR ?? DEFAULT_DIR);
  const sub = pos[0] ?? "list";

  switch (sub) {
    case "list":
      return list(dir, flags["--manifest"] ?? process.env.KVS_MANIFEST ?? DEFAULT_MANIFEST);
    case "show":
      return show(dir, pos[1]);
    case "set":
      return set(dir, pos[1], pos[2]);
    case "clear":
      return clear(dir, pos[1]);
    case "bridge":
      return bridge(dir, pos[1]);
    case "direct":
      return direct(dir, pos[1]);
    default:
      console.error(`unknown subcommand '${sub}'`);
      usage();
      process.exitCode = 1;
  }
}

function parse(rest: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      flags[a] = rest[++i] ?? "";
      continue;
    }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  return { pos, flags };
}

/** Stream keys map to filenames, so keep them to a safe charset (no path bits). */
function validKey(key: string | undefined): key is string {
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
    console.error("a valid streamKey is required (letters, digits, '_' or '-'), e.g. cam0");
    process.exitCode = 1;
    return false;
  }
  return true;
}

function list(dir: string, manifestPath: string): void {
  console.log(`pipeline dir: ${dir}`);
  const manifest = loadManifest(manifestPath);
  if (manifest && manifest.channels.length > 0) {
    console.log("channels:");
    for (const ch of manifest.channels) {
      const f = pipelineFileFor(dir, ch.streamKey);
      const mode = isBridgedPipeline(dir, ch.streamKey) ? " [bridged]" : "";
      const tag = existsSync(f) ? `${f}${mode}` : "(runtime default)";
      console.log(`  ${ch.streamKey.padEnd(8)} ${ch.channelName}  ←  ${tag}`);
    }
  } else {
    console.log(`(no manifest at ${manifestPath}; showing pipeline files only)`);
  }
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".gst")) : [];
  console.log(
    files.length > 0
      ? `pipeline files: ${files.join(", ")}`
      : "no per-stream pipeline files set (all channels use the runtime default)",
  );
}

function show(dir: string, key: string | undefined): void {
  if (!validKey(key)) return;
  const f = pipelineFileFor(dir, key);
  if (!existsSync(f)) {
    console.log(`${key}: no pipeline set (uses the runtime default)`);
    return;
  }
  console.log(`# ${f}`);
  process.stdout.write(readFileSync(f, "utf8"));
}

function set(dir: string, key: string | undefined, file: string | undefined): void {
  if (!validKey(key)) return;
  if (!file) {
    console.error("usage: xorgate pipeline set <streamKey> <file>");
    process.exitCode = 1;
    return;
  }
  const src = resolve(file);
  if (!existsSync(src)) {
    console.error(`pipeline file not found: ${src}`);
    process.exitCode = 1;
    return;
  }
  const content = readFileSync(src, "utf8");
  if (!content.includes("appsink")) {
    console.warn(
      "WARN: pipeline has no 'appsink'; it should end with 'appsink ... name=appsink-video'",
    );
  }
  mkdirSync(dir, { recursive: true });
  const dest = pipelineFileFor(dir, key);
  writeFileSync(dest, content);
  console.log(`✓ set ${key} pipeline → ${dest}`);
  console.log(RESTART_HINT);
}

function clear(dir: string, key: string | undefined): void {
  if (!validKey(key)) return;
  const f = pipelineFileFor(dir, key);
  if (!existsSync(f)) {
    console.log(`${key}: no pipeline set; nothing to clear`);
    return;
  }
  rmSync(f);
  console.log(`✓ cleared ${key} pipeline (${f}); reverts to the runtime default`);
  console.log(RESTART_HINT);
}

/**
 * Switch a stream to BRIDGED mode (offline recording plan D1): the capture
 * daemon owns the camera and the KVS master consumes low-res raw frames over
 * shm. The current direct .gst is backed up to `<key>.gst.direct` and the
 * camera-name preserved in `<key>.camera`, so `xorgate pipeline direct` can
 * restore today's behavior exactly.
 */
function bridge(dir: string, key: string | undefined): void {
  if (!validKey(key)) return;
  const gst = pipelineFileFor(dir, key);
  if (isBridgedPipeline(dir, key)) {
    console.log(`${key}: already bridged (${gst})`);
    return;
  }
  const cameraName = resolveCameraName(dir, key);
  if (!cameraName) {
    console.error(
      `${key}: cannot determine the libcamera camera-name (no ${cameraFileFor(dir, key)} ` +
        `and no camera-name= in the .gst). Write the camera name to that file and retry.`,
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(dir, { recursive: true });
  if (existsSync(gst)) {
    writeFileSync(directBackupFor(dir, key), readFileSync(gst, "utf8"));
  }
  writeFileSync(cameraFileFor(dir, key), `${cameraName}\n`);
  writeFileSync(gst, `${bridgedKvsPipeline(shmSocketPathFor(key))}\n`);
  console.log(`✓ ${key} bridged: capture daemon will own ${cameraName}`);
  console.log(`  .gst → shmsrc consumer (direct pipeline saved to ${directBackupFor(dir, key)})`);
  console.log("  NOTE: live streaming on this camera now requires the agent's capture");
  console.log("  daemon (media on). Revert anytime with: xorgate pipeline direct " + key);
  console.log(RESTART_HINT);
}

/** Restore a stream to DIRECT mode from the `.gst.direct` backup. */
function direct(dir: string, key: string | undefined): void {
  if (!validKey(key)) return;
  const backup = directBackupFor(dir, key);
  if (!existsSync(backup)) {
    console.error(`${key}: no ${backup} to restore; use 'xorgate pipeline set' instead`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(pipelineFileFor(dir, key), readFileSync(backup, "utf8"));
  rmSync(backup);
  console.log(`✓ ${key} restored to direct mode (KVS master owns the camera again)`);
  console.log("  if recording.video.enabled is on, disable it or the capture daemon will");
  console.log("  contend for the camera: xorgate set recording.video.enabled off");
  console.log(RESTART_HINT);
}

function usage(): void {
  console.log(`usage: xorgate pipeline <list|show|set|clear|bridge|direct> [streamKey] [file]

  list                      channels (from kvs.json) + which have a pipeline
  show  <streamKey>         print a stream's pipeline
  set   <streamKey> <file>  install a .gst pipeline for a stream (e.g. cam0)
  clear <streamKey>         remove a stream's pipeline (revert to default)
  bridge <streamKey>        capture-daemon mode: agent owns the camera, KVS
                            reads shm (required for recording.video; backs up
                            the direct .gst)
  direct <streamKey>        restore the backed-up direct pipeline

  --dir <path>       pipeline dir (default: $KVS_PIPELINE_DIR or ${DEFAULT_DIR})
  --manifest <path>  kvs.json for 'list' (default: $KVS_MANIFEST or ${DEFAULT_MANIFEST})`);
}
