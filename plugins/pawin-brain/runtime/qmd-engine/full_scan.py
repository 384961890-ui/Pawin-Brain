#!/usr/bin/env python3
"""qmd-engine 索引构建器：全量扫描 + 增量更新 + 原子重建。

扫描范围由 QMD_MEMORY_DIR 环境变量配置（见 qmd_config.get_memory_dirs），
不带任何硬编码的个人目录。可选环境变量：

  QMD_DOCS_ONLY_DIR   系统 PATH 分隔符（macOS/Linux 用 ':'）分隔的目录前缀
                       列表；这些目录下只收文档（.md/.txt/.docx/.pdf），
                       代码不进语义索引（代码建议用 grep/ripgrep 找，语义
                       索引留给自然语言）
  QMD_EXCLUDE_DIR      系统 PATH 分隔符分隔的目录前缀列表；整棵子树跳过不扫
                       （与 QMD_MEMORY_DIR 用同一种分隔符，统一"路径列表"
                       的分隔约定，避免一个用逗号一个用冒号的认知负担）

# ponytail: single-file by design for auditability; split when it grows past ~900 lines
"""

import sys
import os
import shutil
import re
import json
import hashlib
import time
import subprocess
import urllib.request
import fcntl
from pathlib import Path
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "qmd_src"))
from qmd.search_embed import embed_texts, save_embeddings, load_embeddings, EMBEDDINGS_FILE
from qmd.ingest import Chunk
from qmd_config import EXPECTED_EMBED_DIM, MODEL_NAME, INDEX_DIR, get_memory_dirs

SCAN_TIMESTAMP_FILE = INDEX_DIR / ".last_scan_ts"
FILE_INDEX_FILE = INDEX_DIR / "file_index.json"
MANIFEST_FILE = INDEX_DIR / "manifest.json"

# ── QMD daemon 嵌入复用 ────────────────────────────────
# 扫描/嵌入阶段优先走常驻 daemon 的模型（HTTP），避免再单独加载一份几 GB 的
# embedding 模型把内存啃爆（两份模型常驻是最常见的部署事故，见 PITFALLS.md）。
# daemon 不在线时才本地加载模型兜底——此时全机也只有这一份。
# 端口必须和 qmd_daemon.py/health_check.py 一样读 QMD_DAEMON_PORT——写死
# 18765 会导致：① 用户改了端口后 full_scan 永远探不到自己的 daemon，白白
# 重新加载一份几 GB 的模型；② 更糟的是，如果 18765 上恰好挂着别人的、模型
# 不同的 daemon，会被静默当成"自己的 daemon"借用，导致索引维度/语义空间
# 混入完全不相关的向量（下面 _daemon_supports_embed 还会核对 model 名，
# 端口对不上则这道核对形同虚设）。
_DAEMON_PORT = os.environ.get("QMD_DAEMON_PORT", "18765")
DAEMON_HEALTH_URL = f"http://127.0.0.1:{_DAEMON_PORT}/health"
DAEMON_EMBED_URL = f"http://127.0.0.1:{_DAEMON_PORT}/embed"
DAEMON_EMBED_BATCH = 32   # daemon 内部嵌入批大小：实测 batch=32 附近是吞吐拐点，
                          # 与逐条嵌入数值等价，纯并行提速
DAEMON_HTTP_BATCH = 128   # 每个 POST 文本条数（需 ≥ DAEMON_EMBED_BATCH）：大批省 HTTP 往返

# ── 扫描范围 ──────────────────────────────────────────
# 只扫 QMD_MEMORY_DIR 配置的目录（默认 ~/.qmd/memory）。范围越窄，
# 增量扫描越快、噪音越少——把"所有文件"塞进语义索引本身就是常见反模式。
SCAN_ROOTS = get_memory_dirs()

# 这些子目录是"装来的/机器产的"不是记忆内容：整目录不扫。
# 分隔符与 QMD_MEMORY_DIR 统一用 os.pathsep（macOS/Linux 为 ':'）——
# 三个"目录路径列表"型环境变量之前一个用冒号一个用逗号，是没有理由的不一致
# （目录路径本身用逗号做分隔符也不安全：路径理论上可以含逗号）。
_MEMORY_SCOPE_BLACKLIST = [
    p.strip() for p in os.environ.get("QMD_EXCLUDE_DIR", "").split(os.pathsep) if p.strip()
]

# 这些子目录代码占大头但文档值得记（PROJECT_MEMORY/PLAN/README 等）：只收文档不收代码。
_DOCS_ONLY_ROOTS = [
    p.strip() for p in os.environ.get("QMD_DOCS_ONLY_DIR", "").split(os.pathsep) if p.strip()
]
_DOC_EXTENSIONS = {".md", ".txt", ".docx", ".pdf"}

# ── 黑名单 ────────────────────────────────────────────
BLACKLIST_DIRS = {
    "node_modules", "venv", ".venv", "__pycache__", ".git",
    "Caches", "Logs", "Application Support", "Containers",
    "CrashReporter", "DiagnosticReports",
    ".cache", ".npm", ".cargo", ".rustup", ".pyenv",
    "GoogleSoftwareUpdate", "Group Containers",
    # Rust / C 编译输出
    "target", "release", "debug",
}
BLACKLIST_PATH_PATTERNS = [
    "/Library/Caches", "/Library/Logs", "/Library/Application Support",
    ".ssh/", "id_rsa", "id_ed25519", "known_hosts",
    "archive/", ".bak/", ".bak.", "~",
]
MAX_FILE_SIZE_MB = 10

# ── 噪音文件黑名单 ─────────────────────────────────────
# 这些文件即使扩展名匹配也跳过 — 内容是机器生成 / 缓存 / log / 不可读
EXCLUDE_FILE_NAMES = {
    "sessions.json",
    # log 文件
    "sentinel-log.md",
    "heartbeat-log.md",
    # model artifact（已被 SKIP_BINARY_EXTENSIONS 覆盖大部分 但 tokenizer.json 是 json）
    "tokenizer.json",
    "vocabulary.txt",
    "vocab.txt",
    "merges.txt",
    # 锁文件
    "package-lock.json",
    "bun.lockb",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "uv.lock",
    "composer.lock",
    "Gemfile.lock",
    "pnpm-lock.yaml",
}
# regex 匹配的 noise 命名 pattern
EXCLUDE_FILENAME_REGEX = [
    re.compile(r".*\.cache\.json$"),               # *.cache.json
    re.compile(r".*-log\.(md|log|txt|jsonl)$"),    # *-log.md / *-log.jsonl
    re.compile(r".*\.lock$"),                      # 各种 lock
]

SKIP_BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".mp4", ".mov", ".avi",
    ".zip", ".tar", ".gz", ".rar", ".7z", ".bin", ".exe",
    ".dmg", ".pkg", ".app", ".dylib", ".so", ".wasm",
    ".woff", ".woff2", ".ttf", ".otf",
    ".npy", ".npz", ".gguf", ".safetensors",
    ".icns", ".ico", ".svg",  # svg 太大也不读
}

# ── 文件类型白名单 ────────────────────────────────────
ALLOWED_EXTENSIONS = {
    # 文本
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
    # 代码
    ".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".kt", ".kts",
    ".swift", ".html", ".css", ".scss", ".sh", ".bash", ".zsh",
    ".c", ".cpp", ".h", ".hpp", ".java", ".scala", ".rb",
    ".sql", ".graphql", ".proto",
    # 配置
    ".env.example", ".ini", ".cfg", ".conf",
    # 文档（需要外部工具解析）
    ".docx", ".pdf",
}

# ── chunk 参数 ────────────────────────────────────────
# 目标：chunk 长度必须留在嵌入模型 n_ctx（8192 token，见 search_embed.py）以内，
# 否则向量会被截断/糊掉，检索质量退化到接近随机——踩过的坑见 PITFALLS.md。
TEXT_CHUNK_APPROX_TOKENS = 85
CODE_LINES_PER_CHUNK = 50
CHUNK_OVERLAP_TOKENS = 13


def _should_skip_dir(dir_path: Path) -> bool:
    """Check if directory should be skipped."""
    path_prefix = str(dir_path)
    if any(path_prefix == b or path_prefix.startswith(b + "/") for b in _MEMORY_SCOPE_BLACKLIST):
        return True
    name = dir_path.name
    if name in BLACKLIST_DIRS:
        return True
    if name.startswith("."):
        return True
    path_str = str(dir_path)
    for pattern in BLACKLIST_PATH_PATTERNS:
        if pattern in path_str:
            return True
    return False


def _should_skip_file(file_path: Path) -> bool:
    """Check if file should be skipped."""
    # symlink 指向的内容可能在扫描范围之外（比如指到系统目录/别的盘），
    # 跟着 symlink 走会把范围外的内容悄悄吸进索引——之后能被 /search 检出，
    # 但用户看着 QMD_MEMORY_DIR 配置以为范围就那么大。文件级 symlink 一律跳过
    # （目录级 symlink 本来就不会被 os.walk 默认跟随，见 _walk_candidate_files）。
    if file_path.is_symlink():
        return True
    name = file_path.name
    suffix = file_path.suffix.lower()
    # docs-only 目录：代码不进语义索引（代码用 grep 找），只留文档。
    path_str_scope = str(file_path)
    if suffix not in _DOC_EXTENSIONS and any(
        path_str_scope.startswith(r + "/") for r in _DOCS_ONLY_ROOTS
    ):
        return True
    if suffix in SKIP_BINARY_EXTENSIONS:
        return True
    # 噪音文件名黑名单
    if name in EXCLUDE_FILE_NAMES:
        return True
    for rx in EXCLUDE_FILENAME_REGEX:
        if rx.match(name):
            return True
    if suffix not in ALLOWED_EXTENSIONS:
        return True
    try:
        size = file_path.stat().st_size
        if size > MAX_FILE_SIZE_MB * 1024 * 1024:
            return True
    except OSError:
        return True
    path_str = str(file_path)
    for pattern in BLACKLIST_PATH_PATTERNS:
        if pattern in path_str:
            return True
    return False


def _read_file_content(file_path: Path) -> str | None:
    """Read text from file. For docx/pdf, use external tools."""
    suffix = file_path.suffix.lower()

    if suffix == ".docx":
        try:
            result = subprocess.run(
                ["pandoc", str(file_path), "-t", "plain"],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                return result.stdout
        except Exception:
            pass
        return None

    if suffix == ".pdf":
        try:
            result = subprocess.run(
                ["pdftotext", "-layout", str(file_path), "-"],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout
        except Exception:
            pass
        return None

    # 文本文件：按编码探测，不能拿 latin-1 当兜底——latin-1 对任意字节序列都
    # 不会抛 UnicodeDecodeError（0x00-0xFF 每个值都是合法码点），所以"解码
    # 成功"这个信号在这里是假的：一份 GBK/GB18030 编码的中文文件会被它
    # "成功"解成一整篇乱码，照样分块、嵌入、写入索引，检索永远搜不到、
    # 也没有任何报错——是最隐蔽的一类静默污染。
    # 改用：utf-8 → gb18030（GBK 的超集，覆盖简体中文场景）依次真实尝试；
    # 都失败则用 utf-8 + replace 兜底，但如果替换字符（U+FFFD）占比过高，
    # 判定为"解码失败"直接跳过整份文件并记日志，而不是带着乱码继续入库。
    try:
        raw_bytes = file_path.read_bytes()
    except OSError:
        return None
    for encoding in ("utf-8", "gb18030"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    text = raw_bytes.decode("utf-8", errors="replace")
    bad_ratio = (text.count("�") / len(text)) if text else 0.0
    if bad_ratio > 0.05:
        print(
            f"[full_scan] ⚠️ 跳过 {file_path}（编码探测失败，utf-8 替换字符占比 "
            f"{bad_ratio:.1%} > 5% 阈值，疑似非 utf-8/gb18030 编码）",
            file=sys.stderr,
        )
        return None
    return text


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_code_file(file_path: Path) -> bool:
    code_ext = {".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".kt", ".kts",
                ".swift", ".c", ".cpp", ".h", ".hpp", ".java", ".scala", ".rb",
                ".sh", ".bash", ".zsh", ".sql", ".css", ".scss", ".html"}
    return file_path.suffix.lower() in code_ext


def _chunk_file(file_path: Path, content: str, file_hash: str) -> list[dict]:
    """Chunk file content. Code files use line-based, others use token-based."""
    # stat 一次并传给两个分块函数——原来每个 chunk 都重新 stat()+exists() 两遍
    # （循环不变量放进了循环体内，纯浪费系统调用）；顺带用 try/except 兜住
    # TOCTTOU：文件在"候选扫描"和"这里读 stat"之间被删掉的极小概率窗口。
    try:
        st = file_path.stat()
        created, modified = st.st_ctime, st.st_mtime
    except OSError:
        created = modified = 0
    if _is_code_file(file_path):
        return _chunk_code(file_path, content, file_hash, created, modified)
    return _chunk_text_generic(file_path, content, file_hash, created, modified)


def _chunk_code(
    file_path: Path, content: str, file_hash: str, created: float, modified: float
) -> list[dict]:
    """Chunk code by lines."""
    lines = content.split("\n")
    chunks = []
    for i in range(0, max(1, len(lines)), CODE_LINES_PER_CHUNK):
        chunk_lines = lines[i:i + CODE_LINES_PER_CHUNK]
        chunk_text_val = "\n".join(chunk_lines).strip()
        if not chunk_text_val:
            continue
        chunks.append({
            "chunk_id": _content_hash(f"{file_hash}:{i}"),
            "file_path": str(file_path),
            "file_name": file_path.name,
            "created": created,
            "modified": modified,
            "chunk_index": i // CODE_LINES_PER_CHUNK,
            "text": chunk_text_val,
            "tags": ["code", file_path.suffix.lstrip(".")],
            "file_hash": file_hash,
        })
    return chunks


def _chunk_text_generic(
    file_path: Path, content: str, file_hash: str, created: float, modified: float
) -> list[dict]:
    """Chunk text by approximate tokens (chars/3 rough estimate for mixed CJK/Latin)."""
    chunk_size = TEXT_CHUNK_APPROX_TOKENS * 3
    # 真正的循环步长（留出 overlap 后每次前进多少字符）——chunk_index 必须按
    # 这个步长算，不能按 chunk_size 算：两者不相等（255 vs 216）会导致
    # chunk_index 要么重复要么跳号，破坏"chunk_index 标识文件内顺序位置"
    # 这条隐含契约。
    step = chunk_size - CHUNK_OVERLAP_TOKENS * 3
    chunks = []
    for i in range(0, max(1, len(content)), step):
        chunk_text_val = content[i:i + chunk_size].strip()
        if not chunk_text_val:
            continue
        chunks.append({
            "chunk_id": _content_hash(f"{file_hash}:{i}"),
            "file_path": str(file_path),
            "file_name": file_path.name,
            "created": created,
            "modified": modified,
            "chunk_index": i // step,
            "text": chunk_text_val,
            "tags": ["text"],
        })
    return chunks


def scan_dry_run() -> dict:
    """Walk all scan roots and return statistics without reading files."""
    total_files = 0
    total_size = 0
    by_ext: dict[str, int] = {}

    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not _should_skip_dir(Path(dirpath) / d)]
            for fname in filenames:
                fpath = Path(dirpath) / fname
                if _should_skip_file(fpath):
                    continue
                total_files += 1
                try:
                    total_size += fpath.stat().st_size
                except OSError:
                    pass
                ext = fpath.suffix.lower() or "(noext)"
                by_ext[ext] = by_ext.get(ext, 0) + 1

    return {
        "total_files": total_files,
        "total_size_mb": round(total_size / 1024 / 1024, 1),
        "by_extension": dict(sorted(by_ext.items(), key=lambda x: x[1], reverse=True)),
    }


def validate_embedding_dim(arr: np.ndarray, context: str = "") -> None:
    """写盘前的维度铁闸：必须是 (N, EXPECTED_EMBED_DIM) 的二维数组。

    换过模型/维度配错，污染的 embedding 写盘后会让 daemon 每次查询算出
    无意义分数（不崩溃，只是结果全错——比崩溃更难发现）。这里是最后一道闸——
    任何 embeddings 落盘之前都必须过这个函数，失败就 sys.exit(3)，
    绝不允许带着错误维度继续写盘。见 PITFALLS.md「换 embedding 模型必须全量重算索引」。
    """
    shape = getattr(arr, "shape", None)
    ok = arr.ndim == 2 and int(arr.shape[1]) == EXPECTED_EMBED_DIM
    if not ok:
        print(
            f"❌ FATAL: embeddings 维度校验失败{f' ({context})' if context else ''}\n"
            f"   实际 shape={shape}\n"
            f"   期望：ndim=2, dim={EXPECTED_EMBED_DIM} (model={MODEL_NAME})\n"
            f"   拒绝写盘，防止污染索引（维度错配的向量参与检索只会产出乱码分数）。\n"
            f"   修复：cd <qmd-engine 目录> && python3 full_scan.py rebuild",
            file=sys.stderr,
        )
        sys.exit(3)


def _daemon_supports_embed(timeout: float = 5.0) -> bool:
    """探测常驻 daemon 是否在线、暴露 /embed 端点，且模型和本地期望的一致。

    只查端口对不对不够——18765 上完全可能挂着别人的、模型不同的 daemon
    （同机器换过项目/别人也在用这个默认端口）。不核对 model 名就直接借用，
    等于把别的模型/别的向量空间产出的 embedding 悄悄混进自己的索引，
    是维度/语义空间污染的另一种触发路径（见 qmd_config.py 顶部注释）。
    """
    try:
        with urllib.request.urlopen(DAEMON_HEALTH_URL, timeout=timeout) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8"))
            if not data.get("embed_endpoint"):
                return False
            remote_model = data.get("model")
            if remote_model != MODEL_NAME:
                print(
                    f"[embed] daemon 在线但 model 不匹配（daemon={remote_model!r} "
                    f"期望={MODEL_NAME!r}）→ 不借用，改本地加载模型",
                    file=sys.stderr,
                )
                return False
            return True
    except Exception:
        return False


def _embed_via_daemon(texts: list[str]) -> np.ndarray:
    """走 daemon /embed 分批嵌入，复用其常驻模型——本进程不加载任何模型。

    每批失败重试 3 次（给守护进程崩溃后复活留时间）；彻底失败则抛异常，
    由调用方处理（run_full_scan 不写索引，下次重跑）。
    """
    out: list[list[float]] = []
    total = len(texts)
    for i in range(0, total, DAEMON_HTTP_BATCH):
        batch = texts[i : i + DAEMON_HTTP_BATCH]
        payload = json.dumps({"texts": batch, "batch_size": DAEMON_EMBED_BATCH}).encode("utf-8")
        req = urllib.request.Request(
            DAEMON_EMBED_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=600) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if "embeddings" not in data:
                    raise RuntimeError(f"daemon /embed returned no embeddings: {data}")
                batch_dim = data.get("dim")
                if batch_dim is not None and int(batch_dim) != EXPECTED_EMBED_DIM:
                    raise RuntimeError(
                        f"daemon /embed batch @{i} dim={batch_dim} != EXPECTED_EMBED_DIM="
                        f"{EXPECTED_EMBED_DIM} · 拒绝继续处理下一批（不静默跳过）"
                    )
                out.extend(data["embeddings"])
                last_err = None
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(
                    f"\n  [daemon embed] batch @{i} attempt {attempt + 1}/3 failed: {e}",
                    file=sys.stderr,
                )
                time.sleep(3)
        if last_err is not None:
            raise last_err
        done = min(i + DAEMON_HTTP_BATCH, total)
        print(f"\r  embed via daemon: {done}/{total}", end="", file=sys.stderr)
    print(file=sys.stderr)
    result = np.asarray(out, dtype=np.float32)
    validate_embedding_dim(result, context="_embed_via_daemon 汇总结果")
    return result


def embed_chunks(texts: list[str]) -> np.ndarray:
    """嵌入入口。daemon 在线则复用其常驻模型（省一份模型内存）；
    否则本地加载模型兜底（此时全机只有这一份，不会双份爆内存）。

    两条路径最终都走 qmd.search_embed.embed_texts(batch_size=1)，
    输出同为 L2 归一化 float32，数值等价。
    """
    if _daemon_supports_embed():
        print(
            f"[embed] daemon 在线 → 复用常驻模型嵌入 {len(texts)} 条（本进程不加载模型）",
            file=sys.stderr,
        )
        return _embed_via_daemon(texts)
    print(
        f"[embed] daemon 不可用 → 本地加载模型嵌入 {len(texts)} 条（单份，不会双份）",
        file=sys.stderr,
    )
    local_result = embed_texts(texts, batch_size=1, show_progress=True)
    validate_embedding_dim(local_result, context="本地 embed_texts 兜底路径")
    return local_result


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """先写 .tmp 再 os.replace 转正，防止进程中途被杀留下半成品文件。"""
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "wb") as f:
        f.write(data)
    os.replace(tmp_path, path)


def _atomic_write_text(path: Path, text: str) -> None:
    _atomic_write_bytes(path, text.encode("utf-8"))


def _atomic_write_jsonl(path: Path, records: list[dict]) -> None:
    lines = "\n".join(json.dumps(r, ensure_ascii=False) for r in records)
    if records:
        lines += "\n"
    _atomic_write_text(path, lines)


def _atomic_write_npy(path: Path, arr: np.ndarray) -> None:
    """np.save 只要文件名不以 .npy 结尾就会自动补一个 .npy 后缀，
    所以这里用 BytesIO 手动序列化再走标准的 tmp→replace 原子写，避免文件名被 numpy 改写。"""
    import io
    buf = io.BytesIO()
    np.save(buf, arr)
    _atomic_write_bytes(path, buf.getvalue())


def write_manifest(index_dir: Path, chunks_count: int) -> dict:
    """原子写 manifest.json：model / dim / chunks / updated_at。"""
    manifest = {
        "model": MODEL_NAME,
        "dim": EXPECTED_EMBED_DIM,
        "chunks": chunks_count,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write_text(index_dir / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


def read_manifest() -> dict | None:
    if not MANIFEST_FILE.exists():
        return None
    try:
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def validate_manifest(manifest: dict) -> bool:
    """校验 manifest 的 dim 字段是否等于 EXPECTED_EMBED_DIM。"""
    return int(manifest.get("dim", -1)) == EXPECTED_EMBED_DIM


def _file_hash_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_file_index(index_dir: Path = INDEX_DIR) -> dict:
    p = index_dir / "file_index.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_file_index(file_index: dict, index_dir: Path = INDEX_DIR) -> None:
    _atomic_write_text(index_dir / "file_index.json", json.dumps(file_index, ensure_ascii=False, indent=2))


def _acquire_index_lock():
    """获取索引排他写锁（非阻塞）。拿到返回文件句柄，被占返回 None。"""
    lock_path = INDEX_DIR / ".scan.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


def _release_index_lock(fh) -> None:
    if fh is not None:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


def run_full_scan(incremental: bool = False) -> dict:
    """扫描入口：加索引写锁防并发写（定时任务 / 手动同时跑时序列化），
    再委托 _run_full_scan_inner。拿不到锁直接跳过（幂等，下次补）。"""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    lock_fh = _acquire_index_lock()
    if lock_fh is None:
        print("⚠️ 索引写锁被占（另一进程正在扫描/重建），跳过本次。", file=sys.stderr)
        return {"skipped": "index lock busy"}
    try:
        return _run_full_scan_inner(incremental=incremental)
    finally:
        _release_index_lock(lock_fh)


INDEX_FILES = ("chunks.jsonl", "embeddings.npy", "manifest.json", "file_index.json", ".last_scan_ts")
REBUILD_BACKUPS_TO_KEEP = 2  # 每个文件名只留最近 N 份 .bak-pre-rebuild-<stamp>


def _prune_old_rebuild_backups(index_dir: Path, keep: int = REBUILD_BACKUPS_TO_KEEP) -> None:
    """rebuild 备份从不清理会无限累积——embeddings.npy 一份就是 GB 级
    （十几万块 chunk × 2560 维 float32 ≈ 1GB+），rebuild 跑个十次就能悄悄
    吃掉十几 GB 磁盘。只留最近 keep 份，按文件名里的时间戳排序清理。"""
    for name in INDEX_FILES:
        backups = sorted(index_dir.glob(f"{name}.bak-pre-rebuild-*"))
        stale = backups[:-keep] if keep > 0 else backups
        for old in stale:
            try:
                old.unlink()
            except OSError:
                pass


def rebuild_index() -> dict:
    """原子全量重建：新索引写到 staging 目录（那里为空 → 从零全量嵌入），
    旧索引【全程原位不动】；staging 建好、自洽校验通过后，才逐个 os.replace 顶替
    （旧版先转 .bak-pre-rebuild-<stamp> 留回滚）。中途被掐 → staging 半成品作废，
    旧索引完好可用。见 PITFALLS.md「索引重建必须原子化」条——这是那条教训的实现。

    受同一把写锁保护。"""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    lock_fh = _acquire_index_lock()
    if lock_fh is None:
        print("⚠️ 索引写锁被占，无法重建。", file=sys.stderr)
        return {"skipped": "index lock busy"}
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    staging = INDEX_DIR.parent / f".qmd-staging-{stamp}"  # 同盘 → os.replace 原子
    try:
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        print(f"从零重建到 staging（旧索引原位不动）：{staging.name}", file=sys.stderr)
        stats = _run_full_scan_inner(incremental=False, index_dir=staging)

        # 顶替前自洽校验：核心两件（chunks + embeddings）必须都在，否则放弃顶替，旧索引不动
        if not (staging / "chunks.jsonl").exists() or not (staging / "embeddings.npy").exists():
            raise RuntimeError(
                f"staging 重建产物不完整（缺 chunks 或 embeddings），放弃顶替，旧索引保持不动：{staging}"
            )

        for name in INDEX_FILES:
            src = staging / name
            if not src.exists():
                continue
            dst = INDEX_DIR / name
            if dst.exists():
                dst.rename(INDEX_DIR / f"{name}.bak-pre-rebuild-{stamp}")
            os.replace(src, dst)  # 同盘原子顶替
        _prune_old_rebuild_backups(INDEX_DIR)
        print(f"  ✓ 顶替完成，旧版存为 .bak-pre-rebuild-{stamp}（仅保留最近 {REBUILD_BACKUPS_TO_KEEP} 份备份）", file=sys.stderr)
        return stats
    finally:
        # 成功后 staging 应已空；失败/中断则半成品在此一并作废，绝不污染正式索引
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        _release_index_lock(lock_fh)


def _walk_candidate_files():
    """遍历 SCAN_ROOTS，yield 通过黑白名单的候选文件路径。"""
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not _should_skip_dir(Path(dirpath) / d)]
            for fname in filenames:
                fpath = Path(dirpath) / fname
                if _should_skip_file(fpath):
                    continue
                yield fpath


def _run_full_scan_inner(incremental: bool = False, index_dir: Path | None = None) -> dict:
    """扫描 + 分块 + 嵌入 + 索引更新入口。

    file_index.json 是 per-file 清单（mtime/size/hash），用于分钟级增量：
    - mtime 和 size 都没变 → 直接跳过，完全不读文件内容
    - mtime 或 size 变了 → hash 二次确认，真变了就删旧 chunks/embeddings 再重新分块嵌入
    - 清单里有但磁盘上找不到的文件 → 视为删除，同样清掉它的 chunks/embeddings

    scan / rebuild 模式（incremental=False）同样维护 file_index，
    但不跳过任何文件（等价于清单为空的首次全量）。
    """
    index_dir = index_dir if index_dir is not None else INDEX_DIR
    index_dir.mkdir(parents=True, exist_ok=True)

    chunks_path = index_dir / "chunks.jsonl"
    emb_path = index_dir / EMBEDDINGS_FILE

    # 加载现有 chunks + embeddings（保持一一对应，行号即数组下标）
    existing_chunks: list[dict] = []
    if chunks_path.exists():
        with open(chunks_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    existing_chunks.append(json.loads(line))
    existing_embeddings: np.ndarray | None = None
    if emb_path.exists():
        existing_embeddings = np.load(emb_path)
        if existing_embeddings.ndim == 2:
            validate_embedding_dim(existing_embeddings, context="合并前对已有 npy 的校验")
        if len(existing_chunks) != int(existing_embeddings.shape[0]):
            # 三件套（chunks/embeddings/file_index）行数不一致时绝不能"截断到较小值"
            # 继续跑——那样一次写残 + 静默截断会把索引砍到只剩一部分且增量永不补回。
            # 行号即数组下标，截断在语义上也是错的（砍掉的行和残缺的行根本对不上）。
            # 正确做法：拒绝运行，落 NEEDS-REBUILD 告警，等人工恢复备份或全量重建。
            # 见 PITFALLS.md「增量写盘要事务化，禁止截断和稀泥式容错」条。
            (index_dir / "NEEDS-REBUILD").write_text(
                f"chunks({len(existing_chunks)}) != embeddings({int(existing_embeddings.shape[0])}) "
                f"at {time.strftime('%F %T')} — 三件套不一致 拒绝增量（绝不截断）恢复备份或 rebuild\n"
            )
            print(
                f"❌ FATAL: chunks({len(existing_chunks)}) 与 embeddings({int(existing_embeddings.shape[0])}) "
                f"行数不一致 → 已写 NEEDS-REBUILD 拒绝继续（绝不截断）",
                file=sys.stderr,
            )
            sys.exit(3)

    existing_at_load = len(existing_chunks)  # 缩水保险的基准
    existing_hashes: set[str] = {c["chunk_id"] for c in existing_chunks}

    file_index = load_file_index(index_dir) if incremental else {}

    # 用 file_path 建索引，方便定位某个文件对应的旧 chunk 行号
    chunks_by_path: dict[str, list[int]] = {}
    for i, c in enumerate(existing_chunks):
        chunks_by_path.setdefault(c["file_path"], []).append(i)

    rows_to_drop: set[int] = set()  # 被判定为"变更/删除"的文件，其旧 chunk 行号
    new_chunks: list[dict] = []

    files_scanned = 0
    files_skipped = 0
    files_changed = 0
    files_deleted = 0
    chunks_new = 0
    chunks_dup = 0

    scan_start = time.time()
    seen_paths: set[str] = set()

    for fpath in _walk_candidate_files():
        path_str = str(fpath)
        seen_paths.add(path_str)

        try:
            st = fpath.stat()
        except OSError:
            continue
        mtime, size = st.st_mtime, st.st_size

        prior = file_index.get(path_str)
        if incremental and prior is not None:
            if prior.get("mtime") == mtime and prior.get("size") == size:
                # mtime/size 完全一致 → 直接跳过，不读文件内容
                files_skipped += 1
                continue
            # mtime/size 对不上：hash 二次确认，避免 mtime 抖动误判
            try:
                new_hash = _file_hash_of(fpath)
            except OSError:
                continue
            if new_hash == prior.get("file_hash"):
                # 内容其实没变（比如 touch 过），更新 file_index 但不重新分块嵌入
                file_index[path_str] = {"mtime": mtime, "size": size, "file_hash": new_hash}
                files_skipped += 1
                continue
            # 真变了：旧 chunk 行标记删除，稍后重新分块嵌入
            for row in chunks_by_path.get(path_str, []):
                rows_to_drop.add(row)
            files_changed += 1

        content = _read_file_content(fpath)
        if content is None:
            continue

        files_scanned += 1
        file_hash = _content_hash(content)
        file_index[path_str] = {"mtime": mtime, "size": size, "file_hash": file_hash}
        file_chunks = _chunk_file(fpath, content, file_hash)

        for chunk_data in file_chunks:
            if chunk_data["chunk_id"] in existing_hashes:
                chunks_dup += 1
            else:
                existing_hashes.add(chunk_data["chunk_id"])
                new_chunks.append(chunk_data)
                chunks_new += 1

        if files_scanned % 100 == 0:
            elapsed = time.time() - scan_start
            print(f"  scanned {files_scanned} files, {chunks_new} new chunks ({elapsed:.0f}s)", file=sys.stderr)

    # 清单里记录过、但磁盘上已经找不到的文件 → 视为删除
    if incremental:
        for path_str in list(file_index.keys()):
            if path_str not in seen_paths:
                for row in chunks_by_path.get(path_str, []):
                    rows_to_drop.add(row)
                del file_index[path_str]
                files_deleted += 1

    elapsed = time.time() - scan_start
    print(
        f"Scan done: {files_scanned} files, {chunks_new} new, {chunks_dup} dup, "
        f"{files_changed} changed, {files_deleted} deleted, {files_skipped} skipped in {elapsed:.0f}s",
        file=sys.stderr,
    )

    if not new_chunks and not rows_to_drop:
        print("No changes to index.", file=sys.stderr)
        write_file_index(file_index, index_dir)
        return {
            "files_scanned": files_scanned,
            "files_skipped": files_skipped,
            "files_changed": files_changed,
            "files_deleted": files_deleted,
            "chunks_new": 0,
            "chunks_dup": chunks_dup,
            "total_chunks": len(existing_chunks),
            "elapsed_s": round(elapsed, 1),
        }

    # 从内存结构里同步删除被判定变更/删除的旧行（chunks 和 embeddings 必须同步）
    if rows_to_drop:
        keep_idx = [i for i in range(len(existing_chunks)) if i not in rows_to_drop]
        existing_chunks = [existing_chunks[i] for i in keep_idx]
        if existing_embeddings is not None and len(keep_idx) > 0:
            existing_embeddings = existing_embeddings[keep_idx]
        elif existing_embeddings is not None:
            existing_embeddings = np.empty((0, EXPECTED_EMBED_DIM), dtype=np.float32)

    # Embed new chunks（优先复用 daemon 常驻模型，避免双份模型爆内存）
    if new_chunks:
        print(f"Embedding {chunks_new} new chunks...", file=sys.stderr)
        new_texts = [c["text"] for c in new_chunks]
        new_embeddings = embed_chunks(new_texts)
    else:
        new_embeddings = np.empty((0, EXPECTED_EMBED_DIM), dtype=np.float32)

    final_chunks = existing_chunks + new_chunks
    if existing_embeddings is not None and existing_embeddings.shape[0] > 0:
        combined = np.vstack([existing_embeddings, new_embeddings]) if new_embeddings.shape[0] > 0 else existing_embeddings
    else:
        combined = new_embeddings

    validate_embedding_dim(combined, context="最终写盘前的合并结果")
    if len(final_chunks) != int(combined.shape[0]):
        print(
            f"❌ FATAL: 最终 chunks({len(final_chunks)}) 与 embeddings({combined.shape[0]}) 行数不一致 · 拒绝写盘",
            file=sys.stderr,
        )
        sys.exit(3)

    # 缩水保险：增量一轮把索引砍掉超过一半 ≈ 必是事故（挂载盘没接上/加载了残本）
    # 拒绝落盘。见 PITFALLS.md「增量写盘要事务化」条。
    if incremental and existing_at_load > 1000 and len(final_chunks) < existing_at_load * 0.5:
        (index_dir / "NEEDS-REBUILD").write_text(
            f"incremental 欲将索引从 {existing_at_load} 砍到 {len(final_chunks)} "
            f"at {time.strftime('%F %T')} — 超过缩水保险线(50%) 拒绝写盘\n"
        )
        print(
            f"❌ FATAL: 增量欲将索引 {existing_at_load} → {len(final_chunks)}（缩水>50%）拒绝写盘 已写 NEEDS-REBUILD",
            file=sys.stderr,
        )
        sys.exit(3)

    # 事务化三件套提交：最容易被 OOM/kill 打断的大内存序列化（np.save 大缓冲）
    # 全部提前到任何 replace 之前——中途死掉旧索引原封不动；随后三个 os.replace
    # 连续执行，把三件套不一致窗口从"嵌入全程（分钟级）"压到毫秒级。
    import io as _io
    _buf = _io.BytesIO()
    np.save(_buf, combined)
    emb_bytes = _buf.getvalue()
    chunks_text = "\n".join(json.dumps(r, ensure_ascii=False) for r in final_chunks)
    if final_chunks:
        chunks_text += "\n"
    _atomic_write_text(chunks_path, chunks_text)
    _atomic_write_bytes(emb_path, emb_bytes)
    write_manifest(index_dir, len(final_chunks))

    write_file_index(file_index, index_dir)

    # 兼容旧的 .last_scan_ts（不再用于跳过判断，仅留痕）
    _atomic_write_text(index_dir / ".last_scan_ts", str(time.time()))

    total_chunks = len(final_chunks)
    print(f"Index updated: {total_chunks} total chunks ({chunks_new} new, {len(rows_to_drop)} dropped)", file=sys.stderr)

    return {
        "files_scanned": files_scanned,
        "files_skipped": files_skipped,
        "files_changed": files_changed,
        "files_deleted": files_deleted,
        "chunks_new": chunks_new,
        "chunks_dup": chunks_dup,
        "chunks_dropped": len(rows_to_drop),
        "total_chunks": total_chunks,
        "embeddings_shape": list(combined.shape),
        "elapsed_s": round(elapsed, 1),
    }


def _check_scan_roots_have_content() -> bool:
    """建索引前的友好前置检查：QMD_MEMORY_DIR 里一个能扫的文件都没有时，
    不要让用户一路跑到 rebuild_index() 里因为 staging 缺 chunks/embeddings
    而炸出一个 RuntimeError 裸 traceback——那是"clone 即用"新用户第一条
    命令就会踩到的坑（README 快速开始第 4 步）。这里提前用零成本的
    scan_dry_run() 探一下，空扫描就给清楚的中文提示，非 traceback 地退出。"""
    quick = scan_dry_run()
    if quick["total_files"] > 0:
        return True
    roots = ", ".join(str(p) for p in SCAN_ROOTS)
    print(
        "⚠️ 0 个文件可扫描，没有可建的索引。\n"
        f"   当前 QMD_MEMORY_DIR 指向：{roots}\n"
        "   请先向该目录放入至少一个 .md/.txt 等文档（可以只是一句话的示例笔记），\n"
        "   再重新运行本命令。见 README「快速开始」第 3 步。",
        file=sys.stderr,
    )
    return False


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="qmd-engine：扫描 + 分块 + 嵌入 + 索引")
    parser.add_argument("action", choices=["dry-run", "scan", "incremental", "rebuild"])
    args = parser.parse_args()

    if args.action == "dry-run":
        stats = scan_dry_run()
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    elif args.action == "rebuild":
        if not _check_scan_roots_have_content():
            sys.exit(1)
        stats = rebuild_index()
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    elif args.action in ("scan", "incremental"):
        if not _check_scan_roots_have_content():
            sys.exit(1)
        inc = args.action == "incremental"
        stats = run_full_scan(incremental=inc)
        print(json.dumps(stats, ensure_ascii=False, indent=2))
