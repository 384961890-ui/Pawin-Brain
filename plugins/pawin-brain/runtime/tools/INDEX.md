# claude-brain TOOLS INDEX — 工具入口

> 按"我现在想做什么"找工具，不是按工具名找用法。

---

## 🌐 网页 / 浏览器

| 场景 | 工具 | 关键命令 / 说明 |
|:---|:---|:---|
| 读网页内容（提取文本+元素） | 网页抓取工具 | 提取正文 + 标注交互元素 |
| 浏览器自动化（点击、填表） | mcp__chrome-mcp__ + mcp__Claude_in_Chrome__ | Chrome 扩展 + DOM-aware |
| 本地无头浏览器 | Playwright | v1.58 已装；输入被富文本编辑器拦截需配合网页抓取工具 |

---

## 🔍 搜索 / 调研

| 场景 | 工具 |
|:---|:---|
| 通用网搜 | tavily-search |
| 神经语义搜（找代码/公司/人） | exa-search |
| 深度报告含引用 | deep-research（firecrawl + exa） |
| 我的过去（语义召回） | QMD HTTP search :18765 |
| 我的当下（身份/状态） | 读 IDENTITY.md + STATE.md |

---

## 🧠 记忆 / 索引

| 场景 | 工具 / 路径 |
|:---|:---|
| 找过去对话 / 文档 | QMD :18765/search |
| 找最近教训 | ~/.claude-brain/lessons/INDEX.json |
| 找项目状态 | ~/.claude/workbench/工作缓冲区.md |
| 找今天日记 | ~/.claude/diary/YYYY-MM-DD.md |
| 找历史项目 | ~/.claude/identity/MEMORY.md |

---

## 📝 文档 / 编辑

| 场景 | 工具 |
|:---|:---|
| 读文件 | Read |
| 改文件 | Edit（替换片段）/ Write（新建或重写） |
| 跨文件搜索 | Grep |
| 文件查找 | Bash `find` / `ls` |

---

## 🤖 子任务派发

| 场景 | 工具 |
|:---|:---|
| 内容编辑/枚举类任务 | 双模型协作模式（主模型出题、副模型执行） |
| 代码探索（read-only） | Agent + subagent_type: Explore |
| 复杂多步骤任务 | Agent + subagent_type: general-purpose |

---

## 🎨 设计 / 前端

| 场景 | 技能 |
|:---|:---|
| 高保真原型 / 设计探索 | <your-design-skill> |
| 网页 PPT | guizang-ppt-skill |
| 瑞士国际主义风设计 | frontend-design (skill) |

---

## 🛡️ 安全 / 代码审查

| 场景 | 技能 |
|:---|:---|
| 通用代码审查 | code-review (skill) |
| 安全审查 | security-review (skill) |
| 终极多 agent 审查 | 深度审查命令 (用户触发) |

---

## 💬 通信 / 集成

| 场景 | 工具 |
|:---|:---|
| Discord 回复 | mcp__plugin_discord_discord__* |
| 飞书 / 钉钉 | mcp__lark-mcp__* |
| 邮件 / Slack | 通过 chief-of-staff agent |

---

## 💾 数据 / 数据库

| 场景 | 工具 |
|:---|:---|
| SQLite 查询 | Bash + sqlite3 |
| PostgreSQL | postgres-patterns (skill) |
| ClickHouse 分析 | clickhouse-io (skill) |
| 向量库 | lancedb-pro MCP（暂未深度使用） |

---

## 🌿 记忆索引巡检 (v7.2)

| 场景 | 工具 |
|:---|:---|
| 每日巡检 memory 里的孤儿 / 过期未核实 / 昨日变更 | `node ~/.claude-brain/tools/index-gardener.js` |

- 纯确定性,不调 LLM;只读工具,绝不改/删/移记忆文件
- 报告写 `state/index-gardener-last-report.md`;有发现时 append 当日日记
- 建议 launchd/cron 每天凌晨 02:40 跑一次(避开 QMD 重建窗口)
- 路径覆盖:`CLAUDE_BRAIN_DIR` `CLAUDE_DIR` `CLAUDE_MEMORY_ROOT` `CLAUDE_DIARY_DIR`

---

## 维护说明

- 用过的工具标 ✅ + 一句心得
- 没用过的工具不删（备查）
- 踩坑的工具写 ⚠️ + 原因
- 这个 INDEX 不追求全 — 追求"我真用过的命令是什么"
