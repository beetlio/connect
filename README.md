<p align="center">
  <img src="docs/beetl-logo.svg" alt="Beetl" width="96">
</p>

# Connect

[![npm version](https://img.shields.io/npm/v/%40beetlio%2Fconnect.svg)](https://www.npmjs.com/package/@beetlio/connect)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Build API integrations in TypeScript and run them from your terminal. Connect
checks integration code, manages local configuration and authentication, fetches
and validates records, and writes NDJSON.

[Documentation](https://beetlio.github.io/connect/) · [Examples](examples/) · [Contributing](CONTRIBUTING.md)

The demo checks the included Wikidata integration, fetches five records, and
inspects the emitted NDJSON.

[![Watch @beetlio/connect sync Wikidata](https://asciinema.org/a/1262370.svg)](https://asciinema.org/a/1262370)

> [!WARNING]
> This project is experimental and currently at `0.0.0`. APIs and local storage
> formats may change.

> [!IMPORTANT]
> Integrations are executable code. Only check, pack, or run integrations you
> trust. Artifact digests detect corruption; they do not identify or verify an
> integration's author.

## What it does

- Builds and runs TypeScript API integrations from one CLI
- Validates provider responses and output records with Zod
- Bearer, basic, API-key, custom, and OAuth 2.0 authentication
- Cursor and offset pagination helpers
- Managed retries, incremental checkpoints, and atomic snapshots
- Portable `.beetl.zip` artifacts for running an integration elsewhere
- NDJSON output that works with tools such as `jq`, DuckDB, and data pipelines

## Install

Requires Node.js 24 or newer. Install the CLI globally:

```sh
npm install --global @beetlio/connect
```

Or install it in an integration project and run it with `npx`:

```sh
npm install @beetlio/connect
npx beetl-connect --help
```

## Quick start

Create an `integration.ts` file:

```ts
import { defineIntegration, input, z } from "@beetlio/connect";

const Repository = z.object({
  id: z.number(),
  name: z.string(),
  html_url: z.url(),
});

export default defineIntegration({
  key: "github",
  displayName: "GitHub repositories",
  connection: {
    baseUrl: "https://api.github.com",
  },
  syncs: (defineSync) => [
    defineSync({
      key: "repositories",
      displayName: "Repositories",
      mode: "snapshot",
      records: Repository,
      primaryKey: ["id"],
      inputs: input.object({
        user: input.string({ label: "GitHub user", default: "octocat" }),
      }),
      async run(ctx) {
        const user = encodeURIComponent(ctx.config.sync.user);
        const response = await ctx.fetch(`/users/${user}/repos?per_page=100`);
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        await ctx.emit({
          records: z.array(Repository).parse(await response.json()),
        });
      },
    }),
  ],
});
```

Check it, then run it. The first sync prompts for the declared input and saves a
local profile:

```sh
beetl-connect check .
beetl-connect sync . repositories --output repositories.ndjson
head -n 1 repositories.ndjson
```

Paths passed to `ctx.fetch()` must be relative to the configured API origin and
begin with `/`. Connect keeps authentication input and OAuth authorization state
outside integration code and adds authentication when it sends each request.

## Commands

| Command                                                                  | Purpose                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| `pack <integration>`                                                     | Build a portable `.beetl.zip` artifact              |
| `check <integration>`                                                    | Type-check and validate an integration              |
| `configure <integration> [key] [--profile <name>] [--connection <name>]` | Configure sync inputs and select a named connection |
| `connect <integration> [--connection <name>]`                            | Create or reauthorize a named connection            |
| `verify <integration> [--connection <name>]`                             | Verify a named connection                           |
| `sync <integration> [key]`                                               | Run one sync and write NDJSON records               |

Run `beetl-connect <command> --help` for command-specific options. The
integration argument can be an entry file or a directory containing
`integration.ts`. The CLI type-checks source integrations with its bundled
TypeScript compiler, then bundles the entry, local imports, and installed npm
dependencies. Install dependencies in the integration project with its package
manager; a separate TypeScript compiler is not required. Integrations that use
npm packages must declare them in `dependencies` and commit a current
`package-lock.json`; other lockfile formats are not supported yet. Node built-in
modules, Node-only globals, native add-ons, and runtime-computed imports are
rejected so artifacts stay portable. Commands also accept a packed `.beetl.zip`;
running an artifact does not require TypeScript, npm, or the integration's dependencies.
Artifacts contain the executable bundle, manifest, license notices, and SHA-256
integrity metadata. They intentionally omit the original TypeScript source.

Local commands use the `default` profile unless `--profile <name>` is supplied.
Profiles contain only sync inputs and a named connection reference. If the
selected profile is missing and the sync declares inputs, the CLI configures it
interactively before continuing.

`connect` collects the connection inputs and authentication inputs declared by
the integration. For OAuth, it then opens the authorization flow and stores the
provider-issued access token, refresh token, and other declared token fields as
authorization state. Integration code receives none of these secrets.

```sh
beetl-connect connect .
beetl-connect configure . repositories
beetl-connect sync . repositories
```

Named connections are stored under `.beetl/connections` with owner-only
permissions. They include connection inputs, authentication inputs, and OAuth
authorization state where applicable. They are not encrypted, so treat the
local machine and working directory as trusted. Incremental sync state is stored
separately under `.beetl/state`.

## Output and state

Append syncs are the default: each run writes a new NDJSON file and can resume
from its latest checkpoint. A sync can instead declare `mode: "snapshot"`; the
CLI replaces the file selected by `--output` only after the new snapshot
succeeds. Without `--output`, each run uses a new timestamped filename.

`ctx.paginate()` supports cursor, offset, and provider-supplied next-URL APIs.
Each yielded page includes the response status and normalized headers. Integrations can
also issue requests directly for custom pagination and checkpoint strategies. Retries
apply to safe HTTP methods by default and can be configured per connection. The CLI
rejects provider response bodies larger than 16 MiB.

## Examples

| Integration                                                    | Demonstrates                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Basic dummy API](examples/basic/integration.ts)               | Definition, validation, verification, direct fetch, and snapshot output      |
| [All features dummy API](examples/all-features/integration.ts) | OAuth, configuration, retries, headers, pagination, checkpoints, and logging |
| [Wikidata](examples/wikidata/integration.ts)                   | A real unauthenticated public API with bounded cursor pagination             |

The dummy integrations use the reserved `api.example.com` domain and local
fixture servers. Wikidata structured data is available under
[CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); follow Wikimedia's
[API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
when adapting the public example.

Configure and run the Wikidata example interactively:

```sh
beetl-connect sync examples/wikidata entities
```

For automation, provision the named connection at
`.beetl/connections/wikidata/default.json`:

```json
{
  "integration": "wikidata",
  "name": "default",
  "inputs": { "userAgent": "my-wikidata-sync/1.0 (me@example.com)" },
  "authenticationInput": {}
}
```

Then provision `.beetl/profiles/wikidata/default.json`:

```json
{
  "integration": "wikidata",
  "sync": "entities",
  "connection": "default",
  "inputs": { "search": "open source", "language": "en", "maxResults": 25 }
}
```

```sh
beetl-connect sync examples/wikidata entities
beetl-connect pack examples/wikidata --output wikidata.beetl.zip
```

Replace the example email with your contact information. The command writes a
timestamped NDJSON snapshot to the current directory.

## Using Connect from another application

The CLI is the primary interface. Applications that need to execute the same
integrations with their own authentication, request, and persistence services can
implement the optional `SyncHost` interface from `@beetlio/connect/host`. See
the runnable [custom host example](examples/custom-host/host.ts).

## Development

```sh
npm install
npm run check
npm test
```

## Current scope

Connect is a standalone local CLI and integration toolkit. It supports named
connections. Local connection files are owner-readable but are not encrypted,
and there is no registry or sandbox for untrusted integrations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
