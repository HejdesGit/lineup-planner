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

    expect(scenarios).toHaveLength(480)
    expect(scenarios[0]?.scenarioId).toBe(
      'players-8_period-15_formation-2-3-1_subs-2_gk-auto_roster-canonical',
    )
    expect(
      buildScenarioId({
        playerCount: 10,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 3,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
      }),
    ).toBe('players-10_period-20_formation-2-3-1_subs-3_gk-auto_roster-canonical')
  })
})

describe('resolveLockedGoalkeeperIds', () => {
  it('maps deterministic goalkeeper modes to expected players', () => {
    const players = createNamedPlayers(8)

    expect(resolveLockedGoalkeeperIds(players, 'auto')).toEqual([null, null, null])
    expect(resolveLockedGoalkeeperIds(players, 'lock-period-1')).toEqual([players[0].id, null, null])
    expect(resolveLockedGoalkeeperIds(players, 'lock-period-1-and-3')).toEqual([
      players[0].id,
      null,
      players[2].id,
    ])
    expect(resolveLockedGoalkeeperIds(players, 'lock-all-3')).toEqual([
      players[0].id,
      players[1].id,
      players[2].id,
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

  it('treats the new 11-player double-bench baseline as acceptable in audit validation', () => {
    const players = createNamedPlayers(11)
    const plan = generateMatchPlan({
      players,
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
})

describe('createAuditRecord', () => {
  it('does not flag structurally expected isolated play blocks for the 11-player baseline case', () => {
    const record = createAuditRecord(
      {
        scenarioId: 'players-11_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical',
        playerCount: 11,
        periodMinutes: 20,
        formation: '2-3-1',
        substitutionsPerPeriod: 2,
        chunkMinutes: 10,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
      },
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(4)
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })

  it('does not flag the 9-player high-rotation case after the short-window continuity rebalance', () => {
    const record = createAuditRecord(
      {
        scenarioId: 'players-9_period-15_formation-2-3-1_subs-4_gk-auto_roster-canonical',
        playerCount: 9,
        periodMinutes: 15,
        formation: '2-3-1',
        substitutionsPerPeriod: 4,
        chunkMinutes: 3.75,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
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
        scenarioId: 'players-10_period-15_formation-2-3-1_subs-4_gk-auto_roster-canonical',
        playerCount: 10,
        periodMinutes: 15,
        formation: '2-3-1',
        substitutionsPerPeriod: 4,
        chunkMinutes: 3.75,
        goalkeeperMode: 'auto',
        rosterOrder: 'canonical',
        rosterNames: [],
      },
      1,
    )

    expect(record.derivedMetrics.allowedIsolatedPlayBlocksPerPlayer).toBe(3)
    expect(record.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([])
    expect(record.flags).not.toContain('isolated-play-blocks')
  })
})

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
