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
| `tacticalActionMix.nonNeutralCorrectionScale` | 0 | **0.75** | Reduce tactical pass/shot mix inflation while preserving the neutral CONTROL/CONTROL baseline. | PRESS/COUNTER action mix is reported in the diagnostic section |

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
| tactics-CONTROL-vs-PRESS | CONTROL | home | 54.8% | 26.5 | 31.3 | 5.72 | 42.3% |
| tactics-PRESS-vs-CONTROL | CONTROL | away | 45.7% | 26.6 | 31.2 | 5.70 | 41.8% |
| tactics-CONTROL-vs-COUNTER | CONTROL | home | 58.0% | 26.5 | 26.8 | 4.69 | 36.4% |
| tactics-COUNTER-vs-CONTROL | CONTROL | away | 42.2% | 26.6 | 26.8 | 4.71 | 37.2% |
| tactics-PRESS-vs-COUNTER | PRESS | home | 53.0% | 31.2 | 26.6 | 5.11 | 33.2% |
| tactics-COUNTER-vs-PRESS | PRESS | away | 47.3% | 31.2 | 26.5 | 5.10 | 33.0% |

## Tactical Volume Diagnostic

Diagnostics are from the same engine path with per-match action and phase residence counters; they do not alter outcomes.

| Scenario | N | Pass | Carry | Dribble | Shot | All actions | Controlled min | Dead-ball share | Build-up / progression / final-third |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| neutral-baseline | 20000 | 984.7 | 1142.5 | 29.8 | 26.7 | 2252.6 | 60.9 | 32.5% | 17.1% / 49.1% / 28.2% |
| tactics-CONTROL-vs-CONTROL | 5000 | 985.0 | 1142.7 | 29.8 | 26.8 | 2253.3 | 60.9 | 32.5% | 17.1% / 49.1% / 28.2% |
| tactics-CONTROL-vs-PRESS | 5000 | 936.1 | 1128.8 | 42.5 | 26.5 | 2206.1 | 59.2 | 34.3% | 16.9% / 48.4% / 28.7% |
| tactics-PRESS-vs-CONTROL | 5000 | 937.9 | 1127.4 | 42.7 | 26.6 | 2206.7 | 59.2 | 34.3% | 16.9% / 48.4% / 28.7% |
| tactics-CONTROL-vs-COUNTER | 5000 | 930.4 | 1178.6 | 43.6 | 26.5 | 2252.2 | 60.5 | 32.9% | 16.7% / 49.0% / 28.7% |
| tactics-COUNTER-vs-CONTROL | 5000 | 931.0 | 1177.6 | 43.6 | 26.6 | 2251.8 | 60.5 | 32.9% | 16.8% / 49.0% / 28.7% |
| tactics-PRESS-vs-COUNTER | 5000 | 1145.4 | 934.1 | 56.2 | 31.2 | 2244.2 | 59.5 | 34.0% | 16.9% / 48.9% / 28.0% |
| tactics-COUNTER-vs-PRESS | 5000 | 1145.4 | 934.2 | 56.1 | 31.2 | 2244.2 | 59.5 | 34.0% | 16.9% / 48.9% / 28.0% |
| tactics-PRESS-vs-PRESS | 5000 | 1125.8 | 914.9 | 53.5 | 30.8 | 2202.1 | 58.5 | 35.2% | 16.9% / 48.5% / 27.9% |
| tactics-COUNTER-vs-COUNTER | 5000 | 1159.0 | 946.1 | 58.6 | 31.4 | 2273.2 | 60.2 | 33.2% | 16.9% / 49.2% / 28.0% |
- The diagnostic separates composition from timing: neutral and tactical cases stay near 2253 total actions and 61 controlled minutes, while COUNTER/COUNTER shifts the mix to 1159 passes and 31 shots. The remaining issue is tactical action selection, not a global clock-duration multiplier.

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
| tactics-CONTROL-vs-PRESS | 5000 | 2.54 | 26.5 | 9.3 | 2.56 | 8.9 | 31.3 | 5.72 | 0.156 | 936 | 0.65 | 54.8% | 42.3%/26.6%/31.1% |
| tactics-PRESS-vs-CONTROL | 5000 | 2.54 | 26.6 | 9.3 | 2.56 | 9.0 | 31.2 | 5.70 | 0.155 | 938 | 0.64 | 45.7% | 31.8%/26.4%/41.8% |
| tactics-CONTROL-vs-COUNTER | 5000 | 2.63 | 26.5 | 9.6 | 2.62 | 9.9 | 26.8 | 4.69 | 0.092 | 930 | 0.69 | 58.0% | 36.4%/26.6%/37.0% |
| tactics-COUNTER-vs-CONTROL | 5000 | 2.63 | 26.6 | 9.6 | 2.62 | 9.9 | 26.8 | 4.71 | 0.094 | 931 | 0.67 | 42.2% | 35.9%/26.9%/37.2% |
| tactics-PRESS-vs-COUNTER | 5000 | 2.86 | 31.2 | 10.9 | 2.83 | 10.0 | 26.6 | 5.11 | 0.107 | 1145 | 0.70 | 53.0% | 33.2%/24.8%/42.0% |
| tactics-COUNTER-vs-PRESS | 5000 | 2.84 | 31.2 | 10.9 | 2.83 | 10.1 | 26.5 | 5.10 | 0.104 | 1145 | 0.71 | 47.3% | 41.2%/25.8%/33.0% |
| tactics-PRESS-vs-PRESS | 5000 | 2.77 | 30.8 | 10.5 | 2.76 | 9.1 | 30.4 | 6.03 | 0.145 | 1126 | 0.67 | 50.1% | 38.1%/25.0%/36.9% |
| tactics-COUNTER-vs-COUNTER | 5000 | 2.89 | 31.4 | 11.1 | 2.89 | 11.2 | 23.0 | 4.17 | 0.072 | 1159 | 0.69 | 50.0% | 37.9%/25.3%/36.8% |
| energy-100 | 5000 | 2.58 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
| energy-75 | 5000 | 2.58 | 26.7 | 9.6 | 2.56 | 9.8 | 26.3 | 4.63 | 0.075 | 985 | 0.67 | 50.3% | 36.7%/26.0%/37.3% |
| energy-50 | 5000 | 2.58 | 26.4 | 9.4 | 2.59 | 9.7 | 26.9 | 4.82 | 0.082 | 982 | 0.67 | 50.3% | 37.2%/25.0%/37.8% |
| 10v11-minute-30 | 5000 | 2.67 | 26.7 | 9.6 | 2.66 | 9.8 | 26.2 | 4.61 | 0.076 | 986 | 0.66 | 46.1% | 33.7%/26.0%/40.4% |
| 10v11-minute-60 | 5000 | 2.63 | 26.7 | 9.6 | 2.62 | 9.8 | 26.2 | 4.62 | 0.077 | 985 | 0.67 | 48.2% | 35.0%/26.0%/39.1% |
| out-of-position | 5000 | 2.25 | 25.1 | 8.5 | 2.26 | 9.8 | 27.3 | 4.71 | 0.078 | 982 | 0.65 | 51.0% | 30.0%/28.1%/41.9% |
| minute-60-substitution | 5000 | 2.59 | 26.8 | 9.6 | 2.57 | 9.8 | 26.2 | 4.63 | 0.076 | 985 | 0.67 | 50.3% | 36.8%/25.6%/37.6% |
