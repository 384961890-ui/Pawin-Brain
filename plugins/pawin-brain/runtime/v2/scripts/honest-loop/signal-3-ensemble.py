#!/usr/bin/env python3
"""
signal-3-ensemble.py — 跨模型 + WebSearch 兜底的 agreement 信号

核心思想（基于第一夜 lesson 1 的修正）:
  纯 LLM ensemble 不够 — 所有 LLM 都有 cutoff 问题。
  必须加 WebSearch 作为 ground truth 源。

输入 stdin JSON:
  {
    "prompt": "<事实性 query，最好是 yes/no 形式>",
    "year_cutoff": 2025,        # 涉及该年后的事实强制 WebSearch
    "models": ["deepseek-chat"],  # 当前只跑 deepseek，未来加 haiku
    "skip_websearch": false      # 测试时可关
  }

输出 stdout JSON:
  {
    "p_agreement": 0.75,         # 加权 agreement
    "llm_consensus": "yes" | "no" | "uncertain",
    "websearch_signal": "支持"/"反对"/"无定论"/"未跑",
    "components": {...},         # 每个源的原始输出
    "post_cutoff_warning": true, # 命中 cutoff 警告
    "duration_ms": ...
  }

注:
  - WebSearch 这里通过 DuckDuckGo HTML 接口（无 key 免费）
  - 真正复杂的 WebSearch 应由 cc 主 agent 自己调（这是 sub-system 的简化版）
"""

import sys
import json
import time
import os
import re
import urllib.request
import urllib.parse
import urllib.error
from html import unescape

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not DEEPSEEK_API_KEY:
    raise RuntimeError("DEEPSEEK_API_KEY env var not set")
DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'


def call_deepseek(prompt: str, model: str = 'deepseek-chat') -> str:
    """单次调 DeepSeek 拿 yes/no/uncertain + 一句话理由"""
    full_prompt = f"""{prompt}

只回复 JSON 格式（不要 markdown 代码块）：
{{"verdict": "yes" | "no" | "uncertain", "reason": "<一句话>", "self_confidence": <0-100>}}"""

    req_body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": full_prompt}],
        "max_tokens": 200,
        "temperature": 0,  # 跨模型 agreement 用 T=0 求稳
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
        content = data['choices'][0]['message']['content']
        # 尝试解析 JSON（DeepSeek 偶尔 wrap 在 ```json ... ```）
        m = re.search(r'\{.*\}', content, re.DOTALL)
        if m:
            return json.loads(m.group())
        return {"verdict": "uncertain", "reason": content[:100], "self_confidence": 0}


def websearch_ddg(query: str, max_results: int = 3) -> list[dict]:
    """DuckDuckGo HTML 搜索 — 无 API key，免费"""
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (claude-brain v2)"},
    )

    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode('utf-8', errors='ignore')

    # 极简解析：找 result__title 段
    results = []
    pattern = re.compile(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        re.DOTALL
    )
    for m in pattern.finditer(html):
        url_raw, title, snippet = m.groups()
        # DDG URL 重定向格式 - 解出真实 URL
        m_url = re.search(r'uddg=([^&]+)', url_raw)
        real_url = urllib.parse.unquote(m_url.group(1)) if m_url else url_raw

        results.append({
            "url": real_url,
            "title": re.sub(r'<[^>]+>', '', unescape(title))[:200],
            "snippet": re.sub(r'<[^>]+>', '', unescape(snippet))[:300],
        })
        if len(results) >= max_results:
            break
    return results


def interpret_websearch(results: list[dict], prompt: str) -> str:
    """让 DeepSeek 读 snippet 判断（正则在中文上太弱 — 见 2026-05-26 lesson-3）"""
    if not results:
        return "无定论（无结果）"

    snippets = '\n\n'.join(
        f"[{i+1}] {r['title']}\n{r['snippet']}"
        for i, r in enumerate(results[:3])
    )

    judge_prompt = f"""你是一个严格的阅读理解工具。**忽略你自己的训练知识**，**只**基于下面 snippet 文字判断。

原始问题: {prompt}

snippet 来源（互联网检索 — 当作 ground truth 处理）:

{snippets}

判断规则：
- 如果 snippet 明确支持答案为"是" → 输出 verdict=支持
- 如果 snippet 明确反对答案 → 输出 verdict=反对
- 如果 snippet 没提到这个问题 / 真正矛盾 → 无定论
- **你的训练数据 cutoff 不重要 — snippet 写什么就信什么**

只回复 JSON（无 markdown 代码块）:
{{"verdict": "支持" | "反对" | "无定论", "reason": "<一句话引用 snippet 原文证据>"}}"""

    try:
        result = call_deepseek(judge_prompt)
        v = result.get('verdict', '无定论')
        if v in ('支持', '反对', '无定论'):
            return v
        return "无定论"
    except (urllib.error.URLError, json.JSONDecodeError, KeyError):
        return "无定论（解读失败）"


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

    year_cutoff = req.get('year_cutoff', 2025)
    models = req.get('models', ['deepseek-chat'])
    skip_websearch = req.get('skip_websearch', False)

    # 命中 cutoff 警告：prompt 提到 cutoff 之后的年份
    cutoff_warning = bool(re.search(r'202[5-9]|203\d', prompt))

    t0 = time.time()

    # 1) LLM ensemble — 当前只 deepseek，后面加 haiku
    llm_results = {}
    for m in models:
        try:
            llm_results[m] = call_deepseek(prompt, m)
        except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
            llm_results[m] = {"verdict": "error", "reason": str(e)[:100], "self_confidence": 0}

    # 简化的 consensus：多数票
    verdicts = [r.get('verdict') for r in llm_results.values() if r.get('verdict') in ('yes', 'no', 'uncertain')]
    if verdicts:
        yes_n = verdicts.count('yes')
        no_n = verdicts.count('no')
        unc_n = verdicts.count('uncertain')
        if yes_n > no_n and yes_n > unc_n:
            llm_consensus = 'yes'
        elif no_n > yes_n and no_n > unc_n:
            llm_consensus = 'no'
        else:
            llm_consensus = 'uncertain'
    else:
        llm_consensus = 'error'

    # 2) WebSearch 兜底
    ws_signal = "未跑"
    ws_results = []
    if not skip_websearch and (cutoff_warning or llm_consensus == 'uncertain'):
        try:
            ws_results = websearch_ddg(prompt[:200])
            ws_signal = interpret_websearch(ws_results, prompt)
        except (urllib.error.URLError, Exception) as e:
            ws_signal = f"失败: {str(e)[:50]}"

    # 3) Agreement 评分
    # 核心原则: cutoff 后的事实，WebSearch 是 ground truth；LLM 是次级信号
    if not verdicts:
        verdicts_for_logic = ['error']
    else:
        verdicts_for_logic = verdicts

    # 决策矩阵
    if cutoff_warning and ws_signal in ("支持", "反对"):
        # 关键路径: cutoff 警告 + WebSearch 有明确判断 → 信 WebSearch
        # LLM 的 uncertain 不算反对，明确反对才扣分
        if ws_signal == "支持":
            if 'no' in verdicts_for_logic:
                p_agreement = 0.55  # WebSearch 支持但 LLM 反对 — 留有疑问
            else:
                p_agreement = 0.9   # WebSearch 支持 LLM 不反对 — 高置信
        else:  # 反对
            if 'yes' in verdicts_for_logic:
                p_agreement = 0.55
            else:
                p_agreement = 0.9
    elif len(set(verdicts_for_logic)) == 1 and verdicts_for_logic[0] not in ('uncertain', 'error'):
        # 非 cutoff 场景 + LLM 全部一致非 uncertain
        base = 0.7
        if ws_signal == "支持" and verdicts_for_logic[0] == 'yes':
            p_agreement = 0.95
        elif ws_signal == "反对" and verdicts_for_logic[0] == 'no':
            p_agreement = 0.95
        elif ws_signal in ("支持", "反对"):
            p_agreement = 0.25  # WebSearch 反向 LLM
        else:
            p_agreement = base
    elif 'uncertain' in verdicts_for_logic and ws_signal == "未跑":
        # LLM 不确定 + 没跑 WebSearch → 真不知道
        p_agreement = 0.3
    else:
        # 默认 — LLM 分歧或其他模糊情况
        p_agreement = 0.4

    # cutoff 警告 + 没 WebSearch → 额外降权
    if cutoff_warning and ws_signal == "未跑":
        p_agreement *= 0.5

    duration_ms = int((time.time() - t0) * 1000)

    result = {
        "p_agreement": round(p_agreement, 3),
        "llm_consensus": llm_consensus,
        "websearch_signal": ws_signal,
        "components": {
            "llm_models": llm_results,
            "websearch_results": ws_results[:3],
        },
        "post_cutoff_warning": cutoff_warning,
        "duration_ms": duration_ms,
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
