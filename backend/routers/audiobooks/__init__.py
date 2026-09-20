"""Audiobooks package — registers all audiobook routes on a single router."""
from fastapi import APIRouter, Depends

from ...auth import require_not_guest
from .._bulk_schemas import BulkResult, BulkTagResult
from .core import (
    list_audiobooks,
    list_audiobook_folders,
    update_audiobook_folder,
    bulk_update_audiobook_folders,
    get_audiobook,
    serve_audiobook_file,
    serve_audiobook_artwork,
    update_audiobook,
    update_audiobook_progress,
    reset_audiobook_progress,
    bulk_update_audiobooks,
    bulk_add_audiobook_tags,
    lookup_audible_metadata,
    apply_audiobook_cover_from_url,
    list_convertible_siblings,
    convert_audiobooks_to_m4b,
    get_conversion_status,
    start_chapter_detection,
    get_chapter_detection_status,
    apply_audiobook_chapters,
)
from ._schemas import (
    AudibleLookupResponse,
    AudiobookDetailResponse,
    AudiobookFoldersResponse,
    AudiobookListResponse,
    AudiobookProgressOut,
    ChapterDetectStarted,
    ChapterDetectStatus,
    ConvertibleSiblingsResponse,
    ConvertToM4BStarted,
    ConvertToM4BStatus,
    FolderTagsOut,
    StatusResponse,
)

router = APIRouter(tags=["audiobooks"])

# Browsing the whole audiobooks library is blocked for guests, matching Audio.
# Serving an individual item/artwork by id is allowed, but the get/file/artwork
# handlers enforce access themselves (via assert_media_access): guests are
# limited to items shared into their campaign.
router.add_api_route(
    "/audiobooks",
    list_audiobooks,
    methods=["GET"],
    summary="List audiobooks",
    description="Returns a paginated list of audiobooks.",
    dependencies=[Depends(require_not_guest)],
    response_model=AudiobookListResponse,
)
router.add_api_route(
    "/audiobook-folders",
    list_audiobook_folders,
    methods=["GET"],
    summary="List audiobook folders",
    description="Returns all known audiobook folder paths and their associated tags.",
    dependencies=[Depends(require_not_guest)],
    response_model=AudiobookFoldersResponse,
)
router.add_api_route(
    "/audiobook-folders",
    update_audiobook_folder,
    methods=["PATCH"],
    summary="Set tags on an audiobook folder",
    description="Creates or replaces the tag list for a folder path. GM or admin role required.",
    response_model=FolderTagsOut,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}",
    get_audiobook,
    methods=["GET"],
    summary="Get an audiobook",
    description="Returns full item metadata including duration, embedded tags, and folder tags.",
    response_model=AudiobookDetailResponse,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/file",
    serve_audiobook_file,
    methods=["GET"],
    summary="Stream/download audiobook file",
    description="Streams the original audio file (supports HTTP range requests). Accepts `?token=`.",
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/artwork",
    serve_audiobook_artwork,
    methods=["GET"],
    summary="Audiobook artwork",
    description=(
        "Returns an item's artwork, resolving folder cover art then embedded "
        "album art. 404 if none. There is no UI-uploaded cover for Audiobooks."
    ),
)
router.add_api_route(
    "/audiobooks/{audiobook_id}",
    update_audiobook,
    methods=["PATCH"],
    summary="Update audiobook metadata",
    description=(
        "Updates editable fields on an item (description, tags, title, author, "
        "narrator, series, series_index, year, genres). Curated fields are also "
        "written into the file's own tags when possible. GM or admin role required."
    ),
    response_model=StatusResponse,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/progress",
    update_audiobook_progress,
    methods=["PUT"],
    summary="Save this user's playback position",
    description=(
        "Upserts the requesting user's saved playhead for this audiobook, for "
        "resume-on-play. Called periodically by the player, not just on demand."
    ),
    response_model=AudiobookProgressOut,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/progress",
    reset_audiobook_progress,
    methods=["DELETE"],
    summary="Mark an audiobook as not started",
    description="Clears the requesting user's saved playback position.",
    response_model=AudiobookProgressOut,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/metadata-lookup",
    lookup_audible_metadata,
    methods=["GET"],
    summary="Search Audible for this audiobook's metadata",
    description=(
        "Searches Audible's public catalog (no login required) by title/author, "
        "or an explicit `?query=`, and returns candidate matches with cover art, "
        "series, narrator, and genre info to review and apply. GM or admin role "
        "required."
    ),
    response_model=AudibleLookupResponse,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/artwork/from-url",
    apply_audiobook_cover_from_url,
    methods=["POST"],
    summary="Embed a cover image fetched from a URL",
    description=(
        "Fetches the image at `url` (Audible's own cover CDN only) and embeds it "
        "as this audiobook's cover art. GM or admin role required."
    ),
    response_model=StatusResponse,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/convertible-siblings",
    list_convertible_siblings,
    methods=["GET"],
    summary="List sibling mp3s that can be joined with this one",
    description=(
        "Returns other mp3 files in this item's own folder, for the Edit "
        "Metadata pane's chapter-join picker. GM or admin role required."
    ),
    response_model=ConvertibleSiblingsResponse,
)
router.add_api_route(
    "/audiobooks/convert-to-m4b",
    convert_audiobooks_to_m4b,
    methods=["POST"],
    summary="Convert one or more mp3 audiobooks into a chaptered m4b",
    description=(
        "Starts a background conversion (see services/audiobook_convert) and "
        "returns a job id immediately. A single id converts that mp3 alone, "
        "generating chapters from its own ID3 chapter frames if present or a "
        "fixed `chapter_minutes` split; several ids (same folder, given in "
        "chapter order) are joined into one stream with a chapter per file. "
        "Requires the Docker image's bundled ffmpeg (or a local one exporting "
        "FFMPEG_BINARY) to have been built with mp3/AAC support. GM or admin "
        "role required."
    ),
    response_model=ConvertToM4BStarted,
)
router.add_api_route(
    "/audiobooks/convert-to-m4b/{job_id}",
    get_conversion_status,
    methods=["GET"],
    summary="Poll an m4b conversion job",
    description="Returns {status: running|done|error, ...}. GM or admin role required.",
    response_model=ConvertToM4BStatus,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/chapters/detect",
    start_chapter_detection,
    methods=["POST"],
    summary="Detect spoken chapter markers",
    description=(
        "Starts a background scan of the file's own audio for spoken "
        "\"Chapter N\" markers (see services/audiobook_chapter_detect) and "
        "returns a job id immediately. Requires the Docker image's bundled "
        "ffmpeg (or a local one exporting FFMPEG_BINARY) to have AAC decode "
        "support, and a bundled Vosk speech model. GM or admin role required."
    ),
    response_model=ChapterDetectStarted,
)
router.add_api_route(
    "/audiobooks/chapters/detect/{job_id}",
    get_chapter_detection_status,
    methods=["GET"],
    summary="Poll a chapter-detection job",
    description=(
        "Returns {status: running|done|error|cancelled, ...}. On `done`, "
        "either the proposed chapters for review or, if the request set "
        "`auto_apply`, confirmation they were already saved. GM or admin "
        "role required."
    ),
    response_model=ChapterDetectStatus,
)
router.add_api_route(
    "/audiobooks/{audiobook_id}/chapters",
    apply_audiobook_chapters,
    methods=["PUT"],
    summary="Replace an audiobook's chapter list",
    description=(
        "Overwrites the stored chapter markers for this item — used to "
        "commit a reviewed set of detected chapters, or to hand-edit them "
        "directly. Database only. GM or admin role required."
    ),
    response_model=StatusResponse,
)
# Bulk routes (issue #270). Applying a selection one PATCH per item raced on tag
# creation and 500'd; these take the whole batch in one transaction.
router.add_api_route(
    "/audiobooks/bulk",
    bulk_update_audiobooks,
    methods=["POST"],
    summary="Bulk update audiobooks",
    description=(
        "Applies per-item edits for many audiobooks in one transaction. "
        "Body: {items: [{id, description?, tags?}]}. Unknown ids are reported in "
        "`errors` and skipped. GM or admin role required."
    ),
    response_model=BulkResult,
)
router.add_api_route(
    "/audiobooks/bulk/tags",
    bulk_add_audiobook_tags,
    methods=["POST"],
    summary="Bulk add tags to audiobooks",
    description=(
        "Additively applies tags to many audiobooks in one transaction. "
        "Body: {ids: [...], tags: [...]}. GM or admin role required."
    ),
    response_model=BulkTagResult,
)
router.add_api_route(
    "/audiobook-folders/bulk",
    bulk_update_audiobook_folders,
    methods=["POST"],
    summary="Bulk set audiobook folder tags",
    description=(
        "Sets tags on many audiobook folders in one transaction. "
        "Body: {folders: [{path, tags}]}. GM or admin role required."
    ),
    response_model=AudiobookFoldersResponse,
)
