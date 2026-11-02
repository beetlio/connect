import { defineIntegration, z } from "@beetlio/connect";
import { runSync, withFileSink, type EmittedBatch, type RunSyncInput } from "@beetlio/connect/host";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixtureDirectory } from "./support.ts";

test("file sink keeps its lock through failure and releases it for the next run", async (t) => {
  const directory = await fixtureDirectory(t, "sync-lock");
  const options = {
    outputPath: join(directory, "records.ndjson"),
    statePath: join(directory, "checkpoint.json"),
  };
  const failure = new Error("execution failed");
  await assert.rejects(
    withFileSink(options, async () => {
      await assert.rejects(
        withFileSink(options, async () => assert.fail("Lock must exclude this run")),
        /Sync state is already in use/,
      );
      assert.equal(await readFile(`${options.statePath}.lock`, "utf8"), "");
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(readFile(`${options.statePath}.lock`), { code: "ENOENT" });
  assert.equal(await withFileSink(options, async () => "next run"), "next run");
});

const connection = { origin: "https://example.com" };
const request = async () => {
  throw new Error("Unexpected HTTP request");
};

test("host ignores checkpoints unless append checkpointing is enabled", async () => {
  const inputs: RunSyncInput[] = [
    { sync: "items" },
    { sync: "items", mode: "append", checkpointing: false },
    { sync: "items", mode: "replace", checkpointing: true },
  ];
  for (const input of inputs) {
    const integration = defineIntegration({
      key: "policy",
      displayName: "Policy",
      connection,
      syncs: (sync) => ({
        items: sync({
          records: z.object({ id: z.number() }),
          checkpoint: z.number(),
          async *run(ctx) {
            assert.equal(ctx.checkpoint, undefined);
            yield { records: [{ id: 1 }], checkpoint: Number.NaN };
          },
        }),
      }),
    });
    const batches: EmittedBatch[] = [];
    const result = await runSync(
      integration,
      { ...input, checkpoint: Symbol("ignored") },
      {
        request,
        async commit(batch) {
          batches.push(batch);
          return "continue";
        },
      },
    );
    assert.equal(batches.length, 1);
    assert.equal(Object.hasOwn(batches[0]!, "checkpoint"), false);
    assert.deepEqual(result, { outcome: "completed", batches: 1, records: 1 });
    await assert.rejects(
      runSync(integration, input, {
        request,
        async commit() {
          return "stop";
        },
      }),
      /cannot request continuation without a checkpoint/,
    );
  }
});

test("completed runs without checkpointing clear stale state; failed runs preserve it", async (t) => {
  const directory = await fixtureDirectory(t, "sync-policy");
  const outputPath = join(directory, "records.ndjson");
  const statePath = join(directory, "checkpoint.json");
  for (const mode of ["append", "replace"] as const) {
    await writeFile(outputPath, '{"id":0}\n');
    await writeFile(statePath, "17\n");
    const options = { outputPath, statePath, mode, checkpointing: mode === "replace" };
    const batch = { batchId: "one", sequence: 0, records: [{ id: 1 }], checkpoint: 99 };
    await assert.rejects(
      withFileSink(options, async (sink) => {
        assert.equal(sink.checkpoint, undefined);
        await sink.commit(batch);
        throw new Error("failed run");
      }),
      /failed run/,
    );
    assert.equal(await readFile(statePath, "utf8"), "17\n");
    if (mode === "replace") assert.equal(await readFile(outputPath, "utf8"), '{"id":0}\n');
    await withFileSink(options, async (sink) => {
      assert.equal(sink.checkpoint, undefined);
      await sink.commit(batch);
    });
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
    if (mode === "replace") assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n');
  }
  await writeFile(statePath, "17\n");
  await withFileSink({ outputPath, statePath, checkpointing: true }, async (sink) => {
    assert.equal(sink.checkpoint, 17);
    await sink.commit({ batchId: "two", sequence: 0, records: [], checkpoint: 18 });
  });
  assert.equal(await readFile(statePath, "utf8"), "18\n");
  await withFileSink({ outputPath, statePath, mode: "replace" }, async () => {});
  assert.equal(await readFile(outputPath, "utf8"), "");
  await assert.rejects(readFile(statePath), { code: "ENOENT" });
});
