#!/bin/sh
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
BRAIN_DIR=${CLAUDE_BRAIN_DIR:-"$HOME/.claude-brain"}
BOOTSTRAP="$ROOT/plugins/pawin-brain/scripts/bootstrap-runtime.js"
COMMAND=${1:---install}

case "$COMMAND" in
  --install) ;;
  --uninstall)
    CLAUDE_BRAIN_DIR="$BRAIN_DIR" exec node "$ROOT/install-zcode-hooks.js" --uninstall
    ;;
  --help|-h)
    printf 'Usage: install-zcode-hooks.sh [--install|--uninstall]\n'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$COMMAND" >&2
    exit 1
    ;;
esac

runtime_files() {
  printf '%s\n' \
    scripts/inject-context.js \
    scripts/util.js \
    scripts/link-expand.js \
    scripts/track-behavior.js \
    scripts/capture-lesson.js \
    scripts/decay-lessons.js \
    scripts/efficacy.js \
    scripts/update-state.js \
    v2/scripts/stop-audit.js \
    v2/scripts/finish-the-work.js \
    v3/scripts/think-detect.js \
    v4/scripts/idea-loop-trigger.js \
    zcode-shim/record-prompt.js \
    zcode-shim/zcode-hook-router.js \
    zcode-shim/stop-transcript-bridge.js
}

canonicalize_destination() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    let current = path.resolve(process.argv[1]);
    const missing = [];
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      process.stderr.write(`Refusing symlinked Brain root: ${current}\n`);
      process.exit(1);
    }
    while (!fs.existsSync(current)) {
      missing.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
      process.stderr.write("Brain destination has no safe directory ancestor\n");
      process.exit(1);
    }
    process.stdout.write(path.join(fs.realpathSync(current), ...missing));
  ' "$1"
}

assert_no_symlink_under() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(process.argv[1]);
    const relative = process.argv[2] || "";
    let current = root;
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
      process.stderr.write(`Refusing unsafe install root: ${root}\n`);
      process.exit(1);
    }
    for (const segment of relative.split("/").filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && stat.isSymbolicLink()) {
        process.stderr.write(`Refusing symlinked install component: ${relative}\n`);
        process.exit(1);
      }
    }
  ' "$1" "$2"
}

BRAIN_DIR=$(canonicalize_destination "$BRAIN_DIR")
assert_no_symlink_under "$BRAIN_DIR" ""

for relative in $(runtime_files) plugins/pawin-brain/scripts/bootstrap-runtime.js
do
  source_file="$ROOT/$relative"
  assert_no_symlink_under "$ROOT" "$relative"
  if [ ! -f "$source_file" ] || [ -L "$source_file" ]; then
    printf 'Missing or unsafe package file: %s\n' "$source_file" >&2
    exit 1
  fi
done
for relative in $(runtime_files)
do
  assert_no_symlink_under "$BRAIN_DIR" "$relative"
done
assert_no_symlink_under "$BRAIN_DIR" "zcode-shim/sessions"

STAGE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pawin-zcode-stage.XXXXXX")
BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pawin-zcode-backup.XXXXXX")
INSTALLED_LIST="$BACKUP_DIR/installed-files"
COMMITTED=0
: > "$INSTALLED_LIST"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$COMMITTED" -eq 0 ] && [ -f "$INSTALLED_LIST" ]; then
    while IFS= read -r relative
    do
      [ -n "$relative" ] || continue
      target_file="$BRAIN_DIR/$relative"
      backup_file="$BACKUP_DIR/files/$relative"
      if [ -f "$backup_file" ]; then
        cp "$backup_file" "$target_file.rollback-$$"
        chmod 700 "$target_file.rollback-$$"
        mv -f "$target_file.rollback-$$" "$target_file"
      else
        rm -f -- "$target_file"
      fi
    done < "$INSTALLED_LIST"
  fi
  rm -rf -- "$STAGE_DIR" "$BACKUP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

CLAUDE_BRAIN_DIR="$STAGE_DIR" node "$BOOTSTRAP" --json >/dev/null
for relative in $(runtime_files)
do
  stage_file="$STAGE_DIR/$relative"
  mkdir -p "$(dirname "$stage_file")"
  chmod 700 "$(dirname "$stage_file")"
  cp "$ROOT/$relative" "$stage_file"
  chmod 700 "$stage_file"
done
mkdir -p "$STAGE_DIR/zcode-shim/sessions"
chmod 700 "$STAGE_DIR/zcode-shim/sessions"

SMOKE_OUTPUT=$(
  printf '%s' '{"session_id":"zcode-installer-stage","prompt":"检查 Brain 安装"}' |
    CLAUDE_BRAIN_DIR="$STAGE_DIR" CLAUDE_BRAIN_HOST=zcode BRAIN_DRY_RUN=1 \
      node "$STAGE_DIR/zcode-shim/zcode-hook-router.js" inject-context
)
printf '%s' "$SMOKE_OUTPUT" | node -e '
  const fs = require("fs");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("ZCode runtime smoke check returned invalid JSON\n");
    process.exit(1);
  }
  if (typeof value.additionalContext !== "string" ||
      !value.additionalContext.includes("<brain-context>")) {
    process.stderr.write("ZCode runtime smoke check returned no Brain context\n");
    process.exit(1);
  }
'

CLAUDE_BRAIN_DIR="$BRAIN_DIR" node "$BOOTSTRAP" --json >/dev/null
for relative in \
  . lessons state memory diary v2/data v3 v4 v5/ingested \
  v6/state v6/loop-worklog qmd/index
do
  assert_no_symlink_under "$BRAIN_DIR" "$relative"
  chmod 700 "$BRAIN_DIR/$relative"
done

for relative in $(runtime_files)
do
  source_file="$ROOT/$relative"
  target_file="$BRAIN_DIR/$relative"
  target_dir=$(dirname "$target_file")
  assert_no_symlink_under "$BRAIN_DIR" "$relative"
  mkdir -p "$target_dir"
  chmod 700 "$target_dir"
  if [ -e "$target_file" ] && [ "$source_file" -ef "$target_file" ]; then
    continue
  fi
  if [ -e "$target_file" ] && [ ! -f "$target_file" ]; then
    printf 'Refusing non-file runtime target: %s\n' "$target_file" >&2
    exit 1
  fi
  if [ -f "$target_file" ]; then
    backup_file="$BACKUP_DIR/files/$relative"
    mkdir -p "$(dirname "$backup_file")"
    cp "$target_file" "$backup_file"
    chmod 700 "$backup_file"
  fi
  printf '%s\n' "$relative" >> "$INSTALLED_LIST"
  temporary="$target_file.tmp-pawin-$$"
  cp "$STAGE_DIR/$relative" "$temporary"
  chmod 700 "$temporary"
  mv -f "$temporary" "$target_file"
done

assert_no_symlink_under "$BRAIN_DIR" "zcode-shim/sessions"
mkdir -p "$BRAIN_DIR/zcode-shim/sessions"
chmod 700 "$BRAIN_DIR/zcode-shim/sessions"

CLAUDE_BRAIN_DIR="$BRAIN_DIR" node "$ROOT/install-zcode-hooks.js" --install
COMMITTED=1
