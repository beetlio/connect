import { auth, credential, defineIntegration, input, z } from "@beetlio/connect";

export default defineIntegration({
  key: "oauth",
  displayName: "oauth",
  connection: {
    origin: { oauthTokenField: "instanceUrl" },
    auth: auth.oauth2AuthorizationCode({
      issuer: "https://auth.example",
      authorizationUrl: "https://auth.example/authorize",
      tokenUrl: "https://auth.example/token",
      scopes: ["read"],
      clientSecret: true,
      tokenFields: { instanceUrl: "instance_url" },
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
  ],
});
