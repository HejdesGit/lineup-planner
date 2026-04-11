export const SUBSTITUTIONS_PER_PERIOD_OPTIONS = [2, 3, 4, 5] as const

export type SubstitutionsPerPeriod = (typeof SUBSTITUTIONS_PER_PERIOD_OPTIONS)[number]

export function getSupportedSubstitutionsPerPeriodOptions(periodMinutes: number): readonly SubstitutionsPerPeriod[] {
  return periodMinutes === 25
    ? SUBSTITUTIONS_PER_PERIOD_OPTIONS
    : SUBSTITUTIONS_PER_PERIOD_OPTIONS.filter((substitutionsPerPeriod) => substitutionsPerPeriod !== 5)
}

export function getChunkMinutesForSubstitutions(
  periodMinutes: number,
  substitutionsPerPeriod: SubstitutionsPerPeriod,
) {
  return periodMinutes / substitutionsPerPeriod
}

export function areMinuteValuesEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.001
}

export function getSubstitutionsPerPeriod(periodMinutes: number, chunkMinutes: number) {
  const match = getSupportedSubstitutionsPerPeriodOptions(periodMinutes).find((substitutionsPerPeriod) =>
    areMinuteValuesEqual(getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod), chunkMinutes),
  )

  return match ?? 2
}
