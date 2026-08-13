import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { auth } from "@beetlio/connect";
import { authorizeOAuth } from "../src/oauth.ts";
import { fixtureServer } from "./support.ts";

test("authorization-code flow uses PKCE and returns provider authorization state", async (t) => {
  let challenge = "";
  const provider = await fixtureServer(t, async (request, response) => {
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
      callback.searchParams.set("iss", `${provider}/tenant/acme`);
      response.statusCode = 302;
      response.setHeader("location", callback.href);
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
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
    response.end(
      JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        refresh_token: "refresh-token",
        instance_url: "https://tenant.example",
      }),
    );
  });
  const oauth = auth.oauth2AuthorizationCode({
    issuer: `${provider}/tenant/acme`,
    authorizationUrl: `${provider}/authorize`,
    tokenUrl: `${provider}/token`,
    scopes: ["api", "refresh_token"],
    clientSecret: true,
    tokenFields: { instanceUrl: "instance_url" },
  });
  assert.equal(oauth.type, "oauth2_authorization_code");
  let callbackUrl = "";

  const authorizationState = await authorizeOAuth({
    auth: oauth,
    credentials: { clientId: "client-id", clientSecret: "client-secret" },
    redirectUri: "https://app.example/oauth/callback",
    async onAuthorizationUrl(url) {
      const authorization = await fetch(url, { redirect: "manual" });
      callbackUrl = authorization.headers.get("location")!;
    },
    onAuthorizationCallback: () => callbackUrl,
  });
  assert.deepEqual(authorizationState, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenFields: { instanceUrl: "https://tenant.example" },
  });
});
