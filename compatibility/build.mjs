import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const historical = provenance.artifacts.find(({ id }) => id === fixture.id);
  const source = new URL(`sources/${fixture.id}/`, root);

  let artifact, manifest, sdk, digest;

  if (historical) {
    artifact = `../../compatibility/frozen/${historical.file}`;
    digest = sha256(await readFile(new URL(artifact, output)));

    assert.equal(digest, historical.sha256, "Frozen artifact changed");
    assert.equal(
      sha256(await readFile(new URL("integration.ts", source))),
      historical.sourceSha256,
      "Frozen source changed",
    );

    manifest = historical.manifest;
    sdk = {
      version: provenance.sdkVersion,
      commit: provenance.sdkCommit,
      lockSha256: provenance.sdkLockSha256,
    };
  } else {
    const built = await buildIntegration(fileURLToPath(source));

    artifact = `${fixture.id}.tgz`;
    await writeFile(new URL(artifact, output), built.archive);

    digest = sha256(built.archive);
    manifest = built.manifest;
    sdk = { version: built.sdkVersion };
  }

  fixtures.push({
    ...fixture,
    artifact,
    sha256: digest,
    sdk,
    manifest,
    source: `../../compatibility/sources/${fixture.id}/`,
    hostContractVersion: manifest.hostContractVersion ?? 1,
  });
}

await writeFile(
  new URL("inventory.json", output),
  JSON.stringify(
    {
      formatVersion: 1,
      pathBase: "Resolve artifact and source paths relative to this inventory file.",
      fixtures,
    },
    null,
    2,
  ) + "\n",
);
