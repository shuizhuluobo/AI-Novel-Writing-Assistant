#!/usr/bin/env bash
#
# 启动前后端开发服务。
#
# 默认端口：后端 39001，前端 39002（可用 PORT / CLIENT_PORT 覆盖）。
# 启动前会检查这两个端口，被占用就先结束占用进程，保证每次都能顺利起来。
#
# 用法：
#   ./dev.sh                 启动后端 + 前端（dev 模式，带热重载）
#   ./dev.sh --prod          用构建产物启动（后端 dist + 前端 vite preview）
#   ./dev.sh --only api      只启动后端
#   ./dev.sh --only web      只启动前端
#   ./dev.sh --watch-shared  同时监听 shared 包改动并增量编译
#   ./dev.sh --no-kill       端口被占用时不结束进程，直接退出
#   ./dev.sh --no-follow     启动完成后不跟随日志（适合脚本调用）
#   ./dev.sh --skip-build    --prod 模式下跳过构建
#   ./dev.sh --help          查看帮助
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/.tmp/dev-logs"
API_PID=""
WEB_PID=""
SHARED_PID=""
TAIL_PID=""

MODE="dev"
TARGET="all"
ALLOW_KILL=1
WATCH_SHARED=0
FOLLOW_LOGS=1
SKIP_BUILD=0

C_RESET=$'\033[0m'
C_BLUE=$'\033[34m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_RED=$'\033[31m'

log() { printf '%s[dev.sh]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok() { printf '%s[dev.sh]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[dev.sh]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '%s[dev.sh]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

usage() {
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# ---------------------------------------------------------------------------
# 参数与端口
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod) MODE="prod"; shift ;;
    --only)
      TARGET="${2:-all}"
      [[ "$TARGET" == "api" || "$TARGET" == "web" || "$TARGET" == "all" ]] || die "--only 只支持 api / web / all"
      shift 2
      ;;
    --watch-shared) WATCH_SHARED=1; shift ;;
    --no-kill) ALLOW_KILL=0; shift ;;
    --no-follow) FOLLOW_LOGS=0; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h | --help) usage ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" "$file" | tail -n 1 | tr -d '\r'
}

SERVER_PORT="${PORT:-}"
[[ -z "$SERVER_PORT" ]] && SERVER_PORT="$(read_env_value "$REPO_ROOT/server/.env" PORT)"
[[ -z "$SERVER_PORT" ]] && SERVER_PORT=39001

CLIENT_PORT="${CLIENT_PORT:-}"
[[ -z "$CLIENT_PORT" ]] && CLIENT_PORT="$(read_env_value "$REPO_ROOT/client/.env" CLIENT_PORT)"
[[ -z "$CLIENT_PORT" ]] && CLIENT_PORT=39002

# 导出给子进程：前端 dev / preview 用 PORT 决定 /api 代理目标，用 CLIENT_PORT 决定监听端口。
export PORT="$SERVER_PORT"
export CLIENT_PORT="$CLIENT_PORT"

# Qdrant 端口（章节生成上下文检索用，仅 RAG 启用时需要）
QDRANT_PORT="${QDRANT_PORT:-6333}"
export QDRANT_PORT

# ---------------------------------------------------------------------------
# 端口占用处理
# ---------------------------------------------------------------------------

port_pids() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    local pids
    pids="$(ss -H -ltnp 2>/dev/null | grep -E "[:.]${port}[[:space:]]" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' ')"
    [[ -n "$pids" ]] && { echo "$pids" | tr -s ' '; return 0; }
  fi

  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti "tcp:${port}" 2>/dev/null | sort -u | tr '\n' ' ')"
    [[ -n "$pids" ]] && { echo "$pids" | tr -s ' '; return 0; }
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" 2>/dev/null | tr -s ' '
    return 0
  fi

  echo ""
}

kill_port() {
  local port="$1" pids attempt

  pids="$(port_pids "$port")"
  [[ -z "${pids// /}" ]] && return 0

  if [[ "$ALLOW_KILL" -ne 1 ]]; then
    die "端口 $port 被占用（pid: ${pids}），已指定 --no-kill，退出。"
  fi

  log "端口 $port 被占用（pid: ${pids}），正在结束进程..."
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true

  for attempt in $(seq 1 16); do
    sleep 0.5
    [[ -z "$(port_pids "$port" | tr -d ' ')" ]] && break
  done

  pids="$(port_pids "$port")"
  if [[ -n "${pids// /}" ]]; then
    warn "进程未响应 SIGTERM，强制结束（pid: ${pids}）"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 1
  fi

  if [[ -n "$(port_pids "$port" | tr -d ' ')" ]]; then
    die "端口 $port 仍被占用，请手动处理：ss -ltnp | grep ${port}"
  fi

  ok "端口 $port 已释放"
}

# ---------------------------------------------------------------------------
# 服务启停
# ---------------------------------------------------------------------------

wait_for_url() {
  local url="$1" timeout="$2" deadline
  deadline=$((SECONDS + timeout))

  while ((SECONDS < deadline)); do
    if curl -sf -o /dev/null -m 3 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}

start_api() {
  log "启动后端（端口 $SERVER_PORT，模式 $MODE）..."
  if [[ "$MODE" == "prod" ]]; then
    pnpm --filter @ai-novel/server start >>"$LOG_DIR/api.log" 2>&1 &
  else
    pnpm --filter @ai-novel/server dev >>"$LOG_DIR/api.log" 2>&1 &
  fi
  API_PID=$!

  if ! wait_for_url "http://127.0.0.1:${SERVER_PORT}/api/health" 180; then
    warn "后端健康检查超时，日志尾部："
    tail -n 30 "$LOG_DIR/api.log" >&2 || true
    die "后端启动失败，查看完整日志：tail -f $LOG_DIR/api.log"
  fi
  ok "后端已就绪：http://localhost:${SERVER_PORT}"
}

start_web() {
  log "启动前端（端口 $CLIENT_PORT，模式 $MODE）..."
  if [[ "$MODE" == "prod" ]]; then
    pnpm --filter @ai-novel/client preview >>"$LOG_DIR/web.log" 2>&1 &
  else
    pnpm --filter @ai-novel/client dev >>"$LOG_DIR/web.log" 2>&1 &
  fi
  WEB_PID=$!

  if ! wait_for_url "http://127.0.0.1:${CLIENT_PORT}/" 120; then
    warn "前端启动超时，日志尾部："
    tail -n 30 "$LOG_DIR/web.log" >&2 || true
    die "前端启动失败，查看完整日志：tail -f $LOG_DIR/web.log"
  fi
  ok "前端已就绪：http://localhost:${CLIENT_PORT}"
}

ensure_qdrant() {
  if [[ "$TARGET" != "all" && "$TARGET" != "api" ]]; then
    return 0
  fi
  log "检查 Qdrant（章节生成上下文检索用）..."
  node "$REPO_ROOT/scripts/qdrant.cjs" ensure 2>&1 | sed 's/^/[qdrant] /' || \
    warn "Qdrant 启动失败：章节生成会缺少检索上下文（可在 server/.env 设 RAG_ENABLED=false 关闭）。"
}

cleanup() {
  trap - INT TERM EXIT

  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null || true
  fi
  for pid in "$API_PID" "$WEB_PID" "$SHARED_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done

  # 兜底：确保端口上没有残留进程
  local ports=("$SERVER_PORT" "$CLIENT_PORT")
  if [[ "$TARGET" == "all" || "$TARGET" == "api" ]]; then
    ports+=("$QDRANT_PORT")
  fi
  for port in "${ports[@]}"; do
    local pids
    pids="$(port_pids "$port")"
    if [[ -n "${pids// /}" ]]; then
      # shellcheck disable=SC2086
      kill -TERM $pids 2>/dev/null || true
    fi
  done

  log "已停止前后端服务。"
  exit 0
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm，请先安装（Node >= 20 可用 corepack enable 启用）。"
command -v curl >/dev/null 2>&1 || die "未找到 curl，请先安装。"

mkdir -p "$LOG_DIR"
: >"$LOG_DIR/api.log"
: >"$LOG_DIR/web.log"

if [[ "$TARGET" == "all" || "$TARGET" == "api" ]]; then
  kill_port "$SERVER_PORT"
fi
if [[ "$TARGET" == "all" || "$TARGET" == "web" ]]; then
  kill_port "$CLIENT_PORT"
fi

ensure_qdrant

log "构建 shared 包（前后端共用类型与协议）..."
pnpm --filter @ai-novel/shared build || die "shared 构建失败。"

if [[ "$WATCH_SHARED" -eq 1 ]]; then
  pnpm --filter @ai-novel/shared dev >>"$LOG_DIR/shared.log" 2>&1 &
  SHARED_PID=$!
  log "shared 监听已启动（日志 $LOG_DIR/shared.log）"
fi

if [[ "$MODE" == "prod" ]]; then
  if [[ "$SKIP_BUILD" -ne 1 ]]; then
    log "构建后端与前端产物..."
    pnpm --filter @ai-novel/server build || die "后端构建失败。"
    pnpm --filter @ai-novel/client build || die "前端构建失败。"
  fi
fi

trap cleanup INT TERM EXIT

[[ "$TARGET" == "all" || "$TARGET" == "api" ]] && start_api
[[ "$TARGET" == "all" || "$TARGET" == "web" ]] && start_web

ok "访问地址：http://localhost:${CLIENT_PORT}（后端 API：http://localhost:${SERVER_PORT}）"
log "日志：$LOG_DIR/api.log、$LOG_DIR/web.log"

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
  tail -f "$LOG_DIR/api.log" "$LOG_DIR/web.log" &
  TAIL_PID=$!
  wait "$TAIL_PID"
else
  log "已后台启动（pid：api=${API_PID:-未启动} web=${WEB_PID:-未启动}），用 deploy:stop 或按端口结束进程即可停止。"
fi
