import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { BatchSchema } from "./execution-schema.ts";
import type { EmittedBatch } from "./host.ts";
import type { JsonValue } from "./index.ts";
import { jsonSnapshot } from "./json.ts";

export interface FileSinkOptions {
  readonly outputPath: string;
  readonly statePath: string;
  /** Append resumes from saved state; replace starts over and publishes after success. */
  readonly mode?: "append" | "replace";
}

export async function withFileSink<T>(
  options: FileSinkOptions,
  action: (sink: {
    readonly checkpoint: JsonValue | undefined;
    commit(batch: EmittedBatch): Promise<"continue">;
  }) => Promise<T>,
): Promise<T> {
  const { outputPath, statePath } = options;
  const mode = z.enum(["append", "replace"]).default("append").parse(options.mode);

  return withFileLock(
    `${statePath}.lock`,
    `Sync state is already in use: ${statePath}`,
    async () => {
      const temporary = mode === "replace" ? `${outputPath}.tmp-${randomUUID()}` : undefined;
      const path = temporary ?? outputPath;
      let closed = false;
      // Replace saves its final checkpoint with the published output, so a failed run
      // keeps the state that matches the previous output.
      let replacementCheckpoint: JsonValue | undefined;

      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });

        if (temporary) {
          const file = await open(path, "wx", 0o600);

          await file.close();
        }

        let checkpoint: JsonValue | undefined;

        if (mode === "append") {
          try {
            checkpoint = jsonSnapshot(
              JSON.parse(await readFile(statePath, "utf8")),
              "Invalid stored checkpoint",
            );
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
        }

        const result = await action({
          checkpoint,
          async commit(batch) {
            if (closed) throw new Error("File sink is closed");

            const { checkpoint: next } = BatchSchema.parse(
              jsonSnapshot(batch, "Invalid file batch"),
            );

            const data = batch.records.map((record) => JSON.stringify(record) + "\n").join("");
            const file = await open(path, "a", 0o600);

            try {
              if (data) await file.writeFile(data);

              await file.sync();
            } finally {
              await file.close();
            }

            if (next !== undefined) {
              if (temporary) replacementCheckpoint = next;
              else await replacePrivateFile(statePath, JSON.stringify(next) + "\n");
            }

            return "continue";
          },
        });

        if (temporary) {
          await rename(temporary, outputPath);

          if (replacementCheckpoint === undefined) await rm(statePath, { force: true });
          else await replacePrivateFile(statePath, JSON.stringify(replacementCheckpoint) + "\n");
        }

        return result;
      } finally {
        closed = true;

        if (temporary) await rm(temporary, { force: true });
      }
    },
    true,
  );
}

export async function withFileLock<Value>(
  path: string,
  inUseMessage: string,
  action: () => Promise<Value>,
  wrapAllErrors = false,
): Promise<Value> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const lock = await open(path, "wx", 0o600).catch((error: unknown) => {
    if (wrapAllErrors || (error instanceof Error && "code" in error && error.code === "EEXIST")) {
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

export async function replacePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporaryPath, "wx", 0o600);

  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });

    throw error;
  }
}
