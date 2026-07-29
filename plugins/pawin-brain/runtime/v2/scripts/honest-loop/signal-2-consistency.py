#!/usr/bin/env python3
"""
signal-2-consistency.py — 一致性信号（语义熵）

核心思想（学术依据：Kuhn et al. semantic entropy + Lin et al.）:
  把同一个 prompt 用 T=0.7 跑 3-5 次，看答案是否一致。
  - 全部一致 → entropy=0 → 高置信
  - 答案分散 → entropy 高 → 低置信（模型在猜）

输出 P_consistency ∈ [0, 1]，可作为 5 源融合的一个信号。

用法:
  echo '{"prompt": "DeepSeek V4 Pro 是开源吗?", "samples": 3}' | python3 signal-2-consistency.py

输入 stdin JSON:
  {
    "prompt": "<事实性 query>",
    "samples": 3,            # 采样次数，默认 3
    "temperature": 0.7,      # 默认 0.7
    "model": "deepseek-chat" # 默认 deepseek-chat
  }

输出 stdout JSON:
  {
    "p_consistency": 0.85,   # 一致性置信度 [0,1]
    "samples": [...],        # 原始采样
    "unique_clusters": 1,    # 语义聚类数
    "entropy": 0.12,         # 语义熵
    "duration_ms": 4500
  }
"""

import sys
import json
import re
import time
import os
import urllib.request
import urllib.error
from collections import Counter
import math

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not DEEPSEEK_API_KEY:
    raise RuntimeError("DEEPSEEK_API_KEY env var not set")
DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'


def call_deepseek(prompt: str, temperature: float = 0, model: str = 'deepseek-chat') -> str:
    """单次调 DeepSeek 返回 content"""
    req_body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 200,
        "temperature": temperature,
    }).encode('utf-8')

    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=req_body,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
        method='POST',
    )

    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        return data['choices'][0]['message']['content']


def normalize(text: str) -> str:
    """粗粒度归一化（去空格 / 转小写 / 取前 300 字）— 用于初步聚类"""
    return ''.join(text.lower().split())[:300]


def cluster_answers_llm(answers: list[str], original_query: str) -> list[list[int]]:
    """
    用 LLM 判断 N 个答案是不是"在说同一件事"。
    比 prefix 匹配可靠 100 倍（中文 surface form 变化大）。
    """
    if len(answers) <= 1:
        return [[i] for i in range(len(answers))]

    labeled = '\n\n'.join(f"[{i}] {a}" for i, a in enumerate(answers))
    judge_prompt = f"""原始问题: {original_query}

下面 {len(answers)} 个回答是模型对同一问题不同温度采样的结果。任务：判断它们在**语义上**是否说的是同一件事（不是 surface form）。

回答列表:
{labeled}

输出格式（无 markdown 代码块）— 用列表表示每个 cluster 里的索引:
{{"clusters": [[0, 2], [1]], "explanation": "<一句话>"}}

规则:
- 都说"是" → 一个 cluster
- 都说"否" → 一个 cluster
- 都说"不确定/不知道" → 一个 cluster
- 一半说是一半说否 → 两个 cluster"""

    try:
        result = call_deepseek(judge_prompt, temperature=0, model='deepseek-chat')
        m = re.search(r'\{[^}]*"clusters"[^}]*\}', result, re.DOTALL)
        if not m:
            return cluster_answers_prefix(answers)
        parsed = json.loads(m.group())
        clusters = parsed.get('clusters', [])
        # 验证完整性: 所有索引都被覆盖
        flat = [i for c in clusters for i in c]
        if sorted(flat) != list(range(len(answers))):
            return cluster_answers_prefix(answers)
        return clusters
    except (urllib.error.URLError, json.JSONDecodeError, KeyError, ValueError):
        return cluster_answers_prefix(answers)


def cluster_answers_prefix(answers: list[str]) -> list[list[int]]:
    """旧的 prefix 聚类 — 兜底用"""
    norms = [normalize(a) for a in answers]
    clusters: dict[str, list[int]] = {}
    for i, n in enumerate(norms):
        matched = False
        for key, idxs in clusters.items():
            if n[:50] == key[:50]:
                idxs.append(i); matched = True; break
        if not matched:
            clusters[n] = [i]
    return list(clusters.values())


# 别名 — main 用
def cluster_answers(answers: list[str], original_query: str = '') -> list[list[int]]:
    if not original_query:
        return cluster_answers_prefix(answers)
    return cluster_answers_llm(answers, original_query)


def shannon_entropy(probs: list[float]) -> float:
    """香农熵 — 答案分布越分散越高"""
    return -sum(p * math.log2(p) for p in probs if p > 0)


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        print(json.dumps({"error": "invalid json input"}))
        sys.exit(1)

    prompt = req.get('prompt')
    if not prompt:
        print(json.dumps({"error": "missing prompt"}))
        sys.exit(1)

    samples = req.get('samples', 3)
    temperature = req.get('temperature', 0.7)
    model = req.get('model', 'deepseek-chat')

    t0 = time.time()
    answers = []
    errors = []

    for i in range(samples):
        try:
            ans = call_deepseek(prompt, temperature, model)
            answers.append(ans)
        except (urllib.error.URLError, KeyError, json.JSONDecodeError) as e:
            errors.append(str(e))

    duration_ms = int((time.time() - t0) * 1000)

    if not answers:
        print(json.dumps({
            "error": "all samples failed",
            "errors": errors,
            "duration_ms": duration_ms,
        }))
        sys.exit(1)

    # 聚类 + 算熵（LLM 聚类）
    clusters = cluster_answers(answers, original_query=prompt)
    counts = [len(c) for c in clusters]
    probs = [c / len(answers) for c in counts]
    entropy = shannon_entropy(probs)
    max_entropy = math.log2(len(answers)) if len(answers) > 1 else 1

    # 归一化熵 → [0,1]，然后 p_consistency = 1 - normalized_entropy
    normalized_entropy = entropy / max_entropy if max_entropy > 0 else 0
    p_consistency = round(1.0 - normalized_entropy, 3)

    result = {
        "p_consistency": p_consistency,
        "samples": answers,
        "sample_count": len(answers),
        "unique_clusters": len(clusters),
        "entropy": round(entropy, 3),
        "normalized_entropy": round(normalized_entropy, 3),
        "duration_ms": duration_ms,
        "errors": errors,
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
