import { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react'
import api from '../api'
import useSessionState from '../hooks/useSessionState'

const AudioPlayerContext = createContext(null)

// A track ref is the minimal shape we need to play + display a queue entry:
//   { id, title?, artist?, artwork? }
// The audio file URL is derived from `id` at play time, so only the id is
// required. Entries added with just an id (campaign resources, note embeds) are
// lazily hydrated from GET /audio/:id so the player/queue show a rich label.

// A track needs hydrating only if it has an id but no display title yet and we
// haven't already resolved (or failed) a fetch for it. Tracks added with a
// title/artist (gallery, detail view) are already rich and never fetched.
const needsHydration = (t) => t && t.id && !t.title && !t._hydrated

/**
 * Owns the single app-wide <audio> element (via `audioRef`, attached by
 * GlobalAudioPlayer) and the playback queue. Every play button in the app is a
 * thin controller that calls these actions instead of owning its own audio.
 *
 * Queue, current index, and repeat mode persist across in-session navigation
 * (sessionStorage) and reset on a hard refresh. Playback state (isPlaying,
 * currentTime) is ephemeral and driven by the <audio> element's events.
 */
export function AudioPlayerProvider({ children }) {
  const audioRef = useRef(null)

  const [queue, setQueue] = useSessionState('grimoire:audio:queue', [])
  const [currentIndex, setCurrentIndex] = useSessionState('grimoire:audio:index', -1)
  const [repeatOne, setRepeatOne] = useSessionState('grimoire:audio:repeatOne', false)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [expanded, setExpanded] = useState(false)

  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null

  // Chapters (M4A/M4B audiobooks — see AudioChapterList) aren't part of the
  // minimal track-ref shape queue entries carry, so they're fetched
  // separately for whichever track is actually playing. Scoped to just the
  // current track rather than folded into the title/artist hydration below:
  // that effect runs eagerly for every queue entry to fill in display text,
  // where a chapter list is only ever needed for the one track in earshot.
  const [currentChapters, setCurrentChapters] = useState([])
  useEffect(() => {
    const id = currentTrack?.id
    if (!id) {
      setCurrentChapters([])
      return
    }
    let cancelled = false
    api
      .get(`/audio/${id}`)
      .then((data) => {
        if (!cancelled) setCurrentChapters(data.chapters || [])
      })
      .catch(() => {
        if (!cancelled) setCurrentChapters([])
      })
    return () => {
      cancelled = true
    }
  }, [currentTrack?.id])

  const hasChapters = currentChapters.length > 0
  const activeChapterIndex = hasChapters
    ? currentChapters.findIndex((c) => currentTime >= c.start && currentTime < c.end)
    : -1

  // When the current track changes, the GlobalAudioPlayer reloads the <audio>
  // src; we (re)start playback for any index >= 0. A request flag tells the
  // player to call play() once the new src is ready.
  const playRequested = useRef(false)

  // A chapter click (see AudioChapterList) wants to land on a specific time,
  // not just start the track from 0. Setting <audio>.currentTime before the
  // new src has actually loaded gets silently reset to 0 by the element once
  // metadata arrives, so the target time is stashed here and applied by
  // GlobalAudioPlayer's onLoadedMetadata instead of being set eagerly.
  const pendingSeek = useRef(null)

  const playQueue = useCallback(
    (tracks, startIndex = 0) => {
      const list = (tracks || []).filter((t) => t && t.id)
      if (list.length === 0) return
      const idx = Math.min(Math.max(startIndex, 0), list.length - 1)
      setQueue(list)
      setCurrentIndex(idx)
      playRequested.current = true
      setExpanded(false)
    },
    [setQueue, setCurrentIndex]
  )

  const playNext = useCallback(
    (track) => {
      if (!track || !track.id) return
      setQueue((prev) => {
        if (prev.length === 0) {
          // Nothing playing — start this track immediately.
          setCurrentIndex(0)
          playRequested.current = true
          return [track]
        }
        const next = [...prev]
        next.splice(currentIndex + 1, 0, track)
        return next
      })
    },
    [currentIndex, setQueue, setCurrentIndex]
  )

  const addToQueue = useCallback(
    (track) => {
      if (!track || !track.id) return
      setQueue((prev) => {
        if (prev.length === 0) {
          setCurrentIndex(0)
          playRequested.current = true
          return [track]
        }
        return [...prev, track]
      })
    },
    [setQueue, setCurrentIndex]
  )

  const next = useCallback(() => {
    setCurrentIndex((i) => {
      if (i < queue.length - 1) {
        playRequested.current = true
        return i + 1
      }
      // End of queue — stop.
      playRequested.current = false
      const el = audioRef.current
      if (el) el.pause()
      setIsPlaying(false)
      return i
    })
  }, [queue.length, setCurrentIndex])

  const prev = useCallback(() => {
    const el = audioRef.current
    // If we're more than ~3s into the track, restart it instead of going back.
    if (el && el.currentTime > 3) {
      el.currentTime = 0
      return
    }
    setCurrentIndex((i) => {
      if (i > 0) {
        playRequested.current = true
        return i - 1
      }
      return i
    })
  }, [setCurrentIndex])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el || currentIndex < 0) return
    if (el.paused) {
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [currentIndex])

  const toggleRepeat = useCallback(() => setRepeatOne((r) => !r), [setRepeatOne])

  const seek = useCallback((t) => {
    const el = audioRef.current
    if (el && Number.isFinite(t)) el.currentTime = t
  }, [])

  // Relative jump (Spotify-style -15s/+15s), clamped to the track's bounds so
  // skipping near either end can't push currentTime negative or past a
  // duration that hasn't loaded yet (0 reads as "unknown", not "empty").
  const skipBy = useCallback(
    (delta) => {
      const el = audioRef.current
      if (!el) return
      const max = duration > 0 ? duration : Infinity
      seek(Math.min(Math.max(el.currentTime + delta, 0), max))
    },
    [duration, seek]
  )

  // Step within the current track's chapter list (see AudioChapterList / the
  // detail-view and global-player chapter buttons). A track-level sibling of
  // prev()/next(): those move between queue entries, these move between
  // chapters of the one track currently playing.
  const nextChapter = useCallback(() => {
    if (!hasChapters) return
    const from = activeChapterIndex < 0 ? -1 : activeChapterIndex
    if (from < currentChapters.length - 1) seek(currentChapters[from + 1].start)
  }, [hasChapters, activeChapterIndex, currentChapters, seek])

  const prevChapter = useCallback(() => {
    if (!hasChapters) return
    const from = activeChapterIndex < 0 ? 0 : activeChapterIndex
    const el = audioRef.current
    // Mirrors prev()'s "restart vs. go back" feel: more than ~3s into the
    // current chapter restarts it, otherwise steps to the one before it.
    if (el && el.currentTime - currentChapters[from].start > 3) {
      seek(currentChapters[from].start)
    } else if (from > 0) {
      seek(currentChapters[from - 1].start)
    } else {
      seek(currentChapters[0].start)
    }
  }, [hasChapters, activeChapterIndex, currentChapters, seek])

  // Sleep timer (Spotify-style): either a wall-clock duration or "end of the
  // chapter that's playing right now". `null` means off. A duration timer
  // stores its target as an epoch ms (`endsAt`) rather than a countdown, so
  // it keeps correct time across tab backgrounding/throttled intervals — the
  // interval below is just a once-a-second check against that fixed target,
  // not the thing counting down. A chapter timer stores the chapter's own
  // `end` (track-seconds) and rides on the existing currentTime/chapter
  // machinery instead of a second timing mechanism.
  const [sleepTimer, setSleepTimer] = useState(null)

  const startSleepTimer = useCallback((minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    setSleepTimer({ type: 'duration', endsAt: Date.now() + minutes * 60000 })
  }, [])

  const startSleepTimerEndOfChapter = useCallback(() => {
    if (activeChapterIndex < 0 || !currentChapters[activeChapterIndex]) return
    setSleepTimer({ type: 'chapter', endTime: currentChapters[activeChapterIndex].end })
  }, [activeChapterIndex, currentChapters])

  const cancelSleepTimer = useCallback(() => setSleepTimer(null), [])

  // A duration timer needs its own clock — nothing else re-renders this
  // component once a second while paused/idle — both to fire the pause and
  // to keep the displayed countdown live. A chapter timer needs neither: it
  // fires off the currentTime updates the <audio> element already drives.
  useEffect(() => {
    if (!sleepTimer || sleepTimer.type !== 'duration') return
    const tick = () => {
      if (Date.now() >= sleepTimer.endsAt) {
        audioRef.current?.pause()
        setSleepTimer(null)
      } else {
        // Bump a field on the same object so consumers reading `sleepTimer`
        // (for a live "12:34 left" label) re-render each second; the target
        // time itself never changes.
        setSleepTimer((s) => (s ? { ...s } : s))
      }
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sleepTimer])

  useEffect(() => {
    if (sleepTimer?.type === 'chapter' && currentTime >= sleepTimer.endTime) {
      audioRef.current?.pause()
      setSleepTimer(null)
    }
  }, [sleepTimer, currentTime])

  const sleepTimerRemaining =
    sleepTimer?.type === 'duration' ? Math.max(0, Math.round((sleepTimer.endsAt - Date.now()) / 1000)) : null

  // Jump to a specific chapter/timestamp in `track`, starting it if it isn't
  // already the current track. Used by AudioChapterList.
  const playTrackAt = useCallback(
    (track, time) => {
      if (!track || !track.id) return
      if (currentTrack?.id === track.id) {
        // Already loaded — seek immediately, no src reload (and thus no
        // onLoadedMetadata) is coming to apply a pending seek.
        seek(time)
        const el = audioRef.current
        if (el && el.paused) el.play().catch(() => {})
      } else {
        pendingSeek.current = Number.isFinite(time) ? time : null
        playQueue([track])
      }
    },
    [currentTrack, playQueue, seek]
  )

  const removeAt = useCallback(
    (index) => {
      setQueue((prev) => {
        const nextQueue = prev.filter((_, i) => i !== index)
        setCurrentIndex((ci) => {
          if (nextQueue.length === 0) return -1
          if (index < ci) return ci - 1
          if (index === ci) {
            // Removed the current track: keep the same slot (now the next track),
            // clamped to the new bounds, and request playback of it.
            playRequested.current = true
            return Math.min(ci, nextQueue.length - 1)
          }
          return ci
        })
        return nextQueue
      })
    },
    [setQueue, setCurrentIndex]
  )

  const jumpTo = useCallback(
    (index) => {
      if (index < 0 || index >= queue.length) return
      playRequested.current = true
      setCurrentIndex(index)
    },
    [queue.length, setCurrentIndex]
  )

  // Reorder the queue by moving the track at `from` to `to`, keeping the
  // currently-playing track selected (no remove/re-add, so playback continues).
  const moveTrack = useCallback(
    (from, to) => {
      setQueue((prev) => {
        if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length)
          return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        // Keep currentIndex pointing at the same (still-playing) track.
        setCurrentIndex((ci) => {
          if (ci === from) return to
          // A track moved across the current slot shifts it by one.
          if (from < ci && to >= ci) return ci - 1
          if (from > ci && to <= ci) return ci + 1
          return ci
        })
        return next
      })
    },
    [setQueue, setCurrentIndex]
  )

  const clear = useCallback(() => {
    const el = audioRef.current
    if (el) el.pause()
    setQueue([])
    setCurrentIndex(-1)
    setIsPlaying(false)
    setExpanded(false)
    setSleepTimer(null)
  }, [setQueue, setCurrentIndex])

  const toggleExpanded = useCallback(() => setExpanded((e) => !e), [])

  // Whether a track is anywhere in the queue — what the "Play next" control
  // uses to show an already-queued state, mirroring the soundboard's pad check.
  const inQueue = useCallback((id) => queue.some((t) => t.id === id), [queue])

  const isCurrent = useCallback((id) => currentTrack?.id === id, [currentTrack])
  const isPlayingId = useCallback(
    (id) => isPlaying && currentTrack?.id === id,
    [isPlaying, currentTrack]
  )

  // If the persisted index points past the end of a (restored) queue, reset it.
  useEffect(() => {
    if (currentIndex >= queue.length) setCurrentIndex(queue.length - 1)
  }, [queue.length, currentIndex, setCurrentIndex])

  // Lazily hydrate queue entries that were added with only an id (campaign
  // resources, note embeds) so the player/queue show title + artwork. Each id is
  // fetched at most once; results patch every matching entry still in the queue.
  const hydratingIds = useRef(new Set())
  useEffect(() => {
    const pending = queue.filter((t) => needsHydration(t) && !hydratingIds.current.has(t.id))
    if (pending.length === 0) return
    const ids = [...new Set(pending.map((t) => t.id))]
    ids.forEach((id) => hydratingIds.current.add(id))
    ids.forEach((id) => {
      api
        .get(`/audio/${id}`)
        .then((data) => {
          setQueue((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    title: t.title || data.title || data.filename,
                    artist: t.artist || data.artist || '',
                    artwork: t.artwork || !!data.has_artwork,
                    _hydrated: true,
                  }
                : t
            )
          )
        })
        .catch(() => {
          // Mark resolved-with-no-metadata so we don't keep retrying a bad id.
          setQueue((prev) => prev.map((t) => (t.id === id ? { ...t, _hydrated: true } : t)))
        })
        .finally(() => {
          hydratingIds.current.delete(id)
        })
    })
  }, [queue, setQueue])

  const value = {
    audioRef,
    playRequested,
    pendingSeek,
    queue,
    currentIndex,
    currentTrack,
    isPlaying,
    setIsPlaying,
    currentTime,
    setCurrentTime,
    duration,
    setDuration,
    repeatOne,
    expanded,
    currentChapters,
    hasChapters,
    activeChapterIndex,
    sleepTimer,
    sleepTimerRemaining,
    // actions
    playQueue,
    playNext,
    addToQueue,
    next,
    prev,
    nextChapter,
    prevChapter,
    togglePlay,
    toggleRepeat,
    seek,
    skipBy,
    playTrackAt,
    startSleepTimer,
    startSleepTimerEndOfChapter,
    cancelSleepTimer,
    removeAt,
    jumpTo,
    moveTrack,
    clear,
    toggleExpanded,
    // selectors
    isCurrent,
    isPlayingId,
    inQueue,
  }

  return <AudioPlayerContext.Provider value={value}>{children}</AudioPlayerContext.Provider>
}

export function useAudioPlayer() {
  const ctx = useContext(AudioPlayerContext)
  if (!ctx) {
    // A no-op fallback keeps controllers safe to render outside the provider
    // (e.g. in isolated component tests that don't wrap with the provider).
    return NOOP_PLAYER
  }
  return ctx
}

const NOOP = () => {}
const NOOP_PLAYER = {
  audioRef: { current: null },
  playRequested: { current: false },
  pendingSeek: { current: null },
  queue: [],
  currentIndex: -1,
  currentTrack: null,
  isPlaying: false,
  setIsPlaying: NOOP,
  currentTime: 0,
  setCurrentTime: NOOP,
  duration: 0,
  setDuration: NOOP,
  repeatOne: false,
  expanded: false,
  currentChapters: [],
  hasChapters: false,
  activeChapterIndex: -1,
  sleepTimer: null,
  sleepTimerRemaining: null,
  playQueue: NOOP,
  playNext: NOOP,
  addToQueue: NOOP,
  next: NOOP,
  prev: NOOP,
  nextChapter: NOOP,
  prevChapter: NOOP,
  togglePlay: NOOP,
  toggleRepeat: NOOP,
  seek: NOOP,
  skipBy: NOOP,
  playTrackAt: NOOP,
  startSleepTimer: NOOP,
  startSleepTimerEndOfChapter: NOOP,
  cancelSleepTimer: NOOP,
  removeAt: NOOP,
  jumpTo: NOOP,
  moveTrack: NOOP,
  clear: NOOP,
  toggleExpanded: NOOP,
  isCurrent: () => false,
  isPlayingId: () => false,
  inQueue: () => false,
}
