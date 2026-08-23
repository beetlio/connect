import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { create as createTar } from "tar";

import { buildIntegration } from "@beetlio/connect/builder";
import { fixtureDirectory } from "./support.ts";

const HostPath = resolve("dist/server-host.js");

test("server host inspects, verifies, and syncs an uploaded package", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-server-host");
  const packageDirectory = join(directory, "package");
  const archive = join(directory, "fixture.tgz");
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "integration.ts"),
    `
      import { auth, defineIntegration, input, z } from "@beetlio/connect";

      if (process.env.BEETL_CONNECT_TEST_STDOUT === "1") console.log("integration import output");

      export default defineIntegration({
        key: "fixture",
        displayName: "Fixture",
        connection: {
          origin: "https://api.example.com",
          auth: auth.oauth2AuthorizationCode({
            issuer: "https://auth.example.com",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: ["read"],
            clientSecret: true,
          }),
          inputs: input.object({ prefix: input.string() }),
          async verify(ctx) {
            if (ctx.config.prefix !== "ready") throw new Error("not ready");
          },
        },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.object({ id: z.string() }),
          checkpoint: z.object({ cursor: z.string() }),
          inputs: input.object({ suffix: input.string() }),
          async run(ctx) {
            if (ctx.config.sync.suffix === "hang") await new Promise(() => undefined);
            if (process.env.BEETL_CONNECT_TEST_STDOUT === "1") console.log("integration run output");
            await ctx.emit({
              records: [{
                id: ctx.config.sync.suffix === "envelope-limit"
                  ? "x".repeat(8 * 1024 * 1024 - 116)
                  : ctx.config.connection.prefix + ctx.config.sync.suffix,
              }],
              checkpoint: { cursor: "next" },
            });
          },
        })],
      });
    `,
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      private: true,
      type: "module",
      files: ["integration.ts"],
    }),
  );
  await writeFile(
    join(packageDirectory, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fixture", version: "0.0.0" } },
    }),
  );
  await createTar({ cwd: directory, file: archive, gzip: true }, ["package"]);
  const runtimePath = join(directory, "runtime.tgz");
  await writeFile(runtimePath, (await buildIntegration(packageDirectory)).archive);

  const inspectPath = join(directory, "inspect.json");
  await runHost({ operation: "inspect", integrationPath: archive, resultPath: inspectPath });
  const inspected = JSON.parse(await readFile(inspectPath, "utf8")) as {
    manifest: { manifestVersion: number; integration: { key: string } };
  };
  assert.equal(inspected.manifest.manifestVersion, 2);
  assert.equal(inspected.manifest.integration.key, "fixture");

  const credentials = { clientId: "client-id", clientSecret: "client-secret" };
  const authorizationState = {
    accessToken: "access-token",
    refreshToken: null,
    tokenFields: {},
  };
  const oauthPath = join(directory, "oauth.json");
  await runHost({
    operation: "oauth_start",
    integrationPath: archive,
    resultPath: oauthPath,
    credentials,
    redirectUri: "https://app.example/oauth/callback",
  });
  const oauth = JSON.parse(await readFile(oauthPath, "utf8")) as {
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
  };
  const authorizationUrl = new URL(oauth.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://auth.example.com");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "client-id");
  assert.equal(authorizationUrl.searchParams.get("state"), oauth.state);
  assert.ok(oauth.codeVerifier);

  const verifyPath = join(directory, "verify.json");
  await runHost({
    operation: "verify",
    integrationPath: archive,
    resultPath: verifyPath,
    connectionConfig: { prefix: "ready" },
    credentials,
    authorizationState: null,
    syncs: [{ key: "items", configuration: { suffix: "-item" } }],
  });

  const resultPath = join(directory, "sync.json");
  const syncRequest = {
    operation: "sync",
    runtimePath,
    resultPath,
    syncKey: "items",
    connectionConfig: { prefix: "ready" },
    syncConfig: { suffix: "-item" },
    credentials,
    authorizationState,
  };
  const envelopes = await runRuntimeHost(syncRequest);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    outcome: "completed",
    batches: 1,
    records: 1,
    deleted: 0,
    checkpoint: { cursor: "next" },
    authorizationState: { accessToken: "access-token", tokenFields: {} },
  });
  const batch = {
    protocolVersion: 1,
    kind: "batch",
    batchId: envelopes[0]?.batchId,
    sequence: 0,
    records: [{ id: "ready-item" }],
    checkpoint: { cursor: "next" },
  };
  assert.deepEqual(envelopes, [batch]);

  const oversizedError = await runRejectedRuntimeHost({
    ...syncRequest,
    resultPath: join(directory, "oversized.json"),
    syncConfig: { suffix: "envelope-limit" },
  });
  assert.match(oversizedError, /Emitted batch exceeds 8388608 bytes/);

  const hanging = spawn(process.execPath, [HostPath], { stdio: ["pipe", "ignore", "pipe"] });
  t.after(() => hanging.kill("SIGKILL"));
  hanging.stderr.resume();
  const closed = once(hanging, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  hanging.stdin.write(
    `${JSON.stringify({ ...syncRequest, resultPath: join(directory, "hung.json"), syncConfig: { suffix: "hang" } })}\n`,
  );
  await delay(100);
  assert.equal(hanging.kill("SIGTERM"), true);
  const [status, signal] = await Promise.race([
    closed,
    delay(2_000).then(() => {
      throw new Error("Runtime ignored SIGTERM");
    }),
  ]);
  assert.equal(status, null);
  assert.equal(signal, "SIGTERM");
});

test("server host rejects bounded initial input without waiting for stdin to close", async (t) => {
  for (const [input, expected] of [
    ["not-json\n", /Host request is not valid JSON/],
    [Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), /Host request is too large/],
  ] as const) {
    const child = spawn(process.execPath, [HostPath], { stdio: ["pipe", "ignore", "pipe"] });
    t.after(() => child.kill("SIGKILL"));
    child.stdin.on("error", () => undefined);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.write(input);
    const [status] = await Promise.race([
      once(child, "close") as Promise<[number | null]>,
      delay(5_000).then(() => {
        throw new Error("Runtime waited for the controller to close stdin");
      }),
    ]);
    assert.equal(status, 1);
    assert.match(stderr, expected);
  }
});

async function runRuntimeHost(request: object): Promise<Record<string, unknown>[]> {
  const child = spawn(process.execPath, [HostPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BEETL_CONNECT_TEST_STDOUT: "1" },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = once(child, "close") as Promise<[number | null]>;
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const batches: Record<string, unknown>[] = [];
  child.stdin.write(`${JSON.stringify(request)}\n`);
  for await (const line of output) {
    const batch = JSON.parse(line) as Record<string, unknown>;
    batches.push(batch);
    child.stdin.write(
      `${JSON.stringify({
        protocolVersion: 1,
        kind: "batch_committed",
        batchId: batch.batchId,
        action: "continue",
      })}\n`,
    );
  }
  child.stdin.end();
  const [status] = await closed;
  assert.equal(status, 0, stderr);
  assert.match(stderr, /integration import output/);
  assert.match(stderr, /integration run output/);
  return batches;
}

async function runRejectedRuntimeHost(request: object): Promise<string> {
  const child = spawn(process.execPath, [HostPath], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [status] = (await once(child, "close")) as [number | null];
  assert.equal(status, 1, "Runtime unexpectedly accepted an oversized envelope");
  return stderr;
}

async function runHost(request: object): Promise<void> {
  const child = spawn(process.execPath, [HostPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(request));
  const [status] = (await once(child, "close")) as [number | null];
  assert.equal(status, 0, stderr);
}
