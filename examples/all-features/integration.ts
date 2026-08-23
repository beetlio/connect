import { auth, defineIntegration, input, z } from "@beetlio/connect";

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

const PageConfig = input.object({
  pageSize: input.integer({ label: "Page size", min: 1, max: 100, default: 50 }),
});

export default defineIntegration({
  key: "all-features",
  displayName: "All features dummy API",
  connection: {
    origin: "https://api.example.com",
    inputs: input.object({
      workspace: input.string({ label: "Workspace", minLength: 1 }),
    }),
    auth: auth.oauth2AuthorizationCode({
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
  syncs: (defineSync) => [
    defineSync({
      key: "contacts",
      displayName: "Contacts",
      mode: "merge",
      records: Contact,
      primaryKey: ["id"],
      checkpoint: z.object({
        pagination: z.object({ offset: z.number().int().nonnegative() }),
      }),
      inputs: PageConfig,
      async run(ctx) {
        let offset = ctx.checkpoint?.pagination.offset ?? 0;
        for await (const page of ctx.paginate({
          path: `/v1/contacts?workspace=${encodeURIComponent(ctx.config.connection.workspace)}`,
          records: Contact,
          headers: { "x-api-version": "2026-08-01" },
          pagination: {
            type: "offset",
            offsetParameter: "offset",
            limitParameter: "limit",
            limit: ctx.config.sync.pageSize,
            responsePath: "data",
            initialOffset: offset,
          },
        })) {
          offset += page.records.length;
          await ctx.emit({
            records: page.records,
            checkpoint: { pagination: { offset } },
          });
        }
        await ctx.log.info("Emitted contacts");
      },
    }),
    defineSync({
      key: "events",
      displayName: "Events",
      records: Event,
      checkpoint: z.object({
        watermark: z.object({ lastSeenId: z.string() }),
      }),
      inputs: PageConfig,
      async run(ctx) {
        const params = new URLSearchParams({
          workspace: ctx.config.connection.workspace,
          ...(ctx.checkpoint === undefined ? {} : { since: ctx.checkpoint.watermark.lastSeenId }),
        });
        for await (const page of ctx.paginate({
          path: `/v1/events?${params}`,
          records: Event,
          pagination: {
            type: "cursor",
            cursorParameter: "after",
            cursorPath: "paging.next",
            limitParameter: "limit",
            limit: ctx.config.sync.pageSize,
            responsePath: "data",
          },
        })) {
          const lastSeenId = page.records.at(-1)!.id;
          await ctx.emit({
            records: page.records,
            checkpoint: { watermark: { lastSeenId } },
          });
        }
        await ctx.log.info("Emitted events");
      },
    }),
  ],
});
