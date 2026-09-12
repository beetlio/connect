import { auth, defineIntegration, secret, z } from "@beetlio/connect";
import { createIntegrationManifest } from "@beetlio/connect/builder";
import assert from "node:assert/strict";
import test from "node:test";

test("authoring produces a typed integration manifest", () => {
  const integration = defineIntegration({
    key: "typed",
    displayName: "Typed",
    connection: {
      origin: "https://api.example.com",
      inputs: z.strictObject({
        apiVersion: z.string().min(1).meta({
          title: "API version",
        }),
      }),
      auth: auth.bearer(),
    },
    syncs: (defineSync) => ({
      items: defineSync({
        displayName: "Items",
        records: z.object({ id: z.string() }),
        inputs: z.strictObject({
          pageSize: z.number().int().min(1).default(100),
          region: z.enum(["eu", "us"]).meta({
            "x-beetl-options": [
              { value: "eu", label: "Europe" },
              { value: "us", label: "United States" },
            ],
          }),
          advanced: z.strictObject({ archived: z.boolean() }).optional(),
        }),
        async *run(ctx) {
          const apiVersion: string = ctx.config.connection.apiVersion;
          const region: "eu" | "us" = ctx.config.sync.region;
          const archived: boolean | undefined = ctx.config.sync.advanced?.archived;

          yield { records: [{ id: `${apiVersion}-${region}` }] };
          void archived;
        },
      }),
    }),
  });
  const manifest = createIntegrationManifest(integration);

  assert.equal(manifest.integration.key, "typed");
  assert.deepEqual(manifest.connection.inputs.properties.apiVersion, {
    type: "string",
    minLength: 1,
    title: "API version",
  });
  assert.deepEqual(manifest.connection.credentials.properties.token, {
    type: "string",
    minLength: 1,
    title: "Bearer token",
    "x-beetl-widget": "password",
    writeOnly: true,
  });
  assert.equal(manifest.syncs[0]?.inputs.properties.pageSize?.default, 100);
  assert.ok(!manifest.syncs[0]?.inputs.required?.includes("advanced"));
});

test("integration validation protects credential and request boundaries", () => {
  const integration = defineIntegration({
    key: "secure",
    displayName: "Secure",
    connection: { origin: "https://example.com", auth: auth.bearer() },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        records: z.object({ id: z.string() }),
        async *run() {},
      }),
    }),
  });

  assert.throws(
    () =>
      createIntegrationManifest({
        ...integration,
        connection: { ...integration.connection, origin: "http://example.com" },
      }),
    /must use HTTPS or loopback HTTP/,
  );
  assert.throws(
    () =>
      createIntegrationManifest({
        ...integration,
        connection: {
          ...integration.connection,
          inputs: z.strictObject({ token: secret(z.string()) }),
        },
      }),
    /configuration cannot contain credentials/,
  );
  assert.throws(
    () =>
      createIntegrationManifest({
        ...integration,
        connection: {
          ...integration.connection,
          auth: {
            ...auth.bearer(),
            credentials: z.strictObject({ token: z.string() }),
          },
        },
      }),
    /credential "token" must be secret/,
  );
  assert.throws(
    () =>
      createIntegrationManifest({
        ...integration,
        connection: { ...integration.connection, origin: "https://example.com/api" },
      }),
    /cannot contain a path/,
  );
});

function manifest(inputs: z.ZodObject, authentication?: ReturnType<typeof auth.custom>) {
  return createIntegrationManifest(
    defineIntegration({
      key: "forms",
      displayName: "Forms",
      connection: {
        origin: "https://example.com",
        inputs,
        ...(authentication ? { auth: authentication } : {}),
      },
      syncs: (sync) => ({
        items: sync({ records: z.object({ id: z.string() }), async *run() {} }),
      }),
    }),
  );
}

test("portable forms reject behavior that cannot be represented faithfully", () => {
  for (const field of [
    z.string().transform(String),
    z.string().refine(() => true),
    z.string().overwrite(String),
    z.string().meta({ type: "number" }),
    secret(z.string()),
    z.string().meta({ "x-beetl-widget": "json" }),
    z.enum(["a", "b"]).meta({ "x-beetl-options": [{ value: "a", label: "A" }] }),
    z.lazy(() => z.string()).meta({ "x-beetl-widget": "json" }),
  ]) {
    assert.throws(() => manifest(z.strictObject({ field })));
  }

  assert.throws(() => manifest(z.object({ field: z.string() })), /strictObject/);
  assert.throws(() => manifest(z.strictObject({ field: z.string().min(5).default("bad") })));
  assert.throws(
    () =>
      manifest(
        z.strictObject({}),
        auth.custom({
          credentials: z.strictObject({ nested: z.strictObject({ token: secret(z.string()) }) }),
        }),
      ),
    /credentials must be strings/,
  );
  assert.throws(
    () =>
      manifest(
        z.strictObject({}),
        auth.custom({ credentials: z.strictObject({ token: secret(z.string().default("bad")) }) }),
      ),
    /cannot have defaults/,
  );
});

test("merge primary keys and normalization are validated before execution", () => {
  const integration = defineIntegration({
    key: "invalid-merge-key",
    displayName: "Invalid merge key",
    connection: { origin: "https://api.example.com" },
    syncs: (sync) => ({
      items: sync({
        displayName: "Items",
        mode: "merge",
        primaryKey: ["id"],
        records: z.object({ id: z.string().optional() }),
        async *run() {},
      }),
    }),
  });

  assert.throws(
    () => createIntegrationManifest(integration),
    /must be required, scalar, and non-null/,
  );

  const overwritten = {
    ...integration,
    syncs: {
      items: {
        ...integration.syncs.items,
        records: z
          .object({ id: z.string() })
          .overwrite((record) => ({ id: record.id.toLowerCase() })),
      },
    },
  };

  assert.throws(() => createIntegrationManifest(overwritten), /cannot use root-level overwrite/);
});

// These checks compile but never execute deliberately invalid integration definitions.
function checkAuthoringTypes() {
  defineIntegration({
    key: "types",
    displayName: "Types",
    connection: {
      origin: "https://example.com",
      inputs: z.strictObject({ workspace: z.string() }),
    },
    syncs: (sync) => ({
      // @ts-expect-error Merge requires primary keys.
      missingKeys: sync({ mode: "merge", records: z.object({ id: z.string() }), async *run() {} }),
      extraKeys: sync({
        // @ts-expect-error Append forbids primary keys.
        primaryKey: ["id"],
        records: z.object({ id: z.string() }),
        async *run() {},
      }),
      records: sync({
        records: z.object({ id: z.string() }),
        // @ts-expect-error Yielded records must satisfy the declared schema.
        async *run() {
          yield { records: [{ id: 1 }] };
        },
      }),
      checkpoint: sync({
        records: z.object({ id: z.string() }),
        // @ts-expect-error Checkpoints must be declared.
        async *run() {
          yield { records: [], checkpoint: 1 };
        },
      }),
      good: sync({
        records: z.object({ id: z.string() }),
        inputs: z.strictObject({ limit: z.number().default(10) }),
        async *run(ctx) {
          const limit: number = ctx.config.sync.limit;
          const workspace: string = ctx.config.connection.workspace;

          // @ts-expect-error Configuration is readonly.
          ctx.config.sync = {};
          // @ts-expect-error Parsed config properties are readonly.
          ctx.config.sync.limit = 2;
          yield { records: [{ id: `${workspace}-${limit}` }] };
        },
      }),
    }),
    destinations: (destination) => ({
      // @ts-expect-error Destinations require primary keys.
      missing: destination({ records: z.object({ id: z.string() }), async run() {} }),
      invalid: destination({
        records: z.object({ id: z.string() }),
        // @ts-expect-error The key must belong to the record schema.
        primaryKey: ["unknown"],
        async run() {},
      }),
      typed: destination({
        records: z.object({ id: z.string(), value: z.string().transform(Number) }),
        primaryKey: ["id"],
        supportsDelete: true,
        inputs: z.strictObject({ limit: z.number().default(10) }),
        async run(ctx, batch) {
          const workspace: string = ctx.config.connection.workspace;
          const limit: number = ctx.config.destination.limit;
          const value: number | undefined = batch.records[0]?.value;
          const id: string | undefined = batch.deletedKeys?.[0]?.id;
          // @ts-expect-error Deletions contain only the declared key fields.
          void batch.deletedKeys?.[0]?.value;
          // @ts-expect-error Input records are readonly.
          batch.records[0]!.id = "changed";
          // @ts-expect-error Destination config is readonly.
          ctx.config.destination.limit = 1;
          // @ts-expect-error Destination executions have no source checkpoint.
          void ctx.checkpoint;
          void [workspace, limit, value, id];
        },
      }),
      upserts: destination({
        records: z.object({ id: z.string() }),
        primaryKey: ["id"],
        async run(ctx, batch) {
          // @ts-expect-error Deletion keys are unavailable without supportsDelete.
          void batch.deletedKeys?.[0]?.id;
        },
      }),
    }),
  });
}

void checkAuthoringTypes;
