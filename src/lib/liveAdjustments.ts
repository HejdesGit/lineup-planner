import { buildSummariesFromPeriods } from './planOverrides'
import { getPlanScoreBreakdown, scoreOutfieldPosition } from './scheduler'
import {
  ALL_POSITIONS,
  PERIOD_COUNT,
  ROLE_GROUPS,
  type ChunkPlan,
  type ChunkSubstitution,
  type Lineup,
  type LiveAdjustmentEvent,
  type LiveAvailabilityState,
  type LiveRecommendation,
  type MatchPlan,
  type OutfieldPosition,
  type PeriodPlan,
  type Player,
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

interface MatchChunkTemplate {
  chunkIndex: number
  periodIndex: number
  windowIndex: number
  startMinute: number
  endMinute: number
  durationMinutes: number
}

interface LivePlayerHistory {
  actualMinutes: number
  outfieldMinutes: number
  benchMinutes: number
  playStreak: number
  benchStreak: number
  lastChunkState: 'active' | 'bench' | null
  goalkeeperPeriods: number[]
  lastOutfieldPosition: OutfieldPosition | null
  lastOutfieldGroup: RoleGroup | null
  groupCounts: Record<RoleGroup, number>
  positionCounts: Record<OutfieldPosition, number>
  groupsPlayed: Set<RoleGroup>
  positionsPlayed: Set<OutfieldPosition>
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
  repeatedStartPeriods: number
  repeatedBenchStartPeriods: number
}

interface EventContext {
  players: Player[]
  playerIds: string[]
  nameById: Record<string, string>
  histories: Record<string, LivePlayerHistory>
  prefixPeriods: PeriodPlan[]
  currentPeriodPrefixChunks: ChunkPlan[]
  period: PeriodPlan
  currentChunk: ChunkPlan
  currentChunkIndex: number
  eventMinute: number
  hasStartedCurrentPeriod: boolean
  outfieldTargets: Record<string, number>
}

const ROUNDING_EPSILON = 0.0005
const TEMPORARY_OUT_FAIRNESS_WEIGHT = 32
const TEMPORARY_OUT_BENCH_STREAK_WEIGHT = 120
const TEMPORARY_OUT_ACTUAL_MINUTES_WEIGHT = 0.75
const TEMPORARY_OUT_ROTATION_WEIGHT = 5
const TEMPORARY_OUT_GOALKEEPER_BASE_PENALTY = 18
const TEMPORARY_OUT_GOALKEEPER_MINUTE_WEIGHT = 1.5

function getFairnessTargets(plan: Pick<MatchPlan, 'targets' | 'fairnessTargets'>) {
  return plan.fairnessTargets
}

export function resolveChunkAtMinute(period: PeriodPlan, minute: number) {
  const clampedMinute = roundMinuteValue(minute)
  const chunkIndex = period.chunks.findIndex((chunk, index) => {
    const isLastChunk = index === period.chunks.length - 1
    return (
      clampedMinute >= chunk.startMinute - ROUNDING_EPSILON &&
      (clampedMinute < chunk.endMinute - ROUNDING_EPSILON ||
        (isLastChunk && clampedMinute <= chunk.endMinute + ROUNDING_EPSILON))
    )
  })

  if (chunkIndex === -1) {
    return null
  }

  return {
    chunk: period.chunks[chunkIndex],
    chunkIndex,
    isExactBoundaryMinute: period.chunks.some(
      (chunk) =>
        nearlyEqual(clampedMinute, chunk.startMinute) ||
        nearlyEqual(clampedMinute, chunk.endMinute),
    ),
  }
}

export function createInitialAvailabilityState(plan: MatchPlan): LiveAvailabilityState {
  return Object.fromEntries(
    plan.summaries.map((summary) => [summary.playerId, 'available']),
  ) as LiveAvailabilityState
}

export function applyLiveAdjustmentEvents({
  plan,
  events,
}: {
  plan: MatchPlan
  events: LiveAdjustmentEvent[]
}) {
  let currentPlan = plan
  let availability = createInitialAvailabilityState(plan)

  for (const event of events) {
    const next = replanMatchFromLiveEvent({
      plan: currentPlan,
      event,
      availability,
    })
    currentPlan = next.plan
    availability = next.availability
  }

  return {
    plan: currentPlan,
    availability,
  }
}

export function getLiveRecommendations({
  plan,
  availability,
  period,
  minute,
  playerId,
  type,
  limit = 3,
}: {
  plan: MatchPlan
  availability: LiveAvailabilityState
  period: number
  minute: number
  playerId: string
  type: LiveAdjustmentEvent['type']
  limit?: number
}): LiveRecommendation[] {
  const context = buildEventContext({ plan, period: period, minute })
  const playerOrderById = Object.fromEntries(
    context.playerIds.map((candidateId, index) => [candidateId, index]),
  ) as Record<string, number>
  const phase: RotationPhase = context.hasStartedCurrentPeriod ? 'in-period' : 'period-start'

  if (type === 'injury' || type === 'temporary-out') {
    const position = findOutfieldPosition(context.currentChunk.lineup, playerId)

    if (!position || context.currentChunk.goalkeeperId === playerId) {
      return []
    }

    return getAvailableBenchPlayerIds({
      chunk: context.currentChunk,
      availability,
      playerIds: context.playerIds,
    })
      .map((candidateId) => {
        const history = context.histories[candidateId]
        const rotationScore = scoreOutfieldPosition(buildRotationSnapshot(history, phase), position, phase)
        const fairnessGap = Math.max(context.outfieldTargets[candidateId] - history.outfieldMinutes, 0)
        const benchPriority =
          history.benchStreak * TEMPORARY_OUT_BENCH_STREAK_WEIGHT -
          history.actualMinutes * TEMPORARY_OUT_ACTUAL_MINUTES_WEIGHT
        const rotationPenalty = rotationScore * TEMPORARY_OUT_ROTATION_WEIGHT
        const futureGoalkeeperMinutes = getRemainingGoalkeeperMinutes({
          plan,
          playerId: candidateId,
          period,
          minute,
        })
        const goalkeeperPenalty =
          futureGoalkeeperMinutes > ROUNDING_EPSILON
            ? TEMPORARY_OUT_GOALKEEPER_BASE_PENALTY +
              futureGoalkeeperMinutes * TEMPORARY_OUT_GOALKEEPER_MINUTE_WEIGHT
            : 0
        const score =
          fairnessGap * TEMPORARY_OUT_FAIRNESS_WEIGHT +
          benchPriority -
          rotationPenalty -
          goalkeeperPenalty
        const goalkeeperPenaltyApplied = goalkeeperPenalty > ROUNDING_EPSILON

        return {
          playerId: candidateId,
          position,
          score,
          fairnessGap: roundMinuteValue(fairnessGap),
          benchPriority: roundMinuteValue(benchPriority),
          rotationPenalty: roundMinuteValue(rotationPenalty),
          goalkeeperPenalty: roundMinuteValue(goalkeeperPenalty),
          goalkeeperPenaltyApplied,
          futureGoalkeeperMinutes: roundMinuteValue(futureGoalkeeperMinutes),
          reason:
            goalkeeperPenaltyApplied
              ? `Ligger efter i speltid och passar som ${position}, men har också framtida MV-tid.`
              : history.benchStreak > 0
                ? 'Har väntat längst, ligger efter i speltid och passar bra direkt.'
                : `Ligger efter i speltid och passar bra som ${position}.`,
        } satisfies LiveRecommendation
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }

        return playerOrderById[left.playerId] - playerOrderById[right.playerId]
      })
      .slice(0, limit)
  }

  if (type === 'return' && availability[playerId] !== 'available') {
    return getActiveOutfieldPlayerIds(context.currentChunk)
      .filter((candidateId) => candidateId !== playerId)
      .map((candidateId): LiveRecommendation | null => {
        const position = findOutfieldPosition(context.currentChunk.lineup, candidateId)

        if (!position) {
          return null
        }

        const returningHistory = context.histories[playerId]
        const currentHistory = context.histories[candidateId]
        const rotationScore = scoreOutfieldPosition(
          buildRotationSnapshot(returningHistory, phase),
          position,
          phase,
        )
        const overTarget = currentHistory.actualMinutes - getFairnessTargets(plan)[candidateId]
        const score =
          overTarget * 16 +
          currentHistory.playStreak * 18 +
          currentHistory.actualMinutes * 0.25 -
          rotationScore * 6

        return {
          playerId: candidateId,
          position,
          score,
          fairnessGap: roundMinuteValue(overTarget),
          benchPriority: 0,
          rotationPenalty: roundMinuteValue(rotationScore * 6),
          goalkeeperPenalty: 0,
          goalkeeperPenaltyApplied: false,
          futureGoalkeeperMinutes: 0,
          reason:
            overTarget > 0
              ? `Har redan fått mer speltid och frigör plats på ${position}.`
              : `Ger snabbast väg tillbaka på ${position}.`,
        } satisfies LiveRecommendation
      })
      .filter((recommendation): recommendation is LiveRecommendation => recommendation !== null)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score
        }

        return playerOrderById[left.playerId] - playerOrderById[right.playerId]
      })
      .slice(0, limit)
  }

  return []
}

export function replanMatchFromLiveEvent({
  plan,
  event,
  availability,
}: {
  plan: MatchPlan
  event: LiveAdjustmentEvent
  availability: LiveAvailabilityState
}) {
  const context = buildEventContext({
    plan,
    period: event.period,
    minute: event.minute,
  })
  const nextAvailability = {
    ...availability,
    [event.playerId]: event.type === 'return' ? 'available' : event.status ?? 'temporarily-out',
  } as LiveAvailabilityState

  const currentPosition =
    event.type === 'return'
      ? findOutfieldPosition(context.currentChunk.lineup, event.replacementPlayerId)
      : findOutfieldPosition(context.currentChunk.lineup, event.playerId)

  if (!currentPosition) {
    throw new Error('Spelaren är inte aktiv som utespelare i det här byteblocket.')
  }

  if (event.type === 'return' && availability[event.playerId] === 'available') {
    throw new Error('Spelaren är redan tillgänglig.')
  }

  if (event.type !== 'return' && context.currentChunk.goalkeeperId === event.playerId) {
    throw new Error('Målvaktsskador stöds inte i den här versionen.')
  }

  const periodIndex = event.period - 1
  const currentRemainderDuration = roundMinuteValue(context.currentChunk.endMinute - context.eventMinute)
  const nameById = context.nameById
  const allPlayerIds = context.playerIds
  const playerOrderById = Object.fromEntries(
    allPlayerIds.map((playerId, index) => [playerId, index]),
  ) as Record<string, number>
  const adjustedGoalkeepers = resolveAdjustedGoalkeepers({
    plan,
    availability: nextAvailability,
    currentPeriodIndex: periodIndex,
    playerIds: allPlayerIds,
  })
  validateEventReplacement({
    event,
    availability,
    currentChunk: context.currentChunk,
    playerIds: allPlayerIds,
  })

  const periods: PeriodPlan[] = [...context.prefixPeriods]
  const currentPeriodChunks = [...context.currentPeriodPrefixChunks]
  let currentPeriodStarted = context.hasStartedCurrentPeriod

  if (currentRemainderDuration > ROUNDING_EPSILON) {
    const forcedLineup = {
      ...context.currentChunk.lineup,
      [currentPosition]:
        event.type === 'return' ? event.playerId : event.replacementPlayerId,
    } satisfies Lineup
    const substitution: ChunkSubstitution =
      event.type === 'return'
        ? {
            playerInId: event.playerId,
            playerOutId: event.replacementPlayerId,
            position: currentPosition,
          }
        : {
            playerInId: event.replacementPlayerId,
            playerOutId: event.playerId,
            position: currentPosition,
          }
    const remainderChunk = createChunk({
      template: {
        chunkIndex: context.currentChunk.chunkIndex,
        periodIndex,
        windowIndex: context.currentChunk.windowIndex,
        startMinute: context.eventMinute,
        endMinute: context.currentChunk.endMinute,
        durationMinutes: currentRemainderDuration,
      },
      lineup: forcedLineup,
      goalkeeperId: context.currentChunk.goalkeeperId,
      allPlayerIds,
      nameById,
      availability: nextAvailability,
      substitutions: [substitution],
    })

    currentPeriodChunks.push(remainderChunk)
    applyChunkToHistories({
      chunk: remainderChunk,
      positions: plan.positions,
      playerIds: allPlayerIds,
      histories: context.histories,
      isPeriodStart: !currentPeriodStarted && remainderChunk.startMinute <= ROUNDING_EPSILON,
    })
    currentPeriodStarted = true
  }

  const futureTemplates = buildFutureTemplates({
    plan,
    periodIndex,
    currentChunkIndex: context.currentChunkIndex + 1,
  })
  const adjustedFairnessTargets = buildAvailabilityAdjustedTargets({
    playerIds: allPlayerIds,
    originalTargets: plan.targets,
    histories: context.histories,
    futureTemplates,
    goalkeepers: adjustedGoalkeepers,
    availability: nextAvailability,
    activePlayerCount: plan.positions.length + 1,
  })
  const outfieldTargets = buildOutfieldTargets({
    playerIds: allPlayerIds,
    targets: adjustedFairnessTargets,
    goalkeepers: adjustedGoalkeepers,
    periodMinutes: plan.periodMinutes,
  })
  const remainingEligibleByPlayer = buildRemainingEligibleLookup({
    playerIds: allPlayerIds,
    templates: futureTemplates,
    goalkeepers: adjustedGoalkeepers,
    availability: nextAvailability,
  })

  let previousLineup: Lineup | null =
    currentPeriodChunks.length > 0
      ? currentPeriodChunks[currentPeriodChunks.length - 1].lineup
      : context.currentChunk.lineup

  for (const template of futureTemplates.filter((candidate) => candidate.periodIndex === periodIndex)) {
    const assignment = buildPlannedChunk({
      template,
      plan,
      previousLineup,
      histories: context.histories,
      outfieldTargets,
      remainingEligibleByPlayer,
      availability: nextAvailability,
      playerOrderById,
      goalkeepers: adjustedGoalkeepers,
    })

    currentPeriodChunks.push(assignment.chunk)
    applyChunkToHistories({
      chunk: assignment.chunk,
      positions: plan.positions,
      playerIds: allPlayerIds,
      histories: context.histories,
      isPeriodStart: !currentPeriodStarted && template.startMinute <= ROUNDING_EPSILON,
    })
    currentPeriodStarted = true
    previousLineup = assignment.chunk.lineup
  }

  periods.push(
    buildPeriodPlan({
      periodNumber: event.period,
      formation: plan.formation,
      positions: plan.positions,
      goalkeeperId: adjustedGoalkeepers[periodIndex],
      chunks: currentPeriodChunks,
      nameById,
    }),
  )

  for (let nextPeriodIndex = periodIndex + 1; nextPeriodIndex < PERIOD_COUNT; nextPeriodIndex += 1) {
    const chunks: ChunkPlan[] = []
    previousLineup = null

    for (const template of futureTemplates.filter((candidate) => candidate.periodIndex === nextPeriodIndex)) {
      const assignment = buildPlannedChunk({
        template,
        plan,
        previousLineup,
        histories: context.histories,
        outfieldTargets,
        remainingEligibleByPlayer,
        availability: nextAvailability,
        playerOrderById,
        goalkeepers: adjustedGoalkeepers,
      })

      chunks.push(assignment.chunk)
      applyChunkToHistories({
        chunk: assignment.chunk,
        positions: plan.positions,
        playerIds: allPlayerIds,
        histories: context.histories,
        isPeriodStart: template.windowIndex === 0,
      })
      previousLineup = assignment.chunk.lineup
    }

    periods.push(
      buildPeriodPlan({
          periodNumber: nextPeriodIndex + 1,
          formation: plan.formation,
          positions: plan.positions,
          goalkeeperId: adjustedGoalkeepers[nextPeriodIndex],
          chunks,
          nameById,
        }),
    )
  }

  const normalizedPeriods = normalizePeriods(periods, nameById)
  const summaries = buildSummariesFromPeriods(plan.summaries, normalizedPeriods, nameById)

  return {
    availability: nextAvailability,
    plan: {
      ...plan,
      goalkeepers: adjustedGoalkeepers,
      fairnessTargets: adjustedFairnessTargets,
      periods: normalizedPeriods,
      summaries,
      score: getPlanScoreBreakdown({
        periods: normalizedPeriods,
        summaries,
        targets: plan.targets,
        fairnessTargets: adjustedFairnessTargets,
      }).totalScore,
    },
  }
}

function buildEventContext({
  plan,
  period,
  minute,
}: {
  plan: MatchPlan
  period: number
  minute: number
}): EventContext {
  const players = plan.summaries.map((summary) => ({
    id: summary.playerId,
    name: summary.name,
  }))
  const playerIds = players.map((player) => player.id)
  const nameById = Object.fromEntries(players.map((player) => [player.id, player.name])) as Record<
    string,
    string
  >
  const periodIndex = period - 1
  const currentPeriod = plan.periods[periodIndex]

  if (!currentPeriod) {
    throw new Error('Det finns ingen aktiv period att justera.')
  }

  const eventMinute = roundMinuteValue(Math.min(Math.max(minute, 0), plan.periodMinutes))
  const resolvedChunk = resolveChunkAtMinute(currentPeriod, eventMinute)
  const currentChunkIndex = resolvedChunk?.chunkIndex ?? -1
  const currentChunk = resolvedChunk?.chunk

  if (!currentChunk) {
    throw new Error('Det gick inte att hitta aktivt byteblock.')
  }

  const histories = createHistories(players, plan.goalkeepers)
  const prefixPeriods: PeriodPlan[] = []
  const currentPeriodPrefixChunks: ChunkPlan[] = []

  for (let prefixPeriodIndex = 0; prefixPeriodIndex < periodIndex; prefixPeriodIndex += 1) {
    prefixPeriods.push(plan.periods[prefixPeriodIndex])

    for (const chunk of plan.periods[prefixPeriodIndex].chunks) {
      applyChunkToHistories({
        chunk,
        positions: plan.positions,
        playerIds,
        histories,
        isPeriodStart: chunk.windowIndex === 0,
      })
    }
  }

  for (let chunkIndex = 0; chunkIndex < currentChunkIndex; chunkIndex += 1) {
    const chunk = currentPeriod.chunks[chunkIndex]
    currentPeriodPrefixChunks.push(chunk)
    applyChunkToHistories({
      chunk,
      positions: plan.positions,
      playerIds,
      histories,
      isPeriodStart: chunk.windowIndex === 0,
    })
  }

  if (eventMinute - currentChunk.startMinute > ROUNDING_EPSILON) {
    const playedPrefix = cloneChunk(currentChunk, currentChunk.startMinute, eventMinute, currentChunk.substitutions)
    currentPeriodPrefixChunks.push(playedPrefix)
    applyChunkToHistories({
      chunk: playedPrefix,
      positions: plan.positions,
      playerIds,
      histories,
      isPeriodStart: playedPrefix.startMinute <= ROUNDING_EPSILON,
    })
  }

  const goalkeeperMinuteCounts = Object.fromEntries(playerIds.map((playerId) => [playerId, 0])) as Record<
    string,
    number
  >

  for (const goalkeeperId of plan.goalkeepers) {
    goalkeeperMinuteCounts[goalkeeperId] += plan.periodMinutes
  }

  const fairnessTargets = getFairnessTargets(plan)
  const outfieldTargets = Object.fromEntries(
    playerIds.map((playerId) => [
      playerId,
      Math.max(0, fairnessTargets[playerId] - goalkeeperMinuteCounts[playerId]),
    ]),
  ) as Record<string, number>

  return {
    players,
    playerIds,
    nameById,
    histories,
    prefixPeriods,
    currentPeriodPrefixChunks,
    period: currentPeriod,
    currentChunk,
    currentChunkIndex,
    eventMinute,
    hasStartedCurrentPeriod: currentPeriodPrefixChunks.length > 0,
    outfieldTargets,
  }
}

function validateEventReplacement({
  event,
  availability,
  currentChunk,
  playerIds,
}: {
  event: LiveAdjustmentEvent
  availability: LiveAvailabilityState
  currentChunk: ChunkPlan
  playerIds: string[]
}) {
  if (!playerIds.includes(event.playerId) || !playerIds.includes(event.replacementPlayerId)) {
    throw new Error('Okänd spelare i live-byte.')
  }

  if (event.type === 'return') {
    if (!getActiveOutfieldPlayerIds(currentChunk).includes(event.replacementPlayerId)) {
      throw new Error('Välj en aktiv utespelare att byta ut.')
    }

    return
  }

  if (availability[event.replacementPlayerId] !== 'available') {
    throw new Error('Den valda ersättaren är inte tillgänglig.')
  }

  const availableBenchPlayerIds = getAvailableBenchPlayerIds({
    chunk: currentChunk,
    availability,
    playerIds,
  })

  if (!availableBenchPlayerIds.includes(event.replacementPlayerId)) {
    throw new Error('Den valda ersättaren måste komma från bänken.')
  }
}

function buildFutureTemplates({
  plan,
  periodIndex,
  currentChunkIndex,
}: {
  plan: MatchPlan
  periodIndex: number
  currentChunkIndex: number
}) {
  const templates: MatchChunkTemplate[] = []
  let localChunkIndex = 0

  for (let nextPeriodIndex = periodIndex; nextPeriodIndex < PERIOD_COUNT; nextPeriodIndex += 1) {
    const sourceChunks =
      nextPeriodIndex === periodIndex
        ? plan.periods[nextPeriodIndex].chunks.slice(currentChunkIndex)
        : plan.periods[nextPeriodIndex].chunks

    for (const chunk of sourceChunks) {
      templates.push({
        chunkIndex: localChunkIndex,
        periodIndex: nextPeriodIndex,
        windowIndex: chunk.windowIndex,
        startMinute: chunk.startMinute,
        endMinute: chunk.endMinute,
        durationMinutes: chunk.durationMinutes,
      })
      localChunkIndex += 1
    }
  }

  return templates
}

function buildRemainingEligibleLookup({
  playerIds,
  templates,
  goalkeepers,
  availability,
}: {
  playerIds: string[]
  templates: MatchChunkTemplate[]
  goalkeepers: string[]
  availability: LiveAvailabilityState
}) {
  const lookup: Record<string, number[]> = {}

  for (const playerId of playerIds) {
    const remaining = Array.from({ length: templates.length }, () => 0)
    let running = 0

    for (let chunkIndex = templates.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = templates[chunkIndex]
      if (goalkeepers[chunk.periodIndex] !== playerId && availability[playerId] === 'available') {
        running += chunk.durationMinutes
      }
      remaining[chunkIndex] = running
    }

    lookup[playerId] = remaining
  }

  return lookup
}

function resolveAdjustedGoalkeepers({
  plan,
  availability,
  currentPeriodIndex,
  playerIds,
}: {
  plan: MatchPlan
  availability: LiveAvailabilityState
  currentPeriodIndex: number
  playerIds: string[]
}) {
  const goalkeepers = [...plan.goalkeepers]
  const playerOrderById = Object.fromEntries(
    playerIds.map((playerId, index) => [playerId, index]),
  ) as Record<string, number>
  const usedGoalkeepers = new Set(goalkeepers.slice(0, currentPeriodIndex + 1))

  for (let periodIndex = currentPeriodIndex + 1; periodIndex < PERIOD_COUNT; periodIndex += 1) {
    if (availability[goalkeepers[periodIndex]] === 'available') {
      usedGoalkeepers.add(goalkeepers[periodIndex])
      continue
    }

    const nextGoalkeeper =
      playerIds
        .filter((playerId) => availability[playerId] === 'available' && !usedGoalkeepers.has(playerId))
        .sort((left, right) => playerOrderById[left] - playerOrderById[right])[0] ??
      playerIds
        .filter((playerId) => availability[playerId] === 'available')
        .sort((left, right) => playerOrderById[left] - playerOrderById[right])[0]

    if (!nextGoalkeeper) {
      throw new Error('Det finns ingen tillgänglig spelare kvar att sätta i mål.')
    }

    goalkeepers[periodIndex] = nextGoalkeeper
    usedGoalkeepers.add(nextGoalkeeper)
  }

  return goalkeepers
}

function buildOutfieldTargets({
  playerIds,
  targets,
  goalkeepers,
  periodMinutes,
}: {
  playerIds: string[]
  targets: MatchPlan['targets']
  goalkeepers: string[]
  periodMinutes: MatchPlan['periodMinutes']
}) {
  const goalkeeperMinuteCounts = Object.fromEntries(playerIds.map((playerId) => [playerId, 0])) as Record<
    string,
    number
  >

  for (const goalkeeperId of goalkeepers) {
    goalkeeperMinuteCounts[goalkeeperId] += periodMinutes
  }

  return Object.fromEntries(
    playerIds.map((playerId) => [playerId, Math.max(0, targets[playerId] - goalkeeperMinuteCounts[playerId])]),
  ) as Record<string, number>
}

function buildAvailabilityAdjustedTargets({
  playerIds,
  originalTargets,
  histories,
  futureTemplates,
  goalkeepers,
  availability,
  activePlayerCount,
}: {
  playerIds: string[]
  originalTargets: MatchPlan['targets']
  histories: Record<string, LivePlayerHistory>
  futureTemplates: MatchChunkTemplate[]
  goalkeepers: string[]
  availability: LiveAvailabilityState
  activePlayerCount: number
}) {
  const adjustedTargets = Object.fromEntries(
    playerIds.map((playerId) => [playerId, histories[playerId].actualMinutes]),
  ) as Record<string, number>
  const futureGoalkeeperMinutes = Object.fromEntries(
    playerIds.map((playerId) => [playerId, 0]),
  ) as Record<string, number>

  let futureTotalPlayerMinutes = 0

  for (const template of futureTemplates) {
    futureTotalPlayerMinutes += template.durationMinutes * activePlayerCount
    futureGoalkeeperMinutes[goalkeepers[template.periodIndex]] += template.durationMinutes
  }

  const availablePlayerIds = playerIds.filter((playerId) => availability[playerId] === 'available')
  const mandatoryTotal = availablePlayerIds.reduce(
    (total, playerId) => total + futureGoalkeeperMinutes[playerId],
    0,
  )
  const distributableMinutes = Math.max(0, futureTotalPlayerMinutes - mandatoryTotal)
  const baseNeeds = Object.fromEntries(
    availablePlayerIds.map((playerId) => [
      playerId,
      Math.max(
        0,
        originalTargets[playerId] - histories[playerId].actualMinutes - futureGoalkeeperMinutes[playerId],
      ),
    ]),
  ) as Record<string, number>
  const totalBaseNeed = availablePlayerIds.reduce((total, playerId) => total + baseNeeds[playerId], 0)

  for (const playerId of availablePlayerIds) {
    adjustedTargets[playerId] += futureGoalkeeperMinutes[playerId]
  }

  if (availablePlayerIds.length > 0 && distributableMinutes > ROUNDING_EPSILON) {
    if (totalBaseNeed > distributableMinutes + ROUNDING_EPSILON) {
      const scale = distributableMinutes / totalBaseNeed

      for (const playerId of availablePlayerIds) {
        adjustedTargets[playerId] += baseNeeds[playerId] * scale
      }
    } else {
      const equalSurplus = (distributableMinutes - totalBaseNeed) / availablePlayerIds.length

      for (const playerId of availablePlayerIds) {
        adjustedTargets[playerId] += baseNeeds[playerId] + equalSurplus
      }
    }
  }

  const roundedTargets = Object.fromEntries(
    playerIds.map((playerId) => [playerId, roundMinuteValue(adjustedTargets[playerId])]),
  ) as Record<string, number>
  const expectedTotal = roundMinuteValue(
    Object.values(histories).reduce((total, history) => total + history.actualMinutes, 0) +
      futureTotalPlayerMinutes,
  )
  const roundedTotal = roundMinuteValue(
    Object.values(roundedTargets).reduce((total, target) => total + target, 0),
  )
  const delta = roundMinuteValue(expectedTotal - roundedTotal)
  const normalizationPlayerId = availablePlayerIds[0] ?? playerIds[0]

  if (normalizationPlayerId && Math.abs(delta) > ROUNDING_EPSILON) {
    roundedTargets[normalizationPlayerId] = roundMinuteValue(
      roundedTargets[normalizationPlayerId] + delta,
    )
  }

  return roundedTargets
}

function buildPlannedChunk({
  template,
  plan,
  previousLineup,
  histories,
  outfieldTargets,
  remainingEligibleByPlayer,
  availability,
  playerOrderById,
  goalkeepers,
}: {
  template: MatchChunkTemplate
  plan: MatchPlan
  previousLineup: Lineup | null
  histories: Record<string, LivePlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  availability: LiveAvailabilityState
  playerOrderById: Record<string, number>
  goalkeepers: string[]
}) {
  const playerIds = plan.summaries.map((summary) => summary.playerId)
  const nameById = Object.fromEntries(plan.summaries.map((summary) => [summary.playerId, summary.name])) as Record<
    string,
    string
  >
  const goalkeeperId = goalkeepers[template.periodIndex]
  const phase: RotationPhase =
    template.windowIndex === 0 && !previousLineup ? 'period-start' : 'in-period'
  const selectedPlayerIds = selectOutfieldPlayers({
    chunk: template,
    playerIds,
    goalkeeperId,
    histories,
    outfieldTargets,
    remainingEligibleByPlayer,
    positions: plan.positions,
    phase,
    availability,
  })

  if (!selectedPlayerIds) {
    throw new Error('Det finns ingen tillgänglig ersättare just nu.')
  }

  const assignment =
    phase === 'period-start' || !previousLineup
      ? {
          lineup: assignBestPositions(selectedPlayerIds, plan.positions, histories, phase),
          substitutions: [],
        }
      : assignInPeriodLineup(selectedPlayerIds, previousLineup, plan.positions, histories, playerOrderById)

  return {
    chunk: createChunk({
      template,
      lineup: assignment.lineup,
      goalkeeperId,
      allPlayerIds: playerIds,
      nameById,
      availability,
      substitutions: assignment.substitutions,
    }),
  }
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
  availability,
}: {
  chunk: MatchChunkTemplate
  playerIds: string[]
  goalkeeperId: string
  histories: Record<string, LivePlayerHistory>
  outfieldTargets: Record<string, number>
  remainingEligibleByPlayer: Record<string, number[]>
  positions: readonly OutfieldPosition[]
  phase: RotationPhase
  availability: LiveAvailabilityState
}) {
  const candidates: Array<{ playerId: string; score: number }> = []

  for (const playerId of playerIds) {
    if (playerId === goalkeeperId || availability[playerId] !== 'available') {
      continue
    }

    const history = histories[playerId]
    const remainingNeed = outfieldTargets[playerId] - history.outfieldMinutes
    const remainingOpportunities = remainingEligibleByPlayer[playerId]?.[chunk.chunkIndex] ?? 0
    const futureAfterCurrent = remainingOpportunities - chunk.durationMinutes
    const criticalGap = Math.max(remainingNeed - futureAfterCurrent, 0)
    const shortagePressure = remainingNeed / Math.max(remainingOpportunities, 1)
    const score =
      phase === 'period-start'
        ? (history.startedPreviousPeriod ? -140 : 75) +
          (history.benchedPreviousPeriod ? 95 : 0) +
          history.periodBenchStarts * 30 -
          history.periodStarts * 22 +
          history.repeatedBenchStartPeriods * 45 -
          history.repeatedStartPeriods * 18 +
          criticalGap * 85 +
          Math.max(remainingNeed, 0) * 12 +
          shortagePressure * 24 -
          history.actualMinutes * 1.2
        : criticalGap * 100 +
          Math.max(remainingNeed, 0) * 12 +
          shortagePressure * 30 +
          history.benchStreak * 120 -
          history.actualMinutes * 0.55 +
          Math.min(history.playStreak, 2) * 20

    candidates.push({ playerId, score })
  }

  return selectPlayersWithBenchProtection(candidates, histories, positions.length)
}

function selectPlayersWithBenchProtection(
  candidates: Array<{ playerId: string; score: number }>,
  histories: Record<string, LivePlayerHistory>,
  requiredCount: number,
) {
  const mandatory = candidates.filter((candidate) => histories[candidate.playerId].benchStreak > 0)
  const optional = candidates.filter((candidate) => histories[candidate.playerId].benchStreak === 0)

  mandatory.sort((left, right) => right.score - left.score)
  optional.sort((left, right) => right.score - left.score)

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
  histories: Record<string, LivePlayerHistory>,
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
      cost += scoreOutfieldPosition(buildRotationSnapshot(histories[playerId], phase), position, phase)
    }

    if (cost < bestCost) {
      bestCost = cost
      bestAssignment = Object.fromEntries(
        positions.map((position, index) => [position, permutation[index]]),
      ) as Lineup
    }
  })

  return bestAssignment
}

function assignInPeriodLineup(
  selectedPlayerIds: string[],
  previousLineup: Lineup,
  positions: readonly OutfieldPosition[],
  histories: Record<string, LivePlayerHistory>,
  playerOrderById: Record<string, number>,
) {
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
      cost += scoreOutfieldPosition(
        buildRotationSnapshot(histories[incomingPlayerId], 'in-period'),
        outgoingAssignment.position,
        'in-period',
      )
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

function createChunk({
  template,
  lineup,
  goalkeeperId,
  allPlayerIds,
  nameById,
  availability,
  substitutions,
}: {
  template: MatchChunkTemplate
  lineup: Lineup
  goalkeeperId: string
  allPlayerIds: string[]
  nameById: Record<string, string>
  availability: LiveAvailabilityState
  substitutions: ChunkSubstitution[]
}) {
  const activePlayerIds = [goalkeeperId, ...Object.values(lineup)]
  const activeSet = new Set(activePlayerIds)

  return {
    chunkIndex: template.chunkIndex,
    period: template.periodIndex + 1,
    windowIndex: template.windowIndex,
    startMinute: template.startMinute,
    endMinute: template.endMinute,
    durationMinutes: template.durationMinutes,
    goalkeeperId,
    goalkeeperName: nameById[goalkeeperId],
    lineup,
    activePlayerIds,
    substitutes: allPlayerIds
      .filter((playerId) => !activeSet.has(playerId) && availability[playerId] === 'available')
      .map((playerId) => nameById[playerId]),
    substitutions,
  } satisfies ChunkPlan
}

function buildPeriodPlan({
  periodNumber,
  formation,
  positions,
  goalkeeperId,
  chunks,
  nameById,
}: {
  periodNumber: number
  formation: MatchPlan['formation']
  positions: readonly OutfieldPosition[]
  goalkeeperId: string
  chunks: ChunkPlan[]
  nameById: Record<string, string>
}) {
  const substituteNames = Array.from(new Set(chunks.flatMap((chunk) => chunk.substitutes)))

  return {
    period: periodNumber,
    formation,
    positions,
    goalkeeperId,
    goalkeeperName: nameById[goalkeeperId],
    startingLineup: chunks[0]?.lineup ?? {},
    chunks,
    substitutes: substituteNames,
  } satisfies PeriodPlan
}

function normalizePeriods(periods: PeriodPlan[], nameById: Record<string, string>) {
  let nextChunkIndex = 0

  return periods.map((period) => {
    const chunks = period.chunks.map((chunk, index) => ({
      ...chunk,
      chunkIndex: nextChunkIndex++,
      period: period.period,
      windowIndex: index,
      goalkeeperName: nameById[chunk.goalkeeperId],
      startMinute: roundMinuteValue(chunk.startMinute),
      endMinute: roundMinuteValue(chunk.endMinute),
      durationMinutes: roundMinuteValue(chunk.endMinute - chunk.startMinute),
    }))

    return {
      ...period,
      goalkeeperName: nameById[period.goalkeeperId],
      startingLineup: chunks[0]?.lineup ?? {},
      substitutes: Array.from(new Set(chunks.flatMap((chunk) => chunk.substitutes))),
      chunks,
    }
  })
}

function cloneChunk(
  chunk: ChunkPlan,
  startMinute: number,
  endMinute: number,
  substitutions: ChunkSubstitution[],
) {
  return {
    ...chunk,
    startMinute: roundMinuteValue(startMinute),
    endMinute: roundMinuteValue(endMinute),
    durationMinutes: roundMinuteValue(endMinute - startMinute),
    substitutions,
  }
}

function applyChunkToHistories({
  chunk,
  positions,
  playerIds,
  histories,
  isPeriodStart,
}: {
  chunk: Pick<ChunkPlan, 'goalkeeperId' | 'lineup' | 'activePlayerIds' | 'durationMinutes'>
  positions: readonly OutfieldPosition[]
  playerIds: string[]
  histories: Record<string, LivePlayerHistory>
  isPeriodStart: boolean
}) {
  const activeSet = new Set(chunk.activePlayerIds)

  if (isPeriodStart) {
    updatePeriodStartHistory(playerIds, chunk.goalkeeperId, activeSet, positions, chunk.lineup, histories)
  }

  for (const playerId of playerIds) {
    const history = histories[playerId]
    const isActive = activeSet.has(playerId)
    const nextState = isActive ? 'active' : 'bench'

    if (isActive) {
      history.actualMinutes += chunk.durationMinutes
      history.playStreak += 1
      history.benchStreak = 0
    } else {
      history.benchMinutes += chunk.durationMinutes
      history.playStreak = 0
      history.benchStreak += 1
    }

    history.lastChunkState = nextState
  }

  for (const position of positions) {
    const playerId = getLineupPlayer(chunk.lineup, position)
    const history = histories[playerId]
    const group = ROLE_GROUPS[position]

    history.outfieldMinutes += chunk.durationMinutes
    history.lastOutfieldPosition = position
    history.lastOutfieldGroup = group
    history.positionCounts[position] += chunk.durationMinutes
    history.groupCounts[group] += chunk.durationMinutes
    history.positionsPlayed.add(position)
    history.groupsPlayed.add(group)
  }
}

function updatePeriodStartHistory(
  playerIds: string[],
  goalkeeperId: string,
  activeSet: Set<string>,
  positions: readonly OutfieldPosition[],
  assignment: Lineup,
  histories: Record<string, LivePlayerHistory>,
) {
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
    const history = histories[playerId]
    const group = ROLE_GROUPS[position]

    history.lastStartPosition = position
    history.lastStartGroup = group
    history.startPositionCounts[position] += 1
    history.startGroupCounts[group] += 1
    history.startPositionsPlayed.add(position)
    history.startGroupsPlayed.add(group)
  }
}

function createHistories(players: Player[], goalkeepers: string[]) {
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
        goalkeeperPeriods: goalkeepers
          .map((goalkeeperId, index) => (goalkeeperId === player.id ? index + 1 : null))
          .filter((value): value is number => value !== null),
        lastOutfieldPosition: null,
        lastOutfieldGroup: null,
        groupCounts: { DEF: 0, MID: 0, ATT: 0 },
        positionCounts: { VB: 0, CB: 0, HB: 0, VM: 0, CM: 0, HM: 0, A: 0 },
        groupsPlayed: new Set<RoleGroup>(),
        positionsPlayed: new Set<OutfieldPosition>(),
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
        repeatedStartPeriods: 0,
        repeatedBenchStartPeriods: 0,
      } satisfies LivePlayerHistory,
    ]),
  ) as Record<string, LivePlayerHistory>
}

function buildRotationSnapshot(history: LivePlayerHistory, phase: RotationPhase): RotationSnapshot {
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

function getAvailableBenchPlayerIds({
  chunk,
  availability,
  playerIds,
}: {
  chunk: ChunkPlan
  availability: LiveAvailabilityState
  playerIds: string[]
}) {
  const activeSet = new Set(chunk.activePlayerIds)
  return playerIds.filter((playerId) => !activeSet.has(playerId) && availability[playerId] === 'available')
}

function getActiveOutfieldPlayerIds(chunk: ChunkPlan) {
  return Object.values(chunk.lineup)
}

function getRemainingGoalkeeperMinutes({
  plan,
  playerId,
  period,
  minute,
}: {
  plan: MatchPlan
  playerId: string
  period: number
  minute: number
}) {
  return roundMinuteValue(
    plan.periods
      .flatMap((currentPeriod) => currentPeriod.chunks)
      .filter(
        (chunk) =>
          chunk.goalkeeperId === playerId &&
          (chunk.period > period || (chunk.period === period && chunk.startMinute >= minute - ROUNDING_EPSILON)),
      )
      .reduce((total, chunk) => total + chunk.durationMinutes, 0),
  )
}

function findOutfieldPosition(lineup: Lineup, playerId: string) {
  return ALL_POSITIONS.find((position) => lineup[position] === playerId) ?? null
}

function getLineupPlayer(lineup: Lineup, position: OutfieldPosition) {
  const playerId = lineup[position]

  if (!playerId) {
    throw new Error(`Saknar spelare för position ${position}.`)
  }

  return playerId
}

function roundMinuteValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= ROUNDING_EPSILON
}

function forEachPermutation<T>(items: T[], callback: (permutation: T[]) => void) {
  const used = Array.from({ length: items.length }, () => false)
  const next = Array.from({ length: items.length }) as T[]

  const iterate = (index: number) => {
    if (index === items.length) {
      callback([...next])
      return
    }

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      if (used[itemIndex]) {
        continue
      }

      used[itemIndex] = true
      next[index] = items[itemIndex]
      iterate(index + 1)
      used[itemIndex] = false
    }
  }

  iterate(0)
}
