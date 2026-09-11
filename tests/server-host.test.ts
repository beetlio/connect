import { buildIntegration } from "@beetlio/connect/builder";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create as createTar } from "tar";
import { fixtureDirectory, integrationPackage } from "./support.ts";

const HostPath = resolve("dist/server-host.js");

test("server host inspects, verifies, and syncs an uploaded package", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-server-host");
  const packageDirectory = join(directory, "package");
  const archive = join(directory, "fixture.tgz");

  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "integration.ts"),
    `import { auth, defineIntegration, z } from "@beetlio/connect";
if (process.env.BEETL_CONNECT_TEST_STDOUT === "1") console.log("integration import output");
export default defineIntegration({
  key: "fixture",
  displayName: "Fixture",
  connection: {
    origin: "https://api.example.com",
    auth: auth.oauth2({
      issuer: "https://auth.example.com",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      scopes: ["read"],
      clientSecret: true,
    }),
    inputs: z.strictObject({ prefix: z.string() }),
    async verify(ctx) {
      if (ctx.config.prefix !== "ready") throw new Error("not ready");

      await ctx.log.info("Connection verified", { prefix: ctx.config.prefix });
      void ctx.log.warn("Verification warning");
    },
  },
  syncs: (defineSync) => ({
    items: defineSync({
      displayName: "Items",
      records: z.object({ id: z.string() }),
      checkpoint: z.json(),
      inputs: z.strictObject({ suffix: z.string() }),
      async *run(ctx) {
        if (ctx.config.sync.suffix === "hang") await new Promise(() => undefined);
        if (process.env.BEETL_CONNECT_TEST_STDOUT === "1")
          console.log("integration run output");

        if (ctx.config.sync.suffix === "checkpoint") {
          yield {
            records: [{ id: "checkpoint" }],
            ...(ctx.checkpoint === undefined ? {} : { checkpoint: ctx.checkpoint }),
          };

          return;
        }

        if (ctx.checkpoint !== undefined) return;

        yield {
          records: [
            {
              id:
                ctx.config.sync.suffix === "envelope-limit"
                  ? "x".repeat(8 * 1024 * 1024 - 116)
                  : ctx.config.connection.prefix + ctx.config.sync.suffix,
            },
          ],
          checkpoint: { cursor: "next" },
        };
      },
    }),
  }),
});
`,
  );
  await integrationPackage(packageDirectory);
  await createTar({ cwd: directory, file: archive, gzip: true }, ["package"]);

  const runtimePath = join(directory, "runtime.tgz");

  await writeFile(runtimePath, (await buildIntegration(packageDirectory)).archive);

  const inspectPath = join(directory, "inspect.json");

  await runHost({ operation: "inspect", integrationPath: archive, resultPath: inspectPath });

  const inspected = JSON.parse(await readFile(inspectPath, "utf8")) as {
    manifest: {
      manifestVersion: number;
      integration: {
        key: string;
      };
    };
  };

  assert.equal(inspected.manifest.manifestVersion, 3);
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

  const verificationLogs = await runHost({
    operation: "verify",
    integrationPath: archive,
    resultPath: verifyPath,
    connectionConfig: { prefix: "ready" },
    credentials,
    authorizationState: null,
    syncs: [{ key: "items", configuration: { suffix: "-item" } }],
  });

  assert.deepEqual(
    verificationLogs
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      { level: "info", message: "Connection verified", fields: { prefix: "ready" } },
      { level: "warn", message: "Verification warning", fields: {} },
    ],
  );

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
  const completed = await runRuntimeHost(syncRequest);

  assert.equal(completed.status, 0, completed.stderr);

  const completedResult = JSON.parse(await readFile(resultPath, "utf8"));

  assert.deepEqual(completedResult, {
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
    batchId: completed.batches[0]?.batchId,
    sequence: 0,
    records: [{ id: "ready-item" }],
    checkpoint: { cursor: "next" },
  };

  assert.deepEqual(completed.batches, [batch]);

  const yielded = await runRuntimeHost(
    { ...syncRequest, protocolVersion: 1 },
    { protocolVersion: 1, action: "yield" },
  );
  const continuation = JSON.parse(await readFile(resultPath, "utf8"));

  assert.equal(yielded.status, 0, yielded.stderr);
  assert.deepEqual(yielded.batches, [{ ...batch, batchId: yielded.batches[0]?.batchId }]);
  assert.deepEqual(continuation, { ...completedResult, outcome: "continuation_required" });

  const resumed = await runRuntimeHost({
    ...syncRequest,
    protocolVersion: 1,
    checkpoint: continuation.checkpoint,
  });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(resumed.batches, []);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    outcome: "completed",
    batches: 0,
    records: 0,
    deleted: 0,
    checkpoint: continuation.checkpoint,
    authorizationState: { accessToken: "access-token", tokenFields: {} },
  });

  const checkpoint = await runRuntimeHost({
    ...syncRequest,
    protocolVersion: 1,
    syncConfig: { suffix: "checkpoint" },
    checkpoint: null,
  });

  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  assert.equal(checkpoint.batches[0]?.checkpoint, null);
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).checkpoint, null);

  const badAck = await runRuntimeHost(syncRequest, { protocolVersion: 999, action: "continue" });

  assert.equal(badAck.status, 1);
  assert.match(badAck.stderr, /Unsupported execution protocol version 999.*supported: 1/);

  const oversized = await runRuntimeHost({
    ...syncRequest,
    resultPath: join(directory, "oversized.json"),
    syncConfig: { suffix: "envelope-limit" },
  });

  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /Emitted batch exceeds 8388608 bytes/);

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
    delay(2000).then(() => {
      throw new Error("Runtime ignored SIGTERM");
    }),
  ]);

  assert.equal(status, null);
  assert.equal(signal, "SIGTERM");
});

test("server host rejects invalid initial requests without waiting for stdin to close", async (t) => {
  for (const [input, expected] of [
    ["not-json\n", /Host request is not valid JSON/],
    [Buffer.alloc(4 * 1024 * 1024 + 1, 0x20), /Host request is too large/],
    ['{"protocolVersion":999}\n', /Unsupported execution protocol version 999.*Upgrade/],
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
      delay(5000).then(() => {
        throw new Error("Runtime waited for the controller to close stdin");
      }),
    ]);

    assert.equal(status, 1);
    assert.match(stderr, expected);
  }
});

async function runRuntimeHost(
  request: object,
  acknowledgment: { readonly protocolVersion: number; readonly action: "continue" | "yield" } = {
    protocolVersion: 1,
    action: "continue",
  },
) {
  const child = spawn(process.execPath, [HostPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BEETL_CONNECT_TEST_STDOUT: "1" },
    timeout: 15_000,
  });
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});

  const closed = once(child, "close") as Promise<[number | null]>;
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const batches: Record<string, unknown>[] = [];

  child.stdin.write(`${JSON.stringify(request)}\n`);

  try {
    for await (const line of output) {
      const batch = JSON.parse(line) as Record<string, unknown>;

      batches.push(batch);
      child.stdin.write(
        `${JSON.stringify({
          ...acknowledgment,
          kind: "batch_committed",
          batchId: batch.batchId,
        })}\n`,
      );
    }

    child.stdin.end();

    const [status] = await closed;

    assert.match(stderr, /integration import output/);
    assert.match(stderr, /integration run output/);

    return { status, stderr, batches };
  } finally {
    child.kill("SIGKILL");
  }
}

async function runHost(request: object): Promise<string> {
  const child = spawn(process.execPath, [HostPath], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(request));

  const [status] = (await once(child, "close")) as [number | null];

  assert.equal(status, 0, stderr);

  return stderr;
}
