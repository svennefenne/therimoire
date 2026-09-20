"""audiobook progress: per-user playback position, for resume-on-play

Adds the audiobook_progress table (models/users.py: AudiobookProgress). One
row per (user, audiobook); "not started" is modelled by the row's absence
rather than a stored 0.0, so resetting progress just deletes the row.

Revision ID: e7a2f9c3d156
Revises: c5e175a41e88
Create Date: 2026-09-20 00:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "e7a2f9c3d156"
down_revision: Union[str, None] = "c5e175a41e88"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    existing_tables = set(inspect(op.get_bind()).get_table_names())
    if "audiobook_progress" in existing_tables:
        return
    op.create_table(
        "audiobook_progress",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "audiobook_id",
            sa.String(length=36),
            sa.ForeignKey("audiobooks.id"),
            nullable=False,
        ),
        sa.Column("position_seconds", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("user_id", "audiobook_id", name="uq_audiobook_progress_user_audiobook"),
    )
    op.create_index(
        "ix_audiobook_progress_user_audiobook",
        "audiobook_progress",
        ["user_id", "audiobook_id"],
    )


def downgrade() -> None:
    existing_tables = set(inspect(op.get_bind()).get_table_names())
    if "audiobook_progress" not in existing_tables:
        return
    op.drop_index("ix_audiobook_progress_user_audiobook", table_name="audiobook_progress")
    op.drop_table("audiobook_progress")
