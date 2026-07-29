#!/usr/bin/env python3
"""qmd-engine 三层召回健康自检 · 治"静默失败没人知道"

每次运行：
  1. L1 grep 精确：真跑一次 grep 到已知探针词
  2. L2 QMD /search_fast：真跑一次语义搜索
  3. L3 QMD /search（reranker）：真跑一次深查询
  4. 任一层 fail → 写日志 + stderr 告警 + exit code 非零

产出：`$QMD_HEALTH_LOG_DIR/qmd-health-<YYYY-MM-DD>.md`
     · 建议接到定时任务里，每天巡一次，出问题能第一时间发现，
       而不是"静默瘫了好几天没人知道"。

探针词全部来自环境变量，不带任何真实记忆内容：
  QMD_HEALTH_GREP_PROBES      逗号分隔，L1 grep 精确探针（必须是索引里
                               100% 存在的词，测的是"grep 能跑"不是"抽象词命中"）
  QMD_HEALTH_SEMANTIC_PROBES  逗号分隔，L2/L3 语义探针（抽象概念/模糊
                               表达，测的是"语义匹配层能不能捞回结果"）
用户不配置时，用一组不依赖具体记忆内容的通用兜底词（可能命中率为 0，
仅验证链路是否可达，不代表检索质量）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

# 复用 qmd_config 作为"唯一配置出处"——之前这里自己重新拼了一套
# QMD_HOME/QMD_INDEX_DIR/QMD_HEALTH_LOG_DIR/EXPECTED_DIM 的默认值，
# 且默认值是硬编码 ~/.qmd/... 而不是从 QMD_HOME 派生：用户只设了 QMD_HOME
# 时，nightly_run.sh 和这里各自的 fallback 就会和 qmd_config.py 的真实
# 派生结果对不上，体检/告警盯着的是错误目录（QMD_HOME 断链）。
sys.path.insert(0, str(Path(__file__).parent))
from qmd_config import (  # noqa: E402
    EXPECTED_EMBED_DIM as _CONFIG_EXPECTED_DIM,
    INDEX_DIR as _CONFIG_INDEX_DIR,
    QMD_HOME as _CONFIG_QMD_HOME,
)

DAEMON_BASE = f"http://127.0.0.1:{os.environ.get('QMD_DAEMON_PORT', '18765')}"
LOG_DIR = Path(os.environ.get("QMD_HEALTH_LOG_DIR", str(_CONFIG_QMD_HOME / "health-log")))
GREP_ROOT = Path(os.environ.get("QMD_MEMORY_DIR", str(_CONFIG_QMD_HOME / "memory")).split(os.pathsep)[0])

_DEFAULT_GREP_PROBES = ["README", "TODO"]
_DEFAULT_SEMANTIC_PROBES = ["项目笔记", "重要决定"]

_grep_probes_env = [
    p.strip() for p in os.environ.get("QMD_HEALTH_GREP_PROBES", "").split(",") if p.strip()
]
_semantic_probes_env = [
    p.strip() for p in os.environ.get("QMD_HEALTH_SEMANTIC_PROBES", "").split(",") if p.strip()
]
# 用户没配置探针词时退到通用兜底词——但兜底词不保证在索引里真的命中
# （PITFALLS.md §5 讲的"探针必须是已知命中"这条对默认词不成立）。所以默认词
# 只验证"链路能跑通"（daemon/grep 正常响应），不把 count=0 当失败；
# 用户自己配置过的探针词才按"必须命中"的严格标准判。
GREP_PROBES = _grep_probes_env or _DEFAULT_GREP_PROBES
GREP_PROBES_STRICT = bool(_grep_probes_env)
SEMANTIC_PROBES = _semantic_probes_env or _DEFAULT_SEMANTIC_PROBES
SEMANTIC_PROBES_STRICT = bool(_semantic_probes_env)
RERANK_PROBE = SEMANTIC_PROBES[0]

EXPECTED_DIM = int(os.environ.get("QMD_EXPECTED_EMBED_DIM", str(_CONFIG_EXPECTED_DIM)))


def _local_now() -> datetime:
    return datetime.now().astimezone()


def check_l1_grep(query: str, require_hit: bool = True) -> tuple[bool, str]:
    """L1 · grep 精确 · 用 grep 找已知探针词。

    require_hit=False（默认兜底探针）时只验证 grep 链路本身能正常跑
    （退出码合法），不强制要求命中——兜底词不保证在用户索引里真实存在。
    """
    try:
        cp = subprocess.run(
            # -e 显式标记查询是"要匹配的模式"，不加它时以 '-' 开头的探针词
            # 会被 grep 当成选项吃掉（比如探针词恰好是 "-something"）。
            ["grep", "-r", "-l", "--include=*.md", "-e", query, str(GREP_ROOT)],
            capture_output=True, text=True, timeout=15,
        )
        hits = [line for line in cp.stdout.splitlines() if line]
        if cp.returncode not in (0, 1):
            return False, f"grep exit={cp.returncode} stderr={cp.stderr[:200]}"
        if not require_hit:
            return True, f"grep hits={len(hits)}（链路验证模式 · 未强制要求命中）"
        return (len(hits) > 0), f"grep hits={len(hits)}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def check_l2_fast(query: str, require_hit: bool = True) -> tuple[bool, str]:
    """L2 · QMD /search_fast · 纯 embedding recall。"""
    return _http_search("/search_fast", query, expect_reranked=False, require_hit=require_hit)


def check_l3_rerank(query: str, require_hit: bool = True) -> tuple[bool, str]:
    """L3 · QMD /search reranker · 深查询。"""
    return _http_search("/search", query, expect_reranked=True, timeout=120, require_hit=require_hit)


def _http_search(path: str, query: str, expect_reranked: bool,
                 timeout: float = 15, require_hit: bool = True) -> tuple[bool, str]:
    qs = urllib.parse.urlencode({"query": query, "top_k": 3})
    url = f"{DAEMON_BASE}{path}?{qs}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        count = int(data.get("count", 0))
        elapsed = int(data.get("time_ms", 0))
        reranked = bool(data.get("reranked", False))
        if count == 0:
            if not require_hit:
                return True, f"count=0（链路验证模式 · 未强制要求命中 · reranked={reranked}）"
            return False, f"count=0（daemon 200 但空 · 静默失败模式）"
        if reranked != expect_reranked:
            return False, f"reranked={reranked} 期望 {expect_reranked}"
        return True, f"count={count} time_ms={elapsed} reranked={reranked}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} {e.reason}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def check_daemon_health() -> tuple[bool, str]:
    """/health · 索引 shape 是否对齐 · daemon 是否在。"""
    try:
        with urllib.request.urlopen(f"{DAEMON_BASE}/health", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        chunks = int(data.get("chunks", 0))
        shape = data.get("embeddings_shape") or []
        if chunks == 0:
            return False, f"chunks=0 索引空"
        if len(shape) != 2 or shape[1] != EXPECTED_DIM:
            return False, f"shape={shape} 维度错配（期望 [*, {EXPECTED_DIM}]）"
        return True, f"chunks={chunks} shape={shape}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def main() -> int:
    now = _local_now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")
    log_path = LOG_DIR / f"qmd-health-{date_str}.md"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    results: list[tuple[str, bool, str]] = []

    ok, msg = check_daemon_health()
    results.append(("daemon /health", ok, msg))

    for query in GREP_PROBES:
        ok, msg = check_l1_grep(query, require_hit=GREP_PROBES_STRICT)
        results.append((f"L1 grep · {query!r}", ok, msg))

    for query in SEMANTIC_PROBES:
        ok, msg = check_l2_fast(query, require_hit=SEMANTIC_PROBES_STRICT)
        results.append((f"L2 /search_fast · {query!r}", ok, msg))

    ok, msg = check_l3_rerank(RERANK_PROBE, require_hit=SEMANTIC_PROBES_STRICT)
    results.append((f"L3 /search rerank · {RERANK_PROBE!r}", ok, msg))

    if not (GREP_PROBES_STRICT and SEMANTIC_PROBES_STRICT):
        results.append((
            "ℹ️ 探针模式", True,
            "使用了未配置的默认探针词（QMD_HEALTH_GREP_PROBES/QMD_HEALTH_SEMANTIC_PROBES 未设置）"
            "· 本轮只验证链路可达，不代表检索命中率 · 建议配置成你索引库里确实存在的词以获得真实命中验证",
        ))

    # NEEDS-REBUILD：增量扫描检测到需重建但自动重建可能已按策略禁用
    # （见 PITFALLS.md「索引重建必须原子化」——重建很重，建议人工前台触发）。
    # 体检报 🔴 提醒人工跑 rebuild，跑完手动删这个文件即回绿。
    # index_dir 直接复用 qmd_config 的 INDEX_DIR（已正确处理 QMD_INDEX_DIR
    # 覆盖 / 从 QMD_HOME 派生两种情况），不再自己重新拼一套默认值。
    index_dir = _CONFIG_INDEX_DIR
    needs = index_dir / "NEEDS-REBUILD"
    if needs.exists():
        try:
            body = needs.read_text().strip().splitlines()
            tail = body[-1] if body else ""
        except OSError:
            tail = "(读取失败)"
        results.append(("⚠️ 待人工重建", False,
                        f"检测到 NEEDS-REBUILD：{tail}｜人工跑 full_scan.py rebuild 后删除此文件回绿"))

    all_ok = all(ok for _, ok, _ in results)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    verdict = "✅ 全绿" if all_ok else f"🔴 {total - passed}/{total} 层瘫"

    lines = [
        f"# QMD 三层召回健康自检 · {date_str} {time_str}\n",
        f"**结论**：{verdict}\n",
        f"| # | 层 | 结果 | 详情 |",
        f"|---|---|---|---|",
    ]
    for i, (name, ok, msg) in enumerate(results, 1):
        icon = "✅" if ok else "🔴"
        lines.append(f"| {i} | {name} | {icon} | {msg} |")
    lines.append("")
    if not all_ok:
        lines.append("**告警**：至少一层瘫了。翻上面表看细节，参考 PITFALLS.md。")
        lines.append("")

    # append 模式：一天多次跑（每次运行都留证据），日志不清空
    with open(log_path, "a", encoding="utf-8") as f:
        f.write("\n---\n\n" if log_path.exists() and log_path.stat().st_size > 0 else "")
        f.write("\n".join(lines) + "\n")

    # stderr 告警：让守护进程/定时任务捕获、终端用户看得见
    if not all_ok:
        print(f"[qmd-health-check] {verdict} · 详见 {log_path}", file=sys.stderr)
        for name, ok, msg in results:
            if not ok:
                print(f"[qmd-health-check]   🔴 {name}: {msg}", file=sys.stderr)
    else:
        print(f"[qmd-health-check] {verdict} · {passed}/{total} · 详见 {log_path}", file=sys.stderr)

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
