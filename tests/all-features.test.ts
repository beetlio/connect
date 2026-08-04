import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSync, verifyConnection } from "@beetlio/connect/host";
import integration from "../examples/all-features/beetl.integration.ts";
import { LocalHost } from "../src/local-host.ts";

const contacts = [
  contact("contact_1"),
  contact("contact_2"),
  contact("contact_3"),
];
let events = [event("event_1"), event("event_2"), event("event_3")];

test("all-features integration exercises the complete author API", async () => {
  let verificationCalls = 0;
  const authorizations: string[] = [];
  const workspaces: string[] = [];
  const apiVersions: string[] = [];
  const logs: string[] = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    authorizations.push(request.headers.authorization ?? "");
    workspaces.push(url.searchParams.get("workspace") ?? "");

    if (url.pathname === "/v1/me") {
      verificationCalls += 1;
      if (verificationCalls === 1) {
        response.statusCode = 503;
        response.setHeader("retry-after", "0");
        response.end();
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/contacts") {
      apiVersions.push(String(request.headers["x-api-version"] ?? ""));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      response.end(JSON.stringify({ data: contacts.slice(offset, offset + limit) }));
      return;
    }

    if (url.pathname === "/v1/events") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const since = url.searchParams.get("since");
      const after = url.searchParams.get("after");
      const sinceIndex = since === null
        ? 0
        : events.findIndex((candidate) => candidate.id === since) + 1;
      const available = events.slice(sinceIndex);
      const afterIndex = after === null
        ? 0
        : available.findIndex((candidate) => candidate.id === after) + 1;
      const data = available.slice(afterIndex, afterIndex + limit);
      const hasMore = afterIndex + data.length < available.length;
      response.end(JSON.stringify({
        data,
        paging: hasMore ? { next: data.at(-1)?.id } : {},
      }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const directory = await mkdtemp(join(tmpdir(), "beetl-all-features-"));
  const address = server.address() as AddressInfo;
  const host = new LocalHost({
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: integration.connection.auth!,
    credentialSchema: integration.connection.credentials!,
    credentials: {
      accessToken: "fixture-token",
      refreshToken: "fixture-refresh-token",
    },
    outputPath: join(directory, "records.ndjson"),
    statePath: join(directory, "state.json"),
    onLog: (entry) => logs.push(entry.message),
  });

  try {
    await verifyConnection(
      integration,
      { connectionConfig: { workspace: "workspace_123" } },
      host,
    );
    assert.equal(verificationCalls, 2);

    const contactsResult = await runSync(
      integration,
      "contacts",
      {
        connectionConfig: { workspace: "workspace_123" },
        syncConfig: { pageSize: 2 },
      },
      host,
    );
    assert.deepEqual(contactsResult, {
      batches: 2,
      records: 3,
      checkpoint: { pagination: { offset: 3 } },
    });

    const eventsResult = await runSync(
      integration,
      "events",
      {
        connectionConfig: { workspace: "workspace_123" },
        syncConfig: { pageSize: 2 },
      },
      host,
    );
    assert.deepEqual(eventsResult, {
      batches: 2,
      records: 3,
      checkpoint: { watermark: { lastSeenId: "event_3" } },
    });

    events = [...events, event("event_4")];
    const resumed = await runSync(
      integration,
      "events",
      {
        connectionConfig: { workspace: "workspace_123" },
        syncConfig: { pageSize: 2 },
        checkpoint: eventsResult.checkpoint,
      },
      host,
    );
    assert.deepEqual(resumed, {
      batches: 1,
      records: 1,
      checkpoint: { watermark: { lastSeenId: "event_4" } },
    });

    assert.ok(authorizations.every((value) => value === "Bearer fixture-token"));
    assert.ok(workspaces.every((value) => value === "workspace_123"));
    assert.deepEqual(apiVersions, ["2026-08-01", "2026-08-01"]);
    assert.ok(logs.includes("Connection verified"));
    assert.ok(logs.includes("Emitted contacts"));
    assert.ok(logs.includes("Emitted events"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    await rm(directory, { recursive: true, force: true });
    events = [event("event_1"), event("event_2"), event("event_3")];
  }
});

function contact(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    updatedAt: "2026-08-04T12:00:00Z",
  };
}

function event(id: string) {
  return {
    id,
    type: "contact.updated",
    createdAt: "2026-08-04T12:00:00Z",
  };
}
