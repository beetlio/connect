import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { argument, command, constant, option } from "@optique/core/primitives";
import { choice, json, string, url } from "@optique/core/valueparser";
import { run } from "@optique/run";
import { path as pathValue } from "@optique/run/valueparser";
import { z } from "zod";

import { buildIntegration, packIntegration, withIntegration } from "../artifact.ts";
import { replacePrivateFile, withFileSink, withFileLock } from "../file-sink.ts";
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
  inputShape,
  readConnection,
  resolveProfile,
  selectSyncKey,
} from "./configure.ts";
import { checkPlatformRecordSchemas, runPlatformSync } from "./platform.ts";

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
          description: message`npm package output path (default: <INTEGRATION>/<key>.beetl.tgz).`,
        }),
      ),
    }),
    {
      brief: message`Check record schemas against Beetl and package an integration for a hosted build.`,
    },
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
      mode: optional(
        option("--mode", choice(["append", "replace"]), {
          description: message`Storage mode: append (default) or replace.`,
        }),
      ),
      statePath: optional(
        option("--state", pathValue({ metavar: "PATH" }), {
          description: message`Checkpoint state path.`,
        }),
      ),
      strict: optional(
        option("--strict", {
          description: message`Apply the record schema checks, limits, and run deadline Beetl applies to hosted runs.`,
        }),
      ),
    }),
    { brief: message`Run a sync and write NDJSON records.` },
  ),
);

export async function main(args = process.argv.slice(2)): Promise<void> {
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
    // Building evaluates the definition, so schemas Beetl would reject fail here.
    const { manifest } = await buildIntegration(options.integrationPath);

    for (const format of checkPlatformRecordSchemas(manifest))
      console.warn(
        `Warning: Beetl accepts this schema at upload but rejects some of its values at run time: ${format}`,
      );

    const packed = await packIntegration(options.integrationPath);
    const outputPath = resolve(
      options.outputPath ?? join(options.integrationPath, `${manifest.integration.key}.beetl.tgz`),
    );

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
      const inputs =
        options.inputs === undefined
          ? undefined
          : ConfigurationInputsSchema.safeParse(options.inputs);

      if (inputs?.success === false)
        throw new Error(
          `--inputs must be a JSON object shaped like ${inputShape(manifest, syncKey)}`,
        );

      const connection = await configureIntegration(
        integration,
        manifest,
        syncKey,
        profile,
        options.connection,
        options.origin,
        inputs?.data,
        options.reauthorize ?? false,
      );

      console.log(`Configured ${integration.displayName}/${syncKey} with connection ${connection}`);

      return;
    }

    if (options.command === "sync") {
      const syncKey = selectSyncKey(integration, options.syncKey);

      const formats = options.strict ? checkPlatformRecordSchemas(manifest) : [];

      if (formats.length > 0)
        throw new Error(
          `Beetl rejects some values these record schemas accept:\n${formats.join("\n")}`,
        );

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
          const sinkOptions = {
            outputPath,
            statePath,
            ...(options.mode === undefined ? {} : { mode: options.mode }),
          };
          // A run that returns hasMore continues from its checkpoint, as the platform
          // would, so a replace run publishes the complete output.
          const { records, batches } = await withFileSink(sinkOptions, (sink) =>
            withAuthenticationSettlement(provider, async () => {
              let checkpoint = sink.checkpoint;
              let records = 0,
                batches = 0;

              if (checkpoint !== undefined)
                console.log(
                  `Resuming from the checkpoint saved in ${statePath}; use --mode replace to read everything again`,
                );

              while (true) {
                const result = await (options.strict ? runPlatformSync : runSync)(
                  integration,
                  {
                    sync: syncKey,
                    connectionConfig: connection.inputs,
                    syncConfig: configuration.inputs,
                    ...(checkpoint === undefined ? {} : { checkpoint }),
                    signal: controller.signal,
                  },
                  { ...provider, commit: sink.commit },
                );

                records += result.records;
                batches += result.batches;
                checkpoint = result.checkpoint;

                if (result.outcome === "completed") return { records, batches };

                console.log(`Read ${records} records so far; continuing from the new checkpoint`);
              }
            }),
          );

          console.log(`Emitted ${records} records in ${batches} batches to ${outputPath}`);
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
