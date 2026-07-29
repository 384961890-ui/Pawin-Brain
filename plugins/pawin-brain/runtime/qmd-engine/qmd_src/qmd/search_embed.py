"""Embedding-based semantic search over indexed chunks with Qwen3 GGUF models."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from llama_cpp import Llama
    from qmd.ingest import Chunk

# GGUF 模型路径来自 qmd_config（QMD_MODELS_DIR 环境变量可覆盖，默认 ~/.qmd/models）
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from qmd_config import EMBEDDING_MODEL_PATH, RERANKER_MODEL_PATH  # noqa: E402

EMBEDDINGS_FILE = "embeddings.npy"

# Qwen3 官方查询侧非对称 instruct 前缀。只用于 embedding_search() 里 embed query 之前——
# 红线：文档侧 embed_texts()（被索引构建器 / daemon /embed 调用）绝不加此前缀。
# 加了前缀的召回质量差异见 PITFALLS.md「查询加 instruct 前缀」条。
QUERY_INSTRUCT = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: "

_embedding_model: Llama | None = None
_reranker_model: Llama | None = None


def _get_embedding_model() -> Llama:
    global _embedding_model
    if _embedding_model is not None:
        return _embedding_model
    from llama_cpp import Llama
    # n_ctx 决定 KV cache / compute buffer 的内存占用（GB 级），且是常驻开销。
    # chunk 长度必须小于这里的 n_ctx，否则向量会被静默截断/糊掉——
    # 见 PITFALLS.md「chunk 尺寸必须小于嵌入模型有效 token 窗口」条。
    # 注意：n_ctx 只限制单次最大长度，不改变 ≤n_ctx 文本的 embedding 数值——
    # 调低后已有索引（≤n_ctx token 的 chunk）无需重新嵌入。
    import llama_cpp
    _embedding_model = Llama(
        model_path=EMBEDDING_MODEL_PATH,
        embedding=True,
        n_ctx=8192,
        n_gpu_layers=-1,
        verbose=False,
        pooling_type=llama_cpp.LLAMA_POOLING_TYPE_LAST,
        n_batch=256,
        n_ubatch=256,
    )
    return _embedding_model


def _get_reranker_model() -> Llama:
    global _reranker_model
    if _reranker_model is not None:
        return _reranker_model
    from llama_cpp import Llama
    _reranker_model = Llama(
        model_path=RERANKER_MODEL_PATH,
        embedding=False,
        n_ctx=4096,
        n_gpu_layers=-1,
        verbose=False,
        logits_all=True,
    )
    return _reranker_model


def embed_texts(
    texts: list[str],
    batch_size: int = 32,
    show_progress: bool = True,
) -> np.ndarray:
    """Embed a list of texts, returning a (N, dim) float32 numpy array.

    Uses Qwen3-Embedding-4B GGUF via llama-cpp with last-token pooling.
    """
    model = _get_embedding_model()

    all_embeddings = []
    total = len(texts)

    for i in range(0, total, batch_size):
        batch = texts[i : i + batch_size]
        batch_embeds = model.embed(batch)
        all_embeddings.extend(batch_embeds)

        if show_progress and total > batch_size:
            done = min(i + batch_size, total)
            print(f"\rembed: {done}/{total}", end="", file=sys.stderr)

    if show_progress and total > batch_size:
        print(file=sys.stderr)

    result = np.array(all_embeddings, dtype=np.float32)
    # L2 normalize (Qwen3 embeddings should already be normalized, but ensure)
    norms = np.linalg.norm(result, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return result / norms


def save_embeddings(index_dir: Path, embeddings: np.ndarray) -> Path:
    """原子写：先写临时文件再 os.replace() 转正，和 full_scan.py 的
    _atomic_write_npy 同一套写盘纪律——np.save 直接写目标路径中途被杀
    （OOM/手动中断）会留下半成品 .npy，被 load_embeddings 读到损坏文件。"""
    import io
    import os as _os

    index_dir.mkdir(parents=True, exist_ok=True)
    path = index_dir / EMBEDDINGS_FILE
    buf = io.BytesIO()
    np.save(buf, embeddings)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "wb") as f:
        f.write(buf.getvalue())
    _os.replace(tmp_path, path)
    return path


def load_embeddings(index_dir: Path) -> np.ndarray | None:
    path = index_dir / EMBEDDINGS_FILE
    if not path.exists():
        return None
    return np.load(path)


def embedding_search(
    chunks: list[Chunk],
    query: str,
    embeddings: np.ndarray,
    top_k: int = 5,
    model=None,
) -> list[tuple[int, float]]:
    """Return top-k (chunk_index, score) pairs by cosine similarity."""
    if model is None:
        model = _get_embedding_model()
    query_vec = np.array(model.embed([QUERY_INSTRUCT + query])[0], dtype=np.float32)
    query_vec = query_vec / (np.linalg.norm(query_vec) or 1.0)

    scores = (embeddings @ query_vec).flatten()
    top_indices = scores.argsort()[::-1][:top_k]
    return [(int(idx), float(scores[idx])) for idx in top_indices if scores[idx] > 0]


# yes/no 的 token id 之前是硬编码的（9693 / 2152），注释还写着"cached after
# first model load"——其实压根不是 cache，是写死的数字。这两个 id 是当前
# 这一个模型的 tokenizer 算出来的常量，换一个 reranker 模型（不同量化档位、
# 不同底座，DEPLOY.md 明说这是可以换的）token id 大概率就变了，继续用旧数字去
# 读 logits 数组 = 读到了别的 token 的分数，不会报错，就是精排分数全错——
# PITFALLS.md 通篇都在讲"静默错分数最隐蔽"，这里是自己踩了同款雷。
# 改成启动时用当前加载的模型现算：tokenize("yes")/("no") 各自应该是单个
# token，不是就说明 tokenizer 和预期的不一致，直接 assert 报出来而不是
# 带着错误 id 继续跑。
_yes_token_id: int | None = None
_no_token_id: int | None = None


def _get_yes_no_token_ids(model: Llama) -> tuple[int, int]:
    global _yes_token_id, _no_token_id
    if _yes_token_id is None or _no_token_id is None:
        yes_tokens = model.tokenize(b"yes", add_bos=False, special=False)
        no_tokens = model.tokenize(b"no", add_bos=False, special=False)
        assert len(yes_tokens) == 1, (
            f"'yes' 未被编码为单个 token（实际 {yes_tokens}）——"
            f"reranker 模型/tokenizer 与预期不符，yes/no 打分逻辑不成立"
        )
        assert len(no_tokens) == 1, (
            f"'no' 未被编码为单个 token（实际 {no_tokens}）——"
            f"reranker 模型/tokenizer 与预期不符，yes/no 打分逻辑不成立"
        )
        _yes_token_id, _no_token_id = yes_tokens[0], no_tokens[0]
    return _yes_token_id, _no_token_id


def rerank(
    query: str,
    documents: list[str],
    top_k: int = 10,
) -> list[tuple[int, float]]:
    """Cross-encoder reranking with Qwen3-Reranker-0.6B.

    Uses yes/no logit scoring via model.eval: P(yes) / (P(yes) + P(no)).
    """
    model = _get_reranker_model()
    yes_token_id, no_token_id = _get_yes_no_token_ids(model)
    scores: list[tuple[int, float]] = []

    max_doc_chars = 500  # ~125 tokens, leaving room for prompt template (~70 tokens)
    for idx, doc in enumerate(documents):
        doc_short = doc if len(doc) <= max_doc_chars else doc[:max_doc_chars]
        prompt = (
            "<|im_start|>system\n"
            "Judge whether the following document is relevant to the query. "
            'Output only "yes" or "no".<|im_end|>\n'
            "<|im_start|>user\n"
            f"Query: {query}\n"
            f"Document: {doc_short}<|im_end|>\n"
            "<|im_start|>assistant\n"
        )
        tokens = model.tokenize(prompt.encode("utf-8"), add_bos=True, special=True)
        # Full reset: clears n_tokens, input_ids, scores, AND kv cache.
        # Using only kv_cache_clear() leaves n_tokens accumulated across calls
        # → broadcast shape mismatch on long docs.
        model.reset()
        model.eval(tokens)
        # eval_logits[-1] is the last position's full vocab logits (list of n_vocab floats)
        last_logits = model.eval_logits[-1]
        # Prevent memory accumulation from logits_all
        model.eval_logits.clear()

        yes_logit = float(last_logits[yes_token_id])
        no_logit = float(last_logits[no_token_id])
        # Log-likelihood ratio: higher = more likely relevant
        score = yes_logit - no_logit
        scores.append((idx, score))

    scores.sort(key=lambda x: x[1], reverse=True)
    return scores[:top_k]


def two_stage_search(
    chunks: list[Chunk],
    query: str,
    embeddings: np.ndarray,
    top_k: int = 10,
    recall_k: int = 50,
) -> list[tuple[int, float]]:
    """Two-stage retrieval: embedding recall (top recall_k) + reranker (top top_k)."""
    # Stage 1: embedding recall
    stage1_results = embedding_search(chunks, query, embeddings, top_k=min(recall_k, len(chunks)))

    if not stage1_results:
        return []

    # Stage 2: cross-encoder rerank
    # 防御：过滤越界 idx（embeddings 行数 > chunks 时不再 IndexError 崩溃）
    indices = [idx for idx, _ in stage1_results if 0 <= idx < len(chunks)]
    documents = [chunks[idx].text for idx in indices]
    reranked = rerank(query, documents, top_k=top_k)

    return [(indices[idx], score) for idx, score in reranked]
