# v6 第二支 · Dispatch 主动触发使用说明

> 你在外面，电脑联网开着，但没空 typing 跟泡咪交代细节——
> 在你的 dispatch session 里发一句话就让本地泡咪进入 v6 loop 模式。

## 触发命令（在 dispatch session 里发）

```bash
V6_LOOP_TRIGGER=dispatch bash ~/.claude-brain/v6/scripts/v6-loop-run.sh
```

dispatch session 是 Claude Code agent，有 Bash 工具权限，会直接执行。它跑起来后：

1. 加载 `loop-config.json` 检查 enabled / 速率 / 互斥 / 活跃
2. 启 claude headless 跑 30 分钟（opus 4.7 thinking high）
3. 按 `loop-prompt.md` 执行五步流程
4. Telegram 通知你结果（msg 推到你 chat_id）

**dispatch 速率限制 ≤3 次/天**——超了主入口会直接拒绝。

## 你能看啥（可视化）

dispatch 触发的 stream-json 实时写到：

```
~/.claude-brain/v6/loop-worklog/streams/<TS>-dispatch.jsonl
```

你 dispatch session 是 Claude Code，能直接 `tail -f` 看这个文件。或者读 `loop-state.json` 看 `current_run`。

## 怎么 kill

dispatch session 里：

```bash
# 查 pid
cat ~/.claude-brain/v6/state/loop-state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('current_run',{}).get('pid'))"

# kill（pid 替换）
kill <pid>
```

或者改 `loop-config.json` `enabled:false`（下次触发就退）。但当前已经跑的不会停——必须 kill。

## 跟被动触发的差异

| 维度 | 被动 scheduled | 主动 dispatch |
|:---|:---|:---|
| 触发源 | launchd 00:01/04:01/09:01 | 你手动跑 bash |
| 活跃检测 | 严格（30min 内活跃就退） | 严格（同上——dispatch 触发也会被活跃检测拦） |
| 速率 | 一天三次窗口 | ≤3 次/天（独立计数） |
| 上岗规则 | 完全一样 | 完全一样 |
| 工作日志 | trigger: scheduled | trigger: dispatch |

如果你想强行触发跳过活跃检测（你已经知道电脑没人用），加 `V6_LOOP_FORCE=1`：

```bash
V6_LOOP_TRIGGER=dispatch V6_LOOP_FORCE=1 bash ~/.claude-brain/v6/scripts/v6-loop-run.sh
```

## 状态查询

```bash
cat ~/.claude-brain/v6/state/loop-state.json
```

里面有 `running` / `current_run` / `last_run` / `dispatch_count_today` / `consecutive_failures`。

## 紧急停 loop（所有触发都停）

```bash
# 改 enabled:false（下次触发拒绝，当前跑的不停）
python3 -c "import json;from pathlib import Path;p=Path.home()/'.claude-brain/v6/loop-config.json';c=json.load(open(p));c['enabled']=False;json.dump(c,open(p,'w'),indent=2,ensure_ascii=False)"

# kill 当前 pid（如果在跑）
pid=$(python3 -c "import json;from pathlib import Path;d=json.load(open(Path.home()/'.claude-brain/v6/state/loop-state.json'));print(d.get('current_run',{}).get('pid') or '')")
[ -n "$pid" ] && kill $pid
```

## 注意

- dispatch 触发也走 dry-run 模式（除非 config 改 live）
- dispatch 触发**也会被互斥锁拦**——同时只能跑一个
- dispatch 触发**也走 Plan limit**（不另外烧钱）
