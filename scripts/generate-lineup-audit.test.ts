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
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('generate-lineup-audit CLI', () => {
  it('writes the export structure for a filtered live-pattern run and cleans previous output on rerun', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lineup-audit-'))
    tempDirs.push(outDir)

    const runCli = (seeds: string) =>
      execFileSync(process.execPath, [
        tsxCliPath,
        path.join(repoRoot, 'scripts', 'generate-lineup-audit.ts'),
        `--outDir=${outDir}`,
        '--playerCounts=8',
        '--periodCounts=3',
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
      'players-8_periods-3_period-15_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-single-temporary-out'
    const index = readJson<{
      scenarioCount: number
      exportCount: number
      filters: { livePatterns: string[]; periodCounts: number[] }
    }>(path.join(outDir, 'index.json'))
    const summary = readJson<{ scenarioCount: number; exportCount: number }>(
      path.join(outDir, 'summary.json'),
    )
    const promptPath = path.join(outDir, 'AI_REVIEW_PROMPT.md')
    const manifestPath = path.join(outDir, 'scenarios', scenarioId, 'manifest.json')
    const seedOnePath = path.join(outDir, 'scenarios', scenarioId, 'seed-1.json')
    const seedSevenPath = path.join(outDir, 'scenarios', scenarioId, 'seed-7.json')

    expect(index.scenarioCount).toBe(1)
    expect(index.exportCount).toBe(2)
    expect(index.filters.livePatterns).toEqual(['single-temporary-out'])
    expect(index.filters.periodCounts).toEqual([3])
    expect(summary.scenarioCount).toBe(1)
    expect(summary.exportCount).toBe(2)
    expect(existsSync(promptPath)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(seedOnePath)).toBe(true)
    expect(existsSync(seedSevenPath)).toBe(true)

    const prompt = readFileSync(promptPath, 'utf8')
    expect(prompt).toContain('## Bedömningsregler')
    expect(prompt).toContain('> config.chunkMinutes')
    expect(prompt).toContain('0.5 * config.chunkMinutes')
    expect(prompt).toContain('prioriteringsordning')

    const manifest = readJson<{ seeds: unknown[]; aggregate: { seedCount: number } }>(manifestPath)
    expect(manifest.seeds).toHaveLength(2)
    expect(manifest.aggregate.seedCount).toBe(2)

    runCli('1')

    const nextIndex = readJson<{ exportCount: number }>(path.join(outDir, 'index.json'))
    expect(nextIndex.exportCount).toBe(1)
    expect(existsSync(seedOnePath)).toBe(true)
    expect(existsSync(seedSevenPath)).toBe(false)
  })

  it('exports the repeated-manual-goalkeeper audit mode without duplicate-goalkeeper failures', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lineup-audit-'))
    tempDirs.push(outDir)

    execFileSync(process.execPath, [
      tsxCliPath,
      path.join(repoRoot, 'scripts', 'generate-lineup-audit.ts'),
      `--outDir=${outDir}`,
      '--playerCounts=9',
      '--periodCounts=3',
      '--periodMinutes=15',
      '--formations=2-3-1',
      '--substitutions=2',
      '--goalkeeperModes=lock-same-goalkeeper-all-periods',
      '--rosterOrders=canonical',
      '--seeds=1',
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    })

    const scenarioId =
      'players-9_periods-3_period-15_formation-2-3-1_subs-2_gk-lock-same-goalkeeper-all-periods_roster-canonical_live-none'
    const index = readJson<{ scenarioCount: number; filters: { goalkeeperModes: string[] } }>(
      path.join(outDir, 'index.json'),
    )
    const seed = readJson<{
      input: { lockedGoalkeeperIds: Array<string | null> }
      plan: { goalkeepers: string[] }
      validations: { lockedGoalkeepersRespected: boolean }
      flags: string[]
    }>(path.join(outDir, 'scenarios', scenarioId, 'seed-1.json'))

    expect(index.scenarioCount).toBe(1)
    expect(index.filters.goalkeeperModes).toEqual(['lock-same-goalkeeper-all-periods'])
    expect(seed.input.lockedGoalkeeperIds).toHaveLength(3)
    expect(new Set(seed.input.lockedGoalkeeperIds.filter(Boolean)).size).toBe(1)
    expect(seed.plan.goalkeepers).toEqual(seed.input.lockedGoalkeeperIds)
    expect(seed.validations.lockedGoalkeepersRespected).toBe(true)
    expect(seed.flags).not.toContain('duplicate-goalkeepers')
    expect(seed.flags).not.toContain('goalkeeper-lock-mismatch')
  })

  it('keeps dense four-sub isolated-block cases visible in seed metrics without counting them as hard-flagged exports', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lineup-audit-'))
    tempDirs.push(outDir)

    execFileSync(process.execPath, [
      tsxCliPath,
      path.join(repoRoot, 'scripts', 'generate-lineup-audit.ts'),
      `--outDir=${outDir}`,
      '--playerCounts=11,12',
      '--periodCounts=3',
      '--periodMinutes=20',
      '--formations=3-2-1',
      '--substitutions=3,4',
      '--goalkeeperModes=auto',
      '--rosterOrders=canonical',
      '--seeds=1',
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    })

    const summary = readJson<{
      scenarioCount: number
      exportCount: number
      flaggedExportCount: number
    }>(path.join(outDir, 'summary.json'))
    const denseWarningManifest = readJson<{
      aggregate: { flaggedSeedCount: number; uniqueFlags: string[] }
    }>(
      path.join(
        outDir,
        'scenarios',
        'players-12_periods-3_period-20_formation-3-2-1_subs-4_gk-auto_roster-canonical_live-none',
        'manifest.json',
      ),
    )
    const denseWarningSeed = readJson<{
      derivedMetrics: {
        isolatedPlayBlockSeverity: string
        playersWithExcessIsolatedPlayBlocks: Array<{ name: string; isolatedPlayBlocks: number }>
      }
      flags: string[]
    }>(
      path.join(
        outDir,
        'scenarios',
        'players-12_periods-3_period-20_formation-3-2-1_subs-4_gk-auto_roster-canonical_live-none',
        'seed-1.json',
      ),
    )
    const denseFlagManifest = readJson<{
      aggregate: { flaggedSeedCount: number; uniqueFlags: string[] }
    }>(
      path.join(
        outDir,
        'scenarios',
        'players-12_periods-3_period-20_formation-3-2-1_subs-3_gk-auto_roster-canonical_live-none',
        'manifest.json',
      ),
    )
    const denseFlagSeed = readJson<{
      derivedMetrics: { isolatedPlayBlockSeverity: string }
      flags: string[]
    }>(
      path.join(
        outDir,
        'scenarios',
        'players-12_periods-3_period-20_formation-3-2-1_subs-3_gk-auto_roster-canonical_live-none',
        'seed-1.json',
      ),
    )

    expect(summary.scenarioCount).toBe(4)
    expect(summary.exportCount).toBe(4)
    expect(summary.flaggedExportCount).toBe(1)

    expect(denseWarningManifest.aggregate.flaggedSeedCount).toBe(0)
    expect(denseWarningManifest.aggregate.uniqueFlags).toEqual([])
    expect(denseWarningSeed.derivedMetrics.isolatedPlayBlockSeverity).toBe('warning')
    expect(denseWarningSeed.derivedMetrics.playersWithExcessIsolatedPlayBlocks).toEqual([
      { name: 'David', isolatedPlayBlocks: 4 },
      { name: 'John', isolatedPlayBlocks: 4 },
    ])
    expect(denseWarningSeed.flags).toEqual([])

    expect(denseFlagManifest.aggregate.flaggedSeedCount).toBe(1)
    expect(denseFlagManifest.aggregate.uniqueFlags).toEqual(['isolated-play-blocks'])
    expect(denseFlagSeed.derivedMetrics.isolatedPlayBlockSeverity).toBe('flag')
    expect(denseFlagSeed.flags).toContain('isolated-play-blocks')
  })

  it('exports the single-period short-window continuity improvement without isolated-play flags', () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lineup-audit-'))
    tempDirs.push(outDir)

    execFileSync(process.execPath, [
      tsxCliPath,
      path.join(repoRoot, 'scripts', 'generate-lineup-audit.ts'),
      `--outDir=${outDir}`,
      '--playerCounts=10',
      '--periodCounts=1',
      '--periodMinutes=20',
      '--formations=2-3-1',
      '--substitutions=4',
      '--goalkeeperModes=auto',
      '--rosterOrders=canonical',
      '--seeds=1',
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    })

    const seed = readJson<{
      derivedMetrics: {
        isolatedPlayBlockSeverity: string
        playerMetrics: Array<{
          name: string
          isolatedPlayBlocks: number
          longestPlayStreakWindows: number
          chunkStates: Array<'P' | 'B'>
        }>
      }
      flags: string[]
    }>(
      path.join(
        outDir,
        'scenarios',
        'players-10_periods-1_period-20_formation-2-3-1_subs-4_gk-auto_roster-canonical_live-none',
        'seed-1.json',
      ),
    )
    const gunnar = seed.derivedMetrics.playerMetrics.find((metrics) => metrics.name === 'Gunnar')

    expect(seed.derivedMetrics.isolatedPlayBlockSeverity).toBe('ok')
    expect(seed.flags).toEqual([])
    expect(gunnar).toMatchObject({
      isolatedPlayBlocks: 0,
      longestPlayStreakWindows: 2,
      chunkStates: ['B', 'P', 'P', 'B'],
    })
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
      'position-swap-outfield': {
        liveScenarioId: 'position-swap-outfield',
        seed: 20260401,
      },
      'position-swap-goalkeeper': {
        liveScenarioId: 'position-swap-goalkeeper',
        seed: 20260402,
      },
      'position-swap-bench': {
        liveScenarioId: 'position-swap-bench',
        seed: 20260403,
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
      periodCounts: [3],
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
        `players-10_periods-3_period-20_formation-2-3-1_subs-2_gk-auto_roster-canonical_live-${pattern}`,
      )
      expect(auditScenario).toMatchObject({
        playerCount: liveReport?.initialConfig.playerCount,
        periodCount: liveReport?.initialConfig.periodCount,
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
      expect(
        auditRecord.liveAdjustment?.events.every((event) =>
          event.type === 'position-swap' ? Boolean(event.targetPlayerId) : true,
        ),
      ).toBe(true)
    }
  })
})

function readJson<T>(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
