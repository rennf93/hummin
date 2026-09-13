# zcode-cli

A GLM-native terminal coding agent: the [pi agent harness](https://github.com/earendil-works/pi) (MIT, by Mario Zechner / earendil-works) retuned for Z.ai's GLM models and [colibri](https://github.com/JustVugg/colibri) local inference.

Why a fork: GLM is a first-class citizen here, not a compatibility mode. The provider picker surfaces Z.ai and your local colibri instances first, the default model is GLM, and the whole tool assumes you may be talking to a slow, disk-streaming local model instead of a datacenter.

> Based on [pi](https://github.com/earendil-works/pi). All credit for the agent core goes upstream; this fork only curates, extends, and rebrands. License: MIT (see [LICENSE](LICENSE)).

## Status

Early and moving fast. The working spec lives in Renn's local clone (not part of the public repo):

- M0 rebrand + build: done
- M1 Z.ai catalog: done upstream (GLM-5.3 / GLM-5.3-Flash ship in the zai provider); live acceptance pending
- M2 colibri extension: scaffolded and mock-tested; queue-aware UX and zero-config autoload next
- M3 docs/branding/release: in progress

## Install

From a clone:

```bash
npm install
npm run build
cd packages/coding-agent && npm link     # puts `zcode` on your PATH
```

Requires Node >= 22.19.

## Quickstart (Z.ai cloud)

```bash
export ZAI_API_KEY=your-key      # or run `zcode auth login zai`
zcode                            # interactive TUI; GLM-5.3 is the default suggestion
zcode -p "summarize this repo"   # oneshot mode
```

GLM-5.3, GLM-5.3-Flash and GLM-5.3-highspeed ship in the `zai` provider catalog (1M-token context, reasoning variants mapped to `reasoning_effort`). Pick models with `/model`; set a persistent default with the picker's "set as default" action.

## Local colibri

[Colibri](https://github.com/JustVugg/colibri) streams frontier MoE models (GLM-5.3, GLM-5.3-Flash, ...) off NVMe on consumer hardware and serves an OpenAI-compatible API. The bundled `zcode-colibri` extension registers one provider per instance:

**Full walkthrough - installing colibri, downloading the model containers, running and keeping the server alive on any Linux box or Mac: [COLIBRI-SETUP.md](COLIBRI-SETUP.md).**

```bash
export ZCODE_COLIBRI_INSTANCES="http://nas:9998,http://nas:9997"
export COLI_API_KEY=...                    # only if the server enforces COLI_API_KEY
zcode -e /path/to/packages/coding-agent/extensions/colibri.ts
```

Behavior:

- Instances without a reachable `/v1/models` register nothing (no broken providers).
- One generation at a time per instance is handled, not thrown at you: requests are serialized per instance and the documented busy response (429 + `x-colibri-queue-wait-ms`) is retried with capped backoff.
- `ZCODE_COLIBRI_CTX` overrides the advertised context window (default 16384).

Making the extension load without `-e` is M2 work (see spec).

### Developing without a NAS

A mock colibri server speaks the same surface (streaming, `/health`, `/v1/models`, 429 queueing):

```bash
node scripts/mock-colibri.mjs --port 9998 --model glm-5.3-flash
ZCODE_COLIBRI_INSTANCES="http://127.0.0.1:9998" \
  zcode -e packages/coding-agent/extensions/colibri.ts -p "hello"
```

## GLM-first curation

- `/model` picker: current model, saved default, then zai/colibri providers, then the rest alphabetically.
- `/login`: curated providers first. Other built-ins are hidden unless already configured; set `"providers": { "showAll": true }` in settings to always see everything.
- Default theme: `zcode-dark` (override with `"theme"` in settings or the first-run dialog).

## Differences from upstream pi

- Rebranded binary/config (`zcode`, `~/.zcode/agent`) via pi's official `piConfig` fork support.
- GLM-first provider curation and defaults (this README).
- `zcode-colibri` extension + mock server.
- One upstream build fix (`FinishReason.TOO_MANY_TOOL_CALLS` handling) pending upstream discussion.

Everything else is upstream pi: sessions, extensions API, themes, tools, RPC/JSON modes. Read upstream's docs under [packages/coding-agent/docs](packages/coding-agent/docs).

## Contributing

This fork follows upstream's bar: understand your code, keep the core minimal, prefer extensions. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for the rules that apply to agent-written changes.
