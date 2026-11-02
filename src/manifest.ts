import { z } from "zod";

import { AuthManifestSchema } from "./auth.ts";
import { InputFieldSchema, type InputObjectSchema, objectManifest } from "./forms.ts";
import { OriginSchema, RetrySchema, providerOrigin, resolveRetry } from "./http.ts";
import type { AuthManifest, ConnectionDefinition, IntegrationDefinition } from "./index.ts";

export type { InputField, InputObjectSchema, InputValueSchema } from "./forms.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Contract targeted by artifacts built with this SDK, independent of manifest format. */
export const HOST_CONTRACT_VERSION = 5;
export const SUPPORTED_HOST_CONTRACT_VERSIONS = [5] as const;

/** Omitted requirements identify legacy manifest-v2 artifacts. */
export function assertSupportedHostContractVersion(version: unknown = 1): void {
  if (!SUPPORTED_HOST_CONTRACT_VERSIONS.some((supported) => supported === version)) {
    throw new Error(
      `Unsupported host contract version ${JSON.stringify(version)}; supported: ${SUPPORTED_HOST_CONTRACT_VERSIONS.join(", ")}. Upgrade the execution host SDK or rebuild with a supported SDK.`,
    );
  }
}

export type IntegrationManifest = z.output<typeof IntegrationManifestSchema>;

/** Parse one definition boundary and derive its manifest from the same values. */
export function parseIntegration(value: unknown): {
  readonly integration: IntegrationDefinition;
  readonly manifest: IntegrationManifest;
} {
  const integration = Definition.parse(value) as IntegrationDefinition;

  validateKey(integration.key);

  if (!integration.displayName.trim()) throw new Error("Integration display name cannot be empty");

  if (!Object.keys(integration.syncs).length && !Object.keys(integration.destinations).length)
    throw new Error("Integration must define at least one sync or destination");

  return { integration, manifest: integrationManifest(integration) };
}

export function createIntegrationManifest(integration: IntegrationDefinition): IntegrationManifest {
  return parseIntegration(integration).manifest;
}

function integrationManifest(integration: IntegrationDefinition): IntegrationManifest {
  return {
    manifestVersion: 5,
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

      const records = jsonSchema(sync.records);
      recordProperties(records, `Sync ${JSON.stringify(key)} records`);

      return {
        key,
        displayName: sync.displayName ?? key,
        inputs: objectManifest(sync.inputs),
        records,
        ...(sync.checkpoint === undefined
          ? {}
          : { checkpoint: jsonSchema(sync.checkpoint, "input") }),
      };
    }),
    destinations: Object.entries(integration.destinations).map(([key, destination]) => {
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

const JsonSchemaValue: z.ZodType<JsonSchema> = z.record(z.string(), z.json());
const InputObject = z.custom<InputObjectSchema>((value) => {
  const parsed = InputFieldSchema.safeParse(value);

  return parsed.success && parsed.data.type === "object";
});
export const IntegrationManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(5),
    hostContractVersion: z.literal(5),
    integration: z
      .strictObject({
        key: z.string(),
        displayName: z.string(),
        description: z.string().optional(),
        icon: z.enum(["icon.png", "icon.webp"]).optional(),
      })
      .readonly(),
    connection: z
      .strictObject({
        origin: OriginSchema,
        auth: AuthManifestSchema,
        inputs: InputObject,
        credentials: InputObject,
        retry: RetrySchema.optional(),
        canVerify: z.boolean(),
      })
      .readonly(),
    syncs: z
      .array(
        z
          .strictObject({
            key: z.string(),
            displayName: z.string(),
            inputs: InputObject,
            records: JsonSchemaValue,
            checkpoint: JsonSchemaValue.optional(),
          })
          .readonly(),
      )
      .readonly(),
    destinations: z
      .array(
        z
          .strictObject({
            key: z.string(),
            displayName: z.string(),
            inputs: InputObject,
            records: JsonSchemaValue,
            primaryKey: z.array(z.string()).min(1).readonly(),
            supportsDelete: z.boolean(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();

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
    .default({}),
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
