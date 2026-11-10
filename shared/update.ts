import type { UpdateState } from './types'

/** a > b for plain x.y.z versions (a pre-release tag counts as older than its release). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [main, pre = ''] = v.trim().replace(/^v/, '').split('-', 2)
    return [main.split('.').map((n) => Number(n) || 0), pre]
  }
  const [x, xPre] = parse(a)
  const [y, yPre] = parse(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return !xPre && !!yPre
}

/** The update banner shows for a newer version the user hasn't skipped. */
export function bannerWanted(s: UpdateState, skipped: string | null): boolean {
  return (
    ['available', 'downloading', 'ready', 'error'].includes(s.status) &&
    !!s.version &&
    s.version !== skipped &&
    isNewer(s.version, s.current)
  )
}
