const { contextBridge, ipcRenderer } = require('electron');

let progressCallbackWrapper = null;
let updaterStatusCallbackWrapper = null;

contextBridge.exposeInMainWorld('electronAPI', {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    setFullscreen: (fullscreen) => ipcRenderer.send('window-set-fullscreen', fullscreen),
    setWindowMode: (windowMode) => ipcRenderer.send('window-set-window-mode', windowMode),
    quitApp: () => ipcRenderer.send('app-quit'),
    showOpenDialog: (options) => ipcRenderer.invoke('dialog-open', options),
    onWindowStateChanged: (callback) => ipcRenderer.on('window-state-changed', (event, data) => callback(data)),
    onWindowModeChanged: (callback) => ipcRenderer.on('window-mode-changed', (event, data) => callback(data)),
    getDroppedFilePath: (file) => file.path || '',
    getDefaultModPath: () => ipcRenderer.invoke('getDefaultModPath'),
    selectSaveFolder: (defaultPath) => ipcRenderer.invoke('dialog:select-folder', { title: '选择模组保存文件夹', defaultPath }),
    selectFile: (options) => ipcRenderer.invoke('dialog:select-file', options),
    importModpack: (filePath, targetVersion = '') => ipcRenderer.invoke('import-modpack', filePath, targetVersion),
    onImportProgress: (callback) => {
        if (progressCallbackWrapper) {
            ipcRenderer.removeListener('import-progress', progressCallbackWrapper);
        }
        progressCallbackWrapper = (event, data) => callback(data);
        ipcRenderer.on('import-progress', progressCallbackWrapper);
    },
    removeImportProgressListener: () => {
        if (progressCallbackWrapper) {
            ipcRenderer.removeListener('import-progress', progressCallbackWrapper);
            progressCallbackWrapper = null;
        }
    },
    mods: {
        list: (dirPath) => ipcRenderer.invoke('mods:list', { path: dirPath }),
        read: (filePath) => ipcRenderer.invoke('mods:read', { path: filePath }),
        write: (filePath, content) => ipcRenderer.invoke('mods:write', { path: filePath, content }),
        search: (basePath, pattern) => ipcRenderer.invoke('mods:search', { path: basePath, pattern }),
        getModInfo: (modDirPath) => ipcRenderer.invoke('mods:getModInfo', { path: modDirPath }),
        detectStructure: (modsDirPath) => ipcRenderer.invoke('mods:detectStructure', { path: modsDirPath }),
        getInstalledVersions: () => ipcRenderer.invoke('mods:getInstalledVersions'),
        listJar: (jarPath) => ipcRenderer.invoke('mods:listJar', { path: jarPath }),
        readJarEntry: (jarPath, entryName) => ipcRenderer.invoke('mods:readJarEntry', { jarPath, entryName }),
        writeJarEntry: (jarPath, entryName, content) => ipcRenderer.invoke('mods:writeJarEntry', { jarPath, entryName, content }),
        findLangFiles: (jarPath) => ipcRenderer.invoke('mods:findLangFiles', { jarPath }),
        autoTranslateMod: (jarPath, sourceEntryName, model, apiKey) => ipcRenderer.invoke('mods:autoTranslateMod', { jarPath, sourceEntryName, model, apiKey }),
        ensureDir: (dirPath) => ipcRenderer.invoke('mods:ensureDir', { path: dirPath }),
    },
    updater: {
        checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
        downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),
        installUpdate: () => ipcRenderer.invoke('updater:install-update'),
        getVersion: () => ipcRenderer.invoke('updater:get-version'),
        skipVersion: (version) => ipcRenderer.invoke('updater:skip-version', version),
        openReleasePage: () => ipcRenderer.invoke('updater:open-release-page'),
        toggleMirror: (enabled, url) => ipcRenderer.invoke('updater:toggle-mirror', enabled, url),
        getMirrorConfig: () => ipcRenderer.invoke('updater:get-mirror-config'),
        onStatusChanged: (callback) => {
            if (updaterStatusCallbackWrapper) {
                ipcRenderer.removeListener('updater-status', updaterStatusCallbackWrapper);
            }
            updaterStatusCallbackWrapper = (event, data) => callback(data);
            ipcRenderer.on('updater-status', updaterStatusCallbackWrapper);
        },
        removeStatusListener: () => {
            if (updaterStatusCallbackWrapper) {
                ipcRenderer.removeListener('updater-status', updaterStatusCallbackWrapper);
                updaterStatusCallbackWrapper = null;
            }
        },
    },
    clipboard: {
        writeText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
        readText: () => ipcRenderer.invoke('clipboard-read-text'),
    },
    store: {
        get: (key) => ipcRenderer.invoke('store-get', key),
        set: (key, value) => ipcRenderer.invoke('store-set', key, value),
        delete: (key) => ipcRenderer.invoke('store-delete', key),
    },
    openExternal: (url) => ipcRenderer.invoke('shell-open-external', url),
    memoryOptimize: () => ipcRenderer.invoke('memory-optimize'),
    getMemoryInfo: () => ipcRenderer.invoke('get-memory-info'),
    jvmPreheat: (javaPath, maxMemMB) => ipcRenderer.invoke('jvm-preheat', javaPath, maxMemMB),
    ai: {
        chatStream: (params) => ipcRenderer.send('ai:chat-stream', params),
        chatAbort: () => ipcRenderer.invoke('ai:chat-abort'),
        toolApprove: (approvalId, approved, alwaysAllow) => ipcRenderer.invoke('ai:tool-approve', { approvalId, approved, alwaysAllow }),
        getProviders: () => ipcRenderer.invoke('ai:get-providers'),
        getVersions: () => ipcRenderer.invoke('ai:get-versions'),
        onChunk: (callback) => {
            const wrapper = (event, data) => callback(data);
            ipcRenderer.on('ai:chat-chunk', wrapper);
            return () => ipcRenderer.removeListener('ai:chat-chunk', wrapper);
        },
        // SSE 模式 - 绕过 IPC 序列化瓶颈
        chatStreamSSE: async (params, onChunk, onDone, onError) => {
            const SSE_PORT = 3001;
            const chatId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            let abortController = new AbortController();

            try {
                const response = await fetch(`http://localhost:${SSE_PORT}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...params, chatId }),
                    signal: abortController.signal
                });

                if (!response.ok) {
                    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
                    onError(err.error || `请求失败: ${response.status}`);
                    return { abort: () => abortController.abort(), chatId };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                const readLoop = async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                onDone();
                                return;
                            }
                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const data = JSON.parse(trimmed.slice(6));
                                        onChunk(data);
                                    } catch (e) {}
                                }
                            }
                        }
                    } catch (e) {
                        if (e.name !== 'AbortError') onError(e.message);
                    }
                };

                readLoop();
                return { abort: () => abortController.abort(), chatId };
            } catch (e) {
                if (e.name !== 'AbortError') onError(e.message);
                return { abort: () => {}, chatId };
            }
        },
        toolApproveSSE: async (approvalId, approved) => {
            const SSE_PORT = 3001;
            try {
                const r = await fetch(`http://localhost:${SSE_PORT}/api/chat/approve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approvalId, approved })
                });
                return r.json();
            } catch (e) {
                return { success: false, error: e.message };
            }
        },
    },
});
