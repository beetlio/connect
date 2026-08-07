import { type JSONType as JsonValue, z } from "zod";

export { z };
export type { JsonValue };

export type JsonObject = { [key: string]: JsonValue | undefined };

interface InputOptions<Value> {
  readonly label?: string;
  readonly description?: string;
  readonly default?: Value;
}

interface StringInputOptions extends InputOptions<string> {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: "email" | "url" | "date" | "date-time";
  readonly placeholder?: string;
}

type SecretInputOptions = Omit<StringInputOptions, "default">;

interface NumberInputOptions extends InputOptions<number> {
  readonly min?: number;
  readonly max?: number;
}

interface ArrayInputOptions extends InputOptions<readonly JsonValue[]> {
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface SelectOption<Value extends string = string> {
  readonly value: Value;
  readonly label: string;
}

type ConfigurableInput<Schema extends z.ZodType = z.ZodType> = Schema & {
  readonly "~beetl-input": true;
};
type ConfigurableShape = Record<string, ConfigurableInput>;

function configurable<Schema extends z.ZodType>(
  schema: Schema,
  metadata: Readonly<Record<string, unknown>>,
): ConfigurableInput<Schema> {
  return schema.meta({ ...metadata, "x-beetl-input": true }) as ConfigurableInput<Schema>;
}

function inputMetadata(
  options: { readonly label?: string; readonly description?: string },
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...(options.label === undefined ? {} : { title: options.label }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...extra,
  };
}

function withDefault<Value>(schema: z.ZodType<Value>, value: Value | undefined): z.ZodType<Value> {
  if (value === undefined) return schema;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid input default: ${z.prettifyError(result.error)}`);
  }
  return schema.default(result.data as never) as unknown as z.ZodType<Value>;
}

function stringInput(
  options: StringInputOptions = {},
  widget?: "textarea" | "password",
): ConfigurableInput<z.ZodType<string>> {
  let schema = z.string();
  if (options.minLength !== undefined) schema = schema.min(options.minLength);
  if (options.maxLength !== undefined) schema = schema.max(options.maxLength);
  if (options.pattern !== undefined) schema = schema.regex(new RegExp(options.pattern));
  if (options.format === "email") schema = schema.check(z.email());
  if (options.format === "url") schema = schema.check(z.url());
  if (options.format === "date") schema = schema.check(z.iso.date());
  if (options.format === "date-time") schema = schema.check(z.iso.datetime());
  return configurable(
    withDefault(schema, options.default),
    inputMetadata(options, {
      ...(options.placeholder === undefined ? {} : { "x-beetl-placeholder": options.placeholder }),
      ...(widget === undefined ? {} : { "x-beetl-widget": widget }),
      ...(widget === "password" ? { writeOnly: true } : {}),
    }),
  );
}

/** Typed, serializable fields for connection and sync input forms. */
export const input = {
  string: (options: StringInputOptions = {}) => stringInput(options),
  text: (options: StringInputOptions = {}) => stringInput(options, "textarea"),
  secret(options: SecretInputOptions = {}): ConfigurableInput<z.ZodType<string>> {
    if ((options as StringInputOptions).default !== undefined) {
      throw new Error("Secret inputs cannot declare defaults");
    }
    return stringInput(options, "password");
  },

  integer(options: NumberInputOptions = {}): ConfigurableInput<z.ZodType<number>> {
    let schema = z.number().int();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return configurable(withDefault(schema, options.default), inputMetadata(options));
  },

  number(options: NumberInputOptions = {}): ConfigurableInput<z.ZodType<number>> {
    let schema = z.number();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return configurable(withDefault(schema, options.default), inputMetadata(options));
  },

  boolean(options: InputOptions<boolean> = {}): ConfigurableInput<z.ZodType<boolean>> {
    return configurable(withDefault(z.boolean(), options.default), inputMetadata(options));
  },

  select<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    metadata: InputOptions<Options[number]["value"]> = {},
  ): ConfigurableInput<z.ZodType<Options[number]["value"]>> {
    const values = options.map(({ value }) => value) as [string, ...string[]];
    return configurable(
      withDefault(z.enum(values), metadata.default),
      inputMetadata(metadata, {
        "x-beetl-options": options,
      }),
    );
  },

  multiselect<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    metadata: Omit<ArrayInputOptions, "default"> & {
      readonly default?: readonly Options[number]["value"][];
    } = {},
  ): ConfigurableInput<z.ZodType<Options[number]["value"][]>> {
    let schema = z.array(z.enum(options.map(({ value }) => value) as [string, ...string[]]));
    if (metadata.minItems !== undefined) schema = schema.min(metadata.minItems);
    if (metadata.maxItems !== undefined) schema = schema.max(metadata.maxItems);
    return configurable(
      withDefault(schema, metadata.default === undefined ? undefined : [...metadata.default]),
      inputMetadata(metadata, {
        "x-beetl-options": options,
      }),
    );
  },

  object<const Shape extends ConfigurableShape>(
    shape: Shape,
    options: Pick<InputOptions<never>, "label" | "description"> = {},
  ): ConfigurableInput<z.ZodObject<Shape>> {
    return configurable(z.object(shape), inputMetadata(options));
  },

  array<const Item extends ConfigurableInput>(
    item: Item,
    options: ArrayInputOptions = {},
  ): ConfigurableInput<z.ZodType<z.output<Item>[]>> {
    let schema = z.array(item);
    if (options.minItems !== undefined) schema = schema.min(options.minItems);
    if (options.maxItems !== undefined) schema = schema.max(options.maxItems);
    return configurable(
      withDefault(
        schema,
        options.default === undefined ? undefined : ([...options.default] as z.output<Item>[]),
      ),
      inputMetadata(options),
    );
  },

  json(options: InputOptions<JsonValue> = {}): ConfigurableInput<z.ZodType<JsonValue>> {
    return configurable(
      withDefault(z.json(), options.default),
      inputMetadata(options, {
        "x-beetl-widget": "json",
      }),
    );
  },

  optional<const Schema extends ConfigurableInput>(
    schema: Schema,
  ): ConfigurableInput<z.ZodOptional<Schema>> {
    return schema.optional() as ConfigurableInput<z.ZodOptional<Schema>>;
  },
};

export type SyncFetchInit = Pick<RequestInit, "body" | "headers" | "method" | "signal">;

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly statuses?: readonly number[];
  readonly methods?: readonly string[];
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export type RetryDefinition = false | RetryPolicy;

export type BaseUrlDefinition = string | { readonly oauthTokenField: string };

type AuthenticationFieldSchema = ConfigurableInput<z.ZodType<string>>;
export type AuthenticationInputSchema = ConfigurableInput<z.ZodType> & {
  readonly shape: z.ZodRawShape;
};

export type AuthManifest =
  | { type: "none" }
  | { type: "bearer" }
  | { type: "basic" }
  | {
      type: "api_key";
      in: "header" | "query";
      name: string;
    }
  | {
      type: "oauth2_authorization_code";
      issuer: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: readonly string[];
      usesClientSecret: boolean;
      tokenFields: Readonly<Record<string, string>>;
    }
  | {
      type: "custom";
      headers: Readonly<Record<string, string>>;
      query: Readonly<Record<string, string>>;
    };

export type AuthDefinition = AuthManifest & { inputs: AuthenticationInputSchema };

export const auth = {
  none(): AuthDefinition {
    return { type: "none", inputs: input.object({}) };
  },

  bearer(options: { token?: AuthenticationFieldSchema } = {}): AuthDefinition {
    return {
      type: "bearer",
      inputs: input.object({
        token: options.token ?? input.secret({ label: "Bearer token" }),
      }),
    };
  },

  basic(
    options: {
      username?: AuthenticationFieldSchema;
      password?: AuthenticationFieldSchema;
    } = {},
  ): AuthDefinition {
    return {
      type: "basic",
      inputs: input.object({
        username: options.username ?? input.string({ label: "Username" }),
        password: options.password ?? input.secret({ label: "Password" }),
      }),
    };
  },

  apiKey(options: {
    in: "header" | "query";
    name: string;
    apiKey?: AuthenticationFieldSchema;
  }): AuthDefinition {
    return {
      type: "api_key",
      inputs: input.object({
        apiKey: options.apiKey ?? input.secret({ label: "API key" }),
      }),
      in: options.in,
      name: options.name,
    };
  },

  oauth2AuthorizationCode(options: {
    clientId?: AuthenticationFieldSchema;
    clientSecret?: AuthenticationFieldSchema;
    issuer: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    tokenFields?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "oauth2_authorization_code",
      inputs: input.object({
        clientId: options.clientId ?? input.string({ label: "OAuth client ID" }),
        ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
      }),
      issuer: options.issuer,
      authorizationUrl: options.authorizationUrl,
      tokenUrl: options.tokenUrl,
      scopes: options.scopes,
      usesClientSecret: options.clientSecret !== undefined,
      tokenFields: options.tokenFields ?? {},
    };
  },

  custom<const Shape extends Record<string, AuthenticationFieldSchema>>(options: {
    inputs: ConfigurableInput<z.ZodObject<Shape>>;
    headers?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "custom",
      inputs: options.inputs,
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

export interface NextUrlPagination {
  readonly type: "next-url";
  readonly nextUrlPath: string;
  readonly responsePath?: string;
}

export type PaginationDefinition = CursorPagination | OffsetPagination | NextUrlPagination;

export type PaginationOverride =
  | ({ readonly type?: "cursor" } & Partial<Omit<CursorPagination, "type">>)
  | ({ readonly type?: "offset" } & Partial<Omit<OffsetPagination, "type">>)
  | ({ readonly type?: "next-url" } & Partial<Omit<NextUrlPagination, "type">>);

type RecordSchema = z.ZodType;
type CheckpointSchema = z.ZodType;
type ConfigSchema = ConfigurableInput<z.ZodType<JsonObject>>;

export interface PaginationResponseMetadata {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PaginationPage<RecordValue> {
  readonly records: readonly RecordValue[];
  readonly nextPageParam?: string | number;
  readonly response: PaginationResponseMetadata;
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
  emit(value: { records: readonly RecordInput[]; checkpoint?: CheckpointInput }): Promise<void>;
  readonly log: IntegrationLogger;
}

type ConfigOutput<Config extends ConfigSchema | undefined> = Config extends ConfigSchema
  ? z.output<Config>
  : JsonObject;

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
  readonly inputs?: Config;
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
> {
  readonly baseUrl: BaseUrlDefinition;
  readonly auth?: AuthDefinition;
  readonly inputs?: Config;
  readonly retry?: RetryDefinition;
  readonly pagination?: PaginationDefinition;
  verify?(context: ConnectionContext<ConfigOutput<Config>>): Promise<void>;
}

export {
  createIntegrationManifest,
  type InputField,
  type InputObjectSchema,
  type InputValueSchema,
  type IntegrationManifest,
  type JsonSchema,
} from "./manifest.ts";

export interface IntegrationDefinition<
  ConnectionConfig extends ConfigSchema | undefined = ConfigSchema | undefined,
  Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
> {
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly icon?: string;
  readonly connection: ConnectionDefinition<ConnectionConfig>;
  readonly syncs: Syncs;
}

type BoundDefineSync<ConnectionConfigValue extends JsonObject> = <
  const Records extends RecordSchema,
  const Checkpoint extends CheckpointSchema | undefined = undefined,
  const Config extends ConfigSchema | undefined = undefined,
>(
  definition: SyncDefinition<Records, Checkpoint, Config, ConnectionConfigValue>,
) => SyncDefinition<Records, Checkpoint, Config, ConnectionConfigValue>;

type IntegrationFactoryDefinition<
  ConnectionConfig extends ConfigSchema | undefined,
  Syncs extends readonly ErasedSyncDefinition[],
> = Omit<IntegrationDefinition<ConnectionConfig, Syncs>, "syncs"> & {
  readonly syncs: (defineSync: BoundDefineSync<ConfigOutput<ConnectionConfig>>) => Syncs;
};

export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined = undefined,
  const Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
>(
  definition: IntegrationFactoryDefinition<ConnectionConfig, Syncs>,
): IntegrationDefinition<ConnectionConfig, Syncs>;
export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined = undefined,
  const Syncs extends readonly ErasedSyncDefinition[] = readonly ErasedSyncDefinition[],
>(
  definition: IntegrationDefinition<ConnectionConfig, Syncs>,
): IntegrationDefinition<ConnectionConfig, Syncs>;
export function defineIntegration<
  const ConnectionConfig extends ConfigSchema | undefined,
  const Syncs extends readonly ErasedSyncDefinition[],
>(
  definition:
    | IntegrationFactoryDefinition<ConnectionConfig, Syncs>
    | IntegrationDefinition<ConnectionConfig, Syncs>,
): IntegrationDefinition<ConnectionConfig, Syncs> {
  if (typeof definition.syncs !== "function") {
    return definition as IntegrationDefinition<ConnectionConfig, Syncs>;
  }

  const boundDefineSync: BoundDefineSync<ConfigOutput<ConnectionConfig>> = (sync) => sync;
  return {
    ...definition,
    syncs: definition.syncs(boundDefineSync),
  };
}
