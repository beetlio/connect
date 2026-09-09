import assert from "node:assert/strict";
import test from "node:test";
import { createRecordBatcher } from "@beetlio/connect";

test("record batching preserves order across parents and bounds count and encoded bytes", async () => {
  const batches: { id: number; text: string }[][] = [];
  const output = createRecordBatcher<{ id: number; text: string }>(async ({ records }) => {
    batches.push([...records]);
  });
  for (let id = 0; id < 10001; id++) await output.emit({ records: [{ id, text: "row" }] });
  await output.flush();
  assert.equal(batches.length, 101);
  assert.deepEqual(
    batches.flat().map((row) => row.id),
    Array.from({ length: 10001 }, (_, i) => i),
  );
  assert.ok(batches.every((batch) => batch.length <= 100));
  batches.length = 0;
  const row = { id: 1, text: "é".repeat(300000) };
  await output.emit({ records: [row, row] });
  row.id = 99;
  await output.flush();
  assert.equal(batches.length, 2);
  assert.equal(batches[1]![0]!.id, 1);
  await output.flush();
  assert.equal(batches.length, 2);
});
