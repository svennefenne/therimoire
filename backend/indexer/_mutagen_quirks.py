"""Defensive patches for real-world MP4 quirks mutagen's parser chokes on.

mutagen has no partial-failure story for ``MP4(path)``: a single malformed
atom anywhere in the file aborts the *entire* load, even for fields the
caller never asked for and even when every other atom in the file is fine.
That's come up once so far (see ``_patch_chpl_parsing`` below) for a file
whose legacy Nero-style ``udta.chpl`` chapter atom doesn't match the byte
layout mutagen's ``MP4Chapters._parse_chpl`` hardcodes, which made it
impossible to even *open* that file with mutagen -- not just to read its
chapters, which nothing here uses mutagen for anyway (see
``audio_chapters.py``), but to read or write its tags and cover art too.

The pattern here (one function per quirk, an idempotent guard, and a call
right after each existing local ``from mutagen... import ...``, never a
module-level mutagen import of our own) is meant to make it cheap to add
another patch if a different real file trips over a different one, without
reintroducing the "heavy import at process startup" cost those local
imports exist to avoid.
"""
import logging

logger = logging.getLogger("grimoire.indexer")

_patched = False


def ensure_patched() -> None:
    """Apply mutagen quirk patches. Idempotent and cheap to call repeatedly.

    Call this right after any local ``from mutagen... import ...`` that
    might touch MP4/M4A/M4B files -- it only does real work once per
    process.
    """
    global _patched
    if _patched:
        return
    _patched = True
    _patch_chpl_parsing()


def _patch_chpl_parsing() -> None:
    """Make a malformed legacy ``udta.chpl`` atom non-fatal to opening a file.

    Some audiobook-conversion tools write a Nero-style ``chpl`` chapter-list
    atom whose header doesn't match what ``MP4Chapters._parse_chpl`` assumes
    (a fixed 8-byte version/flags/reserved header before the chapter count
    byte). On a mismatched layout it reads a garbage chapter count and walks
    off the end of the atom's own data, raising ``struct.error: unpack
    requires a buffer of 8 bytes`` from deep inside ``MP4.load()`` -- which
    has no try/except narrow enough to let the rest of the load (tags,
    ``covr`` art) continue; it just aborts the whole ``MP4(path)`` call.

    Grimoire never reads mutagen's ``.chapters`` -- chapters come from
    ffmpeg's ffmetadata dump instead, which doesn't touch this atom at all
    (see ``audio_chapters.py``) -- so there is nothing lost by degrading a
    bad chpl atom to "no mutagen-read chapters" instead of "mutagen can't
    open this file at all."
    """
    from mutagen.mp4 import MP4Chapters

    original_parse_chpl = MP4Chapters._parse_chpl

    def _safe_parse_chpl(self, atom, fileobj):
        try:
            original_parse_chpl(self, atom, fileobj)
        except Exception as exc:
            logger.warning(
                "Ignoring malformed 'chpl' atom (not used for anything "
                f"Grimoire reads): {exc}"
            )
            self._chapters = []

    MP4Chapters._parse_chpl = _safe_parse_chpl
