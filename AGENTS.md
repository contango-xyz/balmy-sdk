# AGENTS.md

Contango's fork of [`nchamo/sdk`](https://github.com/nchamo/sdk) (published upstream as `@nchamo/sdk`; this fork's `main` started from the upstream release commit `bdd3abb`, version 0.0.18). TypeScript 5.4.2, Node 24.11.1 (`.nvmrc`), yarn classic 1.22.22 through corepack (`yarn.lock` v1). Upstream ships no licence file; none is added here.

Contango consumes this repository as a pinned Git submodule and builds it from source. The package is private: it is never published to a registry, so there is no release workflow, version bump or tag. The source identity is the commit SHA, not `version`.

## Where changes go

- Branch from `main` of `contango-xyz/balmy-sdk` and open the PR against it. Never open PRs against the upstream repo.
- Keep one reviewable change per PR.

## Commands

```bash
corepack enable                                  # once: makes `yarn` the pinned 1.22.22
yarn install --frozen-lockfile --ignore-scripts  # install; writes nothing outside node_modules (no Git hooks)
yarn build                                       # clean dist, tsc, path rewriting
yarn lint:check                                  # prettier; `yarn lint:fix` to fix
yarn typecheck                                   # src and test
yarn test:unit                                   # jest, test/unit, behind the in-process network guard
scripts/consumer-smoke.sh                        # after build: a linked consumer typechecks and loads buildSDK
scripts/test-unit-isolated.sh                    # the unit suite in a container with no network (needs docker)
scripts/check-network-guard.sh                   # proves both guard layers stop outbound access (needs docker)
```

## Unit tests are offline

`test/setup/deny-network.ts` runs before every test: any outbound TCP, DNS or UDP attempt throws and fails the test, even when the caller catches the error. Use in-memory fixtures or a local server on `127.0.0.1`. Live provider and RPC tests are not part of this repository.

Only the two reviewed guard files may load `child_process`, `worker_threads`, `cluster` or `dgram`; `scripts/check-bypass-imports.js` enforces that.

## CI

One workflow, `.github/workflows/pull-request.yml`, on every PR, on push to `main` and on manual dispatch: Lint, Typecheck, Build and consumer smoke, Unit tests (both guard layers), Guard canary. It has a read-only token and uses no secrets.

## Do not

- Add publication machinery, provider credentials or live network tests.
- Edit `.github/workflows/` unless the task is about CI.
