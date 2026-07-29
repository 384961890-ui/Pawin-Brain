"""QMD 唯一配置出处：维度 / 模型名 / 目录路径。

全部通过环境变量配置，不带任何硬编码的个人路径：

  QMD_HOME          根目录，默认 ~/.qmd
  QMD_INDEX_DIR      索引目录（chunks.jsonl / embeddings.npy / manifest.json），
                      默认 $QMD_HOME/index
  QMD_MODELS_DIR      GGUF 模型目录，默认 $QMD_HOME/models
  QMD_MEMORY_DIR      待索引的目录，多个用系统 PATH 分隔符（macOS/Linux 用 ':'）
                      分隔，默认 $QMD_HOME/memory

维度/模型改了必须同步改这里——EXPECTED_EMBED_DIM 与索引里存的向量维度
必须一致，否则 embeddings @ query_vec 会静默算出乱码分数（见 PITFALLS.md）。
"""
from __future__ import annotations

import os
from pathlib import Path

# Qwen3-Embedding-4B GGUF 输出 2560 维。索引维度必须与此匹配，否则
# embeddings @ query_vec 会静默产出无意义分数（不报错，只是检索结果全错）。
# 换模型 = 换维度，必须重算全部索引，见 PITFALLS.md「换 embedding 模型」条。
EXPECTED_EMBED_DIM = 2560

MODEL_NAME = "Qwen3-Embedding-4B-Q8 + Qwen3-Reranker-0.6B-Q8"


def _env_path(var: str, default: Path) -> Path:
    val = os.environ.get(var)
    return Path(val).expanduser() if val else default


QMD_HOME = _env_path("QMD_HOME", Path.home() / ".qmd")
INDEX_DIR = _env_path("QMD_INDEX_DIR", QMD_HOME / "index")
MODELS_DIR = _env_path("QMD_MODELS_DIR", QMD_HOME / "models")

EMBEDDING_MODEL_PATH = str(MODELS_DIR / "Qwen3-Embedding-4B-Q8_0.gguf")
RERANKER_MODEL_PATH = str(MODELS_DIR / "qwen3-reranker-0.6b-q8_0.gguf")


def get_memory_dirs() -> list[Path]:
    """待索引目录列表。QMD_MEMORY_DIR 用 os.pathsep 分隔多个路径；
    不设置则默认只扫 $QMD_HOME/memory。"""
    raw = os.environ.get("QMD_MEMORY_DIR")
    if raw:
        return [Path(p).expanduser() for p in raw.split(os.pathsep) if p.strip()]
    return [QMD_HOME / "memory"]
