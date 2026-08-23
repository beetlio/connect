# Connect runtime protocol v1

The Connect runtime process executes a built integration artifact and exchanges bounded batches
and acknowledgments with an external controller over NDJSON. All of it, including the integration
package and its dependencies, is untrusted by the controller.

The process receives provider credentials required by the integration. It never receives
destination publication credentials, destination identity, storage paths, or destination contents.

## Runtime request

The runtime reads the request as the first NDJSON line on standard input. Hosted syncs use the
immutable artifact produced by `buildIntegration()`, not uploaded source and not
`outputPath`/`statePath`. Standard input remains open for batch acknowledgments. Standard output
is reserved for protocol messages; integration logs go to standard error.

```json
{
  "operation": "sync",
  "runtimePath": "/runtime/integration.tgz",
  "resultPath": "/run/result.json",
  "syncKey": "contacts",
  "connectionConfig": {},
  "syncConfig": {},
  "credentials": {},
  "authorizationState": null,
  "checkpoint": { "cursor": "opaque" }
}
```

`checkpoint` may be any JSON value, including `null`, or may be omitted. For a new Replace refresh,
the controller omits it. For a continuation segment, the controller supplies the checkpoint
committed for the unpublished generation.

## Batch exchange

For each awaited `ctx.emit()`, the runtime writes one NDJSON envelope to standard output and waits
for an acknowledgment on standard input:

```json
{
  "protocolVersion": 1,
  "kind": "batch",
  "batchId": "batch-uuid",
  "sequence": 0,
  "records": [{ "id": "updated", "name": "Updated" }],
  "deletedKeys": [{ "id": "deleted" }],
  "checkpoint": { "cursor": "next" }
}
```

`deletedKeys` is present only for Merge and contains exactly the declared primary-key fields.
There is no per-record operation or tombstone record. `checkpoint` is associated with this batch
and remains opaque JSON. Connect rejects batches above 10,000 changes or 8 MiB. Because the
runtime process is untrusted, the controller independently validates and bounds every envelope.

The controller sends an acknowledgment only after the downstream system has durably committed the
records, explicit deletions, and associated checkpoint:

```json
{
  "protocolVersion": 1,
  "kind": "batch_committed",
  "batchId": "batch-uuid",
  "action": "continue"
}
```

`action` is `continue` or `yield`. The controller may return `yield` only for a
checkpoint-bearing batch.
Connect ends the segment through a private continuation signal; integration-facing `ctx.emit()`
remains `Promise<void>`.

The external controller owns destination publication credentials, publication retries, and
idempotency. It retries the exact serialized envelope with the same `batchId`, and the downstream
system treats `(execution, batchId)` idempotently. A patched or faulty integration process cannot
bypass a `yield`: the controller already knows the committed action and may terminate the process
itself.

## Segment completion

After the integration returns, the host writes the existing `resultPath`:

```json
{
  "outcome": "completed",
  "batches": 4,
  "records": 1000,
  "deleted": 2,
  "checkpoint": { "cursor": "next" }
}
```

`outcome` is `completed` or `continuation_required`. A completed Replace segment tells the
downstream system to publish the retained generation atomically. A continuation keeps that
generation unpublished and schedules the next segment in the same logical execution. Append and
Merge retain their committed checkpoint for later refreshes.

The result is untrusted process output. The controller validates it against the batches and
acknowledgments it observed before finalizing the segment.

The controller also owns the hard execution deadline and cancellation. It terminates the runtime
process when either applies, using `SIGKILL` after a grace period if needed. The runtime installs no
signal handler that can suppress normal `SIGTERM` termination. This is the only reliable deadline
for integration code that ignores `ctx.signal` or blocks indefinitely.

## Manifest v2

The build manifest is the canonical ConnectionType contract. Sync modes are `append`, `replace`,
and `merge`; only Merge declares a non-empty `primaryKey`.

`syncs[].records` is generated from the integration's Zod output schema. Its root is a closed,
non-null object, and nested objects and arrays are allowed. Connect checks that Merge key fields
are top-level, required, scalar, and non-null. Merge schemas cannot use root-level Zod
`overwrite()` because deletion keys contain only key fields; field-level normalization is applied
consistently to records and deletions.

Connect uses Zod for runtime validation. Each consumer owns its supported JSON Schema subset and
rejects a manifest whose generated schema cannot map safely to its storage types. Checkpoint
schemas validate but cannot rewrite the serialized JSON value.

## Ownership

| Concern                                  | Integration package            | Connect runtime process        | External controller and consumer        |
| ---------------------------------------- | ------------------------------ | ------------------------------ | --------------------------------------- |
| Provider requests and pagination intent  | Defines                        | Authenticates, retries, bounds | Supplies provider credentials           |
| Record and checkpoint Zod schemas        | Defines                        | Validates runtime values       | Stores canonical manifest JSON Schema   |
| Batching                                 | Calls and awaits `ctx.emit()`  | Orders, IDs, validates, bounds | Publishes and commits idempotently      |
| Merge deletions                          | Emits `deletedKeys`            | Validates exact key shape      | Applies deletes                         |
| Continuation                             | Emits restart-safe checkpoints | Privately ends after `yield`   | Chooses yield, enforces it, reschedules |
| Runtime deadline and cancellation        | Cooperates through signal      | May exit cooperatively         | Supervises and terminates process       |
| Publication endpoint and authentication  | Never sees                     | Never sees                     | Owns and scopes                         |
| Destination identity                     | Never sees                     | Never sees                     | Resolves and owns                       |
| Schema compatibility and materialization | Never performs                 | Never performs                 | Owns                                    |
| Replace generation                       | Emits source records           | Retains no destination state   | Retains and atomically publishes        |
| Checkpoint persistence                   | Defines meaning                | Carries opaque JSON            | Persists after batch commit             |

## Local CLI

Append and Replace write ordinary record NDJSON. Replace stages one complete local run and renames
it only after success. Merge writes one NDJSON batch envelope with
`records` and optional `deletedKeys` per `ctx.emit()`. This makes local behavior observable without
implementing destination schema compatibility, merge, generation, or continuation machinery.
