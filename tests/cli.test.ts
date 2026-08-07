import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";
import { fixtureDirectory } from "./support.ts";

const CliPath = resolve("dist/cli.js");
const ProfileRevision = "11111111-1111-4111-8111-111111111111";
const ConnectionRevision = "22222222-2222-4222-8222-222222222222";
const Provider = {
  origin: "https://api.example.com",
  authentication: { type: "none" },
};

function runCli(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: join(cwd, "user-config") },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("CLI runs source integrations from typed profiles and portable artifacts", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli");
  const workingDirectory = join(directory, "workspace");
  const dependency = join(directory, "node_modules/fixture-dependency");
  const sourceOutput = join(directory, "source.ndjson");
  await mkdir(workingDirectory);
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "fixture-integration",
      version: "1.0.0",
      dependencies: { "fixture-dependency": "1.0.0" },
    }),
  );
  await writeFile(
    join(directory, "package-lock.json"),
    JSON.stringify({
      name: "fixture-integration",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "fixture-dependency": "1.0.0" } },
        "node_modules/fixture-dependency": { version: "1.0.0" },
      },
    }),
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
      types: "./index.d.ts",
    }),
  );
  await writeFile(join(dependency, "index.js"), 'export const suffix = "bundled";\n');
  await writeFile(join(dependency, "index.d.ts"), "export const suffix: string;\n");
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { defineIntegration, z } from "@beetlio/connect";
      import { suffix } from "fixture-dependency";

      export default defineIntegration({
        key: "fixture",
        displayName: "Fixture",
        connection: {
          baseUrl: "https://api.example.com",
          inputs: z.object({ prefix: z.string().transform((value) => value.length) }),
          async verify(ctx) {
            if (ctx.config.prefix !== 10) throw new Error("connection transform failed");
          },
        },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.object({ id: z.string() }),
          inputs: z.object({
            label: z.string().default("profile").transform((value) => value.length),
          }),
          async run(ctx) {
            await ctx.emit({ records: [{
              id: \`\${ctx.config.connection.prefix}-\${suffix}-\${ctx.config.sync.label}\`,
            }] });
          },
        })],
      });
    `,
  );

  const check = runCli(workingDirectory, "check", directory);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Fixture: items/);

  const unconfigured = runCli(workingDirectory, "sync", directory, "--output", sourceOutput);
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /configure requires an interactive terminal/);

  const profile = join(workingDirectory, "user-config/beetl-connect/profiles/fixture/default.json");
  const connection = join(
    workingDirectory,
    "user-config/beetl-connect/connections/fixture/primary.json",
  );
  await mkdir(dirname(profile), { recursive: true });
  await mkdir(dirname(connection), { recursive: true });
  await writeFile(
    profile,
    JSON.stringify({
      integration: "fixture",
      sync: "items",
      connection: "primary",
      revision: ProfileRevision,
      inputs: {},
    }),
  );
  await writeFile(
    connection,
    JSON.stringify({
      integration: "fixture",
      name: "primary",
      revision: ConnectionRevision,
      provider: Provider,
      inputs: { prefix: 42 },
      authenticationInput: {},
    }),
  );
  const invalidConnection = runCli(workingDirectory, "sync", directory, "--output", sourceOutput);
  assert.equal(invalidConnection.status, 1);
  assert.match(invalidConnection.stderr, /Invalid connection config/);

  await writeFile(
    connection,
    JSON.stringify({
      integration: "fixture",
      name: "primary",
      revision: ConnectionRevision,
      provider: { ...Provider, origin: "https://other.example.com" },
      inputs: { prefix: "configured" },
      authenticationInput: {},
    }),
  );
  const wrongProvider = runCli(workingDirectory, "verify", directory, "--connection", "primary");
  assert.equal(wrongProvider.status, 1);
  assert.match(wrongProvider.stderr, /does not match this provider definition/);

  await writeFile(
    connection,
    JSON.stringify({
      integration: "fixture",
      name: "primary",
      revision: ConnectionRevision,
      provider: Provider,
      inputs: { prefix: "configured" },
      authenticationInput: {},
    }),
  );
  const verified = runCli(workingDirectory, "verify", directory, "--connection", "primary");
  assert.equal(verified.status, 0, verified.stderr);
  const sourceSync = runCli(
    workingDirectory,
    "sync",
    directory,
    "--output",
    sourceOutput,
    "--state",
    join(directory, "source-state.json"),
  );
  assert.equal(sourceSync.status, 0, sourceSync.stderr);
  assert.deepEqual(JSON.parse((await readFile(sourceOutput, "utf8")).trim()), {
    id: "10-bundled-7",
  });

  const artifact = join(directory, "fixture.beetl.zip");
  const artifactCopy = join(directory, "fixture-copy.beetl.zip");
  assert.equal(runCli(workingDirectory, "pack", directory, "--output", artifact).status, 0);
  assert.equal(runCli(workingDirectory, "pack", directory, "--output", artifactCopy).status, 0);
  assert.deepEqual(await readFile(artifact), await readFile(artifactCopy));

  const files = unzipSync(new Uint8Array(await readFile(artifact)));
  assert.deepEqual(Object.keys(files).sort(), [
    "LICENSES.txt",
    "artifact.json",
    "integration.mjs",
    "manifest.json",
  ]);
  assert.equal(runCli(workingDirectory, "check", artifact).status, 0);

  for (const [filename, source, expected] of [
    ["global.beetl.zip", "globalThis.process;", /Unsupported runtime global "process"/],
    ["import.beetl.zip", 'import "node:fs";', /cannot contain imports/],
  ] as const) {
    const unsafeFiles = unzipSync(new Uint8Array(await readFile(artifact)));
    const bundle = new TextEncoder().encode(
      `${source}\n${new TextDecoder().decode(unsafeFiles["integration.mjs"]!)}`,
    );
    unsafeFiles["integration.mjs"] = bundle;
    const metadata = JSON.parse(new TextDecoder().decode(unsafeFiles["artifact.json"]!));
    metadata.files["integration.mjs"] = {
      bytes: bundle.byteLength,
      sha256: createHash("sha256").update(bundle).digest("hex"),
    };
    unsafeFiles["artifact.json"] = new TextEncoder().encode(`${JSON.stringify(metadata)}\n`);
    const path = join(directory, filename);
    await writeFile(path, zipSync(unsafeFiles));
    const rejected = runCli(workingDirectory, "check", path);
    assert.equal(rejected.status, 1, `${filename}: ${rejected.stderr}`);
    assert.match(rejected.stderr, expected);
  }

  const artifactOutput = join(directory, "artifact.ndjson");
  const artifactSync = runCli(
    workingDirectory,
    "sync",
    artifact,
    "--output",
    artifactOutput,
    "--state",
    join(directory, "artifact-state.json"),
  );
  assert.equal(artifactSync.status, 0, artifactSync.stderr);
  assert.deepEqual(JSON.parse((await readFile(artifactOutput, "utf8")).trim()), {
    id: "10-bundled-7",
  });

  const bundle = files["integration.mjs"]!;
  bundle[0] = (bundle[0] ?? 0) ^ 1;
  const tampered = join(directory, "tampered.beetl.zip");
  await writeFile(tampered, zipSync(files));
  const rejected = runCli(workingDirectory, "check", tampered);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /digest mismatch for integration\.mjs/);
});

test("CLI requires a sync key only when the choice is ambiguous", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-syncs");
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "multiple",
        displayName: "Multiple",
        icon: "icon.png",
        connection: { baseUrl: "https://api.example.com" },
        syncs: (defineSync) => ["first", "second"].map((key) => defineSync({
          key,
          displayName: key,
          records: z.object({ id: z.string() }),
          checkpoint: z.object({ cursor: z.string() }),
          async run(ctx) {
            await ctx.emit({ records: [{ id: key }], checkpoint: { cursor: key } });
          },
        })),
      });
    `,
  );

  const missingIcon = runCli(directory, "check", directory);
  assert.equal(missingIcon.status, 1);
  assert.match(missingIcon.stderr, /declares missing icon\.png/);
  await writeFile(join(directory, "icon.png"), "not a png");
  const invalidIcon = runCli(directory, "check", directory);
  assert.equal(invalidIcon.status, 1);
  assert.match(invalidIcon.stderr, /valid png image/);
  await writeFile(
    join(directory, "icon.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const missing = runCli(directory, "sync", directory);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /choose one: first, second/);

  const missingProfile = runCli(directory, "sync", directory, "second", "--profile", "prodution");
  assert.equal(missingProfile.status, 1);
  assert.match(missingProfile.stderr, /Profile "prodution" does not exist/);

  const output = join(directory, "second.ndjson");
  const selected = runCli(directory, "sync", directory, "second", "--output", output);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { id: "second" });
  const savedConnection = JSON.parse(
    await readFile(
      join(directory, "user-config/beetl-connect/connections/multiple/default.json"),
      "utf8",
    ),
  );
  assert.deepEqual(savedConnection.provider, Provider);
  assert.match(savedConnection.revision, /^[0-9a-f-]{36}$/);
  assert.deepEqual(savedConnection.inputs, {});
  assert.deepEqual(savedConnection.authenticationInput, {});
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          directory,
          `.beetl/state/multiple/default/implicit/default/${savedConnection.revision}/second.json`,
        ),
        "utf8",
      ),
    ),
    { cursor: "second" },
  );

  const reauthorized = runCli(directory, "connect", directory);
  assert.equal(reauthorized.status, 0, reauthorized.stderr);
  const replacedConnection = JSON.parse(
    await readFile(
      join(directory, "user-config/beetl-connect/connections/multiple/default.json"),
      "utf8",
    ),
  );
  assert.notEqual(replacedConnection.revision, savedConnection.revision);
  const resumed = runCli(
    directory,
    "sync",
    directory,
    "second",
    "--output",
    join(directory, "second-reauthorized.ndjson"),
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          directory,
          `.beetl/state/multiple/default/implicit/default/${replacedConnection.revision}/second.json`,
        ),
        "utf8",
      ),
    ),
    { cursor: "second" },
  );
});

test("CLI reports integration source locations and error causes", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-errors");
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "errors",
        displayName: "Errors",
        connection: {
          baseUrl: "https://api.example.com",
          async verify() {
            throw new Error("bad credentials");
          },
        },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.object({ id: z.string() }),
          async run() {
            throw new Error("sync failed", { cause: new Error("provider failed") });
          },
        }],
      });
    `,
  );

  const connectionPath = join(
    directory,
    "user-config/beetl-connect/connections/errors/default.json",
  );
  const storedConnection = {
    integration: "errors",
    name: "default",
    revision: ConnectionRevision,
    provider: Provider,
    inputs: {},
    authenticationInput: {},
  };
  await mkdir(dirname(connectionPath), { recursive: true });
  await writeFile(connectionPath, JSON.stringify(storedConnection));
  const reconnect = runCli(directory, "connect", directory);
  assert.equal(reconnect.status, 1);
  assert.match(reconnect.stderr, /bad credentials/);
  assert.deepEqual(JSON.parse(await readFile(connectionPath, "utf8")), storedConnection);

  const result = runCli(directory, "sync", directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: sync failed/);
  assert.match(result.stderr, /integration\.ts:\d+:/);
  assert.match(result.stderr, /Error: provider failed/);
});

test("dependency bundles must be locked and use portable runtime APIs", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-dependencies");
  const integrationDirectory = join(directory, "integration");
  const dependency = join(directory, "node_modules/runtime-specific");
  await mkdir(integrationDirectory);
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({ dependencies: { "runtime-specific": "1.0.0" } }),
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "runtime-specific",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
      types: "./index.d.ts",
    }),
  );
  await writeFile(join(dependency, "index.js"), 'export const value = Buffer.from("x");\n');
  await writeFile(join(dependency, "index.d.ts"), "export const value: Uint8Array;\n");
  await writeFile(join(directory, "shared.ts"), 'export { value } from "runtime-specific";\n');
  await writeFile(
    join(integrationDirectory, "integration.ts"),
    `
      import { defineIntegration, z } from "@beetlio/connect";
      import { value } from "../shared.ts";
      export default defineIntegration({
        key: "runtime-specific",
        displayName: "Runtime specific",
        connection: { baseUrl: "https://api.example.com" },
        syncs: [
          {
            key: "items",
            displayName: "Items",
            records: z.object({ size: z.number() }),
            async run(ctx) {
              const globals = globalThis;
              const { fetch: providerFetch } = globals;
              await providerFetch("https://api.example.com/items");
              await ctx.emit({ records: [{ size: value.length }] });
            },
          },
        ],
      });
    `,
  );

  const unlocked = runCli(directory, "check", integrationDirectory);
  assert.equal(unlocked.status, 1);
  assert.match(unlocked.stderr, /require a committed package-lock\.json/);

  await writeFile(
    join(directory, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        integration: { dependencies: { "runtime-specific": "1.0.0" } },
        "node_modules/runtime-specific": { version: "0.9.0" },
      },
    }),
  );
  const stale = runCli(directory, "check", integrationDirectory);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /not pinned at this version/);

  await writeFile(
    join(directory, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        integration: { dependencies: { "runtime-specific": "1.0.0" } },
        "node_modules/runtime-specific": { version: "1.0.0" },
      },
    }),
  );
  const runtimeSpecific = runCli(directory, "check", integrationDirectory);
  assert.equal(runtimeSpecific.status, 1);
  assert.match(runtimeSpecific.stderr, /Unsupported runtime global "Buffer"/);

  await writeFile(join(dependency, "index.js"), "export const value = new Uint8Array();\n");
  const portable = runCli(directory, "check", integrationDirectory);
  assert.equal(portable.status, 0, portable.stderr);
  const directFetch = runCli(
    directory,
    "sync",
    integrationDirectory,
    "--output",
    join(directory, "runtime-specific.ndjson"),
  );
  assert.equal(directFetch.status, 1);
  assert.match(directFetch.stderr, /providerFetch is not a function/);
});
