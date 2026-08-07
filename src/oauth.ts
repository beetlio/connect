import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import * as oauth from "oauth4webapi";

import type { AuthDefinition } from "./index.ts";

type OAuthDefinition = Extract<AuthDefinition, { type: "oauth2_authorization_code" }>;

interface OAuthRequestOptions {
  auth: OAuthDefinition;
  credentials: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface OAuthAuthorizationState {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenFields: Readonly<Record<string, string>>;
}

export interface AuthorizeOAuthOptions extends OAuthRequestOptions {
  redirectUri: string;
  onAuthorizationUrl(url: string): void | Promise<void>;
  onAuthorizationCallback?(): string | Promise<string>;
}

export async function authorizeOAuth(
  options: AuthorizeOAuthOptions,
): Promise<OAuthAuthorizationState> {
  const redirect = new URL(options.redirectUri);
  const usesLocalCallback =
    redirect.protocol === "http:" && isLoopback(redirect.hostname) && Boolean(redirect.port);
  if (!usesLocalCallback && redirect.protocol !== "https:") {
    throw new Error("OAuth redirect URIs must use HTTPS or loopback HTTP");
  }

  const { server, client, clientAuth, requestOptions } = oauthContext(options);
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const authorizationUrl = new URL(server.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirect.href);
  authorizationUrl.searchParams.set("scope", options.auth.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const validateCallback = (value: string | URL) => {
    const url = new URL(value);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
      throw new Error("OAuth callback URL does not match the configured redirect URI");
    }
    return oauth.validateAuthResponse(server, client, url, state);
  };

  let callbackParameters: URLSearchParams;
  if (usesLocalCallback) {
    const callbackServer = createServer();
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(
        Number(redirect.port),
        redirect.hostname === "[::1]" ? "::1" : redirect.hostname,
        () => {
          callbackServer.removeListener("error", reject);
          resolve();
        },
      );
    });
    try {
      const callbackPromise = waitForAuthorizationCallback(
        callbackServer,
        redirect,
        validateCallback,
        options.signal,
      );
      await options.onAuthorizationUrl(authorizationUrl.href);
      callbackParameters = await callbackPromise;
    } finally {
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    }
  } else {
    await options.onAuthorizationUrl(authorizationUrl.href);
    if (options.onAuthorizationCallback === undefined) {
      throw new Error("This OAuth redirect requires the callback URL to be supplied");
    }
    callbackParameters = validateCallback(await options.onAuthorizationCallback());
  }

  const response = await oauth.authorizationCodeGrantRequest(
    server,
    client,
    clientAuth,
    callbackParameters,
    redirect.href,
    verifier,
    requestOptions,
  );
  return authorizationState(
    options,
    await oauth.processAuthorizationCodeResponse(server, client, response),
    undefined,
  );
}

export async function refreshOAuthAuthorization(
  options: OAuthRequestOptions & {
    authorizationState: OAuthAuthorizationState;
  },
): Promise<OAuthAuthorizationState> {
  if (options.authorizationState.refreshToken === undefined) {
    throw new Error("OAuth refresh is not configured");
  }
  const { server, client, clientAuth, requestOptions } = oauthContext(options);
  const response = await oauth.refreshTokenGrantRequest(
    server,
    client,
    clientAuth,
    options.authorizationState.refreshToken,
    requestOptions,
  );
  return authorizationState(
    options,
    await oauth.processRefreshTokenResponse(server, client, response),
    options.authorizationState,
  );
}

function authorizationState(
  options: OAuthRequestOptions,
  responseFields: oauth.TokenEndpointResponse,
  previous: OAuthAuthorizationState | undefined,
): OAuthAuthorizationState {
  const tokenFields: Record<string, string> = { ...previous?.tokenFields };
  for (const [field, responseField] of Object.entries(options.auth.tokenFields)) {
    const value = responseFields[responseField];
    if (typeof value === "string" && value) {
      tokenFields[field] = value;
    }
  }
  const refreshToken = responseFields.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: responseFields.access_token,
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    tokenFields,
  };
}

function waitForAuthorizationCallback(
  server: ReturnType<typeof createServer>,
  redirect: URL,
  validate: (url: URL) => URLSearchParams,
  signal: AbortSignal | undefined,
): Promise<URLSearchParams> {
  return new Promise<URLSearchParams>((resolve, reject) => {
    const timeout = setTimeout(
      () => settle(() => reject(new Error("OAuth authorization timed out"))),
      5 * 60_000,
    );
    const abort = () =>
      settle(() => reject(signal?.reason ?? new Error("OAuth authorization aborted")));
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
      try {
        const parameters = validate(url);
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Connected. You can close this browser tab.");
        settle(() => resolve(parameters));
      } catch (error) {
        response.statusCode = 400;
        response.end("OAuth authorization failed. Return to the terminal.");
        settle(() => reject(error));
      }
    };
    server.on("request", request);
    if (signal?.aborted) abort();
  });
}

function oauthContext(options: OAuthRequestOptions) {
  const issuer = new URL(options.auth.issuer);
  if (issuer.protocol !== "https:" && !isLoopback(issuer.hostname)) {
    throw new Error("OAuth issuers require HTTPS");
  }
  const authorizationUrl = new URL(options.auth.authorizationUrl);
  if (authorizationUrl.protocol !== "https:" && !isLoopback(authorizationUrl.hostname)) {
    throw new Error("OAuth authorization requests require HTTPS");
  }
  const tokenUrl = new URL(options.auth.tokenUrl);
  const insecureTokenUrl = tokenUrl.protocol === "http:" && isLoopback(tokenUrl.hostname);
  if (tokenUrl.protocol !== "https:" && !insecureTokenUrl) {
    throw new Error("OAuth token requests require HTTPS");
  }
  const server = {
    issuer: options.auth.issuer,
    authorization_endpoint: authorizationUrl.href,
    token_endpoint: tokenUrl.href,
  } satisfies oauth.AuthorizationServer;
  const client: oauth.Client = {
    client_id: credential(options.credentials, "clientId"),
  };
  const clientAuth = !options.auth.usesClientSecret
    ? oauth.None()
    : oauth.ClientSecretPost(credential(options.credentials, "clientSecret"));
  const requestOptions: oauth.TokenEndpointRequestOptions = {
    ...(options.fetch === undefined ? {} : { [oauth.customFetch]: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(insecureTokenUrl ? { [oauth.allowInsecureRequests]: true } : {}),
  };
  return { server, client, clientAuth, requestOptions };
}

function credential(credentials: Readonly<Record<string, string>>, field: string): string {
  const value = credentials[field];
  if (value === undefined) {
    throw new Error(`Missing credential ${JSON.stringify(field)}`);
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
