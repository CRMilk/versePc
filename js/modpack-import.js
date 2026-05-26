/**
 * modpack-import.js - 整合包本地拖拽导入功能
 * ============================================================================
 * 支持从本地文件系统中拖拽或选择整合包文件进行导入安装。
 *
 * 支持格式：
 * - .mrpack - Modrinth 整合包格式
 * - .zip    - CurseForge 整合包 / 普通压缩包格式
 *
 * 功能：
 * 1. 拖拽导入 - 在任意页面拖入整合包文件即可触发导入
 * 2. 文件选择 - 点击区域选择文件导入
 * 3. 进度展示 - 实时显示导入进度（文件名、百分比、状态消息）
 * 4. 版本选择 - 导入前弹窗选择目标游戏版本
 * 5. 全局拖拽 - 仿 PCL2 风格，任意区域拖入都能识别并跳转到导入页
 * 6. 结果反馈 - 成功/失败提示，成功后自动跳转到目标版本
 *
 * 架构说明：
 * - 优先通过 Electron IPC (window.electronAPI.importModpack) 调用主进程
 * - 降级方案：通过 HTTP API (/api/modpack/import) 调用
 * - 进度监听通过 IPC 的 onImportProgress 事件实时更新
 */

(function () {
    'use strict';

    // ========================================================================
    // DOM 元素缓存 - 延迟初始化，避免重复 DOM 查询
    // ========================================================================

    let progressElements = null;
    function getProgressElements() {
        if (!progressElements) {
            progressElements = {
                progress: document.getElementById('modpack-import-progress'),
                result: document.getElementById('modpack-import-result'),
                title: document.getElementById('modpack-import-title'),
                msg: document.getElementById('modpack-import-msg'),
                pct: document.getElementById('modpack-import-pct'),
                bar: document.getElementById('modpack-import-bar'),
                spinner: document.getElementById('modpack-import-spinner'),
            };
        }
        return progressElements;
    }

    // ========================================================================
    // 初始化 - DOM 就绪后注册所有事件监听器
    // ========================================================================

    function init() {
        setupModpackPageTabs();
        setupDropZone();
        setupFileInput();
        setupGlobalDrop();
    }

    // ========================================================================
    // 页面 Tab 切换 - "浏览" 和 "本地导入" 两个标签页
    // ========================================================================

    function setupModpackPageTabs() {
        const page = document.getElementById('page-modpacks');
        if (!page) return;

        page.addEventListener('click', function (e) {
            const btn = e.target.closest('.tab-btn[data-tab]');
            if (!btn) return;
            const tab = btn.dataset.tab;

            // 更新标签按钮活跃状态
            page.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const browseTab  = document.getElementById('modpack-browse-tab');
            const importTab  = document.getElementById('modpack-import-tab');

            if (tab === 'import-modpack') {
                if (browseTab) browseTab.style.display = 'none';
                if (importTab) importTab.style.display = '';
            } else {
                if (browseTab) browseTab.style.display = '';
                if (importTab) importTab.style.display = 'none';
            }
        });
    }

    // ========================================================================
    // 拖拽区域事件 - 页面内的导入拖拽区
    // ========================================================================

    function setupDropZone() {
        const zone = document.getElementById('modpack-drop-zone');
        if (!zone) return;

        // 拖入时高亮边框
        zone.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation();
            zone.style.borderColor = 'var(--accent, #60a5fa)';
            zone.style.background  = 'var(--bg-active, rgba(96,165,250,0.08))';
        });

        // 离开时恢复样式
        zone.addEventListener('dragleave', function (e) {
            e.preventDefault();
            e.stopPropagation();
            resetDropZoneStyle(zone);
        });

        // 放下文件时处理导入
        zone.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            resetDropZoneStyle(zone);

            const files = e.dataTransfer.files;
            if (!files || !files.length) return;
            const file = files[0];
            handleFileImport(file);
        });

        // 点击拖拽区域也触文件选择器（方便非拖拽用户）
        zone.addEventListener('click', function (e) {
            if (e.target.closest('#modpack-select-file-btn') || e.target.closest('#modpack-file-input')) return;
            document.getElementById('modpack-file-input') && document.getElementById('modpack-file-input').click();
        });
    }

    function resetDropZoneStyle(zone) {
        zone.style.borderColor = 'var(--border-color, rgba(255,255,255,0.15))';
        zone.style.background  = 'var(--bg-secondary, rgba(255,255,255,0.03))';
    }

    // ========================================================================
    // 文件选择按钮 - 传统"选择文件"按钮
    // ========================================================================

    function setupFileInput() {
        const btn   = document.getElementById('modpack-select-file-btn');
        const input = document.getElementById('modpack-file-input');
        if (!btn || !input) return;

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            input.value = '';  // 清空值，确保选择相同文件也能触发 change 事件
            input.click();
        });

        input.addEventListener('change', function () {
            if (input.files && input.files.length > 0) {
                handleFileImport(input.files[0]);
            }
        });
    }

    // ========================================================================
    // 全局拖拽 - 任意页面拖入都能触发导入（仿 PCL2 风格）
    // ========================================================================

    function setupGlobalDrop() {
        // 阻止浏览器默认行为（默认会用新标签页打开拖入的文件）
        document.addEventListener('dragover', function (e) {
            const hasFile = e.dataTransfer && e.dataTransfer.types &&
                            (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-moz-file'));
            if (hasFile) e.preventDefault();
        });

        document.addEventListener('drop', function (e) {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;

            const file = files[0];
            const ext  = (file.name || '').toLowerCase();
            if (!ext.endsWith('.mrpack') && !ext.endsWith('.zip')) return;

            e.preventDefault();
            e.stopPropagation();

            // 自动跳转到整合包页面并切换到导入 tab
            const modpackPage = document.getElementById('page-modpacks');
            if (!modpackPage || !modpackPage.classList.contains('active')) {
                const navBtn = document.querySelector('.nav-sub-btn[data-page="modpacks"]') ||
                               document.querySelector('[data-page="modpacks"]');
                if (navBtn) navBtn.click();

                setTimeout(() => switchToImportTab(), 100);
            } else {
                switchToImportTab();
            }

            // 延迟导入确保界面已切换
            setTimeout(() => handleFileImport(file), 200);
        });
    }

    /**
     * 切换到"本地导入"tab
     */
    function switchToImportTab() {
        const importBtn = document.querySelector('#page-modpacks .tab-btn[data-tab="import-modpack"]');
        if (importBtn) importBtn.click();
    }

    // ========================================================================
    // 核心导入逻辑
    // ========================================================================

    /**
     * 处理文件导入的完整流程
     * 1. 校验文件格式（.mrpack / .zip）
     * 2. 获取文件真实路径（Electron 环境）
     * 3. 获取/选择目标版本
     * 4. 注册进度监听
     * 5. 调用导入 API
     * 6. 显示结果
     * @param {File} file - 浏览器 File 对象
     */
    async function handleFileImport(file) {
        const ext = (file.name || '').toLowerCase();
        if (!ext.endsWith('.mrpack') && !ext.endsWith('.zip')) {
            showResult(false, '不支持的文件格式，请拖入 .mrpack 或 .zip 整合包', null);
            return;
        }

        switchToImportTab();

        // 获取文件真实路径（Electron 下 File 对象有 path 属性）
        let filePath = '';
        if (window.electronAPI && window.electronAPI.getDroppedFilePath) {
            filePath = window.electronAPI.getDroppedFilePath(file);
        }
        if (!filePath && file.path) filePath = file.path;

        if (!filePath) {
            showResult(false, '无法获取文件路径，请确保在 Electron 应用中运行', null);
            return;
        }

        // 读取当前已选版本设置
        let targetVersion = '';
        try {
            const settings = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
            targetVersion = settings.selectedVersion || '';
        } catch (e) {}
        
        // 未选择版本则弹出选择对话框
        if (!targetVersion) {
            targetVersion = await showImportVersionSelect();
            if (!targetVersion) {
                showResult(false, '已取消导入，请先选择一个游戏版本', null);
                return;
            }
        }

        showProgress(true, file.name, '正在分析整合包...', 5);

        // 注册 IPC 进度监听（先移除旧监听器避免重复）
        if (window.electronAPI && window.electronAPI.removeImportProgressListener) {
            window.electronAPI.removeImportProgressListener();
        }
        if (window.electronAPI && window.electronAPI.onImportProgress) {
            window.electronAPI.onImportProgress(function (data) {
                showProgress(true, file.name, data.message || '', data.progress || 0);
            });
        }

        try {
            let result;
            if (window.electronAPI && window.electronAPI.importModpack) {
                // 优先使用 Electron IPC 调用主进程
                result = await window.electronAPI.importModpack(filePath, targetVersion);
            } else {
                // 降级方案：通过 HTTP API 调用
                result = await callApiImport(filePath, targetVersion);
            }

            showProgress(false, file.name, '', 100);

            if (result && result.success) {
                let msg = '整合包 <strong>' + escapeHtml(result.name || file.name) + '</strong> 已安装到版本 <strong>' + escapeHtml(targetVersion) + '</strong>！';
                if (result.mcVersion) msg += '<br>游戏版本: ' + escapeHtml(result.mcVersion);
                if (result.warning)   msg += '<br><span style="color:var(--yellow,#fbbf24)">\u26A0 ' + escapeHtml(result.warning) + '</span>';
                showResult(true, msg, result);
            } else {
                showResult(false, (result && result.error) ? result.error : '导入失败，请检查文件格式', null);
            }
        } catch (err) {
            showProgress(false, file.name, '', 0);
            showResult(false, '导入出错: ' + (err.message || err), null);
        }

        // 清理进度监听
        if (window.electronAPI && window.electronAPI.removeImportProgressListener) {
            window.electronAPI.removeImportProgressListener();
        }
    }

    /**
     * 显示导入版本选择对话框（模态框）
     * 从已安装版本中让用户选择一个作为目标版本
     * @returns {Promise<string>} 用户选择的版本 ID，取消返回空字符串
     */
    async function showImportVersionSelect() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;';
            
            modal.innerHTML = `
                <div style="background:var(--bg-secondary,#1a1a2e);border-radius:12px;padding:24px;min-width:320px;max-width:400px;border:1px solid var(--border-color,rgba(255,255,255,0.1));">
                    <h3 style="margin:0 0 16px;color:var(--text-primary,#fff);">选择目标版本</h3>
                    <p style="margin:0 0 16px;color:var(--text-muted,#aaa);font-size:13px;">整合包将安装到所选版本中</p>
                    <select id="import-version-select" style="width:100%;padding:10px 12px;background:var(--bg-input,#252540);border:1px solid var(--border-color,rgba(255,255,255,0.15));border-radius:8px;color:var(--text-primary,#fff);font-size:14px;">
                        <option value="">加载中...</option>
                    </select>
                    <div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
                        <button id="import-ver-cancel" style="padding:8px 16px;background:transparent;border:1px solid var(--border-color,rgba(255,255,255,0.2));border-radius:6px;color:var(--text-secondary,#ccc);cursor:pointer;">取消</button>
                        <button id="import-ver-confirm" style="padding:8px 16px;background:var(--accent,#60a5fa);border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:500;">确认导入</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            const select = modal.querySelector('#import-version-select');
            const cancelBtn = modal.querySelector('#import-ver-cancel');
            const confirmBtn = modal.querySelector('#import-ver-confirm');
            
            // 加载已安装版本列表到下拉框
            fetch('/api/versions').then(r => r.json()).then(data => {
                select.innerHTML = '';
                const installed = (data.installed || []).filter(v => v.id && v.type !== '(old)');
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

    /**
     * HTTP API 降级调用（当 IPC 不可用时）
     * @param {string} filePath - 文件完整路径
     * @param {string} targetVersion - 目标版本 ID
     */
    async function callApiImport(filePath, targetVersion = '') {
        const resp = await fetch('/api/modpack/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, targetVersion })
        });
        return await resp.json();
    }

    // ========================================================================
    // UI 更新方法
    // ========================================================================

    /**
     * 显示/隐藏导入进度条
     * @param {boolean} visible - 是否显示
     * @param {string} fileName - 正在导入的文件名
     * @param {string} message - 当前状态消息
     * @param {number} pct - 进度百分比 (0-100)
     */
    function showProgress(visible, fileName, message, pct) {
        const progressEl = document.getElementById('modpack-import-progress');
        const resultEl   = document.getElementById('modpack-import-result');
        if (!progressEl) return;

        if (visible) {
            if (resultEl) resultEl.style.display = 'none';
            progressEl.style.display = '';
            const titleEl   = document.getElementById('modpack-import-title');
            const msgEl     = document.getElementById('modpack-import-msg');
            const pctEl     = document.getElementById('modpack-import-pct');
            const barEl     = document.getElementById('modpack-import-bar');
            const spinnerEl = document.getElementById('modpack-import-spinner');

            if (titleEl)   titleEl.textContent  = '正在导入: ' + (fileName || '');
            if (msgEl)     msgEl.textContent     = message || '处理中...';
            if (pctEl)     pctEl.textContent     = Math.round(pct) + '%';
            if (barEl)     barEl.style.width     = Math.round(pct) + '%';
            if (spinnerEl) spinnerEl.style.display = pct >= 100 ? 'none' : '';
        } else {
            progressEl.style.display = 'none';
        }
    }

    /**
     * 显示导入结果（成功/失败）
     * @param {boolean} success - 是否成功
     * @param {string} message - 结果消息 HTML
     * @param {Object} result - 导入结果对象
     */
    function showResult(success, message, result) {
        const resultEl = document.getElementById('modpack-import-result');
        if (!resultEl) return;
        resultEl.style.display = '';
        resultEl.style.background    = success ? 'rgba(34,197,94,0.1)'  : 'rgba(239,68,68,0.1)';
        resultEl.style.border        = success ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(239,68,68,0.3)';
        resultEl.style.color         = success ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)';
        resultEl.innerHTML = (success ? '\u2705 ' : '\u274C ') + message;

        // 成功时显示右下角 toast 通知
        if (success && window.showToast) {
            const name = (result && result.name) ? result.name : '整合包';
            window.showToast('整合包 "' + name + '" 导入成功！', 'success');
        }
    }

    // ========================================================================
    // 工具方法
    // ========================================================================

    /**
     * HTML 转义，防止 XSS
     * @param {string} str
     * @returns {string}
     */
    function escapeHtml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ========================================================================
    // 自动初始化 - DOM 就绪即注册事件
    // ========================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
