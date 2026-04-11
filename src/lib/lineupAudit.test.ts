import { describe, expect, it } from 'vitest'
import {
  analyzeMatchPlan,
  buildScenarioId,
  createAuditRecord,
  createAuditScenarios,
  resolveLockedGoalkeeperIds,
} from './lineupAudit'
import { generateMatchPlan } from './scheduler'
import { createNamedPlayers } from './playerPool'
import { getChunkMinutesForSubstitutions } from './substitutions'
import type { MatchPlan, PeriodPlan, PlayerSummary } from './types'

describe('createAuditScenarios', () => {
  it('builds the full default UI matrix with stable scenario ids', () => {
    const scenarios = createAuditScenarios()

    expect(scenarios).toHaveLength(6400)
    expect(scenarios[0]?.scenarioId).toBe(
      'players-8_periods-1_period-5_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-none',
    )
    expect(
      buildScenarioId({
        playerCount: 10,
        periodCount: 3,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 3,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        liveAdjustmentPattern: 'none',
      }),
    ).toBe(
      'players-10_periods-3_period-20_formation-2-3-1_subs-3_gk-auto_roster-canonical_live-none',
    )
  })

  it('adds live adjustment patterns as an extra matrix dimension when requested', () => {
    const scenarios = createAuditScenarios({
      playerCounts: [10],
      periodCounts: [3],
      periodMinutes: [20],
      formations: ['2-3-1'],
      substitutions: [2],
      goalkeeperModes: ['auto'],
      rosterOrders: ['canonical'],
      liveAdjustmentPatterns: ['none', 'quick-return'],
    })

    expect(scenarios).toHaveLength(2)
    expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      'players-10_periods-3_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-none',
      'players-10_periods-3_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-quick-return',
    ])
  })

  it('includes 25-minute periods in the default audit matrix', () => {
    const scenarios = createAuditScenarios({
      playerCounts: [10],
      periodCounts: [3],
      periodMinutes: [25],
      formations: ['2-3-1'],
      substitutions: [2],
      goalkeeperModes: ['auto'],
      rosterOrders: ['canonical'],
      liveAdjustmentPatterns: ['none'],
    })

    expect(scenarios).toHaveLength(1)
    expect(scenarios[0]?.scenarioId).toBe(
      'players-10_periods-3_period-25_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-none',
    )
    expect(scenarios[0]?.chunkMinutes).toBe(12.5)
  })

  it('includes a 5-substitution scenario for 25-minute periods only', () => {
    const supportedScenario = createAuditScenarios({
      playerCounts: [10],
      periodCounts: [3],
      periodMinutes: [25],
      formations: ['2-3-1'],
      substitutions: [5],
      goalkeeperModes: ['auto'],
      rosterOrders: ['canonical'],
      liveAdjustmentPatterns: ['none'],
    })
    const unsupportedScenario = createAuditScenarios({
      playerCounts: [10],
      periodCounts: [3],
      periodMinutes: [20],
      formations: ['2-3-1'],
      substitutions: [5],
      goalkeeperModes: ['auto'],
      rosterOrders: ['canonical'],
      liveAdjustmentPatterns: ['none'],
    })

    expect(supportedScenario).toHaveLength(1)
    expect(supportedScenario[0]?.scenarioId).toBe(
      'players-10_periods-3_period-25_formation-2-3-1_subs-5_gk-auto_roster-canonical_live-none',
    )
    expect(supportedScenario[0]?.chunkMinutes).toBe(5)
    expect(unsupportedScenario).toHaveLength(0)
  })
})

describe('resolveLockedGoalkeeperIds', () => {
  it('maps deterministic goalkeeper modes to expected players', () => {
    const players = createNamedPlayers(8)

    expect(resolveLockedGoalkeeperIds(players, 'auto', 3)).toEqual([null, null, null])
    expect(resolveLockedGoalkeeperIds(players, 'lock-period-1', 3)).toEqual([
      players[0].id,
      null,
      null,
    ])
    expect(resolveLockedGoalkeeperIds(players, 'lock-period-1-and-last', 3)).toEqual([
      players[0].id,
      null,
      players[2].id,
    ])
    expect(resolveLockedGoalkeeperIds(players, 'lock-all-periods', 3)).toEqual([
      players[0].id,
      players[1].id,
      players[2].id,
    ])
    expect(resolveLockedGoalkeeperIds(players, 'lock-same-goalkeeper-all-periods', 3)).toEqual([
      players[0].id,
      players[0].id,
      players[0].id,
    ])
  })
})

describe('analyzeMatchPlan', () => {
  it('derives exact minute, goalkeeper and bench-streak metrics for a known plan', () => {
    const plan = createManualPlan()
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 8,
      chunkMinutes: 15,
      lockedGoalkeeperIds: ['p-1', null, 'p-3'],
    })
    const p1 = analysis.derivedMetrics.playerMetrics.find((metrics) => metrics.name === 'Spelare 1')
    const p8 = analysis.derivedMetrics.playerMetrics.find((metrics) => metrics.name === 'Spelare 8')

    expect(analysis.derivedMetrics.expectedTotalMinutes).toBe(315)
    expect(analysis.derivedMetrics.expectedBenchMinutes).toBe(45)
    expect(analysis.derivedMetrics.actualTotalMinutes).toBe(315)
    expect(analysis.derivedMetrics.actualBenchMinutes).toBe(45)
    expect(analysis.derivedMetrics.allowedConsecutiveBenchWindowsPerPlayer).toBe(0)
    expect(analysis.derivedMetrics.allowedBenchStreakWindows).toBe(1)
    expect(analysis.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(2)
    expect(analysis.derivedMetrics.goalkeeperMinutesTotal).toBe(45)
    expect(analysis.derivedMetrics.playersWithConsecutiveBenchWindows).toEqual(['Spelare 8'])
    expect(analysis.derivedMetrics.playersWithExcessConsecutiveBenchWindows).toEqual(['Spelare 8'])
    expect(analysis.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(p1).toMatchObject({
      goalkeeperMinutes: 15,
      outfieldMinutes: 30,
      longestPlayStreakWindows: 3,
      longestPlayStreakMinutes: 45,
    })
    expect(p8).toMatchObject({
      benchMinutes: 45,
      longestBenchStreakWindows: 3,
      longestBenchStreakMinutes: 45,
      consecutiveBenchWindowCount: 2,
    })
    expect(analysis.validations.totalMinutesMatchExpected).toBe(true)
    expect(analysis.validations.benchMinutesMatchExpected).toBe(true)
    expect(analysis.validations.lockedGoalkeepersRespected).toBe(true)
    expect(analysis.validations.noConsecutiveBenchWindows).toBe(false)
  })

  it('accepts recurring decimal chunk windows within minute tolerance', () => {
    const players = createNamedPlayers(10)
    const chunkMinutes = getChunkMinutesForSubstitutions(20, 3)
    const plan = generateMatchPlan({
      players,
      periodCount: 3,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1,
    })
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 10,
      chunkMinutes,
      lockedGoalkeeperIds: [null, null, null],
    })

    expect(analysis.validations.totalMinutesMatchExpected).toBe(true)
    expect(analysis.validations.benchMinutesMatchExpected).toBe(true)
    expect(analysis.validations.minuteSpreadWithinLimit).toBe(true)
    expect(analysis.validations.benchSpreadWithinLimit).toBe(true)
  })

  it('uses the theoretical one-period goalkeeper floor when chunk granularity makes tighter fairness impossible', () => {
    const players = createNamedPlayers(11)
    const chunkMinutes = getChunkMinutesForSubstitutions(20, 3)
    const plan = generateMatchPlan({
      players,
      periodCount: 1,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes,
      lockedGoalkeeperIds: [null],
      seed: 1,
    })
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 11,
      chunkMinutes,
      lockedGoalkeeperIds: [null],
    })

    expect(analysis.derivedMetrics.totalMinuteSpread).toBe(13.333)
    expect(analysis.derivedMetrics.benchMinuteSpread).toBe(13.333)
    expect(analysis.derivedMetrics.maxAllowedMinuteSpread).toBe(13.333)
    expect(analysis.validations.minuteSpreadWithinLimit).toBe(true)
    expect(analysis.validations.benchSpreadWithinLimit).toBe(true)
  })

  it('treats the new 11-player double-bench baseline as acceptable in audit validation', () => {
    const players = createNamedPlayers(11)
    const plan = generateMatchPlan({
      players,
      periodCount: 3,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1,
      attempts: 72,
    })
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 11,
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
    })

    expect(analysis.derivedMetrics.allowedConsecutiveBenchWindowsPerPlayer).toBe(1)
    expect(analysis.derivedMetrics.allowedBenchStreakWindows).toBe(2)
    expect(analysis.derivedMetrics.playersWithConsecutiveBenchWindows.length).toBeGreaterThan(0)
    expect(analysis.derivedMetrics.playersWithExcessConsecutiveBenchWindows).toEqual([])
    expect(analysis.validations.noConsecutiveBenchWindows).toBe(true)
  })

  it('accepts repeated manually locked goalkeepers without flagging them as invalid analysis', () => {
    const players = createNamedPlayers(9)
    const lockedGoalkeeperIds = [players[0].id, players[0].id, players[0].id]
    const plan = generateMatchPlan({
      players,
      periodCount: 3,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds,
      seed: 91,
      attempts: 24,
    })
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 9,
      chunkMinutes: 5,
      lockedGoalkeeperIds,
    })

    expect(plan.goalkeepers).toEqual(lockedGoalkeeperIds)
    expect(analysis.validations.lockedGoalkeepersRespected).toBe(true)
    expect(analysis.validations.summaryMinutesConsistent).toBe(true)
    expect('uniqueGoalkeepersPerPeriod' in analysis.validations).toBe(false)
  })

  it('uses a repeated-goalkeeper spread floor when one goalkeeper is locked for every period', () => {
    const players = createNamedPlayers(11)
    const lockedGoalkeeperIds = [players[0].id, players[0].id, players[0].id, players[0].id]
    const chunkMinutes = 12.5
    const plan = generateMatchPlan({
      players,
      periodCount: 4,
      periodMinutes: 25,
      formation: '2-3-1',
      chunkMinutes,
      lockedGoalkeeperIds,
      seed: 1,
      attempts: 48,
    })
    const analysis = analyzeMatchPlan(plan, {
      playerCount: 11,
      chunkMinutes,
      lockedGoalkeeperIds,
    })

    expect(analysis.derivedMetrics.totalMinuteSpread).toBe(50)
    expect(analysis.derivedMetrics.benchMinuteSpread).toBe(50)
    expect(analysis.derivedMetrics.maxAllowedMinuteSpread).toBe(52.5)
    expect(analysis.validations.minuteSpreadWithinLimit).toBe(true)
    expect(analysis.validations.benchSpreadWithinLimit).toBe(true)
  })
})

describe('createAuditRecord', () => {
  it('covers a repeated manual goalkeeper audit mode without creating false duplicate flags', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-9_periods-3_period-15_formation-2-3-1_subs-2_gk-lock-same-goalkeeper-all-periods_roster-canonical_live-none',
        playerCount: 9,
        periodCount: 3,
        periodMinutes: 15,
        formation: '2-3-1',
        substitutionsPerPeriod: 2,
        chunkMinutes: 7.5,
        goalkeeperMode: 'lock-same-goalkeeper-all-periods',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )

    expect(record.input.lockedGoalkeeperIds).toEqual([
      record.input.players[0].id,
      record.input.players[0].id,
      record.input.players[0].id,
    ])
    expect(record.plan.goalkeepers).toEqual(record.input.lockedGoalkeeperIds)
    expect(record.validations.lockedGoalkeepersRespected).toBe(true)
    expect(record.flags).not.toContain('goalkeeper-lock-mismatch')
    expect(record.flags).not.toContain('duplicate-goalkeepers')
  })

  it('does not flag structurally expected isolated play blocks for the 11-player baseline case', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-11_periods-3_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-none',
        playerCount: 11,
        periodCount: 3,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 2,
        chunkMinutes: 10,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('does not hard-flag one-period goalkeeper-driven spread when the theoretical floor exceeds one chunk', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-11_periods-1_period-20_formation-2-3-1_subs-3_gk-auto_roster-canonical_live-none',
        playerCount: 11,
        periodCount: 1,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 3,
        chunkMinutes: getChunkMinutesForSubstitutions(20, 3),
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )

    expect(record.derivedMetrics.maxAllowedMinuteSpread).toBe(13.333)
    expect(record.flags).not.toContain('minute-spread-over-limit')
    expect(record.flags).not.toContain('bench-spread-over-limit')
  })

  it('captures the single-period short-window continuity fix in audit player metrics', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-10_periods-1_period-20_formation-2-3-1_subs-4_gk-auto_roster-canonical_live-none',
        playerCount: 10,
        periodCount: 1,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 4,
        chunkMinutes: 5,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )
    const gunnar = record.derivedMetrics.playerMetrics.find((metrics) => metrics.name === 'Gunnar')

    expect(gunnar).toBeDefined()
    expect(gunnar).toMatchObject({
      isolatedPlayBlocks: 0,
      longestPlayStreakWindows: 2,
      chunkStates: ['B', 'P', 'P', 'B'],
    })
    expect(record.derivedMetrics.isolatedPlayBlockSeverity).toBe('ok')
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('accepts tiny recurring-decimal spread overages for 4x25 three-sub plans', () => {
    const record = createAuditRecord(
      createStandardScenario({
        playerCount: 11,
        periodCount: 4,
        periodMinutes: 25,
        formation: '2-3-1',
        substitutionsPerPeriod: 3,
      }),
      1,
    )

    expect(record.derivedMetrics.totalMinuteSpread).toBe(8.335)
    expect(record.derivedMetrics.maxAllowedMinuteSpread).toBe(8.333)
    expect(record.validations.minuteSpreadWithinLimit).toBe(true)
    expect(record.validations.benchSpreadWithinLimit).toBe(true)
    expect(record.flags).not.toContain('minute-spread-over-limit')
    expect(record.flags).not.toContain('bench-spread-over-limit')
  })

  it('downgrades dense 4x25 five-sub isolated blocks when fairness still holds', () => {
    const record = createAuditRecord(
      createStandardScenario({
        playerCount: 12,
        periodCount: 4,
        periodMinutes: 25,
        formation: '2-3-1',
        substitutionsPerPeriod: 5,
      }),
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(5)
    expect(record.derivedMetrics.isolatedPlayBlockSeverity).toBe('warning')
    expect(record.validations.minuteSpreadWithinLimit).toBe(true)
    expect(record.validations.benchSpreadWithinLimit).toBe(true)
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('does not flag the 9-player high-rotation case after the short-window continuity rebalance', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-9_periods-3_period-15_formation-2-3-1_subs-4_gk-auto_roster-canonical_live-none',
        playerCount: 9,
        periodCount: 3,
        periodMinutes: 15,
        formation: '2-3-1',
        substitutionsPerPeriod: 4,
        chunkMinutes: 3.75,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(2)
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('does not flag the 10-player high-rotation case after the short-window continuity rebalance', () => {
    const record = createAuditRecord(
      {
        scenarioId:
          'players-10_periods-3_period-15_formation-2-3-1_subs-4_gk-auto_roster-canonical_live-none',
        playerCount: 10,
        periodCount: 3,
        periodMinutes: 15,
        formation: '2-3-1',
        substitutionsPerPeriod: 4,
        chunkMinutes: 3.75,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
        liveAdjustmentPattern: 'none',
      },
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('downgrades the dense 11-player four-sub case to a warning-level isolated block signal', () => {
    const record = createAuditRecord(
      createStandardScenario({
        playerCount: 11,
        periodMinutes: 20,
        formation: '3-2-1',
        substitutionsPerPeriod: 4,
      }),
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
    expect(record.derivedMetrics.isolatedPlayBlockHardFlagThreshold).toBe(5)
    expect(record.derivedMetrics.isolatedPlayBlockHardFlagPlayerCount).toBe(3)
    expect(record.derivedMetrics.isolatedPlayBlockSeverity).toBe('warning')
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([
      { name: 'Gunnar', isolatedPlayBlocks: 4 },
    ])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('downgrades the dense 12-player four-sub case to a warning-level isolated block signal', () => {
    const record = createAuditRecord(
      createStandardScenario({
        playerCount: 12,
        periodMinutes: 20,
        formation: '3-2-1',
        substitutionsPerPeriod: 4,
      }),
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
    expect(record.derivedMetrics.isolatedPlayBlockHardFlagThreshold).toBe(5)
    expect(record.derivedMetrics.isolatedPlayBlockHardFlagPlayerCount).toBe(3)
    expect(record.derivedMetrics.isolatedPlayBlockSeverity).toBe('warning')
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([
      { name: 'David', isolatedPlayBlocks: 4 },
      { name: 'John', isolatedPlayBlocks: 4 },
    ])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it.each([
    {
      formation: '2-3-1' as const,
      seed: 7,
      expectedPlayer: 'Henry',
      scenarioId:
        'players-12_periods-3_period-20_formation-2-3-1_subs-3_gk-auto_roster-canonical_live-none',
    },
    {
      formation: '3-2-1' as const,
      seed: 42,
      expectedPlayer: 'Joar',
      scenarioId:
        'players-12_periods-3_period-20_formation-3-2-1_subs-3_gk-auto_roster-canonical_live-none',
    },
  ])(
    'keeps materially fragmented 12-player three-sub cases hard-flagged for $scenarioId',
    ({ formation, seed, expectedPlayer, scenarioId }) => {
      const record = createAuditRecord(
        createStandardScenario({
          playerCount: 12,
          periodMinutes: 20,
          formation,
          substitutionsPerPeriod: 3,
        }),
        seed,
      )

      expect(record.input.scenarioId).toBe(scenarioId)
      expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
      expect(record.derivedMetrics.isolatedPlayBlockHardFlagThreshold).toBe(4)
      expect(record.derivedMetrics.isolatedPlayBlockSeverity).toBe('flag')
      expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([
        { name: expectedPlayer, isolatedPlayBlocks: 5 },
      ])
      expect(record.derivedMetrics.totalMinuteSpread).toBeCloseTo(6.667, 3)
      expect(record.derivedMetrics.benchMinuteSpread).toBeCloseTo(6.667, 3)
      expect(record.flags).toContain('isolated-play-blocks')
    },
  )

  it.each([
    ['single-temporary-out', 20260315, 1, true],
    ['quick-return', 20260316, 2, true],
    ['injury-mid-match', 20260321, 1, true],
    ['double-temporary-out', 20260325, 2, true],
    ['cross-period-return', 20260327, 2, true],
    ['position-swap-outfield', 20260401, 1, true],
    ['position-swap-goalkeeper', 20260402, 1, true],
    ['position-swap-bench', 20260403, 1, true],
  ] as const)(
    'captures live adjustment data for %s',
    (liveAdjustmentPattern, seed, expectedEventCount, expectedFairnessWithinTolerance) => {
      const record = createAuditRecord(createLiveScenario(liveAdjustmentPattern), seed)

      expect(record.input.liveAdjustmentPattern).toBe(liveAdjustmentPattern)
      expect(record.liveAdjustment).toBeDefined()
      expect(record.liveAdjustment).toMatchObject({
        pattern: liveAdjustmentPattern,
        completed: true,
      })
      expect(record.liveAdjustment?.events).toHaveLength(expectedEventCount)
      expect(record.validations.noUnavailableLeaks).toBe(true)
      expect(record.validations.livePatternCompleted).toBe(true)
      expect(record.validations.liveFairnessWithinTolerance).toBe(expectedFairnessWithinTolerance)
      expect(record.flags).not.toContain('unavailable-player-leak')
      expect(record.flags).not.toContain('live-pattern-incomplete')
      expect(record.flags.includes('live-fairness-exceeded')).toBe(!expectedFairnessWithinTolerance)

      if (liveAdjustmentPattern.startsWith('position-swap')) {
        expect(record.liveAdjustment?.events).toMatchObject([
          {
            type: 'position-swap',
            playerId: expect.any(String),
            targetPlayerId: expect.any(String),
          },
        ])
      }
    },
  )

  it('flags unavailable-player-leak when a cross-period return result reports a leak', () => {
    const scenario = createLiveScenario('cross-period-return')
    const baseline = createAuditRecord(scenario, 20260327)
    const liveAdjustment = requireLiveAdjustment(baseline)

    const leakedPlayerId = liveAdjustment.events[0]?.playerId

    expect(leakedPlayerId).toBeTruthy()

    const record = createAuditRecord(scenario, 20260327, {
      liveAdjustmentResult: {
        plan: baseline.plan,
        noUnavailableLeaks: false,
        completed: true,
        liveAdjustment: {
          ...liveAdjustment,
          unavailablePlayerIds: leakedPlayerId ? [leakedPlayerId] : [],
        },
      },
    })

    expect(record.validations.noUnavailableLeaks).toBe(false)
    expect(record.validations.livePatternCompleted).toBe(true)
    expect(record.flags).toContain('unavailable-player-leak')
  })

  it('flags live-fairness-exceeded when double-temporary-out drifts past tolerance', () => {
    const scenario = createLiveScenario('double-temporary-out')
    const baseline = createAuditRecord(scenario, 20260325)
    const liveAdjustment = requireLiveAdjustment(baseline)

    const record = createAuditRecord(scenario, 20260325, {
      liveAdjustmentResult: {
        plan: baseline.plan,
        noUnavailableLeaks: true,
        completed: true,
        liveAdjustment: {
          ...liveAdjustment,
          fairness: {
            ...liveAdjustment.fairness,
            maxAbsDeltaMinutes: liveAdjustment.fairness.toleranceMinutes + 1,
          },
        },
      },
    })

    expect(record.validations.noUnavailableLeaks).toBe(true)
    expect(record.validations.liveFairnessWithinTolerance).toBe(false)
    expect(record.validations.livePatternCompleted).toBe(true)
    expect(record.flags).toContain('live-fairness-exceeded')
  })

  it('flags live patterns that cannot be fully applied for thin benches', () => {
    const record = createAuditRecord(
      {
        ...createLiveScenario('double-temporary-out'),
        scenarioId:
          'players-8_periods-3_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-double-temporary-out',
        playerCount: 8,
        rosterNames: [],
      },
      20260325,
    )

    expect(record.liveAdjustment?.events).toMatchObject([
      { stepId: 'double-out-1', replacementPlayerId: expect.any(String) },
      { stepId: 'double-out-2', replacementPlayerId: null },
    ])
    expect(record.liveAdjustment?.completed).toBe(false)
    expect(record.validations.livePatternCompleted).toBe(false)
    expect(record.flags).toContain('live-pattern-incomplete')
  })
})

function createLiveScenario(
  liveAdjustmentPattern:
    | 'single-temporary-out'
    | 'quick-return'
    | 'injury-mid-match'
    | 'double-temporary-out'
    | 'cross-period-return'
    | 'position-swap-outfield'
    | 'position-swap-goalkeeper'
    | 'position-swap-bench',
) {
  return {
    scenarioId: buildScenarioId({
      playerCount: 10,
      periodCount: 3,
      periodMinutes: 20,
      formation: '2-3-1',
      substitutionsPerPeriod: 2,
      goalkeeperMode: 'auto',
      rosterOrder: 'canonical',
      liveAdjustmentPattern,
    }),
    playerCount: 10,
    periodCount: 3,
    periodMinutes: 20 as const,
    formation: '2-3-1' as const,
    substitutionsPerPeriod: 2 as const,
    chunkMinutes: 10,
    goalkeeperMode: 'auto' as const,
    rosterOrder: 'canonical' as const,
    rosterNames: [],
    liveAdjustmentPattern,
  }
}

function createStandardScenario({
  playerCount,
  periodCount = 3,
  periodMinutes,
  formation,
  substitutionsPerPeriod,
}: {
  playerCount: number
  periodCount?: number
  periodMinutes: number
  formation: '2-3-1' | '3-2-1'
  substitutionsPerPeriod: 2 | 3 | 4 | 5
}) {
  return {
    scenarioId: buildScenarioId({
      playerCount,
      periodCount,
      periodMinutes,
      formation,
      substitutionsPerPeriod,
      goalkeeperMode: 'auto',
      rosterOrder: 'canonical',
      liveAdjustmentPattern: 'none',
    }),
    playerCount,
    periodCount,
    periodMinutes,
    formation,
    substitutionsPerPeriod,
    chunkMinutes: getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod),
    goalkeeperMode: 'auto' as const,
    rosterOrder: 'canonical' as const,
    rosterNames: [],
    liveAdjustmentPattern: 'none' as const,
  }
}

function requireLiveAdjustment(record: ReturnType<typeof createAuditRecord>) {
  expect(record.liveAdjustment).toBeDefined()

  return record.liveAdjustment!
}

function createManualPlan(): MatchPlan {
  const summaries = createManualSummaries()
  const playerNameById = Object.fromEntries(summaries.map((summary) => [summary.playerId, summary.name]))
  const periods: PeriodPlan[] = [
    createPeriod({
      period: 1,
      goalkeeperId: 'p-1',
      goalkeeperName: playerNameById['p-1'],
      lineup: {
        VB: 'p-2',
        HB: 'p-3',
        VM: 'p-4',
        CM: 'p-5',
        HM: 'p-6',
        A: 'p-7',
      },
      benchName: playerNameById['p-8'],
    }),
    createPeriod({
      period: 2,
      goalkeeperId: 'p-2',
      goalkeeperName: playerNameById['p-2'],
      lineup: {
        VB: 'p-1',
        HB: 'p-3',
        VM: 'p-4',
        CM: 'p-5',
        HM: 'p-6',
        A: 'p-7',
      },
      benchName: playerNameById['p-8'],
    }),
    createPeriod({
      period: 3,
      goalkeeperId: 'p-3',
      goalkeeperName: playerNameById['p-3'],
      lineup: {
        VB: 'p-1',
        HB: 'p-2',
        VM: 'p-4',
        CM: 'p-5',
        HM: 'p-6',
        A: 'p-7',
      },
      benchName: playerNameById['p-8'],
    }),
  ]

  return {
    seed: 1,
    score: 123,
    formation: '2-3-1',
    chunkMinutes: 15,
    periodMinutes: 15,
    positions: ['VB', 'HB', 'VM', 'CM', 'HM', 'A'],
    goalkeepers: ['p-1', 'p-2', 'p-3'],
    lockedGoalkeepers: ['p-1', null, 'p-3'],
    targets: {
      'p-1': 45,
      'p-2': 45,
      'p-3': 45,
      'p-4': 45,
      'p-5': 45,
      'p-6': 45,
      'p-7': 45,
      'p-8': 0,
    },
    fairnessTargets: {
      'p-1': 45,
      'p-2': 45,
      'p-3': 45,
      'p-4': 45,
      'p-5': 45,
      'p-6': 45,
      'p-7': 45,
      'p-8': 0,
    },
    periods,
    summaries,
  }
}

function createPeriod({
  period,
  goalkeeperId,
  goalkeeperName,
  lineup,
  benchName,
}: {
  period: number
  goalkeeperId: string
  goalkeeperName: string
  lineup: PeriodPlan['startingLineup']
  benchName: string
}): PeriodPlan {
  return {
    period,
    formation: '2-3-1',
    positions: ['VB', 'HB', 'VM', 'CM', 'HM', 'A'],
    goalkeeperId,
    goalkeeperName,
    startingLineup: lineup,
    chunks: [
      {
        chunkIndex: period - 1,
        period,
        windowIndex: 0,
        startMinute: 0,
        endMinute: 15,
        durationMinutes: 15,
        goalkeeperId,
        goalkeeperName,
        lineup,
        activePlayerIds: [goalkeeperId, ...(Object.values(lineup) as string[])],
        substitutes: [benchName],
        substitutions: [],
      },
    ],
    substitutes: [benchName],
  }
}

function createManualSummaries(): PlayerSummary[] {
  return [
    {
      playerId: 'p-1',
      name: 'Spelare 1',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [1],
      positionsPlayed: ['VB'],
      roleGroups: ['DEF'],
    },
    {
      playerId: 'p-2',
      name: 'Spelare 2',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [2],
      positionsPlayed: ['VB', 'HB'],
      roleGroups: ['DEF'],
    },
    {
      playerId: 'p-3',
      name: 'Spelare 3',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [3],
      positionsPlayed: ['HB'],
      roleGroups: ['DEF'],
    },
    {
      playerId: 'p-4',
      name: 'Spelare 4',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [],
      positionsPlayed: ['VM'],
      roleGroups: ['MID'],
    },
    {
      playerId: 'p-5',
      name: 'Spelare 5',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [],
      positionsPlayed: ['CM'],
      roleGroups: ['MID'],
    },
    {
      playerId: 'p-6',
      name: 'Spelare 6',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [],
      positionsPlayed: ['HM'],
      roleGroups: ['MID'],
    },
    {
      playerId: 'p-7',
      name: 'Spelare 7',
      totalMinutes: 45,
      benchMinutes: 0,
      goalkeeperPeriods: [],
      positionsPlayed: ['A'],
      roleGroups: ['ATT'],
    },
    {
      playerId: 'p-8',
      name: 'Spelare 8',
      totalMinutes: 0,
      benchMinutes: 45,
      goalkeeperPeriods: [],
      positionsPlayed: [],
      roleGroups: [],
    },
  ]
}
