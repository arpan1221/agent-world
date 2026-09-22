import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPairedFixture } from '../scripts/paired-fixture.mjs';
import { startServer } from '../src/server.mjs';
import { OrchestrationStore } from '../src/orchestration.mjs';
import { resolveProviderResumeHandle } from '../src/providers.mjs';

const frontend = `export async function loadGreeting(base) { const r = await fetch(base + '/api/hello'); if (!r.ok) throw Error('HTTP ' + r.status); return (await r.json()).message; }\n`;
const backend = `export function handler(req,res) { const status = req.url === '/api/hello' || req.url === '/health' ? 200 : 404; res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(req.url === '/api/hello' ? {message:'hello from the backend'} : {ok:status===200})); }\n`;

async function setup(t, { deferExitOnKill = false, failSpawn } = {}) {
  const fixture = createPairedFixture(), launches = [];
  const terminalSpawn = (file, args, options) => {
    const record = { file, args, options }; launches.push(record); if (failSpawn?.(record)) throw Error('fixture spawn failed');
    return { onData(fn) { record.output = fn; }, onExit(fn) { record.exit = fn; }, write(data) { record.output?.(data); }, resize() {}, kill() { record.killed = true; if (!deferExitOnKill) record.exit?.({ exitCode: 0 }); } };
  };
  const app = await startServer({ port: 0, stateDir: fixture.stateDir, claudeDir: join(fixture.root, 'empty'), scan: async () => ({ nodes: [], edges: [] }), terminalSpawn });
  t.after(() => app.close());
  const request = async (path, body = {}, token = app.token) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); return { status: response.status, ...result };
  };
  const created = await request('/api/orchestrations', fixture.input);
  assert.ok(created.id, JSON.stringify(created));
  const run = app.orchestration.run(created.id), route = action => `/api/orchestrations/${run.id}/${action}`;
  const approve = () => request(route('approve'), { confirm: true, approvalHash: run.paired.approvalHash });
  const launch = async assignment => { const response = await request(route('launch'), { assignmentId: assignment.id }); assert.equal(response.status, 201, JSON.stringify(response)); return launches.at(-1).options.env.AGENT_WORLD_WORKER_TOKEN; };
  const submitDevelopers = async () => {
    for (const a of run.assignments.filter(a => a.role === 'developer')) {
      const token = await launch(a); writeFileSync(join(a.workspace, a.lane === 'frontend' ? 'frontend/client.mjs' : 'backend/handler.mjs'), a.lane === 'frontend' ? frontend : backend);
      const result = await request('/agent/submit', { summary: 'Fixture implementation' }, token); assert.equal(result.status, 200, JSON.stringify(result));
    }
  };
  return { fixture, app, run, launches, request, route, approve, launch, submitDevelopers };
}

test('paired HTTP workflow: approval, scoped orchestrator dispatch, real worktrees, endpoint gates, independent council', async t => {
  const s = await setup(t), { run, request, route } = s;
  const devs = run.assignments.filter(a => a.role === 'developer'), leads = run.assignments.filter(a => a.role === 'orchestrator');
  assert.equal(run.paired.state, 'awaiting-approval');
  assert.equal((await request(route('launch'), { assignmentId: devs[0].id })).status, 400);
  assert.equal((await request(route('approve'), { confirm: true, approvalHash: 'wrong' })).status, 400);
  assert.equal((await s.approve()).status, 'ready');
  const leadToken = await s.launch(leads[0]);
  assert.equal((await request('/agent/dispatch', { assignmentId: devs[1].id }, leadToken)).status, 400);
  const dispatch = await request('/agent/dispatch', { assignmentId: devs[0].id }, leadToken); assert.equal(dispatch.status, 200);
  const devToken = s.launches.at(-1).options.env.AGENT_WORLD_WORKER_TOKEN;
  assert.equal(s.launches.at(-1).options.cwd, devs[0].workspace);
  assert.equal((await request('/agent/dispatch', { assignmentId: devs[1].id }, devToken)).status, 400);
  const count = s.launches.length; assert.equal((await request('/agent/dispatch', { assignmentId: devs[0].id }, leadToken)).alreadyRunning, true); assert.equal(s.launches.length, count);
  const work = await request('/agent/work', {}, devToken); assert.equal(work.contract.endpoints[0].path, '/api/hello'); assert.deepEqual(work.assignment.allowedPaths, ['frontend/']);
  writeFileSync(join(devs[0].workspace, 'frontend/client.mjs'), frontend);
  assert.equal((await request('/agent/submit', { summary: 'Frontend consumer' }, devToken)).status, 200);
  const backToken = await s.launch(devs[1]); writeFileSync(join(devs[1].workspace, 'backend/handler.mjs'), backend);
  assert.equal((await request('/agent/submit', { summary: 'Backend endpoint' }, backToken)).status, 200);
  assert.notEqual(devs[0].workspace, devs[1].workspace); assert.notEqual(devs[0].workspace, s.fixture.cwd);
  assert.match(readFileSync(join(s.fixture.cwd, 'backend/handler.mjs'), 'utf8'), /501/);
  assert.equal(run.paired.state, 'submitted');
  assert.equal((await request(route('gate'), { confirm: true })).status, 400);
  const integration = await request('/agent/integrate', {}, leadToken); assert.equal(integration.status, 200);
  // Later developer edits cannot alter captured integration content.
  writeFileSync(join(devs[0].workspace, 'frontend/client.mjs'), 'unsubmitted later edit');
  const gate = await request(route('gate'), { confirm: true, command: 'ignored-unapproved-command' }); assert.equal(gate.exitCode, 0, JSON.stringify(gate));
  assert.match(gate.outputTail, /frontend consumes the real backend endpoint/); assert.doesNotMatch(gate.outputTail, /skipping running files/);
  assert.equal(run.paired.state, 'awaiting-review'); assert.notEqual(run.status, 'passed');
  for (const role of ['tester', 'reviewer', 'council']) for (const a of run.assignments.filter(a => a.role === role)) {
    const token = await s.launch(a); assert.equal(s.launches.at(-1).options.cwd, run.integrationCwd);
    assert.equal((await request('/agent/review', { targetAssignmentId: devs[0].id, verdict: 'pass', findings: ['fixture review'] }, token)).status, 400);
    for (const target of devs) { const review = await request('/agent/review', { targetAssignmentId: target.id, integrationId: integration.id, verdict: 'pass', findings: [`Observed ${role} fixture evidence for ${target.lane}`] }, token); assert.equal(review.status, 200, JSON.stringify(review)); }
  }
  assert.equal(run.status, 'passed'); assert.equal(run.paired.state, 'passed');
  const restored = new OrchestrationStore(s.fixture.stateDir); assert.equal(restored.run(run.id).status, 'passed');
});

test('new developer attempt cannot inherit old integration gates or reviews', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  await s.request(s.route('integrate')); await s.request(s.route('gate'), { confirm: true });
  const oldId = s.run.integration.id, developer = s.run.assignments.find(a => a.role === 'developer');
  assert.equal((await s.request(s.route('rework'), { assignmentId: developer.id })).status, 'challenged');
  const token = await s.launch(developer); writeFileSync(join(developer.workspace, 'frontend/client.mjs'), frontend + '// second attempt\n');
  await s.request('/agent/submit', { summary: 'Repaired frontend' }, token);
  assert.equal(s.app.orchestration.pair.gatesPassed(s.run), false);
  assert.equal((await s.request(s.route('gate'), { confirm: true })).status, 400);
  const integration = await s.request(s.route('integrate')); assert.notEqual(integration.id, oldId); assert.equal(integration.status, 200);
  assert.equal((await s.request(s.route('gate'), { confirm: true })).exitCode, 0);
});

test('human-approved frontend reassignment preserves worktrees and backend submission but requires a fresh Sol capture and integration', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  const frontendDeveloper = s.run.assignments.find(a => a.role === 'developer' && a.lane === 'frontend');
  const backendDeveloper = s.run.assignments.find(a => a.role === 'developer' && a.lane === 'backend');
  const lead = s.run.assignments.find(a => a.role === 'orchestrator');
  const leadToken = await s.launch(lead); await s.request(s.route('integrate'));
  const before = {
    approvalHash: s.run.paired.approvalHash,
    integrationId: s.run.integration.id,
    frontendWorkspace: frontendDeveloper.workspace,
    frontendSubmissionId: frontendDeveloper.submissionId,
    backendWorkspace: backendDeveloper.workspace,
    backendSubmissionId: backendDeveloper.submissionId,
    backendAttempt: backendDeveloper.attempt,
    submissions: s.run.submissions.length
  };
  const input = { confirm: true, approvalHash: before.approvalHash, integrationId: before.integrationId, assignmentId: frontendDeveloper.id, workerId: frontendDeveloper.workerId, submissionId: frontendDeveloper.submissionId, targetAttempt: frontendDeveloper.attempt, provider: 'claude', model: 'gpt-5.6-sol', effort: 'medium' };

  const reassigned = await s.request(s.route('reassign-developer'), input);
  assert.equal(reassigned.status, 200); assert.notEqual(reassigned.approvalHash, before.approvalHash);
  assert.equal(frontendDeveloper.provider, 'codex'); assert.equal(frontendDeveloper.model, 'gpt-5.6-sol'); assert.equal(frontendDeveloper.effort, 'medium'); assert.equal(frontendDeveloper.permission, 'workspace-write');
  assert.equal(frontendDeveloper.status, 'challenged'); assert.equal(frontendDeveloper.attempt, 1); assert.equal(frontendDeveloper.workspace, before.frontendWorkspace); assert.equal(frontendDeveloper.submissionId, before.frontendSubmissionId);
  assert.equal(backendDeveloper.workspace, before.backendWorkspace); assert.equal(backendDeveloper.submissionId, before.backendSubmissionId); assert.equal(backendDeveloper.attempt, before.backendAttempt); assert.equal(backendDeveloper.status, 'submitted');
  assert.equal(s.run.submissions.length, before.submissions); assert.ok(s.run.integration.invalidatedAt); assert.equal(s.run.integration.id, before.integrationId); assert.equal(s.app.orchestration.pair.gatesPassed(s.run), false);
  assert.equal((await s.request(s.route('gate'), { confirm: true })).status, 400);
  assert.ok(s.app.orchestration.authenticate(leadToken)); assert.equal((await s.request('/agent/work', {}, leadToken)).status, 200);

  const dispatch = await s.request('/agent/dispatch', { assignmentId: frontendDeveloper.id }, leadToken); assert.equal(dispatch.status, 200);
  const replacement = s.launches.at(-1), replacementToken = replacement.options.env.AGENT_WORLD_WORKER_TOKEN;
  assert.equal(replacement.file, 'codex'); assert.equal(replacement.args[replacement.args.indexOf('--model') + 1], 'gpt-5.6-sol'); assert.equal(replacement.args[replacement.args.indexOf('model_reasoning_effort="medium"')], 'model_reasoning_effort="medium"'); assert.equal(replacement.args[replacement.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(frontendDeveloper.attempt, 2); assert.equal(frontendDeveloper.workspace, before.frontendWorkspace);
  const submission = await s.request('/agent/submit', { summary: 'Sol independently reworked and recaptured the retained frontend tree' }, replacementToken);
  assert.equal(submission.status, 200); assert.notEqual(submission.id, before.frontendSubmissionId); assert.equal(submission.attempt, 2); assert.equal(frontendDeveloper.submissionId, submission.id);
  assert.equal(s.run.submissions.length, before.submissions + 1); assert.ok(s.run.submissions.some(item => item.id === before.frontendSubmissionId));
  assert.equal((await s.request(s.route('gate'), { confirm: true })).status, 400);
  const integration = await s.request('/agent/integrate', {}, leadToken); assert.equal(integration.status, 200); assert.notEqual(integration.id, before.integrationId);
  assert.ok(integration.snapshotIds.includes(submission.snapshot.id)); assert.ok(integration.snapshotIds.includes(s.run.submissions.find(item => item.id === before.backendSubmissionId).snapshot.id));
});

test('developer reassignment is human-only, CAS guarded, validates model and effort, ignores provider input, and rejects no-op changes', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate'));
  const developer = s.run.assignments.find(a => a.role === 'developer' && a.lane === 'frontend'), token = s.launches.find(record => record.options.env.AGENT_WORLD_WORKER_TOKEN)?.options.env.AGENT_WORLD_WORKER_TOKEN;
  const input = { confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: developer.id, workerId: developer.workerId, submissionId: developer.submissionId, targetAttempt: developer.attempt, model: 'gpt-5.6-sol', effort: 'medium' };
  assert.equal((await s.request(s.route('reassign-developer'), input, token)).status, 401);
  for (const change of [{ confirm: false }, { approvalHash: 'stale' }, { integrationId: 'stale' }, { workerId: 'stale' }, { submissionId: 'stale' }, { targetAttempt: 99 }]) assert.equal((await s.request(s.route('reassign-developer'), { ...input, ...change })).status, 400);
  assert.equal((await s.request(s.route('reassign-developer'), { ...input, model: 'bad model' })).status, 400);
  assert.equal((await s.request(s.route('reassign-developer'), { ...input, effort: 'impossible' })).status, 400);
  assert.equal((await s.request(s.route('reassign-developer'), { ...input, model: developer.model, effort: developer.effort })).status, 400);
  const result = await s.request(s.route('reassign-developer'), { ...input, provider: 'claude' }); assert.equal(result.status, 200); assert.equal(developer.provider, 'codex');
  assert.equal((await s.request(s.route('reassign-developer'), input)).status, 400);
});

test('developer reassignment rejects busy, active-child, exhausted-attempt and stale-tree contexts', async t => {
  const makeInput = (s, developer) => ({ confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: developer.id, workerId: developer.workerId, submissionId: developer.submissionId, targetAttempt: developer.attempt, model: 'gpt-5.6-sol', effort: 'medium' });
  {
    const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate')); const developer = s.run.assignments.find(a => a.lane === 'frontend'), input = makeInput(s, developer);
    s.app.orchestration.pair.busy.add(s.run.id); assert.equal((await s.request(s.route('reassign-developer'), input)).status, 400); s.app.orchestration.pair.busy.delete(s.run.id);
  }
  {
    const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate')); await s.request(s.route('gate'), { confirm: true }); const developer = s.run.assignments.find(a => a.lane === 'frontend'), validator = s.run.assignments.find(a => a.role === 'tester'), input = makeInput(s, developer);
    validator.status = 'ready'; await s.launch(validator); assert.equal((await s.request(s.route('reassign-developer'), input)).status, 400);
  }
  {
    const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate')); const developer = s.run.assignments.find(a => a.lane === 'frontend'); developer.attempt = s.run.policy.maxAttempts;
    assert.equal((await s.request(s.route('reassign-developer'), makeInput(s, developer))).status, 400);
  }
  {
    const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate')); const developer = s.run.assignments.find(a => a.lane === 'frontend'), input = makeInput(s, developer), oldModel = developer.model;
    writeFileSync(join(s.run.integrationCwd, 'backend/handler.mjs'), '// stale integration tree\n'); assert.equal((await s.request(s.route('reassign-developer'), input)).status, 400); assert.equal(s.run.paired.state, 'needs-human'); assert.equal(developer.model, oldModel);
  }
});

test('developer reassignment rolls back on audit persistence failure', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate'));
  const developer = s.run.assignments.find(a => a.lane === 'frontend'), before = structuredClone(s.run), eventCount = s.app.orchestration.data.events.length, append = s.app.orchestration.append;
  const input = { confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: developer.id, workerId: developer.workerId, submissionId: developer.submissionId, targetAttempt: developer.attempt, model: 'gpt-5.6-sol', effort: 'medium' };
  s.app.orchestration.append = () => { throw Error('fixture persistence failure'); };
  assert.throws(() => s.app.orchestration.pair.reassignDeveloper(s.run, input), /persistence failure/); s.app.orchestration.append = append;
  assert.deepEqual(s.run, before); assert.equal(s.app.orchestration.data.events.length, eventCount);
});

test('restart-interrupted paired run can reassign a submitted developer and reopens its retained orchestrator', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  const lead = s.run.assignments.find(a => a.role === 'orchestrator' && a.provider === 'codex'); await s.launch(lead); await s.request(s.route('integrate'));
  const previous = { approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id };
  const restored = new OrchestrationStore(s.fixture.stateDir), run = restored.run(s.run.id), developer = run.assignments.find(a => a.lane === 'frontend'), interruptedLead = run.assignments.find(a => a.id === lead.id);
  assert.equal(run.paired.state, 'interrupted'); assert.equal(interruptedLead.status, 'interrupted');
  const result = restored.pair.reassignDeveloper(run, { confirm: true, approvalHash: previous.approvalHash, integrationId: previous.integrationId, assignmentId: developer.id, workerId: developer.workerId, submissionId: developer.submissionId, targetAttempt: developer.attempt, model: 'gpt-5.6-sol', effort: 'medium' });
  assert.notEqual(result.approvalHash, previous.approvalHash); assert.equal(run.paired.state, 'challenged'); assert.equal(developer.status, 'challenged'); assert.equal(interruptedLead.status, 'ready'); assert.equal(interruptedLead.workerId, null); assert.ok(run.integration.invalidatedAt);
  const persisted = new OrchestrationStore(s.fixture.stateDir).run(run.id); assert.equal(persisted.paired.approvalHash, result.approvalHash); assert.equal(persisted.assignments.find(a => a.id === lead.id).status, 'ready');
});

test('failed reassigned developer launch retains the approved amendment and permits a bounded retry', async t => {
  let failReplacement = true;
  const s = await setup(t, { failSpawn: record => record.args.includes('gpt-5.6-sol') && failReplacement && !(failReplacement = false) });
  await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate'));
  const developer = s.run.assignments.find(a => a.lane === 'frontend');
  const amended = await s.request(s.route('reassign-developer'), { confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: developer.id, workerId: developer.workerId, submissionId: developer.submissionId, targetAttempt: developer.attempt, model: 'gpt-5.6-sol', effort: 'medium' });
  assert.equal(amended.status, 200); assert.equal((await s.request(s.route('launch'), { assignmentId: developer.id })).status, 400);
  assert.equal(developer.model, 'gpt-5.6-sol'); assert.equal(developer.status, 'ready'); assert.equal(developer.attempt, 2); assert.equal(s.run.paired.approvalHash, amended.approvalHash); assert.ok(s.run.integration.invalidatedAt);
  const retryToken = await s.launch(developer); assert.ok(s.app.orchestration.authenticate(retryToken)); assert.equal(developer.attempt, s.run.policy.maxAttempts);
});

test('protected harness edits fail closed and restart revokes orphan workers', async t => {
  const s = await setup(t); await s.approve(); const a = s.run.assignments.find(a => a.role === 'developer');
  const token = await s.launch(a); writeFileSync(join(a.workspace, 'tests/acceptance.test.mjs'), '// cheated\n');
  assert.equal((await s.request('/agent/submit', { summary: 'Fake pass' }, token)).status, 400);
  assert.equal(s.run.paired.state, 'ownership-violation'); assert.equal(s.app.orchestration.authenticate(token), null);
  const lead = s.run.assignments.find(a => a.role === 'orchestrator'), leadToken = await s.launch(lead);
  const restored = new OrchestrationStore(s.fixture.stateDir); assert.equal(restored.authenticate(leadToken), null); assert.equal(restored.run(s.run.id).paired.state, 'interrupted');
});

test('broker restart resumes the exact max-attempt provider session without charging a fourth attempt', async t => {
  const s = await setup(t); await s.approve();
  const developer = s.run.assignments.find(a => a.role === 'developer' && a.provider === 'claude');
  developer.attempt = s.run.policy.maxAttempts - 1;
  const oldToken = await s.launch(developer);
  assert.equal(developer.attempt, s.run.policy.maxAttempts);

  const restored = new OrchestrationStore(s.fixture.stateDir, { resolveResumeHandle: ({ worker }) => worker.sessionId }), run = restored.run(s.run.id);
  const resumed = run.assignments.find(a => a.id === developer.id);
  assert.equal(restored.authenticate(oldToken), null);
  assert.equal(resumed.status, 'resume-ready');
  assert.equal(resumed.restartTicket.attempt, run.policy.maxAttempts);
  assert.equal(resumed.restartTicket.sessionId, developer.sessionId);

  assert.throws(() => restored.issueWorker(run.id, resumed.id, null), /not ready|Attempt limit|recover/);
  const issued = restored.issueResume(run.id, resumed.id, resumed.restartTicket.nonce);
  assert.equal(resumed.attempt, run.policy.maxAttempts);
  assert.equal(issued.assignment.attempt, run.policy.maxAttempts);
  assert.equal(issued.worker.sessionId, developer.sessionId);
  restored.bindResume(run.id, issued.worker.id, developer.sessionId, 'resumed-terminal');
  assert.equal(resumed.restartTicket, undefined);

  restored.workerExited(issued.worker.id, 1);
  assert.equal(resumed.status, 'needs-human');
  assert.throws(() => restored.pair.recoverRun(run), /Attempt budget exhausted/);
});

test('broker restart fails closed when a max-attempt provider session cannot be verified', async t => {
  const s = await setup(t); await s.approve();
  const developer = s.run.assignments.find(a => a.role === 'developer' && a.provider === 'codex');
  developer.attempt = s.run.policy.maxAttempts - 1; await s.launch(developer);
  const restored = new OrchestrationStore(s.fixture.stateDir), run = restored.run(s.run.id), interrupted = run.assignments.find(a => a.id === developer.id);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.restartTicket.sessionId, null);
  assert.throws(() => restored.pair.recoverRun(run), /Attempt budget exhausted/);
});

test('Codex resume handle resolver reads only an unambiguous root session for the exact worktree and lifetime', async t => {
  const s = await setup(t); await s.approve();
  const assignment = s.run.assignments.find(a => a.provider === 'codex' && a.role === 'developer'), codexDir = join(s.fixture.root, 'codex-home');
  const folder = join(codexDir, 'sessions', '2026', '09', '15'); mkdirSync(folder, { recursive: true });
  const worker = { provider: 'codex', createdAt: '2026-09-15T05:36:40.000Z' }, id = '01a0a391-7b02-72f3-9491-60157ec5c6b4';
  const meta = extra => JSON.stringify({ timestamp: '2026-09-15T05:36:55.000Z', type: 'session_meta', payload: { session_id: id, timestamp: '2026-09-15T05:36:55.000Z', cwd: assignment.workspace, originator: 'codex-tui', ...extra } }) + '\n';
  writeFileSync(join(folder, 'root.jsonl'), meta({})); writeFileSync(join(folder, 'child.jsonl'), meta({ parent_thread_id: id, session_id: '01a0a391-7b76-7863-ac1b-cfd6e89d7e79' }));
  assert.equal(resolveProviderResumeHandle({ worker, assignment, endedAt: '2026-09-15T05:40:00.000Z', codexDir }), id);
  writeFileSync(join(folder, 'ambiguous.jsonl'), meta({ session_id: '01a0a391-aaaa-4aaa-8aaa-60157ec5c6b4' }));
  assert.equal(resolveProviderResumeHandle({ worker, assignment, endedAt: '2026-09-15T05:40:00.000Z', codexDir }), null);
});

test('post-integration mutations invalidate gates without executing them', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers(); await s.request(s.route('integrate'));
  writeFileSync(join(s.run.integrationCwd, 'backend/handler.mjs'), '// changed behind broker\n');
  assert.equal((await s.request(s.route('gate'), { confirm: true })).status, 400);
  assert.equal(s.run.paired.state, 'needs-human'); assert.equal(s.run.checks.length, 0);
});

test('failed real gate recovers retained worktrees and requires fresh integration', async t => {
  const s = await setup(t); await s.approve();
  for (const a of s.run.assignments.filter(a => a.role === 'developer')) {
    const token = await s.launch(a); writeFileSync(join(a.workspace, a.lane === 'frontend' ? 'frontend/client.mjs' : 'backend/handler.mjs'), a.lane === 'frontend' ? frontend : backend.replace('hello from the backend', 'wrong greeting'));
    assert.equal((await s.request('/agent/submit', { summary: 'Intentionally failing fixture' }, token)).status, 200);
  }
  await s.request(s.route('integrate')); const original = s.run.integration;
  const result = await s.request(s.route('gate'), { confirm: true }); assert.notEqual(result.exitCode, 0, JSON.stringify(result)); assert.equal(s.run.paired.state, 'gate-failed');
  assert.equal((await s.request(s.route('recover'))).status, 'ready'); assert.equal(s.run.integration.id, original.id);
  await s.submitDevelopers();
  assert.equal((await s.request(s.route('gate'), { confirm: true })).status, 400);
  const next = await s.request(s.route('integrate')); assert.equal(next.status, 200); assert.notEqual(next.id, original.id);
  assert.equal((await s.request(s.route('gate'), { confirm: true })).exitCode, 0);
});

test('late exit cannot reset replacement assignment; attempt budget is enforced', async t => {
  const s = await setup(t); await s.approve(); const a = s.run.assignments.find(a => a.role === 'developer');
  const oldToken = await s.launch(a), oldId = a.workerId;
  s.app.orchestration.failLaunch(s.run.id, oldId, 'late launch failure');
  const token = await s.launch(a), newId = a.workerId;
  s.app.orchestration.workerExited(oldId, 1);
  assert.equal(a.workerId, newId); assert.equal(a.status, 'running'); assert.equal(s.app.orchestration.authenticate(oldToken), null); assert.ok(s.app.orchestration.authenticate(token));
  s.app.orchestration.workerExited(newId, 1); assert.equal(a.status, 'interrupted');
  await s.request(s.route('recover')); await s.launch(a);
  s.app.orchestration.workerExited(a.workerId, 1); assert.equal(a.status, 'needs-human');
  assert.equal((await s.request(s.route('recover'))).status, 400);
});

test('human-approved orchestrator handoff revokes old authority and requires fresh gates for unchanged submissions', async t => {
  const s = await setup(t, { deferExitOnKill: true });
  await s.approve(); await s.submitDevelopers();
  const lead = s.run.assignments.find(a => a.role === 'orchestrator' && a.provider === 'codex');
  const developer = s.run.assignments.find(a => a.role === 'developer');
  const oldToken = await s.launch(lead), oldWorkerId = lead.workerId, oldTerminal = s.launches.at(-1);
  await s.request(s.route('integrate'));
  assert.equal((await s.request(s.route('gate'), { confirm: true })).exitCode, 0);
  const before = {
    approvalHash: s.run.paired.approvalHash,
    integration: structuredClone(s.run.integration),
    submissionIds: s.run.assignments.filter(a => a.role === 'developer').map(a => a.submissionId),
    snapshotIds: s.run.assignments.filter(a => a.role === 'developer').map(a => s.run.submissions.find(item => item.id === a.submissionId).snapshot.id),
    checks: s.run.checks.length
  };
  const handoff = { confirm: true, approvalHash: before.approvalHash, integrationId: before.integration.id, assignmentId: lead.id, workerId: oldWorkerId, provider: 'claude', model: 'claude-opus-4-8', effort: 'high' };

  assert.equal((await s.request(s.route('handoff'), handoff, oldToken)).status, 401);
  assert.equal((await s.request(s.route('handoff'), { ...handoff, confirm: false })).status, 400);
  assert.equal((await s.request(s.route('handoff'), { ...handoff, approvalHash: 'stale' })).status, 400);
  assert.equal((await s.request(s.route('handoff'), { ...handoff, integrationId: 'stale' })).status, 400);
  assert.equal((await s.request(s.route('handoff'), { ...handoff, assignmentId: developer.id })).status, 400);
  assert.equal((await s.request(s.route('handoff'), { ...handoff, model: 'bad model' })).status, 400);
  assert.ok(s.app.orchestration.authenticate(oldToken));

  const amended = await s.request(s.route('handoff'), handoff);
  assert.equal(amended.status, 200); assert.notEqual(amended.approvalHash, before.approvalHash); assert.notEqual(amended.integrationId, before.integration.id);
  assert.equal(oldTerminal.killed, true); assert.equal(s.app.orchestration.authenticate(oldToken), null);
  assert.equal((await s.request('/agent/work', {}, oldToken)).status, 401);
  assert.equal((await s.request(s.route('handoff'), handoff)).status, 400);
  assert.deepEqual(s.run.assignments.filter(a => a.role === 'developer').map(a => a.submissionId), before.submissionIds);
  assert.deepEqual(s.run.integration.snapshotIds, before.integration.snapshotIds); assert.deepEqual(s.run.integration.snapshotIds, before.snapshotIds);
  assert.equal(s.run.integration.treeHash, before.integration.treeHash); assert.equal(s.run.integration.contractHash, amended.approvalHash); assert.equal(s.run.integration.predecessorId, before.integration.id);
  assert.equal(s.run.checks.length, before.checks); assert.equal(s.app.orchestration.pair.gatesPassed(s.run), false);
  assert.equal(s.run.assignments.filter(a => ['tester', 'reviewer', 'council'].includes(a.role)).every(a => a.status === 'blocked'), true);
  const validator = s.run.assignments.find(a => a.role === 'tester');
  assert.equal((await s.request(s.route('launch'), { assignmentId: validator.id })).status, 400);

  const replacementToken = await s.launch(lead), replacementId = lead.workerId, replacement = s.launches.at(-1);
  assert.equal(replacement.file, 'claude');
  assert.equal(replacement.args[replacement.args.indexOf('--model') + 1], 'claude-opus-4-8');
  assert.equal(replacement.args[replacement.args.indexOf('--effort') + 1], 'high');
  assert.equal(replacement.args[replacement.args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(s.app.orchestration.authenticate(replacementToken));
  oldTerminal.exit({ exitCode: 1 });
  assert.equal(lead.workerId, replacementId); assert.equal(lead.status, 'running'); assert.ok(s.app.orchestration.authenticate(replacementToken));
  assert.throws(() => s.app.orchestration.bindWorker(s.run.id, oldWorkerId, 'stale-session', 'stale-terminal'), /current/);
  s.app.orchestration.failLaunch(s.run.id, oldWorkerId, 'late old launch failure');
  assert.equal(lead.workerId, replacementId); assert.equal(lead.status, 'running'); assert.ok(s.app.orchestration.authenticate(replacementToken));
  const freshGate = await s.request(s.route('gate'), { confirm: true }); assert.equal(freshGate.exitCode, 0);
  assert.equal(s.app.orchestration.pair.gatesPassed(s.run), true); assert.equal(freshGate.integrationId, amended.integrationId);
});

test('handoff rejects busy, active-peer, exhausted-attempt and stale-tree contexts without revoking the lead', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  const leads = s.run.assignments.filter(a => a.role === 'orchestrator'), lead = leads.find(a => a.provider === 'codex'), peer = leads.find(a => a.id !== lead.id);
  const oldToken = await s.launch(lead); await s.request(s.route('integrate'));
  const input = { confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: lead.id, workerId: lead.workerId, provider: 'claude', model: 'claude-opus-4-8', effort: 'high' };

  s.app.orchestration.pair.busy.add(s.run.id);
  assert.equal((await s.request(s.route('handoff'), input)).status, 400); s.app.orchestration.pair.busy.delete(s.run.id);
  await s.launch(peer);
  assert.equal((await s.request(s.route('handoff'), input)).status, 400);
  const peerWorker = s.run.workers.find(w => w.id === peer.workerId), peerTerminal = peerWorker.terminalId;
  peerWorker.revokedAt = new Date().toISOString(); peer.status = 'ready'; peer.workerId = null; peer.sessionId = null; s.app.terminals.close(peerTerminal);

  const attempts = lead.attempt; lead.attempt = s.run.policy.maxAttempts;
  assert.equal((await s.request(s.route('handoff'), input)).status, 400); lead.attempt = attempts;
  writeFileSync(join(s.run.integrationCwd, 'backend/handler.mjs'), '// stale integration tree\n');
  assert.equal((await s.request(s.route('handoff'), input)).status, 400); assert.equal(s.run.paired.state, 'needs-human');
  assert.ok(s.app.orchestration.authenticate(oldToken)); assert.equal(lead.workerId, input.workerId); assert.equal(lead.provider, 'codex');
});

test('restart-interrupted orchestrator can amend a current integration with no live worker', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  const lead = s.run.assignments.find(a => a.role === 'orchestrator' && a.provider === 'codex');
  const oldToken = await s.launch(lead); await s.request(s.route('integrate'));
  const previous = { approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, snapshotIds: [...s.run.integration.snapshotIds], treeHash: s.run.integration.treeHash };
  const restored = new OrchestrationStore(s.fixture.stateDir), run = restored.run(s.run.id), interruptedLead = run.assignments.find(a => a.id === lead.id);
  s.app.terminals.items.delete(s.run.workers.find(w => w.id === lead.workerId).terminalId);
  assert.equal(run.paired.state, 'interrupted'); assert.equal(interruptedLead.status, 'interrupted'); assert.equal(interruptedLead.workerId, lead.workerId); assert.equal(restored.authenticate(oldToken), null);
  const amended = restored.pair.handoff(run, { confirm: true, approvalHash: previous.approvalHash, integrationId: previous.integrationId, assignmentId: interruptedLead.id, workerId: interruptedLead.workerId, provider: 'claude', model: 'claude-opus-4-8', effort: 'high' });
  assert.notEqual(amended.approvalHash, previous.approvalHash); assert.notEqual(amended.integrationId, previous.integrationId);
  assert.deepEqual(run.integration.snapshotIds, previous.snapshotIds); assert.equal(run.integration.treeHash, previous.treeHash); assert.equal(run.paired.state, 'awaiting-gates');
  const persisted = new OrchestrationStore(s.fixture.stateDir).run(run.id); assert.equal(persisted.paired.approvalHash, amended.approvalHash); assert.equal(persisted.integration.id, amended.integrationId);
});

test('handoff rolls back completely when its durable audit append fails', async t => {
  const s = await setup(t); await s.approve(); await s.submitDevelopers();
  const lead = s.run.assignments.find(a => a.role === 'orchestrator' && a.provider === 'codex'), oldToken = await s.launch(lead);
  await s.request(s.route('integrate'));
  const before = structuredClone(s.run), eventCount = s.app.orchestration.data.events.length, append = s.app.orchestration.append;
  s.app.orchestration.append = () => { throw Error('fixture persistence failure'); };
  assert.throws(() => s.app.orchestration.pair.handoff(s.run, { confirm: true, approvalHash: before.paired.approvalHash, integrationId: before.integration.id, assignmentId: lead.id, workerId: lead.workerId, provider: 'claude', model: 'claude-opus-4-8', effort: 'high' }), /persistence failure/);
  s.app.orchestration.append = append;
  assert.deepEqual(s.run, before); assert.equal(s.app.orchestration.data.events.length, eventCount); assert.ok(s.app.orchestration.authenticate(oldToken));
});

test('failed replacement launch keeps the amendment and permits one explicit retry', async t => {
  let failReplacement = true;
  const s = await setup(t, { failSpawn: record => record.args.includes('claude-opus-4-8') && failReplacement && !(failReplacement = false) });
  await s.approve(); await s.submitDevelopers();
  const lead = s.run.assignments.find(a => a.role === 'orchestrator' && a.provider === 'codex');
  await s.launch(lead); await s.request(s.route('integrate'));
  const amended = await s.request(s.route('handoff'), { confirm: true, approvalHash: s.run.paired.approvalHash, integrationId: s.run.integration.id, assignmentId: lead.id, workerId: lead.workerId, provider: 'claude', model: 'claude-opus-4-8', effort: 'high' });
  assert.equal(amended.status, 200);
  assert.equal((await s.request(s.route('launch'), { assignmentId: lead.id })).status, 400);
  assert.equal(lead.status, 'ready'); assert.equal(lead.workerId, null); assert.equal(s.run.paired.approvalHash, amended.approvalHash); assert.equal(s.run.integration.id, amended.integrationId); assert.equal(s.app.orchestration.pair.currentSubmissions(s.run), true);
  const retryToken = await s.launch(lead); assert.ok(s.app.orchestration.authenticate(retryToken)); assert.equal(lead.status, 'running'); assert.equal(lead.attempt, s.run.policy.maxAttempts);
});
