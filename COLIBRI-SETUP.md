# Local inference setup

This guide has moved into the documentation site, where it is organized and maintained:

**[Local models](https://rennf93.github.io/hummin/local-models/)** - engine choice (llama.cpp vs colibri), model catalog, downloading, serving (launchd / docker / systemd), connecting hummin, operations and troubleshooting.

Quick start:

```bash
export HUMMIN_COLIBRI_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"   # order = preference
export COLI_API_KEY=...                    # only if the servers enforce a key
hummin                                     # extensions autoload from ~/.hummin/agent/extensions/
```

The docs source lives in [`docs/`](docs/index.md) in this repository; edit it there.
