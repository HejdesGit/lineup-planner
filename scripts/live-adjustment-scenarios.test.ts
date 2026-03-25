import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLiveScenarioCli } from './live-adjustment-scenarios'

describe('live-adjustment-scenarios CLI', () => {
  const cleanupTargets: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupTargets.splice(0).map((target) => rm(target, { force: true, recursive: true })),
    )
  })

  it('writes latest json and markdown artefacts', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'eik-live-scenarios-'))
    cleanupTargets.push(outputDir)

    const result = await runLiveScenarioCli({ outputDir })
    const jsonContent = await readFile(result.jsonPath, 'utf8')
    const markdownContent = await readFile(result.markdownPath, 'utf8')
    const parsed = JSON.parse(jsonContent) as {
      aiValidation: {
        status: string
        summary: {
          scenarioCount: number
        }
      }
      scenarios: Array<{
        id: string
      }>
    }

    expect(result.hardFailureCount).toBe(0)
    expect(parsed.aiValidation.status).toBe('prepared')
    expect(parsed.aiValidation.summary.scenarioCount).toBe(24)
    expect(parsed.scenarios).toHaveLength(24)
    expect(markdownContent).toContain('# Live Scenario Simulation Report')
    expect(markdownContent).toContain('## Minimal bench options (`minimal-bench-options`)')
    expect(markdownContent).toContain('## Injury mid match (`injury-mid-match`)')
    expect(markdownContent).toContain('## Temporary-out in 1x5 format (`single-period-five-minute-out`)')
    expect(markdownContent).toContain('## Goalkeeper temporary-out in 4x20 format (`four-period-goalkeeper-absence`)')
    expect(markdownContent).toContain('## Position swap with bench player (`position-swap-bench`)')
    expect(markdownContent).toContain('## Empty bench no options (`empty-bench-no-options`)')
  })
})
