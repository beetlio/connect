import { defineIntegration, z, type Batch, type SyncMode } from "../src/index.ts";
import type { RunSyncInput } from "../src/host.ts";

function checkSyncInterface() {
  const runs: RunSyncInput[] = [
    { sync: "items", mode: "append" },
    { sync: "items", mode: "append", checkpointing: false },
    { sync: "items", mode: "append", checkpointing: true },
    { sync: "items", mode: "append", checkpointing: true, checkpoint: "cursor" },
    { sync: "items", mode: "replace" },
    { sync: "items", mode: "replace", checkpointing: false },
    { sync: "items" },
    // @ts-expect-error Merge is no longer supported.
    { sync: "items", mode: "merge" },
    { sync: "items", mode: "replace", checkpointing: true },
    { sync: "items", mode: "replace", checkpoint: "cursor" },
    { sync: "items", mode: "replace", checkpointing: true, checkpoint: "cursor" },
    { sync: "items", mode: "append", checkpoint: "cursor" },
    { sync: "items", mode: "append", checkpointing: false, checkpoint: "cursor" },
  ];
  // @ts-expect-error Merge is no longer a storage mode.
  const mode: SyncMode = "merge";
  const batch: Batch = {
    records: [],
    // @ts-expect-error Sync batches cannot emit deletion events.
    deletedKeys: [{ id: "gone" }],
  };

  defineIntegration({
    key: "sync-interface",
    displayName: "Sync interface",
    connection: { origin: "https://example.com" },
    syncs: (sync) => ({
      items: sync({
        records: z.object({ id: z.string() }),
        checkpoint: z.string(),
        async *run(ctx) {
          const cursor: string | undefined = ctx.checkpoint;
          yield { records: [{ id: cursor ?? "first" }], checkpoint: "next" };
        },
      }),
      full: sync({
        records: z.object({ id: z.string() }),
        async *run(ctx) {
          const checkpoint: undefined = ctx.checkpoint;
          yield { records: [{ id: "first" }] };
          void checkpoint;
        },
      }),
      mode: sync({
        // @ts-expect-error Integrations cannot select the host's mode.
        mode: "append",
        records: z.object({ id: z.string() }),
        async *run() {},
      }),
      keys: sync({
        // @ts-expect-error Syncs no longer declare primary keys.
        primaryKey: ["id"],
        records: z.object({ id: z.string() }),
        async *run() {},
      }),
      deletions: sync({
        records: z.object({ id: z.string() }),
        // @ts-expect-error Deletion events are rejected even in inferred generator output.
        async *run() {
          yield { records: [], deletedKeys: [{ id: "gone" }] };
        },
      }),
      undeclared: sync({
        records: z.object({ id: z.string() }),
        // @ts-expect-error Emitting checkpoints requires a checkpoint schema.
        async *run() {
          yield { records: [], checkpoint: "next" };
        },
      }),
      invalid: sync({
        records: z.object({ id: z.string() }),
        checkpoint: z.string(),
        // @ts-expect-error Checkpoints must match their declared schema.
        async *run() {
          yield { records: [], checkpoint: 1 };
        },
      }),
    }),
  });
  void [runs, mode, batch];
}

void checkSyncInterface;
