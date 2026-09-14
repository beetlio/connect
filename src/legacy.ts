import { z, type JSONType } from "zod";

type JsonValue = JSONType;

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

function metadata(options: { readonly label?: string; readonly description?: string }) {
  return {
    ...(options.label === undefined ? {} : { title: options.label }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}

function defaulted<S extends z.ZodType>(
  schema: S,
  options: { readonly default?: z.input<S> },
): S | z.ZodDefault<S> {
  if (!Object.hasOwn(options, "default")) return schema;
  return schema.default(schema.parse(options.default) as never);
}

function stringSchema(options: Omit<StringInputOptions, "default">): z.ZodString {
  let schema = z.string();
  if (options.minLength !== undefined) schema = schema.min(options.minLength);
  if (options.maxLength !== undefined) schema = schema.max(options.maxLength);
  if (options.pattern !== undefined) schema = schema.regex(new RegExp(options.pattern));
  if (options.format === "email") schema = schema.check(z.email());
  if (options.format === "url") schema = schema.check(z.url());
  if (options.format === "date") schema = schema.check(z.iso.date());
  if (options.format === "date-time") schema = schema.check(z.iso.datetime());
  return schema.meta({
    ...metadata(options),
    ...(options.placeholder === undefined ? {} : { "x-beetl-placeholder": options.placeholder }),
  });
}

function stringInput(options: StringInputOptions = {}, widget?: "textarea") {
  const schema = stringSchema(options).meta({
    ...stringSchema(options).meta(),
    ...(widget === undefined ? {} : { "x-beetl-widget": widget }),
  });
  return defaulted(schema, options);
}

/** Compatibility helpers for integrations authored before the Zod-first v0.4 API. */
export const input = {
  string: (options: StringInputOptions = {}) => stringInput(options),
  text: (options: StringInputOptions = {}) => stringInput(options, "textarea"),

  integer(options: NumberInputOptions = {}) {
    let schema = z.number().int();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return defaulted(schema.meta(metadata(options)), options);
  },

  number(options: NumberInputOptions = {}) {
    let schema = z.number();
    if (options.min !== undefined) schema = schema.min(options.min);
    if (options.max !== undefined) schema = schema.max(options.max);
    return defaulted(schema.meta(metadata(options)), options);
  },

  boolean(options: InputOptions<boolean> = {}) {
    return defaulted(z.boolean().meta(metadata(options)), options);
  },

  select<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    details: InputOptions<Options[number]["value"]> = {},
  ) {
    const values = options.map(({ value }) => value) as [
      Options[number]["value"],
      ...Options[number]["value"][],
    ];
    return defaulted(
      z.enum(values).meta({ ...metadata(details), "x-beetl-options": options }),
      details,
    );
  },

  multiselect<const Options extends readonly [SelectOption, ...SelectOption[]]>(
    options: Options,
    details: Omit<ArrayInputOptions, "default"> & {
      readonly default?: readonly Options[number]["value"][];
    } = {},
  ) {
    let schema = z.array(
      z.enum(
        options.map(({ value }) => value) as [
          Options[number]["value"],
          ...Options[number]["value"][],
        ],
      ),
    );
    if (details.minItems !== undefined) schema = schema.min(details.minItems);
    if (details.maxItems !== undefined) schema = schema.max(details.maxItems);
    return defaulted(schema.meta(metadata(details)), {
      ...(details.default === undefined ? {} : { default: [...details.default] }),
    });
  },

  object<const Shape extends z.ZodRawShape>(
    shape: Shape,
    options: Pick<InputOptions<never>, "label" | "description"> = {},
  ) {
    return z.strictObject(shape).meta(metadata(options));
  },

  array<const Item extends z.ZodType>(item: Item, options: ArrayInputOptions = {}) {
    let schema = z.array(item);
    if (options.minItems !== undefined) schema = schema.min(options.minItems);
    if (options.maxItems !== undefined) schema = schema.max(options.maxItems);
    return defaulted(schema.meta(metadata(options)), {
      ...(options.default === undefined
        ? {}
        : { default: [...options.default] as z.input<Item>[] }),
    });
  },

  json(options: InputOptions<JsonValue> = {}) {
    return defaulted(
      z.lazy(() => z.json()).meta({ ...metadata(options), "x-beetl-widget": "json" }),
      options,
    );
  },

  optional<const Field extends z.ZodType>(field: Field): z.ZodOptional<Field> {
    return field.optional();
  },
};

type CredentialOptions = Omit<StringInputOptions, "default">;

function credentialField(options: CredentialOptions, writeOnly: boolean) {
  return stringSchema(options).meta({
    ...stringSchema(options).meta(),
    ...(writeOnly ? { writeOnly: true, "x-beetl-widget": "password" as const } : {}),
  });
}

export const credential = {
  string: (options: CredentialOptions = {}) => credentialField(options, false),
  secret: (options: CredentialOptions = {}) => credentialField(options, true),
  object<const Shape extends z.ZodRawShape>(shape: Shape) {
    return z.strictObject(shape);
  },
};

/** Coalesce snapshot records across pages while retaining the v0.3 emit contract. */
export function createRecordBatcher<RecordValue>(
  emit: (value: { readonly records: readonly RecordValue[] }) => Promise<void>,
) {
  let records: RecordValue[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!records.length) return;
    await emit({ records });
    records = [];
    bytes = 0;
  };
  return {
    async emit(value: { readonly records: readonly RecordValue[] }) {
      for (const record of value.records) {
        const json = JSON.stringify(record);
        const size = new TextEncoder().encode(json).length;
        if (records.length && (records.length >= 100 || bytes + size > 1024 * 1024)) await flush();
        records.push(JSON.parse(json) as RecordValue);
        bytes += size;
        if (bytes >= 1024 * 1024) await flush();
      }
    },
    flush,
  };
}

export type LegacyPaginationDefinition =
  | {
      readonly type: "cursor";
      readonly cursorParameter: string;
      readonly cursorPath: string;
      readonly hasMorePath?: string;
      readonly limitParameter: string;
      readonly limit?: number;
      readonly responsePath?: string;
      readonly initialCursor?: string | number;
    }
  | {
      readonly type: "offset";
      readonly offsetParameter: string;
      readonly hasMorePath?: string;
      readonly limitParameter: string;
      readonly limit?: number;
      readonly responsePath?: string;
      readonly initialOffset?: number;
      readonly increment?: "response-size" | "page";
    }
  | {
      readonly type: "next-url";
      readonly nextUrlPath: string;
      readonly hasMorePath?: string;
      readonly responsePath?: string;
    };

export interface LegacyPaginateOptions<Records extends z.ZodType> {
  readonly onResponseError?: (response: Response) => Promise<void>;
  readonly path: string;
  readonly records: Records;
  readonly pagination: LegacyPaginationDefinition;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
}

export interface LegacyPaginationPage<RecordValue> {
  readonly records: readonly RecordValue[];
  readonly nextPageParam?: string | number;
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/** Execute the declarative pagination contract used by v0.3 integrations. */
export async function* legacyPaginate<Records extends z.ZodType>(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  options: LegacyPaginateOptions<Records>,
): AsyncGenerator<LegacyPaginationPage<z.input<Records>>, void, void> {
  const pagination = options.pagination;
  let pages = 0;
  const fetchPage = async (path: string) => {
    if (++pages > 10_000) throw new Error("Pagination exceeded 10000 pages");
    const response = await fetch(path, {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) await options.onResponseError?.(response.clone());
    return response;
  };
  const page = async (path: string) => {
    const response = await fetchPage(path);
    const text = await response.text();
    if (!response.ok) {
      const detail = text.replace(/\s+/g, " ").trim().slice(0, 1_000);
      throw new Error(
        `Provider returned ${response.status} while paginating${detail ? ` (${detail})` : ""}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error("Provider returned invalid JSON while paginating", { cause });
    }
    const value =
      pagination.responsePath === undefined ? body : valueAtPath(body, pagination.responsePath);
    const parsed = await z.array(options.records).safeParseAsync(value);
    if (!parsed.success)
      throw new Error(`Invalid paginated records: ${z.prettifyError(parsed.error)}`);
    return {
      body,
      records: value as z.input<Records>[],
      response: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
  };

  if (pagination.type === "next-url") {
    let path = legacyPath(options.path, {});
    const seen = new Set<string>();
    while (true) {
      if (seen.has(path)) throw new Error("Provider repeated a pagination next URL");
      seen.add(path);
      const current = await page(path);
      const hasMore = hasMoreAt(current.body, pagination.hasMorePath);
      const candidate =
        hasMore === false ? undefined : valueAtPath(current.body, pagination.nextUrlPath);
      const nextPageParam =
        typeof candidate === "string" && candidate.trim() ? legacyPath(candidate, {}) : undefined;
      if (hasMore === true && nextPageParam === undefined)
        throw new Error("Provider returned has-more=true without a pagination next URL");
      if (!current.records.length && nextPageParam === undefined) return;
      yield {
        records: current.records,
        response: current.response,
        ...(nextPageParam === undefined ? {} : { nextPageParam }),
      };
      if (nextPageParam === undefined) return;
      path = nextPageParam;
    }
  }

  if (pagination.type === "cursor") {
    let cursor = pagination.initialCursor;
    const seen = new Set(cursor === undefined ? [] : [String(cursor)]);
    while (true) {
      const current = await page(
        legacyPath(options.path, {
          ...(cursor === undefined ? {} : { [pagination.cursorParameter]: String(cursor) }),
          ...(pagination.limit === undefined
            ? {}
            : { [pagination.limitParameter]: String(pagination.limit) }),
        }),
      );
      const hasMore = hasMoreAt(current.body, pagination.hasMorePath);
      const candidate =
        hasMore === false ? undefined : valueAtPath(current.body, pagination.cursorPath);
      const nextPageParam =
        typeof candidate === "string" || typeof candidate === "number" ? candidate : undefined;
      if (nextPageParam !== undefined) {
        const key = String(nextPageParam);
        if (seen.has(key)) throw new Error("Provider repeated a pagination cursor");
        seen.add(key);
      }
      if (hasMore === true && nextPageParam === undefined)
        throw new Error("Provider returned has-more=true without a pagination cursor");
      if (!current.records.length && nextPageParam === undefined) return;
      yield {
        records: current.records,
        response: current.response,
        ...(nextPageParam === undefined ? {} : { nextPageParam }),
      };
      if (nextPageParam === undefined) return;
      cursor = nextPageParam;
    }
  }

  let offset = pagination.initialOffset ?? 0;
  while (true) {
    const current = await page(
      legacyPath(options.path, {
        [pagination.offsetParameter]: String(offset),
        ...(pagination.limit === undefined
          ? {}
          : { [pagination.limitParameter]: String(pagination.limit) }),
      }),
    );
    const hasMore = hasMoreAt(current.body, pagination.hasMorePath);
    if (!current.records.length && hasMore !== true) return;
    if (!current.records.length && pagination.increment !== "page")
      throw new Error("Provider returned has-more=true without records to advance the offset");
    const nextPageParam =
      pagination.increment === "page" ? offset + 1 : offset + current.records.length;
    const hasNext =
      hasMore ?? (pagination.limit === undefined || current.records.length >= pagination.limit);
    yield {
      records: current.records,
      response: current.response,
      ...(hasNext ? { nextPageParam } : {}),
    };
    if (!hasNext) return;
    offset = nextPageParam;
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined;
    return Reflect.get(current, key);
  }, value);
}

function hasMoreAt(body: unknown, path: string | undefined): boolean | undefined {
  if (path === undefined) return undefined;
  const value = valueAtPath(body, path);
  if (typeof value !== "boolean") throw new Error("Provider returned an invalid has-more value");
  return value;
}

function legacyPath(path: string, values: Readonly<Record<string, string>>): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("ctx.paginate requires a relative-origin path beginning with /");
  const url = new URL(path, "https://provider.invalid");
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url.pathname + url.search;
}
