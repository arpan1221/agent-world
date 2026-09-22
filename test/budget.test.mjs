import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestrationStore } from '../src/orchestration.mjs';
import { DEFAULT_CATALOG } from '../src/cost.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'agent-world-budget-'));

// Reusable 7-role roster (incl. 5-lens council) so createRun's role/council
// requirements are always satisfied regardless of what budget behavior a
// given test is exercising. Priced deliberately expensive (claude/opus etc.)
// so budget-enforcement tests have real headroom to violate.
const roster = [
  { provider: 'claude', model: 'opus', effort: 'high', role: 'orchestrator' },
  { provider: 'claude', model: 'opus', effort: 'high', role: 'requirements' },
  { provider: 'claude', model: 'opus', effort: 'high', role: 'architect' },
  { provider: 'claude', model: 'sonnet', effort: 'high', role: 'developer' },
  { provider: 'codex', model: 'gpt-6-astra', effort: 'high', role: 'tester' },
  { provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high', role: 'reviewer' },
  { provider: 'claude', model: 'opus', effort: 'high', role: 'council', count: 5 }
];

const tierOf = (provider, model) => DEFAULT_CATALOG.find(e => e.provider === provider && e.model === model)?.tier;

function makeRun(store, cwd, extra = {}) {
  return store.createRun({ objective: 'Ship the budgeted feature', cwd, roster, ...extra });
}

test('parseBudget validation: bad unit, non-positive limit, absent budget, routing.escalate', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  assert.throws(() => makeRun(store, cwd, { budget: { unit: 'bogus', limit: 5 } }), /Budget unit must be one of/);
  assert.throws(() => makeRun(store, cwd, { budget: { unit: 'usd', limit: 0 } }), /Budget limit must be a positive number/);
  assert.throws(() => makeRun(store, cwd, { budget: { unit: 'usd', limit: -1 } }), /Budget limit must be a positive number/);

  const noBudget = makeRun(store, cwd);
  assert.equal(noBudget.policy.budget, null);
  assert.equal(noBudget.policy.routing.escalate, true);

  const escalateOff = makeRun(store, cwd, { routing: { escalate: false } });
  assert.equal(escalateOff.policy.routing.escalate, false);
});

test('autoRoute assigns light roles to local, heavy roles to frontier, developer to cloud', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const run = makeRun(store, cwd, { budget: { unit: 'usd', limit: 5 }, autoRoute: true });

  for (const role of ['requirements', 'tester', 'orchestrator']) {
    for (const a of run.assignments.filter(x => x.role === role)) {
      assert.equal(tierOf(a.provider, a.model), 'local', `${role} assignment ${a.id} should route to a local-tier model, got ${a.provider}:${a.model}`);
    }
  }
  for (const role of ['architect', 'reviewer', 'council']) {
    for (const a of run.assignments.filter(x => x.role === role)) {
      assert.equal(tierOf(a.provider, a.model), 'frontier', `${role} assignment ${a.id} should route to a frontier-tier model, got ${a.provider}:${a.model}`);
    }
  }
  for (const a of run.assignments.filter(x => x.role === 'developer')) {
    assert.equal(tierOf(a.provider, a.model), 'cloud', `developer assignment ${a.id} should route to a cloud-tier model, got ${a.provider}:${a.model}`);
  }
});

test('autoRoute diversity: validators never share a model with the developer they validate', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const run = makeRun(store, cwd, { budget: { unit: 'usd', limit: 5 }, autoRoute: true });

  const devModels = new Set(run.assignments.filter(a => a.role === 'developer').map(a => `${a.provider}:${a.model}`));
  for (const a of run.assignments.filter(x => ['tester', 'reviewer', 'council'].includes(x.role))) {
    assert.ok(!devModels.has(`${a.provider}:${a.model}`), `${a.role} assignment ${a.id} (${a.provider}:${a.model}) collides with a developer model`);
  }
});

test('autoRoute fails closed when the budget cannot staff every role', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  // 11 total assignments (1 orchestrator + 1 requirements + 1 architect + 1
  // developer + 1 tester + 1 reviewer + 5 council). Use unit:'agents', where
  // workerCost is always exactly 1 regardless of tier/model -- unlike 'usd',
  // where local-tier entries are always $0 and an absurdly small usd limit
  // would still succeed (asserted below as the complementary case). A limit
  // well below 11 guarantees applyRouting cannot staff every assignment and
  // must throw at createRun (fail closed, not partially routed).
  assert.throws(
    () => makeRun(store, cwd, { budget: { unit: 'agents', limit: 3 }, autoRoute: true }),
    /too low to staff/
  );

  // Complementary case, documented above: with unit 'usd' and a vanishingly
  // small limit, autoRoute still SUCCEEDS, because every light role routes to
  // a local ($0) entry and the run only needs to cover the few
  // cloud/frontier-tier roles (developer, architect, reviewer, council) --
  // this is why 'agents'/'tokens' (not 'usd') is the unit that actually
  // exercises the fail-closed throw against local's free tier.
  const cwd2 = temp(), store2 = new OrchestrationStore(cwd2);
  const tinyUsd = makeRun(store2, cwd2, { budget: { unit: 'usd', limit: 0.0001 }, autoRoute: true });
  for (const a of tinyUsd.assignments.filter(x => ['requirements', 'tester', 'orchestrator'].includes(x.role))) {
    assert.equal(tierOf(a.provider, a.model), 'local');
  }
});

test('budget enforcement blocks issueWorker and escalates the run to needs-human', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const created = makeRun(store, cwd, { budget: { unit: 'usd', limit: 0.0001 } }); // no autoRoute: keep the pricey claude/opus roster
  const run = store.run(created.id);
  const requirements = run.assignments.find(a => a.role === 'requirements');
  assert.equal(requirements.status, 'ready');

  assert.throws(() => store.issueWorker(run.id, requirements.id, 'session-budget-1'), /Budget limit reached/);
  assert.equal(run.status, 'needs-human');

  const escalated = store.data.events.find(e => e.runId === run.id && e.type === 'run.escalated' && e.payload.reason === 'budget-exhausted');
  assert.ok(escalated, 'expected a run.escalated/budget-exhausted event to be recorded');
  assert.equal(escalated.payload.assignmentId, requirements.id);
});

test('spent accumulates and the issued worker carries its recorded cost/usage', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const created = makeRun(store, cwd, { budget: { unit: 'agents', limit: 10 } });
  const run = store.run(created.id);
  const requirements = run.assignments.find(a => a.role === 'requirements');
  assert.equal(requirements.status, 'ready');
  assert.equal(run.policy.budget.spent, 0);

  const issued = store.issueWorker(run.id, requirements.id, 'session-budget-2');
  assert.equal(run.policy.budget.spent, 1); // agents unit: exactly 1 per worker launch
  assert.equal(issued.worker.cost, 1);
  assert.equal(issued.worker.usage.unit, 'agents');
  assert.equal(typeof issued.worker.usage.estimated.tokens, 'number');
  assert.equal(issued.worker.usage.actual, null);
});

test('a challenged developer is escalated up a tier, avoiding its validators\' models, on reissue', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const created = makeRun(store, cwd, { budget: { unit: 'usd', limit: 5 }, autoRoute: true });
  const run = store.run(created.id);
  const developer = run.assignments.find(a => a.role === 'developer');
  const validators = run.assignments.filter(a => ['tester', 'reviewer', 'council'].includes(a.role) && a.targetIds.includes(developer.id));
  const validatorModels = new Set(validators.map(a => `${a.provider}:${a.model}`));

  const beforeTier = tierOf(developer.provider, developer.model);
  assert.equal(beforeTier, 'cloud'); // autoRoute puts developer at cloud before any escalation
  const beforeModel = `${developer.provider}:${developer.model}`;

  // Drive the developer into 'challenged' directly on the live run object --
  // reaching this via a real review round-trip is exercised elsewhere
  // (test/orchestration.test.mjs); here we only need issueWorker's
  // escalation branch, which keys off assignment.status === 'challenged'.
  developer.status = 'challenged';

  const issued = store.issueWorker(run.id, developer.id, 'session-budget-3');
  const afterModel = `${developer.provider}:${developer.model}`;
  const afterTier = tierOf(developer.provider, developer.model);

  assert.notEqual(afterModel, beforeModel);
  assert.equal(afterTier, 'frontier'); // one step up from 'cloud'
  assert.ok(!validatorModels.has(afterModel), 'escalated developer model must still differ from its validators\' models');
  assert.equal(issued.worker.provider, developer.provider);
  assert.equal(issued.worker.model, developer.model);

  const rerouted = store.data.events.find(e => e.runId === run.id && e.type === 'assignment.rerouted' && e.payload.assignmentId === developer.id);
  assert.ok(rerouted, 'expected an assignment.rerouted event');
  assert.equal(rerouted.payload.from, beforeModel);
  assert.equal(rerouted.payload.to, afterModel);
  assert.equal(rerouted.payload.reason, 'escalation');
});

test('no-budget runs still issue workers and record observability cost with the default usd meter', () => {
  const cwd = temp(), store = new OrchestrationStore(cwd);
  const created = makeRun(store, cwd); // no budget field at all
  const run = store.run(created.id);
  assert.equal(run.policy.budget, null);
  const requirements = run.assignments.find(a => a.role === 'requirements');

  const issued = store.issueWorker(run.id, requirements.id, 'session-budget-4');
  assert.notEqual(run.status, 'needs-human');
  assert.equal(typeof issued.worker.cost, 'number');
  assert.ok(issued.worker.cost > 0); // claude/opus is priced, so estimated usd cost is nonzero
  assert.equal(issued.worker.usage.unit, 'usd');
});

test('budget escalation never mutates a human-approved PAIRED roster (Council send-back regression)', async () => {
  // A paired run's roster is pinned in paired.approvalHash; a model change there must
  // go through the human-gated reassignDeveloper, NOT an automatic budget escalation.
  const { createPairedFixture } = await import('../scripts/paired-fixture.mjs');
  const fx = createPairedFixture();
  const store = new OrchestrationStore(fx.stateDir);
  const run = store.createRun({ ...fx.input, budget: { unit: 'usd', limit: 100 } });
  const live = store.run(run.id);
  assert.ok(live.paired, 'fixture creates a paired run');
  assert.deepEqual(live.policy.budget, { unit: 'usd', limit: 100, spent: 0 });
  const dev = live.assignments.find(a => a.role === 'developer' && a.provider === 'codex');
  const before = `${dev.provider}:${dev.model}`;
  // Drive it into the escalation trigger and reach issueWorker (bypassing only the
  // paired approval/launch gate, which is orthogonal to the escalation guard).
  dev.status = 'challenged'; dev.attempt = 1; dev.workspace = fx.stateDir;
  store.pair.assertLaunch = () => {};
  try { store.issueWorker(run.id, dev.id, 'session-x'); } catch { /* launch gating is not what we assert */ }
  const after = store.run(run.id).assignments.find(a => a.id === dev.id);
  assert.equal(`${after.provider}:${after.model}`, before, 'paired developer model must NOT be auto-escalated');
  assert.equal(store.data.events.filter(e => e.type === 'assignment.rerouted').length, 0, 'no reroute event for a paired run');
});
