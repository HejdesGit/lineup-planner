import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import {
  ACTIVE_MATCH_TIMER_STORAGE_KEY,
  parseStoredActiveMatchTimer,
  serializeStoredActiveMatchTimer,
} from './lib/matchTimer'
import { createBoardAssignments, swapBoardAssignments } from './lib/planOverrides'
import { decodeLineupSnapshot, encodeLineupSnapshot } from './lib/share'
import { generateMatchPlan } from './lib/scheduler'
import type { GeneratedConfig, Player } from './lib/types'

function setUrl(url: string) {
  window.history.replaceState(null, '', url)
}

function createPlayers(names: string[]): Player[] {
  return names.map((name, index) => ({
    id: `player-${index + 1}`,
    name,
  }))
}

function buildSharedLineupFixture() {
  const names = ['Ada', 'Bea', 'Cleo', 'Dani', 'Eli', 'Fia', 'Gio', 'Hugo', 'Iris']
  const players = createPlayers(names)
  const config: GeneratedConfig = {
    playerInput: names.join('\n'),
    playerNames: names,
    periodMinutes: 20,
    formation: '3-2-1',
    chunkMinutes: 6.5,
    goalkeeperSelections: ['Ada', 'Gio', ''],
    seed: 9001,
  }
  const plan = generateMatchPlan({
    players,
    periodMinutes: config.periodMinutes,
    formation: config.formation,
    chunkMinutes: config.chunkMinutes,
    lockedGoalkeeperIds: ['player-1', 'player-7', null],
    seed: config.seed,
    attempts: 1,
  })
  const swappedAssignments = swapBoardAssignments(createBoardAssignments(plan.periods[0]), 'VB', 'CB')

  return {
    plan,
    shareToken: encodeLineupSnapshot({
      config,
      overrides: {
        1: swappedAssignments,
      },
    }),
    swappedAssignments,
  }
}

async function generateCustomPlan(user = userEvent.setup()) {
  render(<App />)

  const textarea = screen.getByLabelText(/spelare/i)
  await user.clear(textarea)
  await user.type(textarea, 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
  await user.selectOptions(screen.getByLabelText(/formation/i), '3-2-1')
  await user.selectOptions(screen.getByLabelText(/antal byten/i), '10')
  await user.selectOptions(screen.getByLabelText(/målvakt period 1/i), 'Ada')
  await user.selectOptions(screen.getByLabelText(/målvakt period 2/i), 'Gio')
  await user.click(screen.getByRole('button', { name: /generera uppställning/i }))

  await screen.findByText(/MV: Ada/i)

  return user
}

function getLineupParam() {
  return new URL(window.location.href).searchParams.get('lineup')
}

async function dragBadge(sourceLock: HTMLElement, targetLock: HTMLElement) {
  const sourceHandle = sourceLock.parentElement as HTMLElement | null
  const sourceWrapper = sourceHandle?.parentElement as HTMLElement | null
  const targetHandle = targetLock.parentElement as HTMLElement | null
  const targetWrapper = targetHandle?.parentElement as HTMLElement | null

  if (!sourceHandle || !sourceWrapper || !targetHandle || !targetWrapper) {
    throw new Error('Kunde inte hitta drag-handtagen i testet.')
  }

  fireEvent.mouseDown(sourceHandle, { clientX: 20, clientY: 20, buttons: 1 })
  fireEvent.mouseMove(document, { clientX: 40, clientY: 20, buttons: 1 })
  fireEvent.pointerEnter(targetWrapper, { clientX: 120, clientY: 20 })
  fireEvent.pointerMove(targetWrapper, { clientX: 120, clientY: 20 })
  fireEvent.mouseUp(document, { clientX: 120, clientY: 20 })
}

describe('App', () => {
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    setUrl('/')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders a generated match plan from user input', async () => {
    await generateCustomPlan()

    expect((await screen.findAllByText(/period 1/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('3-2-1').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/2 per period/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/MV: Ada/i)).toBeInTheDocument()
    expect(screen.getByText(/speltid per spelare/i)).toBeInTheDocument()
  })

  it('does not show a chunk recommendation when 3 byten is selected by default', () => {
    render(<App />)

    expect(screen.queryByText(/rekommendation/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/kan väntan bli lång/i)).not.toBeInTheDocument()
  })

  it('shows curated chunk options for 3x20, 3x15 and 3x25', async () => {
    const user = userEvent.setup()
    render(<App />)

    const chunkSelect = screen.getByLabelText(/antal byten/i)

    expect(within(chunkSelect).getByRole('option', { name: '2 byten (10+10)' })).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '3 byten (6:40+6:40+6:40)' })).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '4 byten (5+5+5+5)' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/matchformat/i), '15')

    expect(within(chunkSelect).getByRole('option', { name: '2 byten (7:30+7:30)' })).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '3 byten (5+5+5)' })).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '4 byten (3:45+3:45+3:45+3:45)' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/matchformat/i), '25')

    expect(within(chunkSelect).getByRole('option', { name: '2 byten (12:30+12:30)' })).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '3 byten (8:20+8:20+8:20)' })).toBeInTheDocument()
    expect(
      within(chunkSelect).getByRole('option', { name: '4 byten (6:15+6:15+6:15+6:15)' }),
    ).toBeInTheDocument()
    expect(within(chunkSelect).getByRole('option', { name: '5 byten (5+5+5+5+5)' })).toBeInTheDocument()
  })

  it('normalizes antal byten when matchformat changes to a different option set', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByLabelText(/antal byten/i)).toHaveValue(`${20 / 3}`)

    await user.selectOptions(screen.getByLabelText(/matchformat/i), '15')

    expect(screen.getByLabelText(/antal byten/i)).toHaveValue('7.5')
  })

  it('hides the chunk recommendation for shorter windows in smaller rosters', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.clear(screen.getByLabelText(/spelare/i))
    await user.type(screen.getByLabelText(/spelare/i), 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo')
    await user.selectOptions(screen.getByLabelText(/antal byten/i), '5')

    expect(screen.queryByText(/kan väntan bli lång/i)).not.toBeInTheDocument()
  })

  it('shows a stronger lock state on the formation board', async () => {
    const user = userEvent.setup()
    render(<App />)

    const lockButton = screen
      .getAllByRole('button', { name: /^lås /i })
      .find((button) => !/ på mv$/i.test(button.getAttribute('aria-label') ?? ''))

    expect(lockButton).toBeDefined()

    const unlockedLabel = lockButton!.getAttribute('aria-label')

    expect(unlockedLabel).toBeTruthy()

    await user.click(lockButton!)

    const lockedButton = screen.getByRole('button', {
      name: new RegExp((unlockedLabel ?? '').replace(/^Lås /i, 'Lås upp '), 'i'),
    })
    expect(lockedButton).toBeInTheDocument()
    expect(lockedButton.querySelector('svg')).not.toBeNull()
  })

  it('locks manually selected goalkeepers by default', async () => {
    const user = userEvent.setup()
    const view = render(<App />)
    const scoped = within(view.container)

    const textarea = scoped.getAllByRole('textbox')[0] as HTMLTextAreaElement
    await user.clear(textarea)
    await user.type(textarea, 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
    await user.selectOptions(scoped.getByLabelText(/målvakt period 1/i), 'Ada')
    await user.selectOptions(scoped.getByLabelText(/målvakt period 2/i), 'Bea')
    await user.selectOptions(scoped.getByLabelText(/målvakt period 3/i), 'Cleo')
    await user.click(scoped.getByRole('button', { name: /generera uppställning/i }))

    expect(await scoped.findByRole('button', { name: /lås upp ada på mv/i })).toBeInTheDocument()
    expect(scoped.getByRole('button', { name: /lås upp bea på mv/i })).toBeInTheDocument()
    expect(scoped.getByRole('button', { name: /lås upp cleo på mv/i })).toBeInTheDocument()
  })

  it('allows the same manually selected goalkeeper in multiple periods', async () => {
    const user = userEvent.setup()
    render(<App />)

    const textarea = screen.getByLabelText(/spelare/i)
    await user.clear(textarea)
    await user.type(textarea, 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
    await user.selectOptions(screen.getByLabelText(/målvakt period 1/i), 'Ada')
    await user.selectOptions(screen.getByLabelText(/målvakt period 2/i), 'Ada')
    expect(screen.getByText(/samma målvakt är vald i flera perioder/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /generera uppställning/i }))

    expect(await screen.findAllByText(/MV: Ada/i)).toHaveLength(2)
    expect(screen.queryByText(/Välj olika målvakter om du låser perioderna manuellt\./i)).not.toBeInTheDocument()
  })

  it('hydrates a valid shared lineup link including manual swaps', async () => {
    const { shareToken, swappedAssignments } = buildSharedLineupFixture()
    setUrl(`/?lineup=${shareToken}`)

    render(<App />)

    expect(screen.getAllByText('3-2-1').length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/antal byten/i)).toHaveValue('6.5')
    expect(screen.getByLabelText(/målvakt period 1/i)).toHaveValue('Ada')
    expect(screen.getByLabelText(/målvakt period 2/i)).toHaveValue('Gio')
    expect(
      await screen.findByRole('button', {
        name: new RegExp(`lås ${getPlayerName(swappedAssignments.VB)} på vb`, 'i'),
      }),
    ).toBeInTheDocument()
  })

  it('shows a goalkeeper and outfield minute split for players with goalkeeper time', async () => {
    const { shareToken, plan } = buildSharedLineupFixture()
    const adaSummary = plan.summaries.find((summary) => summary.name === 'Ada')

    if (!adaSummary) {
      throw new Error('Ada saknas i fixture-planen.')
    }

    setUrl(`/?lineup=${shareToken}`)
    render(<App />)

    const expectedSummaryLine = `MV: ${adaSummary.goalkeeperPeriods.length * plan.periodMinutes} min + Utespelare: ${adaSummary.totalMinutes - adaSummary.goalkeeperPeriods.length * plan.periodMinutes} min = ${adaSummary.totalMinutes} min totalt`
    const adaCard = (await screen.findByRole('heading', { name: 'Ada' })).closest('details')

    if (!adaCard) {
      throw new Error('Ada-kortet saknas i testet.')
    }

    expect(within(adaCard).getByText(expectedSummaryLine)).toBeInTheDocument()

    await userEvent.setup().click(within(adaCard).getByRole('heading', { name: 'Ada' }))

    expect(within(adaCard).getByText(/MV-tid/i)).toBeInTheDocument()
    expect(within(adaCard).getByText(/Utespelartid/i)).toBeInTheDocument()
    expect(within(adaCard).getByText(/Totaltid/i)).toBeInTheDocument()
  })

  it('shows minutes and seconds for byteblock durations that are not whole or half minutes', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.clear(screen.getByLabelText(/spelare/i))
    await user.type(screen.getByLabelText(/spelare/i), 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
    await user.selectOptions(screen.getByLabelText(/antal byten/i), within(screen.getByLabelText(/antal byten/i)).getByRole('option', { name: /3 byten/i }))
    await user.click(screen.getByRole('button', { name: /generera uppställning/i }))

    expect((await screen.findAllByText(/Byteblock 1 · 6 min 40 sek/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/^0-6:40$/i).length).toBeGreaterThan(0)
  })

  it('updates the share url after generating a lineup', async () => {
    await generateCustomPlan()

    await waitFor(() => {
      expect(getLineupParam()).not.toBeNull()
    })
  })

  it('updates the share url after board changes', async () => {
    await generateCustomPlan()
    const initialLineup = getLineupParam()
    const periodCard = screen.getByText(/MV: Ada/i).closest('article')

    if (!periodCard) {
      throw new Error('Periodkort saknas i testet.')
    }

    const lockButtons = within(periodCard)
      .getAllByRole('button', { name: /^lås /i })
      .filter((button) => !/ på mv$/i.test(button.getAttribute('aria-label') ?? ''))

    expect(lockButtons.length).toBeGreaterThanOrEqual(2)

    await dragBadge(lockButtons[0], lockButtons[1])

    await waitFor(() => {
      expect(getLineupParam()).not.toBe(initialLineup)
    })
  })

  it('does not update the share url for draft edits before regenerate', async () => {
    const user = await generateCustomPlan()
    const syncedLineup = getLineupParam()

    await user.type(screen.getByLabelText(/spelare/i), '\nNova')

    expect(getLineupParam()).toBe(syncedLineup)
  })

  it('falls back to the default state when the shared link is invalid', async () => {
    setUrl('/?lineup=defekt')

    render(<App />)

    expect(screen.getByText(/ogiltig delningslänk/i)).toBeInTheDocument()
    expect(getLineupParam()).toBeNull()
    expect(screen.getByDisplayValue('2-3-1')).toBeInTheDocument()
  })

  it('stores an active timer from the current period snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    expect(getStoredMatchTimer()).toEqual({
      version: 3,
      lineupSnapshot: expect.any(String),
      status: 'running',
      startedAt: Date.now(),
      elapsedMs: 0,
      period: 1,
      periodDurationMs: 20 * 60_000,
    })
  })

  it('restores the persisted timer and lineup after reload without a share url', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    act(() => {
      vi.advanceTimersByTime(3 * 60_000)
    })

    cleanup()
    setUrl('/')
    render(<App />)

    expect(screen.getAllByText('3:00').length).toBeGreaterThan(1)
    expect(screen.getByText(/17:00 kvar av 20:00/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /starta period/i })).not.toBeInTheDocument()
  })

  it('restores the persisted timer when the same lineup is present in the url on reload', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    act(() => {
      vi.advanceTimersByTime(4 * 60_000)
    })

    const currentUrl = window.location.href

    cleanup()
    setUrl(currentUrl)
    render(<App />)

    expect(screen.getAllByText('4:00').length).toBeGreaterThan(1)
    expect(screen.getByText(/16:00 kvar av 20:00/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /starta period/i })).not.toBeInTheDocument()
  })

  it('starts the selected period and marks its active byteblock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)

    const periodTwoButton = screen.getAllByRole('button', { name: /period 2/i })[0]
    fireEvent.click(periodTwoButton)
    expect(periodTwoButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /starta period 2/i }))

    act(() => {
      vi.advanceTimersByTime(15 * 60_000)
    })

    const activePeriod = document.querySelector('[data-period="2"][data-period-state="active"]')
    const completedPeriod = document.querySelector('[data-period="1"][data-period-state="completed"]')
    const activeChunk = activePeriod?.querySelector('[data-chunk-index="2"][data-chunk-state="active"]')

    expect(completedPeriod).toBeNull()
    expect(activePeriod).not.toBeNull()
    expect(activeChunk).not.toBeNull()
    expect(getStoredMatchTimer()?.period).toBe(2)
  })

  it('stops the clock, keeps the elapsed time frozen, and resumes from the same point', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    act(() => {
      vi.advanceTimersByTime(7 * 60_000)
    })

    const pauseButton = screen
      .getAllByRole('button')
      .find((button) => /pausa klockan/i.test(button.textContent ?? ''))

    if (!pauseButton) {
      throw new Error('Pause-knappen saknas i testet.')
    }

    fireEvent.click(pauseButton)

    expect(getStoredMatchTimer()).toEqual({
      version: 3,
      lineupSnapshot: expect.any(String),
      status: 'paused',
      startedAt: null,
      elapsedMs: 7 * 60_000,
      period: 1,
      periodDurationMs: 20 * 60_000,
    })
    expect(screen.getAllByText('7:00').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/pausad i period 1 · byteblock 2/i).length).toBeGreaterThan(1)

    act(() => {
      vi.advanceTimersByTime(3 * 60_000)
    })

    expect(screen.getAllByText('7:00').length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: /fortsätt period 1/i }))

    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })

    expect(screen.getAllByText('9:00').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/pågår i period 1 · byteblock 2/i).length).toBeGreaterThan(1)
  })

  it('resets the timer when a new lineup is generated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))
    expect(getStoredMatchTimer()).not.toBeNull()

    const textarea = screen.getByLabelText(/spelare/i) as HTMLTextAreaElement

    fireEvent.change(screen.getByLabelText(/spelare/i), {
      target: { value: `${textarea.value}\nNova` },
    })
    fireEvent.click(screen.getByRole('button', { name: /generera uppställning/i }))

    expect(getStoredMatchTimer()).toBeNull()
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /starta period 1/i })).toBeEnabled()
  })

  it('prefers an explicit lineup in the url over a persisted timer state', () => {
    const { shareToken } = buildSharedLineupFixture()
    const otherShareToken = encodeLineupSnapshot({
      config: {
        playerInput: 'Adam\nAnton\nBill\nDante\nDavid\nElias\nEmil\nGunnar',
        playerNames: ['Adam', 'Anton', 'Bill', 'Dante', 'David', 'Elias', 'Emil', 'Gunnar'],
        periodMinutes: 15,
        formation: '2-3-1',
        chunkMinutes: 7.5,
        goalkeeperSelections: ['Adam', '', 'Anton'],
        seed: 31337,
      },
      overrides: {},
    })

    window.localStorage.setItem(
      ACTIVE_MATCH_TIMER_STORAGE_KEY,
      serializeStoredActiveMatchTimer({
        version: 3,
        lineupSnapshot: otherShareToken,
        status: 'running',
        startedAt: 12345,
        elapsedMs: 0,
        period: 2,
        periodDurationMs: 15 * 60_000,
      }),
    )
    setUrl(`/?lineup=${shareToken}`)

    render(<App />)

    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /starta period 1/i })).toBeEnabled()
  })

  it('stops at the end of the selected period and allows the next period to be started', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    act(() => {
      vi.advanceTimersByTime(21 * 60_000)
    })

    expect(screen.getAllByText(/period 1 klar/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText('20:00').length).toBeGreaterThan(1)
    expect(document.querySelectorAll('[data-period-state="completed"]')).toHaveLength(1)

    const periodTwoButton = screen.getAllByRole('button', { name: /period 2/i })[0]
    fireEvent.click(periodTwoButton)

    expect(screen.getByRole('button', { name: /starta period 2/i })).toBeEnabled()
  })

  it('persists manual board overrides together with the running timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const periodCard = document.querySelector('article[data-period="1"]') as HTMLElement | null

    if (!periodCard) {
      throw new Error('Periodkort saknas i testet.')
    }

    const lockButtons = within(periodCard)
      .getAllByRole('button', { name: /^lås /i })
      .filter((button) => !/ på mv$/i.test(button.getAttribute('aria-label') ?? ''))

    await dragBadge(lockButtons[0], lockButtons[1])

    const swappedLabels = within(periodCard)
      .getAllByRole('button', { name: /^lås /i })
      .map((button) => button.getAttribute('aria-label'))

    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })

    cleanup()
    setUrl('/')
    render(<App />)

    expect(screen.getAllByText('2:00').length).toBeGreaterThan(1)

    const restoredPeriodCard = document.querySelector('article[data-period="1"]') as HTMLElement | null

    if (!restoredPeriodCard) {
      throw new Error('Återställt periodkort saknas i testet.')
    }

    const restoredLabels = within(restoredPeriodCard)
      .getAllByRole('button', { name: /^lås /i })
      .map((button) => button.getAttribute('aria-label'))

    expect(restoredLabels).toEqual(swappedLabels)
  })

  it('shows a floating live timer while the match is active or paused', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T09:00:00Z'))

    render(<App />)

    expect(screen.queryByText(/^live$/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    expect(screen.getByText(/^live$/i)).toBeInTheDocument()
    expect(screen.getAllByText('0:00').length).toBeGreaterThan(1)

    const pauseButton = screen
      .getAllByRole('button')
      .find((button) => /pausa klockan/i.test(button.textContent ?? ''))

    if (!pauseButton) {
      throw new Error('Pause-knappen saknas i testet.')
    }

    fireEvent.click(pauseButton)

    expect(screen.getByText(/^live$/i)).toBeInTheDocument()
    expect(screen.getAllByText(/pausad/i).length).toBeGreaterThan(1)
  })

  it('scrolls to the active byteblock when the floating status row is tapped', () => {
    const scrollIntoViewMock = vi.fn()

    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /pågår i period 1 · byteblock 1/i }))

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1)
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    })
  })

  it('shows available bench cards and upcoming substitutions in the live panel', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    expect(within(activePeriodCard).queryByText(/första reserv/i)).not.toBeInTheDocument()
    expect(within(activePeriodCard).getByText(/tillgänglig bänk/i)).toBeInTheDocument()
    expect(within(activePeriodCard).getByText(/nästa byten/i)).toBeInTheDocument()
    expect(within(activePeriodCard).getByText(/nästa bänk:/i)).toBeInTheDocument()
  })

  it('opens temporary-out from the top-left icon and positionsbyte from the top-right icon', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const temporaryOutButton = within(activePeriodCard).getAllByRole('button', {
      name: /markera .* som tillfälligt ute på /i,
    })[0]
    const temporaryOutInfo = parseLiveBadgeLabel(
      temporaryOutButton.getAttribute('aria-label') ?? '',
      'Markera',
      'som tillfälligt ute',
    )

    await user.click(temporaryOutButton)

    expect(
      within(activePeriodCard).getByText(new RegExp(`${temporaryOutInfo.playerName} är tillfälligt ute`, 'i')),
    ).toBeInTheDocument()

    await user.click(within(activePeriodCard).getByRole('button', { name: /stäng/i }))

    const positionSwapButton = within(activePeriodCard).getAllByRole('button', {
      name: /starta positionsbyte för .* på /i,
    })[0]
    const positionSwapInfo = parseLiveBadgeLabel(
      positionSwapButton.getAttribute('aria-label') ?? '',
      'Starta positionsbyte för',
    )

    await user.click(positionSwapButton)

    expect(
      within(activePeriodCard).getByText(new RegExp(`${positionSwapInfo.playerName} positionsbyte`, 'i')),
    ).toBeInTheDocument()
  })

  it('opens both live actions when the player box itself is clicked', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const bodyButton = within(activePeriodCard).getAllByRole('button', {
      name: /öppna liveval för .* på /i,
    })[0]
    const bodyInfo = parseLiveBadgeLabel(bodyButton.getAttribute('aria-label') ?? '', 'Öppna liveval för')

    await user.click(bodyButton)

    expect(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`${bodyInfo.playerName} är tillfälligt ute`, 'i'),
      }),
    ).toBeInTheDocument()
    expect(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`${bodyInfo.playerName} positionsbyte`, 'i'),
      }),
    ).toBeInTheDocument()
  })

  it('shows both on-field players and bench players as positionsbyte candidates and swaps immediately', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const liveButtons = within(activePeriodCard).getAllByRole('button', {
      name: /öppna liveval för .* på /i,
    })
    const sourceInfo = parseLiveBadgeLabel(
      liveButtons.find((button) => !/ på MV$/i.test(button.getAttribute('aria-label') ?? ''))?.getAttribute(
        'aria-label',
      ) ?? '',
      'Öppna liveval för',
    )
    const targetInfo = parseLiveBadgeLabel(
      liveButtons
        .filter((button) => !/ på MV$/i.test(button.getAttribute('aria-label') ?? ''))
        .map((button) => button.getAttribute('aria-label') ?? '')
        .find((label) => !label.includes(sourceInfo.playerName)) ?? '',
      'Öppna liveval för',
    )

    await user.click(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`starta positionsbyte för ${sourceInfo.playerName} på ${sourceInfo.position}`, 'i'),
      }),
    )

    expect(
      within(activePeriodCard).getAllByText(/är på planen nu och kan byta position direkt/i).length,
    ).toBeGreaterThan(0)
    expect(
      within(activePeriodCard).getAllByText(/är tillgänglig på bänken och kan komma in direkt/i).length,
    ).toBeGreaterThan(0)

    await user.click(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`^${targetInfo.playerName}\\b`, 'i'),
      }),
    )
    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    await waitFor(() => {
      const liveLabels = within(activePeriodCard)
        .getAllByRole('button', {
          name: /öppna liveval för .* på /i,
        })
        .map((button) => button.getAttribute('aria-label') ?? '')
      const swappedSourceLabel = liveLabels.find((label) => label.includes(`för ${sourceInfo.playerName} på `))
      const swappedTargetLabel = liveLabels.find((label) => label.includes(`för ${targetInfo.playerName} på `))

      expect(swappedSourceLabel).toBeDefined()
      expect(swappedTargetLabel).toBeDefined()
      expect(parseLiveBadgeLabel(swappedSourceLabel ?? '', 'Öppna liveval för').position).toBe(
        targetInfo.position,
      )
      expect(parseLiveBadgeLabel(swappedTargetLabel ?? '', 'Öppna liveval för').position).toBe(
        sourceInfo.position,
      )
    })
  })

  it('allows positionsbyte directly with a bench player', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()
    const sourceInfo = parseLiveBadgeLabel(
      within(activePeriodCard)
        .getAllByRole('button', {
          name: /öppna liveval för .* på /i,
        })
        .find((button) => !/ på MV$/i.test(button.getAttribute('aria-label') ?? ''))?.getAttribute(
          'aria-label',
        ) ?? '',
      'Öppna liveval för',
    )

    await user.click(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`starta positionsbyte för ${sourceInfo.playerName} på ${sourceInfo.position}`, 'i'),
      }),
    )

    const benchCandidateButton = within(activePeriodCard)
      .getAllByRole('button')
      .find((button) =>
        /är tillgänglig på bänken och kan komma in direkt/i.test(button.textContent ?? ''),
      )

    if (!benchCandidateButton) {
      throw new Error('Kunde inte hitta någon bänkkandidat i positionsbytet.')
    }

    const firstBenchPlayerName =
      (benchCandidateButton.textContent ?? '').match(/^(.*?)Är tillgänglig på bänken/i)?.[1]?.trim() ?? null

    if (!firstBenchPlayerName) {
      throw new Error('Kunde inte tolka bänkkandidatens namn i testet.')
    }

    await user.click(benchCandidateButton)
    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    await waitFor(() => {
      expect(
        within(activePeriodCard).getByRole('button', {
          name: new RegExp(`öppna liveval för ${firstBenchPlayerName} på ${sourceInfo.position}`, 'i'),
        }),
      ).toBeInTheDocument()
    })
  })

  it('allows positionsbyte with the goalkeeper and persists it through timer restore', async () => {
    const user = userEvent.setup()
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const goalkeeperInfo = parseLiveBadgeLabel(
      within(activePeriodCard)
        .getByRole('button', {
          name: /öppna liveval för .* på MV/i,
        })
        .getAttribute('aria-label') ?? '',
      'Öppna liveval för',
    )
    const outfieldInfo = parseLiveBadgeLabel(
      within(activePeriodCard)
        .getAllByRole('button', {
          name: /öppna liveval för .* på /i,
        })
        .map((button) => button.getAttribute('aria-label') ?? '')
        .find((label) => !/ på MV$/i.test(label)) ?? '',
      'Öppna liveval för',
    )

    await user.click(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`starta positionsbyte för ${goalkeeperInfo.playerName} på MV`, 'i'),
      }),
    )
    await user.click(
      within(activePeriodCard).getByRole('button', {
        name: new RegExp(`^${outfieldInfo.playerName}\\b`, 'i'),
      }),
    )
    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    await waitFor(() => {
      expect(
        within(activePeriodCard).getByRole('button', {
          name: new RegExp(`öppna liveval för ${goalkeeperInfo.playerName} på ${outfieldInfo.position}`, 'i'),
        }),
      ).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(
        within(activePeriodCard).getByRole('button', {
          name: new RegExp(`öppna liveval för ${outfieldInfo.playerName} på MV`, 'i'),
        }),
      ).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(getStoredMatchTimer()).not.toBeNull()
    })

    expect(decodeLineupSnapshot(getStoredMatchTimer()!.lineupSnapshot).liveEvents).toEqual([
      expect.objectContaining({
        type: 'position-swap',
        playerId: expect.any(String),
        targetPlayerId: expect.any(String),
      }),
    ])

    cleanup()
    setUrl('/')
    render(<App />)

    const restoredPeriodCard = getLivePanel()

    expect(
      within(restoredPeriodCard).getByRole('button', {
        name: new RegExp(`öppna liveval för ${outfieldInfo.playerName} på MV`, 'i'),
      }),
    ).toBeInTheDocument()
  })

  it('marks a live player as temporarily out, recommends a replacement, and can return the player immediately', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const injuryButton = within(activePeriodCard).getAllByRole('button', {
      name: /markera .* som tillfälligt ute/i,
    })[0]
    const playerName = parseLiveBadgeLabel(
      injuryButton.getAttribute('aria-label') ?? '',
      'Markera',
      'som tillfälligt ute',
    ).playerName

    await user.click(injuryButton)

    expect(within(activePeriodCard).getByText(new RegExp(`${playerName} är tillfälligt ute`, 'i'))).toBeInTheDocument()
    expect(within(activePeriodCard).getByText(/resten av matchen räknas om direkt/i)).toBeInTheDocument()

    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    const returnButton = within(activePeriodCard).getByRole('button', {
      name: new RegExp(`${playerName}.*klar för spel`, 'i'),
    })
    expect(returnButton).toBeInTheDocument()

    await user.click(returnButton)

    expect(within(activePeriodCard).getByText(new RegExp(`${playerName} är klar för spel`, 'i'))).toBeInTheDocument()

    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    expect(
      within(activePeriodCard).queryByRole('button', {
        name: new RegExp(`${playerName}.*klar för spel`, 'i'),
      }),
    ).not.toBeInTheDocument()
  })

  it('allows the live goalkeeper to be temporarily out and return immediately', async () => {
    const user = await generateCustomPlan()

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const goalkeeperButton = within(activePeriodCard).getByRole('button', {
      name: /markera ada som tillfälligt ute/i,
    })

    await user.click(goalkeeperButton)

    expect(within(activePeriodCard).getByText(/ada är tillfälligt ute/i)).toBeInTheDocument()
    expect(within(activePeriodCard).getByText(/resten av matchen räknas om direkt/i)).toBeInTheDocument()

    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    const returnButton = within(activePeriodCard).getByRole('button', {
      name: /ada.*klar för spel/i,
    })
    expect(returnButton).toBeInTheDocument()

    await user.click(returnButton)

    expect(within(activePeriodCard).getByText(/ada är klar för spel/i)).toBeInTheDocument()

    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    expect(
      within(activePeriodCard).queryByRole('button', {
        name: /ada.*klar för spel/i,
      }),
    ).not.toBeInTheDocument()
  })

  it('persists live temporarily-out events in the running timer snapshot and restores them after reload', async () => {
    const user = userEvent.setup()
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /starta period 1/i }))

    const activePeriodCard = getLivePanel()

    const injuryButton = within(activePeriodCard).getAllByRole('button', {
      name: /markera .* som tillfälligt ute/i,
    })[0]
    const playerName = parseLiveBadgeLabel(
      injuryButton.getAttribute('aria-label') ?? '',
      'Markera',
      'som tillfälligt ute',
    ).playerName

    await user.click(injuryButton)
    await user.click(within(activePeriodCard).getByRole('button', { name: /bekräfta live-byte/i }))

    await waitFor(() => {
      expect(getStoredMatchTimer()).not.toBeNull()
    })

    const storedTimer = getStoredMatchTimer()!

    expect(decodeLineupSnapshot(storedTimer.lineupSnapshot).liveEvents).toHaveLength(1)

    cleanup()
    setUrl('/')
    render(<App />)

    const restoredPeriodCard = getLivePanel()

    expect(
      within(restoredPeriodCard).getByRole('button', {
        name: new RegExp(`${playerName}.*klar för spel`, 'i'),
      }),
    ).toBeInTheDocument()
  })

})

function getStoredMatchTimer() {
  return parseStoredActiveMatchTimer(window.localStorage.getItem(ACTIVE_MATCH_TIMER_STORAGE_KEY))
}

function getLivePanel() {
  const livePanel = screen.getByText(/^live just nu$/i).closest('section')

  if (!livePanel) {
    throw new Error('Livepanelen saknas i testet.')
  }

  return livePanel as HTMLElement
}

function parseLiveBadgeLabel(label: string, prefix: string, suffix = '') {
  const pattern = new RegExp(`^${prefix} (.+?)${suffix ? ` ${suffix}` : ''} på (.+)$`, 'i')
  const match = label.match(pattern)

  if (!match) {
    throw new Error(`Kunde inte tolka live-etiketten: ${label}`)
  }

  return {
    playerName: match[1],
    position: match[2],
  }
}

function getPlayerName(playerId: string) {
  return {
    'player-1': 'Ada',
    'player-2': 'Bea',
    'player-3': 'Cleo',
    'player-4': 'Dani',
    'player-5': 'Eli',
    'player-6': 'Fia',
    'player-7': 'Gio',
    'player-8': 'Hugo',
    'player-9': 'Iris',
  }[playerId]
}
