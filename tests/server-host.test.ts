import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { create as createTar } from "tar";

import { fixtureDirectory } from "./support.ts";

const HostPath = resolve("dist/server-host.js");

test("server host inspects, verifies, and syncs an uploaded package", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-server-host");
  const packageDirectory = join(directory, "package");
  const archive = join(directory, "fixture.tgz");
  await mkdir(packageDirectory);
  await writeFile(
    join(packageDirectory, "integration.ts"),
    `
      import { auth, credential, defineIntegration, input, z } from "@beetlio/connect";

      export default defineIntegration({
        key: "fixture",
        displayName: "Fixture",
        connection: {
          origin: "https://api.example.com",
          auth: auth.oauth2AuthorizationCode({
            issuer: "https://auth.example.com",
            authorizationUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: ["read"],
            clientSecret: credential.secret(),
          }),
          inputs: input.object({ prefix: input.string() }),
          async verify(ctx) {
            if (ctx.config.prefix !== "ready") throw new Error("not ready");
          },
        },
        syncs: (defineSync) => [defineSync({
          key: "items",
          displayName: "Items",
          records: z.object({ id: z.string() }),
          checkpoint: z.object({ cursor: z.string() }),
          inputs: input.object({ suffix: input.string() }),
          async run(ctx) {
            await ctx.emit({
              records: [{ id: ctx.config.connection.prefix + ctx.config.sync.suffix }],
              checkpoint: { cursor: "next" },
            });
          },
        })],
      });
    `,
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", private: true, type: "module" }),
  );
  await writeFile(
    join(packageDirectory, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "fixture", version: "0.0.0" } },
    }),
  );
  await createTar({ cwd: directory, file: archive, gzip: true }, ["package"]);

  const inspectPath = join(directory, "inspect.json");
  runHost({ operation: "inspect", integrationPath: archive, resultPath: inspectPath });
  const inspected = JSON.parse(await readFile(inspectPath, "utf8")) as {
    manifest: { integration: { key: string } };
  };
  assert.equal(inspected.manifest.integration.key, "fixture");

  const credentials = { clientId: "client-id", clientSecret: "client-secret" };
  const authorizationState = {
    accessToken: "access-token",
    refreshToken: null,
    tokenFields: {},
  };
  const oauthPath = join(directory, "oauth.json");
  runHost({
    operation: "oauth_start",
    integrationPath: archive,
    resultPath: oauthPath,
    credentials,
    redirectUri: "https://app.example/oauth/callback",
  });
  const oauth = JSON.parse(await readFile(oauthPath, "utf8")) as {
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
  };
  const authorizationUrl = new URL(oauth.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://auth.example.com");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "client-id");
  assert.equal(authorizationUrl.searchParams.get("state"), oauth.state);
  assert.ok(oauth.codeVerifier);

  const verifyPath = join(directory, "verify.json");
  runHost({
    operation: "verify",
    integrationPath: archive,
    resultPath: verifyPath,
    connectionConfig: { prefix: "ready" },
    credentials,
    authorizationState: null,
    syncs: [{ key: "items", configuration: { suffix: "-item" } }],
  });

  const resultPath = join(directory, "sync.json");
  const outputPath = join(directory, "records.ndjson");
  runHost({
    operation: "sync",
    integrationPath: archive,
    resultPath,
    outputPath,
    statePath: join(directory, "state.json"),
    syncKey: "items",
    connectionConfig: { prefix: "ready" },
    syncConfig: { suffix: "-item" },
    credentials,
    authorizationState,
    checkpoint: null,
  });
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    batches: 1,
    records: 1,
    checkpoint: { cursor: "next" },
    authorizationState: { accessToken: "access-token", tokenFields: {} },
  });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    id: "ready-item",
  });
});

function runHost(request: object): void {
  const result = spawnSync(process.execPath, [HostPath], {
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}
