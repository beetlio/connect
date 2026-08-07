import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { auth, credential, defineIntegration, defineSync, z } from "@beetlio/connect";
import { runSync, type ProviderRequest } from "@beetlio/connect/host";
import { LocalHost } from "../src/local-host.ts";
import { fixtureDirectory } from "./support.ts";

const Request: ProviderRequest = { method: "GET", path: "/events", headers: [] };

test("authentication stays on secure origins and supports declarative fields", async () => {
  let calls = 0;
  let authorization = "";
  const authenticated = {
    auth: auth.bearer(),
    credentials: { token: "secret" },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls += 1;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(null, { status: 204 });
    },
  };

  await assert.rejects(
    new LocalHost({ ...authenticated, origin: "http://example.com" }).request(Request),
    /require HTTPS/,
  );
  assert.equal(calls, 0);
  await new LocalHost({ ...authenticated, origin: "http://127.0.0.1" }).request(Request);
  assert.equal(authorization, "Bearer secret");

  let url = "";
  let account = "";
  const custom = new LocalHost({
    origin: "https://api.example.com",
    auth: auth.custom({
      credentials: credential.object({
        account: credential.string(),
        apiKey: credential.secret(),
      }),
      headers: { "x-account": "account" },
      query: { api_key: "apiKey" },
    }),
    credentials: { account: "acct_123", apiKey: "secret" },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (input, init) => {
      url = String(input);
      account = new Headers(init?.headers).get("x-account") ?? "";
      return new Response(null, { status: 204 });
    },
  });
  await custom.request(Request);
  assert.equal(url, "https://api.example.com/events?api_key=secret");
  assert.equal(account, "acct_123");
});

test("retry policy retries transient responses and can be disabled", async () => {
  let calls = 0;
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: calls < 3 ? 503 : 204,
        headers: { "retry-after": "0" },
      });
    },
  });
  const response = await host.request({
    ...Request,
    retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
  });
  assert.equal(response.status, 204);
  assert.equal(calls, 3);

  calls = 0;
  const singleAttempt = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });
  assert.equal((await singleAttempt.request({ ...Request, retry: false })).status, 503);
  assert.equal(calls, 1);
});

test("OAuth refresh is single-flight and isolated from waiter cancellation", async () => {
  const oauth = auth.oauth2AuthorizationCode({
    issuer: "https://provider.example",
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    scopes: ["events.read"],
    tokenFields: { instanceUrl: "instance_url" },
  });
  let refreshes = 0;
  let saved:
    | {
        readonly accessToken: string;
        readonly refreshToken?: string;
        readonly tokenFields: Readonly<Record<string, string>>;
      }
    | undefined;
  let notifyRefreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const refreshStarted = new Promise<void>((resolve) => (notifyRefreshStarted = resolve));
  const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
  const host = new LocalHost({
    origin: { oauthTokenField: "instanceUrl" },
    auth: oauth,
    credentials: { clientId: "client-id" },
    authorizationState: {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      tokenFields: { instanceUrl: "https://old.example" },
    },
    outputPath: "unused",
    statePath: "unused",
    onAuthorizationStateChanged: (authorizationState) => void (saved = authorizationState),
    fetch: async (input, init) => {
      const url = String(input);
      if (url === "https://provider.example/token") {
        refreshes += 1;
        notifyRefreshStarted();
        await refreshGate;
        return Response.json({
          access_token: "fresh-token",
          token_type: "Bearer",
          instance_url: "https://new.example",
        });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer expired-token") {
        return new Response(null, { status: 401 });
      }
      assert.equal(url, "https://new.example/events");
      return new Response(null, { status: 204 });
    },
  });

  const controller = new AbortController();
  const cancelled = host.request(Request, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  await refreshStarted;
  const active = host.request(Request);
  controller.abort(new Error("request cancelled"));
  releaseRefresh();

  assert.match(String(await cancelled), /request cancelled/);
  assert.equal((await active).status, 204);
  assert.equal(refreshes, 1);
  assert.deepEqual(saved, {
    accessToken: "fresh-token",
    refreshToken: "refresh-token",
    tokenFields: { instanceUrl: "https://new.example" },
  });
});

test("provider responses have a hard size limit", async () => {
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
  });
  await assert.rejects(host.request({ ...Request, retry: false }), /exceeds 16 MiB/);

  const bodyless = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () =>
      new Response(null, { headers: { "content-length": String(32 * 1024 * 1024) } }),
  });
  const response = await bodyless.request({ ...Request, method: "HEAD", retry: false });
  assert.equal(response.body.byteLength, 0);
});

test("checkpoint replacement uses private exclusive files", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-checkpoint");
  const statePath = join(directory, "state.json");
  const predictableTemporaryPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(predictableTemporaryPath, "reserved");
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: join(directory, "items.ndjson"),
    statePath,
  });

  await host.emit({ batchId: "batch", sequence: 0, records: [], checkpoint: { cursor: "next" } });

  assert.equal(await readFile(predictableTemporaryPath, "utf8"), "reserved");
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { cursor: "next" });
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("snapshot output is replaced only after a successful run", async (t) => {
  const directory = await fixtureDirectory(t, "beetl-snapshot");
  const outputPath = join(directory, "items.ndjson");
  let records = [{ id: 1 }, { id: 2 }];
  let fail = false;
  const integration = defineIntegration({
    key: "snapshot",
    displayName: "Snapshot",
    connection: { origin: "https://api.example.com" },
    syncs: [
      defineSync({
        key: "items",
        displayName: "Items",
        mode: "snapshot",
        records: z.object({ id: z.number() }),
        async run(ctx) {
          await ctx.emit({ records });
          if (fail) throw new Error("snapshot failed");
        },
      }),
    ],
  });
  const host = new LocalHost({
    origin: integration.connection.origin,
    outputPath,
    statePath: join(directory, "state.json"),
    onLog: () => undefined,
  });

  await writeFile(outputPath, '{"id":0}\n');
  await runSync(integration, "items", {}, host);
  assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');

  records = [{ id: 3 }];
  fail = true;
  await assert.rejects(runSync(integration, "items", {}, host), /snapshot failed/);
  assert.equal(await readFile(outputPath, "utf8"), '{"id":1}\n{"id":2}\n');
  assert.deepEqual(await readdir(directory), ["items.ndjson"]);
});
