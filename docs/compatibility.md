# Compatibility

Beetl Connect SDK 0.3 supports **manifest v3** and **host contract v3** only.
The process protocol is **v1**. Older artifacts are rejected before import.

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

Provider requests use `request.retry`, then `connection.retry`, then SDK defaults;
an explicit `false` disables retries. Authentication settlement rejects an unresolved
renewal failure. A successful exchange, or OAuth refresh persisted and adopted by the
provider, clears that failure. Hosts must settle on success and failure before reporting
success or releasing resources, retaining execution errors if settlement also fails.

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
- The builder targets v3; it does not infer requirements from function bodies.
- Authoring conveniences that compile to existing behavior do not raise the requirement.
- Behavior an older host cannot execute needs a newer requirement, even if the manifest shape is unchanged.
- New hosts support explicitly documented contracts. Dropping one requires a breaking release.

V3 covers keyed syncs, generators, ordered commits, schema-based pagination, all
current authentication and origin definitions, retries, verification, merge deletions,
and opaque checkpoints. Hosts must use the SDK provider for these behaviors instead
of implementing their own auth-type switch.

Patch releases preserve supported APIs. Compatible additions use minor releases.
Removed exports, incompatible types, changed parameters, defaults, or execution semantics,
and dropped contracts require a breaking release: minor before 1.0, major afterward.
Affected host or wire contracts need their own version change. Never change published
bytes under an existing version. New host behavior needs a fixture and documented requirements.

Source compatibility is separate. An artifact requirement cannot protect source that
no longer compiles. Build old source against the candidate SDK and execute previously
built artifacts for supported historical contracts; neither check replaces the other.

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

Inventory `formatVersion: 2` contains `fixtures` and `rejectedArtifacts`. Resolve paths
relative to `compatibilityFixturesUrl`.

- A fixture provides `id`, `artifact`, `sha256`, `source`, `sdk`, `hostContractVersion`,
  `manifest`, and `scenarios`.
- A scenario supplies an operation (`verify`, `sync`, or `authorization`), inputs,
  ordered provider request/response steps, optional acknowledgments, and expected outcomes.
- Inputs include configuration, credentials, optional OAuth state, sync key, checkpoint,
  or redirect URI. Expected outcomes cover batches, result, errors, verification,
  authorization, and authentication event ordering.

Mock only provider HTTP. Match every expected request field and consume every step;
execute real SDK authentication and sync code. Commit the requested actions and compare
outcomes, including absent versus null checkpoints. Authorization checks use the
prepared OAuth state and verify PKCE.

Three families—bearer, token exchange, and OAuth—cover fixed, environment, and configured
origins; form/JSON exchange; relative OAuth endpoints; retries; verification; output;
continuation; refresh persistence; and checkpoint preservation. Sources in
`compatibility/sources/` share sync code. Builds materialize complete source packages
at each inventory `source` path for consumers to pass to `buildIntegration`.

## Frozen provenance

`compatibility/frozen/` contains SDK 0.2 artifacts from commit
`34ebde36692fa95650ee986d53c1aea47612df59`, their sources, and provenance hashes.
They are rejection fixtures for the 0.3 reset, not supported historical runtimes.
Each `rejectedArtifacts` entry gives a path, checksum, SDK commit, and expected error.

```sh
node compatibility/freeze.mjs --check # maintainer command, run from the SDK checkout
```

The freezer builds an isolated checkout of the pinned commit and verifies the source,
artifact, and provenance bytes. It never trusts caller-supplied compiled files. Do not
replace frozen artifacts with current builds. Once a v3 release is frozen, later SDKs
supporting v3 must execute its unchanged artifacts alongside source-build checks.

Core's package admission and upgrade gate belong to Core.
