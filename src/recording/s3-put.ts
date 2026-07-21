/**
 * Minimal S3 PutObject over HTTPS with hand-rolled SigV4 (plan D3).
 *
 * Deliberately NOT @aws-sdk/client-s3: the agent ships as plain tsc output and
 * deploys by rsyncing dist/ alone (no npm install on the device), so runtime
 * deps are limited to what package.json already carries. A single virtual-host
 * PUT with a signed payload is ~100 lines of node:crypto — well inside that
 * budget, and segments are ≤ ~30 MB so no multipart is ever needed.
 */
import { createHash, createHmac } from "node:crypto";
import { request } from "node:https";
import type { AwsCredentials } from "./iot-creds.js";

export interface S3PutOptions {
  region: string;
  bucket: string;
  /** Object key, no leading slash. */
  key: string;
  body: Buffer;
  contentType: string;
  credentials: AwsCredentials;
  signal?: AbortSignal;
  /** Request timeout (covers connect + upload of one segment). Default 60 s. */
  timeoutMs?: number;
  /** Epoch-ms clock override for tests. */
  nowMs?: number;
}

const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encode a key, keeping `/` as the segment separator. */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export interface SignedHeaders {
  host: string;
  path: string;
  headers: Record<string, string>;
}

/**
 * Build the signed request pieces for a virtual-hosted PUT. Pure — exported for
 * unit tests (deterministic given nowMs + fixed creds).
 */
export function signPut(opts: S3PutOptions): SignedHeaders {
  const { region, bucket, key, body, contentType, credentials } = opts;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${encodeS3Key(key)}`;
  const now = new Date(opts.nowMs ?? Date.now());
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256(body);

  const headers: Record<string, string> = {
    "content-type": contentType,
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": credentials.sessionToken,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "PUT",
    path,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    host,
    path,
    headers: {
      ...headers,
      "content-length": String(body.length),
      authorization:
        `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** PUT the object; resolves on 200, rejects with status + body excerpt otherwise. */
export function s3Put(opts: S3PutOptions): Promise<void> {
  const signed = signPut(opts);
  return new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: signed.host,
        method: "PUT",
        path: signed.path,
        headers: signed.headers,
        timeout: opts.timeoutMs ?? 60_000,
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`S3 PUT failed: HTTP ${res.statusCode} ${body.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("S3 PUT timed out")));
    req.on("error", reject);
    req.end(opts.body);
  });
}
