import assert from "node:assert/strict";
import test from "node:test";

import { auth, defineIntegration, input, z } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import { runSync } from "@beetlio/connect/host";

test("v0.3 definitions execute through the v0.4 host boundary", async () => {
  const integration = defineIntegration({
    key: "legacy",
    displayName: "Legacy",
    connection: {
      origin: { input: "environment", values: { test: "https://api.example.com" } },
      inputs: input.object({
        environment: input.select([{ value: "test", label: "Test" }], { default: "test" }),
      }),
      auth: auth.none(),
    },
    syncs: (sync) => [
      sync({
        key: "items",
        displayName: "Items",
        records: z.object({ id: z.string() }),
        async run(ctx) {
          await ctx.emit({ records: [{ id: ctx.config.connection.environment }] });
        },
      }),
    ],
  });

  assert.equal(integration.syncs[0]?.key, "items");
  assert.equal(createIntegrationManifest(integration).syncs[0]?.key, "items");

  const batches: unknown[] = [];
  const result = await runSync(
    integration,
    "items",
    { connectionConfig: {} },
    {
      async request() {
        throw new Error("Unexpected request");
      },
      async emit(batch) {
        batches.push(batch);
        return "continue";
      },
    },
  );

  assert.equal(result.records, 1);
  assert.deepEqual(Reflect.get(batches[0]!, "records"), [{ id: "test" }]);
});
