import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), "connect-installed-"));

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:package");

const options = { maxBuffer: 10 * 1024 * 1024, windowsHide: true };

try {
  const packed = await exec(
    process.execPath,
    [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", consumer],
    { ...options, cwd: root },
  );
  const [{ filename }] = JSON.parse(packed.stdout);

  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "compatibility-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
    }),
  );

  await exec(
    process.execPath,
    [npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", join(consumer, filename)],
    { ...options, cwd: consumer },
  );

  const installed = join(consumer, "node_modules/@beetlio/connect");
  const definition = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));

  const result = await exec(
    process.execPath,
    [join(installed, definition.bin["beetl-connect"]), "compatibility"],
    { ...options, cwd: consumer },
  );

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log("Installed-package compatibility passed outside the SDK checkout.");
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);

  throw error;
} finally {
  await rm(consumer, { recursive: true, force: true });
}
