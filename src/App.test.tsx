import { render, screen } from '@testing-library/react'
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
    await user.click(screen.getByRole('button', { name: /generera uppställning/i }))

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
    expect(lockedButton).toHaveTextContent(/låst/i)
  })
})
