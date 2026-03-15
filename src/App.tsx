import {
  type ChangeEvent,
  type Dispatch,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragOverEvent,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSwappingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import { Lock, LockOpen } from 'lucide-react'
import { generateMatchPlan } from './lib/scheduler'
import {
  GOALKEEPER_SLOT,
  applyPeriodOverrides,
  areBoardAssignmentsEqual,
  createBoardAssignments,
  getBoardBenchSlots,
  getBoardLineup,
  isBenchSlot,
  normalizePeriodOverrides,
  swapBoardAssignments,
  type BoardSlotId,
  type PeriodBoardOverrides,
} from './lib/planOverrides'
import {
  buildLineupShareUrl,
  clearLineupShareUrl,
  decodeLineupSnapshot,
  encodeLineupSnapshot,
  LINEUP_SHARE_QUERY_PARAM,
} from './lib/share'
import {
  FORMATION_PRESETS,
  type FormationKey,
  type GeneratedConfig,
  type GoalkeeperSelections,
  type Lineup,
  type MatchPlan,
  type OutfieldPosition,
  type PeriodPlan,
  type Player,
} from './lib/types'

const BASE_PLAYER_POOL = [
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
  'Joar',
  'John',
  'Leonel',
  'Lev',
  'Liam',
  'Lion',
  'Lorik',
  'Loui',
  'Madison',
  'Marvin',
  'Matvii',
  'Nathan',
  'Noel',
  'Oscar',
  'Rio Mateo',
  'Ruben',
  'Sami',
  'Svante',
  'Viktor',
  'Vilhelm',
  'Zakarias',
] as const

const DEFAULT_NAMES = BASE_PLAYER_POOL.slice(0, 10)
const DEFAULT_PLAYER_INPUT = DEFAULT_NAMES.join('\n')
const DEFAULT_FORMATION: FormationKey = '2-3-1'
const DEFAULT_CHUNK_MINUTES = 10
const DEFAULT_SHARE_SEED = 20260314
const SHARE_LINK_ERROR_MESSAGE = 'Ogiltig delningslänk. Standarduppställningen visas i stället.'
const SUBSTITUTIONS_PER_PERIOD_OPTIONS = [2, 3, 4] as const
const SUBSTITUTIONS_PER_PERIOD_TO_CHUNK_MINUTES = {
  15: {
    2: 7.5,
    3: 5,
    4: 3.75,
  },
  20: {
    2: 10,
    3: 20 / 3,
    4: 5,
  },
} as const

interface FormState {
  playerInput: string
  periodMinutes: 15 | 20
  formation: FormationKey
  chunkMinutes: number
  goalkeeperSelections: GoalkeeperSelections
  errors: string[]
}

type FormAction =
  | { type: 'setPlayerInput'; value: string }
  | { type: 'setPeriodMinutes'; value: 15 | 20 }
  | { type: 'setFormation'; value: FormationKey }
  | { type: 'setChunkMinutes'; value: number }
  | { type: 'setGoalkeeperSelection'; periodIndex: number; value: string }
  | { type: 'setErrors'; value: string[] }
  | { type: 'clearErrors' }

const INITIAL_FORM_STATE: FormState = {
  playerInput: DEFAULT_PLAYER_INPUT,
  periodMinutes: 20,
  formation: DEFAULT_FORMATION,
  chunkMinutes: DEFAULT_CHUNK_MINUTES,
  goalkeeperSelections: ['', '', ''],
  errors: [],
}

interface InitialAppState {
  formState: FormState
  generatedConfig: GeneratedConfig
  plan: MatchPlan | null
  periodOverrides: PeriodBoardOverrides
  shouldSyncShareUrl: boolean
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setPlayerInput':
      return { ...state, playerInput: action.value }
    case 'setPeriodMinutes':
      return {
        ...state,
        periodMinutes: action.value,
        chunkMinutes: getNormalizedChunkMinutes(action.value, state.chunkMinutes),
      }
    case 'setFormation':
      return { ...state, formation: action.value }
    case 'setChunkMinutes':
      return { ...state, chunkMinutes: action.value }
    case 'setGoalkeeperSelection':
      return {
        ...state,
        goalkeeperSelections: state.goalkeeperSelections.map((selection, index) =>
          index === action.periodIndex ? action.value : selection,
        ) as GoalkeeperSelections,
      }
    case 'setErrors':
      return { ...state, errors: action.value }
    case 'clearErrors':
      return { ...state, errors: [] }
    default:
      return state
  }
}

function App() {
  const [initialState] = useState(createInitialAppState)
  const [formState, dispatch] = useReducer(formReducer, initialState.formState)
  const [isPending, startTransition] = useTransition()
  const [generatedConfig, setGeneratedConfig] = useState(initialState.generatedConfig)
  const [plan, setPlan] = useState<MatchPlan | null>(initialState.plan)
  const [periodOverrides, setPeriodOverrides] = useState<PeriodBoardOverrides>(initialState.periodOverrides)
  const [shouldSyncShareUrl, setShouldSyncShareUrl] = useState(initialState.shouldSyncShareUrl)

  const rosterNames = useMemo(() => getRosterNames(formState.playerInput), [formState.playerInput])
  const playerOptions = rosterNames
  const normalizedOverrides = useMemo(
    () => (plan ? normalizePeriodOverrides(plan, periodOverrides) : {}),
    [periodOverrides, plan],
  )
  const displayPlan = useMemo(
    () => (plan ? applyPeriodOverrides(plan, normalizedOverrides) : null),
    [normalizedOverrides, plan],
  )

  const playerNameById = displayPlan
    ? Object.fromEntries(displayPlan.summaries.map((summary) => [summary.playerId, summary.name]))
    : {}

  useEffect(() => {
    if (!plan || !shouldSyncShareUrl) {
      return
    }

    const nextUrl = createLineupShareUrl(generatedConfig, normalizedOverrides)

    if (window.location.href !== nextUrl) {
      window.history.replaceState(null, '', nextUrl)
    }
  }, [generatedConfig, normalizedOverrides, plan, shouldSyncShareUrl])

  const handleGenerate = () => {
    try {
      const players = normalizePlayers(formState.playerInput)
      const nextPlan = generateMatchPlan({
        players,
        periodMinutes: formState.periodMinutes,
        formation: formState.formation,
        chunkMinutes: formState.chunkMinutes,
        lockedGoalkeeperIds: mapGoalkeeperSelectionsToIds(players, formState.goalkeeperSelections),
        seed: Date.now(),
      })
      const nextGeneratedConfig = buildGeneratedConfig({
        players,
        playerInput: formState.playerInput,
        periodMinutes: formState.periodMinutes,
        formation: formState.formation,
        chunkMinutes: formState.chunkMinutes,
        goalkeeperSelections: formState.goalkeeperSelections,
        seed: nextPlan.seed,
      })
      dispatch({ type: 'clearErrors' })
      startTransition(() => {
        setGeneratedConfig(nextGeneratedConfig)
        setPlan(nextPlan)
        setPeriodOverrides({})
        setShouldSyncShareUrl(true)
      })
    } catch (error) {
      dispatch({
        type: 'setErrors',
        value: [error instanceof Error ? error.message : 'Något gick fel vid generering.'],
      })
      window.history.replaceState(null, '', clearLineupShareUrl(window.location.href))
      setPlan(null)
      setPeriodOverrides({})
      setShouldSyncShareUrl(false)
    }
  }

  const handleShareViaWhatsApp = () => {
    if (!plan) {
      return
    }

    const shareUrl = createLineupShareUrl(generatedConfig, normalizedOverrides)
    window.history.replaceState(null, '', shareUrl)
    setShouldSyncShareUrl(true)
    window.open(
      `https://wa.me/?text=${encodeURIComponent(`Uppställning EIK:\n${shareUrl}`)}`,
      '_blank',
      'noopener,noreferrer',
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden text-stone-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-3 py-4 sm:gap-8 sm:px-6 sm:py-6 lg:px-8">
        <header className="grid gap-5 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 shadow-board backdrop-blur sm:rounded-[2rem] sm:gap-6 sm:p-6 md:grid-cols-[1.1fr_0.9fr]">
          <HeroPanel />
          <SettingsPanel
            state={formState}
            dispatch={dispatch}
            playerOptions={playerOptions}
            rosterCount={rosterNames.length}
            isPending={isPending}
            canShare={Boolean(plan)}
            onGenerate={handleGenerate}
            onShareViaWhatsApp={handleShareViaWhatsApp}
          />
        </header>

        {displayPlan && plan ? (
          <>
            <MatchOverview plan={displayPlan} playerNameById={playerNameById} />

            <section className="grid gap-5 xl:grid-cols-3">
              {displayPlan.periods.map((period, index) => (
                <PeriodCard
                  key={`${displayPlan.seed}-${period.period}`}
                  period={period}
                  boardAssignments={
                    normalizedOverrides[period.period] ?? createBoardAssignments(plan.periods[index])
                  }
                  nameById={playerNameById}
                  defaultLockedSlots={
                    displayPlan.lockedGoalkeepers[index] ? [GOALKEEPER_SLOT] : []
                  }
                  onSwapSlots={(sourceSlot, targetSlot) => {
                    setShouldSyncShareUrl(true)
                    setPeriodOverrides((current) => {
                      const currentAssignments =
                        normalizedOverrides[period.period] ?? createBoardAssignments(plan.periods[index])

                      return {
                        ...current,
                        [period.period]: swapBoardAssignments(
                          currentAssignments,
                          sourceSlot,
                          targetSlot,
                        ),
                      }
                    })
                  }}
                />
              ))}
            </section>

            <PlayerMinutesSection plan={displayPlan} />
          </>
        ) : (
          <section className="rounded-[1.75rem] border border-white/10 bg-black/20 p-8 text-center text-stone-300">
            Fyll i minst 8 unika spelare för att skapa ett matchschema.
          </section>
        )}
      </div>
    </main>
  )
}

function HeroPanel() {
  return (
    <div className="space-y-4 sm:space-y-5">
      <p className="font-mono text-xs uppercase tracking-[0.32em] text-clay-200">
        7v7 match planner
      </p>
      <div className="space-y-3">
        <h1 className="max-w-[13ch] font-display text-[2.85rem] font-extrabold leading-[0.92] text-white sm:max-w-xl sm:text-5xl lg:text-6xl">
          Planera målvakt, utespelare och byten utan att låsa laget i samma roller.
        </h1>
        <p className="max-w-2xl text-sm leading-7 text-stone-300 sm:text-base sm:leading-6">
          Målvakten hålls utanför formationen. Du väljer mellan 2-3-1 och 3-2-1, samt
          2, 3 eller 4 planerade byten per period.
        </p>
      </div>
    </div>
  )
}

function SettingsPanel({
  state,
  dispatch,
  playerOptions,
  rosterCount,
  isPending,
  canShare,
  onGenerate,
  onShareViaWhatsApp,
}: {
  state: FormState
  dispatch: Dispatch<FormAction>
  playerOptions: string[]
  rosterCount: number
  isPending: boolean
  canShare: boolean
  onGenerate: () => void
  onShareViaWhatsApp: () => void
}) {
  const showChunkRecommendation = rosterCount >= 10 && getSubstitutionsPerPeriod(state.periodMinutes, state.chunkMinutes) <= 2
  const substitutionOptions = getSubstitutionOptions(state.periodMinutes, state.chunkMinutes)

  return (
    <section className="rounded-[1.5rem] border border-clay-300/20 bg-black/20 p-4 sm:rounded-[1.75rem] sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-[2rem] font-bold leading-none text-white sm:text-2xl">
            Matchinställningar
          </h2>
          <p className="mt-2 max-w-md text-sm text-stone-300">
            Skriv namn, välj formation och justera hur ofta du vill kunna byta.
          </p>
        </div>
        <div className="w-fit rounded-full border border-clay-300/20 bg-clay-500/10 px-3 py-1 font-mono text-xs text-clay-100">
          3 perioder
        </div>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label
              htmlFor="players"
              className="font-mono text-xs uppercase tracking-[0.24em] text-stone-300"
            >
              Spelare
            </label>
            <div className="flex flex-wrap gap-2">
              {[8, 10, 12].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() =>
                    dispatch({ type: 'setPlayerInput', value: createRandomRoster(count) })
                  }
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-stone-200 transition hover:border-clay-300/40 hover:bg-clay-500/10"
                >
                  Fyll {count}
                </button>
              ))}
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: 'setPlayerInput', value: BASE_PLAYER_POOL.join('\n') })
                }
                className="rounded-full border border-clay-300/20 bg-clay-500/10 px-3 py-1.5 text-xs font-medium text-clay-50 transition hover:border-clay-300/40 hover:bg-clay-500/20"
              >
                Fyll i Alla
              </button>
            </div>
          </div>
          <textarea
            id="players"
            value={state.playerInput}
            onChange={(event) => dispatch({ type: 'setPlayerInput', value: event.target.value })}
            className="min-h-44 w-full rounded-[1.1rem] border border-white/10 bg-pitch-900/70 px-4 py-3.5 font-body text-base text-white placeholder:text-stone-500 focus:border-clay-300/60 focus:outline-none focus:ring-2 focus:ring-clay-300/20 sm:min-h-48 sm:rounded-[1.25rem] sm:py-4"
            placeholder="En spelare per rad"
          />
          <p className="text-xs text-stone-400">
            En rad per spelare. Du kan också separera namn med komma. Fyll 8/10/12 slumpas
            från baslistan, medan Fyll i Alla lägger in hela spelarpoolen.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Matchformat" htmlFor="match-format">
            <SelectControl
              id="match-format"
              value={state.periodMinutes}
              onChange={(event) =>
                dispatch({ type: 'setPeriodMinutes', value: Number(event.target.value) as 15 | 20 })
              }
            >
              <option value={15}>3 x 15 minuter</option>
              <option value={20}>3 x 20 minuter</option>
            </SelectControl>
          </Field>

          <Field label="Formation" htmlFor="formation">
            <SelectControl
              id="formation"
              value={state.formation}
              onChange={(event) => dispatch({ type: 'setFormation', value: event.target.value as FormationKey })}
            >
              {Object.keys(FORMATION_PRESETS).map((formationKey) => (
                <option key={formationKey} value={formationKey}>
                  {formationKey}
                </option>
              ))}
            </SelectControl>
          </Field>
        </div>

        <div className="grid gap-4">
          <Field
            label="Antal byten"
            htmlFor="chunk-minutes"
            hint="Appen delar perioden i jämna byteblock utifrån hur många byten du vill planera per period."
          >
            <SelectControl
              id="chunk-minutes"
              value={state.chunkMinutes}
              onChange={(event) => dispatch({ type: 'setChunkMinutes', value: Number(event.target.value) })}
            >
              {substitutionOptions.map((option) => (
                <option key={`${state.periodMinutes}-${option.value}`} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectControl>
          </Field>
          {showChunkRecommendation ? (
            <div className="rounded-[1.25rem] border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-50">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber-100/80">
                Rekommendation
              </p>
              <p className="mt-1">
                Med {rosterCount} spelare och {getSubstitutionsPerPeriod(state.periodMinutes, state.chunkMinutes)} byten
                per period kan väntan bli lång. Prova gärna 3 eller 4 byten om du vill korta bänkpassen.
              </p>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Field
              key={`goalkeeper-period-${index + 1}`}
              label={`Målvakt period ${index + 1}`}
              htmlFor={`goalkeeper-period-${index + 1}`}
              hint="Lämna på Auto om appen ska välja."
            >
              <SelectControl
                id={`goalkeeper-period-${index + 1}`}
                value={state.goalkeeperSelections[index]}
                onChange={(event) =>
                  dispatch({
                    type: 'setGoalkeeperSelection',
                    periodIndex: index,
                    value: event.target.value,
                  })
                }
              >
                <option value="">Auto</option>
                {playerOptions.map((playerName) => (
                  <option key={`goalkeeper-${index + 1}-${playerName}`} value={playerName}>
                    {playerName}
                  </option>
                ))}
              </SelectControl>
            </Field>
          ))}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onGenerate}
            disabled={isPending}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-clay-400 px-6 font-display text-lg font-bold text-clay-900 transition hover:bg-clay-300 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          >
            {isPending ? 'Genererar...' : 'Generera uppställning'}
          </button>
          <button
            type="button"
            onClick={onShareViaWhatsApp}
            disabled={!canShare}
            className="inline-flex h-12 w-full items-center justify-center rounded-full border border-white/10 bg-white/5 px-6 font-display text-lg font-bold text-white transition hover:border-clay-300/40 hover:bg-clay-500/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            Dela via WhatsApp
          </button>
        </div>

        {state.errors.length > 0 ? (
          <div className="rounded-[1.25rem] border border-red-400/20 bg-red-950/40 px-4 py-3 text-sm text-red-100">
            {state.errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function MatchOverview({
  plan,
  playerNameById,
}: {
  plan: MatchPlan
  playerNameById: Record<string, string>
}) {
  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-white/5 p-5 backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-white">Matchöversikt</h2>
          <p className="text-sm text-stone-300">
            Seed {plan.seed} · Score {plan.score.toFixed(1)}
          </p>
        </div>
        <div className="rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-xs text-stone-300">
          {plan.periodMinutes} min/period
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryChip
          label="Målvakter"
          value={plan.goalkeepers.map((goalkeeperId) => playerNameById[goalkeeperId]).join(', ')}
        />
        <SummaryChip label="Formation" value={plan.formation} />
        <SummaryChip label="Spelare" value={`${plan.summaries.length} st`} />
        <SummaryChip
          label="Byten"
          value={`${getSubstitutionsPerPeriod(plan.periodMinutes, plan.chunkMinutes)} per period`}
        />
        <SummaryChip label="Totaltid" value={`${plan.periodMinutes * 3} min match`} />
      </div>
    </section>
  )
}

function PlayerMinutesSection({ plan }: { plan: MatchPlan }) {
  const playerNameById = Object.fromEntries(plan.summaries.map((summary) => [summary.playerId, summary.name]))

  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-black/20 p-5 backdrop-blur">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-bold text-white">Speltid per spelare</h2>
          <p className="text-sm text-stone-300">
            Dubbelkolla minuter, bänktid och vilka roller varje spelare hann prova. Fäll ut en spelare för detaljer per period och byteblock.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {plan.summaries.map((summary) => {
          const playerDetail = buildPlayerDetail(plan, summary.playerId, playerNameById)
          const minuteBreakdown = getMinuteBreakdown(summary, plan.periodMinutes)

          return (
            <details
              key={summary.playerId}
              className="group rounded-[1.5rem] border border-white/10 bg-white/5 p-4 open:border-clay-300/20 open:bg-white/[0.07]"
            >
              <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-2xl font-bold text-white">{summary.name}</h3>
                    <p className="font-mono text-xs uppercase tracking-[0.24em] text-stone-400">
                      {summary.goalkeeperPeriods.length > 0
                        ? `MV i period ${summary.goalkeeperPeriods.join(', ')}`
                        : 'Ingen målvaktsperiod'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-clay-400 px-3 py-2 text-right text-clay-900">
                      <p className="font-display text-2xl font-black">{minuteBreakdown.totalMinutes}</p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.22em]">totalt</p>
                    </div>
                    <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-300">
                      Visa detaljer
                    </span>
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 text-sm text-stone-300 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber-100/80">
                      MV
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">
                      {minuteBreakdown.goalkeeperMinutes} min
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-100/80">
                      Utespelare
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">
                      {minuteBreakdown.outfieldMinutes} min
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                      Bänktid
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">{summary.benchMinutes} min</dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                      Positioner
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">
                      {summary.positionsPlayed.length > 0 ? summary.positionsPlayed.join(', ') : 'MV'}
                    </dd>
                  </div>
                </dl>

                <p className="mt-4 text-sm text-stone-300">
                  MV: {minuteBreakdown.goalkeeperMinutes} min + Utespelare:{' '}
                  {minuteBreakdown.outfieldMinutes} min = {minuteBreakdown.totalMinutes} min totalt
                </p>

                <div className="mt-4 flex flex-wrap gap-2">
                  {summary.goalkeeperPeriods.length > 0 || summary.roleGroups.length > 0 ? (
                    <>
                      {summary.goalkeeperPeriods.length > 0 ? (
                        <span className="rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-100">
                          MV
                        </span>
                      ) : null}
                      {summary.roleGroups.map((group) => (
                        <span
                          key={group}
                          className="rounded-full border border-clay-300/20 bg-clay-500/10 px-3 py-1 text-xs font-medium text-clay-100"
                        >
                          {group}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-stone-300">
                      Endast målvakt
                    </span>
                  )}
                </div>
              </summary>

              <div className="mt-5 border-t border-white/10 pt-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <DetailStat label="MV-tid" value={`${minuteBreakdown.goalkeeperMinutes} min`} />
                  <DetailStat label="Utespelartid" value={`${minuteBreakdown.outfieldMinutes} min`} />
                  <DetailStat label="Totaltid" value={`${minuteBreakdown.totalMinutes} min`} />
                  <DetailStat label="Bänktid" value={`${summary.benchMinutes} min`} />
                  <DetailStat
                    label="Startroller"
                    value={playerDetail.periods.map((period) => period.startStatus).join(' · ')}
                  />
                </div>

                <div className="mt-4 space-y-3">
                  {playerDetail.periods.map((periodDetail) => (
                    <div
                      key={`${summary.playerId}-period-${periodDetail.period}`}
                      className="rounded-[1.2rem] border border-white/10 bg-black/20 p-3"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-clay-200">
                            Period {periodDetail.period}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-white">
                            {periodDetail.totalMinutes} min totalt · {periodDetail.goalkeeperMinutes} min MV ·{' '}
                            {periodDetail.outfieldMinutes} min utespelare
                          </p>
                        </div>
                        <div className="text-sm text-stone-300">
                          Start: <span className="font-medium text-white">{periodDetail.startStatus}</span>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2">
                        {periodDetail.windows.map((windowDetail) => (
                          <div
                            key={`${summary.playerId}-period-${periodDetail.period}-window-${windowDetail.windowIndex}`}
                            className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2"
                          >
                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                                  {windowDetail.rangeLabel}
                                </p>
                                <p className="text-sm text-white">{windowDetail.statusLabel}</p>
                              </div>
                              {windowDetail.swapLabel ? (
                                <p className="text-xs text-stone-400">{windowDetail.swapLabel}</p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

function PeriodCard({
  period,
  boardAssignments,
  nameById,
  onSwapSlots,
  defaultLockedSlots,
}: {
  period: PeriodPlan
  boardAssignments: Record<BoardSlotId, string>
  nameById: Record<string, string>
  onSwapSlots: (sourceSlot: BoardSlotId, targetSlot: BoardSlotId) => void
  defaultLockedSlots: BoardSlotId[]
}) {
  const [manualLockedSlots, setManualLockedSlots] = useState<BoardSlotId[]>([])
  const [dismissedDefaultLockedSlots, setDismissedDefaultLockedSlots] = useState<BoardSlotId[]>([])
  const [activeSlot, setActiveSlot] = useState<BoardSlotId | null>(null)
  const [overSlot, setOverSlot] = useState<BoardSlotId | null>(null)
  const displayLineup = getBoardLineup(boardAssignments, period.positions)
  const displayGoalkeeperId = boardAssignments[GOALKEEPER_SLOT]
  const displayGoalkeeperName = nameById[displayGoalkeeperId] ?? period.goalkeeperName
  const startBenchSlots = useMemo(() => getBoardBenchSlots(boardAssignments), [boardAssignments])
  const startBenchNames = useMemo(
    () =>
      startBenchSlots.map((slotId) => {
        const playerId = boardAssignments[slotId]
        return nameById[playerId] ?? '-'
      }),
    [boardAssignments, nameById, startBenchSlots],
  )
  const lockedSlots = useMemo(
    () =>
      Array.from(
        new Set([
          ...defaultLockedSlots.filter((slotId) => !dismissedDefaultLockedSlots.includes(slotId)),
          ...manualLockedSlots,
        ]),
      ),
    [defaultLockedSlots, dismissedDefaultLockedSlots, manualLockedSlots],
  )
  const canPreviewSwap = Boolean(
    activeSlot &&
      overSlot &&
      activeSlot !== overSlot &&
      !lockedSlots.includes(activeSlot) &&
    !lockedSlots.includes(overSlot),
  )
  const previewAssignments = useMemo(
    () => {
      if (!canPreviewSwap || !activeSlot || !overSlot) {
        return boardAssignments
      }

      return swapBoardAssignments(boardAssignments, activeSlot, overSlot)
    },
    [activeSlot, boardAssignments, canPreviewSwap, overSlot],
  )
  const activePlayerName = activeSlot ? boardAssignments[activeSlot] : null

  const handleToggleLock = (slotId: BoardSlotId) => {
    if (manualLockedSlots.includes(slotId)) {
      setManualLockedSlots((current) => current.filter((entry) => entry !== slotId))
      return
    }

    if (defaultLockedSlots.includes(slotId) && !dismissedDefaultLockedSlots.includes(slotId)) {
      setDismissedDefaultLockedSlots((current) => [...current, slotId])
      return
    }

    if (defaultLockedSlots.includes(slotId) && dismissedDefaultLockedSlots.includes(slotId)) {
      setDismissedDefaultLockedSlots((current) => current.filter((entry) => entry !== slotId))
      return
    }

    setManualLockedSlots((current) => [...current, slotId])
  }

  const handleSwapAttempt = (sourceSlot: BoardSlotId, targetSlot: BoardSlotId) => {
    if (sourceSlot === targetSlot) {
      return
    }

    if (lockedSlots.includes(sourceSlot) || lockedSlots.includes(targetSlot)) {
      return
    }

    onSwapSlots(sourceSlot, targetSlot)
  }

  return (
    <article className="rounded-[1.5rem] border border-white/10 bg-white/5 p-3.5 backdrop-blur sm:rounded-[1.75rem] sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-clay-200">Period {period.period}</p>
          <h2 className="mt-1 font-display text-2xl font-black text-white sm:text-3xl">
            MV: {displayGoalkeeperName}
          </h2>
          <p className="mt-1 text-sm text-stone-300">Formation: {period.formation}</p>
        </div>
        <div className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-left sm:w-auto sm:max-w-[18rem] sm:text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">Startbänk</p>
          <p className="mt-1 text-sm text-white">
            {startBenchNames.length ? startBenchNames.join(', ') : 'Ingen'}
          </p>
        </div>
      </div>

      <FormationBoard
        formation={period.formation}
        boardAssignments={previewAssignments}
        nameById={nameById}
        lockedSlots={lockedSlots}
        onToggleLock={handleToggleLock}
        onSwapSlots={handleSwapAttempt}
        activeSlot={activeSlot}
        overSlot={overSlot}
        activePlayerName={activePlayerName ? nameById[activePlayerName] ?? null : null}
        onDragStart={setActiveSlot}
        onDragOver={setOverSlot}
        onDragEnd={() => {
          setActiveSlot(null)
          setOverSlot(null)
        }}
      />

      <div className="mt-4 space-y-3 sm:mt-5">
        {period.chunks.map((chunk, chunkIndex) => {
          const nextChunk = period.chunks[chunkIndex + 1]
          const currentIncomingIds = new Set(chunk.substitutions.map((substitution) => substitution.playerInId))
          const nextOutgoingIds = new Set(nextChunk?.substitutions.map((substitution) => substitution.playerOutId) ?? [])
          const chunkLineup = chunkIndex === 0 ? displayLineup : chunk.lineup

          return (
            <div
              key={chunk.chunkIndex}
              className="rounded-[1.1rem] border border-white/10 bg-black/20 px-3 py-3 sm:rounded-[1.25rem] sm:px-4"
            >
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.22em] text-stone-500">
                    {formatMinuteRangeLabel(chunk.startMinute, chunk.endMinute)}
                  </p>
                  <p className="text-sm text-stone-300">
                    Byteblock {chunk.windowIndex + 1} · {formatMinuteDuration(chunk.durationMinutes)}
                  </p>
                </div>
                <p className="text-sm text-stone-300">
                  Bänk: {chunk.substitutes.length > 0 ? chunk.substitutes.join(', ') : 'Ingen'}
                </p>
              </div>

              <p className="mb-3 text-xs text-stone-400">
                {chunk.substitutions.length > 0 ? (
                  <>
                    <span>Byte: </span>
                    {formatChunkSubstitutions(chunk.substitutions, nameById)}
                  </>
                ) : (
                  'Startuppställning eller inga byten i detta byteblock.'
                )}
              </p>
              <ChunkFormationBoard
                formation={period.formation}
                lineup={chunkLineup}
                currentIncomingIds={currentIncomingIds}
                nextOutgoingIds={nextOutgoingIds}
                nameById={nameById}
              />
            </div>
          )
        })}
      </div>
    </article>
  )
}

function FormationBoard({
  formation,
  boardAssignments,
  nameById,
  lockedSlots,
  onToggleLock,
  onSwapSlots,
  activeSlot,
  overSlot,
  activePlayerName,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  formation: FormationKey
  boardAssignments: Record<BoardSlotId, string>
  nameById: Record<string, string>
  lockedSlots: BoardSlotId[]
  onToggleLock: (slotId: BoardSlotId) => void
  onSwapSlots: (sourceSlot: BoardSlotId, targetSlot: BoardSlotId) => void
  activeSlot: BoardSlotId | null
  overSlot: BoardSlotId | null
  activePlayerName: string | null
  onDragStart: (slotId: BoardSlotId | null) => void
  onDragOver: (slotId: BoardSlotId | null) => void
  onDragEnd: () => void
}) {
  const hoveredSlotRef = useRef<BoardSlotId | null>(null)
  const slotCollisionDetection = useMemo<CollisionDetection>(
    () => (args) => {
      const pointerX = args.pointerCoordinates?.x
      const pointerY = args.pointerCoordinates?.y

      if (typeof pointerX === 'number' && typeof pointerY === 'number') {
        const directHit = args.droppableContainers.find((container) => {
          const rect = args.droppableRects.get(container.id)

          if (!rect) {
            return false
          }

          return (
            pointerX >= rect.left &&
            pointerX <= rect.left + rect.width &&
            pointerY >= rect.top &&
            pointerY <= rect.top + rect.height
          )
        })

        if (directHit) {
          return [
            {
              id: directHit.id,
              data: { droppableContainer: directHit, value: 1 },
            },
          ]
        }

        return []
      }

      return closestCenter(args)
    },
    [],
  )
  const lineup = useMemo(
    () => getBoardLineup(boardAssignments, FORMATION_PRESETS[formation].positions),
    [boardAssignments, formation],
  )
  const goalkeeperId = boardAssignments[GOALKEEPER_SLOT]
  const benchSlots = useMemo(() => getBoardBenchSlots(boardAssignments), [boardAssignments])
  const slotOrder = useMemo<BoardSlotId[]>(
    () => [...FORMATION_PRESETS[formation].positions, GOALKEEPER_SLOT, ...benchSlots],
    [benchSlots, formation],
  )
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 10 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
  const activePlayer = activePlayerName
  const activeTone = activeSlot ? getBoardSlotTone(activeSlot) : null

  const syncHoveredSlot = (slotId: BoardSlotId | null) => {
    hoveredSlotRef.current = slotId
    onDragOver(slotId)
  }

  const handleDragStart = (event: DragStartEvent) => {
    hoveredSlotRef.current = null
    onDragStart(event.active.id as BoardSlotId)
  }

  const handleDragOver = (event: DragOverEvent) => {
    const candidateSlot = event.over ? (event.over.id as BoardSlotId) : null

    if (candidateSlot && lockedSlots.includes(candidateSlot)) {
      syncHoveredSlot(null)
      return
    }

    syncHoveredSlot(candidateSlot)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    const targetSlot = hoveredSlotRef.current ?? (over ? (over.id as BoardSlotId) : null)
    hoveredSlotRef.current = null
    onDragEnd()

    if (!targetSlot || active.id === targetSlot || lockedSlots.includes(targetSlot)) {
      return
    }

    onSwapSlots(active.id as BoardSlotId, targetSlot)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={slotCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={onDragEnd}
    >
      <SortableContext items={slotOrder} strategy={rectSwappingStrategy}>
        <div className="rounded-[1.35rem] border border-pitch-300/20 bg-[radial-gradient(circle_at_top,_rgba(141,184,99,0.24),_transparent_34%),linear-gradient(180deg,rgba(13,43,19,0.96),rgba(7,25,11,0.98))] p-2.5 sm:rounded-[1.75rem] sm:p-4">
          <div className="rounded-[1.2rem] border-white/10 p-3 sm:rounded-[1.5rem] sm:p-4">
            <div className="mb-3 flex justify-end">
              <p className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-right font-mono text-[10px] uppercase tracking-[0.22em] text-stone-300">
                Dra eller tryck-dra för att byta plats
                <span className="block text-[9px] tracking-[0.18em] text-stone-500">Låsta brickor ligger fast</span>
              </p>
            </div>
            <div className="space-y-3 sm:space-y-4">
              {benchSlots.length > 0 ? (
                <div className="rounded-[1rem] border border-white/10 bg-black/20 px-3 py-3 sm:rounded-[1.2rem]">
                  <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">
                      Startbänk
                    </p>
                    <p className="text-[10px] text-stone-500">Dra in på plan eller byt tillbaka till bänk</p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {benchSlots.map((slotId) => (
                      <PositionBadge
                        key={slotId}
                        slotId={slotId}
                        label={getBoardSlotLabel(slotId)}
                        player={nameById[boardAssignments[slotId]] ?? '-'}
                        tone="bench"
                        locked={lockedSlots.includes(slotId)}
                        dragState={
                          activeSlot === slotId ? 'source' : overSlot === slotId ? 'target' : 'idle'
                        }
                        onToggleLock={onToggleLock}
                        onHoverSlot={
                          activeSlot
                            ? (nextSlotId) => {
                              if (nextSlotId !== activeSlot && !lockedSlots.includes(nextSlotId)) {
                                syncHoveredSlot(nextSlotId)
                              }
                            }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {FORMATION_PRESETS[formation].rows.map((row) => (
                <FormationRow key={`${formation}-${row.join('-')}`}>
                  {row.map((position) => (
                    <PositionBadge
                      key={position}
                      slotId={position}
                      label={position}
                      player={readLineupPlayer(lineup, position, nameById)}
                      tone={getPositionTone(position)}
                      locked={lockedSlots.includes(position)}
                      dragState={
                        activeSlot === position
                          ? 'source'
                          : overSlot === position
                            ? 'target'
                            : 'idle'
                      }
                      onToggleLock={onToggleLock}
                      onHoverSlot={
                        activeSlot
                          ? (slotId) => {
                            if (slotId !== activeSlot && !lockedSlots.includes(slotId)) {
                              syncHoveredSlot(slotId)
                            }
                          }
                          : undefined
                      }
                    />
                  ))}
                </FormationRow>
              ))}
              <div className="mx-auto mt-1.5 flex max-w-32 justify-center border-t border-dashed border-white/10 pt-3 sm:mt-2 sm:max-w-40 sm:pt-4">
                <PositionBadge
                  slotId={GOALKEEPER_SLOT}
                  label="MV"
                  player={nameById[goalkeeperId] ?? '-'}
                  tone="gk"
                  locked={lockedSlots.includes(GOALKEEPER_SLOT)}
                  dragState={
                    activeSlot === GOALKEEPER_SLOT
                      ? 'source'
                      : overSlot === GOALKEEPER_SLOT
                        ? 'target'
                        : 'idle'
                  }
                  onToggleLock={onToggleLock}
                  onHoverSlot={
                    activeSlot
                      ? (slotId) => {
                        if (slotId !== activeSlot && !lockedSlots.includes(slotId)) {
                          syncHoveredSlot(slotId)
                        }
                      }
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
        {activeSlot && activePlayer && activeTone ? (
          <PositionBadgeCard
            label={getBoardSlotLabel(activeSlot)}
            player={activePlayer}
            tone={activeTone}
            locked={lockedSlots.includes(activeSlot)}
            dragState="idle"
            isOverlay
            onToggleLock={undefined}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={htmlFor}
        className="font-mono text-xs uppercase tracking-[0.24em] text-stone-300"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-stone-400">{hint}</p> : null}
    </div>
  )
}

function SelectControl({
  id,
  value,
  onChange,
  children,
}: {
  id: string
  value: string | number
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void
  children: ReactNode
}) {
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={onChange}
        className="w-full appearance-none rounded-[1.1rem] border border-white/10 bg-pitch-900/70 px-4 py-3 pr-14 text-base text-white focus:border-clay-300/60 focus:outline-none focus:ring-2 focus:ring-clay-300/20 sm:rounded-2xl"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-center text-white/90">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 7 6 6 6-6" />
        </svg>
      </span>
    </div>
  )
}

function FormationRow({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center gap-2 sm:gap-3">{children}</div>
}

function PositionBadge({
  slotId,
  label,
  player,
  tone,
  locked,
  dragState,
  onToggleLock,
  onHoverSlot,
}: {
  slotId: BoardSlotId
  label: string
  player: string
  tone: 'def' | 'mid' | 'att' | 'gk' | 'bench'
  locked: boolean
  dragState: 'idle' | 'source' | 'target'
  onToggleLock: (slotId: BoardSlotId) => void
  onHoverSlot?: (slotId: BoardSlotId) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({
    id: slotId,
    disabled: locked,
  })

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'z-20' : undefined}
      onPointerEnter={() => {
        onHoverSlot?.(slotId)
      }}
      onPointerMove={() => {
        onHoverSlot?.(slotId)
      }}
    >
      <PositionBadgeCard
        label={label}
        player={player}
        tone={tone}
        locked={locked}
        dragState={isDragging ? 'source' : dragState}
        onToggleLock={onToggleLock ? () => onToggleLock(slotId) : undefined}
        dragHandleProps={locked ? undefined : { ...attributes, ...listeners }}
      />
    </div>
  )
}

function PositionBadgeCard({
  label,
  player,
  tone,
  locked,
  dragState,
  isOverlay = false,
  onToggleLock,
  dragHandleProps,
}: {
  label: string
  player: string
  tone: 'def' | 'mid' | 'att' | 'gk' | 'bench'
  locked: boolean
  dragState: 'idle' | 'source' | 'target'
  isOverlay?: boolean
  onToggleLock?: () => void
  dragHandleProps?: HTMLAttributes<HTMLDivElement>
}) {
  const tones = {
    def: 'border-sky-300/35 bg-[linear-gradient(180deg,rgba(56,189,248,0.22),rgba(12,74,110,0.34))] text-sky-50 shadow-[inset_0_1px_0_rgba(186,230,253,0.12),0_0_0_1px_rgba(12,74,110,0.16)]',
    mid: 'border-emerald-300/35 bg-[linear-gradient(180deg,rgba(74,222,128,0.2),rgba(6,78,59,0.34))] text-emerald-50 shadow-[inset_0_1px_0_rgba(209,250,229,0.12),0_0_0_1px_rgba(6,78,59,0.16)]',
    att: 'border-rose-300/35 bg-[linear-gradient(180deg,rgba(251,113,133,0.2),rgba(127,29,29,0.34))] text-rose-50 shadow-[inset_0_1px_0_rgba(255,228,230,0.12),0_0_0_1px_rgba(127,29,29,0.16)]',
    gk: 'border-amber-300/35 bg-[linear-gradient(180deg,rgba(251,191,36,0.22),rgba(120,53,15,0.34))] text-amber-50 shadow-[inset_0_1px_0_rgba(254,243,199,0.12),0_0_0_1px_rgba(120,53,15,0.16)]',
    bench:
      'border-white/15 bg-[linear-gradient(180deg,rgba(250,250,249,0.08),rgba(28,25,23,0.28))] text-stone-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_0_1px_rgba(28,25,23,0.16)]',
  }

  return (
    <div
      className={`group relative min-w-[5.4rem] touch-manipulation select-none rounded-[1rem] border px-2 py-2 text-center sm:min-w-28 sm:rounded-[1.2rem] sm:px-3 sm:py-3 ${tones[tone]} ${locked ? 'ring-2 ring-clay-200/40 shadow-[0_0_0_2px_rgba(251,191,36,0.16)]' : ''
        } ${isOverlay
          ? 'scale-[1.02] shadow-2xl opacity-95'
          : dragState === 'source'
            ? 'scale-[0.97] opacity-70 ring-2 ring-clay-200/30 shadow-[0_0_0_1px_rgba(251,191,36,0.12)]'
            : dragState === 'target'
              ? 'ring-2 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_0_28px_rgba(16,185,129,0.12)]'
              : ''
        }`}
      {...dragHandleProps}
    >
      {locked ? (
        <>
          <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[repeating-linear-gradient(-45deg,rgba(251,191,36,0.14),rgba(251,191,36,0.14)_7px,transparent_7px,transparent_15px)] opacity-70" />
        </>
      ) : null}
      {onToggleLock ? (
        <button
          type="button"
          onPointerDown={(event) => {
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.stopPropagation()
            onToggleLock()
          }}
          className={`absolute -right-2 -top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur sm:-right-2.5 sm:-top-2.5 sm:h-9 sm:w-9 ${
            locked
              ? 'border-clay-200/50 bg-clay-400/25 text-clay-50 shadow-[0_0_0_1px_rgba(251,191,36,0.1)]'
              : 'border-white/10 bg-black/20 text-stone-300 hover:border-white/20 hover:text-white'
          }`}
          aria-label={locked ? `Lås upp ${player} på ${label}` : `Lås ${player} på ${label}`}
        >
          {locked ? (
            <Lock className="h-3 w-3 sm:h-4 sm:w-4" />
          ) : (
            <LockOpen className="h-3 w-3 sm:h-4 sm:w-4" />
          )}
        </button>
      ) : null}
      <div className="pointer-events-none relative z-[1]">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] opacity-75">{label}</p>
        <p className="mt-1 text-xs font-semibold sm:text-sm">{player}</p>
      </div>
    </div>
  )
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.35rem] border border-white/10 bg-black/20 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-white">{value}</p>
    </div>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-white">{value}</p>
    </div>
  )
}

function ChunkFormationBoard({
  formation,
  lineup,
  currentIncomingIds,
  nextOutgoingIds,
  nameById,
}: {
  formation: FormationKey
  lineup: Lineup
  currentIncomingIds: Set<string>
  nextOutgoingIds: Set<string>
  nameById: Record<string, string>
}) {
  return (
    <div className="rounded-[1rem] border border-pitch-300/15 bg-[radial-gradient(circle_at_top,_rgba(141,184,99,0.12),_transparent_40%),linear-gradient(180deg,rgba(10,31,14,0.82),rgba(6,20,9,0.9))] p-2.5 sm:rounded-[1.2rem] sm:p-3">
      <div className="space-y-2.5">
        {FORMATION_PRESETS[formation].rows.map((row, rowIndex) => (
          <div
            key={`chunk-board-${formation}-${row.join('-')}`}
            className={`flex items-center justify-center gap-2 ${rowIndex === 0 ? 'pb-0.5' : ''}`}
          >
            {row.map((position) => {
              const playerId = lineup[position]
              const playerName = readLineupPlayer(lineup, position, nameById)
              const isIncomingNow = playerId ? currentIncomingIds.has(playerId) : false
              const isOutgoingNext = playerId ? nextOutgoingIds.has(playerId) : false

              return (
                <ChunkPositionBadge
                  key={`chunk-board-${position}-${playerId ?? 'empty'}`}
                  label={position}
                  player={playerName}
                  tone={getPositionTone(position)}
                  emphasis={getChunkPositionEmphasis(isIncomingNow, isOutgoingNext)}
                  isSingle={row.length === 1}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChunkPositionBadge({
  label,
  player,
  tone,
  emphasis,
  isSingle = false,
}: {
  label: string
  player: string
  tone: 'def' | 'mid' | 'att' | 'gk'
  emphasis: 'idle' | 'incoming' | 'outgoing' | 'swing'
  isSingle?: boolean
}) {
  const toneClasses = {
    def: 'border-sky-300/22 bg-[linear-gradient(180deg,rgba(56,189,248,0.12),rgba(12,74,110,0.22))] text-sky-50',
    mid: 'border-emerald-300/22 bg-[linear-gradient(180deg,rgba(74,222,128,0.12),rgba(6,78,59,0.22))] text-emerald-50',
    att: 'border-amber-300/24 bg-[linear-gradient(180deg,rgba(245,158,11,0.14),rgba(120,53,15,0.24))] text-amber-50',
    gk: 'border-white/15 bg-[linear-gradient(180deg,rgba(250,250,249,0.08),rgba(41,37,36,0.22))] text-stone-50',
  }
  const emphasisClasses = {
    idle: 'shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
    incoming: 'ring-1 ring-emerald-300/45 shadow-[0_0_0_1px_rgba(16,185,129,0.12),0_0_18px_rgba(16,185,129,0.08)]',
    outgoing: 'ring-1 ring-amber-300/45 shadow-[0_0_0_1px_rgba(245,158,11,0.12),0_0_18px_rgba(245,158,11,0.08)]',
    swing: 'ring-1 ring-clay-300/45 shadow-[0_0_0_1px_rgba(212,125,51,0.14),0_0_18px_rgba(212,125,51,0.08)]',
  }

  return (
    <div
      className={`relative min-w-0 flex-1 rounded-[0.95rem] border px-2.5 py-2 text-center ${toneClasses[tone]} ${emphasisClasses[emphasis]} ${
        isSingle ? 'max-w-[11rem]' : ''
      }`}
    >
      <div className="pointer-events-none">
        <p className="font-mono text-[9px] uppercase tracking-[0.26em] opacity-80">{label}</p>
        <p className="mt-1 truncate text-sm font-semibold text-white">{player}</p>
      </div>
    </div>
  )
}

function buildPlayerDetail(
  plan: MatchPlan,
  playerId: string,
  nameById: Record<string, string>,
) {
  return {
    periods: plan.periods.map((period) => {
      const windows = period.chunks.map((chunk) => {
        const position = Object.entries(chunk.lineup).find(([, lineupPlayerId]) => lineupPlayerId === playerId)?.[0]
        const isGoalkeeper = chunk.goalkeeperId === playerId
        const isActive = isGoalkeeper || Boolean(position)
        const incomingSubstitution = chunk.substitutions.find(
          (substitution) => substitution.playerInId === playerId,
        )
        const outgoingSubstitution = chunk.substitutions.find(
          (substitution) => substitution.playerOutId === playerId,
        )

        return {
          windowIndex: chunk.windowIndex,
          rangeLabel: formatMinuteRangeLabel(chunk.startMinute, chunk.endMinute),
          statusLabel: isGoalkeeper ? 'Målvakt' : position ? position : 'Bänk',
          isActive,
          isGoalkeeper,
          isOutfield: !isGoalkeeper && Boolean(position),
          swapLabel: incomingSubstitution
            ? `${nameById[incomingSubstitution.playerInId]} in för ${nameById[incomingSubstitution.playerOutId]} (${incomingSubstitution.position})`
            : outgoingSubstitution
              ? `${nameById[outgoingSubstitution.playerOutId]} ut mot ${nameById[outgoingSubstitution.playerInId]} (${outgoingSubstitution.position})`
              : null,
          durationMinutes: chunk.durationMinutes,
        }
      })

      return {
        period: period.period,
        totalMinutes: windows
          .filter((windowDetail) => windowDetail.isActive)
          .reduce((total, windowDetail) => total + windowDetail.durationMinutes, 0),
        goalkeeperMinutes: windows
          .filter((windowDetail) => windowDetail.isGoalkeeper)
          .reduce((total, windowDetail) => total + windowDetail.durationMinutes, 0),
        outfieldMinutes: windows
          .filter((windowDetail) => windowDetail.isOutfield)
          .reduce((total, windowDetail) => total + windowDetail.durationMinutes, 0),
        benchMinutes: windows
          .filter((windowDetail) => !windowDetail.isActive)
          .reduce((total, windowDetail) => total + windowDetail.durationMinutes, 0),
        startStatus: windows[0]?.statusLabel ?? 'Ingen',
        windows,
      }
    }),
  }
}

function createInitialAppState(): InitialAppState {
  const defaultState = createDefaultAppState()

  if (typeof window === 'undefined') {
    return defaultState
  }

  const sharedValue = new URL(window.location.href).searchParams.get(LINEUP_SHARE_QUERY_PARAM)

  if (!sharedValue) {
    return defaultState
  }

  try {
    const { config, overrides } = decodeLineupSnapshot(sharedValue)
    const hydratedPlan = buildPlanFromGeneratedConfig(config, true)
    const hydratedOverrides = validateSharedOverrides(hydratedPlan, overrides)

    return {
      formState: createFormStateFromConfig(config),
      generatedConfig: config,
      plan: hydratedPlan,
      periodOverrides: hydratedOverrides,
      shouldSyncShareUrl: true,
    }
  } catch {
    window.history.replaceState(null, '', clearLineupShareUrl(window.location.href))

    return {
      ...defaultState,
      formState: {
        ...defaultState.formState,
        errors: [SHARE_LINK_ERROR_MESSAGE],
      },
    }
  }
}

function createDefaultAppState(): InitialAppState {
  const playerInput = INITIAL_FORM_STATE.playerInput
  const players = normalizePlayers(playerInput)
  const initialGoalkeeperSelections = [...INITIAL_FORM_STATE.goalkeeperSelections] as GoalkeeperSelections
  const initialPlan = generateMatchPlan({
    players,
    periodMinutes: INITIAL_FORM_STATE.periodMinutes,
    formation: INITIAL_FORM_STATE.formation,
    chunkMinutes: INITIAL_FORM_STATE.chunkMinutes,
    lockedGoalkeeperIds: [null, null, null],
    seed: DEFAULT_SHARE_SEED,
  })
  const generatedConfig = buildGeneratedConfig({
    players,
    playerInput,
    periodMinutes: INITIAL_FORM_STATE.periodMinutes,
    formation: INITIAL_FORM_STATE.formation,
    chunkMinutes: INITIAL_FORM_STATE.chunkMinutes,
    goalkeeperSelections: initialGoalkeeperSelections,
    seed: initialPlan.seed,
  })

  return {
    formState: createFormStateFromConfig(generatedConfig),
    generatedConfig,
    plan: initialPlan,
    periodOverrides: {},
    shouldSyncShareUrl: false,
  }
}

function createFormStateFromConfig(config: GeneratedConfig): FormState {
  return {
    playerInput: config.playerInput,
    periodMinutes: config.periodMinutes,
    formation: config.formation,
    chunkMinutes: config.chunkMinutes,
    goalkeeperSelections: [...config.goalkeeperSelections] as GoalkeeperSelections,
    errors: [],
  }
}

function buildGeneratedConfig({
  players,
  playerInput,
  periodMinutes,
  formation,
  chunkMinutes,
  goalkeeperSelections,
  seed,
}: {
  players: Player[]
  playerInput: string
  periodMinutes: 15 | 20
  formation: FormationKey
  chunkMinutes: number
  goalkeeperSelections: GoalkeeperSelections
  seed: number
}): GeneratedConfig {
  return {
    playerInput,
    playerNames: players.map((player) => player.name),
    periodMinutes,
    formation,
    chunkMinutes,
    goalkeeperSelections: [...goalkeeperSelections] as GoalkeeperSelections,
    seed,
  }
}

function buildPlanFromGeneratedConfig(config: GeneratedConfig, exactSeed = false) {
  const players = normalizePlayers(config.playerInput)

  return generateMatchPlan({
    players,
    periodMinutes: config.periodMinutes,
    formation: config.formation,
    chunkMinutes: config.chunkMinutes,
    lockedGoalkeeperIds: mapGoalkeeperSelectionsToIds(players, config.goalkeeperSelections),
    seed: config.seed,
    ...(exactSeed ? { attempts: 1 } : {}),
  })
}

function createLineupShareUrl(
  config: GeneratedConfig,
  overrides: PeriodBoardOverrides,
) {
  const encodedSnapshot = encodeLineupSnapshot({
    config,
    overrides: serializePeriodOverrides(overrides),
  })

  return buildLineupShareUrl(encodedSnapshot, window.location.href)
}

function serializePeriodOverrides(overrides: PeriodBoardOverrides) {
  const serializedOverrides: Record<string, Record<string, string>> = {}

  for (const [period, assignments] of Object.entries(overrides)) {
    if (assignments) {
      serializedOverrides[period] = assignments
    }
  }

  return serializedOverrides
}

function validateSharedOverrides(
  plan: MatchPlan,
  sharedOverrides: Record<string, Record<string, string>>,
): PeriodBoardOverrides {
  const validatedOverrides: PeriodBoardOverrides = {}

  for (const [periodKey, assignments] of Object.entries(sharedOverrides)) {
    const periodNumber = Number(periodKey)
    const period = plan.periods.find((candidate) => candidate.period === periodNumber)

    if (!period) {
      throw new Error('Ogiltig delningslänk.')
    }

    const defaultAssignments = createBoardAssignments(period)
    const expectedSlots = Object.keys(defaultAssignments).sort()
    const receivedSlots = Object.keys(assignments).sort()

    if (
      expectedSlots.length !== receivedSlots.length ||
      !expectedSlots.every((slotId, index) => slotId === receivedSlots[index])
    ) {
      throw new Error('Ogiltig delningslänk.')
    }

    const expectedPlayers = Object.values(defaultAssignments).sort()
    const receivedPlayers = Object.values(assignments).sort()

    if (
      expectedPlayers.length !== receivedPlayers.length ||
      !expectedPlayers.every((playerId, index) => playerId === receivedPlayers[index])
    ) {
      throw new Error('Ogiltig delningslänk.')
    }

    const nextAssignments = Object.fromEntries(
      expectedSlots.map((slotId) => [slotId, assignments[slotId]]),
    ) as Record<BoardSlotId, string>

    if (!areBoardAssignmentsEqual(nextAssignments, defaultAssignments)) {
      validatedOverrides[periodNumber] = nextAssignments
    }
  }

  return validatedOverrides
}

function normalizePlayers(input: string): Player[] {
  const names = parseNames(input)

  if (names.length < 8 || names.length > 12) {
    throw new Error('Lägg in mellan 8 och 12 spelare.')
  }

  const duplicates = names.filter((name, index) => {
    const normalized = name.toLocaleLowerCase('sv-SE')
    return names.findIndex((candidate) => candidate.toLocaleLowerCase('sv-SE') === normalized) !== index
  })

  if (duplicates.length > 0) {
    throw new Error(`Dubbletter hittades: ${Array.from(new Set(duplicates)).join(', ')}`)
  }

  return names.map((name, index) => ({
    id: `player-${index + 1}`,
    name,
  }))
}

function getMinuteBreakdown(summary: MatchPlan['summaries'][number], periodMinutes: number) {
  const goalkeeperMinutes = summary.goalkeeperPeriods.length * periodMinutes
  const outfieldMinutes = Math.max(summary.totalMinutes - goalkeeperMinutes, 0)

  return {
    goalkeeperMinutes,
    outfieldMinutes,
    totalMinutes: summary.totalMinutes,
  }
}

function getSubstitutionOptions(periodMinutes: 15 | 20, currentChunkMinutes?: number) {
  const options = SUBSTITUTIONS_PER_PERIOD_OPTIONS.map((substitutionsPerPeriod) => {
    const chunkMinutes = getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod)

    return {
      value: chunkMinutes,
      label: `${substitutionsPerPeriod} byten (${formatChunkPattern(periodMinutes, chunkMinutes)})`,
    }
  })

  if (
    typeof currentChunkMinutes === 'number' &&
    !options.some((option) => areMinuteValuesEqual(option.value, currentChunkMinutes))
  ) {
    return [
      ...options,
      {
        value: currentChunkMinutes,
        label: `Länkdelning (${formatMinuteValue(currentChunkMinutes)} min)`,
      },
    ]
  }

  return options
}

function getNormalizedChunkMinutes(periodMinutes: 15 | 20, currentChunkMinutes: number) {
  const supportedChunkMinutes = SUBSTITUTIONS_PER_PERIOD_OPTIONS.map((substitutionsPerPeriod) =>
    getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod),
  )

  return supportedChunkMinutes.some((value) => areMinuteValuesEqual(value, currentChunkMinutes))
    ? currentChunkMinutes
    : supportedChunkMinutes[0]
}

function formatChunkPattern(periodMinutes: 15 | 20, chunkMinutes: number) {
  const windows: number[] = []
  let remainingMinutes = periodMinutes

  while (remainingMinutes > 0) {
    const windowMinutes = Math.min(chunkMinutes, remainingMinutes)
    windows.push(windowMinutes)
    remainingMinutes -= windowMinutes
  }

  return windows.map((value) => formatMinutePatternValue(value)).join('+')
}

function formatMinuteValue(value: number) {
  if (Number.isInteger(value)) {
    return `${value}`
  }

  return formatMinuteClockValue(value)
}

function formatMinuteDuration(value: number) {
  if (Number.isInteger(value)) {
    return `${formatMinuteValue(value)} min`
  }

  const { minutes, seconds } = splitMinutesAndSeconds(value)

  return `${minutes} min ${seconds} sek`
}

function formatMinuteRangeLabel(startMinute: number, endMinute: number) {
  return `${formatMinuteValue(startMinute)}-${formatMinuteValue(endMinute)}`
}

function formatMinutePatternValue(value: number) {
  if (Number.isInteger(value)) {
    return formatMinuteValue(value)
  }

  return formatMinuteClockValue(value)
}

function formatMinuteClockValue(value: number) {
  const { minutes, seconds } = splitMinutesAndSeconds(value)

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function splitMinutesAndSeconds(value: number) {
  const totalSeconds = Math.round(value * 60)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return { minutes, seconds }
}

function getChunkMinutesForSubstitutions(
  periodMinutes: 15 | 20,
  substitutionsPerPeriod: (typeof SUBSTITUTIONS_PER_PERIOD_OPTIONS)[number],
) {
  return SUBSTITUTIONS_PER_PERIOD_TO_CHUNK_MINUTES[periodMinutes][substitutionsPerPeriod]
}

function getSubstitutionsPerPeriod(periodMinutes: 15 | 20, chunkMinutes: number) {
  const match = SUBSTITUTIONS_PER_PERIOD_OPTIONS.find((substitutionsPerPeriod) =>
    areMinuteValuesEqual(getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod), chunkMinutes),
  )

  return match ?? 2
}

function areMinuteValuesEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.001
}

function getRosterNames(input: string) {
  const rosterByNormalizedName = new Map<string, string>()

  for (const name of parseNames(input)) {
    const normalizedName = name.toLocaleLowerCase('sv-SE')

    if (!rosterByNormalizedName.has(normalizedName)) {
      rosterByNormalizedName.set(normalizedName, name)
    }
  }

  return [...rosterByNormalizedName.values()]
}

function parseNames(input: string) {
  return input
    .split(/[\n,]+/g)
    .map((name) => name.trim())
    .filter(Boolean)
}

function createRandomRoster(count: number) {
  return shuffle([...BASE_PLAYER_POOL]).slice(0, count).join('\n')
}

function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
      ;[items[index], items[swapIndex]] = [items[swapIndex], items[index]]
  }

  return items
}

function mapGoalkeeperSelectionsToIds(players: Player[], selections: GoalkeeperSelections) {
  const playerIdByName = new Map(
    players.map((player) => [player.name.toLocaleLowerCase('sv-SE'), player.id]),
  )

  return selections.map((selection) => {
    if (!selection) {
      return null
    }

    const playerId = playerIdByName.get(selection.toLocaleLowerCase('sv-SE'))
    if (!playerId) {
      throw new Error(`Målvakten ${selection} finns inte i spelarlistan.`)
    }

    return playerId
  })
}

function readLineupPlayer(
  lineup: Lineup,
  position: OutfieldPosition,
  nameById: Record<string, string>,
) {
  const playerId = lineup[position]
  return playerId ? nameById[playerId] : '-'
}

function formatChunkSubstitutions(
  substitutions: MatchPlan['periods'][number]['chunks'][number]['substitutions'],
  nameById: Record<string, string>,
) {
  return substitutions.map((substitution, index) => (
    <span key={`${substitution.playerInId}-${substitution.playerOutId}-${substitution.position}`}>
      <span className="font-semibold text-emerald-300">{nameById[substitution.playerInId]}</span>
      <span> in, </span>
      <span className="font-semibold text-amber-200">{nameById[substitution.playerOutId]}</span>
      <span> ut ({substitution.position})</span>
      {index < substitutions.length - 1 ? <span className="text-stone-500"> · </span> : null}
    </span>
  ))
}

function getChunkPositionEmphasis(isIncomingNow: boolean, isOutgoingNext: boolean) {
  if (isIncomingNow && isOutgoingNext) {
    return 'swing' as const
  }

  if (isIncomingNow) {
    return 'incoming' as const
  }

  if (isOutgoingNext) {
    return 'outgoing' as const
  }

  return 'idle' as const
}

function getPositionTone(position: OutfieldPosition) {
  if (position === 'A') {
    return 'att'
  }

  if (position === 'VB' || position === 'CB' || position === 'HB') {
    return 'def'
  }

  return 'mid'
}

function getBoardSlotTone(slotId: BoardSlotId) {
  if (slotId === GOALKEEPER_SLOT) {
    return 'gk'
  }

  if (isBenchSlot(slotId)) {
    return 'bench'
  }

  return getPositionTone(slotId)
}

function getBoardSlotLabel(slotId: BoardSlotId) {
  if (slotId === GOALKEEPER_SLOT) {
    return 'MV'
  }

  if (isBenchSlot(slotId)) {
    return slotId
  }

  return slotId
}

export default App
