"""audiobooks: a sixth collection, sibling to Audio

Audiobooks get their own top-level library folder (``library/audiobooks/``)
and their own tables, scanned and browsed independently of Audio even though
both can hold ``.m4b`` files with embedded chapter markers. This is a
deliberate, non-migrating split: existing ``.m4b`` files already catalogued
under Audio stay there untouched by this migration — a title only becomes an
Audiobook once its file is moved into the new folder and picked up by a
rescan. See the note on the ``Audiobook`` model for the reasoning.

Creates ``audiobooks`` and its folder-tag table, matching the shape of
``audio``: the same content-identity columns (``content_hash`` +
``file_mtime``), the same embedded-metadata columns (``duration``, ``title``,
``artist``, ``album``), the same ``chapters`` JSON column (read the same way
as Audio's — see indexer/audio_chapters.py), the same soft variant grouping,
and the same ``is_missing`` flag. Unlike ``audio`` there is no
``cover_image`` column: Audiobooks v1 only resolves folder/embedded artwork
(``has_artwork``), read-only, with no UI-uploaded cover.

Revision ID: d93a6f1c2b47
Revises: f28c4a915e73
Create Date: 2026-09-19 00:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "d93a6f1c2b47"
down_revision: Union[str, None] = "f28c4a915e73"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(inspect(op.get_bind()).get_table_names())

    if "audiobooks" not in tables:
        op.create_table(
            "audiobooks",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("filename", sa.String(length=500), nullable=False),
            sa.Column("filepath", sa.String(length=1000), nullable=False, unique=True),
            sa.Column("relative_path", sa.String(length=1000), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("duration", sa.Float(), nullable=True),
            sa.Column("title", sa.String(length=500), nullable=True),
            sa.Column("artist", sa.String(length=500), nullable=True),
            sa.Column("album", sa.String(length=500), nullable=True),
            sa.Column("chapters", sa.JSON(), nullable=True),
            sa.Column("has_artwork", sa.Boolean(), nullable=True),
            sa.Column("file_size", sa.Integer(), nullable=True),
            sa.Column("content_hash", sa.String(length=64), nullable=True),
            sa.Column("file_mtime", sa.Float(), nullable=True),
            sa.Column("variant_parent_id", sa.String(length=36), nullable=True),
            sa.Column("variant_kind", sa.String(length=30), nullable=True),
            sa.Column("variant_label", sa.String(length=120), nullable=True),
            sa.Column("is_missing", sa.Boolean(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_audiobooks_content_hash", "audiobooks", ["content_hash"]
        )
        op.create_index(
            "ix_audiobooks_variant_parent_id", "audiobooks", ["variant_parent_id"]
        )

    if "audiobook_folders" not in tables:
        op.create_table(
            "audiobook_folders",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("path", sa.String(length=1000), nullable=False, unique=True),
            sa.Column("tags", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    # These tables are this revision's own creation, so reversing it drops them.
    existing = set(inspect(op.get_bind()).get_table_names())
    for table in ("audiobook_folders", "audiobooks"):
        if table in existing:
            op.drop_table(table)
