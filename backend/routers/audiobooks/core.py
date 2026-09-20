"""Audiobook CRUD, file-serving, and folder-tagging endpoints.

Mirrors routers/audio/core.py, with two differences: metadata edits also
write into the file's own tags (see indexer/audio_tags.py) rather than only
Grimoire's database, and there is no UI-uploaded cover — a chosen cover is
embedded directly into the file the same way (see the note on the Audiobook
model for why the split from Audio has no separate cover-upload story).
"""
import logging
import os
from pathlib import Path

from fastapi import Depends, HTTPException, Query
from sqlalchemy.orm import Session
from fastapi.responses import FileResponse, Response

from ...config import get_db
from ...models import Audiobook, AudiobookFolder
from ...models.users import AudiobookProgress
from ...services import (
    audible_lookup,
    audiobook_chapter_detect_jobs,
    audiobook_convert_jobs,
    bulk_service,
    metadata_lookup,
    tag_service,
    variants,
)
from ...auth import require_gm_or_admin, get_current_user, CurrentUser
from ...indexer import (
    AUDIOBOOK_TAG_FIELDS,
    _extract_embedded_art,
    _find_folder_artwork,
    archive_ext,
    archive_mime,
    write_audio_tags,
    write_cover_art,
)
from .._bulk_schemas import BulkAddTags, BulkFolderTags
from .._media_access import assert_media_access
from ._schemas import (
    ApplyChaptersRequest,
    ArtworkFromUrl,
    AudiobookBulkUpdate,
    AudiobookProgressUpdate,
    AudiobookUpdate,
    ChapterDetectRequest,
    ConvertToM4BRequest,
    FolderTagsUpdate,
)

logger = logging.getLogger("grimoire.audiobooks")

# Map audio extensions to the mimetype the browser <audio> element expects.
# Kept in sync with routers/audio/core.py's _AUDIO_MIME.
_AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".aac": "audio/aac",
}


def _current_chapter_info(chapters: list | None, position: float | None) -> dict | None:
    """Which chapter `position` falls in, and how far through it — the compact
    shape gallery rows show ("Progress: 23% of Chapter 3") without shipping the
    whole chapter list over the wire for every item in a page of results.

    None whenever there's nothing to report: no saved position, or a file with
    no chapter markers at all (plenty of audiobooks are one long unchaptered
    stream). A position past every chapter's end (metadata drifted slightly
    short of the actual audio, or the book just finished) is pinned to the
    last chapter rather than reported as unmatched.
    """
    if not chapters or position is None or position < 0:
        return None
    match = None
    for idx, c in enumerate(chapters):
        start = c.get("start", 0) or 0
        end = c.get("end", start) or start
        if start <= position < end:
            match = (idx, c, start, end)
            break
    if match is None:
        idx, c = len(chapters) - 1, chapters[-1]
        start = c.get("start", 0) or 0
        end = c.get("end", start) or start
        match = (idx, c, start, end)
    idx, c, start, end = match
    span = max(end - start, 0.001)
    percent = max(0.0, min(1.0, (position - start) / span))
    return {
        "index": idx,
        "title": c.get("title") or "",
        "start_seconds": start,
        "percent": percent,
    }


def _serialize(
    a: Audiobook,
    tags: list[str] | None = None,
    progress_seconds: float | None = None,
) -> dict:
    return {
        "id": a.id,
        "filename": a.filename,
        "relative_path": a.relative_path,
        "description": a.description,
        "tags": tags if tags is not None else [],
        "duration": a.duration or 0.0,
        "title": a.title or "",
        "artist": a.artist or "",
        "album": a.album or "",
        "author": a.author or "",
        "narrator": a.narrator or "",
        "series": a.series or "",
        "series_index": a.series_index,
        "year": a.year,
        "genres": a.genres or [],
        "has_artwork": bool(a.has_artwork),
        "file_size": a.file_size,
        "is_missing": bool(a.is_missing),
        "is_archive": bool(archive_ext(a.filename)),
        "chapter_count": len(a.chapters or []),
        "progress_seconds": progress_seconds,
        "current_chapter": _current_chapter_info(a.chapters, progress_seconds),
    }


def list_audiobooks(
    limit: int = Query(100000),
    offset: int = 0,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = variants.parents_only(db.query(Audiobook), Audiobook)
    total = q.count()
    items = q.order_by(Audiobook.filename).offset(offset).limit(limit).all()
    item_tags = tag_service.display_tags_for_resources(db, "audiobook", [a.id for a in items])
    vcounts = variants.variant_counts(db, Audiobook, [a.id for a in items])
    vkinds = variants.variant_kinds(db, Audiobook, [a.id for a in items])
    # One query for every item's progress rather than one per row — the
    # gallery page can list hundreds of audiobooks at once.
    progress_by_id = {
        p.audiobook_id: p.position_seconds
        for p in db.query(AudiobookProgress).filter(
            AudiobookProgress.user_id == current_user.id,
            AudiobookProgress.audiobook_id.in_([a.id for a in items]),
        )
    }
    return {
        "total": total,
        "audiobooks": [
            {
                **_serialize(
                    a, tags=item_tags.get(a.id, []), progress_seconds=progress_by_id.get(a.id)
                ),
                "variant_count": vcounts.get(a.id, 0),
                "variant_kinds": vkinds.get(a.id, []),
            }
            for a in items
        ],
    }


def list_audiobook_folders(db: Session = Depends(get_db)):
    folders = db.query(AudiobookFolder).all()
    return {
        "folders": [
            {"path": f.path, "tags": tag_service.folder_display_tags(db, f.tags or [])}
            for f in folders
        ]
    }


def update_audiobook_folder(
    data: FolderTagsUpdate,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    internals = tag_service.upsert_folder_tags(
        db, AudiobookFolder, data.path, data.tags, category="audiobook"
    )
    db.commit()
    return {"path": data.path, "tags": internals}


def get_audiobook(
    audiobook_id: str,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    assert_media_access(db, current_user, "audiobook", a.id)
    folder_path = "/".join(Path(a.relative_path).parts[1:-1])
    folder = db.query(AudiobookFolder).filter_by(path=folder_path).first()
    variant_parent, siblings = variants.family_for(db, Audiobook, a)
    progress = (
        db.query(AudiobookProgress)
        .filter_by(user_id=current_user.id, audiobook_id=a.id)
        .first()
    )
    return {
        **_serialize(
            a,
            tags=tag_service.display_tags_for_resource(db, "audiobook", a.id),
            progress_seconds=progress.position_seconds if progress else None,
        ),
        "folder_path": folder_path,
        "folder_tags": tag_service.folder_display_tags(db, folder.tags if folder else []),
        "variant_parent_id": a.variant_parent_id,
        "variant_kind": a.variant_kind or "",
        "variant_label": a.variant_label or "",
        "variant_main_id": variant_parent.id,
        "variants": [variants.serialize_variant(v) for v in siblings],
        "chapters": a.chapters or [],
    }


def update_audiobook_progress(
    audiobook_id: str,
    data: AudiobookProgressUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save this user's playback position, for resume-on-play.

    Upserts on (user, audiobook_id). Any authenticated user with access to the
    item may save their own progress — this deliberately doesn't require GM/
    admin, unlike the metadata-editing endpoints, since it's per-listener
    state rather than a change to the library.
    """
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    assert_media_access(db, current_user, "audiobook", a.id)
    position = max(0.0, data.position_seconds)
    row = (
        db.query(AudiobookProgress)
        .filter_by(user_id=current_user.id, audiobook_id=audiobook_id)
        .first()
    )
    if row:
        row.position_seconds = position
    else:
        row = AudiobookProgress(
            user_id=current_user.id, audiobook_id=audiobook_id, position_seconds=position
        )
        db.add(row)
    db.commit()
    return {"status": "ok", "position_seconds": position}


def reset_audiobook_progress(
    audiobook_id: str,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mark an audiobook as not started, clearing this user's saved position."""
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    assert_media_access(db, current_user, "audiobook", a.id)
    db.query(AudiobookProgress).filter_by(
        user_id=current_user.id, audiobook_id=audiobook_id
    ).delete()
    db.commit()
    return {"status": "ok", "position_seconds": 0.0}


def serve_audiobook_file(
    audiobook_id: str,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    assert_media_access(db, current_user, "audiobook", a.id)
    if not os.path.exists(a.filepath):
        if not a.is_missing:
            a.is_missing = True
            db.commit()
        raise HTTPException(404, "File not found on disk")
    arc_ext = archive_ext(a.filename)
    if arc_ext:
        media = archive_mime(arc_ext)
    else:
        ext = Path(a.filepath).suffix.lower()
        media = _AUDIO_MIME.get(ext, "application/octet-stream")
    # FileResponse honours HTTP Range requests, so browsers can seek/stream.
    return FileResponse(a.filepath, media_type=media, filename=a.filename)


def serve_audiobook_artwork(
    audiobook_id: str,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    assert_media_access(db, current_user, "audiobook", a.id)
    # No UI-uploaded cover to check first (unlike Audio) — just folder art, then
    # embedded album art.
    cover = _find_folder_artwork(os.path.dirname(a.filepath))
    if cover and os.path.exists(cover):
        ext = Path(cover).suffix.lower().lstrip(".")
        return FileResponse(cover, media_type=f"image/{ext}")
    embedded = _extract_embedded_art(a.filepath)
    if embedded:
        data, mime = embedded
        return Response(content=data, media_type=mime or "image/jpeg")
    raise HTTPException(404)


def update_audiobook(
    audiobook_id: str,
    data: AudiobookUpdate,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    payload = data.model_dump(exclude_none=True)

    # Curated fields also go into the file's own tags, so a rescan reads back
    # what was just saved instead of overwriting it — see indexer/audio_tags.py.
    # Best-effort: a read-only library mount is a supported way to run
    # Grimoire (same rule the metadata sidecar exporter follows), so a failed
    # write here is logged and the request still succeeds against Grimoire's
    # own database.
    tag_fields = {k: v for k, v in payload.items() if k in AUDIOBOOK_TAG_FIELDS}
    file_updated = False
    if tag_fields and not archive_ext(a.filename) and os.path.exists(a.filepath):
        try:
            write_audio_tags(a.filepath, tag_fields)
            file_updated = True
        except Exception as exc:
            logger.warning(f"Could not write audiobook tags to '{a.filepath}': {exc}")

    bulk_service.apply_updates(db, "audiobook", a, payload)
    db.commit()
    return {"status": "ok", "file_updated": file_updated if tag_fields else None}


def lookup_audible_metadata(
    audiobook_id: str,
    query: str | None = Query(None, description="Override the search text; defaults to the item's title"),
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Search every configured metadata source for candidate metadata/cover matches.

    Not a login to any of these services, or a scrape of a book page — see
    services/metadata_lookup.py's module docstring for the full list of
    sources this fans out to (Audible, Audnexus, iTunes, Google Books, Open
    Library) and services/audible_lookup.py for the general shape every
    source's response is normalized into. Results come back grouped by
    source in a fixed priority order, tagged with `source`/`source_id` so the
    frontend can label and de-duplicate-pick them.
    """
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    q = (query or a.title or Path(a.filename).stem).strip()
    if not q:
        raise HTTPException(400, "No search text available for this item")
    try:
        results = metadata_lookup.search_all(q)
    except metadata_lookup.LookupError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"query": q, "results": results}


def apply_audiobook_cover_from_url(
    audiobook_id: str,
    data: ArtworkFromUrl,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Fetch the image at `data.url` and embed it as this item's cover art."""
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    if archive_ext(a.filename) or not os.path.exists(a.filepath):
        raise HTTPException(400, "No audio file to embed a cover into")
    try:
        image_bytes, mime = audible_lookup.fetch_image(data.url)
        write_cover_art(a.filepath, image_bytes, mime)
    except audible_lookup.LookupError as exc:
        raise HTTPException(502, str(exc)) from exc
    except Exception as exc:
        logger.warning(f"Could not embed cover for '{a.filepath}': {exc}")
        raise HTTPException(500, "Could not save that cover into the audio file") from exc
    a.has_artwork = True
    db.commit()
    return {"status": "ok"}


def list_convertible_siblings(
    audiobook_id: str,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Other mp3s in this item's own folder — candidates to join with it.

    Used by the Edit Metadata pane's "join chapters" picker: an audiobook
    bought as one mp3 per chapter shows up as several separate library items
    sharing a folder, so the join has to be assembled from siblings rather
    than read off one record. Ordered by filename, which is how per-chapter
    rips are conventionally numbered.
    """
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    folder = os.path.dirname(a.filepath)
    rows = (
        db.query(Audiobook)
        .filter(Audiobook.id != a.id)
        .order_by(Audiobook.filename)
        .all()
    )
    siblings = [
        r
        for r in rows
        if os.path.dirname(r.filepath) == folder and Path(r.filepath).suffix.lower() == ".mp3"
    ]
    return {
        "siblings": [
            {
                "id": r.id,
                "filename": r.filename,
                "title": r.title or "",
                "duration": r.duration or 0.0,
            }
            for r in siblings
        ]
    }


def convert_audiobooks_to_m4b(
    data: ConvertToM4BRequest,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Start a background mp3 -> chaptered m4b conversion (see services/audiobook_convert).

    Returns immediately with a job id; poll GET .../convert-to-m4b/{job_id}
    for the result. See ConvertToM4BRequest for how one id vs. several are
    treated differently (single-file chapter splitting vs. joining).
    """
    if not data.audiobook_ids:
        raise HTTPException(400, "No source audiobooks given")

    records = []
    for aid in data.audiobook_ids:
        a = db.query(Audiobook).filter_by(id=aid).first()
        if not a:
            raise HTTPException(404, f"Audiobook {aid} not found")
        if Path(a.filepath).suffix.lower() != ".mp3":
            raise HTTPException(400, f"'{a.filename}' is not an mp3 — only mp3 sources can be converted")
        if not os.path.exists(a.filepath):
            raise HTTPException(404, f"'{a.filename}' is missing on disk")
        records.append(a)

    folders = {os.path.dirname(r.filepath) for r in records}
    if len(folders) > 1:
        raise HTTPException(400, "All source files must be in the same folder")
    folder = folders.pop()

    first = records[0]
    if data.dest_filename:
        base_name = data.dest_filename.strip()
    elif len(records) > 1:
        # Joining several chapter files: `first` is just whichever chapter
        # sorts first by filename (e.g. "Chapter 02 - ..."), so its own name
        # is a chapter title, not the book's — naming the merged file after
        # it was the bug report this branch fixes. The book's own folder is
        # the reliable signal instead (see list_convertible_siblings' own
        # docstring on "one folder per book" being how this feature already
        # assumes the library is organized); a shared album tag is tried
        # first since it's the more precise signal when present, but a home
        # rip's tags are inconsistent often enough that the folder name is
        # the safer default to fall back to.
        base_name = (first.album or "").strip() or os.path.basename(folder.rstrip(os.sep))
    else:
        base_name = Path(first.filename).stem
    dest_name = base_name.strip() + ".m4b"
    dest_path = os.path.join(folder, dest_name)
    if os.path.exists(dest_path):
        raise HTTPException(409, f"'{dest_name}' already exists in that folder")

    scope_path = "/".join(Path(first.relative_path).parts[:-1])
    job_id = audiobook_convert_jobs.start_job(
        source_paths=[r.filepath for r in records],
        source_ids=[r.id for r in records],
        dest_path=dest_path,
        chapter_minutes=data.chapter_minutes,
        bitrate_kbps=data.bitrate_kbps,
        delete_sources=data.delete_sources,
        scope_path=scope_path,
    )
    return {"job_id": job_id, "status": "running"}


def get_conversion_status(
    job_id: str,
    _: CurrentUser = Depends(require_gm_or_admin),
):
    status = audiobook_convert_jobs.get_job(job_id)
    if status is None:
        raise HTTPException(404, "Unknown or expired conversion job")
    return status


def start_chapter_detection(
    audiobook_id: str,
    data: ChapterDetectRequest,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Start a background scan for spoken chapter markers (see services/audiobook_chapter_detect).

    Returns immediately with a job id; poll GET .../chapters/detect/{job_id}
    for progress and, once done, either the proposed chapters (for review) or
    confirmation they were already saved, if `data.auto_apply` was set.
    """
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    if archive_ext(a.filename) or not os.path.exists(a.filepath):
        raise HTTPException(400, "No audio file to scan")
    job_id = audiobook_chapter_detect_jobs.start_job(
        audiobook_id=audiobook_id,
        noise_db=data.noise_db,
        min_duration=data.min_duration,
        auto_apply=data.auto_apply,
    )
    return {"job_id": job_id, "status": "running"}


def get_chapter_detection_status(
    job_id: str,
    _: CurrentUser = Depends(require_gm_or_admin),
):
    status = audiobook_chapter_detect_jobs.get_job(job_id)
    if status is None:
        raise HTTPException(404, "Unknown or expired detection job")
    return status


def apply_audiobook_chapters(
    audiobook_id: str,
    data: ApplyChaptersRequest,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Replace this item's chapter list — the review step's "Apply", or a direct hand-edit.

    Database only: does not touch the file itself (see the module docstring
    on services/audiobook_chapter_detect for why detection stops short of
    writing chapters back into the file's own container).
    """
    a = db.query(Audiobook).filter_by(id=audiobook_id).first()
    if not a:
        raise HTTPException(404)
    chapters = sorted((c.model_dump() for c in data.chapters), key=lambda c: c["start"])
    a.chapters = chapters or None
    db.commit()
    return {"status": "ok", "chapter_count": len(chapters)}


def bulk_update_audiobooks(
    data: AudiobookBulkUpdate,  # type: ignore[valid-type]
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Apply per-item edits for a whole selection in one transaction (issue #270).

    Database-only, unlike the single-item PATCH above: curated fields here are
    not also written into each file's tags. The Edit Metadata pane (the
    intended path for author/narrator/series/etc.) always goes through the
    single-item endpoint; this bulk path exists for tags/description across a
    selection, where writing N files synchronously in one request would be a
    different cost profile than today's bulk edits.
    """
    return bulk_service.run_bulk_update(
        db,
        "audiobook",
        list(data.items),  # type: ignore[attr-defined]
        payload_for=lambda item: item.model_dump(exclude_none=True, exclude={"id"}),
        not_found_detail="Audiobook not found",
    )


def bulk_add_audiobook_tags(
    data: BulkAddTags,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Additively tag a whole selection of audiobooks in one transaction."""
    return bulk_service.run_bulk_add_tags(
        db, "audiobook", data.ids, data.tags, not_found_detail="Audiobook not found"
    )


def bulk_update_audiobook_folders(
    data: BulkFolderTags,
    _: CurrentUser = Depends(require_gm_or_admin),
    db: Session = Depends(get_db),
):
    """Set tags on many audiobook folders in one transaction."""
    folders = []
    for entry in data.folders:
        internals = tag_service.upsert_folder_tags(
            db, AudiobookFolder, entry.path, entry.tags, category="audiobook"
        )
        folders.append({"path": entry.path, "tags": internals})
    db.commit()
    return {"folders": folders}
