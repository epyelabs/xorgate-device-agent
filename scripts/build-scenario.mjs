#!/usr/bin/env node
// Build the demo scenario asset pack for the device simulator
// (plans/xorgate-device-simulator, README §3.6 / Phase 1).
//
// Rebuilds `demo-assets/v1/<scenarioId>/` from the source session ids in
// `sim/scenarios/sources.json` alone — idempotent: re-running with the pack
// present re-syncs nothing that is already cached, rebuilds only missing or
// stale files, re-verifies everything and rewrites the JSON deterministically.
//
//   demo-assets/v1/<id>/scenario.json        per-scenario manifest (+ sha256 of every file)
//   demo-assets/v1/<id>/cam0/lap.h264        Annex-B elementary stream: the fragments concatenated, no re-encode
//   demo-assets/v1/<id>/cam0/seg/NNNNN.mp4   the original fragments, byte-for-byte (first-boot seeding uses these)
//   demo-assets/v1/<id>/cam0/seg/NNNNN.json  the original sidecars (reference only; seeding rewrites them)
//   demo-assets/v1/<id>/telemetry/trace.jsonl.gz  {t: ms since lap start, seq, metrics} clipped to the video window
//   demo-assets/v1/<id>/thumb.jpg
//   demo-assets/v1/catalog.json              every scenario's summary + the first-boot seed set
//
// usage:
//   node scripts/build-scenario.mjs --all [--out <dir>] [--work <dir>]
//        [--source-profile xorgate-prod] [--offline] [--force]
//        [--upload s3://<core-bucket>] [--upload-profile <profile>]
//   node scripts/build-scenario.mjs --scenario city-2026-09-27 …
//
// Source objects are READ ONLY (`aws s3 sync` from the source bucket); the
// upload goes to `<bucket>/demo-assets/v1/` with the upload profile. ffmpeg /
// ffprobe come from FFMPEG_BIN / FFPROBE_BIN, PATH, or — when neither is
// found or FFMPEG_DOCKER_IMAGE is set — a `docker run` of that image
// (default linuxserver/ffmpeg) with the scenario directory mounted at /work.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- args ----
const args = process.argv.slice(2);
const opt = { scenarios: [], all: false, force: false, offline: false, skipVerify: false };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const next = () => { i += 1; if (i >= args.length) throw new Error(`${a} needs a value`); return args[i]; };
  if (a === "--scenario") opt.scenarios.push(next());
  else if (a === "--all") opt.all = true;
  else if (a === "--out") opt.out = next();
  else if (a === "--work") opt.work = next();
  else if (a === "--sources") opt.sources = next();
  else if (a === "--source-bucket") opt.sourceBucket = next();
  else if (a === "--source-profile") opt.sourceProfile = next();
  else if (a === "--upload") opt.upload = next();
  else if (a === "--upload-profile") opt.uploadProfile = next();
  else if (a === "--frame-tolerance") opt.frameTolerance = Number(next());
  else if (a === "--force") opt.force = true;
  else if (a === "--offline") opt.offline = true;
  else if (a === "--skip-verify") opt.skipVerify = true;
  else if (a === "-h" || a === "--help") { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0); }
  else throw new Error(`unknown argument ${a}`);
}
const sourcesPath = resolve(opt.sources ?? join(repoRoot, "sim", "scenarios", "sources.json"));
const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
if (sources.v !== 1) throw new Error(`unsupported sources.json v=${sources.v}`);
const outDir = resolve(opt.out ?? join(repoRoot, "sim", "build", "demo-assets", "v1"));
const workDir = resolve(opt.work ?? join(repoRoot, "sim", "build", "work"));
const sourceBucket = (opt.sourceBucket ?? sources.sourceBucket).replace(/\/$/, "");
const sourceProfile = opt.sourceProfile ?? process.env.SOURCE_AWS_PROFILE ?? process.env.AWS_PROFILE;
const uploadProfile = opt.uploadProfile ?? process.env.UPLOAD_AWS_PROFILE;
const PAD_MS = 3000; // telemetry kept this far either side of the video window
const wanted = opt.all ? sources.scenarios.map((s) => s.id) : opt.scenarios;
if (wanted.length === 0) throw new Error("nothing to build: pass --scenario <id> (repeatable) or --all");
for (const id of wanted) if (!sources.scenarios.some((s) => s.id === id)) throw new Error(`scenario ${id} is not in ${sourcesPath}`);

// -------------------------------------------------------------- helpers ----
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const stableJson = (o) => `${JSON.stringify(o, null, 2)}\n`;
const writeIfChanged = (p, text) => {
  if (existsSync(p) && readFileSync(p, "utf8") === text) return false;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return true;
};

function aws(profile, cliArgs) {
  const env = { ...process.env };
  if (profile) env.AWS_PROFILE = profile;
  const r = spawnSync("aws", cliArgs, { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`aws ${cliArgs.join(" ")} failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

// ffmpeg / ffprobe: native binaries when available, else the docker image.
// Every call runs with cwd = the scenario directory and RELATIVE paths, so the
// docker variant (which mounts that directory at /work) behaves identically.
const hasBin = (b) => spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0;
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? "ffprobe";
const dockerImage = process.env.FFMPEG_DOCKER_IMAGE ?? (hasBin(FFMPEG_BIN) && hasBin(FFPROBE_BIN) ? null : "linuxserver/ffmpeg");
if (dockerImage) log(`ffmpeg via docker image ${dockerImage} (set FFMPEG_BIN/FFPROBE_BIN to use native binaries)`);
function ff(tool, cwd, ffArgs) {
  let cmd, cmdArgs;
  if (dockerImage) {
    // linuxserver/ffmpeg drops privileges itself via PUID/PGID (its s6 init breaks under --user)
    const ids = typeof process.getuid === "function" ? ["-e", `PUID=${process.getuid()}`, "-e", `PGID=${process.getgid()}`] : [];
    cmd = "docker";
    cmdArgs = ["run", "--rm", ...ids, "-v", `${cwd}:/work`, "-w", "/work",
      ...(tool === "ffprobe" ? ["--entrypoint", "ffprobe"] : []), dockerImage, ...ffArgs];
  } else {
    cmd = tool === "ffprobe" ? FFPROBE_BIN : FFMPEG_BIN;
    cmdArgs = ffArgs;
  }
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${tool} ${ffArgs.join(" ")} failed (${r.status}):\n${r.stderr.slice(-2000)}`);
  return r.stdout;
}
// JSON output: ffprobe's csv/flat writers emit fields in THEIR order, not the requested one.
const probe = (cwd, ffArgs) => JSON.parse(ff("ffprobe", cwd, ["-v", "error", ...ffArgs, "-of", "json"]));

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ------------------------------------------------------- per scenario ----
function fetchSource(scn) {
  const { deviceId, streamKey, mediaSessionId, telemetrySessionIds } = scn.source;
  const jobs = [
    [`${sourceBucket}/media-sessions/v1/${deviceId}/${streamKey}/${mediaSessionId}/`, join(workDir, "media", mediaSessionId)],
    ...telemetrySessionIds.map((t) => [`${sourceBucket}/telemetry/v1/${deviceId}/${t}/`, join(workDir, "telemetry", t)]),
  ];
  for (const [src, dst] of jobs) {
    if (opt.offline) { if (!existsSync(dst)) throw new Error(`--offline but ${dst} is missing`); continue; }
    mkdirSync(dst, { recursive: true });
    log(`sync ${src} → ${relative(process.cwd(), dst)}`);
    aws(sourceProfile, ["s3", "sync", "--only-show-errors", src, dst]);
  }
}

function readSidecars(scn) {
  const { deviceId, streamKey, mediaSessionId } = scn.source;
  const dir = join(workDir, "media", mediaSessionId);
  const names = readdirSync(dir).filter((f) => /^\d{5}\.json$/.test(f)).sort();
  if (names.length === 0) throw new Error(`no sidecars under ${dir}`);
  const sidecars = names.map((name, i) => {
    const sc = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const seq = Number(name.slice(0, 5));
    if (seq !== i) throw new Error(`${scn.id}: fragment seq gap at ${name}`);
    if (sc.seq !== seq || sc.sessionId !== mediaSessionId || sc.deviceId !== deviceId || sc.streamKey !== streamKey) {
      throw new Error(`${scn.id}: sidecar ${name} identity mismatch`);
    }
    const mp4 = join(dir, `${name.slice(0, 5)}.mp4`);
    if (!existsSync(mp4)) throw new Error(`${scn.id}: ${mp4} missing`);
    const size = statSync(mp4).size;
    if (sc.sizeBytes !== size) throw new Error(`${scn.id}: ${name} sizeBytes ${sc.sizeBytes} ≠ mp4 ${size}`);
    return { name, seq, sc, mp4 };
  });
  return { dir, sidecars };
}

function buildTrace(scn, videoStart, videoEnd, dest) {
  const samples = [];
  for (const tsid of scn.source.telemetrySessionIds) {
    const dir = join(workDir, "telemetry", tsid);
    for (const f of readdirSync(dir).filter((x) => /^\d+-\d{5}\.jsonl\.gz$/.test(x)).sort()) {
      for (const line of gunzipSync(readFileSync(join(dir, f))).toString("utf8").split("\n")) {
        if (!line) continue;
        const o = JSON.parse(line);
        if (o.type === "header") continue;
        if (typeof o.ts !== "number" || o.ts < videoStart - PAD_MS || o.ts > videoEnd + PAD_MS) continue;
        samples.push(o);
      }
    }
  }
  samples.sort((a, b) => a.ts - b.ts);
  const out = [];
  let lastTs = -1;
  for (const o of samples) {
    if (o.ts === lastTs) continue; // sessions overlap by a few seconds at the edges
    lastTs = o.ts;
    out.push({ t: o.ts - videoStart, seq: out.length, metrics: o.metrics });
  }
  if (out.length === 0) throw new Error(`${scn.id}: no telemetry samples inside the video window`);
  const body = `${out.map((o) => JSON.stringify(o)).join("\n")}\n`;
  const gz = gzipSync(Buffer.from(body), { level: 9 }); // node's gzip header carries mtime 0 → deterministic bytes
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest) || !readFileSync(dest).equals(gz)) writeFileSync(dest, gz);

  // insights, mirroring the server's filters (hdop ≤ 5, ≥ 2 km/h, step < 30 s, < 60 m/s)
  let fixes = 0, maxKph = 0, distanceM = 0, prev = null, first = null, last = null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let gaps = 0, maxGapMs = 0;
  for (let i = 0; i < out.length; i += 1) {
    const o = out[i];
    if (i > 0) { const g = o.t - out[i - 1].t; maxGapMs = Math.max(maxGapMs, g); if (g > 5000) gaps += 1; }
    const g = o.metrics?.gps ?? {};
    const fq = g.fix_quality?.value ?? 0;
    if (!fq || typeof g.lat?.value !== "number" || typeof g.lon?.value !== "number") continue;
    const p = { lat: g.lat.value, lon: g.lon.value };
    fixes += 1;
    first ??= p; last = p;
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    const kph = g.speed?.value ?? 0;
    maxKph = Math.max(maxKph, kph);
    const hdop = g.hdop?.value ?? 99;
    if (prev && o.t - prev.t < 30000 && hdop <= 5 && kph >= 2) {
      const d = haversineM(prev.p, p);
      if (d / Math.max((o.t - prev.t) / 1000, 1) < 60) distanceM += d;
    }
    prev = { t: o.t, p };
  }
  return {
    samples: out.length, tMin: out[0].t, tMax: out.at(-1).t, gapsOver5s: gaps, maxGapMs,
    insights: {
      distanceM: Math.round(distanceM), maxKph: Math.round(maxKph * 10) / 10,
      fixRatio: Math.round((fixes / out.length) * 1000) / 1000, fixes,
      start: first, end: last,
      bbox: fixes ? { minLat, maxLat, minLon, maxLon } : null,
    },
  };
}

function buildScenario(scn) {
  log(`=== ${scn.id}`);
  const scnDir = join(outDir, scn.id);
  const streamKey = scn.source.streamKey;
  const segDir = join(scnDir, streamKey, "seg");
  mkdirSync(segDir, { recursive: true });
  fetchSource(scn);
  const { dir: srcDir, sidecars } = readSidecars(scn);

  // 1. fragments + sidecars, byte-for-byte
  let copied = 0;
  for (const { name, mp4 } of sidecars) {
    for (const [src, dst] of [[join(srcDir, name), join(segDir, name)], [mp4, join(segDir, `${name.slice(0, 5)}.mp4`)]]) {
      if (!opt.force && existsSync(dst) && statSync(dst).size === statSync(src).size && sha256File(dst) === sha256File(src)) continue;
      copyFileSync(src, dst);
      copied += 1;
    }
  }
  // remove strays from an earlier build with more fragments
  for (const f of readdirSync(segDir)) {
    if (!/^\d{5}\.(mp4|json)$/.test(f) || Number(f.slice(0, 5)) < sidecars.length) continue;
    rmSync(join(segDir, f));
  }
  log(`fragments: ${sidecars.length} (${copied} file(s) copied)`);

  const videoStart = Math.min(...sidecars.map((s) => s.sc.startTs));
  const videoEnd = Math.max(...sidecars.map((s) => s.sc.startTs + s.sc.durationMs));
  const first = sidecars[0].sc;
  const fps = first.fps;

  // 2. lap.h264 — concat demuxer + h264_mp4toannexb, stream copy (no re-encode)
  const lapRel = `${streamKey}/lap.h264`;
  const lapPath = join(scnDir, lapRel);
  const listRel = `${streamKey}/.concat.txt`;
  const listPath = join(scnDir, listRel);
  if (opt.force || !existsSync(lapPath)) {
    writeFileSync(listPath, `${sidecars.map((s) => `file 'seg/${s.name.slice(0, 5)}.mp4'`).join("\n")}\n`);
    log(`ffmpeg concat → ${lapRel}`);
    try {
      ff("ffmpeg", scnDir, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listRel,
        "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", lapRel]);
    } finally { rmSync(listPath, { force: true }); }
  } else log(`${lapRel} present (use --force to rebuild)`);

  // 3. verify: fragment packet counts, lap frame count, sidecar wall window
  let verify = null;
  if (!opt.skipVerify) {
    log("ffprobe: counting fragment packets + lap frames …");
    const fragments = sidecars.map((s) => {
      const rel = `${streamKey}/seg/${s.name.slice(0, 5)}.mp4`;
      const p = probe(scnDir, ["-count_packets", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_packets,width,height,r_frame_rate:format=duration", rel]);
      const st = p.streams?.[0] ?? {};
      return { seq: s.seq, packets: Number(st.nb_read_packets), width: Number(st.width), height: Number(st.height), rate: st.r_frame_rate,
        mediaDurationMs: Math.round(Number(p.format?.duration) * 1000), sidecarDurationMs: s.sc.durationMs };
    });
    const lapFrames = Number(probe(scnDir, ["-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-f", "h264", lapRel]).streams?.[0]?.nb_read_frames);
    const fragmentPackets = fragments.reduce((a, f) => a + f.packets, 0);
    const mediaDurationMs = fragments.reduce((a, f) => a + f.mediaDurationMs, 0);
    const sidecarDurationMs = videoEnd - videoStart;
    const framesFromSidecars = Math.round((sidecarDurationMs * fps) / 1000);
    const framesFromMedia = Math.round((mediaDurationMs * fps) / 1000);
    const tolerance = opt.frameTolerance ?? fps * 3; // 3 s of wall-vs-media skew across the lap
    const badDims = fragments.filter((f) => f.width !== first.width || f.height !== first.height);
    const checks = {
      lapEqualsFragments: lapFrames === fragmentPackets,
      lapMatchesMediaDuration: Math.abs(lapFrames - framesFromMedia) <= fps,
      lapMatchesSidecarWindow: Math.abs(lapFrames - framesFromSidecars) <= tolerance,
      dimensionsConsistent: badDims.length === 0,
    };
    verify = { lapFrames, fragmentPackets, framesFromMedia, framesFromSidecars, mediaDurationMs, sidecarDurationMs,
      lapDurationMs: Math.round((lapFrames / fps) * 1000), toleranceFrames: tolerance, checks, fragments };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    log(`lap frames ${lapFrames} = fragments ${fragmentPackets}; media ${framesFromMedia} f (${mediaDurationMs} ms); sidecar window ${framesFromSidecars} f (${sidecarDurationMs} ms)`);
    if (failed.length) throw new Error(`${scn.id}: verification failed: ${failed.join(", ")}`);
  }

  // 4. telemetry trace
  const traceRel = "telemetry/trace.jsonl.gz";
  const trace = buildTrace(scn, videoStart, videoEnd, join(scnDir, traceRel));
  log(`trace: ${trace.samples} samples, t ${trace.tMin}..${trace.tMax} ms, ${trace.insights.fixes} fixes, ${trace.insights.distanceM} m, max ${trace.insights.maxKph} km/h`);

  // 5. thumbnail: the session's own thumb.jpg, else the first fragment at 5 s
  const thumbPath = join(scnDir, "thumb.jpg");
  const srcThumb = join(srcDir, "thumb.jpg");
  if (opt.force || !existsSync(thumbPath)) {
    if (existsSync(srcThumb)) copyFileSync(srcThumb, thumbPath);
    else ff("ffmpeg", scnDir, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "5", "-i", `${streamKey}/seg/00000.mp4`, "-frames:v", "1", "-q:v", "3", "thumb.jpg"]);
  }

  // 6. scenario.json (deterministic: no timestamps; every file hashed)
  const files = {};
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name !== "scenario.json" && !f.name.startsWith(".")) files[relative(scnDir, p)] = { bytes: statSync(p).size, sha256: sha256File(p) }; } };
  walk(scnDir);
  const ordered = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  const bytes = Object.values(ordered).reduce((a, f) => a + f.bytes, 0);
  const scenario = {
    v: 1, id: scn.id, title: scn.title, description: scn.description,
    source: { ...scn.source, sourceBucket },
    durationMs: videoEnd - videoStart, originalStartTs: videoStart, originalEndTs: videoEnd,
    streams: [{
      streamKey, lap: lapRel, codec: first.codec ?? "h264", width: first.width, height: first.height, fps, bitrateKbps: first.bitrateKbps,
      segmentSeconds: Math.round(sidecars[0].sc.durationMs / 1000), fragments: `${streamKey}/seg/`, fragmentCount: sidecars.length,
      frames: verify?.lapFrames ?? null, mediaDurationMs: verify?.mediaDurationMs ?? null, timeSource: first.timeSource ?? null,
    }],
    telemetry: { trace: traceRel, rateHz: 1, samples: trace.samples, tMin: trace.tMin, tMax: trace.tMax, gapsOver5s: trace.gapsOver5s, maxGapMs: trace.maxGapMs },
    insights: trace.insights,
    thumbnail: "thumb.jpg",
    privacy: scn.privacy ?? null,
    bytes, files: ordered,
    verify: verify ? { ...verify, fragments: undefined } : null,
  };
  const changed = writeIfChanged(join(scnDir, "scenario.json"), stableJson(scenario));
  log(`scenario.json ${changed ? "written" : "unchanged"}; pack ${(bytes / 1e6).toFixed(1)} MB`);
  return scenario;
}

// ------------------------------------------------------------ catalog ----
function buildCatalog() {
  const scenarios = [];
  for (const scn of sources.scenarios) {
    const p = join(outDir, scn.id, "scenario.json");
    if (!existsSync(p)) continue;
    const s = JSON.parse(readFileSync(p, "utf8"));
    scenarios.push({
      id: s.id, title: s.title, description: s.description, durationMs: s.durationMs, originalStartTs: s.originalStartTs,
      thumbnail: `${s.id}/thumb.jpg`, bytes: s.bytes, insights: s.insights,
      streams: s.streams.map((st) => ({ streamKey: st.streamKey, width: st.width, height: st.height, fps: st.fps, fragmentCount: st.fragmentCount })),
      telemetry: { rateHz: s.telemetry.rateHz, samples: s.telemetry.samples },
      privacy: s.privacy?.decision ?? null,
      manifest: `${s.id}/scenario.json`, manifestSha256: sha256File(p),
    });
  }
  const catalog = { v: 1, home: sources.home, seedSet: sources.seedSet.filter((id) => scenarios.some((s) => s.id === id)), scenarios };
  const changed = writeIfChanged(join(outDir, "catalog.json"), stableJson(catalog));
  log(`catalog.json ${changed ? "written" : "unchanged"}: ${scenarios.length} scenario(s), seedSet ${catalog.seedSet.join(", ")}`);
  return catalog;
}

// --------------------------------------------------------------- main ----
mkdirSync(outDir, { recursive: true });
const built = [];
for (const id of wanted) built.push(buildScenario(sources.scenarios.find((s) => s.id === id)));
const catalog = buildCatalog();

if (opt.upload) {
  const dest = `${opt.upload.replace(/\/$/, "")}/demo-assets/v1/`;
  log(`upload ${outDir} → ${dest}${uploadProfile ? ` (profile ${uploadProfile})` : ""}`);
  aws(uploadProfile, ["s3", "sync", "--only-show-errors", "--exclude", "*/.concat.txt", `${outDir}/`, dest]);
  log("upload done");
}

console.log("\nid                       min   frag  frames   samples  fixes   km   maxKph  MB");
for (const s of built) {
  console.log([s.id.padEnd(24), (s.durationMs / 60000).toFixed(1).padStart(5), String(s.streams[0].fragmentCount).padStart(5),
    String(s.streams[0].frames ?? "-").padStart(7), String(s.telemetry.samples).padStart(8), String(s.insights.fixes).padStart(6),
    (s.insights.distanceM / 1000).toFixed(2).padStart(6), String(s.insights.maxKph).padStart(7), (s.bytes / 1e6).toFixed(1).padStart(7)].join(" "));
}
console.log(`catalog: ${catalog.scenarios.length} scenario(s)`);
