import { describe, expect, it } from 'vitest'
import {
  buildMatchTimeline,
  createRunningMatchTimer,
  getIdleMatchProgress,
  getMatchProgress,
  isStoredActiveMatchTimerCompatible,
  parseStoredActiveMatchTimer,
  pauseMatchTimer,
  resumeMatchTimer,
} from './matchTimer'
import { generateMatchPlan } from './scheduler'
import type { Player } from './types'

function createPlayers(names: string[]): Player[] {
  return names.map((name, index) => ({
    id: `player-${index + 1}`,
    name,
  }))
}

function createPlan() {
  return generateMatchPlan({
    players: createPlayers(['Ada', 'Bea', 'Cleo', 'Dani', 'Eli', 'Fia', 'Gio', 'Hugo', 'Iris']),
    periodMinutes: 20,
    formation: '3-2-1',
    chunkMinutes: 10,
    seed: 77,
    attempts: 1,
  })
}

describe('matchTimer', () => {
  it('builds idle progress before a match has started', () => {
    expect(getIdleMatchProgress(20 * 60_000)).toEqual({
      status: 'idle',
      elapsedMs: 0,
      remainingMs: 20 * 60_000,
      progress: 0,
      activePeriod: null,
      activeChunkIndex: null,
    })
  })

  it('maps elapsed time to the active byteblock within the selected period', () => {
    const timeline = buildMatchTimeline(createPlan())
    const periodOneTimer = createRunningMatchTimer({
      lineupSnapshot: 'snapshot-token',
      startedAt: 1_000,
      period: 1,
      periodDurationMs: timeline.periodDurationMs,
    })
    const periodTwoTimer = createRunningMatchTimer({
      lineupSnapshot: 'snapshot-token',
      startedAt: 1_000,
      period: 2,
      periodDurationMs: timeline.periodDurationMs,
    })

    expect(getMatchProgress({ timeline, timer: periodOneTimer, now: 1_000 + 5 * 60_000 })).toMatchObject({
      status: 'running',
      elapsedMs: 5 * 60_000,
      remainingMs: 15 * 60_000,
      activePeriod: 1,
      activeChunkIndex: 0,
    })

    expect(getMatchProgress({ timeline, timer: periodOneTimer, now: 1_000 + 15 * 60_000 })).toMatchObject({
      status: 'running',
      elapsedMs: 15 * 60_000,
      remainingMs: 5 * 60_000,
      activePeriod: 1,
      activeChunkIndex: 1,
    })

    expect(getMatchProgress({ timeline, timer: periodTwoTimer, now: 1_000 + 19 * 60_000 })).toMatchObject({
      status: 'running',
      elapsedMs: 19 * 60_000,
      remainingMs: 60_000,
      activePeriod: 2,
      activeChunkIndex: 1,
    })
  })

  it('clamps elapsed time before start and after period full time', () => {
    const timeline = buildMatchTimeline(createPlan())

    expect(
      getMatchProgress({
        timeline,
        timer: createRunningMatchTimer({
          lineupSnapshot: 'snapshot-token',
          startedAt: 10_000,
          period: 1,
          periodDurationMs: timeline.periodDurationMs,
        }),
        now: 9_000,
      }),
    ).toMatchObject({
      status: 'running',
      elapsedMs: 0,
      remainingMs: 20 * 60_000,
      activePeriod: 1,
      activeChunkIndex: 0,
    })

    expect(
      getMatchProgress({
        timeline,
        timer: createRunningMatchTimer({
          lineupSnapshot: 'snapshot-token',
          startedAt: 10_000,
          period: 1,
          periodDurationMs: timeline.periodDurationMs,
        }),
        now: 10_000 + 90 * 60_000,
      }),
    ).toEqual({
      status: 'finished',
      elapsedMs: 20 * 60_000,
      remainingMs: 0,
      progress: 1,
      activePeriod: 1,
      activeChunkIndex: null,
    })
  })

  it('pauses the timer and resumes from the stored elapsed time', () => {
    const timeline = buildMatchTimeline(createPlan())
    const runningTimer = createRunningMatchTimer({
      lineupSnapshot: 'snapshot-token',
      startedAt: 1_000,
      period: 1,
      periodDurationMs: timeline.periodDurationMs,
    })

    const pausedTimer = pauseMatchTimer(runningTimer, 1_000 + 12 * 60_000)

    expect(pausedTimer).toEqual({
      version: 2,
      lineupSnapshot: 'snapshot-token',
      status: 'paused',
      startedAt: null,
      elapsedMs: 12 * 60_000,
      period: 1,
      periodDurationMs: timeline.periodDurationMs,
    })

    expect(getMatchProgress({ timeline, timer: pausedTimer, now: 1_000 + 40 * 60_000 })).toMatchObject({
      status: 'paused',
      elapsedMs: 12 * 60_000,
      remainingMs: 8 * 60_000,
      activePeriod: 1,
      activeChunkIndex: 1,
    })

    const resumedTimer = resumeMatchTimer(pausedTimer, 5_000)

    expect(getMatchProgress({ timeline, timer: resumedTimer, now: 5_000 + 3 * 60_000 })).toMatchObject({
      status: 'running',
      elapsedMs: 15 * 60_000,
      remainingMs: 5 * 60_000,
      activePeriod: 1,
      activeChunkIndex: 1,
    })
  })

  it('parses persisted timer payloads and rejects invalid versions or shapes', () => {
    expect(
      parseStoredActiveMatchTimer(
        JSON.stringify({
          version: 2,
          lineupSnapshot: 'snapshot-token',
          status: 'running',
          startedAt: 12345,
          elapsedMs: 0,
          period: 2,
          periodDurationMs: 1_200_000,
        }),
      ),
    ).toEqual({
      version: 2,
      lineupSnapshot: 'snapshot-token',
      status: 'running',
      startedAt: 12345,
      elapsedMs: 0,
      period: 2,
      periodDurationMs: 1_200_000,
    })

    expect(
      parseStoredActiveMatchTimer(
        JSON.stringify({
          version: 2,
          lineupSnapshot: 'snapshot-token',
          status: 'paused',
          startedAt: null,
          elapsedMs: 180000,
          period: 3,
          periodDurationMs: 1_200_000,
        }),
      ),
    ).toEqual({
      version: 2,
      lineupSnapshot: 'snapshot-token',
      status: 'paused',
      startedAt: null,
      elapsedMs: 180000,
      period: 3,
      periodDurationMs: 1_200_000,
    })

    expect(parseStoredActiveMatchTimer('{"version":2}')).toBeNull()
    expect(parseStoredActiveMatchTimer('{"version":1,"lineupSnapshot":"snapshot-token","startedAt":1,"matchDurationMs":1}')).toBeNull()
    expect(parseStoredActiveMatchTimer('not-json')).toBeNull()
  })

  it('checks that a persisted timer matches the restored match duration', () => {
    const timeline = buildMatchTimeline(createPlan())

    expect(
      isStoredActiveMatchTimerCompatible(
        {
          version: 2,
          lineupSnapshot: 'snapshot-token',
          status: 'running',
          startedAt: 12345,
          elapsedMs: 0,
          period: 2,
          periodDurationMs: timeline.periodDurationMs,
        },
        timeline,
      ),
    ).toBe(true)

    expect(
      isStoredActiveMatchTimerCompatible(
        {
          version: 2,
          lineupSnapshot: 'snapshot-token',
          status: 'paused',
          startedAt: null,
          elapsedMs: 180000,
          period: 2,
          periodDurationMs: 999,
        },
        timeline,
      ),
    ).toBe(false)
  })
})
