import { type ChangeEvent, type Dispatch, type ReactNode, useMemo, useReducer, useState, useTransition } from 'react'
import { generateMatchPlan } from './lib/scheduler'
import {
  FORMATION_PRESETS,
  type FormationKey,
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
const DEFAULT_CHUNK_MINUTES = 5

interface FormState {
  playerInput: string
  periodMinutes: 15 | 20
  formation: FormationKey
  chunkMinutes: number
  goalkeeperSelections: [string, string, string]
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

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setPlayerInput':
      return { ...state, playerInput: action.value }
    case 'setPeriodMinutes':
      return { ...state, periodMinutes: action.value }
    case 'setFormation':
      return { ...state, formation: action.value }
    case 'setChunkMinutes':
      return { ...state, chunkMinutes: action.value }
    case 'setGoalkeeperSelection':
      return {
        ...state,
        goalkeeperSelections: state.goalkeeperSelections.map((selection, index) =>
          index === action.periodIndex ? action.value : selection,
        ) as [string, string, string],
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
  const [formState, dispatch] = useReducer(formReducer, INITIAL_FORM_STATE)
  const [isPending, startTransition] = useTransition()
  const [plan, setPlan] = useState<MatchPlan | null>(() => {
    const initialPlayers = normalizePlayers(DEFAULT_PLAYER_INPUT)
    return generateMatchPlan({
      players: initialPlayers,
      periodMinutes: 20,
      formation: DEFAULT_FORMATION,
      chunkMinutes: DEFAULT_CHUNK_MINUTES,
      lockedGoalkeeperIds: [null, null, null],
      seed: 20260314,
    })
  })

  const playerOptions = useMemo(() => getPlayerOptions(formState.playerInput), [formState.playerInput])

  const playerNameById = plan
    ? Object.fromEntries(plan.summaries.map((summary) => [summary.playerId, summary.name]))
    : {}

  const handleGenerate = () => {
    try {
      const players = normalizePlayers(formState.playerInput)
      const seed = Date.now()
      const nextPlan = generateMatchPlan({
        players,
        periodMinutes: formState.periodMinutes,
        formation: formState.formation,
        chunkMinutes: formState.chunkMinutes,
        lockedGoalkeeperIds: mapGoalkeeperSelectionsToIds(players, formState.goalkeeperSelections),
        seed,
      })
      dispatch({ type: 'clearErrors' })
      startTransition(() => {
        setPlan(nextPlan)
      })
    } catch (error) {
      dispatch({
        type: 'setErrors',
        value: [error instanceof Error ? error.message : 'Något gick fel vid generering.'],
      })
      setPlan(null)
    }
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
            isPending={isPending}
            onGenerate={handleGenerate}
          />
        </header>

        {plan ? (
          <>
            <MatchOverview plan={plan} playerNameById={playerNameById} />

            <section className="grid gap-5 xl:grid-cols-3">
              {plan.periods.map((period) => (
                <PeriodCard key={period.period} period={period} nameById={playerNameById} />
              ))}
            </section>

            <PlayerMinutesSection summaries={plan.summaries} />
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
          spelfönster mellan 5 och 10 minuter.
        </p>
      </div>
    </div>
  )
}

function SettingsPanel({
  state,
  dispatch,
  playerOptions,
  isPending,
  onGenerate,
}: {
  state: FormState
  dispatch: Dispatch<FormAction>
  playerOptions: string[]
  isPending: boolean
  onGenerate: () => void
}) {
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
            label="Spelfönster"
            htmlFor="chunk-minutes"
            hint="Spelarna håller uppställningen hela fönstret och byter när fönstret slutar. Om perioden inte går jämnt upp blir sista fönstret kortare."
          >
            <SelectControl
              id="chunk-minutes"
              value={state.chunkMinutes}
              onChange={(event) => dispatch({ type: 'setChunkMinutes', value: Number(event.target.value) })}
            >
              {Array.from({ length: 6 }, (_, index) => 5 + index).map((value) => (
                <option key={value} value={value}>
                  {value} minuter
                </option>
              ))}
            </SelectControl>
          </Field>
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

        <button
          type="button"
          onClick={onGenerate}
          disabled={isPending}
          className="inline-flex h-12 w-full items-center justify-center rounded-full bg-clay-400 px-6 font-display text-lg font-bold text-clay-900 transition hover:bg-clay-300 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
        >
          {isPending ? 'Genererar...' : 'Generera uppställning'}
        </button>

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
      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryChip
          label="Målvakter"
          value={plan.goalkeepers.map((goalkeeperId) => playerNameById[goalkeeperId]).join(', ')}
        />
        <SummaryChip label="Formation" value={plan.formation} />
        <SummaryChip label="Byten" value={`var ${plan.chunkMinutes}:e min`} />
        <SummaryChip label="Totaltid" value={`${plan.periodMinutes * 3} min match`} />
      </div>
    </section>
  )
}

function PlayerMinutesSection({ summaries }: { summaries: MatchPlan['summaries'] }) {
  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-black/20 p-5 backdrop-blur">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-bold text-white">Speltid per spelare</h2>
          <p className="text-sm text-stone-300">
            Dubbelkolla minuter, bänktid och vilka roller varje spelare hann prova.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {summaries.map((summary) => (
          <article
            key={summary.playerId}
            className="rounded-[1.5rem] border border-white/10 bg-white/5 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-2xl font-bold text-white">{summary.name}</h3>
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-stone-400">
                  {summary.goalkeeperPeriods.length > 0
                    ? `MV i period ${summary.goalkeeperPeriods.join(', ')}`
                    : 'Ingen målvaktsperiod'}
                </p>
              </div>
              <div className="rounded-2xl bg-clay-400 px-3 py-2 text-right text-clay-900">
                <p className="font-display text-2xl font-black">{summary.totalMinutes}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em]">min</p>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-300">
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

            <div className="mt-4 flex flex-wrap gap-2">
              {summary.roleGroups.length > 0 ? (
                summary.roleGroups.map((group) => (
                  <span
                    key={group}
                    className="rounded-full border border-clay-300/20 bg-clay-500/10 px-3 py-1 text-xs font-medium text-clay-100"
                  >
                    {group}
                  </span>
                ))
              ) : (
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-stone-300">
                  Endast målvakt
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function PeriodCard({
  period,
  nameById,
}: {
  period: PeriodPlan
  nameById: Record<string, string>
}) {
  return (
    <article className="rounded-[1.5rem] border border-white/10 bg-white/5 p-3.5 backdrop-blur sm:rounded-[1.75rem] sm:p-5">
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-clay-200">Period {period.period}</p>
          <h2 className="mt-1 font-display text-2xl font-black text-white sm:text-3xl">
            MV: {period.goalkeeperName}
          </h2>
          <p className="mt-1 text-sm text-stone-300">Formation: {period.formation}</p>
        </div>
        <div className="w-full rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-left sm:w-auto sm:max-w-[18rem] sm:text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">Startbänk</p>
          <p className="mt-1 text-sm text-white">
            {period.chunks[0]?.substitutes.length ? period.chunks[0].substitutes.join(', ') : 'Ingen'}
          </p>
        </div>
      </div>

      <FormationBoard
        formation={period.formation}
        lineup={period.startingLineup}
        goalkeeper={period.goalkeeperName}
        nameById={nameById}
      />

      <div className="mt-4 space-y-3 sm:mt-5">
        {period.chunks.map((chunk, chunkIndex) => {
          const nextChunk = period.chunks[chunkIndex + 1]
          const currentIncomingIds = new Set(chunk.substitutions.map((substitution) => substitution.playerInId))
          const nextOutgoingIds = new Set(nextChunk?.substitutions.map((substitution) => substitution.playerOutId) ?? [])

          return (
            <div
              key={chunk.chunkIndex}
              className="rounded-[1.1rem] border border-white/10 bg-black/20 px-3 py-3 sm:rounded-[1.25rem] sm:px-4"
            >
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.22em] text-stone-500">
                    {chunk.startMinute}-{chunk.endMinute} min
                  </p>
                  <p className="text-sm text-stone-300">
                    Spelfönster {chunk.windowIndex + 1} · byte efter {chunk.durationMinutes} min
                  </p>
                </div>
                <p className="text-sm text-stone-300">
                  Bänk: {chunk.substitutes.length > 0 ? chunk.substitutes.join(', ') : 'Ingen'}
                </p>
              </div>

              <p className="mb-3 text-xs text-stone-400">
                {chunk.substitutions.length > 0
                  ? `Byte: ${formatChunkSubstitutions(chunk.substitutions, nameById)}`
                  : 'Startuppställning eller inga byten i detta fönster.'}
              </p>

              <div className="grid gap-2 sm:grid-cols-2">
                {period.positions.map((position) => {
                  const playerId = chunk.lineup[position]
                  const playerName = readLineupPlayer(chunk.lineup, position, nameById)
                  const isIncomingNow = playerId ? currentIncomingIds.has(playerId) : false
                  const isOutgoingNext = playerId ? nextOutgoingIds.has(playerId) : false

                  return (
                    <div
                      key={`${chunk.chunkIndex}-${position}`}
                      className={getChunkPositionCardClass(isIncomingNow, isOutgoingNext)}
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-xs uppercase tracking-[0.22em] text-clay-200">
                          {position}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-white">{playerName}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </article>
  )
}

function FormationBoard({
  formation,
  lineup,
  goalkeeper,
  nameById,
}: {
  formation: FormationKey
  lineup: Lineup
  goalkeeper: string
  nameById: Record<string, string>
}) {
  return (
    <div className="rounded-[1.35rem] border border-pitch-300/20 bg-[radial-gradient(circle_at_top,_rgba(141,184,99,0.24),_transparent_34%),linear-gradient(180deg,rgba(13,43,19,0.96),rgba(7,25,11,0.98))] p-2.5 sm:rounded-[1.75rem] sm:p-4">
      <div className="rounded-[1.2rem] border border-white/10 border-dashed p-3 sm:rounded-[1.5rem] sm:p-4">
        <div className="space-y-3 sm:space-y-4">
          {FORMATION_PRESETS[formation].rows.map((row) => (
            <FormationRow key={`${formation}-${row.join('-')}`}>
              {row.map((position) => (
                <PositionBadge
                  key={position}
                  label={position}
                  player={readLineupPlayer(lineup, position, nameById)}
                  tone={getPositionTone(position)}
                />
              ))}
            </FormationRow>
          ))}
          <div className="mx-auto mt-1.5 flex max-w-32 justify-center border-t border-dashed border-white/10 pt-3 sm:mt-2 sm:max-w-40 sm:pt-4">
            <PositionBadge label="MV" player={goalkeeper} tone="gk" />
          </div>
        </div>
      </div>
    </div>
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
  label,
  player,
  tone,
}: {
  label: string
  player: string
  tone: 'def' | 'mid' | 'att' | 'gk'
}) {
  const tones = {
    def: 'border-sky-300/35 bg-[linear-gradient(180deg,rgba(56,189,248,0.22),rgba(12,74,110,0.34))] text-sky-50 shadow-[inset_0_1px_0_rgba(186,230,253,0.12),0_0_0_1px_rgba(12,74,110,0.16)]',
    mid: 'border-emerald-300/35 bg-[linear-gradient(180deg,rgba(74,222,128,0.2),rgba(6,78,59,0.34))] text-emerald-50 shadow-[inset_0_1px_0_rgba(209,250,229,0.12),0_0_0_1px_rgba(6,78,59,0.16)]',
    att: 'border-rose-300/35 bg-[linear-gradient(180deg,rgba(251,113,133,0.2),rgba(127,29,29,0.34))] text-rose-50 shadow-[inset_0_1px_0_rgba(255,228,230,0.12),0_0_0_1px_rgba(127,29,29,0.16)]',
    gk: 'border-amber-300/35 bg-[linear-gradient(180deg,rgba(251,191,36,0.22),rgba(120,53,15,0.34))] text-amber-50 shadow-[inset_0_1px_0_rgba(254,243,199,0.12),0_0_0_1px_rgba(120,53,15,0.16)]',
  }

  return (
    <div
      className={`min-w-[5.4rem] rounded-[1rem] border px-2 py-2 text-center sm:min-w-28 sm:rounded-[1.2rem] sm:px-3 sm:py-3 ${tones[tone]}`}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] opacity-75">{label}</p>
      <p className="mt-1 text-xs font-semibold sm:text-sm">{player}</p>
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

function getPlayerOptions(input: string) {
  return Array.from(new Set(parseNames(input)))
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

function mapGoalkeeperSelectionsToIds(players: Player[], selections: [string, string, string]) {
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
  return substitutions
    .map(
      (substitution) =>
        `${nameById[substitution.playerInId]} in, ${nameById[substitution.playerOutId]} ut (${substitution.position})`,
    )
    .join(' · ')
}

function getChunkPositionCardClass(isIncomingNow: boolean, isOutgoingNext: boolean) {
  if (isIncomingNow && isOutgoingNext) {
    return 'flex items-center justify-between rounded-2xl border border-clay-300/35 bg-[linear-gradient(90deg,rgba(120,53,15,0.2),rgba(6,95,70,0.2))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  }

  if (isIncomingNow) {
    return 'flex items-center justify-between rounded-2xl border border-emerald-400/35 bg-[linear-gradient(180deg,rgba(16,185,129,0.14),rgba(6,78,59,0.18))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  }

  if (isOutgoingNext) {
    return 'flex items-center justify-between rounded-2xl border border-amber-400/35 bg-[linear-gradient(180deg,rgba(245,158,11,0.12),rgba(120,53,15,0.18))] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  }

  return 'flex items-center justify-between rounded-2xl bg-white/5 px-3 py-2'
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

export default App
