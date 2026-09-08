import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AuthDefinition,
  JsonObject,
  JsonValue,
  ProviderOriginDefinition,
  SyncMode,
} from "./index.ts";
import { refreshOAuthAuthorization, type OAuthAuthorizationState } from "./oauth.ts";
import {
  resolveRetry,
  providerOrigin,
  type EmittedBatch,
  type LogEntry,
  type ProviderRequest,
  type ProviderResponse,
  type ResolvedRetry,
  type SyncHost,
} from "./host.ts";

const MaxProviderResponseBytes = 16 * 1024 * 1024;

export interface LocalHostOptions {
  origin: ProviderOriginDefinition;
  connectionConfig?: JsonObject;
  auth?: AuthDefinition;
  credentials?: Readonly<Record<string, string>>;
  authorizationState?: OAuthAuthorizationState;
  outputPath: string;
  statePath: string;
  mode?: SyncMode;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onLog?: (entry: LogEntry) => void;
  /** Await permission before exchanging a refresh token. Rejection prevents the exchange. */
  onAuthorizationRefreshRequested?: (signal?: AbortSignal) => void | Promise<void>;
  onAuthorizationStateChanged?: (state: OAuthAuthorizationState) => void | Promise<void>;
}

export class LocalHost implements SyncHost {
  #origin: URL;
  readonly #originDefinition: ProviderOriginDefinition;
  readonly #connectionConfig: JsonObject;
  readonly #auth: AuthDefinition | { readonly type: "none" };
  readonly #credentials: Readonly<Record<string, string>>;
  #authorizationState: OAuthAuthorizationState | undefined;
  #tokenExchangeState: { readonly accessToken: string; readonly expiresAt: number } | undefined;
  #authorizationVersion = 0;
  #refreshing: Promise<boolean> | undefined;
  #exchanging: Promise<boolean> | undefined;
  readonly #outputPath: string;
  readonly #statePath: string;
  readonly #mode: SyncMode;
  #replacePath: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #onLog: (entry: LogEntry) => void;
  readonly #onAuthorizationRefreshRequested: LocalHostOptions["onAuthorizationRefreshRequested"];
  readonly #onAuthorizationStateChanged: (state: OAuthAuthorizationState) => void | Promise<void>;

  constructor(options: LocalHostOptions) {
    this.#originDefinition = options.origin;
    this.#connectionConfig = options.connectionConfig ?? {};
    this.#auth = options.auth ?? { type: "none" };
    this.#credentials = options.credentials ?? {};
    this.#authorizationState = options.authorizationState;
    this.#origin = resolveProviderOrigin(
      this.#originDefinition,
      this.#authorizationState,
      this.#auth.type !== "none",
      this.#connectionConfig,
    );
    this.#outputPath = options.outputPath;
    this.#statePath = options.statePath;
    this.#mode = options.mode ?? "append";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal;
    this.#onLog = options.onLog ?? ((entry) => console.error(JSON.stringify(entry)));
    this.#onAuthorizationRefreshRequested = options.onAuthorizationRefreshRequested;
    this.#onAuthorizationStateChanged = options.onAuthorizationStateChanged ?? (() => undefined);
  }

  async settleAuthentication(): Promise<void> {
    await Promise.allSettled([this.#refreshing, this.#exchanging]);
  }

  async request(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const requestSignal =
      this.#signal && signal ? AbortSignal.any([this.#signal, signal]) : (this.#signal ?? signal);
    const retry = resolveRetry(request.retry);
    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      requestSignal?.throwIfAborted();
      await this.#exchangeToken(requestSignal);
      const authorizationVersion = this.#authorizationVersion;
      const url = new URL(request.path, this.#origin);
      if (url.origin !== this.#origin.origin) {
        throw new Error("Provider request escaped the configured origin");
      }
      const headers = new Headers(
        request.headers.map(([name, value]): [string, string] => [name, value]),
      );
      this.#applyAuthentication(url, headers);
      let response: Response;
      let responseBody: Uint8Array;
      try {
        response = await this.#fetch(url, {
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
        await delay(retryBackoff(attempt, retry), undefined, {
          ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        });
        continue;
      }
      if (
        response.status === 401 &&
        !refreshed &&
        (authorizationVersion !== this.#authorizationVersion ||
          (await this.#refreshAuthentication(requestSignal)))
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

      const waitMs = retryDelay(response.headers, attempt, retry);
      await delay(waitMs, undefined, {
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    }
  }

  async emit(batch: EmittedBatch): Promise<"continue"> {
    const outputPath = this.#replacePath ?? this.#outputPath;
    await mkdir(dirname(outputPath), { recursive: true });
    const file = await open(outputPath, "a", 0o600);
    try {
      const data =
        this.#mode === "merge"
          ? `${JSON.stringify({
              records: batch.records,
              ...(batch.deletedKeys === undefined ? {} : { deletedKeys: batch.deletedKeys }),
            })}\n`
          : batch.records.map((record) => `${JSON.stringify(record)}\n`).join("");
      if (data) {
        await file.writeFile(data);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    if (batch.checkpoint !== undefined) {
      if (this.#replacePath === undefined) await this.#writeCheckpoint(batch.checkpoint);
    }
    return "continue";
  }

  async beginReplace(): Promise<void> {
    if (this.#replacePath !== undefined) return;
    const path = `${this.#outputPath}.tmp-${process.pid}-${randomUUID()}`;
    this.#replacePath = path;
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "wx", 0o600);
      await file.close();
    } catch (error) {
      this.#replacePath = undefined;
      await rm(path, { force: true });
      throw error;
    }
  }

  async commitReplace(): Promise<void> {
    const path = this.#replacePath;
    if (path === undefined) {
      throw new Error("No replace is in progress");
    }
    await rename(path, this.#outputPath);
    this.#replacePath = undefined;
  }

  async abortReplace(): Promise<void> {
    const path = this.#replacePath;
    this.#replacePath = undefined;
    if (path !== undefined) {
      await rm(path, { force: true });
    }
  }

  async log(entry: LogEntry): Promise<void> {
    this.#onLog(entry);
  }

  async loadCheckpoint(): Promise<JsonValue | undefined> {
    try {
      return JSON.parse(await readFile(this.#statePath, "utf8")) as JsonValue;
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  #applyAuthentication(url: URL, headers: Headers): void {
    if (this.#auth.type === "none") {
      return;
    }
    providerOrigin(url.origin, true);
    if (this.#auth.type === "bearer") {
      headers.set("authorization", `Bearer ${this.#credential("token")}`);
      return;
    }
    if (this.#auth.type === "oauth2_authorization_code") {
      const accessToken = this.#authorizationState?.accessToken;
      if (accessToken === undefined) throw new Error("OAuth connection is not authorized");
      headers.set("authorization", `Bearer ${accessToken}`);
      return;
    }
    if (this.#auth.type === "token_exchange") {
      const accessToken = this.#tokenExchangeState?.accessToken;
      if (accessToken === undefined) throw new Error("Authentication token exchange failed");
      headers.set("authorization", `Bearer ${accessToken}`);
      return;
    }
    if (this.#auth.type === "basic") {
      const value = Buffer.from(
        `${this.#credential("username")}:${this.#credential("password")}`,
      ).toString("base64");
      headers.set("authorization", `Basic ${value}`);
      return;
    }
    if (this.#auth.type === "api_key") {
      const apiKey = this.#credential("apiKey");
      if (this.#auth.in === "header") {
        headers.set(this.#auth.name, apiKey);
        return;
      }
      url.searchParams.set(this.#auth.name, apiKey);
      return;
    }
    for (const [name, field] of Object.entries(this.#auth.headers)) {
      headers.set(name, this.#credential(field));
    }
    for (const [name, field] of Object.entries(this.#auth.query)) {
      url.searchParams.set(name, this.#credential(field));
    }
  }

  #credential(name: string): string {
    const value = this.#credentials[name];
    if (value === undefined) {
      throw new Error(`Missing credential ${JSON.stringify(name)}`);
    }
    return value;
  }

  async #refreshAuthentication(waiterSignal: AbortSignal | undefined): Promise<boolean> {
    if (this.#auth.type === "token_exchange") {
      return this.#exchangeToken(waiterSignal, true);
    }
    return this.#refreshOAuth(waiterSignal);
  }

  async #exchangeToken(waiterSignal: AbortSignal | undefined, force = false): Promise<boolean> {
    if (this.#auth.type !== "token_exchange") return false;
    if (
      !force &&
      this.#tokenExchangeState !== undefined &&
      this.#tokenExchangeState.expiresAt > Date.now() + 30_000
    ) {
      return false;
    }
    waiterSignal?.throwIfAborted();
    const exchanging = (this.#exchanging ??= this.#performTokenExchange(this.#signal).finally(
      () => {
        this.#exchanging = undefined;
      },
    ));
    return waitForShared(exchanging, waiterSignal);
  }

  async #performTokenExchange(signal: AbortSignal | undefined): Promise<boolean> {
    if (this.#auth.type !== "token_exchange") return false;
    const url = new URL(this.#auth.tokenUrl, this.#origin);
    if (url.origin !== this.#origin.origin) {
      throw new Error("Token exchange escaped the configured provider origin");
    }
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    for (const [name, field] of Object.entries(this.#auth.headers)) {
      headers.set(name, this.#credential(field));
    }
    const response = await this.#fetch(url, {
      method: "POST",
      headers,
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      const detail = new TextDecoder()
        .decode(responseBody)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1_000);
      throw new Error(
        `Token exchange failed with ${response.status}${detail ? ` (${detail})` : ""}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(responseBody)) as unknown;
    } catch (error) {
      throw new Error("Token exchange returned invalid JSON", { cause: error });
    }
    const accessToken = valueAtPath(body, this.#auth.tokenPath);
    const expiresAtValue = valueAtPath(body, this.#auth.expiresAtPath);
    const expiresAt = typeof expiresAtValue === "string" ? Date.parse(expiresAtValue) : NaN;
    if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiresAt)) {
      throw new Error("Token exchange response is missing a valid token or expiration time");
    }
    if (expiresAt <= Date.now()) {
      throw new Error("Token exchange returned an expired token");
    }
    this.#tokenExchangeState = { accessToken, expiresAt };
    this.#authorizationVersion += 1;
    return true;
  }

  async #refreshOAuth(waiterSignal: AbortSignal | undefined): Promise<boolean> {
    if (
      this.#auth.type !== "oauth2_authorization_code" ||
      this.#authorizationState?.refreshToken === undefined
    ) {
      return false;
    }
    waiterSignal?.throwIfAborted();
    const refreshing = (this.#refreshing ??= this.#performOAuthRefresh(this.#signal).finally(() => {
      this.#refreshing = undefined;
    }));
    return waitForShared(refreshing, waiterSignal);
  }

  async #performOAuthRefresh(signal: AbortSignal | undefined): Promise<boolean> {
    if (this.#auth.type !== "oauth2_authorization_code" || !this.#authorizationState) {
      return false;
    }
    signal?.throwIfAborted();
    await this.#onAuthorizationRefreshRequested?.(signal);
    signal?.throwIfAborted();
    const authorizationState = await refreshOAuthAuthorization({
      auth: this.#auth,
      credentials: this.#credentials,
      authorizationState: this.#authorizationState,
      fetch: this.#fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    const origin = resolveProviderOrigin(
      this.#originDefinition,
      authorizationState,
      true,
      this.#connectionConfig,
    );
    await this.#onAuthorizationStateChanged(authorizationState);
    this.#authorizationState = authorizationState;
    this.#origin = origin;
    this.#authorizationVersion += 1;
    return true;
  }

  async #writeCheckpoint(checkpoint: JsonValue): Promise<void> {
    await replacePrivateFile(this.#statePath, `${JSON.stringify(checkpoint)}\n`);
  }
}

export function resolveProviderOrigin(
  definition: ProviderOriginDefinition,
  authorizationState?: OAuthAuthorizationState,
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
    if (typeof selected !== "string" || definition.values[selected] === undefined) {
      throw new Error(
        `Connection input ${JSON.stringify(definition.input)} has no provider origin`,
      );
    }
    value = definition.values[selected];
  }
  return providerOrigin(value, authenticated);
}

export async function replacePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

class ResponseTooLargeError extends Error {}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function retryDelay(headers: Headers, attempt: number, retry: ResolvedRetry): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, retry.maxDelayMs);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), retry.maxDelayMs);
    }
  }
  return retryBackoff(attempt, retry);
}

function retryBackoff(attempt: number, retry: ResolvedRetry): number {
  return Math.min(retry.initialDelayMs * 2 ** Math.max(0, attempt - 1), retry.maxDelayMs);
}
