import { z } from "zod";

type Schema = Record<string, unknown>;

/** Project provider data to fixed storage columns without losing dynamic JSON values. */
export function storageRecord(source: z.ZodObject): z.ZodObject {
  if (source._zod.def.checks?.length) {
    throw new Error("storageRecord requires a plain object without root refinements");
  }
  const catchall = source._zod.def.catchall;
  if (catchall && !(catchall instanceof z.ZodNever)) {
    throw new Error("storageRecord requires fixed root fields without a catchall");
  }
  const object = catchall ? z.strictObject : z.object;
  return object(
    Object.fromEntries(
      Object.entries(source.shape).map(([name, field]) => {
        const schema = z.toJSONSchema(field, { io: "output" }) as Schema;
        let target = storageType(schema);
        if (field.isOptional()) target = target.optional();
        return [name, z.preprocess((value) => project(schema, field.parse(value)), target)];
      }),
    ),
  );
}

function nonNull(schema: Schema): { schema: Schema; nullable: boolean } {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Schema[];
    const values = branches.filter((branch) => branch.type !== "null");
    if (values.length > 0 && values.length < branches.length)
      return {
        schema: values.length === 1 ? values[0]! : { ...schema, anyOf: values },
        nullable: true,
      };
  }
  if (Array.isArray(schema.type)) {
    const values = schema.type.filter((type) => type !== "null");
    if (values.length === 1)
      return { schema: { ...schema, type: values[0] }, nullable: schema.type.includes("null") };
  }
  return { schema, nullable: false };
}

function storageType(original: Schema): z.ZodType {
  const { schema, nullable } = nonNull(original);
  let result: z.ZodType;
  if (schema.type === "string") result = z.string();
  else if (schema.type === "integer") result = z.number().int();
  else if (schema.type === "number") result = z.number();
  else if (schema.type === "boolean") result = z.boolean();
  else if (schema.type === "array" && isSchema(schema.items))
    result = z.array(storageType(schema.items));
  else if (
    schema.type === "object" &&
    schema.additionalProperties === false &&
    isSchema(schema.properties)
  ) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    result = z.object(
      Object.fromEntries(
        Object.entries(schema.properties).map(([name, value]) => {
          if (!isSchema(value)) throw new Error("Invalid nested record schema");
          const child = storageType(value);
          return [name, required.includes(name) ? child : child.optional()];
        }),
      ),
    );
  } else result = z.string();
  return nullable ? result.nullable() : result;
}

function project(original: Schema, value: unknown): unknown {
  if (value === undefined) return undefined;
  const { schema, nullable } = nonNull(original);
  if (nullable && value === null) return null;
  if (["string", "integer", "number", "boolean"].includes(String(schema.type))) return value;
  if (schema.type === "array" && isSchema(schema.items) && Array.isArray(value))
    return value.map((item) => project(schema.items as Schema, item));
  if (
    schema.type === "object" &&
    schema.additionalProperties === false &&
    isSchema(schema.properties) &&
    isSchema(value)
  ) {
    return Object.fromEntries(
      Object.entries(schema.properties)
        .map(([name, child]) => [name, project(child as Schema, value[name])])
        .filter(([, child]) => child !== undefined),
    );
  }
  // Primitive ID/amount unions have one text column; structured and dynamic values retain JSON encoding.
  if (
    Array.isArray(schema.anyOf) &&
    (schema.anyOf as Schema[]).every((branch) =>
      ["string", "number", "integer", "boolean"].includes(String(branch.type)),
    )
  )
    return String(value);
  return JSON.stringify(value);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
