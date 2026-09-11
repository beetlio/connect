import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BatchSchema } from "./execution-schema.ts";
import type { EmittedBatch } from "./host.ts";
import type { JsonValue, SyncMode } from "./index.ts";
import { jsonSnapshot } from "./json.ts";

export interface FileSinkOptions {
  readonly outputPath: string;
  readonly statePath: string;
  readonly mode?: SyncMode;
}

export async function withFileSink<T>(
  options: FileSinkOptions,
  action: (sink: {
    readonly checkpoint: JsonValue | undefined;
    commit(batch: EmittedBatch): Promise<"continue">;
  }) => Promise<T>,
): Promise<T> {
  const { outputPath, statePath, mode = "append" } = options;

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });

  const lockPath = `${statePath}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((cause: unknown) => {
    throw new Error(`Sync state is already in use: ${statePath}`, { cause });
  });
  const temporary = mode === "replace" ? `${outputPath}.tmp-${randomUUID()}` : undefined;
  const path = temporary ?? outputPath;
  let closed = false;

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    if (temporary) {
      const file = await open(path, "wx", 0o600);

      await file.close();
    }

    let checkpoint: JsonValue | undefined;

    if (mode !== "replace") {
      try {
        checkpoint = jsonSnapshot(
          JSON.parse(await readFile(statePath, "utf8")),
          "Invalid stored checkpoint",
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }

    const result = await action({
      checkpoint,
      async commit(batch) {
        if (closed) throw new Error("File sink is closed");

        BatchSchema.parse(jsonSnapshot(batch, "Invalid file batch"));

        const data =
          mode === "merge"
            ? JSON.stringify({
                records: batch.records,
                ...(batch.deletedKeys === undefined ? {} : { deletedKeys: batch.deletedKeys }),
              }) + "\n"
            : batch.records.map((record) => JSON.stringify(record) + "\n").join("");
        const file = await open(path, "a", 0o600);

        try {
          if (data) await file.writeFile(data);

          await file.sync();
        } finally {
          await file.close();
        }

        if (mode !== "replace" && batch.checkpoint !== undefined)
          await replacePrivateFile(statePath, JSON.stringify(batch.checkpoint) + "\n");

        return "continue";
      },
    });

    if (temporary) await rename(temporary, outputPath);

    return result;
  } finally {
    closed = true;

    try {
      if (temporary) await rm(temporary, { force: true });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
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
