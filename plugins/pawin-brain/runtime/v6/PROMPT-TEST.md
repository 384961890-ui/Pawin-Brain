# v6 屎山红灯 · 陪测剧本（喂给下个 session 即可）

> 用户：下个对话直接把下面这一整段粘进去给新 session 的我。它会自己读懂前因后果，跑 8 步陪测，最后给你一份报告。

---

```
泡咪。今天上一场我们做完了 claude-brain v6 屎山红灯的第一支（接 6/16 白天那场深聊：v6 = 认知纪律轴 = 给延迟的好装即时红灯 = 外挂变免疫）。建好了、加固过了、自测 7/7、已挂 settings、已 enabled:true。但 hook 是新 session 才生效，所以陪测必须新开对话做 —— 这场就是。

任务：陪用户跑 8 步 v6 屎山红灯陪测剧本，产出一份测试报告。

## 第 0 步：读 build 状态（不要凭记忆，看地面真相）
1. 读 ~/.claude-brain/v6/DESIGN.md（病根 + 设计哲学）
2. 读 ~/.claude/projects/<escaped-home>/memory/projects/claude-brain/project_claude_brain_v6.md（项目状态记忆）
3. 读 ~/.claude/projects/<escaped-home>/memory/feedback/feedback_posttooluse_block_loop.md（PostToolUse block 死循环血泪 —— 测试期间如果你想"修一下让密钥真硬拦"，先读这条）
4. 单行 grep 确认 hook 真挂在 settings：`grep -n smell-check ~/.claude/settings.json` 应返回 1 行
5. 单行 python3 确认 enabled：`python3 -c "import json; print(json.load(open('~/.claude-brain/v6/config.json'))['enabled'])"` 应输出 True

## 第 1-8 步：陪测剧本（每写一个文件 → 立刻报告"红灯亮了 / 没亮 / 文案对不对"）

测试文件全部写到 /tmp/v6test/ 下（先 mkdir -p）。每步之间不要清节流，按真实使用顺序走。

| 步 | 写什么文件 | 期望 |
|:---|:---|:---|
| 1 | clean.js（一个干净 add 函数 + module.exports） | 🟢 静默（屎山红灯不该亮） |
| 2 | bigfile.js（850 行 const v1..v850） | 🚩 红灯 file_too_long 「这文件 850 行了…」 |
| 3 | longfn.js（一个函数体里堆 100 行连续真代码） | 🚩 红灯 long_function 「第 N 行起 100 行代码堆没断开…」 |
| 4 | messy.js（含 5 个 TODO/FIXME + 3 个 console.log） | 🚩 红灯（合并显示前两条 + "还有 1 处小问题先不打断你"） |
| 5 | secret_real.js（含 apiKey: "sk-proj-realKey1234567890XYZ"） | 🚩 高优先红灯 🔴 密钥 —— 但**不阻断**，文件该还在 |
| 6 | secret_env.js（apiKey: process.env.X / "your-key-here" / "changeme"） | 🟢 静默（占位/env 不该误报） |
| 7 | foo.test.js（含 2 个 console.log） | 🟢 静默（测试文件放宽 debug_leftover） |
| 8 | 5 分钟内再 Edit 第 2 步的 bigfile.js（加一行注释） | 🟢 静默（throttle 节流生效） |

## 异常处理（重要 —— 不要乱改 v6 代码）

- **某步红灯没亮该亮 / 误报了 / 文案不对**：**先记录到测试报告**，不要立刻动 detectors.js / smell-check.js。用户看完报告再决定修哪条 —— 你今晚（这个 session）的角色是 QA 不是开发。
- **想"密钥这不应该硬拦吗"**：不要改回 block。读 feedback_posttooluse_block_loop.md，那是死循环血泪。真硬拦留 v6.1 PreToolUse。
- **觉得阈值不对（如 800 行太宽松）**：先记进报告"建议阈值微调"，别动 config.json。
- **任何一步整个 hook 崩溃 / 主流程被阻断**：立刻 `python3 -c "import json; c=json.load(open('~/.claude-brain/v6/config.json')); c['enabled']=False; import json; open('~/.claude-brain/v6/config.json','w').write(json.dumps(c, indent=2))"` 一键熄火，然后写报告。

## 测完产出

写一份测试报告到 `~/.claude-brain/v6/state/live-test-report.md`：
- 每步：期望 vs 实际、是否 PASS、实际红灯原文（如有）
- 总体：x/8 PASS
- 建议清单（阈值微调 / 文案优化 / 检测器增减）—— 只记不动
- 元观察：陪测过程中你自己有没有触发屎山红灯（如果你也写了被红灯打回来的文件 —— 那才是 dogfood 真起作用）

汇报给用户的时候用一句话：x/8 PASS + 最值得说的一条发现。

## 注意你自己

陪测过程中你自己写测试 fixture 文件也会触发红灯（dogfood）。这是好事 —— 说明它真活着。被红灯打回来的时候，认真按"二选一"应一句（"这是测试 fixture 故意写大的，划过"），不要烦它、不要绕过它、不要改 config 关掉它。让它工作。

开始吧。
```

---

**用户看的：** 报告产物 `~/.claude-brain/v6/state/live-test-report.md`。我下次 session 醒来读这份报告就知道 6/17 陪测发现了什么、要不要修。
