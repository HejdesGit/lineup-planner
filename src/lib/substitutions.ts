export const SUBSTITUTIONS_PER_PERIOD_OPTIONS = [2, 3, 4] as const

export type SubstitutionsPerPeriod = (typeof SUBSTITUTIONS_PER_PERIOD_OPTIONS)[number]

export const SUBSTITUTIONS_PER_PERIOD_TO_CHUNK_MINUTES = {
  15: {
    2: 7.5,
    3: 5,
    4: 3.75,
  },
  20: {
    2: 10,
    3: 20 / 3,
    4: 5,
  },
} as const

export function getChunkMinutesForSubstitutions(
  periodMinutes: 15 | 20,
  substitutionsPerPeriod: SubstitutionsPerPeriod,
) {
  return SUBSTITUTIONS_PER_PERIOD_TO_CHUNK_MINUTES[periodMinutes][substitutionsPerPeriod]
}

export function areMinuteValuesEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.001
}

export function getSubstitutionsPerPeriod(periodMinutes: 15 | 20, chunkMinutes: number) {
  const match = SUBSTITUTIONS_PER_PERIOD_OPTIONS.find((substitutionsPerPeriod) =>
    areMinuteValuesEqual(getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod), chunkMinutes),
  )

  return match ?? 2
}
