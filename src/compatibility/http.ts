import assert from "node:assert/strict";
import { MIMEType } from "node:util";

import { z } from "zod";

export const ProviderStepSchema = z.strictObject({
  request: z.strictObject({
    method: z.string(),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    bodyFields: z.record(z.string(), z.string()).optional(),
    bodyJson: z.json().optional(),
  }),
  response: z.strictObject({
    status: z.number().int().min(200).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    json: z.json().optional(),
  }),
});

export type ProviderStep = z.output<typeof ProviderStepSchema>;

// This small adapter consumes the same HTTP examples that external hosts can replay.
export function mockProvider(steps: readonly ProviderStep[]) {
  let consumed = 0;
  let mismatch: unknown;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const actual = new Request(input, init);
      const step = steps[consumed];

      assert.ok(step, `Unexpected provider request: ${actual.method} ${actual.url}`);
      assert.equal(actual.method, step.request.method);
      assert.equal(actual.url, step.request.url);

      for (const [name, value] of Object.entries(step.request.headers)) {
        const header = actual.headers.get(name);

        assert.equal(
          name === "content-type" && header !== null ? new MIMEType(header).essence : header,
          value,
          `Header ${name} on ${actual.url}`,
        );
      }

      if (step.request.bodyJson !== undefined) {
        assert.deepEqual(await actual.json(), step.request.bodyJson);
      }

      if (step.request.bodyFields !== undefined) {
        const form = new URLSearchParams(await actual.text());

        for (const [name, value] of Object.entries(step.request.bodyFields)) {
          assert.equal(form.get(name), value, `Form field ${name}`);
        }
      }

      consumed++;

      return step.response.json === undefined
        ? new Response(null, { status: step.response.status, headers: step.response.headers ?? {} })
        : Response.json(step.response.json, {
            status: step.response.status,
            headers: step.response.headers ?? {},
          });
    } catch (error) {
      mismatch ??= error;

      throw error;
    }
  };

  return {
    fetch,
    assertComplete() {
      if (mismatch) throw mismatch;

      assert.equal(consumed, steps.length, "Provider HTTP scenario was not fully consumed");
    },
  };
}
