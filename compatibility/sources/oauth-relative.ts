import { defineFixture } from "./shared.ts";
import { auth, z } from "@beetlio/connect";

export default defineFixture({
  key: "oauth-relative",
  displayName: "oauth-relative",
  connection: {
    origin: {
      type: "input",
      input: "origin",
    },
    inputs: z.strictObject({ origin: z.string().check(z.url()) }),
    auth: auth.oauth2({
      issuer: "/",
      authorizationUrl: "/authorize",
      tokenUrl: "/token",
      scopes: ["read"],
      clientSecret: true,
    }),
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    async verify(ctx) {
      const response = await ctx.fetch("/verify");

      if (!response.ok) throw new Error("Verification failed");
    },
  },
});
