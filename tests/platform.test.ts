import { defineIntegration, storageRecord, z } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import assert from "node:assert/strict";
import test from "node:test";
import { checkPlatformRecordSchemas, runPlatformSync } from "../src/cli/platform.ts";
import type { IntegrationDefinition, SyncEnd } from "../src/index.ts";
import { syncHost } from "./support.ts";

function integration(
  records: z.ZodObject,
  run: () => AsyncGenerator<
    { records: Record<string, unknown>[]; checkpoint?: number },
    SyncEnd,
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
  checkPlatformRecordSchemas(
    createIntegrationManifest(integration(records, async function* () {})).syncs,
  );

test("record schemas that Beetl cannot store fail before upload", () => {
  for (const [records, location, reason] of [
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

  // Every shape Beetl rejects is listed, so one pack run shows all fields to fix.
  assert.throws(
    () =>
      checkSchema(
        z.object({ metadata: z.record(z.string(), z.string()), pair: z.tuple([z.string()]) }),
      ),
    (error: Error) =>
      error.message.split("\n").length === 3 &&
      error.message.includes("records.properties.metadata: objects must declare properties") &&
      error.message.includes("records.properties.pair: tuple arrays"),
  );

  // Beetl accepts these formats at upload but rejects some values that Zod accepts.
  assert.deepEqual(
    checkSchema(
      z.object({
        website: z.url(),
        timeout: z.object({ value: z.iso.duration().nullable() }),
      }),
    ).map((format) => format.split(": ")[0]),
    [
      "syncs[items].records.properties.website",
      "syncs[items].records.properties.timeout.properties.value",
    ],
  );
  assert.match(
    checkSchema(z.object({ timeout: z.iso.duration() }))[0]!,
    /z\.iso\.duration\(\) accepts durations that Beetl rejects, such as PT1\.5S or P1Y2D/,
  );

  assert.deepEqual(
    checkSchema(
      z.object({
        id: z.string(),
        count: z.number().int(),
        note: z.string().nullable().optional(),
        created: z.iso.datetime(),
        email: z.email(),
        tags: z.array(z.object({ name: z.string() })),
      }),
    ),
    [],
  );
  assert.deepEqual(
    checkSchema(
      storageRecord(
        z.object({
          website: z.url(),
          timeout: z.iso.duration(),
          metadata: z.record(z.string(), z.json()),
          id: z.union([z.string(), z.number()]),
        }),
      ),
    ),
    [],
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
    { message: "Sync batch exceeds its limit" },
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
  // The CLI process may already be large from its build and earlier segments; only
  // what a segment adds counts against the limit.
  const CliRss = 3 * 1024 ** 3;
  let growth = 64 * 1024 ** 2;
  const rss = t.mock.method(process.memoryUsage, "rss", () => CliRss);

  const small = runPlatformSync(
    integration(Records, async function* () {
      rss.mock.mockImplementation(() => CliRss + growth);
      await new Promise((resolve) => setTimeout(resolve, 300));
      yield { records: [{ id: "one" }], checkpoint: 1 };
    }),
    { sync: "items" },
    syncHost(),
  );

  assert.equal((await small).outcome, "completed");

  rss.mock.mockImplementation(() => CliRss);
  growth = 1024 ** 3;

  await assert.rejects(
    runPlatformSync(
      integration(Records, async function* () {
        rss.mock.mockImplementation(() => CliRss + growth);
        yield* hang();
      }),
      { sync: "items" },
      syncHost(),
    ),
    {
      message:
        "the integration ran out of memory: it used more than its 1 GiB limit and was stopped",
    },
  );

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
