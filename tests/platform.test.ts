import { defineIntegration, storageRecord, z } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import assert from "node:assert/strict";
import test from "node:test";
import { assertPlatformRecordSchemas, runPlatformSync } from "../src/cli/platform.ts";
import type { IntegrationDefinition } from "../src/index.ts";
import { syncHost } from "./support.ts";

function integration(
  records: z.ZodObject,
  run: () => AsyncGenerator<
    { records: Record<string, unknown>[]; checkpoint?: number },
    { hasMore: true } | void,
    unknown
  >,
): IntegrationDefinition {
  return defineIntegration({
    key: "platform",
    displayName: "Platform",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({ records, checkpoint: z.number(), run }),
    }),
  }) as IntegrationDefinition;
}

const checkSchema = (records: z.ZodObject) =>
  assertPlatformRecordSchemas(
    createIntegrationManifest(integration(records, async function* () {})),
  );

test("record schemas that Beetl cannot store or validate like Zod fail before upload", () => {
  for (const [records, location, reason] of [
    [
      z.object({ website: z.url() }),
      "properties.website",
      /z\.url\(\) accepts URLs that Beetl rejects/,
    ],
    [
      z.object({ timeout: z.iso.duration().nullable() }),
      "properties.timeout",
      /durations that Beetl rejects, such as PT1\.5S or P1Y2D/,
    ],
    [
      z.object({ metadata: z.record(z.string(), z.string()) }),
      "properties.metadata",
      /objects must declare properties; z\.record\(\) fields have no fixed columns/,
    ],
    [
      z.object({ owner: z.object({ tags: z.array(z.record(z.string(), z.number())) }) }),
      "properties.owner.properties.tags.items",
      /objects must declare properties/,
    ],
    [
      z.object({ extra: z.looseObject({ id: z.string() }) }),
      "properties.extra",
      /additionalProperties to false; z\.looseObject\(\)/,
    ],
    [
      z.object({ id: z.union([z.string(), z.number()]) }),
      "properties.id",
      /type arrays must contain exactly one storage type and null/,
    ],
    [z.object({ payload: z.json() }), "properties.payload", /keyword \$ref cannot be represented/],
    [
      z.object({ pair: z.tuple([z.string(), z.number()]) }),
      "properties.pair",
      /tuple arrays cannot be represented/,
    ],
  ] as const) {
    assert.throws(
      () => checkSchema(records),
      (error: Error) =>
        error.message.startsWith(`Invalid JSON Schema at syncs[items].records.${location}: `) &&
        reason.test(error.message) &&
        error.message.endsWith(
          "storageRecord() from @beetlio/connect stores fields that Beetl cannot type as text.",
        ),
    );
  }

  checkSchema(
    z.object({
      id: z.string(),
      count: z.number().int(),
      note: z.string().nullable().optional(),
      created: z.iso.datetime(),
      email: z.email(),
      tags: z.array(z.object({ name: z.string() })),
    }),
  );
  checkSchema(
    storageRecord(
      z.object({
        website: z.url(),
        timeout: z.iso.duration(),
        metadata: z.record(z.string(), z.json()),
        id: z.union([z.string(), z.number()]),
      }),
    ),
  );
});

const batches = (count: number, checkpoint: (index: number) => number | undefined) =>
  async function* () {
    for (let index = 0; index < count; index++) {
      const value = checkpoint(index);

      yield {
        records: [{ id: String(index) }],
        ...(value === undefined ? {} : { checkpoint: value }),
      };
    }
  };
const Records = z.object({ id: z.string() });

test("a strict run stops at a new checkpoint once half of its batch limit is used", async () => {
  const committed: number[] = [];
  const result = await runPlatformSync(
    integration(
      Records,
      batches(6_000, (index) => index + 1),
    ),
    { sync: "items" },
    syncHost({
      async commit(batch) {
        committed.push(batch.sequence);
        return "continue";
      },
    }),
  );

  assert.deepEqual(
    { outcome: result.outcome, batches: result.batches, checkpoint: result.checkpoint },
    { outcome: "continuation_required", batches: 5_000, checkpoint: 5_000 },
  );
  assert.equal(committed.length, 5_000);

  // A repeated checkpoint may end in the middle of a window, so the run continues past it.
  const repeated = await runPlatformSync(
    integration(
      Records,
      batches(5_002, (index) => (index < 5_001 ? 1 : 2)),
    ),
    { sync: "items" },
    syncHost(),
  );

  assert.deepEqual(
    { outcome: repeated.outcome, batches: repeated.batches },
    { outcome: "continuation_required", batches: 5_002 },
  );
});

test("a strict run fails with Beetl's message past its batch and envelope limits", async () => {
  await assert.rejects(
    runPlatformSync(
      integration(
        Records,
        batches(10_001, () => undefined),
      ),
      { sync: "items" },
      syncHost(),
    ),
    { message: "run emitted more than 10000 batches" },
  );
  await assert.rejects(
    runPlatformSync(
      integration(Records, async function* () {
        yield { records: [{ id: "x".repeat(8 * 1024 * 1024) }] };
      }),
      { sync: "items" },
      syncHost(),
    ),
    { message: "Emitted batch exceeds 8388608 bytes" },
  );
});

test("a strict run counts staged NDJSON bytes against Beetl's 1 GiB run limit", async () => {
  const value = "x".repeat(7 * 1024 * 1024);
  const large = (checkpoint: (index: number) => number | undefined) =>
    async function* () {
      for (let index = 0; ; index++) {
        const next = checkpoint(index);

        yield { records: [{ id: value }], ...(next === undefined ? {} : { checkpoint: next }) };
      }
    };

  const stopped = await runPlatformSync(
    integration(
      Records,
      large((index) => index + 1),
    ),
    { sync: "items" },
    syncHost(),
  );

  // 74 batches of 7 MiB pass half of the limit.
  assert.deepEqual(
    { outcome: stopped.outcome, batches: stopped.batches },
    { outcome: "continuation_required", batches: 74 },
  );
  await assert.rejects(
    runPlatformSync(
      integration(
        Records,
        large(() => undefined),
      ),
      { sync: "items" },
      syncHost(),
    ),
    { message: "run staged more than 1 GiB of records" },
  );
});

test("a strict run ends like the hosted runtime at its memory limit and deadline", async (t) => {
  const hang = async function* () {
    // Ignores cancellation, as the runtime cannot rely on it either.
    await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
  };
  const rss = t.mock.method(process.memoryUsage, "rss", () => 1024 ** 3 + 1);

  await assert.rejects(runPlatformSync(integration(Records, hang), { sync: "items" }, syncHost()), {
    message: "the integration ran out of memory: it used more than its 1 GiB limit and was stopped",
  });

  rss.mock.restore();

  let elapsed = 0;
  const realNow = Date.now.bind(Date);

  t.mock.method(Date, "now", () => realNow() + elapsed);

  const nearDeadline = await runPlatformSync(
    integration(Records, async function* () {
      elapsed = 11 * 60_000;
      yield { records: [{ id: "one" }], checkpoint: 1 };
      yield { records: [{ id: "two" }], checkpoint: 2 };
    }),
    { sync: "items" },
    syncHost(),
  );

  assert.deepEqual(
    { outcome: nearDeadline.outcome, batches: nearDeadline.batches },
    { outcome: "continuation_required", batches: 1 },
  );

  elapsed = 0;

  await assert.rejects(
    runPlatformSync(
      integration(Records, async function* () {
        elapsed = 15 * 60_000;
        yield* hang();
      }),
      { sync: "items" },
      syncHost(),
    ),
    { message: "the integration did not finish within its time limit" },
  );
});
