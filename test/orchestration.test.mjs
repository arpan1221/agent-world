import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestrationStore, LENSES } from '../src/orchestration.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'agent-world-orchestration-'));
const roster = [
  { role: 'developer', provider: 'claude', model: 'sonnet', effort: 'high', count: 1 },
  { role: 'tester', provider: 'codex', model: 'gpt-5.6-terra', effort: 'high', count: 1 },
  { role: 'reviewer', provider: 'claude', model: 'opus', effort: 'xhigh', count: 1 },
  { role: 'council', provider: 'codex', model: 'gpt-6-astra', effort: 'high', count: 5 }
];
function launch(store, run, assignment) { return store.issueWorker(run.id, assignment.id, `session-${assignment.id}`); }

test('SDLC run requires independent evidence, review, full council and trusted gate', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd), run = store.createRun({ objective: 'Build safely', cwd, roster });
  const live = store.run(run.id), developer = live.assignments.find(a => a.role === 'developer'); assert.equal(developer.status, 'ready');
  const dev = launch(store, live, developer), authDev = store.authenticate(dev.token); writeFileSync(join(cwd, 'result.txt'), 'observed result');
  const submission = store.submit(authDev, { summary: 'Implemented', paths: ['result.txt'], claims: ['tests pass'], idempotencyKey: 'dev-submit' });
  assert.equal(submission.artifacts[0].sha256.length, 64); assert.notEqual(live.status, 'passed');
  for (const role of ['tester', 'reviewer']) { const assignment = live.assignments.find(a => a.role === role), issued = launch(store, live, assignment), auth = store.authenticate(issued.token); assert.throws(() => store.submit(auth, { summary: 'forge completion' }), /authorized/); store.review(auth, { targetAssignmentId: developer.id, verdict: 'pass', findings: ['independently observed'], idempotencyKey: role }); }
  assert.notEqual(live.status, 'passed');
  for (const assignment of live.assignments.filter(a => a.role === 'council')) { const issued = launch(store, live, assignment), auth = store.authenticate(issued.token); store.review(auth, { targetAssignmentId: developer.id, verdict: 'pass', findings: [`${assignment.lens} satisfied`], idempotencyKey: assignment.lens }); }
  assert.deepEqual(new Set(live.verdicts.filter(v => v.role !== 'developer').map(v => v.lens).filter(Boolean)), new Set(LENSES)); assert.notEqual(live.status, 'passed');
  store.recordCheck(live.id, { command: 'npm', args: ['test'], exitCode: 0, output: 'ok' }); assert.equal(live.status, 'passed'); assert.equal(developer.status, 'accepted');
  const restored = new OrchestrationStore(cwd); assert.equal(restored.run(live.id).status, 'passed'); assert.equal(restored.snapshot().auditHead.length, 64); assert.ok(!JSON.stringify(restored.snapshot()).includes(dev.token)); assert.ok(!JSON.stringify(restored.snapshot()).includes('tokenHash'));
});

test('broker scopes messages and council challenges prevent acceptance', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd), run = store.run(store.createRun({ objective: 'Coordinate', cwd, roster }).id), developer = run.assignments.find(a => a.role === 'developer');
  const dev = launch(store, run, developer), devAuth = store.authenticate(dev.token), testerAssignment = run.assignments.find(a => a.role === 'tester');
  assert.throws(() => store.send(devAuth, { toWorkerId: 'outside', body: 'escape' }), /Choose a worker/);
  const testerReadyLater = testerAssignment;
  writeFileSync(join(cwd, 'result.txt'), 'v1');
  // The target worker must exist before messaging; issue it after the developer claim in normal DAG order.
  store.submit(devAuth, { summary: 'claim', paths: ['result.txt'] });
  const tester = launch(store, run, testerReadyLater), testerAuth = store.authenticate(tester.token), reviewer = launch(store, run, run.assignments.find(a => a.role === 'reviewer')), reviewerAuth = store.authenticate(reviewer.token);
  const userMessage = store.sendUser(run.id, { toWorkerId: tester.worker.id, body: 'Please verify result.txt' });
  assert.equal(userMessage.toWorkerId, tester.worker.id);
  assert.throws(() => store.send(devAuth, { toWorkerId: tester.worker.id, body: 'late message' }), /authorized/);
  const message = store.send(testerAuth, { toWorkerId: reviewer.worker.id, body: 'Independent result did not reproduce', idempotencyKey: 'm1' });
  assert.equal(store.send(testerAuth, { toWorkerId: reviewer.worker.id, body: 'duplicate body ignored', idempotencyKey: 'm1' }).id, message.id); assert.equal(store.inbox(reviewerAuth)[0].body, 'Independent result did not reproduce'); assert.equal(store.inbox(testerAuth)[0].body, 'Please verify result.txt');
  store.review(testerAuth, { targetAssignmentId: developer.id, verdict: 'challenge', findings: ['claim not reproduced'] }); assert.equal(run.status, 'rework'); assert.equal(developer.status, 'challenged');
});
