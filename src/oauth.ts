import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { AuthDefinition, CredentialSchema } from "./index.ts";

type OAuthDefinition = Extract<
  AuthDefinition,
  { type: "oauth2_authorization_code" }
>;

interface OAuthRequestOptions {
  auth: OAuthDefinition;
  integrationCredentials: Readonly<Record<string, string>>;
  credentialSchema: CredentialSchema;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface AuthorizeOAuthOptions extends OAuthRequestOptions {
  redirectUri: string;
  onAuthorizationUrl(url: string): void | Promise<void>;
  onAuthorizationCallback?(): string | Promise<string>;
}

export interface AuthorizeOAuthDeviceOptions extends OAuthRequestOptions {
  redirectUri?: string;
  onVerification(value: {
    verificationUri: string;
    userCode: string;
  }): void | Promise<void>;
}

export async function authorizeOAuth(
  options: AuthorizeOAuthOptions,
): Promise<Readonly<Record<string, string>>> {
  const redirect = new URL(options.redirectUri);
  const usesLocalCallback = redirect.protocol === "http:" &&
    isLoopback(redirect.hostname) && Boolean(redirect.port);
  if (!usesLocalCallback && redirect.protocol !== "https:") {
    throw new Error("OAuth redirect URIs must use HTTPS or loopback HTTP");
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(options.auth.authorizationUrl);
  if (
    authorizationUrl.protocol !== "https:" &&
    !isLoopback(authorizationUrl.hostname)
  ) {
    throw new Error("OAuth authorization requests require HTTPS");
  }
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "client_id",
    credential(options.integrationCredentials, options.auth.clientId),
  );
  authorizationUrl.searchParams.set("redirect_uri", redirect.href);
  authorizationUrl.searchParams.set("scope", options.auth.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  let code: string;
  if (usesLocalCallback) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port), redirect.hostname, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const codePromise = waitForAuthorizationCode(
        server,
        redirect,
        state,
        options.signal,
      );
      await options.onAuthorizationUrl(authorizationUrl.href);
      code = await codePromise;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } else {
    await options.onAuthorizationUrl(authorizationUrl.href);
    if (options.onAuthorizationCallback === undefined) {
      throw new Error("This OAuth redirect requires the callback URL to be supplied");
    }
    code = parseAuthorizationCallback(
      await options.onAuthorizationCallback(),
      redirect,
      state,
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: credential(options.integrationCredentials, options.auth.clientId),
    redirect_uri: redirect.href,
    code_verifier: verifier,
  });
  addClientSecret(body, options.auth, options.integrationCredentials);
  return exchangeToken(options, body, {});
}

export async function authorizeOAuthDevice(
  options: AuthorizeOAuthDeviceOptions,
): Promise<Readonly<Record<string, string>>> {
  const body = new URLSearchParams({
    response_type: "device_code",
    client_id: credential(options.integrationCredentials, options.auth.clientId),
    scope: options.auth.scopes.join(" "),
  });
  if (options.redirectUri !== undefined) {
    body.set("redirect_uri", options.redirectUri);
  }

  const authorizationResponse = await requestToken(options, body);
  const authorizationText = await authorizationResponse.text();
  if (!authorizationResponse.ok) {
    throw new Error(
      `OAuth device authorization returned ${authorizationResponse.status}: ${authorizationText}`,
    );
  }
  const authorization = parseOAuthResponse(authorizationText);
  const deviceCode = responseCredential(authorization, "device_code");
  const userCode = responseCredential(authorization, "user_code");
  const verificationUri = responseCredential(authorization, "verification_uri");
  let intervalSeconds = nonnegativeNumber(authorization.interval) ?? 5;
  const expiresInSeconds = nonnegativeNumber(authorization.expires_in) ?? 10 * 60;

  await options.onVerification({ verificationUri, userCode });
  const deadline = Date.now() + expiresInSeconds * 1_000;
  while (Date.now() < deadline) {
    await delay(intervalSeconds * 1_000, undefined, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const response = await requestToken(options, new URLSearchParams({
      grant_type: "device",
      client_id: credential(options.integrationCredentials, options.auth.clientId),
      code: deviceCode,
    }));
    const text = await response.text();
    if (response.ok) {
      return tokenCredentials(options, text, {});
    }

    const error = oauthError(text);
    if (error === "authorization_pending") {
      continue;
    }
    if (error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    throw new Error(`OAuth token endpoint returned ${response.status}: ${text}`);
  }
  throw new Error("OAuth device authorization timed out");
}

export async function refreshOAuthCredentials(
  options: OAuthRequestOptions & {
    credentials: Readonly<Record<string, string>>;
  },
): Promise<Readonly<Record<string, string>>> {
  if (options.auth.refreshToken === undefined) {
    throw new Error("OAuth refresh is not configured");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential(options.credentials, options.auth.refreshToken),
    client_id: credential(options.integrationCredentials, options.auth.clientId),
  });
  addClientSecret(body, options.auth, options.integrationCredentials);
  return exchangeToken(options, body, options.credentials);
}

async function exchangeToken(
  options: OAuthRequestOptions,
  body: URLSearchParams,
  previous: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  const response = await requestToken(options, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth token endpoint returned ${response.status}: ${text}`);
  }
  return tokenCredentials(options, text, previous);
}

async function requestToken(
  options: OAuthRequestOptions,
  body: URLSearchParams,
): Promise<Response> {
  const tokenUrl = new URL(options.auth.tokenUrl);
  if (tokenUrl.protocol !== "https:" && !isLoopback(tokenUrl.hostname)) {
    throw new Error("OAuth token requests require HTTPS");
  }
  return await (options.fetch ?? globalThis.fetch)(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function tokenCredentials(
  options: OAuthRequestOptions,
  text: string,
  previous: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const responseFields = parseOAuthResponse(text);
  const credentials: Record<string, string> = { ...previous };
  credentials[options.auth.accessToken] = responseCredential(
    responseFields,
    "access_token",
  );
  if (options.auth.refreshToken !== undefined) {
    const refreshToken = responseFields.refresh_token;
    if (typeof refreshToken === "string" && refreshToken) {
      credentials[options.auth.refreshToken] = refreshToken;
    }
  }
  for (const [field, responseField] of Object.entries(options.auth.tokenFields)) {
    const value = responseFields[responseField];
    if (typeof value === "string" && value) {
      credentials[field] = value;
    }
  }

  const result = options.credentialSchema.safeParse(credentials);
  if (!result.success) {
    throw new Error(`Invalid OAuth credentials: ${z.prettifyError(result.error)}`);
  }
  return Object.fromEntries(
    Object.entries(result.data).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function parseOAuthResponse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("OAuth token endpoint returned invalid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("OAuth token endpoint returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function oauthError(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && "error" in value &&
        typeof value.error === "string"
      ? value.error
      : undefined;
  } catch {
    return undefined;
  }
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function waitForAuthorizationCode(
  server: ReturnType<typeof createServer>,
  redirect: URL,
  state: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => settle(() => reject(new Error("OAuth authorization timed out"))),
      5 * 60_000,
    );
    const abort = () => settle(() =>
      reject(signal?.reason ?? new Error("OAuth authorization aborted"))
    );
    signal?.addEventListener("abort", abort, { once: true });

    const settle = (action: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      server.removeListener("request", request);
      action();
    };
    const request = (incoming: IncomingMessage, response: ServerResponse) => {
      const url = new URL(incoming.url ?? "/", redirect.origin);
      if (url.pathname !== redirect.pathname) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400;
        response.end("Invalid OAuth state");
        return;
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        const description = url.searchParams.get("error_description");
        response.statusCode = 400;
        response.end("OAuth authorization failed. Return to the terminal.");
        settle(() => reject(new Error(
          `OAuth authorization failed: ${description ?? error}`,
        )));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.statusCode = 400;
        response.end("Missing authorization code");
        return;
      }
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Connected. You can close this browser tab.");
      settle(() => resolve(code));
    };
    server.on("request", request);
  });
}

function parseAuthorizationCallback(
  value: string,
  redirect: URL,
  state: string,
): string {
  const url = new URL(value);
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
    throw new Error("OAuth callback URL does not match the configured redirect URI");
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error("Invalid OAuth state");
  }
  const error = url.searchParams.get("error");
  if (error !== null) {
    throw new Error(
      `OAuth authorization failed: ${url.searchParams.get("error_description") ?? error}`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("OAuth callback is missing the authorization code");
  }
  return code;
}

function addClientSecret(
  body: URLSearchParams,
  auth: OAuthDefinition,
  integrationCredentials: Readonly<Record<string, string>>,
): void {
  if (auth.clientSecret !== undefined) {
    body.set("client_secret", credential(integrationCredentials, auth.clientSecret));
  }
}

function credential(
  credentials: Readonly<Record<string, string>>,
  field: string,
): string {
  const value = credentials[field];
  if (value === undefined) {
    throw new Error(`Missing credential ${JSON.stringify(field)}`);
  }
  return value;
}

function responseCredential(
  response: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = response[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`OAuth token response is missing ${JSON.stringify(field)}`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
