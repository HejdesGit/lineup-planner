import {
  createInitialAvailabilityState,
  getLiveRecommendations,
  replanMatchFromLiveEvent,
  resolveChunkAtMinute,
} from './liveAdjustments'
import { generateMatchPlan } from './scheduler'
import type {
  ChunkPlan,
  FormationKey,
  LiveAvailabilityState,
  MatchPlan,
  OutfieldPosition,
  Player,
  PlayerAvailabilityStatus,
} from './types'

const DEFAULT_PLAYER_NAMES = [
  'Adam',
  'Anton',
  'Bill',
  'Dante',
  'David',
  'Elias',
  'Emil',
  'Gunnar',
  'Henry',
  'Jax',
]

const SCENARIO_REPORT_VERSION = 'live-scenarios-v2'
const CHUNK_SEMANTICS_DESCRIPTION =
  'Exakt chunkstart hör till nya byteblocket, exakt chunkslut hör till nästa block och bara periodens sista minutpunkt tillhör sista blocket.'
const EPSILON = 0.0005
const AI_CHECKLIST_QUESTIONS = [
  'Är händelseförloppet realistiskt för en riktig match?',
  'Verkar det rekommenderade bytet rimligt givet bänk, speltid och position?',
  'Verkar omfördelningen av speltid rättvis bland tillgängliga spelare?',
  'Är returflödet begripligt och tränarvänligt?',
  'Finns något i utfallet som ser kontraintuitivt eller misstänkt ut?',
] as const

type ScenarioStep =
  | {
    id: string
    label: string
    expectNoRecommendation?: boolean
    type: 'injury'
    period: number
    minute: number
    target: ScenarioTarget
  }
  | {
    id: string
    label: string
    expectNoRecommendation?: boolean
    type: 'temporary-out'
    period: number
    minute: number
    target: ScenarioTarget
  }
  | {
    id: string
    label: string
    expectNoRecommendation?: boolean
    type: 'return'
    period: number
    minute: number
    target: ScenarioTarget
  }

type ScenarioTarget =
  | {
    type: 'first-active-outfielder'
  }
  | {
    type: 'previous-result'
    stepId: string
    field: 'playerId' | 'replacementPlayerId'
  }

interface ScenarioPreset {
  id: string
  name: string
  description: string
  config: LiveScenarioInitialConfig
  maxExpectedFairnessDeltaMinutes?: number
  steps: ScenarioStep[]
}

interface ScenarioState {
  availability: LiveAvailabilityState
  eventLog: LiveScenarioEventLogEntry[]
  eventNarrative: string[]
  plan: MatchPlan
  stepResults: Record<
    string,
    {
      playerId: string
      replacementPlayerId: string | null
    }
  >
  unavailableLeakCheckPassed: boolean
}

interface AppliedScenarioEvent {
  playerId: string
  replacementPlayerId: string | null
  state: ScenarioState
}

export interface LiveScenarioInitialConfig {
  attempts: number
  chunkMinutes: number
  formation: FormationKey
  periodMinutes: 15 | 20
  playerCount: number
  playerNames: string[]
  seed: number
}

export interface LiveScenarioEventLogEntry {
  chunkSplitApplied: boolean
  chunkWindowIndex: number
  description: string
  didNotReturnBeforeFinalWhistle: boolean
  eventApplied: boolean
  futureGoalkeeperMinutes: number
  goalkeeperPenaltyApplied: boolean
  isExactBoundaryMinute: boolean
  label: string
  minute: number
  period: number
  playerId: string
  playerName: string
  poolType: 'bench' | 'active-outfield' | 'none'
  position: OutfieldPosition
  recommendationPoolSize: number
  recommendationRank: number
  recommendationReason: string
  recommendationScore: number
  replacementFromExpectedPool: boolean
  replacementPlayerId: string
  replacementPlayerName: string
  resolvedChunkWindowIndex: number
  stepId: string
  type: ScenarioStep['type']
}

export interface LiveScenarioPlayerRow {
  name: string
  status: PlayerAvailabilityStatus
  actualMinutes: number
  fairnessTargetMinutes: number
  deltaMinutes: number
  benchMinutes: number
}

export interface LiveScenarioValidationSummary {
  totalMinutesMatch: boolean
  fairnessTargetsMatch: boolean
  noUnavailableLeaks: boolean
  unavailableTargetsFrozen: boolean
  fairnessWithinTolerance: boolean
  scenarioFairnessExpectationMet: boolean
  recommendationLooksReasonable: boolean
  chunkSplitsApplied: boolean
  hardInvariantsPassed: boolean
  overallPassed: boolean
}

export interface LiveScenarioFinalStatus {
  didNotReturnBeforeFinalWhistle: boolean
  goalkeepers: string[]
  planScore: number
  totalActualMinutes: number
  totalBenchMinutes: number
  totalFairnessTargetMinutes: number
  unavailablePlayers: string[]
}

export interface AiScenarioChecklistItem {
  question: string
  rationale: string | null
  verdict: 'pending' | 'pass' | 'fail' | 'unclear'
}

export interface AiScenarioAssessment {
  concerns: string[]
  checklist: AiScenarioChecklistItem[]
  overallAssessment: string | null
  recommendations: string[]
  status: 'prepared' | 'validated'
}

export interface AiValidationInput {
  boundaryEventSummary: string
  chunkSemantics: string
  didNotReturnBeforeFinalWhistle: boolean
  finalPlanSummary: string
  goalkeeperPenaltySummary: string
  localValidationSummary: string
  matchConfig: LiveScenarioInitialConfig
  playerSummary: string
  prompt: string
  reportVersion: typeof SCENARIO_REPORT_VERSION
  scenarioDescription: string
  scenarioEventNarrative: string
  scenarioId: string
  scenarioName: string
}

export interface LiveScenarioReport {
  ai: {
    assessment: AiScenarioAssessment
    input: AiValidationInput
  }
  description: string
  eventLog: LiveScenarioEventLogEntry[]
  events: string[]
  fairness: {
    maxAbsDeltaMinutes: number
    players: LiveScenarioPlayerRow[]
    toleranceMinutes: number
  }
  finalStatus: LiveScenarioFinalStatus
  id: string
  initialConfig: LiveScenarioInitialConfig
  name: string
  validations: LiveScenarioValidationSummary
}

export interface AiValidationReport {
  checklistQuestions: string[]
  generatedAt: string
  reportVersion: typeof SCENARIO_REPORT_VERSION
  scenarios: Array<{
    assessment: AiScenarioAssessment
    input: AiValidationInput
    scenarioId: string
    scenarioName: string
  }>
  status: 'prepared' | 'validated'
  summary: {
    hardFailureCount: number
    overallPassed: boolean
    scenarioCount: number
    softWarningCount: number
  }
}

export interface LiveScenarioArtifactsBundle {
  aiValidation: AiValidationReport
  generatedAt: string
  reportVersion: typeof SCENARIO_REPORT_VERSION
  scenarios: LiveScenarioReport[]
}

function createScenarioConfig({
  attempts = 1,
  chunkMinutes,
  formation,
  periodMinutes,
  playerNames = DEFAULT_PLAYER_NAMES,
  seed,
}: {
  attempts?: number
  chunkMinutes: number
  formation: FormationKey
  periodMinutes: 15 | 20
  playerNames?: string[]
  seed: number
}): LiveScenarioInitialConfig {
  return {
    attempts,
    chunkMinutes,
    formation,
    periodMinutes,
    playerCount: playerNames.length,
    playerNames,
    seed,
  }
}

const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'single-mid-period-out',
    name: 'Single temporary-out mid period',
    description:
      'En vanlig matchsituation där en aktiv utespelare måste kliva av mitt i period 2 och ersättas direkt från bänken.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260315,
    }),
    steps: [
      {
        id: 'single-out',
        label: 'Mitt i period 2 måste en aktiv utespelare kliva av direkt.',
        type: 'temporary-out',
        period: 2,
        minute: 10,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'quick-return-same-period',
    name: 'Quick return in same period',
    description:
      'En spelare blir tillfälligt ute i period 1 men kommer tillbaka snabbt och måste få ett rimligt returbyte.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260316,
    }),
    steps: [
      {
        id: 'quick-out',
        label: 'En spelare kliver av i period 1 minut 6.',
        type: 'temporary-out',
        period: 1,
        minute: 6,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'quick-return',
        label: 'Samma spelare blir klar för spel tre minuter senare.',
        type: 'return',
        period: 1,
        minute: 9,
        target: { type: 'previous-result', stepId: 'quick-out', field: 'playerId' },
      },
    ],
  },
  {
    id: 'replacement-also-out',
    name: 'Replacement also goes out',
    description:
      'En ersättare kommer in i period 2 och måste själv kliva av kort därefter, vilket testar kedjehändelser i samma period.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260317,
    }),
    steps: [
      {
        id: 'chain-out-1',
        label: 'En aktiv spelare går ut i period 2 minut 10.',
        type: 'temporary-out',
        period: 2,
        minute: 10,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'chain-out-2',
        label: 'Den insatta ersättaren går också ut två minuter senare.',
        type: 'temporary-out',
        period: 2,
        minute: 12,
        target: { type: 'previous-result', stepId: 'chain-out-1', field: 'replacementPlayerId' },
      },
    ],
  },
  {
    id: 'late-chunk-out',
    name: 'Late chunk temporary-out',
    description:
      'En spelare måste lämna planen precis före slutet av ett byteblock, vilket ska ge en kort men korrekt chunk-split.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260318,
    }),
    steps: [
      {
        id: 'late-out',
        label: 'En aktiv spelare går ut i period 3 minut 19.5.',
        type: 'temporary-out',
        period: 3,
        minute: 19.5,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'before-period-break-out',
    name: 'Temporary-out before period break',
    description:
      'En spelare går ut precis före periodsignalen i ett schema med tre byteblock per period, så att nästa period måste räknas om rimligt.',
    config: createScenarioConfig({
      chunkMinutes: 20 / 3,
      formation: '3-2-1',
      periodMinutes: 20,
      seed: 20260319,
    }),
    steps: [
      {
        id: 'boundary-out',
        label: 'En aktiv spelare går ut i period 1 minut 19.75 strax före periodbyte.',
        type: 'temporary-out',
        period: 1,
        minute: 19.75,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'injury-mid-match',
    name: 'Injury mid match',
    description:
      'En aktiv utespelare skadar sig mitt i period 2 och utgår resten av matchen, så att kvarvarande speltid måste fördelas om jämt.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260321,
    }),
    steps: [
      {
        id: 'injury-out',
        label: 'En aktiv spelare skadar sig i period 2 minut 9 och kan inte återvända.',
        type: 'injury',
        period: 2,
        minute: 9,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'shoe-tying-brief-absence',
    name: 'Shoe tying brief absence',
    description:
      'En spelare måste snabbt knyta skorna, missar ungefär en minut och ska sedan kunna återvända utan att fairness drar iväg onödigt mycket.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260322,
    }),
    maxExpectedFairnessDeltaMinutes: 8,
    steps: [
      {
        id: 'shoe-tie-out',
        label: 'En aktiv spelare går av i period 1 minut 7 för att knyta skorna.',
        type: 'temporary-out',
        period: 1,
        minute: 7,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'shoe-tie-return',
        label: 'Spelaren är redo igen ungefär en minut senare.',
        type: 'return',
        period: 1,
        minute: 8,
        target: { type: 'previous-result', stepId: 'shoe-tie-out', field: 'playerId' },
      },
    ],
  },
  {
    id: 'out-for-one-period',
    name: 'Temporary-out for one full period',
    description:
      'En spelare måste utgå hela period 2 men kommer tillbaka i början av period 3, vilket ska ge en rimlig omfördelning under frånvaron.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260323,
    }),
    steps: [
      {
        id: 'period-out',
        label: 'En aktiv spelare går ut direkt vid start av period 2.',
        type: 'temporary-out',
        period: 2,
        minute: 0,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'period-return',
        label: 'Spelaren är tillbaka vid start av period 3.',
        type: 'return',
        period: 3,
        minute: 0,
        target: { type: 'previous-result', stepId: 'period-out', field: 'playerId' },
      },
    ],
  },
  {
    id: 'injury-at-kickoff',
    name: 'Injury at kickoff',
    description:
      'En spelare skadar sig direkt vid avspark och resten av matchen måste därför fördelas så jämt som möjligt mellan de tillgängliga spelarna.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260324,
    }),
    steps: [
      {
        id: 'kickoff-injury',
        label: 'En aktiv spelare skadar sig direkt vid period 1 minut 0.',
        type: 'injury',
        period: 1,
        minute: 0,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'minimal-bench-options',
    name: 'Minimal bench options',
    description:
      'Ett lag med bara en bänkspelare får en tillfälligt ute-situation där exakt en giltig ersättare finns att välja.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      playerNames: DEFAULT_PLAYER_NAMES.slice(0, 8),
      seed: 20260320,
    }),
    steps: [
      {
        id: 'minimal-out',
        label: 'En aktiv spelare går ut i period 2 minut 5 när bänken bara har en spelare.',
        type: 'temporary-out',
        period: 2,
        minute: 5,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'double-temporary-out',
    name: 'Double temporary-out in same period',
    description:
      'Två aktiva utespelare måste kliva av i samma period med kort mellanrum, vilket pressar fairness-omfördelningen i snabb följd.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260325,
    }),
    steps: [
      {
        id: 'double-out-1',
        label: 'Första spelaren går ut i period 2 minut 5.',
        type: 'temporary-out',
        period: 2,
        minute: 5,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'double-out-2',
        label: 'En andra spelare går ut i period 2 minut 7.',
        type: 'temporary-out',
        period: 2,
        minute: 7,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'goalkeeper-penalty-bench-pick',
    name: 'Goalkeeper penalty on forced bench pick',
    description:
      'När laget bara har en bänkspelare kvar tidigt i matchen måste samma spelare in trots framtida målvaktsminuter, vilket ska synas som MV-penalty i loggen.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      playerNames: DEFAULT_PLAYER_NAMES.slice(0, 8),
      seed: 20260326,
    }),
    steps: [
      {
        id: 'gk-penalty-out',
        label: 'En aktiv spelare går ut i period 1 minut 3 när bara en bänkspelare finns.',
        type: 'temporary-out',
        period: 1,
        minute: 3,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'cross-period-return',
    name: 'Cross period return',
    description:
      'En spelare går ut tidigt i period 1 och kommer inte tillbaka förrän mitt i period 3, vilket tvingar omplanering över två periodgränser.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260327,
    }),
    steps: [
      {
        id: 'cross-period-out',
        label: 'En aktiv spelare går ut i period 1 minut 5.',
        type: 'temporary-out',
        period: 1,
        minute: 5,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'cross-period-return',
        label: 'Spelaren blir redo igen först i period 3 minut 10.',
        type: 'return',
        period: 3,
        minute: 10,
        target: { type: 'previous-result', stepId: 'cross-period-out', field: 'playerId' },
      },
    ],
  },
  {
    id: 'injury-on-replacement',
    name: 'Replacement gets injured',
    description:
      'En ersättare kommer in efter ett tillfälligt avbrott men skadar sig själv kort därefter, vilket ger två omfördelningar i samma period.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      seed: 20260328,
    }),
    steps: [
      {
        id: 'replacement-injury-out',
        label: 'En aktiv spelare går ut i period 2 minut 8.',
        type: 'temporary-out',
        period: 2,
        minute: 8,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'replacement-injury',
        label: 'Den nyinsatta ersättaren skadar sig i period 2 minut 9.',
        type: 'injury',
        period: 2,
        minute: 9,
        target: {
          type: 'previous-result',
          stepId: 'replacement-injury-out',
          field: 'replacementPlayerId',
        },
      },
    ],
  },
  {
    id: 'formation-3-2-1-mid-out',
    name: '3-2-1 temporary-out mid period',
    description:
      'Samma grundscenario som mitt-i-period-byte men i formation 3-2-1 för att verifiera att livejusteringar fungerar med annan positionsuppsättning.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '3-2-1',
      periodMinutes: 20,
      seed: 20260329,
    }),
    steps: [
      {
        id: 'formation-out',
        label: 'En aktiv spelare går ut i period 2 minut 10 i formation 3-2-1.',
        type: 'temporary-out',
        period: 2,
        minute: 10,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'short-periods-injury',
    name: 'Injury with 15-minute periods',
    description:
      'Ett scenario med 15-minutersperioder där en spelare skadar sig mitt i period 1, så att chunkmatematiken för kortare matcher också valideras.',
    config: createScenarioConfig({
      chunkMinutes: 7.5,
      formation: '2-3-1',
      periodMinutes: 15,
      seed: 20260330,
    }),
    steps: [
      {
        id: 'short-period-injury',
        label: 'En aktiv spelare skadar sig i period 1 minut 7.',
        type: 'injury',
        period: 1,
        minute: 7,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
  {
    id: 'empty-bench-no-options',
    name: 'Empty bench no options',
    description:
      'När enda bänkspelaren redan är insatt och ytterligare en spelare måste kliva av ska scenariomotorn kunna rapportera att ingen ersättare finns.',
    config: createScenarioConfig({
      chunkMinutes: 10,
      formation: '2-3-1',
      periodMinutes: 20,
      playerNames: DEFAULT_PLAYER_NAMES.slice(0, 8),
      seed: 20260331,
    }),
    steps: [
      {
        id: 'empty-bench-first-out',
        label: 'En aktiv spelare går ut i period 2 minut 5 så att bänken töms.',
        type: 'temporary-out',
        period: 2,
        minute: 5,
        target: { type: 'first-active-outfielder' },
      },
      {
        id: 'empty-bench-second-out',
        label: 'En annan spelare måste också kliva av i period 2 minut 8, men ingen ersättare finns kvar.',
        expectNoRecommendation: true,
        type: 'temporary-out',
        period: 2,
        minute: 8,
        target: { type: 'first-active-outfielder' },
      },
    ],
  },
]

export function runLiveAdjustmentScenarios(): LiveScenarioReport[] {
  return SCENARIO_PRESETS.map((preset) => runScenarioPreset(preset))
}

export function createLiveScenarioArtifacts(
  generatedAt = new Date().toISOString(),
): {
  bundle: LiveScenarioArtifactsBundle
  markdown: string
} {
  const scenarios = runLiveAdjustmentScenarios()
  const aiValidation = buildAiValidationReport(scenarios, generatedAt)
  const bundle = {
    generatedAt,
    reportVersion: SCENARIO_REPORT_VERSION,
    scenarios,
    aiValidation,
  } satisfies LiveScenarioArtifactsBundle

  return {
    bundle,
    markdown: renderLiveScenarioMarkdown(bundle),
  }
}

export function buildAiValidationReport(
  scenarios: LiveScenarioReport[],
  generatedAt = new Date().toISOString(),
): AiValidationReport {
  const hardFailureCount = scenarios.filter((scenario) => !scenario.validations.hardInvariantsPassed).length
  const softWarningCount = scenarios.filter(
    (scenario) => scenario.validations.hardInvariantsPassed && !scenario.validations.overallPassed,
  ).length

  return {
    checklistQuestions: [...AI_CHECKLIST_QUESTIONS],
    generatedAt,
    reportVersion: SCENARIO_REPORT_VERSION,
    scenarios: scenarios.map((scenario) => ({
      assessment: scenario.ai.assessment,
      input: scenario.ai.input,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
    })),
    status: 'prepared',
    summary: {
      hardFailureCount,
      overallPassed: hardFailureCount === 0,
      scenarioCount: scenarios.length,
      softWarningCount,
    },
  }
}

export function renderLiveScenarioMarkdown(bundle: LiveScenarioArtifactsBundle) {
  const summaryLines = [
    '# Live Scenario Simulation Report',
    '',
    `Genererad: ${bundle.generatedAt}`,
    `Status: \`${bundle.aiValidation.status}\``,
    '',
    '## Sammanfattning',
    '',
    `- Scenarier: ${bundle.aiValidation.summary.scenarioCount}`,
    `- Hårda fel: ${bundle.aiValidation.summary.hardFailureCount}`,
    `- Mjuka varningar: ${bundle.aiValidation.summary.softWarningCount}`,
    `- Övergripande resultat: ${bundle.aiValidation.summary.overallPassed ? 'Godkänd' : 'Underkänd'}`,
    '',
    '## AI-checklista',
    '',
    ...bundle.aiValidation.checklistQuestions.map((question, index) => `${index + 1}. ${question}`),
    '',
  ]

  const scenarioSections = bundle.scenarios.flatMap((scenario) => {
    const fairnessTable = [
      '| Spelare | Status | Faktisk | Fairness | Delta | Bänk |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...scenario.fairness.players.map(
        (player) =>
          `| ${player.name} | ${player.status} | ${formatMinuteQuantity(player.actualMinutes)} | ${formatMinuteQuantity(player.fairnessTargetMinutes)} | ${formatSignedMinuteQuantity(player.deltaMinutes)} | ${formatMinuteQuantity(player.benchMinutes)} |`,
      ),
    ]
    const validationRows = [
      ['Totala minuter stämmer', scenario.validations.totalMinutesMatch],
      ['Fairness-targets summerar korrekt', scenario.validations.fairnessTargetsMatch],
      ['Tillfälligt ute-spelare läcker inte tillbaka', scenario.validations.noUnavailableLeaks],
      ['Otillgängliga spelare får inga framtida fairness-minuter', scenario.validations.unavailableTargetsFrozen],
      ['Chunk-splittar skapades korrekt', scenario.validations.chunkSplitsApplied],
      ['Fairness ligger inom tolerans', scenario.validations.fairnessWithinTolerance],
      ['Scenariots fairnessförväntan uppfylls', scenario.validations.scenarioFairnessExpectationMet],
      ['Rekommenderat byte ser rimligt ut lokalt', scenario.validations.recommendationLooksReasonable],
    ]

    return [
      `## ${scenario.name} (\`${scenario.id}\`)`,
      '',
      scenario.description,
      '',
      '### Matchkonfiguration',
      '',
      `- Spelare: ${scenario.initialConfig.playerCount}`,
      `- Formation: ${scenario.initialConfig.formation}`,
      `- Perioder: 3 x ${scenario.initialConfig.periodMinutes} min`,
      `- Byteblock: ${formatMinuteQuantity(scenario.initialConfig.chunkMinutes)} min`,
      `- Seed: ${scenario.initialConfig.seed}`,
      '',
      '### Eventlogg',
      '',
      ...scenario.events.map((event) => `- ${event}`),
      '',
      '### Lokal validering',
      '',
      ...validationRows.map(
        ([label, passed]) => `- ${passed ? 'PASS' : 'FAIL'}: ${label}`,
      ),
      '',
      '### Slutstatus',
      '',
      `- Planscore: ${formatMinuteQuantity(scenario.finalStatus.planScore)}`,
      `- Målvakter: ${scenario.finalStatus.goalkeepers.join(', ')}`,
      `- Tillfälligt ute vid slutsignal: ${formatUnavailablePlayersAtFullTime(scenario)}`,
      `- Ej återvänd före slutsignal: ${scenario.finalStatus.didNotReturnBeforeFinalWhistle ? 'Ja' : 'Nej'}`,
      `- Max delta mot fairness-target: ${formatMinuteQuantity(scenario.fairness.maxAbsDeltaMinutes)} min`,
      `- Tolerans: ${formatMinuteQuantity(scenario.fairness.toleranceMinutes)} min`,
      '',
      '### Fairness per spelare',
      '',
      ...fairnessTable,
      '',
      '### AI-validering',
      '',
      `- Status: \`${scenario.ai.assessment.status}\``,
      `- Chunk-semantik: ${scenario.ai.input.chunkSemantics}`,
      `- Boundary-händelser: ${scenario.ai.input.boundaryEventSummary}`,
      `- Målvakts-penalty: ${scenario.ai.input.goalkeeperPenaltySummary}`,
      `- Ej återvänd före slutsignal: ${scenario.ai.input.didNotReturnBeforeFinalWhistle ? 'Ja' : 'Nej'}`,
      '',
      ...scenario.ai.assessment.checklist.flatMap((item) => [
        `- [ ] ${item.question}`,
        '  Kommentar: _(AI fylls i senare)_',
      ]),
      '',
      '<details>',
      '<summary>Förberedd AI-prompt</summary>',
      '',
      '```text',
      scenario.ai.input.prompt,
      '```',
      '',
      '</details>',
      '',
    ]
  })

  return [...summaryLines, ...scenarioSections].join('\n')
}

function runScenarioPreset(preset: ScenarioPreset): LiveScenarioReport {
  let state = createScenarioState(preset.config)

  for (const step of preset.steps) {
    state = applyScenarioStep(state, step).state
  }

  return finalizeScenarioReport(preset, state)
}

function createScenarioState(config: LiveScenarioInitialConfig): ScenarioState {
  const players = config.playerNames.map((name, index) => ({
    id: `player-${index + 1}`,
    name,
  })) satisfies Player[]
  const plan = generateMatchPlan({
    attempts: config.attempts,
    chunkMinutes: config.chunkMinutes,
    formation: config.formation,
    periodMinutes: config.periodMinutes,
    players,
    seed: config.seed,
  })

  return {
    availability: createInitialAvailabilityState(plan),
    eventLog: [],
    eventNarrative: [],
    plan,
    stepResults: {},
    unavailableLeakCheckPassed: true,
  }
}

function applyScenarioStep(state: ScenarioState, step: ScenarioStep): AppliedScenarioEvent {
  const targetPlayerId = resolveScenarioTargetPlayerId(state, step)
  const resolvedChunk = resolveScenarioChunkAtMinute(state.plan, step.period, step.minute)
  const currentChunk = resolvedChunk?.chunk
  const currentPlayerNameById = Object.fromEntries(
    state.plan.summaries.map((summary) => [summary.playerId, summary.name]),
  ) as Record<string, string>

  if (!currentChunk || !resolvedChunk) {
    throw new Error(`Saknar aktivt byteblock för scenariosteget ${step.id}.`)
  }

  const recommendations = getLiveRecommendations({
    availability: state.availability,
    minute: step.minute,
    period: step.period,
    plan: state.plan,
    playerId: targetPlayerId,
    type: step.type,
  })
  const selectedRecommendation = recommendations[0]

  if (step.expectNoRecommendation) {
    if (selectedRecommendation) {
      throw new Error(`Förväntade ingen rekommendation för scenariosteget ${step.id}.`)
    }

    const nextNarrative = formatNoRecommendationNarrative({
      minute: step.minute,
      period: step.period,
      playerName: currentPlayerNameById[targetPlayerId],
      type: step.type,
    })

    return {
      playerId: targetPlayerId,
      replacementPlayerId: null,
      state: {
        ...state,
        eventLog: [
          ...state.eventLog,
          {
            chunkSplitApplied: false,
            chunkWindowIndex: resolvedChunk.chunkIndex + 1,
            description: nextNarrative,
            didNotReturnBeforeFinalWhistle: false,
            eventApplied: false,
            futureGoalkeeperMinutes: 0,
            goalkeeperPenaltyApplied: false,
            isExactBoundaryMinute: resolvedChunk.isExactBoundaryMinute,
            label: step.label,
            minute: step.minute,
            period: step.period,
            playerId: targetPlayerId,
            playerName: currentPlayerNameById[targetPlayerId],
            poolType: 'none',
            position: getDefaultOutfieldPosition(currentChunk, state.plan),
            recommendationPoolSize: 0,
            recommendationRank: 0,
            recommendationReason: 'Ingen ersättare tillgänglig.',
            recommendationScore: 0,
            replacementFromExpectedPool: true,
            replacementPlayerId: '',
            replacementPlayerName: '',
            resolvedChunkWindowIndex: resolvedChunk.chunkIndex + 1,
            stepId: step.id,
            type: step.type,
          },
        ],
        eventNarrative: [...state.eventNarrative, nextNarrative],
        stepResults: {
          ...state.stepResults,
          [step.id]: {
            playerId: targetPlayerId,
            replacementPlayerId: null,
          },
        },
      },
    }
  }

  if (!selectedRecommendation) {
    throw new Error(`Saknar rekommendation för scenariosteget ${step.id}.`)
  }

  const next =
    step.type === 'return'
      ? replanMatchFromLiveEvent({
        availability: state.availability,
        event: {
          type: 'return',
          minute: step.minute,
          period: step.period,
          playerId: targetPlayerId,
          replacementPlayerId: selectedRecommendation.playerId,
        },
        plan: state.plan,
      })
      : replanMatchFromLiveEvent({
        availability: state.availability,
        event: {
          type: step.type,
          minute: step.minute,
          period: step.period,
          playerId: targetPlayerId,
          replacementPlayerId: selectedRecommendation.playerId,
          status: step.type === 'injury' ? 'injured' : 'temporarily-out',
        },
        plan: state.plan,
      })

  const playerNameById = Object.fromEntries(
    next.plan.summaries.map((summary) => [summary.playerId, summary.name]),
  ) as Record<string, string>
  const replacementFromExpectedPool = isReplacementFromExpectedPool(
    step.type,
    currentChunk,
    selectedRecommendation.playerId,
  )
  const chunkSplitApplied = wasChunkSplitApplied(currentChunk, next.plan, step.period, step.minute)
  const nextNarrative = formatScenarioEventNarrative({
    chunkWindowIndex: resolvedChunk.chunkIndex + 1,
    futureGoalkeeperMinutes: selectedRecommendation.futureGoalkeeperMinutes,
    goalkeeperPenaltyApplied: selectedRecommendation.goalkeeperPenaltyApplied,
    isExactBoundaryMinute: resolvedChunk.isExactBoundaryMinute,
    minute: step.minute,
    period: step.period,
    playerName: playerNameById[targetPlayerId],
    position: selectedRecommendation.position,
    recommendationPoolSize: recommendations.length,
    recommendationRank: 1,
    replacementName: playerNameById[selectedRecommendation.playerId],
    type: step.type,
  })
  const unavailableLeakCheckPassed =
    step.type === 'return'
      ? state.unavailableLeakCheckPassed
      : state.unavailableLeakCheckPassed &&
      !isPlayerActiveFromMinute(next.plan, step.period, step.minute, targetPlayerId)

  return {
    playerId: targetPlayerId,
    replacementPlayerId: selectedRecommendation.playerId,
    state: {
      availability: next.availability,
      eventLog: [
        ...state.eventLog,
        {
          chunkSplitApplied,
          chunkWindowIndex: resolvedChunk.chunkIndex + 1,
          description: nextNarrative,
          didNotReturnBeforeFinalWhistle: false,
          eventApplied: true,
          futureGoalkeeperMinutes: selectedRecommendation.futureGoalkeeperMinutes,
          goalkeeperPenaltyApplied: selectedRecommendation.goalkeeperPenaltyApplied,
          isExactBoundaryMinute: resolvedChunk.isExactBoundaryMinute,
          label: step.label,
          minute: step.minute,
          period: step.period,
          playerId: targetPlayerId,
          playerName: playerNameById[targetPlayerId],
          poolType: step.type === 'return' ? 'active-outfield' : 'bench',
          position: selectedRecommendation.position,
          recommendationPoolSize: recommendations.length,
          recommendationRank: 1,
          recommendationReason: selectedRecommendation.reason,
          recommendationScore: roundMinuteValue(selectedRecommendation.score),
          replacementFromExpectedPool,
          replacementPlayerId: selectedRecommendation.playerId,
          replacementPlayerName: playerNameById[selectedRecommendation.playerId],
          resolvedChunkWindowIndex: resolvedChunk.chunkIndex + 1,
          stepId: step.id,
          type: step.type,
        },
      ],
      eventNarrative: [...state.eventNarrative, nextNarrative],
      plan: next.plan,
      stepResults: {
        ...state.stepResults,
        [step.id]: {
          playerId: targetPlayerId,
          replacementPlayerId: selectedRecommendation.playerId,
        },
      },
      unavailableLeakCheckPassed,
    },
  }
}

function resolveScenarioTargetPlayerId(state: ScenarioState, step: ScenarioStep): string {
  if (step.target.type === 'previous-result') {
    const previous = state.stepResults[step.target.stepId]

    if (!previous) {
      throw new Error(`Saknar tidigare scenariosteg ${step.target.stepId}.`)
    }

    const targetPlayerId = previous[step.target.field]

    if (!targetPlayerId) {
      throw new Error(`Saknar tidigare spelarreferens för scenariosteget ${step.id}.`)
    }

    return targetPlayerId
  }

  const chunk = resolveScenarioChunkAtMinute(state.plan, step.period, step.minute)?.chunk

  if (!chunk) {
    throw new Error(`Saknar aktivt byteblock för scenariosteget ${step.id}.`)
  }

  return getDefaultOutfieldPlayerId(chunk, state.plan)
}

function finalizeScenarioReport(preset: ScenarioPreset, state: ScenarioState): LiveScenarioReport {
  const eventLog = markUnresolvedTemporaryOuts(state.eventLog)
  const totalActualMinutes = roundMinuteValue(
    state.plan.summaries.reduce((total, summary) => total + summary.totalMinutes, 0),
  )
  const totalBenchMinutes = roundMinuteValue(
    state.plan.summaries.reduce((total, summary) => total + summary.benchMinutes, 0),
  )
  const totalFairnessTargetMinutes = roundMinuteValue(
    Object.values(state.plan.fairnessTargets).reduce((total, target) => total + target, 0),
  )
  const expectedTotalMinutes = state.plan.periodMinutes * 3 * (state.plan.positions.length + 1)
  const expectedBenchMinutes =
    state.plan.periodMinutes * 3 * state.plan.summaries.length - expectedTotalMinutes
  const players = state.plan.summaries
    .map((summary) => {
      const fairnessTargetMinutes = state.plan.fairnessTargets[summary.playerId]

      return {
        name: summary.name,
        status: state.availability[summary.playerId],
        actualMinutes: roundMinuteValue(summary.totalMinutes),
        fairnessTargetMinutes: roundMinuteValue(fairnessTargetMinutes),
        deltaMinutes: roundMinuteValue(summary.totalMinutes - fairnessTargetMinutes),
        benchMinutes: roundMinuteValue(summary.benchMinutes),
      } satisfies LiveScenarioPlayerRow
    })
    .sort((left, right) => left.name.localeCompare(right.name))
  const maxAbsDeltaMinutes = roundMinuteValue(
    Math.max(...players.map((player) => Math.abs(player.deltaMinutes))),
  )
  const toleranceMinutes = roundMinuteValue(state.plan.chunkMinutes + 0.05)
  const unavailableTargetsFrozen = players.every(
    (player) =>
      player.status === 'available' || nearlyEqual(player.actualMinutes, player.fairnessTargetMinutes),
  )
  const scenarioFairnessExpectationMet =
    maxAbsDeltaMinutes <= (preset.maxExpectedFairnessDeltaMinutes ?? toleranceMinutes) + EPSILON
  const recommendationLooksReasonable = eventLog.every(
    (event) =>
      !event.eventApplied ||
      (event.recommendationRank === 1 &&
        event.recommendationPoolSize > 0 &&
        event.replacementFromExpectedPool),
  )
  const chunkSplitsApplied = eventLog.every((event) => !event.eventApplied || event.chunkSplitApplied)
  const validations: LiveScenarioValidationSummary = {
    totalMinutesMatch:
      nearlyEqual(totalActualMinutes, expectedTotalMinutes) &&
      nearlyEqual(totalBenchMinutes, expectedBenchMinutes),
    fairnessTargetsMatch: nearlyEqual(totalFairnessTargetMinutes, expectedTotalMinutes),
    noUnavailableLeaks: state.unavailableLeakCheckPassed,
    unavailableTargetsFrozen,
    fairnessWithinTolerance: maxAbsDeltaMinutes <= toleranceMinutes + EPSILON,
    scenarioFairnessExpectationMet,
    recommendationLooksReasonable,
    chunkSplitsApplied,
    hardInvariantsPassed: false,
    overallPassed: false,
  }

  validations.hardInvariantsPassed =
    validations.totalMinutesMatch &&
    validations.fairnessTargetsMatch &&
    validations.noUnavailableLeaks &&
    validations.unavailableTargetsFrozen &&
    validations.chunkSplitsApplied
  validations.overallPassed =
    validations.hardInvariantsPassed &&
    validations.fairnessWithinTolerance &&
    validations.scenarioFairnessExpectationMet &&
    validations.recommendationLooksReasonable

  const finalStatus = {
    didNotReturnBeforeFinalWhistle: eventLog.some((event) => event.didNotReturnBeforeFinalWhistle),
    goalkeepers: state.plan.goalkeepers.map((playerId) => {
      const summary = state.plan.summaries.find((candidate) => candidate.playerId === playerId)
      return summary?.name ?? playerId
    }),
    planScore: roundMinuteValue(state.plan.score),
    totalActualMinutes,
    totalBenchMinutes,
    totalFairnessTargetMinutes,
    unavailablePlayers: state.plan.summaries
      .filter((summary) => state.availability[summary.playerId] !== 'available')
      .map((summary) => summary.name),
  } satisfies LiveScenarioFinalStatus

  const reportBase = {
    description: preset.description,
    eventLog,
    events: eventLog.map((event) => event.description),
    fairness: {
      maxAbsDeltaMinutes,
      players,
      toleranceMinutes,
    },
    finalStatus,
    id: preset.id,
    initialConfig: preset.config,
    name: preset.name,
    validations,
  }
  const aiInput = buildAiValidationInput(reportBase)
  const aiAssessment = createPreparedAiAssessment()

  return {
    ...reportBase,
    ai: {
      assessment: aiAssessment,
      input: aiInput,
    },
  }
}

function buildAiValidationInput(report: Omit<LiveScenarioReport, 'ai'>): AiValidationInput {
  const localValidationSummary = [
    `Hårda invariants: ${report.validations.hardInvariantsPassed ? 'pass' : 'fail'}`,
    `Totala minuter: ${report.validations.totalMinutesMatch ? 'pass' : 'fail'}`,
    `Fairness-targets: ${report.validations.fairnessTargetsMatch ? 'pass' : 'fail'}`,
    `Otillgänglig läcka: ${report.validations.noUnavailableLeaks ? 'pass' : 'fail'}`,
    `Otillgängliga fairness-targets frysta: ${report.validations.unavailableTargetsFrozen ? 'pass' : 'fail'}`,
    `Chunk-splittar: ${report.validations.chunkSplitsApplied ? 'pass' : 'fail'}`,
    `Fairness inom tolerans: ${report.validations.fairnessWithinTolerance ? 'pass' : 'fail'}`,
    `Scenariots fairnessförväntan: ${report.validations.scenarioFairnessExpectationMet ? 'pass' : 'fail'}`,
    `Rekommendation rimlig lokalt: ${report.validations.recommendationLooksReasonable ? 'pass' : 'fail'}`,
  ].join(' | ')
  const boundaryEventSummary = report.eventLog
    .map(
      (event) =>
        `${event.playerName} P${event.period} ${formatMinuteQuantity(event.minute)}: byteblock ${event.resolvedChunkWindowIndex}, chunkgräns ${event.isExactBoundaryMinute ? 'ja' : 'nej'}`,
    )
    .join(' | ')
  const goalkeeperPenaltySummary = report.eventLog.some((event) => event.goalkeeperPenaltyApplied)
    ? report.eventLog
      .filter((event) => event.goalkeeperPenaltyApplied)
      .map(
        (event) =>
          `${event.replacementPlayerName} fick MV-penalty (${formatMinuteQuantity(event.futureGoalkeeperMinutes)} framtida MV-min)`,
      )
      .join(' | ')
    : 'Ingen MV-penalty användes.'
  const unavailableAtFullTime = formatUnavailablePlayersAtFullTime(report)
  const finalPlanSummary = [
    `Planscore ${formatMinuteQuantity(report.finalStatus.planScore)}`,
    `Målvakter: ${report.finalStatus.goalkeepers.join(', ')}`,
    `Otillgängliga vid slutsignal: ${unavailableAtFullTime}`,
    `Chunk-semantik: ${CHUNK_SEMANTICS_DESCRIPTION}`,
    `Max fairness-delta ${formatMinuteQuantity(report.fairness.maxAbsDeltaMinutes)} min`,
  ].join('. ')
  const playerSummary = report.fairness.players
    .map(
      (player) =>
        `${player.name}: status ${player.status}, faktisk ${formatMinuteQuantity(player.actualMinutes)} min, fairness ${formatMinuteQuantity(player.fairnessTargetMinutes)} min, delta ${formatSignedMinuteQuantity(player.deltaMinutes)} min, bänk ${formatMinuteQuantity(player.benchMinutes)} min`,
    )
    .join('\n')
  const prompt = [
    'Du granskar en simulering av en 7v7-matchplanerare för ungdomsfotboll.',
    'Bedöm scenariot utifrån realism, tränarlogik och rättvis omfördelning av speltid.',
    '',
    `Scenario: ${report.name} (${report.id})`,
    `Beskrivning: ${report.description}`,
    `Matchkonfiguration: ${report.initialConfig.playerCount} spelare, formation ${report.initialConfig.formation}, 3 x ${report.initialConfig.periodMinutes} min, chunk ${formatMinuteQuantity(report.initialConfig.chunkMinutes)} min, seed ${report.initialConfig.seed}.`,
    `Chunk-semantik: ${CHUNK_SEMANTICS_DESCRIPTION}`,
    `Boundary-händelser: ${boundaryEventSummary}`,
    `Målvakts-penalty: ${goalkeeperPenaltySummary}`,
    `Ej återvänd före slutsignal: ${report.finalStatus.didNotReturnBeforeFinalWhistle ? 'ja' : 'nej'}`,
    '',
    'Eventlogg:',
    ...report.events.map((event, index) => `${index + 1}. ${event}`),
    '',
    `Lokal validering: ${localValidationSummary}`,
    `Slutlig planstatus: ${finalPlanSummary}`,
    'Spelarsammanfattning:',
    playerSummary,
    '',
    'Svara på följande checklista i ordning:',
    ...AI_CHECKLIST_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    '',
    'Returnera gärna ett strukturerat svar med checklist-punkter, övergripande bedömning, misstänkta avvikelser och förbättringsförslag.',
  ].join('\n')

  return {
    boundaryEventSummary,
    chunkSemantics: CHUNK_SEMANTICS_DESCRIPTION,
    didNotReturnBeforeFinalWhistle: report.finalStatus.didNotReturnBeforeFinalWhistle,
    finalPlanSummary,
    goalkeeperPenaltySummary,
    localValidationSummary,
    matchConfig: report.initialConfig,
    playerSummary,
    prompt,
    reportVersion: SCENARIO_REPORT_VERSION,
    scenarioDescription: report.description,
    scenarioEventNarrative: report.events.join('\n'),
    scenarioId: report.id,
    scenarioName: report.name,
  }
}

function createPreparedAiAssessment(): AiScenarioAssessment {
  return {
    concerns: [],
    checklist: AI_CHECKLIST_QUESTIONS.map((question) => ({
      question,
      rationale: null,
      verdict: 'pending',
    })),
    overallAssessment: null,
    recommendations: [],
    status: 'prepared',
  }
}

function formatScenarioEventNarrative({
  chunkWindowIndex,
  futureGoalkeeperMinutes,
  goalkeeperPenaltyApplied,
  isExactBoundaryMinute,
  minute,
  period,
  playerName,
  position,
  recommendationPoolSize,
  recommendationRank,
  replacementName,
  type,
}: {
  chunkWindowIndex: number
  futureGoalkeeperMinutes: number
  goalkeeperPenaltyApplied: boolean
  isExactBoundaryMinute: boolean
  minute: number
  period: number
  playerName: string
  position: OutfieldPosition
  recommendationPoolSize: number
  recommendationRank: number
  replacementName: string
  type: ScenarioStep['type']
}) {
  const boundaryNote = isExactBoundaryMinute ? ', exakt chunkgräns' : ''
  const goalkeeperNote = goalkeeperPenaltyApplied
    ? `, MV-penalty aktiv (${formatMinuteQuantity(futureGoalkeeperMinutes)} min kvar)`
    : ''

  if (type === 'return') {
    return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} tillbaka, ${replacementName} ut på ${position} (rek #${recommendationRank}/${recommendationPoolSize}, byteblock ${chunkWindowIndex}${boundaryNote}${goalkeeperNote}).`
  }

  if (type === 'injury') {
    return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} skadad, ${replacementName} in på ${position} (rek #${recommendationRank}/${recommendationPoolSize}, byteblock ${chunkWindowIndex}${boundaryNote}${goalkeeperNote}).`
  }

  return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} tillfälligt ute, ${replacementName} in på ${position} (rek #${recommendationRank}/${recommendationPoolSize}, byteblock ${chunkWindowIndex}${boundaryNote}${goalkeeperNote}).`
}

function formatNoRecommendationNarrative({
  minute,
  period,
  playerName,
  type,
}: {
  minute: number
  period: number
  playerName: string
  type: ScenarioStep['type']
}) {
  if (type === 'return') {
    return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} vill tillbaka, men ingen aktiv utespelare kan bytas ut just nu.`
  }

  if (type === 'injury') {
    return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} skadad, men ingen ersättare tillgänglig.`
  }

  return `P${period} ${formatMinuteQuantity(minute)}: ${playerName} tillfälligt ute, men ingen ersättare tillgänglig.`
}

function isReplacementFromExpectedPool(
  type: ScenarioStep['type'],
  chunk: ChunkPlan,
  replacementPlayerId: string,
) {
  return type === 'injury' || type === 'temporary-out'
    ? !chunk.activePlayerIds.includes(replacementPlayerId)
    : Object.values(chunk.lineup).includes(replacementPlayerId)
}

function wasChunkSplitApplied(
  currentChunk: ChunkPlan,
  nextPlan: MatchPlan,
  period: number,
  minute: number,
) {
  const touchesBoundary =
    nearlyEqual(minute, currentChunk.startMinute) || nearlyEqual(minute, currentChunk.endMinute)

  if (touchesBoundary) {
    return true
  }

  const nextChunks = nextPlan.periods[period - 1]?.chunks ?? []

  return (
    nextChunks.some((chunk) => nearlyEqual(chunk.endMinute, minute)) &&
    nextChunks.some((chunk) => nearlyEqual(chunk.startMinute, minute))
  )
}

function resolveScenarioChunkAtMinute(plan: MatchPlan, period: number, minute: number) {
  const currentPeriod = plan.periods[period - 1]

  if (!currentPeriod) {
    return null
  }

  return resolveChunkAtMinute(currentPeriod, minute)
}

function getDefaultOutfieldPlayerId(chunk: ChunkPlan, plan: MatchPlan) {
  for (const position of plan.positions) {
    const playerId = chunk.lineup[position]

    if (playerId) {
      return playerId
    }
  }

  throw new Error('Hittade ingen aktiv utespelare i byteblocket.')
}

function getDefaultOutfieldPosition(chunk: ChunkPlan, plan: MatchPlan) {
  for (const position of plan.positions) {
    if (chunk.lineup[position]) {
      return position
    }
  }

  throw new Error('Hittade ingen aktiv utespelarposition i byteblocket.')
}

function isPlayerActiveFromMinute(plan: MatchPlan, period: number, minute: number, playerId: string) {
  return plan.periods
    .flatMap((currentPeriod) => currentPeriod.chunks)
    .filter(
      (chunk) =>
        chunk.period > period ||
        (chunk.period === period && chunk.startMinute >= minute - EPSILON),
    )
    .some((chunk) => chunk.activePlayerIds.includes(playerId))
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) <= EPSILON
}

function roundMinuteValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function formatMinuteQuantity(value: number) {
  if (Number.isInteger(value)) {
    return `${value}`
  }

  return value.toFixed(2).replace(/\.?0+$/, '')
}

function formatSignedMinuteQuantity(value: number) {
  const formatted = formatMinuteQuantity(Math.abs(value))

  if (nearlyEqual(value, 0)) {
    return '0'
  }

  return value > 0 ? `+${formatted}` : `-${formatted}`
}

function markUnresolvedTemporaryOuts(eventLog: LiveScenarioEventLogEntry[]) {
  const unresolvedByPlayerId = new Map<string, number>()

  for (let index = 0; index < eventLog.length; index += 1) {
    const event = eventLog[index]

    if (event.eventApplied && (event.type === 'injury' || event.type === 'temporary-out')) {
      unresolvedByPlayerId.set(event.playerId, index)
      continue
    }

    unresolvedByPlayerId.delete(event.playerId)
  }

  return eventLog.map((event, index) => ({
    ...event,
    didNotReturnBeforeFinalWhistle: unresolvedByPlayerId.get(event.playerId) === index,
  }))
}

function formatUnavailablePlayersAtFullTime(report: Omit<LiveScenarioReport, 'ai'>) {
  if (report.finalStatus.unavailablePlayers.length === 0) {
    return 'ingen'
  }

  const unresolvedPlayers = new Set(
    report.eventLog
      .filter((event) => event.didNotReturnBeforeFinalWhistle)
      .map((event) => event.playerName),
  )

  return report.finalStatus.unavailablePlayers
    .map((name) => (unresolvedPlayers.has(name) ? `${name} (ej återvänd före slutsignal)` : name))
    .join(', ')
}
