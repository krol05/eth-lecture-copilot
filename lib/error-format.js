/**
 * lib/error-format.js
 * Pure formatting of structured API errors for the error panel — no DOM, no
 * chrome.*, fully unit-tested.
 *
 * Input: the background's errorDetail object
 *   { status, provider, model, code, message, raw, timestamp }
 * Output:
 *   {
 *     title,      one line: provider + what class of failure
 *     summary,    the actual error message (never genericized)
 *     hint,       actionable advice when the failure class is recognizable, else ''
 *     sections,   [{label, content}] — full detail incl. pretty-printed raw body
 *     timestamp   ms epoch (0 when absent)
 *   }
 * Nothing from the input is discarded: whatever the provider sent is always
 * visible under the "Provider response" section verbatim.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  function providerLabel(detail) {
    return detail.provider || 'API';
  }

  // Where to send someone whose model rejected an image. Only providers with a
  // clearly named vision model are listed; everyone else gets generic advice.
  const VISION_MODEL_HINTS = {
    deepseek: 'deepseek-v4-flash-vision-exp (the only DeepSeek model that takes images)',
    openai: 'a GPT-5.6 or GPT-4o model',
    anthropic: 'any current Claude model',
    google: 'any current Gemini model'
  };

  function classify(detail) {
    const code = String(detail.code || '').toLowerCase();
    const msg = String(detail.message || '').toLowerCase();
    const status = detail.status;
    const isLocal = String(detail.provider || '').startsWith('local_');

    if (code === 'aborted') return { kind: 'Stopped', hint: '' };
    if (code === 'timeout') {
      return { kind: 'Timeout', hint: 'The provider did not answer in time. Try again; if it keeps happening, the service may be down or the request too large.' };
    }
    // Must precede the auth check below, whose `code.includes('permission')`
    // would otherwise report a missing host grant as a rejected API key and
    // send the user off to re-check a key that was never the problem.
    if (code === 'permission_missing') {
      const host = detail.raw?.host || 'that provider';
      return {
        kind: 'Access to this provider not granted yet',
        hint: `Chrome asks before the extension may contact a new site. Use "Allow ${host}" below, or open the extension popup and pick this provider again — the prompt has to come from a button you click.`
      };
    }
    if (status === 401 || status === 403 || code.includes('authentication') || code.includes('invalid_api_key') || code.includes('permission')) {
      return { kind: 'Authentication failed', hint: `Your ${providerLabel(detail)} API key was rejected. Check it in the extension settings (it may be revoked, mistyped, or lack access to this model).` };
    }
    if (status === 402 || code.includes('insufficient') || msg.includes('insufficient balance') || msg.includes('credit')) {
      return { kind: 'Out of credits', hint: `Your ${providerLabel(detail)} account has no remaining balance/credits. Top up or switch provider.` };
    }
    if (status === 404 || code.includes('model_not_found') || (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist') || msg.includes('decommissioned') || msg.includes('retired')))) {
      return { kind: 'Model not available', hint: `The model "${detail.model || '?'}" was not found — it may be retired or unavailable to your account. Pick another model, or type a current model ID in the model field.` };
    }
    if (status === 429 || code.includes('rate_limit') || code.includes('quota')) {
      return { kind: 'Rate limited', hint: 'Too many requests or quota exhausted. Wait a bit and retry, or switch provider/model.' };
    }
    if (status === 529 || code.includes('overloaded') || (typeof status === 'number' && status >= 500)) {
      return { kind: 'Provider overloaded', hint: 'The provider is having trouble right now. Usually temporary — retry in a minute.' };
    }
    if (msg.includes('not support image') || msg.includes('does not support vision') || msg.includes('image input') || code === 'unsupported_image') {
      const suggestion = VISION_MODEL_HINTS[detail.provider];
      return {
        kind: 'Model can\'t read images',
        hint: `The model "${detail.model || '?'}" only accepts text.${suggestion ? ` Switch to ${suggestion} to send screenshots.` : ' Switch to a vision-capable model to send screenshots.'} Removing the attached image and asking again also works.`
      };
    }
    if (code === 'safety' || msg.includes('blocked')) {
      return { kind: 'Content blocked', hint: 'The provider refused this request via its content filter.' };
    }
    if (status == null && (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed'))) {
      if (isLocal) {
        const ollama = detail.provider === 'local_ollama'
          ? ' For Ollama, also set OLLAMA_ORIGINS=chrome-extension://* before starting the server — it blocks extension requests by default.'
          : '';
        return { kind: 'Local server unreachable', hint: `Could not reach the local server. Check that it is running and the base URL/port is right.${ollama}` };
      }
      return { kind: 'Network error', hint: 'The request never reached the provider. Check your connection; a firewall, VPN, or CORS restriction may also be blocking it.' };
    }
    if (msg.includes('failed to parse json')) {
      return { kind: 'Unusable response', hint: 'The model answered, but not with the JSON structure the extension needs. Retrying often fixes it; a stronger model helps.' };
    }
    return { kind: 'Request failed', hint: '' };
  }

  function prettyRaw(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
      try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
    }
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }

  function formatError(detail) {
    const d = detail || {};
    const { kind, hint } = classify(d);
    const statusPart = typeof d.status === 'number' ? ` (HTTP ${d.status})` : '';
    const title = `${providerLabel(d)}: ${kind}${statusPart}`;
    const summary = d.message || 'Unknown error';

    const meta = [
      d.provider ? `provider: ${d.provider}` : null,
      d.model ? `model: ${d.model}` : null,
      typeof d.status === 'number' ? `HTTP status: ${d.status}` : null,
      d.code ? `code: ${d.code}` : null
    ].filter(Boolean).join('\n');

    const sections = [];
    if (meta) sections.push({ label: 'Request', content: meta });
    const raw = prettyRaw(d.raw);
    if (raw) sections.push({ label: 'Provider response', content: raw });

    return { title, summary, hint, sections, timestamp: d.timestamp || 0 };
  }

  return { formatError };
});
