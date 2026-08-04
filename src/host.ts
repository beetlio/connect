import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AuthDefinition,
  IntegrationDefinition,
  JsonObject,
  JsonValue,
  PaginateOptions,
  PaginationDefinition,
  PaginationOverride,
  PaginationPage,
  RetryDefinition,
  SyncFetchInit,
  SyncDefinition,
} from "./index.ts";

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
  records: readonly JsonValue[];
  checkpoint?: JsonValue;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: JsonObject;
}

export interface SyncHost {
  request(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse>;
  emit(batch: EmittedBatch): Promise<void>;
  log(entry: LogEntry): Promise<void>;
  beginSnapshot?(): Promise<void>;
  commitSnapshot?(): Promise<void>;
  abortSnapshot?(): Promise<void>;
}

export interface RunSyncInput {
  connectionConfig?: unknown;
  syncConfig?: unknown;
  checkpoint?: unknown;
  signal?: AbortSignal;
}

export interface RunSyncResult {
  batches: number;
  records: number;
  checkpoint?: JsonValue;
}

export interface VerifyConnectionInput {
  connectionConfig?: unknown;
  signal?: AbortSignal;
}

const EmptyConfig = z.object({});

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
  const snapshot = sync.mode === "snapshot";
  if (
    snapshot &&
    (!host.beginSnapshot || !host.commitSnapshot || !host.abortSnapshot)
  ) {
    throw new Error("Snapshot syncs require host snapshot support");
  }

  const connectionConfig = parse(
    integration.connection.config ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const syncConfig = parse(
    sync.config ?? EmptyConfig,
    input.syncConfig ?? {},
    "sync config",
  );
  const initialCheckpoint = snapshot || input.checkpoint === undefined
    ? undefined
    : parseCheckpoint(sync, input.checkpoint);
  const signal = input.signal ?? new AbortController().signal;

  let sequence = 0;
  let records = 0;
  let latestCheckpoint = initialCheckpoint;
  let emitQueue = Promise.resolve();
  let contextOpen = true;
  const operations = createOperationTracker();

  const rejectClosed = <T>(): Promise<T> => {
    const rejected = Promise.reject<T>(new Error("Sync context is closed"));
    void rejected.catch(() => undefined);
    return rejected;
  };

  const emit = (value: {
    records: readonly unknown[];
    checkpoint?: unknown;
  }): Promise<void> => {
    if (!contextOpen) {
      return rejectClosed();
    }

    let parsedRecords: JsonValue[];
    let checkpoint: JsonValue | undefined;
    try {
      parsedRecords = value.records.map((record, index) =>
        parse(sync.records, record, `record ${index}`)
      );
      checkpoint = value.checkpoint === undefined
        ? undefined
        : parseCheckpoint(sync, value.checkpoint);
    } catch (error) {
      const failed = emitQueue.then(() => {
        throw error;
      });
      emitQueue = failed;
      void failed.catch(() => undefined);
      return failed;
    }

    const queued = emitQueue.then(async () => {
      signal.throwIfAborted();
      const batch: EmittedBatch = {
        batchId: randomUUID(),
        sequence,
        records: parsedRecords,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      };

      await host.emit(batch);
      sequence += 1;
      records += parsedRecords.length;
      if (checkpoint !== undefined) {
        latestCheckpoint = checkpoint;
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
  ): Promise<void> => contextOpen
    ? operations.track(host.log({ level, message, fields }))
    : rejectClosed();

  const fetch = (path: string, init?: SyncFetchInit): Promise<Response> => {
    if (!contextOpen) {
      return rejectClosed<Response>();
    }
    signal.throwIfAborted();
    return operations.track(hostFetch(
      host,
      path,
      init,
      signal,
      integration.connection.retry,
    ));
  };

  const logger = {
    debug: (message: string, fields: JsonObject = {}) =>
      log("debug", message, fields),
    info: (message: string, fields: JsonObject = {}) =>
      log("info", message, fields),
    warn: (message: string, fields: JsonObject = {}) =>
      log("warn", message, fields),
    error: (message: string, fields: JsonObject = {}) =>
      log("error", message, fields),
  };

  const context = {
    config: {
      connection: connectionConfig,
      sync: syncConfig,
    },
    checkpoint: initialCheckpoint,
    signal,
    fetch,
    paginate: <const Records extends z.ZodType>(
      options: PaginateOptions<Records>,
    ) => paginateRequests(
      fetch,
      integration.connection.pagination,
      options,
    ),
    emit,
    log: logger,
  };

  // The public type carries stronger per-integration inference than this runtime seam.
  signal.throwIfAborted();
  if (snapshot) {
    await host.beginSnapshot!();
  }
  try {
    let runError: unknown;
    let runFailed = false;
    try {
      await sync.run(context);
    } catch (error) {
      runError = error;
      runFailed = true;
    } finally {
      contextOpen = false;
    }

    const [[emitResult], operationResult] = await Promise.all([
      Promise.allSettled([emitQueue]),
      operations.settle(),
    ]);
    if (runFailed) {
      throw runError;
    }
    if (emitResult?.status === "rejected") {
      throw emitResult.reason;
    }
    if (!operationResult.ok) {
      throw operationResult.reason;
    }
    signal.throwIfAborted();
    if (snapshot) {
      await host.commitSnapshot!();
    }

    return {
      batches: sequence,
      records,
      ...(latestCheckpoint === undefined
        ? {}
        : { checkpoint: latestCheckpoint }),
    };
  } catch (error) {
    if (snapshot) {
      try {
        await host.abortSnapshot!();
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          "Snapshot run failed and cleanup also failed",
        );
      }
    }
    throw error;
  }
}

export async function verifyConnection(
  integration: IntegrationDefinition,
  input: VerifyConnectionInput,
  host: SyncHost,
): Promise<void> {
  validateIntegration(integration);
  const verify = integration.connection.verify;
  if (!verify) {
    throw new Error(`Integration ${JSON.stringify(integration.key)} does not define connection verification`);
  }

  const config = parse(
    integration.connection.config ?? EmptyConfig,
    input.connectionConfig ?? {},
    "connection config",
  );
  const signal = input.signal ?? new AbortController().signal;
  const operations = createOperationTracker();
  let contextOpen = true;

  const rejectClosed = <T>(): Promise<T> => {
    const rejected = Promise.reject<T>(new Error("Connection context is closed"));
    void rejected.catch(() => undefined);
    return rejected;
  };
  const fetch = (path: string, init?: SyncFetchInit): Promise<Response> => {
    if (!contextOpen) {
      return rejectClosed<Response>();
    }
    signal.throwIfAborted();
    return operations.track(hostFetch(
      host,
      path,
      init,
      signal,
      integration.connection.retry,
    ));
  };
  const log = (
    level: LogEntry["level"],
    message: string,
    fields: JsonObject = {},
  ): Promise<void> => contextOpen
    ? operations.track(host.log({ level, message, fields }))
    : rejectClosed();

  signal.throwIfAborted();
  let verifyError: unknown;
  let verifyFailed = false;
  try {
    await verify({
      config,
      signal,
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
  }

  const operationResult = await operations.settle();
  if (verifyFailed) {
    throw verifyError;
  }
  if (!operationResult.ok) {
    throw operationResult.reason;
  }
  signal.throwIfAborted();
}

function createOperationTracker() {
  const pending = new Set<Promise<unknown>>();
  let failure: { readonly reason: unknown } | undefined;

  return {
    track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        (reason: unknown) => {
          pending.delete(operation);
          failure ??= { reason };
        },
      );
      return operation;
    },

    async settle(): Promise<
      { readonly ok: true } | { readonly ok: false; readonly reason: unknown }
    > {
      await Promise.allSettled([...pending]);
      return failure === undefined
        ? { ok: true }
        : { ok: false, reason: failure.reason };
    },
  };
}

export function validateIntegration(integration: IntegrationDefinition): void {
  if (!integration.key.trim()) {
    throw new Error("Integration key cannot be empty");
  }
  if (!integration.displayName.trim()) {
    throw new Error("Integration display name cannot be empty");
  }

  if (typeof integration.connection.baseUrl === "string") {
    const baseUrl = new URL(integration.connection.baseUrl);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("Connection base URL must use HTTP or HTTPS");
    }
  }

  const auth = integration.connection.auth ?? { type: "none" as const };
  if (
    auth.type !== "none" ||
    typeof integration.connection.baseUrl !== "string"
  ) {
    const credentials = integration.connection.credentials;
    if (!credentials) {
      throw new Error("This connection must declare a credential schema");
    }
    const credentialKeys = new Set(Object.keys(credentials.shape));
    for (const field of connectionCredentialReferences(
      auth,
      integration.connection.baseUrl,
    )) {
      if (!credentialKeys.has(field)) {
        throw new Error(`Connection references unknown credential ${JSON.stringify(field)}`);
      }
    }
  }
  if (
    auth.type === "custom" &&
    Object.keys(auth.headers).length === 0 &&
    Object.keys(auth.query).length === 0
  ) {
    throw new Error("Custom authentication must inject at least one header or query parameter");
  }
  if (auth.type === "oauth2_authorization_code") {
    for (const value of [auth.authorizationUrl, auth.tokenUrl]) {
      const url = new URL(value);
      if (url.protocol !== "https:") {
        throw new Error("OAuth URLs must use HTTPS");
      }
    }
    const integrationCredentials = integration.connection.integrationCredentials;
    if (!integrationCredentials) {
      throw new Error("OAuth connections must declare integration credentials");
    }
    const credentialKeys = new Set(Object.keys(integrationCredentials.shape));
    for (const field of [auth.clientId, auth.clientSecret]) {
      if (field !== undefined && !credentialKeys.has(field)) {
        throw new Error(
          `OAuth references unknown integration credential ${JSON.stringify(field)}`,
        );
      }
    }
    if (auth.scopes.length === 0 || auth.scopes.some((scope) => !scope.trim())) {
      throw new Error("OAuth scopes must contain non-empty values");
    }
    if (
      Object.entries(auth.tokenFields).some(([field, responseField]) =>
        !field.trim() || !responseField.trim()
      )
    ) {
      throw new Error("OAuth token field mappings cannot be empty");
    }
  }

  validateRetry(integration.connection.retry);
  if (integration.connection.pagination) {
    validatePagination(integration.connection.pagination);
  }

  const keys = new Set<string>();
  for (const sync of integration.syncs) {
    if (!sync.key.trim()) {
      throw new Error("Sync key cannot be empty");
    }
    if (keys.has(sync.key)) {
      throw new Error(`Duplicate sync key ${JSON.stringify(sync.key)}`);
    }
    keys.add(sync.key);
    if (sync.mode !== undefined && sync.mode !== "append" && sync.mode !== "snapshot") {
      throw new Error(`Invalid sync mode ${JSON.stringify(sync.mode)}`);
    }
    if (sync.mode === "snapshot" && sync.checkpoint !== undefined) {
      throw new Error("Snapshot syncs cannot declare checkpoints");
    }
  }
}

async function hostFetch(
  host: SyncHost,
  path: string,
  init: SyncFetchInit = {},
  runSignal: AbortSignal,
  retry?: RetryDefinition,
): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("ctx.fetch requires a relative-origin path beginning with /");
  }

  const signal = init.signal
    ? AbortSignal.any([runSignal, init.signal])
    : runSignal;
  signal.throwIfAborted();
  if (init.body instanceof ReadableStream) {
    throw new Error("Streaming request bodies are not supported");
  }
  const request = new Request("https://provider.invalid", {
    method: init.method ?? "GET",
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
  });
  const body = request.body === null
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  signal.throwIfAborted();
  const response = await host.request({
    method: request.method,
    path,
    headers: [...request.headers.entries()],
    ...(body === undefined ? {} : { body }),
    ...(retry === undefined ? {} : { retry }),
  }, signal);
  signal.throwIfAborted();

  const responseBody = responseCanHaveBody(response.status)
    ? Uint8Array.from(response.body).buffer
    : null;
  return new Response(responseBody, {
    status: response.status,
    headers: response.headers.map(
      ([name, value]): [string, string] => [name, value],
    ),
  });
}

async function* paginateRequests<Records extends z.ZodType>(
  fetch: (path: string, init?: SyncFetchInit) => Promise<Response>,
  defaults: PaginationDefinition | undefined,
  options: PaginateOptions<Records>,
): AsyncGenerator<PaginationPage<z.output<Records>>, void, void> {
  const pagination = resolvePagination(defaults, options.pagination);

  if (pagination.type === "cursor") {
    let cursor = pagination.initialCursor;
    while (true) {
      const response = await fetch(withQuery(options.path, {
        ...(cursor === undefined
          ? {}
          : { [pagination.cursorParameter]: String(cursor) }),
        ...(pagination.limit === undefined
          ? {}
          : { [pagination.limitParameter]: String(pagination.limit) }),
      }), {
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const body = await parsePageResponse(response);
      const records = parsePageRecords(options.records, body, pagination.responsePath);
      if (records.length === 0) {
        return;
      }

      const candidate = valueAtPath(body, pagination.cursorPath);
      const nextPageParam = typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : typeof candidate === "string" && candidate.trim()
        ? candidate
        : undefined;
      const hasNext = nextPageParam !== undefined &&
        String(nextPageParam) !== String(cursor);
      yield {
        records,
        ...(hasNext ? { nextPageParam } : {}),
      };
      if (!hasNext) {
        return;
      }
      cursor = nextPageParam;
    }
  }

  let offset = pagination.initialOffset ?? 0;
  while (true) {
    const response = await fetch(withQuery(options.path, {
      [pagination.offsetParameter]: String(offset),
      ...(pagination.limit === undefined
        ? {}
        : { [pagination.limitParameter]: String(pagination.limit) }),
    }), {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await parsePageResponse(response);
    const records = parsePageRecords(options.records, body, pagination.responsePath);
    if (records.length === 0) {
      return;
    }

    const nextPageParam = pagination.increment === "page"
      ? offset + 1
      : offset + records.length;
    const hasNext = pagination.limit === undefined || records.length >= pagination.limit;
    yield {
      records,
      ...(hasNext ? { nextPageParam } : {}),
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

async function parsePageResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Provider returned ${response.status} while paginating`);
  }
  return await response.json() as unknown;
}

function parsePageRecords<Records extends z.ZodType>(
  schema: Records,
  body: unknown,
  responsePath: string | undefined,
): z.output<Records>[] {
  const result = z.array(schema).safeParse(
    responsePath === undefined ? body : valueAtPath(body, responsePath),
  );
  if (!result.success) {
    throw new Error(`Invalid paginated records: ${z.prettifyError(result.error)}`);
  }
  return result.data;
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

function withQuery(path: string, values: Readonly<Record<string, string>>): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
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

function connectionCredentialReferences(
  auth: AuthDefinition,
  baseUrl: IntegrationDefinition["connection"]["baseUrl"],
): readonly string[] {
  const baseUrlCredentials = typeof baseUrl === "string"
    ? []
    : [baseUrl.credential];
  if (auth.type === "none") {
    return baseUrlCredentials;
  }
  if (auth.type === "bearer" || auth.type === "api_key") {
    return [auth.credential, ...baseUrlCredentials];
  }
  if (auth.type === "basic") {
    return [auth.username, auth.password, ...baseUrlCredentials];
  }
  if (auth.type === "oauth2_authorization_code") {
    return [
      auth.accessToken,
      ...(auth.refreshToken === undefined ? [] : [auth.refreshToken]),
      ...Object.keys(auth.tokenFields),
      ...baseUrlCredentials,
    ];
  }
  return [
    ...Object.values(auth.headers),
    ...Object.values(auth.query),
    ...baseUrlCredentials,
  ];
}

function validateRetry(retry: RetryDefinition | undefined): void {
  if (retry === undefined || retry === false) {
    return;
  }
  if (
    retry.maxAttempts !== undefined &&
    (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)
  ) {
    throw new Error("Retry maxAttempts must be a positive integer");
  }
  if (
    retry.statuses !== undefined &&
    (retry.statuses.length === 0 || retry.statuses.some((status) =>
      !Number.isInteger(status) || status < 100 || status > 599
    ))
  ) {
    throw new Error("Retry statuses must contain valid HTTP status codes");
  }
  if (
    retry.methods !== undefined &&
    (retry.methods.length === 0 || retry.methods.some((method) => !method.trim()))
  ) {
    throw new Error("Retry methods must contain non-empty HTTP methods");
  }
  for (const [name, value] of [
    ["initialDelayMs", retry.initialDelayMs],
    ["maxDelayMs", retry.maxDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Retry ${name} must be a non-negative number`);
    }
  }
  if (
    retry.initialDelayMs !== undefined &&
    retry.maxDelayMs !== undefined &&
    retry.initialDelayMs > retry.maxDelayMs
  ) {
    throw new Error("Retry initialDelayMs cannot exceed maxDelayMs");
  }
}

function validatePagination(pagination: PaginationDefinition): void {
  const required = pagination.type === "cursor"
    ? [
      pagination.cursorParameter,
      pagination.cursorPath,
      pagination.limitParameter,
    ]
    : [pagination.offsetParameter, pagination.limitParameter];
  if (required.some((value) => !value?.trim())) {
    throw new Error(`Invalid ${pagination.type} pagination configuration`);
  }
  if (
    pagination.limit !== undefined &&
    (!Number.isInteger(pagination.limit) || pagination.limit < 1)
  ) {
    throw new Error("Pagination limit must be a positive integer");
  }
  if (pagination.responsePath !== undefined && !pagination.responsePath.trim()) {
    throw new Error("Pagination responsePath cannot be empty");
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

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T & JsonValue {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${label}: ${z.prettifyError(result.error)}`);
  }
  if (!isJsonValue(result.data)) {
    throw new Error(`Invalid ${label}: schema output must be JSON-compatible`);
  }
  let snapshot: unknown;
  try {
    snapshot = structuredClone(result.data);
  } catch {
    throw new Error(`Invalid ${label}: schema output must be JSON-compatible`);
  }
  if (!isJsonValue(snapshot)) {
    throw new Error(`Invalid ${label}: schema output must be JSON-compatible`);
  }
  return snapshot as T & JsonValue;
}

function parseCheckpoint(sync: SyncDefinition, value: unknown): JsonValue {
  if (!sync.checkpoint) {
    throw new Error(`Sync ${JSON.stringify(sync.key)} does not declare a checkpoint`);
  }
  return parse(sync.checkpoint, value, "checkpoint");
}

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
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
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
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
