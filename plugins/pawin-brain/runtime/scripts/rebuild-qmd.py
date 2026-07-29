#!/usr/bin/env python3
"""
rebuild-qmd.py — claude-brain v3 QMD 索引构建器

模式：
    全量重建（默认）  — 重新 embed 所有文件，覆盖旧索引
    增量更新          — 只 embed 新增/改过的文件，append 到现有索引

用法：
    python3 rebuild-qmd.py                  # 全量重建
    python3 rebuild-qmd.py --incremental    # 增量（推荐日常用）
    python3 rebuild-qmd.py --dry-run        # 只扫描，不写文件
"""

import sys
import os
import json
import time
import hashlib
import argparse
from pathlib import Path
from dataclasses import asdict
from collections import Counter

import numpy as np

# 注入 qmd 源码路径（部署时把 QMD_SRC 指到你自己的 QMD 源码位置）
QMD_PATH = Path(os.environ.get("QMD_SRC", str(Path.home() / ".claude-brain/qmd/qmd_src")))
sys.path.insert(0, str(QMD_PATH))

from qmd.ingest import chunk_text, Chunk
from qmd.search_embed import embed_texts, save_embeddings

# ============================================================
# 配置
# ============================================================

INDEX_DIR = Path(os.environ.get("QMD_INDEX_DIR", str(Path.home() / ".claude-brain/qmd/index")))

# 扫描目标目录列表：
# - 默认覆盖 Claude Code 相关目录（`.claude/`、`.claude-brain/`）
# - 通过环境变量 QMD_SCAN_EXTRA_DIRS（冒号分隔）追加你自己的项目目录
DEFAULT_SCAN_TARGETS = [
    Path.home() / ".claude",
    Path.home() / ".claude-brain",
]
_extra = os.environ.get("QMD_SCAN_EXTRA_DIRS", "")
SCAN_TARGETS = DEFAULT_SCAN_TARGETS + [Path(p) for p in _extra.split(":") if p.strip()]

EXTENSIONS = {
    '.md', '.txt',
    '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
    '.py',
    '.go', '.rs',
    '.java', '.kt', '.swift',
    '.html', '.css', '.scss',
    '.json', '.yaml', '.yml', '.toml',
    '.sh', '.zsh', '.bash',
    '.sql',
}

EXCLUDE_DIR_NAMES = {
    'node_modules', '.git', '.next', 'dist', 'build', 'out',
    '__pycache__', '.venv', 'venv', '.pytest_cache', '.cache',
    '.idea', '.vscode', '.DS_Store', 'logs', 'tmp', '.tmp',
    'coverage', '.nyc_output',
    'memory-index',
    'lancedb', 'lancedb-pro', 'lancedb-pro-import',
    # Rust / C 编译输出
    'target', 'release', 'debug',
    # ccd session 附属目录（UUID session 的子目录）
    'tool-results', 'subagents', 'tasks', 'workflows',
    # session 附属
    'debug', 'paste-cache', 'shell-snapshots',
}

# 部署时通过环境变量追加你自己想跳过的目录名（逗号分隔）
_extra_exclude = os.environ.get("QMD_EXTRA_EXCLUDE_DIRS", "")
if _extra_exclude:
    EXCLUDE_DIR_NAMES.update(d.strip() for d in _extra_exclude.split(",") if d.strip())

# 路径片段排除（full path 含这些 → 跳过）
EXCLUDE_PATH_PATTERNS = [
    # ccd session 子目录（memory/ 保留，session UUID 子树排除）
    '/tool-results/',
    '/subagents/',
    '/tasks/',
    '/workflows/',
    # ccd session 附属目录
    '/.claude/debug/',
    '/.claude/paste-cache/',
    '/.claude/shell-snapshots/',
]

# 部署时通过环境变量追加你自己想跳过的路径片段（冒号分隔）
_extra_path_ex = os.environ.get("QMD_EXTRA_EXCLUDE_PATHS", "")
if _extra_path_ex:
    EXCLUDE_PATH_PATTERNS.extend(p.strip() for p in _extra_path_ex.split(":") if p.strip())

EXCLUDE_FILE_PATTERNS = [
    '.bak', '-backup-', '.full-backup-', '.tmp-', '.lock', 'lock-',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
    # ccd hook / session 文件
    'hook-', '-systemMessage.txt', 'agent-',
    # base64 dump
    'export-b64',
]

# 精确文件名排除
EXCLUDE_FILE_NAMES = {
    'Spell.txt', 'Chimes.txt', 'Suspense.txt', 'Cosmic.txt',
    'Silk.txt', 'Ping2.txt', 'Funk.txt', 'Anticipate.txt',
    'aiff.txt', 'mail-sent.txt',
}

MAX_FILE_SIZE = 100_000  # 100 KB（>100KB 大概率是 dump/base64）

# ============================================================
# 函数
# ============================================================

def should_exclude_file(fname):
    """文件名级排除：精确名 + 模式。"""
    if fname in EXCLUDE_FILE_NAMES:
        return True
    for pat in EXCLUDE_FILE_PATTERNS:
        if pat in fname:
            return True
    return False


def should_exclude_path(fpath_str):
    """路径片段排除：full path 含噪声路径 → 跳过。"""
    return any(pat in fpath_str for pat in EXCLUDE_PATH_PATTERNS)


def discover_files(roots, verbose=False):
    """多根目录递归发现可索引文件，带智能排除。"""
    found = []
    skipped = 0
    for root in roots:
        if not root.exists():
            if verbose:
                print(f"  ⚠️  {root} 不存在 跳过", file=sys.stderr)
            continue

        for dirpath, dirs, files in os.walk(root, followlinks=False):
            # 路径片段排除：整个目录树剪枝（加尾斜杠使模式匹配可靠）
            if should_exclude_path(dirpath + os.sep):
                dirs[:] = []
                skipped += len(files)
                continue

            # In-place 过滤目录 — os.walk 会用这个判断要不要递归进去
            dirs[:] = [
                d for d in dirs
                if d not in EXCLUDE_DIR_NAMES
                and not any(pat in d for pat in EXCLUDE_FILE_PATTERNS)
                and not d.endswith('_backup')
                and not d.endswith('-backup')
            ]

            for fname in files:
                if should_exclude_file(fname):
                    skipped += 1
                    continue

                fpath = Path(dirpath) / fname
                if fpath.suffix.lower() not in EXTENSIONS:
                    continue

                try:
                    size = fpath.stat().st_size
                except OSError:
                    skipped += 1
                    continue

                if size == 0 or size > MAX_FILE_SIZE:
                    skipped += 1
                    continue

                found.append(fpath)

    if verbose:
        print(f"  跳过 {skipped} 个文件（太大/排除模式）")

    return sorted(set(found))


def file_to_chunks(fpath):
    """读文件 → chunk 列表。"""
    try:
        text = fpath.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return []

    if not text or not text.strip():
        return []

    text_chunks = chunk_text(text)
    if not text_chunks:
        return []

    stat = fpath.stat()
    fhash = hashlib.sha256(text.encode('utf-8', errors='replace')).hexdigest()[:16]

    chunks = []
    for i, t in enumerate(text_chunks):
        chunks.append(Chunk(
            chunk_id=f"{fhash}-{i:03d}",
            file_path=str(fpath),
            file_name=fpath.name,
            created=stat.st_ctime,
            modified=stat.st_mtime,
            chunk_index=i,
            text=t,
            tags=[],
            file_hash=fhash,
        ))
    return chunks


def get_dir_bucket(fpath, roots):
    """文件归属到哪个 root 目录（用于统计）。"""
    for root in roots:
        try:
            fpath.relative_to(root)
            return root.name or str(root)
        except ValueError:
            continue
    return 'other'


# ============================================================
# 增量支持
# ============================================================

def load_indexed_hashes(chunks_path):
    """读现有 chunks.jsonl → {file_path: file_hash}，已索引文件的 hash 快照。"""
    indexed = {}
    if not chunks_path.exists():
        return indexed
    with open(chunks_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                fpath = rec.get('file_path', '')
                fhash = rec.get('file_hash', '')
                if fpath and fhash:
                    indexed[fpath] = fhash
            except json.JSONDecodeError:
                continue
    return indexed


def filter_new_or_changed(files, indexed_hashes):
    """只保留新增或内容变化的文件，跳过 hash 未变的。"""
    new_files, skipped = [], 0
    for fpath in files:
        try:
            text = fpath.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        fhash = hashlib.sha256(text.encode('utf-8', errors='replace')).hexdigest()[:16]
        if indexed_hashes.get(str(fpath)) == fhash:
            skipped += 1
        else:
            new_files.append(fpath)
    return new_files, skipped


def append_to_index(index_dir, new_chunks, new_embeddings):
    """将新 chunks + embeddings 追加到现有索引（原子操作）。"""
    chunks_path = index_dir / 'chunks.jsonl'
    emb_path    = index_dir / 'embeddings.npy'

    # 追加 chunks（直接 append，不覆盖）
    with open(chunks_path, 'a', encoding='utf-8') as f:
        for c in new_chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + '\n')

    # 合并 embeddings：加载旧的 → vstack → 原子写
    if emb_path.exists():
        old_emb = np.load(emb_path)
        merged  = np.vstack([old_emb, new_embeddings]).astype(np.float32)
    else:
        merged = new_embeddings.astype(np.float32)

    tmp_path = emb_path.with_suffix('.npy.tmp')
    np.save(tmp_path, merged)
    tmp_path.replace(emb_path)

    return merged.shape


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run',     action='store_true', help='只扫描不写文件')
    ap.add_argument('--incremental', action='store_true', help='增量模式：只 embed 新增/改过的文件')
    ap.add_argument('--verbose', '-v', action='store_true')
    args = ap.parse_args()

    mode = "增量" if args.incremental else "全量"
    print(f"🔍 第 1 步: 扫描文件 [{mode}模式]")
    t0 = time.time()
    files = discover_files(SCAN_TARGETS, verbose=args.verbose)
    print(f"  发现 {len(files)} 个文件 (用时 {time.time()-t0:.1f}s)")

    # 目录 / 扩展名统计
    dir_count = Counter(get_dir_bucket(f, SCAN_TARGETS) for f in files)
    print("\n  目录分布:")
    for d, c in dir_count.most_common(20):
        print(f"    {d:40s}  {c:>5d} 个文件")
    ext_count = Counter(f.suffix.lower() for f in files)
    print("\n  文件类型分布 (top 10):")
    for ext, c in ext_count.most_common(10):
        print(f"    {ext:10s}  {c:>5d}")

    if args.dry_run:
        if args.incremental:
            indexed = load_indexed_hashes(INDEX_DIR / 'chunks.jsonl')
            new_files, skipped = filter_new_or_changed(files, indexed)
            print(f"\n  [增量 dry-run] 新增/改过: {len(new_files)} 个，跳过: {skipped} 个")
        print("\n✅ Dry run 完成 — 未实际重建")
        return

    # ── 增量模式 ──────────────────────────────────────────────
    if args.incremental:
        chunks_path = INDEX_DIR / 'chunks.jsonl'

        print("\n📋 读取现有索引 hash 快照...")
        t0 = time.time()
        indexed_hashes = load_indexed_hashes(chunks_path)
        print(f"  已索引文件数: {len(indexed_hashes)}  (用时 {time.time()-t0:.1f}s)")

        print("\n🔎 过滤新增/改过的文件...")
        t0 = time.time()
        new_files, skipped = filter_new_or_changed(files, indexed_hashes)
        print(f"  新增/改过: {len(new_files)} 个  跳过: {skipped} 个  (用时 {time.time()-t0:.1f}s)")

        if not new_files:
            print("\n✅ 索引已是最新，无需更新")
            return

        print("\n✂️  第 2 步: 分 chunks（仅新文件）")
        t0 = time.time()
        new_chunks = []
        for fp in new_files:
            new_chunks.extend(file_to_chunks(fp))
        print(f"  {len(new_chunks)} 个新 chunks (用时 {time.time()-t0:.1f}s)")

        if not new_chunks:
            print("❌ 无 chunks 生成 — 终止")
            return

        print(f"\n🧠 第 3 步: Embedding {len(new_chunks)} 个新 chunks")
        t0 = time.time()
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        new_embeddings = embed_texts([c.text for c in new_chunks])
        print(f"  shape: {new_embeddings.shape}  用时 {time.time()-t0:.1f}s")

        print("\n💾 第 4 步: 追加到现有索引")
        t0 = time.time()
        final_shape = append_to_index(INDEX_DIR, new_chunks, new_embeddings)

        # 更新 manifest
        total_chunks = sum(1 for _ in open(INDEX_DIR / 'chunks.jsonl', encoding='utf-8'))
        manifest = {
            'rebuilt_at':       time.strftime('%Y-%m-%d %H:%M:%S'),
            'rebuilt_by':       'claude-brain v3 rebuild-qmd.py --incremental',
            'mode':             'incremental',
            'new_files':        len(new_files),
            'new_chunks':       len(new_chunks),
            'chunks_count':     total_chunks,
            'embeddings_shape': list(final_shape),
        }
        (INDEX_DIR / 'manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8',
        )
        print(f"  完成 (用时 {time.time()-t0:.1f}s)")
        print()
        print(f"✅ 增量更新完成")
        print(f"   新文件:   {len(new_files)}")
        print(f"   新 chunks:{len(new_chunks)}")
        print(f"   总 chunks:{total_chunks}")
        print(f"   位置:     {INDEX_DIR}")
        return

    # ── 全量重建 ──────────────────────────────────────────────
    print("\n✂️  第 2 步: 分 chunks")
    t0 = time.time()
    all_chunks = []
    for fp in files:
        all_chunks.extend(file_to_chunks(fp))
    print(f"  {len(all_chunks)} 个 chunks (用时 {time.time()-t0:.1f}s)")

    if not all_chunks:
        print("❌ 无 chunks 生成 — 终止")
        return

    print("\n🧠 第 3 步: 生成 embeddings（全量）")
    t0 = time.time()
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    embeddings = embed_texts([c.text for c in all_chunks])
    save_embeddings(INDEX_DIR, embeddings)
    print(f"  shape: {embeddings.shape}  用时 {time.time()-t0:.1f}s")

    print("\n💾 第 4 步: 写 chunks.jsonl + manifest.json")
    t0 = time.time()
    chunks_path = INDEX_DIR / "chunks.jsonl"

    tmp_path = INDEX_DIR / "chunks.jsonl.tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        for c in all_chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + '\n')
    tmp_path.replace(chunks_path)

    manifest = {
        'rebuilt_at':       time.strftime('%Y-%m-%d %H:%M:%S'),
        'rebuilt_by':       'claude-brain v3 rebuild-qmd.py',
        'mode':             'full',
        'chunks_count':     len(all_chunks),
        'files_count':      len(files),
        'directories':      [str(r) for r in SCAN_TARGETS],
        'extensions':       sorted(EXTENSIONS),
        'embeddings_shape': list(embeddings.shape),
    }
    (INDEX_DIR / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8',
    )
    print(f"  完成 (用时 {time.time()-t0:.1f}s)")

    size_mb = chunks_path.stat().st_size / 1024 / 1024
    print()
    print(f"✅ 全量重建完成")
    print(f"   文件:        {len(files)}")
    print(f"   chunks:      {len(all_chunks)}")
    print(f"   chunks.jsonl:{size_mb:.1f} MB")
    print(f"   位置:        {INDEX_DIR}")


if __name__ == '__main__':
    main()
