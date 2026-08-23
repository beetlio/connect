import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { buildIntegration, withIntegration } from "@beetlio/connect/builder";
import { runSync, verifyConnection } from "@beetlio/connect/host";
import { LocalHost } from "../src/local-host.ts";
import { fixtureDirectory, fixtureServer } from "./support.ts";

const contact = (id: string) => ({
  id,
  email: `${id}@example.com`,
  updatedAt: "2026-08-04T12:00:00Z",
});
const event = (id: string) => ({
  id,
  type: "contact.updated",
  createdAt: "2026-08-04T12:00:00Z",
});

test("all-features example verifies, paginates, checkpoints, and resumes", async (t) => {
  const built = await buildIntegration("examples/all-features");
  await withIntegration(built.archive, async (integration) => {
    const contacts = [contact("contact_1"), contact("contact_2"), contact("contact_3")];
    let events = [event("event_1"), event("event_2"), event("event_3")];
    let verificationCalls = 0;
    const authorizations: string[] = [];
    const workspaces: string[] = [];
    const apiVersions: string[] = [];
    const logs: string[] = [];
    const origin = await fixtureServer(t, (request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      authorizations.push(request.headers.authorization ?? "");
      workspaces.push(url.searchParams.get("workspace") ?? "");

      if (url.pathname === "/v1/me") {
        verificationCalls += 1;
        response.statusCode = verificationCalls === 1 ? 503 : 204;
        response.setHeader("retry-after", "0");
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

      const limit = Number(url.searchParams.get("limit") ?? 50);
      const since = url.searchParams.get("since");
      const after = url.searchParams.get("after");
      const available = events.slice(
        since === null ? 0 : events.findIndex((candidate) => candidate.id === since) + 1,
      );
      const start = after === null ? 0 : available.findIndex(({ id }) => id === after) + 1;
      const data = available.slice(start, start + limit);
      response.end(
        JSON.stringify({
          data,
          paging: start + data.length < available.length ? { next: data.at(-1)?.id } : {},
        }),
      );
    });
    const directory = await fixtureDirectory(t, "beetl-all-features");
    const host = new LocalHost({
      origin,
      auth: integration.connection.auth!,
      credentials: { clientId: "fixture-client", clientSecret: "fixture-secret" },
      authorizationState: {
        accessToken: "fixture-token",
        refreshToken: "fixture-refresh-token",
        tokenFields: {},
      },
      outputPath: join(directory, "records.ndjson"),
      statePath: join(directory, "state.json"),
      onLog: ({ message }) => logs.push(message),
    });
    const connectionConfig = { workspace: "workspace_123" };
    const syncConfig = { pageSize: 2 };

    await verifyConnection(integration, { connectionConfig }, host);
    assert.equal(verificationCalls, 2);

    assert.deepEqual(
      await runSync(integration, "contacts", { connectionConfig, syncConfig }, host),
      {
        outcome: "completed",
        batches: 2,
        records: 3,
        deleted: 0,
        checkpoint: { pagination: { offset: 3 } },
      },
    );
    const firstEvents = await runSync(
      integration,
      "events",
      { connectionConfig, syncConfig },
      host,
    );
    assert.deepEqual(firstEvents, {
      outcome: "completed",
      batches: 2,
      records: 3,
      deleted: 0,
      checkpoint: { watermark: { lastSeenId: "event_3" } },
    });

    events = [...events, event("event_4")];
    assert.deepEqual(
      await runSync(
        integration,
        "events",
        { connectionConfig, syncConfig, checkpoint: firstEvents.checkpoint },
        host,
      ),
      {
        outcome: "completed",
        batches: 1,
        records: 1,
        deleted: 0,
        checkpoint: { watermark: { lastSeenId: "event_4" } },
      },
    );

    assert.ok(authorizations.every((value) => value === "Bearer fixture-token"));
    assert.ok(workspaces.every((value) => value === "workspace_123"));
    assert.deepEqual(apiVersions, ["2026-08-01", "2026-08-01"]);
    assert.deepEqual(
      new Set(logs),
      new Set(["Connection verified", "Emitted contacts", "Emitted events"]),
    );
  });
});
