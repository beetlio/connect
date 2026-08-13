import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildIntegration, withIntegration } from "@beetlio/connect/builder";
import { fixtureDirectory, integrationPackage } from "./support.ts";

const source = (displayName: string) => `
  import { defineIntegration, z } from "@beetlio/connect";
  export default defineIntegration({
    key: "builder-invariant",
    displayName: ${displayName},
    connection: { origin: "https://api.example.com" },
    syncs: [{ key: "items", displayName: "Items", records: z.string(), async run() {} }],
  });
`;

test("builder emits relocatable, reproducible runtime archives", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-builder");
  const shallow = join(directory, "shallow");
  const deep = join(directory, "deep/path/integration");
  await Promise.all([mkdir(shallow), mkdir(deep, { recursive: true })]);
  await Promise.all([integrationPackage(shallow), integrationPackage(deep)]);
  await Promise.all(
    [shallow, deep].map((path) => writeFile(join(path, "integration.ts"), source('"Relocatable"'))),
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
      `
        import { readFile } from "node:fs/promises";
        import { defineIntegration, z } from "@beetlio/connect";
        import { read } from "fixture-dependency";
        export default defineIntegration({
          key: "module-tree",
          displayName: "Module tree",
          connection: { origin: "https://api.example.com" },
          syncs: [{
            key: "items",
            displayName: "Items",
            records: z.string(),
            async run(ctx) {
              const local = await readFile(new URL("./message.txt", import.meta.url), "utf8");
              await ctx.emit({ records: [local + read()] });
            },
          }],
        });
      `,
    ),
  ]);

  const built = await buildIntegration(directory);
  await withIntegration(built.archive, async (integration) => {
    let emitted: unknown;
    await integration.syncs[0]!.run({
      emit(value: { records: readonly string[] }) {
        emitted = value.records[0];
        return Promise.resolve();
      },
    } as never);
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
      source('"Icon builder"').replace(
        'displayName: "Icon builder",',
        'displayName: "Icon builder", icon: "icon.png",',
      ),
    ),
  ]);

  const built = await buildIntegration(directory);
  assert.equal(built.icon?.filename, "icon.png");
  assert.ok(built.icon && Buffer.from(built.icon.bytes).equals(icon));
});
