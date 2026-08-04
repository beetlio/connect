import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  auth,
  type CredentialSchema,
  defineIntegration,
  defineSync,
  z,
} from "@beetlio/connect";
import {
  runSync,
  type SyncHost,
  verifyConnection,
} from "@beetlio/connect/host";
import { LocalHost } from "../src/local-host.ts";

const Item = z.object({ id: z.number().int(), name: z.string() });

test("local host runs a paginated sync and resumes from its checkpoint", async () => {
  const seenAuthorization: string[] = [];
  const allItems = [
    { id: 1, name: "one" },
    { id: 2, name: "two" },
    { id: 3, name: "three" },
  ];
  const server = createServer((request, response) => {
    seenAuthorization.push(request.headers.authorization ?? "");
    const url = new URL(request.url ?? "/", "http://fixture");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 2);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(allItems.slice(offset, offset + limit)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const directory = await mkdtemp(join(tmpdir(), "beetl-connect-"));
  const outputPath = join(directory, "items.ndjson");
  const statePath = join(directory, "items.state.json");

  try {
    const items = defineSync({
      key: "items",
      displayName: "Items",
      records: Item,
      checkpoint: z.object({ offset: z.number().int().nonnegative() }),
      config: z.object({ pageSize: z.number().int().default(2) }),
      async run(ctx) {
        let offset = ctx.checkpoint?.offset ?? 0;
        for await (const page of ctx.paginate({
          path: "/items",
          records: Item,
          pagination: {
            initialOffset: offset,
            limit: ctx.config.sync.pageSize,
          },
        })) {
          offset += page.records.length;
          await ctx.emit({ records: page.records, checkpoint: { offset } });
        }
      },
    });
    const integration = defineIntegration({
      key: "fixture",
      displayName: "Fixture",
      connection: {
        baseUrl: baseUrl(server.address() as AddressInfo),
        credentials: z.object({ token: z.string() }),
        auth: auth.bearer(),
        pagination: {
          type: "offset",
          offsetParameter: "offset",
          limitParameter: "limit",
        },
      },
      syncs: [items],
    });
    const host = new LocalHost({
      baseUrl: integration.connection.baseUrl,
      ...(integration.connection.auth === undefined
        ? {}
        : { auth: integration.connection.auth }),
      credentialSchema: integration.connection.credentials!,
      credentials: { token: "local-secret" },
      outputPath,
      statePath,
      onLog: () => undefined,
    });

    const first = await runSync(
      integration,
      "items",
      { checkpoint: await host.loadCheckpoint() },
      host,
    );
    assert.deepEqual(first, {
      batches: 2,
      records: 3,
      checkpoint: { offset: 3 },
    });
    assert.deepEqual(await host.loadCheckpoint(), { offset: 3 });
    assert.deepEqual(
      (await readFile(outputPath, "utf8")).trim().split("\n").map((line) =>
        JSON.parse(line)
      ),
      allItems,
    );
    assert.ok(seenAuthorization.every((value) => value === "Bearer local-secret"));

    const second = await runSync(
      integration,
      "items",
      { checkpoint: await host.loadCheckpoint() },
      host,
    );
    assert.deepEqual(second, {
      batches: 0,
      records: 0,
      checkpoint: { offset: 3 },
    });
    assert.equal(
      (await readFile(outputPath, "utf8")).trim().split("\n").length,
      3,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot sync atomically replaces output only after success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beetl-snapshot-"));
  const outputPath = join(directory, "items.ndjson");
  const statePath = join(directory, "items.state.json");
  let source = [{ id: 1 }, { id: 2 }];
  let fail = false;
  const sync = defineSync({
    key: "items",
    displayName: "Items",
    mode: "snapshot",
    records: z.object({ id: z.number() }),
    async run(ctx) {
      if (source.length > 0) {
        await ctx.emit({ records: source });
      }
      if (fail) {
        throw new Error("snapshot failed");
      }
    },
  });
  const integration = defineIntegration({
    key: "snapshot",
    displayName: "Snapshot",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host = new LocalHost({
    baseUrl: integration.connection.baseUrl,
    outputPath,
    statePath,
    onLog: () => undefined,
  });

  try {
    await writeFile(outputPath, '{"id":0}\n');
    assert.deepEqual(await runSync(integration, "items", {}, host), {
      batches: 1,
      records: 2,
    });
    assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');

    source = [{ id: 3 }];
    fail = true;
    await assert.rejects(
      runSync(integration, "items", {}, host),
      /snapshot failed/,
    );
    assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');
    assert.deepEqual(await readdir(directory), ["items.ndjson"]);

    source = [];
    fail = false;
    assert.deepEqual(await runSync(integration, "items", {}, host), {
      batches: 0,
      records: 0,
    });
    assert.equal(await readFile(outputPath, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ctx.paginate lazily yields structured cursor pages", async () => {
  const requests: string[] = [];
  const nextPageParams: Array<string | number | undefined> = [];
  const sync = defineSync({
    key: "cursor",
    displayName: "Cursor",
    records: Item,
    async run(ctx) {
      for await (const page of ctx.paginate({
        path: "/items",
        records: Item,
        pagination: { limit: 2 },
      })) {
        nextPageParams.push(page.nextPageParam);
        await ctx.emit({ records: page.records });
      }
    },
  });
  const integration = defineIntegration({
    key: "cursor",
    displayName: "Cursor",
    connection: {
      baseUrl: "https://example.com",
      pagination: {
        type: "cursor",
        cursorParameter: "after",
        cursorPath: "paging.next",
        limitParameter: "limit",
        responsePath: "data",
      },
    },
    syncs: [sync],
  });
  const emitted: unknown[] = [];
  const host: SyncHost = {
    async request(request) {
      requests.push(request.path);
      const after = new URL(request.path, "https://example.com").searchParams.get("after");
      const body = after === null
        ? { data: [{ id: 1, name: "one" }, { id: 2, name: "two" }], paging: { next: "two" } }
        : { data: [{ id: 3, name: "three" }], paging: {} };
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    },
    async emit(batch) {
      emitted.push(...batch.records);
    },
    async log() {},
  };

  const result = await runSync(integration, "cursor", {}, host);
  assert.deepEqual(result, { batches: 2, records: 3 });
  assert.deepEqual(requests, ["/items?limit=2", "/items?after=two&limit=2"]);
  assert.deepEqual(nextPageParams, ["two", undefined]);
  assert.equal(emitted.length, 3);
});

test("verifyConnection uses connection config and the host fetch boundary", async () => {
  let requested = "";
  const integration = defineIntegration({
    key: "verified",
    displayName: "Verified",
    connection: {
      baseUrl: "https://example.com",
      config: z.object({ account: z.string() }),
      async verify(ctx) {
        const response = await ctx.fetch(`/accounts/${ctx.config.account}`);
        if (!response.ok) {
          throw new Error("verification failed");
        }
      },
    },
    syncs: [],
  });
  const host: SyncHost = {
    async request(request) {
      requested = request.path;
      return { status: 204, headers: [], body: new Uint8Array() };
    },
    async emit() {},
    async log() {},
  };

  await verifyConnection(
    integration,
    { connectionConfig: { account: "acme" } },
    host,
  );
  assert.equal(requested, "/accounts/acme");
});

test("runSync rejects authentication references missing from the credential schema", async () => {
  const sync = defineSync({
    key: "invalid-auth",
    displayName: "Invalid auth",
    records: z.string(),
    async run() {},
  });
  const integration = defineIntegration({
    key: "invalid-auth",
    displayName: "Invalid auth",
    connection: {
      baseUrl: "https://example.com",
      credentials: z.object({ token: z.string() }),
      auth: auth.bearer({ credential: "missing" }),
    },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "invalid-auth", {}, host),
    /unknown credential "missing"/,
  );
});

test("credential schemas only produce strings", () => {
  const credentials: CredentialSchema = z.object({
    token: z.string(),
    optionalSecret: z.string().optional(),
  });
  assert.ok(credentials);

  if (false) {
    // @ts-expect-error Credential values must be strings.
    const invalid: CredentialSchema = z.object({ token: z.number() });
    assert.ok(invalid);
  }
});

test("connection retry policy is carried through ctx.fetch to the local host", async () => {
  let calls = 0;
  const sync = defineSync({
    key: "retried",
    displayName: "Retried",
    records: z.string(),
    async run(ctx) {
      const response = await ctx.fetch("/temporary");
      assert.equal(response.status, 204);
    },
  });
  const integration = defineIntegration({
    key: "retried",
    displayName: "Retried",
    connection: {
      baseUrl: "https://example.com",
      retry: {
        maxAttempts: 2,
        statuses: [503],
        methods: ["GET"],
        initialDelayMs: 0,
        maxDelayMs: 0,
      },
    },
    syncs: [sync],
  });
  const host = new LocalHost({
    baseUrl: integration.connection.baseUrl,
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 204 });
    },
    onLog: () => undefined,
  });

  await runSync(integration, "retried", {}, host);
  assert.equal(calls, 2);
});

test("runSync validates records before calling the host", async () => {
  let emitted = false;
  const invalid = defineSync({
    key: "invalid",
    displayName: "Invalid",
    records: z.object({ id: z.string() }),
    async run(ctx) {
      // @ts-expect-error Deliberately prove that the runtime boundary also rejects bad data.
      await ctx.emit({ records: [{ id: 42 }] });
    },
  });
  const integration = defineIntegration({
    key: "invalid",
    displayName: "Invalid",
    connection: { baseUrl: "https://example.com" },
    syncs: [invalid],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {
      emitted = true;
    },
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "invalid", {}, host),
    /Invalid record 0/,
  );
  assert.equal(emitted, false);
});

test("runSync parses record and checkpoint inputs into schema outputs", async () => {
  const emitted: unknown[] = [];
  const checkpoints: unknown[] = [];
  const sync = defineSync({
    key: "transformed",
    displayName: "Transformed",
    records: z.string().transform((value) => Number(value)),
    checkpoint: z.string().transform((value) => Number(value)),
    async run(ctx) {
      assert.equal(ctx.checkpoint, 1);
      await ctx.emit({ records: ["2"], checkpoint: "3" });
      if (false) {
        // @ts-expect-error Emits accept schema inputs, not parsed outputs.
        await ctx.emit({ records: [2], checkpoint: 3 });
      }
    },
  });
  const integration = defineIntegration({
    key: "transformed",
    displayName: "Transformed",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit(batch) {
      emitted.push(...batch.records);
      checkpoints.push(batch.checkpoint);
    },
    async log() {},
  };

  const result = await runSync(
    integration,
    "transformed",
    { checkpoint: "1" },
    host,
  );
  assert.deepEqual(emitted, [2]);
  assert.deepEqual(checkpoints, [3]);
  assert.deepEqual(result, { batches: 1, records: 1, checkpoint: 3 });
});

test("cursor pagination treats numeric and string cursors as equivalent", async () => {
  let requests = 0;
  const sync = defineSync({
    key: "normalized-cursor",
    displayName: "Normalized cursor",
    records: Item,
    async run(ctx) {
      for await (const page of ctx.paginate({
        path: "/items",
        records: Item,
        pagination: {
          type: "cursor",
          cursorParameter: "after",
          cursorPath: "paging.next",
          limitParameter: "limit",
          responsePath: "data",
          initialCursor: 1,
        },
      })) {
        assert.equal(page.nextPageParam, undefined);
      }
    },
  });
  const integration = defineIntegration({
    key: "normalized-cursor",
    displayName: "Normalized cursor",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      requests += 1;
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(JSON.stringify({
          data: [{ id: 1, name: "one" }],
          paging: { next: "1" },
        })),
      };
    },
    async emit() {},
    async log() {},
  };

  await runSync(integration, "normalized-cursor", {}, host);
  assert.equal(requests, 1);
});

test("runSync stops queued emissions after the first host failure", async () => {
  const emittedSequences: number[] = [];
  const sync = defineSync({
    key: "queued",
    displayName: "Queued",
    records: z.object({ id: z.number() }),
    checkpoint: z.object({ offset: z.number() }),
    async run(ctx) {
      const first = ctx.emit({ records: [{ id: 1 }], checkpoint: { offset: 1 } });
      const second = ctx.emit({ records: [{ id: 2 }], checkpoint: { offset: 2 } });
      await Promise.allSettled([first, second]);
    },
  });
  const integration = defineIntegration({
    key: "queued",
    displayName: "Queued",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit(batch) {
      emittedSequences.push(batch.sequence);
      throw new Error("host failed");
    },
    async log() {},
  };

  await assert.rejects(runSync(integration, "queued", {}, host), /host failed/);
  assert.deepEqual(emittedSequences, [0]);
});

test("ctx.emit snapshots mutable checkpoints before queueing", async () => {
  const checkpoints: unknown[] = [];
  const checkpoint = { offset: 1 };
  const sync = defineSync({
    key: "snapshots",
    displayName: "Snapshots",
    records: z.object({ id: z.number() }),
    checkpoint: z.object({ offset: z.number() }),
    async run(ctx) {
      const first = ctx.emit({ records: [{ id: 1 }], checkpoint });
      checkpoint.offset = 2;
      const second = ctx.emit({ records: [{ id: 2 }], checkpoint });
      await Promise.all([first, second]);
    },
  });
  const integration = defineIntegration({
    key: "snapshots",
    displayName: "Snapshots",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit(batch) {
      checkpoints.push(batch.checkpoint);
    },
    async log() {},
  };

  await runSync(integration, "snapshots", {}, host);
  assert.deepEqual(checkpoints, [{ offset: 1 }, { offset: 2 }]);
});

test("runSync closes capabilities after the sync returns", async () => {
  let emitAfterReturn: (() => Promise<void>) | undefined;
  let emitted = false;
  const sync = defineSync({
    key: "closed",
    displayName: "Closed",
    records: z.string(),
    async run(ctx) {
      emitAfterReturn = () => ctx.emit({ records: ["late"] });
    },
  });
  const integration = defineIntegration({
    key: "closed",
    displayName: "Closed",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {
      emitted = true;
    },
    async log() {},
  };

  await runSync(integration, "closed", {}, host);
  assert.ok(emitAfterReturn);
  await assert.rejects(emitAfterReturn(), /Sync context is closed/);
  assert.equal(emitted, false);
});

test("runSync reports failures from unawaited host operations", async () => {
  const sync = defineSync({
    key: "unawaited-request",
    displayName: "Unawaited request",
    records: z.string(),
    async run(ctx) {
      void ctx.fetch("/fail");
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });
  const integration = defineIntegration({
    key: "unawaited-request",
    displayName: "Unawaited request",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("request failed");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "unawaited-request", {}, host),
    /request failed/,
  );
});

test("verifyConnection reports failures from unawaited host operations", async () => {
  const integration = defineIntegration({
    key: "unawaited-verification",
    displayName: "Unawaited verification",
    connection: {
      baseUrl: "https://example.com",
      async verify(ctx) {
        void ctx.fetch("/fail");
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
    syncs: [],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("verification request failed");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    verifyConnection(integration, {}, host),
    /verification request failed/,
  );
});

test("runSync drains a queued emission before reporting a run failure", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hostStarted = false;
  let runSettled = false;
  const sync = defineSync({
    key: "drain",
    displayName: "Drain",
    records: z.string(),
    async run(ctx) {
      void ctx.emit({ records: ["started"] });
      throw new Error("run failed");
    },
  });
  const integration = defineIntegration({
    key: "drain",
    displayName: "Drain",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {
      hostStarted = true;
      await gate;
    },
    async log() {},
  };

  const running = runSync(integration, "drain", {}, host);
  void running.finally(() => {
    runSettled = true;
  }).catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(hostStarted, true);
  assert.equal(runSettled, false);
  release?.();
  await assert.rejects(running, /run failed/);
});

test("runSync rejects a run that returns after cancellation", async () => {
  const controller = new AbortController();
  const sync = defineSync({
    key: "cancelled",
    displayName: "Cancelled",
    records: z.string(),
    async run() {
      controller.abort(new Error("cancelled"));
    },
  });
  const integration = defineIntegration({
    key: "cancelled",
    displayName: "Cancelled",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "cancelled", { signal: controller.signal }, host),
    /cancelled/,
  );
});

test("runSync rejects non-JSON objects accepted by broad schemas", async () => {
  let emitted = false;
  const sync = defineSync({
    key: "non-json",
    displayName: "Non-JSON",
    records: z.any(),
    async run(ctx) {
      await ctx.emit({ records: [new Date()] });
    },
  });
  const integration = defineIntegration({
    key: "non-json",
    displayName: "Non-JSON",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("not used");
    },
    async emit() {
      emitted = true;
    },
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "non-json", {}, host),
    /schema output must be JSON-compatible/,
  );
  assert.equal(emitted, false);
});

test("ctx.fetch rejects absolute and scheme-relative URLs", async () => {
  const escaping = defineSync({
    key: "escaping",
    displayName: "Escaping",
    records: z.object({ id: z.string() }),
    async run(ctx) {
      await ctx.fetch("//example.net/escape");
    },
  });
  const integration = defineIntegration({
    key: "escaping",
    displayName: "Escaping",
    connection: { baseUrl: "https://example.com" },
    syncs: [escaping],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("request should not reach host");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "escaping", {}, host),
    /relative-origin path/,
  );
});

test("ctx.paginate rejects absolute and scheme-relative URLs", async () => {
  const escaping = defineSync({
    key: "escaping-pages",
    displayName: "Escaping pages",
    records: z.string(),
    async run(ctx) {
      for await (const _page of ctx.paginate({
        path: "https://example.net/escape",
        records: z.string(),
        pagination: {
          type: "offset",
          offsetParameter: "offset",
          limitParameter: "limit",
          limit: 10,
        },
      })) {
        throw new Error("unreachable");
      }
    },
  });
  const integration = defineIntegration({
    key: "escaping-pages",
    displayName: "Escaping pages",
    connection: { baseUrl: "https://example.com" },
    syncs: [escaping],
  });
  const host: SyncHost = {
    async request() {
      throw new Error("request should not reach host");
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "escaping-pages", {}, host),
    /ctx\.paginate requires a relative-origin path/,
  );
});

test("ctx.fetch preserves body-generated content headers", async () => {
  let contentType: string | null = null;
  let body = "";
  const sync = defineSync({
    key: "form",
    displayName: "Form",
    records: z.string(),
    async run(ctx) {
      await ctx.fetch("/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
    },
  });
  const integration = defineIntegration({
    key: "form",
    displayName: "Form",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request(request) {
      contentType = new Headers(
        request.headers.map(([name, value]): [string, string] => [name, value]),
      ).get("content-type");
      body = new TextDecoder().decode(request.body);
      return { status: 204, headers: [], body: new Uint8Array() };
    },
    async emit() {},
    async log() {},
  };

  await runSync(integration, "form", {}, host);
  assert.match(contentType ?? "", /^application\/x-www-form-urlencoded/);
  assert.equal(body, "grant_type=client_credentials");
});

test("ctx.fetch forwards per-request cancellation", async () => {
  const controller = new AbortController();
  const sync = defineSync({
    key: "request-cancellation",
    displayName: "Request cancellation",
    records: z.string(),
    async run(ctx) {
      const request = ctx.fetch("/slow", { signal: controller.signal });
      controller.abort(new Error("request cancelled"));
      await request;
    },
  });
  const integration = defineIntegration({
    key: "request-cancellation",
    displayName: "Request cancellation",
    connection: { baseUrl: "https://example.com" },
    syncs: [sync],
  });
  const host: SyncHost = {
    async request(_request, signal) {
      assert.ok(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    async emit() {},
    async log() {},
  };

  await assert.rejects(
    runSync(integration, "request-cancellation", {}, host),
    /request cancelled/,
  );
});

test("integration-bound syncs infer connection config and optional fields", () => {
  const integration = defineIntegration({
    key: "typed",
    displayName: "Typed",
    connection: {
      baseUrl: "https://example.com",
      config: z.object({ apiVersion: z.string() }),
    },
    syncs: (defineSync) => [defineSync({
      key: "typed",
      displayName: "Typed",
      records: z.object({
        id: z.string(),
        nickname: z.string().optional(),
      }),
      checkpoint: z.object({ after: z.string().optional() }),
      async run(ctx) {
        const apiVersion: string = ctx.config.connection.apiVersion;
        await ctx.emit({ records: [{ id: apiVersion }], checkpoint: {} });
        if (false) {
          // @ts-expect-error The connection schema has no missing field.
          ctx.config.connection.missing;
          // @ts-expect-error Record IDs remain inferred as strings.
          await ctx.emit({ records: [{ id: 1 }] });
        }
      },
    })],
  });

  assert.equal(integration.syncs[0]?.key, "typed");
});

function baseUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}`;
}
