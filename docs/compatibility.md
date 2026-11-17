# Compatibility

SDK 0.7 uses manifest v5, host contract v5, and process protocol v3. Source definitions
and artifacts from before SDK 0.5 are unsupported; frozen artifacts remain unchanged
rejection fixtures.

## Sync contract

Integrations emit records and, when the sync declares a checkpoint schema, checkpoints.
They do not choose a storage mode, declare sync primary keys, or emit deletions. Without
a supplied checkpoint they start from the beginning; with one they resume from that position.

Checkpoints follow the sync definition, not an execution option. For a sync with a
checkpoint schema, a supplied checkpoint is validated and passed in, and emitted
checkpoints are validated and returned on their batch. Supplying a checkpoint to a sync
without a schema is an error. Checkpoints must be JSON-compatible and validation cannot
change their serialized value; absent and null are distinct.

The host commits each batch before the generator advances. A failed commit cannot
advance progress. Continuation requires a checkpoint on the stopping batch.

A sync that stops on its own before reading everything available returns
`{ hasMore: true }` from its generator, after committing a checkpoint that differs from the
one it started with. The run then ends with `continuation_required`, as when the host stops
it. Returning nothing or `{ hasMore: false }` completes the run. Any other return value,
such as a misspelled key, a non-boolean `hasMore`, or extra fields, fails it. Hosts
running SDK 0.6 or earlier ignore the returned value and report `completed`.

Append or replace is host storage policy; execution is identical for both. A replacing
host starts without a checkpoint, stages records, and publishes the complete dataset
only after the run and any continuations succeed, including an empty dataset. Saved
progress must match published data, so failed runs preserve it. Append does not
deduplicate records or update existing rows.

Connections may declare `redirects: { origins, max? }`. The provider then follows GET and
HEAD redirects to the connection origin or a listed HTTPS origin, sends no credentials or
connector headers across origins (query credentials copied into the target are removed),
and reports followed hops on the provider response as
`redirects` (origin and path of each source, origin of each target). Hosts log them at
debug level. Artifacts that declare `redirects` need a host running SDK 0.7 or later;
older hosts reject the manifest field.

`HttpError.crossOrigin` is true when the provider followed a redirect and an origin other
than the connection's answered, for example an expired signed storage URL. Hosts should
treat only a 401 with `crossOrigin: false` as rejected connection credentials. The SDK
also refreshes OAuth tokens only after a connection-origin 401. An `HttpError` that
integration code constructs itself has `crossOrigin: false` unless it passes
`{ crossOrigin: true }`.

Credential injection, origin restrictions, retries, OAuth refresh persistence, cancellation,
and error precedence remain SDK responsibilities. Hosts settle authentication before
reporting success. Integration and cleanup failures must remain visible.

## Beetl platform checks

`beetl-connect pack` and `beetl-connect sync --strict` apply checks that Beetl Core applies
after upload or during a hosted run, with Core's messages. They belong to the CLI, not to
the executor or the manifest: `runSync`, `buildIntegration`, and the process adapter behave
as before, and built manifests are unchanged, so existing artifacts still load.

- Record schemas must map to Core's storage types: string, integer, number, boolean, closed
  objects, and arrays of one item type, each optionally nullable. `$ref`, `allOf`, `oneOf`,
  open or property-less objects (`z.record()`, `z.looseObject()`, `z.json()`), tuples, and
  unions of several types are rejected at any depth. Core rejects these at upload, so
  `pack` fails on them.
- Core accepts `format: "uri"` (`z.url()`) and `format: "duration"` (`z.iso.duration()`) at
  upload but validates values by RFC 3986 and RFC 3339, which rejects values Zod accepts,
  such as URLs with spaces or non-ASCII hosts and durations like `PT1.5S` or `P1Y2D`. A run
  that emits such a value fails. `pack` warns about these fields and `sync --strict` fails
  on them. Core's own `url` format uses WHATWG parsing like Zod, but rewriting the manifest
  would make artifacts built by older SDKs fail their manifest check, so the CLI suggests
  `z.string()` or `storageRecord()` instead.
- A strict run fails past 10,000 batches, 1 GiB of records as NDJSON, an 8 MiB batch
  envelope, 1 GiB of memory, or 15 minutes, and requests `stop` at the next changed
  checkpoint once half of a run limit is used or less than five minutes remain. The CLI then
  starts a new run from that checkpoint. The 10,000-record batch limit and 16 MiB provider
  response limit apply in every mode.
- Memory is approximated. A hosted run starts each segment in a fresh process; the CLI
  process also holds its own build and earlier segments. A strict segment therefore counts
  the CLI's resident size once its modules have loaded, as an estimate of a fresh process,
  plus how much the resident size grew since the segment started. Platform differences in
  process size, and memory the CLI frees but the operating system has not reclaimed, can
  move the local result either way. A sync that blocks the event loop cannot be stopped
  locally.

## Migration from 0.6

Integration code written for 0.6 compiles and runs unchanged, and the process protocol
stays v3. Artifacts that declare `redirects` need a 0.7 host. Other changes:

- `SyncEnd` is `void | { hasMore: boolean }`. `{ hasMore: false }` completes a run like
  returning nothing; 0.6 hosts reject it.
- `HttpError` has `crossOrigin`. Hosts should treat only a 401 with `crossOrigin: false`
  as rejected connection credentials.
- `pack` now builds the integration before packaging. It fails where 0.6 packed:
  - TypeScript errors, or a definition that fails to load or validate;
  - installed dependencies that are missing or differ from `package-lock.json` (run
    `npm ci` first);
  - record schemas Core rejects at upload, listed above.
- `pack` warns about `z.url()` and `z.iso.duration()` record fields, and writes
  `<key>.beetl.tgz` into the integration directory instead of npm's file name in the working
  directory. `--output` still chooses the path.
- `configure` and `sync` also check installed dependencies. Optional, dev-optional, and
  other-platform lockfile entries are not required.
- `sync --strict` applies the checks above. `sync` prints the state file it resumes from,
  input errors show the expected `--inputs` shape, and the CLI exits with a message on
  Node.js older than 24.2.

## Migration from 0.5

Integration code and built artifacts are unchanged. Remove `mode` and `checkpointing`
from `runSync` input and process requests, and send protocol v3. Checkpoints flow
whenever the sync declares a schema; omit the checkpoint to start over. `SyncMode` is no
longer exported. The CLI drops `--checkpointing`: syncs with a checkpoint save and resume
progress, and `--mode replace` starts from the beginning.

## Migration from 0.4

Remove `mode` and `primaryKey` from sync definitions and `deletedKeys` from emitted
sync batches; the host chooses how records are stored. Sync results no longer contain a
deletion count. Rebuild integrations with SDK 0.5 or later, then apply the 0.5 migration
above. Destination behavior is unchanged.

Author `syncs` and `destinations` through callbacks passed to `defineIntegration`.
Both collections are optional when authoring and always present after normalization.
The returned definition and loaded artifacts use empty objects for omitted collections.
Plain destination objects are no longer accepted by `defineIntegration`.

## Destination batches

`destinations` sit alongside `syncs` and share the connection and SDK provider.
Integrations may declare either or both. Each destination requires a `records` object
schema, a `primaryKey`, and `async run(ctx, batch)`. Optional `inputs` configure the
destination; `supportsDelete` defaults to `false`. Context provides
`config.connection`, `config.destination`, requests, pagination, logging, and cancellation.

`runDestinationBatch(integration, input, host)` from `@beetlio/connect/host` accepts
`destination`, optional connection/destination configuration and signal, and a batch:

```ts
{ batchId: "delivery-42", records: [{ id: "one", email: "one@example.com" }], deletedKeys: [{ id: "gone" }] }
```

`batchId` must be a non-empty string. Records are upserts containing mapped desired
state. Deletions contain exactly the primary-key fields and require `supportsDelete`.
Keys must be required, scalar, and non-null; coercion is rejected anywhere in a key schema,
including input and intermediate pipeline stages. The manifest
exposes the schema's accepted input for mapping. Unknown root record fields are rejected.
Author parsing may normalize records; parsed output must remain JSON-compatible.

Before invoking destination code or provider requests, the executor snapshots caller
data and validates the complete batch: at most 10,000 records plus deletions, at most
8 MiB of UTF-8 JSON for both received and normalized batches, and no duplicate or
conflicting normalized keys. Validation never mutates caller input. The batch and its
rows are readonly in the authoring API; integrations must treat them as immutable.

Resolution acknowledges the entire batch; any execution, cancellation, or cleanup error
rejects it. A provider may already have accepted some writes. Destinations must make
whole-batch replay safe, including repeated deletions, and reject unsuccessful items
even when a bulk API returns HTTP 200. Use provider idempotency support where available.
The SDK does not retry a whole destination batch or guarantee exactly-once delivery.

Core owns Delta CDC, field mapping, coalescing latest state, ordering, immutable batch
identities, acknowledgments, and durable progress. Replay uses the same ID, contents,
mapping, and destination configuration; a changed payload needs a new delivery identity.
Core defines what happens when a destination cannot delete. The SDK receives neither
Delta metadata nor a destination checkpoint. Destination execution is embedded only;
CLI profiles and process-protocol operations remain pull-only.

## OAuth for embedding hosts

Use `prepareOAuthAuthorization(connection, { connectionConfig, credentials })` from
`@beetlio/connect/host` to resolve configuration-dependent OAuth origins in the SDK.
It returns options for the existing authorization functions:

```ts
const options = {
  ...(await prepareOAuthAuthorization(connection, { connectionConfig, credentials })),
  redirectUri,
};
const request = await beginOAuthAuthorization(options);
// After redirecting the user and receiving the callback:
const authorization = await completeOAuthAuthorization({
  ...options,
  state: request.state,
  codeVerifier: request.codeVerifier,
  callbackUrl,
});
```

Reuse the prepared options for the attempt. Hosts handling start and callback in separate
processes must retain the same connection definition, configuration, and credentials.
Absolute OAuth endpoints need no connection configuration; relative endpoints require
an origin available before authorization. Preparation is a convenience over v3 behavior;
it adds no artifact or protocol requirement. Existing explicit `{ auth, origin, credentials }`
options remain supported.

## Versions and releases

The npm release, manifest format, host contract, and process protocol are separate
versions. This release targets only manifest and host contract v5. Unsupported artifacts
are rejected before integration code is imported. Loaded definitions must match their
build manifests. Public breaking changes require a breaking release (minor before 1.0).
Never replace published or frozen bytes.

## Reusable fixture inventory

Run `npm test` for a fresh build, SDK tests, and installed-package checks. Focused
`npm run test:compatibility` builds fixtures and executes mocked provider scenarios.
The inventory is available as `compatibilityFixturesUrl` from `@beetlio/connect/builder`.
Resolve its artifact and source paths relative to that URL. Hosts should execute the
same scenarios through their own adapter; passing SDK tests alone does not verify Core.

Current fixtures cover bearer, token exchange, OAuth, pagination, checkpoints, provider
errors, and destination upserts, deletions, validation, and replay. Historical v2 and v3
artifacts in `compatibility/frozen/` are checked for rejection and retain their hashes
and provenance. They are never rebuilt by the current SDK.
