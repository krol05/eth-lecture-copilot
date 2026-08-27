# Keeping the AI providers working

This document explains the machinery that stops the extension from breaking when
providers change their APIs, why it is built this way, and what to do when part
of it complains.

## The problem it solves

This extension talks to roughly thirty AI providers. It went unmaintained for
three months and most providers stopped working — not because the code was
wrong when it was written, but because the world moved:

- Model IDs were retired. DeepSeek removed `deepseek-chat` and
  `deepseek-reasoner` outright; requests to them now fail rather than falling
  back to something sensible.
- Parameters changed meaning. Anthropic's `thinking: {budget_tokens}` became a
  400 error on newer models, which need `{type: "adaptive"}` instead.
- Defaults changed underneath us. Several models now reason by default when the
  reasoning parameter is absent, so a request that used to be fast started
  taking minutes with no output — indistinguishable from a hang.

None of this produces a compile error or a failing unit test. It produces a
broken extension for a user who has no idea why. The goal of everything below is
that these changes get noticed by us, not by them.

## Layers

Four layers, from most to least automatic. Each catches things the others
cannot; none is sufficient alone.

| Layer | Runs | Catches | Cannot catch |
|---|---|---|---|
| Request parameter check | Every provider-code change + weekly | Sending a parameter or value the provider does not document | Whether a provider still honours its own documentation |
| Model catalog sync | Weekly | New models; reasoning levels a model no longer accepts | Anything about request shape |
| Background test suite | Every test run | Our own plumbing: aborts, timeouts, error shapes, streaming, caching | Anything about what providers actually accept |
| Provider research docs | By hand, on demand | Everything else — parameter names, defaults, quirks | Nothing, but it goes stale silently |

### 1. Request parameter check

`scripts/check-api-params.mjs` — workflow `.github/workflows/check-api-params.yml`

Builds the request bodies our adapters actually produce, across six option
combinations (plain, thinking, streaming + JSON mode, structured output, token
cap + temperature, image input), and validates every parameter and every
constrained value.

It works in two tiers because only some providers publish a machine-readable
schema.

**Spec-checked** — validated against the provider's own published schema:

- **OpenAI** — the official `openapi.yaml`.
- **Anthropic** — their SDK repository publishes a `.stats.yml` containing the
  URL of their real OpenAPI spec. The script reads that file to find the spec,
  so it keeps working when they publish a new one.
- **Google** — the Generative Language API discovery document.
- **Cerebras** — publishes a spec the same way Anthropic does. Worth having even
  though it is a small provider: it independently validates our generic
  OpenAI-compatible adapter against somebody else's implementation of that API,
  rather than only against OpenAI's own.

**Baseline-checked** — the other 28 providers. Groq, xAI, Mistral, Together,
Perplexity, OpenRouter, Moonshot and the rest were all checked for a published
spec; none has one. For these, every parameter we send must be either:

- part of OpenAI's Chat Completions schema, which they all claim compatibility
  with, or
- listed in the `DOCUMENTED_EXTENSIONS` registry at the top of the script, with
  a note saying where it is documented.

Anything else fails the build. The registry currently holds four entries:
`thinking`, `enable_thinking`, `chat_template_kwargs` and `reasoning`.

**Why a registry rather than a permissive allowlist.** The realistic failure is
not a provider inventing a parameter — it is *us* adding one from memory or a
blog post and never verifying it. Requiring a citation makes that impossible to
do accidentally. Adding a parameter without documenting it turns CI red.

**What this cannot do.** For the 28 baseline providers it proves we never send
anything undocumented; it cannot prove the provider still accepts what its
documentation describes. Only a live call with a real key could, and CI has no
keys — see "Why there are no live API calls" below.

On a scheduled failure the workflow opens a GitHub issue (or comments on the
open one) rather than only turning a tick red, because a provider changing their
API while nobody is working on the extension is exactly the case where a red
tick goes unseen.

### 2. Model catalog sync

`scripts/update-catalog.mjs` — workflow `.github/workflows/update-models.yml`

Weekly, pulls [models.dev](https://models.dev) and regenerates
`lib/providers/catalog-data.js`, then opens a pull request. Never pushes
directly — model lists are user-facing and deserve a human glance.

Two rules matter more than the rest:

**Additive only.** Models already listed are never removed, only added to.
Providers keep serving models long after they stop promoting them, and a
disappearing entry silently breaks the setup of whoever was using it. Only IDs
verified as *retired* (in the script's `RETIRED` set) are kept out, because
those genuinely fail.

**Reasoning levels are refreshed too.** models.dev reports which effort levels
each model accepts, and those land in the catalog as `efforts`. This is load
bearing: `gpt-5-pro` accepts only `high`, and the `-pro` variants only
`medium` and above. A hand-written table said `none` for all of them, which
would have been rejected. The data decides the value now; the documentation only
decides which *parameter* to use.

The job also prints two audits into the PR body: any value we would send that a
model rejects, and any model that reasons by default where we send nothing.

Newly added models are capped at 25 per provider so a 400-model aggregator does
not bloat the offline fallback — and the PR states how many were left out rather
than hiding the truncation. The live model refresh inside the extension covers
the full list at runtime anyway.

### 3. Background test suite

`tests/background-routing.test.js` with `tests/helpers/service-worker.js`

Runs the real `background.js` inside a fake Chrome environment — stubbed
`chrome.*`, `fetch` and `importScripts` — so the whole message-handling path can
be exercised in Node with no browser and no API keys. This covers the things
that were hardest to verify by hand: Stop actually cancelling a request, a dead
provider timing out instead of hanging, errors keeping the full provider
response, streaming including split frames and mid-stream errors, custom
endpoints, keys never leaking to local servers, and the model cache.

`tests/reasoning.test.js` pins the reasoning table to the documentation, and
asserts the shipped catalog never asks a model for a level it rejects.

### 4. Provider research documents

`docs/providers/*.md`

Collected by hand (via research agents) from official documentation, each with a
retrieval date and source URLs. These are the ground truth for everything the
machines cannot derive: endpoint shapes, authentication, thinking parameters,
streaming event formats, error envelopes, retired models.

Quality is uneven and the files say so:

- `anthropic.md`, `openai.md`, `google.md`, `deepseek.md`, `openrouter.md` each
  got a dedicated deep pass. Treat as reliable.
- `reasoning-controls.md` covers one question across every provider and marks
  each row CONFIRMED or UNVERIFIED. Reliable where it says CONFIRMED.
- `oai-compat.md` covered nine providers in a single pass and carries a long
  UNVERIFIED list. **Treat with suspicion beyond base URLs.** Two real bugs came
  from trusting it.

Refresh these when a provider starts failing in a way the automation cannot
explain, or every few months. There is no way to automate it — it requires
reading prose.

## Design decisions

### Why there are no live API calls in CI

The strongest possible check would call each provider with a real key. We do not
do this because it would require storing keys for thirty providers in repository
secrets, it would cost money on every run, and rate limits would make failures
ambiguous — a red build that might mean "the API changed" or might mean "we were
throttled" trains people to ignore red builds. The two-tier scheme gets most of
the value with none of that.

### Why unverified providers are left alone

When the documentation does not confirm how to disable reasoning for a provider,
`lib/providers/reasoning.js` returns `null` and we send nothing.

The asymmetry is the whole argument. Sending a wrong parameter produces a 400
that breaks *every* request to that provider for *every* user. Sending nothing
produces a slower request — annoying, visible (tool generations stream, so
progress is obvious), and recoverable. Never guess in the direction that breaks
things.

### Why the reasoning table is per-model, not per-provider

There is no universal way to turn reasoning off:

- `"none"` is rejected by every `gpt-oss` model on every host — Fireworks
  documents the literal error `Invalid reasoning effort: none`.
- xAI cannot disable reasoning at all and defaults to `high`.
- It varies *within* a provider: on Groq, qwen accepts `none` but gpt-oss does
  not; GLM-5.3 rejects what GLM-5.2 requires.
- Four different parameter names are in use.

Hence a table keyed on provider *and* model, with the accepted values supplied by
data rather than by hand.

### Why model lists are never pruned automatically

Covered above, but it is the decision most likely to be second-guessed: the
lists look untidy and full of old models. That is deliberate. Someone is using
`gpt-4o` deliberately, and an automated tidy-up that removes it breaks them for
no benefit. The free-text model field exists for the same reason — no list is
ever a gate.

### Why the catalog is split in two

`catalog-data.js` holds only model lists and is machine-regenerated;
`catalog.js` holds structure and behaviour and is hand-written. A generator that
rewrites a file containing logic will eventually eat something it should not.

## When something fails

**The parameter check fails.** Read which provider and parameter. Either they
changed their API — check their changelog, update `lib/providers/adapters.js`
and the relevant `docs/providers/*.md` — or an adapter gained a parameter that
was never documented, in which case document it or remove it. Do not silence it
by adding the parameter to `DOCUMENTED_EXTENSIONS` without a real source.

**The catalog PR shows rejected reasoning values.** The model's accepted levels
changed. Usually the fix is nothing at all, because the value is now data-driven
— but if the warning persists after merging, the fallback in
`lib/providers/reasoning.js` needs adjusting.

**A user reports a provider failing.** The error panel shows the provider's full
response including the raw JSON body. That is normally enough to identify the
parameter at fault without reproducing anything.

## Setup

Both scheduled workflows need two things that are easy to miss:

1. **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions
   to create and approve pull requests"** must be enabled. It is off by default,
   and without it the catalog job does all its work and then fails with a 403 at
   the final step.
2. **Scheduled workflows only run from the default branch.** While these live on
   a feature branch, neither the weekly cron nor the manual "Run workflow"
   button will appear. Both activate on merge to `master`.

No secrets or tokens are required — models.dev and the provider specs are public,
and `GITHUB_TOKEN` is provided automatically.

Locally:

```bash
npm run check:api        # validate request parameters against provider specs
npm run update:catalog   # refresh model lists (add --dry-run to preview)
npm test                 # unit + background routing tests
npm run lint
```
