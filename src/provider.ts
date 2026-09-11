import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseToken, resolveFields, type AuthDefinition } from "./auth.ts";
import type { ProviderRequest, ProviderResponse } from "./host.ts";
import {
  OriginSchema,
  providerOrigin,
  resolveProviderOrigin,
  resolveRetry,
  type ResolvedRetry,
} from "./http.ts";
import type { ConnectionDefinition } from "./index.ts";
import {
  OAuthAuthorizationStateSchema,
  refreshOAuthAuthorization,
  type OAuthAuthorizationState,
} from "./oauth.ts";

const MaxProviderResponseBytes = 16 * 1024 * 1024;

export interface ProviderOptions {
  readonly connectionConfig?: unknown;
  readonly credentials?: unknown;
  readonly authorizationState?: OAuthAuthorizationState;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: typeof delay;
  readonly onAuthorizationRefreshRequested?: (signal?: AbortSignal) => void | Promise<void>;
  readonly onAuthorizationStateChanged?: (state: OAuthAuthorizationState) => void | Promise<void>;
}

/** Stateful HTTP resource; provider decisions and filesystem storage live elsewhere. */
export function createProvider(connection: ConnectionDefinition, options: ProviderOptions = {}) {
  const authentication = connection.auth ?? ({ type: "none" } as const);
  const credentials = z
    .record(z.string(), z.string())
    .parse((connection.auth?.credentials ?? z.strictObject({})).parse(options.credentials ?? {}));
  const connectionConfig = z
    .record(z.string(), z.json())
    .parse((connection.inputs ?? z.strictObject({})).parse(options.connectionConfig ?? {}));
  const originDefinition = OriginSchema.parse(connection.origin);
  let currentAuthorization =
    options.authorizationState === undefined
      ? undefined
      : OAuthAuthorizationStateSchema.parse(options.authorizationState);
  let origin = resolveProviderOrigin(
    originDefinition,
    currentAuthorization,
    authentication.type !== "none",
    connectionConfig,
  );
  let token: { readonly accessToken: string; readonly expiresAt: number } | undefined;
  let version = 0;
  let renewing: Promise<boolean> | undefined;
  let failure: { readonly error: unknown } | undefined;
  const transport = options.fetch ?? globalThis.fetch;
  const hostSignal = options.signal;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const beforeRefresh = options.onAuthorizationRefreshRequested;
  const persist = options.onAuthorizationStateChanged ?? (() => undefined);
  const recordFailure = (error: unknown): never => {
    failure = { error };

    throw error;
  };

  return {
    request,
    async settleAuthentication() {
      await Promise.allSettled([renewing]);

      if (failure) throw failure.error;
    },
  };

  async function request(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const requestSignal =
      hostSignal && signal ? AbortSignal.any([hostSignal, signal]) : (hostSignal ?? signal);
    const retry = resolveRetry(request.retry ?? connection.retry);
    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      requestSignal?.throwIfAborted();
      await exchangeToken(requestSignal);

      const authorizationVersion = version;
      const url = new URL(request.path, origin);

      if (url.origin !== origin.origin) {
        throw new Error("Provider request escaped the configured origin");
      }

      const headers = new Headers(
        request.headers.map(([name, value]): [string, string] => [name, value]),
      );

      applyAuthentication(url, headers);

      let response: Response;
      let responseBody: Uint8Array;

      try {
        response = await transport(url, {
          method: request.method,
          headers,
          redirect: "manual",
          ...(requestSignal === undefined ? {} : { signal: requestSignal }),
          ...(request.body === undefined ? {} : { body: Uint8Array.from(request.body).buffer }),
        });
        responseBody = await readResponseBody(response);
      } catch (error) {
        if (
          error instanceof ResponseTooLargeError ||
          requestSignal?.aborted ||
          !canRetry(request.method, attempt, retry)
        ) {
          throw error;
        }

        await sleep(retryBackoff(attempt, retry), undefined, {
          ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        });

        continue;
      }

      if (
        response.status === 401 &&
        !refreshed &&
        (authorizationVersion !== version || (await refreshAuthentication(requestSignal)))
      ) {
        refreshed = true;
        attempt -= 1;

        continue;
      }

      if (!shouldRetry(request.method, response.status, attempt, retry)) {
        return {
          status: response.status,
          headers: [...response.headers.entries()],
          body: responseBody,
        };
      }

      const waitMs = retryDelay(response.headers, attempt, retry, now());

      await sleep(waitMs, undefined, {
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    }
  }

  function applyAuthentication(url: URL, headers: Headers): void {
    if (authentication.type === "none") {
      return;
    }

    providerOrigin(url.origin, true);

    if (authentication.type === "bearer") {
      headers.set("authorization", `Bearer ${credential("token")}`);

      return;
    }

    if (authentication.type === "oauth2_authorization_code") {
      const accessToken = currentAuthorization?.accessToken;

      if (accessToken === undefined) throw new Error("OAuth connection is not authorized");

      headers.set("authorization", `Bearer ${accessToken}`);

      return;
    }

    if (authentication.type === "token_exchange") {
      const accessToken = token?.accessToken;

      if (accessToken === undefined) throw new Error("Authentication token exchange failed");

      for (const [name, value] of Object.entries(
        resolveFields(authentication.session?.headers, credentials),
      )) {
        headers.set(name, value);
      }

      headers.set(
        authentication.session?.header ?? "authorization",
        `${authentication.session?.prefix ?? "Bearer "}${accessToken}`,
      );

      return;
    }

    if (authentication.type === "basic") {
      const value = Buffer.from(`${credential("username")}:${credential("password")}`).toString(
        "base64",
      );

      headers.set("authorization", `Basic ${value}`);

      return;
    }

    if (authentication.type === "api_key") {
      const apiKey = credential("apiKey");

      if (authentication.in === "header") {
        headers.set(authentication.name, apiKey);

        return;
      }

      url.searchParams.set(authentication.name, apiKey);

      return;
    }

    for (const [name, value] of Object.entries(
      resolveFields(authentication.headers, credentials),
    )) {
      headers.set(name, value);
    }

    for (const [name, value] of Object.entries(resolveFields(authentication.query, credentials))) {
      url.searchParams.set(name, value);
    }
  }

  function credential(name: string): string {
    const value = credentials[name];

    if (value === undefined) {
      throw new Error(`Missing credential ${JSON.stringify(name)}`);
    }

    return value;
  }

  async function refreshAuthentication(waiterSignal: AbortSignal | undefined): Promise<boolean> {
    if (authentication.type === "token_exchange") {
      return exchangeToken(waiterSignal, true);
    }

    return refreshOAuth(waiterSignal);
  }

  async function exchangeToken(
    waiterSignal: AbortSignal | undefined,
    force = false,
  ): Promise<boolean> {
    if (authentication.type !== "token_exchange") return false;

    if (!force && token !== undefined && token.expiresAt > now() + 30_000) {
      return false;
    }

    waiterSignal?.throwIfAborted();

    const exchanging = (renewing ??= performTokenExchange(hostSignal)
      .catch(recordFailure)
      .finally(() => {
        renewing = undefined;
      }));

    return waitForShared(exchanging, waiterSignal);
  }

  async function performTokenExchange(signal: AbortSignal | undefined): Promise<boolean> {
    if (authentication.type !== "token_exchange") return false;

    const url = new URL(authentication.request.path, origin);

    if (url.origin !== origin.origin) {
      throw new Error("Token exchange escaped the configured provider origin");
    }

    const { headers, body: requestBody } = exchangeRequest(authentication, credentials);
    const response = await transport(url, {
      method: "POST",
      headers,
      redirect: "manual",
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(signal === undefined ? {} : { signal }),
    });
    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new Error(`Token exchange failed with ${response.status}`);
    }

    let body: unknown;

    try {
      body = JSON.parse(new TextDecoder().decode(responseBody)) as unknown;
    } catch (error) {
      throw new Error("Token exchange returned invalid JSON", { cause: error });
    }

    token = parseToken(body, authentication.response, now());
    version += 1;
    failure = undefined;

    return true;
  }

  async function refreshOAuth(waiterSignal: AbortSignal | undefined): Promise<boolean> {
    if (
      authentication.type !== "oauth2_authorization_code" ||
      currentAuthorization?.refreshToken === undefined
    ) {
      return false;
    }

    waiterSignal?.throwIfAborted();

    const refreshing = (renewing ??= performOAuthRefresh(hostSignal)
      .catch(recordFailure)
      .finally(() => {
        renewing = undefined;
      }));

    return waitForShared(refreshing, waiterSignal);
  }

  async function performOAuthRefresh(signal: AbortSignal | undefined): Promise<boolean> {
    if (authentication.type !== "oauth2_authorization_code" || !currentAuthorization) {
      return false;
    }

    signal?.throwIfAborted();
    await beforeRefresh?.(signal);
    signal?.throwIfAborted();

    const authorizationState = await refreshOAuthAuthorization({
      auth: authentication,
      origin: origin.origin,
      credentials: credentials,
      authorizationState: currentAuthorization,
      fetch: transport,
      ...(signal === undefined ? {} : { signal }),
    });
    const refreshedOrigin = resolveProviderOrigin(
      originDefinition,
      authorizationState,
      true,
      connectionConfig,
    );

    await persist(authorizationState);
    currentAuthorization = authorizationState;
    origin = refreshedOrigin;
    version += 1;
    failure = undefined;

    return true;
  }
}

/** Internal adapter lifecycle: settle once and retain both execution and renewal failures. */
export async function withAuthenticationSettlement<T>(
  provider: Pick<ReturnType<typeof createProvider>, "settleAuthentication">,
  execute: () => Promise<T>,
): Promise<T> {
  let result: T;

  try {
    result = await execute();
  } catch (error) {
    try {
      await provider.settleAuthentication();
    } catch (settlementError) {
      if (settlementError !== error) {
        throw new AggregateError(
          [error, settlementError],
          "Execution and authentication settlement failed",
        );
      }
    }

    throw error;
  }

  await provider.settleAuthentication();

  return result;
}

function exchangeRequest(
  auth: Extract<AuthDefinition, { type: "token_exchange" }>,
  credentials: Readonly<Record<string, string>>,
) {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });

  for (const [name, value] of Object.entries(resolveFields(auth.request.headers, credentials))) {
    headers.set(name, value);
  }

  if (auth.request.basic) {
    const component = (key: string) =>
      new URLSearchParams({ value: z.string().parse(credentials[key]) }).toString().slice(6);

    headers.set(
      "authorization",
      `Basic ${Buffer.from(`${component(auth.request.basic.username)}:${component(auth.request.basic.password)}`).toString("base64")}`,
    );
  }

  const payload = auth.request.body;

  if (!payload) return { headers, body: undefined };

  const values = resolveFields(payload.fields, credentials);

  headers.set(
    "content-type",
    payload.encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
  );

  return {
    headers,
    body:
      payload.encoding === "form" ? new URLSearchParams(values).toString() : JSON.stringify(values),
  };
}

class ResponseTooLargeError extends Error {}

function waitForShared<Value>(
  promise: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) return promise;

  return new Promise<Value>((resolve, reject) => {
    const settle = (action: () => void) => {
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => settle(() => reject(signal.reason));

    signal.addEventListener("abort", abort, { once: true });

    if (signal.aborted) abort();

    void promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();

  const declaredLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > MaxProviderResponseBytes) {
    throw new ResponseTooLargeError("Provider response exceeds 16 MiB");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of response.body) {
    length += chunk.byteLength;

    if (length > MaxProviderResponseBytes) {
      throw new ResponseTooLargeError("Provider response exceeds 16 MiB");
    }

    chunks.push(chunk);
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function shouldRetry(
  method: string,
  status: number,
  attempt: number,
  retry: ResolvedRetry,
): boolean {
  return canRetry(method, attempt, retry) && retry.statuses.includes(status);
}

function canRetry(method: string, attempt: number, retry: ResolvedRetry): boolean {
  return (
    attempt < retry.maxAttempts &&
    retry.methods.some((candidate) => candidate.toUpperCase() === method.toUpperCase())
  );
}

function retryDelay(headers: Headers, attempt: number, retry: ResolvedRetry, now: number): number {
  const retryAfter = headers.get("retry-after");

  if (retryAfter !== null) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, retry.maxDelayMs);
    }

    const date = Date.parse(retryAfter);

    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - now), retry.maxDelayMs);
    }
  }

  return retryBackoff(attempt, retry);
}

function retryBackoff(attempt: number, retry: ResolvedRetry): number {
  return Math.min(retry.initialDelayMs * 2 ** Math.max(0, attempt - 1), retry.maxDelayMs);
}
