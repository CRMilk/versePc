/**
 * VersePC SSE 服务器 - 零外部依赖，纯 Node.js http 模块
 * 绕过 Electron IPC 序列化瓶颈，直接通过 HTTP+SSE 流式传输 AI 响应
 */

const http = require('http');

function createSSEServer(mainExports = {}) {
    const { executeTool = null } = mainExports;
    const PORT = 3001;
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

        const url = new URL(req.url, `http://localhost:${PORT}`);
        const pathname = url.pathname;

        // 健康检查
        if (req.method === 'GET' && pathname === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', port: PORT }));
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

            const sendChunk = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

            const requestApproval = (toolName, args) => {
                const aid = `apv_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 6)}`;
                sendChunk({ type: 'approval_requested', approvalId: aid, toolName, args });
                return new Promise((resolve) => {
                    const t = setTimeout(() => {
                        if (approvalPendingMap[aid]) { delete approvalPendingMap[aid]; resolve({ approved: false, toolName, timeout: true }); }
                    }, 60000);
                    approvalPendingMap[aid] = { resolve, timeout: t, chatId };
                });
            };

            try {
                const { AIEngine: EngineClass } = require('./agent-engine');
                const engine = new EngineClass({ executeTool, requestApproval, sendChunk, logger: console });
                await engine.processChat({ apiKey, model, messages, temperature, enableTools, maxRounds: 24 });
            } catch (e) {
                sendChunk({ type: 'error', error: e.message });
            } finally {
                cleanup();
                res.end();
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(PORT, () => console.log(`[SSE] 启动: http://localhost:${PORT}`));
    return { server, PORT };
}

module.exports = { createSSEServer };