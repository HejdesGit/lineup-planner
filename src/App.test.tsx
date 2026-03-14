import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders a generated match plan from user input', async () => {
    const user = userEvent.setup()
    render(<App />)

    const textarea = screen.getByLabelText(/spelare/i)
    await user.clear(textarea)
    await user.type(textarea, 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo\nIris')
    await user.selectOptions(screen.getByLabelText(/formation/i), '3-2-1')
    await user.selectOptions(screen.getByLabelText(/spelfönster/i), '7')
    await user.selectOptions(screen.getByLabelText(/målvakt period 1/i), 'Ada')
    await user.selectOptions(screen.getByLabelText(/målvakt period 2/i), 'Gio')
    await user.click(screen.getAllByRole('button', { name: /generera uppställning/i }).at(-1)!)

    expect((await screen.findAllByText(/period 1/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('3-2-1').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/var 7:e min/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/MV: Ada/i)).toBeInTheDocument()
    expect(screen.getByText(/speltid per spelare/i)).toBeInTheDocument()
  })

  it('shows a stronger lock state on the formation board', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: /lås henry på vm/i }))

    const lockedButton = screen.getByRole('button', { name: /lås upp henry på vm/i })
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
})
