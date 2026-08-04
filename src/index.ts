import { type JSONType as JsonValue, z } from "zod";

export { z };
export type { JsonValue };

export type JsonObject = { [key: string]: JsonValue | undefined };

export type SyncFetchInit = Pick<
  RequestInit,
  "body" | "headers" | "method" | "signal"
>;

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly statuses?: readonly number[];
  readonly methods?: readonly string[];
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export type RetryDefinition = false | RetryPolicy;

export type BaseUrlDefinition =
  | string
  | { readonly credential: string };

export type AuthDefinition =
  | { type: "none" }
  | { type: "bearer"; credential: string }
  | {
    type: "basic";
    username: string;
    password: string;
  }
  | {
    type: "api_key";
    in: "header" | "query";
    name: string;
    credential: string;
  }
  | {
    type: "oauth2_authorization_code";
    authorizationUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    clientId: string;
    clientSecret?: string;
    accessToken: string;
    refreshToken?: string;
    tokenFields: Readonly<Record<string, string>>;
  }
  | {
    type: "custom";
    headers: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
  };

export const auth = {
  none(): AuthDefinition {
    return { type: "none" };
  },

  bearer(options: { credential?: string } = {}): AuthDefinition {
    return { type: "bearer", credential: options.credential ?? "token" };
  },

  basic(options: { username?: string; password?: string } = {}): AuthDefinition {
    return {
      type: "basic",
      username: options.username ?? "username",
      password: options.password ?? "password",
    };
  },

  apiKey(options: {
    in: "header" | "query";
    name: string;
    credential?: string;
  }): AuthDefinition {
    return {
      type: "api_key",
      in: options.in,
      name: options.name,
      credential: options.credential ?? "apiKey",
    };
  },

  oauth2AuthorizationCode(options: {
    authorizationUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenFields?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "oauth2_authorization_code",
      authorizationUrl: options.authorizationUrl,
      tokenUrl: options.tokenUrl,
      scopes: options.scopes,
      clientId: options.clientId ?? "clientId",
      ...(options.clientSecret === undefined
        ? {}
        : { clientSecret: options.clientSecret }),
      accessToken: options.accessToken ?? "accessToken",
      ...(options.refreshToken === undefined
        ? {}
        : { refreshToken: options.refreshToken }),
      tokenFields: options.tokenFields ?? {},
    };
  },

  custom(options: {
    headers?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "custom",
      headers: options.headers ?? {},
      query: options.query ?? {},
    };
  },
};

export interface CursorPagination {
  readonly type: "cursor";
  readonly cursorParameter: string;
  readonly cursorPath: string;
  readonly limitParameter: string;
  readonly limit?: number;
  readonly responsePath?: string;
  readonly initialCursor?: string | number;
}

export interface OffsetPagination {
  readonly type: "offset";
  readonly offsetParameter: string;
  readonly limitParameter: string;
  readonly limit?: number;
  readonly responsePath?: string;
  readonly initialOffset?: number;
  readonly increment?: "response-size" | "page";
}

export type PaginationDefinition = CursorPagination | OffsetPagination;

export type PaginationOverride =
  | ({ readonly type?: "cursor" } & Partial<Omit<CursorPagination, "type">>)
  | ({ readonly type?: "offset" } & Partial<Omit<OffsetPagination, "type">>);

type RecordSchema = z.ZodType;
type CheckpointSchema = z.ZodType;
type ConfigSchema = z.ZodType<JsonObject>;
type CredentialFieldSchema = z.ZodType<string | undefined>;
export type CredentialSchema = z.ZodObject<
  Record<string, CredentialFieldSchema>
>;

export interface PaginationPage<RecordValue> {
  readonly records: readonly RecordValue[];
  readonly nextPageParam?: string | number;
}

export interface PaginateOptions<Records extends RecordSchema> {
  readonly path: string;
  readonly records: Records;
  readonly pagination?: PaginationOverride;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export interface IntegrationLogger {
  debug(message: string, fields?: JsonObject): Promise<void>;
  info(message: string, fields?: JsonObject): Promise<void>;
  warn(message: string, fields?: JsonObject): Promise<void>;
  error(message: string, fields?: JsonObject): Promise<void>;
}

export interface ConnectionContext<ConnectionConfigValue extends JsonObject> {
  readonly config: ConnectionConfigValue;
  readonly signal: AbortSignal;
  fetch(path: string, init?: SyncFetchInit): Promise<Response>;
  readonly log: IntegrationLogger;
}

export interface SyncContext<
  RecordInput,
  CheckpointInput,
  CheckpointOutput,
  ConfigValue extends JsonObject,
  ConnectionConfigValue extends JsonObject = JsonObject,
> {
  readonly config: {
    readonly connection: ConnectionConfigValue;
    readonly sync: ConfigValue;
  };
  readonly checkpoint: CheckpointOutput | undefined;
  readonly signal: AbortSignal;
  fetch(path: string, init?: SyncFetchInit): Promise<Response>;
  paginate<const Records extends RecordSchema>(
    options: PaginateOptions<Records>,
  ): AsyncGenerator<PaginationPage<z.output<Records>>, void, void>;
  emit(value: {
    records: readonly RecordInput[];
    checkpoint?: CheckpointInput;
  }): Promise<void>;
  readonly log: IntegrationLogger;
}

type ConfigOutput<Config extends ConfigSchema | undefined> =
  Config extends ConfigSchema ? z.output<Config> : JsonObject;

export type SyncMode = "append" | "snapshot";

export interface SyncDefinition<
  Records extends RecordSchema = RecordSchema,
  Checkpoint extends CheckpointSchema | undefined = CheckpointSchema | undefined,
  Config extends ConfigSchema | undefined = ConfigSchema | undefined,
  ConnectionConfigValue extends JsonObject = JsonObject,
> {
  readonly key: string;
  readonly displayName: string;
  readonly mode?: SyncMode;
  readonly records: Records;
  readonly primaryKey?: readonly string[];
  readonly checkpoint?: Checkpoint;
  readonly config?: Config;
  run(
    context: SyncContext<
      z.input<Records>,
      Checkpoint extends CheckpointSchema ? z.input<Checkpoint> : never,
      Checkpoint extends CheckpointSchema ? z.output<Checkpoint> : never,
      ConfigOutput<Config>,
      ConnectionConfigValue
    >,
  ): Promise<void>;
}

export function defineSync<
  const Records extends RecordSchema,
  const Checkpoint extends CheckpointSchema | undefined = undefined,
  const Config extends ConfigSchema | undefined = undefined,
>(
  definition: SyncDefinition<Records, Checkpoint, Config>,
): SyncDefinition<Records, Checkpoint, Config> {
  return definition;
}

type ErasedSyncDefinition = SyncDefinition<
  RecordSchema,
  CheckpointSchema | undefined,
  ConfigSchema | undefined,
  JsonObject
>;

export interface ConnectionDefinition<
  Config extends ConfigSchema | undefined = ConfigSchema | undefined,
  Credentials extends CredentialSchema | undefined = CredentialSchema | undefined,
> {
  readonly baseUrl: BaseUrlDefinition;
  readonly auth?: AuthDefinition;
  readonly config?: Config;
  readonly integrationCredentials?: CredentialSchema;
  readonly credentials?: Credentials;
  readonly retry?: RetryDefinition;
  readonly pagination?: PaginationDefinition;
  verify?(context: ConnectionContext<ConfigOutput<Config>>): Promise<void>;
}

export interface IntegrationDefinition<
  ConnectionConfig extends ConfigSchema | undefined = ConfigSchema | undefined,
  Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
  Credentials extends CredentialSchema | undefined = CredentialSchema | undefined,
> {
  readonly key: string;
  readonly displayName: string;
  readonly connection: ConnectionDefinition<ConnectionConfig, Credentials>;
  readonly syncs: Syncs;
}

type BoundDefineSync<ConnectionConfigValue extends JsonObject> = <
  const Records extends RecordSchema,
  const Checkpoint extends CheckpointSchema | undefined = undefined,
  const Config extends ConfigSchema | undefined = undefined,
>(
  definition: SyncDefinition<
    Records,
    Checkpoint,
    Config,
    ConnectionConfigValue
  >,
) => SyncDefinition<Records, Checkpoint, Config, ConnectionConfigValue>;

type IntegrationFactoryDefinition<
  ConnectionConfig extends ConfigSchema | undefined,
  Syncs extends readonly ErasedSyncDefinition[],
  Credentials extends CredentialSchema | undefined,
> = Omit<IntegrationDefinition<ConnectionConfig, Syncs, Credentials>, "syncs"> & {
  readonly syncs: (
    defineSync: BoundDefineSync<ConfigOutput<ConnectionConfig>>,
  ) => Syncs;
};

export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined = undefined,
  const Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
  const Credentials extends CredentialSchema | undefined = undefined,
>(
  definition: IntegrationFactoryDefinition<ConnectionConfig, Syncs, Credentials>,
): IntegrationDefinition<ConnectionConfig, Syncs, Credentials>;
export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined = undefined,
  const Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
  const Credentials extends CredentialSchema | undefined = undefined,
>(
  definition: IntegrationDefinition<ConnectionConfig, Syncs, Credentials>,
): IntegrationDefinition<ConnectionConfig, Syncs, Credentials>;
export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined,
  const Syncs extends readonly ErasedSyncDefinition[],
  const Credentials extends CredentialSchema | undefined,
>(
  definition:
    | IntegrationFactoryDefinition<ConnectionConfig, Syncs, Credentials>
    | IntegrationDefinition<ConnectionConfig, Syncs, Credentials>,
): IntegrationDefinition<ConnectionConfig, Syncs, Credentials> {
  if (typeof definition.syncs !== "function") {
    return definition as IntegrationDefinition<ConnectionConfig, Syncs, Credentials>;
  }

  const boundDefineSync: BoundDefineSync<ConfigOutput<ConnectionConfig>> =
    (sync) => sync;
  return {
    ...definition,
    syncs: definition.syncs(boundDefineSync),
  };
}
