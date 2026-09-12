<p align="center"><img src="docs/beetl-logo.svg" alt="Beetl" width="72"></p>

# Beetl Connect SDK

A TypeScript library for authoring API integrations for the Beetl data processing
platform. Define pull syncs or destinations that receive record batches; Connect handles
authentication, retries, and validation. Pull syncs also support checkpoints and local CLI execution.

**[Documentation](https://beetlio.github.io/connect/)** · [Examples](examples) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

![Beetl Connect SDK configuring an integration and writing GitHub data to NDJSON](docs/demo.gif)

## Get started

Requires **Node.js 24.2+**. In a new directory, create `package.json`:

```json
{
  "name": "my-integration",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["integration.ts"]
}
```

Install the SDK:

```sh
npm install --save-dev @beetlio/connect
```

Create `integration.ts`:

```ts
import { defineIntegration, z } from "@beetlio/connect";

const User = z.object({ id: z.number(), login: z.string() });

export default defineIntegration({
  key: "github",
  displayName: "GitHub",
  connection: { origin: "https://api.github.com" },
  syncs: (sync) => ({
    users: sync({
      mode: "replace",
      records: User,
      async *run(ctx) {
        const user = await ctx.json("/users/octocat", User);

        yield { records: [user] };
      },
    }),
  }),
});
```

Configure the integration, then run it:

```sh
npx beetl-connect configure . users
npx beetl-connect sync . users --output users.ndjson
```

`users.ndjson` contains one validated GitHub user record. Continue with the
[user guide](https://beetlio.github.io/connect/) for authentication, pagination,
checkpoints, and packaging for Beetl.

## Destinations

Add `destinations` beside `syncs` to accept mapped records and optional deletion keys.
The embedding host selects batches and owns delivery progress; integrations write them
through the same provider client. See the [destination guide](https://beetlio.github.io/connect/#destinations).
CLI and process destination commands are not included yet.

Run the [mocked destination example](examples/destination/run.ts) from this checkout:

```sh
npm ci
npm run build
node examples/destination/run.ts
```

## Development

```sh
npm ci
npm run check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands and
[AGENTS.md](AGENTS.md) for coding harness instructions.

[Apache-2.0](LICENSE) · [Security policy](SECURITY.md)
