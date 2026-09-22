# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Compute/cost observability** — a terminal-style **COMPUTE** pane plus a world-HUD
  compute tile, both fed by a pure, deterministic aggregator (`src/analytics.mjs`
  → `computeAnalytics`) rolled into the server snapshot. The pane shows fleet totals
  (estimated compute, live/total workers, spend, sessions, runs), a **per-CLI**
  breakdown, a **per-tier** split (local/cloud/frontier), a **per-run budget bar**
  (in the run's own unit — usd/tokens/agents), and a **recent-launch log** across every
  CLI. Estimated tokens are the universal cross-unit compute proxy; monetary/relative
  spend is reported per budget unit (summing dollars with token counts would be
  meaningless). Cost stays an honest estimate — no live telemetry. Verified by 13 unit
  tests (161/161 suite green), a unanimous 4-lens adversarial council (aggregation
  fidelity, snapshot safety incl. no `tokenHash`/secret leak, UI/XSS robustness, product
  fidelity — all with live smokes against a real orchestration store), and a live
  end-to-end browser proof across five workers spanning all three tiers and two budget
  units.
- **Budget + smart model-routing harness** (`src/cost.mjs` + orchestrator
  integration). A run can carry a budget (`{ unit, limit }` in **dollars**
  (estimated), **tokens** (estimated), or **agent launches** (exact)). Auto-routing
  assigns each role a model from a curated catalog by tier — **light roles →
  local/free, heavy reasoning (architect/review/council) → frontier, developers →
  cheap cloud** — under the cap, preserving the model-diversity acceptance rule. The
  cap is **hard-enforced** at launch (`issueWorker` refuses → `needs-human`,
  hash-chain ledgered), a challenged developer **escalates a tier toward the
  frontier** (non-paired only — paired rosters change only through the human-gated
  reassign), and per-worker `cost`/`usage` are recorded with a null `actual` slot for
  future reconciliation against the CLIs' own usage logs. Cost is an honest estimate
  (no live token telemetry). Set a budget + auto-route on the run form; spend shows in
  the control room. Verified by 45 tests + a 5-lens adversarial council (which caught,
  and now regression-locks, a paired-roster escalation leak) + a live browser proof.
- **Provider-adapter interface for any coding CLI** (`src/providers.mjs` →
  `ADAPTERS`). Claude and Codex are now adapters with unchanged behavior
  (regression-locked). Adding a CLI is a registry entry + an adapter — no changes
  to the launch dispatcher, server, or orchestrator.
- **Gemini CLI support** as the first new adapter: `--model` + `--prompt-interactive`,
  `--approval-mode` mapped from the read-only/workspace-write permission model, and
  scoped-broker MCP registration merged into project `.gemini/settings.json` (via
  `ensureProviderMcp`, non-destructive). Set `AGENT_WORLD_GEMINI_BIN` to override the
  binary. Session resume/fork fail closed until wired. See [ROADMAP.md](ROADMAP.md).
- **opencode support** as a second new adapter (`provider/model` model form): TUI
  launch with `--model` + `--prompt`; read-only roles enforced via a generated
  `--agent agent-world-readonly` (edit/bash denied); scoped-broker MCP merged into
  `opencode.json`. Set `AGENT_WORLD_OPENCODE_BIN` to override. Built and proven
  through the full swarm-build gauntlet incl. a live browser proof.
- **Three more coding-CLI adapters — Qwen Code, Cursor CLI, and Grok CLI** — all
  broker-capable, bringing the total to **seven** (Claude, Codex, Gemini, opencode,
  Qwen, Cursor, Grok). Each maps read-only roles to a real CLI restriction
  (`--approval-mode plan` / `--mode plan` / `--sandbox readonly`) and registers the
  scoped broker in the CLI's own config (Qwen `.qwen/settings.json`, Cursor
  `.cursor/mcp.json`, Grok via `grok mcp add` → `.grok/config.toml`). Override
  binaries with `AGENT_WORLD_QWEN_BIN` / `AGENT_WORLD_CURSOR_BIN` / `AGENT_WORLD_GROK_BIN`.
  Continue/aider/goose/crush/amp were researched and deferred with documented
  blockers — see [ROADMAP.md](ROADMAP.md).
- Added a shared `mergeMcpServersJson` helper for JSON `mcpServers`-map configs
  (Gemini-style), reused by the Qwen and Cursor adapters.
- **Verified the cross-CLI broker transport live and regression-locked it**
  (`test/broker.test.mjs`). The scoped broker (`plugin/scripts/mcp.mjs`) is one
  CLI-agnostic stdio-MCP child, so the test drives the real broker + real server to
  prove a worker on one CLI (**claude**) sends a scoped, durable message that a worker
  on a **different** CLI (**codex**) reads from its inbox — with per-run **scoping** (a
  worker in another run cannot target these peers) and **worker-token auth** (a bogus
  token is rejected). Inter-session messaging is provider-neutral at the transport
  layer; each CLI's *registration* of this child is covered separately.
- **Hardened the settings-file MCP registration** (used by Gemini and opencode):
  the shared loader is now **JSONC-tolerant** (comments + trailing commas), **fails
  loud instead of clobbering** an existing/unparseable config, rejects non-object
  `mcp`/`mcpServers`/`agent` containers, and never writes secrets to disk.
- Hardened `resolveCodexHandle` to reject session records with a non-finite timestamp;
  hardened the launcher lock so a failed startup never removes another instance's lock.

### Changed
- **Made the project provider- and employer-agnostic for open-source release.**
  Branding is now swappable via `src/brand.mjs` (`AGENT_WORLD_BRAND`,
  `AGENT_WORLD_PIPELINE_LABEL`) instead of a hardcoded codename. The orchestration
  policy id is now `sdlc-v1` and the Docker stack profile is now `app`.
- Broadened `package.json` metadata (description, keywords, repository/homepage/bugs).

### Removed
- Excluded local-only working material (`.migration/`, `notes/`) from the
  distribution via `.gitignore` and the npm `files` whitelist.

### Security
- Verified no live secrets are committed; per-launch tokens, `0o600` state files,
  and timing-safe auth comparisons are retained.
- **Closed a prompt option-injection across positional-prompt adapters (cursor,
  grok, and the pre-existing codex):** the initial prompt is now passed after a `--`
  end-of-options separator, so a prompt beginning with `-` (e.g. codex's
  `--dangerously-bypass-approvals-and-sandbox`, or cursor's `-p`/`--print`) can no
  longer be parsed as a CLI flag that bypasses the read-only/sandbox guard. Verified
  live against the installed binaries; regression-locked by tests.
- Broker credentials (`AGENT_WORLD_URL`/`AGENT_WORLD_WORKER_TOKEN`) are forwarded to
  each CLI's stdio MCP child by **reference** (`$VAR` / `${env:VAR}` / `{env:VAR}`
  per the CLI), never as literal values on disk — a stdio MCP child does not inherit
  arbitrary parent env.

## [0.6.0]

- Prior internal releases (mixed-model orchestration, paired execution, Docker
  export, achievement ledger, voxel world view). See git history once published.
