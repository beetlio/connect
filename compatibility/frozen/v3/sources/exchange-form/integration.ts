import { defineFixture } from "./shared.ts";
import { auth, secret, z } from "@beetlio/connect";

export default defineFixture({
  key: "exchange-form",
  displayName: "exchange-form",
  connection: {
    origin: {
      type: "environment",
      input: "environment",
      values: { production: "https://provider.example", sandbox: "https://sandbox.example" },
    },
    inputs: z.strictObject({
      environment: z
        .enum(["production", "sandbox"])
        .default("production")
        .meta({
          "x-beetl-options": [
            { value: "production", label: "Production" },
            { value: "sandbox", label: "Sandbox" },
          ],
        }),
    }),
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
            scope: "read",
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
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    async verify(ctx) {
      const response = await ctx.fetch("/verify");

      if (!response.ok) throw new Error("Verification failed");
    },
  },
});
