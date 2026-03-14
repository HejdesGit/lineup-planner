import { describe, expect, it } from 'vitest'
import { applyPeriodOverrides, createBoardAssignments, swapBoardAssignments } from './planOverrides'
import { generateMatchPlan } from './scheduler'
import type { Player } from './types'

function createPlayers(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p-${index + 1}`,
    name: `Spelare ${index + 1}`,
  }))
}

describe('applyPeriodOverrides', () => {
  it('updates goalkeeper periods and minutes when swapping attacker with goalkeeper', () => {
    const players = createPlayers(10)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 20260314,
      attempts: 16,
    })

    const period = plan.periods[0]
    const originalAssignments = createBoardAssignments(period)
    const overriddenAssignments = swapBoardAssignments(originalAssignments, 'A', 'MV')
    const overriddenPlan = applyPeriodOverrides(plan, {
      [period.period]: overriddenAssignments,
    })

    const originalGoalkeeperId = period.goalkeeperId
    const originalAttackerId = period.startingLineup.A!

    expect(overriddenPlan.periods[0].goalkeeperId).toBe(originalAttackerId)
    expect(overriddenPlan.periods[0].startingLineup.A).toBe(originalGoalkeeperId)

    const originalGoalkeeperSummary = overriddenPlan.summaries.find(
      (summary) => summary.playerId === originalGoalkeeperId,
    )
    const originalAttackerSummary = overriddenPlan.summaries.find(
      (summary) => summary.playerId === originalAttackerId,
    )

    expect(originalGoalkeeperSummary?.goalkeeperPeriods).not.toContain(period.period)
    expect(originalGoalkeeperSummary?.positionsPlayed).toContain('A')
    expect(originalAttackerSummary?.goalkeeperPeriods).toContain(period.period)

    const periodMinutes = overriddenPlan.periods[0].chunks.reduce(
      (total, chunk) => total + chunk.durationMinutes,
      0,
    )

    expect(originalAttackerSummary?.totalMinutes).toBeGreaterThanOrEqual(periodMinutes)
    expect(originalGoalkeeperSummary?.totalMinutes).toBeGreaterThanOrEqual(periodMinutes)
  })

  it('recomputes period chunk lineups from the overridden board assignments', () => {
    const players = createPlayers(9)
    const plan = generateMatchPlan({
      players,
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      lockedGoalkeeperIds: [null, null, null],
      seed: 5151,
      attempts: 16,
    })

    const period = plan.periods[0]
    const overriddenAssignments = swapBoardAssignments(createBoardAssignments(period), 'VB', 'VM')
    const overriddenPlan = applyPeriodOverrides(plan, {
      [period.period]: overriddenAssignments,
    })

    const vbPlayerId = overriddenPlan.periods[0].chunks[0].lineup.VB
    const vmPlayerId = overriddenPlan.periods[0].chunks[0].lineup.VM

    expect(vbPlayerId).toBe(period.startingLineup.VM)
    expect(vmPlayerId).toBe(period.startingLineup.VB)
  })
})
