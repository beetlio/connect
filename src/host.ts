import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { EmittedBatch, RunSyncResult } from "./execution-schema.ts";
import { paginate, parseResponse } from "./http.ts";
import type {
  DestinationBatch,
  IntegrationDefinition,
  IntegrationLogger,
  JsonObject,
  JsonValue,
  RetryDefinition,
  SyncDefinition,
  SyncFetchInit,
} from "./index.ts";
import { isJsonValue, jsonSnapshot } from "./json.ts";
import { createIntegrationManifest } from "./manifest.ts";

export type { EmittedBatch, RunSyncResult } from "./execution-schema.ts";

export {
  HOST_CONTRACT_VERSION,
  SUPPORTED_HOST_CONTRACT_VERSIONS,
  assertSupportedHostContractVersion,
} from "./manifest.ts";

export { createProvider, type ProviderOptions } from "./provider.ts";

export { withFileSink, type FileSinkOptions } from "./file-sink.ts";

export {
  prepareOAuthAuthorization,
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  refreshOAuthAuthorization,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationState,
  type OAuthDefinition,
  type OAuthRequestOptions,
} from "./oauth.ts";

export interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body?: Uint8Array;
  readonly retry?: RetryDefinition;
}

export interface ProviderResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

export type CommitAction = "continue" | "stop";

export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: JsonObject;
}

export interface RequestHost {
  request(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
  log?(entry: LogEntry): Promise<void>;
}

export interface SyncHost extends RequestHost {
  commit(batch: EmittedBatch): Promise<CommitAction>;
}

export interface VerifyConnectionInput {
  readonly connectionConfig?: unknown;
  readonly signal?: AbortSignal;
}

export interface RunSyncInput extends VerifyConnectionInput {
  readonly sync: string;
  readonly syncConfig?: unknown;
  readonly checkpoint?: unknown;
}

export interface RunDestinationBatchInput extends VerifyConnectionInput {
  readonly destination: string;
  readonly destinationConfig?: unknown;
  readonly batch: unknown;
}

const ProviderResponseSchema = z.strictObject({
  status: z.number().int().min(200).max(599),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z
    .instanceof(Uint8Array)
    .refine((body) => body.byteLength <= 16 * 1024 * 1024, "Provider response exceeds 16 MiB"),
});

const EmptyConfig = z.strictObject({});
const YieldedBatch = z.strictObject({
  records: z.array(z.unknown()),
  deletedKeys: z.array(z.unknown()).optional(),
  checkpoint: z.unknown().optional(),
});
const DestinationBatchInput = YieldedBatch.omit({ checkpoint: true }).extend({
  batchId: z.string().min(1),
});

/** Apply one prepared batch. The caller owns durable acknowledgments and replay. */
export async function runDestinationBatch(
  integration: IntegrationDefinition,
  input: RunDestinationBatchInput,
  host: RequestHost,
): Promise<void> {
  createIntegrationManifest(integration);
  const destination = Object.hasOwn(integration.destinations ?? {}, input.destination)
    ? integration.destinations?.[input.destination]
    : undefined;
  if (!destination) throw new Error(`Unknown destination ${JSON.stringify(input.destination)}`);

  const raw = DestinationBatchInput.parse(input.batch);
  if (raw.records.length + (raw.deletedKeys?.length ?? 0) > 10_000)
    throw new Error("Destination batch exceeds 10000 record and deletion changes");
  if (raw.deletedKeys !== undefined && !destination.supportsDelete)
    throw new Error("Destination does not support deletions");

  // Snapshot before any await or author-defined normalization can modify input.
  const value = jsonSnapshot(raw, "Invalid destination batch: must be JSON-compatible");
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024)
    throw new Error("Destination batch exceeds 8 MiB");

  input.signal?.throwIfAborted();
  const connection = await parse(
    integration.connection.inputs ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const config = await parse(
    destination.inputs ?? EmptyConfig,
    input.destinationConfig ?? {},
    "destination config",
  );
  const records = await parseRecords(destination.records.strict(), value.records);
  const deletedKeys = await parseDeletedKeys(destination, value.deletedKeys);
  validateRecordKeys(destination.primaryKey, records, deletedKeys, "destination");
  const batch: DestinationBatch<JsonObject> = {
    batchId: value.batchId,
    records,
    ...(value.deletedKeys === undefined ? {} : { deletedKeys }),
  };
  if (Buffer.byteLength(JSON.stringify(batch)) > 8 * 1024 * 1024)
    throw new Error("Destination batch exceeds 8 MiB");

  const scope = executionScope(host, { signal: input.signal, retry: integration.connection.retry });
  const failures: unknown[] = [];
  try {
    scope.context.signal.throwIfAborted();
    await destination.run({ ...scope.context, config: { connection, destination: config } }, batch);
    input.signal?.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    scope.abort();
    try {
      await scope.settle();
    } catch (error) {
      failures.push(error);
    }
  }
  throwFailures(failures, input.signal);
}

export async function runSync(
  integration: IntegrationDefinition,
  input: RunSyncInput,
  host: SyncHost,
): Promise<RunSyncResult> {
  createIntegrationManifest(integration);

  const sync = integration.syncs[input.sync];

  if (!sync) throw new Error(`Unknown sync ${JSON.stringify(input.sync)}`);

  const connection = await parse(
    integration.connection.inputs ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const config = await parse(sync.inputs ?? EmptyConfig, input.syncConfig ?? {}, "sync config");
  let checkpoint =
    input.checkpoint === undefined
      ? undefined
      : jsonSnapshot(input.checkpoint, "Invalid checkpoint input: must be JSON-compatible");

  if (checkpoint !== undefined) await parseCheckpoint(sync, checkpoint);

  const scope = executionScope(host, { signal: input.signal, retry: integration.connection.retry });
  let iterator: ReturnType<SyncDefinition["run"]> | undefined;
  let batches = 0,
    records = 0,
    deleted = 0;
  let stopped = false;
  const failures: unknown[] = [];

  try {
    iterator = sync.run({
      ...scope.context,
      config: { connection, sync: config },
      checkpoint: checkpoint === undefined ? undefined : structuredClone(checkpoint),
    });

    while (true) {
      scope.context.signal.throwIfAborted();

      const step = await iterator.next();

      if (step.done) break;

      const value = YieldedBatch.parse(step.value);

      if (value.records.length + (value.deletedKeys?.length ?? 0) > 10_000)
        throw new Error("Emitted batch exceeds 10000 record and deletion changes");

      const parsedRecords = await parseRecords(sync.records, value.records);
      if (value.deletedKeys !== undefined && sync.mode !== "merge")
        throw new Error("Only merge syncs can emit deleted keys");
      const deletedKeys = await parseDeletedKeys(sync, value.deletedKeys);

      if (sync.mode === "merge")
        validateRecordKeys(sync.primaryKey!, parsedRecords, deletedKeys, "merge");

      const next =
        value.checkpoint === undefined
          ? undefined
          : jsonSnapshot(value.checkpoint, "Invalid checkpoint input: must be JSON-compatible");

      if (next !== undefined) await parseCheckpoint(sync, next);

      scope.context.signal.throwIfAborted();

      const action = await host.commit({
        batchId: crypto.randomUUID(),
        sequence: batches,
        records: parsedRecords,
        ...(deletedKeys.length ? { deletedKeys } : {}),
        ...(next === undefined ? {} : { checkpoint: next }),
      });

      if (action !== "continue" && action !== "stop")
        throw new Error("Host commit must return continue or stop");

      if (action === "stop" && next === undefined)
        throw new Error("The controller cannot request continuation without a checkpoint");

      batches++;
      records += parsedRecords.length;
      deleted += deletedKeys.length;

      if (next !== undefined) checkpoint = next;

      if (action === "stop") {
        stopped = true;

        break;
      }
    }

    input.signal?.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    scope.abort();

    try {
      await iterator?.return();
    } catch (error) {
      failures.push(error);
    }

    try {
      await scope.settle();
    } catch (error) {
      failures.push(error);
    }
  }

  throwFailures(failures, input.signal);

  return {
    outcome: stopped ? "continuation_required" : "completed",
    batches,
    records,
    deleted,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export async function verifyConnection(
  integration: IntegrationDefinition,
  input: VerifyConnectionInput,
  host: RequestHost,
): Promise<void> {
  createIntegrationManifest(integration);

  const verify = integration.connection.verify;

  if (!verify)
    throw new Error(
      `Integration ${JSON.stringify(integration.key)} does not define connection verification`,
    );

  const config = await parse(
    integration.connection.inputs ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const scope = executionScope(host, { signal: input.signal, retry: integration.connection.retry });
  const failures: unknown[] = [];

  try {
    scope.context.signal.throwIfAborted();
    await verify({ ...scope.context, config });
    input.signal?.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    scope.abort();

    try {
      await scope.settle();
    } catch (error) {
      failures.push(error);
    }
  }

  throwFailures(failures, input.signal);
}

function throwFailures(failures: readonly unknown[], signal?: AbortSignal): void {
  const unique = [...new Set(failures)];

  if (unique.length === 1) throw unique[0];

  if (unique.length) throw new AggregateError(unique, "Execution and cleanup failed");

  signal?.throwIfAborted();
}

function executionScope(
  host: RequestHost,
  options: { signal: AbortSignal | undefined; retry: RetryDefinition | undefined },
) {
  const lifecycle = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifecycle.signal])
    : lifecycle.signal;
  const pending = new Set<Promise<unknown>>();
  let logs = Promise.resolve();
  let loggingClosed = false;
  const fetch = (path: string, init?: SyncFetchInit): Promise<Response> => {
    const operation = hostFetch(host, path, init, { signal, retry: options.retry });

    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );

    return operation;
  };
  const log = (level: LogEntry["level"], message: string, fields: JsonObject = {}) => {
    if (loggingClosed) return Promise.reject(new Error("Execution context is closed"));

    logs = logs.then(async () => {
      await host.log?.({
        level,
        message,
        fields: z.record(z.string(), z.json()).parse(jsonSnapshot(fields, "Invalid log fields")),
      });
    });
    void logs.catch(() => undefined);

    return logs;
  };
  const logger: IntegrationLogger = {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };

  return {
    context: {
      signal,
      fetch,
      log: logger,
      json: <S extends z.ZodType>(path: string, schema: S, init?: SyncFetchInit) =>
        fetch(path, init).then((response) => parseResponse(response, schema)),
      paginate: <S extends z.ZodType>(options: import("./http.ts").PaginateOptions<S>) =>
        paginate(fetch, options),
    },
    abort: () => lifecycle.abort(new Error("Execution context is closed")),
    async settle() {
      await Promise.allSettled(pending);
      loggingClosed = true;
      await logs;
    },
  };
}

async function hostFetch(
  host: RequestHost,
  path: string,
  init: SyncFetchInit = {},
  environment: { signal: AbortSignal; retry: RetryDefinition | undefined },
): Promise<Response> {
  const { signal: runSignal, retry } = environment;

  if (
    (!path.startsWith("/") && !/^https?:\/\//.test(path)) ||
    path.startsWith("//") ||
    /[\\\s#]/.test(path)
  ) {
    throw new Error("Provider requests require a relative path or a same-origin HTTP URL");
  }

  const signal = init.signal ? AbortSignal.any([runSignal, init.signal]) : runSignal;

  signal.throwIfAborted();

  if (init.body instanceof ReadableStream) {
    throw new Error("Streaming request bodies are not supported");
  }

  const request = new Request("https://provider.invalid", {
    method: init.method ?? "GET",
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
  });
  const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());

  signal.throwIfAborted();

  const response = ProviderResponseSchema.parse(
    await host.request(
      {
        method: request.method,
        path,
        headers: [...request.headers.entries()],
        ...(body === undefined ? {} : { body }),
        ...(retry === undefined ? {} : { retry }),
      },
      signal,
    ),
  );

  signal.throwIfAborted();

  const responseBody = ![101, 204, 205, 304].includes(response.status)
    ? Uint8Array.from(response.body).buffer
    : null;

  return new Response(responseBody, {
    status: response.status,
    headers: response.headers.map(([name, value]): [string, string] => [name, value]),
  });
}

async function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): Promise<T & JsonValue> {
  const result = await schema.safeParseAsync(value);

  if (!result.success) {
    throw new Error(`Invalid ${label}: ${z.prettifyError(result.error)}`);
  }

  return jsonSnapshot(result.data, `Invalid ${label}: schema output must be JSON-compatible`) as T &
    JsonValue;
}

async function parseRecords(
  schema: z.ZodObject,
  records: readonly unknown[],
): Promise<JsonObject[]> {
  return Promise.all(
    records.map(async (record, index) => {
      const parsed = await parse(schema, record, `record ${index}`);
      if (!isJsonObject(parsed)) throw new Error(`Invalid record ${index}: must be an object`);
      return parsed;
    }),
  );
}

async function parseDeletedKeys(
  definition: Pick<SyncDefinition, "records" | "primaryKey">,
  value: readonly unknown[] | undefined,
): Promise<JsonObject[]> {
  if (value === undefined) return [];

  const fields = definition.primaryKey!;
  const schema = z.strictObject(
    Object.fromEntries(fields.map((field) => [field, definition.records.shape[field]!])),
  );

  return Promise.all(
    value.map(async (candidate, index) => {
      const parsed = await parse(schema, candidate, `deleted key ${index}`);

      if (!isJsonObject(parsed) || Object.values(parsed).some((item) => !isJsonScalar(item))) {
        throw new Error(`Invalid deleted key ${index}: values must be scalar and non-null`);
      }

      return parsed;
    }),
  );
}

function validateRecordKeys(
  primaryKey: readonly string[],
  records: readonly JsonObject[],
  deletedKeys: readonly JsonObject[],
  kind: "merge" | "destination",
): void {
  const identities = new Set<string>();

  for (const [index, record] of records.entries()) {
    const values = primaryKey.map((field) => record[field]);

    if (values.some((value) => !isJsonScalar(value))) {
      throw new Error(`Invalid record ${index}: ${kind} primary keys must be scalar and non-null`);
    }

    const identity = JSON.stringify(values);

    if (identities.has(identity)) {
      throw new Error(`Duplicate ${kind} key in record ${index}`);
    }

    identities.add(identity);
  }

  for (const [index, key] of deletedKeys.entries()) {
    const identity = JSON.stringify(primaryKey.map((field) => key[field]));

    if (identities.has(identity)) {
      throw new Error(`Duplicate or conflicting ${kind} deletion key ${index}`);
    }

    identities.add(identity);
  }
}

function isJsonScalar(value: JsonValue | undefined): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
}

async function parseCheckpoint(sync: SyncDefinition, value: JsonValue): Promise<JsonValue> {
  if (!sync.checkpoint) {
    throw new Error("Sync does not declare a checkpoint");
  }

  const parsed = await parse(sync.checkpoint, value, "checkpoint");

  if (!isDeepStrictEqual(parsed, value)) {
    throw new Error("Checkpoint schemas must preserve the serialized JSON value");
  }

  return value;
}
