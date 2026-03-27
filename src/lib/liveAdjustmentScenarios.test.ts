import { describe, expect, it } from 'vitest'
import {
  buildAiValidationReport,
  createLiveScenarioArtifacts,
  runLiveAdjustmentScenarios,
} from './liveAdjustmentScenarios'

describe('liveAdjustmentScenarios', () => {
  it('returns the full preset scenario set with passing hard validations', () => {
    const reports = runLiveAdjustmentScenarios()

    expect(reports).toHaveLength(24)
    expect(reports.every((report) => report.validations.hardInvariantsPassed)).toBe(true)
    expect(reports.every((report) => report.validations.unavailableTargetsFrozen)).toBe(true)
    expect(reports.map((report) => report.id)).toEqual([
      'single-mid-period-out',
      'quick-return-same-period',
      'replacement-also-out',
      'late-chunk-out',
      'before-period-break-out',
      'injury-mid-match',
      'shoe-tying-brief-absence',
      'out-for-one-period',
      'injury-at-kickoff',
      'minimal-bench-options',
      'double-temporary-out',
      'goalkeeper-penalty-bench-pick',
      'cross-period-return',
      'injury-on-replacement',
      'formation-3-2-1-mid-out',
      'short-periods-injury',
      'single-period-five-minute-out',
      'two-period-cross-break-return',
      'four-period-short-boundary-out',
      'four-period-goalkeeper-absence',
      'position-swap-outfield',
      'position-swap-goalkeeper',
      'position-swap-bench',
      'empty-bench-no-options',
    ])
  })

  it('captures scenario-specific split, injury, return, goalkeeper, and no-option behaviour', () => {
    const reports = runLiveAdjustmentScenarios()
    const singleMidScenario = reports.find((report) => report.id === 'single-mid-period-out')
    const lateChunkScenario = reports.find((report) => report.id === 'late-chunk-out')
    const periodBreakScenario = reports.find((report) => report.id === 'before-period-break-out')
    const injuryScenario = reports.find((report) => report.id === 'injury-mid-match')
    const shoeTyingScenario = reports.find((report) => report.id === 'shoe-tying-brief-absence')
    const onePeriodScenario = reports.find((report) => report.id === 'out-for-one-period')
    const kickoffInjuryScenario = reports.find((report) => report.id === 'injury-at-kickoff')
    const minimalBenchScenario = reports.find((report) => report.id === 'minimal-bench-options')
    const doubleOutScenario = reports.find((report) => report.id === 'double-temporary-out')
    const goalkeeperPenaltyScenario = reports.find(
      (report) => report.id === 'goalkeeper-penalty-bench-pick',
    )
    const crossPeriodScenario = reports.find((report) => report.id === 'cross-period-return')
    const replacementInjuryScenario = reports.find((report) => report.id === 'injury-on-replacement')
    const formationScenario = reports.find((report) => report.id === 'formation-3-2-1-mid-out')
    const shortPeriodsScenario = reports.find((report) => report.id === 'short-periods-injury')
    const singlePeriodScenario = reports.find((report) => report.id === 'single-period-five-minute-out')
    const twoPeriodScenario = reports.find((report) => report.id === 'two-period-cross-break-return')
    const fourPeriodBoundaryScenario = reports.find((report) => report.id === 'four-period-short-boundary-out')
    const fourPeriodGoalkeeperScenario = reports.find((report) => report.id === 'four-period-goalkeeper-absence')
    const outfieldSwapScenario = reports.find((report) => report.id === 'position-swap-outfield')
    const goalkeeperSwapScenario = reports.find((report) => report.id === 'position-swap-goalkeeper')
    const benchSwapScenario = reports.find((report) => report.id === 'position-swap-bench')
    const emptyBenchScenario = reports.find((report) => report.id === 'empty-bench-no-options')

    expect(singleMidScenario?.eventLog[0]?.resolvedChunkWindowIndex).toBe(2)
    expect(singleMidScenario?.eventLog[0]?.replacementFromExpectedPool).toBe(true)
    expect(singleMidScenario?.eventLog[0]?.isExactBoundaryMinute).toBe(true)
    expect(lateChunkScenario?.eventLog[0]?.chunkSplitApplied).toBe(true)
    expect(periodBreakScenario?.eventLog[0]?.chunkSplitApplied).toBe(true)
    expect(periodBreakScenario?.eventLog[0]?.resolvedChunkWindowIndex).toBe(3)
    expect(injuryScenario?.eventLog[0]?.type).toBe('injury')
    expect(injuryScenario?.finalStatus.unavailablePlayers.length).toBe(1)
    expect(injuryScenario?.eventLog[0]?.didNotReturnBeforeFinalWhistle).toBe(true)
    expect(shoeTyingScenario?.eventLog).toHaveLength(2)
    expect(shoeTyingScenario?.validations.scenarioFairnessExpectationMet).toBe(false)
    expect(onePeriodScenario?.eventLog[1]?.type).toBe('return')
    expect(kickoffInjuryScenario?.eventLog[0]?.minute).toBe(0)
    expect(minimalBenchScenario?.eventLog[0]?.recommendationPoolSize).toBe(1)
    expect(doubleOutScenario?.eventLog).toHaveLength(2)
    expect(doubleOutScenario?.eventLog.every((event) => event.poolType === 'bench')).toBe(true)
    expect(goalkeeperPenaltyScenario?.eventLog[0]?.goalkeeperPenaltyApplied).toBe(true)
    expect(goalkeeperPenaltyScenario?.eventLog[0]?.futureGoalkeeperMinutes).toBeGreaterThan(0)
    expect(crossPeriodScenario?.eventLog[1]?.period).toBe(3)
    expect(crossPeriodScenario?.eventLog[1]?.type).toBe('return')
    expect(replacementInjuryScenario?.eventLog[1]?.type).toBe('injury')
    expect(replacementInjuryScenario?.finalStatus.unavailablePlayers.length).toBe(2)
    expect(formationScenario?.initialConfig.formation).toBe('3-2-1')
    expect(['VB', 'CB', 'HB', 'VM', 'HM', 'A']).toContain(formationScenario?.eventLog[0]?.position)
    expect(shortPeriodsScenario?.initialConfig.periodMinutes).toBe(15)
    expect(singlePeriodScenario?.initialConfig.periodCount).toBe(1)
    expect(singlePeriodScenario?.validations.scenarioFairnessExpectationMet).toBe(true)
    expect(twoPeriodScenario?.eventLog[1]?.period).toBe(2)
    expect(twoPeriodScenario?.eventLog[1]?.type).toBe('return')
    expect(fourPeriodBoundaryScenario?.eventLog[0]?.period).toBe(3)
    expect(fourPeriodBoundaryScenario?.eventLog[0]?.chunkSplitApplied).toBe(true)
    expect(fourPeriodGoalkeeperScenario?.eventLog).toHaveLength(2)
    expect(fourPeriodGoalkeeperScenario?.eventLog[0]?.position).toBe('MV')
    expect(fourPeriodGoalkeeperScenario?.eventLog[1]?.type).toBe('return')
    expect(outfieldSwapScenario?.eventLog[0]?.type).toBe('position-swap')
    expect(outfieldSwapScenario?.eventLog[0]?.poolType).toBe('active-outfield')
    expect(outfieldSwapScenario?.eventLog[0]?.replacementPlayerId).toBeTruthy()
    expect(goalkeeperSwapScenario?.eventLog[0]?.poolType).toBe('active-goalkeeper')
    expect(goalkeeperSwapScenario?.eventLog[0]?.position).toBe('MV')
    expect(benchSwapScenario?.eventLog[0]?.poolType).toBe('bench')
    expect(benchSwapScenario?.eventLog[0]?.position).toBe('Bench')
    expect(emptyBenchScenario?.eventLog[1]?.recommendationPoolSize).toBe(0)
    expect(emptyBenchScenario?.eventLog[1]?.eventApplied).toBe(false)
    expect(emptyBenchScenario?.eventLog[1]?.poolType).toBe('none')
  })

  it('builds a prepared AI validation report and markdown artefacts', () => {
    const reports = runLiveAdjustmentScenarios()
    const aiReport = buildAiValidationReport(reports, '2026-03-15T12:00:00.000Z')
    const artifacts = createLiveScenarioArtifacts('2026-03-15T12:00:00.000Z')

    expect(aiReport.status).toBe('prepared')
    expect(aiReport.summary.scenarioCount).toBe(24)
    expect(aiReport.scenarios.every((scenario) => scenario.assessment.status === 'prepared')).toBe(true)

    expect(artifacts.bundle.aiValidation.reportVersion).toBe('live-scenarios-v2')
    expect(artifacts.bundle.scenarios[0]?.ai.input.prompt).toContain('Du granskar en simulering')
    expect(artifacts.markdown).toContain('# Live Scenario Simulation Report')
    expect(artifacts.markdown).toContain('## AI-checklista')
    expect(artifacts.markdown).toContain('Chunk-semantik')
    expect(artifacts.markdown).toContain('ej återvänd före slutsignal')
    expect(artifacts.markdown).toContain('## Single temporary-out mid period (`single-mid-period-out`)')
    expect(artifacts.markdown).toContain('## Injury at kickoff (`injury-at-kickoff`)')
    expect(artifacts.markdown).toContain('## Temporary-out in 1x5 format (`single-period-five-minute-out`)')
    expect(artifacts.markdown).toContain(
      '## Goalkeeper temporary-out in 4x20 format (`four-period-goalkeeper-absence`)',
    )
    expect(artifacts.markdown).toContain(
      '## Position swap with goalkeeper (`position-swap-goalkeeper`)',
    )
    expect(artifacts.markdown).toContain('## Empty bench no options (`empty-bench-no-options`)')
  })
})
