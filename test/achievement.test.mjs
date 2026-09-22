import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AchievementLedger, observedFacts } from '../src/achievements.mjs';
import { compileBlueprint } from '../src/blueprint.mjs';
import { startServer } from '../src/server.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'world-achievement-test-'));

test('observed milestones replay exactly after restart, and adding earlier IDs cannot move plots', () => {
  const dir = temp(), ledger = new AchievementLedger(dir), world = { tasks: [{ id: 'z', title: 'API forge', cwd: '/fixture', component: 'service', stage: 'planned', source: 'user' }] };
  ledger.observe(world); const first = compileBlueprint(ledger.at());
  assert.equal(ledger.observe(world).length, 0);
  world.tasks[0].stage = 'building'; ledger.observe(world);
  world.tasks.push({ id: 'a', title: 'Data vault', component: 'database', stage: 'completed', source: 'user', dependsOn: ['z'] }); ledger.observe(world);
  const latest = compileBlueprint(ledger.at());
  assert.deepEqual(latest.structures[0].position, first.structures[0].position);
  assert.equal(latest.structures[1].verified, false); assert.equal(latest.roads.length, 1);
  assert.deepEqual(compileBlueprint(new AchievementLedger(dir).at(1)), first);
  assert.deepEqual(compileBlueprint(new AchievementLedger(dir).at()), latest);
  assert.equal(ledger.history()[0].origin, 'imported');
  assert.throws(() => ledger.at(-1), /Invalid/);
  const stored = JSON.parse(readFileSync(ledger.file)); stored.events[0].fact.title = 'tampered'; writeFileSync(ledger.file, JSON.stringify(stored));
  assert.throws(() => new AchievementLedger(dir), /verification failed/);
});

test('only broker accepted work in a passed run earns an accepted landmark', () => {
  assert.equal(observedFacts({ tasks: [{ id: 'hook', title: 'Unverified', stage: 'completed', source: 'claude' }] })[0].status, 'submitted');
  assert.equal(observedFacts({ tasks: [{ id: 'hook', title: 'Approved', stage: 'completed', source: 'claude', completionAuthority: 'human' }] })[0].status, 'completed');
  const run = { id: 'r', cwd: '/fixture', status: 'running', assignments: [{ id: 'a', title: 'Build', role: 'developer', status: 'submitted', attempt: 1, submissionId: 's', dependsOn: [] }], submissions: [{ id: 's', attempt: 1, artifacts: [{ path: 'a.js', sha256: 'a'.repeat(64), bytes: 10 }] }], verdicts: [], checks: [] };
  const plan = () => compileBlueprint({ revision: 1, hash: 'fixture', facts: observedFacts({ tasks: [], orchestration: { runs: [run] } }) });
  assert.equal(plan().counts.accepted, 0); assert.equal(plan().structures[0].evidence.length, 1);
  run.assignments[0].status = 'accepted'; assert.equal(plan().counts.accepted, 0);
  run.status = 'passed'; assert.equal(plan().counts.accepted, 1);
  run.assignments[0].attempt = 2; run.assignments[0].status = 'challenged';
  assert.equal(plan().structures[0].evidence.length, 0); assert.equal(plan().structures[0].builderState, 'waiting');
});

test('challenges retain submitted masonry while removing acceptance signals', () => {
  const ledger = new AchievementLedger(temp()), world = { tasks: [{ id: 'repair', title: 'Repair', stage: 'building', source: 'user' }] };
  ledger.observe(world); world.tasks[0].stage = 'completed'; ledger.observe(world);
  world.tasks[0].stage = 'blocked'; ledger.observe(world);
  const site = compileBlueprint(ledger.at()).structures[0]; assert.equal(site.phase, 3); assert.equal(site.builderState, 'waiting'); assert.equal(site.verified, false);
  assert.ok(site.blocks.some(b => b.y === 3.8));
});

test('authenticated task API produces typed sites and historical plans; demo stays fictional', async () => {
  const app = await startServer({ port: 0, stateDir: temp(), demo: true });
  const base = `http://127.0.0.1:${app.port}`, headers = { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' };
  const get = path => fetch(base + path, { headers }).then(r => r.json());
  const post = (path, value) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(value) }).then(r => r.json());
  try {
    assert.equal((await fetch(base + '/api/blueprint')).status, 401);
    const world = await get('/api/world'), sessionId = world.sessions[0].sessionId;
    const task = await post('/api/tasks', { title: 'Storage', component: 'database', sessionId });
    const before = await get('/api/blueprint'); assert.equal(before.structures[0].kind, 'database');
    await post('/api/tasks/' + task.id, { stage: 'building' });
    const after = await get('/api/blueprint'); assert.ok(after.structures[0].blocks.length > before.structures[0].blocks.length);
    assert.deepEqual(await get('/api/blueprint?revision=' + before.revision), before);
    assert.equal((await get('/api/achievements')).events.length, 2);
    for (let i = 0; i < 4; i++) await post('/api/demo/construction', {});
    const demo = await get('/api/blueprint'); assert.equal(demo.structures.filter(s => s.authority === 'demo').length, 8); assert.equal(demo.counts.accepted, 0);
    assert.equal((await fetch(base + '/construction.js')).status, 200);
  } finally { await app.close(); }
});
