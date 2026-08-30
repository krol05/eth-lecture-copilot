/**
 * scripts/lib/model-sources.mjs
 * The public, no-auth datasets we check our provider layer against.
 *
 * We deliberately use more than one, because each is wrong in different places
 * and disagreement is the signal we want:
 *
 *   models.dev   broadest model lists; reports accepted reasoning effort levels.
 *   LiteLLM      a `mode` per model (chat / embedding / rerank / …) and a set of
 *                reasoning capability flags. Maintained by a large project that
 *                actually calls these APIs, so it catches things provider docs
 *                bury. Covers ~79% of our catalog.
 *   OpenRouter   `supported_parameters` per model for its ~400 routed models —
 *                the only per-model parameter list anyone publishes.
 *
 * None is authoritative. LiteLLM lists no NVIDIA specialist models at all and
 * labels `Nemotron-Content-Safety` as `chat`; models.dev reports embedding and
 * protein models as ordinary text models. So callers combine them and treat a
 * non-chat verdict from ANY source as disqualifying.
 */

const MODELS_DEV = 'https://models.dev/api.json';
const LITELLM =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER = 'https://openrouter.ai/api/v1/models';

async function getJson(url, what) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'eth-lecture-copilot-ci' } });
  if (!resp.ok) throw new Error(`${what}: HTTP ${resp.status}`);
  return resp.json();
}

export const fetchModelsDev = () => getJson(MODELS_DEV, 'models.dev');
export const fetchOpenRouter = () => getJson(OPENROUTER, 'openrouter /models');

/** Strip a vendor prefix: "anthropic/claude-opus-5" -> "claude-opus-5". */
export function bareId(id) {
  const s = String(id || '');
  return (s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s).toLowerCase();
}

/**
 * LiteLLM keys look like "gpt-5", "anthropic/claude-opus-4-5", "azure/gpt-4o".
 * We look models up by their bare name, so one bare name can map to several
 * entries (the same model offered by several hosts). Merge them conservatively:
 * a capability counts as present if ANY host reports it, and the mode is the
 * one the majority of entries agree on.
 */
export async function fetchLiteLLM() {
  const raw = await getJson(LITELLM, 'litellm model metadata');
  const byBare = new Map();
  for (const [key, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue;
    const bare = bareId(key);
    if (!bare || bare === 'sample_spec') continue;
    if (!byBare.has(bare)) byBare.set(bare, []);
    byBare.get(bare).push(info);
  }

  return {
    size: byBare.size,

    /** Merged view of one model, or null when LiteLLM doesn't list it. */
    get(modelId) {
      const entries = byBare.get(bareId(modelId));
      if (!entries || !entries.length) return null;

      const modes = {};
      for (const e of entries) if (e.mode) modes[e.mode] = (modes[e.mode] || 0) + 1;
      const mode = Object.entries(modes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const any = flag => entries.some(e => e[flag] === true);

      // Levels: an explicit list wins; otherwise assemble from the capability
      // flags. low/medium/high are the levels every reasoning model takes, and
      // the flags only ever ADD to that set.
      let levels = entries.map(e => e.reasoning_effort_levels).find(Array.isArray) || null;
      if (!levels && any('supports_reasoning')) {
        levels = ['low', 'medium', 'high'];
        if (any('supports_none_reasoning_effort')) levels.unshift('none');
        if (any('supports_minimal_reasoning_effort')) levels.splice(levels.indexOf('low'), 0, 'minimal');
        if (any('supports_xhigh_reasoning_effort')) levels.push('xhigh');
        if (any('supports_max_reasoning_effort')) levels.push('max');
      }

      return {
        mode,
        reasoning: any('supports_reasoning'),
        alwaysOn: any('thinking_always_on'),
        levels,
        defaultEffort: entries.map(e => e.default_reasoning_effort).find(Boolean) || null
      };
    }
  };
}
