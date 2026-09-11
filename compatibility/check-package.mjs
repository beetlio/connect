import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
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

  assert.deepEqual(Object.keys(definition.exports).sort(), [".", "./builder", "./host"]);

  await writeFile(
    join(consumer, "consumer.ts"),
    `
import { auth, defineIntegration, z } from "@beetlio/connect";
import {
  buildIntegration,
  compatibilityFixturesUrl,
  createIntegrationManifest,
} from "@beetlio/connect/builder";
import {
  beginOAuthAuthorization,
  createProvider,
  prepareOAuthAuthorization,
  runSync,
  type CommitAction,
} from "@beetlio/connect/host";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const integration = defineIntegration({
  key: "consumer",
  displayName: "Consumer",
  connection: { origin: "https://example.com", auth: auth.bearer() },
  syncs: (sync) => ({
    items: sync({
      records: z.object({ id: z.string() }),
      inputs: z.strictObject({ id: z.string() }),
      checkpoint: z.number(),
      async *run(ctx) {
        yield { records: [{ id: ctx.config.sync.id }], checkpoint: 1 };
      },
    }),
  }),
});
const provider = createProvider(integration.connection, { credentials: { token: "test" } });
const action: CommitAction = "continue";

const oauth = await prepareOAuthAuthorization({
  origin: { type: "input", input: "tenant" },
  inputs: z.strictObject({ tenant: z.url() }),
  auth: auth.oauth2({ issuer: "/", authorizationUrl: "/authorize", tokenUrl: "/token", scopes: [] }),
}, { connectionConfig: { tenant: "https://tenant.example.com" }, credentials: { clientId: "client" } });
const authorization = await beginOAuthAuthorization({
  ...oauth,
  redirectUri: "https://app.example.com/callback",
});

assert.equal(new URL(authorization.authorizationUrl).origin, "https://tenant.example.com");

createIntegrationManifest(integration);
await runSync(integration, { sync: "items", syncConfig: { id: "1" } }, {
  ...provider,
  async commit(batch) {
    assert.deepEqual(batch.records, [{ id: "1" }]);
    return action;
  },
});

const inventory = z.object({
  fixtures: z.array(z.object({ source: z.string(), manifest: z.json() })).min(1),
}).parse(JSON.parse(await readFile(compatibilityFixturesUrl, "utf8")));
const fixture = inventory.fixtures[0]!;
const built = await buildIntegration(fileURLToPath(new URL(fixture.source, compatibilityFixturesUrl)));

assert.deepEqual(built.manifest, fixture.manifest);
`,
  );
  await exec(
    process.execPath,
    [
      join(consumer, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--noUncheckedIndexedAccess",
      "--noImplicitReturns",
      "--erasableSyntaxOnly",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "consumer.ts",
    ],
    { ...options, cwd: consumer },
  );

  await exec(process.execPath, ["consumer.ts"], { ...options, cwd: consumer });

  // The installed process entry point must load and report protocol errors.
  const host = spawnSync(process.execPath, [join(installed, "dist/server-host.js")], {
    ...options,
    cwd: consumer,
    encoding: "utf8",
    input: '{"protocolVersion":999}\n',
    timeout: 15_000,
  });

  assert.equal(host.status, 1, host.stderr);
  assert.equal(host.stdout, "");
  assert.match(host.stderr, /Unsupported execution protocol version 999.*supported: 1.*Upgrade/);

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
