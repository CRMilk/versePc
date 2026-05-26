const svgIcon = (d, vb) => {
    const paths = d.split(',').map(p => `<path d="${p.trim()}"/>`).join('');
    return `<svg viewBox="${vb || '0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ai-svg-icon">${paths}</svg>`;
};

const TOOL_ICONS = {
    bash: svgIcon('M4 17l6-6-6-6M12 19h8'),
    str_replace_based_edit_tool: svgIcon('M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7,M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z'),
    json_edit_tool: svgIcon('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z,M14 2v6h6,M8 13h2M8 17h2,M14 13h2M14 17h2'),
    sequential_thinking: svgIcon('M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z,M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2z'),
    attempt_completion: svgIcon('M22 11.08V12a10 10 0 1 1-5.93-9.14,M22 4L12 14.01l-3-3'),
    ckg: svgIcon('M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5,M2 12l10 5 10-5')
};

const TOOL_DISPLAY_NAMES = {
    bash: '执行命令', str_replace_based_edit_tool: '编辑文件',
    json_edit_tool: '编辑JSON', sequential_thinking: '分步思考',
    attempt_completion: '完成任务', ckg: '代码图谱'
};

const AIChat = {
    conversations: [],
    currentId: null,
    isGenerating: false,
    abortController: null,
    _sseHandle: null,
    currentToolCalls: [],
    toolCallBubble: null,
    userMemory: '',
    toolCallStartTime: null,
    thinkingBubble: null,
    thinkingContent: '',
    thinkingStartTime: null,
    typewriterQueue: '',
    typewriterTimer: null,
    typewriterSpeed: 18,
    typewriterBatchSize: 2,
    displayedLength: 0,
    fullTextBuffer: '',
    typewriterTextBlock: null,
    _chunkQueue: [],
    _schedulerTimer: null,
    providers: [],
    addedModels: [],

    async loadUserMemory() {
        try {
            const raw = await window.electronAPI.store.get('versepc_ai_memory');
            if (raw) this.userMemory = raw;
        } catch (e) {}
    },

    async saveUserMemory() {
        try {
            await window.electronAPI.store.set('versepc_ai_memory', this.userMemory);
        } catch (e) {}
    },

    async init() {
        this._initScheduler();
        await this.loadSettings();
        await this.loadConversations();
        await this.loadUserMemory();
        try {
            this.providers = await window.electronAPI.ai.getProviders();
        } catch (e) { this.providers = []; }
        try {
            const raw = await window.electronAPI.store.get('versepc_ai_added_models');
            if (raw) this.addedModels = JSON.parse(raw);
        } catch (e) {}
        this.updateModelLabel();
        this.renderSidebar();

        if (this.conversations.length === 0) {
            this.newChat();
        } else if (!this.currentId) {
            this.switchTo(this.conversations[0].id);
        }

        this._startWatchdog();

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.rc-mode-dropdown')) {
                const menu = document.getElementById('ai-mode-menu');
                if (menu) menu.style.display = 'none';
            }
        });

        this._messagesContainer = document.getElementById('ai-messages');

        const msgsContainer = this._messagesContainer;
        if (msgsContainer) {
            msgsContainer.addEventListener('wheel', (e) => {
                if (!this.isGenerating) return;
                if (e.deltaY < 0) {
                    this._userScrollingUp = true;
                    if (this._scrollToBottomBtn && this.isGenerating) {
                        this._scrollToBottomBtn.classList.add('visible');
                    }
                }
            });
            msgsContainer.addEventListener('scroll', () => {
                if (!this.isGenerating) return;
                const atBottom = msgsContainer.scrollHeight - msgsContainer.scrollTop - msgsContainer.clientHeight < 50;
                if (atBottom) {
                    this._userScrollingUp = false;
                    if (this._scrollToBottomBtn) {
                        this._scrollToBottomBtn.classList.toggle('visible', this._userScrollingUp && this.isGenerating);
                    }
                }
            });
        }
        this._scrollToBottomBtn = null;
        this._createScrollToBottomButton();
    },

    _createScrollToBottomButton() {
        const btn = document.createElement('button');
        btn.className = 'scroll-to-bottom-btn';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>';
        btn.title = '滚动到底部';
        btn.addEventListener('click', () => {
            this._userScrollingUp = false;
            this.scrollToBottom();
        });
        const container = this._messagesContainer || document.getElementById('ai-messages');
        if (container && container.parentElement) {
            container.parentElement.style.position = 'relative';
            container.parentElement.appendChild(btn);
        }
        this._scrollToBottomBtn = btn;
    },

    newChat() {
        const conv = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '新对话', messages: [], createdAt: Date.now() };
        this.conversations.unshift(conv);
        this.currentId = conv.id;
        this._todos = [];
        if (this._todoCard) { this._todoCard.remove(); this._todoCard = null; }
        this.updateTodoBar();
        this.renderSidebar();
        this.showWelcome();
        this.saveConversations();
        const sidebar = document.getElementById('ai-chat-sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
            const overlay = document.getElementById('ai-sidebar-overlay');
            if (overlay) overlay.classList.remove('visible');
            const historyBtn = document.getElementById('ai-history-btn');
            if (historyBtn) historyBtn.classList.remove('active');
        }
    },

    switchTo(id) {
        this.currentId = id;
        this._todos = [];
        if (this._todoCard) { this._todoCard.remove(); this._todoCard = null; }
        this.updateTodoBar();
        const conv = this.getConv(id);
        if (!conv || conv.messages.length === 0) {
            this.showWelcome();
        } else {
            this.showMessages(conv.messages);
        }
        this.renderSidebar();
        const sidebar = document.getElementById('ai-chat-sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
            const overlay = document.getElementById('ai-sidebar-overlay');
            if (overlay) overlay.classList.remove('visible');
            const historyBtn = document.getElementById('ai-history-btn');
            if (historyBtn) historyBtn.classList.remove('active');
        }
    },

    deleteConv(id, event) {
        event?.stopPropagation();
        const idx = this.conversations.findIndex(c => c.id === id);
        if (idx === -1) return;
        this.conversations.splice(idx, 1);

        if (this.currentId === id) {
            if (this.conversations.length > 0) {
                this.switchTo(this.conversations[Math.min(idx, this.conversations.length - 1)].id);
            } else {
                this.currentId = null;
                this.newChat();
            }
        }
        this.saveConversations();
        this.renderSidebar();
    },

    getConv(id) {
        return this.conversations.find(c => c.id === id);
    },

    getCurrent() {
        return this.getConv(this.currentId);
    },

    showWelcome() {
        const topbar = document.getElementById('ai-chat-topbar');
        if (topbar) topbar.style.display = '';
        document.getElementById('ai-welcome').style.display = '';
        this._messagesContainer.style.display = 'none';
        document.getElementById('ai-chat-main').classList.add('ai-idle');
        const inputArea = document.querySelector('.rc-input-area');
        if (inputArea) inputArea.style.display = '';
    },

    showMessages(messages) {
        document.getElementById('ai-welcome').style.display = 'none';
        document.getElementById('ai-chat-main').classList.remove('ai-idle');
        const container = this._messagesContainer;
        container.style.display = '';

        const existingCount = container.children.length;
        if (existingCount === 0 || existingCount !== messages.length) {
            container.innerHTML = '';
            for (const msg of messages) {
                this.appendMessage(msg.role, msg.content, msg.error);
            }
        } else {
            const children = Array.from(container.querySelectorAll('.ai-msg'));
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                const child = children[i];
                if (child) {
                    const bubble = child.querySelector('.ai-msg-bubble');
                    if (bubble && bubble.textContent !== msg.content) {
                        if (msg.error) {
                            bubble.innerHTML = `<span class="ai-msg-error">${this.escapeHtml(msg.content)}</span>`;
                        } else {
                            this.asyncRenderMarkdown(msg.content, (html) => {
                                if (bubble) bubble.innerHTML = html;
                            });
                        }
                    }
                }
            }
        }

        this._todos = [];
        for (const msg of messages) {
            if (msg.role === 'assistant' && typeof msg.content === 'string') {
                const todos = this.parseTodosFromText(msg.content);
                if (todos.length > 0) this._todos = todos;
            }
        }
        this.updateTodoBar();
        const condenseBtn = document.getElementById('ai-condense-btn');
        if (condenseBtn) {
            const totalChars = messages.reduce((sum, m) => sum + (m.content || '').length, 0);
            condenseBtn.style.display = totalChars > 8000 && messages.length > 4 ? '' : 'none';
        }

        this.scrollToBottom();
    },

    appendMessage(role, content, isError) {
        const container = this._messagesContainer;
        if (!container) return;

        if (typeof content !== 'string') {
            try { content = JSON.stringify(content, null, 2); } catch (e) { content = String(content); }
        }

        const div = document.createElement('div');
        div.className = `ai-msg ai-msg-${role}`;
        div.style.cssText = 'padding:10px 15px 10px 6px;';

        const header = document.createElement('div');
        header.className = 'ai-msg-header';
        header.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:default;margin-bottom:10px;word-break:break-word;';

        if (role === 'user') {
            const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            header.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span style="font-weight:bold">你说</span><span style="font-size:11px;color:var(--text-muted);margin-left:auto">${timeStr}</span>`;
        } else {
            const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            header.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg><span style="font-weight:bold">VerseAI 说</span><span style="font-size:11px;color:var(--text-muted);margin-left:auto">${timeStr}</span>`;
        }

        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'ai-msg-body';
        contentWrapper.style.cssText = 'padding-left:24px;';

        if (isError) {
            contentWrapper.innerHTML = `<span class="ai-msg-error">${this.escapeHtml(content)}</span>`;
        } else if (role === 'user') {
            contentWrapper.innerHTML = `<div style="white-space:pre-wrap;word-break:break-word">${this.escapeHtml(content)}</div>`;
        } else {
            this.asyncRenderMarkdown(content, (html) => {
                contentWrapper.innerHTML = html;
            });
        }

        div.appendChild(header);
        div.appendChild(contentWrapper);
        container.appendChild(div);

        return contentWrapper;
    },

    appendStreamingBubble() {
        const container = this._messagesContainer;
        if (!container) return null;

        const div = document.createElement('div');
        div.className = 'ai-msg ai-msg-assistant ai-streaming-msg';
        div.id = 'ai-current-response';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-msg-content';

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';
        bubble.innerHTML = '<span class="ai-cursor"></span>';

        contentDiv.appendChild(bubble);
        div.appendChild(contentDiv);
        container.appendChild(div);

        return bubble;
    },

    scrollToBottom() {
        const msgs = this._messagesContainer;
        if (!msgs) return;
        msgs.scrollTop = msgs.scrollHeight;
    },

    createWorkflowBubble() {
        const container = this._messagesContainer;
        if (!container) return null;

        const div = document.createElement('div');
        div.className = 'ai-msg ai-msg-assistant';
        div.id = 'ai-active-workflow';
        div.style.cssText = 'padding:10px 15px 10px 6px;';

        const header = document.createElement('div');
        header.className = 'ai-msg-header';
        header.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:default;margin-bottom:10px;word-break:break-word;';
        const timeStr2 = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        header.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg><span style="font-weight:bold">VerseAI 说</span><span style="font-size:11px;color:var(--text-muted);margin-left:auto">${timeStr2}</span>`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-msg-content ai-msg-body';
        contentDiv.style.cssText = 'padding-left:24px;';

        div.appendChild(header);
        div.appendChild(contentDiv);
        container.appendChild(div);

        return contentDiv;
    },

    getOrCreateWorkflowContent() {
        let content = document.getElementById('ai-active-workflow');
        if (content) return content.querySelector('.ai-msg-content');
        return this.createWorkflowBubble();
    },

    appendWorkflowBlock(block) {
        const contentDiv = this.getOrCreateWorkflowContent();
        if (!contentDiv) return;
        contentDiv.appendChild(block);
        this._scrollDebounced();
    },

    getToolActionDescription(name, args) {
        let parsed = {};
        try { parsed = JSON.parse(args); } catch (e) {}

        switch (name) {
            case 'bash': {
                const cmd = (parsed.command || '').slice(0, 60);
                return cmd ? `Running command… <code>${this.escapeHtml(cmd)}${parsed.command.length > 60 ? '…' : ''}</code>` : 'Running command…';
            }
            case 'str_replace_based_edit_tool': {
                const cmd = parsed.command || 'view';
                const filePath = parsed.path || '';
                const labels = { view: '查看文件', create: '创建文件', str_replace: '编辑文件', insert: '插入到文件' };
                return `${labels[cmd] || '编辑文件'} <code>${this.escapeHtml(filePath.split(/[\/\\]/).pop() || filePath)}</code>`;
            }
            case 'json_edit_tool': {
                const op = parsed.operation || 'view';
                const filePath = parsed.file_path || '';
                const labels = { view: '查看文件', set: '编辑文件', add: '编辑文件', remove: '编辑文件' };
                return `${labels[op] || '编辑文件'} <code>${this.escapeHtml(filePath.split(/[\/\\]/).pop() || filePath)}</code>`;
            }
            case 'sequential_thinking':
                return parsed.is_revision ? '修正思考步骤' : `思考步骤 ${parsed.thought_number || ''}/${parsed.total_thoughts || ''}`;
            case 'attempt_completion':
                return '标记任务完成';
            case 'ckg': {
                const cmd = parsed.command || '';
                const id = parsed.identifier || '';
                return `搜索代码库 <code>${this.escapeHtml(id)}</code>`;
            }
            default:
                return TOOL_DISPLAY_NAMES[name] || name;
        }
    },

    appendToolCallBubble(tc) {
        if (!tc) return;
        const icon = TOOL_ICONS[tc.name] || svgIcon('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2');

        const bubble = document.createElement('div');
        bubble.className = 'ai-tool-row running';
        bubble.id = `tool-${tc.id}`;
        bubble.dataset.toolId = tc.id;
        bubble.dataset.toolName = tc.name;
        bubble.dataset.toolArgs = tc.arguments || '{}';

        const desc = this.getToolActionDescription(tc.name, tc.arguments) || TOOL_DISPLAY_NAMES[tc.name] || tc.name;

        const header = document.createElement('div');
        header.className = 'ai-tool-row-header';
        header.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px;word-break:break-word;';
        header.innerHTML = `<span style="display:flex;align-items:center;color:var(--text-primary);margin-bottom:-1.5px">${icon}</span><span style="font-weight:bold;color:var(--text-primary)">${desc}</span><span class="ai-tool-row-status-icon" data-tool-id="${tc.id}"><span class="ai-tool-row-spinner"></span></span><svg class="ai-tool-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;margin-left:auto;transition:transform 0.2s"><polyline points="6 9 12 15 18 9"/></svg>`;

        header.addEventListener('click', () => {
            const contentWrapper = bubble.querySelector('.ai-tool-use-block');
            if (!contentWrapper) return;
            const isOpen = contentWrapper.classList.toggle('open');
            const chevron = header.querySelector('.ai-tool-row-chevron');
            if (chevron) chevron.style.transform = isOpen ? 'rotate(180deg)' : '';
            if (isOpen) this._lazyRenderToolResult(bubble);
        });

        const contentWrapper = document.createElement('div');
        contentWrapper.style.cssText = 'padding-left:24px;';

        const toolBlock = document.createElement('div');
        toolBlock.className = 'ai-tool-use-block';
        toolBlock.style.cssText = 'border-radius:6px;padding:8px;background:var(--editor-background,rgba(0,0,0,0.3));max-height:0;overflow:hidden;transition:max-height 0.3s ease,padding 0.3s ease;padding:0 8px;';

        const resultArea = document.createElement('div');
        resultArea.className = 'ai-tool-row-result';
        resultArea.dataset.toolId = tc.id;

        toolBlock.appendChild(resultArea);
        contentWrapper.appendChild(toolBlock);
        bubble.appendChild(header);
        bubble.appendChild(contentWrapper);

        if (!this._toolBubbleFragment) {
            this._toolBubbleFragment = document.createDocumentFragment();
        }
        this._toolBubbleFragment.appendChild(bubble);
        this._pendingToolBubbles = (this._pendingToolBubbles || 0) + 1;
        this.currentToolCalls.push({ id: tc.id, name: tc.name, bubble });
    },

    _getToolSummary(name, args) {
        return this.getToolActionDescription(name, JSON.stringify(args)) || '';
    },

    _formatArgs(args) {
        try {
            return JSON.stringify(args, null, 2)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        } catch (e) {
            return String(args);
        }
    },

    updateToolCallStatus(tcId, name, result, isError, toolStatus) {
        // 批处理：同帧内多个工具结果合并为一次 rAF 批量 DOM 更新，消除 layout thrashing
        if (!this._toolResultQueue) this._toolResultQueue = [];
        this._toolResultQueue.push({ tcId, name, result, isError, toolStatus });
        if (!this._toolResultRAF) {
            this._toolResultRAF = requestAnimationFrame(() => {
                this._toolResultRAF = null;
                const queue = this._toolResultQueue;
                this._toolResultQueue = [];
                for (const item of queue) {
                    this._applyToolCallStatus(item);
                }
            });
        }
    },

    _applyToolCallStatus({ tcId, name, result, isError, toolStatus }) {
        const row = document.getElementById('tool-' + tcId);
        if (!row) return;

        const st = toolStatus || (isError ? 'error' : 'success');
        row.classList.remove('running');
        row.classList.add(st === 'error' || st === 'denied' ? 'error' : 'done');

        const indicator = row.querySelector('.ai-tool-step-indicator');
        if (indicator) {
            const spinner = indicator.querySelector('.ai-tool-step-spinner');
            if (spinner) {
                if (st === 'error' || st === 'denied') {
                    spinner.className = 'ai-tool-step-cross';
                    spinner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" style="width:12px;height:12px"><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/></svg>';
                } else {
                    spinner.className = 'ai-tool-step-check';
                    spinner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" style="width:12px;height:12px"><polyline points="6 12 10 16 18 8"/></svg>';
                }
            }
        }

        if (result) {
            row.dataset.toolResult = result;
            row.dataset.toolRendered = '';
        }
    },

    _lazyRenderToolResult(row) {
        if (!row || row.dataset.toolRendered === '1') return;
        const result = row.dataset.toolResult;
        const tcId = row.dataset.toolId;
        const name = row.dataset.toolName;
        if (!result || !tcId) return;
        row.dataset.toolRendered = '1';

        const resultEl = row.querySelector('.ai-tool-row-result[data-tool-id="' + tcId + '"]');
        if (!resultEl) return;

        const renderResult = () => {
            try {
                const MAX_RESULT_LEN = 4096;
                const parseStr = result.length > MAX_RESULT_LEN ? result.slice(0, MAX_RESULT_LEN) : result;
                const truncated = result.length > MAX_RESULT_LEN;
                const parsed = JSON.parse(parseStr);

                if (typeof parsed === 'object' && parsed !== null) {
                    if (parsed.status === 'denied') {
                        resultEl.innerHTML = '<span class="ai-tool-status-denied">' + this.escapeHtml(parsed.message || '操作被拒绝') + '</span>';
                    } else if (parsed.status === 'error' || parsed.error) {
                        resultEl.innerHTML = '<span class="ai-tool-status-error-text">' + this.escapeHtml(parsed.error || '未知错误') + '</span>';
                    } else if (name === 'bash' || name === 'execute_command') {
                        const cmd = row.dataset.toolArgs ? (() => { try { return JSON.parse(row.dataset.toolArgs).command; } catch(e) { return ''; } })() : '';
                        resultEl.innerHTML = this._renderCommandCard(cmd, parsed, parsed.exitCode ?? parsed.code);
                    } else if (name === 'str_replace_based_edit_tool') {
                        const args = row.dataset.toolArgs ? (() => { try { return JSON.parse(row.dataset.toolArgs); } catch(e) { return {}; } })() : {};
                        const cmd = args.command || 'view';
                        const filePath = args.path || args.file_path || '';
                        if (cmd === 'view') {
                            const content = parsed.content || parsed.data || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
                            resultEl.innerHTML = this._renderFileCard(filePath, content);
                        } else if (cmd === 'str_replace' || cmd === 'insert' || cmd === 'create') {
                            const oldStr = args.old_str || args.search || '';
                            const newStr = args.new_str || args.replace || args.content || '';
                            if (oldStr && newStr) {
                                resultEl.innerHTML = this._renderDiffCard(filePath, oldStr, newStr);
                            } else {
                                const content = parsed.content || parsed.data || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
                                resultEl.innerHTML = this._renderFileCard(filePath, content);
                            }
                        }
                    } else if (name === 'json_edit_tool') {
                        const args = row.dataset.toolArgs ? (row._parsedToolArgs || (() => { try { return JSON.parse(row.dataset.toolArgs); } catch(e) { return {}; } })()) : {};
                        const filePath = args.file_path || '';
                        const content = parsed.content || parsed.data || JSON.stringify(parsed, null, 2);
                        resultEl.innerHTML = this._renderFileCard(filePath, content);
                    } else if (name === 'grep_search' || name === 'glob_search' || name === 'search_files' || name === 'search' || name === 'ckg') {
                        const results = parsed.results || parsed.matches || parsed.files || parsed.paths || [];
                        const query = parsed.query || parsed.pattern || parsed.identifier || '';
                        resultEl.innerHTML = this._renderSearchResultCard(query, Array.isArray(results) ? results : [], name);
                    } else if (parsed.files && Array.isArray(parsed.files)) {
                        const items = parsed.files.slice(0, 20).map(f => {
                            const fname = typeof f === 'string' ? f : (f.name || f.path || '');
                            return '<span class="ai-tool-file-item">' + this._escapeHtml(fname) + '</span>';
                        }).join('');
                        const more = parsed.files.length > 20 ? ' <span class="ai-tool-more">等 ' + parsed.files.length + ' 项</span>' : '';
                        resultEl.innerHTML = '<div class="rc-file-card expanded"><div class="rc-file-card-header"><div class="rc-file-card-info"><span class="rc-file-card-icon">📁</span><span class="rc-file-card-path">' + parsed.files.length + ' 个文件</span></div></div><div class="rc-file-card-body"><div class="rc-file-list">' + items + more + '</div></div></div>';
                    } else {
                        const str = JSON.stringify(parsed, null, 2);
                        const suffix = truncated ? '\n...(结果过大已截断)' : (str.length > 800 ? '\n...(已截断)' : '');
                        resultEl.innerHTML = '<pre class="rc-file-card-pre">' + this._escapeHtml(str.slice(0, 800) + suffix) + '</pre>';
                    }
                } else {
                    const suffix = truncated ? '\n...(结果过大已截断)' : '';
                    resultEl.innerHTML = '<pre class="rc-file-card-pre">' + this._escapeHtml(String(parsed).slice(0, 800) + suffix) + '</pre>';
                }
            } catch (e) {
                resultEl.innerHTML = '<pre class="rc-file-card-pre">' + this._escapeHtml(String(result).slice(0, 800)) + '</pre>';
            }
        };
        setTimeout(renderResult, 0);
    },

    renderCommandOutput(result, toolName) {
        if (toolName !== 'execute_command' && toolName !== 'read_command_output') return null;
        let parsed;
        try { parsed = typeof result === 'string' ? JSON.parse(result) : result; } catch(e) { parsed = { output: String(result) }; }
        const output = parsed.output || parsed.stdout || parsed.result || String(result);
        const exitCode = parsed.exitCode ?? parsed.code;
        const stderr = parsed.stderr || '';
        
        const container = document.createElement('div');
        container.className = 'rc-terminal';
        
        let headerHtml = '<div class="rc-terminal-header"><span class="rc-terminal-title">终端输出</span>';
        if (exitCode !== undefined && exitCode !== null) {
            headerHtml += `<span class="rc-terminal-badge ${exitCode === 0 ? 'success' : 'error'}">${exitCode === 0 ? '✓ 成功' : '✗ 失败 (' + exitCode + ')'}</span>`;
        }
        headerHtml += `<button class="rc-terminal-copy" onclick="AIChat._copyTerminalOutput(this)" title="复制输出"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:12px;height:12px"><rect x="6" y="6" width="8" height="8" rx="1"/><path d="M2 10V3a1 1 0 0 1 1-1h7"/></svg></button>`;
        headerHtml += '</div>';
        
        let bodyHtml = '<div class="rc-terminal-body"><pre class="rc-terminal-output">';
        if (output) bodyHtml += this._parseAnsiColors(this.escapeHtml(output));
        if (stderr && stderr !== output) bodyHtml += '<span class="rc-terminal-stderr">' + this._parseAnsiColors(this.escapeHtml(stderr)) + '</span>';
        if (!output && !stderr) bodyHtml += '<span class="rc-terminal-empty">(无输出)</span>';
        bodyHtml += '</pre></div>';
        
        container.innerHTML = headerHtml + bodyHtml;
        return container;
    },

    _parseAnsiColors(text) {
        if (!text) return '';
        const colorMap = {
            '30': '#6b7280', '31': '#ef4444', '32': '#22c55e', '33': '#eab308',
            '34': '#3b82f6', '35': '#a855f7', '36': '#06b6d4', '37': '#e5e7eb',
        };
        return text.replace(/\x1b\[([0-9;]*)m/g, (match, codes) => {
            const parts = codes.split(';');
            let styles = [];
            for (const code of parts) {
                if (code === '0' || code === '') { styles = []; continue; }
                if (colorMap[code]) styles.push('color:' + colorMap[code]);
                if (code === '1') styles.push('font-weight:bold');
                if (code === '4') styles.push('text-decoration:underline');
            }
            return styles.length > 0 ? `<span style="${styles.join(';')}">` : '</span>';
        });
    },

    _copyTerminalOutput(btn) {
        const body = btn.closest('.rc-terminal')?.querySelector('.rc-terminal-output');
        if (body) {
            const text = body.innerText;
            try { window.electronAPI?.clipboard?.writeText(text); } catch(e) { navigator.clipboard?.writeText(text); }
        }
    },

    renderSearchResults(result, toolName) {
        if (toolName !== 'grep_search' && toolName !== 'glob_search' && toolName !== 'search_files') return null;
        let parsed;
        try { parsed = typeof result === 'string' ? JSON.parse(result) : result; } catch(e) { return null; }
        const results = parsed.results || parsed.matches || parsed.files || [];
        if (!Array.isArray(results) || results.length === 0) return null;
        
        const container = document.createElement('div');
        container.className = 'rc-search-results';
        
        const summary = document.createElement('div');
        summary.className = 'rc-search-summary';
        summary.textContent = `${results.length} 个结果`;
        container.appendChild(summary);
        
        const byFile = new Map();
        for (const r of results) {
            const file = r.file || r.path || r.filename || 'unknown';
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file).push(r);
        }
        
        for (const [file, matches] of byFile) {
            const fileGroup = document.createElement('div');
            fileGroup.className = 'rc-search-file-group';
            fileGroup.innerHTML = `<div class="rc-search-file-header"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:12px;height:12px"><path d="M10 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6l-3-4z"/></svg>${this.escapeHtml(file)}</div>`;
            
            for (const m of matches) {
                const matchLine = document.createElement('div');
                matchLine.className = 'rc-search-match';
                const lineNum = m.line || m.lineNumber || '';
                const text = m.text || m.content || m.match || '';
                const highlighted = m.line !== undefined || m.lineNumber !== undefined;
                matchLine.innerHTML = highlighted 
                    ? `<span class="rc-search-line-num">${lineNum}</span><span class="rc-search-line-text">${this.escapeHtml(String(text))}</span>`
                    : `<span class="rc-search-line-text">${this.escapeHtml(String(text))}</span>`;
                fileGroup.appendChild(matchLine);
            }
            container.appendChild(fileGroup);
        }
        return container;
    },

    updateInstallProgress(toolCallId, toolName, progress, status) {
        const row = document.getElementById('tool-' + toolCallId);
        if (!row) return;

        let progBar = row.querySelector('.ai-tool-progress');
        if (!progBar) {
            progBar = document.createElement('div');
            progBar.className = 'ai-tool-progress';
            const body = row.querySelector('.ai-tool-row-body');
            if (body) {
                body.style.display = '';
                body.appendChild(progBar);
            } else {
                row.appendChild(progBar);
            }
        }
        const pct = Math.min(100, Math.max(0, progress));
        const stText = status === 'completed' ? '完成' : status === 'failed' ? '失败' : status || (pct + '%');
        progBar.innerHTML = '<div class="ai-tool-progress-track"><div class="ai-tool-progress-fill" style="width:' + pct + '%"></div></div><span class="ai-tool-progress-label">' + stText + '</span>';

        if (status === 'completed' || status === 'done' || pct >= 100) {
            progBar.classList.add('ai-tool-progress-done');
        } else if (status === 'failed' || status === 'error') {
            progBar.classList.add('ai-tool-progress-error');
        }
    },

    _parseDiffFromArgs(toolName, args) {
        if (!args) return null;
        const diffs = [];
        if (toolName === 'write_file' || toolName === 'write_to_file') {
            const lines = (args.content || '').split('\n');
            diffs.push({ path: args.path || args.file || 'unknown', additions: lines.length, deletions: 0, lines: lines.map(l => ({ type: '+', text: l })) });
        } else if (toolName === 'edit_file' || toolName === 'search_replace') {
            const search = args.old_str || args.search || args.oldStr || '';
            const replace = args.new_str || args.replace || args.newStr || '';
            const searchLines = search.split('\n');
            const replaceLines = replace.split('\n');
            const diffLines = [];
            for (const l of searchLines) diffLines.push({ type: '-', text: l });
            for (const l of replaceLines) diffLines.push({ type: '+', text: l });
            diffs.push({ path: args.path || args.file || 'unknown', additions: replaceLines.length, deletions: searchLines.length, lines: diffLines });
        }
        return diffs.length > 0 ? diffs : null;
    },

    _renderDiffBlock(diffs) {
        if (!diffs || diffs.length === 0) return '';
        let html = '<div class="rc-diff-view">';
        for (const diff of diffs) {
            html += `<div class="rc-diff-header"><span class="rc-diff-file">${diff.path}</span><span class="rc-diff-stats"><span class="rc-diff-add">+${diff.additions}</span> <span class="rc-diff-del">-${diff.deletions}</span></span></div>`;
            html += '<div class="rc-diff-body">';
            let lineNum = 1;
            for (const line of diff.lines) {
                const cls = line.type === '+' ? 'add' : line.type === '-' ? 'del' : 'ctx';
                html += `<div class="rc-diff-line ${cls}"><span class="rc-diff-gutter">${line.type === '+' ? '' : line.type === '-' ? '' : lineNum}</span><span class="rc-diff-prefix">${line.type === ' ' ? '&nbsp;' : line.type}</span><span class="rc-diff-text">${this._escapeHtml(line.text)}</span></div>`;
                if (line.type !== '-') lineNum++;
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    },

    _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _getLanguageFromPath(filePath) {
        if (!filePath) return 'text';
        const ext = (filePath.split('.').pop() || '').toLowerCase();
        const map = {
            js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
            py: 'python', rb: 'ruby', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
            cs: 'csharp', go: 'go', rs: 'rust', php: 'php', swift: 'swift',
            kt: 'kotlin', scala: 'scala', html: 'html', htm: 'html',
            css: 'scss', scss: 'scss', less: 'less', xml: 'xml',
            json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
            md: 'markdown', markdown: 'markdown', txt: 'text', sh: 'bash',
            bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'batch',
            sql: 'sql', graphql: 'graphql', dockerfile: 'dockerfile',
            makefile: 'makefile', vue: 'html', svelte: 'html',
        };
        return map[ext] || ext || 'text';
    },

    _getFileName(filePath) {
        if (!filePath) return '';
        return filePath.split(/[\/\\]/).pop() || filePath;
    },

    _getFileIcon(filePath) {
        const ext = (filePath || '').split('.').pop()?.toLowerCase() || '';
        const iconMap = {
            js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️', py: '🐍',
            html: '🌐', css: '🎨', json: '📋', md: '📝',
            java: '☕', go: '🐹', rs: '🦀', rb: '💎',
            sh: '🖥️', bash: '🖥️', sql: '🗃️',
        };
        return iconMap[ext] || '📄';
    },

    _renderFileCard(filePath, content, options = {}) {
        const lang = options.language || this._getLanguageFromPath(filePath);
        const fileName = this._getFileName(filePath);
        const icon = this._getFileIcon(filePath);
        const truncated = content && content.length > 6000;
        const displayContent = truncated ? content.slice(0, 6000) : content;
        const lines = (displayContent || '').split('\n').length;

        // syntax highlighting removed to avoid blocking main thread; use Web Worker for future support
        const highlighted = this._escapeHtml(displayContent || '');

        return `<div class="rc-file-card">
            <div class="rc-file-card-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="rc-file-card-info">
                    <span class="rc-file-card-icon">${icon}</span>
                    <span class="rc-file-card-path" title="${this._escapeHtml(filePath || '')}">${this._escapeHtml(filePath || 'unknown')}</span>
                    <span class="rc-file-card-lang">${lang}</span>
                </div>
                <div class="rc-file-card-actions">
                    <span class="rc-file-card-meta">${lines} 行</span>
                    <button class="rc-file-card-btn" onclick="event.stopPropagation();const t=this.closest('.rc-file-card').querySelector('code');navigator.clipboard.writeText(t?.textContent||'').then(()=>{this.textContent='✓';setTimeout(()=>{this.textContent='📋'},1500)})" title="复制内容">📋</button>
                    <svg class="rc-file-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="rc-file-card-body">
                <pre class="rc-file-card-pre"><code class="hljs language-${lang}">${highlighted}</code></pre>
                ${truncated ? '<div class="rc-file-card-truncated">内容过长已截断，共 ' + (content || '').split('\n').length + ' 行</div>' : ''}
            </div>
        </div>`;
    },

    _renderDiffCard(filePath, oldStr, newStr) {
        const maxDiffLines = 100;
        const truncatedOld = (oldStr || '').split('\n');
        const truncatedNew = (newStr || '').split('\n');
        if (truncatedOld.length > maxDiffLines || truncatedNew.length > maxDiffLines) {
            return this._renderFileCard(filePath, `// Diff 过大（${truncatedOld.length}+${truncatedNew.length} 行），已截断显示\n// 旧内容:\n${truncatedOld.slice(0, 250).join('\n')}\n// ...\n// 新内容:\n${truncatedNew.slice(0, 250).join('\n')}`);
        }
        const oldLines = truncatedOld;
        const newLines = truncatedNew;
        const additions = newLines.length;
        const deletions = oldLines.length;

        const maxLines = Math.max(oldLines.length, newLines.length);
        let tableRows = '';

        for (let i = 0; i < maxLines; i++) {
            const oldLine = i < oldLines.length ? oldLines[i] : null;
            const newLine = i < newLines.length ? newLines[i] : null;
            const isUnchanged = oldLine === newLine;

            if (isUnchanged) {
                tableRows += `<tr class="rc-diff-row rc-diff-ctx">
                    <td class="rc-diff-ln">${i + 1}</td>
                    <td class="rc-diff-ln">${i + 1}</td>
                    <td class="rc-diff-bar"></td>
                    <td class="rc-diff-sign"></td>
                    <td class="rc-diff-code">${this._escapeHtml(oldLine || '')}</td>
                </tr>`;
            } else {
                if (oldLine !== null) {
                    tableRows += `<tr class="rc-diff-row rc-diff-del">
                        <td class="rc-diff-ln">${i + 1}</td>
                        <td class="rc-diff-ln"></td>
                        <td class="rc-diff-bar rc-diff-bar-del"></td>
                        <td class="rc-diff-sign">-</td>
                        <td class="rc-diff-code">${this._escapeHtml(oldLine)}</td>
                    </tr>`;
                }
                if (newLine !== null) {
                    tableRows += `<tr class="rc-diff-row rc-diff-add">
                        <td class="rc-diff-ln"></td>
                        <td class="rc-diff-ln">${i + 1}</td>
                        <td class="rc-diff-bar rc-diff-bar-add"></td>
                        <td class="rc-diff-sign">+</td>
                        <td class="rc-diff-code">${this._escapeHtml(newLine)}</td>
                    </tr>`;
                }
            }
        }

        return `<div class="rc-file-card">
            <div class="rc-file-card-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="rc-file-card-info">
                    <span class="rc-file-card-icon">✏️</span>
                    <span class="rc-file-card-path" title="${this._escapeHtml(filePath || '')}">${this._escapeHtml(filePath || 'unknown')}</span>
                    <span class="rc-file-card-diff-stats"><span class="rc-diff-stat-add">+${additions}</span> <span class="rc-diff-stat-del">-${deletions}</span></span>
                </div>
                <div class="rc-file-card-actions">
                    <svg class="rc-file-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="rc-file-card-body">
                <div class="rc-diff-view">
                    <table class="rc-diff-table"><tbody>${tableRows}</tbody></table>
                </div>
            </div>
        </div>`;
    },

    _renderSearchResultCard(query, results, toolName) {
        if (!results || results.length === 0) {
            return `<div class="rc-file-card"><div class="rc-file-card-header"><div class="rc-file-card-info"><span class="rc-file-card-icon">🔍</span><span class="rc-file-card-path">搜索 "${this._escapeHtml(query)}" 无结果</span></div></div></div>`;
        }

        const byFile = new Map();
        for (const r of results) {
            const file = r.file || r.path || r.filename || 'unknown';
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file).push(r);
        }

        let filesHtml = '';
        for (const [file, matches] of byFile) {
            const icon = this._getFileIcon(file);
            let matchesHtml = '';
            for (const m of matches.slice(0, 10)) {
                const lineNum = m.line || m.lineNumber || '';
                const text = m.text || m.content || m.match || '';
                matchesHtml += `<div class="rc-search-match">
                    ${lineNum ? `<span class="rc-search-line-num">${lineNum}</span>` : ''}
                    <span class="rc-search-line-text">${this._escapeHtml(String(text))}</span>
                </div>`;
            }
            if (matches.length > 10) {
                matchesHtml += `<div class="rc-search-more">还有 ${matches.length - 10} 个结果...</div>`;
            }
            filesHtml += `<div class="rc-search-file-group">
                <div class="rc-search-file-header"><span class="rc-file-card-icon">${icon}</span><span class="rc-search-file-path">${this._escapeHtml(file)}</span><span class="rc-search-file-count">${matches.length}</span></div>
                <div class="rc-search-file-matches">${matchesHtml}</div>
            </div>`;
        }

        return `<div class="rc-file-card expanded">
            <div class="rc-file-card-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="rc-file-card-info">
                    <span class="rc-file-card-icon">🔍</span>
                    <span class="rc-file-card-path">搜索 "${this._escapeHtml(query)}" — ${results.length} 个结果，${byFile.size} 个文件</span>
                </div>
                <div class="rc-file-card-actions">
                    <svg class="rc-file-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="rc-file-card-body">
                <div class="rc-search-results">${filesHtml}</div>
            </div>
        </div>`;
    },

    _renderCommandCard(command, output, exitCode) {
        const parsed = {};
        try {
            if (typeof output === 'string') {
                const o = JSON.parse(output);
                Object.assign(parsed, o);
            } else if (typeof output === 'object') {
                Object.assign(parsed, output);
            }
        } catch (e) {
            parsed.output = String(output);
        }
        const stdout = parsed.output || parsed.stdout || parsed.result || String(output || '');
        const displayStdout = stdout.length > 5000 ? stdout.slice(0, 5000) + '\n...(输出过长，已截断，共 ' + stdout.length + ' 字符)' : stdout;
        const stderr = parsed.stderr || '';
        const code = exitCode ?? parsed.exitCode ?? parsed.code;
        const success = code === 0 || code === undefined || code === null;

        let outputHtml = '';
        if (displayStdout) outputHtml += `<pre class="rc-terminal-output">${this._parseAnsiColors(this.escapeHtml(displayStdout))}</pre>`;
        if (stderr && stderr !== stdout) outputHtml += `<pre class="rc-terminal-output rc-terminal-stderr">${this._parseAnsiColors(this.escapeHtml(stderr))}</pre>`;
        if (!stdout && !stderr) outputHtml = '<span class="rc-terminal-empty">(无输出)</span>';

        return `<div class="rc-file-card expanded">
            <div class="rc-file-card-header" onclick="this.parentElement.classList.toggle('expanded')">
                <div class="rc-file-card-info">
                    <span class="rc-file-card-icon">🖥️</span>
                    <span class="rc-file-card-path rc-file-card-cmd">${this._escapeHtml((command || '').slice(0, 120))}${(command || '').length > 120 ? '...' : ''}</span>
                    <span class="rc-terminal-badge ${success ? 'success' : 'error'}">${success ? '✓' : '✗ ' + code}</span>
                </div>
                <div class="rc-file-card-actions">
                    <button class="rc-file-card-btn" onclick="event.stopPropagation();const t=this.closest('.rc-file-card').querySelector('.rc-terminal-body');navigator.clipboard.writeText(t?.textContent||'').then(()=>{this.textContent='✓';setTimeout(()=>{this.textContent='📋'},1500)})" title="复制输出">📋</button>
                    <svg class="rc-file-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="rc-file-card-body">
                <div class="rc-terminal-body">${outputHtml}</div>
            </div>
        </div>`;
    },

    startTypewriter(textBlock) {
        this.typewriterTextBlock = textBlock;
        this.displayedLength = 0;
        this.fullTextBuffer = '';
        this.typewriterSpeed = 16;
        this.typewriterBatchSize = 3;
        this._lastRenderLength = 0;
        this._lastRenderTime = 0;
        this._markdownBatchSize = 999999;
        this._plainNode = null;
        this._rAFPending = false;
        this._mdRenderTimer = null;

        if (this.typewriterTimer) {
            clearTimeout(this.typewriterTimer);
            this.typewriterTimer = null;
        }

        if (this._todoThrottleTimer) {
            clearTimeout(this._todoThrottleTimer);
            this._todoThrottleTimer = null;
            this.extractTodosFromStream(this.fullTextBuffer);
        }
    },

    feedTypewriter(newText) {
        this.fullTextBuffer += newText;
        if (!this._todoThrottleTimer) {
            this._todoThrottleTimer = setTimeout(() => {
                this._todoThrottleTimer = null;
                this.extractTodosFromStream(this.fullTextBuffer);
            }, 2000);
        }
        if (!this.typewriterTimer) this.typewriterTick();
    },

    typewriterTick() {
        if (this.displayedLength >= this.fullTextBuffer.length) {
            this.typewriterTimer = null;
            if (this.typewriterTextBlock && this.fullTextBuffer) {
                this.asyncRenderMarkdown(this.fullTextBuffer, (html) => {
                    if (this.typewriterTextBlock) this.typewriterTextBlock.innerHTML = html;
                });
            }
            return;
        }

        const backlog = this.fullTextBuffer.length - this.displayedLength;

        if (backlog > 500) {
            this.displayedLength = this.fullTextBuffer.length;
            this._scheduleMarkdownRender(true);
            this.scheduleScroll();
            this.typewriterTimer = null;
            return;
        }

        let batchSize = this.typewriterBatchSize;
        let speed = this.typewriterSpeed;

        if (backlog > 200) { batchSize = 15; speed = 8; }
        else if (backlog > 100) { batchSize = 8; speed = 16; }
        else if (backlog > 50) { batchSize = 5; speed = 20; }

        const advance = Math.min(batchSize, backlog);
        this.displayedLength += advance;

        this._scheduleMarkdownRender(false);

        this.scheduleScroll();

        this.typewriterTimer = setTimeout(() => this.typewriterTick(), speed);
    },

    // 使用 RAF 调度滚动，仅做纯赋值不读取 layout 属性，避免强制布局回流
    scheduleScroll() {
        if (!this._rAFPending) {
            this._rAFPending = true;
            requestAnimationFrame(() => {
                this._rAFPending = false;
                const msgs = this._messagesContainer;
                if (msgs) {
                    // 纯赋值，不做 scrollHeight / clientHeight 读取，不触发强制 layout
                    msgs.scrollTop = msgs.scrollHeight;
                }
            });
        }
    },

    flushTypewriter() {
        if (this.typewriterTimer) {
            clearTimeout(this.typewriterTimer);
            this.typewriterTimer = null;
        }
        this.displayedLength = this.fullTextBuffer.length;
        if (this.typewriterTextBlock && this.fullTextBuffer) {
            const block = this.typewriterTextBlock;
            this.asyncRenderMarkdown(this.fullTextBuffer, (html) => {
                if (block) block.innerHTML = html;
            });
        }
        this.typewriterTextBlock = null;
        this.fullTextBuffer = '';
        this._lastRenderLength = 0;
        this._lastRenderTime = 0;
        this._plainNode = null;
        this._rAFPending = false;
    },

    _scheduleMarkdownRender(immediate) {
        const now = Date.now();
        if (!immediate && (now - (this._lastRenderTime || 0)) < 100) return;
        this._lastRenderTime = now;
        if (!this.typewriterTextBlock || !this.fullTextBuffer) return;
        const text = this.fullTextBuffer.slice(0, this.displayedLength);
        const block = this.typewriterTextBlock;
        this.asyncRenderMarkdown(text, (html) => {
            if (block === this.typewriterTextBlock) {
                block.innerHTML = html;
            }
        });
    },

    trimMessages(messages, maxChars) {
        const systemMsg = messages[0];
        const conversationMsgs = messages.slice(1);
        const systemChars = JSON.stringify(systemMsg).length;
        let remaining = maxChars - systemChars;
        if (remaining < 2000) remaining = maxChars * 0.3;

        const trimmed = [];
        for (let i = conversationMsgs.length - 1; i >= 0; i--) {
            const msgChars = JSON.stringify(conversationMsgs[i]).length;
            if (remaining - msgChars < 0 && trimmed.length > 2) break;
            remaining -= msgChars;
            trimmed.unshift(conversationMsgs[i]);
        }

        if (trimmed.length < conversationMsgs.length) {
            const summaryCount = conversationMsgs.length - trimmed.length;
            const summaryMsg = { role: 'system', content: `[之前有 ${summaryCount} 条对话消息已被省略，以下是最近的对话]` };
            return [systemMsg, summaryMsg, ...trimmed];
        }
        return messages;
    },

    async sendMessage(text) {
        if (!text.trim()) return;

        if (this.isGenerating) {
            console.warn('[AIChat] isGenerating stuck, force stopping');
            this.stopGenerationForce();
            await new Promise(r => setTimeout(r, 100));
        }

        let model = this.model;
        let temp = this.temperature;
        try { model = await window.electronAPI.store.get('versepc_ai_model') || this.model; } catch (e) {}
        try { temp = parseFloat(await window.electronAPI.store.get('versepc_ai_temp')); } catch (e) {}
        model = model || 'glm-5-flash';
        temp = isNaN(temp) ? 0.7 : temp;

        let apiKey = this.apiKey;
        let apiFormat = '';
        let customBaseUrl = '';
        const addedEntry = this.addedModels.find(m => m.modelId === model);
        if (addedEntry) {
            apiKey = addedEntry.apiKey;
            apiFormat = addedEntry.apiFormat || '';
            customBaseUrl = addedEntry.baseUrl || '';
        }
        if (!apiKey) {
            try { apiKey = await window.electronAPI.store.get('versepc_ai_api_key'); } catch (e) {}
        }
        if (!apiKey) {
            this.toggleSettings();
            return;
        }

        const conv = this.getCurrent();
        if (!conv) return;

        let messageContent = text;
        conv.messages.push({ role: 'user', content: messageContent });
        const MAX_CONV_MSGS = 50;
        if (conv.messages.length > MAX_CONV_MSGS) {
            conv.messages = conv.messages.slice(-MAX_CONV_MSGS);
        }
        if (conv.title === '新对话') {
            conv.title = text.slice(0, 30).replace(/\n/g, ' ');
        }

        if (document.getElementById('ai-welcome').style.display !== 'none') {
            this.showMessages([]);
        }

        this.appendMessage('user', text);
        this.scrollToBottom();
        this.renderSidebar();

        document.getElementById('ai-input').value = '';
        aiAutoResize(document.getElementById('ai-input'));

        this.isGenerating = true;
        this._userScrollingUp = false;
        this._lastChunkTime = Date.now();
        this._generationSeq = (this._generationSeq || 0) + 1;
        this._startWatchdog();
        this.updateSendButton(true);
        this.clearFollowUpSuggestions();
        this.currentToolCalls = [];

        this._streamWorkflowContent = this.createWorkflowBubble();
        this._streamTextBlock = null;
        this._streamFullResponse = '';

        this._safetyTimeout = null;

        if (this.chunkListener) {
            try { this.chunkListener(); } catch (e) {}
            this.chunkListener = null;
        }

        this.chunkListener = window.electronAPI.ai.onChunk((data) => {
            this._lastChunkTime = Date.now();
            if (data._genSeq && data._genSeq !== this._generationSeq) return;
            if (data.type === 'reasoning_content') {
                const q = this._chunkQueue;
                if (q.length > 0 && q[q.length - 1].type === 'reasoning_content') {
                    q[q.length - 1] = data;
                } else {
                    q.push(data);
                }
                this._startScheduler();
                return;
            }
            const logType = data.done ? 'DONE' : data.error ? 'ERROR' : data.type || 'text';
            const logExtra = data.type === 'reasoning_start' ? { state: this.thinkingBubble?.dataset?.state } :
                data.type === 'reasoning_end' ? { hasBubble: !!this.thinkingBubble } :
                data.type === 'tool_calls_start' ? { calls: (data.calls || []).length } :
                data.type === 'tool_calls_end' ? {} :
                data.type === 'tool_call_result' ? { id: data.id } :
                data.done ? { respLen: (this._streamFullResponse || '').length } :
                {};
            console.log(`[AI-CHUNK] ${logType}`, logExtra);
            if (data.done || data.error) {
                this._stopScheduler();
                this._chunkQueue.push(data);
                this._drainChunkQueue();
                return;
            }
            this._chunkQueue.push(data);
            this._startScheduler();
        });

        try {
            const sysPrompt = `You are VersePC Agent, an autonomous AI assistant that accomplishes tasks iteratively using available tools. You work within a Minecraft launcher environment, helping users manage their game, mods, versions, and system configuration.

${this.userMemory ? `## User Preferences
${this.userMemory}

` : ''}## Environment
- OS: ${navigator.platform || 'Windows'}
- Available tools: bash, str_replace_based_edit_tool, json_edit_tool, sequential_thinking, attempt_completion, ckg, update_todo_list

## Tool Use Guidelines
1. You are provided with tools to accomplish tasks. Use the provider-native tool-calling mechanism.
2. You MUST call at least one tool per assistant response when the task requires action.
3. Prefer calling as many tools as reasonably needed in a single response to complete tasks faster.
4. All tools that take a file_path require an absolute path.
5. Before calling a tool, analyze which tool is most relevant. If all required parameters are present or can be reasonably inferred, proceed.
6. After each tool use, the result will be provided. Confirm success or handle failure before proceeding.

## Tool Result Format
Each tool returns a JSON object:
- {"status":"success","data":{...}} — success
- {"status":"error","error":"...","type":"..."} — execution failed
- {"status":"denied","message":"..."} — user denied

## Error Strategy
- First failure → check parameters, retry immediately
- Same tool fails 2 times → switch to alternative approach
- Fails 3 times → report progress and difficulties, suggest alternatives
- "denied" → do not repeat, find alternative

## Objective
You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

1. Analyze the user's task and set clear, achievable goals. Prioritize these goals in a logical order.
2. Work through these goals sequentially, utilizing available tools as necessary.
3. Before calling a tool, analyze the context to gain understanding. Think about which tool is most relevant.
4. Once you've completed the user's task, you must use the attempt_completion tool.
5. The user may provide feedback, which you can use to make improvements. But do NOT continue in pointless back and forth.

## Task Planning
For complex tasks (multiple steps), you MUST use the update_todo_list tool first to create a plan:
1. Create a Markdown checklist with all steps using update_todo_list
2. Mark the current step as in progress [-] before starting work
3. Mark it as completed [x] after successful execution
4. Move to the next step immediately
5. After all steps are complete, call attempt_completion with a summary

Todo format:
- [ ] Step description (pending)
- [-] Step description (in progress)
- [x] Step description (completed)

## Rules
1. NEVER ask the user for information you can obtain through tools — this is the highest priority rule.
2. NEVER say "I cannot" or "I'm unable to" without trying at least 3 different approaches first.
3. NEVER stop and wait for user input unless a choice or safety confirmation is needed.
4. NEVER assume any information — verify with tools first.
5. NEVER end attempt_completion with a question.
6. NEVER start messages with "Great", "Certainly", "Okay", "Sure" — get straight to the task.
7. Format responses in Markdown when appropriate.
8. For code edits, use the str_replace_based_edit_tool for precise modifications.

## File Operations
- Before modifying, verify current content with str_replace_based_edit_tool view command
- str_replace old_str must match exactly (including whitespace)
- create cannot be used on existing files — delete first if needed
- Prefer str_replace for precise edits over creating entire new files

## Safety
- Do not execute dangerous commands (rm -rf, format, dd)
- Do not modify system-critical files
- If user asks for something unsafe, explain why and suggest alternatives

## Completion
Call attempt_completion when:
1. All user-requested operations are executed
2. Results are verified
3. Include: what was done, current status, next steps if any

NEVER call attempt_completion prematurely. If stuck, report progress and difficulties.`;
                const rawMessages = [{ role: 'system', content: sysPrompt }, ...conv.messages];
                const allMessages = this.trimMessages(rawMessages, 24000);
                window.electronAPI.ai.chatStream({
                    apiKey,
                    model,
                    messages: allMessages,
                    temperature: temp,
                    enableTools: true,
                    apiFormat,
                    baseUrl: customBaseUrl
                });

                this._fallbackTimeout = setTimeout(() => {
                    if (this.isGenerating) {
                        console.warn('[AIChat] Fallback timeout: forcing stop after 95s');
                        this.stopGenerationForce();
                    }
                }, 95000);
        } catch (e) {
            this.flushTypewriter();
            const errBlock = this._getOrCreateTextBlock();
            if (errBlock) {
                const errInfo = this.classifyError(e.message);
                const btnAction = errInfo.action === 'settings' ? "AIChat.toggleSettings()" : "AIChat.retryLastMessage()";
                errBlock.innerHTML = `<div class="ai-error-card"><div class="ai-error-icon">${errInfo.icon}</div><div class="ai-error-content"><div class="ai-error-title">${errInfo.title}</div><div class="ai-error-detail">${this.escapeHtml(e.message || '请求失败')}</div></div><button class="ai-error-retry" onclick="${btnAction}">${errInfo.retryLabel}</button></div>`;
            }
            this.stopGeneration(e.message || '请求失败', true);
        }
    },

    _cleanupGenerationState() {
        if (this.chunkListener) {
            try { this.chunkListener(); } catch (e) {}
            this.chunkListener = null;
        }

        const clearTimer = (name) => {
            if (this[name]) {
                try { clearInterval(this[name]); } catch (e) {}
                try { clearTimeout(this[name]); } catch (e) {}
                this[name] = null;
            }
        };
        const cancelRAF = (name) => {
            if (this[name]) {
                try { cancelAnimationFrame(this[name]); } catch (e) {}
                this[name] = null;
            }
        };

        clearTimer('typewriterTimer');
        clearTimer('_todoThrottleTimer');
        clearTimer('_reasoningTimer');
        cancelRAF('_reasoningRAF');
        clearTimer('_watchdogTimer');
        clearTimer('_mdRenderTimer');
        clearTimer('_thinkingChainTimer');
        cancelRAF('_toolResultRAF');

        if (this._scrollTimer) {
            try { clearTimeout(this._scrollTimer); } catch (e) {}
            try { cancelAnimationFrame(this._scrollTimer); } catch (e) {}
            this._scrollTimer = null;
        }
        this._lastScrollTime = null;

        this._apiStatusBubble = null;

        if (this._safetyTimeout) { clearTimeout(this._safetyTimeout); this._safetyTimeout = null; }
        if (this._fallbackTimeout) { clearTimeout(this._fallbackTimeout); this._fallbackTimeout = null; }
        if (this._sseHandle) { this._sseHandle.abort(); this._sseHandle = null; }

        this._stopScheduler();
        this._chunkQueue = [];
        this._domBatchQueue = [];
        this._domBatchFlushScheduled = false;

        if (this.thinkingBubble && this.thinkingBubble.isConnected) {
            const b = this.thinkingBubble;
            b.dataset.state = 'done';
            b.classList.remove('expanded');
            const label = b.querySelector('.rc-chain-label');
            const timer = b.querySelector('.rc-chain-timer');
            if (label) label.textContent = '思考完成';
            if (timer) timer.textContent = '';
        }

        this.thinkingBubble = null;
        this._thinkingContentEl = null;
        this._thinkingTimerEl = null;
        this._thinkingChainBubble = null;
        this._thinkingChainStepsEl = null;
        this._thinkingChainStartTime = null;
        this.thinkingContent = '';
        this.thinkingStartTime = 0;
        this._lastReasoningRender = null;
        this._thinkingSteps = null;
        this._currentThinkingStep = null;
        this._pendingThinkingSteps = [];
        this._thinkingFlushScheduled = false;
        this.toolCallBubble = null;
        this.currentToolCalls = [];
        this.fullTextBuffer = '';
        this.displayedLength = 0;
        this._rAFPending = false;
        this._streamTextBlock = null;
        this._streamFullResponse = '';
        this._streamWorkflowContent = null;
    },

    stopGeneration(finalContent, isError) {
        console.log(`[AI-STOP] stopGeneration called, thinkingBubble: ${!!this.thinkingBubble}, state: ${this.thinkingBubble?.dataset?.state}`);
        this.isGenerating = false;
        this.updateSendButton(false);

        try {

        this._cleanupGenerationState();

        if (this._todoThrottleTimer) {
            this.extractTodosFromStream(this.fullTextBuffer);
        }

        if (this._currentToolUseBlocks) {
            for (const block of this._currentToolUseBlocks) {
                if (block && block.dataset && block.dataset.status === 'running') {
                    block.dataset.status = 'failed';
                    const spinner = block.querySelector('.ai-tool-row-spinner');
                    if (spinner) spinner.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
                }
            }
            this._currentToolUseBlocks = [];
        }

        const wf = document.getElementById('ai-active-workflow');
        if (wf) {
            wf.classList.remove('ai-streaming-msg');
            wf.removeAttribute('id');
        }

        if (finalContent && !isError) {
            if (typeof finalContent !== 'string') {
                try { finalContent = JSON.stringify(finalContent, null, 2); } catch (e) { finalContent = String(finalContent); }
            }
            let cleanContent = finalContent;
            const memoryMatches = [...finalContent.matchAll(/\[MEMORY:(.*?)\]/g)];
            if (memoryMatches.length > 0) {
                const newMemories = memoryMatches.map(m => m[1].trim()).filter(m => m);
                if (newMemories.length > 0) {
                    const existing = this.userMemory ? this.userMemory.split('\n') : [];
                    const memorySet = new Set(existing.map(m => m.trim()).filter(m => m));
                    for (const mem of newMemories) {
                        memorySet.add(mem);
                    }
                    this.userMemory = [...memorySet].slice(-20).join('\n');
                    this.saveUserMemory();
                }
                cleanContent = finalContent.replace(/\[MEMORY:.*?\]/g, '').trim();
            }

            const conv = this.getCurrent();
            if (conv) {
                conv.messages.push({ role: 'assistant', content: cleanContent || finalContent });
                if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
                this.saveConversations();
            }

            if (cleanContent !== finalContent) {
                const lastTextBlock = document.querySelector('#ai-messages .ai-workflow-text:last-child');
                if (lastTextBlock) {
                    this.asyncRenderMarkdown(cleanContent, (html) => {
                        if (lastTextBlock) lastTextBlock.innerHTML = html;
                    });
                }
            }

            if (this.settings && this.settings.soundEnabled !== false) {
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(523, ctx.currentTime);
                    osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1);
                    osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2);
                    gain.gain.setValueAtTime(this.settings.soundVolume || 0.3, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
                    osc.start(ctx.currentTime);
                    osc.stop(ctx.currentTime + 0.4);
                } catch(e) {}
            }

        }

        const inputArea = document.querySelector('.rc-input-area');
        if (inputArea) inputArea.style.display = '';
        } catch (e) {
            console.error('[AIChat] stopGeneration error:', e);
            this.isGenerating = false;
            try { this.updateSendButton(false); } catch (e2) {}
        }
    },

    stopGenerationForce() {
        if (!this.isGenerating) return;
        console.log(`[AI-STOP] stopGenerationForce called, thinkingBubble: ${!!this.thinkingBubble}, state: ${this.thinkingBubble?.dataset?.state}`);

        try { window.electronAPI.ai.chatAbort(); } catch (e) {}
        try { this.flushTypewriter(); } catch (e) {}

        this._cleanupGenerationState();

        this.isGenerating = false;
        this.updateSendButton(false);

        const wf = document.getElementById('ai-active-workflow');
        if (wf) {
            const textBlocks = wf.querySelectorAll('.ai-workflow-text');
            let lastText = '';
            for (const block of textBlocks) {
                const t = block.innerText.replace(/[\u200B\uFEFF]/g, '').trim();
                if (t) lastText = t;
            }
            if (lastText) {
                const conv = this.getCurrent();
                if (conv) {
                    conv.messages.push({ role: 'assistant', content: lastText });
                    if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
                }
            }
            wf.classList.remove('ai-streaming-msg');
            wf.removeAttribute('id');
        }

        const inputArea = document.querySelector('.rc-input-area');
        if (inputArea) inputArea.style.display = '';

        this.saveConversations();
    },

    _startWatchdog() {
        if (this._watchdogTimer) return;
        this._lastChunkTime = Date.now();
        this._watchdogTick = 0;
        this._watchdogTimer = setInterval(() => {
            if (!this.isGenerating) return;
            if (!this._lastChunkTime) this._lastChunkTime = Date.now();
            const elapsed = Date.now() - this._lastChunkTime;
            this._watchdogTick++;
            if (elapsed > 45000) {
                console.warn(`[AIChat] Watchdog: no chunks for ${Math.round(elapsed/1000)}s, force stopping`);
                this.stopGenerationForce();
                return;
            }
            if (this._chunkQueue && this._chunkQueue.length > 100) {
                console.warn(`[AIChat] Watchdog: chunk queue overflow (${this._chunkQueue.length}), force stopping`);
                this.stopGenerationForce();
            }
        }, 5000);
    },

    _initScheduler() {
        this._domBatchQueue = [];
        this._domBatchFlushScheduled = false;
        this._schedulerTimer = null;
    },

    _startScheduler() {
        if (this._schedulerTimer) return;
        this._schedulerTick();
    },

    _stopScheduler() {
        if (this._schedulerTimer) {
            clearTimeout(this._schedulerTimer);
            this._schedulerTimer = null;
        }
    },

    _schedulerTick() {
        this._schedulerTimer = null;
        if (this._chunkQueue.length === 0) return;

        this._dedupReasoningChunks();

        const BUDGET = 4;
        const start = performance.now();
        while (this._chunkQueue.length > 0 && performance.now() - start < BUDGET) {
            const chunk = this._chunkQueue.shift();
            try { this._processChunk(chunk); } catch (e) { console.error('[AIChat] _processChunk error:', e); }
        }

        if (this._domBatchQueue.length > 0) {
            this._flushDOMBatch();
        }

        if (this._chunkQueue.length > 0) {
            this._schedulerTimer = setTimeout(() => this._schedulerTick(), 0);
        }
    },

    _dedupReasoningChunks() {
        const q = this._chunkQueue;
        if (q.length < 3) return;
        let lastReasoningIdx = -1;
        for (let i = q.length - 1; i >= 0; i--) {
            if (q[i].type === 'reasoning_content') {
                if (lastReasoningIdx === -1) {
                    lastReasoningIdx = i;
                }
            } else {
                break;
            }
        }
        if (lastReasoningIdx > 0) {
            q.splice(0, lastReasoningIdx);
        }
    },

    _drainChunkQueue() {
        this._dedupReasoningChunks();
        const DRAIN_BUDGET = 8;
        const start = performance.now();
        while (this._chunkQueue.length > 0 && performance.now() - start < DRAIN_BUDGET) {
            const chunk = this._chunkQueue.shift();
            try { this._processChunk(chunk); } catch (e) { console.error('[AIChat] _processChunk error:', e); }
        }
        if (this._domBatchQueue.length > 0) {
            this._flushDOMBatch();
        }
        if (this._chunkQueue.length > 0) {
            this._schedulerTimer = setTimeout(() => this._drainChunkQueue(), 0);
        }
    },

    _scheduleDOMBatch(fn) {
        this._domBatchQueue.push(fn);
        if (!this._domBatchFlushScheduled) {
            this._domBatchFlushScheduled = true;
            if (typeof requestAnimationFrame !== 'undefined') {
                requestAnimationFrame(() => this._flushDOMBatch());
            } else {
                setTimeout(() => this._flushDOMBatch(), 0);
            }
        }
    },

    _flushDOMBatch() {
        this._domBatchFlushScheduled = false;
        const batch = this._domBatchQueue;
        if (batch.length === 0) return;
        this._domBatchQueue = [];
        const DOM_BUDGET = 4;
        const start = performance.now();
        for (let i = 0; i < batch.length; i++) {
            if (i > 0 && performance.now() - start > DOM_BUDGET) {
                this._domBatchQueue.push(...batch.slice(i));
                if (!this._domBatchFlushScheduled) {
                    this._domBatchFlushScheduled = true;
                    if (typeof requestAnimationFrame !== 'undefined') {
                        requestAnimationFrame(() => this._flushDOMBatch());
                    } else {
                        setTimeout(() => this._flushDOMBatch(), 0);
                    }
                }
                return;
            }
            try { batch[i](); } catch (e) {}
        }
    },

    _getOrCreateTextBlock() {
        if (!this._streamTextBlock) {
            if (!this._streamWorkflowContent) return null;
            this._streamTextBlock = document.createElement('div');
            this._streamTextBlock.className = 'ai-workflow-block ai-workflow-text';
            this._streamWorkflowContent.appendChild(this._streamTextBlock);
            this.startTypewriter(this._streamTextBlock);
        }
        return this._streamTextBlock;
    },

    _processChunk(data) {
        const chunkType = data.done ? 'DONE' : data.error ? 'ERROR' : data.type || 'say';
        if (chunkType !== 'reasoning_content') {
            console.log(`[AI-PROC] ${chunkType}`, data.type ? {} : { say: data.say, partial: data.partial });
        }
        if (data.error) {
            this._streamFullResponse = data.error;
            this.flushTypewriter();
            const block = this._getOrCreateTextBlock();
            if (block) {
                const errInfo = this.classifyError(data.error);
                const btnAction = errInfo.action === 'settings' ? "AIChat.toggleSettings()" : "AIChat.retryLastMessage()";
                block.innerHTML = `<div class="ai-error-card"><div class="ai-error-icon">${errInfo.icon}</div><div class="ai-error-content"><div class="ai-error-title">${errInfo.title}</div><div class="ai-error-detail">${this.escapeHtml(data.error)}</div></div><button class="ai-error-retry" onclick="${btnAction}">${errInfo.retryLabel}</button></div>`;
            }
            const wf = document.getElementById('ai-active-workflow');
            if (wf) wf.classList.remove('ai-streaming-msg');
            this.stopGeneration(this._streamFullResponse, true);
            return;
        }

        if (data.type === 'approval_requested') {
            const { approvalId, toolName, risk, args } = data;
            const desc = this.getToolActionDescription(toolName, JSON.stringify(args || {})) || TOOL_DISPLAY_NAMES[toolName] || toolName;
            const riskColor = risk === 'dangerous' ? '#ef4444' : risk === 'moderate' ? '#f59e0b' : '#22c55e';
            const riskLabel = risk === 'dangerous' ? '高风险' : risk === 'moderate' ? '中风险' : '低风险';

            this._scheduleDOMBatch(() => {
                const block = this._getOrCreateTextBlock();
                if (!block) return;
                const div = document.createElement('div');
                div.className = 'ai-approval-card';
                div.id = 'approval-' + approvalId;
                div.innerHTML = `
                    <div class="ai-approval-header">
                        <span class="ai-approval-icon">⚠️</span>
                        <span class="ai-approval-title">需要授权</span>
                        <span class="ai-approval-risk" style="color:${riskColor}">${riskLabel}</span>
                    </div>
                    <div class="ai-approval-desc">${this.escapeHtml(desc)}</div>
                    <div class="ai-approval-actions">
                        <button class="ai-approval-btn approve" data-approval-id="${approvalId}">允许</button>
                        <button class="ai-approval-btn deny" data-approval-id="${approvalId}">拒绝</button>
                    </div>`;
                block.appendChild(div);

                div.querySelector('.ai-approval-btn.approve').addEventListener('click', () => {
                    try { window.electronAPI.ai.toolApprove(approvalId, true); } catch (e) {}
                    div.classList.add('resolved');
                    div.querySelector('.ai-approval-actions').innerHTML = '<span class="ai-approval-status approved">✓ 已允许</span>';
                });
                div.querySelector('.ai-approval-btn.deny').addEventListener('click', () => {
                    try { window.electronAPI.ai.toolApprove(approvalId, false); } catch (e) {}
                    div.classList.add('resolved');
                    div.querySelector('.ai-approval-actions').innerHTML = '<span class="ai-approval-status denied">✗ 已拒绝</span>';
                });
            });
            return;
        }

        if (data.type === 'thinking_step') {
            const step = data.step;
            if (!step) return;
            if (!this._pendingThinkingSteps) this._pendingThinkingSteps = [];
            this._pendingThinkingSteps.push(step);
            if (!this._thinkingFlushScheduled) {
                this._thinkingFlushScheduled = true;
                setTimeout(() => {
                    this._thinkingFlushScheduled = false;
                    this._flushThinkingSteps();
                }, 0);
            }
            return;
        }

        if (data.type === 'tool_calls_start') {
            if (this.thinkingBubble && this.thinkingBubble.dataset.state === 'streaming') {
                const b = this.thinkingBubble;
                b.dataset.state = 'done';
                b.classList.remove('expanded');
                const icon = b.querySelector('.rc-chain-icon');
                const label = b.querySelector('.rc-chain-label');
                if (icon) icon.classList.remove('spinning');
                if (label) label.textContent = '思考完成';
            }
            this.thinkingBubble = null;
            this._thinkingContentEl = null;
            this._thinkingTimerEl = null;
            if (this._reasoningTimer) { clearInterval(this._reasoningTimer); this._reasoningTimer = null; }
            this.currentToolCalls = data.calls || [];
            this.toolCallStartTime = Date.now();
            if (this.typewriterTimer) {
                clearTimeout(this.typewriterTimer);
                this.typewriterTimer = null;
            }
            this._streamTextBlock = null;
            const calls = data.calls;
            this._scheduleDOMBatch(() => {
                for (const call of calls) {
                    this.appendToolCallBubble(call);
                }
                if (this._toolBubbleFragment && this._pendingToolBubbles > 0) {
                    const container = this.currentWorkflowContent || this._messagesContainer;
                    if (container) container.appendChild(this._toolBubbleFragment);
                    this._toolBubbleFragment = null;
                    this._pendingToolBubbles = 0;
                }
            });
            return;
        }

        if (data.type === 'tool_call_exec') {
            return;
        }

        if (data.type === 'reasoning_start') {
            if (data.silent) return;
            if (this._reasoningTimer) { clearInterval(this._reasoningTimer); this._reasoningTimer = null; }
            if (this._reasoningRAF) { cancelAnimationFrame(this._reasoningRAF); this._reasoningRAF = null; }
            this.thinkingContent = '';
            this.thinkingStartTime = Date.now();
            this._thinkingSteps = [];
            this._currentThinkingStep = null;

            const CHEVRON_S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>';
            const LIGHTBULB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>';
            const bubble = document.createElement('div');
            bubble.className = 'rc-thinking-chain expanded';
            bubble.dataset.state = 'streaming';
            bubble.dataset.thinkingContent = '';
            bubble.innerHTML = `<div class="rc-chain-header" onclick="AIChat.toggleReasoningBlock(this.parentElement)"><div class="rc-chain-header-left"><div class="rc-chain-icon">${LIGHTBULB}</div><span class="rc-chain-label">思考中</span><span class="rc-chain-timer"></span></div>${CHEVRON_S}</div><div class="rc-chain-body"><div class="rc-chain-content"></div></div>`;

            this.thinkingBubble = bubble;
            this._thinkingContentEl = bubble.querySelector('.rc-chain-content');
            this._thinkingTimerEl = bubble.querySelector('.rc-chain-timer');

            this._scheduleDOMBatch(() => {
                this.appendWorkflowBlock(bubble);
                this._hideOldThinkingChains();
                this._reasoningTimer = setInterval(() => {
                    if (this._thinkingTimerEl && this.thinkingBubble && this.thinkingBubble.dataset.state === 'streaming') {
                        const s = Math.floor((Date.now() - this.thinkingStartTime) / 1000);
                        this._thinkingTimerEl.textContent = s > 0 ? s + 's' : '';
                    }
                }, 1000);
            });
            if (data.content) {
                this.thinkingContent = data.content;
            }
            return;
        }

        if (data.type === 'reasoning_content') {
            if (this.thinkingBubble) {
                this.thinkingContent = data.content || '';
                const now = Date.now();
                const queueLen = this._chunkQueue.length;
                const throttle = queueLen > 30 ? 1000 : queueLen > 15 ? 600 : 350;
                if (!this._lastReasoningRender || now - this._lastReasoningRender > throttle) {
                    this._lastReasoningRender = now;
                    if (queueLen > 40) {
                        this._scrollDebounced();
                        return;
                    }
                    const content = this.thinkingContent;
                    const el = this._thinkingContentEl;
                    if (!this._reasoningRAF && el) {
                        this._reasoningRAF = requestAnimationFrame(() => {
                            this._reasoningRAF = null;
                            if (this.thinkingBubble && el) {
                                const MAX_DISPLAY = 5000;
                                el.textContent = content.length > MAX_DISPLAY ? content.slice(-MAX_DISPLAY) + '\n...(已截断)' : content;
                            }
                        });
                    }
                }
                this._scrollDebounced();
            }
            return;
        }

        if (data.type === 'reasoning_end') {
            if (this._reasoningTimer) { clearInterval(this._reasoningTimer); this._reasoningTimer = null; }
            if (this._reasoningRAF) { cancelAnimationFrame(this._reasoningRAF); this._reasoningRAF = null; }
            const bubble = this.thinkingBubble;
            const startTime = this.thinkingStartTime;
            const content = this.thinkingContent;
            const contentEl = this._thinkingContentEl;
            this._scheduleDOMBatch(() => {
                if (bubble) {
                    bubble.dataset.state = 'done';
                    bubble.classList.remove('expanded');
                    if (content) bubble.dataset.thinkingContent = content;
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const label = bubble.querySelector('.rc-chain-label');
                    const timer = bubble.querySelector('.rc-chain-timer');
                    if (label) label.textContent = '思考完成';
                    if (timer) timer.textContent = elapsed > 0 ? elapsed + 's' : '';
                }
                if (contentEl && content) {
                    const MAX_DISPLAY = 5000;
                    contentEl.textContent = content.length > MAX_DISPLAY ? content.slice(-MAX_DISPLAY) + '\n...(已截断)' : content;
                }
            });
            this.thinkingBubble = null;
            this._thinkingContentEl = null;
            this._thinkingTimerEl = null;
            this._lastReasoningRender = null;
            this._thinkingSteps = null;
            this._currentThinkingStep = null;
            return;
        }

        if (data.type === 'tool_call_result') {
            if (data.name === 'todo_write') {
                try {
                    const parsed = JSON.parse(data.result || '{}');
                    if (Array.isArray(parsed.todos) && parsed.todos.length > 0) {
                        this._todos = parsed.todos.map(t => ({
                            id: t.id || String(Date.now()),
                            content: t.content || '',
                            status: t.status || 'pending',
                            priority: t.priority || 'medium'
                        }));
                        this.updateTodoBar();
                    }
                } catch (e) {}
            }
            if (data.name === 'update_todo_list') {
                try {
                    const parsed = JSON.parse(data.result || '{}');
                    const todosStr = parsed.todos || '';
                    if (todosStr) {
                        const parsed_todos = this.parseTodosFromText(todosStr);
                        if (parsed_todos.length > 0) {
                            this._todos = parsed_todos.map((t, i) => ({
                                id: 'task-' + (i + 1),
                                content: t.content,
                                status: t.status,
                                priority: 'medium'
                            }));
                            this.updateTodoBar();
                        }
                    }
                } catch (e) {}
            }
            if (!this._pendingToolResults) this._pendingToolResults = {};
            let isError = false;
            let status = 'success';
            const resultStr = data.result || '';
            if (resultStr.includes('"status":"error"') || resultStr.includes('"status":"denied"') || resultStr.includes('"error":"')) {
                isError = true;
                status = resultStr.includes('"status":"denied"') ? 'denied' : 'error';
            }
            this._pendingToolResults[data.id] = { id: data.id, name: data.name, result: data.result, isError, status };

            return;
        }

        if (data.type === 'install_progress') {
            this.updateInstallProgress(data.toolCallId, data.toolName, data.progress, data.status);
            return;
        }

        if (data.type === 'tool_calls_end') {
            if (this.typewriterTimer) {
                clearTimeout(this.typewriterTimer);
                this.typewriterTimer = null;
            }

            if (this._pendingToolResults && Object.keys(this._pendingToolResults).length > 0) {
                const results = Object.values(this._pendingToolResults);
                if (!this._toolResultQueue) this._toolResultQueue = [];
                this._toolResultQueue.push(...results);
                if (!this._toolResultRAF) {
                    this._toolResultRAF = requestAnimationFrame(() => {
                        this._toolResultRAF = null;
                        const queue = this._toolResultQueue;
                        this._toolResultQueue = [];
                        for (let i = 0; i < queue.length; i++) {
                            this._applyToolCallStatus(queue[i]);
                        }
                        const lastRow = queue.length > 0 ? document.getElementById('tool-' + queue[queue.length - 1].id) : null;
                        if (lastRow) {
                            const block = lastRow.querySelector('.ai-tool-use-block');
                            const header = lastRow.querySelector('.ai-tool-row-header');
                            if (block && header) {
                                block.classList.add('open');
                                block.style.maxHeight = '2000px';
                                block.style.padding = '8px';
                                const chevron = header.querySelector('.ai-tool-row-chevron');
                                if (chevron) chevron.style.transform = 'rotate(180deg)';
                                this._lazyRenderToolResult(lastRow);
                            }
                        }
                    });
                }
                this._pendingToolResults = {};
            }

            const runningRows = document.querySelectorAll('.ai-tool-row.running');
            runningRows.forEach(row => {
                row.classList.remove('running');
                row.classList.add('done');
                const spinner = row.querySelector('.ai-tool-row-spinner');
                if (spinner) spinner.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
            });

            this.typewriterTextBlock = null;
            this.toolCallBubble = null;
            this.currentToolCalls = [];
            return;
        }

        if (data.type === 'say' && data.say === 'api_req_started') {
            if (!this._apiStatusBubble) {
                const bubble = document.createElement('div');
                bubble.className = 'ai-api-status';
                bubble.innerHTML = '<div class="ai-api-status-spinner"></div><span class="ai-api-status-text">请求中...</span>';
                this._scheduleDOMBatch(() => {
                    this.appendWorkflowBlock(bubble);
                });
                this._apiStatusBubble = bubble;
            }
            return;
        }

        if (data.type === 'say' && data.say === 'api_req_finished') {
            if (this._apiStatusBubble) {
                const bubble = this._apiStatusBubble;
                this._scheduleDOMBatch(() => {
                    if (bubble && bubble.isConnected) {
                        const text = bubble.querySelector('.ai-api-status-text');
                        if (text) text.textContent = '完成';
                        const spinner = bubble.querySelector('.ai-api-status-spinner');
                        if (spinner) spinner.className = 'ai-api-status-done';
                    }
                });
                this._apiStatusBubble = null;
            }
            return;
        }

        if (data.type === 'say' && data.say === 'completion') {
            this.flushTypewriter();
            const content = data.text || '';
            const bubble = document.createElement('div');
            bubble.className = 'ai-msg';
            bubble.style.cssText = 'padding:10px 15px 10px 6px;';
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:default;margin-bottom:10px;word-break:break-word;';
            header.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span style="font-weight:bold;color:#22c55e">任务完成</span>`;
            const contentWrapper = document.createElement('div');
            contentWrapper.style.cssText = 'padding-left:24px;border-left:2px solid rgba(34,197,94,0.3);margin-left:2px;';
            if (content) {
                this.asyncRenderMarkdown(content, (html) => { contentWrapper.innerHTML = html; });
            }
            bubble.appendChild(header);
            bubble.appendChild(contentWrapper);
            this._scheduleDOMBatch(() => {
                this.appendWorkflowBlock(bubble);
            });
            return;
        }

        if (data.type === 'say') {
            const content = data.text || data.content || '';
            if (content) {
                const textContent = typeof content === 'string' ? content : (typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content));
                this._streamFullResponse += textContent;
                const textBlock = this._getOrCreateTextBlock();
                if (textBlock) {
                    this.feedTypewriter(textContent);
                }
            }
            return;
        }

        if (data.content || data.text) {
            let content = data.content || data.text;
            if (typeof content !== 'string') {
                try { content = JSON.stringify(content, null, 2); } catch (e) { content = String(content); }
            }
            this._streamFullResponse += content;
            const textBlock = this._getOrCreateTextBlock();
            if (textBlock) {
                this.feedTypewriter(content);
            }
        }
        if (data.type === 'completion') {
            this.flushTypewriter();
            const completionText = data.text || '';
            if (completionText.trim()) {
                this.feedTypewriter('\n\n' + completionText);
                this.flushTypewriter();
            }
        }

        if (data.type === 'followup_suggestions' || (data.type === 'say' && data.say === 'followup')) {
            const suggestions = data.suggestions || data.items || [];
            const question = data.question || data.text || '';
            if (suggestions.length === 0 && !question) return;

            const container = document.createElement('div');
            container.className = 'ai-follow-up';

            if (question) {
                const qEl = document.createElement('div');
                qEl.className = 'ai-follow-up-question';
                qEl.textContent = question;
                container.appendChild(qEl);
            }

            const chipWrap = document.createElement('div');
            chipWrap.className = 'ai-follow-up-chips';
            for (const s of suggestions) {
                const chip = document.createElement('button');
                chip.className = 'ai-suggestion-chip';
                chip.textContent = typeof s === 'string' ? s : (s.text || s.label || '');
                chip.addEventListener('click', () => {
                    const input = document.getElementById('ai-input');
                    if (input) {
                        input.value = chip.textContent;
                        input.dispatchEvent(new Event('input'));
                    }
                    this.sendMessage();
                });
                chipWrap.appendChild(chip);
            }
            container.appendChild(chipWrap);

            this._scheduleDOMBatch(() => {
                this.appendWorkflowBlock(container);
            });
            return;
        }

        if (data.done) {
            this.flushTypewriter();

            if (data.reason === 'max_rounds' && !this._streamFullResponse.trim()) {
                const block = document.createElement('div');
                block.className = 'ai-workflow-block ai-workflow-text';
                block.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;display:flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ai-svg-icon" style="color:#f59e0b"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> 操作步骤较多，已达到最大执行轮次。如需继续，请发送新消息。</div>';
                const wf = document.getElementById('ai-active-workflow');
                if (wf) wf.querySelector('.ai-msg-content').appendChild(block);
            }
            this.stopGeneration(this._streamFullResponse, !!data.error);
        }
    },

    _scrollDebounced() {
        if (this._scrollTimer) return;
        if (this._lastScrollTime && Date.now() - this._lastScrollTime < 200) {
            this._scrollTimer = setTimeout(() => {
                this._scrollTimer = null;
                this.scrollToBottom();
            }, 200);
            return;
        }
        this._scrollTimer = requestAnimationFrame(() => {
            this._scrollTimer = null;
            this.scrollToBottom();
            this._lastScrollTime = Date.now();
        });
    },


    _hideOldThinkingChains() {
        const chains = document.querySelectorAll('.rc-thinking-chain');
        if (chains.length <= 1) return;
        const lastChain = chains[chains.length - 1];
        chains.forEach(c => {
            if (c === lastChain) return;
            c.style.display = 'none';
        });
    },

    _flushThinkingSteps() {
        const steps = this._pendingThinkingSteps;
        if (!steps || steps.length === 0) return;
        this._pendingThinkingSteps = [];

        if (!this._thinkingChainBubble) {
            const bubble = document.createElement('div');
            bubble.className = 'rc-thinking-chain expanded';
            bubble.dataset.state = 'streaming';
            const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="6 9 12 15 18 9"/></svg>';
            const SPINNER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M12 2a10 10 0 0 1 10 10"/><path d="M12 2v4"/><circle cx="12" cy="12" r="3"/></svg>';
            bubble.innerHTML = `<div class="rc-chain-header" onclick="AIChat.toggleReasoningBlock(this.parentElement)"><div class="rc-chain-header-left"><div class="rc-chain-icon spinning">${SPINNER}</div><span class="rc-chain-label">思考中...</span><span class="rc-chain-timer"></span></div>${CHEVRON}</div><div class="rc-chain-body"><div class="rc-chain-steps"></div></div>`;
            this.appendWorkflowBlock(bubble);
            this._thinkingChainBubble = bubble;
            this._hideOldThinkingChains();
            this._thinkingChainStepsEl = bubble.querySelector('.rc-chain-steps');
            this._thinkingChainStartTime = Date.now();
            if (this._thinkingChainTimer) clearInterval(this._thinkingChainTimer);
            this._thinkingChainTimer = setInterval(() => {
                const b = this._thinkingChainBubble;
                if (!b) return;
                const timerEl = b.querySelector('.rc-chain-timer');
                if (timerEl && b.dataset.state === 'streaming') {
                    const s = Math.floor((Date.now() - this._thinkingChainStartTime) / 1000);
                    timerEl.textContent = s > 0 ? s + 's' : '';
                }
            }, 1000);
        }

        const stepsEl = this._thinkingChainStepsEl;
        if (!stepsEl) return;
        const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" style="width:10px;height:10px"><polyline points="3 8 7 12 13 4"/></svg>';
        const EDIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:10px;height:10px"><path d="M11 2l3 3-9 9H2v-3z"/></svg>';

        for (const step of steps) {
            const existingStep = stepsEl.querySelector(`[data-thought="${step.thought_number}"]`);
            if (existingStep) {
                const contentEl = existingStep.querySelector('.rc-step-content');
                if (contentEl) {
                    const textEl = contentEl.querySelector('.rc-step-text');
                    if (textEl) textEl.textContent = step.thought;
                }
                if (step.is_revision) existingStep.classList.add('revision');
                continue;
            }
            const el = document.createElement('div');
            el.className = 'rc-chain-step done';
            el.dataset.thought = step.thought_number;
            if (step.is_revision) el.classList.add('revision');
            if (step.branch_from_thought) el.classList.add('branch');
            const total = step.total_thoughts;
            el.innerHTML = `<div class="rc-step-indicator"><div class="rc-step-dot">${step.is_revision ? EDIT : CHECK}</div><div class="rc-step-line"></div></div><div class="rc-step-content"><span class="rc-step-number">${step.thought_number}/${total}</span>${step.is_revision ? '<span class="rc-step-badge revision">修正</span>' : ''}${step.branch_from_thought ? '<span class="rc-step-badge branch">分支</span>' : ''}<span class="rc-step-text">${this._escapeHtml(step.thought)}</span></div>`;
            stepsEl.appendChild(el);
        }

        const lastStep = steps[steps.length - 1];
        if (lastStep && !lastStep.next_thought_needed) {
            if (this._thinkingChainTimer) { clearInterval(this._thinkingChainTimer); this._thinkingChainTimer = null; }
            const bubble = this._thinkingChainBubble;
            if (bubble) {
                bubble.dataset.state = 'done';
                const icon = bubble.querySelector('.rc-chain-icon');
                const label = bubble.querySelector('.rc-chain-label');
                if (icon) icon.classList.remove('spinning');
                if (label) label.textContent = `思考完成 (${lastStep.total_thoughts}步)`;
            }
            this._thinkingChainBubble = null;
            this._thinkingChainStepsEl = null;
            this._thinkingChainStartTime = null;
            this._thinkingChainTimer = null;
        }
        this._scrollDebounced();
    },

    collapseReasoningBlock(bubble, delay) {
        if (!bubble) return;
        setTimeout(() => {
            if (!bubble) return;
            bubble.classList.remove('expanded');
        }, delay || 200);
    },

    toggleReasoningBlock(bubble) {
        if (!bubble) return;
        if (bubble.classList.contains('expanded')) {
            bubble.classList.remove('expanded');
        } else {
            bubble.classList.add('expanded');
        }
    },

    updateSendButton(isGenerating) {
        document.getElementById('ai-send-btn').style.display = isGenerating ? 'none' : '';
        document.getElementById('ai-stop-btn').style.display = isGenerating ? '' : 'none';
        if (!isGenerating) {
            const inputArea = document.querySelector('.rc-input-area');
            if (inputArea) inputArea.style.display = '';
            this._updateSendBtnState();
        }
    },

    _updateSendBtnState() {
        const input = document.getElementById('ai-input');
        const btn = document.getElementById('ai-send-btn');
        if (!input || !btn) return;
        if (input.value.trim().length > 0) {
            btn.classList.add('has-content');
        } else {
            btn.classList.remove('has-content');
        }
    },

    renderSidebar(filter) {
        const list = document.getElementById('ai-chat-list');
        if (!list) return;
        list.innerHTML = '';

        const query = (filter || '').toLowerCase().trim();
        let convs = this.conversations;
        if (query) {
            convs = convs.filter(c =>
                c.title.toLowerCase().includes(query) ||
                c.messages.some(m => m.content.toLowerCase().includes(query))
            );
        }

        const now = Date.now();
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);

        const groups = [
            { label: '今天', filter: c => c.createdAt >= todayStart.getTime() },
            { label: '昨天', filter: c => c.createdAt >= yesterdayStart.getTime() && c.createdAt < todayStart.getTime() },
            { label: '过去7天', filter: c => c.createdAt >= weekStart.getTime() && c.createdAt < yesterdayStart.getTime() },
            { label: '更早', filter: c => c.createdAt < weekStart.getTime() },
        ];

        for (const group of groups) {
            const items = convs.filter(group.filter);
            if (items.length === 0) continue;

            const label = document.createElement('div');
            label.className = 'ai-chat-group-label';
            label.textContent = group.label;
            list.appendChild(label);

            for (const conv of items) {
                const item = document.createElement('div');
                item.className = 'ai-chat-item' + (conv.id === this.currentId ? ' active' : '');
                item.onclick = () => this.switchTo(conv.id);
                item.ondblclick = () => this.startRename(conv.id);

                const titleSpan = document.createElement('span');
                titleSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0';
                titleSpan.textContent = conv.title;

                const delBtn = document.createElement('button');
                delBtn.className = 'ai-chat-item-delete btn-icon';
                delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
                delBtn.onclick = (e) => this.deleteConv(conv.id, e);

                item.appendChild(titleSpan);
                item.appendChild(delBtn);
                list.appendChild(item);
            }
        }

        if (convs.length === 0 && query) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:20px;text-align:center;color:var(--text-muted);font-size:12px';
            empty.textContent = '未找到匹配的对话';
            list.appendChild(empty);
        }
    },

    toggleSidebar() {
        const sidebar = document.getElementById('ai-chat-sidebar');
        const overlay = document.getElementById('ai-sidebar-overlay');
        const historyBtn = document.getElementById('ai-history-btn');
        if (!sidebar) return;
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) {
            sidebar.classList.remove('open');
            if (overlay) { overlay.classList.remove('visible'); }
            if (historyBtn) historyBtn.classList.remove('active');
        } else {
            sidebar.classList.add('open');
            if (overlay) { overlay.classList.add('visible'); }
            if (historyBtn) historyBtn.classList.add('active');
            this.renderSidebar();
        }
    },

    startRename(id) {
        const conv = this.getConv(id);
        if (!conv) return;

        const list = document.getElementById('ai-chat-list');
        const items = list.querySelectorAll('.ai-chat-item');
        for (const item of items) {
            const titleSpan = item.querySelector('span');
            if (!titleSpan || titleSpan.textContent !== conv.title) continue;

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'ai-chat-item-rename';
            input.value = conv.title;
            titleSpan.replaceWith(input);
            input.focus();
            input.select();

            const finishRename = async () => {
                const newTitle = input.value.trim() || conv.title;
                conv.title = newTitle;
                this.saveConversations();
                this.renderSidebar(document.getElementById('ai-chat-search')?.value);
            };

            input.onblur = finishRename;
            input.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
                if (e.key === 'Escape') { input.value = conv.title; input.blur(); }
            };
            break;
        }
    },

    async clearAllChats() {
        if (!confirm('确定要清空所有对话历史吗？此操作不可撤销。')) return;
        this.flushTypewriter();
        if (this._reasoningTimer) { clearInterval(this._reasoningTimer); this._reasoningTimer = null; }
        this._scrollTimer = null;
        this.thinkingBubble = null;
        this.toolCallBubble = null;
        this.typewriterTextBlock = null;
        this.conversations = [];
        this.currentId = null;
        this.saveConversations();
        this.newChat();
    },

    toggleSettings() {
        const page = document.getElementById('ai-settings-page');
        const welcome = document.getElementById('ai-welcome');
        const messages = this._messagesContainer;
        const inputArea = document.querySelector('.rc-input-area');
        const sidebar = document.getElementById('ai-chat-sidebar');
        if (sidebar && sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
            const overlay = document.getElementById('ai-sidebar-overlay');
            if (overlay) overlay.classList.remove('visible');
            const historyBtn = document.getElementById('ai-history-btn');
            if (historyBtn) historyBtn.classList.remove('active');
        }

        if (page.style.display === 'none') {
            page.style.display = '';
            welcome.style.display = 'none';
            messages.style.display = 'none';
            inputArea.style.display = 'none';
            this.loadSettingsUI();
            this.renderSettingsPanel();
        } else {
            page.style.display = 'none';
            const conv = this.getCurrent();
            if (!conv || conv.messages.length === 0) {
                welcome.style.display = '';
            } else {
                messages.style.display = '';
            }
            inputArea.style.display = '';
        }
    },

    _settingsTabs: [
        { id: 'providers', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6m0 8v6M2 12h6m8 0h6"/><circle cx="12" cy="12" r="3"/></svg>', label: '模型接入' },
        { id: 'autoApprove', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', label: '自动批准' },
        { id: 'notifications', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>', label: '通知' },
        { id: 'context', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>', label: '上下文' },
        { id: 'terminal', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M6 9l4 4-4 4"/></svg>', label: '终端' },
        { id: 'prompts', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', label: '提示词' },
        { id: 'ui', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/><path d="M2 12h2M20 12h2M12 2v2M12 20v2"/></svg>', label: '界面' },
        { id: 'experimental', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6v4H9z"/><path d="M10 9V3M14 9V3"/><path d="M7 9l-2 12h14l-2-12"/></svg>', label: '实验性' },
        { id: 'language', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>', label: '语言' },
        { id: 'about', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>', label: '关于' },
    ],

    _currentSettingsTab: 'providers',

    async renderSettingsPanel() {
        const tabList = document.getElementById('rc-settings-tab-list');
        const tabContent = document.getElementById('rc-settings-tab-content');
        if (!tabList || !tabContent) return;

        tabList.innerHTML = this._settingsTabs.map(t =>
            `<button class="rc-settings-tab-trigger${t.id === this._currentSettingsTab ? ' active' : ''}" data-tab="${t.id}">${t.icon}<span class="rc-settings-tab-label">${t.label}</span></button>`
        ).join('');

        tabList.querySelectorAll('.rc-settings-tab-trigger').forEach(btn => {
            btn.addEventListener('click', () => this._switchSettingsTab(btn.dataset.tab));
        });

        tabContent.innerHTML = this._renderSettingsTabContent(this._currentSettingsTab);

        this._setupSettingsSearch();
        this._markSettingsDirty(false);
    },

    _switchSettingsTab(tabId) {
        this._currentSettingsTab = tabId;
        document.querySelectorAll('.rc-settings-tab-trigger').forEach(b => b.classList.remove('active'));
        const active = document.querySelector(`.rc-settings-tab-trigger[data-tab="${tabId}"]`);
        if (active) active.classList.add('active');
        const content = document.getElementById('rc-settings-tab-content');
        if (content) {
            content.innerHTML = this._renderSettingsTabContent(tabId);
        }
    },

    _markSettingsDirty(dirty) {
        const btn = document.getElementById('rc-settings-save-btn');
        if (btn) btn.disabled = !dirty;
    },

    _setupSettingsSearch() {
        const input = document.getElementById('rc-settings-search-input');
        if (!input) return;
        input.addEventListener('input', () => {
            const q = input.value.toLowerCase().trim();
            if (!q) { this._switchSettingsTab(this._currentSettingsTab); return; }
            const tabContent = document.getElementById('rc-settings-tab-content');
            if (!tabContent) return;
            let found = false;
            for (const tab of this._settingsTabs) {
                const tmp = document.createElement('div');
                tmp.innerHTML = this._renderSettingsTabContent(tab.id);
                const items = tmp.querySelectorAll('.rc-settings-item, .rc-settings-section-header');
                for (const item of items) {
                    if (item.textContent.toLowerCase().includes(q)) {
                        this._currentSettingsTab = tab.id;
                        tabContent.innerHTML = this._renderSettingsTabContent(tab.id);
                        document.querySelectorAll('.rc-settings-tab-trigger').forEach(b => b.classList.remove('active'));
                        const activeBtn = document.querySelector(`.rc-settings-tab-trigger[data-tab="${tab.id}"]`);
                        if (activeBtn) activeBtn.classList.add('active');
                        setTimeout(() => {
                            tabContent.querySelectorAll('.rc-settings-item').forEach(el => {
                                if (el.textContent.toLowerCase().includes(q)) {
                                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    el.style.background = 'var(--rc-bg-active)';
                                    setTimeout(() => el.style.background = '', 1500);
                                }
                            });
                        }, 50);
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
        });
    },

    _renderSettingsTabContent(tabId) {
        switch (tabId) {
            case 'providers': return this._renderProvidersTab();
            case 'providers-add': return this._renderProvidersAddPanel();
            case 'autoApprove': return this._renderAutoApproveTab();
            case 'notifications': return this._renderNotificationsTab();
            case 'context': return this._renderContextTab();
            case 'terminal': return this._renderTerminalTab();
            case 'prompts': return this._renderPromptsTab();
            case 'ui': return this._renderUITab();
            case 'experimental': return this._renderExperimentalTab();
            case 'language': return this._renderLanguageTab();
            case 'about': return this._renderAboutTab();
            default: return '';
        }
    },

    _sectionHeader(title, desc) {
        let h = `<div class="rc-settings-section-header"><h3>${title}</h3>`;
        if (desc) h += `<p>${desc}</p>`;
        return h + '</div>';
    },

    _section(body) { return `<div class="rc-settings-section">${body}</div>`; },

    _checkbox(id, label, checked, onChange) {
        return `<div class="rc-settings-item" data-setting-id="${id}"><label class="rc-settings-checkbox"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} onchange="${onChange}"><span>${label}</span></label></div>`;
    },

    _slider(id, label, min, max, step, value, unit, onChange) {
        return `<div class="rc-settings-item" data-setting-id="${id}"><label class="rc-settings-item-label">${label}</label><div class="rc-settings-slider-row"><input type="range" class="rc-settings-slider" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" oninput="document.getElementById('${id}-val').textContent=this.value+'${unit}';${onChange}"><span class="rc-settings-slider-value" id="${id}-val">${value}${unit}</span></div></div>`;
    },

    _select(id, label, options, selected, onChange) {
        const opts = options.map(o => `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`).join('');
        return `<div class="rc-settings-item" data-setting-id="${id}"><label class="rc-settings-item-label">${label}</label><select class="rc-settings-select" id="${id}" onchange="${onChange}">${opts}</select></div>`;
    },

    _textArea(id, label, placeholder, value, rows, onChange) {
        return `<div class="rc-settings-item" data-setting-id="${id}"><label class="rc-settings-item-label">${label}</label><textarea class="rc-settings-textarea" id="${id}" rows="${rows || 4}" placeholder="${placeholder}" oninput="${onChange}">${this._escapeHtml(value || '')}</textarea></div>`;
    },

    _escapeHtml(s) { if (!s) return ''; return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },

    _renderProvidersTab() {
        const providerNames = { zhipu:'智谱 GLM', deepseek:'DeepSeek', qwen:'通义千问', moonshot:'Kimi', yi:'零一万物', baichuan:'百川', minimax:'MiniMax', stepfun:'阶跃星辰', siliconflow:'SiliconFlow', openrouter:'OpenRouter', groq:'Groq', openai:'OpenAI', anthropic:'Anthropic', google:'Google' };
        let modelsHtml = '';
        const allModels = this.addedModels.length > 0 ? this.addedModels : this.getDefaultModels();
        for (const m of allModels) {
            const iconChar = m.providerKey ? m.providerKey[0].toUpperCase() : '?';
            const isCurrent = m.modelId === this.model;
            modelsHtml += `<tr><td><div class="rc-model-name-cell"><div class="rc-model-icon ${m.providerKey||''}">${iconChar}</div><div><div class="rc-model-name">${isCurrent?'● ':''}${m.modelName||m.modelId}</div><div class="rc-model-id">${m.modelId}</div></div></div></td><td><span class="rc-provider-badge">${providerNames[m.providerKey]||m.providerKey||'-'}${m.free?'<span class="rc-free-badge">FREE</span>':''}</span></td><td>${isCurrent?'<span style="color:var(--rc-accent);font-size:11px;font-weight:600">使用中</span>':`<button class="rc-table-action" onclick="AIChat.selectModelFromTable('${m.modelId}')">使用</button> <button class="rc-table-action danger" onclick="AIChat.removeModelFromTable('${m.modelId}')">移除</button>`}</td></tr>`;
        }
        if (!allModels.length) modelsHtml = '<tr><td colspan="3" style="text-align:center;padding:32px;color:var(--rc-text-muted);font-size:13px">暂无模型，点击「新模型」添加</td></tr>';

        let providerOpts = '<option value="">-- 选择平台 --</option>';
        for (const p of this.providers) providerOpts += `<option value="${p.key}">${p.name}</option>`;

        return this._sectionHeader('模型接入', '配置 API 平台和管理可用模型') + this._section(`
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><label class="rc-settings-item-label" style="margin:0">可用模型</label><button class="rc-btn rc-btn-primary rc-btn-sm" onclick="AIChat._switchSettingsTab('providers-add')"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg> 新模型</button></div>
            <div class="rc-model-table-wrap"><table class="rc-model-table"><thead><tr><th width="45%">模型</th><th width="30%">服务商</th><th width="25%">操作</th></tr></thead><tbody>${modelsHtml}</tbody></table></div>
        `);
    },

    _renderProvidersAddPanel() {
        const cp = this._customProvider || {};
        let providerOpts = '';
        for (const p of this.providers) providerOpts += `<option value="${p.key}">${p.name}</option>`;
        return this._sectionHeader('添加新模型', '选择 AI 平台并配置 API Key') + this._section(`
            <div class="rc-settings-item"><label class="rc-settings-item-label">AI 平台</label><select class="rc-settings-select" id="ai-provider-select" onchange="AIChat.onProviderSelect()"><option value="">-- 选择平台 --</option><option value="custom">自定义服务商 (OpenAI Compatible)</option>${providerOpts}</select></div>
            <div id="ai-provider-custom-fields" style="display:none">
                <div class="rc-settings-item" style="margin-top:12px"><label class="rc-settings-item-label">Base URL <span style="color:var(--rc-error,#f44)">*</span></label><input type="url" class="rc-input" id="ai-custom-base-url" placeholder="https://api.example.com/v1" value="${this._escapeHtml(cp.baseUrl || '')}"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">API Key <span style="color:var(--rc-error,#f44)">*</span></label><input type="password" class="rc-input" id="ai-custom-api-key" placeholder="sk-..." value="${this._escapeHtml(cp.apiKey || '')}"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">Model ID <span style="color:var(--rc-error,#f44)">*</span></label><input type="text" class="rc-input" id="ai-custom-model-id" placeholder="gpt-4o" value="${this._escapeHtml(cp.modelId || '')}"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">API 格式</label><select class="rc-settings-select" id="ai-custom-api-format"><option value="openai" ${cp.apiFormat === 'anthropic' ? '' : 'selected'}>OpenAI (Chat Completions)</option><option value="anthropic" ${cp.apiFormat === 'anthropic' ? 'selected' : ''}>Anthropic (Messages API)</option></select><div class="rc-settings-item-desc">选择服务商的 API 接口格式。OpenAI 格式兼容大多数服务商（DeepSeek、GLM、Kimi 等），Anthropic 格式用于 Claude。</div></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">模型显示名称</label><input type="text" class="rc-input" id="ai-custom-model-name" placeholder="自定义模型 (可选)" value="${this._escapeHtml(cp.modelName || '')}"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">最大 Token</label><input type="number" class="rc-input" id="ai-custom-max-tokens" placeholder="4096" value="${cp.maxTokens || 4096}" style="width:120px"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">上下文窗口</label><input type="number" class="rc-input" id="ai-custom-context-window" placeholder="128000" value="${cp.contextWindow || 128000}" style="width:120px"></div>
                <div class="rc-settings-item"><label class="rc-settings-item-label">自定义 Headers</label><div id="ai-custom-headers-list">${(cp.headers || []).map((h, i) => `<div style="display:flex;gap:6px;margin-bottom:4px"><input type="text" class="rc-input" placeholder="Header Name" value="${this._escapeHtml(h[0])}" data-idx="${i}" data-field="key" style="flex:1"><input type="text" class="rc-input" placeholder="Header Value" value="${this._escapeHtml(h[1])}" data-idx="${i}" data-field="val" style="flex:1"><button class="rc-btn rc-btn-secondary rc-btn-sm" onclick="AIChat._removeCustomHeader(${i})">✕</button></div>`).join('')}</div><button class="rc-btn rc-btn-secondary rc-btn-sm" onclick="AIChat._addCustomHeader()" style="margin-top:4px">+ 添加 Header</button></div>
                <div class="rc-settings-item" style="margin-top:8px"><label class="rc-settings-checkbox"><input type="checkbox" id="ai-custom-streaming" ${cp.streaming !== false ? 'checked' : ''}><span>启用流式输出</span></label></div>
                <div style="margin-top:12px;display:flex;gap:8px;align-items:center"><button class="rc-btn rc-btn-primary rc-btn-sm" onclick="AIChat._saveCustomProvider()">保存并使用</button><span id="ai-custom-status" style="font-size:12px;color:var(--rc-text-muted)"></span></div>
            </div>
        `);
    },

    _addCustomHeader() {
        const list = document.getElementById('ai-custom-headers-list');
        if (!list) return;
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;gap:6px;margin-bottom:4px';
        const idx = list.children.length;
        div.innerHTML = `<input type="text" class="rc-input" placeholder="Header Name" data-idx="${idx}" data-field="key" style="flex:1"><input type="text" class="rc-input" placeholder="Header Value" data-idx="${idx}" data-field="val" style="flex:1"><button class="rc-btn rc-btn-secondary rc-btn-sm" onclick="AIChat._removeCustomHeader(${idx})">✕</button>`;
        list.appendChild(div);
    },

    _removeCustomHeader(idx) {
        const list = document.getElementById('ai-custom-headers-list');
        if (!list) return;
        const items = list.querySelectorAll('div');
        if (items[idx]) items[idx].remove();
    },

    _saveCustomProvider() {
        const baseUrl = document.getElementById('ai-custom-base-url')?.value?.trim();
        const apiKey = document.getElementById('ai-custom-api-key')?.value?.trim();
        const modelId = document.getElementById('ai-custom-model-id')?.value?.trim();
        const modelName = document.getElementById('ai-custom-model-name')?.value?.trim();
        const maxTokens = parseInt(document.getElementById('ai-custom-max-tokens')?.value) || 4096;
        const contextWindow = parseInt(document.getElementById('ai-custom-context-window')?.value) || 128000;
        const streaming = document.getElementById('ai-custom-streaming')?.checked !== false;
        const apiFormat = document.getElementById('ai-custom-api-format')?.value || 'openai';

        if (!baseUrl || !apiKey || !modelId) {
            const status = document.getElementById('ai-custom-status');
            if (status) { status.textContent = '请填写 Base URL、API Key 和 Model ID'; status.style.color = 'var(--rc-error,#f44)'; }
            return;
        }

        const headers = [];
        const headerEls = document.querySelectorAll('#ai-custom-headers-list > div');
        headerEls.forEach(el => {
            const key = el.querySelector('[data-field="key"]')?.value?.trim();
            const val = el.querySelector('[data-field="val"]')?.value?.trim();
            if (key) headers.push([key, val || '']);
        });

        this._customProvider = { baseUrl, apiKey, modelId, modelName: modelName || modelId, maxTokens, contextWindow, streaming, headers, apiFormat };

        const fullId = 'custom:' + baseUrl + ':' + modelId;
        const entry = { modelId: fullId, modelName: modelName || modelId, providerKey: 'custom', free: false, apiKey, baseUrl, maxTokens, contextWindow, streaming, headers, apiFormat };
        const exists = this.addedModels.findIndex(m => m.modelId === fullId);
        if (exists >= 0) this.addedModels[exists] = entry;
        else this.addedModels.push(entry);

        this.model = fullId;
        window.electronAPI.store.set('versepc_ai_model', fullId);
        window.electronAPI.store.set('versepc_ai_added_models', JSON.stringify(this.addedModels));
        window.electronAPI.store.set('versepc_ai_custom_provider', JSON.stringify(this._customProvider));
        this.updateModelLabel();

        const status = document.getElementById('ai-custom-status');
        if (status) { status.textContent = '✓ 已保存'; status.style.color = 'var(--rc-success,#34d399)'; }
        setTimeout(() => { if (status) status.textContent = ''; }, 2000);
        this._markSettingsDirty(true);
    },

    _renderAutoApproveTab() {
        const s = this._autoApproveSettings || {};
        return this._sectionHeader('自动批准', '自动批准工具调用，无需手动确认') + this._section(`
            ${this._checkbox('aa-enabled', '启用自动批准', s.enabled, "AIChat._updateAutoApprove('enabled', this.checked)")}
            ${s.enabled ? `<div class="rc-settings-nested">
                ${this._checkbox('aa-read', '自动批准读取文件', s.read, "AIChat._updateAutoApprove('read', this.checked)")}
                ${this._checkbox('aa-write', '自动批准写入文件', s.write, "AIChat._updateAutoApprove('write', this.checked)")}
                ${this._checkbox('aa-execute', '自动执行终端命令', s.execute, "AIChat._updateAutoApprove('execute', this.checked)")}
                ${this._checkbox('aa-mcp', '自动批准 MCP 工具', s.mcp, "AIChat._updateAutoApprove('mcp', this.checked)")}
                ${this._checkbox('aa-mode', '自动批准模式切换', s.mode, "AIChat._updateAutoApprove('mode', this.checked)")}
                ${this._checkbox('aa-subtasks', '自动批准子任务', s.subtasks, "AIChat._updateAutoApprove('subtasks', this.checked)")}
            </div>` : ''}
        `);
    },

    _renderNotificationsTab() {
        const s = this._notifSettings || {};
        return this._sectionHeader('通知', '配置通知和音效') + this._section(`
            ${this._checkbox('notif-tts', '启用文本转语音 (TTS)', s.ttsEnabled, "AIChat._updateNotif('ttsEnabled', this.checked)")}
            ${s.ttsEnabled ? `<div class="rc-settings-nested">${this._slider('notif-tts-speed', 'TTS 速度', 0.1, 2.0, 0.01, s.ttsSpeed || 1.0, 'x', "AIChat._updateNotif('ttsSpeed', parseFloat(this.value))")}</div>` : ''}
            ${this._checkbox('notif-sound', '启用音效', s.soundEnabled !== false, "AIChat._updateNotif('soundEnabled', this.checked)")}
            ${s.soundEnabled !== false ? `<div class="rc-settings-nested">${this._slider('notif-volume', '音量', 0, 1, 0.01, s.soundVolume || 0.5, '', "AIChat._updateNotif('soundVolume', parseFloat(this.value))")}</div>` : ''}
        `);
    },

    _renderContextTab() {
        const s = this._contextSettings || {};
        return this._sectionHeader('上下文', '管理 AI 上下文窗口设置') + this._section(`
            ${this._slider('ctx-max-tabs', '打开标签页上下文限制', 0, 500, 1, s.maxOpenTabs || 20, '', "AIChat._updateContext('maxOpenTabs', parseInt(this.value))")}
            ${this._slider('ctx-max-files', '工作区文件上下文限制', 0, 500, 1, s.maxFiles || 200, '', "AIChat._updateContext('maxFiles', parseInt(this.value))")}
            ${this._checkbox('ctx-time', '包含当前时间', s.includeTime !== false, "AIChat._updateContext('includeTime', this.checked)")}
            ${this._checkbox('ctx-diagnostics', '包含诊断信息', s.includeDiagnostics !== false, "AIChat._updateContext('includeDiagnostics', this.checked)")}
            <div style="border-top:1px solid var(--rc-border);margin:8px 0;padding-top:12px">
                <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:8px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M4 14h6m4 0h6M4 10h6m4 0h6"/></svg><span>Context Compression</span></div>
                ${this._checkbox('ctx-auto-condense', '自动压缩上下文', s.autoCondense, "AIChat._updateContext('autoCondense', this.checked);AIChat._switchSettingsTab('context')")}
                <div class="rc-settings-item-desc" style="margin-left:24px;margin-bottom:8px">当上下文超过阈值时自动压缩旧消息</div>
                ${s.autoCondense ? `<div class="rc-settings-nested">
                    ${this._slider('ctx-condense-threshold', '压缩触发阈值', 10, 100, 5, s.condenseThreshold || 80, '%', "AIChat._updateContext('condenseThreshold', parseInt(this.value))")}
                    <div class="rc-settings-item-desc" style="margin-left:0">当上下文使用量达到模型上下文窗口的此百分比时触发压缩</div>
                </div>` : ''}
            </div>
        `);
    },

    _renderTerminalTab() {
        const s = this._terminalSettings || {};
        return this._sectionHeader('终端', '终端命令执行设置') + this._section(`
            <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:4px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg><span>基础设置</span></div>
            <div class="rc-settings-nested">
                ${this._select('term-preview', '命令输出预览大小', [{value:'small',label:'小 (5KB)'},{value:'medium',label:'中 (10KB)'},{value:'large',label:'大 (20KB)'}], s.outputPreview || 'medium', "AIChat._updateTerminal('outputPreview', this.value)")}
            </div>
            <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:8px;margin-bottom:4px"><span>高级设置</span></div>
            <div class="rc-settings-nested">
                ${this._checkbox('term-cmd-delay', '启用命令延迟', s.cmdDelay > 0, "AIChat._updateTerminal('cmdDelay', this.checked ? 100 : 0)")}
                ${s.cmdDelay > 0 ? this._slider('term-cmd-delay-val', '命令延迟 (ms)', 0, 1000, 10, s.cmdDelay || 0, 'ms', "AIChat._updateTerminal('cmdDelay', parseInt(this.value))") : ''}
            </div>
        `);
    },

    _renderPromptsTab() {
        const s = this._promptSettings || {};
        return this._sectionHeader('提示词', '自定义系统提示词和增强提示') + this._section(`
            ${this._textArea('prompt-system', '系统提示词', '可选的系统提示词...', s.systemPrompt, 5, "AIChat._updatePrompt('systemPrompt', this.value);AIChat._markSettingsDirty(true)")}
            ${this._textArea('prompt-enhance', '增强提示词', '用于增强用户输入的提示词...', s.enhancePrompt, 4, "AIChat._updatePrompt('enhancePrompt', this.value);AIChat._markSettingsDirty(true)")}
        `);
    },

    _renderUITab() {
        const s = this._uiSettings || {};
        return this._sectionHeader('界面', '界面显示设置') + this._section(`
            ${this._checkbox('ui-collapse-thinking', '默认折叠推理过程', s.collapseThinking !== false, "AIChat._updateUI('collapseThinking', this.checked)")}
            <div class="rc-settings-item-desc" style="margin-left:24px">启用后，推理链默认显示为折叠状态</div>
            ${this._checkbox('ui-enter-send', 'Enter 键发送消息 (Shift+Enter 换行)', s.sendOnEnter !== false, "AIChat._updateUI('sendOnEnter', this.checked)")}
            <div class="rc-settings-item-desc" style="margin-left:24px">取消勾选后，需要 Ctrl+Enter 发送消息</div>
            ${this._checkbox('ui-auto-scroll', '自动滚动到最新消息', s.autoScroll !== false, "AIChat._updateUI('autoScroll', this.checked)")}
        `);
    },

    _renderExperimentalTab() {
        const s = this._experimentalSettings || {};
        return this._sectionHeader('实验性', '实验性功能 (可能不稳定)') + this._section(`
            ${this._checkbox('exp-thinking', '启用 Sequential Thinking 工具', s.sequentialThinking, "AIChat._updateExperimental('sequentialThinking', this.checked)")}
            <div class="rc-settings-item-desc" style="margin-left:24px">使用结构化思维链进行复杂推理</div>
            ${this._checkbox('exp-ckg', '启用代码知识图谱 (CKG)', s.ckg, "AIChat._updateExperimental('ckg', this.checked)")}
            <div class="rc-settings-item-desc" style="margin-left:24px">自动索引代码库以提供更精准的上下文</div>
            ${this._checkbox('exp-stream', '流式输出', s.streaming !== false, "AIChat._updateExperimental('streaming', this.checked)")}
            <div class="rc-settings-item-desc" style="margin-left:24px">逐字显示 AI 回复，关闭则等待完整回复后一次性显示</div>
        `);
    },

    _renderLanguageTab() {
        const lang = this._language || 'zh-CN';
        return this._sectionHeader('语言', '选择界面语言') + this._section(`
            ${this._select('settings-language', '界面语言', [{value:'zh-CN',label:'简体中文'},{value:'en',label:'English'},{value:'ja',label:'日本語'},{value:'ko',label:'한국어'}], lang, "AIChat._updateLanguage(this.value)")}
        `);
    },

    _renderAboutTab() {
        return this._sectionHeader('关于', '关于 VerseAI') + this._section(`
            <div class="rc-settings-item"><p style="color:var(--rc-text-secondary);font-size:13px;margin:0">Version: 1.0.0</p></div>
            <div class="rc-settings-item" style="padding-top:12px;border-top:1px solid var(--rc-border)">
                <label class="rc-settings-item-label">管理设置</label>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
                    <button class="rc-btn rc-btn-secondary rc-btn-sm" onclick="AIChat._exportSettings()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> 导出</button>
                    <button class="rc-btn rc-btn-secondary rc-btn-sm" onclick="AIChat._importSettings()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 导入</button>
                    <button class="rc-btn rc-btn-danger rc-btn-sm" onclick="AIChat._resetSettings()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> 重置</button>
                </div>
            </div>
        `);
    },

    _updateAutoApprove(key, val) {
        if (!this._autoApproveSettings) this._autoApproveSettings = {};
        this._autoApproveSettings[key] = val;
        this._markSettingsDirty(true);
        this._switchSettingsTab('autoApprove');
    },

    _updateNotif(key, val) {
        if (!this._notifSettings) this._notifSettings = {};
        this._notifSettings[key] = val;
        this._markSettingsDirty(true);
        this._switchSettingsTab('notifications');
    },

    _updateContext(key, val) {
        if (!this._contextSettings) this._contextSettings = {};
        this._contextSettings[key] = val;
        this._markSettingsDirty(true);
    },

    _updateTerminal(key, val) {
        if (!this._terminalSettings) this._terminalSettings = {};
        this._terminalSettings[key] = val;
        this._markSettingsDirty(true);
        this._switchSettingsTab('terminal');
    },

    _updatePrompt(key, val) {
        if (!this._promptSettings) this._promptSettings = {};
        this._promptSettings[key] = val;
    },

    _updateUI(key, val) {
        if (!this._uiSettings) this._uiSettings = {};
        this._uiSettings[key] = val;
        this._markSettingsDirty(true);
    },

    _updateExperimental(key, val) {
        if (!this._experimentalSettings) this._experimentalSettings = {};
        this._experimentalSettings[key] = val;
        this._markSettingsDirty(true);
        this._switchSettingsTab('experimental');
    },

    _updateLanguage(val) {
        this._language = val;
        this._markSettingsDirty(true);
    },

    async _exportSettings() {
        const data = {
            apiKey: this.apiKey, model: this.model, temperature: this.temperature,
            addedModels: this.addedModels,
            autoApprove: this._autoApproveSettings, notifications: this._notifSettings,
            context: this._contextSettings, terminal: this._terminalSettings,
            prompts: this._promptSettings, ui: this._uiSettings,
            experimental: this._experimentalSettings, language: this._language,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'verseai-settings.json'; a.click();
        if (typeof showToast === 'function') showToast('设置已导出', 'success');
    },

    async _importSettings() {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0]; if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (data.apiKey) { this.apiKey = data.apiKey; await window.electronAPI.store.set('versepc_ai_api_key', data.apiKey); }
                if (data.model) { this.model = data.model; await window.electronAPI.store.set('versepc_ai_model', data.model); }
                if (data.temperature != null) { this.temperature = data.temperature; await window.electronAPI.store.set('versepc_ai_temp', String(data.temperature)); }
                if (data.addedModels) { this.addedModels = data.addedModels; await window.electronAPI.store.set('versepc_ai_added_models', JSON.stringify(data.addedModels)); }
                if (data.autoApprove) this._autoApproveSettings = data.autoApprove;
                if (data.notifications) this._notifSettings = data.notifications;
                if (data.context) this._contextSettings = data.context;
                if (data.terminal) this._terminalSettings = data.terminal;
                if (data.prompts) this._promptSettings = data.prompts;
                if (data.ui) this._uiSettings = data.ui;
                if (data.experimental) this._experimentalSettings = data.experimental;
                if (data.language) this._language = data.language;
                this.updateModelLabel();
                this.renderSettingsPanel();
                if (typeof showToast === 'function') showToast('设置已导入', 'success');
            } catch (e) { if (typeof showToast === 'function') showToast('导入失败: ' + e.message, 'error'); }
        };
        input.click();
    },

    async _resetSettings() {
        this._autoApproveSettings = {};
        this._notifSettings = {};
        this._contextSettings = {};
        this._terminalSettings = {};
        this._promptSettings = {};
        this._uiSettings = {};
        this._experimentalSettings = {};
        this._language = 'zh-CN';
        this.renderSettingsPanel();
        if (typeof showToast === 'function') showToast('设置已重置', 'success');
    },

    populateProviderSelect() {
        const select = document.getElementById('ai-provider-select');
        if (!select) return;
        select.innerHTML = '<option value="">-- 选择平台 --</option>';
        for (const p of this.providers) {
            const opt = document.createElement('option');
            opt.value = p.key;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
    },

    onProviderSelect() {
        const sel = document.getElementById('ai-provider-select');
        const keyGroup = document.getElementById('ai-add-key-group');
        const modelGroup = document.getElementById('ai-add-model-group');
        const addBtn = document.getElementById('ai-add-model-btn');
        const customFields = document.getElementById('ai-provider-custom-fields');
        if (!sel) return;
        const val = sel.value;

        if (customFields) customFields.style.display = val === 'custom' ? '' : 'none';
        if (keyGroup) keyGroup.style.display = val && val !== 'custom' ? '' : 'none';
        if (modelGroup) modelGroup.style.display = 'none';
        if (addBtn) addBtn.style.display = 'none';
        if (val === 'custom') return;

        const provider = this.providers.find(p => p.key === val);
        if (!provider) return;
        const models = provider.models || [];
        const modelSel = document.getElementById('ai-add-model-select');
        if (modelSel) {
            modelSel.innerHTML = models.map(m => `<option value="${m.id}">${m.name || m.id}</option>`).join('');
            if (models.length > 0) { modelSel.style.display = ''; if (addBtn) addBtn.style.display = ''; }
        }
    },

    toggleAddKeyVisibility() {
        const input = document.getElementById('ai-add-key-input');
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
    },





    async addModels() {
        const providerSelect = document.getElementById('ai-provider-select');
        const keyInput = document.getElementById('ai-add-key-input');
        const modelSelect = document.getElementById('ai-add-model-select');
        const providerKey = providerSelect?.value;
        const apiKey = keyInput?.value?.trim();

        if (!providerKey) { if (typeof showToast === 'function') showToast('请选择平台', 'error'); return; }
        if (!apiKey) { if (typeof showToast === 'function') showToast('请输入 API Key', 'error'); return; }

        const selectedOptions = Array.from(modelSelect?.selectedOptions || []);
        if (selectedOptions.length === 0) { if (typeof showToast === 'function') showToast('请选择至少一个模型', 'error'); return; }

        const provider = this.providers.find(p => p.key === providerKey);
        if (!provider) return;

        for (const opt of selectedOptions) {
            const modelId = opt.value;
            const modelInfo = provider.models.find(m => m.id === modelId);
            const existingIdx = this.addedModels.findIndex(m => m.modelId === modelId);
            const entry = {
                providerKey: providerKey,
                providerName: provider.name,
                modelId: modelId,
                modelName: modelInfo?.name || modelId,
                free: modelInfo?.free || false,
                apiKey: apiKey
            };
            if (existingIdx >= 0) {
                this.addedModels[existingIdx] = entry;
            } else {
                this.addedModels.push(entry);
            }
        }

        try {
            await window.electronAPI.store.set('versepc_ai_added_models', JSON.stringify(this.addedModels));
        } catch (e) {}

        if (!this.model || !this.addedModels.some(m => m.modelId === this.model)) {
            this.model = selectedOptions[0].value;
            this.apiKey = apiKey;
            try {
                await window.electronAPI.store.set('versepc_ai_model', this.model);
                await window.electronAPI.store.set('versepc_ai_api_key', this.apiKey);
            } catch (e) {}
        }

        this.updateModelLabel();
        this.renderModelTable();
        if (typeof showToast === 'function') showToast(`已添加 ${selectedOptions.length} 个模型`, 'success');
    },

    async removeAddedModel(modelId) {
        this.addedModels = this.addedModels.filter(m => m.modelId !== modelId);
        try {
            await window.electronAPI.store.set('versepc_ai_added_models', JSON.stringify(this.addedModels));
        } catch (e) {}
        if (this.model === modelId) {
            this.model = this.addedModels.length > 0 ? this.addedModels[0].modelId : '';
            this.apiKey = this.addedModels.length > 0 ? this.addedModels[0].apiKey : '';
            try {
                await window.electronAPI.store.set('versepc_ai_model', this.model);
                await window.electronAPI.store.set('versepc_ai_api_key', this.apiKey);
            } catch (e) {}
        }
        this.updateModelLabel();
        this.renderModelTable();
    },

    renderModelTable() {
        const tbody = document.getElementById('rc-model-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        const allModels = this.addedModels.length > 0 ? this.addedModels : this.getDefaultModels();
        const providerNames = { zhipu:'智谱 GLM', deepseek:'DeepSeek', qwen:'通义千问', moonshot:'Kimi', yi:'零一万物', baichuan:'百川', minimax:'MiniMax', stepfun:'阶跃星辰', siliconflow:'SiliconFlow', openrouter:'OpenRouter', groq:'Groq', openai:'OpenAI', anthropic:'Anthropic', google:'Google' };
        for (const m of allModels) {
            const tr = document.createElement('tr');
            const iconChar = m.providerKey ? m.providerKey[0].toUpperCase() : '?';
            const isCurrent = m.modelId === this.model;
            tr.innerHTML = `
                <td>
                    <div class="rc-model-name-cell">
                        <div class="rc-model-icon ${m.providerKey || ''}">${iconChar}</div>
                        <div><div class="rc-model-name">${isCurrent ? '● ' : ''}${m.modelName || m.modelId}</div><div class="rc-model-id">${m.modelId}</div></div>
                    </div>
                </td>
                <td><span class="rc-provider-badge">${providerNames[m.providerKey] || m.providerKey || '-'}${m.free ? '<span class="rc-free-badge">FREE</span>' : ''}</span></td>
                <td>${isCurrent ? '<span style="color:var(--rc-accent);font-size:11px;font-weight:600">使用中</span>' : `<button class="rc-table-action" onclick="AIChat.selectModelFromTable('${m.modelId}')">使用</button> <button class="rc-table-action danger" onclick="AIChat.removeModelFromTable('${m.modelId}')">移除</button>`}</td>`;
            tbody.appendChild(tr);
        }
        if (allModels.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="3" style="text-align:center;padding:32px;color:var(--rc-text-muted);font-size:13px">暂无模型，点击「新模型」添加</td>`;
            tbody.appendChild(tr);
        }
    },

    getDefaultModels() {
        const defaults = [
            { modelId:'glm-5-flash', modelName:'GLM-5-Flash', providerKey:'zhipu', free:true },
            { modelId:'deepseek-v4-flash', modelName:'DeepSeek-V4-Flash', providerKey:'deepseek', free:true },
            { modelId:'qwen3.6-flash', modelName:'Qwen3.6-Flash', providerKey:'qwen', free:true },
            { modelId:'gpt-4o-mini', modelName:'GPT-4o-mini', providerKey:'openai' },
            { modelId:'gemini-2.5-flash', modelName:'Gemini 2.5 Flash', providerKey:'google', free:true }
        ];
        if (this._customProvider && this._customProvider.modelId) {
            const fullId = 'custom:' + this._customProvider.baseUrl + ':' + this._customProvider.modelId;
            defaults.unshift({ modelId: fullId, modelName: this._customProvider.modelName || this._customProvider.modelId, providerKey: 'custom', free: false });
        }
        return defaults;
    },

    async selectModelFromTable(modelId) {
        this.model = modelId;
        try { await window.electronAPI.store.set('versepc_ai_model', modelId); } catch(e){}
        this.updateModelLabel();
        this.renderModelTable();
    },

    async removeModelFromTable(modelId) {
        this.addedModels = this.addedModels.filter(m => m.modelId !== modelId);
        try { await window.electronAPI.store.set('versepc_ai_added_models', JSON.stringify(this.addedModels)); } catch(e){}
        if (this.model === modelId && this.addedModels.length > 0) {
            this.model = this.addedModels[0].modelId;
            this.updateModelLabel();
        }
        this.renderModelTable();
    },

    showAddModelDialog() {
        this._switchSettingsTab('providers-add');
    },

    async useModel(modelId) {
        const entry = this.addedModels.find(m => m.modelId === modelId);
        if (!entry) return;
        this.model = modelId;
        this.apiKey = entry.apiKey;
        try {
            await window.electronAPI.store.set('versepc_ai_model', modelId);
            await window.electronAPI.store.set('versepc_ai_api_key', entry.apiKey);
        } catch (e) {}
        this.updateModelLabel();
        this.renderAddedModels();
    },

    async loadSettingsUI() {
        try { this.apiKey = await window.electronAPI.store.get('versepc_ai_api_key'); } catch (e) {}
        try { this.model = await window.electronAPI.store.get('versepc_ai_model'); } catch (e) {}
        try { this.temperature = parseFloat(await window.electronAPI.store.get('versepc_ai_temp')); } catch (e) {}

        const tempSlider = document.getElementById('ai-temp-slider');
        if (tempSlider) {
            const val = isNaN(this.temperature) ? 70 : Math.round(this.temperature * 100);
            tempSlider.value = val;
            const valEl = document.getElementById('ai-temp-value');
            if (valEl) valEl.textContent = (val / 100).toFixed(2);
        }
        this.updateModelLabel();
    },

    _todos: [],
    _todoExpanded: false,
    _todoCard: null,
    _lastTodoState: '',

    parseTodosFromText(text) {
        if (!text) return [];
        const todos = [];
        const regex = /^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/gm;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const marker = match[1];
            let status = 'pending';
            if (marker === 'x' || marker === 'X') status = 'completed';
            else if (marker === '-' || marker === '~') status = 'in_progress';
            todos.push({ content: match[2].trim(), status });
        }
        return todos;
    },

    updateTodoBar() {
        if (this._todos.length === 0) {
            if (this._todoCard && this._todoCard.isConnected) {
                this._todoCard.remove();
            }
            this._todoCard = null;
            this._lastTodoState = '';
            return;
        }

        const stateKey = this._todos.map(t => `${t.status}:${t.content}`).join('|');
        if (stateKey === this._lastTodoState) return;
        this._lastTodoState = stateKey;

        const completed = this._todos.filter(t => t.status === 'completed').length;
        const total = this._todos.length;
        const inProgress = this._todos.find(t => t.status === 'in_progress');
        const allDone = completed === total;

        if (!this._todoCard || !this._todoCard.isConnected) {
            this._todoCard = document.createElement('div');
            this._todoCard.className = 'solo-task-card';
            const container = this.currentWorkflowContent || this._messagesContainer;
            if (container) container.appendChild(this._todoCard);
        }

        const card = this._todoCard;

        if (allDone) {
            card.classList.add('all-done');
        } else {
            card.classList.remove('all-done');
        }

        const statusText = allDone
            ? `${total}/${total} 已完成`
            : `${completed}/${total} 已完成`;
        const statusColor = allDone ? 'var(--rc-success, #34d399)' : '';

        const ICON_DONE = '<svg class="solo-task-icon done" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>';
        const ICON_RUNNING = '<svg class="solo-task-icon running" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
        const ICON_PENDING = '<svg class="solo-task-icon pending" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary, #666)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-dasharray="4 3"/></svg>';

        let taskListHtml = '';
        for (let i = 0; i < this._todos.length; i++) {
            const t = this._todos[i];
            const icon = t.status === 'completed' ? ICON_DONE : t.status === 'in_progress' ? ICON_RUNNING : ICON_PENDING;
            const cls = t.status === 'in_progress' ? 'solo-task-item active' : t.status === 'completed' ? 'solo-task-item done' : 'solo-task-item';
            const div = document.createElement('div');
            div.textContent = t.content;
            taskListHtml += `<div class="${cls}">${icon}<span class="solo-task-text">${div.textContent}</span></div>`;
        }

        const expanded = this._todoExpanded;
        const chevronSvg = expanded
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

        card.innerHTML = `
            <div class="solo-task-header" id="solo-task-header">
                <svg class="solo-task-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;flex-shrink:0"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                <span class="solo-task-toggle">${expanded ? '收起' : '查看更多'}</span>
                <span class="solo-task-status" style="color:${statusColor}">${statusText}</span>
                <span class="solo-task-chevron">${chevronSvg}</span>
            </div>
            <div class="solo-task-body ${expanded ? 'open' : ''}">
                <div class="solo-task-list">${taskListHtml}</div>
            </div>`;

        const header = card.querySelector('#solo-task-header');
        if (header) {
            header.onclick = () => {
                this._todoExpanded = !this._todoExpanded;
                this.updateTodoBar();
            };
        }

        if (expanded && inProgress) {
            const activeEl = card.querySelector('.solo-task-item.active');
            if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        this._scrollDebounced();
    },

    toggleTodoList() {
        this._todoExpanded = !this._todoExpanded;
        this.updateTodoBar();
    },

    condenseContext() {
        const conv = this.getCurrent();
        if (!conv || !conv.messages || conv.messages.length < 4) {
            if (typeof showToast === 'function') showToast('消息太少，无需压缩', 'info');
            return;
        }
        const totalChars = conv.messages.reduce((sum, m) => sum + (m.content || '').length, 0);
        if (totalChars < 8000) {
            if (typeof showToast === 'function') showToast('上下文还不够长，无需压缩', 'info');
            return;
        }
        const half = Math.floor(conv.messages.length / 2);
        const oldMessages = conv.messages.slice(0, half);
        const newMessages = conv.messages.slice(half);
        const summaryParts = [];
        for (const m of oldMessages) {
            if (m.role === 'user') {
                summaryParts.push('User: ' + (m.content || '').slice(0, 200));
            } else if (m.role === 'assistant') {
                summaryParts.push('Assistant: ' + (m.content || '').slice(0, 200));
            }
        }
        const summary = '[Context Summary]\nPrevious conversation:\n' + summaryParts.join('\n') + '\n\n[End Summary - Continue from here]';
        conv.messages = [{ role: 'user', content: summary }, ...newMessages];
        this.saveConversations();
        this._todos = [];
        for (const msg of conv.messages) {
            if (msg.role === 'assistant' && typeof msg.content === 'string') {
                const todos = this.parseTodosFromText(msg.content);
                if (todos.length > 0) this._todos = todos;
            }
        }
        this.updateTodoBar();
        this.showMessages(conv.messages);
        if (typeof showToast === 'function') showToast('上下文已压缩', 'success');
    },

    extractTodosFromStream(fullText) {
        const todos = this.parseTodosFromText(fullText);
        if (todos.length > 0) {
            this._todos = todos;
            this.updateTodoBar();
        }
    },

    async loadSettings() {
        try { this.apiKey = await window.electronAPI.store.get('versepc_ai_api_key'); } catch (e) {}
        try { this.model = await window.electronAPI.store.get('versepc_ai_model'); } catch (e) {}
        try { this.temperature = parseFloat(await window.electronAPI.store.get('versepc_ai_temp')); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_auto_approve'); if (d) this._autoApproveSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_notifications'); if (d) this._notifSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_context'); if (d) this._contextSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_terminal'); if (d) this._terminalSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_prompts'); if (d) this._promptSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_ui'); if (d) this._uiSettings = JSON.parse(d); } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_experimental'); if (d) this._experimentalSettings = JSON.parse(d); } catch (e) {}
        try { this._language = await window.electronAPI.store.get('versepc_ai_language') || 'zh-CN'; } catch (e) {}
        try { const d = await window.electronAPI.store.get('versepc_ai_custom_provider'); if (d) this._customProvider = JSON.parse(d); } catch (e) {}
    },

    async saveSettings() {
        const tempSlider = document.getElementById('ai-temp-slider');
        if (tempSlider) this.temperature = parseInt(tempSlider.value) / 100;

        try { await window.electronAPI.store.set('versepc_ai_temp', String(this.temperature)); } catch (e) {}
        try { if (this._autoApproveSettings) await window.electronAPI.store.set('versepc_ai_auto_approve', JSON.stringify(this._autoApproveSettings)); } catch (e) {}
        try { if (this._notifSettings) await window.electronAPI.store.set('versepc_ai_notifications', JSON.stringify(this._notifSettings)); } catch (e) {}
        try { if (this._contextSettings) await window.electronAPI.store.set('versepc_ai_context', JSON.stringify(this._contextSettings)); } catch (e) {}
        try { if (this._terminalSettings) await window.electronAPI.store.set('versepc_ai_terminal', JSON.stringify(this._terminalSettings)); } catch (e) {}
        try { if (this._promptSettings) await window.electronAPI.store.set('versepc_ai_prompts', JSON.stringify(this._promptSettings)); } catch (e) {}
        try { if (this._uiSettings) await window.electronAPI.store.set('versepc_ai_ui', JSON.stringify(this._uiSettings)); } catch (e) {}
        try { if (this._experimentalSettings) await window.electronAPI.store.set('versepc_ai_experimental', JSON.stringify(this._experimentalSettings)); } catch (e) {}
        try { if (this._language) await window.electronAPI.store.set('versepc_ai_language', this._language); } catch (e) {}

        this._markSettingsDirty(false);
        if (typeof showToast === 'function') showToast('配置已保存', 'success');
    },

    saveConversations() {
        if (this._saveConversationsTimer) clearTimeout(this._saveConversationsTimer);
        this._saveConversationsTimer = setTimeout(() => {
            this._saveConversationsTimer = null;
            this._doSaveConversations();
        }, 300);
    },

    async _doSaveConversations() {
        try {
            const data = JSON.stringify(this.conversations.map(c => ({
                id: c.id, title: c.title, messages: c.messages, createdAt: c.createdAt
            })));
            await window.electronAPI.store.set('versepc_ai_chats', data);
        } catch (e) {}
    },

    async loadConversations() {
        try {
            const raw = await window.electronAPI.store.get('versepc_ai_chats');
            if (raw) {
                const parsed = JSON.parse(raw);
                this.conversations = parsed || [];
                if (this.conversations.length > 0) {
                    this.currentId = this.conversations[0].id;
                }
            }
        } catch (e) {
            this.conversations = [];
        }
    },

    // 异步渲染 Markdown：使用 setTimeout 将 marked.parse 移出当前事件循环
    // 避免主线程被同步阻塞导致页面卡死
    asyncRenderMarkdown(text, callback) {
        if (!text) {
            callback('');
            return;
        }
        if (text.length > 8000) {
            const safe = text.slice(0, 8000);
            callback(this.escapeHtml(safe));
            return;
        }

        if (text.length > 500) {
            const chunks = [];
            const lines = text.split('\n');
            let current = '';
            for (const line of lines) {
                if (current.length + line.length + 1 > 500) {
                    if (current) chunks.push(current);
                    current = line;
                } else {
                    current = current ? current + '\n' + line : line;
                }
            }
            if (current) chunks.push(current);

            const results = [];
            let idx = 0;
            const renderNext = () => {
                if (idx >= chunks.length) {
                    callback(results.join('\n'));
                    return;
                }
                const chunk = chunks[idx];
                idx++;
                try {
                    results.push(this.renderMarkdown(chunk));
                } catch (e) {
                    results.push(this.escapeHtml(chunk));
                }
                setTimeout(renderNext, 0);
            };
            setTimeout(renderNext, 0);
            return;
        }

        const doRender = () => {
            try {
                const html = this.renderMarkdown(text);
                callback(html);
            } catch (e) {
                callback(this.escapeHtml(text));
            }
        };

        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(doRender, { timeout: 500 });
        } else {
            setTimeout(doRender, 0);
        }
    },

    escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    _markedConfigured: false,

    renderMarkdown(text) {
        if (!text) return '';
        if (text.length > 8000) {
            return this.escapeHtml(text.slice(0, 8000)) + '<p style="color:var(--text-muted)">...(内容过长，已截断)</p>';
        }
        if (typeof marked !== 'undefined') {
            if (!this._markedConfigured) {
                const renderer = new marked.Renderer();
                renderer.listitem = function(text) {
                    const raw = typeof text === 'object' ? text.text || text.raw || '' : String(text);
                    const m = raw.match(/^<input\s+checked=""\s+disabled=""\s+type="checkbox">(?:\s*)(.*)/i);
                    const m2 = raw.match(/^<input\s+disabled=""\s+type="checkbox">(?:\s*)(.*)/i);
                    if (m) return `<li class="task-completed"><input type="checkbox" checked disabled>${m[1]}</li>`;
                    if (m2) return `<li class="task-pending"><input type="checkbox" disabled>${m2[1]}</li>`;
                    return `<li>${raw}</li>`;
                };
                renderer.list = function(body) {
                    const raw = typeof body === 'object' ? body.items || body.raw || '' : String(body);
                    const isTask = raw.includes('type="checkbox"');
                    return isTask ? `<ul class="task-list">${raw}</ul>` : `<ul>${raw}</ul>`;
                };
                renderer.code = function(code, language) {
                    const lang = (language || 'text').toLowerCase();
                    const safeCode = AIChat.escapeHtml(code);
                    return `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">${lang}</span><button class="ai-code-copy" onclick="AIChat.copyCode(this)">复制</button></div><pre><code class="hljs language-${lang}">${safeCode}</code></pre></div>`;
                };
                marked.setOptions({
                    renderer,
                    breaks: true,
                    gfm: true
                });
                this._markedConfigured = true;
            }
            try { return marked.parse(text); } catch (e) { return this.escapeHtml(text); }
        }
        let html = this.escapeHtml(text);
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
        html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
        html = html.replace(/\n{2,}/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        html = '<p>' + html + '</p>';
        html = html.replace(/<p>(<h[123]>)/g, '$1');
        html = html.replace(/(<\/h[123]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<(?:pre|ul|ol|blockquote)>)/g, '$1');
        html = html.replace(/(<\/(?:pre|ul|ol|blockquote)>)<\/p>/g, '$1');
        html = html.replace(/<p><\/p>/g, '');
        return html;
    },

    copyCode(btn) {
        const codeBlock = btn.closest('.ai-code-block');
        if (!codeBlock) return;
        const code = codeBlock.querySelector('code');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(() => {
            btn.textContent = '已复制';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2000);
        }).catch(() => {});
    },

    classifyError(error) {
        const e = (error || '').toLowerCase();
        if (e.includes('429') || e.includes('rate_limit')) return { icon: svgIcon('M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83'), title: '请求过于频繁', retryLabel: '稍后重试', action: 'retry' };
        if (e.includes('quota') || e.includes('exhausted') || e.includes('insufficient') || e.includes('余额') || e.includes('配额') || e.includes('billing') || e.includes('payment')) return { icon: svgIcon('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z'), title: '配额已用完', retryLabel: '打开设置', action: 'settings' };
        if (e.includes('过期') || e.includes('expired') || e.includes('invalid_token') || e.includes('token_invalid')) return { icon: svgIcon('M23 18v2h-8v-2h3v-7a3 3 0 0 0-3-3h-4V4a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h16a2 2 0 0 0 2-2zM8 14h8v2H8z'), title: '令牌/API Key 已过期', retryLabel: '打开设置', action: 'settings' };
        if (e.includes('401') || e.includes('403') || e.includes('api key') || e.includes('apikey') || e.includes('unauthorized') || e.includes('认证失败')) return { icon: svgIcon('M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'), title: 'API 密钥无效', retryLabel: '检查设置', action: 'settings' };
        if (e.includes('network') || e.includes('econnrefused') || e.includes('timeout') || e.includes('超时')) return { icon: svgIcon('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zM17.9 17.39c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'), title: '网络连接失败', retryLabel: '重新连接', action: 'retry' };
        if (e.includes('context_length') || (e.includes('token') && e.includes('exceed')) || e.includes('too long')) return { icon: svgIcon('M21 3H3v18h18V3zM9 3v18M15 3v18M3 9h18M3 15h18'), title: '对话过长', retryLabel: '新对话', action: 'retry' };
        return { icon: svgIcon('M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z,M12 9v4,M12 17h.01'), title: '请求失败', retryLabel: '重试', action: 'retry' };
    },

    retryLastMessage() {
        const conv = this.getCurrent();
        if (!conv) return;
        const lastMsg = conv.messages[conv.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') conv.messages.pop();
        const lastUserMsg = [...conv.messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
            this.showMessages(conv.messages);
            this.sendMessage(lastUserMsg.content);
        }
    },

    copyLastMessage() {
        const conv = this.getCurrent();
        if (!conv) return;
        const lastMsg = [...conv.messages].reverse().find(m => m.role === 'assistant');
        if (lastMsg) {
            navigator.clipboard.writeText(lastMsg.content).catch(() => {});
        }
    },

    async exportConversation() {
        const conv = this.getCurrent();
        if (!conv) return;
        const text = conv.messages.map(m => `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content}`).join('\n\n---\n\n');
        try {
            if (window.electronAPI?.clipboard) { window.electronAPI.clipboard.writeText(text); }
            else { await navigator.clipboard.writeText(text); }
        } catch(e) {
            try { await navigator.clipboard.writeText(text); } catch(e2) {}
        }
        if (typeof showToast === 'function') showToast('对话已复制到剪贴板', 'success');
    },



    updateModelLabel() {
        const label = document.getElementById('ai-current-model-label');
        const settingsName = document.getElementById('ai-settings-model-name');
        const settingsBadge = document.getElementById('ai-settings-model-badge');
        const modelId = this.model || 'glm-5-flash';
        let displayName = modelId;
        let isFree = false;
        for (const p of this.providers) {
            const m = p.models.find(m => m.id === modelId);
            if (m) { displayName = m.name; isFree = m.free; break; }
        }
        if (label) label.textContent = displayName;
        if (settingsName) settingsName.textContent = displayName;
        if (settingsBadge) {
            settingsBadge.textContent = isFree ? '免费' : '付费';
            settingsBadge.className = 'ai-settings-model-badge' + (isFree ? ' free' : '');
        }
    },


    handlePaste(event) {
        const items = event.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                event.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const textarea = document.getElementById('ai-input');
                        if (textarea) {
                            textarea.value += `[图片: ${file.name || 'clipboard'}]`;
                            aiAutoResize(textarea);
                        }
                    };
                    reader.readAsDataURL(file);
                }
                return;
            }
        }
    },

    handleDrop(event) {
        event.preventDefault();
        const textarea = document.getElementById('ai-input');
        if (!textarea) return;
        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
            for (const file of files) {
                textarea.value += `[文件: ${file.path || file.name}]`;
            }
            aiAutoResize(textarea);
        }
    },

    showModelSelector() {
        this._currentSettingsTab = 'providers';
        this.toggleSettings();
    },

    showFolderSwitcher() {
        this._currentSettingsTab = 'ui';
        this.toggleSettings();
    },

    clearFollowUpSuggestions() {
        const suggestions = document.querySelectorAll('.ai-follow-up, .ai-suggestion-chip, .rc-follow-up');
        suggestions.forEach(el => el.remove());
    },

    renderAddedModels() {
        const container = document.getElementById('ai-added-models-list');
        if (!container) return;
        if (!this.addedModels || this.addedModels.length === 0) {
            container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:12px 0">暂无已添加的模型</div>';
            return;
        }
        container.innerHTML = this.addedModels.map(m => `
            <div class="rc-model-item ${m.modelId === this.model ? 'active' : ''}" onclick="AIChat.useModel('${m.modelId}')">
                <div class="rc-model-item-info">
                    <span class="rc-model-item-name">${this._escapeHtml(m.customName || m.modelId)}</span>
                    <span class="rc-model-item-provider">${this._escapeHtml(m.provider || '')}</span>
                </div>
                <button class="rc-model-item-remove" onclick="event.stopPropagation();AIChat.removeAddedModel('${m.modelId}')">✕</button>
            </div>
        `).join('');
    },
};

function aiNewChat() { AIChat.newChat(); }
function aiToggleSettings() { AIChat.toggleSettings(); }
function aiSaveSettings() { AIChat.saveSettings(); }
function aiSearchConversations(query) { AIChat.renderSidebar(query); }
function aiClearAllChats() { AIChat.clearAllChats(); }
function switchSettingsPanel(panelId, el) {
    AIChat._switchSettingsTab(panelId);
}
async function aiSendMessage() {
    const input = document.getElementById('ai-input');
    if (input) await AIChat.sendMessage(input.value);
}
function aiStopGeneration() { AIChat.stopGenerationForce(); }
function aiSendQuick(text) { AIChat.sendMessage(text); }
function aiHandleKeyDown(e) {
    const sendOnEnter = !AIChat._uiSettings || AIChat._uiSettings.sendOnEnter !== false;
    if (e.key === 'Enter') {
        if (sendOnEnter && !e.shiftKey) {
            e.preventDefault();
            aiSendMessage();
        } else if (!sendOnEnter && e.ctrlKey) {
            e.preventDefault();
            aiSendMessage();
        }
    }
}
function aiAutoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

if (typeof window !== 'undefined') {
    window.AIChat = AIChat;
}
