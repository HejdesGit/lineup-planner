export const PERIOD_COUNT = 3
export const FORMATION_PRESETS = {
  '2-3-1': {
    label: '2-3-1',
    positions: ['VB', 'HB', 'VM', 'CM', 'HM', 'A'] as const,
    rows: [['A'], ['VM', 'CM', 'HM'], ['VB', 'HB']] as const,
  },
  '3-2-1': {
    label: '3-2-1',
    positions: ['VB', 'CB', 'HB', 'VM', 'HM', 'A'] as const,
    rows: [['A'], ['VM', 'HM'], ['VB', 'CB', 'HB']] as const,
  },
} as const

export const ALL_POSITIONS = ['VB', 'CB', 'HB', 'VM', 'CM', 'HM', 'A'] as const
export const ROLE_GROUPS = {
  VB: 'DEF',
  CB: 'DEF',
  HB: 'DEF',
  VM: 'MID',
  CM: 'MID',
  HM: 'MID',
  A: 'ATT',
} as const

export type FormationKey = keyof typeof FORMATION_PRESETS
export type OutfieldPosition = (typeof ALL_POSITIONS)[number]
export type RoleGroup = (typeof ROLE_GROUPS)[OutfieldPosition]
export type Lineup = Partial<Record<OutfieldPosition, string>>

export interface ChunkSubstitution {
  playerInId: string
  playerOutId: string
  position: OutfieldPosition
}

export interface Player {
  id: string
  name: string
}

export interface MatchConfig {
  players: Player[]
  periodMinutes: 15 | 20
  formation: FormationKey
  chunkMinutes: number
  lockedGoalkeeperIds?: Array<string | null>
  seed?: number
  attempts?: number
}

export interface ChunkPlan {
  chunkIndex: number
  period: number
  windowIndex: number
  startMinute: number
  endMinute: number
  durationMinutes: number
  goalkeeperId: string
  goalkeeperName: string
  lineup: Lineup
  activePlayerIds: string[]
  substitutes: string[]
  substitutions: ChunkSubstitution[]
}

export interface PeriodPlan {
  period: number
  formation: FormationKey
  positions: readonly OutfieldPosition[]
  goalkeeperId: string
  goalkeeperName: string
  startingLineup: Lineup
  chunks: ChunkPlan[]
  substitutes: string[]
}

export interface PlayerSummary {
  playerId: string
  name: string
  totalMinutes: number
  benchMinutes: number
  goalkeeperPeriods: number[]
  positionsPlayed: OutfieldPosition[]
  roleGroups: RoleGroup[]
}

export interface MatchPlan {
  seed: number
  score: number
  formation: FormationKey
  chunkMinutes: number
  periodMinutes: 15 | 20
  positions: readonly OutfieldPosition[]
  goalkeepers: string[]
  lockedGoalkeepers: Array<string | null>
  targets: Record<string, number>
  periods: PeriodPlan[]
  summaries: PlayerSummary[]
}
