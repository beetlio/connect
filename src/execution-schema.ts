import { z } from "zod";
import type { JsonObject as JsonObjectValue } from "./index.ts";

const JsonObject: z.ZodType<JsonObjectValue> = z.record(z.string(), z.json());

export const BatchSchema = z.strictObject({
  batchId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  records: z.array(JsonObject).readonly(),
  deletedKeys: z.array(JsonObject).readonly().optional(),
  checkpoint: z.json().optional(),
});

export const RunResultSchema = z.strictObject({
  outcome: z.enum(["completed", "continuation_required"]),
  batches: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  checkpoint: z.json().optional(),
});

type Batch = z.output<typeof BatchSchema>;
type RunResult = z.output<typeof RunResultSchema>;

// Preserve absent optional fields rather than allowing an explicit undefined value.
export type EmittedBatch = { readonly [Key in keyof Batch]: Exclude<Batch[Key], undefined> };
export type RunSyncResult = {
  readonly [Key in keyof RunResult]: Exclude<RunResult[Key], undefined>;
};
