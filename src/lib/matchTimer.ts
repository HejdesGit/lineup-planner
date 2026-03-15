import type { MatchPlan } from './types'

export const ACTIVE_MATCH_TIMER_STORAGE_KEY = 'eik.active-match-timer.v1'
const STORED_ACTIVE_MATCH_TIMER_VERSION = 2
type StoredActiveMatchTimerStatus = 'running' | 'paused' | 'finished'

export interface StoredActiveMatchTimer {
  version: typeof STORED_ACTIVE_MATCH_TIMER_VERSION
  lineupSnapshot: string
  status: StoredActiveMatchTimerStatus
  startedAt: number | null
  elapsedMs: number
  period: number
  periodDurationMs: number
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
  periodCount: number
  periodDurationMs: number
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
      const startMs = Math.round(chunk.startMinute * 60_000)
      const endMs = Math.round(chunk.endMinute * 60_000)

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
    periodCount: plan.periods.length,
    periodDurationMs: plan.periodMinutes * 60_000,
  }
}

export function getIdleMatchProgress(periodDurationMs: number): MatchProgress {
  return {
    status: 'idle',
    elapsedMs: 0,
    remainingMs: periodDurationMs,
    progress: periodDurationMs > 0 ? 0 : 1,
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
    return getIdleMatchProgress(timeline.periodDurationMs)
  }

  const elapsedMs = resolveElapsedMs(timer, now, timer.periodDurationMs)
  const remainingMs = Math.max(0, timer.periodDurationMs - elapsedMs)
  const isFinished = elapsedMs >= timer.periodDurationMs

  if (isFinished) {
    return {
      status: 'finished',
      elapsedMs,
      remainingMs,
      progress: 1,
      activePeriod: timer.period,
      activeChunkIndex: null,
    }
  }

  const activeChunk = getActiveTimelineChunk(timeline, timer.period, elapsedMs)

  return {
    status: timer.status === 'paused' ? 'paused' : 'running',
    elapsedMs,
    remainingMs,
    progress: timer.periodDurationMs > 0 ? elapsedMs / timer.periodDurationMs : 1,
    activePeriod: timer.period,
    activeChunkIndex: activeChunk?.windowIndex ?? null,
  }
}

export function createRunningMatchTimer({
  lineupSnapshot,
  startedAt,
  period,
  periodDurationMs,
  elapsedMs = 0,
}: {
  lineupSnapshot: string
  startedAt: number
  period: number
  periodDurationMs: number
  elapsedMs?: number
}): StoredActiveMatchTimer {
  return {
    version: STORED_ACTIVE_MATCH_TIMER_VERSION,
    lineupSnapshot,
    status: 'running',
    startedAt,
    elapsedMs,
    period,
    periodDurationMs,
  }
}

export function pauseMatchTimer(
  timer: StoredActiveMatchTimer,
  now: number,
): StoredActiveMatchTimer {
  const elapsedMs = resolveElapsedMs(timer, now, timer.periodDurationMs)

  return {
    ...timer,
    status: elapsedMs >= timer.periodDurationMs ? 'finished' : 'paused',
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
    const { periodDurationMs, period } = parsed

    if (
      parsed.version !== STORED_ACTIVE_MATCH_TIMER_VERSION ||
      typeof parsed.lineupSnapshot !== 'string' ||
      parsed.lineupSnapshot.length === 0 ||
      typeof period !== 'number' ||
      !Number.isInteger(period) ||
      period < 1 ||
      typeof periodDurationMs !== 'number' ||
      !Number.isFinite(periodDurationMs) ||
      periodDurationMs <= 0
    ) {
      return null
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
      elapsedMs: Math.min(parsed.elapsedMs, periodDurationMs),
      period,
      periodDurationMs,
    }
  } catch {
    return null
  }
}

export function isStoredActiveMatchTimerCompatible(
  timer: StoredActiveMatchTimer,
  timeline: MatchTimeline,
) {
  return timer.periodDurationMs === timeline.periodDurationMs && timer.period <= timeline.periodCount
}

export function getTimelineChunksForPeriod(timeline: MatchTimeline, period: number) {
  return timeline.chunks.filter((chunk) => chunk.period === period)
}

function getActiveTimelineChunk(timeline: MatchTimeline, period: number, elapsedMs: number) {
  const periodChunks = getTimelineChunksForPeriod(timeline, period)

  return periodChunks.find((chunk, index) => {
    const isLastChunk = index === periodChunks.length - 1
    return elapsedMs >= chunk.startMs && (elapsedMs < chunk.endMs || (isLastChunk && elapsedMs === chunk.endMs))
  })
}

function resolveElapsedMs(
  timer: StoredActiveMatchTimer,
  now: number,
  periodDurationMs: number,
) {
  const liveElapsedMs =
    timer.status === 'running' && typeof timer.startedAt === 'number'
      ? timer.elapsedMs + Math.max(0, now - timer.startedAt)
      : timer.elapsedMs

  return Math.min(liveElapsedMs, periodDurationMs)
}
