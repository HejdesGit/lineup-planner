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
import { AlertTriangle, ArrowLeftRight, Bandage, Lock, LockOpen, UserPlus } from 'lucide-react'
import {
  applyLiveAdjustmentEvents,
  createInitialAvailabilityState,
  getLiveRecommendations,
} from './lib/liveAdjustments'
import { generateMatchPlan } from './lib/scheduler'
import {
  GOALKEEPER_SLOT,
  applyPeriodOverrides,
  areBoardAssignmentsEqual,
  createBoardAssignments,
  getBoardBenchSlots,
  getBenchSlotId,
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
  ACTIVE_MATCH_TIMER_STORAGE_KEY,
  buildMatchTimeline,
  createRunningMatchTimer,
  getMatchProgress,
  getTimelineChunksForPeriod,
  isStoredActiveMatchTimerCompatible,
  parseStoredActiveMatchTimer,
  pauseMatchTimer,
  resumeMatchTimer,
  serializeStoredActiveMatchTimer,
  type MatchProgress,
  type MatchTimeline,
  type StoredActiveMatchTimer,
} from './lib/matchTimer'
import {
  areMinuteValuesEqual,
  getChunkMinutesForSubstitutions,
  getSubstitutionsPerPeriod,
  getSupportedSubstitutionsPerPeriodOptions,
} from './lib/substitutions'
import {
  FORMATION_PRESETS,
  PERIOD_COUNT,
  PERIOD_COUNT_OPTIONS,
  PERIOD_MINUTE_OPTIONS,
  type FormationKey,
  type GeneratedConfig,
  type GoalkeeperSelections,
  type Lineup,
  type LiveAdjustmentEvent,
  type LiveAdjustmentRole,
  type LiveAvailabilityState,
  type LiveRecommendation,
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
const DEFAULT_CHUNK_MINUTES = 20 / 3
const DEFAULT_SHARE_SEED = 20260314
const DEFAULT_SELECTED_TIMER_PERIOD = 1
const SHARE_LINK_ERROR_MESSAGE = 'Ogiltig delningslänk. Standarduppställningen visas i stället.'
const LIVE_NOW_SECTION_ID = 'section-live-now'
const BOTTOM_TAB_ITEMS = [
  { id: 'pre-match', label: 'Inför match', sectionId: 'section-pre-match' },
  { id: 'match-mode', label: 'Matchläge', sectionId: 'section-match-mode' },
  { id: 'minutes', label: 'Speltid', sectionId: 'section-minutes' },
] as const

interface FormState {
  playerInput: string
  periodCount: number
  periodMinutes: number
  formation: FormationKey
  chunkMinutes: number
  goalkeeperSelections: GoalkeeperSelections
  errors: string[]
}

type FormAction =
  | { type: 'setPlayerInput'; value: string }
  | { type: 'setPeriodCount'; value: number }
  | { type: 'setPeriodMinutes'; value: number }
  | { type: 'setFormation'; value: FormationKey }
  | { type: 'setChunkMinutes'; value: number }
  | { type: 'setGoalkeeperSelection'; periodIndex: number; value: string }
  | { type: 'setErrors'; value: string[] }
  | { type: 'clearErrors' }

const INITIAL_FORM_STATE: FormState = {
  playerInput: DEFAULT_PLAYER_INPUT,
  periodCount: PERIOD_COUNT,
  periodMinutes: 20,
  formation: DEFAULT_FORMATION,
  chunkMinutes: DEFAULT_CHUNK_MINUTES,
  goalkeeperSelections: createGoalkeeperSelections(PERIOD_COUNT),
  errors: [],
}

interface InitialAppState {
  formState: FormState
  generatedConfig: GeneratedConfig
  plan: MatchPlan | null
  periodOverrides: PeriodBoardOverrides
  liveEvents: LiveAdjustmentEvent[]
  shouldSyncShareUrl: boolean
  selectedTimerPeriod: number
  activeMatchTimer: StoredActiveMatchTimer | null
}

type ApplyLiveEventInput =
  | {
      type: 'temporary-out'
      playerId: string
      replacementPlayerId: string
      role: LiveAdjustmentRole
    }
  | {
      type: 'return'
      playerId: string
      replacementPlayerId: string
      role: LiveAdjustmentRole
    }
  | {
      type: 'position-swap'
      playerId: string
      targetPlayerId: string
    }

interface AppController {
  activeBottomTab: BottomTabId
  canSelectTimerPeriod: boolean
  dispatch: Dispatch<FormAction>
  displayPlan: MatchPlan | null
  formState: FormState
  hasGeneratedPlan: boolean
  isPending: boolean
  liveAvailability: LiveAvailabilityState | null
  liveError: string | null
  matchProgress: MatchProgress | null
  matchTimeline: MatchTimeline | null
  normalizedOverrides: PeriodBoardOverrides
  plan: MatchPlan | null
  playerNameById: Record<string, string>
  playerOptions: string[]
  rosterCount: number
  selectedTimerPeriod: number
  showFloatingMatchTimer: boolean
  showLiveNowPanel: boolean
  unavailableRoleById: Record<string, LiveAdjustmentRole>
  handleApplyLiveEvent: (event: ApplyLiveEventInput) => void
  handleGenerate: () => void
  handlePauseMatch: () => void
  handleResetMatchTimer: () => void
  handleResumeMatch: () => void
  handleScrollToLiveNowSection: () => void
  handleSelectBottomTab: (tabId: BottomTabId) => void
  handleSelectTimerPeriod: (periodNumber: number) => void
  handleStartMatch: () => void
  handleSwapPeriodSlots: (
    periodNumber: number,
    fallbackAssignments: Record<BoardSlotId, string>,
    sourceSlot: BoardSlotId,
    targetSlot: BoardSlotId,
  ) => void
}

interface PositionSwapCandidate {
  playerId: string
  position: string
}

type BottomTabId = (typeof BOTTOM_TAB_ITEMS)[number]['id']

type LiveEventDraft =
  | {
      type: 'action-picker'
      playerId: string
    }
  | {
      type: 'unavailable'
      playerId: string
      role: LiveAdjustmentRole
      recommendations: LiveRecommendation[]
      selectedReplacementPlayerId: string | null
    }
  | {
      type: 'return'
      playerId: string
      role: LiveAdjustmentRole
      recommendations: LiveRecommendation[]
      selectedReplacementPlayerId: string | null
    }
  | {
      type: 'position-swap'
      playerId: string
      candidates: PositionSwapCandidate[]
      selectedTargetPlayerId: string | null
    }

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'setPlayerInput':
      return { ...state, playerInput: action.value }
    case 'setPeriodCount':
      return {
        ...state,
        periodCount: action.value,
        goalkeeperSelections: resizeGoalkeeperSelections(state.goalkeeperSelections, action.value),
      }
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
        ),
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
  const app = useAppController()

  return <AppShell app={app} />
}

function useAppController(): AppController {
  const [initialState] = useState(createInitialAppState)
  const [formState, dispatch] = useReducer(formReducer, initialState.formState)
  const [isPending, startTransition] = useTransition()
  const [generatedConfig, setGeneratedConfig] = useState(initialState.generatedConfig)
  const [plan, setPlan] = useState<MatchPlan | null>(initialState.plan)
  const [periodOverrides, setPeriodOverrides] = useState<PeriodBoardOverrides>(initialState.periodOverrides)
  const [liveEvents, setLiveEvents] = useState<LiveAdjustmentEvent[]>(initialState.liveEvents)
  const [shouldSyncShareUrl, setShouldSyncShareUrl] = useState(initialState.shouldSyncShareUrl)
  const [selectedTimerPeriod, setSelectedTimerPeriod] = useState(initialState.selectedTimerPeriod)
  const [activeMatchTimer, setActiveMatchTimer] = useState<StoredActiveMatchTimer | null>(
    initialState.activeMatchTimer,
  )
  const [timerNow, setTimerNow] = useState(() => Date.now())
  const [liveError, setLiveError] = useState<string | null>(null)
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTabId>('pre-match')
  const pendingBottomTabRef = useRef<BottomTabId | null>(null)
  const pendingBottomTabUntilRef = useRef<number>(0)

  const rosterNames = useMemo(() => getRosterNames(formState.playerInput), [formState.playerInput])
  const playerOptions = rosterNames
  const normalizedOverrides = useMemo(
    () => (plan ? normalizePeriodOverrides(plan, periodOverrides) : {}),
    [periodOverrides, plan],
  )
  const overridePlan = useMemo(
    () => (plan ? applyPeriodOverrides(plan, normalizedOverrides) : null),
    [normalizedOverrides, plan],
  )
  const livePlanState = useMemo(
    () =>
      overridePlan
        ? applyLiveAdjustmentEvents({
            plan: overridePlan,
            events: liveEvents,
          })
        : null,
    [liveEvents, overridePlan],
  )
  const displayPlan = livePlanState?.plan ?? overridePlan
  const liveAvailability = livePlanState?.availability ?? (plan ? createInitialAvailabilityState(plan) : null)
  const unavailableRoleById = useMemo(() => {
    const nextRoles: Record<string, LiveAdjustmentRole> = {}

    for (const event of liveEvents) {
      if (event.type === 'position-swap') {
        continue
      }

      if (event.type === 'return') {
        delete nextRoles[event.playerId]
        continue
      }

      nextRoles[event.playerId] = event.role ?? 'outfield'
    }

    return nextRoles
  }, [liveEvents])

  const playerNameById = displayPlan
    ? Object.fromEntries(displayPlan.summaries.map((summary) => [summary.playerId, summary.name]))
    : {}
  const lineupSnapshot = useMemo(
    () =>
      plan
        ? encodeLineupSnapshot({
            config: generatedConfig,
            overrides: serializePeriodOverrides(normalizedOverrides),
            liveEvents,
          })
        : null,
    [generatedConfig, liveEvents, normalizedOverrides, plan],
  )
  const matchTimeline = useMemo(() => (displayPlan ? buildMatchTimeline(displayPlan) : null), [displayPlan])
  const matchProgress = useMemo(
    () =>
      matchTimeline
        ? getMatchProgress({
            timeline: matchTimeline,
            timer: activeMatchTimer,
            now: timerNow,
          })
        : null,
    [activeMatchTimer, matchTimeline, timerNow],
  )
  const hasGeneratedPlan = Boolean(displayPlan && plan)
  const showFloatingMatchTimer = Boolean(matchProgress && matchTimeline && matchProgress.status !== 'idle')
  const showLiveNowPanel = Boolean(
    liveAvailability &&
      matchProgress &&
      matchProgress.activePeriod !== null &&
      matchProgress.activeChunkIndex !== null &&
      (matchProgress.status === 'running' || matchProgress.status === 'paused'),
  )
  const canSelectTimerPeriod =
    Boolean(plan) && matchProgress?.status !== 'running' && matchProgress?.status !== 'paused'

  useEffect(() => {
    if (hasGeneratedPlan) {
      return
    }

    setActiveBottomTab('pre-match')
  }, [hasGeneratedPlan])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let frameId: number | null = null

    const updateActiveTabFromScroll = () => {
      const tabsWithSections = BOTTOM_TAB_ITEMS.filter(
        (tab) => hasGeneratedPlan || tab.id === 'pre-match',
      )
        .map((tab) => ({
          id: tab.id,
          element: document.getElementById(tab.sectionId),
        }))
        .filter((tab): tab is { id: BottomTabId; element: HTMLElement } => tab.element !== null)

      if (!tabsWithSections.length) {
        return
      }

      const triggerY = window.innerHeight * 0.32
      const pendingBottomTab = pendingBottomTabRef.current

      if (pendingBottomTab && window.performance.now() < pendingBottomTabUntilRef.current) {
        const pendingTarget = tabsWithSections.find((tab) => tab.id === pendingBottomTab)

        if (pendingTarget) {
          const distanceToTargetTop = Math.abs(pendingTarget.element.getBoundingClientRect().top)

          if (distanceToTargetTop > 12) {
            setActiveBottomTab((currentTab) => (currentTab === pendingBottomTab ? currentTab : pendingBottomTab))
            return
          }
        }
      }

      pendingBottomTabRef.current = null
      pendingBottomTabUntilRef.current = 0
      let nextTabId = tabsWithSections[0].id

      for (const tab of tabsWithSections) {
        if (tab.element.getBoundingClientRect().top <= triggerY) {
          nextTabId = tab.id
        }
      }

      setActiveBottomTab((currentTab) => (currentTab === nextTabId ? currentTab : nextTabId))
    }

    const queueActiveTabUpdate = () => {
      if (frameId !== null) {
        return
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null
        updateActiveTabFromScroll()
      })
    }

    queueActiveTabUpdate()
    window.addEventListener('scroll', queueActiveTabUpdate, { passive: true })
    window.addEventListener('resize', queueActiveTabUpdate)

    return () => {
      window.removeEventListener('scroll', queueActiveTabUpdate)
      window.removeEventListener('resize', queueActiveTabUpdate)

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [hasGeneratedPlan])

  useEffect(() => {
    if (!plan || !shouldSyncShareUrl) {
      return
    }

    const nextUrl = createLineupShareUrl(generatedConfig, normalizedOverrides, liveEvents)

    if (window.location.href !== nextUrl) {
      window.history.replaceState(null, '', nextUrl)
    }
  }, [generatedConfig, liveEvents, normalizedOverrides, plan, shouldSyncShareUrl])

  useEffect(() => {
    if (!matchTimeline || !activeMatchTimer || activeMatchTimer.status !== 'running') {
      return
    }

    const intervalId = window.setInterval(() => {
      setTimerNow(Date.now())
    }, 1_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeMatchTimer, matchTimeline])

  useEffect(() => {
    if (!activeMatchTimer || activeMatchTimer.status !== 'running' || matchProgress?.status !== 'finished') {
      return
    }

    setActiveMatchTimer(pauseMatchTimer(activeMatchTimer, Date.now()))
  }, [activeMatchTimer, matchProgress])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    if (!activeMatchTimer || !lineupSnapshot || !matchTimeline) {
      try {
        window.localStorage.removeItem(ACTIVE_MATCH_TIMER_STORAGE_KEY)
      } catch {
        // Ignore local persistence failures in v1.
      }
      return
    }

    try {
      window.localStorage.setItem(
        ACTIVE_MATCH_TIMER_STORAGE_KEY,
        serializeStoredActiveMatchTimer({
          ...activeMatchTimer,
          lineupSnapshot,
          periodDurationMs: matchTimeline.periodDurationMs,
        }),
      )
    } catch {
      // Ignore local persistence failures in v1.
    }
  }, [activeMatchTimer, lineupSnapshot, matchTimeline])

  const handleGenerate = () => {
    try {
      const players = normalizePlayers(formState.playerInput)
      const nextPlan = generateMatchPlan({
        players,
        periodCount: formState.periodCount,
        periodMinutes: formState.periodMinutes,
        formation: formState.formation,
        chunkMinutes: formState.chunkMinutes,
        lockedGoalkeeperIds: mapGoalkeeperSelectionsToIds(players, formState.goalkeeperSelections),
        seed: Date.now(),
      })
      const nextGeneratedConfig = buildGeneratedConfig({
        players,
        playerInput: formState.playerInput,
        periodCount: formState.periodCount,
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
        setLiveEvents([])
        setShouldSyncShareUrl(true)
        setSelectedTimerPeriod(DEFAULT_SELECTED_TIMER_PERIOD)
        setActiveMatchTimer(null)
        setTimerNow(Date.now())
        setLiveError(null)
      })
    } catch (error) {
      dispatch({
        type: 'setErrors',
        value: [error instanceof Error ? error.message : 'Något gick fel vid generering.'],
      })
      window.history.replaceState(null, '', clearLineupShareUrl(window.location.href))
      setPlan(null)
      setPeriodOverrides({})
      setLiveEvents([])
      setShouldSyncShareUrl(false)
      setSelectedTimerPeriod(DEFAULT_SELECTED_TIMER_PERIOD)
      setActiveMatchTimer(null)
      setTimerNow(Date.now())
      setLiveError(null)
    }
  }

  const handleStartMatch = () => {
    if (!lineupSnapshot || !matchTimeline) {
      return
    }

    const startedAt = Date.now()

    setTimerNow(startedAt)
    setActiveMatchTimer(
      createRunningMatchTimer({
        lineupSnapshot,
        startedAt,
        period: selectedTimerPeriod,
        periodDurationMs: matchTimeline.periodDurationMs,
      }),
    )
  }

  const handlePauseMatch = () => {
    if (!activeMatchTimer) {
      return
    }

    const now = Date.now()
    setTimerNow(now)
    setActiveMatchTimer(pauseMatchTimer(activeMatchTimer, now))
  }

  const handleResumeMatch = () => {
    if (!activeMatchTimer) {
      return
    }

    const now = Date.now()
    setTimerNow(now)
    setActiveMatchTimer(resumeMatchTimer(activeMatchTimer, now))
  }

  const handleResetMatchTimer = () => {
    setActiveMatchTimer(null)
    setTimerNow(Date.now())
  }

  const handleSelectTimerPeriod = (periodNumber: number) => {
    if (!plan || periodNumber < 1 || periodNumber > plan.periods.length || !canSelectTimerPeriod) {
      return
    }

    setSelectedTimerPeriod(periodNumber)

    if (matchProgress?.status === 'finished') {
      setActiveMatchTimer(null)
      setTimerNow(Date.now())
    }
  }

  const handleApplyLiveEvent = (event: ApplyLiveEventInput) => {
    if (!displayPlan || !liveAvailability || !matchTimeline || !activeMatchTimer) {
      return
    }

    const now = Date.now()
    const liveProgress = getMatchProgress({
      timeline: matchTimeline,
      timer: activeMatchTimer,
      now,
    })
    const activePeriod = liveProgress.activePeriod

    if (!activePeriod) {
      return
    }

    const minute = roundMinuteValue(liveProgress.elapsedMs / 60_000)

    try {
      let nextEvent: LiveAdjustmentEvent

      if (event.type === 'position-swap') {
        nextEvent = {
          type: event.type,
          period: activePeriod,
          minute,
          playerId: event.playerId,
          targetPlayerId: event.targetPlayerId,
        }
      } else if (event.type === 'return') {
        nextEvent = {
          type: event.type,
          period: activePeriod,
          minute,
          playerId: event.playerId,
          replacementPlayerId: event.replacementPlayerId,
          role: event.role,
        }
      } else {
        nextEvent = {
          type: event.type,
          period: activePeriod,
          minute,
          playerId: event.playerId,
          replacementPlayerId: event.replacementPlayerId,
          role: event.role,
          status: 'temporarily-out',
        }
      }

      if (overridePlan) {
        applyLiveAdjustmentEvents({
          plan: overridePlan,
          events: [...liveEvents, nextEvent],
        })
      }

      setLiveEvents((current) => [...current, nextEvent])
      setShouldSyncShareUrl(true)
      setTimerNow(now)
      setLiveError(null)
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : 'Live-bytet kunde inte genomföras.')
    }
  }

  const handleSwapPeriodSlots = (
    periodNumber: number,
    fallbackAssignments: Record<BoardSlotId, string>,
    sourceSlot: BoardSlotId,
    targetSlot: BoardSlotId,
  ) => {
    setShouldSyncShareUrl(true)
    setLiveError(null)
    setPeriodOverrides((current) => {
      const currentAssignments = normalizedOverrides[periodNumber] ?? fallbackAssignments

      return {
        ...current,
        [periodNumber]: swapBoardAssignments(currentAssignments, sourceSlot, targetSlot),
      }
    })
  }

  const handleSelectBottomTab = (tabId: BottomTabId) => {
    const tab = BOTTOM_TAB_ITEMS.find((item) => item.id === tabId)

    if (!tab) {
      return
    }

    if (!hasGeneratedPlan && tab.id !== 'pre-match') {
      return
    }

    pendingBottomTabRef.current = tabId
    pendingBottomTabUntilRef.current = window.performance.now() + 1200
    setActiveBottomTab(tabId)
    document.getElementById(tab.sectionId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  const handleScrollToLiveNowSection = () => {
    document.getElementById(LIVE_NOW_SECTION_ID)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  return {
    activeBottomTab,
    canSelectTimerPeriod,
    dispatch,
    displayPlan,
    formState,
    hasGeneratedPlan,
    isPending,
    liveAvailability,
    liveError,
    matchProgress,
    matchTimeline,
    normalizedOverrides,
    plan,
    playerNameById,
    playerOptions,
    rosterCount: rosterNames.length,
    selectedTimerPeriod,
    showFloatingMatchTimer,
    showLiveNowPanel,
    unavailableRoleById,
    handleApplyLiveEvent,
    handleGenerate,
    handlePauseMatch,
    handleResetMatchTimer,
    handleResumeMatch,
    handleScrollToLiveNowSection,
    handleSelectBottomTab,
    handleSelectTimerPeriod,
    handleStartMatch,
    handleSwapPeriodSlots,
  }
}

function AppShell({ app }: { app: AppController }) {
  return (
    <main className="relative min-h-screen overflow-hidden text-stone-100">
      <div
        className={`mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-3 py-4 sm:gap-8 sm:px-6 sm:py-6 lg:px-8 ${
          app.showFloatingMatchTimer ? 'pb-52 sm:pb-56 lg:pb-10' : 'pb-28 sm:pb-32 lg:pb-10'
        }`}
      >
        <section id="section-pre-match" className="scroll-mt-4">
          <header className="grid gap-5 rounded-[1.5rem] border border-white/10 bg-white/5 p-4 shadow-board backdrop-blur sm:rounded-[2rem] sm:gap-6 sm:p-6 md:grid-cols-[1.1fr_0.9fr]">
            <HeroPanel />
            <SettingsPanel
              state={app.formState}
              dispatch={app.dispatch}
              playerOptions={app.playerOptions}
              rosterCount={app.rosterCount}
              isPending={app.isPending}
              onGenerate={app.handleGenerate}
            />
          </header>
        </section>

        <section id="section-match-mode" className="scroll-mt-4 space-y-5">
          {app.displayPlan && app.plan ? (
            <>
              <MatchOverview
                plan={app.displayPlan}
                playerNameById={app.playerNameById}
                matchProgress={app.matchProgress}
                matchTimeline={app.matchTimeline}
                selectedTimerPeriod={app.selectedTimerPeriod}
                canSelectTimerPeriod={app.canSelectTimerPeriod}
                onStartMatch={app.handleStartMatch}
                onPauseMatch={app.handlePauseMatch}
                onResumeMatch={app.handleResumeMatch}
                onResetMatch={app.handleResetMatchTimer}
                onSelectTimerPeriod={app.handleSelectTimerPeriod}
              />

              {app.showLiveNowPanel ? (
                <LiveNowPanel
                  id={LIVE_NOW_SECTION_ID}
                  key={`live-period-${app.matchProgress!.activePeriod}`}
                  plan={app.displayPlan}
                  period={
                    app.displayPlan.periods.find((period) => period.period === app.matchProgress!.activePeriod) ??
                    app.displayPlan.periods[0]
                  }
                  availability={app.liveAvailability!}
                  nameById={app.playerNameById}
                  activeMinute={roundMinuteValue(app.matchProgress!.elapsedMs / 60_000)}
                  activeChunkIndex={app.matchProgress!.activeChunkIndex!}
                  unavailableRoleById={app.unavailableRoleById}
                  onApplyLiveEvent={app.handleApplyLiveEvent}
                />
              ) : null}

              {app.liveError ? (
                <section className="rounded-[1.35rem] border border-red-400/20 bg-red-950/40 px-4 py-3 text-sm text-red-100">
                  {app.liveError}
                </section>
              ) : null}

              <section className="grid gap-5 xl:grid-cols-3">
                {app.displayPlan.periods.map((period, index) => {
                  const boardAssignments =
                    app.normalizedOverrides[period.period] ?? createBoardAssignments(app.plan!.periods[index])

                  return (
                    <PeriodCard
                      key={`${app.displayPlan!.seed}-${period.period}`}
                      period={period}
                      boardAssignments={boardAssignments}
                      nameById={app.playerNameById}
                      defaultLockedSlots={
                        app.displayPlan!.lockedGoalkeepers[index] ? [GOALKEEPER_SLOT] : []
                      }
                      isActivePeriod={app.matchProgress?.activePeriod === period.period}
                      activeChunkIndex={
                        app.matchProgress?.activePeriod === period.period ? app.matchProgress.activeChunkIndex : null
                      }
                      periodState={getPeriodState(period.period, app.matchProgress)}
                      onSwapSlots={(sourceSlot, targetSlot) =>
                        app.handleSwapPeriodSlots(period.period, boardAssignments, sourceSlot, targetSlot)
                      }
                    />
                  )
                })}
              </section>

              {app.showFloatingMatchTimer ? (
                <FloatingMatchTimer
                  matchProgress={app.matchProgress!}
                  matchTimeline={app.matchTimeline!}
                  canScrollToLiveNowSection={app.showLiveNowPanel}
                  onScrollToLiveNowSection={app.handleScrollToLiveNowSection}
                />
              ) : null}
            </>
          ) : (
            <section className="rounded-[1.75rem] border border-white/10 bg-black/20 p-8 text-center text-stone-300">
              Fyll i minst 8 unika spelare för att skapa ett matchschema.
            </section>
          )}
        </section>

        {app.displayPlan && app.plan ? (
          <section id="section-minutes" className="scroll-mt-4">
            <PlayerMinutesSection plan={app.displayPlan} />
          </section>
        ) : null}
      </div>
      <BottomTabBar
        activeTab={app.activeBottomTab}
        hasGeneratedPlan={app.hasGeneratedPlan}
        onSelectTab={app.handleSelectBottomTab}
      />
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
          2, 3, 4 eller 5 planerade byten per period.
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
  onGenerate,
}: {
  state: FormState
  dispatch: Dispatch<FormAction>
  playerOptions: string[]
  rosterCount: number
  isPending: boolean
  onGenerate: () => void
}) {
  const showChunkRecommendation = rosterCount >= 10 && getSubstitutionsPerPeriod(state.periodMinutes, state.chunkMinutes) <= 2
  const substitutionOptions = getSubstitutionOptions(state.periodMinutes, state.chunkMinutes)
  const hasRepeatedManualGoalkeeper = hasRepeatedManualGoalkeeperSelection(state.goalkeeperSelections)

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
          {state.periodCount} {state.periodCount === 1 ? 'period' : 'perioder'}
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

        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Matchformat" htmlFor="match-format">
            <SelectControl
              id="match-format"
              value={state.periodMinutes}
              onChange={(event) =>
                dispatch({ type: 'setPeriodMinutes', value: Number(event.target.value) })
              }
            >
              {PERIOD_MINUTE_OPTIONS.map((periodMinutes) => (
                <option key={`period-minutes-${periodMinutes}`} value={periodMinutes}>
                  {periodMinutes} minuter
                </option>
              ))}
            </SelectControl>
          </Field>

          <Field label="Antal perioder" htmlFor="period-count">
            <SelectControl
              id="period-count"
              value={state.periodCount}
              onChange={(event) =>
                dispatch({ type: 'setPeriodCount', value: Number(event.target.value) })
              }
            >
              {PERIOD_COUNT_OPTIONS.map((periodCount) => (
                <option key={`period-count-${periodCount}`} value={periodCount}>
                  {periodCount}
                </option>
              ))}
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
                per period kan väntan bli lång. Prova gärna fler byten om du vill korta bänkpassen.
              </p>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: state.periodCount }, (_, index) => (
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
        {hasRepeatedManualGoalkeeper ? (
          <div className="rounded-[1.25rem] border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-50">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-amber-100/80">
              Målvaktsvarning
            </p>
            <p className="mt-1">
              Samma målvakt är vald i flera perioder. Det är tillåtet, men kan ge ojämn speltid och
              fler analysflaggor.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onGenerate}
            disabled={isPending}
            className="inline-flex h-12 w-full items-center justify-center rounded-full bg-clay-400 px-6 font-display text-lg font-bold text-clay-900 transition hover:bg-clay-300 disabled:cursor-wait disabled:opacity-70 sm:w-auto"
          >
            {isPending ? 'Genererar...' : 'Generera uppställning'}
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

function LiveNowPanel({
  id,
  plan,
  period,
  availability,
  nameById,
  activeMinute,
  activeChunkIndex,
  unavailableRoleById,
  onApplyLiveEvent,
}: {
  id?: string
  plan: MatchPlan
  period: PeriodPlan
  availability: LiveAvailabilityState
  nameById: Record<string, string>
  activeMinute: number
  activeChunkIndex: number
  unavailableRoleById: Record<string, LiveAdjustmentRole>
  onApplyLiveEvent: (event:
    | {
        type: 'temporary-out'
        playerId: string
        replacementPlayerId: string
        role: LiveAdjustmentRole
      }
    | {
        type: 'return'
        playerId: string
        replacementPlayerId: string
        role: LiveAdjustmentRole
      }
    | {
        type: 'position-swap'
        playerId: string
        targetPlayerId: string
      }) => void
}) {
  const activeChunk = period.chunks[activeChunkIndex] ?? null
  const allPlayerIds = useMemo(
    () => plan.summaries.map((summary) => summary.playerId),
    [plan.summaries],
  )
  const availableBenchPlayerIds = useMemo(() => {
    if (!activeChunk) {
      return []
    }

    const activePlayerIds = new Set(activeChunk.activePlayerIds)
    return allPlayerIds.filter(
      (playerId) => !activePlayerIds.has(playerId) && availability[playerId] === 'available',
    )
  }, [activeChunk, allPlayerIds, availability])
  const nextPlannedChunk = period.chunks[activeChunkIndex + 1] ?? null
  const unavailablePlayers = useMemo(
    () =>
      plan.summaries.filter((summary) => {
        const status = availability[summary.playerId]
        return status !== 'available'
      }),
    [availability, plan.summaries],
  )
  const [liveDraft, setLiveDraft] = useState<LiveEventDraft | null>(null)

  const createActionPickerDraft = (playerId: string): LiveEventDraft => ({
    type: 'action-picker',
    playerId,
  })

  const createUnavailableDraft = (playerId: string): LiveEventDraft => {
    const role: LiveAdjustmentRole = activeChunk?.goalkeeperId === playerId ? 'goalkeeper' : 'outfield'
    const recommendations = getLiveRecommendations({
      plan,
      availability,
      period: period.period,
      minute: activeMinute,
      playerId,
      type: 'temporary-out',
      role,
    })

    return {
      type: 'unavailable',
      playerId,
      role,
      recommendations,
      selectedReplacementPlayerId: recommendations[0]?.playerId ?? null,
    }
  }

  const createPositionSwapDraft = (playerId: string): LiveEventDraft => {
    const candidates = [
      ...period.positions
        .map((position) => ({
          playerId: activeChunk?.lineup[position] ?? null,
          position,
        }))
        .filter(
          (candidate): candidate is { playerId: string; position: OutfieldPosition } =>
            candidate.playerId !== null && candidate.playerId !== playerId,
        ),
      ...(activeChunk && activeChunk.goalkeeperId !== playerId
        ? [{ playerId: activeChunk.goalkeeperId, position: 'MV' as const }]
        : []),
      ...availableBenchPlayerIds
        .filter((candidateId) => candidateId !== playerId)
        .map((candidateId, index) => ({
          playerId: candidateId,
          position: getBenchSlotId(index),
        })),
    ]

    return {
      type: 'position-swap',
      playerId,
      candidates,
      selectedTargetPlayerId: candidates[0]?.playerId ?? null,
    }
  }

  const createReturnDraft = (playerId: string): LiveEventDraft => {
    const role = unavailableRoleById[playerId] ?? 'outfield'
    const recommendations = getLiveRecommendations({
      plan,
      availability,
      period: period.period,
      minute: activeMinute,
      playerId,
      type: 'return',
      role,
    })

    return {
      type: 'return',
      playerId,
      role,
      recommendations,
      selectedReplacementPlayerId: recommendations[0]?.playerId ?? null,
    }
  }

  const handleConfirmLiveDraft = () => {
    if (!liveDraft) {
      return
    }

    if (liveDraft.type === 'position-swap') {
      if (!liveDraft.selectedTargetPlayerId) {
        return
      }

      onApplyLiveEvent({
        type: 'position-swap',
        playerId: liveDraft.playerId,
        targetPlayerId: liveDraft.selectedTargetPlayerId,
      })
      setLiveDraft(null)
      return
    }

    if (liveDraft.type === 'action-picker' || !liveDraft.selectedReplacementPlayerId) {
      return
    }

    onApplyLiveEvent({
      type: liveDraft.type === 'return' ? 'return' : 'temporary-out',
      playerId: liveDraft.playerId,
      replacementPlayerId: liveDraft.selectedReplacementPlayerId,
      role: liveDraft.role,
    })
    setLiveDraft(null)
  }

  if (!activeChunk) {
    return null
  }

  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-[1.75rem] border border-clay-300/20 bg-clay-500/10 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur sm:p-5"
    >
      <div className="mb-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-clay-100/75">
            Live just nu
          </p>
          <p className="mt-1 text-sm text-white">
            Period {period.period} · {formatMinuteRangeLabel(activeChunk.startMinute, activeChunk.endMinute)} · minut{' '}
            {formatMinuteValue(activeMinute)}
          </p>
        </div>
      </div>

      <div className="mb-3 space-y-3">
        <NextSubstitutionsPanel chunk={nextPlannedChunk} nameById={nameById} />
        <BenchBadgePanel
          title="Tillgänglig bänk"
          hint="Spelare som kan komma in direkt just nu."
          playerIds={availableBenchPlayerIds}
          nameById={nameById}
          emptyLabel="Ingen tillgänglig bänk just nu"
        />
      </div>

      <LiveFormationBoard
        formation={period.formation}
        lineup={activeChunk.lineup}
        goalkeeperId={activeChunk.goalkeeperId}
        nameById={nameById}
        onOpenActionPicker={(playerId) => setLiveDraft(createActionPickerDraft(playerId))}
        onMarkUnavailable={(playerId) => setLiveDraft(createUnavailableDraft(playerId))}
        onStartPositionSwap={(playerId) => setLiveDraft(createPositionSwapDraft(playerId))}
      />

      <div className="mt-3 rounded-[1rem] border border-white/10 bg-black/20 px-3 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">
              Ej tillgängliga nu
            </p>
            <p className="mt-1 text-sm text-stone-300">
              Spelare som är tillfälligt ute kan sättas tillbaka direkt härifrån.
            </p>
          </div>
          <p className="text-sm text-white">
            {unavailablePlayers.length > 0 ? `${unavailablePlayers.length} spelare` : 'Ingen just nu'}
          </p>
        </div>
        {unavailablePlayers.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {unavailablePlayers.map((summary) => {
              return (
                <button
                  key={`unavailable-${summary.playerId}`}
                  type="button"
                  onClick={() => {
                    const nextDraft = createReturnDraft(summary.playerId)
                    setLiveDraft(nextDraft)
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-white transition hover:border-clay-300/35 hover:bg-clay-500/10"
                >
                  <span className="inline-flex rounded-full bg-clay-400/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-clay-50">
                    Tillfälligt ute
                  </span>
                  <span>{summary.name}</span>
                  <span className="inline-flex items-center gap-1 text-stone-300">
                    <UserPlus className="h-3.5 w-3.5" />
                    Klar för spel
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone-400">Alla spelare är tillgängliga.</p>
        )}
      </div>

      {liveDraft ? (
        <LiveAdjustmentPanel
          draft={liveDraft}
          playerNameById={nameById}
          onClose={() => setLiveDraft(null)}
          onChooseUnavailable={(playerId) => setLiveDraft(createUnavailableDraft(playerId))}
          onChoosePositionSwap={(playerId) => setLiveDraft(createPositionSwapDraft(playerId))}
          onSelectPlayer={(playerId) =>
            setLiveDraft((current) =>
              current && current.type !== 'action-picker'
                ? {
                    ...current,
                    ...(current.type === 'position-swap'
                      ? { selectedTargetPlayerId: playerId }
                      : { selectedReplacementPlayerId: playerId }),
                  }
                : current,
            )
          }
          onConfirm={handleConfirmLiveDraft}
        />
      ) : null}
    </section>
  )
}

function MatchOverview({
  plan,
  playerNameById,
  matchProgress,
  matchTimeline,
  selectedTimerPeriod,
  canSelectTimerPeriod,
  onStartMatch,
  onPauseMatch,
  onResumeMatch,
  onResetMatch,
  onSelectTimerPeriod,
}: {
  plan: MatchPlan
  playerNameById: Record<string, string>
  matchProgress: MatchProgress | null
  matchTimeline: MatchTimeline | null
  selectedTimerPeriod: number
  canSelectTimerPeriod: boolean
  onStartMatch: () => void
  onPauseMatch: () => void
  onResumeMatch: () => void
  onResetMatch: () => void
  onSelectTimerPeriod: (periodNumber: number) => void
}) {
  return (
    <section className="rounded-[1.75rem] border border-white/10 bg-white/5 p-5 backdrop-blur">
      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div>
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
            <SummaryChip label="Totaltid" value={`${plan.periodMinutes * plan.periods.length} min match`} />
          </div>
        </div>

        {matchProgress && matchTimeline ? (
          <MatchTimerPanel
            plan={plan}
            matchProgress={matchProgress}
            matchTimeline={matchTimeline}
            selectedTimerPeriod={selectedTimerPeriod}
            canSelectTimerPeriod={canSelectTimerPeriod}
            onStartMatch={onStartMatch}
            onPauseMatch={onPauseMatch}
            onResumeMatch={onResumeMatch}
            onResetMatch={onResetMatch}
            onSelectTimerPeriod={onSelectTimerPeriod}
          />
        ) : null}
      </div>
    </section>
  )
}

function MatchTimerPanel({
  plan,
  matchProgress,
  matchTimeline,
  selectedTimerPeriod,
  canSelectTimerPeriod,
  onStartMatch,
  onPauseMatch,
  onResumeMatch,
  onResetMatch,
  onSelectTimerPeriod,
}: {
  plan: MatchPlan
  matchProgress: MatchProgress
  matchTimeline: MatchTimeline
  selectedTimerPeriod: number
  canSelectTimerPeriod: boolean
  onStartMatch: () => void
  onPauseMatch: () => void
  onResumeMatch: () => void
  onResetMatch: () => void
  onSelectTimerPeriod: (periodNumber: number) => void
}) {
  const statusLabel = getMatchStatusLabel(matchProgress)
  const statusSummary = getMatchProgressSummary(matchProgress, selectedTimerPeriod)
  const selectedPeriodChunks = getTimelineChunksForPeriod(matchTimeline, selectedTimerPeriod)

  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-clay-300/20 bg-[radial-gradient(circle_at_top,_rgba(212,125,51,0.18),_transparent_42%),linear-gradient(180deg,rgba(36,20,13,0.92),rgba(16,10,7,0.96))] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-clay-100/70">
            Periodtimer
          </p>
          <h3 className="mt-2 font-display text-4xl font-black text-white">
            {formatMatchClock(matchProgress.elapsedMs)}
          </h3>
          <p className="mt-2 text-sm text-stone-300">
            {matchProgress.status === 'finished'
              ? `Period ${matchProgress.activePeriod ?? selectedTimerPeriod} klar`
              : `${formatMatchClock(matchProgress.remainingMs)} kvar av ${formatMatchClock(matchTimeline.periodDurationMs)}`}
          </p>
          <p className="mt-2 text-xs font-medium uppercase tracking-[0.18em] text-clay-100/70">
            {statusSummary}
          </p>
        </div>

        <div
          className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] ${matchProgress.status === 'finished'
              ? 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100'
              : matchProgress.status === 'running'
                ? 'border-clay-300/30 bg-clay-400/10 text-clay-50'
                : matchProgress.status === 'paused'
                  ? 'border-sky-300/30 bg-sky-400/10 text-sky-100'
                  : 'border-white/10 bg-black/20 text-stone-300'
            }`}
        >
          {statusLabel}
        </div>
      </div>

      <div className="mt-5">
        <div className="relative overflow-hidden rounded-[1.1rem] border border-white/10 bg-black/30 px-2 py-2.5">
          <div className="pointer-events-none absolute inset-y-0 left-0 rounded-[0.9rem] bg-[linear-gradient(90deg,rgba(212,125,51,0.72),rgba(251,191,36,0.55))] transition-[width] duration-700 ease-out" style={{ width: `${matchProgress.progress * 100}%` }} />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-full">
            {selectedPeriodChunks.slice(0, -1).map((chunk) => (
              <span
                key={`chunk-marker-${chunk.period}-${chunk.chunkIndex}`}
                className="absolute top-0 h-full w-px bg-white/12"
                style={{ left: `${(chunk.endMs / matchTimeline.periodDurationMs) * 100}%` }}
              />
            ))}
          </div>
          <div className="relative grid grid-cols-3 gap-2">
            {Array.from({ length: plan.periods.length }, (_, index) => {
              const periodNumber = index + 1
              const periodState = getPeriodState(periodNumber, matchProgress)
              const isSelectedTimerPeriod = selectedTimerPeriod === periodNumber

              return (
                <button
                  type="button"
                  key={`timeline-period-${periodNumber}`}
                  onClick={() => onSelectTimerPeriod(periodNumber)}
                  disabled={!canSelectTimerPeriod}
                  aria-pressed={isSelectedTimerPeriod}
                  className={`rounded-[0.9rem] border px-3 py-2 text-left transition ${periodState === 'active'
                      ? 'border-clay-200/40 bg-white/10'
                      : periodState === 'completed'
                        ? 'border-emerald-300/15 bg-emerald-400/5'
                        : isSelectedTimerPeriod
                          ? 'border-clay-300/35 bg-clay-500/15'
                          : 'border-white/8 bg-black/10'
                    } ${canSelectTimerPeriod ? 'hover:border-clay-200/35 hover:bg-white/10' : 'cursor-default opacity-90'}`}
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-stone-300/80">
                    Period {periodNumber}
                  </p>
                  <p className="mt-1 text-sm font-medium text-white">{plan.periodMinutes} min</p>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        {(matchProgress.status === 'idle' || matchProgress.status === 'finished') ? (
          <button
            type="button"
            onClick={onStartMatch}
            className="inline-flex h-11 items-center justify-center rounded-full bg-clay-400 px-5 font-display text-base font-bold text-clay-900 transition hover:bg-clay-300"
          >
            Starta period {selectedTimerPeriod}
          </button>
        ) : null}
        {matchProgress.status === 'running' ? (
          <button
            type="button"
            onClick={onPauseMatch}
            className="inline-flex h-11 items-center justify-center rounded-full bg-sky-300 px-5 font-display text-base font-bold text-sky-950 transition hover:bg-sky-200"
          >
            Pausa klockan
          </button>
        ) : null}
        {matchProgress.status === 'paused' ? (
          <button
            type="button"
            onClick={onResumeMatch}
            className="inline-flex h-11 items-center justify-center rounded-full bg-clay-400 px-5 font-display text-base font-bold text-clay-900 transition hover:bg-clay-300"
          >
            Fortsätt period {matchProgress.activePeriod ?? selectedTimerPeriod}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onResetMatch}
          className="inline-flex h-11 items-center justify-center rounded-full border border-white/10 bg-white/5 px-5 font-display text-base font-bold text-white transition hover:border-clay-300/40 hover:bg-clay-500/10"
        >
          Nollställ
        </button>
      </div>
    </section>
  )
}

function FloatingMatchTimer({
  matchProgress,
  matchTimeline,
  canScrollToLiveNowSection,
  onScrollToLiveNowSection,
}: {
  matchProgress: MatchProgress
  matchTimeline: MatchTimeline
  canScrollToLiveNowSection: boolean
  onScrollToLiveNowSection: () => void
}) {
  const statusLabel = getMatchStatusLabel(matchProgress)

  return (
    <aside className="pointer-events-none fixed inset-x-3 bottom-24 z-40 sm:bottom-28 lg:inset-x-auto lg:right-4 lg:top-4 lg:bottom-auto">
      <div className="pointer-events-auto rounded-[1.35rem] border border-white/10 bg-[linear-gradient(180deg,rgba(8,24,13,0.94),rgba(12,18,10,0.96))] px-4 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.38)] backdrop-blur lg:min-w-[18rem]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-clay-100/70">
              Live
            </p>
            <p className="mt-1 font-display text-3xl font-black text-white">
              {formatMatchClock(matchProgress.elapsedMs)}
            </p>
          </div>
          <div className="text-right">
            <p className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-200">
              {statusLabel}
            </p>
            <p className="mt-2 text-xs text-stone-300">
              {matchProgress.status === 'finished'
                ? 'Period klar'
                : `${formatMatchClock(matchProgress.remainingMs)} kvar`}
            </p>
          </div>
        </div>
        {canScrollToLiveNowSection ? (
          <button
            type="button"
            onClick={onScrollToLiveNowSection}
            className="mt-3 text-left text-xs font-medium uppercase tracking-[0.18em] text-clay-100/75 transition hover:text-clay-50 focus:outline-none focus:ring-2 focus:ring-clay-300/30"
          >
            {getMatchProgressSummary(matchProgress, matchProgress.activePeriod ?? DEFAULT_SELECTED_TIMER_PERIOD)}
          </button>
        ) : (
          <p className="mt-3 text-xs font-medium uppercase tracking-[0.18em] text-clay-100/75">
            {getMatchProgressSummary(matchProgress, matchProgress.activePeriod ?? DEFAULT_SELECTED_TIMER_PERIOD)}
          </p>
        )}
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[linear-gradient(90deg,rgba(212,125,51,0.82),rgba(251,191,36,0.64))] transition-[width] duration-700 ease-out"
            style={{ width: `${matchProgress.progress * 100}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-stone-400">
          {formatMatchClock(matchTimeline.periodDurationMs)} per period
        </p>
      </div>
    </aside>
  )
}

function BottomTabBar({
  activeTab,
  hasGeneratedPlan,
  onSelectTab,
}: {
  activeTab: BottomTabId
  hasGeneratedPlan: boolean
  onSelectTab: (tabId: BottomTabId) => void
}) {
  return (
    <nav
      aria-label="Bottennavigation"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-30 sm:bottom-4"
    >
      <div className="pointer-events-auto mx-auto flex w-full max-w-xl items-center gap-2 rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(8,24,13,0.94),rgba(12,18,10,0.98))] p-2 shadow-[0_24px_60px_rgba(0,0,0,0.32)] backdrop-blur">
        {BOTTOM_TAB_ITEMS.map((tab) => {
          const isActive = tab.id === activeTab
          const isDisabled = !hasGeneratedPlan && tab.id !== 'pre-match'

          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={isActive}
              disabled={isDisabled}
              onClick={() => onSelectTab(tab.id)}
              className={`flex min-w-0 flex-1 items-center justify-center rounded-[1.15rem] px-3 py-3 text-center transition ${
                isActive
                  ? 'bg-clay-400 text-clay-950 shadow-[0_10px_30px_rgba(212,125,51,0.3)]'
                  : 'bg-white/[0.03] text-stone-200 hover:bg-white/[0.08]'
              } ${isDisabled ? 'cursor-not-allowed opacity-45 hover:bg-white/[0.03]' : ''}`}
            >
              <span className="truncate font-display text-sm font-bold sm:text-base">{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
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
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="font-display text-2xl font-bold text-white">{summary.name}</h3>
                    <p className="font-mono text-xs uppercase tracking-[0.24em] text-stone-400">
                      {summary.goalkeeperPeriods.length > 0
                        ? `MV i period ${summary.goalkeeperPeriods.join(', ')}`
                        : 'Ingen målvaktsperiod'}
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                    <div className="rounded-2xl bg-clay-400 px-3 py-2 text-left text-clay-900 sm:text-right">
                      <p className="font-display text-2xl font-black">
                        {formatMinuteQuantity(minuteBreakdown.totalMinutes)}
                      </p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.22em]">totalt</p>
                    </div>
                    <span className="inline-flex w-fit rounded-full border border-white/10 bg-black/20 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-300">
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
                      {formatMinuteQuantity(minuteBreakdown.goalkeeperMinutes)} min
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-100/80">
                      Utespelare
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">
                      {formatMinuteQuantity(minuteBreakdown.outfieldMinutes)} min
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                      Bänktid
                    </dt>
                    <dd className="mt-1 text-lg font-semibold text-white">
                      {formatMinuteQuantity(summary.benchMinutes)} min
                    </dd>
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
                  MV: {formatMinuteQuantity(minuteBreakdown.goalkeeperMinutes)} min + Utespelare:{' '}
                  {formatMinuteQuantity(minuteBreakdown.outfieldMinutes)} min ={' '}
                  {formatMinuteQuantity(minuteBreakdown.totalMinutes)} min totalt
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
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <DetailStat
                    label="MV-tid"
                    value={`${formatMinuteQuantity(minuteBreakdown.goalkeeperMinutes)} min`}
                  />
                  <DetailStat
                    label="Utespelartid"
                    value={`${formatMinuteQuantity(minuteBreakdown.outfieldMinutes)} min`}
                  />
                  <DetailStat
                    label="Totaltid"
                    value={`${formatMinuteQuantity(minuteBreakdown.totalMinutes)} min`}
                  />
                  <DetailStat
                    label="Bänktid"
                    value={`${formatMinuteQuantity(summary.benchMinutes)} min`}
                  />
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
                            {formatMinuteQuantity(periodDetail.totalMinutes)} min totalt ·{' '}
                            {formatMinuteQuantity(periodDetail.goalkeeperMinutes)} min MV ·{' '}
                            {formatMinuteQuantity(periodDetail.outfieldMinutes)} min utespelare
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
  isActivePeriod,
  activeChunkIndex,
  periodState,
}: {
  period: PeriodPlan
  boardAssignments: Record<BoardSlotId, string>
  nameById: Record<string, string>
  onSwapSlots: (sourceSlot: BoardSlotId, targetSlot: BoardSlotId) => void
  defaultLockedSlots: BoardSlotId[]
  isActivePeriod: boolean
  activeChunkIndex: number | null
  periodState: 'upcoming' | 'active' | 'completed'
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
    <article
      data-period={period.period}
      data-period-state={periodState}
      className={`rounded-[1.5rem] border p-3.5 backdrop-blur transition sm:rounded-[1.75rem] sm:p-5 ${periodState === 'active'
          ? 'border-clay-300/35 bg-white/[0.08] shadow-[0_0_0_1px_rgba(251,191,36,0.08),0_18px_45px_rgba(0,0,0,0.18)]'
          : periodState === 'completed'
            ? 'border-emerald-300/10 bg-white/[0.06]'
            : 'border-white/10 bg-white/5'
        }`}
    >
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-clay-200">Period {period.period}</p>
          <h2 className="mt-1 font-display text-2xl font-black text-white sm:text-3xl">
            MV: {displayGoalkeeperName}
          </h2>
          <p className="mt-1 text-sm text-stone-300">Formation: {period.formation}</p>
        </div>
        <div
          className={`w-full rounded-2xl border px-3 py-2 text-left sm:w-auto sm:max-w-[18rem] sm:text-right ${isActivePeriod
              ? 'border-clay-300/30 bg-clay-400/10'
              : 'border-white/10 bg-black/20'
            }`}
        >
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
          const chunkState = getChunkState(periodState, activeChunkIndex, chunk.windowIndex)

          return (
            <div
              key={chunk.chunkIndex}
              id={getChunkAnchorId(period.period, chunk.windowIndex)}
              data-chunk-index={chunk.windowIndex}
              data-chunk-state={chunkState}
              className={`rounded-[1.1rem] border px-3 py-3 transition sm:rounded-[1.25rem] sm:px-4 ${chunkState === 'active'
                  ? 'border-clay-300/35 bg-clay-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.06)]'
                  : chunkState === 'completed'
                    ? 'border-emerald-300/12 bg-emerald-400/[0.05]'
                    : 'border-white/10 bg-black/20'
                }`}
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

function LiveFormationBoard({
  formation,
  lineup,
  goalkeeperId,
  nameById,
  onOpenActionPicker,
  onMarkUnavailable,
  onStartPositionSwap,
}: {
  formation: FormationKey
  lineup: Lineup
  goalkeeperId: string
  nameById: Record<string, string>
  onOpenActionPicker: (playerId: string) => void
  onMarkUnavailable: (playerId: string) => void
  onStartPositionSwap: (playerId: string) => void
}) {
  return (
    <div className="rounded-[1.1rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.14),_transparent_40%),linear-gradient(180deg,rgba(13,43,19,0.96),rgba(7,25,11,0.98))] p-3">
      <div className="space-y-3">
        {FORMATION_PRESETS[formation].rows.map((row) => (
          <div key={`live-row-${formation}-${row.join('-')}`} className="flex items-center justify-center gap-2">
            {row.map((position) => {
              const playerId = lineup[position]
              const playerName = readLineupPlayer(lineup, position, nameById)

              return (
                <LivePositionBadge
                  key={`live-position-${position}-${playerId ?? 'empty'}`}
                  label={position}
                  player={playerName}
                  tone={getPositionTone(position)}
                  onOpenActionPicker={playerId ? () => onOpenActionPicker(playerId) : undefined}
                  onMarkUnavailable={playerId ? () => onMarkUnavailable(playerId) : undefined}
                  onStartPositionSwap={playerId ? () => onStartPositionSwap(playerId) : undefined}
                />
              )
            })}
          </div>
        ))}
        <div className="mx-auto mt-1.5 flex max-w-32 justify-center border-t border-dashed border-white/10 pt-3">
          <LivePositionBadge
            label="MV"
            player={nameById[goalkeeperId] ?? '-'}
            tone="gk"
            onOpenActionPicker={() => onOpenActionPicker(goalkeeperId)}
            onMarkUnavailable={() => onMarkUnavailable(goalkeeperId)}
            onStartPositionSwap={() => onStartPositionSwap(goalkeeperId)}
          />
        </div>
      </div>
    </div>
  )
}

function LivePositionBadge({
  label,
  player,
  tone,
  onOpenActionPicker,
  onMarkUnavailable,
  onStartPositionSwap,
}: {
  label: string
  player: string
  tone: 'def' | 'mid' | 'att' | 'gk'
  onOpenActionPicker?: () => void
  onMarkUnavailable?: () => void
  onStartPositionSwap?: () => void
}) {
  const toneClasses = {
    def: 'border-sky-300/35 bg-[linear-gradient(180deg,rgba(56,189,248,0.18),rgba(12,74,110,0.28))] text-sky-50',
    mid: 'border-emerald-300/35 bg-[linear-gradient(180deg,rgba(74,222,128,0.18),rgba(6,78,59,0.28))] text-emerald-50',
    att: 'border-rose-300/35 bg-[linear-gradient(180deg,rgba(251,113,133,0.18),rgba(127,29,29,0.28))] text-rose-50',
    gk: 'border-clay-300/35 bg-[linear-gradient(180deg,rgba(251,191,36,0.18),rgba(120,53,15,0.28))] text-amber-50',
  }
  const badgeClasses = `relative min-w-0 flex-1 rounded-[0.95rem] border px-2.5 py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ${toneClasses[tone]}`

  if (!onOpenActionPicker || !onMarkUnavailable || !onStartPositionSwap) {
    return (
      <div className={badgeClasses}>
        <div className="pointer-events-none">
          <p className="font-mono text-[9px] uppercase tracking-[0.26em] opacity-80">{label}</p>
          <p className="mt-2 text-sm font-semibold">{player}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${badgeClasses} overflow-visible`}>
      <button
        type="button"
        onClick={onMarkUnavailable}
        className="absolute -left-2 -top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/20 text-stone-300 backdrop-blur transition hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:-left-2.5 sm:-top-2.5 sm:h-9 sm:w-9"
        aria-label={`Markera ${player} som tillfälligt ute på ${label}`}
      >
        <Bandage className="h-3 w-3 sm:h-4 sm:w-4" />
      </button>
      <button
        type="button"
        onClick={onStartPositionSwap}
        className="absolute -right-2 -top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/20 text-stone-300 backdrop-blur transition hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 sm:-right-2.5 sm:-top-2.5 sm:h-9 sm:w-9"
        aria-label={`Starta positionsbyte för ${player} på ${label}`}
      >
        <ArrowLeftRight className="h-3 w-3 sm:h-4 sm:w-4" />
      </button>
      <button
        type="button"
        onClick={onOpenActionPicker}
        className="block w-full rounded-[0.7rem] px-1.5 py-1.5 transition hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
        aria-label={`Öppna liveval för ${player} på ${label}`}
      >
        <div className="pointer-events-none">
          <p className="font-mono text-[9px] uppercase tracking-[0.26em] opacity-80">{label}</p>
          <p className="mt-2 text-sm font-semibold">{player}</p>
        </div>
      </button>
    </div>
  )
}

function LiveAdjustmentPanel({
  draft,
  playerNameById,
  onClose,
  onChooseUnavailable,
  onChoosePositionSwap,
  onSelectPlayer,
  onConfirm,
}: {
  draft: LiveEventDraft
  playerNameById: Record<string, string>
  onClose: () => void
  onChooseUnavailable: (playerId: string) => void
  onChoosePositionSwap: (playerId: string) => void
  onSelectPlayer: (playerId: string) => void
  onConfirm: () => void
}) {
  const title =
    draft.type === 'action-picker'
      ? `${playerNameById[draft.playerId]}`
      : draft.type === 'return'
      ? `${playerNameById[draft.playerId]} är klar för spel`
      : draft.type === 'position-swap'
        ? `${playerNameById[draft.playerId]} positionsbyte`
      : `${playerNameById[draft.playerId]} är tillfälligt ute`
  const canConfirm =
    draft.type === 'position-swap'
      ? Boolean(draft.selectedTargetPlayerId)
      : draft.type === 'action-picker'
        ? false
        : Boolean(draft.selectedReplacementPlayerId)

  return (
    <div className="mt-3 rounded-[1rem] border border-clay-300/20 bg-black/25 p-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-clay-100/80">
            Live-byte
          </p>
          <h3 className="mt-1 text-lg font-semibold text-white">{title}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-stone-200 transition hover:border-white/20 hover:text-white"
        >
          Stäng
        </button>
      </div>

      {draft.type === 'action-picker' ? (
        <>
          <p className="mt-3 rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-3 text-sm text-stone-300">
            Välj vad du vill göra med {playerNameById[draft.playerId]} just nu.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onChooseUnavailable(draft.playerId)}
              className="rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:border-white/20 hover:bg-white/10"
            >
              <p className="text-sm font-semibold text-white">
                {playerNameById[draft.playerId]} är tillfälligt ute
              </p>
              <p className="mt-1 text-sm text-stone-300">Välj en ersättare från bänken.</p>
            </button>
            <button
              type="button"
              onClick={() => onChoosePositionSwap(draft.playerId)}
              className="rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:border-white/20 hover:bg-white/10"
            >
              <p className="text-sm font-semibold text-white">{playerNameById[draft.playerId]} positionsbyte</p>
              <p className="mt-1 text-sm text-stone-300">Välj en spelare som redan är på planen.</p>
            </button>
          </div>
        </>
      ) : (
        <>
          {draft.type === 'unavailable' ? (
            <p className="mt-3 rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-3 text-sm text-stone-300">
              Välj vem som ska ersätta spelaren medan den är tillfälligt ute.
            </p>
          ) : null}

          {draft.type === 'position-swap' ? (
            <p className="mt-3 rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-3 text-sm text-stone-300">
              Välj vem {playerNameById[draft.playerId]} ska byta position med, antingen på planen eller från bänken.
            </p>
          ) : null}

          <div className="mt-3 space-y-2">
            {draft.type === 'position-swap' ? (
              draft.candidates.length > 0 ? (
                draft.candidates.map((candidate) => (
                  <button
                    key={`position-swap-${draft.playerId}-${candidate.playerId}-${candidate.position}`}
                    type="button"
                    onClick={() => onSelectPlayer(candidate.playerId)}
                    className={`flex w-full items-start justify-between gap-3 rounded-[0.95rem] border px-3 py-3 text-left transition ${
                      draft.selectedTargetPlayerId === candidate.playerId
                        ? 'border-clay-300/35 bg-clay-500/10'
                        : 'border-white/10 bg-white/5 hover:border-white/20'
                    }`}
                  >
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {playerNameById[candidate.playerId]}
                      </p>
                      <p className="mt-1 text-sm text-stone-300">
                        {candidate.position.startsWith('B')
                          ? 'Är tillgänglig på bänken och kan komma in direkt.'
                          : 'Är på planen nu och kan byta position direkt.'}
                      </p>
                    </div>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-stone-300">
                      {candidate.position}
                    </span>
                  </button>
                ))
              ) : (
                <div className="rounded-[0.95rem] border border-amber-300/20 bg-amber-400/10 px-3 py-3 text-sm text-amber-50">
                  Det finns ingen annan spelare på planen att byta position med just nu.
                </div>
              )
            ) : draft.recommendations.length > 0 ? (
              draft.recommendations.map((recommendation, index) => (
                <button
                  key={`live-recommendation-${draft.playerId}-${recommendation.playerId}-${recommendation.position}`}
                  type="button"
                  onClick={() => onSelectPlayer(recommendation.playerId)}
                  className={`flex w-full items-start justify-between gap-3 rounded-[0.95rem] border px-3 py-3 text-left transition ${
                    draft.selectedReplacementPlayerId === recommendation.playerId
                      ? 'border-clay-300/35 bg-clay-500/10'
                      : 'border-white/10 bg-white/5 hover:border-white/20'
                  }`}
                >
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {playerNameById[recommendation.playerId]}
                      {index === 0 ? (
                        <span className="ml-2 rounded-full bg-clay-400/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-clay-50">
                          Rek
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-sm text-stone-300">{recommendation.reason}</p>
                  </div>
                  <span className="rounded-full border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-stone-300">
                    {recommendation.position}
                  </span>
                </button>
              ))
            ) : (
              <div className="rounded-[0.95rem] border border-amber-300/20 bg-amber-400/10 px-3 py-3 text-sm text-amber-50">
                Det finns ingen tillgänglig rekommendation just nu.
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="inline-flex items-center gap-2 text-sm text-stone-300">
              <AlertTriangle className="h-4 w-4 text-clay-200" />
              Resten av matchen räknas om direkt efter bekräftelse.
            </p>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!canConfirm}
              className="inline-flex items-center justify-center rounded-full bg-clay-400 px-4 py-2 text-sm font-semibold text-clay-900 transition hover:bg-clay-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Bekräfta live-byte
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function BenchBadgePanel({
  title,
  hint,
  playerIds,
  nameById,
  emptyLabel,
}: {
  title: string
  hint?: string
  playerIds: string[]
  nameById: Record<string, string>
  emptyLabel: string
}) {
  return (
    <div className="rounded-[1rem] border border-white/10 bg-black/20 px-3 py-3 sm:rounded-[1.2rem]">
      <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">{title}</p>
        {hint ? <p className="text-[10px] text-stone-500">{hint}</p> : null}
      </div>

      {playerIds.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {playerIds.map((playerId, index) => (
            <PositionBadgeCard
              key={`${title}-${playerId}`}
              label={getBenchSlotId(index)}
              player={nameById[playerId] ?? '-'}
              tone="bench"
              locked={false}
              dragState="idle"
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-stone-400">{emptyLabel}</p>
      )}
    </div>
  )
}

function NextSubstitutionsPanel({
  chunk,
  nameById,
}: {
  chunk: PeriodPlan['chunks'][number] | null
  nameById: Record<string, string>
}) {
  return (
    <div className="rounded-[1rem] border border-white/10 bg-black/20 px-3 py-3 sm:rounded-[1.2rem]">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">Nästa byten</p>
          <p className="mt-1 text-sm text-stone-300">
            {chunk
              ? `${formatMinuteRangeLabel(chunk.startMinute, chunk.endMinute)} · Byteblock ${chunk.windowIndex + 1}`
              : 'Inga fler planerade byten i perioden.'}
          </p>
        </div>
      </div>

      {chunk ? (
        <div className="mt-3 space-y-2">
          {chunk.substitutions.length > 0 ? (
            chunk.substitutions.map((substitution) => (
              <div
                key={`next-substitution-${substitution.playerInId}-${substitution.playerOutId}-${substitution.position}`}
                className="rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-2.5 text-sm"
              >
                <span className="font-semibold text-emerald-300">{nameById[substitution.playerInId]}</span>
                <span className="text-stone-300"> in, </span>
                <span className="font-semibold text-amber-200">{nameById[substitution.playerOutId]}</span>
                <span className="text-stone-300"> ut ({substitution.position})</span>
              </div>
            ))
          ) : (
            <p className="rounded-[0.95rem] border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-stone-400">
              Inga planerade byten i nästa byteblock.
            </p>
          )}

          <p className="text-xs text-stone-500">
            Nästa bänk: {chunk.substitutes.length > 0 ? chunk.substitutes.join(', ') : 'Ingen'}
          </p>
        </div>
      ) : null}
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
          className={`absolute -right-2 -top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur sm:-right-2.5 sm:-top-2.5 sm:h-9 sm:w-9 ${locked
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
    <div className="min-w-0 rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
      <p className="break-words font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500 [overflow-wrap:anywhere]">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-medium text-white [overflow-wrap:anywhere]">{value}</p>
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
  tone: 'def' | 'mid' | 'att'
  emphasis: 'idle' | 'incoming' | 'outgoing' | 'swing'
  isSingle?: boolean
}) {
  const toneClasses = {
    def: 'border-sky-300/35 bg-[linear-gradient(180deg,rgba(56,189,248,0.16),rgba(12,74,110,0.24))] shadow-[inset_0_1px_0_rgba(186,230,253,0.08),0_0_0_1px_rgba(12,74,110,0.16)]',
    mid: 'border-emerald-300/35 bg-[linear-gradient(180deg,rgba(74,222,128,0.16),rgba(6,78,59,0.24))] shadow-[inset_0_1px_0_rgba(209,250,229,0.08),0_0_0_1px_rgba(6,78,59,0.16)]',
    att: 'border-clay-300/35 bg-[linear-gradient(180deg,rgba(212,125,51,0.18),rgba(69,37,21,0.28))] shadow-[inset_0_1px_0_rgba(251,191,36,0.08),0_0_0_1px_rgba(120,53,15,0.16)]',
  }
  const nameClasses = {
    idle: 'text-white',
    incoming: 'text-emerald-300',
    outgoing: 'text-amber-200',
    swing: 'text-clay-100',
  }

  return (
    <div
      className={`relative min-w-0 flex-1 rounded-[0.95rem] border px-2.5 py-2 text-center ${toneClasses[tone]} ${isSingle ? 'max-w-[11rem]' : ''
        }`}
    >
      <div className="pointer-events-none">
        <p className="font-mono text-[9px] uppercase tracking-[0.26em] text-white/75">{label}</p>
        <p className={`mt-1 truncate text-sm font-semibold ${nameClasses[emphasis]}`}>{player}</p>
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
  const storedTimer = readStoredActiveMatchTimer()

  if (sharedValue) {
    try {
      const hydratedState = createHydratedStateFromSnapshot(sharedValue)
      const hydratedDisplayPlan = applyLiveAdjustmentEvents({
        plan: applyPeriodOverrides(hydratedState.plan, hydratedState.periodOverrides),
        events: hydratedState.liveEvents,
      }).plan
      const matchTimeline = buildMatchTimeline(hydratedDisplayPlan)
      const activeMatchTimer =
        storedTimer &&
          storedTimer.lineupSnapshot === sharedValue &&
          isStoredActiveMatchTimerCompatible(storedTimer, matchTimeline)
          ? storedTimer
          : null

      return {
        ...hydratedState,
        shouldSyncShareUrl: true,
        selectedTimerPeriod: activeMatchTimer?.period ?? DEFAULT_SELECTED_TIMER_PERIOD,
        activeMatchTimer,
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

  if (!storedTimer) {
    return defaultState
  }

  try {
    const hydratedState = createHydratedStateFromSnapshot(storedTimer.lineupSnapshot)
    const hydratedDisplayPlan = applyLiveAdjustmentEvents({
      plan: applyPeriodOverrides(hydratedState.plan, hydratedState.periodOverrides),
      events: hydratedState.liveEvents,
    }).plan
    const matchTimeline = buildMatchTimeline(hydratedDisplayPlan)

    if (!isStoredActiveMatchTimerCompatible(storedTimer, matchTimeline)) {
      clearStoredActiveMatchTimer()
      return defaultState
    }

    return {
      ...hydratedState,
      shouldSyncShareUrl: false,
      selectedTimerPeriod: storedTimer.period,
      activeMatchTimer: storedTimer,
    }
  } catch {
    clearStoredActiveMatchTimer()
    return defaultState
  }
}

function createDefaultAppState(): InitialAppState {
  const playerInput = INITIAL_FORM_STATE.playerInput
  const players = normalizePlayers(playerInput)
  const initialGoalkeeperSelections = [...INITIAL_FORM_STATE.goalkeeperSelections]
  const initialPlan = generateMatchPlan({
    players,
    periodCount: INITIAL_FORM_STATE.periodCount,
    periodMinutes: INITIAL_FORM_STATE.periodMinutes,
    formation: INITIAL_FORM_STATE.formation,
    chunkMinutes: INITIAL_FORM_STATE.chunkMinutes,
    lockedGoalkeeperIds: createGoalkeeperSelections(INITIAL_FORM_STATE.periodCount).map(() => null),
    seed: DEFAULT_SHARE_SEED,
  })
  const generatedConfig = buildGeneratedConfig({
    players,
    playerInput,
    periodCount: INITIAL_FORM_STATE.periodCount,
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
    liveEvents: [],
    shouldSyncShareUrl: false,
    selectedTimerPeriod: DEFAULT_SELECTED_TIMER_PERIOD,
    activeMatchTimer: null,
  }
}

function createHydratedStateFromSnapshot(encodedSnapshot: string) {
  const { config, overrides, liveEvents } = decodeLineupSnapshot(encodedSnapshot)
  const hydratedPlan = buildPlanFromGeneratedConfig(config, true)
  const hydratedOverrides = validateSharedOverrides(hydratedPlan, overrides)

  return {
    formState: createFormStateFromConfig(config),
    generatedConfig: config,
    plan: hydratedPlan,
    periodOverrides: hydratedOverrides,
    liveEvents,
  }
}

function createFormStateFromConfig(config: GeneratedConfig): FormState {
  const periodCount = normalizePeriodCount(config.periodCount)

  return {
    playerInput: config.playerInput,
    periodCount,
    periodMinutes: config.periodMinutes,
    formation: config.formation,
    chunkMinutes: config.chunkMinutes,
    goalkeeperSelections: resizeGoalkeeperSelections(config.goalkeeperSelections, periodCount),
    errors: [],
  }
}

function readStoredActiveMatchTimer() {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const parsedTimer = parseStoredActiveMatchTimer(
      window.localStorage.getItem(ACTIVE_MATCH_TIMER_STORAGE_KEY),
    )

    if (!parsedTimer) {
      window.localStorage.removeItem(ACTIVE_MATCH_TIMER_STORAGE_KEY)
      return null
    }

    return parsedTimer
  } catch {
    return null
  }
}

function clearStoredActiveMatchTimer() {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(ACTIVE_MATCH_TIMER_STORAGE_KEY)
  } catch {
    // Ignore local persistence failures in v1.
  }
}

function normalizePeriodCount(periodCount?: number) {
  return PERIOD_COUNT_OPTIONS.includes(periodCount as (typeof PERIOD_COUNT_OPTIONS)[number])
    ? (periodCount ?? PERIOD_COUNT)
    : PERIOD_COUNT
}

function createGoalkeeperSelections(periodCount: number) {
  return Array.from({ length: periodCount }, () => '')
}

function resizeGoalkeeperSelections(selections: GoalkeeperSelections, periodCount: number) {
  return Array.from({ length: periodCount }, (_, index) => selections[index] ?? '')
}

function buildGeneratedConfig({
  players,
  playerInput,
  periodCount,
  periodMinutes,
  formation,
  chunkMinutes,
  goalkeeperSelections,
  seed,
}: {
  players: Player[]
  playerInput: string
  periodCount: number
  periodMinutes: number
  formation: FormationKey
  chunkMinutes: number
  goalkeeperSelections: GoalkeeperSelections
  seed: number
}): GeneratedConfig {
  return {
    playerInput,
    playerNames: players.map((player) => player.name),
    periodCount,
    periodMinutes,
    formation,
    chunkMinutes,
    goalkeeperSelections: resizeGoalkeeperSelections(goalkeeperSelections, periodCount),
    seed,
  }
}

function buildPlanFromGeneratedConfig(config: GeneratedConfig, exactSeed = false) {
  const players = normalizePlayers(config.playerInput)

  return generateMatchPlan({
    players,
    periodCount: normalizePeriodCount(config.periodCount),
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
  liveEvents: LiveAdjustmentEvent[],
) {
  const encodedSnapshot = encodeLineupSnapshot({
    config,
    overrides: serializePeriodOverrides(overrides),
    liveEvents,
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

function getSubstitutionOptions(periodMinutes: number, currentChunkMinutes?: number) {
  const options = getSupportedSubstitutionsPerPeriodOptions(periodMinutes).map((substitutionsPerPeriod) => {
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

function getPeriodState(
  periodNumber: number,
  matchProgress: MatchProgress | null,
): 'upcoming' | 'active' | 'completed' {
  if (!matchProgress || matchProgress.status === 'idle' || matchProgress.activePeriod !== periodNumber) {
    return 'upcoming'
  }

  if (matchProgress.status === 'finished') {
    return 'completed'
  }

  return 'active'
}

function getMatchStatusLabel(matchProgress: MatchProgress) {
  if (matchProgress.status === 'finished') {
    return `Period ${matchProgress.activePeriod ?? DEFAULT_SELECTED_TIMER_PERIOD} klar`
  }

  if (matchProgress.status === 'paused') {
    return 'Pausad'
  }

  if (matchProgress.status === 'running') {
    return `Period ${matchProgress.activePeriod ?? 1}`
  }

  return 'Redo'
}

function getMatchProgressSummary(matchProgress: MatchProgress, selectedPeriod: number) {
  if (matchProgress.status === 'finished') {
    return `Period ${matchProgress.activePeriod ?? selectedPeriod} avslutad`
  }

  const byteblockLabel =
    typeof matchProgress.activeChunkIndex === 'number'
      ? `Byteblock ${matchProgress.activeChunkIndex + 1}`
      : 'Byteblock väntar'

  if (matchProgress.status === 'paused') {
    return `Pausad i period ${matchProgress.activePeriod ?? 1} · ${byteblockLabel}`
  }

  if (matchProgress.status === 'running') {
    return `Pågår i period ${matchProgress.activePeriod ?? 1} · ${byteblockLabel}`
  }

  return `Redo att starta period ${selectedPeriod}`
}

function getChunkState(
  periodState: 'upcoming' | 'active' | 'completed',
  activeChunkIndex: number | null,
  chunkIndex: number,
): 'upcoming' | 'active' | 'completed' {
  if (periodState === 'completed') {
    return 'completed'
  }

  if (periodState !== 'active' || activeChunkIndex === null) {
    return 'upcoming'
  }

  if (chunkIndex === activeChunkIndex) {
    return 'active'
  }

  return chunkIndex < activeChunkIndex ? 'completed' : 'upcoming'
}

function getChunkAnchorId(period: number, chunkIndex: number) {
  return `active-period-${period}-chunk-${chunkIndex}`
}

function getNormalizedChunkMinutes(periodMinutes: number, currentChunkMinutes: number) {
  const supportedChunkMinutes = getSupportedSubstitutionsPerPeriodOptions(periodMinutes).map(
    (substitutionsPerPeriod) => getChunkMinutesForSubstitutions(periodMinutes, substitutionsPerPeriod),
  )

  return supportedChunkMinutes.some((value) => areMinuteValuesEqual(value, currentChunkMinutes))
    ? currentChunkMinutes
    : supportedChunkMinutes[0]
}

function formatChunkPattern(periodMinutes: number, chunkMinutes: number) {
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

function formatMinuteQuantity(value: number) {
  if (Number.isInteger(value)) {
    return `${value}`
  }

  return value.toFixed(2).replace(/\.?0+$/, '')
}

function hasRepeatedManualGoalkeeperSelection(selections: GoalkeeperSelections) {
  const manualSelections = selections.filter((selection) => selection.trim().length > 0)

  return new Set(manualSelections).size !== manualSelections.length
}

function roundMinuteValue(value: number) {
  return Math.round(value * 1000) / 1000
}

function formatMatchClock(valueMs: number) {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
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
