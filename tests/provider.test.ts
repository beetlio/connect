import { auth, secret, z } from "@beetlio/connect";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  createProvider,
  prepareOAuthAuthorization,
  type ProviderRequest,
} from "@beetlio/connect/host";
import assert from "node:assert/strict";
import test from "node:test";

const Request: ProviderRequest = { method: "GET", path: "/events", headers: [] };

test("authentication validates origins before sending credentials", async () => {
  const options = {
    credentials: { token: "secret" },
    fetch: async (_input: URL | RequestInfo, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");

      return new Response(null, { status: 204 });
    },
  };

  for (const origin of [
    "http://example.com",
    "https://secret@example.com",
    "https://example.com/path",
    "file:///tmp/test",
  ]) {
    assert.throws(() => createProvider({ origin, auth: auth.bearer() }, options));
    assert.throws(() =>
      createProvider(
        { origin: { type: "input", input: "origin" }, auth: auth.bearer() },
        { ...options, connectionConfig: { origin } },
      ),
    );
  }

  const provider = createProvider({ origin: "http://127.0.0.1", auth: auth.bearer() }, options);

  assert.equal((await provider.request(Request)).status, 204);
});

test("custom authentication injects declared headers and query fields", async () => {
  let url = "";
  let account = "";
  const custom = createProvider(
    {
      origin: "https://api.example.com",
      auth: auth.custom({
        credentials: z.strictObject({
          account: z.string(),
          apiKey: secret(z.string()),
        }),
        headers: {
          "x-account": {
            credential: "account",
          },
        },
        query: {
          api_key: {
            credential: "apiKey",
          },
        },
      }),
    },
    {
      credentials: { account: "acct_123", apiKey: "secret" },
      fetch: async (input, init) => {
        url = String(input);
        account = new Headers(init?.headers).get("x-account") ?? "";

        return new Response(null, { status: 204 });
      },
    },
  );

  await custom.request(Request);

  assert.equal(url, "https://api.example.com/events?api_key=secret");
  assert.equal(account, "acct_123");
});

test("requests inherit connection retries and can override them, including false", async () => {
  for (const [connectionRetry, requestRetry, attempts] of [
    [undefined, undefined, 3],
    [false, undefined, 1],
    [{ maxAttempts: 2 }, undefined, 2],
    [false, { maxAttempts: 3 }, 3],
    [{ maxAttempts: 3 }, false, 1],
  ] as const) {
    let calls = 0;
    const provider = createProvider(
      {
        origin: "https://api.example.com",
        ...(connectionRetry === undefined ? {} : { retry: connectionRetry }),
      },
      {
        fetch: async () => {
          calls += 1;

          return new Response(null, {
            status: calls < 3 ? 503 : 204,
            headers: { "retry-after": "0" },
          });
        },
      },
    );
    const response = await provider.request({
      ...Request,
      ...(requestRetry === undefined ? {} : { retry: requestRetry }),
    });

    assert.equal(calls, attempts);
    assert.equal(response.status, attempts === 3 ? 204 : 503);
  }
});

for (const authentication of ["exchange", "oauth"] as const) {
  test(`${authentication} settlement recovers only after successful token adoption`, async () => {
    let exchanges = 0;
    let saves = 0;
    const persistenceError = new Error("Persistence unavailable");
    const provider = createProvider(
      {
        origin: "https://provider.example",
        auth:
          authentication === "exchange"
            ? auth.tokenExchange({
                credentials: z.strictObject({ key: secret(z.string()) }),
                request: { path: "/token", headers: { "x-key": { credential: "key" } } },
                response: { tokenPath: "access_token", expiry: { type: "fixed", seconds: 3600 } },
              })
            : auth.oauth2({
                issuer: "https://provider.example",
                authorizationUrl: "https://provider.example/authorize",
                tokenUrl: "https://provider.example/token",
                scopes: [],
              }),
      },
      {
        credentials: authentication === "exchange" ? { key: "secret" } : { clientId: "client" },
        authorizationState: { accessToken: "old", refreshToken: "refresh", tokenFields: {} },
        onAuthorizationStateChanged() {
          saves += 1;

          if (saves === 1) throw persistenceError;
        },
        fetch: async (url, init) => {
          if (String(url).endsWith("/token")) {
            exchanges += 1;

            return exchanges === 1
              ? new Response(null, { status: 503 })
              : Response.json({ access_token: "new", token_type: "bearer" });
          }

          return new Response(null, {
            status: new Headers(init?.headers).get("authorization") === "Bearer new" ? 204 : 401,
          });
        },
      },
    );
    let failure: unknown;

    await assert.rejects(provider.request(Request), (error) => {
      failure = error;

      return true;
    });
    await assert.rejects(provider.settleAuthentication(), (error) => error === failure);
    await assert.rejects(provider.settleAuthentication(), (error) => error === failure);

    if (authentication === "oauth") {
      await assert.rejects(provider.request(Request), (error) => error === persistenceError);
      await assert.rejects(provider.settleAuthentication(), (error) => error === persistenceError);
    }

    assert.equal((await provider.request(Request)).status, 204);

    await provider.settleAuthentication();

    assert.equal(exchanges, authentication === "exchange" ? 2 : 3);
  });
}

test("OAuth refresh is single-flight and isolated from waiter cancellation", async () => {
  const oauth = auth.oauth2({
    issuer: "https://provider.example",
    authorizationUrl: "https://provider.example/authorize",
    tokenUrl: "https://provider.example/token",
    scopes: ["events.read"],
    tokenFields: { instanceUrl: "instance_url" },
  });
  let refreshes = 0;
  let claims = 0;
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
  const host = createProvider(
    {
      origin: {
        type: "oauth",
        oauthTokenField: "instanceUrl",
      },
      auth: oauth,
    },
    {
      credentials: { clientId: "client-id" },
      authorizationState: {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        tokenFields: { instanceUrl: "https://old.example" },
      },
      async onAuthorizationRefreshRequested(signal) {
        assert.equal(signal, undefined);
        // Individual waiter cancellation is not host cancellation.
        claims += 1;
        notifyRefreshStarted();
        await refreshGate;
      },
      onAuthorizationStateChanged: (authorizationState) => void (saved = authorizationState),
      fetch: async (input, init) => {
        const url = String(input);

        if (url === "https://provider.example/token") {
          refreshes += 1;

          assert.equal(claims, 1);

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
    },
  );
  const controller = new AbortController();
  const cancelled = host.request(Request, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );

  await refreshStarted;

  const active = host.request(Request);

  controller.abort(new Error("request cancelled"));

  let settled = false;
  const settlement = host.settleAuthentication().then(() => void (settled = true));

  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(refreshes, 0);

  releaseRefresh();
  await settlement;

  assert.match(String(await cancelled), /request cancelled/);
  assert.equal((await active).status, 204);
  assert.equal(refreshes, 1);
  assert.equal(claims, 1);
  assert.deepEqual(saved, {
    accessToken: "fresh-token",
    refreshToken: "refresh-token",
    tokenFields: { instanceUrl: "https://new.example" },
  });
});

test("provider responses have a hard size limit", async () => {
  const host = createProvider(
    {
      origin: "https://api.example.com",
    },
    {
      fetch: async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
    },
  );

  await assert.rejects(host.request({ ...Request, retry: false }), /exceeds 16 MiB/);

  const bodyless = createProvider(
    {
      origin: "https://api.example.com",
    },
    {
      fetch: async () =>
        new Response(null, { headers: { "content-length": String(32 * 1024 * 1024) } }),
    },
  );
  const response = await bodyless.request({ ...Request, method: "HEAD", retry: false });

  assert.equal(response.body.byteLength, 0);
});
for (const failure of ["denied", "aborted"] as const) {
  test(`OAuth refresh ${failure} at the claim hook never exchanges tokens`, async () => {
    const controller = new AbortController();
    const reason = new Error(failure);
    let exchanges = 0;
    let commits = 0;
    let claims = 0;
    const host = createProvider(
      {
        origin: "https://provider.example",
        auth: auth.oauth2({
          issuer: "https://provider.example",
          authorizationUrl: "https://provider.example/authorize",
          tokenUrl: "https://provider.example/token",
          scopes: [],
        }),
      },
      {
        credentials: { clientId: "client-id" },
        authorizationState: {
          accessToken: "old-token",
          refreshToken: "refresh-token",
          tokenFields: {},
        },
        signal: controller.signal,
        async onAuthorizationRefreshRequested(signal) {
          assert.equal(signal, controller.signal);

          claims += 1;
          await Promise.resolve();

          if (failure === "denied") throw reason;

          controller.abort(reason);
        },
        onAuthorizationStateChanged() {
          commits += 1;
        },
        fetch: async (input, init) => {
          if (String(input) === "https://provider.example/token") {
            exchanges += 1;

            return Response.json({ access_token: "new-token", token_type: "Bearer" });
          }

          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer old-token");

          return new Response(null, { status: 401 });
        },
      },
    );

    await assert.rejects(host.request(Request), (error) => error === reason);
    await assert.rejects(host.settleAuthentication(), (error) => error === reason);

    assert.equal(claims, 1);
    assert.equal(exchanges, 0);
    assert.equal(commits, 0);
  });
}

test("form client credentials support basic authentication and relative token expiry", async () => {
  const host = createProvider(
    {
      origin: "https://api.example.com",
      auth: auth.tokenExchange({
        credentials: z.strictObject({
          clientId: z.string(),
          clientSecret: secret(z.string()),
        }),
        request: {
          path: "/token",
          basic: { username: "clientId", password: "clientSecret" },
          body: {
            encoding: "form",
            fields: {
              grant_type: "client_credentials",
              scope: "expenses:read",
            },
          },
        },
        response: {
          tokenPath: "access_token",
          expiry: {
            type: "relative",
            path: "expires_in",
          },
        },
      }),
    },
    {
      credentials: { clientId: "a b~!", clientSecret: "s p~!" },
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
    },
  );

  await host.request({ method: "GET", path: "/records", headers: [] });
});

test("login headers override defaults and errors never echo submitted secrets", async () => {
  const host = createProvider(
    {
      origin: "https://api.example.com",
      auth: auth.tokenExchange({
        credentials: z.strictObject({ token: secret(z.string()) }),
        request: {
          path: "/login",
          headers: {
            Accept: "application/vnd.example+json",
            "Content-Type": "application/vnd.example+json",
            "x-key": {
              credential: "token",
            },
          },
        },
        response: {
          tokenPath: "token",
          expiry: {
            type: "absolute",
            path: "expires_at",
          },
        },
      }),
    },
    {
      credentials: { token: "secret" },
      fetch: async (_url, init) => {
        const headers = new Headers(init?.headers);

        assert.equal(headers.get("accept"), "application/vnd.example+json");
        assert.equal(headers.get("content-type"), "application/vnd.example+json");
        assert.equal(headers.get("x-key"), "secret");
        assert.equal(init?.body, undefined);

        return Response.json({ error: "secret" }, { status: 400 });
      },
    },
  );

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
    const definition = auth.oauth2({
      issuer: "/",
      authorizationUrl: url,
      tokenUrl: "/token",
      scopes: [],
      clientSecret: true,
    });

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
  const definition = auth.oauth2({
    issuer: "https://login.example.com",
    authorizationUrl: "https://login.example.com/authorize",
    tokenUrl: "https://login.example.com/token",
    scopes: [],
    clientSecret: true,
  });

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

test("OAuth preparation resolves and retains the configured tenant for start and callback", async () => {
  const config = { tenant: "https://tenant.example.com" };
  const oauth = auth.oauth2({
    issuer: "/",
    authorizationUrl: "/authorize",
    tokenUrl: "/token",
    scopes: [],
  });
  const prepared = await prepareOAuthAuthorization(
    {
      origin: { type: "input", input: "tenant" },
      inputs: z.strictObject({ tenant: z.url() }),
      auth: oauth,
    },
    {
      connectionConfig: config,
      credentials: { clientId: "client" },
      fetch: async (url) => {
        assert.equal(String(url), "https://tenant.example.com/token");

        return Response.json({ access_token: "access", token_type: "bearer" });
      },
    },
  );
  const options = { ...prepared, redirectUri: "https://app.example.com/callback" };

  config.tenant = "https://changed.example.com";

  const request = await beginOAuthAuthorization(options);

  assert.equal(new URL(request.authorizationUrl).origin, "https://tenant.example.com");

  const state = await completeOAuthAuthorization({
    ...options,
    ...request,
    callbackUrl: `${options.redirectUri}?code=code&state=${request.state}`,
  });

  assert.equal(state.accessToken, "access");

  await assert.rejects(
    prepareOAuthAuthorization(
      { origin: { type: "oauth", oauthTokenField: "instance" }, auth: oauth },
      { credentials: { clientId: "client" } },
    ),
    /origin available before authorization/,
  );
  await assert.rejects(
    prepareOAuthAuthorization(
      { origin: "https://tenant.example.com", auth: oauth },
      { credentials: {} },
    ),
  );
});
