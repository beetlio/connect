import { buildIntegration, packIntegration, withIntegration } from "@beetlio/connect/builder";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { extract } from "tar";
import { fixtureDirectory, integrationPackage } from "./support.ts";

const source = (displayName: string) => `import { defineIntegration, z } from "@beetlio/connect";

export default defineIntegration({
  key: "builder-invariant",
  displayName: ${JSON.stringify(displayName)},
  connection: { origin: "https://api.example.com" },
  syncs: (sync) => ({
    items: sync({ records: z.object({ value: z.string() }), async *run() {} }),
  }),
});
`;

test("builder emits relocatable, reproducible runtime archives", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-builder");
  const shallow = join(directory, "shallow");
  const deep = join(directory, "deep/path/integration");

  await Promise.all([mkdir(shallow), mkdir(deep, { recursive: true })]);
  await Promise.all([integrationPackage(shallow), integrationPackage(deep)]);
  await Promise.all(
    [shallow, deep].map((path) => writeFile(join(path, "integration.ts"), source("Relocatable"))),
  );

  const [first, second] = await Promise.all([buildIntegration(shallow), buildIntegration(deep)]);

  assert.deepEqual(first.archive, second.archive);

  await withIntegration(first.archive, (integration) => {
    assert.equal(integration.displayName, "Relocatable");
  });
});

test("runtime archives preserve npm modules and package assets", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-module-tree-builder");
  const dependency = join(directory, "node_modules/fixture-dependency");

  await mkdir(dependency, { recursive: true });
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "module-tree-integration",
        version: "1.0.0",
        private: true,
        type: "module",
        files: ["integration.ts", "message.txt"],
        dependencies: { "fixture-dependency": "1.0.0" },
      }),
    ),
    writeFile(
      join(directory, "package-lock.json"),
      JSON.stringify({
        name: "module-tree-integration",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "fixture-dependency": "1.0.0" } },
          "node_modules/fixture-dependency": { version: "1.0.0" },
        },
      }),
    ),
    writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "fixture-dependency",
        version: "1.0.0",
        main: "index.cjs",
        types: "index.d.ts",
      }),
    ),
    writeFile(
      join(dependency, "index.cjs"),
      'const fs = require("node:fs"); const path = require("node:path"); exports.read = () => fs.readFileSync(path.join(__dirname, "message.txt"), "utf8");\n',
    ),
    writeFile(join(dependency, "index.d.ts"), "export function read(): string;\n"),
    writeFile(join(dependency, "message.txt"), "dependency"),
    writeFile(join(directory, "message.txt"), "integration+"),
    writeFile(
      join(directory, "integration.ts"),
      `import { readFile } from "node:fs/promises";
import { defineIntegration, z } from "@beetlio/connect";
import { read } from "fixture-dependency";
export default defineIntegration({
  key: "module-tree",
  displayName: "Module tree",
  connection: { origin: "https://api.example.com" },
  syncs: (sync) => ({
    items: sync({
      displayName: "Items",
      records: z.object({ value: z.string() }),
      async *run(ctx) {
        const local = await readFile(new URL("./message.txt", import.meta.url), "utf8");
        yield { records: [{ value: local + read() }] };
      },
    }),
  }),
});
`,
    ),
  ]);

  const built = await buildIntegration(directory);

  await withIntegration(built.archive, async (integration) => {
    const { runSync } = await import("@beetlio/connect/host");
    let emitted: unknown;

    await runSync(
      integration,
      { sync: "items" },
      {
        request: async () => {
          throw new Error("Unexpected request");
        },
        commit: async (batch) => {
          emitted = batch.records[0]?.value;

          return "continue";
        },
      },
    );

    assert.equal(emitted, "integration+dependency");
  });
});

test("builder captures validated icon bytes", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-icon-builder");

  await integrationPackage(directory, ["integration.ts", "icon.png"]);

  const icon = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  await Promise.all([
    writeFile(join(directory, "icon.png"), icon),
    writeFile(
      join(directory, "integration.ts"),
      source("Icon builder").replace(
        'displayName: "Icon builder",',
        'displayName: "Icon builder", icon: "icon.png",',
      ),
    ),
  ]);

  const built = await buildIntegration(directory);

  assert.equal(built.icon?.filename, "icon.png");
  assert.ok(built.icon && Buffer.from(built.icon.bytes).equals(icon));
});

test("source packages preserve the lockfile and reject private files included by npm", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-pack");

  await integrationPackage(directory);
  await writeFile(join(directory, "integration.ts"), source("Packed"));
  await writeFile(join(directory, ".env"), "API_KEY=private\n");

  const packed = await packIntegration(directory);
  const archive = join(directory, "source.tgz");
  const unpacked = join(directory, "unpacked");

  await writeFile(archive, packed.bytes);
  await mkdir(unpacked);
  await extract({ cwd: unpacked, file: archive, strict: true });

  assert.deepEqual(packed.files, ["integration.ts", "package-lock.json", "package.json"]);
  assert.equal(
    await readFile(join(unpacked, "package/package-lock.json"), "utf8"),
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );

  const definition = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

  await writeFile(join(directory, "package.json"), JSON.stringify({ ...definition, main: ".env" }));
  await assert.rejects(packIntegration(directory), /contains private runtime file \.env/);
});
