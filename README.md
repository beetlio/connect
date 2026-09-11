<p align="center">
  <img src="docs/beetl-logo.svg" alt="Beetl" width="96">
</p>

# Connect

[![npm version](https://img.shields.io/npm/v/%40beetlio%2Fconnect.svg)](https://www.npmjs.com/package/@beetlio/connect)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Build API integrations in TypeScript and run them from your terminal. Connect
validates integration code, manages local configuration and authentication, fetches
and validates records, and writes NDJSON.

[Documentation](https://beetlio.github.io/connect/) · [Examples](examples/) · [Contributing](CONTRIBUTING.md)

The hosted process exchange is specified in [Connect runtime protocol v1](docs/host-protocol.md).
Supported public APIs, artifact requirements, and reusable host fixtures are documented in
[Connect compatibility](docs/compatibility.md). Run `beetl-connect compatibility` to check an
installed SDK; embedding hosts can consume the same fixture inventory through their own execution path.

The demo runs the included Wikidata integration, fetches five records, and
inspects the emitted NDJSON.

[![Watch @beetlio/connect sync Wikidata](https://asciinema.org/a/1262370.svg)](https://asciinema.org/a/1262370)

> [!WARNING]
> This project is experimental and currently at `0.2.0`. APIs and local storage
> formats may change.

> [!IMPORTANT]
> Integrations are executable code. Only configure, pack, or run integrations you
> trust. Hosted builds must treat uploaded source packages as untrusted.

## What it does

- Builds and runs TypeScript API integrations from one CLI
- Validates provider responses and output records with Zod
- Bearer, basic, API-key, token-exchange, custom, and OAuth 2.0 authentication
- Cursor and offset pagination helpers
- Managed retries, incremental checkpoints, and atomic replace generations
- Standard npm `.tgz` packages for hosted builds
- NDJSON output that works with tools such as `jq`, DuckDB, and data pipelines

## Install

Requires Node.js 24.2 or newer. Install the CLI globally:

```sh
npm install --global @beetlio/connect
```

Or install it in an integration project and run it with `npx`:

```sh
npm install --save-dev @beetlio/connect
npx beetl-connect --help
```

Integration projects are npm packages. Set `"type": "module"` and add an explicit
`"files": ["integration.ts", "src"]` allowlist to `package.json`; npm creates and
maintains the required `package-lock.json`.

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
      mode: "replace",
      records: Repository,
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

Configure it, then run it. Calling `sync` first opens the same configuration
flow when the default profile or connection is missing:

```sh
beetl-connect configure . repositories
beetl-connect sync . repositories --output repositories.ndjson
head -n 1 repositories.ndjson
```

Paths passed to `ctx.fetch()` must be relative to the configured API origin and
begin with `/`. Connect keeps credentials and OAuth authorization state
outside integration code and adds authentication when it sends each request.
Await all context promises. Requests still running when the integration returns are cancelled;
emits and logs already submitted before return are settled in order as cleanup.

## Commands

| Command                                                                                                                     | Purpose                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `configure <integration> [key] [--inputs <json>] [--profile <name>] [--connection <name>] [--origin <url>] [--reauthorize]` | Configure connection and sync inputs, authenticate, verify |
| `sync <integration> [key]`                                                                                                  | Validate and run one sync                                  |
| `pack <directory>`                                                                                                          | Create an npm package for a hosted build                   |

Run `beetl-connect <command> --help` for command-specific options. `pack`
accepts a self-contained npm application containing `integration.ts`, `package.json`,
and the committed `package-lock.json`. Its `package.json` must contain an explicit
`files` allowlist so local state, output, and environment files are not uploaded by
accident. Connect uses `npm pack --ignore-scripts`, adds the lockfile to the resulting
`.tgz`, rejects npm-selected files outside that allowlist and private runtime paths at
any depth, and prints the included files. Package metadata, README, and license files
remain implicit. Registry dependencies and npm aliases are supported. Local paths,
workspaces, Git repositories, and remote tarballs are not reproducible registry
dependencies and are rejected by `pack`. Dependency declarations must exactly match
the lockfile root.

```json
{ "files": ["integration.ts", "src", "icon.png"] }
```

The npm package is transport, not a trusted build artifact: `pack` does not compile
or execute the integration. A hosted platform must safely unpack it inside an
untrusted build job, enforce package limits, run `npm ci --ignore-scripts`, validate
the exact upload, and call the same builder used by the local CLI:

```ts
import { buildIntegration } from "@beetlio/connect/builder";

const { archive, manifest, icon, sdkVersion } = await buildIntegration("/workspace/integration");
```

The builder compiles the package into a Node.js 24.2 module tree, prunes development
dependencies with npm, adds the runtime SDK, and returns it as an immutable `.tgz` archive.
Normal ESM, CommonJS dependencies, package assets, `__dirname`, and `import.meta.url` keep
their ordinary Node behavior because dependencies are not forced into one JavaScript file.
The runtime entry validates its definition against the build manifest when loaded. Runtime
jobs extract and execute the archive in gVisor on an isolated node pool. `sync` uses the same
builder and archive loader for local development.

Builds never run dependency lifecycle scripts. Packages that require install-time code or native
compilation are outside the first-release runtime contract.

Connection and sync configuration must use `input.object()` and the non-secret
`input.*` field helpers. Built-in authentication owns its credential schema; custom
authentication uses `credential.*`. Each descriptor directly owns its parser and manifest
representation; supported Zod schemas define records and representation-preserving JSON-compatible
Zod schemas define opaque checkpoints. Use `ctx.fetch()` for managed
authentication, retries, and origin enforcement. Hosted jobs may make direct external
requests, but those requests receive none of the connection's managed credentials.
The local CLI is not a sandbox, so only run integrations you trust.

Hosted v1 likewise treats uploaded integrations as operator-approved executable
code. gVisor isolates the workload from platform infrastructure; it does not prevent
integration code or an npm dependency from forwarding fetched data to another external
service. Third-party marketplace integrations require a separate egress policy and are
outside the first release.

Built-in authentication declarations own their credential schemas: bearer and API keys
are non-empty secrets, Basic auth permits an empty password, and OAuth uses
`clientSecret: true` for confidential clients. `credential.string()` and
`credential.secret()` are the explicit escape hatch for `auth.custom()` and
`auth.tokenExchange()`; add `minLength` when an empty custom credential is invalid.

Local commands use the `default` profile unless `--profile <name>` is supplied.
Profiles contain only sync inputs and a named connection reference. `configure`
collects connection and sync inputs in one object, prompts separately for masked
credentials, authenticates, and verifies before saving either object:

```sh
beetl-connect configure . repositories \
  --inputs '{"connection":{},"sync":{"user":"octocat"}}'
```

Existing credentials and OAuth state are retained. Use `--reauthorize` to collect
credentials and authorize again. Provider-issued access tokens, refresh tokens,
and other authorization state remain unavailable to integration code. If the
default profile or connection is missing, `sync` enters the same configuration
flow. An explicitly requested missing profile is an error.

The local OAuth authorization-code flow uses
`http://localhost:53682/oauth/callback`; register that redirect URI with the provider.
It uses PKCE and either a public client or `client_secret_post`. Hosted authorization
does not use this loopback address: the platform owns its public callback URL, performs
the OAuth exchange, and stores the resulting authorization state. Redirect addresses
therefore do not belong in uploaded integration source.

`auth.tokenExchange()` supports APIs that exchange long-lived credentials for a
short-lived bearer token. The host caches the token until its declared expiration and
automatically exchanges it again before expiry or after a 401 response.

For session or client-credentials APIs, token exchange also accepts a `body` with `encoding`
(`json` or `form`), credential-name mappings in `fields`, and static strings in `values`.
Optional `basic` maps credential names to the exchange's username/password. Use `expiresInPath`
for a numeric lifetime in the response, or `expiresInSeconds` for a documented fixed session
lifetime. `tokenHeader`/`tokenPrefix` select the resulting session header; `requestHeaders` maps
original credentials required alongside that session on data requests. Credential values remain
inside the host. Existing header-only exchanges and absolute expiration paths continue to work.

Account-specific providers may declare `origin: { input: "origin" }` with a required connection
string input using `format: "url"`. The host validates an HTTPS origin (or loopback HTTP), without
userinfo, paths or query strings. OAuth issuer, authorization and token URLs can then be paths
relative to that origin. Both hosted authorization requests include `connectionConfig`; refresh
uses the same resolved account. An origin learned only from the token response still requires
absolute OAuth endpoints.

`storageRecord(sourceObjectSchema)` adapts provider schemas to fixed storage columns. It validates
the original source values, keeps typed nested objects/arrays and scalar columns, and serializes
dynamic maps or heterogeneous structured values as JSON text. Mixed primitive IDs or amounts use
text; optional and nullable fields remain optional or nullable. Use it for the sync's `records`
declaration while continuing to parse API responses with the original source schema. It requires
a plain object without root refinements or open catchall columns, and retains strict-root rejection
of unknown keys when the source is strict. This projection avoids dynamic or mixed-type JSON schemas
that the hosted tabular storage cannot represent.

Profiles and named connections are stored with owner-only permissions in the
operating system's user configuration directory: `$XDG_CONFIG_HOME/beetl-connect`
on Linux, `~/Library/Preferences/beetl-connect` on macOS, and
`%APPDATA%\beetl-connect\Config` on Windows. Connections include credentials
and OAuth authorization state where applicable. Each connection binds
those secrets to the provider origin and authentication definition; a mismatch
requires configuring again. Files are not encrypted, so treat the local user account
as trusted. Incremental sync state remains in the workspace under `.beetl/state`.

## Output and state

Append syncs are the default: each run writes a new NDJSON file and can resume
from its latest checkpoint. A Replace sync declares `mode: "replace"`; the CLI
stages the complete local run and replaces the file selected by `--output` only
after it succeeds. A Merge sync
declares a non-empty, top-level `primaryKey` and emits upsert records plus explicit
deleted keys:

```ts
await ctx.emit({
  records: [{ id: "updated", name: "Updated" }],
  deletedKeys: [{ id: "deleted" }],
  checkpoint: { cursor: "next" },
});
```

Merge output is one batch envelope per NDJSON line containing `records` and, when
present, `deletedKeys`. This preserves the integration contract for local inspection
without reproducing a destination materializer. Append and Replace output remains one
record per line. Local runs consume all emitted batches; a hosted controller may end a worker segment
internally after durably committing a checkpoint-bearing batch. Platform scheduling remains
invisible to the integration. Without `--output`, each run uses a new timestamped filename.

For snapshots that hydrate individual records or flatten child resources, use
`const output = createRecordBatcher(ctx.emit)`, send arrays through `output.emit({ records })`,
and call `await output.flush()` after the scan succeeds. The helper groups at most 100 records
with a 1-MiB JSON input target; a larger single record is sent separately and remains subject to
host limits. Do not use it for checkpointed batches, whose acknowledgments must stay immediate.

Record schemas must be Zod object schemas whose output is a non-null, top-level JSON
object. Nested objects and arrays are allowed. Connect generates the canonical JSON Schema
in the build manifest and uses the original Zod schema for runtime validation. The downstream
consumer decides whether that JSON Schema maps to its supported storage types. Merge key fields must be
present at the top level, required, scalar, and non-null. Merge record schemas cannot use a
root-level Zod `overwrite()`; normalize individual fields so records and deletion keys use the
same transformation.

Checkpoint schemas validate without rewriting: the same JSON value is emitted, persisted, and
supplied as `ctx.checkpoint` on the next run. Decode provider cursors inside `run()` when needed.
Profiles and connections carry revisions. `configure` preserves revisions when
nothing changed, while changed inputs and `--reauthorize` create new revisions.
Automatic OAuth refresh preserves the connection revision. Default checkpoint paths
include the built artifact digest and both revisions so changed code, filters, or
credentials cannot silently reuse older state. Existing checkpoint files are retained,
and `--state` can select one explicitly.
Only one local process may use a state path at a time. Configuration and OAuth-backed
syncs also lock their named connection so authorization refresh cannot race. A
concurrent operation fails instead of waiting. If a process is forcibly killed, remove
the adjacent `.lock` file only after confirming that no operation still uses it.

`ctx.paginate()` supports cursor, offset, and provider-supplied next-URL APIs.
Each yielded page includes the response status and normalized headers. Integrations can
optionally set `hasMorePath` when a response boolean explicitly controls whether pagination
continues. Page schemas validate provider values without rewriting them; the sync record schema
normalizes records once at `ctx.emit()`. Integrations can also issue requests directly for custom
pagination and checkpoint strategies.
Set `onResponseError: async (response) => { ... }` to translate unsuccessful paginated responses
into provider-specific setup or permission guidance. It receives a response clone; if it returns
without throwing, normal pagination error handling still applies.
Retries apply to safe HTTP methods by default and can be configured per connection. The CLI rejects
malformed or repeated continuations, follows continuations across empty pages, limits pagination to
10,000 pages, and rejects provider response bodies larger than 16 MiB.

## Migrating from 0.1

Manifest v2 and SDK 0.2 are intentionally breaking. Rename `mode: "snapshot"` to
`mode: "replace"`; Replace checkpoints now belong to the in-progress generation. Remove
`primaryKey` from Append and Replace syncs. Syncs that update existing keys should use
`mode: "merge"`, declare a non-empty `primaryKey`, and emit explicit `deletedKeys` when the
source reports deletion. Wrap primitive record schemas in a top-level object schema. Hosted sync
launches now pass `runtimePath` instead of `integrationPath`, `outputPath`, and `statePath`.
The runtime exchanges batches and commit acknowledgments over NDJSON; the external controller keeps
publication credentials and the hard deadline outside integration code.

## Examples

| Integration                                                    | Demonstrates                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Basic dummy API](examples/basic/integration.ts)               | Definition, validation, verification, direct fetch, and replace output       |
| [All features dummy API](examples/all-features/integration.ts) | OAuth, configuration, retries, headers, pagination, checkpoints, and logging |
| [Wikidata](examples/wikidata/integration.ts)                   | A real unauthenticated public API with bounded cursor pagination             |

The dummy integrations use the reserved `api.example.com` domain and local
fixture servers. Wikidata structured data is available under
[CC0](https://www.wikidata.org/wiki/Wikidata:Licensing); follow Wikimedia's
[API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines)
when adapting the public example.

Configure and run the Wikidata example interactively:

```sh
beetl-connect configure examples/wikidata entities
beetl-connect sync examples/wikidata entities
```

```sh
beetl-connect configure examples/wikidata entities \
  --inputs '{"connection":{"userAgent":"my-wikidata-sync/1.0 (me@example.com)"},"sync":{"search":"open source","language":"en","maxResults":25}}'
beetl-connect sync examples/wikidata entities
beetl-connect pack examples/wikidata --output wikidata.tgz
```

Replace the example email with your contact information. The command writes a
timestamped NDJSON replacement to the current directory.

## Embedding a host

Host applications can use the supported package entry points:

```ts
import {
  LocalHost,
  resolveProviderOrigin,
  type LocalHostOptions,
} from "@beetlio/connect/local-host";
import {
  beginOAuthAuthorization,
  completeOAuthAuthorization,
  refreshOAuthAuthorization,
  type OAuthAuthorizationState,
} from "@beetlio/connect/oauth";
```

`LocalHost` accepts an optional `onAuthorizationRefreshRequested(signal)` callback.
It awaits this callback once per shared OAuth refresh, before sending the token
request. A host can acquire its refresh claim here; rejecting the callback prevents
that exchange. The signal belongs to the host, so cancelling one provider request
cannot cancel a refresh that other requests still need. Use it to cancel any I/O
performed by the callback.

After the exchange, the existing `onAuthorizationStateChanged(state)` callback is
awaited before the host adopts the new credentials and provider origin. Together,
the callbacks support **claim → exchange → persist → use**, without intercepting
HTTP 401 responses. Omitting the new callback preserves local CLI behavior.

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
