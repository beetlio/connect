# Connect compatibility

Connect preserves documented API and execution semantics for supported contracts,
including authentication ordering, records, acknowledgments, and checkpoint meaning.
Security fixes and corrections to invalid behavior must be documented and covered by
regression tests. Incidental timing, private implementation details, and bugs are not contracts.

## Versions and supported surfaces

| Surface              | Version policy                  | Public boundary                                                                                          |
| -------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| TypeScript authoring | SDK release policy below        | Exports from `@beetlio/connect`, including supported schemas and authoring helpers                       |
| Build and manifest   | Manifest v2                     | `@beetlio/connect/builder`; `IntegrationManifest` and `createIntegrationManifest` from the root export   |
| Embedded execution   | Required host contract v1 or v2 | Exports from `/host`, `/local-host`, and `/oauth`                                                        |
| Process execution    | Execution protocol v1           | `node node_modules/@beetlio/connect/dist/server-host.js` and [its documented messages](host-protocol.md) |

The npm version identifies an SDK release. It is independent of
`manifestVersion`, `hostContractVersion`, and `protocolVersion`.
All exports at the named entry points are public. Other source/dist paths, private
helpers, CLI implementation, and dependency layout are internal; the documented
server-host executable is the explicit exception.

### Artifact host requirements

`hostContractVersion` means **the host contract required to execute this artifact**.
It is not the SDK version, a capability registry, or the manifest format version.

- Missing means legacy v1. The frozen baseline is SDK `0.2.0` at commit
  `34ebde36692fa95650ee986d53c1aea47612df59`.
- This SDK supports host contracts **1 and 2** and builds artifacts targeting **2**.
  The builder uses a conservative target for the entire artifact; it does not infer
  a minimum requirement by inspecting integration function bodies. Rebuilding old
  source therefore may target a newer host than its unchanged historical artifact.
- Adding authoring conveniences that compile to existing behavior does not increment
  that target. For example, storage projection and record batching use existing
  record/emit semantics and are bundled with the artifact.
- Introducing behavior an older host cannot execute requires a newer requirement,
  even when its JSON still fits manifest v2. This includes new context operations,
  authentication mechanisms/options, and required callbacks.
- New hosts continue supporting the explicitly documented older contracts. Removing
  support is a breaking release with migration guidance; it cannot be a silent upgrade.

| Requirement | SDK-owned behavior                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1          | Fixed, environment-mapped and OAuth-token-derived origins; bearer/basic/API-key/custom auth; header-based token exchange with absolute expiry; absolute OAuth endpoints and refresh hooks; retries; cursor/offset/next-URL pagination; verification; append/replace/merge batches, acknowledgments and opaque checkpoints |
| v2          | Everything in v1, plus configured URL origins; form/JSON token-exchange bodies, Basic client authentication, relative expiry and custom session headers; provider-relative OAuth endpoints; pagination `onResponseError`                                                                                                  |

Unversioned historical hosts must not be assumed to implement v2 just because they
accept manifest v2. `HOST_CONTRACT_VERSION`,
`SUPPORTED_HOST_CONTRACT_VERSIONS`, and `assertSupportedHostContractVersion`
are available from `@beetlio/connect/host`.
`withIntegration()` checks the stored manifest and host requirement before importing
the artifact. It preserves the archive's bundled authoring SDK and manifest checks.
Unsupported versions report the received and supported versions and an upgrade/rebuild action.
Only manifest v2 is supported.

### Source and release compatibility

An artifact requirement cannot protect source that fails to compile. Public
TypeScript compatibility is checked separately by building historical fixture sources
against the current SDK and executing those builds.

Compatible additions use a new SDK minor release; fixes use a patch release.
Removed exports, incompatible types, required parameters, changed defaults or documented
semantics, and dropped contracts require a breaking release and migration notes.
Before 1.0, a breaking release increments the minor version; at/after 1.0 it increments
the major version. A published version must never be reused for different bytes.
Breaking a host or wire contract also requires a new affected contract version;
changing the package number alone is insufficient.

### Direction of protocol compatibility

The new server host accepts old initial requests with no `protocolVersion`,
and explicitly versioned v1 requests. This is **new host → old request**
compatibility. Older hosts use strict request schemas and may reject the added field.
Existing consumers should continue omitting it until their host update is coordinated.
This SDK's existing callers do not automatically add it.

Batch envelopes and acknowledgments still require `protocolVersion: 1`.
Future or malformed versions are rejected with actionable errors. The SDK NDJSON
protocol is distinct from an embedding application's own RPC transport.

## Reusing the host

`LocalHost` owns provider origin resolution, authentication, token renewal and retries.
`runSync` owns pagination, record/checkpoint validation and ordered emission;
`verifyConnection` executes verification through the same provider request path.
Consumers supply credentials, validated configuration, transport, logs, and a durable
batch sink. Do not recreate provider authentication in a consumer-side auth-type switch.

```ts
import { runSync, type SyncHost } from "@beetlio/connect/host";
import { LocalHost } from "@beetlio/connect/local-host";

const provider = new LocalHost({
  origin: integration.connection.origin,
  connectionConfig,
  ...(integration.connection.auth === undefined ? {} : { auth: integration.connection.auth }),
  credentials,
  fetch: providerFetch,
});
const host: SyncHost = {
  request: (request, signal) => provider.request(request, signal),
  log: appendLog,
  emit: commitBatch,
};
try {
  await runSync(integration, syncKey, { connectionConfig, checkpoint }, host);
} finally {
  await provider.settleAuthentication();
}
```

Omit both `outputPath` and `statePath` for provider-only use. File operations then
fail before writing. Supplying both retains local file behavior.
OAuth embedders use `/oauth` with the resolved `origin` when endpoints are relative.
The CLI/server share internal preparation; it is not another public API.

OAuth refresh preserves **claim → exchange → persist → use**.
Await persistence in `onAuthorizationStateChanged`; rejection prevents adoption.
An individual request's cancellation does not cancel shared refresh work, while the
host signal does. `settleAuthentication()` waits for shared work but does not rethrow
detached failures; embedders must retain/report persistence failures, as well as awaiting
the active execution.

## Installed compatibility command

```sh
beetl-connect compatibility
# SDK checkout:
npm run test:compatibility
```

The command uses Node's test runner, prints TAP, and exits nonzero on failure.
It exercises the installed SDK against frozen and current artifacts, recompiles
historical source separately, and checks the SDK's NDJSON server host. Provider HTTP
uses strict injected responses; no provider access or credentials are needed.
Temporary runtime/build files are cleaned up. No SDK checkout is needed after installation.

**Passing this command establishes SDK compatibility; it does not certify a consumer's
execution adapter.** Core uses its own RPC execution path and must run these same
fixtures through that path, including any admission/authentication switches.
Core admission enforcement and its upgrade CI gate are separate work.

## Fixture inventory for Core and other hosts

The npm package includes a JSON inventory, frozen archives, current archives,
fixture source packages, provider scenarios and expected outcomes. Locate it through
the existing builder export:

```ts
import { readFile } from "node:fs/promises";
import { compatibilityFixturesUrl } from "@beetlio/connect/builder";

const inventory = JSON.parse(await readFile(compatibilityFixturesUrl, "utf8"));
for (const fixture of inventory.fixtures) {
  const artifact = await readFile(new URL(fixture.artifact, compatibilityFixturesUrl));
  // Check fixture.sha256, then give artifact to your actual execution host.
  // Replay each fixture.scenarios entry with a fresh execution and provider script.
}
```

Inventory format v1:

- `fixtures[]`: `id`, relative `artifact` and `source` paths, `sha256`, SDK
  provenance, exact `manifest`, effective `hostContractVersion`, and `scenarios`.
  Resolve paths relative to the inventory URL. Unknown inventory formats must be rejected.
- Each scenario has an `operation` (`verify`, `sync`, or `authorization`), an
  `input`, ordered `provider` exchanges, and `expected` outcomes. Scenarios are
  independent; start a fresh execution/authentication cache for each.
- Provider requests specify exact method/URL, required header values, and optionally
  exact `bodyJson` or required form `bodyFields`. Content-Type compares the media
  type, allowing parameters such as charset. Additional headers/form fields
  are allowed (OAuth PKCE values are generated). Responses supply status, optional
  headers and optional JSON. Consume every exchange in order; reject unexpected HTTP.
- Sync `acknowledgments` prescribe `continue` or `yield` after committing the
  corresponding batch. `expected.batches` omit generated batch IDs; validate their
  uniqueness and acknowledge the received IDs. Compare sequence, records, deletions
  and checkpoint values exactly. `expected.result` describes SDK execution semantics;
  map your RPC receipts/results to it rather than requiring the SDK transport.
- `expected.verified` or `expected.error` describes verification/execution success
  or failure. An RPC adapter may map the documented error to its own failure type.
  `expected.authorizationState` and `authenticationEvents` check persisted grants
  and refresh ordering. Persistence must precede requests using the renewed token/origin.
- For `authorization`, begin authorization with the inputs, validate the expected
  authorization endpoint and PKCE/state, then complete using callback code `code`
  and the returned state. Replay the token response and compare the resulting grant.

There are three families: fixed bearer, configured token exchange, and OAuth.
Historical fixtures cover the original host boundary; current variants cover form
and JSON exchanges and account-relative OAuth. Checkpoint/continuation cases live in
the bearer family instead of being duplicated across every provider.

## Maintaining fixtures

`compatibility/frozen/provenance.json` records the exact historical SDK commit,
lock hash, source hashes, manifests and archive hashes. These are artifacts built once
with the historical SDK, not claimed to be downloaded published integration binaries.
Normal build/test/prepack checks never regenerate them.

To reproduce the baseline deliberately, run `node compatibility/freeze.mjs` from
an SDK Git checkout containing commit `34ebde36692fa95650ee986d53c1aea47612df59`.
The script exports that exact commit into a fresh temporary directory, installs its
locked dependencies with `npm ci --ignore-scripts`, and compiles the historical SDK
there before building fixtures. It never accepts caller-supplied compiled SDK files
or copies the working tree's `dist` or `node_modules`. Temporary files are cleaned up
on success or failure. Git, npm, and access to the locked dependencies are required.

Run `node compatibility/freeze.mjs --check` to rebuild from the pinned commit and
verify the existing archive bytes and provenance without rewriting them.
Review provenance and binary changes explicitly. Ordinary feature changes must not
replace historical fixtures to make a regression pass.

Normal SDK builds generate only current artifacts and the inventory under
`dist/compatibility/`. Before shipping a behavioral addition: assign its host
requirement, retain older supported fixtures, add one focused scenario, document its
host obligations, and run the installed-package check. Authoring-only additions
need source-build coverage without inventing a new runtime requirement.
