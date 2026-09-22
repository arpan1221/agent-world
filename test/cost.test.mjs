import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../src/providers.mjs';
import { TIERS, DEFAULT_CATALOG, tierIndex, estimateTokens, workerCost, withinBudget, routeAssignment } from '../src/cost.mjs';

const findEntry = (tier, model) => DEFAULT_CATALOG.find(e => e.tier === tier && e.model === model);
const localLlama = findEntry('local', 'ollama/llama3.3');
const localQwenCoder = findEntry('local', 'ollama/qwen2.5-coder');
const frontierGemini = findEntry('frontier', 'gemini-2.5-pro');
const frontierClaudeSonnet = findEntry('frontier', 'sonnet');
const cloudQwenFlash = findEntry('cloud', 'qwen3-coder-flash');

// --- 1. catalog integrity -------------------------------------------------

test('every DEFAULT_CATALOG entry references a real provider + effort registered in PROVIDERS', () => {
  // This re-asserts, from the test side, what cost.mjs already self-checks at
  // import time (see the loop right after DEFAULT_CATALOG) -- a belt-and-braces
  // guard so a future catalog edit that skips that check still gets caught here.
  for (const entry of DEFAULT_CATALOG) {
    const provider = PROVIDERS[entry.provider];
    assert.ok(provider, `entry ${entry.provider}:${entry.model} references unknown provider '${entry.provider}'`);
    assert.ok(provider.efforts.includes(entry.effort), `entry ${entry.provider}:${entry.model} uses effort '${entry.effort}' not valid for '${entry.provider}'`);
  }
});

test('every DEFAULT_CATALOG entry has a valid tier and non-negative numeric prices', () => {
  for (const entry of DEFAULT_CATALOG) {
    assert.ok(TIERS.includes(entry.tier), `entry ${entry.provider}:${entry.model} has unknown tier '${entry.tier}'`);
    assert.equal(typeof entry.priceIn, 'number');
    assert.equal(typeof entry.priceOut, 'number');
    assert.ok(entry.priceIn >= 0, `entry ${entry.provider}:${entry.model} has negative priceIn`);
    assert.ok(entry.priceOut >= 0, `entry ${entry.provider}:${entry.model} has negative priceOut`);
  }
});

test('every local-tier DEFAULT_CATALOG entry is priced at exactly $0 in and out', () => {
  const localEntries = DEFAULT_CATALOG.filter(e => e.tier === 'local');
  assert.ok(localEntries.length > 0, 'expected at least one local entry to check');
  for (const entry of localEntries) {
    assert.equal(entry.priceIn, 0, `local entry ${entry.provider}:${entry.model} must have priceIn === 0`);
    assert.equal(entry.priceOut, 0, `local entry ${entry.provider}:${entry.model} must have priceOut === 0`);
  }
});

test('DEFAULT_CATALOG has at least one entry per tier', () => {
  for (const tier of TIERS) {
    assert.ok(DEFAULT_CATALOG.some(e => e.tier === tier), `no catalog entry for tier '${tier}'`);
  }
});

// --- tierIndex (small exported helper used throughout routeAssignment) ----

test('tierIndex maps TIERS to their position and throws on an unknown tier', () => {
  assert.equal(tierIndex('local'), 0);
  assert.equal(tierIndex('cloud'), 1);
  assert.equal(tierIndex('frontier'), 2);
  assert.throws(() => tierIndex('nope'), /Unknown tier/);
});

// --- 2. estimateTokens ------------------------------------------------------

test('estimateTokens returns the documented per-role estimate', () => {
  assert.equal(estimateTokens('orchestrator'), 40000);
  assert.equal(estimateTokens('requirements'), 30000);
  assert.equal(estimateTokens('architect'), 60000);
  assert.equal(estimateTokens('developer'), 120000);
  assert.equal(estimateTokens('tester'), 50000);
  assert.equal(estimateTokens('reviewer'), 50000);
  assert.equal(estimateTokens('council'), 25000);
});

test('estimateTokens defaults to 40000 for an unrecognized role', () => {
  assert.equal(estimateTokens('some-future-role'), 40000);
  assert.equal(estimateTokens(undefined), 40000);
});

// --- 3. workerCost -----------------------------------------------------------

test("workerCost unit 'agents' is always exactly 1, regardless of role or entry", () => {
  assert.equal(workerCost({ role: 'developer', entry: frontierGemini, unit: 'agents' }), 1);
  assert.equal(workerCost({ role: 'architect', entry: localLlama, unit: 'agents' }), 1);
  assert.equal(workerCost({ role: 'council', entry: cloudQwenFlash, unit: 'agents' }), 1);
});

test("workerCost unit 'tokens' matches estimateTokens(role), independent of the entry", () => {
  assert.equal(workerCost({ role: 'developer', entry: frontierGemini, unit: 'tokens' }), estimateTokens('developer'));
  assert.equal(workerCost({ role: 'tester', entry: localLlama, unit: 'tokens' }), estimateTokens('tester'));
  assert.equal(workerCost({ role: 'council', entry: cloudQwenFlash, unit: 'tokens' }), estimateTokens('council'));
});

test("workerCost unit 'usd' matches the documented 70/30 input/output split against a known cloud entry", () => {
  // developer -> estimateTokens = 120000; cloudQwenFlash priceIn=0.3, priceOut=1.2 ($/M tokens).
  const total = 120000;
  const expected = ((total * 0.7) / 1e6) * cloudQwenFlash.priceIn + ((total * 0.3) / 1e6) * cloudQwenFlash.priceOut;
  assert.ok(Math.abs(expected - 0.0684) < 1e-9, 'sanity check on the hand-derived expected value');
  const actual = workerCost({ role: 'developer', entry: cloudQwenFlash, unit: 'usd' });
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
});

test("workerCost unit 'usd' matches the documented 70/30 split against a known frontier entry", () => {
  // architect -> estimateTokens = 60000; frontierGemini priceIn=1.25, priceOut=10 ($/M tokens).
  const total = 60000;
  const expected = ((total * 0.7) / 1e6) * frontierGemini.priceIn + ((total * 0.3) / 1e6) * frontierGemini.priceOut;
  assert.ok(Math.abs(expected - 0.2325) < 1e-9, 'sanity check on the hand-derived expected value');
  const actual = workerCost({ role: 'architect', entry: frontierGemini, unit: 'usd' });
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
});

test("workerCost unit 'usd' is exactly 0 for a local ($0/$0) entry, for any role", () => {
  assert.equal(workerCost({ role: 'developer', entry: localLlama, unit: 'usd' }), 0);
  assert.equal(workerCost({ role: 'architect', entry: localQwenCoder, unit: 'usd' }), 0);
});

test('workerCost throws on an unrecognized unit', () => {
  assert.throws(() => workerCost({ role: 'developer', entry: cloudQwenFlash, unit: 'euros' }), /Unknown budget unit/);
});

// --- 4. withinBudget -----------------------------------------------------------

test('withinBudget is true strictly under the limit and false strictly over it', () => {
  assert.equal(withinBudget({ spent: 0, cost: 4, limit: 5 }), true);
  assert.equal(withinBudget({ spent: 0, cost: 6, limit: 5 }), false);
});

test('withinBudget is true exactly at the limit (inclusive)', () => {
  assert.equal(withinBudget({ spent: 0, cost: 5, limit: 5 }), true);
  assert.equal(withinBudget({ spent: 2, cost: 3, limit: 5 }), true);
});

test('withinBudget accounts for spent-so-far, not just cost alone', () => {
  assert.equal(withinBudget({ spent: 4, cost: 2, limit: 5 }), false);
  assert.equal(withinBudget({ spent: 4, cost: 1, limit: 5 }), true);
});

test('withinBudget is always true when limit is null or Infinity', () => {
  assert.equal(withinBudget({ spent: 1e9, cost: 1e9, limit: null }), true);
  assert.equal(withinBudget({ spent: 1e9, cost: 1e9, limit: Infinity }), true);
  assert.equal(withinBudget({ cost: 1e9, limit: undefined }), true);
});

test('withinBudget defaults spent to 0 when omitted', () => {
  assert.equal(withinBudget({ cost: 5, limit: 5 }), true);
  assert.equal(withinBudget({ cost: 6, limit: 5 }), false);
});

// --- 5. routeAssignment: desired tier by role (no escalation, ample remaining) ---

test('routeAssignment sends architect, council, and reviewer to a frontier-tier entry', () => {
  for (const role of ['architect', 'council', 'reviewer']) {
    const entry = routeAssignment({ role, unit: 'usd', remaining: Infinity });
    assert.equal(entry.tier, 'frontier', `role '${role}' expected frontier tier, got '${entry?.tier}'`);
  }
});

test('routeAssignment sends requirements, tester, and orchestrator to a local-tier entry', () => {
  for (const role of ['requirements', 'tester', 'orchestrator']) {
    const entry = routeAssignment({ role, unit: 'usd', remaining: Infinity });
    assert.equal(entry.tier, 'local', `role '${role}' expected local tier, got '${entry?.tier}'`);
  }
});

test('routeAssignment sends developer (unrecognized/default role) to a cloud-tier entry', () => {
  const entry = routeAssignment({ role: 'developer', unit: 'usd', remaining: Infinity });
  assert.equal(entry.tier, 'cloud');
});

test('routeAssignment picks the cheapest entry within the desired tier: developer -> qwen3-coder-flash', () => {
  // Hand-computed: qwen3-coder-flash is the cheapest cloud entry for a developer's
  // 120000-token estimate ($0.0684), see the workerCost 'usd' test above.
  const entry = routeAssignment({ role: 'developer', unit: 'usd', remaining: Infinity });
  assert.equal(entry.provider, 'qwen');
  assert.equal(entry.model, 'qwen3-coder-flash');
});

test('routeAssignment picks the cheapest entry within the desired tier: architect -> gemini-2.5-pro', () => {
  // Hand-computed: gemini-2.5-pro is the cheapest frontier entry for an architect's
  // 60000-token estimate ($0.2325) -- lowest priceIn AND priceOut of all frontier entries.
  const entry = routeAssignment({ role: 'architect', unit: 'usd', remaining: Infinity });
  assert.equal(entry.provider, 'gemini');
  assert.equal(entry.model, 'gemini-2.5-pro');
});

// --- 6. escalation -----------------------------------------------------------

test('escalation: a challenged developer routes to a higher tier (frontier) than a normal developer (cloud)', () => {
  const normal = routeAssignment({ role: 'developer', unit: 'usd', remaining: Infinity });
  const challenged = routeAssignment({ role: 'developer', challenged: true, unit: 'usd', remaining: Infinity });
  assert.equal(normal.tier, 'cloud');
  assert.equal(challenged.tier, 'frontier');
  assert.ok(tierIndex(challenged.tier) > tierIndex(normal.tier));
});

test('escalation: a developer on attempt > 0 (rework, not flagged challenged) also escalates to frontier', () => {
  const entry = routeAssignment({ role: 'developer', attempt: 1, challenged: false, unit: 'usd', remaining: Infinity });
  assert.equal(entry.tier, 'frontier');
});

test('escalation: an already-frontier role (architect) stays frontier when escalated, it does not overflow', () => {
  const entry = routeAssignment({ role: 'architect', challenged: true, attempt: 1, unit: 'usd', remaining: Infinity });
  assert.equal(entry.tier, 'frontier');
});

test('escalation: escalate=false disables escalation even when challenged/attempt say otherwise', () => {
  const entry = routeAssignment({ role: 'developer', challenged: true, attempt: 1, escalate: false, unit: 'usd', remaining: Infinity });
  assert.equal(entry.tier, 'cloud');
});

// --- 7. budget-aware downgrade -----------------------------------------------

test('budget-aware downgrade: a tester (desired local) with ample remaining stays local', () => {
  const entry = routeAssignment({ role: 'tester', unit: 'usd', remaining: 1 });
  assert.equal(entry.tier, 'local');
});

test('budget-aware downgrade: an architect steps down from frontier to cloud when remaining is below the cheapest frontier cost but above the cheapest cloud cost', () => {
  // Cheapest frontier for architect (gemini-2.5-pro) costs $0.2325; cheapest cloud
  // for architect (qwen3-coder-flash) costs $0.0342 (both hand-computed from the
  // catalog's priceIn/priceOut against estimateTokens('architect') = 60000). A
  // remaining budget of $0.1 sits strictly between the two.
  const remaining = 0.1;
  const entry = routeAssignment({ role: 'architect', unit: 'usd', remaining });
  assert.equal(entry.tier, 'cloud');
  assert.equal(entry.provider, 'qwen');
  assert.equal(entry.model, 'qwen3-coder-flash');
});

test('budget-aware downgrade: an architect falls all the way to a local $0 entry when remaining is 0', () => {
  const entry = routeAssignment({ role: 'architect', unit: 'usd', remaining: 0 });
  assert.equal(entry.tier, 'local');
  assert.equal(workerCost({ role: 'architect', entry, unit: 'usd' }), 0);
});

// --- 8. diversity avoid --------------------------------------------------------

test('diversity avoid: avoided provider:model entries are never returned for a frontier role', () => {
  // The overall cheapest frontier pick (gemini-2.5-pro) is untouched by this avoid
  // list, so this alone would pass vacuously -- paired with the next test, which
  // forces a different pick by avoiding the actual cheapest entry.
  const entry = routeAssignment({ role: 'architect', avoid: ['claude:sonnet', 'claude:opus'], unit: 'usd', remaining: Infinity });
  assert.notEqual(`${entry.provider}:${entry.model}`, 'claude:sonnet');
  assert.notEqual(`${entry.provider}:${entry.model}`, 'claude:opus');
  assert.equal(entry.provider, 'gemini', 'sanity: the untouched cheapest pick is still gemini');
});

test('diversity avoid: avoiding the cheapest entry forces routeAssignment onto the next-cheapest one', () => {
  // Avoiding gemini-2.5-pro (the actual cheapest frontier pick for architect) must
  // force selection of the next cheapest, claude:sonnet ($0.396, tied with
  // cursor:sonnet-4-thinking but sorted first by compareEntries).
  const entry = routeAssignment({ role: 'architect', avoid: ['gemini:gemini-2.5-pro'], unit: 'usd', remaining: Infinity });
  assert.equal(entry.provider, 'claude');
  assert.equal(entry.model, 'sonnet');
});

test('diversity avoid: avoiding every catalog entry across every reachable tier down to local returns null', () => {
  const avoidEverything = DEFAULT_CATALOG.map(e => `${e.provider}:${e.model}`);
  const entry = routeAssignment({ role: 'architect', avoid: avoidEverything, unit: 'usd', remaining: Infinity });
  assert.equal(entry, null);
});

// --- 9. determinism ------------------------------------------------------------

test('determinism: the same routeAssignment call returns the identical entry both times', () => {
  const args = { role: 'developer', challenged: true, unit: 'usd', remaining: 5 };
  const first = routeAssignment(args);
  const second = routeAssignment(args);
  assert.deepEqual(first, second);
  // DEFAULT_CATALOG entries are singleton objects (never cloned by routeAssignment),
  // so a deterministic pick should also be the exact same object reference.
  assert.equal(first, second);
});

test("determinism: tied costs under unit 'agents' break stably toward the entry sorted first (provider, then model, then effort)", () => {
  // Both local entries cost exactly 1 agent, so the tie always resolves to
  // 'ollama/llama3.3' ('l' < 'q'), never 'ollama/qwen2.5-coder', across repeated calls.
  for (let i = 0; i < 5; i++) {
    const entry = routeAssignment({ role: 'tester', unit: 'agents', remaining: Infinity });
    assert.equal(entry.model, 'ollama/llama3.3');
  }
});

// --- 10. null/edge cases --------------------------------------------------------

test('a negative remaining budget returns null -- even a $0 local entry does not fit a negative budget', () => {
  const entry = routeAssignment({ role: 'tester', unit: 'usd', remaining: -0.01 });
  assert.equal(entry, null);
});

test('an empty catalog returns null for any role', () => {
  const entry = routeAssignment({ role: 'developer', catalog: [], unit: 'usd', remaining: Infinity });
  assert.equal(entry, null);
});
