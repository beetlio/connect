#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type {
  AuthDefinition,
  CredentialSchema,
  IntegrationDefinition,
} from "./index.ts";
import { runSync, validateIntegration, verifyConnection } from "./host.ts";
import { LocalHost } from "./local-host.ts";
import { authorizeOAuth } from "./oauth.ts";

interface CliOptions {
  integrationPath: string;
  outputPath?: string;
  statePath?: string;
  baseUrl?: string;
  connectionConfig: unknown;
  syncConfig: unknown;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === "check") {
    const options = parseOptions(rest);
    const integration = await loadIntegration(options.integrationPath);
    validateIntegration(integration);
    console.log(
      `${integration.displayName}: ${integration.syncs.map((sync) => sync.key).join(", ")}`,
    );
    return;
  }

  if (command === "connect") {
    const options = parseOptions(rest);
    const integration = await loadIntegration(options.integrationPath);
    validateIntegration(integration);
    const oauth = localAuth(integration.connection.auth);
    if (oauth?.type !== "oauth2_authorization_code") {
      throw new Error("The connect command requires OAuth authentication");
    }
    const integrationCredentialSchema = integration.connection.integrationCredentials!;
    const credentialSchema = integration.connection.credentials!;
    const integrationCredentials = parseCredentialValues(
      integrationCredentialSchema,
      credentialsFromEnvironment(integrationCredentialSchema),
      "integration credentials",
    );
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", abort);
    try {
      let credentials = await authorizeOAuth({
        auth: oauth,
        integrationCredentials,
        credentialSchema,
        redirectUri: process.env.BEETL_CONNECT_REDIRECT_URI ??
          "http://127.0.0.1:53682/oauth/callback",
        signal: controller.signal,
        onAuthorizationUrl(url) {
          console.log(`Open this URL in your browser:\n${url}`);
        },
        async onAuthorizationCallback() {
          const lines = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await lines.question("Paste the final callback URL: ", {
              signal: controller.signal,
            });
          } finally {
            lines.close();
          }
        },
      });
      const host = new LocalHost({
        baseUrl: options.baseUrl ?? process.env.BEETL_CONNECT_BASE_URL ??
          integration.connection.baseUrl,
        auth: oauth,
        integrationCredentialSchema,
        integrationCredentials,
        credentialSchema,
        credentials,
        outputPath: resolve(`.beetl/output/${integration.key}/verify.ndjson`),
        statePath: resolve(`.beetl/state/${integration.key}/verify.json`),
        signal: controller.signal,
        onCredentialsChanged(updated) {
          credentials = updated;
        },
      });
      if (integration.connection.verify !== undefined) {
        await verifyConnection(
          integration,
          {
            connectionConfig: options.connectionConfig,
            signal: controller.signal,
          },
          host,
        );
      }
      const path = localConnectionPath(integration);
      await saveLocalConnection(path, credentials);
      console.log(`Connected ${integration.displayName}; credentials saved to ${path}`);
    } finally {
      process.removeListener("SIGINT", abort);
    }
    return;
  }

  if (command === "sync") {
    const syncKey = rest[0];
    if (!syncKey || syncKey.startsWith("--")) {
      throw new Error("Usage: beetl-connect sync <sync> [options]");
    }
    const options = parseOptions(rest.slice(1));
    const integration = await loadIntegration(options.integrationPath);
    const outputPath = resolve(
      options.outputPath ??
        `${integration.key}-${syncKey}_${new Date().toISOString().replaceAll(":", "-")}.ndjson`,
    );
    const statePath = resolve(
      options.statePath ?? `.beetl/state/${integration.key}/${syncKey}.json`,
    );
    const controller = new AbortController();
    const host = await createLocalHost(integration, options, {
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
          connectionConfig: options.connectionConfig,
          syncConfig: options.syncConfig,
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

  if (command === "verify") {
    const options = parseOptions(rest);
    const integration = await loadIntegration(options.integrationPath);
    const controller = new AbortController();
    const host = await createLocalHost(integration, options, {
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
          connectionConfig: options.connectionConfig,
          signal: controller.signal,
        },
        host,
      );
      console.log(`Verified ${integration.displayName}`);
    } finally {
      process.removeListener("SIGINT", abort);
    }
    return;
  }

  throw new Error(usage());
}

async function createLocalHost(
  integration: IntegrationDefinition,
  options: CliOptions,
  files: { outputPath: string; statePath: string; signal: AbortSignal },
): Promise<LocalHost> {
  const credentialSchema = integration.connection.credentials;
  const auth = localAuth(integration.connection.auth);
  const storedCredentials = integration.connection.auth?.type ===
      "oauth2_authorization_code"
    ? await loadLocalConnection(localConnectionPath(integration))
    : undefined;
  return new LocalHost({
    baseUrl: options.baseUrl ?? process.env.BEETL_CONNECT_BASE_URL ??
      integration.connection.baseUrl,
    ...(auth === undefined
      ? {}
      : { auth }),
    ...(integration.connection.integrationCredentials === undefined
      ? {}
      : {
        integrationCredentialSchema: integration.connection.integrationCredentials,
        integrationCredentials: credentialsFromEnvironment(
          integration.connection.integrationCredentials,
        ),
      }),
    ...(credentialSchema === undefined
      ? {}
      : {
        credentialSchema,
        credentials: storedCredentials ?? credentialsFromEnvironment(credentialSchema),
        onCredentialsChanged: (credentials: Readonly<Record<string, string>>) =>
          saveLocalConnection(localConnectionPath(integration), credentials),
      }),
    ...files,
  });
}

function localAuth(auth: AuthDefinition | undefined): AuthDefinition | undefined {
  if (auth?.type !== "oauth2_authorization_code") {
    return auth;
  }
  return {
    ...auth,
    authorizationUrl: process.env.BEETL_CONNECT_OAUTH_AUTHORIZATION_URL ??
      auth.authorizationUrl,
    tokenUrl: process.env.BEETL_CONNECT_OAUTH_TOKEN_URL ?? auth.tokenUrl,
  };
}

function parseCredentialValues(
  schema: CredentialSchema,
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${label}: ${z.prettifyError(result.error)}`);
  }
  return Object.fromEntries(
    Object.entries(result.data).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function credentialsFromEnvironment(
  schema: CredentialSchema,
): Readonly<Record<string, string>> {
  const credentials: Record<string, string> = {};
  const environmentNames = new Set<string>();
  for (const field of Object.keys(schema.shape)) {
    const environmentName = credentialEnvironmentName(field);
    if (environmentNames.has(environmentName)) {
      throw new Error(`Credential fields map to duplicate environment variable ${environmentName}`);
    }
    environmentNames.add(environmentName);
    const value = process.env[environmentName];
    if (value !== undefined) {
      credentials[field] = value;
    }
  }
  return credentials;
}

function credentialEnvironmentName(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
}

function localConnectionPath(integration: IntegrationDefinition): string {
  return resolve(`.beetl/connections/${integration.key}.json`);
}

async function loadLocalConnection(
  path: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || !("credentials" in value)) {
      throw new Error(`Invalid local connection file ${path}`);
    }
    return (value as { credentials: Readonly<Record<string, string>> }).credentials;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

async function saveLocalConnection(
  path: string,
  credentials: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ credentials }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadIntegration(path: string): Promise<IntegrationDefinition> {
  const url = pathToFileURL(resolve(path)).href;
  const module = await import(url) as { default?: unknown };
  if (!module.default || typeof module.default !== "object") {
    throw new Error(`${path} must default-export an integration`);
  }
  return module.default as IntegrationDefinition;
}

function parseOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid option ${JSON.stringify(flag)}`);
    }
    values.set(flag, value);
  }

  const known = new Set([
    "--integration",
    "--output",
    "--state",
    "--base-url",
    "--connection-config",
    "--sync-config",
  ]);
  for (const flag of values.keys()) {
    if (!known.has(flag)) {
      throw new Error(`Unknown option ${flag}`);
    }
  }

  return {
    integrationPath: values.get("--integration") ?? "integration.ts",
    ...(values.has("--output") ? { outputPath: values.get("--output")! } : {}),
    ...(values.has("--state") ? { statePath: values.get("--state")! } : {}),
    ...(values.has("--base-url") ? { baseUrl: values.get("--base-url")! } : {}),
    connectionConfig: parseJson(values.get("--connection-config") ?? "{}", "connection config"),
    syncConfig: parseJson(values.get("--sync-config") ?? "{}", "sync config"),
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid JSON for ${label}`);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  beetl-connect check [--integration path]",
    "  beetl-connect connect [--integration path] [--connection-config json]",
    "  beetl-connect verify [--integration path] [--base-url url] [--connection-config json]",
    "  beetl-connect sync <sync> [--integration path] [--output path] [--state path]",
    "                       [--base-url url] [--connection-config json] [--sync-config json]",
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
