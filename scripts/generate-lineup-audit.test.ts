import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAuditRecord,
  createAuditScenarios,
  type LiveAdjustmentPattern,
} from '../src/lib/lineupAudit'
import { runLiveAdjustmentScenarios } from '../src/lib/liveAdjustmentScenarios'

const tempDirs: string[] = []
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('generate-lineup-audit CLI', () => {
  it('writes the export structure for a filtered live-pattern run and cleans previous output on rerun', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lineup-audit-'))
    tempDirs.push(outDir)

    const runCli = (seeds: string) =>
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
        'run',
        'generate:lineup-audit',
        '--',
        `--outDir=${outDir}`,
        '--playerCounts=8',
        '--periodMinutes=15',
        '--formations=2-3-1',
        '--substitutions=2',
        '--goalkeeperModes=auto',
        '--rosterOrders=canonical',
        '--livePatterns=single-temporary-out',
        `--seeds=${seeds}`,
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      })

    runCli('1,7')

    const scenarioId =
      'players-8_period-15_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-single-temporary-out'
    const index = readJson<{
      scenarioCount: number
      exportCount: number
      filters: { livePatterns: string[] }
    }>(path.join(outDir, 'index.json'))
    const summary = readJson<{ scenarioCount: number; exportCount: number }>(
      path.join(outDir, 'summary.json'),
    )
    const manifestPath = path.join(outDir, 'scenarios', scenarioId, 'manifest.json')
    const seedOnePath = path.join(outDir, 'scenarios', scenarioId, 'seed-1.json')
    const seedSevenPath = path.join(outDir, 'scenarios', scenarioId, 'seed-7.json')

    expect(index.scenarioCount).toBe(1)
    expect(index.exportCount).toBe(2)
    expect(index.filters.livePatterns).toEqual(['single-temporary-out'])
    expect(summary.scenarioCount).toBe(1)
    expect(summary.exportCount).toBe(2)
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(seedOnePath)).toBe(true)
    expect(existsSync(seedSevenPath)).toBe(true)

    const manifest = readJson<{ seeds: unknown[]; aggregate: { seedCount: number } }>(manifestPath)
    expect(manifest.seeds).toHaveLength(2)
    expect(manifest.aggregate.seedCount).toBe(2)

    runCli('1')

    const nextIndex = readJson<{ exportCount: number }>(path.join(outDir, 'index.json'))
    expect(nextIndex.exportCount).toBe(1)
    expect(existsSync(seedOnePath)).toBe(true)
    expect(existsSync(seedSevenPath)).toBe(false)
  })

  it('keeps overlapping audit live-pattern semantics aligned with live scenario presets', () => {
    const patternToPreset = {
      'single-temporary-out': {
        liveScenarioId: 'single-mid-period-out',
        seed: 20260315,
      },
      'quick-return': {
        liveScenarioId: 'quick-return-same-period',
        seed: 20260316,
      },
      'injury-mid-match': {
        liveScenarioId: 'injury-mid-match',
        seed: 20260321,
      },
      'double-temporary-out': {
        liveScenarioId: 'double-temporary-out',
        seed: 20260325,
      },
      'cross-period-return': {
        liveScenarioId: 'cross-period-return',
        seed: 20260327,
      },
    } as const satisfies Record<
      Exclude<LiveAdjustmentPattern, 'none'>,
      {
        liveScenarioId: string
        seed: number
      }
    >

    const auditScenarios = createAuditScenarios({
      playerCounts: [10],
      periodMinutes: [20],
      formations: ['2-3-1'],
      substitutions: [2],
      goalkeeperModes: ['auto'],
      rosterOrders: ['canonical'],
      liveAdjustmentPatterns: Object.keys(patternToPreset) as Array<
        Exclude<LiveAdjustmentPattern, 'none'>
      >,
    })
    const auditScenarioByPattern = new Map(
      auditScenarios.map((scenario) => [scenario.liveAdjustmentPattern, scenario]),
    )
    const liveReportById = new Map(
      runLiveAdjustmentScenarios().map((report) => [report.id, report] as const),
    )

    for (const [pattern, expected] of Object.entries(patternToPreset) as Array<
      [
        Exclude<LiveAdjustmentPattern, 'none'>,
        {
          liveScenarioId: string
          seed: number
        },
      ]
    >) {
      const auditScenario = auditScenarioByPattern.get(pattern)
      const liveReport = liveReportById.get(expected.liveScenarioId)

      expect(auditScenario).toBeDefined()
      expect(liveReport).toBeDefined()
      expect(auditScenario?.scenarioId).toBe(
        `players-10_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-${pattern}`,
      )
      expect(auditScenario).toMatchObject({
        playerCount: liveReport?.initialConfig.playerCount,
        periodMinutes: liveReport?.initialConfig.periodMinutes,
        formation: liveReport?.initialConfig.formation,
        chunkMinutes: liveReport?.initialConfig.chunkMinutes,
      })

      const auditRecord = createAuditRecord(auditScenario!, expected.seed)

      expect(
        auditRecord.liveAdjustment?.events.map(({ type, period, minute }) => ({
          type,
          period,
          minute,
        })),
      ).toEqual(
        liveReport?.eventLog.map(({ type, period, minute }) => ({
          type,
          period,
          minute,
        })),
      )
    }
  })
})

function readJson<T>(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
