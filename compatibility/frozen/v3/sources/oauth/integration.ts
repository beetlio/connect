import { defineFixture } from "./shared.ts";
import { auth } from "@beetlio/connect";

export default defineFixture({
  key: "oauth",
  displayName: "oauth",
  connection: {
    origin: {
      type: "oauth",
      oauthTokenField: "instanceUrl",
    },
    auth: auth.oauth2({
      issuer: "https://auth.example",
      authorizationUrl: "https://auth.example/authorize",
      tokenUrl: "https://auth.example/token",
      scopes: ["read"],
      clientSecret: true,
      tokenFields: { instanceUrl: "instance_url" },
    }),
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    async verify(ctx) {
      const response = await ctx.fetch("/verify");

      if (!response.ok) throw new Error("Verification failed");
    },
  },
});
