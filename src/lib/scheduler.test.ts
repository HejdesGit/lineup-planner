import { describe, expect, it } from 'vitest'
import {
  generateMatchPlan,
  getPlanScoreBreakdown,
  resolveAttemptCount,
  scoreComponentsToTotal,
  scoreOutfieldPosition,
} from './scheduler'
import { FORMATION_PRESETS, type ChunkPlan, type FormationKey, type Player } from './types'

function createPlayers(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Spelare ${index + 1}`,
  }))
}

function getBenchWindows(plan: ReturnType<typeof generateMatchPlan>, players: Player[]) {
  const allChunks = plan.periods.flatMap((period) => period.chunks)

  return allChunks.map((chunk) => {
    const active = new Set(chunk.activePlayerIds)
    return players
      .filter((player) => !active.has(player.id))
      .map((player) => player.id)
      .sort()
  })
}

function getPlayerChunkStates(plan: ReturnType<typeof generateMatchPlan>, playerId: string) {
  return plan.periods.flatMap((period) =>
    period.chunks.map((chunk) => (chunk.activePlayerIds.includes(playerId) ? 'P' : 'B')),
  )
}

function getSingleChunkPlayBlocks(states: string[]) {
  let count = 0

  for (let index = 0; index < states.length; index += 1) {
    const isIsolatedPlayWindow =
      states[index] === 'P' &&
      states[index - 1] !== 'P' &&
      states[index + 1] !== 'P'

    if (isIsolatedPlayWindow) {
      count += 1
    }
  }

  return count
}

function getLongestPlayStreak(states: string[]) {
  let longest = 0
  let current = 0

  for (const state of states) {
    if (state === 'P') {
      current += 1
      longest = Math.max(longest, current)
      continue
    }

    current = 0
  }

  return longest
}

function expectNoConsecutiveBenchWindows(
  plan: ReturnType<typeof generateMatchPlan>,
  players: Player[],
) {
  const benchWindows = getBenchWindows(plan, players)

  for (let index = 1; index < benchWindows.length; index += 1) {
    const previousBench = new Set(benchWindows[index - 1])
    const currentBench = benchWindows[index]

    expect(
      currentBench.filter((playerId) => previousBench.has(playerId)),
      `bench repeated between windows ${index - 1} and ${index}`,
    ).toEqual([])
  }
}

function getChangedPositions(previousChunk: ChunkPlan, nextChunk: ChunkPlan) {
  return Object.keys(previousChunk.lineup).filter((position) => {
    const previousPlayerId = previousChunk.lineup[position as keyof typeof previousChunk.lineup]
    const nextPlayerId = nextChunk.lineup[position as keyof typeof nextChunk.lineup]
    return previousPlayerId !== nextPlayerId
  })
}

function getOutfieldPlayerToPosition(chunk: ChunkPlan) {
  return Object.fromEntries(
    Object.entries(chunk.lineup).map(([position, playerId]) => [playerId, position]),
  ) as Record<string, string>
}

describe('generateMatchPlan', () => {
  for (const formation of ['2-3-1', '3-2-1'] as FormationKey[]) {
    for (const chunkMinutes of [5, 7, 10]) {
      for (const playerCount of [8, 9, 10, 11, 12]) {
        for (const periodMinutes of [15, 20] as const) {
          it(`creates a valid ${formation} plan for ${playerCount} players at 3x${periodMinutes} with ${chunkMinutes} minute windows`, () => {
            const players = createPlayers(playerCount)
            const plan = generateMatchPlan({
              players,
              periodMinutes,
              formation,
              chunkMinutes,
              lockedGoalkeeperIds: [null, null, null],
              seed: 1234 + playerCount + periodMinutes + chunkMinutes,
              attempts: 12,
            })

            const positions = FORMATION_PRESETS[formation].positions

            expect(plan.periods).toHaveLength(3)
            expect(plan.formation).toBe(formation)
            expect(new Set(plan.goalkeepers).size).toBe(3)
            expect(plan.positions).toEqual(positions)

            for (const period of plan.periods) {
              expect(period.formation).toBe(formation)

              for (const chunk of period.chunks) {
                expect(chunk.durationMinutes).toBeGreaterThan(0)
                expect(chunk.durationMinutes).toBeLessThanOrEqual(chunkMinutes)
                expect(new Set(Object.keys(chunk.lineup))).toEqual(new Set(positions))
                expect(new Set(Object.values(chunk.lineup)).size).toBe(6)
                expect(new Set([...Object.values(chunk.lineup), chunk.goalkeeperId]).size).toBe(7)
              }
            }

            const totalMinutes = plan.summaries.reduce((sum, summary) => sum + summary.totalMinutes, 0)
            const totalBenchMinutes = plan.summaries.reduce((sum, summary) => sum + summary.benchMinutes, 0)
            const minuteValues = plan.summaries.map((summary) => summary.totalMinutes)
            const expectedTotalMinutes = 3 * periodMinutes * 7
            const expectedBenchMinutes = 3 * periodMinutes * (playerCount - 7)
            const trailingChunkMinutes = periodMinutes % chunkMinutes || chunkMinutes
            const allowedMinuteSpread =
              playerCount === 12 ? chunkMinutes + trailingChunkMinutes : chunkMinutes

            expect(totalMinutes).toBe(expectedTotalMinutes)
            expect(totalBenchMinutes).toBe(expectedBenchMinutes)
            expect(Math.max(...minuteValues) - Math.min(...minuteValues)).toBeLessThanOrEqual(
              allowedMinuteSpread,
            )

            for (const summary of plan.summaries) {
              expect(summary.totalMinutes + summary.benchMinutes).toBe(3 * periodMinutes)
            }

            expectNoConsecutiveBenchWindows(plan, players)
          })
        }
      }
    }
  }

  it('varies period starters and opening bench groups across periods when alternatives exist', () => {
    const players = createPlayers(10)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 4242,
      attempts: 24,
    })

    const periodOneStarters = new Set(Object.values(plan.periods[0].startingLineup))
    const periodTwoStarters = new Set(Object.values(plan.periods[1].startingLineup))
    const periodThreeStarters = new Set(Object.values(plan.periods[2].startingLineup))
    const periodOneBench = new Set(plan.periods[0].chunks[0].substitutes)
    const periodTwoBench = new Set(plan.periods[1].chunks[0].substitutes)
    const periodThreeBench = new Set(plan.periods[2].chunks[0].substitutes)

    expect(periodOneStarters).not.toEqual(periodTwoStarters)
    expect(periodTwoStarters).not.toEqual(periodThreeStarters)
    expect(periodOneBench).not.toEqual(periodTwoBench)
    expect(periodTwoBench).not.toEqual(periodThreeBench)
  })

  it('does not bench the same outfielder in consecutive windows across a period boundary', () => {
    const players = createPlayers(11)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [players[0].id, players[4].id, players[8].id],
      seed: 5150,
      attempts: 24,
    })

    expectNoConsecutiveBenchWindows(plan, players)
  })

  it('keeps previously benched players active in the next window for the Bill scenario', () => {
    const players = createPlayers(10).map((player, index) =>
      index === 1 ? { ...player, name: 'Bill' } : player,
    )
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 2027,
      attempts: 32,
    })

    const benchWindows = getBenchWindows(plan, players)
    const billId = players[1].id

    for (let index = 1; index < benchWindows.length; index += 1) {
      expect(
        !(benchWindows[index - 1].includes(billId) && benchWindows[index].includes(billId)),
      ).toBe(true)
    }
  })

  it('keeps continuing outfielders on the same positions within a period', () => {
    const players = createPlayers(9)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [players[0].id, players[1].id, players[2].id],
      seed: 8080,
      attempts: 24,
    })

    for (const period of plan.periods) {
      for (let index = 1; index < period.chunks.length; index += 1) {
        const previousChunk = period.chunks[index - 1]
        const nextChunk = period.chunks[index]
        const previousPositions = getOutfieldPlayerToPosition(previousChunk)
        const nextPositions = getOutfieldPlayerToPosition(nextChunk)
        const previousOutfieldIds = new Set(Object.values(previousChunk.lineup))
        const nextOutfieldIds = new Set(Object.values(nextChunk.lineup))
        const sharedPlayers = [...previousOutfieldIds].filter((playerId) => nextOutfieldIds.has(playerId))
        const changedPositions = getChangedPositions(previousChunk, nextChunk)

        expect(changedPositions).toHaveLength(nextChunk.substitutions.length)

        for (const playerId of sharedPlayers) {
          expect(nextPositions[playerId]).toBe(previousPositions[playerId])
        }

        for (const substitution of nextChunk.substitutions) {
          expect(previousChunk.lineup[substitution.position]).toBe(substitution.playerOutId)
          expect(nextChunk.lineup[substitution.position]).toBe(substitution.playerInId)
        }

        if (nextChunk.substitutions.length === 1) {
          expect(changedPositions).toHaveLength(1)
        }
      }
    }
  })

  it('supports Marvin, Ruben and Vilhelm as local one-for-one substitutions', () => {
    const players: Player[] = [
      { id: 'gk-1', name: 'Adam' },
      { id: 'gk-2', name: 'Oscar' },
      { id: 'gk-3', name: 'Noel' },
      { id: 'p-1', name: 'Marvin' },
      { id: 'p-2', name: 'Ruben' },
      { id: 'p-3', name: 'Vilhelm' },
      { id: 'p-4', name: 'Loui' },
      { id: 'p-5', name: 'Elias' },
    ]
    let matchingPlan: ReturnType<typeof generateMatchPlan> | null = null

    for (let seed = 1; seed <= 200; seed += 1) {
      const candidatePlan = generateMatchPlan({
        players,
        periodMinutes: 15,
        formation: '2-3-1',
        chunkMinutes: 5,
        lockedGoalkeeperIds: [players[0].id, players[1].id, players[2].id],
        seed,
        attempts: 1,
      })

      const playerNameById = Object.fromEntries(players.map((player) => [player.id, player.name]))
      const incomingNames = new Set(
        candidatePlan.periods
          .flatMap((period) => period.chunks)
          .flatMap((chunk) => chunk.substitutions)
          .map((substitution) => playerNameById[substitution.playerInId]),
      )

      if (['Marvin', 'Ruben', 'Vilhelm'].every((name) => incomingNames.has(name))) {
        matchingPlan = candidatePlan
        break
      }
    }

    expect(matchingPlan).not.toBeNull()

    const playerNameById = Object.fromEntries(players.map((player) => [player.id, player.name]))
    const substitutions = matchingPlan!.periods
      .flatMap((period) => period.chunks)
      .flatMap((chunk) => chunk.substitutions)

    for (const name of ['Marvin', 'Ruben', 'Vilhelm']) {
      const substitution = substitutions.find(
        (candidate) => playerNameById[candidate.playerInId] === name,
      )

      expect(substitution, `${name} should enter through a local substitution`).toBeDefined()
      expect(substitution?.playerOutId).not.toBe(substitution?.playerInId)
    }
  })

  it('allows a full position reset between periods', () => {
    const players = createPlayers(10)
    let foundBoundaryReset = false

    for (let seed = 1; seed <= 80; seed += 1) {
      const plan = generateMatchPlan({
        players,
        periodMinutes: 15,
        formation: '2-3-1',
        chunkMinutes: 5,
        lockedGoalkeeperIds: [null, null, null],
        seed,
        attempts: 1,
      })

      for (let index = 1; index < plan.periods.length; index += 1) {
        const previousChunk = plan.periods[index - 1].chunks.at(-1)
        const nextChunk = plan.periods[index].chunks[0]
        if (!previousChunk) {
          continue
        }

        const previousPositions = getOutfieldPlayerToPosition(previousChunk)
        const nextPositions = getOutfieldPlayerToPosition(nextChunk)
        const sharedPlayers = Object.keys(previousPositions).filter((playerId) => playerId in nextPositions)

        if (sharedPlayers.some((playerId) => previousPositions[playerId] !== nextPositions[playerId])) {
          foundBoundaryReset = true
          break
        }
      }

      if (foundBoundaryReset) {
        break
      }
    }

    expect(foundBoundaryReset).toBe(true)
  })

  it('keeps named outfielders within one window of total minutes in the 11-player scenario', () => {
    const players: Player[] = [
      { id: 'p-1', name: 'Adam' },
      { id: 'p-2', name: 'Emil' },
      { id: 'p-3', name: 'Leonel' },
      { id: 'p-4', name: 'LionLionLion' },
      { id: 'p-5', name: 'Madison' },
      { id: 'p-6', name: 'Matvii' },
      { id: 'p-7', name: 'Svante' },
      { id: 'p-8', name: 'Noel' },
      { id: 'p-9', name: 'Oscar' },
      { id: 'p-10', name: 'Vilhelm' },
      { id: 'p-11', name: 'Ruben' },
    ]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1,
      attempts: 72,
    })
    const totals = Object.fromEntries(plan.summaries.map((summary) => [summary.name, summary.totalMinutes]))

    expect(Math.abs(totals.Leonel - totals.Emil)).toBeLessThanOrEqual(10)
    expect(Math.abs(totals.Leonel - totals.Madison)).toBeLessThanOrEqual(10)
  })

  it('avoids giving Leonel only isolated one-window stints in the 11-player scenario', () => {
    const players: Player[] = [
      { id: 'p-1', name: 'Adam' },
      { id: 'p-2', name: 'Emil' },
      { id: 'p-3', name: 'Leonel' },
      { id: 'p-4', name: 'LionLionLion' },
      { id: 'p-5', name: 'Madison' },
      { id: 'p-6', name: 'Matvii' },
      { id: 'p-7', name: 'Svante' },
      { id: 'p-8', name: 'Noel' },
      { id: 'p-9', name: 'Oscar' },
      { id: 'p-10', name: 'Vilhelm' },
      { id: 'p-11', name: 'Ruben' },
    ]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1,
      attempts: 72,
    })
    const leonel = players.find((player) => player.name === 'Leonel')

    expect(leonel).toBeDefined()

    const leonelStates = getPlayerChunkStates(plan, leonel!.id)

    expect(getSingleChunkPlayBlocks(leonelStates)).toBeLessThanOrEqual(1)
    expect(getLongestPlayStreak(leonelStates)).toBeGreaterThanOrEqual(2)
  })

  it('gives Matvii at least one attacking assignment when he logs heavy outfield minutes', () => {
    const players: Player[] = [
      { id: 'p-1', name: 'Adam' },
      { id: 'p-2', name: 'Emil' },
      { id: 'p-3', name: 'Leonel' },
      { id: 'p-4', name: 'LionLionLion' },
      { id: 'p-5', name: 'Madison' },
      { id: 'p-6', name: 'Matvii' },
      { id: 'p-7', name: 'Svante' },
      { id: 'p-8', name: 'Noel' },
      { id: 'p-9', name: 'Oscar' },
      { id: 'p-10', name: 'Vilhelm' },
    ]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
      seed: 3,
      attempts: 72,
    })
    const matvii = plan.summaries.find((summary) => summary.name === 'Matvii')

    expect(matvii?.totalMinutes).toBeGreaterThanOrEqual(40)
    expect(matvii?.positionsPlayed).toContain('A')
  })

  it('compares legacy and normalized scores for 8, 10 and 12-player regressions', () => {
    for (const playerCount of [8, 10, 12]) {
      const players = createPlayers(playerCount)
      const plan = generateMatchPlan({
        players,
        periodMinutes: 20,
        formation: '2-3-1',
        chunkMinutes: 10,
        lockedGoalkeeperIds: [null, null, null],
        seed: 1000 + playerCount,
        attempts: 24,
      })

      const normalized = getPlanScoreBreakdown(plan, 'normalized')
      const legacy = getPlanScoreBreakdown(plan, 'legacy')

      expect(plan.score).toBe(normalized.totalScore)
      expect(legacy.totalScore).not.toBe(normalized.totalScore)
      expectNoConsecutiveBenchWindows(plan, players)
    }
  })
})

describe('scheduler scoring calibration', () => {
  it('keeps per-player aggregate scoring closer across 8, 10 and 12 players than legacy scoring', () => {
    const legacyScores = [8, 10, 12].map((playerCount) =>
      scoreComponentsToTotal(
        {
          playerCount,
          targetPenalty: playerCount * 6,
          minuteSpreadPenalty: 10,
          benchSpreadPenalty: 10,
          repeatPenalty: playerCount * 14,
          periodStartPenalty: playerCount * 12,
          consecutiveBenchPenalty: playerCount * 20,
          fragmentedMinutesPenalty: playerCount * 10,
          groupBreadthPenalty: playerCount * 8,
          periodStartVariationPenalty: 32,
        },
        'legacy',
      ).totalScore,
    )
    const normalizedScores = [8, 10, 12].map((playerCount) =>
      scoreComponentsToTotal(
        {
          playerCount,
          targetPenalty: playerCount * 6,
          minuteSpreadPenalty: 10,
          benchSpreadPenalty: 10,
          repeatPenalty: playerCount * 14,
          periodStartPenalty: playerCount * 12,
          consecutiveBenchPenalty: playerCount * 20,
          fragmentedMinutesPenalty: playerCount * 10,
          groupBreadthPenalty: playerCount * 8,
          periodStartVariationPenalty: 32,
        },
        'normalized',
      ).totalScore,
    )

    expect(Math.max(...normalizedScores) - Math.min(...normalizedScores)).toBeLessThan(
      Math.max(...legacyScores) - Math.min(...legacyScores),
    )
  })

  it('still lets repeat, fragmentation and group breadth penalties influence the winner after normalization', () => {
    const cleanerRotation = scoreComponentsToTotal(
      {
        playerCount: 10,
        targetPenalty: 12,
        minuteSpreadPenalty: 10,
        benchSpreadPenalty: 10,
        repeatPenalty: 18,
        periodStartPenalty: 12,
        consecutiveBenchPenalty: 24,
        fragmentedMinutesPenalty: 10,
        groupBreadthPenalty: 6,
        periodStartVariationPenalty: 28,
      },
      'normalized',
    )
    const worseRotation = scoreComponentsToTotal(
      {
        playerCount: 10,
        targetPenalty: 12,
        minuteSpreadPenalty: 10,
        benchSpreadPenalty: 10,
        repeatPenalty: 60,
        periodStartPenalty: 12,
        consecutiveBenchPenalty: 24,
        fragmentedMinutesPenalty: 38,
        groupBreadthPenalty: 24,
        periodStartVariationPenalty: 28,
      },
      'normalized',
    )

    expect(cleanerRotation.totalScore).toBeLessThan(worseRotation.totalScore)
    expect(worseRotation.componentScores.repeatPenalty).toBeGreaterThan(
      cleanerRotation.componentScores.repeatPenalty,
    )
    expect(worseRotation.componentScores.fragmentedMinutesPenalty).toBeGreaterThan(
      cleanerRotation.componentScores.fragmentedMinutesPenalty,
    )
    expect(worseRotation.componentScores.groupBreadthPenalty).toBeGreaterThan(
      cleanerRotation.componentScores.groupBreadthPenalty,
    )
  })
})

describe('resolveAttemptCount', () => {
  it('keeps the 72-attempt floor for simpler scenarios and scales up for larger searches', () => {
    expect(
      resolveAttemptCount({
        players: createPlayers(6),
        periodMinutes: 15,
        chunkMinutes: 10,
      }),
    ).toBe(72)

    expect(
      resolveAttemptCount({
        players: createPlayers(12),
        periodMinutes: 20,
        chunkMinutes: 5,
      }),
    ).toBe(288)
  })

  it('respects an explicit attempts override', () => {
    expect(
      resolveAttemptCount({
        players: createPlayers(12),
        periodMinutes: 20,
        chunkMinutes: 5,
        attempts: 16,
      }),
    ).toBe(16)
  })
})

describe('scoreOutfieldPosition', () => {
  it('prefers a new group over repeating DEF', () => {
    const snapshot = {
      lastOutfieldPosition: 'HB' as const,
      lastOutfieldGroup: 'DEF' as const,
      groupCounts: { DEF: 5, MID: 0, ATT: 0 },
      positionCounts: { VB: 0, CB: 0, HB: 5, VM: 0, CM: 0, HM: 0, A: 0 },
      groupsPlayed: ['DEF'] as const,
      positionsPlayed: ['HB'] as const,
    }

    expect(scoreOutfieldPosition(snapshot, 'CM', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'CB', 'period-start'),
    )
    expect(scoreOutfieldPosition(snapshot, 'A', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'HB', 'period-start'),
    )
  })

  it('still penalizes the exact same position, but less than staying in the same group', () => {
    const snapshot = {
      lastOutfieldPosition: 'CM' as const,
      lastOutfieldGroup: 'MID' as const,
      groupCounts: { DEF: 0, MID: 10, ATT: 0 },
      positionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 10, HM: 0, A: 0 },
      groupsPlayed: ['MID'] as const,
      positionsPlayed: ['CM'] as const,
    }

    expect(scoreOutfieldPosition(snapshot, 'CM', 'period-start')).toBeGreaterThan(
      scoreOutfieldPosition(snapshot, 'VB', 'period-start'),
    )
    expect(scoreOutfieldPosition(snapshot, 'VM', 'period-start')).toBeGreaterThan(
      scoreOutfieldPosition(snapshot, 'A', 'period-start'),
    )
  })

  it('prefers ATT over another MID spot after DEF and MID history', () => {
    const snapshot = {
      lastOutfieldPosition: 'HM' as const,
      lastOutfieldGroup: 'MID' as const,
      groupCounts: { DEF: 2, MID: 2, ATT: 0 },
      positionCounts: { VB: 1, CB: 0, HB: 1, VM: 1, CM: 1, HM: 2, A: 0 },
      groupsPlayed: ['DEF', 'MID'] as const,
      positionsPlayed: ['VB', 'HB', 'VM', 'CM', 'HM'] as const,
    }

    expect(scoreOutfieldPosition(snapshot, 'A', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'VM', 'period-start'),
    )
    expect(scoreOutfieldPosition(snapshot, 'A', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'CM', 'period-start'),
    )
  })

  it('prefers DEF over another MID spot after MID and ATT history', () => {
    const snapshot = {
      lastOutfieldPosition: 'HM' as const,
      lastOutfieldGroup: 'MID' as const,
      groupCounts: { DEF: 0, MID: 2, ATT: 2 },
      positionCounts: { VB: 0, CB: 0, HB: 0, VM: 1, CM: 1, HM: 2, A: 2 },
      groupsPlayed: ['MID', 'ATT'] as const,
      positionsPlayed: ['VM', 'CM', 'HM', 'A'] as const,
    }

    expect(scoreOutfieldPosition(snapshot, 'VB', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'VM', 'period-start'),
    )
    expect(scoreOutfieldPosition(snapshot, 'HB', 'period-start')).toBeLessThan(
      scoreOutfieldPosition(snapshot, 'CM', 'period-start'),
    )
  })

  it('respects locked goalkeepers for specific periods', () => {
    const players = createPlayers(10)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [players[2].id, null, players[7].id],
      seed: 99,
      attempts: 12,
    })

    expect(plan.periods[0].goalkeeperId).toBe(players[2].id)
    expect(plan.periods[2].goalkeeperId).toBe(players[7].id)
    expect(new Set(plan.goalkeepers).size).toBe(3)
  })
})
