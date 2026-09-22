# Quickstart (Z.ai cloud)

The fastest way to a working session: GLM from the cloud, no hardware needed.

## 1. Set your key

```bash
export ZAI_API_KEY=your-key      # add to ~/.zshrc
# or: hummin auth login zai
```

## 2. Start a session

```bash
cd your-project
hummin                            # interactive TUI
```

GLM-5.3 is the default suggestion. Three GLM models ship in the `zai` provider catalog:

| Model | When to use it |
|---|---|
| GLM-5.3 | Flagship quality, 1M-token context |
| GLM-5.3-Flash | Faster, cheaper daily driver |
| GLM-5.3-highspeed | Latency-critical back-and-forth |

Pick with `/model`. The picker's "set as default" action persists your choice.

## 3. Oneshot and scripted use

```bash
hummin -p "summarize this repo"          # print mode: answer, then exit
hummin --mode json                        # JSON event stream, for scripts
```

## 4. Reasoning control

GLM reasoning maps to hummin's thinking level:

```text
/thinking high     # deeper reasoning, slower
/thinking off      # direct answers only
```

## 5. Watch what it is doing

- `/context` - token breakdown with cache-hit ratio
- `/cost` - spend per model
- `/status` - model, memory, todos, TUI state at a glance

## When the cloud is not the answer

If you want models on your own hardware (privacy, zero cost per token, or just because it is fun), the [Local Models](../local-models/index.md) section walks the whole path: download, serve, connect, use.
