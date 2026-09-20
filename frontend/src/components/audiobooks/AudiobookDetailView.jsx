import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LuArrowLeft,
  LuInfo,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuHeadphones,
  LuPanelRightOpen,
  LuPanelRightClose,
  LuPencil,
} from 'react-icons/lu'
// Tabler's numbered rewind/forward glyphs (bundled in the same react-icons
// install as the Lu set above, no extra dependency) rather than a bare
// LuRotateCcw/LuRotateCw: a plain curved arrow reads the same as "previous/
// next chapter" at a glance, and the user asked for the row to be clearer
// about what each button actually does. The baked-in "15" is what disambiguates
// a seek from a chapter step, so it has to be the same icon everywhere this
// action appears — see the matching swap in GlobalAudioPlayer and
// HotkeyFeedback.
import { TbRewindBackward15, TbRewindForward15 } from 'react-icons/tb'
import api, { mediaUrl } from '../../api'
import useSiblingNavigation from '../../hooks/useSiblingNavigation'
import { useAudioPlayer } from '../../context/AudioPlayerContext'
import Spinner from '../Spinner'
import { formatSize, formatDuration } from '../../utils'
import InlineTagEditor from '../maps/InlineTagEditor'
import AddToCampaignButton from '../campaigns/AddToCampaignButton'
import DetailFavoriteButton from '../DetailFavoriteButton'
import VariantPicker from '../VariantPicker'
import DownloadVersionButton from '../DownloadVersionButton'
import MetaRow from '../MetaRow'
import TagSection from '../TagSection'
import AudioPlayer from '../audio/AudioPlayer'
import AudioChapterList from '../audio/AudioChapterList'
import ArchivePlaceholder from '../media/ArchivePlaceholder'
import SiblingNavButtons from '../media/SiblingNavButtons'
import SiblingPosition from '../media/SiblingPosition'
import EditAudiobookMetadataModal from './EditAudiobookMetadataModal'
import { isArchiveMedia } from '../../constants'
import useIsMobile from '../../hooks/useIsMobile'

// Persisted the same way the app's left Sidebar remembers its own
// collapsed/expanded state (see AppShell's SIDEBAR_COLLAPSED_KEY).
const DETAILS_COLLAPSED_KEY = 'grimoire_audiobook_details_collapsed'

// Collapsed height (px) for the description block — see the "Show more"
// toggle further down.
const DESCRIPTION_COLLAPSED_HEIGHT = 250

/**
 * Mirrors AudioDetailView, with two differences: every API call and track ref
 * uses the audiobooks collection (`kind: 'audiobook'`, threaded through so the
 * shared global player streams from `/audiobooks/...` — see `apiBaseFor` in
 * AudioPlayerContext), and there is no cover-editing UI — Audiobooks v1 only
 * resolves folder/embedded artwork, read-only (no `/audiobooks/{id}/cover`
 * upload route on the backend to match).
 */
export default function AudiobookDetailView() {
  const { audiobookId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  // See MapDetailView: guests reach this view from a campaign resource row and
  // have no /audiobooks browse route to go back to (issue #361).
  const backPathRef = useRef(location.state?.from ?? null)
  // Going back is a *return* to the gallery, so it restores the filters the user
  // had rather than re-applying their saved default over them.
  const goBack = () =>
    navigate(backPathRef.current || '/audiobooks', { state: { restoreView: true } })
  const { t } = useTranslation()
  const isMobilePhone = useIsMobile(640)
  const [track, setTrack] = useState(null)
  const [editingTrackTags, setEditingTrackTags] = useState(false)
  const [editingFolderTags, setEditingFolderTags] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [editingMetadata, setEditingMetadata] = useState(false)
  // Bumped whenever a save embeds a new cover into the file, so the <img> src
  // below picks up a fresh query param and re-fetches instead of showing the
  // browser's cached copy of the old (or absent) artwork.
  const [artworkVersion, setArtworkVersion] = useState(0)
  const [detailsCollapsed, setDetailsCollapsed] = useState(
    () => localStorage.getItem(DETAILS_COLLAPSED_KEY) === 'true'
  )
  const toggleDetailsCollapsed = () =>
    setDetailsCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(DETAILS_COLLAPSED_KEY, String(next))
      } catch {}
      return next
    })
  const { isCurrent, currentTime, playTrackAt, skipBy, resetProgress } = useAudioPlayer()

  // Collapsible description (issue: Audible descriptions run several
  // paragraphs) — clamped to DESCRIPTION_COLLAPSED_HEIGHT with a "Show
  // more"/"Show less" toggle, Audible's own app being the model. The toggle
  // itself only appears when the text actually overflows that height: a
  // short description just renders in full with nothing to click. Measured
  // via scrollHeight (unaffected by the clamp's overflow:hidden, so it stays
  // accurate whether currently expanded or collapsed) rather than guessed
  // from character count, which would be wrong for a description packed with
  // short paragraphs/line breaks.
  const descriptionRef = useRef(null)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [descriptionOverflows, setDescriptionOverflows] = useState(false)
  useEffect(() => {
    setDescriptionExpanded(false)
    const el = descriptionRef.current
    setDescriptionOverflows(!!el && el.scrollHeight > DESCRIPTION_COLLAPSED_HEIGHT)
  }, [track?.description])

  const audiobookDetailPath = useCallback((id) => `/audiobooks/${id}`, [])
  const {
    siblings,
    index: siblingIdx,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
  } = useSiblingNavigation({
    item: track,
    id: audiobookId,
    listUrl: '/audiobooks',
    listKey: 'audiobooks',
    detailPath: audiobookDetailPath,
    navigate,
    get: api.get,
  })
  // Left/Right here are the ±15s skip keys (useAudiobookSkipKeys, mounted once
  // in AppShell) instead of the sibling prev/next that other detail views bind
  // via useArrowKeyNavigation — switching books uses the on-screen buttons below.
  useEffect(() => {
    api.get(`/audiobooks/${audiobookId}`).then(setTrack)
  }, [audiobookId])

  if (!track)
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spinner size={32} />
      </div>
    )

  const folder = (() => {
    const parts = (track.relative_path || '').replace(/\\/g, '/').split('/')
    const dirParts = parts.slice(1, -1)
    return dirParts.length > 0 ? dirParts.join(' / ') : null
  })()

  const currentFolderTags = track.folder_tags ?? []
  const isArchive = isArchiveMedia(track)

  // Chapter step buttons flanking the play control (see AudioChapterList for
  // the full list). Computed from this track's own data rather than the
  // player context's current-track chapters, since this page can be open on
  // a track that isn't the one actually playing in the background — the
  // buttons must always act on *this* track, starting it via playTrackAt if
  // it isn't loaded yet.
  const chapters = track.chapters || []
  const hasChapters = chapters.length > 0
  const isPlayingThis = isCurrent(audiobookId)
  // While this book is the one actually loaded in the player, its live
  // currentTime is the more accurate "where you are" than the position last
  // saved to the server (which trails by up to the ~15s save interval).
  // Otherwise fall back to the saved position from this page's own fetch.
  const displayProgress = isPlayingThis ? currentTime : track.progress_seconds || 0
  const hasResumableProgress =
    track.duration > 0 && displayProgress > 3 && displayProgress < track.duration - 3
  const activeChapterIdx = isPlayingThis
    ? chapters.findIndex((c) => currentTime >= c.start && currentTime < c.end)
    : -1
  const chapterTrackRef = {
    id: audiobookId,
    title: track.title || track.filename,
    artwork: track.has_artwork,
    kind: 'audiobook',
  }

  const onPrevChapter = () => {
    if (!hasChapters) return
    const from = activeChapterIdx < 0 ? 0 : activeChapterIdx
    // Mirrors the global player's prev(): more than ~3s into the current
    // chapter restarts it, otherwise steps to the one before it.
    if (isPlayingThis && currentTime - chapters[from].start > 3) {
      playTrackAt(chapterTrackRef, chapters[from].start)
    } else if (from > 0) {
      playTrackAt(chapterTrackRef, chapters[from - 1].start)
    } else {
      playTrackAt(chapterTrackRef, chapters[0].start)
    }
  }

  const onNextChapter = () => {
    if (!hasChapters) return
    const from = activeChapterIdx < 0 ? -1 : activeChapterIdx
    if (from < chapters.length - 1) playTrackAt(chapterTrackRef, chapters[from + 1].start)
  }

  // Relative ±15s skip. Deliberately not context's raw skipBy while this
  // track isn't the one actually playing — skipBy jumps whatever is live in
  // the background, which would silently mangle a *different* track's
  // position. Falls back to starting this one from the top instead.
  const onSkipBack15 = () => (isPlayingThis ? skipBy(-15) : playTrackAt(chapterTrackRef, 0))
  const onSkipForward15 = () => (isPlayingThis ? skipBy(15) : playTrackAt(chapterTrackRef, 0))

  const chapterButtonStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    flexShrink: 0,
  }

  const markNotStarted = async () => {
    await resetProgress(audiobookId)
    setTrack((t) => ({ ...t, progress_seconds: null }))
  }

  const saveTrackTags = async (tags) => {
    await api.patch(`/audiobooks/${audiobookId}`, { tags })
    setTrack({ ...track, tags })
    setEditingTrackTags(false)
  }

  const saveFolderTags = async (tags) => {
    await api.patch('/audiobook-folders', { path: track.folder_path, tags })
    setTrack({ ...track, folder_tags: tags })
    setEditingFolderTags(false)
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 20px',
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={goBack}
          aria-label={t('audiobooks.detail.back')}
          style={{
            background: 'none',
            color: 'var(--text-dim)',
            fontSize: 15,
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <LuArrowLeft size={15} /> {!isMobilePhone && t('common.back')}
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <span
          style={{
            fontSize: 16,
            fontWeight: 500,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {track.title || track.filename}
        </span>
        <SiblingPosition
          index={siblingIdx}
          total={siblings.length}
          label={t('audiobooks.detail.position', {
            current: siblingIdx + 1,
            total: siblings.length,
          })}
        />
        {isMobilePhone && (
          <button
            onClick={() => setShowDetails((v) => !v)}
            title={t('audiobooks.detail.details')}
            style={{
              background: showDetails ? 'var(--bg-card-hover)' : 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: showDetails ? 'var(--gold)' : 'var(--text-dim)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 14,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              cursor: 'pointer',
            }}
          >
            <LuInfo size={13} />
            <LuChevronDown
              size={11}
              style={{
                transform: showDetails ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s',
              }}
            />
          </button>
        )}
        <VariantPicker item={track} detailPath={(id) => `/audiobooks/${id}`} compact />
        <DetailFavoriteButton type="audiobook" id={audiobookId} compact={isMobilePhone} />
        <AddToCampaignButton resourceType="audiobook" resourceId={audiobookId} />
        <DownloadVersionButton
          type="audiobooks"
          id={audiobookId}
          item={track}
          compact={isMobilePhone}
        />
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: isMobilePhone ? 'column' : 'row',
        }}
      >
        {/* Player / archive pane */}
        {isArchive ? (
          <ArchivePlaceholder fileUrl={`/audiobooks/${audiobookId}/file`} filename={track.filename} />
        ) : (
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              background: 'var(--bg-deep)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 24,
              padding: 24,
              // Anchors the overlay prev/next arrows.
              position: 'relative',
            }}
          >
            <SiblingNavButtons
              hasPrev={hasPrev}
              hasNext={hasNext}
              onPrev={onPrev}
              onNext={onNext}
              prevLabel={t('audiobooks.detail.previous')}
              nextLabel={t('audiobooks.detail.next')}
            />
            <div
              style={{
                // Much bigger than the old fixed 360px cap, which left a lot
                // of dead space on larger screens — still bounded by both
                // viewport dimensions (not just width) so it can't push the
                // transport controls below it off-screen on a short window.
                width: 'min(900px, 85vw, 78vh)',
                aspectRatio: '1/1',
                borderRadius: 8,
                overflow: 'hidden',
                background: 'var(--bg-card)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 24px var(--overlay)',
              }}
            >
              {track.has_artwork ? (
                <img
                  src={mediaUrl(
                    `/audiobooks/${audiobookId}/artwork`,
                    artworkVersion ? { v: artworkVersion } : {}
                  )}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <LuHeadphones size={160} color="var(--text-muted)" style={{ opacity: 0.4 }} />
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {hasChapters && (
                <button
                  type="button"
                  onClick={onSkipBack15}
                  aria-label={t('audio.player.skipBack15')}
                  title={t('audio.player.skipBack15')}
                  style={chapterButtonStyle}
                >
                  <TbRewindBackward15 size={18} />
                </button>
              )}
              {hasChapters && (
                <button
                  type="button"
                  onClick={onPrevChapter}
                  aria-label={t('audio.player.previousChapter')}
                  title={t('audio.player.previousChapter')}
                  style={chapterButtonStyle}
                >
                  <LuChevronLeft size={16} />
                </button>
              )}
              {/* No showPlayNext here: "add to queue" makes little sense for
                  the one audiobook you already have open, and the global
                  player bar's own queue-list toggle already covers it — a
                  second queue-shaped control here was just noise. */}
              <AudioPlayer
                track={{
                  id: audiobookId,
                  title: track.title || track.filename,
                  artwork: track.has_artwork,
                  kind: 'audiobook',
                }}
                size={56}
              />
              {hasChapters && (
                <button
                  type="button"
                  onClick={onNextChapter}
                  aria-label={t('audio.player.nextChapter')}
                  title={t('audio.player.nextChapter')}
                  style={chapterButtonStyle}
                >
                  <LuChevronRight size={16} />
                </button>
              )}
              {hasChapters && (
                <button
                  type="button"
                  onClick={onSkipForward15}
                  aria-label={t('audio.player.skipForward15')}
                  title={t('audio.player.skipForward15')}
                  style={chapterButtonStyle}
                >
                  <TbRewindForward15 size={18} />
                </button>
              )}
            </div>
            {hasResumableProgress && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13,
                  color: 'var(--text-muted)',
                }}
              >
                <span>
                  {t('audiobooks.detail.continueFrom', { time: formatDuration(displayProgress) })}
                </span>
                <button
                  type="button"
                  onClick={markNotStarted}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--gold)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  {t('audiobooks.detail.markNotStarted')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Metadata sidebar — collapsible on desktop like the app's left
            Sidebar (see DETAILS_COLLAPSED_KEY); on a phone it's already a
            toggleable drawer via the Details button in the toolbar, so the
            collapse control below only renders for the wider layout. */}
        <div
          style={{
            ...(isMobilePhone
              ? {
                  display: showDetails ? 'flex' : 'none',
                  width: '100%',
                  borderTop: '1px solid var(--border)',
                  maxHeight: '50vh',
                }
              : {
                  // 400 (was 280) so a book's description has room to read as
                  // paragraphs instead of a cramped, heavily-wrapped column —
                  // see the description block below.
                  width: detailsCollapsed ? 44 : 400,
                  flexShrink: 0,
                  borderLeft: '1px solid var(--border)',
                  transition: 'width 0.15s ease',
                }),
            background: 'var(--bg-panel)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {!isMobilePhone && (
            <div
              style={{
                display: 'flex',
                // Flush with the pane's own left edge (the shared border with
                // the player pane) when open, same as the left Sidebar's own
                // toggle sits at ITS boundary with the main content — centered
                // once collapsed, since the pane is just a slim strip then.
                justifyContent: detailsCollapsed ? 'center' : 'flex-start',
                padding: '8px 8px 0',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={toggleDetailsCollapsed}
                title={
                  detailsCollapsed
                    ? t('audiobooks.detail.expandDetails')
                    : t('audiobooks.detail.collapseDetails')
                }
                aria-label={
                  detailsCollapsed
                    ? t('audiobooks.detail.expandDetails')
                    : t('audiobooks.detail.collapseDetails')
                }
                aria-expanded={!detailsCollapsed}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: 'none',
                  background: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {detailsCollapsed ? (
                  <LuPanelRightOpen size={16} />
                ) : (
                  <LuPanelRightClose size={16} />
                )}
              </button>
            </div>
          )}

          {(!detailsCollapsed || isMobilePhone) && (
            <div style={{ padding: '4px 20px 24px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 20,
            }}
          >
            <h3 style={{ fontSize: 15, margin: 0 }}>{t('audiobooks.detail.title')}</h3>
            <button
              type="button"
              onClick={() => setEditingMetadata(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                padding: '4px 9px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-dim)',
                cursor: 'pointer',
              }}
            >
              <LuPencil size={12} /> {t('audiobooks.metadata.editButton')}
            </button>
          </div>

          {folder && <MetaRow label={t('audiobooks.detail.location')} value={folder} />}
          {track.title && (
            <MetaRow label={t('audiobooks.detail.trackTitle')} value={track.title} />
          )}
          {/* Curated fields (Edit Metadata pane) take precedence for display;
              the raw artist/album mirror below only fills in for whichever of
              author/series hasn't been curated yet. */}
          {track.author ? (
            <MetaRow label={t('audiobooks.metadata.authorLabel')} value={track.author} />
          ) : (
            track.artist && <MetaRow label={t('audiobooks.detail.artist')} value={track.artist} />
          )}
          {track.narrator && (
            <MetaRow label={t('audiobooks.metadata.narratorLabel')} value={track.narrator} />
          )}
          {track.series ? (
            <MetaRow
              label={t('audiobooks.metadata.seriesLabel')}
              value={track.series_index != null ? `${track.series} #${track.series_index}` : track.series}
            />
          ) : (
            track.album && <MetaRow label={t('audiobooks.detail.album')} value={track.album} />
          )}
          {track.year && <MetaRow label={t('audiobooks.metadata.yearLabel')} value={String(track.year)} />}
          {track.genres?.length > 0 && (
            <MetaRow label={t('audiobooks.metadata.genresLabel')} value={track.genres.join(', ')} />
          )}
          {track.description && (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  marginBottom: 3,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {t('audiobooks.metadata.descriptionLabel')}
              </div>
              {/* pre-wrap, not a MetaRow: the description is multi-paragraph
                  prose (blank-line-separated, same as the edit textarea),
                  which MetaRow's single-line value styling isn't meant for. */}
              <div
                ref={descriptionRef}
                style={{
                  fontSize: 14,
                  color: 'var(--text)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  maxHeight: descriptionExpanded ? 'none' : DESCRIPTION_COLLAPSED_HEIGHT,
                  overflow: 'hidden',
                }}
              >
                {track.description}
              </div>
              {descriptionOverflows && (
                <button
                  type="button"
                  onClick={() => setDescriptionExpanded((v) => !v)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    marginTop: 8,
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: 'var(--gold)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {descriptionExpanded ? t('audiobooks.detail.showLess') : t('audiobooks.detail.showMore')}
                  <LuChevronDown
                    size={13}
                    style={{
                      transform: descriptionExpanded ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.15s ease',
                    }}
                  />
                </button>
              )}
            </div>
          )}
          {track.duration > 0 && (
            <MetaRow
              label={t('audiobooks.detail.duration')}
              value={formatDuration(track.duration)}
            />
          )}
          <MetaRow label={t('audiobooks.detail.fileSize')} value={formatSize(track.file_size)} />

          <AudioChapterList track={track} kind="audiobook" />

          {/* Folder tags */}
          {folder &&
            (editingFolderTags ? (
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
                  {t('audiobooks.detail.folderTags')}
                </div>
                <InlineTagEditor
                  tags={currentFolderTags}
                  onSave={saveFolderTags}
                  onCancel={() => setEditingFolderTags(false)}
                  resourceType="audiobook"
                />
              </div>
            ) : (
              <TagSection
                label={t('audiobooks.detail.folderTags')}
                tags={currentFolderTags}
                canEdit={true}
                onEdit={() => setEditingFolderTags(true)}
                editLabel={t('audiobooks.detail.editTags')}
                noTagsLabel={t('audiobooks.detail.noTags')}
              />
            ))}

          {/* Track tags */}
          {editingTrackTags ? (
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
                {t('audiobooks.detail.trackTags')}
              </div>
              <InlineTagEditor
                tags={track.tags}
                onSave={saveTrackTags}
                onCancel={() => setEditingTrackTags(false)}
                resourceType="audiobook"
              />
            </div>
          ) : (
            <TagSection
              label={t('audiobooks.detail.trackTags')}
              tags={track.tags}
              canEdit
              onEdit={() => setEditingTrackTags(true)}
              editLabel={t('audiobooks.detail.editTags')}
              noTagsLabel={t('audiobooks.detail.noTags')}
            />
          )}
            </div>
          )}
        </div>
      </div>

      {editingMetadata && (
        <EditAudiobookMetadataModal
          audiobookId={audiobookId}
          track={track}
          onClose={() => setEditingMetadata(false)}
          onSaved={(updated) => {
            setTrack((t) => ({ ...t, ...updated }))
            if (updated?.has_artwork) setArtworkVersion((v) => v + 1)
            setEditingMetadata(false)
          }}
          onConverted={(newAudiobookId) => {
            setEditingMetadata(false)
            navigate(`/audiobooks/${newAudiobookId}`)
          }}
          onChaptersApplied={() => {
            api.get(`/audiobooks/${audiobookId}`).then(setTrack)
          }}
        />
      )}
    </div>
  )
}
