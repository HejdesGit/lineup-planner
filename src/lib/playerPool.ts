import type { Player } from './types'

export const BASE_PLAYER_POOL = [
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

export type RosterOrder = 'canonical' | 'reversed'

export function getRosterNames(count: number, order: RosterOrder = 'canonical') {
  if (!Number.isInteger(count) || count < 1 || count > BASE_PLAYER_POOL.length) {
    throw new Error(`Kan inte skapa en spelarlista med ${count} namn.`)
  }

  const names = [...BASE_PLAYER_POOL.slice(0, count)]
  return order === 'reversed' ? names.reverse() : names
}

export function createNamedPlayers(count: number, order: RosterOrder = 'canonical'): Player[] {
  return getRosterNames(count, order).map((name, index) => ({
    id: `p-${index + 1}`,
    name,
  }))
}
