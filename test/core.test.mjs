import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldState } from '../src/state.mjs';
import { normalizeHook } from '../plugin/scripts/normalize.mjs';
import { launchPlan } from '../src/terminals.mjs';
import { toWorld, demoTopology } from '../src/world.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'agent-world-test-'));
const sid = '00000000-0000-4000-8000-000000000001';

test('task progress survives restart and duplicate hook delivery', () => {
  const dir = temp(), store = new WorldState(dir);
  const event = { id: 'event-one', type: 'task.created', sessionId: sid, taskId: '1', title: 'Build the garden', stage: 'planned' };
  assert.equal(store.accept(event), true); assert.equal(store.accept(event), false);
  store.accept({ ...event, id: 'event-two', type: 'task.updated', stage: 'completed', title: '' });
  const restored = new WorldState(dir); assert.equal(restored.data.tasks.length, 1); assert.equal(restored.data.tasks[0].stage, 'completed'); assert.equal(restored.data.tasks[0].title, 'Build the garden'); assert.equal(restored.accept(event), false);
});
test('task IDs are scoped to their owning session', () => {
  const store = new WorldState(temp()); for (const s of ['a', 'b']) store.accept({ id: s, type: 'task.created', sessionId: s, taskId: '1', title: 'Task', stage: 'planned' }); assert.equal(store.data.tasks.length, 2);
});
test('Stop and pre-completion hooks do not claim that a task completed', () => {
  const base = { session_id: sid, task_id: '1', task_subject: 'Task' };
  assert.equal(normalizeHook({ ...base, hook_event_name: 'Stop' }).type, 'turn.completed'); assert.equal(normalizeHook({ ...base, hook_event_name: 'TaskCompleted' }), null);
  const claim = normalizeHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_use_id: 't1', tool_input: { taskId: '1', status: 'completed' } }); assert.equal(claim.type, 'task.claimed'); assert.equal(claim.stage, 'building');
});
test('hook normalization drops prompts, raw outputs and source content', () => {
  const e = normalizeHook({ session_id: sid, hook_event_name: 'Notification', title: 'Ready', message: 'Waiting', prompt: 'DO NOT STORE', tool_response: 'SECRET' }); assert.ok(!JSON.stringify(e).includes('SECRET')); assert.ok(!JSON.stringify(e).includes('DO NOT STORE'));
});
test('live foreground sessions require an explicit fork; args are never shell interpolated', () => {
  const cwd = temp(), node = { id: sid, live: true };
  assert.throws(() => launchPlan({ provider: 'claude', model: 'sonnet', role: 'developer', node, cwd, mode: 'resume', pluginDir: '/plugin' }), /already running/);
  const plan = launchPlan({ provider: 'claude', model: 'sonnet', role: 'developer', node, cwd, mode: 'fork', prompt: '$(echo secret); hello', pluginDir: '/plugin with spaces' });
  assert.equal(plan.file, 'claude'); assert.ok(plan.args.includes('--fork-session')); assert.equal(plan.args.at(-1), '$(echo secret); hello'); assert.ok(plan.args.includes('/plugin with spaces')); assert.notEqual(plan.sid, sid);
});
test('Codex and Claude launch plans preserve model choice and least privilege', () => {
  const cwd = temp(), mcpScript = '/agent world/mcp.mjs';
  const codex = launchPlan({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'high', role: 'reviewer', cwd, mcpScript, mode: 'new' });
  assert.equal(codex.file, 'codex'); assert.ok(codex.args.includes('gpt-5.6-terra')); assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'read-only'); assert.ok(codex.args.some(v => v.includes(JSON.stringify(mcpScript))));
  const forwarded = codex.args.find(v => v.startsWith('mcp_servers.agent_world.env_vars='));
  assert.deepEqual(JSON.parse(forwarded.split('=').slice(1).join('=')), ['AGENT_WORLD_URL', 'AGENT_WORLD_WORKER_TOKEN']);
  assert.ok(!forwarded.includes('AGENT_WORLD_TOKEN'));
  const claude = launchPlan({ provider: 'claude', model: 'opus', effort: 'xhigh', role: 'developer', cwd, pluginDir: '/plugin', mode: 'new' });
  assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'acceptEdits'); assert.ok(!claude.args.includes('bypassPermissions'));
});
test('archived builders and their completed workshops survive discovery removal', () => {
  const w = toWorld({ nodes: [], edges: [], generatedAt: new Date().toISOString() }, { revision: 1, notifications: [], tasks: [{ sessionId: sid, biome: 'frontend', title: 'Done', stage: 'completed' }] }); assert.equal(w.sessions.length, 1); assert.equal(w.sessions[0].source, 'archive'); assert.equal(w.tasks[0].stage, 'completed');
});
test('explicit tmux imports replace their live Claude registry duplicate', () => {
  const duplicate = { id: sid, name: 'agents-backend', cwd: '/work/agents', status: 'active', live: true, inTmux: true };
  const etl = { id: 'etl-session', name: 'pipeline-etl', cwd: '/work/etl', status: 'idle', live: true };
  const terminal = { sessionId: 'tmux:agents-backend', name: 'agents-backend', cwd: '/work/agents', provider: 'claude', biome: 'backend' };
  const world = toWorld({ nodes: [duplicate, etl], edges: [{ from: sid, to: 'etl-session', count: 1 }], generatedAt: new Date().toISOString() }, { revision: 1, notifications: [], tasks: [{ sessionId: sid, title: 'Verify contract', stage: 'building' }] }, [terminal]);
  assert.equal(world.stats.live, 2);
  assert.deepEqual(world.sessions.map(s => s.sessionId).sort(), ['etl-session', 'tmux:agents-backend']);
  assert.equal(world.edges[0].from, 'tmux:agents-backend');
  assert.equal(world.tasks[0].sessionId, 'tmux:agents-backend');
});
test('demo contains no owner snapshots and package excludes runtime state', () => {
  assert.ok(demoTopology().nodes.every(n => n.cwd.startsWith('/demo/')));
  const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))); assert.ok(!p.files.includes('.state')); assert.ok(!p.files.includes('world.json'));
});
