import { describe, expect, it } from 'vitest'
import { buildLineupShareUrl, decodeLineupSnapshot, encodeLineupSnapshot } from './share'
import type { GeneratedConfig } from './types'

function encodeBase64Url(value: string) {
  const binary = Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join('')

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

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
    expect(decoded.liveEvents).toEqual([])
  })

  it('round-trips live adjustment events in v3 snapshots', () => {
    const config: GeneratedConfig = {
      playerInput: 'Ada\nBea\nCleo\nDani\nEli\nFia\nGio\nHugo',
      playerNames: ['Ada', 'Bea', 'Cleo', 'Dani', 'Eli', 'Fia', 'Gio', 'Hugo'],
      periodMinutes: 15,
      formation: '2-3-1',
      chunkMinutes: 5,
      goalkeeperSelections: ['Ada', '', 'Bea'],
      seed: 999,
    }

    const encoded = encodeLineupSnapshot({
      config,
      overrides: {},
      liveEvents: [
        {
          type: 'temporary-out',
          period: 2,
          minute: 10,
          playerId: 'player-3',
          replacementPlayerId: 'player-8',
          status: 'temporarily-out',
        },
        {
          type: 'position-swap',
          period: 2,
          minute: 12,
          playerId: 'player-2',
          targetPlayerId: 'player-1',
        },
      ],
    })
    const decoded = decodeLineupSnapshot(encoded)

    expect(decoded.liveEvents).toEqual([
      {
        type: 'temporary-out',
        period: 2,
        minute: 10,
        playerId: 'player-3',
        replacementPlayerId: 'player-8',
        status: 'temporarily-out',
      },
      {
        type: 'position-swap',
        period: 2,
        minute: 12,
        playerId: 'player-2',
        targetPlayerId: 'player-1',
      },
    ])
  })

  it('decodes legacy v2 live adjustment snapshots', () => {
    const payload = {
      v: 2,
      p: ['Ada', 'Bea', 'Cleo', 'Dani', 'Eli', 'Fia', 'Gio', 'Hugo'],
      pm: 15,
      f: '2-3-1',
      cm: 5,
      gk: ['Ada', '', 'Bea'],
      s: 999,
      le: [
        {
          type: 'temporary-out',
          period: 2,
          minute: 10,
          playerId: 'player-3',
          replacementPlayerId: 'player-8',
          status: 'temporarily-out',
        },
      ],
    }
    const encoded = encodeBase64Url(JSON.stringify(payload))

    expect(decodeLineupSnapshot(encoded).liveEvents).toEqual(payload.le)
  })

  it('builds a share url with a single lineup query param', () => {
    const shareUrl = buildLineupShareUrl('encoded-value', 'https://example.com/app?foo=bar')
    const url = new URL(shareUrl)

    expect(url.searchParams.get('lineup')).toBe('encoded-value')
    expect(url.searchParams.get('foo')).toBe('bar')
  })
})
