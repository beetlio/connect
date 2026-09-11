import { batchRecords, defineIntegration, storageRecord, z } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import { runSync, type EmittedBatch } from "@beetlio/connect/host";
import assert from "node:assert/strict";
import test from "node:test";
import { syncHost } from "./support.ts";

test("batchRecords preserves order and bounds count and bytes without a flush call", async () => {
  const source = Array.from({ length: 205 }, (_, id) => ({ id }));
  const batches = await collect(batchRecords(source));

  assert.deepEqual(
    batches.map((batch) => batch.records.length),
    [100, 100, 5],
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.records),
    source,
  );

  const large = { value: "x".repeat(1024 * 1024) };
  const sizes = await collect(batchRecords([{ value: "small" }, large, { value: "last" }]));

  assert.deepEqual(
    sizes.map((batch) => batch.records.length),
    [1, 1, 1],
  );

  async function* reusedRecord() {
    const record = { id: 1 };

    yield record;
    record.id = 2;
    yield record;
    record.id = 3;
  }

  assert.deepEqual(
    (await collect(batchRecords(reusedRecord()))).flatMap((batch) => batch.records),
    [{ id: 1 }, { id: 2 }],
  );

  await assert.rejects(collect(batchRecords([{ value: undefined }])), /JSON-compatible/);
});

test("batchRecords does not flush partial output after source failure", async () => {
  async function* source() {
    yield { id: 1 };

    throw new Error("provider failed");
  }

  const output: unknown[] = [];

  await assert.rejects(async () => {
    for await (const batch of batchRecords(source())) output.push(batch);
  }, /provider failed/);

  assert.deepEqual(output, []);
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of source) values.push(value);

  return values;
}

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
    syncs: (define) => ({
      records: define({
        displayName: "Records",
        mode: "replace",
        records,
        async *run(ctx) {
          yield {
            records: [
              {
                id: 123,
                amount: 2.5,
                metadata: { labels: ["a", 1] },
                items: [{ value: { nested: true }, count: 2 }],
                address: null,
              },
            ],
          };
        },
      }),
    }),
  });
  const batches: EmittedBatch[] = [];

  await runSync(
    definition,
    { sync: "records" },
    syncHost({
      async commit(batch) {
        batches.push(batch);

        return "continue";
      },
    }),
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
