import { describe, expect, it } from 'vitest'
import {
  buildGoalkeeperFairnessTargets,
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

function hasConsecutiveBenchWindows(plan: ReturnType<typeof generateMatchPlan>, players: Player[]) {
  const benchWindows = getBenchWindows(plan, players)

  for (let index = 1; index < benchWindows.length; index += 1) {
    const previousBench = new Set(benchWindows[index - 1])
    const currentBench = benchWindows[index]

    if (currentBench.some((playerId) => previousBench.has(playerId))) {
      return true
    }
  }

  return false
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

function createPlayerOrderById(players: Player[]) {
  return Object.fromEntries(players.map((player, index) => [player.id, index])) as Record<string, number>
}

describe('buildGoalkeeperFairnessTargets', () => {
  it('does not grant an extra bias chunk to a player who already covers multiple goalkeeper periods', () => {
    const players = createPlayers(9)
    const fairnessTargets = buildGoalkeeperFairnessTargets({
      playerIds: players.map((player) => player.id),
      goalkeepers: [players[0].id, players[0].id, players[1].id],
      periodCount: 3,
      periodMinutes: 15,
      chunkMinutes: 7.5,
      outfieldSlotCount: 6,
      playerOrderById: createPlayerOrderById(players),
      fallbackTargets: Object.fromEntries(players.map((player) => [player.id, 35])),
    })

    expect(fairnessTargets[players[0].id]).toBeCloseTo(30, 3)
    expect(fairnessTargets[players[1].id]).toBeCloseTo(37.5, 3)
    expect(fairnessTargets[players[2].id]).toBeCloseTo(37.5, 3)
    expect(fairnessTargets[players[7].id]).toBeCloseTo(30, 3)
    expect(fairnessTargets[players[8].id]).toBeCloseTo(30, 3)
  })
})

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

            if (playerCount <= 10) {
              expectNoConsecutiveBenchWindows(plan, players)
            }
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

  it('does not bench the same outfielder in consecutive windows across a period boundary for 10-player scenarios', () => {
    const players = createPlayers(10)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [players[0].id, players[3].id, players[7].id],
      seed: 5150,
      attempts: 24,
    })

    expectNoConsecutiveBenchWindows(plan, players)
  })

  it('allows the same manually locked goalkeeper across multiple periods while keeping auto-filled periods distinct', () => {
    const players = createPlayers(9)
    const repeatedGoalkeeperId = players[0].id
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [repeatedGoalkeeperId, repeatedGoalkeeperId, null],
      seed: 6161,
      attempts: 24,
    })

    expect(plan.goalkeepers[0]).toBe(repeatedGoalkeeperId)
    expect(plan.goalkeepers[1]).toBe(repeatedGoalkeeperId)
    expect(plan.goalkeepers[2]).not.toBeNull()
    expect(plan.goalkeepers[2]).not.toBe(repeatedGoalkeeperId)
    expect(plan.lockedGoalkeepers).toEqual([repeatedGoalkeeperId, repeatedGoalkeeperId, null])
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
          if (substitution.position === 'MV') {
            expect(previousChunk.goalkeeperId).toBe(substitution.playerOutId)
            expect(nextChunk.goalkeeperId).toBe(substitution.playerInId)
            continue
          }

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

  it('orders incoming substitutions by the previous bench order', () => {
    const players: Player[] = [
      { id: 'p-1', name: 'Adam' },
      { id: 'p-2', name: 'Anton' },
      { id: 'p-3', name: 'Bill' },
      { id: 'p-4', name: 'Dante' },
      { id: 'p-5', name: 'Elias' },
      { id: 'p-6', name: 'Emil' },
      { id: 'p-7', name: 'Gunnar' },
      { id: 'p-8', name: 'Henry' },
      { id: 'p-9', name: 'Jax' },
      { id: 'p-10', name: 'Noel' },
    ]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [players[9].id, players[8].id, players[7].id],
      seed: 1,
      attempts: 1,
    })
    const firstPeriod = plan.periods[0]
    const firstChunk = firstPeriod.chunks[0]
    const secondChunk = firstPeriod.chunks[1]
    const incomingNames = secondChunk.substitutions.map(
      (substitution) => players.find((player) => player.id === substitution.playerInId)?.name,
    )
    const previousBenchNames = players
      .filter((player) => firstChunk.substitutes.includes(player.name))
      .map((player) => player.name)

    expect(incomingNames).toEqual(previousBenchNames)
    expect(previousBenchNames).toHaveLength(3)
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

  it('prefers the higher total-minute tier for players with goalkeeper periods when chunk fairness cannot be exact', () => {
    const players = createPlayers(10)
    const lockedGoalkeeperIds = [players[0].id, players[1].id, players[2].id]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 20 / 3,
      lockedGoalkeeperIds,
      seed: 11,
      attempts: 72,
    })
    const summaryById = Object.fromEntries(plan.summaries.map((summary) => [summary.playerId, summary]))

    expect(new Set(Object.values(plan.targets))).toEqual(new Set([42]))

    for (const goalkeeperId of lockedGoalkeeperIds) {
      expect(plan.fairnessTargets[goalkeeperId]).toBeCloseTo(46.667, 3)
      expect(summaryById[goalkeeperId]?.totalMinutes).toBeCloseTo(plan.fairnessTargets[goalkeeperId], 3)
    }

    for (const player of players.slice(3)) {
      expect(plan.fairnessTargets[player.id]).toBeCloseTo(40, 3)
      expect(summaryById[player.id]?.totalMinutes).toBeCloseTo(plan.fairnessTargets[player.id], 2)
    }
  })

  it('does not introduce goalkeeper bias when exact total equality is chunk-feasible', () => {
    const players = createPlayers(9)
    const lockedGoalkeeperIds = [players[0].id, players[1].id, players[2].id]
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 20 / 3,
      lockedGoalkeeperIds,
      seed: 17,
      attempts: 72,
    })
    const totalMinutes = plan.summaries.map((summary) => summary.totalMinutes)

    for (const player of players) {
      expect(plan.fairnessTargets[player.id]).toBeCloseTo(46.667, 3)
    }

    expect(Math.max(...totalMinutes) - Math.min(...totalMinutes)).toBeLessThanOrEqual(0.0011)
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
      if (playerCount <= 10) {
        expectNoConsecutiveBenchWindows(plan, players)
      }
    }
  })

  it('keeps hard bench protection for 8-player scenarios', () => {
    const players = createPlayers(8)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 10,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1008,
      attempts: 24,
    })

    expectNoConsecutiveBenchWindows(plan, players)
  })

  it('allows at least one repeated bench window in a 12-player 5-minute scenario', () => {
    const players = createPlayers(12)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1012,
      attempts: 72,
    })

    expect(hasConsecutiveBenchWindows(plan, players)).toBe(true)
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

  it('keeps normalized fragmentation below half of the total score in a 12-player 5-minute regression', () => {
    const players = createPlayers(12)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1012,
      attempts: 72,
    })
    const normalized = getPlanScoreBreakdown(plan, 'normalized')

    expect(normalized.componentScores.fragmentedMinutesPenalty).toBeLessThanOrEqual(
      normalized.totalScore * 0.5,
    )
  })

  it('does not let expected 12-player double-bench windows dominate the normalized score', () => {
    const players = createPlayers(12)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1012,
      attempts: 72,
    })
    const normalized = getPlanScoreBreakdown(plan, 'normalized')

    expect(normalized.componentScores.consecutiveBenchPenalty).toBeLessThanOrEqual(
      normalized.totalScore * 0.25,
    )
  })

  it('accepts one chunk of minute spread as the floor for 9-player 20-minute matches with 10-minute chunks', () => {
    const players = createPlayers(9)
    const chunkMinutes = 10
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes,
      lockedGoalkeeperIds: [null, null, null],
      seed: 1009,
      attempts: 24,
    })
    const normalized = getPlanScoreBreakdown(plan, 'normalized')

    expect(normalized.components.minuteSpreadPenalty).toBeLessThanOrEqual(chunkMinutes)
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
