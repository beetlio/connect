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
- Self-contained, Deno-compatible `.beetl.zip` artifacts
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
    origin: "https://api.github.com",
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
begin with `/`. Connect keeps credentials and OAuth authorization state
outside integration code and adds authentication when it sends each request.

## Commands

| Command                                                                  | Purpose                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| `pack <integration>`                                                     | Build a Deno-compatible `.beetl.zip` artifact       |
| `check <integration>`                                                    | Type-check and validate an integration              |
| `configure <integration> [key] [--profile <name>] [--connection <name>]` | Configure sync inputs and select a named connection |
| `connect <integration> [--connection <name>] [--origin <url>]`           | Create or reauthorize a named connection            |
| `verify <integration> [--connection <name>]`                             | Verify a named connection                           |
| `sync <integration> [key]`                                               | Run one sync and write NDJSON records               |

Run `beetl-connect <command> --help` for command-specific options. `pack`
accepts an entry file or a directory containing `integration.ts`. It type-checks
source with the bundled TypeScript compiler and bundles local imports and
installed npm dependencies into neutral ESM. Dependencies must be declared in
`dependencies` and pinned by a current npm v3 `package-lock.json`; other lockfile
formats are not supported yet.

`check`, `configure`, `connect`, `verify`, and `sync` also accept a packed
`.beetl.zip`. Artifacts contain the bundle, manifest, Deno runtime declaration,
license notices, SHA-256 integrity metadata, and inline source maps without
source contents. They run without the integration source, npm, or installed
dependencies. Neutral bundling rejects Node built-ins and other unresolved imports.

Artifact hashes detect corruption, not provenance. A hosted platform must accept
source workspaces, install their committed npm graph with lifecycle scripts disabled
inside an untrusted build sandbox, and record the artifact digest it produced. It
must not treat an uploaded `.beetl.zip` and its self-declared hashes as trusted.

Connection and sync configuration must use `input.object()` and the non-secret
`input.*` field helpers. Authentication uses the separate `credential.*` helpers.
Each descriptor directly owns its parser and manifest representation; ordinary Zod
schemas remain available for records and checkpoints. Provider traffic must use
`ctx.fetch()`. The local CLI is not a sandbox, so only run integrations you trust.

Local commands use the `default` profile unless `--profile <name>` is supplied.
Profiles contain only sync inputs and a named connection reference. If the
selected profile is missing and the sync declares inputs, the CLI configures it
interactively before continuing. An explicitly requested missing profile is an error.

`connect` collects connection inputs and credentials declared by
the integration. For OAuth, it then opens the authorization flow and stores the
provider-issued access token, refresh token, and other declared token fields as
authorization state. Integration code receives none of these secrets.

```sh
beetl-connect connect .
beetl-connect configure . repositories
beetl-connect sync . repositories
```

Profiles and named connections are stored with owner-only permissions in the
operating system's user configuration directory: `$XDG_CONFIG_HOME/beetl-connect`
on Linux, `~/Library/Preferences/beetl-connect` on macOS, and
`%APPDATA%\beetl-connect\Config` on Windows. Connections include credentials
and OAuth authorization state where applicable. Each connection binds
those secrets to the provider origin and authentication definition; a mismatch
requires reconnecting. Files are not encrypted, so treat the local user account
as trusted. Incremental sync state remains in the workspace under `.beetl/state`.

## Output and state

Append syncs are the default: each run writes a new NDJSON file and can resume
from its latest checkpoint. A sync can instead declare `mode: "snapshot"`; the
CLI replaces the file selected by `--output` only after the new snapshot
succeeds. Without `--output`, each run uses a new timestamped filename.
Profiles and connections carry revisions. `configure` preserves a profile
revision when nothing changed, while changed inputs and explicit `connect`
operations create new revisions. Automatic OAuth refresh preserves the
connection revision. Default checkpoint paths include both revisions so changed
filters or credentials cannot silently reuse older state. Existing checkpoint
files are retained, and `--state` can select one explicitly.

`ctx.paginate()` supports cursor, offset, and provider-supplied next-URL APIs.
Each yielded page includes the response status and normalized headers. Integrations can
also issue requests directly for custom pagination and checkpoint strategies. Retries
apply to safe HTTP methods by default and can be configured per connection. The CLI
rejects malformed or repeated continuations, follows continuations across empty pages,
limits pagination to 10,000 pages, and rejects provider response bodies larger than 16 MiB.

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

For automation, provision the named connection under the user configuration
directory at `connections/wikidata/default.json`:

```json
{
  "integration": "wikidata",
  "name": "default",
  "revision": "22222222-2222-4222-8222-222222222222",
  "provider": {
    "origin": "https://www.wikidata.org",
    "authentication": { "type": "none" }
  },
  "inputs": { "userAgent": "my-wikidata-sync/1.0 (me@example.com)" },
  "credentials": {}
}
```

Then provision `profiles/wikidata/default.json` in the same directory:

```json
{
  "integration": "wikidata",
  "sync": "entities",
  "connection": "default",
  "revision": "11111111-1111-4111-8111-111111111111",
  "inputs": { "search": "open source", "language": "en", "maxResults": 25 }
}
```

When provisioning these files directly, generate a new UUID revision whenever
their inputs or authorization change. `configure` and `connect` do this automatically.

```sh
beetl-connect sync examples/wikidata entities
beetl-connect pack examples/wikidata --output wikidata.beetl.zip
```

Replace the example email with your contact information. The command writes a
timestamped NDJSON snapshot to the current directory.

## Using Connect from another application

The CLI is the primary interface. Applications that need to execute the same
Deno-compatible artifacts with their own authentication, request, and persistence services
can implement the optional `SyncHost` interface from `@beetlio/connect/host`. See
the runnable [custom host example](examples/custom-host/host.ts). `SyncHost` is a
capability boundary, not a sandbox: custom executors must prevent integration
code from reaching providers directly. The production boundary belongs in an
isolated runtime with provider egress allowed only through the trusted host.

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
