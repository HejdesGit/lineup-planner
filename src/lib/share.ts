import {
  FORMATION_PRESETS,
  PERIOD_COUNT,
  PERIOD_COUNT_OPTIONS,
  PERIOD_MINUTE_OPTIONS,
  type GeneratedConfig,
  type LiveAdjustmentEvent,
} from './types'

export const LINEUP_SHARE_QUERY_PARAM = 'lineup'

interface LineupSnapshotV1 {
  v: 1
  p: string[]
  pm: number
  f: GeneratedConfig['formation']
  cm: number
  gk: GeneratedConfig['goalkeeperSelections']
  s: number
  o?: Record<string, Record<string, string>>
}

interface LineupSnapshotV2 extends Omit<LineupSnapshotV1, 'v'> {
  v: 2
  le?: LiveAdjustmentEvent[]
}

interface LineupSnapshotV3 extends Omit<LineupSnapshotV1, 'v'> {
  v: 3
  le?: LiveAdjustmentEvent[]
}

interface LineupSnapshotV4 extends Omit<LineupSnapshotV1, 'v'> {
  v: 4
  pc?: number
  le?: LiveAdjustmentEvent[]
}

export interface DecodedLineupSnapshot {
  config: GeneratedConfig
  overrides: Record<string, Record<string, string>>
  liveEvents: LiveAdjustmentEvent[]
}

export function encodeLineupSnapshot({
  config,
  overrides,
  liveEvents,
}: {
  config: GeneratedConfig
  overrides: Record<string, Record<string, string>>
  liveEvents?: LiveAdjustmentEvent[]
}) {
  const payload: LineupSnapshotV4 = {
    v: 4,
    p: config.playerNames,
    pm: config.periodMinutes,
    f: config.formation,
    cm: config.chunkMinutes,
    gk: config.goalkeeperSelections,
    s: config.seed,
    ...(config.periodCount && config.periodCount !== PERIOD_COUNT ? { pc: config.periodCount } : {}),
    ...(Object.keys(overrides).length > 0 ? { o: overrides } : {}),
    ...(liveEvents && liveEvents.length > 0 ? { le: liveEvents } : {}),
  }

  return encodeBase64Url(JSON.stringify(payload))
}

export function decodeLineupSnapshot(encodedSnapshot: string): DecodedLineupSnapshot {
  const parsed = JSON.parse(decodeBase64Url(encodedSnapshot)) as
    | Partial<LineupSnapshotV1>
    | Partial<LineupSnapshotV2>
    | Partial<LineupSnapshotV3>
    | Partial<LineupSnapshotV4>

  const periodCount = parsed.v === 4 ? parsed.pc ?? PERIOD_COUNT : PERIOD_COUNT

  if (
    (parsed.v !== 1 && parsed.v !== 2 && parsed.v !== 3 && parsed.v !== 4) ||
    !Array.isArray(parsed.p) ||
    parsed.p.length < 8 ||
    parsed.p.length > 12 ||
    !parsed.p.every((name) => typeof name === 'string' && name.trim().length > 0) ||
    !PERIOD_MINUTE_OPTIONS.includes(parsed.pm as (typeof PERIOD_MINUTE_OPTIONS)[number]) ||
    !(parsed.f && parsed.f in FORMATION_PRESETS) ||
    typeof parsed.cm !== 'number' ||
    !isValidChunkMinutes(parsed.cm) ||
    typeof periodCount !== 'number' ||
    !Number.isInteger(periodCount) ||
    !PERIOD_COUNT_OPTIONS.includes(periodCount as (typeof PERIOD_COUNT_OPTIONS)[number]) ||
    !Array.isArray(parsed.gk) ||
    parsed.gk.length !== periodCount ||
    !parsed.gk.every((selection) => typeof selection === 'string') ||
    !Number.isInteger(parsed.s)
  ) {
    throw new Error('Ogiltig delningslänk.')
  }

  if (parsed.o && !isOverrideMap(parsed.o)) {
    throw new Error('Ogiltig delningslänk.')
  }

  if ((parsed.v === 2 || parsed.v === 3) && parsed.le && !isLiveEventList(parsed.le)) {
    throw new Error('Ogiltig delningslänk.')
  }

  const playerNames = parsed.p as string[]
  const periodMinutes = parsed.pm as number
  const formation = parsed.f as GeneratedConfig['formation']
  const chunkMinutes = parsed.cm as number
  const goalkeeperSelections = parsed.gk as GeneratedConfig['goalkeeperSelections']
  const seed = parsed.s as number

  return {
    config: {
      playerInput: playerNames.join('\n'),
      playerNames,
      ...(periodCount !== PERIOD_COUNT ? { periodCount } : {}),
      periodMinutes,
      formation,
      chunkMinutes,
      goalkeeperSelections: [...goalkeeperSelections] as GeneratedConfig['goalkeeperSelections'],
      seed,
    },
    overrides: parsed.o ?? {},
    liveEvents: parsed.v === 2 || parsed.v === 3 || parsed.v === 4 ? parsed.le ?? [] : [],
  }
}

function isValidChunkMinutes(chunkMinutes: number) {
  return Number.isFinite(chunkMinutes) && chunkMinutes > 0
}

export function buildLineupShareUrl(encodedSnapshot: string, currentUrl: string) {
  const url = new URL(currentUrl)
  url.searchParams.set(LINEUP_SHARE_QUERY_PARAM, encodedSnapshot)
  return url.toString()
}

export function clearLineupShareUrl(currentUrl: string) {
  const url = new URL(currentUrl)
  url.searchParams.delete(LINEUP_SHARE_QUERY_PARAM)
  return url.toString()
}

function isOverrideMap(value: unknown): value is Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.entries(value).every(([period, assignments]) => {
    if (!Number.isInteger(Number(period))) {
      return false
    }

    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
      return false
    }

    return Object.entries(assignments).every(
      ([slotId, playerId]) => slotId.length > 0 && typeof playerId === 'string' && playerId.length > 0,
    )
  })
}

function isLiveEventList(value: unknown): value is LiveAdjustmentEvent[] {
  if (!Array.isArray(value)) {
    return false
  }

  return value.every((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false
    }

    const event = entry as Partial<LiveAdjustmentEvent>
    const status = 'status' in event ? event.status : undefined
    const hasBaseFields =
      typeof event.period === 'number' &&
      Number.isInteger(event.period) &&
      event.period >= 1 &&
      typeof event.minute === 'number' &&
      Number.isFinite(event.minute) &&
      typeof event.playerId === 'string' &&
      event.playerId.length > 0

    if (!hasBaseFields || typeof event.type !== 'string') {
      return false
    }

    if (event.type === 'position-swap') {
      return typeof event.targetPlayerId === 'string' && event.targetPlayerId.length > 0
    }

    return (
      (event.type === 'injury' || event.type === 'temporary-out' || event.type === 'return') &&
      typeof event.replacementPlayerId === 'string' &&
      event.replacementPlayerId.length > 0 &&
      (status === undefined || status === 'injured' || status === 'temporarily-out')
    )
  })
}

function encodeBase64Url(value: string) {
  const binary = bytesToBinaryString(new TextEncoder().encode(value))

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string) {
  const paddedValue = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(paddedValue)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))

  return new TextDecoder().decode(bytes)
}

function bytesToBinaryString(bytes: Uint8Array) {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return binary
}
