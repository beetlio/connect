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
import { runSync, validateIntegration } from "@beetlio/connect/host";
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
      auth: auth.bearer(),
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        inputs: input.object({
          pageSize: input.integer({ min: 1, default: 100 }),
          region: input.select([
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
          ]),
          advanced: input.optional(input.object({ archived: input.boolean() })),
        }),
        async run(ctx) {
          const apiVersion: string = ctx.config.connection.apiVersion;
          const region: "eu" | "us" = ctx.config.sync.region;
          const archived: boolean | undefined = ctx.config.sync.advanced?.archived;
          await ctx.emit({ records: [{ id: `${apiVersion}-${region}` }] });
          void archived;
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
  assert.deepEqual(manifest.connection.credentials.properties.token, {
    type: "string",
    minLength: 1,
    title: "Bearer token",
    "x-beetl-widget": "password",
    writeOnly: true,
  });
  assert.equal(manifest.syncs[0]?.inputs.properties.pageSize?.default, 100);
  assert.ok(!manifest.syncs[0]?.inputs.required?.includes("advanced"));
});

test("merge emits records and explicit deleted keys from a nested manifest v2 schema", async () => {
  const batches: unknown[] = [];
  const integration = defineIntegration({
    key: "merge",
    displayName: "Merge",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({
          id: z.string(),
          profile: z.object({ active: z.boolean(), nickname: z.string().nullable() }),
          tags: z.array(z.object({ name: z.string() })),
          note: z.string().optional(),
        }),
        checkpoint: z.object({ cursor: z.number().int() }),
        async run(ctx) {
          await ctx.emit({
            records: [
              {
                id: "upserted",
                profile: { active: true, nickname: null },
                tags: [{ name: "one" }],
              },
            ],
            deletedKeys: [{ id: "deleted" }],
            checkpoint: { cursor: 1 },
          });
        },
      }),
    ],
  });

  const manifest = createIntegrationManifest(integration);
  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.syncs[0]?.primaryKey, ["id"]);
  assert.deepEqual((manifest.syncs[0]?.records.properties as Record<string, unknown>).tags, {
    type: "array",
    items: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  });

  const result = await runSync(
    integration,
    "items",
    {},
    syncHost({ emit: async (batch) => void batches.push(batch) }),
  );
  assert.deepEqual(batches, [
    {
      batchId: (batches[0] as { batchId: string }).batchId,
      sequence: 0,
      records: [
        {
          id: "upserted",
          profile: { active: true, nickname: null },
          tags: [{ name: "one" }],
        },
      ],
      deletedKeys: [{ id: "deleted" }],
      checkpoint: { cursor: 1 },
    },
  ]);
  assert.deepEqual(result, {
    outcome: "completed",
    batches: 1,
    records: 1,
    deleted: 1,
    checkpoint: { cursor: 1 },
  });
});

test("merge rejects duplicate or conflicting keys within one batch", async () => {
  const integration = defineIntegration({
    key: "merge-conflict",
    displayName: "Merge conflict",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string() }),
        async run(ctx) {
          await ctx.emit({ records: [{ id: "same" }], deletedKeys: [{ id: "same" }] });
        },
      }),
    ],
  });

  await assert.rejects(
    runSync(integration, "items", {}, syncHost()),
    /Duplicate or conflicting merge deletion key/,
  );
});

test("merge primary keys and normalization are validated before execution", async () => {
  const integration = defineIntegration({
    key: "invalid-merge-key",
    displayName: "Invalid merge key",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string().optional() }),
        async run() {},
      }),
    ],
  });

  assert.throws(
    () => createIntegrationManifest(integration),
    /must be required, scalar, and non-null/,
  );

  const overwritten = {
    ...integration,
    syncs: [
      {
        ...integration.syncs[0]!,
        records: z
          .object({ id: z.string() })
          .overwrite((record) => ({ id: record.id.toLowerCase() })),
      },
    ],
  };
  assert.throws(() => createIntegrationManifest(overwritten), /cannot use root-level overwrite/);
  await assert.rejects(
    runSync(overwritten, "items", {}, syncHost()),
    /cannot use root-level overwrite/,
  );
});

test("host continuation preserves the resumable checkpoint", async () => {
  let emitted = 0;
  const integration = defineIntegration({
    key: "continued",
    displayName: "Continued",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "replace",
        records: z.object({ id: z.number() }),
        checkpoint: z.number().int(),
        async run(ctx) {
          for (let id = ctx.checkpoint ?? 0; id < 3; id += 1) {
            await ctx.emit({ records: [{ id }], checkpoint: id + 1 });
          }
        },
      }),
    ],
  });
  const host = syncHost({
    async emit() {
      emitted += 1;
      return emitted === 1 ? "yield" : "continue";
    },
  });

  const first = await runSync(integration, "items", {}, host);
  assert.deepEqual(first, {
    outcome: "continuation_required",
    batches: 1,
    records: 1,
    deleted: 0,
    checkpoint: 1,
  });
  const second = await runSync(integration, "items", { checkpoint: first.checkpoint }, host);
  assert.deepEqual(second, {
    outcome: "completed",
    batches: 2,
    records: 2,
    deleted: 0,
    checkpoint: 3,
  });
});

test("host continuation wins cooperative signal cancellation", async () => {
  const integration = defineIntegration({
    key: "continued-request",
    displayName: "Continued request",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.number() }),
        checkpoint: z.number(),
        async run(ctx) {
          const cancelled = new Promise((_resolve, reject) =>
            ctx.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Operation aborted", "AbortError")),
              { once: true },
            ),
          );
          await Promise.all([cancelled, ctx.emit({ records: [{ id: 1 }], checkpoint: 1 })]);
        },
      }),
    ],
  });

  const result = await runSync(
    integration,
    "items",
    {},
    syncHost({
      emit: async () => "yield",
    }),
  );

  assert.deepEqual(result, {
    outcome: "continuation_required",
    batches: 1,
    records: 1,
    deleted: 0,
    checkpoint: 1,
  });
});

test("an integration error before a yield acknowledgment is not hidden", async () => {
  let acknowledge!: () => void;
  const acknowledgment = new Promise<"yield">(
    (resolve) => void (acknowledge = () => resolve("yield")),
  );
  let markBatchReady!: () => void;
  const batchReady = new Promise<void>((resolve) => void (markBatchReady = resolve));
  const integration = defineIntegration({
    key: "failed-continuation",
    displayName: "Failed continuation",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "replace",
        records: z.object({ id: z.number() }),
        checkpoint: z.number().int(),
        async run(ctx) {
          void ctx.emit({ records: [{ id: 1 }], checkpoint: 1 });
          throw new Error("integration failed");
        },
      }),
    ],
  });

  const running = runSync(
    integration,
    "items",
    {},
    syncHost({
      emit() {
        markBatchReady();
        return acknowledgment;
      },
    }),
  );
  await batchReady;
  acknowledge();
  await assert.rejects(running, /integration failed/);
});

test("null remains a valid opaque checkpoint", async () => {
  let checkpoint: unknown = "missing";
  const integration = defineIntegration({
    key: "null-checkpoint",
    displayName: "Null checkpoint",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        checkpoint: z.null(),
        async run(ctx) {
          assert.equal(ctx.checkpoint, null);
          await ctx.emit({ records: [], checkpoint: null });
        },
      }),
    ],
  });
  const result = await runSync(
    integration,
    "items",
    { checkpoint: null },
    syncHost({ emit: async (batch) => void (checkpoint = batch.checkpoint) }),
  );
  assert.equal(checkpoint, null);
  assert.equal(result.checkpoint, null);
});

test("checkpoint schemas cannot rewrite serialized values", async () => {
  const integration = defineIntegration({
    key: "normalized-checkpoint",
    displayName: "Normalized checkpoint",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.number() }),
        checkpoint: z.coerce.number(),
        async run(ctx) {
          await ctx.emit({ records: [{ id: 1 }], checkpoint: "1" });
        },
      }),
    ],
  });

  await assert.rejects(
    runSync(integration, "items", {}, syncHost()),
    /must preserve the serialized JSON value/,
  );
});

test("runSync validates async schemas and transforms boundary values once", async () => {
  const emitted: unknown[] = [];
  const Record = z.object({
    value: z
      .string()
      .refine(async (value) => value.length > 0)
      .overwrite((value) => `${value}!`),
  });
  const integration = defineIntegration({
    key: "boundaries",
    displayName: "Boundaries",
    connection: {
      origin: "https://api.example.com",
      inputs: input.object({ account: input.string() }),
    },
    syncs: (defineSync) => [
      defineSync({
        key: "items",
        displayName: "Items",
        inputs: input.object({ limit: input.integer() }),
        records: Record,
        checkpoint: z.number().int(),
        async run(ctx) {
          assert.deepEqual(ctx.config, {
            connection: { account: "acme" },
            sync: { limit: 2 },
          });
          assert.equal(ctx.checkpoint, 1);
          await ctx.emit({
            records: [{ value: "item" }],
            checkpoint: ctx.checkpoint + 1,
          });
        },
      }),
    ],
  });

  const result = await runSync(
    integration,
    "items",
    {
      connectionConfig: { account: "acme" },
      syncConfig: { limit: 2 },
      checkpoint: 1,
    },
    syncHost({
      emit: async ({ sequence, records, checkpoint }) =>
        void emitted.push({ sequence, records, checkpoint }),
    }),
  );

  assert.deepEqual(emitted, [{ sequence: 0, records: [{ value: "item!" }], checkpoint: 2 }]);
  assert.deepEqual(result, {
    outcome: "completed",
    batches: 1,
    records: 1,
    deleted: 0,
    checkpoint: 2,
  });
});

test("batch change limits are checked before record parsing", async () => {
  let parsed = 0;
  const integration = defineIntegration({
    key: "bounded",
    displayName: "Bounded",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({
          id: z.string().overwrite((value) => {
            parsed += 1;
            return value;
          }),
        }),
        async run(ctx) {
          await ctx.emit({
            records: Array.from({ length: 10_001 }, (_, id) => ({ id: String(id) })),
          });
        },
      }),
    ],
  });

  await assert.rejects(runSync(integration, "items", {}, syncHost()), /exceeds 10000/);
  assert.equal(parsed, 0);
});

test("cursor pagination follows continuation across empty pages", async () => {
  const requests: string[] = [];
  const pages: unknown[] = [];
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "cursor-pages",
    displayName: "Cursor pages",
    connection: {
      origin: "https://api.example.com",
      pagination: {
        type: "cursor",
        cursorParameter: "after",
        cursorPath: "paging.next",
        hasMorePath: "paging.has_more",
        limitParameter: "limit",
        responsePath: "data",
      },
    },
    syncs: [
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
            pages.push({
              records: page.records,
              next: page.nextPageParam,
              status: page.response.status,
            });
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
        const after = new URL(request.path, "https://api.example.com").searchParams.get("after");
        const body =
          after === null
            ? { data: [], paging: { next: "two", has_more: true } }
            : after === "two"
              ? { data: [{ id: 1 }, { id: 2 }], paging: { next: "three", has_more: true } }
              : { data: [{ id: 3 }], paging: { has_more: false } };
        return {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: new TextEncoder().encode(JSON.stringify(body)),
        };
      },
    }),
  );

  assert.deepEqual(requests, [
    "/items?limit=2",
    "/items?after=two&limit=2",
    "/items?after=three&limit=2",
  ]);
  assert.deepEqual(pages, [
    { records: [], next: "two", status: 200 },
    { records: [{ id: 1 }, { id: 2 }], next: "three", status: 200 },
    { records: [{ id: 3 }], next: undefined, status: 200 },
  ]);
  assert.deepEqual(result, { outcome: "completed", batches: 3, records: 3, deleted: 0 });
});

test("cursor pagination rejects malformed and repeated continuations", async () => {
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "cursor-guards",
    displayName: "Cursor guards",
    connection: {
      origin: "https://api.example.com",
      pagination: {
        type: "cursor",
        cursorParameter: "after",
        cursorPath: "next",
        limitParameter: "limit",
        responsePath: "data",
      },
    },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: Item,
        async run(ctx) {
          for await (const page of ctx.paginate({ path: "/items", records: Item })) {
            await ctx.emit({ records: page.records });
          }
        },
      }),
    ],
  });
  const response = (next: unknown) => ({
    status: 200,
    headers: [["content-type", "application/json"]] as const,
    body: new TextEncoder().encode(JSON.stringify({ data: [], next })),
  });

  await assert.rejects(
    runSync(integration, "items", {}, syncHost({ request: async () => response(true) })),
    /invalid pagination cursor/,
  );

  const cursors = ["A", "B", "A"];
  await assert.rejects(
    runSync(integration, "items", {}, syncHost({ request: async () => response(cursors.shift()) })),
    /repeated a pagination cursor/,
  );
});

test("next-url pagination follows relative URLs across empty pages", async () => {
  const requests: string[] = [];
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "next-pages",
    displayName: "Next pages",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: Item,
        async run(ctx) {
          for await (const page of ctx.paginate({
            path: "/items",
            records: Item,
            pagination: {
              type: "next-url",
              nextUrlPath: "next",
              hasMorePath: "has_more",
              responsePath: "data",
            },
          })) {
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
              request.path === "/items"
                ? { data: [], next: "/items/two", has_more: true }
                : { data: [{ id: 1 }], has_more: false },
            ),
          ),
        };
      },
    }),
  );

  assert.deepEqual(requests, ["/items", "/items/two"]);
  assert.deepEqual(result, { outcome: "completed", batches: 2, records: 1, deleted: 0 });
});

test("offset pagination respects provider has-more metadata", async () => {
  const requests: string[] = [];
  const Item = z.object({ id: z.number() });
  const integration = defineIntegration({
    key: "offset-pages",
    displayName: "Offset pages",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: Item,
        async run(ctx) {
          for await (const page of ctx.paginate({
            path: "/items",
            records: Item,
            pagination: {
              type: "offset",
              offsetParameter: "page",
              limitParameter: "size",
              limit: 2,
              increment: "page",
              responsePath: "data",
              hasMorePath: "paging.has_more",
            },
          })) {
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
        const last = request.path.includes("page=1");
        return {
          status: 200,
          headers: [["content-type", "application/json"]],
          body: new TextEncoder().encode(
            JSON.stringify(
              last
                ? { data: [{ id: 2 }, { id: 3 }], paging: { has_more: false } }
                : { data: [{ id: 1 }], paging: { has_more: true } },
            ),
          ),
        };
      },
    }),
  );

  assert.deepEqual(requests, ["/items?page=0&size=2", "/items?page=1&size=2"]);
  assert.deepEqual(result, { outcome: "completed", batches: 2, records: 3, deleted: 0 });
});

test("sync operations are ordered, tracked, and closed with the run", async () => {
  const sequences: number[] = [];
  let emitAfterRun: (() => Promise<void>) | undefined;
  const integration = defineIntegration({
    key: "ordered",
    displayName: "Ordered",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ value: z.number() }),
        async run(ctx) {
          emitAfterRun = () => ctx.emit({ records: [{ value: 3 }] });
          void ctx.emit({ records: [{ value: 1 }] });
          void ctx.emit({ records: [{ value: 2 }] });
        },
      }),
    ],
  });

  await assert.rejects(
    runSync(
      integration,
      "items",
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
  await assert.rejects(emitAfterRun!(), /Sync context is closed/);
});

test("sync settles logs and cancels abandoned requests", async () => {
  const logs: string[] = [];
  let requestAborted = false;
  let releaseEmit!: () => void;
  const emitReleased = new Promise<void>((resolve) => void (releaseEmit = resolve));
  let markEmitStarted!: () => void;
  const emitStarted = new Promise<void>((resolve) => void (markEmitStarted = resolve));
  const integration = defineIntegration({
    key: "capability-lifecycle",
    displayName: "Capability lifecycle",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ value: z.string() }),
        async run(ctx) {
          void ctx.fetch("/abandoned");
          void ctx.log.info("first");
          void ctx.log.info("second");
          void ctx.emit({ records: [{ value: "submitted" }] });
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      }),
    ],
  });

  const running = runSync(
    integration,
    "items",
    {},
    syncHost({
      request(_request, signal) {
        return new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
      async log(entry) {
        logs.push(entry.message);
      },
      async emit() {
        markEmitStarted();
        await emitReleased;
      },
    }),
  );

  await emitStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const requestCancelledBeforeCommit = requestAborted;
  releaseEmit();
  await running;
  assert.deepEqual(logs, ["first", "second"]);
  assert.equal(requestCancelledBeforeCommit, true);
});

test("record outputs must be JSON-compatible", async () => {
  let emitted = false;
  const integration = defineIntegration({
    key: "json",
    displayName: "JSON",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ value: z.any() }),
        async run(ctx) {
          await ctx.emit({ records: [{ value: new Date() }] });
        },
      }),
    ],
  });

  assert.deepEqual(
    (createIntegrationManifest(integration).syncs[0]?.records.properties as Record<string, unknown>)
      .value,
    {},
  );
  await assert.rejects(
    runSync(integration, "items", {}, syncHost({ emit: async () => void (emitted = true) })),
    /JSON-compatible/,
  );
  assert.equal(emitted, false);
});

test("integration validation protects credential and request boundaries", () => {
  const integration = defineIntegration({
    key: "secure",
    displayName: "Secure",
    connection: { origin: "https://example.com", auth: auth.bearer() },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        async run() {},
      }),
    ],
  });

  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: { ...integration.connection, origin: "http://example.com" },
      }),
    /must use HTTPS or loopback HTTP/,
  );
  assert.throws(
    () => input.object({ token: credential.secret() } as never),
    /only input\.\* fields/,
  );
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: {
          ...integration.connection,
          auth: {
            ...auth.bearer(),
            credentials: credential.object({ token: credential.string() }),
          },
        },
      }),
    /credential "token" must be secret/,
  );
  assert.throws(
    () =>
      validateIntegration({
        ...integration,
        connection: { ...integration.connection, origin: "https://example.com/api" },
      }),
    /cannot contain a path/,
  );
});
