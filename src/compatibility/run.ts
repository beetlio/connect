import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { create, extract } from "tar";

// Exercise consumer imports, including the installed package's declarations and runtime.
import type { IntegrationDefinition } from "@beetlio/connect";
import { compatibilityFixturesUrl, withIntegration } from "@beetlio/connect/builder";
import {
  assertSupportedHostContractVersion,
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  createProvider,
  prepareOAuthAuthorization,
  runSync,
  verifyConnection,
  type OAuthAuthorizationState,
  type SyncHost,
} from "@beetlio/connect/host";

import { BatchSchema, RunResultSchema } from "../execution-schema.ts";
import { IntegrationManifestSchema } from "../manifest.ts";
import { OAuthAuthorizationStateSchema } from "../oauth.ts";
import { withAuthenticationSettlement } from "../provider.ts";
import { ProviderStepSchema, mockProvider } from "./http.ts";

const ScenarioSchema = z.strictObject({
  id: z.string(),
  operation: z.enum(["verify", "sync", "authorization"]),
  input: z.strictObject({
    connectionConfig: z.record(z.string(), z.json()),
    credentials: z.record(z.string(), z.string()),
    authorizationState: OAuthAuthorizationStateSchema.optional(),
    syncKey: z.string().optional(),
    checkpoint: z.json().optional(),
    redirectUri: z.url().optional(),
  }),
  provider: z.array(ProviderStepSchema),
  acknowledgments: z.array(z.enum(["continue", "stop"])).optional(),
  expected: z.strictObject({
    verified: z.boolean().optional(),
    error: z.string().optional(),
    batches: z.array(BatchSchema.omit({ batchId: true })).optional(),
    result: RunResultSchema.optional(),
    authorizationUrl: z.url().optional(),
    authorizationState: OAuthAuthorizationStateSchema.optional(),
    authenticationEvents: z.array(z.string()).optional(),
  }),
});

type Scenario = z.output<typeof ScenarioSchema>;

const inventory = z
  .strictObject({
    formatVersion: z.literal(2),
    pathBase: z.string(),
    fixtures: z.array(
      z.strictObject({
        id: z.string(),
        artifact: z.string(),
        source: z.string(),
        sha256: z.string(),
        hostContractVersion: z.number(),
        manifest: IntegrationManifestSchema,
        sdk: z.strictObject({ version: z.string(), commit: z.string().optional() }),
        scenarios: z.array(ScenarioSchema),
      }),
    ),
    rejectedArtifacts: z.array(
      z.strictObject({
        artifact: z.string(),
        sha256: z.string(),
        sdkCommit: z.string(),
        expectedError: z.string(),
      }),
    ),
  })
  .parse(JSON.parse(await readFile(compatibilityFixturesUrl, "utf8")));

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function temporary(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "connect-compatibility-"));

  t.after(() => rm(path, { recursive: true, force: true }));

  return path;
}

async function execute(integration: IntegrationDefinition, scenario: Scenario): Promise<void> {
  const provider = mockProvider(scenario.provider);
  const input = scenario.input;

  if (scenario.operation === "authorization") {
    const options = {
      ...(await prepareOAuthAuthorization(integration.connection, {
        connectionConfig: input.connectionConfig,
        credentials: input.credentials,
        fetch: provider.fetch,
      })),
      redirectUri: input.redirectUri!,
    };

    const prepared = await beginOAuthAuthorization(options);
    const url = new URL(prepared.authorizationUrl);

    assert.equal(url.origin + url.pathname, scenario.expected.authorizationUrl);
    assert.equal(url.searchParams.get("state"), prepared.state);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256").update(prepared.codeVerifier).digest("base64url"),
    );

    const granted = await completeOAuthAuthorization({
      ...options,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      callbackUrl: `${options.redirectUri}?code=code&state=${prepared.state}`,
    });

    assert.deepEqual(granted, scenario.expected.authorizationState);

    provider.assertComplete();

    return;
  }

  const connectionConfig =
    (await integration.connection.inputs?.parseAsync(input.connectionConfig)) ?? {};
  const authenticationEvents: string[] = [];
  let authorizationState: OAuthAuthorizationState | undefined;

  const local = createProvider(integration.connection, {
    connectionConfig,
    credentials: input.credentials,
    ...(input.authorizationState === undefined
      ? {}
      : { authorizationState: input.authorizationState }),
    fetch: (request, init) => {
      if (
        scenario.expected.authenticationEvents &&
        new Headers(init?.headers).get("authorization") ===
          `Bearer ${scenario.expected.authorizationState?.accessToken}`
      ) {
        assert.deepEqual(
          authorizationState,
          scenario.expected.authorizationState,
          "Persist authorization before using it",
        );
      }

      return provider.fetch(request, init);
    },
    onAuthorizationRefreshRequested() {
      authenticationEvents.push("claim");
    },
    async onAuthorizationStateChanged(state) {
      await Promise.resolve();
      authenticationEvents.push("persist");
      authorizationState = state;
    },
  });

  const batches: Omit<z.output<typeof BatchSchema>, "batchId">[] = [];
  const ids = new Set<string>();

  const host: SyncHost = {
    request: (request, signal) => local.request(request, signal),
    log: async () => {},
    async commit({ batchId, ...batch }) {
      assert.match(batchId, /^[0-9a-f-]{36}$/);
      assert.equal(ids.has(batchId), false);

      ids.add(batchId);
      batches.push(BatchSchema.omit({ batchId: true }).parse(batch));

      return scenario.acknowledgments?.[batch.sequence] ?? "continue";
    },
  };

  const run = async () => {
    if (scenario.operation === "verify") {
      await verifyConnection(integration, { connectionConfig: input.connectionConfig }, host);

      assert.equal(scenario.expected.verified, true);
    } else {
      const result = await runSync(
        integration,
        {
          sync: input.syncKey!,
          connectionConfig: input.connectionConfig,
          ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
        },
        host,
      );

      assert.deepEqual(result, scenario.expected.result);
    }
  };

  if (scenario.expected.error) {
    await assert.rejects(
      () => withAuthenticationSettlement(local, run),
      (error: unknown) => error instanceof Error && error.message === scenario.expected.error,
    );
  } else await withAuthenticationSettlement(local, run);

  provider.assertComplete();

  assert.deepEqual(batches, scenario.expected.batches ?? []);
  assert.deepEqual(authenticationEvents, scenario.expected.authenticationEvents ?? []);
  assert.deepEqual(authorizationState, scenario.expected.authorizationState);
}

for (const fixture of inventory.fixtures) {
  test(`compatibility: ${fixture.id} (host v${fixture.hostContractVersion})`, async (t) => {
    const archive = await readFile(new URL(fixture.artifact, compatibilityFixturesUrl));

    assert.equal(sha256(archive), fixture.sha256, "Artifact bytes changed");

    await withIntegration(archive, async (integration) => {
      for (const scenario of fixture.scenarios) {
        await t.test(scenario.id, () => execute(integration, scenario));
      }
    });
  });
}

for (const rejected of inventory.rejectedArtifacts) {
  test(`historical artifact is rejected: ${rejected.artifact}`, async () => {
    const archive = await readFile(new URL(rejected.artifact, compatibilityFixturesUrl));

    assert.equal(sha256(archive), rejected.sha256);

    await assert.rejects(
      withIntegration(archive, () => assert.fail("Must not execute")),
      (error) => error instanceof Error && error.message.includes(rejected.expectedError),
    );
  });
}

test("unsupported artifact contracts fail before importing integration code", async (t) => {
  const path = await temporary(t);
  const fixture = inventory.fixtures[0]!;

  await extract({
    cwd: path,
    file: fileURLToPath(new URL(fixture.artifact, compatibilityFixturesUrl)),
    strict: true,
  });
  await writeFile(
    join(path, "package/integration.mjs"),
    'throw new Error("Integration must not be imported");',
  );

  for (const [field, versions, expected] of [
    [
      "manifestVersion",
      [1, 2, 999, "3", null],
      /Unsupported manifest version.*supported: 3.*Upgrade/,
    ],
    [
      "hostContractVersion",
      [1, 2, 999, "3", null],
      /Unsupported host contract version.*supported: 3.*Upgrade/,
    ],
  ] as const) {
    for (const version of versions) {
      await writeFile(
        join(path, "package/manifest.json"),
        JSON.stringify({ ...fixture.manifest, [field]: version }),
      );

      const archive = join(path, "unsupported.tgz");

      await create({ cwd: path, file: archive, gzip: true }, ["package"]);

      await assert.rejects(
        withIntegration(await readFile(archive), () => assert.fail("Must not execute")),
        expected,
      );
    }
  }

  assert.throws(() => assertSupportedHostContractVersion(), /Upgrade/);
  assert.doesNotThrow(() => assertSupportedHostContractVersion(3));
  assert.throws(() => assertSupportedHostContractVersion(999), /Upgrade/);
});

test("failed OAuth persistence prevents using the refreshed token", async () => {
  const fixture = inventory.fixtures.find(({ id }) => id === "oauth")!;
  const scenario = fixture.scenarios.find(({ id }) => id === "refresh")!;
  const archive = await readFile(new URL(fixture.artifact, compatibilityFixturesUrl));

  await withIntegration(archive, async (integration) => {
    const provider = mockProvider(scenario.provider.slice(0, 2));
    const failure = new Error("Grant persistence failed");
    const events: string[] = [];

    const host = createProvider(integration.connection, {
      credentials: scenario.input.credentials,
      authorizationState: scenario.input.authorizationState!,
      fetch: provider.fetch,
      onAuthorizationRefreshRequested() {
        events.push("claim");
      },
      onAuthorizationStateChanged() {
        events.push("persist");

        throw failure;
      },
    });

    await assert.rejects(verifyConnection(integration, {}, host), (error) => error === failure);
    await assert.rejects(host.settleAuthentication(), (error) => error === failure);

    provider.assertComplete();

    assert.deepEqual(events, ["claim", "persist"]);
  });
});
