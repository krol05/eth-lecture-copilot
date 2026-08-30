#!/usr/bin/env python3
"""
scripts/litellm-params.py
Asks LiteLLM which parameters each provider accepts, and prints the answer as
JSON on stdout for scripts/check-api-params.mjs to check our adapters against.

Why this exists: most of the ~30 providers we support publish no machine-
readable schema, so our own check can only confirm we send OpenAI-compatible
parameters. LiteLLM talks to all of them for real and keeps a per-provider
parameter list, which is the closest thing to an authoritative second opinion
that does not require an API key.

Nothing here ships to users — this is a CI/dev dependency only. The extension
has no Python and no build step.

Input : JSON on argv[1] — {"<our provider id>": {"litellm": "<their id>",
                            "model": "<model id>"}, ...}
Output: JSON on stdout  — {"<our provider id>": {"params": [...]}}
        or {"<id>": {"error": "..."}} when LiteLLM cannot answer.

Usage: python3 scripts/litellm-params.py '{"groq": {...}}'
"""
import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: litellm-params.py '<json>'", file=sys.stderr)
        return 2

    try:
        import litellm
    except ImportError:
        print(json.dumps({"__unavailable__": "litellm is not installed"}))
        return 0

    # LiteLLM chats to the network on import for some configs; make sure a CI
    # run can never hang or phone home because of us.
    litellm.suppress_debug_info = True
    litellm.telemetry = False

    requested = json.loads(sys.argv[1])
    out = {}
    for our_id, spec in requested.items():
        provider = spec.get("litellm")
        model = spec.get("model")
        if not provider or not model:
            continue
        try:
            params = litellm.get_supported_openai_params(
                model=model, custom_llm_provider=provider
            )
            out[our_id] = {"params": sorted(params or []), "model": model}
        except Exception as err:                       # noqa: BLE001 - report, never fail the run
            out[our_id] = {"error": f"{type(err).__name__}: {err}"}

    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
