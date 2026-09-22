---
title: hummin
description: A GLM-native terminal coding agent with first-class local inference
hide:
  - navigation
  - toc
---

<div class="tx-hero" markdown>

# hummin

<p class="tx-tagline">A GLM-native terminal coding agent. Local inference is a first-class citizen, not a compatibility mode: colibri, llama.cpp and Ollama on your own hardware, surfaced in one model picker alongside Z.ai's GLM catalog.</p>

<div class="tx-hero__term">
	<div class="term-bar"><span class="r"></span><span class="y"></span><span class="g"></span></div>

```bash
export HUMMIN_COLIBRI_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"
hummin
# /model -> GLM-5.3-Flash [NAS], Qwen3.8-27B [Mac], your whole fleet, one picker
```

</div>

<div class="tx-hero__buttons" markdown>

[Get started](getting-started/installation.md){ .md-button .md-button--primary }
[Run local models](local-models/index.md){ .md-button }

</div>

</div>

---

## See it in action

Ornith 1.5 35B (local GGUF via llama.cpp) working through four upstream bugs in hummin's own source. Watch the footer: live **tok/s** next to the context bar - 31 tok/s from a model running on a Mac Mini. The full path to this setup is in [Local Models](local-models/index.md).

<img src="assets/demo-ornith.gif" alt="hummin running Ornith 1.5 35B locally at 31 tok/s" style="width: 100%; border-radius: 8px; border: 1px solid var(--md-default-fg-color--lightest);">

---

## Why hummin

<div class="grid cards" markdown>

- :material-code-braces:{ .lg .middle } **GLM first**

	---

	GLM-5.3, GLM-5.3-Flash and GLM-5.3-highspeed ship in the built-in `zai` catalog with 1M-token context and mapped reasoning variants. The default model is GLM.

- :material-server-network:{ .lg .middle } **Local fleet**

	---

	One provider across every OpenAI-compatible server on your LAN: health-probed, serialized per origin, startable straight from the model picker.

- :material-radar:{ .lg .middle } **Agent teamwork**

	---

	Sessions message each other across terminals and projects, share a task board, spawn bounded subagents, run scheduled wake-ups.

- :material-shield-check:{ .lg .middle } **Safety that bites**

	---

	Seatbelt/bubblewrap sandboxing, destructive-command advisories, loop and budget guardrails, checkpoints with `/rewind`.

- :material-brain:{ .lg .middle } **Memory that persists**

	---

	Session distillation into lessons plus a self-curating Obsidian-compatible vault with BM25-ranked recall.

- :material-gauge:{ .lg .middle } **Built for slow models**

	---

	Queue-aware UX, real context windows, idle-timeout tuning and a local-vs-cloud cost split - because a 195GB model streams from disk.

</div>

## From zero to a local model in the terminal

<div class="grid cards" markdown>

- :material-download:{ .lg .middle } **[Download](local-models/downloading.md)**

	---

	Resumable `hf download`, stall-proof flags, the right machine for the WAN pipe.

- :material-play-circle:{ .lg .middle } **[Serve](local-models/serving-llamacpp.md)**

	---

	llama.cpp on Mac (launchd) or Linux (compose); colibri for frontier MoE.

- :material-connection:{ .lg .middle } **[Connect](local-models/fleet.md)**

	---

	One env var, `/model`, done. Fleet start/stop from the picker.

- :material-tune-vertical:{ .lg .middle } **[Operate](local-models/operations.md)**

	---

	Service templates, co-run rules, warm caches, measured numbers.

</div>
