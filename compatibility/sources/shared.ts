import { HttpError, batchRecords, defineIntegration, storageRecord, z } from "@beetlio/connect";
import type { IntegrationDefinition } from "@beetlio/connect";

export function defineFixture(definition: Omit<IntegrationDefinition, "syncs">) {
  return defineIntegration({
    ...definition,
    syncs: (sync) => ({
      items: sync({
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string() }),
        checkpoint: z.json(),
        async *run(ctx) {
          const cursor =
            typeof ctx.checkpoint === "object" &&
            ctx.checkpoint !== null &&
            !Array.isArray(ctx.checkpoint) &&
            typeof ctx.checkpoint.cursor === "string"
              ? ctx.checkpoint.cursor
              : undefined;

          try {
            for await (const page of ctx.paginate({
              request: { path: "/items", ...(cursor === undefined ? {} : { query: { cursor } }) },
              schema: z.object({
                records: z.array(z.object({ id: z.string() })),
                next: z.string().nullable().optional(),
              }),
              next: ({ data }) =>
                data.next == null ? undefined : { path: "/items", query: { cursor: data.next } },
            })) {
              yield {
                records: page.data.records,
                ...(page.data.next == null ? { deletedKeys: [{ id: "gone" }] } : {}),
                checkpoint: { cursor: page.data.next ?? null, opaque: ["keep", null, false, 0] },
              };
            }
          } catch (error) {
            if (error instanceof HttpError && error.status === 403)
              throw new Error("Provider scope missing");

            throw error;
          }
        },
      }),
      checkpoint: sync({
        records: z.object({ id: z.string() }),
        checkpoint: z.json(),
        async *run(ctx) {
          yield {
            records: [{ id: "checkpoint" }],
            ...(ctx.checkpoint === undefined ? {} : { checkpoint: ctx.checkpoint }),
          };
        },
      }),
      projected: sync({
        mode: "replace",
        records: storageRecord(
          z.object({ id: z.string(), metadata: z.record(z.string(), z.json()) }),
        ),
        async *run() {
          yield* batchRecords([{ id: "projected", metadata: { nested: [1, null] } }]);
        },
      }),
    }),
  });
}
