import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { create, extract } from "tar";

// Exercise consumer imports, including the installed package's declarations and runtime.
import type {
  IntegrationDefinition,
  IntegrationManifest,
  JsonObject,
  JsonValue,
} from "@beetlio/connect";
import {
  buildIntegration,
  compatibilityFixturesUrl,
  withIntegration,
} from "@beetlio/connect/builder";
import {
  assertSupportedHostContractVersion,
  HOST_CONTRACT_VERSION,
  runSync,
  verifyConnection,
  type EmitAction,
  type EmittedBatch,
  type RunSyncResult,
  type SyncHost,
} from "@beetlio/connect/host";
import { LocalHost } from "@beetlio/connect/local-host";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  type OAuthAuthorizationState,
} from "@beetlio/connect/oauth";

import { mockProvider, type ProviderStep } from "./compatibility-http.ts";
import { resolveOAuthOrigin } from "./oauth-origin.ts";

interface Scenario {
  id: string;
  operation: "verify" | "sync" | "authorization";
  input: {
    connectionConfig: JsonObject;
    credentials: Record<string, string>;
    authorizationState?: OAuthAuthorizationState;
    syncKey?: string;
    checkpoint?: JsonValue;
    redirectUri?: string;
  };
  provider: ProviderStep[];
  acknowledgments?: EmitAction[];
  expected: {
    verified?: boolean;
    error?: string;
    batches?: Omit<EmittedBatch, "batchId">[];
    result?: RunSyncResult;
    authorizationUrl?: string;
    authorizationState?: OAuthAuthorizationState;
    authenticationEvents?: string[];
  };
}

interface Fixture {
  id: string;
  artifact: string;
  source: string;
  sha256: string;
  hostContractVersion: number;
  manifest: IntegrationManifest;
  sdk: { version: string; commit?: string };
  scenarios: Scenario[];
}

const inventory = JSON.parse(await readFile(compatibilityFixturesUrl, "utf8")) as {
  formatVersion: number;
  fixtures: Fixture[];
};
assert.equal(inventory.formatVersion, 1);

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
    const auth = integration.connection.auth;
    assert.equal(auth?.type, "oauth2_authorization_code");
    if (auth?.type !== "oauth2_authorization_code") throw new Error("Expected OAuth fixture");

    const origin = await resolveOAuthOrigin(integration.connection, input.connectionConfig);
    const options = {
      auth,
      credentials: input.credentials,
      redirectUri: input.redirectUri!,
      ...(origin === undefined ? {} : { origin }),
      fetch: provider.fetch,
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
    (await integration.connection.inputs?.schema.parseAsync(input.connectionConfig)) ?? {};
  const authenticationEvents: string[] = [];
  let authorizationState: OAuthAuthorizationState | undefined;

  const local = new LocalHost({
    origin: integration.connection.origin,
    connectionConfig: connectionConfig as JsonObject,
    ...(integration.connection.auth === undefined ? {} : { auth: integration.connection.auth }),
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

  const batches: Omit<EmittedBatch, "batchId">[] = [];
  const ids = new Set<string>();

  const host: SyncHost = {
    request: (request, signal) => local.request(request, signal),
    log: (entry) => local.log(entry),
    async emit({ batchId, ...batch }) {
      assert.match(batchId, /^[0-9a-f-]{36}$/);
      assert.equal(ids.has(batchId), false);

      ids.add(batchId);
      batches.push(batch);

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
        input.syncKey!,
        {
          connectionConfig: input.connectionConfig,
          ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
        },
        host,
      );

      assert.deepEqual(result, scenario.expected.result);
    }
  };

  try {
    if (scenario.expected.error) {
      await assert.rejects(
        run,
        (error: unknown) => error instanceof Error && error.message === scenario.expected.error,
      );
    } else await run();
  } finally {
    await local.settleAuthentication();
  }

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

  if (fixture.sdk.commit) {
    test(`source compatibility: ${fixture.id} builds with current public APIs`, async () => {
      const built = await buildIntegration(
        fileURLToPath(new URL(fixture.source, compatibilityFixturesUrl)),
      );

      const { hostContractVersion, ...manifest } = built.manifest;
      assert.equal(hostContractVersion, HOST_CONTRACT_VERSION);
      assert.deepEqual(manifest, fixture.manifest);

      await withIntegration(built.archive, async (integration) => {
        for (const scenario of fixture.scenarios) await execute(integration, scenario);
      });
    });
  }
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
    ["manifestVersion", [1, 999, "2", null], /Unsupported manifest version.*supported: 2.*Upgrade/],
    [
      "hostContractVersion",
      [999, "1", null],
      /Unsupported host contract version.*supported: 1, 2.*Upgrade/,
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

  assert.doesNotThrow(() => assertSupportedHostContractVersion());
  assert.doesNotThrow(() => assertSupportedHostContractVersion(1));
  assert.doesNotThrow(() => assertSupportedHostContractVersion(2));
  assert.throws(() => assertSupportedHostContractVersion(999), /Upgrade/);
});

test("provider-only LocalHost rejects every file operation before writing", async () => {
  assert.throws(
    () => new LocalHost({ origin: "https://provider.example", outputPath: "unused" }),
    /both outputPath and statePath/,
  );

  const host = new LocalHost({ origin: "https://provider.example" });

  for (const action of [
    () => host.emit({ batchId: "batch", sequence: 0, records: [], checkpoint: null }),
    () => host.loadCheckpoint(),
    () => host.beginReplace(),
    () => host.commitReplace(),
    () => host.abortReplace(),
  ])
    await assert.rejects(action, /file operations require outputPath and statePath/);
});

test("failed OAuth persistence prevents using the refreshed token", async () => {
  const fixture = inventory.fixtures.find(({ id }) => id === "oauth")!;
  const scenario = fixture.scenarios.find(({ id }) => id === "refresh")!;
  const archive = await readFile(new URL(fixture.artifact, compatibilityFixturesUrl));

  await withIntegration(archive, async (integration) => {
    const provider = mockProvider(scenario.provider.slice(0, 2));
    const failure = new Error("Grant persistence failed");
    const events: string[] = [];

    const host = new LocalHost({
      origin: integration.connection.origin,
      auth: integration.connection.auth!,
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
    await host.settleAuthentication();

    provider.assertComplete();
    assert.deepEqual(events, ["claim", "persist"]);
  });
});

async function server(
  t: TestContext,
  request: object,
  scenario?: Scenario,
  acknowledgmentVersion = 1,
) {
  const path = await temporary(t);
  const resultPath = join(path, "result.json");

  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./compatibility-http.js", import.meta.url).href,
      fileURLToPath(new URL("./server-host.js", import.meta.url)),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BEETL_CONNECT_COMPAT_HTTP: JSON.stringify(scenario?.provider ?? []) },
    },
  );
  t.after(() => child.kill("SIGKILL"));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const closed = once(child, "close");

  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (value: string) => {
    stderr += value;
  });
  child.stdin.on("error", () => {});

  const batches: Omit<EmittedBatch, "batchId">[] = [];
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ ...request, resultPath }) + "\n");

  try {
    for await (const line of lines) {
      const { protocolVersion, kind, batchId, ...batch } = JSON.parse(line) as EmittedBatch & {
        protocolVersion: number;
        kind: string;
      };

      assert.equal(protocolVersion, 1);
      assert.equal(kind, "batch");
      batches.push(batch);

      child.stdin.write(
        JSON.stringify({
          protocolVersion: acknowledgmentVersion,
          kind: "batch_committed",
          batchId,
          action: scenario?.acknowledgments?.[batch.sequence] ?? "continue",
        }) + "\n",
      );
    }

    const [status] = await closed;
    return { status, stderr, batches, resultPath };
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
  }
}

test("frozen artifact executes through protocol v1, including legacy requests and continuation", async (t) => {
  const fixture = inventory.fixtures.find(({ id }) => id === "bearer")!;
  const runtimePath = fileURLToPath(new URL(fixture.artifact, compatibilityFixturesUrl));

  for (const id of ["sync", "yield", "resume", "checkpoint-null"]) {
    const scenario = fixture.scenarios.find((candidate) => candidate.id === id)!;
    const result = await server(
      t,
      {
        operation: "sync",
        runtimePath,
        ...scenario.input,
        ...(id === "sync" ? {} : { protocolVersion: 1 }),
      },
      scenario,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.batches, scenario.expected.batches);
    assert.deepEqual(
      JSON.parse(await readFile(result.resultPath, "utf8")),
      scenario.expected.result,
    );
  }

  const scenario = fixture.scenarios.find(({ id }) => id === "checkpoint-null")!;
  const badAck = await server(
    t,
    { operation: "sync", runtimePath, ...scenario.input },
    scenario,
    999,
  );

  assert.notEqual(badAck.status, 0);
  assert.match(badAck.stderr, /Unsupported execution protocol version 999.*supported: 1/);

  const future = await server(t, { protocolVersion: 999 });
  assert.notEqual(future.status, 0);
  assert.match(future.stderr, /Unsupported execution protocol version 999.*Upgrade/);
});
