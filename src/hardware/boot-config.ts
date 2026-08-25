/**
 * The boot config (`/boot/firmware/config.txt`) as this agent is allowed to
 * touch it: ONE parameter, `rotation`, on ONE kind of line, the camera
 * `dtoverlay=`.
 *
 * Why it exists (cam-sensor-level-rotate plan): a device mounted upside down
 * has to deliver upright frames to live WebRTC, recorded MP4s, replays AND
 * workflow/ML frames. Flipping in GStreamer costs +21% of a core on a CM5 and
 * +50% on a CM4; the sensor's own H+V flip — which is all the overlay's
 * `rotation=180` parameter does — costs +0.0% on both, measured. The price is
 * that the device tree is read once, at boot.
 *
 * THE SAFETY INVARIANT: nothing in this file, or anything it calls, may ever
 * reboot the device. It edits the line, reports that a reboot is required, and
 * stops. A reboot loop on a fleet of dashcams is the one failure this feature
 * could cause that nobody could recover remotely, so the property is
 * structural (there is no reboot call anywhere in this module) rather than
 * conditional.
 *
 * Three different rotations exist at any moment and the difference between
 * them IS the feature's user-visible state:
 *
 *   desired    what settings.json asks for (cloud or `xorgate set`)
 *   boot       what config.txt now holds  -> takes effect on the NEXT boot
 *   in force   what the running kernel booted with, read back from the live
 *              device tree (/proc/device-tree/…/<sensor>@<addr>/rotation)
 *
 * Reading the live device tree — rather than remembering what we wrote — is
 * what makes "reboot required" honest across agent restarts, SD re-images and
 * hand-edits: it is the kernel's own answer, not our bookkeeping.
 *
 * Writing needs root, and the agent runs as the provisioning user, so the
 * write itself goes through `sudo -n /usr/local/bin/xorgate-camrotate` — the
 * same shape as the clock stepper's `xorgate-setclock` helper, with the
 * sudoers drop-in (023_xorgate-camrotate) as the entire privilege surface and
 * the helper re-validating every argument.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.js";
import { cameraFileFor } from "../media/pipeline.js";
import type { CameraMountSettings, CameraRotationDeg } from "../daemon/settings.js";
import type { DeviceHardwareBlock } from "./hardware-config.js";

/** Where the boot config lives: Bookworm first, then the pre-Bookworm path. */
export const BOOT_CONFIG_CANDIDATES = ["/boot/firmware/config.txt", "/boot/config.txt"] as const;

/** The root of the LIVE device tree — what the kernel actually booted with. */
export const PROC_DEVICE_TREE = "/proc/device-tree";

/** The privileged writer (see system/xorgate-camrotate). */
export const CAMROTATE_HELPER = "/usr/local/bin/xorgate-camrotate";

export function resolveBootConfigPath(
  candidates: readonly string[] = BOOT_CONFIG_CANDIDATES,
): string | null {
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// --- parsing ----------------------------------------------------------------

/** One `dtoverlay=` line, split into the overlay name and its parameters. */
export interface OverlayLine {
  /** 0-based line number in the file. */
  index: number;
  /** Overlay name — the first comma-separated token (e.g. `imx290`). */
  name: string;
  /** The remaining tokens, verbatim (`cam0`, `4lane`, `rotation=180`, …). */
  params: string[];
  /** The line as it appears in the file, without its newline. */
  text: string;
}

/**
 * Every `dtoverlay=` line in the file, in order.
 *
 * Commented-out lines are skipped: `#dtoverlay=…` is how the RGB-LED plan
 * disabled the googlevoicehat overlay, and re-animating a line someone
 * deliberately commented out would be a surprising thing for a rotation
 * setting to do.
 *
 * Section conditionals (`[cm4]`, `[all]`, `[pi5]`, …) are deliberately NOT
 * interpreted. A camera overlay repeated under two sections is legitimate, and
 * the only safe reading of "which one is live" belongs to the firmware; we
 * therefore treat EVERY matching line as one that must carry the same
 * rotation, which is true whichever section ends up applying.
 */
export function parseOverlayLines(text: string): OverlayLine[] {
  const out: OverlayLine[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("dtoverlay=")) continue;
    const value = trimmed.slice("dtoverlay=".length);
    const tokens = value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    const name = tokens[0];
    if (!name) continue;
    out.push({ index, name, params: tokens.slice(1), text: line });
  }
  return out;
}

/** `csi0` -> `cam0`. Returns null for a connector this mapping does not know. */
export function overlayCamToken(connector: string): string | null {
  const m = /^csi(\d+)$/.exec(connector.trim());
  return m ? `cam${m[1]}` : null;
}

/**
 * The rotation a line declares: the value of its `rotation=` token, or 0 when
 * it has none (the overlay's own default). Anything unparseable is reported as
 * null so the caller can rewrite the line rather than trust it.
 */
export function rotationOfLine(line: OverlayLine): number | null {
  const token = line.params.find((p) => p.startsWith("rotation="));
  if (token === undefined) return 0;
  const value = Number(token.slice("rotation=".length));
  return value === 0 || value === 180 ? value : null;
}

/** The `dtoverlay=` lines that configure one camera connector. */
export function overlayLinesForCamera(lines: OverlayLine[], camToken: string): OverlayLine[] {
  return lines.filter((l) => l.params.includes(camToken));
}

export interface BootConfigCameraView {
  /** The overlay (sensor) name the boot config uses for this camera. */
  sensor: string | null;
  /** Rotation in the boot config; null when there is no line, or lines disagree. */
  rotation: number | null;
  /** How many `dtoverlay=` lines mention this camera. */
  lines: number;
}

/**
 * What the boot config says about one camera. Disagreeing duplicate lines
 * report `rotation: null`, which the reconciler treats as "needs a write" —
 * the helper then makes every one of them say the same thing.
 */
export function bootConfigCamera(text: string, camToken: string): BootConfigCameraView {
  const matches = overlayLinesForCamera(parseOverlayLines(text), camToken);
  if (matches.length === 0) return { sensor: null, rotation: null, lines: 0 };
  const rotations = matches.map(rotationOfLine);
  const first = rotations[0];
  const agreed = rotations.every((r) => r !== null && r === first) ? (first as number) : null;
  return { sensor: matches[0]?.name ?? null, rotation: agreed, lines: matches.length };
}

// --- what the kernel actually booted with -----------------------------------

/**
 * The rotation IN FORCE for an enumerated camera, read off the live device
 * tree. `cameraName` is libcamera's own identity for the sensor — the very
 * string the capture pipeline opens, e.g.
 * `/base/axi/pcie@…/i2c@88000/imx290@1a` — and its `/base` prefix maps onto
 * `/proc/device-tree`.
 *
 * null when the node or property is missing (a v1 device tree, an
 * unenumerated camera, a sensor whose overlay has no rotation parameter).
 * The caller must then say it could not confirm, never assume 0.
 */
export function dtRotationForCamera(
  cameraName: string,
  dtRoot: string = PROC_DEVICE_TREE,
): number | null {
  const node = cameraName.trim().replace(/^\/base\//, "");
  if (node.length === 0 || node.includes("..")) return null;
  try {
    const buf = readFileSync(join(dtRoot, node, "rotation"));
    if (buf.length !== 4) return null;
    return buf.readUInt32BE(0);
  } catch {
    return null;
  }
}

/** The enumerated camera identity this boot, as the hardware reconciler cached it. */
export function cameraNameFor(pipelineDir: string, streamKey: string): string | null {
  try {
    const text = readFileSync(cameraFileFor(pipelineDir, streamKey), "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// --- does this sensor's overlay even have the parameter? --------------------

export type OverlayProbe = (sensor: string) => Promise<{ ok: boolean; supports: boolean }>;

/**
 * Q4's runtime probe: ask `dtoverlay -h <sensor>` whether the overlay on THIS
 * device declares a `rotation` parameter, instead of carrying a static
 * allowlist that rots. imx290 has it (verified on both benches); imx219 /
 * imx477 / imx708 are believed to and will answer for themselves.
 *
 * `ok: false` means the probe itself could not run (no `dtoverlay` binary, an
 * unknown overlay) — the reconciler then refuses to edit and says so, which is
 * the whole point: an unsupported sensor must produce a visible error, never a
 * silently-written parameter the firmware ignores.
 */
export async function probeOverlayRotation(
  sensor: string,
): Promise<{ ok: boolean; supports: boolean }> {
  const res = await run("dtoverlay", ["-h", sensor], { timeoutMs: 10_000 });
  if (res.notFound || res.failed) return { ok: false, supports: false };
  // The help text lists one parameter per indented block; `rotation` appears as
  // the first word of its own line.
  const supports = /^\s*rotation\b/m.test(res.stdout);
  return { ok: true, supports };
}

// --- the reconciler ---------------------------------------------------------

export type CameraMountVerdict =
  /** In force right now: the running kernel booted with the desired rotation. */
  | "applied"
  /** config.txt now holds the desired rotation; it applies on the next boot. */
  | "pending-reboot"
  /** config.txt holds it, but the rotation in force could not be read back. */
  | "unconfirmed"
  /** The device has no camera by that stream key. */
  | "unknown-camera"
  /** No `dtoverlay=` line configures that camera — nothing to edit. */
  | "no-overlay"
  /** That sensor's overlay has no `rotation` parameter (or the probe failed). */
  | "unsupported"
  /** The privileged write did not happen (helper/sudoers missing, or it failed). */
  | "write-failed";

export interface CameraMountCameraState {
  streamKey: string;
  desiredDeg: CameraRotationDeg;
  /** Rotation the running kernel booted with; null = could not read it. */
  inForceDeg: number | null;
  /** Rotation config.txt now holds; null = no line (or lines disagree). */
  bootDeg: number | null;
  verdict: CameraMountVerdict;
  detail?: string;
}

export interface CameraMountState {
  at: number;
  cameras: CameraMountCameraState[];
  /** Any camera whose desired rotation is written but not yet in force. */
  rebootRequired: boolean;
  /** True when the boot config changed on THIS pass (the write actually ran). */
  wrote: boolean;
}

export interface ReconcileCameraMountOptions {
  /** The `cameraMount` namespace as settings.json holds it. */
  settings: CameraMountSettings | undefined;
  /** Model facts (stream key -> connector/sensor); optional, see resolveCamToken. */
  hardware?: DeviceHardwareBlock | null;
  /** Where the hardware reconciler caches each camera's enumerated identity. */
  pipelineDir: string;
  bootConfigPath?: string | null;
  dtRoot?: string;
  now?: () => number;
  log?: (level: "info" | "warn", msg: string) => void;
  /** Test seams. */
  probe?: OverlayProbe;
  applyRotation?: (
    sensor: string,
    camToken: string,
    deg: CameraRotationDeg,
  ) => Promise<{ ok: boolean; changed: boolean; detail: string }>;
}

/**
 * Run the privileged edit. Exit codes are the helper's contract:
 * 0 = changed, 3 = already correct (nothing written), 4 = no matching overlay
 * line, 2 = bad arguments.
 */
export async function applyRotationViaHelper(
  sensor: string,
  camToken: string,
  deg: CameraRotationDeg,
): Promise<{ ok: boolean; changed: boolean; detail: string }> {
  const res = await run("sudo", ["-n", CAMROTATE_HELPER, sensor, camToken, String(deg)], {
    timeoutMs: 20_000,
  });
  if (res.notFound) return { ok: false, changed: false, detail: "sudo not found" };
  if (res.exitCode === 3) return { ok: true, changed: false, detail: "" };
  if (!res.failed) return { ok: true, changed: true, detail: "" };
  const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`;
  return { ok: false, changed: false, detail };
}

/**
 * Which `camN` token in config.txt belongs to a stream key.
 *
 * When the device HAS a hardware block that block is the whole truth: a stream
 * key it does not declare is a camera this device does not have, and saying so
 * beats editing an overlay line that happens to share the name. Only a v1
 * device (no block at all) falls back to "a `camN` stream key stands for
 * itself" — which is exactly what the install script writes there.
 */
export function resolveCamToken(
  streamKey: string,
  hardware: DeviceHardwareBlock | null | undefined,
): string | null {
  if (hardware) {
    const entry = hardware.video.find((v) => v.key === streamKey);
    return entry ? overlayCamToken(entry.connector) : null;
  }
  return /^cam\d+$/.test(streamKey) ? streamKey : null;
}

/**
 * Make the boot config agree with the `cameraMount` namespace, and report the
 * three rotations for every camera the cloud manages.
 *
 * Returns null when the namespace is ABSENT — no camera is managed, so the
 * boot config is not read, not compared and above all not written. That is the
 * difference between "the cloud wants every camera upright" and "the cloud has
 * never said anything about this device", and it is why an installer's
 * hand-set `rotation=180` survives on an unconfigured device.
 *
 * Idempotent by construction: the helper only runs when the boot config
 * disagrees with the desired value, so a reconcile pass on a settled device is
 * a couple of file reads and nothing else.
 */
export async function reconcileCameraMount(
  opts: ReconcileCameraMountOptions,
): Promise<CameraMountState | null> {
  const cameras = opts.settings?.cameras;
  if (!cameras) return null;
  const at = (opts.now ?? Date.now)();
  const log = opts.log ?? (() => {});
  const probe = opts.probe ?? probeOverlayRotation;
  const applyRotation = opts.applyRotation ?? applyRotationViaHelper;
  const keys = Object.keys(cameras).sort();
  if (keys.length === 0) return { at, cameras: [], rebootRequired: false, wrote: false };

  const path =
    opts.bootConfigPath === undefined ? resolveBootConfigPath() : opts.bootConfigPath;
  const out: CameraMountCameraState[] = [];
  let wrote = false;

  for (const streamKey of keys) {
    const desiredDeg = cameras[streamKey]!.rotationDeg;
    const inForceDeg = readInForce(opts, streamKey);
    const base = { streamKey, desiredDeg, inForceDeg };

    const camToken = resolveCamToken(streamKey, opts.hardware);
    if (camToken === null) {
      out.push({
        ...base,
        bootDeg: null,
        verdict: "unknown-camera",
        detail: `this device has no camera "${streamKey}"`,
      });
      continue;
    }

    if (path === null) {
      out.push({
        ...base,
        bootDeg: null,
        verdict: "no-overlay",
        detail: "no config.txt on this device (looked in /boot/firmware and /boot)",
      });
      continue;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      out.push({
        ...base,
        bootDeg: null,
        verdict: "write-failed",
        detail: `cannot read ${path}: ${(err as Error).message}`,
      });
      continue;
    }

    const view = bootConfigCamera(text, camToken);
    if (view.sensor === null) {
      out.push({
        ...base,
        bootDeg: null,
        verdict: "no-overlay",
        detail: `no dtoverlay line for ${camToken} in ${path} — the camera overlay is missing`,
      });
      continue;
    }

    if (view.rotation !== desiredDeg) {
      // Support gate BEFORE any edit (Q4): truth from the box, not a list.
      const support = await probe(view.sensor);
      if (!support.ok || !support.supports) {
        out.push({
          ...base,
          bootDeg: view.rotation,
          verdict: "unsupported",
          detail: support.ok
            ? `the ${view.sensor} overlay on this device has no "rotation" parameter`
            : `could not ask dtoverlay whether ${view.sensor} supports rotation`,
        });
        continue;
      }

      const res = await applyRotation(view.sensor, camToken, desiredDeg);
      if (!res.ok) {
        out.push({
          ...base,
          bootDeg: view.rotation,
          verdict: "write-failed",
          detail:
            `could not edit ${path}: ${res.detail}` +
            " (the agent needs the xorgate-camrotate helper — run `sudo xorgate update`)",
        });
        log("warn", `${streamKey}: boot config rotation edit failed — ${res.detail}`);
        continue;
      }
      if (res.changed) {
        wrote = true;
        log(
          "info",
          `${streamKey}: ${view.sensor}/${camToken} rotation set to ${desiredDeg}° in ${path} — ` +
            "REBOOT required before the image changes (the agent never reboots itself)",
        );
      }
    }

    const bootDeg = desiredDeg;
    if (inForceDeg === null) {
      out.push({
        ...base,
        bootDeg,
        verdict: "unconfirmed",
        detail: "could not read the rotation currently in force from the device tree",
      });
      continue;
    }
    out.push({
      ...base,
      bootDeg,
      verdict: inForceDeg === desiredDeg ? "applied" : "pending-reboot",
    });
  }

  return {
    at,
    cameras: out,
    rebootRequired: out.some((c) => c.verdict === "pending-reboot"),
    wrote,
  };
}

function readInForce(opts: ReconcileCameraMountOptions, streamKey: string): number | null {
  const cameraName = cameraNameFor(opts.pipelineDir, streamKey);
  if (cameraName === null) return null;
  return dtRotationForCamera(cameraName, opts.dtRoot ?? PROC_DEVICE_TREE);
}
