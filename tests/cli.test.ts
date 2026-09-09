import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { fixtureDirectory, integrationPackage } from "./support.ts";

const CliPath = resolve("dist/cli.js");
const ConnectionRevision = "22222222-2222-4222-8222-222222222222";
const Provider = {
  origin: "https://api.example.com",
  authentication: { type: "none" },
};

function runCli(cwd: string, ...args: string[]) {
  const home = join(cwd, "user-home");
  const configHome = join(cwd, "user-config");
  const result = spawnSync(process.execPath, [CliPath, ...args], {
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
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function configDirectory(cwd: string) {
  return process.platform === "darwin"
    ? join(cwd, "user-home/Library/Preferences/beetl-connect")
    : process.platform === "win32"
      ? join(cwd, "user-config/beetl-connect/Config")
      : join(cwd, "user-config/beetl-connect");
}

test("CLI syncs legacy connections after adding mapped origin defaults", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-origin-default");
  const home = join(directory, "home");
  const configHome = join(home, "config");
  const configDirectory =
    process.platform === "darwin"
      ? join(home, "Library/Preferences/beetl-connect")
      : process.platform === "win32"
        ? join(configHome, "beetl-connect/Config")
        : join(configHome, "beetl-connect");
  const connection = join(configDirectory, "connections/origin-default/default.json");
  const profile = join(configDirectory, "profiles/origin-default/items/default.json");
  const output = join(directory, "output.ndjson");
  await integrationPackage(directory);
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { defineIntegration, input, z } from "@beetlio/connect";

      export default defineIntegration({
        key: "origin-default",
        displayName: "Origin default",
        connection: {
          origin: {
            input: "environment",
            values: {
              production: "https://api.example.com",
              sandbox: "https://api.sandbox.example.com",
            },
          },
          inputs: input.object({
            environment: input.select(
              [
                { value: "production", label: "Production" },
                { value: "sandbox", label: "Sandbox" },
              ],
              { default: "production" },
            ),
          }),
        },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.object({ environment: z.string() }),
          async run(ctx) {
            await ctx.emit({ records: [{ environment: ctx.config.connection.environment }] });
          },
        })],
      });
    `,
  );
  await mkdir(dirname(connection), { recursive: true });
  await writeFile(
    connection,
    JSON.stringify({
      integration: "origin-default",
      name: "default",
      revision: ConnectionRevision,
      provider: Provider,
      inputs: {},
      credentials: {},
    }),
  );
  await mkdir(dirname(profile), { recursive: true });
  await writeFile(
    profile,
    JSON.stringify({
      integration: "origin-default",
      sync: "items",
      connection: "default",
      revision: "11111111-1111-4111-8111-111111111111",
      inputs: {},
    }),
  );

  const result = spawnSync(process.execPath, [CliPath, "sync", directory, "--output", output], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      APPDATA: configHome,
      LOCALAPPDATA: configHome,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), {
    environment: "production",
  });
});

test("CLI configures and syncs a source integration", async (t) => {
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
      type: "module",
      files: ["integration.ts"],
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
      import { defineIntegration, input, z } from "@beetlio/connect";
      import { suffix } from "fixture-dependency";

      export default defineIntegration({
        key: "fixture",
        displayName: "Fixture",
        connection: {
          origin: "https://api.example.com",
          inputs: input.object({ prefix: input.string() }),
          async verify(ctx) {
            if (ctx.config.prefix !== "configured") throw new Error("connection config failed");
          },
        },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.object({ id: z.string() }),
          inputs: input.object({
            label: input.string({ pattern: "^ x $" }),
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

  const profile = join(configDirectory(workingDirectory), "profiles/fixture/items/default.json");
  const connection = join(configDirectory(workingDirectory), "connections/fixture/primary.json");
  const configured = runCli(
    workingDirectory,
    "configure",
    directory,
    "items",
    "--connection",
    "primary",
    "--inputs",
    '{"connection":{"prefix":"configured"},"sync":{"label":" x "}}',
  );
  assert.equal(configured.status, 0, configured.stderr);
  const savedProfile = JSON.parse(await readFile(profile, "utf8"));
  const savedConnection = JSON.parse(await readFile(connection, "utf8"));
  assert.deepEqual(savedProfile.inputs, { label: " x " });
  assert.deepEqual(savedConnection.inputs, {
    prefix: "configured",
  });
  const sourceState = join(directory, "source-state.json");
  const sourceSync = runCli(
    workingDirectory,
    "sync",
    directory,
    "--output",
    sourceOutput,
    "--state",
    sourceState,
  );
  assert.equal(sourceSync.status, 0, sourceSync.stderr);
  await assert.rejects(access(`${sourceState}.lock`));
  assert.deepEqual(JSON.parse((await readFile(sourceOutput, "utf8")).trim()), {
    id: "configured-bundled- x ",
  });
});

test("CLI requires a sync key only when the choice is ambiguous", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-syncs");
  await integrationPackage(directory);
  const entry = join(directory, "integration.ts");
  const source = `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "multiple",
        displayName: "Multiple",
        connection: { origin: "https://api.example.com" },
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
  `;
  await writeFile(entry, source);

  const missing = runCli(directory, "sync", directory);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /choose one: first, second/);

  const missingProfile = runCli(directory, "sync", directory, "second", "--profile", "prodution");
  assert.equal(missingProfile.status, 1);
  assert.match(missingProfile.stderr, /Profile "prodution" does not exist/);

  const profiles = join(configDirectory(directory), "profiles/multiple");
  const configuredFirst = runCli(directory, "configure", directory, "first");
  assert.equal(configuredFirst.status, 0, configuredFirst.stderr);
  await access(join(profiles, "first/default.json"));
  const output = join(directory, "second.ndjson");
  const selected = runCli(directory, "sync", directory, "second", "--output", output);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { id: "second" });
  const savedConnection = JSON.parse(
    await readFile(join(configDirectory(directory), "connections/multiple/default.json"), "utf8"),
  );
  assert.deepEqual(savedConnection.provider, Provider);
  assert.match(savedConnection.revision, /^[0-9a-f-]{36}$/);
  assert.deepEqual(savedConnection.inputs, {});
  assert.deepEqual(savedConnection.credentials, {});
  const stateRoot = join(directory, ".beetl/state/multiple");
  const stateFiles = (await readdir(stateRoot, { recursive: true })).filter((path) =>
    path.endsWith(join(savedConnection.revision, "second.json")),
  );
  assert.equal(stateFiles.length, 1);
  assert.match(stateFiles[0]!, /^[a-f0-9]{64}[\\/]/);
  assert.deepEqual(JSON.parse(await readFile(join(stateRoot, stateFiles[0]!), "utf8")), {
    cursor: "second",
  });
});

test("CLI reports integration source locations and error causes", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-errors");
  await integrationPackage(directory);
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "errors",
        displayName: "Errors",
        connection: {
          origin: "https://api.example.com",
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

  const connectionPath = join(configDirectory(directory), "connections/errors/default.json");
  const profilePath = join(configDirectory(directory), "profiles/errors/items/default.json");
  const storedConnection = {
    integration: "errors",
    name: "default",
    revision: ConnectionRevision,
    provider: Provider,
    inputs: {},
    credentials: {},
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
  const configure = runCli(directory, "configure", directory);
  assert.equal(configure.status, 1);
  assert.match(configure.stderr, /bad credentials/);
  assert.deepEqual(JSON.parse(await readFile(connectionPath, "utf8")), storedConnection);

  const result = runCli(directory, "sync", directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: sync failed/);
  assert.match(result.stderr, /integration\.ts:\d+:/);
  assert.match(result.stderr, /Error: provider failed/);
});

test("pack creates an installable npm application package", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-pack");
  const integrationDirectory = join(directory, "integration");
  await mkdir(integrationDirectory);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      type: "module",
    }),
  );
  await writeFile(
    join(integrationDirectory, "integration.ts"),
    'export default "packed source";\n',
  );

  await writeFile(
    join(integrationDirectory, "package-lock.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "packed-integration", version: "1.0.0" },
      },
    }),
  );
  await writeFile(join(integrationDirectory, ".env"), "API_KEY=private\n");
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      main: ".env",
      type: "module",
    }),
  );
  const privateFile = runCli(directory, "pack", integrationDirectory);
  assert.equal(privateFile.status, 1);
  assert.match(privateFile.stderr, /contains private runtime file \.env/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      type: "module",
    }),
  );
  const sourcePackage = join(directory, "packed-integration.tgz");
  const packed = runCli(directory, "pack", integrationDirectory, "--output", sourcePackage);
  assert.equal(packed.status, 0, packed.stderr);

  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true}');
  const installed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      sourcePackage,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--cache",
      join(consumer, "npm-cache"),
    ],
    { cwd: consumer, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const installedPackage = join(consumer, "node_modules/packed-integration");
  assert.equal(
    await readFile(join(installedPackage, "integration.ts"), "utf8"),
    'export default "packed source";\n',
  );
  assert.equal(
    JSON.parse(await readFile(join(installedPackage, "package-lock.json"), "utf8")).lockfileVersion,
    3,
  );
});
