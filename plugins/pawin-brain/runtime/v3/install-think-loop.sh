#!/bin/bash
# install-think-loop.sh — 把 claude-brain v3 think-detect.js 挂到 Stop hook
#
# 设计（照 v2 install-hooks.sh 的安全模式 + 现实修正）：
# - 先备份 settings.json
# - 用 Python 改（保留其他所有 hooks）
# - 幂等去重（已挂载则跳过）
# - 以"独立 entry"追加，不依赖任何现有命令串（现状 Stop 里没有 capture-lesson 串）
# - 改完校验 JSON 合法
#
# 注：inject 端（buildStuckBlock 读旗 + buildPlanningBlock 三问）已写进
#     ~/.claude-brain/scripts/inject-context.js，而它已挂在 UserPromptSubmit，
#     无需额外挂 hook。本脚本只负责把 think-detect 的 Stop 这一侧装上。

set -e

SETTINGS="$HOME/.claude/settings.json"
THINK_DETECT="$HOME/.claude-brain/v3/scripts/think-detect.js"

if [ ! -f "$SETTINGS" ]; then echo "❌ $SETTINGS 不存在"; exit 1; fi
if [ ! -f "$THINK_DETECT" ]; then echo "❌ $THINK_DETECT 不存在"; exit 1; fi

BACKUP="${SETTINGS}.bak-thinkloop-$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$BACKUP"
echo "✅ 备份 → $BACKUP"

chmod +x "$THINK_DETECT" 2>/dev/null || true

python3 << 'PYEOF'
import json, os
sp = os.path.expanduser('~/.claude/settings.json')
s = json.load(open(sp))
stop = s.setdefault('hooks', {}).setdefault('Stop', [])
cmd = 'node ' + os.path.expanduser('~/.claude-brain/v3/scripts/think-detect.js')

if any('v3/scripts/think-detect' in json.dumps(g) for g in stop):
    print('⏭️  think-detect 已挂载，跳过')
else:
    stop.append({'matcher': '', 'hooks': [{'type': 'command', 'command': cmd, 'timeout': 8}]})
    json.dump(s, open(sp, 'w'), indent=2, ensure_ascii=False)
    print('✅ think-detect.js 已挂到 Stop hook')
PYEOF

python3 -c "import json,os; json.load(open(os.path.expanduser('~/.claude/settings.json'))); print('✅ settings.json JSON 合法')"

echo ""
echo "生效方式：下次启动 Claude Code 会话即生效（hook 在会话启动时加载）。"
