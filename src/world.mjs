import { basename } from 'node:path';
export const BIOMES = { frontend: 'Frontend Plains', backend: 'Backend Caverns', etl: 'ETL Mines', integration: 'Integration Rails', data: 'Data Bedrock', ops: 'Ops Watchtower', wilds: 'The Wilds', remote: 'The End' };
export function biomeOfNode(n) {
  if (BIOMES[n.biome]) return n.biome;
  const s = `${n.cwd || ''} ${n.branch || ''} ${n.quest || ''}`.toLowerCase();
  for (const [key, rx] of [['frontend', /frontend|react|website|css|design/], ['etl', /\betl\b|ingest|pipeline|crawler/], ['data', /database|postgres|schema|migration/], ['ops', /deploy|docker|infra|ci\/|devops/], ['integration', /integrat|webhook|oauth/], ['backend', /backend|server|\bapi\b/]]) if (rx.test(s)) return key;
  return 'wilds';
}
export function toWorld(topology, state, terminals = [], orchestration = { runs: [] }) {
  const importedByName = new Map(terminals.filter(t => t.sessionId?.startsWith('tmux:') && t.name).map(t => [t.name, t]));
  const aliases = new Map();
  const visibleNodes = topology.nodes.filter(n => {
    const imported = n.live && n.inTmux ? importedByName.get(n.name) : null;
    if (!imported) return true;
    aliases.set(n.id, imported.sessionId);
    return false;
  });
  const sessions = visibleNodes.map(n => ({ sessionId: n.id, name: n.name || basename(n.cwd || '') || n.id.slice(0, 8), quest: n.quest || '', biome: biomeOfNode(n), status: n.status === 'self' ? 'active' : n.status, live: n.live, cwd: n.cwd, branch: n.branch, actAgeMin: n.ageMinutes, lastPreview: n.lastPreview, lastRole: n.lastRole, inTmux: n.inTmux, entrypoint: n.entrypoint, source: 'local' }));
  for (const terminal of terminals) { let s = sessions.find(s => s.sessionId === terminal.sessionId); if (!s) { s = { sessionId: terminal.sessionId, name: terminal.name, biome: terminal.biome || 'wilds', cwd: terminal.cwd, quest: terminal.quest || '', status: 'idle', live: true, source: 'local' }; sessions.push(s); } Object.assign(s, { managed: true, provider: terminal.provider || 'claude', model: terminal.model, role: terminal.role, workerId: terminal.workerId, runId: terminal.runId }); }
  // Finished work remains visible even if its old transcript is removed.
  for (const task of state.tasks) { const sessionId = aliases.get(task.sessionId) || task.sessionId; if (sessionId && !sessions.some(s => s.sessionId === sessionId)) sessions.push({ sessionId, name: 'Archived builder', biome: task.biome || 'wilds', cwd: task.cwd, status: 'dormant', live: false, source: 'archive' }); }
  for (const run of orchestration.runs || []) for (const assignment of run.assignments || []) if (assignment.sessionId && !sessions.some(s => s.sessionId === assignment.sessionId)) sessions.push({ sessionId: assignment.sessionId, name: assignment.title, biome: assignment.role === 'developer' ? 'wilds' : 'ops', cwd: run.cwd, status: assignment.status === 'challenged' ? 'stuck' : assignment.status === 'accepted' ? 'converged' : 'dormant', live: false, source: 'orchestration', provider: assignment.provider, model: assignment.model, role: assignment.role, workerId: assignment.workerId, runId: run.id });
  for (const run of orchestration.runs || []) if (run.paired) for (const a of run.assignments) {
    const session = sessions.find(s => s.sessionId === a.sessionId); if (!session) continue;
    session.biome = a.lane || (a.role === 'orchestrator' ? 'ops' : 'integration'); session.name = a.title; session.cwd = a.workspace || run.integrationCwd;
    session.status = a.status === 'accepted' && run.status === 'passed' ? 'converged' : ['challenged', 'interrupted', 'ownership-violation', 'needs-human'].includes(a.status) ? 'stuck' : a.status === 'running' ? 'active' : session.live ? 'idle' : 'dormant';
  }
  const biomes = Object.entries(BIOMES).map(([key, label]) => { const list = sessions.filter(s => s.biome === key); return { key, label, sessionIds: list.map(s => s.sessionId), count: list.length, live: list.filter(s => s.live).length }; }).filter(b => b.count);
  const byStatus = {}; for (const s of sessions) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  const workerSession = new Map(); for (const run of orchestration.runs || []) for (const worker of run.workers || []) if (worker.sessionId) workerSession.set(worker.id, worker.sessionId);
  const brokerEdges = []; for (const run of orchestration.runs || []) for (const message of run.messages || []) { const from = workerSession.get(message.fromWorkerId), to = workerSession.get(message.toWorkerId); if (from && to && from !== to) brokerEdges.push({ from, to, count: 1, kind: 'broker-message', messageId: message.id }); }
  const orchestrationTasks = []; for (const run of orchestration.runs || []) for (const a of run.assignments || []) if (a.sessionId) orchestrationTasks.push({ id: `orchestration-${a.id}`, title: a.title, sessionId: a.sessionId, cwd: run.cwd, biome: a.lane || (a.role === 'developer' ? 'wilds' : 'ops'), stage: a.status === 'accepted' && run.status === 'passed' ? 'completed' : ['challenged', 'interrupted', 'ownership-violation', 'needs-human'].includes(a.status) ? 'blocked' : ['running', 'submitted', 'accepted'].includes(a.status) ? 'building' : 'planned', source: 'orchestration', role: a.role, runId: run.id });
  const edges = topology.edges.map(edge => ({ ...edge, from: aliases.get(edge.from) || edge.from, to: aliases.get(edge.to) || edge.to }));
  const tasks = state.tasks.map(task => aliases.has(task.sessionId) ? { ...task, sessionId: aliases.get(task.sessionId) } : task);
  return { generatedAt: topology.generatedAt, host: topology.host, self: { sessionId: 'world-overlord', name: 'You' }, sessions, nodes: visibleNodes, edges: [...edges, ...brokerEdges], biomes, stats: { total: sessions.length, live: sessions.filter(s => s.live).length, byStatus }, tasks: [...tasks, ...orchestrationTasks], notifications: state.notifications, revision: state.revision };
}
export function demoTopology() {
  const nodes = Object.keys(BIOMES).slice(0, 7).flatMap((b, i) => Array.from({ length: i === 0 ? 5 : 3 }, (_, j) => ({ id: `00000000-0000-4000-8000-${String(i * 10 + j + 1).padStart(12, '0')}`, name: `${b}-builder-${j + 1}`, biome: b, cwd: `/demo/${b}`, quest: `${b} project`, live: j < 2, status: j === 0 ? 'active' : j === 1 ? 'stuck' : 'converged', ageMinutes: j * 12, inTmux: false })));
  return { nodes, edges: nodes.slice(1, 9).map((n, i) => ({ from: nodes[0].id, to: n.id, count: i + 1, kind: 'message' })), host: 'Demo settlement', generatedAt: new Date().toISOString() };
}
