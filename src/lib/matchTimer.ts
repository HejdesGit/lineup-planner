import type { MatchPlan } from './types'

export const ACTIVE_MATCH_TIMER_STORAGE_KEY = 'eik.active-match-timer.v1'
const STORED_ACTIVE_MATCH_TIMER_VERSION = 1
type StoredActiveMatchTimerStatus = 'running' | 'paused' | 'finished'

export interface StoredActiveMatchTimer {
  version: typeof STORED_ACTIVE_MATCH_TIMER_VERSION
  lineupSnapshot: string
  status: StoredActiveMatchTimerStatus
  startedAt: number | null
  elapsedMs: number
  matchDurationMs: number
}

export interface MatchTimelineChunk {
  period: number
  chunkIndex: number
  windowIndex: number
  startMs: number
  endMs: number
  durationMs: number
}

export interface MatchTimeline {
  chunks: MatchTimelineChunk[]
  totalDurationMs: number
}

export interface MatchProgress {
  status: 'idle' | 'running' | 'paused' | 'finished'
  elapsedMs: number
  remainingMs: number
  progress: number
  activePeriod: number | null
  activeChunkIndex: number | null
}

export function buildMatchTimeline(plan: MatchPlan): MatchTimeline {
  const chunks = plan.periods.flatMap((period) =>
    period.chunks.map((chunk) => {
      const periodOffsetMs = (period.period - 1) * plan.periodMinutes * 60_000
      const startMs = periodOffsetMs + Math.round(chunk.startMinute * 60_000)
      const endMs = periodOffsetMs + Math.round(chunk.endMinute * 60_000)

      return {
        period: period.period,
        chunkIndex: chunk.chunkIndex,
        windowIndex: chunk.windowIndex,
        startMs,
        endMs,
        durationMs: endMs - startMs,
      }
    }),
  )

  return {
    chunks,
    totalDurationMs: plan.periodMinutes * plan.periods.length * 60_000,
  }
}

export function getIdleMatchProgress(totalDurationMs: number): MatchProgress {
  return {
    status: 'idle',
    elapsedMs: 0,
    remainingMs: totalDurationMs,
    progress: totalDurationMs > 0 ? 0 : 1,
    activePeriod: null,
    activeChunkIndex: null,
  }
}

export function getMatchProgress({
  timeline,
  timer,
  now,
}: {
  timeline: MatchTimeline
  timer: StoredActiveMatchTimer | null
  now: number
}): MatchProgress {
  if (!timer) {
    return getIdleMatchProgress(timeline.totalDurationMs)
  }

  const elapsedMs = resolveElapsedMs(timer, now, timeline.totalDurationMs)
  const remainingMs = Math.max(0, timeline.totalDurationMs - elapsedMs)
  const isFinished = elapsedMs >= timeline.totalDurationMs

  if (isFinished) {
    return {
      status: 'finished',
      elapsedMs,
      remainingMs,
      progress: 1,
      activePeriod: null,
      activeChunkIndex: null,
    }
  }

  const activeChunk = getActiveTimelineChunk(timeline, elapsedMs)

  return {
    status: timer.status === 'paused' ? 'paused' : 'running',
    elapsedMs,
    remainingMs,
    progress: timeline.totalDurationMs > 0 ? elapsedMs / timeline.totalDurationMs : 1,
    activePeriod: activeChunk?.period ?? null,
    activeChunkIndex: activeChunk?.windowIndex ?? null,
  }
}

export function createRunningMatchTimer({
  lineupSnapshot,
  startedAt,
  matchDurationMs,
  elapsedMs = 0,
}: {
  lineupSnapshot: string
  startedAt: number
  matchDurationMs: number
  elapsedMs?: number
}): StoredActiveMatchTimer {
  return {
    version: STORED_ACTIVE_MATCH_TIMER_VERSION,
    lineupSnapshot,
    status: 'running',
    startedAt,
    elapsedMs,
    matchDurationMs,
  }
}

export function pauseMatchTimer(
  timer: StoredActiveMatchTimer,
  now: number,
): StoredActiveMatchTimer {
  const elapsedMs = resolveElapsedMs(timer, now, timer.matchDurationMs)

  return {
    ...timer,
    status: elapsedMs >= timer.matchDurationMs ? 'finished' : 'paused',
    startedAt: null,
    elapsedMs,
  }
}

export function resumeMatchTimer(
  timer: StoredActiveMatchTimer,
  now: number,
): StoredActiveMatchTimer {
  if (timer.status === 'finished') {
    return timer
  }

  return {
    ...timer,
    status: 'running',
    startedAt: now,
  }
}

export function serializeStoredActiveMatchTimer(timer: StoredActiveMatchTimer) {
  return JSON.stringify(timer)
}

export function parseStoredActiveMatchTimer(
  value: string | null,
): StoredActiveMatchTimer | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<StoredActiveMatchTimer>
    const { matchDurationMs } = parsed

    if (
      parsed.version !== STORED_ACTIVE_MATCH_TIMER_VERSION ||
      typeof parsed.lineupSnapshot !== 'string' ||
      parsed.lineupSnapshot.length === 0 ||
      typeof matchDurationMs !== 'number' ||
      !Number.isFinite(matchDurationMs) ||
      matchDurationMs <= 0
    ) {
      return null
    }

    // Backward compatibility with the initial running-only timer schema.
    if (!parsed.status && typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) {
      return {
        version: STORED_ACTIVE_MATCH_TIMER_VERSION,
        lineupSnapshot: parsed.lineupSnapshot,
        status: 'running',
        startedAt: parsed.startedAt,
        elapsedMs: 0,
        matchDurationMs,
      }
    }

    if (
      (parsed.status !== 'running' && parsed.status !== 'paused' && parsed.status !== 'finished') ||
      typeof parsed.elapsedMs !== 'number' ||
      !Number.isFinite(parsed.elapsedMs) ||
      parsed.elapsedMs < 0
    ) {
      return null
    }

    if (
      parsed.status === 'running' &&
      (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt))
    ) {
      return null
    }

    if (
      parsed.status !== 'running' &&
      parsed.startedAt !== null &&
      parsed.startedAt !== undefined
    ) {
      return null
    }

    return {
      version: STORED_ACTIVE_MATCH_TIMER_VERSION,
      lineupSnapshot: parsed.lineupSnapshot,
      status: parsed.status,
      startedAt: parsed.status === 'running' ? parsed.startedAt ?? null : null,
      elapsedMs: Math.min(parsed.elapsedMs, matchDurationMs),
      matchDurationMs,
    }
  } catch {
    return null
  }
}

export function isStoredActiveMatchTimerCompatible(
  timer: StoredActiveMatchTimer,
  timeline: MatchTimeline,
) {
  return timer.matchDurationMs === timeline.totalDurationMs
}

function getActiveTimelineChunk(timeline: MatchTimeline, elapsedMs: number) {
  return timeline.chunks.find((chunk, index) => {
    const isLastChunk = index === timeline.chunks.length - 1
    return elapsedMs >= chunk.startMs && (elapsedMs < chunk.endMs || (isLastChunk && elapsedMs === chunk.endMs))
  })
}

function resolveElapsedMs(
  timer: StoredActiveMatchTimer,
  now: number,
  totalDurationMs: number,
) {
  const liveElapsedMs =
    timer.status === 'running' && typeof timer.startedAt === 'number'
      ? timer.elapsedMs + Math.max(0, now - timer.startedAt)
      : timer.elapsedMs

  return Math.min(liveElapsedMs, totalDurationMs)
}
