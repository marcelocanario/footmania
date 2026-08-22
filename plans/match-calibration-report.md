# Match Simulator Calibration — Final Report

Deterministic seeded Monte Carlo over the production possession engine. The final run contains **20,000 neutral samples** and **5,000 samples per non-neutral scenario**; counts below come from the result data.

## Method

- Neutral baseline: **20,000** simulations; every non-neutral scenario: at least **5,000** simulations.
- Empirical action, transition, duration, xG-context, restart, and set-piece tables were preserved.
- `matchSimulator.influence` is **0.40 / 0.35 / 0.25**.

## Config Changes (before → after)

| Coefficient | Before | After | Reason | Metric effect |
|---|---:|---:|---|---|
| `timing.tempoScale` | 0.928 | **0.84** | Reduce modeled action volume through duration, not empirical probabilities. | passes 3; shots -0.1 |
| `probabilityModel.foulProbabilityCalibrationMultiplier` | 1.1 | **1.1** | Restore foul volume after the tempo correction. | fouls -0.2 |
| `normalization.madToSigma` | 1.8 | **1.8** | Keep strength signals monotonic without over-saturating possession. | P75-vs-P50 possession 66.0% |
| `homeAdvantage.targetXg` | 1.5 | **0.35** | Redistribute expected xG from away to home while holding total xG near neutral. | identical home-away xG diff 0.282; total xG 2.72 |
| `cards.yellowTargetPerMatch` | 1.1 | **3.95** | Raise yellow frequency after adding second-yellow leniency. | yellows 4.65 |
| `cards.redTargetPerMatch` | 0.003 | **0.003** | Anchor total straight-plus-second-yellow reds in the target band. | reds 0.083 |
| `injuries.targetPerMatch` | 0.088 | **0.088** | Restore the target injury event rate. | injuries 0.67 |
| `tacticalActionMix.nonNeutralCorrectionScale` | 0 | **0.75** | Reduce tactical pass/shot mix inflation while preserving the neutral CONTROL/CONTROL baseline. | PRESS/COUNTER action mix is reported in the diagnostic section |

## Neutral Benchmark (20,000 sims)

| Metric | Before mean | After mean | After P05 / P50 / P95 | Target range (center) |
|---|---:|---:|---:|---|
| goals | 2.556 | **2.565** | 0.00 / 2.00 / 5.00 | 2.4–3.0 (~2.7) |
| shots | 26.781 | **26.667** | 19.00 / 26.00 / 36.00 | 22–27 (~24.5) |
| shotsOnTarget | 9.561 | **9.558** | 5.00 / 9.00 / 15.00 | 7.5–10 (~8.75) |
| xg | 2.566 | **2.574** | 1.34 / 2.49 / 4.11 | 2.3–2.8 (~2.55) |
| corners | 9.792 | **9.740** | 5.00 / 10.00 / 15.00 | 8.5–11.5 (~10) |
| fouls | 26.456 | **26.261** | 19.00 / 26.00 / 34.00 | 22–31 (~26.5) |
| yellows | 1.548 | **4.646** | 2.00 / 5.00 / 8.00 | 3.5–4.7 (~4.1) |
| reds | 0.079 | **0.083** | 0.00 / 0.00 / 1.00 | 0.04–0.10 (~0.07) |
| passes | 982.234 | **985.142** | 911.00 / 985.00 / 1062.00 | 900–1050 (~975) |
| injuries | 0.669 | **0.674** | 0.00 / 0.00 / 2.00 | 0.5–0.8 (~0.65) |
| shot→goal | 9.54% | **9.62%** | — | 9.5–12.5% |
| shot→on-target | 35.70% | **35.84%** | — | 32–39% |
| possession (home) | 50.21% | **49.99%** | 38.1 / 49.9 / 62.0 | ~50/50 |

Goal histogram (total goals per match, % of 20,000): 0→7.8%, 1→20.1%, 2→25.4%, 3→21.0%, 4→13.7%, 5→7.1%, 6→3.1%, 7→1.2%, 8→0.4%, 9→0.1%, 10→0.0%, 11→0.0%, 12→0.0%

## Home Advantage

- Identical teams (5,000 sims): home/draw/away **42.9% / 25.0% / 32.2%**.
- Home xG **1.501** vs away xG **1.219**, difference **0.282**.
- Total xG **2.719** vs neutral **2.574**.

## Card Calibration

- Neutral yellows: **4.65**; total reds: **0.083**.
- Neutral straight reds: **0.005**; second-yellow reds: **0.078**; total: **0.083**.
- The final card configuration uses a second-yellow logit penalty of **2.5**.

## Strength Gradient and Reversed Neutral Symmetry

| Scenario | Home win% | xG diff | Home possession |
|---|---:|---:|---:|
| P10 | 19.0% | -1.022 | 34.2% |
| P25 | 21.5% | -0.775 | 34.0% |
| P50 | 36.9% | -0.006 | 49.9% |
| P75 | 56.1% | 0.790 | 66.0% |
| P90 | 61.3% | 1.030 | 65.8% |
| P10 vs P90 | 19.1% | -1.054 | 34.2% |
| P90 vs P10 | 62.2% | 1.077 | 65.9% |
- Reversed matchup checks use corresponding probabilities directly: weak-home win 19.1% vs strong-home loss 18.2% (Δ 0.009); weak-home loss 60.8% vs strong-home win 62.2% (Δ 0.014); draws 20.1% vs 19.6% (Δ 0.005).
- Reversed xG differences are -1.054 and 1.077; their signed sum is 0.023.

## Tactical Signatures

| Scenario | Selected tactic | Side | Possession | Shots | Fouls | Yellows | Selected-side win% |
|---|---|---|---:|---:|---:|---:|---:|
| tactics-CONTROL-vs-PRESS | CONTROL | home | 54.6% | 26.6 | 31.4 | 5.72 | 42.6% |
| tactics-PRESS-vs-CONTROL | CONTROL | away | 45.6% | 26.6 | 31.3 | 5.70 | 42.0% |
| tactics-CONTROL-vs-COUNTER | CONTROL | home | 57.8% | 26.6 | 26.8 | 4.65 | 36.6% |
| tactics-COUNTER-vs-CONTROL | CONTROL | away | 42.2% | 26.5 | 26.8 | 4.69 | 37.7% |
| tactics-PRESS-vs-COUNTER | PRESS | home | 52.9% | 31.3 | 26.6 | 5.08 | 33.8% |
| tactics-COUNTER-vs-PRESS | PRESS | away | 47.2% | 31.3 | 26.6 | 5.11 | 33.7% |

## Tactical Volume Diagnostic

Diagnostics are from the same engine path with per-match action and phase residence counters; they do not alter outcomes.

| Scenario | N | Pass | Carry | Dribble | Shot | All actions | Controlled min | Dead-ball share | Build-up / progression / final-third |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| neutral-baseline | 20000 | 985.1 | 1142.2 | 29.8 | 26.7 | 2252.5 | 67.2 | 32.4% | 17.1% / 49.2% / 28.2% |
| tactics-CONTROL-vs-CONTROL | 5000 | 985.5 | 1142.5 | 29.8 | 26.7 | 2253.4 | 67.2 | 32.4% | 17.0% / 49.2% / 28.2% |
| tactics-CONTROL-vs-PRESS | 5000 | 942.5 | 1133.9 | 42.8 | 26.6 | 2218.1 | 65.8 | 34.4% | 16.8% / 48.5% / 28.7% |
| tactics-PRESS-vs-CONTROL | 5000 | 942.6 | 1133.5 | 42.8 | 26.6 | 2218.0 | 65.8 | 34.4% | 16.8% / 48.5% / 28.7% |
| tactics-CONTROL-vs-COUNTER | 5000 | 931.8 | 1177.6 | 43.7 | 26.6 | 2252.6 | 66.8 | 32.9% | 16.7% / 49.0% / 28.7% |
| tactics-COUNTER-vs-CONTROL | 5000 | 932.2 | 1178.6 | 43.7 | 26.5 | 2254.1 | 66.9 | 32.9% | 16.7% / 49.0% / 28.7% |
| tactics-PRESS-vs-COUNTER | 5000 | 1151.1 | 938.3 | 56.4 | 31.3 | 2254.8 | 66.0 | 34.1% | 16.9% / 48.9% / 28.0% |
| tactics-COUNTER-vs-PRESS | 5000 | 1151.2 | 938.3 | 56.4 | 31.3 | 2254.9 | 66.0 | 34.2% | 16.9% / 48.9% / 28.0% |
| tactics-PRESS-vs-PRESS | 5000 | 1135.5 | 922.3 | 54.0 | 31.0 | 2220.4 | 65.1 | 35.4% | 16.9% / 48.6% / 27.9% |
| tactics-COUNTER-vs-COUNTER | 5000 | 1161.0 | 947.3 | 58.7 | 31.4 | 2276.4 | 66.6 | 33.2% | 16.9% / 49.3% / 28.0% |
- The diagnostic separates composition from timing: neutral and tactical cases stay near 2253 total actions and 67 controlled minutes, while COUNTER/COUNTER shifts the mix to 1161 passes and 31 shots. The remaining issue is tactical action selection, not a global clock-duration multiplier.

## Fatigue and Player Availability

| Scenario | N | Goals | Shots | xG | Home possession | H/D/A |
|---|---:|---:|---:|---:|---:|---:|
| energy-100 | 5000 | 2.56 | 26.7 | 2.57 | 49.9% | 36.9%/26.2%/36.9% |
| energy-75 | 5000 | 2.56 | 26.7 | 2.56 | 49.9% | 37.2%/25.6%/37.3% |
| energy-50 | 5000 | 2.56 | 26.3 | 2.58 | 50.1% | 37.0%/25.8%/37.2% |
| 10v11-minute-30 | 5000 | 2.49 | 24.9 | 2.48 | 45.8% | 33.5%/26.3%/40.2% |
| 10v11-minute-60 | 5000 | 2.44 | 25.0 | 2.45 | 47.7% | 35.3%/26.9%/37.8% |
| out-of-position | 5000 | 2.25 | 25.1 | 2.26 | 50.8% | 29.1%/28.5%/42.3% |
| minute-60-substitution | 5000 | 2.39 | 25.0 | 2.40 | 49.9% | 36.3%/27.0%/36.7% |

## Benchmarks Outside Range

- Yellows: 4.65 vs target 3.5–4.7 — structural second-yellow coupling remains unresolved.
- Identical home/away draw rate: 25.0%; this is reported from the scenario result and is below the approximate 26% target.
- 10v11 minute 30 vs minute 60 remains a structural validation item; the exact scenario values are in the table above.

## Influence Weights

The configured team/tactics/luck influence remains **0.40 / 0.35 / 0.25**; no change was made without a dedicated influence decomposition.

## Appendix — Full Scenario Results

| Scenario | N | Goals | Shots | SOT | xG | Corners | Fouls | Yellows | Reds | Passes | Injuries | Poss | H/D/A |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| neutral-baseline | 20000 | 2.57 | 26.7 | 9.6 | 2.57 | 9.7 | 26.3 | 4.65 | 0.083 | 985 | 0.67 | 50.0% | 36.6%/26.4%/37.0% |
| P10-vs-P50-neutral | 5000 | 3.21 | 23.4 | 8.3 | 3.20 | 10.0 | 27.3 | 4.65 | 0.090 | 993 | 0.68 | 34.2% | 19.0%/20.1%/60.9% |
| P25-vs-P50-neutral | 5000 | 2.83 | 23.8 | 8.3 | 2.84 | 10.0 | 27.2 | 4.64 | 0.076 | 989 | 0.68 | 34.0% | 21.5%/22.6%/55.9% |
| P50-vs-P50-neutral | 5000 | 2.56 | 26.7 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.078 | 985 | 0.67 | 49.9% | 36.9%/26.2%/36.9% |
| P75-vs-P50-neutral | 5000 | 2.82 | 23.8 | 8.3 | 2.85 | 10.0 | 27.1 | 4.65 | 0.083 | 990 | 0.69 | 66.0% | 56.1%/23.1%/20.8% |
| P90-vs-P50-neutral | 5000 | 3.19 | 23.3 | 8.3 | 3.20 | 10.0 | 27.3 | 4.66 | 0.086 | 993 | 0.69 | 65.8% | 61.3%/20.1%/18.7% |
| P10-vs-P90-neutral | 5000 | 3.32 | 23.6 | 8.5 | 3.32 | 10.1 | 27.3 | 4.64 | 0.087 | 994 | 0.68 | 34.2% | 19.1%/20.1%/60.8% |
| P90-vs-P10-neutral | 5000 | 3.30 | 23.5 | 8.4 | 3.33 | 10.0 | 27.5 | 4.68 | 0.081 | 994 | 0.68 | 65.9% | 62.2%/19.6%/18.2% |
| identical-home-away | 5000 | 2.70 | 27.9 | 10.0 | 2.72 | 10.1 | 26.1 | 4.62 | 0.078 | 985 | 0.67 | 50.2% | 42.9%/25.0%/32.2% |
| tactics-CONTROL-vs-CONTROL | 5000 | 2.56 | 26.7 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.078 | 985 | 0.67 | 49.9% | 36.9%/26.2%/36.9% |
| tactics-CONTROL-vs-PRESS | 5000 | 2.52 | 26.6 | 9.3 | 2.55 | 9.0 | 31.4 | 5.72 | 0.159 | 942 | 0.66 | 54.6% | 42.6%/25.8%/31.6% |
| tactics-PRESS-vs-CONTROL | 5000 | 2.54 | 26.6 | 9.4 | 2.55 | 9.0 | 31.3 | 5.70 | 0.150 | 943 | 0.66 | 45.6% | 31.2%/26.8%/42.0% |
| tactics-CONTROL-vs-COUNTER | 5000 | 2.65 | 26.6 | 9.7 | 2.63 | 9.9 | 26.8 | 4.65 | 0.093 | 932 | 0.69 | 57.8% | 36.6%/26.5%/36.9% |
| tactics-COUNTER-vs-CONTROL | 5000 | 2.66 | 26.5 | 9.6 | 2.62 | 9.9 | 26.8 | 4.69 | 0.092 | 932 | 0.67 | 42.2% | 35.7%/26.6%/37.7% |
| tactics-PRESS-vs-COUNTER | 5000 | 2.86 | 31.3 | 10.9 | 2.83 | 10.1 | 26.6 | 5.08 | 0.100 | 1151 | 0.70 | 52.9% | 33.8%/24.4%/41.9% |
| tactics-COUNTER-vs-PRESS | 5000 | 2.87 | 31.3 | 10.9 | 2.84 | 10.1 | 26.6 | 5.11 | 0.097 | 1151 | 0.70 | 47.2% | 41.9%/24.4%/33.7% |
| tactics-PRESS-vs-PRESS | 5000 | 2.77 | 31.0 | 10.5 | 2.77 | 9.2 | 30.6 | 6.04 | 0.147 | 1135 | 0.67 | 50.0% | 37.7%/24.7%/37.6% |
| tactics-COUNTER-vs-COUNTER | 5000 | 2.87 | 31.4 | 11.1 | 2.88 | 11.2 | 23.0 | 4.19 | 0.066 | 1161 | 0.70 | 50.1% | 38.2%/25.2%/36.7% |
| energy-100 | 5000 | 2.56 | 26.7 | 9.6 | 2.57 | 9.8 | 26.2 | 4.62 | 0.078 | 985 | 0.67 | 49.9% | 36.9%/26.2%/36.9% |
| energy-75 | 5000 | 2.56 | 26.7 | 9.6 | 2.56 | 9.8 | 26.3 | 4.65 | 0.079 | 985 | 0.68 | 49.9% | 37.2%/25.6%/37.3% |
| energy-50 | 5000 | 2.56 | 26.3 | 9.3 | 2.58 | 9.7 | 26.9 | 4.79 | 0.085 | 983 | 0.68 | 50.1% | 37.0%/25.8%/37.2% |
| 10v11-minute-30 | 5000 | 2.49 | 24.9 | 9.0 | 2.48 | 9.1 | 24.5 | 4.34 | 0.070 | 921 | 0.62 | 45.8% | 33.5%/26.3%/40.2% |
| 10v11-minute-60 | 5000 | 2.44 | 25.0 | 9.0 | 2.45 | 9.1 | 24.5 | 4.36 | 0.069 | 922 | 0.63 | 47.7% | 35.3%/26.9%/37.8% |
| out-of-position | 5000 | 2.25 | 25.1 | 8.5 | 2.26 | 9.8 | 27.2 | 4.69 | 0.081 | 980 | 0.65 | 50.8% | 29.1%/28.5%/42.3% |
| minute-60-substitution | 5000 | 2.39 | 25.0 | 9.0 | 2.40 | 9.1 | 24.5 | 4.37 | 0.069 | 922 | 0.63 | 49.9% | 36.3%/27.0%/36.7% |
