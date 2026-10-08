# Contributing to GSClaw

Thanks for helping! Bug reports, docs fixes, new analysis tools and platform improvements are all
welcome. For anything bigger than a small fix, please open an issue first so we can agree on the
approach before you spend time on it.

Security problems: please don't open a public issue; follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node 22+ and pnpm (pinned in `package.json`; `corepack enable` installs the right
version). Other package managers are blocked on purpose.

```bash
git clone https://github.com/tuyakhov/gsclaw && cd gsclaw
corepack enable
pnpm install
pnpm build && pnpm demo     # http://127.0.0.1:3920, fake Search Console data, no Google account
```

`DEMO_AUTH=oauth pnpm demo` runs the demo in Google OAuth mode with a stand-in Google sign-in
page. To work against your real Search Console, copy `.env.example` to `.env`, fill it in, export
it in your shell and run `pnpm dev`.

| Command                         | What it does                                               |
| ------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                      | HTTP server with reload                                    |
| `pnpm dev:dashboard`            | Rebuild the dashboard bundle on change                     |
| `pnpm test` / `pnpm test:watch` | Unit and integration tests (no network, no Google account) |
| `pnpm lint` / `pnpm format`     | ESLint + Prettier check / fix                              |
| `pnpm typecheck`                | Server and dashboard TypeScript                            |
| `pnpm build`                    | Server bundle and dashboard (fails over the 100 KB budget) |
| `pnpm inspector`                | MCP Inspector, to poke at a running server by hand         |
| `./scripts/smoke-docker.sh`     | Build the Docker image and run an MCP handshake against it |

## How the code is organized

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the layout and the key decisions. The rules
that matter most when changing code:

- **`src/core` is runtime-agnostic.** It runs unchanged on Node, Vercel, Netlify and Cloudflare
  Workers, so it may only use web-standard APIs (`fetch`, `Request`, WebCrypto). ESLint rejects
  `node:*` imports there. Platform code lives in `src/adapters`.
- **Stateless.** No database, no files, nothing shared between requests that has to survive.
  Anything that must persist goes into sealed tokens (`src/core/seal.ts`).
- **Never run open.** Every route that touches Search Console requires authentication, and
  misconfiguration must fail closed. Error messages and logs never contain secrets or their values.
- **One definition per tool.** MCP and the dashboard call the same `run()`.

## Adding or changing a tool

1. Put the logic in a pure function in `src/core/analysis/` when it's more than a single API
   call, with unit tests that need no I/O.
2. Define the tool in `src/core/tools/` with `defineTool()`: a zod `input` schema with
   descriptions on every field (clients show them to the model), accurate `annotations`
   (`READ_ONLY` for reads), `run()` returning plain data, and `format()` returning compact text.
   Follow the output conventions in ARCHITECTURE.md: top N rows with an "N more" note, CTR as a
   percentage, positions to one decimal.
3. Register it in `src/core/tools/registry.ts`. Write tools set `write: true` so they only appear
   with `GSCLAW_ALLOW_WRITES=true`.
4. Add tests in `test/tools.test.ts` against the fake Search Console backend
   (`test/helpers/fake-gsc.ts`); extend its dataset if your tool needs something to find.
5. Add the tool to the table in the README.

## Tests

Tests never call Google. `test/helpers/fake-gsc.ts` answers the same REST endpoints from a
synthetic dataset, and `test/helpers/oauth.ts` fakes Google sign-in. Adapter tests in
`test/integration/` run the real Node, stdio, Vercel, Netlify and Cloudflare (workerd) entry
points. Please add a
test with every fix, ideally one that fails without it.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`,
  `docs: …`, `chore: …`, optionally with a scope (`fix(oauth): …`). Releases and the changelog
  are generated from them by release-please, so the subject line is what users will read.
- Keep pull requests focused, and make sure `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
  passes; CI runs the same on Node 22 and 24, plus a Docker smoke test.
- Never commit secrets: no `.env`, service-account keys, tokens or real Search Console data in
  code, tests, fixtures, screenshots or issues.
- Dependencies: avoid new runtime dependencies (the server has three), and keep the dashboard
  under its 100 KB budget.

## Releasing

For maintainers. release-please keeps a release pull request open with the next version and
changelog. Merging it:

1. tags the release and publishes the GitHub release;
2. pushes the Docker image to `ghcr.io/tuyakhov/gsclaw` (`X.Y.Z`, `X.Y` and `latest`);
3. **stages** the npm package. npm uses trusted publishing (no token is stored in GitHub) with
   staging only, so the new version isn't installable until a maintainer approves it with 2FA:
   on npmjs.com (package → staged versions), or with `npm stage list gsclaw` then
   `npm stage approve <stage-id>`. Approval becomes available once npm's malware scan finishes.

A staged version already uses up its version number. If a release goes wrong, reject the staged
version (`npm stage reject <stage-id>`) and release a new patch version rather than re-running the
job.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
