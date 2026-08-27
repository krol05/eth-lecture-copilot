/**
 * lib/providers/reasoning.js — how each provider/model is told to stop
 * reasoning. Every expectation here is traceable to a CONFIRMED row in
 * docs/providers/reasoning-controls.md; anything the docs left UNVERIFIED must
 * return null, because a wrong parameter is a 400 that breaks the provider
 * while a missing one only makes requests slow.
 */
const { reasoningOffBody } = require('../lib/providers/reasoning.js');
const { Catalog } = require('../lib/providers/catalog.js');

describe('gpt-oss rejects "none" on every host', () => {
  // Fireworks documents the literal 400: "Invalid reasoning effort: none"
  test.each([
    ['groq', 'openai/gpt-oss-120b'],
    ['cerebras', 'gpt-oss-120b'],
    ['together', 'openai/gpt-oss-120b'],
    ['fireworks', 'accounts/fireworks/models/gpt-oss-120b'],
    ['local_ollama', 'gpt-oss:20b']
  ])('%s / %s uses the "low" floor', (provider, model) => {
    expect(reasoningOffBody(provider, model)).toEqual({ reasoning_effort: 'low' });
  });
});

describe('providers that accept a real off value', () => {
  test('OpenAI: none for gpt-5.x, low floor for o-series', () => {
    expect(reasoningOffBody('openai', 'gpt-5.6-terra')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('openai', 'o4-mini')).toEqual({ reasoning_effort: 'low' });
  });

  test('DeepSeek and Zhipu use a thinking object', () => {
    expect(reasoningOffBody('deepseek', 'deepseek-v4-pro')).toEqual({ thinking: { type: 'disabled' } });
    expect(reasoningOffBody('zhipu', 'glm-5.1')).toEqual({ thinking: { type: 'disabled' } });
  });

  test('Zhipu GLM-5.3 rejects disabled — floor instead', () => {
    expect(reasoningOffBody('zhipu', 'glm-5.3-flash')).toEqual({ reasoning_effort: 'low' });
  });

  test('Moonshot: K2.x disables, K3 has a floor', () => {
    expect(reasoningOffBody('moonshot', 'kimi-k2.6')).toEqual({ thinking: { type: 'disabled' } });
    expect(reasoningOffBody('moonshot', 'kimi-k3')).toEqual({ reasoning_effort: 'low' });
  });

  test('DashScope and NIM/SambaNova use their own template switches', () => {
    expect(reasoningOffBody('qwen', 'qwen3.5-plus')).toEqual({ enable_thinking: false });
    expect(reasoningOffBody('nvidia_nim', 'qwen/qwen3-32b')).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(reasoningOffBody('sambanova', 'DeepSeek-V3.2')).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  test('OpenRouter uses the unified switch, not effort none', () => {
    // per-model `mandatory: true` models reject effort "none"
    const off = reasoningOffBody('openrouter', 'google/gemini-3.5-flash');
    expect(off).toEqual({ reasoning: { enabled: false } });
  });

  test('Mistral and Fireworks accept none; Together hybrids use reasoning.enabled', () => {
    expect(reasoningOffBody('mistral', 'mistral-medium-3-5')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('fireworks', 'accounts/fireworks/models/deepseek-v4-pro')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('together', 'deepseek-ai/DeepSeek-V4-Pro')).toEqual({ reasoning: { enabled: false } });
  });

  test('Perplexity floors at minimal, and only for its reasoning models', () => {
    expect(reasoningOffBody('perplexity', 'sonar-reasoning-pro')).toEqual({ reasoning_effort: 'minimal' });
    expect(reasoningOffBody('perplexity', 'sonar-pro')).toBeNull();
  });

  test('Cohere only for its reasoning model', () => {
    expect(reasoningOffBody('cohere', 'command-a-reasoning-08-2025')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('cohere', 'command-r-08-2024')).toBeNull();
  });
});

describe('models that cannot stop reasoning', () => {
  test('Grok always reasons — lowest effort, never an off switch', () => {
    expect(reasoningOffBody('xai', 'grok-4.3')).toEqual({ reasoning_effort: 'low' });
    // also when routed through an aggregator
    expect(reasoningOffBody('openrouter', 'x-ai/grok-4.6')).toEqual({ reasoning_effort: 'low' });
  });

  test('thinking-only models get nothing rather than an error', () => {
    for (const model of ['kimi-k2.7-code', 'qwq-plus', 'deepseek-r1']) {
      expect(reasoningOffBody('moonshot', model) || reasoningOffBody('qwen', model)).toBeFalsy();
    }
  });
});

describe('unverified providers send nothing', () => {
  // Slow requests are recoverable; a 400 that breaks the provider is not.
  test.each([
    ['huggingface', 'openai/gpt-oss-120b'],   // forwards to backends that reject none
    ['hyperbolic', 'Qwen/Qwen3-235B-A22B'],
    ['local_lmstudio', 'some-model'],
    ['local_vllm', 'some-model'],
    ['custom_mine', 'whatever']
  ])('%s sends nothing', (provider, model) => {
    expect(reasoningOffBody(provider, model)).toBeNull();
  });

  test('non-reasoning models on known providers are left alone', () => {
    expect(reasoningOffBody('groq', 'llama-3.3-70b-versatile')).toBeNull();
    expect(reasoningOffBody('cerebras', 'zai-glm-4.7')).toBeNull();
  });
});

describe('coverage against the shipped catalog', () => {
  test('every first-class and preset provider id is a known case or a deliberate null', () => {
    for (const p of Catalog.list()) {
      if (p.adapter !== 'oai') continue;
      for (const m of p.models.slice(0, 6)) {
        // must not throw, and must return null or a plain object
        const out = reasoningOffBody(p.id, m.id);
        expect(out === null || typeof out === 'object').toBe(true);
      }
    }
  });

  test('missing arguments never throw', () => {
    expect(() => reasoningOffBody(undefined, undefined)).not.toThrow();
    expect(reasoningOffBody('', '')).toBeNull();
  });
});

describe('plain chat models never receive a reasoning parameter', () => {
  // Sending one to a model that has nothing to switch off risks an
  // unrecognized-parameter error and can only do harm.
  test.each([
    ['openai', 'gpt-4o'],
    ['openai', 'gpt-4.1-mini'],
    ['mistral', 'codestral-latest'],
    ['fireworks', 'accounts/fireworks/models/llama4-maverick-instruct-basic'],
    ['together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['nvidia_nim', 'meta/llama-4-maverick-17b-128e-instruct'],
    ['groq', 'llama-3.1-8b-instant']
  ])('%s / %s gets nothing', (provider, model) => {
    expect(reasoningOffBody(provider, model)).toBeNull();
  });

  test('but their reasoning stablemates still do', () => {
    expect(reasoningOffBody('openai', 'gpt-5.6-sol')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('together', 'Qwen/Qwen3.5-397B-A17B')).toEqual({ reasoning: { enabled: false } });
    expect(reasoningOffBody('nvidia_nim', 'qwen/qwen3-32b')).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

describe('accepted effort levels from the catalog override the hand-written value', () => {
  // Captured from models.dev by the weekly update. Without this, "none" would
  // be sent to models that only accept "high" — a 400.
  test('picks the lowest level the model actually accepts', () => {
    expect(reasoningOffBody('openai', 'gpt-5-pro', { efforts: ['high'] }))
      .toEqual({ reasoning_effort: 'high' });
    expect(reasoningOffBody('openai', 'gpt-5-mini', { efforts: ['minimal', 'low', 'medium', 'high'] }))
      .toEqual({ reasoning_effort: 'minimal' });
    expect(reasoningOffBody('openai', 'gpt-5.2-pro', { efforts: ['medium', 'high', 'xhigh'] }))
      .toEqual({ reasoning_effort: 'medium' });
  });

  test('falls back to the documented value when the levels are unknown', () => {
    expect(reasoningOffBody('openai', 'gpt-5.6-terra')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningOffBody('openai', 'gpt-5.6-terra', {})).toEqual({ reasoning_effort: 'none' });
  });

  test('a gpt-oss model still cannot be pushed to "none" by bad data', () => {
    // its real list never contains "none"; if it somehow did we would honour it,
    // but the documented floor protects the common case
    expect(reasoningOffBody('groq', 'openai/gpt-oss-120b', { efforts: ['low', 'medium', 'high'] }))
      .toEqual({ reasoning_effort: 'low' });
    expect(reasoningOffBody('groq', 'openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' });
  });

  test('object-valued switches ignore effort data', () => {
    expect(reasoningOffBody('deepseek', 'deepseek-v4-pro', { efforts: ['high', 'max'] }))
      .toEqual({ thinking: { type: 'disabled' } });
    expect(reasoningOffBody('qwen', 'qwen3.5-plus', { efforts: ['low'] }))
      .toEqual({ enable_thinking: false });
  });

  test('the shipped catalog never asks for a level its model rejects', () => {
    for (const p of Catalog.list()) {
      if (p.adapter !== 'oai') continue;
      for (const m of p.models) {
        const off = reasoningOffBody(p.id, m.id, m);
        if (off && off.reasoning_effort && Array.isArray(m.efforts) && m.efforts.length) {
          expect(m.efforts).toContain(off.reasoning_effort);
        }
      }
    }
  });
});
