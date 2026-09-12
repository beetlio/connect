import {
  auth,
  defineIntegration,
  z,
  type DestinationBatch,
  type DestinationContext,
} from "@beetlio/connect";

const Contact = z.object({ id: z.string(), email: z.email() });
const inputs = z.strictObject({ list: z.string().min(1).default("contacts") });

async function writeContacts(
  ctx: DestinationContext<z.output<typeof inputs>, { tenant: string }>,
  batch: DestinationBatch<z.output<typeof Contact>, { id: string }>,
): Promise<void> {
  const result = await ctx.json(
    `/${encodeURIComponent(ctx.config.destination.list)}/batch`,
    z.object({ failedIds: z.array(z.string()) }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": batch.batchId,
        "x-tenant": ctx.config.connection.tenant,
      },
      body: JSON.stringify({ records: batch.records, deletedKeys: batch.deletedKeys ?? [] }),
    },
  );
  if (result.failedIds.length)
    throw new Error(`Contact write failed: ${result.failedIds.join(", ")}`);
  await ctx.log.info("Contact batch written", { batchId: batch.batchId });
}

export default defineIntegration({
  key: "destination",
  displayName: "Contact destination",
  connection: {
    origin: "https://provider.example",
    auth: auth.bearer(),
    inputs: z.strictObject({ tenant: z.string() }),
  },
  destinations: (destination) => ({
    contacts: destination({
      displayName: "Contacts (delete removes the contact)",
      records: Contact,
      primaryKey: ["id"],
      inputs,
      supportsDelete: true,
      run: writeContacts,
    }),
    "upsert-only": destination({
      records: Contact,
      primaryKey: ["id"],
      inputs,
      run: writeContacts,
    }),
  }),
});
