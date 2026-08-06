import assert from "node:assert/strict";
import test from "node:test";

import {
  auth,
  createIntegrationManifest,
  defineIntegration,
  defineSync,
  input,
  z,
} from "@beetlio/connect";
import {
  type EmittedBatch,
  runSync,
  validateIntegration,
  verifyConnection,
} from "@beetlio/connect/host";
import { syncHost } from "./support.ts";

test("authoring produces a typed integration manifest", () => {
  const integration = defineIntegration({
    key: "typed",
    displayName: "Typed",
    connection: {
      baseUrl: "https://api.example.com",
      inputs: input.object({
        apiVersion: input.string({ label: "API version", minLength: 1 }),
      }),
      auth: auth.bearer({ token: input.secret({ label: "API token" }) }),
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        inputs: input.object({
          pageSize: input.integer({ label: "Page size", min: 1, default: 100 }),
          region: input.select(
            [
              { value: "eu", label: "Europe" },
              { value: "us", label: "United States" },
            ],
            { default: "eu" },
          ),
        }),
        async run(ctx) {
          const apiVersion: string = ctx.config.connection.apiVersion;
          const region: "eu" | "us" = ctx.config.sync.region;
          await ctx.emit({ records: [{ id: `${apiVersion}-${region}` }] });
          if (false) {
            // @ts-expect-error Connection inputs remain schema-derived.
            ctx.config.connection.missing;
            // @ts-expect-error Record IDs remain strings.
            await ctx.emit({ records: [{ id: 1 }] });
          }
        },
      }),
    ],
  });

  const manifest = createIntegrationManifest(integration);
  assert.equal(manifest.integration.key, "typed");
  assert.deepEqual(manifest.connection.inputs.properties.apiVersion, {
    type: "string",
    minLength: 1,
    title: "API version",
  });
  assert.deepEqual(manifest.connection.auth, { type: "bearer" });
  assert.deepEqual(manifest.connection.authenticationInput.properties.token, {
    type: "string",
    title: "API token",
    "x-beetl-widget": "password",
    writeOnly: true,
  });
  assert.equal(manifest.syncs[0]?.inputs.properties.pageSize?.default, 100);
  assert.equal(manifest.syncs[0]?.mode, "append");
});

test("runSync parses every domain boundary and serializes emitted batches", async () => {
  const batches: EmittedBatch[] = [];
  const integration = defineIntegration({
    key: "transformed",
    displayName: "Transformed",
    connection: {
      baseUrl: "https://api.example.com",
      inputs: z.object({ account: z.string().transform((value) => value.toUpperCase()) }),
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        inputs: z.object({ limit: z.coerce.number().int() }),
        records: z.string().transform(Number),
        checkpoint: z.string().transform(Number),
        async run(ctx) {
          assert.equal(ctx.config.connection.account, "ACME");
          assert.equal(ctx.config.sync.limit, 2);
          assert.equal(ctx.checkpoint, 1);
          await ctx.emit({ records: ["2"], checkpoint: "2" });
          await ctx.emit({ records: ["3"], checkpoint: "3" });
        },
      }),
    ],
  });

  const result = await runSync(
    integration,
    "items",
    {
      connectionConfig: { account: "acme" },
      syncConfig: { limit: "2" },
      checkpoint: "1",
    },
    syncHost({ emit: async (batch) => void batches.push(batch) }),
  );

  assert.deepEqual(
    batches.map(({ sequence, records, checkpoint }) => ({ sequence, records, checkpoint })),
    [
      { sequence: 0, records: [2], checkpoint: 2 },
      { sequence: 1, records: [3], checkpoint: 3 },
    ],
  );
  assert.deepEqual(result, { batches: 2, records: 2, checkpoint: 3 });
});

test("pagination yields records and provider cursors without exposing response envelopes", async () => {
  const requests: string[] = [];
  const next: Array<string | number | undefined> = [];
  const records: unknown[] = [];
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "pages",
    displayName: "Pages",
    connection: {
      baseUrl: "https://api.example.com",
      pagination: {
        type: "cursor",
        cursorParameter: "after",
        cursorPath: "paging.next",
        limitParameter: "limit",
        responsePath: "data",
      },
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        records: Item,
        async run(ctx) {
          for await (const page of ctx.paginate({
            path: "/items",
            records: Item,
            pagination: { limit: 2 },
          })) {
            next.push(page.nextPageParam);
            await ctx.emit({ records: page.records });
          }
        },
      }),
    ],
  });

  const result = await runSync(
    integration,
    "items",
    {},
    syncHost({
      async request(request) {
        requests.push(request.path);
        const continued = request.path.includes("after=two");
        return {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: new TextEncoder().encode(
            JSON.stringify(
              continued
                ? { data: [{ id: 3 }], paging: {} }
                : { data: [{ id: 1 }, { id: 2 }], paging: { next: "two" } },
            ),
          ),
        };
      },
      emit: async (batch) => void records.push(...batch.records),
    }),
  );

  assert.deepEqual(requests, ["/items?limit=2", "/items?after=two&limit=2"]);
  assert.deepEqual(next, ["two", undefined]);
  assert.deepEqual(records, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(result, { batches: 2, records: 3 });
});

test("connection verification uses validated config and the host request boundary", async () => {
  let requested = "";
  const integration = defineIntegration({
    key: "verified",
    displayName: "Verified",
    connection: {
      baseUrl: "https://api.example.com",
      inputs: z.object({ account: z.string() }),
      async verify(ctx) {
        const response = await ctx.fetch(`/accounts/${ctx.config.account}`);
        assert.equal(response.status, 204);
      },
    },
    syncs: [],
  });

  await verifyConnection(
    integration,
    { connectionConfig: { account: "acme" } },
    syncHost({
      async request(request) {
        requested = request.path;
        return { status: 204, headers: [], body: new Uint8Array() };
      },
    }),
  );
  assert.equal(requested, "/accounts/acme");
});

test("sync operations stay ordered, tracked, and closed after the run", async () => {
  const sequences: number[] = [];
  let emitAfterRun: (() => Promise<void>) | undefined;
  const sync = defineSync({
    key: "ordered",
    displayName: "Ordered",
    records: z.number(),
    async run(ctx) {
      emitAfterRun = () => ctx.emit({ records: [3] });
      void ctx.emit({ records: [1] });
      void ctx.emit({ records: [2] });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });
  const integration = defineIntegration({
    key: "ordered",
    displayName: "Ordered",
    connection: { baseUrl: "https://api.example.com" },
    syncs: [sync],
  });

  await assert.rejects(
    runSync(
      integration,
      "ordered",
      {},
      syncHost({
        async emit(batch) {
          sequences.push(batch.sequence);
          throw new Error("storage failed");
        },
      }),
    ),
    /storage failed/,
  );
  assert.deepEqual(sequences, [0]);
  assert.ok(emitAfterRun);
  await assert.rejects(emitAfterRun(), /Sync context is closed/);
});

test("records must be JSON values before they cross the host boundary", async () => {
  let emitted = false;
  const integration = defineIntegration({
    key: "json",
    displayName: "JSON",
    connection: { baseUrl: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.any(),
        async run(ctx) {
          await ctx.emit({ records: [new Date()] });
        },
      }),
    ],
  });

  await assert.rejects(
    runSync(integration, "items", {}, syncHost({ emit: async () => void (emitted = true) })),
    /schema output must be JSON-compatible/,
  );
  assert.equal(emitted, false);
});

test("integration contracts enforce authentication and input invariants", () => {
  assert.throws(() => input.secret({ default: "secret" } as never), /cannot declare defaults/);
  assert.throws(() => input.integer({ min: 1, default: 0 }), /Invalid input default/);

  const integration = defineIntegration({
    key: "invalid",
    displayName: "Invalid",
    connection: {
      baseUrl: "https://user:secret@example.com",
      auth: auth.custom({
        inputs: z.object({ token: z.string().default("secret") }),
        headers: { authorization: "missing" },
      }),
    },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        primaryKey: ["id", "id"],
        async run() {},
      }),
    ],
  });

  assert.throws(() => validateIntegration(integration), /cannot contain credentials/);
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: {
          ...integration.connection,
          baseUrl: "https://example.com",
          auth: auth.custom({
            inputs: z.object({ token: z.string() }),
            headers: { authorization: "missing" },
          }),
        },
      }),
    /unknown input "missing"/,
  );
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: {
          baseUrl: "https://example.com",
          auth: auth.bearer(),
        },
      }),
    /Duplicate primary key path "id"/,
  );
  assert.throws(() => createIntegrationManifest(integration), /cannot declare defaults/);
  assert.doesNotThrow(() =>
    createIntegrationManifest(
      defineIntegration({
        key: "default-field",
        displayName: "Default field",
        connection: {
          baseUrl: "https://example.com",
          auth: auth.custom({
            inputs: input.object({ default: input.secret() }),
            headers: { authorization: "default" },
          }),
        },
        syncs: [],
      }),
    ),
  );
  assert.throws(
    () =>
      createIntegrationManifest(
        defineIntegration({
          key: "dynamic-input",
          displayName: "Dynamic input",
          connection: {
            baseUrl: "https://example.com",
            inputs: z.object({ headers: z.record(z.string(), z.string()) }),
          },
          syncs: [],
        }),
      ),
    /declare it with input\.json\(\)/,
  );
  assert.doesNotThrow(() =>
    createIntegrationManifest(
      defineIntegration({
        key: "json-input",
        displayName: "JSON input",
        connection: {
          baseUrl: "https://example.com",
          inputs: input.object({ headers: input.json() }),
        },
        syncs: [],
      }),
    ),
  );
});
