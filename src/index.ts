import { z, type JSONType } from "zod";

export { z };

export {
  createRecordBatcher,
  credential,
  input,
  type LegacyPaginateOptions,
  type LegacyPaginationPage,
} from "./legacy.ts";

export {
  auth,
  secret,
  type AuthDefinition,
  type AuthManifest,
  type TokenExchangeOptions,
} from "./auth.ts";

export { batchRecords, storageRecord } from "./records.ts";
export { createIntegrationManifest } from "./manifest.ts";

export {
  HttpError,
  type PaginateOptions,
  type PaginationPage,
  type PaginationRequest,
} from "./http.ts";

import type { AuthDefinition } from "./auth.ts";
import type { PaginateOptions, PaginationPage } from "./http.ts";
import { legacyPaginate, type LegacyPaginateOptions, type LegacyPaginationPage } from "./legacy.ts";

export type JsonValue = JSONType;

export type JsonObject = { readonly [key: string]: JsonValue | undefined };

export type SyncMode = "append" | "replace" | "merge";

export type SyncFetchInit = Pick<RequestInit, "body" | "headers" | "method" | "signal">;

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly statuses?: readonly number[];
  readonly methods?: readonly string[];
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export type RetryDefinition = false | RetryPolicy;

export type ProviderOriginDefinition =
  | string
  | { readonly type: "input"; readonly input: string }
  | {
      readonly type: "environment";
      readonly input: string;
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly type: "oauth"; readonly oauthTokenField: string };

export type ProviderOriginInputDefinition =
  | ProviderOriginDefinition
  | { readonly input: string }
  | { readonly input: string; readonly values: Readonly<Record<string, string>> }
  | { readonly oauthTokenField: string };

export interface IntegrationLogger {
  debug(message: string, fields?: JsonObject): Promise<void>;
  info(message: string, fields?: JsonObject): Promise<void>;
  warn(message: string, fields?: JsonObject): Promise<void>;
  error(message: string, fields?: JsonObject): Promise<void>;
}

export interface RequestContext {
  readonly signal: AbortSignal;
  readonly log: IntegrationLogger;
  fetch(path: string, init?: SyncFetchInit): Promise<Response>;
  json<S extends z.ZodType>(path: string, schema: S, init?: SyncFetchInit): Promise<z.output<S>>;
  paginate<S extends z.ZodType>(
    options: PaginateOptions<S>,
  ): AsyncGenerator<PaginationPage<z.output<S>>>;
}

export interface ConnectionContext<C extends object = JsonObject> extends RequestContext {
  readonly config: Readonly<C>;
}

export interface SyncContext<
  C extends object = JsonObject,
  K = JsonValue,
  Connection extends object = JsonObject,
> extends RequestContext {
  readonly config: { readonly connection: Readonly<Connection>; readonly sync: Readonly<C> };
  readonly checkpoint: K | undefined;
  /** Compatibility emission API for v0.3 async sync functions. */
  emit(value: {
    readonly records: readonly unknown[];
    readonly deletedKeys?: readonly JsonObject[];
    readonly checkpoint?: K;
  }): Promise<void>;
  paginate<S extends z.ZodType>(
    options: PaginateOptions<S>,
  ): AsyncGenerator<PaginationPage<z.output<S>>>;
  paginate<S extends z.ZodType>(
    options: LegacyPaginateOptions<S>,
  ): AsyncGenerator<LegacyPaginationPage<z.input<S>>, void, void>;
}

export interface DestinationContext<
  C extends object = JsonObject,
  Connection extends object = JsonObject,
> extends RequestContext {
  readonly config: {
    readonly connection: Readonly<Connection>;
    readonly destination: Readonly<C>;
  };
}

export type DestinationBatch<R = unknown, K = JsonObject> = {
  readonly batchId: string;
  readonly records: readonly Readonly<R>[];
  readonly deletedKeys?: readonly Readonly<K>[];
};

export type Batch<R = unknown, K = JsonValue, M extends SyncMode = SyncMode> = {
  readonly records: readonly R[];
  readonly checkpoint?: K;
} & (M extends "merge"
  ? { readonly deletedKeys?: readonly JsonObject[] }
  : { readonly deletedKeys?: never });

type Config<C> = C extends z.ZodType ? z.output<C> : Readonly<Record<string, never>>;

type Checkpoint<K> = K extends z.ZodType ? z.output<K> : never;

type Mode<M, R> = M extends "merge"
  ? { readonly primaryKey: readonly [keyof R & string, ...(keyof R & string)[]] }
  : { readonly primaryKey?: never };

/** Runtime definition. Author it through the scoped sync function for inference. */
export interface SyncDefinition {
  readonly displayName?: string;
  readonly records: z.ZodObject;
  readonly inputs?: z.ZodObject;
  readonly checkpoint?: z.ZodType;
  readonly mode?: SyncMode;
  readonly primaryKey?: readonly string[];
  run(context: SyncContext): AsyncGenerator<Batch, void, unknown>;
}

type DefineSync<Connection extends object> = <
  R extends z.ZodObject,
  C extends z.ZodObject | undefined = undefined,
  K extends z.ZodType | undefined = undefined,
  M extends SyncMode = "append",
>(
  definition: {
    readonly displayName?: string;
    readonly records: R;
    readonly inputs?: C;
    readonly checkpoint?: K;
    readonly mode?: M;
    run(
      context: SyncContext<Config<C>, Checkpoint<K>, Connection>,
    ): AsyncGenerator<Batch<z.input<R>, Checkpoint<K>, M>, void, unknown>;
  } & Mode<M, z.output<R>>,
) => SyncDefinition;

/** Runtime definition. Author it through the scoped destination function for inference. */
export interface DestinationDefinition {
  readonly displayName?: string;
  readonly records: z.ZodObject;
  readonly primaryKey: readonly string[];
  readonly inputs?: z.ZodObject;
  readonly supportsDelete?: boolean;
  run(context: DestinationContext, batch: DestinationBatch): Promise<void>;
}

type DefineDestination<Connection extends object> = <
  R extends z.ZodObject,
  const P extends readonly [keyof z.output<R> & string, ...(keyof z.output<R> & string)[]],
  C extends z.ZodObject | undefined = undefined,
  D extends boolean = false,
>(definition: {
  readonly displayName?: string;
  readonly records: R;
  readonly primaryKey: P;
  readonly inputs?: C;
  readonly supportsDelete?: D;
  run(
    context: DestinationContext<Config<C>, Connection>,
    batch: DestinationBatch<z.output<R>, D extends true ? Pick<z.output<R>, P[number]> : never>,
  ): Promise<void>;
}) => DestinationDefinition;

export interface ConnectionDefinition<C extends z.ZodObject | undefined = z.ZodObject | undefined> {
  readonly origin: ProviderOriginInputDefinition;
  readonly auth?: AuthDefinition;
  readonly inputs?: C;
  readonly retry?: RetryDefinition;
  verify?(context: ConnectionContext<Config<C>>): Promise<void>;
}

export type LegacySyncContext<
  R = unknown,
  K = JsonValue,
  C extends object = JsonObject,
  Connection extends object = JsonObject,
> = SyncContext<C, K, Connection> & {
  emit(value: {
    readonly records: readonly R[];
    readonly deletedKeys?: readonly JsonObject[];
    readonly checkpoint?: K;
  }): Promise<void>;
};

interface LegacySyncDefinition<
  R extends z.ZodObject = z.ZodObject,
  C extends z.ZodObject | undefined = z.ZodObject | undefined,
  K extends z.ZodType | undefined = z.ZodType | undefined,
  M extends SyncMode = SyncMode,
  Connection extends object = JsonObject,
> {
  readonly key: string;
  readonly displayName: string;
  readonly records: R;
  readonly inputs?: C;
  readonly checkpoint?: K;
  readonly mode?: M;
  readonly primaryKey?: readonly string[];
  run(context: LegacySyncContext<z.input<R>, Checkpoint<K>, Config<C>, Connection>): Promise<void>;
}

type LegacyDefineSync<Connection extends object> = {
  <
    R extends z.ZodObject,
    C extends z.ZodObject | undefined = undefined,
    M extends SyncMode = "append",
  >(
    definition: Omit<LegacySyncDefinition<R, C, undefined, M, Connection>, "checkpoint"> & {
      readonly checkpoint?: undefined;
    } & Mode<M, z.output<R>>,
  ): LegacySyncDefinition<R, C, undefined, M, Connection>;
  <
    R extends z.ZodObject,
    C extends z.ZodObject | undefined = undefined,
    K extends z.ZodType = z.ZodType,
    M extends SyncMode = "append",
  >(
    definition: LegacySyncDefinition<R, C, K, M, Connection> & { readonly checkpoint: K } & Mode<
        M,
        z.output<R>
      >,
  ): LegacySyncDefinition<R, C, K, M, Connection>;
};

type CompatibleDefineSync<Connection extends object> = DefineSync<Connection> &
  LegacyDefineSync<Connection>;

export type SyncCollection = Readonly<Record<string, SyncDefinition>> &
  readonly (SyncDefinition & { readonly key: string })[];

export interface IntegrationDefinition {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: "icon.png" | "icon.webp";
  readonly connection: ConnectionDefinition;
  readonly syncs: SyncCollection;
  readonly destinations?: Readonly<Record<string, DestinationDefinition>>;
}

type IntegrationBase<
  C extends z.ZodObject | undefined,
  A extends AuthDefinition | undefined = AuthDefinition | undefined,
> = {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: "icon.png" | "icon.webp";
  readonly connection: Omit<ConnectionDefinition<C>, "auth"> & { readonly auth?: A };
};

export function defineIntegration<
  C extends z.ZodObject | undefined = undefined,
  A extends AuthDefinition | undefined = AuthDefinition | undefined,
  S extends readonly (SyncDefinition | LegacySyncDefinition)[] = readonly (
    SyncDefinition | LegacySyncDefinition
  )[],
  D extends Readonly<Record<string, DestinationDefinition>> = Readonly<
    Record<string, DestinationDefinition>
  >,
>(
  definition: IntegrationBase<C, A> & {
    readonly syncs: (sync: CompatibleDefineSync<Config<C>>) => S;
    readonly destinations?: ((destination: DefineDestination<Config<C>>) => D) | D;
  },
): IntegrationDefinition & {
  readonly connection: IntegrationBase<C, A>["connection"];
  readonly syncs: SyncCollection & S;
  readonly destinations: D;
};
export function defineIntegration<
  C extends z.ZodObject | undefined = undefined,
  A extends AuthDefinition | undefined = AuthDefinition | undefined,
  S extends Readonly<Record<string, SyncDefinition>> = Readonly<Record<string, SyncDefinition>>,
  D extends Readonly<Record<string, DestinationDefinition>> = Readonly<
    Record<string, DestinationDefinition>
  >,
>(
  definition: IntegrationBase<C, A> & {
    readonly syncs?: (sync: CompatibleDefineSync<Config<C>>) => S;
    readonly destinations?: ((destination: DefineDestination<Config<C>>) => D) | D;
  },
): IntegrationDefinition & {
  readonly connection: IntegrationBase<C, A>["connection"];
  readonly syncs: SyncCollection & S;
  readonly destinations: D;
};
export function defineIntegration(
  definition: IntegrationBase<z.ZodObject | undefined, AuthDefinition | undefined> & {
    readonly syncs?: (sync: CompatibleDefineSync<JsonObject>) => unknown;
    readonly destinations?:
      | ((
          destination: DefineDestination<JsonObject>,
        ) => Readonly<Record<string, DestinationDefinition>>)
      | Readonly<Record<string, DestinationDefinition>>;
  },
): IntegrationDefinition {
  const sync = ((value: SyncDefinition | LegacySyncDefinition) =>
    value) as CompatibleDefineSync<JsonObject>;
  const produced = definition.syncs?.(sync) ?? {};
  const destination: DefineDestination<JsonObject> = (value) =>
    value as unknown as DestinationDefinition;

  return {
    ...definition,
    syncs: syncCollection(produced),
    destinations:
      typeof definition.destinations === "function"
        ? definition.destinations(destination)
        : (definition.destinations ?? {}),
  } as unknown as IntegrationDefinition;
}

function syncCollection(source: unknown): SyncCollection {
  const legacy = Array.isArray(source);
  const entries: readonly (readonly [string, SyncDefinition | LegacySyncDefinition])[] = legacy
    ? (source as readonly LegacySyncDefinition[]).map((value) => [value.key, value] as const)
    : Object.entries(source as Readonly<Record<string, SyncDefinition>>);
  const collection: Record<string, SyncDefinition> = {};
  const list: (SyncDefinition & { readonly key: string })[] = [];

  for (const [key, value] of entries) {
    const { key: ignored, ...definition } = value as LegacySyncDefinition & {
      readonly key?: string;
    };
    void ignored;
    const normalized = {
      ...definition,
      run: adaptRun(value.run as SyncDefinition["run"] | LegacySyncDefinition["run"]),
    } as unknown as SyncDefinition;
    Object.defineProperty(normalized, "key", { value: key });
    collection[key] = normalized;
    list.push(normalized as SyncDefinition & { readonly key: string });
  }

  Object.defineProperty(collection, "length", { value: list.length });
  list.forEach((value, index) => Object.defineProperty(collection, index, { value }));
  for (const method of [
    "at",
    "every",
    "filter",
    "find",
    "findIndex",
    "forEach",
    "map",
    "some",
  ] as const)
    Object.defineProperty(collection, method, { value: Array.prototype[method].bind(list) });
  Object.defineProperty(collection, Symbol.iterator, { value: list[Symbol.iterator].bind(list) });
  return collection as SyncCollection;
}

function adaptRun(run: SyncDefinition["run"] | LegacySyncDefinition["run"]): SyncDefinition["run"] {
  return async function* (context) {
    type Pending = {
      readonly value: Batch;
      readonly acknowledged: ReturnType<typeof Promise.withResolvers<void>>;
    };
    const queue: Pending[] = [];
    let changed = Promise.withResolvers<void>();
    let active: Pending | undefined;
    const notify = () => {
      changed.resolve();
      changed = Promise.withResolvers<void>();
    };
    const emit = (value: Batch) => {
      context.signal.throwIfAborted();
      const acknowledged = Promise.withResolvers<void>();
      queue.push({ value, acknowledged });
      notify();
      return acknowledged.promise;
    };
    const paginate = <S extends z.ZodType>(
      options: PaginateOptions<S> | LegacyPaginateOptions<S>,
    ) =>
      "request" in options ? context.paginate(options) : legacyPaginate(context.fetch, options);
    const output = run({ ...context, emit, paginate } as never) as
      | Promise<void>
      | AsyncGenerator<Batch<Record<string, unknown>, unknown, SyncMode>, void, unknown>;

    if (typeof Reflect.get(output, Symbol.asyncIterator) === "function") {
      for await (const batch of output as AsyncGenerator<
        Batch<Record<string, unknown>, unknown, SyncMode>,
        void,
        unknown
      >)
        yield batch as Batch;
      return;
    }

    let complete = false;
    let failure: unknown;
    const execution = Promise.resolve(output).then(
      () => {
        complete = true;
        notify();
      },
      (error: unknown) => {
        failure = error;
        complete = true;
        notify();
      },
    );

    try {
      while (!complete || queue.length) {
        if (!queue.length) {
          await changed.promise;
          continue;
        }
        active = queue.shift()!;
        yield active.value;
        active.acknowledged.resolve();
        active = undefined;
      }
      if (failure !== undefined) throw failure;
      await execution;
    } finally {
      const reason = context.signal.reason ?? new Error("Sync context is closed");
      active?.acknowledged.reject(reason);
      for (const pending of queue) pending.acknowledged.reject(reason);
      await execution.catch((error: unknown) => {
        if (!context.signal.aborted) throw error;
      });
    }
  };
}
