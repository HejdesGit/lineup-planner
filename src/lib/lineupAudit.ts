import { getPlanScoreBreakdown, generateMatchPlan, resolveAttemptCount } from './scheduler'
import { createNamedPlayers, getRosterNames, type RosterOrder } from './playerPool'
import {
  SUBSTITUTIONS_PER_PERIOD_OPTIONS,
  getChunkMinutesForSubstitutions,
  type SubstitutionsPerPeriod,
} from './substitutions'
import {
  PERIOD_COUNT,
  type FormationKey,
  type MatchPlan,
  type Player,
  type PlayerSummary,
} from './types'

export const DEFAULT_AUDIT_PLAYER_COUNTS = [8, 9, 10, 11, 12] as const
export const DEFAULT_AUDIT_PERIOD_MINUTES = [15, 20] as const
export const DEFAULT_AUDIT_FORMATIONS = ['2-3-1', '3-2-1'] as const
export const DEFAULT_AUDIT_GOALKEEPER_MODES = [
  'auto',
  'lock-period-1',
  'lock-period-1-and-3',
  'lock-all-3',
] as const
export const DEFAULT_AUDIT_ROSTER_ORDERS = ['canonical', 'reversed'] as const
export const DEFAULT_AUDIT_SEEDS = [1, 7, 19, 42, 99] as const
export const LINEUP_AUDIT_SCHEMA_VERSION = 1 as const
const MINUTE_TOLERANCE = 0.001

export type GoalkeeperMode = (typeof DEFAULT_AUDIT_GOALKEEPER_MODES)[number]
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

export interface AuditScenario {
  scenarioId: string
  playerCount: number
  periodMinutes: 15 | 20
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  chunkMinutes: number
  goalkeeperMode: GoalkeeperMode
  rosterOrder: RosterOrder
  rosterNames: string[]
}

export interface AuditScenarioFilters {
  playerCounts?: readonly number[]
  periodMinutes?: ReadonlyArray<15 | 20>
  formations?: readonly FormationKey[]
  substitutions?: readonly SubstitutionsPerPeriod[]
  goalkeeperModes?: readonly GoalkeeperMode[]
  rosterOrders?: readonly RosterOrder[]
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
  goalkeeperMinutesTotal: number
  playerMetrics: PlayerAuditMetrics[]
  playersWithConsecutiveBenchWindows: string[]
  playersWithExcessConsecutiveBenchWindows: string[]
  playersWithIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
  playersWithExcessIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
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
  normalizedScoreMatchesPlan: boolean
  allPassed: boolean
}

export interface AuditInputSnapshot {
  scenarioId: string
  seed: number
  playerCount: number
  players: Player[]
  periodMinutes: 15 | 20
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  chunkMinutes: number
  goalkeeperMode: GoalkeeperMode
  lockedGoalkeeperIds: Array<string | null>
  rosterOrder: RosterOrder
  attempts: number
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

  const scenarios: AuditScenario[] = []

  for (const playerCount of playerCounts) {
    for (const periodMinutes of periodMinutesValues) {
      for (const formation of formations) {
        for (const substitutionsPerPeriod of substitutions) {
          const chunkMinutes = getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod)
          for (const goalkeeperMode of goalkeeperModes) {
            for (const rosterOrder of rosterOrders) {
              scenarios.push({
                scenarioId: buildScenarioId({
                  playerCount,
                  periodMinutes,
                  formation,
                  substitutionsPerPeriod,
                  goalkeeperMode,
                  rosterOrder,
                }),
                playerCount,
                periodMinutes,
                formation,
                substitutionsPerPeriod,
                chunkMinutes,
                goalkeeperMode,
                rosterOrder,
                rosterNames: getRosterNames(playerCount, rosterOrder),
              })
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
  periodMinutes,
  formation,
  substitutionsPerPeriod,
  goalkeeperMode,
  rosterOrder,
}: {
  playerCount: number
  periodMinutes: 15 | 20
  formation: FormationKey
  substitutionsPerPeriod: SubstitutionsPerPeriod
  goalkeeperMode: GoalkeeperMode
  rosterOrder: RosterOrder
}) {
  return [
    `players-${playerCount}`,
    `period-${periodMinutes}`,
    `formation-${formation}`,
    `subs-${substitutionsPerPeriod}`,
    `gk-${goalkeeperMode}`,
    `roster-${rosterOrder}`,
  ].join('_')
}

export function resolveLockedGoalkeeperIds(players: Player[], goalkeeperMode: GoalkeeperMode) {
  switch (goalkeeperMode) {
    case 'auto':
      return [null, null, null]
    case 'lock-period-1':
      return [players[0]?.id ?? null, null, null]
    case 'lock-period-1-and-3':
      return [players[0]?.id ?? null, null, players[2]?.id ?? null]
    case 'lock-all-3':
      return [players[0]?.id ?? null, players[1]?.id ?? null, players[2]?.id ?? null]
  }
}

export function generateAuditRecord(
  scenario: AuditScenario,
  seed: number,
): GeneratedAuditRecord {
  const players = createNamedPlayers(scenario.playerCount, scenario.rosterOrder)
  const lockedGoalkeeperIds = resolveLockedGoalkeeperIds(players, scenario.goalkeeperMode)
  const attempts = resolveAttemptCount({
    players,
    periodMinutes: scenario.periodMinutes,
    chunkMinutes: scenario.chunkMinutes,
  })
  const plan = generateMatchPlan({
    players,
    periodMinutes: scenario.periodMinutes,
    formation: scenario.formation,
    chunkMinutes: scenario.chunkMinutes,
    lockedGoalkeeperIds,
    seed,
  })
  const normalized = getPlanScoreBreakdown(plan, 'normalized')
  const legacy = getPlanScoreBreakdown(plan, 'legacy')
  const analysis = analyzeMatchPlan(plan, {
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
      periodMinutes: scenario.periodMinutes,
      formation: scenario.formation,
      substitutionsPerPeriod: scenario.substitutionsPerPeriod,
      chunkMinutes: scenario.chunkMinutes,
      goalkeeperMode: scenario.goalkeeperMode,
      lockedGoalkeeperIds,
      rosterOrder: scenario.rosterOrder,
      attempts,
    },
    plan,
    scoreBreakdown: {
      normalized,
      legacy,
    },
    derivedMetrics: analysis.derivedMetrics,
    validations: {
      ...analysis.validations,
      normalizedScoreMatchesPlan: plan.score === normalized.totalScore,
      allPassed: false,
    },
    flags: [],
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

export function createAuditRecord(scenario: AuditScenario, seed: number) {
  return finalizeAuditRecord(generateAuditRecord(scenario, seed))
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
  const isolatedPlayBlockAllowance = getIsolatedPlayBlockAllowance(playerCount)
  const matchMinutes = PERIOD_COUNT * plan.periodMinutes
  const expectedTotalMinutes = PERIOD_COUNT * plan.periodMinutes * 7
  const expectedBenchMinutes = PERIOD_COUNT * plan.periodMinutes * (playerCount - 7)
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
    .filter((metrics) => metrics.isolatedPlayBlocks > isolatedPlayBlockAllowance)
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
      allowedIsolatedPlayBlocksPerPlayer: isolatedPlayBlockAllowance,
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

function getIsolatedPlayBlockAllowance(playerCount: number) {
  return Math.min(Math.max(playerCount - 7, 2), 3)
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
  if (record.derivedMetrics.playersWithExcessIsolatedPlayBlocks.length > 0) {
    flags.push('isolated-play-blocks')
  }

  return flags
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
