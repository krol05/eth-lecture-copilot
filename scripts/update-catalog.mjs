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

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchModelsDev, fetchLiteLLM } from './lib/model-sources.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { reasoningOffBody } = require('../lib/providers/reasoning.js');
const DATA_FILE = join(ROOT, 'lib/providers/catalog-data.js');

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
//
// This regex is the ONLY thing standing between us and junk entries. The
// modality check below cannot help: models.dev reports embedding models
// (baai/bge-m3), protein models (meta/esmfold) and audio models
// (nvidia/studiovoice) all as plain "text -> text" with a normal context
// length. Judge by name or not at all.
//
// Matched only at a word boundary, for tokens that would otherwise hit real
// chat models ("live" inside "olive", "sam" inside "samantha").
//
// Short or dictionary-word tokens ALSO need a boundary on the right, or they
// eat real models: "music" matched "gemma-4-26b-a4b-it-musica", a 262k-context
// tool-calling chat model. Tokens that legitimately run into other words
// ("embed" in "nv-embedcode", "rerank" in "reranker") must stay loose.
const WHOLE_WORD = ['music', 'esm', 'e5', 'gte', 'bge', 'asr', 'stt', 'sana', 'depth',
  'canary', 'riva', 'veo', 'ocr', 'tts', 'live', 'safety', 'guard', 'shield'];
const LOOSE = ['embed', 'embedding', 'embedqa', 'whisper', 'transcribe', 'realtime',
  'image', 'dall-e', 'moderation', 'rerank', 'reranker', 'jailbreak', 'topic-control',
  'gliner', 'content-safety', 'audio', 'video', 'imagen', 'lyria', 'robotics',
  'computer-use', 'deep-research', 'search-preview', 'codex-spark', 'paligemma',
  'retriever', 'nemoretriever', 'sam2', 'segment', 'upscal', 'parakeet', 'fastpitch',
  'hifigan', 'esmfold', 'evo2', 'molmim', 'diffdock', 'alphafold', 'proteinmpnn', 'genemol',
  'nv-embed', 'arctic-embed'];

const NON_CHAT = new RegExp(
  `(^|[-/_])(?:(?:${WHOLE_WORD.join('|')})(?![a-z])|(?:${LOOSE.join('|')}))`, 'i');

// Matched anywhere in the id — unambiguous enough that a substring hit is
// always a non-chat model. ("studiovoice" has no separator before "voice".)
const NON_CHAT_ANY = /(voice|speech|embedding|reranker)/i;

// models.dev marks "latest" alias rows with a leading "~". That prefix is its
// own bookkeeping, not part of any provider's model id — sending
// "~x-ai/grok-latest" would 404. Never add them, and prune any that an earlier
// run let through.
const ALIAS_PREFIX = '~';

// Providers whose catalogue is a marketplace of hundreds of third-party models
// (OpenRouter alone lists 354). Auto-adding "the newest 25" every week grows
// these lists without bound and mostly surfaces models nobody asked for, so we
// keep the curated seed list and let the runtime /models fetch — which is
// unfiltered and complete — cover the real range. Their existing entries are
// still kept and still get their reasoning levels refreshed.
const AGGREGATORS = new Set(['openrouter', 'nvidia_nim', 'huggingface']);

// Cap on NEWLY ADDED models per provider (non-aggregators only). Existing
// entries are never affected, live /models covers the full list at runtime,
// and the cap is reported below.
const NEW_MODEL_CAP = 25;

/** The reasoning effort levels a model accepts, when the index reports them. */
function effortsOf(model) {
  const values = (model.reasoning_options || [])
    .filter(o => o && o.type === 'effort' && Array.isArray(o.values))
    .flatMap(o => o.values);
  return values.length ? { efforts: [...new Set(values)] } : {};
}

/**
 * Is this something a chat-completions call can talk to?
 *
 * Three independent opinions, and a NO from any of them disqualifies. That
 * asymmetry is deliberate: a wrongly-excluded model is merely absent from a
 * dropdown (the live /models list and the free-text field still reach it),
 * while a wrongly-included one is a broken choice we offered the user.
 *
 * `lite` is LiteLLM's view, or null when it doesn't list the model. It is the
 * only source that states a purpose outright, but it covers ~79% of our
 * catalog and mislabels the odd classifier as `chat`, so the name pattern
 * stays as the fallback rather than being replaced by it.
 */
function isChatTextModel(model, lite) {
  if (model.id.startsWith(ALIAS_PREFIX)) return false;
  if (lite && lite.mode && lite.mode !== 'chat' && lite.mode !== 'completion') return false;
  if (NON_CHAT.test(model.id) || NON_CHAT_ANY.test(model.id)) return false;
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

/** Upstream names are sometimes just the id again, or carry a vendor prefix. */
function cleanLabel(model) {
  const name = String(model.name || '').trim();
  const bare = model.id.includes('/') ? model.id.slice(model.id.lastIndexOf('/') + 1) : model.id;
  if (!name || name === model.id || name === bare) return bare;
  return name.replace(/^[\w .-]{2,20}:\s+/, '');   // "NVIDIA: Nemotron 3" -> "Nemotron 3"
}

function mergeProvider(existing, upstreamModels, { addNew = true, lite = null } = {}) {
  const liteFor = id => (lite ? lite.get(id) : null);

  // Alias rows are not real model ids; drop any a previous run added.
  const kept = existing.filter(m => !m.id.startsWith(ALIAS_PREFIX));
  const prunedCount = existing.length - kept.length;

  const merged = kept.map(m => ({ ...m }));
  const seen = new Set(merged.map(m => m.id));

  const candidates = addNew
    ? Object.values(upstreamModels)
      .filter(m => isChatTextModel(m, liteFor(m.id)))
      .filter(m => !RETIRED.has(m.id) && !seen.has(m.id))
      .sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')))
    : [];

  const added = candidates.slice(0, NEW_MODEL_CAP);
  for (const m of added) merged.push({ id: m.id, label: cleanLabel(m), ...effortsOf(m) });

  // Refresh what each model says about reasoning. This is what stops us
  // sending a value the provider would reject.
  //
  //   efforts   the levels the model accepts. models.dev is the primary source
  //             because it is per-provider; LiteLLM fills in models it has no
  //             opinion on.
  //   alwaysOn  the model reasons no matter what, so an "off" value is an error
  //             rather than a no-op. Hand-maintained as a regex before this.
  let alwaysOnCount = 0;
  for (const entry of merged) {
    const info = upstreamModels[entry.id];
    const l = liteFor(entry.id);

    const fromDev = info ? effortsOf(info).efforts : null;
    const efforts = fromDev || (l && l.levels) || null;
    if (efforts) entry.efforts = efforts;
    else delete entry.efforts;

    if (l && l.alwaysOn) { entry.alwaysOn = true; alwaysOnCount++; }
    else delete entry.alwaysOn;
  }
  return {
    merged,
    addedCount: added.length,
    skippedCount: candidates.length - added.length,
    prunedCount,
    alwaysOnCount
  };
}

// Column width for the id field. A FIXED constant on purpose: deriving it from
// the data (max id length) meant that one unusually long new id re-padded every
// other row in that provider, so a PR adding 3 models showed 60 changed lines
// of pure whitespace. Ids longer than this simply overflow their own row and
// leave every other line untouched. Changing this number reformats the whole
// file once, so don't, unless that is what you want.
const ID_COLUMN = 46;

/** The sync date changes every run; ignore it when asking "did anything change". */
function stripSyncDate(text) {
  return text.replace(/Model data last synced from models\.dev: .*/, '');
}

function serialize(catalogModels, sourceDate) {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const body = Object.entries(catalogModels).map(([provider, models]) => {
    const rows = models
      .map(m => {
        const efforts = m.efforts ? `, efforts: ${JSON.stringify(m.efforts)}` : '';
        const always = m.alwaysOn ? ', alwaysOn: true' : '';
        return `      { id: ${pad(JSON.stringify(m.id) + ',', ID_COLUMN + 1)} label: ${JSON.stringify(m.label)}${efforts}${always} }`;
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

  console.log('Fetching models.dev …');
  let upstream;
  try {
    upstream = await fetchModelsDev();
  } catch (err) {
    console.error(`${err.message} — leaving the catalog untouched.`);
    process.exit(1);
  }

  // LiteLLM is a supplement, not a requirement: it tells us what a model is FOR
  // and whether its reasoning can be switched off. If it is unreachable we
  // still run, just with the name pattern doing the filtering on its own.
  let lite = null;
  try {
    console.log('Fetching LiteLLM model metadata …');
    lite = await fetchLiteLLM();
    console.log(`  ${lite.size} models described`);
  } catch (err) {
    console.log(`  unavailable (${err.message}) — falling back to name matching alone`);
  }

  const existing = loadExisting();
  const out = {};
  let totalAdded = 0;
  let totalAlwaysOn = 0;
  const report = [];

  for (const [providerId, models] of Object.entries(existing)) {
    const sourceId = PROVIDER_SOURCES[providerId];
    const upstreamModels = sourceId && upstream[sourceId] ? upstream[sourceId].models : null;
    if (!upstreamModels) {
      out[providerId] = models;
      report.push(`  ${providerId}: no upstream data — kept ${models.length} existing`);
      continue;
    }
    const isAggregator = AGGREGATORS.has(providerId);
    const { merged, addedCount, skippedCount, prunedCount, alwaysOnCount } =
      mergeProvider(models, upstreamModels, { addNew: !isAggregator, lite });
    out[providerId] = merged;
    totalAdded += addedCount;
    totalAlwaysOn += alwaysOnCount;

    const notes = [];
    if (isAggregator) {
      notes.push(`marketplace — not auto-extended, live /models covers its ${Object.keys(upstreamModels).length} models`);
    } else if (skippedCount) {
      notes.push(`${skippedCount} more available, capped at ${NEW_MODEL_CAP} — live model refresh covers the rest`);
    }
    if (prunedCount) notes.push(`${prunedCount} alias id${prunedCount > 1 ? 's' : ''} removed`);
    const note = notes.length ? ` (${notes.join('; ')})` : '';
    report.push(`  ${providerId}: ${models.length} → ${merged.length} (+${addedCount})${note}`);
  }

  console.log('\nModel counts:');
  console.log(report.join('\n'));
  console.log(`\nTotal new models: ${totalAdded}`);
  if (lite) {
    console.log(`Models flagged as reasoning-always-on (no off switch): ${totalAlwaysOn}`);
  }

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

  // Compare against the file as it stands rather than trusting the added
  // count: refreshed reasoning levels and pruned alias ids are real changes
  // that add no models, and an early return here used to discard them.
  const today = new Date().toISOString().slice(0, 10);
  const previous = readFileSync(DATA_FILE, 'utf8');
  const content = serialize(out, today);
  const unchangedApartFromDate =
    stripSyncDate(content) === stripSyncDate(previous);

  if (unchangedApartFromDate) {
    console.log('\nNothing to change — catalog left untouched.');
    return;
  }
  if (dryRun) {
    console.log(`\n--dry-run: would write ${DATA_FILE}.`);
    return;
  }
  writeFileSync(DATA_FILE, content);
  console.log(`\nWrote ${DATA_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
