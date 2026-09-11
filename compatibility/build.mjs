import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildIntegration } from "../dist/artifact.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const root = new URL("./", import.meta.url);
const output = new URL("../dist/compatibility/", import.meta.url);

await mkdir(output, { recursive: true });

const provenance = JSON.parse(await readFile(new URL("frozen/provenance.json", root), "utf8"));
const scenarios = JSON.parse(await readFile(new URL("scenarios.json", root), "utf8"));
const fixtures = [];

for (const fixture of scenarios.fixtures) {
  const source = new URL(`sources/${fixture.id}/`, output);
  const name = `compatibility-${fixture.id}`;

  await mkdir(source, { recursive: true });
  await Promise.all([
    copyFile(new URL("sources/shared.ts", root), new URL("shared.ts", source)),
    copyFile(new URL(`sources/${fixture.id}.ts`, root), new URL("integration.ts", source)),
    writeFile(
      new URL("package.json", source),
      JSON.stringify(
        {
          name,
          version: "0.0.0",
          private: true,
          type: "module",
          files: ["integration.ts", "shared.ts"],
        },
        null,
        2,
      ) + "\n",
    ),
    writeFile(
      new URL("package-lock.json", source),
      JSON.stringify(
        {
          name,
          version: "0.0.0",
          lockfileVersion: 3,
          packages: { "": { name, version: "0.0.0" } },
        },
        null,
        2,
      ) + "\n",
    ),
  ]);

  const built = await buildIntegration(fileURLToPath(source));
  const artifact = `${fixture.id}.tgz`;

  await writeFile(new URL(artifact, output), built.archive);

  const digest = sha256(built.archive);
  const manifest = built.manifest;
  const sdk = { version: built.sdkVersion };

  fixtures.push({
    ...fixture,
    artifact,
    sha256: digest,
    sdk,
    manifest,
    source: `sources/${fixture.id}/`,
    hostContractVersion: manifest.hostContractVersion ?? 1,
  });
}

await writeFile(
  new URL("inventory.json", output),
  JSON.stringify(
    {
      formatVersion: 2,
      pathBase: "Resolve artifact and source paths relative to this inventory file.",
      fixtures,
      rejectedArtifacts: provenance.artifacts.map((artifact) => ({
        artifact: `../../compatibility/frozen/${artifact.file}`,
        sha256: artifact.sha256,
        sdkCommit: provenance.sdkCommit,
        expectedError: "Unsupported manifest version 2",
      })),
    },
    null,
    2,
  ) + "\n",
);
