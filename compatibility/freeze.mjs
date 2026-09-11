// Maintenance only: never called by build, test, prepack, or the installed command.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { extract } from "tar";

const commit = "34ebde36692fa95650ee986d53c1aea47612df59";
const sdkLockSha256 = "36bfd3813968aff6db20476c2001f4d328740ec8b2cc8d8328b6b4bf32d9572d";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const npm =
  process.platform === "win32"
    ? [process.execPath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
    : ["npm"];

assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"),
  "Usage: node compatibility/freeze.mjs [--check]. The SDK is always built from the pinned Git commit.",
);
const check = process.argv[2] === "--check";
const directory = await mkdtemp(join(tmpdir(), "connect-freeze-"));

try {
  const checkout = join(directory, "sdk");
  const archive = join(directory, "sdk.tar");
  const sdk = pathToFileURL(checkout + "/");
  const options = { cwd: checkout, maxBuffer: 5 * 1024 * 1024, windowsHide: true };

  await mkdir(checkout);
  // Only committed source enters this directory; caller dist/node_modules are never copied.
  await exec("git", ["-C", repository, "archive", "--format=tar", "--output", archive, commit]);
  await extract({ file: archive, cwd: checkout, strict: true });
  assert.equal(sha256(await readFile(new URL("package-lock.json", sdk))), sdkLockSha256);

  await exec(
    npm[0],
    [...npm.slice(1), "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    options,
  );
  await exec(npm[0], [...npm.slice(1), "run", "build", "--silent"], options);

  const { buildIntegration } = await import(new URL("dist/artifact.js", sdk).href);

  const frozen = new URL("./frozen/", import.meta.url);
  if (!check) await mkdir(frozen, { recursive: true });
  const artifacts = [];

  for (const id of ["bearer", "exchange", "oauth"]) {
    const source = new URL(`./frozen/sources/${id}/`, import.meta.url);
    const built = await buildIntegration(fileURLToPath(source));

    assert.equal(built.sdkVersion, "0.2.0");
    assert.equal(built.manifest.hostContractVersion, undefined);

    const destination = new URL(`${id}.tgz`, frozen);
    if (check) {
      assert.equal(
        sha256(built.archive),
        sha256(await readFile(destination)),
        `${id}: frozen artifact differs from the pinned SDK build`,
      );
    } else {
      await writeFile(destination, built.archive);
    }

    artifacts.push({
      id,
      file: `${id}.tgz`,
      sha256: sha256(built.archive),
      sourceSha256: sha256(await readFile(new URL("integration.ts", source))),
      manifest: built.manifest,
    });
  }

  const provenance = {
    sdkVersion: "0.2.0",
    sdkCommit: commit,
    sdkLockSha256,
    nodeVersion: process.version,
    origin: "Built once from the historical SDK checkout; not downloaded release binaries.",
    artifacts,
  };

  if (check) {
    const existing = JSON.parse(await readFile(new URL("provenance.json", frozen), "utf8"));
    assert.equal(existing.sdkCommit, commit);
    assert.equal(existing.sdkVersion, provenance.sdkVersion);
    assert.equal(existing.sdkLockSha256, sdkLockSha256);
    assert.deepEqual(existing.artifacts, artifacts);
    console.log(`Frozen artifacts match SDK ${commit}.`);
  } else {
    await writeFile(new URL("provenance.json", frozen), JSON.stringify(provenance, null, 2) + "\n");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
