#!/usr/bin/env node
/**
 * scripts/update-catalog.mjs
 * Regenerates lib/providers/catalog-data.js from models.dev (a community-
 * maintained, machine-readable index of provider model lists).
 *
 * Run by .github/workflows/update-models.yml weekly; the result is opened as a
 * PR so every model change is reviewed, never auto-merged.
 *
 * Rules:
 *  - ADDITIVE ONLY. Models already in catalog-data.js keep their position and
 *    hand-written label. Nothing is ever removed by this script — providers
 *    keep serving older models long after they stop being promoted, and a
 *    disappearing entry would silently break someone's saved setup.
 *  - Only chat-capable text models are added (no image/audio/embedding/realtime).
 *  - Known-retired IDs are never added back.
 *  - New models are appended newest-first by release date.
 *
 * Usage: node scripts/update-catalog.mjs [--dry-run]
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { reasoningOffBody } = require('../lib/providers/reasoning.js');
const DATA_FILE = join(ROOT, 'lib/providers/catalog-data.js');
const SOURCE_URL = 'https://models.dev/api.json';

// our catalog id → models.dev provider id
const PROVIDER_SOURCES = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  groq: 'groq',
  xai: 'xai',
  mistral: 'mistral',
  together: 'togetherai',
  cerebras: 'cerebras',
  perplexity: 'perplexity',
  nvidia_nim: 'nvidia',
  fireworks: 'fireworks-ai',
  cohere: 'cohere',
  huggingface: 'huggingface',
  moonshot: 'moonshotai',
  zhipu: 'zhipuai',
  qwen: 'alibaba'
};

// Verified retired per docs/providers/*.md — requests to these fail outright,
// so they must never be (re-)added even if an upstream index still lists them.
const RETIRED = new Set([
  'deepseek-chat', 'deepseek-reasoner',
  'gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4-0613', 'gpt-3.5-turbo-0125',
  'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash',
  'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet-20241022',
  'claude-3-haiku-20240307', 'claude-3-opus-20240229', 'claude-3-7-sonnet-20250219'
]);

// Model families that don't work through a plain chat-completions call, so
// listing them would only offer the user broken choices: other modalities
// (image/audio/video), different API surfaces (Live/realtime = websockets,
// deep-research = its own endpoint), and non-conversational specialists.
const NON_CHAT = /(^|[-/])(embed|embedding|tts|whisper|transcribe|realtime|live|image|dall-e|moderation|rerank|guard|audio|video|veo|imagen|lyria|music|robotics|computer-use|deep-research|search-preview|codex-spark)/i;

// Cap on NEWLY ADDED models per provider, so a 400-model aggregator doesn't
// bloat the static fallback. Existing entries are never affected, live
// /models covers the full list at runtime, and the cap is reported below.
const NEW_MODEL_CAP = 25;

/** The reasoning effort levels a model accepts, when the index reports them. */
function effortsOf(model) {
  const values = (model.reasoning_options || [])
    .filter(o => o && o.type === 'effort' && Array.isArray(o.values))
    .flatMap(o => o.values);
  return values.length ? { efforts: [...new Set(values)] } : {};
}

function isChatTextModel(model) {
  if (NON_CHAT.test(model.id)) return false;
  const out = model.modalities?.output;
  const inp = model.modalities?.input;
  if (Array.isArray(out) && !out.includes('text')) return false;
  if (Array.isArray(inp) && !inp.includes('text')) return false;
  if (model.limit && model.limit.context === 0) return false; // non-text endpoints
  return true;
}

/**
 * Cross-check lib/providers/reasoning.js against what models.dev reports each
 * model actually accepts. This cannot regenerate the table — the off-switches
 * come from provider docs — but it catches the dangerous case where we would
 * send a value the model rejects, which is a 400 that breaks the provider.
 */
function auditReasoning(catalogModels, upstream) {
  const problems = [];
  const gaps = [];
  for (const [providerId, models] of Object.entries(catalogModels)) {
    // Anthropic and Google have dedicated adapters that always state their
    // thinking mode; this table only governs the OpenAI-compatible ones.
    if (providerId === 'anthropic' || providerId === 'google') continue;
    const sourceId = PROVIDER_SOURCES[providerId];
    const upstreamModels = sourceId && upstream[sourceId] ? upstream[sourceId].models : null;
    if (!upstreamModels) continue;

    for (const entry of models) {
      const { id } = entry;
      const info = upstreamModels[id];
      if (!info) continue;
      const off = reasoningOffBody(providerId, id, entry);
      const efforts = (info.reasoning_options || [])
        .filter(o => o.type === 'effort' && Array.isArray(o.values))
        .flatMap(o => o.values);

      if (off && off.reasoning_effort && efforts.length && !efforts.includes(off.reasoning_effort)) {
        problems.push(`  ${providerId}/${id}: we send reasoning_effort "${off.reasoning_effort}" but only [${efforts.join(', ')}] are listed`);
      }
      if (!off && info.reasoning === true) {
        gaps.push(`  ${providerId}/${id}: reasons by default, we send nothing`);
      }
    }
  }
  return { problems, gaps };
}

function loadExisting() {
  try {
    delete require.cache[require.resolve(DATA_FILE)];
    return require(DATA_FILE).CATALOG_MODELS || {};
  } catch (err) {
    console.error(`Could not read existing catalog data (${err.message}) — aborting rather than risk dropping models.`);
    process.exit(1);
  }
}

function mergeProvider(existing, upstreamModels) {
  const merged = existing.map(m => ({ ...m }));
  const seen = new Set(merged.map(m => m.id));

  const candidates = Object.values(upstreamModels)
    .filter(isChatTextModel)
    .filter(m => !RETIRED.has(m.id) && !seen.has(m.id))
    .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));

  const added = candidates.slice(0, NEW_MODEL_CAP);
  for (const m of added) merged.push({ id: m.id, label: m.name || m.id, ...effortsOf(m) });

  // Refresh the accepted reasoning levels on models we already listed — this
  // is what stops us sending a value the provider would reject.
  for (const entry of merged) {
    const info = upstreamModels[entry.id];
    if (!info) continue;
    const e = effortsOf(info);
    if (e.efforts) entry.efforts = e.efforts;
    else delete entry.efforts;
  }
  return { merged, addedCount: added.length, skippedCount: candidates.length - added.length };
}

function serialize(catalogModels, sourceDate) {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const body = Object.entries(catalogModels).map(([provider, models]) => {
    const idWidth = Math.max(...models.map(m => JSON.stringify(m.id).length));
    const rows = models
      .map(m => {
        const efforts = m.efforts ? `, efforts: ${JSON.stringify(m.efforts)}` : '';
        return `      { id: ${pad(JSON.stringify(m.id) + ',', idWidth + 1)} label: ${JSON.stringify(m.label)}${efforts} }`;
      })
      .join(',\n');
    return `    ${provider}: [\n${rows}\n    ]`;
  }).join(',\n');

  return `/**
 * lib/providers/catalog-data.js
 * Static model lists per provider — the DATA half of the catalog.
 * Regenerated by scripts/update-catalog.mjs (weekly GitHub Action → PR from
 * models.dev); hand edits are welcome but may be superseded by the next
 * generated PR. Structure/behavior lives in catalog.js, which loads this file
 * first (script tag / importScripts order, require() in tests).
 *
 * These lists are fallbacks and conveniences, never gates: live /models
 * results, user overrides, and the free-text model field extend them at
 * runtime. The generator only ever ADDS models — nothing is removed
 * automatically, because providers keep serving models long after they stop
 * promoting them.
 *
 * Model data last synced from models.dev: ${sourceDate}
 * Last verified against official provider docs: 2026-08-23 (docs/providers/).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  const CATALOG_MODELS = {
${body}
  };

  return { CATALOG_MODELS };
});
`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Fetching ${SOURCE_URL} …`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) {
    console.error(`models.dev returned HTTP ${resp.status} — leaving the catalog untouched.`);
    process.exit(1);
  }
  const upstream = await resp.json();

  const existing = loadExisting();
  const out = {};
  let totalAdded = 0;
  const report = [];

  for (const [providerId, models] of Object.entries(existing)) {
    const sourceId = PROVIDER_SOURCES[providerId];
    const upstreamModels = sourceId && upstream[sourceId] ? upstream[sourceId].models : null;
    if (!upstreamModels) {
      out[providerId] = models;
      report.push(`  ${providerId}: no upstream data — kept ${models.length} existing`);
      continue;
    }
    const { merged, addedCount, skippedCount } = mergeProvider(models, upstreamModels);
    out[providerId] = merged;
    totalAdded += addedCount;
    const skipNote = skippedCount ? ` (${skippedCount} more available, capped at ${NEW_MODEL_CAP} — live model refresh covers the rest)` : '';
    report.push(`  ${providerId}: ${models.length} → ${merged.length} (+${addedCount})${skipNote}`);
  }

  console.log('\nModel counts:');
  console.log(report.join('\n'));
  console.log(`\nTotal new models: ${totalAdded}`);

  // Safety check on the reasoning table (see auditReasoning)
  const { problems, gaps } = auditReasoning(out, upstream);
  if (problems.length) {
    console.log('\n⚠ Reasoning settings that may be REJECTED (fix lib/providers/reasoning.js):');
    console.log(problems.join('\n'));
  } else {
    console.log('\nReasoning settings: no rejected values detected.');
  }
  if (gaps.length) {
    console.log(`\nModels that reason by default where we send nothing (${gaps.length}):`);
    console.log(gaps.slice(0, 15).join('\n'));
    if (gaps.length > 15) console.log(`  …and ${gaps.length - 15} more`);
  }

  if (!totalAdded) {
    console.log('Nothing new — catalog left unchanged.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = serialize(out, today);
  if (dryRun) {
    console.log('\n--dry-run: not writing.');
    return;
  }
  writeFileSync(DATA_FILE, content);
  console.log(`\nWrote ${DATA_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
