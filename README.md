# @beetlio/connect

`@beetlio/connect` is an experimental TypeScript SDK and local CLI for building
host-neutral data integrations. Integrations declare credentials, validation,
records, pagination, checkpoints, and sync behavior; the host owns secrets,
HTTP authentication, retries, output, and state.

> This project is at `0.0.0`. APIs and local storage formats may change.

## Features

- Strict TypeScript authoring with Zod validation at runtime boundaries
- Bearer, basic, API-key, custom, and OAuth 2.0 authentication
- Authorization Code + PKCE and Salesforce device-code connection flows
- Connection verification and automatic OAuth refresh after a `401`
- Cursor and offset pagination helpers
- Durable checkpoints for incremental syncs
- Atomic replacement for full snapshot syncs
- Managed retries with `Retry-After` support
- NDJSON output from the local CLI

## Requirements

- Node.js 24 or newer
- npm

## Development setup

```fish
npm install
npm run build
```

## Author an integration

Create a `beetl.integration.ts` file:

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

Provider paths passed to `ctx.fetch()` must be relative to the configured
origin and begin with `/`. Sync code never receives declared credentials; the
host injects authentication into requests.

## Use the CLI

Credential fields map from camel case to exported upper-snake-case environment
variables. For example, `apiKey` maps to `API_KEY` and `token` maps to `TOKEN`.

```fish
set -gx TOKEN "<token>"

npm run cli -- check --integration beetl.integration.ts
npm run cli -- verify --integration beetl.integration.ts
npm run cli -- sync items --integration beetl.integration.ts

set -e TOKEN
```

The commands are:

- `check`: validate the integration and list its syncs
- `connect`: complete OAuth, verify the connection, and save credentials
- `verify`: test stored or environment-provided credentials
- `sync`: run one sync and write NDJSON records

Incremental state is stored under `.beetl/state`; OAuth connections are stored
under `.beetl/connections` with owner-only permissions. Connection files are
not encrypted, so treat the local machine and working directory as trusted.

## Examples

| Integration | Demonstrates |
| --- | --- |
| [Basic dummy API](examples/basic/beetl.integration.ts) | Definition, validation, verification, direct fetch, and snapshot output |
| [All features dummy API](examples/all-features/beetl.integration.ts) | OAuth declarations, configuration, retries, headers, cursor and offset pagination, checkpoints, and logging |
| [Wikidata](examples/wikidata/beetl.integration.ts) | A real unauthenticated public API with bounded cursor pagination |

The dummy integrations use the reserved `api.example.com` domain. Their tests
run against local fixture servers and are the easiest starting points for a new
integration.

## Sync behavior

Append syncs are the default. Each run writes a new NDJSON file and can resume
from its latest checkpoint. A full-source sync can instead declare
`mode: "snapshot"`; the local host replaces its previous output only after the
new snapshot succeeds.

`ctx.paginate()` supports cursor and offset APIs. An integration can also issue
requests directly when a provider needs a custom pagination or checkpoint
strategy. See the [all-features dummy](examples/all-features/beetl.integration.ts)
for both pagination styles and resumable checkpoints.

Retries apply to safe methods by default. Override or disable them on the
connection:

```ts
retry: {
  maxAttempts: 5,
  statuses: [429, 502, 503, 504],
  methods: ["GET"],
  initialDelayMs: 500,
  maxDelayMs: 30_000,
}
```

## Wikidata example

The Wikidata example searches public entities without authentication and
writes a snapshot. Wikimedia requires automated clients to identify themselves
with a descriptive user agent containing contact information.

```fish
npm run cli -- sync entities \
  --integration examples/wikidata/beetl.integration.ts \
  --connection-config '{"userAgent":"my-wikidata-sync/1.0 (me@example.com)"}' \
  --sync-config '{"search":"open source","language":"en","maxResults":25}'
```

Wikidata structured data is available under
[CC0](https://www.wikidata.org/wiki/Wikidata:Licensing). Follow Wikimedia's
[API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
when adapting this example.

## Scope

The current local host supports one OAuth connection per integration. Hosted
execution, multi-connection profiles, encrypted credential storage, deployment,
and compatibility manifests are not implemented.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
