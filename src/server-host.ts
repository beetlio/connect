#!/usr/bin/env node

import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { extract } from "tar";
import { z } from "zod";

import { buildIntegration, withIntegration } from "./artifact.ts";
import { BatchSchema, RunResultSchema } from "./execution-schema.ts";
import { replacePrivateFile } from "./file-sink.ts";
import {
  runSync,
  verifyConnection,
  type CommitAction,
  type EmittedBatch,
  type SyncHost,
} from "./host.ts";
import type { IntegrationDefinition } from "./index.ts";
import { IntegrationManifestSchema } from "./manifest.ts";
import {
  OAuthAuthorizationStateSchema,
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  prepareOAuthAuthorization,
  type OAuthAuthorizationState,
} from "./oauth.ts";
import { createProvider, withAuthenticationSettlement } from "./provider.ts";

const JsonObject = z.record(z.string(), z.json());
const Credentials = z.record(z.string(), z.string());
const OptionalAuthorizationState = OAuthAuthorizationStateSchema.nullish().transform(
  (authorizationState) => authorizationState ?? undefined,
);
const HostFetch = globalThis.fetch.bind(globalThis);
const HostParse = JSON.parse.bind(JSON);
const HostStringify = JSON.stringify.bind(JSON);
const HostWrite = process.stdout.write.bind(process.stdout);
const IntegrationWrite = process.stderr.write.bind(process.stderr);
const HostError = console.error.bind(console);
const ExecFile = promisify(execFile);
const MaxBatchBytes = 8 * 1024 * 1024;
const SourceRequest = z.strictObject({
  protocolVersion: z.literal(1).optional(),
  integrationPath: z.string().min(1),
  resultPath: z.string().min(1),
});
const RuntimeSyncRequest = z.strictObject({
  protocolVersion: z.literal(1).optional(),
  operation: z.literal("sync"),
  runtimePath: z.string().min(1),
  resultPath: z.string().min(1),
  syncKey: z.string().min(1),
  connectionConfig: JsonObject.default({}),
  syncConfig: JsonObject.default({}),
  credentials: Credentials.default({}),
  authorizationState: OptionalAuthorizationState,
  checkpoint: z.json().optional(),
});

type RuntimeSyncRequest = z.output<typeof RuntimeSyncRequest>;

const BatchCommitted = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal("batch_committed"),
  batchId: z.string().min(1),
  action: z.enum(["continue", "yield"]),
});
const Request = z.discriminatedUnion("operation", [
  SourceRequest.extend({ operation: z.literal("inspect") }),
  SourceRequest.extend({
    operation: z.literal("oauth_start"),
    connectionConfig: JsonObject.default({}),
    credentials: Credentials,
    redirectUri: z.url(),
  }),
  SourceRequest.extend({
    operation: z.literal("oauth_callback"),
    connectionConfig: JsonObject.default({}),
    credentials: Credentials,
    redirectUri: z.url(),
    callbackUrl: z.url(),
    state: z.string().min(1),
    codeVerifier: z.string().min(1),
  }),
  SourceRequest.extend({
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
  RuntimeSyncRequest,
]);

async function main(): Promise<void> {
  const readMessage = createMessageReader(process.stdin);
  let workingDirectory: string | undefined;

  try {
    const message = await readMessage("Host request", 4 * 1024 * 1024);

    assertProtocolVersion(message, true);

    const request = Request.parse(message);
    const directory = await mkdtemp(join(tmpdir(), "beetl-connect-server-host-"));

    workingDirectory = directory;

    if (request.operation === "sync") {
      process.stdout.write = IntegrationWrite;
      await withIntegration(new Uint8Array(await readFile(request.runtimePath)), (integration) =>
        runRuntimeSync(integration, request, readMessage),
      );

      return;
    }

    const integrationPath = await prepareIntegrationPath(request.integrationPath, directory);
    const { archive, manifest } = await buildIntegration(integrationPath);

    if (request.operation === "inspect") {
      await replacePrivateFile(
        request.resultPath,
        JSON.stringify({ manifest: IntegrationManifestSchema.parse(manifest) }),
      );

      return;
    }

    await withIntegration(archive, async (integration) => {
      if (request.operation === "oauth_start" || request.operation === "oauth_callback") {
        const options = await prepareOAuthAuthorization(integration.connection, {
          connectionConfig: request.connectionConfig,
          credentials: request.credentials,
          fetch: HostFetch,
        });

        if (request.operation === "oauth_start") {
          const authorization = await beginOAuthAuthorization({
            ...options,
            redirectUri: request.redirectUri,
          });

          await replacePrivateFile(
            request.resultPath,
            JSON.stringify(
              z
                .strictObject({
                  authorizationUrl: z.url(),
                  state: z.string(),
                  codeVerifier: z.string(),
                })
                .parse(authorization),
            ),
          );

          return;
        }

        const authorizationState = await completeOAuthAuthorization({
          ...options,
          redirectUri: request.redirectUri,
          callbackUrl: request.callbackUrl,
          state: request.state,
          codeVerifier: request.codeVerifier,
        });

        await replacePrivateFile(
          request.resultPath,
          JSON.stringify({
            authorizationState: OAuthAuthorizationStateSchema.parse(authorizationState),
          }),
        );

        return;
      }

      const connectionConfig = await (
        integration.connection.inputs ?? z.strictObject({})
      ).parseAsync(request.connectionConfig);

      let authorizationState: OAuthAuthorizationState | undefined = request.authorizationState;
      const host = createProvider(integration.connection, {
        connectionConfig,
        credentials: request.credentials,
        ...(authorizationState === undefined ? {} : { authorizationState }),
        fetch: HostFetch,
        onAuthorizationStateChanged: (state) => void (authorizationState = state),
      });

      await (integration.connection.auth?.credentials ?? z.strictObject({})).parseAsync(
        request.credentials,
      );

      for (const selected of request.syncs) {
        const sync = integration.syncs[selected.key];

        if (sync === undefined) throw new Error(`Unknown sync ${JSON.stringify(selected.key)}`);

        await (sync.inputs ?? z.strictObject({})).parseAsync(selected.configuration);
      }

      await withAuthenticationSettlement(host, async () => {
        if (!manifest.connection.canVerify) return;

        await verifyConnection(
          integration,
          { connectionConfig },
          {
            ...host,
            async log(entry) {
              HostError(HostStringify(entry));
            },
          },
        );
      });

      await replacePrivateFile(
        request.resultPath,
        JSON.stringify({
          verified: true,
          ...(authorizationState === undefined ? {} : { authorizationState }),
        }),
      );
    });
  } finally {
    process.stdin.destroy();

    if (workingDirectory !== undefined) {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

async function runRuntimeSync(
  integration: IntegrationDefinition,
  request: RuntimeSyncRequest,
  readMessage: (label: string, maxBytes: number) => Promise<unknown>,
): Promise<void> {
  const connectionConfig = await (integration.connection.inputs ?? z.strictObject({})).parseAsync(
    request.connectionConfig,
  );

  await (integration.connection.auth?.credentials ?? z.strictObject({})).parseAsync(
    request.credentials,
  );

  let authorizationState: OAuthAuthorizationState | undefined = request.authorizationState;
  const providerHost = createProvider(integration.connection, {
    connectionConfig,
    credentials: request.credentials,
    ...(authorizationState === undefined ? {} : { authorizationState }),
    fetch: HostFetch,
    onAuthorizationStateChanged: (state) => void (authorizationState = state),
  });
  const host: SyncHost = {
    request: (providerRequest, providerSignal) =>
      providerHost.request(providerRequest, providerSignal),
    log: async (entry) => {
      HostError(HostStringify(entry));
    },
    commit: (batch) => exchangeBatch(batch, readMessage),
  };

  const result = await withAuthenticationSettlement(providerHost, () =>
    runSync(
      integration,
      {
        sync: request.syncKey,
        connectionConfig,
        syncConfig: request.syncConfig,
        ...(request.checkpoint === undefined ? {} : { checkpoint: request.checkpoint }),
      },
      host,
    ),
  );

  await replacePrivateFile(
    request.resultPath,
    HostStringify(
      RunResultSchema.extend({
        authorizationState: OAuthAuthorizationStateSchema.optional(),
      }).parse({
        ...result,
        ...(authorizationState === undefined ? {} : { authorizationState }),
      }),
    ),
  );
}

async function exchangeBatch(
  batch: EmittedBatch,
  readMessage: (label: string, maxBytes: number) => Promise<unknown>,
): Promise<CommitAction> {
  await writeMessage(
    BatchSchema.extend({ protocolVersion: z.literal(1), kind: z.literal("batch") }).parse({
      protocolVersion: 1,
      kind: "batch",
      ...batch,
    }),
  );

  const message = await readMessage("Batch acknowledgment", 64 * 1024);

  assertProtocolVersion(message);

  const committed = BatchCommitted.parse(message);

  if (committed.batchId !== batch.batchId) {
    throw new Error("The controller acknowledged a different batch");
  }

  return committed.action === "yield" ? "stop" : "continue";
}

function assertProtocolVersion(message: unknown, allowLegacy = false): void {
  const version =
    typeof message === "object" && message !== null && "protocolVersion" in message
      ? message.protocolVersion
      : undefined;

  if (version === 1 || (allowLegacy && version === undefined)) return;

  throw new Error(
    `Unsupported execution protocol version ${JSON.stringify(version)}; supported: 1. Upgrade the execution host/controller or send protocol v1.`,
  );
}

function createMessageReader(input: AsyncIterable<Uint8Array | string>) {
  const chunks = input[Symbol.asyncIterator]();
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  return async (label: string, maxBytes: number): Promise<unknown> => {
    while (true) {
      const newline = buffered.indexOf(0x0a);

      if (newline !== -1) {
        if (newline > maxBytes) throw new Error(`${label} is too large`);

        const message = buffered.subarray(0, newline);

        buffered = buffered.subarray(newline + 1);

        return parseMessage(message, label);
      }

      if (buffered.length > maxBytes) throw new Error(`${label} is too large`);

      const next = await chunks.next();

      if (next.done) {
        if (buffered.length === 0) throw new Error(`${label} is missing`);

        const message = buffered;

        buffered = Buffer.alloc(0);

        return parseMessage(message, label);
      }

      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      const chunkNewline = chunk.indexOf(0x0a);
      const messageBytes = buffered.length + (chunkNewline === -1 ? chunk.length : chunkNewline);

      if (messageBytes > maxBytes) throw new Error(`${label} is too large`);

      if (chunkNewline === -1) {
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk], messageBytes);

        continue;
      }

      const message =
        buffered.length === 0
          ? chunk.subarray(0, chunkNewline)
          : Buffer.concat([buffered, chunk.subarray(0, chunkNewline)], messageBytes);

      buffered = chunk.subarray(chunkNewline + 1);

      return parseMessage(message, label);
    }
  };
}

function parseMessage(message: Buffer<ArrayBufferLike>, label: string): unknown {
  try {
    return HostParse(message.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function writeMessage(value: object): Promise<void> {
  const message = HostStringify(value);

  if (Buffer.byteLength(message) > MaxBatchBytes) {
    throw new Error(`Emitted batch exceeds ${MaxBatchBytes} bytes`);
  }

  if (!HostWrite(`${message}\n`)) await once(process.stdout, "drain");
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
  HostError(error);
  process.exitCode = 1;
});
