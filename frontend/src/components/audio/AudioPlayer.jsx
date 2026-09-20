import { useTranslation } from 'react-i18next'
import { LuPlay, LuPause, LuListPlus, LuListCheck } from 'react-icons/lu'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

/**
 * A thin controller for the global audio player. Given a `track`
 * ({ id, title?, artwork? }), the overlay button plays/pauses that track in the
 * single app-wide player; the optional "Play Next" button queues it after the
 * current track without interrupting playback.
 *
 * A track already in the queue shows a checked icon and the button becomes a
 * no-op rather than disappearing, so the control doesn't shift position on
 * click and queueing the same track twice isn't possible by accident. This
 * mirrors AddToSoundboardButton, so both destinations read the same way.
 *
 * This replaces the old self-contained <audio> element — there is now exactly
 * one audio element app-wide (see GlobalAudioPlayer), so playback survives
 * navigation and multiple controls stay in sync.
 */
export default function AudioPlayer({ track, showPlayNext = false, size = 44, savedFraction }) {
  const { t } = useTranslation()
  const {
    playQueue,
    playNext,
    togglePlay,
    isCurrent,
    isPlayingId,
    inQueue,
    currentTime,
    duration,
  } = useAudioPlayer()

  if (!track || !track.id) return null

  const playing = isPlayingId(track.id)
  const current = isCurrent(track.id)

  // Progress ring around the button, so a glance at the control also says how
  // far into the track you are. The current track's own live position wins
  // (it's exact, and keeps advancing while playing); otherwise `savedFraction`
  // — this listener's last saved position for this item, as a 0..1 fraction of
  // the full duration, passed in by gallery rows (see MediaCard) — draws the
  // same ring for a book you've started but isn't loaded right now. A
  // zero/unknown duration (still loading, or a stream) leaves the ring empty.
  const hasSavedFraction = typeof savedFraction === 'number' && Number.isFinite(savedFraction)
  const progress =
    current && duration > 0
      ? Math.min(Math.max(currentTime / duration, 0), 1)
      : hasSavedFraction
        ? Math.min(Math.max(savedFraction, 0), 1)
        : 0
  const showRing = current || (hasSavedFraction && progress > 0)
  const ringWidth = Math.max(2, Math.round(size * 0.07))

  const onToggle = (e) => {
    e.stopPropagation()
    if (isCurrent(track.id)) {
      togglePlay()
    } else {
      playQueue([track])
    }
  }

  const queued = inQueue(track.id)
  const queueLabel = queued ? t('audio.player.queued') : t('audio.player.playNext')

  const onPlayNext = (e) => {
    e.stopPropagation()
    if (!queued) playNext(track)
  }

  return (
    <>
      <div
        // The ring is a conic-gradient disc masked by the button sitting on top
        // of it, which avoids an SVG and scales with `size`.
        //
        // pointerEvents: 'auto' matters in the gallery grid card: the overlay
        // that centers this component inside the thumbnail is itself
        // pointerEvents:'none' (so the rest of the artwork falls through to
        // the card's navigation link) — this re-enables clicks on just this
        // button-sized area, not the whole thumbnail.
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'auto',
          background: showRing
            ? `conic-gradient(var(--gold) ${progress * 360}deg, var(--border) 0deg)`
            : 'transparent',
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={playing ? t('audio.pause') : t('audio.play')}
          style={{
            width: showRing ? size - ringWidth * 2 : size,
            height: showRing ? size - ringWidth * 2 : size,
            borderRadius: '50%',
            border: 'none',
            background: 'var(--overlay)',
            color: 'var(--on-media)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 2px 8px var(--shadow)',
            flexShrink: 0,
            padding: 0,
          }}
        >
          {playing ? (
            <LuPause size={size * 0.45} />
          ) : (
            <LuPlay size={size * 0.45} style={{ marginLeft: 2 }} />
          )}
        </button>
      </div>
      {showPlayNext && (
        <button
          type="button"
          onClick={onPlayNext}
          aria-label={queueLabel}
          title={queueLabel}
          aria-pressed={queued}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: '50%',
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: queued ? 'var(--gold)' : 'var(--text-dim)',
            cursor: queued ? 'default' : 'pointer',
            flexShrink: 0,
          }}
        >
          {queued ? <LuListCheck size={15} /> : <LuListPlus size={15} />}
        </button>
      )}
    </>
  )
}
