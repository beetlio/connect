import assert from "node:assert/strict";
import test from "node:test";
import { defineIntegration, z, type DestinationContext } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import { runDestinationBatch } from "@beetlio/connect/host";
import fixture from "../examples/destination/integration.ts";

const noRequests = {
  request: async () => assert.fail("Validation must precede provider requests"),
};

test("destination batches validate all records and keys before execution", async () => {
  for (const [batch, expected] of [
    [
      { batchId: "invalid", records: [{ id: "ok", email: "ok@example.com" }, { id: "bad" }] },
      /Invalid record 1/,
    ],
    [{ batchId: "invalid", records: [{ id: null, email: "ok@example.com" }] }, /Invalid record 0/],
    [
      { batchId: "invalid", records: [{ id: "ok", email: "ok@example.com", extra: true }] },
      /Invalid record 0/,
    ],
    [
      { batchId: "invalid", records: [], deletedKeys: [{ id: "gone", email: "not-a-key" }] },
      /Invalid deleted key 0/,
    ],
    [{ batchId: "invalid", records: [], deletedKeys: [{ id: null }] }, /Invalid deleted key 0/],
    [
      { batchId: "invalid", records: [], deletedKeys: [{ id: "gone" }, { id: "gone" }] },
      /Duplicate or conflicting destination deletion key/,
    ],
    [{ batchId: "invalid", records: [{ id: "date", email: new Date() }] }, /JSON-compatible/],
    [{ batchId: "", records: [] }, /Too small/],
    [{ batchId: "invalid", records: [], checkpoint: 1 }, /Unrecognized key/],
  ] as const) {
    await assert.rejects(
      runDestinationBatch(
        fixture,
        {
          destination: "contacts",
          connectionConfig: { tenant: "acme" },
          batch,
        },
        noRequests,
      ),
      expected,
    );
  }
  await assert.rejects(
    runDestinationBatch(
      fixture,
      {
        destination: "constructor",
        batch: { batchId: "unknown", records: [] },
      },
      noRequests,
    ),
    /Unknown destination/,
  );
});

test("destination count and byte limits precede author parsing and include normalized output", async () => {
  let parsed = 0;
  const integration = defineIntegration({
    key: "limits",
    displayName: "Limits",
    connection: { origin: "https://example.com" },
    destinations: (destination) => ({
      items: destination({
        records: z.object({
          id: z.string(),
          value: z.string().overwrite((value) => {
            parsed++;
            return value === "expand" ? "x".repeat(8 * 1024 * 1024) : value;
          }),
        }),
        primaryKey: ["id"],
        supportsDelete: true,
        async run() {
          assert.fail("Oversized batch must not execute");
        },
      }),
    }),
  });
  await assert.rejects(
    runDestinationBatch(
      integration,
      {
        destination: "items",
        batch: {
          batchId: "count",
          records: Array.from({ length: 10_000 }, (_, id) => ({ id: String(id), value: "small" })),
          deletedKeys: [{ id: "last" }],
        },
      },
      noRequests,
    ),
    /exceeds 10000/,
  );
  await assert.rejects(
    runDestinationBatch(
      integration,
      {
        destination: "items",
        batch: { batchId: "bytes", records: [{ id: "one", value: "é".repeat(4 * 1024 * 1024) }] },
      },
      noRequests,
    ),
    /exceeds 8 MiB/,
  );
  assert.equal(parsed, 0);
  await assert.rejects(
    runDestinationBatch(
      integration,
      {
        destination: "items",
        batch: { batchId: "expanded", records: [{ id: "one", value: "expand" }] },
      },
      noRequests,
    ),
    /exceeds 8 MiB/,
  );
  assert.equal(parsed, 1);
});

test("destination input is snapshotted and async normalization runs once", async () => {
  const original = { batchId: "snapshot", records: [{ id: "ONE", nested: { value: "original" } }] };
  let normalized = 0;
  const integration = defineIntegration({
    key: "snapshot",
    displayName: "Snapshot",
    connection: { origin: "https://example.com" },
    destinations: (destination) => ({
      items: destination({
        records: z.object({
          id: z
            .string()
            .refine(async (id) => id.length > 0)
            .overwrite((id) => {
              normalized++;
              return id.toLowerCase();
            }),
          nested: z.object({ value: z.string() }),
        }),
        primaryKey: ["id"],
        async run(ctx, batch) {
          assert.equal(batch.batchId, "snapshot");
          assert.deepEqual(batch.records, [{ id: "one", nested: { value: "original" } }]);
          batch.records[0]!.nested.value = "writer mutation";
        },
      }),
    }),
  });
  const running = runDestinationBatch(
    integration,
    { destination: "items", batch: original },
    noRequests,
  );
  original.records[0]!.nested.value = "caller mutation";
  await running;
  assert.equal(normalized, 1);
  assert.equal(original.records[0]!.id, "ONE");
  assert.equal(original.records[0]!.nested.value, "caller mutation");

  await assert.rejects(
    runDestinationBatch(
      integration,
      {
        destination: "items",
        batch: {
          batchId: "normalized-conflict",
          records: [
            { id: "ONE", nested: { value: "a" } },
            { id: "one", nested: { value: "b" } },
          ],
        },
      },
      noRequests,
    ),
    /Duplicate destination key/,
  );
});

test("destination cancellation preserves its cause and drains cleanup logs", async () => {
  const controller = new AbortController();
  const failure = new Error("Cancelled by host");
  const events: string[] = [];
  let context: DestinationContext | undefined;
  const integration = defineIntegration({
    key: "cancel",
    displayName: "Cancel",
    connection: { origin: "https://example.com" },
    destinations: (destination) => ({
      items: destination({
        records: z.object({ id: z.string() }),
        primaryKey: ["id"],
        async run(ctx) {
          context = ctx;
          try {
            await ctx.fetch("/items", { method: "PUT", body: "{}" });
            assert.fail("Cancelled request must reject");
          } finally {
            await ctx.log.info("cleanup");
          }
        },
      }),
    }),
  });
  const input = {
    destination: "items",
    batch: { batchId: "cancel", records: [] },
    signal: controller.signal,
  };
  await assert.rejects(
    runDestinationBatch(integration, input, {
      async request(request, signal) {
        controller.abort(failure);
        signal!.throwIfAborted();
        return { status: 204, headers: [], body: new Uint8Array() };
      },
      async log(entry) {
        await Promise.resolve();
        events.push(entry.message);
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ["cleanup"]);
  assert.ok(context?.signal.aborted);
  await assert.rejects(context.fetch("/late"), (error) => error === failure);
  await assert.rejects(
    runDestinationBatch(integration, input, noRequests),
    (error) => error === failure,
  );
});

test("destination execution and cleanup failures retain the original errors", async () => {
  const execution = new Error("Write failed");
  const cleanup = new Error("Log failed");
  const integration = defineIntegration({
    key: "errors",
    displayName: "Errors",
    connection: { origin: "https://example.com" },
    destinations: (destination) => ({
      items: destination({
        records: z.object({ id: z.string() }),
        primaryKey: ["id"],
        async run(ctx) {
          void ctx.log.info("pending");
          throw execution;
        },
      }),
    }),
  });
  await assert.rejects(
    runDestinationBatch(
      integration,
      {
        destination: "items",
        batch: { batchId: "errors", records: [] },
      },
      {
        ...noRequests,
        async log() {
          throw cleanup;
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [execution, cleanup]);
      return true;
    },
  );
});

test("destination key pipelines reject coercion before executing records or deletions", async () => {
  for (const [key, value] of [
    [z.coerce.number().pipe(z.number()), null],
    [z.coerce.number().pipe(z.number()).readonly().pipe(z.number()), null],
    [
      z
        .number()
        .transform(() => null)
        .pipe(z.coerce.number())
        .pipe(z.number()),
      1,
    ],
  ] as const) {
    let executions = 0;
    const integration = defineIntegration({
      key: "key-pipeline",
      displayName: "Key pipeline",
      connection: { origin: "https://example.com" },
      destinations: (destination) => ({
        items: destination({
          records: z.object({ id: key }),
          primaryKey: ["id"],
          supportsDelete: true,
          async run() {
            executions++;
          },
        }),
      }),
    });
    for (const batch of [
      { batchId: "upsert", records: [{ id: value }] },
      { batchId: "delete", records: [], deletedKeys: [{ id: value }] },
    ]) {
      await assert.rejects(
        runDestinationBatch(integration, { destination: "items", batch }, noRequests),
        /without coercion/,
      );
    }
    assert.equal(executions, 0);
    assert.throws(() => createIntegrationManifest(integration), /without coercion/);
  }

  // A pipeline with representable input/output and an ordinary transform remains valid.
  const normalized = {
    ...fixture,
    destinations: {
      contacts: {
        ...fixture.destinations.contacts!,
        records: z.object({
          id: z
            .string()
            .transform((id) => id.trim())
            .pipe(z.string()),
        }),
      },
    },
  };
  assert.doesNotThrow(() => createIntegrationManifest(normalized));
});

test("destination manifests expose input schemas and require usable identities", () => {
  const manifest = createIntegrationManifest(fixture);
  assert.equal(manifest.manifestVersion, 4);
  assert.equal(manifest.hostContractVersion, 4);
  assert.deepEqual(manifest.syncs, []);
  assert.equal(manifest.destinations[0]?.supportsDelete, true);
  assert.equal(manifest.destinations[1]?.supportsDelete, false);
  assert.deepEqual(manifest.destinations[0]?.records.required, ["id", "email"]);
  assert.equal(manifest.destinations[0]?.records.additionalProperties, false);

  for (const key of [
    z.string().optional(),
    z.string().nullable(),
    z.string().default("missing"),
    z.object({ id: z.string() }),
    z.coerce.number(),
    z.coerce.number().readonly(),
  ]) {
    assert.throws(
      () =>
        createIntegrationManifest({
          ...fixture,
          destinations: {
            contacts: { ...fixture.destinations.contacts!, records: z.object({ id: key }) },
          },
        }),
      /must be required, scalar, and non-null/,
    );
  }
  assert.throws(
    () =>
      createIntegrationManifest(
        defineIntegration({
          key: "empty",
          displayName: "Empty",
          connection: { origin: "https://example.com" },
        }),
      ),
    /at least one sync or destination/,
  );
});
