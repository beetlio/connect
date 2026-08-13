import { auth, defineIntegration, z } from "@beetlio/connect";

const Item = z.object({
  id: z.string(),
  name: z.string(),
});

const ItemsResponse = z.object({
  items: z.array(Item),
});

export default defineIntegration({
  key: "basic",
  displayName: "Basic dummy API",
  connection: {
    origin: "https://api.example.com",
    auth: auth.none(),
    async verify(ctx) {
      const response = await ctx.fetch("/health");
      if (!response.ok) throw new Error(`Health check failed with ${response.status}`);
    },
  },
  syncs: (defineSync) => [
    defineSync({
      key: "items",
      displayName: "Items",
      mode: "snapshot",
      records: Item,
      primaryKey: ["id"],
      async run(ctx) {
        const response = await ctx.fetch("/items");
        if (!response.ok) throw new Error(`Item request failed with ${response.status}`);
        const { items } = ItemsResponse.parse(await response.json());
        await ctx.emit({ records: items });
      },
    }),
  ],
});
