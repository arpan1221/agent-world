import { createHash } from 'node:crypto';
import { WorkspaceManager } from './workspaces.mjs';
import { validateWorker } from './providers.mjs';
import { randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validators = new Set(['tester', 'reviewer', 'council']);
const stamp = () => new Date().toISOString();

export function approvalDigest(run) {
  const { base, contract, gates, protectedPaths } = run.paired;
  const ownership = Object.fromEntries(run.assignments.filter(a => a.role === 'developer').map(a => [a.lane, a.allowedPaths]));
  return digest({ objective: run.objective, cwd: run.cwd, base, policy: run.policy, contract, gates, protectedPaths, ownership: { frontend: ownership.frontend, backend: ownership.backend }, roster: run.assignments.map(a => ({ id: a.id, provider: a.provider, model: a.model, effort: a.effort, role: a.role, lens: a.lens, permission: a.permission, parentAssignmentId: a.parentAssignmentId })) });
}

function prefixes(values) {
  if (!Array.isArray(values) || !values.length || values.length > 20) throw Error('Choose 1–20 owned directories for each developer.');
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\/$/.test(value) || value.split('/').some(p => p === '..' || p === '.' || p === '.git') || value.includes('//')) throw Error('Ownership paths must be relative directory prefixes ending in /; no dot segments.');
    return value;
  }))].sort();
}

export function configurePair(run, input) {
  if (!input) return;
  const base = { ref: 'develop', remote: 'origin', refresh: true, ...input.base };
  if (typeof base.ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,119}$/.test(base.ref) || base.ref.includes('..') || base.ref.endsWith('/') || (base.remote !== null && (typeof base.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(base.remote))) || typeof base.refresh !== 'boolean' || base.refresh && !base.remote) throw Error('Base must name a branch, optional remote and explicit refresh policy.');
  const devs = run.assignments.filter(a => a.role === 'developer');
  if (devs.length !== 2 || !devs.some(a => a.provider === 'codex') || !devs.some(a => a.provider === 'claude')) throw Error('Paired mode requires exactly one Codex frontend and one Claude backend developer.');
  if (run.assignments.some(a => ['requirements', 'architect'].includes(a.role))) throw Error('For paired mode, put requirements and architecture in the approved contract, not source-writing planner assignments.');
  const frontend = prefixes(input.frontendPaths), backend = prefixes(input.backendPaths);
  if (frontend.some(a => backend.some(b => a.startsWith(b) || b.startsWith(a)))) throw Error('Frontend and backend ownership must not overlap. Shared files remain human-owned.');
  const contract = structuredClone(input.contract);
  if (!contract || !Array.isArray(contract.endpoints) || !contract.endpoints.length || contract.endpoints.length > 100 || !Array.isArray(contract.acceptance) || !contract.acceptance.length || contract.acceptance.some(v => typeof v !== 'string' || !v.trim())) throw Error('Contract needs endpoints and concrete acceptance criteria.');
  for (const e of contract.endpoints) if (!e || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(e.method) || typeof e.path !== 'string' || !e.path.startsWith('/') || !e.request || !e.response) throw Error('Each endpoint needs method, /path, request and response definitions.');
  if (JSON.stringify(contract).length > 16000) throw Error('Contract is too large.');
  if (!Array.isArray(input.gates) || !input.gates.length || input.gates.length > 8) throw Error('Approve 1–8 deterministic gates.');
  const gates = input.gates.map(g => {
    if (!g || typeof g.command !== 'string' || !/^[a-zA-Z0-9@_./+:-]{1,200}$/.test(g.command) || !Array.isArray(g.args) || g.args.length > 40 || g.args.some(a => typeof a !== 'string' || a.length > 1000)) throw Error('Gate requires an executable and an array of arguments.');
    return { command: g.command, args: [...g.args], timeoutMs: Math.min(300000, Math.max(1000, Number(g.timeoutMs) || 60000)) };
  });
  for (const a of devs) { a.lane = a.provider === 'codex' ? 'frontend' : 'backend'; a.allowedPaths = a.lane === 'frontend' ? frontend : backend; a.title = `${a.provider === 'codex' ? 'Codex' : 'Claude'} · ${a.lane}`; }
  const protectedPaths = input.protectedPaths || ['tests/', 'test/', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', '.github/'];
  if (!Array.isArray(protectedPaths) || protectedPaths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) throw Error('Protected evaluation paths must be relative.');
  run.paired = { base, contract, gates, protectedPaths, approvedAt: null, state: 'awaiting-approval' };
  run.paired.approvalHash = approvalDigest(run);
}

export class PairedExecution {
  constructor(dir, store) { this.store = store; this.workspaces = new WorkspaceManager(dir); this.busy = new Set(); }
  transition(run, state, detail) { run.paired.state = run.status = state; run.paired.detail = detail || null; run.updatedAt = stamp(); this.store.append(`paired.${state}`, 'broker', run.id, { detail, integrationId: run.integration?.id }); }
  recover() {
    for (const run of this.store.data.runs.filter(r => r.paired)) {
      let interrupted = ['provisioning', 'integrating', 'testing'].includes(run.paired.state);
      const ticketFor = (a, worker, endedAt) => {
        const sessionId = this.store.resolveResumeHandle?.({ worker, assignment: a, endedAt }) || null;
        return { nonce: randomUUID(), reason: 'broker-restart', attempt: a.attempt, priorWorkerId: worker.id, sessionId, provider: a.provider, model: a.model, effort: a.effort, permission: a.permission, workspace: a.workspace || run.integrationCwd, approvalHash: run.paired.approvalHash, integrationId: run.integration?.id || null, treeHash: run.integration?.treeHash || null, failures: 0, createdAt: endedAt };
      };
      for (const worker of run.workers.filter(w => !w.revokedAt)) {
        const endedAt = stamp(); worker.revokedAt = endedAt;
        const a = run.assignments.find(a => a.workerId === worker.id);
        if (a?.status === 'running') {
          a.restartTicket = ticketFor(a, worker, endedAt);
          a.status = a.restartTicket.sessionId ? 'resume-ready' : 'interrupted';
          interrupted = true;
        }
      }
      // Migrate state written by older brokers that converted a crash-interrupted,
      // already-bound worker to `ready` before exact-session tickets existed.
      for (const a of run.assignments.filter(a => a.status === 'ready' && a.attempt >= run.policy.maxAttempts && !a.restartTicket)) {
        const worker = run.workers.filter(w => w.assignmentId === a.id && w.revokedAt && w.terminalId && !w.completedAt && !w.exitedAt).at(-1);
        if (!worker) continue;
        const ticket = ticketFor(a, worker, worker.revokedAt); if (!ticket.sessionId) continue;
        a.restartTicket = ticket; a.status = 'resume-ready'; interrupted = true;
      }
      // A prior fail-closed recovery may have persisted a ticket before the user
      // authorized provider metadata access. Re-resolve only its pinned old worker.
      for (const a of run.assignments.filter(a => a.status === 'interrupted' && a.restartTicket?.reason === 'broker-restart' && !a.restartTicket.sessionId)) {
        const worker = run.workers.find(w => w.id === a.restartTicket.priorWorkerId);
        const sessionId = worker && this.store.resolveResumeHandle?.({ worker, assignment: a, endedAt: a.restartTicket.createdAt });
        if (!sessionId) continue;
        a.restartTicket.sessionId = sessionId; a.status = 'resume-ready'; interrupted = true;
      }
      if (interrupted && run.paired.state !== 'passed') this.transition(run, 'interrupted', 'Broker restarted; old credentials revoked. Inspect retained worktrees and explicitly recover.');
      else this.store.save();
    }
  }
  approve(run, hash) {
    if (!run.paired || run.paired.approvedAt || run.paired.state !== 'awaiting-approval') throw Error('Run is not awaiting contract approval.');
    if (hash !== run.paired.approvalHash) throw Error('Approval hash does not match the displayed contract, ownership, gates and roster.');
    this.transition(run, 'provisioning');
    try { this.workspaces.provision(run); run.paired.approvedAt = stamp(); this.transition(run, 'ready'); }
    catch (e) { this.transition(run, 'provision-failed', e.message); throw e; }
    return this.store.snapshot().runs.find(r => r.id === run.id);
  }
  recoverRun(run) {
    if (!run.paired?.approvedAt || !['interrupted', 'gate-failed', 'integration-conflict', 'ownership-violation', 'challenged', 'needs-human'].includes(run.paired.state)) throw Error('This run cannot be automatically recovered. Provisioning failures need inspection and a new run.');
    if (run.workers.some(w => !w.revokedAt && w.role !== 'orchestrator')) throw Error('Stop active implementation/review workers before recovery.');
    if (run.paired.state === 'gate-failed') for (const a of run.assignments.filter(a => a.role === 'developer' && a.status === 'submitted')) a.status = 'challenged';
    for (const a of run.assignments) {
      if (a.role === 'orchestrator' && a.status === 'interrupted') a.status = a.restartTicket?.sessionId ? 'resume-ready' : 'ready';
      if (a.role === 'developer' && ['interrupted', 'challenged', 'needs-human', 'ownership-violation'].includes(a.status)) {
        const brokerResume = a.status === 'interrupted' && a.restartTicket?.sessionId && a.restartTicket.attempt === a.attempt;
        if (!brokerResume && a.attempt >= run.policy.maxAttempts) throw Error('Attempt budget exhausted; create a new approved continuation run.');
        a.status = brokerResume ? 'resume-ready' : 'ready';
      }
      if (validators.has(a.role)) a.status = 'blocked';
    }
    if (run.integration) run.integration.invalidatedAt = stamp();
    this.transition(run, run.assignments.filter(a => a.role === 'developer').every(a => a.status === 'submitted') ? 'submitted' : 'ready');
  }
  handoff(run, input) {
    if (input.confirm !== true || !run.paired?.approvedAt) throw Error('Explicit human approval is required for handoff.');
    if (this.busy.has(run.id) || !['awaiting-gates', 'awaiting-review', 'interrupted'].includes(run.paired.state)) throw Error('Handoff requires a quiescent integrated run.');
    const assignment = run.assignments.find(a => a.id === input.assignmentId && a.role === 'orchestrator');
    if (!assignment || assignment.permission !== 'read-only') throw Error('Select a read-only orchestrator.');
    if (input.approvalHash !== run.paired.approvalHash || input.integrationId !== run.integration?.id || input.workerId !== assignment.workerId) throw Error('Handoff context changed; refresh approval, integration and worker.');
    if (approvalDigest(run) !== run.paired.approvalHash) throw Error('Approved roster or contract drifted; handoff is refused.');
    if (assignment.attempt >= run.policy.maxAttempts) throw Error('Orchestrator attempt budget exhausted.');
    if (!run.assignments.filter(a => a.role === 'developer').every(a => a.status === 'submitted') || run.workers.some(w => !w.revokedAt && w.assignmentId !== assignment.id)) throw Error('All developers must submit and other workers must stop before handoff.');
    const replacement = validateWorker({ provider: input.provider, model: input.model, effort: input.effort, role: 'orchestrator' });
    if (replacement.provider === assignment.provider && replacement.model === assignment.model && replacement.effort === assignment.effort) throw Error('Choose a different orchestrator configuration.');
    this.assertCurrent(run);
    const original = structuredClone(run), eventCount = this.store.data.events.length;
    const at = stamp(), previous = { provider: assignment.provider, model: assignment.model, effort: assignment.effort, workerId: assignment.workerId, sessionId: assignment.sessionId, approvalHash: run.paired.approvalHash, integrationId: run.integration.id };
    const terminalIds = run.workers.filter(w => w.assignmentId === assignment.id && w.terminalId).map(w => w.terminalId);
    for (const worker of run.workers.filter(w => w.assignmentId === assignment.id)) worker.revokedAt ||= at;
    Object.assign(assignment, replacement, { status: 'ready', workerId: null, sessionId: null });
    run.paired.approvalHash = approvalDigest(run); run.paired.approvedAt = at;
    run.integration = { ...run.integration, id: randomUUID(), predecessorId: previous.integrationId, contractHash: run.paired.approvalHash };
    delete run.dockerStack;
    for (const a of run.assignments.filter(a => validators.has(a.role))) { a.status = 'blocked'; a.workerId = null; a.sessionId = null; }
    const record = { at, assignmentId: assignment.id, previous, replacement, approvalHash: run.paired.approvalHash, integrationId: run.integration.id, treeHash: run.integration.treeHash };
    (run.handoffs ||= []).push(record);
    run.status = run.paired.state = 'awaiting-gates'; run.paired.detail = 'Human-approved orchestrator handoff; unchanged source requires fresh gates and reviews.'; run.updatedAt = at;
    try { this.store.append('orchestrator.handoff', 'user', run.id, record); }
    catch (error) {
      for (const key of Object.keys(run)) delete run[key];
      Object.assign(run, original); this.store.data.events.splice(eventCount);
      throw error;
    }
    return { assignmentId: assignment.id, terminalIds, approvalHash: run.paired.approvalHash, integrationId: run.integration.id, treeHash: run.integration.treeHash };
  }
  reassignDeveloper(run, input) {
    if (input.confirm !== true || !run.paired?.approvedAt) throw Error('Explicit human approval is required for developer reassignment.');
    if (this.busy.has(run.id) || !['submitted', 'awaiting-gates', 'awaiting-review', 'interrupted'].includes(run.paired.state)) throw Error('Developer reassignment requires a quiescent submitted integration.');
    const assignment = run.assignments.find(a => a.id === input.assignmentId && a.role === 'developer');
    if (!assignment || assignment.status !== 'submitted') throw Error('Select a submitted developer.');
    if (input.approvalHash !== run.paired.approvalHash || input.integrationId !== run.integration?.id || input.workerId !== assignment.workerId || input.submissionId !== assignment.submissionId || input.targetAttempt !== assignment.attempt) throw Error('Reassignment context changed; refresh the run before approving.');
    if (approvalDigest(run) !== run.paired.approvalHash) throw Error('Approved roster or contract drifted; reassignment is refused.');
    if (assignment.attempt >= run.policy.maxAttempts) throw Error('Developer attempt budget exhausted.');
    if (run.workers.some(w => !w.revokedAt && run.assignments.find(a => a.id === w.assignmentId)?.role !== 'orchestrator')) throw Error('Stop active implementation and validation workers before reassignment.');
    const replacement = validateWorker({ provider: assignment.provider, model: input.model, effort: input.effort, role: 'developer' });
    if (replacement.permission !== assignment.permission) throw Error('Developer reassignment cannot change lane or permission.');
    if (replacement.model === assignment.model && replacement.effort === assignment.effort) throw Error('Choose a different developer model or effort.');
    this.assertCurrent(run);
    const original = structuredClone(run), eventCount = this.store.data.events.length, at = stamp();
    const previous = { provider: assignment.provider, model: assignment.model, effort: assignment.effort, workerId: assignment.workerId, sessionId: assignment.sessionId, submissionId: assignment.submissionId, attempt: assignment.attempt, approvalHash: run.paired.approvalHash, integrationId: run.integration.id };
    const terminalIds = [];
    for (const worker of run.workers.filter(w => w.assignmentId === assignment.id)) { worker.revokedAt ||= at; if (worker.terminalId) terminalIds.push(worker.terminalId); }
    Object.assign(assignment, replacement, { status: 'challenged', workerId: null, sessionId: null });
    run.integration.invalidatedAt = at; delete run.dockerStack;
    for (const item of run.assignments.filter(a => validators.has(a.role))) {
      const worker = run.workers.find(w => w.id === item.workerId);
      if (worker) { worker.revokedAt ||= at; if (worker.terminalId) terminalIds.push(worker.terminalId); }
      item.status = 'blocked'; item.workerId = null; item.sessionId = null;
    }
    for (const item of run.assignments.filter(a => a.role === 'orchestrator' && a.status === 'interrupted')) { item.status = 'ready'; item.workerId = null; item.sessionId = null; }
    run.paired.approvalHash = approvalDigest(run); run.paired.approvedAt = at;
    const record = { at, assignmentId: assignment.id, previous, replacement, approvalHash: run.paired.approvalHash, invalidatedIntegrationId: run.integration.id, treeHash: run.integration.treeHash };
    (run.reassignments ||= []).push(record);
    run.status = run.paired.state = 'challenged'; run.paired.detail = 'Human-approved developer reassignment; a new implementation capture, integration, gates and reviews are required.'; run.updatedAt = at;
    try { this.store.append('developer.reassigned', 'user', run.id, record); }
    catch (error) {
      for (const key of Object.keys(run)) delete run[key];
      Object.assign(run, original); this.store.data.events.splice(eventCount);
      throw error;
    }
    return { assignmentId: assignment.id, terminalIds: [...new Set(terminalIds)], approvalHash: run.paired.approvalHash, invalidatedIntegrationId: run.integration.id, treeHash: run.integration.treeHash };
  }
  assertLaunch(run, assignment) {
    if (!run.paired) return;
    if (!run.paired.approvedAt || ['provision-failed', 'interrupted', 'needs-human', 'passed'].includes(run.paired.state)) throw Error('Approve/provision or recover this paired run before launching.');
    if (this.busy.has(run.id)) throw Error('Integration or gates are running.');
    if (validators.has(assignment.role)) { this.assertCurrent(run); if (!this.gatesPassed(run)) throw Error('Independent validation waits for the pinned integration gates.'); }
  }
  cwd(run, assignment) { return run.paired ? assignment.role === 'developer' ? assignment.workspace : run.integrationCwd : run.cwd; }
  context(run) { return run.paired ? { contract: run.paired.contract, approvalHash: run.paired.approvalHash, base: run.paired.base, baseRef: run.baseRef, baseCommit: run.baseCommit, integration: run.integration, pairedState: run.paired.state, gates: run.paired.gates, handoffs: structuredClone(run.handoffs || []), reassignments: structuredClone(run.reassignments || []), coordinationHistory: structuredClone(run.handoffs?.length || run.reassignments?.length ? run.messages.slice(-100) : []) } : {}; }
  capture(run, assignment) {
    try {
      const captured = this.workspaces.capture(run, assignment);
      if (captured.files.some(f => run.paired.protectedPaths.some(p => p.endsWith('/') ? f.path.startsWith(p) : f.path === p) || /(^|\/)package(?:-lock)?\.json$/.test(f.path))) throw Error('Evaluation paths and package manifests are human-owned; their changes cannot be submitted.');
      return captured;
    }
    catch (e) { assignment.status = 'ownership-violation'; const worker = run.workers.find(w => w.id === assignment.workerId); if (worker) worker.revokedAt = stamp(); this.transition(run, 'ownership-violation', e.message); throw e; }
  }
  integrate(run) {
    if (!run.paired?.approvedAt || this.busy.has(run.id)) throw Error('Run is not approved or is busy.');
    if (!run.assignments.filter(a => a.role === 'developer').every(a => a.status === 'submitted')) throw Error('Both developers must submit before integration.');
    if (this.currentSubmissions(run)) { this.assertCurrent(run); return structuredClone(run.integration); }
    if (run.assignments.some(a => validators.has(a.role) && a.status === 'running')) throw Error('Stop active validators before replacing their integration.');
    this.transition(run, 'integrating');
    try {
      run.integration = this.workspaces.integrate(run);
      run.integration.contractHash = run.paired.approvalHash;
      run.integration.treeHash = this.workspaces.treeHash(run);
      for (const a of run.assignments.filter(a => validators.has(a.role))) { a.status = 'blocked'; a.workerId = null; }
      this.transition(run, 'awaiting-gates'); return structuredClone(run.integration);
    } catch (e) { this.transition(run, 'integration-conflict', e.message); throw e; }
  }
  assertCurrent(run) {
    if (!this.currentSubmissions(run)) throw Error('Integrate the current approved submissions first; previous gates are stale.');
    if (this.workspaces.treeHash(run) !== run.integration.treeHash) { this.transition(run, 'needs-human', 'Integration files changed after capture; gates and reviews are stale.'); throw Error('Integration snapshot is stale.'); }
  }
  gatesPassed(run) {
    if (!this.currentSubmissions(run)) return false;
    return run.paired.gates.every((_, i) => { const check = run.checks.filter(c => c.integrationId === run.integration.id && c.gateIndex === i).at(-1); return check?.exitCode === 0 && !check.timedOut && check.treeHash === run.integration.treeHash; });
  }
  currentSubmissions(run) {
    if (!run.integration || run.integration.invalidatedAt || run.integration.contractHash !== run.paired.approvalHash) return false;
    const devs = run.assignments.filter(a => a.role === 'developer');
    if (!devs.every(a => ['submitted', 'accepted'].includes(a.status))) return false;
    const ids = devs.map(a => run.submissions.find(s => s.id === a.submissionId)?.snapshot?.id).sort();
    return ids.every(Boolean) && JSON.stringify(ids) === JSON.stringify([...(run.integration.snapshotIds || [])].sort());
  }
  async gates(run, runner) {
    if (!run.paired?.approvedAt || this.busy.has(run.id) || run.paired.state === 'passed') throw Error('Run is not approved, is busy, or already passed.');
    this.assertCurrent(run); this.busy.add(run.id); this.transition(run, 'testing');
    try {
      for (const [gateIndex, spec] of run.paired.gates.entries()) {
        const result = await runner({ ...spec, cwd: run.integrationCwd });
        this.assertCurrent(run);
        this.store.recordCheck(run.id, { ...result, command: spec.command, args: spec.args, integrationId: run.integration.id, treeHash: run.integration.treeHash, gateIndex });
        if (result.exitCode !== 0 || result.timedOut) { this.transition(run, 'gate-failed', 'Fix the implementation in its owned worktree and submit a new attempt.'); return run.checks.at(-1); }
      }
      this.transition(run, 'awaiting-review'); this.store.advance(run); this.store.save(); return run.checks.at(-1);
    } catch (e) { if (run.paired.state !== 'needs-human') this.transition(run, 'gate-failed', e.message); throw e; }
    finally { this.busy.delete(run.id); }
  }
}

export { validators };
