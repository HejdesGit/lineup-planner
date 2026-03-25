import {
  createInitialAvailabilityState,
  getLiveRecommendations,
  replanMatchFromLiveEvent,
  resolveChunkAtMinute,
} from './liveAdjustments'
import { getPlanScoreBreakdown, generateMatchPlan, resolveAttemptCount } from './scheduler'
import { createNamedPlayers, getRosterNames, type RosterOrder } from './playerPool'
import {
  SUBSTITUTIONS_PER_PERIOD_OPTIONS,
  getChunkMinutesForSubstitutions,
  getSubstitutionsPerPeriod,
  type SubstitutionsPerPeriod,
} from './substitutions'
import {
  PERIOD_COUNT_OPTIONS,
  PERIOD_MINUTE_OPTIONS,
  type FormationKey,
  type LiveAdjustmentEvent,
  type MatchPlan,
  type Player,
  type PlayerSummary,
} from './types'

export const DEFAULT_AUDIT_PLAYER_COUNTS = [8, 9, 10, 11, 12] as const
export const DEFAULT_AUDIT_PERIOD_COUNTS = [...PERIOD_COUNT_OPTIONS] as const
export const DEFAULT_AUDIT_PERIOD_MINUTES = [...PERIOD_MINUTE_OPTIONS] as const
export const DEFAULT_AUDIT_FORMATIONS = ['2-3-1', '3-2-1'] as const
export const DEFAULT_AUDIT_GOALKEEPER_MODES = [
  'auto',
  'lock-period-1',
  'lock-period-1-and-last',
  'lock-all-periods',
] as const
export const DEFAULT_AUDIT_ROSTER_ORDERS = ['canonical', 'reversed'] as const
export const ALL_AUDIT_LIVE_PATTERNS = [
  'none',
  'single-temporary-out',
  'quick-return',
  'injury-mid-match',
  'double-temporary-out',
  'cross-period-return',
  'position-swap-outfield',
  'position-swap-goalkeeper',
  'position-swap-bench',
] as const
export const DEFAULT_AUDIT_LIVE_PATTERNS =
  ['none'] as const satisfies readonly (typeof ALL_AUDIT_LIVE_PATTERNS)[number][]
export const DEFAULT_AUDIT_SEEDS = [1, 7, 19, 42, 99] as const
export const LINEUP_AUDIT_SCHEMA_VERSION = 1 as const
const MINUTE_TOLERANCE = 0.001
const LIVE_ADJUSTMENT_EPSILON = 0.0005
const LIVE_ADJUSTMENT_TOLERANCE_OFFSET = 0.05

export type GoalkeeperMode = (typeof DEFAULT_AUDIT_GOALKEEPER_MODES)[number]
export type LiveAdjustmentPattern = (typeof ALL_AUDIT_LIVE_PATTERNS)[number]
export type AuditFlag =
  | 'total-minutes-mismatch'
  | 'bench-minutes-mismatch'
  | 'minute-spread-over-limit'
  | 'bench-spread-over-limit'
  | 'consecutive-bench'
  | 'goalkeeper-lock-mismatch'
  | 'summary-minutes-mismatch'
  | 'duplicate-goalkeepers'
  | 'score-mismatch'
  | 'isolated-play-blocks'
  | 'unavailable-player-leak'
  | 'live-fairness-exceeded'
  | 'live-pattern-incomplete'

export interface AuditScenario {
  scenarioId: string
  playerCount: number
  periodCount: number
  periodMinutes: number
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  chunkMinutes: number
  goalkeeperMode: GoalkeeperMode
  rosterOrder: RosterOrder
  rosterNames: string[]
  liveAdjustmentPattern: LiveAdjustmentPattern
}

export interface AuditScenarioFilters {
  playerCounts?: readonly number[]
  periodCounts?: readonly number[]
  periodMinutes?: readonly number[]
  formations?: readonly FormationKey[]
  substitutions?: readonly SubstitutionsPerPeriod[]
  goalkeeperModes?: readonly GoalkeeperMode[]
  rosterOrders?: readonly RosterOrder[]
  liveAdjustmentPatterns?: readonly LiveAdjustmentPattern[]
}

export interface PlayerAuditMetrics {
  playerId: string
  name: string
  totalMinutes: number
  benchMinutes: number
  goalkeeperMinutes: number
  outfieldMinutes: number
  goalkeeperPeriods: number[]
  positionsPlayed: PlayerSummary['positionsPlayed']
  roleGroups: PlayerSummary['roleGroups']
  isolatedPlayBlocks: number
  longestPlayStreakWindows: number
  longestPlayStreakMinutes: number
  longestBenchStreakWindows: number
  longestBenchStreakMinutes: number
  consecutiveBenchWindowCount: number
  chunkStates: Array<'P' | 'B'>
}

export interface AuditDerivedMetrics {
  expectedTotalMinutes: number
  expectedBenchMinutes: number
  actualTotalMinutes: number
  actualBenchMinutes: number
  totalMinuteSpread: number
  benchMinuteSpread: number
  maxAllowedMinuteSpread: number
  allowedConsecutiveBenchWindowsPerPlayer: number
  allowedBenchStreakWindows: number
  allowedIsolatedPlayBlocksPerPlayer: number
  isolatedPlayBlockHardFlagThreshold: number
  isolatedPlayBlockHardFlagPlayerCount: number
  isolatedPlayBlockSeverity: 'ok' | 'warning' | 'flag'
  goalkeeperMinutesTotal: number
  playerMetrics: PlayerAuditMetrics[]
  playersWithConsecutiveBenchWindows: string[]
  playersWithExcessConsecutiveBenchWindows: string[]
  playersWithIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
  playersWithExcessIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
}

interface IsolatedPlayBlockPolicy {
  allowedIsolatedPlayBlocksPerPlayer: number
  hardFlagMinOverage: number
  hardFlagMinExcessPlayers: number
}

export interface AuditValidations {
  totalMinutesMatchExpected: boolean
  benchMinutesMatchExpected: boolean
  minuteSpreadWithinLimit: boolean
  benchSpreadWithinLimit: boolean
  lockedGoalkeepersRespected: boolean
  summaryMinutesConsistent: boolean
  uniqueGoalkeepersPerPeriod: boolean
  noConsecutiveBenchWindows: boolean
  noUnavailableLeaks: boolean
  liveFairnessWithinTolerance: boolean
  livePatternCompleted: boolean
  normalizedScoreMatchesPlan: boolean
  allPassed: boolean
}

export interface AuditInputSnapshot {
  scenarioId: string
  seed: number
  playerCount: number
  players: Player[]
  periodCount: number
  periodMinutes: number
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  chunkMinutes: number
  goalkeeperMode: GoalkeeperMode
  lockedGoalkeeperIds: Array<string | null>
  rosterOrder: RosterOrder
  liveAdjustmentPattern: LiveAdjustmentPattern
  attempts: number
}

interface BaseLiveAdjustmentAuditEvent {
  stepId: string
  period: number
  minute: number
  playerId: string
}

export interface LiveAvailabilityAuditEvent extends BaseLiveAdjustmentAuditEvent {
  type: Exclude<LiveAdjustmentEvent['type'], 'position-swap'>
  replacementPlayerId: string | null
}

export interface LivePositionSwapAuditEvent extends BaseLiveAdjustmentAuditEvent {
  type: 'position-swap'
  targetPlayerId: string | null
}

export type LiveAdjustmentAuditEvent =
  | LiveAvailabilityAuditEvent
  | LivePositionSwapAuditEvent

export interface LiveAdjustmentAudit {
  pattern: Exclude<LiveAdjustmentPattern, 'none'>
  events: LiveAdjustmentAuditEvent[]
  fairness: {
    maxAbsDeltaMinutes: number
    toleranceMinutes: number
  }
  unavailablePlayerIds: string[]
  completed: boolean
}

export interface GeneratedAuditRecord {
  schemaVersion: typeof LINEUP_AUDIT_SCHEMA_VERSION
  input: AuditInputSnapshot
  plan: MatchPlan
  scoreBreakdown: {
    normalized: ReturnType<typeof getPlanScoreBreakdown>
    legacy: ReturnType<typeof getPlanScoreBreakdown>
  }
  derivedMetrics: AuditDerivedMetrics
  validations: AuditValidations
  flags: AuditFlag[]
  liveAdjustment?: LiveAdjustmentAudit
}

export interface ScenarioAggregate {
  seedCount: number
  flaggedSeedCount: number
  validationFailureCount: number
  uniqueFlags: AuditFlag[]
  averageNormalizedScore: number
  averageLegacyScore: number
  averageMinuteSpread: number
  maxMinuteSpread: number
  averageBenchSpread: number
  maxBenchSpread: number
}

export function createAuditScenarios(filters: AuditScenarioFilters = {}): AuditScenario[] {
  const playerCounts = resolveFilter(DEFAULT_AUDIT_PLAYER_COUNTS, filters.playerCounts, 'spelarantal')
  const periodCounts = resolveFilter(DEFAULT_AUDIT_PERIOD_COUNTS, filters.periodCounts, 'periodantal')
  const periodMinutesValues = resolveFilter(
    DEFAULT_AUDIT_PERIOD_MINUTES,
    filters.periodMinutes,
    'periodminuter',
  )
  const formations = resolveFilter(DEFAULT_AUDIT_FORMATIONS, filters.formations, 'formationer')
  const substitutions = resolveFilter(
    SUBSTITUTIONS_PER_PERIOD_OPTIONS,
    filters.substitutions,
    'byten per period',
  )
  const goalkeeperModes = resolveFilter(
    DEFAULT_AUDIT_GOALKEEPER_MODES,
    filters.goalkeeperModes,
    'målvaktslägen',
  )
  const rosterOrders = resolveFilter(
    DEFAULT_AUDIT_ROSTER_ORDERS,
    filters.rosterOrders,
    'rosterordning',
  )
  const liveAdjustmentPatterns = filters.liveAdjustmentPatterns
    ? resolveFilter(ALL_AUDIT_LIVE_PATTERNS, filters.liveAdjustmentPatterns, 'livejusteringsmönster')
    : [...DEFAULT_AUDIT_LIVE_PATTERNS]

  const scenarios: AuditScenario[] = []

  for (const playerCount of playerCounts) {
    for (const periodCount of periodCounts) {
      for (const periodMinutes of periodMinutesValues) {
        for (const formation of formations) {
          for (const substitutionsPerPeriod of substitutions) {
            const chunkMinutes = getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod)
            for (const goalkeeperMode of goalkeeperModes) {
              for (const rosterOrder of rosterOrders) {
                for (const liveAdjustmentPattern of liveAdjustmentPatterns) {
                  if (!isLivePatternCompatible(liveAdjustmentPattern, periodCount)) {
                    continue
                  }

                  scenarios.push({
                    scenarioId: buildScenarioId({
                      playerCount,
                      periodCount,
                      periodMinutes,
                      formation,
                      substitutionsPerPeriod,
                      goalkeeperMode,
                      rosterOrder,
                      liveAdjustmentPattern,
                    }),
                    playerCount,
                    periodCount,
                    periodMinutes,
                    formation,
                    substitutionsPerPeriod,
                    chunkMinutes,
                    goalkeeperMode,
                    rosterOrder,
                    rosterNames: getRosterNames(playerCount, rosterOrder),
                    liveAdjustmentPattern,
                  })
                }
              }
            }
          }
        }
      }
    }
  }

  return scenarios
}

export function buildScenarioId({
  playerCount,
  periodCount,
  periodMinutes,
  formation,
  substitutionsPerPeriod,
  goalkeeperMode,
  rosterOrder,
  liveAdjustmentPattern,
}: {
  playerCount: number
  periodCount: number
  periodMinutes: number
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  goalkeeperMode: GoalkeeperMode
  rosterOrder: RosterOrder
  liveAdjustmentPattern: LiveAdjustmentPattern
}) {
  return [
    `players-${playerCount}`,
    `periods-${periodCount}`,
    `period-${periodMinutes}`,
    `formation-${formation}`,
    `subs-${substitutionsPerPeriod}`,
    `gk-${goalkeeperMode}`,
    `roster-${rosterOrder}`,
    `live-${liveAdjustmentPattern}`,
  ].join('_')
}

export function resolveLockedGoalkeeperIds(
  players: Player[],
  goalkeeperMode: GoalkeeperMode,
  periodCount: number,
) {
  const ids = Array.from({ length: periodCount }, () => null as string | null)

  switch (goalkeeperMode) {
    case 'auto':
      return ids
    case 'lock-period-1':
      ids[0] = players[0]?.id ?? null
      return ids
    case 'lock-period-1-and-last':
      ids[0] = players[0]?.id ?? null
      ids[periodCount - 1] = players[Math.min(periodCount - 1, players.length - 1)]?.id ?? null
      return ids
    case 'lock-all-periods':
      return ids.map((_, index) => players[index]?.id ?? null)
  }
}

export function generateAuditRecord(
  scenario: AuditScenario,
  seed: number,
  overrides: AuditRecordOverrides = {},
): GeneratedAuditRecord {
  const players = createNamedPlayers(scenario.playerCount, scenario.rosterOrder)
  const lockedGoalkeeperIds = resolveLockedGoalkeeperIds(
    players,
    scenario.goalkeeperMode,
    scenario.periodCount,
  )
  const attempts = resolveAttemptCount({
    players,
    periodCount: scenario.periodCount,
    periodMinutes: scenario.periodMinutes,
    chunkMinutes: scenario.chunkMinutes,
  })
  const plan = generateMatchPlan({
    players,
    periodCount: scenario.periodCount,
    periodMinutes: scenario.periodMinutes,
    formation: scenario.formation,
    chunkMinutes: scenario.chunkMinutes,
    lockedGoalkeeperIds,
    seed,
  })
  const liveResult =
    overrides.liveAdjustmentResult !== undefined
      ? overrides.liveAdjustmentResult
      : scenario.liveAdjustmentPattern === 'none'
        ? null
        : applyLiveAdjustmentPattern(plan, scenario.liveAdjustmentPattern)
  const auditedPlan = liveResult?.plan ?? plan
  const normalized = getPlanScoreBreakdown(auditedPlan, 'normalized')
  const legacy = getPlanScoreBreakdown(auditedPlan, 'legacy')
  const analysis = analyzeMatchPlan(auditedPlan, {
    playerCount: scenario.playerCount,
    chunkMinutes: scenario.chunkMinutes,
    lockedGoalkeeperIds,
  })

  return {
    schemaVersion: LINEUP_AUDIT_SCHEMA_VERSION,
    input: {
      scenarioId: scenario.scenarioId,
      seed,
      playerCount: scenario.playerCount,
      players,
      periodCount: scenario.periodCount,
      periodMinutes: scenario.periodMinutes,
      formation: scenario.formation,
      substitutionsPerPeriod: scenario.substitutionsPerPeriod,
      chunkMinutes: scenario.chunkMinutes,
      goalkeeperMode: scenario.goalkeeperMode,
      lockedGoalkeeperIds,
      rosterOrder: scenario.rosterOrder,
      liveAdjustmentPattern: scenario.liveAdjustmentPattern,
      attempts,
    },
    plan: auditedPlan,
    scoreBreakdown: {
      normalized,
      legacy,
    },
    derivedMetrics: analysis.derivedMetrics,
    validations: {
      ...analysis.validations,
      noUnavailableLeaks: liveResult?.noUnavailableLeaks ?? true,
      liveFairnessWithinTolerance: liveResult
        ? liveResult.liveAdjustment.fairness.maxAbsDeltaMinutes <=
        liveResult.liveAdjustment.fairness.toleranceMinutes + LIVE_ADJUSTMENT_EPSILON
        : true,
      livePatternCompleted: liveResult?.completed ?? true,
      normalizedScoreMatchesPlan: auditedPlan.score === normalized.totalScore,
      allPassed: false,
    },
    flags: [],
    liveAdjustment: liveResult?.liveAdjustment,
  }
}

export function finalizeAuditRecord(record: GeneratedAuditRecord): GeneratedAuditRecord {
  const validations: AuditValidations = {
    ...record.validations,
    allPassed: false,
  }
  const flags = buildFlags(record, validations)
  validations.allPassed = Object.entries(validations)
    .filter(([key]) => key !== 'allPassed')
    .every(([, value]) => value)

  return {
    ...record,
    validations,
    flags,
  }
}

export function createAuditRecord(
  scenario: AuditScenario,
  seed: number,
  overrides: AuditRecordOverrides = {},
) {
  return finalizeAuditRecord(generateAuditRecord(scenario, seed, overrides))
}

export function summarizeScenarioRecords(records: GeneratedAuditRecord[]): ScenarioAggregate {
  if (records.length === 0) {
    throw new Error('Kan inte summera ett tomt scenario.')
  }

  return {
    seedCount: records.length,
    flaggedSeedCount: records.filter((record) => record.flags.length > 0).length,
    validationFailureCount: records.filter((record) => !record.validations.allPassed).length,
    uniqueFlags: [...new Set(records.flatMap((record) => record.flags))].sort() as AuditFlag[],
    averageNormalizedScore: average(records.map((record) => record.scoreBreakdown.normalized.totalScore)),
    averageLegacyScore: average(records.map((record) => record.scoreBreakdown.legacy.totalScore)),
    averageMinuteSpread: average(records.map((record) => record.derivedMetrics.totalMinuteSpread)),
    maxMinuteSpread: Math.max(...records.map((record) => record.derivedMetrics.totalMinuteSpread)),
    averageBenchSpread: average(records.map((record) => record.derivedMetrics.benchMinuteSpread)),
    maxBenchSpread: Math.max(...records.map((record) => record.derivedMetrics.benchMinuteSpread)),
  }
}

export function analyzeMatchPlan(
  plan: MatchPlan,
  {
    playerCount,
    chunkMinutes,
    lockedGoalkeeperIds,
  }: {
    playerCount: number
    chunkMinutes: number
    lockedGoalkeeperIds: Array<string | null>
  },
) {
  const allChunks = plan.periods.flatMap((period) => period.chunks)
  const consecutiveBenchAllowance = getConsecutiveBenchAllowance(playerCount)
  const substitutionsPerPeriod = getSubstitutionsPerPeriod(plan.periodMinutes, chunkMinutes)
  const periodCount = plan.periods.length
  const isolatedPlayBlockPolicy = getIsolatedPlayBlockPolicy({
    playerCount,
    chunkMinutes,
    substitutionsPerPeriod,
  })
  const matchMinutes = periodCount * plan.periodMinutes
  const expectedTotalMinutes = periodCount * plan.periodMinutes * 7
  const expectedBenchMinutes = periodCount * plan.periodMinutes * (playerCount - 7)
  const actualTotalMinutes = roundAuditValue(
    plan.summaries.reduce((total, summary) => total + summary.totalMinutes, 0),
  )
  const actualBenchMinutes = roundAuditValue(
    plan.summaries.reduce((total, summary) => total + summary.benchMinutes, 0),
  )
  const totalMinutes = plan.summaries.map((summary) => summary.totalMinutes)
  const benchMinutes = plan.summaries.map((summary) => summary.benchMinutes)
  const trailingChunkMinutes = plan.periodMinutes % chunkMinutes || chunkMinutes
  const maxAllowedMinuteSpread = roundAuditValue(
    playerCount === 12 ? chunkMinutes + trailingChunkMinutes : chunkMinutes,
  )
  const playerMetrics = plan.summaries.map((summary) => buildPlayerAuditMetrics(summary, allChunks))
  const playersWithConsecutiveBenchWindows = playerMetrics
    .filter((metrics) => metrics.longestBenchStreakWindows >= 2)
    .map((metrics) => metrics.name)
  const playersWithExcessConsecutiveBenchWindows = playerMetrics
    .filter(
      (metrics) =>
        metrics.consecutiveBenchWindowCount > consecutiveBenchAllowance.allowedConsecutiveBenchWindowsPerPlayer ||
        metrics.longestBenchStreakWindows > consecutiveBenchAllowance.allowedBenchStreakWindows,
    )
    .map((metrics) => metrics.name)
  const playersWithIsolatedPlayBlocks = playerMetrics
    .filter((metrics) => metrics.isolatedPlayBlocks > 0)
    .map((metrics) => ({
      name: metrics.name,
      isolatedPlayBlocks: metrics.isolatedPlayBlocks,
    }))
  const playersWithExcessIsolatedPlayBlocks = playerMetrics
    .filter(
      (metrics) =>
        metrics.isolatedPlayBlocks > isolatedPlayBlockPolicy.allowedIsolatedPlayBlocksPerPlayer,
    )
    .map((metrics) => ({
      name: metrics.name,
      isolatedPlayBlocks: metrics.isolatedPlayBlocks,
    }))
  const lockedGoalkeepersRespected = lockedGoalkeeperIds.every(
    (goalkeeperId, periodIndex) =>
      goalkeeperId === null || plan.periods[periodIndex]?.goalkeeperId === goalkeeperId,
  )
  const summaryMinutesConsistent = plan.summaries.every(
    (summary) => isWithinMinuteTolerance(summary.totalMinutes + summary.benchMinutes, matchMinutes),
  )
  const totalMinuteSpread = roundAuditValue(Math.max(...totalMinutes) - Math.min(...totalMinutes))
  const benchMinuteSpread = roundAuditValue(Math.max(...benchMinutes) - Math.min(...benchMinutes))
  const isolatedPlayBlockSeverity = classifyIsolatedPlayBlockSeverity({
    playersWithExcessIsolatedPlayBlocks,
    policy: isolatedPlayBlockPolicy,
    totalMinuteSpread,
    benchMinuteSpread,
    maxAllowedMinuteSpread,
  })

  return {
    derivedMetrics: {
      expectedTotalMinutes,
      expectedBenchMinutes,
      actualTotalMinutes,
      actualBenchMinutes,
      totalMinuteSpread,
      benchMinuteSpread,
      maxAllowedMinuteSpread,
      allowedConsecutiveBenchWindowsPerPlayer:
        consecutiveBenchAllowance.allowedConsecutiveBenchWindowsPerPlayer,
      allowedBenchStreakWindows: consecutiveBenchAllowance.allowedBenchStreakWindows,
      allowedIsolatedPlayBlocksPerPlayer:
        isolatedPlayBlockPolicy.allowedIsolatedPlayBlocksPerPlayer,
      isolatedPlayBlockHardFlagThreshold:
        isolatedPlayBlockPolicy.allowedIsolatedPlayBlocksPerPlayer +
        isolatedPlayBlockPolicy.hardFlagMinOverage,
      isolatedPlayBlockHardFlagPlayerCount: isolatedPlayBlockPolicy.hardFlagMinExcessPlayers,
      isolatedPlayBlockSeverity,
      goalkeeperMinutesTotal: playerMetrics.reduce(
        (total, metrics) => total + metrics.goalkeeperMinutes,
        0,
      ),
      playerMetrics,
      playersWithConsecutiveBenchWindows,
      playersWithExcessConsecutiveBenchWindows,
      playersWithIsolatedPlayBlocks,
      playersWithExcessIsolatedPlayBlocks,
    } satisfies AuditDerivedMetrics,
    validations: {
      totalMinutesMatchExpected: isWithinMinuteTolerance(actualTotalMinutes, expectedTotalMinutes),
      benchMinutesMatchExpected: isWithinMinuteTolerance(actualBenchMinutes, expectedBenchMinutes),
      minuteSpreadWithinLimit: totalMinuteSpread <= maxAllowedMinuteSpread + MINUTE_TOLERANCE,
      benchSpreadWithinLimit: benchMinuteSpread <= maxAllowedMinuteSpread + MINUTE_TOLERANCE,
      lockedGoalkeepersRespected,
      summaryMinutesConsistent,
      uniqueGoalkeepersPerPeriod: new Set(plan.goalkeepers).size === plan.goalkeepers.length,
      noConsecutiveBenchWindows: playersWithExcessConsecutiveBenchWindows.length === 0,
      noUnavailableLeaks: true,
      liveFairnessWithinTolerance: true,
      livePatternCompleted: true,
      normalizedScoreMatchesPlan: false,
      allPassed: false,
    } satisfies AuditValidations,
  }
}

function getConsecutiveBenchAllowance(playerCount: number) {
  const allowedConsecutiveBenchWindowsPerPlayer = Math.max(playerCount - 10, 0)
  const allowedBenchStreakWindows = 1 + Math.min(allowedConsecutiveBenchWindowsPerPlayer, 1)

  return {
    allowedConsecutiveBenchWindowsPerPlayer,
    allowedBenchStreakWindows,
  }
}

function getIsolatedPlayBlockPolicy({
  playerCount,
  chunkMinutes,
  substitutionsPerPeriod,
}: {
  playerCount: number
  chunkMinutes: number
  substitutionsPerPeriod: SubstitutionsPerPeriod
}): IsolatedPlayBlockPolicy {
  const baseAllowance = Math.min(Math.max(playerCount - 7, 2), 3)
  const isDenseHighRotationCohort =
    playerCount >= 11 &&
    substitutionsPerPeriod >= 4 &&
    chunkMinutes <= 5 + MINUTE_TOLERANCE

  return {
    allowedIsolatedPlayBlocksPerPlayer: baseAllowance,
    hardFlagMinOverage: isDenseHighRotationCohort ? 2 : 1,
    hardFlagMinExcessPlayers: isDenseHighRotationCohort ? 3 : 1,
  }
}

function classifyIsolatedPlayBlockSeverity({
  playersWithExcessIsolatedPlayBlocks,
  policy,
  totalMinuteSpread,
  benchMinuteSpread,
  maxAllowedMinuteSpread,
}: {
  playersWithExcessIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
  policy: IsolatedPlayBlockPolicy
  totalMinuteSpread: number
  benchMinuteSpread: number
  maxAllowedMinuteSpread: number
}): 'ok' | 'warning' | 'flag' {
  if (playersWithExcessIsolatedPlayBlocks.length === 0) {
    return 'ok'
  }

  const maxOverage = Math.max(
    ...playersWithExcessIsolatedPlayBlocks.map(
      ({ isolatedPlayBlocks }) =>
        isolatedPlayBlocks - policy.allowedIsolatedPlayBlocksPerPlayer,
    ),
  )
  const fairnessDrifted =
    totalMinuteSpread > maxAllowedMinuteSpread + MINUTE_TOLERANCE ||
    benchMinuteSpread > maxAllowedMinuteSpread + MINUTE_TOLERANCE

  if (
    maxOverage >= policy.hardFlagMinOverage ||
    playersWithExcessIsolatedPlayBlocks.length >= policy.hardFlagMinExcessPlayers ||
    fairnessDrifted
  ) {
    return 'flag'
  }

  return 'warning'
}

function buildPlayerAuditMetrics(
  summary: PlayerSummary,
  chunks: MatchPlan['periods'][number]['chunks'],
): PlayerAuditMetrics {
  const chunkStates = chunks.map((chunk) => (chunk.activePlayerIds.includes(summary.playerId) ? 'P' : 'B'))
  const goalkeeperMinutes = chunks.reduce(
    (total, chunk) => total + (chunk.goalkeeperId === summary.playerId ? chunk.durationMinutes : 0),
    0,
  )
  const playStreak = getLongestStreak(chunkStates, chunks, 'P')
  const benchStreak = getLongestStreak(chunkStates, chunks, 'B')

  return {
    playerId: summary.playerId,
    name: summary.name,
    totalMinutes: summary.totalMinutes,
    benchMinutes: summary.benchMinutes,
    goalkeeperMinutes,
    outfieldMinutes: Math.max(summary.totalMinutes - goalkeeperMinutes, 0),
    goalkeeperPeriods: summary.goalkeeperPeriods,
    positionsPlayed: summary.positionsPlayed,
    roleGroups: summary.roleGroups,
    isolatedPlayBlocks: countIsolatedPlayBlocks(chunkStates),
    longestPlayStreakWindows: playStreak.windows,
    longestPlayStreakMinutes: playStreak.minutes,
    longestBenchStreakWindows: benchStreak.windows,
    longestBenchStreakMinutes: benchStreak.minutes,
    consecutiveBenchWindowCount: countConsecutiveBenchWindows(chunkStates),
    chunkStates,
  }
}

function getLongestStreak(
  states: Array<'P' | 'B'>,
  chunks: MatchPlan['periods'][number]['chunks'],
  target: 'P' | 'B',
) {
  let longestWindows = 0
  let longestMinutes = 0
  let currentWindows = 0
  let currentMinutes = 0

  for (const [index, state] of states.entries()) {
    if (state === target) {
      currentWindows += 1
      currentMinutes += chunks[index]?.durationMinutes ?? 0
      if (
        currentWindows > longestWindows ||
        (currentWindows === longestWindows && currentMinutes > longestMinutes)
      ) {
        longestWindows = currentWindows
        longestMinutes = currentMinutes
      }
      continue
    }

    currentWindows = 0
    currentMinutes = 0
  }

  return {
    windows: longestWindows,
    minutes: longestMinutes,
  }
}

function countIsolatedPlayBlocks(states: Array<'P' | 'B'>) {
  let count = 0

  for (let index = 0; index < states.length; index += 1) {
    const isIsolatedPlayWindow =
      states[index] === 'P' && states[index - 1] !== 'P' && states[index + 1] !== 'P'

    if (isIsolatedPlayWindow) {
      count += 1
    }
  }

  return count
}

function countConsecutiveBenchWindows(states: Array<'P' | 'B'>) {
  let count = 0

  for (let index = 1; index < states.length; index += 1) {
    if (states[index - 1] === 'B' && states[index] === 'B') {
      count += 1
    }
  }

  return count
}

function buildFlags(record: GeneratedAuditRecord, validations: AuditValidations) {
  const flags: AuditFlag[] = []

  if (!validations.totalMinutesMatchExpected) {
    flags.push('total-minutes-mismatch')
  }
  if (!validations.benchMinutesMatchExpected) {
    flags.push('bench-minutes-mismatch')
  }
  if (!validations.minuteSpreadWithinLimit) {
    flags.push('minute-spread-over-limit')
  }
  if (!validations.benchSpreadWithinLimit) {
    flags.push('bench-spread-over-limit')
  }
  if (!validations.noConsecutiveBenchWindows) {
    flags.push('consecutive-bench')
  }
  if (!validations.lockedGoalkeepersRespected) {
    flags.push('goalkeeper-lock-mismatch')
  }
  if (!validations.summaryMinutesConsistent) {
    flags.push('summary-minutes-mismatch')
  }
  if (!validations.uniqueGoalkeepersPerPeriod) {
    flags.push('duplicate-goalkeepers')
  }
  if (!validations.normalizedScoreMatchesPlan) {
    flags.push('score-mismatch')
  }
  if (!validations.noUnavailableLeaks) {
    flags.push('unavailable-player-leak')
  }
  if (!validations.liveFairnessWithinTolerance) {
    flags.push('live-fairness-exceeded')
  }
  if (!validations.livePatternCompleted) {
    flags.push('live-pattern-incomplete')
  }
  if (record.derivedMetrics.isolatedPlayBlockSeverity === 'flag') {
    flags.push('isolated-play-blocks')
  }

  return flags
}

type LivePatternTarget =
  | {
    type: 'first-active-outfielder'
  }
  | {
    type: 'first-continuing-active-outfielder'
  }
  | {
    type: 'second-active-outfielder'
  }
  | {
    type: 'active-goalkeeper'
  }
  | {
    type: 'first-available-bench-player'
  }
  | {
    type: 'previous-result'
    stepId: string
    field: 'playerId' | 'replacementPlayerId' | 'targetPlayerId'
  }

interface LiveAvailabilityPatternStep {
  id: string
  type: Exclude<LiveAdjustmentEvent['type'], 'position-swap'>
  period: number
  minute: number
  target: LivePatternTarget
}

interface LivePositionSwapPatternStep {
  id: string
  type: 'position-swap'
  period: number
  minute: number
  target: LivePatternTarget
  swapTarget: LivePatternTarget
}

type LivePatternStep = LiveAvailabilityPatternStep | LivePositionSwapPatternStep

type LivePatternStepResult =
  | {
    type: Exclude<LiveAdjustmentEvent['type'], 'position-swap'>
    playerId: string
    replacementPlayerId: string | null
    targetPlayerId?: never
  }
  | {
    type: 'position-swap'
    playerId: string
    replacementPlayerId?: never
    targetPlayerId: string | null
  }

interface AppliedLiveAdjustmentPattern {
  plan: MatchPlan
  noUnavailableLeaks: boolean
  completed: boolean
  liveAdjustment: LiveAdjustmentAudit
}

// Narrow seam used by tests to verify audit handling of edge-case live results.
export interface AuditRecordOverrides {
  liveAdjustmentResult?: {
    plan: MatchPlan
    noUnavailableLeaks: boolean
    completed: boolean
    liveAdjustment: LiveAdjustmentAudit
  } | null
}

function applyLiveAdjustmentPattern(
  plan: MatchPlan,
  pattern: Exclude<LiveAdjustmentPattern, 'none'>,
): AppliedLiveAdjustmentPattern {
  const steps = getLivePatternSteps(pattern)
  const stepResults: Record<string, LivePatternStepResult> = {}
  const events: LiveAdjustmentAuditEvent[] = []
  let currentPlan = plan
  let availability = createInitialAvailabilityState(plan)
  let noUnavailableLeaks = true
  let completed = true

  for (const step of steps) {
    const targetPlayerId = resolveLivePatternTargetPlayerId(
      currentPlan,
      step,
      stepResults,
      availability,
    )
    if (step.type === 'position-swap') {
      const swapTargetPlayerId = resolveLivePatternTargetPlayerId(
        currentPlan,
        step,
        stepResults,
        availability,
        step.swapTarget,
      )

      try {
        const next = replanMatchFromLiveEvent({
          availability,
          event: {
            type: 'position-swap',
            minute: step.minute,
            period: step.period,
            playerId: targetPlayerId,
            targetPlayerId: swapTargetPlayerId,
          },
          plan: currentPlan,
        })

        currentPlan = next.plan
        availability = next.availability
        events.push({
          stepId: step.id,
          type: step.type,
          period: step.period,
          minute: step.minute,
          playerId: targetPlayerId,
          targetPlayerId: swapTargetPlayerId,
        })
        stepResults[step.id] = {
          type: step.type,
          playerId: targetPlayerId,
          targetPlayerId: swapTargetPlayerId,
        }
      } catch {
        events.push({
          stepId: step.id,
          type: step.type,
          period: step.period,
          minute: step.minute,
          playerId: targetPlayerId,
          targetPlayerId: null,
        })
        stepResults[step.id] = {
          type: step.type,
          playerId: targetPlayerId,
          targetPlayerId: null,
        }
        completed = false
        break
      }

      continue
    }

    const selectedRecommendation = getLiveRecommendations({
      availability,
      minute: step.minute,
      period: step.period,
      plan: currentPlan,
      playerId: targetPlayerId,
      type: step.type,
    })[0]

    if (!selectedRecommendation) {
      events.push({
        stepId: step.id,
        type: step.type,
        period: step.period,
        minute: step.minute,
        playerId: targetPlayerId,
        replacementPlayerId: null,
      })
      stepResults[step.id] = {
        type: step.type,
        playerId: targetPlayerId,
        replacementPlayerId: null,
      }
      completed = false
      break
    }

    const next =
      step.type === 'return'
        ? replanMatchFromLiveEvent({
          availability,
          event: {
            type: 'return',
            minute: step.minute,
            period: step.period,
            playerId: targetPlayerId,
            replacementPlayerId: selectedRecommendation.playerId,
          },
          plan: currentPlan,
        })
        : replanMatchFromLiveEvent({
          availability,
          event: {
            type: step.type,
            minute: step.minute,
            period: step.period,
            playerId: targetPlayerId,
            replacementPlayerId: selectedRecommendation.playerId,
            status: step.type === 'injury' ? 'injured' : 'temporarily-out',
          },
          plan: currentPlan,
        })

    if (step.type !== 'return') {
      noUnavailableLeaks =
        noUnavailableLeaks &&
        !isPlayerActiveFromMinute(next.plan, step.period, step.minute, targetPlayerId)
    }

    currentPlan = next.plan
    availability = next.availability
    events.push({
      stepId: step.id,
      type: step.type,
      period: step.period,
      minute: step.minute,
      playerId: targetPlayerId,
      replacementPlayerId: selectedRecommendation.playerId,
    })
    stepResults[step.id] = {
      type: step.type,
      playerId: targetPlayerId,
      replacementPlayerId: selectedRecommendation.playerId,
    }
  }

  return {
    plan: currentPlan,
    noUnavailableLeaks,
    completed,
    liveAdjustment: {
      pattern,
      events,
      fairness: buildLiveAdjustmentFairness(currentPlan),
      unavailablePlayerIds: currentPlan.summaries
        .filter((summary) => availability[summary.playerId] !== 'available')
        .map((summary) => summary.playerId),
      completed,
    },
  }
}

function getLivePatternSteps(
  pattern: Exclude<LiveAdjustmentPattern, 'none'>,
): LivePatternStep[] {
  switch (pattern) {
    case 'single-temporary-out':
      return [
        {
          id: 'single-out',
          type: 'temporary-out',
          period: 2,
          minute: 10,
          target: { type: 'first-active-outfielder' },
        },
      ]
    case 'quick-return':
      return [
        {
          id: 'quick-out',
          type: 'temporary-out',
          period: 1,
          minute: 6,
          target: { type: 'first-active-outfielder' },
        },
        {
          id: 'quick-return',
          type: 'return',
          period: 1,
          minute: 9,
          target: { type: 'previous-result', stepId: 'quick-out', field: 'playerId' },
        },
      ]
    case 'injury-mid-match':
      return [
        {
          id: 'injury-out',
          type: 'injury',
          period: 2,
          minute: 9,
          target: { type: 'first-active-outfielder' },
        },
      ]
    case 'double-temporary-out':
      return [
        {
          id: 'double-out-1',
          type: 'temporary-out',
          period: 2,
          minute: 5,
          target: { type: 'first-active-outfielder' },
        },
        {
          id: 'double-out-2',
          type: 'temporary-out',
          period: 2,
          minute: 7,
          target: { type: 'first-active-outfielder' },
        },
      ]
    case 'cross-period-return':
      return [
        {
          id: 'cross-period-out',
          type: 'temporary-out',
          period: 1,
          minute: 5,
          target: { type: 'first-active-outfielder' },
        },
        {
          id: 'cross-period-return',
          type: 'return',
          period: 3,
          minute: 10,
          target: { type: 'previous-result', stepId: 'cross-period-out', field: 'playerId' },
        },
      ]
    case 'position-swap-outfield':
      return [
        {
          id: 'swap-outfield',
          type: 'position-swap',
          period: 2,
          minute: 10,
          target: { type: 'first-active-outfielder' },
          swapTarget: { type: 'second-active-outfielder' },
        },
      ]
    case 'position-swap-goalkeeper':
      return [
        {
          id: 'swap-goalkeeper',
          type: 'position-swap',
          period: 2,
          minute: 10,
          target: { type: 'first-active-outfielder' },
          swapTarget: { type: 'active-goalkeeper' },
        },
      ]
    case 'position-swap-bench':
      return [
        {
          id: 'swap-bench',
          type: 'position-swap',
          period: 2,
          minute: 10,
          target: { type: 'first-continuing-active-outfielder' },
          swapTarget: { type: 'first-available-bench-player' },
        },
      ]
  }

  const exhaustivePattern: never = pattern
  throw new Error(`Okänt livejusteringsmönster: ${exhaustivePattern}`)
}

function resolveLivePatternTargetPlayerId(
  plan: MatchPlan,
  step: LivePatternStep,
  stepResults: Record<string, LivePatternStepResult>,
  availability: Record<string, 'available' | 'injured' | 'temporarily-out'>,
  targetOverride?: LivePatternTarget,
) {
  const target = targetOverride ?? step.target

  if (target.type === 'previous-result') {
    const previous = stepResults[target.stepId]

    if (!previous) {
      throw new Error(`Saknar tidigare livejusteringssteg ${target.stepId}.`)
    }

    const targetPlayerId = previous[target.field]

    if (!targetPlayerId) {
      throw new Error(`Saknar spelarreferens för livejusteringssteget ${step.id}.`)
    }

    return targetPlayerId
  }

  const chunk = resolveLivePatternChunkAtMinute(plan, step.period, step.minute)?.chunk

  if (!chunk) {
    throw new Error(`Saknar aktivt byteblock för livejusteringssteget ${step.id}.`)
  }

  switch (target.type) {
    case 'first-active-outfielder':
      return getOutfieldPlayerIdByIndex(chunk, plan, 0)
    case 'first-continuing-active-outfielder':
      return getContinuingOutfieldPlayerId(chunk, plan, step.period, step.minute)
    case 'second-active-outfielder':
      return getOutfieldPlayerIdByIndex(chunk, plan, 1)
    case 'active-goalkeeper':
      return chunk.goalkeeperId
    case 'first-available-bench-player':
      return getFirstAvailableBenchPlayerId(chunk, plan, availability, step.id)
  }
}

function resolveLivePatternChunkAtMinute(plan: MatchPlan, period: number, minute: number) {
  const currentPeriod = plan.periods[period - 1]

  if (!currentPeriod) {
    return null
  }

  return resolveChunkAtMinute(currentPeriod, minute)
}

function getOutfieldPlayerIdByIndex(
  chunk: MatchPlan['periods'][number]['chunks'][number],
  plan: MatchPlan,
  targetIndex: number,
) {
  let currentIndex = 0

  for (const position of plan.positions) {
    const playerId = chunk.lineup[position]

    if (playerId) {
      if (currentIndex === targetIndex) {
        return playerId
      }

      currentIndex += 1
    }
  }

  throw new Error('Hittade inte tillräckligt många aktiva utespelare i byteblocket.')
}

function getContinuingOutfieldPlayerId(
  chunk: MatchPlan['periods'][number]['chunks'][number],
  plan: MatchPlan,
  period: number,
  minute: number,
) {
  const resolved = resolveLivePatternChunkAtMinute(plan, period, minute)
  const previousChunk =
    resolved && resolved.chunkIndex > 0 ? plan.periods[period - 1]?.chunks[resolved.chunkIndex - 1] : null
  const previousActivePlayerIds = new Set(previousChunk?.activePlayerIds ?? [])

  for (const position of plan.positions) {
    const playerId = chunk.lineup[position]

    if (playerId && previousActivePlayerIds.has(playerId)) {
      return playerId
    }
  }

  return getOutfieldPlayerIdByIndex(chunk, plan, 0)
}

function getFirstAvailableBenchPlayerId(
  chunk: MatchPlan['periods'][number]['chunks'][number],
  plan: MatchPlan,
  availability: Record<string, 'available' | 'injured' | 'temporarily-out'>,
  stepId: string,
) {
  const benchPlayerId = plan.summaries
    .map((summary) => summary.playerId)
    .find(
      (playerId) =>
        !chunk.activePlayerIds.includes(playerId) && availability[playerId] === 'available',
    )

  if (!benchPlayerId) {
    throw new Error(`Hittade ingen tillgänglig bänkspelare för livejusteringssteget ${stepId}.`)
  }

  return benchPlayerId
}

function isPlayerActiveFromMinute(plan: MatchPlan, period: number, minute: number, playerId: string) {
  return plan.periods
    .flatMap((currentPeriod) => currentPeriod.chunks)
    .filter(
      (chunk) =>
        chunk.period > period ||
        (chunk.period === period && chunk.startMinute >= minute - LIVE_ADJUSTMENT_EPSILON),
    )
    .some((chunk) => chunk.activePlayerIds.includes(playerId))
}

function buildLiveAdjustmentFairness(plan: MatchPlan) {
  return {
    maxAbsDeltaMinutes: roundAuditValue(
      Math.max(
        ...plan.summaries.map((summary) =>
          Math.abs(summary.totalMinutes - plan.fairnessTargets[summary.playerId]),
        ),
      ),
    ),
    toleranceMinutes: roundAuditValue(plan.chunkMinutes + LIVE_ADJUSTMENT_TOLERANCE_OFFSET),
  }
}

function getMinimumPeriodCountForLivePattern(pattern: LiveAdjustmentPattern) {
  switch (pattern) {
    case 'none':
      return 1
    case 'quick-return':
      return 1
    case 'single-temporary-out':
    case 'injury-mid-match':
    case 'double-temporary-out':
    case 'position-swap-outfield':
    case 'position-swap-goalkeeper':
    case 'position-swap-bench':
      return 2
    case 'cross-period-return':
      return 3
  }
}

function isLivePatternCompatible(pattern: LiveAdjustmentPattern, periodCount: number) {
  return periodCount >= getMinimumPeriodCountForLivePattern(pattern)
}

function average(values: number[]) {
  return roundAuditValue(values.reduce((total, value) => total + value, 0) / values.length)
}

function roundAuditValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function isWithinMinuteTolerance(left: number, right: number) {
  return Math.abs(left - right) <= MINUTE_TOLERANCE
}

function resolveFilter<const T extends string | number>(
  defaults: readonly T[],
  requested: readonly T[] | undefined,
  label: string,
) {
  if (!requested || requested.length === 0) {
    return [...defaults]
  }

  const requestedSet = new Set(requested)
  const invalid = requested.filter((value) => !defaults.includes(value))

  if (invalid.length > 0) {
    throw new Error(`Ogiltiga värden för ${label}: ${invalid.join(', ')}`)
  }

  return defaults.filter((value) => requestedSet.has(value))
}
