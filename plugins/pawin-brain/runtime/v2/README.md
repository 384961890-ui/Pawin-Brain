# claude-brain v2 — 诚实睡眠回路 (Honest Sleep Loop)

> 2026-05-26 凌晨开干
> 目标：解决 LLM agent introspective grounding 问题 + sleep-time memory consolidation 合体
> 学术对应：arxiv 2505.13763 (mech-interp metacog) + Letta sleep-time (arxiv 2504.13171) + A-MEM (arxiv 2502.12110)

---

## 一句话

> 让 cc 真的知道自己知道什么 — 在线时不自欺、睡觉时复盘所有记忆的可信度。

---

## 为什么不是 v1.x 的延续 — 是结构突破

| brain v1.x（v1.x 实现） | brain v2（诚实睡眠回路） |
|---|---|
| **单源**置信度（agent 自己打分） | **5 源融合**（语言+一致性+跨模型+logprobs+历史） |
| **后验**反思（错了写 lesson） | **前验**干预（说之前先核） |
| failure-guard 模式匹配 | adversarial probe 主动挑战 |
| 单 agent 自检 | 结构独立的质疑者（不同 prompt / 不同模型） |
| 经验胶囊（文字） | 校准曲线（数字 P_say → P_actual） |
| daily/weekly reflect cron | nightly memory consolidation with confidence re-evaluation |
| 反思生成 markdown | 反思**改写决策**本身 |

---

## 核心机制（图）

```
                    在线（每次回答前）
┌───────────────────────────────────────────────────────┐
│  我即将给出答案                                          │
└─────────────────────┬─────────────────────────────────┘
                      ▼
        ┌─────────────────────────────────┐
        │   5 源置信度采集                  │
        ├─────────────────────────────────┤
        │ ① 语言信号 (我口头说的%)          │
        │ ② 一致性信号 (T=0.7 跑 3 次)      │
        │    → 答案语义熵                  │
        │ ③ 跨模型信号 (Haiku + DeepSeek)   │
        │    → agreement ratio            │
        │ ④ logprobs 信号 (DeepSeek API)   │
        │    → token 概率分布              │
        │ ⑤ 历史校准 (PATTERNS.md)         │
        │    → 这类断言我历史准确率         │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │   融合 → P_true                  │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │   |P_say - P_true| 检测自欺      │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │   Adversarial Self-Probe         │
        │   独立 haiku 质疑者              │
        └────────────────┬────────────────┘
                         ▼
        ┌─────────────────────────────────┐
        │   决策：直接答/加修饰/反问/查    │
        └─────────────────────────────────┘

                    夜里（每天 03:00 cron）
┌───────────────────────────────────────────────────────┐
│  Sleep Consolidation (低成本 DeepSeek API 跑)          │
├───────────────────────────────────────────────────────┤
│  扫今天所有对话+记忆条目                                │
│  每条用诚实回路重新评估可信度                           │
│  ├─ 高可信 (P>85%) → 进 long-term memory             │
│  ├─ 中可信 (50-85%) → 标记 "uncertain"               │
│  ├─ 低可信 (P<50%) → 移到 pending-review            │
│  └─ 矛盾的 (说过 A 又说过 B) → 触发 reconciliation   │
│                                                       │
│  每周日 03:05 → 拟合 P_say → P_actual 校准曲线        │
│  → CALIBRATION.json 更新                              │
└───────────────────────────────────────────────────────┘
```

---

## 目录结构

```
~/.claude-brain/v2/
├── README.md              # 本文件 — 完整设计
├── protocol.md            # 我自己要遵守的协议 (注入到 hook)
├── scripts/
│   ├── honest-loop/       # 在线 — 5 源信号采集
│   │   ├── signal-1-verbal.js      # 语言信号 (自报)
│   │   ├── signal-2-consistency.py # 一致性信号 (语义熵)
│   │   ├── signal-3-ensemble.py    # 跨模型 agreement
│   │   ├── signal-4-logprobs.py    # DeepSeek logprobs
│   │   ├── signal-5-history.js     # 历史校准
│   │   ├── fuse.js                 # 5 源融合
│   │   ├── adversarial-probe.js    # 派 haiku 质疑者
│   │   └── decide.js               # 决策层
│   └── sleep-loop/        # 离线 — 夜里整合
│       ├── nightly-consolidate.py  # 每晚 03:00 跑
│       └── calibration-update.py   # 每周日 03:05 拟合曲线
├── data/
│   ├── calibration.json   # P_say → P_actual 映射
│   ├── pending-review.json # 待澄清的低可信记忆
│   ├── memory-graph.json  # 可信度加权记忆图
│   └── audit-log.jsonl    # 每次诚实回路触发的审计日志
└── logs/
    ├── consolidate-YYYY-MM-DD.log
    └── calibration.log
```

---

## 路线图

### Phase 1 — 骨架 + Protocol（今晚）
- [x] 目录结构
- [x] README (本文件)
- [ ] protocol.md (我的自我约束)
- [ ] 改 inject-context.js 注入 protocol
- [ ] signal-2-consistency.py 跑通 (最容易那个)
- [ ] audit-log.jsonl 初始化
- [ ] DeepSeek API logprobs 验证 ✅ 已确认可用

### Phase 2 — 5 源信号全部实现（1-3 天）
- [ ] signal-1-verbal.js (语言信号 — 让我自己打分)
- [ ] signal-2-consistency.py (语义熵 — 已 phase 1 done)
- [ ] signal-3-ensemble.py (跨模型 agreement)
- [ ] signal-4-logprobs.py (DeepSeek logprobs)
- [ ] signal-5-history.js (历史校准查询)
- [ ] fuse.js (5 源融合算法)

### Phase 3 — Adversarial Probe + 决策层（3-7 天）
- [ ] adversarial-probe.js (派 haiku 独立质疑)
- [ ] decide.js (3 档决策: 直接答 / 加修饰 / 反问/查)
- [ ] 接入 PostToolUse hook (事后审计)

### Phase 4 — Sleep Loop（1-2 周）
- [ ] nightly-consolidate.py (每晚跑)
- [ ] calibration-update.py (周拟合曲线)
- [ ] launchd cron 配置
- [ ] memory-graph.json 可信度加权写入

### Phase 5 — 闭环优化（长期）
- [ ] 校准数据反向蒸馏 (训咱家专属校准模型)
- [ ] adversarial probe → DeepSeek 升级 (haiku 不够时)
- [ ] 接入 brain v1 的 lessons / failure-guard 数据

---

## 学术支撑

| 我们的设计 | 学术来源 | 工程贡献 |
|---|---|---|
| 5 源融合 | Lin et al. verbal confidence + semantic entropy | **首次**把多源融合到 production agent |
| Adversarial probe | CoVe (Meta) + "Adversarial self-verification unexplored" | 实现学术明说但没人做的方向 |
| Sleep consolidation | Letta arxiv 2504.13171 | 加入 confidence re-evaluation 维度 |
| 校准曲线 | Uncertainty Distillation arxiv 2503.14749 | 用 production 数据而非预训练 |
| Logprobs 信号 | OpenAI/DeepSeek API | 实践：白盒不可得时的次优代替 |

---

## 不确定性披露

- 我对自己技术判断的置信度: **75%**
- 调研覆盖: 学术 2025-Q4 ~ 2026-Q1，**4 个月盲窗 (2026-02 ~ 2026-05)**
- 风险: Anthropic / OpenAI 内部可能已有更先进的实现 (但他们没 ship 出来给个人 agent 用)
- 我们的优势: 个人 agent + 低成本 DeepSeek API + 钩子基础设施

---

## 下次会话时我要做的第一件事

读 `protocol.md` 并严格遵守。这是我和用户的约定。

---
*2026-05-26 凌晨*
