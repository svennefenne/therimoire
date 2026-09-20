"""Background job wrapper around services.audiobook_convert.

A decode+re-encode pass finishes in well under a minute even for a long
audiobook (see the module docstring on audiobook_convert), but an HTTP request
still has no business blocking on a subprocess for that long, so it runs in a
plain daemon thread and reports through a small status dict — shared via
Valkey when available so every worker sees the same result, exactly like the
duplicate-scan job (see services/duplicates/job.py), just without that job's
cancellation/heartbeat machinery: a conversion is one independent unit of work
rather than a long walk over the whole library, so there is nothing to cancel
and no ambiguity about which run a stuck status would even belong to.
"""
import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from ..config import SessionLocal, _valkey
from ..indexer import (
    AUDIOBOOK_TAG_FIELDS,
    _extract_embedded_art,
    _find_folder_artwork,
    write_audio_tags,
    write_cover_art,
)
from ..models import Audiobook
from . import audiobook_convert

logger = logging.getLogger("grimoire.audiobooks")

try:
    from redis.exceptions import RedisError as _RedisError

    _VALKEY_ERRORS: tuple = (_RedisError,)
except ImportError:  # redis not installed - _valkey is always None
    _VALKEY_ERRORS = ()

_KEY_PREFIX = "grimoire:audiobook_convert:"
_JOB_TTL = 3600

# In-process fallback when Valkey is unavailable. Fine even with WORKERS>1 in
# that configuration, since a Valkey-less deployment is single-worker by the
# same reasoning the duplicate-scan job documents for its own status dict.
_jobs: dict = {}


def _set_status(job_id: str, status: dict) -> None:
    if _valkey:
        try:
            _valkey.set(_KEY_PREFIX + job_id, json.dumps(status), ex=_JOB_TTL)
            return
        except _VALKEY_ERRORS as e:
            logger.warning("Valkey set(convert job) failed, using in-process: %s", e)
    _jobs[job_id] = status


def get_job(job_id: str) -> Optional[dict]:
    if _valkey:
        try:
            raw = _valkey.get(_KEY_PREFIX + job_id)
            if raw is not None:
                return json.loads(raw)
        except (*_VALKEY_ERRORS, ValueError) as e:
            logger.warning("Valkey get(convert job) failed, using in-process: %s", e)
    return _jobs.get(job_id)


def _copy_metadata_and_cover(source: Audiobook, dest_path: str, new_row: Audiobook) -> None:
    """Best-effort: carry the source's curated fields and cover into the new file.

    Mirrors what a PATCH to /audiobooks/{id} does (see
    routers/audiobooks/core.py's update_audiobook) — written into both the new
    file's own tags and Grimoire's database, so the converted item looks the
    way the source did rather than starting blank. Never raises: a failure
    here still leaves a perfectly good, playable m4b behind.
    """
    fields = {k: getattr(source, k) for k in AUDIOBOOK_TAG_FIELDS if getattr(source, k, None)}
    if fields:
        try:
            write_audio_tags(dest_path, fields)
        except Exception as exc:
            logger.warning("Could not write carried-over tags to '%s': %s", dest_path, exc)
        for k, v in fields.items():
            setattr(new_row, k, v)

    if not source.has_artwork:
        return
    try:
        image_bytes = None
        mime = "image/jpeg"
        cover = _find_folder_artwork(os.path.dirname(source.filepath))
        if cover and os.path.exists(cover):
            with open(cover, "rb") as f:
                image_bytes = f.read()
            ext = Path(cover).suffix.lower().lstrip(".")
            mime = f"image/{ext}" if ext else mime
        else:
            embedded = _extract_embedded_art(source.filepath)
            if embedded:
                image_bytes, mime = embedded
        if image_bytes:
            write_cover_art(dest_path, image_bytes, mime)
            new_row.has_artwork = True
    except Exception as exc:
        logger.warning("Could not carry cover art to '%s': %s", dest_path, exc)


def _run(
    job_id: str,
    source_paths: list[str],
    source_ids: list[str],
    dest_path: str,
    chapter_minutes: Optional[int],
    bitrate_kbps: int,
    delete_sources: bool,
    scope_path: str,
) -> None:
    # Imported here, not at module load: routers.library imports from services
    # at import time too, and doing this at the top would risk a circular
    # import depending on package init order.
    from ..routers.library._helpers import run_rescan_sync

    try:
        result = audiobook_convert.convert_to_m4b(
            source_paths, dest_path, chapter_minutes=chapter_minutes, bitrate_kbps=bitrate_kbps
        )
    except audiobook_convert.ConversionError as exc:
        logger.warning("Audiobook conversion failed: %s", exc)
        _set_status(job_id, {"status": "error", "error": str(exc)})
        return
    except Exception as exc:  # noqa: BLE001 - a failed job must not kill the thread
        logger.exception("Audiobook conversion crashed")
        _set_status(job_id, {"status": "error", "error": str(exc)[:300]})
        return

    db: Session = SessionLocal()
    new_id = None
    try:
        source = db.query(Audiobook).filter_by(id=source_ids[0]).first()

        # A scoped rescan registers the new file, reusing the same tested scan
        # path a manual "Rescan this folder" click goes through — see
        # run_rescan_sync's own docstring. If a full library scan happens to
        # already be running, this call simply no-ops rather than erroring;
        # the new file still exists on disk and the next rescan (scheduled or
        # manual) picks it up, it just will not appear instantly this once.
        run_rescan_sync(scope_path=scope_path)

        new_row = db.query(Audiobook).filter_by(filepath=dest_path).first()
        if new_row and source:
            _copy_metadata_and_cover(source, dest_path, new_row)
            db.commit()
            new_id = new_row.id

        if delete_sources:
            # Deleted here, not just flagged: leaving these is_missing (what a
            # plain rescan/reconcile does — see indexer/reconcile.py) would
            # leave the converted-away chapters' stale metadata sitting in the
            # folder view until someone ran Settings -> Maintenance -> "Remove
            # missing files" by hand (issue: converted mp3s stay listed after
            # deletion). So each file that actually comes off disk here also
            # has its row removed immediately, the same way that button
            # removes a single known-gone row (see
            # routers/maintenance/_helpers.py's _do_cleanup) — just scoped to
            # the ids this conversion deleted rather than a full-library sweep.
            from .library_fs.references import purge_references

            removed_ids = []
            for path, source_id in zip(source_paths, source_ids):
                try:
                    os.remove(path)
                    removed_ids.append(source_id)
                except OSError as exc:
                    logger.warning("Could not remove source file '%s': %s", path, exc)

            if removed_ids:
                try:
                    for source_id in removed_ids:
                        row = db.query(Audiobook).filter_by(id=source_id).first()
                        if row:
                            purge_references(db, Audiobook, row.id)
                            db.delete(row)
                    db.commit()
                except Exception as exc:  # noqa: BLE001 - a cleanup failure must not lose the file removal above
                    logger.warning("Could not remove converted source rows from the library: %s", exc)
                    db.rollback()

            # Still worth a scoped rescan: it flags is_missing for any file
            # that failed to delete above (rather than leaving its row look
            # untouched) and reconciles folder-tag bookkeeping generally.
            run_rescan_sync(scope_path=scope_path)
    finally:
        db.close()

    _set_status(
        job_id,
        {
            "status": "done",
            "audiobook_id": new_id,
            "duration": result["duration"],
            "chapter_count": result["chapter_count"],
        },
    )


def start_job(
    *,
    source_paths: list[str],
    source_ids: list[str],
    dest_path: str,
    chapter_minutes: Optional[int],
    bitrate_kbps: int,
    delete_sources: bool,
    scope_path: str,
) -> str:
    job_id = str(uuid.uuid4())
    _set_status(job_id, {"status": "running"})
    thread = threading.Thread(
        target=_run,
        args=(
            job_id,
            source_paths,
            source_ids,
            dest_path,
            chapter_minutes,
            bitrate_kbps,
            delete_sources,
            scope_path,
        ),
        daemon=True,
    )
    thread.start()
    return job_id
