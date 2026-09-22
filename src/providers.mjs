import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Declarative registry surfaced to the UI (label + selectable models/efforts).
// This object is JSON-serialized to the browser, so it holds DATA only; per-CLI
// launch/resume BEHAVIOR lives in ADAPTERS below. Adding a coding CLI = one entry
// here + one adapter, with no changes to the orchestrator or server control flow.
export const PROVIDERS = Object.freeze({
  claude: { label: 'Claude Code', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { label: 'Codex', models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  // Gemini CLI (google-gemini/gemini-cli). Model names are editable in the UI;
  // availability depends on the user's account and installed CLI version.
  gemini: { label: 'Gemini CLI', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], efforts: ['low', 'medium', 'high'] },
  // opencode (opencode.ai). Models use opencode's `provider/model` form.
  opencode: { label: 'opencode', models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol', 'google/gemini-2.5-pro'], efforts: ['low', 'medium', 'high'] },
  // Qwen Code (QwenLM/qwen-code), a Gemini-CLI fork.
  qwen: { label: 'Qwen Code', models: ['qwen3-coder-plus', 'qwen3-coder-flash'], efforts: ['low', 'medium', 'high'] },
  // Cursor agent CLI (cursor-agent). Model ids depend on the signed-in account.
  cursor: { label: 'Cursor CLI', models: ['sonnet-4', 'sonnet-4-thinking', 'gpt-5'], efforts: ['low', 'medium', 'high'] },
  // xAI Grok CLI.
  grok: { label: 'Grok CLI', models: ['grok-4.6', 'grok-4.5'], efforts: ['low', 'medium', 'high'] }
});
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const readonlyRoles = new Set(['requirements', 'architect', 'tester', 'reviewer', 'council', 'orchestrator']);

export function validateWorker(input) {
  const provider = input.provider;
  if (!PROVIDERS[provider]) throw Error(`Unknown provider '${provider}'. Registered: ${Object.keys(PROVIDERS).join(', ')}.`);
  const model = String(input.model || '').trim(), effort = String(input.effort || 'high');
  if (!safeName.test(model)) throw Error('Choose a valid model identifier.');
  if (!PROVIDERS[provider].efforts.includes(effort)) throw Error('Unsupported effort for this provider.');
  const role = String(input.role || 'developer');
  if (!['orchestrator', 'requirements', 'architect', 'developer', 'tester', 'reviewer', 'council'].includes(role)) throw Error('Unknown worker role.');
  return { provider, model, effort, role, permission: readonlyRoles.has(role) ? 'read-only' : 'workspace-write' };
}

function firstJSONLine(file) {
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(65536), size = readSync(fd, bytes, 0, bytes.length, 0);
    return JSON.parse(bytes.subarray(0, size).toString('utf8').split('\n', 1)[0]);
  } finally { closeSync(fd); }
}

// Codex's launch ID is synthetic, so recovery reads only root session metadata in
// its lifetime window and fails closed unless there is exactly one canonical-cwd match.
function resolveCodexHandle({ worker, assignment, endedAt, codexDir }) {
  if (!assignment.workspace || !worker.createdAt) return null;
  const start = Date.parse(worker.createdAt) - 60000, end = Date.parse(endedAt) + 60000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const expected = realpathSync(assignment.workspace), roots = new Set(), cursor = new Date(start - 86400000), last = end + 86400000;
  while (cursor.getTime() <= last) {
    roots.add(join(codexDir, 'sessions', String(cursor.getUTCFullYear()), String(cursor.getUTCMonth() + 1).padStart(2, '0'), String(cursor.getUTCDate()).padStart(2, '0')));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const matches = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const record = firstJSONLine(join(root, entry.name)), meta = record?.payload;
        const at = Date.parse(record?.timestamp || meta?.timestamp);
        if (record?.type !== 'session_meta' || meta?.parent_thread_id || meta?.originator !== 'codex-tui' || !UUID.test(meta?.session_id || '') || !Number.isFinite(at) || at < start || at > end || realpathSync(meta.cwd) !== expected) continue;
        matches.push(meta.session_id);
      } catch {}
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Strips JSONC constructs (// and /* */ comments, trailing commas) from `text` in
// a single left-to-right, string-aware pass, returning text that should parse as
// strict JSON. A string literal starts/ends on an unescaped '"' (backslash escapes
// are honored), and once inside one every byte is copied through verbatim -- so
// "//", "/*", and "," inside a string value (e.g. "https://example.com" or
// "a/*b*/c") are never touched. Outside strings, line and block comments are
// dropped, and a trailing comma (one followed only by whitespace/comments and then
// a '}' or ']') is dropped too; any other comma is kept.
function stripJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let pending = null; // buffered ',' (+ whitespace seen since) held back in case it
                       // turns out to precede a closing '}'/']' (a trailing comma)
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      if (pending !== null) { out += pending; pending = null; }
      inString = true;
      out += ch;
      i++;
      continue;
    }

    // A comment is a token SEPARATOR (whitespace in JSONC), so replace it with a
    // single space rather than deleting it — otherwise two adjacent value tokens
    // with no other separator (e.g. `1/**/2`) would silently merge into `12`. The
    // space accumulates into a buffered trailing comma exactly as real whitespace does.
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      if (pending !== null) pending += ' '; else out += ' ';
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip past the closing '*/'
      if (pending !== null) pending += ' '; else out += ' ';
      continue;
    }

    if (ch === ',') {
      if (pending !== null) out += pending; // an earlier comma turned out not to be trailing
      pending = ch;
      i++;
      continue;
    }

    if (pending !== null) {
      if (ch === '}' || ch === ']') { pending = null; out += ch; i++; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { pending += ch; i++; continue; }
      out += pending; // not trailing after all (comma precedes another value)
      pending = null;
    }

    out += ch;
    i++;
  }
  if (pending !== null) out += pending;
  return out;
}

// Shared loader for settings-file adapters (gemini, opencode). Distinguishes
// "file absent" (safe to create from {}) from "file present but unparseable"
// (must NOT be overwritten -- throws loud instead of silently clobbering it).
// Tries strict JSON first; if that fails, falls back to JSONC (comments and
// trailing commas are stripped, then re-parsed) since opencode natively supports
// JSONC in its config files. A file that fails both is genuinely broken and still
// throws loud. Note: merging into a JSONC file normalizes it to strict JSON on
// write -- comments are not preserved, but all config VALUES are.
// `note` is an optional adapter-specific hint appended to the parse-error message.
function readJsonSettings(file, note) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripJsonc(raw));
    } catch {
      throw Error(`${file} is not valid JSON or JSONC${note ? ` (${note})` : ''}; fix the file or add the agent_world MCP server manually.`);
    }
  }
  if (!isPlainObject(parsed)) throw Error(`${file} does not contain a JSON object at the root; refusing to overwrite it.`);
  return parsed;
}

// Merge a stdio `agent_world` server into a JSON/JSONC config file that keys its
// MCP servers under an `mcpServers` object (Qwen's .qwen/settings.json, Cursor's
// .cursor/mcp.json — same shape Gemini uses). Fail-loud + non-destructive via
// readJsonSettings; no token/secret is written (the local server inherits the
// process env the terminal injects).
function mergeMcpServersJson({ cwd, dir, file, entry, note }) {
  const targetDir = dir ? join(cwd, dir) : cwd;
  const target = join(targetDir, file);
  const settings = readJsonSettings(target, note);
  if (settings.mcpServers !== undefined && !isPlainObject(settings.mcpServers)) {
    throw Error(`${target}: "mcpServers" is not a JSON object; refusing to overwrite it. Add the agent_world MCP server manually.`);
  }
  settings.mcpServers = settings.mcpServers || {};
  settings.mcpServers.agent_world = entry;
  if (dir) mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
}

// One adapter per coding CLI. Each declares how it launches (argv), how a durable
// session id is recovered, whether it can attach to a live terminal, and how the
// scoped MCP broker is wired into it. The broker itself (plugin/scripts/mcp.mjs) is
// vanilla MCP-over-stdio, so any CLI that can register an MCP server can message peers.
export const ADAPTERS = Object.freeze({
  claude: {
    supportsAttach: true,
    // Claude Code loads the broker + hooks from a plugin directory.
    mcp: 'plugin-dir',
    launch({ mode, model, effort, readonly, node, cwd, prompt, name, pluginDir, binaries }) {
      const sid = mode === 'new' || mode === 'fork' ? randomUUID() : node?.id;
      if (!UUID.test(sid || '')) throw Error('A valid Claude session ID is required.');
      if (mode === 'attach') {
        if (!node?.live || !node.pane || !/^[a-zA-Z0-9_%:.@\-]+$/.test(node.pane)) throw Error('This session has no attachable tmux terminal.');
        return { file: 'tmux', args: ['attach-session', '-t', node.pane], sid };
      }
      if (!['new', 'resume', 'fork'].includes(mode)) throw Error('Unknown launch mode.');
      if (mode === 'resume' && node?.live) throw Error('This session is already running. Attach to its tmux terminal, or explicitly fork it.');
      if (mode !== 'new' && !UUID.test(node?.id || '')) throw Error('Session not found.');
      const args = mode === 'new' ? ['--session-id', sid] : ['--resume', node.id];
      if (mode === 'fork') args.push('--fork-session', '--session-id', sid);
      args.push('--model', model, '--effort', effort, '--plugin-dir', pluginDir, '--name', String(name).slice(0, 80), '--permission-mode', readonly ? 'plan' : 'acceptEdits');
      if (prompt.trim()) args.push('--', prompt);
      return { file: binaries.claude || 'claude', args, sid };
    },
    resume({ worker }) { return UUID.test(worker.sessionId || '') ? worker.sessionId : null; }
  },
  codex: {
    supportsAttach: false,
    // Codex registers the broker through inline `-c mcp_servers.*` config flags.
    mcp: 'inline-config',
    launch({ mode, model, effort, readonly, node, cwd, prompt, binaries, mcpScript }) {
      if (!['new', 'resume', 'fork'].includes(mode)) throw Error('Codex supports new, resume, or fork here.');
      const sid = mode === 'new' ? `codex-${randomUUID()}` : node?.id;
      if (!sid || (mode !== 'new' && !node)) throw Error('Codex session not found.');
      const command = mode === 'new' ? [] : [mode, node.id];
      const args = [...command, '--model', model, '--sandbox', readonly ? 'read-only' : 'workspace-write', '--ask-for-approval', 'on-request', '--cd', cwd, '--no-alt-screen',
        '-c', `model_reasoning_effort=\"${effort}\"`,
        '-c', 'mcp_servers.agent_world.command="node"',
        '-c', 'mcp_servers.agent_world.env_vars=["AGENT_WORLD_URL","AGENT_WORLD_WORKER_TOKEN"]',
        '-c', `mcp_servers.agent_world.args=[${JSON.stringify(mcpScript)}]`];
      // `--` ends option parsing so a prompt beginning with '-' (e.g. Codex's own
      // --dangerously-bypass-approvals-and-sandbox) is treated as the positional
      // prompt, not an injected flag. Verified: Codex's parser rejects a bare
      // dash-leading positional and recommends `-- <value>`.
      if (prompt.trim()) args.push('--', prompt);
      return { file: binaries.codex || 'codex', args, sid };
    },
    resume({ worker, assignment, endedAt, codexDir }) { return resolveCodexHandle({ worker, assignment, endedAt, codexDir }); }
  },
  gemini: {
    supportsAttach: false,
    // Gemini CLI has no inline MCP flag; the broker is merged into a project-level
    // .gemini/settings.json before launch (see ensureProviderMcp). Working directory
    // comes from the spawned process cwd, so no --cd flag is needed. --approval-mode
    // maps our permission model: read-only -> plan, workspace-write -> auto_edit.
    mcp: 'settings-file',
    launch({ mode, model, readonly, prompt, binaries }) {
      if (mode !== 'new') throw Error('Gemini currently supports only new sessions in Agent World; resume/fork are not yet wired.');
      const sid = `gemini-${randomUUID()}`;
      const args = ['--model', model, '--approval-mode', readonly ? 'plan' : 'auto_edit'];
      if (prompt.trim()) args.push('--prompt-interactive', prompt);
      return { file: binaries.gemini || 'gemini', args, sid };
    },
    // Gemini exposes no stable resume-by-id handle to Agent World yet; fail closed.
    resume() { return null; },
    // Gemini CLI has no inline MCP flag; the broker is merged into a project-level
    // .gemini/settings.json before launch. The broker URL/token are read from the
    // process env the terminal injects, referenced here as $VARs.
    setupMcp({ cwd, mcpScript }) {
      const dir = join(cwd, '.gemini'), file = join(dir, 'settings.json');
      const settings = readJsonSettings(file);
      if (settings.mcpServers !== undefined && !isPlainObject(settings.mcpServers)) {
        throw Error(`${file}: "mcpServers" is not a JSON object; refusing to overwrite it. Add the agent_world MCP server manually.`);
      }
      settings.mcpServers = settings.mcpServers || {};
      settings.mcpServers.agent_world = {
        command: 'node',
        args: [mcpScript],
        env: { AGENT_WORLD_URL: '$AGENT_WORLD_URL', AGENT_WORLD_WORKER_TOKEN: '$AGENT_WORLD_WORKER_TOKEN' },
        trust: false,
        description: 'Agent World scoped broker'
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    }
  },
  opencode: {
    supportsAttach: false,
    // opencode has no inline MCP flag; the broker is merged into a project-level
    // opencode.json before launch (see setupMcp below).
    mcp: 'settings-file',
    launch({ mode, model, readonly, prompt, binaries }) {
      if (mode !== 'new') throw Error('opencode currently supports only new sessions in Agent World; resume/fork are not yet wired.');
      const sid = `opencode-${randomUUID()}`;
      // opencode has no effort flag, so none is emitted (mirrors gemini ignoring
      // effort in argv). Working dir is inherited from the spawned process cwd.
      // opencode has no --read-only/--mode plan flag; read-only roles instead
      // launch under the restricted 'agent-world-readonly' agent (defined in
      // setupMcp below), which denies edit/bash/external_directory for that
      // session only, without affecting other sessions in the same cwd.
      const args = ['--model', model];
      if (readonly) args.push('--agent', 'agent-world-readonly');
      if (prompt.trim()) args.push('--prompt', prompt);
      return { file: binaries.opencode || 'opencode', args, sid };
    },
    // opencode's assigned session id can't be recovered by Agent World yet; fail closed.
    resume() { return null; },
    // Merge the broker (and the read-only agent definition) into <cwd>/opencode.json
    // WITHOUT clobbering any existing configuration. No token/secret values are
    // written to disk; the local MCP server inherits the process env
    // (AGENT_WORLD_URL / AGENT_WORLD_WORKER_TOKEN) that the terminal injects.
    setupMcp({ cwd, mcpScript }) {
      const file = join(cwd, 'opencode.json');
      const settings = readJsonSettings(file, 'opencode supports JSONC: comments and trailing commas are tolerated, but this file has other syntax errors');
      if (settings.mcp !== undefined && !isPlainObject(settings.mcp)) {
        throw Error(`${file}: "mcp" is not a JSON object; refusing to overwrite it. Add the agent_world MCP server manually.`);
      }
      settings.mcp = settings.mcp || {};
      // Forward the broker URL/token via opencode's documented {env:VAR} interpolation
      // (references, not values -- expanded at spawn from opencode's env, so no secret
      // lands on disk). A stdio MCP child does not inherit arbitrary parent env.
      settings.mcp.agent_world = { type: 'local', command: ['node', mcpScript], enabled: true, environment: { AGENT_WORLD_URL: '{env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '{env:AGENT_WORLD_WORKER_TOKEN}' } };

      if (settings.agent !== undefined && !isPlainObject(settings.agent)) {
        throw Error(`${file}: "agent" is not a JSON object; refusing to overwrite it. Add the agent-world-readonly agent manually.`);
      }
      settings.agent = settings.agent || {};
      settings.agent['agent-world-readonly'] = {
        description: 'Agent World read-only role (no edits, no shell).',
        permission: { edit: 'deny', bash: 'deny', external_directory: 'deny' }
      };

      writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    }
  },
  qwen: {
    supportsAttach: false,
    // Qwen Code is a Gemini-CLI fork: identical --model + --prompt-interactive launch,
    // and the broker merges into .qwen/settings.json (mcpServers). --approval-mode
    // maps our permission model: read-only -> plan, workspace-write -> auto-edit.
    mcp: 'settings-file',
    launch({ mode, model, readonly, prompt, binaries }) {
      if (mode !== 'new') throw Error('Qwen Code currently supports only new sessions in Agent World; resume/fork are not yet wired.');
      const sid = `qwen-${randomUUID()}`;
      // Qwen forked from Gemini-CLI but DIVERGED on this enum: its ApprovalMode is
      // `auto-edit` (HYPHEN) — verified live against qwen-code v0.24.0, whose yargs
      // `choices` are plan/default/auto-edit/auto/yolo and reject the underscore
      // form. (Gemini upstream uses `auto_edit`; do not assume parity.)
      const args = ['--model', model, '--approval-mode', readonly ? 'plan' : 'auto-edit'];
      if (prompt.trim()) args.push('--prompt-interactive', prompt);
      return { file: binaries.qwen || 'qwen', args, sid };
    },
    resume() { return null; },
    setupMcp({ cwd, mcpScript }) {
      // A stdio MCP child does NOT inherit arbitrary parent env (the MCP SDK's stdio
      // transport carries only a PATH/HOME whitelist), so the broker's URL/token are
      // forwarded as $VAR REFERENCES (Gemini/Qwen expand them at spawn) — names, not
      // secret values, so nothing sensitive lands on disk.
      mergeMcpServersJson({ cwd, dir: '.qwen', file: 'settings.json', entry: { command: 'node', args: [mcpScript], env: { AGENT_WORLD_URL: '$AGENT_WORLD_URL', AGENT_WORLD_WORKER_TOKEN: '$AGENT_WORLD_WORKER_TOKEN' } } });
    }
  },
  cursor: {
    supportsAttach: false,
    // Cursor's agent CLI is interactive by DEFAULT (omitting -p/--print); the prompt
    // is a trailing positional argv token. --workspace sets the project dir; --mode
    // plan is read-only ("no edits"). The broker merges into .cursor/mcp.json. Note:
    // Cursor gates new MCP servers behind an approval; a one-time
    // `cursor-agent mcp enable agent_world` clears it (not run here to keep setup
    // side-effect free -- see ROADMAP).
    mcp: 'settings-file',
    launch({ mode, model, readonly, cwd, prompt, binaries }) {
      if (mode !== 'new') throw Error('Cursor CLI currently supports only new sessions in Agent World; resume/fork are not yet wired.');
      const sid = `cursor-${randomUUID()}`;
      const args = ['--model', model, '--workspace', cwd];
      if (readonly) args.push('--mode', 'plan');
      // `--` ends option parsing so a prompt beginning with '-' (e.g. "-p"/"--print",
      // which would grant full write+bash and bypass --mode plan) is treated as the
      // positional prompt, not a CLI flag. Verified against cursor-agent's parser.
      if (prompt.trim()) args.push('--', prompt);
      return { file: binaries.cursor || 'cursor-agent', args, sid };
    },
    resume() { return null; },
    setupMcp({ cwd, mcpScript }) {
      // Forward the broker URL/token via Cursor's documented ${env:VAR} interpolation
      // (a reference, not a value — expanded at spawn from Cursor's own env, so no
      // secret is written to disk). A stdio MCP child does not inherit arbitrary
      // parent env, so this is required for the session to reach the broker.
      mergeMcpServersJson({ cwd, dir: '.cursor', file: 'mcp.json', entry: { command: 'node', args: [mcpScript], env: { AGENT_WORLD_URL: '${env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '${env:AGENT_WORLD_WORKER_TOKEN}' } } });
    }
  },
  grok: {
    supportsAttach: false,
    // Grok CLI takes the initial prompt as a leading positional [PROMPT] that seeds
    // the interactive TUI; -m/--model, --cwd, and --sandbox readonly are flags. Grok
    // stores MCP servers in TOML, so the broker is registered via the CLI's own
    // idempotent `grok mcp add` (project scope -> ./.grok/config.toml) rather than a
    // JSON merge (mcp: 'command').
    mcp: 'command',
    launch({ mode, model, readonly, cwd, prompt, binaries }) {
      if (mode !== 'new') throw Error('Grok CLI currently supports only new sessions in Agent World; resume/fork are not yet wired.');
      const sid = `grok-${randomUUID()}`;
      // Flags first, then `--`, then the prompt as a positional. grok's parser rejects
      // a dash-leading positional and itself recommends `-- <value>`; the separator
      // makes a prompt like "--force" inert (a value, not a flag). Verified live.
      const args = ['--model', model, '--cwd', cwd];
      if (readonly) {
        const reviewProfile = existsSync(join(cwd, '.grok', 'sandbox.toml'));
        args.push('--sandbox', reviewProfile ? 'agent-world-review' : 'read-only',
          '--no-subagents', '--disable-web-search', '--permission-mode', 'dontAsk',
          '--tools', 'read_file,list_dir,grep', '--deny', 'Bash', '--deny', 'Edit', '--deny', 'MCPTool',
          '--deny', `Read(${join(homedir(), '.grok')}/**)`, '--deny', `Grep(${join(homedir(), '.grok')}/**)`);
      }
      if (prompt.trim()) args.push('--', prompt);
      return { file: binaries.grok || 'grok', args, sid };
    },
    resume() { return null; },
    // Grok's config is TOML; let its own `grok mcp add` (idempotent add-or-update)
    // manage it. argv-only (no shell). Grok is Rust — its process spawn inherits the
    // parent env by default — so the broker's stdio child receives AGENT_WORLD_URL /
    // AGENT_WORLD_WORKER_TOKEN from grok's own (terminal-injected) env; no `-e` is
    // written (which would risk overriding the inherited value with an unexpanded
    // literal). Live broker connectivity is a follow-up verification (see ROADMAP).
    setupMcp({ cwd, mcpScript, binaries = {} }) {
      execFileSync(binaries.grok || 'grok', ['mcp', 'add', '--scope', 'project', 'agent_world', 'node', '--', mcpScript], { cwd, stdio: 'ignore', timeout: 15000 });
    }
  }
});

export function resolveProviderResumeHandle({ worker, assignment, endedAt = new Date().toISOString(), codexDir = join(homedir(), '.codex') }) {
  const adapter = ADAPTERS[worker?.provider];
  if (!adapter?.resume) return null;
  return adapter.resume({ worker, assignment, endedAt, codexDir });
}

/** Ensure the scoped MCP broker is registered for CLIs that need per-session
 * setup. Dispatches to the provider's adapter.setupMcp({ cwd, mcpScript, binaries }),
 * which registers the `agent_world` server in that CLI's own project-level config
 * WITHOUT clobbering existing configuration -- by merging a JSON/JSONC settings file
 * (Gemini, opencode, Qwen, Cursor) or by running the CLI's own idempotent add
 * command (Grok's TOML, via `grok mcp add`). No-op for adapters without a setupMcp
 * (Claude/Codex wire the broker via launch flags instead). The broker URL/token are
 * read from the process env the terminal injects, never written to disk. */
export function ensureProviderMcp({ provider, cwd, mcpScript, binaries = {} }) {
  const adapter = ADAPTERS[provider];
  if (!adapter || !adapter.setupMcp) return;
  if (!cwd || !statSync(cwd).isDirectory()) throw Error('Choose an existing project directory.');
  adapter.setupMcp({ cwd, mcpScript, binaries });
}

export function providerLaunchPlan({ provider = 'claude', model, effort = 'high', role = 'developer', node, cwd, mode = 'new', prompt = '', name = 'World builder', pluginDir, binaries = {}, mcpScript }) {
  if (!cwd || !statSync(cwd).isDirectory()) throw Error('Choose an existing project directory.');
  if (typeof prompt !== 'string' || prompt.length > 32000) throw Error('Prompt must be at most 32000 characters.');
  const worker = validateWorker({ provider, model, effort, role });
  const adapter = ADAPTERS[provider];
  if (!adapter) throw Error(`No launch adapter registered for provider '${provider}'.`);
  const readonly = worker.permission === 'read-only';
  const built = adapter.launch({ mode, model, effort, readonly, node, cwd, prompt, name, pluginDir, binaries, mcpScript });
  return { ...built, cwd, name, mode, ...worker };
}
