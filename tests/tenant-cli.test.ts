import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { fixtureDirectory, integrationPackage } from "./support.ts";

const CliPath = resolve("dist/cli.js");
const OriginalOrigin = "https://tenant-a.example.com";
const OriginalCredentials = { clientId: "tenant-a-client", clientSecret: "tenant-a-secret" };
const OriginalAuthorization = {
  accessToken: "tenant-a-access",
  refreshToken: "tenant-a-refresh",
  tokenFields: {},
};

async function tenantFixture(t: TestContext) {
  const directory = await fixtureDirectory(t, "beetl-cli-tenant");
  const userDirectory = join(directory, "isolated-user");
  const configurationRoot = join(directory, "isolated-config");
  const configDirectory =
    process.platform === "darwin"
      ? join(userDirectory, "Library/Preferences/beetl-connect")
      : process.platform === "win32"
        ? join(configurationRoot, "beetl-connect/Config")
        : join(configurationRoot, "beetl-connect");
  const connectionPath = join(configDirectory, "connections/tenant-fixture/default.json");
  const bootstrap = join(directory, "isolate-cli.mjs");
  await integrationPackage(directory);
  await writeFile(
    bootstrap,
    `import os from "node:os";
     os.homedir = () => ${JSON.stringify(userDirectory)};
     globalThis.fetch = async () => { throw new Error("Unexpected provider network request"); };`,
  );
  await writeFile(
    join(directory, "integration.ts"),
    `import { auth, defineIntegration, input, z } from "@beetlio/connect";
     export default defineIntegration({
       key: "tenant-fixture",
       displayName: "Tenant fixture",
       connection: {
         origin: { input: "origin" },
         inputs: input.object({ origin: input.string({ format: "url" }), label: input.string() }),
         auth: auth.oauth2AuthorizationCode({
           issuer: "/", authorizationUrl: "/oauth/authorize", tokenUrl: "/oauth/token",
           scopes: ["read"], clientSecret: true,
         }),
         async verify(ctx) {
           if (ctx.config.label !== "updated") throw new Error("Updated inputs were not used");
         },
       },
       syncs: define => [define({
         key: "items", displayName: "Items", records: z.object({ id: z.string() }),
         async run() {},
       })],
     });`,
  );
  const stored = {
    integration: "tenant-fixture",
    name: "default",
    revision: "22222222-2222-4222-8222-222222222222",
    provider: {
      origin: OriginalOrigin,
      authentication: {
        type: "oauth2_authorization_code",
        issuer: "/",
        authorizationUrl: "/oauth/authorize",
        tokenUrl: "/oauth/token",
        scopes: ["read"],
        usesClientSecret: true,
        tokenFields: {},
      },
    },
    inputs: { origin: OriginalOrigin, label: "original" },
    credentials: OriginalCredentials,
    authorizationState: OriginalAuthorization,
  };
  await mkdir(dirname(connectionPath), { recursive: true });
  await writeFile(connectionPath, JSON.stringify(stored));

  return {
    stored,
    readConnection: async () => JSON.parse(await readFile(connectionPath, "utf8")),
    configure(origin: string) {
      return spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(bootstrap).href,
          CliPath,
          "configure",
          directory,
          "items",
          "--inputs",
          JSON.stringify({ connection: { origin, label: "updated" } }),
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configurationRoot,
            APPDATA: configurationRoot,
            LOCALAPPDATA: configurationRoot,
          },
        },
      );
    },
  };
}

test("CLI changing a tenant origin requires fresh credentials and keeps old authorization untouched", async (t) => {
  const fixture = await tenantFixture(t);
  const result = fixture.configure("https://tenant-b.example.com");

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /credentials require an interactive terminal/);
  assert.doesNotMatch(result.stdout + result.stderr, /Unexpected provider network request/);
  assert.deepEqual(await fixture.readConnection(), fixture.stored);
});

test("CLI changing other inputs at the same tenant reuses credentials and OAuth authorization", async (t) => {
  const fixture = await tenantFixture(t);
  const result = fixture.configure(OriginalOrigin);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Tenant fixture\/items/);
  const saved = await fixture.readConnection();
  assert.deepEqual(saved.inputs, { origin: OriginalOrigin, label: "updated" });
  assert.deepEqual(saved.credentials, OriginalCredentials);
  assert.deepEqual(saved.authorizationState, OriginalAuthorization);
  assert.equal(saved.provider.origin, OriginalOrigin);
});
