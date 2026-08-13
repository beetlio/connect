#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";
import { extract } from "tar";

import { buildIntegration, withIntegration } from "./artifact.ts";
import { runSync, verifyConnection } from "./host.ts";
import { LocalHost, replacePrivateFile } from "./local-host.ts";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  type OAuthAuthorizationState,
} from "./oauth.ts";

const JsonObject = z.record(z.string(), z.json());
const Credentials = z.record(z.string(), z.string());
const AuthorizationState = z
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
const OptionalAuthorizationState = AuthorizationState.nullish().transform(
  (authorizationState) => authorizationState ?? undefined,
);
const ExecFile = promisify(execFile);
const BaseRequest = z.strictObject({
  integrationPath: z.string().min(1),
  resultPath: z.string().min(1),
});
const Request = z.discriminatedUnion("operation", [
  BaseRequest.extend({ operation: z.literal("inspect") }),
  BaseRequest.extend({
    operation: z.literal("oauth_start"),
    credentials: Credentials,
    redirectUri: z.url(),
  }),
  BaseRequest.extend({
    operation: z.literal("oauth_callback"),
    credentials: Credentials,
    redirectUri: z.url(),
    callbackUrl: z.url(),
    state: z.string().min(1),
    codeVerifier: z.string().min(1),
  }),
  BaseRequest.extend({
    operation: z.literal("verify"),
    connectionConfig: JsonObject.default({}),
    credentials: Credentials.default({}),
    syncs: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          configuration: JsonObject.default({}),
        }),
      )
      .default([]),
    authorizationState: OptionalAuthorizationState,
  }),
  BaseRequest.extend({
    operation: z.literal("sync"),
    syncKey: z.string().min(1),
    connectionConfig: JsonObject.default({}),
    syncConfig: JsonObject.default({}),
    credentials: Credentials.default({}),
    authorizationState: OptionalAuthorizationState,
    checkpoint: z
      .json()
      .nullish()
      .transform((checkpoint) => checkpoint ?? undefined),
    outputPath: z.string().min(1),
    statePath: z.string().min(1),
  }),
]);

async function main(): Promise<void> {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > 4 * 1024 * 1024) {
      throw new Error("Host request exceeds 4 MiB");
    }
  }
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) {
    throw new Error("Host request exceeds 4 MiB");
  }
  const request = Request.parse(JSON.parse(source) as unknown);
  const workingDirectory = await mkdtemp(join(tmpdir(), "beetl-connect-server-host-"));
  try {
    const integrationPath = await prepareIntegrationPath(request.integrationPath, workingDirectory);
    const { archive, manifest } = await buildIntegration(integrationPath);

    if (request.operation === "inspect") {
      await replacePrivateFile(request.resultPath, JSON.stringify({ manifest }));
      return;
    }
    await withIntegration(archive, async (integration) => {
      if (request.operation === "oauth_start" || request.operation === "oauth_callback") {
        const oauth = integration.connection.auth;
        if (oauth?.type !== "oauth2_authorization_code") {
          throw new Error("Integration does not use OAuth authorization code authentication");
        }
        await oauth.credentials.schema.parseAsync(request.credentials);
        if (request.operation === "oauth_start") {
          const authorization = await beginOAuthAuthorization({
            auth: oauth,
            credentials: request.credentials,
            redirectUri: request.redirectUri,
          });
          await replacePrivateFile(request.resultPath, JSON.stringify(authorization));
          return;
        }
        const authorizationState = await completeOAuthAuthorization({
          auth: oauth,
          credentials: request.credentials,
          redirectUri: request.redirectUri,
          callbackUrl: request.callbackUrl,
          state: request.state,
          codeVerifier: request.codeVerifier,
        });
        await replacePrivateFile(request.resultPath, JSON.stringify({ authorizationState }));
        return;
      }

      const connectionConfig = await (
        integration.connection.inputs?.schema ?? z.strictObject({})
      ).parseAsync(request.connectionConfig);

      const outputPath =
        request.operation === "sync" ? request.outputPath : join(workingDirectory, "verify.ndjson");
      const statePath =
        request.operation === "sync"
          ? request.statePath
          : join(workingDirectory, "verify-state.json");
      let authorizationState: OAuthAuthorizationState | undefined = request.authorizationState;
      const host = new LocalHost({
        origin: integration.connection.origin,
        connectionConfig,
        ...(integration.connection.auth === undefined ? {} : { auth: integration.connection.auth }),
        credentials: request.credentials,
        ...(authorizationState === undefined ? {} : { authorizationState }),
        outputPath,
        statePath,
        onLog: (entry) => console.error(JSON.stringify(entry)),
        onAuthorizationStateChanged: (state) => void (authorizationState = state),
      });

      if (request.operation === "verify") {
        await (integration.connection.auth?.credentials.schema ?? z.strictObject({})).parseAsync(
          request.credentials,
        );
        for (const selected of request.syncs) {
          const sync = integration.syncs.find((candidate) => candidate.key === selected.key);
          if (sync === undefined) throw new Error(`Unknown sync ${JSON.stringify(selected.key)}`);
          await (sync.inputs?.schema ?? z.strictObject({})).parseAsync(selected.configuration);
        }
        if (manifest.connection.canVerify) {
          await verifyConnection(integration, { connectionConfig }, host);
        }
        await host.settleAuthentication();
        await replacePrivateFile(
          request.resultPath,
          JSON.stringify({
            verified: true,
            ...(authorizationState === undefined ? {} : { authorizationState }),
          }),
        );
        return;
      }

      const result = await runSync(
        integration,
        request.syncKey,
        {
          connectionConfig,
          syncConfig: request.syncConfig,
          ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
        },
        host,
      );
      await host.settleAuthentication();
      await replacePrivateFile(
        request.resultPath,
        JSON.stringify({
          ...result,
          ...(authorizationState === undefined ? {} : { authorizationState }),
        }),
      );
    });
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function prepareIntegrationPath(path: string, workingDirectory: string): Promise<string> {
  if ((await stat(path)).isDirectory()) return path;
  await extract({ cwd: workingDirectory, file: path, strict: true });
  const packagePath = join(workingDirectory, "package");
  if (!(await stat(packagePath)).isDirectory()) {
    throw new Error("Integration package must contain a package directory");
  }
  await ExecFile("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: packagePath,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
  return packagePath;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
