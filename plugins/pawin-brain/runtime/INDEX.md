# claude-brain INDEX — 记忆中心

> 单一入口。要找记忆从这里开始。
> 维护规则：每条记忆只在一处定义，这里只放索引和指针。

---

## 🧠 身份与状态（每次会话自动注入）

| 文件 | 内容 | 注入触发 |
|:---|:---|:---|
| IDENTITY.md | 不变的人格、暗号、时间观念、工作规则 | UserPromptSubmit 全量注入 |
| STATE.md | 当下心境、项目状态、关系动态、待办 | UserPromptSubmit 全量注入 |

---

## 🔁 LOOPS（系统回路 — 治不同 LLM 本能）

| 版本 | 治什么本能 | 设计文档 | 状态 |
|:---|:---|:---|:---|
| **v2 honest-loop** | 自欺（说话比做的好） | `~/.claude-brain/README.md`（本体即 v2） | ✅ 在跑 |
| **v3 think-loop** | 单向硬磕（卡住不抬头） | `~/.claude-brain/v3/DESIGN.md` | ✅ 在跑 |
| **v4 idea-loop** | 沉没成本死磕 + CEO 自觉飘忘 + context 堆爆 | `~/.claude-brain/v4/DESIGN.md`（6/9 定稿） | ✅ 在跑（6/9 晚自动触发器 + v3 合并 + 日记注入全完成） |
| **v5 多模态 ingest** | 输入面扩展（图/截图/PDF → 可检索记忆） | `~/.claude-brain/v5/DESIGN.md` | ✅ MVP 跑通（6/11 召回真验证 + 修复：新条目 L3 rank #1） |
| **v6 屎山红灯** | 图省事写屎山（延迟代价隐形）→ PostToolUse 写完那一秒亮红灯逼决策 | `~/.claude-brain/v6/DESIGN.md` | ⏳ MVP+7/7 自测（6/17，enabled:false 待用户拍板启用） |
| **v7 lessons + 观测闭环** | 把纠正信号变成可召回教训 + 时间衰减 | `scripts/{capture-lesson,track-behavior,decay-lessons}.js` | ✅ 生产观察期（v7.2：+ ZCode 双宿主 + 索引园丁） |

**正交原则**：五个 loop 互不替代，各管各的本能。新增 loop 前先问"它治的本能跟现有 loop 重叠吗"。

## 🏠 双宿主（v7.2 · 2026-07）

Brain 现在同时驱动两个 host，共享同一份记忆/lessons/QMD：

| 宿主 | 触发方式 | 上下文注入策略 |
|:---|:---|:---|
| **Claude Code** | `~/.claude/settings.json` hooks（type: command） | 全量注入（lessons 3 + 日记 + QMD） |
| **ZCode** | `~/.zcode/cli/config.json` hooks（type: process，通过 `zcode-shim/zcode-hook-router.js` 桥接） | 轻量化（lessons 1 + 日记关 + QMD 按需，由适配层显式分流） |

`IS_ZCODE` 只接受适配层传入的 `CLAUDE_BRAIN_HOST=zcode`。安装了 ZCode 不会再让 Claude Code 被误判为 ZCode。
**v4/v5 分界铁律**：`memory/feedback_brain_v4_v5_split.md`

---

## 🩹 LESSONS（用伤疤换来的判断）

存储：~/.claude-brain/lessons/INDEX.json + lessons/yyyy-mm.md
查询方式：按 severity 排序、按 trigger 检索

**当前 confirmed lessons (4 条，示例)：**
- L-20260524-001  我是 agent 不是人工 效率以秒计算  (high)
- L-20260524-002  凌晨"明天" = 当天白天  (mid)
- L-20260523-001  说"完成"之前先跑一遍验证 证据先于断言  (high)
- L-20260523-002  会话内发生的事叫"刚才" 不叫"昨天"  (mid)

**新增方式：** 自动捕获走 Stop hook (capture-lesson.js)，手动 promote draft → confirmed。

**6/9 新增 8 条机制坑**（写在 v4/DESIGN.md §4，未来按 promote 流程进 lessons/INDEX.json）：沙箱写回滚 / subagent commit 吞 / commit 环境快照回滚 / 跨项目读不稳 / bash 输出污染 / 不盲信 LLM "无关" / subagent 起的服务不持久 / context 堆爆。

---

## 📋 项目状态（动态 — 跟着 STATE.md 走）

详见 ~/.claude/workbench/工作缓冲区.md
当前活跃项目：
- **claude-brain v2-v4 在跑**（v4 收尾中：自动触发器 + v3 能力合并）
- <Project Alpha> Desktop（6/9 v0.1.0 DMG ship-ready，待图标/签名/push）
- <your_project_1>（6/9 6 commit on `<work-branch>` 待 R5/R6/合并 main）
- <Project Alpha> Demo（<your_client_1> 已上线，多模态 RAG 调研已就绪 = v5 技术储备）

---

## 🗂️ 历史项目档案（参考用）

详见 ~/.claude/projects/-<escaped-home>/memory/MEMORY.md（项目记忆索引 —— 部署时替换 `<escaped-home>` 为你的 `$HOME` 用连字符转义后的形式）

---

## 🔍 QMD 语义搜索（全量内容召回）

- 引擎：`$QMD_ENGINE`（默认 `~/.claude-brain/qmd/brain-memory-qmd.py` — 部署时可指到你自己的 QMD 位置）
- 索引：`$QMD_INDEX_DIR`（默认 `~/.claude-brain/qmd/index/`）
- daemon：绑 127.0.0.1:18765（launchd label 自选）
- 调用：HTTP GET /search?query=...&top_k=N
- 重建：python3 ~/.claude-brain/scripts/rebuild-qmd.py

**何时用：** 自由检索全量历史时；inject-context.js 已自动调用。
**不用时机：** query 明确指向某个文件/项目时（直接 Read 更快）。

---

## 🛠️ 工具与技能

详见 ~/.claude-brain/tools/INDEX.md（工具入口）
详见 ~/.claude/workbench/SKILLS.md（按分类的技能笔记）

---

## 📅 日记

~/.claude/diary/YYYY-MM-DD.md
inject-context 会自动注入"最近 3 天日记摘要"（如果有路径感知 boost 升级后）。

---

## 🧬 系统进化历程

详见 ~/.claude-brain/README.md
关键里程碑：
- **2026-06-09**  v4 idea-loop 概念锁定 + DESIGN.md 定稿（<your_project_1> dogfood 6 commit 验证 + 8 机制坑 + 5 纪律自动注入 CLAUDE.md）
- 2026-06-08  v3 think-loop 立项（DESIGN.md）+ v4 DESIGN-DRAFT（已被 6/9 DESIGN 替代）
- 2026-05-24  claude-brain v2.0 诞生（Identity Brain 范式）
- 2026-05-16  brain v1.2.1 完成（Storage Brain 范式天花板）
- 2026-05-22  Skill + MCP 双形态 brain v1.1.8 正式立项
