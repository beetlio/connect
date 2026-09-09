import assert from "node:assert/strict";
import test from "node:test";
import { auth, credential, defineIntegration, input, z } from "@beetlio/connect";
import { validateIntegration } from "@beetlio/connect/host";
import { LocalHost, resolveProviderOrigin } from "@beetlio/connect/local-host";
import { beginOAuthAuthorization, completeOAuthAuthorization } from "@beetlio/connect/oauth";

test("configured origins are validated before credentials leave the host", () => {
  assert.equal(
    resolveProviderOrigin({ input: "origin" }, undefined, true, {
      origin: "https://shop.example.com",
    }).origin,
    "https://shop.example.com",
  );
  for (const origin of [
    "http://example.com",
    "https://secret@example.com",
    "https://example.com/path",
    "file:///tmp/test",
  ]) {
    assert.throws(() => resolveProviderOrigin({ input: "origin" }, undefined, true, { origin }));
  }
  const definition = defineIntegration({
    key: "tenant",
    displayName: "Tenant",
    connection: {
      origin: { input: "origin" },
      inputs: input.object({ origin: input.string({ format: "url" }) }),
      auth: auth.bearer(),
    },
    syncs: (define) => [
      define({
        key: "rows",
        displayName: "Rows",
        records: z.object({ id: z.string() }),
        async run() {},
      }),
    ],
  });
  assert.doesNotThrow(() => validateIntegration(definition));
  assert.throws(() =>
    validateIntegration({
      ...definition,
      connection: { ...definition.connection, inputs: input.object({ origin: input.string() }) },
    }),
  );
});

test("JSON session login injects original credentials and renewed session headers", async () => {
  let exchanges = 0;
  let dataCalls = 0;
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    credentials: { username: "tester", password: "secret", devKey: "developer" },
    auth: auth.tokenExchange({
      credentials: credential.object({
        username: credential.string(),
        password: credential.secret(),
        devKey: credential.secret(),
      }),
      tokenUrl: "/login",
      body: {
        encoding: "json",
        fields: { username: "username", password: "password", devKey: "devKey" },
      },
      tokenPath: "sessionId",
      expiresInSeconds: 1800,
      tokenHeader: "sessionId",
      tokenPrefix: "",
      requestHeaders: { devKey: "devKey" },
    }),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/login")) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          username: "tester",
          password: "secret",
          devKey: "developer",
        });
        return Response.json({ sessionId: `session-${++exchanges}` });
      }
      assert.equal(headers.get("devKey"), "developer");
      assert.equal(headers.get("sessionId"), `session-${exchanges}`);
      assert.equal(headers.has("authorization"), false);
      return new Response(null, { status: ++dataCalls === 1 ? 401 : 204 });
    },
  });
  assert.equal((await host.request({ method: "GET", path: "/records", headers: [] })).status, 204);
  assert.equal(exchanges, 2);
  assert.equal((await host.request({ method: "GET", path: "/records", headers: [] })).status, 204);
  assert.equal(exchanges, 2);
});

test("form client credentials support basic authentication and relative token expiry", async () => {
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    credentials: { clientId: "a b~!", clientSecret: "s p~!" },
    auth: auth.tokenExchange({
      credentials: credential.object({
        clientId: credential.string(),
        clientSecret: credential.secret(),
      }),
      tokenUrl: "/token",
      basic: { username: "clientId", password: "clientSecret" },
      body: {
        encoding: "form",
        fields: {},
        values: { grant_type: "client_credentials", scope: "expenses:read" },
      },
      tokenPath: "access_token",
      expiresInPath: "expires_in",
    }),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (String(url).endsWith("/token")) {
        assert.equal(
          headers.get("authorization"),
          `Basic ${Buffer.from("a+b%7E%21:s+p%7E%21").toString("base64")}`,
        );
        assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
        assert.equal(new URLSearchParams(String(init?.body)).get("scope"), "expenses:read");
        return Response.json({ access_token: "access", expires_in: 3600 });
      }
      assert.equal(headers.get("authorization"), "Bearer access");
      return new Response(null, { status: 204 });
    },
  });
  await host.request({ method: "GET", path: "/records", headers: [] });
});

test("tenant OAuth authorization and token exchange use the same resolved account", async () => {
  const definition = auth.oauth2AuthorizationCode({
    issuer: "/",
    authorizationUrl: "/oauth/authorize",
    tokenUrl: "/oauth/token",
    scopes: ["read"],
    clientSecret: true,
  });
  assert.equal(definition.type, "oauth2_authorization_code");
  if (definition.type !== "oauth2_authorization_code") throw new Error("Invalid auth");
  const options = {
    auth: definition,
    origin: "https://tenant.example.com",
    credentials: { clientId: "client", clientSecret: "secret" },
    redirectUri: "http://127.0.0.1:53682/oauth/callback",
  };
  const request = await beginOAuthAuthorization(options);
  assert.equal(new URL(request.authorizationUrl).origin, options.origin);
  const result = await completeOAuthAuthorization({
    ...options,
    ...request,
    callbackUrl: `${options.redirectUri}?code=code&state=${request.state}`,
    fetch: async (url) => {
      assert.equal(String(url), "https://tenant.example.com/oauth/token");
      return Response.json({
        access_token: "access",
        token_type: "bearer",
        refresh_token: "refresh",
      });
    },
  });
  assert.equal(result.accessToken, "access");
});

test("login errors never echo submitted secrets", async () => {
  const host = new LocalHost({
    origin: "https://api.example.com",
    outputPath: "unused",
    statePath: "unused",
    credentials: { token: "secret" },
    auth: auth.tokenExchange({
      credentials: credential.object({ token: credential.secret() }),
      tokenUrl: "/login",
      headers: { "x-key": "token" },
    }),
    fetch: async () => Response.json({ error: "secret" }, { status: 400 }),
  });
  await assert.rejects(
    host.request({ method: "GET", path: "/records", headers: [] }),
    (error: unknown) =>
      error instanceof Error && error.message === "Token exchange failed with 400",
  );
});

test("tenant OAuth rejects URL normalization that could change the provider origin", async () => {
  for (const url of [
    "/\n/other.example/token",
    "//other.example/token",
    "/\\other.example/token",
    "/token#fragment",
    "ftp://localhost/token",
  ]) {
    const definition = auth.oauth2AuthorizationCode({
      issuer: "/",
      authorizationUrl: url,
      tokenUrl: "/token",
      scopes: [],
      clientSecret: true,
    });
    if (definition.type !== "oauth2_authorization_code") throw new Error("Invalid auth");
    await assert.rejects(
      beginOAuthAuthorization({
        auth: definition,
        origin: "https://tenant.example.com",
        credentials: { clientId: "client", clientSecret: "secret" },
        redirectUri: "http://127.0.0.1:53682/oauth/callback",
      }),
    );
  }
});

test("absolute OAuth issuer comparison preserves the provider's exact identifier", async () => {
  const definition = auth.oauth2AuthorizationCode({
    issuer: "https://login.example.com",
    authorizationUrl: "https://login.example.com/authorize",
    tokenUrl: "https://login.example.com/token",
    scopes: [],
    clientSecret: true,
  });
  if (definition.type !== "oauth2_authorization_code") throw new Error("Invalid auth");
  const options = {
    auth: definition,
    credentials: { clientId: "client", clientSecret: "secret" },
    redirectUri: "http://127.0.0.1:53682/oauth/callback",
  };
  const request = await beginOAuthAuthorization(options);
  const state = await completeOAuthAuthorization({
    ...options,
    ...request,
    callbackUrl: `${options.redirectUri}?code=code&state=${request.state}&iss=https%3A%2F%2Flogin.example.com`,
    fetch: async () => Response.json({ access_token: "access", token_type: "bearer" }),
  });
  assert.equal(state.accessToken, "access");
});
