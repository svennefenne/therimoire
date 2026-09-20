"""Background job wrapper around services.audiobook_chapter_detect.

Scanning a whole audiobook for spoken chapter markers is a full pass over
the file (silence detection) plus a speech-to-text run over every candidate
snippet - minutes for a long book, not seconds - so, like the mp3->m4b
conversion job (see audiobook_convert_jobs.py), this runs in a plain daemon
thread and reports progress/results through a small status dict shared via
Valkey when available, so every worker process sees the same result.

Unlike conversion, this job is cancellable: a noisy narration track can turn
up far more silence candidates than a clean one, and a scan running with the
wrong noise-floor setting is much more useful to stop and re-run than to let
finish.
"""
import json
import logging
import threading
import uuid
from typing import Optional

from sqlalchemy.orm import Session

from ..config import SessionLocal, _valkey
from ..models import Audiobook
from . import audiobook_chapter_detect as detect

logger = logging.getLogger("grimoire.audiobooks")

try:
    from redis.exceptions import RedisError as _RedisError

    _VALKEY_ERRORS: tuple = (_RedisError,)
except ImportError:  # redis not installed - _valkey is always None
    _VALKEY_ERRORS = ()

_KEY_PREFIX = "grimoire:audiobook_chapter_detect:"
_JOB_TTL = 3600

# In-process fallback when Valkey is unavailable, and always for cancellation
# (see request_stop below) — fine even with WORKERS>1 in that configuration,
# for the same reason the duplicate-scan job's own status dict is.
_jobs: dict = {}
_stop_flags: dict[str, bool] = {}


def _set_status(job_id: str, status: dict) -> None:
    if _valkey:
        try:
            _valkey.set(_KEY_PREFIX + job_id, json.dumps(status), ex=_JOB_TTL)
            return
        except _VALKEY_ERRORS as e:
            logger.warning("Valkey set(chapter detect job) failed, using in-process: %s", e)
    _jobs[job_id] = status


def get_job(job_id: str) -> Optional[dict]:
    if _valkey:
        try:
            raw = _valkey.get(_KEY_PREFIX + job_id)
            if raw is not None:
                return json.loads(raw)
        except (*_VALKEY_ERRORS, ValueError) as e:
            logger.warning("Valkey get(chapter detect job) failed, using in-process: %s", e)
    return _jobs.get(job_id)


def request_stop(job_id: str) -> None:
    """Ask a running scan to stop after its current snippet.

    In-process only: a job is short enough (minutes, not hours) that a client
    polling it is polling the same worker that started it, so there is no
    need to route this through Valkey the way status is shared.
    """
    _stop_flags[job_id] = True


def _run(
    job_id: str,
    audiobook_id: str,
    noise_db: float,
    min_duration: float,
    auto_apply: bool,
) -> None:
    db: Session = SessionLocal()
    try:
        audiobook = db.query(Audiobook).filter_by(id=audiobook_id).first()
        if audiobook is None:
            _set_status(job_id, {"status": "error", "error": "Audiobook not found."})
            return
        filepath = audiobook.filepath
        duration = audiobook.duration or 0.0
    finally:
        db.close()

    def should_stop() -> bool:
        return _stop_flags.get(job_id, False)

    def on_progress(done: int, total: int) -> None:
        _set_status(job_id, {"status": "running", "done": done, "total": total})

    try:
        candidates = detect.detect_spoken_chapters(
            filepath,
            noise_db=noise_db,
            min_duration=min_duration,
            should_stop=should_stop,
            on_progress=on_progress,
        )
    except detect.ChapterDetectError as exc:
        logger.warning("Chapter detection failed: %s", exc)
        _set_status(job_id, {"status": "error", "error": str(exc)})
        return
    except Exception as exc:  # noqa: BLE001 - a failed job must not kill the thread
        logger.exception("Chapter detection crashed")
        _set_status(job_id, {"status": "error", "error": str(exc)[:300]})
        return
    finally:
        _stop_flags.pop(job_id, None)

    if should_stop():
        _set_status(job_id, {"status": "cancelled"})
        return

    chapters = detect.candidates_to_chapters(candidates, duration)

    if auto_apply:
        db = SessionLocal()
        try:
            audiobook = db.query(Audiobook).filter_by(id=audiobook_id).first()
            if audiobook is not None:
                audiobook.chapters = chapters or None
                db.commit()
        finally:
            db.close()
        _set_status(job_id, {"status": "done", "applied": True, "chapter_count": len(chapters)})
        return

    proposals = [
        {
            "title": ch["title"],
            "start": ch["start"],
            "end": ch["end"],
            "sample_text": next(
                (c.raw_text for c in candidates if abs(c.start - ch["start"]) < 0.01), ""
            ),
        }
        for ch in chapters
    ]
    _set_status(job_id, {"status": "done", "applied": False, "chapters": proposals})


def start_job(
    *,
    audiobook_id: str,
    noise_db: float,
    min_duration: float,
    auto_apply: bool,
) -> str:
    job_id = str(uuid.uuid4())
    _set_status(job_id, {"status": "running", "done": 0, "total": 0})
    thread = threading.Thread(
        target=_run,
        args=(job_id, audiobook_id, noise_db, min_duration, auto_apply),
        daemon=True,
    )
    thread.start()
    return job_id
