"""Fan out a metadata search across every configured source.

Originally "Find on Audible" hit only services/audible_lookup.py. This adds
Audnexus, iTunes, Google Books, and Open Library (see their own module
docstrings for what each contributes and why) behind one merged search, so
the picker in EditAudiobookMetadataModal.jsx shows candidates from all of
them without the frontend needing to know how many sources exist or call
each one itself.

Each source's `search(query, num_results)` is an independent blocking HTTP
call, so they run concurrently in a thread pool -- total latency stays close
to the slowest single source rather than their sum. One source failing
(timeout, shape change, service down) never sinks the others: only if every
source fails does this raise, so a user still gets Audible/Audnexus results
on a day Open Library happens to be unreachable.

Merged order is priority, not relevance-interleaved: audiobook-specific,
narrator/series-aware sources (Audible, Audnexus) come first, iTunes (a
genuinely independent catalog, but thinner data) next, then the two general
book catalogs (Google Books, Open Library) used as a last-resort fallback for
titles the audiobook-specific sources don't have.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from . import audible_lookup, audnexus_lookup, google_books_lookup, itunes_lookup, openlibrary_lookup

logger = logging.getLogger("grimoire.metadata_lookup")

# (source key, search fn) in the priority order results are grouped by.
# audible_lookup's search function predates the `search(query, num_results)`
# convention the newer modules share (it's named `search_audible`), so it's
# referenced directly here rather than requiring a rename of an
# already-shipped, working module.
_SOURCES: list[tuple[str, Callable[[str, int], list[dict]]]] = [
    ("audible", audible_lookup.search_audible),
    ("audnexus", audnexus_lookup.search),
    ("itunes", itunes_lookup.search),
    ("google_books", google_books_lookup.search),
    ("open_library", openlibrary_lookup.search),
]


class LookupError(Exception):
    """Every configured source failed -- nothing to show the caller."""


def search_all(query: str, num_results: int = 10) -> list[dict]:
    """Search every source for `query`, merged in source-priority order.

    Raises LookupError only if *every* source fails; a partial result (some
    sources returned nothing, or errored) is returned as-is so the user still
    gets whatever's available rather than an all-or-nothing failure.
    """
    results_by_source: dict[str, list[dict]] = {}
    errors: dict[str, str] = {}

    with ThreadPoolExecutor(max_workers=len(_SOURCES)) as pool:
        future_to_source = {
            pool.submit(search_fn, query, num_results): key for key, search_fn in _SOURCES
        }
        for future in as_completed(future_to_source):
            key = future_to_source[future]
            try:
                results_by_source[key] = future.result()
            except Exception as exc:  # noqa: BLE001 -- one source's failure must not sink the rest
                logger.warning(f"Metadata source '{key}' failed: {exc}")
                errors[key] = str(exc)

    if not results_by_source and errors:
        raise LookupError(
            "All metadata sources failed: " + "; ".join(f"{k}: {v}" for k, v in errors.items())
        )

    merged: list[dict] = []
    for key, _search_fn in _SOURCES:
        merged.extend(results_by_source.get(key, []))
    return merged
