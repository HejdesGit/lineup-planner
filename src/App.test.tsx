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
import { encodeLineupSnapshot } from './lib/share'
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

  it('shows a chunk recommendation for bigger rosters with long windows', () => {
    render(<App />)

    expect(screen.getByText(/rekommendation/i)).toBeInTheDocument()
    expect(screen.getByText(/kan väntan bli lång/i)).toBeInTheDocument()
  })

  it('shows curated chunk options for 3x20 and 3x15', async () => {
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
  })

  it('normalizes antal byten when matchformat changes to a different option set', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByLabelText(/antal byten/i)).toHaveValue('10')

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
    const comboboxes = scoped.getAllByRole('combobox') as HTMLSelectElement[]
    const goalkeeperPeriod1 = comboboxes[3]
    const goalkeeperPeriod2 = comboboxes[4]
    const goalkeeperPeriod3 = comboboxes[5]
    await user.clear(textarea)
    await user.type(textarea, 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
    await user.selectOptions(goalkeeperPeriod1, 'Ada')
    await user.selectOptions(goalkeeperPeriod2, 'Bea')
    await user.selectOptions(goalkeeperPeriod3, 'Cleo')
    await user.click(scoped.getByRole('button', { name: /generera uppställning/i }))

    expect(await scoped.findByRole('button', { name: /lås upp ada på mv/i })).toBeInTheDocument()
    expect(scoped.getByRole('button', { name: /lås upp bea på mv/i })).toBeInTheDocument()
    expect(scoped.getByRole('button', { name: /lås upp cleo på mv/i })).toBeInTheDocument()
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

  it('opens WhatsApp with the current share url in the message text', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /dela via whatsapp/i }))

    expect(openSpy).toHaveBeenCalledTimes(1)

    const [openedUrl] = openSpy.mock.calls[0]
    const whatsappUrl = new URL(openedUrl as string)
    const message = whatsappUrl.searchParams.get('text')

    expect(whatsappUrl.origin).toBe('https://wa.me')
    expect(message).toContain('Uppställning EIK:')
    expect(message).toContain(window.location.href)
    expect(getLineupParam()).not.toBeNull()
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
      version: 2,
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
    const activeChunk = activePeriod?.querySelector('[data-chunk-index="1"][data-chunk-state="active"]')

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
      version: 2,
      lineupSnapshot: expect.any(String),
      status: 'paused',
      startedAt: null,
      elapsedMs: 7 * 60_000,
      period: 1,
      periodDurationMs: 20 * 60_000,
    })
    expect(screen.getAllByText('7:00').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/pausad i period 1 · byteblock 1/i).length).toBeGreaterThan(1)

    act(() => {
      vi.advanceTimersByTime(3 * 60_000)
    })

    expect(screen.getAllByText('7:00').length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: /fortsätt period 1/i }))

    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })

    expect(screen.getAllByText('9:00').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/pågår i period 1 · byteblock 1/i).length).toBeGreaterThan(1)
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
        version: 2,
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
      block: 'center',
    })
  })

})

function getStoredMatchTimer() {
  return parseStoredActiveMatchTimer(window.localStorage.getItem(ACTIVE_MATCH_TIMER_STORAGE_KEY))
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
