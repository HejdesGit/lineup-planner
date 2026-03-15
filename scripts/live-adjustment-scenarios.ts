import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLiveScenarioArtifacts } from '../src/lib/liveAdjustmentScenarios.ts'

interface LiveScenarioCliResult {
  hardFailureCount: number
  jsonPath: string
  markdownPath: string
  outputDir: string
}

export async function runLiveScenarioCli({
  outputDir = resolve(process.cwd(), 'output/scenarios/live'),
}: {
  outputDir?: string
} = {}): Promise<LiveScenarioCliResult> {
  const { bundle, markdown } = createLiveScenarioArtifacts()
  const resolvedOutputDir = resolve(outputDir)
  const jsonPath = resolve(resolvedOutputDir, 'latest.json')
  const markdownPath = resolve(resolvedOutputDir, 'latest.md')

  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, markdown, 'utf8')

  const hardFailureCount = bundle.aiValidation.summary.hardFailureCount

  console.log(`Scenario artefacts written to ${resolvedOutputDir}`)
  console.log(`- JSON: ${jsonPath}`)
  console.log(`- Markdown: ${markdownPath}`)
  console.log(
    `- Scenarios: ${bundle.aiValidation.summary.scenarioCount}, hard failures: ${hardFailureCount}, soft warnings: ${bundle.aiValidation.summary.softWarningCount}`,
  )

  for (const scenario of bundle.scenarios) {
    console.log(
      `  ${scenario.validations.overallPassed ? 'PASS' : 'WARN'} ${scenario.id}: ${scenario.name}`,
    )
  }

  return {
    hardFailureCount,
    jsonPath,
    markdownPath,
    outputDir: resolvedOutputDir,
  }
}

function parseOutputDirFromArgs(argv: string[]) {
  const outputDirIndex = argv.findIndex((argument) => argument === '--output-dir')

  if (outputDirIndex === -1) {
    return undefined
  }

  return argv[outputDirIndex + 1]
}

async function main() {
  try {
    const outputDir = parseOutputDirFromArgs(process.argv.slice(2))
    const result = await runLiveScenarioCli({ outputDir })

    if (result.hardFailureCount > 0) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
