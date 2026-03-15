import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_AUDIT_LIVE_PATTERNS,
  DEFAULT_AUDIT_FORMATIONS,
  DEFAULT_AUDIT_GOALKEEPER_MODES,
  DEFAULT_AUDIT_PERIOD_MINUTES,
  DEFAULT_AUDIT_PLAYER_COUNTS,
  DEFAULT_AUDIT_ROSTER_ORDERS,
  DEFAULT_AUDIT_SEEDS,
  LINEUP_AUDIT_SCHEMA_VERSION,
  createAuditRecord,
  createAuditScenarios,
  summarizeScenarioRecords,
  type AuditFlag,
  type AuditScenario,
  type AuditScenarioFilters,
  type GeneratedAuditRecord,
} from '../src/lib/lineupAudit'
import {
  SUBSTITUTIONS_PER_PERIOD_OPTIONS,
  type SubstitutionsPerPeriod,
} from '../src/lib/substitutions'
import type { RosterOrder } from '../src/lib/playerPool'
import type { FormationKey } from '../src/lib/types'

interface ScenarioIndexEntry {
  scenarioId: string
  config: Omit<AuditScenario, 'scenarioId' | 'rosterNames'>
  manifestPath: string
  seedFiles: string[]
  aggregate: ReturnType<typeof summarizeScenarioRecords>
}

interface DimensionBucket {
  scenarioCount: number
  exportCount: number
  flaggedExportCount: number
  validationFailureCount: number
  averageNormalizedScore: number
  averageMinuteSpread: number
  maxMinuteSpread: number
  maxBenchSpread: number
  uniqueFlags: AuditFlag[]
}

interface RecordWithContext {
  scenario: AuditScenario
  record: GeneratedAuditRecord
  seedPath: string
  manifestPath: string
}

const DEFAULT_OUT_DIR = 'docs/generated-lineups'

async function main() {
  const options = parseCliArgs(process.argv.slice(2))
  const outDir = path.resolve(process.cwd(), options.outDir)
  const scenarios = createAuditScenarios(options.filters)
  const generatedAt = new Date().toISOString()

  if (options.clean) {
    await rm(outDir, { recursive: true, force: true })
  }

  await mkdir(path.join(outDir, 'scenarios'), { recursive: true })

  const scenarioEntries: ScenarioIndexEntry[] = []
  const recordsWithContext: RecordWithContext[] = []

  for (const scenario of scenarios) {
    const scenarioDir = path.join(outDir, 'scenarios', scenario.scenarioId)
    await mkdir(scenarioDir, { recursive: true })

    const seedFiles: string[] = []
    const records = options.seeds.map((seed) => {
      const record = createAuditRecord(scenario, seed)
      const seedFilePath = path.join(scenarioDir, `seed-${seed}.json`)
      const relativeSeedPath = toPosix(path.relative(outDir, seedFilePath))
      const relativeManifestPath = toPosix(path.relative(outDir, path.join(scenarioDir, 'manifest.json')))

      seedFiles.push(relativeSeedPath)
      recordsWithContext.push({
        scenario,
        record,
        seedPath: relativeSeedPath,
        manifestPath: relativeManifestPath,
      })

      return { seed, record, seedFilePath, relativeSeedPath }
    })

    for (const { record, seedFilePath } of records) {
      await writeJson(seedFilePath, record)
    }

    const aggregate = summarizeScenarioRecords(records.map(({ record }) => record))
    const manifestPath = path.join(scenarioDir, 'manifest.json')
    const relativeManifestPath = toPosix(path.relative(outDir, manifestPath))

    await writeJson(manifestPath, {
      schemaVersion: LINEUP_AUDIT_SCHEMA_VERSION,
      generatedAt,
      scenario,
      aggregate,
      seeds: records.map(({ seed, record, relativeSeedPath }) => ({
        seed,
        file: relativeSeedPath,
        flags: record.flags,
        validations: record.validations,
        normalizedScore: record.scoreBreakdown.normalized.totalScore,
        legacyScore: record.scoreBreakdown.legacy.totalScore,
        totalMinuteSpread: record.derivedMetrics.totalMinuteSpread,
        benchMinuteSpread: record.derivedMetrics.benchMinuteSpread,
      })),
    })

    scenarioEntries.push({
      scenarioId: scenario.scenarioId,
      config: {
        playerCount: scenario.playerCount,
        periodMinutes: scenario.periodMinutes,
        formation: scenario.formation,
        substitutionsPerPeriod: scenario.substitutionsPerPeriod,
        chunkMinutes: scenario.chunkMinutes,
        goalkeeperMode: scenario.goalkeeperMode,
        rosterOrder: scenario.rosterOrder,
        liveAdjustmentPattern: scenario.liveAdjustmentPattern,
      },
      manifestPath: relativeManifestPath,
      seedFiles,
      aggregate,
    })
  }

  await writeJson(path.join(outDir, 'index.json'), {
    schemaVersion: LINEUP_AUDIT_SCHEMA_VERSION,
    generatedAt,
    outDir: toPosix(path.relative(process.cwd(), outDir) || '.'),
    scenarioCount: scenarioEntries.length,
    exportCount: recordsWithContext.length,
    filters: {
      playerCounts: options.filters.playerCounts ?? [...DEFAULT_AUDIT_PLAYER_COUNTS],
      periodMinutes: options.filters.periodMinutes ?? [...DEFAULT_AUDIT_PERIOD_MINUTES],
      formations: options.filters.formations ?? [...DEFAULT_AUDIT_FORMATIONS],
      substitutions: options.filters.substitutions ?? [...SUBSTITUTIONS_PER_PERIOD_OPTIONS],
      goalkeeperModes: options.filters.goalkeeperModes ?? [...DEFAULT_AUDIT_GOALKEEPER_MODES],
      rosterOrders: options.filters.rosterOrders ?? [...DEFAULT_AUDIT_ROSTER_ORDERS],
      livePatterns: options.filters.liveAdjustmentPatterns ?? [...DEFAULT_AUDIT_LIVE_PATTERNS],
      seeds: options.seeds,
      clean: options.clean,
    },
    scenarios: scenarioEntries,
  })
  await writeJson(path.join(outDir, 'summary.json'), buildSummary(recordsWithContext, scenarioEntries, generatedAt))
  await writeFile(path.join(outDir, 'AI_REVIEW_PROMPT.md'), buildAiReviewPrompt(), 'utf8')

  process.stdout.write(
    `Generated ${recordsWithContext.length} lineup audit files across ${scenarioEntries.length} scenarios in ${outDir}\n`,
  )
}

function parseCliArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      outDir: { type: 'string' },
      playerCounts: { type: 'string' },
      periodMinutes: { type: 'string' },
      formations: { type: 'string' },
      substitutions: { type: 'string' },
      goalkeeperModes: { type: 'string' },
      rosterOrders: { type: 'string' },
      livePatterns: { type: 'string' },
      seeds: { type: 'string' },
      clean: { type: 'string' },
    },
    allowPositionals: false,
  })

  return {
    outDir: values.outDir ?? DEFAULT_OUT_DIR,
    clean: parseBoolean(values.clean),
    filters: {
      playerCounts: parseNumberList(values.playerCounts),
      periodMinutes: parseNumberList(values.periodMinutes) as Array<15 | 20> | undefined,
      formations: parseStringList(values.formations) as FormationKey[] | undefined,
      substitutions: parseNumberList(values.substitutions) as SubstitutionsPerPeriod[] | undefined,
      goalkeeperModes: parseStringList(values.goalkeeperModes) as
        | Array<AuditScenario['goalkeeperMode']>
        | undefined,
      rosterOrders: parseStringList(values.rosterOrders) as RosterOrder[] | undefined,
      liveAdjustmentPatterns: parseStringList(values.livePatterns) as
        | Array<AuditScenario['liveAdjustmentPattern']>
        | undefined,
    } satisfies AuditScenarioFilters,
    seeds: parseNumberList(values.seeds) ?? [...DEFAULT_AUDIT_SEEDS],
  }
}

function buildSummary(
  recordsWithContext: RecordWithContext[],
  scenarioEntries: ScenarioIndexEntry[],
  generatedAt: string,
) {
  return {
    schemaVersion: LINEUP_AUDIT_SCHEMA_VERSION,
    generatedAt,
    scenarioCount: scenarioEntries.length,
    exportCount: recordsWithContext.length,
    flaggedExportCount: recordsWithContext.filter(({ record }) => record.flags.length > 0).length,
    validationFailureCount: recordsWithContext.filter(({ record }) => !record.validations.allPassed).length,
    byDimension: {
      playerCount: buildDimensionBuckets(recordsWithContext, ({ scenario }) => `${scenario.playerCount}`),
      periodMinutes: buildDimensionBuckets(recordsWithContext, ({ scenario }) => `${scenario.periodMinutes}`),
      formation: buildDimensionBuckets(recordsWithContext, ({ scenario }) => scenario.formation),
      substitutionsPerPeriod: buildDimensionBuckets(
        recordsWithContext,
        ({ scenario }) => `${scenario.substitutionsPerPeriod}`,
      ),
      goalkeeperMode: buildDimensionBuckets(recordsWithContext, ({ scenario }) => scenario.goalkeeperMode),
      rosterOrder: buildDimensionBuckets(recordsWithContext, ({ scenario }) => scenario.rosterOrder),
      liveAdjustmentPattern: buildDimensionBuckets(
        recordsWithContext,
        ({ scenario }) => scenario.liveAdjustmentPattern,
      ),
    },
    topFlaggedScenarios: scenarioEntries
      .map((entry) => ({
        scenarioId: entry.scenarioId,
        manifestPath: entry.manifestPath,
        flaggedSeedCount: entry.aggregate.flaggedSeedCount,
        validationFailureCount: entry.aggregate.validationFailureCount,
        maxMinuteSpread: entry.aggregate.maxMinuteSpread,
        uniqueFlags: entry.aggregate.uniqueFlags,
      }))
      .filter((entry) => entry.flaggedSeedCount > 0 || entry.validationFailureCount > 0)
      .sort((left, right) => {
        if (right.flaggedSeedCount !== left.flaggedSeedCount) {
          return right.flaggedSeedCount - left.flaggedSeedCount
        }
        if (right.validationFailureCount !== left.validationFailureCount) {
          return right.validationFailureCount - left.validationFailureCount
        }
        return right.maxMinuteSpread - left.maxMinuteSpread
      })
      .slice(0, 25),
  }
}

function buildDimensionBuckets(
  recordsWithContext: RecordWithContext[],
  selectValue: (record: RecordWithContext) => string,
) {
  const buckets = new Map<string, RecordWithContext[]>()

  for (const recordWithContext of recordsWithContext) {
    const value = selectValue(recordWithContext)
    const existing = buckets.get(value)

    if (existing) {
      existing.push(recordWithContext)
    } else {
      buckets.set(value, [recordWithContext])
    }
  }

  return Object.fromEntries(
    [...buckets.entries()].map(([value, records]) => [value, summarizeDimensionBucket(records)]),
  ) satisfies Record<string, DimensionBucket>
}

function summarizeDimensionBucket(recordsWithContext: RecordWithContext[]): DimensionBucket {
  const scenarioIds = new Set(recordsWithContext.map(({ scenario }) => scenario.scenarioId))
  const normalizedScores = recordsWithContext.map(
    ({ record }) => record.scoreBreakdown.normalized.totalScore,
  )
  const minuteSpreads = recordsWithContext.map(({ record }) => record.derivedMetrics.totalMinuteSpread)
  const benchSpreads = recordsWithContext.map(({ record }) => record.derivedMetrics.benchMinuteSpread)

  return {
    scenarioCount: scenarioIds.size,
    exportCount: recordsWithContext.length,
    flaggedExportCount: recordsWithContext.filter(({ record }) => record.flags.length > 0).length,
    validationFailureCount: recordsWithContext.filter(({ record }) => !record.validations.allPassed)
      .length,
    averageNormalizedScore: average(normalizedScores),
    averageMinuteSpread: average(minuteSpreads),
    maxMinuteSpread: Math.max(...minuteSpreads),
    maxBenchSpread: Math.max(...benchSpreads),
    uniqueFlags: [
      ...new Set(recordsWithContext.flatMap(({ record }) => record.flags)),
    ].sort() as AuditFlag[],
  }
}

function buildAiReviewPrompt() {
  return `# AI Review Prompt

Du granskar exportdata i \`docs/generated-lineups\`. Fokusera på resultaten i exporten, inte på implementationskoden.

## Mål
- Bedöm om viktningen och normalized scoring verkar robusta och rimliga över hela exporten.
- Hitta tydliga fel, återkommande fairnessproblem och omotiverade skillnader mellan \`legacy\` och \`normalized\`.

## Arbetsordning
1. Börja med \`summary.json\` och notera dimensioner som sticker ut genom:
   - \`flaggedExportCount > 0\`
   - \`validationFailureCount > 0\`
   - icke-tomma \`uniqueFlags\`
   - hög \`maxMinuteSpread\` eller \`maxBenchSpread\`
2. Öppna \`index.json\` och välj en fast granskningsmatris:
   - 2 extrema scenarion med flest flaggade seeds, högst spreads eller tydligast avvikande aggregate-värden
   - 2 mer typiska eller medianlika scenarion utan flaggor eller valideringsfel
   - 2 kohortjämförelser där du håller så mycket som möjligt konstant men byter en dimension, till exempel formation, spelarantal eller antal byten
3. För varje valt scenario, läs \`scenarios/<scenario-id>/manifest.json\` och minst 2 \`seed-<seed>.json\`:
   - ett seed som verkar värst eller mest extremt
   - ett seed som verkar mer typiskt för samma scenario
4. Verifiera alltid mot scenarioets \`config\` i \`index.json\` eller \`manifest.json\`, inte bara mot scenario-id:t.

## Bedömningsregler
- Alla \`validationFailureCount > 0\` eller misslyckade \`validations\` är kritiska fynd.
- Alla icke-tomma \`flags\` är värdiga att kommentera, även om valideringarna passerar.
- Scenarion som ligger på eller nära högsta observerade \`totalMinuteSpread\` eller \`benchMinuteSpread\` ska granskas som hög prioritet.
- Bedöm korrekthet mot spelform, total speltid, bänktid, rotationsbredd och målvaktslåsning i scenarioets config.
- Jämför \`normalized\` mot \`legacy\` så här:
  - önskat: \`normalized\` minskar minutspridning, bänkspridning eller flaggor utan att skapa nya regelbrott
  - neutralt: skillnaderna är små och ger ingen tydlig effekt på fairness eller rotationsbredd
  - varningsflagga: \`normalized\` ökar spridning, skapar smalare rotation, ger sämre bänkfördelning eller introducerar nya flaggor

## Viktiga fält
- \`scoreBreakdown.normalized\`
- \`scoreBreakdown.legacy\`
- \`derivedMetrics.totalMinuteSpread\`
- \`derivedMetrics.benchMinuteSpread\`
- \`derivedMetrics.playerMetrics\`
- \`validations\`
- \`flags\`
- \`aggregate.flaggedSeedCount\`
- \`aggregate.maxMinuteSpread\`
- \`aggregate.maxBenchSpread\`
- \`config.playerCount\`
- \`config.periodMinutes\`
- \`config.formation\`
- \`config.substitutionsPerPeriod\`
- \`config.goalkeeperMode\`

## Önskat svar
1. En kort slutsats om viktningen verkar rimlig, delvis rimlig eller inte rimlig.
2. De tydligaste problemen, alltid med scenario-id, seed och konkreta evidensvärden.
3. Vad som ser stabilt ut över många scenarion eller kohorter.
4. Konkreta förslag på vilka penalties eller vikter som bör justeras, och varför.
5. Om inga tydliga problem hittas, säg det explicit och namnge vilka kontroller som passerade.
`
}

function parseNumberList(value: string | undefined) {
  if (!value) {
    return undefined
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = Number(item)

      if (!Number.isFinite(parsed)) {
        throw new Error(`Ogiltigt talvärde: ${item}`)
      }

      return parsed
    })
}

function parseStringList(value: string | undefined) {
  if (!value) {
    return undefined
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseBoolean(value: string | undefined) {
  if (value === undefined) {
    return true
  }

  if (value === 'true' || value === '1') {
    return true
  }

  if (value === 'false' || value === '0') {
    return false
  }

  throw new Error(`Ogiltigt booleanvärde för clean: ${value}`)
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function average(values: number[]) {
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1000) / 1000
}

function toPosix(value: string) {
  return value.split(path.sep).join(path.posix.sep)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
