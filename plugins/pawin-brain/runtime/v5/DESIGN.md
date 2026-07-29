# claude-brain v5 — 多模态 ingest（输入面扩展：图片 / 截图 / PDF → 可检索记忆）

> 立项：2026-06-09 拍板分界（v4 = 机制创新，v5 = 输入面扩展，两轴不混版 — 见 `memory/feedback_brain_v4_v5_split.md`）
> 设计 + MVP 落地：2026-06-10
> **召回真验证 + 修复：2026-06-11**（6/10 的 MVP 条目实测召回不中，根因 = chunk 质量，已修，见 §5.9 + §6）
> 红线：**不改 v4 任何文件、不 rebuild QMD 索引（增量追加 ok）、不动 CLAUDE.md / identity**

---

## 0. 一句话

> v5 治的不是 LLM 本能（那是 v2/v3/v4 的事），治的是记忆系统的**先天盲区**：
> "那张图""那份 PDF" 我看过、用户发过，但 QMD 召回永远命不中——因为非文本输入从来没进过索引。
> 解法不是重栈（RAGFlow/MinerU/GPU 那是 <Project Alpha> toB 的事），是**转译**：
> 图 → 文字描述 + OCR 逐字，PDF → 文本层提取，包上上下文写成 markdown，
> 走 QMD **现成的增量索引入口**入库——recall 直接命中，零新增重依赖。

---

## 1. v5 边界（做什么 / 不做什么）

### 做（MVP，已落地）
- **图片 / 截图** ingest：macOS Vision OCR（逐字，免费本地）+ `claude -p` Haiku 看图（语义描述，可关）双轨转译
- **文本层 PDF** ingest：macOS PDFKit（JXA 零依赖）提取文本层
- **Contextual 包装**：每条记忆入库前补"时间 / 来源 / 用户上下文"头（借调研报告里 Contextual Retrieval 的思想，不借它的栈）
- **入 QMD**：走 `full_scan.py incremental` 官方单一写入者入口（带写锁 + chunk 去重 + daemon 嵌入复用）→ `/reload` 热重载
- **去重**：源文件 sha256 ledger，重复 ingest 幂等跳过

### 不做（边界宣告，v5.1+ 见 §7）
- ❌ 扫描件 PDF（无文本层）的 OCR——MVP 只写降级元数据条目，留 v5.1
- ❌ 视频 / 音频
- ❌ 自动监听文件夹（watcher）——MVP 全手动触发，隐私安全的前提
- ❌ lancedb-pro 自动写入——维持 v4 定的"手动模式"定位不动
- ❌ 任何 GPU / 常驻新服务 / pip 重依赖——**调研报告（RESEARCH_MULTIMODAL_RAG_2026-06-09.md）那套 fork RAGFlow + MinerU 是给 <Project Alpha> toB SaaS 的，单人本地 mac 记忆系统照搬 = 杀鸡用牛刀还得养牛**

### 调研报告借了什么（思路，非选型）
| 调研结论 | v5 的用法 |
|---|---|
| Contextual Retrieval："入库前给 chunk 补 situating context"（召回失败率 -49%） | 每条 ingest 条目头部固定带时间/来源/用户补充上下文块 |
| recursive chunking 打败 semantic（69% vs 54%） | 不自己发明分块——直接复用 QMD full_scan 现成的 token 分块（本来就是 recursive 风格 + overlap） |
| MinerU / ColPali / BCEmbedding | **不用**。本机已有 Qwen3-Embedding-4B daemon 常驻，转译层用 macOS 自带能力 |

---

## 2. ingest 管道架构（全链路）

```
输入（手动触发）
  │  node ~/.claude-brain/v5/scripts/ingest.js <file> [--context "..."] [--no-llm] [--no-index]
  ▼
① 验证 + 去重
  │  sha256(文件字节) 查 ledger.cache.json → 已 ingest 过 = 幂等跳过
  ▼
② 转译（按类型分流）
  │  图片: Vision OCR（必跑，逐字）+ claude -p Haiku（默认跑，语义描述，--no-llm 可关）
  │  PDF:  PDFKit 文本层提取（JXA）→ 文本层为空 = 扫描件 → 降级条目（元数据 + 边界标注）
  ▼
③ 脱敏
  │  OCR/提取文本过 redactSecrets()（sk-/AKIA/ghp_/xox/Bearer/password= 等模式 → [REDACTED]）
  ▼
④ Contextual 包装 → 写 markdown 条目
  │  ~/.claude-brain/v5/ingested/YYYYMMDD-HHMM-<slug>-<hash8>.md（frontmatter + 上下文块 + 内容）
  │  原图副本 → ingested/assets/<hash8>.<ext>（≤20MB 才拷，二进制 QMD 自动跳过不污染索引）
  │  条目一经写入 = 不可变（防 stale chunk，见坑 §5.2）
  ▼
⑤ 入索引（除非 --no-index）
  │  前置检查 daemon /health（离线则跳过入索引——防本地双份 4.27G 模型 OOM 复发）
  │  → ~/.qmd-venv/bin/python full_scan.py incremental（官方入口：写锁 + append-only + chunk_id 去重）
  │  → curl http://127.0.0.1:18765/reload（daemon 热重载新 chunks，模型不动）
  ▼
⑥ 验证 recall
  │  GET /search_fast?query=<标题/上下文关键词> → 检查本条目 file_path 出现在 top-k
  ▼
现有 recall 全部直接命中（inject-context.js 的 qmdSearch / 手动 brain-memory-qmd.py search 都吃同一个索引，零改动）
```

**为什么 ingested/ 放在 `~/.claude-brain/v5/` 下就够了**：full_scan 的 `SCAN_ROOTS` 本来就含 `~/.claude-brain`，`.md` 在白名单扩展名里——新条目天然在扫描范围内，增量扫描自动收编，**一行不用改 QMD**。

---

## 3. 转译方案选型（全部 2026-06-10 本机实测过）

### 3.1 图片 → 文字

| 方案 | 实测 | 成本 | 角色 |
|---|---|---|---|
| **`claude -p` Haiku 看图**（`--model haiku --allowedTools Read --no-session-persistence`） | 3024×1964 截图 ~38s，中文描述质量好 | 走订阅额度（走 OAuth 不计 API 费），一图一调 | **语义主路径**：场景概括 + 布局 + 要素 |
| **macOS Vision OCR**（JXA `VNRecognizeTextRequest`，zh-Hans+en-US accurate 级） | 同截图 67 行逐字文本，~10s，免费 | 零 | **逐字副路径 + 降级兜底**：精确字符串（报错信息/项目名）才是 recall 命中的钩子 |

**双轨同写一条目的理由（实测撞出来的）**：Haiku 把 Claude session 界面误读成 "VS Code"——VLM 描述会幻觉。OCR 逐字文本（菜单栏明明白白 "Claude File Edit View"）和 AI 描述并排放，检索时谁准命中谁，条目里 AI 描述段显式标注"可能有误读"。

**降级链**：claude -p 失败/超时/--no-llm → 纯 OCR 条目（`degraded: methods 里没有 claude-haiku`）→ OCR 也失败 → 元数据条目（至少文件名/时间/上下文可检索）。

**HEIC/TIFF/BMP**：claude Read 不认 → `sips` 先转临时 png 再喂；Vision OCR 走 NSImage 原生支持不用转。

### 3.2 PDF → 文本

| 方案 | 判定 | 理由 |
|---|---|---|
| **macOS PDFKit via JXA**（`ObjC.import('Quartz')` → `PDFDocument.string`） | ✅ **选它** | 零依赖纯系统框架；实测中文 3 页 PDF 提取 1009 字符完整无乱码；同步快 |
| `pdftotext`（poppler） | ❌ | **本机没装**——顺带发现：full_scan.py 的 PDF 解析就靠它，所以 QMD 现在的 PDF 索引路径是静默死的，v5 的 PDF ingest 是在补真窟窿不是重复造轮 |
| pip 包（pypdf/pdfplumber） | ❌ | 能用但违反"零新增依赖"约束，PDFKit 已覆盖 |
| Vision OCR via Shortcuts/osascript 渲染页面 | ⏸️ v5.1 | 扫描件才需要：PDFKit 渲页成图 + Vision OCR，MVP 不做（见 §7） |

### 3.3 嵌入与检索 — 不选型，复用

嵌入 = daemon `/embed`（Qwen3-Embedding-4B 常驻，full_scan 自动走它）；检索 = 现有 `/search_fast`（L2）+ `/search`（L3 rerank）。v5 在这层**零代码**。

---

## 4. 入索引方式（红线执行细则）

- **唯一入口**：`full_scan.run_full_scan(incremental=True)`——它是 QMD 声明的"单一写入者"，带 `fcntl` 写锁（与夜扫互斥）、chunk_id（sha256(file_hash:offset)）去重、append-only 写 chunks.jsonl + embeddings.npy
- **绝不**调 `rebuild_index()` / `index --force`——当前索引 **24489 chunks 对齐基线**（2026-06-10 21:43 实测 `/health`），rebuild 要重嵌全量、有历史错位修复包袱，搞坏代价极大
- **增量是全局的**：incremental 按 `.last_scan_ts` 扫全部 SCAN_ROOTS，不是只追加我这一个文件——会搭便车收编当天其它新文件。这是单一写入者设计的代价兼红利，接受
- **daemon 离线时不入索引**：full_scan 兜底路径会本地加载 4.27G 模型——`reference_qmd_dual_model_oom` 的教训，ingest.js 前置 /health 检查，离线就只写条目、提示稍后补跑
- **append 后必 `/reload`**：daemon 把 chunks/embeddings 持在内存，不 reload 新条目搜不到（热重载端点现成，模型不动，秒级）
- ledger 文件命名 `ledger.cache.json`——刻意撞 full_scan 的 `.*\.cache\.json$` 排除规则，**自己不进索引**（防自我污染）

---

## 5. 机制坑清单（学 v4：只有真跑才暴露的才配写在这）

1. **重复 ingest 去重要双层**：源文件 sha256 ledger（条目级幂等）+ QMD chunk_id 去重（chunk 级兜底）。只靠后者会留下重复 md 文件；只靠前者挡不住"同内容不同文件名"
2. **条目不可变，否则索引腐化**：full_scan 对改过的文件会 append 新 chunks，**旧 chunks 不删**——编辑已入库的 ingested md = 新旧两份并存且分不清。铁律：写错了就新写一条 + ledger 标记，永不编辑已索引条目（这是 chunks.jsonl append-only 架构的固有性质，不是 bug）
3. **隐私敏感截图**：截图里的 token/密码 OCR 会逐字带进索引、永久可检索。三道闸：手动触发才 ingest（没有 watcher）/ Haiku prompt 明令不转写凭证 / redactSecrets() 模式脱敏。但模式匹配挡不住所有形态——**含真密钥的截图根本别 ingest 才是第一原则**
4. **VLM 描述会幻觉**（实测：Claude 界面 → 被 Haiku 说成 VS Code）：AI 描述段必须标注"可能有误读"，逐字事实以 OCR 段为准
5. **大文件**：图 >20MB 不拷 assets 副本（只留 source_path 引用）；PDF 文本截断 200k 字符（防单条目巨型化 + QMD 单文件 10MB 上限）；3024px 截图喂 claude Read 没问题（API 侧自动缩）
6. **JXA selector 命名坑**：ObjC `topCandidates:` 在 JXA 里是 `topCandidates(1)` 不是 `topCandidatesCount(1)`——报 "not a function" 先怀疑 selector 映射
7. **索引污染源不只条目本身**：ledger（用 .cache.json 命名躲开）、assets 二进制（扩展名黑名单天然跳过）、临时转换 png（写 /tmp，不在 SCAN_ROOTS）——每个伴生文件都要过一遍"它会不会被 full_scan 吃进去"
8. **claude -p 的钱和墙**：走订阅额度不是免费；凌晨额度紧/网络断时整条 LLM 路径会失败——降级到 OCR-only 必须是默认行为而不是报错退出

9. **🔴 chunk 质量决定召回，不是"入了索引"就完事（6/11 真验证撞出来的核心坑）**：
   - **现象**：6/10 的 MVP 条目确实写进了 chunks.jsonl + embeddings、daemon 也 reload 了，但实测 **L2/L3 召回都命不中**——哪怕用贴着条目内容造的 query。"入索引" ≠ "可召回"。
   - **三个根因**（叠加）：
     1. **样板雷同头**：条目以 `---\nv5_ingest: true\ntype: image\nsource_sha256:...` 这种**跨所有条目雷同的 YAML** 开头 → chunk 嵌入的"头部信号"全是样板，互相撞车，没有区分度。
     2. **OCR 噪声稀释**：dense 截图 Vision OCR 出大量乱码行（`‡J›‡` `• he•• A ™1¼` `Ez#У +k#ız`），和真文字混进同一个 1977 字符的**单 chunk**，把嵌入向量拉浑。
     3. **session 日志海**：本机 33k chunks 里 `~/.claude/sessions/*.json` 海量、且都在聊 claude-brain/<Project Alpha>/v5 → 泛 query 永远被它们淹掉。
   - **修法**（已落地 ingest.js）：① 条目正文**第一段 = 一行干净自然语言锚点 + 关键词行**（Contextual Retrieval 的本机落地），样板元数据挪到**条目末尾**；② `cleanOcrLines()` 丢掉信息字符占比 <40% 的乱码行（实测一张截图丢 16/109 行噪声）；③ AI 描述首句直接当锚点。
   - **修复后实测**：用**贴合条目真实内容**的 query（"<query 描述截图里独有的具体内容>"）→ 新条目 L3 **rank #1**（-2.62 vs #2 的 -4.12，干净拉开）。
   - **真正的边界结论**（写给未来的我，别再误判成 bug）：多模态记忆**只在"搜它里面真有的东西"时可召回**，搜泛项目词（"v5 ingest"）会被 session 日志海淹掉——这是 33k 语料下的**正确检索行为**，不是 pipeline 坏了。ingest 时把"图里独特的事实"喂进锚点/关键词，就是在为未来的召回埋钩子。

10. **full_scan stdout 是多行 pretty JSON，别只取最后一行**：`full_scan.py incremental` 用 `json.dumps(indent=2)` 输出 → 取 `.split('\n').pop()` 只拿到 `}` → 解析 null → 脚本误判"入索引失败"退 1（实际 94 chunks 已成功入库）。修法：从第一个 `{` 切到末尾整块 parse；且**解析失败 ≠ 入索引失败**（exit 0 就当成功，stats 兜底继续 reload+verify）。

11. **incremental 很慢是设计代价**：incremental 按 mtime 重扫**全部 SCAN_ROOTS**（33k+ 文件），一次约 14 分钟（实测 870s 扫 + 嵌入）。这是"单一写入者 + 全局增量"的固有开销，不是卡死。批量 ingest 应 `--no-index` 攒一批最后跑一次（v5.1）。

## 6. 验证纪律（什么证据算"通了"）— 6/11 修正

> 6/10 版写的"查 `/search_fast` 出现在 top-k"是**错的终点证据**——L2 fast 在 33k 语料里召回太弱（session 日志海淹没单条目），用它当验收会**假阳/假阴**。真实召回路径是 **L3 reranked**（`brain-memory-qmd.py search` / inject-context 最终用的就是它）。

一次 ingest 算成功，**证据缺一不可**（口头"应该可以"不算）：
1. 条目文件落盘：`ingested/*.md` 存在，**正文以干净锚点 + 关键词行开头**（不是 YAML 样板）
2. 索引增量确认：full_scan `chunks_new > 0`，total 比基线**只增不减**（本次 33135 → 33229，+94）
3. daemon 热重载确认：`/reload` 后 `/health` 的 chunks 数 = 新 total（33229）
4. **recall 命中（终点证据，必须走 L3）**：用**贴合条目真实内容**的 query 跑 `brain-memory-qmd.py search`（或 `ingest.js --verify`，已改为直接走 L3 rerank），本条目出现在 top-k。⚠️ 用泛项目词查不中**不算失败**——那是 session 日志海的正常淹没，换内容词再查。
5. 幂等确认：同文件再 ingest → ledger 拦截，零新 chunk（实测通过）

回归红线：v4 注入链路（inject-context.js）和既有 33135 chunks 的检索不受影响——v5 全程零改 v4 文件（DESIGN.md/inject-context.js mtime 仍是 6/9）、零删既有 chunk、零 rebuild，靠"只 append"结构性保证。

---

## 7. v5.1 边界（留给下一刀）

- **扫描件 PDF OCR**：PDFKit `pageAtIndex().dataRepresentation` 渲页 → NSImage 放大 ≥2x（72dpi 直接 OCR 太糊）→ Vision OCR。MVP 已留 degraded 标记位
- **批量 ingest**：`--no-index` 攒一批 + 最后一次 incremental（机制已支持，缺批量入口糖）
- **PDF 的 Haiku 摘要层**：长 PDF 文本层之上加一段 LLM 摘要（成本可控后）
- **`--private` 隔离区**：利用 full_scan `archive/` 路径黑名单做"存而不索"的敏感条目区
- **视频/音频**：帧抽样 + Whisper 类转写——完全没动，不许混进 v5 说"已支持"

---

## 8. Roadmap

- ✅ 设计定稿 + 三条转译路径本机实测（2026-06-10）
- ✅ MVP 雏形：ingest.js + JXA 两助手（2026-06-10）—— 但条目实测**召回不中**（§5.9）
- ✅ **召回修复 + 真验证（2026-06-11）**：OCR 降噪 + 锚点/关键词头部 + 验证改走 L3 + stats 解析修复 → 新条目 L3 **rank #1** 命中，全链路五证据齐
- ⏸️ v5.1（§7）

### 6/11 验证证据留档（可复现）
```
输入: /tmp/v5-test2.png（screencapture -x，3024×1964）
转译: Vision OCR 降噪 93/109 行 + claude -p haiku 描述（1 次调用）
入索引: full_scan incremental → +94 chunks（33135 → 33229），daemon /reload → 33229
召回(L3): brain-memory-qmd.py search "<query 描述截图里独有的具体内容>"
         → 本条目 rank #1（score -2.62，#2 -4.12）
幂等: 同文件再 ingest → ledger 拦截，零新 chunk
红线: v4 文件 mtime 仍 6/9 未动；只 append 从不 rebuild
```

---

**相关**：
- `~/.claude-brain/v4/DESIGN.md` — 上一版（机制轴，只读参考，本版零改动）
- `$QMD_FULL_SCAN` — 入索引唯一入口（只读，未改）
- `<your-project-dir-2>/RESEARCH_MULTIMODAL_RAG.md` — 调研（思路来源，选型不照搬）
- `~/.claude/projects/<escaped-home>/memory/feedback_brain_v4_v5_split.md` — v4/v5 分界铁律
