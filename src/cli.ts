#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { string, url } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { path as pathValue } from "@optique/run/valueparser";
import password from "@inquirer/password";
import { z } from "zod";

import { createIntegrationArchive, loadIntegration } from "./artifact.ts";
import type {
  AuthenticationInputSchema,
  InputField,
  InputObjectSchema,
  IntegrationDefinition,
  IntegrationManifest,
  JsonObject,
  JsonValue,
} from "./index.ts";
import { runSync, verifyConnection } from "./host.ts";
import { LocalHost } from "./local-host.ts";
import { authorizeOAuth, type OAuthAuthorizationState } from "./oauth.ts";

interface ProfileConfiguration {
  readonly connection: string;
  readonly inputs: JsonObject;
}

type JsonRecord = Record<string, JsonValue>;

const Package = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));
const DefaultProfile = "default";
const DefaultConnection = "default";
const EmptyInputs = z.strictObject({});
const JsonObjectSchema = z.record(z.string(), z.json());
const AuthenticationInputValuesSchema = z.record(z.string(), z.string());
const ProfileSchema = z.strictObject({
  integration: z.string().min(1),
  sync: z.string().min(1),
  connection: z.string().min(1),
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
const StoredConnectionSchema = z.strictObject({
  integration: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  inputs: JsonObjectSchema.default({}),
  authenticationInput: AuthenticationInputValuesSchema.default({}),
  authorizationState: OAuthAuthorizationStateSchema.optional(),
});
type StoredConnection = z.output<typeof StoredConnectionSchema>;
const integrationArgument = () =>
  argument(pathValue({ mustExist: true, type: "either", metavar: "INTEGRATION" }), {
    description: message`Integration file, directory, or .beetl.zip artifact.`,
  });
const profileOption = () =>
  optional(
    option("--profile", string({ metavar: "NAME", pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }), {
      description: message`Load a local configuration profile (default: default).`,
    }),
  );
const connectionOption = () =>
  optional(
    option("--connection", string({ metavar: "NAME", pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ }), {
      description: message`Use a named connection (default: default).`,
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
          description: message`Artifact output path.`,
        }),
      ),
    }),
    { brief: message`Build a portable .beetl.zip artifact.` },
  ),
  command(
    "check",
    object({
      command: constant("check"),
      integrationPath: integrationArgument(),
    }),
    { brief: message`Type-check and validate trusted integration code.` },
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
    }),
    { brief: message`Interactively create a local configuration profile.` },
  ),
  command(
    "connect",
    object({
      command: constant("connect"),
      integrationPath: integrationArgument(),
      baseUrl: optional(
        option("--base-url", url({ allowedProtocols: ["http:", "https:"], metavar: "URL" }), {
          description: message`Override the provider base URL.`,
        }),
      ),
      connection: connectionOption(),
    }),
    { brief: message`Create or reauthorize a local connection.` },
  ),
  command(
    "verify",
    object({
      command: constant("verify"),
      integrationPath: integrationArgument(),
      connection: connectionOption(),
    }),
    { brief: message`Verify an integration connection.` },
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
    const requestedOutput =
      options.outputPath === undefined ? undefined : resolve(options.outputPath);
    if (requestedOutput !== undefined && !requestedOutput.endsWith(".beetl.zip")) {
      throw new Error("Artifact output must end with .beetl.zip");
    }
    const archive = await createIntegrationArchive(options.integrationPath);
    const outputPath = requestedOutput ?? resolve(archive.filename);
    await savePrivateFile(outputPath, archive.bytes);
    console.log(`Packed ${archive.manifest.integration.displayName} to ${outputPath}`);
    return;
  }
  const { integration, manifest } = await loadIntegration(options.integrationPath);

  if (options.command === "check") {
    console.log(
      `${integration.displayName}: ${integration.syncs.map((sync) => sync.key).join(", ")}`,
    );
    return;
  }

  if (options.command === "configure") {
    const syncKey = selectSyncKey(integration, options.syncKey);
    const profile = options.profile ?? DefaultProfile;
    await configureProfile(
      integration,
      manifest,
      syncKey,
      resolve(`.beetl/profiles/${integration.key}/${profile}.json`),
      options.connection,
    );
    console.log(`Saved profile ${profile} for ${integration.displayName}/${syncKey}`);
    return;
  }

  if (options.command === "connect") {
    const name = options.connection ?? DefaultConnection;
    const path = resolve(`.beetl/connections/${integration.key}/${name}.json`);
    await connectConnection(integration, manifest, name, path, options.baseUrl);
    console.log(`Connected ${integration.displayName} as ${name}`);
    return;
  }

  if (options.command === "sync") {
    const syncKey = selectSyncKey(integration, options.syncKey);
    const configuration = await resolveProfile(integration, manifest, syncKey, options.profile);
    const connectionPath = resolve(
      `.beetl/connections/${integration.key}/${configuration.connection}.json`,
    );
    let connection = await readConnection(
      connectionPath,
      integration.key,
      configuration.connection,
    );
    if (connection === undefined) {
      connection = await connectConnection(
        integration,
        manifest,
        configuration.connection,
        connectionPath,
      );
    }
    const outputPath = resolve(
      options.outputPath ??
        `${integration.key}-${syncKey}_${new Date().toISOString().replaceAll(":", "-")}.ndjson`,
    );
    const statePath = resolve(
      options.statePath ?? `.beetl/state/${integration.key}/${syncKey}.json`,
    );
    const controller = new AbortController();
    const host = createLocalHost(integration, connection, connectionPath, {
      outputPath,
      statePath,
      signal: controller.signal,
    });
    const abort = () => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", abort);
    try {
      const result = await runSync(
        integration,
        syncKey,
        {
          connectionConfig: connection.inputs,
          syncConfig: configuration.inputs,
          checkpoint: await host.loadCheckpoint(),
          signal: controller.signal,
        },
        host,
      );
      console.log(
        `Emitted ${result.records} records in ${result.batches} batches to ${outputPath}`,
      );
    } finally {
      process.removeListener("SIGINT", abort);
    }
    return;
  }

  if (options.command === "verify") {
    const name = options.connection ?? DefaultConnection;
    const connectionPath = resolve(`.beetl/connections/${integration.key}/${name}.json`);
    const connection = await readConnection(connectionPath, integration.key, name);
    if (connection === undefined) {
      throw new Error(`Connection ${JSON.stringify(name)} does not exist; run connect first`);
    }
    const controller = new AbortController();
    const host = createLocalHost(integration, connection, connectionPath, {
      outputPath: resolve(`.beetl/output/${integration.key}/verify.ndjson`),
      statePath: resolve(`.beetl/state/${integration.key}/verify.json`),
      signal: controller.signal,
    });
    const abort = () => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", abort);
    try {
      await verifyConnection(
        integration,
        {
          connectionConfig: connection.inputs,
          signal: controller.signal,
        },
        host,
      );
      console.log(`Verified ${integration.displayName} connection ${name}`);
    } finally {
      process.removeListener("SIGINT", abort);
    }
    return;
  }
}

async function resolveProfile(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  syncKey: string,
  requestedProfile: string | undefined,
): Promise<ProfileConfiguration> {
  const profileName = requestedProfile ?? DefaultProfile;
  const path = resolve(`.beetl/profiles/${integration.key}/${profileName}.json`);
  const syncManifest = manifest.syncs.find((sync) => sync.key === syncKey);
  let profile = await readProfile(path);
  if (
    profile === undefined &&
    syncManifest !== undefined &&
    Object.keys(syncManifest.inputs.properties).length > 0
  ) {
    await configureProfile(integration, manifest, syncKey, path);
    profile = await readProfile(path);
  }
  if (profile === undefined) {
    return { connection: DefaultConnection, inputs: {} };
  }
  if (profile.integration !== integration.key) {
    throw new Error(`Profile belongs to integration ${profile.integration}`);
  }
  if (profile.sync !== syncKey) {
    throw new Error(`Profile belongs to sync ${profile.sync}`);
  }
  return { connection: profile.connection, inputs: profile.inputs };
}

async function configureProfile(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  syncKey: string,
  path: string,
  requestedConnection?: string,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("configure requires an interactive terminal");
  }
  const existing = await readProfile(path);
  const sync = integration.syncs.find((candidate) => candidate.key === syncKey);
  const syncManifest = manifest.syncs.find((candidate) => candidate.key === syncKey);
  if (sync === undefined || syncManifest === undefined) {
    throw new Error(`Unknown sync ${JSON.stringify(syncKey)}`);
  }
  const inputs = await promptObject(syncManifest.inputs, existing?.inputs ?? {});
  const parsedInputs = (sync.inputs ?? EmptyInputs).safeParse(inputs);
  if (!parsedInputs.success) {
    throw new Error(`Invalid sync inputs: ${z.prettifyError(parsedInputs.error)}`);
  }
  const profile: Profile = {
    integration: integration.key,
    sync: syncKey,
    connection: requestedConnection ?? existing?.connection ?? DefaultConnection,
    inputs: JsonObjectSchema.parse(inputs),
  };
  await savePrivateFile(path, `${JSON.stringify(profile, null, 2)}\n`);
}

async function promptObject(
  schema: InputObjectSchema,
  existing: Readonly<Record<string, JsonValue | undefined>>,
): Promise<JsonRecord> {
  const required = new Set(schema.required ?? []);
  const values: JsonRecord = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    const current = existing[name] ?? field.default;
    const label = field.title ?? name;
    const value = await promptValue(label, field, current, required.has(name));
    if (value !== undefined) values[name] = value;
  }
  return values;
}

async function promptValue(
  label: string,
  schema: InputField,
  current: JsonValue | undefined,
  required: boolean,
): Promise<JsonValue | undefined> {
  if (schema.type === "object") {
    console.log(label);
    return promptObject(
      schema,
      current !== null && typeof current === "object" && !Array.isArray(current) ? current : {},
    );
  }
  if (schema["x-beetl-widget"] === "password") {
    while (true) {
      const answer = (
        await password({
          message: current === undefined ? label : `${label} [configured]`,
          mask: true,
        })
      ).trim();
      if (answer) return answer;
      if (current !== undefined) return current;
      if (!required) return undefined;
      console.error(`${label} is required`);
    }
  }
  const choices = Array.isArray(schema.enum)
    ? ` (${schema.enum.join("/")})`
    : schema.type === "boolean"
      ? " (true/false)"
      : "";
  const shown =
    current === undefined
      ? ""
      : ` [${typeof current === "string" ? current : JSON.stringify(current)}]`;
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await lines.question(`${label}${choices}${shown}: `)).trim();
      if (!answer) {
        if (current !== undefined) return current;
        if (!required) return undefined;
        console.error(`${label} is required`);
        continue;
      }
      if (schema.type === "integer" || schema.type === "number") {
        const value = Number(answer);
        if (Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value))) {
          return value;
        }
        console.error(`${label} must be a ${schema.type}`);
        continue;
      }
      if (schema.type === "boolean") {
        if (answer === "true") return true;
        if (answer === "false") return false;
        console.error(`${label} must be true or false`);
        continue;
      }
      if (schema.type === "array" || schema["x-beetl-widget"] === "json") {
        try {
          const value = z.json().safeParse(JSON.parse(answer));
          if (value.success) return value.data;
        } catch {}
        console.error(`${label} must be valid JSON`);
        continue;
      }
      return answer;
    }
  } finally {
    lines.close();
  }
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

async function connectConnection(
  integration: IntegrationDefinition,
  manifest: IntegrationManifest,
  name: string,
  path: string,
  baseUrl?: URL,
): Promise<StoredConnection> {
  if (
    (!process.stdin.isTTY || !process.stdout.isTTY) &&
    (Object.keys(manifest.connection.inputs.properties).length > 0 ||
      Object.keys(manifest.connection.authenticationInput.properties).length > 0)
  ) {
    throw new Error("connect requires an interactive terminal");
  }
  const existing = await readConnection(path, integration.key, name);
  const inputs = await promptObject(manifest.connection.inputs, existing?.inputs ?? {});
  const authenticationInput = await promptObject(
    manifest.connection.authenticationInput,
    existing?.authenticationInput ?? {},
  );
  const parsedInputs = (integration.connection.inputs ?? EmptyInputs).safeParse(inputs);
  if (!parsedInputs.success) {
    throw new Error(`Invalid connection inputs: ${z.prettifyError(parsedInputs.error)}`);
  }
  const parsedAuthenticationInput = parseAuthenticationInput(
    integration.connection.auth?.inputs ?? EmptyInputs,
    authenticationInput,
  );
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", abort);
  try {
    const configuredBaseUrl = baseUrl?.href ?? existing?.baseUrl;
    const authorizationState =
      integration.connection.auth?.type === "oauth2_authorization_code"
        ? await authorizeOAuth({
            auth: integration.connection.auth,
            authenticationInput: parsedAuthenticationInput,
            redirectUri: "http://127.0.0.1:53682/oauth/callback",
            signal: controller.signal,
            onAuthorizationUrl: (url) => console.log(`Open this URL to authorize:\n${url}`),
          })
        : undefined;
    const connection: StoredConnection = {
      integration: integration.key,
      name,
      ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl }),
      inputs: JsonObjectSchema.parse(inputs),
      authenticationInput: AuthenticationInputValuesSchema.parse(authenticationInput),
      ...(authorizationState === undefined ? {} : { authorizationState }),
    };
    await savePrivateFile(path, `${JSON.stringify(connection, null, 2)}\n`);
    if (manifest.connection.canVerify) {
      await verifyConnection(
        integration,
        { connectionConfig: connection.inputs, signal: controller.signal },
        createLocalHost(integration, connection, path, {
          outputPath: resolve(`.beetl/output/${integration.key}/connect.ndjson`),
          statePath: resolve(`.beetl/state/${integration.key}/connect.json`),
          signal: controller.signal,
        }),
      );
    }
    return connection;
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

function createLocalHost(
  integration: IntegrationDefinition,
  connection: StoredConnection,
  connectionPath: string,
  files: { outputPath: string; statePath: string; signal: AbortSignal },
): LocalHost {
  const auth = integration.connection.auth;
  return new LocalHost({
    baseUrl: connection.baseUrl ?? integration.connection.baseUrl,
    ...(auth === undefined ? {} : { auth }),
    authenticationInput: parseAuthenticationInput(
      auth?.inputs ?? EmptyInputs,
      connection.authenticationInput,
    ),
    ...(connection.authorizationState === undefined
      ? {}
      : { authorizationState: connection.authorizationState }),
    onAuthorizationStateChanged: (authorizationState) =>
      savePrivateFile(
        connectionPath,
        `${JSON.stringify({ ...connection, authorizationState }, null, 2)}\n`,
      ),
    ...files,
  });
}

function parseAuthenticationInput(
  schema: AuthenticationInputSchema,
  input: unknown,
): Readonly<Record<string, string>> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid authentication input: ${z.prettifyError(result.error)}`);
  }
  return result.data;
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

async function savePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, value, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
