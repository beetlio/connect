# Contributing

Use Node.js 24.2+ and npm. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing
module boundaries or host behavior.

## Setup and checks

```sh
npm ci
npm run check
npm test
```

`check` runs formatting and TypeScript checks. `test` compiles the SDK, runs its tests
(including the process protocol), then prepares fixtures and checks the packed SDK
in a temporary consumer. That check runs the compatibility fixtures and verifies
the installed process entry point.

For a focused run, build first with `npm run build`, then use `npm run test:sdk`,
`npm run test:compatibility`, or `npm run test:package`. The latter two prepare their
own fixtures; ordinary `build` only compiles the SDK. Use `npm run typecheck` for
TypeScript alone and `npm run format` to apply formatting. `npm run clean` removes
build output. Normal npm packaging builds the SDK and fixtures through `prepack`.

## Changes

Keep changes focused on a concrete integration or host requirement. Add a regression
check for behavior changes; mock provider HTTP and keep credentials out of fixtures.
Test public behavior rather than internal helpers, documentation, or individual examples.
Follow the [compatibility policy](docs/compatibility.md) when changing public APIs or
execution semantics. Frozen artifacts establish runtime compatibility; rebuilding
old source does not.

Put user instructions in the [docs site](docs/index.html), architecture in
[ARCHITECTURE.md](ARCHITECTURE.md), and coding harness guidance in [AGENTS.md](AGENTS.md).
The site is static HTML/CSS, deployed from `docs/` by GitHub Pages. Preview it locally:

```sh
python3 -m http.server 8000 --directory docs
```

In a pull request, explain the problem, the resulting behavior, and what you tested.
Use a Conventional Commits title. Report vulnerabilities through the
[security policy](SECURITY.md).

## CI and security

CI runs the full SDK and installed-package suite on Linux with Node.js 24.2.0,
24, and 26. Formatting and type checks run once on Node.js 24. macOS and Windows
run the installed-package compatibility checks and CLI smoke commands on Node.js 24.
Superseded CI runs are canceled. All dependencies come from `npm ci`.

The Security workflow runs on pull requests, pushes to `main`, and weekly:
`npm audit --audit-level=high` checks the root lockfile, including development
dependencies; CodeQL scans TypeScript/JavaScript and GitHub Actions. Dependabot
opens weekly npm and action update PRs. Frozen compatibility fixtures keep their
original dependencies and bytes.

## Releases

Publishing a GitHub Release triggers [release.yml](.github/workflows/release.yml).
It validates the tag and lockfile versions, checks that the commit belongs to
`main`, runs checks, audits dependencies, tests the built package, and stages
that build on npm. An npm maintainer must approve it with 2FA before it becomes
public. Stable releases use `latest`; prereleases use `next`.

One-time setup for an npm package owner: open
[`@beetlio/connect` settings](https://www.npmjs.com/package/@beetlio/connect/access)
and add a GitHub Actions trusted publisher with these exact values:

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Organization or user | `beetlio`                                                   |
| Repository           | `connect`                                                   |
| Workflow filename    | `release.yml`                                               |
| Environment name     | `npm`                                                       |
| Allowed actions      | Leave `npm publish` unchecked; allow staged publishing only |

This uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
with OIDC and automatic provenance. No npm token secret is needed. The release
runner uses Node.js 24 and installs npm 11.16.0; staged publishing requires npm
11.15.0 or newer. It does not restore package caches. The package must already
exist on npm, and the approving maintainer needs publish access and 2FA enabled.

For each release:

1. Follow the [versioning policy](docs/compatibility.md#versions-and-releases).
   Run `npm version <version> --no-git-tag-version` and commit both `package.json`
   and `package-lock.json` through a PR. Run `npm run check` and `npm test`.
2. After merging and passing CI, create a GitHub Release with tag `v<version>`
   targeting that commit. Generate release notes and describe any breaking changes.
   Mark versions such as `0.4.0-rc.1` as prereleases.
3. Publish the GitHub Release and check the **Stage npm release** workflow.
   If staging fails before upload, fix the setup and rerun the failed job.
4. On npm, open **Staged Packages**, review the package version and tag, and click
   **Approve** with 2FA. Alternatively, use `npm stage list @beetlio/connect`,
   `npm stage view <stage-id>`, and `npm stage approve <stage-id>` with npm 11.15.0
   or newer. See [npm's staged publishing guide](https://docs.npmjs.com/staged-publishing/).
   A successful workflow only stages the package; approval makes it public.
   Never move a published tag or reuse an npm version.

## Documentation deployment

In repository **Settings → Pages → Build and deployment**, set **Source** to
**GitHub Actions**. The workflow needs Pages enabled once before it can deploy.
[pages.yml](.github/workflows/pages.yml) publishes `docs/` when it changes on `main`;
run **Deploy documentation** manually on `main` to redeploy without a code change.
The site is available at <https://beetlio.github.io/connect/>.

Contributions are licensed under [Apache-2.0](LICENSE).
