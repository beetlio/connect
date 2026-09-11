import assert from "node:assert/strict";
import { MIMEType } from "node:util";

import type { JsonValue } from "./index.ts";

export interface ProviderStep {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyFields?: Record<string, string>;
    bodyJson?: JsonValue;
  };
  response: { status: number; headers?: Record<string, string>; json?: JsonValue };
}

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
        ? new Response(null, step.response)
        : Response.json(step.response.json, step.response);
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

// Used only by the compatibility suite's server-host subprocess, never by normal execution.
if (process.env.BEETL_CONNECT_COMPAT_HTTP !== undefined) {
  const provider = mockProvider(
    JSON.parse(process.env.BEETL_CONNECT_COMPAT_HTTP) as ProviderStep[],
  );

  delete process.env.BEETL_CONNECT_COMPAT_HTTP;
  globalThis.fetch = provider.fetch;
  process.once("exit", () => provider.assertComplete());
}
