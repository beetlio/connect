import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { auth, z } from "@beetlio/connect";
import { authorizeOAuth } from "../src/oauth.ts";

test("authorization-code flow uses PKCE and maps provider credentials", async () => {
  let challenge = "";
  const provider = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://provider");
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), "client-id");
      assert.equal(url.searchParams.get("scope"), "api refresh_token");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      challenge = url.searchParams.get("code_challenge") ?? "";
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      response.statusCode = 302;
      response.setHeader("location", callback.href);
      response.end();
      return;
    }

    if (url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "authorization-code");
      assert.equal(body.get("client_id"), "client-id");
      assert.equal(body.get("client_secret"), "client-secret");
      assert.equal(
        createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
        challenge,
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        instance_url: "https://tenant.example",
      }));
      return;
    }

    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address() as AddressInfo;
  const oauth = auth.oauth2AuthorizationCode({
    authorizationUrl: `http://127.0.0.1:${providerAddress.port}/authorize`,
    tokenUrl: `http://127.0.0.1:${providerAddress.port}/token`,
    scopes: ["api", "refresh_token"],
    clientSecret: "clientSecret",
    refreshToken: "refreshToken",
    tokenFields: { instanceUrl: "instance_url" },
  });
  assert.equal(oauth.type, "oauth2_authorization_code");
  let callbackUrl = "";

  try {
    const credentials = await authorizeOAuth({
      auth: oauth,
      integrationCredentials: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      credentialSchema: z.object({
        accessToken: z.string(),
        refreshToken: z.string(),
        instanceUrl: z.string(),
      }),
      redirectUri: "https://app.example/oauth/callback",
      async onAuthorizationUrl(url) {
        const authorization = await fetch(url, { redirect: "manual" });
        callbackUrl = authorization.headers.get("location")!;
      },
      onAuthorizationCallback: () => callbackUrl,
    });
    assert.deepEqual(credentials, {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      instanceUrl: "https://tenant.example",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => error ? reject(error) : resolve())
    );
  }
});
