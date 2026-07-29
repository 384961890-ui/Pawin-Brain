"""Shared utilities for QMD search."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


def normalize_text(text: str) -> str:
    """Apply minimal cleaning to document text.

    Rules:
    - Normalize line endings to \\n
    - Collapse runs of 3+ newlines to 2
    - Collapse repeated spaces/tabs within lines to single space
    - Strip trivial header lines (e.g. "Transcript:") at the very start
    - Preserve all meaningful content
    """
    # Normalize line endings
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # Strip trivial leading header (only if it's the very first line)
    text = re.sub(r"^(Transcript|TRANSCRIPT|transcript)\s*:\s*\n", "", text)

    # Collapse runs of spaces/tabs within each line (but keep newlines)
    text = re.sub(r"[^\S\n]+", " ", text)

    # Collapse 3+ consecutive newlines into 2 (keep paragraph breaks)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def file_hash(path: Path) -> str:
    """Return SHA-256 hex digest of a file's contents."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8192), b""):
            h.update(block)
    return h.hexdigest()


def tags_from_filename(filename: str) -> list[str]:
    """Infer simple tags from a filename.

    Examples:
        'meeting_2024-01-15_security_review.txt' → ['meeting', 'security', 'review']
        'standup-notes.md' → ['standup', 'notes']
    """
    stem = Path(filename).stem
    # Split on common separators
    tokens = re.split(r"[-_.\s]+", stem)
    # Drop pure date/number tokens
    tags = [t.lower() for t in tokens if t and not re.match(r"^\d+$", t)]
    return tags
