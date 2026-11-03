import { defineIntegration, z } from "@beetlio/connect";
import { runSync, withFileSink, type EmittedBatch } from "@beetlio/connect/host";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixtureDirectory } from "./support.ts";

const connection = { origin: "https://example.com" };
const request = async () => {
  throw new Error("Unexpected HTTP request");
};

test("checkpoints follow the sync definition", async () => {
  const integration = defineIntegration({
    key: "policy",
    displayName: "Policy",
    connection,
    syncs: (sync) => ({
      resumable: sync({
        records: z.object({ id: z.number() }),
        checkpoint: z.number(),
        async *run(ctx) {
          yield { records: [{ id: 1 }], checkpoint: (ctx.checkpoint ?? 0) + 1 };
        },
      }),
      full: sync({
        records: z.object({ id: z.number() }),
        async *run() {
          yield { records: [{ id: 1 }] };
        },
      }),
    }),
  });
  for (const [input, checkpoint] of [
    [{ sync: "resumable" }, 1],
    [{ sync: "resumable", checkpoint: 5 }, 6],
  ] as const) {
    const batches: EmittedBatch[] = [];
    const result = await runSync(integration, input, {
      request,
      async commit(batch) {
        batches.push(batch);
        return "continue";
      },
    });
    assert.equal(batches[0]?.checkpoint, checkpoint);
    assert.deepEqual(result, { outcome: "completed", batches: 1, records: 1, checkpoint });
  }
  await assert.rejects(
    runSync(
      integration,
      { sync: "full", checkpoint: 5 },
      { request, commit: async () => "continue" },
    ),
    /Sync does not declare a checkpoint/,
  );
});

test("file sink resumes append and publishes replace state with its output", async (t) => {
  const directory = await fixtureDirectory(t, "sync-policy");
  const outputPath = join(directory, "records.ndjson");
  const statePath = join(directory, "checkpoint.json");
  const batch = { batchId: "one", sequence: 0, records: [{ id: 1 }], checkpoint: 99 };

  await writeFile(statePath, "17\n");
  await withFileSink({ outputPath, statePath }, async (sink) => {
    assert.equal(sink.checkpoint, 17);
    await sink.commit({ ...batch, checkpoint: 18 });
  });
  assert.equal(await readFile(statePath, "utf8"), "18\n");

  const replace = { outputPath, statePath, mode: "replace" } as const;
  await writeFile(outputPath, '{"id":0}\n');
  await assert.rejects(
    withFileSink(replace, async (sink) => {
      assert.equal(sink.checkpoint, undefined);
      await sink.commit(batch);
      throw new Error("failed run");
    }),
    /failed run/,
  );
  assert.equal(await readFile(statePath, "utf8"), "18\n");
  assert.equal(await readFile(outputPath, "utf8"), '{"id":0}\n');

  await withFileSink(replace, async (sink) => {
    await sink.commit(batch);
  });
  assert.equal(await readFile(statePath, "utf8"), "99\n");
  assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n');

  await withFileSink(replace, async () => {});
  assert.equal(await readFile(outputPath, "utf8"), "");
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
});
