# Process protocol v1

`node node_modules/@beetlio/connect/dist/server-host.js` runs a built integration
and exchanges NDJSON with a controller. Embedded hosts use `@beetlio/connect/host`;
see [architecture](../ARCHITECTURE.md) for shared execution and ownership.

The process and its dependencies are untrusted. It receives provider credentials,
never destination credentials or destination contents. The controller isolates it,
validates output, and owns publication, retries, and idempotency.

## Request

The first stdin line is a request. Keep stdin open for acknowledgments. Stdout is
reserved for protocol envelopes; integration logs go to stderr.

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

`runtimePath` points to a `buildIntegration` artifact, not source. This host supports
manifest v3 and host contract v3. Initial requests may omit `protocolVersion` or
specify `1`; adding it to requests sent to older strict-schema hosts requires a
coordinated update. Unsupported versions fail before execution. See [compatibility](compatibility.md).

Checkpoints may be any JSON value, including null, or absent. A new replace generation
starts without one. Continuation supplies the last committed checkpoint for the same
unpublished generation. Hosted syncs do not use local `outputPath` or `statePath`.

## Commit a batch

The process writes one envelope, then waits for an acknowledgment:

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

Only merge batches may include `deletedKeys`; each deletion contains exactly the
primary-key fields. The checkpoint belongs to this batch. Limits are 10,000 changes
and 8 MiB per batch. The controller independently bounds and validates each envelope.

Acknowledge only after records, deletions, and checkpoint have been durably committed:

```json
{
  "protocolVersion": 1,
  "kind": "batch_committed",
  "batchId": "batch-uuid",
  "action": "continue"
}
```

`action` is `continue` or `yield`. Use `yield` only on a checkpoint-bearing batch.
It maps to embedded action `stop`: the generator closes, runs `finally`, and produces
no more batches. The controller enforces its decision even if faulty code ignores it.

For publication retries, reuse the exact serialized envelope and `batchId`.
The destination treats `(execution, batchId)` idempotently.

## Complete a segment

After execution, the process writes `resultPath`:

```json
{
  "outcome": "completed",
  "batches": 4,
  "records": 1000,
  "deleted": 2,
  "checkpoint": { "cursor": "next" }
}
```

`outcome` is `completed` or `continuation_required`. A completed replace segment
allows atomic publication of the generation. A continuation leaves it unpublished
and schedules the next segment of the same execution. Append and merge retain their
committed checkpoints for later refreshes.

Validate the result against observed batches and acknowledgments before finalizing.
The controller also owns cancellation and hard deadlines: terminate the process,
then use SIGKILL after a grace period if needed. The runtime does not suppress SIGTERM.
A cooperative `ctx.signal` alone cannot stop blocking or uncooperative integration code.

## Manifest and local output

`syncs[].records` is JSON Schema generated from the Zod output schema: a closed,
non-null root object, with nested objects and arrays allowed. Only merge declares
`primaryKey`; its fields must be top-level, required, scalar, and non-null. Root-level
`overwrite()` is forbidden for merge; field normalization applies to records and
deletion keys alike. Checkpoint schemas cannot rewrite serialized values.

Each consumer owns its supported storage schema subset and rejects manifests it
cannot map safely. The runtime does not perform destination materialization.

The local CLI uses the same executor with a file sink. Append/replace produce record
NDJSON; replace stages output until success. Merge writes batch envelopes with records
and deletions. The file sink does not implement a destination database or merge engine.
