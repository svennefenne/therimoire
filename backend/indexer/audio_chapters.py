"""Chapter markers for audiobook-style M4A/M4B files.

Audiobook rips and exports (m4b-tool, Audible conversions, most audiobook
apps) routinely embed a chapter list inside the MP4 container. Mutagen has no
API for it — it reads tags, embedded art, and the stream's overall length,
but nothing container-level like a chapter list. Reading it back needs
something that understands the MP4 chapter box.

Rather than hand-parse the box structure, this shells out the same way
``video_frames.py`` does: the bundled ffmpeg already links the ``mov``
demuxer (it needs it to read MP4 battlemaps), and dumping chapters via the
``ffmetadata`` muxer never touches the audio stream at all — no decode, no
encode, just a read of the container's own metadata — so it works even
though that ffmpeg build has no audio decoders at all. The one thing the
image's ffmpeg-builder stage does not yet enable is the ``ffmetadata`` muxer
itself; until it does, this quietly returns no chapters in the built image
(``read_chapters`` never raises), while a system ffmpeg on a dev machine
already has it and works today.
"""
import logging
import os
import re
import shutil
import subprocess
from typing import Optional

logger = logging.getLogger("grimoire.indexer")

# Same override knob as video_frames.py, so a dev machine without the
# Docker image's binary still gets chapters from whatever ffmpeg it has.
FFMPEG_BINARY = os.environ.get("FFMPEG_BINARY", "/usr/local/bin/ffmpeg")

# Wall-clock budget for the child process. A metadata dump reads the
# container index rather than decoding anything, so it should return in well
# under a second; this only guards against a wedged process.
_FFMPEG_TIMEOUT = 10

# Ceiling on the ffmetadata text read back. A chapter list is a few KB even
# for a 50-chapter audiobook; this is a decompression-bomb-style guard, not a
# realistic limit.
_MAX_METADATA_BYTES = 4 * 1024 * 1024

# Formats that plausibly carry chapters — the MP4 chapter conventions
# ffmpeg's ffmetadata export reads. Gating on extension avoids spending a
# subprocess per file on formats (mp3/flac/wav/ogg/opus/aac) that never carry
# this kind of chapter data.
CHAPTER_CAPABLE_EXTS = {".m4a", ".m4b"}

_CHAPTER_HEADER_RE = re.compile(r"^\[CHAPTER\]$")
_TIMEBASE_RE = re.compile(r"^TIMEBASE=(\d+)/(\d+)$")
_START_RE = re.compile(r"^START=(-?\d+)$")
_END_RE = re.compile(r"^END=(-?\d+)$")
_TITLE_RE = re.compile(r"^title=(.*)$")

# ffmetadata escapes '=', ';', '#', '\' with a leading backslash in values
# (see the ffmpeg ffmetadata format docs); undo that for a clean title.
_UNESCAPE_RE = re.compile(r"\\([=;#\\])")


def _unescape(value: str) -> str:
    return _UNESCAPE_RE.sub(r"\1", value)


def ffmpeg_path() -> Optional[str]:
    """Absolute path to a usable ffmpeg, or None when none is available.

    Mirrors ``video_frames.ffmpeg_path`` — falls back to ``PATH`` so a dev
    machine's system ffmpeg is used outside Docker.
    """
    if os.path.isfile(FFMPEG_BINARY) and os.access(FFMPEG_BINARY, os.X_OK):
        return FFMPEG_BINARY
    return shutil.which("ffmpeg")


def _parse_ffmetadata_chapters(text: str) -> list[dict]:
    """Parse ``[CHAPTER]`` blocks out of ffmpeg's ffmetadata text format.

    Each block looks like::

        [CHAPTER]
        TIMEBASE=1/1000
        START=0
        END=125000
        title=Chapter 1

    ``START``/``END`` are integers in ``TIMEBASE`` units, converted to
    seconds here so nothing downstream needs to carry the timebase around.
    A block missing a title or a timing field is dropped rather than stored
    half-populated; malformed input yields fewer chapters, never a crash.
    """
    chapters: list[dict] = []
    in_chapter = False
    timebase = 1.0
    start: Optional[int] = None
    end: Optional[int] = None
    title: Optional[str] = None

    def _flush() -> None:
        if start is not None and end is not None and title is not None:
            chapters.append(
                {
                    "title": _unescape(title),
                    "start": round(start * timebase, 3),
                    "end": round(end * timebase, 3),
                }
            )

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if _CHAPTER_HEADER_RE.match(line):
            _flush()
            in_chapter = True
            timebase, start, end, title = 1.0, None, None, None
            continue
        if not in_chapter:
            continue
        if m := _TIMEBASE_RE.match(line):
            num, den = int(m.group(1)), int(m.group(2))
            timebase = num / den if den else 1.0
        elif m := _START_RE.match(line):
            start = int(m.group(1))
        elif m := _END_RE.match(line):
            end = int(m.group(1))
        elif m := _TITLE_RE.match(line):
            title = m.group(1)
    _flush()
    return chapters


def read_chapters(filepath: str) -> list[dict]:
    """Return ``[{"title", "start", "end"}, ...]`` for an M4A/M4B's chapters.

    ``start``/``end`` are float seconds. Returns ``[]`` for any format other
    than M4A/M4B, when no ffmpeg is available, or on any failure — this never
    raises, matching every other best-effort metadata read in this package.
    """
    ext = os.path.splitext(filepath)[1].lower()
    if ext not in CHAPTER_CAPABLE_EXTS:
        return []

    exe = ffmpeg_path()
    if exe is None:
        return []

    cmd = [
        exe,
        "-nostdin",  # never block waiting on a terminal that isn't there
        "-loglevel", "error",
        "-i", filepath,
        "-f", "ffmetadata",
        "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=_FFMPEG_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning(f"ffmpeg timed out after {_FFMPEG_TIMEOUT}s reading chapters from {filepath}")
        return []
    except OSError as e:
        logger.debug(f"Could not run ffmpeg for chapters on {filepath}: {e}")
        return []

    if proc.returncode != 0 or not proc.stdout:
        # A build without the ffmetadata muxer, or a file with no chapters at
        # all, both land here — neither is worth logging above debug.
        detail = proc.stderr.decode("utf-8", "replace").strip()
        logger.debug(f"No chapter metadata from {filepath}: {detail or 'empty output'}")
        return []

    if len(proc.stdout) > _MAX_METADATA_BYTES:
        logger.warning(f"Chapter metadata for {filepath} exceeds {_MAX_METADATA_BYTES} bytes; ignoring")
        return []

    try:
        text = proc.stdout.decode("utf-8", "replace")
        return _parse_ffmetadata_chapters(text)
    except Exception as exc:
        logger.debug(f"Could not parse chapters from {filepath}: {exc}")
        return []
