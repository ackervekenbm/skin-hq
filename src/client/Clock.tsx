import { useEffect, useState, type ReactNode } from 'react'

/**
 * Re-renders only its own children once a second, so a ticking countdown
 * doesn't re-render the whole app. It runs only while mounted.
 */
export function Clock({ children }: { children: (now: number) => ReactNode }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{children(now)}</>
}
