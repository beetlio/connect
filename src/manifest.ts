import { type JSONType as JsonValue, z } from "zod";

import type {
  AuthManifest,
  BaseUrlDefinition,
  IntegrationDefinition,
  PaginationDefinition,
  RetryDefinition,
  SyncMode,
} from "./index.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

interface InputMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonValue;
  "x-beetl-input"?: true;
}

export interface InputObjectSchema extends InputMetadata {
  readonly type: "object";
  readonly properties: Readonly<Record<string, InputField>>;
  readonly required?: readonly string[];
}

export interface InputValueSchema extends InputMetadata {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array";
  readonly enum?: readonly string[];
  readonly writeOnly?: boolean;
  readonly "x-beetl-widget"?: "textarea" | "password" | "json";
}

export type InputField = InputObjectSchema | InputValueSchema;

export interface IntegrationManifest {
  readonly manifestVersion: 1;
  readonly hostProtocolVersion: 1;
  readonly integration: {
    readonly key: string;
    readonly displayName: string;
    readonly description?: string;
    readonly icon?: string;
  };
  readonly connection: {
    readonly baseUrl: BaseUrlDefinition;
    readonly auth: AuthManifest;
    readonly inputs: InputObjectSchema;
    readonly authenticationInput: InputObjectSchema;
    readonly retry?: RetryDefinition;
    readonly pagination?: PaginationDefinition;
    readonly canVerify: boolean;
  };
  readonly syncs: readonly {
    readonly key: string;
    readonly displayName: string;
    readonly mode: SyncMode;
    readonly inputs: InputObjectSchema;
    readonly records: JsonSchema;
    readonly primaryKey: readonly string[];
    readonly checkpoint?: JsonSchema;
  }[];
}

const EmptyObject = z.object({}).meta({ "x-beetl-input": true });
const SchemaValueKeywords = new Set([
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedProperties",
]);
const SchemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SchemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

export function createIntegrationManifest(integration: IntegrationDefinition): IntegrationManifest {
  const connection = integration.connection;
  const authentication = connection.auth ?? { type: "none" as const, inputs: EmptyObject };
  const { inputs: authenticationInput, ...auth } = authentication;
  return {
    manifestVersion: 1,
    hostProtocolVersion: 1,
    integration: {
      key: integration.key,
      displayName: integration.displayName,
      ...(integration.description === undefined ? {} : { description: integration.description }),
      ...(integration.icon === undefined ? {} : { icon: integration.icon }),
    },
    connection: {
      baseUrl: connection.baseUrl,
      auth,
      inputs: inputJsonSchema(connection.inputs ?? EmptyObject),
      authenticationInput: authenticationInputJsonSchema(authenticationInput),
      ...(connection.retry === undefined ? {} : { retry: connection.retry }),
      ...(connection.pagination === undefined ? {} : { pagination: connection.pagination }),
      canVerify: connection.verify !== undefined,
    },
    syncs: integration.syncs.map((sync) => ({
      key: sync.key,
      displayName: sync.displayName,
      mode: sync.mode ?? "append",
      inputs: inputJsonSchema(sync.inputs ?? EmptyObject),
      records: jsonSchema(sync.records, "output"),
      primaryKey: sync.primaryKey ?? [],
      ...(sync.checkpoint === undefined
        ? {}
        : { checkpoint: jsonSchema(sync.checkpoint, "output") }),
    })),
  };
}

function authenticationInputJsonSchema(schema: z.ZodType): InputObjectSchema {
  const result = inputJsonSchema(schema);
  if (containsDefault(result)) {
    throw new Error("Authentication input cannot declare defaults");
  }
  return result;
}

function inputJsonSchema(schema: z.ZodType): InputObjectSchema {
  const result = jsonSchema(schema, "input");
  if (
    result.type !== "object" ||
    typeof result.properties !== "object" ||
    result.properties === null ||
    Array.isArray(result.properties)
  ) {
    throw new Error("Integration input schemas must describe an object");
  }
  const input = result as unknown as InputObjectSchema;
  assertPromptableInputs(input, "Integration inputs");
  return input;
}

function assertPromptableInputs(schema: InputObjectSchema, location: string): void {
  if (schema["x-beetl-input"] !== true) {
    throw new Error(`${location} must be declared with input.object()`);
  }
  delete schema["x-beetl-input"];
  for (const [name, field] of Object.entries(schema.properties)) {
    const fieldLocation = `Input ${JSON.stringify(name)}`;
    if (field["x-beetl-input"] !== true) {
      throw new Error(`${fieldLocation} must be declared with input.*`);
    }
    if ("x-beetl-widget" in field && field["x-beetl-widget"] === "json") {
      delete field["x-beetl-input"];
      continue;
    }
    if (field.type === "object") {
      if (!("properties" in field) || field.properties === undefined) {
        throw new Error(`${fieldLocation} must use input.json() for arbitrary JSON objects`);
      }
      assertPromptableInputs(field, fieldLocation);
      continue;
    }
    delete field["x-beetl-input"];
    if (!field.type) {
      throw new Error(
        `${fieldLocation} cannot be represented by the interactive configuration form`,
      );
    }
  }
}

function containsDefault(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDefault);
  if (value === null || typeof value !== "object") return false;
  if (Object.hasOwn(value, "default")) return true;
  for (const [keyword, nested] of Object.entries(value)) {
    if (SchemaValueKeywords.has(keyword) && containsDefault(nested)) return true;
    if (SchemaArrayKeywords.has(keyword) && Array.isArray(nested) && nested.some(containsDefault)) {
      return true;
    }
    if (
      SchemaMapKeywords.has(keyword) &&
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested) &&
      Object.values(nested).some(containsDefault)
    ) {
      return true;
    }
  }
  return false;
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
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
