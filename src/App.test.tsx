import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
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

async function generateCustomPlan() {
  const user = userEvent.setup()
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
    setUrl('/')
    vi.restoreAllMocks()
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

})

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
