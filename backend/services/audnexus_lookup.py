"""Metadata lookup against Audnexus (api.audnex.us).

A free, no-auth audiobook data aggregator that harmonizes multiple sources --
chiefly Audible's own catalog, resolved server-side via region ADP tokens --
into one consistently-shaped JSON response. See services/audible_lookup.py's
module docstring for the general caveat about hitting a third-party API: this
one publishes an OpenAPI spec, but it has changed shape before (its search
path moved from `/books?q=` to `/books/search?q=` at one point), so every
field read here is defensive, same as audible_lookup -- a missing/unexpected
shape degrades to an empty value rather than raising.

This complements the direct Audible search in audible_lookup.py rather than
replacing it: Audnexus is itself mostly Audible data underneath, so it isn't
an independent second opinion, but it fills gaps -- a more consistently
populated narrator list, chapter-aware runtime -- and is a useful fallback if
Audible's own catalog endpoint ever changes shape again.
"""
import logging
from typing import Optional

import httpx

from ._text_utils import html_to_text

logger = logging.getLogger("grimoire.audnexus_lookup")

_SEARCH_URL = "https://api.audnex.us/books/search"
# Region selects which storefront's catalog Audnexus searches server-side;
# "us" matches the default storefront services/audible_lookup.py's own direct
# Audible search implicitly uses, so results line up between the two sources.
_REGION = "us"


class LookupError(Exception):
    """Audnexus could not be reached, or returned something unusable."""


def search(query: str, num_results: int = 10) -> list[dict]:
    """Search Audnexus by free-text `query`. Raises LookupError on failure."""
    params = {"q": query, "region": _REGION}
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(_SEARCH_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise LookupError(f"Audnexus search failed: {exc}") from exc

    # A bare single object (rather than a list) has been observed for some
    # exact-title matches -- normalize both shapes to a list defensively.
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = [data]
    else:
        items = []

    results = []
    for item in items[: max(1, min(num_results, 25))]:
        try:
            results.append(_normalize(item))
        except Exception as exc:  # noqa: BLE001 -- one odd result must not sink the rest
            logger.debug(f"Skipping unparseable Audnexus result: {exc}")
    return results


def _normalize(item: dict) -> dict:
    authors = [
        a.get("name", "").strip() for a in (item.get("authors") or []) if isinstance(a, dict)
    ]
    narrators = [
        n.get("name", "").strip() for n in (item.get("narrators") or []) if isinstance(n, dict)
    ]

    series_name = ""
    series_index: Optional[float] = None
    series_primary = item.get("seriesPrimary") or {}
    if isinstance(series_primary, dict):
        series_name = (series_primary.get("name") or "").strip()
        try:
            series_index = float(series_primary.get("position"))
        except (TypeError, ValueError):
            series_index = None

    genres: list[str] = []
    for g in item.get("genres") or []:
        name = (g.get("name") or "").strip() if isinstance(g, dict) else ""
        if name and name not in genres:
            genres.append(name)

    year = None
    release_date = item.get("releaseDate") or ""
    if len(release_date) >= 4 and release_date[:4].isdigit():
        year = int(release_date[:4])

    description = html_to_text(item.get("summary") or item.get("description") or "")

    asin = item.get("asin", "") or ""
    return {
        "source": "audnexus",
        "source_id": asin,
        "asin": asin,
        "title": (item.get("title") or "").strip(),
        "subtitle": (item.get("subtitle") or "").strip(),
        "authors": [a for a in authors if a],
        "narrators": [n for n in narrators if n],
        "series": series_name,
        "series_index": series_index,
        "year": year,
        "genres": genres,
        "cover_url": item.get("image") or None,
        "runtime_minutes": item.get("runtimeLengthMin"),
        "description": description,
    }
