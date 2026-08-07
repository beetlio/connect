import assert from "node:assert/strict";
import test from "node:test";

import {
  auth,
  credential,
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
      origin: "https://api.example.com",
      inputs: input.object({
        apiVersion: input.string({ label: "API version", minLength: 1 }),
      }),
      auth: auth.bearer({ token: credential.secret({ label: "API token" }) }),
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
          advanced: input.optional(
            input.object({ includeArchived: input.boolean({ label: "Include archived" }) }),
          ),
        }),
        async run(ctx) {
          const apiVersion: string = ctx.config.connection.apiVersion;
          const region: "eu" | "us" = ctx.config.sync.region;
          const includeArchived: boolean | undefined = ctx.config.sync.advanced?.includeArchived;
          await ctx.emit({ records: [{ id: `${apiVersion}-${region}` }] });
          void includeArchived;
          if (false) {
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
  assert.deepEqual(manifest.connection.credentials.properties.token, {
    type: "string",
    title: "API token",
    "x-beetl-widget": "password",
    writeOnly: true,
  });
  assert.equal(manifest.syncs[0]?.inputs.properties.pageSize?.default, 100);
  assert.equal(manifest.syncs[0]?.inputs.properties.advanced?.type, "object");
  assert.ok(!manifest.syncs[0]?.inputs.required?.includes("advanced"));
  assert.equal(manifest.syncs[0]?.mode, "append");
});

test("runSync awaits asynchronous record and checkpoint validation", async () => {
  const batches: EmittedBatch[] = [];
  const nonEmptyString = z.string().refine(async (value) => value.length > 0);
  const integration = defineIntegration({
    key: "transformed",
    displayName: "Transformed",
    connection: {
      origin: "https://api.example.com",
      inputs: input.object({ account: input.string() }),
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        inputs: input.object({ limit: input.integer() }),
        records: nonEmptyString,
        checkpoint: nonEmptyString,
        async run(ctx) {
          assert.equal(ctx.config.connection.account, "acme");
          assert.equal(ctx.config.sync.limit, 2);
          assert.equal(ctx.checkpoint, "1");
          await ctx.emit({ records: ["2"], checkpoint: "2" });
          await ctx.emit({ records: ["3"], checkpoint: "3" });
        },
      }),
    ],
  });
  createIntegrationManifest(integration);

  const result = await runSync(
    integration,
    "items",
    {
      connectionConfig: { account: "acme" },
      syncConfig: { limit: 2 },
      checkpoint: "1",
    },
    syncHost({ emit: async (batch) => void batches.push(batch) }),
  );

  assert.deepEqual(
    batches.map(({ sequence, records, checkpoint }) => ({ sequence, records, checkpoint })),
    [
      { sequence: 0, records: ["2"], checkpoint: "2" },
      { sequence: 1, records: ["3"], checkpoint: "3" },
    ],
  );
  assert.deepEqual(result, { batches: 2, records: 2, checkpoint: "3" });
});

test("pagination yields records, cursors, and response metadata without response envelopes", async () => {
  const requests: string[] = [];
  const next: Array<string | number | undefined> = [];
  const responses: unknown[] = [];
  const records: unknown[] = [];
  const Item = z.object({ id: z.number() }).refine(async ({ id }) => id > 0);
  const integration = defineIntegration({
    key: "pages",
    displayName: "Pages",
    connection: {
      origin: "https://api.example.com",
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
            responses.push(page.response);
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
        const second = request.path.includes("after=two");
        const third = request.path.includes("after=three");
        return {
          status: 200,
          headers: [
            ["content-type", "application/json"],
            ["x-page", third ? "three" : second ? "two" : "one"],
          ],
          body: new TextEncoder().encode(
            JSON.stringify(
              third
                ? { data: [{ id: 3 }], paging: {} }
                : second
                  ? { data: [{ id: 1 }, { id: 2 }], paging: { next: "three" } }
                  : { data: [], paging: { next: "two" } },
            ),
          ),
        };
      },
      emit: async (batch) => void records.push(...batch.records),
    }),
  );

  assert.deepEqual(requests, [
    "/items?limit=2",
    "/items?after=two&limit=2",
    "/items?after=three&limit=2",
  ]);
  assert.deepEqual(next, ["two", "three", undefined]);
  assert.deepEqual(responses, [
    {
      status: 200,
      headers: { "content-type": "application/json", "x-page": "one" },
    },
    {
      status: 200,
      headers: { "content-type": "application/json", "x-page": "two" },
    },
    {
      status: 200,
      headers: { "content-type": "application/json", "x-page": "three" },
    },
  ]);
  assert.deepEqual(records, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(result, { batches: 3, records: 3 });

  await assert.rejects(
    runSync(
      integration,
      "items",
      {},
      syncHost({
        async request() {
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: new TextEncoder().encode(JSON.stringify({ data: [], paging: { next: true } })),
          };
        },
      }),
    ),
    /invalid pagination cursor/,
  );

  const cursors = ["A", "B", "A"];
  await assert.rejects(
    runSync(
      integration,
      "items",
      {},
      syncHost({
        async request() {
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: new TextEncoder().encode(
              JSON.stringify({ data: [], paging: { next: cursors.shift() } }),
            ),
          };
        },
      }),
    ),
    /repeated a pagination cursor/,
  );
});

test("next-url pagination follows relative URLs across empty pages", async () => {
  const requests: string[] = [];
  const next: Array<string | number | undefined> = [];
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "next-pages",
    displayName: "Next pages",
    connection: { origin: "https://api.example.com" },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        records: Item,
        async run(ctx) {
          for await (const page of ctx.paginate({
            path: "/items?limit=2",
            records: Item,
            pagination: {
              type: "next-url",
              nextUrlPath: "next",
              responsePath: "data",
            },
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
        return {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: new TextEncoder().encode(
            JSON.stringify(
              request.path === "/items?limit=2"
                ? { data: [], next: "/items/page/two" }
                : { data: [{ id: 3 }] },
            ),
          ),
        };
      },
    }),
  );

  assert.deepEqual(requests, ["/items?limit=2", "/items/page/two"]);
  assert.deepEqual(next, ["/items/page/two", undefined]);
  assert.deepEqual(result, { batches: 2, records: 1 });
});

test("connection verification can recover from caught request failures", async () => {
  const requested: string[] = [];
  const integration = defineIntegration({
    key: "verified",
    displayName: "Verified",
    connection: {
      origin: "https://api.example.com",
      inputs: input.object({ account: input.string() }),
      async verify(ctx) {
        try {
          await ctx.fetch("/optional");
        } catch {
          // Optional provider capabilities may be unavailable.
        }
        const response = await ctx.fetch(`/accounts/${ctx.config.account}`);
        assert.equal(response.status, 204);
      },
    },
    syncs: [],
  });

  const host = syncHost({
    async request(request) {
      requested.push(request.path);
      if (request.path === "/optional") throw new Error("not available");
      return { status: 204, headers: [], body: new Uint8Array() };
    },
  });
  await verifyConnection(integration, { connectionConfig: { account: "acme" } }, host);
  assert.deepEqual(requested, ["/optional", "/accounts/acme"]);
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
    connection: { origin: "https://api.example.com" },
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
    connection: { origin: "https://api.example.com" },
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
  assert.throws(
    () => input.object({ token: credential.secret() } as never),
    /only input\.\* fields/,
  );
  assert.throws(
    () => input.optional(input.string({ default: "value" })),
    /cannot also be optional/,
  );
  assert.throws(() => input.integer({ min: 1, default: 0 }), /Invalid input default/);
  assert.throws(
    () =>
      validateIntegration(
        defineIntegration({
          key: "retry",
          displayName: "Retry",
          connection: {
            origin: "https://example.com",
            retry: { maxDelayMs: 100 },
          },
          syncs: [],
        }),
      ),
    /initialDelayMs cannot exceed maxDelayMs/,
  );
  const authenticatedHttp = defineIntegration({
    key: "authenticated-http",
    displayName: "Authenticated HTTP",
    connection: { origin: "http://example.com", auth: auth.bearer() },
    syncs: [],
  });
  assert.throws(() => validateIntegration(authenticatedHttp), /must use HTTPS or loopback HTTP/);
  assert.doesNotThrow(() =>
    validateIntegration({
      ...authenticatedHttp,
      connection: { ...authenticatedHttp.connection, origin: "http://[::1]:8080" },
    }),
  );

  const integration = defineIntegration({
    key: "invalid",
    displayName: "Invalid",
    connection: {
      origin: "https://user:secret@example.com",
      auth: auth.custom({
        credentials: credential.object({ token: credential.secret() }),
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
          origin: "https://example.com",
          auth: auth.custom({
            credentials: credential.object({ token: credential.secret() }),
            headers: { authorization: "missing" },
          }),
        },
      }),
    /unknown credential "missing"/,
  );
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: {
          origin: "https://example.com",
          auth: auth.bearer(),
        },
      }),
    /Duplicate primary key path "id"/,
  );
  assert.throws(
    () =>
      validateIntegration(
        defineIntegration({
          key: "path-origin",
          displayName: "Path origin",
          connection: { origin: "https://example.com/api" },
          syncs: [],
        }),
      ),
    /cannot contain a path/,
  );
  assert.deepEqual(
    createIntegrationManifest(
      defineIntegration({
        key: "default-field",
        displayName: "Default field",
        connection: {
          origin: "https://example.com",
          auth: auth.custom({
            credentials: credential.object({ default: credential.secret() }),
            headers: { authorization: "default" },
          }),
        },
        syncs: [],
      }),
    ).connection.credentials.properties.default,
    { type: "string", "x-beetl-widget": "password", writeOnly: true },
  );
  assert.throws(
    () =>
      validateIntegration(
        defineIntegration({
          key: "invalid-header",
          displayName: "Invalid header",
          connection: {
            origin: "https://example.com",
            auth: auth.apiKey({ in: "header", name: "" }),
          },
          syncs: [],
        }),
      ),
    /Invalid authentication header name/,
  );
  assert.throws(
    () =>
      validateIntegration(
        defineIntegration({
          key: "invalid-query",
          displayName: "Invalid query",
          connection: {
            origin: "https://example.com",
            auth: auth.apiKey({ in: "query", name: " " }),
          },
          syncs: [],
        }),
      ),
    /query parameter names cannot be empty/,
  );
});
