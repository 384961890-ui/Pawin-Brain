#!/usr/bin/env python3
"""
nightly-consolidate.py v2 — 真实评估版

升级:
  - 从 pending-review.json 读 stop-audit 收集的事实性断言
  - 对最高风险的 N 条（默认 20）跑完整 fuse
  - 高自欺事件 (p_say - p_true > 0.3) → 写 lesson + 加入 PATTERNS 候选
  - 评估过的标 evaluated=true，避免重复

每晚 03:00 launchd 自动跑（cron 已在 v1 phase 1 配好）
"""

import json
import os
import sys
import re
import subprocess
from datetime import datetime, date, timedelta
from pathlib import Path

HOME = Path.home()
V2_DIR = HOME / '.claude-brain' / 'v2'
PENDING_REVIEW = V2_DIR / 'data/pending-review.json'
AUDIT_LOG = V2_DIR / 'data/audit-log.jsonl'
LOG_DIR = V2_DIR / 'logs'
FUSE_SCRIPT = V2_DIR / 'scripts/honest-loop/fuse.js'

# 每晚最多评估几条（17s × 20 = 5.7 分钟，可接受）
MAX_EVALS_PER_NIGHT = 20

# 自欺阈值
SELF_DECEIT_THRESHOLD = 0.3


def load_pending() -> dict:
    try:
        return json.loads(PENDING_REVIEW.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {'pending': []}


def save_pending(data: dict):
    PENDING_REVIEW.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def append_audit(entry: dict):
    with AUDIT_LOG.open('a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def call_fuse(sentence: str, p_say: float = 0.9) -> dict | None:
    """对一句断言跑完整 fuse"""
    req = json.dumps({
        'query': sentence,  # 用断言本身做"query"，让 fuse 反向核实
        'draft_answer': sentence,
        'p_say': p_say,
        'skip_adversary': False,
    })

    try:
        result = subprocess.run(
            ['node', str(FUSE_SCRIPT)],
            input=req,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None


def prioritize(items: list[dict]) -> list[dict]:
    """优先级排序: 多 PATTERN > 单 PATTERN > 最近"""
    def score(item):
        return (
            -len(item.get('patterns', [])),  # 多 pattern 优先
            -datetime.fromisoformat(item['ts'].replace('Z', '+00:00')).timestamp(),  # 新的优先
        )
    return sorted(items, key=score)


def consolidate() -> dict:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f'consolidate-{date.today().isoformat()}.log'
    log_f = log_path.open('a')

    def log(msg):
        line = f'[{datetime.now().isoformat()}] {msg}'
        print(line)
        log_f.write(line + '\n')

    log('=== nightly-consolidate v2 启动 ===')

    pending_data = load_pending()
    pending = pending_data.get('pending', [])
    unevaluated = [p for p in pending if not p.get('evaluated')]

    log(f'pending 总计 {len(pending)} 条，未评估 {len(unevaluated)} 条')

    if not unevaluated:
        log('无待评估，退出')
        log_f.close()
        return {'status': 'no_pending', 'evaluated': 0}

    # 优先级 + 抽样
    sorted_items = prioritize(unevaluated)
    to_evaluate = sorted_items[:MAX_EVALS_PER_NIGHT]
    log(f'今晚评估 {len(to_evaluate)} 条（最高风险）')

    high_self_deceit_events = []
    eval_results = []

    for i, item in enumerate(to_evaluate, 1):
        log(f'  [{i}/{len(to_evaluate)}] {item["sentence"][:60]}...')
        result = call_fuse(item['sentence'])

        if not result:
            log(f'    ❌ fuse 失败')
            continue

        gap = result.get('self_deceit_gap', 0)
        decision = result.get('decision', {}).get('decision', 'unknown')

        item['evaluated'] = True
        item['eval_ts'] = datetime.now().isoformat()
        item['p_true'] = result.get('p_true')
        item['self_deceit_gap'] = gap
        item['decision'] = decision

        eval_results.append({
            'sentence': item['sentence'][:120],
            'patterns': item.get('patterns'),
            'p_true': result.get('p_true'),
            'gap': gap,
            'decision': decision,
        })

        if gap > SELF_DECEIT_THRESHOLD:
            high_self_deceit_events.append({
                'sentence': item['sentence'],
                'p_say': result.get('p_say'),
                'p_true': result.get('p_true'),
                'gap': gap,
                'patterns': item.get('patterns'),
                'adversary': (result.get('adversary') or {}).get('verdict'),
                'session': item.get('session'),
            })
            log(f'    ⚠️ HIGH SELF-DECEIT (gap={gap}) — 自欺事件')

        log(f'    p_true={result.get("p_true")}, gap={gap}, decision={decision}')

    # 持久化更新
    save_pending(pending_data)

    # 写 audit
    audit_entry = {
        'ts': datetime.now().isoformat(),
        'event': 'nightly_consolidate_done',
        'evaluated': len(eval_results),
        'high_self_deceit_events': len(high_self_deceit_events),
        'avg_gap': sum(e['gap'] for e in eval_results) / max(len(eval_results), 1),
        'top_self_deceit': sorted(eval_results, key=lambda e: -e['gap'])[:3],
    }
    append_audit(audit_entry)

    # 高自欺事件写 lesson
    if high_self_deceit_events:
        lesson_path = LOG_DIR / f'self-deceit-{date.today().isoformat()}.md'
        with lesson_path.open('a') as f:
            f.write(f'\n## {datetime.now().strftime("%H:%M")} consolidate run\n\n')
            for ev in high_self_deceit_events:
                f.write(f'### gap={ev["gap"]:.2f}\n')
                f.write(f'**断言:** {ev["sentence"][:200]}\n\n')
                f.write(f'- p_say: {ev["p_say"]}, p_true: {ev["p_true"]}\n')
                f.write(f'- patterns: {ev["patterns"]}\n')
                f.write(f'- adversary: {ev["adversary"]}\n')
                f.write(f'- session: {ev["session"]}\n\n')
        log(f'写 lesson: {lesson_path}')

    log(f'=== 完成 — 评估 {len(eval_results)} 条，{len(high_self_deceit_events)} 个高自欺事件 ===')
    log_f.close()

    return audit_entry


def main():
    result = consolidate()
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == '__main__':
    main()
