import { defineFixture } from "./shared.ts";
import { auth } from "@beetlio/connect";

export default defineFixture({
  key: "bearer",
  displayName: "bearer",
  connection: {
    origin: "https://provider.example",
    auth: auth.bearer(),
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
    async verify(ctx) {
      const response = await ctx.fetch("/verify");

      if (!response.ok) throw new Error("Verification failed");
    },
  },
});
