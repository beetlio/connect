import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  auth as authentication,
  type AuthDefinition,
  type InputField,
  type InputObjectSchema,
  type IntegrationDefinition,
  type JsonObject,
  type JsonValue,
  type PaginateOptions,
  type PaginationDefinition,
  type PaginationOverride,
  type PaginationPage,
  type PaginationResponseMetadata,
  type RetryDefinition,
  type RetryPolicy,
  type SyncFetchInit,
  type SyncDefinition,
} from "./index.ts";
import { createIntegrationManifest } from "./manifest.ts";

const MaxPaginationPages = 10_000;
const MaxChangesPerBatch = 10_000;

export interface ProviderRequest {
  method: string;
  path: string;
  headers: ReadonlyArray<readonly [string, string]>;
  body?: Uint8Array;
  retry?: RetryDefinition;
}

export interface ProviderResponse {
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  body: Uint8Array;
}

export interface EmittedBatch {
  batchId: string;
  sequence: number;
  records: readonly JsonObject[];
  deletedKeys?: readonly JsonObject[];
  checkpoint?: JsonValue;
}

export type EmitAction = "continue" | "yield";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: JsonObject;
}

export interface SyncHost {
  request(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse>;
  emit(batch: EmittedBatch): Promise<EmitAction | void>;
  log(entry: LogEntry): Promise<void>;
}

export interface RunSyncInput {
  connectionConfig?: unknown;
  syncConfig?: unknown;
  checkpoint?: unknown;
  signal?: AbortSignal;
}

export interface RunSyncResult {
  outcome: "completed" | "continuation_required";
  batches: number;
  records: number;
  deleted: number;
  checkpoint?: JsonValue;
}

export interface VerifyConnectionInput {
  connectionConfig?: unknown;
  signal?: AbortSignal;
}

const EmptyConfig = z.strictObject({});

export async function runSync(
  integration: IntegrationDefinition,
  syncKey: string,
  input: RunSyncInput,
  host: SyncHost,
): Promise<RunSyncResult> {
  validateIntegration(integration);

  const sync = integration.syncs.find((candidate) => candidate.key === syncKey);
  if (!sync) {
    throw new Error(`Unknown sync ${JSON.stringify(syncKey)}`);
  }
  const connectionConfig = await parse(
    integration.connection.inputs?.schema ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const syncConfig = await parse(
    sync.inputs?.schema ?? EmptyConfig,
    input.syncConfig ?? {},
    "sync config",
  );
  const initialCheckpointInput =
    input.checkpoint === undefined
      ? undefined
      : jsonSnapshot(input.checkpoint, "Invalid checkpoint input: must be JSON-compatible");
  const initialCheckpoint =
    initialCheckpointInput === undefined
      ? undefined
      : await parseCheckpoint(sync, initialCheckpointInput);
  const runSignal = input.signal ?? new AbortController().signal;
  const lifecycle = new AbortController();
  const contextSignal = AbortSignal.any([runSignal, lifecycle.signal]);
  const continuation = new Error("Worker segment reached a safe continuation boundary");

  let sequence = 0;
  let records = 0;
  let deleted = 0;
  let latestCheckpoint = initialCheckpointInput;
  let continuationRequested = false;
  let emitQueue: Promise<unknown> = Promise.resolve();
  let logQueue = Promise.resolve();
  let contextOpen = true;
  const rejectClosed = <T>(): Promise<T> => {
    const rejected = Promise.reject<T>(new Error("Sync context is closed"));
    void rejected.catch(() => undefined);
    return rejected;
  };

  const emit = (value: {
    records: readonly unknown[];
    deletedKeys?: readonly unknown[];
    checkpoint?: unknown;
  }): Promise<void> => {
    if (!contextOpen) {
      return rejectClosed();
    }

    const queued = emitQueue.then(async () => {
      runSignal.throwIfAborted();
      if (!Array.isArray(value.records)) {
        throw new Error("Emitted records must be an array");
      }
      if (value.deletedKeys !== undefined && !Array.isArray(value.deletedKeys)) {
        throw new Error("Deleted keys must be an array");
      }
      const changes = value.records.length + (value.deletedKeys?.length ?? 0);
      if (changes > MaxChangesPerBatch) {
        throw new Error(`Emitted batch exceeds ${MaxChangesPerBatch} record and deletion changes`);
      }
      const parsedRecords = (
        await Promise.all(
          value.records.map((record, index) => parse(sync.records, record, `record ${index}`)),
        )
      ).map((record, index) => {
        const value = jsonSnapshot(record, `Invalid record ${index}: must be JSON-compatible`);
        if (!isJsonObject(value)) throw new Error(`Invalid record ${index}: must be an object`);
        return value;
      });
      const deletedKeys = await parseDeletedKeys(sync, value.deletedKeys);
      validateMergeKeys(sync, parsedRecords, deletedKeys);
      const checkpointInput =
        value.checkpoint === undefined
          ? undefined
          : jsonSnapshot(value.checkpoint, "Invalid checkpoint input: must be JSON-compatible");
      if (checkpointInput !== undefined) await parseCheckpoint(sync, checkpointInput);
      runSignal.throwIfAborted();
      const batch: EmittedBatch = {
        batchId: crypto.randomUUID(),
        sequence,
        records: parsedRecords,
        ...(deletedKeys.length === 0 ? {} : { deletedKeys }),
        ...(checkpointInput === undefined ? {} : { checkpoint: checkpointInput }),
      };
      const action = (await host.emit(batch)) ?? "continue";
      if (action === "yield" && checkpointInput === undefined) {
        throw new Error("The controller cannot request continuation without a checkpoint");
      }
      sequence += 1;
      records += parsedRecords.length;
      deleted += deletedKeys.length;
      if (checkpointInput !== undefined) latestCheckpoint = checkpointInput;
      if (action === "yield") {
        continuationRequested = true;
        lifecycle.abort(continuation);
        throw continuation;
      }
    });
    emitQueue = queued;
    void queued.catch(() => undefined);
    return queued;
  };

  const log = (
    level: LogEntry["level"],
    message: string,
    fields: JsonObject = {},
  ): Promise<void> => {
    if (!contextOpen) return rejectClosed();
    const queued = logQueue.then(() => host.log({ level, message, fields }));
    logQueue = queued;
    void queued.catch(() => undefined);
    return queued;
  };

  const fetch = (path: string, init?: SyncFetchInit): Promise<Response> => {
    if (!contextOpen) {
      return rejectClosed<Response>();
    }
    contextSignal.throwIfAborted();
    const operation = hostFetch(host, path, init, contextSignal, integration.connection.retry);
    void operation.catch(() => undefined);
    return operation;
  };

  const logger = {
    debug: (message: string, fields: JsonObject = {}) => log("debug", message, fields),
    info: (message: string, fields: JsonObject = {}) => log("info", message, fields),
    warn: (message: string, fields: JsonObject = {}) => log("warn", message, fields),
    error: (message: string, fields: JsonObject = {}) => log("error", message, fields),
  };

  const context = {
    config: {
      connection: connectionConfig,
      sync: syncConfig,
    },
    checkpoint: initialCheckpoint,
    signal: contextSignal,
    fetch,
    paginate: <const Records extends z.ZodType>(options: PaginateOptions<Records>) =>
      paginateRequests(fetch, integration.connection.pagination, options),
    emit,
    log: logger,
  };

  runSignal.throwIfAborted();
  let runError: unknown;
  let runFailedBeforeContinuation = false;
  try {
    await sync.run(context);
  } catch (error) {
    runError = error;
    runFailedBeforeContinuation = !continuationRequested;
  } finally {
    contextOpen = false;
    lifecycle.abort(new Error("Sync context is closed"));
  }

  const [emitResult, logResult] = await Promise.allSettled([emitQueue, logQueue]);
  if (!continuationRequested) runSignal.throwIfAborted();
  if (runFailedBeforeContinuation) throw runError;
  if (!continuationRequested && emitResult.status === "rejected") {
    throw emitResult.reason;
  }
  if (!continuationRequested && logResult.status === "rejected") throw logResult.reason;
  return {
    outcome: continuationRequested ? "continuation_required" : "completed",
    batches: sequence,
    records,
    deleted,
    ...(latestCheckpoint === undefined ? {} : { checkpoint: latestCheckpoint }),
  };
}

export async function verifyConnection(
  integration: IntegrationDefinition,
  input: VerifyConnectionInput,
  host: SyncHost,
): Promise<void> {
  validateIntegration(integration);
  const verify = integration.connection.verify;
  if (!verify) {
    throw new Error(
      `Integration ${JSON.stringify(integration.key)} does not define connection verification`,
    );
  }

  const config = await parse(
    integration.connection.inputs?.schema ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const runSignal = input.signal ?? new AbortController().signal;
  const lifecycle = new AbortController();
  const contextSignal = AbortSignal.any([runSignal, lifecycle.signal]);
  let contextOpen = true;
  let logQueue = Promise.resolve();

  const rejectClosed = <T>(): Promise<T> => {
    const rejected = Promise.reject<T>(new Error("Connection context is closed"));
    void rejected.catch(() => undefined);
    return rejected;
  };
  const fetch = (path: string, init?: SyncFetchInit): Promise<Response> => {
    if (!contextOpen) {
      return rejectClosed<Response>();
    }
    contextSignal.throwIfAborted();
    const operation = hostFetch(host, path, init, contextSignal, integration.connection.retry);
    void operation.catch(() => undefined);
    return operation;
  };
  const log = (
    level: LogEntry["level"],
    message: string,
    fields: JsonObject = {},
  ): Promise<void> => {
    if (!contextOpen) return rejectClosed();
    const queued = logQueue.then(() => host.log({ level, message, fields }));
    logQueue = queued;
    void queued.catch(() => undefined);
    return queued;
  };

  runSignal.throwIfAborted();
  let verifyError: unknown;
  let verifyFailed = false;
  try {
    await verify({
      config,
      signal: contextSignal,
      fetch,
      log: {
        debug: (message, fields = {}) => log("debug", message, fields),
        info: (message, fields = {}) => log("info", message, fields),
        warn: (message, fields = {}) => log("warn", message, fields),
        error: (message, fields = {}) => log("error", message, fields),
      },
    });
  } catch (error) {
    verifyError = error;
    verifyFailed = true;
  } finally {
    contextOpen = false;
    lifecycle.abort(new Error("Connection context is closed"));
  }

  const [logResult] = await Promise.allSettled([logQueue]);
  if (verifyFailed) {
    throw verifyError;
  }
  if (logResult?.status === "rejected") {
    throw logResult.reason;
  }
  runSignal.throwIfAborted();
}

export function validateIntegration(integration: IntegrationDefinition): void {
  validateKey(integration.key, "Integration");
  if (!integration.displayName.trim()) {
    throw new Error("Integration display name cannot be empty");
  }
  if (integration.description !== undefined && !integration.description.trim()) {
    throw new Error("Integration description cannot be empty");
  }
  if (
    integration.icon !== undefined &&
    integration.icon !== "icon.png" &&
    integration.icon !== "icon.webp"
  ) {
    throw new Error("Integration icon must be icon.png or icon.webp");
  }
  validateConfigurationInputs(integration.connection.inputs, "Connection");
  const auth = integration.connection.auth ?? authentication.none();
  if (
    auth.credentials.kind !== "credentials" ||
    Object.values(auth.credentials.shape).some((field) => field.kind !== "credential")
  ) {
    throw new Error("Authentication credentials must use credential.object()");
  }
  const origin = integration.connection.origin;
  if (typeof origin === "string") {
    providerOrigin(origin, auth.type !== "none");
  } else if ("values" in origin) {
    const inputField = integration.connection.inputs?.shape[origin.input];
    const selectValues =
      inputField?.manifest.type === "string" ? inputField.manifest.enum : undefined;
    const configuredValues = Object.keys(origin.values);
    if (
      !origin.input.trim() ||
      selectValues === undefined ||
      configuredValues.length === 0 ||
      configuredValues.length !== selectValues.length ||
      selectValues.some((value) => origin.values[value] === undefined)
    ) {
      throw new Error("Provider origins must map every value of a connection select input");
    }
    for (const value of Object.values(origin.values)) {
      providerOrigin(value, auth.type !== "none");
    }
  } else if ("input" in origin) {
    const field = integration.connection.inputs?.shape[origin.input];
    if (
      !origin.input.trim() ||
      field?.manifest.type !== "string" ||
      field.optional ||
      field.manifest.format !== "url"
    ) {
      throw new Error("Provider origin must reference a required URL connection input");
    }
  }

  const credentialKeys = new Set(Object.keys(auth.credentials.shape));
  const referencedCredentials = new Set(credentialReferences(auth));
  for (const field of referencedCredentials) {
    if (!credentialKeys.has(field)) {
      throw new Error(`Authentication references unknown credential ${JSON.stringify(field)}`);
    }
  }
  const unusedCredential = [...credentialKeys].find((field) => !referencedCredentials.has(field));
  if (unusedCredential !== undefined) {
    throw new Error(
      `Authentication declares unused credential ${JSON.stringify(unusedCredential)}`,
    );
  }
  const secretCredentials =
    auth.type === "bearer"
      ? ["token"]
      : auth.type === "basic"
        ? ["password"]
        : auth.type === "api_key"
          ? ["apiKey"]
          : auth.type === "oauth2_authorization_code" && auth.usesClientSecret
            ? ["clientSecret"]
            : [];
  for (const name of secretCredentials) {
    const field = auth.credentials.shape[name];
    if (field?.manifest.writeOnly !== true || field.manifest["x-beetl-widget"] !== "password") {
      throw new Error(`Authentication credential ${JSON.stringify(name)} must be secret`);
    }
  }
  if (
    auth.type === "custom" &&
    Object.keys(auth.headers).length === 0 &&
    Object.keys(auth.query).length === 0
  ) {
    throw new Error("Custom authentication must inject at least one header or query parameter");
  }
  if (auth.type === "token_exchange") {
    if (
      Object.keys(auth.headers).length === 0 &&
      !auth.basic &&
      Object.keys(auth.body?.fields ?? {}).length === 0
    ) {
      throw new Error(
        "Token exchange authentication must inject credentials into headers, a body, or basic authentication",
      );
    }
    if (
      !auth.tokenUrl.startsWith("/") ||
      auth.tokenUrl.startsWith("//") ||
      auth.tokenUrl.includes("\\") ||
      /[\x00-\x20\x7f#]/.test(auth.tokenUrl)
    ) {
      throw new Error("Token exchange URL must be a relative-origin path beginning with /");
    }
    if (
      [
        auth.tokenPath,
        auth.expiresAtPath,
        ...(auth.expiresInPath === undefined ? [] : [auth.expiresInPath]),
      ].some((path) => !path.trim() || path.split(".").some((segment) => !segment))
    ) {
      throw new Error("Token exchange response paths cannot be empty");
    }
    if (
      auth.expiresInSeconds !== undefined &&
      (!Number.isFinite(auth.expiresInSeconds) || auth.expiresInSeconds <= 0)
    ) {
      throw new Error("Token exchange lifetime must be positive seconds");
    }
    if (auth.expiresInPath !== undefined && auth.expiresInSeconds !== undefined) {
      throw new Error("Token exchange must select only one relative expiration source");
    }
    if (auth.body !== undefined && auth.body.encoding !== "json" && auth.body.encoding !== "form") {
      throw new Error("Token exchange body encoding must be json or form");
    }
    if (
      Object.keys(auth.body?.fields ?? {}).some(
        (name) => !name.trim() || Object.hasOwn(auth.body?.values ?? {}, name),
      )
    ) {
      throw new Error(
        "Token exchange body fields must be non-empty and cannot overlap literal values",
      );
    }
    new Headers().set(auth.tokenHeader ?? "authorization", `${auth.tokenPrefix ?? "Bearer "}token`);
    if (
      auth.basic !== undefined &&
      auth.credentials.shape[auth.basic.password]?.manifest.writeOnly !== true
    ) {
      throw new Error("Token exchange basic password must be secret");
    }
  }
  const headerNames =
    auth.type === "api_key" && auth.in === "header"
      ? [auth.name]
      : auth.type === "token_exchange"
        ? [...Object.keys(auth.headers), ...Object.keys(auth.requestHeaders ?? {})]
        : auth.type === "custom"
          ? Object.keys(auth.headers)
          : [];
  for (const name of headerNames) {
    try {
      new Headers().set(name, "value");
    } catch (error) {
      throw new Error(`Invalid authentication header name ${JSON.stringify(name)}`, {
        cause: error,
      });
    }
  }
  const queryNames =
    auth.type === "api_key" && auth.in === "query"
      ? [auth.name]
      : auth.type === "custom"
        ? Object.keys(auth.query)
        : [];
  if (queryNames.some((name) => !name.trim())) {
    throw new Error("Authentication query parameter names cannot be empty");
  }
  if (auth.type === "oauth2_authorization_code") {
    for (const value of [auth.issuer, auth.authorizationUrl, auth.tokenUrl]) {
      if (/[\x00-\x20\x7f#]/.test(value)) throw new Error("Invalid OAuth URL");
      if (
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.includes("\\") &&
        !value.includes("#")
      ) {
        if (typeof origin !== "string" && "oauthTokenField" in origin) {
          throw new Error("Relative OAuth URLs require an origin available before authorization");
        }
        continue;
      }
      const url = new URL(value);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("OAuth URLs must use HTTPS or loopback HTTP");
      }
      if (url.username || url.password) {
        throw new Error("OAuth URLs cannot contain credentials");
      }
    }
    if (auth.scopes.length === 0 || auth.scopes.some((scope) => !scope.trim())) {
      throw new Error("OAuth scopes must contain non-empty values");
    }
    if (
      Object.entries(auth.tokenFields).some(
        ([field, responseField]) => !field.trim() || !responseField.trim(),
      )
    ) {
      throw new Error("OAuth token field mappings cannot be empty");
    }
    if (
      typeof origin !== "string" &&
      "oauthTokenField" in origin &&
      auth.tokenFields[origin.oauthTokenField] === undefined
    ) {
      throw new Error("Provider origin references an unknown OAuth token field");
    }
  } else if (typeof origin !== "string" && "oauthTokenField" in origin) {
    throw new Error("Dynamic provider origins require OAuth authentication");
  }

  resolveRetry(integration.connection.retry);
  if (integration.connection.pagination) {
    validatePagination(integration.connection.pagination);
  }
  if (integration.syncs.length === 0) {
    throw new Error("Integration must define at least one sync");
  }

  const keys = new Set<string>();
  for (const sync of integration.syncs) {
    validateConfigurationInputs(sync.inputs, `Sync ${JSON.stringify(sync.key)}`);
    validateKey(sync.key, "Sync");
    if (keys.has(sync.key)) {
      throw new Error(`Duplicate sync key ${JSON.stringify(sync.key)}`);
    }
    keys.add(sync.key);
    if (!sync.displayName.trim()) {
      throw new Error("Sync display name cannot be empty");
    }
    if (
      sync.mode !== undefined &&
      sync.mode !== "append" &&
      sync.mode !== "replace" &&
      sync.mode !== "merge"
    ) {
      throw new Error(`Invalid sync mode ${JSON.stringify(sync.mode)}`);
    }
    const primaryKey = (sync as { readonly primaryKey?: readonly unknown[] }).primaryKey;
    if (sync.mode === "merge" && (!primaryKey || primaryKey.length === 0)) {
      throw new Error("Merge syncs require a primary key");
    }
    if (sync.mode !== "merge" && primaryKey !== undefined) {
      throw new Error("Only merge syncs can declare a primary key");
    }
    const primaryKeys = new Set<string>();
    for (const field of primaryKey ?? []) {
      if (typeof field !== "string" || !field.trim() || field.includes(".")) {
        throw new Error(`Invalid primary key field ${JSON.stringify(field)}`);
      }
      if (primaryKeys.has(field)) {
        throw new Error(`Duplicate primary key field ${JSON.stringify(field)}`);
      }
      primaryKeys.add(field);
    }
  }
  createIntegrationManifest(integration);
}

function validateConfigurationInputs(
  inputs: { readonly kind: string; readonly manifest: InputObjectSchema } | undefined,
  label: string,
): void {
  if (inputs === undefined) return;
  if (inputs.kind !== "configuration") {
    throw new Error(`${label} inputs must use input.object()`);
  }
  const fields: InputField[] = Object.values(inputs.manifest.properties);
  for (const field of fields) {
    if (
      ("writeOnly" in field && field.writeOnly) ||
      ("x-beetl-widget" in field && field["x-beetl-widget"] === "password")
    ) {
      throw new Error(`${label} inputs cannot contain credentials`);
    }
    if (field.type === "object") fields.push(...Object.values(field.properties));
    if (field.type === "array" && field.items !== undefined) fields.push(field.items);
  }
}

export function providerOrigin(value: string, authenticated = false): URL {
  const origin = new URL(value);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Provider origin must use HTTP or HTTPS");
  }
  if (origin.username || origin.password) {
    throw new Error("Provider origin cannot contain credentials");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Provider origin cannot contain a path, query, or fragment");
  }
  if (
    authenticated &&
    origin.protocol !== "https:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "[::1]" &&
    !/^127(?:\.\d{1,3}){3}$/.test(origin.hostname)
  ) {
    throw new Error("Authenticated provider origins must use HTTPS or loopback HTTP");
  }
  return origin;
}

function validateKey(key: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(key)) {
    throw new Error(
      `${label} key must start with a letter and contain only lowercase letters, numbers, and hyphens`,
    );
  }
}

async function hostFetch(
  host: SyncHost,
  path: string,
  init: SyncFetchInit = {},
  runSignal: AbortSignal,
  retry?: RetryDefinition,
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("ctx.fetch requires a relative-origin path beginning with /");
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
  const response = await host.request(
    {
      method: request.method,
      path,
      headers: [...request.headers.entries()],
      ...(body === undefined ? {} : { body }),
      ...(retry === undefined ? {} : { retry }),
    },
    signal,
  );
  signal.throwIfAborted();

  const responseBody = responseCanHaveBody(response.status)
    ? Uint8Array.from(response.body).buffer
    : null;
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers.map(([name, value]): [string, string] => [name, value]),
  });
}

async function* paginateRequests<Records extends z.ZodType>(
  fetch: (path: string, init?: SyncFetchInit) => Promise<Response>,
  defaults: PaginationDefinition | undefined,
  options: PaginateOptions<Records>,
): AsyncGenerator<PaginationPage<z.input<Records>>, void, void> {
  const pagination = resolvePagination(defaults, options.pagination);
  let pages = 0;
  const fetchPage = async (path: string) => {
    pages += 1;
    if (pages > MaxPaginationPages) {
      throw new Error(`Pagination exceeded ${MaxPaginationPages} pages`);
    }
    const response = await fetch(path, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) await options.onResponseError?.(response.clone());
    return response;
  };

  if (pagination.type === "next-url") {
    let path = withQuery(options.path, {});
    const seenPaths = new Set<string>();
    while (true) {
      if (seenPaths.has(path)) {
        throw new Error("Provider repeated a pagination next URL");
      }
      seenPaths.add(path);
      const response = await fetchPage(path);
      const { body, metadata } = await parsePageResponse(response);
      const records = await validatePageRecords(options.records, body, pagination.responsePath);
      const hasMore = parseHasMore(body, pagination.hasMorePath);
      const candidate = hasMore === false ? undefined : valueAtPath(body, pagination.nextUrlPath);
      if (
        candidate !== undefined &&
        candidate !== null &&
        (typeof candidate !== "string" || !candidate.trim())
      ) {
        throw new Error("Provider returned an invalid pagination next URL");
      }
      const nextPageParam =
        typeof candidate === "string" && candidate.trim() ? withQuery(candidate, {}) : undefined;
      if (hasMore === true && nextPageParam === undefined) {
        throw new Error("Provider returned has-more=true without a pagination next URL");
      }
      if (records.length === 0 && nextPageParam === undefined) return;
      yield {
        records,
        ...(nextPageParam === undefined ? {} : { nextPageParam }),
        response: metadata,
      };
      if (nextPageParam === undefined) return;
      path = nextPageParam;
    }
  }

  if (pagination.type === "cursor") {
    let cursor = pagination.initialCursor;
    const seenCursors = new Set(cursor === undefined ? [] : [String(cursor)]);
    while (true) {
      const response = await fetchPage(
        withQuery(options.path, {
          ...(cursor === undefined ? {} : { [pagination.cursorParameter]: String(cursor) }),
          ...(pagination.limit === undefined
            ? {}
            : { [pagination.limitParameter]: String(pagination.limit) }),
        }),
      );
      const { body, metadata } = await parsePageResponse(response);
      const records = await validatePageRecords(options.records, body, pagination.responsePath);
      const hasMore = parseHasMore(body, pagination.hasMorePath);
      const candidate = hasMore === false ? undefined : valueAtPath(body, pagination.cursorPath);
      let nextPageParam: string | number | undefined;
      if (candidate !== undefined && candidate !== null) {
        if (!(
          (typeof candidate === "number" && Number.isFinite(candidate)) ||
          (typeof candidate === "string" && candidate.trim())
        )) {
          throw new Error("Provider returned an invalid pagination cursor");
        }
        nextPageParam = candidate;
        const key = String(candidate);
        if (seenCursors.has(key)) {
          throw new Error("Provider repeated a pagination cursor");
        }
        seenCursors.add(key);
      }
      if (hasMore === true && nextPageParam === undefined) {
        throw new Error("Provider returned has-more=true without a pagination cursor");
      }
      if (records.length === 0 && nextPageParam === undefined) return;
      yield {
        records,
        ...(nextPageParam === undefined ? {} : { nextPageParam }),
        response: metadata,
      };
      if (nextPageParam === undefined) return;
      cursor = nextPageParam;
    }
  }

  let offset = pagination.initialOffset ?? 0;
  while (true) {
    const response = await fetchPage(
      withQuery(options.path, {
        [pagination.offsetParameter]: String(offset),
        ...(pagination.limit === undefined
          ? {}
          : { [pagination.limitParameter]: String(pagination.limit) }),
      }),
    );
    const { body, metadata } = await parsePageResponse(response);
    const records = await validatePageRecords(options.records, body, pagination.responsePath);
    const hasMore = parseHasMore(body, pagination.hasMorePath);
    if (records.length === 0 && hasMore !== true) {
      return;
    }
    if (records.length === 0 && pagination.increment !== "page") {
      throw new Error("Provider returned has-more=true without records to advance the offset");
    }

    const nextPageParam = pagination.increment === "page" ? offset + 1 : offset + records.length;
    const hasNext =
      hasMore ?? (pagination.limit === undefined || records.length >= pagination.limit);
    yield {
      records,
      ...(hasNext ? { nextPageParam } : {}),
      response: metadata,
    };
    if (!hasNext) {
      return;
    }
    offset = nextPageParam;
  }
}

function resolvePagination(
  defaults: PaginationDefinition | undefined,
  override: PaginationOverride | undefined,
): PaginationDefinition {
  if (!defaults && !override?.type) {
    throw new Error("ctx.paginate requires a pagination type or connection default");
  }
  const merged = {
    ...(defaults ?? {}),
    ...(override ?? {}),
  } as unknown as PaginationDefinition;
  validatePagination(merged);
  return merged;
}

async function parsePageResponse(
  response: Response,
): Promise<{ body: unknown; metadata: PaginationResponseMetadata }> {
  const text = await response.text();
  if (!response.ok) {
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      response.headers.get("x-correlation-id") ??
      response.headers.get("trace-id");
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 1_000);
    throw new Error(
      `Provider returned ${response.status} while paginating${requestId ? ` [${requestId}]` : ""}${detail ? ` (${detail})` : ""}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Provider returned invalid JSON while paginating", { cause: error });
  }
  return {
    body,
    metadata: {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    },
  };
}

async function validatePageRecords<Records extends z.ZodType>(
  schema: Records,
  body: unknown,
  responsePath: string | undefined,
): Promise<z.input<Records>[]> {
  const records = responsePath === undefined ? body : valueAtPath(body, responsePath);
  const result = await z.array(schema).safeParseAsync(records);
  if (!result.success) {
    throw new Error(`Invalid paginated records: ${z.prettifyError(result.error)}`);
  }
  return records as z.input<Records>[];
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseHasMore(body: unknown, path: string | undefined): boolean | undefined {
  if (path === undefined) return undefined;
  const value = valueAtPath(body, path);
  if (typeof value !== "boolean") {
    throw new Error("Provider returned an invalid has-more value");
  }
  return value;
}

function withQuery(path: string, values: Readonly<Record<string, string>>): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("ctx.paginate requires a relative-origin path beginning with /");
  }
  const url = new URL(path, "https://provider.invalid");
  for (const [name, value] of Object.entries(values)) {
    url.searchParams.set(name, value);
  }
  return `${url.pathname}${url.search}`;
}

function responseCanHaveBody(status: number): boolean {
  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function credentialReferences(auth: AuthDefinition): readonly string[] {
  if (auth.type === "none") return [];
  if (auth.type === "bearer") return ["token"];
  if (auth.type === "basic") return ["username", "password"];
  if (auth.type === "api_key") return ["apiKey"];
  if (auth.type === "oauth2_authorization_code") {
    return ["clientId", ...(auth.usesClientSecret ? ["clientSecret"] : [])];
  }
  if (auth.type === "token_exchange")
    return [
      ...Object.values(auth.headers),
      ...Object.values(auth.body?.fields ?? {}),
      ...Object.values(auth.requestHeaders ?? {}),
      ...(auth.basic === undefined ? [] : [auth.basic.username, auth.basic.password]),
    ];
  return [...Object.values(auth.headers), ...Object.values(auth.query)];
}

export type ResolvedRetry = Required<RetryPolicy>;

const DefaultRetry: ResolvedRetry = {
  maxAttempts: 3,
  statuses: [408, 429, 500, 502, 503, 504],
  methods: ["GET", "HEAD", "OPTIONS"],
  initialDelayMs: 500,
  maxDelayMs: 30_000,
};

export function resolveRetry(retry: RetryDefinition | undefined): ResolvedRetry {
  const resolved =
    retry === false ? { ...DefaultRetry, maxAttempts: 1 } : { ...DefaultRetry, ...retry };
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new Error("Retry maxAttempts must be a positive integer");
  }
  if (
    resolved.statuses.length === 0 ||
    resolved.statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
  ) {
    throw new Error("Retry statuses must contain valid HTTP status codes");
  }
  if (resolved.methods.length === 0 || resolved.methods.some((method) => !method.trim())) {
    throw new Error("Retry methods must contain non-empty HTTP methods");
  }
  if (!Number.isFinite(resolved.initialDelayMs) || resolved.initialDelayMs < 0) {
    throw new Error("Retry initialDelayMs must be a non-negative number");
  }
  if (!Number.isFinite(resolved.maxDelayMs) || resolved.maxDelayMs < 0) {
    throw new Error("Retry maxDelayMs must be a non-negative number");
  }
  if (resolved.initialDelayMs > resolved.maxDelayMs) {
    throw new Error("Retry initialDelayMs cannot exceed maxDelayMs");
  }
  return resolved;
}

function validatePagination(pagination: PaginationDefinition): void {
  let required: readonly string[];
  switch (pagination.type) {
    case "cursor":
      required = [pagination.cursorParameter, pagination.cursorPath, pagination.limitParameter];
      break;
    case "offset":
      required = [pagination.offsetParameter, pagination.limitParameter];
      break;
    case "next-url":
      required = [pagination.nextUrlPath];
      break;
    default:
      throw new Error("Invalid pagination type");
  }
  if (required.some((value) => !value?.trim())) {
    throw new Error(`Invalid ${pagination.type} pagination configuration`);
  }
  if (
    pagination.type !== "next-url" &&
    pagination.limitParameter ===
      (pagination.type === "cursor" ? pagination.cursorParameter : pagination.offsetParameter)
  ) {
    throw new Error("Pagination continuation and limit parameters must differ");
  }
  if (
    pagination.type !== "next-url" &&
    pagination.limit !== undefined &&
    (!Number.isInteger(pagination.limit) || pagination.limit < 1)
  ) {
    throw new Error("Pagination limit must be a positive integer");
  }
  if (pagination.responsePath !== undefined && !pagination.responsePath.trim()) {
    throw new Error("Pagination responsePath cannot be empty");
  }
  if (pagination.hasMorePath !== undefined && !pagination.hasMorePath.trim()) {
    throw new Error("Pagination hasMorePath cannot be empty");
  }
  if (
    pagination.type === "cursor" &&
    pagination.initialCursor !== undefined &&
    typeof pagination.initialCursor === "number" &&
    !Number.isFinite(pagination.initialCursor)
  ) {
    throw new Error("Pagination initialCursor must be finite");
  }
  if (
    pagination.type === "offset" &&
    pagination.initialOffset !== undefined &&
    (!Number.isInteger(pagination.initialOffset) || pagination.initialOffset < 0)
  ) {
    throw new Error("Pagination initialOffset must be a non-negative integer");
  }
  if (
    pagination.type === "offset" &&
    pagination.increment !== undefined &&
    pagination.increment !== "response-size" &&
    pagination.increment !== "page"
  ) {
    throw new Error("Invalid offset pagination increment");
  }
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

async function parseDeletedKeys(
  sync: SyncDefinition,
  value: readonly unknown[] | undefined,
): Promise<JsonObject[]> {
  if (value === undefined) return [];
  if (sync.mode !== "merge") {
    throw new Error("Only merge syncs can emit deleted keys");
  }

  const fields = sync.primaryKey!;
  const schema = z.strictObject(
    Object.fromEntries(fields.map((field) => [field, sync.records.shape[field]!])),
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

function validateMergeKeys(
  sync: SyncDefinition,
  records: readonly JsonObject[],
  deletedKeys: readonly JsonObject[],
): void {
  if (sync.mode !== "merge") return;
  const primaryKey = sync.primaryKey!;
  const identities = new Set<string>();
  for (const [index, record] of records.entries()) {
    const values = primaryKey.map((field) => record[field]);
    if (values.some((value) => !isJsonScalar(value))) {
      throw new Error(`Invalid record ${index}: merge primary keys must be scalar and non-null`);
    }
    const identity = JSON.stringify(values);
    if (identities.has(identity)) {
      throw new Error(`Duplicate merge key in record ${index}`);
    }
    identities.add(identity);
  }
  for (const [index, key] of deletedKeys.entries()) {
    const identity = JSON.stringify(primaryKey.map((field) => key[field]));
    if (identities.has(identity)) {
      throw new Error(`Duplicate or conflicting merge deletion key ${index}`);
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
    throw new Error(`Sync ${JSON.stringify(sync.key)} does not declare a checkpoint`);
  }
  const parsed = await parse(sync.checkpoint, value, "checkpoint");
  if (!isDeepStrictEqual(parsed, value)) {
    throw new Error("Checkpoint schemas must preserve the serialized JSON value");
  }
  return value;
}

function jsonSnapshot(value: unknown, errorMessage: string): JsonValue {
  if (isJsonValue(value)) {
    try {
      const snapshot: unknown = structuredClone(value);
      if (isJsonValue(snapshot)) return snapshot;
    } catch {}
  }
  throw new Error(errorMessage);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        return false;
      }
      return value.every((item) => isJsonValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}
