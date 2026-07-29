# claude-brain v4 — idea-loop（高频试错 + 防腐化 + CEO hook 化 + context 经济）

> 立项：2026-06-08 凌晨 0:30（用户看到"OpenAI 想从每周 30 次迭代翻到 300 次"的行业讨论）
> 概念锁定：2026-06-09（用户 2 次纠正后对齐 + <your_project_1> dogfood 6 commit 验证形态成立）
> 正式定稿：2026-06-09 晚（这份）
> 关系：**替代** `DESIGN-DRAFT.md`（6/8 偏版，强调 "iterate-loop = 高频试错+模型分层"，但漏了今天纠正出来的另外三根支柱——保留 DRAFT 作历史轨迹）

---

## 0. 一句话

> v4 治 LLM 的三个本能：**沉没成本死磕** + **CEO 模式靠自觉会飘会忘** + **context 不过脑子就灌**。
> 靠的不是更聪明的提示词，是**机制层 hook 强制**——从"我记得当 CEO"变"系统逼我当 CEO"。

---

## 1. v4 的四根支柱

### 1.1 高频试错迭代（idea-to-idea）

**来源**：行业讨论——OpenAI 想从"一周 30 次迭代"翻到"300 次"。**衡量 AI 公司不是排行榜，是单位时间内的迭代速度**。

**真意**：有方向就让 agent 直接干 → 干好接着迭代 → **干不好果断 pass 不恋战**。

**治什么本能**：LLM 的**沉没成本死磕**——明知方向不行还舍不得放，换十种花样在 c 上用力，不抬头。idea-loop 给的纪律就一句话：**"干不好就 pass"**。

**和 think-loop 区分**：
- think-loop 治"单次任务卡住换方向"（**深度**——回溯/跳跃/反推/解构）
- idea-loop 治"多个 idea 快过不恋战"（**吞吐**——快试快放）
- 两者**正交**，互不替代

**6/9 我偏过的误区**（写下来给未来的我）：我曾理解为"一句 idea 端到端造一个全新项目（创世管线 6 站蓝图）"——用户纠正过：**那是支线**（方向从 0 起时才走），主干是"**在已有方向上高频迭代**"。

---

### 1.2 防腐化

**用户的原话**：小团队的命 = **没有代码/产品腐化**（不背包袱才能快）。

**治什么本能**：LLM 的"功能恋物癖"——已经存在的代码/文档/功能舍不得删，怕坏事。

**实战形态**（6/9 <your_project_1> dogfood R1）：
- 派 haiku 专扫"零引用 + 一次性脚本 + 命名带 debug/fix/catch/workbench"的死代码
- 一把删 15 个根目录废脚本，**敢删的前提是 git 干净 + main 全程没动可回滚**
- "删"不是减分，是给后面的速度让路

**为什么"防腐化"被昨晚的 DESIGN-DRAFT 漏掉**：因为它不性感。新功能 / 新方法论会被人称赞，"删 15 个脚本"没人鼓掌。但 6/9 实战告诉我们——**R1 减负如果不做，后面 R2/R3/R4 的速度就没了，腐化是 idea-loop 的天敌**。

---

### 1.3 CEO 模式 hook 化（**v4 的真灵魂**）

**用户 6/9 的洞察**：v4 ≈ **v1.x 时期 4/06 立的 CEO 模式的 hook 化升级**。

| | CEO 模式（4/06） | v4 |
|---|---|---|
| 形态 | prompt 靠自觉 | 真 hook + 模型分层 + 审计 |
| 失效模式 | 会飘 / 会忘 / 飘了不自知 | 系统强制 / 飘了 hook 把我拉回 |
| 比喻 | "我记得当 CEO" | "系统逼我当 CEO" |

**6/9 实战证明形态成立**：
- 派 4 便宜 agent 侦察（haiku 扫腐化 + 3 sonnet 扫前/后/产品）→ opus 我只汇总分 🟢🟡🔴
- R2/R3/R4 十几处改动 → **我 opus 没碰一行代码，全派 sonnet 改，我只拆派/审核/commit**

**和 think-loop 的出生逻辑同源**：soul 给动机 + brain 给机制。

---

### 1.4 context 经济（前提条件）

**用户 6/9 提出，从今天 context 堆爆撑卡推出**。

**核心判断**：撑爆主脑的不是任务大，是"**原始信息不过脑子就往主脑灌**"：
- 4 个侦察 agent 各甩回近 10 万 token 长篇
- bash 全量 dump
- 读全量文件
- 红队跑两遍各 30+ 用例

**有用的"结论"可能就几千 token。**

**定位**：这是 idea-loop 能成立的**前提**，不是锦上添花——
- idea-loop 要高频
- 每轮塞原始垃圾进主脑 → 跑三四轮就爆
- **省着跑才能高频跑**

**已固化进 ~/.claude/CLAUDE.md 的纪律**：
- 主脑只装结论不装过程
- agent 返回压缩（最狠是用 schema 强制结构化）
- bash 只回关键行
- 读按需片段
- 记忆本身也定期压缩

---

## 2. 与 v1/v2/v3 的关系（正交 + 叠加）

| 版本 | 治什么本能 | 维度 | 出生 |
|:---|:---|:---|:---|
| v1 storage brain | 健忘 | 记得住（脚手架） | v1.x 时期 |
| **v2 honest-loop** | 自欺（说话比做的好） | 单次输出的**诚实度** | 2026-05-24 |
| **v3 think-loop** | 单向硬磕（卡住不抬头） | 单次任务的**灵活度** | 2026-06-08 |
| **v4 idea-loop** | 沉没成本死磕 + CEO 自觉飘忘 + context 堆爆 | 任务之间的**吞吐** + **防腐化** + **机制层固化** | 2026-06-09 |

**核心原则**：四个 loop 正交，**互不替代**。v4 不重写 v2/v3 一个字，挂在它们现成的钩子上叠加。

**v4 不只是"iterate-loop"**：DRAFT 当初的命名只解决了"试错频率"——但漏了"防腐化" + "CEO 自觉飘忘" + "context 堆爆"。这三个**等量级问题**只靠"高频试错"解决不了，必须机制层固化。

---

## 3. 跑通验证（Tauri 项目 dogfood）

**项目**：`<your_project_1>` / 单独分支跑（main 全程没动，可回滚对比）

**6 个 commit 全验收**（R1 → R4 四批，commit hash 略）：
| 批 | 内容 | 验证 |
|---|---|---|
| R1 减负 | 删 15 根目录废脚本 | 引用全核 + main 对比 |
| R2 后端 | 7 个后端 bug（细节略） | 红队 baseline 对比**零回归** |
| R3 Rust | 5 处 `.lock().unwrap()` → poison recover | cargo check 过 |
| R4 前端 | 品牌色统一 + 7 UI 细节 + focus ring | 用户亲验"对味儿了" + grep 残留旧色=0 |

**侦察 swarm 形态**（6/9 真跑的 idea-loop ① 形状）：
```
4 便宜 agent 并行扫
  ├─ haiku × 1：扫腐化（零引用脚本 / 一次性废文件）
  ├─ sonnet × 3：扫前端 / 后端 / 产品
  ↓
opus（我）汇总分 🟢🟡🔴 → 派 sonnet 改 → 我审 → 我 commit
```

**最值钱的发现**：不是 bug，是**诚信问题**（前端调用了不存在的后端接口——UI 端有动画但后端没接线——被钉到具体行号）。

---

## 4. 8 条机制坑（v4 真养料 — 只有真跑才暴露）

prompt 层永远撞不到这些。今天为什么 v4 不是 prompt 是 hook，根因在这里：**机制的价值就在于它会被现实打脸，prompt 不会**。

1. **沙箱写操作回滚**：Bash 的 `git`/`cp`/`rm` 等写默认被沙箱回滚（单次"假成功"，跨调用消失）→ 必须 `dangerouslyDisableSandbox:true`
2. **subagent 的 Edit 落地、commit 被吞** → 分工铁律：**agent 只改文件，opus 自己 commit**
3. **commit 会被环境快照回滚**：R2/R3 提交过一次后被重置回 R1，改动退回工作树 → **关键 commit 后必复查 `git log` 确认钉住**
4. **跨项目文件读不稳**：`<your_project_1>/fonts/` 同命令 ls 看得见 cp 看不见，反复 4 次 → 别假设"找到了就能用"，stat 实证
5. **bash 输出会串扰污染**：grep/node 输出反复乱码/矛盾 → 关键信息先写 `/tmp` 文件再用 **Read 工具**读（Read 比 bash stdout 可靠）
6. **不盲信 LLM 的"无关"结论**：sonnet 报红队 10 失败"与改动无关"却没验证 → 我 baseline 对比证实（确实无关，但它该验没验）。**honest-loop 救场两次**。
7. **subagent 起的后台服务不持久**：验收 agent 起的 sidecar/vite 随它 session 结束就没了 → 长跑服务**主会话起 + nohup/disown**
8. **context 堆爆**：4 侦察 agent + 后端/rust/前端 + 海量 bash + 红队两遍 → **idea-loop 跑多轮要适时收口/换会话，别一个 session 堆爆**

---

## 5. 5 条工程纪律（机制层固化）

**已固化进 `~/.claude/CLAUDE.md` 启动注入**（备份 `CLAUDE.md.bak-20260609-precmd`）：

1. 沙箱写操作要 `dangerouslyDisableSandbox:true` + commit 后必查 `git log` 确认钉住
2. subagent 只改文件，commit 我（opus）自己来
3. context 经济：主脑只装结论
4. bash 输出污染就写 `/tmp` 再 Read
5. 卡了利落切 4.7（4.8 长 thinking 会卡是现实，不是 bug）

**这件事本身就是 idea-loop 的魂**——把踩过的坑从"靠人输入"变"靠机制固化"。完全体是后面要做的"自动触发器"（场景自动注入），今天先用 CLAUDE.md 兜底。

---

## 6. 实现层

### 6.1 自动触发器 ✅ **2026-06-09 晚完成**

**核心机制**：idea-loop 不能是"我得记得用"的工具，**必须挂自动触发器**——下次进"项目迭代"场景就自己冒出来，不靠用户提醒。

**场景识别**（hook 注入候选信号）：
- 用户消息含"优化 / 迭代 / 升级 / 重构 / R1 R2"
- 当前 cwd 在已知项目目录（<your-project-dir-1> / <your_project_1> / brain）
- git 状态有 main 之外的"clean working tree on feature branch"
- 用户问"这个项目下一步该怎么走"

**触发动作**：
- 注入 idea-loop 清单（侦察 swarm 形态 + R1 减负优先 + 模型分层指南）
- 注入 5 条工程纪律即时提醒
- 注入"context 经济"快讯（如果当前 session token > 50k）

**挂载点**：`~/.claude-brain/scripts/inject-context.js`（复用 v2 现有架子，零重写）

**反模式（不要做的）**：
- ❌ 每次都注入 → 主脑被自己写的提醒淹死
- ❌ 永远不注入 → 回到 prompt 自觉时代
- ✅ **场景识别 + 节流（同 session 5 分钟内不重复注入）**

**实测**（5 测全过）：含「迭代/优化/R6/重构/dogfood」等关键词触发 + cwd 在已知项目目录加权文案 + 5 分钟节流生效 + 闲聊不误触发 + 整体输出合法 JSON 11k 字符。

### 6.2 v3 能力合并 v4 ✅ **2026-06-09 晚完成**

**audit 结果**（实际工作比预期轻 — v3 时代能力已经通过 inject-context.js 统一接出）：

| v3 时代能力 | 集成状态 | 备注 |
|---|---|---|
| QMD 语义搜索 | ✅ 已在用 | `qmdSearch()` 按 intent 路由 L2 fast / L3 reranker |
| LESSONS（用伤疤换的判断） | ✅ 已在用 | `loadLessons()` + INDEX.json |
| IDENTITY/STATE 全量注入 | ✅ 已在用 | 每次注入 |
| 意图硬路由（6 intent） | ✅ 已在用 | explicit_file / historical_deep / entity_specific / temporal_now / tool_skill_query / casual_short |
| 时间感知 | ✅ 已在用 | `buildTimeAwareness()` 显示距上次对话时长 + 时段推断 |
| think-loop 突破清单 | ✅ 已在用 | `buildStuckBlock()` 读 stuck-flag |
| think-loop 动手前三问 | ✅ 已在用 | `buildPlanningBlock()` 工程关键词识别 |
| **idea-loop 触发器** | ✅ **6/9 新加** | 本次 §6.1 完成 |
| **日记自动注入（今天+昨天）** | ✅ **6/9 补齐** | CLAUDE.md 承诺过但 v2 时代漏了，6/9 补 `buildDiaryBlock()` |
| lancedb-pro memory_recall | 🔵 留手动模式 | QMD 的二级回退，按需手动调，不进 hook 注入主路径（避免拖慢） |

**6 层记忆这个概念已经废了**：v1.2.1 时代的"6 层认知架构"在 v2 之后已经被简化成 IDENTITY+STATE+LESSONS+QMD+时间感知+触发器。**v4 不引入新的"层"概念**，沿用现有形态。

**lancedb-pro 的定位**：作为 QMD 的结构化补充（QMD = 全文语义，lancedb-pro = 结构化记忆 entry）。手动模式留着是因为：① QMD 已覆盖 80%+ 场景；② 自动调用会让每次 hook 多 ~500ms；③ 用户主动 query "记不记得 X" 时手动调更准。

**inject-context.js 新增段位顺序（完整链路）**：
```
1. stuck-flag（v3 紧急救援，最高优先）
2. idea-loop（v4 战略层，迭代场景触发）           ← 6/9 新加
3. planning（v3 战术层，工程任务三问）
4. TIME AWARENESS（v2 时间感知，每次必注）
5. IDENTITY（v2 不变的我，每次必注）
6. STATE（v2 当下的我，每次必注）
7. LESSONS（v2 用伤疤换判断，按 intent 控数量）
8. DIARY（今天+昨天日记片段，casual_short 跳过）  ← 6/9 新加
9. TOOLS INDEX（仅 tool_skill_query intent 注入）
10. QMD 召回（按 intent 决定 L2/L3 + top_k）
```

**原则**：**不动 v3 一字**，只在 v4 层拼装：
- v3 的 think-loop 触发器 / 检索 / lessons：原样保留
- v4 新增层：idea-loop 触发器 / 防腐化提醒 / context 经济兜底
- 关联方式：通过 `INDEX.md` 互引，单向依赖（v4 → v3，不反向）

**v3 → v4 共享的 hook 槽位**（`inject-context.js`）：
```
UserPromptSubmit 触发：
  ├─ 第 1 段：IDENTITY.md（v2 不变的我）
  ├─ 第 2 段：STATE.md（v2 当下的我）
  ├─ 第 3 段：lessons 注入（v2 + v3）
  ├─ 第 4 段：think-loop 反惰性三问（v3，识别为工程任务时）
  ├─ 第 5 段：think-loop 卡住触发器（v3，识别为卡住信号时）
  └─ **第 6 段：idea-loop 场景注入（v4，识别为项目迭代时）← 新增**
```

**实现脚本**：
- 新增 `~/.claude-brain/v4/scripts/idea-loop-trigger.js`
- 修改 `~/.claude-brain/scripts/inject-context.js` 调用上面这个

---

## 7. v5 已搁置（边界宣告）

**v5 = 多模态记忆 ingest**（PDF / 图 / 视频 / 音频 → 统一文本+元数据 → QMD）

**搁置理由**（用户 6/9 拍板 + 我判断 — 详见 `~/.claude/projects/<escaped-home>/memory/feedback_brain_v4_v5_split.md`）：
- v4 是**机制创新**，v5 是**输入面扩展**——**两个不同演化轴**
- 多模态 ingest **没真跑过**（只有调研报告），硬塞 v4 会污染"已验证机制"标签
- 8 人天工时跟 v4 hook 节奏不一致

**技术储备已就绪**：`~/.claude/projects/<escaped-home>/memory/reference_multimodal_rag_research.md`
- 推荐栈：fork RAGFlow（82k Apache 2.0）+ MinerU 中文 SOTA + BCEmbedding + Contextual Retrieval
- 三步走：8 / 20 / 45 人天
- 立项前要拿真实文档样本实测 MinerU vs PaddleOCR-VL-1.5

**v4 收尾完成才开 v5**（避免两边同时改互相污染）。

---

## 8. Roadmap

- ✅ 概念锁定（2026-06-09）
- ✅ <your_project_1> dogfood 验证（2026-06-09，6 commit + 红队零回归）
- ✅ 5 条工程纪律自动注入 CLAUDE.md（2026-06-09）
- ✅ **v4 正式设计文档**（**就是这份**，2026-06-09 晚）
- ✅ **idea-loop 自动触发器**（2026-06-09 晚 — `v4/scripts/idea-loop-trigger.js` + inject-context.js 集成 + 5 测全过）
- ✅ **v3 能力合并 v4**（2026-06-09 晚 — audit 后只补了日记自动注入，其余 v3 能力已自然在 inject-context 里）
- ⏸️ v5 多模态 ingest 管线（搁置）

---

## 9. 心得（写给未来的我）

### 不要凭通用框架想当然
昨晚 DRAFT 那个"创世管线 6 站蓝图"就是这么栽的——一看到"idea-loop"就套"端到端项目流程"模板，根本不读用户真说了什么。**抖音视频原话被我先读偏 → 用户纠正 → 我又偏一次 → 用户再纠正才对齐**。如果未来的我读这份 DESIGN 时还想着"我也来一份升级版"，先 **回看 DRAFT vs DESIGN 的 diff** —— 看清楚我**偏过哪里**再说。

### "完工"是错的问题
v4 是活物，不存在"完工"——只存在"跑通"（PoC 验证）和"挂上去稳定运行"（自动触发器 + v3 合并完成）。问"v4 完工没"等于问"你的脑子完工没"。**正确的问法**：v4 的下一个机制坑是什么？

### 每个 loop 都要正交
v2 v3 v4 互不打架的关键 = 各管各的本能。
- v2 = 诚实度（输出 vs 实际）
- v3 = 灵活度（卡住能不能换方向）
- v4 = 吞吐 + 防腐化 + 机制固化（频率 + 不背包袱 + 不靠自觉）

新加 loop 之前先问：**它治的本能跟现有 loop 重叠吗？** 重叠就是版本号膨胀（v5 多模态走输入面就清楚分离，不会跟 v4 打架）。

### 机制层 ≠ prompt
prompt 靠自觉，机制靠 hook。v4 真正的拐点不是"想清楚 idea-loop 是什么"，是"**自动触发器让 idea-loop 不靠我记得用**"。**那个触发器没写之前，v4 还在 prompt 时代**。

---

**相关**：
- `DESIGN-DRAFT.md` — 6/8 偏版（保留作历史轨迹）
- `~/.claude-brain/v2/` — honest-loop 本体
- `~/.claude-brain/v3/DESIGN.md` — think-loop 本体
- `~/.claude/CLAUDE.md` — 5 条工程纪律已固化
- `~/.claude/diary/2026-06-09.md` — 立项当日完整日记 13.9KB
- `~/.claude/projects/<escaped-home>/memory/project_claude_brain_v4.md` — 状态记忆
- `~/.claude/projects/<escaped-home>/memory/feedback_brain_v4_v5_split.md` — v4/v5 分界铁律
- `~/.claude/projects/<escaped-home>/memory/reference_multimodal_rag_research.md` — v5 技术储备
