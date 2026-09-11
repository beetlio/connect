import {
  auth,
  credential,
  defineIntegration,
  input,
  z,
  createRecordBatcher,
  storageRecord,
} from "@beetlio/connect";

export default defineIntegration({
  key: "exchange-form",
  displayName: "exchange-form",
  connection: {
    origin: {
      input: "environment",
      values: { production: "https://provider.example", sandbox: "https://sandbox.example" },
    },
    inputs: input.object({
      environment: input.select(
        [
          { value: "production", label: "Production" },
          { value: "sandbox", label: "Sandbox" },
        ],
        { default: "production" },
      ),
    }),
    auth: auth.tokenExchange({
      credentials: credential.object({
        clientId: credential.string(),
        clientSecret: credential.secret(),
      }),
      tokenUrl: "/token",
      basic: { username: "clientId", password: "clientSecret" },
      body: {
        encoding: "form",
        fields: {},
        values: { grant_type: "client_credentials", scope: "read" },
      },
      tokenPath: "access_token",
      expiresInPath: "expires_in",
    }),
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    pagination: {
      type: "cursor",
      cursorParameter: "cursor",
      cursorPath: "next",
      limitParameter: "limit",
      responsePath: "records",
    },
    async verify(ctx) {
      const response = await ctx.fetch("/verify");
      if (!response.ok) throw new Error("Verification failed");
    },
  },
  syncs: (defineSync) => [
    defineSync({
      key: "items",
      displayName: "Items",
      mode: "merge",
      primaryKey: ["id"],
      records: z.object({ id: z.string() }),
      checkpoint: z.json(),
      async run(ctx) {
        for await (const page of ctx.paginate({
          path: "/items",
          records: z.object({ id: z.string() }),
          pagination: {
            ...(typeof ctx.checkpoint === "object" &&
            ctx.checkpoint !== null &&
            !Array.isArray(ctx.checkpoint) &&
            typeof ctx.checkpoint.cursor === "string"
              ? { initialCursor: ctx.checkpoint.cursor }
              : {}),
          },
          onResponseError: async (response) => {
            if (response.status === 403) throw new Error("Provider scope missing");
          },
        })) {
          await ctx.emit({
            records: page.records,
            ...(page.nextPageParam === undefined ? { deletedKeys: [{ id: "gone" }] } : {}),
            checkpoint: { cursor: page.nextPageParam ?? null, opaque: ["keep", null, false, 0] },
          });
        }
      },
    }),
    defineSync({
      key: "checkpoint",
      displayName: "Checkpoint",
      records: z.object({ id: z.string() }),
      checkpoint: z.json(),
      async run(ctx) {
        await ctx.emit({
          records: [{ id: "checkpoint" }],
          ...(ctx.checkpoint === undefined ? {} : { checkpoint: ctx.checkpoint }),
        });
      },
    }),
    defineSync({
      key: "projected",
      displayName: "Projected",
      mode: "replace",
      records: storageRecord(
        z.object({ id: z.string(), metadata: z.record(z.string(), z.json()) }),
      ),
      async run(ctx) {
        const batcher = createRecordBatcher(ctx.emit);
        await batcher.emit({ records: [{ id: "projected", metadata: { nested: [1, null] } }] });
        await batcher.flush();
      },
    }),
  ],
});
