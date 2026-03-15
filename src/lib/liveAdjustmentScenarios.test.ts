import { describe, expect, it } from 'vitest'
import {
  buildAiValidationReport,
  createLiveScenarioArtifacts,
  runLiveAdjustmentScenarios,
} from './liveAdjustmentScenarios'

describe('liveAdjustmentScenarios', () => {
  it('returns the full preset scenario set with passing hard validations', () => {
    const reports = runLiveAdjustmentScenarios()

    expect(reports).toHaveLength(6)
    expect(reports.every((report) => report.validations.hardInvariantsPassed)).toBe(true)
    expect(reports.map((report) => report.id)).toEqual([
      'single-mid-period-out',
      'quick-return-same-period',
      'replacement-also-out',
      'late-chunk-out',
      'before-period-break-out',
      'minimal-bench-options',
    ])
  })

  it('captures scenario-specific split and minimal-bench behaviour', () => {
    const reports = runLiveAdjustmentScenarios()
    const singleMidScenario = reports.find((report) => report.id === 'single-mid-period-out')
    const lateChunkScenario = reports.find((report) => report.id === 'late-chunk-out')
    const periodBreakScenario = reports.find((report) => report.id === 'before-period-break-out')
    const minimalBenchScenario = reports.find((report) => report.id === 'minimal-bench-options')

    expect(singleMidScenario?.eventLog[0]?.resolvedChunkWindowIndex).toBe(2)
    expect(singleMidScenario?.eventLog[0]?.replacementFromExpectedPool).toBe(true)
    expect(singleMidScenario?.eventLog[0]?.isExactBoundaryMinute).toBe(true)
    expect(lateChunkScenario?.eventLog[0]?.chunkSplitApplied).toBe(true)
    expect(periodBreakScenario?.eventLog[0]?.chunkSplitApplied).toBe(true)
    expect(periodBreakScenario?.eventLog[0]?.resolvedChunkWindowIndex).toBe(3)
    expect(minimalBenchScenario?.eventLog[0]?.recommendationPoolSize).toBe(1)
  })

  it('builds a prepared AI validation report and markdown artefacts', () => {
    const reports = runLiveAdjustmentScenarios()
    const aiReport = buildAiValidationReport(reports, '2026-03-15T12:00:00.000Z')
    const artifacts = createLiveScenarioArtifacts('2026-03-15T12:00:00.000Z')

    expect(aiReport.status).toBe('prepared')
    expect(aiReport.summary.scenarioCount).toBe(6)
    expect(aiReport.scenarios.every((scenario) => scenario.assessment.status === 'prepared')).toBe(true)

    expect(artifacts.bundle.aiValidation.reportVersion).toBe('live-scenarios-v2')
    expect(artifacts.bundle.scenarios[0]?.ai.input.prompt).toContain('Du granskar en simulering')
    expect(artifacts.markdown).toContain('# Live Scenario Simulation Report')
    expect(artifacts.markdown).toContain('## AI-checklista')
    expect(artifacts.markdown).toContain('Chunk-semantik')
    expect(artifacts.markdown).toContain('ej återvänd före slutsignal')
    expect(artifacts.markdown).toContain('## Single temporary-out mid period (`single-mid-period-out`)')
  })
})
