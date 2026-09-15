import { useEffect, useRef, useState } from 'react'

/**
 * Reveals text at a smooth, readable rate instead of in the bursts it
 * actually arrives in.
 *
 * The answer already streamed - what it did not do is *flow*. Anthropic's API
 * emits deltas in uneven chunks: several words at once, then a pause, then a
 * whole clause. Rendering each delta the moment it lands reproduces that
 * unevenness exactly, so the text arrives in visible jerks. Worse, the final
 * `done` frame carries the complete answer, so whatever had not yet been
 * shown appeared all at once at the end.
 *
 * This decouples arrival from display. Deltas accumulate into `target`; the
 * visible prefix walks toward it a few characters per frame.
 *
 * The rate is proportional to how far behind it is rather than fixed, which
 * is what makes it feel alive rather than mechanical: far behind and it moves
 * quickly, nearly caught up and it eases in. A fixed characters-per-second
 * would either lag seconds behind a fast answer or crawl through a slow one.
 */

/**
 * Time constant for draining the backlog. Smaller is snappier. At 190ms the
 * reveal stays roughly a fifth of a second behind the data, which reads as
 * deliberate rather than laggy.
 */
const CATCH_UP_MS = 190

/** A long pause (backgrounded tab) must not dump the rest of the answer in one frame. */
const MAX_FRAME_MS = 100

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useSmoothText(target: string): { text: string; isSettled: boolean } {
  const [shown, setShown] = useState('')

  // The loop reads the target through a ref rather than closing over it, so a
  // new delta never has to restart the animation. An earlier version listed
  // `shown` as an effect dependency, which cancelled and restarted the frame
  // loop on every painted character - that reset the frame clock each time,
  // so dt was always ~0, the proportional term rounded away, and the whole
  // thing degraded to a flat one character per frame. A long answer crawled.
  const targetRef = useRef(target)
  const previousTarget = useRef('')
  const shownLength = useRef(0)
  const frame = useRef<number | null>(null)
  const lastFrameAt = useRef<number | null>(null)

  useEffect(() => {
    targetRef.current = target

    // A new question, or a target that is not a continuation of the last one.
    // Carrying on from the current position would splice two answers together.
    if (!target.startsWith(previousTarget.current)) {
      shownLength.current = 0
      setShown('')
    }
    previousTarget.current = target

    if (prefersReducedMotion()) {
      shownLength.current = target.length
      setShown(target)
      return
    }

    const step = (now: number) => {
      const current = targetRef.current
      const dt = Math.min(now - (lastFrameAt.current ?? now), MAX_FRAME_MS)
      lastFrameAt.current = now

      const backlog = current.length - shownLength.current
      if (backlog <= 0) {
        // Idle rather than spin. The next delta restarts the loop.
        frame.current = null
        lastFrameAt.current = null
        return
      }

      // +1 guarantees forward progress: the proportional term alone rounds to
      // zero over the last few characters and the tail would never arrive.
      const advance = Math.max(1, Math.ceil(backlog * (dt / CATCH_UP_MS)))
      shownLength.current = Math.min(current.length, shownLength.current + advance)
      setShown(current.slice(0, shownLength.current))

      frame.current = requestAnimationFrame(step)
    }

    if (frame.current === null && target.length > shownLength.current) {
      lastFrameAt.current = null
      frame.current = requestAnimationFrame(step)
    }
    // Deliberately no cleanup here: tearing the loop down on every target
    // change is exactly the bug described above. Cancellation is unmount-only,
    // below.
  }, [target])

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [])

  return { text: shown, isSettled: shown.length >= target.length }
}
