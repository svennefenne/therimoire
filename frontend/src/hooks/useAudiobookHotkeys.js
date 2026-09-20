import { useEffect, useRef, useState, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useAudioPlayer } from '../context/AudioPlayerContext'

const SKIP_SECONDS = 15
const VOLUME_STEP = 0.1
const FEEDBACK_MS = 900

/**
 * Keyboard shortcuts for the Audiobooks section, plus the transient on-screen
 * feedback (rendered by <HotkeyFeedback>, driven by the `feedback` this hook
 * returns) that confirms each press actually landed:
 *
 *  - Left/Right  ±15s skip
 *  - Up/Down     volume, in 10% steps
 *  - Space       play/pause
 *
 * Supersedes the old skip-only useAudiobookSkipKeys (kept as a re-export so
 * nothing importing that path breaks). Mounted once in AppShell so it covers
 * the gallery and every detail page without wiring it into each view
 * separately.
 *
 * Scoped two ways:
 *  - by route (`/audiobooks*`) — Maps/Tokens/Audio/Models detail views bind
 *    Up/Down themselves (see useArrowKeyNavigation) for sibling prev/next, so
 *    reusing those keys here must stay inside Audiobooks or it'd fight them.
 *  - by the loaded track's `kind`, so a regular Audio/soundboard track left
 *    playing in the background while browsing Audiobooks doesn't get
 *    hijacked by keys meant for the audiobook.
 *
 * Also skipped while focus is in a text field (the gallery's filter box, a
 * tag editor, …) so normal typing — including hitting space in a search box
 * — is untouched.
 *
 * Registered on the capture phase and stops propagation once it decides to
 * act: the on-page play/pause button keeps keyboard focus after a click, and
 * left focused there, a bubble-phase key can still reach it — this is what
 * caused the skip-pauses-the-track bug the capture+stopPropagation fix here
 * already covers for arrow keys, extended to Up/Down/Space too.
 */
export default function useAudiobookHotkeys() {
  const location = useLocation()
  const { currentTrack, isPlaying, skipBy, togglePlay, volume, setVolume } = useAudioPlayer()
  const inAudiobooks = location.pathname.startsWith('/audiobooks')
  const isAudiobook = currentTrack?.kind === 'audiobook'

  const [feedback, setFeedback] = useState(null)
  const feedbackTimer = useRef(null)
  const flash = useCallback((next) => {
    setFeedback({ ...next, ts: Date.now() })
    clearTimeout(feedbackTimer.current)
    feedbackTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS)
  }, [])
  useEffect(() => () => clearTimeout(feedbackTimer.current), [])

  useEffect(() => {
    if (!inAudiobooks || !isAudiobook) return

    const handler = (e) => {
      const el = document.activeElement
      const inField =
        el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable
      if (inField) return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        const direction = e.key === 'ArrowLeft' ? -1 : 1
        skipBy(direction * SKIP_SECONDS)
        flash({ type: 'skip', direction })
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        const direction = e.key === 'ArrowUp' ? 1 : -1
        const next = Math.min(1, Math.max(0, +(volume + direction * VOLUME_STEP).toFixed(2)))
        setVolume(next)
        flash({ type: 'volume', value: next })
      } else if (e.code === 'Space') {
        e.preventDefault()
        e.stopPropagation()
        togglePlay()
        flash({ type: 'playpause', playing: !isPlaying })
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [inAudiobooks, isAudiobook, skipBy, togglePlay, isPlaying, volume, setVolume, flash])

  return { feedback }
}
