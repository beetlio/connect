import { z } from "zod";
import type { JsonValue } from "./index.ts";

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

const Metadata = {
  title: z.string().optional(),
  description: z.string().optional(),
  default: z.json().optional(),
};
export const InputFieldSchema: z.ZodType<InputField> = z.lazy(() =>
  z.union([
    z.strictObject({
      ...Metadata,
      type: z.literal("object"),
      properties: z.record(z.string(), InputFieldSchema),
      required: z.array(z.string()).optional(),
      additionalProperties: z.literal(false),
    }),
    z
      .strictObject({
        ...Metadata,
        type: z.enum(["string", "number", "integer", "boolean", "array"]).optional(),
        enum: z.array(z.string()).optional(),
        items: InputFieldSchema.optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().optional(),
        pattern: z.string().optional(),
        format: z.enum(["email", "url", "date", "date-time"]).optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        minItems: z.number().int().nonnegative().optional(),
        maxItems: z.number().int().nonnegative().optional(),
        writeOnly: z.boolean().optional(),
        "x-beetl-options": z
          .array(z.strictObject({ value: z.string(), label: z.string() }))
          .optional(),
        "x-beetl-placeholder": z.string().optional(),
        "x-beetl-widget": z.enum(["textarea", "password", "json"]).optional(),
      })
      .superRefine((field, context) => {
        const widget = field["x-beetl-widget"];
        const options = field["x-beetl-options"];
        if (
          (widget === "json" && field.type !== undefined) ||
          ((widget === "textarea" || widget === "password") && field.type !== "string")
        ) {
          context.addIssue({ code: "custom", message: "Widget does not match the field type" });
        }
        if (
          options &&
          (!field.enum ||
            options.length !== field.enum.length ||
            new Set(options.map((option) => option.value)).size !== options.length ||
            options.some((option) => !field.enum?.includes(option.value)))
        ) {
          context.addIssue({
            code: "custom",
            message: "Options must label each enum value exactly once",
          });
        }
      }),
  ]),
) as z.ZodType<InputField>;

const MetadataKeys = new Set([
  "title",
  "description",
  "writeOnly",
  "x-beetl-options",
  "x-beetl-placeholder",
  "x-beetl-widget",
]);

/** One adapter owns Zod inspection; arbitrary Zod behavior is not a portable form. */
export function inputManifest(schema: z.ZodType, credentials = false, path = "inputs"): InputField {
  const meta = schema.meta() ?? {};

  for (const key of Object.keys(meta)) {
    if (!MetadataKeys.has(key)) throw new Error(`${path}: unsupported schema metadata ${key}`);
  }

  if (!credentials && (meta.writeOnly || meta["x-beetl-widget"] === "password")) {
    throw new Error(`${path}: configuration cannot contain credentials`);
  }

  const definition = schema._zod.def;

  if (definition.checks?.some((check) => ["custom", "overwrite"].includes(check._zod.def.check))) {
    throw new Error(`${path}: custom refinements and overwrites cannot be represented in a form`);
  }

  if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional) {
    const inner = schema.unwrap() as z.ZodType;
    const field = inputManifest(inner.meta({ ...inner.meta(), ...meta }), credentials, path);

    if (schema instanceof z.ZodDefault) {
      if (credentials) throw new Error(`${path}: credentials cannot have defaults`);

      const value = z.parse(schema.unwrap(), schema.def.defaultValue);

      return InputFieldSchema.parse({ ...field, ...meta, default: value });
    }

    return InputFieldSchema.parse({ ...field, ...meta });
  }

  if (meta["x-beetl-widget"] === "json" && schema instanceof z.ZodLazy) {
    const generated = z.toJSONSchema(schema);
    const reference = generated.$ref;
    const definition = reference ? generated.$defs?.[reference.split("/").at(-1)!] : generated;
    const branches = JSON.stringify(definition?.anyOf);
    const normalized = reference
      ? branches?.replaceAll(JSON.stringify(reference), '"#"')
      : branches;

    if (credentials || normalized !== JSON.stringify(z.toJSONSchema(z.json()).anyOf)) {
      throw new Error(`${path}: JSON widgets require z.json() outside credentials`);
    }

    return InputFieldSchema.parse(meta);
  }

  if (schema instanceof z.ZodObject) {
    if (credentials && path !== "inputs") throw new Error(`${path}: credentials must be strings`);

    if (!(schema.def.catchall instanceof z.ZodNever))
      throw new Error(`${path}: configuration objects must use z.strictObject()`);

    const properties = Object.fromEntries(
      Object.entries(schema.shape).map(([key, child]) => {
        if (
          ["__proto__", "prototype", "constructor"].includes(key) ||
          !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
        )
          throw new Error(`${path}: invalid field ${key}`);

        return [key, inputManifest(child, credentials, `${path}.${key}`)];
      }),
    );
    const required = Object.entries(schema.shape)
      .filter(([, child]) => !child.isOptional())
      .map(([key]) => key);

    return InputFieldSchema.parse({
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
      ...meta,
    });
  }

  if (schema instanceof z.ZodArray) {
    if (credentials) throw new Error(`${path}: credentials must be strings`);

    const generated = z.toJSONSchema(schema, { io: "input" });
    const { $schema, items, ...rest } = generated;

    return InputFieldSchema.parse({
      ...rest,
      items: inputManifest(schema.element as z.ZodType, false, `${path}[]`),
    });
  }

  if (!["string", "number", "boolean", "enum"].includes(definition.type)) {
    throw new Error(`${path}: schema cannot be represented in a portable form`);
  }

  if (credentials && definition.type !== "string")
    throw new Error(`${path}: credentials must be strings`);

  const { $schema, ...generated } = z.toJSONSchema(schema, { io: "input" });

  if (generated.format === "uri") generated.format = "url";

  try {
    return InputFieldSchema.parse(generated);
  } catch (cause) {
    throw new Error(`${path}: unsupported portable form constraints`, { cause });
  }
}

export function objectManifest(
  schema: z.ZodObject | undefined,
  credentials = false,
): InputObjectSchema {
  const field = inputManifest(schema ?? z.strictObject({}), credentials);

  if (field.type !== "object") throw new Error("Inputs must be an object");

  return field;
}
