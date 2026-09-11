import { defineIntegration, z } from "@beetlio/connect";

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
    origin: "https://www.wikidata.org",
    inputs: z.strictObject({
      userAgent: z.string().min(1).meta({
        title: "User agent",
        description: "Identify your application and include a contact address.",
      }),
    }),
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
  syncs: (defineSync) => ({
    entities: defineSync({
      displayName: "Entities",
      mode: "replace",
      records: Entity,
      inputs: z.strictObject({
        search: z.string().min(1).meta({
          title: "Search",
        }),
        language: z.string().min(1).default("en").meta({
          title: "Language",
        }),
        pageSize: z.number().int().min(1).max(50).default(25).meta({
          title: "Page size",
        }),
        maxResults: z.number().int().min(1).max(500).default(100).meta({
          title: "Maximum results",
        }),
      }),
      async *run(ctx) {
        const { search, language, pageSize, maxResults } = ctx.config.sync;
        const path =
          "/w/api.php?" +
          new URLSearchParams({
            action: "wbsearchentities",
            format: "json",
            maxlag: "30",
            search,
            language,
            uselang: language,
            type: "item",
          });
        let remaining = maxResults;

        for await (const page of ctx.paginate({
          request: {
            path,
            query: { limit: pageSize },
            headers: { "user-agent": ctx.config.connection.userAgent },
          },
          schema: z.object({
            search: z.array(SearchHit),
            "search-continue": z.number().optional(),
          }),
          next: ({ data, request }) =>
            data["search-continue"] === undefined
              ? undefined
              : { ...request, query: { limit: pageSize, continue: data["search-continue"] } },
        })) {
          const records = page.data.search.slice(0, remaining).map((hit) => ({
            id: hit.id,
            label: hit.label ?? hit.id,
            description: hit.description ?? null,
            aliases: hit.aliases ?? [],
            url: `https://www.wikidata.org/wiki/${encodeURIComponent(hit.id)}`,
          }));

          yield { records };
          remaining -= records.length;

          if (remaining === 0) return;
        }
      },
    }),
  }),
});
