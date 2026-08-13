import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildIntegration } from "@beetlio/connect/builder";
import { fixtureDirectory } from "./support.ts";

test("builder emits reproducible artifacts that validate their runtime manifest", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-builder");
  const shallow = join(directory, "shallow");
  const deep = join(directory, "deep/path/integration");
  await Promise.all([mkdir(shallow), mkdir(deep, { recursive: true })]);
  const source = `
    import { defineIntegration, z } from "@beetlio/connect";
    export default defineIntegration({
      key: "builder-invariant",
      displayName: process.env.BEETL_BUILDER_TEST_MODE ?? "unset",
      connection: { origin: "https://api.example.com" },
      syncs: [{
        key: "items",
        displayName: "Items",
        records: z.string(),
        async run() {},
      }],
    });
  `;
  await Promise.all([shallow, deep].map((path) => writeFile(join(path, "integration.ts"), source)));
  const previousMode = process.env.BEETL_BUILDER_TEST_MODE;
  t.after(() => {
    if (previousMode === undefined) delete process.env.BEETL_BUILDER_TEST_MODE;
    else process.env.BEETL_BUILDER_TEST_MODE = previousMode;
  });

  process.env.BEETL_BUILDER_TEST_MODE = "build";
  const [first, second] = await Promise.all([buildIntegration(shallow), buildIntegration(deep)]);
  assert.deepEqual(first.bundle, second.bundle);

  const artifact = join(directory, "integration.mjs");
  await writeFile(artifact, first.bundle);
  const artifactUrl = pathToFileURL(artifact).href;
  const runtime = (await import(`${artifactUrl}?build`)) as {
    default: { displayName: string };
  };
  assert.equal(runtime.default.displayName, "build");
  process.env.BEETL_BUILDER_TEST_MODE = "runtime";
  await assert.rejects(
    import(`${artifactUrl}?runtime`),
    /Runtime integration definition does not match its build manifest/,
  );

  await writeFile(
    join(shallow, "integration.ts"),
    source.replace('process.env.BEETL_BUILDER_TEST_MODE ?? "unset"', "crypto.randomUUID()"),
  );
  await assert.rejects(
    buildIntegration(shallow),
    /Runtime integration definition does not match its build manifest/,
  );
});

test("builder freezes source before evaluating its manifest", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-frozen-builder");
  const entry = join(directory, "integration.ts");
  const source = (record: string, prelude = "") => `
    import { defineIntegration, z } from "@beetlio/connect";
    ${prelude}
    export default defineIntegration({
      key: "frozen-builder",
      displayName: "Frozen builder",
      connection: { origin: "https://api.example.com" },
      syncs: [{
        key: "items",
        displayName: "Items",
        records: z.object({ value: z.string() }),
        async run(ctx) { await ctx.emit({ records: [{ value: ${JSON.stringify(record)} }] }); },
      }],
    });
  `;
  const replacement = source("mutated");
  await writeFile(
    entry,
    source(
      "original",
      `import { writeFile } from "node:fs/promises";
       await writeFile(${JSON.stringify(entry)}, ${JSON.stringify(replacement)});`,
    ),
  );

  const artifact = join(directory, "integration.mjs");
  const built = await buildIntegration(directory);
  await writeFile(artifact, built.bundle);
  const runtime = (await import(`${pathToFileURL(artifact).href}?frozen`)) as {
    default: {
      syncs: readonly {
        run(context: unknown): Promise<void>;
      }[];
    };
  };
  let emitted: unknown;
  await runtime.default.syncs[0]!.run({
    emit(value: { records: readonly { value: string }[] }) {
      emitted = value.records[0]?.value;
      return Promise.resolve();
    },
  });
  assert.equal(emitted, "original");
});

test("builder enforces its minimum Node runtime types", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-node-runtime-builder");
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { mkdtempDisposable } from "node:fs/promises";
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "node-runtime-builder",
        displayName: "Node runtime builder",
        connection: { origin: "https://api.example.com" },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run() { await mkdtempDisposable("beetl-"); },
        }],
      });
    `,
  );

  await assert.rejects(buildIntegration(directory), /no exported member 'mkdtempDisposable'/);
});

test("builder bundles self-contained CommonJS dependencies", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-commonjs-builder");
  const dependency = join(directory, "node_modules/commonjs-dependency");
  await mkdir(dependency, { recursive: true });
  await Promise.all([
    writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "commonjs-dependency", main: "index.cjs", types: "index.d.ts" }),
    ),
    writeFile(join(dependency, "index.cjs"), 'exports.platform = require("node:os").platform();\n'),
    writeFile(join(dependency, "index.d.ts"), "export const platform: string;\n"),
  ]);
  const entry = join(directory, "integration.ts");
  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      import { platform } from "commonjs-dependency";
      export default defineIntegration({
        key: "commonjs-builder",
        displayName: platform,
        connection: { origin: "https://api.example.com" },
        syncs: [{ key: "items", displayName: "Items", records: z.string(), async run() {} }],
      });
    `,
  );

  assert.equal((await buildIntegration(directory)).integration.displayName, process.platform);

  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "computed-require",
        displayName: "Computed require",
        connection: { origin: "https://api.example.com" },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run() { const path = "./dependency.cjs"; require(path); },
        }],
      });
    `,
  );
  await assert.rejects(buildIntegration(directory), /Dynamic require.*not supported/);

  await writeFile(join(directory, "helper.cjs"), 'module.exports = "helper";\n');
  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "require-resolve",
        displayName: "Require resolve",
        connection: { origin: "https://api.example.com" },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run() { require.resolve("./helper.cjs"); },
        }],
      });
    `,
  );
  await assert.rejects(buildIntegration(directory), /Using require as a value.*not supported/);

  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      export default defineIntegration({
        key: "aliased-require",
        displayName: "Aliased require",
        connection: { origin: "https://api.example.com" },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run() { const loader = require; loader.resolve("./helper.cjs"); },
        }],
      });
    `,
  );
  await assert.rejects(buildIntegration(directory), /Using require as a value.*not supported/);

  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      const __require2 = { resolve: () => "local" };
      export default defineIntegration({
        key: "local-resolve",
        displayName: __require2.resolve(),
        connection: { origin: "https://api.example.com" },
        syncs: [{ key: "items", displayName: "Items", records: z.string(), async run() {} }],
      });
    `,
  );
  assert.equal((await buildIntegration(directory)).integration.displayName, "local");

  await Promise.all([
    writeFile(join(dependency, "index.cjs"), "exports.directory = () => __dirname;\n"),
    writeFile(join(dependency, "index.d.ts"), "export function directory(): string;\n"),
  ]);
  await writeFile(
    entry,
    `
      import { defineIntegration, z } from "@beetlio/connect";
      import { directory } from "commonjs-dependency";
      export default defineIntegration({
        key: "commonjs-path",
        displayName: "CommonJS path",
        connection: { origin: "https://api.example.com" },
        syncs: [{
          key: "items",
          displayName: "Items",
          records: z.string(),
          async run() { directory(); },
        }],
      });
    `,
  );
  await assert.rejects(buildIntegration(directory), /__dirname is not supported/);
});

test("builder captures validated icon bytes", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-icon-builder");
  const icon = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const iconPath = join(directory, "icon.png");
  const markerPath = join(directory, "evaluated");
  await writeFile(iconPath, icon);
  await writeFile(
    join(directory, "integration.ts"),
    `
      import { access, writeFile } from "node:fs/promises";
      import { defineIntegration, z } from "@beetlio/connect";
      try {
        await access(${JSON.stringify(markerPath)});
        await writeFile(${JSON.stringify(iconPath)}, "not an image");
      } catch {
        await writeFile(${JSON.stringify(markerPath)}, "");
      }
      export default defineIntegration({
        key: "icon-builder",
        displayName: "Icon builder",
        icon: "icon.png",
        connection: { origin: "https://api.example.com" },
        syncs: [{ key: "items", displayName: "Items", records: z.string(), async run() {} }],
      });
    `,
  );

  const built = await buildIntegration(directory);
  assert.equal(built.icon?.filename, "icon.png");
  assert.equal(built.icon?.mediaType, "image/png");
  assert.ok(built.icon && Buffer.from(built.icon.bytes).equals(icon));
  assert.equal(await readFile(iconPath, "utf8"), "not an image");
});
