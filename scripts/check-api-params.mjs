#!/usr/bin/env node
/**
 * scripts/check-api-params.mjs
 * Validates the request bodies our adapters build against the providers' own
 * published API specifications.
 *
 * The point: users should never hit "unrecognized parameter" or a rejected
 * value because a provider changed their API and we didn't notice. Model
 * *names* drift weekly and are handled by update-catalog.mjs; this covers the
 * request *shape*, which breaks far more loudly.
 *
 * Sources (machine-readable, fetched live):
 *   OpenAI  — openapi.yaml from the official openai-openapi repository
 *   Google  — the Generative Language API discovery document
 *
 * Providers without a published spec (Anthropic and the OpenAI-compatible
 * fleet) can't be checked this way; their parameters come from the research in
 * docs/providers/ and are guarded by the reasoning audit in update-catalog.mjs.
 *
 * Exit code 1 means we would send something the spec does not allow — that is
 * a real user-facing breakage waiting to happen.
 *
 * Usage: node scripts/check-api-params.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Adapters } = require(join(ROOT, 'lib/providers/adapters.js'));
const { Catalog } = require(join(ROOT, 'lib/providers/catalog.js'));

const OPENAI_SPEC = 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml';
const GOOGLE_DISCOVERY = 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta';

const BASE_REQUEST = {
  apiKey: 'sk-test',
  system: 'You are a tutor.',
  messages: [{ role: 'user', content: 'Explain the Fourier transform' }]
};

const findings = [];
const notes = [];

async function fetchText(url, what) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'eth-lecture-copilot-ci' } });
  if (!resp.ok) throw new Error(`${what}: HTTP ${resp.status}`);
  return resp.text();
}

/** Collect property names from a schema, following allOf/$ref one level deep. */
function schemaProperties(schema, components, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return new Set();
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (seen.has(name)) return new Set();
    seen.add(name);
    return schemaProperties(components?.[name], components, seen);
  }
  const out = new Set(Object.keys(schema.properties || {}));
  for (const sub of [...(schema.allOf || []), ...(schema.anyOf || []), ...(schema.oneOf || [])]) {
    for (const k of schemaProperties(sub, components, seen)) out.add(k);
  }
  return out;
}

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

/** The schema of one property, following allOf/anyOf/oneOf and $ref. */
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

/**
 * The allowed values for a property, if the spec constrains them. The enum is
 * often behind a $ref and nested in anyOf (alongside a nullable branch), e.g.
 * reasoning_effort → ReasoningEffort → anyOf[{enum:[...]}, {type:'null'}].
 */
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

async function checkOpenAI() {
  const spec = parseYaml(await fetchText(OPENAI_SPEC, 'OpenAI spec'));
  const components = spec.components?.schemas || {};
  const reqSchema = components.CreateChatCompletionRequest;
  if (!reqSchema) {
    notes.push('OpenAI: CreateChatCompletionRequest not found in the spec — schema may have been restructured.');
    return;
  }
  const allowed = schemaProperties(reqSchema, components);
  if (!allowed.size) {
    notes.push('OpenAI: could not read any properties from the spec; skipping.');
    return;
  }

  const provider = Catalog.get('openai');
  // Exercise the combinations the extension actually sends
  const cases = [
    { label: 'chat model, no thinking', model: 'gpt-4o', thinking: 'none', temperature: 0.4 },
    { label: 'reasoning model, no thinking', model: 'gpt-5.6-terra', thinking: 'none' },
    { label: 'reasoning model, thinking high', model: 'gpt-5.6-terra', thinking: 'high' },
    { label: 'o-series', model: 'o4-mini', thinking: 'none' },
    { label: 'streaming + JSON mode', model: 'gpt-4o', thinking: 'none', stream: true, jsonMode: true },
    { label: 'structured output', model: 'gpt-4o', thinking: 'none', jsonSchema: { type: 'object' } },
    { label: 'with token cap', model: 'gpt-4o', thinking: 'none', maxTokens: 4000 }
  ];

  for (const c of cases) {
    const info = provider.models.find(m => m.id === c.model);
    const { body } = Adapters.oai.buildRequest({
      ...BASE_REQUEST, base: provider.base, providerId: 'openai',
      quirks: provider.quirks, modelInfo: info, ...c
    });
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        findings.push(`OpenAI (${c.label}): sends "${key}", which is not in CreateChatCompletionRequest`);
      }
    }
    if (body.reasoning_effort) {
      const values = enumFor(reqSchema, components, 'reasoning_effort');
      if (values && !values.includes(body.reasoning_effort)) {
        findings.push(`OpenAI (${c.label}): reasoning_effort "${body.reasoning_effort}" not in spec enum [${values.join(', ')}]`);
      }
    }
  }
  console.log(`OpenAI: checked ${cases.length} request shapes against ${allowed.size} documented parameters.`);
}

async function checkGoogle() {
  const disc = JSON.parse(await fetchText(GOOGLE_DISCOVERY, 'Google discovery'));
  const schemas = disc.schemas || {};
  const req = schemas.GenerateContentRequest;
  const genConfig = schemas.GenerationConfig;
  if (!req || !genConfig) {
    notes.push('Google: GenerateContentRequest/GenerationConfig missing from the discovery document.');
    return;
  }
  const allowedTop = new Set(Object.keys(req.properties || {}));
  const allowedCfg = new Set(Object.keys(genConfig.properties || {}));
  const thinkingCfg = schemas.ThinkingConfig ? new Set(Object.keys(schemas.ThinkingConfig.properties || {})) : null;

  const provider = Catalog.get('google');
  const cases = [
    { label: 'gemini 3, no thinking', model: 'gemini-3.7-flash', thinking: 'none' },
    { label: 'gemini 2.5, thinking medium', model: 'gemini-2.5-flash', thinking: 'medium' },
    { label: 'streaming + JSON mode', model: 'gemini-2.5-flash', thinking: 'none', stream: true, jsonMode: true },
    { label: 'structured output', model: 'gemini-2.5-flash', thinking: 'none', jsonSchema: { type: 'object' } },
    { label: 'with token cap', model: 'gemini-2.5-flash', thinking: 'none', maxTokens: 4000 }
  ];

  for (const c of cases) {
    const { body } = Adapters.google.buildRequest({
      ...BASE_REQUEST, base: provider.base, providerId: 'google', ...c
    });
    for (const key of Object.keys(body)) {
      if (!allowedTop.has(key)) {
        findings.push(`Google (${c.label}): sends "${key}", not in GenerateContentRequest`);
      }
    }
    for (const key of Object.keys(body.generationConfig || {})) {
      if (!allowedCfg.has(key)) {
        findings.push(`Google (${c.label}): generationConfig sends "${key}", not in GenerationConfig`);
      }
    }
    if (thinkingCfg && body.generationConfig?.thinkingConfig) {
      for (const key of Object.keys(body.generationConfig.thinkingConfig)) {
        if (!thinkingCfg.has(key)) {
          findings.push(`Google (${c.label}): thinkingConfig sends "${key}", not in ThinkingConfig`);
        }
      }
    }
  }
  console.log(`Google: checked ${cases.length} request shapes against the v1beta discovery document.`);
}

async function main() {
  const checks = [
    ['OpenAI', checkOpenAI],
    ['Google', checkGoogle]
  ];
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (err) {
      // A fetch failure must not fail the build — it says nothing about our code
      notes.push(`${name}: could not be checked (${err.message}).`);
    }
  }

  if (notes.length) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  - ${n}`);
  }

  if (findings.length) {
    console.error('\n❌ Parameters that the provider does not document:\n');
    for (const f of findings) console.error(`  - ${f}`);
    console.error('\nEither the provider changed their API, or an adapter is sending something it should not.');
    console.error('Check the relevant docs/providers/*.md and lib/providers/adapters.js.');
    process.exit(1);
  }

  console.log('\n✅ Every parameter we send is documented by the provider.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
