import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";
import { fixtureDirectory } from "./support.ts";

const CliPath = resolve("dist/cli.js");

function runCli(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CliPath, ...args], { cwd, encoding: "utf8" });
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

  const profile = join(workingDirectory, ".beetl/profiles/fixture/default.json");
  const connection = join(workingDirectory, ".beetl/connections/fixture/primary.json");
  await mkdir(dirname(profile), { recursive: true });
  await mkdir(dirname(connection), { recursive: true });
  await writeFile(
    profile,
    JSON.stringify({
      integration: "fixture",
      sync: "items",
      connection: "primary",
      inputs: {},
    }),
  );
  await writeFile(
    connection,
    JSON.stringify({
      integration: "fixture",
      name: "primary",
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
          async run(ctx) { await ctx.emit({ records: [{ id: key }] }); },
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

  const output = join(directory, "second.ndjson");
  const selected = runCli(directory, "sync", directory, "second", "--output", output);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { id: "second" });
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, ".beetl/connections/multiple/default.json"), "utf8")),
    {
      integration: "multiple",
      name: "default",
      inputs: {},
      authenticationInput: {},
    },
  );
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
            async run(ctx) { await ctx.emit({ records: [{ size: value.length }] }); },
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
});
