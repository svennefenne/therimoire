"""Cover art + metadata lookup against Apple's public iTunes Search API.

Official, documented, and requires no API key or auth for a basic keyword
search:
https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
Used here as a genuinely independent catalog from Audible/Amazon (Audnexus is
Audible data underneath; this isn't) -- useful for titles that never made it
onto Audible, or as a cross-check.

Apple's audiobook metadata is thinner than Audible's: there's no reliable
narrator or series field (`artistName` conflates author/narrator in whatever
way the publisher entered it, and `collectionName` is not consistently a
series name), so this only fills in what iTunes actually gives cleanly --
title, author, cover, description, runtime, genres -- and leaves narrator/
series blank rather than guess.
"""
import logging
from typing import Optional

import httpx

from ._text_utils import html_to_text

logger = logging.getLogger("grimoire.itunes_lookup")

_SEARCH_URL = "https://itunes.apple.com/search"


class LookupError(Exception):
    """iTunes Search could not be reached, or returned something unusable."""


def search(query: str, num_results: int = 10) -> list[dict]:
    """Search iTunes's audiobook catalog by free-text `query`."""
    params = {
        "term": query,
        "media": "audiobook",
        "entity": "audiobook",
        "limit": max(1, min(num_results, 25)),
    }
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(_SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise LookupError(f"iTunes search failed: {exc}") from exc

    items = data.get("results") or []
    results = []
    for item in items:
        try:
            results.append(_normalize(item))
        except Exception as exc:  # noqa: BLE001 -- one odd result must not sink the rest
            logger.debug(f"Skipping unparseable iTunes result: {exc}")
    return results


def _upsize_artwork(url: Optional[str]) -> Optional[str]:
    """Apple's artwork URLs encode the thumbnail size in the filename (e.g.
    .../100x100bb.jpg); swapping in a larger size is the documented trick to
    get a real cover image instead of a postage-stamp thumbnail."""
    if not url:
        return None
    for small in ("100x100bb", "60x60bb"):
        if small in url:
            return url.replace(small, "600x600bb")
    return url


def _normalize(item: dict) -> dict:
    year = None
    release_date = item.get("releaseDate") or ""
    if len(release_date) >= 4 and release_date[:4].isdigit():
        year = int(release_date[:4])

    runtime_ms = item.get("trackTimeMillis")
    runtime_minutes = int(runtime_ms / 60000) if isinstance(runtime_ms, (int, float)) else None

    author = (item.get("artistName") or "").strip()
    # "Audiobooks" is Apple's own top-level media category, present on every
    # result -- not a useful genre tag once we already know these are all
    # audiobooks.
    genres = [g for g in (item.get("genres") or []) if g and g != "Audiobooks"]

    source_id = item.get("trackId") or item.get("collectionId") or ""

    return {
        "source": "itunes",
        "source_id": str(source_id),
        "asin": "",
        "title": (item.get("trackName") or item.get("collectionName") or "").strip(),
        "subtitle": "",
        "authors": [author] if author else [],
        "narrators": [],
        "series": "",
        "series_index": None,
        "year": year,
        "genres": genres,
        "cover_url": _upsize_artwork(item.get("artworkUrl100") or item.get("artworkUrl60")),
        "runtime_minutes": runtime_minutes,
        "description": html_to_text(item.get("description") or item.get("longDescription") or ""),
    }
