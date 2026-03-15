import {
  ALL_POSITIONS,
  FORMATION_PRESETS,
  PERIOD_COUNT,
  ROLE_GROUPS,
  type ChunkSubstitution,
  type FormationKey,
  type Lineup,
  type MatchConfig,
  type MatchPlan,
  type OutfieldPosition,
  type PeriodPlan,
  type Player,
  type PlayerSummary,
  type RoleGroup,
} from './types'

interface RotationSnapshot {
  lastOutfieldPosition: OutfieldPosition | null
  lastOutfieldGroup: RoleGroup | null
  groupCounts: Partial<Record<RoleGroup, number>>
  positionCounts: Partial<Record<OutfieldPosition, number>>
  groupsPlayed: readonly RoleGroup[]
  positionsPlayed: readonly OutfieldPosition[]
}

type RotationPhase = 'period-start' | 'in-period'

interface MatchChunk {
  chunkIndex: number
  periodIndex: number
  windowIndex: number
  startMinute: number
  endMinute: number
  durationMinutes: number
}

interface PlayerHistory {
  actualMinutes: number
  outfieldMinutes: number
  benchMinutes: number
  playStreak: number
  benchStreak: number
  lastChunkState: 'active' | 'bench' | null
  stateTransitions: number
  shortPlayBlocks: number
  consecutiveBenchViolations: number
  benchViolationWeight: number
  maxBenchStreak: number
  goalkeeperPeriods: number[]
  lastOutfieldPosition: OutfieldPosition | null
  lastOutfieldGroup: RoleGroup | null
  groupCounts: Record<RoleGroup, number>
  positionCounts: Record<OutfieldPosition, number>
  groupsPlayed: Set<RoleGroup>
  positionsPlayed: Set<OutfieldPosition>
  samePositionRepeats: number
  sameGroupRepeats: number
  periodStarts: number
  periodBenchStarts: number
  startedPreviousPeriod: boolean
  benchedPreviousPeriod: boolean
  lastStartPosition: OutfieldPosition | null
  lastStartGroup: RoleGroup | null
  startGroupCounts: Record<RoleGroup, number>
  startPositionCounts: Record<OutfieldPosition, number>
  startGroupsPlayed: Set<RoleGroup>
  startPositionsPlayed: Set<OutfieldPosition>
  sameStartPositionRepeats: number
  sameStartGroupRepeats: number
  repeatedStartPeriods: number
  repeatedBenchStartPeriods: number
}

interface CandidatePlan {
  score: number
  periods: PeriodPlan[]
  summaries: PlayerSummary[]
  targets: Record<string, number>
  fairnessTargets: Record<string, number>
  goalkeepers: string[]
}

export type ScoringProfileName = 'legacy' | 'normalized'

export interface ScoreComponents {
  playerCount: number
  targetPenalty: number
  minuteSpreadPenalty: number
  benchSpreadPenalty: number
  repeatPenalty: number
  periodStartPenalty: number
  consecutiveBenchPenalty: number
  fragmentedMinutesPenalty: number
  groupBreadthPenalty: number
  periodStartVariationPenalty: number
}

interface ScoringProfile {
  name: ScoringProfileName
  weights: Omit<ScoreComponents, 'playerCount'>
  normalizeComponents: ReadonlySet<keyof Omit<ScoreComponents, 'playerCount'>>
}

interface AssignmentResult {
  lineup: Lineup
  substitutions: ChunkSubstitution[]
}

const DEFAULT_ATTEMPTS = 72
const AGGREGATE_SCORING_COMPONENTS = new Set<keyof Omit<ScoreComponents, 'playerCount'>>([
  'targetPenalty',
  'repeatPenalty',
  'periodStartPenalty',
  'consecutiveBenchPenalty',
  'fragmentedMinutesPenalty',
  'groupBreadthPenalty',
])

const LEGACY_SCORING_PROFILE: ScoringProfile = {
  name: 'legacy',
  weights: {
    targetPenalty: 20,
    minuteSpreadPenalty: 8,
    benchSpreadPenalty: 8,
    repeatPenalty: 1,
    periodStartPenalty: 1,
    consecutiveBenchPenalty: 1,
    fragmentedMinutesPenalty: 1,
    groupBreadthPenalty: 1,
    periodStartVariationPenalty: 1,
  },
  normalizeComponents: new Set(),
}

const NORMALIZED_SCORING_PROFILE: ScoringProfile = {
  name: 'normalized',
  weights: {
    targetPenalty: 180,
    minuteSpreadPenalty: 8,
    benchSpreadPenalty: 8,
    repeatPenalty: 12,
    periodStartPenalty: 10,
    consecutiveBenchPenalty: 12,
    fragmentedMinutesPenalty: 3,
    groupBreadthPenalty: 11,
    periodStartVariationPenalty: 1,
  },
  normalizeComponents: AGGREGATE_SCORING_COMPONENTS,
}

// Revert to the legacy profile if the regression calibration stops holding.
const ACTIVE_SCORING_PROFILE = NORMALIZED_SCORING_PROFILE

function getRoleGroup(position: OutfieldPosition): RoleGroup {
  return ROLE_GROUPS[position]
}

export function scoreOutfieldPosition(
  snapshot: RotationSnapshot,
  position: OutfieldPosition,
  phase: RotationPhase = 'in-period',
): number {
  const nextGroup = getRoleGroup(position)
  const groupsPlayed = new Set(snapshot.groupsPlayed)
  const positionsPlayed = new Set(snapshot.positionsPlayed)
  const groupCost = scoreGroupRotation(snapshot, nextGroup, groupsPlayed, phase)
  const positionCost = scoreWithinGroupPosition(snapshot, position, positionsPlayed, phase)

  return groupCost + positionCost
}

function scoreGroupRotation(
  snapshot: RotationSnapshot,
  nextGroup: RoleGroup,
  groupsPlayed: Set<RoleGroup>,
  phase: RotationPhase,
) {
  let cost = 0
  const minutesPlayed = Object.values(snapshot.groupCounts).reduce((total, value) => total + (value ?? 0), 0)

  const sameGroupPenalty = phase === 'period-start' ? 20 : 13
  const differentGroupBonus = phase === 'period-start' ? 10 : 6
  const newGroupBonus = phase === 'period-start' ? 15 : 10
  const oneGroupBreadthBonus = phase === 'period-start' ? 12 : 8
  const twoGroupBreadthBonus = phase === 'period-start' ? 6 : 4
  const groupCountWeight = phase === 'period-start' ? 2.5 : 1.85
  const attackerDiscoveryBonus =
    nextGroup === 'ATT' && !groupsPlayed.has('ATT')
      ? phase === 'period-start'
        ? minutesPlayed >= 20
          ? 12
          : 6
        : minutesPlayed >= 20
          ? 10
          : 5
      : 0

  if (snapshot.lastOutfieldGroup === nextGroup) {
    cost += sameGroupPenalty
  } else if (snapshot.lastOutfieldGroup) {
    cost -= differentGroupBonus
  }

  if (!groupsPlayed.has(nextGroup)) {
    cost -= newGroupBonus
  }

  if (groupsPlayed.size === 1 && !groupsPlayed.has(nextGroup)) {
    cost -= oneGroupBreadthBonus
  }

  if (groupsPlayed.size === 2 && !groupsPlayed.has(nextGroup)) {
    cost -= twoGroupBreadthBonus
  }

  cost -= attackerDiscoveryBonus
  cost += (snapshot.groupCounts[nextGroup] ?? 0) * groupCountWeight

  return cost
}

function scoreWithinGroupPosition(
  snapshot: RotationSnapshot,
  position: OutfieldPosition,
  positionsPlayed: Set<OutfieldPosition>,
  phase: RotationPhase,
) {
  let cost = 0
  const samePositionPenalty = phase === 'period-start' ? 2 : 3
  const newPositionBonus = phase === 'period-start' ? 0.35 : 0.5
  const positionCountWeight = phase === 'period-start' ? 0.05 : 0.1

  if (snapshot.lastOutfieldPosition === position) {
    cost += samePositionPenalty
  }

  if (!positionsPlayed.has(position)) {
    cost -= newPositionBonus
  }

  cost += (snapshot.positionCounts[position] ?? 0) * positionCountWeight

  return cost
}

export function generateMatchPlan({
  players,
  periodMinutes,
  formation,
  chunkMinutes,
  lockedGoalkeeperIds,
  seed = Date.now(),
  attempts,
}: MatchConfig): MatchPlan {
  validateConfig(players, periodMinutes, formation, chunkMinutes, lockedGoalkeeperIds)
  const resolvedAttempts = resolveAttemptCount({ players, periodMinutes, chunkMinutes, attempts })

  let best: CandidatePlan | null = null
  let bestSeed = seed

  for (let index = 0; index < resolvedAttempts; index += 1) {
    const candidateSeed = (seed + index * 7919) >>> 0
    const candidate = buildCandidatePlan(
      players,
      periodMinutes,
      formation,
      chunkMinutes,
      lockedGoalkeeperIds,
      candidateSeed,
    )
    if (!candidate) {
      continue
    }

    if (!best || candidate.score < best.score) {
      best = candidate
      bestSeed = candidateSeed
    }
  }

  if (!best) {
    throw new Error('Kunde inte skapa ett giltigt matchschema.')
  }

  return {
    seed: bestSeed,
    score: best.score,
    formation,
    chunkMinutes,
    periodMinutes,
    positions: FORMATION_PRESETS[formation].positions,
    goalkeepers: best.goalkeepers,
    lockedGoalkeepers: normalizeLockedGoalkeepers(lockedGoalkeeperIds),
    targets: best.targets,
    fairnessTargets: best.fairnessTargets,
    periods: best.periods,
    summaries: best.summaries,
  }
}

function validateConfig(
  players: Player[],
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  lockedGoalkeeperIds?: Array<string | null>,
) {
  if (players.length < 8 || players.length > 12) {
    throw new Error('Antalet spelare måste vara mellan 8 och 12.')
  }

  if (periodMinutes !== 15 && periodMinutes !== 20) {
    throw new Error('Matchtiden måste vara 15 eller 20 minuter per period.')
  }

  if (!(formation in FORMATION_PRESETS)) {
    throw new Error('Formationen stöds inte.')
  }

  if (!isValidChunkMinutes(chunkMinutes)) {
    throw new Error('Bytesfönstret måste vara mellan 5 och 10 minuter i hela eller halva minuter.')
  }

  if (lockedGoalkeeperIds && lockedGoalkeeperIds.length !== PERIOD_COUNT) {
    throw new Error('Målvaktsval måste anges för exakt tre perioder.')
  }

  if (lockedGoalkeeperIds) {
    const selectedGoalkeepers = lockedGoalkeeperIds.filter(
      (goalkeeperId): goalkeeperId is string => Boolean(goalkeeperId),
    )
    if (new Set(selectedGoalkeepers).size !== selectedGoalkeepers.length) {
      throw new Error('Välj tre olika målvakter om du låser perioderna manuellt.')
    }

    for (const goalkeeperId of selectedGoalkeepers) {
      if (!players.some((player) => player.id === goalkeeperId)) {
        throw new Error('En vald målvakt finns inte i spelarlistan.')
      }
    }
  }
}

function buildCandidatePlan(
  players: Player[],
  periodMinutes: 15 | 20,
  formation: FormationKey,
  chunkMinutes: number,
  lockedGoalkeeperIds: Array<string | null> | undefined,
  seed: number,
): CandidatePlan | null {
  const rng = createRng(seed)
  const positions = FORMATION_PRESETS[formation].positions
  const matchChunks = buildMatchChunks(periodMinutes, chunkMinutes)
  const totalPlayerMinutes = PERIOD_COUNT * periodMinutes * 7
  const playerIds = players.map((player) => player.id)
  const playerOrderById = Object.fromEntries(playerIds.map((id, index) => [id, index])) as Record<
    string,
    number
  >
  const nameById = Object.fromEntries(players.map((player) => [player.id, player.name]))
  const targets = distributeTargetMinutes(playerIds, totalPlayerMinutes, rng)
  const goalkeepers = resolveGoalkeepers(playerIds, normalizeLockedGoalkeepers(lockedGoalkeeperIds), rng)
  const goalkeeperMinuteCounts = Object.fromEntries(playerIds.map((id) => [id, 0])) as Record<
    string,
    number
  >

  for (const goalkeeperId of goalkeepers) {
    goalkeeperMinuteCounts[goalkeeperId] += periodMinutes
  }

  const outfieldTargets = Object.fromEntries(
    playerIds.map((id) => [id, Math.max(0, targets[id] - goalkeeperMinuteCounts[id])]),
  ) as Record<string, number>
  const remainingEligibleByPlayer = buildRemainingEligibleLookup(playerIds, matchChunks, goalkeepers)
  const histories = createHistories(players, goalkeepers)
  const periods: PeriodPlan[] = []

  for (let periodIndex = 0; periodIndex < PERIOD_COUNT; periodIndex += 1) {
    const goalkeeperId = goalkeepers[periodIndex]
    const chunks = []
    const substituteSet = new Set<string>()
    const periodChunks = matchChunks.filter((chunk) => chunk.periodIndex === periodIndex)
    let previousLineup: Lineup | null = null

    for (const chunk of periodChunks) {
      const phase: RotationPhase = chunk.windowIndex === 0 ? 'period-start' : 'in-period'
      const outfieldPlayers = selectOutfieldPlayers({
        chunk,
        playerIds,
        goalkeeperId,
        histories,
        outfieldTargets,
        remainingEligibleByPlayer,
        positions,
        phase,
        rng,
      })

      if (!outfieldPlayers) {
        return null
      }

      const assignmentResult: AssignmentResult =
        phase === 'period-start' || !previousLineup
          ? {
              lineup: assignBestPositions(outfieldPlayers, positions, histories, phase),
              substitutions: [],
            }
          : assignInPeriodLineup(outfieldPlayers, previousLineup, positions, histories, playerOrderById)
      const assignment = assignmentResult.lineup
      const activePlayerIds = [goalkeeperId, ...positions.map((position) => getLineupPlayer(assignment, position))]
      const activeSet = new Set(activePlayerIds)

      for (const playerId of playerIds) {
        const history = histories[playerId]
        const isActive = activeSet.has(playerId)
        const nextState = isActive ? 'active' : 'bench'

        if (history.lastChunkState && history.lastChunkState !== nextState) {
          history.stateTransitions += 1
        }

        if (isActive) {
          history.actualMinutes += chunk.durationMinutes
          history.playStreak += 1
          history.benchStreak = 0
        } else {
          if (history.playStreak === 1) {
            history.shortPlayBlocks += 1
          }
          const nextBenchStreak = history.benchStreak + 1
          if (history.benchStreak > 0) {
            history.consecutiveBenchViolations += 1
            history.benchViolationWeight += nextBenchStreak
          }
          history.benchMinutes += chunk.durationMinutes
          history.playStreak = 0
          history.benchStreak = nextBenchStreak
          history.maxBenchStreak = Math.max(history.maxBenchStreak, nextBenchStreak)
          substituteSet.add(playerId)
        }

        history.lastChunkState = nextState
      }

      if (phase === 'period-start') {
        updatePeriodStartHistory(playerIds, goalkeeperId, activeSet, positions, assignment, histories)
      }

      for (const position of positions) {
        const playerId = getLineupPlayer(assignment, position)
        const history = histories[playerId]
        const group = getRoleGroup(position)

        if (history.lastOutfieldPosition === position) {
          history.samePositionRepeats += 1
        }
        if (history.lastOutfieldGroup === group) {
          history.sameGroupRepeats += 1
        }

        history.outfieldMinutes += chunk.durationMinutes
        history.lastOutfieldPosition = position
        history.lastOutfieldGroup = group
        history.positionCounts[position] += chunk.durationMinutes
        history.groupCounts[group] += chunk.durationMinutes
        history.positionsPlayed.add(position)
        history.groupsPlayed.add(group)
      }

      chunks.push({
        chunkIndex: chunk.chunkIndex,
        period: periodIndex + 1,
        windowIndex: chunk.windowIndex,
        startMinute: chunk.startMinute,
        endMinute: chunk.endMinute,
        durationMinutes: chunk.durationMinutes,
        goalkeeperId,
        goalkeeperName: nameById[goalkeeperId],
        lineup: assignment,
        activePlayerIds,
        substitutes: playerIds
          .filter((playerId) => !activeSet.has(playerId))
          .map((playerId) => nameById[playerId]),
        substitutions: assignmentResult.substitutions,
      })

      previousLineup = assignment
    }

    periods.push({
      period: periodIndex + 1,
      formation,
      positions,
      goalkeeperId,
      goalkeeperName: nameById[goalkeeperId],
      startingLineup: chunks[0].lineup,
      chunks,
      substitutes: Array.from(substituteSet).map((playerId) => nameById[playerId]),
    })
  }

  for (const history of Object.values(histories)) {
    if (history.playStreak === 1) {
      history.shortPlayBlocks += 1
    }
  }

  const summaries = players.map((player) => {
    const history = histories[player.id]
    return {
      playerId: player.id,
      name: player.name,
      totalMinutes: history.actualMinutes,
      benchMinutes: history.benchMinutes,
      goalkeeperPeriods: [...history.goalkeeperPeriods],
      positionsPlayed: ALL_POSITIONS.filter((position) => history.positionsPlayed.has(position)),
      roleGroups: (['DEF', 'MID', 'ATT'] as RoleGroup[]).filter((group) =>
        history.groupsPlayed.has(group),
      ),
    }
  })

  const scoreComponents = buildScoreComponents(targets, histories, periods, players.length)

  return {
    score: scoreComponentsToTotal(scoreComponents, ACTIVE_SCORING_PROFILE.name).totalScore,
    periods,
    summaries,
    targets,
    fairnessTargets: targets,
    goalkeepers,
  }
}

function normalizeLockedGoalkeepers(lockedGoalkeeperIds?: Array<string | null>) {
  return Array.from({ length: PERIOD_COUNT }, (_, index) => lockedGoalkeeperIds?.[index] ?? null)
}

function resolveGoalkeepers(
  playerIds: string[],
  lockedGoalkeeperIds: Array<string | null>,
  rng: () => number,
) {
  const chosen = [...lockedGoalkeeperIds]
  const usedIds = new Set(chosen.filter((goalkeeperId): goalkeeperId is string => Boolean(goalkeeperId)))
  const remainingIds = shuffle(
    playerIds.filter((playerId) => !usedIds.has(playerId)),
    rng,
  )

  for (let periodIndex = 0; periodIndex < PERIOD_COUNT; periodIndex += 1) {
    if (chosen[periodIndex]) {
      continue
    }

    const nextGoalkeeper = remainingIds.shift()
    if (!nextGoalkeeper) {
      throw new Error('Det finns inte tillräckligt många spelare för att välja tre olika målvakter.')
    }
    chosen[periodIndex] = nextGoalkeeper
  }

  return chosen as string[]
}

export function resolveAttemptCount({
  players,
  periodMinutes,
  chunkMinutes,
  attempts,
}: {
  players: Player[]
  periodMinutes: 15 | 20
  chunkMinutes: number
  attempts?: number
}) {
  if (typeof attempts === 'number') {
    return attempts
  }

  return Math.max(DEFAULT_ATTEMPTS, players.length * getTotalChunkCount(periodMinutes, chunkMinutes) * 2)
}

function getTotalChunkCount(periodMinutes: 15 | 20, chunkMinutes: number) {
  return PERIOD_COUNT * Math.ceil(periodMinutes / chunkMinutes)
}

function buildMatchChunks(periodMinutes: 15 | 20, chunkMinutes: number): MatchChunk[] {
  const chunks: MatchChunk[] = []
  let chunkIndex = 0

  for (let periodIndex = 0; periodIndex < PERIOD_COUNT; periodIndex += 1) {
    let cursor = 0
    let windowIndex = 0

    while (cursor < periodMinutes - 0.0001) {
      const nextCursor = roundMinuteValue(Math.min(cursor + chunkMinutes, periodMinutes))
      chunks.push({
        chunkIndex,
        periodIndex,
        windowIndex,
        startMinute: roundMinuteValue(cursor),
        endMinute: nextCursor,
        durationMinutes: roundMinuteValue(nextCursor - cursor),
      })
      cursor = nextCursor
      windowIndex += 1
      chunkIndex += 1
    }
  }

  return chunks
}

function isValidChunkMinutes(chunkMinutes: number) {
  return Number.isFinite(chunkMinutes) && chunkMinutes >= 3.75 && chunkMinutes <= 10
}

function roundMinuteValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function createHistories(players: Player[], goalkeepers: string[]): Record<string, PlayerHistory> {
  return Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        actualMinutes: 0,
        outfieldMinutes: 0,
        benchMinutes: 0,
        playStreak: 0,
        benchStreak: 0,
        lastChunkState: null,
        stateTransitions: 0,
        shortPlayBlocks: 0,
        consecutiveBenchViolations: 0,
        benchViolationWeight: 0,
        maxBenchStreak: 0,
        goalkeeperPeriods: goalkeepers
          .map((goalkeeperId, index) => (goalkeeperId === player.id ? index + 1 : null))
          .filter((value): value is number => value !== null),
        lastOutfieldPosition: null,
        lastOutfieldGroup: null,
        groupCounts: { DEF: 0, MID: 0, ATT: 0 },
        positionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 },
        groupsPlayed: new Set<RoleGroup>(),
        positionsPlayed: new Set<OutfieldPosition>(),
        samePositionRepeats: 0,
        sameGroupRepeats: 0,
        periodStarts: 0,
        periodBenchStarts: 0,
        startedPreviousPeriod: false,
        benchedPreviousPeriod: false,
        lastStartPosition: null,
        lastStartGroup: null,
        startGroupCounts: { DEF: 0, MID: 0, ATT: 0 },
        startPositionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 },
        startGroupsPlayed: new Set<RoleGroup>(),
        startPositionsPlayed: new Set<OutfieldPosition>(),
        sameStartPositionRepeats: 0,
        sameStartGroupRepeats: 0,
        repeatedStartPeriods: 0,
        repeatedBenchStartPeriods: 0,
      },
    ]),
  )
}

function buildRemainingEligibleLookup(
  playerIds: string[],
  matchChunks: MatchChunk[],
  goalkeepers: string[],
) {
  const lookup: Record<string, number[]> = {}

  for (const playerId of playerIds) {
    const remaining: number[] = Array.from({ length: matchChunks.length }, () => 0)
    let running = 0

    for (let chunkIndex = matchChunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = matchChunks[chunkIndex]
      if (goalkeepers[chunk.periodIndex] !== playerId) {
        running += chunk.durationMinutes
      }
      remaining[chunkIndex] = running
    }

    lookup[playerId] = remaining
  }

  return lookup
}

function selectOutfieldPlayers({
  chunk,
  playerIds,
  goalkeeperId,
  histories,
  outfieldTargets,
  remainingEligibleByPlayer,
  positions,
  phase,
  rng,
}: {
  chunk: MatchChunk
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, PlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  phase: RotationPhase
  rng: () => number
}) {
  if (phase === 'period-start') {
    return selectPeriodStarters({
      chunk,
      playerIds,
      goalkeeperId,
      histories,
      outfieldTargets,
      remainingEligibleByPlayer,
      positions,
      rng,
    })
  }

  return selectInPeriodPlayers({
    chunk,
    playerIds,
    goalkeeperId,
    histories,
    outfieldTargets,
    remainingEligibleByPlayer,
    positions,
    rng,
  })
}

function selectPeriodStarters({
  chunk,
  playerIds,
  goalkeeperId,
  histories,
  outfieldTargets,
  remainingEligibleByPlayer,
  positions,
  rng,
}: {
  chunk: MatchChunk
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, PlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  rng: () => number
}) {
  const candidates: Array<{ playerId: string; score: number }> = []

  for (const playerId of playerIds) {
    if (playerId === goalkeeperId) {
      continue
    }

    const history = histories[playerId]
    const remainingNeed = outfieldTargets[playerId] - history.outfieldMinutes
    const remainingOpportunities = remainingEligibleByPlayer[playerId][chunk.chunkIndex]
    const futureAfterCurrent = remainingOpportunities - chunk.durationMinutes
    const criticalGap = Math.max(remainingNeed - futureAfterCurrent, 0)
    const shortagePressure = remainingNeed / Math.max(remainingOpportunities, 1)
    const score =
      (history.startedPreviousPeriod ? -140 : 75) +
      (history.benchedPreviousPeriod ? 95 : 0) +
      history.periodBenchStarts * 30 -
      history.periodStarts * 22 +
      history.repeatedBenchStartPeriods * 45 -
      history.repeatedStartPeriods * 18 +
      criticalGap * 85 +
      Math.max(remainingNeed, 0) * 12 +
      shortagePressure * 24 -
      history.actualMinutes * 1.2 +
      rng() * 0.01

    candidates.push({ playerId, score })
  }

  return selectPlayersWithBenchProtection(candidates, histories, positions.length, playerIds.length)
}

function selectInPeriodPlayers({
  chunk,
  playerIds,
  goalkeeperId,
  histories,
  outfieldTargets,
  remainingEligibleByPlayer,
  positions,
  rng,
}: {
  chunk: MatchChunk
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, PlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  rng: () => number
}) {
  const candidates: Array<{ playerId: string; score: number }> = []

  for (const playerId of playerIds) {
    if (playerId === goalkeeperId) {
      continue
    }

    const history = histories[playerId]
    const remainingNeed = outfieldTargets[playerId] - history.outfieldMinutes
    const remainingOpportunities = remainingEligibleByPlayer[playerId][chunk.chunkIndex]
    const futureAfterCurrent = remainingOpportunities - chunk.durationMinutes
    const criticalGap = Math.max(remainingNeed - futureAfterCurrent, 0)
    const shortagePressure = remainingNeed / Math.max(remainingOpportunities, 1)
    const shortWindowSinglePlayProtection =
      playerIds.length <= 10 && chunk.durationMinutes <= 5 && history.playStreak === 1 ? 110 : 0
    const score =
      criticalGap * 100 +
      Math.max(remainingNeed, 0) * 12 +
      shortagePressure * 30 +
      history.benchStreak * 120 -
      history.actualMinutes * 0.55 +
      shortWindowSinglePlayProtection +
      Math.min(history.playStreak, 2) * 20 +
      rng() * 0.01

    candidates.push({ playerId, score })
  }

  return selectPlayersWithBenchProtection(candidates, histories, positions.length, playerIds.length)
}

function selectPlayersWithBenchProtection(
  candidates: Array<{ playerId: string; score: number }>,
  histories: Record<string, PlayerHistory>,
  requiredCount: number,
  playerCount: number,
) {
  candidates.sort((left, right) => right.score - left.score)

  if (playerCount >= 11) {
    const selected = candidates.slice(0, requiredCount).map((candidate) => candidate.playerId)
    return selected.length === requiredCount ? selected : null
  }

  const mandatory = candidates.filter((candidate) => histories[candidate.playerId].benchStreak > 0)
  const optional = candidates.filter((candidate) => histories[candidate.playerId].benchStreak === 0)

  if (mandatory.length >= requiredCount) {
    return mandatory.slice(0, requiredCount).map((candidate) => candidate.playerId)
  }

  const selected = [
    ...mandatory.map((candidate) => candidate.playerId),
    ...optional.slice(0, requiredCount - mandatory.length).map((candidate) => candidate.playerId),
  ]

  return selected.length === requiredCount ? selected : null
}

function assignBestPositions(
  selectedPlayerIds: string[],
  positions: readonly OutfieldPosition[],
  histories: Record<string, PlayerHistory>,
  phase: RotationPhase,
): Lineup {
  let bestCost = Number.POSITIVE_INFINITY
  let bestAssignment: Lineup = Object.fromEntries(
    positions.map((position, index) => [position, selectedPlayerIds[index] ?? selectedPlayerIds[0]]),
  )

  forEachPermutation(selectedPlayerIds, (permutation) => {
    let cost = 0

    for (let index = 0; index < positions.length; index += 1) {
      const playerId = permutation[index]
      const position = positions[index]
      const snapshot = buildRotationSnapshot(histories[playerId], phase)
      cost += scoreOutfieldPosition(
        snapshot,
        position,
        phase,
      )
    }

    if (cost < bestCost) {
      bestCost = cost
      bestAssignment = Object.fromEntries(
        positions.map((position, index) => [position, permutation[index]]),
      )
    }
  })

  return bestAssignment
}

function assignInPeriodLineup(
  selectedPlayerIds: string[],
  previousLineup: Lineup,
  positions: readonly OutfieldPosition[],
  histories: Record<string, PlayerHistory>,
  playerOrderById: Record<string, number>,
): AssignmentResult {
  const previousAssignments = positions.map((position) => ({
    position,
    playerId: getLineupPlayer(previousLineup, position),
  }))
  const previousPlayerIds = previousAssignments.map((entry) => entry.playerId)
  const selectedSet = new Set(selectedPlayerIds)
  const previousSet = new Set(previousPlayerIds)
  const outgoingAssignments = previousAssignments.filter((entry) => !selectedSet.has(entry.playerId))
  const incomingPlayerIds = selectedPlayerIds.filter((playerId) => !previousSet.has(playerId))

  if (incomingPlayerIds.length === 0 && outgoingAssignments.length === 0) {
    return {
      lineup: Object.fromEntries(previousAssignments.map((entry) => [entry.position, entry.playerId])),
      substitutions: [],
    }
  }

  if (incomingPlayerIds.length !== outgoingAssignments.length) {
    throw new Error('Ogiltigt byte: inkommande och utgående spelare matchar inte.')
  }

  let bestCost = Number.POSITIVE_INFINITY
  let bestIncomingOrder = [...incomingPlayerIds]

  forEachPermutation(incomingPlayerIds, (permutation) => {
    let cost = 0

    for (let index = 0; index < outgoingAssignments.length; index += 1) {
      const incomingPlayerId = permutation[index]
      const outgoingAssignment = outgoingAssignments[index]
      const snapshot = buildRotationSnapshot(histories[incomingPlayerId], 'in-period')
      cost += scoreOutfieldPosition(snapshot, outgoingAssignment.position, 'in-period')
    }

    if (cost < bestCost) {
      bestCost = cost
      bestIncomingOrder = [...permutation]
    }
  })

  const nextLineup: Lineup = Object.fromEntries(
    previousAssignments
      .filter((entry) => selectedSet.has(entry.playerId))
      .map((entry) => [entry.position, entry.playerId]),
  )
  const substitutions = outgoingAssignments.map((outgoingAssignment, index) => {
    const playerInId = bestIncomingOrder[index]
    nextLineup[outgoingAssignment.position] = playerInId

    return {
      playerInId,
      playerOutId: outgoingAssignment.playerId,
      position: outgoingAssignment.position,
    }
  })

  substitutions.sort(
    (left, right) => playerOrderById[left.playerInId] - playerOrderById[right.playerInId],
  )

  return {
    lineup: nextLineup,
    substitutions,
  }
}

function buildRotationSnapshot(history: PlayerHistory, phase: RotationPhase): RotationSnapshot {
  if (phase === 'period-start') {
    return {
      lastOutfieldPosition: history.lastStartPosition,
      lastOutfieldGroup: history.lastStartGroup,
      groupCounts: history.startGroupCounts,
      positionCounts: history.startPositionCounts,
      groupsPlayed: [...history.startGroupsPlayed],
      positionsPlayed: [...history.startPositionsPlayed],
    }
  }

  return {
    lastOutfieldPosition: history.lastOutfieldPosition,
    lastOutfieldGroup: history.lastOutfieldGroup,
    groupCounts: history.groupCounts,
    positionCounts: history.positionCounts,
    groupsPlayed: [...history.groupsPlayed],
    positionsPlayed: [...history.positionsPlayed],
  }
}

function updatePeriodStartHistory(
  playerIds: string[],
  goalkeeperId: string,
  activeSet: Set<string>,
  positions: readonly OutfieldPosition[],
  assignment: Lineup,
  histories: Record<string, PlayerHistory>,
) {
  const starterIds = new Set(positions.map((position) => getLineupPlayer(assignment, position)))

  for (const playerId of playerIds) {
    const history = histories[playerId]

    if (playerId === goalkeeperId) {
      history.startedPreviousPeriod = false
      history.benchedPreviousPeriod = false
      continue
    }

    if (activeSet.has(playerId)) {
      if (history.startedPreviousPeriod) {
        history.repeatedStartPeriods += 1
      }
      history.periodStarts += 1
      history.startedPreviousPeriod = true
      history.benchedPreviousPeriod = false
      continue
    }

    if (history.benchedPreviousPeriod) {
      history.repeatedBenchStartPeriods += 1
    }
    history.periodBenchStarts += 1
    history.startedPreviousPeriod = false
    history.benchedPreviousPeriod = true
  }

  for (const position of positions) {
    const playerId = getLineupPlayer(assignment, position)
    if (!starterIds.has(playerId)) {
      continue
    }

    const history = histories[playerId]
    const group = getRoleGroup(position)

    if (history.lastStartPosition === position) {
      history.sameStartPositionRepeats += 1
    }
    if (history.lastStartGroup === group) {
      history.sameStartGroupRepeats += 1
    }

    history.lastStartPosition = position
    history.lastStartGroup = group
    history.startPositionCounts[position] += 1
    history.startGroupCounts[group] += 1
    history.startPositionsPlayed.add(position)
    history.startGroupsPlayed.add(group)
  }
}

function buildScoreComponents(
  targets: Record<string, number>,
  histories: Record<string, PlayerHistory>,
  periods: PeriodPlan[],
  playerCount: number,
) {
  const benchSlots = Math.max(playerCount - 7, 0)
  const allowedTransitions = 2 + Math.max(benchSlots - 1, 0)
  const allowedShortPlayBlocks = Math.max(benchSlots - 2, 0)
  const allowedConsecutiveBenchWindows = Math.max(playerCount - 10, 0)
  const allowedBenchViolationWeight = allowedConsecutiveBenchWindows * 2
  const allowedBenchStreak = 1 + Math.min(allowedConsecutiveBenchWindows, 1)
  const targetPenalty = Object.entries(targets).reduce(
    (total, [playerId, target]) => total + Math.abs(histories[playerId].actualMinutes - target),
    0,
  )
  const minuteCounts = Object.values(histories).map((history) => history.actualMinutes)
  const benchCounts = Object.values(histories).map((history) => history.benchMinutes)
  const minuteSpreadPenalty = Math.max(...minuteCounts) - Math.min(...minuteCounts)
  const benchSpreadPenalty = Math.max(...benchCounts) - Math.min(...benchCounts)
  const repeatPenalty = Object.values(histories).reduce(
    (total, history) => total + history.samePositionRepeats * 1.5 + history.sameGroupRepeats * 8,
    0,
  )
  const periodStartPenalty = Object.values(histories).reduce((total, history) => {
    return (
      total +
      history.repeatedStartPeriods * 30 +
      history.repeatedBenchStartPeriods * 34 +
      history.sameStartGroupRepeats * 24 +
      history.sameStartPositionRepeats * 4
    )
  }, 0)
  const consecutiveBenchPenalty = Object.values(histories).reduce((total, history) => {
    return (
      total +
      Math.max(history.consecutiveBenchViolations - allowedConsecutiveBenchWindows, 0) * 900 +
      Math.max(history.benchViolationWeight - allowedBenchViolationWeight, 0) * 220 +
      Math.max(history.maxBenchStreak - allowedBenchStreak, 0) * 350
    )
  }, 0)
  const fragmentedMinutesPenalty = Object.values(histories).reduce((total, history) => {
    // Larger squads inherently create more bench/load transitions; only score the excess above that baseline.
    return (
      total +
      Math.max(history.shortPlayBlocks - allowedShortPlayBlocks, 0) * 140 +
      Math.max(history.stateTransitions - allowedTransitions, 0) * 24
    )
  }, 0)
  const groupBreadthPenalty = Object.values(histories).reduce((total, history) => {
    if (history.outfieldMinutes <= 10) {
      return total
    }

    if (history.groupsPlayed.size === 1) {
      return total + 54
    }

    if (history.outfieldMinutes >= 30 && history.groupsPlayed.size === 2) {
      return total + 18
    }

    if (history.outfieldMinutes >= 30 && !history.groupsPlayed.has('ATT')) {
      return total + 12
    }

    return total
  }, 0)
  const periodStartVariationPenalty = scorePeriodStartVariation(periods)

  return {
    playerCount,
    targetPenalty,
    minuteSpreadPenalty,
    benchSpreadPenalty,
    repeatPenalty,
    periodStartPenalty,
    consecutiveBenchPenalty,
    fragmentedMinutesPenalty,
    groupBreadthPenalty,
    periodStartVariationPenalty,
  } satisfies ScoreComponents
}

export function scoreComponentsToTotal(
  components: ScoreComponents,
  profileName: ScoringProfileName = ACTIVE_SCORING_PROFILE.name,
) {
  const profile = getScoringProfile(profileName)
  const playerCount = Math.max(components.playerCount, 1)
  const componentScores = {
    targetPenalty: scoreComponent(
      components.targetPenalty,
      playerCount,
      'targetPenalty',
      profile,
    ),
    minuteSpreadPenalty: scoreComponent(
      components.minuteSpreadPenalty,
      playerCount,
      'minuteSpreadPenalty',
      profile,
    ),
    benchSpreadPenalty: scoreComponent(
      components.benchSpreadPenalty,
      playerCount,
      'benchSpreadPenalty',
      profile,
    ),
    repeatPenalty: scoreComponent(
      components.repeatPenalty,
      playerCount,
      'repeatPenalty',
      profile,
    ),
    periodStartPenalty: scoreComponent(
      components.periodStartPenalty,
      playerCount,
      'periodStartPenalty',
      profile,
    ),
    consecutiveBenchPenalty: scoreComponent(
      components.consecutiveBenchPenalty,
      playerCount,
      'consecutiveBenchPenalty',
      profile,
    ),
    fragmentedMinutesPenalty: scoreComponent(
      components.fragmentedMinutesPenalty,
      playerCount,
      'fragmentedMinutesPenalty',
      profile,
    ),
    groupBreadthPenalty: scoreComponent(
      components.groupBreadthPenalty,
      playerCount,
      'groupBreadthPenalty',
      profile,
    ),
    periodStartVariationPenalty: scoreComponent(
      components.periodStartVariationPenalty,
      playerCount,
      'periodStartVariationPenalty',
      profile,
    ),
  }

  return {
    profile: profile.name,
    components,
    componentScores,
    totalScore: Object.values(componentScores).reduce((total, value) => total + value, 0),
  }
}

export function getPlanScoreBreakdown(
  plan: Pick<MatchPlan, 'periods' | 'summaries' | 'targets'> & Partial<Pick<MatchPlan, 'fairnessTargets'>>,
  profileName: ScoringProfileName = ACTIVE_SCORING_PROFILE.name,
) {
  const histories = createHistoriesFromPlan(plan)
  const comparisonTargets = plan.fairnessTargets ?? plan.targets
  const components = buildScoreComponents(
    comparisonTargets,
    histories,
    plan.periods,
    plan.summaries.length,
  )

  return scoreComponentsToTotal(components, profileName)
}

function getScoringProfile(profileName: ScoringProfileName) {
  return profileName === 'legacy' ? LEGACY_SCORING_PROFILE : NORMALIZED_SCORING_PROFILE
}

function scoreComponent(
  value: number,
  playerCount: number,
  component: keyof Omit<ScoreComponents, 'playerCount'>,
  profile: ScoringProfile,
) {
  const normalizedValue = profile.normalizeComponents.has(component) ? value / playerCount : value

  return normalizedValue * profile.weights[component]
}

function scorePeriodStartVariation(periods: PeriodPlan[]) {
  let penalty = 0

  for (let index = 1; index < periods.length; index += 1) {
    const previousStarters = new Set(Object.values(periods[index - 1].startingLineup))
    const currentStarters = new Set(Object.values(periods[index].startingLineup))
    const previousBench = new Set(periods[index - 1].chunks[0]?.substitutes ?? [])
    const currentBench = new Set(periods[index].chunks[0]?.substitutes ?? [])

    penalty += countIntersection(previousStarters, currentStarters) * 18
    penalty += countIntersection(previousBench, currentBench) * 22
  }

  return penalty
}

function countIntersection<T>(left: Set<T>, right: Set<T>) {
  let count = 0

  for (const value of left) {
    if (right.has(value)) {
      count += 1
    }
  }

  return count
}

function createHistoriesFromPlan(
  plan: Pick<MatchPlan, 'periods' | 'summaries'>,
): Record<string, PlayerHistory> {
  const playerIds = plan.summaries.map((summary) => summary.playerId)
  const histories = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      {
        actualMinutes: 0,
        outfieldMinutes: 0,
        benchMinutes: 0,
        playStreak: 0,
        benchStreak: 0,
        lastChunkState: null,
        stateTransitions: 0,
        shortPlayBlocks: 0,
        consecutiveBenchViolations: 0,
        benchViolationWeight: 0,
        maxBenchStreak: 0,
        goalkeeperPeriods: [],
        lastOutfieldPosition: null,
        lastOutfieldGroup: null,
        groupCounts: { DEF: 0, MID: 0, ATT: 0 },
        positionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 },
        groupsPlayed: new Set<RoleGroup>(),
        positionsPlayed: new Set<OutfieldPosition>(),
        samePositionRepeats: 0,
        sameGroupRepeats: 0,
        periodStarts: 0,
        periodBenchStarts: 0,
        startedPreviousPeriod: false,
        benchedPreviousPeriod: false,
        lastStartPosition: null,
        lastStartGroup: null,
        startGroupCounts: { DEF: 0, MID: 0, ATT: 0 },
        startPositionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 },
        startGroupsPlayed: new Set<RoleGroup>(),
        startPositionsPlayed: new Set<OutfieldPosition>(),
        sameStartPositionRepeats: 0,
        sameStartGroupRepeats: 0,
        repeatedStartPeriods: 0,
        repeatedBenchStartPeriods: 0,
      } satisfies PlayerHistory,
    ]),
  ) as Record<string, PlayerHistory>

  for (const period of plan.periods) {
    const firstChunk = period.chunks[0]
    const starterIds = new Set(
      firstChunk ? period.positions.map((position) => getLineupPlayer(firstChunk.lineup, position)) : [],
    )

    for (const playerId of playerIds) {
      const history = histories[playerId]

      if (playerId === period.goalkeeperId) {
        history.startedPreviousPeriod = false
        history.benchedPreviousPeriod = false
        continue
      }

      if (starterIds.has(playerId)) {
        if (history.startedPreviousPeriod) {
          history.repeatedStartPeriods += 1
        }
        history.periodStarts += 1
        history.startedPreviousPeriod = true
        history.benchedPreviousPeriod = false
        continue
      }

      if (history.benchedPreviousPeriod) {
        history.repeatedBenchStartPeriods += 1
      }
      history.periodBenchStarts += 1
      history.startedPreviousPeriod = false
      history.benchedPreviousPeriod = true
    }

    if (firstChunk) {
      for (const position of period.positions) {
        const playerId = getLineupPlayer(firstChunk.lineup, position)
        const history = histories[playerId]
        const group = getRoleGroup(position)

        if (history.lastStartPosition === position) {
          history.sameStartPositionRepeats += 1
        }
        if (history.lastStartGroup === group) {
          history.sameStartGroupRepeats += 1
        }

        history.lastStartPosition = position
        history.lastStartGroup = group
        history.startPositionCounts[position] += 1
        history.startGroupCounts[group] += 1
        history.startPositionsPlayed.add(position)
        history.startGroupsPlayed.add(group)
      }
    }

    for (const chunk of period.chunks) {
      const activePlayerIds = new Set(chunk.activePlayerIds)

      for (const playerId of playerIds) {
        const history = histories[playerId]
        const isActive = activePlayerIds.has(playerId)
        const nextState = isActive ? 'active' : 'bench'

        if (history.lastChunkState && history.lastChunkState !== nextState) {
          history.stateTransitions += 1
        }

        if (isActive) {
          history.actualMinutes += chunk.durationMinutes
          history.playStreak += 1
          history.benchStreak = 0
        } else {
          if (history.playStreak === 1) {
            history.shortPlayBlocks += 1
          }
          const nextBenchStreak = history.benchStreak + 1
          if (history.benchStreak > 0) {
            history.consecutiveBenchViolations += 1
            history.benchViolationWeight += nextBenchStreak
          }
          history.benchMinutes += chunk.durationMinutes
          history.playStreak = 0
          history.benchStreak = nextBenchStreak
          history.maxBenchStreak = Math.max(history.maxBenchStreak, nextBenchStreak)
        }

        history.lastChunkState = nextState
      }

      for (const position of period.positions) {
        const playerId = getLineupPlayer(chunk.lineup, position)
        const history = histories[playerId]
        const group = getRoleGroup(position)

        if (history.lastOutfieldPosition === position) {
          history.samePositionRepeats += 1
        }
        if (history.lastOutfieldGroup === group) {
          history.sameGroupRepeats += 1
        }

        history.outfieldMinutes += chunk.durationMinutes
        history.lastOutfieldPosition = position
        history.lastOutfieldGroup = group
        history.positionCounts[position] += chunk.durationMinutes
        history.groupCounts[group] += chunk.durationMinutes
        history.positionsPlayed.add(position)
        history.groupsPlayed.add(group)
      }
    }
  }

  for (const history of Object.values(histories)) {
    if (history.playStreak === 1) {
      history.shortPlayBlocks += 1
    }
  }

  return histories
}

function distributeTargetMinutes(
  playerIds: string[],
  totalMinutes: number,
  rng: () => number,
): Record<string, number> {
  const baseMinutes = Math.floor(totalMinutes / playerIds.length)
  const remainder = totalMinutes % playerIds.length
  const bonusOrder = shuffle([...playerIds], rng)
  const targets = Object.fromEntries(playerIds.map((playerId) => [playerId, baseMinutes])) as Record<
    string,
    number
  >

  for (let index = 0; index < remainder; index += 1) {
    targets[bonusOrder[index]] += 1
  }

  return targets
}

function getLineupPlayer(lineup: Lineup, position: OutfieldPosition) {
  const playerId = lineup[position]
  if (!playerId) {
    throw new Error(`Saknar spelare för position ${position}.`)
  }
  return playerId
}

function createRng(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rng: () => number) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1))
    ;[items[index], items[swapIndex]] = [items[swapIndex], items[index]]
  }

  return items
}

function forEachPermutation<T>(items: T[], callback: (permutation: T[]) => void) {
  const values = [...items]

  const visit = (startIndex: number) => {
    if (startIndex === values.length - 1) {
      callback([...values])
      return
    }

    for (let index = startIndex; index < values.length; index += 1) {
      ;[values[startIndex], values[index]] = [values[index], values[startIndex]]
      visit(startIndex + 1)
      ;[values[startIndex], values[index]] = [values[index], values[startIndex]]
    }
  }

  visit(0)
}
