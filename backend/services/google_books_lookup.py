"""Cover art + description lookup against Google Books' public Volumes API.

Official, documented, and needs no API key for a basic search (a key only
raises the daily quota, which this light, on-demand use doesn't need):
https://developers.google.com/books/docs/v1/using#WorkingVolumes
Used as a fallback for titles neither Audible nor Audnexus have -- self-
published and small-press audiobooks often exist as a Google Books catalog
entry (with a real description and cover) well before, or instead of, an
Audible listing.

Google Books is a *book* database, not an audiobook one: it has no narrator,
series, or runtime fields at all, so those are always left blank here --
only title/author/genres/cover/description are populated.
"""
import logging
from typing import Optional

import httpx

from ._text_utils import html_to_text

logger = logging.getLogger("grimoire.google_books_lookup")

_SEARCH_URL = "https://www.googleapis.com/books/v1/volumes"


class LookupError(Exception):
    """Google Books could not be reached, or returned something unusable."""


def search(query: str, num_results: int = 10) -> list[dict]:
    """Search Google Books by free-text `query`."""
    params = {"q": query, "maxResults": max(1, min(num_results, 40))}
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(_SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise LookupError(f"Google Books search failed: {exc}") from exc

    items = data.get("items") or []
    results = []
    for item in items:
        try:
            results.append(_normalize(item))
        except Exception as exc:  # noqa: BLE001 -- one odd result must not sink the rest
            logger.debug(f"Skipping unparseable Google Books result: {exc}")
    return results


def _cover_url(image_links: dict) -> Optional[str]:
    url = image_links.get("thumbnail") or image_links.get("smallThumbnail")
    if not url:
        return None
    # Google serves these over http:// by default, with a curled-page-edge
    # overlay (zoom=1); force https (the CSP only allows https image sources)
    # and drop the overlay for a clean cover.
    return url.replace("http://", "https://").replace("zoom=1", "zoom=0")


def _normalize(item: dict) -> dict:
    info = item.get("volumeInfo") or {}

    year = None
    published = info.get("publishedDate") or ""
    if len(published) >= 4 and published[:4].isdigit():
        year = int(published[:4])

    return {
        "source": "google_books",
        "source_id": item.get("id", "") or "",
        "asin": "",
        "title": (info.get("title") or "").strip(),
        "subtitle": (info.get("subtitle") or "").strip(),
        "authors": [a.strip() for a in (info.get("authors") or []) if a and a.strip()],
        "narrators": [],
        "series": "",
        "series_index": None,
        "year": year,
        "genres": [c for c in (info.get("categories") or []) if c],
        "cover_url": _cover_url(info.get("imageLinks") or {}),
        "runtime_minutes": None,
        "description": html_to_text(info.get("description") or ""),
    }
