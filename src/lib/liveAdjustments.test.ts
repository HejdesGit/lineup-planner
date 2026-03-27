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

function createGoalkeeperBiasPlan() {
  const players = createPlayers(['Adam', 'Anton', 'Bill', 'Dante', 'David', 'Elias', 'Emil', 'Gunnar', 'Henry', 'Jax'])
  const lockedGoalkeeperIds = [players[0].id, players[1].id, players[2].id]

  return {
    players,
    lockedGoalkeeperIds,
    plan: generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 20 / 3,
      lockedGoalkeeperIds,
      seed: 11,
      attempts: 72,
    }),
  }
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

  it('preserves the goalkeeper fairness bias through live replanning', () => {
    const { players, lockedGoalkeeperIds, plan } = createGoalkeeperBiasPlan()
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

    const unaffectedGoalkeeperId = lockedGoalkeeperIds.find((goalkeeperId) => goalkeeperId !== chunk.goalkeeperId)
    const unaffectedOutfielderId = players.find(
      (player) =>
        !lockedGoalkeeperIds.includes(player.id) &&
        player.id !== playerId &&
        player.id !== replacement.playerId,
    )?.id

    expect(unaffectedGoalkeeperId).toBeDefined()
    expect(unaffectedOutfielderId).toBeDefined()
    expect(plan.fairnessTargets[unaffectedGoalkeeperId!]).toBeGreaterThan(
      plan.fairnessTargets[unaffectedOutfielderId!],
    )

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

    expect(next.plan.targets[unaffectedGoalkeeperId!]).toBe(plan.targets[unaffectedGoalkeeperId!])
    expect(next.plan.fairnessTargets[unaffectedGoalkeeperId!]).toBeGreaterThan(
      next.plan.targets[unaffectedGoalkeeperId!],
    )
    expect(next.plan.fairnessTargets[unaffectedGoalkeeperId!]).toBeGreaterThan(
      plan.targets[unaffectedGoalkeeperId!],
    )
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

    expect(totalActualMinutes).toBeCloseTo(3 * 20 * 7, 6)
    expect(totalBenchMinutes).toBeCloseTo(
      afterReturn.plan.summaries.length * 60 - totalActualMinutes,
      6,
    )
  })

  it('supports goalkeeper temporary-out events and lets the goalkeeper return', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const goalkeeperId = chunk.goalkeeperId
    const temporaryOutRecommendations = getLiveRecommendations({
      plan,
      availability,
      period: 2,
      minute: 10,
      playerId: goalkeeperId,
      type: 'temporary-out',
      role: 'goalkeeper',
    })

    expect(temporaryOutRecommendations.length).toBeGreaterThan(0)
    expect(temporaryOutRecommendations[0].position).toBe('MV')
    expect(chunk.activePlayerIds).not.toContain(temporaryOutRecommendations[0].playerId)

    const afterTemporaryOut = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId: goalkeeperId,
        replacementPlayerId: temporaryOutRecommendations[0].playerId,
        status: 'temporarily-out',
        role: 'goalkeeper',
      },
    })

    const replacementChunk = getChunkAtMinute(afterTemporaryOut.plan, 2, 12)

    expect(afterTemporaryOut.availability[goalkeeperId]).toBe('temporarily-out')
    expect(replacementChunk?.goalkeeperId).toBe(temporaryOutRecommendations[0].playerId)
    expect(replacementChunk?.activePlayerIds).toContain(temporaryOutRecommendations[0].playerId)
    expect(replacementChunk?.activePlayerIds).not.toContain(goalkeeperId)

    const returnRecommendations = getLiveRecommendations({
      plan: afterTemporaryOut.plan,
      availability: afterTemporaryOut.availability,
      period: 2,
      minute: 12,
      playerId: goalkeeperId,
      type: 'return',
      role: 'goalkeeper',
    })

    expect(returnRecommendations).toHaveLength(1)
    expect(returnRecommendations[0].playerId).toBe(temporaryOutRecommendations[0].playerId)
    expect(returnRecommendations[0].position).toBe('MV')

    const afterReturn = replanMatchFromLiveEvent({
      plan: afterTemporaryOut.plan,
      availability: afterTemporaryOut.availability,
      event: {
        type: 'return',
        period: 2,
        minute: 12,
        playerId: goalkeeperId,
        replacementPlayerId: returnRecommendations[0].playerId,
        role: 'goalkeeper',
      },
    })

    expect(afterReturn.availability[goalkeeperId]).toBe('available')
    expect(getChunkAtMinute(afterReturn.plan, 2, 12)?.goalkeeperId).toBe(goalkeeperId)
  })

  it('splits the active chunk for an outfield positionsbyte and keeps availability unchanged', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const leftPlayerId = chunk.lineup.VB!
    const rightPlayerId = chunk.lineup.HB!

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'position-swap',
        period: 2,
        minute: 10,
        playerId: leftPlayerId,
        targetPlayerId: rightPlayerId,
      },
    })

    const swappedChunk = getChunkAtMinute(next.plan, 2, 12)

    expect(next.availability).toEqual(availability)
    expect(next.plan.periods[1].chunks.some((candidate) => candidate.endMinute === 10)).toBe(true)
    expect(next.plan.periods[1].chunks.some((candidate) => candidate.startMinute === 10)).toBe(true)
    expect(swappedChunk?.lineup.VB).toBe(rightPlayerId)
    expect(swappedChunk?.lineup.HB).toBe(leftPlayerId)
  })

  it('supports positionsbyte with the goalkeeper and swaps the active roles immediately', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const outfieldPlayerId = chunk.lineup.VB!
    const goalkeeperId = chunk.goalkeeperId

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'position-swap',
        period: 2,
        minute: 10,
        playerId: outfieldPlayerId,
        targetPlayerId: goalkeeperId,
      },
    })

    const swappedChunk = getChunkAtMinute(next.plan, 2, 12)

    expect(swappedChunk?.goalkeeperId).toBe(outfieldPlayerId)
    expect(swappedChunk?.lineup.VB).toBe(goalkeeperId)
    expect(swappedChunk?.activePlayerIds).toContain(outfieldPlayerId)
    expect(swappedChunk?.activePlayerIds).toContain(goalkeeperId)
  })

  it('supports positionsbyte with a bench player and brings that player onto the field', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const outfieldPlayerId = chunk.lineup.VB!
    const benchPlayerId = plan.summaries.find(
      (summary) =>
        availability[summary.playerId] === 'available' &&
        !chunk.activePlayerIds.includes(summary.playerId),
    )?.playerId

    if (!benchPlayerId) {
      throw new Error('Saknar tillgänglig bänkspelare i testet.')
    }

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'position-swap',
        period: 2,
        minute: 10,
        playerId: outfieldPlayerId,
        targetPlayerId: benchPlayerId,
      },
    })

    const swappedChunk = getChunkAtMinute(next.plan, 2, 12)

    expect(swappedChunk?.lineup.VB).toBe(benchPlayerId)
    expect(swappedChunk?.activePlayerIds).toContain(benchPlayerId)
    expect(swappedChunk?.activePlayerIds).not.toContain(outfieldPlayerId)
  })

  it('rebalances future chunks after a bench positionsbyte so the outgoing player can return later', () => {
    const plan = createPlan()
    const availability = createInitialAvailabilityState(plan)
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const outfieldPlayerId = chunk.lineup.VB!
    const benchPlayerId = plan.summaries.find(
      (summary) =>
        availability[summary.playerId] === 'available' &&
        !chunk.activePlayerIds.includes(summary.playerId),
    )?.playerId

    if (!benchPlayerId) {
      throw new Error('Saknar tillgänglig bänkspelare i testet.')
    }

    const next = replanMatchFromLiveEvent({
      plan,
      availability,
      event: {
        type: 'position-swap',
        period: 2,
        minute: 10,
        playerId: outfieldPlayerId,
        targetPlayerId: benchPlayerId,
      },
    })

    const laterChunks = next.plan.periods
      .flatMap((period) => period.chunks)
      .filter((candidate) => candidate.period > 2 || candidate.startMinute >= 20)

    expect(next.availability).toEqual(availability)
    expect(laterChunks.some((candidate) => candidate.activePlayerIds.includes(outfieldPlayerId))).toBe(true)
    expect(
      Math.max(
        ...next.plan.summaries.map((summary) =>
          Math.abs(summary.totalMinutes - next.plan.fairnessTargets[summary.playerId]),
        ),
      ),
    ).toBeLessThanOrEqual(next.plan.chunkMinutes + 0.05)
  })

  it('replays temporary-out and return events correctly after a positionsbyte', () => {
    const plan = createPlan()
    const chunk = getChunkAtMinute(plan, 2, 10)

    if (!chunk) {
      throw new Error('Aktivt byteblock saknas i testet.')
    }

    const swappedOutfieldId = chunk.lineup.VB!
    const swapTargetId = chunk.lineup.HB!
    const swapEvent: LiveAdjustmentEvent = {
      type: 'position-swap',
      period: 2,
      minute: 10,
      playerId: swappedOutfieldId,
      targetPlayerId: swapTargetId,
    }

    const afterSwap = applyLiveAdjustmentEvents({
      plan,
      events: [swapEvent],
    })
    const temporaryOutRecommendation = getLiveRecommendations({
      plan: afterSwap.plan,
      availability: afterSwap.availability,
      period: 2,
      minute: 12,
      playerId: swappedOutfieldId,
      type: 'temporary-out',
    })[0]

    if (!temporaryOutRecommendation) {
      throw new Error('Saknar ersättningskandidat efter positionsbytet.')
    }

    const temporaryOutEvent: LiveAdjustmentEvent = {
      type: 'temporary-out',
      period: 2,
      minute: 12,
      playerId: swappedOutfieldId,
      replacementPlayerId: temporaryOutRecommendation.playerId,
      status: 'temporarily-out',
    }
    const afterTemporaryOut = applyLiveAdjustmentEvents({
      plan,
      events: [swapEvent, temporaryOutEvent],
    })
    const returnRecommendation = getLiveRecommendations({
      plan: afterTemporaryOut.plan,
      availability: afterTemporaryOut.availability,
      period: 2,
      minute: 14,
      playerId: swappedOutfieldId,
      type: 'return',
    })[0]

    if (!returnRecommendation) {
      throw new Error('Saknar returkandidat efter positionsbytet.')
    }

    const replayed = applyLiveAdjustmentEvents({
      plan,
      events: [
        swapEvent,
        temporaryOutEvent,
        {
          type: 'return',
          period: 2,
          minute: 14,
          playerId: swappedOutfieldId,
          replacementPlayerId: returnRecommendation.playerId,
        },
      ],
    })

    expect(afterTemporaryOut.availability[swappedOutfieldId]).toBe('temporarily-out')
    expect(getChunkAtMinute(afterTemporaryOut.plan, 2, 12)?.activePlayerIds).not.toContain(
      swappedOutfieldId,
    )
    expect(replayed.availability[swappedOutfieldId]).toBe('available')
    expect(getChunkAtMinute(replayed.plan, 2, 14)?.activePlayerIds).toContain(swappedOutfieldId)
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
