import { defineFixture } from "./shared.ts";
import { auth, secret, z } from "@beetlio/connect";

export default defineFixture({
  key: "exchange-json",
  displayName: "exchange-json",
  connection: {
    origin: {
      type: "input",
      input: "origin",
    },
    inputs: z.strictObject({ origin: z.string().check(z.url()) }),
    auth: auth.tokenExchange({
      credentials: z.strictObject({
        clientId: z.string(),
        clientSecret: secret(z.string()),
      }),
      request: {
        path: "/token",
        body: {
          encoding: "json",
          fields: {
            username: {
              credential: "clientId",
            },
            password: {
              credential: "clientSecret",
            },
          },
        },
      },
      response: {
        tokenPath: "session",
        expiry: {
          type: "fixed",
          seconds: 3600,
        },
      },
      session: {
        header: "x-session",
        prefix: "",
        headers: {
          "x-client-id": {
            credential: "clientId",
          },
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
