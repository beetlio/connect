import { type JSONType as JsonValue, z } from "zod";

import type {
  InputField as InputManifestField,
  InputObjectSchema,
  InputValueSchema,
} from "./manifest.ts";

export { z };
export { storageRecord } from "./storage.ts";
export { createRecordBatcher } from "./batching.ts";
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

export interface ConfigurationField<Schema extends z.ZodType = z.ZodType> {
  readonly kind: "configuration";
  readonly schema: Schema;
  readonly manifest: InputManifestField;
  readonly optional: boolean;
}

type ConfigurationShape = Record<string, ConfigurationField>;
type SchemaShape<Shape extends ConfigurationShape> = {
  readonly [Key in keyof Shape]: Shape[Key]["schema"];
};

export interface ConfigurationObject<
  Shape extends ConfigurationShape = ConfigurationShape,
> extends ConfigurationField<z.ZodObject<SchemaShape<Shape>>> {
  readonly shape: Shape;
  readonly manifest: InputObjectSchema;
}

export interface CredentialField<Schema extends z.ZodType<string> = z.ZodType<string>> {
  readonly kind: "credential";
  readonly schema: Schema;
  readonly manifest: InputValueSchema;
}

type CredentialShape = Record<string, CredentialField>;
type CredentialSchemaShape<Shape extends CredentialShape> = {
  readonly [Key in keyof Shape]: Shape[Key]["schema"];
};

export interface CredentialObject<Shape extends CredentialShape = CredentialShape> {
  readonly kind: "credentials";
  readonly shape: Shape;
  readonly schema: z.ZodObject<CredentialSchemaShape<Shape>>;
  readonly manifest: InputObjectSchema;
}

function metadata(options: {
  readonly label?: string;
  readonly description?: string;
}): Pick<InputValueSchema, "title" | "description"> {
  return {
    ...(options.label === undefined ? {} : { title: options.label }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

function assertBounds(
  kind: "number" | "integer" | "length",
  minimum: number | undefined,
  maximum: number | undefined,
): void {
  const label = kind === "number" ? "Number" : kind === "integer" ? "Integer" : "Length";
  const valid = (value: number) =>
    Number.isFinite(value) &&
    (kind === "number" || (Number.isInteger(value) && (kind === "integer" || value >= 0)));
  if ([minimum, maximum].some((value) => value !== undefined && !valid(value))) {
    throw new Error(
      `${label} bounds must be ${kind === "length" ? "non-negative integers" : `finite ${kind}s`}`,
    );
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error(`${label} minimum cannot exceed maximum`);
  }
}

function stringSchema(options: Omit<StringInputOptions, "default">): z.ZodType<string> {
  assertBounds("length", options.minLength, options.maxLength);
  let schema = z.string();
  if (options.minLength !== undefined) schema = schema.min(options.minLength);
  if (options.maxLength !== undefined) schema = schema.max(options.maxLength);
  if (options.pattern !== undefined) schema = schema.regex(new RegExp(options.pattern));
  if (options.format === "email") schema = schema.check(z.email());
  if (options.format === "url") schema = schema.check(z.url());
  if (options.format === "date") schema = schema.check(z.iso.date());
  if (options.format === "date-time") schema = schema.check(z.iso.datetime());
  return schema;
}

function configurationField<Schema extends z.ZodType>(
  schema: Schema,
  manifest: InputValueSchema,
  options: { readonly default?: z.input<Schema> },
): ConfigurationField<z.ZodType<z.output<Schema>>> {
  if (!Object.hasOwn(options, "default")) {
    return {
      kind: "configuration",
      schema: schema as unknown as z.ZodType<z.output<Schema>>,
      manifest,
      optional: false,
    };
  }
  const parsed = schema.safeParse(options.default);
  if (!parsed.success) {
    throw new Error(`Invalid input default: ${z.prettifyError(parsed.error)}`);
  }
  return {
    kind: "configuration",
    schema: schema.default(parsed.data as never) as z.ZodType<z.output<Schema>>,
    manifest: { ...manifest, default: parsed.data as JsonValue },
    optional: false,
  };
}

function stringInput(
  options: StringInputOptions = {},
  widget?: "textarea",
): ConfigurationField<z.ZodType<string>> {
  return configurationField(
    stringSchema(options),
    {
      type: "string",
      ...metadata(options),
      ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.placeholder === undefined ? {} : { "x-beetl-placeholder": options.placeholder }),
      ...(widget === undefined ? {} : { "x-beetl-widget": widget }),
    },
    options,
  );
}

/** Typed, non-secret connection and sync configuration. */
export const input = {
  string: (options: StringInputOptions = {}) => stringInput(options),
  text: (options: StringInputOptions = {}) => stringInput(options, "textarea"),

  integer(options: NumberInputOptions = {}): ConfigurationField<z.ZodType<number>> {
    assertBounds("integer", options.min, options.max);
    let schema = z.number().int();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return configurationField(
      schema,
      {
        type: "integer",
        ...metadata(options),
        ...(options.min === undefined ? {} : { minimum: options.min }),
        ...(options.max === undefined ? {} : { maximum: options.max }),
      },
      options,
    );
  },

  number(options: NumberInputOptions = {}): ConfigurationField<z.ZodType<number>> {
    assertBounds("number", options.min, options.max);
    let schema = z.number();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return configurationField(
      schema,
      {
        type: "number",
        ...metadata(options),
        ...(options.min === undefined ? {} : { minimum: options.min }),
        ...(options.max === undefined ? {} : { maximum: options.max }),
      },
      options,
    );
  },

  boolean(options: InputOptions<boolean> = {}): ConfigurationField<z.ZodType<boolean>> {
    return configurationField(z.boolean(), { type: "boolean", ...metadata(options) }, options);
  },

  select<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    details: InputOptions<Options[number]["value"]> = {},
  ): ConfigurationField<z.ZodType<Options[number]["value"]>> {
    const values = options.map(({ value }) => value) as [string, ...string[]];
    return configurationField(
      z.enum(values),
      {
        type: "string",
        ...metadata(details),
        enum: values,
        "x-beetl-options": options,
      },
      details,
    );
  },

  multiselect<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    details: Omit<ArrayInputOptions, "default"> & {
      readonly default?: readonly Options[number]["value"][];
    } = {},
  ): ConfigurationField<z.ZodType<Options[number]["value"][]>> {
    assertBounds("length", details.minItems, details.maxItems);
    let schema = z.array(z.enum(options.map(({ value }) => value) as [string, ...string[]]));
    if (details.minItems !== undefined) schema = schema.min(details.minItems);
    if (details.maxItems !== undefined) schema = schema.max(details.maxItems);
    return configurationField(
      schema,
      {
        type: "array",
        ...metadata(details),
        items: { type: "string", enum: options.map(({ value }) => value) },
        ...(details.minItems === undefined ? {} : { minItems: details.minItems }),
        ...(details.maxItems === undefined ? {} : { maxItems: details.maxItems }),
        "x-beetl-options": options,
      },
      Object.hasOwn(details, "default") ? { default: [...details.default!] } : {},
    );
  },

  object<const Shape extends ConfigurationShape>(
    shape: Shape,
    options: Pick<InputOptions<never>, "label" | "description"> = {},
  ): ConfigurationObject<Shape> {
    if (Object.values(shape).some((field) => field.kind !== "configuration")) {
      throw new Error("Configuration objects can contain only input.* fields");
    }
    const required = Object.entries(shape)
      .filter(([, field]) => !field.optional && !Object.hasOwn(field.manifest, "default"))
      .map(([name]) => name);
    return {
      kind: "configuration",
      shape,
      schema: z.strictObject(
        Object.fromEntries(
          Object.entries(shape).map(([name, field]) => [name, field.schema]),
        ) as SchemaShape<Shape>,
      ),
      manifest: {
        type: "object",
        ...metadata(options),
        properties: Object.fromEntries(
          Object.entries(shape).map(([name, field]) => [name, field.manifest]),
        ),
        additionalProperties: false,
        ...(required.length === 0 ? {} : { required }),
      },
      optional: false,
    };
  },

  array<const Item extends ConfigurationField>(
    item: Item,
    options: ArrayInputOptions = {},
  ): ConfigurationField<z.ZodType<z.output<Item["schema"]>[]>> {
    if (item.kind !== "configuration" || item.optional) {
      throw new Error("Configuration arrays require a non-optional input.* field");
    }
    assertBounds("length", options.minItems, options.maxItems);
    let arraySchema = z.array(item.schema);
    if (options.minItems !== undefined) arraySchema = arraySchema.min(options.minItems);
    if (options.maxItems !== undefined) arraySchema = arraySchema.max(options.maxItems);
    const schema = arraySchema as z.ZodType<z.output<Item["schema"]>[]>;
    return configurationField(
      schema,
      {
        type: "array",
        ...metadata(options),
        items: item.manifest,
        ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
        ...(options.maxItems === undefined ? {} : { maxItems: options.maxItems }),
      },
      Object.hasOwn(options, "default")
        ? { default: [...options.default!] as z.input<typeof schema> }
        : {},
    );
  },

  json(options: InputOptions<JsonValue> = {}): ConfigurationField<z.ZodType<JsonValue>> {
    return configurationField(
      z.json(),
      { ...metadata(options), "x-beetl-widget": "json" },
      options,
    );
  },

  optional<const Field extends ConfigurationField>(
    field: Field,
  ): ConfigurationField<z.ZodOptional<Field["schema"]>> {
    if (field.kind !== "configuration") {
      throw new Error("Only input.* fields can be optional configuration");
    }
    if (Object.hasOwn(field.manifest, "default")) {
      throw new Error("Defaulted inputs cannot also be optional");
    }
    return { ...field, schema: field.schema.optional(), optional: true };
  },
};

type CredentialOptions = Omit<StringInputOptions, "default">;

function credentialField(
  options: CredentialOptions,
  secret: boolean,
): CredentialField<z.ZodType<string>> {
  return {
    kind: "credential",
    schema: stringSchema(options),
    manifest: {
      type: "string",
      ...metadata(options),
      ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.placeholder === undefined ? {} : { "x-beetl-placeholder": options.placeholder }),
      ...(secret ? { "x-beetl-widget": "password" as const, writeOnly: true } : {}),
    },
  };
}

/** Authentication values entered by the user and retained only by the host. */
export const credential = {
  string: (options: CredentialOptions = {}) => credentialField(options, false),
  secret: (options: CredentialOptions = {}) => credentialField(options, true),
  object<const Shape extends CredentialShape>(shape: Shape): CredentialObject<Shape> {
    if (Object.values(shape).some((field) => field.kind !== "credential")) {
      throw new Error("Credential objects can contain only credential.* fields");
    }
    const required = Object.keys(shape);
    return {
      kind: "credentials",
      shape,
      schema: z.strictObject(
        Object.fromEntries(
          Object.entries(shape).map(([name, field]) => [name, field.schema]),
        ) as CredentialSchemaShape<Shape>,
      ),
      manifest: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([name, field]) => [name, field.manifest]),
        ),
        additionalProperties: false,
        ...(required.length === 0 ? {} : { required }),
      },
    };
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

export type ProviderOriginDefinition =
  | string
  | { readonly oauthTokenField: string }
  | { readonly input: string }
  | {
      readonly input: string;
      readonly values: Readonly<Record<string, string>>;
    };

export interface TokenExchangeOptions {
  readonly body?: {
    readonly encoding: "json" | "form";
    readonly fields: Readonly<Record<string, string>>;
    readonly values?: Readonly<Record<string, string>>;
  };
  readonly basic?: { readonly username: string; readonly password: string };
  readonly expiresInPath?: string;
  readonly expiresInSeconds?: number;
  readonly tokenHeader?: string;
  readonly tokenPrefix?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
}

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
  | ({
      type: "token_exchange";
      tokenUrl: string;
      headers: Readonly<Record<string, string>>;
      tokenPath: string;
      expiresAtPath: string;
    } & TokenExchangeOptions)
  | {
      type: "custom";
      headers: Readonly<Record<string, string>>;
      query: Readonly<Record<string, string>>;
    };

export type AuthDefinition = AuthManifest & { credentials: CredentialObject };

export const auth = {
  none(): AuthDefinition {
    return { type: "none", credentials: credential.object({}) };
  },

  bearer(): AuthDefinition {
    return {
      type: "bearer",
      credentials: credential.object({
        token: credential.secret({ label: "Bearer token", minLength: 1 }),
      }),
    };
  },

  basic(): AuthDefinition {
    return {
      type: "basic",
      credentials: credential.object({
        username: credential.string({ label: "Username", minLength: 1 }),
        password: credential.secret({ label: "Password" }),
      }),
    };
  },

  apiKey(options: { in: "header" | "query"; name: string }): AuthDefinition {
    return {
      type: "api_key",
      credentials: credential.object({
        apiKey: credential.secret({ label: "API key", minLength: 1 }),
      }),
      in: options.in,
      name: options.name,
    };
  },

  oauth2AuthorizationCode(options: {
    clientSecret?: true;
    issuer: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    tokenFields?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "oauth2_authorization_code",
      credentials: credential.object({
        clientId: credential.string({ label: "OAuth client ID", minLength: 1 }),
        ...(options.clientSecret === undefined
          ? {}
          : {
              clientSecret: credential.secret({
                label: "OAuth client secret",
                minLength: 1,
              }),
            }),
      }),
      issuer: options.issuer,
      authorizationUrl: options.authorizationUrl,
      tokenUrl: options.tokenUrl,
      scopes: options.scopes,
      usesClientSecret: options.clientSecret !== undefined,
      tokenFields: options.tokenFields ?? {},
    };
  },

  tokenExchange<const Shape extends CredentialShape>(
    options: {
      credentials: CredentialObject<Shape>;
      tokenUrl: string;
      headers?: Readonly<Record<string, string>>;
      tokenPath?: string;
      expiresAtPath?: string;
    } & TokenExchangeOptions,
  ): AuthDefinition {
    const { credentials, headers, tokenPath, expiresAtPath, ...exchange } = options;
    return {
      ...exchange,
      type: "token_exchange",
      credentials,
      headers: headers ?? {},
      tokenPath: tokenPath ?? "token",
      expiresAtPath: expiresAtPath ?? "expires_at",
    };
  },

  custom<const Shape extends CredentialShape>(options: {
    credentials: CredentialObject<Shape>;
    headers?: Readonly<Record<string, string>>;
    query?: Readonly<Record<string, string>>;
  }): AuthDefinition {
    return {
      type: "custom",
      credentials: options.credentials,
      headers: options.headers ?? {},
      query: options.query ?? {},
    };
  },
};

export interface CursorPagination {
  readonly type: "cursor";
  readonly cursorParameter: string;
  readonly cursorPath: string;
  readonly hasMorePath?: string;
  readonly limitParameter: string;
  readonly limit?: number;
  readonly responsePath?: string;
  readonly initialCursor?: string | number;
}

export interface OffsetPagination {
  readonly type: "offset";
  readonly offsetParameter: string;
  readonly hasMorePath?: string;
  readonly limitParameter: string;
  readonly limit?: number;
  readonly responsePath?: string;
  readonly initialOffset?: number;
  readonly increment?: "response-size" | "page";
}

export interface NextUrlPagination {
  readonly type: "next-url";
  readonly nextUrlPath: string;
  readonly hasMorePath?: string;
  readonly responsePath?: string;
}

export type PaginationDefinition = CursorPagination | OffsetPagination | NextUrlPagination;

export type PaginationOverride =
  | ({ readonly type?: "cursor" } & Partial<Omit<CursorPagination, "type">>)
  | ({ readonly type?: "offset" } & Partial<Omit<OffsetPagination, "type">>)
  | ({ readonly type?: "next-url" } & Partial<Omit<NextUrlPagination, "type">>);

type RecordSchema = z.ZodObject;
type PageRecordSchema = z.ZodType;
type CheckpointSchema = z.ZodType;
type ConfigSchema = ConfigurationObject;

export interface PaginationResponseMetadata {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PaginationPage<RecordValue> {
  readonly records: readonly RecordValue[];
  readonly nextPageParam?: string | number;
  readonly response: PaginationResponseMetadata;
}

export interface PaginateOptions<Records extends PageRecordSchema> {
  /** Explain a failed provider response before the generic pagination error. */
  readonly onResponseError?: (response: Response) => Promise<void>;
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

export interface ConnectionContext<ConnectionConfigValue extends object> {
  readonly config: ConnectionConfigValue;
  readonly signal: AbortSignal;
  fetch(path: string, init?: SyncFetchInit): Promise<Response>;
  readonly log: IntegrationLogger;
}

export interface SyncContext<
  RecordInput,
  CheckpointValue,
  ConfigValue extends object,
  ConnectionConfigValue extends object = JsonObject,
> {
  readonly config: {
    readonly connection: ConnectionConfigValue;
    readonly sync: ConfigValue;
  };
  readonly checkpoint: CheckpointValue | undefined;
  readonly signal: AbortSignal;
  fetch(path: string, init?: SyncFetchInit): Promise<Response>;
  paginate<const Records extends PageRecordSchema>(
    options: PaginateOptions<Records>,
  ): AsyncGenerator<PaginationPage<z.input<Records>>, void, void>;
  emit(value: {
    records: readonly RecordInput[];
    deletedKeys?: readonly JsonObject[];
    checkpoint?: CheckpointValue;
  }): Promise<void>;
  readonly log: IntegrationLogger;
}

type OptionalConfigurationKeys<Shape extends ConfigurationShape> = {
  [Key in keyof Shape]: undefined extends z.output<Shape[Key]["schema"]> ? Key : never;
}[keyof Shape];
type ConfigurationOutput<Shape extends ConfigurationShape> = {
  [Key in Exclude<keyof Shape, OptionalConfigurationKeys<Shape>>]: z.output<Shape[Key]["schema"]>;
} & {
  [Key in OptionalConfigurationKeys<Shape>]?: z.output<Shape[Key]["schema"]>;
};
type ConfigOutput<Config extends ConfigSchema | undefined> =
  Config extends ConfigurationObject<infer Shape> ? ConfigurationOutput<Shape> : JsonObject;

export type SyncMode = "append" | "replace" | "merge";

export interface SyncDefinition<
  Records extends RecordSchema = RecordSchema,
  Checkpoint extends CheckpointSchema | undefined = CheckpointSchema | undefined,
  Config extends ConfigSchema | undefined = ConfigSchema | undefined,
  ConnectionConfigValue extends object = JsonObject,
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
  readonly origin: ProviderOriginDefinition;
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
  readonly icon?: "icon.png" | "icon.webp";
  readonly connection: ConnectionDefinition<ConnectionConfig>;
  readonly syncs: Syncs;
}

type BoundDefineSync<ConnectionConfigValue extends object> = <
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
