# Working on Beetl Connect SDK

Read [ARCHITECTURE.md](ARCHITECTURE.md) for module ownership and
[CONTRIBUTING.md](CONTRIBUTING.md) for development commands.

## Build and check

- Use Node.js 24.2+ and npm. Install locked dependencies with `npm ci`.
- Run `npm run check` for formatting and TypeScript checks.
- Run `npm test` for a fresh build, SDK tests, and installed-package checks.
- Focused `test:*` scripts reuse the compiled SDK; run `npm run build` after source changes.
  Compatibility and package checks prepare their own fixtures.
- Tests use mocked provider responses and temporary directories. Never use real
  credentials in tests.
- Test public SDK behavior and regressions involving data integrity, credential safety,
  or compatibility. Reuse the compatibility inventory instead of duplicating its scenarios.
  Review documentation and examples directly; do not add tests for prose or page structure.
- For documentation changes, check links, execute changed examples, and preview
  site changes at desktop and mobile widths.

## Changes

- Prefer functions, readonly data, and small modules with a clear responsibility.
  Keep local mutation where it makes an algorithm simpler; never mutate caller input.
- Parse external values at boundaries with Zod. Use `unknown`, not `any`.
- Preserve public promise rejection and error semantics during refactors.
- Reuse existing helpers and dependencies. Avoid wrappers, factories, and configuration
  without a current caller. Group related behavior instead of creating one-file helpers.
- Keep authentication, origin rules, and retries in the SDK provider. Consumers should
  not maintain separate auth-type switches.
- Before changing a public API or execution behavior, read
  [docs/compatibility.md](docs/compatibility.md). Update the contract documentation
  and the smallest relevant source-build or runtime fixture.
- Preserve frozen artifact bytes and provenance. Never rebuild them with the current SDK.
- Do not edit generated `dist/` files or unrelated local output under `outputs/`.

## Documentation

README is the introduction and quickstart. The site in `docs/` is the user guide.
Architecture belongs in `ARCHITECTURE.md`; harness instructions belong here.
Keep prose short, examples runnable, and public names consistent with package exports.
