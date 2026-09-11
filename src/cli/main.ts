#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { json, string, url } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { path as pathValue } from "@optique/run/valueparser";
import { z } from "zod";

import { buildIntegration, packIntegration, withIntegration } from "../artifact.ts";
import { replacePrivateFile, withFileSink } from "../file-sink.ts";
import { runSync } from "../host.ts";
import { withAuthenticationSettlement } from "../provider.ts";

import {
  ConfigurationInputsSchema,
  DefaultProfile,
  LocalNamePattern,
  UserConfigDirectory,
  assertConnectionProvider,
  configureIntegration,
  createConfiguredProvider,
  readConnection,
  resolveProfile,
  selectSyncKey,
  withFileLock,
} from "./configure.ts";

const Package = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../../package.json"));
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
  command("compatibility", object({ command: constant("compatibility") }), {
    brief: message`Check SDK compatibility with frozen and current integration fixtures.`,
  }),
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

  if (options.command === "compatibility") {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        fileURLToPath(new URL("../compatibility/run.js", import.meta.url)),
      ],
      { stdio: "inherit" },
    );

    if (result.error) throw result.error;

    process.exitCode = result.status ?? 1;

    return;
  }

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
      const sync = integration.syncs[syncKey]!;
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
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Interrupted"));

        process.once("SIGINT", abort);

        const provider = createConfiguredProvider(integration, manifest, connection, {
          signal: controller.signal,
          onConnectionChanged: (updated) =>
            replacePrivateFile(connectionPath, JSON.stringify(updated, null, 2) + "\n"),
        });

        try {
          const result = await withFileSink(
            { outputPath, statePath, mode: sync.mode ?? "append" },
            (sink) =>
              withAuthenticationSettlement(provider, () =>
                runSync(
                  integration,
                  {
                    sync: syncKey,
                    connectionConfig: connection.inputs,
                    syncConfig: configuration.inputs,
                    ...(sink.checkpoint === undefined ? {} : { checkpoint: sink.checkpoint }),
                    signal: controller.signal,
                  },
                  { ...provider, commit: sink.commit },
                ),
              ),
          );

          console.log(
            `Emitted ${result.records} records${result.deleted ? ` and ${result.deleted} deletes` : ""} in ${result.batches} batches to ${outputPath}`,
          );
        } finally {
          process.removeListener("SIGINT", abort);
        }
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

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
