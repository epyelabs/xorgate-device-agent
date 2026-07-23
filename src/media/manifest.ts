/**
 * KVS provisioning manifest (kvs.json) — the device-side view of what the media
 * runtime needs to connect as a KVS WebRTC master: the device's region, the IoT
 * credential-provider endpoint + role alias (so the existing device cert mints
 * KVS creds), and the signaling channels to serve.
 *
 * This is the SAME shape the install script writes to /etc/xorgate/kvs.json and
 * that `xorgate-device-agent/scripts/provision-test-device.mjs` writes into
 * ./creds/kvs.json for the synthetic-master rig. Keeping the shape identical lets
 * the agent-managed runtime drop into the exact path the frontend viewer expects.
 *
 * loadManifest NEVER throws: a missing/corrupt/incomplete file is treated as "no
 * media config" (returns null), so the media collector self-gates like the IMU
 * one rather than crashing the daemon.
 */
import { readFileSync } from "node:fs";
import { atomicWriteJson } from "../lib/atomicWrite.js";

export interface KvsChannel {
  streamKey: string;
  channelName: string;
}

export interface KvsManifest {
  deviceId: string;
  region: string;
  credentialEndpoint: string;
  roleAlias: string;
  channels: KvsChannel[];
  /**
   * S3 bucket recording-segment uploads PUT into (offline recording plan,
   * Phase 2). Optional: pre-Phase-2 manifests don't carry it; without it the
   * agent's uploader stays disabled. Written by the install script from the
   * claim response; XORGATE_UPLOAD_BUCKET env overrides for dev/test.
   */
  uploadBucket?: string;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Parse + validate the manifest at `path`, or null when absent/invalid/incomplete. */
export function loadManifest(path: string): KvsManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // missing or unparseable — caller stays inert
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (
    !nonEmptyString(o.deviceId) ||
    !nonEmptyString(o.region) ||
    !nonEmptyString(o.credentialEndpoint) ||
    !nonEmptyString(o.roleAlias)
  ) {
    return null;
  }

  const channels: KvsChannel[] = [];
  if (Array.isArray(o.channels)) {
    for (const c of o.channels) {
      if (c && typeof c === "object") {
        const streamKey = (c as Record<string, unknown>).streamKey;
        const channelName = (c as Record<string, unknown>).channelName;
        if (nonEmptyString(streamKey) && nonEmptyString(channelName)) {
          channels.push({ streamKey, channelName });
        }
      }
    }
  }

  return {
    deviceId: o.deviceId,
    region: o.region,
    credentialEndpoint: o.credentialEndpoint,
    roleAlias: o.roleAlias,
    channels,
    ...(nonEmptyString(o.uploadBucket) ? { uploadBucket: o.uploadBucket } : {}),
  };
}

/**
 * Persist the cloud-delivered `uploadBucket` into kvs.json (offline recording
 * plan, Phase 6.2 backfill): devices fielded before Phase 2 provisioning have
 * no `uploadBucket` in their manifest and silently cannot upload. The retained
 * config message now carries the bucket, and this writes it in place — the
 * cloud value is authoritative, so an existing different value is overwritten.
 * All other manifest fields (including unknown ones) are preserved verbatim.
 *
 * Returns "applied" when the file changed, "unchanged" when the bucket already
 * matches (the retained message redelivers on every reconnect — must no-op),
 * and "no-manifest" when kvs.json is absent/unreadable (nothing to backfill
 * into: without credentialEndpoint etc. the uploader couldn't run anyway).
 */
export function persistUploadBucket(
  path: string,
  bucket: string,
): "applied" | "unchanged" | "no-manifest" {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "no-manifest";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "no-manifest";
  const o = raw as Record<string, unknown>;
  if (o.uploadBucket === bucket) return "unchanged";
  o.uploadBucket = bucket;
  atomicWriteJson(path, o);
  return "applied";
}
