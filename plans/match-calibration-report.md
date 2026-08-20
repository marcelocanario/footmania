# Match Simulator Calibration

Deterministic seeded Monte Carlo harness against the production possession engine. No match outcomes are scripted; all behavior comes from the two match configuration files.

Seed: `1369948382`

## Neutral Benchmark

| Metric | Mean | P05 / P50 / P95 | Target |
|---|---:|---:|---|
| goals | 0.000 | 0.000 / 0.000 / 0.000 | 2.4-3.0 |
| shots | 0.000 | 0.000 / 0.000 / 0.000 | 22-27 |
| shotsOnTarget | 0.000 | 0.000 / 0.000 / 0.000 | 7.5-10 |
| xg | 0.000 | 0.000 / 0.000 / 0.000 | 2.3-2.8 |
| corners | 0.000 | 0.000 / 0.000 / 0.000 | 8.5-11.5 |
| fouls | 0.000 | 0.000 / 0.000 / 0.000 | 22-31 |
| yellows | 0.000 | 0.000 / 0.000 / 0.000 | 3.5-4.7 |
| reds | 0.000 | 0.000 / 0.000 / 0.000 | 0.04-0.10 |
| passes | 0.000 | 0.000 / 0.000 / 0.000 | 900-1050 |
| injuries | 0.000 | 0.000 / 0.000 / 0.000 | 0.5-0.8 |
| homePossession | 0.000 | 0.000 / 0.000 / 0.000 | 50/50 |

## Home Advantage

Identical teams: home/draw/away = 41.0% / 23.4% / 35.6%; home-away xG = 1.644 / 1.511 (difference 0.133).

## Scenario Results

| Scenario | N | Goals | Shots | xG | Possession | H / D / A |
|---|---:|---:|---:|---:|---:|---:|
| identical-home-away | 500 | 3.194 | 27.470 | 3.155 | 48.94% | 41.0 / 23.4 / 35.6% |

## Before Config Snapshot

```json
{
  "before": {
    "probabilityModel": {
      "foulProbabilityCalibrationMultiplier": 0.85,
      "stateShotProbabilities": {
        "SET_PIECE.DEF_WIDE": 0,
        "SET_PIECE.DEF_CENTRAL": 0,
        "SET_PIECE.MID_WIDE": 0.000045887209239688845,
        "SET_PIECE.MID_CENTRAL": 0.0003167970654587621,
        "SET_PIECE.ATT_WIDE": 0.0011916237095399745,
        "SET_PIECE.ATT_CENTRAL": 0.0266,
        "SET_PIECE.BOX": 0.10925,
        "TRANSITION.DEF_WIDE": 0,
        "TRANSITION.DEF_CENTRAL": 0,
        "TRANSITION.MID_WIDE": 0.0004094010614101592,
        "TRANSITION.MID_CENTRAL": 0.0009261230572705983,
        "TRANSITION.ATT_WIDE": 0.0036952998379254456,
        "TRANSITION.ATT_CENTRAL": 0.0266,
        "TRANSITION.BOX": 0.10925,
        "BUILD_UP.DEF_WIDE": 0,
        "BUILD_UP.DEF_CENTRAL": 0,
        "PROGRESSION.MID_WIDE": 0.000059571840932353465,
        "PROGRESSION.MID_CENTRAL": 0.00016703584008133919,
        "FINAL_THIRD.ATT_WIDE": 0.0004262711268842897,
        "FINAL_THIRD.ATT_CENTRAL": 0.02375,
        "FINAL_THIRD.BOX": 0.114
      }
    },
    "timing": {
      "tempoScale": 1,
      "regulationSeconds": 5400,
      "firstHalfEndSeconds": 2700,
      "deadBallSecondsPerRestart": 25.84916263374729,
      "instantActionSeconds": 0.17533731670946573,
      "durationGamma": {
        "ACTION": {
          "PASS": {
            "shape": 3.3394959051716864,
            "scale": 0.46035656810283665
          },
          "CROSS": {
            "shape": 3.58748685143264,
            "scale": 0.4819751527150497
          },
          "CARRY": {
            "shape": 1.1262148849824531,
            "scale": 1.5332408427658488
          },
          "SHOT": {
            "shape": 1.6092215713657576,
            "scale": 0.4552570098490261
          }
        },
        "ACTION_PHASE": {
          "PASS.SET_PIECE": {
            "shape": 3.0814389270571936,
            "scale": 0.5481603679396492
          },
          "PASS.TRANSITION": {
            "shape": 3.4935376620762826,
            "scale": 0.46399907804902185
          },
          "PASS.BUILD_UP": {
            "shape": 3.6804117267669314,
            "scale": 0.47835339563648943
          },
          "PASS.PROGRESSION": {
            "shape": 4.029075082262344,
            "scale": 0.3627664172185757
          },
          "PASS.FINAL_THIRD": {
            "shape": 2.9309049310092443,
            "scale": 0.4191490716886423
          },
          "CROSS.SET_PIECE": {
            "shape": 4.683356214747565,
            "scale": 0.3773422449650266
          },
          "CROSS.FINAL_THIRD": {
            "shape": 3.3432262000140143,
            "scale": 0.5134339159164159
          },
          "CARRY.SET_PIECE": {
            "shape": 1.0788837845328438,
            "scale": 1.4369892982386567
          },
          "CARRY.TRANSITION": {
            "shape": 1.0761529350661165,
            "scale": 2.193640796317039
          },
          "CARRY.BUILD_UP": {
            "shape": 1.0968416549086983,
            "scale": 1.9038901621019917
          },
          "CARRY.PROGRESSION": {
            "shape": 1.1843136856986398,
            "scale": 1.4102148281646365
          },
          "CARRY.FINAL_THIRD": {
            "shape": 1.1284746855970862,
            "scale": 1.4508276569232255
          },
          "SHOT.SET_PIECE": {
            "shape": 1.758069076807605,
            "scale": 0.44881828808069113
          },
          "SHOT.TRANSITION": {
            "shape": 1.4659871740872112,
            "scale": 0.4790145786543332
          },
          "SHOT.PROGRESSION": {
            "shape": 3.0335766757516627,
            "scale": 0.7150168738605447
          },
          "SHOT.FINAL_THIRD": {
            "shape": 1.585052079554542,
            "scale": 0.44426251533285427
          }
        },
        "ACTION_PHASE_ZONE": {
          "PASS.SET_PIECE.DEF_WIDE": {
            "shape": 3.426192340433821,
            "scale": 0.5288694011839964
          },
          "PASS.SET_PIECE.DEF_CENTRAL": {
            "shape": 3.8032093642017566,
            "scale": 0.6518034861578376
          },
          "PASS.SET_PIECE.MID_WIDE": {
            "shape": 3.454320362590281,
            "scale": 0.44959347217254714
          },
          "PASS.SET_PIECE.MID_CENTRAL": {
            "shape": 3.4556289063412486,
            "scale": 0.4585610940264107
          },
          "PASS.SET_PIECE.ATT_WIDE": {
            "shape": 3.6249066799283596,
            "scale": 0.3692883934350782
          },
          "PASS.SET_PIECE.ATT_CENTRAL": {
            "shape": 3.212364034284353,
            "scale": 0.4708918381746009
          },
          "PASS.SET_PIECE.BOX": {
            "shape": 1.940748583978232,
            "scale": 0.6145179878707302
          },
          "PASS.TRANSITION.DEF_WIDE": {
            "shape": 4.2420882507884325,
            "scale": 0.39203367990907056
          },
          "PASS.TRANSITION.DEF_CENTRAL": {
            "shape": 3.8445120616436124,
            "scale": 0.4441302835268027
          },
          "PASS.TRANSITION.MID_WIDE": {
            "shape": 3.603968929841501,
            "scale": 0.44016711410560605
          },
          "PASS.TRANSITION.MID_CENTRAL": {
            "shape": 3.442895281978984,
            "scale": 0.4796736251452264
          },
          "PASS.TRANSITION.ATT_WIDE": {
            "shape": 2.334939284461931,
            "scale": 0.5681270668253128
          },
          "PASS.TRANSITION.ATT_CENTRAL": {
            "shape": 3.686535859262324,
            "scale": 0.3872256506867236
          },
          "PASS.TRANSITION.BOX": {
            "shape": 1.3591290908815419,
            "scale": 0.7066595903793959
          },
          "PASS.BUILD_UP.DEF_WIDE": {
            "shape": 3.2008304841465263,
            "scale": 0.4877255378520728
          },
          "PASS.BUILD_UP.DEF_CENTRAL": {
            "shape": 4.073043824370907,
            "scale": 0.453979202606348
          },
          "PASS.PROGRESSION.MID_WIDE": {
            "shape": 3.725877080953923,
            "scale": 0.37588306555987794
          },
          "PASS.PROGRESSION.MID_CENTRAL": {
            "shape": 4.335631372224324,
            "scale": 0.34778901691849057
          },
          "PASS.FINAL_THIRD.ATT_WIDE": {
            "shape": 3.0334170325028365,
            "scale": 0.38901921024182046
          },
          "PASS.FINAL_THIRD.ATT_CENTRAL": {
            "shape": 3.279475351348188,
            "scale": 0.40225120881291043
          },
          "PASS.FINAL_THIRD.BOX": {
            "shape": 1.7027206754024806,
            "scale": 0.5854049042717614
          },
          "CROSS.SET_PIECE.ATT_WIDE": {
            "shape": 5.40670472461975,
            "scale": 0.33541159648018265
          },
          "CROSS.SET_PIECE.BOX": {
            "shape": 2.56903955222936,
            "scale": 0.5369894965106176
          },
          "CROSS.FINAL_THIRD.ATT_WIDE": {
            "shape": 4.21865923357648,
            "scale": 0.437085943549134
          },
          "CROSS.FINAL_THIRD.BOX": {
            "shape": 2.386530521823417,
            "scale": 0.541698057766041
          },
          "CARRY.SET_PIECE.DEF_WIDE": {
            "shape": 1.0424445182869666,
            "scale": 1.5008978411674159
          },
          "CARRY.SET_PIECE.DEF_CENTRAL": {
            "shape": 1.3048842417385629,
            "scale": 1.6041687159101161
          },
          "CARRY.SET_PIECE.MID_WIDE": {
            "shape": 1.08081144291628,
            "scale": 1.345705203254862
          },
          "CARRY.SET_PIECE.MID_CENTRAL": {
            "shape": 1.1463365897243152,
            "scale": 1.3398579777250563
          },
          "CARRY.SET_PIECE.ATT_WIDE": {
            "shape": 1.0357130116852122,
            "scale": 1.467425327722644
          },
          "CARRY.SET_PIECE.ATT_CENTRAL": {
            "shape": 1.0879882443300108,
            "scale": 1.1905763721136222
          },
          "CARRY.SET_PIECE.BOX": {
            "shape": 0.8219997575891091,
            "scale": 1.371156976257382
          },
          "CARRY.TRANSITION.DEF_WIDE": {
            "shape": 1.3468580258581302,
            "scale": 1.836727529234806
          },
          "CARRY.TRANSITION.DEF_CENTRAL": {
            "shape": 0.9939664907646841,
            "scale": 2.993070980493889
          },
          "CARRY.TRANSITION.MID_WIDE": {
            "shape": 1.0852600153051377,
            "scale": 2.3093946993885996
          },
          "CARRY.TRANSITION.MID_CENTRAL": {
            "shape": 1.00627076417951,
            "scale": 2.1162595432442335
          },
          "CARRY.TRANSITION.ATT_WIDE": {
            "shape": 1.3979461826100252,
            "scale": 1.7217713499370773
          },
          "CARRY.TRANSITION.ATT_CENTRAL": {
            "shape": 1.5102052191730568,
            "scale": 1.1091183040921617
          },
          "CARRY.TRANSITION.BOX": {
            "shape": 1.474129920040395,
            "scale": 0.6995947183468952
          },
          "CARRY.BUILD_UP.DEF_WIDE": {
            "shape": 1.237165028693343,
            "scale": 1.4438165881691833
          },
          "CARRY.BUILD_UP.DEF_CENTRAL": {
            "shape": 1.0554063905846403,
            "scale": 2.112573561318192
          },
          "CARRY.PROGRESSION.MID_WIDE": {
            "shape": 1.2031460695095844,
            "scale": 1.4275712634723172
          },
          "CARRY.PROGRESSION.MID_CENTRAL": {
            "shape": 1.1701555228191458,
            "scale": 1.3927550878607164
          },
          "CARRY.FINAL_THIRD.ATT_WIDE": {
            "shape": 1.2519337320185417,
            "scale": 1.5013228714003604
          },
          "CARRY.FINAL_THIRD.ATT_CENTRAL": {
            "shape": 1.095071961730475,
            "scale": 1.2481213021482889
          },
          "CARRY.FINAL_THIRD.BOX": {
            "shape": 0.9475102962978581,
            "scale": 1.2928880360100348
          },
          "SHOT.SET_PIECE.ATT_WIDE": {
            "shape": 3.244657592800212,
            "scale": 0.3371078382721673
          },
          "SHOT.SET_PIECE.ATT_CENTRAL": {
            "shape": 2.088951347504096,
            "scale": 0.4122381602390892
          },
          "SHOT.SET_PIECE.BOX": {
            "shape": 1.6194018499679728,
            "scale": 0.44128916594888357
          },
          "SHOT.TRANSITION.ATT_CENTRAL": {
            "shape": 1.4614836365355148,
            "scale": 0.5523176465333304
          },
          "SHOT.TRANSITION.BOX": {
            "shape": 1.6218817476354253,
            "scale": 0.3790838442935706
          },
          "SHOT.FINAL_THIRD.ATT_WIDE": {
            "shape": 2.4774709990535344,
            "scale": 0.483441091858303
          },
          "SHOT.FINAL_THIRD.ATT_CENTRAL": {
            "shape": 1.5988221242623717,
            "scale": 0.5099335004128225
          },
          "SHOT.FINAL_THIRD.BOX": {
            "shape": 1.6396362288994928,
            "scale": 0.38128787095085953
          }
        }
      }
    },
    "shotModel": {
      "finisherVsGoalkeeperLogitCoefficient": 0.35,
      "shotsOnTarget": {
        "baseRate": 0.25,
        "finishingCoefficient": 0.04,
        "pressurePenalty": 0.03,
        "min": 0.15,
        "max": 0.65
      }
    },
    "homeAdvantage": {
      "targetXg": 1,
      "creationShare": 0.7,
      "shotQualityShare": 0.3
    },
    "readiness": {
      "fullEnergyThreshold": 75,
      "maxPenalty": 0.28,
      "curveExponent": 1.35
    },
    "defensiveOrganisation": {
      "baselineIntercept": 0.55,
      "formationCoverageWeight": 0.3,
      "readinessWeight": 0.15,
      "min": 0.35,
      "max": 1,
      "disruptionAdvancedRecoveryWeight": 0.5,
      "disruptionCommitmentWeight": 0.3,
      "disruptionPressExposureWeight": 0.2,
      "playersCommittedForwardNormalizer": 6,
      "recoveryPaceWeight": 0.5,
      "recoveryReadinessWeight": 0.5,
      "minRecoveryQuality": 0.25,
      "recoveryBaseSeconds": 12
    },
    "fatigue": {
      "fatigueScale": 1,
      "agePenaltyStartAge": 27,
      "agePenaltyPerYear": 1.8,
      "physicalBonusCoefficient": 0.25,
      "physicalBonusCenter": 50,
      "staminaCapacityMin": 45,
      "staminaCapacityMax": 100,
      "restLast24hPenalty": 1.1,
      "restLast72hPenalty": 0.35,
      "restDaysSinceMatchBonus": 15,
      "dailyRecoveryBase": 4,
      "dailyRecoveryStaminaCoefficient": 0.04,
      "dailyRecoveryRestCoefficient": 0.02,
      "dailyRecoveryMin": 4,
      "dailyRecoveryMax": 10,
      "roleLoad": {
        "GK": 0.2,
        "DEF": 0.75,
        "MID": 1,
        "ATT": 0.9
      },
      "pressLoadCoefficient": 0.22,
      "ageLoadCoefficient": 0.006,
      "perMinuteBase": 0.32,
      "lowEnergyAcceleration": 0.35,
      "involvementBase": 0.75,
      "involvementRange": 0.6
    },
    "fouls": {
      "disciplineRiskLogitCoefficient": 0.35,
      "pressIntensityLogitCoefficient": 0.2,
      "fatigueLogitCoefficient": 0.2,
      "lowOrganisationLogitCoefficient": 0.15
    },
    "cards": {
      "yellowTargetPerMatch": 1,
      "redTargetPerMatch": 0.0025,
      "disciplineRiskLogitCoefficient": 0.6,
      "fatigueLogitCoefficient": 0.25,
      "pressIntensityLogitCoefficient": 0.2,
      "highThreatLogitCoefficient": 0.2
    },
    "injuries": {
      "targetPerMatch": 0.075,
      "ageRiskStartAge": 28,
      "ageLogRiskPerYear": 0.025,
      "fatigueLogRiskCoefficient": 1.25,
      "recentWorkloadLogRiskCoefficient": 0.35
    }
  }
}
```

## Interpretation

The report preserves distributions (P05/P50/P95 and goal histograms in the JSON sidecar) so calibration is not average-only. Strength rows are monotonic when stronger teams show non-decreasing xG and result points; tactics are observable through possession, turnovers, shots and cards; energy and dismissal rows expose fatigue signatures.