import { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react'
import api from '../api'
import useSessionState from '../hooks/useSessionState'

const AudioPlayerContext = createContext(null)

// Volume and playback rate are device/listener preferences, not part of a
// playback session, so they persist in localStorage (survives a hard reload)
// rather than the sessionStorage the queue itself uses.
const VOLUME_KEY = 'grimoire:audio:volume'
const RATE_KEY = 'grimoire:audio:rate'
const MIN_RATE = 0.5
const MAX_RATE = 2

const readStoredNumber = (key, fallback, { min, max } = {}) => {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return fallback
    if (min != null && n < min) return fallback
    if (max != null && n > max) return fallback
    return n
  } catch {
    return fallback
  }
}
const writeStoredNumber = (key, n) => {
  try {
    localStorage.setItem(key, String(n))
  } catch {}
}

// A track ref is the minimal shape we need to play + display a queue entry:
//   { id, title?, artist?, artwork?, kind? }
// The audio file URL is derived from `id` at play time, so only the id is
// required. Entries added with just an id (campaign resources, note embeds) are
// lazily hydrated from GET /audio/:id (or /audiobooks/:id) so the player/queue
// show a rich label.

// `kind` distinguishes an Audiobooks item from a regular Audio track — the two
// are separate collections with separate API routes (see routers/audiobooks),
// even though they share this one global player. Every track ref defaults to
// 'audio' when `kind` is absent, so every existing call site (gallery cards,
// campaign resources, the soundboard) keeps working unchanged.
export const apiBaseFor = (track) => (track?.kind === 'audiobook' ? '/audiobooks' : '/audio')

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

  // Volume: 0..1, pushed onto the <audio> element by the effect below (see
  // its comment for why that has to be an effect rather than a prop). Muting
  // is "remember the volume, drop to 0" rather than a separate boolean, so
  // there is only ever one source of truth for how loud playback actually is.
  const [volume, setVolumeState] = useState(() => readStoredNumber(VOLUME_KEY, 1, { min: 0, max: 1 }))
  const previousVolumeRef = useRef(volume > 0 ? volume : 1)

  const setVolume = useCallback((v) => {
    if (!Number.isFinite(v)) return
    const clamped = Math.min(1, Math.max(0, v))
    if (clamped > 0) previousVolumeRef.current = clamped
    setVolumeState(clamped)
    writeStoredNumber(VOLUME_KEY, clamped)
  }, [])

  const toggleMute = useCallback(() => {
    setVolumeState((v) => {
      if (v > 0) {
        previousVolumeRef.current = v
        writeStoredNumber(VOLUME_KEY, 0)
        return 0
      }
      const restored = previousVolumeRef.current || 1
      writeStoredNumber(VOLUME_KEY, restored)
      return restored
    })
  }, [])

  // Playback speed. Unlike volume this isn't a plain React-managed DOM prop,
  // so it needs the effect below to push it onto the element — including
  // whenever the track changes, since loading a new src can reset it.
  const [rate, setRateState] = useState(() =>
    readStoredNumber(RATE_KEY, 1, { min: MIN_RATE, max: MAX_RATE })
  )
  const setRate = useCallback((r) => {
    if (!Number.isFinite(r)) return
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, r))
    setRateState(clamped)
    writeStoredNumber(RATE_KEY, clamped)
  }, [])

  const currentTrack = currentIndex >= 0 ? queue[currentIndex] : null

  // Chapters (M4A/M4B audiobooks — see AudioChapterList) aren't part of the
  // minimal track-ref shape queue entries carry, so they're fetched
  // separately for whichever track is actually playing. Scoped to just the
  // current track rather than folded into the title/artist hydration below:
  // that effect runs eagerly for every queue entry to fill in display text,
  // where a chapter list is only ever needed for the one track in earshot.
  //
  // The same fetch also carries this user's saved playback position for an
  // audiobook (`progress_seconds`, absent for plain Audio items) — one round
  // trip rather than a second effect. `resumeSeconds` is `undefined` while
  // the fetch for the *current* track id is still in flight (distinct from
  // `null`, "fetched, nothing saved") — the resume effect below needs that
  // three-way distinction to know when it's actually safe to decide.
  const [currentChapters, setCurrentChapters] = useState([])
  const [resumeSeconds, setResumeSeconds] = useState(null)
  useEffect(() => {
    const id = currentTrack?.id
    if (!id) {
      setCurrentChapters([])
      setResumeSeconds(null)
      return
    }
    let cancelled = false
    setResumeSeconds(undefined)
    api
      .get(`${apiBaseFor(currentTrack)}/${id}`)
      .then((data) => {
        if (cancelled) return
        setCurrentChapters(data.chapters || [])
        setResumeSeconds(Number.isFinite(data.progress_seconds) ? data.progress_seconds : null)
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentChapters([])
          setResumeSeconds(null)
        }
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

  // Which track id an explicit seek (a chapter click via playTrackAt) was
  // just requested for — the resume-on-play effect further down checks this
  // instead of `pendingSeek` itself. `pendingSeek` is nulled synchronously
  // inside onLoadedMetadata the moment it's applied, which can happen before
  // the resume effect (driven by state: metadata-ready + the fetched saved
  // position, whichever resolves second) ever gets to look at it — by the
  // time that effect runs, `pendingSeek.current` would already read back
  // null regardless of whether a seek was requested, making it useless as a
  // "was this an explicit seek" flag for anything but the same tick. This
  // ref is never cleared early, so it survives until the resume effect reads
  // it no matter which of the two async signals (metadata / saved position)
  // arrives first.
  const skipResumeFor = useRef(null)

  // `duration` (state) isn't reset when the current track changes, so a
  // stale nonzero value from the *previous* track would otherwise let the
  // resume effect below think metadata for the new one is already loaded —
  // and calling seek() before the browser has actually parsed the new src's
  // metadata gets silently reset to 0, the exact failure pendingSeek exists
  // to dodge. Resetting both here on every track change keeps `duration` a
  // reliable "is there loaded metadata for *this* track" signal once
  // GlobalAudioPlayer's onLoadedMetadata sets it again for real.
  useEffect(() => {
    setDuration(0)
    setCurrentTime(0)
  }, [currentTrack?.id])

  // Set by GlobalAudioPlayer's onLoadedMetadata, once real metadata for the
  // currently-loading src has arrived — the other half of the "safe to
  // resume" gate alongside `resumeSeconds` above.
  const [metadataReadyId, setMetadataReadyId] = useState(null)
  const markMetadataReady = useCallback((id) => setMetadataReadyId(id), [])

  // Re-applied on every rate/volume change and every track change: the
  // single <audio> element is reused across tracks, but loading a new src
  // can reset playbackRate to 1 in some browsers — GlobalAudioPlayer's
  // onLoadedMetadata reapplies both, as a belt-and-suspenders for that case.
  // Volume in particular needs this rather than a `volume` prop on <audio>:
  // unlike `muted`, React does not special-case `volume` as an IDL property
  // for media elements, so passing it as a prop silently does nothing — the
  // slider moved and the on-screen feedback updated, but actual playback
  // stayed at whatever the element's default was.
  useEffect(() => {
    const el = audioRef.current
    if (el) el.volume = volume
  }, [volume, currentTrack?.id])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.playbackRate = rate
  }, [rate, currentTrack?.id])

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

  // Resolves the resume-on-play decision for whichever track is current, the
  // moment BOTH signals it needs are in: metadata has loaded for this track
  // (`metadataReadyId`) and the saved-position lookup for it has resolved
  // (`resumeSeconds` no longer `undefined`). Those two can arrive in either
  // order — a slow network favours metadata-first, a fast one can flip it —
  // so this effect is keyed off both and just waits for whichever settles
  // last, rather than assuming one always precedes the other.
  const resumeResolvedFor = useRef(null)
  useEffect(() => {
    const track = currentTrack
    if (!track?.id) return
    if (resumeResolvedFor.current === track.id) return
    if (metadataReadyId !== track.id) return
    if (resumeSeconds === undefined) return
    resumeResolvedFor.current = track.id
    if (skipResumeFor.current === track.id) return
    // Don't resume into the last few seconds of a finished book — reads as
    // starting over on a click rather than continuing.
    if (resumeSeconds != null && resumeSeconds > 0 && duration > 0 && resumeSeconds < duration - 5) {
      seek(resumeSeconds)
    }
  }, [currentTrack, metadataReadyId, resumeSeconds, duration, seek])

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
        // An explicit target time (a chapter click) always wins over a saved
        // resume position for this track load — see skipResumeFor's comment.
        skipResumeFor.current = track.id
        playQueue([track])
      }
    },
    [currentTrack, playQueue, seek]
  )

  // Mirrors `currentTime` without retriggering the effects below on every
  // single onTimeUpdate tick — they only need the *latest* position at the
  // moment they actually save, not a reason to re-run every fraction of a
  // second.
  const currentTimeRef = useRef(0)
  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  // Best-effort save of this user's playback position, for resume-on-play.
  // Audiobooks only (see apiBaseFor) — regular Audio/ambience tracks have no
  // per-user "where you left off" concept. Silently ignores failures, same as
  // the chapters fetch above: a missed save just means the next one (or the
  // periodic/pause/unmount saves below) catches up.
  const saveProgress = useCallback((track, position) => {
    if (!track?.id || apiBaseFor(track) !== '/audiobooks') return
    if (!Number.isFinite(position) || position < 0) return
    api.put(`/audiobooks/${track.id}/progress`, { position_seconds: position }).catch(() => {})
  }, [])

  // Periodic save while actually playing an audiobook, so a crash/reload
  // loses at most ~15s of progress rather than everything since the last
  // pause or track change.
  useEffect(() => {
    if (!isPlaying || apiBaseFor(currentTrack) !== '/audiobooks') return
    const id = setInterval(() => {
      saveProgress(currentTrack, currentTimeRef.current)
    }, 15000)
    return () => clearInterval(id)
  }, [isPlaying, currentTrack, saveProgress])

  // Save the instant playback pauses (covers the pause button, the sleep
  // timer firing, and reaching the end of a non-repeating queue).
  const wasPlayingRef = useRef(false)
  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying) {
      saveProgress(currentTrack, currentTimeRef.current)
    }
    wasPlayingRef.current = isPlaying
  }, [isPlaying, currentTrack, saveProgress])

  // Save whatever position the *previous* track was at the moment we leave
  // it (queue advance, jumpTo, a fresh playQueue, or unmount) — the periodic
  // timer alone would otherwise lose up to 15s on every track change.
  // `currentTimeRef` still holds the outgoing track's last reported time
  // here: the browser doesn't reset our `currentTime` state until the new
  // track's own onTimeUpdate fires, which hasn't happened yet at cleanup.
  useEffect(() => {
    const track = currentTrack
    if (!track?.id) return
    return () => {
      saveProgress(track, currentTimeRef.current)
    }
  }, [currentTrack, saveProgress])

  // Reset this user's saved position for `audiobookId` ("Mark as not
  // started" — see AudiobookDetailView). If it's the track currently loaded,
  // also snaps local playback back to 0 rather than leaving the player
  // sitting mid-book while the server says "not started".
  const resetProgress = useCallback(
    async (audiobookId) => {
      if (!audiobookId) return
      try {
        await api.delete(`/audiobooks/${audiobookId}/progress`)
      } catch {
        // Best-effort — the detail view still updates its own local state.
      }
      if (currentTrack?.id === audiobookId) {
        skipResumeFor.current = audiobookId
        setResumeSeconds(null)
        seek(0)
      }
    },
    [currentTrack, seek]
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
    // Kept per id (not just deduped ids) so the fetch can hit the right API
    // base — an id is unique within its own collection, so the first ref seen
    // for an id always carries that id's real kind.
    const byId = new Map()
    for (const t of pending) if (!byId.has(t.id)) byId.set(t.id, t)
    const ids = [...byId.keys()]
    ids.forEach((id) => hydratingIds.current.add(id))
    ids.forEach((id) => {
      api
        .get(`${apiBaseFor(byId.get(id))}/${id}`)
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
    markMetadataReady,
    resumeSeconds,
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
    volume,
    rate,
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
    setVolume,
    toggleMute,
    setRate,
    playTrackAt,
    startSleepTimer,
    startSleepTimerEndOfChapter,
    cancelSleepTimer,
    removeAt,
    jumpTo,
    moveTrack,
    clear,
    toggleExpanded,
    resetProgress,
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
  markMetadataReady: NOOP,
  resumeSeconds: null,
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
  volume: 1,
  rate: 1,
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
  setVolume: NOOP,
  toggleMute: NOOP,
  setRate: NOOP,
  playTrackAt: NOOP,
  startSleepTimer: NOOP,
  startSleepTimerEndOfChapter: NOOP,
  cancelSleepTimer: NOOP,
  removeAt: NOOP,
  jumpTo: NOOP,
  moveTrack: NOOP,
  clear: NOOP,
  toggleExpanded: NOOP,
  resetProgress: NOOP,
  isCurrent: () => false,
  isPlayingId: () => false,
  inQueue: () => false,
}
