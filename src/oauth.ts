import * as oauth from "oauth4webapi";
import { z } from "zod";

import { resolveProviderOrigin } from "./http.ts";
import type { AuthDefinition, ConnectionDefinition } from "./index.ts";

export type OAuthDefinition = Extract<AuthDefinition, { type: "oauth2_authorization_code" }>;

export interface OAuthRequestOptions {
  readonly auth: OAuthDefinition;
  readonly origin?: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface OAuthAuthorizationState {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenFields: Readonly<Record<string, string>>;
}

export interface OAuthAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

/** Resolve connection-dependent endpoints once for an authorization attempt. */
export async function prepareOAuthAuthorization(
  connection: ConnectionDefinition,
  options: {
    readonly connectionConfig?: unknown;
    readonly credentials: unknown;
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
  },
): Promise<OAuthRequestOptions> {
  const auth = connection.auth;

  if (auth?.type !== "oauth2_authorization_code") {
    throw new Error("Integration does not use OAuth authorization code authentication");
  }

  const credentials = z
    .record(z.string(), z.string())
    .parse(await auth.credentials.parseAsync(options.credentials));
  const origin = await resolveOAuthOrigin(connection, options.connectionConfig);

  return {
    auth,
    credentials,
    ...(origin === undefined ? {} : { origin }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export async function beginOAuthAuthorization(
  options: OAuthRequestOptions & { redirectUri: string },
): Promise<OAuthAuthorizationRequest> {
  const redirect = oauthRedirect(options.redirectUri);
  const { server, client } = oauthContext(options);
  const state = oauth.generateRandomState();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const authorizationUrl = new URL(server.authorization_endpoint);

  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirect.href);
  authorizationUrl.searchParams.set("scope", options.auth.scopes.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return { authorizationUrl: authorizationUrl.href, state, codeVerifier };
}

export async function completeOAuthAuthorization(
  options: OAuthRequestOptions & {
    readonly redirectUri: string;
    callbackUrl: string;
    state: string;
    codeVerifier: string;
  },
): Promise<OAuthAuthorizationState> {
  const redirect = oauthRedirect(options.redirectUri);
  const callback = new URL(options.callbackUrl);

  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) {
    throw new Error("OAuth callback URL does not match the configured redirect URI");
  }

  const { server, client, clientAuth, requestOptions } = oauthContext(options);
  const callbackParameters = oauth.validateAuthResponse(server, client, callback, options.state);
  const response = await oauth.authorizationCodeGrantRequest(
    server,
    client,
    clientAuth,
    callbackParameters,
    redirect.href,
    options.codeVerifier,
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

function oauthRedirect(value: string): URL {
  const redirect = new URL(value);
  const loopback = redirect.protocol === "http:" && isLoopback(redirect.hostname);

  if (redirect.protocol !== "https:" && !loopback) {
    throw new Error("OAuth redirect URIs must use HTTPS or loopback HTTP");
  }

  return redirect;
}

function oauthContext(options: OAuthRequestOptions) {
  const resolve = (value: string) => {
    if (value.startsWith("//") || value.includes("\\") || /[\x00-\x20\x7f]/.test(value))
      throw new Error("Invalid OAuth URL");

    const url = new URL(value, options.origin);

    if (url.username || url.password || url.hash) throw new Error("Invalid OAuth URL");

    return url;
  };
  const issuer = resolve(options.auth.issuer);

  if (
    issuer.protocol !== "https:" &&
    !(issuer.protocol === "http:" && isLoopback(issuer.hostname))
  ) {
    throw new Error("OAuth issuers require HTTPS");
  }

  const authorizationUrl = resolve(options.auth.authorizationUrl);

  if (
    authorizationUrl.protocol !== "https:" &&
    !(authorizationUrl.protocol === "http:" && isLoopback(authorizationUrl.hostname))
  ) {
    throw new Error("OAuth authorization requests require HTTPS");
  }

  const tokenUrl = resolve(options.auth.tokenUrl);
  const insecureTokenUrl = tokenUrl.protocol === "http:" && isLoopback(tokenUrl.hostname);

  if (tokenUrl.protocol !== "https:" && !insecureTokenUrl) {
    throw new Error("OAuth token requests require HTTPS");
  }

  const server = {
    issuer: options.auth.issuer.startsWith("/") ? issuer.href : options.auth.issuer,
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

export const OAuthAuthorizationStateSchema = z
  .strictObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullish(),
    tokenFields: z.record(z.string(), z.string()),
  })
  .transform(({ accessToken, refreshToken, tokenFields }): OAuthAuthorizationState => ({
    accessToken,
    ...(refreshToken == null ? {} : { refreshToken }),
    tokenFields,
  }));

// Absolute endpoints need no connection configuration.
async function resolveOAuthOrigin(
  connection: ConnectionDefinition,
  connectionConfig: unknown = {},
): Promise<string | undefined> {
  const auth = connection.auth;

  if (
    auth?.type !== "oauth2_authorization_code" ||
    ![auth.issuer, auth.authorizationUrl, auth.tokenUrl].some((url) => url.startsWith("/"))
  ) {
    return undefined;
  }

  if (typeof connection.origin !== "string" && "oauthTokenField" in connection.origin) {
    throw new Error("Relative OAuth URLs require an origin available before authorization");
  }

  const config =
    typeof connection.origin !== "string" && connection.inputs !== undefined
      ? await connection.inputs.parseAsync(connectionConfig)
      : connectionConfig;

  return resolveProviderOrigin(
    connection.origin,
    undefined,
    true,
    z.record(z.string(), z.json()).parse(config),
  ).origin;
}
