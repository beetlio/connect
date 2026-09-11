import { z } from "zod";
import type {
  JsonObject,
  ProviderOriginDefinition,
  RetryDefinition,
  RetryPolicy,
  SyncFetchInit,
} from "./index.ts";

export interface PaginationRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PaginationPage<T> {
  readonly data: T;
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly request: PaginationRequest;
  readonly index: number;
}

export interface PaginateOptions<S extends z.ZodType> {
  readonly request: PaginationRequest;
  readonly schema: S;
  readonly next: (page: PaginationPage<z.output<S>>) => PaginationRequest | undefined;
  readonly signal?: AbortSignal;
}

const HttpErrorTag = Symbol.for("@beetlio/connect/HttpError");

export class HttpError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && Reflect.get(value, HttpErrorTag) === true;
  }

  readonly status: number;
  readonly detail: string;
  readonly requestId: string | undefined;

  constructor(status: number, detail: string, requestId?: string) {
    super(
      `Provider returned ${status}${requestId ? ` [${requestId}]` : ""}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "HttpError";
    Object.defineProperty(this, HttpErrorTag, { value: true });
    this.status = status;
    this.detail = detail;
    this.requestId = requestId;
  }
}

export async function parseResponse<S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> {
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 1000);

    throw new HttpError(
      response.status,
      detail,
      response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
    );
  }

  let value: unknown;

  try {
    value = await response.json();
  } catch (cause) {
    throw new Error("Provider returned invalid JSON", { cause });
  }

  return schema.parseAsync(value);
}

const RequestSchema = z.strictObject({
  path: z.string().min(1),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export function requestPath(request: PaginationRequest): string {
  if (
    request.path.startsWith("//") ||
    /[\\\s#]/.test(request.path) ||
    !(request.path.startsWith("/") || /^https?:\/\//.test(request.path))
  ) {
    throw new Error("Pagination requires a relative provider path or an absolute HTTP URL");
  }

  const url = new URL(request.path, "https://provider.invalid");

  for (const [key, value] of Object.entries(request.query ?? {}))
    url.searchParams.set(key, String(value));

  return request.path.startsWith("/") ? url.pathname + url.search : url.href;
}

export async function* paginate<S extends z.ZodType>(
  fetch: (path: string, init?: SyncFetchInit) => Promise<Response>,
  options: PaginateOptions<S>,
): AsyncGenerator<PaginationPage<z.output<S>>> {
  let request: PaginationRequest | undefined = options.request;
  const seen = new Set<string>();

  for (let index = 0; request !== undefined; index++) {
    if (index >= 10_000) throw new Error("Pagination exceeded 10000 pages");

    RequestSchema.parse(request);

    const path = requestPath(request);
    const identity = JSON.stringify([path, Object.entries(request.headers ?? {}).sort()]);

    if (seen.has(identity)) throw new Error("Provider repeated a pagination request");

    seen.add(identity);

    const response = await fetch(path, {
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const page: PaginationPage<z.output<S>> = {
      data: await parseResponse(response, options.schema),
      request,
      index,
      response: { status: response.status, headers: Object.fromEntries(response.headers) },
    };

    yield page;
    request = options.next(page);
  }
}

export const OriginSchema = z.union([
  z.string(),
  z.strictObject({ type: z.literal("input"), input: z.string().min(1) }),
  z.strictObject({
    type: z.literal("environment"),
    input: z.string().min(1),
    values: z.record(z.string(), z.string()),
  }),
  z.strictObject({ type: z.literal("oauth"), oauthTokenField: z.string().min(1) }),
]);

export function providerOrigin(value: string, authenticated = false): URL {
  const origin = new URL(value);

  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Provider origin must use HTTP or HTTPS");
  }

  if (origin.username || origin.password) {
    throw new Error("Provider origin cannot contain credentials");
  }

  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Provider origin cannot contain a path, query, or fragment");
  }

  if (
    authenticated &&
    origin.protocol !== "https:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "[::1]" &&
    !/^127(?:\.\d{1,3}){3}$/.test(origin.hostname)
  ) {
    throw new Error("Authenticated provider origins must use HTTPS or loopback HTTP");
  }

  return origin;
}

export type ResolvedRetry = Required<RetryPolicy>;

const DefaultRetry: ResolvedRetry = {
  maxAttempts: 3,
  statuses: [408, 429, 500, 502, 503, 504],
  methods: ["GET", "HEAD", "OPTIONS"],
  initialDelayMs: 500,
  maxDelayMs: 30_000,
};

export function resolveRetry(retry: RetryDefinition | undefined): ResolvedRetry {
  const resolved =
    retry === false ? { ...DefaultRetry, maxAttempts: 1 } : { ...DefaultRetry, ...retry };

  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new Error("Retry maxAttempts must be a positive integer");
  }

  if (
    resolved.statuses.length === 0 ||
    resolved.statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
  ) {
    throw new Error("Retry statuses must contain valid HTTP status codes");
  }

  if (resolved.methods.length === 0 || resolved.methods.some((method) => !method.trim())) {
    throw new Error("Retry methods must contain non-empty HTTP methods");
  }

  if (!Number.isFinite(resolved.initialDelayMs) || resolved.initialDelayMs < 0) {
    throw new Error("Retry initialDelayMs must be a non-negative number");
  }

  if (!Number.isFinite(resolved.maxDelayMs) || resolved.maxDelayMs < 0) {
    throw new Error("Retry maxDelayMs must be a non-negative number");
  }

  if (resolved.initialDelayMs > resolved.maxDelayMs) {
    throw new Error("Retry initialDelayMs cannot exceed maxDelayMs");
  }

  return resolved;
}

export function resolveProviderOrigin(
  definition: ProviderOriginDefinition,
  authorizationState?: { readonly tokenFields: Readonly<Record<string, string>> },
  authenticated = false,
  connectionConfig: JsonObject = {},
): URL {
  let value: string;

  if (typeof definition === "string") {
    value = definition;
  } else if ("oauthTokenField" in definition) {
    const tokenField = authorizationState?.tokenFields[definition.oauthTokenField];

    if (tokenField === undefined) {
      throw new Error(
        `OAuth authorization is missing token field ${JSON.stringify(definition.oauthTokenField)}`,
      );
    }

    value = tokenField;
  } else {
    const selected = connectionConfig[definition.input];

    if (
      typeof selected !== "string" ||
      ("values" in definition && definition.values[selected] === undefined)
    ) {
      throw new Error(
        `Connection input ${JSON.stringify(definition.input)} has no provider origin`,
      );
    }

    value = "values" in definition ? definition.values[selected]! : selected;
  }

  return providerOrigin(value, authenticated);
}

export const RetrySchema = z.union([
  z.literal(false),
  z.strictObject({
    maxAttempts: z.number().int().positive().optional(),
    statuses: z.array(z.number().int().min(100).max(599)).min(1).optional(),
    methods: z.array(z.string().min(1)).min(1).optional(),
    initialDelayMs: z.number().nonnegative().optional(),
    maxDelayMs: z.number().nonnegative().optional(),
  }),
]);
