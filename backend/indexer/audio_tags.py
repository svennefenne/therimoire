"""Writing curated audiobook metadata back into the file's own embedded tags.

The write-side mirror of ``_read_audio_metadata``/``_extract_embedded_art`` in
``indexer/metadata.py``: those read title/artist/album and cover art with
mutagen, and this writes Grimoire's curated fields (from the Edit Metadata
pane) the same way, so the file itself carries what the app shows and a later
rescan reads back exactly what was just written rather than something stale.

Neither ID3 nor MP4 has a dedicated "narrator" or "series" frame, so this
follows the convention audiobook tools already converged on (Audiobookshelf,
AAXtoMP3, Apple Books' own audiobook exporter):

    field         ID3 (mp3, etc.)      MP4 (m4a/m4b)
    -----         ---------------      -------------
    title         TIT2                 (c)nam
    author        TPE1  (artist)       (c)ART (artist)
    narrator      TPE2  (album artist) aART   (album artist)
    series        TALB  (album)        (c)alb (album)
    series_index  TRCK  (track)        trkn   (track) -- integer part only
    year          TDRC  (date)         (c)day (date)
    genres        TCON, "; "-joined    (c)gen, "; "-joined
    description   COMM  (comment)      (c)cmt (comment)

A field key absent from ``fields`` is left untouched; present with a falsy
value (``""``, ``None``, ``[]``) it clears that tag. This is best-effort by
design, matching the "never break the thing that triggered them" rule the
metadata sidecar exporter follows for the same reason (issue #300): a library
mounted read-only is a supported way to run Grimoire, so a failed write here
is the caller's to catch and log, not to let crash the request that also
updates Grimoire's own database.
"""
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("grimoire.indexer")

_MP4_EXTS = {".m4a", ".m4b", ".mp4"}

# The full curated-field set the Edit Metadata pane can send. Kept here (not
# just in the router) so the router's "which fields are tag-writes vs.
# DB-only" filter and this module's own field handling can never drift apart.
TAG_FIELDS = frozenset(
    {"title", "author", "narrator", "series", "series_index", "year", "genres", "description"}
)


def _format_series_index(value: Any) -> str:
    """``2`` -> "2", ``2.5`` -> "2.5" -- whole numbers print without a decimal."""
    if value is None or value == "":
        return ""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return ""
    return str(int(f)) if f.is_integer() else str(f)


def write_audio_tags(filepath: str, fields: dict) -> None:
    """Write ``fields`` into ``filepath``'s embedded tags (format-aware).

    Raises on failure -- opening/saving the tag container is the one thing
    here that is not per-field best-effort, so a caller can catch one
    exception and know nothing was written rather than half of it.
    """
    ext = Path(filepath).suffix.lower()
    if ext in _MP4_EXTS:
        _write_mp4_tags(filepath, fields)
    else:
        _write_id3_tags(filepath, fields)


def _write_id3_tags(filepath: str, fields: dict) -> None:
    from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, TRCK, TDRC, TCON, COMM

    try:
        tags = ID3(filepath)
    except ID3NoHeaderError:
        tags = ID3()

    def _set(frame_id: str, frame_cls, text: str) -> None:
        if text:
            tags.setall(frame_id, [frame_cls(encoding=3, text=text)])
        else:
            tags.delall(frame_id)

    if "title" in fields:
        _set("TIT2", TIT2, (fields["title"] or "").strip())
    if "author" in fields:
        _set("TPE1", TPE1, (fields["author"] or "").strip())
    if "narrator" in fields:
        _set("TPE2", TPE2, (fields["narrator"] or "").strip())
    if "series" in fields:
        _set("TALB", TALB, (fields["series"] or "").strip())
    if "series_index" in fields:
        _set("TRCK", TRCK, _format_series_index(fields["series_index"]))
    if "year" in fields:
        year = fields["year"]
        _set("TDRC", TDRC, str(int(year)) if year else "")
    if "genres" in fields:
        genres = [g.strip() for g in (fields["genres"] or []) if str(g).strip()]
        _set("TCON", TCON, "; ".join(genres))
    if "description" in fields:
        desc = (fields["description"] or "").strip()
        tags.delall("COMM")
        if desc:
            tags.add(COMM(encoding=3, lang="eng", desc="", text=desc))

    tags.save(filepath)


def _write_mp4_tags(filepath: str, fields: dict) -> None:
    from mutagen.mp4 import MP4, MP4Tags
    from ._mutagen_quirks import ensure_patched

    ensure_patched()
    audio = MP4(filepath)
    if audio.tags is None:
        audio.tags = MP4Tags()
    tags = audio.tags

    def _set(atom: str, text: str) -> None:
        if text:
            tags[atom] = [text]
        else:
            tags.pop(atom, None)

    if "title" in fields:
        _set("\xa9nam", (fields["title"] or "").strip())
    if "author" in fields:
        _set("\xa9ART", (fields["author"] or "").strip())
    if "narrator" in fields:
        _set("aART", (fields["narrator"] or "").strip())
    if "series" in fields:
        _set("\xa9alb", (fields["series"] or "").strip())
    if "series_index" in fields:
        idx = fields["series_index"]
        # trkn is an (track, total) integer tuple -- MP4 has no fractional
        # track slot, so a half-entry ("2.5") keeps its precision in
        # Grimoire's own database but is rounded here. Good enough for sort
        # order in players that read trkn; not claimed as exact.
        if idx not in (None, ""):
            try:
                tags["trkn"] = [(round(float(idx)), 0)]
            except (TypeError, ValueError):
                tags.pop("trkn", None)
        else:
            tags.pop("trkn", None)
    if "year" in fields:
        year = fields["year"]
        _set("\xa9day", str(int(year)) if year else "")
    if "genres" in fields:
        genres = [g.strip() for g in (fields["genres"] or []) if str(g).strip()]
        _set("\xa9gen", "; ".join(genres))
    if "description" in fields:
        _set("\xa9cmt", (fields["description"] or "").strip())

    audio.save()


def write_cover_art(filepath: str, image_bytes: bytes, mime: str = "image/jpeg") -> None:
    """Embed ``image_bytes`` as the file's cover art, replacing any existing one."""
    ext = Path(filepath).suffix.lower()
    if ext in _MP4_EXTS:
        from mutagen.mp4 import MP4, MP4Cover, MP4Tags
        from ._mutagen_quirks import ensure_patched

        ensure_patched()
        audio = MP4(filepath)
        if audio.tags is None:
            audio.tags = MP4Tags()
        fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
        audio.tags["covr"] = [MP4Cover(image_bytes, imageformat=fmt)]
        audio.save()
        return

    from mutagen.id3 import ID3, ID3NoHeaderError, APIC

    try:
        tags = ID3(filepath)
    except ID3NoHeaderError:
        tags = ID3()
    tags.delall("APIC")
    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=image_bytes))
    tags.save(filepath)
