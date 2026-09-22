import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalytics } from '../src/analytics.mjs';
import { DEFAULT_CATALOG } from '../src/cost.mjs';

// --- 1. empty input ----------------------------------------------------------

test('computeAnalytics() with no arguments returns all-zero/empty output without throwing', () => {
  const result = computeAnalytics();
  assert.deepEqual(result.totals, {
    runs: 0,
    workers: 0,
    live: 0,
    sessions: 0,
    looseSessions: 0,
    estTokens: 0,
    spendByUnit: { usd: 0, tokens: 0, agents: 0 }
  });
  assert.deepEqual(result.byProvider, []);
  assert.deepEqual(result.byRole, []);
  assert.deepEqual(result.byTier, []);
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.recent, []);
});

test('computeAnalytics({ runs: [], terminals: [] }) matches the no-argument default', () => {
  const result = computeAnalytics({ runs: [], terminals: [] });
  assert.deepEqual(result.totals, {
    runs: 0,
    workers: 0,
    live: 0,
    sessions: 0,
    looseSessions: 0,
    estTokens: 0,
    spendByUnit: { usd: 0, tokens: 0, agents: 0 }
  });
  assert.deepEqual(result.byProvider, []);
  assert.deepEqual(result.byRole, []);
  assert.deepEqual(result.byTier, []);
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.recent, []);
});

// --- 2. totals -----------------------------------------------------------------

test('totals: workers, live, estTokens, and spendByUnit (summed per unit, not cross-summed) all aggregate correctly', () => {
  const w1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's1', cost: 0.5, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 1000 }, unit: 'usd' } }; // live
  const w2 = { provider: 'gemini', model: 'gemini-2.5-pro', role: 'reviewer', sessionId: 's2', cost: 2, createdAt: '2026-01-02T00:00:00.000Z', revokedAt: '2026-01-02T01:00:00.000Z', usage: { estimated: { tokens: 2000 }, unit: 'usd' } }; // revoked -> not live
  const w3 = { provider: 'claude', model: 'opus', role: 'architect', sessionId: 's3', cost: 3, createdAt: '2026-01-03T00:00:00.000Z', exitedAt: '2026-01-03T01:00:00.000Z', usage: { estimated: { tokens: 500 }, unit: 'agents' } }; // exited -> not live

  const run = { id: 'run-totals', objective: 'obj', status: 'running', policy: { budget: { unit: 'usd', limit: 10 } }, workers: [w1, w2, w3] };
  const terminals = [
    { sessionId: 's1', provider: 'claude' },
    { sessionId: 'term-x', provider: 'codex' }
  ];

  const result = computeAnalytics({ runs: [run], terminals });

  assert.deepEqual(result.totals, {
    runs: 1,
    workers: 3,
    live: 1,
    sessions: 2, // terminals.length
    looseSessions: 1, // 'term-x' has no matching worker sessionId
    estTokens: 3500, // 1000 + 2000 + 500
    spendByUnit: { usd: 2.5, tokens: 0, agents: 3 } // usd worker(s) grouped separately from the agents worker
  });
});

// --- 3. byProvider ---------------------------------------------------------------

test('byProvider: groups workers across providers with correct counts, live, estTokens, spend, per-provider sessions, sorted by estTokens desc', () => {
  const w1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 'sess-1', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 1000 }, unit: 'usd' } }; // live
  const w2 = { provider: 'claude', model: 'opus', role: 'reviewer', sessionId: 'sess-2', cost: 2, createdAt: '2026-01-02T00:00:00.000Z', revokedAt: '2026-01-02T01:00:00.000Z', usage: { estimated: { tokens: 3000 }, unit: 'usd' } }; // not live
  const w3 = { provider: 'gemini', model: 'gemini-2.5-pro', role: 'architect', sessionId: 'sess-3', cost: 5, createdAt: '2026-01-03T00:00:00.000Z', usage: { estimated: { tokens: 2000 }, unit: 'usd' } }; // live

  const run = { id: 'run-provider', workers: [w1, w2, w3] };
  const terminals = [
    { sessionId: 'sess-1', provider: 'claude' },
    { sessionId: 'term-loose-claude', provider: 'claude' },
    { sessionId: 'sess-3', provider: 'gemini' },
    { sessionId: 'term-loose-codex', provider: 'codex' } // provider with no workers at all
  ];

  const result = computeAnalytics({ runs: [run], terminals });

  // claude: estTokens 1000+3000=4000 > gemini's 2000, so claude must sort first.
  assert.deepEqual(result.byProvider, [
    { key: 'claude', workers: 2, live: 1, estTokens: 4000, spend: { usd: 3, tokens: 0, agents: 0 }, sessions: 2 },
    { key: 'gemini', workers: 1, live: 1, estTokens: 2000, spend: { usd: 5, tokens: 0, agents: 0 }, sessions: 1 }
  ]);
});

// --- 4. byRole and byTier ----------------------------------------------------------

test('byRole groups by role, and byTier buckets via entryFor (local/frontier catalog hits, cloud fallback for an unknown model)', () => {
  const localEntry = DEFAULT_CATALOG.find(e => e.tier === 'local');
  const frontierEntry = DEFAULT_CATALOG.find(e => e.tier === 'frontier');

  const wLocal = { provider: localEntry.provider, model: localEntry.model, role: 'tester', sessionId: 's-local', cost: 400, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 800 }, unit: 'tokens' } };
  const wFrontier = { provider: frontierEntry.provider, model: frontierEntry.model, role: 'architect', sessionId: 's-frontier', cost: 1, createdAt: '2026-01-02T00:00:00.000Z', usage: { estimated: { tokens: 6000 }, unit: 'usd' } };
  const wCloudFallback = { provider: 'mystery-provider', model: 'made-up-model', role: 'developer', sessionId: 's-cloud', cost: 2, createdAt: '2026-01-03T00:00:00.000Z', usage: { estimated: { tokens: 1500 }, unit: 'usd' } }; // not in catalog -> entryFor fallback tier 'cloud'

  const run = { id: 'run-tier', workers: [wLocal, wFrontier, wCloudFallback] };
  const result = computeAnalytics({ runs: [run], terminals: [] });

  // Sorted desc by estTokens: architect(6000) > developer(1500) > tester(800).
  assert.deepEqual(result.byRole, [
    { key: 'architect', workers: 1, live: 1, estTokens: 6000, spend: { usd: 1, tokens: 0, agents: 0 } },
    { key: 'developer', workers: 1, live: 1, estTokens: 1500, spend: { usd: 2, tokens: 0, agents: 0 } },
    { key: 'tester', workers: 1, live: 1, estTokens: 800, spend: { usd: 0, tokens: 400, agents: 0 } }
  ]);

  assert.deepEqual(result.byTier, [
    { key: 'frontier', workers: 1, live: 1, estTokens: 6000, spend: { usd: 1, tokens: 0, agents: 0 } },
    { key: 'cloud', workers: 1, live: 1, estTokens: 1500, spend: { usd: 2, tokens: 0, agents: 0 } },
    { key: 'local', workers: 1, live: 1, estTokens: 800, spend: { usd: 0, tokens: 400, agents: 0 } }
  ]);
});

test('workers missing provider/role are grouped under the "unknown" key', () => {
  const w = { model: 'mystery-model', sessionId: 's-unknown', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 10 }, unit: 'usd' } };
  const result = computeAnalytics({ runs: [{ id: 'run-unknown', workers: [w] }], terminals: [] });
  assert.equal(result.byProvider.length, 1);
  assert.equal(result.byProvider[0].key, 'unknown');
  assert.equal(result.byRole.length, 1);
  assert.equal(result.byRole[0].key, 'unknown');
});

// --- 5. live vs terminated ---------------------------------------------------------

test('live vs terminated: exited and revoked workers count in workers/estTokens/spend but not in live, at both totals and group level', () => {
  const wExited = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-exit', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', exitedAt: '2026-01-01T02:00:00.000Z', usage: { estimated: { tokens: 100 }, unit: 'usd' } };
  const wRevoked = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-revoke', cost: 2, createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-01-01T01:00:00.000Z', usage: { estimated: { tokens: 200 }, unit: 'usd' } };
  const wLive = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-live', cost: 3, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 300 }, unit: 'usd' } };

  const result = computeAnalytics({ runs: [{ id: 'run-live', workers: [wExited, wRevoked, wLive] }], terminals: [] });

  assert.equal(result.totals.workers, 3);
  assert.equal(result.totals.live, 1);
  assert.equal(result.totals.estTokens, 600);
  assert.deepEqual(result.totals.spendByUnit, { usd: 6, tokens: 0, agents: 0 });

  assert.equal(result.byProvider.length, 1);
  assert.deepEqual(result.byProvider[0], { key: 'claude', workers: 3, live: 1, estTokens: 600, spend: { usd: 6, tokens: 0, agents: 0 }, sessions: 0 });
});

// --- 6. loose terminals ------------------------------------------------------------

test('loose terminals: sessions with no matching worker sessionId are looseSessions; matching ones are not; totals.sessions counts all terminals', () => {
  const w1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's1', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 10 }, unit: 'usd' } };
  const w2 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's2', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 10 }, unit: 'usd' } };
  const terminals = [
    { sessionId: 's1', provider: 'claude' }, // matches w1 -> not loose
    { sessionId: 's2', provider: 'claude' }, // matches w2 -> not loose
    { sessionId: 'other-1', provider: 'claude' }, // loose
    { sessionId: 'other-2', provider: 'gemini' } // loose
  ];

  const result = computeAnalytics({ runs: [{ id: 'run-loose', workers: [w1, w2] }], terminals });

  assert.equal(result.totals.sessions, 4);
  assert.equal(result.totals.looseSessions, 2);
});

// --- 7. run rollup -----------------------------------------------------------------

test('runs: one rollup entry per input run with {id, objective, status, budget, workers, live, estTokens, spend}; budget is null when policy.budget is absent', () => {
  const wA1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 'a1', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 100 }, unit: 'usd' } }; // live
  const wA2 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 'a2', cost: 2, createdAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-01-01T01:00:00.000Z', usage: { estimated: { tokens: 200 }, unit: 'usd' } }; // not live
  const runA = { id: 'run-a', objective: 'Build X', status: 'running', policy: { budget: { unit: 'usd', limit: 50 } }, workers: [wA1, wA2] };

  const wB1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 'b1', cost: 3, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 300 }, unit: 'agents' } }; // live
  const runB = { id: 'run-b', objective: 'Build Y', status: 'completed', workers: [wB1] }; // no `policy` at all

  const result = computeAnalytics({ runs: [runA, runB], terminals: [] });

  assert.deepEqual(result.runs, [
    { id: 'run-a', objective: 'Build X', status: 'running', budget: { unit: 'usd', limit: 50 }, workers: 2, live: 1, estTokens: 300, spend: { usd: 3, tokens: 0, agents: 0 } },
    { id: 'run-b', objective: 'Build Y', status: 'completed', budget: null, workers: 1, live: 1, estTokens: 300, spend: { usd: 0, tokens: 0, agents: 3 } }
  ]);
});

// --- 8. recent -----------------------------------------------------------------------

test('recent: newest-first by createdAt, mapped to {at, provider, role, model, cost, unit, live}', () => {
  const wOld = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-old', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 10 }, unit: 'usd' } };
  const wNew = { provider: 'gemini', model: 'gemini-2.5-pro', role: 'architect', sessionId: 's-new', cost: 3, createdAt: '2026-01-03T00:00:00.000Z', revokedAt: '2026-01-03T01:00:00.000Z', usage: { estimated: { tokens: 30 }, unit: 'agents' } };
  const wMid = { provider: 'claude', model: 'opus', role: 'reviewer', sessionId: 's-mid', cost: 2, createdAt: '2026-01-02T00:00:00.000Z', usage: { estimated: { tokens: 20 }, unit: 'usd' } };

  // Input order deliberately scrambled to prove computeAnalytics sorts, not passes through.
  const result = computeAnalytics({ runs: [{ id: 'run-recent', workers: [wOld, wNew, wMid] }], terminals: [] });

  assert.deepEqual(result.recent, [
    { at: wNew.createdAt, provider: 'gemini', role: 'architect', model: 'gemini-2.5-pro', cost: 3, unit: 'agents', live: false },
    { at: wMid.createdAt, provider: 'claude', role: 'reviewer', model: 'opus', cost: 2, unit: 'usd', live: true },
    { at: wOld.createdAt, provider: 'claude', role: 'developer', model: 'sonnet', cost: 1, unit: 'usd', live: true }
  ]);
});

test('recent: caps at 20 entries even with 25 workers, keeping the 20 newest', () => {
  const workers = Array.from({ length: 25 }, (_, i) => ({
    provider: 'claude',
    model: 'sonnet',
    role: 'developer',
    sessionId: `s-${i}`,
    cost: 1,
    createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, // i=0 oldest ... i=24 newest
    usage: { estimated: { tokens: 10 }, unit: 'usd' }
  }));

  const result = computeAnalytics({ runs: [{ id: 'run-cap', workers }], terminals: [] });

  assert.equal(result.recent.length, 20);
  assert.equal(result.recent[0].at, '2026-01-01T00:24:00.000Z'); // newest (i=24)
  assert.equal(result.recent[19].at, '2026-01-01T00:05:00.000Z'); // 20th newest (i=5); i=0..4 dropped
});

// --- 9. unit fallback ----------------------------------------------------------------

test('unit fallback: missing or invalid usage.unit is metered as usd', () => {
  const wMissingUnitField = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-a', cost: 1, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 100 } } }; // usage present, no .unit
  const wInvalidUnit = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-b', cost: 2, createdAt: '2026-01-01T00:01:00.000Z', usage: { estimated: { tokens: 50 }, unit: 'euros' } }; // unrecognized unit string
  const wNoUsageAtAll = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's-c', cost: 3, createdAt: '2026-01-01T00:02:00.000Z' }; // no usage key at all

  const result = computeAnalytics({ runs: [{ id: 'run-unit', workers: [wMissingUnitField, wInvalidUnit, wNoUsageAtAll] }], terminals: [] });

  assert.deepEqual(result.totals.spendByUnit, { usd: 6, tokens: 0, agents: 0 });
  assert.equal(result.totals.estTokens, 150); // 100 + 50 + 0 (missing tokens -> 0, no throw)
  assert.ok(result.recent.every(r => r.unit === 'usd'));
});

// --- 10. determinism -------------------------------------------------------------------

test('determinism: the same input produces deep-equal output across repeated calls', () => {
  const w1 = { provider: 'claude', model: 'sonnet', role: 'developer', sessionId: 's1', cost: 1.25, createdAt: '2026-01-01T00:00:00.000Z', usage: { estimated: { tokens: 100 }, unit: 'usd' } };
  const w2 = { provider: 'gemini', model: 'gemini-2.5-pro', role: 'architect', sessionId: 's2', cost: 2, createdAt: '2026-01-02T00:00:00.000Z', revokedAt: '2026-01-02T01:00:00.000Z', usage: { estimated: { tokens: 200 }, unit: 'agents' } };
  const w3 = { model: 'made-up-model', role: 'tester', sessionId: 's3', cost: 3, createdAt: '2026-01-03T00:00:00.000Z', usage: { estimated: { tokens: 300 } } };

  const runs = [
    { id: 'run-det-1', objective: 'A', status: 'running', policy: { budget: { unit: 'usd', limit: 5 } }, workers: [w1, w2] },
    { id: 'run-det-2', objective: 'B', status: 'completed', workers: [w3] }
  ];
  const terminals = [{ sessionId: 's1', provider: 'claude' }, { sessionId: 'loose', provider: 'codex' }];

  const first = computeAnalytics({ runs, terminals });
  const second = computeAnalytics({ runs, terminals });

  assert.deepEqual(first, second);
});
