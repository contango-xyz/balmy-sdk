# AGENTS.md

Contango's fork of [`nchamo/sdk`](https://github.com/nchamo/sdk) (published upstream as `@nchamo/sdk`). TypeScript, Node 24, yarn classic (`yarn.lock` v1).

## Where changes go

- Branch from `main` of `contango-xyz/balmy-sdk` and open the PR against it. Never open PRs against the upstream repo.
- Keep one reviewable change per PR.

## Commands

```bash
yarn --frozen-lockfile   # install (also installs the husky git hooks)
yarn build               # tsc + path rewriting
yarn lint:check          # prettier; `yarn lint:fix` to fix
yarn test:unit           # jest, test/unit: offline, run this before every push
```

`yarn test:integration` (test/integration) calls live RPCs and third-party APIs and needs keys from `.env.default` (`ALCHEMY_API_KEY`, `DODO_API_KEY`, `BARTER_*`). Do not expect it to pass without them; never commit keys.

## Commits

Commit messages must follow Conventional Commits (`fix: ...`, `feat: ...`, `refactor: ...`, `test: ...`, `chore: ...`): the husky `commit-msg` hook and the Lint workflow run commitlint. The `pre-commit` hook runs prettier on staged files through lint-staged.

## CI

GitHub Actions on every PR: Build, Lint (prettier + commitlint), Tests (unit, and integration with the `ALCHEMY_API_KEY` secret).

## Do not

- Run or dispatch `.github/workflows/publish.yml` (npm release); releases are a human decision.
- Edit `.github/workflows/` unless the task is about CI.
