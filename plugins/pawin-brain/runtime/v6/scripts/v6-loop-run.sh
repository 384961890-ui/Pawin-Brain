#!/bin/zsh
# v6 第二支 loop · launchd / dispatch 入口 wrapper
# 把 PATH 准备好 + caffeinate 防睡眠 + trap 兜底 + 调 Python 主入口

set -u

# Workflow B fix · I8: zsh -c 不 source profile（保证 env 干净）· 但我们走 launchd ProgramArguments
# 已经传了 zsh -lc，所以这里只补 PATH。env 主要靠 plist EnvironmentVariables。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin"
export LANG="en_US.UTF-8"

# Workflow B fix · B5: caffeinate trap 兜底
# 即使 Python 被 launchd SIGKILL，trap 也能 kill caffeinate 防泄漏
CAFFEINATE_PID=""
cleanup() {
  if [ -n "$CAFFEINATE_PID" ]; then
    kill "$CAFFEINATE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 防止系统睡眠（35 分钟兜底——比 hard kill 多 5 分钟缓冲）
/usr/bin/caffeinate -dimsu -t 2100 &
CAFFEINATE_PID=$!

# 触发源：通过环境变量传入，默认 scheduled
export V6_LOOP_TRIGGER="${V6_LOOP_TRIGGER:-scheduled}"

# 跑主入口
/usr/bin/python3 ~/.claude-brain/v6/scripts/v6_loop_run.py
EXIT_CODE=$?

# trap 会自动 kill caffeinate 在 EXIT 时
exit $EXIT_CODE
