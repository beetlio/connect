import { type JSONType as JsonValue, z } from "zod";

import type {
  AuthManifest,
  IntegrationDefinition,
  PaginationDefinition,
  ProviderOriginDefinition,
  RetryDefinition,
  SyncMode,
} from "./index.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

interface InputMetadata {
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonValue;
}

export interface InputObjectSchema extends InputMetadata {
  readonly type: "object";
  readonly properties: Readonly<Record<string, InputField>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface InputValueSchema extends InputMetadata {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array";
  readonly enum?: readonly string[];
  readonly items?: InputField;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: "email" | "url" | "date" | "date-time";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly writeOnly?: boolean;
  readonly "x-beetl-options"?: readonly { readonly value: string; readonly label: string }[];
  readonly "x-beetl-placeholder"?: string;
  readonly "x-beetl-widget"?: "textarea" | "password" | "json";
}

export type InputField = InputObjectSchema | InputValueSchema;

export interface IntegrationManifest {
  readonly manifestVersion: 1;
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

const EmptyObject: InputObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function createIntegrationManifest(integration: IntegrationDefinition): IntegrationManifest {
  const authentication = integration.connection.auth;
  let auth: AuthManifest = { type: "none" };
  if (authentication !== undefined) {
    const { credentials: _, ...manifest } = authentication;
    auth = manifest;
  }
  return {
    manifestVersion: 1,
    integration: {
      key: integration.key,
      displayName: integration.displayName,
      ...(integration.description === undefined ? {} : { description: integration.description }),
      ...(integration.icon === undefined ? {} : { icon: integration.icon }),
    },
    connection: {
      origin: integration.connection.origin,
      auth,
      inputs: integration.connection.inputs?.manifest ?? EmptyObject,
      credentials: authentication?.credentials.manifest ?? EmptyObject,
      ...(integration.connection.retry === undefined
        ? {}
        : { retry: integration.connection.retry }),
      ...(integration.connection.pagination === undefined
        ? {}
        : { pagination: integration.connection.pagination }),
      canVerify: integration.connection.verify !== undefined,
    },
    syncs: integration.syncs.map((sync) => ({
      key: sync.key,
      displayName: sync.displayName,
      mode: sync.mode ?? "append",
      inputs: sync.inputs?.manifest ?? EmptyObject,
      records: jsonSchema(sync.records),
      primaryKey: sync.primaryKey ?? [],
      ...(sync.checkpoint === undefined
        ? {}
        : { checkpoint: jsonSchema(sync.checkpoint, "input") }),
    })),
  };
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
