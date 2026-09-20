"""Spoken chapter-marker detection for audiobooks with no embedded chapters.

Some audiobook rips - typically a single mp3 converted straight to m4b with no
ID3 CHAP/CTOC frames - carry no chapter data of any kind, so read_chapters()
(audio_chapters.py) always comes back empty and the whole book plays as one
giant chapter. There is no metadata to recover here: the only place a chapter
boundary exists is spoken out loud by the narrator ("Chapter One", "Chapter
Two", ...), so finding one means listening for it.

Transcribing the whole book would work but is needlessly slow - a full
speech-to-text pass over a 10+ hour file is the actually expensive part of any
"listen for chapter markers" approach. Chapter breaks in narrated audio are
reliably preceded by a longer pause than ordinary speech, so this instead:

  1. Runs ffmpeg's `silencedetect` filter once over the whole file (a single
     fast pass - it never decodes to a real sink or writes output, it just
     watches sample amplitude) to get every pause that could plausibly be a
     chapter break.
  2. Extracts a short clip after each candidate pause and runs *only that
     clip* through an offline speech-to-text engine (Vosk), instead of the
     whole book.
  3. Regex-matches the transcribed clip for "chapter <number>" (spelled out
     or digits) near the start of the clip, and keeps only numbers that
     increase monotonically - a stray "chapter twelve" spoken in dialogue
     later in the book, or a mis-heard number, rarely continues a strictly
     increasing sequence the way real chapter markers do.

A 10-hour book might have 100-200 silence candidates; each snippet is a few
seconds of audio, so the whole scan finishes in low single digit minutes on
modest hardware, not hours.

This is inherently best-effort - a narrator's cadence, ambient noise, or a
number Vosk mishears can all produce a wrong or missing boundary - so nothing
here writes to the database or touches the source file. detect_spoken_chapters()
only returns candidates for a caller (see audiobook_chapter_detect_jobs.py and
the /audiobooks/{id}/chapters/detect endpoint) to apply or show for review.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger("grimoire.audiobooks")

# Same override knob as audio_chapters.py/video_frames.py, so a dev machine
# without the Docker image's binary still works from whatever ffmpeg it has.
FFMPEG_BINARY = os.environ.get("FFMPEG_BINARY", "/usr/local/bin/ffmpeg")

# Bundled in the runtime image at build time (see the Dockerfile's
# vosk-model stage); overridable for a dev machine that keeps the model
# somewhere else, or a different language's model.
VOSK_MODEL_PATH = os.environ.get(
    "VOSK_MODEL_PATH", "/app/models/vosk-model-small-en-us-0.15"
)

# One pass over the whole file for silence detection - same order of
# magnitude budget as the mp3->m4b conversion job for a comparably long file.
_SILENCE_TIMEOUT = 6 * 3600
# A single ~10s snippet extraction should return in well under this.
_SNIPPET_TIMEOUT = 30

# Candidate pauses shorter than this are ordinary speech rhythm, not a
# section break; audiobook chapter breaks are routinely 1.5s+ of near-silence.
DEFAULT_MIN_SILENCE = 1.2
# -30dB is quiet-room-noise-floor territory for a studio narration track; a
# noisier rip may need a caller to pass a lower (more negative) value.
DEFAULT_NOISE_FLOOR_DB = -30.0

# How much audio to transcribe after each candidate pause. Long enough to
# catch a musical sting or a beat of narration before "Chapter Twenty-One" is
# actually spoken (a produced audiobook with sound design between chapters,
# not just a plain narration track, routinely has one), short enough that a
# book with hundreds of candidates still finishes in minutes rather than
# hours.
SNIPPET_SECONDS = 14.0
# Start slightly before the measured silence end, since silencedetect's
# threshold crossing can land a fraction of a second after speech is
# audibly already underway.
SNIPPET_LEAD_IN = 0.4

# Two candidates within this many seconds of each other are almost certainly
# the same spoken phrase caught by more than one silence gap (a narrator
# pause mid-sentence right after "Chapter Twelve", say) rather than two
# distinct chapters.
MIN_CHAPTER_GAP_SECONDS = 20.0

# Defensive ceiling on how many silence candidates get transcribed. A
# pathologically quiet or noisy file could otherwise turn up thousands of
# "silences" and turn a few-minute scan into a multi-hour one; a genuine
# audiobook chapter count never approaches this.
MAX_SILENCE_CANDIDATES = 600

_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_TEENS = {
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen",
}

# Matches "chapter" (Vosk's small model emits lowercase, unpunctuated text,
# but a trailing "." is tolerated in case a future model adds punctuation)
# followed by up to three words of a spelled-out or digit number.
_CHAPTER_RE = re.compile(
    r"\bchapter\.?\s+((?:\d+)|(?:[a-z]+(?:[\s-][a-z]+){0,2}))\b", re.I
)
# Only accept a match reasonably near the front of a snippet's transcript - a
# "chapter" found deep into a snippet belongs to whatever sentence was
# already playing when the clip started, not to the pause this snippet was
# extracted for. Loose enough to tolerate a few words of transcribed noise
# from a musical sting ahead of the actual announcement.
_MATCH_POSITION_LIMIT = 80

_SILENCE_END_RE = re.compile(r"silence_end:\s*([\d.]+)")


def _parse_spoken_number(text: str) -> Optional[int]:
    """"twenty one" / "twenty-one" / "21" -> 21. None if text isn't a number."""
    text = text.strip().lower().replace("-", " ")
    if not text:
        return None
    if text.isdigit():
        return int(text)
    words = text.split()
    if len(words) == 1:
        return _NUMBER_WORDS.get(words[0])
    if len(words) == 2 and words[0] in _NUMBER_WORDS and words[0] not in _TEENS:
        tens, ones = _NUMBER_WORDS.get(words[0]), _NUMBER_WORDS.get(words[1])
        if tens and tens % 10 == 0 and ones and ones < 10:
            return tens + ones
    return None


@dataclass
class ChapterCandidate:
    start: float  # seconds
    number: int
    raw_text: str


class ChapterDetectError(Exception):
    """Raised for anything that stops detection; message is user-facing."""


def ffmpeg_path() -> Optional[str]:
    if os.path.isfile(FFMPEG_BINARY) and os.access(FFMPEG_BINARY, os.X_OK):
        return FFMPEG_BINARY
    return shutil.which("ffmpeg")


def detect_silences(
    filepath: str,
    *,
    noise_db: float = DEFAULT_NOISE_FLOOR_DB,
    min_duration: float = DEFAULT_MIN_SILENCE,
) -> list[float]:
    """Timestamps (seconds) where a silence gap ends - each a candidate chapter start.

    A single ffmpeg pass with the silencedetect filter, real output discarded
    (-f null): it reports through stderr and never writes anything to disk.
    """
    exe = ffmpeg_path()
    if exe is None:
        raise ChapterDetectError(
            "No ffmpeg with an AAC decoder is available. Rebuild the Docker "
            "image (it bundles one) or set FFMPEG_BINARY to point at a system "
            "ffmpeg for local development."
        )

    cmd = [
        exe, "-nostdin", "-loglevel", "info",
        "-i", filepath,
        # Audio only: an audiobook's embedded cover art rides along as an
        # "attached pic" video stream (and some carry a subtitle/data stream
        # too), and ffmpeg auto-maps one stream of every type it can into the
        # output by default — for a video stream into a `null` output, that
        # means picking an encoder for it, which this build doesn't have one
        # registered for. -vn/-sn/-dn drops all three so only the actual
        # audio ever reaches the filter.
        "-vn", "-sn", "-dn",
        "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}",
        "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_SILENCE_TIMEOUT, check=False)
    except subprocess.TimeoutExpired as e:
        raise ChapterDetectError("ffmpeg timed out scanning for silence.") from e
    except OSError as e:
        raise ChapterDetectError(f"Could not run ffmpeg: {e}") from e

    text = proc.stderr.decode("utf-8", "replace")
    ends = [float(m.group(1)) for m in _SILENCE_END_RE.finditer(text)]
    if proc.returncode != 0 and not ends:
        detail = text.strip()[-2000:]
        raise ChapterDetectError(
            f"ffmpeg failed reading '{os.path.basename(filepath)}': {detail or 'unknown error'}"
        )
    return ends


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _extract_snippet_wav(filepath: str, start: float, duration: float) -> Optional[str]:
    """A mono 16kHz PCM WAV of [start, start+duration) at a temp path, or None on failure.

    16kHz mono is Vosk's expected input rate - the resample happens here via
    ffmpeg's swresample rather than asking Vosk to do it.
    """
    exe = ffmpeg_path()
    if exe is None:
        return None
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    cmd = [
        exe, "-nostdin", "-loglevel", "error",
        "-ss", f"{max(0.0, start):.3f}",
        "-i", filepath,
        "-t", f"{duration:.3f}",
        # Same reasoning as detect_silences: drop the cover-art video stream
        # (and any subtitle/data stream) so only audio is ever mapped — a wav
        # output has no encoder for either anyway, but there's no reason to
        # rely on ffmpeg's default stream selection sorting that out itself.
        "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-f", "wav", "-y", tmp_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_SNIPPET_TIMEOUT, check=False)
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.debug(f"Could not extract snippet at {start:.1f}s from {filepath}: {e}")
        _safe_remove(tmp_path)
        return None
    if proc.returncode != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
        _safe_remove(tmp_path)
        return None
    return tmp_path


_vosk_model = None  # lazily loaded once per process - a few hundred ms, reused across snippets


def _load_vosk_model():
    global _vosk_model
    if _vosk_model is not None:
        return _vosk_model
    if not os.path.isdir(VOSK_MODEL_PATH):
        raise ChapterDetectError(
            f"No speech-recognition model at '{VOSK_MODEL_PATH}'. Rebuild the "
            "Docker image (it bundles one) or set VOSK_MODEL_PATH for local "
            "development."
        )
    try:
        import vosk
    except ImportError as e:
        raise ChapterDetectError(
            "The 'vosk' package is not installed. Run `pip install -r "
            "backend/requirements.txt`."
        ) from e
    vosk.SetLogLevel(-1)  # Vosk logs straight to stderr by default; keep it quiet
    _vosk_model = vosk.Model(VOSK_MODEL_PATH)
    return _vosk_model


def _transcribe_wav(path: str) -> str:
    """Full-text transcript of a short mono 16kHz WAV via Vosk."""
    from vosk import KaldiRecognizer

    model = _load_vosk_model()
    with wave.open(path, "rb") as wf:
        recognizer = KaldiRecognizer(model, wf.getframerate())
        recognizer.SetWords(False)
        pieces = []
        while True:
            data = wf.readframes(4000)
            if not data:
                break
            if recognizer.AcceptWaveform(data):
                pieces.append(json.loads(recognizer.Result()).get("text", ""))
        pieces.append(json.loads(recognizer.FinalResult()).get("text", ""))
    return " ".join(p for p in pieces if p).strip()


def detect_spoken_chapters(
    filepath: str,
    *,
    noise_db: float = DEFAULT_NOISE_FLOOR_DB,
    min_duration: float = DEFAULT_MIN_SILENCE,
    should_stop: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[ChapterCandidate]:
    """Candidate chapter boundaries found by listening for spoken "Chapter N" markers.

    Returns candidates sorted by time, with a strictly increasing chapter
    number (a match that doesn't continue the sequence is dropped - see the
    module docstring). Never raises for an individual snippet's
    transcription failure (that snippet is just skipped); raises
    ChapterDetectError only for something that stops the whole scan (no
    ffmpeg, no model, the file itself unreadable).
    """
    silence_ends = detect_silences(filepath, noise_db=noise_db, min_duration=min_duration)
    if len(silence_ends) > MAX_SILENCE_CANDIDATES:
        logger.warning(
            f"{filepath}: {len(silence_ends)} silence candidates, capping at {MAX_SILENCE_CANDIDATES}"
        )
        silence_ends = silence_ends[:MAX_SILENCE_CANDIDATES]

    _load_vosk_model()  # fail fast, before spending time on ffmpeg snippet extraction

    candidates: list[ChapterCandidate] = []
    last_number: Optional[int] = None
    total = len(silence_ends)
    for i, end in enumerate(silence_ends):
        if should_stop is not None and should_stop():
            break
        if on_progress is not None:
            on_progress(i, total)

        snippet_start = max(0.0, end - SNIPPET_LEAD_IN)
        tmp_path = _extract_snippet_wav(filepath, snippet_start, SNIPPET_SECONDS)
        if tmp_path is None:
            continue
        try:
            text = _transcribe_wav(tmp_path)
        except Exception as exc:  # noqa: BLE001 - one bad snippet must not abort the scan
            logger.debug(f"Could not transcribe snippet at {snippet_start:.1f}s: {exc}")
            continue
        finally:
            _safe_remove(tmp_path)

        m = _CHAPTER_RE.search(text)
        if m is None or m.start() > _MATCH_POSITION_LIMIT:
            continue
        number = _parse_spoken_number(m.group(1))
        if number is None:
            continue
        if last_number is not None and number <= last_number:
            continue
        last_number = number
        candidates.append(ChapterCandidate(start=snippet_start, number=number, raw_text=text[:120]))

    if on_progress is not None:
        on_progress(total, total)

    return candidates


def candidates_to_chapters(candidates: list[ChapterCandidate], duration: float) -> list[dict]:
    """[ChapterCandidate, ...] -> the same {"title", "start", "end"} shape audio_chapters.py produces.

    A gap between 0 and the first detected chapter becomes its own leading
    "Introduction" chapter rather than being folded into Chapter 1 - most
    audiobooks have at least a few seconds of publisher/narrator credits
    before the story starts, and collapsing that into the first real chapter
    would misreport its length and progress percentage.
    """
    chapters: list[dict] = []
    if not candidates:
        return chapters

    if candidates[0].start > 3.0:
        chapters.append({"title": "Introduction", "start": 0.0, "end": round(candidates[0].start, 3)})

    for i, c in enumerate(candidates):
        end = candidates[i + 1].start if i + 1 < len(candidates) else duration
        chapters.append({"title": f"Chapter {c.number}", "start": round(c.start, 3), "end": round(end, 3)})
    return chapters
