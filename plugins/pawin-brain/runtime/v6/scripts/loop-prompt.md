# 巡检任务

定时唤醒后,只做一件事:把下面三个项目按六项查清楚,产出一份体检报告。**不改任何代码、不 commit、不启服务**。

## 巡这三个

- `<your-brain-project-dir>` (brain 本身)
- `<your-project-1>` (<Project Alpha> 桌面前端)
- `<your-project-2>` (<Project Alpha> 后端)

## 每个查六项

1. **git 状态** — 未提交的活、未 push 的 commit、当前分支。`git status -sb` + `git log @{u}.. --oneline` 即可。
2. **代码 TODO** — `grep -rEn "(TODO|FIXME|XXX|ponytail:)" --include="*.{js,ts,tsx,jsx,py,go,rs,md}" --exclude-dir={node_modules,.git,dist,build,out,coverage,.next,target,android,test-results} --exclude="index-*.js" --exclude="*.min.js" --exclude="*.chunk.js" --exclude="*.bundle.*"` 按文件聚合,只列前 10 条**真代码**(过滤掉 prompt/BP/任务追踪文档里的字面"TODO")。
3. **测试入口** — 有 `package.json` 看 `scripts.test`;有 Makefile 看 `test:` target。**不要主动跑测试**,只汇报"有入口未跑 / 无测试入口"。
4. **README ↔ 代码对齐** — 抽 README 里提到的 1-2 个命令/路径/文件名,grep 看代码里还在不在。不深究,只抓显眼的脱节。
5. **上次建议落地情况** — 读 `brain-research/inspections/` 里上一份报告(按文件名时间排序最近的)。逐条看 "综合建议" 段每条这次是否已做。**复发的标记 ⚠️ 复发**(需要user决定还要不要做)。
6. **项目内待办块** —
   - brain:读 `README.md` 的 P0/P1/P2 区块
   - 其他项目:读 `README.md` / `TODO.md` / `NOTES.md` / `TASKS.md` / `ROADMAP.md` / `*-TASKS.md` / `*-REPORT.md`(如有任一)

## 报告写到哪

`<your-brain-project-dir>/brain-research/inspections/YYYY-MM-DD-HHMM.md`

时间戳用当前时间,到分。

## 报告格式

```
# 巡检报告 YYYY-MM-DD HHMM

## brain
- git: <一行>
- TODO: <N 条,列前 10 条最显眼>
- 测试: <状态>
- README 对齐: <发现/无>
- 上次建议落地: <逐条状态,复发标 ⚠️>
- 项目待办: <P0/P1/P2 各几条 / 已经做了哪些>

## your-project-1
(同上)

## your-project-2
(同上)

---

## 综合建议(优先级排序)

1. **[高/中/低]** <简述> — <哪个项目> — 建议:<下次怎么处理>
   - 证据:<文件路径/行号 或 grep 命中 或 commit hash>

(如本次无任何新发现,写"本次无新发现"——不准硬凑)
```

## 铁律

- **只读、不改代码** — 不 commit / push / 启服务 / 改配置 / 删文件
- **没就不凑** — 某项无内容直接写"无",不掰建议出来
- **证据先行** — 每个发现给文件路径/行号/commit/grep 命中,不允许空口
- **复发要响** — 上次建议这次仍在,标 ⚠️ 复发(代表user的决定权,不是我自动推进)
- **不动 brain 自身的代码** — 哪怕 brain 项目里有 TODO,也只汇报不改
