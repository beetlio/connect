import { defineIntegration, z } from "@beetlio/connect";
import { buildIntegration } from "@beetlio/connect/builder";
import { createProvider, runSync, withFileSink } from "@beetlio/connect/host";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fixtureDirectory, integrationPackage } from "./support.ts";

const CliPath = resolve("dist/cli/main.js");
const ConnectionRevision = "22222222-2222-4222-8222-222222222222";
const Provider = {
  origin: "https://api.example.com",
  authentication: { type: "none" },
};

function runCli(cwd: string, args: readonly string[], preload?: string) {
  const home = join(cwd, "user-home");
  const configHome = join(cwd, "user-config");
  const result = spawnSync(
    process.execPath,
    [...(preload === undefined ? [] : ["--import", pathToFileURL(preload).href]), CliPath, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        LOCALAPPDATA: configHome,
      },
    },
  );

  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function configDirectory(cwd: string) {
  return process.platform === "darwin"
    ? join(cwd, "user-home/Library/Preferences/beetl-connect")
    : process.platform === "win32"
      ? join(cwd, "user-config/beetl-connect/Config")
      : join(cwd, "user-config/beetl-connect");
}

test("CLI masks write-only credentials without a password widget", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-secret");
  const bootstrap = join(directory, "terminal.mjs");

  await integrationPackage(directory);
  await writeFile(
    bootstrap,
    `Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
`,
  );
  await writeFile(
    join(directory, "integration.ts"),
    `import { auth, defineIntegration, z } from "@beetlio/connect";

export default defineIntegration({
  key: "masked",
  displayName: "Masked",
  connection: {
    origin: "https://api.example.com",
    auth: {
      ...auth.bearer(),
      credentials: z.strictObject({
        token: z.string().meta({ writeOnly: true, title: "Secret token" }),
      }),
    },
  },
  syncs: (sync) => ({
    items: sync({ records: z.object({ id: z.string() }), async *run() {} }),
  }),
});
`,
  );

  const home = join(directory, "user-home");
  const configHome = join(directory, "user-config");
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(bootstrap).href, CliPath, "configure", directory],
    {
      cwd: directory,
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: configHome,
        APPDATA: configHome,
        LOCALAPPDATA: configHome,
      },
    },
  );
  const closed = once(child, "close");
  const secret = "must-stay-masked";
  let output = "";
  let stderr = "";
  let entered = false;

  t.after(() => child.kill("SIGKILL"));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;

    if (!entered && output.includes("Secret token")) {
      entered = true;
      child.stdin.write(`${secret}\r`);
    }

    if (output.includes("Configured Masked/items")) child.stdin.end();
  });

  const [status] = await closed;

  assert.equal(status, 0, stderr);
  assert.equal(entered, true);
  assert.ok(!stripVTControlCharacters(output + stderr).includes(secret));

  const connection = join(configDirectory(directory), "connections/masked/default.json");

  assert.deepEqual(JSON.parse(await readFile(connection, "utf8")).credentials, { token: secret });
});

test("CLI configures, syncs, and resumes a source integration", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli");
  const workingDirectory = join(directory, "workspace");
  const sourceOutput = join(directory, "source.ndjson");

  await mkdir(workingDirectory);
  await integrationPackage(directory);
  await writeFile(
    join(directory, "integration.ts"),
    `import { defineIntegration, z } from "@beetlio/connect";
export default defineIntegration({
  key: "fixture",
  displayName: "Fixture",
  connection: {
    origin: "https://api.example.com",
    inputs: z.strictObject({ prefix: z.string() }),
    async verify(ctx) {
      if (ctx.config.prefix !== "configured") throw new Error("connection config failed");
    },
  },
  syncs: (defineSync) => ({
    items: defineSync({
      displayName: "Items",
      records: z.object({ id: z.string() }),
      checkpoint: z.number(),
      inputs: z.strictObject({
        label: z.string().regex(new RegExp("^ x $")),
      }),
      async *run(ctx) {
        if (ctx.checkpoint !== undefined) return;

        yield {
          records: [
            {
              id: \`\${ctx.config.connection.prefix}-\${ctx.config.sync.label}\`,
            },
          ],
          checkpoint: 1,
        };
      },
    }),
  }),
});
`,
  );

  const profile = join(configDirectory(workingDirectory), "profiles/fixture/items/default.json");
  const connection = join(configDirectory(workingDirectory), "connections/fixture/primary.json");
  const configured = runCli(workingDirectory, [
    "configure",
    directory,
    "items",
    "--connection",
    "primary",
    "--inputs",
    '{"connection":{"prefix":"configured"},"sync":{"label":" x "}}',
  ]);

  assert.equal(configured.status, 0, configured.stderr);

  const savedProfile = JSON.parse(await readFile(profile, "utf8"));
  const savedConnection = JSON.parse(await readFile(connection, "utf8"));

  assert.deepEqual(savedProfile.inputs, { label: " x " });
  assert.deepEqual(savedConnection.inputs, {
    prefix: "configured",
  });

  const sourceState = join(directory, "source-state.json");
  const sync = () =>
    runCli(workingDirectory, ["sync", directory, "--output", sourceOutput, "--state", sourceState]);
  const sourceSync = sync();

  assert.equal(sourceSync.status, 0, sourceSync.stderr);

  await assert.rejects(access(`${sourceState}.lock`));

  assert.equal(JSON.parse(await readFile(sourceState, "utf8")), 1);

  const resumed = sync();

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse((await readFile(sourceOutput, "utf8")).trim()), {
    id: "configured- x ",
  });
});

test("CLI requires a sync key only when the choice is ambiguous", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-syncs");

  await integrationPackage(directory);

  const entry = join(directory, "integration.ts");
  const source = `import { defineIntegration, z } from "@beetlio/connect";
export default defineIntegration({
  key: "multiple",
  displayName: "Multiple",
  connection: { origin: "https://api.example.com" },
  syncs: (sync) =>
    Object.fromEntries(
      ["first", "second"].map((key) => [
        key,
        sync({
          displayName: key,
          records: z.object({ id: z.string() }),
          checkpoint: z.object({ cursor: z.string() }),
          async *run(ctx) {
            yield { records: [{ id: key }], checkpoint: { cursor: key } };
          },
        }),
      ]),
    ),
});
`;

  await writeFile(entry, source);

  const missing = runCli(directory, ["sync", directory]);

  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /choose one: first, second/);

  const missingProfile = runCli(directory, ["sync", directory, "second", "--profile", "prodution"]);

  assert.equal(missingProfile.status, 1);
  assert.match(missingProfile.stderr, /Profile "prodution" does not exist/);

  const output = join(directory, "second.ndjson");
  const selected = runCli(directory, ["sync", directory, "second", "--output", output]);

  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { id: "second" });
});

test("CLI and process adapters preserve execution errors and settle before success", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-errors");

  await integrationPackage(directory);
  await writeFile(
    join(directory, "integration.ts"),
    `import { auth, defineIntegration, z } from "@beetlio/connect";
export default defineIntegration({
  key: "errors",
  displayName: "Errors",
  connection: {
    origin: "https://api.example.com",
    auth: auth.tokenExchange({
      credentials: z.strictObject({ token: z.string().meta({ writeOnly: true }) }),
      request: { path: "/token", headers: { "x-key": { credential: "token" } } },
      response: { tokenPath: "token", expiry: { type: "fixed", seconds: 3600 } },
    }),
    async verify(ctx) {
      try {
        await ctx.fetch("/items");
      } catch (cause) {
        throw new Error("bad credentials", { cause });
      }
    },
  },
  syncs: (sync) => ({
    items: sync({
      displayName: "Items",
      records: z.object({ id: z.string() }),
      mode: "replace",
      inputs: z.strictObject({ ignoreFailure: z.boolean().default(false) }),
      async *run(ctx) {
        try {
          await ctx.fetch("/items");
        } catch (cause) {
          if (!ctx.config.sync.ignoreFailure) throw new Error("sync failed", { cause });
        }

        yield { records: [{ id: "replacement" }] };
      },
    }),
  }),
});
`,
  );

  const bootstrap = join(directory, "provider.mjs");
  const runtimePath = join(directory, "runtime.tgz");
  const built = await buildIntegration(directory);

  await writeFile(
    bootstrap,
    'globalThis.fetch = async () => { throw new Error("provider failed"); };',
  );
  await writeFile(runtimePath, built.archive);

  const connectionPath = join(configDirectory(directory), "connections/errors/default.json");
  const profilePath = join(configDirectory(directory), "profiles/errors/items/default.json");
  const storedConnection = {
    integration: "errors",
    name: "default",
    revision: ConnectionRevision,
    provider: { origin: Provider.origin, authentication: built.manifest.connection.auth },
    inputs: {},
    credentials: { token: "fixture-token" },
  };

  await mkdir(dirname(connectionPath), { recursive: true });
  await writeFile(connectionPath, JSON.stringify(storedConnection));
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(
    profilePath,
    JSON.stringify({
      integration: "errors",
      sync: "items",
      connection: "default",
      revision: "11111111-1111-4111-8111-111111111111",
      inputs: {},
    }),
  );

  const configure = runCli(
    directory,
    ["configure", directory, "--inputs", '{"sync":{"ignoreFailure":false}}'],
    bootstrap,
  );

  assert.equal(configure.status, 1);
  assert.match(configure.stderr, /bad credentials/);
  assert.match(configure.stderr, /provider failed/);
  assert.deepEqual(JSON.parse(await readFile(connectionPath, "utf8")), storedConnection);

  const result = runCli(directory, ["sync", directory], bootstrap);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: sync failed/);
  assert.match(result.stderr, /integration\.ts:\d+:/);
  assert.match(result.stderr, /Error: provider failed/);

  for (const operation of ["verify", "sync"] as const) {
    const resultPath = join(directory, `${operation}.json`);
    const request =
      operation === "verify"
        ? { operation, integrationPath: directory, resultPath }
        : { operation, runtimePath, resultPath, syncKey: "items" };
    const hosted = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(bootstrap).href, resolve("dist/server-host.js")],
      {
        input: `${JSON.stringify({ ...request, credentials: storedConnection.credentials })}\n`,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(hosted.status, 1, hosted.stderr);
    assert.match(hosted.stderr, operation === "verify" ? /bad credentials/ : /sync failed/);
    assert.match(hosted.stderr, /provider failed/);
    await assert.rejects(access(resultPath));
  }

  const output = join(directory, "replacement.ndjson");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));

  await writeFile(profilePath, JSON.stringify({ ...profile, inputs: { ignoreFailure: true } }));
  await writeFile(output, '{"id":"original"}\n');

  const settlementOnly = runCli(directory, ["sync", directory, "--output", output], bootstrap);

  assert.equal(settlementOnly.status, 1, settlementOnly.stderr);
  assert.match(settlementOnly.stderr, /provider failed/);
  assert.doesNotMatch(settlementOnly.stdout, /Emitted/);
  assert.equal(await readFile(output, "utf8"), '{"id":"original"}\n');
});

test("replace output is published only after a successful run", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-replace");
  const outputPath = join(directory, "items.ndjson");
  let records = [{ id: 1 }, { id: 2 }];
  let fail = false;
  const integration = defineIntegration({
    key: "replace",
    displayName: "Replace",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        mode: "replace",
        records: z.object({ id: z.number() }),
        async *run(ctx) {
          yield { records };

          if (fail) throw new Error("replace failed");
        },
      }),
    }),
  });
  const provider = createProvider(integration.connection);
  const run = () =>
    withFileSink(
      { outputPath, statePath: join(directory, "state.json"), mode: "replace" },
      (sink) => runSync(integration, { sync: "items" }, { ...provider, commit: sink.commit }),
    );

  await writeFile(outputPath, '{"id":0}\n');
  await run();

  assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');

  records = [{ id: 3 }];
  fail = true;
  await assert.rejects(run(), /replace failed/);

  assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');
  assert.deepEqual(await readdir(directory), ["items.ndjson"]);
});

test("merge local output mirrors emitted batch records and deleted keys", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-merge");
  const outputPath = join(directory, "items.ndjson");
  const integration = defineIntegration({
    key: "merge-output",
    displayName: "Merge output",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string(), name: z.string() }),
        async *run(ctx) {
          yield {
            records: [{ id: "upserted", name: "Updated" }],
            deletedKeys: [{ id: "deleted" }],
          };
        },
      }),
    }),
  });
  const provider = createProvider(integration.connection);

  await withFileSink(
    { outputPath, statePath: join(directory, "state.json"), mode: "merge" },
    (sink) => runSync(integration, { sync: "items" }, { ...provider, commit: sink.commit }),
  );

  const output = JSON.parse((await readFile(outputPath, "utf8")).trim());

  assert.deepEqual(output, {
    records: [{ id: "upserted", name: "Updated" }],
    deletedKeys: [{ id: "deleted" }],
  });
});

const OriginalOrigin = "https://tenant-a.example.com";
const OriginalCredentials = { clientId: "tenant-a-client", clientSecret: "tenant-a-secret" };
const OriginalAuthorization = {
  accessToken: "tenant-a-access",
  refreshToken: "tenant-a-refresh",
  tokenFields: {},
};

async function tenantFixture(t: TestContext) {
  const directory = await fixtureDirectory(t, "beetl-cli-tenant");
  const userDirectory = join(directory, "isolated-user");
  const configurationRoot = join(directory, "isolated-config");
  const configDirectory =
    process.platform === "darwin"
      ? join(userDirectory, "Library/Preferences/beetl-connect")
      : process.platform === "win32"
        ? join(configurationRoot, "beetl-connect/Config")
        : join(configurationRoot, "beetl-connect");
  const connectionPath = join(configDirectory, "connections/tenant-fixture/default.json");
  const bootstrap = join(directory, "isolate-cli.mjs");

  await integrationPackage(directory);
  await writeFile(
    bootstrap,
    `import os from "node:os";
     os.homedir = () => ${JSON.stringify(userDirectory)};
     globalThis.fetch = async () => { throw new Error("Unexpected provider network request"); };`,
  );
  await writeFile(
    join(directory, "integration.ts"),
    `import { auth, defineIntegration, z } from "@beetlio/connect";
export default defineIntegration({
  key: "tenant-fixture",
  displayName: "Tenant fixture",
  connection: {
    origin: {
      type: "input",
      input: "origin",
    },
    inputs: z.strictObject({ origin: z.string().check(z.url()), label: z.string() }),
    auth: auth.oauth2({
      issuer: "/",
      authorizationUrl: "/oauth/authorize",
      tokenUrl: "/oauth/token",
      scopes: ["read"],
      clientSecret: true,
    }),
    async verify(ctx) {
      if (ctx.config.label !== "updated") throw new Error("Updated inputs were not used");
    },
  },
  syncs: (define) => ({
    items: define({
      displayName: "Items",
      records: z.object({ id: z.string() }),
      async *run() {},
    }),
  }),
});
`,
  );

  const stored = {
    integration: "tenant-fixture",
    name: "default",
    revision: "22222222-2222-4222-8222-222222222222",
    provider: {
      origin: OriginalOrigin,
      authentication: {
        type: "oauth2_authorization_code",
        issuer: "/",
        authorizationUrl: "/oauth/authorize",
        tokenUrl: "/oauth/token",
        scopes: ["read"],
        usesClientSecret: true,
        tokenFields: {},
      },
    },
    inputs: { origin: OriginalOrigin, label: "original" },
    credentials: OriginalCredentials,
    authorizationState: OriginalAuthorization,
  };

  await mkdir(dirname(connectionPath), { recursive: true });
  await writeFile(connectionPath, JSON.stringify(stored));

  return {
    stored,
    readConnection: async () => JSON.parse(await readFile(connectionPath, "utf8")),
    configure(origin: string) {
      return spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(bootstrap).href,
          CliPath,
          "configure",
          directory,
          "items",
          "--inputs",
          JSON.stringify({ connection: { origin, label: "updated" } }),
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configurationRoot,
            APPDATA: configurationRoot,
            LOCALAPPDATA: configurationRoot,
          },
        },
      );
    },
  };
}

test("CLI requires new credentials for another tenant and preserves the existing connection", async (t) => {
  const fixture = await tenantFixture(t);
  const changed = fixture.configure("https://tenant-b.example.com");

  assert.equal(changed.error, undefined);
  assert.equal(changed.status, 1, changed.stderr);
  assert.match(changed.stderr, /credentials require an interactive terminal/);
  assert.doesNotMatch(changed.stdout + changed.stderr, /Unexpected provider network request/);
  assert.deepEqual(await fixture.readConnection(), fixture.stored);

  const same = fixture.configure(OriginalOrigin);

  assert.equal(same.error, undefined);
  assert.equal(same.status, 0, same.stderr);

  const saved = await fixture.readConnection();

  assert.deepEqual(saved.inputs, { origin: OriginalOrigin, label: "updated" });
  assert.deepEqual(saved.credentials, OriginalCredentials);
  assert.deepEqual(saved.authorizationState, OriginalAuthorization);
  assert.equal(saved.provider.origin, OriginalOrigin);
});
