"""Cover art + metadata lookup against Audible's public catalog search.

Not the "audible-cover-grabber" browser extension the feature request linked
to -- that extension only works by riding along on an already-open
audible.com book page in the user's own browser, which is not something a
server-side call can do. What it (and every self-hosted audiobook app: Audio-
bookshelf, LazyLibrarian, and friends) actually rides on underneath is
Audible's own public catalog search endpoint, which needs no login and no API
key for a basic keyword search -- so this hits that directly instead.

This is a *server-side reimplementation of the same public API*, not a
Grimoire login to Audible: no credentials are involved, and only the search/
catalog endpoint is used (never anything under a signed-in account).

Best-effort throughout: Audible's response shape is not officially
documented (this is the same reverse-engineered API every open-source
audiobook tool uses), so every field read is defensive and a missing/
unexpected shape degrades to an empty value rather than raising.
"""
import logging
from typing import Optional
from urllib.parse import urlparse

import httpx

from ._text_utils import html_to_text

logger = logging.getLogger("grimoire.audible_lookup")

# The US storefront. Region only matters for availability/pricing, which this
# never touches -- title/author/narrator/series/cover data is the same
# catalog entry regardless, so there is no per-user region to plumb through.
_CATALOG_URL = "https://api.audible.com/1.0/catalog/products"
# product_desc alone only earns the search endpoint a short marketing blurb
# per result (`merchandising_summary`, truncated with "..."). Adding
# product_extended_attrs pulls in the *full* publisher-provided description
# (`publisher_summary`) for every result in this same call -- no per-result
# follow-up request needed to fill in a candidate's description.
_RESPONSE_GROUPS = (
    "contributors,media,product_desc,product_attrs,series,category_ladders,"
    "product_extended_attrs"
)

# Hosts an "apply this cover" request is allowed to fetch from. This endpoint
# takes a URL from the caller (the frontend, echoing one of our own search
# results) and fetches it server-side, so it is restricted to known
# catalog/image hosts rather than left as an open fetch of any URL an admin
# happens to paste in. Shared across every metadata source (see
# services/metadata_lookup.py) since this same function is the one gateway
# apply_audiobook_cover_from_url uses regardless of which source a candidate
# came from -- so each source's own image CDN needs an entry here, not just
# Audible/Amazon's:
#   - media-amazon.com / amazon.com: Audible covers, and Audnexus's own
#     `image` field (it passes through Amazon's CDN rather than hosting its
#     own copies).
#   - mzstatic.com: Apple/iTunes artwork.
#   - books.google.com / books.googleusercontent.com: Google Books thumbnails.
#   - covers.openlibrary.org: Open Library cover images.
_ALLOWED_IMAGE_HOSTS = (
    "media-amazon.com",
    "amazon.com",
    "mzstatic.com",
    "books.google.com",
    "books.googleusercontent.com",
    "covers.openlibrary.org",
)


class LookupError(Exception):
    """Audible could not be reached, or returned something unusable."""


def search_audible(query: str, num_results: int = 10) -> list[dict]:
    """Search Audible's catalog by free-text `query`. Raises LookupError on failure."""
    params = {
        "keywords": query,
        "num_results": max(1, min(num_results, 25)),
        "products_sort_by": "Relevance",
        "response_groups": _RESPONSE_GROUPS,
        "image_sizes": "500,1024",
    }
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(_CATALOG_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise LookupError(f"Audible search failed: {exc}") from exc

    products = data.get("products") or []
    results = []
    for item in products:
        try:
            results.append(_normalize(item))
        except Exception as exc:  # noqa: BLE001 -- one odd result must not sink the rest
            logger.debug(f"Skipping unparseable Audible result: {exc}")
    return results


def _normalize(item: dict) -> dict:
    images = item.get("product_images") or {}
    cover_url = None
    if images:
        # Keys are size strings ("500", "1024", …); take the largest available
        # rather than assuming a fixed size is present.
        best = max(images, key=lambda k: int(k) if str(k).isdigit() else -1)
        cover_url = images.get(best)

    authors = [a.get("name", "").strip() for a in (item.get("authors") or [])]
    narrators = [n.get("name", "").strip() for n in (item.get("narrators") or [])]

    series_list = item.get("series") or []
    series_name = ""
    series_index: Optional[float] = None
    if series_list:
        first = series_list[0] or {}
        series_name = (first.get("title") or "").strip()
        try:
            series_index = float(first.get("sequence"))
        except (TypeError, ValueError):
            series_index = None

    genres: list[str] = []
    for ladder in item.get("category_ladders") or []:
        for rung in ladder.get("ladder") or []:
            name = (rung.get("name") or "").strip()
            if name and name not in genres:
                genres.append(name)

    year = None
    release_date = item.get("release_date") or ""
    if len(release_date) >= 4 and release_date[:4].isdigit():
        year = int(release_date[:4])

    # publisher_summary is the full description; merchandising_summary (a
    # shorter marketing blurb, often truncated with "...") only fills in for
    # the rare item missing the former.
    description = html_to_text(item.get("publisher_summary") or item.get("merchandising_summary") or "")

    asin = item.get("asin", "") or ""
    return {
        # "source"/"source_id" let a multi-source result list (see
        # services/metadata_lookup.py) tell candidates apart and re-key a
        # picked one even when two sources both leave "asin" blank.
        "source": "audible",
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
        "cover_url": cover_url,
        "runtime_minutes": item.get("runtime_length_min"),
        "description": description,
    }


def fetch_image(url: str) -> tuple[bytes, str]:
    """Fetch an image from `url`. Raises LookupError if it isn't one of ours to fetch."""
    host = (urlparse(url).hostname or "").lower()
    if urlparse(url).scheme != "https" or not any(
        host == h or host.endswith("." + h) for h in _ALLOWED_IMAGE_HOSTS
    ):
        raise LookupError(f"Refusing to fetch image from untrusted host: {host!r}")
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise LookupError(f"Could not fetch cover image: {exc}") from exc

    mime = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    if not mime.startswith("image/"):
        raise LookupError(f"URL did not return an image (got {mime!r})")
    data = resp.content
    if len(data) > 15 * 1024 * 1024:
        raise LookupError("Cover image is too large (over 15MB)")
    return data, mime
