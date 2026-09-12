# Compatibility

Beetl Connect SDK 0.4 builds **manifest v4** and **host contract v4**. It also supports
unchanged v3 pull artifacts and source. The process protocol remains **v1**; v1/v2
artifacts are rejected before import.

## Public contract

The [package exports and process entry point](../ARCHITECTURE.md#public-surfaces)
are supported APIs. Other source/dist paths, bundled dependencies, form adapters,
and origin helpers are internal.

For supported contracts, Connect preserves documented API and execution semantics:
authentication ordering, records, acknowledgments, and checkpoint meaning. Security
fixes and corrections to invalid behavior must be documented and regression-tested.
Incidental timing is not part of the contract.

Credential prompts mask `writeOnly` fields. Explicit token-exchange headers replace
defaults case-insensitively; a configured body determines `Content-Type`. Cancellation
stops requests, while generator cleanup can still log. Execution drains those logs
before returning; process-host verification and sync logs go to stderr.
Executors recheck caller cancellation after cleanup drains, so an abort during settlement
cannot report success. Existing execution and cleanup errors retain precedence.

Provider requests use `request.retry`, then `connection.retry`, then SDK defaults;
an explicit `false` disables retries. Authentication settlement rejects an unresolved
renewal failure. A successful exchange, or OAuth refresh persisted and adopted by the
provider, clears that failure. Hosts must settle on success and failure before reporting
success or releasing resources, retaining execution errors if settlement also fails.

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

| Version               | Meaning                                       |
| --------------------- | --------------------------------------------- |
| npm version           | SDK release                                   |
| `manifestVersion`     | Serialized manifest format                    |
| `hostContractVersion` | Host behavior required to execute an artifact |
| `protocolVersion`     | Process message format                        |

- A missing host requirement means legacy v1, which this SDK rejects.
- The builder targets v4, including for pull-only integrations; it does not infer requirements from function bodies.
- Authoring conveniences that compile to existing behavior do not raise the requirement.
- Behavior an older host cannot execute needs a newer requirement, even if the manifest shape is unchanged.
- New hosts support explicitly documented contracts. Dropping one requires a breaking release.

V3 covers keyed syncs, generators, ordered commits, schema-based pagination, all
authentication and origin definitions, retries, verification, merge deletions,
and opaque checkpoints. Hosts must use the SDK provider for these behaviors instead
of implementing their own auth-type switch.

V4 adds destination metadata and the embedded whole-batch execution contract above.
V3 artifacts must pair manifest v3 with host contract v3; v4 artifacts must pair v4
with v4. Loaded definitions must match the declared manifest, including destination
schemas and deletion capability. Unsupported versions and mixed pairs fail before import.

Patch releases preserve supported APIs. Compatible additions use minor releases.
Removed exports, incompatible types, changed parameters, defaults, or execution semantics,
and dropped contracts require a breaking release: minor before 1.0, major afterward.
Affected host or wire contracts need their own version change. Never change published
bytes under an existing version. New host behavior needs a fixture and documented requirements.

Source compatibility is separate. An artifact requirement cannot protect source that
no longer compiles. Build old source against the candidate SDK and execute previously
built artifacts for supported historical contracts; neither check replaces the other.
Source builds support native filesystem paths on Linux, macOS, and Windows.

## Protocol direction

New process hosts accept initial requests with no `protocolVersion` or with `1`.
Old strict-schema hosts may reject the added field. Existing callers must keep omitting
it until their host update is coordinated. Batch messages and acknowledgments require
`protocolVersion: 1`; wire action `yield` maps to embedded action `stop`.
See the [process protocol](host-protocol.md).

## Reusable fixture inventory

```sh
npm test                    # build, run SDK and installed-package checks
npm run test:compatibility   # prepare fixtures and check the compiled SDK
beetl-connect compatibility # check an installed SDK
```

Focused `test:*` commands reuse the compiled SDK; rebuild after source changes.
Compatibility and package checks prepare fixtures separately from ordinary compilation.
The installed check compiles a consumer, rebuilds a shipped fixture source, runs the
compatibility command, and checks process-host startup and version rejection.
Detailed protocol tests run in the SDK suite. `prepack` includes prepared fixtures
in the published package.

Beetl Core uses its own RPC host. It must run the same fixtures through that path;
passing the SDK's process-host suite alone cannot prove Core compatibility.

```ts
import { compatibilityFixturesUrl } from "@beetlio/connect/builder";
import { readFile } from "node:fs/promises";

const inventory = JSON.parse(await readFile(compatibilityFixturesUrl, "utf8"));
```

Inventory `formatVersion: 3` contains `fixtures` and `rejectedArtifacts`. Resolve paths
relative to `compatibilityFixturesUrl`.

- A fixture provides `id`, `artifact`, `sha256`, `source`, `sdk`, `hostContractVersion`,
  `manifest`, and `scenarios`.
- A scenario supplies an operation (`verify`, `sync`, `destination`, or `authorization`), inputs,
  ordered provider request/response steps, optional acknowledgments, and expected outcomes.
- Inputs include configuration, credentials, optional OAuth state, sync key, checkpoint,
  destination key/configuration and batch, or redirect URI. Expected outcomes cover batches, result, errors, verification,
  authorization, and authentication event ordering.

Mock only provider HTTP. Match every expected request field and consume every step;
execute real SDK authentication and sync code. Commit the requested actions and compare
outcomes, including absent versus null checkpoints. Authorization checks use the
prepared OAuth state and verify PKCE.

Destination scenarios exercise upserts, deletion-only batches, validation before HTTP,
and partial failure followed by replay. With `replay: true`, assert the first expected
error, then resubmit the identical input and require success. Match the provider steps
across both attempts and assert that execution leaves input unchanged.

Three families—bearer, token exchange, and OAuth—cover fixed, environment, and configured
origins; form/JSON exchange; relative OAuth endpoints; retries; verification; output;
continuation; refresh persistence; and checkpoint preservation. Sources in
`compatibility/sources/` share sync code. The destination fixture uses the runnable
`examples/destination/integration.ts`. Builds materialize complete source packages
at each inventory `source` path for consumers to pass to `buildIntegration`.

## Frozen provenance

`compatibility/frozen/` contains SDK 0.2 artifacts from commit
`34ebde36692fa95650ee986d53c1aea47612df59`, their sources, and provenance hashes.
They remain rejection fixtures from the 0.3 reset, not supported historical runtimes.
Each `rejectedArtifacts` entry gives a path, checksum, SDK commit, and expected error.

`compatibility/frozen/v3/` contains SDK 0.3 artifacts and unchanged source from commit
`cc298f3ce41ab91603ca7d36449628c0c3f6d099`. The inventory executes all six frozen artifacts
and rebuilds all six source packages with the candidate SDK. Provenance includes the
original lockfile and source hashes; current builds never replace historical bytes.

```sh
node compatibility/freeze.mjs --check # maintainer command, run from the SDK checkout
node compatibility/freeze.mjs --v3 --check
```

The freezer builds an isolated checkout of the pinned commit and verifies the source,
artifact, and provenance bytes. It never trusts caller-supplied compiled files. Do not
replace frozen artifacts with current builds. Later SDKs supporting v3 must execute
its unchanged artifacts alongside source-build checks.

Core's package admission and upgrade gate belong to Core.
