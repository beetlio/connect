import { auth, defineIntegration, z } from "@beetlio/connect";

const Contact = z.object({
  id: z.string(),
  email: z.string(),
  updatedAt: z.string(),
});
const Event = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
});
const PageConfig = z.strictObject({
  pageSize: z.number().int().min(1).max(100).default(50).meta({
    title: "Page size",
  }),
});

export default defineIntegration({
  key: "all-features",
  displayName: "All features dummy API",
  connection: {
    origin: "https://api.example.com",
    inputs: z.strictObject({
      workspace: z.string().min(1).meta({
        title: "Workspace",
      }),
    }),
    auth: auth.oauth2({
      clientSecret: true,
      issuer: "https://auth.example.com",
      authorizationUrl: "https://auth.example.com/oauth/authorize",
      tokenUrl: "https://auth.example.com/oauth/token",
      scopes: ["contacts:read", "events:read"],
    }),
    retry: {
      maxAttempts: 2,
      statuses: [503],
      methods: ["GET"],
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
    async verify(ctx) {
      const response = await ctx.fetch(
        `/v1/me?workspace=${encodeURIComponent(ctx.config.workspace)}`,
      );

      if (!response.ok) throw new Error(`Verification failed with ${response.status}`);

      await ctx.log.info("Connection verified");
    },
  },
  syncs: (defineSync) => ({
    contacts: defineSync({
      displayName: "Contacts",
      mode: "merge",
      records: Contact,
      primaryKey: ["id"],
      checkpoint: z.object({
        pagination: z.object({ offset: z.number().int().nonnegative() }),
      }),
      inputs: PageConfig,
      async *run(ctx) {
        let offset = ctx.checkpoint?.pagination.offset ?? 0;

        for await (const page of ctx.paginate({
          request: {
            path: `/v1/contacts?workspace=${encodeURIComponent(ctx.config.connection.workspace)}`,
            query: { offset, limit: ctx.config.sync.pageSize },
            headers: { "x-api-version": "2026-08-01" },
          },
          schema: z.object({ data: z.array(Contact) }),
          next: ({ data, request }) =>
            data.data.length < ctx.config.sync.pageSize
              ? undefined
              : { ...request, query: { offset: offset, limit: ctx.config.sync.pageSize } },
        })) {
          offset += page.data.data.length;
          yield {
            records: page.data.data,
            checkpoint: { pagination: { offset } },
          };
        }

        await ctx.log.info("Emitted contacts");
      },
    }),
    events: defineSync({
      displayName: "Events",
      records: Event,
      checkpoint: z.object({
        watermark: z.object({ lastSeenId: z.string() }),
      }),
      inputs: PageConfig,
      async *run(ctx) {
        const params = new URLSearchParams({
          workspace: ctx.config.connection.workspace,
          ...(ctx.checkpoint === undefined ? {} : { since: ctx.checkpoint.watermark.lastSeenId }),
        });

        for await (const page of ctx.paginate({
          request: { path: `/v1/events?${params}`, query: { limit: ctx.config.sync.pageSize } },
          schema: z.object({
            data: z.array(Event),
            paging: z.object({ next: z.string().optional() }),
          }),
          next: ({ data, request }) =>
            data.paging.next === undefined
              ? undefined
              : { ...request, query: { after: data.paging.next, limit: ctx.config.sync.pageSize } },
        })) {
          const lastSeenId = page.data.data.at(-1)?.id;

          if (lastSeenId === undefined) continue;

          yield {
            records: page.data.data,
            checkpoint: { watermark: { lastSeenId } },
          };
        }

        await ctx.log.info("Emitted events");
      },
    }),
  }),
});
