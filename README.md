<p align="center">
  <img src="docs/beetl-logo.svg" alt="Beetl" width="96">
</p>

# @beetlio/connect

Connect is a Beetl project for building host-neutral data integrations. Its SDK
runs inside compatible host applications without depending on Beetl services or
infrastructure, while a companion CLI supports local development and testing.

[Documentation](https://beetlio.github.io/connect/) · [Examples](examples/) · [Contributing](CONTRIBUTING.md)

The demo validates the included Wikidata integration, runs a five-record sync,
and inspects the emitted NDJSON.

[![Watch @beetlio/connect sync Wikidata](https://asciinema.org/a/1262370.svg)](https://asciinema.org/a/1262370)

> [!WARNING]
> This project is experimental and currently at `0.0.0`. APIs and local storage
> formats may change.

An integration declares its credentials, runtime validation, records,
pagination, checkpoints, and sync behavior. The host owns secrets, HTTP
authentication, retries, output, and state. Sync code never receives declared
credentials directly.

## Features

- Strict TypeScript authoring with Zod validation at runtime boundaries
- Bearer, basic, API-key, custom, and OAuth 2.0 authentication
- Authorization Code with PKCE for OAuth 2.0 connections
- Connection verification and automatic OAuth refresh after a `401`
- Cursor and offset pagination helpers
- Durable checkpoints for incremental syncs and atomic snapshot replacement
- Managed retries with `Retry-After` support
- NDJSON output from the local CLI

## Install

Requires Node.js 24 or newer.

Install the SDK and a project-local CLI:

```fish
npm install @beetlio/connect
```

Run the project-local command with `npx beetl-connect`. To make
`beetl-connect` available system-wide, install the same package globally:

```fish
npm install --global @beetlio/connect
```

## Define an integration

Create an `integration.ts` file:

```ts
import { auth, defineIntegration, z } from "@beetlio/connect";

const Item = z.object({
  id: z.string(),
  name: z.string(),
});

export default defineIntegration({
  key: "example",
  displayName: "Example",
  connection: {
    baseUrl: "https://api.example.com",
    credentials: z.object({ token: z.string() }),
    auth: auth.bearer(),
    async verify(ctx) {
      const response = await ctx.fetch("/me");
      if (!response.ok) throw new Error("Connection verification failed");
    },
  },
  syncs: (defineSync) => [
    defineSync({
      key: "items",
      displayName: "Items",
      records: Item,
      primaryKey: ["id"],
      async run(ctx) {
        const response = await ctx.fetch("/items");
        if (!response.ok) throw new Error("Item request failed");
        await ctx.emit({ records: z.array(Item).parse(await response.json()) });
      },
    }),
  ],
});
```

Paths passed to `ctx.fetch()` must be relative to the configured origin and
begin with `/`. The host validates configuration and injects authentication
into each request.

## Embed in a host application

Host applications use the runtime exported from `@beetlio/connect/host`:

```ts
import { runSync, verifyConnection, type SyncHost } from "@beetlio/connect/host";
import integration from "./integration.ts";

const host: SyncHost = applicationHost;
await verifyConnection(integration, { connectionConfig }, host);
const result = await runSync(
  integration,
  "items",
  { connectionConfig, syncConfig, checkpoint },
  host,
);
```

The host implements provider requests, authentication, record and checkpoint
persistence, and logging. Snapshot syncs additionally require `beginSnapshot`,
`commitSnapshot`, and `abortSnapshot`. The returned checkpoint can be persisted
and passed to the next run.

See the runnable [custom host example](examples/custom-host/host.ts), which
executes the Wikidata integration without using the CLI.

## CLI

| Command | Purpose |
| --- | --- |
| `check` | Validate an integration and list its syncs |
| `connect` | Complete OAuth, verify the connection, and save credentials |
| `verify` | Test stored or environment-provided credentials |
| `sync <key>` | Run one sync and write NDJSON records |

Credential fields map from camel case to upper-snake-case environment
variables. For example, `apiKey` maps to `API_KEY` and `token` maps to `TOKEN`.

```fish
set -gx TOKEN "<token>"
npx beetl-connect check
npx beetl-connect verify
npx beetl-connect sync items
set -e TOKEN
```

Incremental state is stored under `.beetl/state`. OAuth connections are stored
under `.beetl/connections` with owner-only permissions. Connection files are
not encrypted, so treat the local machine and working directory as trusted.

## Sync model

Append syncs are the default: each run writes a new NDJSON file and can resume
from its latest checkpoint. A sync can instead declare `mode: "snapshot"`; the
local host replaces the previous output only after the new snapshot succeeds.

`ctx.paginate()` supports cursor and offset APIs. Integrations can also issue
requests directly for custom pagination and checkpoint strategies. Retries
apply to safe HTTP methods by default and can be configured per connection.

## Examples

| Integration | Demonstrates |
| --- | --- |
| [Basic dummy API](examples/basic/integration.ts) | Definition, validation, verification, direct fetch, and snapshot output |
| [All features dummy API](examples/all-features/integration.ts) | OAuth, configuration, retries, headers, pagination, checkpoints, and logging |
| [Wikidata](examples/wikidata/integration.ts) | A real unauthenticated public API with bounded cursor pagination |

The dummy integrations use the reserved `api.example.com` domain and local
fixture servers. Wikidata structured data is available under
[CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); follow Wikimedia's
[API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
when adapting the public example.

Run the Wikidata example from this repository without authentication:

```fish
npm run cli -- sync entities \
  --integration examples/wikidata/integration.ts \
  --connection-config '{"userAgent":"my-wikidata-sync/1.0 (me@example.com)"}' \
  --sync-config '{"search":"open source","language":"en","maxResults":25}'
```

Replace the example email with your contact information. The command writes a
timestamped NDJSON snapshot to the current directory.

## Development

```fish
npm install
npm run check
npm test
```

## Current scope

The local host supports one OAuth connection per integration. Hosted execution,
multi-connection profiles, encrypted credential storage, deployment, and
compatibility manifests are not implemented.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
