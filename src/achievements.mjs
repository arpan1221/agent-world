import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const COMPONENTS = ['workshop', 'interface', 'service', 'database', 'pipeline', 'observatory', 'citadel', 'archive', 'blueprint', 'test-chamber', 'council'];
const roleType = { orchestrator: 'citadel', requirements: 'archive', architect: 'blueprint', developer: 'workshop', tester: 'test-chamber', reviewer: 'observatory', council: 'council' };

export function observedFacts(world) {
  const facts = [];
  for (const t of world.tasks || []) {
    if (t.source === 'orchestration') continue;
    const human = t.source === 'user' || t.completionAuthority === 'human';
    facts.push({ id: `task:${t.id}`, title: t.title, sessionId: t.sessionId || null, project: t.cwd || 'Local settlement', role: 'developer', kind: COMPONENTS.includes(t.component) ? t.component : 'workshop', status: t.stage === 'completed' && !human ? 'submitted' : t.stage, authority: human ? 'human' : 'observed', attempt: 0, dependencies: (t.dependsOn || []).map(id => `task:${id}`), evidence: [], reviews: [], gate: null });
  }
  for (const run of world.orchestration?.runs || []) for (const a of run.assignments || []) {
    const submission = (run.submissions || []).find(s => s.id === a.submissionId && s.attempt === a.attempt);
    const reviews = (run.verdicts || []).filter(v => (!run.paired || !run.integration?.invalidatedAt && v.integrationId === run.integration?.id) && v.targetAssignmentId === a.id && v.targetAttempt === a.attempt).map(v => ({ role: v.reviewerRole, lens: v.lens || null, verdict: v.verdict, findings: v.findings, workerId: v.workerId }));
    const check = (run.checks || []).filter(c => !run.paired || !run.integration?.invalidatedAt && c.integrationId === run.integration?.id).at(-1);
    facts.push({ id: `assignment:${a.id}`, title: a.title, sessionId: a.sessionId || null, project: run.cwd, runId: run.id, role: a.role, kind: a.lane === 'frontend' ? 'interface' : a.lane === 'backend' ? 'service' : roleType[a.role] || 'workshop', status: a.status === 'accepted' && run.status === 'passed' ? 'accepted' : a.status === 'accepted' ? 'submitted' : a.status, authority: 'broker', attempt: a.attempt, dependencies: (a.dependsOn || []).map(id => `assignment:${id}`), evidence: (submission?.artifacts || []).map(e => ({ path: e.path, sha256: e.sha256, bytes: e.bytes })), reviews, gate: check ? { id: check.id, exitCode: check.exitCode, timedOut: check.timedOut, hash: check.stdoutHash } : null });
  }
  return facts.sort((a, b) => a.id.localeCompare(b.id));
}

export class AchievementLedger {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); this.file = join(dir, 'achievements.json');
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, events: [] };
    if (this.data.version !== 1 || !Array.isArray(this.data.events)) throw Error('Unsupported achievement ledger; original file preserved.');
    let previousHash = 'GENESIS'; this.latest = new Map();
    for (const event of this.data.events) {
      const { hash, ...body } = event;
      if (body.previousHash !== previousHash || digest(body) !== hash) throw Error('Achievement ledger verification failed; original file preserved.');
      previousHash = hash; this.latest.set(event.fact.id, event.fact);
    }
  }
  observe(world) { return this.record(observedFacts(world), this.data.events.length ? 'observed' : 'imported'); }
  record(facts, origin = 'observed') {
    const events = [];
    for (const fact of facts) {
      if (JSON.stringify(this.latest.get(fact.id)) === JSON.stringify(fact)) continue;
      const body = { revision: this.data.events.length + 1, at: new Date().toISOString(), origin, previousHash: this.data.events.at(-1)?.hash || 'GENESIS', fact: structuredClone(fact) };
      const event = { ...body, hash: digest(body) }; this.data.events.push(event); this.latest.set(fact.id, event.fact); events.push(event);
    }
    if (events.length) { writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file); }
    return events;
  }
  history() { return this.data.events.map(e => ({ revision: e.revision, at: e.at, origin: e.origin, id: e.fact.id, title: e.fact.title, status: e.fact.status, hash: e.hash })); }
  at(revision = this.data.events.length) {
    if (!Number.isInteger(revision) || revision < 0 || revision > this.data.events.length) throw Error('Invalid world revision.');
    const facts = new Map();
    for (let i = 0; i < revision; i++) {
      const fact = this.data.events[i].fact, previous = facts.get(fact.id);
      const phase = { completed: 3, accepted: 3, submitted: 2, building: 1, running: 1, challenged: 1 }[fact.status] || 0;
      const builtPhase = fact.authority === 'demo' && fact.status === 'planned' ? 0 : Math.max(previous?.builtPhase || 0, phase);
      facts.set(fact.id, { ...fact, builtPhase });
    }
    return { revision, hash: this.data.events[revision - 1]?.hash || 'GENESIS', facts: [...facts.values()] };
  }
}
