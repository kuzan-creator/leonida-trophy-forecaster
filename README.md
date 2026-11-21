# Leonida Trophy Rarity Forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kuzan-creator/leonida-trophy-forecaster/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kuzan-creator/leonida-trophy-forecaster/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

**Leonida Trophy Rarity Forecaster** forecasts, for every GTA VI PlayStation 5 trophy, its earn rate on Exophase at 2026-11-26T00:00:00Z — a week after launch — as five quantiles (5%, 25%, 50%, 75%, 95%) per trophy. It is an entry for the make.fun bounty [Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## How it works

An Exophase earn rate is a ratio, `rate = 100 * earners / players_tracked`, and the two halves move for different reasons — so the program forecasts them separately and divides at the end, instead of extrapolating the ratio itself.

- **Players tracked (N).** N only grows, and it grows in steps: Exophase refreshes its counts on its own schedule, so the history is plateaus with sudden jumps. The program collapses consecutive identical reads into one distinct snapshot, fits N's growth on those snapshots only (a power law in log-time averaged with an exponential fit on the last 24 hours), and measures refresh-jump dispersion from the jumps it has actually seen.
- **Earners per trophy.** Per trophy, log(earners) is fitted against log(1 + hours since launch) — a power law that bends down as a trophy saturates — blended with an exponential-in-time fit. Each slope is shrunk toward its tier's median slope and the global median, so a trophy with almost no movement borrows strength from its tier. Slopes are never negative: earners cannot fall.
- **Rate view, blended in.** The logit of the rate itself is also fitted against log-time, shrunk the same way, and the two views (counts view and rate view) are averaged in logit space. This keeps a common trophy from being dragged down by N growth alone — new players earn it too — and a rare trophy from being dragged up by a rate trend that ignores dilution.
- **Special cases.** The platinum (id 1) gets its own fitted slope plus a relative cap; the 100% trophy (id 2) is pinned near 100.
- **Honest, refresh-aware spread.** The logit width combines refresh-jump uncertainty — how much N can jump before the target, with a wide prior when no jump has ever been seen (a flat history hides the next refresh, it does not rule it out) — and trend uncertainty that grows with the horizon. Rare, volatile trophies get a wider band than saturated ones. On the practice cases this covers the unseen 6× dilution refresh that the house baseline's narrow band misses entirely.

Nothing is hardcoded: no rate, player count or refresh factor is fixed in advance. Every parameter is estimated from the case file at run time, with persistence as the fallback when the history is flat or too short. Node 22, standard library only, no network, deterministic.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `*.in` in the input directory and writes one `<id>.out` per case to the output directory: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}, ...]}`, one row per trophy, five finite numbers from 0 to 100, non-decreasing.

## Validation

- Practice cases p00/p01: valid output, deterministic across runs (byte-identical), ~0.2 s per case.
- Local pinball-loss scorer (logit scale, per the rules): on synthetic practice answers — earners frozen with N = 3868 (pure dilution), earners +10%, earners +30% — loss 0.98 / 0.93 / 0.82 vs the house baseline's 1.69 / 1.61 / 1.41, with 90% coverage 1.00 (baseline 0.00).
- On a synthetic final-like case (2 days of history with refresh jumps, held-out target 4.5 days later): loss 0.174 vs the baseline's 0.230.

## Files

- `main.ts` — the forecaster (the entrypoint)
- `README.md` — this file
- `LICENSE` — MIT

<sub>Entered on [make.fun](https://make.fun/?ref=00sgd8yt&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
