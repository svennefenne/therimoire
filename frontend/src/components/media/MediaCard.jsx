import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LuCheck, LuFileVideo } from 'react-icons/lu'
import api, { mediaUrl } from '../../api'
import { formatSize } from '../../utils'
import FavoriteButton from '../FavoriteButton'
import DownloadButton from '../DownloadButton'
import AudioPlayer from '../audio/AudioPlayer'
import AddToSoundboardButton from '../audio/AddToSoundboardButton'
import NowPlayingIndicator from '../audio/NowPlayingIndicator'
import LazyImg from '../LazyImg'
import CardLink from '../CardLink'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import VariantBadge from './VariantBadge'

const CORNER_POS = {
  'bottom-left': { bottom: 6, left: 6 },
  'bottom-right': { bottom: 6, right: 6 },
  // Top-left is free on the thumbnail (favorite/download sit top-right); in bulk
  // mode the selection checkbox takes it, so corner badges are hidden there.
  'top-left': { top: 6, left: 6 },
}

/**
 * Generic gallery card for a media item (map, token, …). Behaviour is identical
 * across types; per-type differences (icon, thumbnail shape, badges, font size)
 * come from the `config` entry in mediaConfig.js.
 */
export default function MediaCard({ config, item, bulkMode, selected, onToggle, list }) {
  const { t } = useTranslation()
  const [hovered, setHovered] = useState(false)
  const {
    isCurrent,
    isPlayingId,
    currentTime,
    duration,
    currentChapters,
    activeChapterIndex,
    resetProgress,
    seek,
  } = useAudioPlayer()
  const Icon = config.icon

  // Outside bulk mode the card is a real link (a CardLink overlay), so middle
  // click and ctrl/cmd-click open the detail page in a new tab (issue #313).
  // Bulk mode claims the modifier keys for range and multi-select, so there the
  // card stays a toggle button.
  const toggle = (e) => onToggle({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
  const buttonProps = bulkMode
    ? {
        onClick: toggle,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(e)
          }
        },
        role: 'button',
        tabIndex: 0,
        'aria-label': item.title || item.filename,
        'aria-pressed': selected,
      }
    : {}
  const cardLink = !bulkMode && (
    <CardLink to={config.detailPath(item.id)} label={item.title || item.filename} />
  )

  // Badges that apply to this item, in config order. `footer` badges render in
  // the card footer next to the size (and in the list-mode metadata row) rather
  // than over the thumbnail art.
  const activeBadges = config.badges.filter((b) => item[b.flag])
  const cornerBadges = activeBadges.filter((b) => b.corner)
  const footerBadges = activeBadges.filter((b) => b.footer)

  // Which item field signals an available thumbnail/artwork (audio uses artwork).
  const hasThumbnail = item[config.thumbnailFlag || 'has_thumbnail']

  // Animated maps (.webm/.mp4) never get a thumbnail — extracting a frame needs
  // a video decoder the image deliberately does not ship — so the placeholder
  // icon says "video" rather than falling back to the generic map pin.
  const isVideoItem = /\.(webm|mp4)$/i.test(item.filename || '')
  const PlaceholderIcon = isVideoItem ? LuFileVideo : Icon

  // Track ref for the global audio player (audio gallery only). Archives in the
  // audio tree (issue #250) are opaque blobs with nothing to play.
  const isAudio = !!config.audioFileUrl && !item.is_archive
  // `kind` lets the global player resolve the right API base (/audio vs
  // /audiobooks — see apiBaseFor in AudioPlayerContext); config.type is
  // exactly that collection name for both.
  const track = isAudio
    ? { id: item.id, title: item.title || item.filename, artwork: item.has_artwork, kind: config.type }
    : null

  // "Active" (this is the loaded track — keeps the row findable even when
  // paused) is a separate signal from "playing" (drives the animation). Gated on
  // audio so map/token rows are untouched.
  const isActiveTrack = isAudio && isCurrent(item.id)
  const isPlayingTrack = isAudio && isPlayingId(item.id)

  // The extra chapter/progress reporting below (progress ring fraction,
  // "23% of Chapter 3", the reset actions) is audiobook-only — plain Audio
  // tracks have no per-user resume state on the backend.
  const isAudiobook = isAudio && config.type === 'audiobook'

  // A "Reset chapter progress" / "Mark as not started" click updates the
  // server, but this card only gets a fresh item.progress_seconds on the
  // gallery's next full fetch — so the result is held here and preferred
  // over the prop until then, letting the row update immediately.
  const [progressOverride, setProgressOverride] = useState(null)

  // While this book is the one actually loaded in the player, its live
  // position is more accurate than whatever was last saved to the server
  // (which trails by up to the periodic save interval — see
  // AudioPlayerContext) — mirrors the same live-vs-saved choice
  // AudiobookDetailView makes for its own "Continue from" row.
  const effectiveProgressSeconds = isActiveTrack
    ? currentTime
    : progressOverride
      ? progressOverride.progress_seconds
      : item.progress_seconds
  const effectiveCurrentChapter = isActiveTrack
    ? activeChapterIndex >= 0 && currentChapters[activeChapterIndex]
      ? {
          index: activeChapterIndex,
          title: currentChapters[activeChapterIndex].title || '',
          start_seconds: currentChapters[activeChapterIndex].start,
          percent: Math.max(
            0,
            Math.min(
              1,
              (currentTime - currentChapters[activeChapterIndex].start) /
                Math.max(
                  currentChapters[activeChapterIndex].end -
                    currentChapters[activeChapterIndex].start,
                  0.001
                )
            )
          ),
        }
      : null
    : progressOverride
      ? progressOverride.current_chapter
      : item.current_chapter
  const effectiveChapterCount = isActiveTrack ? currentChapters.length : item.chapter_count || 0
  const effectiveDuration = isActiveTrack && duration > 0 ? duration : item.duration || 0

  const hasResumableProgress =
    isAudiobook &&
    effectiveDuration > 0 &&
    effectiveProgressSeconds > 3 &&
    effectiveProgressSeconds < effectiveDuration - 3
  const savedFraction =
    isAudiobook && effectiveDuration > 0 && Number.isFinite(effectiveProgressSeconds)
      ? effectiveProgressSeconds / effectiveDuration
      : undefined

  const chapterLabel = (chapter) =>
    chapter?.title || t('audiobooks.detail.chapterNumber', { number: (chapter?.index ?? 0) + 1 })
  // How far through the *current chapter* (not the whole book — that's
  // savedFraction, for the ring) — this is what "23% of Chapter 3" reports,
  // and what resetChapterProgress below zeroes out immediately by setting
  // current_chapter.percent to 0 in the override, ahead of the server
  // round trip actually landing.
  const chapterPercent = Math.round((effectiveCurrentChapter?.percent ?? 0) * 100)

  const markNotStarted = async () => {
    await resetProgress(item.id)
    setProgressOverride({ progress_seconds: null, current_chapter: null })
  }

  const resetChapterProgress = async () => {
    const chapter = effectiveCurrentChapter
    if (!chapter) return
    const newPosition = chapter.start_seconds
    try {
      await api.put(`/audiobooks/${item.id}/progress`, { position_seconds: newPosition })
    } catch {
      // Best-effort — matches the save-progress calls in AudioPlayerContext.
    }
    setProgressOverride({
      progress_seconds: newPosition,
      current_chapter: { ...chapter, percent: 0 },
    })
    if (isActiveTrack) seek(newPosition)
  }

  if (list) {
    return (
      <div
        {...buttonProps}
        aria-current={isActiveTrack ? 'true' : undefined}
        data-now-playing={isActiveTrack ? 'true' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '10px 14px',
          background: selected || isActiveTrack ? 'var(--bg-card-hover)' : 'var(--bg-card)',
          border:
            selected || isActiveTrack ? '1px solid var(--gold-dim)' : '1px solid var(--border)',
          // Left accent bar — a second, non-color-dependent cue for the active row.
          borderLeft: isActiveTrack ? '3px solid var(--gold)' : undefined,
          borderRadius: 8,
          cursor: bulkMode ? 'default' : 'pointer',
          transition: 'border-color 0.15s',
          position: 'relative',
        }}
      >
        {cardLink}
        {bulkMode && (
          <div
            style={{
              width: 20,
              height: 20,
              flexShrink: 0,
              borderRadius: 4,
              background: selected ? 'var(--gold)' : 'transparent',
              border: selected ? 'none' : '2px solid var(--border-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {selected && <LuCheck size={12} color="var(--bg-deep)" strokeWidth={3} />}
          </div>
        )}
        <div
          style={{
            width: config.listIcon.width,
            height: config.listIcon.height,
            borderRadius: 4,
            overflow: 'hidden',
            flexShrink: 0,
            background: 'var(--bg-deep)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {hasThumbnail ? (
            <LazyImg
              src={mediaUrl(config.thumbnailUrl(item.id))}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <PlaceholderIcon
              size={18}
              color="var(--text-muted)"
              aria-hidden="true"
              data-testid={isVideoItem ? 'video-placeholder' : 'media-placeholder'}
              style={{ opacity: 0.4 }}
            />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isActiveTrack ? 'var(--gold)' : undefined,
              fontWeight: isActiveTrack ? 600 : undefined,
            }}
          >
            {item.title || item.filename}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              display: 'flex',
              gap: 8,
              marginTop: 2,
              alignItems: 'center',
            }}
          >
            <span>{formatSize(item.file_size)}</span>
            {isActiveTrack && (
              <span style={{ color: 'var(--gold)' }}>
                {t(isPlayingTrack ? 'audio.nowPlaying' : 'audio.nowPlayingPaused')}
              </span>
            )}
            {cornerBadges.map((b) => (
              <span key={b.flag} style={{ color: b.inlineColor }}>
                {t(b.labelKey || `${config.i18n}.${b.label}`)}
              </span>
            ))}
            {footerBadges.map((b) => (
              <VariantBadge key={b.flag} item={item} />
            ))}
          </div>
          {isAudiobook && effectiveChapterCount > 0 && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                display: 'flex',
                gap: 8,
                marginTop: 3,
                alignItems: 'center',
                flexWrap: 'wrap',
                // Establishes a stacking context above the CardLink overlay
                // (see the comment on the action-buttons row below) so the
                // reset links here are actually clickable.
                position: 'relative',
              }}
            >
              <span>
                {t('audiobooks.detail.chaptersCount', { count: effectiveChapterCount })}
              </span>
              {hasResumableProgress && (
                <>
                  <span>
                    {t('audiobooks.detail.progressOfChapter', {
                      percent: chapterPercent,
                      chapter: chapterLabel(effectiveCurrentChapter),
                    })}
                  </span>
                  {effectiveCurrentChapter && (
                    <button
                      type="button"
                      onClick={resetChapterProgress}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--gold)',
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      {t('audiobooks.detail.resetChapterProgress')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={markNotStarted}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--gold)',
                      fontSize: 12,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    {t('audiobooks.detail.markNotStarted')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {!bulkMode && (
          // Positioned so the action buttons paint above the CardLink overlay.
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0,
              position: 'relative',
            }}
          >
            {/* The row's metadata line already announces the state as text, so
                the bars are decorative here. */}
            {isActiveTrack && (
              <span aria-hidden="true" style={{ display: 'inline-flex', marginRight: 4 }}>
                <NowPlayingIndicator playing={isPlayingTrack} size={14} />
              </span>
            )}
            {isAudio && !item.is_missing && (
              <>
                <AudioPlayer track={track} showPlayNext size={30} savedFraction={savedFraction} />
                <AddToSoundboardButton track={track} size={30} />
              </>
            )}
            <DownloadButton
              type={config.downloadType}
              id={item.id}
              item={item}
              style={{ position: 'static', background: 'transparent', width: 28, height: 28 }}
            />
            <FavoriteButton
              type={config.type}
              id={item.id}
              style={{ position: 'static', background: 'transparent', width: 28, height: 28 }}
            />
          </div>
        )}
      </div>
    )
  }

  const thumbStyle =
    config.thumb.kind === 'square'
      ? { width: '100%', aspectRatio: '1/1' }
      : { width: '100%', height: config.thumb.height }

  return (
    <div
      {...buttonProps}
      style={{
        background: selected ? 'var(--bg-card-hover)' : 'var(--bg-card)',
        border: selected ? '1px solid var(--gold-dim)' : '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        cursor: bulkMode ? 'default' : 'pointer',
        transition: 'border-color 0.15s',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        setHovered(true)
        if (!bulkMode && !selected) e.currentTarget.style.borderColor = 'var(--border-light)'
      }}
      onMouseLeave={(e) => {
        setHovered(false)
        if (!selected) e.currentTarget.style.borderColor = 'var(--border)'
      }}
    >
      {cardLink}
      {!bulkMode && (
        <DownloadButton type={config.downloadType} id={item.id} item={item} cardHovered={hovered} />
      )}
      {!bulkMode && <FavoriteButton type={config.type} id={item.id} cardHovered={hovered} />}
      {bulkMode && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 2,
            width: 20,
            height: 20,
            borderRadius: 4,
            background: selected ? 'var(--gold)' : 'var(--bg-input)',
            border: selected ? 'none' : '2px solid var(--border-light)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 4px var(--shadow)',
          }}
        >
          {selected && <LuCheck size={12} color="var(--bg-deep)" strokeWidth={3} />}
        </div>
      )}
      {/* Positioned (to anchor the badges and audio overlay), which would paint
          it above the CardLink overlay — pointerEvents:'none' lets clicks fall
          through to the link; the audio overlay re-enables them for itself. */}
      <div
        style={{
          ...thumbStyle,
          background: 'var(--bg-deep)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          pointerEvents: bulkMode ? undefined : 'none',
        }}
      >
        {hasThumbnail ? (
          <LazyImg
            src={mediaUrl(config.thumbnailUrl(item.id))}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <PlaceholderIcon
            size={32}
            color="var(--text-muted)"
            aria-hidden="true"
            data-testid={isVideoItem ? 'video-placeholder' : 'media-placeholder'}
            style={{ opacity: 0.4 }}
          />
        )}
        {isAudio && !item.is_missing && (
          // pointerEvents: 'none' here, not 'auto' — this div only exists to
          // center the button, and 'auto' across its full inset:0 bounding
          // box turned the *entire* thumbnail into a dead zone for the
          // CardLink navigation underneath it (issue: clicking an audiobook's
          // cover art didn't open the detail page, only its title did).
          // AudioPlayer's own button re-enables pointer events on just
          // itself, so the button stays clickable at its actual visual size.
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1,
              pointerEvents: 'none',
            }}
          >
            <AudioPlayer track={track} savedFraction={savedFraction} />
          </div>
        )}
        {cornerBadges
          // In bulk mode the selection checkbox occupies the top-left corner.
          .filter((b) => !(bulkMode && b.corner === 'top-left'))
          .map((b) => (
            <div
              key={b.flag}
              style={{
                position: 'absolute',
                ...CORNER_POS[b.corner],
                zIndex: 2,
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 6,
                background: b.color,
                color: 'var(--on-media)',
                fontWeight: 600,
              }}
            >
              {t(b.labelKey || `${config.i18n}.${b.label}`)}
            </div>
          ))}
      </div>
      <div style={{ padding: config.thumb.kind === 'square' ? '8px 10px' : '10px 12px' }}>
        <div
          style={{
            fontSize: config.titleFontSize,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.title || item.filename}
        </div>
        <div
          style={{
            fontSize: config.thumb.kind === 'square' ? 12 : 13,
            color: 'var(--text-muted)',
            marginTop: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {/* Pushes the version icons to the right edge of the card, so they
              line up down a column of cards instead of starting at a ragged
              offset that depends on how long each file size renders. Icons are
              fixed-width, so the row cannot overflow the way text chips could. */}
          <span style={{ marginRight: 'auto' }}>{formatSize(item.file_size)}</span>
          {footerBadges.map((b) => (
            <VariantBadge key={b.flag} item={item} />
          ))}
        </div>
        {/* Condensed one-line status — the card is too narrow for the reset
            actions the list row gets, so this is read-only; use the list view
            or the detail page to reset progress. */}
        {hasResumableProgress && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('audiobooks.detail.progressCompact', {
              percent: chapterPercent,
              chapter: chapterLabel(effectiveCurrentChapter),
            })}
          </div>
        )}
      </div>
    </div>
  )
}
