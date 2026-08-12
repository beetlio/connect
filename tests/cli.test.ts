import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { fixtureDirectory } from "./support.ts";

const CliPath = resolve("dist/cli.js");
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

test("CLI configures source integrations and creates source packages", async (t) => {
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

  const help = runCli(workingDirectory, "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /beetl-connect pack/);
  assert.match(help.stdout, /beetl-connect configure/);
  assert.match(help.stdout, /beetl-connect sync/);
  assert.doesNotMatch(help.stdout, /beetl-connect (?:check|connect|verify)/);

  const unconfigured = runCli(workingDirectory, "sync", directory, "--output", sourceOutput);
  assert.equal(unconfigured.status, 1);
  assert.match(
    unconfigured.stderr,
    /configuration inputs require an interactive terminal or --inputs/,
  );

  const profile = join(
    workingDirectory,
    "user-config/beetl-connect/profiles/fixture/items/default.json",
  );
  const connection = join(
    workingDirectory,
    "user-config/beetl-connect/connections/fixture/primary.json",
  );
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
  const unchanged = runCli(
    workingDirectory,
    "configure",
    directory,
    "items",
    "--connection",
    "primary",
    "--inputs",
    '{"connection":{"prefix":"configured"},"sync":{"label":" x "}}',
  );
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(JSON.parse(await readFile(profile, "utf8")).revision, savedProfile.revision);
  assert.equal(JSON.parse(await readFile(connection, "utf8")).revision, savedConnection.revision);
  const sourceState = join(directory, "source-state.json");
  await writeFile(`${sourceState}.lock`, "held");
  const locked = runCli(
    workingDirectory,
    "sync",
    directory,
    "--output",
    sourceOutput,
    "--state",
    sourceState,
  );
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /Sync state is already in use/);
  await rm(`${sourceState}.lock`);
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

  const sourcePackage = join(directory, "fixture.tgz");
  const sourcePackageCopy = join(directory, "fixture-copy.tgz");
  const packed = runCli(workingDirectory, "pack", directory, "--output", sourcePackage);
  assert.equal(packed.status, 0, packed.stderr);
  assert.match(packed.stdout, /Included files: integration\.ts, package-lock\.json, package\.json/);
  assert.equal(
    runCli(workingDirectory, "pack", directory, "--output", sourcePackageCopy).status,
    0,
  );
  assert.deepEqual(await readFile(sourcePackage), await readFile(sourcePackageCopy));
  assert.deepEqual((await readFile(sourcePackage)).subarray(0, 3), Buffer.from([0x1f, 0x8b, 0x08]));
});

test("CLI rejects unsafe config roots and concurrent OAuth connection use", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-config-locks");
  const relativeConfig = spawnSync(process.execPath, [CliPath, "--help"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: "relative" },
  });
  assert.equal(relativeConfig.status, 1);
  assert.match(relativeConfig.stderr, /user configuration directory must be absolute/);
  await assert.rejects(access(join(directory, "relative")));

  const connection = join(
    directory,
    "user-config/beetl-connect/connections/all-features/default.json",
  );
  const profile = join(
    directory,
    "user-config/beetl-connect/profiles/all-features/contacts/default.json",
  );
  await mkdir(dirname(connection), { recursive: true });
  await writeFile(
    connection,
    JSON.stringify({
      integration: "all-features",
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
      integration: "all-features",
      sync: "contacts",
      connection: "default",
      revision: "11111111-1111-4111-8111-111111111111",
      inputs: {},
    }),
  );
  await writeFile(`${connection}.lock`, "held");
  const locked = runCli(directory, "sync", resolve("examples/all-features"), "contacts");
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /Connection "default" is already in use/);
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
    `,
  );

  const missingIcon = runCli(directory, "sync", directory);
  assert.equal(missingIcon.status, 1);
  assert.match(missingIcon.stderr, /declares missing icon\.png/);
  await writeFile(join(directory, "icon.png"), "not a png");
  const invalidIcon = runCli(directory, "sync", directory);
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

  const profiles = join(directory, "user-config/beetl-connect/profiles/multiple");
  const configuredFirst = runCli(directory, "configure", directory, "first");
  assert.equal(configuredFirst.status, 0, configuredFirst.stderr);
  await access(join(profiles, "first/default.json"));
  const output = join(directory, "second.ndjson");
  const selected = runCli(directory, "sync", directory, "second", "--output", output);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { id: "second" });
  const secondProfile = JSON.parse(await readFile(join(profiles, "second/default.json"), "utf8"));
  const savedConnection = JSON.parse(
    await readFile(
      join(directory, "user-config/beetl-connect/connections/multiple/default.json"),
      "utf8",
    ),
  );
  assert.deepEqual(savedConnection.provider, Provider);
  assert.match(savedConnection.revision, /^[0-9a-f-]{36}$/);
  assert.deepEqual(savedConnection.inputs, {});
  assert.deepEqual(savedConnection.credentials, {});
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          directory,
          `.beetl/state/multiple/default/${secondProfile.revision}/default/${savedConnection.revision}/second.json`,
        ),
        "utf8",
      ),
    ),
    { cursor: "second" },
  );

  const reauthorized = runCli(directory, "configure", directory, "second", "--reauthorize");
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
          `.beetl/state/multiple/default/${secondProfile.revision}/default/${replacedConnection.revision}/second.json`,
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

  const connectionPath = join(
    directory,
    "user-config/beetl-connect/connections/errors/default.json",
  );
  const profilePath = join(
    directory,
    "user-config/beetl-connect/profiles/errors/items/default.json",
  );
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

  const unlocked = runCli(directory, "pack", integrationDirectory);
  assert.equal(unlocked.status, 1);
  assert.match(unlocked.stderr, /require package\.json and package-lock\.json/);

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
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({ name: "packed-integration", version: "1.0.0", type: "module" }),
  );
  const implicitFiles = runCli(directory, "pack", integrationDirectory);
  assert.equal(implicitFiles.status, 1);
  assert.match(implicitFiles.stderr, /requires an explicit "files" allowlist/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["."],
      type: "module",
    }),
  );
  const broadFiles = runCli(directory, "pack", integrationDirectory);
  assert.equal(broadFiles.status, 1);
  assert.match(broadFiles.stderr, /files entry "\." is too broad/);
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
  await writeFile(join(integrationDirectory, "credentials.json"), '{"token":"private"}\n');
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      main: "credentials.json",
      type: "module",
    }),
  );
  const implicitMain = runCli(directory, "pack", integrationDirectory);
  assert.equal(implicitMain.status, 1);
  assert.match(implicitMain.stderr, /credentials\.json outside the package files allowlist/);
  await mkdir(join(integrationDirectory, "src"));
  await writeFile(join(integrationDirectory, "src/.env.production"), "API_KEY=private\n");
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts", "src"],
      type: "module",
    }),
  );
  const nestedPrivateFile = runCli(directory, "pack", integrationDirectory);
  assert.equal(nestedPrivateFile.status, 1);
  assert.match(nestedPrivateFile.stderr, /private runtime file src\/\.env\.production/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      bundledDependencies: [],
      type: "module",
    }),
  );
  const bundled = runCli(directory, "pack", integrationDirectory);
  assert.equal(bundled.status, 1);
  assert.match(bundled.stderr, /cannot bundle node_modules/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      dependencies: { shared: "file:../shared" },
      type: "module",
    }),
  );
  const linked = runCli(directory, "pack", integrationDirectory);
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /dependency "shared" must resolve from the npm registry/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      dependencies: { remote: "https://example.com/remote.tgz" },
      type: "module",
    }),
  );
  const remote = runCli(directory, "pack", integrationDirectory);
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /dependency "remote" must resolve from the npm registry/);
  await writeFile(
    join(integrationDirectory, "package.json"),
    JSON.stringify({
      name: "packed-integration",
      version: "1.0.0",
      files: ["integration.ts"],
      dependencies: { zod: "1.0.0" },
      type: "module",
    }),
  );
  const staleLock = runCli(directory, "pack", integrationDirectory);
  assert.equal(staleLock.status, 1);
  assert.match(staleLock.stderr, /package-lock\.json dependencies are out of sync/);
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

test("local integration builds support the hosted Node runtime", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-cli-node-module");
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { Buffer } from "node:buffer";
      import { defineIntegration, z } from "@beetlio/connect";

      export default defineIntegration({
        key: "node-runtime",
        displayName: Buffer.from("Node runtime").toString(),
        connection: { origin: "https://api.example.com" },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run(ctx) { await ctx.emit({ records: [process.platform] }); },
        })],
      });
    `,
  );
  const output = join(directory, "output.ndjson");
  const result = runCli(directory, "sync", directory, "--output", output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse((await readFile(output, "utf8")).trim()), process.platform);
});
