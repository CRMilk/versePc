/**
 * VersePC Agent Engine (基于 Roo Code 架构模式 + 全部智能功能)
 * 
 * 核心设计：
 * 1. 状态机驱动：IDLE → RUNNING → STREAMING → ACTING → OBSERVING → REFLECTING → DONE
 * 2. 增量流式输出：仅发送新字符，消息去重 (OutputManager)
 * 3. 事件驱动：统一 say/ask 消息格式
 * 4. 全功能保留：意图检测、计划生成、卡死检测、反思、被动检测、并行工具、进度轮询
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// =============================================================================
// Agent State Machine
// =============================================================================

const AgentState = {
    IDLE: 'idle',
    RUNNING: 'running',
    STREAMING: 'streaming',
    ACTING: 'acting',
    OBSERVING: 'observing',
    REFLECTING: 'reflecting',
    RESPONDING: 'responding',
    WAITING_FOR_INPUT: 'waiting_for_input',
    DONE: 'done',
    STUCK: 'stuck',
    ERROR: 'error'
};

const SayType = {
    TEXT: 'text',
    REASONING: 'reasoning',
    TOOL_START: 'tool_start',
    TOOL_RESULT: 'tool_result',
    TOOL_END: 'tool_end',
    ERROR: 'error',
    COMPLETION: 'completion',
    API_STARTED: 'api_req_started',
    API_FINISHED: 'api_req_finished',
    FOLLOWUP: 'followup',
    PLAN_CREATED: 'plan_created',
    PLAN_STEP_UPDATE: 'plan_step_update',
    PLAN_DONE: 'plan_done',
    THINKING_STEP: 'thinking_step',
    REFLECTION: 'reflection',
    PROGRESS: 'progress'
};

const AskType = {
    TOOL_APPROVAL: 'tool_approval',
    FOLLOWUP: 'followup'
};

// =============================================================================
// Output Manager (增量输出 + 去重)
// =============================================================================

class OutputManager {
    constructor() {
        this.displayedMessages = new Map();
        this.streamedContent = new Map();
        this.currentlyStreamingTs = null;
        this.tsCounter = 0;
    }

    _nextTs() { return ++this.tsCounter; }

    _streamDelta(ts, text) {
        const previous = this.streamedContent.get(ts);
        if (!previous) {
            this.streamedContent.set(ts, { text, headerShown: true });
            this.currentlyStreamingTs = ts;
            return { action: 'full', text };
        }
        if (text.length > previous.text.length && text.startsWith(previous.text)) {
            const delta = text.slice(previous.text.length);
            this.streamedContent.set(ts, { text, headerShown: true });
            return { action: 'delta', text: delta };
        }
        return { action: 'skip' };
    }

    _finishStream(ts) {
        if (this.currentlyStreamingTs === ts) {
            this.currentlyStreamingTs = null;
        }
    }

    processMessage(msg) {
        const text = msg.text || '';
        const isPartial = msg.partial === true;
        let ts;

        if (isPartial && msg.type === 'say' && (msg.say === SayType.TEXT || msg.say === SayType.REASONING || msg.say === SayType.COMPLETION)) {
            if (this.currentlyStreamingTs) {
                const activeMsg = this.displayedMessages.get(this.currentlyStreamingTs);
                if (activeMsg && activeMsg.say === msg.say && activeMsg.partial) {
                    ts = this.currentlyStreamingTs;
                } else {
                    ts = this._nextTs();
                }
            } else {
                ts = this._nextTs();
            }
        } else {
            if (!isPartial && msg.type === 'say' && this.currentlyStreamingTs) {
                const activeMsg = this.displayedMessages.get(this.currentlyStreamingTs);
                if (activeMsg && activeMsg.say === msg.say) {
                    ts = this.currentlyStreamingTs;
                } else {
                    ts = msg.ts || this._nextTs();
                }
            } else {
                ts = msg.ts || this._nextTs();
            }
        }

        const previous = this.displayedMessages.get(ts);
        const alreadyComplete = previous && !previous.partial;

        if (msg.type === 'say') {
            return this._processSay(ts, msg.say, text, isPartial, alreadyComplete, msg);
        }
        if (msg.type === 'ask') {
            return this._processAsk(ts, msg.ask, text, isPartial, alreadyComplete, msg);
        }
        return null;
    }

    _processSay(ts, say, text, isPartial, alreadyComplete, msg) {
        switch (say) {
            case SayType.TEXT:
            case SayType.REASONING:
            case SayType.COMPLETION:
                if (isPartial && text) {
                    const delta = this._streamDelta(ts, text);
                    this.displayedMessages.set(ts, { ts, text, partial: true });
                    return { type: 'say', say, ts, text: delta.text, partial: true, delta: delta.action === 'delta' };
                }
                if (!isPartial && !alreadyComplete) {
                    const streamed = this.streamedContent.get(ts);
                    if (streamed && text && text.length > streamed.text.length && text.startsWith(streamed.text)) {
                        const remaining = text.slice(streamed.text.length);
                        this._finishStream(ts);
                        this.displayedMessages.set(ts, { ts, text, partial: false });
                        return { type: 'say', say, ts, text: remaining, partial: false, trailing: true };
                    }
                    this._finishStream(ts);
                    this.displayedMessages.set(ts, { ts, text, partial: false });
                    return { type: 'say', say, ts, text: text || '', partial: false };
                }
                break;

            case SayType.TOOL_START:
            case SayType.TOOL_RESULT:
            case SayType.TOOL_END:
            case SayType.ERROR:
            case SayType.PLAN_CREATED:
            case SayType.PLAN_STEP_UPDATE:
            case SayType.PLAN_DONE:
            case SayType.THINKING_STEP:
            case SayType.REFLECTION:
            case SayType.PROGRESS:
                this.displayedMessages.set(ts, { ts, text, partial: false });
                return { type: 'say', say, ts, text, partial: false };

            case SayType.API_STARTED:
                this.displayedMessages.set(ts, { ts, text, partial: true });
                return null;

            case SayType.API_FINISHED:
            case SayType.FOLLOWUP:
                this.displayedMessages.set(ts, { ts, text, partial: false });
                return { type: 'say', say, ts, text, partial: false };
        }
        return null;
    }

    _processAsk(ts, ask, text, isPartial, alreadyComplete, fullMsg) {
        this.displayedMessages.set(ts, { ts, text, partial: false });
        return { type: 'ask', ask, ts, text, partial: false, args: fullMsg.args, toolName: fullMsg.toolName, risk: fullMsg.risk };
    }

    clear() {
        this.displayedMessages.clear();
        this.streamedContent.clear();
        this.currentlyStreamingTs = null;
        this.tsCounter = 0;
    }
}

// =============================================================================
// AI Platform & Provider 配置（所有平台）
// =============================================================================
// 结构：
//   PLATFORMS: providerKey → { name, baseUrl, authType, apiFormat, thinkingParams }
//   MODELS: modelId → { provider, name, free }
//
// apiFormat 可选值：'openai'(默认) | 'anthropic' | 'google'
// authType 可选值：'bearer'(默认) | 'x-api-key' | 'url_key'

const PLATFORMS = {
    zhipu: {
        name: '智谱 GLM',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    deepseek: {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: { enable_thinking: true }
    },
    qwen: {
        name: '通义千问',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: { enable_thinking: true }
    },
    moonshot: {
        name: 'Moonshot Kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    yi: {
        name: '零一万物',
        baseUrl: 'https://api.lingyiwanwu.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    baichuan: {
        name: '百川智能',
        baseUrl: 'https://api.baichuan-ai.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    minimax: {
        name: 'MiniMax',
        baseUrl: 'https://api.minimax.chat/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    stepfun: {
        name: '阶跃星辰',
        baseUrl: 'https://api.stepfun.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    siliconflow: {
        name: 'SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: { enable_thinking: true }
    },
    openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: { enable_thinking: true }
    },
    groq: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    openai: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    anthropic: {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        authType: 'x-api-key',
        apiFormat: 'anthropic',
        thinkingParams: {}
    },
    google: {
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        authType: 'url_key',
        apiFormat: 'google',
        thinkingParams: {}
    }
};

const MODELS = {
    // 智谱 GLM
    'glm-5.1': { provider: 'zhipu', name: 'GLM-5.1' },
    'glm-5': { provider: 'zhipu', name: 'GLM-5' },
    'glm-5-plus': { provider: 'zhipu', name: 'GLM-5-Plus' },
    'glm-5-air': { provider: 'zhipu', name: 'GLM-5-Air' },
    'glm-5-flash': { provider: 'zhipu', name: 'GLM-5-Flash', free: true },
    'glm-4.7': { provider: 'zhipu', name: 'GLM-4.7' },
    // DeepSeek
    'deepseek-v4-pro': { provider: 'deepseek', name: 'DeepSeek-V4-Pro' },
    'deepseek-v4-flash': { provider: 'deepseek', name: 'DeepSeek-V4-Flash' },
    'deepseek-chat': { provider: 'deepseek', name: 'DeepSeek-V3.2' },
    'deepseek-reasoner': { provider: 'deepseek', name: 'DeepSeek-R1' },
    // 通义千问
    'qwen3.6-max-preview': { provider: 'qwen', name: 'Qwen3.6-Max' },
    'qwen3.6-plus': { provider: 'qwen', name: 'Qwen3.6-Plus' },
    'qwen3.6-flash': { provider: 'qwen', name: 'Qwen3.6-Flash', free: true },
    'qwen3-235b-a22b': { provider: 'qwen', name: 'Qwen3-235B' },
    'qwen3-30b-a3b': { provider: 'qwen', name: 'Qwen3-30B', free: true },
    'qwq-plus': { provider: 'qwen', name: 'QwQ-Plus' },
    // Moonshot Kimi
    'kimi-k2.6': { provider: 'moonshot', name: 'Kimi-K2.6' },
    'kimi-k2.5': { provider: 'moonshot', name: 'Kimi-K2.5' },
    'moonshot-v1-128k': { provider: 'moonshot', name: 'Moonshot-v1-128k' },
    'moonshot-v1-32k': { provider: 'moonshot', name: 'Moonshot-v1-32k' },
    // 零一万物 Yi
    'yi-lightning': { provider: 'yi', name: 'Yi-Lightning', free: true },
    'yi-large': { provider: 'yi', name: 'Yi-Large' },
    'yi-large-turbo': { provider: 'yi', name: 'Yi-Large-Turbo' },
    'yi-medium': { provider: 'yi', name: 'Yi-Medium' },
    // 百川
    'Baichuan4-Turbo': { provider: 'baichuan', name: 'Baichuan4-Turbo' },
    'Baichuan4-Air': { provider: 'baichuan', name: 'Baichuan4-Air' },
    'Baichuan4': { provider: 'baichuan', name: 'Baichuan4' },
    'Baichuan3-Turbo': { provider: 'baichuan', name: 'Baichuan3-Turbo' },
    // MiniMax
    'MiniMax-M2.7': { provider: 'minimax', name: 'MiniMax-M2.7' },
    'MiniMax-M2.5': { provider: 'minimax', name: 'MiniMax-M2.5' },
    'MiniMax-M2.1': { provider: 'minimax', name: 'MiniMax-M2.1' },
    // 阶跃星辰
    'step-2-16k': { provider: 'stepfun', name: 'Step-2-16K' },
    'step-1-8k': { provider: 'stepfun', name: 'Step-1-8K', free: true },
    // SiliconFlow
    'Pro/deepseek-ai/DeepSeek-V4-Pro': { provider: 'siliconflow', name: 'DeepSeek-V4-Pro' },
    'deepseek-ai/DeepSeek-V4-Flash': { provider: 'siliconflow', name: 'DeepSeek-V4-Flash', free: true },
    'Qwen/Qwen3-235B-A22B': { provider: 'siliconflow', name: 'Qwen3-235B', free: true },
    'Qwen/Qwen3-30B-A3B': { provider: 'siliconflow', name: 'Qwen3-30B', free: true },
    'Qwen/Qwen3.6-Flash': { provider: 'siliconflow', name: 'Qwen3.6-Flash', free: true },
    'Pro/zai-org/GLM-5.1': { provider: 'siliconflow', name: 'GLM-5.1', free: true },
    // OpenRouter
    'deepseek/deepseek-v4-pro': { provider: 'openrouter', name: 'DeepSeek V4 Pro' },
    'deepseek/deepseek-v4-flash:free': { provider: 'openrouter', name: 'DeepSeek V4 Flash', free: true },
    'qwen/qwen3-235b-a22b': { provider: 'openrouter', name: 'Qwen3 235B' },
    'google/gemini-2.5-flash': { provider: 'openrouter', name: 'Gemini 2.5 Flash', free: true },
    'anthropic/claude-sonnet-4-6': { provider: 'openrouter', name: 'Claude Sonnet 4.6' },
    'anthropic/claude-3.5-sonnet': { provider: 'openrouter', name: 'Claude 3.5 Sonnet', free: true },
    // Groq
    'llama-3.3-70b-versatile': { provider: 'groq', name: 'Llama 3.3 70B', free: true },
    'qwen/qwen3-32b': { provider: 'groq', name: 'Qwen3 32B', free: true },
    'deepseek-r1-distill-llama-70b': { provider: 'groq', name: 'DeepSeek R1 70B', free: true },
    // OpenAI
    'gpt-4.1': { provider: 'openai', name: 'GPT-4.1' },
    'gpt-4.1-mini': { provider: 'openai', name: 'GPT-4.1-mini' },
    'gpt-4.1-nano': { provider: 'openai', name: 'GPT-4.1-nano' },
    'gpt-4o': { provider: 'openai', name: 'GPT-4o' },
    'gpt-4o-mini': { provider: 'openai', name: 'GPT-4o-mini' },
    'o3-mini': { provider: 'openai', name: 'o3-mini' },
    'o3': { provider: 'openai', name: 'o3' },
    // Anthropic Claude
    'claude-sonnet-4-6-20250217': { provider: 'anthropic', name: 'Claude Sonnet 4.6' },
    'claude-opus-4-7-20260416': { provider: 'anthropic', name: 'Claude Opus 4.7' },
    'claude-sonnet-4-5-20250929': { provider: 'anthropic', name: 'Claude Sonnet 4.5' },
    'claude-opus-4-5-20251124': { provider: 'anthropic', name: 'Claude Opus 4.5' },
    'claude-haiku-4-5-20251001': { provider: 'anthropic', name: 'Claude Haiku 4.5' },
    // Google Gemini
    'gemini-3.5-flash': { provider: 'google', name: 'Gemini 3.5 Flash' },
    'gemini-2.5-pro': { provider: 'google', name: 'Gemini 2.5 Pro' },
    'gemini-2.5-flash': { provider: 'google', name: 'Gemini 2.5 Flash', free: true },
    'gemini-2.5-flash-lite': { provider: 'google', name: 'Gemini 2.5 Flash-Lite', free: true },
    'gemini-2.0-flash': { provider: 'google', name: 'Gemini 2.0 Flash', free: true }
};

function getProviderInfo(modelId) {
    const modelInfo = MODELS[modelId];
    if (!modelInfo) return { platform: PLATFORMS.zhipu, modelInfo: { name: modelId } };
    return { platform: PLATFORMS[modelInfo.provider] || PLATFORMS.zhipu, modelInfo };
}

function getProviderForModel(modelId) {
    return getProviderInfo(modelId).platform;
}

function buildApiHeaders(platform, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    switch (platform.authType) {
        case 'x-api-key':
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            break;
        case 'url_key':
            headers['x-goog-api-key'] = apiKey;
            break;
        case 'bearer':
        default:
            headers['Authorization'] = `Bearer ${apiKey}`;
            break;
    }
    if (platform.apiFormat === 'openrouter') {
        headers['HTTP-Referer'] = 'https://versepc.app';
        headers['X-Title'] = 'VersePC';
    }
    return headers;
}

function buildChatEndpoint(platform, modelId, apiKey) {
    const base = platform.baseUrl;
    switch (platform.apiFormat) {
        case 'anthropic':
            return { url: base + '/v1/messages', method: 'POST' };
        case 'google':
            return { url: base + '/models/' + modelId + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(apiKey), method: 'POST' };
        case 'openai':
        default:
            return { url: base + '/chat/completions', method: 'POST' };
    }
}

function buildNonStreamingEndpoint(platform, modelId, apiKey) {
    const base = platform.baseUrl;
    switch (platform.apiFormat) {
        case 'google':
            return { url: base + '/models/' + modelId + ':generateContent?key=' + encodeURIComponent(apiKey), method: 'POST' };
        default:
            return buildChatEndpoint(platform, modelId, apiKey);
    }
}

// Anthropic 消息格式转换
function _toAnthropicMessages(messages) {
    const system = messages.find(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const result = { messages: [] };
    if (system) result.system = system.content;

    for (let i = 0; i < others.length; i++) {
        const m = others[i];
        const next = others[i + 1];
        const content = [];

        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                let input = {};
                try { input = JSON.parse(tc.function.arguments); } catch (e) {}
                content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
            }
        }

        if (m.role === 'tool') {
            const toolContent = typeof m.content === 'string' ? m.content : '';
            const prevAssistant = i > 0 && others[i - 1].role === 'assistant' && others[i - 1].tool_calls;
            if (prevAssistant && prevAssistant.tool_calls.length > 0) {
                const matchingTc = prevAssistant.tool_calls.find(tc => tc.id === m.tool_call_id);
                if (matchingTc || prevAssistant.tool_calls.length === 1) {
                    const tcId = matchingTc ? matchingTc.id : prevAssistant.tool_calls[0].id;
                    result.messages.push({
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: tcId, content: toolContent }]
                    });
                    continue;
                }
            }
        }

        if (content.length > 0) {
            result.messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
        }
    }

    if (result.messages.length === 0 && others.length > 0) {
        result.messages = others.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '...' }));
    }
    return result;
}

function _toAnthropicTools(tools) {
    if (!tools || !tools.length) return undefined;
    return tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
}

// Google Gemini 消息格式转换
function _toGoogleMessages(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const result = { contents: [] };
    if (systemMsg) result.system_instruction = { parts: [{ text: systemMsg.content }] };

    for (const m of nonSystem) {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function.arguments); } catch (e) {}
                parts.push({ functionCall: { name: tc.function.name, args } });
            }
        }
        if (m.role === 'tool') {
            try {
                const parsed = JSON.parse(m.content);
                parts.push({ functionResponse: { name: m.name || m.tool_name || '', response: parsed } });
            } catch (e) {
                parts.push({ functionResponse: { name: m.name || m.tool_name || '', response: { result: m.content || '' } } });
            }
        }
        if (parts.length > 0) {
            result.contents.push({
                role: m.role === 'assistant' ? 'model' : (m.role === 'tool' ? 'function' : 'user'),
                parts
            });
        }
    }
    return result;
}

function _toGoogleTools(tools) {
    if (!tools || !tools.length) return undefined;
    return [{ functionDeclarations: tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
}

// =============================================================================
// Tool 定义
// =============================================================================

const AI_TOOLS = [
    { type: 'function', function: { name: 'bash', description: 'Execute a bash command in a persistent shell session. State is preserved across calls. Use & for long-running commands.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute' }, restart: { type: 'boolean', description: 'Set true to restart the shell session' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'str_replace_based_edit_tool', description: 'File editing tool: view, create, and edit files. Commands: view (read file), create (new file), str_replace (exact string replacement), insert (insert at line). create cannot be used on existing files.', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'], description: 'Command to execute' }, path: { type: 'string', description: 'Absolute path to file or directory' }, file_text: { type: 'string', description: 'Required for create: file content' }, old_str: { type: 'string', description: 'Required for str_replace: exact string to replace (must be unique)' }, new_str: { type: 'string', description: 'New string for str_replace/insert' }, insert_line: { type: 'integer', description: 'Required for insert: line number to insert after' }, view_range: { type: 'array', items: { type: 'integer' }, description: 'Optional for view: line range [start, end]' } }, required: ['command', 'path'] } } },
    { type: 'function', function: { name: 'json_edit_tool', description: 'JSON file editing tool using JSONPath expressions. Operations: view, set, add, remove. Examples: $.users[0].name, $.config.database', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['view', 'set', 'add', 'remove'], description: 'Operation to perform' }, file_path: { type: 'string', description: 'Absolute path to JSON file' }, json_path: { type: 'string', description: 'JSONPath expression' }, value: { type: 'object', description: 'Value to set or add (required for set/add)' }, pretty_print: { type: 'boolean', description: 'Format output (default true)' } }, required: ['operation', 'file_path'] } } },
    { type: 'function', function: { name: 'sequential_thinking', description: 'Break down complex problems into sequential thinking steps. Each step produces a conclusion. Supports revising previous steps. Use when deep analysis is needed.', parameters: { type: 'object', properties: { thought: { type: 'string', description: 'Thinking content for current step' }, thought_number: { type: 'number', description: 'Current step number' }, total_thoughts: { type: 'number', description: 'Estimated total steps' }, next_thought_needed: { type: 'boolean', description: 'Whether another step is needed' }, is_revision: { type: 'boolean', description: 'Whether revising a previous step' }, revises_thought: { type: 'number', description: 'Step number being revised (when is_revision=true)' }, branch_from_thought: { type: 'number', description: 'Branch from this step (optional)' }, branch_id: { type: 'string', description: 'Branch identifier (optional)' } }, required: ['thought', 'thought_number', 'total_thoughts', 'next_thought_needed'] } } },
    { type: 'function', function: { name: 'attempt_completion', description: 'Report task completion. Only call after verifying the task is done. The result will be presented to the user for confirmation.', parameters: { type: 'object', properties: { result: { type: 'string', description: 'Final result message with summary of completed work' } }, required: ['result'] } } },
    { type: 'function', function: { name: 'ckg', description: 'Code Knowledge Graph: search for functions, classes, and class methods in the codebase.', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['search_function', 'search_class', 'search_class_method'], description: 'Search command' }, path: { type: 'string', description: 'Codebase path' }, identifier: { type: 'string', description: 'Function/class/method name to search' }, print_body: { type: 'boolean', description: 'Print function/class body (default true)' } }, required: ['command', 'path', 'identifier'] } } },
    { type: 'function', function: { name: 'update_todo_list', description: 'Replace the entire TODO list with an updated checklist reflecting current progress. Use this to plan, track, and update task progress. Format: [ ] pending, [-] in progress, [x] completed.', parameters: { type: 'object', properties: { todos: { type: 'string', description: 'Full markdown checklist in execution order. Use [ ] for pending, [-] for in progress, [x] for completed.' } }, required: ['todos'] } } }
];

const toolDescriptions = AI_TOOLS.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n');

const TOOL_RISK = {
    str_replace_based_edit_tool: 'safe', json_edit_tool: 'safe', ckg: 'safe',
    sequential_thinking: 'safe', attempt_completion: 'safe',
    bash: 'safe', update_todo_list: 'safe'
};

const TOOL_DISPLAY_NAMES = {
    bash: '执行命令', str_replace_based_edit_tool: '编辑文件',
    json_edit_tool: '编辑JSON', sequential_thinking: '分步思考',
    attempt_completion: '完成任务', ckg: '代码图谱',
    update_todo_list: '更新计划'
};



// =============================================================================
// HTTP API 工具
// =============================================================================

function makeApiStreamRequest(apiUrl, bodyStr, headers) {
    const options = {
        hostname: apiUrl.hostname,
        path: apiUrl.pathname + (apiUrl.search || ''),
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr), 'Connection': 'close' },
        agent: false
    };
    const proto = apiUrl.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = proto.request(options, (res) => {
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    let errMsg = `HTTP ${res.statusCode}`;
                    try {
                        const parsed = JSON.parse(errData);
                        errMsg = parsed.error?.message || parsed.error?.code || parsed.message || errMsg;
                    } catch (e) {}
                    reject(new Error(errMsg));
                });
                return;
            }
            resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('API连接超时(60s)')); });
        req.write(bodyStr);
        req.end();
    });
}

function makeApiRequest(apiUrl, bodyStr, headers) {
    const options = {
        hostname: apiUrl.hostname,
        path: apiUrl.pathname + (apiUrl.search || ''),
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr), 'Connection': 'close' },
        agent: false
    };
    const proto = apiUrl.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = proto.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    let errMsg = `HTTP ${res.statusCode}`;
                    try {
                        const parsed = JSON.parse(data);
                        errMsg = parsed.error?.message || parsed.error?.code || parsed.message || errMsg;
                    } catch (e) {}
                    reject(new Error(errMsg));
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(parsed.error.message || parsed.error.code || JSON.stringify(parsed.error)));
                        return;
                    }
                    resolve(parsed.choices?.[0]?.message?.content || '');
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('API请求超时(30s)')); });
        req.write(bodyStr);
        req.end();
    });
}

// =============================================================================
// Agent Engine (全功能)
// =============================================================================

class AgentEngine {
    constructor(options = {}) {
        this.onChunk = options.onChunk || (() => {});
        this.onRequestApproval = options.onRequestApproval || null;
        this.executeTool = options.executeTool || null;
        this.output = new OutputManager();

        this.enablePlanning = options.enablePlanning !== false;
        this.enableReflection = options.enableReflection !== false;
        this.enableStuckDetection = options.enableStuckDetection !== false;
        this.enablePassiveDetection = options.enablePassiveDetection !== false;
        this.maxRounds = options.maxRounds || 24;
        this.maxConsecutiveFailures = options.maxConsecutiveFailures || 3;
        this.maxPassiveDetections = options.maxPassiveDetections || 2;
        this.maxRepeatText = options.maxRepeatText || 2;

        this._aborted = false;
        this._actionHistory = [];
        this._lastTextContent = '';
        this._repeatTextCount = 0;
        this._consecutiveFailures = 0;
        this._consecutiveMistakes = 0;
        this._passiveDetectionCount = 0;
        this._activePlan = null;
        this._planStepResults = {};
        this._provider = null;
        this._apiUrl = null;
        this._apiHeaders = null;
        this._model = null;
    }

    abort() {
        this._aborted = true;
    }

    _send(msg) {
        const processed = this.output.processMessage(msg);
        if (processed) {
            this.onChunk(processed);
        }
    }

    /**
     * 主入口：处理聊天
     */
    async processChat({ apiKey, model, messages, temperature, enableTools, apiFormat: customApiFormat, baseUrl: customBaseUrl }) {
        this._aborted = false;
        this.output.clear();
        this._actionHistory = [];
        this._lastTextContent = '';
        this._repeatTextCount = 0;
        this._consecutiveFailures = 0;
        this._consecutiveMistakes = 0;
        this._passiveDetectionCount = 0;
        this._activePlan = null;
        this._planStepResults = {};
        this._thinkingSteps = [];
        this._model = model || 'glm-5-flash';

        if (!apiKey) {
            this._send({ type: 'say', say: SayType.ERROR, text: '未配置 API Key，请在设置中填写' });
            return;
        }

        let apiFormat;
        let requestModel = this._model;
        if (customBaseUrl && customApiFormat) {
            const authType = customApiFormat === 'anthropic' ? 'x-api-key' : 'bearer';
            this._provider = { name: 'Custom', baseUrl: customBaseUrl, authType, apiFormat: customApiFormat, thinkingParams: {} };
            const endpoint = buildChatEndpoint(this._provider, this._model, apiKey);
            this._apiUrl = new URL(endpoint.url);
            this._apiHeaders = buildApiHeaders(this._provider, apiKey);
            apiFormat = customApiFormat;
            const customMatch = this._model.match(/^custom:(https?:\/\/.+):(.+)$/);
            if (customMatch) requestModel = customMatch[2];
        } else {
            this._provider = getProviderForModel(this._model);
            const endpoint = buildChatEndpoint(this._provider, this._model, apiKey);
            this._apiUrl = new URL(endpoint.url);
            this._apiHeaders = buildApiHeaders(this._provider, apiKey);
            apiFormat = this._provider.apiFormat || 'openai';
        }
        this._requestModel = requestModel;
        const tools = enableTools !== false ? AI_TOOLS : undefined;

        let conversation = [...messages];
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

        const contextSummary = this._buildContextSummary();
        if (contextSummary) conversation.push({ role: 'system', content: contextSummary });

        if (this.enablePlanning && lastUserMsg && tools) {
            const intent = this._detectIntent(lastUserMsg.content);
            if (intent.intent === 'complex' && intent.steps_needed > 1) {
                conversation.push({
                    role: 'system',
                    content: `This is a multi-step task. You MUST first call update_todo_list to create a plan, then execute each step sequentially:
1. Call update_todo_list with a markdown checklist (use [ ] pending, [-] in progress, [x] completed)
2. Before each step, call update_todo_list to mark it as [-] in progress
3. Execute the step using appropriate tools
4. Call update_todo_list to mark it as [x] completed
5. Repeat until all steps are done
6. Call attempt_completion with a structured summary

Do NOT skip planning. Do NOT ask the user if you should continue. Execute autonomously.`
                });
            }
        }

        for (let round = 0; round < this.maxRounds; round++) {
            if (this._aborted) break;
            await new Promise(resolve => setImmediate(resolve));

            let bodyStr;
            const hasTools = tools && tools.length > 0;

            if (apiFormat === 'anthropic') {
                const anthropicMessages = _toAnthropicMessages(conversation);
                const reqBody = {
                    model: this._requestModel,
                    max_tokens: 8192,
                    stream: true,
                    ...(anthropicMessages.system ? { system: anthropicMessages.system } : {}),
                    messages: anthropicMessages.messages
                };
                if (hasTools) reqBody.tools = _toAnthropicTools(tools);
                bodyStr = JSON.stringify(reqBody);
            } else if (apiFormat === 'google') {
                const googleMessages = _toGoogleMessages(conversation);
                const reqBody = {
                    ...(googleMessages.system_instruction ? { system_instruction: googleMessages.system_instruction } : {}),
                    contents: googleMessages.contents,
                    generationConfig: { temperature: temperature != null ? temperature : 0.7 }
                };
                if (hasTools) reqBody.tools = _toGoogleTools(tools);
                bodyStr = JSON.stringify(reqBody);
            } else {
                const reqBody = {
                    model: this._requestModel,
                    messages: conversation,
                    temperature: temperature != null ? temperature : 0.7,
                    stream: true
                };
                if (hasTools) { reqBody.tools = tools; reqBody.tool_choice = 'auto'; }
                if (this._provider.thinkingParams && Object.keys(this._provider.thinkingParams).length > 0) {
                    Object.assign(reqBody, this._provider.thinkingParams);
                }
                if (reqBody.enable_thinking === true) delete reqBody.temperature;
                bodyStr = JSON.stringify(reqBody);
            }

            let res;
            try {
                this._send({ type: 'say', say: SayType.API_STARTED, text: '' });
                res = await makeApiStreamRequest(this._apiUrl, bodyStr, this._apiHeaders);
            } catch (e) {
                this._send({ type: 'say', say: SayType.ERROR, text: e.message });
                return;
            }

            const roundData = await this._processStream(res, apiFormat);
            if (this._aborted) break;

            if (roundData.toolCalls.length > 0 && roundData.finishReason === 'tool_calls') {
                const assistantMsg = {
                    role: 'assistant',
                    content: roundData.fullContent || '',
                    tool_calls: roundData.toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.name, arguments: tc.argsStr }
                    }))
                };
                if (this._provider.thinkingParams && this._provider.thinkingParams.enable_thinking) {
                    assistantMsg.reasoning_content = roundData.fullReasoning || '';
                } else if (roundData.fullReasoning) {
                    assistantMsg.reasoning_content = roundData.fullReasoning;
                }
                conversation.push(assistantMsg);

                const stuckDetected = this.enableStuckDetection && this._detectStuck();
                if (stuckDetected) {
                    this._send({ type: 'say', say: SayType.ERROR, text: '检测到循环调用，已自动中断' });
                    this._send({
                        type: 'say', say: SayType.TOOL_START,
                        text: JSON.stringify(roundData.toolCalls.map(tc => ({
                            id: tc.id, name: tc.name,
                            displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name,
                            args: tc.argsStr
                        })))
                    });
                    for (const tc of roundData.toolCalls) {
                        this._send({
                            type: 'say', say: SayType.TOOL_RESULT,
                            text: JSON.stringify({ id: tc.id, name: tc.name, error: '检测到循环调用，已自动中断' })
                        });
                    }
                    this._send({ type: 'say', say: SayType.TOOL_END, text: '' });
                    conversation.push({
                        role: 'system',
                        content: 'AGENT STATE: STUCK — Loop detected. You must try a completely different approach, or call attempt_completion to report current progress and difficulties.'
                    });
                    continue;
                }

                const toolResults = await this._executeTools(roundData.toolCalls, lastUserMsg);
                if (this._aborted) break;

                for (const tr of toolResults) {
                    conversation.push({
                        role: 'tool',
                        tool_call_id: tr.id,
                        name: tr.name,
                        content: tr.result
                    });
                }

                this._evaluateAndGuide(toolResults, conversation, lastUserMsg, round);

                if (toolResults.some(r => r.isCompletion)) break;

                this._compressIfNeeded(conversation);
                continue;
            }

            if (roundData.fullContent && roundData.toolCalls.length === 0) {
                if (this.enablePassiveDetection) {
                    const isPassive = this._detectPassive(roundData.fullContent, lastUserMsg);
                    if (isPassive && this._passiveDetectionCount < this.maxPassiveDetections) {
                        this._passiveDetectionCount++;
                        conversation.push({
                            role: 'system',
                            content: `Your response is too passive. You have tools to autonomously gather information and execute actions. NEVER ask the user for information you can obtain yourself.

Review the user's request. Think about what information you need and which tool can provide it. Call the tool immediately.

Available tools: bash, str_replace_based_edit_tool, json_edit_tool, ckg, sequential_thinking, attempt_completion, update_todo_list.
Take action now. Do not explain your limitations.`
                        });
                        continue;
                    }
                }

                const similarity = this._computeTextSimilarity(roundData.fullContent, this._lastTextContent);
                if (similarity > 0.4 && this._lastTextContent.length > 10) {
                    this._repeatTextCount++;
                    if (this._repeatTextCount >= this.maxRepeatText) {
                        this._send({ type: 'say', say: SayType.COMPLETION, text: '' });
                        return;
                    }
                } else if (this._detectInternalRepetition(roundData.fullContent)) {
                    this._repeatTextCount++;
                    if (this._repeatTextCount >= this.maxRepeatText) {
                        this._send({ type: 'say', say: SayType.COMPLETION, text: '' });
                        return;
                    }
                } else {
                    this._repeatTextCount = 0;
                }
                this._lastTextContent = roundData.fullContent;
            }

            this._send({ type: 'say', say: SayType.COMPLETION, text: roundData.fullContent || '' });
            this._send({ type: 'say', say: SayType.API_FINISHED, text: '' });
            return;
        }

        this._send({ type: 'say', say: SayType.COMPLETION, text: '' });
        this._send({ type: 'say', say: SayType.API_FINISHED, text: '' });
    }
    // Context Builder
    // =========================================================================

    _buildContextSummary() {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            const settingsPath = path.join(os.homedir(), '.versepc', 'settings.json');
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                let s = '## 当前工作区状态（自动获取，无需询问用户）\n';
                if (settings.selectedVersion) s += `- 当前版本: ${settings.selectedVersion}\n`;
                if (settings.javaPath) s += `- Java路径: ${settings.javaPath}\n`;
                if (settings.maxMemory) s += `- 最大内存: ${settings.maxMemory}\n`;
                if (settings.gameDir) s += `- 游戏目录: ${settings.gameDir}\n`;
                s += '\n以上信息已自动获取。如需更详细的信息（模组列表、版本列表等），请使用工具获取。';
                return s;
            }
        } catch (e) {}
        return null;
    }

    // =========================================================================
    // Intent Detection
    // =========================================================================

    _detectIntent(userMessage) {
        const lower = userMessage.toLowerCase();
        const simplePatterns = /^(你好|hi|hello|hey|谢谢|感谢|ok|好的|知道了|你是谁|你叫什么|帮我解释|什么是|怎么理解|你是|说说|聊聊|讲讲|告诉我)/;
        if (simplePatterns.test(lower)) return { intent: 'simple', reason: 'greeting', steps_needed: 0 };
        if (userMessage.length < 15 && !/[安装|卸载|创建|删除|修改]/.test(userMessage)) return { intent: 'simple', reason: 'short', steps_needed: 0 };
        const complexPatterns = /安装|卸载|创建|删除|修改|编辑|配置|部署|构建|编译|调试|搜索|查找|读取|写入|执行|运行|启动|停止|重启|更新|升级|迁移|导入|导出|备份|恢复|修复|优化|测试|分析|检查|扫描|监控|设置|初始化|clone|install|uninstall|create|delete|modify|edit|config|deploy|build|compile|debug|search|find|read|write|exec|run|start|stop|restart|update|upgrade|migrate|import|export|backup|restore|fix|optimize|test|analyze|check|scan|monitor|setup|init|git|npm|pip|docker|kubernetes|bash|terminal|command|script|file|folder|directory|code|project|package|module|dependency|api|database|server|deploy|ci|cd|pipeline|workflow|refactor|整合包|材质|光影|mod|MOD|forge|fabric|neoforge|版本|启动游戏|我的世界|minecraft|minecraft/i;
        if (complexPatterns.test(lower)) return { intent: 'complex', reason: 'task', steps_needed: 2 };
        return { intent: 'simple', reason: 'general', steps_needed: 0 };
    }

    // =========================================================================
    // Stream Processing
    // =========================================================================

    async _processStream(res, apiFormat) {
        if (apiFormat === 'anthropic') return this._processAnthropicStream(res);
        if (apiFormat === 'google') return this._processGoogleStream(res);
        return this._processOpenAIStream(res);
    }

    // OpenAI-compatible SSE
    async _processOpenAIStream(res) {
        let buffer = '';
        let fullContent = '';
        let prevContentLen = 0;
        let fullReasoning = '';
        let prevReasoningLen = 0;
        let toolCalls = [];
        let finishReason = null;
        let reasoningStarted = false;
        let doneReceived = false;

        await new Promise((resolve) => {
            let inactivityTimer = setTimeout(() => resolve('timeout'), 120000);
            const TOTAL_TIMEOUT = 600000;
            const totalTimer = setTimeout(() => resolve('timeout'), TOTAL_TIMEOUT);
            let finished = false;
            const finish = (reason) => {
                if (finished) return;
                finished = true;
                clearTimeout(inactivityTimer);
                clearTimeout(totalTimer);
                resolve(reason);
            };

            res.on('data', (chunk) => {
                try {
                    clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => finish('timeout'), 120000);
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;
                        const data = trimmed.slice(5).trim();
                        if (data === '[DONE]') { finishReason = finishReason || 'stop'; doneReceived = true; }

                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0];
                            if (!choice) continue;

                            const delta = choice.delta;
                            finishReason = choice.finish_reason || finishReason;

                            if (delta?.content) {
                                fullContent += delta.content;
                                const newDelta = fullContent.slice(prevContentLen);
                                prevContentLen = fullContent.length;
                                this._send({ type: 'say', say: SayType.TEXT, text: newDelta, partial: true });
                            }

                            if (delta?.reasoning_content) {
                                if (!reasoningStarted) {
                                    reasoningStarted = true;
                                    this._send({ type: 'say', say: SayType.REASONING, text: '', partial: true });
                                }
                                fullReasoning += delta.reasoning_content;
                                const newDelta = fullReasoning.slice(prevReasoningLen);
                                prevReasoningLen = fullReasoning.length;
                                this._send({ type: 'say', say: SayType.REASONING, text: newDelta, partial: true });
                            }

                            if (delta?.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index ?? toolCalls.length;
                                    if (!toolCalls[idx]) {
                                        toolCalls[idx] = { id: tc.id || '', name: '', argsStr: '' };
                                    }
                                    if (tc.id) toolCalls[idx].id = tc.id;
                                    if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                                    if (tc.function?.arguments) toolCalls[idx].argsStr += tc.function.arguments;
                                }
                            }
                        } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
                    }
                } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
            });

            res.on('end', () => { finishReason = finishReason || 'stop'; finish('done'); });
            res.on('error', (err) => { console.error('[Engine] SSE stream error:', err.message); finish('error'); });
        });

        if (fullContent) {
            this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: false });
        }
        if (reasoningStarted) {
            this._send({ type: 'say', say: SayType.REASONING, text: '', partial: false });
        }

        return { fullContent, fullReasoning, toolCalls, finishReason: finishReason || 'stop' };
    }

    // Anthropic SSE
    async _processAnthropicStream(res) {
        let buffer = '';
        let fullContent = '';
        let prevContentLen = 0;
        let fullReasoning = '';
        let prevReasoningLen = 0;
        let toolCalls = [];
        let finishReason = null;
        let reasoningStarted = false;

        const currentTool = {};
        let activeToolId = null;

        await new Promise((resolve) => {
            let inactivityTimer = setTimeout(() => resolve('timeout'), 120000);
            const totalTimer = setTimeout(() => resolve('timeout'), TOTAL_TIMEOUT);
            let finished = false;
            const finish = (reason) => {
                if (finished) return;
                finished = true;
                clearTimeout(inactivityTimer);
                clearTimeout(totalTimer);
                resolve(reason);
            };

            res.on('data', (chunk) => {
                try {
                    clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => finish('timeout'), 120000);
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;
                        const data = trimmed.slice(5).trim();

                        try {
                            const event = JSON.parse(data);

                            switch (event.type) {
                                case 'content_block_start': {
                                    const block = event.content_block;
                                    if (block.type === 'tool_use') {
                                        const id = block.id || ('toolu_' + Math.random().toString(36).slice(2));
                                        currentTool[id] = { id, name: block.name || '', args: {} };
                                        activeToolId = id;
                                    }
                                    break;
                                }
                                case 'content_block_delta': {
                                    const delta = event.delta;
                                    if (delta.type === 'text_delta') {
                                        fullContent += delta.text || '';
                                        const newDelta = fullContent.slice(prevContentLen);
                                        prevContentLen = fullContent.length;
                                        this._send({ type: 'say', say: SayType.TEXT, text: newDelta, partial: true });
                                    } else if (delta.type === 'input_json_delta') {
                                        const toolId = activeToolId;
                                        if (toolId && currentTool[toolId]) {
                                            currentTool[toolId].partialJson = (currentTool[toolId].partialJson || '') + (delta.partial_json || '');
                                            try {
                                                currentTool[toolId].args = JSON.parse(currentTool[toolId].partialJson);
                                            } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
                                        }
                                    } else if (delta.type === 'thinking_delta') {
                                        if (!reasoningStarted) {
                                            reasoningStarted = true;
                                            this._send({ type: 'say', say: SayType.REASONING, text: '', partial: true });
                                        }
                                        fullReasoning += delta.thinking || '';
                                        const newDelta = fullReasoning.slice(prevReasoningLen);
                                        prevReasoningLen = fullReasoning.length;
                                        this._send({ type: 'say', say: SayType.REASONING, text: newDelta, partial: true });
                                    } else if (delta.type === 'signature_delta') {
                                        // signature delta - ignore
                                    }
                                    break;
                                }
                                case 'content_block_stop': {
                                    for (const [id, toolData] of Object.entries(currentTool)) {
                                        if (toolData.name) {
                                            toolCalls.push({
                                                id: toolData.id,
                                                name: toolData.name,
                                                argsStr: JSON.stringify(toolData.args || {})
                                            });
                                            delete currentTool[id];
                                        }
                                    }
                                    break;
                                }
                                case 'message_delta': {
                                    if (event.delta?.stop_reason === 'end_turn') finishReason = 'stop';
                                    if (event.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls';
                                    break;
                                }
                                case 'message_stop': {
                                    if (!finishReason) finishReason = 'stop';
                                    resolve('done');
                                    break;
                                }
                                case 'ping': break;
                            }
                        } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
                    }
                } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
            });

            res.on('end', () => { finishReason = finishReason || 'stop'; finish('done'); });
            res.on('error', (err) => { console.error('[Engine] SSE stream error:', err.message); finish('error'); });
        });

        for (const [id, toolData] of Object.entries(currentTool)) {
            if (toolData.name) {
                toolCalls.push({ id: toolData.id, name: toolData.name, argsStr: JSON.stringify(toolData.args || {}) });
            }
        }

        if (fullContent) {
            this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: false });
        }
        if (reasoningStarted) {
            this._send({ type: 'say', say: SayType.REASONING, text: '', partial: false });
        }

        return { fullContent, fullReasoning, toolCalls, finishReason: finishReason || 'stop' };
    }

    // Google Gemini SSE
    async _processGoogleStream(res) {
        let buffer = '';
        let fullContent = '';
        let prevContentLen = 0;
        let fullReasoning = '';
        let prevReasoningLen = 0;
        let toolCalls = [];
        let finishReason = null;
        let reasoningStarted = false;

        await new Promise((resolve) => {
            let inactivityTimer = setTimeout(() => resolve('timeout'), 120000);
            const totalTimer = setTimeout(() => resolve('timeout'), TOTAL_TIMEOUT);
            let finished = false;
            const finish = (reason) => {
                if (finished) return;
                finished = true;
                clearTimeout(inactivityTimer);
                clearTimeout(totalTimer);
                resolve(reason);
            };

            res.on('data', (chunk) => {
                try {
                    clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => finish('timeout'), 120000);
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;
                        const data = trimmed.slice(5).trim();

                        try {
                            const parsed = JSON.parse(data);
                            const candidate = parsed.candidates?.[0];
                            if (!candidate) continue;

                            if (candidate.content?.parts) {
                                for (const part of candidate.content.parts) {
                                    if (part.text) {
                                        fullContent += part.text;
                                        const newDelta = fullContent.slice(prevContentLen);
                                        prevContentLen = fullContent.length;
                                        this._send({ type: 'say', say: SayType.TEXT, text: newDelta, partial: true });
                                    }
                                    if (part.thought) {
                                        if (!reasoningStarted) {
                                            reasoningStarted = true;
                                            this._send({ type: 'say', say: SayType.REASONING, text: '', partial: true });
                                        }
                                        fullReasoning += part.thought;
                                        const newDelta = fullReasoning.slice(prevReasoningLen);
                                        prevReasoningLen = fullReasoning.length;
                                        this._send({ type: 'say', say: SayType.REASONING, text: newDelta, partial: true });
                                    }
                                    if (part.functionCall) {
                                        toolCalls.push({
                                            id: 'call_' + Math.random().toString(36).slice(2, 10),
                                            name: part.functionCall.name,
                                            argsStr: JSON.stringify(part.functionCall.args || {})
                                        });
                                    }
                                }
                            }

                            if (candidate.finishReason) {
                                const fr = candidate.finishReason;
                                if (fr === 'STOP') finishReason = 'stop';
                                else if (fr === 'TOOL_CALLS' || fr === 'FUNCTION_CALL') finishReason = 'tool_calls';
                                else if (fr === 'MAX_TOKENS') finishReason = 'length';
                                else finishReason = 'stop';
                            }
                        } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
                    }
                } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
            });

            res.on('end', () => { finishReason = finishReason || 'stop'; finish('done'); });
            res.on('error', (err) => { console.error('[Engine] SSE stream error:', err.message); finish('error'); });
        });

        if (fullContent) {
            this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: false });
        }
        if (reasoningStarted) {
            this._send({ type: 'say', say: SayType.REASONING, text: '', partial: false });
        }

        return { fullContent, fullReasoning, toolCalls, finishReason: finishReason || 'stop' };
    }

    // =========================================================================
    // Tool Execution
    // =========================================================================

    async _executeTools(toolCalls, lastUserMsg) {
        if (!this.executeTool) {
            return toolCalls.map(tc => ({ id: tc.id, name: tc.name, result: JSON.stringify({ error: '工具执行未配置' }) }));
        }

        for (const tc of toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.argsStr); } catch (e) {}
            this._actionHistory.push({ name: tc.name, args });
        }

        this._send({
            type: 'say', say: SayType.TOOL_START,
            text: JSON.stringify(toolCalls.map(tc => ({
                id: tc.id, name: tc.name,
                displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name,
                args: tc.argsStr
            })))
        });

        const independentCalls = [];
        const dependentCalls = [];

        for (const tc of toolCalls) {
            let args = {};
            try { args = JSON.parse(tc.argsStr); } catch (e) {}

            if (this._activePlan) {
                const planStep = this._activePlan.find(s => s.tool === tc.name);
                if (planStep && planStep.depends_on && planStep.depends_on.length > 0) {
                    for (const depStep of planStep.depends_on) {
                        const depResult = this._planStepResults[depStep];
                        if (depResult) {
                            const argsStr = JSON.stringify(args);
                            const resolved = argsStr.replace(/STEP(\d+)\.result\.(\w+)/g, (_, stepNum, field) => {
                                const stepResult = this._planStepResults[parseInt(stepNum)];
                                return stepResult?.[field] || '';
                            });
                            try { args = JSON.parse(resolved); } catch (e) {}
                        }
                    }
                    dependentCalls.push({ tc, args });
                } else {
                    independentCalls.push({ tc, args });
                }
            } else {
                independentCalls.push({ tc, args });
            }
        }

        const executeOne = async ({ tc, args }) => {
            if (this._aborted) {
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: '已中断', elapsed: 0 })
                });
                return { id: tc.id, name: tc.name, result: JSON.stringify({ status: 'aborted' }) };
            }

            if (tc.name === 'attempt_completion') {
                let parsed = {};
                try { parsed = JSON.parse(tc.argsStr); } catch (e) {}
                const compResult = JSON.stringify({ status: 'success', completion: parsed.result || parsed.text || '' });
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: '任务完成', elapsed: 0 })
                });
                return {
                    id: tc.id, name: tc.name,
                    result: compResult,
                    isCompletion: true
                };
            }

            if (tc.name === 'update_todo_list') {
                let parsed = {};
                try { parsed = JSON.parse(tc.argsStr); } catch (e) {}
                const todos = parsed.todos || '';
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: '计划已更新', elapsed: 0 })
                });
                return {
                    id: tc.id, name: tc.name,
                    result: JSON.stringify({ status: 'success', todos })
                };
            }

            if (tc.name === 'sequential_thinking') {
                let parsed = {};
                try { parsed = JSON.parse(tc.argsStr); } catch (e) {}
                this._thinkingSteps = this._thinkingSteps || [];
                const stepData = {
                    thought: parsed.thought || '',
                    thought_number: parsed.thought_number || this._thinkingSteps.length + 1,
                    total_thoughts: parsed.total_thoughts || this._thinkingSteps.length + 1,
                    next_thought_needed: parsed.next_thought_needed !== false,
                    is_revision: parsed.is_revision || false,
                    revises_thought: parsed.revises_thought || null,
                    branch_from_thought: parsed.branch_from_thought || null,
                    branch_id: parsed.branch_id || null,
                };
                this._thinkingSteps.push(stepData);
                this._send({
                    type: 'say', say: SayType.THINKING_STEP,
                    text: JSON.stringify(stepData),
                    partial: false
                });
                const thinkResult = JSON.stringify({ status: 'success', thought_number: stepData.thought_number, message: `Step ${stepData.thought_number} recorded` });
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: `思考步骤 ${stepData.thought_number}/${stepData.total_thoughts}`, elapsed: 0 })
                });
                return {
                    id: tc.id, name: tc.name,
                    result: thinkResult
                };
            }

            if (this._activePlan) {
                const planStep = this._activePlan.find(s => s.tool === tc.name);
                if (planStep) {
                    this._send({
                        type: 'say', say: SayType.PLAN_STEP_UPDATE,
                        text: JSON.stringify({ step: planStep.step, status: 'running' })
                    });
                }
            }

            try {
                const startTime = Date.now();
                const TOOL_EXEC_TIMEOUT = 45000;
                const result = await Promise.race([
                    this.executeTool(tc.name, tc.argsStr),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('工具执行超时(45s)')), TOOL_EXEC_TIMEOUT))
                ]);
                const elapsed = Date.now() - startTime;
                const summarized = this._summarizeToolResult(tc.name, result);
                const MAX_RESULT = 3000;
                const trimmed = summarized.length > MAX_RESULT ? summarized.slice(0, MAX_RESULT) + '...[截断]' : summarized;

                const displayResult = trimmed.length > 500 ? trimmed.slice(0, 500) + '...[显示摘要]' : trimmed;
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({
                        id: tc.id, name: tc.name,
                        displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name,
                        result: displayResult, elapsed
                    })
                });

                if (this._activePlan) {
                    const planStep = this._activePlan.find(s => s.tool === tc.name);
                    if (planStep) {
                        try { this._planStepResults[planStep.step] = JSON.parse(trimmed); } catch (e) {}
                        const hasError = trimmed.includes('"error"') || trimmed.includes('"status":"error"');
                        this._send({
                            type: 'say', say: SayType.PLAN_STEP_UPDATE,
                            text: JSON.stringify({ step: planStep.step, status: hasError ? 'error' : 'done' })
                        });
                    }
                }

                return { id: tc.id, name: tc.name, result: trimmed };
            } catch (e) {
                const errResult = JSON.stringify({ status: 'error', error: e.message, type: 'execution_exception' });
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, error: e.message })
                });
                if (this._activePlan) {
                    const planStep = this._activePlan.find(s => s.tool === tc.name);
                    if (planStep) {
                        this._send({
                            type: 'say', say: SayType.PLAN_STEP_UPDATE,
                            text: JSON.stringify({ step: planStep.step, status: 'error' })
                        });
                    }
                }
                return { id: tc.id, name: tc.name, result: errResult };
            }
        };

        const GLOBAL_TIMEOUT = 90000;
        let allResults;
        try {
            const execPromise = (async () => {
                const parallelResults = independentCalls.length > 1
                    ? await Promise.all(independentCalls.map(executeOne))
                    : independentCalls.length === 1
                        ? [await executeOne(independentCalls[0])]
                        : [];

                const results = [...parallelResults];
                for (const depCall of dependentCalls) {
                    if (this._aborted) break;
                    const r = await executeOne(depCall);
                    results.push(r);
                }
                return results;
            })();

            allResults = await Promise.race([
                execPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('工具批次执行超时(90s)')), GLOBAL_TIMEOUT))
            ]);
        } catch (e) {
            allResults = allResults || toolCalls.map(tc => ({
                id: tc.id, name: tc.name,
                result: JSON.stringify({ status: 'error', error: e.message || '执行异常' })
            }));
        }

        if (this._activePlan) {
            const completedSteps = Object.keys(this._planStepResults).length;
            if (completedSteps >= this._activePlan.length) {
                this._send({
                    type: 'say', say: SayType.PLAN_DONE,
                    text: JSON.stringify({ steps: this._activePlan.length })
                });
                this._activePlan = null;
            }
        }

        this._send({ type: 'say', say: SayType.TOOL_END, text: '' });
        return allResults;
    }

    // =========================================================================
    // Tool Result Summarization
    // =========================================================================

    _summarizeToolResult(name, rawResult) {
        try {
            const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
            if (parsed.error) return JSON.stringify(parsed);
            const str = JSON.stringify(parsed);
            if (str.length > 2000) return JSON.stringify({ summary: str.slice(0, 1500) + '...[truncated]', truncated: true });
            return str;
        } catch (e) {
            return rawResult;
        }
    }

    // =========================================================================
    // Stuck Detection
    // =========================================================================

    _detectStuck() {
        if (this._actionHistory.length < 3) return false;
        const recent = this._actionHistory.slice(-8);
        const actionPatterns = recent.map(a => `${a.name}:${JSON.stringify(a.args)}`);

        const patternCounts = {};
        for (const p of actionPatterns) {
            patternCounts[p] = (patternCounts[p] || 0) + 1;
        }
        for (const count of Object.values(patternCounts)) {
            if (count >= 4) return true;
        }

        if (recent.length >= 3) {
            const last3 = recent.slice(-3);
            if (last3.every(a => a.name === last3[0].name && JSON.stringify(a.args) === JSON.stringify(last3[0].args))) {
                return true;
            }
        }

        if (recent.length >= 4) {
            const names = recent.map(a => a.name);
            if (names[0] === names[2] && names[1] === names[3] &&
                JSON.stringify(recent[0].args) === JSON.stringify(recent[2].args)) {
                return true;
            }
        }

        return false;
    }

    // =========================================================================
    // Passive Detection
    // =========================================================================

    _detectPassive(fullContent, lastUserMsg) {
        if (!lastUserMsg) return false;
        const passivePatterns = [
            /我无法/, /我需要.*信息/, /请提供/, /我需要知道/, /你能不能/,
            /请告诉我/, /我需要你/, /请先/, /我需要更多/, /我没办法/,
            /我看不到/, /我访问不了/, /我无法访问/, /我无法查看/, /我没有权限/
        ];
        const isPassive = passivePatterns.some(p => p.test(fullContent));
        if (!isPassive) return false;

        const userContent = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
        const needsTools = /装|安装|启动|停止|搜索|查找|查看|检查|修复|修改|删除|下载|崩溃|日志|配置|设置|版本|模组|整合包|汉化|文件|文件夹|目录|优化|推荐|找|帮|看看|有没有|能不能|怎么|如何/.test(userContent);
        return needsTools;
    }

    // =========================================================================
    // Text Similarity
    // =========================================================================

    _computeTextSimilarity(a, b) {
        if (!a || !b || a.length < 10 || b.length < 10) return 0;
        const getNgrams = (str, n = 4) => {
            const ngrams = new Set();
            for (let i = 0; i <= str.length - n; i++) {
                ngrams.add(str.slice(i, i + n));
            }
            return ngrams;
        };
        const ngramsA = getNgrams(a);
        const ngramsB = getNgrams(b);
        let intersection = 0;
        for (const ng of ngramsA) {
            if (ngramsB.has(ng)) intersection++;
        }
        return intersection / Math.max(ngramsA.size, ngramsB.size);
    }

    _detectInternalRepetition(text) {
        if (!text || text.length < 40) return false;
        const sentences = text.split(/[。！？\n]/).filter(s => s.trim().length > 8);
        if (sentences.length < 3) return false;
        const seen = new Map();
        for (const s of sentences) {
            const key = s.trim().slice(0, 30);
            seen.set(key, (seen.get(key) || 0) + 1);
        }
        for (const count of seen.values()) {
            if (count >= 3) return true;
        }
        const half = Math.floor(sentences.length / 2);
        if (half >= 2) {
            const firstHalf = sentences.slice(0, half).join('');
            const secondHalf = sentences.slice(half).join('');
            if (this._computeTextSimilarity(firstHalf, secondHalf) > 0.5) return true;
        }
        return false;
    }

    // =========================================================================
    // Evaluation & Guidance
    // =========================================================================

    _evaluateAndGuide(allResults, conversation, lastUserMsg, round) {
        const errorCount = allResults.filter(r => {
            try {
                const p = JSON.parse(r.result);
                return p.status === 'error' || p.error;
            } catch (e) { return false; }
        }).length;
        const successCount = allResults.filter(r => {
            try {
                const p = JSON.parse(r.result);
                return p.status === 'success' || (!p.status && !p.error);
            } catch (e) { return false; }
        }).length;
        const deniedCount = allResults.filter(r => r.denied).length;

        if (errorCount > 0) {
            this._consecutiveMistakes++;
        } else {
            this._consecutiveMistakes = 0;
        }

        if (this._consecutiveMistakes >= 3) {
            conversation.push({
                role: 'system',
                content: 'Tool errors occurred 3 times in a row. You must try a completely different approach, or call attempt_completion to report progress and difficulties.'
            });
            this._consecutiveMistakes = 0;
        }

        if (errorCount > 0 && successCount === 0 && deniedCount === 0) {
            this._consecutiveFailures++;
        } else if (successCount > 0) {
            this._consecutiveFailures = 0;
        }

        if (this._consecutiveFailures >= this.maxConsecutiveFailures) {
            conversation.push({
                role: 'system',
                content: `All tool calls failed for ${this.maxConsecutiveFailures} consecutive rounds. Stop trying the same approach. Call attempt_completion to report what you've done and what difficulties you encountered.`
            });
            this._consecutiveFailures = 0;
        }

        if (!this._activePlan && round < 4) {
            let guidance = '';
            if (successCount > 0 && errorCount === 0 && deniedCount === 0) {
                guidance = 'All tools executed successfully. Determine task progress: if there are remaining steps → continue immediately, do not stop. If task is complete → call attempt_completion.';
            } else if (errorCount > 0) {
                guidance = 'Some tools failed. Analyze the error and try a different approach. Do not repeat the same failed action.';
            }
            if (guidance) conversation.push({ role: 'system', content: guidance });
        }

        if (round >= 2 && this._repeatTextCount > 0) {
            conversation.push({
                role: 'system',
                content: 'Your response is highly repetitive. Do NOT repeat what you already said. Call tools to take action, or call attempt_completion if the task is done.'
            });
        }

        if (round >= 3) {
            conversation.push({
                role: 'system',
                content: 'Multiple rounds have passed. Stop explaining and take action. Call tools to complete the task, or call attempt_completion. Every response must make progress.'
            });
        }
    }

    // =========================================================================
    // Reflection
    // =========================================================================

    async _reflectOnResult(toolName, result, goal) {
        try {
            const resultStr = typeof result === 'string' ? result.slice(0, 500) : JSON.stringify(result).slice(0, 500);
            const resp = await makeApiRequest(this._apiUrl, JSON.stringify({
                model: this._requestModel,
                messages: [
                    {
                        role: 'system',
                        content: `评估工具执行结果是否符合预期。只输出JSON，不要其他内容。
输出格式:
{"assessment":"success|partial|failed","next_action":"continue|retry|alternative|ask_user","reasoning":"简短原因","suggestion":"建议的替代方案(如果failed)"}
重要原则：
- 优先选择 retry 或 alternative，尽量自主解决问题
- 只有在确实无法通过工具解决时才选择 ask_user
- 如果是参数错误，选择 retry
- 如果是方法不对，选择 alternative`
                    },
                    { role: 'user', content: `目标: ${goal}\n工具: ${toolName}\n结果: ${resultStr}` }
                ],
                temperature: 0.2,
                stream: false
            }), this._apiHeaders);
            const match = resp.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) {}
        return { assessment: 'success', next_action: 'continue', reasoning: '' };
    }

    // =========================================================================
    // Message Compression
    // =========================================================================

    _compressIfNeeded(conversation) {
        const MAX_CHARS = 12000;
        const MAX_MSGS = 40;
        let total = conversation.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
        if (total <= MAX_CHARS && conversation.length <= MAX_MSGS) return;

        const system = conversation[0];
        const lastUser = conversation.filter(m => m.role === 'user').pop();
        const recent = conversation.slice(-6);
        const middle = conversation.slice(1, -6);

        const usedTools = new Set();
        let decisions = [];
        for (const m of middle) {
            if (m.tool_calls) m.tool_calls.forEach(tc => usedTools.add(tc.function.name));
            if (m.role === 'tool' && typeof m.content === 'string') {
                try {
                    const p = JSON.parse(m.content);
                    if (p.error) decisions.push(p.error.slice(0, 60));
                } catch (e) {}
            }
        }

        let summary = '[对话压缩] ';
        if (usedTools.size) summary += `使用工具: ${[...usedTools].join(', ')}。`;
        if (decisions.length) summary += `结果: ${decisions.slice(-3).join('; ')}。`;

        conversation.length = 0;
        conversation.push(system, { role: 'system', content: summary });
        if (lastUser && !recent.includes(lastUser)) conversation.push(lastUser);
        conversation.push(...recent);
    }
}

// =============================================================================
// 导出
// =============================================================================

module.exports = {
    AgentEngine,
    OutputManager,
    AgentState,
    SayType,
    AskType,
    AI_TOOLS,
    toolDescriptions,
    TOOL_DISPLAY_NAMES,
    TOOL_RISK,
    PLATFORMS,
    MODELS,
    getProviderForModel,
    getProviderInfo,
    buildApiHeaders,
    buildChatEndpoint,
    makeApiStreamRequest,
    makeApiRequest
};