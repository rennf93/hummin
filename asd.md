I created murmur — a group-chat layer for Claude Code sessions (and other LLM CLI) — and benchmark it against Claude Code's native SendMessage flow: 3 sessions (an Implementer plus two Peers), one task ("ask both peers to check a regex, wait for both answers, report"), model haiku, Claude Code 2.1.304, 3 runs per arm. All numbers come from each session's own transcript from the task prompt onward, deduplicated by message id; the murmur arm is cross-checked against the broker's deliveries table. Everything is regenerable: make bench-consult re-runs the whole matrix live and rewrites docs/bench/consult.md.

Someone recently asked the obvious follow-up to our headline numbers (363k vs 511k raw tokens, 9 vs 13 API calls): how much of that input was billed as cache reads rather than fresh tokens? Here is the split — medians over 3 runs per arm, all three sessions summed per run:

| arm | completed | fresh in | cache write | cache read | out | total | read % | API calls | $ / task* |
| --- | --------- | -------- | ----------- | ---------- | --- | ----- | ------ | --------- | --------- |
| native SendMessage | 0 / 3 | 18 | 15,772 | 250,956 | 1,540 | 268k | 93.5% | 7 | $0.0525 † |
| native SendMessage, prompt told how replies return | 3 / 3 | 32 | 22,050 | 486,468 | 2,317 | 511k | 95.2% | 13 | $0.0878 |
| murmur             | 3 / 3 | 22 | 17,365 | 343,788 | 1,704 | 363k | 94.7% | 9 | $0.0646 |

* Haiku list prices, 2026-10. † Arm native paid for a task that never finished — see finding 4.

1. ~95% of all tokens in a completed run are cache reads. Both working arms re-read roughly the whole session context on every API turn: 37.4k cached tokens/call (native-told), 38.2k (murmur). Raw token counts overstate the bill by ~10x at Haiku prices. Any dashboard tracking "tokens" without the fresh/write/read split is tracking a number an order of magnitude away from cost.

2. The token-vs-dollar divergence mostly doesn't happen here. With cache-read fractions this similar across arms (95.2% vs 94.7%), the caching discount applies to both sides and cancels in the ratio: murmur's dollar saving (26%) lands right next to its token cut (29%). They come apart only when methods differ in cacheability — e.g. one keeps a smaller resident context and pays more cache writes — not when they differ in call count. At Sonnet-class prices both columns scale ×3, ratio unchanged.

3. The saving is fewer calls, not smaller re-reads. murmur doesn't shrink the per-turn context re-read at all (~38k tokens/call in both arms). It removes turns: one send reaches both peers instead of two sends plus per-peer copy injections, replies wake only the session waiting for them, and tools ship always-loaded so there are no ToolSearch discovery turns (0 vs 1 per peer). Median wall time: 10.1s vs 13.8s.

4. The most interesting row is the failure. Plain native SendMessage completed 0 of 3: both sends compose fine, both peers receive a copy, and the answers never route back — unless the prompt spells out that replies return via SendMessage-to-self, the model stalls waiting. "Tool call succeeded" and "protocol usable" are different observability signals, and only one of them shows up in a token chart.
