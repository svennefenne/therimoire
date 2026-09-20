import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration } from '../../utils'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

/**
 * Chapter markers for an audiobook-style M4A/M4B track (see
 * indexer/audio_chapters.py for how they're read). Renders nothing when the
 * track has none — an ordinary track with no `chapters` never grows this
 * section.
 *
 * Clicking a chapter starts the track (if it isn't already playing) and
 * jumps straight to that timestamp via `playTrackAt`; the chapter containing
 * the current playback position is highlighted and kept in view while this
 * track is the one playing.
 *
 * `kind` ('audio' | 'audiobook') is threaded into the track ref handed to
 * `playTrackAt` so the global player streams from the right API base — see
 * `apiBaseFor` in AudioPlayerContext.
 */
export default function AudioChapterList({ track, kind = 'audio' }) {
  const { t } = useTranslation()
  const { isCurrent, currentTime, playTrackAt } = useAudioPlayer()

  const chapters = track?.chapters
  const current = isCurrent(track?.id)
  const activeIndex = current
    ? chapters?.findIndex((c) => currentTime >= c.start && currentTime < c.end)
    : -1

  const activeRef = useRef(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!chapters || chapters.length === 0) return null

  const onSelect = (chapter) => {
    playTrackAt(
      { id: track.id, title: track.title || track.filename, artwork: track.has_artwork, kind },
      chapter.start
    )
  }

  return (
    <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
      <div
        style={{
          fontSize: 12,
          color: 'var(--text-muted)',
          marginBottom: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {t('audio.detail.chapters')} ({chapters.length})
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', borderRadius: 6 }}>
        {chapters.map((chapter, i) => {
          const active = i === activeIndex
          return (
            <button
              key={`${chapter.start}-${i}`}
              ref={active ? activeRef : null}
              type="button"
              onClick={() => onSelect(chapter)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '7px 8px',
                background: active ? 'var(--bg-card-hover)' : 'transparent',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
                color: active ? 'var(--gold)' : 'var(--text)',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: active ? 'var(--gold)' : 'var(--text-muted)',
                  width: 44,
                }}
              >
                {formatDuration(chapter.start)}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 13,
                }}
              >
                {chapter.title || t('audio.detail.untitledChapter', { number: i + 1 })}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
