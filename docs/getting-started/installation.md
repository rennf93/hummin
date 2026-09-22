# Installation

## Requirements

- **Node >= 22.19**
- A terminal. hummin is a TUI-first tool; any modern terminal works (iTerm2, Ghostty, kitty, Windows Terminal).

## Install from npm

```bash
npm install -g hummin-cli
```

Verify:

```bash
hummin --version
```

## Install from a clone

```bash
git clone https://github.com/rennf93/hummin.git
cd hummin
npm install
npm run build
cd packages/coding-agent && npm link     # puts `hummin` on your PATH
```

## Authenticate

hummin works with Z.ai's GLM models out of the box:

```bash
export ZAI_API_KEY=your-key     # in ~/.zshrc
# or, interactively:
hummin auth login zai

# sanity-check your credentials:
hummin auth check
```

The GLM catalog (GLM-5.3, GLM-5.3-Flash, GLM-5.3-highspeed) ships built in - no models.json editing needed.

## Where hummin keeps its files

| Path | Purpose |
|---|---|
| `~/.hummin/agent/` | Agent home: settings, extensions, sessions |
| `~/.hummin/agent/extensions/` | TypeScript extensions, autoloaded at startup |
| project dir | `AGENTS.md` context file, project trust state |

## First session

```bash
cd your-project
hummin
```

Type a request, or type `/` to browse every available command. Useful first commands:

- `/model` - pick a model (GLM-5.3 is the default suggestion)
- `/doctor` - verify settings, credentials and extensions
- `/init` - generate an `AGENTS.md` for the project

Next: [Quickstart](quickstart.md) for cloud usage, or [Local Models](../local-models/index.md) to run models on your own hardware.
