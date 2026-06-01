/**
 * VersePC Agent Engine
 * 
 * 鏍稿績璁捐锛? * 1. 鐘舵€佹満椹卞姩锛欼DLE 鈫?RUNNING 鈫?STREAMING 鈫?ACTING 鈫?OBSERVING 鈫?REFLECTING 鈫?DONE
 * 2. 澧為噺娴佸紡杈撳嚭锛氫粎鍙戦€佹柊瀛楃锛屾秷鎭幓閲?(OutputManager)
 * 3. 浜嬩欢椹卞姩锛氱粺涓€ say/ask 娑堟伅鏍煎紡
 * 4. 鍏ㄥ姛鑳戒繚鐣欙細鎰忓浘妫€娴嬨€佽鍒掔敓鎴愩€佸崱姝绘娴嬨€佸弽鎬濄€佽鍔ㄦ娴嬨€佸苟琛屽伐鍏枫€佽繘搴﹁疆璇? */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { getPluginManager } = require('./plugin-manager');

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
// Output Manager (澧為噺杈撳嚭 + 鍘婚噸)
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
                    this.displayedMessages.set(ts, { ts, say, text, partial: true });
                    return { type: 'say', say, ts, text: delta.text, partial: true, delta: delta.action === 'delta' };
                }
                if (!isPartial && !alreadyComplete) {
                    const streamed = this.streamedContent.get(ts);
                    if (streamed && text && text.length > streamed.text.length && text.startsWith(streamed.text)) {
                        const remaining = text.slice(streamed.text.length);
                        this._finishStream(ts);
                        this.displayedMessages.set(ts, { ts, say, text, partial: false });
                        return { type: 'say', say, ts, text: remaining, partial: false, trailing: true };
                    }
                    this._finishStream(ts);
                    this.displayedMessages.set(ts, { ts, say, text, partial: false });
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
                return { type: 'say', say, ts, text, partial: false };

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
// ConversationManager 鈥?缁撴瀯鍖栦笂涓嬫枃绠＄悊
// =============================================================================

class ConversationManager {
    constructor(engine) {
        this.engine = engine;
        this.messages = [];
        this._toolMessages = new Map();
    }

    init(messages) {
        this.messages = [...messages];
        this._rebuildToolIndex();
        return this.messages;
    }

    push(msg) {
        this.messages.push(msg);
        return this.messages;
    }

    get() {
        return this.messages;
    }

    set(arr) {
        this.messages = arr;
        this._rebuildToolIndex();
        return this.messages;
    }

    lastUser() {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === 'user') return this.messages[i];
        }
        return null;
    }

    assistantMessages() {
        return this.messages.filter(m => m.role === 'assistant');
    }

    _rebuildToolIndex() {
        this._toolMessages.clear();
        for (const m of this.messages) {
            if (m.role === 'tool') this._toolMessages.set(m.tool_call_id, m);
        }
    }

    cleanupOrphanToolMessages() {
        const before = this.messages.length;
        this.messages = this.messages.filter(m => {
            if (m.role !== 'tool') return true;
            return this.messages.some(o => o.role === 'assistant' && o.tool_calls?.some(tc => tc.id === m.tool_call_id));
        });
        return before - this.messages.length;
    }

    compress(force) {
        const MAX_CHARS = 12000;
        const MAX_MSGS = 40;
        let total = 0;
        for (const m of this.messages) {
            if (typeof m.content === 'string') total += m.content.length;
            else if (Array.isArray(m.content)) {
                for (const p of m.content) {
                    if (p.type === 'text' && p.text) total += p.text.length;
                }
            }
        }

        const overLimit = total > MAX_CHARS || this.messages.length > MAX_MSGS;
        if (!force && !overLimit) return { compressed: false };

        const { systemMessages, rest } = this._splitSystemAndRest();
        if (rest.length <= 4) return { compressed: false };

        const targetMsgs = Math.max(6, Math.floor(rest.length * 0.5));
        const recent = rest.slice(-targetMsgs);
        const removed = rest.length - recent.length;

        const summaryParts = [];
        for (const m of rest.slice(0, -targetMsgs)) {
            if (m.role === 'user') {
                const content = typeof m.content === 'string' ? m.content : '';
                if (content) summaryParts.push(`鐢ㄦ埛: ${content.slice(0, 200)}`);
            } else if (m.role === 'assistant') {
                const content = typeof m.content === 'string' ? m.content : '';
                if (content) summaryParts.push(`AI: ${content.slice(0, 200)}`);
            }
        }

        const summaryMsg = {
            role: 'system',
            content: `[涓婁笅鏂囧帇缂? 宸插悎骞?${removed} 鏉℃秷鎭痌\n${summaryParts.join('\n')}`
        };

        this.messages = [...systemMessages, summaryMsg, ...recent];
        this._rebuildToolIndex();
        return { compressed: true, removed, totalBefore: this.messages.length + removed, totalAfter: this.messages.length };
    }

    _splitSystemAndRest() {
        const systemMessages = [];
        const rest = [];
        let foundNonSystem = false;
        for (const m of this.messages) {
            if (m.role === 'system' && !foundNonSystem) {
                systemMessages.push(m);
            } else {
                foundNonSystem = true;
                rest.push(m);
            }
        }
        return { systemMessages, rest };
    }
}

// =============================================================================
// ToolOrchestrator 鈥?宸ュ叿瑙ｆ瀽/鍒嗙被/鎵ц/鑱氬悎
// =============================================================================

class ToolOrchestrator {
    constructor(engine) {
        this.engine = engine;
    }

    parseFromResponse(response) {
        const toolCalls = response.tool_calls || [];
        if (toolCalls.length === 0) return { calls: [], hasTools: false };
        return { calls: toolCalls, hasTools: true };
    }

    aggregateResults(results) {
        let hasDenials = false;
        let hasErrors = false;
        let hasSuccess = false;
        let dryRunCount = 0;

        for (const r of results) {
            const raw = r.result || '';
            try {
                const parsed = JSON.parse(raw);
                if (parsed.status === 'denied') hasDenials = true;
                else if (parsed.status === 'error' || parsed.error) hasErrors = true;
                else if (parsed.status === 'dry_run') dryRunCount++;
                else hasSuccess = true;
            } catch {
                if (raw && !raw.includes('error')) hasSuccess = true;
                else hasErrors = true;
            }
        }

        return { hasDenials, hasErrors, hasSuccess, dryRunCount, total: results.length };
    }

    isReadOnly(toolName) {
        const READ_ONLY_TOOLS = new Set(['list_versions', 'read_file', 'get_version_info', 'list_mods', 'get_minecraft_versions', 'get_modloader_versions', 'search_mods', 'get_curseforge_categories', 'get_modrinth_categories', 'get_mod_details', 'get_mod_files', 'check_tool_installed']);
        return READ_ONLY_TOOLS.has(toolName);
    }
}

// =============================================================================
// SubAgentManager 鈥?瀛愪唬鐞嗙敓鍛藉懆鏈熺鐞?// =============================================================================

class SubAgentManager {
    constructor(engine) {
        this.engine = engine;
    }

    createEngine(agentType, task) {
        const config = SUBAGENT_CONFIGS[agentType];
        if (!config) return null;

        const subEngine = new AgentEngine({
            apiKey: this.engine._apiKey,
            model: this.engine._model,
            platform: this.engine._platform,
            apiUrl: this.engine._apiUrl,
            apiHeaders: this.engine._apiHeaders,
            enableTools: true,
            logger: this.engine.logger,
            onChunk: (chunk) => {
                this.engine._send({ type: 'subagent_chunk', agentType, chunk });
            },
            onRequestApproval: this.engine.onRequestApproval
        });

        subEngine._parentEngine = this.engine;
        subEngine._subAgentType = agentType;
        subEngine._isSubAgent = true;

        return subEngine;
    }

    async execute(agentType, task) {
        const meta = AGENT_META[agentType];
        if (!meta) return JSON.stringify({ status: 'error', error: `鏈煡瀛愪唬鐞嗙被鍨? ${agentType}` });

        this.engine._send({ type: 'subagent_start', agentType, name: meta.name, role: meta.role, avatar: meta.avatar, color: meta.color, task });

        const subEngine = this.createEngine(agentType, task);
        if (!subEngine) return JSON.stringify({ status: 'error', error: `鏃犳硶鍒涘缓瀛愪唬鐞? ${agentType}` });

        try {
            const messages = [
                { role: 'system', content: meta.systemPrompt },
                { role: 'user', content: task }
            ];

            await subEngine.processChat({
                apiKey: this.engine._apiKey,
                model: this.engine._model,
                messages,
                temperature: 0.3,
                enableTools: true,
                maxRounds: 8
            });

            const lastAssistant = (subEngine.conversation || []).filter(m => m.role === 'assistant').pop();
            const result = lastAssistant ? lastAssistant.content : '瀛愪唬鐞嗘湭杩斿洖缁撴灉';

            this.engine._send({ type: 'subagent_end', agentType, name: meta.name, result });
            return JSON.stringify({ status: 'completed', agentType, agentName: meta.name, result });
        } catch (e) {
            this.engine._send({ type: 'subagent_end', agentType, name: meta.name, error: e.message });
            return JSON.stringify({ status: 'error', agentType, agentName: meta.name, error: e.message });
        }
    }

    forwardEvent(event) {
        if (!this.engine._activeSubAgents || this.engine._activeSubAgents.size === 0) return false;
        for (const [agentType] of this.engine._activeSubAgents) {
            if (event.type === 'chunk') {
                const textChunk = event.raw || event.text || '';
                if (textChunk) {
                    this.engine.output.subAgentChunk(agentType, textChunk);
                }
            }
        }
        return true;
    }
}

// =============================================================================
// AI Platform & Provider 閰嶇疆锛堟墍鏈夊钩鍙帮級
// =============================================================================
// 缁撴瀯锛?//   PLATFORMS: providerKey 鈫?{ name, baseUrl, authType, apiFormat, thinkingParams }
//   MODELS: modelId 鈫?{ provider, name, free }
//
// apiFormat 鍙€夊€硷細'openai'(榛樿) | 'anthropic' | 'google'
// authType 鍙€夊€硷細'bearer'(榛樿) | 'x-api-key' | 'url_key'

const PLATFORMS = {
    zhipu: {
        name: '鏅鸿氨 GLM',
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
        name: '閫氫箟鍗冮棶',
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
        name: '闆朵竴涓囩墿',
        baseUrl: 'https://api.lingyiwanwu.com/v1',
        authType: 'bearer',
        apiFormat: 'openai',
        thinkingParams: {}
    },
    baichuan: {
        name: '鐧惧窛鏅鸿兘',
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
        name: '闃惰穬鏄熻景',
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
    // 鏅鸿氨 GLM
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
    // 閫氫箟鍗冮棶
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
    // 闆朵竴涓囩墿 Yi
    'yi-lightning': { provider: 'yi', name: 'Yi-Lightning', free: true },
    'yi-large': { provider: 'yi', name: 'Yi-Large' },
    'yi-large-turbo': { provider: 'yi', name: 'Yi-Large-Turbo' },
    'yi-medium': { provider: 'yi', name: 'Yi-Medium' },
    // 鐧惧窛
    'Baichuan4-Turbo': { provider: 'baichuan', name: 'Baichuan4-Turbo' },
    'Baichuan4-Air': { provider: 'baichuan', name: 'Baichuan4-Air' },
    'Baichuan4': { provider: 'baichuan', name: 'Baichuan4' },
    'Baichuan3-Turbo': { provider: 'baichuan', name: 'Baichuan3-Turbo' },
    // MiniMax
    'MiniMax-M2.7': { provider: 'minimax', name: 'MiniMax-M2.7' },
    'MiniMax-M2.5': { provider: 'minimax', name: 'MiniMax-M2.5' },
    'MiniMax-M2.1': { provider: 'minimax', name: 'MiniMax-M2.1' },
    // 闃惰穬鏄熻景
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

// Anthropic 娑堟伅鏍煎紡杞崲
function _toAnthropicMessages(messages) {
    const system = messages.find(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const result = { messages: [] };
    if (system) result.system = system.content;

    let i = 0;
    while (i < others.length) {
        const m = others[i];

        if (m.role === 'tool') {
            const toolResults = [];
            while (i < others.length && others[i].role === 'tool') {
                const toolContent = typeof others[i].content === 'string' ? others[i].content : '';
                toolResults.push({ type: 'tool_result', tool_use_id: others[i].tool_call_id || 'unknown', content: toolContent });
                i++;
            }
            if (toolResults.length > 0) {
                result.messages.push({ role: 'user', content: toolResults });
            }
            continue;
        }

        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
            for (const tc of m.tool_calls) {
                let input = {};
                try { input = JSON.parse(tc.function.arguments); } catch (e) {}
                content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
            }
        }

        if (content.length > 0) {
            result.messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
        }
        i++;
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

// Google Gemini 娑堟伅鏍煎紡杞崲
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
// Tool 瀹氫箟
// =============================================================================

const AI_TOOLS = [
    { type: 'function', function: { name: 'bash', description: 'Execute a bash command in a persistent shell session. State is preserved across calls. Use & for long-running commands.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The bash command to execute' }, restart: { type: 'boolean', description: 'Set true to restart the shell session' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'str_replace_based_edit_tool', description: 'File editing tool: view, create, and edit files. Commands: view (read file), create (new file), str_replace (exact string replacement), insert (insert at line). create cannot be used on existing files.', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'], description: 'Command to execute' }, path: { type: 'string', description: 'Absolute path to file or directory' }, file_text: { type: 'string', description: 'Required for create: file content' }, old_str: { type: 'string', description: 'Required for str_replace: exact string to replace (must be unique)' }, new_str: { type: 'string', description: 'New string for str_replace/insert' }, insert_line: { type: 'integer', description: 'Required for insert: line number to insert after' }, view_range: { type: 'array', items: { type: 'integer' }, description: 'Optional for view: line range [start, end]' } }, required: ['command', 'path'] } } },
    { type: 'function', function: { name: 'json_edit_tool', description: 'JSON file editing tool using JSONPath expressions. Operations: view, set, add, remove. Examples: $.users[0].name, $.config.database', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['view', 'set', 'add', 'remove'], description: 'Operation to perform' }, file_path: { type: 'string', description: 'Absolute path to JSON file' }, json_path: { type: 'string', description: 'JSONPath expression' }, value: { type: 'object', description: 'Value to set or add (required for set/add)' }, pretty_print: { type: 'boolean', description: 'Format output (default true)' } }, required: ['operation', 'file_path'] } } },
    { type: 'function', function: { name: 'sequential_thinking', description: 'Break down complex problems into sequential thinking steps. Each step produces a conclusion. Supports revising previous steps. Use when deep analysis is needed.', parameters: { type: 'object', properties: { thought: { type: 'string', description: 'Thinking content for current step' }, thought_number: { type: 'number', description: 'Current step number' }, total_thoughts: { type: 'number', description: 'Estimated total steps' }, next_thought_needed: { type: 'boolean', description: 'Whether another step is needed' }, is_revision: { type: 'boolean', description: 'Whether revising a previous step' }, revises_thought: { type: 'number', description: 'Step number being revised (when is_revision=true)' }, branch_from_thought: { type: 'number', description: 'Branch from this step (optional)' }, branch_id: { type: 'string', description: 'Branch identifier (optional)' } }, required: ['thought', 'thought_number', 'total_thoughts', 'next_thought_needed'] } } },
    { type: 'function', function: { name: 'attempt_completion', description: 'Report task completion. Only call after verifying the task is done. The result will be presented to the user for confirmation.', parameters: { type: 'object', properties: { result: { type: 'string', description: 'Final result message with summary of completed work' } }, required: ['result'] } } },
    { type: 'function', function: { name: 'ckg', description: 'Code Knowledge Graph: search for functions, classes, and class methods in the codebase.', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['search_function', 'search_class', 'search_class_method'], description: 'Search command' }, path: { type: 'string', description: 'Codebase path' }, identifier: { type: 'string', description: 'Function/class/method name to search' }, print_body: { type: 'boolean', description: 'Print function/class body (default true)' } }, required: ['command', 'path', 'identifier'] } } },
    { type: 'function', function: { name: 'update_todo_list', description: '鍒涘缓鎴栨洿鏂颁换鍔¤鍒掑垪琛ㄣ€備粎鍦ㄥ鐞嗗姝ラ澶嶆潅浠诲姟鏃朵娇鐢紝灏嗙敤鎴疯姹傚垎瑙ｄ负鍏蜂綋浠诲姟骞惰窡韪繘搴︺€傛牸寮忥細[ ] 寰呮墽琛? [-] 杩涜涓? [x] 宸插畬鎴愩€?, parameters: { type: 'object', properties: { todos: { type: 'string', description: '瀹屾暣鐨勪换鍔℃竻鍗曪紙Markdown鏍煎紡锛夈€傜ず渚嬶細\n- [ ] 浠诲姟1锛氬垎鏋愪唬鐮佺粨鏋刓n- [-] 浠诲姟2锛氫慨鏀笴SS鏍峰紡锛堝綋鍓嶆墽琛屼腑锛塡n- [x] 浠诲姟3锛氬凡淇bug' } }, required: ['todos'] } } },
    {
        type: 'function',
        function: {
            name: 'sub_agent_dispatch',
            description: '娲鹃仯瀛愪唬鐞嗘墽琛岀壒瀹氫换鍔°€俧ile_search: 鍦ㄤ唬鐮佸簱涓悳绱㈡枃浠跺拰鐩綍, code_analysis: 鍒嗘瀽浠ｇ爜缁撴瀯鍜岃皟鐢ㄩ摼, resource_download: 鎼滅储Minecraft璧勬簮, crash_analysis: 鍒嗘瀽宕╂簝鏃ュ織',
            parameters: {
                type: 'object',
                properties: {
                    agent_type: {
                        type: 'string',
                        enum: ['file_search', 'code_analysis', 'resource_download', 'crash_analysis'],
                        description: '瀛愪唬鐞嗙被鍨?
                    },
                    task: {
                        type: 'string',
                        description: '瀛愪唬鐞嗚鎵ц鐨勫叿浣撲换鍔℃弿杩?
                    }
                },
                required: ['agent_type', 'task']
            }
        }
    },
];

let _pluginManager = null;
function _getPluginTools() {
    try {
        if (!_pluginManager) _pluginManager = getPluginManager();
        return _pluginManager.getTools();
    } catch (e) { return []; }
}

function _getPluginDisplayNames() {
    try {
        if (!_pluginManager) _pluginManager = getPluginManager();
        return _pluginManager.getToolDisplayNames();
    } catch (e) { return {}; }
}

function _getPluginRisks() {
    try {
        if (!_pluginManager) _pluginManager = getPluginManager();
        return _pluginManager.getToolRisks();
    } catch (e) { return {}; }
}

function _getPluginPromptExtensions() {
    try {
        if (!_pluginManager) _pluginManager = getPluginManager();
        return _pluginManager.getPromptExtensions();
    } catch (e) { return []; }
}

function _isPluginTool(name) {
    try {
        if (!_pluginManager) _pluginManager = getPluginManager();
        return _pluginManager.isPluginTool(name);
    } catch (e) { return false; }
}

function _getAllTools() {
    return [...AI_TOOLS, ..._getPluginTools()];
}

const toolDescriptions = AI_TOOLS.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n');

const TOOL_RISK = {
    str_replace_based_edit_tool: 'safe', json_edit_tool: 'safe', ckg: 'safe',
    sequential_thinking: 'safe', attempt_completion: 'safe',
    bash: 'safe', update_todo_list: 'safe',
    sub_agent_dispatch: 'safe'
};

const PASSIVE_PATTERNS = [
    /鎴戞棤娉?, /鎴戦渶瑕?*淇℃伅/, /璇锋彁渚?, /鎴戦渶瑕佺煡閬?, /浣犺兘涓嶈兘/,
    /璇峰憡璇夋垜/, /鎴戦渶瑕佷綘/, /璇峰厛/, /鎴戦渶瑕佹洿澶?, /鎴戞病鍔炴硶/,
    /鎴戠湅涓嶅埌/, /鎴戣闂笉浜?, /鎴戞棤娉曡闂?, /鎴戞棤娉曟煡鐪?, /鎴戞病鏈夋潈闄?,
    /I can't/, /I need.*information/, /please provide/, /I need to know/,
    /could you/, /can you please/, /I need you to/, /please tell me/,
    /I don't have access/, /I'm unable to/, /I cannot access/, /I don't have permission/,
    /I can't see/, /I'm not able to/, /would you mind/
];

const PASSIVE_NEEDS_TOOLS = /瑁厊瀹夎|鍚姩|鍋滄|鎼滅储|鏌ユ壘|鏌ョ湅|妫€鏌淇|淇敼|鍒犻櫎|涓嬭浇|宕╂簝|鏃ュ織|閰嶇疆|璁剧疆|鐗堟湰|妯＄粍|鏁村悎鍖厊姹夊寲|鏂囦欢|鏂囦欢澶箌鐩綍|浼樺寲|鎺ㄨ崘|鎵緗甯畖鐪嬬湅|鏈夋病鏈墊鑳戒笉鑳絴鎬庝箞|濡備綍|install|search|find|check|fix|modify|delete|download|crash|log|config|setup|version|mod|file|folder|optimize|help|show|list|read|write|create|update|remove/;

const TOOL_DISPLAY_NAMES = {
    bash: '鎵ц鍛戒护', str_replace_based_edit_tool: '缂栬緫鏂囦欢',
    json_edit_tool: '缂栬緫JSON', sequential_thinking: '鍒嗘鎬濊€?,
    attempt_completion: '瀹屾垚浠诲姟', ckg: '浠ｇ爜鍥捐氨',
    update_todo_list: '鏇存柊璁″垝',
    sub_agent_dispatch: '娲鹃仯瀛愪唬鐞?
};

const AGENT_META = {
    file_search: {
        name: '鏂囦欢鎼滅储浠ｇ悊', role: 'File Search', avatar: 'robot', color: '#4caf50',
        systemPrompt: `浣犳槸 VersePC 椤圭洰鐨勬枃浠舵悳绱唬鐞嗐€備綘鐨勪换鍔℃槸鍦ㄤ唬鐮佸簱涓揩閫熷畾浣嶆枃浠跺拰鐩綍銆?
## 宸ヤ綔娴佺▼
1. 棣栧厛鐞嗚В鎼滅储鐩爣锛堟枃浠跺悕銆佸叧閿瘝銆佹枃浠剁被鍨嬬瓑锛?2. 浣跨敤 bash 宸ュ叿鎵ц鎼滅储鍛戒护锛?   - 鎸夋枃浠跺悕鎼滅储: find . -name "pattern" -type f
   - 鎸夊唴瀹规悳绱? grep -r "pattern" --include="*.js" --include="*.css" --include="*.html" -l
   - 鏌ョ湅鐩綍缁撴瀯: ls -la, tree (闄愬埗娣卞害)
   - 鏌ョ湅鏂囦欢淇℃伅: wc -l, file, stat
3. 瀵规悳绱㈢粨鏋滆繘琛岀瓫閫夊拰鎺掑簭
4. 杈撳嚭缁撴瀯鍖栫粨鏋?
## 杈撳嚭鏍煎紡
鎼滅储瀹屾垚鍚庯紝鐢ㄤ互涓嬫牸寮忔€荤粨锛?- 鎼滅储鐩爣锛歺xx
- 鎵惧埌 N 涓枃浠?- 鍏抽敭鏂囦欢鍒楄〃锛堣矾寰?+ 鐢ㄩ€旇鏄庯級
- 鐩稿叧浠ｇ爜鐗囨锛堝鏈夛級

## 娉ㄦ剰浜嬮」
- 浼樺厛鎼滅储椤圭洰鏍圭洰褰曚笅鐨?js/銆乧ss/銆乤gent-engine.js 绛夋牳蹇冩枃浠?- 鎼滅储鏃舵帓闄?node_modules銆乨ist銆?git 鐩綍
- 濡傛灉鎼滅储缁撴灉杩囧锛屾寜鐩稿叧鎬ф帓搴忥紝鍙睍绀烘渶鐩稿叧鐨?- 鐢ㄤ腑鏂囪緭鍑虹粨鏋渀
    },
    code_analysis: {
        name: '浠ｇ爜鍒嗘瀽浠ｇ悊', role: 'Code Analysis', avatar: 'robot', color: '#9c27b0',
        systemPrompt: `浣犳槸 VersePC 椤圭洰鐨勪唬鐮佸垎鏋愪唬鐞嗐€備綘鐨勪换鍔℃槸鍒嗘瀽浠ｇ爜缁撴瀯銆佺悊瑙ｉ」鐩灦鏋勩€佽拷韪嚱鏁拌皟鐢ㄩ摼銆?
## 宸ヤ綔娴佺▼
1. 棣栧厛纭畾鍒嗘瀽鐩爣锛堟枃浠躲€佸嚱鏁般€佹ā鍧楋級
2. 浣跨敤 bash 宸ュ叿闃呰浠ｇ爜锛?   - cat 鏌ョ湅鏂囦欢鍐呭
   - grep 鎼滅储鍑芥暟璋冪敤
   - find 鏌ユ壘鐩稿叧鏂囦欢
3. 鍒嗘瀽浠ｇ爜缁撴瀯鍜屼緷璧栧叧绯?4. 杈撳嚭鍒嗘瀽鎶ュ憡

## 鍒嗘瀽缁村害
- 鏂囦欢鑱岃矗锛氳鏂囦欢鐨勪富瑕佸姛鑳?- 渚濊禆鍏崇郴锛氫緷璧栦簡鍝簺妯″潡锛岃鍝簺妯″潡渚濊禆
- 鍑芥暟璋冪敤閾撅細鍏抽敭鍑芥暟鐨勮皟鐢ㄨ矾寰?- 鏁版嵁娴侊細鏁版嵁濡備綍鍦ㄦā鍧楅棿浼犻€?- 娼滃湪闂锛氬彂鐜扮殑 bug銆佹€ц兘闂銆佷唬鐮佸紓鍛?
## 杈撳嚭鏍煎紡
鍒嗘瀽瀹屾垚鍚庯紝鐢ㄤ互涓嬫牸寮忔€荤粨锛?- 鍒嗘瀽鐩爣锛歺xx
- 鏂囦欢缁撴瀯锛氬垪鍑虹浉鍏虫枃浠跺強鍏惰亴璐?- 鏍稿績閫昏緫锛氬叧閿嚱鏁板拰璋冪敤閾?- 鍙戠幇鐨勯棶棰橈紙濡傛湁锛夛細闂鎻忚堪 + 寤鸿淇鏂规

## 娉ㄦ剰浜嬮」
- 鐢ㄤ腑鏂囪緭鍑哄垎鏋愮粨鏋?- 浠ｇ爜鐗囨淇濈暀鍘熷鏍煎紡
- 琛屽彿寮曠敤鏍煎紡锛氭枃浠跺悕:琛屽彿`
    },
    resource_download: {
        name: '璧勬簮鎼滅储浠ｇ悊', role: 'Resource Search', avatar: 'robot', color: '#8d6e63',
        systemPrompt: `浣犳槸 Minecraft 璧勬簮鎼滅储浠ｇ悊銆備綘鐨勪换鍔℃槸鎼滅储鍜屾帹鑽?Minecraft 鐩稿叧璧勬簮銆?
## 鏀寔鐨勮祫婧愮被鍨?- Mod锛堟ā缁勶級
- 鏁村悎鍖咃紙Modpack锛?- 鏉愯川鍖咃紙Texture Pack锛?- 鍏夊奖鍖咃紙Shader Pack锛?
## 宸ヤ綔娴佺▼
1. 鐞嗚В鐢ㄦ埛闇€姹傦紙鐗堟湰銆佺被鍨嬨€佸姛鑳藉亸濂斤級
2. 鎼滅储 CurseForge 鍜?Modrinth 涓婄殑璧勬簮
3. 绛涢€夊拰鎺ㄨ崘

## 鎺ㄨ崘鏍囧噯
- 鐗堟湰鍏煎鎬э細浼樺厛鎺ㄨ崘涓庣敤鎴?Minecraft 鐗堟湰鍏煎鐨勮祫婧?- 绋冲畾鎬э細浼樺厛鎺ㄨ崘鏇存柊棰戠箒銆乥ug 灏戠殑璧勬簮
- 涓嬭浇閲忓拰璇勫垎锛氫綔涓哄弬鑰冩寚鏍?- 鍏煎鎬э細鎺ㄨ崘鐨勮祫婧愪箣闂翠笉瑕佹湁鍐茬獊

## 杈撳嚭鏍煎紡
- 璧勬簮鍚嶇О + 绠€浠?- 鐗堟湰鍏煎淇℃伅
- 涓嬭浇閲?璇勫垎
- 瀹夎寤鸿
- 娉ㄦ剰浜嬮」锛堝鏈夛級

## 娉ㄦ剰浜嬮」
- 鐢ㄤ腑鏂囪緭鍑烘帹鑽愮粨鏋?- 濡傛灉璧勬簮闇€瑕佸墠缃緷璧栵紝涓€骞惰鏄巂
    },
    crash_analysis: {
        name: '宕╂簝鍒嗘瀽浠ｇ悊', role: 'Crash Analysis', avatar: 'robot', color: '#9e9e9e',
        systemPrompt: `浣犳槸 Minecraft 宕╂簝鍒嗘瀽浠ｇ悊銆備綘鐨勪换鍔℃槸鍒嗘瀽宕╂簝鏃ュ織锛屽畾浣嶉敊璇師鍥犲苟鎻愪緵淇寤鸿銆?
## 宸ヤ綔娴佺▼
1. 瀹氫綅鏃ュ織鏂囦欢锛坈rash-reports/銆乴ogs/ 鐩綍锛?2. 浣跨敤 bash 宸ュ叿璇诲彇鍜屽垎鏋愭棩蹇?3. 璇嗗埆宕╂簝绫诲瀷鍜屽師鍥?4. 鎻愪緵淇寤鸿

## 宕╂簝绫诲瀷璇嗗埆
- Mod 鍐茬獊锛氭鏌ュ涓?Mod 鐨勫吋瀹规€?- 鍐呭瓨涓嶈冻锛氭鏌?JVM 鍙傛暟鍜屽唴瀛樺垎閰?- 閰嶇疆閿欒锛氭鏌ラ厤缃枃浠舵牸寮忓拰鍊?- 鐗堟湰涓嶅吋瀹癸細妫€鏌?Mod 涓?Minecraft 鐗堟湰鐨勫吋瀹规€?- 椹卞姩闂锛氭鏌ユ樉鍗￠┍鍔ㄧ増鏈?- Java 鐗堟湰锛氭鏌?Java 鐗堟湰鏄惁鍖归厤

## 杈撳嚭鏍煎紡
- 宕╂簝绫诲瀷锛歺xx
- 閿欒鍘熷洜锛氳缁嗘弿杩?- 娑夊強鏂囦欢锛氱浉鍏虫棩蹇楁枃浠跺拰閰嶇疆鏂囦欢
- 淇姝ラ锛氭寜浼樺厛绾ф帓鍒楃殑淇鏂规
- 棰勯槻寤鸿锛氶伩鍏嶅啀娆″彂鐢熺殑鏂规硶

## 娉ㄦ剰浜嬮」
- 鐢ㄤ腑鏂囪緭鍑哄垎鏋愮粨鏋?- 寮曠敤鍏抽敭鏃ュ織琛岋紙鏂囦欢:琛屽彿锛?- 淇姝ラ瑕佸叿浣撳彲鎿嶄綔`
    }
};



// =============================================================================
// HTTP API 宸ュ叿
// =============================================================================

function makeApiStreamRequest(apiUrl, bodyStr, headers) {
    const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || undefined,
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
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('API杩炴帴瓒呮椂(60s)')); });
        req.write(bodyStr);
        req.end();
    });
}

function makeApiRequest(apiUrl, bodyStr, headers) {
    const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || undefined,
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
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('API璇锋眰瓒呮椂(30s)')); });
        req.write(bodyStr);
        req.end();
    });
}

// =============================================================================
// Agent Engine (鍏ㄥ姛鑳?
// =============================================================================

class AgentEngine {
    constructor(options = {}) {
        this.onChunk = options.onChunk || (() => {});
        this.onRequestApproval = options.onRequestApproval || null;
        this.executeTool = options.executeTool || null;
        this.output = new OutputManager();
        this.conv = new ConversationManager(this);
        this.tools = new ToolOrchestrator(this);
        this.subAgents = new SubAgentManager(this);

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
        const passthroughTypes = ['subagent_start', 'subagent_chunk', 'subagent_end'];
        if (passthroughTypes.includes(msg.type)) {
            this.onChunk(msg);
            return;
        }
        const processed = this.output.processMessage(msg);
        if (processed) {
            this.onChunk(processed);
        }
    }

    _initReasoningThrottle() {
        if (this._reasoningFlushTimer) {
            clearTimeout(this._reasoningFlushTimer);
            this._reasoningFlushTimer = null;
        }
        this._reasoningBuffer = null;
        this._reasoningStarted = false;
    }

    _sendReasoningDelta(delta, fullReasoning) {
        if (!this._reasoningStarted) {
            this._reasoningStarted = true;
            this.onChunk({ type: 'reasoning_start', content: '' });
        }
        this._reasoningBuffer = (this._reasoningBuffer || '') + delta;
        if (!this._reasoningFlushTimer) {
            this._reasoningFlushTimer = setTimeout(() => {
                this._reasoningFlushTimer = null;
                if (this._reasoningBuffer) {
                    const buf = this._reasoningBuffer;
                    this._reasoningBuffer = null;
                    this.onChunk({ type: 'reasoning_content', content: buf, partial: true });
                }
            }, 80);
        }
    }

    _flushReasoningThrottle() {
        if (this._reasoningFlushTimer) {
            clearTimeout(this._reasoningFlushTimer);
            this._reasoningFlushTimer = null;
        }
        if (this._reasoningStarted && this._reasoningBuffer) {
            const buf = this._reasoningBuffer;
            this._reasoningBuffer = null;
            this.onChunk({ type: 'reasoning_content', content: buf, partial: true });
        }
    }

    _finishReasoningThrottle() {
        if (this._reasoningFlushTimer) {
            clearTimeout(this._reasoningFlushTimer);
            this._reasoningFlushTimer = null;
        }
        this._reasoningBuffer = null;
        this._reasoningStarted = false;
    }

    /**
     * 涓诲叆鍙ｏ細澶勭悊鑱婂ぉ
     */
    async processChat({ apiKey, model, messages, temperature, enableTools, apiFormat: customApiFormat, baseUrl: customBaseUrl, language, projectDir }) {
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
        this._round3GuidanceSent = false;
        this._errorMemory = [];
        this._reflectionCache = new Map();
        this._model = model || 'glm-5-flash';
        this._projectDir = projectDir || null;

        if (!apiKey) {
            this._send({ type: 'say', say: SayType.ERROR, text: '鏈厤缃?API Key锛岃鍦ㄨ缃腑濉啓' });
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
        const tools = enableTools !== false ? _getAllTools() : undefined;

        this.conversation = this.conv.init(messages);
        let conversation = this.conversation;
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

        const contextSummary = this._buildContextSummary();
        if (contextSummary) conversation.push({ role: 'system', content: contextSummary });

        if (this._projectDir) {
            conversation.push({ role: 'system', content: `褰撳墠椤圭洰宸ヤ綔鐩綍: ${this._projectDir}\n璇峰湪姝ょ洰褰曚笅鎵ц鎵€鏈夋枃浠舵搷浣滃懡浠ゃ€備娇鐢?bash 宸ュ叿鏃讹紝鍏?cd 鍒版鐩綍鍐嶆墽琛屾搷浣溿€俙 });
        }

        conversation.push({ role: 'system', content: 'OS: Windows. Use CMD commands only: dir (not ls), type (not cat), findstr (not grep), copy (not cp), move (not mv), del (not rm), mkdir, rmdir, more (not head/tail). Pipe: | more. Redirect: > file 2>&1. NEVER use Unix/Linux commands.' });

        const pluginPrompts = _getPluginPromptExtensions();
        if (pluginPrompts.length > 0) {
            conversation.push({ role: 'system', content: '## Plugin Capabilities\n\n' + pluginPrompts.join('\n\n') });
        }

        if (this.enablePlanning && lastUserMsg && tools) {
            const intent = this._detectIntent(lastUserMsg.content);
            if (intent.intent === 'complex') {
                const stepHint = intent.steps_needed >= 3
                    ? `杩欐槸涓€涓鏉傜殑澶氭楠や换鍔★紙妫€娴嬪埌 ${intent.steps_needed}+ 涓楠わ級銆俙
                    : '杩欐槸涓€涓渶瑕佸姝ラ鎵ц鐨勪换鍔°€?;
                conversation.push({
                    role: 'system',
                    content: `${stepHint}

## 浠诲姟宸ヤ綔娴?
璇蜂娇鐢?update_todo_list 宸ュ叿鍒涘缓浠诲姟璁″垝锛屽皢鐢ㄦ埛鐨勮姹傚垎瑙ｄ负鍏蜂綋鐨勩€佸彲鎵ц鐨勪换鍔°€?
### 鎵ц娴佺▼
1. 璋冪敤 update_todo_list 鍒涘缓浠诲姟鍒楄〃
   - [ ] 浠诲姟1锛氬叿浣撴弿杩?   - [ ] 浠诲姟2锛氬叿浣撴弿杩?   - [ ] 浠诲姟3锛氬叿浣撴弿杩?2. 閫愪釜鎵ц浠诲姟锛?   a. 灏嗗綋鍓嶄换鍔℃爣璁颁负 [-] 杩涜涓紙璋冪敤 update_todo_list锛?   b. 鎵ц璇ヤ换鍔℃墍闇€鐨勬墍鏈夊伐鍏疯皟鐢?   c. 浠诲姟瀹屾垚鍚庯紝灏嗕换鍔℃爣璁颁负 [x] 宸插畬鎴愶紙璋冪敤 update_todo_list锛?3. 鎵€鏈変换鍔″畬鎴愬悗锛岃皟鐢?attempt_completion 鎻愪氦鏈€缁堟€荤粨

### 鍏抽敭瑙勫垯
- 姣忎釜浠诲姟搴旇鏄嚜鍖呭惈鐨勶紝灏嗙浉鍏崇殑宸ュ叿璋冪敤褰掔粍鍒颁竴璧?- attempt_completion 鐨?result 瀛楁蹇呴』鍖呭惈娓呮櫚鐨勪腑鏂囨€荤粨
- 濡傛灉鏌愪釜浠诲姟澶辫触锛屾爣璁颁负 [x] 骞舵敞鏄庨敊璇紝鐒跺悗缁х画涓嬩竴涓换鍔?- 姘歌繙涓嶈鍦ㄥ洖澶嶄腑浣跨敤 emoji

### 瀛愪唬鐞嗘淳閬ｈ鍒?褰撲綘闇€瑕佹悳绱㈡枃浠躲€佸垎鏋愪唬鐮併€佹悳绱㈣祫婧愭垨鍒嗘瀽宕╂簝鏃ュ織鏃讹紝浣犲繀椤昏皟鐢?sub_agent_dispatch 宸ュ叿锛岃€屼笉鏄嚜宸辨墽琛岃繖浜涗换鍔°€?- 鎼滅储鏂囦欢/鐩綍 鈫?sub_agent_dispatch(agent_type="file_search", task="鍏蜂綋浠诲姟鎻忚堪")
- 鍒嗘瀽浠ｇ爜缁撴瀯 鈫?sub_agent_dispatch(agent_type="code_analysis", task="鍏蜂綋浠诲姟鎻忚堪")
- 鎼滅储Minecraft璧勬簮 鈫?sub_agent_dispatch(agent_type="resource_download", task="鍏蜂綋浠诲姟鎻忚堪")
- 鍒嗘瀽宕╂簝鏃ュ織 鈫?sub_agent_dispatch(agent_type="crash_analysis", task="鍏蜂綋浠诲姟鎻忚堪")
缁濆涓嶈鍦ㄦ枃鏈腑鍐?[鎵ц] 璋冪敤瀛愪唬鐞?锛岃€屾槸蹇呴』瀹為檯璋冪敤 sub_agent_dispatch 宸ュ叿銆俙
                });
            } else {
                conversation.push({
                    role: 'system',
                    content: `## 鎵ц鎸囧崡

杩欐槸涓€涓畝鍗曠殑浠诲姟锛岃鐩存帴鎵ц锛屼笉闇€瑕佸垱寤轰换鍔¤鍒掋€?
### 鎵ц娴佺▼
1. 鐩存帴浣跨敤宸ュ叿瀹屾垚鐢ㄦ埛璇锋眰
2. 鎵ц瀹屾垚鍚庯紝璋冪敤 attempt_completion 鎻愪氦缁撴灉鎬荤粨

### 鍏抽敭瑙勫垯
- 涓嶈璋冪敤 update_todo_list锛岀洿鎺ュ紑濮嬫墽琛?- 鐢ㄤ腑鏂囧啓鎬荤粨
- attempt_completion 鐨?result 瀛楁蹇呴』鍖呭惈娓呮櫚鐨勪腑鏂囨€荤粨
- 姘歌繙涓嶈鍦ㄥ洖澶嶄腑浣跨敤 emoji
- 褰撻渶瑕佹悳绱㈡枃浠躲€佸垎鏋愪唬鐮併€佹悳绱㈣祫婧愭垨鍒嗘瀽宕╂簝鏃ュ織鏃讹紝蹇呴』璋冪敤 sub_agent_dispatch 宸ュ叿锛屼笉瑕佸湪鏂囨湰涓弿杩颁綘瑕佸仛浠€涔堬紝鑰屾槸瀹為檯璋冪敤宸ュ叿`
                });
            }
        }

        if (language && language !== 'en') {
            const _langNames = { 'zh-CN': '绠€浣撲腑鏂?, 'zh-TW': '绻侀珨涓枃', 'ja': '鏃ユ湰瑾?, 'ko': '頃滉淡鞏? };
            const _langName = _langNames[language] || '绠€浣撲腑鏂?;
            conversation.push({
                role: 'system',
                content: `FINAL REMINDER 鈥?Language: You MUST respond entirely in ${_langName}. All explanations, todo descriptions, plan text, and completion summaries must be in ${_langName}. Only code, file paths, and technical identifiers stay in English.`
            });
        }

        let _lastCompletionText = '';

        for (let round = 0; round < this.maxRounds; round++) {
            if (this._aborted) break;
            await new Promise(resolve => setImmediate(resolve));

            if (apiFormat === 'openai') {
                const toRemove = new Set();
                for (let i = 0; i < conversation.length; i++) {
                    const msg = conversation[i];
                    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
                        const foundIds = new Set();
                        for (let j = i + 1; j < conversation.length; j++) {
                            const next = conversation[j];
                            if (next.role === 'assistant') break;
                            if (next.role === 'tool' && expectedIds.has(next.tool_call_id)) {
                                foundIds.add(next.tool_call_id);
                            }
                        }
                        if (foundIds.size < expectedIds.size) {
                            toRemove.add(i);
                            for (let j = i + 1; j < conversation.length; j++) {
                                if (conversation[j].role === 'assistant') break;
                                if (conversation[j].role === 'tool') toRemove.add(j);
                            }
                        }
                    }
                }
                for (let i = conversation.length - 1; i >= 0; i--) {
                    if (toRemove.has(i)) conversation.splice(i, 1);
                }
                for (let i = conversation.length - 1; i >= 0; i--) {
                    if (conversation[i].role === 'tool') {
                        let hasAssistantBefore = false;
                        for (let j = i - 1; j >= 0; j--) {
                            if (conversation[j].role === 'assistant') {
                                hasAssistantBefore = conversation[j].tool_calls && conversation[j].tool_calls.length > 0;
                                break;
                            }
                        }
                        if (!hasAssistantBefore) conversation.splice(i, 1);
                    }
                }
            }

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
            const MAX_RETRIES = 2;
            let lastError = null;
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    this._send({ type: 'say', say: SayType.API_STARTED, text: '' });
                    res = await makeApiStreamRequest(this._apiUrl, bodyStr, this._apiHeaders);
                    lastError = null;
                    break;
                } catch (e) {
                    lastError = e;
                    const isRetryable = e.message && (e.message.includes('ECONNRESET') || e.message.includes('ECONNREFUSED') || e.message.includes('ETIMEDOUT') || e.message.includes('socket hang up'));
                    if (isRetryable && attempt < MAX_RETRIES) {
                        this._send({ type: 'say', say: SayType.HEARTBEAT, text: `杩炴帴涓柇锛屾鍦ㄩ噸璇?(${attempt + 1}/${MAX_RETRIES})...` });
                        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                        continue;
                    }
                    this._send({ type: 'say', say: SayType.ERROR, text: e.message });
                    this._send({ type: 'say', say: SayType.API_FINISHED, text: '' });
                    return;
                }
            }
            if (lastError) {
                this._send({ type: 'say', say: SayType.ERROR, text: lastError.message });
                this._send({ type: 'say', say: SayType.API_FINISHED, text: '' });
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
                    this._send({ type: 'say', say: SayType.ERROR, text: '妫€娴嬪埌寰幆璋冪敤锛屽凡鑷姩涓柇' });
                    this._send({
                        type: 'say', say: SayType.TOOL_START,
                        text: JSON.stringify(roundData.toolCalls.map(tc => ({
                            id: tc.id, name: tc.name,
                            displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name,
                            args: tc.argsStr
                        })))
                    });
                    for (const tc of roundData.toolCalls) {
                        this._send({
                            type: 'say', say: SayType.TOOL_RESULT,
                            text: JSON.stringify({ id: tc.id, name: tc.name, error: '妫€娴嬪埌寰幆璋冪敤锛屽凡鑷姩涓柇' })
                        });
                    }
                    this._send({ type: 'say', say: SayType.TOOL_END, text: '' });
                    conversation.push({
                        role: 'system',
                        content: 'AGENT STATE: STUCK 鈥?Loop detected. You must try a completely different approach, or call attempt_completion to report current progress and difficulties.'
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

                for (const tr of toolResults) {
                    if (tr.reflectionGuidance) {
                        conversation.push({ role: 'system', content: tr.reflectionGuidance });
                    }
                }

                this._evaluateAndGuide(toolResults, conversation, lastUserMsg, round);

                if (toolResults.some(r => r.isCompletion)) break;

                this.conv.compress();
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

            this._send({ type: 'say', say: SayType.COMPLETION, text: roundData.fullContent || _lastCompletionText || '' });
            this._send({ type: 'say', say: SayType.API_FINISHED, text: '' });
            return;
        }

        this._send({ type: 'say', say: SayType.COMPLETION, text: _lastCompletionText || '' });
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
                let s = '## 褰撳墠宸ヤ綔鍖虹姸鎬侊紙鑷姩鑾峰彇锛屾棤闇€璇㈤棶鐢ㄦ埛锛塡n';
                if (settings.selectedVersion) s += `- 褰撳墠鐗堟湰: ${settings.selectedVersion}\n`;
                if (settings.javaPath) s += `- Java璺緞: ${settings.javaPath}\n`;
                if (settings.maxMemory) s += `- 鏈€澶у唴瀛? ${settings.maxMemory}\n`;
                if (settings.gameDir) s += `- 娓告垙鐩綍: ${settings.gameDir}\n`;
                s += '\n浠ヤ笂淇℃伅宸茶嚜鍔ㄨ幏鍙栥€傚闇€鏇磋缁嗙殑淇℃伅锛堟ā缁勫垪琛ㄣ€佺増鏈垪琛ㄧ瓑锛夛紝璇蜂娇鐢ㄥ伐鍏疯幏鍙栥€?;
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
        const simplePatterns = /^(浣犲ソ|hi|hello|hey|璋㈣阿|鎰熻阿|ok|濂界殑|鐭ラ亾浜唡浣犳槸璋亅浣犲彨浠€涔坾甯垜瑙ｉ噴|浣犳槸|璇磋|鑱婅亰|璁茶|鍛婅瘔鎴?/;
        if (simplePatterns.test(lower)) return { intent: 'simple', reason: 'greeting', steps_needed: 0 };
        if (userMessage.length < 10) return { intent: 'simple', reason: 'short', steps_needed: 0 };

        const questionPatterns = /鏄粈涔坾浠€涔堟剰鎬潀鏈変粈涔堢敤|鏈変粈涔堝尯鍒珅鍖哄埆鏄粈涔坾鎬庝箞鐞嗚В|鎬庝箞鐢▅鎬庝箞寮剕鎬庝箞鎼瀨鑳戒笉鑳絴鍙互鍚梶鍚梊?|鍚楋紵|璇疯В閲妡璇疯鏄巪璇蜂粙缁峾鎺ㄨ崘|鐜╂硶|鎶€宸鏈哄埗|鍘熺悊|瑙勫垯|鏁欑▼|鏀荤暐|鏌ョ湅|鐪嬬湅|鐪嬩竴涓媩甯垜鏌鏌ヤ竴涓媩鏌ヨ/;
        if (questionPatterns.test(lower)) return { intent: 'simple', reason: 'question', steps_needed: 0 };

        const explicitMultiStep = /鐒跺悗|鎺ョ潃|涔嬪悗鍐峾鍏?*鍐峾鍏?*鐒跺悗|涔嬪悗鍐峾绗竴姝?*绗簩姝棣栧厛.*鐒跺悗.*鏈€鍚巪涓€鏂归潰.*鍙︿竴鏂归潰|涓嶄粎.*鑰屼笖|鏃㈣.*涔熻/;
        if (explicitMultiStep.test(lower)) {
            const conjunctionCount = (lower.match(/鐒跺悗|鎺ョ潃|涔嬪悗鍐峾鍐??!娆?/g) || []).length;
            return { intent: 'complex', reason: 'explicit_multi_step', steps_needed: conjunctionCount + 1 };
        }

        const separateActions = /瀹夎.*(?:骞朵笖|骞秥鐒跺悗|鍐峾鎺ョ潃)|(?:瀹夎|閰嶇疆|鍒涘缓|淇敼|鍒犻櫎|淇|浼樺寲).*(?:瀹夎|閰嶇疆|鍒涘缓|淇敼|鍒犻櫎|淇|浼樺寲)/;
        if (separateActions.test(lower)) {
            const actionCount = (lower.match(/(?:瀹夎|鍗歌浇|鍒涘缓|鍒犻櫎|淇敼|缂栬緫|閰嶇疆|閮ㄧ讲|鏋勫缓|缂栬瘧|璋冭瘯|淇|浼樺寲|杩佺Щ|鍗囩骇)/g) || []).length;
            if (actionCount >= 2) return { intent: 'complex', reason: 'multi_action', steps_needed: actionCount };
        }

        if (userMessage.length > 120) {
            const actionCount = (lower.match(/(?:瀹夎|鍗歌浇|鍒涘缓|鍒犻櫎|淇敼|缂栬緫|閰嶇疆|閮ㄧ讲|鏋勫缓|缂栬瘧|璋冭瘯|淇|浼樺寲|杩佺Щ|鍗囩骇|鍐檤鍋殀杩愯|鎵ц)/g) || []).length;
            if (actionCount >= 3) return { intent: 'complex', reason: 'long_multi_action', steps_needed: actionCount };
        }

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
        this._initReasoningThrottle();

        await new Promise((resolve) => {
            let inactivityTimer = setTimeout(() => resolve('timeout'), 60000);
            const TOTAL_TIMEOUT = 300000;
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
                    inactivityTimer = setTimeout(() => finish('timeout'), 60000);
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;
                        const data = trimmed.slice(5).trim();
                        if (data === '[DONE]') { finishReason = finishReason || 'stop'; doneReceived = true; finish('done'); return; }

                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0];
                            if (!choice) continue;

                            const delta = choice.delta;
                            finishReason = choice.finish_reason || finishReason;

                            if (delta?.content) {
                                fullContent += delta.content;
                                this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: true });
                            }

                            if (delta?.reasoning_content) {
                                if (!reasoningStarted) reasoningStarted = true;
                                fullReasoning += delta.reasoning_content;
                                this._sendReasoningDelta(delta.reasoning_content, fullReasoning);
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
        this._finishReasoningThrottle();
        if (reasoningStarted) {
            this.onChunk({ type: 'reasoning_end' });
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
        let inputTokens = 0;
        let outputTokens = 0;
        let doneReceived = false;
        this._initReasoningThrottle();
        let reasoningStarted = false;

        const currentTool = {};
        let activeToolId = null;

        await new Promise((resolve) => {
            const STREAM_TIMEOUT = 60000;
            const STREAM_TOTAL = 300000;
            let inactivityTimer = setTimeout(() => resolve('timeout'), STREAM_TIMEOUT);
            const totalTimer = setTimeout(() => resolve('timeout'), STREAM_TOTAL);
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
                    inactivityTimer = setTimeout(() => finish('timeout'), STREAM_TIMEOUT);
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
                                        this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: true });
                                    } else if (delta.type === 'input_json_delta') {
                                        const toolId = activeToolId;
                                        if (toolId && currentTool[toolId]) {
                                            currentTool[toolId].partialJson = (currentTool[toolId].partialJson || '') + (delta.partial_json || '');
                                            try {
                                                currentTool[toolId].args = JSON.parse(currentTool[toolId].partialJson);
                                            } catch (e) { console.error('[Engine] SSE parse error:', e.message); }
                                        }
                                    } else if (delta.type === 'thinking_delta') {
                                        if (!reasoningStarted) reasoningStarted = true;
                                        fullReasoning += delta.thinking || '';
                                        this._sendReasoningDelta(delta.thinking || '', fullReasoning);
                                    } else if (delta.type === 'signature_delta') {
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
                                    finish('done');
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
        this._finishReasoningThrottle();
        if (reasoningStarted) {
            this.onChunk({ type: 'reasoning_end' });
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
        this._initReasoningThrottle();

        await new Promise((resolve) => {
            const STREAM_TIMEOUT = 60000;
            const STREAM_TOTAL = 300000;
            let inactivityTimer = setTimeout(() => resolve('timeout'), STREAM_TIMEOUT);
            const totalTimer = setTimeout(() => resolve('timeout'), STREAM_TOTAL);
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
                    inactivityTimer = setTimeout(() => finish('timeout'), STREAM_TIMEOUT);
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
                                        this._send({ type: 'say', say: SayType.TEXT, text: fullContent, partial: true });
                                    }
                                    if (part.thought) {
                                        if (!reasoningStarted) reasoningStarted = true;
                                        fullReasoning += part.thought;
                                        this._sendReasoningDelta(part.thought, fullReasoning);
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
                                if (finishReason) { finish('done'); return; }
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
        this._finishReasoningThrottle();
        if (reasoningStarted) {
            this.onChunk({ type: 'reasoning_end' });
        }

        return { fullContent, fullReasoning, toolCalls, finishReason: finishReason || 'stop' };
    }

    // =========================================================================
    // Tool Execution
    // =========================================================================

    async _executeTools(toolCalls, lastUserMsg) {
        if (!this.executeTool) {
            return toolCalls.map(tc => ({ id: tc.id, name: tc.name, result: JSON.stringify({ error: '宸ュ叿鎵ц鏈厤缃? }) }));
        }

        const parsedCalls = toolCalls.map(tc => {
            let args = {};
            try { args = JSON.parse(tc.argsStr); } catch (e) {
                args = { _parseError: true, _raw: tc.argsStr, _error: e.message };
            }
            return { tc, args, _pattern: `${tc.name}:${tc.argsStr}` };
        });

        for (const pc of parsedCalls) {
            this._actionHistory.push({ name: pc.tc.name, args: pc.args, _pattern: pc._pattern });
        }

        this._send({
            type: 'say', say: SayType.TOOL_START,
            text: JSON.stringify(parsedCalls.map(pc => ({
                id: pc.tc.id, name: pc.tc.name,
                displayName: TOOL_DISPLAY_NAMES[pc.tc.name] || _getPluginDisplayNames()[pc.tc.name] || pc.tc.name,
                args: pc.tc.argsStr
            })))
        });

        const independentCalls = [];
        const dependentCalls = [];

        for (const pc of parsedCalls) {
            let { args } = pc;

            if (this._activePlan) {
                const planStep = this._activePlan.find(s => s.tool === pc.tc.name);
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
                    dependentCalls.push({ tc: pc.tc, args });
                } else {
                    independentCalls.push({ tc: pc.tc, args });
                }
            } else {
                independentCalls.push({ tc: pc.tc, args });
            }
        }

        const executeOne = async ({ tc, args }) => {
            if (args._parseError) {
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: `JSON 瑙ｆ瀽澶辫触: ${args._error}\n鍘熷鍙傛暟: ${args._raw}`, elapsed: 0 })
                });
                return { tc, result: { status: 'error', error: `JSON 瑙ｆ瀽澶辫触: ${args._error}` }, elapsed: 0 };
            }
            if (this._aborted) {
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name, result: '宸蹭腑鏂?, elapsed: 0 })
                });
                return { id: tc.id, name: tc.name, result: JSON.stringify({ status: 'aborted' }) };
            }

            const pluginRisks = _getPluginRisks();
            const toolRisk = TOOL_RISK[tc.name] || pluginRisks[tc.name] || 'safe';
            if (toolRisk !== 'safe' && this.onRequestApproval) {
                try {
                    const approval = await this.onRequestApproval(tc.name, tc.argsStr);
                    if (approval && approval.approved === false) {
                        const denyResult = JSON.stringify({ status: 'denied', reason: '鐢ㄦ埛鎷掔粷浜嗘鎿嶄綔' });
                        this._send({
                            type: 'say', say: SayType.TOOL_RESULT,
                            text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || tc.name, result: '鐢ㄦ埛鎷掔粷', elapsed: 0 })
                        });
                        return { tc, result: denyResult, elapsed: 0 };
                    }
                } catch (e) {
                    console.error('[AgentEngine] Approval error:', e);
                }
            }

            if (tc.name === 'attempt_completion') {
                let parsed = {};
                try { parsed = JSON.parse(tc.argsStr); } catch (e) {}
                const compText = parsed.result || parsed.text || '';
                _lastCompletionText = compText;
                const compResult = JSON.stringify({ status: 'success', completion: compText });
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name, result: '浠诲姟瀹屾垚', elapsed: 0 })
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
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name, result: JSON.stringify({ status: 'success', todos }), elapsed: 0 })
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
                const thinkResult = JSON.stringify({ status: 'success', thought_number: stepData.thought_number, message: `姝ラ ${stepData.thought_number} 宸茶褰昤 });
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name, result: `鎬濊€冩楠?${stepData.thought_number}/${stepData.total_thoughts}`, elapsed: 0 })
                });
                return {
                    id: tc.id, name: tc.name,
                    result: thinkResult
                };
            }

            if (tc.name === 'sub_agent_dispatch') {
                const subStartTime = Date.now();
                try {
                    this._send({ type: 'say', say: SayType.TOOL_START, text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name], description: `娲鹃仯${AGENT_META[args.agent_type]?.name || '瀛愪唬鐞?}: ${args.task}` }) });

                    const subResult = await this._executeSubAgent(args.agent_type, args.task);
                    const subElapsed = ((Date.now() - subStartTime) / 1000).toFixed(1);

                    this._send({ type: 'say', say: SayType.TOOL_RESULT, text: JSON.stringify({ id: tc.id, name: tc.name, displayName: TOOL_DISPLAY_NAMES[tc.name], result: subResult, elapsed: subElapsed }) });

                    return { tc, result: subResult, elapsed: subElapsed };
                } catch (e) {
                    const subElapsed = ((Date.now() - subStartTime) / 1000).toFixed(1);
                    this._send({ type: 'say', say: SayType.ERROR, text: `瀛愪唬鐞嗘墽琛屽け璐? ${e.message}` });
                    return { tc, result: JSON.stringify({ status: 'error', error: e.message }), elapsed: subElapsed };
                }
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
                const TOOL_EXEC_TIMEOUT = 120000;
                let result;
                const heartbeatTimer = setInterval(() => {
                    this._send({ type: 'say', say: 'heartbeat', text: JSON.stringify({ elapsed: Date.now() - startTime, tool: tc.name }) });
                }, 15000);
                try {
                    if (_isPluginTool(tc.name)) {
                        result = await Promise.race([
                            _pluginManager.executeTool(tc.name, tc.argsStr),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Plugin tool timeout(120s)')), TOOL_EXEC_TIMEOUT))
                        ]);
                    } else {
                        result = await Promise.race([
                            this.executeTool(tc.name, tc.argsStr),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('宸ュ叿鎵ц瓒呮椂(120s)')), TOOL_EXEC_TIMEOUT))
                        ]);
                    }
                } finally {
                    clearInterval(heartbeatTimer);
                }
                const elapsed = Date.now() - startTime;
                const summarized = this._summarizeToolResult(tc.name, result);
                const MAX_RESULT = 3000;
                const trimmed = summarized.length > MAX_RESULT ? summarized.slice(0, MAX_RESULT) + '...[鎴柇]' : summarized;

                const displayResult = trimmed.length > 500 ? trimmed.slice(0, 500) + '...[鏄剧ず鎽樿]' : trimmed;
                this._send({
                    type: 'say', say: SayType.TOOL_RESULT,
                    text: JSON.stringify({
                        id: tc.id, name: tc.name,
                        displayName: TOOL_DISPLAY_NAMES[tc.name] || _getPluginDisplayNames()[tc.name] || tc.name,
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

                let reflectionGuidance = null;
                const isErrorResult = trimmed.includes('"error"') || trimmed.includes('"status":"error"') || trimmed.includes('"status":"denied"');
                if (isErrorResult && this.enableReflection) {
                    try {
                        const goal = lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '') : '';
                        const reflection = await this._reflectOnResult(tc.name, trimmed, goal);
                        reflectionGuidance = this._buildReflectionGuidance(reflection, tc.name);
                        if (reflectionGuidance) {
                            this._send({ type: 'say', say: SayType.REFLECTION, text: JSON.stringify(reflection) });
                        }
                    } catch (e) {}
                }

                if (this._isFileEditTool(tc.name) && !isErrorResult && this.enableReflection) {
                    try {
                        const parsed = typeof tc.argsStr === 'string' ? JSON.parse(tc.argsStr) : {};
                        const verifyResult = await this._verifyFileEdit(parsed);
                        if (verifyResult && !verifyResult.verified) {
                            reflectionGuidance = `[Self-Refine] 鏂囦欢缂栬緫楠岃瘉澶辫触: ${verifyResult.reason}銆傝妫€鏌ョ紪杈戝唴瀹瑰苟閲嶈瘯銆俙;
                        }
                    } catch (e) {}
                }

                return { id: tc.id, name: tc.name, result: trimmed, reflectionGuidance };
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

        const GLOBAL_TIMEOUT = 300000;
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
                new Promise((_, reject) => setTimeout(() => reject(new Error('宸ュ叿鎵规鎵ц瓒呮椂(90s)')), GLOBAL_TIMEOUT))
            ]);
        } catch (e) {
            allResults = allResults || toolCalls.map(tc => ({
                id: tc.id, name: tc.name,
                result: JSON.stringify({ status: 'error', error: e.message || '鎵ц寮傚父' })
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
        const patterns = recent.map(a => a._pattern || `${a.name}:${JSON.stringify(a.args)}`);

        const patternCounts = {};
        for (const p of patterns) {
            patternCounts[p] = (patternCounts[p] || 0) + 1;
        }
        for (const count of Object.values(patternCounts)) {
            if (count >= 4) return true;
        }

        if (recent.length >= 3) {
            const last3 = recent.slice(-3);
            const p0 = last3[0]._pattern;
            if (last3.every(a => (a._pattern || `${a.name}:${JSON.stringify(a.args)}`) === p0)) {
                return true;
            }
        }

        if (recent.length >= 4) {
            const p0 = patterns[0], p1 = patterns[1], p2 = patterns[2], p3 = patterns[3];
            if (p0 === p2 && p1 === p3 && p0 !== p1) {
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
        const isPassive = PASSIVE_PATTERNS.some(p => p.test(fullContent));
        if (!isPassive) return false;

        const userContent = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
        return PASSIVE_NEEDS_TOOLS.test(userContent);
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
        const sentences = text.split(/[銆傦紒锛焅n]/).filter(s => s.trim().length > 8);
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
        const results = allResults || [];
        let errorCount = 0, successCount = 0, deniedCount = 0;
        for (const r of results) {
            if (r.denied) { deniedCount++; continue; }
            try {
                const p = JSON.parse(r.result);
                if (p.status === 'error' || p.error) errorCount++;
                else successCount++;
            } catch (e) {}
        }

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
                guidance = 'All tools executed successfully. Determine task progress: if there are remaining steps 鈫?continue immediately, do not stop. If task is complete 鈫?call attempt_completion.';
            } else if (errorCount > 0) {
                guidance = '閮ㄥ垎宸ュ叿鎵ц澶辫触銆傚垎鏋愰敊璇苟灏濊瘯涓嶅悓鐨勬柟娉曘€備笉瑕侀噸澶嶇浉鍚岀殑澶辫触鎿嶄綔銆?;
            }
            if (guidance) conversation.push({ role: 'system', content: guidance });
        }

        if (round >= 2 && this._repeatTextCount > 0) {
            conversation.push({
                role: 'system',
                content: 'Your response is highly repetitive. Do NOT repeat what you already said. Call tools to take action, or call attempt_completion if the task is done.'
            });
        }

        if (round >= 3 && !this._round3GuidanceSent) {
            this._round3GuidanceSent = true;
            conversation.push({
                role: 'system',
                content: '宸茶繃鍘诲杞€傚仠姝㈣В閲婂苟閲囧彇琛屽姩銆傝皟鐢ㄥ伐鍏峰畬鎴愪换鍔★紝鎴栬皟鐢?attempt_completion銆傛瘡娆″洖澶嶉兘蹇呴』鏈夎繘灞曘€?
            });
        }
    }

    async _executeSubAgent(agentType, task) {
        return this.subAgents.execute(agentType, task);
    }

    // =========================================================================
    // Reflection & Self-Refine
    // =========================================================================

    async _reflectOnResult(toolName, result, goal) {
        const resultStr = typeof result === 'string' ? result.slice(0, 800) : JSON.stringify(result).slice(0, 800);

        const cacheKey = `${toolName}:${resultStr.slice(0, 200)}`;
        const cached = this._reflectionCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 30000) return cached.data;

        const memMatch = this._checkErrorMemory(toolName, resultStr);
        if (memMatch) {
            const memResult = { assessment: 'failed', next_action: 'retry', reasoning: `璁板繂鍖归厤: ${memMatch.pattern}`, suggestion: memMatch.suggestion, fromMemory: true };
            this._reflectionCache.set(cacheKey, { data: memResult, ts: Date.now() });
            return memResult;
        }

        try {
            const resp = await makeApiRequest(this._apiUrl, JSON.stringify({
                model: this._requestModel,
                messages: [
                    {
                        role: 'system',
                        content: `浣犳槸宸ュ叿鎵ц缁撴灉鍒嗘瀽鍣ㄣ€傚垎鏋愬伐鍏锋墽琛岀粨鏋滐紝鍒ゆ柇鏄惁鎴愬姛浠ュ強涓嬩竴姝ヨ鎬庝箞鍋氥€?
杈撳嚭涓ユ牸JSON鏍煎紡锛堜笉瑕乵arkdown鍖呰９锛?
{"assessment":"success|partial|failed","next_action":"continue|retry|alternative|ask_user","error_pattern":"閿欒妯″紡鍒嗙被(濡?鍙傛暟閿欒/鏉冮檺涓嶈冻/鏂囦欢涓嶅瓨鍦?璇硶閿欒/缃戠粶瓒呮椂/閫昏緫閿欒/绌虹粨鏋?","reasoning":"涓€鍙ヨ瘽鍘熷洜","suggestion":"濡傛灉retry:淇鍙傛暟寤鸿;濡傛灉alternative:鏇夸唬鏂规"}

瑙勫垯:
- 鏈夐敊璇俊鎭?鈫?assessment=failed, 鏍规嵁閿欒绫诲瀷閫塺etry鎴朼lternative
- 鍙傛暟鏍煎紡閿欒 鈫?retry + 缁欏嚭姝ｇ‘鍙傛暟
- 鏂囦欢/璺緞涓嶅瓨鍦?鈫?alternative + 寤鸿鐢ㄥ叾浠栧伐鍏?- 鏉冮檺涓嶈冻 鈫?ask_user
- 缁撴灉涓虹┖浣嗘棤閿欒 鈫?partial + 寤鸿妫€鏌ュ弬鏁?- 缁撴灉姝ｅ父 鈫?success + continue`
                    },
                    { role: 'user', content: `宸ュ叿: ${toolName}\n鐩爣: ${goal}\n鎵ц缁撴灉:\n${resultStr}` }
                ],
                temperature: 0.1,
                stream: false
            }), this._apiHeaders);
            const match = resp.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                this._recordError(toolName, resultStr, parsed);
                this._reflectionCache.set(cacheKey, { data: parsed, ts: Date.now() });
                if (this._reflectionCache.size > 100) {
                    const oldest = this._reflectionCache.keys().next().value;
                    this._reflectionCache.delete(oldest);
                }
                return parsed;
            }
        } catch (e) {}
        return { assessment: 'success', next_action: 'continue', reasoning: '', error_pattern: '' };
    }

    _checkErrorMemory(toolName, resultStr) {
        const now = Date.now();
        const MEMORY_TTL = 300000;
        for (let i = this._errorMemory.length - 1; i >= 0; i--) {
            const mem = this._errorMemory[i];
            if (now - mem.timestamp > MEMORY_TTL) {
                this._errorMemory.splice(i, 1);
                continue;
            }
            if (mem.tool === toolName && mem.pattern && resultStr.includes(mem.errorSnippet)) {
                return mem;
            }
        }
        return null;
    }

    _recordError(toolName, resultStr, reflection) {
        if (!reflection || reflection.assessment === 'success') return;
        const snippet = resultStr.slice(0, 150);
        this._errorMemory.push({
            tool: toolName,
            pattern: reflection.error_pattern || 'unknown',
            suggestion: reflection.suggestion || '',
            errorSnippet: snippet,
            timestamp: Date.now()
        });
        if (this._errorMemory.length > 20) this._errorMemory.shift();
    }

    _isFileEditTool(name) {
        return name === 'str_replace_based_edit_tool' || name === 'json_edit_tool';
    }

    async _verifyFileEdit(args) {
        if (!this.executeTool || !args) return null;
        const filePath = args.file_path || args.path;
        if (!filePath) return null;
        try {
            const readResult = await Promise.race([
                this.executeTool('read_file', JSON.stringify({ file_path: filePath })),
                new Promise((_, rej) => setTimeout(() => rej(new Error('verify timeout')), 15000))
            ]);
            const parsed = typeof readResult === 'string' ? JSON.parse(readResult) : readResult;
            if (parsed.error) return { verified: false, reason: `璇诲彇澶辫触: ${parsed.error}` };
            const content = parsed.content || parsed.text || '';
            if (!content || content.length === 0) return { verified: false, reason: '鏂囦欢鍐呭涓虹┖' };
            if (args.new_str && !content.includes(args.new_str.slice(0, 50))) {
                return { verified: false, reason: '缂栬緫鍐呭鏈湪鏂囦欢涓壘鍒? };
            }
            return { verified: true, reason: '鏂囦欢楠岃瘉閫氳繃' };
        } catch (e) {
            return { verified: false, reason: `楠岃瘉寮傚父: ${e.message}` };
        }
    }

    _buildReflectionGuidance(reflection, toolName) {
        if (!reflection || reflection.assessment === 'success') return null;
        const { next_action, reasoning, suggestion, error_pattern } = reflection;

        if (next_action === 'retry' && suggestion) {
            return `[Self-Refine] 宸ュ叿 ${toolName} 鎵ц澶辫触(${error_pattern || '鏈煡閿欒'}): ${reasoning}銆傝淇鍚庨噸璇? ${suggestion}`;
        }
        if (next_action === 'alternative' && suggestion) {
            return `[Self-Refine] 宸ュ叿 ${toolName} 涓嶅彲琛?${error_pattern || '鏈煡閿欒'}): ${reasoning}銆傝灏濊瘯鏇夸唬鏂规: ${suggestion}`;
        }
        if (next_action === 'ask_user') {
            return `[Self-Refine] 宸ュ叿 ${toolName} 闇€瑕佺敤鎴峰崗鍔? ${reasoning}銆傝鍚戠敤鎴疯鏄庢儏鍐靛苟璇锋眰甯姪銆俙;
        }
        if (next_action === 'retry') {
            return `[Self-Refine] 宸ュ叿 ${toolName} 鎵ц澶辫触: ${reasoning}銆傝鍒嗘瀽閿欒鍘熷洜骞剁敤涓嶅悓鍙傛暟閲嶈瘯銆俙;
        }
        if (next_action === 'alternative') {
            return `[Self-Refine] 宸ュ叿 ${toolName} 涓嶅彲琛? ${reasoning}銆傝灏濊瘯鍏朵粬鏂规硶瀹屾垚浠诲姟銆俙;
        }
        return null;
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
        let recentStart = Math.max(1, conversation.length - 6);
        while (recentStart > 1) {
            const msg = conversation[recentStart];
            if (msg.role === 'tool') { recentStart--; continue; }
            if (msg.role === 'assistant' && msg.tool_calls) { recentStart--; continue; }
            break;
        }
        const recent = conversation.slice(recentStart);
        const middle = conversation.slice(1, recentStart);

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

        let summary = '[瀵硅瘽鍘嬬缉] ';
        if (usedTools.size) summary += `浣跨敤宸ュ叿: ${[...usedTools].join(', ')}銆俙;
        if (decisions.length) summary += `缁撴灉: ${decisions.slice(-3).join('; ')}銆俙;

        const compressed = [system, { role: 'system', content: summary }];
        if (lastUser && !recent.includes(lastUser)) compressed.push(lastUser);
        compressed.push(...recent);
        conversation.splice(0, conversation.length, ...compressed);
    }
}

// =============================================================================
// 瀵煎嚭
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
    makeApiRequest,
    _getPluginPromptExtensions,
    _getPluginTools,
    _getPluginDisplayNames
};