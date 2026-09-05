/**
 * lib/providers/reasoning.js
 * How to turn reasoning OFF for a given provider + model.
 *
 * Why this exists: many current models reason by DEFAULT when no reasoning
 * parameter is sent. On a long generation that is indistinguishable from a
 * frozen request, so "none" must always be stated explicitly. But there is no
 * universal off-switch:
 *
 *   - the parameter name differs (reasoning_effort / thinking / enable_thinking
 *     / reasoning / chat_template_kwargs.enable_thinking)
 *   - "none" is a 400 error on every gpt-oss model, on GLM-5.3 and on
 *     MiniMax-M2 — those have a floor of "low"
 *   - some models cannot disable reasoning at all (xAI Grok, Kimi K2.7-code,
 *     the DashScope thinking-only line)
 *   - it varies per MODEL inside one provider (Groq: qwen accepts "none",
 *     gpt-oss does not)
 *
 * Ground truth: docs/providers/reasoning-controls.md (official docs, 2026-08-27).
 * Anything not CONFIRMED there returns null — we send nothing rather than risk
 * a 400 that breaks the provider outright. Slow is recoverable; broken is not.
 *
 * Returns a body fragment to merge into the request, or null to send nothing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  // Effort levels from least to most thinking. When we know which levels a
  // model actually accepts (captured from models.dev by the weekly catalog
  // update), we pick the lowest available rather than trusting a hand-written
  // value — gpt-5-pro accepts only "high", and "none" would be rejected.
  const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  function lowestEffort(accepted, fallback) {
    if (!Array.isArray(accepted) || !accepted.length) return fallback;
    const found = EFFORT_ORDER.find(v => accepted.includes(v));
    return found || fallback;
  }

  // Providers whose reasoning parameter the official docs never confirmed.
  // Both directions — on and off — send nothing for these.
  const UNVERIFIED = new Set(['huggingface', 'hyperbolic', 'local_lmstudio']);

  const effort = v => ({ reasoning_effort: v });
  const THINKING_OFF = { thinking: { type: 'disabled' } };
  const ENABLE_THINKING_OFF = { enable_thinking: false };
  const TEMPLATE_THINKING_OFF = { chat_template_kwargs: { enable_thinking: false } };

  // Families whose behaviour follows the model wherever it is hosted.
  // gpt-oss only accepts low/medium/high — Fireworks documents the literal
  // 400 "Invalid reasoning effort: none".
  const IS_GPT_OSS = /gpt-oss/i;
  const IS_QWEN = /qwen/i;
  const IS_GEMMA = /gemma/i;

  // Models that reason unconditionally — sending an off-value errors.
  //
  // The catalog now carries `alwaysOn: true` on models LiteLLM reports as
  // thinking-only (regenerated weekly), so this list is the fallback for models
  // no dataset covers rather than the only defence it used to be.
  const CANNOT_DISABLE = [
    /^grok/i,                       // xAI: "Reasoning cannot be disabled"
    /kimi-k2\.7-code/i,             // Moonshot: "disabled" errors
    /qwq/i, /-thinking-/i, /^r1$/i, /deepseek-r1/i, /minimax-m\d/i
  ];

  // Model families that actually reason. Providers whose line-up is mixed are
  // gated on this: sending a reasoning parameter to a plain chat model risks an
  // unrecognized-parameter error, and it has nothing to switch off anyway.
  const REASONING_FAMILY = new RegExp([
    'gpt-5', '^o[0-9]', 'gpt-oss',
    'deepseek-v4', 'deepseek-v3\\.[12]', 'deepseek-chat-v3',
    'glm-[45]', 'qwen3', 'kimi-k[23]',
    'magistral', 'mistral-small', 'mistral-medium-3',
    'minimax-m', 'nemotron-3', 'command-a-reasoning',
    'sonar-reasoning', 'deep-research', 'grok'
  ].join('|'), 'i');

  function isReasoningModel(modelId) {
    return REASONING_FAMILY.test(bare(modelId)) || REASONING_FAMILY.test(String(modelId || ''));
  }

  function bare(modelId) {
    const m = String(modelId || '');
    return (m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m).toLowerCase();
  }

  /**
   * True only when we have positive evidence the model does not reason: the
   * catalog lists it, gives it no effort levels, does not mark it always-on,
   * and its name belongs to no known reasoning family. An unlisted model
   * (user-typed, or newer than our catalog) is never "known" anything.
   */
  function knownNonReasoning(modelId, modelInfo) {
    if (!modelInfo) return false;
    if (modelInfo.alwaysOn) return false;
    if (Array.isArray(modelInfo.efforts) && modelInfo.efforts.length) return false;
    return !isReasoningModel(modelId);
  }

  function cannotDisable(modelId) {
    const m = String(modelId || '');
    return CANNOT_DISABLE.some(re => re.test(m) || re.test(bare(m)));
  }

  /**
   * @param {string} providerId  catalog provider id (or custom_/local_ id)
   * @param {string} modelId     the model being called
   * @param {Object<string, any>} [modelInfo] catalog entry for the model; `efforts` lists
   *                             the levels the provider says it accepts
   * @returns {Object<string, any>|null}      body fragment for "reasoning off", or null
   */
  function reasoningOffBody(providerId, modelId, modelInfo) {
    const p = String(providerId || '');
    const m = String(modelId || '');
    const b = bare(m);
    const accepted = modelInfo && modelInfo.efforts;

    // Whenever the answer is an effort level, defer to what the model says it
    // accepts. Only the fallback comes from the hand-written table below.
    const atLeast = fallback => effort(lowestEffort(accepted, fallback));

    // Grok and friends always reason; the best we can do is the lowest effort
    // rather than an off-switch that would 400.
    if (/^grok/i.test(b)) return atLeast('low');

    // The catalog says this model cannot stop reasoning. Asking it to would be
    // an error, so ask for as little as it will accept instead — unless it
    // takes no effort levels either, in which case send nothing at all.
    if (modelInfo && modelInfo.alwaysOn) {
      return Array.isArray(accepted) && accepted.length ? atLeast('low') : null;
    }
    if (cannotDisable(m)) return null;

    // Mixed line-ups: never send a reasoning parameter to a plain chat model.
    const MIXED = ['openai', 'mistral', 'fireworks', 'together', 'nvidia_nim', 'sambanova', 'huggingface'];
    if (MIXED.includes(p) && !isReasoningModel(m)) return null;

    switch (p) {
      case 'openai':
        // o-series predates the none/minimal levels; "low" is its safe floor
        return /^o[0-9]/.test(b) ? atLeast('low') : atLeast('none');

      case 'deepseek':
        return THINKING_OFF;

      case 'openrouter':
        // Unified switch across every routed backend. Per-model `mandatory:
        // true` models reject effort "none", which is why this uses `enabled`.
        //
        // Skipped where the catalog positively describes a non-reasoning model
        // (no effort levels, and a name from no reasoning family). OpenRouter
        // ignores the parameter for those anyway, and staying quiet keeps the
        // cross-check against their supported_parameters meaningful. A model
        // we know nothing about still gets it — an unnoticed default-on
        // reasoner is the failure that actually hurts.
        if (knownNonReasoning(m, modelInfo)) return null;
        return { reasoning: { enabled: false } };

      case 'groq':
        if (IS_GPT_OSS.test(b)) return atLeast('low');
        if (IS_QWEN.test(b)) return atLeast('none');
        return null;                       // Llama etc. are not reasoning models

      case 'xai':
        return atLeast('low');                        // cannot be disabled; default is "high"

      case 'mistral':
        return atLeast('none');

      case 'together':
        return IS_GPT_OSS.test(b) ? atLeast('low') : { reasoning: { enabled: false } };

      case 'cerebras':
        if (IS_GPT_OSS.test(b)) return atLeast('low');
        if (IS_GEMMA.test(b)) return atLeast('none');
        return null;

      case 'fireworks':
        return IS_GPT_OSS.test(b) ? atLeast('low') : atLeast('none');

      case 'nvidia_nim':
        return TEMPLATE_THINKING_OFF;

      case 'sambanova':
        return TEMPLATE_THINKING_OFF;

      case 'perplexity':
        // Only the reasoning Sonar models take it; "minimal" is the floor
        return /reasoning|deep-research/i.test(b) ? atLeast('minimal') : null;

      case 'cohere':
        return /reasoning/i.test(b) ? atLeast('none') : null;

      case 'zhipu':
        return /glm-5\.3/i.test(b) ? atLeast('low') : THINKING_OFF;

      case 'moonshot':
        return /kimi-k3/i.test(b) ? atLeast('low') : THINKING_OFF;

      case 'qwen':                          // Alibaba DashScope
        return ENABLE_THINKING_OFF;

      case 'local_ollama':
        // Ollama's OpenAI endpoint takes reasoning_effort (not `think`), and
        // thinking is enabled by default
        return IS_GPT_OSS.test(b) ? atLeast('low') : atLeast('none');

      default:
        // Not confirmed by the docs: HuggingFace router (forwards to backends
        // that reject "none"), Hyperbolic, LM Studio's chat endpoint, other
        // local servers, and user-defined custom providers. Send nothing.
        return null;
    }
  }

  /**
   * The counterpart to reasoningOffBody: how to ask this provider for a
   * reasoning level. Split out for the same reason — the parameter name and
   * shape differ per provider, and getting it wrong is silent rather than
   * loud. OpenRouter ignores parameters a backend doesn't understand, so
   * sending `reasoning_effort` where `reasoning.effort` was needed produced a
   * request that worked but ignored the user's choice entirely.
   *
   * @param {string} providerId
   * @param {string} modelId
   * @param {Object<string, any>} modelInfo catalog entry; `efforts` bounds the level
   * @param {string} level  'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
   * @returns {Object<string, any>|null}  body fragment, or null to send nothing
   */
  function reasoningOnBody(providerId, modelId, modelInfo, level) {
    const p = String(providerId || '');
    const b = bare(modelId);
    const want = clampEffort(level, modelInfo && modelInfo.efforts);

    switch (p) {
      // Unified switch across every routed backend. `reasoning_effort` is
      // accepted by only a third of OpenRouter's catalogue; `reasoning.effort`
      // is the documented form (openrouter.md §5).
      case 'openrouter':
      case 'together':
        return { reasoning: { effort: want } };

      case 'nvidia_nim':
      case 'sambanova':
        return { chat_template_kwargs: { enable_thinking: true } };

      case 'qwen':
        return { enable_thinking: true };

      case 'zhipu':
        return /glm-5\.3/i.test(b) ? effort(want) : { thinking: { type: 'enabled' } };

      case 'moonshot':
        // K3 uses effort levels; K2.x uses the thinking object (K2.7-code
        // cannot be switched at all and never reaches here).
        return /kimi-k3/i.test(b) ? effort(want) : { thinking: { type: 'enabled' } };

      default:
        // Same caution as the off-switch: providers whose reasoning parameter
        // the docs never confirmed get nothing. A model gaining an `efforts`
        // list from an upstream dataset is not evidence that THIS host accepts
        // the parameter — the HuggingFace router forwards to backends that
        // reject it (reasoning-controls.md §5).
        if (UNVERIFIED.has(p) || /^(custom_|local_lmstudio)/.test(p)) return null;

        // Everyone else takes OpenAI's reasoning_effort — but only send it to
        // a model that actually reasons, or it is an unrecognized parameter.
        if (!isReasoningModel(modelId) && !(modelInfo && modelInfo.efforts)) return null;
        return effort(want);
    }
  }

  /**
   * Pick the level closest to what the user asked for that the model accepts.
   * Asking gpt-5-pro for "low" when it only takes "high" is a 400; quietly
   * moving to the nearest accepted level is better than failing the request.
   */
  function clampEffort(level, accepted) {
    const want = EFFORT_ORDER.indexOf(level) === -1 ? 'medium' : level;
    if (!Array.isArray(accepted) || !accepted.length) return want;
    if (accepted.includes(want)) return want;
    const target = EFFORT_ORDER.indexOf(want);
    let best = null, bestDist = Infinity;
    for (const value of accepted) {
      const i = EFFORT_ORDER.indexOf(value);
      if (i === -1) continue;
      const dist = Math.abs(i - target);
      // On a tie prefer the higher level: the user asked for more thinking.
      if (dist < bestDist || (dist === bestDist && i > EFFORT_ORDER.indexOf(best))) {
        best = value; bestDist = dist;
      }
    }
    return best || want;
  }

  return { reasoningOffBody, reasoningOnBody, clampEffort };
});
