import assert from "node:assert/strict";
import test from "node:test";
import { createIntegrationManifest, defineIntegration, storageRecord, z } from "@beetlio/connect";
import { runSync, type EmittedBatch } from "@beetlio/connect/host";

test("storage records preserve typed nested columns and serialize dynamic fields", async () => {
  const source = z.object({
    id: z.union([z.string(), z.number()]),
    amount: z.number(),
    metadata: z.record(z.string(), z.json()),
    items: z.array(
      z.object({ value: z.json(), count: z.number(), note: z.string().nullable().optional() }),
    ),
    address: z.object({ city: z.string() }).nullable().optional(),
  });
  const records = storageRecord(source);
  const definition = defineIntegration({
    key: "storage",
    displayName: "Storage",
    connection: { origin: "https://example.com" },
    syncs: (define) => [
      define({
        key: "records",
        displayName: "Records",
        mode: "replace",
        records,
        async run(ctx) {
          await ctx.emit({
            records: [
              {
                id: 123,
                amount: 2.5,
                metadata: { labels: ["a", 1] },
                items: [{ value: { nested: true }, count: 2 }],
                address: null,
              },
            ],
          });
        },
      }),
    ],
  });
  const batches: EmittedBatch[] = [];
  await runSync(
    definition,
    "records",
    {},
    {
      async request() {
        throw new Error("No request expected");
      },
      async emit(batch) {
        batches.push(batch);
      },
      async log() {},
    },
  );
  assert.deepEqual(batches[0]?.records[0], {
    id: "123",
    amount: 2.5,
    metadata: '{"labels":["a",1]}',
    items: [{ value: '{"nested":true}', count: 2 }],
    address: null,
  });
  const manifest = createIntegrationManifest(definition);
  assert.doesNotMatch(
    JSON.stringify(manifest.syncs[0]?.records),
    /\$ref|\$defs|additionalProperties":true/,
  );
  assert.throws(() => records.parse({ id: {}, amount: 2, metadata: {}, items: [] }));
  assert.throws(() => records.parse({ id: "id", amount: "2", metadata: {}, items: [] }));
});

test("nullable mixed primitive IDs preserve the same text identity as required IDs", () => {
  const records = storageRecord(
    z.object({
      id: z.union([z.string(), z.number()]),
      parent: z.union([z.string(), z.number()]).nullable().optional(),
    }),
  );
  assert.deepEqual(records.parse({ id: "id1", parent: "id1" }), { id: "id1", parent: "id1" });
  assert.deepEqual(records.parse({ id: 123, parent: 123 }), { id: "123", parent: "123" });
  assert.deepEqual(records.parse({ id: "id1", parent: null }), { id: "id1", parent: null });
});

test("storage projection retains strict root validation and rejects open root columns", () => {
  const records = storageRecord(z.strictObject({ id: z.string() }));
  assert.deepEqual(records.parse({ id: "id1" }), { id: "id1" });
  assert.throws(() => records.parse({ id: "id1", extra: true }));
  assert.throws(() => storageRecord(z.looseObject({ id: z.string() })), /fixed root/);
});
