/**
 * IoT credential-provider client (plan D3): exchanges the device's X.509 cert
 * for short-lived AWS credentials via the account's IoT credentials endpoint
 * (`https://<endpoint>/role-aliases/<alias>/credentials`, mTLS). This is the
 * same exchange the KVS WebRTC C runtime already performs; the agent now needs
 * the creds itself for S3 segment uploads.
 *
 * Caching: creds are vended for 1 h (role-alias `credentialDurationSeconds`);
 * we refresh when within `refreshSkewMs` (default 5 min) of expiry. Concurrent
 * callers share one in-flight fetch.
 */
import { readFileSync } from "node:fs";
import { request } from "node:https";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch ms when these credentials expire. */
  expiration: number;
}

export interface IotCredentialsOptions {
  /** Credentials endpoint host (no scheme), e.g. cXXXX.credentials.iot.us-east-1.amazonaws.com */
  credentialEndpoint: string;
  roleAlias: string;
  /** IoT thing name (== deviceId) — sent as x-amzn-iot-thingname. */
  thingName: string;
  certPath: string;
  keyPath: string;
  /** Refresh when creds are within this many ms of expiring. Default 5 min. */
  refreshSkewMs?: number;
  /** Request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Injectable transport for tests. */
  fetchFn?: () => Promise<AwsCredentials>;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

export class IotCredentialsProvider {
  private readonly opts: IotCredentialsOptions;
  private cached: AwsCredentials | null = null;
  private inflight: Promise<AwsCredentials> | null = null;

  constructor(opts: IotCredentialsOptions) {
    this.opts = opts;
  }

  /** Current creds, fetching/refreshing as needed. Rejects on network/HTTP failure. */
  async get(): Promise<AwsCredentials> {
    const now = (this.opts.now ?? Date.now)();
    const skew = this.opts.refreshSkewMs ?? DEFAULT_SKEW_MS;
    if (this.cached && this.cached.expiration - now > skew) return this.cached;
    if (!this.inflight) {
      this.inflight = (this.opts.fetchFn ?? (() => this.fetch()))().finally(() => {
        this.inflight = null;
      });
    }
    const creds = await this.inflight;
    this.cached = creds;
    return creds;
  }

  /** Drop the cache (e.g. after an auth failure) so the next get() re-fetches. */
  invalidate(): void {
    this.cached = null;
  }

  private fetch(): Promise<AwsCredentials> {
    // Cert/key are re-read per fetch (~hourly) so a cert rotation needs no restart.
    const cert = readFileSync(this.opts.certPath);
    const key = readFileSync(this.opts.keyPath);
    return new Promise<AwsCredentials>((resolve, reject) => {
      const req = request(
        {
          host: this.opts.credentialEndpoint,
          method: "GET",
          path: `/role-aliases/${encodeURIComponent(this.opts.roleAlias)}/credentials`,
          headers: { "x-amzn-iot-thingname": this.opts.thingName },
          cert,
          key,
          timeout: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `IoT credentials fetch failed: HTTP ${res.statusCode} ${body.slice(0, 200)}`,
                ),
              );
              return;
            }
            try {
              const parsed = JSON.parse(body) as {
                credentials?: {
                  accessKeyId?: string;
                  secretAccessKey?: string;
                  sessionToken?: string;
                  expiration?: string;
                };
              };
              const c = parsed.credentials;
              if (!c?.accessKeyId || !c.secretAccessKey || !c.sessionToken || !c.expiration) {
                reject(new Error("IoT credentials response missing fields"));
                return;
              }
              resolve({
                accessKeyId: c.accessKeyId,
                secretAccessKey: c.secretAccessKey,
                sessionToken: c.sessionToken,
                expiration: Date.parse(c.expiration),
              });
            } catch (err) {
              reject(new Error(`IoT credentials response unparseable: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("IoT credentials fetch timed out")));
      req.on("error", reject);
      req.end();
    });
  }
}
