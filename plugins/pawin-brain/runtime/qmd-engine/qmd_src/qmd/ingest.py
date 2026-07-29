"""Ingestion and chunking of document files."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from qmd.utils import file_hash, normalize_text, tags_from_filename

SUPPORTED_EXTENSIONS = {".txt", ".md"}

# Chunking defaults
DEFAULT_MAX_CHUNK_TOKENS = 300  # approximate word count
DEFAULT_MIN_CHUNK_TOKENS = 30
DEFAULT_OVERLAP_TOKENS = 30


@dataclass
class Chunk:
    chunk_id: str
    file_path: str
    file_name: str
    created: float
    modified: float
    chunk_index: int
    text: str
    tags: list[str] = field(default_factory=list)
    file_hash: str = ""


def discover_files(input_dir: Path) -> list[Path]:
    """Recursively find all supported document files."""
    files: list[Path] = []
    for ext in SUPPORTED_EXTENSIONS:
        files.extend(input_dir.rglob(f"*{ext}"))
    return sorted(files)


def chunk_text(
    text: str,
    max_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    min_tokens: int = DEFAULT_MIN_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> list[str]:
    """Split text into retrievable chunks.

    Strategy:
    1. Split on paragraph boundaries (double newline).
    2. If a paragraph exceeds max_tokens, split it by sentences/words.
    3. Merge tiny consecutive paragraphs that are below min_tokens.
    4. Add overlap between chunks for context continuity.
    """
    paragraphs = _split_paragraphs(text)
    raw_chunks = _merge_and_split(paragraphs, max_tokens, min_tokens)
    if overlap_tokens > 0 and len(raw_chunks) > 1:
        raw_chunks = _add_overlap(raw_chunks, overlap_tokens)
    return raw_chunks


def _split_paragraphs(text: str) -> list[str]:
    """Split text on double newlines, keeping non-empty paragraphs."""
    parts = text.split("\n\n")
    return [p.strip() for p in parts if p.strip()]


def _word_count(text: str) -> int:
    return len(text.split())


def _merge_and_split(
    paragraphs: list[str], max_tokens: int, min_tokens: int
) -> list[str]:
    """Merge small paragraphs and split oversized ones."""
    chunks: list[str] = []
    buffer: list[str] = []
    buffer_wc = 0

    for para in paragraphs:
        pwc = _word_count(para)

        # If paragraph alone exceeds max, flush buffer then split paragraph
        if pwc > max_tokens:
            if buffer:
                chunks.append("\n\n".join(buffer))
                buffer, buffer_wc = [], 0
            chunks.extend(_split_by_words(para, max_tokens))
            continue

        # If adding this paragraph would exceed max, flush buffer first
        if buffer_wc + pwc > max_tokens:
            chunks.append("\n\n".join(buffer))
            buffer, buffer_wc = [], 0

        buffer.append(para)
        buffer_wc += pwc

    if buffer:
        # If buffer is tiny and we have a previous chunk, merge with it
        if buffer_wc < min_tokens and chunks:
            chunks[-1] = chunks[-1] + "\n\n" + "\n\n".join(buffer)
        else:
            chunks.append("\n\n".join(buffer))

    return chunks


def _split_by_words(text: str, max_tokens: int) -> list[str]:
    """Split a long paragraph into chunks of roughly max_tokens words."""
    words = text.split()
    chunks: list[str] = []
    for i in range(0, len(words), max_tokens):
        chunk = " ".join(words[i : i + max_tokens])
        if chunk:
            chunks.append(chunk)
    return chunks


def _add_overlap(chunks: list[str], overlap_tokens: int) -> list[str]:
    """Prepend tail of the previous chunk to each subsequent chunk."""
    result = [chunks[0]]
    for i in range(1, len(chunks)):
        prev_words = chunks[i - 1].split()
        overlap_words = prev_words[-overlap_tokens:]
        overlap_text = " ".join(overlap_words)
        result.append(overlap_text + " " + chunks[i])
    return result


@dataclass
class FileRecord:
    """Tracks a file's identity for incremental indexing."""
    mtime: float
    size: int
    content_hash: str


def load_manifest(index_dir: Path) -> dict[str, FileRecord]:
    """Load the file manifest for incremental indexing.

    命名注意：这个清单文件叫 file_manifest.json，不叫 manifest.json——
    full_scan.py 在同一个 index_dir 下用 manifest.json 记录完全不同的东西
    （{model, dim, chunks, updated_at} 的索引"尺子"，daemon 加载时用来做
    fail-fast 一致性校验）。两套管线如果共用一个 index_dir，一名两义的
    manifest.json 会被互相覆盖：daemon 的 dim/chunks 校验因为字段缺失
    静默跳过，这边 load_manifest 读到 full_scan 版的内容又会在
    `FileRecord(**v)` 处直接 TypeError 崩掉。
    """
    manifest_path = index_dir / "file_manifest.json"
    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        # Handle both old format (str values) and new format (dict values)
        result: dict[str, FileRecord] = {}
        for k, v in raw.items():
            if isinstance(v, str):
                # Old format: value is just the hash — force reprocess
                result[k] = FileRecord(mtime=0.0, size=0, content_hash=v)
            else:
                result[k] = FileRecord(**v)
        return result
    return {}


def save_manifest(index_dir: Path, manifest: dict[str, FileRecord]) -> None:
    """Save the file manifest. 见 load_manifest 的命名说明——不叫 manifest.json。"""
    manifest_path = index_dir / "file_manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {k: asdict(v) for k, v in manifest.items()},
            f, indent=2,
        )


def _file_changed(fpath: Path, old_record: FileRecord | None) -> tuple[bool, FileRecord]:
    """Check if a file has changed using a two-tier strategy.

    Tier 1 (cheap): Compare mtime + size via stat(). No file read.
    Tier 2 (expensive): If mtime/size differ, hash contents to confirm.

    Returns (changed: bool, new_record: FileRecord).
    """
    stat = fpath.stat()
    cur_mtime = stat.st_mtime
    cur_size = stat.st_size

    if old_record and old_record.mtime == cur_mtime and old_record.size == cur_size:
        # Stat matches — skip the hash, reuse old record
        return False, old_record

    # Stat changed — hash the file to be certain
    fhash = file_hash(fpath)

    new_record = FileRecord(mtime=cur_mtime, size=cur_size, content_hash=fhash)

    if old_record and old_record.content_hash == fhash:
        # Content identical despite stat change (e.g. touch with no edit)
        return False, new_record

    return True, new_record


def ingest_folder(
    input_dir: Path,
    index_dir: Path,
    max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    min_chunk_tokens: int = DEFAULT_MIN_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    force: bool = False,
) -> tuple[list[Chunk], dict[str, int]]:
    """Ingest document files and write chunks.jsonl.

    Incremental re-indexing strategy:
    1. Stat each file (mtime + size) — no file reads for unchanged files.
    2. If stat differs, hash contents to confirm real change.
    3. Only re-chunk files with actual content changes.
    Use force=True to skip all checks and reprocess everything.

    Returns (all_chunks, stats_dict).
    """
    index_dir.mkdir(parents=True, exist_ok=True)
    chunks_path = index_dir / "chunks.jsonl"

    files = discover_files(input_dir)
    if not files:
        raise FileNotFoundError(f"No .txt or .md files found in {input_dir}")

    # Load previous manifest for incremental indexing
    old_manifest: dict[str, FileRecord] = {} if force else load_manifest(index_dir)
    new_manifest: dict[str, FileRecord] = {}

    # Load existing chunks (keyed by file_path) for merging
    existing_chunks_by_file: dict[str, list[Chunk]] = {}
    if not force and chunks_path.exists():
        for ch in _read_chunks_jsonl(chunks_path):
            existing_chunks_by_file.setdefault(ch.file_path, []).append(ch)

    all_chunks: list[Chunk] = []
    stats = {"new": 0, "changed": 0, "unchanged": 0, "deleted": 0}

    # Track current file paths to detect deletions
    current_file_paths: set[str] = set()

    for fpath in files:
        fpath_str = str(fpath)
        current_file_paths.add(fpath_str)

        old_record = old_manifest.get(fpath_str)
        is_new = old_record is None

        if force:
            changed = True
            fhash = file_hash(fpath)
            stat = fpath.stat()
            record = FileRecord(mtime=stat.st_mtime, size=stat.st_size, content_hash=fhash)
        else:
            changed, record = _file_changed(fpath, old_record)

        new_manifest[fpath_str] = record

        if not changed:
            # Reuse existing chunks — no file read happened
            if fpath_str in existing_chunks_by_file:
                all_chunks.extend(existing_chunks_by_file[fpath_str])
            stats["unchanged"] += 1
            continue

        if is_new:
            stats["new"] += 1
        else:
            stats["changed"] += 1

        # Read and process file (only files that actually changed reach here)
        raw = fpath.read_text(encoding="utf-8", errors="replace")
        cleaned = normalize_text(raw)
        if not cleaned:
            continue

        stat = fpath.stat()
        tags = tags_from_filename(fpath.name)

        text_chunks = chunk_text(
            cleaned,
            max_tokens=max_chunk_tokens,
            min_tokens=min_chunk_tokens,
            overlap_tokens=overlap_tokens,
        )

        for idx, chunk_text_str in enumerate(text_chunks):
            chunk = Chunk(
                chunk_id=f"{fpath.stem}_{idx:04d}",
                file_path=fpath_str,
                file_name=fpath.name,
                created=stat.st_birthtime if hasattr(stat, "st_birthtime") else stat.st_ctime,
                modified=stat.st_mtime,
                chunk_index=idx,
                text=chunk_text_str,
                tags=tags,
                file_hash=record.content_hash,
            )
            all_chunks.append(chunk)

    # Count files that were in old manifest but no longer exist
    for old_path in old_manifest:
        if old_path not in current_file_paths:
            stats["deleted"] += 1

    # Write all chunks
    with open(chunks_path, "w", encoding="utf-8") as f:
        for chunk in all_chunks:
            f.write(json.dumps(asdict(chunk), ensure_ascii=False) + "\n")

    save_manifest(index_dir, new_manifest)

    return all_chunks, stats


def _read_chunks_jsonl(path: Path) -> list[Chunk]:
    """Read chunks from a JSONL file."""
    chunks: list[Chunk] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            chunks.append(Chunk(**d))
    return chunks
