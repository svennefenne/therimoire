import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LuX, LuSearch, LuCheck, LuFileAudio, LuPlay } from 'react-icons/lu'
import api from '../../api'
import GenrePicker from '../metadata/GenrePicker'
import Spinner from '../Spinner'
import { useAudioPlayer } from '../../context/AudioPlayerContext'

const isMp3 = (filename) => /\.mp3$/i.test(filename || '')

// i18n key per source, for the small badge shown on each search result — see
// services/metadata_lookup.py on the backend for what each source
// contributes. Falls back to the raw source string for one the frontend
// doesn't recognize yet, so a new backend source never renders blank.
const SOURCE_LABEL_KEYS = {
  audible: 'audiobooks.metadata.sourceAudible',
  audnexus: 'audiobooks.metadata.sourceAudnexus',
  itunes: 'audiobooks.metadata.sourceItunes',
  google_books: 'audiobooks.metadata.sourceGoogleBooks',
  open_library: 'audiobooks.metadata.sourceOpenLibrary',
}

// A stable identity for a search result across every source: `asin` alone
// used to double as the key, but non-Audible sources leave it blank, which
// would collide every one of their candidates onto the same key/highlight.
// `source_id` (always populated — see _schemas.py's AudibleCandidate) plus
// `source` disambiguates properly; title is a last-resort fallback for a
// malformed candidate missing both.
const candidateKey = (c) => `${c.source || 'audible'}:${c.source_id || c.asin || c.title}`

/**
 * Edit an audiobook's curated metadata (title/author/narrator/series/series
 * index/year/genres/description), with an optional metadata-lookup panel
 * that searches Audible, Audnexus, iTunes, Google Books, and Open Library
 * (see services/metadata_lookup.py) and lets a result be applied to the form
 * (and, for its cover, embedded into the file) in one Save.
 *
 * Saving writes to Grimoire's database *and* into the file's own tags (best-
 * effort — see the PATCH /audiobooks/{id} description) so the metadata
 * travels with the file rather than living only in Grimoire.
 *
 * For an mp3 item, this also offers converting it to a chaptered .m4b (see
 * services/audiobook_convert on the backend): alone, chapters come from its
 * own ID3 chapter frames if it has any, else a fixed-length split; picked
 * alongside sibling mp3s from the same folder, they're joined into one m4b
 * with a chapter per file — the common shape for an audiobook bought as one
 * mp3 per chapter, which otherwise shows up as several separate library
 * items. `onConverted(newAudiobookId)` is called on success so the caller can
 * navigate to the freshly created item.
 *
 * For an m4a/m4b item, this also offers detecting chapters by listening for
 * spoken "Chapter N" markers in the audio itself (see
 * services/audiobook_chapter_detect on the backend) — for a file with no
 * chapter data of any kind, typically a single mp3 converted straight to m4b
 * with no ID3 chapter frames to carry over. Runs as a background job the same
 * way conversion does; unless "apply automatically" is checked, the result is
 * a reviewable, editable list rather than an immediate save.
 * `onChaptersApplied()` is called after a successful apply (automatic or
 * reviewed) so the caller can refetch the item's chapters.
 */
export default function EditAudiobookMetadataModal({
  audiobookId,
  track,
  onClose,
  onSaved,
  onConverted,
  onChaptersApplied,
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState({
    title: track.title || '',
    author: track.author || '',
    narrator: track.narrator || '',
    series: track.series || '',
    series_index: track.series_index ?? '',
    year: track.year ?? '',
    genres: track.genres || [],
    description: track.description || '',
  })
  const setField = (field, value) => setDraft((d) => ({ ...d, [field]: value }))

  const [genreTree, setGenreTree] = useState([])
  useEffect(() => {
    api
      .get('/genres')
      .then((r) => setGenreTree(r.genres || []))
      .catch(() => setGenreTree([]))
  }, [])

  const defaultQuery = useMemo(
    () => track.title || track.filename?.replace(/\.[^.]+$/, '') || '',
    [track.title, track.filename]
  )
  const [query, setQuery] = useState(defaultQuery)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [results, setResults] = useState(null)
  const [pickedKey, setPickedKey] = useState(null)
  const [pickedCoverUrl, setPickedCoverUrl] = useState(null)

  const runSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchError(null)
    try {
      const data = await api.get(
        `/audiobooks/${audiobookId}/metadata-lookup?query=${encodeURIComponent(q)}`
      )
      setResults(data.results || [])
    } catch (err) {
      setSearchError(err.message)
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const applyCandidate = (c) => {
    setDraft((d) => ({
      ...d,
      title: c.title || d.title,
      author: c.authors?.length ? c.authors.join(', ') : d.author,
      narrator: c.narrators?.length ? c.narrators.join(', ') : d.narrator,
      series: c.series || d.series,
      series_index: c.series_index ?? d.series_index,
      year: c.year ?? d.year,
      genres: c.genres?.length ? c.genres : d.genres,
      description: c.description || d.description,
    }))
    setPickedKey(candidateKey(c))
    setPickedCoverUrl(c.cover_url || null)
  }

  // Shared by save() and applyMetadataToConverted() below — the join-then-
  // convert flow needs the exact same draft-to-payload shape, just aimed at
  // a different id.
  const buildMetadataPayload = () => {
    const payload = {
      title: draft.title.trim(),
      author: draft.author.trim(),
      narrator: draft.narrator.trim(),
      series: draft.series.trim(),
      series_index: draft.series_index === '' ? null : parseFloat(draft.series_index),
      year: draft.year === '' ? null : parseInt(draft.year, 10),
      genres: draft.genres,
      description: draft.description,
    }
    // null values are dropped by the backend's exclude_none, i.e. left
    // untouched rather than cleared — matches how the field started (a
    // blank series_index/year here just means "don't send it").
    Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k])
    return payload
  }

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const save = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const payload = buildMetadataPayload()
      await api.patch(`/audiobooks/${audiobookId}`, payload)
      if (pickedCoverUrl) {
        // Best-effort: a failed cover fetch shouldn't lose the metadata that
        // already saved successfully above.
        try {
          await api.post(`/audiobooks/${audiobookId}/artwork/from-url`, { url: pickedCoverUrl })
        } catch (err) {
          setSaveError(t('audiobooks.metadata.coverSaveFailed', { error: err.message }))
        }
      }
      onSaved({ ...payload, has_artwork: pickedCoverUrl ? true : track.has_artwork })
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // --- Convert to chaptered M4B (mp3 sources only) ---------------------------
  const convertible = isMp3(track.filename)
  const [siblings, setSiblings] = useState([])
  const [selectedSiblingIds, setSelectedSiblingIds] = useState([])
  const [chapterMinutes, setChapterMinutes] = useState('')
  const [destFilename, setDestFilename] = useState('')
  const [bitrateKbps, setBitrateKbps] = useState('64')
  const [deleteSources, setDeleteSources] = useState(false)
  const [converting, setConverting] = useState(false)
  const [convertError, setConvertError] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    if (!convertible) return
    api
      .get(`/audiobooks/${audiobookId}/convertible-siblings`)
      .then((r) => setSiblings(r.siblings || []))
      .catch(() => setSiblings([]))
    return () => clearTimeout(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audiobookId])

  const toggleSibling = (id) =>
    setSelectedSiblingIds((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]))

  // "Select all" for the join list — with a book split into many mp3s
  // (one per chapter), checking each sibling by hand is tedious. Shows an
  // indeterminate dash when some but not all are selected, and toggles
  // between all-selected and none.
  const allSiblingsSelected = siblings.length > 0 && selectedSiblingIds.length === siblings.length
  const selectAllRef = useRef(null)
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedSiblingIds.length > 0 && selectedSiblingIds.length < siblings.length
    }
  }, [selectedSiblingIds, siblings])
  const toggleAllSiblings = () =>
    setSelectedSiblingIds(allSiblingsSelected ? [] : siblings.map((s) => s.id))

  const isJoin = selectedSiblingIds.length > 0

  // Converting produces a brand-new item at a new id — if the user searched
  // metadata and picked a candidate here first (setting pickedKey) rather
  // than clicking Save on the pre-conversion source, that picked metadata
  // only ever existed in `draft`; nothing wrote it anywhere. Without this,
  // the new item would come out with none of it, and the user would have to
  // reopen Edit Metadata on the new item and redo the whole search. Applied
  // best-effort: the conversion already succeeded and produced a perfectly
  // good file, so a failure here is surfaced but doesn't block navigating to
  // it (see the catch in pollConversion below, which still calls onConverted).
  const applyMetadataToConverted = async (newId) => {
    try {
      await api.patch(`/audiobooks/${newId}`, buildMetadataPayload())
      if (pickedCoverUrl) {
        await api.post(`/audiobooks/${newId}/artwork/from-url`, { url: pickedCoverUrl })
      }
    } catch (err) {
      setConvertError(t('audiobooks.metadata.convertMetadataApplyFailed', { error: err.message }))
    }
  }

  const pollConversion = (jobId) => {
    pollRef.current = setTimeout(async () => {
      try {
        const status = await api.get(`/audiobooks/convert-to-m4b/${jobId}`)
        if (status.status === 'running') {
          pollConversion(jobId)
          return
        }
        setConverting(false)
        if (status.status === 'error') {
          setConvertError(status.error || t('audiobooks.metadata.convertFailed'))
        } else if (status.audiobook_id) {
          if (pickedKey) {
            await applyMetadataToConverted(status.audiobook_id)
          }
          onConverted(status.audiobook_id)
        }
      } catch (err) {
        setConverting(false)
        setConvertError(err.message)
      }
    }, 2000)
  }

  const startConversion = async () => {
    if (converting) return
    setConverting(true)
    setConvertError(null)
    try {
      // Join order follows filename, the convention chapter-per-file rips are
      // numbered by — the current item is always included alongside whichever
      // siblings were checked.
      const ordered = [{ id: audiobookId, filename: track.filename }, ...siblings]
        .filter((c) => c.id === audiobookId || selectedSiblingIds.includes(c.id))
        .sort((a, b) => a.filename.localeCompare(b.filename))
      const { job_id: jobId } = await api.post('/audiobooks/convert-to-m4b', {
        audiobook_ids: ordered.map((c) => c.id),
        chapter_minutes: !isJoin && chapterMinutes ? parseInt(chapterMinutes, 10) : null,
        bitrate_kbps: parseInt(bitrateKbps, 10),
        delete_sources: deleteSources,
        // Only meaningful for a join — left unset otherwise so the backend's
        // own default (the source file's own name) still applies. Blank
        // means "use the book's name", which the backend derives from the
        // shared folder/album — see convert_audiobooks_to_m4b.
        dest_filename: isJoin && destFilename.trim() ? destFilename.trim() : null,
      })
      pollConversion(jobId)
    } catch (err) {
      setConverting(false)
      setConvertError(err.message)
    }
  }

  // --- Detect chapters from spoken markers (m4a/m4b only) --------------------
  const isChapterCapable = /\.(m4a|m4b)$/i.test(track.filename)
  const { playTrackAt, isCurrent } = useAudioPlayer()
  // Which proposed row's preview button was last clicked, purely so the row
  // can show it's the one currently playing — this doesn't track the global
  // player's position, so it stops being accurate the moment a *different*
  // track starts playing in the background instead.
  const [previewingKey, setPreviewingKey] = useState(null)
  const previewChapter = (c) => {
    // Parsed fresh from the live text field rather than c.start, so clicking
    // Preview right after typing a new time (before the field has blurred
    // and committed) still jumps to what's actually shown.
    const start = parseTimestamp(c._startText) ?? c.start
    playTrackAt(
      { id: audiobookId, title: track.title || track.filename, artwork: track.has_artwork, kind: 'audiobook' },
      start
    )
    setPreviewingKey(c._key)
  }
  const [detecting, setDetecting] = useState(false)
  const [detectProgress, setDetectProgress] = useState(null)
  const [detectError, setDetectError] = useState(null)
  const [detectAutoApply, setDetectAutoApply] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [detectNoiseDb, setDetectNoiseDb] = useState('-30')
  const [detectMinDuration, setDetectMinDuration] = useState('1.2')
  // Detected chapters, PLUS any the user adds/edits by hand in the review
  // list — a produced audiobook with music/sound design between chapters can
  // leave real gaps in a purely audio-detected list (some transitions never
  // dip below the silence threshold at all), so the review step needs to be
  // a genuine editor, not just an accept/reject list.
  const [proposedChapters, setProposedChapters] = useState(null)
  const [chaptersApplied, setChaptersApplied] = useState(false)
  const [applyingChapters, setApplyingChapters] = useState(false)
  const [applyError, setApplyError] = useState(null)
  const detectPollRef = useRef(null)
  // Negative, decrementing keys for hand-added rows so they never collide
  // with the 0..n-1 keys detection results are seeded with.
  const nextManualKeyRef = useRef(-1)

  useEffect(() => () => clearTimeout(detectPollRef.current), [])

  const formatChapterTimestamp = (seconds) => {
    const s = Math.max(0, Math.round(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`
  }

  // "1:23:45" / "83:45" / "5025" / "5025.5" -> seconds. null for anything
  // that isn't one of those shapes, so an in-progress edit (or a typo) can be
  // told apart from a deliberately-entered value.
  const parseTimestamp = (raw) => {
    const s = String(raw ?? '').trim()
    if (!s) return null
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)
    const parts = s.split(':').map((p) => p.trim())
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
      return null
    }
    const nums = parts.map(Number)
    return nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1]
  }

  const pollDetection = (jobId) => {
    detectPollRef.current = setTimeout(async () => {
      try {
        const status = await api.get(`/audiobooks/chapters/detect/${jobId}`)
        if (status.status === 'running') {
          setDetectProgress({ done: status.done || 0, total: status.total || 0 })
          pollDetection(jobId)
          return
        }
        setDetecting(false)
        if (status.status === 'error') {
          setDetectError(status.error || t('audiobooks.metadata.detectChaptersFailed'))
        } else if (status.status === 'cancelled') {
          setDetectError(t('audiobooks.metadata.detectChaptersCancelled'))
        } else if (status.status === 'done') {
          if (status.applied) {
            setChaptersApplied(true)
            onChaptersApplied?.()
          } else {
            setProposedChapters(
              (status.chapters || []).map((c, i) => ({
                ...c,
                _key: i,
                _startText: formatChapterTimestamp(c.start),
              }))
            )
          }
        }
      } catch (err) {
        setDetecting(false)
        setDetectError(err.message)
      }
    }, 2000)
  }

  const startDetection = async () => {
    if (detecting) return
    setDetecting(true)
    setDetectError(null)
    setDetectProgress(null)
    setProposedChapters(null)
    setChaptersApplied(false)
    try {
      const { job_id: jobId } = await api.post(`/audiobooks/${audiobookId}/chapters/detect`, {
        auto_apply: detectAutoApply,
        noise_db: parseFloat(detectNoiseDb) || -30,
        min_duration: Math.max(0.2, parseFloat(detectMinDuration) || 1.2),
      })
      pollDetection(jobId)
    } catch (err) {
      setDetecting(false)
      setDetectError(err.message)
    }
  }

  const updateProposedField = (key, field, value) =>
    setProposedChapters((list) => list.map((c) => (c._key === key ? { ...c, [field]: value } : c)))
  // Reparses the timestamp text on blur rather than every keystroke, so
  // typing "1:23" doesn't get clobbered mid-edit by an intermediate parse —
  // an unparseable value just snaps back to the last good one.
  const normalizeProposedTimestamp = (key) =>
    setProposedChapters((list) =>
      list.map((c) => {
        if (c._key !== key) return c
        const start = parseTimestamp(c._startText) ?? c.start
        return { ...c, start, _startText: formatChapterTimestamp(start) }
      })
    )
  const removeProposedChapter = (key) =>
    setProposedChapters((list) => list.filter((c) => c._key !== key))
  const addProposedChapter = () =>
    setProposedChapters((list) => {
      const rows = list || []
      const start = rows.length ? Math.max(...rows.map((c) => c.start)) + 60 : 0
      const key = nextManualKeyRef.current--
      return [
        ...rows,
        { _key: key, title: '', start, end: start, sample_text: '', _startText: formatChapterTimestamp(start) },
      ]
    })
  const discardProposedChapters = () => setProposedChapters(null)

  // Chapter end times aren't edited directly — they're always "the next
  // chapter's start" (or the book's duration, for the last one), rederived
  // here so adding/reordering/retiming a row can never leave a stale `end`
  // behind. A row with a blank title (an unfinished manual add) is dropped.
  const validProposedCount = (proposedChapters || []).filter((c) => c.title.trim()).length
  const buildChaptersForApply = () => {
    const rows = (proposedChapters || [])
      .filter((c) => c.title.trim())
      .sort((a, b) => a.start - b.start)
    return rows.map((c, i) => ({
      title: c.title.trim(),
      start: c.start,
      end: i + 1 < rows.length ? rows[i + 1].start : track.duration || c.start,
    }))
  }

  const applyProposedChapters = async () => {
    if (validProposedCount === 0 || applyingChapters) return
    setApplyingChapters(true)
    setApplyError(null)
    try {
      await api.put(`/audiobooks/${audiobookId}/chapters`, { chapters: buildChaptersForApply() })
      setChaptersApplied(true)
      setProposedChapters(null)
      onChaptersApplied?.()
    } catch (err) {
      setApplyError(err.message)
    } finally {
      setApplyingChapters(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={overlay}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={panel}>
        <div style={header}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{t('audiobooks.metadata.editTitle')}</span>
          <button onClick={onClose} style={closeBtn} aria-label={t('common.close')}>
            <LuX size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {/* Form */}
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            <label style={label}>{t('audiobooks.metadata.titleLabel')}</label>
            <input
              style={input}
              value={draft.title}
              onChange={(e) => setField('title', e.target.value)}
            />

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>{t('audiobooks.metadata.authorLabel')}</label>
                <input
                  style={input}
                  value={draft.author}
                  onChange={(e) => setField('author', e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>{t('audiobooks.metadata.narratorLabel')}</label>
                <input
                  style={input}
                  value={draft.narrator}
                  onChange={(e) => setField('narrator', e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 2 }}>
                <label style={label}>{t('audiobooks.metadata.seriesLabel')}</label>
                <input
                  style={input}
                  value={draft.series}
                  onChange={(e) => setField('series', e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>{t('audiobooks.metadata.seriesIndexLabel')}</label>
                <input
                  style={input}
                  type="number"
                  step="0.5"
                  value={draft.series_index}
                  onChange={(e) => setField('series_index', e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>{t('audiobooks.metadata.yearLabel')}</label>
                <input
                  style={input}
                  type="number"
                  value={draft.year}
                  onChange={(e) => setField('year', e.target.value)}
                />
              </div>
            </div>

            <label style={label}>{t('audiobooks.metadata.genresLabel')}</label>
            <div style={{ marginBottom: 12 }}>
              <GenrePicker
                genreTree={genreTree}
                selected={draft.genres}
                onChange={(g) => setField('genres', g)}
              />
            </div>

            <label style={label}>{t('audiobooks.metadata.descriptionLabel')}</label>
            <textarea
              style={{ ...input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
              value={draft.description}
              onChange={(e) => setField('description', e.target.value)}
            />
          </div>

          {/* Audible lookup */}
          <div style={{ flex: '1 1 280px', minWidth: 260 }}>
            <label style={label}>{t('audiobooks.metadata.audibleSearchLabel')}</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                style={{ ...input, flex: 1 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), runSearch())}
                placeholder={t('audiobooks.metadata.audibleSearchPlaceholder')}
              />
              <button
                type="button"
                onClick={runSearch}
                disabled={searching || !query.trim()}
                style={{ ...cancelBtn, padding: '0 12px', opacity: searching ? 0.6 : 1 }}
                aria-label={t('audiobooks.metadata.audibleSearchButton')}
              >
                {searching ? <Spinner size={15} /> : <LuSearch size={15} />}
              </button>
            </div>

            {searchError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>
                {t('audiobooks.metadata.audibleSearchFailed', { error: searchError })}
              </div>
            )}

            <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {results === null && !searching && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('audiobooks.metadata.audibleSearchHint')}
                </p>
              )}
              {results && results.length === 0 && !searching && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('audiobooks.metadata.audibleNoResults')}
                </p>
              )}
              {(results || []).map((c) => {
                const key = candidateKey(c)
                const picked = pickedKey === key
                return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyCandidate(c)}
                  style={{
                    display: 'flex',
                    gap: 10,
                    textAlign: 'left',
                    padding: 8,
                    borderRadius: 8,
                    border: picked ? '1px solid var(--gold)' : '1px solid var(--border)',
                    background: picked ? 'var(--bg-card-hover)' : 'var(--bg-card)',
                    cursor: 'pointer',
                    color: 'var(--text)',
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 4,
                      overflow: 'hidden',
                      flexShrink: 0,
                      background: 'var(--bg-deep)',
                    }}
                  >
                    {c.cover_url && (
                      <img
                        src={c.cover_url}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {c.title}
                      </div>
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--text-muted)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: '1px 5px',
                          flexShrink: 0,
                        }}
                      >
                        {t(SOURCE_LABEL_KEYS[c.source] || c.source)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {[c.authors?.join(', '), c.narrators?.length && `${t('audiobooks.metadata.narratedBy')} ${c.narrators.join(', ')}`]
                        .filter(Boolean)
                        .join(' — ')}
                    </div>
                    {c.series && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {c.series}
                        {c.series_index != null ? ` #${c.series_index}` : ''}
                      </div>
                    )}
                  </div>
                  {picked && (
                    <LuCheck size={16} color="var(--gold)" style={{ flexShrink: 0, alignSelf: 'center' }} />
                  )}
                </button>
                )
              })}
            </div>
            {pickedCoverUrl && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                {t('audiobooks.metadata.coverWillBeApplied')}
              </p>
            )}
          </div>
        </div>

        {convertible && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <LuFileAudio size={14} color="var(--text-muted)" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {t('audiobooks.metadata.convertTitle')}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              {t('audiobooks.metadata.convertHint')}
            </p>

            {siblings.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 10,
                    marginBottom: 6,
                  }}
                >
                  <label style={{ ...label, margin: 0 }}>{t('audiobooks.metadata.convertJoinLabel')}</label>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSiblingsSelected}
                      onChange={toggleAllSiblings}
                    />
                    {t('audiobooks.metadata.convertSelectAll')}
                  </label>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    maxHeight: 140,
                    overflowY: 'auto',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 8,
                  }}
                >
                  {siblings.map((s) => (
                    <label
                      key={s.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSiblingIds.includes(s.id)}
                        onChange={() => toggleSibling(s.id)}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.title || s.filename}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {isJoin ? (
                <div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                    {t('audiobooks.metadata.convertJoinChapters', { count: selectedSiblingIds.length + 1 })}
                  </p>
                  <label style={label}>{t('audiobooks.metadata.convertFilenameLabel')}</label>
                  <input
                    style={{ ...input, width: 220 }}
                    value={destFilename}
                    onChange={(e) => setDestFilename(e.target.value)}
                    placeholder={t('audiobooks.metadata.convertFilenamePlaceholder')}
                  />
                </div>
              ) : (
                <div>
                  <label style={label}>{t('audiobooks.metadata.convertChapterMinutesLabel')}</label>
                  <input
                    style={{ ...input, width: 100 }}
                    type="number"
                    min="1"
                    placeholder={t('audiobooks.metadata.convertChapterMinutesPlaceholder')}
                    value={chapterMinutes}
                    onChange={(e) => setChapterMinutes(e.target.value)}
                  />
                </div>
              )}
              <div>
                <label style={label}>{t('audiobooks.metadata.convertBitrateLabel')}</label>
                <select
                  style={{ ...input, width: 110, appearance: 'auto' }}
                  value={bitrateKbps}
                  onChange={(e) => setBitrateKbps(e.target.value)}
                >
                  {[32, 48, 64, 96, 128].map((kbps) => (
                    <option key={kbps} value={kbps}>
                      {kbps} kbps
                    </option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginBottom: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={deleteSources}
                  onChange={(e) => setDeleteSources(e.target.checked)}
                />
                {isJoin
                  ? t('audiobooks.metadata.convertDeleteSourcesJoin')
                  : t('audiobooks.metadata.convertDeleteSourcesSingle')}
              </label>
              <button
                type="button"
                onClick={startConversion}
                disabled={converting}
                style={{ ...cancelBtn, marginBottom: 8, gap: 6, opacity: converting ? 0.6 : 1 }}
              >
                {converting ? <Spinner size={14} /> : <LuFileAudio size={14} />}
                {converting
                  ? t('audiobooks.metadata.converting')
                  : t('audiobooks.metadata.convertButton')}
              </button>
            </div>
            {convertError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{convertError}</div>
            )}
          </div>
        )}

        {isChapterCapable && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <LuFileAudio size={14} color="var(--text-muted)" />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {t('audiobooks.metadata.detectChaptersTitle')}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              {t('audiobooks.metadata.detectChaptersHint')}
            </p>

            {!proposedChapters && (
              <div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={startDetection}
                    disabled={detecting}
                    style={{ ...cancelBtn, gap: 6, opacity: detecting ? 0.6 : 1 }}
                  >
                    {detecting ? <Spinner size={14} /> : <LuFileAudio size={14} />}
                    {detecting
                      ? detectProgress?.total
                        ? t('audiobooks.metadata.detectChaptersScanning', detectProgress)
                        : t('audiobooks.metadata.detecting')
                      : t('audiobooks.metadata.detectChaptersButton')}
                  </button>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12.5,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={detectAutoApply}
                      onChange={(e) => setDetectAutoApply(e.target.checked)}
                      disabled={detecting}
                    />
                    {t('audiobooks.metadata.detectChaptersAutoApply')}
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    fontSize: 11.5,
                    cursor: 'pointer',
                    padding: 0,
                    marginTop: 10,
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                  }}
                >
                  {showAdvanced
                    ? t('audiobooks.metadata.detectChaptersHideAdvanced')
                    : t('audiobooks.metadata.detectChaptersShowAdvanced')}
                </button>
                {showAdvanced && (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
                    <div>
                      <label style={label}>{t('audiobooks.metadata.detectChaptersNoiseDbLabel')}</label>
                      <input
                        style={{ ...input, width: 90 }}
                        type="number"
                        step="1"
                        value={detectNoiseDb}
                        onChange={(e) => setDetectNoiseDb(e.target.value)}
                        disabled={detecting}
                      />
                    </div>
                    <div>
                      <label style={label}>{t('audiobooks.metadata.detectChaptersMinSilenceLabel')}</label>
                      <input
                        style={{ ...input, width: 90 }}
                        type="number"
                        step="0.1"
                        min="0.2"
                        value={detectMinDuration}
                        onChange={(e) => setDetectMinDuration(e.target.value)}
                        disabled={detecting}
                      />
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', flexBasis: '100%', margin: '2px 0 0' }}>
                      {t('audiobooks.metadata.detectChaptersAdvancedHint')}
                    </p>
                  </div>
                )}
              </div>
            )}

            {chaptersApplied && !proposedChapters && (
              <p style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>
                {t('audiobooks.metadata.detectChaptersApplied')}
              </p>
            )}

            {proposedChapters && (
              <div style={{ marginTop: 10 }}>
                {proposedChapters.length === 0 && (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                    {t('audiobooks.metadata.detectChaptersNoneFound')}
                  </p>
                )}
                {proposedChapters.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      maxHeight: 220,
                      overflowY: 'auto',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 8,
                    }}
                  >
                    {proposedChapters.map((c) => {
                      const isPreviewing = previewingKey === c._key && isCurrent(audiobookId)
                      return (
                      <div key={c._key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => previewChapter(c)}
                          style={{
                            ...closeBtn,
                            flexShrink: 0,
                            color: isPreviewing ? 'var(--gold)' : 'var(--text-muted)',
                          }}
                          title={t('audiobooks.metadata.detectChaptersPreview')}
                          aria-label={t('audiobooks.metadata.detectChaptersPreview')}
                        >
                          <LuPlay size={13} />
                        </button>
                        <input
                          style={{
                            ...input,
                            padding: '5px 6px',
                            fontSize: 11,
                            width: 64,
                            textAlign: 'center',
                            flexShrink: 0,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                          value={c._startText}
                          onChange={(e) => updateProposedField(c._key, '_startText', e.target.value)}
                          onBlur={() => normalizeProposedTimestamp(c._key)}
                          placeholder="h:mm:ss"
                        />
                        <input
                          style={{ ...input, padding: '5px 8px', fontSize: 12.5, flex: 1 }}
                          value={c.title}
                          onChange={(e) => updateProposedField(c._key, 'title', e.target.value)}
                          placeholder={t('audiobooks.metadata.detectChaptersTitlePlaceholder')}
                          title={c.sample_text || undefined}
                        />
                        <button
                          type="button"
                          onClick={() => removeProposedChapter(c._key)}
                          style={{ ...closeBtn, flexShrink: 0 }}
                          aria-label={t('audiobooks.metadata.detectChaptersRemove')}
                        >
                          <LuX size={14} />
                        </button>
                      </div>
                      )
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={addProposedChapter}
                  style={{ ...cancelBtn, marginTop: 8, fontSize: 12, padding: '5px 12px' }}
                >
                  {t('audiobooks.metadata.detectChaptersAddRow')}
                </button>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={discardProposedChapters} style={cancelBtn}>
                    {t('audiobooks.metadata.detectChaptersDiscard')}
                  </button>
                  <button
                    type="button"
                    onClick={applyProposedChapters}
                    disabled={applyingChapters || validProposedCount === 0}
                    style={{ ...goldBtn, opacity: applyingChapters ? 0.6 : 1 }}
                  >
                    {applyingChapters
                      ? t('common.saving')
                      : t('audiobooks.metadata.detectChaptersApplyButton', {
                          count: validProposedCount,
                        })}
                  </button>
                </div>
                {applyError && (
                  <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{applyError}</div>
                )}
              </div>
            )}

            {detectError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{detectError}</div>
            )}
          </div>
        )}

        {saveError && (
          <div style={{ color: 'var(--danger)', fontSize: 13, margin: '14px 0 0' }}>{saveError}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} style={cancelBtn}>
            {t('common.cancel')}
          </button>
          <button onClick={save} disabled={saving} style={{ ...goldBtn, opacity: saving ? 0.6 : 1 }}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed',
  inset: 0,
  zIndex: 1200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--scrim)',
  padding: 16,
}
const panel = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 24,
  width: 720,
  maxWidth: '95vw',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxSizing: 'border-box',
}
const header = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 16,
}
const closeBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--text-muted)',
  display: 'flex',
  padding: 2,
}
const label = {
  display: 'block',
  fontSize: 12,
  color: 'var(--text-muted)',
  fontWeight: 500,
  marginBottom: 6,
  marginTop: 10,
}
const input = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 14,
  boxSizing: 'border-box',
}
const cancelBtn = {
  padding: '7px 16px',
  borderRadius: 6,
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--text-dim)',
  fontSize: 14,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
}
const goldBtn = {
  padding: '7px 18px',
  borderRadius: 6,
  background: 'var(--gold-dim)',
  border: 'none',
  color: 'var(--bg-deep)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}
