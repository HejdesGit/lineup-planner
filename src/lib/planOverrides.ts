import {
  ROLE_GROUPS,
  type Lineup,
  type MatchPlan,
  type OutfieldPosition,
  type PeriodPlan,
  type PlayerSummary,
} from './types'

export const GOALKEEPER_SLOT = 'MV' as const
export const BENCH_SLOT_PREFIX = 'B' as const

export type BenchSlotId = `${typeof BENCH_SLOT_PREFIX}${number}`
export type BoardSlotId = OutfieldPosition | typeof GOALKEEPER_SLOT | BenchSlotId
export type PeriodBoardOverrides = Partial<Record<number, Record<BoardSlotId, string>>>

export function createBoardAssignments(period: PeriodPlan): Record<BoardSlotId, string> {
  return {
    ...Object.fromEntries(
      period.positions.map((position) => [position, period.startingLineup[position] ?? '']),
    ),
    [GOALKEEPER_SLOT]: period.goalkeeperId,
    ...Object.fromEntries(
      getStartBenchPlayerIds(period).map((playerId, index) => [getBenchSlotId(index), playerId]),
    ),
  } as Record<BoardSlotId, string>
}

export function getBoardLineup(
  boardAssignments: Record<BoardSlotId, string>,
  positions: readonly OutfieldPosition[],
): Lineup {
  return Object.fromEntries(
    positions.map((position) => [position, boardAssignments[position]]),
  ) as Lineup
}

export function swapBoardAssignments(
  boardAssignments: Record<BoardSlotId, string>,
  sourceSlot: BoardSlotId,
  targetSlot: BoardSlotId,
) {
  return {
    ...boardAssignments,
    [sourceSlot]: boardAssignments[targetSlot],
    [targetSlot]: boardAssignments[sourceSlot],
  }
}

export function areBoardAssignmentsEqual(
  left: Partial<Record<BoardSlotId, string>>,
  right: Partial<Record<BoardSlotId, string>>,
) {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key, index) => {
    if (key !== rightKeys[index]) {
      return false
    }

    return left[key as BoardSlotId] === right[key as BoardSlotId]
  })
}

export function getBenchSlotId(index: number): BenchSlotId {
  return `${BENCH_SLOT_PREFIX}${index + 1}` as BenchSlotId
}

export function isBenchSlot(slotId: string): slotId is BenchSlotId {
  return slotId.startsWith(BENCH_SLOT_PREFIX)
}

export function getBoardBenchSlots(
  boardAssignments: Partial<Record<BoardSlotId, string>>,
): BenchSlotId[] {
  return Object.keys(boardAssignments)
    .filter(isBenchSlot)
    .sort((left, right) => getBenchSlotNumber(left) - getBenchSlotNumber(right)) as BenchSlotId[]
}

function getBenchSlotNumber(slotId: BenchSlotId) {
  return Number(slotId.slice(BENCH_SLOT_PREFIX.length))
}

function getStartBenchPlayerIds(period: PeriodPlan) {
  const firstChunk = period.chunks[0]

  if (!firstChunk) {
    return []
  }

  const firstChunkActiveIds = new Set(firstChunk.activePlayerIds)
  return collectPeriodPlayerIds(period).filter((playerId) => !firstChunkActiveIds.has(playerId))
}

function collectPeriodPlayerIds(period: PeriodPlan) {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const chunk of period.chunks) {
    for (const playerId of [
      chunk.goalkeeperId,
      ...chunk.activePlayerIds,
      ...chunk.substitutions.flatMap((substitution) => [
        substitution.playerInId,
        substitution.playerOutId,
      ]),
    ]) {
      if (!seen.has(playerId)) {
        seen.add(playerId)
        ordered.push(playerId)
      }
    }
  }

  return ordered
}

export function normalizePeriodOverrides(
  plan: MatchPlan,
  overrides: PeriodBoardOverrides,
): PeriodBoardOverrides {
  const normalized: PeriodBoardOverrides = {}

  for (const period of plan.periods) {
    const overrideAssignments = overrides[period.period]

    if (!overrideAssignments) {
      continue
    }

    const defaultAssignments = createBoardAssignments(period)

    if (!areBoardAssignmentsEqual(overrideAssignments, defaultAssignments)) {
      normalized[period.period] = overrideAssignments
    }
  }

  return normalized
}

export function applyPeriodOverrides(
  plan: MatchPlan,
  overrides: PeriodBoardOverrides,
): MatchPlan {
  if (Object.keys(overrides).length === 0) {
    return plan
  }

  const playerNameById = Object.fromEntries(
    plan.summaries.map((summary) => [summary.playerId, summary.name]),
  )
  const allPlayerIds = plan.summaries.map((summary) => summary.playerId)

  const periods = plan.periods.map((period) => {
    const overrideAssignments = overrides[period.period]

    if (!overrideAssignments) {
      return period
    }

    const originalAssignments = createBoardAssignments(period)
    const playerMapping = Object.fromEntries(
      (Object.keys(originalAssignments) as BoardSlotId[]).map((slotId) => [
        originalAssignments[slotId],
        overrideAssignments[slotId],
      ]),
    ) as Record<string, string>

    const chunks = period.chunks.map((chunk) => {
      const activePlayerIds = chunk.activePlayerIds.map(
        (playerId) => playerMapping[playerId] ?? playerId,
      )
      const substituteIds = allPlayerIds.filter((playerId) => !activePlayerIds.includes(playerId))

      return {
        ...chunk,
        goalkeeperId: playerMapping[chunk.goalkeeperId] ?? chunk.goalkeeperId,
        goalkeeperName:
          playerNameById[playerMapping[chunk.goalkeeperId] ?? chunk.goalkeeperId],
        lineup: Object.fromEntries(
          period.positions.map((position) => {
            const playerId = chunk.lineup[position]
            return [position, playerId ? playerMapping[playerId] ?? playerId : playerId]
          }),
        ) as Lineup,
        activePlayerIds,
        substitutes: substituteIds.map((playerId) => playerNameById[playerId]),
        substitutions: chunk.substitutions.map((substitution) => ({
          ...substitution,
          playerInId: playerMapping[substitution.playerInId] ?? substitution.playerInId,
          playerOutId: playerMapping[substitution.playerOutId] ?? substitution.playerOutId,
        })),
      }
    })

    const substituteIds = Array.from(
      new Set(
        chunks.flatMap((chunk) =>
          allPlayerIds.filter((playerId) => !chunk.activePlayerIds.includes(playerId)),
        ),
      ),
    )

    return {
      ...period,
      goalkeeperId: playerMapping[period.goalkeeperId] ?? period.goalkeeperId,
      goalkeeperName: playerNameById[playerMapping[period.goalkeeperId] ?? period.goalkeeperId],
      startingLineup: getBoardLineup(overrideAssignments, period.positions),
      chunks,
      substitutes: substituteIds.map((playerId) => playerNameById[playerId]),
    }
  })

  return {
    ...plan,
    periods,
    goalkeepers: periods.map((period) => period.goalkeeperId),
    summaries: buildSummariesFromPeriods(plan.summaries, periods, playerNameById),
  }
}

export function buildSummariesFromPeriods(
  baseSummaries: PlayerSummary[],
  periods: PeriodPlan[],
  playerNameById: Record<string, string>,
): PlayerSummary[] {
  return baseSummaries.map((summary) => {
    let totalMinutes = 0
    let benchMinutes = 0
    const goalkeeperPeriods: number[] = []
    const positionsPlayed = new Set<OutfieldPosition>()
    const roleGroups = new Set<PlayerSummary['roleGroups'][number]>()

    for (const period of periods) {
      let wasGoalkeeperInPeriod = false

      for (const chunk of period.chunks) {
        if (chunk.goalkeeperId === summary.playerId) {
          totalMinutes += chunk.durationMinutes
          wasGoalkeeperInPeriod = true
          continue
        }

        const playedPosition = period.positions.find(
          (position) => chunk.lineup[position] === summary.playerId,
        )

        if (playedPosition) {
          totalMinutes += chunk.durationMinutes
          positionsPlayed.add(playedPosition)
          roleGroups.add(ROLE_GROUPS[playedPosition])
        } else {
          benchMinutes += chunk.durationMinutes
        }
      }

      if (wasGoalkeeperInPeriod) {
        goalkeeperPeriods.push(period.period)
      }
    }

    return {
      ...summary,
      name: playerNameById[summary.playerId] ?? summary.name,
      totalMinutes,
      benchMinutes,
      goalkeeperPeriods,
      positionsPlayed: Array.from(positionsPlayed),
      roleGroups: (['DEF', 'MID', 'ATT'] as const).filter((group) => roleGroups.has(group)),
    }
  })
}
