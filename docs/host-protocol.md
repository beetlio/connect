# Process protocol v3

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
  "protocolVersion": 3,
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
manifest/host contract v5. Destination execution is embedded only. All requests and
acknowledgments require `protocolVersion: 3`; older versions fail before execution.

The request carries no storage mode. Supply `checkpoint` only to resume a sync that
declares a checkpoint schema; omit it to start from the beginning, for example when
replacing data. Checkpoints can be any JSON value, including null. Hosted syncs do not
use local output or state paths.

## Commit a batch

The process writes one envelope, then waits for an acknowledgment:

```json
{
  "protocolVersion": 3,
  "kind": "batch",
  "batchId": "batch-uuid",
  "sequence": 0,
  "records": [{ "id": "updated", "name": "Updated" }],
  "checkpoint": { "cursor": "next" }
}
```

Batches contain records and, for syncs with a checkpoint schema, an optional checkpoint. Limits are 10,000 records
and 8 MiB per batch. The controller independently bounds and validates each envelope.
Acknowledge only after records and any checkpoint have been durably committed.

```json
{
  "protocolVersion": 3,
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
  "checkpoint": { "cursor": "next" }
}
```

`outcome` is `completed` or `continuation_required`. Continuation requires a checkpoint
on the acknowledged batch; a stop without a checkpoint fails the run.

Append or replace is controller policy; the process behaves the same for both. When
replacing, the controller stages records across the run and any continuations and
publishes them, with the final checkpoint, only after the last segment completes.
Saved progress must match published data, so failure must not change it. The SDK file
sink implements this rule for local execution.

Validate the result against observed batches and acknowledgments before finalizing.
The controller also owns cancellation and hard deadlines: terminate the process,
then use SIGKILL after a grace period if needed. The runtime does not suppress SIGTERM.
A cooperative `ctx.signal` alone cannot stop blocking or uncooperative integration code.

## Manifest and local output

`syncs[].records` is JSON Schema generated from the Zod output schema: a closed,
non-null root object, with nested objects and arrays allowed. Syncs declare neither
storage mode nor primary keys. Checkpoint schemas cannot rewrite serialized values.

Each consumer owns its supported storage schema subset and rejects manifests it
cannot map safely. The runtime does not perform destination materialization.

The local CLI uses the same executor with a file sink. Append and replace produce record
NDJSON. Append resumes from and saves checkpoints. `--mode replace` starts from the
beginning, stages output until success, and then saves its final checkpoint or clears
saved state.
