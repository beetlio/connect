import { HttpError, defineIntegration, z, type SyncContext } from "@beetlio/connect";
import { createProvider, runSync } from "@beetlio/connect/host";
import assert from "node:assert/strict";
import test from "node:test";
import { syncHost } from "./support.ts";

function integration(
  run: (
    ctx: SyncContext,
  ) => AsyncGenerator<{ records: { id: number }[]; checkpoint?: number }, void, unknown>,
) {
  return defineIntegration({
    key: "execution",
    displayName: "Execution",
    connection: { origin: "https://provider.example" },
    syncs: (sync) => ({
      items: sync({ records: z.object({ id: z.number() }), checkpoint: z.number(), run }),
    }),
  });
}

test("commits apply backpressure and continuation closes the generator", async () => {
  const events: string[] = [];
  let logger: SyncContext["log"] | undefined;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const committed = new Promise<void>((resolve) => {
    started = resolve;
  });
  const source = integration(async function* (ctx) {
    logger = ctx.log;

    try {
      events.push("first");
      yield { records: [{ id: 1 }], checkpoint: 1 };
      events.push("second");
      yield { records: [{ id: 2 }], checkpoint: 2 };
    } finally {
      events.push("finally");
      await assert.rejects(ctx.fetch("/after-stop"), /Execution context is closed/);
      await ctx.log.info("closed");
    }
  });
  const running = runSync(
    source,
    { sync: "items" },
    syncHost({
      async log(entry) {
        await Promise.resolve();
        events.push(entry.message);
      },
      async commit() {
        started();
        await barrier;
        events.push("commit");

        return "stop";
      },
    }),
  );

  await committed;

  assert.deepEqual(events, ["first"]);

  release();

  const result = await running;

  assert.deepEqual(events, ["first", "commit", "finally", "closed"]);
  assert.equal(result.checkpoint, 1);
  assert.equal(result.outcome, "continuation_required");
  await assert.rejects(logger!.info("late"), /Execution context is closed/);
});

test("commit and generator cleanup failures remain visible", async () => {
  const commitFailure = new Error("commit failed"),
    cleanupFailure = new Error("cleanup failed");
  const source = integration(async function* () {
    try {
      yield { records: [{ id: 1 }], checkpoint: 1 };
    } finally {
      throw cleanupFailure;
    }
  });

  await assert.rejects(
    runSync(
      source,
      { sync: "items" },
      syncHost({
        async commit() {
          throw commitFailure;
        },
      }),
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(commitFailure) &&
      error.errors.includes(cleanupFailure),
  );
});

test("cancellation closes the generator and cannot commit another batch", async () => {
  const controller = new AbortController();
  let closed = false,
    commits = 0;
  const source = integration(async function* () {
    try {
      yield { records: [{ id: 1 }], checkpoint: 1 };
      yield { records: [{ id: 2 }], checkpoint: 2 };
    } finally {
      closed = true;
    }
  });

  await assert.rejects(
    runSync(
      source,
      { sync: "items", signal: controller.signal },
      syncHost({
        async commit() {
          commits++;
          controller.abort(new Error("cancelled"));

          return "continue";
        },
      }),
    ),
    /cancelled/,
  );

  assert.equal(closed, true);
  assert.equal(commits, 1);
});

test("execution drains submitted logs and cancels abandoned requests", async () => {
  const logs: string[] = [];
  let aborted = false;
  const source = integration(async function* (ctx) {
    void ctx.log.info("first");
    void ctx.log.info("second");
    void ctx.fetch("/pending");
    yield { records: [{ id: 1 }] };
  });

  await runSync(
    source,
    { sync: "items" },
    syncHost({
      async request(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal!.reason);
            },
            { once: true },
          );
        });

        throw new Error("unreachable");
      },
      async log(entry) {
        await Promise.resolve();
        logs.push(entry.message);
      },
    }),
  );

  assert.deepEqual(logs, ["first", "second"]);
  assert.equal(aborted, true);
});

test("pagination follows next requests through empty pages", async () => {
  const urls: string[] = [];
  const provider = createProvider(
    { origin: "https://provider.example" },
    {
      fetch: async (input) => {
        urls.push(String(input));

        return Response.json(
          urls.length === 1 ? { items: [], next: 1 } : { items: [{ id: 1 }], next: null },
        );
      },
    },
  );
  const source = integration(async function* (ctx) {
    for await (const page of ctx.paginate({
      request: { path: "/items" },
      schema: z.object({
        items: z.array(z.object({ id: z.number() })),
        next: z.number().nullable(),
      }),
      next: ({ data }) =>
        data.next === null
          ? undefined
          : { path: `https://provider.example/items?page=${data.next}` },
    })) {
      if (page.data.items.length) yield { records: page.data.items };
    }
  });
  const result = await runSync(
    source,
    { sync: "items" },
    {
      ...provider,
      async commit() {
        return "continue";
      },
    },
  );

  assert.deepEqual(urls, [
    "https://provider.example/items",
    "https://provider.example/items?page=1",
  ]);
  assert.equal(result.records, 1);
});

test("pagination rejects repetition, invalid data, and cross-origin requests", async () => {
  for (const failure of ["repeat", "schema", "origin"] as const) {
    const provider = createProvider(
      { origin: "https://provider.example" },
      { fetch: async () => Response.json(failure === "schema" ? { id: "bad" } : { id: 1 }) },
    );
    const source = integration(async function* (ctx) {
      for await (const page of ctx.paginate({
        request: { path: "/items" },
        schema: z.object({ id: z.number() }),
        next: () => ({ path: failure === "origin" ? "https://other.example/items" : "/items" }),
      }))
        yield { records: [page.data] };
    });

    await assert.rejects(
      runSync(
        source,
        { sync: "items" },
        {
          ...provider,
          async commit() {
            return "continue";
          },
        },
      ),
      failure === "repeat" ? /repeated/ : failure === "origin" ? /escaped/ : /number/,
    );
  }
});

test("json returns parsed output and exposes bounded HTTP errors", async () => {
  const source = integration(async function* (ctx) {
    const value = await ctx.json("/value", z.object({ id: z.string().transform(Number) }));
    const id: number = value.id;

    yield { records: [{ id }] };
    await assert.rejects(
      ctx.json("/error", z.unknown()),
      (error) => error instanceof HttpError && error.status === 403 && error.detail.length === 1000,
    );
  });
  const provider = createProvider(
    { origin: "https://provider.example" },
    {
      fetch: async (url) =>
        String(url).endsWith("/value")
          ? Response.json({ id: "42" })
          : new Response("x".repeat(2000), { status: 403 }),
    },
  );
  const result = await runSync(
    source,
    { sync: "items" },
    {
      ...provider,
      async commit(batch) {
        assert.equal(batch.records[0]?.id, 42);

        return "continue";
      },
    },
  );

  assert.equal(result.records, 1);
});

test("pagination rejects ambiguous paths before provider HTTP", async () => {
  for (const path of ["//other.example/items", "/\\other.example/items", "/items#fragment"]) {
    let requests = 0;
    const source = integration(async function* (ctx) {
      for await (const page of ctx.paginate({
        request: { path },
        schema: z.object({ id: z.number() }),
        next: () => undefined,
      })) {
        yield { records: [page.data] };
      }
    });

    await assert.rejects(
      runSync(
        source,
        { sync: "items" },
        syncHost({
          async request() {
            requests++;
            throw new Error("Should not request");
          },
        }),
      ),
      /relative provider path/,
    );
    assert.equal(requests, 0);
  }
});

test("execution validates custom host responses before exposing them to integration code", async () => {
  const source = integration(async function* (ctx) {
    await ctx.fetch("/items");
    yield { records: [] };
  });

  await assert.rejects(
    runSync(
      source,
      { sync: "items" },
      syncHost({
        async request() {
          return { status: 999, headers: [], body: new Uint8Array() };
        },
      }),
    ),
    /599/,
  );
});

test("mutating the initial checkpoint cannot advance committed state", async () => {
  const source = defineIntegration({
    key: "checkpoint",
    displayName: "Checkpoint",
    connection: { origin: "https://example.com" },
    syncs: (sync) => ({
      items: sync({
        records: z.object({ id: z.number() }),
        checkpoint: z.object({ cursor: z.number() }),
        async *run(ctx) {
          if (ctx.checkpoint) Reflect.set(ctx.checkpoint, "cursor", 2);
        },
      }),
    }),
  });
  const checkpoint = { cursor: 1 };
  const result = await runSync(source, { sync: "items", checkpoint }, syncHost());

  assert.deepEqual(checkpoint, { cursor: 1 });
  assert.deepEqual(result.checkpoint, { cursor: 1 });
});

test("merge rejects duplicate or conflicting keys within one batch", async () => {
  const integration = defineIntegration({
    key: "merge-conflict",
    displayName: "Merge conflict",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string() }),
        async *run(ctx) {
          yield { records: [{ id: "same" }], deletedKeys: [{ id: "same" }] };
        },
      }),
    }),
  });

  await assert.rejects(
    runSync(integration, { sync: "items" }, syncHost()),
    /Duplicate or conflicting merge deletion key/,
  );
});

test("checkpoint schemas cannot rewrite serialized values", async () => {
  const integration = defineIntegration({
    key: "normalized-checkpoint",
    displayName: "Normalized checkpoint",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        records: z.object({ id: z.number() }),
        checkpoint: z.coerce.number(),
        async *run(ctx) {
          yield { records: [{ id: 1 }], checkpoint: "1" as unknown as number };
        },
      }),
    }),
  });

  await assert.rejects(
    runSync(integration, { sync: "items" }, syncHost()),
    /must preserve the serialized JSON value/,
  );
});

test("runSync validates async schemas and transforms boundary values once", async () => {
  const emitted: unknown[] = [];
  const Record = z.object({
    value: z
      .string()
      .refine(async (value) => value.length > 0)
      .overwrite((value) => `${value}!`),
  });
  const integration = defineIntegration({
    key: "boundaries",
    displayName: "Boundaries",
    connection: {
      origin: "https://api.example.com",
      inputs: z.strictObject({ account: z.string() }),
    },
    syncs: (defineSync) => ({
      items: defineSync({
        displayName: "Items",
        inputs: z.strictObject({ limit: z.number().int() }),
        records: Record,
        checkpoint: z.number().int(),
        async *run(ctx) {
          assert.deepEqual(ctx.config, {
            connection: { account: "acme" },
            sync: { limit: 2 },
          });
          assert.equal(ctx.checkpoint, 1);

          yield {
            records: [{ value: "item" }],
            checkpoint: ctx.checkpoint + 1,
          };
        },
      }),
    }),
  });
  const result = await runSync(
    integration,
    {
      sync: "items",
      connectionConfig: { account: "acme" },
      syncConfig: { limit: 2 },
      checkpoint: 1,
    },
    syncHost({
      commit: async ({ sequence, records, checkpoint }) => {
        emitted.push({ sequence, records, checkpoint });

        return "continue";
      },
    }),
  );

  assert.deepEqual(emitted, [{ sequence: 0, records: [{ value: "item!" }], checkpoint: 2 }]);
  assert.deepEqual(result, {
    outcome: "completed",
    batches: 1,
    records: 1,
    deleted: 0,
    checkpoint: 2,
  });
});

test("batch change limits are checked before record parsing", async () => {
  let parsed = 0;
  const integration = defineIntegration({
    key: "bounded",
    displayName: "Bounded",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        records: z.object({
          id: z.string().overwrite((value) => {
            parsed += 1;

            return value;
          }),
        }),
        async *run(ctx) {
          yield {
            records: Array.from({ length: 10001 }, (_, id) => ({ id: String(id) })),
          };
        },
      }),
    }),
  });

  await assert.rejects(runSync(integration, { sync: "items" }, syncHost()), /exceeds 10000/);

  assert.equal(parsed, 0);
});

test("record outputs must be JSON-compatible", async () => {
  let emitted = false;
  const integration = defineIntegration({
    key: "json",
    displayName: "JSON",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        records: z.object({ value: z.unknown() }),
        async *run(ctx) {
          yield { records: [{ value: new Date() }] };
        },
      }),
    }),
  });

  await assert.rejects(
    runSync(
      integration,
      { sync: "items" },
      syncHost({
        commit: async () => {
          emitted = true;

          return "continue";
        },
      }),
    ),
    /JSON-compatible/,
  );

  assert.equal(emitted, false);
});
