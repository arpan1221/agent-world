# Agent World — Roadmap

Agent World is a local, provider-agnostic control room for coding-agent CLI
sessions. Today it drives Claude Code and Codex through a verified SDLC
orchestration pipeline and visualizes them as a live voxel world. This roadmap
tracks the path to a fully agnostic, budget-aware, observable multi-CLI platform.

The design below is deliberately incremental: each phase builds on seams that
already exist in the codebase rather than rewriting the core.

---

## Phase 1 — Open-source readiness ✅ (done)

Branding is swappable (`src/brand.mjs`), all employer/product coupling removed from
shippable code, local-only material excluded, standard OSS files added. See
[CHANGELOG.md](CHANGELOG.md).

---

## Phase 2 — Any coding CLI, and CLI-agnostic inter-session messaging

**Goal:** drop in Gemini CLI, Grok, opencode, aider, and others without touching
core control flow, and let sessions on *different* CLIs message each other.

> **Status: in progress.** The provider-adapter interface has landed
> (`src/providers.mjs` → `ADAPTERS`), Claude and Codex are now adapters (behavior
> unchanged, regression-locked in `test/core.test.mjs`), and **seven CLIs ship
> today**: Claude, Codex, Gemini, opencode, **Qwen Code, Cursor CLI, and Grok CLI**
> — all broker-capable. Adding a CLI is a registry entry + an adapter, with no
> changes to the launch dispatcher, server, or orchestrator. The opencode adapter
> was built through the full swarm-build gauntlet (developer → paired tester →
> CodeRabbit → 5-lens adversarial council → live browser proof); the council caught
> a read-only fail-open and a config-clobbering bug before they shipped.

### Read-only + broker registration, per CLI

Every landed adapter maps the app's read-only roles to a real CLI restriction, and
registers the scoped broker so cross-CLI sessions can message each other:

| CLI | read-only | broker registration |
|---|---|---|
| Claude | `--permission-mode plan` | `--plugin-dir` |
| Codex | `--sandbox read-only` | inline `-c mcp_servers.*` |
| Gemini | `--approval-mode plan` | `.gemini/settings.json` (JSON) |
| opencode | `--agent agent-world-readonly` (edit/bash denied) | `opencode.json` (JSONC) |
| Qwen Code | `--approval-mode plan` | `.qwen/settings.json` (JSON) |
| Cursor | `--mode plan` | `.cursor/mcp.json` (JSON)¹ |
| Grok | `--sandbox readonly` | `grok mcp add` → `.grok/config.toml` |

¹ Cursor gates new MCP servers behind an approval; a one-time
`cursor-agent mcp enable agent_world` clears it (not yet automated).

**Broker connectivity — transport proven, per-CLI mount pending.** The scoped broker
(`plugin/scripts/mcp.mjs`) is one CLI-agnostic stdio-MCP script, so the provider-neutral
part is now verified **live and end-to-end**: `test/broker.test.mjs` spawns the real
broker child exactly as a CLI mounts it and drives the real server, proving a worker on
one CLI (**claude**) sends a scoped, durable message that a worker on a **different** CLI
(**codex**) reads from its inbox — plus per-run **scoping** (a worker in another run
cannot target these peers) and **worker-token auth** (a bogus token is rejected). The
configs above are also correct per each CLI's docs (env forwarded by reference) and the
read-only + option-injection guards are verified live against the installed binaries.
What remains is the last mile behind the auth walls: a launched, **authenticated** CLI
session of each settings-file CLI actually registering this child and calling it. Since
the child and transport are identical across CLIs, that step verifies each CLI's
MCP-registration wiring, not the messaging itself.

### Researched but deferred (documented so the work isn't lost)

- **Continue CLI (`cn`)** — clean launch (`--model`, positional prompt, `--readonly`
  plan mode), but MCP config is a YAML *list* in a global `~/.continue/config.yaml`;
  needs a YAML writer / `--config` strategy before the broker is auto-wired.
- **aider** — a REPL with no argv-prompt-into-interactive path, and **no MCP host**,
  so its sessions can't join the broker mesh. Launch-only at best.
- **goose** — MCP-native but YAML config (`~/.config/goose/config.yaml`) and no cwd
  flag; needs a YAML writer.
- **crush** — the bare interactive TUI takes no `--model`/prompt argv (only the
  headless `run` subcommand does); awkward fit for a managed interactive session.
- **amp** — no `--model` selection and no argv-prompt-into-TUI; deferred.

### The adapter contract (how to add a CLI)

1. Add a data entry to `PROVIDERS` in `src/providers.mjs`: `{ label, models, efforts }`.
   This is JSON-serialized to the browser; the UI enumerates it automatically.
2. Add an adapter to `ADAPTERS` with:
   - `supportsAttach` — whether it can attach to a live terminal.
   - `mcp` — how the scoped broker is wired: `'plugin-dir'` (Claude), `'inline-config'`
     (Codex), or `'settings-file'` (Gemini — merged into `.gemini/settings.json` by
     `ensureProviderMcp`, without clobbering user config).
   - `launch(ctx)` → `{ file, args, sid }`. Pass the prompt as a discrete argv token
     (never shell-interpolated) and map `readonly` to the CLI's least-privilege mode.
   - `resume(ctx)` → durable session id or `null` (fail closed).
3. Add the binary to the default `binaries` map (`src/server.mjs`, `bin/agent-world.mjs`
   via `AGENT_WORLD_<NAME>_BIN`).

**Remaining in Phase 2:** wire Gemini/opencode session resume (both fail closed
today); add Grok / aider adapters; generalize `resolveProviderResumeHandle` fully;
generalize paired mode (`src/paired.mjs`) beyond "one Codex frontend + one Claude
backend."

### Per-CLI MCP registration mechanisms (implemented)

The scoped broker is provider-agnostic, but each CLI mounts it differently — the
adapter's `mcp` tag records how:
- **Claude** (`plugin-dir`): `--plugin-dir` loads the broker + hooks.
- **Codex** (`inline-config`): inline `-c mcp_servers.*` launch flags.
- **Gemini / opencode** (`settings-file`): the adapter's `setupMcp` merges an
  `agent_world` entry into `.gemini/settings.json` / `opencode.json`. The shared
  loader is JSONC-tolerant (opencode documents JSONC) and **fail-loud, never
  clobbering** an existing config, and writes **no token/secret to disk** (the local
  MCP server inherits the injected process env). opencode read-only roles launch
  with `--agent agent-world-readonly` (an agent `setupMcp` defines with
  `edit`/`bash` denied), matching Claude's plan mode and Codex's read-only sandbox.

**What already helps us:**
- `PROVIDERS` (`src/providers.mjs`) is a single declarative registry, and
  `validateWorker` is already generic against it.
- The broker (`plugin/scripts/mcp.mjs`) is vanilla MCP-over-stdio — **any CLI that
  can register an MCP server can already call `world_send_message` / `world_inbox`
  to reach peers.** Inter-session comms are provider-neutral at the transport layer.
- `spawnPty`, the env-injected broker URL/token, and model-diversity checks are all
  provider-neutral.

**What must be built:**
1. **A provider-adapter interface.** Replace the two hardcoded branches in
   `providerLaunchPlan` with a descriptor per CLI capturing: binary name, how to
   pass model + reasoning/effort, how to set sandbox/permission, new/resume/fork
   syntax, session-id scheme, working-dir flag, and MCP-registration mechanism.
2. **Generic MCP registration.** Abstract the divergent wiring (Claude via
   `--plugin-dir`, Codex via inline `-c`) so each adapter declares how it mounts the
   broker. CLIs without a plugin system get the inline-config path.
3. **Session resume per CLI.** `resolveProviderResumeHandle` is Claude/Codex-only;
   each adapter describes where its CLI persists session metadata.
4. **UI + binaries generalization.** Provider dropdown and `binaries` map are
   currently `{claude, codex}`; both should enumerate from the registry.
5. **Generalize paired mode.** `src/paired.mjs` hardcodes "one Codex frontend + one
   Claude backend"; make lanes/roles provider-independent.

**Definition of done:** adding a CLI is a new adapter file + registry entry, no core
edits; two sessions on different CLIs exchange scoped broker messages in a run.

---

## Phase 3 — Budget & smart model routing

> **Status: foundation shipped.** `src/cost.mjs` (model catalog + multi-unit cost
> estimator + tier router) plus orchestrator integration: `run.policy.budget`
> ({unit: usd|tokens|agents, limit, spent}), `autoRoute` (light→local, heavy→frontier,
> developer→cloud, under budget, diversity-preserving), hard enforcement at
> `issueWorker` (→ `needs-human`), challenged-developer escalation (non-paired), and
> per-worker `cost`/`usage`. UI: budget + auto-route on the run form, spend in the
> control room. Built through the swarm gauntlet; browser-proven.
>
> **Remaining:** usage **reconciliation** (replace estimates by reading each CLI's own
> usage logs — Claude/Codex session JSONL, `opencode stats`), configurable catalog UI
> (edit tiers/prices, add OpenRouter/Ollama endpoints), and per-run spend history.

**Goal:** let users run within a compute budget, choosing local models (their own
hardware), cloud/open-source gateways (e.g. OpenRouter), or frontier models — and
route heavy reasoning to the frontier while keeping cheap work local.

**What already helps us:**
- `run.policy` is the single policy record (today only `maxAttempts`) — the natural
  home for a cost/budget/routing policy.
- Each assignment already carries `provider/model/effort/permission`.
- Deterministic gates run through one measured path (`src/gates.mjs`).

**What must be built:**
1. **Cost/usage model.** Add token/duration/cost fields to worker and assignment
   records and to the achievement ledger facts (which record none today). Capture
   per-turn usage from each CLI where available.
2. **Endpoint fields on providers.** The provider descriptor needs base-URL /
   api-key / "local vs cloud" / price-per-token so a local Ollama/vLLM/llama.cpp
   host and an OpenRouter gateway are first-class targets.
3. **A routing policy.** Consulted at launch (and on rework) to *choose*
   provider+model per assignment by role/difficulty and remaining budget — e.g.
   local model for mechanical roles, frontier for architecture/council lenses.
   Today provider/model are fixed at `createRun` time.
4. **Budget enforcement.** A hard ceiling that blocks new launches when exhausted,
   surfaced as a policy gate alongside `maxAttempts`.

**Definition of done:** a run configured with a budget and a local+frontier mix
completes with heavy reasoning offloaded to frontier, cheap work kept local, and
spend tracked against the ceiling.

---

## Phase 4 — Observability: compute analytics + desktop/web shell

> **Status: analytics shipped.** A pure aggregator (`src/analytics.mjs` →
> `computeAnalytics({ runs, terminals })`) is rolled into the server snapshot and
> rendered two ways: a terminal-style **COMPUTE** pane (`public/app.js` →
> `awRenderCompute`) with fleet totals, per-CLI bars, per-tier split, per-run budget
> bars, and a recent-launch log; and a **compute tile on the world HUD**
> (`public/world.html`). Estimated tokens are the cross-unit compute proxy; spend is
> reported per budget unit. Built through the swarm gauntlet — a unanimous 4-lens
> council (aggregation fidelity, snapshot/secret-leak safety, UI/XSS robustness,
> product fidelity, all with live smokes) — and browser-proven end-to-end across five
> workers spanning all three tiers and two budget units.
>
> **Remaining:** world **overlays** (compute flowing along broker edges, cost/heat
> tiles on workshops), time-series history, and the optional **desktop shell**
> (Tauri/Electron). Analytics also inherit Phase 3's estimate caveat — they sharpen
> automatically once usage **reconciliation** lands.

**Goal:** make the whole fleet monitorable — the voxel world plus a terminal-style
analytics/observability view showing compute in flight while setting up, running,
and spawning many sessions across CLIs.

**What already helps us:**
- `world.mjs::toWorld()` is the single view-model both the voxel view and any
  dashboard read from — a compute/cost overlay slots in here.
- The hash-chained `AchievementLedger` is a ready, immutable audit spine.
- The SSE/WebSocket server already streams live events to clients.

**What must be built:**
1. ~~**Metrics in the view-model.**~~ ✅ **Done** — `computeAnalytics` aggregates
   per-run/per-worker tokens and cost into the snapshot; the HUD reads a compute tile
   from it. (Latency/time-series still to come — no per-turn telemetry yet.)
2. ~~**Analytics view.**~~ ✅ **Done** — the terminal-style **COMPUTE** pane
   (`awRenderCompute`) reuses the existing pane pattern: live compute meters,
   per-CLI/per-role/per-tier spend, per-run budget bars, and a spawn/lifecycle log.
   Time-series is the remaining piece.
3. **World overlays.** Visualize "compute flowing" along the existing broker edges;
   cost/heat tiles on builder workshops.
4. **Desktop shell (optional).** The app is web-only today (127.0.0.1 + browser
   tab). A thin Tauri/Electron shell would package the world + analytics as a
   desktop app without changing the server.

**Definition of done (analytics):** ✅ met — with five workers running across four
CLIs and two budget units, the user saw live compute, spend against budget, and
launch events in **both** the world HUD and the dedicated COMPUTE pane. World overlays
and the desktop shell remain open.

---

## Contributing

New provider adapters and observability widgets are great first contributions. See
[CONTRIBUTING.md](CONTRIBUTING.md).
