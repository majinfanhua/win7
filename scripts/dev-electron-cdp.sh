#!/usr/bin/env bash
#
# 在 Linux 上用真实 Electron 22 / Chromium 108 跑起打包版渲染层，并开 CDP 调试端口。
#
# 为什么需要它：
#   5173 那条路是「浏览器 + 最新 Chrome + 内存桩」，看不到 preload / IPC / Chromium 108。
#   这个脚本加载的是**真实构建产物** out/renderer/index.html，跑在**真 Electron** 里，
#   所以能用来验证「Win7 上到底会怎样」——包括 CSS 在 108 下的真实解析结果。
#
# 用法：
#   bash scripts/dev-electron-cdp.sh [端口]        # 默认 9333
#
# 起来之后：
#   curl -s http://127.0.0.1:9333/json/version     # 看 Browser 版本
#   node /tmp/dbg/probe.mjs 9333                   # 探活（如果那个脚本还在）
#
# 停止：kill 掉进程，或 job_kill（后台任务形态）
#
# 环境说明：
#   - 容器 / root 下必须 --no-sandbox（chrome-sandbox 不是 setuid-root）
#   - /dev/shm 受限时必须 --disable-dev-shm-usage，否则 Chromium 会 SIGTRAP
#   - XDG_CONFIG_HOME 指到临时目录：不碰你真实的 ~/.config/AIEditor-dev，
#     也不会和已解压的打包版抢单实例锁
set -euo pipefail

PORT="${1:-9333}"
PROFILE_DIR="${XDG_DIR:-/tmp/electron-cdp-profile}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$ROOT/out/renderer/index.html" ]]; then
  echo "[cdp] 未找到构建产物，请先执行：npm run build" >&2
  exit 1
fi

ELECTRON_BIN="$ROOT/node_modules/electron/dist/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "[cdp] 未找到 Electron 二进制：$ELECTRON_BIN" >&2
  echo "[cdp] 请先执行 npm install" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "[cdp] Electron  : $ELECTRON_BIN"
echo "[cdp] 加载产物  : $ROOT/out/renderer/index.html"
echo "[cdp] CDP 端口  : $PORT"
echo "[cdp] 用户数据  : $PROFILE_DIR （隔离，不动 ~/.config/AIEditor-dev）"
echo "[cdp] 连上后试：curl -s http://127.0.0.1:$PORT/json/version"
echo

cd "$ROOT"
# 用 xvfb-run 造一个虚拟 X display —— 无头环境不给 DISPLAY，Electron 起不来
exec xvfb-run -a --server-args="-screen 0 1440x900x24" \
  env XDG_CONFIG_HOME="$PROFILE_DIR" \
  "$ELECTRON_BIN" \
  --remote-debugging-port="$PORT" \
  --no-sandbox \
  --disable-dev-shm-usage \
  .
