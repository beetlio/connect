# Compatibility

SDK 0.6 uses manifest v5, host contract v5, and process protocol v3. Source definitions
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

Append or replace is host storage policy; execution is identical for both. A replacing
host starts without a checkpoint, stages records, and publishes the complete dataset
only after the run and any continuations succeed, including an empty dataset. Saved
progress must match published data, so failed runs preserve it. Append does not
deduplicate records or update existing rows.

Credential injection, origin restrictions, retries, OAuth refresh persistence, cancellation,
and error precedence remain SDK responsibilities. Hosts settle authentication before
reporting success. Integration and cleanup failures must remain visible.

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
