# Contributing

Thanks for improving `@beetlio/connect`. The project is experimental, so prefer
small changes that prove a concrete integration or host requirement.

## Setup

Use Node.js 24.2 or newer:

```fish
npm install
npm run build
```

## Make a change

1. Add or update the smallest relevant test.
2. Keep provider-specific behavior in an example unless the host must enforce
   it for every integration.
3. Validate external data with Zod and keep credentials outside sync contexts.
4. Update the README when CLI behavior or public APIs change.

The CLI and hosted integration runtime use strict TypeScript, ES modules, and
Node.js 24.2. Avoid new dependencies when the standard library or existing
packages cover the change.

## Verify

Build the package, type-check all examples, and run the complete suite:

```fish
npm run check
npm test
```

Tests must not contact real providers or contain real credentials. Use local
fixture servers and temporary directories.

The static documentation site lives in `docs/` and is published to GitHub Pages
from `main`. Keep it dependency-free and update it when public APIs change.

## Pull requests

Keep pull requests focused. Include:

- The problem and intended behavior
- Any public API or storage-format impact
- The verification commands you ran
- Follow-up work intentionally left out

By submitting a contribution, you agree that it is licensed under the Apache
License 2.0 as described in [LICENSE](LICENSE).
