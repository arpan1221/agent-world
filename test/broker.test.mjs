import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.mjs';

// The scoped broker (plugin/scripts/mcp.mjs) is a single, CLI-agnostic stdio-MCP
// script: whichever CLI registers it, the same child connects back to the server and
// exchanges world_* messages. This locks the provider-NEUTRAL transport end-to-end --
// a worker on one CLI messages a worker on a DIFFERENT CLI through the real broker
// script + real server -- plus the two guarantees that make it safe: per-run scoping
// and worker-token auth. Only the PTY is stubbed; the broker, HTTP endpoints, auth,
// and durable message store are real. (Per-CLI *registration* of this child is covered
// separately in providers.test.mjs; here we prove what happens once it is mounted.)
const BROKER = new URL('../plugin/scripts/mcp.mjs', import.meta.url).pathname;
const stub = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });

// Drive the real broker as an MCP client over stdio (initialize + tools/list, then each
// tool call in order), exactly as a CLI host would. Returns parsed JSON-RPC responses.
function broker(base, token, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BROKER], { env: { ...process.env, AGENT_WORLD_URL: base, AGENT_WORLD_WORKER_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject);
    child.on('exit', () => { try { resolve(out.trim().split('\n').filter(Boolean).map(JSON.parse)); } catch { reject(new Error('bad broker output: ' + out + ' / ' + err)); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    calls.forEach((c, i) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2 + i, method: 'tools/call', params: { name: c.name, arguments: c.arguments || {} } }) + '\n'));
    child.stdin.end();
  });
}
const toolsCount = resp => resp.find(x => x.id === 1)?.result?.tools?.length ?? -1;
const call = (resp, id) => { const r = resp.find(x => x.id === id); return r?.error ? { error: r.error.message } : JSON.parse(r.result.content[0].text); };

const roster = extra => [
  { role: 'tester', provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high', count: 1 },
  { role: 'reviewer', provider: 'qwen', model: 'qwen3-coder-plus', effort: 'medium', count: 1 },
  { role: 'council', provider: 'grok', model: 'grok-4.5', effort: 'medium', count: 5 },
  ...extra,
];

test('scoped broker relays messages across two different CLIs, and enforces run-scoping + auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-world-broker-'));
  const app = await startServer({ port: 0, stateDir: dir, claudeDir: join(dir, 'empty'), scan: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }), terminalSpawn: stub });
  const base = `http://127.0.0.1:${app.port}`, orch = app.orchestration;
  const issue = (runId, role) => {
    const a = orch.run(runId).assignments.find(x => x.role === role && x.status === 'ready' && !x.workerId);
    const iss = orch.issueWorker(runId, a.id, null);
    orch.bindWorker(runId, iss.worker.id, 'sess-' + iss.worker.id.slice(0, 8), 'term-' + iss.worker.id.slice(0, 8));
    return { id: iss.worker.id, token: iss.token, provider: iss.worker.provider };
  };
  try {
    // Run 1: a claude developer and a codex orchestrator -- two peers on DIFFERENT CLIs.
    const run1 = orch.createRun({ objective: 'Cross-CLI broker handshake', cwd: dir, roster: roster([
      { role: 'orchestrator', provider: 'codex', model: 'gpt-6-astra', effort: 'high', count: 1 },
      { role: 'developer', provider: 'claude', model: 'sonnet', effort: 'high', count: 1 },
    ]) });
    const A = issue(run1.id, 'developer');    // claude
    const B = issue(run1.id, 'orchestrator'); // codex
    assert.notEqual(A.provider, B.provider);

    // A (claude) lists tools, discovers peers, and sends a scoped message to B (codex).
    const aResp = await broker(base, A.token, [
      { name: 'world_get_work' },
      { name: 'world_send_message', arguments: { toWorkerId: B.id, body: 'handshake claude->codex', correlationId: 'demo-1' } },
    ]);
    assert.equal(toolsCount(aResp), 7, 'broker exposes all seven world_* tools');
    const work = call(aResp, 2);
    assert.ok((work.peers || []).some(p => p.id === B.id && p.provider === 'codex'), 'claude worker sees the codex peer');
    const sent = call(aResp, 3);
    assert.equal(sent.error, undefined); assert.equal(sent.fromWorkerId, A.id); assert.equal(sent.toWorkerId, B.id);

    // B (codex) reads its inbox -> receives A's message; A's own inbox stays empty.
    const inbox = call(await broker(base, B.token, [{ name: 'world_inbox' }]), 2);
    assert.ok(Array.isArray(inbox) && inbox.length === 1 && inbox[0].fromWorkerId === A.id, 'codex inbox received the claude message');
    assert.match(inbox[0].body, /handshake claude->codex/);
    const aInbox = call(await broker(base, A.token, [{ name: 'world_inbox' }]), 2);
    assert.equal(aInbox.length, 0, 'sender inbox stays empty (one-way delivery)');

    // Run 2: a worker in a SEPARATE run cannot target a run-1 peer (per-run scoping).
    const run2 = orch.createRun({ objective: 'A separate run', cwd: dir, roster: roster([
      { role: 'orchestrator', provider: 'cursor', model: 'gpt-5', effort: 'medium', count: 1 },
      { role: 'developer', provider: 'opencode', model: 'openai/gpt-5.6-sol', effort: 'medium', count: 1 },
    ]) });
    const C = issue(run2.id, 'orchestrator'); // cursor, different run
    const cross = call(await broker(base, C.token, [{ name: 'world_send_message', arguments: { toWorkerId: A.id, body: 'should never arrive' } }]), 2);
    assert.ok(cross.error, 'a worker in another run is refused when targeting a run-1 peer');
    const bInbox2 = call(await broker(base, B.token, [{ name: 'world_inbox' }]), 2);
    assert.ok(bInbox2.every(m => m.fromWorkerId === A.id), 'nothing from run 2 leaked into run 1');

    // Auth: a well-formed but bogus worker token is rejected.
    const authRes = call(await broker(base, 'f'.repeat(64), [{ name: 'world_get_work' }]), 2);
    assert.ok(authRes.error, 'a bogus worker token is rejected by the broker/server');
  } finally { await app.close(); }
});
