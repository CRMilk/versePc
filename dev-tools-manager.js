const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

const DATA_DIR = path.join(os.homedir(), '.versepc');
const DEV_TOOLS_DIR = path.join(DATA_DIR, 'dev-tools');
const TEMPLATES_DIR = path.join(DEV_TOOLS_DIR, 'templates');
const CONFIG_FILE = path.join(DEV_TOOLS_DIR, 'config.json');

const JDK_VERSION = '21';
const GRADLE_VERSION = '8.12';

const DOWNLOAD_SOURCES = {
    jdk: [
        { name: 'Adoptium', url: 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' },
        { name: 'Tuna', url: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/windows/x64/' },
        { name: 'Huawei', url: 'https://repo.huaweicloud.com/openjdk/' }
    ],
    gradle: [
        { name: 'Official', url: 'https://services.gradle.org/distributions/gradle-8.12-bin.zip' },
        { name: 'Tencent', url: 'https://mirrors.cloud.tencent.com/gradle/gradle-8.12-bin.zip' }
    ],
    fabric_template: [
        { name: 'GitHub', url: 'https://github.com/FabricMC/fabric-example-mod/archive/refs/heads/master.zip' }
    ]
};

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {}
    return {};
}

function saveConfig(config) {
    ensureDir(DEV_TOOLS_DIR);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const doDownload = (downloadUrl, redirectCount) => {
            if (redirectCount > 5) return reject(new Error('Too many redirects'));
            const req = proto.get(downloadUrl, { headers: { 'User-Agent': 'VersePC-DevTools/1.0' }, timeout: 30000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return doDownload(res.headers.location, redirectCount + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} from ${downloadUrl}`));
                }
                const total = parseInt(res.headers['content-length'], 10) || 0;
                let downloaded = 0;
                const file = createWriteStream(destPath);
                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (onProgress && total) onProgress(downloaded, total);
                });
                pipelineAsync(res, file).then(() => resolve(destPath)).catch(reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
        };
        doDownload(url, 0);
    });
}

function extractZip(zipPath, destDir) {
    const AdmZip = (() => { try { return require('adm-zip'); } catch (e) { return null; } })();
    if (AdmZip) {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(destDir, true);
        return;
    }
    try {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { timeout: 120000 });
    } catch (e) {
        throw new Error('Failed to extract zip: ' + e.message);
    }
}

function findJavaInDir(dir) {
    const candidates = [
        path.join(dir, 'bin', 'java.exe'),
        path.join(dir, 'bin', 'java')
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const sub = path.join(dir, entry);
            if (fs.statSync(sub).isDirectory()) {
                const found = findJavaInDir(sub);
                if (found) return found;
            }
        }
    } catch (e) {}
    return null;
}

function findGradleInDir(dir) {
    const candidates = [
        path.join(dir, 'bin', 'gradle.bat'),
        path.join(dir, 'bin', 'gradle')
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const sub = path.join(dir, entry);
            if (fs.statSync(sub).isDirectory()) {
                const found = findGradleInDir(sub);
                if (found) return found;
            }
        }
    } catch (e) {}
    return null;
}

class DevToolsManager {
    constructor() {
        ensureDir(DEV_TOOLS_DIR);
        ensureDir(TEMPLATES_DIR);
        this._config = loadConfig();
    }

    checkEnvironment() {
        const result = { jdk: { installed: false }, gradle: { installed: false }, templates: {} };

        const javaPath = findJavaInDir(DEV_TOOLS_DIR);
        if (javaPath) {
            try {
                const versionOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf-8', timeout: 10000 });
                const match = versionOutput.match(/"(\d+[\d.]*)/);
                result.jdk = { installed: true, version: match ? match[1] : 'unknown', path: javaPath };
            } catch (e) {
                result.jdk = { installed: true, version: 'unknown', path: javaPath };
            }
        }

        const gradlePath = findGradleInDir(DEV_TOOLS_DIR);
        if (gradlePath) {
            result.gradle = { installed: true, path: gradlePath };
        }

        try {
            const templateDirs = fs.readdirSync(TEMPLATES_DIR);
            for (const d of templateDirs) {
                const full = path.join(TEMPLATES_DIR, d);
                if (fs.statSync(full).isDirectory()) {
                    result.templates[d] = { path: full };
                }
            }
        } catch (e) {}

        return result;
    }

    async installJDK(progressCallback) {
        const env = this.checkEnvironment();
        if (env.jdk.installed) return { success: true, message: 'JDK already installed', ...env.jdk };

        ensureDir(DEV_TOOLS_DIR);
        const zipPath = path.join(DEV_TOOLS_DIR, 'jdk-download.zip');

        for (const source of DOWNLOAD_SOURCES.jdk) {
            try {
                if (progressCallback) progressCallback({ stage: 'downloading', source: source.name });
                await downloadFile(source.url, zipPath, (downloaded, total) => {
                    if (progressCallback) progressCallback({ stage: 'downloading', source: source.name, downloaded, total, percent: Math.round(downloaded / total * 100) });
                });
                if (progressCallback) progressCallback({ stage: 'extracting' });
                extractZip(zipPath, DEV_TOOLS_DIR);
                try { fs.unlinkSync(zipPath); } catch (e) {}
                const newEnv = this.checkEnvironment();
                if (newEnv.jdk.installed) {
                    this._config.jdk = { version: newEnv.jdk.version, path: newEnv.jdk.path };
                    saveConfig(this._config);
                    return { success: true, ...newEnv.jdk };
                }
            } catch (e) {
                try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
                continue;
            }
        }
        return { success: false, error: 'Failed to download JDK from all sources' };
    }

    async installGradle(progressCallback) {
        const env = this.checkEnvironment();
        if (env.gradle.installed) return { success: true, message: 'Gradle already installed', ...env.gradle };

        ensureDir(DEV_TOOLS_DIR);
        const zipPath = path.join(DEV_TOOLS_DIR, 'gradle-download.zip');

        for (const source of DOWNLOAD_SOURCES.gradle) {
            try {
                if (progressCallback) progressCallback({ stage: 'downloading', source: source.name });
                await downloadFile(source.url, zipPath, (downloaded, total) => {
                    if (progressCallback) progressCallback({ stage: 'downloading', source: source.name, downloaded, total, percent: Math.round(downloaded / total * 100) });
                });
                if (progressCallback) progressCallback({ stage: 'extracting' });
                extractZip(zipPath, DEV_TOOLS_DIR);
                try { fs.unlinkSync(zipPath); } catch (e) {}
                const newEnv = this.checkEnvironment();
                if (newEnv.gradle.installed) {
                    this._config.gradle = { path: newEnv.gradle.path };
                    saveConfig(this._config);
                    return { success: true, ...newEnv.gradle };
                }
            } catch (e) {
                try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
                continue;
            }
        }
        return { success: false, error: 'Failed to download Gradle from all sources' };
    }

    async downloadTemplate(loader, mcVersion, progressCallback) {
        const templateKey = `${loader}-${mcVersion}`;
        const templateDir = path.join(TEMPLATES_DIR, templateKey);
        if (fs.existsSync(templateDir) && fs.readdirSync(templateDir).length > 0) {
            return { success: true, message: 'Template already exists', path: templateDir };
        }

        ensureDir(TEMPLATES_DIR);
        const zipPath = path.join(TEMPLATES_DIR, templateKey + '.zip');

        if (loader === 'fabric') {
            for (const source of DOWNLOAD_SOURCES.fabric_template) {
                try {
                    if (progressCallback) progressCallback({ stage: 'downloading', source: source.name });
                    await downloadFile(source.url, zipPath, (downloaded, total) => {
                        if (progressCallback) progressCallback({ stage: 'downloading', downloaded, total, percent: Math.round(downloaded / total * 100) });
                    });
                    if (progressCallback) progressCallback({ stage: 'extracting' });
                    extractZip(zipPath, TEMPLATES_DIR);
                    const extractedDir = path.join(TEMPLATES_DIR, 'fabric-example-mod-master');
                    if (fs.existsSync(extractedDir)) {
                        fs.renameSync(extractedDir, templateDir);
                    }
                    try { fs.unlinkSync(zipPath); } catch (e) {}
                    if (fs.existsSync(templateDir)) {
                        return { success: true, path: templateDir };
                    }
                } catch (e) {
                    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
                    continue;
                }
            }
        }

        return { success: false, error: `Template download for ${loader} not yet supported. Please download manually.` };
    }

    async ensureEnvironment(progressCallback) {
        const env = this.checkEnvironment();
        const results = {};

        if (!env.jdk.installed) {
            results.jdk = await this.installJDK(progressCallback ? (p) => progressCallback({ component: 'jdk', ...p }) : null);
        } else {
            results.jdk = { success: true, ...env.jdk };
        }

        if (!env.gradle.installed) {
            results.gradle = await this.installGradle(progressCallback ? (p) => progressCallback({ component: 'gradle', ...p }) : null);
        } else {
            results.gradle = { success: true, ...env.gradle };
        }

        return {
            success: results.jdk.success && results.gradle.success,
            jdk: results.jdk,
            gradle: results.gradle,
            templates: env.templates
        };
    }

    initProject(options) {
        const { modName, modId, loader, mcVersion, packageName, outputPath } = options;
        const templateKey = `${loader}-${mcVersion}`;
        const templateDir = path.join(TEMPLATES_DIR, templateKey);

        if (!fs.existsSync(templateDir)) {
            return { success: false, error: `Template not found: ${templateKey}. Run download_template first.` };
        }

        const projectDir = outputPath || path.join(DATA_DIR, 'mod-projects', modId);
        ensureDir(path.dirname(projectDir));

        this._copyDir(templateDir, projectDir);

        this._replaceInFiles(projectDir, {
            'example-mod': modId,
            'Example Mod': modName,
            'com.example.examplemod': packageName || `com.versepc.${modId}`,
            'examplemod': modId.replace(/-/g, ''),
        });

        return {
            success: true,
            projectPath: projectDir,
            files: this._listFiles(projectDir)
        };
    }

    buildMod(projectPath, progressCallback) {
        const env = this.checkEnvironment();
        if (!env.jdk.installed || !env.gradle.installed) {
            return { success: false, error: 'JDK or Gradle not installed. Run check_dev_environment first.' };
        }

        const gradlewPath = path.join(projectPath, 'gradlew.bat');
        const gradleExe = fs.existsSync(gradlewPath) ? gradlewPath : env.gradle.path;

        try {
            const JAVA_HOME = path.dirname(path.dirname(env.jdk.path));
            const result = execSync(`"${gradleExe}" build`, {
                cwd: projectPath,
                env: { ...process.env, JAVA_HOME, PATH: `${path.join(JAVA_HOME, 'bin')};${process.env.PATH}` },
                encoding: 'utf-8',
                timeout: 300000,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const libsDir = path.join(projectPath, 'build', 'libs');
            let jarPath = '';
            if (fs.existsSync(libsDir)) {
                const jars = fs.readdirSync(libsDir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
                if (jars.length > 0) jarPath = path.join(libsDir, jars[0]);
            }

            return { success: true, jarPath, output: result };
        } catch (e) {
            return { success: false, error: e.stderr || e.message, output: e.stdout || '' };
        }
    }

    createDatapack(options) {
        const { mcVersion, namespace, items, outputPath } = options;
        const packFormat = this._getPackFormat(mcVersion);
        const dpName = `${namespace}_datapack`;
        const dpDir = outputPath || path.join(DATA_DIR, 'datapacks', dpName);
        ensureDir(dpDir);

        fs.writeFileSync(path.join(dpDir, 'pack.mcmeta'), JSON.stringify({
            pack: { pack_format: packFormat, description: `${namespace} datapack` }
        }, null, 2));

        for (const item of items) {
            const dataDir = path.join(dpDir, 'data', namespace);
            if (item.type === 'recipe') {
                const recipeDir = path.join(dataDir, 'recipe');
                ensureDir(recipeDir);
                fs.writeFileSync(path.join(recipeDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'loot_table') {
                const lootDir = path.join(dataDir, 'loot_table');
                ensureDir(lootDir);
                fs.writeFileSync(path.join(lootDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'tag') {
                const tagDir = path.join(dataDir, 'tags');
                ensureDir(tagDir);
                fs.writeFileSync(path.join(tagDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'advancement') {
                const advDir = path.join(dataDir, 'advancement');
                ensureDir(advDir);
                fs.writeFileSync(path.join(advDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            }
        }

        return { success: true, path: dpDir, files: this._listFiles(dpDir) };
    }

    createResourcepack(options) {
        const { mcVersion, namespace, items, outputPath } = options;
        const packFormat = this._getPackFormat(mcVersion);
        const rpName = `${namespace}_resourcepack`;
        const rpDir = outputPath || path.join(DATA_DIR, 'resourcepacks', rpName);
        ensureDir(rpDir);

        fs.writeFileSync(path.join(rpDir, 'pack.mcmeta'), JSON.stringify({
            pack: { pack_format: packFormat, description: `${namespace} resource pack` }
        }, null, 2));

        const assetsDir = path.join(rpDir, 'assets', namespace);
        for (const item of items) {
            if (item.type === 'model') {
                const modelDir = path.join(assetsDir, 'models');
                ensureDir(modelDir);
                fs.writeFileSync(path.join(modelDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'blockstate') {
                const bsDir = path.join(assetsDir, 'blockstates');
                ensureDir(bsDir);
                fs.writeFileSync(path.join(bsDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'lang') {
                const langDir = path.join(assetsDir, 'lang');
                ensureDir(langDir);
                fs.writeFileSync(path.join(langDir, item.name + '.json'), JSON.stringify(item.data, null, 2));
            } else if (item.type === 'texture') {
                const texDir = path.join(assetsDir, 'textures');
                ensureDir(texDir);
                if (item.base64) {
                    fs.writeFileSync(path.join(texDir, item.name + '.png'), Buffer.from(item.base64, 'base64'));
                }
            }
        }

        return { success: true, path: rpDir, files: this._listFiles(rpDir) };
    }

    compileAndInstall(projectPath, targetVersionId, progressCallback) {
        const buildResult = this.buildMod(projectPath, progressCallback);
        if (!buildResult.success) return buildResult;

        const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
        const modsDir = path.join(VERSIONS_DIR, targetVersionId, 'mods');
        ensureDir(modsDir);

        const jarName = path.basename(buildResult.jarPath);
        const destPath = path.join(modsDir, jarName);
        fs.copyFileSync(buildResult.jarPath, destPath);

        return { success: true, jarPath: destPath, message: `Installed ${jarName} to ${modsDir}` };
    }

    _copyDir(src, dest) {
        ensureDir(dest);
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                this._copyDir(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    _replaceInFiles(dir, replacements) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._replaceInFiles(fullPath, replacements);
            } else if (entry.name.endsWith('.java') || entry.name.endsWith('.json') || entry.name.endsWith('.gradle') || entry.name.endsWith('.properties') || entry.name.endsWith('.fabric.json') || entry.name.endsWith('.accesswidener')) {
                try {
                    let content = fs.readFileSync(fullPath, 'utf-8');
                    for (const [from, to] of Object.entries(replacements)) {
                        content = content.split(from).join(to);
                    }
                    fs.writeFileSync(fullPath, content, 'utf-8');
                } catch (e) {}
            }
        }
    }

    _listFiles(dir, base) {
        base = base || dir;
        const result = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(base, fullPath);
                if (entry.isDirectory()) {
                    result.push(...this._listFiles(fullPath, base));
                } else {
                    result.push(relPath);
                }
            }
        } catch (e) {}
        return result;
    }

    _getPackFormat(mcVersion) {
        const versionMap = {
            '1.20': 15, '1.20.1': 15, '1.20.2': 18, '1.20.3': 22, '1.20.4': 22,
            '1.20.5': 32, '1.20.6': 32, '1.21': 34, '1.21.1': 34, '1.21.2': 42,
            '1.21.3': 42, '1.21.4': 46, '1.21.5': 57
        };
        for (const [ver, fmt] of Object.entries(versionMap)) {
            if (mcVersion.startsWith(ver)) return fmt;
        }
        return 46;
    }
}

let _instance = null;
function getDevToolsManager() {
    if (!_instance) _instance = new DevToolsManager();
    return _instance;
}

module.exports = { DevToolsManager, getDevToolsManager, DEV_TOOLS_DIR, TEMPLATES_DIR };
