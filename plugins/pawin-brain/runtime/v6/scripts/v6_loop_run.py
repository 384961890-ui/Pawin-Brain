#!/usr/bin/env python3
"""v6 第二支 · 5h 定时上班 loop · 主入口

由 launchd（scheduled）或 dispatch 调用。
责任：
1. 读 config + state（防腐败）
2. config schema 校验前置
3. 6 道闸（enabled / fcntl-flock 真互斥 + pid 健康 / dispatch quota / active / mode / time-window）
4. 跨日 quota 重置立即落盘
5. subprocess.Popen + setsid 启 claude headless 30min · 超时 killpg
6. 原子写 state · finally 用 update 模式

环境变量：
- V6_LOOP_TRIGGER: "scheduled" | "dispatch"（默认 scheduled）
- V6_LOOP_FORCE: "1" 跳过活跃检测

6/17 Workflow B review fix:
- B1: --append-system-prompt-file 不存在 → 改 --append-system-prompt <content>
- B2/B3/🔴-3: fcntl.flock 真锁 + pid 健康检查（防 SIGKILL 锁死）
- B4: subprocess.Popen + setsid + killpg 杀子进程组
- 🔴-1: dispatch quota 跨日重置立即落盘
- 🔴-4: load_json 加 try
- 🟡-4: config schema 校验前置
- I3: dispatch quota 只在真启动 claude 时 +1
- I7: 删 --permission-mode bypassPermissions（与 --dangerously-skip-permissions 重复）
- I9: 原子写 state（tmp + os.replace）
"""

import json
import os
import sys
import uuid
import subprocess
import datetime
import time
import fcntl
import signal
import tempfile
from pathlib import Path

# NOTE: replace <escaped-home> with your escaped home dir (your $HOME with every "/"
# replaced by "-") before enabling GATE-4 user-activity detection.
# Until replaced, GATE-4 is skipped with a log line instead of silently doing nothing.
ESCAPED_HOME = '<escaped-home>'

V6 = Path.home() / '.claude-brain/v6'
CONFIG = V6 / 'loop-config.json'
STATE = V6 / 'state/loop-state.json'
LOCK = V6 / 'state/loop.lock'
PROMPT = V6 / 'scripts/loop-prompt.md'
ERR_LOG = V6 / 'loop-worklog/v6loop.err.log'

REQUIRED_CONFIG_PATHS = [
    ('execution', 'mode'),
    ('execution', 'model'),
    ('execution', 'effort'),
    ('execution', 'max_thinking_tokens'),
    ('execution', 'max_duration_sec_hard_kill'),
    ('paths', 'claude_bin'),
    ('paths', 'loop_prompt'),
    ('trigger', 'scheduled_hours'),
    ('trigger', 'dispatch_daily_limit'),
    ('trigger', 'active_detection_min'),
]


def log_err(msg):
    ERR_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(ERR_LOG, 'a') as f:
        f.write(f"[{datetime.datetime.now().isoformat()}] {msg}\n")
        f.flush()
    print(msg, file=sys.stderr)


def load_json_safe(p, default=None):
    """读 JSON 防腐败。失败返回 default（None=致命退出）"""
    try:
        return json.loads(p.read_text())
    except FileNotFoundError:
        return default
    except (json.JSONDecodeError, OSError) as e:
        log_err(f"FATAL state file corrupted: {p} · {e}")
        if default is None:
            sys.exit(2)
        return default


def save_json_atomic(p, d):
    """原子写：tmp + os.replace 不会有半截 JSON"""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        mode='w', delete=False, dir=str(p.parent), prefix=f'.{p.name}.', suffix='.tmp'
    )
    try:
        json.dump(d, tmp, indent=2, ensure_ascii=False)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, p)
    except Exception:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        raise


def validate_config_schema(cfg):
    """前置 config 必填字段检查"""
    for path in REQUIRED_CONFIG_PATHS:
        cur = cfg
        for k in path:
            if not isinstance(cur, dict) or k not in cur:
                log_err(f"FATAL config missing required field: {'.'.join(path)}")
                return False
            cur = cur[k]
    mode = cfg['execution']['mode']
    if mode not in ('dry-run', 'live'):
        log_err(f"FATAL config invalid mode={mode}, must be dry-run|live")
        return False
    bin_path = Path(cfg['paths']['claude_bin'])
    if not bin_path.exists():
        log_err(f"FATAL claude_bin not found: {bin_path}")
        return False
    prompt_path = Path(cfg['paths']['loop_prompt'])
    if not prompt_path.exists():
        log_err(f"FATAL loop_prompt not found: {prompt_path}")
        return False
    return True


def pid_alive(pid):
    """检查 pid 是否还活着"""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except Exception:
        return False


def acquire_lock():
    """fcntl.flock 真互斥锁。返回 file descriptor 或 None（已被占）"""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = open(LOCK, 'w')
    try:
        fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_fd
    except BlockingIOError:
        lock_fd.close()
        return None


def initial_state():
    return {
        '_doc': 'v6 第二支 loop 状态文件 · 互斥锁(fcntl.flock 真锁) + 速率统计 + 失败计数',
        'running': False,
        'current_run': None,
        'last_run': None,
        'dispatch_count_today': {'date': '', 'count': 0},
        'consecutive_failures': 0,
        'history_count': 0,
    }


def main():
    trigger = os.environ.get('V6_LOOP_TRIGGER', 'scheduled')
    force = os.environ.get('V6_LOOP_FORCE') == '1'

    # === Preflight: config + state 完整性 ===
    if not CONFIG.exists():
        log_err(f"FATAL config not found: {CONFIG}")
        return 2
    cfg = load_json_safe(CONFIG)
    if not validate_config_schema(cfg):
        return 2

    state = load_json_safe(STATE, default=initial_state())

    # === GATE-1 enabled ===
    if not cfg.get('enabled'):
        log_err(f"GATE-1 disabled, exit (trigger={trigger})")
        return 0

    # === GATE-2 真互斥锁（fcntl.flock）+ pid 健康检查 ===
    # 步骤 a: 检查 state.running + pid 是否还活着（防 SIGKILL 残留）
    if state.get('running'):
        stale_pid = (state.get('current_run') or {}).get('pid')
        if stale_pid and pid_alive(stale_pid):
            log_err(f"GATE-2 another loop running pid={stale_pid} session={state['current_run'].get('session_id')}")
            return 1
        else:
            log_err(f"GATE-2 stale lock pid={stale_pid} dead, force unlock")
            state['running'] = False
            state['last_run'] = state.get('current_run')
            state['current_run'] = None
            save_json_atomic(STATE, state)
    # 步骤 b: fcntl.flock 真锁
    lock_fd = acquire_lock()
    if lock_fd is None:
        log_err("GATE-2 lock file held by another v6 process, exit")
        return 1

    try:
        # === GATE-3 dispatch quota（跨日重置立即落盘）===
        today = datetime.date.today().isoformat()
        quota = state.get('dispatch_count_today') or {'date': '', 'count': 0}
        if quota['date'] != today:
            quota = {'date': today, 'count': 0}
            state['dispatch_count_today'] = quota
            save_json_atomic(STATE, state)
        daily_limit = cfg['trigger'].get('dispatch_daily_limit', 3)
        if trigger == 'dispatch' and quota['count'] >= daily_limit:
            log_err(f"GATE-3 dispatch quota exhausted ({quota['count']}/{daily_limit}), exit")
            return 1

        # === GATE-4 活跃检测 ===
        if not force:
            if '<' in ESCAPED_HOME:
                # 占位符未替换 → 显式跳过并留痕，而不是静默失效（见文件头 NOTE）
                log_err("GATE-4 skipped: ESCAPED_HOME placeholder not configured (see NOTE at top of file)")
            else:
                mem = Path.home() / '.claude/projects' / ESCAPED_HOME / 'memory/MEMORY.md'
                if mem.exists():
                    diff_min = (time.time() - mem.stat().st_mtime) / 60
                    active_thresh = cfg['trigger'].get('active_detection_min', 30)
                    if diff_min < active_thresh:
                        log_err(f"GATE-4 user active {diff_min:.1f}min ago (<{active_thresh}min), exit")
                        return 0

        # === GATE-5 mode（已在 validate_config_schema 验过格式，此处 noop）===
        mode = cfg['execution']['mode']

        # === GATE-6 time-window（仅 scheduled）===
        hour = datetime.datetime.now().hour
        allowed = cfg['trigger'].get('scheduled_hours', [0, 4, 9])
        if trigger == 'scheduled' and hour not in allowed:
            log_err(f"GATE-6 hour={hour} not in {allowed}, exit (trigger={trigger})")
            return 0

        # === 全闸过 · 启动 claude headless ===
        session_id = str(uuid.uuid4())
        ts = datetime.datetime.now().strftime('%Y%m%d-%H%M')
        loop_started_claude = False  # 标记是否真启动了 claude（dispatch quota +1 的前提）

        # 加锁状态
        state['running'] = True
        state['current_run'] = {
            'session_id': session_id,
            'started_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'trigger': trigger,
            'pid': os.getpid(),
            'ts': ts,
            'mode': mode,
        }
        save_json_atomic(STATE, state)

        stream_log = V6 / f'loop-worklog/streams/{ts}-{trigger}.jsonl'
        stream_log.parent.mkdir(parents=True, exist_ok=True)

        env = os.environ.copy()
        # 加 bun 路径——telegram 插件用 bun 启动 server.ts，launchd 触发时 PATH 缩水可能找不到 bun（v6.1 fix）
        env['PATH'] = f"~/.bun/bin:/opt/homebrew/bin:{env.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')}"
        env['MAX_THINKING_TOKENS'] = str(cfg['execution']['max_thinking_tokens'])
        env['V6_LOOP_TRIGGER'] = trigger
        env['V6_LOOP_SESSION_ID'] = session_id
        env['V6_LOOP_MODE'] = mode
        env['V6_LOOP_TS'] = ts

        # 读 prompt 文件内容（B1 修复：不再用不存在的 --append-system-prompt-file）
        prompt_content = Path(cfg['paths']['loop_prompt']).read_text()

        cmd = [
            cfg['paths']['claude_bin'],
            '-p', (
                f'v6-loop 上岗 · trigger={trigger} · mode={mode} · session={session_id}\n\n'
                '按 system prompt 附加段（即 loop-prompt 内容）执行 5 步流程：'
                '扫 → 干 → 同步 → 写工作日志 → TG 通知 → 退。'
                '干满 20 分钟。'
            ),
            '--model', cfg['execution']['model'],
            '--effort', cfg['execution']['effort'],
            '--output-format', 'stream-json',
            '--include-partial-messages',
            '--verbose',
            '--dangerously-skip-permissions',
            '--setting-sources', 'user,project,local',
            '--add-dir', '~/.claude',
            '--add-dir', '~/.claude-brain',
            '--append-system-prompt', prompt_content,
            '--session-id', session_id,
        ]

        # 可选：headless `-p` 模式下 settings.json enabledPlugins 链路可能掉链，
        # 用 --plugin-dir 强挂插件目录更稳。部署时用 CLAUDE_PLUGIN_DIR 环境变量指定。
        plugin_dir = os.environ.get('CLAUDE_PLUGIN_DIR')
        if plugin_dir:
            cmd += ['--plugin-dir', plugin_dir]

        # Step 0 反向同步：当全局 live 或 reverse_sync 单独 live 时，把 dispatch memory 目录挂进来
        # （写 cc-daily-digest.md）。两者都不是 live → 写 /tmp/v6-loop-dryrun/，不挂 = 少给权限。
        # 注：Step 4.5 写日记报告在 ~/.claude 下，已被现有 --add-dir 覆盖，无需额外挂。
        reverse_sync_live = bool(cfg.get('live_actions', {}).get('reverse_sync'))
        if mode == 'live' or reverse_sync_live:
            # 部署时通过环境变量指到你的 Claude Code dispatch session memory 目录：
            # ~/Library/Application Support/Claude/local-agent-mode-sessions/<agent-uuid>/<session-uuid>/agent/memory
            dispatch_mem = os.environ.get('DISPATCH_MEMORY_DIR')
            if dispatch_mem:
                cmd += ['--add-dir', dispatch_mem]

        max_sec = cfg['execution'].get('max_duration_sec_hard_kill', 1800)
        exit_code = -1
        try:
            log_err(f"=== START trigger={trigger} mode={mode} session={session_id} ts={ts} timeout={max_sec}s ===")
            with open(stream_log, 'wb') as out, open(ERR_LOG, 'ab') as err:
                # B4 修复：用 Popen + setsid 创建进程组 · 超时 killpg 整组杀
                proc = subprocess.Popen(
                    cmd, env=env, stdout=out, stderr=err,
                    preexec_fn=os.setsid,
                )
                loop_started_claude = True
                try:
                    exit_code = proc.wait(timeout=max_sec)
                except subprocess.TimeoutExpired:
                    err.write(f"[{datetime.datetime.now().isoformat()}] HARD-KILL timeout after {max_sec}s, sending SIGTERM to process group\n".encode())
                    err.flush()
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    time.sleep(5)
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    exit_code = 124
            log_err(f"=== END trigger={trigger} session={session_id} exit={exit_code} stream={stream_log.name} ===")
        finally:
            # 解锁（无论怎么退出都要解）· 重新 load 防 race
            current_state = load_json_safe(STATE, default=initial_state())
            current_state['running'] = False
            current_state['last_run'] = current_state.get('current_run')
            current_state['current_run'] = None
            # I3 修复：dispatch quota 只在真启动了 claude 时 +1
            if trigger == 'dispatch' and loop_started_claude:
                today_now = datetime.date.today().isoformat()
                q = current_state.get('dispatch_count_today') or {'date': '', 'count': 0}
                if q['date'] != today_now:
                    q = {'date': today_now, 'count': 0}
                q['count'] += 1
                current_state['dispatch_count_today'] = q
            if exit_code != 0:
                current_state['consecutive_failures'] = current_state.get('consecutive_failures', 0) + 1
            else:
                current_state['consecutive_failures'] = 0
            current_state['history_count'] = current_state.get('history_count', 0) + 1
            try:
                save_json_atomic(STATE, current_state)
            except Exception as e:
                log_err(f"FATAL failed to save state on cleanup: {e}")

        return exit_code

    finally:
        # 释放 fcntl 锁（lock_fd 关闭即自动释放）
        try:
            fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
            lock_fd.close()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
