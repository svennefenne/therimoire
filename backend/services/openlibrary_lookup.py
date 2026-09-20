"""Cover art lookup against the Open Library search + covers APIs.

Official, documented, no API key or auth required:
https://openlibrary.org/dev/docs/api/search
Used as a last-resort fallback: Open Library's catalog skews toward older,
public-domain, and small-press titles that neither Audible nor Google Books
carry.

Its data is the thinnest of any source here -- no narrator, series, or
runtime field exists at all, and the search endpoint (unlike a per-work
detail fetch, which this deliberately avoids -- see audible_lookup.py's
module docstring on why an N+1 per-result request isn't worth it here either)
doesn't return a description. So only title/author/year/genre/cover populate.
"""
import logging

import httpx

logger = logging.getLogger("grimoire.openlibrary_lookup")

_SEARCH_URL = "https://openlibrary.org/search.json"
_COVER_URL = "https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"


class LookupError(Exception):
    """Open Library could not be reached, or returned something unusable."""


def search(query: str, num_results: int = 10) -> list[dict]:
    """Search Open Library by free-text `query`."""
    params = {
        "q": query,
        "limit": max(1, min(num_results, 25)),
        "fields": "key,title,subtitle,author_name,first_publish_year,cover_i,subject",
    }
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(_SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise LookupError(f"Open Library search failed: {exc}") from exc

    docs = data.get("docs") or []
    results = []
    for item in docs:
        try:
            results.append(_normalize(item))
        except Exception as exc:  # noqa: BLE001 -- one odd result must not sink the rest
            logger.debug(f"Skipping unparseable Open Library result: {exc}")
    return results


def _normalize(item: dict) -> dict:
    cover_id = item.get("cover_i")
    cover_url = _COVER_URL.format(cover_id=cover_id) if cover_id else None

    # `subject` can run to hundreds of loosely-related tags on a popular
    # work; cap it so one Open Library result doesn't dwarf every other
    # candidate's genre list.
    genres = [s for s in (item.get("subject") or [])[:8] if s]

    return {
        "source": "open_library",
        "source_id": (item.get("key") or "").strip(),
        "asin": "",
        "title": (item.get("title") or "").strip(),
        "subtitle": (item.get("subtitle") or "").strip(),
        "authors": [a.strip() for a in (item.get("author_name") or []) if a and a.strip()],
        "narrators": [],
        "series": "",
        "series_index": None,
        "year": item.get("first_publish_year"),
        "genres": genres,
        "cover_url": cover_url,
        "runtime_minutes": None,
        "description": "",
    }
