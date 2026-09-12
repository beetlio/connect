import { z, type JSONType } from "zod";

export { z };

export {
  auth,
  secret,
  type AuthDefinition,
  type AuthManifest,
  type TokenExchangeOptions,
} from "./auth.ts";

export { batchRecords, storageRecord } from "./records.ts";

export {
  HttpError,
  type PaginateOptions,
  type PaginationPage,
  type PaginationRequest,
} from "./http.ts";

import type { AuthDefinition } from "./auth.ts";
import type { PaginateOptions, PaginationPage } from "./http.ts";

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
  readonly origin: ProviderOriginDefinition;
  readonly auth?: AuthDefinition;
  readonly inputs?: C;
  readonly retry?: RetryDefinition;
  verify?(context: ConnectionContext<Config<C>>): Promise<void>;
}

export interface IntegrationDefinition {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: "icon.png" | "icon.webp";
  readonly connection: ConnectionDefinition;
  readonly syncs: Readonly<Record<string, SyncDefinition>>;
  readonly destinations?: Readonly<Record<string, DestinationDefinition>>;
}

export function defineIntegration<
  C extends z.ZodObject | undefined = undefined,
  S extends Readonly<Record<string, SyncDefinition>> = Readonly<Record<string, SyncDefinition>>,
  D extends Readonly<Record<string, DestinationDefinition>> = Readonly<
    Record<string, DestinationDefinition>
  >,
>(definition: {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: "icon.png" | "icon.webp";
  readonly connection: ConnectionDefinition<C>;
  readonly syncs?: (sync: DefineSync<Config<C>>) => S;
  readonly destinations?: ((destination: DefineDestination<Config<C>>) => D) | D;
}): IntegrationDefinition & { readonly syncs: S; readonly destinations: D } {
  // Generic callback types are erased only at the authoring boundary. The builder
  // validates the complete definition before it becomes an executable artifact.
  const sync: DefineSync<Config<C>> = (value) => value as unknown as SyncDefinition;
  const destination: DefineDestination<Config<C>> = (value) =>
    value as unknown as DestinationDefinition;

  return {
    ...definition,
    syncs: definition.syncs?.(sync) ?? ({} as S),
    destinations:
      typeof definition.destinations === "function"
        ? definition.destinations(destination)
        : (definition.destinations ?? ({} as D)),
  };
}
