import { auth, defineIntegration, z } from "@beetlio/connect";

const SearchHit = z.object({
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});

const Entity = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  url: z.string(),
});

export default defineIntegration({
  key: "wikidata",
  displayName: "Wikidata",
  connection: {
    baseUrl: "https://www.wikidata.org",
    auth: auth.none(),
    config: z.object({
      userAgent: z.string().min(1),
    }),
    pagination: {
      type: "cursor",
      cursorParameter: "continue",
      cursorPath: "search-continue",
      limitParameter: "limit",
      responsePath: "search",
    },
    async verify(ctx) {
      const response = await ctx.fetch(
        "/w/api.php?action=query&meta=siteinfo&format=json&maxlag=5",
        { headers: { "user-agent": ctx.config.userAgent } },
      );
      if (!response.ok) {
        throw new Error(`Wikidata connection verification failed with ${response.status}`);
      }
    },
  },
  syncs: (defineSync) => [
    defineSync({
      key: "entities",
      displayName: "Entities",
      mode: "snapshot",
      records: Entity,
      primaryKey: ["id"],
      config: z.object({
        search: z.string().min(1),
        language: z.string().min(1).default("en"),
        pageSize: z.number().int().min(1).max(50).default(25),
        maxResults: z.number().int().min(1).max(500).default(100),
      }),
      async run(ctx) {
        const { search, language, pageSize, maxResults } = ctx.config.sync;
        const path = "/w/api.php?" + new URLSearchParams({
          action: "wbsearchentities",
          format: "json",
          maxlag: "5",
          search,
          language,
          uselang: language,
          type: "item",
        });
        let remaining = maxResults;

        for await (const page of ctx.paginate({
          path,
          records: SearchHit,
          pagination: { limit: pageSize },
          headers: { "user-agent": ctx.config.connection.userAgent },
        })) {
          const records = page.records.slice(0, remaining).map((hit) => ({
            id: hit.id,
            label: hit.label ?? hit.id,
            description: hit.description ?? null,
            aliases: hit.aliases ?? [],
            url: `https://www.wikidata.org/wiki/${encodeURIComponent(hit.id)}`,
          }));
          await ctx.emit({ records });
          remaining -= records.length;
          if (remaining === 0) return;
        }
      },
    }),
  ],
});
