# Contributing to Agent World

Thanks for your interest in improving Agent World. This project is a
provider-agnostic control room for coding-agent CLI sessions; contributions that
keep it neutral (no single vendor or employer baked into the core) are especially
welcome.

## Ground rules

- **Stay agnostic.** Core code must not hardcode a specific product, employer, or
  vendor. Provider-specific behavior belongs behind the provider registry
  (`src/providers.mjs`); branding belongs in `src/brand.mjs` (env-driven).
- **No secrets, no PII.** Never commit credentials, tokens, real absolute home
  paths, or session transcripts. `.gitignore` already excludes `.env*`, `.state/`,
  `.migration/`, and `notes/`. Double-check `git diff` before every push.
- **Loopback-only, fail-closed.** The server binds `127.0.0.1` and authenticates
  every request. Preserve those invariants; security-relevant changes get extra
  review.

## Development

```sh
npm install
npm run demo -- --open   # fictional data, no CLI launched, temp state
npm test                 # node --test test/*.test.mjs
```

Requires Node 22+. The embedded terminal uses `node-pty` (native build).

## Pull requests

1. Fork and branch from the default branch.
2. Add or update tests under `test/` for any behavior change. Keep `npm test` green.
3. Keep changes focused; describe the motivation and any security implications.
4. By contributing you agree your work is licensed under the project's MIT license.

## Reporting bugs & ideas

Open an issue using the provided templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of filing a public issue.
