import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSync, verifyConnection } from "@beetlio/connect/host";
import wikidata from "../examples/wikidata/integration.ts";
import { LocalHost } from "../src/local-host.ts";

test("Wikidata entity search identifies the client and follows continuation", async () => {
  const requests: Array<{ url: URL; userAgent: string }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push({ url, userAgent: request.headers["user-agent"] ?? "" });
    response.setHeader("content-type", "application/json");

    if (url.searchParams.get("action") === "query") {
      response.end(JSON.stringify({ query: { general: { sitename: "Wikidata" } } }));
      return;
    }

    const continued = url.searchParams.get("continue") === "2";
    response.end(JSON.stringify(continued
      ? { search: [hit("Q3", "Open source software")] }
      : {
        search: [hit("Q1", "Open source"), hit("Q2", "Open-source model")],
        "search-continue": 2,
      }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const directory = await mkdtemp(join(tmpdir(), "beetl-wikidata-"));
  const outputPath = join(directory, "entities.ndjson");
  const address = server.address() as AddressInfo;
  const host = new LocalHost({
    baseUrl: `http://127.0.0.1:${address.port}`,
    outputPath,
    statePath: join(directory, "entities.json"),
    onLog: () => undefined,
  });
  const connectionConfig = {
    userAgent: "beetl-wikidata-test/1.0 (https://github.com/beetlio/connect)",
  };

  try {
    await verifyConnection(wikidata, { connectionConfig }, host);
    const result = await runSync(
      wikidata,
      "entities",
      {
        connectionConfig,
        syncConfig: { search: "open source", pageSize: 2, maxResults: 3 },
      },
      host,
    );

    assert.deepEqual(result, { batches: 2, records: 3 });
    assert.deepEqual(
      (await readFile(outputPath, "utf8")).trim().split("\n").map((line) =>
        JSON.parse(line) as unknown
      ),
      [
        entity("Q1", "Open source"),
        entity("Q2", "Open-source model"),
        entity("Q3", "Open source software"),
      ],
    );
    assert.ok(requests.every(({ userAgent }) => userAgent === connectionConfig.userAgent));
    assert.equal(requests[1]?.url.searchParams.get("search"), "open source");
    assert.equal(requests[1]?.url.searchParams.get("limit"), "2");
    assert.equal(requests[2]?.url.searchParams.get("continue"), "2");
    assert.ok(requests.every(({ url }) => url.searchParams.get("maxlag") === "5"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await rm(directory, { recursive: true, force: true });
  }
});

function hit(id: string, label: string) {
  return { id, label, description: `${label} description`, aliases: [label.toLowerCase()] };
}

function entity(id: string, label: string) {
  return {
    id,
    label,
    description: `${label} description`,
    aliases: [label.toLowerCase()],
    url: `https://www.wikidata.org/wiki/${id}`,
  };
}
