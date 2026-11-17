import { isDeepStrictEqual } from "node:util";

import { runSync, type RunSyncInput, type RunSyncResult, type SyncHost } from "../host.ts";
import type { IntegrationDefinition } from "../index.ts";
import { isJsonSchema, type IntegrationManifest } from "../manifest.ts";

// Beetl's limits for one hosted sync run. Messages match the ones Beetl writes to the
// run log, so a local failure reads like the hosted one.
const MaxBatchesPerRun = 10_000;
const MaxStagedBytes = 1024 ** 3;
const MaxBatchEnvelopeBytes = 8 * 1024 * 1024;
const MemoryLimitBytes = 1024 ** 3;
const RunMilliseconds = 15 * 60_000;
const StopBeforeDeadlineMilliseconds = 5 * 60_000;
const WatchdogMilliseconds = 100;
// A hosted run starts each segment in a fresh process that has loaded the same SDK modules
// as this CLI by the time this module is evaluated. The CLI process also holds its own
// build and earlier segments, so a strict segment counts this startup footprint plus what
// it grows by itself.
const StartupRss = process.memoryUsage.rss();
const StorageHint =
  "storageRecord() from @beetlio/connect stores fields that Beetl cannot type as text.";

/**
 * Mirror Core's record schema mapping for the given syncs. Throws one error listing every
 * shape Core rejects when the package is uploaded. Returns string formats that Core accepts
 * at upload but validates more strictly than Zod at run time, so some records Zod accepts
 * fail the hosted run.
 */
export function checkPlatformRecordSchemas(syncs: IntegrationManifest["syncs"]): readonly string[] {
  const issues = { rejected: [] as string[], formats: [] as string[] };

  for (const sync of syncs) checkStorageType(sync.records, `syncs[${sync.key}].records`, issues);

  if (issues.rejected.length > 0) throw new Error(`${issues.rejected.join("\n")}\n${StorageHint}`);

  return issues.formats;
}

function checkStorageType(
  schema: unknown,
  location: string,
  issues: { rejected: string[]; formats: string[] },
): void {
  const reject = (reason: string) => {
    issues.rejected.push(`Invalid JSON Schema at ${location}: ${reason}`);
  };

  if (!isJsonSchema(schema)) return reject("storage fields must be object-form JSON Schemas");

  for (const keyword of [
    "$ref",
    "allOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "patternProperties",
    "unevaluatedProperties",
  ]) {
    if (Object.hasOwn(schema, keyword))
      return reject(
        `JSON Schema keyword ${keyword} cannot be represented as a stable storage type`,
      );
  }

  if (Object.hasOwn(schema, "anyOf")) {
    if (Object.hasOwn(schema, "type"))
      return reject("anyOf cannot be combined with type in a record storage schema");
    if (!Array.isArray(schema.anyOf)) return reject("anyOf must be an array");

    const values = schema.anyOf.filter((branch) => !isJsonSchema(branch) || branch.type !== "null");

    if (schema.anyOf.length !== 2 || values.length !== 1)
      return reject("anyOf must contain exactly one storage type and null");

    return checkStorageType(values[0], location, issues);
  }

  let type = schema.type;

  if (Array.isArray(type)) {
    const values = type.filter((value) => typeof value === "string" && value !== "null");

    if (type.length !== 2 || values.length !== 1 || !type.includes("null"))
      return reject("type arrays must contain exactly one storage type and null");

    type = values[0];
  } else if (type === undefined) {
    return reject("record fields must declare a storage type");
  } else if (typeof type !== "string") {
    return reject("type must be a string or a nullable type array");
  }

  switch (type) {
    case "string":
      // Zod checks these with its own rules; Beetl's validator rejects values Zod accepts.
      if (schema.format === "uri")
        issues.formats.push(
          `${location}: z.url() accepts URLs that Beetl rejects as URIs, such as ones with spaces or non-ASCII host names; declare the field as z.string() or use storageRecord()`,
        );
      if (schema.format === "duration")
        issues.formats.push(
          `${location}: z.iso.duration() accepts durations that Beetl rejects, such as PT1.5S or P1Y2D; declare the field as z.string() or use storageRecord()`,
        );
      return;
    case "integer":
    case "number":
    case "boolean":
      return;
    case "null":
      return reject("null-only fields have no storage type");
    case "object": {
      if (!isJsonSchema(schema.properties))
        return reject("objects must declare properties; z.record() fields have no fixed columns");
      if (schema.additionalProperties !== false)
        return reject(
          "objects must set additionalProperties to false; z.looseObject() and .catchall() fields have no fixed columns",
        );

      const properties = schema.properties;
      const required = Array.isArray(schema.required) ? schema.required : [];
      const missing = required.find(
        (field) => typeof field === "string" && !Object.hasOwn(properties, field),
      );

      if (missing !== undefined)
        return reject(`required field ${JSON.stringify(missing)} is not declared in properties`);

      for (const [name, property] of Object.entries(properties))
        checkStorageType(property, `${location}.properties.${name}`, issues);

      return;
    }
    case "array":
      if (Object.hasOwn(schema, "prefixItems"))
        return reject("tuple arrays cannot be represented as a stable storage type");
      if (!Object.hasOwn(schema, "items")) return reject("arrays must declare one item schema");

      return checkStorageType(schema.items, `${location}.items`, issues);
    default:
      return reject(`JSON Schema type ${JSON.stringify(type)} has no supported storage type`);
  }
}

/**
 * Run one sync segment as a Beetl-hosted run would: within its deadline and memory limit,
 * failing on batch and run limits, and stopping at the next new checkpoint once half of a
 * run limit is used or less than five minutes remain.
 */
export async function runPlatformSync(
  integration: IntegrationDefinition,
  input: RunSyncInput,
  host: SyncHost,
): Promise<RunSyncResult> {
  const deadline = Date.now() + RunMilliseconds;
  const segmentRss = process.memoryUsage.rss();
  const stopped = new AbortController();
  let rejectStopped: (reason: unknown) => void = () => undefined;
  const stoppedRun = new Promise<never>((_, reject) => (rejectStopped = reject));
  // The hosted runtime kills the process, so the run ends even if the sync ignores its signal.
  const stop = (message: string) => {
    if (stopped.signal.aborted) return;

    const reason = new Error(message);

    stopped.abort(reason);
    rejectStopped(reason);
  };
  const watchdog = setInterval(() => {
    if (StartupRss + process.memoryUsage.rss() - segmentRss > MemoryLimitBytes)
      stop(
        `the integration ran out of memory: it used more than its ${MemoryLimitBytes / 1024 ** 3} GiB limit and was stopped`,
      );
    else if (Date.now() >= deadline) stop("the integration did not finish within its time limit");
  }, WatchdogMilliseconds);
  let checkpoint = input.checkpoint;
  let batches = 0;
  let stagedBytes = 0;

  const run = runSync(
    integration,
    {
      ...input,
      signal:
        input.signal === undefined
          ? stopped.signal
          : AbortSignal.any([input.signal, stopped.signal]),
    },
    {
      ...host,
      async commit(batch) {
        stopped.signal.throwIfAborted();

        // Beetl's process host frames each batch like this and rejects frames over 8 MiB.
        const envelope = JSON.stringify({ kind: "batch", ...batch });

        if (Buffer.byteLength(envelope) > MaxBatchEnvelopeBytes)
          throw new Error("Sync batch exceeds its limit");
        if (batches >= MaxBatchesPerRun)
          throw new Error(`run emitted more than ${MaxBatchesPerRun} batches`);

        // Beetl stages records as NDJSON, one line per record.
        stagedBytes += batch.records.reduce(
          (total, record) => total + Buffer.byteLength(JSON.stringify(record)) + 1,
          0,
        );

        if (stagedBytes > MaxStagedBytes)
          throw new Error(`run staged more than ${MaxStagedBytes / 1024 ** 3} GiB of records`);

        batches++;

        // A batch that repeats the previous checkpoint may end in the middle of a
        // window, so Beetl only stops a run at a checkpoint that moved.
        const advanced =
          batch.checkpoint !== undefined && !isDeepStrictEqual(batch.checkpoint, checkpoint);

        if (batch.checkpoint !== undefined) checkpoint = batch.checkpoint;

        const action = await host.commit(batch);
        const nearLimits =
          batches >= MaxBatchesPerRun / 2 ||
          stagedBytes >= MaxStagedBytes / 2 ||
          deadline - Date.now() < StopBeforeDeadlineMilliseconds;

        return advanced && nearLimits ? "stop" : action;
      },
    },
  );

  // After a stop, the abandoned run may still settle; its outcome no longer matters.
  run.catch(() => undefined);

  try {
    return await Promise.race([stoppedRun, run]);
  } finally {
    clearInterval(watchdog);
  }
}
