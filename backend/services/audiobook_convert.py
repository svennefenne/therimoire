"""mp3 -> chaptered .m4b conversion.

Uses the same purpose-built ffmpeg binary that generates animated-map
thumbnails (see ``indexer/video_frames.py`` and the ``ffmpeg-builder`` stage in
the Dockerfile), extended with an mp3 decoder, the native AAC encoder, and the
"ipod" muxer (the mov/mp4 variant that tags itself as m4a/m4b rather than
plain mp4 - see the Dockerfile comment on why that specific muxer name
matters). One binary serves both jobs; the added decoders/encoders cost about
1.4 MB over the video-only build, still self-contained (libc/libm/libz only).

Two shapes of source material both end up here:

* A single long mp3 with no chapter markers - the common case for an
  audiobook bought as one file. Chapters come from the file's own ID3
  CHAP/CTOC frames if it has any (rare, but some rips do), otherwise from a
  fixed ``chapter_minutes`` split, or the whole book is left as one chapter
  if ``chapter_minutes`` is falsy.
* Several mp3s that are really one book split by chapter (``Chapter
  01.mp3``, ``Chapter 02.mp3``, ...). One chapter per file, titled from each
  file's own tag or filename, joined into a single stream before encoding.

Both paths funnel into one ffmpeg invocation: every source is decoded,
normalised to a common sample rate/channel layout (so mismatched inputs don't
break the concat filter), concatenated, and re-encoded to AAC once. The
chapter marks are supplied as a hand-written FFMETADATA1 file - only the
*demuxer* for that format needs to be compiled in (to read it back via
``-map_metadata``); nothing here needs ffmpeg's own ffmetadata *muxer* to
write it, since it is just a small text format Python can produce directly.

Every ``-i`` is its own argv element and the filtergraph is built from numeric
input indices, so no source filename ever needs shell-style quoting or
escaping, however it's spelled.
"""
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("grimoire.audiobooks")

# Same binary as video_frames.py — one purpose-built ffmpeg serves both the
# animated-map thumbnailer and this converter.
FFMPEG_BINARY = os.environ.get("FFMPEG_BINARY", "/usr/local/bin/ffmpeg")

# A decode+encode pass runs at tens of times realtime even on modest hardware
# (a 15-hour audiobook is minutes of work), so this is only a guard against a
# wedged process, not a realistic ceiling for a legitimate conversion.
_FFMPEG_TIMEOUT = 6 * 3600

DEFAULT_BITRATE_KBPS = 64
MIN_BITRATE_KBPS = 32
MAX_BITRATE_KBPS = 256

# Normalisation target when joining multiple files (see convert_to_m4b): audio
# is resampled to this rate regardless of source, so the concat filter always
# sees matching streams even when the sources don't quite agree.
_JOIN_SAMPLE_RATE = 44100


class ConversionError(Exception):
    """Raised for anything that stops a conversion; message is user-facing."""


def ffmpeg_path() -> Optional[str]:
    """Absolute path to a usable ffmpeg, or None when the build has no codec support.

    Falls back to ``PATH`` so a developer running outside Docker gets a working
    converter from whatever ffmpeg they already have installed.
    """
    if os.path.isfile(FFMPEG_BINARY) and os.access(FFMPEG_BINARY, os.X_OK):
        return FFMPEG_BINARY
    return shutil.which("ffmpeg")


@dataclass
class SourceTrack:
    path: str
    title: str
    duration: float  # seconds
    channels: int


def probe_mp3(path: str) -> SourceTrack:
    """Read duration/channels/title via mutagen — the same library the indexer
    already uses for every other tag read, so this adds no new dependency."""
    from mutagen.mp3 import MP3

    try:
        audio = MP3(path)
    except Exception as e:
        raise ConversionError(f"Could not read '{os.path.basename(path)}': {e}") from e

    title = None
    if audio.tags is not None:
        frame = audio.tags.get("TIT2")
        if frame is not None and frame.text:
            title = str(frame.text[0]).strip() or None
    if not title:
        title = os.path.splitext(os.path.basename(path))[0]

    return SourceTrack(
        path=path,
        title=title,
        duration=float(audio.info.length),
        channels=int(getattr(audio.info, "channels", 2) or 2),
    )


def _extract_id3_chapters(path: str) -> Optional[list[dict]]:
    """Chapters already embedded as ID3 CHAP/CTOC frames, if any.

    Some audiobook rips (particularly ones exported from podcast tooling)
    carry real chapter markers this way; when present they beat any
    duration-based guess. Returns None — not an empty list — when the file
    has no CTOC at all, so the caller can fall back to fixed-duration
    splitting only for "no chapter data", not for "a table of contents that
    happens to resolve to zero usable entries".
    """
    from mutagen.id3 import ID3

    try:
        id3 = ID3(path)
    except Exception:
        return None

    tocs = id3.getall("CTOC")
    if not tocs:
        return None

    chapters_by_id = {f.element_id: f for f in id3.getall("CHAP")}
    chapters = []
    for element_id in tocs[0].child_element_ids:
        chap = chapters_by_id.get(element_id)
        if chap is None:
            continue
        title = element_id
        for sub in getattr(chap, "sub_frames", None) or []:
            if getattr(sub, "FrameID", None) == "TIT2" and sub.text:
                title = str(sub.text[0])
                break
        chapters.append(
            {"start_ms": int(chap.start_time), "end_ms": int(chap.end_time), "title": title}
        )
    return chapters or None


def _escape_ffmetadata(value: str) -> str:
    """Escape a value for the FFMETADATA1 text format: ``=``, ``;``, ``#``,
    ``\\`` and newlines all need a backslash or they get parsed as syntax."""
    return (
        value.replace("\\", "\\\\")
        .replace("=", "\\=")
        .replace(";", "\\;")
        .replace("#", "\\#")
        .replace("\n", "\\\n")
    )


def _build_ffmetadata(chapters: list[dict]) -> str:
    lines = [";FFMETADATA1"]
    for chapter in chapters:
        lines.append("[CHAPTER]")
        lines.append("TIMEBASE=1/1000")
        lines.append(f"START={int(chapter['start_ms'])}")
        lines.append(f"END={int(chapter['end_ms'])}")
        lines.append(f"title={_escape_ffmetadata(chapter['title'])}")
    return "\n".join(lines) + "\n"


def _fixed_duration_chapters(total_seconds: float, chapter_minutes: int, base_title: str) -> list[dict]:
    step_ms = max(1, chapter_minutes) * 60_000
    total_ms = round(total_seconds * 1000)
    chapters = []
    start = 0
    n = 1
    while start < total_ms:
        end = min(start + step_ms, total_ms)
        chapters.append({"start_ms": start, "end_ms": end, "title": f"{base_title} ({n})"})
        start = end
        n += 1
    return chapters or [{"start_ms": 0, "end_ms": total_ms, "title": base_title}]


def plan_chapters(tracks: list[SourceTrack], chapter_minutes: Optional[int]) -> list[dict]:
    """Decide chapter marks for the combined output stream.

    Multiple tracks (a join): one chapter per source file, in the given order,
    using each file's own title. A single track: its own embedded ID3
    chapters if it has any, else a fixed ``chapter_minutes`` split, else the
    whole book as one chapter.
    """
    if len(tracks) > 1:
        chapters = []
        cursor_ms = 0
        for track in tracks:
            dur_ms = round(track.duration * 1000)
            chapters.append(
                {"start_ms": cursor_ms, "end_ms": cursor_ms + dur_ms, "title": track.title}
            )
            cursor_ms += dur_ms
        return chapters

    track = tracks[0]
    embedded = _extract_id3_chapters(track.path)
    if embedded:
        return embedded
    if chapter_minutes:
        return _fixed_duration_chapters(track.duration, chapter_minutes, track.title)
    return [{"start_ms": 0, "end_ms": round(track.duration * 1000), "title": track.title}]


def convert_to_m4b(
    source_paths: list[str],
    dest_path: str,
    *,
    chapter_minutes: Optional[int] = None,
    bitrate_kbps: int = DEFAULT_BITRATE_KBPS,
) -> dict:
    """Join/convert *source_paths* (in order) into one chaptered m4b at *dest_path*.

    Raises ConversionError on any failure (missing ffmpeg, unreadable source,
    ffmpeg exiting non-zero). Never leaves a partial file at *dest_path* — the
    encode lands at a ``.tmp`` sibling first and is only renamed into place on
    success.
    """
    if not source_paths:
        raise ConversionError("No source files given.")

    exe = ffmpeg_path()
    if exe is None:
        raise ConversionError(
            "No ffmpeg with mp3/AAC support is available. Rebuild the Docker "
            "image (it bundles one) or set FFMPEG_BINARY to point at a system "
            "ffmpeg for local development."
        )

    bitrate_kbps = max(
        MIN_BITRATE_KBPS, min(MAX_BITRATE_KBPS, int(bitrate_kbps or DEFAULT_BITRATE_KBPS))
    )

    tracks = [probe_mp3(p) for p in source_paths]
    chapters = plan_chapters(tracks, chapter_minutes)

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    meta_path = dest_path + ".chapters.tmp.txt"
    tmp_dest = dest_path + ".tmp"

    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            f.write(_build_ffmetadata(chapters))

        cmd = [exe, "-y", "-nostdin", "-loglevel", "error"]
        for track in tracks:
            cmd += ["-i", track.path]
        meta_input_index = len(tracks)
        cmd += ["-i", meta_path]

        if len(tracks) > 1:
            layout = "mono" if all(t.channels == 1 for t in tracks) else "stereo"
            graph_parts = []
            labels = []
            for i in range(len(tracks)):
                graph_parts.append(
                    f"[{i}:a]aformat=sample_fmts=fltp:sample_rates={_JOIN_SAMPLE_RATE}:"
                    f"channel_layouts={layout}[a{i}]"
                )
                labels.append(f"[a{i}]")
            graph_parts.append("".join(labels) + f"concat=n={len(tracks)}:v=0:a=1[outa]")
            cmd += ["-filter_complex", ";".join(graph_parts), "-map", "[outa]"]
        else:
            cmd += ["-map", "0:a"]

        cmd += [
            "-map_metadata", str(meta_input_index),
            "-c:a", "aac",
            "-b:a", f"{bitrate_kbps}k",
            "-f", "ipod",
            tmp_dest,
        ]

        logger.info("Converting %d source file(s) to '%s'", len(tracks), dest_path)
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_TIMEOUT, check=False)
        except subprocess.TimeoutExpired as e:
            raise ConversionError("ffmpeg timed out.") from e
        except OSError as e:
            raise ConversionError(f"Could not run ffmpeg: {e}") from e

        if proc.returncode != 0 or not os.path.exists(tmp_dest):
            detail = proc.stderr.decode("utf-8", "replace").strip()[-2000:]
            raise ConversionError(f"ffmpeg failed: {detail or 'unknown error'}")

        os.replace(tmp_dest, dest_path)
    finally:
        for tmp in (meta_path, tmp_dest):
            try:
                os.remove(tmp)
            except OSError:
                pass

    return {
        "dest_path": dest_path,
        "duration": sum(t.duration for t in tracks),
        "chapter_count": len(chapters),
        "bitrate_kbps": bitrate_kbps,
    }
