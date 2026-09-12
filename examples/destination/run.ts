// From the SDK checkout: npm run build && node examples/destination/run.ts
import assert from "node:assert/strict";
import { z } from "@beetlio/connect";
import { createProvider, runDestinationBatch } from "@beetlio/connect/host";
import integration from "./integration.ts";

const contacts = new Map([["gone", "old@example.com"]]);
const payload = z.strictObject({
  records: z.array(z.strictObject({ id: z.string(), email: z.email() })),
  deletedKeys: z.array(z.strictObject({ id: z.string() })),
});
let requests = 0;
const provider = createProvider(integration.connection, {
  connectionConfig: { tenant: "demo" },
  credentials: { token: "mock-token" },
  async fetch(input, init) {
    const request = new Request(input, init);
    assert.equal(request.url, "https://provider.example/contacts/batch");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer mock-token");
    assert.equal(request.headers.get("idempotency-key"), "demo-batch");
    const batch = payload.parse(await request.json());
    for (const record of batch.records) contacts.set(record.id, record.email);
    for (const key of batch.deletedKeys) contacts.delete(key.id);
    requests++;
    return Response.json({ failedIds: [] });
  },
});
const input = {
  destination: "contacts",
  connectionConfig: { tenant: "demo" },
  batch: {
    batchId: "demo-batch",
    records: [{ id: "one", email: "one@example.com" }],
    deletedKeys: [{ id: "gone" }],
  },
};

try {
  await runDestinationBatch(integration, input, provider);
  // Simulate an acknowledgment lost by the host: repeat the exact batch.
  await runDestinationBatch(integration, input, provider);
  assert.deepEqual([...contacts], [["one", "one@example.com"]]);
  assert.equal(requests, 2);
  console.log("Upsert, deletion, and replay succeeded against the mocked provider.");
} finally {
  await provider.settleAuthentication();
}
