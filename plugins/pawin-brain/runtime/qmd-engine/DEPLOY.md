# DEPLOY.md — qmd-engine 部署指南

qmd-engine 是本地语义记忆检索：embedding 召回 + reranker 精排两阶段检索，
常驻本机 HTTP daemon，只监听 127.0.0.1。

**本项目未做任何训练/微调，只做工程集成** —— 用的是现成开源量化模型
（Qwen3-Embedding-4B / Qwen3-Reranker-0.6B），这个包提供的是围绕它们的
索引构建、原子重建、增量扫描、健康自检、常驻服务这套工程管线。

---

## 1. 依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install llama-cpp-python numpy
```

`llama-cpp-python` 需要能跑 GGUF 模型；如果要用 GPU 加速（macOS Metal /
CUDA），装对应编译选项的版本，参考 llama-cpp-python 官方文档。

**macOS 注意**：`llama-cpp-python` 在 macOS 上默认从源码编译（没有现成的
二进制轮子覆盖所有 Python/系统版本组合），需要先装 Xcode Command Line
Tools：

```bash
xcode-select --install
```

没装过 CLT 的机器上 `pip install llama-cpp-python` 要么编译失败要么卡
在编译步骤几分钟到十几分钟——这是正常现象，不代表命令卡死。

pdf/docx 解析额外需要系统工具（可选，不装就跳过这两种格式）：

```bash
# macOS
brew install pandoc poppler
# Debian/Ubuntu
apt install pandoc poppler-utils
```

## 2. 模型获取

qmd-engine 需要两个 GGUF 量化模型，放进 `$QMD_MODELS_DIR`（默认
`~/.qmd/models`）：

| 模型 | 用途 | 文件名（默认路径约定） |
|---|---|---|
| Qwen3-Embedding-4B-Q8_0 | 召回（embedding） | `Qwen3-Embedding-4B-Q8_0.gguf` |
| Qwen3-Reranker-0.6B-Q8_0 | 精排（reranker） | `qwen3-reranker-0.6b-q8_0.gguf` |

从 Hugging Face 上对应的 GGUF 仓库下载（搜 "Qwen3-Embedding-4B-GGUF" /
"Qwen3-Reranker-0.6B-GGUF"，选 Q8_0 量化版本）。两个都是现成开源模型，
下载后直接放进 `$QMD_MODELS_DIR` 即可，代码里不需要改任何路径——
`qmd_config.py` 会自动从这个目录按上表文件名拼路径。

换成别的量化档位（如 Q4）或别的 embedding 模型会改变输出维度，
必须同步改 `qmd_config.py` 的 `EXPECTED_EMBED_DIM` 并全量重建索引，
见 PITFALLS.md「换 embedding 模型必须全量重算索引」条。

## 3. 环境变量

全部有默认值，按需覆盖：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QMD_HOME` | `~/.qmd` | 根目录。以下几个 `$QMD_HOME/...` 默认值全部从它派生——只设 `QMD_HOME`、不单独设下面几个目录变量时，索引/日志/告警都应该落在同一棵目录树下（这是 nightly_run.sh / health_check.py 之前的一个 bug：它们各自的 fallback 硬编码了 `~/.qmd/...`，没有真的从 `QMD_HOME` 派生，已修） |
| `QMD_INDEX_DIR` | `$QMD_HOME/index` | 索引存放（chunks.jsonl / embeddings.npy / manifest.json） |
| `QMD_MODELS_DIR` | `$QMD_HOME/models` | GGUF 模型目录 |
| `QMD_MEMORY_DIR` | `$QMD_HOME/memory` | 待索引目录，多个用系统 PATH 分隔符 `:`（Linux/macOS）分隔 |
| `QMD_DOCS_ONLY_DIR` | 空 | 系统 PATH 分隔符 `:` 分隔的目录前缀列表，这些目录下只收文档不收代码（与 `QMD_MEMORY_DIR` 统一用 `:`，不再用逗号） |
| `QMD_EXCLUDE_DIR` | 空 | 系统 PATH 分隔符 `:` 分隔的目录前缀列表，整棵子树跳过不扫 |
| `QMD_DAEMON_PORT` | `18765` | daemon 监听端口（只绑 127.0.0.1）；`full_scan.py` 复用常驻 daemon 时也读这个变量，两边必须一致 |
| `QMD_DAEMON_ERR_LOG` | 空 | daemon 自身 err log 的路径（应该和 plist/service 里 `StandardErrorPath`/重定向目标填同一个路径）。daemon 启动时会在这个文件超过 10MB 时轮转成 `.err.1`——不设这个变量轮转直接跳过，err log 可能无限增长。轮转只在**下次进程重启**时真正体现（见 `qmd_daemon.py::_rotate_err_log_if_huge` 注释），不是设了就立刻生效 |
| `QMD_HEALTH_LOG_DIR` | `$QMD_HOME/health-log` | 健康自检日志目录 |
| `QMD_HEALTH_GREP_PROBES` | — | 逗号分隔，L1 grep 探针词（建议设成你记忆库里确实存在的词）。不设置则用通用兜底词，此时体检只验证链路可达，不代表检索命中率 |
| `QMD_HEALTH_SEMANTIC_PROBES` | — | 逗号分隔，L2/L3 语义探针词。同上，不设置则退化为链路验证模式 |

## 4. 建索引

首次全量：

```bash
python3 full_scan.py rebuild
```

原子重建：新索引写到临时 staging 目录，全部构建完、自洽校验通过后才
整体顶替旧索引；中途被杀，旧索引原封不动（见 PITFALLS.md）。

日常增量（只处理新增/改过/删除的文件，秒级到分钟级）：

```bash
python3 full_scan.py incremental
```

先看看会扫到什么，不实际写索引：

```bash
python3 full_scan.py dry-run
```

## 5. daemon 常驻

daemon 把模型加载进内存常驻，避免每次查询都重新加载模型（模型加载
是秒级到十几秒级开销，常驻后单次查询降到 `/search_fast` ~0.4s 量级）。

手动跑（前台调试）：

```bash
python3 qmd_daemon.py
```

生产环境用进程守护跑起来并开机自启：

- **macOS**：见 `launchd/com.example.qmd-daemon.plist`，`launchctl load` 即可
- **Linux**：见 `systemd/qmd-daemon.service`，`systemctl --user enable --now` 即可

两份配置示例都只在本机 127.0.0.1 监听，不对外暴露端口。

## 6. 接口

daemon 起来后：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 存活检查 + 索引维度/规模 |
| `/search_fast?query=...&top_k=5` | GET | 只跑 embedding 召回，不调 reranker。**日常首选**，~0.4s 量级 |
| `/search?query=...&top_k=5&rerank=1` | GET | 两阶段检索（embedding 召回 + reranker 精排）。**几十秒级**（实测 recall_k≈24 时约 30-50s，量级取决于 `recall_k`——召回越多送进 reranker 的候选越多，逐条 cross-encoder 打分是最耗时的部分），精度更高，**兜底/深查询用**，不适合当默认路径 |
| `/reload` | GET | 索引更新后热重载 chunks + embeddings（模型不重新加载） |
| `/embed` | POST | `{"texts": [...], "batch_size": N}`，供索引构建脚本复用常驻模型，避免额外加载一份模型 |

调用建议（见 PITFALLS.md「三层路由哲学」）：能用 grep 精确命中的先
grep（免费，零延迟）；grep 找不到再走 `/search_fast`（本地算力，快）；
`/search_fast` 结果不够好才上 `/search`（reranker，慢，最后手段）。

## 7. 增量定时任务

`nightly_run.sh` 只做增量扫描，不做全量重建（全量很重，凌晨自动跑
容易撞到白天使用时段，见 PITFALLS.md）。

- **macOS**：`launchd/com.example.qmd-nightly.plist`
- **Linux**：`systemd/qmd-nightly.service` + `qmd-nightly.timer`

需要全量重建时，人工前台跑并盯着它：

```bash
python3 full_scan.py rebuild
```

## 8. 健康自检

```bash
python3 health_check.py
```

跑一遍 L1 grep / L2 /search_fast / L3 /search 三层探针，结果写进
`$QMD_HEALTH_LOG_DIR`，任一层失败 exit code 非零，适合接进定时任务
每天巡检一次——静默失败往往比崩溃更难发现，这个脚本就是治这个的。

## 9. 退出码约定

本包几个脚本各自用退出码表达不同的失败语义，同一个数字在不同脚本里含义
不一样，接自动化脚本（launchd/systemd/cron/health check）前先对一下：

| 脚本 | 退出码 | 含义 |
|---|---|---|
| `full_scan.py` | `0` | 正常完成（含"无变更"） |
| `full_scan.py` | `1` | 无文件可扫描（`QMD_MEMORY_DIR` 是空的），友好退出，不是异常 |
| `full_scan.py` | `3` | 三件套（chunks/embeddings/file_index）行数不一致，或增量一轮缩水超过 50%——拒绝写盘，已留 `NEEDS-REBUILD`，人工介入 |
| `qmd_daemon.py` | 进程正常运行 | 不退出 |
| `qmd_daemon.py` | `2` | 加载索引时维度/manifest 校验失败（fail-fast），交给 launchd/systemd 重启后重新校验 |
| `qmd_daemon.py` HTTP | `400` | 请求参数非法（缺 query / top_k 不是整数） |
| `qmd_daemon.py` HTTP | `403` | Host 头不是 127.0.0.1/localhost |
| `qmd_daemon.py` HTTP | `413` | `/embed` 请求体超过 `MAX_EMBED_BODY_BYTES`（50MB） |
| `qmd_daemon.py` HTTP | `500` | 未预料的内部异常（兜底，不会裸 traceback 断连接） |
| `health_check.py` | `0` | 全部探针通过 |
| `health_check.py` | `1` | 至少一层探针失败 |
| `nightly_run.sh` | 透传 `full_scan.py incremental` 的退出码 | `3` 或其他非零都会写 `NEEDS-REBUILD`（措辞按是否为维度污染区分，见脚本注释） |
