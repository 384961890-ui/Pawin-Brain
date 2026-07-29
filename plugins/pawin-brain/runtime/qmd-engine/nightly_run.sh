#!/bin/bash
# qmd-engine 增量索引入口（供 launchd/cron/systemd timer 调用）。
#
# 只做增量。全量重建很重（几万块 chunk / 数百 MB / 数小时量级），挂在
# 凌晨自动跑容易撞到白天使用时段——我们踩过三次风扇狂转的教训。
# 根治：凌晨永不自动全量重建。需要重建时人工前台跑，盯着它：
#     $QMD_VENV_PYTHON $QMD_ENGINE_DIR/full_scan.py rebuild
#
# 详见 PITFALLS.md「索引重建必须原子化」条。
set -u

# QMD_INDEX_DIR 必须从 QMD_HOME 派生（和 qmd_config.py 的
# INDEX_DIR = _env_path("QMD_INDEX_DIR", QMD_HOME / "index") 保持一致），
# 不能像之前那样直接硬编码 $HOME/.qmd/index——用户只设了 QMD_HOME
# （plist/service 模板引导的就是这么设）时，这里会算出跟 full_scan.py/
# health_check.py 不一样的目录，NEEDS-REBUILD 告警和体检各自盯着不同
# 地方，整套告警机制静默失明。
QMD_HOME="${QMD_HOME:-$HOME/.qmd}"
QMD_INDEX_DIR="${QMD_INDEX_DIR:-$QMD_HOME/index}"
QMD_ENGINE_DIR="${QMD_ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
QMD_VENV_PYTHON="${QMD_VENV_PYTHON:-python3}"
QMD_DAEMON_LAUNCHD_LABEL="${QMD_DAEMON_LAUNCHD_LABEL:-}"  # 例：com.example.qmd-daemon（可选，仅 macOS）
QMD_DAEMON_PORT="${QMD_DAEMON_PORT:-18765}"

FLAG="$QMD_INDEX_DIR/.rebuild-once"
NEEDFLAG="$QMD_INDEX_DIR/NEEDS-REBUILD"
SCRIPT="$QMD_ENGINE_DIR/full_scan.py"
ts() { date '+%F %T'; }

# .rebuild-once：任何调用方都可能 touch 这个文件申请重建。消费掉（防累积），
# 但不在凌晨自动执行重量级重建——改留人工告警，需要重建的人自己前台跑。
if [ -f "$FLAG" ]; then
    rm -f "$FLAG"
    echo "[nightly $(ts)] ⚠️ 检测到 .rebuild-once —— 自动全量重建已禁用（防止凌晨烧到白天）。已留 NEEDS-REBUILD 告警。"
    echo "$(ts) .rebuild-once 触发。人工前台跑：$QMD_VENV_PYTHON $SCRIPT rebuild" >> "$NEEDFLAG"
fi

echo "[nightly $(ts)] 增量扫描"
"$QMD_VENV_PYTHON" "$SCRIPT" incremental
RC=$?

# 维度污染(exit 3)：这类错误意味着索引/模型状态不一致，不该自动盲目重建，
# 应该停下等人工排查（health_check 会同时报出来）。
if [ "$RC" -eq 3 ]; then
    echo "[nightly $(ts)] ❌ 增量遇维度污染/三件套不一致(exit 3) —— 自动重建已禁用。已留 NEEDS-REBUILD 告警，请人工排查。"
    echo "$(ts) exit3 维度污染/不一致。人工排查+跑：$QMD_VENV_PYTHON $SCRIPT rebuild" >> "$NEEDFLAG"
elif [ "$RC" -ne 0 ]; then
    # exit 3 以外的任何非零退出（比如 python 解释器路径失效走到 127、
    # 依赖没装崩在 import 阶段等）之前完全静默——只有 exit 3 才落告警，
    # 别的失败整夜没人知道，直到某天发现索引很久没更新过。
    # 不确定是不是数据本身坏了，所以措辞和 exit3 分开，别让人工一上来就跑 rebuild。
    echo "[nightly $(ts)] ❌ 增量扫描异常退出(exit $RC，非维度污染)—— 已留 NEEDS-REBUILD 告警，请人工排查（先确认 python/依赖/路径是否正常，不一定要 rebuild）。"
    echo "$(ts) exit$RC 非预期退出（非 exit3 维度污染）。人工排查：先手动跑一遍 $QMD_VENV_PYTHON $SCRIPT incremental 看报什么错" >> "$NEEDFLAG"
fi

# 扫描后重启 daemon（替代旧的 /reload）：① 加载新索引 ② 应用代码更新
# ③ 清掉 embed/search 在内存基线之上累积的碎片。
# 注意：daemon 常驻内存基线较高（模型 + reranker logits_all + GPU/Metal buffer），
# 重启不降基线；这里重启主要防"长期只增不减"的运行时碎片。
if [ -n "$QMD_DAEMON_LAUNCHD_LABEL" ] && launchctl kickstart -k "gui/$(id -u)/$QMD_DAEMON_LAUNCHD_LABEL" 2>/dev/null; then
    echo "[nightly $(ts)] daemon 已重启（launchctl kickstart -k）"
else
    # 兜底：kickstart 不可用（非 macOS，或未配置 launchd label）退回 /reload
    curl -s --max-time 30 "http://127.0.0.1:${QMD_DAEMON_PORT}/reload" >/dev/null 2>&1 \
        && echo "[nightly $(ts)] 已用 /reload 刷新索引（未重启进程，代码更新需手动重启 daemon）" \
        || echo "[nightly $(ts)] daemon 重启/reload 均失败——daemon 可能未运行"
fi
exit $RC
