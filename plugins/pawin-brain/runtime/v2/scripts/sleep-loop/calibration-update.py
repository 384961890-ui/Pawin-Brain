#!/usr/bin/env python3
"""
calibration-update.py — 每周日 03:05 跑（cron 已配 nightly，可单独加 cron 或被 nightly 主调）

核心任务:
  扫 pending-review.json 里 evaluated=true 的项 → 拟合 PATTERN 的真实"误差幅度"
  → 反向调整 PATTERNS.md 里的 calibration_factor
  → 写 calibration.json 作为 fuse 的下次校准基础

工作原理（贝叶斯思路 — 简化版）:
  每个 PATTERN 触发后，我们观察到 self_deceit_gap（p_say - p_true）
  - 高 gap = PATTERN 触发后我口头自信 >> 真实 → 校准系数应该更狠（更小）
  - 低 gap = PATTERN 触发后已经很准 → 校准系数可以放松（更大）
  - 滑动平均：旧值 0.5 权重 + 新观察值 0.5 权重

最小数据点要求: 3 条（少于 3 条不更新，避免噪声）

输出:
  - data/calibration.json — { Pattern-XXX: { factor: 0.X, sample_size: N, avg_gap: 0.X } }
  - 更新 PATTERNS.md 末尾"校准映射"段
  - audit-log 一条 calibration_update 事件
"""

import json
from datetime import datetime
from pathlib import Path
from collections import defaultdict

HOME = Path.home()
V2_DIR = HOME / '.claude-brain' / 'v2'
PENDING_REVIEW = V2_DIR / 'data/pending-review.json'
CALIBRATION_JSON = V2_DIR / 'data/calibration.json'
PATTERNS_MD = V2_DIR / 'data/PATTERNS.md'
AUDIT_LOG = V2_DIR / 'data/audit-log.jsonl'
LOG_DIR = V2_DIR / 'logs'

# 最少需要几条数据才更新一个 PATTERN
MIN_SAMPLE_SIZE = 3

# 滑动平均权重（旧值占比）
OLD_WEIGHT = 0.5


def load_pending() -> dict:
    try:
        return json.loads(PENDING_REVIEW.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {'pending': []}


def load_existing_calibration() -> dict:
    try:
        return json.loads(CALIBRATION_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_calibration(data: dict):
    CALIBRATION_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def append_audit(entry: dict):
    with AUDIT_LOG.open('a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def compute_new_factors(pending: list, existing: dict) -> dict:
    """对每个 PATTERN 计算新的 calibration_factor"""

    # 按 PATTERN 分组 — 每个 evaluated 项可能命中多个 PATTERN
    pattern_gaps = defaultdict(list)
    for item in pending:
        if not item.get('evaluated'):
            continue
        gap = item.get('self_deceit_gap')
        if gap is None:
            continue
        for pid in item.get('patterns', []):
            pattern_gaps[pid].append(gap)

    new_calib = {}

    for pid, gaps in pattern_gaps.items():
        n = len(gaps)
        if n < MIN_SAMPLE_SIZE:
            # 数据不够 — 保留旧值
            if pid in existing:
                new_calib[pid] = existing[pid]
            continue

        avg_gap = sum(gaps) / n

        # 算"建议"factor：
        # gap=0   → factor 1.0  (我说啥都对，不需要折扣)
        # gap=0.3 → factor 0.7  (我口头比真值高 30%，打 70 折)
        # gap=0.5 → factor 0.5  (我口头比真值高 50%，打 5 折)
        # gap=0.8 → factor 0.2  (我口头比真值高 80%，几乎不要信)
        suggested_factor = max(0.1, min(1.0, 1.0 - avg_gap))

        # 滑动平均（如果有旧值）
        old_factor = existing.get(pid, {}).get('factor')
        if old_factor is not None:
            new_factor = old_factor * OLD_WEIGHT + suggested_factor * (1 - OLD_WEIGHT)
        else:
            new_factor = suggested_factor

        new_calib[pid] = {
            'factor': round(new_factor, 3),
            'sample_size': n,
            'avg_gap': round(avg_gap, 3),
            'last_updated': datetime.now().isoformat(),
            'previous_factor': old_factor,
        }

    # 保留旧版本里有但本周没数据的 PATTERN
    for pid, val in existing.items():
        if pid not in new_calib:
            new_calib[pid] = val

    return new_calib


def update_patterns_md(new_calib: dict):
    """更新 PATTERNS.md 末尾的'校准映射'代码块"""
    try:
        text = PATTERNS_MD.read_text()
    except FileNotFoundError:
        return False

    # 构造新的校准映射块
    lines = ['## 校准映射（signal-5 用）', '']
    lines.append('> 由 calibration-update.py 周更新 — 不要手动改 factor，会被覆盖。')
    lines.append('')
    lines.append('```')
    lines.append('触发的 Pattern → P_true 修正系数')

    for pid in sorted(new_calib.keys()):
        c = new_calib[pid]
        if isinstance(c, dict):
            factor = c.get('factor', 1.0)
            n = c.get('sample_size', 0)
            avg_gap = c.get('avg_gap', 0)
            lines.append(f'{pid}    → P_true *= {factor}  (基于 {n} 条数据, 平均 gap={avg_gap})')
        else:
            # 旧格式 — 直接是数字
            lines.append(f'{pid}    → P_true *= {c}')

    lines.append('```')
    lines.append('')
    lines.append(f'最后更新: {datetime.now().isoformat()}')
    lines.append('')

    new_section = '\n'.join(lines)

    # 替换原有"校准映射"段（从"## 校准映射"到下一个"## "或文件结尾）
    import re
    pattern = re.compile(r'## 校准映射.*?(?=^## |\Z)', re.DOTALL | re.MULTILINE)

    if pattern.search(text):
        new_text = pattern.sub(new_section, text)
    else:
        # 没找到段 — 追加到末尾
        new_text = text.rstrip() + '\n\n---\n\n' + new_section

    PATTERNS_MD.write_text(new_text)
    return True


def main():
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f'calibration-{datetime.now().date().isoformat()}.log'

    with log_path.open('a') as log_f:
        def log(msg):
            line = f'[{datetime.now().isoformat()}] {msg}'
            print(line)
            log_f.write(line + '\n')

        log('=== calibration-update 启动 ===')

        pending_data = load_pending()
        pending = pending_data.get('pending', [])
        evaluated = [p for p in pending if p.get('evaluated')]

        log(f'pending 总计 {len(pending)} 条，已评估 {len(evaluated)} 条')

        if not evaluated:
            log('无已评估数据 — 退出')
            return {'status': 'no_data'}

        existing = load_existing_calibration()
        new_calib = compute_new_factors(evaluated, existing)

        log(f'计算出 {len(new_calib)} 个 PATTERN 校准:')
        for pid, c in new_calib.items():
            if isinstance(c, dict):
                old = c.get('previous_factor')
                old_str = f' (was {old})' if old is not None else ' (新)'
                log(f'  {pid}: factor={c["factor"]}{old_str}, n={c["sample_size"]}, gap={c["avg_gap"]}')

        save_calibration(new_calib)
        log(f'已写 {CALIBRATION_JSON}')

        if update_patterns_md(new_calib):
            log('已更新 PATTERNS.md 校准段')

        append_audit({
            'ts': datetime.now().isoformat(),
            'event': 'calibration_update',
            'patterns_updated': list(new_calib.keys()),
            'sample_sizes': {pid: c.get('sample_size', 0) for pid, c in new_calib.items() if isinstance(c, dict)},
        })

        log('=== 完成 ===')

        return {
            'status': 'ok',
            'patterns_updated': len(new_calib),
            'evaluated_count': len(evaluated),
        }


if __name__ == '__main__':
    result = main()
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
