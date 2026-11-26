# Development

## Working loop

Use Node.js 22.19 or later and the pnpm version recorded in the root `packageManager` field. Install that version directly or use Corepack when available (`corepack pnpm` selects the declared version). Dependencies and versions are declared in [package.json](../package.json) and [pnpm-lock.yaml](../pnpm-lock.yaml).

```sh
pnpm install --frozen-lockfile
pnpm run build
node dist/bin/mini-harness.js --no-open
```

Use a separate `MINI_HARNESS_HOME` for experiments that should not touch your normal configuration or conversations. See [Profiles](profiles.md) for custom compositions and config dumps.

## Verification

| Command                 | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `pnpm run format`       | Apply repository formatting                                       |
| `pnpm run format:check` | Check formatting                                                  |
| `pnpm run typecheck`    | Strict compile-only check                                         |
| `pnpm test`             | Build and execute Node tests                                      |
| `pnpm run check:deps`   | Build and check package boundaries                                |
| `pnpm run test:browser` | Build and run Playwright tests                                    |
| `pnpm run pack:check`   | Build and verify the published tarball and external SDK consumers |
| `pnpm run check`        | Formatting check, build and Node tests                            |

After building, run a focused test with `node --test dist/packages/tasks/tests/runtime.test.js` (substitute the relevant compiled test file). The Node test runner also covers [framework](../test/framework/), [plugin integration](../test/plugins/) and [system](../test/system/) suites. For browser tests, first run `pnpm exec playwright install chromium --only-shell`; the [browser suites](../test/browser/) cover desktop, tablet, and mobile workflows.

## Distribution

The root build compiles strict TypeScript, resolves imports, copies assets, prunes SDK declarations and compiles the in-repository examples. The root package exports are the installed SDK contract. Package verification installs the tarball in a clean project, builds external plugins and runs a detached server against a local mock model. Private workspace packages are not separate releases.

## CI

The [CI workflow](../.github/workflows/ci.yml) runs `format:check` in its `format` job before the Node, browser and installed-plugin jobs. A formatting failure blocks those jobs. The independent [Autofix workflow](../.github/workflows/autofix.yml) runs alongside CI on same-repository pull requests (except Dependabot). It formats the exact PR head, verifies the result, and pushes a formatting-only commit to the PR branch only when tracked files change. A clean tree produces no commit, so the subsequent PR event does not cause a push loop. Fork PRs and pushes to `main` are check-only. A concurrent push is not overwritten.

For repository administrators: require the `format` status check in the `main` branch rules to enforce this gate at merge time. Configure the Actions secret `FORMAT_AUTOFIX_TOKEN` with a fine-grained personal access token with Contents write access (and Workflows write access if formatting changes workflow files). This allows the autofix push to trigger CI automatically on the new PR head. A missing or invalid token fails writeback rather than falling back to the built-in token.
