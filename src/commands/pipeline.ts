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
import { pipelineFileFor } from "../media/pipeline.js";
import { loadManifest } from "../media/manifest.js";

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
      const tag = existsSync(f) ? f : "(runtime default)";
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

function usage(): void {
  console.log(`usage: xorgate pipeline <list|show|set|clear> [streamKey] [file]

  list                      channels (from kvs.json) + which have a pipeline
  show  <streamKey>         print a stream's pipeline
  set   <streamKey> <file>  install a .gst pipeline for a stream (e.g. cam0)
  clear <streamKey>         remove a stream's pipeline (revert to default)

  --dir <path>       pipeline dir (default: $KVS_PIPELINE_DIR or ${DEFAULT_DIR})
  --manifest <path>  kvs.json for 'list' (default: $KVS_MANIFEST or ${DEFAULT_MANIFEST})`);
}
