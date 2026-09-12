import { z } from "zod";

import { AuthManifestSchema } from "./auth.ts";
import { InputFieldSchema, type InputObjectSchema, objectManifest } from "./forms.ts";
import { OriginSchema, RetrySchema, providerOrigin, resolveRetry } from "./http.ts";
import type {
  AuthManifest,
  ConnectionDefinition,
  IntegrationDefinition,
  ProviderOriginDefinition,
  RetryDefinition,
  SyncMode,
} from "./index.ts";

export type { InputField, InputObjectSchema, InputValueSchema } from "./forms.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Contract targeted by artifacts built with this SDK, independent of manifest format. */
export const HOST_CONTRACT_VERSION = 4;
export const SUPPORTED_HOST_CONTRACT_VERSIONS = [3, 4] as const;

/** Omitted requirements identify legacy manifest-v2 artifacts. */
export function assertSupportedHostContractVersion(version: unknown = 1): void {
  if (!SUPPORTED_HOST_CONTRACT_VERSIONS.some((supported) => supported === version)) {
    throw new Error(
      `Unsupported host contract version ${JSON.stringify(version)}; supported: ${SUPPORTED_HOST_CONTRACT_VERSIONS.join(", ")}. Upgrade the execution host SDK or rebuild with a supported SDK.`,
    );
  }
}

export interface IntegrationManifest {
  readonly manifestVersion: 3 | 4;
  /** Required execution behavior, independent of the SDK release. */
  readonly hostContractVersion: 3 | 4;
  readonly integration: {
    readonly key: string;
    readonly displayName: string;
    readonly description?: string;
    readonly icon?: "icon.png" | "icon.webp";
  };
  readonly connection: {
    readonly origin: ProviderOriginDefinition;
    readonly auth: AuthManifest;
    readonly inputs: InputObjectSchema;
    readonly credentials: InputObjectSchema;
    readonly retry?: RetryDefinition;
    readonly canVerify: boolean;
  };
  readonly syncs: readonly {
    readonly key: string;
    readonly displayName: string;
    readonly mode: SyncMode;
    readonly inputs: InputObjectSchema;
    readonly records: JsonSchema;
    readonly primaryKey?: readonly string[];
    readonly checkpoint?: JsonSchema;
  }[];
  /** Present in manifest v4. V3 artifacts expose pull syncs only. */
  readonly destinations?: readonly {
    readonly key: string;
    readonly displayName: string;
    readonly inputs: InputObjectSchema;
    readonly records: JsonSchema;
    readonly primaryKey: readonly string[];
    readonly supportsDelete: boolean;
  }[];
}

export type IntegrationManifestV4 = IntegrationManifest & {
  readonly manifestVersion: 4;
  readonly hostContractVersion: 4;
  readonly destinations: NonNullable<IntegrationManifest["destinations"]>;
};

/** Parse one definition boundary and derive its manifest from the same values. */
export function parseIntegration(value: unknown): {
  readonly integration: IntegrationDefinition;
  readonly manifest: IntegrationManifestV4;
} {
  const integration = Definition.parse(value) as IntegrationDefinition;

  validateKey(integration.key);

  if (!integration.displayName.trim()) throw new Error("Integration display name cannot be empty");

  if (!Object.keys(integration.syncs).length && !Object.keys(integration.destinations ?? {}).length)
    throw new Error("Integration must define at least one sync or destination");

  return { integration, manifest: integrationManifest(integration) };
}

export function createIntegrationManifest(
  integration: IntegrationDefinition,
): IntegrationManifestV4 {
  return parseIntegration(integration).manifest;
}

function integrationManifest(integration: IntegrationDefinition): IntegrationManifestV4 {
  return {
    manifestVersion: 4,
    hostContractVersion: HOST_CONTRACT_VERSION,
    integration: {
      key: integration.key,
      displayName: integration.displayName,
      ...(integration.description === undefined ? {} : { description: integration.description }),
      ...(integration.icon === undefined ? {} : { icon: integration.icon }),
    },
    connection: connectionManifest(integration.connection),
    syncs: Object.entries(integration.syncs).map(([key, sync]) => {
      validateKey(key);

      const mode = sync.mode ?? "append";

      if (mode !== "append" && mode !== "replace" && mode !== "merge") {
        throw new Error(`Sync ${JSON.stringify(key)} has invalid mode ${JSON.stringify(mode)}`);
      }

      const records = jsonSchema(sync.records);
      recordProperties(records, `Sync ${JSON.stringify(key)} records`);
      const declaredPrimaryKey = sync.primaryKey;

      if (mode !== "merge" && declaredPrimaryKey !== undefined) {
        throw new Error(`Sync ${JSON.stringify(key)} only merge mode may declare primaryKey`);
      }

      const primaryKey = mode === "merge" ? declaredPrimaryKey : undefined;

      if (mode === "merge") {
        if (hasRootOverwrite(sync.records)) {
          throw new Error(
            `Sync ${JSON.stringify(key)} merge records cannot use root-level overwrite(); normalize individual fields instead`,
          );
        }

        if (!primaryKey || primaryKey.length === 0) {
          throw new Error(`Sync ${JSON.stringify(key)} merge mode requires a primary key`);
        }

        validatePrimaryKey(records, primaryKey, `Sync ${JSON.stringify(key)}`);
      }

      return {
        key,
        displayName: sync.displayName ?? key,
        mode,
        inputs: objectManifest(sync.inputs),
        records,
        ...(primaryKey === undefined ? {} : { primaryKey }),
        ...(sync.checkpoint === undefined
          ? {}
          : { checkpoint: jsonSchema(sync.checkpoint, "input") }),
      };
    }),
    destinations: Object.entries(integration.destinations ?? {}).map(([key, destination]) => {
      validateKey(key);
      const label = `Destination ${JSON.stringify(key)}`;

      if (hasRootOverwrite(destination.records))
        throw new Error(
          `${label} records cannot use root-level overwrite(); normalize individual fields instead`,
        );

      // Hosts map to the accepted input shape. Match it with strict runtime parsing.
      const records = jsonSchema(destination.records.strict(), "input");
      validatePrimaryKey(records, destination.primaryKey, label);
      // Key normalization must also preserve the scalar identity contract.
      for (const field of destination.primaryKey) {
        const schema = destination.records.shape[field]!;
        const output = z.toJSONSchema(schema, {
          override: function rejectCoercion({ zodSchema }) {
            const definition = zodSchema._zod.def;
            if ("coerce" in definition && definition.coerce)
              throw new Error(
                `${label} primary key ${JSON.stringify(field)} must be required, scalar, and non-null without coercion`,
              );
            // Output conversion skips pipeline inputs. Inspect them too, including
            // intermediate transforms that need no standalone JSON Schema.
            if (definition.type === "pipe")
              z.toJSONSchema(definition.in, {
                unrepresentable: "any",
                override: rejectCoercion,
              });
          },
        });
        if (!isScalarSchema(output))
          throw new Error(
            `${label} primary key ${JSON.stringify(field)} must remain scalar and non-null`,
          );
      }

      return {
        key,
        displayName: destination.displayName ?? key,
        inputs: objectManifest(destination.inputs),
        records,
        primaryKey: [...destination.primaryKey],
        supportsDelete: destination.supportsDelete ?? false,
      };
    }),
  };
}

function validatePrimaryKey(
  records: JsonSchema,
  primaryKey: readonly string[],
  label: string,
): void {
  const properties = recordProperties(records, `${label} records`);
  if (!primaryKey.length) throw new Error(`${label} requires a primary key`);
  if (new Set(primaryKey).size !== primaryKey.length)
    throw new Error(`${label} primary key fields must be unique`);
  const required = new Set(Array.isArray(records.required) ? records.required : []);

  for (const key of primaryKey) {
    const field = properties[key];
    if (field === undefined)
      throw new Error(`${label} primary key ${JSON.stringify(key)} is not a record field`);
    if (!required.has(key) || !isScalarSchema(field))
      throw new Error(
        `${label} primary key ${JSON.stringify(key)} must be required, scalar, and non-null`,
      );
  }
}

function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io }) as JsonSchema;
  } catch (error) {
    throw new Error(
      `Schema cannot be represented in an integration manifest: ${
        error instanceof Error ? error.message : error
      }`,
      { cause: error },
    );
  }
}

function recordProperties(schema: JsonSchema, label: string): Readonly<Record<string, JsonSchema>> {
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isJsonSchema(schema.properties)
  ) {
    throw new Error(`${label} must be a closed object`);
  }

  return schema.properties as Readonly<Record<string, JsonSchema>>;
}

function isScalarSchema(schema: JsonSchema): boolean {
  return (
    schema.type === "string" ||
    schema.type === "integer" ||
    schema.type === "number" ||
    schema.type === "boolean"
  );
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRootOverwrite(schema: z.ZodObject): boolean {
  return schema._zod.def.checks?.some((check) => check._zod.def.check === "overwrite") ?? false;
}

const JsonSchemaValue = z.record(z.string(), z.json());
const InputObject = z.custom<InputObjectSchema>((value) => {
  const parsed = InputFieldSchema.safeParse(value);

  return parsed.success && parsed.data.type === "object";
});
const ManifestV3 = z.strictObject({
  manifestVersion: z.literal(3),
  hostContractVersion: z.literal(3),
  integration: z.strictObject({
    key: z.string(),
    displayName: z.string(),
    description: z.string().optional(),
    icon: z.enum(["icon.png", "icon.webp"]).optional(),
  }),
  connection: z.strictObject({
    origin: OriginSchema,
    auth: AuthManifestSchema,
    inputs: InputObject,
    credentials: InputObject,
    retry: RetrySchema.optional(),
    canVerify: z.boolean(),
  }),
  syncs: z.array(
    z.strictObject({
      key: z.string(),
      displayName: z.string(),
      mode: z.enum(["append", "replace", "merge"]),
      inputs: InputObject,
      records: JsonSchemaValue,
      primaryKey: z.array(z.string()).optional(),
      checkpoint: JsonSchemaValue.optional(),
    }),
  ),
});

export const IntegrationManifestSchema = z.discriminatedUnion("manifestVersion", [
  ManifestV3,
  ManifestV3.extend({
    manifestVersion: z.literal(4),
    hostContractVersion: z.literal(4),
    destinations: z.array(
      z.strictObject({
        key: z.string(),
        displayName: z.string(),
        inputs: InputObject,
        records: JsonSchemaValue,
        primaryKey: z.array(z.string()).min(1),
        supportsDelete: z.boolean(),
      }),
    ),
  }),
]);

const Schema = z.custom<z.ZodType>((value) => value instanceof z.ZodType);
const ObjectSchema = z.custom<z.ZodObject>((value) => value instanceof z.ZodObject);
const FunctionSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
);
const Definition = z.strictObject({
  key: z.string(),
  displayName: z.string().min(1),
  description: z.string().min(1).optional(),
  icon: z.enum(["icon.png", "icon.webp"]).optional(),
  connection: z.strictObject({
    origin: OriginSchema,
    auth: z.unknown().optional(),
    inputs: ObjectSchema.optional(),
    retry: z.unknown().optional(),
    verify: FunctionSchema.optional(),
  }),
  syncs: z
    .record(
      z.string(),
      z.strictObject({
        displayName: z.string().min(1).optional(),
        records: ObjectSchema,
        inputs: ObjectSchema.optional(),
        checkpoint: Schema.optional(),
        mode: z.enum(["append", "replace", "merge"]).optional(),
        primaryKey: z.array(z.string()).optional(),
        run: FunctionSchema,
      }),
    )
    .default({}),
  destinations: z
    .record(
      z.string(),
      z.strictObject({
        displayName: z.string().min(1).optional(),
        records: ObjectSchema,
        primaryKey: z.array(z.string()).min(1),
        inputs: ObjectSchema.optional(),
        supportsDelete: z.boolean().optional(),
        run: FunctionSchema,
      }),
    )
    .optional(),
});

function validateKey(key: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(key))
    throw new Error(
      "Integration, sync, and destination keys must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens",
    );
}

function connectionManifest(connection: ConnectionDefinition): IntegrationManifest["connection"] {
  const inputs = objectManifest(connection.inputs);
  const authentication = connection.auth;
  const auth =
    authentication === undefined
      ? ({ type: "none" } as const)
      : AuthManifestSchema.parse((({ credentials, ...value }) => value)(authentication));
  const credentials = objectManifest(authentication?.credentials, true);
  const origin = connection.origin;

  if (typeof origin === "string") providerOrigin(origin, auth.type !== "none");
  else if (origin.type === "environment") {
    const field = inputs.properties[origin.input];
    const values = field?.type === "string" ? field.enum : undefined;

    if (
      !values?.length ||
      values.length !== Object.keys(origin.values).length ||
      values.some((value) => origin.values[value] === undefined)
    )
      throw new Error("Provider origins must map every value of a connection select input");

    for (const value of Object.values(origin.values)) providerOrigin(value, auth.type !== "none");
  } else if (origin.type === "input") {
    const field = inputs.properties[origin.input];

    if (
      field?.type !== "string" ||
      field.format !== "url" ||
      (!inputs.required?.includes(origin.input) && !Object.hasOwn(field, "default"))
    )
      throw new Error("Provider origin must reference a required URL connection input");
  } else if (
    auth.type !== "oauth2_authorization_code" ||
    auth.tokenFields[origin.oauthTokenField] === undefined
  ) {
    throw new Error("Provider origin references an unknown OAuth token field");
  }

  const references = credentialReferences(auth);

  for (const key of references)
    if (!Object.hasOwn(credentials.properties, key))
      throw new Error(`Authentication references unknown credential ${JSON.stringify(key)}`);

  for (const key of Object.keys(credentials.properties))
    if (!references.includes(key))
      throw new Error(`Authentication declares unused credential ${JSON.stringify(key)}`);

  const secrets =
    auth.type === "bearer"
      ? ["token"]
      : auth.type === "basic"
        ? ["password"]
        : auth.type === "api_key"
          ? ["apiKey"]
          : auth.type === "oauth2_authorization_code" && auth.usesClientSecret
            ? ["clientSecret"]
            : auth.type === "token_exchange" && auth.request.basic
              ? [auth.request.basic.password]
              : [];

  for (const key of secrets) {
    const field = credentials.properties[key];

    if (!field || !("writeOnly" in field) || field.writeOnly !== true)
      throw new Error(`Authentication credential ${JSON.stringify(key)} must be secret`);
  }

  if ((auth.type === "custom" || auth.type === "token_exchange") && !references.length)
    throw new Error("Authentication must inject at least one credential");

  if (auth.type === "token_exchange") {
    const request = auth.request;

    if (
      !request.path.startsWith("/") ||
      request.path.startsWith("//") ||
      /[\\\s#]/.test(request.path)
    )
      throw new Error("Token exchange URL must be a relative-origin path beginning with /");

    const paths = [
      auth.response.tokenPath,
      ...(auth.response.expiry.type === "fixed" ? [] : [auth.response.expiry.path]),
    ];

    if (paths.some((path) => path.split(".").some((part) => !part.trim())))
      throw new Error("Token exchange response paths cannot be empty");

    new Headers().set(
      auth.session?.header ?? "authorization",
      `${auth.session?.prefix ?? "Bearer "}token`,
    );
  }

  const headers =
    auth.type === "custom"
      ? auth.headers
      : auth.type === "token_exchange"
        ? { ...auth.request.headers, ...auth.session?.headers }
        : auth.type === "api_key" && auth.in === "header"
          ? { [auth.name]: "value" }
          : {};

  for (const key of Object.keys(headers)) new Headers().set(key, "value");

  if (auth.type === "oauth2_authorization_code") {
    for (const value of [auth.issuer, auth.authorizationUrl, auth.tokenUrl]) {
      if (/[\x00-\x20\x7f#\\]/.test(value)) throw new Error("Invalid OAuth URL");

      if (value.startsWith("/") && !value.startsWith("//")) {
        if (typeof origin !== "string" && origin.type === "oauth")
          throw new Error("Relative OAuth URLs require an origin available before authorization");
      } else {
        const url = new URL(value);

        providerOrigin(url.origin, true);

        if (url.username || url.password) throw new Error("OAuth URLs cannot contain credentials");
      }
    }
  }

  resolveRetry(connection.retry);

  return {
    origin,
    auth,
    inputs,
    credentials,
    ...(connection.retry === undefined ? {} : { retry: connection.retry }),
    canVerify: connection.verify !== undefined,
  };
}

function credentialReferences(auth: AuthManifest): readonly string[] {
  switch (auth.type) {
    case "none":
      return [];
    case "bearer":
      return ["token"];
    case "basic":
      return ["username", "password"];
    case "api_key":
      return ["apiKey"];
    case "oauth2_authorization_code":
      return ["clientId", ...(auth.usesClientSecret ? ["clientSecret"] : [])];
    case "custom":
      return [...Object.values(auth.headers), ...Object.values(auth.query)].flatMap((value) =>
        typeof value === "string" ? [] : [value.credential],
      );
    case "token_exchange":
      return [
        ...Object.values(auth.request.headers ?? {}),
        ...Object.values(auth.request.body?.fields ?? {}),
        ...Object.values(auth.session?.headers ?? {}),
      ]
        .flatMap((value) => (typeof value === "string" ? [] : [value.credential]))
        .concat(
          auth.request.basic ? [auth.request.basic.username, auth.request.basic.password] : [],
        );
  }
}
