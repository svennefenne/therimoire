"""Small text-normalization helpers shared by the metadata lookup services.

Split out of services/audible_lookup.py so the other lookup modules (Audnexus,
Google Books, ...) that also hand back simple HTML description fields can
reuse the same conversion instead of each rolling their own.
"""
import html
import re

# Audible/Audnexus/Google Books summary fields are simple `<p>`-per-paragraph
# HTML (occasionally a `<br/>`, rarely `<b>`/`<i>`) -- not worth a
# markup-parsing dependency for. `</p>`/`<br>` become the paragraph breaks a
# plain description textarea wants; every other tag is just dropped, leaving
# whatever text it wrapped.
_BLOCK_BREAK_RE = re.compile(r"(?i)</p\s*>|<br\s*/?>")
_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(markup: str) -> str:
    """Plain-text paragraphs from a source's HTML summary/description field."""
    if not markup:
        return ""
    normalized = _BLOCK_BREAK_RE.sub("\n", markup)
    stripped = _TAG_RE.sub("", normalized)
    text = html.unescape(stripped)
    paragraphs = [p.strip() for p in text.split("\n")]
    return "\n\n".join(p for p in paragraphs if p)
