/**
 * VersePC SSE 服务器 - 零外部依赖，纯 Node.js http 模块
 * 绕过 Electron IPC 序列化瓶颈，直接通过 HTTP+SSE 流式传输 AI 响应
 */

const http = require('http');

function createSSEServer(mainExports = {}) {
    const { executeTool = null } = mainExports;
    const BASE_PORT = 3001;
    const approvalPendingMap = {};

    // JSON 解析请求体
    function parseBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', c => { body += c; if (body.length > 10 * 1024 * 1024) req.destroy(); });
            req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve({}); } });
        });
    }

    // CORS 头
    function setCORS(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    const server = http.createServer(async (req, res) => {
        setCORS(res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204); res.end(); return;
        }

        const url = new URL(req.url, `http://localhost:${BASE_PORT}`);
        const pathname = url.pathname;

        // 健康检查
        if (req.method === 'GET' && pathname === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', port: BASE_PORT }));
            return;
        }

        // 工具审批
        if (req.method === 'POST' && pathname === '/api/chat/approve') {
            const body = await parseBody(req);
            const p = approvalPendingMap[body.approvalId];
            if (p) {
                clearTimeout(p.timeout);
                delete approvalPendingMap[body.approvalId];
                p.resolve({ approved: !!body.approved });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: !!p }));
            return;
        }

        // SSE 聊天流
        if (req.method === 'POST' && pathname === '/api/chat') {
            const body = await parseBody(req);
            const { apiKey, model = 'glm-5-flash', messages = [], temperature = 0.7, enableTools = true } = body;
            const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            if (!apiKey) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'API Key 未配置' }));
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*',
            });

            const heartbeat = setInterval(() => { res.write(': hb\n\n'); }, 30000);

            const cleanup = () => {
                clearInterval(heartbeat);
                Object.keys(approvalPendingMap).forEach(k => {
                    if (approvalPendingMap[k].chatId === chatId) {
                        approvalPendingMap[k].resolve({ approved: false, timeout: true });
                        delete approvalPendingMap[k];
                    }
                });
            };

            res.on('close', cleanup);

            let _resClosed = false;
            res.on('close', () => { _resClosed = true; });
            const sendChunk = (data) => {
                if (_resClosed) return;
                try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { _resClosed = true; }
            };

            const onChunk = (processed) => {
                if (!processed) return;
                if (processed.type && processed.type !== 'say') {
                    sendChunk(processed);
                    return;
                }
                sendChunk(processed);
            };

            const TOOL_RISK_MAP = {
                write_to_file: 'dangerous', replace_in_file: 'dangerous', delete_file: 'dangerous',
                execute_command: 'moderate', spawn_process: 'moderate',
                browser_action: 'moderate', mcp_tool: 'moderate',
                search_files: 'safe', list_files: 'safe', list_code_definition_names: 'safe',
                read_file: 'safe', ask_followup_question: 'safe', attempt_completion: 'safe',
                update_todo_list: 'safe', sequential_thinking: 'safe',
            };
            const onRequestApproval = (toolName, argsStr) => {
                const risk = TOOL_RISK_MAP[toolName] || 'moderate';
                const aid = `apv_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
                sendChunk({ type: 'approval_requested', approvalId: aid, toolName, risk, args: argsStr });
                return new Promise((resolve) => {
                    const t = setTimeout(() => {
                        if (approvalPendingMap[aid]) { delete approvalPendingMap[aid]; resolve({ approved: false, toolName, timeout: true }); }
                    }, 60000);
                    approvalPendingMap[aid] = { resolve, timeout: t, chatId };
                });
            };

            try {
                const { AgentEngine: EngineClass } = require('./agent-engine');
                const engine = new EngineClass({ executeTool, onRequestApproval, onChunk, logger: console });
                await engine.processChat({ apiKey, model, messages, temperature, enableTools, maxRounds: 24 });
            } catch (e) {
                sendChunk({ type: 'error', error: e.message });
            } finally {
                cleanup();
                try { res.end(); } catch (e) {}
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    function tryListen(port) {
        server.removeAllListeners('error');
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE' && port < BASE_PORT + 100) {
                console.log(`[SSE] 端口 ${port} 被占用，尝试 ${port + 1}`);
                tryListen(port + 1);
            } else {
                console.error(`[SSE] 启动失败:`, err.message);
            }
        });
        server.listen(port, () => {
            server._actualPort = port;
            console.log(`[SSE] 启动: http://localhost:${port}`);
        });
    }
    tryListen(BASE_PORT);
    return { server, get PORT() { return server._actualPort || BASE_PORT; } };
}

module.exports = { createSSEServer };