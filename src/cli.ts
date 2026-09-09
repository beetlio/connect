#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { json, string, url } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { path as pathValue } from "@optique/run/valueparser";
import password from "@inquirer/password";
import envPaths from "env-paths";
import { z } from "zod";

import { buildIntegration, packIntegration, withIntegration } from "./artifact.ts";
import type {
  InputObjectSchema,
  IntegrationDefinition,
  IntegrationManifest,
  JsonObject,
  SyncMode,
} from "./index.ts";
import { runSync, verifyConnection } from "./host.ts";
import { LocalHost, replacePrivateFile, resolveProviderOrigin } from "./local-host.ts";
import { authorizeOAuth, type OAuthAuthorizationState } from "./oauth.ts";

interface ProfileConfiguration {
  readonly profile: string;
  readonly revision: string;
  readonly connection: string;
  readonly inputs: JsonObject;
}

const Package = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));
const DefaultProfile = "default";
const DefaultConnection = "default";
const LocalOAuthRedirectUri = "http://localhost:53682/oauth/callback";
const LocalNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const UserConfigDirectory = envPaths("beetl-connect", { suffix: "" }).config;
if (!isAbsolute(UserConfigDirectory)) {
  throw new Error("The operating-system user configuration directory must be absolute");
}
const ProviderFetch = globalThis.fetch.bind(globalThis);
const EmptyInputs = z.strictObject({});
const JsonObjectSchema = z.record(z.string(), z.json());
const ConfigurationInputsSchema = z.strictObject({
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
const OAuthAuthorizationStateSchema = z
  .strictObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    tokenFields: z.record(z.string(), z.string()),
  })
  .transform(({ accessToken, refreshToken, tokenFields }): OAuthAuthorizationState => ({
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    tokenFields,
  }));
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

const integrationArgument = () =>
  argument(pathValue({ mustExist: true, type: "directory", metavar: "INTEGRATION" }), {
    description: message`Integration npm package directory.`,
  });
const profileOption = () =>
  optional(
    option("--profile", string({ metavar: "NAME", pattern: LocalNamePattern }), {
      description: message`Load a local configuration profile (default: default).`,
    }),
  );
const connectionOption = () =>
  optional(
    option("--connection", string({ metavar: "NAME", pattern: LocalNamePattern }), {
      description: message`Use a named connection (default: default).`,
    }),
  );
const inputsOption = () =>
  optional(
    option("--inputs", json({ rootType: "object", metavar: "JSON" }), {
      description: message`Connection and sync inputs as one JSON object.`,
    }),
  );

const Cli = or(
  command(
    "pack",
    object({
      command: constant("pack"),
      integrationPath: integrationArgument(),
      outputPath: optional(
        option("--output", pathValue({ metavar: "PATH" }), {
          description: message`npm package output path.`,
        }),
      ),
    }),
    { brief: message`Create an npm package for a hosted build.` },
  ),
  command(
    "configure",
    object({
      command: constant("configure"),
      integrationPath: integrationArgument(),
      syncKey: optional(
        argument(string({ metavar: "SYNC" }), {
          description: message`Sync to configure; optional for single-sync integrations.`,
        }),
      ),
      profile: profileOption(),
      connection: connectionOption(),
      origin: optional(
        option("--origin", url({ allowedProtocols: ["http:", "https:"], metavar: "URL" }), {
          description: message`Override the provider origin.`,
        }),
      ),
      inputs: inputsOption(),
      reauthorize: optional(
        option("--reauthorize", {
          description: message`Collect credentials and authorize again.`,
        }),
      ),
    }),
    { brief: message`Configure and verify a local sync.` },
  ),
  command(
    "sync",
    object({
      command: constant("sync"),
      integrationPath: integrationArgument(),
      syncKey: optional(
        argument(string({ metavar: "SYNC" }), {
          description: message`Sync key; optional for single-sync integrations.`,
        }),
      ),
      profile: profileOption(),
      outputPath: optional(
        option("--output", pathValue({ metavar: "PATH" }), {
          description: message`NDJSON output path.`,
        }),
      ),
      statePath: optional(
        option("--state", pathValue({ metavar: "PATH" }), {
          description: message`Checkpoint state path.`,
        }),
      ),
    }),
    { brief: message`Run a sync and write NDJSON records.` },
  ),
);

async function main(args = process.argv.slice(2)): Promise<void> {
  const options = run(Cli, {
    args,
    programName: "beetl-connect",
    brief: message`Build and run API integrations.`,
    help: "both",
    version: Package.version,
  });
  if (options.command === "pack") {
    const packed = await packIntegration(options.integrationPath);
    const outputPath = resolve(options.outputPath ?? packed.filename);
    await replacePrivateFile(outputPath, packed.bytes);
    console.log(`Packed integration to ${outputPath}`);
    console.log(`Included files: ${packed.files.join(", ")}`);
    return;
  }
  const { archive, manifest } = await buildIntegration(options.integrationPath);
  const artifactRevision = createHash("sha256").update(archive).digest("hex");
  await withIntegration(archive, async (integration) => {
    if (options.command === "configure") {
      const syncKey = selectSyncKey(integration, options.syncKey);
      const profile = options.profile ?? DefaultProfile;
      const connection = await configureIntegration(
        integration,
        manifest,
        syncKey,
        profile,
        options.connection,
        options.origin,
        options.inputs === undefined ? undefined : ConfigurationInputsSchema.parse(options.inputs),
        options.reauthorize ?? false,
      );
      console.log(`Configured ${integration.displayName}/${syncKey} with connection ${connection}`);
      return;
    }

    if (options.command === "sync") {
      const syncKey = selectSyncKey(integration, options.syncKey);
      const sync = integration.syncs.find((candidate) => candidate.key === syncKey)!;
      let configuration = await resolveProfile(integration, manifest, syncKey, options.profile);
      let connectionPath = join(
        UserConfigDirectory,
        "connections",
        integration.key,
        `${configuration.connection}.json`,
      );
      if (
        (await readConnection(connectionPath, integration.key, configuration.connection)) ===
        undefined
      ) {
        await configureIntegration(
          integration,
          manifest,
          syncKey,
          configuration.profile,
          configuration.connection,
        );
        configuration = await resolveProfile(integration, manifest, syncKey, options.profile);
        connectionPath = join(
          UserConfigDirectory,
          "connections",
          integration.key,
          `${configuration.connection}.json`,
        );
      }
      const runConfiguredSync = async () => {
        const connection = await readConnection(
          connectionPath,
          integration.key,
          configuration.connection,
        );
        if (connection === undefined) throw new Error("Configuration did not create a connection");
        assertConnectionProvider(integration, manifest, connection);
        const outputPath = resolve(
          options.outputPath ??
            `${integration.key}-${syncKey}_${new Date().toISOString().replaceAll(":", "-")}.ndjson`,
        );
        const statePath = resolve(
          options.statePath ??
            `.beetl/state/${integration.key}/${artifactRevision}/${configuration.profile}/${configuration.revision}/${configuration.connection}/${connection.revision}/${syncKey}.json`,
        );
        await withFileLock(
          `${statePath}.lock`,
          `Sync state is already in use: ${statePath}`,
          async () => {
            const controller = new AbortController();
            const abort = () => controller.abort(new Error("Interrupted"));
            process.once("SIGINT", abort);
            try {
              const host = createLocalHost(integration, manifest, connection, {
                outputPath,
                statePath,
                mode: sync.mode ?? "append",
                signal: controller.signal,
                onConnectionChanged: (updated) =>
                  replacePrivateFile(connectionPath, `${JSON.stringify(updated, null, 2)}\n`),
              });
              try {
                const replace = sync.mode === "replace";
                if (replace) await host.beginReplace();
                try {
                  const checkpoint = replace ? undefined : await host.loadCheckpoint();
                  const result = await runSync(
                    integration,
                    syncKey,
                    {
                      connectionConfig: connection.inputs,
                      syncConfig: configuration.inputs,
                      ...(checkpoint === undefined ? {} : { checkpoint }),
                      signal: controller.signal,
                    },
                    host,
                  );
                  if (replace) await host.commitReplace();
                  console.log(
                    `Emitted ${result.records} records${result.deleted === 0 ? "" : ` and ${result.deleted} deletes`} in ${result.batches} batches to ${outputPath}`,
                  );
                } catch (error) {
                  try {
                    if (replace) await host.abortReplace();
                  } catch (cleanupError) {
                    throw new AggregateError(
                      [error, cleanupError],
                      "Replace run failed and cleanup also failed",
                    );
                  }
                  throw error;
                }
              } finally {
                await host.settleAuthentication();
              }
            } finally {
              process.removeListener("SIGINT", abort);
            }
          },
        );
      };
      if (integration.connection.auth?.type === "oauth2_authorization_code") {
        await withFileLock(
          `${connectionPath}.lock`,
          `Connection ${JSON.stringify(configuration.connection)} is already in use`,
          runConfiguredSync,
        );
      } else {
        await runConfiguredSync();
      }
    }
  });
}

async function resolveProfile(
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

async function configureIntegration(
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
  const sync = integration.syncs.find((candidate) => candidate.key === syncKey);
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
      const parsedConnectionInputs = (
        integration.connection.inputs?.schema ?? EmptyInputs
      ).safeParse(inputs.connection);
      if (!parsedConnectionInputs.success) {
        throw new Error(
          `Invalid connection inputs: ${z.prettifyError(parsedConnectionInputs.error)}`,
        );
      }
      const parsedSyncInputs = (sync.inputs?.schema ?? EmptyInputs).safeParse(inputs.sync);
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
        integration.connection.auth?.credentials.schema ?? EmptyInputs,
        credentials,
      );
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Interrupted"));
      process.once("SIGINT", abort);
      try {
        const configuredOrigin = requestedOrigin ?? existingConnection?.origin;
        const oauthOrigin =
          integration.connection.auth?.type !== "oauth2_authorization_code"
            ? undefined
            : (configuredOrigin ??
              (typeof integration.connection.origin !== "string" &&
              "oauthTokenField" in integration.connection.origin
                ? undefined
                : resolveProviderOrigin(
                    integration.connection.origin,
                    undefined,
                    true,
                    JsonObjectSchema.parse(parsedConnectionInputs.data),
                  ).origin));
        const authorizationState =
          integration.connection.auth?.type === "oauth2_authorization_code"
            ? existingConnection?.authorizationState !== undefined && !reauthorize
              ? existingConnection.authorizationState
              : await authorizeOAuth({
                  auth: integration.connection.auth,
                  ...(oauthOrigin === undefined ? {} : { origin: oauthOrigin }),
                  credentials: parsedCredentials,
                  redirectUri: LocalOAuthRedirectUri,
                  fetch: ProviderFetch,
                  signal: controller.signal,
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
          const host = createLocalHost(integration, manifest, connection, {
            outputPath: resolve(`.beetl/output/${integration.key}/configure.ndjson`),
            statePath: resolve(`.beetl/state/${integration.key}/configure.json`),
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
          try {
            await verifyConnection(
              integration,
              { connectionConfig: connection.inputs, signal: controller.signal },
              host,
            );
          } finally {
            await host.settleAuthentication();
          }
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

async function withFileLock<Value>(
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
    if ("x-beetl-widget" in field && field["x-beetl-widget"] === "password") {
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

function createLocalHost(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  connection: StoredConnection,
  options: {
    outputPath: string;
    statePath: string;
    mode?: SyncMode;
    signal: AbortSignal;
    onConnectionChanged(connection: StoredConnection): void | Promise<void>;
  },
): LocalHost {
  const { onConnectionChanged, ...files } = options;
  const auth = integration.connection.auth;
  return new LocalHost({
    origin: connection.origin ?? integration.connection.origin,
    connectionConfig: parseConnectionInputs(integration, connection.inputs),
    fetch: ProviderFetch,
    ...(auth === undefined ? {} : { auth }),
    credentials: parseCredentials(auth?.credentials.schema ?? EmptyInputs, connection.credentials),
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
    ...files,
  });
}

function parseConnectionInputs(integration: IntegrationDefinition, input: unknown): JsonObject {
  return JsonObjectSchema.parse(
    (integration.connection.inputs?.schema ?? EmptyInputs).parse(input),
  );
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

function assertConnectionProvider(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  connection: StoredConnection,
): void {
  if (!connectionMatchesProvider(integration, manifest, connection)) {
    throw new Error("Connection does not match this provider definition; run configure again");
  }
}

async function readConnection(
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

function selectSyncKey(integration: IntegrationDefinition, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!integration.syncs.some((sync) => sync.key === requested)) {
      throw new Error(
        `Unknown sync ${JSON.stringify(requested)}; choose one: ${integration.syncs
          .map((sync) => sync.key)
          .join(", ")}`,
      );
    }
    return requested;
  }
  if (integration.syncs.length === 1) {
    return integration.syncs[0]!.key;
  }
  throw new Error(
    `${integration.displayName} has multiple syncs; choose one: ${integration.syncs
      .map((sync) => sync.key)
      .join(", ")}`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
