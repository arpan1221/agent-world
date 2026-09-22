import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, ADAPTERS, validateWorker, providerLaunchPlan, ensureProviderMcp } from '../src/providers.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'agent-world-providers-'));

test('the provider registry and adapters stay in lockstep', () => {
  // Every declared provider must have a launch adapter, so "add a CLI" is one
  // registry entry + one adapter, never a change to the launch dispatcher.
  for (const name of Object.keys(PROVIDERS)) {
    assert.ok(ADAPTERS[name], `missing adapter for provider '${name}'`);
    assert.equal(typeof ADAPTERS[name].launch, 'function');
    assert.equal(typeof ADAPTERS[name].resume, 'function');
  }
});

test('validateWorker accepts registered providers and rejects unknown ones', () => {
  assert.equal(validateWorker({ provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high', role: 'developer' }).provider, 'gemini');
  assert.throws(() => validateWorker({ provider: 'nope', model: 'x', effort: 'high', role: 'developer' }), /Unknown provider/);
  assert.throws(() => validateWorker({ provider: 'gemini', model: 'gemini-2.5-pro', effort: 'ultra', role: 'developer' }), /Unsupported effort/);
});

test('Gemini launch plan maps permission to approval-mode and never interpolates the prompt', () => {
  const cwd = temp();
  const dev = providerLaunchPlan({ provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '$(rm -rf /) build the garden' });
  assert.equal(dev.file, 'gemini');
  assert.equal(dev.args[dev.args.indexOf('--model') + 1], 'gemini-2.5-pro');
  assert.equal(dev.args[dev.args.indexOf('--approval-mode') + 1], 'auto_edit');
  // Prompt is passed as a discrete argv token (no shell), so injection text is inert.
  assert.equal(dev.args[dev.args.indexOf('--prompt-interactive') + 1], '$(rm -rf /) build the garden');
  assert.ok(dev.sid.startsWith('gemini-'));

  // A read-only role (e.g. reviewer) drops to plan mode.
  const reviewer = providerLaunchPlan({ provider: 'gemini', model: 'gemini-2.5-flash', effort: 'high', role: 'reviewer', cwd, mode: 'new' });
  assert.equal(reviewer.args[reviewer.args.indexOf('--approval-mode') + 1], 'plan');
  assert.equal(reviewer.permission, 'read-only');
});

test('Gemini fails closed on resume/fork until session recovery is wired', () => {
  const cwd = temp();
  assert.throws(() => providerLaunchPlan({ provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high', role: 'developer', cwd, mode: 'resume', node: { id: 'gemini-x', cwd } }), /only supports only new|not yet wired/);
});

test('ensureProviderMcp merges the broker into .gemini/settings.json without clobbering', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.gemini'), { recursive: true });
  writeFileSync(join(cwd, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dark', mcpServers: { other: { command: 'foo' } } }));
  ensureProviderMcp({ provider: 'gemini', cwd, mcpScript: '/plugin/mcp.mjs' });
  const merged = JSON.parse(readFileSync(join(cwd, '.gemini', 'settings.json'), 'utf8'));
  assert.equal(merged.theme, 'Dark', 'existing user settings are preserved');
  assert.equal(merged.mcpServers.other.command, 'foo', 'existing MCP servers are preserved');
  assert.equal(merged.mcpServers.agent_world.command, 'node');
  assert.deepEqual(merged.mcpServers.agent_world.args, ['/plugin/mcp.mjs']);
  assert.equal(merged.mcpServers.agent_world.trust, false, 'broker is not blindly trusted');

  // Claude/Codex wire MCP via launch flags, so the settings-file path is a no-op for them.
  const untouched = temp();
  ensureProviderMcp({ provider: 'claude', cwd: untouched, mcpScript: '/plugin/mcp.mjs' });
  assert.throws(() => readFileSync(join(untouched, '.gemini', 'settings.json'), 'utf8'));
});

// The registry/adapter lockstep test above already iterates Object.keys(PROVIDERS),
// so it exercises ADAPTERS.opencode automatically; no separate assertion needed here.

test('opencode launch plan (new) skips the effort flag and never interpolates the prompt', () => {
  const cwd = temp();
  const dev = providerLaunchPlan({ provider: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '$(rm -rf /) build' });
  assert.equal(dev.file, 'opencode');
  assert.equal(dev.args[dev.args.indexOf('--model') + 1], 'anthropic/claude-sonnet-5');
  // Prompt is passed as a discrete argv token (no shell), so injection text is inert.
  assert.equal(dev.args[dev.args.indexOf('--prompt') + 1], '$(rm -rf /) build');
  assert.ok(dev.sid.startsWith('opencode-'));
  // opencode has no effort flag; none should be emitted regardless of the requested effort.
  assert.ok(!dev.args.includes('--effort'));
});

test('opencode launch plan enforces read-only roles via --agent agent-world-readonly, write roles get no --agent', () => {
  const cwd = temp();
  const reviewer = providerLaunchPlan({ provider: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high', role: 'reviewer', cwd, mode: 'new' });
  assert.equal(reviewer.file, 'opencode');
  assert.equal(reviewer.permission, 'read-only');
  assert.equal(reviewer.args[reviewer.args.indexOf('--agent') + 1], 'agent-world-readonly');

  // A write role (developer) is not sandboxed under the read-only agent.
  const dev = providerLaunchPlan({ provider: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high', role: 'developer', cwd, mode: 'new' });
  assert.equal(dev.permission, 'workspace-write');
  assert.ok(!dev.args.includes('--agent'), 'developer (write) role must not be pinned to the read-only agent');
});

test('opencode fails closed on resume/fork until session recovery is wired', () => {
  const cwd = temp();
  assert.throws(() => providerLaunchPlan({ provider: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high', role: 'developer', cwd, mode: 'resume', node: { id: 'opencode-x', cwd } }), /not yet wired|only new/);
  assert.throws(() => providerLaunchPlan({ provider: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high', role: 'developer', cwd, mode: 'fork', node: { id: 'opencode-x', cwd } }), /not yet wired|only new/);
});

test('ensureProviderMcp merges the broker into opencode.json without clobbering and forwards env by reference only', () => {
  const cwd = temp();
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({ model: 'anthropic/x', mcp: { other: { type: 'local', command: ['foo'] } }, agent: { other: { description: 'existing' } } }));
  ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' });
  const merged = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'));
  assert.equal(merged.model, 'anthropic/x', 'existing user settings are preserved');
  assert.deepEqual(merged.mcp.other, { type: 'local', command: ['foo'] }, 'existing MCP servers are preserved');
  // A stdio MCP child does not inherit arbitrary parent env, so the broker's
  // URL/token are forwarded via opencode's documented {env:VAR} interpolation --
  // a reference expanded at spawn, never a literal secret value on disk.
  assert.deepEqual(merged.mcp.agent_world, {
    type: 'local',
    command: ['node', '/plugin/mcp.mjs'],
    enabled: true,
    environment: { AGENT_WORLD_URL: '{env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '{env:AGENT_WORLD_WORKER_TOKEN}' }
  });
  // The read-only agent definition is merged in alongside any existing agents.
  assert.deepEqual(merged.agent.other, { description: 'existing' }, 'existing agent definitions are preserved');
  assert.deepEqual(merged.agent['agent-world-readonly'].permission, { edit: 'deny', bash: 'deny', external_directory: 'deny' });
  // The environment values are references (carry the "{env:" interpolation marker),
  // never a literal URL or token.
  for (const value of Object.values(merged.mcp.agent_world.environment)) {
    assert.ok(value.startsWith('{env:'), `expected an {env:...} reference, got '${value}'`);
  }
});

test('ensureProviderMcp creates opencode.json when none exists yet, including the read-only agent', () => {
  const cwd = temp();
  ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' });
  const created = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'));
  assert.deepEqual(created.mcp.agent_world, {
    type: 'local',
    command: ['node', '/plugin/mcp.mjs'],
    enabled: true,
    environment: { AGENT_WORLD_URL: '{env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '{env:AGENT_WORLD_WORKER_TOKEN}' }
  });
  // The reviewer/tester/etc. launch plan references --agent agent-world-readonly,
  // so setupMcp must always define it (deny edit/bash/external_directory) for it to resolve.
  assert.deepEqual(created.agent['agent-world-readonly'].permission, { edit: 'deny', bash: 'deny', external_directory: 'deny' });
});

test('ensureProviderMcp fails loud and does not clobber invalid JSON in opencode.json', () => {
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  // Broken even after JSONC stripping (bare/missing value) -- comments and
  // trailing commas alone would now be tolerated, so this must stay broken on
  // its own merits to keep exercising the fail-loud/no-clobber path.
  const original = '{ "model": }';
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), original, 'invalid JSON file must be left byte-for-byte unchanged');
});

test('ensureProviderMcp rejects a non-object "mcp" value in opencode.json without clobbering', () => {
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  const original = JSON.stringify({ mcp: [1, 2, 3] });
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }), /"mcp" is not a JSON object/);
  assert.equal(readFileSync(file, 'utf8'), original, 'file must be left unchanged when "mcp" is not a JSON object (no silent drop / fail-open)');
});

test('ensureProviderMcp (gemini) fails loud and does not clobber invalid JSON in .gemini/settings.json', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.gemini'), { recursive: true });
  const file = join(cwd, '.gemini', 'settings.json');
  // Broken even after JSONC stripping (bare/missing value) -- comments and
  // trailing commas alone would now be tolerated, so this must stay broken on
  // its own merits to keep exercising the fail-loud/no-clobber path.
  const original = '{ "theme": }';
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'gemini', cwd, mcpScript: '/plugin/mcp.mjs' }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), original, 'invalid JSON file must be left byte-for-byte unchanged');
});

test('ensureProviderMcp (gemini) rejects a non-object "mcpServers" value without clobbering', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.gemini'), { recursive: true });
  const file = join(cwd, '.gemini', 'settings.json');
  const original = JSON.stringify({ mcpServers: [1, 2, 3] });
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'gemini', cwd, mcpScript: '/plugin/mcp.mjs' }), /"mcpServers" is not a JSON object/);
  assert.equal(readFileSync(file, 'utf8'), original, 'file must be left unchanged when "mcpServers" is not a JSON object (no silent drop / fail-open)');
});

test('ensureProviderMcp (opencode) tolerates real JSONC -- comments and trailing commas -- and merges cleanly', () => {
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  const seed = '{\n  // my config\n  "model": "anthropic/x",\n  "mcp": { "other": { "type": "local", "command": ["foo"] }, },\n}';
  writeFileSync(file, seed);
  assert.doesNotThrow(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }));
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.model, 'anthropic/x', 'existing model (from JSONC input) is preserved');
  assert.deepEqual(merged.mcp.other, { type: 'local', command: ['foo'] }, 'existing mcp server (from JSONC input) is preserved');
  assert.deepEqual(merged.mcp.agent_world, {
    type: 'local',
    command: ['node', '/plugin/mcp.mjs'],
    enabled: true,
    environment: { AGENT_WORLD_URL: '{env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '{env:AGENT_WORLD_WORKER_TOKEN}' }
  });
  assert.deepEqual(merged.agent['agent-world-readonly'].permission, { edit: 'deny', bash: 'deny', external_directory: 'deny' });
});

test('ensureProviderMcp (gemini) tolerates real JSONC -- comments and trailing commas -- and merges cleanly', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.gemini'), { recursive: true });
  const file = join(cwd, '.gemini', 'settings.json');
  const seed = '{\n  // my config\n  "theme": "Dark",\n  "mcpServers": { "other": { "command": "foo" }, },\n}';
  writeFileSync(file, seed);
  assert.doesNotThrow(() => ensureProviderMcp({ provider: 'gemini', cwd, mcpScript: '/plugin/mcp.mjs' }));
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.theme, 'Dark', 'existing theme (from JSONC input) is preserved');
  assert.deepEqual(merged.mcpServers.other, { command: 'foo' }, 'existing mcp server (from JSONC input) is preserved');
  assert.deepEqual(merged.mcpServers.agent_world, {
    command: 'node',
    args: ['/plugin/mcp.mjs'],
    env: { AGENT_WORLD_URL: '$AGENT_WORLD_URL', AGENT_WORLD_WORKER_TOKEN: '$AGENT_WORLD_WORKER_TOKEN' },
    trust: false,
    description: 'Agent World scoped broker'
  });
});

test('stripJsonc (via ensureProviderMcp) does not corrupt string values containing comment-like or comma-like sequences', () => {
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  // A genuine trailing comma before the final '}' forces the JSONC fallback path;
  // the string values below contain "//" and "/*...*/" sequences that must survive
  // untouched since the string-aware pass never treats in-string bytes as comments.
  const seed = '{ "model": "https://example.com//x", "note": "a/*b*/c", "mcp": {}, }';
  writeFileSync(file, seed);
  assert.doesNotThrow(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }));
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.model, 'https://example.com//x', 'a "//" inside a string value must not be treated as a line comment');
  assert.equal(merged.note, 'a/*b*/c', 'a "/*...*/" inside a string value must not be treated as a block comment');
});

test('stripJsonc (via ensureProviderMcp) does not corrupt an escaped quote followed by comment-like text', () => {
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  // Trailing comma before the final '}' forces the JSONC fallback path. The string
  // value contains an escaped quote (\") immediately followed by "// not a comment" --
  // the escape must not be misread as closing the string early, which would leave
  // the trailing "// not a comment" text outside a string and stripped as a comment.
  const seed = '{ "a": "he said \\"hi\\" // not a comment", "mcp": {}, }';
  writeFileSync(file, seed);
  assert.doesNotThrow(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }));
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.a, 'he said "hi" // not a comment');
});

test('stripJsonc treats a comment as a whitespace separator, so it never silently merges adjacent tokens', () => {
  // A block comment is a token separator in JSONC. Two adjacent numbers separated
  // ONLY by a comment (`1/**/2`) has no valid interpretation, so the merge must
  // fail LOUD (throw) rather than silently "repair" it to `12` and write that back.
  const cwd = temp();
  const file = join(cwd, 'opencode.json');
  const seed = '{ "n": [1/**/2], "mcp": {} }';
  writeFileSync(file, seed);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => ensureProviderMcp({ provider: 'opencode', cwd, mcpScript: '/plugin/mcp.mjs' }));
  assert.equal(readFileSync(file, 'utf8'), before, 'the ambiguous file is left untouched, not silently rewritten');
});

// --- qwen -------------------------------------------------------------

test('Qwen launch plan (write role) maps to --approval-mode auto-edit and never interpolates the prompt', () => {
  const cwd = temp();
  const dev = providerLaunchPlan({ provider: 'qwen', model: 'qwen3-coder-plus', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '$(rm -rf /) go' });
  assert.equal(dev.file, 'qwen');
  assert.equal(dev.args[dev.args.indexOf('--model') + 1], 'qwen3-coder-plus');
  // Qwen forked from Gemini-CLI but DIVERGED: its enum is `auto-edit` (HYPHEN);
  // the underscore form is rejected by qwen-code (verified live against v0.24.0).
  assert.equal(dev.args[dev.args.indexOf('--approval-mode') + 1], 'auto-edit');
  assert.ok(!dev.args.includes('plan'), 'a write role must not carry the read-only approval mode');
  // Prompt is passed as a discrete argv token (no shell), immediately after --prompt-interactive.
  assert.equal(dev.args[dev.args.indexOf('--prompt-interactive') + 1], '$(rm -rf /) go');
  assert.ok(dev.sid.startsWith('qwen-'));
});

test('Qwen launch plan (read-only role) maps to --approval-mode plan', () => {
  const cwd = temp();
  const reviewer = providerLaunchPlan({ provider: 'qwen', model: 'qwen3-coder-flash', effort: 'high', role: 'reviewer', cwd, mode: 'new' });
  assert.equal(reviewer.permission, 'read-only');
  assert.equal(reviewer.args[reviewer.args.indexOf('--approval-mode') + 1], 'plan');
});

test('Qwen fails closed on resume and fork until session recovery is wired', () => {
  const cwd = temp();
  assert.throws(() => providerLaunchPlan({ provider: 'qwen', model: 'qwen3-coder-plus', effort: 'high', role: 'developer', cwd, mode: 'resume', node: { id: 'qwen-x', cwd } }), /not yet wired|only new/);
  assert.throws(() => providerLaunchPlan({ provider: 'qwen', model: 'qwen3-coder-plus', effort: 'high', role: 'developer', cwd, mode: 'fork', node: { id: 'qwen-x', cwd } }), /not yet wired|only new/);
});

test('ensureProviderMcp (qwen) merges the broker into .qwen/settings.json without clobbering', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.qwen'), { recursive: true });
  writeFileSync(join(cwd, '.qwen', 'settings.json'), JSON.stringify({ theme: 'Dark', mcpServers: { other: { command: 'foo' } } }));
  ensureProviderMcp({ provider: 'qwen', cwd, mcpScript: '/plugin/mcp.mjs' });
  const merged = JSON.parse(readFileSync(join(cwd, '.qwen', 'settings.json'), 'utf8'));
  assert.equal(merged.theme, 'Dark', 'existing user settings are preserved');
  assert.deepEqual(merged.mcpServers.other, { command: 'foo' }, 'existing MCP servers are preserved');
  // A stdio MCP child does not inherit arbitrary parent env, so the broker's
  // URL/token are forwarded as $VAR references (Qwen expands them at spawn) --
  // names, not secret values, so nothing sensitive lands on disk.
  assert.deepEqual(merged.mcpServers.agent_world, {
    command: 'node',
    args: ['/plugin/mcp.mjs'],
    env: { AGENT_WORLD_URL: '$AGENT_WORLD_URL', AGENT_WORLD_WORKER_TOKEN: '$AGENT_WORLD_WORKER_TOKEN' }
  });
});

test('ensureProviderMcp (qwen) creates .qwen/settings.json when none exists yet', () => {
  const cwd = temp();
  ensureProviderMcp({ provider: 'qwen', cwd, mcpScript: '/plugin/mcp.mjs' });
  const created = JSON.parse(readFileSync(join(cwd, '.qwen', 'settings.json'), 'utf8'));
  assert.deepEqual(created.mcpServers.agent_world, {
    command: 'node',
    args: ['/plugin/mcp.mjs'],
    env: { AGENT_WORLD_URL: '$AGENT_WORLD_URL', AGENT_WORLD_WORKER_TOKEN: '$AGENT_WORLD_WORKER_TOKEN' }
  });
});

test('ensureProviderMcp (qwen) fails loud and does not clobber invalid JSON in .qwen/settings.json', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.qwen'), { recursive: true });
  const file = join(cwd, '.qwen', 'settings.json');
  const original = '{ "x": }';
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'qwen', cwd, mcpScript: '/plugin/mcp.mjs' }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), original, 'invalid JSON file must be left byte-for-byte unchanged');
});

test('ensureProviderMcp (qwen) rejects a non-object "mcpServers" value without clobbering', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.qwen'), { recursive: true });
  const file = join(cwd, '.qwen', 'settings.json');
  const original = JSON.stringify({ mcpServers: [1, 2, 3] });
  writeFileSync(file, original);
  assert.throws(() => ensureProviderMcp({ provider: 'qwen', cwd, mcpScript: '/plugin/mcp.mjs' }), /"mcpServers" is not a JSON object/);
  assert.equal(readFileSync(file, 'utf8'), original, 'file must be left unchanged when "mcpServers" is not a JSON object (no silent drop / fail-open)');
});

// --- cursor -------------------------------------------------------------

test('Cursor launch plan (write role) sets --workspace and trails the prompt as a positional, never interpolating it', () => {
  const cwd = temp();
  const dev = providerLaunchPlan({ provider: 'cursor', model: 'sonnet-4', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '$(rm -rf /) go' });
  assert.equal(dev.file, 'cursor-agent');
  assert.equal(dev.args[dev.args.indexOf('--model') + 1], 'sonnet-4');
  assert.equal(dev.args[dev.args.indexOf('--workspace') + 1], cwd);
  assert.ok(!dev.args.includes('--mode'), 'a write role must not carry --mode plan');
  // Prompt is a trailing positional argv token (interactive by default; no shell).
  assert.equal(dev.args[dev.args.length - 1], '$(rm -rf /) go');
  assert.ok(dev.sid.startsWith('cursor-'));
});

test('Cursor launch plan (read-only role) adds --mode plan', () => {
  const cwd = temp();
  const reviewer = providerLaunchPlan({ provider: 'cursor', model: 'sonnet-4', effort: 'high', role: 'reviewer', cwd, mode: 'new' });
  assert.equal(reviewer.permission, 'read-only');
  assert.equal(reviewer.args[reviewer.args.indexOf('--mode') + 1], 'plan');
});

test('Cursor fails closed on resume and fork until session recovery is wired', () => {
  const cwd = temp();
  assert.throws(() => providerLaunchPlan({ provider: 'cursor', model: 'sonnet-4', effort: 'high', role: 'developer', cwd, mode: 'resume', node: { id: 'cursor-x', cwd } }), /not yet wired|only new/);
  assert.throws(() => providerLaunchPlan({ provider: 'cursor', model: 'sonnet-4', effort: 'high', role: 'developer', cwd, mode: 'fork', node: { id: 'cursor-x', cwd } }), /not yet wired|only new/);
});

test('Cursor option-injection is neutralized: a prompt that looks like a real flag stays a positional value', () => {
  const cwd = temp();
  // '--print' is a real cursor-agent flag that would grant full write+bash and
  // bypass --mode plan if it were parsed as an option instead of the prompt value.
  const dev = providerLaunchPlan({ provider: 'cursor', model: 'sonnet-4', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '--print' });
  assert.equal(dev.args.at(-2), '--', 'the `--` end-of-options separator must immediately precede the prompt');
  assert.equal(dev.args.at(-1), '--print', 'the prompt is the last argv token');
  const beforeSeparator = dev.args.slice(0, dev.args.length - 2);
  assert.ok(!beforeSeparator.includes('--print'), 'a bare --print must not appear before the `--` separator (it would be parsed as an active flag)');
});

test('ensureProviderMcp (cursor) merges the broker into .cursor/mcp.json without clobbering', () => {
  const cwd = temp();
  mkdirSync(join(cwd, '.cursor'), { recursive: true });
  writeFileSync(join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ other: 'field', mcpServers: { other: { command: 'foo' } } }));
  ensureProviderMcp({ provider: 'cursor', cwd, mcpScript: '/plugin/mcp.mjs' });
  const merged = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(merged.other, 'field', 'existing top-level keys are preserved');
  assert.deepEqual(merged.mcpServers.other, { command: 'foo' }, 'existing MCP servers are preserved');
  // A stdio MCP child does not inherit arbitrary parent env, so the broker's
  // URL/token are forwarded via Cursor's documented ${env:VAR} interpolation --
  // a reference expanded at spawn, never a literal secret value on disk.
  assert.deepEqual(merged.mcpServers.agent_world, {
    command: 'node',
    args: ['/plugin/mcp.mjs'],
    env: { AGENT_WORLD_URL: '${env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '${env:AGENT_WORLD_WORKER_TOKEN}' }
  });
});

test('ensureProviderMcp (cursor) creates .cursor/mcp.json when none exists yet', () => {
  const cwd = temp();
  ensureProviderMcp({ provider: 'cursor', cwd, mcpScript: '/plugin/mcp.mjs' });
  const created = JSON.parse(readFileSync(join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(created.mcpServers.agent_world, {
    command: 'node',
    args: ['/plugin/mcp.mjs'],
    env: { AGENT_WORLD_URL: '${env:AGENT_WORLD_URL}', AGENT_WORLD_WORKER_TOKEN: '${env:AGENT_WORLD_WORKER_TOKEN}' }
  });
});

// --- grok -------------------------------------------------------------

test('Grok launch plan (write role) is flags-first then trails the prompt after `--`, never interpolating it', () => {
  const cwd = temp();
  const dev = providerLaunchPlan({ provider: 'grok', model: 'grok-4.6', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '$(rm -rf /) go' });
  assert.equal(dev.file, 'grok');
  assert.equal(dev.args[dev.args.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(dev.args[dev.args.indexOf('--cwd') + 1], cwd);
  assert.ok(!dev.args.includes('--sandbox'), 'a write role must not carry --sandbox readonly');
  // Flags first, then `--`, then the prompt as a trailing positional (no shell);
  // the separator makes a dash-leading prompt inert -- a value, not a parsed flag.
  assert.equal(dev.args.at(-2), '--', 'the `--` end-of-options separator must immediately precede the prompt');
  assert.equal(dev.args.at(-1), '$(rm -rf /) go', 'the prompt is the last argv token, not args[0]');
  assert.ok(dev.sid.startsWith('grok-'));
});

test('Grok launch plan (read-only role) adds the documented --sandbox read-only profile', () => {
  const cwd = temp();
  const reviewer = providerLaunchPlan({ provider: 'grok', model: 'grok-4.6', effort: 'high', role: 'reviewer', cwd, mode: 'new' });
  assert.equal(reviewer.permission, 'read-only');
  assert.equal(reviewer.args[reviewer.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(reviewer.args[reviewer.args.indexOf('--tools') + 1], 'read_file,list_dir,grep');
  assert.ok(reviewer.args.includes('--no-subagents'));
  assert.ok(reviewer.args.includes('--disable-web-search'));
  assert.ok(reviewer.args.includes('MCPTool'));
  assert.equal(reviewer.args[reviewer.args.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('Grok fails closed on resume and fork until session recovery is wired', () => {
  const cwd = temp();
  assert.throws(() => providerLaunchPlan({ provider: 'grok', model: 'grok-4.6', effort: 'high', role: 'developer', cwd, mode: 'resume', node: { id: 'grok-x', cwd } }), /not yet wired|only new/);
  assert.throws(() => providerLaunchPlan({ provider: 'grok', model: 'grok-4.6', effort: 'high', role: 'developer', cwd, mode: 'fork', node: { id: 'grok-x', cwd } }), /not yet wired|only new/);
});

test('Grok option-injection is neutralized: a prompt that looks like a real flag stays a positional value', () => {
  const cwd = temp();
  // '--force' is a plausible grok flag; grok's own parser rejects a dash-leading
  // positional and recommends `-- <value>` for exactly this reason.
  const dev = providerLaunchPlan({ provider: 'grok', model: 'grok-4.6', effort: 'high', role: 'developer', cwd, mode: 'new', prompt: '--force' });
  assert.equal(dev.args.at(-2), '--', 'the `--` end-of-options separator must immediately precede the prompt');
  assert.equal(dev.args.at(-1), '--force', 'the prompt is the last argv token');
  const beforeSeparator = dev.args.slice(0, dev.args.length - 2);
  assert.ok(!beforeSeparator.includes('--force'), 'a bare --force must not appear before the `--` separator (it would be parsed as an active flag)');
});

test('Grok setupMcp is registered but not unit-tested here', () => {
  // Grok registers the broker by shelling out to the installed `grok` binary
  // (`grok mcp add ...`), a side-effecting call to an external CLI -- exercising
  // it here would depend on a locally installed, authenticated `grok` and would
  // mutate its TOML config. That broker-registration path is integration-verified
  // separately; this only proves the adapter wires up the hook.
  assert.equal(typeof ADAPTERS.grok.setupMcp, 'function');
});

// --- broker env: references only, never raw secrets ---------------------

test('ensureProviderMcp never writes a raw secret value -- qwen, cursor, and opencode all forward env by reference', () => {
  // No real token exists in this test; the point is to lock that every written
  // VALUE is a reference marker ($VAR or {env:VAR}/${env:VAR}), never a literal.
  const referencePattern = /\$|\{env:/;

  const qwenCwd = temp();
  ensureProviderMcp({ provider: 'qwen', cwd: qwenCwd, mcpScript: '/plugin/mcp.mjs' });
  const qwenSettings = JSON.parse(readFileSync(join(qwenCwd, '.qwen', 'settings.json'), 'utf8'));
  for (const value of Object.values(qwenSettings.mcpServers.agent_world.env)) {
    assert.match(value, referencePattern, `qwen env value '${value}' must be a reference, not a literal secret`);
  }

  const cursorCwd = temp();
  ensureProviderMcp({ provider: 'cursor', cwd: cursorCwd, mcpScript: '/plugin/mcp.mjs' });
  const cursorSettings = JSON.parse(readFileSync(join(cursorCwd, '.cursor', 'mcp.json'), 'utf8'));
  for (const value of Object.values(cursorSettings.mcpServers.agent_world.env)) {
    assert.match(value, referencePattern, `cursor env value '${value}' must be a reference, not a literal secret`);
  }

  const opencodeCwd = temp();
  ensureProviderMcp({ provider: 'opencode', cwd: opencodeCwd, mcpScript: '/plugin/mcp.mjs' });
  const opencodeSettings = JSON.parse(readFileSync(join(opencodeCwd, 'opencode.json'), 'utf8'));
  for (const value of Object.values(opencodeSettings.mcp.agent_world.environment)) {
    assert.match(value, referencePattern, `opencode environment value '${value}' must be a reference, not a literal secret`);
  }
});

test('Codex option-injection is neutralized: a dash-leading prompt stays a positional value after --', () => {
  const cwd = temp();
  // Codex's parser (clap) would treat a bare dash-leading positional as a flag,
  // e.g. --dangerously-bypass-approvals-and-sandbox. The `--` separator makes it inert.
  const plan = providerLaunchPlan({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'high', role: 'reviewer', cwd, mode: 'new', prompt: '--dangerously-bypass-approvals-and-sandbox' });
  assert.equal(plan.args.at(-2), '--');
  assert.equal(plan.args.at(-1), '--dangerously-bypass-approvals-and-sandbox');
  // The dangerous string must not appear as an active flag before the separator.
  assert.ok(!plan.args.slice(0, plan.args.indexOf('--')).includes('--dangerously-bypass-approvals-and-sandbox'));
});
