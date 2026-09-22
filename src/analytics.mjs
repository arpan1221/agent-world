// Compute/cost observability aggregation for the analytics view.
//
// Pure + deterministic: takes the orchestration runs and the live terminal list
// (both already in the server snapshot) and rolls them up into the metrics the
// COMPUTE pane and the world HUD render. No I/O, no Date.now()/Math.random().
//
// The universal compute measure is ESTIMATED TOKENS (usage.estimated.tokens),
// which every worker carries regardless of its run's budget unit -- so totals are
// comparable across runs that budget in usd, tokens, or agents. Monetary/relative
// spend is reported PER UNIT (spendByUnit) since summing dollars with token counts
// would be meaningless. Cost is an estimate (no live telemetry); see cost.mjs.

import { DEFAULT_CATALOG, entryFor } from './cost.mjs';

const UNITS = ['usd', 'tokens', 'agents'];
const zeroSpend = () => ({ usd: 0, tokens: 0, agents: 0 });
const round = n => Math.round(n * 1e6) / 1e6; // tame float noise from usd sums

/** A worker is "live" while it has been neither revoked nor exited. */
function isLive(worker) {
  return !worker.revokedAt && !worker.exitedAt;
}

/** The budget unit a worker was metered in (falls back to usd, matching issueWorker). */
function unitOf(worker) {
  return UNITS.includes(worker.usage?.unit) ? worker.usage.unit : 'usd';
}

function addSpend(target, worker) {
  target[unitOf(worker)] += Number(worker.cost) || 0;
}

function finalizeSpend(spend) {
  return { usd: round(spend.usd), tokens: Math.round(spend.tokens), agents: Math.round(spend.agents) };
}

/** Roll runs + live terminals into compute/cost analytics.
 * @param {object[]} runs  orchestration runs (each with policy.budget + workers[])
 * @param {object[]} terminals  live app terminals (provider/role/sessionId)
 * @param {object[]} catalog  model catalog for tier lookup (defaults to DEFAULT_CATALOG)
 */
export function computeAnalytics({ runs = [], terminals = [], catalog = DEFAULT_CATALOG } = {}) {
  const workers = runs.flatMap(r => r.workers || []);
  const byProvider = new Map(), byRole = new Map(), byTier = new Map();
  const totalSpend = zeroSpend();
  let estTokens = 0, live = 0;

  const bump = (map, key, worker) => {
    const g = map.get(key) || { key, workers: 0, live: 0, estTokens: 0, spend: zeroSpend() };
    g.workers++; if (isLive(worker)) g.live++;
    g.estTokens += Number(worker.usage?.estimated?.tokens) || 0;
    addSpend(g.spend, worker);
    map.set(key, g);
  };

  for (const worker of workers) {
    if (isLive(worker)) live++;
    estTokens += Number(worker.usage?.estimated?.tokens) || 0;
    addSpend(totalSpend, worker);
    bump(byProvider, worker.provider || 'unknown', worker);
    bump(byRole, worker.role || 'unknown', worker);
    bump(byTier, entryFor(catalog, worker.provider, worker.model).tier, worker);
  }

  // Live terminals that aren't orchestration workers (e.g. hand-opened NEW SESSION
  // terminals) still represent compute in flight across CLIs -- count them by provider.
  const workerSessionIds = new Set(workers.map(w => w.sessionId).filter(Boolean));
  const looseTerminals = terminals.filter(t => !workerSessionIds.has(t.sessionId));
  const providerSessions = new Map();
  for (const t of terminals) providerSessions.set(t.provider || 'unknown', (providerSessions.get(t.provider || 'unknown') || 0) + 1);

  const finalizeGroups = map => [...map.values()]
    .map(g => ({ ...g, estTokens: Math.round(g.estTokens), spend: finalizeSpend(g.spend) }))
    .sort((a, b) => b.estTokens - a.estTokens || (a.key < b.key ? -1 : 1));

  const runRollup = runs.map(run => {
    const rw = run.workers || [], spend = zeroSpend();
    let est = 0, rlive = 0;
    for (const w of rw) { addSpend(spend, w); est += Number(w.usage?.estimated?.tokens) || 0; if (isLive(w)) rlive++; }
    return { id: run.id, objective: run.objective, status: run.status, budget: run.policy?.budget || null, workers: rw.length, live: rlive, estTokens: Math.round(est), spend: finalizeSpend(spend) };
  });

  // Most-recent worker launches, newest first, as a spawn/lifecycle log. createdAt is
  // an ISO string; string-sort is chronological for same-format ISO timestamps.
  const recent = [...workers]
    .filter(w => w.createdAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, 20)
    .map(w => ({ at: w.createdAt, provider: w.provider, role: w.role, model: w.model, cost: Number(w.cost) || 0, unit: unitOf(w), live: isLive(w) }));

  return {
    totals: {
      runs: runs.length,
      workers: workers.length,
      live,
      sessions: terminals.length,
      looseSessions: looseTerminals.length,
      estTokens: Math.round(estTokens),
      spendByUnit: finalizeSpend(totalSpend),
    },
    byProvider: finalizeGroups(byProvider).map(g => ({ ...g, sessions: providerSessions.get(g.key) || 0 })),
    byRole: finalizeGroups(byRole),
    byTier: finalizeGroups(byTier),
    runs: runRollup,
    recent,
  };
}
