"""audiobook curated metadata: author, narrator, series, series_index, year, genres

Adds the columns the new Edit Metadata pane reads and writes. These are
deliberately separate from the existing ``title``/``artist``/``album``, which
stay exactly as they were: a plain mirror of whatever the file's raw tags say,
refreshed by the indexer on every scan. The columns added here are Grimoire's
own curated layer on top -- NULL until a user opens the editor (or runs the
Audible lookup) for that title -- and saving them also writes the same values
into the file's own tags (see indexer/audio_tags.py), so a later rescan reads
back what was just saved instead of overwriting it.

Revision ID: c5e175a41e88
Revises: d93a6f1c2b47
Create Date: 2026-09-20 00:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "c5e175a41e88"
down_revision: Union[str, None] = "d93a6f1c2b47"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_COLUMNS = (
    ("author", sa.String(length=500)),
    ("narrator", sa.String(length=500)),
    ("series", sa.String(length=500)),
    ("series_index", sa.Float()),
    ("year", sa.Integer()),
    ("genres", sa.JSON()),
)


def upgrade() -> None:
    existing = {c["name"] for c in inspect(op.get_bind()).get_columns("audiobooks")}
    for name, col_type in _NEW_COLUMNS:
        if name not in existing:
            op.add_column("audiobooks", sa.Column(name, col_type, nullable=True))


def downgrade() -> None:
    existing = {c["name"] for c in inspect(op.get_bind()).get_columns("audiobooks")}
    for name, _ in reversed(_NEW_COLUMNS):
        if name in existing:
            op.drop_column("audiobooks", name)
