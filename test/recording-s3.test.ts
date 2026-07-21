import { describe, expect, it } from "vitest";
import { encodeS3Key, signPut } from "../src/recording/s3-put.js";
import { IotCredentialsProvider, type AwsCredentials } from "../src/recording/iot-creds.js";

const CREDS: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "TOKEN",
  expiration: Date.now() + 3600_000,
};

describe("signPut", () => {
  const base = {
    region: "us-east-1",
    bucket: "my-bucket",
    key: "telemetry/v1/dev/sess/1000-00000.jsonl.gz",
    body: Buffer.from("hello"),
    contentType: "application/gzip",
    credentials: CREDS,
    nowMs: Date.UTC(2026, 6, 21, 12, 0, 0),
  };

  it("builds a virtual-hosted request with all SigV4 headers", () => {
    const signed = signPut(base);
    expect(signed.host).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(signed.path).toBe("/telemetry/v1/dev/sess/1000-00000.jsonl.gz");
    expect(signed.headers["x-amz-date"]).toBe("20260721T120000Z");
    expect(signed.headers["x-amz-security-token"]).toBe("TOKEN");
    expect(signed.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers["content-length"]).toBe("5");
    expect(signed.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260721\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it("is deterministic for fixed inputs and sensitive to the body", () => {
    const a = signPut(base);
    const b = signPut(base);
    const c = signPut({ ...base, body: Buffer.from("other") });
    expect(a.headers.authorization).toBe(b.headers.authorization);
    expect(a.headers.authorization).not.toBe(c.headers.authorization);
  });

  it("encodes reserved characters in keys but keeps slashes", () => {
    expect(encodeS3Key("a/b c/d+e*f")).toBe("a/b%20c/d%2Be%2Af");
  });
});

describe("IotCredentialsProvider", () => {
  it("caches until near expiry, then refreshes (shared in-flight fetch)", async () => {
    let fetches = 0;
    let now = 0;
    const provider = new IotCredentialsProvider({
      credentialEndpoint: "example.invalid",
      roleAlias: "alias",
      thingName: "thing",
      certPath: "/nope",
      keyPath: "/nope",
      refreshSkewMs: 1000,
      now: () => now,
      fetchFn: async () => {
        fetches++;
        return { ...CREDS, expiration: now + 10_000 };
      },
    });

    const [a, b] = await Promise.all([provider.get(), provider.get()]);
    expect(fetches).toBe(1); // concurrent callers share one fetch
    expect(a).toEqual(b);

    now = 5_000;
    await provider.get();
    expect(fetches).toBe(1); // still fresh

    now = 9_500; // within the 1 s refresh skew
    await provider.get();
    expect(fetches).toBe(2);

    provider.invalidate();
    await provider.get();
    expect(fetches).toBe(3);
  });
});
