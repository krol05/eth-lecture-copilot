#!/usr/bin/env node
/**
 * scripts/check-api-params.mjs
 * Verifies that every request our adapters build is one the provider will
 * actually accept — so users never hit "unrecognized parameter" because an API
 * changed and nobody noticed.
 *
 * Coverage is deliberately two-tier, because only some providers publish a
 * machine-readable schema:
 *
 *  1. SPEC-CHECKED — validated against the provider's own published schema:
 *       OpenAI     official openapi.yaml
 *       Anthropic  OpenAPI spec, URL resolved from their SDK's .stats.yml
 *       Google     Generative Language API discovery document
 *       Cerebras   OpenAPI spec via .stats.yml (an independent check of our
 *                  generic OpenAI-compatible adapter against someone else's
 *                  implementation of that API)
 *     Both parameter names and constrained values (enums) are checked.
 *
 *  2. BASELINE-CHECKED — every other provider. They all implement OpenAI's
 *     Chat Completions shape, so OpenAI's schema is the baseline, plus a
 *     registry of documented per-provider extensions (below). Anything we send
 *     that is in neither is a failure. This cannot prove a provider still
 *     accepts a parameter, but it does guarantee we never send one that isn't
 *     documented somewhere — which is the mistake we can actually make.
 *
 *  3. CROSS-CHECKED against two independent datasets, when they are reachable:
 *       LiteLLM     per-provider accepted parameters, via its own Python API
 *                   (scripts/litellm-params.py). Covers the providers that
 *                   publish nothing themselves, which is most of them.
 *       OpenRouter  `supported_parameters` per model, for its routed catalog.
 *     These REPORT rather than fail the build. They describe what LiteLLM and
 *     OpenRouter believe, and both are wrong sometimes — LiteLLM does not know
 *     that Moonshot K2.x takes `thinking`, for instance. Treat a disagreement
 *     as a prompt to check the provider's docs, not as proof of a bug.
 *
 * Exit code 1 means we would send something no source documents (tiers 1-2).
 *
 * Usage: node scripts/check-api-params.mjs [--verbose] [--strict-cross-check]
 *   --strict-cross-check also fails on tier-3 disagreements (not used in CI).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { fetchOpenRouter } from './lib/model-sources.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Adapters } = require(join(ROOT, 'lib/providers/adapters.js'));
const { Catalog } = require(join(ROOT, 'lib/providers/catalog.js'));

const VERBOSE = process.argv.includes('--verbose');
const STRICT_CROSS = process.argv.includes('--strict-cross-check');

/**
 * Non-OpenAI parameters our adapters send, each with the provider that needs it
 * and where it is documented. Adding a parameter without adding it here fails
 * the check — that is the point.
 */
const DOCUMENTED_EXTENSIONS = {
  thinking: 'DeepSeek / Zhipu / Moonshot reasoning switch — docs/providers/deepseek.md §4, reasoning-controls.md',
  enable_thinking: 'Alibaba DashScope reasoning switch — docs/providers/reasoning-controls.md',
  chat_template_kwargs: 'NVIDIA NIM / SambaNova reasoning switch — docs/providers/reasoning-controls.md',
  reasoning: 'OpenRouter / Together unified reasoning parameter — docs/providers/openrouter.md §5'
};

/**
 * our catalog id → LiteLLM's provider id, for the tier-3 cross-check.
 *
 * null means "do not compare", and the reason matters: Cohere and Zhipu are
 * listed because we call their OpenAI-COMPATIBILITY endpoints while LiteLLM
 * models their native APIs. Comparing those produces confident nonsense —
 * "cohere does not support response_format" is true of the native API and
 * false of the compatibility one.
 */
const LITELLM_PROVIDERS = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  groq: 'groq',
  xai: 'xai',
  mistral: 'mistral',
  together: 'together_ai',
  cerebras: 'cerebras',
  perplexity: 'perplexity',
  nvidia_nim: 'nvidia_nim',
  fireworks: 'fireworks_ai',
  huggingface: 'huggingface',
  moonshot: 'moonshot',
  sambanova: 'sambanova',
  qwen: 'dashscope',
  cohere: null,           // we use /compatibility/v1; LiteLLM models native /v1/chat
  zhipu: null,            // same: we use the OpenAI-compatible surface
  hyperbolic: null        // LiteLLM has no hyperbolic provider
};

/**
 * Keys that are part of every chat request's structure rather than tunable
 * options. LiteLLM's "supported params" lists options only, so these would
 * otherwise all look unrecognised.
 */
const STRUCTURAL = new Set([
  'model', 'messages', 'stream', 'system', 'contents', 'generationConfig',
  'systemInstruction', 'anthropic_version', 'input', 'stream_options'
]);

const SPEC_SOURCES = {
  openai: {
    kind: 'openapi',
    url: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
    schemaName: 'CreateChatCompletionRequest'
  },
  anthropic: {
    kind: 'stainless',
    statsUrl: 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/.stats.yml',
    path: '/v1/messages'
  },
  cerebras: {
    kind: 'stainless',
    statsUrl: 'https://raw.githubusercontent.com/cerebras/cerebras-cloud-sdk-node/main/.stats.yml',
    path: '/chat/completions'
  },
  google: {
    kind: 'discovery',
    url: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta'
  }
};

const BASE_REQUEST = {
  apiKey: 'sk-test',
  system: 'You are a tutor.',
  messages: [{ role: 'user', content: 'Explain the Fourier transform' }]
};

// The option combinations the extension actually sends
const VARIANTS = [
  { label: 'plain', thinking: 'none' },
  { label: 'thinking high', thinking: 'high' },
  { label: 'streaming + JSON mode', thinking: 'none', stream: true, jsonMode: true },
  { label: 'structured output', thinking: 'none', jsonSchema: { type: 'object' } },
  { label: 'token cap + temperature', thinking: 'none', maxTokens: 4000, temperature: 0.4 },
  { label: 'with an image', thinking: 'none', messages: [{ role: 'user', content: 'what is this?', images: ['data:image/png;base64,AAAA'] }] }
];

const findings = [];        // fail the build
const crossFindings = [];   // report only — see tier 3 in the header
const notes = [];
const coverage = [];

async function fetchText(url, what) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'eth-lecture-copilot-ci' } });
  if (!resp.ok) throw new Error(`${what}: HTTP ${resp.status}`);
  return resp.text();
}

// ── Schema helpers ───────────────────────────────────────────────────────────

function resolveRef(schema, components, seen = new Set()) {
  let cur = schema;
  while (cur && cur.$ref) {
    const name = cur.$ref.split('/').pop();
    if (seen.has(name)) return null;
    seen.add(name);
    cur = components?.[name];
  }
  return cur;
}

function schemaProperties(schema, components, seen = new Set()) {
  const resolved = resolveRef(schema, components, seen);
  if (!resolved || typeof resolved !== 'object') return new Set();
  const out = new Set(Object.keys(resolved.properties || {}));
  for (const sub of [...(resolved.allOf || []), ...(resolved.anyOf || []), ...(resolved.oneOf || [])]) {
    for (const k of schemaProperties(sub, components, seen)) out.add(k);
  }
  return out;
}

function propertySchema(schema, components, prop, seen = new Set()) {
  const resolved = resolveRef(schema, components, seen);
  if (!resolved || typeof resolved !== 'object') return null;
  if (resolved.properties?.[prop]) return resolved.properties[prop];
  for (const sub of [...(resolved.allOf || []), ...(resolved.anyOf || []), ...(resolved.oneOf || [])]) {
    const found = propertySchema(sub, components, prop, seen);
    if (found) return found;
  }
  return null;
}

/** Allowed values for a property; the enum is often behind a $ref inside anyOf. */
function enumFor(schema, components, prop) {
  const propSchema = propertySchema(schema, components, prop);
  if (!propSchema) return null;
  const visit = (s, depth = 0) => {
    const r = resolveRef(s, components);
    if (!r || typeof r !== 'object' || depth > 4) return null;
    if (Array.isArray(r.enum)) return r.enum;
    for (const sub of [...(r.allOf || []), ...(r.anyOf || []), ...(r.oneOf || [])]) {
      const found = visit(sub, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(propSchema);
}

// ── Spec loading ─────────────────────────────────────────────────────────────

async function loadOpenApiRequestSchema(source, providerId) {
  let spec;
  if (source.kind === 'stainless') {
    const stats = await fetchText(source.statsUrl, `${providerId} .stats.yml`);
    const match = stats.match(/openapi_spec_url:\s*(\S+)/);
    if (!match) throw new Error('no openapi_spec_url in .stats.yml');
    spec = parseYaml(await fetchText(match[1], `${providerId} spec`));
  } else {
    spec = parseYaml(await fetchText(source.url, `${providerId} spec`));
  }
  const components = spec.components?.schemas || {};

  if (source.schemaName) {
    const schema = components[source.schemaName];
    if (!schema) throw new Error(`${source.schemaName} missing from spec`);
    return { schema, components };
  }

  // Find the request body schema for the documented path
  const pathKey = Object.keys(spec.paths || {}).find(p => p.endsWith(source.path));
  const body = pathKey && spec.paths[pathKey]?.post?.requestBody?.content?.['application/json']?.schema;
  if (!body) throw new Error(`no request body for ${source.path}`);
  return { schema: body, components };
}

// ── Checks ───────────────────────────────────────────────────────────────────

function buildBody(providerId, variant, modelOverride) {
  const provider = Catalog.get(providerId);
  const model = modelOverride || provider.defaultModel || provider.models[0]?.id || 'test-model';
  const modelInfo = provider.models.find(m => m.id === model);
  const { messages, label, ...opts } = variant;
  void label;
  return Adapters[provider.adapter].buildRequest({
    ...BASE_REQUEST,
    base: provider.base || 'http://localhost:11434/v1',
    providerId,
    model,
    modelInfo,
    quirks: provider.quirks,
    ...(messages ? { messages } : {}),
    ...opts
  }).body;
}

function checkAgainstSchema(providerId, schema, components) {
  const allowed = schemaProperties(schema, components);
  if (!allowed.size) {
    notes.push(`${providerId}: spec produced no properties; skipped.`);
    return false;
  }
  for (const variant of VARIANTS) {
    let body;
    try { body = buildBody(providerId, variant); } catch (err) {
      findings.push(`${providerId} (${variant.label}): adapter threw — ${err.message}`);
      continue;
    }
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        findings.push(`${providerId} (${variant.label}): sends "${key}", not documented in the provider's own spec`);
      }
    }
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== 'string') continue;
      const values = enumFor(schema, components, key);
      if (values && !values.includes(value)) {
        findings.push(`${providerId} (${variant.label}): ${key}="${value}" not in [${values.join(', ')}]`);
      }
    }
  }
  coverage.push(`  ${providerId.padEnd(14)} spec-checked (${allowed.size} documented parameters)`);
  return true;
}

function checkGoogleDiscovery(providerId, disc) {
  const schemas = disc.schemas || {};
  const req = schemas.GenerateContentRequest;
  const cfg = schemas.GenerationConfig;
  if (!req || !cfg) {
    notes.push('google: discovery document missing GenerateContentRequest/GenerationConfig.');
    return false;
  }
  const top = new Set(Object.keys(req.properties || {}));
  const cfgProps = new Set(Object.keys(cfg.properties || {}));
  const thinkingProps = schemas.ThinkingConfig ? new Set(Object.keys(schemas.ThinkingConfig.properties || {})) : null;

  for (const variant of VARIANTS) {
    const body = buildBody(providerId, variant);
    for (const key of Object.keys(body)) {
      if (!top.has(key)) findings.push(`google (${variant.label}): sends "${key}", not in GenerateContentRequest`);
    }
    for (const key of Object.keys(body.generationConfig || {})) {
      if (!cfgProps.has(key)) findings.push(`google (${variant.label}): generationConfig sends "${key}", not in GenerationConfig`);
    }
    if (thinkingProps && body.generationConfig?.thinkingConfig) {
      for (const key of Object.keys(body.generationConfig.thinkingConfig)) {
        if (!thinkingProps.has(key)) findings.push(`google (${variant.label}): thinkingConfig sends "${key}", not in ThinkingConfig`);
      }
    }
  }
  coverage.push(`  ${'google'.padEnd(14)} spec-checked (${top.size} request parameters, ${cfgProps.size} generation options)`);
  return true;
}

/** Everyone without a spec: OpenAI baseline plus documented extensions. */
function checkAgainstBaseline(providerIds, baseline) {
  for (const providerId of providerIds) {
    const provider = Catalog.get(providerId);
    const unknown = new Set();
    for (const variant of VARIANTS) {
      let body;
      try { body = buildBody(providerId, variant); } catch (err) {
        findings.push(`${providerId} (${variant.label}): adapter threw — ${err.message}`);
        continue;
      }
      for (const key of Object.keys(body)) {
        if (baseline.has(key)) continue;
        if (DOCUMENTED_EXTENSIONS[key]) continue;
        unknown.add(`${key} (${variant.label})`);
      }
    }
    for (const u of unknown) {
      findings.push(`${providerId}: sends "${u}" — neither an OpenAI-compatible parameter nor a documented extension`);
    }
    if (VERBOSE) coverage.push(`  ${providerId.padEnd(14)} baseline-checked (${provider.adapter} adapter)`);
  }
  if (!VERBOSE) {
    coverage.push(`  ${'(' + providerIds.length + ' others)'.padEnd(14)} baseline-checked against OpenAI compatibility + documented extensions`);
  }
}

// ── Tier 3: independent datasets ─────────────────────────────────────────────

/**
 * Every parameter key our adapter produces for a provider, across all variants.
 * The model matters: our adapters already drop `temperature` for reasoning
 * models and switch `max_tokens` for `max_completion_tokens`, so checking one
 * model's parameters against another model's allowance invents disagreements.
 */
function paramsWeSend(providerId, model) {
  const keys = new Set();
  for (const variant of VARIANTS) {
    let body;
    try { body = buildBody(providerId, variant, model); } catch { continue; }
    for (const k of Object.keys(body || {})) if (!STRUCTURAL.has(k)) keys.add(k);
  }
  return keys;
}

/** Ask LiteLLM, via its Python API, what each provider accepts. */
async function crossCheckLiteLLM() {
  const request = {};
  for (const provider of Catalog.list()) {
    const litellm = LITELLM_PROVIDERS[provider.id];
    if (!litellm) continue;
    const model = provider.defaultModel || provider.models?.[0]?.id;
    if (model) request[provider.id] = { litellm, model };
  }
  if (!Object.keys(request).length) return;

  const script = join(ROOT, 'scripts/litellm-params.py');
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      const proc = spawn('python3', [script, JSON.stringify(request)], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`)));
    });
  } catch (err) {
    notes.push(`LiteLLM cross-check skipped (${err.message}). Install with: pip install litellm`);
    return;
  }

  let data;
  try { data = JSON.parse(raw); } catch { notes.push('LiteLLM cross-check: unparseable output.'); return; }
  if (data.__unavailable__) {
    notes.push(`LiteLLM cross-check skipped (${data.__unavailable__}). Install with: pip install litellm`);
    return;
  }

  let agreed = 0;
  for (const [providerId, result] of Object.entries(data)) {
    if (result.error) { notes.push(`LiteLLM could not describe ${providerId}: ${result.error}`); continue; }
    const known = new Set(result.params);
    const unknown = [...paramsWeSend(providerId, result.model)].filter(p => !known.has(p));
    if (!unknown.length) { agreed++; continue; }
    crossFindings.push(
      `${providerId}: LiteLLM does not list ${unknown.map(u => `"${u}"`).join(', ')} ` +
      `(it knows ${known.size} parameters for ${result.model})`);
  }
  coverage.push(`  ${'LiteLLM'.padEnd(14)} cross-checked ${Object.keys(data).length} providers, ${agreed} in full agreement`);
}

/** OpenRouter publishes supported_parameters per model — check that path per model. */
async function crossCheckOpenRouter() {
  const provider = Catalog.get('openrouter');
  if (!provider) return;
  let models;
  try {
    models = (await fetchOpenRouter()).data || [];
  } catch (err) {
    notes.push(`OpenRouter cross-check skipped (${err.message}).`);
    return;
  }

  const byId = new Map(models.map(m => [m.id, m.supported_parameters]).filter(([, p]) => Array.isArray(p)));
  let checked = 0, clean = 0;

  // Check every catalog model on this provider, not just the default — the
  // whole point of OpenRouter is that one key reaches many different backends,
  // and they do not all accept the same parameters.
  for (const entry of provider.models || []) {
    const supported = byId.get(entry.id);
    if (!supported) continue;
    checked++;
    const unknown = [...paramsWeSend('openrouter', entry.id)].filter(p => !supported.includes(p));
    if (!unknown.length) { clean++; continue; }
    crossFindings.push(
      `openrouter/${entry.id}: does not list ${unknown.map(u => `"${u}"`).join(', ')}`);
  }
  const missing = (provider.models || []).length - checked;
  coverage.push(
    `  ${'OpenRouter'.padEnd(14)} cross-checked ${checked} models against supported_parameters, ${clean} clean` +
    (missing ? ` (${missing} not in their catalogue)` : ''));
}

async function main() {
  let baseline = null;
  const specChecked = new Set();

  for (const [providerId, source] of Object.entries(SPEC_SOURCES)) {
    if (!Catalog.get(providerId)) continue;
    try {
      if (source.kind === 'discovery') {
        const disc = JSON.parse(await fetchText(source.url, 'google discovery'));
        if (checkGoogleDiscovery(providerId, disc)) specChecked.add(providerId);
        continue;
      }
      const { schema, components } = await loadOpenApiRequestSchema(source, providerId);
      if (providerId === 'openai') baseline = schemaProperties(schema, components);
      if (checkAgainstSchema(providerId, schema, components)) specChecked.add(providerId);
    } catch (err) {
      // A source being unreachable says nothing about our code — never fail on it
      notes.push(`${providerId}: could not be spec-checked (${err.message}).`);
    }
  }

  if (!baseline) {
    notes.push('OpenAI spec unavailable, so the compatibility baseline could not be built; other providers were not checked this run.');
  } else {
    const rest = Catalog.list()
      .filter(p => p.adapter === 'oai' && !specChecked.has(p.id))
      .map(p => p.id);
    checkAgainstBaseline(rest, baseline);
  }

  // Tier 3 runs last and never blocks: both datasets are third-party opinions.
  await Promise.all([crossCheckLiteLLM(), crossCheckOpenRouter()]);

  console.log('Coverage:');
  console.log(coverage.join('\n'));
  console.log('\nDocumented non-OpenAI parameters in use:');
  for (const [k, why] of Object.entries(DOCUMENTED_EXTENSIONS)) console.log(`  ${k.padEnd(22)} ${why}`);

  if (crossFindings.length) {
    console.log('\nDisagreements with LiteLLM / OpenRouter (informational):');
    for (const c of crossFindings) console.log(`  - ${c}`);
    console.log('  These datasets are third-party and incomplete. Check the provider\'s own');
    console.log('  documentation before changing an adapter because of one.');
  }

  if (notes.length) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }

  if (STRICT_CROSS && crossFindings.length) {
    console.error('\n❌ --strict-cross-check: the datasets above disagree with us.');
    process.exit(1);
  }

  if (findings.length) {
    console.error('\n❌ Requests that a provider may reject:\n');
    for (const f of findings) console.error(`  - ${f}`);
    console.error('\nEither the provider changed their API, or an adapter sends something undocumented.');
    console.error('See docs/providers/ and lib/providers/adapters.js.');
    process.exit(1);
  }

  console.log('\n✅ Every parameter we send is documented.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
