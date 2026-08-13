import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { buildIntegration, withIntegration } from "@beetlio/connect/builder";
import { runSync, verifyConnection } from "@beetlio/connect/host";
import { LocalHost } from "../src/local-host.ts";
import { fixtureDirectory, fixtureServer } from "./support.ts";

const hit = (id: string, label: string) => ({
  id,
  label,
  description: `${label} description`,
  aliases: [label.toLowerCase()],
});

test("Wikidata example builds through the public builder and follows continuation", async (t) => {
  const { archive, manifest, sdkVersion } = await buildIntegration("examples/wikidata");
  assert.ok(archive.byteLength > 0);
  assert.match(sdkVersion, /^\d+\.\d+\.\d+/);
  await withIntegration(archive, async (wikidata) => {
    assert.equal(manifest.integration.key, wikidata.key);
    const requests: Array<{ url: URL; userAgent: string }> = [];
    const origin = await fixtureServer(t, (request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      requests.push({ url, userAgent: request.headers["user-agent"] ?? "" });
      response.setHeader("content-type", "application/json");
      if (url.searchParams.get("action") === "query") {
        response.end(JSON.stringify({ query: { general: { sitename: "Wikidata" } } }));
        return;
      }
      response.end(
        JSON.stringify(
          url.searchParams.get("continue") === "2"
            ? { search: [hit("Q3", "Open source software")] }
            : {
                search: [hit("Q1", "Open source"), hit("Q2", "Open-source model")],
                "search-continue": 2,
              },
        ),
      );
    });
    const directory = await fixtureDirectory(t, "beetl-wikidata");
    const outputPath = join(directory, "entities.ndjson");
    const host = new LocalHost({
      origin,
      outputPath,
      statePath: join(directory, "state.json"),
      onLog: () => undefined,
    });
    const connectionConfig = {
      userAgent: "beetl-wikidata-test/1.0 (https://github.com/beetlio/connect)",
    };

    await verifyConnection(wikidata, { connectionConfig }, host);
    assert.deepEqual(
      await runSync(
        wikidata,
        "entities",
        {
          connectionConfig,
          syncConfig: { search: "open source", pageSize: 2, maxResults: 3 },
        },
        host,
      ),
      { batches: 2, records: 3 },
    );

    assert.deepEqual(
      (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { ...hit("Q1", "Open source"), url: "https://www.wikidata.org/wiki/Q1" },
        { ...hit("Q2", "Open-source model"), url: "https://www.wikidata.org/wiki/Q2" },
        { ...hit("Q3", "Open source software"), url: "https://www.wikidata.org/wiki/Q3" },
      ],
    );
    assert.ok(requests.every(({ userAgent }) => userAgent === connectionConfig.userAgent));
    assert.equal(requests[1]?.url.searchParams.get("search"), "open source");
    assert.equal(requests[1]?.url.searchParams.get("limit"), "2");
    assert.equal(requests[2]?.url.searchParams.get("continue"), "2");
    assert.equal(requests[0]?.url.searchParams.get("maxlag"), "5");
    assert.ok(requests.slice(1).every(({ url }) => url.searchParams.get("maxlag") === "30"));
  });
});
