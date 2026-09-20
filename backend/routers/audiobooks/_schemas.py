"""Pydantic schemas for the audiobooks API."""
from typing import Optional
from pydantic import BaseModel, field_validator

from ...services import tag_service
from .._bulk_schemas import bulk_update_model
from .._variant_schemas import VariantCountMixin, VariantFamilyMixin


class AudiobookChapter(BaseModel):
    title: str
    start: float
    end: float


class AudiobookUpdate(BaseModel):
    description: Optional[str] = None
    tags: Optional[list[str]] = None
    # Curated metadata (issue: audiobook metadata editing). Saving any of these
    # also writes them into the file's own tags — see indexer/audio_tags.py —
    # so a rescan reads back what was just saved. `genres` replaces the whole
    # list, matching how Book.genres is edited.
    title: Optional[str] = None
    author: Optional[str] = None
    narrator: Optional[str] = None
    series: Optional[str] = None
    series_index: Optional[float] = None
    year: Optional[int] = None
    genres: Optional[list[str]] = None

    @field_validator("tags", mode="before")
    @classmethod
    def dedupe_tags(cls, v):
        return tag_service.dedupe_tags(v, validate=True) if v is not None else v


# Batch form of AudiobookUpdate: {"items": [{"id": ..., ...AudiobookUpdate fields}]}.
AudiobookBulkUpdate = bulk_update_model(AudiobookUpdate, "Audiobook")


class FolderTagsUpdate(BaseModel):
    path: str
    tags: list[str]

    @field_validator("tags", mode="before")
    @classmethod
    def dedupe_tags(cls, v):
        # Keep the entered casing (dedupe by key); the folder-update handler
        # registers catalog rows with this casing and stores internal keys.
        return tag_service.dedupe_tags(v, validate=True)


class AudiobookCurrentChapter(BaseModel):
    """Which chapter this user's saved position falls within, for gallery rows
    that want to show "Progress: 23% of Chapter 3" without fetching the whole
    chapter list. `start_seconds` is echoed back so the client can offer
    "reset chapter progress" (seek back to `start_seconds`) without a second
    round trip."""

    index: int
    title: str
    start_seconds: float
    percent: float


class AudiobookOut(VariantCountMixin):
    """One audiobook, as built by `core._serialize`.

    Mirrors `AudioOut` (see routers/audio/_schemas.py) but with no `has_cover`
    field: a cover here is embedded directly into the file rather than
    UI-uploaded to a side folder — see the note on the `Audiobook` model.
    """

    id: str
    filename: str
    relative_path: str
    # `description` is `default=""`, not NOT NULL — legacy rows can be NULL.
    description: Optional[str] = None
    tags: list[str]
    duration: float
    title: str
    artist: str
    album: str
    # Curated metadata — see the note on AudiobookUpdate. Blank/None until a
    # user has edited this item (or applied an Audible lookup result).
    author: str = ""
    narrator: str = ""
    series: str = ""
    series_index: Optional[float] = None
    year: Optional[int] = None
    genres: list[str] = []
    has_artwork: bool
    # `file_size` is `default=0`, not NOT NULL.
    file_size: Optional[int] = None
    is_missing: bool
    is_archive: bool
    # Number of chapter markers (0 for a plain unchaptered file). Cheap to
    # compute — it's just len(chapters) — so it's always populated, unlike
    # progress_seconds/current_chapter below which need a per-user join.
    chapter_count: int = 0
    # This user's saved playback position, in seconds — null if they've never
    # played it (or have reset it via "Mark as not started"). Scoped to the
    # requesting user; see AudiobookProgress.
    progress_seconds: Optional[float] = None
    # Derived from progress_seconds + the file's own chapters — which chapter
    # that position falls in, and how far through it. Null whenever
    # progress_seconds is null, or the file has no chapter markers.
    current_chapter: Optional[AudiobookCurrentChapter] = None


class AudiobookListResponse(BaseModel):
    total: int
    audiobooks: list[AudiobookOut]


class AudiobookDetailResponse(AudiobookOut, VariantFamilyMixin):
    """`GET /audiobooks/{id}` — the serialized item plus its folder context."""

    folder_path: str
    folder_tags: list[str]
    chapters: list[AudiobookChapter] = []


class FolderTagsOut(BaseModel):
    """One folder path and its tags.

    Note the list/update endpoints differ: `GET /audiobook-folders` returns
    display tags, while the PATCH/bulk writes echo back the stored internal keys.
    """

    path: str
    tags: list[str]


class AudiobookFoldersResponse(BaseModel):
    folders: list[FolderTagsOut]


class StatusResponse(BaseModel):
    status: str
    # Only meaningful on the metadata PATCH: whether the curated fields were
    # also written into the file itself, vs. only saved to Grimoire's own
    # database (e.g. a read-only library mount — a supported way to run
    # Grimoire, so this degrades rather than failing the request).
    file_updated: Optional[bool] = None


class AudibleCandidate(BaseModel):
    """One catalog match from any configured metadata source.

    Normalized into this shape by services/audible_lookup.py (source
    "audible") and its siblings services/audnexus_lookup.py, itunes_lookup.py,
    google_books_lookup.py, and openlibrary_lookup.py — see
    services/metadata_lookup.py for how they're merged. `asin` is only
    populated for the "audible"/"audnexus" sources (both are Audible-catalog
    identifiers underneath); `source_id` is always populated and is the right
    field to key a picked candidate on regardless of source.
    """

    source: str = "audible"
    source_id: str = ""
    asin: str
    title: str
    subtitle: str = ""
    authors: list[str] = []
    narrators: list[str] = []
    series: str = ""
    series_index: Optional[float] = None
    year: Optional[int] = None
    genres: list[str] = []
    cover_url: Optional[str] = None
    runtime_minutes: Optional[int] = None
    description: str = ""


class AudibleLookupResponse(BaseModel):
    query: str
    results: list[AudibleCandidate]


class ArtworkFromUrl(BaseModel):
    url: str


class ConvertibleSibling(BaseModel):
    id: str
    filename: str
    title: str
    duration: float


class ConvertibleSiblingsResponse(BaseModel):
    siblings: list[ConvertibleSibling]


class ConvertToM4BRequest(BaseModel):
    """Join and/or convert one or more mp3 audiobooks into one chaptered m4b.

    A single id converts that one mp3: chapters come from its own embedded
    ID3 chapter frames if it has any, else a fixed ``chapter_minutes`` split
    (ignored, along with any chapter frames, when omitted — the whole book
    becomes one chapter). Several ids, given in the desired chapter order,
    join those files into one stream with a real chapter mark at each file's
    boundary; ``chapter_minutes`` is not used in that case. All ids must name
    mp3s in the same folder — the new file is written beside them.
    """

    audiobook_ids: list[str]
    chapter_minutes: Optional[int] = None
    bitrate_kbps: int = 64
    delete_sources: bool = False
    # Without extension; defaults to the first source's own filename.
    dest_filename: Optional[str] = None


class ConvertToM4BStarted(BaseModel):
    job_id: str
    status: str = "running"


class ConvertToM4BStatus(BaseModel):
    status: str  # running | done | error
    error: Optional[str] = None
    audiobook_id: Optional[str] = None
    duration: Optional[float] = None
    chapter_count: Optional[int] = None


class AudiobookProgressUpdate(BaseModel):
    """Body of `PUT /audiobooks/{id}/progress` — the client's current playhead.

    Sent periodically while playing, on pause, and when switching tracks (see
    AudioPlayerContext). Not validated against the file's own duration here —
    a position a few seconds past what the server knows about is a client
    clock skew, not something worth rejecting the save over.
    """

    position_seconds: float


class AudiobookProgressOut(BaseModel):
    status: str = "ok"
    position_seconds: float


class DetectedChapter(BaseModel):
    """One proposed chapter from spoken-marker detection, pending review.

    `sample_text` is the (lowercase, unpunctuated) transcript Vosk produced
    for the snippet right after this boundary — shown in the review UI so a
    person can sanity-check a guess like "chapter thirteen" against what was
    actually heard, without needing to scrub the audio to the same spot.
    """

    title: str
    start: float
    end: float
    sample_text: str = ""


class ChapterDetectRequest(BaseModel):
    """Body of `POST /audiobooks/{id}/chapters/detect`.

    `noise_db`/`min_duration` tune the initial silencedetect pass (see
    services/audiobook_chapter_detect.detect_silences) — the defaults work for
    a normally-mastered narration track; a noisier rip may need a lower (more
    negative) `noise_db` to find its pauses at all. `auto_apply` skips the
    review step and writes the detected chapters straight to the database as
    soon as the scan finishes, instead of returning them for review.
    """

    noise_db: float = -30.0
    min_duration: float = 1.2
    auto_apply: bool = False


class ChapterDetectStarted(BaseModel):
    job_id: str
    status: str = "running"


class ChapterDetectStatus(BaseModel):
    status: str  # running | done | error | cancelled
    error: Optional[str] = None
    done: Optional[int] = None
    total: Optional[int] = None
    # Populated once status == "done" and auto_apply was false: the proposed
    # chapters, for review.
    chapters: Optional[list[DetectedChapter]] = None
    # Populated once status == "done": whether the result was written straight
    # to the database (auto_apply) or is waiting on a PUT .../chapters to
    # commit a reviewed list.
    applied: Optional[bool] = None
    chapter_count: Optional[int] = None


class ApplyChaptersRequest(BaseModel):
    """Body of `PUT /audiobooks/{id}/chapters` — replaces the whole chapter list.

    Used both to commit a reviewed set of detected chapters and, generally, to
    hand-edit an item's chapters directly. An empty list clears them
    (equivalent to the file having none).
    """

    chapters: list[AudiobookChapter]
