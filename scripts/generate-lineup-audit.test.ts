import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('generate-lineup-audit CLI', () => {
  it('writes the export structure for a filtered run and cleans previous output on rerun', () => {
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
        `--seeds=${seeds}`,
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      })

    runCli('1,7')

    const scenarioId = 'players-8_period-15_formation-2-3-1_subs-2_gk-auto_roster-canonical'
    const index = readJson<{ scenarioCount: number; exportCount: number }>(path.join(outDir, 'index.json'))
    const summary = readJson<{ scenarioCount: number; exportCount: number }>(
      path.join(outDir, 'summary.json'),
    )
    const manifestPath = path.join(outDir, 'scenarios', scenarioId, 'manifest.json')
    const seedOnePath = path.join(outDir, 'scenarios', scenarioId, 'seed-1.json')
    const seedSevenPath = path.join(outDir, 'scenarios', scenarioId, 'seed-7.json')

    expect(index.scenarioCount).toBe(1)
    expect(index.exportCount).toBe(2)
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
})

function readJson<T>(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
