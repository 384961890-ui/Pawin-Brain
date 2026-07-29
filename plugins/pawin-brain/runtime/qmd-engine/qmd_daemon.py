#!/usr/bin/env python3
"""qmd-engine 语义搜索守护进程.

- Qwen3-Embedding-4B-Q8 + Qwen3-Reranker-0.6B-Q8 常驻内存
- /search 默认两阶段检索（reranker on），&rerank=0 退化为单阶段
- /search_fast 只跑 stage1 embedding，不调 reranker（快，日常用）
- /reload 索引刷新后热重载 chunks + embeddings（模型不动）
- /embed 供索引构建器（full_scan.py）复用常驻模型，避免第二份模型常驻

监听 127.0.0.1，只在本机可达。端口默认 18765，可用 QMD_DAEMON_PORT 覆盖。
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
QMD_PATH = Path(__file__).parent / "qmd_src"
sys.path.insert(0, str(QMD_PATH))

from qmd.ingest import Chunk  # noqa: E402
from qmd.search_embed import (  # noqa: E402
    _get_embedding_model,
    _get_reranker_model,
    embed_texts,
    embedding_search,
    load_embeddings,
    two_stage_search,
)
from qmd_config import EXPECTED_EMBED_DIM, INDEX_DIR, MODEL_NAME  # noqa: E402

DAEMON_PORT = int(os.environ.get("QMD_DAEMON_PORT", "18765"))

# /embed 请求体大小上限：没有这个上限，任意大的 Content-Length 都会被
# 无条件 read() 进内存——一次异常大/恶意的请求就能把常驻进程的内存撑爆。
MAX_EMBED_BODY_BYTES = 50 * 1024 * 1024  # 50MB，够装几千条文本，留足余量

# 只信任本机访问：daemon 只绑 127.0.0.1，但浏览器仍可能通过 DNS rebinding
# 或简单的 <img>/no-cors 请求打过来（跨源请求虽然读不到响应体，但请求本身
# 已经执行了 —— /reload、/embed 都有副作用）。校验 Host 头挡掉这类请求。
_ALLOWED_HOSTS = {"127.0.0.1", "localhost"}

_chunks: list[Chunk] | None = None
_embeddings: Any = None

# 串行化所有 llama-cpp 模型调用（embed / rerank）。llama-cpp 非线程安全，
# ThreadingHTTPServer 下并发的 /search 与 /embed 必须互斥，否则模型状态错乱崩溃。
_model_lock = threading.Lock()

# 保护索引加载/重载本身（与 _model_lock 分开：这个锁保护的是"_chunks/
# _embeddings 处于什么状态"，不是模型调用）。没有这把锁时，两个并发请求
# 同时撞见 _chunks is None 会都触发一次加载——重复加载几十万行 chunks +
# 上 GB 的 embeddings，内存尖峰双倍；/reload 清空全局变量的瞬间也可能被
# 并发的 /search 看到"半重置"状态。
_index_lock = threading.Lock()


def get_chunks_and_embeddings() -> tuple[list[Chunk], Any]:
    global _chunks, _embeddings
    with _index_lock:
        if _chunks is None or _embeddings is None:
            chunks_path = INDEX_DIR / "chunks.jsonl"
            if not chunks_path.exists():
                _chunks, _embeddings = [], None
                return _chunks, _embeddings
            loaded: list[Chunk] = []
            with open(chunks_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    d = json.loads(line)
                    loaded.append(Chunk(**d))
            _chunks = loaded
            _embeddings = load_embeddings(INDEX_DIR)
            # 维度校验：embedding 模型输出维度必须与索引存储维度一致，否则 matmul
            # 每次查询都算出无意义分数（不报错，是最隐蔽的一类故障）。
            # fail-fast：直接 SystemExit，让进程守护（launchd/systemd）拉起再退，
            # 日志留证 + 健康检查报警。见 PITFALLS.md「换 embedding 模型」条。
            if _embeddings is not None and _embeddings.ndim == 2 and int(_embeddings.shape[1]) != EXPECTED_EMBED_DIM:
                print(
                    f"[qmd-daemon] ❌ FATAL: embeddings dim={int(_embeddings.shape[1])} "
                    f"≠ expected {EXPECTED_EMBED_DIM} (model={MODEL_NAME}). "
                    f"索引与模型维度错配 · 每次查询都会 matmul 崩 · 立即退出防止内存泄漏。"
                    f"修复：cd <qmd-engine 目录> && python3 full_scan.py rebuild",
                    file=sys.stderr, flush=True,
                )
                sys.exit(2)
            # 对齐校验：chunks 与 embeddings 行数必须一致，否则检索返回的 idx 会错位/越界。
            # 重建中途被打断 / 写入异常都可能产生不一致——此处截断到较小值并告警，
            # 宁可少检索也不返回错乱结果或崩溃（配合 two_stage_search 的边界过滤双保险）。
            if _embeddings is not None and len(_chunks) != int(_embeddings.shape[0]):
                n = min(len(_chunks), int(_embeddings.shape[0]))
                print(
                    f"[qmd-daemon] ⚠️ chunks({len(_chunks)}) vs embeddings({_embeddings.shape[0]}) "
                    f"不一致 → 截断到 {n} 保证对齐（建议重建索引）",
                    file=sys.stderr, flush=True,
                )
                _chunks = _chunks[:n]
                _embeddings = _embeddings[:n]
            _check_manifest(_chunks, _embeddings)
        return _chunks, _embeddings


def _check_manifest(chunks: list[Chunk], embeddings: Any) -> None:
    """manifest.json 是索引的尺子：写入侧记下当时的 dim/chunks 数量，
    这里加载时核对。manifest 缺失（旧索引未升级过）只 warning 不挡启动；
    一旦存在但字段对不上，说明索引状态与 manifest 记录的不一致——
    同 EXPECTED_EMBED_DIM 校验一样的 fail-fast 风格：sys.exit(2) + 报错留证。"""
    manifest_path = INDEX_DIR / "manifest.json"
    if not manifest_path.exists():
        print(
            f"[qmd-daemon] ⚠️ manifest.json 不存在（旧索引未升级）· 跳过一致性校验",
            file=sys.stderr, flush=True,
        )
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"[qmd-daemon] ⚠️ manifest.json 读取/解析失败：{e} · 跳过一致性校验",
            file=sys.stderr, flush=True,
        )
        return

    manifest_dim = manifest.get("dim")
    if manifest_dim is not None and int(manifest_dim) != EXPECTED_EMBED_DIM:
        print(
            f"[qmd-daemon] ❌ FATAL: manifest.dim={manifest_dim} "
            f"≠ EXPECTED_EMBED_DIM={EXPECTED_EMBED_DIM}。索引 manifest 与当前模型维度不符。"
            f"修复：cd <qmd-engine 目录> && python3 full_scan.py rebuild",
            file=sys.stderr, flush=True,
        )
        sys.exit(2)

    manifest_chunks = manifest.get("chunks")
    actual_chunks = int(embeddings.shape[0]) if embeddings is not None else 0
    if manifest_chunks is not None and int(manifest_chunks) != actual_chunks:
        print(
            f"[qmd-daemon] ❌ FATAL: manifest.chunks={manifest_chunks} "
            f"≠ 实际加载 embeddings 行数={actual_chunks}。索引写入可能中途中断或被截断。"
            f"修复：cd <qmd-engine 目录> && python3 full_scan.py rebuild",
            file=sys.stderr, flush=True,
        )
        sys.exit(2)


def search_memory(query: str, top_k: int = 5, rerank: bool = True) -> list[dict]:
    chunks, embeddings = get_chunks_and_embeddings()
    if not chunks or embeddings is None:
        return []
    # llama-cpp 非线程安全：embed/rerank 调用必须与 /embed 串行
    with _model_lock:
        if rerank:
            results = two_stage_search(
                chunks,
                query,
                embeddings,
                top_k=top_k,
                recall_k=max(24, top_k * 4),
            )
        else:
            results = embedding_search(chunks, query, embeddings, top_k=top_k)
    out = []
    for idx, score in results:
        if idx < 0 or idx >= len(chunks):
            continue
        c = chunks[idx]
        out.append({
            "text": c.text,
            "source": c.file_name,
            "file_path": c.file_path,
            "score": round(float(score), 4),
            "chunk_id": c.chunk_id,
        })
    return out


def reload_index() -> None:
    global _chunks, _embeddings
    with _index_lock:
        _chunks = None
        _embeddings = None
    get_chunks_and_embeddings()  # 重新获取 _index_lock，串行完成重新加载


class QMDHandler(BaseHTTPRequestHandler):
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        if host in _ALLOWED_HOSTS:
            return True
        self.send_response(403)
        self.end_headers()
        return False

    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            return
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        try:
            if parsed.path == "/health":
                emb_shape = list(_embeddings.shape) if _embeddings is not None else None
                self._json(200, {
                    "status": "ok",
                    "model": MODEL_NAME,
                    "port": DAEMON_PORT,
                    "chunks": len(_chunks or []),
                    "embeddings_shape": emb_shape,
                    "embed_endpoint": True,
                })
            elif parsed.path == "/search":
                query = params.get("query", [""])[0]
                if not query:
                    self._json(400, {"error": "missing query"})
                    return
                try:
                    top_k = int(params.get("top_k", ["5"])[0])
                except ValueError:
                    self._json(400, {"error": "top_k must be an integer"})
                    return
                rerank = params.get("rerank", ["1"])[0] != "0"
                t0 = time.time()
                results = search_memory(query, top_k, rerank)
                elapsed_ms = int((time.time() - t0) * 1000)
                self._json(200, {
                    "results": results,
                    "count": len(results),
                    "time_ms": elapsed_ms,
                    "reranked": rerank,
                })
            elif parsed.path == "/search_fast":
                # L2 召回：只跑 stage1 embedding，不调 reranker。
                # 目标 <1s，作为默认查询通道；reranker 重活留给 /search。
                query = params.get("query", [""])[0]
                if not query:
                    self._json(400, {"error": "missing query"})
                    return
                try:
                    top_k = int(params.get("top_k", ["5"])[0])
                except ValueError:
                    self._json(400, {"error": "top_k must be an integer"})
                    return
                t0 = time.time()
                results = search_memory(query, top_k, rerank=False)
                elapsed_ms = int((time.time() - t0) * 1000)
                self._json(200, {
                    "results": results,
                    "count": len(results),
                    "time_ms": elapsed_ms,
                    "reranked": False,
                })
            elif parsed.path == "/reload":
                reload_index()
                self._json(200, {
                    "status": "reloaded",
                    "chunks": len(_chunks or []),
                })
            else:
                self.send_response(404)
                self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            # client 提早断开，不视为错误
            pass
        except Exception as e:  # noqa: BLE001
            # do_POST 一直有这道兜底，do_GET 之前没有——同一个 handler 类两种
            # 错误处理哲学：未预料的异常（不只是 top_k 解析）穿透到这里时，
            # 连接会被裸着关掉、traceback 灌进 err log（还会撞上没配轮转的
            # err log 无限增长，见 qmd_daemon.py 顶部 err log 轮转注释）。
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok():
            return
        parsed = urlparse(self.path)
        if parsed.path != "/embed":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length > MAX_EMBED_BODY_BYTES:
                self._json(413, {
                    "error": f"request body too large ({length} bytes, "
                             f"max {MAX_EMBED_BODY_BYTES})"
                })
                return
            raw = self.rfile.read(length) if length > 0 else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            texts = body.get("texts")
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                self._json(400, {"error": "texts must be a list of strings"})
                return
            if not texts:
                self._json(200, {"embeddings": [], "count": 0, "dim": 0})
                return
            # 可选 batch_size：embedding 逐条独立、不跨条依赖，批处理数值等价、纯并行提速。
            # 默认 1 向后兼容；索引构建可传更大批以加速嵌入。
            try:
                batch_size = int(body.get("batch_size", 1))
            except (TypeError, ValueError):
                batch_size = 1
            batch_size = max(1, min(batch_size, len(texts)))
            # 复用常驻 embedding 模型；与 /search 互斥（llama-cpp 非线程安全）。
            with _model_lock:
                arr = embed_texts(texts, batch_size=batch_size, show_progress=False)
            self._json(200, {
                "embeddings": arr.tolist(),
                "count": int(arr.shape[0]),
                "dim": int(arr.shape[1]) if arr.ndim == 2 else 0,
            })
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


def _rotate_err_log_if_huge(max_mb: int = 10) -> None:
    """启动时兜底轮转 err log。launchd/systemd 通常不支持日志 size cap，
    只能在 daemon 里自己做——不然一个反复出现的 traceback 能把 err log 灌到几 GB。
    每次 daemon 启动/被守护进程拉起时看一眼，超阈值就搬去 .1，主文件重开。

    生效时机注意：launchd/systemd 在 exec 本进程之前就已经把 stderr 打开、
    重定向到 QMD_DAEMON_ERR_LOG 指向的路径了；这里的 rename 只是把那个 inode
    改了个名字，本进程手里的 fd 依然指向同一个 inode——也就是说本次运行剩下
    的日志还是会写进被改名后的 `.err.1`，新的主文件路径本次运行不会有任何
    输出。轮转"生效"（下次日志写进新主文件）要等到下一次进程重启（比如
    KeepAlive/Restart=on-failure 触发的重启）。这只是防止单个 err log 文件
    无限增长，不是"调用瞬间清空当前文件"。

    另外：这个函数依赖 QMD_DAEMON_ERR_LOG 环境变量才会生效——只设了
    StandardErrorPath（plist）/ 只用 shell 重定向（systemd 默认）而没设这个
    变量的话，本函数直接 return，轮转形同虚设。见 launchd/*.plist 和
    systemd/*.service 里的 QMD_DAEMON_ERR_LOG 设置，以及 DEPLOY.md 环境变量表。"""
    log_path_str = os.environ.get("QMD_DAEMON_ERR_LOG")
    p = Path(log_path_str).expanduser() if log_path_str else None
    if p is None or not p.exists():
        return
    size_mb = p.stat().st_size / 1024 / 1024
    if size_mb <= max_mb:
        return
    rotated = p.with_suffix(".err.1")
    try:
        if rotated.exists():
            rotated.unlink()
        p.rename(rotated)
        print(f"[qmd-daemon] err log 轮转 {size_mb:.1f}MB → {rotated.name}",
              file=sys.stderr, flush=True)
    except OSError as e:
        print(f"[qmd-daemon] err log 轮转失败：{e}", file=sys.stderr, flush=True)


def main() -> None:
    _rotate_err_log_if_huge()
    print("[qmd-daemon] 加载 chunks + embeddings ...", file=sys.stderr, flush=True)
    t0 = time.time()
    get_chunks_and_embeddings()
    shape = _embeddings.shape if _embeddings is not None else None
    print(f"[qmd-daemon] chunks={len(_chunks or [])} embeddings={shape} ({time.time()-t0:.1f}s)", file=sys.stderr, flush=True)

    print("[qmd-daemon] 加载 embedding model ...", file=sys.stderr, flush=True)
    t0 = time.time()
    _get_embedding_model()
    print(f"[qmd-daemon] embedding model ready ({time.time()-t0:.1f}s)", file=sys.stderr, flush=True)

    print("[qmd-daemon] 加载 reranker model ...", file=sys.stderr, flush=True)
    t0 = time.time()
    _get_reranker_model()
    print(f"[qmd-daemon] reranker model ready ({time.time()-t0:.1f}s)", file=sys.stderr, flush=True)

    print(f"[qmd-daemon] listening on 127.0.0.1:{DAEMON_PORT} (threaded)", file=sys.stderr, flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", DAEMON_PORT), QMDHandler)
    # llama-cpp 不是线程安全 — 但 HTTPServer 多线程主要保护"小请求被大请求堵住"
    # search 仍然受 embedding_model 单实例 + GIL 排队（不会真并行 embed）
    # 但 health/reload 可以 instant 响应不被 search hang 阻塞

    def shutdown(sig: int, frame: Any) -> None:
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.serve_forever()


if __name__ == "__main__":
    main()
