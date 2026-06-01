/**
 * app.js - VersePC 前端主应用逻辑
 * ============================================================================
 * 所有渲染进程(前端)的UI交互逻辑，是用户界面的核心控制器。
 *
 * 核心功能：
 * 1. 版本管理 - 版本列表加载、渲染、筛选、选择
 * 2. 启动流程 - 启动按钮处理、启动模态框、进度轮询/SSE监听
 * 3. 模组管理 - 模组搜索、安装、详情、多选操作
 * 4. 系统设置 - Java路径/内存/窗口/语言/下载等设置
 * 5. 账户管理 - Microsoft/离线登录、皮肤显示
 * 6. Java管理 - Java运行时下载、切换、自动检测
 * 7. 整合包 - Modrinth/CurseForge整合包浏览和安装
 * 8. 地图/Saves - 存档和世界管理
 * 9. 资源下载 - 光影/材质/数据包等资源下载
 * 10. 界面框架 - Toast通知、Modal对话框、页面导航
 *
 * 架构说明：
 * - 单页面应用(SPA)架构，通过页面切换实现多视图
 * - 全局状态变量管理应用数据
 * - 通过 API 对象调用后端接口
 * - DOM缓存(domCache)优化频繁的DOM查询
 */

// ============================================================================
// 全局状态变量 - 应用数据状态中心
// ============================================================================
let currentVersionTab = 'release';
let allVersions = [];
let installedVersions = [];
let versionIconsTimestamp = Date.now();
let currentModTab = 'installed-mods';
let modSearchOffset = 0;
let modSearchTotal = 0;
let modSearchQuery = '';
let modSearchResults = [];
let currentInstallSessionId = null;
let msAuthPollInterval = null;
let currentLoaderType = 'fabric';
let gameLogEventSource = null;
let currentModDetailId = null;
let currentModDetailSource = 'modrinth';
let previousPage = null;
let modDetailVersions = [];
let modDownloadPollTimers = [];
const dlManager = {
    tasks: new Map(),
    order: [],
    add(id, name, type, sessionId, iconUrl) {
        if (this.tasks.has(id)) return;
        this.tasks.set(id, { id, name, type, sessionId, iconUrl: iconUrl || '', progress: 0, status: 'downloading', message: '', files: [], expanded: false });
        this.order.push(id);
        this.updateFab();
        this.render();
    },
    remove(id) {
        this.tasks.delete(id);
        this.order = this.order.filter(i => i !== id);
        this.updateFab();
        this.render();
    },
    update(id, data) {
        const task = this.tasks.get(id);
        if (!task) return;
        Object.assign(task, data);
        if (data.status === 'completed' || data.status === 'failed') {
            task.progress = data.status === 'completed' ? 100 : task.progress;
        }
        this.updateFab();
        this.updateDom(id);
    },
    updateDom(id) {
        const taskEl = document.querySelector('.dl-task[data-task-id="' + id + '"]');
        if (!taskEl) return;
        const t = this.tasks.get(id);
        if (!t) return;
        const fill = taskEl.querySelector('.dl-task-progress-fill');
        const percent = taskEl.querySelector('.dl-task-percent');
        if (fill) {
            fill.style.width = t.progress + '%';
            fill.className = 'dl-task-progress-fill' + (t.status === 'completed' ? ' dl-task-progress-fill--completed' : t.status === 'failed' ? ' dl-task-progress-fill--failed' : '');
        }
        if (percent) percent.textContent = Math.round(t.progress) + '%';
        const statusEl = taskEl.querySelector('.dl-task-status');
        if (statusEl) {
            statusEl.textContent = t.status === 'completed' ? '下载完成' : t.status === 'failed' ? '下载失败' : (t.message || '下载中...');
        }
        const detailEl = taskEl.querySelector('.dl-task-detail');
        if (detailEl && t.files && t.files.length > 0) {
            var hash = '';
            for (var i = 0; i < t.files.length; i++) {
                var f = t.files[i];
                hash += f.name + '_' + f.status + '_' + f.progress + ';';
            }
            if (hash !== t._lastFilesHash) {
                t._lastFilesHash = hash;
                detailEl.innerHTML = this.buildFilesHtml(t.files);
            }
        }
        if (t.status === 'completed' || t.status === 'failed') {
            if (!taskEl.querySelector('.dl-task-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'dl-task-actions';
                const btn = document.createElement('button');
                btn.className = 'btn btn-secondary btn-sm';
                btn.textContent = '移除';
                btn.addEventListener('click', () => dlManager.remove(id));
                actionsDiv.appendChild(btn);
                taskEl.appendChild(actionsDiv);
            }
        }
    },
    buildFilesHtml(files) {
        return files.map(f => {
            const fProgress = f.progress || 0;
            const fFillClass = f.status === 'completed' ? 'dl-task-progress-fill--completed' : f.status === 'failed' ? 'dl-task-progress-fill--failed' : '';
            const sIcon = f.status === 'completed' ? '✓' : f.status === 'failed' ? '✗' : f.status === 'downloading' ? '↓' : '○';
            const sClass = 'dl-file-status--' + (f.status || 'pending');
            const progressBar = (f.status === 'downloading' || f.status === 'pending') ? '<div class="dl-file-progress-bar"><div class="dl-file-progress-fill ' + fFillClass + '" style="width:' + fProgress + '%"></div></div><span class="dl-file-percent">' + fProgress + '%</span>' : '';
            return '<div class="dl-file-item"><span class="dl-file-status ' + sClass + '">' + sIcon + '</span><span class="dl-file-name">' + escapeHtml(f.name || '') + '</span>' + (f.size ? '<span class="dl-file-size">' + f.size + '</span>' : '') + '</div>' + (progressBar ? '<div class="dl-file-progress">' + progressBar + '</div>' : '');
        }).join('');
    },
    toggleExpand(id) {
        const task = this.tasks.get(id);
        if (!task) return;
        task.expanded = !task.expanded;
        const taskEl = document.querySelector('.dl-task[data-task-id="' + id + '"]');
        if (taskEl) {
            if (task.expanded) {
                taskEl.classList.add('dl-task--expanded');
            } else {
                taskEl.classList.remove('dl-task--expanded');
            }
        } else {
            this.render();
        }
    },
    updateFab() {
        const fab = document.getElementById('dl-fab');
        const badge = document.getElementById('dl-fab-badge');
        if (!fab) return;
        const active = [...this.tasks.values()].filter(t => t.status === 'downloading').length;
        const total = this.tasks.size;
        if (total === 0) {
            fab.style.display = 'none';
        } else {
            fab.style.display = 'flex';
            if (badge) {
                badge.style.display = active > 0 ? 'flex' : 'none';
                badge.textContent = active;
            }
        }
    },
    render() {
        const list = document.getElementById('download-queue-list');
        if (!list) return;
        if (this.order.length === 0) {
            list.innerHTML = '<p class="empty-text" id="dl-empty-hint">暂无下载任务</p>';
            return;
        }
        const svgIcons = {
            mod: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><path d="M20 16V7a2 2 0 00-2-2H6a2 2 0 00-2 2v9m16 0H4m16 0l1.28 2.55a1 1 0 01-.9 1.45H3.62a1 1 0 01-.9-1.45L4 16"/></svg>',
            modpack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
            version: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h.01M10 12h.01M14 12h4"/></svg>',
            java: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><path d="M17 8h1a4 4 0 110 8h-1M3 8h14v9a4 4 0 01-4 4H7a4 4 0 01-4-4V8zm0 0V6a2 2 0 012-2h2m4-2v2"/></svg>',
            other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8m8 4H8m2-8H8"/></svg>'
        };
        list.innerHTML = this.order.map(id => {
            const t = this.tasks.get(id);
            if (!t) return '';
            const iconClass = 'dl-task-icon--' + (t.type || 'other');
            const iconHtml = t.iconUrl
                ? '<img src="' + t.iconUrl + '" alt="" class="dl-task-icon-img" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><div class="dl-task-icon-fallback dl-task-icon-svg" style="display:none">' + (svgIcons[t.type] || svgIcons.other) + '</div>'
                : svgIcons[t.type] || svgIcons.other;
            const fillClass = t.status === 'completed' ? 'dl-task-progress-fill--completed' : t.status === 'failed' ? 'dl-task-progress-fill--failed' : '';
            const statusText = t.status === 'completed' ? '下载完成' : t.status === 'failed' ? '下载失败' : (t.message || '下载中...');
            const expandedClass = t.expanded ? 'dl-task--expanded' : '';
            let filesHtml = '';
            if (t.files && t.files.length > 0) {
                filesHtml = this.buildFilesHtml(t.files);
            }
            let actionsHtml = '';
            if (t.status === 'completed' || t.status === 'failed') {
                actionsHtml = '<div class="dl-task-actions"><button class="btn btn-secondary btn-sm dl-task-remove-btn" data-task-id="' + escapeHtml(id) + '">移除</button></div>';
            }
            return '<div class="dl-task ' + expandedClass + '" data-task-id="' + escapeHtml(id) + '">' +
                '<div class="dl-task-header dl-task-toggle-btn" data-task-id="' + escapeHtml(id) + '">' +
                '<div class="dl-task-icon ' + iconClass + '">' + iconHtml + '</div>' +
                '<div class="dl-task-info">' +
                '<div class="dl-task-name">' + escapeHtml(t.name) + '</div>' +
                '<div class="dl-task-status">' + escapeHtml(statusText) + '</div>' +
                '</div>' +
                '<div class="dl-task-progress">' +
                '<div class="dl-task-progress-bar"><div class="dl-task-progress-fill ' + fillClass + '" style="width:' + t.progress + '%"></div></div>' +
                '<span class="dl-task-percent">' + Math.round(t.progress) + '%</span>' +
                '</div>' +
                '<svg class="dl-task-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>' +
                '</div>' +
                '<div class="dl-task-detail">' + filesHtml + '</div>' +
                actionsHtml +
                '</div>';
        }).join('');

        list.querySelectorAll('.dl-task-toggle-btn').forEach(el => {
            el.addEventListener('click', () => dlManager.toggleExpand(el.dataset.taskId));
        });
        list.querySelectorAll('.dl-task-remove-btn').forEach(el => {
            el.addEventListener('click', () => dlManager.remove(el.dataset.taskId));
        });
    }
};

function clearCompletedDownloads() {
    const toRemove = [...dlManager.tasks.entries()].filter(([_, t]) => t.status === 'completed' || t.status === 'failed').map(([id]) => id);
    toRemove.forEach(id => dlManager.remove(id));
}
let launchDepPollTimer = null;
let modMultiSelectMode = false;
let modSelectedIds = new Set();
let modSelectedVersions = new Map();

// ============================================================================
// 优化基础设施 - DOM缓存、防抖节流等
// ============================================================================

// DOM 缓存对象
const domCache = new Map();
function getDOMElement(id) {
    if (domCache.has(id)) return domCache.get(id);
    const el = document.getElementById(id);
    if (el) domCache.set(id, el);
    return el;
}
function clearDOMCache() { domCache.clear(); }

// 缓存常用 DOM 元素（在 init 结束时调用）
const commonElements = {};
function cacheCommonElements() {
    const ids = [
        'mod-filter-version', 'mod-filter-loader', 'mod-filter-search',
        'msauth-status-text', 'acc-start-btn', 'launch-error-msg',
        'status-indicator', 'status-text', 'launch-btn',
        'mod-multiselect-toggle', 'mod-filter-sort', 'mod-list'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) commonElements[id] = el;
    });
}
// 刷新单个缓存元素
function refreshElementCache(id) {
    const el = document.getElementById(id);
    if (el) commonElements[id] = el;
    else delete commonElements[id];
}

// 防抖函数
function debounce(fn, delay = 300) {
    let timer = null;
    return function(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            fn.apply(this, args);
            timer = null;
        }, delay);
    };
}

// 节流函数
function throttle(fn, limit = 100) {
    let inThrottle = false;
    return function(...args) {
        if (!inThrottle) {
            fn.apply(this, args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

// fetch 超时包装器
async function fetchWithTimeout(url, options = {}, timeout = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

// 定时器管理
const managedTimers = { intervals: new Map(), timeouts: new Map() };
function setManagedInterval(fn, delay, key) {
    if (managedTimers.intervals.has(key)) clearInterval(managedTimers.intervals.get(key));
    const id = setInterval(fn, delay);
    managedTimers.intervals.set(key, id);
    return id;
}
function clearManagedInterval(key) {
    if (managedTimers.intervals.has(key)) {
        clearInterval(managedTimers.intervals.get(key));
        managedTimers.intervals.delete(key);
    }
}
function clearAllManagedIntervals() {
    managedTimers.intervals.forEach(id => clearInterval(id));
    managedTimers.intervals.clear();
}

// ─── 自定义下拉菜单组件 ──────────────────────────────────
class CustomSelect {
    constructor(wrapperId, options = {}) {
        this.wrapper = document.getElementById(wrapperId);
        if (!this.wrapper) return;

        this.trigger = this.wrapper.querySelector('.custom-select-trigger');
        this.valueEl = this.wrapper.querySelector('.custom-select-value');
        this.dropdown = this.wrapper.querySelector('.custom-select-dropdown');
        this.optionsContainer = this.wrapper.querySelector('.custom-select-options');
        this.searchInput = this.wrapper.querySelector('.custom-select-input');
        this.placeholder = this.wrapper.querySelector('.custom-select-value.placeholder');

        this.isOpen = false;
        this.selectedValue = '';
        this.selectedText = '';
        this.allOptions = [];
        this.filteredOptions = [];
        this.onChange = options.onChange || (() => {});
        this._originalParent = this.dropdown ? this.dropdown.parentNode : null;

        this.init();
    }

    init() {
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.filterOptions(e.target.value);
            });
            this.searchInput.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.wrapper.contains(e.target) && !this.dropdown.contains(e.target)) {
                this.close();
            }
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });

        window.addEventListener('scroll', () => {
            if (this.isOpen) this.updatePosition();
        }, true);

        window.addEventListener('resize', () => {
            if (this.isOpen) this.updatePosition();
        });
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    updatePosition() {
        if (!this.trigger || !this.dropdown) return;
        const rect = this.trigger.getBoundingClientRect();
        const vpH = window.innerHeight;
        const vpW = window.innerWidth;
        const ddH = this.dropdown.offsetHeight || 200;

        let top = rect.bottom + 6;
        let left = rect.left;

        if (top + ddH > vpH && rect.top > ddH) {
            top = rect.top - ddH - 6;
        }
        if (top < 4) top = 4;

        if (left + rect.width > vpW) {
            left = vpW - rect.width - 4;
        }
        if (left < 4) left = 4;

        this.dropdown.style.top = Math.round(top) + 'px';
        this.dropdown.style.left = Math.round(left) + 'px';
        this.dropdown.style.width = Math.round(rect.width) + 'px';
    }

    open() {
        this.isOpen = true;
        this.wrapper.classList.add('open');

        document.body.appendChild(this.dropdown);
        this.dropdown.classList.add('custom-select-dropdown-active');

        this.updatePosition();

        if (this.searchInput) {
            setTimeout(() => this.searchInput.focus(), 50);
        }
    }

    close() {
        this.isOpen = false;
        this.wrapper.classList.remove('open');
        this.dropdown.classList.remove('custom-select-dropdown-active');

        this.dropdown.style.top = '';
        this.dropdown.style.left = '';
        this.dropdown.style.width = '';

        if (this._originalParent && this.dropdown.parentNode !== this._originalParent) {
            this._originalParent.appendChild(this.dropdown);
        }

        if (this.searchInput) {
            this.searchInput.value = '';
            this.filterOptions('');
        }
    }

    setOptions(options) {
        this.allOptions = options;
        this.filteredOptions = [...options];
        this.renderOptions();
    }

    filterOptions(query) {
        const q = query.toLowerCase().trim();
        if (!q) {
            this.filteredOptions = [...this.allOptions];
        } else {
            this.filteredOptions = this.allOptions.filter(opt =>
                opt.text.toLowerCase().includes(q) ||
                opt.value.toLowerCase().includes(q)
            );
        }
        this.renderOptions();
    }

    renderOptions() {
        if (!this.optionsContainer) return;

        if (this.filteredOptions.length === 0) {
            this.optionsContainer.innerHTML = '<div class="custom-select-no-results">未找到匹配的版本</div>';
            return;
        }

        const html = this.filteredOptions.map(opt => `
            <div class="custom-select-option ${opt.value === this.selectedValue ? 'selected' : ''}"
                 data-value="${opt.value}">
                ${opt.icon ? `<div class="custom-select-option-icon">${opt.icon}</div>` : ''}
                <div class="custom-select-option-text">
                    <div class="custom-select-option-name">${opt.text}</div>
                    ${opt.subtext ? `<div class="custom-select-option-type">${opt.subtext}</div>` : ''}
                </div>
                <div class="custom-select-option-check">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            </div>
        `).join('');

        this.optionsContainer.innerHTML = html;

        this.optionsContainer.querySelectorAll('.custom-select-option').forEach(el => {
            el.addEventListener('click', () => {
                const value = el.dataset.value;
                const opt = this.allOptions.find(o => o.value === value);
                if (opt) {
                    this.select(value, opt.text);
                    this.onChange(value, opt);
                }
            });
        });
    }

    select(value, text) {
        this.selectedValue = value;
        this.selectedText = text;
        this.valueEl.textContent = text || '选择版本...';
        if (this.valueEl) {
            this.valueEl.classList.toggle('placeholder', !text);
        }

        this.optionsContainer.querySelectorAll('.custom-select-option').forEach(el => {
            el.classList.toggle('selected', el.dataset.value === value);
        });

        this.close();
    }

    getValue() {
        return this.selectedValue;
    }

    setValue(value) {
        const opt = this.allOptions.find(o => o.value === value);
        if (opt) {
            this.selectedValue = value;
            this.selectedText = opt.text;
            this.valueEl.textContent = opt.text;
            if (this.valueEl) {
                this.valueEl.classList.toggle('placeholder', !opt.text);
            }
        }
    }
}

let homeVersionCustomSelect = null;
let launchVersionCustomSelect = null;
let modloaderGameVersionCustomSelect = null;
let modloaderVersionCustomSelect = null;

const customSelectInstances = {};

function initAllCustomSelects() {
    if (!customSelectInstances['vset-icon-type']) {
        customSelectInstances['vset-icon-type'] = new CustomSelect('vset-icon-type-wrapper', {
            onChange: (value) => {
                if (!currentSettingsVersionId) return;
                API.setVersionIcon(currentSettingsVersionId, value).then(r => {
                    if (r.success) showToast('图标已更新', 'success');
                });
            }
        });
        customSelectInstances['vset-icon-type'].setOptions([
            { value: 'auto', text: '自动' },
            { value: 'grass', text: '草方块' },
            { value: 'cobblestone', text: '圆石' },
            { value: 'commandblock', text: '命令方块' },
            { value: 'neoforge', text: 'NeoForge' },
            { value: 'fabric', text: 'Fabric' }
        ]);
    }

    if (!customSelectInstances['vset-category']) {
        customSelectInstances['vset-category'] = new CustomSelect('vset-category-wrapper', {
            onChange: (value) => {
                if (!currentSettingsVersionId) return;
                API.setVersionCategory(currentSettingsVersionId, value).then(r => {
                    if (r.success) showToast('分类已更新', 'success');
                });
            }
        });
        customSelectInstances['vset-category'].setOptions([
            { value: 'auto', text: '自动' },
            { value: 'survival', text: '生存' },
            { value: 'creative', text: '创造' },
            { value: 'modded', text: '模组' },
            { value: 'other', text: '其他' }
        ]);
    }

    if (!customSelectInstances['vset-isolation']) {
        customSelectInstances['vset-isolation'] = new CustomSelect('vset-isolation-wrapper');
        customSelectInstances['vset-isolation'].setOptions([
            { value: 'global', text: '跟随全局设置' },
            { value: 'on', text: '开启' },
            { value: 'off', text: '关闭' }
        ]);
    }

    if (!customSelectInstances['vset-mem-optimize']) {
        customSelectInstances['vset-mem-optimize'] = new CustomSelect('vset-mem-optimize-wrapper');
        customSelectInstances['vset-mem-optimize'].setOptions([
            { value: 'global', text: '跟随全局设置' },
            { value: 'on', text: '开启' },
            { value: 'off', text: '关闭' }
        ]);
    }

    if (!customSelectInstances['mod-filter-loader']) {
        customSelectInstances['mod-filter-loader'] = new CustomSelect('mod-filter-loader-wrapper', {
            onChange: () => loadMods()
        });
        customSelectInstances['mod-filter-loader'].setOptions([
            { value: '', text: '全部' },
            { value: 'fabric', text: 'Fabric' },
            { value: 'forge', text: 'Forge' },
            { value: 'neoforge', text: 'NeoForge' }
        ]);
    }

    if (!customSelectInstances['mod-filter-sort']) {
        customSelectInstances['mod-filter-sort'] = new CustomSelect('mod-filter-sort-wrapper', {
            onChange: () => loadMods()
        });
        customSelectInstances['mod-filter-sort'].setOptions([
            { value: 'relevance', text: '相关度' },
            { value: 'downloads', text: '下载量' },
            { value: 'newest', text: '最新' },
            { value: 'updated', text: '最近更新' }
        ]);
    }

    if (!customSelectInstances['mod-filter-category']) {
        customSelectInstances['mod-filter-category'] = new CustomSelect('mod-filter-category-wrapper', {
            onChange: () => loadMods()
        });
        customSelectInstances['mod-filter-category'].setOptions([
            { value: '', text: '全部' }
        ]);
    }

    if (!customSelectInstances['mod-filter-version']) {
        customSelectInstances['mod-filter-version'] = new CustomSelect('mod-filter-version-wrapper', {
            onChange: () => loadMods()
        });
        customSelectInstances['mod-filter-version'].setOptions([
            { value: '', text: '全部' }
        ]);
    }

    if (!customSelectInstances['modpack-filter-loader']) {
        customSelectInstances['modpack-filter-loader'] = new CustomSelect('modpack-filter-loader-wrapper', {
            onChange: () => {}
        });
        customSelectInstances['modpack-filter-loader'].setOptions([
            { value: '', text: '全部' },
            { value: 'fabric', text: 'Fabric' },
            { value: 'forge', text: 'Forge' },
            { value: 'neoforge', text: 'NeoForge' },
            { value: 'quilt', text: 'Quilt' }
        ]);
    }

    if (!customSelectInstances['modpack-filter-version']) {
        customSelectInstances['modpack-filter-version'] = new CustomSelect('modpack-filter-version-wrapper');
        customSelectInstances['modpack-filter-version'].setOptions([{ value: '', text: '全部' }]);
    }

    if (!customSelectInstances['datapack-filter-version']) {
        customSelectInstances['datapack-filter-version'] = new CustomSelect('datapack-filter-version-wrapper');
        customSelectInstances['datapack-filter-version'].setOptions([{ value: '', text: '全部' }]);
    }

    if (!customSelectInstances['resourcepack-filter-version']) {
        customSelectInstances['resourcepack-filter-version'] = new CustomSelect('resourcepack-filter-version-wrapper');
        customSelectInstances['resourcepack-filter-version'].setOptions([{ value: '', text: '全部' }]);
    }

    if (!customSelectInstances['resourcepack-filter-resolution']) {
        customSelectInstances['resourcepack-filter-resolution'] = new CustomSelect('resourcepack-filter-resolution-wrapper');
        customSelectInstances['resourcepack-filter-resolution'].setOptions([
            { value: '', text: '全部' },
            { value: '16x', text: '16x' },
            { value: '32x', text: '32x' },
            { value: '64x', text: '64x' },
            { value: '128x', text: '128x' },
            { value: '256x', text: '256x' },
            { value: '512x', text: '512x' }
        ]);
    }
}

function getCustomSelectValue(id) {
    const instance = customSelectInstances[id];
    return instance ? instance.getValue() : '';
}

function setCustomSelectValue(id, value) {
    const instance = customSelectInstances[id];
    if (instance) instance.setValue(value);
}

function updateCustomSelectOptions(id, options) {
    const instance = customSelectInstances[id];
    if (instance) instance.setOptions(options);
}

// ─── 原有函数 ──────────────────────────────────────────────


function showToast(message, type = 'info') {
    const container = getDOMElement('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => {
            toast.remove();
            // 如果没有 toast 了，清理容器引用
            if (container.children.length === 0) domCache.delete('toast-container');
        }, 300);
    }, 3000);
}

function showModal(id) {
    var modal = getDOMElement(id);
    if (!modal) {
        console.error('Modal not found:', id);
        return;
    }

    if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }

    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-state', 'open');

    modal.dataset.previouslyFocused = document.activeElement ? (document.activeElement.id || '') : '';

    modal.style.display = 'flex';
    requestAnimationFrame(function () {
        modal.classList.add('modal-visible');
        modal.classList.remove('modal-exiting');
    });

    requestAnimationFrame(function () {
        var closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.focus();
        }
    });

    var onKeyDown = function (e) {
        if (e.key === 'Escape') {
            hideModal(id);
        }
    };
    modal.addEventListener('keydown', onKeyDown);
    modal._escCleanup = function () { modal.removeEventListener('keydown', onKeyDown); };

    if (!modal.dataset.noCloseOnBackdrop) {
        var onBackdrop = function (e) {
            if (e.target === modal) {
                hideModal(id);
            }
        };
        modal.addEventListener('click', onBackdrop);
        modal._backdropCleanup = function () { modal.removeEventListener('click', onBackdrop); };
    }
}

function hideModal(id) {
    var modal = getDOMElement(id);
    if (!modal) return;

    modal.setAttribute('data-state', 'closed');
    modal.classList.add('modal-exiting');
    modal.classList.remove('modal-visible');

    if (typeof modal._escCleanup === 'function') {
        modal._escCleanup();
        modal._escCleanup = null;
    }
    if (typeof modal._backdropCleanup === 'function') {
        modal._backdropCleanup();
        modal._backdropCleanup = null;
    }

    setTimeout(function () {
        var prevId = modal.dataset.previouslyFocused;
        if (prevId) {
            var prevEl = document.getElementById(prevId);
            if (prevEl) {
                try { prevEl.focus(); } catch (e) {}
            }
        }
        modal.classList.remove('modal-exiting');
        modal.style.display = 'none';
    }, 200);
}

function showConfirmDialog(title, message, confirmText, cancelText) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'confirm-dialog-title');

        overlay.innerHTML = `
            <div class="modal-content" style="width:440px;min-height:auto;">
                <div class="modal-header">
                    <h3 id="confirm-dialog-title">${title || '确认'}</h3>
                    <button class="modal-close confirm-cancel" aria-label="关闭对话框">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="margin:0;color:var(--text-secondary);font-size:14px;line-height:1.6;">${message || ''}</p>
                </div>
                <div class="modal-footer">
                    <button class="modal-btn modal-btn--secondary confirm-cancel">${cancelText || '取消'}</button>
                    <button class="modal-btn modal-btn--danger confirm-ok">${confirmText || '确定'}</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        
        // Show modal with animation
        requestAnimationFrame(() => overlay.classList.add('modal-visible'));

        var close = function (result) {
            overlay.setAttribute('data-state', 'closed');
            overlay.classList.add('modal-exiting');
            overlay.classList.remove('modal-visible');

            setTimeout(function () {
                if (overlay.parentElement) {
                    overlay.parentElement.removeChild(overlay);
                }
                resolve(result);
            }, 200);
        };

        // Close on cancel buttons
        overlay.querySelectorAll('.confirm-cancel').forEach(btn => {
            btn.addEventListener('click', () => close(false));
        });
        
        // Confirm action
        overlay.querySelector('.confirm-ok').addEventListener('click', () => close(true));
        
        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        
        // Close on ESC key
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close(false);
        });
    });
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        return d.toLocaleDateString('zh-CN');
    } catch (e) { return dateStr; }
}

function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return bytesPerSec + ' B/s';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function escapeOnclick(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

const SUPPORT_MILESTONES = [3, 5, 10, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1500, 2000, 3000, 5000, 10000];

function getLaunchCount() {
    try { return parseInt(localStorage.getItem('verse_launchCount') || '0', 10); }
    catch (e) { return 0; }
}

var _launchCounted = false;

function incrementLaunchCount() {
    if (_launchCounted) return getLaunchCount();
    _launchCounted = true;
    var c = getLaunchCount() + 1;
    try { localStorage.setItem('verse_launchCount', String(c)); } catch (e) {}
    return c;
}

function isSupportMilestone(c) { return SUPPORT_MILESTONES.indexOf(c) !== -1; }

function checkSupportMilestone() {
    var c = getLaunchCount();
    if (isSupportMilestone(c)) {
        setTimeout(function() {
            document.getElementById('support-modal-count').textContent = c;
            document.getElementById('support-modal').style.display = '';
        }, 800);
    }
}

function openSupportPage() {
    window.open('https://ifdian.net/a/versejava?tab=home', '_blank');
    dismissSupportModal();
}

function dismissSupportModal() {
    document.getElementById('support-modal').style.display = 'none';
}

function generateColorAvatar(username, size) {
    size = size || 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    ctx.fillStyle = 'hsl(' + hue + ', 55%, 50%)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold ' + Math.floor(size * 0.45) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(username.charAt(0).toUpperCase(), size / 2, size / 2);
    return canvas.toDataURL('image/png');
}

const VERSION_TYPE_LABELS = { release: '正式版', snapshot: '快照版', old_beta: '旧测试版', old_alpha: '旧内测版', '(old)': '旧版' };
function getVersionTypeLabel(v) {
    const type = v.type || 'release';
    let label = VERSION_TYPE_LABELS[type] || type;
    if (v.complianceLevel === 0) label = '未混淆';
    return label;
}

const DL_FOLDER_KEY = 'versepc_dl_folders';
function getRememberedFolder(key) {
    try { const d = JSON.parse(localStorage.getItem(DL_FOLDER_KEY) || '{}'); return d[key] || ''; } catch (e) { return ''; }
}
function saveRememberedFolder(key, folderPath) {
    try { const d = JSON.parse(localStorage.getItem(DL_FOLDER_KEY) || '{}'); d[key] = folderPath; localStorage.setItem(DL_FOLDER_KEY, JSON.stringify(d)); } catch (e) {}
}

// ============================================================================
// 应用初始化 - 页面加载完成后的启动流程
// ============================================================================
async function init() {
    const splashProgress = document.getElementById('splash-progress');
    const splashOverlay = document.getElementById('splash-overlay');
    const startTime = Date.now();
    const MIN_SPLASH_DURATION = 800;
    const _perfInit = (label) => console.log(`[PERF-INIT] ${label} ${(performance.now()-_perfT).toFixed(1)}ms`);
    let _perfT = performance.now();

    try {
        const earlyTheme = await window.electronAPI.store.get('versepc_theme');
        if (earlyTheme) {
            const legacyThemes = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];
            const themeName = legacyThemes.includes(earlyTheme) ? 'dark' : earlyTheme;
            document.documentElement.setAttribute('data-theme', themeName);
            document.querySelectorAll('.theme-option').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-theme') === themeName);
            });
        }
    } catch (e) {}

    function setProgress(val, statusText) {
        if (!splashProgress) return;
        splashProgress.style.width = Math.min(val, 100) + '%';
        
        const splashStatus = document.getElementById('splash-status');
        if (splashStatus && statusText) {
            splashStatus.textContent = statusText;
        }
    }

    function safeSetup(name, fn) {
        try { fn(); } catch (e) {
            console.error('Setup failed:', name, e);
        }
    }

    try {
        setProgress(5, '正在初始化界面...');
        safeSetup('navigation', setupNavigation);
        safeSetup('launchBar', setupLaunchBar);
        safeSetup('windowControls', setupWindowControls);
        initAllCustomSelects();
        setProgress(15, '正在构建界面...');
        _perfInit('setup UI');

        try {
            const cachedName = localStorage.getItem('cachedPlayerName');
            if (cachedName) {
                const homeName = document.getElementById('home-player-name');
                const launchName = document.getElementById('launch-player-name');
                if (homeName) homeName.textContent = cachedName;
                if (launchName) launchName.textContent = cachedName;
            }
        } catch(e) {}

        safeSetup('tabs', setupTabs);
        safeSetup('modBrowse', setupModBrowse);
        safeSetup('accountButtons', setupAccountButtons);
        safeSetup('versionListClicks', setupVersionListClicks);
        setProgress(25, '正在加载数据...');
        _perfT = performance.now();

        // 并行加载核心数据，避免串行等待
        const [settingsResult, versionsResult, accountsResult] = await Promise.allSettled([
            loadSettings(),
            loadVersions(),
            loadAccounts()
        ]);
        _perfInit('load data (parallel)');
        setProgress(70, '正在初始化功能...');

        // 设置页面初始化（轻量，不涉及网络请求）
        safeSetup('settingsPage', setupSettingsPage);
        safeSetup('javaPage', setupJavaPage);
        safeSetup('console', setupConsole);
        _perfInit('setup pages');

        setProgress(90, '正在完成...');

        // 尝试加载游玩时间（非关键，失败不影响首屏）
        try {
            const selVal = homeVersionCustomSelect ? homeVersionCustomSelect.getValue() : '';
            if (selVal) await loadPlayTimeDisplay(selVal);
        } catch (e) {}

        setProgress(100, '准备就绪!');

        updateGameStatus();
        setManagedInterval(updateGameStatus, 3000, 'updateGameStatus');
        checkJavaOnStartup();

        setTimeout(() => {
            triggerJvmPreheat();
        }, 10000);

        cacheCommonElements();

        if (typeof initWallpaper === 'function') {
            initWallpaper();
        }

        initWallpaperDropZone();
        initWallpaperAutoAdapt();
        _perfInit('wallpaper');

        if (typeof AIChat !== 'undefined') {
            AIChat.init();
        }
        _perfInit('AIChat.init');

        try {
            const savedCustomImage = await window.electronAPI.store.get('versepc_custom_image');
            if (savedCustomImage && typeof setCustomWallpaperImage === 'function') {
                setCustomWallpaperImage(savedCustomImage);
            }

            const savedCustomVideo = await window.electronAPI.store.get('versepc_custom_video');
            if (savedCustomVideo && typeof setCustomWallpaperVideo === 'function') {
                setCustomWallpaperVideo(savedCustomVideo);
            }
        } catch (e) {
            console.error('[Init] Load custom wallpaper error:', e);
        }

        try {
            const savedWallpaper = await window.electronAPI.store.get('versepc_wallpaper');
            if (savedWallpaper) {
                let wpName = savedWallpaper;
                if (wpName === 'starry') wpName = 'panorama';
                const wpEl = document.querySelector(`.wallpaper-option[data-wallpaper="${wpName}"]`);
                if (wpEl) selectWallpaper(wpEl);
            }
        } catch (e) {
            console.error('[Init] Load wallpaper error:', e);
        }

        try {
            const savedOpacity = await window.electronAPI.store.get('versepc_wallpaper_opacity');
            if (savedOpacity != null) {
                const slider = document.getElementById('wallpaper-opacity-slider');
                if (slider) { slider.value = savedOpacity; onWallpaperOpacityChange(savedOpacity); }
            }

            const savedBlur = await window.electronAPI.store.get('versepc_wallpaper_blur');
            if (savedBlur != null) {
                const slider = document.getElementById('wallpaper-blur-slider');
                if (slider) { slider.value = savedBlur; onWallpaperBlurChange(savedBlur); }
            }

            const savedFit = await window.electronAPI.store.get('versepc_wallpaper_fit');
            if (savedFit) {
                const select = document.getElementById('wallpaper-fit-select');
                if (select) { select.value = savedFit; onWallpaperFitChange(savedFit); }
            }

            const savedCustomImage = await window.electronAPI.store.get('versepc_custom_image');
            if (savedCustomImage) {
                const nameEl = document.getElementById('custom-wallpaper-file-name');
                if (nameEl) nameEl.textContent = savedCustomImage.split(/[\\/]/).pop();
                _updateCustomImagePreview(savedCustomImage);
            }

            const savedCustomVideo = await window.electronAPI.store.get('versepc_custom_video');
            if (savedCustomVideo) {
                const nameEl = document.getElementById('custom-wallpaper-file-name');
                if (nameEl) nameEl.textContent = savedCustomVideo.split(/[\\/]/).pop();
            }
        } catch (e) {
            console.error('[Init] Load wallpaper settings error:', e);
        }
    } catch (e) {
        console.error('Init critical error:', e);
        setProgress(100, '初始化完成');
    }

    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_SPLASH_DURATION) {
        await new Promise(r => setTimeout(r, MIN_SPLASH_DURATION - elapsed));
    }

    await new Promise(r => setTimeout(r, 200));

    if (splashOverlay) {
        splashOverlay.style.transition = 'opacity 0.4s cubic-bezier(0.4,0,0.2,1)';
        splashOverlay.style.opacity = '0';
        splashOverlay.style.pointerEvents = 'none';
        await new Promise(r => setTimeout(r, 400));
        try { splashOverlay.remove(); } catch (err) {}
    }

    // 首屏显示后，延迟加载非关键数据
    setTimeout(() => {
        Promise.allSettled([
            loadModFilterOptions(),
            loadInstalledMods(),
            loadFeaturedMods()
        ]).catch(e => console.error('延迟加载失败:', e));
    }, 100);
}

function setupNavigation() {
    document.querySelectorAll('.nav-btn:not(.nav-submenu-toggle)').forEach(btn => {
        btn.addEventListener('click', () => {
            const page = btn.dataset.page;
            if (!page) return;

            if (page === 'versions' && versionsLoadFailed) {
                console.log('[Navigate] Versions page entered, retrying load...');
                const container = document.getElementById('versions-list');
                if (container) {
                    container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>正在重新加载...</p></div>`;
                }
                loadVersions(true);
            }

            navigateToPage(page);
        });
    });

    document.querySelectorAll('.nav-submenu-group').forEach(group => {
        const toggle = group.querySelector('.nav-submenu-toggle');
        if (!toggle) return;

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = group.classList.contains('open');
            document.querySelectorAll('.nav-submenu-group').forEach(g => g.classList.remove('open'));
            if (!isOpen) group.classList.add('open');
        });

        group.querySelectorAll('.nav-sub-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                if (!page) return;
                navigateToPage(page);
            });
        });
    });
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            const parent = btn.closest('.tab-group');
            parent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (tab === 'release' || tab === 'snapshot' || tab === 'installed') {
                currentVersionTab = tab;
                renderVersions();
            } else if (tab === 'installed-mods') {
                currentModTab = 'installed-mods';
                const installedPanel = document.getElementById('installed-mods-panel');
                const browsePanel = document.getElementById('browse-mods-panel');
                if (installedPanel) installedPanel.style.display = '';
                if (browsePanel) browsePanel.style.display = 'none';
            } else if (tab === 'browse-mods') {
                currentModTab = 'browse-mods';
                const installedPanel = document.getElementById('installed-mods-panel');
                const browsePanel = document.getElementById('browse-mods-panel');
                if (installedPanel) installedPanel.style.display = 'none';
                if (browsePanel) browsePanel.style.display = '';
            } else if (tab === 'browse-modpacks') {
                loadResourcePage('modpack');
            } else if (tab === 'installed-modpacks') {
                loadInstalledModpacks();
            }
        });
    });

    document.querySelectorAll('.loader-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.loader-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentLoaderType = btn.dataset.loader;
            loadModLoaderVersions();
        });
    });
}

function setupLaunchBar() {
    document.getElementById('launch-btn').addEventListener('click', handleLaunch);
    document.getElementById('home-launch-btn').addEventListener('click', handleLaunch);

    if (!launchVersionCustomSelect) {
        launchVersionCustomSelect = new CustomSelect('launch-version-select-wrapper', {
            onChange: (value) => {
                if (homeVersionCustomSelect) homeVersionCustomSelect.setValue(value);
            }
        });
    }

    const windowSizeSelect = document.getElementById('window-size');
    const customWindowSizeDiv = document.getElementById('custom-window-size');
    const customWidthInput = document.getElementById('custom-width');
    const customHeightInput = document.getElementById('custom-height');

    if (windowSizeSelect && customWindowSizeDiv) {
        windowSizeSelect.addEventListener('change', () => {
            if (windowSizeSelect.value === 'custom') {
                customWindowSizeDiv.style.display = 'flex';
                if (!customWidthInput.value) customWidthInput.value = '1920';
                if (!customHeightInput.value) customHeightInput.value = '1080';
            } else {
                customWindowSizeDiv.style.display = 'none';
            }
        });
    }

    const refreshBtn = document.getElementById('refresh-versions-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
        showToast('正在刷新版本列表...', 'info');
        await loadVersions(true);
        showToast('版本列表已刷新', 'success');
    });
}

function setupModBrowse() {
    const modSearchBtn = document.getElementById('mod-search-btn');
    if (!modSearchBtn) return;
    const modSearchInput = document.getElementById('mod-search-input');
    modSearchBtn.addEventListener('click', () => {
        modSearchQuery = modSearchInput ? modSearchInput.value.trim() : '';
        modSearchOffset = 0;
        loadMods();
    });
    if (modSearchInput) modSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            modSearchQuery = e.target.value.trim();
            modSearchOffset = 0;
            loadMods();
        }
    });
    const modPrevBtn = document.getElementById('mod-prev-btn');
    if (modPrevBtn) modPrevBtn.addEventListener('click', () => {
        if (modSearchOffset >= 15) {
            modSearchOffset -= 15;
            loadMods();
        }
    });
    const modNextBtn = document.getElementById('mod-next-btn');
    if (modNextBtn) modNextBtn.addEventListener('click', () => {
        modSearchOffset += 15;
        loadMods();
    });

    const bindFilter = (id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => { modSearchOffset = 0; loadMods(); });
    };
    bindFilter('mod-filter-loader');
    bindFilter('mod-filter-version');
    bindFilter('mod-filter-category');
    bindFilter('mod-filter-sort');
}

function setupAccountButtons() {
    const addMsBtn = document.getElementById('add-ms-account-btn');
    if (!addMsBtn) return;
    addMsBtn.addEventListener('click', startMsAuth);
    const addThirdPartyBtn = document.getElementById('add-thirdparty-account-btn');
    if (addThirdPartyBtn) addThirdPartyBtn.addEventListener('click', () => {
        showModal('thirdparty-account-modal');
    });
    const addOfflineBtn = document.getElementById('add-offline-account-btn');
    if (addOfflineBtn) addOfflineBtn.addEventListener('click', () => {
        showModal('offline-account-modal');
    });
    const createOfflineBtn = document.getElementById('create-offline-btn');
    if (createOfflineBtn) createOfflineBtn.addEventListener('click', async () => {
        const offlineUsernameInput = document.getElementById('offline-username-input');
        const username = offlineUsernameInput ? offlineUsernameInput.value.trim() : '';
        if (!username) { showToast('请输入用户名', 'error'); return; }
        try {
            const result = await API.addOfflineAccount(username);
            if (result.success) {
                showToast(`离线账户 ${username} 创建成功`, 'success');
                closeOfflineModal();
                await loadAccounts();
            } else {
                showToast(result.error || '创建失败', 'error');
            }
        } catch (e) {
            showToast('创建离线账户失败', 'error');
        }
    });

    const tpPreset = document.getElementById('tp-server-preset');
    const tpUrl = document.getElementById('tp-server-url');
    if (tpPreset) {
        tpPreset.addEventListener('change', () => {
            const val = tpPreset.value;
            if (val && val !== 'custom') {
                tpUrl.value = val;
                verifyThirdPartyServer(val);
            } else {
                tpUrl.value = '';
            }
        });
    }
    if (tpUrl) {
        tpUrl.addEventListener('blur', () => {
            const url = tpUrl.value.trim();
            if (url) verifyThirdPartyServer(url);
        });
    }

    const tpLoginBtn = document.getElementById('tp-login-btn');
    if (tpLoginBtn) tpLoginBtn.addEventListener('click', async () => {
        const tpServerUrl = document.getElementById('tp-server-url');
        const tpUsernameInput = document.getElementById('tp-username-input');
        const tpPasswordInput = document.getElementById('tp-password-input');
        const serverUrl = tpServerUrl ? tpServerUrl.value.trim() : '';
        const username = tpUsernameInput ? tpUsernameInput.value.trim() : '';
        const password = tpPasswordInput ? tpPasswordInput.value : '';
        if (!serverUrl) { showToast('请输入认证服务器地址', 'error'); return; }
        if (!username) { showToast('请输入邮箱或用户名', 'error'); return; }
        if (!password) { showToast('请输入密码', 'error'); return; }

        const btn = document.getElementById('tp-login-btn');
        btn.disabled = true;
        btn.textContent = '登录中...';
        try {
            const result = await API.loginThirdParty(serverUrl, username, password);
            if (result.success) {
                showToast(`欢迎，${result.account.username}！`, 'success');
                closeThirdPartyModal();
                await loadAccounts();
            } else if (result.needSelectProfile) {
                closeThirdPartyModal();
                showProfileSelectModal(result.accessToken, result.clientToken, result.serverUrl, result.availableProfiles);
            } else {
                showToast(result.error || '登录失败', 'error');
            }
        } catch (e) {
            showToast('登录失败', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '登录';
        }
    });
}

function setupSettingsPage() {
    const saveBtn = document.getElementById('save-settings-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', saveCurrentSettings);
    document.getElementById('reset-settings-btn').addEventListener('click', async () => {
        const confirmed = await showConfirmDialog('重置设置', '确定要重置所有设置为默认值吗？此操作不可恢复！', '重置', '取消');
        if (confirmed) {
            try {
                const result = await API.resetSettings();
                if (result.success) {
                    document.documentElement.setAttribute('data-theme', 'dark');
                    document.querySelectorAll('.theme-option').forEach(btn => {
                        btn.classList.toggle('active', btn.getAttribute('data-theme') === 'dark');
                    });
                    applyAccentColor('#ffffff');
                    await loadSettings();
                    showToast('设置已重置为默认值', 'success');
                } else {
                    showToast('重置失败: ' + (result.error || '未知错误'), 'error');
                }
            } catch (e) {
                showToast('重置失败: ' + e.message, 'error');
            }
        }
    });

    const accentColorInput = getDOMElement('custom-accent-color');
    if (accentColorInput) {
        const accentColorValueEl = getDOMElement('custom-color-value');
        const colorPreviewDot = document.getElementById('color-preview-dot');
        accentColorInput.addEventListener('input', throttle((e) => {
            const color = e.target.value;
            if (accentColorValueEl) accentColorValueEl.textContent = color;
            if (colorPreviewDot) colorPreviewDot.style.background = color;
        }, 50));
    }
}

function setupJavaPage() {
    document.getElementById('refresh-java-btn').addEventListener('click', loadInstalledJava);
    
    loadInstalledJava();
    loadJavaDownloadList();
}

async function loadInstalledJava() {
    const listEl = document.getElementById('installed-java-list');
    listEl.innerHTML = '<div class="loading">正在检测Java...</div>';
    
    try {
        const result = await API.getInstalledJava();
        
        if (result.java.length === 0) {
            listEl.innerHTML = '<div class="hint">未检测到已安装的Java</div>';
            return;
        }
        
        listEl.innerHTML = result.java.map((j, idx) => `
            <div class="java-item" data-java-index="${idx}">
                <div class="java-item-info">
                    <div class="java-version">
                        Java ${j.majorVersion} (${j.version})
                        <span class="java-badge ${j.source}">${j.source === 'system' ? '系统' : '内置'}</span>
                        ${j.isJdk ? '<span class="java-badge jdk">JDK</span>' : '<span class="java-badge jre">JRE</span>'}
                        ${j.is64Bit ? '<span class="java-badge arch">64位</span>' : '<span class="java-badge arch">32位</span>'}
                    </div>
                    <div class="java-path">${escapeHtml(j.path)}</div>
                </div>
                <div class="java-item-actions">
                    ${j.source === 'bundled' ? `<button class="btn btn-danger btn-sm java-delete-btn" data-java-index="${idx}">删除</button>` : ''}
                </div>
            </div>
        `).join('');

        listEl._javaData = result.java;
    } catch (e) {
        listEl.innerHTML = '<div class="hint">检测Java失败</div>';
    }
}

document.addEventListener('click', function(e) {
    const btn = e.target.closest('.java-delete-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.javaIndex, 10);
    const listEl = document.getElementById('installed-java-list');
    if (!listEl || !listEl._javaData || !listEl._javaData[idx]) return;
    const j = listEl._javaData[idx];
    deleteJava(j.javaHome, j.majorVersion);
});

async function deleteJava(javaHome, majorVersion) {
    if (!javaHome) {
        showToast('缺少Java路径信息', 'error');
        return;
    }
    const confirmed = await showConfirmDialog('删除 Java', `确定要删除 Java ${majorVersion} 吗？\n\n将删除: ${javaHome}\n\n此操作不可撤销！`, '删除', '取消');
    if (!confirmed) return;
    
    try {
        const result = await API.deleteJava(javaHome);
        if (result.success) {
            showToast(result.message || 'Java已删除', 'success');
            await loadInstalledJava();
        } else {
            showToast(result.message || '删除失败', 'error');
        }
    } catch (e) {
        showToast('删除Java失败: ' + (e.message || '未知错误'), 'error');
    }
}

async function loadJavaDownloadList() {
    const listEl = document.getElementById('java-download-list');
    listEl.innerHTML = '<div class="loading">正在获取Java版本列表...</div>';
    
    try {
        const result = await API.getJavaList();
        
        if (result.versions.length === 0) {
            listEl.innerHTML = '<div class="hint">无法获取Java版本列表</div>';
            return;
        }
        
        listEl.innerHTML = result.versions.map(j => `
            <div class="java-download-item">
                <div class="java-download-version">Java ${j.majorVersion}</div>
                <div class="java-download-info">版本: ${j.version}</div>
                <button class="btn btn-primary" onclick="downloadJava(${j.majorVersion})">下载</button>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = '<div class="hint">获取Java版本列表失败</div>';
    }
}

let javaDownloadSessionId = null;
let javaDownloadPollTimer = null;

async function downloadJava(majorVersion) {
    try {
        const result = await API.downloadJava(majorVersion);
        javaDownloadSessionId = result.sessionId;
        
        document.getElementById('java-download-progress').style.display = 'block';
        document.getElementById('java-progress-fill').style.width = '0%';
        document.getElementById('java-progress-text').textContent = '0%';
        document.getElementById('java-progress-message').textContent = '准备下载...';
        
        if (javaDownloadPollTimer) clearInterval(javaDownloadPollTimer);
        javaDownloadPollTimer = setInterval(pollJavaDownloadStatus, 500);
        
        showToast('开始下载Java ' + majorVersion, 'info');
    } catch (e) {
        showToast('启动下载失败: ' + e.message, 'error');
    }
}

async function pollJavaDownloadStatus() {
    if (!javaDownloadSessionId) return;
    
    try {
        const status = await API.getJavaDownloadStatus(javaDownloadSessionId);
        
        document.getElementById('java-progress-fill').style.width = status.progress + '%';
        document.getElementById('java-progress-text').textContent = status.progress + '%';
        let msg = status.message || '处理中...';
        if (status.speed && status.speed > 0) {
            const speedMB = (status.speed / 1024 / 1024).toFixed(2);
            msg += ` (${speedMB} MB/s)`;
        }
        document.getElementById('java-progress-message').textContent = msg;
        
        if (status.status === 'completed') {
            clearInterval(javaDownloadPollTimer);
            javaDownloadPollTimer = null;
            javaDownloadSessionId = null;
            
            showToast('Java安装成功！环境变量已自动配置', 'success');
            
            setTimeout(() => {
                document.getElementById('java-download-progress').style.display = 'none';
                loadInstalledJava();
            }, 2000);
        } else if (status.status === 'error') {
            clearInterval(javaDownloadPollTimer);
            javaDownloadPollTimer = null;
            javaDownloadSessionId = null;
            
            showToast('安装失败: ' + (status.message || '未知错误'), 'error');
        }
    } catch (e) {
        console.error('轮询Java下载状态失败:', e);
    }
}

function setupConsole() {
    const clearBtn = document.getElementById('clear-log-btn');
    const consoleOutput = document.getElementById('console-output');
    if (!clearBtn || !consoleOutput) return;
    clearBtn.addEventListener('click', () => {
        consoleOutput.innerHTML = '<p class="console-wait">日志已清空</p>';
    });
}

async function exportGameLog() {
    try {
        const versionId = typeof currentSettingsVersionId !== 'undefined' ? currentSettingsVersionId
            : (typeof launchVersionCustomSelect !== 'undefined' && launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '');
        const url = `/api/game/log/export${versionId ? '?versionId=' + encodeURIComponent(versionId) : ''}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (typeof showToast === 'function') showToast('日志导出成功', 'success');
    } catch (e) {
        console.error('[ExportLog] 导出失败:', e);
        if (typeof showToast === 'function') showToast('导出日志失败: ' + e.message, 'error');
    }
}

async function loadSettings() {
    try {
        const settings = await API.getSettings();
        const sv = (id, fallback) => { const el = document.getElementById(id); if (el) return el; return { value: fallback, checked: !!fallback, textContent: String(fallback) }; };

        sv('setting-java-path').value = settings.javaPath || '';
        sv('setting-max-memory').value = settings.maxMemory || 4096;
        sv('setting-min-memory').value = settings.minMemory || 1024;
        sv('setting-game-dir').value = settings.gameDir || '';
        sv('setting-version-isolation').checked = settings.versionIsolation !== false;
        sv('setting-fullscreen').checked = !!settings.fullscreen;
        sv('setting-resolution').value = settings.resolution || '1920x1080';
        sv('setting-java-args').value = settings.javaArgs || '';
        sv('setting-close-on-launch').checked = !!settings.closeOnLaunch;
        sv('setting-auto-update').checked = settings.autoUpdate !== false;

        sv('setting-download-source').value = settings.downloadSource || 'auto';
        sv('setting-version-source').value = settings.versionSource || 'auto';
        const maxThreads = settings.maxThreads || 32;
        sv('setting-max-threads').value = maxThreads;
        const threadCountEl = document.getElementById('thread-count-value');
        if (threadCountEl) threadCountEl.textContent = maxThreads;
        const enableChunkEl = document.getElementById('setting-enable-chunk-download');
        if (enableChunkEl) enableChunkEl.checked = settings.enableChunkDownload !== false;
        const maxChunksEl = document.getElementById('setting-max-chunks-per-file');
        if (maxChunksEl) {
            const maxChunks = settings.maxChunksPerFile || 8;
            maxChunksEl.value = maxChunks;
            const chunkLabel = document.getElementById('chunk-count-value');
            if (chunkLabel) chunkLabel.textContent = maxChunks;
        }
        const speedLimit = settings.speedLimit || 0;
        sv('setting-speed-limit').value = speedLimit;
        updateSpeedLimitLabel(speedLimit);
        sv('setting-target-dir').value = settings.targetDir || '';
        sv('setting-ssl-verify').checked = !!settings.sslVerify;

        sv('setting-mod-source').value = settings.modSource || 'modrinth';
        sv('setting-filename-format').value = settings.filenameFormat || 'default';
        sv('setting-mod-style').value = settings.modStyle || 'title';
        sv('setting-ignore-quilt').checked = !!settings.ignoreQuilt;

        const accentColor = settings.accentColor || '#ffffff';
        const accentColorInput = document.getElementById('custom-accent-color');
        if (accentColorInput) accentColorInput.value = accentColor;
        const accentColorValueEl = document.getElementById('custom-color-value');
        if (accentColorValueEl) accentColorValueEl.textContent = accentColor;

        let savedTheme = settings.theme || 'dark';
        const legacyThemes = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];
        if (legacyThemes.includes(savedTheme)) savedTheme = 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
        document.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-theme') === savedTheme);
        });
        const defaultAccent = savedTheme === 'light' ? '#1a1a1a' : '#ffffff';
        const effectiveAccent = settings.accentColor || defaultAccent;
        if (accentColorInput) accentColorInput.value = effectiveAccent;
        if (accentColorValueEl) accentColorValueEl.textContent = effectiveAccent;
        const colorPreviewDot = document.getElementById('color-preview-dot');
        if (colorPreviewDot) colorPreviewDot.style.background = effectiveAccent;
        if (settings.accentColor && settings.accentColor !== defaultAccent) {
            applyAccentColor(settings.accentColor);
        }
    } catch (e) { console.error('[Settings] Failed to load settings:', e); }
}

function updateSpeedLimitLabel(value) {
    const el = document.getElementById('speed-limit-value');
    if (el) {
        el.textContent = value === 0 ? '无限制' : value + ' MB/s';
    }
}

async function saveCurrentSettings() {
    const g = (id) => document.getElementById(id);
    const settings = {
        javaPath: g('setting-java-path')?.value || '',
        maxMemory: parseInt(g('setting-max-memory')?.value || '2048', 10),
        minMemory: parseInt(g('setting-min-memory')?.value || '256', 10),
        gameDir: g('setting-game-dir')?.value || '',
        versionIsolation: g('setting-version-isolation')?.checked || false,
        fullscreen: g('setting-fullscreen')?.checked || false,
        resolution: g('setting-resolution')?.value || '',
        javaArgs: g('setting-java-args')?.value || '',
        closeOnLaunch: g('setting-close-on-launch')?.checked || false,
        autoUpdate: g('setting-auto-update')?.checked || false,

        downloadSource: g('setting-download-source')?.value || 'mojang',
        versionSource: g('setting-version-source')?.value || 'mojang',
        maxThreads: parseInt(g('setting-max-threads')?.value || '4', 10),
        enableChunkDownload: g('setting-enable-chunk-download') ? g('setting-enable-chunk-download').checked : true,
        maxChunksPerFile: g('setting-max-chunks-per-file') ? parseInt(g('setting-max-chunks-per-file').value, 10) : 8,
        speedLimit: parseInt(g('setting-speed-limit')?.value || '0', 10),
        targetDir: g('setting-target-dir')?.value || '',
        sslVerify: g('setting-ssl-verify')?.checked || false,

        modSource: g('setting-mod-source')?.value || 'modrinth',
        filenameFormat: g('setting-filename-format')?.value || '',
        modStyle: g('setting-mod-style')?.value || '',
        ignoreQuilt: g('setting-ignore-quilt')?.checked || false,

        accentColor: g('custom-accent-color')?.value || '#ffffff'
    };
    try {
        await API.saveSettings(settings);
        showToast('设置已保存', 'success');
    } catch (e) {
        showToast('保存设置失败', 'error');
    }
}

let versionsLoadFailed = false;
let versionsRetryTimer = null;

// ============================================================================
// 版本列表管理 - 加载、筛选、渲染游戏版本列表
// ============================================================================
async function loadVersions(forceRefresh = false) {
    try {
        const data = await API.getVersions(forceRefresh);
        allVersions = data.versions || [];
        installedVersions = data.installed || [];
        if (!Array.isArray(allVersions)) allVersions = [];
        if (!Array.isArray(installedVersions)) installedVersions = [];
        versionIconsTimestamp = Date.now();
        versionsLoadFailed = false;

        updateVersionSelects();
        renderVersions();
        updateHomeStats();
        populateModVersionFilter();
    } catch (e) {
        console.error('[Versions] Load failed:', e.message);
        versionsLoadFailed = true;
        
        const container = document.getElementById('versions-list');
        if (container && installedVersions.length > 0) {
            currentVersionTab = 'installed';
            renderVersions();
            const tabs = document.querySelectorAll('.tab-btn[data-tab]');
            tabs.forEach(t => t.classList.remove('active'));
            const installedTab = document.querySelector('.tab-btn[data-tab="installed"]');
            if (installedTab) installedTab.classList.add('active');
        } else if (container) {
            container.innerHTML = `
                <p class="empty-text">加载版本列表失败</p>
                <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="retryLoadVersions()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px">
                        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                    </svg> 重试
                </button>`;
        }
        populateModVersionFilter();

        if (!forceRefresh && !versionsRetryTimer) {
            versionsRetryTimer = setTimeout(() => {
                versionsRetryTimer = null;
                if (versionsLoadFailed) {
                    console.log('[Versions] Auto-retrying...');
                    loadVersions(false);
                }
            }, 30000);
        }
    }
}

function retryLoadVersions() {
    if (versionsRetryTimer) clearTimeout(versionsRetryTimer);
    versionsRetryTimer = null;
    const container = document.getElementById('versions-list');
    if (container) {
        container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>正在重新加载...</p></div>`;
    }
    loadVersions(true);
}

// ============================================================================
// 版本选择器 - 自定义下拉选择框的选项填充
// ============================================================================
function updateVersionSelects() {
    if (!launchVersionCustomSelect && !document.getElementById('home-version-select-wrapper')) return;
    const currentVal = launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '';

    const versionOptions = installedVersions.map(v => {
        let text = v.isExternal ? v.id.replace(' [外部]', '') : v.id;
        let subtext = '';
        if (v.isModpack) { text += ` [${v.modpackLoader || '整合包'}]`; subtext = v.modpackLoader || '整合包'; }
        else if (v.isFabric) { text += ' [Fabric]'; subtext = 'Fabric Loader'; }
        else if (v.isForge) { text += ' [Forge]'; subtext = 'Forge'; }
        else if (v.isNeoForge) { text += ' [NeoForge]'; subtext = 'NeoForge'; }
        else { subtext = 'Vanilla'; }
        if (v.isExternal) { subtext += ' · 外部文件夹'; }
        return { value: v.id, text: text, subtext: subtext };
    });

    if (launchVersionCustomSelect) {
        launchVersionCustomSelect.setOptions(versionOptions);
        if (currentVal && versionOptions.find(o => o.value === currentVal)) {
            launchVersionCustomSelect.setValue(currentVal);
        }
    }

    if (!homeVersionCustomSelect) {
        homeVersionCustomSelect = new CustomSelect('home-version-select-wrapper', {
            onChange: (value) => {
                if (launchVersionCustomSelect) launchVersionCustomSelect.setValue(value);
                loadPlayTimeDisplay(value);
            }
        });
    }
    homeVersionCustomSelect.setOptions(versionOptions);
    if (currentVal && versionOptions.find(o => o.value === currentVal)) {
        homeVersionCustomSelect.setValue(currentVal);
    }

    const homeList = document.getElementById('home-installed-list');
    if (installedVersions.length === 0) {
        homeList.innerHTML = '<p class="empty-text">暂无已安装的版本</p>';
    } else {
        homeList.innerHTML = installedVersions.map(v => {
            let badge = '原版', badgeClass = '';
            const iconParams = `id=${encodeURIComponent(v.id)}&type=release`;
            const forgeParam = v.isForge ? '&forge=true' : '';
            const fabricParam = v.isFabric ? '&fabric=true' : '';
            const neoforgeParam = v.isNeoForge ? '&neoforge=true' : '';
            const modpackParam = v.isModpack ? '&modpack=true' : '';
            const iconUrl = `/api/version-icon?${iconParams}${forgeParam}${fabricParam}${neoforgeParam}${modpackParam}&_t=${versionIconsTimestamp}`;
            if (v.isModpack) { badge = v.modpackLoader || '整合包'; badgeClass = 'modpack'; }
            else if (v.isFabric) { badge = 'Fabric'; badgeClass = 'fabric'; }
            else if (v.isForge) { badge = 'Forge'; badgeClass = 'forge'; }
            else if (v.isNeoForge) { badge = 'NeoForge'; badgeClass = 'forge'; }
            const externalBadge = v.isExternal ? '<span class="v-badge external" style="background:rgba(255,165,0,0.15);color:#ffa500;font-size:10px;margin-left:4px">外部</span>' : '';
            const displayName = v.isExternal ? (v.customName || v.id.replace(' [外部]', '')) : (v.customName || v.id);
            return `<div class="version-item" style="cursor:pointer" onclick="openVersionSettings('${escapeOnclick(v.id)}','${escapeOnclick(displayName)}')">
                <div class="version-item-left">
                    <div class="version-item-icon"><img src="${iconUrl}" alt="" class="version-icon-img"></div>
                    <div class="version-item-info">
                        <span class="version-item-name">${escapeHtml(displayName)}</span>
                        <span class="version-item-meta"><span class="v-badge ${badgeClass}">${badge}</span>${externalBadge}</span>
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

// ============================================================================
// 版本列表渲染 - 将版本数据渲染为DOM卡片列表
// ============================================================================
function renderVersions() {
    const container = document.getElementById('versions-list');
    if (!container) return;
    let versions;

    if (currentVersionTab === 'installed') {
        versions = installedVersions;
    } else {
        versions = allVersions.filter(v => v.type === currentVersionTab);
    }

    if (versions.length === 0) {
        container.innerHTML = '<p class="empty-text">暂无版本</p>';
        return;
    }

    container.innerHTML = versions.map(v => {
        const isInInstalledTab = currentVersionTab === 'installed';
        const iconClass = v.type === 'snapshot' || v.type === 'old_alpha' || v.type === 'old_beta' ? (v.type === 'snapshot' ? 'snapshot' : 'old') : (isInInstalledTab ? 'installed' : 'release');
        const iconParams = `id=${encodeURIComponent(v.id)}&type=${v.type || 'release'}`;
        const forgeParam = v.isForge ? '&forge=true' : '';
        const fabricParam = v.isFabric ? '&fabric=true' : '';
        const neoforgeParam = v.isNeoForge ? '&neoforge=true' : '';
        const modpackParam = v.isModpack ? '&modpack=true' : '';
        const iconUrl = `/api/version-icon?${iconParams}${forgeParam}${fabricParam}${neoforgeParam}${modpackParam}&_t=${versionIconsTimestamp}`;

        if (isInInstalledTab) {
            const externalBadgeHtml = v.isExternal ? '<span style="display:inline-block;background:rgba(255,165,0,0.15);color:#ffa500;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px">外部文件夹</span>' : '';
            const externalPathHtml = v.isExternal && v.externalPath ? `<span style="color:var(--text-muted);font-size:11px;margin-left:4px" title="${escapeHtml(v.externalPath)}">📁 ${escapeHtml(v.externalPath)}</span>` : '';
            const displayName = v.isExternal ? (v.customName || v.id.replace(' [外部]', '')) : (v.customName || v.id);
            const deleteBtnHtml = v.isExternal ? '' : `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteVersion('${escapeOnclick(v.id)}')">删除</button>`;
            return `<div class="version-item version-item-clickable" 
                data-version-id="${escapeHtml(v.id)}" 
                data-version-url="" 
                data-version-type="${v.type || 'release'}"
                data-installed="true"
                data-custom-name="${escapeHtml(v.customName || '')}">
                <div class="version-item-left">
                    <div class="version-item-icon ${iconClass}">
                        <img src="${iconUrl}" alt="" class="version-icon-img">
                    </div>
                    <div class="version-item-info">
                        <span class="version-item-name">${displayName}${externalBadgeHtml}</span>
                        <span class="version-item-meta">${getVersionTypeLabel(v)} \u00B7 ${formatDate(v.releaseTime)}${externalPathHtml}</span>
                    </div>
                </div>
                <div class="version-item-actions">
                    <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openVersionSettings('${escapeOnclick(v.id)}','${escapeOnclick(displayName)}')">设置</button>
                    ${deleteBtnHtml}
                </div>
            </div>`;
        } else {
            return `<div class="version-item version-item-clickable" 
                data-version-id="${escapeHtml(v.id)}" 
                data-version-url="${escapeHtml(v.url || '')}" 
                data-version-type="${escapeHtml(v.type || 'release')}">
                <div class="version-item-left">
                    <div class="version-item-icon ${iconClass}">
                        <img src="${iconUrl}" alt="" class="version-icon-img">
                    </div>
                    <div class="version-item-info">
                        <span class="version-item-name">${v.id}</span>
                        <span class="version-item-meta">${getVersionTypeLabel(v)} \u00B7 ${formatDate(v.releaseTime)}</span>
                    </div>
                </div>
                <div class="version-item-actions">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;opacity:0.5"><path d="M9 18l6-6-6-6"/></svg>
                </div>
            </div>`;
        }
    }).join('');
}

let currentVersionDetail = null;
let selectedLoaderType = '';
let selectedLoaderVersion = '';
const AVATAR_CACHE_VERSION = 9;

let _pageTransitionLock = false;
let _pendingPageTransition = null;

function navigateToPage(pageName) {
    if (_pageTransitionLock) {
        _pendingPageTransition = pageName;
        return;
    }

    console.log('[Navigate] Going to page:', pageName);
    const currentPage = document.querySelector('.page.active');
    const target = document.getElementById(`page-${pageName}`);
    if (!target) {
        console.error('[Navigate] Page not found:', pageName);
        return;
    }
    
    if (currentPage && currentPage === target) {
        target.scrollTop = 0;
        return;
    }

    if (currentPage && currentPage.id === 'page-explore' && pageName !== 'explore') {
        try {
            if (typeof AIChat !== 'undefined' && AIChat && AIChat.isGenerating) {
                AIChat.stopGenerationForce();
            }
        } catch (e) {}
    }
    
    const isDetailPage = pageName === 'version-detail' || pageName === 'mod-detail' || pageName === 'version-settings';
    
    if (isDetailPage && currentPage && currentPage.id.startsWith('page-')) {
        const currentPageName = currentPage.id.replace('page-', '');
        const detailPages = ['version-detail', 'mod-detail', 'version-settings'];
        if (!detailPages.includes(currentPageName)) {
            previousPage = currentPageName;
        }
    }
    
    if (currentPage && currentPage !== target) {
        if (currentPage.id === 'page-version-settings') {
            document.querySelector('.content-area')?.classList.remove('no-scroll');
        }
        _pageTransitionLock = true;
        console.log(`[PERF-NAV] transition start: ${currentPage.id} → page-${pageName}`);
        const _navT0 = performance.now();
        currentPage.style.animation = 'pageOut 0.12s var(--ease-out-expo) forwards';
        setTimeout(() => {
            currentPage.classList.remove('active');
            currentPage.style.animation = '';
            target.classList.add('active');
            target.scrollTop = 0;
            target.style.animation = 'pageIn 0.35s var(--ease-out-expo) both';
            console.log(`[PERF-NAV] page swap ${(performance.now()-_navT0).toFixed(1)}ms`);
            setTimeout(() => {
                _pageTransitionLock = false;
                if (_pendingPageTransition && _pendingPageTransition !== pageName) {
                    const pending = _pendingPageTransition;
                    _pendingPageTransition = null;
                    navigateToPage(pending);
                } else {
                    _pendingPageTransition = null;
                }
            }, 50);
        }, 100);
    } else if (!currentPage) {
        target.classList.add('active');
        target.scrollTop = 0;
        target.style.animation = 'pageIn 0.35s var(--ease-out-expo) both';
    }
    
    if (isDetailPage) {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const backPage = previousPage || 'mods';
        const navBtn = document.querySelector(`.nav-btn[data-page="${backPage}"]`);
        if (navBtn) {
            navBtn.classList.add('active');
        } else {
            const subBtn = document.querySelector(`.nav-sub-btn[data-page="${backPage}"]`);
            if (subBtn) {
                subBtn.classList.add('active');
            }
        }
    } else {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.nav-sub-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.nav-submenu-group').forEach(g => g.classList.remove('open'));
        document.querySelectorAll('.nav-submenu-toggle').forEach(t => t.classList.remove('active'));
        const navBtn = document.querySelector(`.nav-btn[data-page="${pageName}"]`);
        if (navBtn) {
            navBtn.classList.add('active');
        } else {
            const subBtn = document.querySelector(`.nav-sub-btn[data-page="${pageName}"]`);
            if (subBtn) {
                subBtn.classList.add('active');
                const parentGroup = subBtn.closest('.nav-submenu-group');
                if (parentGroup) {
                    parentGroup.classList.add('open');
                    const toggle = parentGroup.querySelector('.nav-submenu-toggle');
                    if (toggle) toggle.classList.add('active');
                }
            }
        }
    }

    if (pageName === 'modpacks') {
        const activeTab = document.querySelector('#page-modpacks .tab-btn.active');
        if (activeTab && activeTab.dataset.tab === 'installed-modpacks') {
            setTimeout(() => loadInstalledModpacks(), 100);
        } else {
            setTimeout(() => loadResourcePage('modpack'), 100);
        }
    } else if (pageName === 'settings-other') {
        setTimeout(() => refreshMemoryInfo(), 200);
    } else if (pageName === 'datapacks') {
        setTimeout(() => loadResourcePage('datapack'), 100);
    } else if (pageName === 'resourcepacks') {
        setTimeout(() => loadResourcePage('resourcepack'), 100);
    } else if (pageName === 'shaders') {
        setTimeout(() => loadResourcePage('shader'), 100);
    } else if (pageName === 'mods' && modMultiSelectMode) {
        setTimeout(() => {
            document.getElementById('mod-multiselect-bar').style.display = 'flex';
            document.getElementById('mod-multiselect-toggle').classList.add('btn-primary');
            document.getElementById('mod-multiselect-toggle').classList.remove('btn-secondary');
            updateModSelectUI();
            loadMods();
        }, 200);
    } else if (pageName === 'downloads') {
        dlManager.render();
    }
}

function goBackFromDetail() {
    const backPage = previousPage || 'mods';
    navigateToPage(backPage);
}

function openVersionDetail(versionId, versionUrl, versionType) {
    currentVersionDetail = { id: versionId, url: versionUrl, type: versionType };
    
    navigateToPage('version-detail');
    
    const iconParams = `id=${encodeURIComponent(versionId)}&type=${versionType}`;
    document.getElementById('verdetail-icon').src = `/api/version-icon?${iconParams}&_t=${versionIconsTimestamp}`;
    document.getElementById('verdetail-name').textContent = versionId;
    const typeLabels = { release: '正式版', snapshot: '快照版', old_beta: '旧测试版', old_alpha: '旧内测版' };
    document.getElementById('verdetail-meta').textContent = typeLabels[versionType] || versionType || '正式版';
    
    document.querySelector('input[name="download-source"][value="mojang"]').checked = true;
    
    selectedLoaderType = '';
    selectedLoaderVersion = '';
    document.querySelectorAll('.loader-card').forEach(item => item.classList.remove('selected'));
    document.querySelector('.loader-card[data-loader=""]').classList.add('selected');
    document.getElementById('loader-version-section').style.display = 'none';
    document.getElementById('loader-version-list').innerHTML = '';
    
    loadLoaderVersions(versionId);
}

async function loadLoaderVersions(versionId) {
    const loaders = ['forge', 'neoforge', 'fabric', 'optifine'];
    for (const loader of loaders) {
        try {
            const versions = await API.getModLoaderVersions(versionId, loader);
            const descEl = document.getElementById(`loader-desc-${loader}`);
            if (versions && versions.length > 0) {
                const latestVer = versions[0].version || versions[0].id || versions[0] || '最新';
                const loaderNames = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', optifine: 'OptiFine' };
                descEl.textContent = `${loaderNames[loader]} ${latestVer} 可用`;
            } else {
                descEl.textContent = loader === 'optifine' ? '暂不支持此版本' : '暂无可用版本';
            }
        } catch (e) {
            const descEl = document.getElementById(`loader-desc-${loader}`);
            if (descEl) descEl.textContent = '加载失败';
        }
    }
}

function selectLoaderCard(loaderType) {
    selectedLoaderType = loaderType;
    
    document.querySelectorAll('.loader-card').forEach(item => item.classList.remove('selected'));
    document.querySelector(`.loader-card[data-loader="${loaderType}"]`).classList.add('selected');
    
    if (loaderType) {
        populateLoaderVersionSelect(loaderType);
    } else {
        document.getElementById('loader-version-section').style.display = 'none';
        selectedLoaderVersion = '';
    }
}

async function populateLoaderVersionSelect(loaderType) {
    const listContainer = document.getElementById('loader-version-list');
    const section = document.getElementById('loader-version-section');

    section.style.display = 'block';
    listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">加载中...</p>';

    const loaderIcons = {
        forge: 'CommandBlock.png',
        neoforge: 'NeoForge.png',
        fabric: 'Fabric.png',
        optifine: 'OptiFabric.png'
    };
    const iconFile = loaderIcons[loaderType] || 'Grass.png';

    try {
        const versions = await API.getModLoaderVersions(currentVersionDetail.id, loaderType);
        
        if (versions && versions.length > 0) {
            const loaderNames = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', optifine: 'OptiFine' };
            const loaderName = loaderNames[loaderType] || loaderType;

            listContainer.innerHTML = versions.map((v, i) => {
                const verStr = v.version || v.id || v;
                const verType = v.type || (i === 0 ? '推荐' : '');
                return `<div class="lver-item ${i === 0 ? 'selected' : ''}" data-version="${escapeHtml(verStr)}" onclick="selectLoaderVersion('${escapeOnclick(verStr)}')">
                    <div class="lver-icon"><img src="img/${iconFile}" alt="" style="width:24px;height:24px;image-rendering:pixelated"></div>
                    <div class="lver-info">
                        <div class="lver-name">${loaderName} ${escapeHtml(verStr)}</div>
                        <div class="lver-meta">${verType ? '<span class="lver-badge">' + escapeHtml(verType) + '</span>' : ''}</div>
                    </div>
                    <div class="lver-check">✓</div>
                </div>`;
            }).join('');

            selectedLoaderVersion = versions[0].version || versions[0].id || versions[0];
        } else {
            listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">暂无可用版本</p>';
            selectedLoaderVersion = '';
        }
    } catch (e) {
        console.error('Loader version load error:', e);
        listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">加载失败</p>';
        selectedLoaderVersion = '';
    }
}

function selectLoaderVersion(version) {
    selectedLoaderVersion = version;
    document.querySelectorAll('.lver-item').forEach(item => item.classList.remove('selected'));
    document.querySelector(`.lver-item[data-version="${version}"]`)?.classList.add('selected');
}

function confirmInstallVersion() {
    if (!currentVersionDetail) return;
    
    const downloadSource = document.querySelector('input[name="download-source"]:checked');
    const source = downloadSource ? downloadSource.value : 'mojang';
    
    let loaderInfo = null;
    if (selectedLoaderType) {
        loaderInfo = {
            type: selectedLoaderType,
            version: selectedLoaderVersion
        };
    }
    
    navigateToPage('versions');
    
    setTimeout(() => {
        installVersionWithLoader(currentVersionDetail.url, currentVersionDetail.id, loaderInfo, source);
    }, 200);
}

async function installVersionWithLoader(versionUrl, versionId, loaderInfo, downloadSource) {
    try {
        const result = await API.installVersion(versionUrl, versionId, loaderInfo, downloadSource);
        if (result.success) {
            currentInstallSessionId = result.sessionId;
            showInstallModal(versionId);
            pollInstallProgress(result.sessionId);
        } else {
            showToast(result.error || '安装失败', 'error');
        }
    } catch (e) {
        showToast('安装请求失败', 'error');
    }
}

async function installVersion(versionUrl, versionId) {
    try {
        const result = await API.installVersion(versionUrl, versionId);
        if (result.success) {
            currentInstallSessionId = result.sessionId;
            showInstallModal(versionId);
            pollInstallProgress(result.sessionId);
        } else {
            showToast(result.error || '安装失败', 'error');
        }
    } catch (e) {
        showToast('安装请求失败', 'error');
    }
}

function showInstallModal(versionId) {
    const taskId = 'version-' + currentInstallSessionId;
    dlManager.add(taskId, `安装 ${versionId}`, 'version', currentInstallSessionId,
        versionId ? `/api/version-icon?id=${encodeURIComponent(versionId)}&type=release` : '');
    navigateToPage('downloads');
}

function closeInstallModal() {
    if (currentInstallSessionId) {
        API.cancelInstall(currentInstallSessionId);
        currentInstallSessionId = null;
    }
}

function cancelInstall() {
    closeInstallModal();
    showToast('安装已取消', 'info');
}

async function pollInstallProgress(sessionId) {
    const taskId = 'version-' + sessionId;

    const poll = async () => {
        try {
            if (!dlManager.tasks.has(taskId)) return;
            const data = await API.getInstallProgress(sessionId);
            if (!data || !data.sessionId) return;

            const downloadStatus = data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'failed' : data.status === 'cancelled' ? 'failed' : 'downloading';
            const statusMessage = getStageText(data.stage) || data.message || '安装中...';

            var files = [];
            if (data.currentFile) {
                var speedText = data.speed ? formatBytes(data.speed) + '/s' : '';
                files.push({
                    name: '当前文件: ' + data.currentFile,
                    progress: downloadStatus === 'completed' ? 100 : (data.totalFiles ? Math.round(data.completedFiles / data.totalFiles * 100) : data.progress || 0),
                    status: downloadStatus,
                    size: speedText
                });
            }
            if (data.totalFiles > 0) {
                files.push({
                    name: '文件进度: ' + data.completedFiles + ' / ' + data.totalFiles,
                    progress: Math.round(data.completedFiles / data.totalFiles * 100),
                    status: downloadStatus
                });
            }
            if (data.bytesDownloaded > 0 || data.totalBytes > 0) {
                var dlText = formatBytes(data.bytesDownloaded || 0);
                if (data.totalBytes) dlText += ' / ' + formatBytes(data.totalBytes);
                files.push({
                    name: '下载量: ' + dlText,
                    progress: data.totalBytes ? Math.round(data.bytesDownloaded / data.totalBytes * 100) : 0,
                    status: downloadStatus
                });
            }
            if (data.stage) {
                files.push({
                    name: '当前阶段: ' + (getStageText(data.stage) || data.stage),
                    progress: downloadStatus === 'completed' ? 100 : 0,
                    status: data.stage === 'completed' ? 'completed' : downloadStatus
                });
            }

            dlManager.update(taskId, {
                progress: data.progress || 0,
                status: downloadStatus,
                message: statusMessage,
                files: files
            });

            if (data.status === 'completed') {
                showToast(data.versionId + ' 安装完成！', 'success');
                currentInstallSessionId = null;
                await loadVersions();
                return;
            }
            if (data.status === 'failed') {
                showToast('安装失败: ' + (data.message || '未知错误'), 'error');
                currentInstallSessionId = null;
                return;
            }
            if (data.status === 'cancelled') { currentInstallSessionId = null; return; }
            setTimeout(poll, 500);
        } catch (e) {
            if (dlManager.tasks.has(taskId)) setTimeout(poll, 1000);
        }
    };
    poll();
}

function getStageText(stage) {
    const map = {
        'preparing': '准备中...',
        'version_json': '下载版本信息...',
        'client_jar': '下载游戏客户端...',
        'libraries': '下载依赖库...',
        'assets': '下载资源文件...',
        'natives': '提取原生库...',
        'finalizing': '完成安装...',
        'loader': '安装模组加载器...',
        'completed': '安装完成',
        'failed': '安装失败',
        'cancelled': '已取消'
    };
    return map[stage] || stage || '';
}

async function deleteVersion(versionId) {
    if (versionId.includes('[外部]')) {
        showToast('外部文件夹版本请通过管理外部文件夹移除', 'error');
        return;
    }
    const confirmed = await showConfirmDialog('删除版本', `确定要删除版本 ${versionId} 吗？`, '删除', '取消');
    if (!confirmed) return;
    try {
        await API.deleteVersion(versionId);
        showToast(`版本 ${versionId} 已删除`, 'success');
        await loadVersions();
    } catch (e) { showToast('删除失败', 'error'); }
}

let pendingExternalFolderPath = '';

async function addExternalFolder() {
    document.getElementById('external-folder-path').value = '';
    document.getElementById('external-folder-name').value = '';
    document.getElementById('external-folder-preview').style.display = 'none';
    document.getElementById('external-folder-error').style.display = 'none';
    document.getElementById('external-folder-confirm-btn').disabled = true;
    pendingExternalFolderPath = '';
    showModal('external-folder-modal');
}

function closeExternalFolderModal() {
    hideModal('external-folder-modal');
    pendingExternalFolderPath = '';
}

async function selectExternalFolderPath() {
    try {
        const result = await API.selectExternalFolder();
        if (result.success && result.path) {
            document.getElementById('external-folder-path').value = result.path;
            pendingExternalFolderPath = result.path;
            document.getElementById('external-folder-error').style.display = 'none';
            document.getElementById('external-folder-confirm-btn').disabled = false;
        }
    } catch (e) {
        console.error('Select external folder error:', e);
    }
}

async function confirmAddExternalFolder() {
    const folderPath = document.getElementById('external-folder-path').value || pendingExternalFolderPath;
    const folderName = document.getElementById('external-folder-name').value.trim();
    if (!folderPath) {
        showToast('请先选择文件夹', 'error');
        return;
    }
    const confirmBtn = document.getElementById('external-folder-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '添加中...';
    try {
        const result = await API.addExternalFolder(folderPath, folderName);
        if (result.success) {
            showToast(`已添加文件夹，发现 ${result.versions.length} 个版本`, 'success');
            if (result.versions && result.versions.length > 0) {
                const listHtml = result.versions.map(v => {
                    let typeLabel = '原版';
                    if (v.isFabric) typeLabel = 'Fabric';
                    else if (v.isForge) typeLabel = 'Forge';
                    else if (v.isNeoForge) typeLabel = 'NeoForge';
                    return `<div style="padding:4px 0;display:flex;align-items:center;gap:8px"><span style="color:var(--text-primary)">${v.id}</span><span style="color:var(--text-muted);font-size:12px;padding:2px 6px;border-radius:4px;background:var(--bg-tertiary)">${typeLabel}</span></div>`;
                }).join('');
                document.getElementById('external-folder-versions-list').innerHTML = listHtml;
                document.getElementById('external-folder-preview').style.display = 'block';
            }
            setTimeout(() => {
                closeExternalFolderModal();
                loadVersions();
            }, 1500);
        } else {
            document.getElementById('external-folder-error').textContent = result.error || '添加失败';
            document.getElementById('external-folder-error').style.display = 'block';
        }
    } catch (e) {
        document.getElementById('external-folder-error').textContent = '添加失败: ' + e.message;
        document.getElementById('external-folder-error').style.display = 'block';
    } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '添加';
    }
}

function openModLoaderModal(gameVersion) {
    showModal('modloader-modal');

    if (!modloaderGameVersionCustomSelect) {
        modloaderGameVersionCustomSelect = new CustomSelect('modloader-game-version-wrapper', {
            onChange: () => loadModLoaderVersions()
        });
    }

    const installedBase = installedVersions.filter(v => !v.isFabric && !v.isForge && !v.isNeoForge);
    const versions = installedBase.length > 0 ? installedBase : allVersions.filter(v => v.type === 'release').slice(0, 20);

    const options = versions.map(v => ({
        value: v.id,
        text: v.id
    }));

    modloaderGameVersionCustomSelect.setOptions(options);

    if (gameVersion && options.find(o => o.value === gameVersion)) {
        modloaderGameVersionCustomSelect.setValue(gameVersion);
    }

    loadModLoaderVersions();
    document.getElementById('modloader-install-btn').onclick = installModLoader;
}

function closeModLoaderModal() {
    hideModal('modloader-modal');
}

async function loadModLoaderVersions() {
    const gameVersion = modloaderGameVersionCustomSelect ? modloaderGameVersionCustomSelect.getValue() : '';

    if (!modloaderVersionCustomSelect) {
        modloaderVersionCustomSelect = new CustomSelect('modloader-version-wrapper');
    }

    modloaderVersionCustomSelect.setOptions([{ value: '', text: '加载中...' }]);
    try {
        if (currentLoaderType === 'fabric') {
            const data = await API.getFabricVersions(gameVersion);
            const versions = data.versions || [];
            const options = versions.map(v => ({
                value: v.version,
                text: `${v.version} ${v.stable ? '(稳定)' : ''}`
            }));
            modloaderVersionCustomSelect.setOptions(options);
            const stable = versions.find(v => v.stable);
            if (stable) modloaderVersionCustomSelect.setValue(stable.version);
        } else if (currentLoaderType === 'forge') {
            const data = await API.getForgeVersions(gameVersion);
            const versions = data.versions || [];
            const options = versions.map(v => ({
                value: v.version,
                text: `${v.version} (${v.type})`
            }));
            modloaderVersionCustomSelect.setOptions(options);
        } else if (currentLoaderType === 'neoforge') {
            const versions = await API.getModLoaderVersions(gameVersion, 'neoforge');
            const options = versions.map(v => ({
                value: v.version,
                text: `${v.version} ${v.type ? '(' + v.type + ')' : ''}`
            }));
            modloaderVersionCustomSelect.setOptions(options);
            if (versions.length > 0) modloaderVersionCustomSelect.setValue(versions[0].version);
        }
    } catch (e) { modloaderVersionCustomSelect.setOptions([{ value: '', text: '加载失败' }]); }
}

async function installModLoader() {
    const gameVersion = modloaderGameVersionCustomSelect ? modloaderGameVersionCustomSelect.getValue() : '';
    const loaderVersion = modloaderVersionCustomSelect ? modloaderVersionCustomSelect.getValue() : '';
    if (!gameVersion) { showToast('请选择游戏版本', 'error'); return; }
    try {
        let result;
        const loaderNames = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
        if (currentLoaderType === 'fabric') {
            result = await API.installFabric(gameVersion, loaderVersion);
        } else if (currentLoaderType === 'forge') {
            if (!loaderVersion) { showToast('请选择Forge版本', 'error'); return; }
            result = await API.installForge(gameVersion, loaderVersion);
        } else if (currentLoaderType === 'neoforge') {
            if (!loaderVersion) { showToast('请选择NeoForge版本', 'error'); return; }
            result = await API.installNeoForge(gameVersion, loaderVersion);
        } else {
            showToast('不支持的加载器类型', 'error');
            return;
        }
        if (result.success) {
            showToast(`${loaderNames[currentLoaderType] || currentLoaderType} 安装成功！`, 'success');
            closeModLoaderModal();
            await loadVersions();
        } else {
            showToast(result.error || '安装失败', 'error');
        }
    } catch (e) { showToast('安装失败', 'error'); }
}

async function loadInstalledMods() {
    try {
        const result = await API.getInstalledMods();
        const mods = Array.isArray(result) ? result : (result.mods || []);
        const warnings = Array.isArray(result) ? [] : (result.warnings || []);
        const container = document.getElementById('installed-mods-list');
        if (!container) return;
        if (mods.length === 0) {
            container.innerHTML = '<p class="empty-text">暂无已安装的模组</p>';
        } else {
            let warningHtml = '';
            if (warnings.length > 0) {
                warningHtml = warnings.map(w =>
                    `<div class="mod-warning ${w.type === 'conflict' ? 'warning-conflict' : 'warning-duplicate'}">
                        <span class="warning-icon">${w.type === 'conflict' ? '⚠️' : '🔄'}</span>
                        <span>${escapeHtml(w.message)}</span>
                    </div>`
                ).join('');
            }
            container.innerHTML = warningHtml + mods.map(function (mod) {
                return '<div class="mod-item">' +
                    '<div class="mod-icon"><img src="' + (mod.icon || '') + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'mod-icon--fallback\')"></div>' +
                    '<div class="mod-info">' +
                        '<div class="mod-name">' + escapeHtml(formatModNameWithChinese(mod.id || mod.fileName, mod.name)) + '</div>' +
                        '<div class="mod-desc">' + escapeHtml(mod.description) + '</div>' +
                        '<div class="mod-meta">' +
                            '<span>' + mod.size + '</span>' +
                            '<span>' + (mod.enabled ? '已启用' : '已禁用') + '</span>' +
                            (mod.author ? '<span>' + escapeHtml(mod.author) + '</span>' : '') +
                            (mod.version && mod.version !== '1.0' ? '<span>v' + escapeHtml(mod.version) + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="mod-actions">' +
                        '<button class="btn btn-sm ' + (mod.enabled ? 'btn-secondary' : 'btn-primary') + '" onclick="toggleMod(\'' + escapeOnclick(mod.fileName || mod.id) + '\', ' + (!mod.enabled) + ')">' + (mod.enabled ? '禁用' : '启用') + '</button>' +
                        '<button class="btn btn-danger btn-sm" onclick="deleteMod(\'' + escapeOnclick(mod.fileName || mod.id) + '\')">删除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
        document.getElementById('stat-mods').textContent = mods.length;
    } catch (e) { console.error('[Mods] Failed to load installed mods:', e); }
}

const MODRINTH_CATEGORY_ZH = {
    'adventure': '冒险', 'cursed': '诅咒', 'decoration': '装饰', 'equipment': '装备',
    'food': '食物', 'library': '前置库', 'magic': '魔法', 'optimization': '优化',
    'storage': '存储', 'technology': '科技', 'transportation': '交通', 'utility': '实用',
    'world-gen': '世界生成', 'game-mechanics': '游戏机制', 'social': '社交',
    'automation': '自动化', 'biomes': '生物群系', 'blocks': '方块', 'bosses': 'Boss',
    'building': '建筑', 'chat': '聊天', 'combat': '战斗', 'dimensions': '维度',
    'economy': '经济', 'entities': '实体', 'environment': '环境', 'farming': '农业',
    'hud': 'HUD', 'items': '物品', 'management': '管理', 'map': '地图',
    'minigame': '小游戏', 'mobs': '生物', 'modded': '模组化', 'models': '模型',
    'multimedia': '多媒体', 'performance': '性能', 'quests': '任务', 'redstone': '红石',
    'resource-pack': '资源包', 'server': '服务器', 'skin': '皮肤', 'sound': '声音',
    'structures': '结构', 'tweaks': '调整', 'vanilla-like': '原版风格',
    '8x-': '8x-', '16x': '16x', '32x': '32x', '64x': '64x', '128x': '128x',
    '256x': '256x', '512x+': '512x+', 'animation': '动画', 'core-shaders': '核心着色器',
    'compatibility': '兼容性', 'cartoon': '卡通', 'fantasy': '奇幻', 'medieval': '中世纪',
    'modern': '现代', 'photo-realistic': '写实', 'semi-realistic': '半写实',
    'simplistic': '简约', 'traditional': '传统', 'pbr': 'PBR', 'colored-lighting': '彩色光照',
    'path-tracing': '光线追踪', 'reflections': '反射', 'shadows': '阴影',
    'volumetric-light': '体积光', 'datapack': '数据包'
};

async function loadModFilterOptions() {
    try {
        const data = await API.getModCategories();
        const categories = data.categories || [];
        const options = [
            { value: '', text: '全部' },
            ...categories.map(cat => ({ value: cat.name, text: MODRINTH_CATEGORY_ZH[cat.name] || cat.name }))
        ];
        updateCustomSelectOptions('mod-filter-category', options);
    } catch (e) { console.error('[Mods] Failed to load filter options:', e); }
}

function populateModVersionFilter() {
    const versionOptions = [
        { value: '', text: '全部' },
        ...allVersions.filter(v => v.type === 'release').slice(0, 30).map(v => ({
            value: v.id,
            text: v.id
        }))
    ];

    const currentVal = getCustomSelectValue('mod-filter-version');
    updateCustomSelectOptions('mod-filter-version', versionOptions);
    if (currentVal) {
        setCustomSelectValue('mod-filter-version', currentVal);
    }

    updateCustomSelectOptions('modpack-filter-version', versionOptions);
    updateCustomSelectOptions('datapack-filter-version', versionOptions);
    updateCustomSelectOptions('resourcepack-filter-version', versionOptions);
}

async function loadMods() {
    const container = document.getElementById('mod-browse-list');
    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>加载中...</p></div>';

    const title = document.getElementById('mod-browse-title');
    title.textContent = modSearchQuery ? `搜索 "${modSearchQuery}" 的结果` : '热门模组';

    const loader = getCustomSelectValue('mod-filter-loader');
    const version = getCustomSelectValue('mod-filter-version');
    const category = getCustomSelectValue('mod-filter-category');
    const sort = getCustomSelectValue('mod-filter-sort');

    try {
        const data = await API.searchMods(modSearchQuery, 'modrinth', loader, version, category, sort, 15, modSearchOffset);
        const hits = data.hits || [];
        modSearchTotal = data.total || 0;
        modSearchResults = hits;

        if (hits.length === 0) {
            container.innerHTML = '<p class="empty-text">未找到模组</p>';
        } else {
            container.innerHTML = hits.map(function (mod) {
                var isSelected = modSelectedIds.has(mod.id);
                return '<div class="mod-item mod-item-clickable' + (modMultiSelectMode ? ' mod-multiselect-active' : '') + '" onclick="openModDetail(\'' + mod.id + '\', \'' + mod.source + '\')">' +
                    (modMultiSelectMode ? '<div class="mod-checkbox' + (isSelected ? ' checked' : '') + '" data-mod-id="' + mod.id + '" onclick="event.stopPropagation();toggleModSelect(\'' + mod.id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : '') +
                    '<div class="mod-icon"><img src="' + (mod.icon || '') + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'mod-icon--fallback\')"></div>' +
                    '<div class="mod-info">' +
                        '<div class="mod-name">' + escapeHtml(formatModNameWithChinese(mod.id || mod.slug, mod.title)) + '</div>' +
                        '<div class="mod-desc">' + escapeHtml(mod.description) + '</div>' +
                        '<div class="mod-meta">' +
                            '<span>\u2B07 ' + formatNumber(mod.downloads) + '</span>' +
                            '<span>\u2764 ' + escapeHtml(mod.author) + '</span>' +
                            '<span>' + (mod.categories || []).slice(0, 3).join(', ') + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="mod-actions" onclick="event.stopPropagation()">' +
                        '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openModDetail(\'' + mod.id + '\', \'' + mod.source + '\')">安装</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        updateModPagination();
    } catch (e) {
        container.innerHTML = '<p class="empty-text">加载失败</p>';
    }
}

function updateModPagination() {
    const pagination = document.getElementById('mod-pagination');
    const currentPage = Math.floor(modSearchOffset / 15) + 1;
    const totalPages = Math.max(1, Math.ceil(modSearchTotal / 15));

    pagination.style.display = 'flex';
    document.getElementById('mod-page-info').textContent = `${currentPage}/${totalPages}`;
    document.getElementById('mod-prev-btn').disabled = modSearchOffset <= 0;
    document.getElementById('mod-next-btn').disabled = modSearchOffset + 15 >= modSearchTotal;
}

async function loadFeaturedMods() {
    modSearchQuery = '';
    modSearchOffset = 0;
    await loadMods();
}

async function searchMods() {
    modSearchOffset = 0;
    await loadMods();
}

let currentModDetailData = null;
let mdAllVersions = [];
let mdCurrentTab = '';
let currentModDetailType = 'mod';
let mdCurrentDeps = [];
let mdDepsResolved = {};
let mdDepsVersionInfo = {};
let _modDetailSeq = 0;

async function getInstalledVersionInfo() {
    try {
        const settings = await API.getSettings().catch(() => ({}));
        const selectedVersion = settings.selectedVersion || '';
        if (!selectedVersion) return { gameVersion: '', loaderType: '', versionId: '' };

        const versionInfo = installedVersions.find(v => v.id === selectedVersion);
        let gameVersion = '';
        if (versionInfo && versionInfo.baseVersion) {
            gameVersion = versionInfo.baseVersion;
        } else if (versionInfo && versionInfo.inheritsFrom) {
            gameVersion = versionInfo.inheritsFrom;
        } else {
            gameVersion = selectedVersion.split('-')[0];
        }

        let loaderType = '';
        if (versionInfo) {
            if (versionInfo.isFabric) loaderType = 'fabric';
            else if (versionInfo.isForge) loaderType = 'forge';
            else if (versionInfo.isNeoForge) loaderType = 'neoforge';
        }

        return { gameVersion, loaderType, versionId: selectedVersion };
    } catch (e) {
        return { gameVersion: '', loaderType: '', versionId: '' };
    }
}

async function openModDetail(projectId, source) {
    console.log('[ModDetail] Opening mod detail for:', projectId, 'source:', source);
    const mySeq = ++_modDetailSeq;
    currentModDetailId = projectId;
    currentModDetailSource = source || 'modrinth';
    currentModDetailType = 'mod';

    navigateToPage('mod-detail');

    const backBtn = document.querySelector('#page-mod-detail .moddetail-page-header .btn-icon');
    if (backBtn) backBtn.setAttribute('onclick', 'goBackFromDetail()');

    const mdName = document.getElementById('md-name');
    const mdDesc = document.getElementById('md-desc');
    const mdIconImg = document.getElementById('md-icon-img');
    const mdIconFallback = document.getElementById('md-icon-fallback');
    const mdVersionList = document.getElementById('md-version-list');
    const mdVersionTabs = document.getElementById('md-version-tabs');

    if (!mdName || !mdVersionList) {
        console.error('[ModDetail] Required elements not found');
        return;
    }

    mdName.textContent = '加载中...';
    if (mdDesc) mdDesc.textContent = '';
    if (mdIconImg) mdIconImg.style.display = 'none';
    if (mdIconFallback) mdIconFallback.style.display = 'none';
    mdVersionList.innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">加载中...</p>';
    if (mdVersionTabs) mdVersionTabs.innerHTML = '';

    try {
        console.log('[ModDetail] Fetching mod detail...');
        const detail = await API.getModDetail(projectId, source);
        if (mySeq !== _modDetailSeq) { console.log('[ModDetail] Aborted (stale)'); return; }
        console.log('[ModDetail] Got detail:', detail);
        currentModDetailData = detail;

        const modTitle = formatModNameWithChinese(detail.id || detail.slug, detail.title || '未知模组');
        mdName.textContent = modTitle;
        if (mdDesc) mdDesc.textContent = (detail.description || '').substring(0, 200);

        if (detail.icon && mdIconImg && mdIconFallback) {
            mdIconImg.src = detail.icon;
            mdIconImg.style.display = '';
            mdIconFallback.style.display = 'none';
        } else if (mdIconImg && mdIconFallback) {
            mdIconImg.style.display = 'none';
            mdIconFallback.textContent = modTitle.charAt(0).toUpperCase();
            mdIconFallback.style.display = '';
        }

        const mdDownloads = document.getElementById('md-downloads');
        const mdFollowers = document.getElementById('md-followers');
        const mdUpdated = document.getElementById('md-updated');
        const srcBadge = document.getElementById('md-source-badge');

        if (mdDownloads) mdDownloads.textContent = `⬇ ${formatNumber(detail.downloads || 0)}`;
        if (mdFollowers) mdFollowers.textContent = `❤ ${formatNumber(detail.followers || 0)}`;
        
        const updatedStr = detail.dateModified ? formatDate(detail.dateModified) : '';
        if (mdUpdated) mdUpdated.textContent = `🕐 更新于 ${updatedStr}`;

        if (srcBadge) {
            if (source === 'curseforge') {
                srcBadge.textContent = 'CurseForge';
                srcBadge.style.color = '#f97316';
                srcBadge.style.background = 'rgba(249, 115, 22, 0.12)';
            } else {
                srcBadge.textContent = 'Modrinth';
                srcBadge.style.color = '#a855f7';
                srcBadge.style.background = 'rgba(168, 85, 247, 0.12)';
            }
        }

        await loadMdVersions(projectId, source, mySeq);
    } catch (e) {
        if (mySeq !== _modDetailSeq) return;
        console.error('[ModDetail] Error:', e);
        mdName.textContent = '加载失败';
        mdVersionList.innerHTML = `<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">无法加载模组详情: ${e.message || e}</p>`;
    }
}

async function loadMdVersions(projectId, source, detailSeq) {
    try {
        const data = await API.getModVersions(projectId, source);
        if (detailSeq !== undefined && detailSeq !== _modDetailSeq) { console.log('[MDVersions] Aborted (stale)'); return; }
        mdAllVersions = data.versions || [];
        if (!Array.isArray(mdAllVersions)) mdAllVersions = [];

        loadModDependencies();

        const tabsContainer = document.getElementById('md-version-tabs');
        const currentGameVersion = getCustomSelectValue('mod-filter-version');
        const currentLoader = getCustomSelectValue('mod-filter-loader');

        if (currentGameVersion || currentLoader) {
            const filtered = mdAllVersions.filter(v => {
                const gv = v.gameVersions || [];
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                let match = true;
                if (currentGameVersion && !gv.includes(currentGameVersion)) match = false;
                if (currentLoader && !loaders.includes(currentLoader.toLowerCase())) match = false;
                return match;
            });
            
            if (tabsContainer) {
                tabsContainer.innerHTML = `<button class="md-vtab active" data-ver="_filtered" onclick="switchMdVersionTab('_filtered')">筛选结果 (${filtered.length})</button><button class="md-vtab" data-ver="" onclick="switchMdVersionTab('')">全部 (${mdAllVersions.length})</button>`;
            }
            renderMdVersionList(filtered);
        } else {
            const gameVersions = new Set();
            mdAllVersions.forEach(v => {
                (v.gameVersions || []).forEach(gv => gameVersions.add(gv));
            });

            let tabsHtml = '<button class="md-vtab active" data-ver="" onclick="switchMdVersionTab(\'\')">全部</button>';
            [...gameVersions].sort().reverse().forEach(gv => {
                tabsHtml += `<button class="md-vtab" data-ver="${escapeHtml(gv)}" onclick="switchMdVersionTab('${escapeOnclick(gv)}')">${escapeHtml(gv)}</button>`;
            });
            tabsHtml += '<button class="md-vtab" data-ver="_snapshot" onclick="switchMdVersionTab(\'_snapshot\')">快照版</button>';
            if (tabsContainer) tabsContainer.innerHTML = tabsHtml;

            renderMdVersionList(mdAllVersions);
        }
    } catch (e) {
        console.error('[MDVersions] Error:', e);
        document.getElementById('md-version-list').innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">加载版本列表失败</p>';
    }
}

function switchMdVersionTab(ver) {
    mdCurrentTab = ver;
    
    document.querySelectorAll('.md-vtab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.ver === ver);
    });

    let filtered = mdAllVersions;
    if (ver && ver !== '') {
        if (ver === '_snapshot') {
            filtered = mdAllVersions.filter(v => v.releaseType === 'alpha' || v.releaseType === 'beta' || v.releaseType === 'snapshot');
        } else if (ver === '_filtered') {
            const currentGameVersion = getCustomSelectValue('mod-filter-version');
            const currentLoader = getCustomSelectValue('mod-filter-loader');
            filtered = mdAllVersions.filter(v => {
                const gv = v.gameVersions || [];
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                let match = true;
                if (currentGameVersion && !gv.includes(currentGameVersion)) match = false;
                if (currentLoader && !loaders.includes(currentLoader.toLowerCase())) match = false;
                return match;
            });
        } else {
            filtered = mdAllVersions.filter(v => (v.gameVersions || []).includes(ver));
        }
    }

    renderMdVersionList(filtered);
}

const mdDepsCache = new Map();
const MD_DEPS_CACHE_TTL = 5 * 60 * 1000;

async function loadModDependencies() {
    const depsSection = document.getElementById('md-deps-section');
    const depsList = document.getElementById('md-deps-list');
    const depsCount = document.getElementById('md-deps-count');

    if (!depsSection || !depsList) return;

    const allDeps = new Map();
    mdAllVersions.forEach(v => {
        (v.dependencies || []).forEach(d => {
            if (d.projectId && !allDeps.has(d.projectId)) {
                allDeps.set(d.projectId, d);
            }
        });
    });

    const depArray = Array.from(allDeps.values());
    mdCurrentDeps = depArray;

    if (depArray.length === 0) {
        depsSection.style.display = 'none';
        return;
    }

    const requiredDeps = depArray.filter(d => d.dependencyType === 'required');
    depsSection.style.display = 'block';

    const verInfo = await getInstalledVersionInfo();
    const currentGameVersion = verInfo.gameVersion;
    const currentLoader = verInfo.loaderType;
    const hasVersionFilter = !!(currentGameVersion || currentLoader);

    if (!hasVersionFilter) {
        if (depsCount) depsCount.textContent = `(${requiredDeps.length} 必选, ${depArray.length - requiredDeps.length} 可选) — 请先选择游戏版本`;
    }

    const depIds = depArray.map(d => d.projectId).filter(Boolean);
    if (!depIds.length) {
        depsList.innerHTML = '';
        return;
    }

    const cacheKey = depIds.sort().join(',') + '|' + (currentGameVersion || '') + '|' + (currentLoader || '');
    const cached = mdDepsCache.get(cacheKey);
    if (cached && (Date.now() - cached.time < MD_DEPS_CACHE_TTL)) {
        mdDepsResolved = cached.resolved;
        mdDepsVersionInfo = cached.versionInfo;
        renderDepsList(depArray, cached.resolved, cached.versionInfo, hasVersionFilter, currentGameVersion, currentLoader, cached.installedMods, depsList, depsCount, requiredDeps);
        return;
    }

    depsList.innerHTML = depArray.map(d => {
        const depType = d.dependencyType || 'optional';
        const typeLabel = depType === 'required' ? '必选' : (depType === 'incompatible' ? '冲突' : '可选');
        const badgeClass = depType === 'required' ? 'required' : (depType === 'incompatible' ? 'incompatible' : 'optional');
        return `<div class="md-dep-item" id="md-dep-${d.projectId}" onclick="openModDetail('${d.projectId}', 'modrinth')">
            <div class="md-dep-icon"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>
            <div class="md-dep-info">
                <div class="md-dep-name" style="color:var(--text-muted)">加载中...</div>
            </div>
            <span class="md-dep-badge ${badgeClass}">${typeLabel}</span>
            <span class="md-dep-status not-installed">...</span>
        </div>`;
    }).join('');

    try {
        const [resolveResult, installedModsData] = await Promise.all([
            hasVersionFilter
                ? API.resolveDepVersions(depIds, currentGameVersion, currentLoader, 'modrinth')
                : API.resolveModDeps(depIds.join(',')).then(r => ({ _basic: r })),
            API.getInstalledMods().catch(() => []).then(r => Array.isArray(r) ? r : (r.mods || []))
        ]);

        let resolved = {};
        let versionInfo = {};

        if (hasVersionFilter) {
            versionInfo = resolveResult;
            mdDepsVersionInfo = versionInfo;
            for (const pid of depIds) {
                const info = versionInfo[pid] || {};
                resolved[pid] = {
                    id: info.id || pid,
                    title: info.title || pid,
                    icon: info.icon || '',
                    description: info.description || '',
                    downloads: info.downloads || 0
                };
            }
            mdDepsResolved = resolved;

            const compatibleCount = requiredDeps.filter(d => versionInfo[d.projectId]?.hasCompatibleVersion).length;
            const incompatibleCount = requiredDeps.filter(d => !versionInfo[d.projectId]?.hasCompatibleVersion).length;
            if (depsCount) {
                let countText = `(${requiredDeps.length} 必选, ${depArray.length - requiredDeps.length} 可选)`;
                countText += ` — ${compatibleCount} 个有对应版本`;
                if (incompatibleCount > 0) {
                    countText += `，${incompatibleCount} 个未有对应版本`;
                }
                depsCount.textContent = countText;
            }
        } else {
            resolved = resolveResult._basic;
            mdDepsResolved = resolved;
            mdDepsVersionInfo = {};
            if (depsCount) depsCount.textContent = `(${requiredDeps.length} 必选, ${depArray.length - requiredDeps.length} 可选)`;
        }

        const installedMods = Array.isArray(installedModsData) ? installedModsData : [];

        mdDepsCache.set(cacheKey, { resolved, versionInfo, installedMods, time: Date.now() });

        renderDepsList(depArray, resolved, versionInfo, hasVersionFilter, currentGameVersion, currentLoader, installedMods, depsList, depsCount, requiredDeps);
    } catch (e) {
        depsList.innerHTML = depArray.map(d => {
            const depType = d.dependencyType || 'optional';
            const typeLabel = depType === 'required' ? '必选' : (depType === 'incompatible' ? '冲突' : '可选');
            const badgeClass = depType === 'required' ? 'required' : (depType === 'incompatible' ? 'incompatible' : 'optional');
            return `<div class="md-dep-item" onclick="openModDetail('${d.projectId}', 'modrinth')">
                <div class="md-dep-info">
                    <div class="md-dep-name">${escapeHtml(d.projectId)}</div>
                </div>
                <span class="md-dep-badge ${badgeClass}">${typeLabel}</span>
            </div>`;
        }).join('');
    }
}

function renderDepsList(depArray, resolved, versionInfo, hasVersionFilter, currentGameVersion, currentLoader, installedMods, depsList, depsCount, requiredDeps) {
    depsList.innerHTML = depArray.map(d => {
        const info = resolved[d.projectId] || {};
        const title = info.title || d.projectId;
        const icon = info.icon || '';
        const desc = info.description || '';
        const depType = d.dependencyType || 'optional';
        const typeLabel = depType === 'required' ? '必选' : (depType === 'incompatible' ? '冲突' : '可选');
        const badgeClass = depType === 'required' ? 'required' : (depType === 'incompatible' ? 'incompatible' : 'optional');

        const isInstalled = installedMods.some(m =>
            m.id === d.projectId || m.name?.toLowerCase().includes(title.toLowerCase().substring(0, 6))
        );

        let statusText = '';
        let statusClass = '';
        if (isInstalled) {
            statusText = '✓ 已安装';
            statusClass = 'installed';
        } else if (hasVersionFilter) {
            const vInfo = versionInfo[d.projectId];
            if (vInfo?.hasCompatibleVersion) {
                statusText = '可安装';
                statusClass = 'compatible';
            } else {
                statusText = '未有对应版本';
                statusClass = 'incompatible-version';
            }
        } else {
            statusText = '请先选择版本';
            statusClass = 'not-installed';
        }

        let versionInfoHtml = '';
        if (hasVersionFilter && !isInstalled) {
            const vInfo = versionInfo[d.projectId];
            if (vInfo?.hasCompatibleVersion) {
                const verNum = vInfo.versionNumber || '';
                const loaders = (vInfo.loaders || []).map(l => {
                    const ll = l.toLowerCase();
                    let color = '#888', bg = 'rgba(136,136,136,0.15)';
                    if (ll === 'fabric') { color = '#dbb07c'; bg = 'rgba(219,176,124,0.15)'; }
                    else if (ll === 'forge') { color = '#4a6b8a'; bg = 'rgba(74,107,138,0.15)'; }
                    else if (ll === 'neoforge') { color = '#f47733'; bg = 'rgba(244,119,51,0.15)'; }
                    else if (ll === 'quilt') { color = '#9b59b6'; bg = 'rgba(155,89,182,0.15)'; }
                    return `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${bg};color:${color}">${escapeHtml(l)}</span>`;
                }).join('');
                versionInfoHtml = `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:4px">${verNum ? escapeHtml(verNum) : ''} ${loaders}</div>`;
            } else {
                versionInfoHtml = `<div style="font-size:11px;color:var(--warning,orange);margin-top:2px">⚠ ${currentGameVersion || '未知版本'}${currentLoader ? ' / ' + currentLoader : ''} 无对应版本</div>`;
            }
        }

        return `<div class="md-dep-item" onclick="openModDetail('${d.projectId}', 'modrinth')">
            ${icon ? `<div class="md-dep-icon"><img src="${icon}" alt="" onerror="this.parentElement.remove()"></div>` : ''}
            <div class="md-dep-info">
                <div class="md-dep-name">${escapeHtml(formatModNameWithChinese(d.projectId, title))}</div>
                <div class="md-dep-desc">${escapeHtml(desc)}</div>
                ${versionInfoHtml}
            </div>
            <span class="md-dep-badge ${badgeClass}">${typeLabel}</span>
            <span class="md-dep-status ${statusClass}">${statusText}</span>
        </div>`;
    }).join('');
}

function toggleMdDepsSection() {
    const depsList = document.getElementById('md-deps-list');
    const arrow = document.getElementById('md-deps-arrow');
    if (!depsList) return;
    depsList.classList.toggle('expanded');
    if (arrow) {
        arrow.style.transform = depsList.classList.contains('expanded') ? 'rotate(180deg)' : '';
    }
}


function renderMdVersionList(versions) {
    const container = document.getElementById('md-version-list');

    if (versions.length === 0) {
        container.innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">无匹配版本</p>';
        return;
    }

    container.innerHTML = versions.map((v, idx) => {
        const verNum = v.versionNumber || v.versionName || v.id.substring(0, 12);
        const gvs = (v.gameVersions || []).slice(0, 3).join(', ');
        const releaseType = v.releaseType === 'release' ? '' : (v.releaseType === 'beta' ? '测试版' : '');
        const files = v.files || [];
        const fileCount = files.length;
        
        const loaders = v.loaders || [];
        const loaderBadges = loaders.map(l => {
            const ll = l.toLowerCase();
            let color = '#888', bg = 'rgba(136,136,136,0.15)';
            if (ll === 'fabric') { color = '#dbb07c'; bg = 'rgba(219,176,124,0.15)'; }
            else if (ll === 'forge') { color = '#4a6b8a'; bg = 'rgba(74,107,138,0.15)'; }
            else if (ll === 'neoforge') { color = '#f47733'; bg = 'rgba(244,119,51,0.15)'; }
            else if (ll === 'quilt') { color = '#9b59b6'; bg = 'rgba(155,89,182,0.15)'; }
            return `<span class="loader-badge" style="background:${bg};color:${color}">${escapeHtml(l)}</span>`;
        }).join('');

        const safeVid = btoa(encodeURIComponent(v.id || ''));

        return `<div class="mdv-group" id="mdvg-${idx}">
            <div class="mdv-group-header" onclick="toggleMdvGroup(${idx})">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="mdv-group-title">${escapeHtml(verNum)}</span>
                    ${loaderBadges}
                    <span style="font-size:11px;color:var(--text-muted)">${gvs}</span>
                    ${releaseType ? `<span class="lver-badge" style="margin-left:4px">${releaseType}</span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                    <span style="font-size:11px;color:var(--text-muted)">${fileCount} 个文件</span>
                    <svg class="mdv-expand-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </div>
            </div>
            <div class="mdv-files">
                ${files.map(f => {
                    const fname = f.filename || f.name || f.id;
                    const size = formatNumber(Math.round((f.size || 1024) / 1024)) + ' KB';
                    const dateStr = f.datePublished ? formatDate(f.datePublished).split(' ')[0] : '';
                    const stableBadge = f.releaseType === 'release' ? '<span class="lver-badge">稳定</span>' : 
                                       (f.releaseType === 'beta' ? '<span class="lver-badge">测试版</span>' : '');
                    const loaderIcon = getLoaderFileIcon(fname);
                    const safeFid = btoa(encodeURIComponent(f.id || ''));

                    const isMod = currentModDetailType === 'mod';
                    const isModpack = currentModDetailType === 'modpack';
                    const addBtn = isModpack
                           ? `<button class="btn btn-primary btn-sm mdv-install-btn" onclick="event.stopPropagation();installModpackVersionSafe(this.closest('.mdv-file-item'))">下载</button>`
                           : (isMod
                              ? `<button class="btn btn-primary btn-sm mdv-install-btn" onclick="event.stopPropagation();installModFileSafe(this.closest('.mdv-file-item'))">安装</button>`
                              : `<button class="btn btn-primary btn-sm mdv-install-btn" onclick="event.stopPropagation();installResourceVersionSafe(this.closest('.mdv-file-item'))">安装</button>`);
                    const rowOnclick = isModpack ? `installModpackVersionSafe(this)` : (isMod ? `installModFileSafe(this)` : `installResourceVersionSafe(this)`);
                    return `<div class="mdv-file-item" data-vid="${safeVid}" data-fid="${safeFid}" onclick="${rowOnclick}">
                        <div class="mdv-file-icon">${loaderIcon}</div>
                        <div class="mdv-file-info">
                            <div class="mdv-file-name">${escapeHtml(fname)}</div>
                            <div class="mdv-file-meta">${size}${dateStr ? ' · ' + dateStr : ''}${stableBadge ? ' · ' + stableBadge : ''}</div>
                        </div>
                        ${addBtn}
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');
}


function installModFileSafe(el) {
    if (!el) return;
    const vid = decodeURIComponent(atob(el.dataset.vid || ''));
    const fid = decodeURIComponent(atob(el.dataset.fid || ''));
    installModFile(currentModDetailId, currentModDetailSource, vid, fid);
}

function installModpackVersionSafe(el) {
    if (!el) return;
    const vid = decodeURIComponent(atob(el.dataset.vid || ''));
    installModpackVersion(currentModDetailId, vid);
}

function installResourceVersionSafe(el) {
    if (!el) return;
    const vid = decodeURIComponent(atob(el.dataset.vid || ''));
    quickInstallResourceVersion(currentModDetailId, currentModDetailType, vid);
}

async function quickInstallResourceVersion(projectId, type, versionId) {
    const typeNames = { resourcepack: '材质包', shader: '光影包', datapack: '数据包' };
    showToast(`正在安装${typeNames[type] || '资源'}...`, 'info');
    try {
        const result = await API.downloadResource(versionId, projectId, type);
        if (result.success) {
            showModDownloadModal(result.fileName, result.sessionId);
        } else {
            showToast(result.error || '安装失败', 'error');
        }
    } catch (e) {
        showToast('安装失败', 'error');
    }
}

function toggleMdvGroup(idx) {
    const group = document.getElementById(`mdvg-${idx}`);
    group.classList.toggle('expanded');
}

function getLoaderFileIcon(filename) {
    const lower = filename.toLowerCase();
    if (lower.includes('fabric')) return '<img src="img/Fabric.png" alt="" style="width:20px;height:20px;image-rendering:pixelated">';
    if (lower.includes('neoforge')) return '<img src="img/NeoForge.png" alt="" style="width:20px;height:20px;image-rendering:pixelated">';
    if (lower.includes('forge')) return '<img src="img/CommandBlock.png" alt="" style="width:20px;height:20px;image-rendering:pixelated">';
    if (lower.includes('optifine')) return '<img src="img/OptiFabric.png" alt="" style="width:20px;height:20px;image-rendering:pixelated">';
    return '<img src="img/Grass.png" alt="" style="width:20px;height:20px;image-rendering:pixelated">';
}

function installModFile(projectId, source, versionId, fileId) {
    showModInstallConfirm(projectId, source, versionId, fileId);
}

async function installModpackVersion(projectId, versionId) {
    showToast('正在下载整合包，将创建新版本...', 'info');
    try {
        const result = await API.downloadResource(versionId, projectId, 'modpack', '');
        if (result.success) {
            showModpackInstallModal(result.fileName, result.sessionId);
        } else {
            console.error('[Modpack] downloadResource failed:', JSON.stringify(result));
            showToast(`整合包安装失败: ${result.error || '未知错误'}`, 'error');
        }
    } catch (e) {
        console.error('[Modpack] downloadResource error:', e);
        showToast(`整合包安装失败: ${e.message || e}`, 'error');
    }
}

async function quickInstallModpack(projectId, versionId) {
    showToast('正在下载整合包，将创建新版本...', 'info');
    try {
        const result = await API.downloadResource(versionId, projectId, 'modpack', '');
        if (result.success) {
            showModpackInstallModal(result.fileName, result.sessionId);
        } else {
            console.error('[Modpack] quickInstallModpack downloadResource failed:', JSON.stringify(result));
            showToast(`整合包安装失败: ${result.error || '未知错误'}`, 'error');
        }
    } catch (e) {
        console.error('[Modpack] quickInstallModpack downloadResource error:', e);
        showToast(`整合包安装失败: ${e.message || e}`, 'error');
    }
}

function showModpackInstallModal(fileName, sessionId) {
    currentInstallSessionId = sessionId;
    const taskId = 'modpack-' + sessionId;
    const iconUrl = currentModDetailData?.icon || '';
    dlManager.add(taskId, fileName || '整合包安装', 'modpack', sessionId, iconUrl);
    navigateToPage('downloads');

    const poll = async () => {
        try {
            const data = await API.getModDownloadStatus(sessionId);
            const files = (data.files || []).map(f => ({
                name: f.name || f.filename || f.path || '',
                status: f.status || 'pending',
                size: f.size ? formatSize(f.size) : ''
            }));
            dlManager.update(taskId, {
                progress: data.progress || 0,
                status: data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'failed' : data.status === 'cancelled' ? 'failed' : 'downloading',
                message: getDownloadStageText(data),
                files: files
            });
            if (data.status === 'completed') {
                showToast('整合包安装完成', 'success');
                loadVersions();
                return;
            }
            if (data.status === 'failed') {
                showToast(`安装失败: ${data.message}`, 'error');
                return;
            }
            if (data.status === 'cancelled') {
                dlManager.update(taskId, { status: 'failed', message: '已取消' });
                return;
            }
            if (data.status === 'unknown' || !data.status) {
                dlManager.update(taskId, { status: 'failed', message: '会话已失效' });
                return;
            }
            const timer = setTimeout(poll, 500);
            modDownloadPollTimers.push(timer);
        } catch (e) {
            const timer = setTimeout(poll, 1000);
            modDownloadPollTimers.push(timer);
        }
    };
    setTimeout(poll, 500);
}

function getDownloadStageText(data) {
    if (!data) return '准备中...';
    const phaseMap = {
        'download':        '下载整合包文件...',
        'read':            '正在读取整合包...',
        'base':            '正在准备基础版本...',
        'loader-install':  '正在安装模组加载器...',
        'version-config':  '正在创建版本配置...',
        'loader':          '模组加载器就绪',
        'download-mods':   '下载整合包模组...',
        'overrides':       '解压整合包配置...',
        'install':         '安装整合包内容...',
    };
    if (data.phase && phaseMap[data.phase]) return phaseMap[data.phase];
    if (data.phase === 'install') return '安装整合包内容...';
    if (data.status === 'completed') return '安装完成';
    if (data.status === 'failed') return '安装失败';
    return data.message || '处理中...';
}

async function showModInstallConfirm(projectId, source, versionId, fileId) {
    showToast('请选择保存文件夹...', 'info');
    try {
        const settings = await API.getSettings();
        let defaultPath = '';
        if (settings.selectedVersion) {
            const gpRes = await API.getDefaultModPath().catch(() => null);
            defaultPath = (gpRes && gpRes.path) ? gpRes.path : '';
        }
        const folderResult = await API.selectSaveFolder(defaultPath);
        if (folderResult.cancelled) {
            if (folderResult.error) {
                showToast('文件夹选择失败: ' + folderResult.error, 'error');
            } else {
                showToast('已取消选择', 'info');
            }
            return;
        }
        const savePath = folderResult.path;
        if (!savePath) {
            showToast('未选择文件夹', 'error');
            return;
        }

        const currentGameVersion = document.getElementById('mod-filter-version')?.value || '';
        const currentLoader = document.getElementById('mod-filter-loader')?.value || '';

        if (versionId) {
            showToast('正在检查前置依赖...', 'info');
            try {
                const depResult = await API.getModDependencies(versionId, source, currentGameVersion, currentLoader);
                const deps = depResult.dependencies || [];
                if (deps.length > 0) {
                    showDependencyDialog(projectId, source, versionId, fileId, savePath, deps, currentGameVersion, currentLoader);
                    return;
                }
            } catch (e) {}
        }

        proceedModInstall(projectId, source, versionId, fileId, savePath, true);
    } catch (e) {
        console.error('Mod install confirm error:', e);
        showToast('操作失败', 'error');
    }
}

function showDependencyDialog(projectId, source, versionId, fileId, savePath, deps, gameVersion, loader) {
    const existing = document.getElementById('mod-dependency-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'mod-dependency-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';

    const depListHtml = deps.map(dep => {
        const ver = dep.compatibleVersion;
        const verInfo = ver ? `v${ver.versionNumber}` : '未找到兼容版本';
        const iconHtml = dep.icon
            ? `<img src="${dep.icon}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;" onerror="this.style.display='none'" loading="lazy">`
            : `<div style="width:32px;height:32px;border-radius:6px;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;font-size:14px;">📦</div>`;
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            ${iconHtml}
            <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${dep.title}</div>
                <div style="font-size:11px;color:var(--text-secondary);">${verInfo}</div>
            </div>
            ${ver ? '<span style="font-size:11px;color:#22c55e;">✓ 可下载</span>' : '<span style="font-size:11px;color:#ef4444;">✗ 无兼容版本</span>'}
        </div>`;
    }).join('');

    const downloadableCount = deps.filter(d => d.compatibleVersion).length;

    modal.innerHTML = `<div style="background:var(--bg-primary);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <h3 style="margin:0 0 8px;font-size:16px;font-weight:700;">检测到前置依赖</h3>
        <p style="margin:0 0 16px;font-size:13px;color:var(--text-secondary);">该模组需要以下前置模组才能正常运行：</p>
        <div style="max-height:240px;overflow-y:auto;margin-bottom:16px;">${depListHtml}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="dep-cancel-btn" style="padding:8px 20px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-primary);cursor:pointer;font-size:13px;">取消</button>
            <button id="dep-download-btn" style="padding:8px 20px;border-radius:8px;border:none;background:var(--primary);color:#fff;cursor:pointer;font-size:13px;font-weight:600;${downloadableCount === 0 ? 'opacity:0.5;pointer-events:none;' : ''}">一键下载（含 ${downloadableCount} 个前置）</button>
        </div>
    </div>`;

    document.body.appendChild(modal);

    document.getElementById('dep-cancel-btn').onclick = () => modal.remove();
    document.getElementById('dep-download-btn').onclick = () => {
        modal.remove();
        proceedModInstall(projectId, source, versionId, fileId, savePath, true, deps, gameVersion, loader);
    };
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}


async function proceedModInstall(projectId, source, versionId, fileId, savePath, includeDeps, deps, gameVersion, loader) {
    showToast('正在安装模组...', 'info');
    try {
        const currentGameVersion = gameVersion || document.getElementById('mod-filter-version')?.value || '';
        const currentLoader = loader || document.getElementById('mod-filter-loader')?.value || '';
        const result = await API.downloadModVersion(versionId || '', projectId, source, fileId || '', currentGameVersion, currentLoader, savePath, includeDeps);
        if (result.success) {
            showModDownloadModal(result.fileName, result.sessionId, savePath);
        } else {
            showToast(result.error || '下载失败', 'error');
        }
    } catch (e) {
        console.error('Mod install error:', e);
        showToast('下载请求失败', 'error');
    }
}

function quickInstallCurrentMod() {
    if (!currentModDetailId) return;
    showModInstallConfirm(currentModDetailId, currentModDetailSource, currentModDetailVersionId || '');
}

function copyModName() {
    if (!currentModDetailData) return;
    window.electronAPI.clipboard.writeText(currentModDetailData.title).then(() => showToast('已复制名称', 'success'));
}

function openModSourceUrl() {
    if (!currentModDetailData) return;
    let url = '';
    if (currentModDetailSource === 'curseforge') {
        url = `https://www.curseforge.com/minecraft-mc-mods/${currentModDetailId}`;
    } else {
        url = `https://modrinth.com/mod/${currentModDetailId}`;
    }
    window.electronAPI.openExternal(url);
}

async function quickInstallMod(projectId, source, versionId, fileId) {
    showToast('正在安装模组...', 'info');
    try {
        const currentGameVersion = document.getElementById('mod-filter-version')?.value || '';
        const currentLoader = document.getElementById('mod-filter-loader')?.value || '';
        const result = await API.downloadModVersion(versionId || '', projectId, source, fileId || '', currentGameVersion, currentLoader);
        if (result.success) {
            showModDownloadModal(result.fileName, result.sessionId);
        } else {
            showToast(result.error || '下载失败', 'error');
        }
    } catch (e) {
        console.error('quickInstallMod error:', e);
        showToast('下载请求失败', 'error');
    }
}

function showModDownloadModal(fileName, sessionId, savePath) {
    const taskId = 'mod-' + sessionId;
    const iconUrl = currentModDetailData?.icon || '';
    dlManager.add(taskId, fileName || '模组下载', 'mod', sessionId, iconUrl);
    navigateToPage('downloads');

    modDownloadPollTimers.forEach(t => clearTimeout(t));
    modDownloadPollTimers = [];

    const poll = async () => {
        try {
            const data = await API.getModDownloadStatus(sessionId);
            dlManager.update(taskId, {
                progress: data.progress || 0,
                status: data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'failed' : 'downloading',
                message: data.message || '下载中...'
            });
            if (data.status === 'completed') {
                showToast(`${fileName} 下载完成`, 'success');
                loadInstalledMods();
                return;
            }
            if (data.status === 'failed') {
                showToast(`下载失败: ${data.message}`, 'error');
                return;
            }
            if (data.status === 'unknown' || !data.status) {
                dlManager.update(taskId, { status: 'failed', message: '会话已失效' });
                return;
            }
            const timer = setTimeout(poll, 500);
            modDownloadPollTimers.push(timer);
        } catch (e) {
            const timer = setTimeout(poll, 1000);
            modDownloadPollTimers.push(timer);
        }
    };
    const timer = setTimeout(poll, 500);
    modDownloadPollTimers.push(timer);
}

function toggleModMultiSelect() {
    modMultiSelectMode = !modMultiSelectMode;
    const toggleBtn = document.getElementById('mod-multiselect-toggle');
    const bar = document.getElementById('mod-multiselect-bar');
    const hintEl = document.getElementById('mod-filter-hint');
    
    if (modMultiSelectMode) {
        toggleBtn.classList.add('btn-primary');
        toggleBtn.classList.remove('btn-secondary');
        bar.style.display = 'flex';
        modSelectedIds.clear();
        modSelectedVersions.clear();
        
        const gv = document.getElementById('mod-filter-version')?.value || '';
        const ld = document.getElementById('mod-filter-loader')?.value || '';
        let hintParts = [];
        if (gv) hintParts.push(gv);
        if (ld) hintParts.push(ld.charAt(0).toUpperCase() + ld.slice(1));
        if (hintEl) hintEl.textContent = hintParts.length > 0 ? `将下载 ${hintParts.join(' + ')} 版本` : '建议先选择游戏版本和加载器';
        
        updateModSelectUI();
    } else {
        toggleBtn.classList.remove('btn-primary');
        toggleBtn.classList.add('btn-secondary');
        bar.style.display = 'none';
        modSelectedIds.clear();
        modSelectedVersions.clear();
    }
    loadMods();
}

function toggleModSelect(modId) {
    if (modSelectedIds.has(modId)) {
        modSelectedIds.delete(modId);
    } else {
        modSelectedIds.add(modId);
    }
    updateModSelectUI();
    
    const safeId = CSS.escape(modId);
    const checkbox = document.querySelector(`.mod-checkbox[data-mod-id="${safeId}"]`);
    if (checkbox) {
        checkbox.classList.toggle('checked', modSelectedIds.has(modId));
    }
}

function toggleSelectAllMods(checked) {
    const container = document.getElementById('mod-browse-list');
    const items = container.querySelectorAll('.mod-item');
    
    if (checked) {
        items.forEach(item => {
            const checkbox = item.querySelector('.mod-checkbox');
            if (checkbox) {
                const modId = checkbox.dataset.modId;
                modSelectedIds.add(modId);
                checkbox.classList.add('checked');
            }
        });
    } else {
        modSelectedIds.clear();
        items.forEach(item => {
            const checkbox = item.querySelector('.mod-checkbox');
            if (checkbox) checkbox.classList.remove('checked');
        });
    }
    updateModSelectUI();
}

function updateModSelectUI() {
    const countEl = document.getElementById('mod-selected-count');
    const batchBtn = document.getElementById('mod-batch-download-btn');
    const selectAll = document.getElementById('mod-select-all');
    
    if (countEl) countEl.textContent = `已选 ${modSelectedIds.size} 个`;
    if (batchBtn) batchBtn.disabled = modSelectedIds.size === 0;
    
    const container = document.getElementById('mod-browse-list');
    const totalItems = container.querySelectorAll('.mod-checkbox').length;
    if (selectAll) selectAll.checked = totalItems > 0 && modSelectedIds.size >= totalItems;
}

async function batchDownloadMods() {
    if (modSelectedIds.size === 0) return;

    try { await API.openModSaveFolder(); } catch (e) {}

    const currentGameVersion = getCustomSelectValue('mod-filter-version');
    const currentLoader = getCustomSelectValue('mod-filter-loader');
    
    const modIds = Array.from(modSelectedIds);
    const total = modIds.length;
    
    const modInfoMap = {};
    modSearchResults.forEach(m => { modInfoMap[m.id] = m; });

    const batchTaskId = 'batch-' + Date.now();
    const files = modIds.map(id => {
        const info = modInfoMap[id];
        const displayName = info ? formatModNameWithChinese(id, info.title) : id;
        return { name: displayName, status: 'pending', size: '' };
    });
    dlManager.add(batchTaskId, `批量下载 ${total} 个模组`, 'mod', '');
    dlManager.update(batchTaskId, { files: files });
    navigateToPage('downloads');
    
    let completed = 0;
    let failed = 0;
    
    for (let i = 0; i < modIds.length; i++) {
        const modId = modIds[i];
        const info = modInfoMap[modId];
        const displayName = info ? formatModNameWithChinese(modId, info.title) : modId;

        files[i].status = 'downloading';
        dlManager.update(batchTaskId, {
            progress: Math.round((i / total) * 100),
            message: `正在下载 ${i + 1}/${total}`,
            files: [...files]
        });
        
        try {
            const selectedVer = modSelectedVersions.get(modId);
            const versionId = selectedVer?.versionId || '';
            const fileId = selectedVer?.fileId || '';
            const source = selectedVer?.source || 'modrinth';
            
            const result = await API.downloadModVersion(versionId, modId, source, fileId, currentGameVersion, currentLoader);
            
            if (result.success) {
                await pollBatchModDownload(result.sessionId, modId);
                completed++;
                files[i].status = 'completed';
            } else {
                failed++;
                files[i].status = 'failed';
            }
        } catch (e) {
            failed++;
            files[i].status = 'failed';
        }
        
        dlManager.update(batchTaskId, {
            progress: Math.round(((i + 1) / total) * 100),
            message: `下载完成 ${completed}/${total}${failed > 0 ? `，失败 ${failed}` : ''}`,
            status: (i + 1 === total) ? (failed === total ? 'failed' : 'completed') : 'downloading',
            files: [...files]
        });
    }
    
    modSelectedIds.clear();
    modSelectedVersions.clear();
    updateModSelectUI();
    
    if (currentSettingsVersionId) {
        loadInstalledModsForSettings();
    }
    loadInstalledMods();
}

function pollBatchModDownload(sessionId, modId) {
    return new Promise((resolve) => {
        const poll = async () => {
            try {
                const data = await API.getModDownloadStatus(sessionId);
                if (data.status === 'completed') {
                    resolve();
                    return;
                }
                if (data.status === 'failed') {
                    resolve();
                    return;
                }
                setTimeout(poll, 500);
            } catch (e) {
                setTimeout(poll, 1000);
            }
        };
        setTimeout(poll, 500);
    });
}




let terracottaPollTimer = null;
let terracottaState = { mode: null, connected: false };

function updateTerracottaStatus(title, desc, state) {
    document.getElementById('terracotta-status-title').textContent = title;
    document.getElementById('terracotta-status-desc').textContent = desc;
    const dot = document.getElementById('terracotta-status-dot');
    dot.className = 'lan-status-dot';
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'connecting') dot.classList.add('connecting');
    else dot.classList.add('disconnected');
}

async function terracottaHost() {
    document.getElementById('terracotta-actions').style.display = 'none';
    document.getElementById('terracotta-host-panel').style.display = 'block';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    updateTerracottaStatus('陶瓦联机 - 创建房间', '准备创建房间', 'disconnected');
    try {
        const lanResult = await fetch('/api/lan/port');
        if (lanResult.ok) {
            const data = await lanResult.json();
            if (data.port) {
                document.getElementById('terracotta-host-port').value = data.port;
            }
        }
    } catch (e) {}
}

async function terracottaJoin() {
    document.getElementById('terracotta-actions').style.display = 'none';
    document.getElementById('terracotta-join-panel').style.display = 'block';
    document.getElementById('terracotta-host-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    updateTerracottaStatus('陶瓦联机 - 加入房间', '输入房间码加入', 'disconnected');
}

function terracottaBackToActions() {
    document.getElementById('terracotta-host-panel').style.display = 'none';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-actions').style.display = '';
    updateTerracottaStatus('未连接', '创建房间或加入朋友的房间', 'disconnected');
}

function terracottaHide() {
    document.getElementById('terracotta-host-panel').style.display = 'none';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-actions').style.display = 'none';
    if (terracottaPollTimer) { clearInterval(terracottaPollTimer); terracottaPollTimer = null; }
}

async function terracottaStartHost() {
    try {
        const gameStatus = await API.getGameStatus();
        if (!gameStatus.running) {
            showToast('请先启动游戏，然后在游戏内开放局域网联机', 'error');
            return;
        }
        if (!gameStatus.lanPort) {
            showToast('请在游戏内先开放局域网联机（按Esc → 对局域网开放）', 'error');
            return;
        }
        
        const gamePort = gameStatus.lanPort;
        document.getElementById('terracotta-host-port').value = gamePort;
        
        showToast('正在初始化陶瓦联机...', 'info');
        
        const result = await API.easytierHost(gamePort);
        if (result.success) {
            terracottaState = { mode: 'host', connected: true };
            
            document.getElementById('terracotta-host-panel').style.display = 'none';
            document.getElementById('terracotta-connected').style.display = '';
            document.getElementById('terracotta-addr-field').style.display = 'none';
            document.getElementById('terracotta-roomcode').textContent = '等待分配房间码...';
            document.getElementById('terracotta-conn-status').textContent = '正在创建房间...';
            document.getElementById('terracotta-hint').textContent = `已检测到局域网端口 ${gamePort}，房间创建中...`;
            document.getElementById('terracotta-hint').style.background = 'rgba(59,130,246,0.1)';
            document.getElementById('terracotta-hint').style.color = 'var(--blue)';
            
            updateTerracottaStatus('陶瓦联机 - 主机', '正在创建房间...', 'connecting');
            
            terracottaStartPolling();
        }
    } catch (e) {
        showToast('创建联机失败: ' + e.message, 'error');
    }
}

async function terracottaJoinRoom() {
    const codeText = document.getElementById('terracotta-join-code').value.trim();
    if (!codeText) {
        showToast('请输入房间码', 'error');
        return;
    }
    
    try {
        showToast('正在初始化陶瓦联机...', 'info');
        
        const result = await API.easytierGuest(codeText);
        if (result.success) {
            terracottaState = { mode: 'guest', connected: true };
            
            document.getElementById('terracotta-join-panel').style.display = 'none';
            document.getElementById('terracotta-connected').style.display = '';
            document.getElementById('terracotta-addr-field').style.display = '';
            document.getElementById('terracotta-roomcode').textContent = '--';
            document.getElementById('terracotta-connect-addr').textContent = '等待分配...';
            document.getElementById('terracotta-conn-status').textContent = '正在连接...';
            document.getElementById('terracotta-hint').textContent = '正在连接到主机...';
            document.getElementById('terracotta-hint').style.background = 'rgba(59,130,246,0.1)';
            document.getElementById('terracotta-hint').style.color = 'var(--blue)';
            
            updateTerracottaStatus('陶瓦联机 - 客户端', '正在连接...', 'connecting');
            
            terracottaStartPolling();
        }
    } catch (e) {
        showToast('加入联机失败: ' + e.message, 'error');
    }
}

async function terracottaDisconnect() {
    try {
        await API.easytierStop();
    } catch (e) {}
    
    terracottaState = { mode: null, connected: false };
    if (terracottaPollTimer) { clearInterval(terracottaPollTimer); terracottaPollTimer = null; }
    
    terracottaBackToActions();
    showToast('已断开陶瓦联机', 'info');
}

function terracottaCopyRoomCode() {
    const code = document.getElementById('terracotta-roomcode').textContent;
    if (!code || code === '--' || code === '等待分配房间码...') return;
    window.electronAPI.clipboard.writeText(code).then(() => {
        showToast('房间码已复制！发送给朋友即可加入', 'success');
    });
}

function terracottaCopyAddr() {
    const addr = document.getElementById('terracotta-connect-addr').textContent;
    if (!addr || addr === '等待分配...') return;
    window.electronAPI.clipboard.writeText(addr).then(() => {
        showToast('连接地址已复制', 'success');
    });
}

function terracottaStartPolling() {
    if (terracottaPollTimer) clearInterval(terracottaPollTimer);
    terracottaPollTimer = setInterval(async () => {
        try {
            const result = await API.easytierStatus();
            if (result.running && result.state) {
                const state = result.state;
                const stateType = state.state;

                if (terracottaState.mode === 'host') {
                    if (stateType === 'host-scanning') {
                        document.getElementById('terracotta-conn-status').textContent = '正在扫描局域网游戏...';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                    } else if (stateType === 'host-starting') {
                        document.getElementById('terracotta-conn-status').textContent = '正在启动房间...';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                    } else if (stateType === 'host-ok') {
                        const roomCode = state.room || result.roomCode || '';
                        document.getElementById('terracotta-roomcode').textContent = roomCode;
                        document.getElementById('terracotta-conn-status').textContent = '房间已创建 (P2P)';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--green)';
                        document.getElementById('terracotta-hint').textContent = '将房间码发送给朋友即可联机';
                        document.getElementById('terracotta-hint').style.background = 'rgba(16,185,129,0.1)';
                        document.getElementById('terracotta-hint').style.color = 'var(--green)';
                        updateTerracottaStatus('陶瓦联机 - 主机', `房间码: ${roomCode}`, 'connected');
                    } else if (stateType === 'exception') {
                        document.getElementById('terracotta-conn-status').textContent = '连接异常';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
                    }
                } else if (terracottaState.mode === 'guest') {
                    if (stateType === 'guest-connecting') {
                        document.getElementById('terracotta-conn-status').textContent = '正在连接...';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                    } else if (stateType === 'guest-starting') {
                        document.getElementById('terracotta-conn-status').textContent = '正在建立P2P连接...';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                    } else if (stateType === 'guest-ok') {
                        const connectUrl = state.url || result.virtualIP || '';
                        document.getElementById('terracotta-roomcode').textContent = connectUrl;
                        document.getElementById('terracotta-connect-addr').textContent = connectUrl;
                        document.getElementById('terracotta-conn-status').textContent = '已连接 (P2P)';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--green)';
                        document.getElementById('terracotta-hint').textContent = `在Minecraft多人游戏中添加服务器地址: ${connectUrl}`;
                        document.getElementById('terracotta-hint').style.background = 'rgba(16,185,129,0.1)';
                        document.getElementById('terracotta-hint').style.color = 'var(--green)';
                        updateTerracottaStatus('陶瓦联机 - 客户端', `连接地址: ${connectUrl}`, 'connected');
                    } else if (stateType === 'exception') {
                        document.getElementById('terracotta-conn-status').textContent = '连接异常';
                        document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
                    }
                }
            } else if (!result.running) {
                document.getElementById('terracotta-conn-status').textContent = '已断开';
                document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
            }
        } catch (e) {
            console.warn('[Terracotta] 状态轮询失败:', e);
        }
    }, 3000);
}

function updatePortmapStatus(title, desc, state) {
    document.getElementById('portmap-status-title').textContent = title;
    document.getElementById('portmap-status-desc').textContent = desc;
    const dot = document.getElementById('portmap-status-dot');
    dot.className = 'lan-status-dot';
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'connecting') dot.classList.add('connecting');
    else dot.classList.add('disconnected');
}

function portmapCreateRoom() {
    document.getElementById('portmap-actions').style.display = 'none';
    document.getElementById('portmap-create-panel').style.display = 'block';
}

function portmapJoinRoom() {
    document.getElementById('portmap-actions').style.display = 'none';
    document.getElementById('portmap-join-panel').style.display = 'block';
}

function portmapBackToActions() {
    document.getElementById('portmap-create-panel').style.display = 'none';
    document.getElementById('portmap-join-panel').style.display = 'none';
    document.getElementById('portmap-actions').style.display = '';
    updatePortmapStatus('未连接', '创建房间或加入朋友的房间', 'disconnected');
}

async function portmapDoCreate() {
    const name = document.getElementById('portmap-create-name').value || 'VersePC';
    const port = document.getElementById('portmap-create-port').value || '25565';
    const playerName = document.getElementById('portmap-create-player-name').value || '';
    const useUPnP = document.getElementById('portmap-create-upnp').checked;
    try {
        const res = await fetch('/api/lan/remote-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, port: parseInt(port), playerName, useUPnP })
        });
        const result = await res.json();
        if (result.success) {
            document.getElementById('portmap-create-panel').style.display = 'none';
            document.getElementById('portmap-connected').style.display = 'block';
            document.getElementById('portmap-connected-title').textContent = name;
            document.getElementById('portmap-room-addr').textContent = result.connectInfo || (result.publicIP ? result.publicIP + ':' + port : (result.localIPs && result.localIPs[0] ? result.localIPs[0] + ':' + port : '检测失败'));
            document.getElementById('portmap-room-port').textContent = port;
            if (result.upnp && result.upnp.success) {
                addPortmapLog('UPnP 端口映射成功');
            } else if (result.upnp) {
                addPortmapLog('UPnP 端口映射失败: ' + (result.upnp.error || '未知'));
            }
            addPortmapLog('公网IP: ' + (result.publicIP || '未检测到'));
            addPortmapLog('连接地址: ' + (result.connectInfo || '未获取'));
            updatePortmapStatus('已创建房间', '等待朋友加入...', 'connected');
        } else {
            alert('创建失败: ' + (result.error || '未知错误'));
        }
    } catch(e) {
        alert('创建失败: ' + e.message);
    }
}

function portmapDoJoin() {
    const addr = document.getElementById('portmap-join-addr').value.trim();
    const name = document.getElementById('portmap-join-name').value.trim();
    if (!addr) { alert('请输入服务器地址'); return; }
    navigator.clipboard.writeText(addr).then(() => {
        alert('已复制地址: ' + addr + '\n\n在Minecraft多人游戏中添加该地址即可加入。' + (name ? '\n建议使用名称: ' + name : ''));
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = addr;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('已复制地址: ' + addr + '\n\n在Minecraft多人游戏中添加该地址即可加入。');
    });
}

function portmapLeave() {
    document.getElementById('portmap-connected').style.display = 'none';
    document.getElementById('portmap-actions').style.display = '';
    const logEl = document.getElementById('portmap-room-log');
    if (logEl) logEl.textContent = '';
    updatePortmapStatus('未连接', '创建房间或加入朋友的房间', 'disconnected');
}

async function portmapUPnPDiagnose() {
    try {
        const res = await fetch('/api/lan/upnp-diagnose');
        const result = await res.json();
        if (result.success) {
            let msg = '=== UPnP 诊断 ===\n\n';
            msg += '平台: ' + result.platform + '\n';
            msg += 'UPnP可用: ' + (result.canUseUPnP ? '是' : '否') + '\n\n';
            msg += '检查项目:\n';
            if (result.checks) {
                result.checks.forEach((c, i) => {
                    msg += `  ${i+1}. [${c.status}] ${c.name}: ${typeof c.result === 'object' ? JSON.stringify(c.result) : c.result}\n`;
                });
            }
            if (result.recommendations && result.recommendations.length > 0) {
                msg += '\n建议:\n';
                result.recommendations.forEach((r, i) => {
                    msg += `  ${i+1}. ${r}\n`;
                });
            }
            alert(msg);
        } else {
            alert('UPnP 诊断失败: ' + (result.error || '未知错误'));
        }
    } catch(e) {
        alert('UPnP 诊断失败: ' + e.message);
    }
}

function addPortmapLog(msg) {
    const logEl = document.getElementById('portmap-room-log');
    if (!logEl) return;
    const time = new Date().toLocaleTimeString();
    logEl.textContent += `[${time}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function portmapCopyAddr() {
    const addr = document.getElementById('portmap-room-addr').textContent;
    if (!addr || addr === '--') return;
    navigator.clipboard.writeText(addr).then(() => {
        const btn = document.querySelector('#portmap-connected .lan-room-field:first-child button');
        if (btn) { btn.textContent = '已复制!'; setTimeout(() => { btn.textContent = '复制'; }, 2000); }
    }).catch(() => {});
}

let accPollTimer = null;
let accDlSessionId = null;
let accDlPollTimer = null;

function accUpdateHeroBadge(statusType, text) {
    const badge = document.getElementById('acc-hero-badge');
    const dot = badge.querySelector('.acc-badge-dot');
    const textEl = document.getElementById('acc-badge-text');
    badge.className = 'acc-hero-status-badge';
    if (statusType === 'running') badge.classList.add('running');
    if (statusType === 'installed') badge.classList.add('installed');
    textEl.textContent = text;
}

async function accLoadStatus() {
    try {
        const status = await API.easytierStatus();
        const installPanel = document.getElementById('acc-install-panel');
        const controlPanel = document.getElementById('acc-control-panel');
        const joinPanel = document.getElementById('acc-join-panel');
        const peersPanel = document.getElementById('acc-peers-panel');
        const statusGrid = document.getElementById('acc-status-grid');
        const configSection = document.getElementById('acc-config-section');
        const startBtn = document.getElementById('acc-start-btn');
        const stopBtn = document.getElementById('acc-stop-btn');

        if (status.running) {
            installPanel.style.display = 'none';
            controlPanel.style.display = '';
            joinPanel.style.display = 'none';
            peersPanel.style.display = '';
            statusGrid.style.display = '';
            configSection.style.display = 'none';
            startBtn.style.display = 'none';
            stopBtn.style.display = '';

            accUpdateHeroBadge('running', '运行中');
            document.getElementById('acc-hero-desc').textContent = 'P2P 虚拟组网已启动';

            document.getElementById('acc-status-mode').textContent = status.mode === 'host' ? '主机模式' : '客户端模式';
            document.getElementById('acc-status-ip').textContent = status.virtualIP || '等待分配...';
            document.getElementById('acc-status-peers').textContent = '0';
            document.getElementById('acc-status-port').textContent = status.gamePort || 25565;

            if (status.mode === 'host') {
                document.getElementById('acc-card-invitation').style.display = '';
                document.getElementById('acc-card-connect').style.display = 'none';
                document.getElementById('acc-status-invitation').textContent = status.roomCode || '等待分配...';
            } else {
                document.getElementById('acc-card-invitation').style.display = 'none';
                document.getElementById('acc-card-connect').style.display = '';
                document.getElementById('acc-status-connect').textContent = status.virtualIP || '等待分配...';
            }

            if (status.state) {
                const stateType = status.state.state;
                if (stateType === 'host-ok' && status.state.room) {
                    document.getElementById('acc-status-invitation').textContent = status.state.room;
                    document.getElementById('acc-status-peers').textContent = '1';
                } else if (stateType === 'guest-ok' && status.state.url) {
                    document.getElementById('acc-status-connect').textContent = status.state.url;
                    document.getElementById('acc-status-ip').textContent = status.state.url;
                    document.getElementById('acc-status-peers').textContent = '1';
                }
            }

            if (accPollTimer) clearInterval(accPollTimer);
            accPollTimer = setInterval(accRefreshStatus, 3000);
        } else if (status.installed || status.downloading) {
            installPanel.style.display = status.downloading ? 'none' : '';
            controlPanel.style.display = '';
            joinPanel.style.display = '';
            peersPanel.style.display = 'none';
            statusGrid.style.display = 'none';
            configSection.style.display = 'none';
            startBtn.style.display = '';
            stopBtn.style.display = 'none';
            document.getElementById('acc-download-btn').style.display = 'none';
            document.getElementById('acc-download-progress').style.display = 'none';

            if (status.downloading) {
                accUpdateHeroBadge('installed', '下载中...');
            } else {
                accUpdateHeroBadge('installed', '已就绪');
            }
            document.getElementById('acc-hero-desc').textContent = 'P2P 虚拟组网加速，降低 Minecraft 联机延迟';
        } else {
            installPanel.style.display = '';
            controlPanel.style.display = 'none';
            joinPanel.style.display = 'none';
            peersPanel.style.display = 'none';
            document.getElementById('acc-download-btn').style.display = '';
            document.getElementById('acc-download-progress').style.display = 'none';
            accUpdateHeroBadge('', '未安装');
            document.getElementById('acc-hero-desc').textContent = 'P2P 虚拟组网加速，降低 Minecraft 联机延迟';
        }
    } catch (e) {
        console.error('[Acc] Load status error:', e);
    }
}

async function accRefreshStatus() {
    try {
        const status = await API.easytierStatus();
        if (!status.running) {
            if (accPollTimer) { clearInterval(accPollTimer); accPollTimer = null; }
            accLoadStatus();
            return;
        }

        if (status.state) {
            const stateType = status.state.state;
            if (stateType === 'host-ok') {
                const roomCode = status.state.room || status.roomCode || '';
                document.getElementById('acc-status-invitation').textContent = roomCode;
                document.getElementById('acc-status-peers').textContent = '1';
            } else if (stateType === 'guest-ok') {
                const connectUrl = status.state.url || status.virtualIP || '';
                document.getElementById('acc-status-connect').textContent = connectUrl;
                document.getElementById('acc-status-ip').textContent = connectUrl;
                document.getElementById('acc-status-peers').textContent = '1';
            } else if (stateType === 'host-scanning' || stateType === 'host-starting') {
                document.getElementById('acc-status-peers').textContent = '...';
            } else if (stateType === 'guest-connecting' || stateType === 'guest-starting') {
                document.getElementById('acc-status-peers').textContent = '...';
            } else if (stateType === 'exception') {
                document.getElementById('acc-status-peers').textContent = '!';
            }
        }

        const peersResult = await API.easytierPeers();
        if (peersResult.state && peersResult.state.state === 'host-ok' && peersResult.state.room) {
            document.getElementById('acc-status-invitation').textContent = peersResult.state.room;
        }
        if (peersResult.state && peersResult.state.state === 'guest-ok' && peersResult.state.url) {
            document.getElementById('acc-status-connect').textContent = peersResult.state.url;
            document.getElementById('acc-status-ip').textContent = peersResult.state.url;
        }
    } catch (e) {
        console.error('[Acc] Refresh status error:', e);
    }
}

async function accDownload() {
    const btn = document.getElementById('acc-download-btn');
    btn.disabled = true;
    btn.textContent = '准备下载...';
    document.getElementById('acc-download-progress').style.display = '';

    try {
        const result = await API.easytierDownload();
        accDlSessionId = result.sessionId;

        if (accDlPollTimer) clearInterval(accDlPollTimer);
        accDlPollTimer = setInterval(async () => {
            try {
                const status = await API.easytierDownloadStatus(accDlSessionId);
                document.getElementById('acc-progress-fill').style.width = status.progress + '%';
                document.getElementById('acc-progress-pct').textContent = status.progress + '%';
                document.getElementById('acc-progress-status').textContent = status.status === 'downloading' ? '下载中' : status.status === 'extracting' ? '解压中' : status.status;
                document.getElementById('acc-progress-msg').textContent = status.message || '';

                if (status.status === 'completed') {
                    clearInterval(accDlPollTimer);
                    accDlPollTimer = null;
                    showToast('陶瓦联机安装完成！', 'success');
                    await accLoadStatus();
                } else if (status.status === 'error') {
                    clearInterval(accDlPollTimer);
                    accDlPollTimer = null;
                    showToast('安装失败: ' + (status.message || '未知错误'), 'error');
                    btn.disabled = false;
                    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>重新下载';
                }
            } catch (e) {
                console.warn('[Terracotta] 安装进度轮询失败:', e);
            }
        }, 500);
    } catch (e) {
        showToast('启动下载失败: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '下载并安装';
    }
}

async function accStartHost() {
    const portEl = document.getElementById('acc-game-port');
    const gamePort = (portEl && parseInt(portEl.value, 10)) || 25565;
    try {
        showToast('正在初始化陶瓦联机...', 'info');
        document.getElementById('acc-start-btn').disabled = true;
        document.getElementById('acc-start-btn').textContent = '初始化中...';

        const result = await API.easytierHost(gamePort);

        document.getElementById('acc-start-btn').style.display = 'none';
        document.getElementById('acc-stop-btn').style.display = '';
        document.getElementById('acc-status-grid').style.display = '';
        document.getElementById('acc-config-section').style.display = 'none';
        document.getElementById('acc-join-panel').style.display = 'none';

        accUpdateHeroBadge('running', '运行中');
        document.getElementById('acc-hero-desc').textContent = 'P2P 虚拟组网已启动';

        document.getElementById('acc-status-mode').textContent = '主机模式';
        document.getElementById('acc-status-ip').textContent = '等待分配...';
        document.getElementById('acc-status-peers').textContent = '0';
        document.getElementById('acc-status-port').textContent = gamePort;
        document.getElementById('acc-card-invitation').style.display = '';
        document.getElementById('acc-card-connect').style.display = 'none';
        document.getElementById('acc-status-invitation').textContent = '等待分配...';

        if (accPollTimer) clearInterval(accPollTimer);
        accPollTimer = setInterval(accRefreshStatus, 3000);

        showToast('陶瓦联机已启动', 'success');
    } catch (e) {
        showToast('启动失败: ' + e.message, 'error');
        document.getElementById('acc-start-btn').disabled = false;
        document.getElementById('acc-start-btn').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><polygon points="5 3 19 12 5 21 5 3"/></svg>启动加速';
    }
}

async function accJoin() {
    const codeText = document.getElementById('acc-join-code').value.trim();
    if (!codeText) {
        showToast('请输入房间码', 'error');
        return;
    }

    try {
        showToast('正在加入联机网络...', 'info');
        const joinBtn = document.querySelector('#acc-join-panel .btn-primary');
        joinBtn.disabled = true;
        joinBtn.textContent = '连接中...';

        const result = await API.easytierGuest(codeText);

        document.getElementById('acc-control-panel').style.display = '';
        document.getElementById('acc-join-panel').style.display = 'none';
        document.getElementById('acc-install-panel').style.display = 'none';
        document.getElementById('acc-peers-panel').style.display = '';
        document.getElementById('acc-status-grid').style.display = '';
        document.getElementById('acc-config-section').style.display = 'none';
        document.getElementById('acc-start-btn').style.display = 'none';
        document.getElementById('acc-stop-btn').style.display = '';

        accUpdateHeroBadge('running', '运行中');
        document.getElementById('acc-hero-desc').textContent = '已加入 P2P 联机网络';

        document.getElementById('acc-status-mode').textContent = '客户端模式';
        document.getElementById('acc-status-ip').textContent = '等待分配...';
        document.getElementById('acc-status-peers').textContent = '0';
        document.getElementById('acc-status-port').textContent = '--';
        document.getElementById('acc-card-invitation').style.display = 'none';
        document.getElementById('acc-card-connect').style.display = '';
        document.getElementById('acc-status-connect').textContent = '等待分配...';

        if (accPollTimer) clearInterval(accPollTimer);
        accPollTimer = setInterval(accRefreshStatus, 3000);

        showToast('已加入联机网络，正在连接...', 'success');
    } catch (e) {
        showToast('加入失败: ' + e.message, 'error');
        const joinBtn = document.querySelector('#acc-join-panel .btn-primary');
        if (joinBtn) {
            joinBtn.disabled = false;
            joinBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>加入联机网络';
        }
    }
}

async function accStop() {
    if (accPollTimer) { clearInterval(accPollTimer); accPollTimer = null; }
    try {
        await API.easytierStop();
        showToast('加速器已停止', 'info');
    } catch (e) {
        console.warn('[Acc] 停止加速器失败:', e);
    }
    await accLoadStatus();
}

function accCopyInvitation() {
    const code = document.getElementById('acc-status-invitation').textContent;
    if (code && code !== '--' && code !== '等待分配...') {
        window.electronAPI.clipboard.writeText(code).then(() => {
            showToast('房间码已复制', 'success');
        });
    }
}

function accCopyConnect() {
    const addr = document.getElementById('acc-status-connect').textContent;
    if (addr && addr !== '--' && addr !== '等待分配...') {
        window.electronAPI.clipboard.writeText(addr).then(() => {
            showToast('连接地址已复制', 'success');
        });
    }
}

async function loadSettingsFromLocal() {
    try {
        const raw = await window.electronAPI.store.get('versepc_settings');
        return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch (e) { return null; }
}

async function toggleMod(modId, enabled) {
    try {
        await API.toggleMod(modId, enabled);
        await loadInstalledMods();
        showToast(enabled ? '模组已启用' : '模组已禁用', 'info');
    } catch (e) { showToast('操作失败', 'error'); }
}

async function deleteMod(modId) {
    const confirmed = await showConfirmDialog('删除模组', '确定要删除此模组吗？', '删除', '取消');
    if (!confirmed) return;
    try {
        await API.deleteMod(modId);
        showToast('模组已删除', 'success');
        await loadInstalledMods();
    } catch (e) { showToast('删除失败', 'error'); }
}

async function loadAccounts() {
    try {
        const [accounts, settings] = await Promise.all([
            API.getAccounts(),
            API.getSettings(),
        ]);
        const container = document.getElementById('accounts-list');

        if (accounts.length === 0) {
            container.innerHTML = '<p class="empty-text">暂无账户，请添加账户</p>';
        } else {
            container.innerHTML = accounts.map(acc => {
                const isSelected = acc.id === settings.selectedAccount;
                const typeLabel = acc.type === 'microsoft' ? '微软账户' : acc.type === 'thirdparty' ? '外置登录' : '离线账户';
                const typeClass = acc.type === 'microsoft' ? 'microsoft' : acc.type === 'thirdparty' ? 'thirdparty' : 'offline';
                const accUuid = (acc.uuid || '').replace(/-/g, '');
                let skinUrl = '';
                if (accUuid) {
                    const serverParam = acc.serverUrl ? `&serverUrl=${encodeURIComponent(acc.serverUrl)}` : '';
                    const usernameParam = acc.username ? `&username=${encodeURIComponent(acc.username)}` : '';
                    skinUrl = `/api/avatar?uuid=${accUuid}${serverParam}${usernameParam}`;
                }
                const avatarHtml = skinUrl
                    ? `<img src="${skinUrl}" alt="" class="account-avatar-img">`
                    : `<span class="account-avatar-text">${acc.username.charAt(0).toUpperCase()}</span>`;
                return `<div class="account-item ${isSelected ? 'selected' : ''}" onclick="selectAccount('${acc.id}')">
                    <div class="account-avatar">${avatarHtml}</div>
                    <div class="account-item-info">
                        <div class="account-item-name">${escapeHtml(acc.username)}</div>
                        <div class="account-item-uuid">${acc.uuid}</div>
                        <div class="account-item-type ${typeClass}">${typeLabel}</div>
                    </div>
                    <div class="mod-actions">
                        ${!isSelected ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); selectAccount('${acc.id}')">选择</button>` : '<span style="color: var(--accent); font-size: 12px;">当前使用</span>'}
                        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteAccount('${acc.id}')">删除</button>
                    </div>
                </div>`;
            }).join('');
            
            container.querySelectorAll('.account-avatar-img').forEach(img => {
                img.onerror = function() {
                    const avatarDiv = this.parentElement;
                    if (avatarDiv) {
                        this.style.display = 'none';
                        const textSpan = document.createElement('span');
                        textSpan.className = 'account-avatar-text';
                        const name = avatarDiv.closest('.account-item')?.querySelector('.account-item-name')?.textContent || '?';
                        textSpan.textContent = name.charAt(0).toUpperCase();
                        avatarDiv.appendChild(textSpan);
                    }
                };
            });
        }

        const selectedAccount = accounts.find(a => a.id === settings.selectedAccount) || accounts[0];
        if (selectedAccount) {
            const accUuid = (selectedAccount.uuid || '').replace(/-/g, '');
            let accSkinUrl = '';
            if (accUuid) {
                const serverParam = selectedAccount.serverUrl ? `&serverUrl=${encodeURIComponent(selectedAccount.serverUrl)}` : '';
                const usernameParam = selectedAccount.username ? `&username=${encodeURIComponent(selectedAccount.username)}` : '';
                const offlineParam = (selectedAccount.type === 'offline' && !selectedAccount.serverUrl) ? '&offline=1' : '';
                accSkinUrl = `/api/avatar?uuid=${accUuid}${serverParam}${usernameParam}${offlineParam}&_=${AVATAR_CACHE_VERSION}`;
            }
            
            document.getElementById('home-player-name').textContent = selectedAccount.username;
            document.getElementById('home-account-type').textContent = selectedAccount.type === 'microsoft' ? '微软账户' : selectedAccount.type === 'thirdparty' ? '外置登录' : '离线模式';
            try { localStorage.setItem('cachedPlayerName', selectedAccount.username); } catch(e) {}
            
            const homeAvatar = document.getElementById('home-avatar');
            if (accSkinUrl) {
                homeAvatar.innerHTML = '';
                homeAvatar.style.backgroundImage = '';
                const img = document.createElement('img');
                img.src = accSkinUrl;
                img.className = 'account-avatar-img';
                img.width = 64;
                img.height = 64;
                img.onload = function() {
                    try { localStorage.setItem('cachedAvatarUrl', accSkinUrl); localStorage.setItem('cachedAvatarId', selectedAccount.id); } catch(e) {}
                };
                img.onerror = function() {
                    img.style.display = 'none';
                    const span = document.createElement('span');
                    span.className = 'account-avatar-text';
                    span.textContent = selectedAccount.username.charAt(0).toUpperCase();
                    homeAvatar.appendChild(span);
                };
                homeAvatar.appendChild(img);
            }
            
            document.getElementById('launch-player-name').textContent = selectedAccount.username;
            const launchAvatar = document.getElementById('launch-avatar');
            if (accSkinUrl) {
                launchAvatar.innerHTML = '';
                launchAvatar.style.backgroundImage = '';
                const img2 = document.createElement('img');
                img2.src = accSkinUrl;
                img2.className = 'account-avatar-img';
                img2.onerror = function() {
                    img2.style.display = 'none';
                    const span = document.createElement('span');
                    span.className = 'account-avatar-text';
                    span.textContent = selectedAccount.username.charAt(0).toUpperCase();
                    launchAvatar.appendChild(span);
                };
                launchAvatar.appendChild(img2);
            }
        }
    } catch (e) { console.error('[Accounts] Failed to update account display:', e); }
}

async function selectAccount(accountId) {
    try {
        await API.selectAccount(accountId);
        await loadAccounts();
        showToast('已切换账户', 'info');
    } catch (e) { showToast('切换失败', 'error'); }
}

async function deleteAccount(accountId) {
    const confirmed = await showConfirmDialog('删除账户', '确定要删除此账户吗？', '删除', '取消');
    if (!confirmed) return;
    try {
        await API.deleteAccount(accountId);
        await loadAccounts();
        showToast('账户已删除', 'success');
    } catch (e) { showToast('删除失败', 'error'); }
}

async function startMsAuth() {
    showModal('msauth-modal');
    document.getElementById('msauth-status-text').textContent = '获取设备码中...';
    try {
        const result = await API.getMsDeviceCode();
        if (result.success) {
            document.getElementById('msauth-url').href = result.verificationUri;
            document.getElementById('msauth-url').textContent = result.verificationUri;
            document.getElementById('msauth-code-text').textContent = result.userCode;
            document.getElementById('msauth-status-text').textContent = '等待登录...';
            if (msAuthPollInterval) clearInterval(msAuthPollInterval);
            msAuthPollInterval = setInterval(async () => {
                try {
                    const pollResult = await API.pollMsAuth(result.deviceCode);
                    if (pollResult.success) {
                        clearInterval(msAuthPollInterval);
                        msAuthPollInterval = null;
                        document.getElementById('msauth-status-text').textContent = '登录成功！';
                        showToast(`欢迎，${pollResult.account.username}！`, 'success');
                        setTimeout(() => closeMsAuthModal(), 1500);
                        await loadAccounts();
                    } else if (pollResult.pending) {
                        document.getElementById('msauth-status-text').textContent = '等待验证...';
                    } else {
                        document.getElementById('msauth-status-text').textContent = pollResult.error || '验证失败';
                    }
                } catch (e) {
                    console.warn('[Auth] 微软登录轮询失败:', e);
                }
            }, (result.interval || 5) * 1000);
        } else {
            document.getElementById('msauth-status-text').textContent = '获取设备码失败';
        }
    } catch (e) {
        document.getElementById('msauth-status-text').textContent = '请求失败';
    }
}

function closeMsAuthModal() {
    hideModal('msauth-modal');
    if (msAuthPollInterval) { clearInterval(msAuthPollInterval); msAuthPollInterval = null; }
}

function closeOfflineModal() {
    hideModal('offline-account-modal');
    document.getElementById('offline-username-input').value = '';
}

function copyMsCode() {
    const code = document.getElementById('msauth-code-text').textContent;
    window.electronAPI.clipboard.writeText(code).then(() => showToast('代码已复制', 'success'));
}

function closeThirdPartyModal() {
    hideModal('thirdparty-account-modal');
    document.getElementById('tp-username-input').value = '';
    document.getElementById('tp-password-input').value = '';
    document.getElementById('tp-server-info').style.display = 'none';
}

async function verifyThirdPartyServer(url) {
    const infoDiv = document.getElementById('tp-server-info');
    try {
        const result = await API.verifyThirdPartyServer(url);
        if (result.success) {
            document.getElementById('tp-server-name').textContent = result.meta?.serverName || '未知服务器';
            document.getElementById('tp-server-desc').textContent = result.meta?.implementationName || url;
            if (result.meta?.serverIcon) {
                document.getElementById('tp-server-icon').src = result.meta.serverIcon;
                document.getElementById('tp-server-icon').style.display = '';
            }
            infoDiv.style.display = '';
        } else {
            infoDiv.style.display = 'none';
        }
    } catch (e) {
        infoDiv.style.display = 'none';
    }
}

let tpPendingAuth = null;

function showProfileSelectModal(accessToken, clientToken, serverUrl, profiles) {
    tpPendingAuth = { accessToken, clientToken, serverUrl };
    const container = document.getElementById('tp-profile-list');
    container.innerHTML = profiles.map(p => {
        const pUuid = (p.id || '').replace(/-/g, '');
        const pServerParam = serverUrl ? `&serverUrl=${encodeURIComponent(serverUrl)}` : '';
        const pUsernameParam = p.name ? `&username=${encodeURIComponent(p.name)}` : '';
        const pSkinUrl = `/api/avatar?uuid=${pUuid}${pServerParam}${pUsernameParam}`;
        return `
        <div class="profile-select-item" onclick="selectThirdPartyProfile('${escapeOnclick(p.id)}', '${escapeOnclick(p.name)}')">
            <img src="${escapeHtml(pSkinUrl)}" alt="" class="profile-select-avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div class="profile-select-avatar-fallback" style="display:none;width:40px;height:40px;background:var(--bg-tertiary);border-radius:6px;align-items:center;justify-content:center;font-size:18px;color:var(--text-secondary);">${p.name.charAt(0).toUpperCase()}</div>
            <div class="profile-select-info">
                <div class="profile-select-name">${escapeHtml(p.name)}</div>
                <div class="profile-select-uuid">${p.id}</div>
            </div>
            <button class="btn btn-primary btn-sm">选择</button>
        </div>
    `;
    }).join('');
    container.querySelectorAll('.profile-select-avatar').forEach(img => {
        img.onload = function() {
            const w = this.naturalWidth || this.width;
            const h = this.naturalHeight || this.height;
            const isFullSkin = (w === 64 && (h === 64 || h === 32)) || w === 128 || w === 256;
            if (isFullSkin) {
                const cropped = cropSkinHeadCanvas(this, 64);
                if (cropped) {
                    this.onload = null;
                    this.src = cropped;
                }
            }
        };
    });
    showModal('tp-profile-select-modal');
}

function closeProfileSelectModal() {
    hideModal('tp-profile-select-modal');
    tpPendingAuth = null;
}

async function selectThirdPartyProfile(profileId, profileName) {
    if (!tpPendingAuth) return;
    showToast('正在选择角色...', 'info');
    try {
        const result = await API.selectThirdPartyProfile(
            tpPendingAuth.accessToken,
            tpPendingAuth.clientToken,
            tpPendingAuth.serverUrl,
            profileId,
            profileName
        );
        if (result.success) {
            showToast(`欢迎，${result.account.username}！`, 'success');
            closeProfileSelectModal();
            await loadAccounts();
        } else {
            showToast(result.error || '角色选择失败', 'error');
        }
    } catch (e) {
        showToast('角色选择失败', 'error');
    }
}

// ============================================================================
// 游戏启动流程 - 检查依赖、显示启动模态框、处理进度
// ============================================================================
async function handleLaunch() {
    const versionId = launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '';
    if (!versionId) { showToast('请选择游戏版本', 'error'); return; }

    const launchBtn = document.getElementById('launch-btn');
    const homeLaunchBtn = document.getElementById('home-launch-btn');

    launchBtn.disabled = true;
    homeLaunchBtn.disabled = true;

    _launchCounted = false;

    showLaunchModal();
    hideLaunchError();

    try {
        setLaunchStep('auth', 'running', '正在验证登录状态...');
        await new Promise(r => setTimeout(r, 300));
        setLaunchStep('auth', 'success', '登录验证通过');

        setLaunchStep('java-check', 'running', '正在检测 Java 环境...');
        
        const depCheck = await API.launchCheck(versionId);
        const requiredJava = (depCheck.java && depCheck.java.required) || 21;
        
        console.log(`[Launch] 版本 ${versionId} 需要Java ${requiredJava}+`);
        
        if (!depCheck.java || !depCheck.java.ok) {
            const requiredVer = requiredJava;
            setLaunchStep('java-check', 'running', `Java ${requiredVer}+ 未找到，正在自动安装...`);
            try {
                const javaInstallRes = await API.autoInstallJava(requiredVer);
                if (javaInstallRes.success && javaInstallRes.sessionId) {
                    const sessionId = javaInstallRes.sessionId;
                    let javaStatus = 'detecting';
                    while (javaStatus === 'detecting' || javaStatus === 'downloading' || javaStatus === 'configuring') {
                        await new Promise(r => setTimeout(r, 1500));
                        try {
                            const st = await API.getJavaInstallStatus(sessionId);
                            if (st && st.status) {
                                javaStatus = st.status;
                                setLaunchStep('java-check', 'running', st.message || `正在安装 Java ${requiredVer}+...`);
                            }
                        } catch (_) { javaStatus = 'failed'; }
                    }
                    if (javaStatus === 'completed') {
                        setLaunchStep('java-check', 'success', `Java ${requiredVer}+ 安装完成，重新检测...`);
                        const reCheck = await API.launchCheck(versionId);
                        if (reCheck.java && reCheck.java.ok) {
                            depCheck = reCheck; // 使用重新检查的结果继续后续流程
                            setLaunchStep('java-check', 'success', reCheck.java.message || `Java ${reCheck.java.version} ✓`);
                        } else {
                            setLaunchStep('java-check', 'error', 'Java 安装后仍无法检测，请检查设置');
                            showLaunchError('Java 自动安装完成，但仍未检测到。请前往版本设置手动配置Java路径');
                            launchBtn.disabled = false;
                            homeLaunchBtn.disabled = false;
                            return;
                        }
                    } else {
                        setLaunchStep('java-check', 'error', `Java ${requiredVer}+ 自动安装失败`);
                        showLaunchError(`Java ${requiredVer}+ 自动安装失败，请前往版本设置手动安装或配置Java。\n错误: ${javaStatus}`);
                        launchBtn.disabled = false;
                        homeLaunchBtn.disabled = false;
                        return;
                    }
                } else {
                    setLaunchStep('java-check', 'error', `需要Java ${requiredVer}或更高版本`);
                    showLaunchError(`需要安装Java ${requiredVer}或更高版本。请前往版本设置"文件修复"功能安装Java。`);
                    launchBtn.disabled = false;
                    homeLaunchBtn.disabled = false;
                    return;
                }
            } catch (e) {
                setLaunchStep('java-check', 'error', `Java ${requiredVer}+ 安装失败: ${e.message}`);
                showLaunchError(`Java 自动安装失败: ${e.message}。请前往版本设置手动安装Java。`);
                launchBtn.disabled = false;
                homeLaunchBtn.disabled = false;
                return;
            }
        }
        
        setLaunchStep('java-check', 'success', depCheck.java.message || `Java ${depCheck.java.version} ✓`);

        setLaunchStep('version-resolve', 'running', '正在解析版本信息...');
        await new Promise(r => setTimeout(r, 200));
        setLaunchStep('version-resolve', 'success', '版本信息解析完成');

        setLaunchStep('files-check', 'running', '正在检查文件完整性...');
        
        if (depCheck.mainJar) {
            if (depCheck.mainJar.ok) {
                setLaunchStep('files-check', 'success', depCheck.mainJar.message);
            } else {
                setLaunchStep('files-check', 'error', depCheck.mainJar.message);
                showLaunchError(depCheck.mainJar.message);
                launchBtn.disabled = false;
                homeLaunchBtn.disabled = false;
                return;
            }
        } else {
            setLaunchStep('files-check', 'success', '游戏文件完整');
        }

        if (depCheck.forgeCore && !depCheck.forgeCore.ok && depCheck.forgeCore.missing && depCheck.forgeCore.missing.length > 0) {
            const missingNames = depCheck.forgeCore.missing.map(m => `${m.desc} (${m.name.split(':').pop()})`).join('、');
            const errorMsg = `Forge核心库文件缺失 (${depCheck.forgeCore.missing.length}个): ${missingNames}`;
            setLaunchStep('files-check', 'error', errorMsg);
            showLaunchError(
                `Forge 核心库文件缺失，无法启动游戏。\n缺失文件：${missingNames}\n\n请前往"版本设置 → 文件修复"功能修复此问题，或重新安装该 Forge 版本。`,
                { forgeMissing: depCheck.forgeCore.missing, repairHint: 'forge_core_missing', versionId }
            );
            launchBtn.disabled = false;
            homeLaunchBtn.disabled = false;
            return;
        }

        setLaunchStep('natives-extract', 'running', '正在解压本地库...');
        await new Promise(r => setTimeout(r, 200));
        setLaunchStep('natives-extract', 'success', '本地库解压完成');

        setLaunchStep('assets-check', 'running', '正在检查资源文件...');
        
        if (depCheck.libraries && depCheck.libraries.missing.length > 0) {
            const libMsg = `${depCheck.libraries.missing.length}/${depCheck.libraries.total} 个库文件缺失`;
            setLaunchStep('assets-check', 'warning', libMsg);
            
            if (!depCheck.ready && depCheck.missingFiles && depCheck.missingFiles.length > 0) {
                setLaunchStep('download', 'running', '正在下载缺失文件...');
                
                const result = await API.launchGame(versionId);
                
                if (result.needDownload && result.sessionId) {
                    pollLaunchDownload(result.sessionId, versionId, requiredJava);
                    return;
                }
            }
        } else {
            setLaunchStep('assets-check', 'success', '所有资源文件完整');
        }

        setLaunchStep('build-args', 'running', '正在构建启动参数...');
        await new Promise(r => setTimeout(r, 200));
        setLaunchStep('build-args', 'success', '启动参数构建完成');

        setLaunchStep('launching', 'running', '正在启动 Minecraft...');
        
        const result = await API.launchGame(versionId);

        if (result.success) {
            setLaunchStep('launching', 'success', '游戏进程已创建');
            updateLaunchProgress(100);
            document.getElementById('launch-log-section').style.display = '';
            launchBtn.classList.add('running');
            launchBtn.querySelector('span').textContent = '启动游戏';
            document.getElementById('status-indicator').classList.add('running');
            document.getElementById('status-text').textContent = '游戏运行中';
            startGameLogStream();
            updateGameStatus();
            incrementLaunchCount();
            checkSupportMilestone();
            setTimeout(() => {
                closeLaunchModal('fade');
                launchBtn.disabled = false;
                homeLaunchBtn.disabled = false;
            }, 2000);
        } else {
            setLaunchStep('launching', 'error', result.error || '启动失败');
            showLaunchError(result.error || '启动失败', result.details || result);
            launchBtn.disabled = false;
            homeLaunchBtn.disabled = false;
        }
    } catch (e) {
        console.error('[Launch] 启动异常:', e);
        const currentStep = document.querySelector('.launch-chain-step.running');
        if (currentStep) {
            setLaunchStep(currentStep.dataset.step, 'error', e.message || '启动请求失败');
        }
        showLaunchError(e.message || '启动请求失败', { error: e.message, stack: e.stack });
        launchBtn.disabled = false;
        homeLaunchBtn.disabled = false;
    }
}

function showLaunchDepModal(versionId, sessionId, missingCount, depCheck) {
    setLaunchStep('download', 'running', `发现 ${missingCount} 个缺失文件，需要下载...`);
    updateLaunchDownloadProgress(0, `0/${missingCount} 文件`, {
        completedFiles: 0,
        totalFiles: missingCount,
        currentFile: '准备下载...',
        speed: 0,
        activeDownloads: []
    });

    startLaunchDepDownload(versionId, sessionId);
}

function closeLaunchDepModal() {
    if (launchDepPollTimer) { clearInterval(launchDepPollTimer); launchDepPollTimer = null; }
    const modal = document.getElementById('launch-dep-modal');
    if (modal) {
        modal.classList.remove('modal-visible');
        setTimeout(() => modal.remove(), 300);
    }
}

async function startLaunchDepDownload(versionId, sessionId) {
    setLaunchStep('download', 'running', '正在下载缺失文件...');

    try {
        const result = await API.downloadLaunchDeps(versionId, sessionId);

        if (result.success && result.sessionId) {
            pollLaunchDepProgress(result.sessionId, versionId);
        } else if (result.message === '无需下载') {
            setLaunchStep('download', 'success', '无需下载');
            setLaunchStep('build-args', 'running', '正在构建启动参数...');
            await new Promise(r => setTimeout(r, 200));
            setLaunchStep('build-args', 'success', '启动参数构建完成');
            setLaunchStep('launching', 'running', '正在启动 Minecraft...');
            const launchBtn = document.getElementById('launch-btn');
            const homeLaunchBtn = document.getElementById('home-launch-btn');
            try {
                const launchResult = await API.launchGame(versionId);
                if (launchResult.success) {
                    setLaunchStep('launching', 'success', '游戏进程已创建');
                    updateLaunchProgress(100);
                    showToast('游戏启动成功', 'success');
                    launchBtn.classList.add('running');
                    launchBtn.querySelector('span').textContent = '启动游戏';
                    document.getElementById('status-indicator').classList.add('running');
                    document.getElementById('status-text').textContent = '游戏运行中';
                    startGameLogStream();
                    updateGameStatus();
                    incrementLaunchCount();
                    checkSupportMilestone();
                    setTimeout(() => {
                        closeLaunchModal('fade');
                        launchBtn.disabled = false;
                        homeLaunchBtn.disabled = false;
                    }, 2000);
                } else {
                    setLaunchStep('launching', 'error', launchResult.error || '启动失败');
                    showLaunchError(launchResult.error || '启动失败', launchResult.details || launchResult);
                }
            } catch (e) {
                setLaunchStep('launching', 'error', '启动失败');
                showLaunchError('启动失败', { error: e.message });
            }
            launchBtn.disabled = false;
            if (homeLaunchBtn) homeLaunchBtn.disabled = false;
        } else {
            setLaunchStep('download', 'error', '下载请求失败');
            showLaunchError('下载请求失败');
        }
    } catch (e) {
        setLaunchStep('download', 'error', '下载请求失败: ' + e.message);
        showLaunchError('下载请求失败: ' + e.message, { error: e.message });
    }
}

function pollLaunchDepProgress(sessionId, versionId) {
    if (launchDepPollTimer) clearInterval(launchDepPollTimer);

    launchDepPollTimer = setInterval(async () => {
        try {
            const status = await API.getLaunchSessionStatus(sessionId);

            const detailData = {
                completedFiles: status.completedFiles || 0,
                totalFiles: status.totalFiles || 0,
                currentFile: status.currentFile || '',
                speed: status.speed || 0,
                activeDownloads: status.activeDownloads || []
            };

            updateLaunchDownloadProgress(status.progress || 0, status.message || '', detailData);
            const baseProgress = parseInt(document.querySelector('.launch-chain-step[data-step="download"]')?.dataset.progress || '75');
            updateLaunchProgress(baseProgress + ((status.progress || 0) / 100) * 10);

            if (status.status === 'launched') {
                clearInterval(launchDepPollTimer);
                launchDepPollTimer = null;
                setLaunchStep('download', 'success', '缺失文件下载完成');
                setLaunchStep('build-args', 'success', '启动参数构建完成');
                setLaunchStep('launching', 'success', '游戏进程已创建');
                updateLaunchProgress(100);
                showToast('游戏启动成功', 'success');
                const launchBtn = document.getElementById('launch-btn');
                const homeLaunchBtn = document.getElementById('home-launch-btn');
                launchBtn.classList.add('running');
                launchBtn.querySelector('span').textContent = '启动游戏';
                document.getElementById('status-indicator').classList.add('running');
                document.getElementById('status-text').textContent = '游戏运行中';
                startGameLogStream();
                incrementLaunchCount();
                checkSupportMilestone();
                setTimeout(() => {
                    closeLaunchModal('fade');
                    launchBtn.disabled = false;
                    if (homeLaunchBtn) homeLaunchBtn.disabled = false;
                }, 2000);
            } else if (status.status === 'launch_failed') {
                clearInterval(launchDepPollTimer);
                launchDepPollTimer = null;
                setLaunchStep('launching', 'error', status.message || '启动失败');
                showLaunchError(status.message || '启动失败', status.launchResult || status);
            } else if (status.status === 'failed') {
                clearInterval(launchDepPollTimer);
                launchDepPollTimer = null;
                setLaunchStep('download', 'error', status.message || '下载失败');
                showLaunchError(status.message || '下载失败', { failedFiles: status.failedFiles });
            } else if (status.status === 'completed' && status.failed > 0) {
                setLaunchStep('download', 'warning', `${status.failed} 个文件下载失败`);
            } else if (status.status === 'completed') {
                clearInterval(launchDepPollTimer);
                launchDepPollTimer = null;
                updateLaunchDownloadProgress(100, '下载完成', {
                    completedFiles: status.totalFiles || 0,
                    totalFiles: status.totalFiles || 0,
                    currentFile: '',
                    speed: 0,
                    activeDownloads: []
                });
                setLaunchStep('download', 'success', '缺失文件下载完成');
                showToast(`下载完成: ${status.completedFiles || 0} 个文件`, 'success');
            }
        } catch (e) {
            console.error('[Launch Poll] Error:', e);
        }
    }, 200);
}

async function retryLaunchDepDownload(versionId, sessionId) {
    setLaunchStep('download', 'running', '正在重试下载...');

    try {
        const result = await API.downloadLaunchDeps(versionId, sessionId);
        if (result.success && result.sessionId) {
            pollLaunchDepProgress(result.sessionId, versionId);
        } else {
            setLaunchStep('download', 'error', '重试失败');
            showLaunchError('重试失败', result);
        }
    } catch (e) {
        setLaunchStep('download', 'error', '重试请求失败');
        showLaunchError('重试请求失败', { error: e.message });
    }
}

async function updateGameStatus() {
    try {
        const status = await API.getGameStatus();
        const indicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        const launchBtn = document.getElementById('launch-btn');

        if (status.running) {
            indicator.classList.add('running');
            const count = status.instances ? status.instances.length : 1;
            if (count > 1) {
                statusText.textContent = `${count} 个游戏运行中`;
            } else {
                statusText.textContent = '游戏运行中';
            }
            launchBtn.classList.add('running');
            launchBtn.querySelector('span').textContent = '启动游戏';

            updateGameInstanceList(status.instances || []);
        } else {
            const wasRunning = indicator.classList.contains('running');
            indicator.classList.remove('running');
            statusText.textContent = '就绪';
            launchBtn.classList.remove('running');
            launchBtn.querySelector('span').textContent = '启动游戏';

            updateGameInstanceList([]);

            if (wasRunning) {
                try {
                    const analysisResult = await API.getExitAnalysis();
                    const analysis = analysisResult.analysis;
                    if (analysis && analysis.isCrash) {
                        showToast(`游戏崩溃: ${analysis.reason}`, 'error');
                        if (analysis.suggestion) {
                            setTimeout(() => showToast(`建议: ${analysis.suggestion}`, 'info'), 1000);
                        }
                        if (analysis.versionId || status.lastVersionId) {
                            const vid = analysis.versionId || status.lastVersionId;
                            setTimeout(() => {
                                const repairToast = document.createElement('div');
                                repairToast.className = 'toast warning';
                                repairToast.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:8px';
                                repairToast.innerHTML = '<span>游戏启动失败，可前往<strong>版本设置页面</strong>使用<strong>文件修复功能</strong>解决此问题</span><button style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap">立即修复</button>';
                                repairToast.querySelector('button').addEventListener('click', () => {
                                    openVersionSettings(vid);
                                    document.querySelectorAll('.vset-nav-item[data-tab="overview"]').forEach(b => b.click());
                                    setTimeout(() => { repairFiles(); }, 500);
                                });
                                const container = document.getElementById('toast-container');
                                if (container) {
                                    container.appendChild(repairToast);
                                    setTimeout(() => {
                                        repairToast.style.transform = 'translateX(120%)';
                                        repairToast.style.opacity = '0';
                                        setTimeout(() => { if (repairToast.parentNode) repairToast.parentNode.removeChild(repairToast); }, 300);
                                    }, 8000);
                                }
                            }, 2000);
                        }
                        const crashVid = analysis.versionId || status.lastVersionId;
                        if (crashVid) {
                            showCrashAnalysis(crashVid);
                        }
                    }
                } catch (e) {
                    console.warn('[Launch] 退出分析失败:', e);
                }
                try {
                    const selVal = homeVersionCustomSelect ? homeVersionCustomSelect.getValue() : '';
                    if (selVal) loadPlayTimeDisplay(selVal);
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error('[Launch] 更新游戏状态失败:', e);
    }
}

async function showCrashAnalysis(versionId) {
    try {
        const result = await API.analyzeCrash(versionId);
        if (result.found) {
            showCrashAnalysisDialog(result);
        }
    } catch (e) {}
}

function showCrashAnalysisDialog(result) {
    const existing = document.getElementById('crash-analysis-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'crash-analysis-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)';

    const severityColors = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
    const severityLabels = { high: '严重', medium: '中等', low: '轻微' };
    const severityColor = severityColors[result.severity] || severityColors.medium;
    const severityLabel = severityLabels[result.severity] || '中等';

    const dialog = document.createElement('div');
    dialog.style.cssText = `width:90%;max-width:520px;background:var(--bg-secondary);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden`;

    dialog.innerHTML = `
        <div style="padding:20px 24px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between">
            <h3 style="margin:0;font-size:18px;color:var(--text-primary)">崩溃分析结果</h3>
            <button id="crash-dialog-close" style="width:32px;height:32px;border:none;background:transparent;color:var(--text-muted);font-size:20px;cursor:pointer;border-radius:6px">×</button>
        </div>
        <div style="padding:24px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${severityColor}"></span>
                <span style="font-size:14px;font-weight:600;color:var(--text-primary)">${result.reason}</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${severityColor}20;color:${severityColor}">${severityLabel}</span>
            </div>
            ${result.modName ? `<div style="padding:10px 14px;background:var(--bg-primary);border-radius:8px;margin-bottom:12px;font-size:13px;color:var(--text-secondary)">相关Mod: <strong style="color:var(--accent)">${result.modName}</strong></div>` : ''}
            <div style="padding:14px;background:var(--bg-primary);border-radius:8px;border-left:4px solid var(--accent);margin-bottom:16px">
                <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">解决方案</div>
                <div style="font-size:13px;color:var(--text-primary);line-height:1.6">${result.solution}</div>
            </div>
            ${result.logFile ? `<div style="font-size:12px;color:var(--text-muted)">日志文件: ${result.logFile}</div>` : ''}
        </div>
        <div style="padding:16px 24px;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:8px">
            <button id="crash-dialog-view-log" style="padding:8px 16px;border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);border-radius:6px;font-size:13px;cursor:pointer">查看日志</button>
            <button id="crash-dialog-ok" style="padding:8px 16px;border:none;background:var(--accent);color:#fff;border-radius:6px;font-size:13px;cursor:pointer">知道了</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeDialog = () => { overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
    dialog.querySelector('#crash-dialog-close').addEventListener('click', closeDialog);
    dialog.querySelector('#crash-dialog-ok').addEventListener('click', closeDialog);
    dialog.querySelector('#crash-dialog-view-log').addEventListener('click', () => {
        closeDialog();
        if (typeof crashAnalyzerUI !== 'undefined') {
            crashAnalyzerUI.show();
        }
    });
}

async function loadPlayTimeDisplay(versionId) {
    const card = document.getElementById('home-play-time-card');
    const sessionEl = document.getElementById('home-play-time-session');
    const worldsEl = document.getElementById('home-play-time-worlds');
    if (!card || !versionId) {
        if (card) card.style.display = 'none';
        return;
    }

    try {
        const data = await API.getPlayTime(versionId);
        const hasSession = data.session && (data.session.totalSeconds > 0 || data.session.playCount > 0);
        const hasWorlds = data.worlds && data.worlds.length > 0;

        if (!hasSession && !hasWorlds) {
            card.style.display = 'none';
            return;
        }

        card.style.display = '';

        if (hasSession) {
            const s = data.session;
            let sessionHtml = `<div style="display:flex;gap:16px;flex-wrap:wrap">`;
            sessionHtml += `<div style="flex:1;min-width:120px;padding:12px;background:var(--bg-primary);border-radius:8px">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">累计游戏时长</div>
                <div style="font-size:16px;font-weight:600;color:var(--text-primary)">${s.formatted}</div>
            </div>`;
            sessionHtml += `<div style="flex:1;min-width:120px;padding:12px;background:var(--bg-primary);border-radius:8px">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">启动次数</div>
                <div style="font-size:16px;font-weight:600;color:var(--text-primary)">${s.playCount} 次</div>
            </div>`;
            if (s.lastPlayed) {
                const lastDate = new Date(s.lastPlayed);
                const now = new Date();
                const diffMs = now - lastDate;
                let lastPlayedText;
                if (diffMs < 60000) lastPlayedText = '刚刚';
                else if (diffMs < 3600000) lastPlayedText = Math.floor(diffMs / 60000) + ' 分钟前';
                else if (diffMs < 86400000) lastPlayedText = Math.floor(diffMs / 3600000) + ' 小时前';
                else lastPlayedText = Math.floor(diffMs / 86400000) + ' 天前';
                sessionHtml += `<div style="flex:1;min-width:120px;padding:12px;background:var(--bg-primary);border-radius:8px">
                    <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">上次游玩</div>
                    <div style="font-size:16px;font-weight:600;color:var(--text-primary)">${lastPlayedText}</div>
                </div>`;
            }
            sessionHtml += `</div>`;
            sessionEl.innerHTML = sessionHtml;
        } else {
            sessionEl.innerHTML = '';
        }

        if (hasWorlds) {
            const sorted = [...data.worlds].sort((a, b) => b.seconds - a.seconds);
            let worldsHtml = `<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">存档游玩时间</div>`;
            for (const w of sorted.slice(0, 5)) {
                worldsHtml += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-primary);border-radius:6px;margin-bottom:4px">
                    <span style="font-size:13px;color:var(--text-primary)">${w.worldName}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${w.formatted}</span>
                </div>`;
            }
            worldsEl.innerHTML = worldsHtml;
        } else {
            worldsEl.innerHTML = '';
        }
    } catch (e) {
        if (card) card.style.display = 'none';
    }
}

function showLaunchModal() {
    const overlay = document.getElementById('game-launch-overlay');
    if (!overlay) {
        console.error('[Launch] game-launch-overlay element not found');
        return;
    }

    overlay.style.display = 'flex';

    document.querySelectorAll('.launch-chain-step').forEach(el => {
        el.className = 'launch-chain-step pending';
        const desc = el.querySelector('.launch-chain-desc');
        if (desc) desc.textContent = '等待中...';
    });
    document.querySelectorAll('.launch-chain-link').forEach(el => {
        el.classList.remove('active');
    });

    const errorSection = document.getElementById('launch-error-section');
    if (errorSection) errorSection.style.display = 'none';

    const logSection = document.getElementById('launch-log-section');
    if (logSection) logSection.style.display = 'none';

    const titleEl = document.getElementById('launch-flow-title');
    if (titleEl) titleEl.textContent = '正在启动游戏';

    updateLaunchProgress(0);

    const repairGuide = document.getElementById('launch-repair-guide');
    if (repairGuide) repairGuide.style.display = 'none';
}

function closeLaunchModal(name_fade) {
    const overlay = document.getElementById('game-launch-overlay');
    if (!overlay) return;

    if (name_fade) {
        overlay.style.transition = 'opacity 0.5s ease-out';
        overlay.style.opacity = '0';
        setTimeout(() => {
            overlay.style.display = 'none';
            overlay.style.opacity = '1';
            overlay.style.transition = '';
            navigateToPage('home');
        }, 500);
    } else {
        overlay.style.display = 'none';
    }

    hideLaunchError();
}

function updateLaunchProgress(pct) {
    const glow = document.getElementById('launch-chain-glow');
    if (glow) glow.style.width = pct + '%';
}

function setLaunchStep(stepName, status, desc) {
    const step = document.querySelector(`.launch-chain-step[data-step="${stepName}"]`);
    if (!step) return;

    step.className = 'launch-chain-step ' + status;

    const descEl = step.querySelector('.launch-chain-desc');
    if (descEl && desc) descEl.textContent = desc;

    const progress = parseInt(step.dataset.progress || '0');
    updateLaunchProgress(progress);

    const allSteps = document.querySelectorAll('.launch-chain-step');
    const allLinks = document.querySelectorAll('.launch-chain-link');
    allSteps.forEach((s, i) => {
        if (s.classList.contains('success') || s.classList.contains('warning')) {
            if (i < allLinks.length) allLinks[i].classList.add('active');
        }
    });

    if (stepName === 'launching' && status === 'success') {
        updateLaunchProgress(100);
        const titleEl = document.getElementById('launch-flow-title');
        if (titleEl) {
            titleEl.textContent = '启动成功！';
            titleEl.style.color = '#4ade80';
        }
    }
}

function completeAllPreviousSteps(currentStepName) {
    const allSteps = document.querySelectorAll('.launch-chain-step');
    let foundCurrent = false;
    allSteps.forEach(step => {
        if (step.dataset.step === currentStepName) {
            foundCurrent = true;
            return;
        }
        if (!foundCurrent && !step.classList.contains('success')) {
            step.className = 'launch-chain-step success';
            const descEl = step.querySelector('.launch-chain-desc');
            if (descEl && descEl.textContent === '等待中...') descEl.textContent = '完成';
        }
    });
}

function showLaunchError(msg, details = null) {
    const errorSection = document.getElementById('launch-error-section');
    const errorMsg = document.getElementById('launch-error-msg');
    const repairGuide = document.getElementById('launch-repair-guide');
    if (errorSection) errorSection.style.display = 'flex';
    if (repairGuide) {
        repairGuide.style.display = 'flex';
        repairGuide.dataset.versionId = (details && details.versionId) || currentSettingsVersionId || (launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '');
    }

    let fullMsg = msg || '未知错误';
    if (details) {
        console.error('[Launch] 详细错误信息:', details);
        if (details.versionId) fullMsg += `\n版本: ${details.versionId}`;
        if (details.mainClass) fullMsg += `\n主类: ${details.mainClass}`;
        if (details.externalVersionDir) fullMsg += `\n外部目录: ${details.externalVersionDir}`;
        if (details.error) fullMsg += `\n错误: ${details.error}`;
    }

    if (errorMsg) {
        errorMsg.textContent = msg || '未知错误';
        errorMsg.title = fullMsg;
    }
}

function hideLaunchError() {
    const errorSection = document.getElementById('launch-error-section');
    const repairGuide = document.getElementById('launch-repair-guide');
    if (errorSection) errorSection.style.display = 'none';
    if (repairGuide) repairGuide.style.display = 'none';
}

function openVersionSettingsForRepair() {
    const repairGuide = document.getElementById('launch-repair-guide');
    const versionId = (repairGuide && repairGuide.dataset.versionId) || (launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '');
    if (versionId) {
        openVersionSettings(versionId);
    }
    closeLaunchModal();
}

function updateLaunchDownloadProgress(pct, msg, detailData) {
    const step = document.querySelector('.launch-chain-step[data-step="download"]');
    if (!step) return;

    const detailWrap = step.querySelector('.launch-chain-detail');
    const fill = step.querySelector('.launch-chain-detail-fill');
    const textEl = step.querySelector('.launch-chain-detail-text');
    const desc = step.querySelector('.launch-chain-desc');

    if (detailWrap) detailWrap.style.display = 'flex';
    if (fill) fill.style.width = Math.round(pct) + '%';
    if (textEl) textEl.textContent = Math.round(pct) + '%';
    if (desc && msg) desc.textContent = msg;

    if (detailData) {
        if (textEl) {
            var parts = [];
            if (detailData.completedFiles !== undefined && detailData.totalFiles !== undefined) {
                parts.push(detailData.completedFiles + '/' + detailData.totalFiles);
            }
            if (detailData.speed > 0) {
                var spd = detailData.speed;
                if (spd < 1024) parts.push(spd.toFixed(0) + ' B/s');
                else if (spd < 1024 * 1024) parts.push((spd / 1024).toFixed(1) + ' KB/s');
                else parts.push((spd / (1024 * 1024)).toFixed(1) + ' MB/s');
            }
            textEl.textContent = (parts.length ? parts.join('  ') + ' - ' : '') + Math.round(pct) + '%';
        }
    }
}

function cancelLaunchFlow() {
    closeLaunchModal();
    const launchBtn = document.getElementById('launch-btn');
    const homeLaunchBtn = document.getElementById('home-launch-btn');
    if (launchBtn) launchBtn.disabled = false;
    if (homeLaunchBtn) homeLaunchBtn.disabled = false;
}

function toggleLaunchLog() {
    const content = document.getElementById('launch-log-content');
    if (content.style.maxHeight === '0px') {
        content.style.maxHeight = '150px';
    } else {
        content.style.maxHeight = '0px';
    }
}

async function pollLaunchDownload(sessionId, versionId, requiredJava) {
    try {
        let lastPct = 0;
        
        const pollInterval = setInterval(async () => {
            try {
                const dlStatus = await API.getLaunchSessionStatus(sessionId);
                
                if (!dlStatus || dlStatus.status === 'error') {
                    clearInterval(pollInterval);
                    setLaunchStep('download', 'error', dlStatus?.message || '下载失败');
                    showLaunchError(dlStatus?.message || '下载失败');
                    const launchBtn = document.getElementById('launch-btn');
                    const homeLaunchBtn = document.getElementById('home-launch-btn');
                    if (launchBtn) launchBtn.disabled = false;
                    if (homeLaunchBtn) homeLaunchBtn.disabled = false;
                    return;
                }
                
                const pct = Math.min(95, Math.round(dlStatus.progress || 0));
                if (pct !== lastPct) {
                    lastPct = pct;
                    updateLaunchDownloadProgress(pct, `下载文件 (${dlStatus.completedFiles || 0}/${dlStatus.totalFiles || 0}): ${dlStatus.currentFile || ''}`, {
                        completedFiles: dlStatus.completedFiles || 0,
                        totalFiles: dlStatus.totalFiles || 0,
                        currentFile: dlStatus.currentFile || '',
                        speed: dlStatus.speed || 0,
                        activeDownloads: dlStatus.activeDownloads || []
                    });
                    const baseProgress = parseInt(document.querySelector('.launch-chain-step[data-step="download"]')?.dataset.progress || '75');
                        updateLaunchProgress(baseProgress + (pct / 100) * 10);
                }
                
                if (dlStatus.status === 'completed') {
                    clearInterval(pollInterval);
                    updateLaunchDownloadProgress(100, '下载完成', {
                        completedFiles: dlStatus.totalFiles || 0,
                        totalFiles: dlStatus.totalFiles || 0,
                        currentFile: '',
                        speed: 0,
                        activeDownloads: []
                    });
                    setLaunchStep('download', 'success', '缺失文件下载完成');
                    
                    setTimeout(async () => {
                        setLaunchStep('build-args', 'running', '正在构建启动参数...');
                        await new Promise(r => setTimeout(r, 200));
                        setLaunchStep('build-args', 'success', '启动参数构建完成');
                        
                        setLaunchStep('launching', 'running', '正在启动 Minecraft...');
                        
                        const result = await API.launchGame(versionId);
                        
                        if (result.success) {
                            setLaunchStep('launching', 'success', '游戏进程已创建');
                            updateLaunchProgress(100);
                            document.getElementById('launch-log-section').style.display = '';
                            const launchBtn = document.getElementById('launch-btn');
                            const homeLaunchBtn = document.getElementById('home-launch-btn');
                            launchBtn.classList.add('running');
                            launchBtn.querySelector('span').textContent = '启动游戏';
                            document.getElementById('status-indicator').classList.add('running');
                            document.getElementById('status-text').textContent = '游戏运行中';
                            startGameLogStream();
                            updateGameStatus();
                            incrementLaunchCount();
                            checkSupportMilestone();
                            setTimeout(() => {
                                closeLaunchModal('fade');
                                launchBtn.disabled = false;
                                homeLaunchBtn.disabled = false;
                            }, 2000);
                        } else {
                            setLaunchStep('launching', 'error', result.error || '启动失败');
                            showLaunchError(result.error || '启动失败');
                            const launchBtn = document.getElementById('launch-btn');
                            const homeLaunchBtn = document.getElementById('home-launch-btn');
                            if (launchBtn) launchBtn.disabled = false;
                            if (homeLaunchBtn) homeLaunchBtn.disabled = false;
                        }
                    }, 500);
                }
            } catch (e) {
                console.warn('[Launch] 启动轮询回调异常:', e);
            }
        }, 800);
    } catch (e) {
        console.error('[Launch] 轮询失败:', e);
    }
}

function updateGameInstanceList(instances) {
    let container = document.getElementById('game-instance-list');
    if (!container) {
        const sidebar = document.querySelector('.launch-bar') || document.querySelector('.sidebar');
        if (!sidebar) return;
        container = document.createElement('div');
        container.id = 'game-instance-list';
        container.style.cssText = 'position:fixed;bottom:60px;right:16px;z-index:1000;display:flex;flex-direction:column;gap:6px;max-width:280px;';
        document.body.appendChild(container);
    }

    if (instances.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = instances.map(inst => {
        const elapsed = Math.floor((Date.now() - inst.startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
        return `
            <div class="game-instance-card" data-session="${inst.sessionId}" style="
                background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;
                padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;
                box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:default;
            ">
                <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;"></div>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${inst.versionId}</div>
                    <div style="color:var(--text-secondary);font-size:11px;">PID: ${inst.pid} · ${timeStr}${inst.lanPort ? ' · LAN:' + inst.lanPort : ''}</div>
                </div>
                <button onclick="stopGameInstance('${inst.sessionId}')" style="
                    background:var(--red);color:white;border:none;border-radius:4px;
                    padding:2px 8px;cursor:pointer;font-size:11px;flex-shrink:0;
                ">停止</button>
            </div>
        `;
    }).join('');
}

async function stopGameInstance(sessionId) {
    try {
        const result = await API.stopGameInstance(sessionId);
        if (result.success) {
            showToast('游戏实例已停止', 'info');
            updateGameStatus();
        } else {
            showToast(result.error || '停止失败', 'error');
        }
    } catch (e) {
        showToast('停止请求失败', 'error');
    }
}

function startGameLogStream() {
    if (gameLogEventSource) gameLogEventSource.close();
    const consoleOutput = document.getElementById('console-output');
    consoleOutput.innerHTML = '';
    try {
        gameLogEventSource = new EventSource('/api/game/log/stream');
        gameLogEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.event === 'exited') {
                    appendConsoleLine('[VersePC] 游戏进程已退出', 'warn');
                    gameLogEventSource.close();
                    gameLogEventSource = null;
                    return;
                }
                if (data.line) {
                    let type = '';
                    const line = data.line;
                    if (line.includes('ERROR') || line.includes('FATAL') || line.includes('Exception')) type = 'error';
                    else if (line.includes('WARN')) type = 'warn';
                    else if (line.includes('[VersePC]')) type = 'info';
                    appendConsoleLine(line, type);
                }
            } catch (e) {
                console.warn('[GameLog] 解析日志行失败:', e);
            }
        };
        gameLogEventSource.onerror = () => { gameLogEventSource.close(); gameLogEventSource = null; };
    } catch (e) {
        console.warn('[GameLog] 创建日志流失败:', e);
    }
}

function appendConsoleLine(text, type = '') {
    const consoleOutput = document.getElementById('console-output');
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.textContent = text;
    consoleOutput.appendChild(line);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
    while (consoleOutput.children.length > 500) consoleOutput.removeChild(consoleOutput.firstChild);
}

async function detectJava() {
    const hint = document.getElementById('java-detect-result');
    hint.textContent = '检测中...';
    try {
        const result = await API.detectJava();
        if (result.javaList && result.javaList.length > 0) {
            const best = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
            document.getElementById('setting-java-path').value = best.path;
            hint.textContent = `找到 Java ${best.version} (${best.is64Bit ? '64位' : '32位'})`;
            document.getElementById('stat-java').textContent = best.majorVersion;
        } else {
            hint.textContent = '未检测到Java，请手动配置或安装';
        }
    } catch (e) { hint.textContent = '检测失败'; }
}

let javaInstallPollTimer = null;

async function checkJavaOnStartup() {
    try {
        const result = await API.detectJava();
        if (result.javaList && result.javaList.length > 0) {
            const best = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
            const statJava = document.getElementById('stat-java');
            if (statJava) statJava.textContent = best.majorVersion;
        }
    } catch (e) {
        console.error('Java startup check failed:', e);
    }
}

async function triggerJvmPreheat() {
    try {
        const saved = await window.electronAPI.store.get('versepc_launch_settings');
        if (!saved) return;
        const settings = JSON.parse(saved);
        if (!settings.jvmPreheat) return;

        const result = await API.detectJava();
        if (result && result.javaList && result.javaList.length > 0) {
            const bestJava = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
            const memInfo = await API.getSystemMemory();
            const totalMB = memInfo.totalMB || 8192;
            const preheatMem = Math.min(2048, Math.floor(totalMB * 0.3));
            await fetch('/api/jvm/preheat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ javaPath: bestJava.path, maxMemMB: preheatMem })
            });
        }
    } catch(e) {}
}

async function generateCdsArchive() {
    const versionId = document.getElementById('launch-version-select')?.value;
    if (!versionId) {
        showToast('请先选择一个游戏版本', 'error');
        return;
    }
    const statusText = document.getElementById('cds-status-text');
    if (statusText) statusText.textContent = '正在生成...';
    showToast('正在生成 CDS 归档，请稍候...', 'info');
    try {
        const result = await API.generateCds(versionId);
        if (result.success) {
            const sizeInfo = result.sizeKB ? ` (${result.sizeKB}KB)` : '';
            showToast(`CDS 归档生成成功${sizeInfo}，下次启动将自动加速`, 'success');
            if (statusText) statusText.textContent = `✓ 已生成${sizeInfo}`;
        } else {
            showToast('CDS 归档生成失败: ' + (result.error || '未知错误'), 'error');
            if (statusText) statusText.textContent = '✗ 生成失败';
        }
    } catch (e) {
        showToast('CDS 归档生成失败: ' + e.message, 'error');
        if (statusText) statusText.textContent = '✗ 生成失败';
    }
}

async function checkCdsStatus() {
    const versionId = document.getElementById('launch-version-select')?.value;
    if (!versionId) return;
    const statusText = document.getElementById('cds-status-text');
    if (!statusText) return;
    try {
        const result = await API.getCdsStatus(versionId);
        if (result.available) {
            statusText.textContent = `✓ 归档已就绪 (${result.sizeKB}KB)`;
        } else {
            statusText.textContent = '未生成归档';
        }
    } catch (e) {
        statusText.textContent = '';
    }
}

function showJavaInstallModal(requiredVersion) {
    const existing = document.getElementById('java-install-modal');
    if (existing) existing.remove();

    const modalHtml = `
    <div class="modal" id="java-install-modal" style="display:flex;">
        <div class="modal-content java-install-modal-content">
            <div class="modal-header">
                <h3>☕ Java 运行环境</h3>
                <button class="modal-close" onclick="closeJavaInstallModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="java-install-info">
                    <div class="java-install-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                            <path d="M12 6v6l4 2"/>
                        </svg>
                    </div>
                    <div class="java-install-text">
                        <p class="java-install-title">未检测到 Java ${requiredVersion}+</p>
                        <p class="java-install-desc">Minecraft 需要 Java 运行环境才能启动。点击下方按钮自动下载并安装。</p>
                    </div>
                </div>
                <div class="java-install-sources">
                    <p class="java-sources-label">下载源：</p>
                    <div class="java-source-list" id="java-source-list">
                        <div class="java-source-item active" data-source="auto">
                            <span class="java-source-dot"></span>
                            <span class="java-source-name">自动选择</span>
                            <span class="java-source-desc">依次尝试所有下载源</span>
                        </div>
                    </div>
                </div>
                <div id="java-install-progress" style="display:none;margin-top:16px;">
                    <div class="java-progress-header">
                        <span id="java-progress-status" class="java-progress-status">准备中...</span>
                        <span id="java-progress-source" class="java-progress-source"></span>
                    </div>
                    <div class="progress-bar-container java-progress-bar">
                        <div class="progress-bar" id="java-install-progress-bar" style="width:0%"></div>
                    </div>
                    <div class="java-progress-details">
                        <span id="java-progress-text" class="java-progress-text"></span>
                        <span id="java-progress-speed" class="java-progress-speed"></span>
                    </div>
                    <div class="java-progress-size">
                        <span id="java-progress-size-text"></span>
                    </div>
                </div>
            </div>
            <div class="modal-footer" id="java-install-footer">
                <button class="btn btn-secondary" onclick="closeJavaInstallModal()">稍后安装</button>
                <button class="btn btn-primary" id="java-install-btn" onclick="startJavaAutoInstall(${requiredVersion})">
                    <span>自动安装 Java ${requiredVersion}</span>
                </button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    requestAnimationFrame(() => {
        const modal = document.getElementById('java-install-modal');
        if (modal) modal.classList.add('modal-visible');
    });

    loadJavaDownloadSources();
}

async function loadJavaDownloadSources() {
    try {
        const result = await API.getJavaDownloadSources();
        const listEl = document.getElementById('java-source-list');
        if (!listEl || !result.sources) return;

        result.sources.forEach(source => {
            const item = document.createElement('div');
            item.className = 'java-source-item';
            item.dataset.source = source.id;
            item.innerHTML = `
                <span class="java-source-dot"></span>
                <span class="java-source-name">${source.name}</span>
                <span class="java-source-desc">${source.description}</span>
            `;
            listEl.appendChild(item);
        });
    } catch (e) { console.error('[Java] Failed to load download sources:', e); }
}

function closeJavaInstallModal() {
    if (javaInstallPollTimer) { clearInterval(javaInstallPollTimer); javaInstallPollTimer = null; }
    const modal = document.getElementById('java-install-modal');
    if (modal) {
        modal.classList.remove('modal-visible');
        setTimeout(() => modal.remove(), 300);
    }
}

async function startJavaAutoInstall(requiredVersion) {
    const installBtn = document.getElementById('java-install-btn');
    const progressDiv = document.getElementById('java-install-progress');
    const footerDiv = document.getElementById('java-install-footer');
    const sourceList = document.getElementById('java-source-list');

    if (installBtn) installBtn.disabled = true;
    if (progressDiv) progressDiv.style.display = 'block';
    if (sourceList) sourceList.style.display = 'none';

    try {
        const result = await API.autoInstallJava(requiredVersion);

        if (result.success && result.sessionId) {
            pollJavaInstallProgress(result.sessionId, requiredVersion);
        } else {
            showToast('Java安装请求失败', 'error');
            if (installBtn) installBtn.disabled = false;
        }
    } catch (e) {
        showToast('Java安装请求失败: ' + e.message, 'error');
        if (installBtn) installBtn.disabled = false;
    }
}

function pollJavaInstallProgress(sessionId, requiredVersion) {
    const progressBar = document.getElementById('java-install-progress-bar');
    const progressText = document.getElementById('java-progress-text');
    const progressStatus = document.getElementById('java-progress-status');
    const progressSource = document.getElementById('java-progress-source');
    const progressSpeed = document.getElementById('java-progress-speed');
    const progressSize = document.getElementById('java-progress-size-text');
    const installBtn = document.getElementById('java-install-btn');

    if (javaInstallPollTimer) clearInterval(javaInstallPollTimer);

    javaInstallPollTimer = setInterval(async () => {
        try {
            const status = await API.getJavaInstallStatus(sessionId);

            if (progressBar) {
                progressBar.style.width = (status.progress || 0) + '%';
            }
            if (progressStatus) {
                const statusMap = {
                    'detecting': '🔍 检测Java环境...',
                    'pending': '⏳ 准备下载...',
                    'downloading': '📥 下载中...',
                    'configuring': '⚙️ 配置环境变量...',
                    'completed': '✅ 安装完成',
                    'failed': '❌ 安装失败'
                };
                progressStatus.textContent = statusMap[status.status] || status.message;
            }
            if (progressSource && status.source) {
                progressSource.textContent = `来源: ${status.source}`;
            }
            if (progressText) {
                progressText.textContent = status.message || '';
            }
            if (progressSpeed && status.speed) {
                progressSpeed.textContent = formatSpeed(status.speed);
            }
            if (progressSize && status.totalBytes) {
                progressSize.textContent = `${formatSize(status.downloadedBytes || 0)} / ${formatSize(status.totalBytes)}`;
            }

            if (status.status === 'completed') {
                clearInterval(javaInstallPollTimer);
                javaInstallPollTimer = null;

                if (status.result) {
                    const statJava = document.getElementById('stat-java');
                    if (statJava && status.result.majorVersion) {
                        statJava.textContent = status.result.majorVersion;
                    }
                    const javaPathInput = document.getElementById('setting-java-path');
                    if (javaPathInput && status.result.path) {
                        javaPathInput.value = status.result.path;
                    }
                }

                showToast('Java 安装成功！环境变量已自动配置', 'success');
                setTimeout(() => closeJavaInstallModal(), 1500);
            } else if (status.status === 'failed') {
                clearInterval(javaInstallPollTimer);
                javaInstallPollTimer = null;
                showToast(status.message || 'Java安装失败', 'error');
                if (installBtn) installBtn.disabled = false;
            }
        } catch (e) {
            clearInterval(javaInstallPollTimer);
            javaInstallPollTimer = null;
            showToast('获取安装状态失败', 'error');
            if (installBtn) installBtn.disabled = false;
        }
    }, 500);
}

async function ensureJavaForLaunch(requiredVersion) {
    try {
        const result = await API.detectJava();
        if (result.javaList && result.javaList.length > 0) {
            const suitable = result.javaList.find(j => j.majorVersion >= requiredVersion);
            if (suitable) return true;
        }

        showJavaInstallModal(requiredVersion);
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const modal = document.getElementById('java-install-modal');
                if (!modal) {
                    clearInterval(checkInterval);
                    API.detectJava().then(r => {
                        if (r.javaList) {
                            const suitable = r.javaList.find(j => j.majorVersion >= requiredVersion);
                            resolve(!!suitable);
                        } else {
                            resolve(false);
                        }
                    }).catch(() => resolve(false));
                }
            }, 500);
        });
    } catch (e) {
        return false;
    }
}

async function openFolder(folder) {
    try { await API.openFolder(folder); }
    catch (e) { showToast('无法打开文件夹', 'error'); }
}

function applyAccentColor(color) {
    if (!color || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    document.documentElement.style.setProperty('--accent', color);
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.3)`);
    document.documentElement.style.setProperty('--accent-hover', `rgba(${r}, ${g}, ${b}, 0.85)`);
}

function switchTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);

    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-hover');
    document.documentElement.style.removeProperty('--accent-rgb');

    if (typeof updateWallpaperTheme === 'function') {
        updateWallpaperTheme(themeName === 'dark');
    }

    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-theme') === themeName);
    });

    const themeDef = getComputedStyle(document.documentElement);
    const accentColor = themeDef.getPropertyValue('--accent').trim();

    const accentColorInput = document.getElementById('custom-accent-color');
    if (accentColorInput) accentColorInput.value = accentColor;
    const accentColorValueEl = document.getElementById('custom-color-value');
    if (accentColorValueEl) accentColorValueEl.textContent = accentColor;
    const colorPreviewDot = document.getElementById('color-preview-dot');
    if (colorPreviewDot) colorPreviewDot.style.background = accentColor;

    API.saveSetting('theme', themeName);
    API.saveSetting('accentColor', accentColor);
    window.electronAPI?.store?.set('versepc_theme', themeName).catch(() => {});

    showToast(`已切换到「${getThemeLabel(themeName)}」主题`, 'success');
}

function applyCustomAccent() {
    const colorInput = document.getElementById('custom-accent-color');
    const color = colorInput?.value;
    if (!color) return;
    const colorValueEl = document.getElementById('custom-color-value');
    if (colorValueEl) colorValueEl.textContent = color;
    applyAccentColor(color);
    API.saveSetting('accentColor', color);
    showToast('强调色已应用', 'success');
}

function getThemeLabel(themeName) {
    const labels = {
        dark: '黑色',
        light: '白色'
    };
    return labels[themeName] || themeName;
}

function browseFolder(type) {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        window.electronAPI.showOpenDialog({ properties: ['openDirectory'] }).then(result => {
            if (!result.canceled && result.filePaths.length > 0) {
                if (type === 'target') {
                    document.getElementById('setting-target-dir').value = result.filePaths[0];
                } else if (type === 'game') {
                    document.getElementById('setting-game-dir').value = result.filePaths[0];
                }
            }
        }).catch(() => {});
    } else {
        showToast('请手动输入路径', 'info');
    }
}

function updateHomeStats() {
    const el = document.getElementById('stat-installed');
    if (el) el.textContent = installedVersions.length;
}

async function pingServer() {
    const input = document.getElementById('server-ping-input');
    const hostPort = input.value.trim();
    if (!hostPort) { showToast('请输入服务器地址', 'error'); return; }

    let host, port = 25565;
    if (hostPort.includes(':')) {
        const parts = hostPort.split(':');
        host = parts[0];
        port = parseInt(parts[1]) || 25565;
    } else {
        host = hostPort;
    }

    const resultDiv = document.getElementById('server-ping-result');
    resultDiv.style.display = 'none';
    showToast('正在查询服务器状态...', 'info');

    try {
        const result = await API.pingServer(host, port);
        if (result.online) {
            document.getElementById('server-ping-version').textContent = result.version;
            document.getElementById('server-ping-players').textContent = `${result.players.online} / ${result.players.max} 在线`;
            const latencyEl = document.getElementById('server-ping-latency');
            latencyEl.textContent = `${result.latency}ms`;
            latencyEl.style.color = result.latency < 150 ? '#4ade80' : result.latency < 400 ? '#fbbf24' : '#ef4444';
            document.getElementById('server-ping-motd').textContent = result.description?.replace(/§[0-9a-fk-or]/g, '') || '';

            const iconEl = document.getElementById('server-ping-icon');
            if (result.favicon) {
                iconEl.src = result.favicon;
                iconEl.style.display = 'block';
            } else {
                iconEl.style.display = 'none';
            }

            resultDiv.style.display = 'block';
            showToast('服务器在线', 'success');
        } else {
            showToast('服务器离线或无法连接', 'error');
        }
    } catch (e) {
        showToast('查询失败: ' + e.message, 'error');
    }
}

let isWindowMode = false;
let isWindowMaximized = false;

function setupWindowControls() {
    const windowControls = document.getElementById('window-controls');
    const windowModeCheckbox = document.getElementById('setting-window-mode');
    const exitLauncherBtn = document.getElementById('exit-launcher-btn');

    if (windowControls) windowControls.style.display = 'flex';

    const winBtnMinimize = document.getElementById('win-btn-minimize');
    if (winBtnMinimize) winBtnMinimize.addEventListener('click', () => {
        window.electronAPI.minimize();
    });

    const winBtnMaximize = document.getElementById('win-btn-maximize');
    if (winBtnMaximize) winBtnMaximize.addEventListener('click', () => {
        window.electronAPI.maximize();
    });

    const winBtnRestore = document.getElementById('win-btn-restore');
    if (winBtnRestore) winBtnRestore.addEventListener('click', () => {
        window.electronAPI.maximize();
    });

    const winBtnClose = document.getElementById('win-btn-close');
    if (winBtnClose) winBtnClose.addEventListener('click', () => {
        window.electronAPI.close();
    });

    window.electronAPI.onWindowStateChanged((data) => {
        isWindowMaximized = data.maximized;
        isWindowMode = !data.fullscreen;
        if (windowModeCheckbox) {
            windowModeCheckbox.checked = isWindowMode;
        }
        updateWindowButtons();
    });

    window.electronAPI.onWindowModeChanged((data) => {
        isWindowMode = data.windowMode;
        isWindowMaximized = data.maximized;
        if (windowModeCheckbox) {
            windowModeCheckbox.checked = data.windowMode;
        }
        updateWindowButtons();
    });

    if (windowModeCheckbox) {
        windowModeCheckbox.addEventListener('change', () => {
            const enabled = windowModeCheckbox.checked;
            isWindowMode = enabled;
            window.electronAPI.setWindowMode(enabled);
            updateWindowButtons();
        });
    }

    if (exitLauncherBtn) {
        exitLauncherBtn.addEventListener('click', () => {
            window.electronAPI.quitApp();
        });
    }

    window.electronAPI.isFullscreen().then((fullscreen) => {
        isWindowMode = !fullscreen;
        if (windowModeCheckbox) {
            windowModeCheckbox.checked = isWindowMode;
        }
        updateWindowButtons();
    });
}

function setupVersionListClicks() {
    document.addEventListener('click', (e) => {
        const versionItem = e.target.closest('.version-item-clickable');
        if (versionItem && !e.target.closest('button')) {
            const versionId = versionItem.dataset.versionId;
            const versionUrl = versionItem.dataset.versionUrl || '';
            const versionType = versionItem.dataset.versionType || 'release';
            const isInstalled = versionItem.dataset.installed === 'true';
            const customName = versionItem.dataset.customName || '';
            
            if (versionId) {
                console.log('Version item clicked:', versionId, 'installed:', isInstalled);
                if (isInstalled) {
                    openVersionSettings(versionId, customName || versionId);
                } else {
                    openVersionDetail(versionId, versionUrl, versionType);
                }
            }
        }
    });
}

function updateWindowButtons() {
    const controls = document.getElementById('window-controls');
    const maximizeBtn = document.getElementById('win-btn-maximize');
    const restoreBtn = document.getElementById('win-btn-restore');

    if (!controls) return;

    controls.style.display = 'flex';
    if (isWindowMode) {
        if (isWindowMaximized) {
            maximizeBtn.style.display = 'none';
            restoreBtn.style.display = 'flex';
        } else {
            maximizeBtn.style.display = 'flex';
            restoreBtn.style.display = 'none';
        }
    } else {
        maximizeBtn.style.display = 'flex';
        restoreBtn.style.display = 'none';
    }
}

const resourceState = {
    modpack: { offset: 0, total: 0, query: '' },
    datapack: { offset: 0, total: 0, query: '' },
    resourcepack: { offset: 0, total: 0, query: '' },
    shader: { offset: 0, total: 0, query: '' },
};

const typeNames = {
    modpack: '整合包', datapack: '数据包',
    resourcepack: '材质包', shader: '光影包'
};

const typeIcons = {
    modpack: '📦', datapack: '🗄️',
    resourcepack: '🎨', shader: '☀️'
};

async function importModpackFromFile() {
    try {
        const result = await API.selectModpackFile();
        if (result && result.filePath) {
            const filePath = result.filePath;
            showToast('正在导入整合包...', 'info');
            const importResult = await window.electronAPI.importModpack(filePath, '');
            if (importResult && importResult.success) {
                showToast(`整合包 "${importResult.name || '未知'}" 导入成功！`, 'success');
            } else {
                showToast(`导入失败: ${importResult?.error || '未知错误'}`, 'error');
            }
        }
    } catch (e) {
        showToast('导入失败: ' + (e.message || ''), 'error');
    }
}

function loadResourcePage(type) {
    const state = resourceState[type];
    state.offset = 0;
    state.query = '';
    loadResourceList(type);
    setupResourceEvents(type);
}

function loadInstalledModpacks() {
    const container = document.getElementById('modpack-browse-list');
    if (!container) return;

    const modpackVersions = installedVersions.filter(v => v.isModpack);

    if (modpackVersions.length === 0) {
        container.innerHTML = '<p class="empty-text">暂无已安装的整合包</p>';
    } else {
        container.innerHTML = modpackVersions.map(v => {
            const iconParams = `id=${encodeURIComponent(v.id)}&type=release`;
            const modpackParam = '&modpack=true';
            const iconUrl = `/api/version-icon?${iconParams}${modpackParam}&_t=${versionIconsTimestamp}`;
            const displayName = v.customName || v.id;
            const badge = v.modpackLoader || '整合包';
            return `<div class="version-grid-item" onclick="openVersionSettings('${escapeOnclick(v.id)}','${escapeOnclick(displayName)}')" style="cursor:pointer">
                <div class="v-icon"><img src="${iconUrl}" alt="" class="version-icon-img"></div>
                <span class="v-name">${displayName}</span>
                <span class="v-badge modpack">${badge}</span>
            </div>`;
        }).join('');
    }

    const pageInfo = document.getElementById('modpack-page-info');
    if (pageInfo) pageInfo.textContent = '';
}

function setupResourceEvents(type) {
    const searchInput = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-search-input`);
    const searchBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-search-btn`);
    const prevBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-prev-btn`);
    const nextBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-next-btn`);

    const prefix = type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack';

    if (searchBtn && !searchBtn._bound) {
        searchBtn._bound = true;
        searchBtn.addEventListener('click', () => {
            resourceState[type].query = searchInput.value.trim();
            resourceState[type].offset = 0;
            loadResourceList(type);
        });
    }
    if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                resourceState[type].query = searchInput.value.trim();
                resourceState[type].offset = 0;
                loadResourceList(type);
            }
        });
    }
    if (prevBtn && !prevBtn._bound) {
        prevBtn._bound = true;
        prevBtn.addEventListener('click', () => {
            if (resourceState[type].offset >= 15) {
                resourceState[type].offset -= 15;
                loadResourceList(type);
            }
        });
    }
    if (nextBtn && !nextBtn._bound) {
        nextBtn._bound = true;
        nextBtn.addEventListener('click', () => {
            resourceState[type].offset += 15;
            loadResourceList(type);
        });
    }

    const loaderInstance = customSelectInstances[`${prefix}-filter-loader`];
    const versionInstance = customSelectInstances[`${prefix}-filter-version`];
    if (loaderInstance && !loaderInstance._resourceBound) {
        loaderInstance._resourceBound = true;
        loaderInstance.onChange = () => {
            resourceState[type].offset = 0;
            loadResourceList(type);
        };
    }
    if (versionInstance && !versionInstance._resourceBound) {
        versionInstance._resourceBound = true;
        const origOnChange = versionInstance.onChange;
        versionInstance.onChange = () => {
            if (origOnChange) origOnChange();
            resourceState[type].offset = 0;
            loadResourceList(type);
        };
    }
    if (type === 'resourcepack') {
        const resolutionInstance = customSelectInstances['resourcepack-filter-resolution'];
        if (resolutionInstance && !resolutionInstance._resourceBound) {
            resolutionInstance._resourceBound = true;
            resolutionInstance.onChange = () => {
                resourceState[type].offset = 0;
                loadResourceList(type);
            };
        }
    }
}

async function loadResourceList(type) {
    const prefix = type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack';
    const container = document.getElementById(`${prefix}-browse-list`);
    if (!container) return;
    container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>正在获取${typeNames[type] || '资源'}列表...</p></div>`;

    const state = resourceState[type];
    const loader = getCustomSelectValue(`${prefix}-filter-loader`);
    const version = getCustomSelectValue(`${prefix}-filter-version`);
    const resolution = type === 'resourcepack' ? getCustomSelectValue('resourcepack-filter-resolution') : '';

    try {
        const data = await API.searchResources(state.query, type, loader, version, resolution, 'downloads', 15, state.offset);
        const hits = data.hits || [];
        state.total = data.total || 0;

        if (hits.length === 0) {
            if (state.query) {
                container.innerHTML = `<p class="empty-text">暂无匹配的${typeNames[type]}</p><p class="empty-hint">试试其他关键词吧</p>`;
            } else {
                container.innerHTML = `<p class="empty-text">暂无${typeNames[type]}</p>`;
            }
        } else {
            container.innerHTML = hits.map(item => `
                <div class="mod-item mod-item-clickable" onclick="openResourceDetail('${item.id}', '${type}')">
                    ${item.icon ? `<div class="mod-icon"><img src="${item.icon}" alt="" onerror="this.parentElement.remove()"></div>` : ''}
                    <div class="mod-info">
                        <div class="mod-name">${escapeHtml(formatModNameWithChinese(item.id || item.slug, item.title))}</div>
                        <div class="mod-desc">${escapeHtml(item.description)}</div>
                        <div class="mod-meta">
                            <span>⬇ ${formatNumber(item.downloads)}</span>
                            <span>❤ ${escapeHtml(item.author)}</span>
                            <span>${(item.categories || []).slice(0, 3).join(', ')}</span>
                        </div>
                    </div>
                    <div class="mod-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openResourceDetail('${item.id}', '${type}')">安装</button>
                    </div>
                </div>
            `).join('');
        }

        const pageInfo = document.getElementById(`${prefix}-page-info`);
        const totalPages = Math.max(1, Math.ceil(state.total / 15));
        const currentPage = Math.floor(state.offset / 15) + 1;
        if (pageInfo) pageInfo.textContent = `${currentPage}/${totalPages}`;
    } catch (e) {
        container.innerHTML = `<p class="empty-text">加载失败</p><button class="btn btn-secondary btn-sm" onclick="loadResourceList('${type}')" style="margin-top:8px">重试</button>`;
    }
}

async function openResourceDetail(projectId, type) {
    currentModDetailId = projectId;
    currentModDetailSource = 'modrinth';
    currentModDetailType = type;

    navigateToPage('mod-detail');

    const depsSection = document.getElementById('md-deps-section');
    if (depsSection) depsSection.style.display = 'none';
    if (type !== 'mod' && modMultiSelectMode) {
        modMultiSelectMode = false;
    }
    mdCurrentDeps = [];
    mdDepsResolved = {};
    mdDepsVersionInfo = {};

    const backBtn = document.querySelector('#page-mod-detail .moddetail-page-header .btn-icon');
    if (backBtn) {
        const pageMap = { mod: 'mods', modpack: 'modpacks', datapack: 'datapacks', resourcepack: 'resourcepacks', shader: 'shaders' };
        backBtn.setAttribute('onclick', `navigateToPage('${pageMap[type] || 'mods'}')`);
    }

    const mdName = document.getElementById('md-name');
    const mdDesc = document.getElementById('md-desc');
    const mdIconImg = document.getElementById('md-icon-img');
    const mdIconFallback = document.getElementById('md-icon-fallback');
    const mdVersionList = document.getElementById('md-version-list');
    const mdVersionTabs = document.getElementById('md-version-tabs');

    if (!mdName || !mdVersionList) return;

    const typeNames = { mod: '模组', modpack: '整合包', resourcepack: '材质包', shader: '光影包', datapack: '数据包' };
    const typeIcons = { mod: '🧩', modpack: '📦', resourcepack: '🎨', shader: '✨', datapack: '📊' };

    mdName.textContent = '加载中...';
    if (mdDesc) mdDesc.textContent = '';
    if (mdIconImg) mdIconImg.style.display = 'none';
    if (mdIconFallback) mdIconFallback.style.display = 'none';
    mdVersionList.innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">加载中...</p>';
    if (mdVersionTabs) mdVersionTabs.innerHTML = '';

    try {
        const detail = await API.getResourceDetail(projectId);
        currentModDetailData = detail;

        mdName.textContent = formatModNameWithChinese(detail.id || detail.slug, detail.title || typeNames[type] || '未知');
        if (mdDesc) mdDesc.textContent = (detail.description || '').substring(0, 200);

        if (detail.icon && mdIconImg && mdIconFallback) {
            mdIconImg.src = detail.icon;
            mdIconImg.style.display = '';
            mdIconFallback.style.display = 'none';
        } else {
            if (mdIconImg) mdIconImg.style.display = 'none';
            if (mdIconFallback) mdIconFallback.style.display = 'none';
        }

        const mdDownloads = document.getElementById('md-downloads');
        const mdFollowers = document.getElementById('md-followers');
        const mdUpdated = document.getElementById('md-updated');
        const srcBadge = document.getElementById('md-source-badge');

        if (mdDownloads) mdDownloads.textContent = `⬇ ${formatNumber(detail.downloads || 0)}`;
        if (mdFollowers) mdFollowers.textContent = `❤ ${formatNumber(detail.followers || 0)}`;
        if (mdUpdated) mdUpdated.textContent = '';
        if (srcBadge) {
            srcBadge.textContent = typeNames[type] || type;
            srcBadge.style.color = '#f59e0b';
            srcBadge.style.background = 'rgba(245,158,11,0.12)';
        }

        const data = await API.getResourceVersions(projectId);
        mdAllVersions = data.versions || [];
        if (!Array.isArray(mdAllVersions)) mdAllVersions = [];

        const currentGameVersion = document.getElementById('mod-filter-version')?.value || '';
        const currentLoader = document.getElementById('mod-filter-loader')?.value || '';

        if (currentGameVersion || currentLoader) {
            const filtered = mdAllVersions.filter(v => {
                const gv = v.gameVersions || [];
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                let match = true;
                if (currentGameVersion && !gv.includes(currentGameVersion)) match = false;
                if (currentLoader && !loaders.includes(currentLoader.toLowerCase())) match = false;
                return match;
            });
            renderMdVersionList(filtered);
            
            if (mdVersionTabs) {
                mdVersionTabs.innerHTML = `<button class="md-vtab active" data-ver="_filtered" onclick="switchMdVersionTab('_filtered')">筛选结果 (${filtered.length})</button><button class="md-vtab" data-ver="" onclick="switchMdVersionTab('')">全部 (${mdAllVersions.length})</button>`;
            }
        } else {
            const tabsContainer = document.getElementById('md-version-tabs');
            const gameVersions = new Set();
            mdAllVersions.forEach(v => {
                (v.gameVersions || []).forEach(gv => gameVersions.add(gv));
            });

            let tabsHtml = '<button class="md-vtab active" data-ver="" onclick="switchMdVersionTab(\'\')">全部</button>';
            [...gameVersions].sort().reverse().forEach(gv => {
                tabsHtml += `<button class="md-vtab" data-ver="${escapeHtml(gv)}" onclick="switchMdVersionTab('${escapeOnclick(gv)}')">${escapeHtml(gv)}</button>`;
            });
            if (tabsContainer) tabsContainer.innerHTML = tabsHtml;
            
            renderMdVersionList(mdAllVersions);
        }
    } catch (e) {
        mdName.textContent = '加载失败';
        mdVersionList.innerHTML = `<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">无法加载详情: ${e.message || e}</p>`;
    }
}

// 全局变量：当前整合包详情的目标版本
async function quickInstallResource(projectId, type) {
    if (type === 'modpack') {
        showToast('正在下载整合包，将创建为新版本...', 'info');
        try {
            const result = await API.downloadResource('', projectId, type, '');
            if (result.success) {
                showModpackInstallModal(result.fileName, result.sessionId);
            } else {
                showToast(result.error || '安装失败', 'error');
            }
        } catch (e) {
            showToast('安装失败', 'error');
        }
    } else {
        showToast(`正在安装${typeNames[type]}...`, 'info');
        try {
            const result = await API.downloadResource('', projectId, type);
            if (result.success) {
                showModDownloadModal(result.fileName, result.sessionId);
            } else {
                showToast(result.error || '安装失败', 'error');
            }
        } catch (e) {
            showToast('安装失败', 'error');
        }
    }
}

// 显示版本选择对话框
async function showVersionSelectDialog() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
        
        modal.innerHTML = `
            <div style="background:var(--bg-secondary,#1a1a2e);border-radius:12px;padding:24px;min-width:320px;max-width:400px;border:1px solid var(--border-color,rgba(255,255,255,0.1));">
                <h3 style="margin:0 0 16px;color:var(--text-primary,#fff);">选择目标版本</h3>
                <p style="margin:0 0 16px;color:var(--text-muted,#aaa);font-size:13px;">整合包将安装到所选版本中</p>
                <select id="version-select-dialog" style="width:100%;padding:10px 12px;background:var(--bg-input,#252540);border:1px solid var(--border-color,rgba(255,255,255,0.15));border-radius:8px;color:var(--text-primary,#fff);font-size:14px;">
                    <option value="">加载中...</option>
                </select>
                <div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
                    <button id="version-select-cancel" style="padding:8px 16px;background:transparent;border:1px solid var(--border-color,rgba(255,255,255,0.2));border-radius:6px;color:var(--text-secondary,#ccc);cursor:pointer;">取消</button>
                    <button id="version-select-confirm" style="padding:8px 16px;background:var(--accent,#60a5fa);border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:500;">确认安装</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const select = modal.querySelector('#version-select-dialog');
        const cancelBtn = modal.querySelector('#version-select-cancel');
        const confirmBtn = modal.querySelector('#version-select-confirm');
        
        // 加载版本列表
        API.getVersions().then(versions => {
            select.innerHTML = '';
            const installed = (versions || []).filter(v => v.id && v.type !== '(old)');
            if (installed.length === 0) {
                select.innerHTML = '<option value="">没有已安装的版本</option>';
            } else {
                installed.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    opt.textContent = v.name || v.id;
                    select.appendChild(opt);
                });
            }
        }).catch(() => {
            select.innerHTML = '<option value="">加载失败</option>';
        });
        
        const close = (result) => {
            document.body.removeChild(modal);
            resolve(result);
        };
        
        cancelBtn.addEventListener('click', () => close(''));
        confirmBtn.addEventListener('click', () => close(select.value));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close('');
        });
    });
}

let currentSettingsVersionId = null;
let currentVersionSettings = null;

async function openVersionSettings(versionId, versionName) {
    currentSettingsVersionId = versionId;
    document.getElementById('vset-title').textContent = '版本设置 - ' + (versionName || versionId);
    document.getElementById('export-name').value = versionName || versionId;

    const versionInfo = installedVersions.find(v => v.id === versionId);
    const externalInfoEl = document.getElementById('vset-external-info');
    if (externalInfoEl) {
        if (versionInfo && versionInfo.isExternal) {
            externalInfoEl.style.display = 'block';
            externalInfoEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;background:rgba(255,165,0,0.08);border:1px solid rgba(255,165,0,0.2)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="#ffa500" stroke-width="2" style="width:18px;height:18px;flex-shrink:0"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    <div>
                        <div style="font-size:13px;color:var(--text-primary);font-weight:500">外部文件夹版本</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;word-break:break-all">${escapeHtml(versionInfo.externalPath || '')}</div>
                    </div>
                </div>`;
        } else {
            externalInfoEl.style.display = 'none';
        }
    }
    
    API.saveSetting('selectedVersion', versionId).catch(e => {
        console.error('[VersionSettings] Failed to set selectedVersion:', e);
    });
    
    navigateToPage('version-settings');
    document.querySelector('.content-area').classList.add('no-scroll');
    switchVSetTab('overview');
    loadInstalledModsForSettings();
    loadExportTreeData();
    loadVersionSettingsUI();
}

async function loadVersionSettingsUI() {
    if (!currentSettingsVersionId) return;
    try {
        const settings = await API.getVersionSettings(currentSettingsVersionId);
        currentVersionSettings = settings;

        if (customSelectInstances['vset-icon-type']) {
            customSelectInstances['vset-icon-type'].setValue(settings.icon || 'auto');
        }

        if (customSelectInstances['vset-category']) {
            customSelectInstances['vset-category'].setValue(settings.category || 'auto');
        }

        const isolationSelect = document.getElementById('vset-isolation');
        if (isolationSelect) {
            const versionInfo = installedVersions.find(v => v.id === currentSettingsVersionId);
            const isExternal = versionInfo && versionInfo.isExternal;
            isolationSelect.value = settings.isolation || (isExternal ? 'on' : 'global');
        }

        const windowTitle = document.getElementById('vset-window-title');
        if (windowTitle) windowTitle.value = settings.windowTitle || '';

        const customInfo = document.getElementById('vset-custom-info');
        if (customInfo) customInfo.value = settings.customInfo || '';

        const javaSelect = document.getElementById('vset-java');
        if (javaSelect || customSelectInstances['vset-java']) {
            try {
                const javaData = await API.getInstalledJava();
                const javaList = javaData.java || [];
                const options = [
                    { value: 'global', text: '跟随全局设置' },
                    ...javaList.map(j => ({
                        value: j.path || j.executable || '',
                        text: `${j.version || j.name || 'Java'}${j.arch ? ' (' + j.arch + ')' : ''}${j.majorVersion ? ' [' + j.majorVersion + ']' : ''}`
                    }))
                ];

                if (!customSelectInstances['vset-java']) {
                    customSelectInstances['vset-java'] = new CustomSelect('vset-java-wrapper', {
                        onChange: (value) => saveCurrentVersionSetting('javaPath', value)
                    });
                }

                customSelectInstances['vset-java'].setOptions(options);

                if (settings.javaPath) {
                    customSelectInstances['vset-java'].setValue(settings.javaPath);
                }
            } catch (e) {
                console.error('[VersionSettings] Load Java list error:', e);
            }
        }

        const memoryMode = document.querySelector(`input[name="memoryMode"][value="${settings.memoryMode || 'global'}"]`);
        if (memoryMode) memoryMode.checked = true;

        const memoryCustom = document.getElementById('vset-memory-custom');
        if (memoryCustom) memoryCustom.style.display = settings.memoryMode === 'custom' ? 'block' : 'none';

        const memoryValue = document.getElementById('vset-memory-value');
        if (memoryValue) memoryValue.value = settings.memoryValue || 4096;

        const memoryDisplay = document.getElementById('vset-memory-display');
        if (memoryDisplay) memoryDisplay.textContent = (settings.memoryValue || 4096) + ' MB';

        const memOptimize = document.getElementById('vset-mem-optimize');
        if (memOptimize) memOptimize.value = settings.memOptimize || 'global';

        const jvmArgsInput = document.getElementById('vset-jvm-args');
        if (jvmArgsInput) jvmArgsInput.value = settings.jvmArgs || '';

        const gameArgsInput = document.getElementById('vset-game-args');
        if (gameArgsInput) gameArgsInput.value = settings.gameArgs || '';

        const favBtn = document.querySelector('[onclick="addToFavorites()"]');
        if (favBtn) favBtn.textContent = settings.favorite ? '取消收藏' : '加入收藏夹';
    } catch (e) {
        console.error('[VersionSettings] Load settings error:', e);
    }
}

function saveCurrentVersionSetting(key, value) {
    if (!currentSettingsVersionId) return;
    const data = { versionId: currentSettingsVersionId, [key]: value };
    API.saveVersionSettings(data).then(r => {
        if (r.success) {
            if (currentVersionSettings) currentVersionSettings[key] = value;
        }
    }).catch(e => console.error('[VersionSettings] Save error:', e));
}

function closeVersionSettings() {
    currentSettingsVersionId = null;
    currentVersionSettings = null;
    document.querySelector('.content-area').classList.remove('no-scroll');
    navigateToPage(previousPage || 'home');
}

function switchVSetTab(tabName) {
    document.querySelectorAll('.vset-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelector(`.vset-nav-item[data-tab="${tabName}"]`)?.classList.add('active');

    document.querySelectorAll('.vset-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`vset-panel-${tabName}`);
    if (panel) panel.classList.add('active');

    if (tabName === 'modmgr') {
        const versionInfo = installedVersions.find(v => v.id === currentSettingsVersionId);
        const isVanilla = versionInfo && !versionInfo.isFabric && !versionInfo.isForge && !versionInfo.isNeoForge;
        const modList = document.getElementById('modmgr-mod-list');
        const modHeader = panel?.querySelector('.modmgr-header-row');
        const modActions = panel?.querySelector('.modmgr-actions');
        if (isVanilla) {
            if (modHeader) modHeader.style.display = 'none';
            if (modActions) modActions.style.display = 'none';
            if (modList) {
                modList.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" style="width:48px;height:48px;margin-bottom:16px;opacity:0.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                        <div style="font-size:16px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">原版不支持安装模组</div>
                        <div style="font-size:13px;color:var(--text-muted);max-width:320px;line-height:1.6;">此版本为 Minecraft 原版，没有模组加载器。如需安装模组，请先安装 Fabric、Forge 或 NeoForge 模组加载器。</div>
                    </div>`;
            }
        } else {
            if (modHeader) modHeader.style.display = '';
            if (modActions) modActions.style.display = '';
            loadInstalledModsForSettings();
        }
    }
}

function openVersionFolder() {
    if (!currentSettingsVersionId) return;
    API.openVersionFolder(currentSettingsVersionId, 'version');
}

function openSavesFolder() {
    if (!currentSettingsVersionId) return;
    API.openVersionFolder(currentSettingsVersionId, 'saves');
}

function openModsFolder() {
    if (!currentSettingsVersionId) return;
    API.openVersionFolder(currentSettingsVersionId, 'mods');
}

let _checkingModUpdates = false;

async function checkModUpdatesForVersion() {
    if (!currentSettingsVersionId) {
        showToast('请先选择一个版本', 'error');
        return;
    }
    if (_checkingModUpdates) {
        showToast('正在检查更新，请稍候...', 'info');
        return;
    }
    _checkingModUpdates = true;
    showToast('正在检查模组更新...', 'info');
    try {
        const result = await API.checkModUpdates(currentSettingsVersionId);
        if (result.error) {
            showToast('检查更新失败: ' + result.error, 'error');
            return;
        }
        const updates = result.updates || [];
        if (updates.length === 0) {
            showToast(`已检查 ${result.checked || 0} 个模组，暂无更新`, 'success');
            return;
        }
        showModUpdateDialog(updates, result.checked || 0);
    } catch (e) {
        showToast('检查更新失败: ' + (e.message || '未知错误'), 'error');
    } finally {
        _checkingModUpdates = false;
    }
}

function showModUpdateDialog(updates, checkedCount) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--bg-primary);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:70vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

    const listHtml = updates.map(u => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-color);">
            <div style="flex:1;min-width:0;">
                <div style="font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(u.modName)}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escapeHtml(u.fileName)} | 当前版本: ${escapeHtml(u.currentVersion)}</div>
            </div>
            <a href="${u.projectUrl}" target="_blank" style="color:var(--accent);font-size:13px;text-decoration:none;white-space:nowrap;margin-left:12px;">查看更新</a>
        </div>
    `).join('');

    dialog.innerHTML = `
        <h3 style="margin:0 0 4px 0;color:var(--text-primary);">模组更新检查</h3>
        <p style="margin:0 0 16px 0;font-size:13px;color:var(--text-muted);">已检查 ${checkedCount} 个模组，发现 ${updates.length} 个可在 Modrinth 上找到</p>
        <div>${listHtml}</div>
        <div style="margin-top:16px;text-align:right;">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">关闭</button>
        </div>
    `;

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

function renameCurrentVersion() {
    if (!currentSettingsVersionId) return;
    const newName = prompt('请输入新的版本名称：', '');
    if (!newName) return;
    API.renameVersion(currentSettingsVersionId, newName).then(() => {
        showToast('版本名已修改', 'success');
        document.getElementById('vset-title').textContent = '版本设置 - ' + newName;
    }).catch(e => showToast(e.message || '修改失败', 'error'));
}

function editVersionDesc() {
    if (!currentSettingsVersionId) return;
    const currentDesc = currentVersionSettings?.description || '';
    const newDesc = prompt('请输入版本描述：', currentDesc);
    if (newDesc === null) return;
    API.setVersionDescription(currentSettingsVersionId, newDesc).then(r => {
        if (r.success) {
            showToast('版本描述已修改', 'success');
            if (currentVersionSettings) currentVersionSettings.description = newDesc;
        } else {
            showToast(r.error || '修改失败', 'error');
        }
    }).catch(e => showToast(e.message || '修改失败', 'error'));
}

function addToFavorites() {
    if (!currentSettingsVersionId) return;
    const isFav = currentVersionSettings?.favorite || false;
    const newState = !isFav;
    API.setVersionFavorite(currentSettingsVersionId, newState).then(r => {
        if (r.success) {
            showToast(newState ? '已加入收藏夹' : '已取消收藏', 'success');
            if (currentVersionSettings) currentVersionSettings.favorite = newState;
            const favBtn = document.querySelector('[onclick="addToFavorites()"]');
            if (favBtn) favBtn.textContent = newState ? '取消收藏' : '加入收藏夹';
        } else {
            showToast(r.error || '操作失败', 'error');
        }
    }).catch(e => showToast(e.message || '操作失败', 'error'));
}

function exportLaunchScript() {
    if (!currentSettingsVersionId) return;
    API.exportLaunchScript(currentSettingsVersionId).then(r => {
        if (r.success) showToast('启动脚本已导出', 'success');
        else showToast(r.error || '导出失败', 'error');
    });
}

let currentRepairSessionId = null;
let repairPollTimer = null;

function showRepairModal(versionId) {
    document.getElementById('repair-modal-title').textContent = `文件修复 - ${versionId}`;
    document.getElementById('repair-progress-fill').style.width = '0%';
    document.getElementById('repair-stage').textContent = '准备中...';
    document.getElementById('repair-percent').textContent = '0%';
    document.getElementById('repair-message').textContent = '';
    document.getElementById('repair-file-count').textContent = '';
    document.getElementById('repair-cancel-btn').style.display = '';
    showModal('repair-modal');
}

function closeRepairModal() {
    hideModal('repair-modal');
    if (repairPollTimer) { clearTimeout(repairPollTimer); repairPollTimer = null; }
    currentRepairSessionId = null;
}

function cancelRepair() {
    if (currentRepairSessionId) {
        API.repairCancel(currentRepairSessionId);
        currentRepairSessionId = null;
    }
    if (repairPollTimer) { clearTimeout(repairPollTimer); repairPollTimer = null; }
    document.getElementById('repair-stage').textContent = '修复已取消';
    document.getElementById('repair-cancel-btn').style.display = 'none';
    showToast('修复已取消', 'info');
    setTimeout(() => hideModal('repair-modal'), 1500);
}

function getRepairStageText(stage) {
    const map = {
        'preparing': '准备修复...',
        'directories': '检查目录结构...',
        'resolve': '解析版本信息...',
        'scanning': '扫描库文件...',
        'client_jar': '检查客户端JAR...',
        'downloading': '下载缺失文件...',
        'complete': '修复完成',
        'failed': '修复失败',
        'cancelled': '已取消'
    };
    return map[stage] || stage || '';
}

function pollRepairProgress(sessionId) {
    const poll = async () => {
        try {
            const data = await API.repairProgress(sessionId);
            const fill = document.getElementById('repair-progress-fill');
            const stage = document.getElementById('repair-stage');
            const percent = document.getElementById('repair-percent');
            const message = document.getElementById('repair-message');
            const fileCount = document.getElementById('repair-file-count');

            if (fill) fill.style.width = `${data.progress || 0}%`;
            if (stage) stage.textContent = getRepairStageText(data.stage);
            if (percent) percent.textContent = `${Math.round(data.progress || 0)}%`;
            if (message) message.textContent = data.message || '';

            if (fileCount) {
                const parts = [];
                if (data.checkedFiles !== undefined && data.totalFiles !== undefined) {
                    parts.push(`已检查: ${data.checkedFiles}/${data.totalFiles}`);
                }
                if (data.missingFiles !== undefined) {
                    parts.push(`缺失: ${data.missingFiles}`);
                }
                if (data.repairedFiles !== undefined) {
                    parts.push(`已修复: ${data.repairedFiles}`);
                }
                if (data.currentFile) {
                    parts.push(`当前: ${data.currentFile}`);
                }
                fileCount.textContent = parts.join(' | ');
            }

            if (data.status === 'completed') {
                document.getElementById('repair-progress-fill').style.width = '100%';
                document.getElementById('repair-percent').textContent = '100%';
                document.getElementById('repair-cancel-btn').style.display = 'none';
                showToast(data.message || '文件修复完成！', 'success');
                currentRepairSessionId = null;
                setTimeout(() => hideModal('repair-modal'), 2000);
                return;
            }
            if (data.status === 'failed') {
                document.getElementById('repair-stage').textContent = '修复失败';
                document.getElementById('repair-cancel-btn').style.display = 'none';
                showToast(data.message || '文件修复失败', 'error');
                currentRepairSessionId = null;
                return;
            }
            if (data.status === 'cancelled') {
                currentRepairSessionId = null;
                return;
            }
            repairPollTimer = setTimeout(poll, 500);
        } catch (e) {
            repairPollTimer = setTimeout(poll, 1000);
        }
    };
    poll();
}

async function repairFiles() {
    if (!currentSettingsVersionId) return;

    showRepairModal(currentSettingsVersionId);

    try {
        const result = await API.repairStart(currentSettingsVersionId);
        if (result.success && result.sessionId) {
            currentRepairSessionId = result.sessionId;
            pollRepairProgress(result.sessionId);
        } else {
            document.getElementById('repair-stage').textContent = '启动失败';
            document.getElementById('repair-message').textContent = result.error || '无法启动修复';
            document.getElementById('repair-cancel-btn').style.display = 'none';
            showToast(result.error || '启动修复失败', 'error');
        }
    } catch (e) {
        document.getElementById('repair-stage').textContent = '启动失败';
        document.getElementById('repair-message').textContent = '网络错误，请重试';
        document.getElementById('repair-cancel-btn').style.display = 'none';
        showToast('启动修复失败: ' + e.message, 'error');
    }
}

async function diagnoseVersion() {
    if (!currentSettingsVersionId) {
        showToast('请先选择一个游戏版本', 'error');
        return;
    }

    try {
        const result = await API.diagnoseVersion(currentSettingsVersionId);
        showDiagnoseDialog(result);
    } catch (e) {
        showToast('诊断失败: ' + e.message, 'error');
    }
}

function showDiagnoseDialog(result) {
    const issues = result.issues || [];
    const typeColors = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
    const typeLabels = { critical: '严重', warning: '警告', info: '信息' };

    let html = issues.map(issue => `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:6px;background:var(--bg-active);margin-bottom:6px;">
            <span style="color:${typeColors[issue.type]};font-weight:600;min-width:36px;">${typeLabels[issue.type]}</span>
            <div>
                <div style="font-size:13px;">${issue.message}</div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${issue.solution}</div>
            </div>
        </div>
    `).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
        <div class="modal-content" style="width:520px;min-height:auto;max-height:80vh;">
            <div class="modal-header">
                <h3>版本诊断结果</h3>
                <button class="modal-close diagnose-close" aria-label="关闭对话框">&times;</button>
            </div>
            <div class="modal-body" style="overflow-y:auto;max-height:60vh;">
                ${html}
            </div>
            <div class="modal-footer">
                <button class="modal-btn modal-btn--secondary diagnose-close">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('modal-visible'));

    const close = () => {
        overlay.classList.add('modal-exiting');
        overlay.classList.remove('modal-visible');
        setTimeout(() => {
            if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
        }, 200);
    };

    overlay.querySelectorAll('.diagnose-close').forEach(btn => btn.addEventListener('click', close));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

async function deleteCurrentVersion() {
    if (!currentSettingsVersionId) {
        showToast('未找到版本信息', 'error');
        return;
    }
    const confirmed = await showConfirmDialog('删除版本', '确定要删除此版本吗？此操作不可撤销！', '删除', '取消');
    if (!confirmed) return;
    try {
        const r = await API.deleteVersionById(currentSettingsVersionId);
        if (r.success) {
            showToast('版本已删除', 'success');
            closeVersionSettings();
            loadVersions();
        } else {
            showToast(r.error || '删除失败', 'error');
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
}

document.querySelectorAll('input[name="memoryMode"]').forEach(r => {
    r.addEventListener('change', function() {
        document.getElementById('vset-memory-custom').style.display = this.value === 'custom' ? 'block' : 'none';
        saveCurrentVersionSetting('memoryMode', this.value);
    });
});

const memSlider = getDOMElement('vset-memory-value');
if (memSlider) {
    const memDisplay = getDOMElement('vset-memory-display');
    memSlider.addEventListener('input', throttle(function() {
        if (memDisplay) memDisplay.textContent = this.value + ' MB';
    }, 50));
    memSlider.addEventListener('change', function() {
        saveCurrentVersionSetting('memoryValue', parseInt(this.value, 10));
    });
}


document.getElementById('vset-isolation')?.addEventListener('change', function() {
    saveCurrentVersionSetting('isolation', this.value);
});

document.getElementById('vset-window-title')?.addEventListener('change', function() {
    saveCurrentVersionSetting('windowTitle', this.value);
});

document.getElementById('vset-custom-info')?.addEventListener('change', function() {
    saveCurrentVersionSetting('customInfo', this.value);
});

if (customSelectInstances['vset-java']) {
    customSelectInstances['vset-java'].onChange = (value) => saveCurrentVersionSetting('javaPath', value);
}

if (customSelectInstances['vset-mem-optimize']) {
    customSelectInstances['vset-mem-optimize'].onChange = (value) => saveCurrentVersionSetting('memOptimize', value);
}

document.getElementById('vset-jvm-args')?.addEventListener('change', function() {
    saveCurrentVersionSetting('jvmArgs', this.value);
});

document.getElementById('vset-game-args')?.addEventListener('change', function() {
    saveCurrentVersionSetting('gameArgs', this.value);
});

async function loadInstalledModsForSettings() {
    if (!currentSettingsVersionId) return;
    try {
        const mods = await API.getVersionMods(currentSettingsVersionId);
        renderModMgrList(mods || []);
    } catch (e) {
        console.error('[ModMgr] Load error:', e);
    }
}

function renderModMgrList(mods) {
    const container = document.getElementById('modmgr-mod-list');
    const countAll = document.getElementById('modmgr-count-all');
    const countUpdate = document.getElementById('modmgr-count-update');

    if (!container) return;

    if (!mods || mods.length === 0) {
        container.innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">暂无已安装的模组</p>';
        if (countAll) countAll.textContent = '0';
        if (countUpdate) countUpdate.textContent = '0';
        return;
    }

    container.innerHTML = mods.map(m => {
        const iconUrl = m.icon || '';
        const desc = (m.description || '').substring(0, 60);
        const verStr = m.version || '';
        const author = m.author || '';
        const projectId = m.projectId || m.slug || '';
        const isDisabled = m.disabled || false;
        const fileName = m.fileName || m.name || '';
        const toggleLabel = isDisabled ? '启用' : '禁用';
        const toggleClass = isDisabled ? 'btn-primary' : 'btn-secondary';
        const nameStyle = isDisabled ? 'opacity:0.5;text-decoration:line-through;' : '';
        const iconHtml = iconUrl
            ? `<div class="modmgr-icon"><img src="${iconUrl}" alt="" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('modmgr-icon--fallback')"></div>`
            : '<div class="modmgr-icon modmgr-icon--fallback"></div>';
        return `<div class="modmgr-item${isDisabled ? ' mod-disabled' : ''}" data-name="${escapeHtml(m.name || '')}" data-desc="${escapeHtml(desc)}">
            ${iconHtml}
            <div class="modmgr-info">
                <div class="modmgr-name" style="${nameStyle}">${escapeHtml(formatModNameWithChinese(m.id || m.fileName, m.name))}${isDisabled ? ' (已禁用)' : ''}</div>
                <div class="modmgr-meta">${author ? escapeHtml(author) : ''}${verStr ? ' | ' + escapeHtml(verStr) : ''}</div>
                <div class="modmgr-desc">${escapeHtml(desc)}</div>
            </div>
            <div class="modmgr-actions-row">
                <button class="btn ${toggleClass} btn-sm" onclick="event.stopPropagation();toggleModInManager('${escapeOnclick(fileName)}',${!isDisabled})">${toggleLabel}</button>
                ${projectId ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();previewMod('${escapeOnclick(projectId)}')">预览</button>` : ''}
                <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();removeModFromManager('${escapeOnclick(fileName)}')">移除</button>
            </div>
        </div>`;
    }).join('');

    if (countAll) countAll.textContent = mods.length;
    if (countUpdate) countUpdate.textContent = '0';
}

function previewMod(projectId) {
    if (!projectId) return;
    openModDetail(projectId, 'modrinth');
}

function filterInstalledMods() {
    const keyword = (document.getElementById('modmgr-search')?.value || '').toLowerCase();
    document.querySelectorAll('.modmgr-item').forEach(item => {
        const name = (item.dataset.name || '').toLowerCase();
        const desc = (item.dataset.desc || '').toLowerCase();
        item.style.display = (name.includes(keyword) || desc.includes(keyword)) ? 'flex' : 'none';
    });
}

function filterModMgrTab(filter) {
    document.querySelectorAll('.modmgr-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.modmgr-tab[data-filter="${filter}"]`)?.classList.add('active');
}

function selectAllMods() {
    showToast('已选择所有模组', 'info');
}

function installModFromFile() {
    showToast('请选择要安装的 Mod 文件（.jar）', 'info');
    API.selectModFile().then(result => {
        if (result && result.filePath) {
            installModByFile(result.filePath);
        }
    });
}

function installModByFile(filePath) {
    if (!currentSettingsVersionId) {
        showToast('请先选择一个版本', 'error');
        return;
    }
    API.installModFromFile(currentSettingsVersionId, filePath).then(r => {
        if (r.success) {
            showToast('Mod 安装成功', 'success');
            loadInstalledModsForSettings();
        } else {
            showToast(r.error || '安装失败', 'error');
        }
    }).catch(e => showToast('安装失败: ' + e.message, 'error'));
}

function openBrowseMods() {
    navigateToPage('mods');
}

function goDownloadMods() {
    if (!currentSettingsVersionId) {
        navigateToPage('mods');
        return;
    }
    
    const versionInfo = installedVersions.find(v => v.id === currentSettingsVersionId);
    
    let gameVersion = '';
    if (versionInfo && versionInfo.baseVersion) {
        gameVersion = versionInfo.baseVersion;
    } else if (versionInfo && versionInfo.inheritsFrom) {
        gameVersion = versionInfo.inheritsFrom;
    } else {
        gameVersion = currentSettingsVersionId.split('-')[0];
    }
    
    let loaderType = '';
    if (versionInfo) {
        if (versionInfo.isFabric) loaderType = 'fabric';
        else if (versionInfo.isForge) loaderType = 'forge';
        else if (versionInfo.isNeoForge) loaderType = 'neoforge';
    }
    
    console.log('[goDownloadMods] versionId:', currentSettingsVersionId, 'gameVersion:', gameVersion, 'loaderType:', loaderType);
    
    navigateToPage('mods');
    
    setTimeout(() => {
        if (gameVersion && customSelectInstances['mod-filter-version']) {
            customSelectInstances['mod-filter-version'].setValue(gameVersion);
        }
        
        if (loaderType && customSelectInstances['mod-filter-loader']) {
            customSelectInstances['mod-filter-loader'].setValue(loaderType);
        }
        
        modSearchOffset = 0;
        loadMods();
    }, 100);
}

function toggleModInManager(fileName, disable) {
    if (!currentSettingsVersionId) return;
    API.toggleModForVersion(fileName, !disable).then(r => {
        if (r.success) {
            showToast(disable ? '已禁用' : '已启用', 'success');
            loadInstalledModsForSettings();
        } else {
            showToast(r.error || '操作失败', 'error');
        }
    }).catch(e => showToast(e.message || '操作失败', 'error'));
}

async function removeModFromManager(fileName) {
    if (!currentSettingsVersionId) return;
    const confirmed = await showConfirmDialog('删除模组', `确定要删除 ${fileName} 吗？`, '删除', '取消');
    if (!confirmed) return;
    API.removeMod(currentSettingsVersionId, fileName).then(r => {
        if (r.success) {
            showToast('已删除', 'success');
            loadInstalledModsForSettings();
        } else {
            showToast(r.error || '删除失败', 'error');
        }
    });
}

function toggleExportTree(el) {
    el.classList.toggle('expanded');
}

async function loadExportTreeData() {
    if (!currentSettingsVersionId) return;

    try {
        const data = await API.getVersionExportInfo(currentSettingsVersionId);

        if (data.gameDesc) {
            const el = document.getElementById('export-game-desc');
            if (el) el.textContent = data.gameDesc;
        }

        if (data.modCount !== undefined) {
            const el = document.getElementById('export-mod-count');
            if (el) el.textContent = `${data.modCount} 个`;
        }

        if (data.savesCount !== undefined) {
            const el = document.getElementById('export-saves-desc');
            if (el) el.textContent = `${data.savesCount} 个存档`;
        }

        const rpList = document.getElementById('export-rp-list');
        if (rpList && data.resourcePacks && data.resourcePacks.length > 0) {
            rpList.innerHTML = data.resourcePacks.map(rp =>
                `<div class="export-tree-item"><input type="checkbox" checked class="export-cb" data-key="rp_${escapeHtml(rp)}"><span class="export-label">${escapeHtml(rp)}</span></div>`
            ).join('');
        } else if (rpList) {
            rpList.innerHTML = '<div class="export-tree-item"><span class="export-label" style="color:var(--text-muted)">暂无资源包</span></div>';
        }

        const savesList = document.getElementById('export-saves-list');
        if (savesList && data.saves && data.saves.length > 0) {
            savesList.innerHTML = data.saves.slice(0, 10).map(s =>
                `<div class="export-tree-item"><input type="checkbox" checked class="export-cb" data-key="save_${escapeHtml(s)}"><span class="export-label">${escapeHtml(s)}</span></div>`
            ).join('') + (data.saves.length > 10 ? `<div class="export-tree-item"><span class="export-label" style="color:var(--text-muted)">... 还有 ${data.saves.length - 10} 个存档</span></div>` : '');
        } else if (savesList) {
            savesList.innerHTML = '<div class="export-tree-item"><span class="export-label" style="color:var(--text-muted)">暂无存档</span></div>';
        }
    } catch (e) {
        console.error('[Export] Load tree data error:', e);
    }
}

function startExport() {
    if (!currentSettingsVersionId) return;
    const name = document.getElementById('export-name')?.value || '';
    const version = document.getElementById('export-version')?.value || '1.0.0';
    const author = document.getElementById('export-author')?.value || '';
    const description = document.getElementById('export-description')?.value || '';

    if (!name.trim()) { showToast('请输入整合包名称', 'error'); return; }

    const selectedKeys = [];
    document.querySelectorAll('.export-cb:checked').forEach(cb => selectedKeys.push(cb.dataset.key));

    showToast('正在导出整合包...', 'info');
    API.exportModpack(currentSettingsVersionId, name, version, author, description, selectedKeys).then(r => {
        if (r.success) {
            showToast(`整合包已导出到 ${r.path}`, 'success');
        } else {
            showToast(r.error || '导出失败', 'error');
        }
    }).catch(e => showToast('导出失败: ' + (e.message || ''), 'error'));
}

// ─── 设置子菜单和功能函数 ──────────────────────────────────

function setupSettingsSubmenu() {
}

function switchPage(pageName) {
    const currentPage = document.querySelector('.page.active');
    const target = document.getElementById(`page-${pageName}`);
    if (!target || target === currentPage) return;

    if (currentPage) {
        currentPage.style.animation = 'pageOut 0.18s var(--ease-out-expo) forwards';
        setTimeout(() => {
            currentPage.classList.remove('active');
            currentPage.style.animation = '';
            target.classList.add('active');
            target.style.animation = 'pageIn 0.35s var(--ease-out-expo) both';
        }, 160);
    } else {
        target.classList.add('active');
        target.style.animation = 'pageIn 0.35s var(--ease-out-expo) both';
    }

    previousPage = currentPage?.id?.replace('page-', '') || null;
}

// ─── 启动设置函数 ──────────────────────────────────────────

let systemMemoryInfo = null;

function toggleMemoryMode() {
    const mode = document.querySelector('input[name="memoryMode"]:checked')?.value;
    const customSettings = document.getElementById('memory-custom-settings');
    const autoInfo = document.getElementById('memory-auto-info');
    if (customSettings) {
        customSettings.style.display = mode === 'custom' ? 'block' : 'none';
    }
    if (autoInfo) {
        autoInfo.style.display = mode === 'auto' ? 'block' : 'none';
    }
    updateMemoryDisplay();
}

function updateMemoryDisplay() {
    const slider = document.getElementById('memory-slider');
    const display = document.getElementById('memory-value-display');
    const warning = document.getElementById('memory-warning');
    if (slider && display) {
        const mb = parseInt(slider.value, 10);
        const gb = (mb / 1024).toFixed(1);
        display.textContent = mb >= 1024 ? `${mb} MB (${gb} GB)` : `${mb} MB`;
        if (warning && systemMemoryInfo) {
            const totalMB = systemMemoryInfo.totalMB;
            let warnMsg = '';
            if (mb > totalMB * 0.85) {
                warnMsg = '⚠ 分配内存接近系统总内存，可能导致系统卡顿！';
            } else if (mb < 1024) {
                warnMsg = '⚠ 内存分配过小，可能导致游戏卡顿';
            }
            if (warnMsg) {
                warning.textContent = warnMsg;
                warning.style.display = 'block';
            } else {
                warning.style.display = 'none';
            }
        }
    }
    updateAllocatedMemoryDisplay();
}

function updateAllocatedMemoryDisplay() {
    const mode = document.querySelector('input[name="memoryMode"]:checked')?.value;
    const allocatedDisplay = document.getElementById('allocated-memory-display');
    const remainingDisplay = document.getElementById('remaining-memory-display');
    if (!systemMemoryInfo) return;
    let allocMB;
    if (mode === 'auto') {
        allocMB = systemMemoryInfo.autoMB;
    } else {
        const slider = document.getElementById('memory-slider');
        allocMB = slider ? parseInt(slider.value, 10) : systemMemoryInfo.autoMB;
    }
    const allocGB = (allocMB / 1024).toFixed(1);
    const remainMB = systemMemoryInfo.totalMB - allocMB;
    const remainGB = Math.max(0, remainMB / 1024).toFixed(1);
    if (allocatedDisplay) allocatedDisplay.textContent = `${allocGB} GB`;
    if (remainingDisplay) remainingDisplay.textContent = `${remainGB} GB`;
}

async function updateSystemMemoryInfo() {
    try {
        const data = await API.getSystemMemory();
        systemMemoryInfo = data;
        const totalDisplay = document.getElementById('sys-total-memory');
        const usedDisplay = document.getElementById('sys-used-memory');
        const freeDisplay = document.getElementById('sys-free-memory');
        const memBar = document.getElementById('sys-memory-bar');
        const autoValue = document.getElementById('memory-auto-value');
        const sliderMax = document.getElementById('memory-slider-max');
        const slider = document.getElementById('memory-slider');
        if (totalDisplay) totalDisplay.textContent = `${data.totalGB} GB`;
        if (usedDisplay) usedDisplay.textContent = `${data.usedGB} GB`;
        if (freeDisplay) freeDisplay.textContent = `${data.freeGB} GB`;
        if (memBar) {
            const usedPct = Math.min(100, Math.round((data.usedMB / data.totalMB) * 100));
            memBar.style.width = `${usedPct}%`;
            if (usedPct > 80) memBar.style.background = '#ff4d4d';
            else if (usedPct > 60) memBar.style.background = '#ff9800';
            else memBar.style.background = 'var(--accent)';
        }
        if (autoValue) autoValue.textContent = `${data.autoGB} GB`;
        if (slider) {
            slider.max = data.totalMB;
            if (parseInt(slider.value, 10) > data.totalMB) {
                slider.value = data.autoMB;
            }
        }
        if (sliderMax) sliderMax.textContent = `${data.totalMB} MB`;
        updateMemoryDisplay();
    } catch (e) {
        console.error('[Settings] Update memory info error:', e);
    }
}

function toggleAdvancedOptions() {
    const content = document.getElementById('advanced-options-content');
    const arrow = document.getElementById('advanced-options-arrow');
    if (content && arrow) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0)';
    }
}

async function saveLaunchSettings() {
    let windowSize = document.getElementById('window-size')?.value || 'default';
    if (windowSize === 'custom') {
        const w = document.getElementById('custom-width')?.value;
        const h = document.getElementById('custom-height')?.value;
        if (w && h) {
            windowSize = `${w}x${h}`;
        } else {
            windowSize = '1920x1080';
        }
    }

    const settings = {
        versionIsolation: document.getElementById('launch-version-isolation')?.value,
        windowTitle: document.getElementById('launch-window-title')?.value,
        customInfo: document.getElementById('launch-custom-info')?.value,
        launcherVisibility: document.getElementById('launcher-visibility')?.value,
        processPriority: document.getElementById('process-priority')?.value,
        windowSize: windowSize,
        gameJava: document.getElementById('game-java-select')?.value,
        memoryMode: document.querySelector('input[name="memoryMode"]:checked')?.value,
        memoryValue: document.getElementById('memory-slider')?.value,
        jvmArgs: document.getElementById('jvm-args')?.value,
        gameArgs: document.getElementById('game-args')?.value,
        preLaunchCommand: document.getElementById('pre-launch-command')?.value,
        memoryManagement: document.getElementById('memory-management')?.value,
        disableJavaWrapper: document.getElementById('disable-java-wrapper')?.checked,
        disableLWJGLAgent: document.getElementById('disable-lwjgl-agent')?.checked,
        useHighPerformanceGPU: document.getElementById('use-high-performance-gpu')?.checked,
        performanceBoost: document.getElementById('performance-boost')?.checked,
        jvmPreheat: document.getElementById('jvm-preheat')?.checked,
        enableCds: document.getElementById('enable-cds')?.checked
    };

    try {
        await window.electronAPI.store.set('versepc_launch_settings', JSON.stringify(settings));
        showToast('启动设置已保存', 'success');
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

async function resetLaunchSettings() {
    const confirmed = await showConfirmDialog('重置设置', '确定要重置启动设置为默认值吗?', '重置', '取消');
    if (!confirmed) return;

    document.getElementById('launch-version-isolation').value = 'all';
    document.getElementById('launch-window-title').value = '';
    document.getElementById('launch-custom-info').value = '';
    document.getElementById('launcher-visibility').value = 'keep';
    document.getElementById('process-priority').value = 'normal';
    document.getElementById('window-size').value = 'default';
    document.getElementById('game-java-select').value = 'auto';
    document.querySelector('input[name="memoryMode"][value="auto"]').checked = true;
    document.getElementById('memory-slider').value = 4096;
    document.getElementById('jvm-args').value = '';
    document.getElementById('game-args').value = '';
    document.getElementById('pre-launch-command').value = '';
    document.getElementById('memory-management').value = 'default';
    document.getElementById('disable-java-wrapper').checked = false;
    document.getElementById('disable-lwjgl-agent').checked = false;
    document.getElementById('use-high-performance-gpu').checked = true;
    document.getElementById('performance-boost').checked = true;
    document.getElementById('jvm-preheat').checked = false;
    document.getElementById('enable-cds').checked = true;

    toggleMemoryMode();
    updateMemoryDisplay();
    showToast('启动设置已重置', 'success');
}

async function optimizeJvmArgs() {
    const versionId = launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '';
    if (!versionId) {
        showToast('请先选择一个游戏版本', 'error');
        return;
    }
    try {
        const result = await API.getOptimizedJvmArgs(versionId);
        if (result && result.args) {
            document.getElementById('jvm-args').value = result.args;
            showToast(`已优化 JVM 参数（分配 ${result.ramGB}GB 内存，检测到 ${result.modCount} 个模组）`, 'success');
        }
    } catch (e) {
        showToast('优化失败: ' + e.message, 'error');
    }
}

async function loadLaunchSettings() {
    try {
        const saved = await window.electronAPI.store.get('versepc_launch_settings');
        if (saved) {
            const settings = JSON.parse(saved);
            if (settings.versionIsolation) document.getElementById('launch-version-isolation').value = settings.versionIsolation;
            if (settings.windowTitle) document.getElementById('launch-window-title').value = settings.windowTitle;
            if (settings.customInfo) document.getElementById('launch-custom-info').value = settings.customInfo;
            if (settings.launcherVisibility) document.getElementById('launcher-visibility').value = settings.launcherVisibility;
            if (settings.processPriority) document.getElementById('process-priority').value = settings.processPriority;
            if (settings.windowSize) {
                const wsVal = settings.windowSize;
                const wsSelect = document.getElementById('window-size');
                const customDiv = document.getElementById('custom-window-size');
                
                if (/^\d+x\d+$/.test(wsVal)) {
                    const presetOptions = ['854x480','1280x720','1600x900','1920x1080','2560x1440','3840x2160'];
                    if (presetOptions.includes(wsVal)) {
                        if (wsSelect) wsSelect.value = wsVal;
                        if (customDiv) customDiv.style.display = 'none';
                    } else {
                        if (wsSelect) wsSelect.value = 'custom';
                        if (customDiv) customDiv.style.display = 'flex';
                        const [w, h] = wsVal.split('x');
                        const cw = document.getElementById('custom-width');
                        const ch = document.getElementById('custom-height');
                        if (cw) cw.value = w;
                        if (ch) ch.value = h;
                    }
                } else {
                    if (wsSelect) wsSelect.value = wsVal;
                    if (customDiv) customDiv.style.display = 'none';
                }
            }
            if (settings.gameJava) document.getElementById('game-java-select').value = settings.gameJava;
            if (settings.memoryMode) {
                document.querySelector(`input[name="memoryMode"][value="${settings.memoryMode}"]`).checked = true;
                toggleMemoryMode();
            }
            if (settings.memoryValue) {
                document.getElementById('memory-slider').value = settings.memoryValue;
                updateMemoryDisplay();
            }
            if (settings.jvmArgs) document.getElementById('jvm-args').value = settings.jvmArgs;
            if (settings.gameArgs) document.getElementById('game-args').value = settings.gameArgs;
            if (settings.preLaunchCommand) document.getElementById('pre-launch-command').value = settings.preLaunchCommand;
            if (settings.memoryManagement) document.getElementById('memory-management').value = settings.memoryManagement;
            if (settings.disableJavaWrapper !== undefined) document.getElementById('disable-java-wrapper').checked = settings.disableJavaWrapper;
            if (settings.disableLWJGLAgent !== undefined) document.getElementById('disable-lwjgl-agent').checked = settings.disableLWJGLAgent;
            if (settings.useHighPerformanceGPU !== undefined) document.getElementById('use-high-performance-gpu').checked = settings.useHighPerformanceGPU;
            if (settings.performanceBoost !== undefined) document.getElementById('performance-boost').checked = settings.performanceBoost;
            if (settings.jvmPreheat !== undefined) document.getElementById('jvm-preheat').checked = settings.jvmPreheat;
            if (settings.enableCds !== undefined) document.getElementById('enable-cds').checked = settings.enableCds;
        }

        updateSystemMemoryInfo();
        checkCdsStatus();
    } catch (e) {
        console.error('[Settings] Load launch settings error:', e);
    }
}

// ─── 个性化设置函数 ──────────────────────────────────────

async function selectTheme(element) {
    document.querySelectorAll('.theme-option').forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');

    const theme = element.dataset.theme;
    document.documentElement.setAttribute('data-theme', theme);

    try {
        const savedColor = await window.electronAPI.store.get('versepc_custom_accent_color');
        if (savedColor) {
            document.documentElement.style.setProperty('--accent', savedColor);
            const r = parseInt(savedColor.slice(1, 3), 16);
            const g = parseInt(savedColor.slice(3, 5), 16);
            const b = parseInt(savedColor.slice(5, 7), 16);
            const lighter = `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`;
            document.documentElement.style.setProperty('--accent-hover', lighter);
            document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
        }
    } catch (e) {}

    if (typeof updateWallpaperTheme === 'function') {
        updateWallpaperTheme(theme === 'dark');
    }

    try {
        await window.electronAPI.store.set('versepc_theme', theme);
    } catch (e) {
        console.error('[Settings] Save theme error:', e);
    }
}

async function selectWallpaper(element) {
    document.querySelectorAll('.wallpaper-option').forEach(opt => opt.classList.remove('active'));
    element.classList.add('active');

    const mode = element.dataset.wallpaper;

    if (typeof switchWallpaperMode === 'function') {
        switchWallpaperMode(mode);
    }

    const isCustom = mode === 'customImage' || mode === 'customVideo';
    document.getElementById('custom-wallpaper-file-group').style.display = isCustom ? '' : 'none';
    document.getElementById('wallpaper-fit-group').style.display = isCustom ? '' : 'none';

    if (isCustom) {
        const fileLabel = document.getElementById('custom-wallpaper-file-label');
        if (fileLabel) fileLabel.textContent = mode === 'customVideo' ? '选择视频文件' : '选择图片文件';
        const dropZone = document.getElementById('custom-wallpaper-drop-zone');
        if (dropZone) dropZone.textContent = mode === 'customVideo' ? '拖放视频到此处' : '拖放图片到此处';
    }

    try {
        await window.electronAPI.store.set('versepc_wallpaper', mode);
    } catch (e) {
        console.error('[Settings] Save wallpaper error:', e);
    }
}

async function pickCustomWallpaperFile() {
    const activeMode = document.querySelector('.wallpaper-option.active')?.dataset.wallpaper;
    const isVideo = activeMode === 'customVideo';

    const filters = isVideo
        ? [{ name: '视频文件', extensions: ['mp4', 'webm', 'mkv', 'avi'] }]
        : [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }];

    try {
        const result = await window.electronAPI.selectFile({
            title: isVideo ? '选择视频壁纸' : '选择图片壁纸',
            filters
        });

        if (result.cancelled) return;

        const filePath = result.path;
        await _applyCustomWallpaperFile(filePath, isVideo);
    } catch (e) {
        console.error('[Wallpaper] Pick file error:', e);
    }
}

async function _applyCustomWallpaperFile(filePath, isVideo) {
    document.getElementById('custom-wallpaper-file-name').textContent = filePath.split(/[\\/]/).pop();

    if (isVideo) {
        if (typeof setCustomWallpaperVideo === 'function') {
            setCustomWallpaperVideo(filePath);
        }
        try { await window.electronAPI.store.set('versepc_custom_video', filePath); } catch (e) {}
    } else {
        if (typeof setCustomWallpaperImage === 'function') {
            setCustomWallpaperImage(filePath);
        }
        try { await window.electronAPI.store.set('versepc_custom_image', filePath); } catch (e) {}
        _updateCustomImagePreview(filePath);
    }
}

function _updateCustomImagePreview(filePath) {
    const preview = document.getElementById('wp-preview-custom-image');
    if (!preview) return;
    const icon = preview.querySelector('.wp-preview-icon');
    if (filePath) {
        if (icon) icon.style.display = 'none';
        let img = preview.querySelector('.wp-preview-thumb');
        if (!img) {
            img = document.createElement('img');
            img.className = 'wp-preview-thumb';
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;';
            preview.style.position = 'relative';
            preview.appendChild(img);
        }
        img.src = typeof wpfilePath === 'function' ? wpfilePath(filePath) : ('wpfile:///' + filePath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/'));
    } else {
        if (icon) icon.style.display = '';
        const img = preview.querySelector('.wp-preview-thumb');
        if (img) img.remove();
    }
}

function initWallpaperDropZone() {
    const dropZone = document.getElementById('custom-wallpaper-drop-zone');
    if (!dropZone) return;

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');

        const activeMode = document.querySelector('.wallpaper-option.active')?.dataset.wallpaper;
        const isVideo = activeMode === 'customVideo';

        const file = e.dataTransfer.files[0];
        if (!file) return;

        const filePath = file.path;
        if (!filePath) return;

        const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const validVideoExts = ['.mp4', '.webm', '.mkv', '.avi'];
        const ext = '.' + file.name.split('.').pop().toLowerCase();

        if (isVideo && !validVideoExts.includes(ext)) {
            if (typeof showToast === 'function') showToast('请拖放视频文件', 'error');
            return;
        }
        if (!isVideo && !validImageExts.includes(ext)) {
            if (typeof showToast === 'function') showToast('请拖放图片文件', 'error');
            return;
        }

        await _applyCustomWallpaperFile(filePath, isVideo);
    });
}

function initWallpaperAutoAdapt() {
    if (typeof onWallpaperBrightnessChange !== 'function') return;

    onWallpaperBrightnessChange((brightness) => {
        const overlay = document.getElementById('wallpaper-overlay');
        if (!overlay) return;

        const app = document.getElementById('app');
        if (!app) return;

        const isLight = brightness > 0.55;
        const isDark = brightness < 0.35;

        if (isLight) {
            overlay.style.background = 'rgba(0, 0, 0, 0.15)';
            app.classList.add('wp-light');
            app.classList.remove('wp-dark');
        } else if (isDark) {
            overlay.style.background = 'transparent';
            app.classList.add('wp-dark');
            app.classList.remove('wp-light');
        } else {
            const alpha = (0.55 - brightness) * 0.3;
            overlay.style.background = `rgba(0, 0, 0, ${Math.max(0, alpha)})`;
            app.classList.remove('wp-light', 'wp-dark');
        }

        document.documentElement.style.setProperty('--wp-brightness', brightness);
    });
}

function onWallpaperOpacityChange(value) {
    const opacity = value / 100;
    document.getElementById('wallpaper-opacity-value').textContent = value + '%';
    if (typeof setWallpaperOpacity === 'function') setWallpaperOpacity(opacity);
    window.electronAPI?.store?.set('versepc_wallpaper_opacity', value).catch(() => {});
}

function onWallpaperBlurChange(value) {
    document.getElementById('wallpaper-blur-value').textContent = value + 'px';
    if (typeof setWallpaperBlur === 'function') setWallpaperBlur(parseInt(value));
    window.electronAPI?.store?.set('versepc_wallpaper_blur', value).catch(() => {});
}

function onWallpaperFitChange(value) {
    if (typeof setWallpaperFitMode === 'function') setWallpaperFitMode(value);
    window.electronAPI?.store?.set('versepc_wallpaper_fit', value).catch(() => {});
}

function aiToggleApiKeyVisibility() {
    const input = document.getElementById('ai-api-key-input');
    if (!input) return;
    const btn = input.parentElement.querySelector('button');
    if (input.type === 'password') {
        input.type = 'text';
        if (btn) btn.textContent = '隐藏';
    } else {
        input.type = 'password';
        if (btn) btn.textContent = '显示';
    }
}

function applyThemeColors(themeName) {
    const themes = {
        dark: { accent: '#ffffff', accentHover: '#d0d0d0' },
        light: { accent: '#1a1a1a', accentHover: '#333333' }
    };

    const theme = themes[themeName] || themes.dark;
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.style.setProperty('--accent-hover', theme.accentHover);
}

async function updateCustomAccentColor(color) {
    const colorValue = document.getElementById('custom-color-value');
    if (colorValue) {
        colorValue.textContent = color;
    }

    const colorPreviewDot = document.getElementById('color-preview-dot');
    if (colorPreviewDot) {
        colorPreviewDot.style.background = color;
    }

    document.documentElement.style.setProperty('--accent', color);

    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const lighter = `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`;
    document.documentElement.style.setProperty('--accent-hover', lighter);
    document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

    try {
        await window.electronAPI.store.set('versepc_custom_accent_color', color);
    } catch (e) {
        console.error('[Settings] Save custom color error:', e);
    }
}

async function savePersonalizeSettings() {
    const settings = {
        theme: document.querySelector('.theme-option.active')?.dataset.theme || 'dark',
        customAccentColor: document.getElementById('custom-accent-color')?.value,
        wallpaper: document.querySelector('.wallpaper-option.active')?.dataset.wallpaper || 'panorama'
    };

    try {
        await window.electronAPI.store.set('versepc_personalize_settings', JSON.stringify(settings));
        await window.electronAPI.store.set('versepc_wallpaper', settings.wallpaper);
        showToast('个性化设置已保存', 'success');
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

async function resetPersonalizeSettings() {
    const confirmed = await showConfirmDialog('重置设置', '确定要重置个性化设置为默认值吗?', '重置', '取消');
    if (!confirmed) return;

    document.querySelector('.theme-option[data-theme="dark"]')?.click();
    document.getElementById('custom-accent-color').value = '#ffffff';
    const colorPreviewDot = document.getElementById('color-preview-dot');
    if (colorPreviewDot) colorPreviewDot.style.background = '#ffffff';

    document.querySelector('.wallpaper-option[data-wallpaper="panorama"]')?.click();

    const opacitySlider = document.getElementById('wallpaper-opacity-slider');
    if (opacitySlider) { opacitySlider.value = 100; onWallpaperOpacityChange(100); }
    const blurSlider = document.getElementById('wallpaper-blur-slider');
    if (blurSlider) { blurSlider.value = 0; onWallpaperBlurChange(0); }
    const fitSelect = document.getElementById('wallpaper-fit-select');
    if (fitSelect) { fitSelect.value = 'cover'; onWallpaperFitChange('cover'); }

    try {
        await window.electronAPI.store.set('versepc_personalize_settings', JSON.stringify({
            theme: 'dark',
            customAccentColor: '#ffffff',
            wallpaper: 'panorama'
        }));
        await window.electronAPI.store.set('versepc_wallpaper', 'panorama');
        await window.electronAPI.store.delete('versepc_solid_color');
        await window.electronAPI.store.set('versepc_wallpaper_opacity', 100);
        await window.electronAPI.store.set('versepc_wallpaper_blur', 0);
        await window.electronAPI.store.set('versepc_wallpaper_fit', 'cover');
        await window.electronAPI.store.delete('versepc_custom_image');
        await window.electronAPI.store.delete('versepc_custom_video');
        _updateCustomImagePreview(null);
        const nameEl = document.getElementById('custom-wallpaper-file-name');
        if (nameEl) nameEl.textContent = '未选择';
    } catch (e) {
        console.error('[Settings] Reset personalize settings save error:', e);
    }

    showToast('个性化设置已重置', 'success');
}

async function loadPersonalizeSettings() {
    try {
        const saved = await window.electronAPI.store.get('versepc_personalize_settings');
        if (saved) {
            const settings = JSON.parse(saved);
            if (settings.theme) {
                let themeName = settings.theme;
                const legacyThemes = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];
                if (legacyThemes.includes(themeName)) themeName = 'dark';
                const themeEl = document.querySelector(`.theme-option[data-theme="${themeName}"]`);
                if (themeEl) selectTheme(themeEl);
            }
            if (settings.customAccentColor) {
                document.getElementById('custom-accent-color').value = settings.customAccentColor;
                updateCustomAccentColor(settings.customAccentColor);
            }
            if (settings.wallpaper) {
                let wpName = settings.wallpaper;
                if (wpName === 'starry') wpName = 'panorama';
                const wpEl = document.querySelector(`.wallpaper-option[data-wallpaper="${wpName}"]`);
                if (wpEl) selectWallpaper(wpEl);
            }
        } else {
            const savedTheme = await window.electronAPI.store.get('versepc_theme');
            if (savedTheme) {
                let themeName = savedTheme;
                const legacyThemes = ['blue', 'purple', 'green', 'orange', 'red', 'pink', 'teal', 'cyan', 'amber'];
                if (legacyThemes.includes(themeName)) themeName = 'dark';
                const themeEl = document.querySelector(`.theme-option[data-theme="${themeName}"]`);
                if (themeEl) selectTheme(themeEl);
            }
            const savedCustomColor = await window.electronAPI.store.get('versepc_custom_accent_color');
            if (savedCustomColor) {
                document.getElementById('custom-accent-color').value = savedCustomColor;
                updateCustomAccentColor(savedCustomColor);
            }
        }
    } catch (e) {
        console.error('[Settings] Load personalize settings error:', e);
    }
}

// ─── 其他设置函数 ──────────────────────────────────────────

function toggleDebugOptions() {
    const content = document.getElementById('debug-options-content');
    const arrow = document.getElementById('debug-options-arrow');
    if (content && arrow) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0)';
    }
}

async function saveOtherSettings() {
    const settings = {
        downloadSource: document.getElementById('setting-download-source')?.value,
        versionSource: document.getElementById('setting-version-source')?.value,
        maxThreads: document.getElementById('setting-max-threads')?.value,
        speedLimit: document.getElementById('setting-speed-limit')?.value,
        targetDir: document.getElementById('setting-target-dir')?.value,
        sslVerify: document.getElementById('setting-ssl-verify')?.checked,
        modSource: document.getElementById('setting-mod-source')?.value,
        filenameFormat: document.getElementById('setting-filename-format')?.value,
        modStyle: document.getElementById('setting-mod-style')?.value,
        ignoreQuilt: document.getElementById('setting-ignore-quilt')?.checked,
        notifyReleaseUpdates: document.getElementById('notify-release-updates')?.checked,
        notifySnapshotUpdates: document.getElementById('notify-snapshot-updates')?.checked,
        autoSetChinese: document.getElementById('auto-set-chinese')?.checked,
        launcherUpdateMode: document.getElementById('launcher-update-mode')?.value,
        launcherNoticeMode: document.getElementById('launcher-notice-mode')?.value,
        anonymousDataCollection: document.getElementById('anonymous-data-collection')?.checked,
        debugMode: document.getElementById('debug-mode')?.checked,
        verboseLogging: document.getElementById('verbose-logging')?.checked,
        consoleDebug: document.getElementById('enable-console-debug')?.checked
    };

    try {
        await window.electronAPI.store.set('versepc_other_settings', JSON.stringify(settings));
        showToast('其他设置已保存', 'success');
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

async function resetOtherSettings() {
    const confirmed = await showConfirmDialog('重置设置', '确定要重置其他设置为默认值吗?', '重置', '取消');
    if (!confirmed) return;

    document.getElementById('setting-download-source').value = 'auto';
    document.getElementById('setting-version-source').value = 'auto';
    document.getElementById('setting-max-threads').value = 32;
    document.getElementById('thread-count-value').textContent = '32';
    document.getElementById('setting-speed-limit').value = 0;
    document.getElementById('speed-limit-value').textContent = '无限制';
    document.getElementById('setting-target-dir').value = '';
    document.getElementById('setting-ssl-verify').checked = false;
    document.getElementById('setting-mod-source').value = 'modrinth';
    document.getElementById('setting-filename-format').value = 'default';
    document.getElementById('setting-mod-style').value = 'title';
    document.getElementById('setting-ignore-quilt').checked = false;
    document.getElementById('notify-release-updates').checked = false;
    document.getElementById('notify-snapshot-updates').checked = false;
    document.getElementById('auto-set-chinese').checked = true;
    document.getElementById('launcher-update-mode').value = 'auto';
    document.getElementById('launcher-notice-mode').value = 'show-all';
    document.getElementById('anonymous-data-collection').checked = false;
    document.getElementById('debug-mode').checked = false;
    document.getElementById('verbose-logging').checked = false;
    document.getElementById('enable-console-debug').checked = false;

    API.saveSetting('autoSetChinese', true).catch(() => {});
    showToast('其他设置已重置', 'success');
}

async function loadOtherSettings() {
    try {
        const saved = await window.electronAPI.store.get('versepc_other_settings');
        if (saved) {
            const settings = JSON.parse(saved);
            if (settings.downloadSource) document.getElementById('setting-download-source').value = settings.downloadSource;
            if (settings.versionSource) document.getElementById('setting-version-source').value = settings.versionSource;
            if (settings.maxThreads) {
                document.getElementById('setting-max-threads').value = settings.maxThreads;
                document.getElementById('thread-count-value').textContent = settings.maxThreads;
            }
            if (settings.speedLimit !== undefined) {
                document.getElementById('setting-speed-limit').value = settings.speedLimit;
                updateSpeedLimitLabel(settings.speedLimit);
            }
            if (settings.targetDir) document.getElementById('setting-target-dir').value = settings.targetDir;
            if (settings.sslVerify !== undefined) document.getElementById('setting-ssl-verify').checked = settings.sslVerify;
            if (settings.modSource) document.getElementById('setting-mod-source').value = settings.modSource;
            if (settings.filenameFormat) document.getElementById('setting-filename-format').value = settings.filenameFormat;
            if (settings.modStyle) document.getElementById('setting-mod-style').value = settings.modStyle;
            if (settings.ignoreQuilt !== undefined) document.getElementById('setting-ignore-quilt').checked = settings.ignoreQuilt;
            if (settings.notifyReleaseUpdates !== undefined) document.getElementById('notify-release-updates').checked = settings.notifyReleaseUpdates;
            if (settings.notifySnapshotUpdates !== undefined) document.getElementById('notify-snapshot-updates').checked = settings.notifySnapshotUpdates;
            if (settings.autoSetChinese !== undefined) document.getElementById('auto-set-chinese').checked = settings.autoSetChinese;
            if (settings.launcherUpdateMode) document.getElementById('launcher-update-mode').value = settings.launcherUpdateMode;
            if (settings.launcherNoticeMode) document.getElementById('launcher-notice-mode').value = settings.launcherNoticeMode;
            if (settings.anonymousDataCollection !== undefined) document.getElementById('anonymous-data-collection').checked = settings.anonymousDataCollection;
            if (settings.debugMode !== undefined) document.getElementById('debug-mode').checked = settings.debugMode;
            if (settings.verboseLogging !== undefined) document.getElementById('verbose-logging').checked = settings.verboseLogging;
            if (settings.consoleDebug !== undefined) document.getElementById('enable-console-debug').checked = settings.consoleDebug;
        }
    } catch (e) {
        console.error('[Settings] Load other settings error:', e);
    }
}

function updateSpeedLimitLabel(value) {
    const label = document.getElementById('speed-limit-value');
    if (label) {
        label.textContent = value == 0 ? '无限制' : `${value} MB/s`;
    }
}

function checkForUpdates() {
    showToast('正在检查更新...', 'info');
    handleCheckUpdate();
}

let _memoryOptimizing = false;

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

async function refreshMemoryInfo() {
    try {
        const info = await API.getMemoryInfo();
        if (!info || info.error) return;
        const bar = document.getElementById('memory-usage-bar');
        const text = document.getElementById('memory-usage-text');
        const detail = document.getElementById('memory-detail-text');
        if (bar) bar.style.width = info.loadPercent + '%';
        if (text) text.textContent = info.loadPercent + '%';
        if (detail) detail.textContent = `${formatBytes(info.used)} / ${formatBytes(info.total)}`;
        if (bar) {
            if (info.loadPercent > 85) bar.style.background = '#ef4444';
            else if (info.loadPercent > 70) bar.style.background = '#f59e0b';
            else bar.style.background = 'var(--accent)';
        }
    } catch (e) {}
}

async function doMemoryOptimize() {
    if (_memoryOptimizing) {
        showToast('内存优化正在进行中，请稍候', 'info');
        return;
    }
    _memoryOptimizing = true;
    const btn = document.getElementById('memory-optimize-btn');
    if (btn) { btn.disabled = true; btn.textContent = '优化中...'; }
    showToast('正在执行内存优化...', 'info');
    try {
        const result = await API.memoryOptimize();
        if (result.success) {
            const freedStr = result.freedMB > 0 ? `释放了 ${result.freedMB} MB` : '内存已优化';
            showToast(`内存优化完成，${freedStr}，当前可用 ${result.afterMB} MB`, 'success');
        } else {
            showToast('内存优化失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (e) {
        showToast('内存优化失败: ' + e.message, 'error');
    } finally {
        _memoryOptimizing = false;
        if (btn) { btn.disabled = false; btn.textContent = '内存优化'; }
        refreshMemoryInfo();
    }
}

async function exportSettings() {
    try {
        const allSettings = {
            launch: await window.electronAPI.store.get('versepc_launch_settings'),
            personalize: await window.electronAPI.store.get('versepc_personalize_settings'),
            other: await window.electronAPI.store.get('versepc_other_settings'),
            exportTime: new Date().toISOString()
        };

        const blob = new Blob([JSON.stringify(allSettings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `versepc-settings-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);

        showToast('设置已导出', 'success');
    } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
    }
}

function importSettings() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const settings = JSON.parse(text);

            if (settings.launch) {
                await window.electronAPI.store.set('versepc_launch_settings', settings.launch);
                loadLaunchSettings();
            }
            if (settings.personalize) {
                await window.electronAPI.store.set('versepc_personalize_settings', settings.personalize);
                loadPersonalizeSettings();
            }
            if (settings.other) {
                await window.electronAPI.store.set('versepc_other_settings', settings.other);
                loadOtherSettings();
            }

            showToast('设置已导入，请刷新页面查看效果', 'success');
        } catch (err) {
            showToast('导入失败: 无效的设置文件', 'error');
        }
    };

    input.click();
}

async function createDesktopShortcut() {
    try {
        const result = await API.createShortcut('desktop');
        if (result.success) showToast('桌面快捷方式已创建', 'success');
        else showToast('创建失败', 'error');
    } catch (e) {
        showToast('创建失败: ' + e.message, 'error');
    }
}

async function openScreenshots(versionId) {
    const modal = document.getElementById('screenshot-modal');
    const grid = document.getElementById('screenshot-grid');
    grid.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">加载中...</div>';
    modal.style.display = 'flex';

    try {
        const result = await API.getScreenshots(versionId);
        if (result.screenshots && result.screenshots.length > 0) {
            grid.innerHTML = result.screenshots.map(ss => `
                <div style="position:relative;border-radius:6px;overflow:hidden;cursor:pointer;background:var(--bg-active);" onclick="window.open('${ss.url}','_blank')">
                    <img src="${ss.url}" style="width:100%;height:120px;object-fit:cover;display:block;">
                    <div style="padding:4px 6px;font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ss.name}</div>
                </div>
            `).join('');
        } else {
            grid.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">暂无截图</div>';
        }
    } catch (e) {
        grid.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px;">加载失败</div>';
    }
}

function closeScreenshotModal() {
    document.getElementById('screenshot-modal').style.display = 'none';
}

// ─── 初始化设置页面 ──────────────────────────────────────

async function initSettingsPages() {
    setupSettingsSubmenu();
    loadLaunchSettings();
    await loadPersonalizeSettings();
    loadOtherSettings();
}

function uploadImage(type) {
    const inputId = type === 'background' ? 'bg-image-input' : 'avatar-input';
    const input = document.getElementById(inputId);
    if (input) {
        input.click();
    }
}

function handleImageUpload(input, type) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const dataUrl = e.target.result;
        try {
            if (type === 'background') {
                await API.saveBackgroundImage(dataUrl);
                const preview = document.getElementById('bg-image-preview');
                const placeholder = document.getElementById('bg-image-placeholder');
                if (preview) {
                    preview.style.backgroundImage = `url(${dataUrl})`;
                    preview.style.display = 'block';
                }
                if (placeholder) placeholder.style.display = 'none';
                document.body.style.setProperty('--bg-image', `url(${dataUrl})`);
                showToast('背景图片已更新', 'success');
            } else if (type === 'avatar') {
                await API.saveAvatarImage(dataUrl);
                const preview = document.getElementById('avatar-preview');
                const placeholder = document.getElementById('avatar-placeholder');
                if (preview) {
                    preview.style.backgroundImage = `url(${dataUrl})`;
                    preview.style.display = 'block';
                }
                if (placeholder) placeholder.style.display = 'none';
                const homeAvatar = document.getElementById('home-avatar');
                const launchAvatar = document.getElementById('launch-avatar');
                if (homeAvatar) homeAvatar.style.backgroundImage = `url(${dataUrl})`;
                if (launchAvatar) launchAvatar.style.backgroundImage = `url(${dataUrl})`;
                showToast('头像已更新', 'success');
            }
        } catch (err) {
            showToast('图片保存失败: ' + (err.message || ''), 'error');
        }
    };
    reader.readAsDataURL(file);
}

function clearImage(type) {
    if (type === 'background') {
        API.clearBackgroundImage().then(() => {
            const preview = document.getElementById('bg-image-preview');
            const placeholder = document.getElementById('bg-image-placeholder');
            if (preview) { preview.style.backgroundImage = ''; preview.style.display = 'none'; }
            if (placeholder) placeholder.style.display = 'flex';
            document.body.style.removeProperty('--bg-image');
            showToast('背景图片已清除', 'success');
        }).catch(e => showToast('清除失败', 'error'));
    } else if (type === 'avatar') {
        API.clearAvatarImage().then(() => {
            const preview = document.getElementById('avatar-preview');
            const placeholder = document.getElementById('avatar-placeholder');
            if (preview) { preview.style.backgroundImage = ''; preview.style.display = 'none'; }
            if (placeholder) placeholder.style.display = 'flex';
            const homeAvatar = document.getElementById('home-avatar');
            const launchAvatar = document.getElementById('launch-avatar');
            if (homeAvatar) homeAvatar.style.backgroundImage = '';
            if (launchAvatar) launchAvatar.style.backgroundImage = '';
            showToast('头像已清除', 'success');
        }).catch(e => showToast('清除失败', 'error'));
    }
}

function useDefaultImage(type) {
    if (type === 'background') {
        API.clearBackgroundImage().then(() => {
            const preview = document.getElementById('bg-image-preview');
            const placeholder = document.getElementById('bg-image-placeholder');
            if (preview) { preview.style.backgroundImage = ''; preview.style.display = 'none'; }
            if (placeholder) placeholder.style.display = 'flex';
            document.body.style.removeProperty('--bg-image');
            showToast('已恢复默认背景', 'success');
        }).catch(e => showToast('恢复失败', 'error'));
    }
}

function browseJavaPath() {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        window.electronAPI.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Java 可执行文件', extensions: ['exe', ''] }]
        }).then(result => {
            if (!result.canceled && result.filePaths.length > 0) {
                const path = result.filePaths[0];
                const input = document.getElementById('setting-java-path');
                if (input) input.value = path;
            }
        }).catch(() => {});
    } else {
        showToast('请手动输入 Java 路径', 'info');
    }
}



document.addEventListener('DOMContentLoaded', () => {
    init();
    setTimeout(initSettingsPages, 500);
});

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        if (typeof AIChat !== 'undefined' && AIChat.toggleTerminal) {
            AIChat.toggleTerminal();
        }
    }
});
