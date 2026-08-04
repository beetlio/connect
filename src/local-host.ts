import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type {
  AuthDefinition,
  BaseUrlDefinition,
  CredentialSchema,
  JsonValue,
  RetryDefinition,
  RetryPolicy,
} from "./index.ts";
import { refreshOAuthCredentials } from "./oauth.ts";
import type {
  EmittedBatch,
  LogEntry,
  ProviderRequest,
  ProviderResponse,
  SyncHost,
} from "./host.ts";

export interface LocalHostOptions {
  baseUrl: BaseUrlDefinition;
  auth?: AuthDefinition;
  integrationCredentialSchema?: CredentialSchema;
  integrationCredentials?: unknown;
  credentialSchema?: CredentialSchema;
  credentials?: unknown;
  outputPath: string;
  statePath: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onLog?: (entry: LogEntry) => void;
  onCredentialsChanged?: (
    credentials: Readonly<Record<string, string>>,
  ) => void | Promise<void>;
}

export class LocalHost implements SyncHost {
  #baseUrl: URL;
  readonly #baseUrlDefinition: BaseUrlDefinition;
  readonly #auth: AuthDefinition;
  readonly #integrationCredentials: Readonly<Record<string, string>>;
  readonly #credentialSchema: CredentialSchema | undefined;
  #credentials: Readonly<Record<string, string>>;
  readonly #outputPath: string;
  readonly #statePath: string;
  #snapshotPath: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #onLog: (entry: LogEntry) => void;
  readonly #onCredentialsChanged: (
    credentials: Readonly<Record<string, string>>,
  ) => void | Promise<void>;

  constructor(options: LocalHostOptions) {
    this.#baseUrlDefinition = options.baseUrl;
    this.#auth = options.auth ?? { type: "none" };
    this.#integrationCredentials = parseCredentials(
      options.integrationCredentialSchema,
      options.integrationCredentials,
    );
    this.#credentialSchema = options.credentialSchema;
    this.#credentials = parseCredentials(
      options.credentialSchema,
      options.credentials,
    );
    this.#baseUrl = this.#resolveBaseUrl();
    this.#outputPath = options.outputPath;
    this.#statePath = options.statePath;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal;
    this.#onLog = options.onLog ?? ((entry) => console.error(JSON.stringify(entry)));
    this.#onCredentialsChanged = options.onCredentialsChanged ?? (() => undefined);
  }

  async request(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const requestSignal = this.#signal && signal
      ? AbortSignal.any([this.#signal, signal])
      : this.#signal ?? signal;
    const retry = resolveRetry(request.retry);
    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      requestSignal?.throwIfAborted();
      const url = new URL(request.path, this.#baseUrl);
      if (url.origin !== this.#baseUrl.origin) {
        throw new Error("Provider request escaped the configured origin");
      }
      const headers = new Headers(
        request.headers.map(
          ([name, value]): [string, string] => [name, value],
        ),
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
          ...(request.body === undefined
            ? {}
            : { body: Uint8Array.from(request.body).buffer }),
        });
        responseBody = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (
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
        await this.#refreshOAuth(requestSignal)
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

  async emit(batch: EmittedBatch): Promise<void> {
    const outputPath = this.#snapshotPath ?? this.#outputPath;
    await mkdir(dirname(outputPath), { recursive: true });
    const file = await open(outputPath, "a", 0o600);
    try {
      const data = batch.records.map((record) => `${JSON.stringify(record)}\n`).join("");
      if (data) {
        await file.writeFile(data);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    if (batch.checkpoint !== undefined) {
      await this.#replaceCheckpoint(batch.checkpoint);
    }
  }

  async beginSnapshot(): Promise<void> {
    if (this.#snapshotPath !== undefined) {
      throw new Error("A snapshot is already in progress");
    }
    const path = `${this.#outputPath}.tmp-${process.pid}-${randomUUID()}`;
    this.#snapshotPath = path;
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "wx", 0o600);
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      this.#snapshotPath = undefined;
      await rm(path, { force: true });
      throw error;
    }
  }

  async commitSnapshot(): Promise<void> {
    const path = this.#snapshotPath;
    if (path === undefined) {
      throw new Error("No snapshot is in progress");
    }
    await rename(path, this.#outputPath);
    this.#snapshotPath = undefined;
  }

  async abortSnapshot(): Promise<void> {
    const path = this.#snapshotPath;
    this.#snapshotPath = undefined;
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
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      throw new Error("Authenticated provider requests require HTTPS");
    }
    if (this.#auth.type === "bearer") {
      headers.set("authorization", `Bearer ${this.#credential(this.#auth.credential)}`);
      return;
    }
    if (this.#auth.type === "oauth2_authorization_code") {
      headers.set("authorization", `Bearer ${this.#credential(this.#auth.accessToken)}`);
      return;
    }
    if (this.#auth.type === "basic") {
      const value = Buffer.from(
        `${this.#credential(this.#auth.username)}:${this.#credential(this.#auth.password)}`,
      ).toString("base64");
      headers.set("authorization", `Basic ${value}`);
      return;
    }
    if (this.#auth.type === "api_key") {
      const credential = this.#credential(this.#auth.credential);
      if (this.#auth.in === "header") {
        headers.set(this.#auth.name, credential);
        return;
      }
      url.searchParams.set(this.#auth.name, credential);
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

  async #refreshOAuth(signal: AbortSignal | undefined): Promise<boolean> {
    if (
      this.#auth.type !== "oauth2_authorization_code" ||
      this.#auth.refreshToken === undefined ||
      this.#credentialSchema === undefined
    ) {
      return false;
    }
    this.#credentials = await refreshOAuthCredentials({
      auth: this.#auth,
      integrationCredentials: this.#integrationCredentials,
      credentialSchema: this.#credentialSchema,
      credentials: this.#credentials,
      fetch: this.#fetch,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#baseUrl = this.#resolveBaseUrl();
    await this.#onCredentialsChanged(this.#credentials);
    return true;
  }

  #resolveBaseUrl(): URL {
    const value = typeof this.#baseUrlDefinition === "string"
      ? this.#baseUrlDefinition
      : this.#credential(this.#baseUrlDefinition.credential);
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Connection base URL must use HTTP or HTTPS");
    }
    return url;
  }

  async #replaceCheckpoint(checkpoint: JsonValue): Promise<void> {
    await mkdir(dirname(this.#statePath), { recursive: true });
    const temporaryPath = `${this.#statePath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, {
        mode: 0o600,
      });
      const file = await open(temporaryPath, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.#statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

type ResolvedRetry = Required<RetryPolicy>;

const DefaultRetry: ResolvedRetry = {
  maxAttempts: 3,
  statuses: [408, 429, 500, 502, 503, 504],
  methods: ["GET", "HEAD", "OPTIONS"],
  initialDelayMs: 500,
  maxDelayMs: 30_000,
};

function resolveRetry(retry: RetryDefinition | undefined): ResolvedRetry {
  if (retry === false) {
    return { ...DefaultRetry, maxAttempts: 1 };
  }
  const resolved = { ...DefaultRetry, ...retry };
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new Error("Retry maxAttempts must be a positive integer");
  }
  if (
    !Number.isFinite(resolved.initialDelayMs) ||
    !Number.isFinite(resolved.maxDelayMs) ||
    resolved.initialDelayMs < 0 ||
    resolved.maxDelayMs < resolved.initialDelayMs
  ) {
    throw new Error("Invalid retry delay configuration");
  }
  return resolved;
}

function shouldRetry(
  method: string,
  status: number,
  attempt: number,
  retry: ResolvedRetry,
): boolean {
  return canRetry(method, attempt, retry) &&
    retry.statuses.includes(status);
}

function canRetry(
  method: string,
  attempt: number,
  retry: ResolvedRetry,
): boolean {
  return attempt < retry.maxAttempts &&
    retry.methods.some((candidate) => candidate.toUpperCase() === method.toUpperCase());
}

function retryDelay(
  headers: Headers,
  attempt: number,
  retry: ResolvedRetry,
): number {
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
  return Math.min(
    retry.initialDelayMs * (2 ** Math.max(0, attempt - 1)),
    retry.maxDelayMs,
  );
}

function parseCredentials(
  schema: CredentialSchema | undefined,
  value: unknown,
): Readonly<Record<string, string>> {
  if (!schema) {
    return {};
  }
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new Error(`Invalid credentials: ${z.prettifyError(result.error)}`);
  }
  const credentials: Record<string, string> = {};
  for (const [name, credential] of Object.entries(result.data)) {
    if (credential === undefined) {
      continue;
    }
    if (typeof credential !== "string") {
      throw new Error(`Credential ${JSON.stringify(name)} must be a string`);
    }
    credentials[name] = credential;
  }
  return credentials;
}
