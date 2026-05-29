const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class PluginManager {
    constructor(baseDir) {
        this.baseDir = baseDir || path.join(__dirname, 'plugins');
        this.plugins = new Map();
        this._loaded = false;
    }

    loadAll() {
        if (this._loaded) return;
        this._loaded = true;
        if (!fs.existsSync(this.baseDir)) return;
        const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pluginDir = path.join(this.baseDir, entry.name);
            const manifestPath = path.join(pluginDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (!manifest.id || !manifest.tools) continue;
                const entryPath = path.join(pluginDir, manifest.entry || 'index.js');
                let pluginImpl = {};
                if (fs.existsSync(entryPath)) {
                    pluginImpl = require(entryPath);
                }
                this.plugins.set(manifest.id, { manifest, impl: pluginImpl, dir: pluginDir });
            } catch (e) {
                console.error(`[PluginManager] Failed to load plugin "${entry.name}":`, e.message);
            }
        }
    }

    getTools() {
        const tools = [];
        for (const [id, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            for (const tool of plugin.manifest.tools) {
                tools.push({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters || { type: 'object', properties: {} }
                    }
                });
            }
        }
        return tools;
    }

    getToolDisplayNames() {
        const names = {};
        for (const [, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            for (const tool of plugin.manifest.tools) {
                if (tool.displayName) names[tool.name] = tool.displayName;
            }
        }
        return names;
    }

    getToolRisks() {
        const risks = {};
        for (const [, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            for (const tool of plugin.manifest.tools) {
                risks[tool.name] = tool.risk || 'safe';
            }
        }
        return risks;
    }

    getPromptExtensions() {
        const extensions = [];
        for (const [, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            if (Array.isArray(plugin.manifest.promptExtensions)) {
                extensions.push(...plugin.manifest.promptExtensions);
            }
        }
        return extensions;
    }

    isPluginTool(name) {
        for (const [, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            for (const tool of plugin.manifest.tools) {
                if (tool.name === name) return true;
            }
        }
        return false;
    }

    async executeTool(name, argsStr) {
        let args = {};
        try { args = JSON.parse(argsStr || '{}'); } catch (e) {}
        for (const [, plugin] of this.plugins) {
            if (plugin.manifest.enabled === false) continue;
            for (const tool of plugin.manifest.tools) {
                if (tool.name !== name) continue;
                if (typeof plugin.impl.execute === 'function') {
                    return await plugin.impl.execute(name, args, { pluginDir: plugin.dir, httpGet: httpGetJson });
                }
                return JSON.stringify({ status: 'error', error: `Plugin "${plugin.manifest.id}" does not implement execute()` });
            }
        }
        return null;
    }

    listPlugins() {
        const list = [];
        for (const [id, plugin] of this.plugins) {
            list.push({
                id,
                name: plugin.manifest.name || id,
                version: plugin.manifest.version || '1.0.0',
                description: plugin.manifest.description || '',
                enabled: plugin.manifest.enabled !== false,
                toolCount: (plugin.manifest.tools || []).length
            });
        }
        return list;
    }

    setPluginEnabled(id, enabled) {
        const plugin = this.plugins.get(id);
        if (!plugin) return false;
        plugin.manifest.enabled = enabled;
        const manifestPath = path.join(plugin.dir, 'manifest.json');
        try {
            const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            raw.enabled = enabled;
            fs.writeFileSync(manifestPath, JSON.stringify(raw, null, 2), 'utf-8');
        } catch (e) {}
        return true;
    }
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        proto.get(url, { headers: { 'User-Agent': 'VersePC/1.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse error')); }
            });
        }).on('error', reject);
    });
}

let _instance = null;
function getPluginManager(baseDir) {
    if (!_instance) {
        _instance = new PluginManager(baseDir);
        _instance.loadAll();
    }
    return _instance;
}

module.exports = { PluginManager, getPluginManager, httpGetJson };
