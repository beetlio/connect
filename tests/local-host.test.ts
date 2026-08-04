import assert from "node:assert/strict";
import test from "node:test";

import { auth, z } from "@beetlio/connect";
import { LocalHost } from "../src/local-host.ts";

const request = {
  method: "GET",
  path: "/events",
  headers: [],
};

test("local host only sends credentials over HTTPS or loopback HTTP", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
    return new Response(null, { status: 204 });
  };

  const options = {
    auth: auth.bearer(),
    credentialSchema: z.object({ token: z.string() }),
    credentials: { token: "secret" },
    outputPath: "unused",
    statePath: "unused",
    fetch,
  };
  await assert.rejects(
    new LocalHost({ ...options, baseUrl: "http://example.com" }).request(request),
    /require HTTPS/,
  );
  assert.equal(calls, 0);

  await new LocalHost({ ...options, baseUrl: "http://127.0.0.1" }).request(request);
  assert.equal(calls, 1);
});

test("OAuth authorization-code metadata uses a bearer access token", async () => {
  const oauth = auth.oauth2AuthorizationCode({
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    scopes: ["accounts.read"],
  });
  assert.deepEqual(oauth, {
    type: "oauth2_authorization_code",
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    scopes: ["accounts.read"],
    clientId: "clientId",
    accessToken: "accessToken",
    tokenFields: {},
  });

  let authorization: string | null = null;
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    auth: oauth,
    credentialSchema: z.object({ accessToken: z.string() }),
    credentials: { accessToken: "access-token" },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: 204 });
    },
  });

  await host.request(request);
  assert.equal(authorization, "Bearer access-token");
});

test("OAuth connections refresh after 401 and update a credential-derived base URL", async () => {
  const oauth = auth.oauth2AuthorizationCode({
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    scopes: ["accounts.read"],
    clientSecret: "clientSecret",
    refreshToken: "refreshToken",
    tokenFields: { instanceUrl: "instance_url" },
  });
  const requests: string[] = [];
  let saved: Readonly<Record<string, string>> | undefined;
  const host = new LocalHost({
    baseUrl: { credential: "instanceUrl" },
    auth: oauth,
    integrationCredentialSchema: z.object({
      clientId: z.string(),
      clientSecret: z.string(),
    }),
    integrationCredentials: {
      clientId: "client-id",
      clientSecret: "client-secret",
    },
    credentialSchema: z.object({
      accessToken: z.string(),
      refreshToken: z.string(),
      instanceUrl: z.string(),
    }),
    credentials: {
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      instanceUrl: "https://old.example",
    },
    outputPath: "unused",
    statePath: "unused",
    onCredentialsChanged(credentials) {
      saved = credentials;
    },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://provider.example/token") {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "refresh-token");
        assert.equal(body.get("client_id"), "client-id");
        assert.equal(body.get("client_secret"), "client-secret");
        return Response.json({
          access_token: "fresh-token",
          instance_url: "https://new.example",
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      return url === "https://old.example/events"
        ? new Response(null, { status: 401 })
        : new Response(null, {
          status: authorization === "Bearer fresh-token" ? 204 : 403,
        });
    },
  });

  const response = await host.request(request);
  assert.equal(response.status, 204);
  assert.deepEqual(requests, [
    "https://old.example/events",
    "https://provider.example/token",
    "https://new.example/events",
  ]);
  assert.deepEqual(saved, {
    accessToken: "fresh-token",
    refreshToken: "refresh-token",
    instanceUrl: "https://new.example",
  });
});

test("local host applies declarative multi-field authentication", async () => {
  let url = "";
  let account = "";
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    auth: auth.custom({
      headers: { "x-account": "accountId" },
      query: { api_key: "apiKey" },
    }),
    credentialSchema: z.object({
      accountId: z.string(),
      apiKey: z.string(),
    }),
    credentials: {
      accountId: "acct_123",
      apiKey: "secret",
    },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (input, init) => {
      url = String(input);
      account = new Headers(init?.headers).get("x-account") ?? "";
      return new Response(null, { status: 204 });
    },
  });

  await host.request(request);
  assert.equal(url, "https://provider.example/events?api_key=secret");
  assert.equal(account, "acct_123");
});

test("local host applies basic authentication from typed credentials", async () => {
  let authorization = "";
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    auth: auth.basic(),
    credentialSchema: z.object({
      username: z.string(),
      password: z.string(),
    }),
    credentials: { username: "user", password: "secret" },
    outputPath: "unused",
    statePath: "unused",
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(null, { status: 204 });
    },
  });

  await host.request(request);
  assert.equal(
    authorization,
    `Basic ${Buffer.from("user:secret").toString("base64")}`,
  );
});

test("local host performs configured safe retries", async () => {
  let calls = 0;
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      return calls < 3
        ? new Response(null, {
          status: 503,
          headers: { "retry-after": "0" },
        })
        : new Response(null, { status: 204 });
    },
  });

  const response = await host.request({
    ...request,
    retry: {
      maxAttempts: 3,
      statuses: [503],
      methods: ["GET"],
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
  });
  assert.equal(response.status, 204);
  assert.equal(calls, 3);
});

test("local host retries transient transport failures", async () => {
  let calls = 0;
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("connection reset");
      }
      if (calls === 2) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(new TypeError("response body interrupted"));
          },
        }));
      }
      return new Response(null, { status: 204 });
    },
  });

  const response = await host.request({
    ...request,
    retry: {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
  });
  assert.equal(response.status, 204);
  assert.equal(calls, 3);
});

test("retry false performs exactly one request", async () => {
  let calls = 0;
  const host = new LocalHost({
    baseUrl: "https://provider.example",
    outputPath: "unused",
    statePath: "unused",
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });

  const response = await host.request({ ...request, retry: false });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});
