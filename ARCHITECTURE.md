# Architecture

Beetl Connect SDK turns TypeScript integration definitions into executable artifacts.
The same authoring API serves the local CLI and Beetl's execution hosts.

## Public surfaces

| Import / entry point       | Role                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `@beetlio/connect`         | Integration definitions, auth declarations, Zod, HTTP and record helpers                 |
| `@beetlio/connect/builder` | Source packaging, compilation, manifests, artifact loading, fixture inventory            |
| `@beetlio/connect/host`    | Provider requests, sync and destination execution, verification, OAuth, local file sinks |
| `dist/server-host.js`      | Process execution over NDJSON                                                            |

`package.json` defines the supported exports. Other source and compiled paths are
internal. SDK releases, manifest formats, host requirements, and protocol versions
are distinct; see the [compatibility contract](docs/compatibility.md).

## Build and execution

```text
integration.ts + package.json + lockfile
    → packIntegration → source package
    → buildIntegration → runtime archive + manifest
    → withIntegration → runSync / runDestinationBatch / verifyConnection
    → host → provider HTTP and committed batches
```

`packIntegration` checks the file allowlist and dependency lock before packaging
source. `buildIntegration` compiles a Node.js module tree, retains production
dependencies, and includes the SDK authoring runtime. It returns a relocatable
archive and a manifest derived from the definition. Dependency install scripts do
not run. Packages requiring install-time native compilation are unsupported.

The loader rejects unsupported manifest and host versions before importing code.
The artifact's entry point checks its definition against the build manifest.
A source package must be built before it can be used as a runtime artifact.

`runSync` validates inputs, records, deletions, and checkpoints. It requests one
batch from the generator, awaits `host.commit`, then advances. `stop` closes the
generator and returns `continuation_required`; that batch must carry a checkpoint.
A failed commit never advances the checkpoint. Checkpoint validation cannot change
the serialized value, including the distinction between absent and `null`.

`runDestinationBatch` accepts one host-prepared batch of upserts and optional deletion
keys. It snapshots input, validates the full batch and limits, then invokes the
destination's `run(ctx, batch)`. It owns no delivery state. A successful return acknowledges
all changes; failure may leave partial remote effects and the host can replay the batch.
The integration must implement safe repeated upserts and deletions.

Destination manifests describe the accepted record input schema for host field mapping.
Configuration stays in `inputs`; runtime contexts expose it as `config.destination`.
Manifest and host contract v4 add destinations; v3 artifacts retain pull support.

## Ownership

- **Integration:** provider endpoints, response schemas, pagination, record mapping,
  sync mode, checkpoint meaning, and remote upsert/deletion behavior. Credentials stay
  outside execution contexts, though package code shares the provider's process.
- **SDK provider:** origin restrictions, credential injection, token exchange, OAuth
  refresh, retries, and response limits. Verification uses this same request path.
- **Host:** committing records and checkpoints, destination state, execution deadlines,
  and isolation. Beetl also owns package admission and its SDK upgrade gate.
  For outbound delivery it owns change detection, mapping, removal policy, immutable
  pending batches, ordering, and durable acknowledgments. Beetl Core will supply CDC
  batches; the SDK has no Delta or Core dependency.

OAuth refresh follows claim → exchange → persist → adopt. The host's persistence
hook must finish before the provider uses new tokens. Concurrent requests share a
refresh; canceling one waiter does not cancel the shared exchange. Hosts settle
pending authentication before releasing resources.

The CLI composes the pull provider and executor with `withFileSink`. The process adapter
uses the same executor and exchanges acknowledgments with an external controller.
Its [protocol reference](docs/host-protocol.md) defines the wire format and limits.
Destination execution is initially available only through the embedded host API.

Integration code and dependencies execute as ordinary Node.js code. Host API checks
are not a sandbox: hosted builds and runs need isolation. The external controller
keeps platform/storage credentials and validates process output independently. Destination
executions receive only the selected connection's provider access and prepared input batches.

## Source map

| Files under `src/`                   | Responsibility                                           |
| ------------------------------------ | -------------------------------------------------------- |
| `index.ts`, `auth.ts`                | Authoring API and auth definitions                       |
| `manifest.ts`, `forms.ts`            | Definition validation, manifests, portable form metadata |
| `host.ts`, `execution-schema.ts`     | Execution and canonical batch/result schemas             |
| `provider.ts`, `oauth.ts`, `http.ts` | Provider transport, OAuth operations, HTTP rules         |
| `records.ts`, `json.ts`              | Record projection, batching, JSON snapshots              |
| `artifact.ts`                        | Source packages and executable artifacts                 |
| `file-sink.ts`                       | Local locks, output, and checkpoint persistence          |
| `cli/`, `server-host.ts`             | Local commands and process adapter                       |
| `compatibility/`                     | SDK fixture runner and mocked provider HTTP              |

The root `compatibility/` directory contains reusable fixture sources, scenarios,
and frozen artifacts. Consumers run the same inventory through their own host path;
passing the SDK runner alone does not establish compatibility with Beetl's RPC host.
