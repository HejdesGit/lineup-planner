import { describe, expect, it } from 'vitest'
import {
  applyLiveAdjustmentEvents,
  createInitialAvailabilityState,
  getLiveRecommendations,
  replanMatchFromLiveEvent,
  resolveChunkAtMinute,
} from './liveAdjustments'
import { generateMatchPlan } from './scheduler'
import type { LiveAdjustmentEvent, Player } from './types'

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
    chunkMinutes: 20 / 3,
    seed: 31337,
    attempts: 1,
  })
}

function createBoundaryPlan() {
  return generateMatchPlan({
    players: createPlayers(['Adam', 'Anton', 'Bill', 'Dante', 'David', 'Elias', 'Emil', 'Gunnar', 'Henry', 'Jax']),
    periodMinutes: 20,
    formation: '2-3-1',
    chunkMinutes: 10,
    seed: 20260315,
    attempts: 1,
  })
}

function getChunkAtMinute(plan: ReturnType<typeof createPlan>, period: number, minute: number) {
  const currentPeriod = plan.periods[period - 1]
  return currentPeriod ? resolveChunkAtMinute(currentPeriod, minute)?.chunk ?? null : null
}

describe('liveAdjustments', () => {
  it('resolves exact chunk boundaries consistently with live semantics', () => {
    const plan = createBoundaryPlan()
    const period = plan.periods[1]

    expect(resolveChunkAtMinute(period, 9.999)?.chunk.windowIndex).toBe(0)
    expect(resolveChunkAtMinute(period, 10)?.chunk.windowIndex).toBe(1)
    expect(resolveChunkAtMinute(period, 10)?.isExactBoundaryMinute).toBe(true)
    expect(resolveChunkAtMinute(period, 20)?.chunk.windowIndex).toBe(1)
  })

  it('reallocates fairness targets away from players who are temporarily out', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const playerId = chunk.lineup.VB!
    const replacement = getLiveRecommendations({
      plan,
      availability,
      period: 2,
      minute: 10,
      playerId,
      type: 'temporary-out',
    })[0]

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId,
        replacementPlayerId: replacement.playerId,
        status: 'temporarily-out',
      },
    })

    const unavailableSummary = next.plan.summaries.find((summary) => summary.playerId === playerId)

    expect(unavailableSummary).toBeDefined()
    expect(next.plan.fairnessTargets[playerId]).toBe(unavailableSummary!.totalMinutes)
    expect(next.plan.fairnessTargets[playerId]).toBeLessThan(plan.targets[playerId])
    expect(
      Object.values(next.plan.fairnessTargets).reduce((total, minutes) => total + minutes, 0),
    ).toBeCloseTo(next.plan.summaries.reduce((total, summary) => total + summary.totalMinutes, 0), 6)
  })

  it('splits the active chunk and removes unavailable players from future active lineups', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const injuredPlayerId = chunk.lineup.VB!
    const recommendations = getLiveRecommendations({
      plan,
      availability,
      period: 2,
      minute: 10,
      playerId: injuredPlayerId,
      type: 'temporary-out',
    })

    expect(recommendations).toHaveLength(2)
    expect(chunk.activePlayerIds).not.toContain(recommendations[0].playerId)

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId: injuredPlayerId,
        replacementPlayerId: recommendations[0].playerId,
        status: 'temporarily-out',
      },
    })

    expect(next.availability[injuredPlayerId]).toBe('temporarily-out')

    const updatedPeriodTwo = next.plan.periods[1]
    expect(updatedPeriodTwo.chunks.some((candidate) => candidate.endMinute === 10)).toBe(true)
    expect(updatedPeriodTwo.chunks.some((candidate) => candidate.startMinute === 10)).toBe(true)

    const futureActivePlayerIds = next.plan.periods
      .flatMap((period) => period.chunks)
      .filter((candidate) => candidate.period > 2 || candidate.startMinute >= 10)
      .flatMap((candidate) => candidate.activePlayerIds)

    expect(futureActivePlayerIds).not.toContain(injuredPlayerId)
  })

  it('recommends only active outfield players on return and keeps total minutes consistent', () => {
    const plan = createPlan()
    const injuryAvailability = createInitialAvailabilityState(plan)
    const injuryChunk = getChunkAtMinute(plan, 2, 10)

    if (!injuryChunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const injuredPlayerId = injuryChunk.lineup.VB!
    const injuryRecommendation = getLiveRecommendations({
      plan,
      availability: injuryAvailability,
      period: 2,
      minute: 10,
      playerId: injuredPlayerId,
      type: 'temporary-out',
    })[0]

    const afterInjury = replanMatchFromLiveEvent({
      plan,
      availability: injuryAvailability,
      event: {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId: injuredPlayerId,
        replacementPlayerId: injuryRecommendation.playerId,
        status: 'temporarily-out',
      },
    })

    const returnRecommendations = getLiveRecommendations({
      plan: afterInjury.plan,
      availability: afterInjury.availability,
      period: 2,
      minute: 12,
      playerId: injuredPlayerId,
      type: 'return',
    })
    const activeAtReturnMinute = getChunkAtMinute(afterInjury.plan, 2, 12)

    if (!activeAtReturnMinute) {
      throw new Error('Return-byteblock saknas i testet.')
    }

    expect(returnRecommendations.length).toBeGreaterThan(0)
    expect(
      returnRecommendations.every((recommendation) =>
        activeAtReturnMinute.activePlayerIds.includes(recommendation.playerId),
      ),
    ).toBe(true)

    const afterReturn = replanMatchFromLiveEvent({
      plan: afterInjury.plan,
      availability: afterInjury.availability,
      event: {
        type: 'return',
        period: 2,
        minute: 12,
        playerId: injuredPlayerId,
        replacementPlayerId: returnRecommendations[0].playerId,
      },
    })

    expect(afterReturn.availability[injuredPlayerId]).toBe('available')
    expect(afterReturn.plan.fairnessTargets[injuredPlayerId]).toBeGreaterThan(
      afterInjury.plan.fairnessTargets[injuredPlayerId],
    )

    const totalActualMinutes = afterReturn.plan.summaries.reduce(
      (total, summary) => total + summary.totalMinutes,
      0,
    )
    const totalBenchMinutes = afterReturn.plan.summaries.reduce(
      (total, summary) => total + summary.benchMinutes,
      0,
    )

    expect(totalActualMinutes).toBe(3 * 20 * 7)
    expect(totalBenchMinutes).toBe(afterReturn.plan.summaries.length * 60 - totalActualMinutes)
  })

  it('replays persisted live events in order', () => {
    const plan = createPlan()
    const injuryChunk = getChunkAtMinute(plan, 2, 10)

    if (!injuryChunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const injuredPlayerId = injuryChunk.lineup.VB!
    const events: LiveAdjustmentEvent[] = [
      {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId: injuredPlayerId,
        replacementPlayerId: getLiveRecommendations({
          plan,
          availability: createInitialAvailabilityState(plan),
          period: 2,
          minute: 10,
          playerId: injuredPlayerId,
          type: 'temporary-out',
        })[0].playerId,
        status: 'temporarily-out',
      },
    ]

    const replayed = applyLiveAdjustmentEvents({
      plan,
      events,
    })

    expect(replayed.availability[injuredPlayerId]).toBe('temporarily-out')
    expect(replayed.plan.periods[1].chunks.some((chunk) => chunk.endMinute === 10)).toBe(true)
  })

  it('softly penalizes bench candidates with future goalkeeper minutes', () => {
    const plan = createBoundaryPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const playerId = chunk.lineup.VB!
    const baselineRecommendations = getLiveRecommendations({
      plan,
      availability,
      period: 2,
      minute: 10,
      playerId,
      type: 'temporary-out',
    })
    const penalizedCandidateId = baselineRecommendations[0]?.playerId

    if (!penalizedCandidateId) {
      throw new Error('Saknar ersättningskandidat för GK-penalty-testet.')
    }

    const modifiedPlan = structuredClone(plan)
    modifiedPlan.goalkeepers[2] = penalizedCandidateId
    modifiedPlan.periods[2] = {
      ...modifiedPlan.periods[2],
      goalkeeperId: penalizedCandidateId,
      goalkeeperName:
        modifiedPlan.summaries.find((summary) => summary.playerId === penalizedCandidateId)?.name ??
        penalizedCandidateId,
      chunks: modifiedPlan.periods[2].chunks.map((currentChunk) => ({
        ...currentChunk,
        goalkeeperId: penalizedCandidateId,
        goalkeeperName:
          modifiedPlan.summaries.find((summary) => summary.playerId === penalizedCandidateId)?.name ??
          penalizedCandidateId,
      })),
    }

    const penalizedRecommendation = getLiveRecommendations({
      plan: modifiedPlan,
      availability,
      period: 2,
      minute: 10,
      playerId,
      type: 'temporary-out',
    }).find((recommendation) => recommendation.playerId === penalizedCandidateId)

    expect(penalizedRecommendation).toBeDefined()
    expect(penalizedRecommendation?.goalkeeperPenaltyApplied).toBe(true)
    expect(penalizedRecommendation?.futureGoalkeeperMinutes).toBeGreaterThan(0)
    expect(penalizedRecommendation?.score).toBeLessThan(
      baselineRecommendations.find((recommendation) => recommendation.playerId === penalizedCandidateId)!.score,
    )
  })
})
