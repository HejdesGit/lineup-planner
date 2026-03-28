import {
  ALL_POSITIONS,
  FORMATION_PRESETS,
  PERIOD_COUNT,
  PERIOD_COUNT_OPTIONS,
  PERIOD_MINUTE_OPTIONS,
  ROLE_GROUPS,
  type CarryOverPlayerStats,
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
type SchedulingMode = 'single-period' | 'short-multi-period' | 'extended-multi-period' | 'default'

interface SchedulingPolicy {
  mode: SchedulingMode
}

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

interface EvaluatedCandidatePlan {
  score: number
}

interface SchedulerContext {
  positions: readonly OutfieldPosition[]
  normalizedLockedGoalkeepers: Array<string | null>
  matchChunks: MatchChunk[]
  chunksByPeriod: MatchChunk[][]
  policy: SchedulingPolicy
  totalPlayerMinutes: number
  playerIds: string[]
  playerOrderById: Record<string, number>
  nameById: Record<string, string>
  carryOverByPlayerId: Record<string, CarryOverPlayerState>
  totalCarryOverMinutes: number
}

interface CarryOverPlayerState {
  actualMinutes: number
  outfieldMinutes: number
  benchMinutes: number
  goalkeeperMinutes: number
  groupCounts: Record<RoleGroup, number>
  positionCounts: Record<OutfieldPosition, number>
  groupsPlayed: Set<RoleGroup>
  positionsPlayed: Set<OutfieldPosition>
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
const ROUNDING_EPSILON = 0.0001
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
  periodCount = PERIOD_COUNT,
  periodMinutes,
  formation,
  chunkMinutes,
  lockedGoalkeeperIds,
  priorPlayerStats,
  seed = Date.now(),
  attempts,
}: MatchConfig): MatchPlan {
  validateConfig(players, periodCount, periodMinutes, formation, chunkMinutes, lockedGoalkeeperIds)
  const resolvedAttempts = resolveAttemptCount({ players, periodCount, periodMinutes, chunkMinutes, attempts })
  const context = buildSchedulerContext(
    players,
    periodCount,
    periodMinutes,
    formation,
    chunkMinutes,
    lockedGoalkeeperIds,
    priorPlayerStats,
  )

  let best: EvaluatedCandidatePlan | null = null
  let bestSeed = seed

  for (let index = 0; index < resolvedAttempts; index += 1) {
    const candidateSeed = (seed + index * 7919) >>> 0
    const candidate = evaluateCandidatePlan(
      context,
      players,
      periodCount,
      periodMinutes,
      formation,
      chunkMinutes,
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

  const winningCandidate = buildCandidatePlan(
    context,
    players,
    periodCount,
    periodMinutes,
    formation,
    chunkMinutes,
    bestSeed,
  )

  if (!winningCandidate) {
    throw new Error('Kunde inte återskapa vinnande matchschema.')
  }

  return {
    seed: bestSeed,
    score: winningCandidate.score,
    periodCount,
    formation,
    chunkMinutes,
    periodMinutes,
    positions: context.positions,
    goalkeepers: winningCandidate.goalkeepers,
    lockedGoalkeepers: context.normalizedLockedGoalkeepers,
    targets: winningCandidate.targets,
    fairnessTargets: winningCandidate.fairnessTargets,
    periods: winningCandidate.periods,
    summaries: winningCandidate.summaries,
  }
}

function buildSchedulerContext(
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  lockedGoalkeeperIds: Array<string | null> | undefined,
  priorPlayerStats: CarryOverPlayerStats[] | undefined,
): SchedulerContext {
  const positions = FORMATION_PRESETS[formation].positions
  const normalizedLockedGoalkeepers = normalizeLockedGoalkeepers(lockedGoalkeeperIds, periodCount)
  const matchChunks = buildMatchChunks(periodCount, periodMinutes, chunkMinutes)
  const chunksByPeriod = Array.from({ length: periodCount }, () => [] as MatchChunk[])

  for (const chunk of matchChunks) {
    chunksByPeriod[chunk.periodIndex]?.push(chunk)
  }

  const playerIds = players.map((player) => player.id)
  const carryOverByPlayerId = buildCarryOverLookup(players, priorPlayerStats)

  return {
    positions,
    normalizedLockedGoalkeepers,
    matchChunks,
    chunksByPeriod,
    policy: resolveSchedulingPolicy({
      periodCount,
      chunkCount: matchChunks.length,
      benchSlots: Math.max(players.length - 7, 0),
    }),
    totalPlayerMinutes: periodCount * periodMinutes * 7,
    playerIds,
    playerOrderById: Object.fromEntries(playerIds.map((id, index) => [id, index])) as Record<
      string,
      number
    >,
    nameById: Object.fromEntries(players.map((player) => [player.id, player.name])),
    carryOverByPlayerId,
    totalCarryOverMinutes: Object.values(carryOverByPlayerId).reduce(
      (total, carryOver) => total + carryOver.actualMinutes,
      0,
    ),
  }
}

function buildCarryOverLookup(
  players: Player[],
  priorPlayerStats: CarryOverPlayerStats[] | undefined,
): Record<string, CarryOverPlayerState> {
  const carryOverByName = new Map(
    (priorPlayerStats ?? []).map((entry) => [normalizePlayerName(entry.name), entry]),
  )

  return Object.fromEntries(
    players.map((player) => {
      const carryOver = carryOverByName.get(normalizePlayerName(player.name))

      return [
        player.id,
        {
          actualMinutes: carryOver?.totalMinutes ?? 0,
          outfieldMinutes: carryOver?.outfieldMinutes ?? 0,
          benchMinutes: carryOver?.benchMinutes ?? 0,
          goalkeeperMinutes: carryOver?.goalkeeperMinutes ?? 0,
          groupCounts: {
            ...createRoleGroupCountMap(),
            ...(carryOver?.groupMinutes ?? {}),
          },
          positionCounts: {
            ...createPositionCountMap(),
            ...(carryOver?.positionMinutes ?? {}),
          },
          groupsPlayed: new Set<RoleGroup>(carryOver?.roleGroups ?? []),
          positionsPlayed: new Set<OutfieldPosition>(carryOver?.positionsPlayed ?? []),
        } satisfies CarryOverPlayerState,
      ]
    }),
  ) as Record<string, CarryOverPlayerState>
}

function buildCumulativeFairnessTargets(
  playerIds: string[],
  cumulativeTargets: Record<string, number>,
  currentTargets: Record<string, number>,
  currentFairnessTargets: Record<string, number>,
) {
  return Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      cumulativeTargets[playerId] + (currentFairnessTargets[playerId] - currentTargets[playerId]),
    ]),
  ) as Record<string, number>
}

function buildCumulativeTargets(
  playerIds: string[],
  currentTargets: Record<string, number>,
  totalCarryOverMinutes: number,
  playerOrderById: Record<string, number>,
) {
  const normalizedCarryOverMinutes = Math.max(Math.round(totalCarryOverMinutes), 0)
  const carryOverBaseMinutes = Math.floor(normalizedCarryOverMinutes / playerIds.length)
  const carryOverRemainder = normalizedCarryOverMinutes % playerIds.length
  const orderedPlayerIds = playerIds.slice().sort((left, right) => playerOrderById[left] - playerOrderById[right])

  return Object.fromEntries(
    orderedPlayerIds.map((playerId, index) => [
      playerId,
      currentTargets[playerId] + carryOverBaseMinutes + (index < carryOverRemainder ? 1 : 0),
    ]),
  ) as Record<string, number>
}

function normalizePlayerName(name: string) {
  return name.trim().toLocaleLowerCase('sv-SE')
}

function validateConfig(
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  lockedGoalkeeperIds?: Array<string | null>,
) {
  if (players.length < 8 || players.length > 12) {
    throw new Error('Antalet spelare måste vara mellan 8 och 12.')
  }

  if (
    !Number.isInteger(periodCount) ||
    !PERIOD_COUNT_OPTIONS.includes(periodCount as (typeof PERIOD_COUNT_OPTIONS)[number])
  ) {
    throw new Error('Antal perioder måste vara mellan 1 och 4.')
  }

  if (
    !Number.isInteger(periodMinutes) ||
    !PERIOD_MINUTE_OPTIONS.includes(periodMinutes as (typeof PERIOD_MINUTE_OPTIONS)[number])
  ) {
    throw new Error('Matchtiden måste vara 5, 10, 15 eller 20 minuter per period.')
  }

  if (!(formation in FORMATION_PRESETS)) {
    throw new Error('Formationen stöds inte.')
  }

  if (!isValidChunkMinutes(chunkMinutes) || chunkMinutes > periodMinutes) {
    throw new Error('Bytesfönstret måste vara större än 0 och högst lika långt som perioden.')
  }

  if (lockedGoalkeeperIds && lockedGoalkeeperIds.length !== periodCount) {
    throw new Error(`Målvaktsval måste anges för exakt ${periodCount} perioder.`)
  }

  if (lockedGoalkeeperIds) {
    const selectedGoalkeepers = lockedGoalkeeperIds.filter(
      (goalkeeperId): goalkeeperId is string => Boolean(goalkeeperId),
    )
    for (const goalkeeperId of selectedGoalkeepers) {
      if (!players.some((player) => player.id === goalkeeperId)) {
        throw new Error('En vald målvakt finns inte i spelarlistan.')
      }
    }
  }
}

function evaluateCandidatePlan(
  context: SchedulerContext,
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  seed: number,
): EvaluatedCandidatePlan | null {
  return runCandidatePlan(
    context,
    players,
    periodCount,
    periodMinutes,
    formation,
    chunkMinutes,
    seed,
    false,
  )
}

function buildCandidatePlan(
  context: SchedulerContext,
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  seed: number,
): CandidatePlan | null {
  return runCandidatePlan(
    context,
    players,
    periodCount,
    periodMinutes,
    formation,
    chunkMinutes,
    seed,
    true,
  )
}

function runCandidatePlan(
  context: SchedulerContext,
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  seed: number,
  includeOutput: true,
): CandidatePlan | null
function runCandidatePlan(
  context: SchedulerContext,
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  seed: number,
  includeOutput: false,
): EvaluatedCandidatePlan | null
function runCandidatePlan(
  context: SchedulerContext,
  players: Player[],
  periodCount: number,
  periodMinutes: number,
  formation: FormationKey,
  chunkMinutes: number,
  seed: number,
  includeOutput: boolean,
): CandidatePlan | EvaluatedCandidatePlan | null {
  const rng = createRng(seed)
  const targets = distributeTargetMinutes(context.playerIds, context.totalPlayerMinutes, rng)
  const goalkeepers = resolveGoalkeepers(
    context.playerIds,
    context.normalizedLockedGoalkeepers,
    periodCount,
    rng,
  )
  const fairnessTargets = buildGoalkeeperFairnessTargets({
    playerIds: context.playerIds,
    goalkeepers,
    periodCount,
    periodMinutes,
    chunkMinutes,
    outfieldSlotCount: context.positions.length,
    playerOrderById: context.playerOrderById,
    fallbackTargets: targets,
  })
  const cumulativeTargets = buildCumulativeTargets(
    context.playerIds,
    targets,
    context.totalCarryOverMinutes,
    context.playerOrderById,
  )
  const cumulativeFairnessTargets = buildCumulativeFairnessTargets(
    context.playerIds,
    cumulativeTargets,
    targets,
    fairnessTargets,
  )
  const goalkeeperMinuteCounts = buildGoalkeeperMinuteCounts(context.playerIds, goalkeepers, periodMinutes)
  const cumulativeGoalkeeperMinuteCounts = Object.fromEntries(
    context.playerIds.map((id) => [
      id,
      context.carryOverByPlayerId[id].goalkeeperMinutes + goalkeeperMinuteCounts[id],
    ]),
  ) as Record<string, number>

  const outfieldTargets = Object.fromEntries(
    context.playerIds.map((id) => [
      id,
      Math.max(0, cumulativeFairnessTargets[id] - cumulativeGoalkeeperMinuteCounts[id]),
    ]),
  ) as Record<string, number>
  const remainingEligibleByPlayer = buildRemainingEligibleLookup(
    context.playerIds,
    context.matchChunks,
    goalkeepers,
  )
  const histories = createHistories(players, goalkeepers, context.carryOverByPlayerId)
  const summaryHistories = includeOutput ? createMatchOnlyHistories(players, goalkeepers) : null
  const periods: PeriodPlan[] = []
  let previousStarterIds: Set<string> | null = null
  let previousBenchIds: Set<string> | null = null
  let periodStartVariationPenalty = 0

  for (let periodIndex = 0; periodIndex < periodCount; periodIndex += 1) {
    const goalkeeperId = goalkeepers[periodIndex]
    const chunks: PeriodPlan['chunks'] | null = includeOutput ? [] : null
    const substituteSet = new Set<string>()
    const periodChunks = context.chunksByPeriod[periodIndex] ?? []
    let previousLineup: Lineup | null = null

    for (const chunk of periodChunks) {
      const phase: RotationPhase = chunk.windowIndex === 0 ? 'period-start' : 'in-period'
      const outfieldPlayers = selectOutfieldPlayers({
        chunk,
        playerIds: context.playerIds,
        goalkeeperId,
        histories,
        outfieldTargets,
        remainingEligibleByPlayer,
        positions: context.positions,
        phase,
        policy: context.policy,
        rng,
      })

      if (!outfieldPlayers) {
        return null
      }

      const assignmentResult: AssignmentResult =
        phase === 'period-start' || !previousLineup
          ? {
              lineup: assignBestPositions(outfieldPlayers, context.positions, histories, phase),
              substitutions: [],
            }
          : assignInPeriodLineup(
              outfieldPlayers,
              previousLineup,
              context.positions,
              histories,
              context.playerOrderById,
            )
      const assignment = assignmentResult.lineup
      const activePlayerIds = [
        goalkeeperId,
        ...context.positions.map((position) => getLineupPlayer(assignment, position)),
      ]
      const activeSet = new Set(activePlayerIds)

      for (const playerId of context.playerIds) {
        const isActive = activeSet.has(playerId)

        for (const historyMap of [histories, summaryHistories].filter(
          (value): value is Record<string, PlayerHistory> => value !== null,
        )) {
          const history = historyMap[playerId]
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

        if (!isActive) {
          substituteSet.add(playerId)
        }
      }

      if (phase === 'period-start') {
        updatePeriodStartHistory(
          context.playerIds,
          goalkeeperId,
          activeSet,
          context.positions,
          assignment,
          histories,
        )
        if (summaryHistories) {
          updatePeriodStartHistory(
            context.playerIds,
            goalkeeperId,
            activeSet,
            context.positions,
            assignment,
            summaryHistories,
          )
        }
        const starterIds = new Set(
          context.positions.map((position) => getLineupPlayer(assignment, position)),
        )
        const benchIds = new Set(context.playerIds.filter((playerId) => !activeSet.has(playerId)))

        if (previousStarterIds && previousBenchIds) {
          periodStartVariationPenalty += countIntersection(previousStarterIds, starterIds) * 18
          periodStartVariationPenalty += countIntersection(previousBenchIds, benchIds) * 22
        }

        previousStarterIds = starterIds
        previousBenchIds = benchIds
      }

      for (const position of context.positions) {
        const playerId = getLineupPlayer(assignment, position)
        const group = getRoleGroup(position)

        for (const historyMap of [histories, summaryHistories].filter(
          (value): value is Record<string, PlayerHistory> => value !== null,
        )) {
          const history = historyMap[playerId]

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

      if (chunks) {
        chunks.push({
          chunkIndex: chunk.chunkIndex,
          period: periodIndex + 1,
          windowIndex: chunk.windowIndex,
          startMinute: chunk.startMinute,
          endMinute: chunk.endMinute,
          durationMinutes: chunk.durationMinutes,
          goalkeeperId,
          goalkeeperName: context.nameById[goalkeeperId],
          lineup: assignment,
          activePlayerIds,
          substitutes: context.playerIds
            .filter((playerId) => !activeSet.has(playerId))
            .map((playerId) => context.nameById[playerId]),
          substitutions: assignmentResult.substitutions,
        })
      }

      previousLineup = assignment
    }

    if (chunks) {
      periods.push({
        period: periodIndex + 1,
        formation,
        positions: context.positions,
        goalkeeperId,
        goalkeeperName: context.nameById[goalkeeperId],
        startingLineup: chunks[0].lineup,
        chunks,
        substitutes: Array.from(substituteSet).map((playerId) => context.nameById[playerId]),
      })
    }
  }

  for (const historyMap of [histories, summaryHistories].filter(
    (value): value is Record<string, PlayerHistory> => value !== null,
  )) {
    for (const history of Object.values(historyMap)) {
      if (history.playStreak === 1) {
        history.shortPlayBlocks += 1
      }
    }
  }

  const scoreComponents = buildScoreComponentsFromState(
    cumulativeFairnessTargets,
    histories,
    players.length,
    periodStartVariationPenalty,
  )
  const score = scoreComponentsToTotal(scoreComponents, ACTIVE_SCORING_PROFILE.name).totalScore

  if (!includeOutput) {
    return { score }
  }

  const summaries = buildPlayerSummariesFromHistories(players, summaryHistories ?? histories)

  return {
    score,
    periods,
    summaries,
    targets,
    fairnessTargets,
    goalkeepers,
  }
}

function normalizeLockedGoalkeepers(lockedGoalkeeperIds: Array<string | null> | undefined, periodCount: number) {
  return Array.from({ length: periodCount }, (_, index) => lockedGoalkeeperIds?.[index] ?? null)
}

function resolveGoalkeepers(
  playerIds: string[],
  lockedGoalkeeperIds: Array<string | null>,
  periodCount: number,
  rng: () => number,
) {
  const chosen = [...lockedGoalkeeperIds]
  const usedIds = new Set(chosen.filter((goalkeeperId): goalkeeperId is string => Boolean(goalkeeperId)))
  const remainingIds = shuffle(
    playerIds.filter((playerId) => !usedIds.has(playerId)),
    rng,
  )

  for (let periodIndex = 0; periodIndex < periodCount; periodIndex += 1) {
    if (chosen[periodIndex]) {
      continue
    }

    const nextGoalkeeper = remainingIds.shift()
    if (!nextGoalkeeper) {
      throw new Error('Det finns inte tillräckligt många spelare för att välja olika målvakter.')
    }
    chosen[periodIndex] = nextGoalkeeper
  }

  return chosen as string[]
}

function buildGoalkeeperMinuteCounts(
  playerIds: string[],
  goalkeepers: string[],
  periodMinutes: number,
) {
  const goalkeeperMinuteCounts = Object.fromEntries(playerIds.map((id) => [id, 0])) as Record<
    string,
    number
  >

  for (const goalkeeperId of goalkeepers) {
    goalkeeperMinuteCounts[goalkeeperId] += periodMinutes
  }

  return goalkeeperMinuteCounts
}

export function buildGoalkeeperFairnessTargets({
  playerIds,
  goalkeepers,
  periodCount,
  periodMinutes,
  chunkMinutes,
  outfieldSlotCount,
  playerOrderById,
  fallbackTargets,
}: {
  playerIds: string[]
  goalkeepers: string[]
  periodCount: number
  periodMinutes: number
  chunkMinutes: number
  outfieldSlotCount: number
  playerOrderById: Record<string, number>
  fallbackTargets: Record<string, number>
}) {
  const matchChunks = buildMatchChunks(periodCount, periodMinutes, chunkMinutes)
  const goalkeeperMinuteCounts = buildGoalkeeperMinuteCounts(playerIds, goalkeepers, periodMinutes)

  return buildFairnessTargets({
    playerIds,
    fallbackTargets,
    matchChunks,
    goalkeepers,
    goalkeeperMinuteCounts,
    periodCount,
    periodMinutes,
    outfieldSlotCount,
    playerOrderById,
  })
}

function buildFairnessTargets({
  playerIds,
  fallbackTargets,
  matchChunks,
  goalkeepers,
  goalkeeperMinuteCounts,
  periodCount,
  periodMinutes,
  outfieldSlotCount,
  playerOrderById,
}: {
  playerIds: string[]
  fallbackTargets: Record<string, number>
  matchChunks: MatchChunk[]
  goalkeepers: string[]
  goalkeeperMinuteCounts: Record<string, number>
  periodCount: number
  periodMinutes: number
  outfieldSlotCount: number
  playerOrderById: Record<string, number>
}) {
  if (playerIds.length > 10) {
    return fallbackTargets
  }

  const chunkDurations = matchChunks.map((chunk) => chunk.durationMinutes)
  const minChunkDuration = Math.min(...chunkDurations)
  const maxChunkDuration = Math.max(...chunkDurations)

  if (
    !Number.isFinite(minChunkDuration) ||
    !Number.isFinite(maxChunkDuration) ||
    maxChunkDuration - minChunkDuration > 0.01
  ) {
    return fallbackTargets
  }

  const chunkCountPerPeriod = Math.max(matchChunks.length / Math.max(periodCount, 1), 1)
  const outfieldChunkMinutes = periodMinutes / chunkCountPerPeriod
  const neutralTotalTarget = (periodCount * periodMinutes * (outfieldSlotCount + 1)) / playerIds.length
  const goalkeeperPeriodsByPlayer = Object.fromEntries(
    playerIds.map((playerId) => [playerId, goalkeepers.filter((goalkeeperId) => goalkeeperId === playerId).length]),
  ) as Record<string, number>
  const eligibleOutfieldChunks = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      Math.max(matchChunks.length - goalkeeperPeriodsByPlayer[playerId] * chunkCountPerPeriod, 0),
    ]),
  ) as Record<string, number>
  const desiredOutfieldChunks = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      Math.max(0, (neutralTotalTarget - goalkeeperMinuteCounts[playerId]) / outfieldChunkMinutes),
    ]),
  ) as Record<string, number>
  const allocatedOutfieldChunks = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      Math.min(Math.floor(desiredOutfieldChunks[playerId] + ROUNDING_EPSILON), eligibleOutfieldChunks[playerId]),
    ]),
  ) as Record<string, number>
  const isGoalkeeperBiasEligible = (playerId: string) =>
    goalkeeperPeriodsByPlayer[playerId] > 0 &&
    goalkeeperMinuteCounts[playerId] + outfieldChunkMinutes <= neutralTotalTarget + ROUNDING_EPSILON

  let remainingChunkSlots =
    matchChunks.length * outfieldSlotCount -
    Object.values(allocatedOutfieldChunks).reduce((total, chunkCount) => total + chunkCount, 0)

  while (remainingChunkSlots > 0) {
    const nextPlayerId = playerIds
      .filter((playerId) => allocatedOutfieldChunks[playerId] < eligibleOutfieldChunks[playerId])
      .sort((left, right) => {
        const leftNeed = desiredOutfieldChunks[left] - allocatedOutfieldChunks[left]
        const rightNeed = desiredOutfieldChunks[right] - allocatedOutfieldChunks[right]

        if (Math.abs(rightNeed - leftNeed) > ROUNDING_EPSILON) {
          return rightNeed - leftNeed
        }

        const leftGoalkeeperPriority = isGoalkeeperBiasEligible(left) ? 1 : 0
        const rightGoalkeeperPriority = isGoalkeeperBiasEligible(right) ? 1 : 0
        if (rightGoalkeeperPriority !== leftGoalkeeperPriority) {
          return rightGoalkeeperPriority - leftGoalkeeperPriority
        }

        const leftGoalkeeperMinutes = goalkeeperMinuteCounts[left]
        const rightGoalkeeperMinutes = goalkeeperMinuteCounts[right]
        if (Math.abs(leftGoalkeeperMinutes - rightGoalkeeperMinutes) > ROUNDING_EPSILON) {
          return leftGoalkeeperMinutes - rightGoalkeeperMinutes
        }

        return playerOrderById[left] - playerOrderById[right]
      })[0]

    if (!nextPlayerId) {
      break
    }

    allocatedOutfieldChunks[nextPlayerId] += 1
    remainingChunkSlots -= 1
  }

  const fairnessTargets = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      goalkeeperMinuteCounts[playerId] + allocatedOutfieldChunks[playerId] * outfieldChunkMinutes,
    ]),
  ) as Record<string, number>
  const normalizationDelta =
    periodCount * periodMinutes * (outfieldSlotCount + 1) -
    Object.values(fairnessTargets).reduce((total, minutes) => total + minutes, 0)
  const normalizationPlayerId = playerIds
    .slice()
    .sort((left, right) => {
      const leftGoalkeeperMinutes = goalkeeperMinuteCounts[left]
      const rightGoalkeeperMinutes = goalkeeperMinuteCounts[right]

      if (normalizationDelta > 0 && Math.abs(leftGoalkeeperMinutes - rightGoalkeeperMinutes) > ROUNDING_EPSILON) {
        return leftGoalkeeperMinutes - rightGoalkeeperMinutes
      }

      if (normalizationDelta < 0 && Math.abs(leftGoalkeeperMinutes - rightGoalkeeperMinutes) > ROUNDING_EPSILON) {
        return rightGoalkeeperMinutes - leftGoalkeeperMinutes
      }

      if (normalizationDelta > 0 && Math.abs(fairnessTargets[left] - fairnessTargets[right]) > ROUNDING_EPSILON) {
        return fairnessTargets[left] - fairnessTargets[right]
      }

      if (normalizationDelta < 0 && Math.abs(fairnessTargets[left] - fairnessTargets[right]) > ROUNDING_EPSILON) {
        return fairnessTargets[right] - fairnessTargets[left]
      }

      return playerOrderById[left] - playerOrderById[right]
    })[0]

  if (normalizationPlayerId && Math.abs(normalizationDelta) > Number.EPSILON) {
    fairnessTargets[normalizationPlayerId] += normalizationDelta
  }

  return fairnessTargets
}

export function resolveAttemptCount({
  players,
  periodCount = PERIOD_COUNT,
  periodMinutes,
  chunkMinutes,
  attempts,
}: {
  players: Player[]
  periodCount?: number
  periodMinutes: number
  chunkMinutes: number
  attempts?: number
}) {
  if (typeof attempts === 'number') {
    return attempts
  }

  return Math.max(DEFAULT_ATTEMPTS, players.length * getTotalChunkCount(periodCount, periodMinutes, chunkMinutes) * 2)
}

function getTotalChunkCount(periodCount: number, periodMinutes: number, chunkMinutes: number) {
  return periodCount * Math.ceil(periodMinutes / chunkMinutes)
}

function buildMatchChunks(periodCount: number, periodMinutes: number, chunkMinutes: number): MatchChunk[] {
  const chunks: MatchChunk[] = []
  let chunkIndex = 0

  for (let periodIndex = 0; periodIndex < periodCount; periodIndex += 1) {
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
  return Number.isFinite(chunkMinutes) && chunkMinutes > 0
}

function roundMinuteValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function createRoleGroupCountMap() {
  return { DEF: 0, MID: 0, ATT: 0 } satisfies Record<RoleGroup, number>
}

function createPositionCountMap() {
  return { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 } satisfies Record<OutfieldPosition, number>
}

function createEmptyHistory(goalkeeperPeriods: number[] = []): PlayerHistory {
  return {
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
    goalkeeperPeriods,
    lastOutfieldPosition: null,
    lastOutfieldGroup: null,
    groupCounts: createRoleGroupCountMap(),
    positionCounts: createPositionCountMap(),
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
    startGroupCounts: createRoleGroupCountMap(),
    startPositionCounts: createPositionCountMap(),
    startGroupsPlayed: new Set<RoleGroup>(),
    startPositionsPlayed: new Set<OutfieldPosition>(),
    sameStartPositionRepeats: 0,
    sameStartGroupRepeats: 0,
    repeatedStartPeriods: 0,
    repeatedBenchStartPeriods: 0,
  }
}

function createHistoryFromCarryOver(
  carryOver: CarryOverPlayerState | undefined,
  goalkeeperPeriods: number[],
): PlayerHistory {
  const history = createEmptyHistory(goalkeeperPeriods)

  if (!carryOver) {
    return history
  }

  history.actualMinutes = carryOver.actualMinutes
  history.outfieldMinutes = carryOver.outfieldMinutes
  history.benchMinutes = carryOver.benchMinutes
  history.groupCounts = { ...carryOver.groupCounts }
  history.positionCounts = { ...carryOver.positionCounts }
  history.groupsPlayed = new Set(carryOver.groupsPlayed)
  history.positionsPlayed = new Set(carryOver.positionsPlayed)

  return history
}

function createHistories(
  players: Player[],
  goalkeepers: string[],
  carryOverByPlayerId: Record<string, CarryOverPlayerState>,
): Record<string, PlayerHistory> {
  return Object.fromEntries(
    players.map((player) => [
      player.id,
      createHistoryFromCarryOver(
        carryOverByPlayerId[player.id],
        goalkeepers
          .map((goalkeeperId, index) => (goalkeeperId === player.id ? index + 1 : null))
          .filter((value): value is number => value !== null),
      ),
    ]),
  )
}

function createMatchOnlyHistories(
  players: Player[],
  goalkeepers: string[],
): Record<string, PlayerHistory> {
  return Object.fromEntries(
    players.map((player) => [
      player.id,
      createEmptyHistory(
        goalkeepers
          .map((goalkeeperId, index) => (goalkeeperId === player.id ? index + 1 : null))
          .filter((value): value is number => value !== null),
      ),
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
  policy,
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
  policy: SchedulingPolicy
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
      policy,
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
    policy,
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
  policy,
  rng,
}: {
  chunk: MatchChunk
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, PlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  policy: SchedulingPolicy
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

  return selectPlayersWithBenchProtection(
    candidates,
    histories,
    positions.length,
    playerIds.length,
    policy,
  )
}

function selectInPeriodPlayers({
  chunk,
  playerIds,
  goalkeeperId,
  histories,
  outfieldTargets,
  remainingEligibleByPlayer,
  positions,
  policy,
  rng,
}: {
  chunk: MatchChunk
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, PlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  policy: SchedulingPolicy
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
      policy.mode === 'short-multi-period' && chunk.durationMinutes <= 5 && history.playStreak === 1
        ? 110
        : 0
    const largeRosterBenchRecoveryBoost =
      policy.mode === 'extended-multi-period' &&
      playerIds.length >= 11 &&
      history.benchStreak > 0 &&
      history.consecutiveBenchViolations > 0
        ? chunk.durationMinutes <= 5
          ? 140
          : 175
        : 0
    const tripleBenchProtection =
      policy.mode === 'short-multi-period' &&
      playerIds.length >= 11 &&
      chunk.durationMinutes <= 5 &&
      history.benchStreak >= 2
        ? 420
        : 0
    const score =
      criticalGap * 100 +
      Math.max(remainingNeed, 0) * 12 +
      shortagePressure * 30 +
      history.benchStreak * 120 -
      history.actualMinutes * 0.55 +
      shortWindowSinglePlayProtection +
      largeRosterBenchRecoveryBoost +
      tripleBenchProtection +
      Math.min(history.playStreak, 2) * 20 +
      rng() * 0.01

    candidates.push({ playerId, score })
  }

  return selectPlayersWithBenchProtection(
    candidates,
    histories,
    positions.length,
    playerIds.length,
    policy,
  )
}

function selectPlayersWithBenchProtection(
  candidates: Array<{ playerId: string; score: number }>,
  histories: Record<string, PlayerHistory>,
  requiredCount: number,
  playerCount: number,
  policy: SchedulingPolicy,
) {
  candidates.sort((left, right) => right.score - left.score)

  if (playerCount >= 11) {
    if (policy.mode === 'short-multi-period') {
      const mandatory = candidates.filter((candidate) => histories[candidate.playerId].benchStreak >= 2)
      const optional = candidates.filter((candidate) => histories[candidate.playerId].benchStreak < 2)

      if (mandatory.length > 0) {
        return [
          ...mandatory.slice(0, requiredCount).map((candidate) => candidate.playerId),
          ...optional
            .slice(0, Math.max(requiredCount - mandatory.length, 0))
            .map((candidate) => candidate.playerId),
        ]
      }
    }

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
  const costMatrixByPlayerId = Object.fromEntries(
    selectedPlayerIds.map((playerId) => {
      const snapshot = buildRotationSnapshot(histories[playerId], phase)
      return [
        playerId,
        positions.map((position) => scoreOutfieldPosition(snapshot, position, phase)),
      ]
    }),
  ) as Record<string, number[]>
  let bestCost = Number.POSITIVE_INFINITY
  let bestAssignment: Lineup = Object.fromEntries(
    positions.map((position, index) => [position, selectedPlayerIds[index] ?? selectedPlayerIds[0]]),
  )

  forEachPermutation(selectedPlayerIds, (permutation) => {
    let cost = 0

    for (let index = 0; index < positions.length; index += 1) {
      const playerId = permutation[index]
      cost += costMatrixByPlayerId[playerId]?.[index] ?? 0
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
  const incomingCostMatrixByPlayerId = Object.fromEntries(
    incomingPlayerIds.map((playerId) => {
      const snapshot = buildRotationSnapshot(histories[playerId], 'in-period')
      return [
        playerId,
        outgoingAssignments.map((assignment) =>
          scoreOutfieldPosition(snapshot, assignment.position, 'in-period'),
        ),
      ]
    }),
  ) as Record<string, number[]>

  forEachPermutation(incomingPlayerIds, (permutation) => {
    let cost = 0

    for (let index = 0; index < outgoingAssignments.length; index += 1) {
      const incomingPlayerId = permutation[index]
      cost += incomingCostMatrixByPlayerId[incomingPlayerId]?.[index] ?? 0
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

function resolveSchedulingPolicy({
  periodCount,
  chunkCount,
  benchSlots,
}: {
  periodCount: number
  chunkCount: number
  benchSlots: number
}): SchedulingPolicy {
  if (periodCount === 1) {
    return { mode: 'single-period' }
  }

  if (
    (periodCount === 2 && chunkCount <= 8 && benchSlots >= 3) ||
    (periodCount === 3 && chunkCount >= 12 && benchSlots <= 3)
  ) {
    return { mode: 'short-multi-period' }
  }

  if (periodCount >= 4 && benchSlots >= 3) {
    return { mode: 'extended-multi-period' }
  }

  return { mode: 'default' }
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
  return buildScoreComponentsFromState(
    targets,
    histories,
    playerCount,
    scorePeriodStartVariation(periods),
  )
}

function buildScoreComponentsFromState(
  targets: Record<string, number>,
  histories: Record<string, PlayerHistory>,
  playerCount: number,
  periodStartVariationPenalty: number,
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
  return createHistoriesFromPeriods(
    plan.summaries.map((summary) => ({
      id: summary.playerId,
      name: summary.name,
    })),
    plan.periods,
  )
}

function createHistoriesFromPeriods(
  players: Array<Pick<Player, 'id' | 'name'>>,
  periods: PeriodPlan[],
): Record<string, PlayerHistory> {
  const playerIds = players.map((player) => player.id)
  const histories = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      createEmptyHistory(),
    ]),
  ) as Record<string, PlayerHistory>

  for (const period of periods) {
    const firstChunk = period.chunks[0]
    const starterIds = new Set(
      firstChunk ? period.positions.map((position) => getLineupPlayer(firstChunk.lineup, position)) : [],
    )
    histories[period.goalkeeperId]?.goalkeeperPeriods.push(period.period)

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

function buildPlayerSummariesFromHistories(
  players: Array<Pick<Player, 'id' | 'name'>>,
  histories: Record<string, PlayerHistory>,
): PlayerSummary[] {
  return players.map((player) => {
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

function forEachPermutation<T>(items: T[], callback: (permutation: readonly T[]) => void) {
  const values = [...items]

  const visit = (startIndex: number) => {
    if (startIndex === values.length - 1) {
      callback(values)
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
