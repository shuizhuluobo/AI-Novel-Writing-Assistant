#!/usr/bin/env python3
"""
Ollama 简易监控面板
显示模型状态、Token 生成速度、支持简单对话测试
"""

import json
import time
import threading
from flask import Flask, render_template_string, request, jsonify
import urllib.request

app = Flask(__name__)
OLLAMA_URL = "http://localhost:11434"

# HTML 模板
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ollama 监控面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #1a1a2e; color: #eee; padding: 20px;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; color: #00d4aa; }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: #16213e;
            border-radius: 10px;
            padding: 15px;
            border: 1px solid #0f3460;
        }
        .stat-card h3 { color: #888; font-size: 12px; margin-bottom: 5px; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #00d4aa; }
        .stat-card .value.warning { color: #f39c12; }
        .stat-card .value.error { color: #e74c3c; }
        
        .chat-box {
            background: #16213e;
            border-radius: 10px;
            padding: 15px;
            border: 1px solid #0f3460;
            height: 400px;
            overflow-y: auto;
            margin-bottom: 15px;
        }
        .message { margin-bottom: 10px; padding: 10px; border-radius: 8px; }
        .message.user { background: #0f3460; margin-left: 20%; }
        .message.assistant { background: #1a1a2e; margin-right: 20%; border: 1px solid #0f3460; }
        .message .role { font-size: 11px; color: #888; margin-bottom: 5px; }
        .message .content { line-height: 1.5; }
        .message .tokens { font-size: 11px; color: #00d4aa; margin-top: 5px; }
        
        .input-area {
            display: flex;
            gap: 10px;
        }
        .input-area input {
            flex: 1;
            padding: 12px 15px;
            border: 1px solid #0f3460;
            border-radius: 8px;
            background: #16213e;
            color: #eee;
            font-size: 14px;
        }
        .input-area input:focus { outline: none; border-color: #00d4aa; }
        .input-area button {
            padding: 12px 25px;
            background: #00d4aa;
            border: none;
            border-radius: 8px;
            color: #1a1a2e;
            font-weight: bold;
            cursor: pointer;
        }
        .input-area button:hover { background: #00b894; }
        .input-area button:disabled { background: #555; cursor: not-allowed; }
        
        .status-bar {
            text-align: center;
            padding: 10px;
            font-size: 12px;
            color: #888;
        }
        .status-bar .dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 5px;
        }
        .status-bar .dot.online { background: #00d4aa; }
        .status-bar .dot.offline { background: #e74c3c; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Ollama 监控面板</h1>
        
        <div class="stats">
            <div class="stat-card">
                <h3>服务状态</h3>
                <div class="value" id="status">检测中...</div>
            </div>
            <div class="stat-card">
                <h3>已加载模型</h3>
                <div class="value" id="model-count">-</div>
            </div>
            <div class="stat-card">
                <h3>当前模型</h3>
                <div class="value" id="current-model" style="font-size: 14px;">-</div>
            </div>
            <div class="stat-card">
                <h3>生成速度</h3>
                <div class="value" id="speed">-</div>
            </div>
        </div>
        
        <div class="chat-box" id="chat-box">
            <div class="message assistant">
                <div class="role">系统</div>
                <div class="content">输入消息开始测试模型响应速度...</div>
            </div>
        </div>
        
        <div class="input-area">
            <input type="text" id="user-input" placeholder="输入消息测试模型..." 
                   onkeypress="if(event.key==='Enter') sendMessage()">
            <button onclick="sendMessage()" id="send-btn">发送</button>
        </div>
        
        <div class="status-bar">
            <span class="dot" id="status-dot"></span>
            <span id="status-text">连接中...</span>
        </div>
    </div>
    
    <script>
        let isGenerating = false;
        
        async function updateStats() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('status').textContent = data.online ? '在线' : '离线';
                document.getElementById('status').className = 'value ' + (data.online ? '' : 'error');
                document.getElementById('model-count').textContent = data.models.length;
                document.getElementById('current-model').textContent = data.running || '无';
                document.getElementById('speed').textContent = data.last_speed || '-';
                
                document.getElementById('status-dot').className = 'dot ' + (data.online ? 'online' : 'offline');
                document.getElementById('status-text').textContent = data.online ? '已连接到 Ollama' : '无法连接';
            } catch (e) {
                document.getElementById('status').textContent = '离线';
                document.getElementById('status-dot').className = 'dot offline';
            }
        }
        
        async function sendMessage() {
            const input = document.getElementById('user-input');
            const btn = document.getElementById('send-btn');
            const text = input.value.trim();
            if (!text || isGenerating) return;
            
            isGenerating = true;
            btn.disabled = true;
            input.value = '';
            
            // 添加用户消息
            const chatBox = document.getElementById('chat-box');
            chatBox.innerHTML += `<div class="message user">
                <div class="role">你</div>
                <div class="content">${text}</div>
            </div>`;
            
            // 添加等待响应
            const waitMsg = document.createElement('div');
            waitMsg.className = 'message assistant';
            waitMsg.innerHTML = `<div class="role">模型</div><div class="content">生成中...</div>`;
            chatBox.appendChild(waitMsg);
            chatBox.scrollTop = chatBox.scrollHeight;
            
            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({message: text})
                });
                const data = await res.json();
                
                if (data.error) {
                    waitMsg.querySelector('.content').textContent = '错误: ' + data.error;
                } else {
                    waitMsg.querySelector('.content').textContent = data.response;
                    waitMsg.innerHTML += `<div class="tokens">⚡ ${data.tokens_per_sec} tok/s | ${data.total_tokens} tokens | ${data.duration}s</div>`;
                    document.getElementById('speed').textContent = data.tokens_per_sec + ' tok/s';
                }
            } catch (e) {
                waitMsg.querySelector('.content').textContent = '请求失败: ' + e.message;
            }
            
            isGenerating = false;
            btn.disabled = false;
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        // 定期更新状态
        setInterval(updateStats, 3000);
        updateStats();
    </script>
</body>
</html>
"""

def ollama_request(path, data=None, timeout=120):
    """发送请求到 Ollama API"""
    url = f"{OLLAMA_URL}{path}"
    if data:
        req = urllib.request.Request(url, data=json.dumps(data).encode(), 
                                    headers={'Content-Type': 'application/json'})
    else:
        req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route('/api/status')
def status():
    """获取 Ollama 状态"""
    # 检查服务是否在线
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags")
        with urllib.request.urlopen(req, timeout=3) as resp:
            models_data = json.loads(resp.read())
        
        # 检查运行中的模型
        try:
            req2 = urllib.request.Request(f"{OLLAMA_URL}/api/ps")
            with urllib.request.urlopen(req2, timeout=3) as resp2:
                running_data = json.loads(resp2.read())
                running = running_data.get('models', [{}])[0].get('name', '无') if running_data.get('models') else '无'
        except:
            running = '无'
        
        return jsonify({
            "online": True,
            "models": [m['name'] for m in models_data.get('models', [])],
            "running": running,
            "last_speed": "-"
        })
    except:
        return jsonify({"online": False, "models": [], "running": "无"})

@app.route('/api/chat', methods=['POST'])
def chat():
    """发送聊天请求并测量速度"""
    data = request.json
    message = data.get('message', '')
    
    start_time = time.time()
    print(f"[{time.strftime('%H:%M:%S')}] Chat request: {message[:20]}...")
    
    payload = {
        "model": "openbmb/minicpm5:q4_K_M",
        "messages": [{"role": "user", "content": message}],
        "stream": False,
        "options": {"num_ctx": 2048}
    }
    
    req_start = time.time()
    result = ollama_request("/api/chat", payload, timeout=120)
    req_duration = time.time() - req_start
    print(f"[{time.strftime('%H:%M:%S')}] Ollama response in {req_duration:.2f}s")
    
    duration = time.time() - start_time
    
    if "error" in result:
        return jsonify({"error": result["error"]})
    
    eval_count = result.get('eval_count', 0)
    tokens_per_sec = round(eval_count / duration, 1) if duration > 0 else 0
    
    return jsonify({
        "response": result.get('message', {}).get('content', ''),
        "total_tokens": eval_count,
        "tokens_per_sec": tokens_per_sec,
        "duration": round(duration, 2)
    })

if __name__ == '__main__':
    print("=" * 50)
    print("Ollama 监控面板")
    print("=" * 50)
    print(f"访问地址: http://localhost:8999")
    print(f"Ollama: {OLLAMA_URL}")
    print("按 Ctrl+C 停止")
    print("=" * 50)
    app.run(host='0.0.0.0', port=8999, debug=False, threaded=True)
