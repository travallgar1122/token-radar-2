# token-radar-2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/travallgar1122/token-radar-2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/travallgar1122/token-radar-2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar whose prices come from a fitted model, not from hand-set multiples. The program classifies all 758 protocols in the sealed snapshot — 127 already trade (the fit anchors), 197 still record no token and are ranked, and 434 are set aside with a stated, counted reason (wrapped, staked, bridged, exchange and versioned products among them), so the three numbers always reconcile. Each ranked protocol is priced by `impliedValue()`: a Huber-robust log-log size curve fitted on the trading anchors (intercept 3.3497, slope 0.4801), plus shrunk category offsets, a fitted 7-day growth carry and a fitted seasoning term for days without a token, with a P25–P75 band and a rank range from 200 bootstrap refits. The model is validated out of sample on the page itself: leave-one-out over the anchors misses by a median 3.472× against 4.941× for a flat TVL multiple, walk-forward misses by 2.62×, and a per-term ablation table is printed with the numbers as they came out. Every row then gets a farm plan netted to the dollar at $1,000 and $10,000 deposits — gross slice, round-trip fees, per-chain gas, T-bill opportunity cost, net if it launches, net per hands-on hour, break-even launch chance, and a Farm / Marginal / Skip / Thin verdict — and the farm steps are generated from those figures. The dashboard re-prices, re-plans and re-verdicts all 197 rows in the browser on load and prints the result ("board.json = this page: 197/197 … all matched"), so the screenshots and the code can be checked against each other at a glance.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h0zvrf0h&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
