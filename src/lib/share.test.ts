import { describe, expect, it } from 'vitest'
import { buildLineupShareUrl, decodeLineupSnapshot, encodeLineupSnapshot } from './share'
import type { GeneratedConfig } from './types'

describe('share codec', () => {
  it('round-trips a compact lineup snapshot with Swedish player names', () => {
    const config: GeneratedConfig = {
      playerInput: 'Åke\nÖrjan\nÄlva\nNils\nMoa\nLinn\nBo\nEbbe',
      playerNames: ['Åke', 'Örjan', 'Älva', 'Nils', 'Moa', 'Linn', 'Bo', 'Ebbe'],
      periodMinutes: 20,
      formation: '2-3-1',
      chunkMinutes: 7.5,
      goalkeeperSelections: ['Åke', '', 'Örjan'],
      seed: 424242,
    }
    const overrides = {
      1: {
        VB: 'player-2',
        HB: 'player-3',
        VM: 'player-4',
        CM: 'player-5',
        HM: 'player-6',
        A: 'player-7',
        MV: 'player-1',
        B1: 'player-8',
      },
    }

    const encoded = encodeLineupSnapshot({ config, overrides })
    const decoded = decodeLineupSnapshot(encoded)

    expect(decoded.config).toEqual(config)
    expect(decoded.overrides).toEqual({
      1: {
        VB: 'player-2',
        HB: 'player-3',
        VM: 'player-4',
        CM: 'player-5',
        HM: 'player-6',
        A: 'player-7',
        MV: 'player-1',
        B1: 'player-8',
      },
    })
  })

  it('builds a share url with a single lineup query param', () => {
    const shareUrl = buildLineupShareUrl('encoded-value', 'https://example.com/app?foo=bar')
    const url = new URL(shareUrl)

    expect(url.searchParams.get('lineup')).toBe('encoded-value')
    expect(url.searchParams.get('foo')).toBe('bar')
  })
})
