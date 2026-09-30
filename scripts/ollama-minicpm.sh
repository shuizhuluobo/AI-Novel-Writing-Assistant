#!/bin/bash
# Ollama + MiniCPM5-1B 启动脚本
# 用于 AI 小说创作工作台的本地模型支持

set -e

OLLAMA_DIR="${HOME}/.ollama"
MODEL_NAME="openbmb/minicpm5:q4_K_M"
SERVICE_NAME="ollama-minicpm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 Ollama 是否已安装
check_ollama() {
    if ! command -v ollama &> /dev/null; then
        log_error "Ollama 未安装，请先安装 Ollama"
        echo "安装命令: curl -fsSL https://ollama.com/install.sh | sh"
        exit 1
    fi
    log_info "Ollama 已安装: $(ollama --version 2>/dev/null | head -1)"
}

# 启动 Ollama 服务
start_ollama() {
    # 检查是否已在运行
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        log_info "Ollama 服务已在运行"
        return 0
    fi

    log_info "启动 Ollama 服务..."

    # 配置环境变量
    export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"
    export OLLAMA_MODELS="${OLLAMA_DIR}/models"
    export OLLAMA_FLASH_ATTENTION=1
    export OLLAMA_KV_CACHE_TYPE=q8_0

    # 创建模型目录
    mkdir -p "$OLLAMA_MODELS"

    # 后台启动 Ollama
    nohup ollama serve > "${OLLAMA_DIR}/ollama.log" 2>&1 &
    OLLAMA_PID=$!
    echo $OLLAMA_PID > "${OLLAMA_DIR}/ollama.pid"

    # 等待服务就绪
    for i in $(seq 1 30); do
        if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
            log_info "Ollama 服务启动成功 (PID: $OLLAMA_PID)"
            return 0
        fi
        sleep 1
    done

    log_error "Ollama 服务启动超时"
    exit 1
}

# 拉取 MiniCPM5 模型
pull_model() {
    log_info "检查模型: ${MODEL_NAME}"

    # 检查模型是否已存在
    if ollama list 2>/dev/null | grep -q "minicpm5"; then
        log_info "MiniCPM5 模型已存在"
        return 0
    fi

    log_info "拉取 MiniCPM5-1B 模型 (约 688MB)..."
    echo "这可能需要几分钟，取决于网络速度..."

    if ollama pull "$MODEL_NAME"; then
        log_info "模型拉取成功"
    else
        log_error "模型拉取失败，请检查网络连接"
        exit 1
    fi
}

# 启动监控面板
start_panel() {
    # 检查面板是否已在运行
    if curl -s http://localhost:8999/api/status > /dev/null 2>&1; then
        log_info "监控面板已在运行"
        return 0
    fi

    log_info "启动监控面板..."

    # 启动面板
    cd "$PROJECT_DIR"
    nohup python3 scripts/ollama-panel.py > "${OLLAMA_DIR}/panel.log" 2>&1 &
    PANEL_PID=$!
    echo $PANEL_PID > "${OLLAMA_DIR}/panel.pid"

    # 等待面板就绪
    for i in $(seq 1 10); do
        if curl -s http://localhost:8999/api/status > /dev/null 2>&1; then
            log_info "监控面板启动成功 (PID: $PANEL_PID)"
            return 0
        fi
        sleep 1
    done

    log_warn "监控面板启动超时"
    return 1
}

# 停止监控面板
stop_panel() {
    if [ -f "${OLLAMA_DIR}/panel.pid" ]; then
        PID=$(cat "${OLLAMA_DIR}/panel.pid")
        if kill -0 "$PID" 2>/dev/null; then
            log_info "停止监控面板 (PID: $PID)..."
            kill "$PID" 2>/dev/null || true
            rm -f "${OLLAMA_DIR}/panel.pid"
        else
            rm -f "${OLLAMA_DIR}/panel.pid"
        fi
    fi
    # 确保清理
    pkill -f "ollama-panel.py" 2>/dev/null || true
}

# 停止 Ollama 服务
stop_ollama() {
    if [ -f "${OLLAMA_DIR}/ollama.pid" ]; then
        PID=$(cat "${OLLAMA_DIR}/ollama.pid")
        if kill -0 "$PID" 2>/dev/null; then
            log_info "停止 Ollama 服务 (PID: $PID)..."
            kill "$PID" 2>/dev/null || true
            rm -f "${OLLAMA_DIR}/ollama.pid"
            log_info "Ollama 服务已停止"
        else
            log_warn "Ollama 进程不存在"
            rm -f "${OLLAMA_DIR}/ollama.pid"
        fi
    else
        # 尝试通过端口查找
        PID=$(lsof -ti:11434 2>/dev/null || true)
        if [ -n "$PID" ]; then
            log_info "停止 Ollama 服务 (PID: $PID)..."
            kill $PID 2>/dev/null || true
            log_info "Ollama 服务已停止"
        else
            log_warn "Ollama 服务未运行"
        fi
    fi
}

# 显示状态
status() {
    echo "=== Ollama + MiniCPM5 状态 ==="
    echo ""

    # 检查服务状态
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo -e "服务状态: ${GREEN}运行中${NC}"
    else
        echo -e "服务状态: ${RED}未运行${NC}"
    fi

    # 显示已安装模型
    echo ""
    echo "已安装模型:"
    ollama list 2>/dev/null || echo "  无法获取模型列表"

    # 显示面板状态
    echo ""
    if curl -s http://localhost:8999/api/status > /dev/null 2>&1; then
        echo -e "监控面板: ${GREEN}运行中${NC} (http://localhost:8999)"
    else
        echo -e "监控面板: ${RED}未运行${NC}"
    fi

    # 显示配置
    echo ""
    echo "配置信息:"
    echo "  API 地址: http://localhost:11434"
    echo "  OpenAI 兼容地址: http://localhost:11434/v1"
    echo "  监控面板: http://localhost:8999"
    echo "  模型目录: ${OLLAMA_DIR}/models"
    echo "  日志文件: ${OLLAMA_DIR}/ollama.log"
}

# 测试模型
test_model() {
    log_info "测试 MiniCPM5 模型..."

    RESPONSE=$(curl -s http://localhost:11434/api/chat -d '{
        "model": "openbmb/minicpm5:q4_K_M",
        "messages": [{"role": "user", "content": "你好，请用一句话介绍你自己"}],
        "stream": false
    }' 2>/dev/null)

    if echo "$RESPONSE" | grep -q "message"; then
        echo ""
        echo "模型回复:"
        echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('message', {}).get('content', '无回复'))
" 2>/dev/null || echo "$RESPONSE"
        echo ""
        log_info "模型测试成功!"
    else
        log_error "模型测试失败"
        echo "响应: $RESPONSE"
        return 1
    fi
}

# 主逻辑
case "${1:-start}" in
    start)
        check_ollama
        start_ollama
        pull_model
        start_panel
        echo ""
        log_info "Ollama + MiniCPM5 已就绪!"
        echo ""
        echo "API 地址: http://localhost:11434"
        echo "OpenAI 兼容地址: http://localhost:11434/v1"
        echo "监控面板: http://localhost:8999"
        echo ""
        echo "在 AI 小说创作工作台中配置:"
        echo "  Provider: 自定义"
        echo "  Base URL: http://localhost:11434/v1"
        echo "  Model: openbmb/minicpm5:q4_K_M"
        ;;
    stop)
        stop_panel
        stop_ollama
        ;;
    restart)
        stop_panel
        stop_ollama
        sleep 2
        check_ollama
        start_ollama
        start_panel
        ;;
    status)
        status
        ;;
    test)
        test_model
        ;;
    panel)
        start_panel
        echo ""
        log_info "监控面板已启动: http://localhost:8999"
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status|test|panel}"
        echo ""
        echo "命令:"
        echo "  start   启动 Ollama 服务、模型和监控面板"
        echo "  stop    停止所有服务"
        echo "  restart 重启所有服务"
        echo "  status  显示状态信息"
        echo "  test    测试模型"
        echo "  panel   仅启动监控面板"
        exit 1
        ;;
esac
