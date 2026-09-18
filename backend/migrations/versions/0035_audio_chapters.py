"""audio chapters: chapter markers for audiobook-style M4A/M4B files

Adds ``audio.chapters`` — a JSON list of ``{"title", "start", "end"}`` (start/
end in seconds), read from the MP4 chapter box via ffmpeg's ffmetadata export
(see indexer/audio_chapters.py; mutagen has no API for it). NULL for every
row until the next rescan populates it, and NULL/empty forever for anything
that isn't an M4A/M4B or carries no embedded chapters — this is display data,
not something the app fills in synthetically.

Revision ID: f28c4a915e73
Revises: e4b81f60a9c2
Create Date: 2026-09-18 00:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "f28c4a915e73"
down_revision: Union[str, None] = "e4b81f60a9c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _audio_columns() -> set:
    return {c["name"] for c in inspect(op.get_bind()).get_columns("audio")}


def upgrade() -> None:
    if "chapters" not in _audio_columns():
        op.add_column(
            "audio",
            sa.Column("chapters", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    if "chapters" in _audio_columns():
        op.drop_column("audio", "chapters")
