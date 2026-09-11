import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";

import password from "@inquirer/password";
import envPaths from "env-paths";
import { z } from "zod";

import { replacePrivateFile } from "../file-sink.ts";
import { verifyConnection } from "../host.ts";
import { resolveProviderOrigin } from "../http.ts";
import type { IntegrationDefinition, JsonObject } from "../index.ts";
import type { InputObjectSchema, IntegrationManifest } from "../manifest.ts";
import {
  OAuthAuthorizationStateSchema,
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  prepareOAuthAuthorization,
  type OAuthAuthorizationState,
  type OAuthRequestOptions,
} from "../oauth.ts";
import { createProvider, withAuthenticationSettlement } from "../provider.ts";

interface ProfileConfiguration {
  readonly profile: string;
  readonly revision: string;
  readonly connection: string;
  readonly inputs: JsonObject;
}

export const DefaultProfile = "default";
const DefaultConnection = "default";
const LocalOAuthRedirectUri = "http://localhost:53682/oauth/callback";
export const LocalNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const UserConfigDirectory = envPaths("beetl-connect", { suffix: "" }).config;

if (!isAbsolute(UserConfigDirectory)) {
  throw new Error("The operating-system user configuration directory must be absolute");
}

const ProviderFetch = globalThis.fetch.bind(globalThis);
const EmptyInputs = z.strictObject({});
const JsonObjectSchema = z.record(z.string(), z.json());
export const ConfigurationInputsSchema = z.strictObject({
  connection: JsonObjectSchema.optional(),
  sync: JsonObjectSchema.optional(),
});

type ConfigurationInputs = z.output<typeof ConfigurationInputsSchema>;

const CredentialValuesSchema = z.record(z.string(), z.string());
const LocalNameSchema = z.string().regex(LocalNamePattern);
const ProfileSchema = z.strictObject({
  integration: z.string().min(1),
  sync: z.string().min(1),
  connection: LocalNameSchema,
  revision: z.uuid(),
  inputs: JsonObjectSchema.default({}),
});

type Profile = z.output<typeof ProfileSchema>;

const ProviderBindingSchema = z.strictObject({
  origin: z.url({ protocol: /^https?$/ }),
  authentication: z.json(),
});

type ProviderBinding = z.output<typeof ProviderBindingSchema>;

const StoredConnectionSchema = z.strictObject({
  integration: z.string().min(1),
  name: LocalNameSchema,
  revision: z.uuid(),
  provider: ProviderBindingSchema,
  origin: z.url({ protocol: /^https?$/ }).optional(),
  inputs: JsonObjectSchema.default({}),
  credentials: CredentialValuesSchema.default({}),
  authorizationState: OAuthAuthorizationStateSchema.optional(),
});

type StoredConnection = z.output<typeof StoredConnectionSchema>;

export async function resolveProfile(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  syncKey: string,
  requestedProfile: string | undefined,
): Promise<ProfileConfiguration> {
  const profileName = requestedProfile ?? DefaultProfile;
  const path = join(
    UserConfigDirectory,
    "profiles",
    integration.key,
    syncKey,
    `${profileName}.json`,
  );
  let profile = await readProfile(path);

  if (requestedProfile === undefined && profile === undefined) {
    await configureIntegration(integration, manifest, syncKey, profileName);
    profile = await readProfile(path);
  }

  if (profile === undefined) {
    if (requestedProfile !== undefined) {
      throw new Error(
        `Profile ${JSON.stringify(requestedProfile)} does not exist; run configure first`,
      );
    }

    throw new Error(`Profile ${JSON.stringify(profileName)} was not created by configure`);
  }

  if (profile.integration !== integration.key) {
    throw new Error(`Profile belongs to integration ${profile.integration}`);
  }

  if (profile.sync !== syncKey) {
    throw new Error(`Profile belongs to sync ${profile.sync}`);
  }

  return {
    profile: profileName,
    revision: profile.revision,
    connection: profile.connection,
    inputs: profile.inputs,
  };
}

export async function configureIntegration(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  syncKey: string,
  profileName: string,
  requestedConnection?: string,
  origin?: URL,
  requestedInputs?: ConfigurationInputs,
  reauthorize = false,
): Promise<string> {
  const profilePath = join(
    UserConfigDirectory,
    "profiles",
    integration.key,
    syncKey,
    `${profileName}.json`,
  );
  const existingProfile = await readProfile(profilePath);

  if (existingProfile !== undefined && existingProfile.integration !== integration.key) {
    throw new Error(`Profile belongs to integration ${existingProfile.integration}`);
  }

  if (existingProfile !== undefined && existingProfile.sync !== syncKey) {
    throw new Error(`Profile belongs to sync ${existingProfile.sync}`);
  }

  const sync = integration.syncs[syncKey];
  const syncManifest = manifest.syncs.find((candidate) => candidate.key === syncKey);

  if (sync === undefined || syncManifest === undefined) {
    throw new Error(`Unknown sync ${JSON.stringify(syncKey)}`);
  }

  const connectionName = requestedConnection ?? existingProfile?.connection ?? DefaultConnection;
  const connectionPath = join(
    UserConfigDirectory,
    "connections",
    integration.key,
    `${connectionName}.json`,
  );

  return withFileLock(
    `${connectionPath}.lock`,
    `Connection ${JSON.stringify(connectionName)} is already in use`,
    async () => {
      const requestedOrigin =
        origin === undefined ? undefined : resolveProviderOrigin(origin.href).origin;
      const stored = await readConnection(connectionPath, integration.key, connectionName);
      let existingConnection =
        stored !== undefined &&
        connectionMatchesProvider(integration, manifest, stored) &&
        (requestedOrigin === undefined || requestedOrigin === stored.provider.origin)
          ? stored
          : undefined;
      const currentInputs = {
        connection: existingConnection?.inputs ?? {},
        sync: existingProfile?.inputs ?? {},
      };
      const inputs =
        requestedInputs === undefined
          ? Object.keys(manifest.connection.inputs.properties).length === 0 &&
            Object.keys(syncManifest.inputs.properties).length === 0
            ? currentInputs
            : await promptConfigurationInputs(currentInputs)
          : {
              connection: requestedInputs.connection ?? currentInputs.connection,
              sync: requestedInputs.sync ?? currentInputs.sync,
            };
      const parsedConnectionInputs = (integration.connection.inputs ?? EmptyInputs).safeParse(
        inputs.connection,
      );

      if (!parsedConnectionInputs.success) {
        throw new Error(
          `Invalid connection inputs: ${z.prettifyError(parsedConnectionInputs.error)}`,
        );
      }

      const parsedSyncInputs = (sync.inputs ?? EmptyInputs).safeParse(inputs.sync);

      if (!parsedSyncInputs.success) {
        throw new Error(`Invalid sync inputs: ${z.prettifyError(parsedSyncInputs.error)}`);
      }

      if (existingConnection !== undefined) {
        const selectedOrigin = resolveProviderOrigin(
          requestedOrigin ?? existingConnection.origin ?? integration.connection.origin,
          existingConnection.authorizationState,
          integration.connection.auth !== undefined,
          JsonObjectSchema.parse(parsedConnectionInputs.data),
        ).origin;

        if (selectedOrigin !== existingConnection.provider.origin) {
          existingConnection = undefined;
        }
      }

      const credentials =
        existingConnection !== undefined && !reauthorize
          ? existingConnection.credentials
          : await promptCredentials(
              manifest.connection.credentials,
              reauthorize ? {} : (existingConnection?.credentials ?? {}),
            );
      const parsedCredentials = parseCredentials(
        integration.connection.auth?.credentials ?? EmptyInputs,
        credentials,
      );
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Interrupted"));

      process.once("SIGINT", abort);

      try {
        const configuredOrigin = requestedOrigin ?? existingConnection?.origin;
        const authorizationState =
          integration.connection.auth?.type === "oauth2_authorization_code"
            ? existingConnection?.authorizationState !== undefined && !reauthorize
              ? existingConnection.authorizationState
              : await authorizeOAuth({
                  ...(await prepareOAuthAuthorization(
                    {
                      ...integration.connection,
                      ...(configuredOrigin === undefined ? {} : { origin: configuredOrigin }),
                    },
                    {
                      connectionConfig: inputs.connection,
                      credentials: parsedCredentials,
                      fetch: ProviderFetch,
                      signal: controller.signal,
                    },
                  )),
                  redirectUri: LocalOAuthRedirectUri,
                  onAuthorizationUrl: (url) => console.log(`Open this URL to authorize:\n${url}`),
                })
            : undefined;
        const connectionInputs = JsonObjectSchema.parse(parsedConnectionInputs.data);
        const credentialValues = CredentialValuesSchema.parse(parsedCredentials);
        const provider = providerBinding(
          integration,
          manifest,
          configuredOrigin,
          authorizationState,
          connectionInputs,
        );
        const connectionValues = {
          integration: integration.key,
          name: connectionName,
          ...(configuredOrigin === undefined ? {} : { origin: configuredOrigin }),
          inputs: connectionInputs,
          credentials: credentialValues,
          ...(authorizationState === undefined ? {} : { authorizationState }),
          provider,
        };
        let connectionRevision: string = randomUUID();

        if (existingConnection !== undefined && !reauthorize) {
          const { revision, ...existingValues } = existingConnection;

          if (isDeepStrictEqual(existingValues, connectionValues)) connectionRevision = revision;
        }

        let connection = StoredConnectionSchema.parse({
          ...connectionValues,
          revision: connectionRevision,
        });

        if (manifest.connection.canVerify) {
          const host = createConfiguredProvider(integration, manifest, connection, {
            signal: controller.signal,
            onConnectionChanged: async (updated) => {
              connection = updated;

              if (existingConnection !== undefined && !reauthorize) {
                await replacePrivateFile(
                  connectionPath,
                  `${JSON.stringify(
                    {
                      ...existingConnection,
                      authorizationState: updated.authorizationState,
                      provider: providerBinding(
                        integration,
                        manifest,
                        existingConnection.origin,
                        updated.authorizationState,
                        existingConnection.inputs,
                      ),
                    },
                    null,
                    2,
                  )}\n`,
                );
              }
            },
          });

          await withAuthenticationSettlement(host, () =>
            verifyConnection(
              integration,
              { connectionConfig: connection.inputs, signal: controller.signal },
              host,
            ),
          );
        }

        const syncInputs = JsonObjectSchema.parse(parsedSyncInputs.data);
        const profileValues = {
          integration: integration.key,
          sync: syncKey,
          connection: connectionName,
          inputs: syncInputs,
        };
        let profileRevision: string = randomUUID();

        if (existingProfile !== undefined) {
          const { revision, ...existingValues } = existingProfile;

          if (isDeepStrictEqual(existingValues, profileValues)) profileRevision = revision;
        }

        const profile: Profile = { ...profileValues, revision: profileRevision };

        await replacePrivateFile(connectionPath, `${JSON.stringify(connection, null, 2)}\n`);
        await replacePrivateFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

        return connectionName;
      } finally {
        process.removeListener("SIGINT", abort);
      }
    },
  );
}

export async function withFileLock<Value>(
  path: string,
  inUseMessage: string,
  action: () => Promise<Value>,
): Promise<Value> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const lock = await open(path, "wx", 0o600).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(inUseMessage, { cause: error });
    }

    throw error;
  });

  try {
    return await action();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(path, { force: true });
    }
  }
}

async function promptConfigurationInputs(current: {
  connection: JsonObject;
  sync: JsonObject;
}): Promise<{ connection: JsonObject; sync: JsonObject }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("configuration inputs require an interactive terminal or --inputs");
  }

  const lines = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const answer = await lines.question(`Inputs [${JSON.stringify(current)}]: `);

      if (!answer.trim()) return current;

      try {
        const parsed = ConfigurationInputsSchema.safeParse(JSON.parse(answer));

        if (parsed.success) {
          return {
            connection: parsed.data.connection ?? current.connection,
            sync: parsed.data.sync ?? current.sync,
          };
        }
      } catch {}

      console.error("Inputs must contain connection and sync JSON objects");
    }
  } finally {
    lines.close();
  }
}

async function promptCredentials(
  schema: InputObjectSchema,
  existing: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  if (
    Object.keys(schema.properties).length > 0 &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    throw new Error("credentials require an interactive terminal");
  }

  const values: Record<string, string> = {};

  for (const [name, field] of Object.entries(schema.properties)) {
    const current = existing[name];
    const label = field.title ?? name;
    let answer: string;

    if (
      ("writeOnly" in field && field.writeOnly === true) ||
      ("x-beetl-widget" in field && field["x-beetl-widget"] === "password")
    ) {
      answer = await password({
        message: current === undefined ? label : `${label} [configured]`,
        mask: true,
      });
    } else {
      const lines = createInterface({ input: process.stdin, output: process.stdout });

      try {
        answer = await lines.question(
          current === undefined ? `${label}: ` : `${label} [configured]: `,
        );
      } finally {
        lines.close();
      }
    }

    values[name] = answer === "" && current !== undefined ? current : answer;
  }

  return values;
}

async function readProfile(path: string): Promise<Profile | undefined> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

    throw new Error(`Could not read profile ${path}`, { cause: error });
  }

  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Profile ${path} is not valid JSON`, { cause: error });
  }

  const profile = ProfileSchema.safeParse(value);

  if (!profile.success)
    throw new Error(`Invalid profile ${path}: ${z.prettifyError(profile.error)}`);

  return profile.data;
}

export function createConfiguredProvider(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  connection: StoredConnection,
  options: {
    signal: AbortSignal;
    onConnectionChanged(connection: StoredConnection): void | Promise<void>;
  },
) {
  const { onConnectionChanged, signal } = options;
  const auth = integration.connection.auth;
  const provider = createProvider(
    { ...integration.connection, origin: connection.origin ?? integration.connection.origin },
    {
      connectionConfig: parseConnectionInputs(integration, connection.inputs),
      fetch: ProviderFetch,
      credentials: parseCredentials(auth?.credentials ?? EmptyInputs, connection.credentials),
      ...(connection.authorizationState === undefined
        ? {}
        : { authorizationState: connection.authorizationState }),
      onAuthorizationStateChanged: (authorizationState) => {
        const updated = {
          ...connection,
          authorizationState,
          provider: providerBinding(
            integration,
            manifest,
            connection.origin,
            authorizationState,
            connection.inputs,
          ),
        };

        return onConnectionChanged(updated);
      },
      signal,
    },
  );

  return {
    ...provider,
    async log(entry: import("../host.ts").LogEntry) {
      console.error(JSON.stringify(entry));
    },
  };
}

function parseConnectionInputs(integration: IntegrationDefinition, input: unknown): JsonObject {
  return JsonObjectSchema.parse((integration.connection.inputs ?? EmptyInputs).parse(input));
}

function parseCredentials(schema: z.ZodType, input: unknown): Readonly<Record<string, string>> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(`Invalid credentials: ${z.prettifyError(result.error)}`);
  }

  return CredentialValuesSchema.parse(result.data);
}

function providerBinding(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  origin: string | undefined,
  authorizationState: OAuthAuthorizationState | undefined,
  connectionInputs: JsonObject,
): ProviderBinding {
  return {
    origin: resolveProviderOrigin(
      origin ?? integration.connection.origin,
      authorizationState,
      manifest.connection.auth.type !== "none",
      parseConnectionInputs(integration, connectionInputs),
    ).origin,
    authentication: z.json().parse(manifest.connection.auth),
  };
}

function connectionMatchesProvider(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  connection: StoredConnection,
): boolean {
  try {
    return isDeepStrictEqual(
      connection.provider,
      providerBinding(
        integration,
        manifest,
        connection.origin,
        connection.authorizationState,
        connection.inputs,
      ),
    );
  } catch {
    return false;
  }
}

export function assertConnectionProvider(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  connection: StoredConnection,
): void {
  if (!connectionMatchesProvider(integration, manifest, connection)) {
    throw new Error("Connection does not match this provider definition; run configure again");
  }
}

export async function readConnection(
  path: string,
  integration: string,
  name: string,
): Promise<StoredConnection | undefined> {
  let source: string;

  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

    throw new Error(`Could not read local connection ${path}`, { cause: error });
  }

  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Local connection ${path} is not valid JSON`, { cause: error });
  }

  const connection = StoredConnectionSchema.safeParse(value);

  if (!connection.success) {
    throw new Error(`Invalid local connection ${path}: ${z.prettifyError(connection.error)}`);
  }

  if (connection.data.integration !== integration || connection.data.name !== name) {
    throw new Error(`Local connection ${path} does not match ${integration}/${name}`);
  }

  return connection.data;
}

export function selectSyncKey(
  integration: IntegrationDefinition,
  requested: string | undefined,
): string {
  const keys = Object.keys(integration.syncs);

  if (requested !== undefined && Object.hasOwn(integration.syncs, requested)) return requested;

  if (requested === undefined && keys.length === 1) return keys[0]!;

  throw new Error(
    `${requested === undefined ? "Multiple syncs" : `Unknown sync ${JSON.stringify(requested)}`}; choose one: ${keys.join(", ")}`,
  );
}

export interface AuthorizeOAuthOptions extends OAuthRequestOptions {
  readonly redirectUri: string;
  onAuthorizationUrl(url: string): void | Promise<void>;
  onAuthorizationCallback?(): string | Promise<string>;
}

export async function authorizeOAuth(
  options: AuthorizeOAuthOptions,
): Promise<OAuthAuthorizationState> {
  const redirect = new URL(options.redirectUri);
  const usesLocalCallback = redirect.protocol === "http:" && Boolean(redirect.port);
  const request = await beginOAuthAuthorization(options);

  const validateCallback = (value: string | URL) => {
    const url = new URL(value);

    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
      throw new Error("OAuth callback URL does not match the configured redirect URI");
    }

    return url;
  };

  let callbackUrl: URL;

  if (usesLocalCallback) {
    const callbackServer = createServer();
    const callbackController = new AbortController();

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

    const callbackPromise = waitForAuthorizationCallback(
      callbackServer,
      redirect,
      validateCallback,
      options.signal === undefined
        ? callbackController.signal
        : AbortSignal.any([options.signal, callbackController.signal]),
    );

    try {
      await options.onAuthorizationUrl(request.authorizationUrl);
      callbackUrl = await callbackPromise;
    } finally {
      callbackController.abort(new Error("OAuth authorization stopped"));
      await callbackPromise.catch(() => undefined);
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    }
  } else {
    await options.onAuthorizationUrl(request.authorizationUrl);

    if (options.onAuthorizationCallback === undefined) {
      throw new Error("This OAuth redirect requires the callback URL to be supplied");
    }

    callbackUrl = validateCallback(await options.onAuthorizationCallback());
  }

  return completeOAuthAuthorization({
    ...options,
    callbackUrl: callbackUrl.href,
    state: request.state,
    codeVerifier: request.codeVerifier,
  });
}

function waitForAuthorizationCallback(
  server: ReturnType<typeof createServer>,
  redirect: URL,
  validate: (url: URL) => URL,
  signal: AbortSignal | undefined,
): Promise<URL> {
  return new Promise<URL>((resolve, reject) => {
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
