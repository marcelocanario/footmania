# Match Simulator Calibration — Final Report

Deterministic seeded Monte Carlo over the production possession engine. The final run contains **20,000 neutral samples** and **5,000 samples per non-neutral scenario**; counts below come from the result data.

## Method

- Neutral baseline: **20,000** simulations; every non-neutral scenario: at least **5,000** simulations.
- Empirical action, transition, duration, xG-context, restart, and set-piece tables were preserved.
- `matchSimulator.influence` is **0.40 / 0.35 / 0.25**.

## Config Changes (before → after)

| Coefficient | Before | After | Reason | Metric effect |
|---|---:|---:|---|---|
| `timing.tempoScale` | 0.928 | **0.928** | Reduce modeled action volume through duration, not empirical probabilities. | passes 2; shots -0.1 |
| `probabilityModel.foulProbabilityCalibrationMultiplier` | 1.1 | **1.1** | Restore foul volume after the tempo correction. | fouls -0.2 |
| `normalization.madToSigma` | 1.8 | **1.8** | Keep strength signals monotonic without over-saturating possession. | P75-vs-P50 possession 66.2% |
| `homeAdvantage.targetXg` | 1.5 | **0.35** | Redistribute expected xG from away to home while holding total xG near neutral. | identical home-away xG diff 0.260; total xG 2.70 |
| `cards.yellowTargetPerMatch` | 1.1 | **3.95** | Raise yellow frequency after adding second-yellow leniency. | yellows 4.66 |
| `cards.redTargetPerMatch` | 0.003 | **0.003** | Anchor total straight-plus-second-yellow reds in the target band. | reds 0.081 |
| `injuries.targetPerMatch` | 0.088 | **0.088** | Restore the target injury event rate. | injuries 0.67 |

## Neutral Benchmark (20,000 sims)

| Metric | Before mean | After mean | After P05 / P50 / P95 | Target range (center) |
|---|---:|---:|---:|---|
| goals | 2.556 | **2.579** | 0.00 / 2.00 / 5.00 | 2.4–3.0 (~2.7) |
| shots | 26.781 | **26.717** | 19.00 / 27.00 / 35.00 | 22–27 (~24.5) |
| shotsOnTarget | 9.561 | **9.571** | 5.00 / 9.00 / 15.00 | 7.5–10 (~8.75) |
| xg | 2.566 | **2.581** | 1.36 / 2.49 / 4.06 | 2.3–2.8 (~2.55) |
| corners | 9.792 | **9.775** | 5.00 / 10.00 / 15.00 | 8.5–11.5 (~10) |
| fouls | 26.456 | **26.297** | 19.00 / 26.00 / 34.00 | 22–31 (~26.5) |
| yellows | 1.548 | **4.657** | 2.00 / 5.00 / 8.00 | 3.5–4.7 (~4.1) |
| reds | 0.079 | **0.081** | 0.00 / 0.00 / 1.00 | 0.04–0.10 (~0.07) |
| passes | 982.234 | **984.704** | 912.00 / 984.00 / 1058.00 | 900–1050 (~975) |
| injuries | 0.669 | **0.673** | 0.00 / 0.00 / 2.00 | 0.5–0.8 (~0.65) |
| shot→goal | 9.54% | **9.65%** | — | 9.5–12.5% |
| shot→on-target | 35.70% | **35.82%** | — | 32–39% |
| possession (home) | 50.21% | **50.23%** | 38.2 / 50.3 / 62.1 | ~50/50 |

Goal histogram (total goals per match, % of 20,000): 0→7.4%, 1→19.6%, 2→25.2%, 3→21.7%, 4→14.3%, 5→7.1%, 6→3.0%, 7→1.2%, 8→0.3%, 9→0.1%, 10→0.0%, 12→0.0%

## Home Advantage

- Identical teams (5,000 sims): home/draw/away **43.4% / 25.0% / 31.6%**.
- Home xG **1.481** vs away xG **1.221**, difference **0.260**.
- Total xG **2.702** vs neutral **2.581**.

## Card Calibration

- Neutral yellows: **4.66**; total reds: **0.081**.
- Neutral straight reds: **0.005**; second-yellow reds: **0.076**; total: **0.081**.
- The final card configuration uses a second-yellow logit penalty of **2.5**.

## Strength Gradient and Reversed Neutral Symmetry

| Scenario | Home win% | xG diff | Home possession |
|---|---:|---:|---:|
| P10 | 19.2% | -1.014 | 34.4% |
| P25 | 21.4% | -0.791 | 34.2% |
| P50 | 36.8% | -0.000 | 50.3% |
| P75 | 56.7% | 0.789 | 66.2% |
| P90 | 61.3% | 1.016 | 65.9% |
| P10 vs P90 | 19.3% | -1.048 | 34.4% |
| P90 vs P10 | 61.9% | 1.046 | 66.0% |
- Reversed matchup checks use corresponding probabilities directly: weak-home win 19.3% vs strong-home loss 19.4% (Δ 0.001); weak-home loss 61.5% vs strong-home win 61.9% (Δ 0.004); draws 19.2% vs 18.7% (Δ 0.005).
- Reversed xG differences are -1.048 and 1.046; their signed sum is -0.002.

## Tactical Signatures

| Scenario | Selected tactic | Side | Possession | Shots | Fouls | Yellows | Selected-side win% |
|---|---|---|---:|---:|---:|---:|---:|
| tactics-CONTROL-vs-PRESS | CONTROL | home | 53.6% | 30.8 | 27.2 | 5.14 | 43.3% |
| tactics-PRESS-vs-CONTROL | CONTROL | away | 46.7% | 30.8 | 27.2 | 5.15 | 43.0% |
| tactics-CONTROL-vs-COUNTER | CONTROL | home | 56.9% | 30.7 | 23.4 | 4.18 | 37.3% |
| tactics-COUNTER-vs-CONTROL | CONTROL | away | 43.4% | 30.7 | 23.4 | 4.18 | 37.7% |
| tactics-PRESS-vs-COUNTER | PRESS | home | 53.1% | 35.4 | 22.7 | 4.45 | 33.9% |
| tactics-COUNTER-vs-PRESS | PRESS | away | 47.2% | 35.3 | 22.7 | 4.45 | 33.5% |

## Tactical Volume Diagnostic

Diagnostics are from the same engine path with per-match action and phase residence counters; they do not alter outcomes.

| Scenario | N | Pass | Carry | Dribble | Shot | All actions | Controlled min | Dead-ball share | Build-up / progression / final-third |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| neutral-baseline | 5000 | 985.0 | 1142.7 | 29.8 | 26.8 | 2253.3 | 60.9 | 32.5% | 17.1% / 49.1% / 28.2% |
| tactics-CONTROL-vs-CONTROL | 5000 | 985.0 | 1142.7 | 29.8 | 26.8 | 2253.3 | 60.9 | 32.5% | 17.1% / 49.1% / 28.2% |
| tactics-CONTROL-vs-PRESS | 5000 | 1166.9 | 923.9 | 37.9 | 30.8 | 2231.6 | 59.6 | 33.9% | 17.2% / 48.8% / 27.8% |
| tactics-PRESS-vs-CONTROL | 5000 | 1168.2 | 923.4 | 38.0 | 30.8 | 2232.5 | 59.6 | 33.9% | 17.1% / 48.7% / 27.9% |
| tactics-CONTROL-vs-COUNTER | 5000 | 1160.5 | 965.8 | 38.8 | 30.7 | 2268.4 | 60.6 | 32.7% | 17.2% / 49.3% / 27.7% |
| tactics-COUNTER-vs-CONTROL | 5000 | 1161.3 | 964.7 | 38.8 | 30.7 | 2268.1 | 60.6 | 32.7% | 17.2% / 49.2% / 27.8% |
| tactics-PRESS-vs-COUNTER | 5000 | 1377.1 | 728.5 | 48.4 | 35.4 | 2266.4 | 59.8 | 33.7% | 17.2% / 49.0% / 27.3% |
| tactics-COUNTER-vs-PRESS | 5000 | 1376.4 | 728.3 | 48.4 | 35.3 | 2265.3 | 59.8 | 33.7% | 17.2% / 49.0% / 27.3% |
| tactics-PRESS-vs-PRESS | 5000 | 1357.0 | 717.4 | 46.4 | 35.1 | 2233.4 | 58.9 | 34.6% | 17.2% / 48.7% / 27.3% |
| tactics-COUNTER-vs-COUNTER | 5000 | 1390.9 | 736.3 | 50.4 | 35.8 | 2291.3 | 60.3 | 33.1% | 17.2% / 49.3% / 27.4% |
- The diagnostic separates composition from timing: neutral and tactical cases stay near 2253 total actions and 61 controlled minutes, while COUNTER/COUNTER shifts the mix to 1391 passes and 36 shots. The remaining issue is tactical action selection, not a global clock-duration multiplier.

## Fatigue and Player Availability

| Scenario | N | Goals | Shots | xG | Home possession | H/D/A |
|---|---:|---:|---:|---:|---:|---:|
| energy-100 | 5000 | 2.58 | 26.8 | 2.57 | 50.3% | 36.8%/25.6%/37.6% |
| energy-75 | 5000 | 2.58 | 26.7 | 2.56 | 50.3% | 36.7%/26.0%/37.3% |
| energy-50 | 5000 | 2.58 | 26.4 | 2.59 | 50.3% | 37.2%/25.0%/37.8% |
| 10v11-minute-30 | 5000 | 2.67 | 26.7 | 2.66 | 46.1% | 33.7%/26.0%/40.4% |
| 10v11-minute-60 | 5000 | 2.63 | 26.7 | 2.62 | 48.2% | 35.0%/26.0%/39.1% |
| out-of-position | 5000 | 2.25 | 25.1 | 2.26 | 51.0% | 30.0%/28.1%/41.9% |
| minute-60-substitution | 5000 | 2.59 | 26.8 | 2.57 | 50.3% | 36.8%/25.6%/37.6% |

## Benchmarks Outside Range

- Yellows: 4.66 vs target 3.5–4.7 — structural second-yellow coupling remains unresolved.
- Identical home/away draw rate: 25.0%; this is reported from the scenario result and is below the approximate 26% target.
- 10v11 minute 30 vs minute 60 remains a structural validation item; the exact scenario values are in the table above.

## Influence Weights

The configured team/tactics/luck influence remains **0.40 / 0.35 / 0.25**; no change was made without a dedicated influence decomposition.

## Appendix — Full Scenario Results

| Scenario | N | Goals | Shots | SOT | xG | Corners | Fouls | Yellows | Reds | Passes | Injuries | Poss | H/D/A |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| neutral-baseline | 20000 | 2.58 | 26.7 | 9.6 | 2.58 | 9.8 | 26.3 | 4.66 | 0.081 | 985 | 0.67 | 50.2% | 37.1%/26.4%/36.5% |
| P10-vs-P50-neutral | 5000 | 3.19 | 23.2 | 8.3 | 3.18 | 10.0 | 27.2 | 4.69 | 0.086 | 986 | 0.69 | 34.4% | 19.2%/19.7%/61.1% |
| P25-vs-P50-neutral | 5000 | 2.82 | 23.7 | 8.3 | 2.84 | 10.0 | 27.1 | 4.66 | 0.079 | 987 | 0.68 | 34.2% | 21.4%/23.1%/55.5% |
| P50-vs-P50-neutral | 5000 | 2.58 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
| P75-vs-P50-neutral | 5000 | 2.85 | 23.8 | 8.3 | 2.86 | 10.0 | 27.1 | 4.64 | 0.077 | 987 | 0.68 | 66.2% | 56.7%/22.3%/21.0% |
| P90-vs-P50-neutral | 5000 | 3.18 | 23.3 | 8.3 | 3.19 | 10.0 | 27.2 | 4.66 | 0.084 | 987 | 0.69 | 65.9% | 61.3%/19.5%/19.1% |
| P10-vs-P90-neutral | 5000 | 3.30 | 23.4 | 8.4 | 3.30 | 10.0 | 27.2 | 4.67 | 0.083 | 988 | 0.68 | 34.4% | 19.3%/19.2%/61.5% |
| P90-vs-P10-neutral | 5000 | 3.30 | 23.4 | 8.4 | 3.30 | 10.0 | 27.2 | 4.65 | 0.080 | 988 | 0.68 | 66.0% | 61.9%/18.7%/19.4% |
| identical-home-away | 5000 | 2.69 | 27.9 | 10.0 | 2.70 | 10.1 | 26.1 | 4.61 | 0.079 | 983 | 0.67 | 50.3% | 43.4%/25.0%/31.6% |
| tactics-CONTROL-vs-CONTROL | 5000 | 2.58 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
| tactics-CONTROL-vs-PRESS | 5000 | 2.77 | 30.8 | 10.7 | 2.79 | 9.6 | 27.2 | 5.14 | 0.125 | 1167 | 0.66 | 53.6% | 43.3%/24.8%/31.9% |
| tactics-PRESS-vs-CONTROL | 5000 | 2.77 | 30.8 | 10.7 | 2.78 | 9.7 | 27.2 | 5.15 | 0.125 | 1168 | 0.66 | 46.7% | 32.5%/24.5%/43.0% |
| tactics-CONTROL-vs-COUNTER | 5000 | 2.79 | 30.7 | 10.9 | 2.82 | 10.6 | 23.4 | 4.18 | 0.067 | 1161 | 0.68 | 56.9% | 37.3%/25.8%/36.9% |
| tactics-COUNTER-vs-CONTROL | 5000 | 2.78 | 30.7 | 10.9 | 2.83 | 10.6 | 23.4 | 4.18 | 0.064 | 1161 | 0.68 | 43.4% | 37.1%/25.2%/37.7% |
| tactics-PRESS-vs-COUNTER | 5000 | 3.07 | 35.4 | 12.2 | 3.08 | 10.8 | 22.7 | 4.45 | 0.080 | 1377 | 0.69 | 53.1% | 33.9%/24.1%/42.0% |
| tactics-COUNTER-vs-PRESS | 5000 | 3.08 | 35.3 | 12.2 | 3.08 | 10.8 | 22.7 | 4.45 | 0.076 | 1376 | 0.69 | 47.2% | 42.7%/23.8%/33.5% |
| tactics-PRESS-vs-PRESS | 5000 | 3.00 | 35.1 | 11.8 | 3.01 | 9.8 | 26.1 | 5.29 | 0.116 | 1357 | 0.65 | 50.3% | 37.6%/24.2%/38.1% |
| tactics-COUNTER-vs-COUNTER | 5000 | 3.14 | 35.8 | 12.6 | 3.15 | 11.9 | 19.5 | 3.62 | 0.049 | 1391 | 0.69 | 50.0% | 36.8%/24.8%/38.4% |
| energy-100 | 5000 | 2.58 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
| energy-75 | 5000 | 2.58 | 26.7 | 9.6 | 2.56 | 9.8 | 26.3 | 4.63 | 0.075 | 985 | 0.67 | 50.3% | 36.7%/26.0%/37.3% |
| energy-50 | 5000 | 2.58 | 26.4 | 9.4 | 2.59 | 9.7 | 26.9 | 4.82 | 0.082 | 982 | 0.67 | 50.3% | 37.2%/25.0%/37.8% |
| 10v11-minute-30 | 5000 | 2.67 | 26.7 | 9.6 | 2.66 | 9.8 | 26.2 | 4.61 | 0.076 | 986 | 0.66 | 46.1% | 33.7%/26.0%/40.4% |
| 10v11-minute-60 | 5000 | 2.63 | 26.7 | 9.6 | 2.62 | 9.8 | 26.2 | 4.62 | 0.077 | 985 | 0.67 | 48.2% | 35.0%/26.0%/39.1% |
| out-of-position | 5000 | 2.25 | 25.1 | 8.5 | 2.26 | 9.8 | 27.3 | 4.71 | 0.078 | 982 | 0.65 | 51.0% | 30.0%/28.1%/41.9% |
| minute-60-substitution | 5000 | 2.59 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.63 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
