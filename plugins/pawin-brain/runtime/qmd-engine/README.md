# qmd-engine

本地语义记忆检索引擎：两阶段检索（embedding 召回 + reranker 精排），
常驻本机 daemon，完全离线、不出网、只监听 127.0.0.1。

用现成开源量化模型（Qwen3-Embedding-4B-Q8 + Qwen3-Reranker-0.6B-Q8）
做工程集成——本项目未做任何训练/微调，价值在索引构建、原子重建、
增量扫描、健康自检这套围绕检索的工程管线。

## 架构（文字版）

```
                     ┌─────────────────────────┐
   文件目录  ──扫描──▶│      full_scan.py         │──写盘──▶ 索引三件套
 (QMD_MEMORY_DIR)    │  (分块 → 嵌入 → 原子写)    │        chunks.jsonl
                     └─────────────────────────┘        embeddings.npy
                                  │                      manifest.json
                          复用常驻模型（可选）
                                  │
                                  ▼
                     ┌─────────────────────────┐
   查询请求 ──HTTP──▶│      qmd_daemon.py        │
 /search_fast        │  (embedding + reranker    │──读取──▶ 索引三件套
 /search              常驻内存，避免重复加载模型) │
 /health /reload      └─────────────────────────┘
 /embed

                     ┌─────────────────────────┐
   定时任务 ────────▶│    nightly_run.sh         │──调用──▶ full_scan.py incremental
 (launchd/systemd)   │  (只做增量，全量重建留给     │──重启──▶ qmd_daemon（应用新索引）
                      人工前台触发)               │
                     └─────────────────────────┘

                     ┌─────────────────────────┐
   定时/手动 ───────▶│    health_check.py        │──产出──▶ 每日健康日志
                     │  L1 grep / L2 fast /       │           (QMD_HEALTH_LOG_DIR)
                      L3 rerank 三层探针           │
                     └─────────────────────────┘
```

三层检索的选层逻辑（免费 grep → 本地 embedding → reranker 精排）
详见 PITFALLS.md「三层路由哲学」条。

## 快速开始

```bash
# 1. 装依赖（macOS 上 llama-cpp-python 会从源码编译，需要先装
#    Xcode Command Line Tools：xcode-select --install；
#    没装过的话编译要额外几分钟到十几分钟，属正常现象不是卡住）
python3 -m venv .venv && source .venv/bin/activate
pip install llama-cpp-python numpy

# 2. 放模型（见 DEPLOY.md 第 2 节获取方式）
mkdir -p ~/.qmd/models
# 把 Qwen3-Embedding-4B-Q8_0.gguf 和 qwen3-reranker-0.6b-q8_0.gguf 放进去

# 3. 配置待索引目录，并放至少一个示例文件进去——
#    空目录直接 rebuild 没有内容可建索引，下一步会友好提示并退出
mkdir -p ~/.qmd/memory
export QMD_MEMORY_DIR=~/.qmd/memory
echo "这是一条示例记忆：qmd-engine 用来检索你自己的笔记/文档。" > ~/.qmd/memory/example.md

# 4. 建索引
python3 full_scan.py rebuild

# 5. 起 daemon
python3 qmd_daemon.py &

# 6. 搜索
curl "http://127.0.0.1:18765/search_fast?query=你好&top_k=5"
```

生产部署（开机自启、崩溃自动重启、定时增量扫描、健康自检）见 **DEPLOY.md**。
工程踩坑经验（chunk 尺寸/换模型/原子重建/事务化写盘/三层路由）见 **PITFALLS.md**。

## 文件结构

```
qmd-engine/
├── qmd_config.py        # 唯一配置出处：维度/模型名/目录路径（全部走环境变量）
├── full_scan.py         # 扫描 + 分块 + 嵌入 + 原子写索引（含 rebuild/incremental）
├── qmd_daemon.py         # 常驻 HTTP daemon：/search /search_fast /health /reload /embed
├── health_check.py       # 三层召回健康自检（grep / embedding / reranker）
├── nightly_run.sh        # 增量扫描定时任务入口
├── qmd_src/qmd/           # 检索引擎核心库：ingest.py（分块/文件清单）+ search_embed.py（向量检索/精排）
├── launchd/               # macOS 部署配置示例
└── systemd/                # Linux 部署配置示例
```

## 许可与说明

模型本身遵循各自的开源许可（Qwen3 系列，查阅对应模型卡）。本包代码
仅涉及工程集成，不包含任何训练数据或模型权重。
