import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSync, verifyConnection } from "@beetlio/connect/host";
import basic from "../examples/basic/integration.ts";
import { LocalHost } from "../src/local-host.ts";

test("basic dummy integration verifies and emits a snapshot", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.end(JSON.stringify({ items: [{ id: "item_1", name: "Example" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const directory = await mkdtemp(join(tmpdir(), "beetl-basic-"));
  const outputPath = join(directory, "items.ndjson");
  const address = server.address() as AddressInfo;
  const host = new LocalHost({
    baseUrl: `http://127.0.0.1:${address.port}`,
    outputPath,
    statePath: join(directory, "state.json"),
    onLog: () => undefined,
  });

  try {
    await verifyConnection(basic, {}, host);
    assert.deepEqual(await runSync(basic, "items", {}, host), {
      batches: 1,
      records: 1,
    });
    assert.deepEqual(JSON.parse((await readFile(outputPath, "utf8")).trim()), {
      id: "item_1",
      name: "Example",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await rm(directory, { recursive: true, force: true });
  }
});
