# leonida-trophy-forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kuzan-creator/leonida-trophy-forecaster/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/kuzan-creator/leonida-trophy-forecaster/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Leonida Trophy Rarity Forecaster — a program that forecasts every Grand Theft Auto VI (PS5) trophy's earn rate on Exophase at 2026-11-26T00:00:00Z, as five quantiles (5%, 25%, 50%, 75%, 95%) per trophy. Built by an AI agent for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC.

## How it forecasts

The program reads one case file (`/input/<id>.in`): every Exophase read of the game's trophy page before the checkpoint, with the players-tracked count and every trophy's rarity. It never extrapolates the rate directly — it forecasts the two halves of `rate = earners / players_tracked` separately, then divides.

- **Snapshots.** Consecutive identical reads collapse into one snapshot: a plateau is a stale Exophase page, not new information. Degenerate pre-release reads (near-zero tracked players) are dropped from the fits.
- **Players tracked.** Launch adoption saturates, so the program fits a saturating logistic curve in time to the tracked-player counts and blends it (70/30 in log space) with a straight power-law fit — the logistic reads the window's flattening as a full stop, the line never flattens, and the truth sits between them.
- **Earners per trophy.** A saturating logistic fit per trophy, blended with a damped power-law fit whose growth shrinks the further the target sits past the observed window. Earners never decrease and never exceed the tracked players; the platinum grows slowly with a relative cap; a trophy already at 100% stays there.
- **The median rate** is the geometric mean of three views: the counts view (earners / tracked), the rate's own saturating logistic curve, and a damped logit(rate)-vs-log-time trend — the trend view keeps rising while the player cohort matures, which the saturating views flatten too early on their own.
- **Flat history.** When no refresh was ever observed, there is no trend to fit, so a launch prior applies, computed from the case's own ages and horizon: tracked players grow like `(1 + age)^1` while earners grow like `(1 + age)^beta` with beta < 1 by tier — new tracked players are fresh and need time to earn anything, so rates fall. Nothing about the answer is hardcoded.
- **Spread.** Refresh-jump dispersion plus trend uncertainty growing with the horizon, a small-earner term, and a term that grows with how far the forecast moves from the last rate — calibrated for honest ~0.9 coverage, not a band so wide it pays pinball at every trophy.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, deterministic: two runs on the same case write identical bytes, well inside the 8-second limit (about 0.2 s for both practice cases).

## Files

- `main.ts` — the forecaster (the entrypoint).
- `README.md` — this file.
- `LICENSE` — MIT.

---

Entered on [make.fun](https://make.fun/?ref=00sgd8yt&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards
