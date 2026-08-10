import { useEffect, useState } from 'react'

/* Motion primitives.
 *
 * Deliberately minimal. Entrance staggers, count-ups, chart draw-in and the
 * pulsing live dot were removed — on a data page they add noise without adding
 * information, and the figures are already legible standing still.
 */

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/* Relative timestamp. Ticks on a 30s interval rather than every second — the
 * label only changes by the minute, so a per-second re-render bought nothing. */
export function useRelativeTime(from: Date, tick = 30_000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tick)
    return () => window.clearInterval(timer)
  }, [tick])

  const seconds = Math.max(0, Math.floor((now - from.getTime()) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
