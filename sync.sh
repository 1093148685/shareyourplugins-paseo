#!/usr/bin/env bash
# 把本机 workplace 里的开发版插件同步进本仓库（排除 node_modules）。
# 用法:
#   ./sync.sh                 # 同步 SYNC_LIST 里的全部插件
#   ./sync.sh preset-switcher # 只同步指定插件
# 同步后照常 git add / commit / push。

set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKPLACE="$(dirname "$REPO_DIR")"

# 仓库里的插件 -> workplace 里的开发目录（一般同名）
SYNC_LIST=(preset-switcher server-monitor provider-switcher)

sync_one() {
  local name="$1"
  local src="$WORKPLACE/$name"
  local dst="$REPO_DIR/plugins/$name"
  if [[ ! -d "$src" ]]; then
    echo "⚠️  跳过 $name：$src 不存在" >&2
    return 1
  fi
  mkdir -p "$dst"
  # --delete 让仓库目录与开发目录严格一致（开发目录里删掉的文件也同步删除）
  tar --exclude=node_modules --exclude=.git --exclude='*.tmp' -cf - -C "$src" . | tar -xf - -C "$dst"
  echo "✅ $name 已同步 -> plugins/$name"
}

if [[ $# -gt 0 ]]; then
  for name in "$@"; do sync_one "$name"; done
else
  for name in "${SYNC_LIST[@]}"; do sync_one "$name"; done
fi

echo "提示: cd $REPO_DIR && git add -A && git commit -m \"update plugins\" && git push"
