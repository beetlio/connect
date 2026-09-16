import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { signS3Request } from "../src/aws-sigv4.ts";
import { auth, defineIntegration, input, z } from "@beetlio/connect";
import { LocalHost } from "../src/local-host.ts";
import { validateIntegration } from "@beetlio/connect/host";
import { assumeAwsRole } from "../src/aws-role.ts";

test("role credentials refresh before expiry, share concurrent renewal and stay per host", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let renewals = 0;
  const tokens: string[] = [];
  const options = {
    origin: "https://bucket.s3.eu-west-1.amazonaws.com",
    auth: auth.awsSigV4({ region: "eu-west-1", service: "s3", credentialSource: "assume_role" }),
    credentials: { roleArn: "arn:aws:iam::123456789012:role/beetl" },
    outputPath: "unused",
    statePath: "unused",
    awsCredentials: async () => {
      const number = ++renewals;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: `session-${number}`,
        expiration: now + 120_000,
      };
    },
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("x-amz-security-token")!);
      return new Response("ok");
    },
  };
  const host = new LocalHost(options);
  const request = { method: "GET" as const, path: "/", headers: [] };
  await Promise.all([host.request(request), host.request(request)]);
  assert.equal(renewals, 1);
  now += 70_000;
  await Promise.all([host.request(request), host.request(request)]);
  assert.equal(renewals, 2);
  assert.deepEqual(tokens, ["session-1", "session-1", "session-2", "session-2"]);
  await new LocalHost(options).request(request);
  assert.equal(renewals, 3);
  await assert.rejects(
    new LocalHost({
      ...options,
      awsCredentials: async () => ({
        accessKeyId: "key",
        secretAccessKey: "secret",
        sessionToken: "expired",
        expiration: now,
      }),
    }).request(request),
    /expiring/,
  );
});

test("role trust must reject missing and incorrect tenant IDs before issuing credentials", async () => {
  const role = "arn:aws:iam::123456789012:role/beetl";
  const externalId = "beetl-11111111-1111-1111-1111-111111111111";
  const seen: (string | undefined)[] = [];
  const provider: Parameters<typeof assumeAwsRole>[3] = (options) => async () => {
    seen.push(options.params.ExternalId);
    if (options.params.ExternalId !== externalId)
      throw Object.assign(new Error("Denied"), { name: "AccessDenied" });
    return {
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: "session",
      expiration: new Date(Date.now() + 3600000),
    };
  };
  assert.equal(
    (await assumeAwsRole(role, externalId, "eu-west-1", provider)).sessionToken,
    "session",
  );
  assert.equal(seen.length, 3);
  assert.equal(seen[0], undefined);
  assert.notEqual(seen[1], externalId);
  assert.equal(seen[2], externalId);
  await assert.rejects(
    assumeAwsRole(role, externalId, "eu-west-1", () => async () => ({
      accessKeyId: "key",
      secretAccessKey: "secret",
    })),
    /exact Beetl external ID/,
  );
  await assert.rejects(
    assumeAwsRole(role, "customer-supplied", "eu-west-1", provider),
    /Invalid AWS role binding/,
  );
});

test("S3 signature matches an independently assembled canonical GET request", () => {
  const credentials = {
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "",
  };
  const headers = new Headers({ range: "bytes=0-9" });
  signS3Request(
    new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    "GET",
    headers,
    undefined,
    credentials,
    new Date("2013-05-24T00:00:00Z"),
  );
  const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const canonical = `GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:${empty}\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n${empty}`;
  const hmac = (key: Buffer | string, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const key = hmac(
    hmac(hmac(hmac("AWS4" + credentials.secretAccessKey, "20130524"), "us-east-1"), "s3"),
    "aws4_request",
  );
  const signature = hmac(
    key,
    "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n" +
      createHash("sha256").update(canonical).digest("hex"),
  ).toString("hex");
  assert.ok(headers.get("authorization")!.endsWith("Signature=" + signature));
});

test("S3 signs query values, temporary tokens and conditional ranges inside the host", async () => {
  const host = new LocalHost({
    origin: "https://bucket.s3.eu-west-1.amazonaws.com",
    connectionConfig: { region: "eu-west-1" },
    auth: auth.awsSigV4({ region: { input: "region" }, service: "s3" }),
    credentials: { accessKeyId: "key", secretAccessKey: "secret", sessionToken: "session" },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-amz-security-token"), "session");
      assert.match(headers.get("authorization")!, /eu-west-1\/s3\/aws4_request/);
      assert.match(
        headers.get("authorization")!,
        /SignedHeaders=host;if-match;range;x-amz-content-sha256;x-amz-date;x-amz-security-token/,
      );
      assert.equal(new URL(String(url)).pathname, "/folder/a%20b.csv");
      assert.equal(headers.get("secretAccessKey"), null);
      return new Response("data");
    },
  });
  await host.request({
    method: "GET",
    path: "/folder/a%20b.csv?z=%2B&a=1&a=0",
    headers: [
      ["range", "bytes=0-3"],
      ["if-match", '"etag"'],
    ],
  });
  await assert.rejects(
    host.request({ method: "GET", path: "https://evil.example/", headers: [] }),
    /origin/,
  );
});

test("AWS manifests require a real region input and secret credentials", () => {
  const integration = defineIntegration({
    key: "s3",
    displayName: "S3",
    connection: {
      origin: "https://bucket.s3.eu-west-1.amazonaws.com",
      inputs: input.object({ region: input.string() }),
      auth: auth.awsSigV4({ region: { input: "region" }, service: "s3" }),
    },
    syncs: (define) => [
      define({
        key: "rows",
        displayName: "Rows",
        records: z.object({ id: z.string() }),
        async run() {},
      }),
    ],
  });
  validateIntegration(integration);
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: {
          ...integration.connection,
          auth: auth.awsSigV4({ region: { input: "missing" }, service: "s3" }),
        },
      }),
    /region/,
  );
});
