import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
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
    copyFile(
      new URL(
        fixture.id === "destination"
          ? "../examples/destination/integration.ts"
          : `sources/${fixture.id}.ts`,
        root,
      ),
      new URL("integration.ts", source),
    ),
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

// Execute unchanged v3 artifacts and rebuild their unchanged sources with this SDK.
const historical = JSON.parse(await readFile(new URL("frozen/v3/provenance.json", root), "utf8"));
for (const fixture of historical.fixtures) {
  const { sourceHashes, ...contract } = fixture;
  const source = new URL(fixture.source, new URL("frozen/v3/", root));
  for (const [file, hash] of Object.entries(sourceHashes)) {
    if (sha256(await readFile(new URL(file, source))) !== hash)
      throw new Error(`Frozen v3 source changed: ${fixture.id}/${file}`);
  }
  const id = `v3-${fixture.id}`;
  fixtures.push({
    ...contract,
    id,
    artifact: `../../compatibility/frozen/v3/${fixture.artifact}`,
    source: `../../compatibility/frozen/v3/${fixture.source}`,
  });
  const rebuiltSource = new URL(`sources/${id}/`, output);
  await cp(source, rebuiltSource, { recursive: true });
  const built = await buildIntegration(fileURLToPath(rebuiltSource));
  await writeFile(new URL(`${id}-rebuilt.tgz`, output), built.archive);
  fixtures.push({
    ...contract,
    id: `${id}-rebuilt`,
    artifact: `${id}-rebuilt.tgz`,
    source: `sources/${id}/`,
    sha256: sha256(built.archive),
    manifest: built.manifest,
    sdk: { version: built.sdkVersion },
    hostContractVersion: built.manifest.hostContractVersion,
  });
}

await writeFile(
  new URL("inventory.json", output),
  JSON.stringify(
    {
      formatVersion: 3,
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
