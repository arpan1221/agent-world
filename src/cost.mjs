// Budget + model-routing foundation for mixed-model SDLC orchestration.
//
// Pure logic only: no I/O, no fs/network, no Date.now()/Math.random(). Every
// function here is deterministic given its inputs, which keeps routing
// decisions reproducible across runs and testable without mocking a clock.
//
// NO LIVE TELEMETRY EXISTS for per-worker token usage today, so token/usd
// costs are ESTIMATES from `estimateTokens` (a per-role heuristic), not
// measured spend. Once the orchestrator starts reconciling against each
// CLI's own usage logs (Claude Code's transcript, Codex's session JSONL,
// etc.), that reconciled data should replace/augment these estimates --
// this module's shape (workerCost taking a role + catalog entry) is meant
// to keep working unchanged when a real "measured" cost source is wired in
// alongside or instead of the estimate.

import { PROVIDERS } from './providers.mjs';

/** Cost/capability bands, cheapest-to-priciest. `local` runs on the user's
 * own hardware (always $0); `cloud` is cheaper hosted/open-source models;
 * `frontier` is top-capability, priciest models. Index order matters -- it's
 * the escalation/downgrade axis used by routeAssignment. */
export const TIERS = ['local', 'cloud', 'frontier'];

/** Indicative default price/model catalog. PRICES ARE INDICATIVE DEFAULTS
 * the user curates, not authoritative billing data -- provider list prices
 * change over time and vary by account/region. priceIn/priceOut are $ per
 * MILLION tokens (input/output respectively); local entries are always 0/0
 * since they run on the user's own hardware. Every `effort` below is valid
 * for its `provider` per PROVIDERS[provider].efforts (see src/providers.mjs);
 * every `model` passes providers.mjs's safeName check (validateWorker does
 * not require membership in PROVIDERS[provider].models -- that list is UI
 * suggestions, not an allowlist). */
export const DEFAULT_CATALOG = [
  // -- local ($0, runs on the user's own hardware via opencode + Ollama) --
  { provider: 'opencode', model: 'ollama/llama3.3', tier: 'local', effort: 'medium', priceIn: 0, priceOut: 0 },
  { provider: 'opencode', model: 'ollama/qwen2.5-coder', tier: 'local', effort: 'medium', priceIn: 0, priceOut: 0 },

  // -- cloud (cheaper hosted / open-weight models) --
  { provider: 'qwen', model: 'qwen3-coder-flash', tier: 'cloud', effort: 'low', priceIn: 0.3, priceOut: 1.2 },
  { provider: 'qwen', model: 'qwen3-coder-plus', tier: 'cloud', effort: 'medium', priceIn: 1, priceOut: 3 },
  { provider: 'opencode', model: 'openai/gpt-5.6-sol', tier: 'cloud', effort: 'medium', priceIn: 2, priceOut: 6 },
  { provider: 'grok', model: 'grok-4.5', tier: 'cloud', effort: 'medium', priceIn: 2, priceOut: 8 },
  { provider: 'cursor', model: 'gpt-5', tier: 'cloud', effort: 'medium', priceIn: 1.75, priceOut: 7 },

  // -- frontier (top capability, priciest) --
  { provider: 'claude', model: 'sonnet', tier: 'frontier', effort: 'high', priceIn: 3, priceOut: 15 },
  { provider: 'claude', model: 'opus', tier: 'frontier', effort: 'high', priceIn: 15, priceOut: 75 },
  { provider: 'codex', model: 'gpt-6-astra', tier: 'frontier', effort: 'high', priceIn: 5, priceOut: 15 },
  { provider: 'gemini', model: 'gemini-2.5-pro', tier: 'frontier', effort: 'high', priceIn: 1.25, priceOut: 10 },
  { provider: 'cursor', model: 'sonnet-4-thinking', tier: 'frontier', effort: 'high', priceIn: 3, priceOut: 15 }
];

// Fail loud at import time if a curated catalog entry drifts out of sync
// with providers.mjs (e.g. an effort renamed/removed upstream) rather than
// silently routing workers to a rejected effort.
for (const entry of DEFAULT_CATALOG) {
  const provider = PROVIDERS[entry.provider];
  if (!provider) throw Error(`cost.mjs: DEFAULT_CATALOG references unknown provider '${entry.provider}'.`);
  if (!provider.efforts.includes(entry.effort)) throw Error(`cost.mjs: DEFAULT_CATALOG entry ${entry.provider}:${entry.model} uses effort '${entry.effort}', not valid for '${entry.provider}' (${provider.efforts.join(', ')}).`);
}

/** Index of `tier` within TIERS (0 = local ... TIERS.length-1 = frontier).
 * Throws on an unknown tier so a typo fails loud instead of silently
 * comparing as -1. */
export function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  if (i === -1) throw Error(`Unknown tier '${tier}'. Expected one of: ${TIERS.join(', ')}.`);
  return i;
}

function tierAt(index) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, index))];
}

/** One step up the TIERS ladder toward frontier (frontier stays frontier). */
function escalateTier(tier) {
  return tierAt(tierIndex(tier) + 1);
}

/** One step down the TIERS ladder toward local (local stays local). */
function downgradeTier(tier) {
  return tierAt(tierIndex(tier) - 1);
}

// Roles whose work benefits most from top capability (design/judgment calls
// that are expensive to get wrong) default to frontier; roles that are cheap,
// high-volume, or largely mechanical default to local. Everything else
// (developer, and any role this module doesn't recognize) defaults to cloud
// as a middle ground.
const HEAVY_ROLES = new Set(['architect', 'council', 'reviewer']);
const LIGHT_ROLES = new Set(['requirements', 'tester', 'orchestrator']);

/** The tier a role should route to before any escalation is applied. */
export function desiredTier(role) {
  if (HEAVY_ROLES.has(role)) return 'frontier';
  if (LIGHT_ROLES.has(role)) return 'local';
  return 'cloud';
}

/** Heuristic token estimate for one worker run, by role. NO LIVE TELEMETRY
 * EXISTS for actual per-run usage, so this is a rough size-of-task proxy
 * (heavier roles read/write more context) -- not a measurement. Suitable for
 * budget planning and relative comparisons, not for billing reconciliation;
 * replace/augment with real CLI usage-log data when available. */
export function estimateTokens(role) {
  const ESTIMATES = {
    orchestrator: 40000,
    requirements: 30000,
    architect: 60000,
    developer: 120000,
    tester: 50000,
    reviewer: 50000,
    council: 25000
  };
  return ESTIMATES[role] ?? 40000;
}

/** Cost of running one worker of `role` on catalog `entry`, in `unit`:
 * - 'agents': always 1 (one worker launch -- exact, not estimated).
 * - 'tokens': estimateTokens(role) (estimated; see that function's caveat).
 * - 'usd': estimateTokens(role) split ~70% input / 30% output against
 *   entry.priceIn/priceOut ($ per million tokens); local entries (0/0)
 *   always cost $0. Estimated, same caveat as 'tokens'.
 * Throws on an unrecognized unit. */
export function workerCost({ role, entry, unit }) {
  if (unit === 'agents') return 1;
  const total = estimateTokens(role);
  if (unit === 'tokens') return total;
  if (unit === 'usd') {
    const inputTok = total * 0.7;
    const outputTok = total * 0.3;
    return (inputTok / 1e6) * entry.priceIn + (outputTok / 1e6) * entry.priceOut;
  }
  throw Error(`Unknown budget unit '${unit}'. Expected 'agents', 'tokens', or 'usd'.`);
}

/** True when spending `cost` on top of `spent` still fits `limit` (an
 * absent/Infinity limit always fits). */
export function withinBudget({ spent = 0, cost, limit }) {
  return limit == null || limit === Infinity || spent + cost <= limit;
}

// Stable order for tie-breaking (equal cost) and for iterating candidates
// deterministically: by provider, then model, then effort.
function compareEntries(a, b) {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.model !== b.model) return a.model < b.model ? -1 : 1;
  if (a.effort !== b.effort) return a.effort < b.effort ? -1 : 1;
  return 0;
}

/** Find the catalog entry for a (provider, model), or synthesize a default so
 * ANY assignment can be priced -- a user may hand-pick a model that isn't in the
 * catalog. The fallback is priced as a mid-range 'cloud' entry so budgeting still
 * works; `effort` is null because the fallback is only ever used for pricing, never
 * to launch. */
export function entryFor(catalog, provider, model) {
  const match = catalog.find(e => e.provider === provider && e.model === model);
  if (match) return match;
  return { provider, model, tier: 'cloud', effort: null, priceIn: 3, priceOut: 12, synthesized: true };
}

/** Route one worker assignment to a catalog entry, or null if nothing fits
 * (caller should fail closed on null).
 *
 * - Desired tier by role: HEAVY (architect/council/reviewer) -> frontier;
 *   LIGHT (requirements/tester/orchestrator) -> local; everything else
 *   (developer) -> cloud. See desiredTier().
 * - Escalation: if `escalate` and (`challenged` or `attempt > 0`), the
 *   desired tier is bumped one step toward frontier before selection --
 *   rework/hard/challenged tasks get offloaded to stronger models.
 * - Diversity: entries whose `${provider}:${model}` is in `avoid` are never
 *   selected (e.g. so a validator differs from the model it's validating).
 * - Budget-aware downgrade: starting at the (possibly escalated) desired
 *   tier, picks the CHEAPEST eligible entry at that tier (by workerCost in
 *   `unit`) that fits `remaining`. If nothing at that tier fits (too costly,
 *   or all avoided), steps down a tier and retries; local always has a $0
 *   entry, so it fits unless every local entry is avoided, in which case
 *   this returns null.
 * - Deterministic: ties are broken by provider, then model, then effort
 *   (see compareEntries) -- no Math.random()/Date.now(). */
export function routeAssignment({ role, attempt = 0, challenged = false, catalog = DEFAULT_CATALOG, unit = 'usd', remaining = Infinity, avoid = [], escalate = true }) {
  let tier = desiredTier(role);
  if (escalate && (challenged || attempt > 0)) tier = escalateTier(tier);

  const avoidSet = new Set(avoid);
  const sorted = [...catalog].sort(compareEntries);

  for (let t = tierIndex(tier); ; t--) {
    const currentTier = tierAt(t);
    let best = null;
    let bestCost = Infinity;
    for (const entry of sorted) {
      if (entry.tier !== currentTier) continue;
      if (avoidSet.has(`${entry.provider}:${entry.model}`)) continue;
      const cost = workerCost({ role, entry, unit });
      if (cost <= remaining && cost < bestCost) {
        best = entry;
        bestCost = cost;
      }
    }
    if (best) return best;
    if (t === 0) return null; // exhausted local, the cheapest tier -- nothing fits
  }
}
