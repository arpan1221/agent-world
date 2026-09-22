import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.mjs';
const sid = '00000000-0000-4000-8000-000000000001';
test('API auth, origin checks, live events, task persistence and PTY transport', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-world-server-')), calls = [], writes = [];
  let output, exit;
  const spawn = (file, args) => { calls.push({ file, args }); return { onData(fn) { output = fn; }, onExit(fn) { exit = fn; }, write(data) { writes.push(data); output(data); }, resize() {}, kill() { exit({ exitCode: 0 }); } }; };
  const topology = { nodes: [{ id: sid, name: 'Fixture', cwd: dir, status: 'dormant', live: false }], edges: [], generatedAt: new Date().toISOString() };
  const app = await startServer({ port: 0, stateDir: dir, claudeDir: join(dir, 'empty'), scan: async () => topology, terminalSpawn: spawn });
  const base = `http://127.0.0.1:${app.port}`, headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/world')).status, 401);
    assert.equal((await fetch(base + '/api/hooks', { method: 'POST', headers, body: '{}' })).status, 401);
    for (const asset of ['/vendor/three.js', '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/xterm-fit.js']) assert.equal((await fetch(base + asset)).status, 200);
    assert.equal((await fetch(base + '/api/world', { headers: { ...headers, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/terminal/open', { headers })).status, 405); assert.equal(calls.length, 0);
    const streamAbort = new AbortController(); const stream = await fetch(base + '/api/events', { headers, signal: streamAbort.signal }); const reader = stream.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: world/);
    const taskResponse = await fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ sessionId: sid, title: 'Test workshop', cwd: dir }) }); assert.equal(taskResponse.status, 201); const task = await taskResponse.json();
    assert.match(new TextDecoder().decode((await reader.read()).value), /Test workshop/); streamAbort.abort();
    await fetch(base + '/api/tasks/' + task.id, { method: 'POST', headers, body: JSON.stringify({ stage: 'completed' }) }); assert.equal(app.state.data.tasks[0].stage, 'completed');
    const opened = await fetch(base + '/api/terminal/open', { method: 'POST', headers, body: JSON.stringify({ sessionId: sid, mode: 'resume' }) }).then(r => r.json()); assert.ok(opened.id); assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('--resume'));
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/api/terminal/${opened.id}?token=${app.token}`, { origin: base }); await new Promise((yes, no) => { ws.once('open', yes); ws.once('error', no); });
    ws.send(JSON.stringify({ type: 'input', data: 'hello\r' })); await new Promise(r => setTimeout(r, 30)); assert.equal(writes[0], 'hello\r');
    const again = await fetch(base + '/api/terminal/open', { method: 'POST', headers, body: JSON.stringify({ sessionId: sid, mode: 'resume' }) }).then(r => r.json()); assert.equal(again.id, opened.id); assert.equal(calls.length, 1);
    ws.close(); await fetch(base + '/api/terminal/close', { method: 'POST', headers, body: JSON.stringify({ id: opened.id }) });
  } finally { await app.close(); }
});

test('explicit tmux imports are projected as reconnectable managed sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-world-tmux-import-')), calls = [];
  const terminalSpawn = (file, args) => { calls.push({ file, args }); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };
  const app = await startServer({ port: 0, stateDir: dir, claudeDir: join(dir, 'empty'), scan: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }), terminalSpawn, externalTmux: [{ pane: 'pipeline-codex', cwd: dir, name: 'pipeline-codex', provider: 'codex', role: 'developer', biome: 'frontend' }] });
  try {
    const world = app.snapshot(), session = world.sessions.find(s => s.sessionId === 'tmux:pipeline-codex');
    assert.equal(calls[0].file, 'tmux'); assert.deepEqual(calls[0].args, ['attach-session', '-t', 'pipeline-codex']);
    assert.equal(session.name, 'pipeline-codex'); assert.equal(session.provider, 'codex'); assert.equal(session.managed, true); assert.equal(session.live, true);
  } finally { await app.close(); }
});

const orchestrationRoster = [
  { role: 'developer', provider: 'claude', model: 'sonnet', effort: 'high' },
  { role: 'tester', provider: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
  { role: 'reviewer', provider: 'claude', model: 'opus', effort: 'xhigh' },
  { role: 'council', provider: 'codex', model: 'gpt-6-astra', effort: 'high', count: 5 }
];
test('orchestration API launches scoped mixed-model workers and MCP reads real work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-world-orchestration-api-')), launches = [], writes = [];
  let output, exit;
  const terminalSpawn = (file, args, options) => { launches.push({ file, args, options }); return { onData(fn) { output = fn; }, onExit(fn) { exit = fn; }, write(data) { writes.push(data); output?.(data); }, resize() {}, kill() { exit?.({ exitCode: 0 }); } }; };
  const topology = { nodes: [], edges: [], generatedAt: new Date().toISOString() };
  const app = await startServer({ port: 0, stateDir: dir, claudeDir: join(dir, 'empty'), scan: async () => topology, terminalSpawn, gateRunner: async input => ({ ...input, exitCode: 0, output: 'trusted fixture' }) });
  const base = `http://127.0.0.1:${app.port}`, headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  try {
    const createdResponse = await fetch(base + '/api/orchestrations', { method: 'POST', headers, body: JSON.stringify({ objective: 'Cross-check a fixture', cwd: dir, roster: orchestrationRoster }) }); assert.equal(createdResponse.status, 201); const run = await createdResponse.json();
    const developer = run.assignments.find(a => a.role === 'developer');
    const launchedResponse = await fetch(`${base}/api/orchestrations/${run.id}/launch`, { method: 'POST', headers, body: JSON.stringify({ assignmentId: developer.id }) }); assert.equal(launchedResponse.status, 201); assert.equal(launches[0].file, 'claude'); assert.ok(launches[0].args.includes('sonnet'));
    const workerToken = launches[0].options.env.AGENT_WORLD_WORKER_TOKEN; assert.equal(workerToken.length, 64); assert.equal(launches[0].options.env.AGENT_WORLD_STATE_DIR, undefined); assert.notEqual(workerToken, app.token);
    const snapshot = await fetch(base + '/api/world', { headers }).then(r => r.json()); assert.ok(!JSON.stringify(snapshot).includes(workerToken)); assert.ok(!JSON.stringify(snapshot).includes('tokenHash'));
    const work = await fetch(base + '/agent/work', { method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: '{}' }); assert.equal(work.status, 200); assert.equal((await work.json()).assignment.id, developer.id);
    assert.equal((await fetch(base + '/api/world', { headers: { authorization: `Bearer ${workerToken}` } })).status, 401);
    const mcp = spawn(process.execPath, [new URL('../plugin/scripts/mcp.mjs', import.meta.url).pathname], { env: { ...process.env, AGENT_WORLD_URL: base, AGENT_WORLD_WORKER_TOKEN: workerToken }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; mcp.stdout.on('data', chunk => text += chunk); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n'); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'world_get_work', arguments: {} } }) + '\n'); mcp.stdin.end();
    await new Promise((yes, no) => { mcp.on('exit', yes); mcp.on('error', no); }); const responses = text.trim().split('\n').map(JSON.parse); assert.equal(responses.find(r => r.id === 2).result.tools.length, 7); assert.match(responses.find(r => r.id === 3).result.content[0].text, /Cross-check a fixture/);
    const gate = await fetch(`${base}/api/orchestrations/${run.id}/gate`, { method: 'POST', headers, body: JSON.stringify({ command: 'npm', args: ['test'], confirm: true }) }); assert.equal(gate.status, 200); assert.equal((await gate.json()).exitCode, 0);
  } finally { await app.close(); }
});

test('companion hook forwards a synthetic confirmed task and fails open offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-world-hook-'));
  const app = await startServer({ port: 0, stateDir: dir, claudeDir: join(dir, 'empty'), demo: true });
  const input = { session_id: sid, hook_event_name: 'PostToolUse', tool_use_id: 'fixture-tool', tool_name: 'TaskCreate', tool_input: { subject: 'Hook-built workshop' }, tool_response: { task: { id: '1' } } };
  const run = () => new Promise((yes, no) => {
    const child = spawn(process.execPath, [new URL('../plugin/scripts/forward.mjs', import.meta.url).pathname], { env: { ...process.env, AGENT_WORLD_STATE_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c); child.on('error', no); child.on('exit', code => { try { assert.equal(code, 0); assert.equal(output, ''); yes(); } catch (e) { no(e); } }); child.stdin.end(JSON.stringify(input));
  });
  try { await run(); await run(); assert.equal(app.state.data.tasks.length, 1); assert.equal(app.state.data.tasks[0].title, 'Hook-built workshop'); }
  finally { await app.close(); }
  await run();
});
