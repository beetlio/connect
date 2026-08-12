import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
});
