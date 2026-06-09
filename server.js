/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * server.js - VersePC 服务端核心模块
 * ============================================================================
 * 所有版本管理、游戏启动、模组加载器集成、下载管理等核心业务逻辑。
 * 
 * 核心功能：
 * 1. 版本管理 - 版本JSON解析/合并、版本安装/删除/修复
 * 2. 游戏启动 - JVM参数构建、Natives提取、进程启动管理
 * 3. 依赖检查 - 检查库文件/Natives/Assets完整性
 * 4. 下载管理 - 多线程下载、断点续传、镜像加速
 * 5. 模组加载器 - Fabric/Forge/NeoForge/Quilt集成
 * 6. 认证系统 - Microsoft OAuth、authlib-injector
 * 7. 文件系统 - 目录浏览、JAR解析、配置读写
 * 8. API路由 - handleNativeAPI 统一路由分发
 * 9. 整合包 - Modrinth/CurseForge整合包导入导出
 * 10. 局域网联机 - UPnP端口映射、EasyTier虚拟组网
 *
 * 架构说明：
 * - 通过 handleNativeAPI/handleNativeSSE 与 main.js 通信
 * - 无Express/HTTP依赖，纯函数调用模式
 * - DownloadManager 类管理所有下载任务和版本状态
 */

// ============================================================================
// 模块导入 - Node.js 核心模块
// ============================================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const os = require('os');
const zlib = require('zlib');
const net = require('net');
const dns = require('dns');
const { EventEmitter } = require('events');

let _mainWindow = null;
function setMainWindow(win) { _mainWindow = win; }

let preheatedJvm = null;
let preheatTimer = null;

async function preheatJvm(javaPath, maxMemMB) {
    if (preheatedJvm) return;
    try {
        const preheatArgs = [
            `-Xmx${Math.min(maxMemMB, 512)}M`,
            '-XX:+UseG1GC',
            '-XX:MaxGCPauseMillis=200',
            '-cp', '.',
            'java.lang.Object'
        ];
        const proc = spawn(javaPath, preheatArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        proc.unref();
        preheatedJvm = { pid: proc.pid, javaPath, startTime: Date.now() };
        console.log(`[Preheat] JVM 预热进程已启动, PID: ${proc.pid}`);

        proc.on('exit', () => {
            preheatedJvm = null;
        });

        if (preheatTimer) clearTimeout(preheatTimer);
        preheatTimer = setTimeout(() => {
            if (preheatedJvm) {
                try { process.kill(preheatedJvm.pid); } catch(e) {}
                preheatedJvm = null;
                console.log('[Preheat] 预热进程已超时清理');
            }
        }, 300000);
    } catch(e) {
        console.log(`[Preheat] JVM 预热失败: ${e.message}`);
    }
}

// ============================================================================
// 延迟加载库 - 避免启动时依赖检查失败
// ============================================================================

// adm-zip: 用于JAR/ZIP文件写入操作
let AdmZipModule = null;
function getAdmZip() {
    if (!AdmZipModule) {
        try {
            AdmZipModule = require('adm-zip');
        } catch (e) {
            throw new Error('缺少 adm-zip 依赖，请运行 npm install adm-zip');
        }
    }
    return AdmZipModule;
}

// ============================================================================
// PCL2-style shared HTTP Agent with connection pooling
// ============================================================================
const SHARED_HTTPS_AGENT = new https.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 128,
    timeout: 120000,
    keepAliveMsecs: 30000,
    scheduling: 'fifo',
    lookup: cachedLookup
});

const SHARED_HTTP_AGENT = new http.Agent({
    keepAlive: true,
    maxSockets: 256,
    maxFreeSockets: 128,
    timeout: 120000,
    keepAliveMsecs: 30000,
    scheduling: 'fifo',
    lookup: cachedLookup
});

const dnsCache = new Map();
const DNS_CACHE_TTL = 60000;

function cachedLookup(hostname, opts, callback) {
    const cached = dnsCache.get(hostname);
    if (cached && Date.now() - cached.time < DNS_CACHE_TTL) {
        return callback(null, cached.address, cached.family);
    }
    dns.lookup(hostname, opts, (err, address, family) => {
        if (!err) {
            dnsCache.set(hostname, { address, family, time: Date.now() });
        }
        callback(err, address, family);
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of dnsCache) {
        if (now - val.time > DNS_CACHE_TTL) dnsCache.delete(key);
    }
}, 30000);

// ============================================================================
// 工具函数
// ============================================================================

// 确保目录存在（优化版，减少 existsSync 调用）
const dirCache = new Set();
function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (dirCache.has(dir)) return;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    dirCache.add(dir);
}

async function asyncEnsureDir(filePath) {
    const dir = path.dirname(filePath);
    if (dirCache.has(dir)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    dirCache.add(dir);
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

setInterval(() => { dirCache.clear(); }, 5 * 60 * 1000);

const DATA_DIR = path.join(os.homedir(), '.versepc');
const APP_DATA_PATH = DATA_DIR;
const MINECRAFT_DIR = path.join(os.homedir(), '.minecraft');
const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const MODS_DIR = path.join(DATA_DIR, 'mods');
const NATIVES_DIR = path.join(DATA_DIR, 'natives');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function hasNonASCII(str) {
    for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) > 127) return true;
    }
    return false;
}

function getSafeJavaDir() {
    const defaultDir = path.join(DATA_DIR, 'java');
    if (!hasNonASCII(defaultDir)) return defaultDir;
    const candidates = [
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'VersePC', 'java'),
        path.join('C:\\VersePC', 'java'),
        path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'VersePC', 'java')
    ];
    for (const dir of candidates) {
        if (!hasNonASCII(dir)) return dir;
    }
    return defaultDir;
}

const JAVA_DIR = getSafeJavaDir();
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const ICON_CACHE_DIR = path.join(DATA_DIR, 'cache', 'mod-icons');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');

function generateUUID() {
    return crypto.randomUUID();
}

function loadFavorites() {
    try {
        if (fs.existsSync(FAVORITES_FILE)) {
            const data = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
            if (Array.isArray(data)) {
                if (data.length === 0) {
                    const defaultFavs = [{ name: '默认', id: generateUUID(), favs: [], notes: {} }];
                    saveFavorites(defaultFavs);
                    return defaultFavs;
                }
                return data;
            }
            if (typeof data === 'object' && data !== null) {
                const converted = [{ name: '默认', id: generateUUID(), favs: Object.keys(data).filter(k => data[k]), notes: {} }];
                saveFavorites(converted);
                return converted;
            }
        }
    } catch (e) {}
    const defaultFavs = [{ name: '默认', id: generateUUID(), favs: [], notes: {} }];
    saveFavorites(defaultFavs);
    return defaultFavs;
}

function saveFavorites(favorites) {
    try {
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2));
    } catch (e) {}
}

const MOJANG_API = 'https://piston-meta.mojang.com';
const VERSION_MANIFEST_URL = `${MOJANG_API}/mc/game/version_manifest_v2.json`;
const VERSION_MANIFEST_MIRROR = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_API_MIRROR = 'https://mod.mcimirror.top/modrinth/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const CURSEFORGE_API_MIRROR = 'https://mod.mcimirror.top/curseforge/v1';
const JAVA_RUNTIME_URL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_API_URL = 'https://maven.neoforged.net/api/maven';

const MS_CLIENT_ID = '9c1f1f43-58d5-4b7a-af0d-4e487f073441';

const BMCLAPI_MIRROR = {
    'https://piston-data.mojang.com/': 'https://bmclapi2.bangbang93.com/',
    'https://piston-meta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
    'https://libraries.minecraft.net/': 'https://bmclapi2.bangbang93.com/libraries/',
    'https://resources.download.minecraft.net/': 'https://bmclapi2.bangbang93.com/assets/',
    'https://launchermeta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
    'https://launcher.mojang.com/': 'https://bmclapi2.bangbang93.com/',
    'https://meta.fabricmc.net/': 'https://bmclapi2.bangbang93.com/fabric-meta/',
    'https://maven.minecraftforge.net/': 'https://bmclapi2.bangbang93.com/maven/',
    'https://maven.neoforged.net/': 'https://bmclapi2.bangbang93.com/maven/',
    'https://maven.fabricmc.net/': 'https://bmclapi2.bangbang93.com/maven/',
    'https://cdn.modrinth.com/': 'https://mod.mcimirror.top/modrinth/',
    'https://edge.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
    'https://mediafilez.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
    'https://media.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
};

const MCIM_MIRROR = {
    'https://piston-data.mojang.com/': 'https://download.mcbbs.net/',
    'https://piston-meta.mojang.com/': 'https://download.mcbbs.net/',
    'https://libraries.minecraft.net/': 'https://download.mcbbs.net/libraries/',
    'https://resources.download.minecraft.net/': 'https://download.mcbbs.net/assets/',
    'https://launchermeta.mojang.com/': 'https://download.mcbbs.net/',
    'https://launcher.mojang.com/': 'https://download.mcbbs.net/',
    'https://cdn.modrinth.com/': 'https://mod.mcimirror.top/modrinth/',
    'https://edge.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
    'https://mediafilez.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
    'https://media.forgecdn.net/': 'https://mod.mcimirror.top/curseforge/',
};

const JAVA_DOWNLOAD_MIRRORS = [
    { name: 'BMCLAPI', urlMap: {
        'https://launchermeta.mojang.com/': 'https://bmclapi2.bangbang93.com/',
        'https://piston-data.mojang.com/': 'https://bmclapi2.bangbang93.com/',
    }},
    { name: 'Mojang官方', prefix: '' },
    { name: 'Adoptium (Temurin)', type: 'temurin' },
];

const TEMURIN_API = 'https://api.adoptium.net/v3';

const MINECRAFT_DIR_ORIG = MINECRAFT_DIR;

const AVATAR_SERVICES = [
    (uuid) => `https://minotar.net/helm/${uuid}.png`,
    (uuid) => `https://mc-heads.net/avatar/${uuid}/64`,
    (uuid) => `https://crafatar.com/avatars/${uuid}?size=64&overlay`,
    (uuid) => `https://visage.surgeplay.com/face/64/${uuid}`,
];

function cleanServerUrl(url) {
    if (!url) return '';
    return url.replace(/@@@.*$/, '').replace(/@@.*$/, '').replace(/\/$/, '');
}

async function fetchSkinFromSessionServer(uuid, serverUrl) {
    try {
        const cleanUuid = uuid.replace(/-/g, '');
        const dashedUuid = uuid.length === 32
            ? `${uuid.slice(0,8)}-${uuid.slice(8,12)}-${uuid.slice(12,16)}-${uuid.slice(16,20)}-${uuid.slice(20)}`
            : uuid;

        if (serverUrl) {
            let apiUrl = cleanServerUrl(serverUrl);
            const profileUrl = `${apiUrl}/sessionserver/session/minecraft/profile/${dashedUuid}`;
            const profileData = await fetchJSON(profileUrl);
            if (profileData && profileData.properties) {
                const texturesProp = profileData.properties.find(p => p.name === 'textures');
                if (texturesProp) {
                    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                    if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                        return decoded.textures.SKIN.url;
                    }
                }
            }
        }

        const mojangUrl = `https://sessionserver.mojang.com/session/minecraft/profile/${dashedUuid}`;
        const mojangData = await fetchJSON(mojangUrl);
        if (mojangData && mojangData.properties) {
            const texturesProp = mojangData.properties.find(p => p.name === 'textures');
            if (texturesProp) {
                const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                    return decoded.textures.SKIN.url;
                }
            }
        }
    } catch (e) {
        console.log('[Avatar] session server获取皮肤失败:', e.message);
    }
    return null;
}

const AVATAR_CACHE = new Map();
const AVATAR_CACHE_DURATION = 30 * 60 * 1000; // 30分钟（过期后后台异步刷新，但仍用旧缓存响应）
const VERSION_ICON_CACHE = new Map();
const VERSION_ICON_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时

const STEVE_SKIN_LOCAL_PATH = path.join(__dirname, 'img', 'steve_head.png');
let cachedSteveHead = null;
let steveHeadPromise = null;

async function getSteveHeadLocal() {
    if (cachedSteveHead) return cachedSteveHead;
    if (steveHeadPromise) {
        try { return await steveHeadPromise; } catch (e) {}
    }
    steveHeadPromise = (async () => {
        try {
            if (!fs.existsSync(STEVE_SKIN_LOCAL_PATH)) return null;
            const skinBuffer = fs.readFileSync(STEVE_SKIN_LOCAL_PATH);
            const sharpLib = require('sharp');
            const metadata = await sharpLib(skinBuffer).metadata();
            const w = metadata.width || 0;
            const h = metadata.height || 0;
            if (w < 64 || h < 32) return null;
            const scale = w / 64;
            const headLeft = Math.round(8 * scale);
            const headTop = Math.round(8 * scale);
            const headDim = Math.round(8 * scale);
            const hatLeft = Math.round(40 * scale);
            const hatTop = Math.round(8 * scale);

            const facePng = await sharpLib(skinBuffer)
                .extract({ left: headLeft, top: headTop, width: headDim, height: headDim })
                .ensureAlpha()
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();

            if (h < 64 && metadata.channels !== 4) {
                cachedSteveHead = facePng;
                console.log('[Avatar] Steve head loaded (no hat layer)');
                return cachedSteveHead;
            }

            const hatPng = await sharpLib(skinBuffer)
                .extract({ left: hatLeft, top: hatTop, width: headDim, height: headDim })
                .ensureAlpha()
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();

            cachedSteveHead = await sharpLib(facePng)
                .composite([{ input: hatPng, blend: 'over' }])
                .png()
                .toBuffer();

            console.log('[Avatar] Steve head loaded with hat overlay');
            return cachedSteveHead;
        } catch (e) {
            console.error('[Avatar] getSteveHeadLocal error:', e.message);
            return null;
        }
    })();
    try {
        return await steveHeadPromise;
    } catch (e) {
        console.error('[Avatar] getSteveHeadLocal await error:', e.message);
        return null;
    }
}

async function cropSkinToHeadWithSharp(skinBuffer) {
    try {
        const sharpLib = require('sharp');
        const metadata = await sharpLib(skinBuffer).metadata();
        const w = metadata.width || 0;
        const h = metadata.height || 0;
        if (!w || !h) return null;
        const isValidSkin = (w === 64 && h === 32) || (w === 64 && h === 64) || w === 128 || w === 256 || w === 512;
        if (!isValidSkin) return null;
        const scale = w / 64;
        const headLeft = Math.round(8 * scale);
        const headTop = Math.round(8 * scale);
        const headDim = Math.round(8 * scale);
        const hatLeft = Math.round(40 * scale);
        const hatTop = Math.round(8 * scale);
        if (headLeft + headDim > w || headTop + headDim > h) return null;
        if (hatLeft + headDim > w || hatTop + headDim > h) return null;

        const isRGBA = metadata.channels === 4;

        const faceRaw = await sharpLib(skinBuffer)
            .extract({ left: headLeft, top: headTop, width: headDim, height: headDim })
            .ensureAlpha()
            .raw()
            .toBuffer();

        if (!isRGBA) {
            return await sharpLib(faceRaw, { raw: { width: headDim, height: headDim, channels: 4 } })
                .resize(64, 64, { kernel: 'nearest' })
                .png()
                .toBuffer();
        }

        const hatRaw = await sharpLib(skinBuffer)
            .extract({ left: hatLeft, top: hatTop, width: headDim, height: headDim })
            .ensureAlpha()
            .raw()
            .toBuffer();

        const pixelCount = headDim * headDim;
        const blended = Buffer.alloc(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
            const off = i * 4;
            const fr = faceRaw[off], fg = faceRaw[off + 1], fb = faceRaw[off + 2], fa = faceRaw[off + 3];
            const hr = hatRaw[off], hg = hatRaw[off + 1], hb = hatRaw[off + 2], ha = hatRaw[off + 3];
            if (ha === 0) {
                blended[off] = fr; blended[off + 1] = fg; blended[off + 2] = fb; blended[off + 3] = fa;
                continue;
            }
            if (ha === 255) {
                blended[off] = hr; blended[off + 1] = hg; blended[off + 2] = hb; blended[off + 3] = 255;
                continue;
            }
            if (fa === 0) {
                blended[off] = hr; blended[off + 1] = hg; blended[off + 2] = hb; blended[off + 3] = ha;
                continue;
            }
            const hA = ha / 255;
            const fA = fa / 255;
            const outA = hA + fA * (1 - hA);
            const invOutA = 1 / outA;
            blended[off] = Math.round((hr * hA + fr * fA * (1 - hA)) * invOutA);
            blended[off + 1] = Math.round((hg * hA + fg * fA * (1 - hA)) * invOutA);
            blended[off + 2] = Math.round((hb * hA + fb * fA * (1 - hA)) * invOutA);
            blended[off + 3] = Math.round(outA * 255);
        }

        return await sharpLib(blended, { raw: { width: headDim, height: headDim, channels: 4 } })
            .resize(64, 64, { kernel: 'nearest' })
            .png()
            .toBuffer();
    } catch (e) {
        console.error('[Avatar] cropSkinToHeadWithSharp error:', e.message);
        return null;
    }
}

async function fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl) {
    let avatarData = null;
    let avatarContentType = 'image/png';
    let isFullSkin = false;

    if (storedSkinUrl) {
        try {
            const skinRes = await new Promise((resolve, reject) => {
                const req = https.get(storedSkinUrl, { timeout: 5000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
                isFullSkin = true;
            } else { skinRes.resume(); }
        } catch (e) {}
    }

    if (!avatarServerUrl) {
        const serviceResults = await Promise.allSettled(
            AVATAR_SERVICES.map(async (serviceFn) => {
                const tryUrl = serviceFn(cleanUuid);
                const checkRes = await new Promise((resolve, reject) => {
                    const req = https.get(tryUrl, { timeout: 4000 }, resolve);
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (checkRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of checkRes) chunks.push(chunk);
                    return { data: Buffer.concat(chunks), contentType: checkRes.headers['content-type'] || 'image/png' };
                }
                checkRes.resume();
                throw new Error('non-200');
            })
        );
        for (const r of serviceResults) {
            if (r.status === 'fulfilled' && r.value) {
                avatarData = r.value.data;
                avatarContentType = r.value.contentType;
                break;
            }
        }
    } else {
        console.log('[Avatar] 外置认证，跳过公共Avatar服务，直连 ' + avatarServerUrl);
    }

    if (!avatarData && !avatarServerUrl) return null;

    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let skinRoot = cleanServerUrl(avatarServerUrl);
            if (skinRoot.endsWith('/api/yggdrasil')) skinRoot = skinRoot.replace('/api/yggdrasil', '');
            const skinUrl = skinRoot + '/skin/' + encodeURIComponent(avatarUsername) + '.png';
            console.log('[Avatar] 传统API: ' + skinUrl);
            const skinRes = await new Promise((resolve, reject) => {
                const req = https.get(skinUrl, { timeout: 10000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                isFullSkin = true;
            } else { skinRes.resume(); }
        } catch (e) { console.log('[Avatar] 传统API失败: ' + e.message); }
    }

    if (!avatarData && avatarServerUrl) {
        try {
            let cslRoot = cleanServerUrl(avatarServerUrl);
            if (cslRoot.endsWith('/api/yggdrasil')) cslRoot = cslRoot.replace('/api/yggdrasil', '');
            const cslUsername = avatarUsername || '';
            if (cslUsername) {
                const cslUrl = cslRoot + '/csl/' + encodeURIComponent(cslUsername) + '.json';
                const cslData = await fetchJSON(cslUrl);
                if (cslData && cslData.skins) {
                    const skinHash = cslData.skins.slim || cslData.skins.default || cslData.skins.steve;
                    if (skinHash) {
                        const textureUrl = cslRoot + '/textures/' + skinHash;
                        const textureRes = await new Promise((resolve, reject) => {
                            const req = https.get(textureUrl, { timeout: 10000 }, resolve);
                            req.on('error', reject);
                            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                        });
                        if (textureRes.statusCode === 200) {
                            const chunks = [];
                            for await (const chunk of textureRes) chunks.push(chunk);
                            avatarData = Buffer.concat(chunks);
                            isFullSkin = true;
                        } else { textureRes.resume(); }
                    }
                }
            }
        } catch (e) { console.log('[Avatar] CSL失败: ' + e.message); }
    }

    if (!avatarData) {
        const skinTextureUrl = await fetchSkinFromSessionServer(cleanUuid, avatarServerUrl);
        if (skinTextureUrl) {
            try {
                const texRes = await new Promise((resolve, reject) => {
                    const req = https.get(skinTextureUrl, { timeout: 10000 }, resolve);
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (texRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of texRes) chunks.push(chunk);
                    avatarData = Buffer.concat(chunks);
                    isFullSkin = true;
                } else { texRes.resume(); }
            } catch (e) { console.log('[Avatar] SessionServer失败: ' + e.message); }
        }
    }

    if (avatarData && isFullSkin) {
        const cropped = await cropSkinToHeadWithSharp(avatarData);
        if (cropped) {
            avatarData = cropped;
            avatarContentType = 'image/png';
            console.log('[Avatar] sharp裁剪全皮肤为头像成功');
        } else {
            console.warn('[Avatar] sharp裁剪失败，使用默认头像');
            avatarData = null;
        }
    }

    if (!avatarData) return null;
    return { data: avatarData, contentType: avatarContentType };
}

function refreshAvatarCache(cacheKey, cleanUuid, avatarServerUrl, avatarUsername) {
    fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername).then(result => {
        if (result) {
            AVATAR_CACHE.set(cacheKey, { data: result.data, contentType: result.contentType, time: Date.now() });
            console.log('[Avatar] 后台刷新成功: ' + cacheKey);
        }
    }).catch(e => {
        console.error('[Avatar] 后台刷新失败: ' + e.message);
    });
}

async function fetchAvatarDataFull(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl) {
    let avatarData = null;
    let avatarContentType = 'image/png';

    if (storedSkinUrl) {
        try {
            const skinRes = await new Promise((resolve, reject) => {
                const req = https.get(storedSkinUrl, { timeout: 5000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
            } else { skinRes.resume(); }
        } catch (e) {}
    }

    if (!avatarData && !avatarServerUrl) {
        const serviceResults = await Promise.allSettled(
            AVATAR_SERVICES.map(async (serviceFn) => {
                const tryUrl = serviceFn(cleanUuid);
                const checkRes = await new Promise((resolve, reject) => {
                    const req = https.get(tryUrl, { timeout: 4000 }, resolve);
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (checkRes.statusCode === 200) {
                    const chunks = [];
                    for await (const chunk of checkRes) chunks.push(chunk);
                    return { data: Buffer.concat(chunks), contentType: checkRes.headers['content-type'] || 'image/png' };
                }
                checkRes.resume();
                throw new Error('non-200');
            })
        );
        for (const r of serviceResults) {
            if (r.status === 'fulfilled' && r.value) {
                avatarData = r.value.data;
                avatarContentType = r.value.contentType;
                break;
            }
        }
    }
    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let skinRoot = cleanServerUrl(avatarServerUrl);
            if (skinRoot.endsWith('/api/yggdrasil')) skinRoot = skinRoot.replace('/api/yggdrasil', '');
            const skinUrl = skinRoot + '/skin/' + encodeURIComponent(avatarUsername) + '.png';
            const skinRes = await new Promise((resolve, reject) => {
                const req = https.get(skinUrl, { timeout: 5000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (skinRes.statusCode === 200) {
                const chunks = [];
                for await (const chunk of skinRes) chunks.push(chunk);
                avatarData = Buffer.concat(chunks);
                avatarContentType = skinRes.headers['content-type'] || 'image/png';
            } else { skinRes.resume(); }
        } catch (e) {}
    }
    if (!avatarData && avatarServerUrl && avatarUsername) {
        try {
            let cslRoot = cleanServerUrl(avatarServerUrl);
            if (cslRoot.endsWith('/api/yggdrasil')) cslRoot = cslRoot.replace('/api/yggdrasil', '');
            const cslUrl = cslRoot + '/csl/' + encodeURIComponent(avatarUsername) + '.json';
            const cslRes = await new Promise((resolve, reject) => {
                const req = https.get(cslUrl, { timeout: 4000 }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
            if (cslRes.statusCode === 200) {
                const cslChunks = [];
                for await (const chunk of cslRes) cslChunks.push(chunk);
                const cslData = JSON.parse(Buffer.concat(cslChunks).toString('utf8'));
                const skinEntry = cslData.skins && cslData.skins.find(s => s.type === 'skin' || s.type === 'default');
                if (skinEntry && skinEntry.url) {
                    const texRes = await new Promise((resolve, reject) => {
                        const req = https.get(skinEntry.url, { timeout: 5000 }, resolve);
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    });
                    if (texRes.statusCode === 200) {
                        const texChunks = [];
                        for await (const chunk of texRes) texChunks.push(chunk);
                        avatarData = Buffer.concat(texChunks);
                        avatarContentType = texRes.headers['content-type'] || 'image/png';
                    } else { texRes.resume(); }
                }
            } else { cslRes.resume(); }
        } catch (e) {}
    }
    if (!avatarData) {
        const skinTextureUrl = await fetchSkinFromSessionServer(cleanUuid, avatarServerUrl);
        if (skinTextureUrl) {
            try {
                const texRes = await new Promise((resolve, reject) => {
                    const req = https.get(skinTextureUrl, { timeout: 5000 }, resolve);
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                });
                if (texRes.statusCode === 200) {
                    const texChunks = [];
                    for await (const chunk of texRes) texChunks.push(chunk);
                    avatarData = Buffer.concat(texChunks);
                    avatarContentType = texRes.headers['content-type'] || 'image/png';
                } else { texRes.resume(); }
            } catch (e) {}
        }
    }
    if (!avatarData) return null;
    return { data: avatarData, contentType: avatarContentType };
}

let _steveSkinFull = null;
let _steveSkinFullPromise = null;
async function getSteveSkinFull() {
    if (_steveSkinFull) return _steveSkinFull;
    if (_steveSkinFullPromise) { try { return await _steveSkinFullPromise; } catch (e) {} }
    _steveSkinFullPromise = (async () => {
        try {
            const skinPath = path.join(__dirname, 'img', 'steve_skin.png');
            if (fs.existsSync(skinPath)) {
                _steveSkinFull = fs.readFileSync(skinPath);
                return _steveSkinFull;
            }
            const headPath = path.join(__dirname, 'img', 'steve_head.png');
            if (fs.existsSync(headPath)) {
                _steveSkinFull = fs.readFileSync(headPath);
                return _steveSkinFull;
            }
        } catch (e) {}
        return null;
    })();
    return await _steveSkinFullPromise;
}

// 定期清理过期的头像缓存
function cleanAvatarCache() {
    const now = Date.now();
    const MAX_AVATAR_CACHE = 500;
    const MAX_ICON_CACHE = 500;
    for (const [key, value] of AVATAR_CACHE.entries()) {
        if (now - value.time > AVATAR_CACHE_DURATION) {
            AVATAR_CACHE.delete(key);
        }
    }
    if (AVATAR_CACHE.size > MAX_AVATAR_CACHE) {
        const oldestKey = AVATAR_CACHE.keys().next().value;
        AVATAR_CACHE.delete(oldestKey);
    }
    for (const [key, value] of VERSION_ICON_CACHE.entries()) {
        if (now - value.time > VERSION_ICON_CACHE_DURATION) {
            VERSION_ICON_CACHE.delete(key);
        }
    }
    if (VERSION_ICON_CACHE.size > MAX_ICON_CACHE) {
        const oldestKey = VERSION_ICON_CACHE.keys().next().value;
        VERSION_ICON_CACHE.delete(oldestKey);
    }
}

// 每10分钟清理一次缓存
setInterval(cleanAvatarCache, 10 * 60 * 1000);

function cropSkinHead(skinPngBuffer) {
    try {
        const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (skinPngBuffer.length < 24 || !skinPngBuffer.slice(0, 8).equals(PNG_SIGNATURE)) {
            return null;
        }

        let offset = 8;
        let width = 0, height = 0;
        let ihdrFound = false;

        while (offset < skinPngBuffer.length) {
            const chunkLen = skinPngBuffer.readUInt32BE(offset);
            const chunkType = skinPngBuffer.slice(offset + 4, offset + 8).toString('ascii');
            if (chunkType === 'IHDR') {
                width = skinPngBuffer.readUInt32BE(offset + 8);
                height = skinPngBuffer.readUInt32BE(offset + 12);
                ihdrFound = true;
                break;
            }
            offset += 12 + chunkLen;
        }

        if (!ihdrFound || width < 64 || height < 32) return null;

        const headX = 8, headY = 8;
        const headW = 8, headH = 8;
        const hatX = 40, hatY = 8;

        const pixelData = decodePngPixels(skinPngBuffer);
        if (!pixelData) return null;

        const outputSize = 64;
        const outPixels = Buffer.alloc(outputSize * outputSize * 4, 0);

        for (let dy = 0; dy < headH; dy++) {
            for (let dx = 0; dx < headW; dx++) {
                const sx = headX + dx;
                const sy = headY + dy;
                const srcIdx = (sy * width + sx) * 4;
                const r = pixelData[srcIdx] || 0;
                const g = pixelData[srcIdx + 1] || 0;
                const b = pixelData[srcIdx + 2] || 0;
                const a = pixelData[srcIdx + 3] || 0;

                const hx = hatX + dx;
                const hy = hatY + dy;
                const hatIdx = (hy * width + hx) * 4;
                const hr = pixelData[hatIdx] || 0;
                const hg = pixelData[hatIdx + 1] || 0;
                const hb = pixelData[hatIdx + 2] || 0;
                const ha = pixelData[hatIdx + 3] || 0;

                const fa = ha / 255;
                const ba = a / 255;
                const outA = ha + ba * (1 - fa);
                const outR = outA > 0 ? (hr * fa + r * ba * (1 - fa)) / outA : 0;
                const outG = outA > 0 ? (hg * fa + g * ba * (1 - fa)) / outA : 0;
                const outB = outA > 0 ? (hb * fa + b * ba * (1 - fa)) / outA : 0;

                const scale = outputSize / headW;
                for (let sy2 = 0; sy2 < scale; sy2++) {
                    for (let sx2 = 0; sx2 < scale; sx2++) {
                        const outX = dx * scale + sx2;
                        const outY = dy * scale + sy2;
                        const outIdx = (outY * outputSize + outX) * 4;
                        outPixels[outIdx] = Math.round(outR);
                        outPixels[outIdx + 1] = Math.round(outG);
                        outPixels[outIdx + 2] = Math.round(outB);
                        outPixels[outIdx + 3] = Math.round(outA * 255);
                    }
                }
            }
        }

        return encodePng(outPixels, outputSize, outputSize);
    } catch (e) {
        console.log('[Avatar] cropSkinHead失败:', e.message);
        return null;
    }
}

function decodePngPixels(buf) {
    try {
        let offset = 8;
        let width = 0, height = 0, bitDepth = 0, colorType = 0;
        const idatChunks = [];

        while (offset < buf.length) {
            if (offset + 8 > buf.length) break;
            const chunkLen = buf.readUInt32BE(offset);
            const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
            if (chunkType === 'IHDR') {
                width = buf.readUInt32BE(offset + 8);
                height = buf.readUInt32BE(offset + 12);
                bitDepth = buf[offset + 16];
                colorType = buf[offset + 17];
            } else if (chunkType === 'IDAT') {
                idatChunks.push(buf.slice(offset + 8, offset + 8 + chunkLen));
            }
            offset += 12 + chunkLen;
        }

        if (width === 0 || height === 0) return null;

        const compressed = Buffer.concat(idatChunks);
        const raw = zlib.inflateSync(compressed);

        const bpp = (colorType === 6) ? 4 : (colorType === 2) ? 3 : (colorType === 0) ? 1 : 4;
        const outBpp = 4;
        const pixels = Buffer.alloc(width * height * outBpp, 0);
        const prevRow = Buffer.alloc(width * outBpp, 0);
        let srcIdx = 0;

        function paethPredictor(a, b, c) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            if (pa <= pb && pa <= pc) return a;
            if (pb <= pc) return b;
            return c;
        }

        for (let y = 0; y < height; y++) {
            if (srcIdx >= raw.length) break;
            const filter = raw[srcIdx++];
            const curRow = Buffer.alloc(width * outBpp, 0);

            for (let x = 0; x < width; x++) {
                const curIdx = x * outBpp;
                for (let c = 0; c < bpp; c++) {
                    if (srcIdx >= raw.length) break;
                    let val = raw[srcIdx++];

                    const leftIdx = (x - 1) * outBpp;
                    const aboveIdx = x * outBpp;
                    const aboveLeftIdx = (x - 1) * outBpp;

                    const left = x > 0 ? curRow[leftIdx + c] : 0;
                    const above = prevRow[aboveIdx + c];
                    const aboveLeft = x > 0 ? prevRow[aboveLeftIdx + c] : 0;

                    switch (filter) {
                        case 0: break;
                        case 1: val = (val + left) & 0xFF; break;
                        case 2: val = (val + above) & 0xFF; break;
                        case 3: val = (val + Math.floor((left + above) / 2)) & 0xFF; break;
                        case 4: val = (val + paethPredictor(left, above, aboveLeft)) & 0xFF; break;
                    }

                    if (c < outBpp) curRow[curIdx + c] = val;
                }
                if (bpp === 3) curRow[x * outBpp + 3] = 255;
                if (bpp === 1) {
                    const v = curRow[x * outBpp];
                    curRow[x * outBpp + 1] = v;
                    curRow[x * outBpp + 2] = v;
                    curRow[x * outBpp + 3] = 255;
                }
            }

            curRow.copy(pixels, y * width * outBpp);
            curRow.copy(prevRow);
        }

        return pixels;
    } catch (e) {
        console.log('[Avatar] decodePngPixels失败:', e.message);
        return null;
    }
}

function encodePng(pixels, width, height) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const rawData = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        rawData[y * (1 + width * 4)] = 0;
        pixels.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawData);

    const chunks = [
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', compressed),
        makePngChunk('IEND', Buffer.alloc(0))
    ];

    return Buffer.concat([signature, ...chunks]);
}

function makePngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function extractSkinUrlFromAuthResult(authResult) {
    try {
        const sources = [
            authResult?.selectedProfile?.properties,
            authResult?.user?.properties
        ];
        for (const properties of sources) {
            if (!properties) continue;
            const texturesProp = properties.find(p => p.name === 'textures');
            if (texturesProp && texturesProp.value) {
                try {
                    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf8'));
                    if (decoded.textures && decoded.textures.SKIN && decoded.textures.SKIN.url) {
                        return decoded.textures.SKIN.url;
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

let versionCache = null;
let versionCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;
const DISK_CACHE_PATH = path.join(DATA_DIR, 'cache', 'version-manifest.json');
let versionDetailsCache = {};

function saveDiskCache() {
    try {
        const dir = path.dirname(DISK_CACHE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify({ data: versionCache, timestamp: versionCacheTime }));
    } catch (e) {}
}
const installSessions = new Map();
const javaInstallSessions = new Map();

function safeLibPath(artifactPath, baseDir) {
    if (!artifactPath || typeof artifactPath !== 'string') return null;
    const rawPath = artifactPath.replace(/\//g, path.sep);
    const resolved = path.resolve(baseDir || LIBRARIES_DIR, rawPath);
    const base = path.resolve(baseDir || LIBRARIES_DIR);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        console.warn(`[Security] Blocked path traversal in artifact path: ${artifactPath}`);
        return null;
    }
    return resolved;
}
const modDownloadSessions = new Map();
const repairSessions = new Map();
const gameInstances = new Map();
let gameLogBuffer = [];
let lastGameExitAnalysis = null;
let detectedLanPort = null;
let gameInstanceCounter = 0;

const SENSITIVE_PATTERNS = [
    { pattern: /--accessToken\s+\S+/g, replacement: '--accessToken ***' },
    { pattern: /--uuid\s+\S+/g, replacement: '--uuid ***' },
    { pattern: /auth_access_token[=:]\s*\S+/g, replacement: 'auth_access_token=***' },
    { pattern: /auth_uuid[=:]\s*\S+/g, replacement: 'auth_uuid=***' },
    { pattern: /accessToken['"]\s*:\s*['"][^'"]+['"]/g, replacement: 'accessToken":"***"' },
    { pattern: /refreshToken['"]\s*:\s*['"][^'"]+['"]/g, replacement: 'refreshToken":"***"' },
    { pattern: /token\s*[=:]\s*['"]?[a-zA-Z0-9._-]{20,}['"]?/gi, replacement: 'token=***' },
    { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, replacement: 'eyJ***' },
];

function filterSensitiveInfo(line) {
    if (!line || typeof line !== 'string') return line;
    let filtered = line;
    for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
        filtered = filtered.replace(pattern, replacement);
    }
    return filtered;
}

const lanRooms = new Map();
const lanRelayServers = new Map();

const TERRACOTTA_DIR = path.join(__dirname, 'tools', 'terracotta');
const TERRACOTTA_VERSION = '0.4.2';
let terracottaProcess = null;
let terracottaHttpPort = 0;
let terracottaPortFilePath = '';
let terracottaStatus = { running: false, mode: null, roomCode: '', virtualIP: '', gamePort: 0, state: null, stateIndex: -1 };
let terracottaPublicNodes = null;

function generateInvitationCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let segments = [];
    for (let s = 0; s < 4; s++) {
        let seg = '';
        const bytes = crypto.randomBytes(4);
        for (let i = 0; i < 4; i++) seg += chars[bytes[i] % chars.length];
        segments.push(seg);
    }
    return segments.join('-');
}

function generateNetworkSecret() {
    const bytes = crypto.randomBytes(16);
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let secret = '';
    for (let i = 0; i < 16; i++) secret += chars[bytes[i] % chars.length];
    return secret;
}

function getTerracottaBinaryPath() {
    const exeName = process.platform === 'win32' ? 'terracotta.exe' : 'terracotta';
    const bundledPath = path.join(__dirname, 'tools', 'terracotta', exeName);
    if (fs.existsSync(bundledPath)) return bundledPath;
    return path.join(TERRACOTTA_DIR, exeName);
}

function isTerracottaInstalled() {
    return fs.existsSync(getTerracottaBinaryPath());
}

async function ensureTerracottaInstalled() {
    if (isTerracottaInstalled()) return true;
    const TERRACOTTA_URLS = [
        'https://terracotta.glavo.site/download/latest/terracotta.exe',
        'https://ghfast.top/https://github.com/HMCL-dev/HMCL/releases/download/terracotta-v0.4.2/terracotta.exe',
        'https://mirror.ghproxy.com/https://github.com/HMCL-dev/HMCL/releases/download/terracotta-v0.4.2/terracotta.exe'
    ];
    const binPath = getTerracottaBinaryPath();
    const binDir = path.dirname(binPath);
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    for (const url of TERRACOTTA_URLS) {
        try {
            console.log(`[Terracotta] Downloading from ${url}...`);
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const buffer = Buffer.from(await resp.arrayBuffer());
            if (buffer.length < 10000) continue;
            const tmpPath = binPath + '.tmp';
            fs.writeFileSync(tmpPath, buffer);
            fs.renameSync(tmpPath, binPath);
            if (process.platform !== 'win32') {
                fs.chmodSync(binPath, 0o755);
            }
            console.log(`[Terracotta] Installed successfully (${buffer.length} bytes)`);
            return true;
        } catch (e) {
            console.warn(`[Terracotta] Download failed from ${url}: ${e.message}`);
        }
    }
    return false;
}

async function fetchTerracottaPublicNodes() {
    if (terracottaPublicNodes) return terracottaPublicNodes;
    try {
        const nodeUrl = 'https://terracotta.glavo.site/nodes';
        const resp = await fetchJSON(nodeUrl);
        if (Array.isArray(resp)) {
            terracottaPublicNodes = resp
                .filter(n => n && n.url)
                .map(n => n.url);
        }
    } catch (e) {
        console.error('[Terracotta] Failed to fetch public nodes:', e.message);
    }
    if (!terracottaPublicNodes || terracottaPublicNodes.length === 0) {
        terracottaPublicNodes = [
            'tcp://public.easytier.cn:11010',
            'udp://public.easytier.cn:11010',
            'tcp://easytier.1-hub.com:11010',
            'udp://easytier.1-hub.com:11010'
        ];
    }
    return terracottaPublicNodes;
}

async function terracottaHttpGet(endpoint, params = {}) {
    if (!terracottaHttpPort) throw new Error('Terracotta未启动');
    const urlObj = new URL(`http://127.0.0.1:${terracottaHttpPort}${endpoint}`);
    Object.entries(params).forEach(([key, value]) => {
        if (Array.isArray(value)) {
            value.forEach(v => urlObj.searchParams.append(key, v));
        } else if (value !== undefined && value !== null) {
            urlObj.searchParams.set(key, value);
        }
    });
    return new Promise((resolve, reject) => {
        const req = http.get(urlObj.toString(), { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Terracotta API parse error: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Terracotta API timeout')); });
        req.on('error', reject);
    });
}

function waitForTerracottaPort(filePath, timeout) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const check = () => {
            if (fs.existsSync(filePath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    if (data.port) {
                        resolve(data.port);
                        return;
                    }
                } catch (e) {}
            }
            if (Date.now() - startTime > timeout) {
                reject(new Error('Terracotta启动超时'));
                return;
            }
            setTimeout(check, 500);
        };
        check();
    });
}

async function startTerracotta() {
    if (terracottaProcess && terracottaHttpPort) {
        try {
            await terracottaHttpGet('/state');
            return terracottaHttpPort;
        } catch (e) {
            stopTerracotta();
        }
    }

    const installed = await ensureTerracottaInstalled();
    if (!installed) {
        throw new Error('陶瓦联机初始化失败，请检查网络连接后重试');
    }

    const binPath = getTerracottaBinaryPath();
    const tmpDir = path.join(os.tmpdir(), `versepc-terracotta-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    terracottaPortFilePath = path.join(tmpDir, 'http');

    console.log(`[Terracotta] Starting: ${binPath} --hmcl ${terracottaPortFilePath}`);

    terracottaProcess = spawn(binPath, ['--hmcl', terracottaPortFilePath], {
        cwd: TERRACOTTA_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    terracottaProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        console.log(`[Terracotta] ${line}`);
    });

    terracottaProcess.stderr.on('data', (data) => {
        const line = data.toString().trim();
        console.log(`[Terracotta ERR] ${line}`);
    });

    terracottaProcess.on('close', (code) => {
        console.log(`[Terracotta] Process exited with code ${code}`);
        terracottaStatus.running = false;
        terracottaHttpPort = 0;
        terracottaProcess = null;
        stopTerracottaDaemon();
        if (code !== 0 && code !== null && _terracottaSavedMode) {
            console.warn('[Terracotta] Non-zero exit, attempting auto-recovery...');
            setTimeout(() => recoverTerracotta(), 2000);
        }
    });

    terracottaProcess.on('error', (err) => {
        console.error(`[Terracotta] Process error:`, err.message);
        terracottaStatus.running = false;
        terracottaHttpPort = 0;
        terracottaProcess = null;
    });

    try {
        const port = await waitForTerracottaPort(terracottaPortFilePath, 30000);
        terracottaHttpPort = port;
        terracottaStatus.running = true;
        console.log(`[Terracotta] HTTP API listening on port ${port}`);
        return port;
    } catch (e) {
        if (terracottaProcess) {
            try { terracottaProcess.kill(); } catch (ex) {}
            terracottaProcess = null;
        }
        throw new Error('Terracotta启动超时，请重试');
    }
}

function getPlayerName() {
    try {
        const accountsPath = path.join(DATA_DIR, 'accounts.json');
        if (fs.existsSync(accountsPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
            if (Array.isArray(accounts) && accounts.length > 0) {
                return accounts[0].username || accounts[0].name || 'Player';
            }
        }
    } catch (e) {}
    return 'Player';
}

async function terracottaStartHost(gamePort) {
    const port = await startTerracotta();
    const nodes = await fetchTerracottaPublicNodes();

    terracottaStatus.mode = 'host';
    terracottaStatus.gamePort = gamePort;

    const playerName = getPlayerName();
    const params = {
        player: playerName,
        public_nodes: nodes,
        game_port: gamePort
    };

    await terracottaHttpGet('/state/scanning', params);

    _terracottaSavedMode = 'host';
    _terracottaSavedGamePort = gamePort;
    _terracottaCrashCount = 0;
    startTerracottaDaemon();

    return { success: true, httpPort: port };
}

async function terracottaStartGuest(roomCode) {
    const port = await startTerracotta();
    const nodes = await fetchTerracottaPublicNodes();

    terracottaStatus.mode = 'guest';

    const playerName = getPlayerName();
    const params = {
        room: roomCode,
        player: playerName,
        public_nodes: nodes
    };

    await terracottaHttpGet('/state/guesting', params);

    _terracottaSavedMode = 'guest';
    _terracottaSavedRoomCode = roomCode;
    _terracottaCrashCount = 0;
    startTerracottaDaemon();

    return { success: true, httpPort: port };
}

let _terracottaDaemonTimer = null;
let _terracottaCrashCount = 0;
let _terracottaSavedMode = null;
let _terracottaSavedGamePort = 0;
let _terracottaSavedRoomCode = '';
const TERRACOTTA_MAX_CRASH_RECOVERY = 3;

function startTerracottaDaemon() {
    if (_terracottaDaemonTimer) clearInterval(_terracottaDaemonTimer);
    _terracottaDaemonTimer = setInterval(async () => {
        if (!terracottaHttpPort) return;
        try {
            await getTerracottaState();
        } catch (e) {}
    }, 500);
}

function stopTerracottaDaemon() {
    if (_terracottaDaemonTimer) { clearInterval(_terracottaDaemonTimer); _terracottaDaemonTimer = null; }
}

async function recoverTerracotta() {
    if (_terracottaCrashCount >= TERRACOTTA_MAX_CRASH_RECOVERY) {
        console.error('[Terracotta] Max crash recovery attempts reached');
        stopTerracotta();
        _terracottaCrashCount = 0;
        return false;
    }
    _terracottaCrashCount++;
    console.warn(`[Terracotta] Attempting recovery (${_terracottaCrashCount}/${TERRACOTTA_MAX_CRASH_RECOVERY})...`);
    try {
        terracottaProcess = null;
        terracottaHttpPort = 0;
        if (_terracottaSavedMode === 'host' && _terracottaSavedGamePort) {
            await terracottaStartHost(_terracottaSavedGamePort);
            return true;
        } else if (_terracottaSavedMode === 'guest' && _terracottaSavedRoomCode) {
            await terracottaStartGuest(_terracottaSavedRoomCode);
            return true;
        }
    } catch (e) {
        console.error('[Terracotta] Recovery failed:', e.message);
    }
    return false;
}

function stopTerracotta() {
    stopTerracottaDaemon();
    if (terracottaProcess) {
        try { terracottaProcess.kill(); } catch (e) {}
        terracottaProcess = null;
    }
    terracottaHttpPort = 0;
    _terracottaCrashCount = 0;
    _terracottaSavedMode = null;
    _terracottaSavedGamePort = 0;
    _terracottaSavedRoomCode = '';
    terracottaStatus = { running: false, mode: null, roomCode: '', virtualIP: '', gamePort: 0, state: null, stateIndex: -1, profiles: [], difficulty: null, errorType: null, errorMessage: null };

    if (terracottaPortFilePath) {
        try {
            const tmpDir = path.dirname(terracottaPortFilePath);
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {}
        terracottaPortFilePath = '';
    }

    return { success: true };
}

const TERRACOTTA_ERROR_MAP = {
    0: { key: 'PING_HOST_FAIL', msg: '无法连接到主机，请检查网络' },
    1: { key: 'PING_HOST_RST', msg: '主机连接被重置，可能NAT类型不兼容' },
    2: { key: 'GUEST_ET_CRASH', msg: '客户端网络组件崩溃' },
    3: { key: 'HOST_ET_CRASH', msg: '主机网络组件崩溃' },
    4: { key: 'PING_SERVER_RST', msg: '公共节点连接被重置' },
    5: { key: 'SCAFFOLDING_INVALID_RESPONSE', msg: '服务器返回无效响应' }
};

const TERRACOTTA_FATAL_MAP = {
    'OS': '当前系统不支持陶瓦联机',
    'NETWORK': '网络连接失败，请检查网络设置',
    'INSTALL': '陶瓦组件安装失败',
    'TERRACOTTA': '陶瓦组件运行异常',
    'UNKNOWN': '发生未知错误'
};

async function getTerracottaState() {
    if (!terracottaHttpPort) return null;
    try {
        const state = await terracottaHttpGet('/state');
        if (state && state.state) {
            terracottaStatus.state = state.state;
            terracottaStatus.stateIndex = state.index || -1;

            if (state.state === 'host-ok' && state.room) {
                terracottaStatus.roomCode = state.room;
            }
            if (state.state === 'guest-ok' && state.url) {
                terracottaStatus.virtualIP = state.url;
            }

            if (state.state === 'exception' && state.type !== undefined) {
                const errInfo = TERRACOTTA_ERROR_MAP[state.type];
                if (errInfo) {
                    terracottaStatus.errorType = errInfo.key;
                    terracottaStatus.errorMessage = errInfo.msg;
                }
            }

            if (state.profiles) {
                terracottaStatus.profiles = state.profiles;
            }
            if (state.difficulty !== undefined) {
                terracottaStatus.difficulty = state.difficulty;
            }
        }
        return state;
    } catch (e) {
        return null;
    }
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length];
    return code;
}

function createLANRoom(roomName, gamePort, playerName) {
    const code = generateRoomCode();
    while (lanRooms.has(code)) { code = generateRoomCode(); }
    
    const net = require('net');
    const dgram = require('dgram');
    
    const relayPort = 30000 + Math.floor(Math.random() * 1000);
    
    const room = {
        code,
        name: roomName || `房间 ${code}`,
        hostPlayer: playerName || '主机',
        gamePort: parseInt(gamePort, 10) || 25565,
        relayPort,
        peers: new Map(),
        connections: new Map(),
        createdAt: Date.now(),
        status: 'waiting'
    };
    
    const relayServer = net.createServer((clientSocket) => {
        const peerId = crypto.randomUUID();
        clientSocket.peerId = peerId;
        
        const mcServer = net.createConnection({ host: '127.0.0.1', port: room.gamePort }, () => {
            room.connections.set(peerId, { client: clientSocket, server: mcServer, connected: true });
            room.peers.set(peerId, { id: peerId, name: `玩家${room.peers.size + 1}`, connectedAt: Date.now() });
            console.log(`[LAN] Peer ${peerId} connected, forwarding to MC server :${room.gamePort}`);
        });
        
        clientSocket.on('data', (data) => {
            if (mcServer.writable) mcServer.write(data);
        });
        
        mcServer.on('data', (data) => {
            if (clientSocket.writable) clientSocket.write(data);
        });
        
        clientSocket.on('close', () => {
            mcServer.destroy();
            room.connections.delete(peerId);
            room.peers.delete(peerId);
            console.log(`[LAN] Peer ${peerId} disconnected`);
        });
        
        mcServer.on('close', () => {
            clientSocket.destroy();
            room.connections.delete(peerId);
        });
        
        clientSocket.on('error', () => { mcServer.destroy(); });
        mcServer.on('error', () => { clientSocket.destroy(); });
    });
    
    relayServer.listen(relayPort, '0.0.0.0', () => {
        console.log(`[LAN] Room ${code} relay listening on port ${relayPort}`);
        room.status = 'active';
    });
    
    relayServer.on('error', (e) => {
        console.error(`[LAN] Relay server error:`, e.message);
        room.status = 'error';
    });
    
    room.relayServer = relayServer;
    lanRooms.set(code, room);
    lanRelayServers.set(code, relayServer);
    
    return { code, relayPort, name: room.name };
}

function destroyLANRoom(code) {
    const room = lanRooms.get(code);
    if (!room) return;
    
    room.connections.forEach((conn) => {
        if (conn.client) conn.client.destroy();
        if (conn.server) conn.server.destroy();
    });
    room.peers.clear();
    room.connections.clear();
    
    const relay = lanRelayServers.get(code);
    if (relay) {
        relay.close();
        lanRelayServers.delete(code);
    }
    
    lanRooms.delete(code);
    console.log(`[LAN] Room ${code} destroyed`);
}

function getLANRoomInfo(code) {
    const room = lanRooms.get(code);
    if (!room) return null;
    
    return {
        code: room.code,
        name: room.name,
        hostPlayer: room.hostPlayer,
        gamePort: room.gamePort,
        relayPort: room.relayPort,
        status: room.status,
        peerCount: room.peers.size,
        peers: Array.from(room.peers.values()).map(p => ({
            id: p.id,
            name: p.name,
            connectedAt: p.connectedAt
        }))
    };
}

const upnpMappings = new Map();
let upnpGatewayCache = null;

function getLocalIPForGateway(gatewayAddress) {
    const netIfs = os.networkInterfaces();
    for (const name of Object.keys(netIfs)) {
        for (const net of netIfs[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                const parts = net.address.split('.').map(Number);
                const gwParts = gatewayAddress.split('.').map(Number);
                if (parts[0] === gwParts[0] && parts[1] === gwParts[1] && parts[2] === gwParts[2]) {
                    return net.address;
                }
            }
        }
    }
    for (const name of Object.keys(netIfs)) {
        for (const net of netIfs[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

async function discoverUPnPGateway() {
    if (upnpGatewayCache) {
        return upnpGatewayCache;
    }

    const searchTypes = [
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
        'upnp:rootdevice'
    ];

    for (const st of searchTypes) {
        try {
            const result = await _ssdpSearch(st, 3);
            if (result) {
                upnpGatewayCache = result;
                return result;
            }
        } catch (e) {
            console.log(`[UPnP] SSDP search for ${st} failed:`, e.message);
        }
    }

    throw new Error('UPnP gateway not found. Please check: 1) Router UPnP is enabled 2) Windows SSDP Discovery service is not blocking 3) Firewall allows UDP port 1900');
}

function _ssdpSearch(searchType, maxRetries) {
    return new Promise((resolve, reject) => {
        const dgram = require('dgram');
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        const ssdpMsg = [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'MX: 5',
            `ST: ${searchType}`,
            '', ''
        ].join('\r\n');

        let found = false;
        let retryCount = 0;
        let retryTimer = null;
        const timeout = 8000;

        const timer = setTimeout(() => {
            if (!found) {
                clearTimeout(retryTimer);
                socket.close();
                reject(new Error(`SSDP search timeout for ${searchType}`));
            }
        }, timeout);

        socket.on('message', (msg, rinfo) => {
            const str = msg.toString();
            if (str.includes('InternetGatewayDevice') || str.includes('WANIPConnection') || str.includes('WANPPPConnection')) {
                const locationMatch = str.match(/LOCATION:\s*(.+)/i);
                if (locationMatch) {
                    found = true;
                    clearTimeout(timer);
                    clearTimeout(retryTimer);
                    socket.close();
                    const result = { location: locationMatch[1].trim(), address: rinfo.address };
                    resolve(result);
                }
            }
        });

        socket.on('error', (e) => {
            clearTimeout(timer);
            clearTimeout(retryTimer);
            socket.close();
            reject(e);
        });

        socket.bind(() => {
            try {
                socket.addMembership('239.255.255.250');
            } catch (e) {
                console.log('[UPnP] addMembership failed (non-fatal):', e.message);
            }
            socket.setBroadcast(true);
            socket.setMulticastTTL(4);

            const sendSearch = () => {
                if (found || retryCount >= maxRetries) return;
                retryCount++;
                socket.send(ssdpMsg, 1900, '239.255.255.250', (err) => {
                    if (err) {
                        clearTimeout(timer);
                        clearTimeout(retryTimer);
                        socket.close();
                        reject(err);
                    }
                });
                if (retryCount < maxRetries) {
                    retryTimer = setTimeout(sendSearch, 2000);
                }
            };
            sendSearch();
        });
    });
}

async function getUPnPControlURL(gatewayLocation) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(gatewayLocation); } catch (e) { return reject(new Error('Invalid gateway URL')); }
        
        const req = http.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: parsedUrl.pathname + (parsedUrl.search || ''),
            method: 'GET',
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/<URLBase>(.*?)<\/URLBase>/);
                const baseUrl = match ? match[1] : `${parsedUrl.protocol}//${parsedUrl.host}`;
                
                const serviceTypes = [
                    'urn:schemas-upnp-org:service:WANIPConnection:1',
                    'urn:schemas-upnp-org:service:WANIPConnection:2',
                    'urn:schemas-upnp-org:service:WANPPPConnection:1'
                ];

                for (const svcType of serviceTypes) {
                    const escapedType = svcType.replace(/([.:])/g, '\\$1');
                    const svcRegex = new RegExp(
                        `<service>[\\s\\S]*?<serviceType>${escapedType}<\\/serviceType>[\\s\\S]*?<controlURL>(.*?)<\\/controlURL>[\\s\\S]*?<\\/service>`, 'i'
                    );
                    const svcMatch = data.match(svcRegex);
                    if (svcMatch) {
                        resolve({ baseUrl, controlUrl: svcMatch[1], serviceType: svcType });
                        return;
                    }
                }

                const anyWanMatch = data.match(/<service>[\s\S]*?<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d+)<\/serviceType>[\s\S]*?<controlURL>(.*?)<\/controlURL>[\s\S]*?<\/service>/i);
                if (anyWanMatch) {
                    resolve({ baseUrl, controlUrl: anyWanMatch[2], serviceType: anyWanMatch[1] });
                    return;
                }

                reject(new Error('WANIPConnection service not found in gateway description'));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching gateway description')); });
        req.end();
    });
}

async function upnpAddPortMapping(internalPort, externalPort, description) {
    try {
        const gateway = await discoverUPnPGateway();
        const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
        const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';
        const localIP = getLocalIPForGateway(gateway.address);
        
        let parsedBase;
        try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
        const soapBody = [
            '<?xml version="1.0"?>',
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
            '<s:Body>',
            `<u:AddPortMapping xmlns:u="${svcType}">`,
            '<NewRemoteHost></NewRemoteHost>',
            `<NewExternalPort>${externalPort}</NewExternalPort>`,
            '<NewProtocol>TCP</NewProtocol>',
            `<NewInternalClient>${localIP}</NewInternalClient>`,
            `<NewInternalPort>${internalPort}</NewInternalPort>`,
            '<NewEnabled>1</NewEnabled>',
            `<NewPortMappingDescription>${description || 'VersePC'}</NewPortMappingDescription>`,
            '<NewLeaseDuration>0</NewLeaseDuration>',
            '</u:AddPortMapping>',
            '</s:Body>',
            '</s:Envelope>'
        ].join('');

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: parsedBase.hostname,
                port: parsedBase.port || 80,
                path: controlUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${svcType}#AddPortMapping"`,
                    'Content-Length': Buffer.byteLength(soapBody)
                },
                timeout: 10000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    upnpMappings.set(externalPort, { internalPort, description, localIP });
                    resolve({ success: true, externalPort, internalPort, localIP });
                } else {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        const errorCodeMatch = data.match(/<errorCode>(\d+)<\/errorCode>/);
                        const errorDescMatch = data.match(/<errorDescription>(.*?)<\/errorDescription>/);
                        const errorCode = errorCodeMatch ? errorCodeMatch[1] : res.statusCode;
                        const errorDesc = errorDescMatch ? errorDescMatch[1] : data.substring(0, 200);
                        
                        if (errorCode === '725') {
                            reject(new Error('Router does not allow permanent port mapping (error 725). Try with a lease duration.'));
                        } else if (errorCode === '718') {
                            reject(new Error('Port mapping conflict: another mapping already exists for this port (error 718).'));
                        } else if (errorCode === '606') {
                            reject(new Error('Router rejected the mapping (error 606). Try a different external port.'));
                        } else {
                            reject(new Error(`UPnP AddPortMapping failed: ${errorCode} ${errorDesc}`));
                        }
                    });
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(soapBody);
            req.end();
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function upnpDeletePortMapping(externalPort) {
    try {
        const gateway = await discoverUPnPGateway();
        const { baseUrl, controlUrl, serviceType } = await getUPnPControlURL(gateway.location);
        const svcType = serviceType || 'urn:schemas-upnp-org:service:WANIPConnection:1';
        
        let parsedBase;
        try { parsedBase = new URL(baseUrl); } catch (e) { return { success: false, error: 'Invalid base URL' }; }
        const soapBody = [
            '<?xml version="1.0"?>',
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
            '<s:Body>',
            `<u:DeletePortMapping xmlns:u="${svcType}">`,
            '<NewRemoteHost></NewRemoteHost>',
            `<NewExternalPort>${externalPort}</NewExternalPort>`,
            '<NewProtocol>TCP</NewProtocol>',
            '</u:DeletePortMapping>',
            '</s:Body>',
            '</s:Envelope>'
        ].join('');

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: parsedBase.hostname,
                port: parsedBase.port || 80,
                path: controlUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'SOAPAction': `"${svcType}#DeletePortMapping"`,
                    'Content-Length': Buffer.byteLength(soapBody)
                },
                timeout: 10000
            }, (res) => {
                if (res.statusCode === 200 || res.statusCode === 204) {
                    upnpMappings.delete(externalPort);
                    upnpGatewayCache = null;
                    resolve({ success: true });
                } else {
                    reject(new Error(`UPnP DeletePortMapping failed: ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(soapBody);
            req.end();
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getPublicIP() {
    const services = [
        'https://api.ipify.org?format=json',
        'https://api64.ipify.org?format=json',
        'https://ifconfig.me/ip'
    ];
    
    for (const service of services) {
        try {
            const result = await new Promise((resolve, reject) => {
                const client = service.startsWith('https') ? https : http;
                const req = client.get(service, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json.ip);
                        } catch {
                            resolve(data.trim());
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
            });
            if (result && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(result)) {
                return result;
            }
        } catch (e) { continue; }
    }
    return null;
}

const WebSocket = require('ws');
let wsRelayServer = null;
const wsRelayRooms = new Map();

function startWSRelayServer(port) {
    if (wsRelayServer) return { success: true, port: wsRelayServer.port };
    
    try {
        wsRelayServer = new WebSocket.Server({ port, maxPayload: 10 * 1024 * 1024 });
        wsRelayServer.port = port;
        
        wsRelayServer.on('connection', (ws, req) => {
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    handleWSMessage(ws, msg);
                } catch (e) {}
            });
            
            ws.on('close', () => {
                if (ws.roomCode) {
                    const room = wsRelayRooms.get(ws.roomCode);
                    if (room) {
                        if (ws.role === 'host') {
                            room.host = null;
                            room.clients.forEach(c => { try { c.close(); } catch(e){} });
                            wsRelayRooms.delete(ws.roomCode);
                        } else {
                            room.clients.delete(ws);
                            if (room.host) {
                                try { room.host.send(JSON.stringify({ type: 'peer-left', peerId: ws.peerId })); } catch(e){}
                            }
                        }
                    }
                }
            });
        });
        
        const interval = setInterval(() => {
            wsRelayServer.clients.forEach(ws => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
        
        wsRelayServer.on('close', () => clearInterval(interval));
        
        console.log(`[WS-Relay] Server started on port ${port}`);
        return { success: true, port };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function handleWSMessage(ws, msg) {
    switch (msg.type) {
        case 'create-room': {
            const code = msg.code || generateRoomCode();
            while (wsRelayRooms.has(code)) { code = generateRoomCode(); }
            
            ws.roomCode = code;
            ws.role = 'host';
            
            const room = {
                code,
                host: ws,
                clients: new Set(),
                gamePort: msg.gamePort || 25565,
                roomName: msg.roomName || `房间 ${code}`,
                hostPlayer: msg.hostPlayer || '主机',
                createdAt: Date.now()
            };
            wsRelayRooms.set(code, room);
            
            ws.send(JSON.stringify({ type: 'room-created', code, gamePort: room.gamePort }));
            break;
        }
        case 'join-room': {
            const code = (msg.code || '').toUpperCase().trim();
            const room = wsRelayRooms.get(code);
            
            if (!room || !room.host) {
                ws.send(JSON.stringify({ type: 'join-failed', error: '房间不存在' }));
                return;
            }
            
            ws.roomCode = code;
            ws.role = 'client';
            ws.peerId = crypto.randomUUID();
            ws.playerName = msg.playerName || '玩家';
            
            room.clients.add(ws);
            
            ws.send(JSON.stringify({ 
                type: 'join-success', 
                code, 
                peerId: ws.peerId,
                roomName: room.roomName,
                hostPlayer: room.hostPlayer
            }));
            
            try {
                room.host.send(JSON.stringify({ 
                    type: 'peer-joined', 
                    peerId: ws.peerId, 
                    playerName: ws.playerName 
                }));
            } catch(e){}
            break;
        }
        case 'mc-data': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-data', data: msg.data, peerId: ws.peerId })); } catch(e){}
                }
            } else if (ws.role === 'host' && ws.roomCode) {
                const room = wsRelayRooms.get(ws.roomCode);
                if (room && msg.peerId) {
                    room.clients.forEach(client => {
                        if (client.peerId === msg.peerId) {
                            try { client.send(JSON.stringify({ type: 'mc-data', data: msg.data })); } catch(e){}
                        }
                    });
                }
            }
            break;
        }
        case 'mc-connect': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-connect', peerId: ws.peerId, playerName: ws.playerName })); } catch(e){}
                }
            }
            break;
        }
        case 'mc-disconnect': {
            if (ws.role === 'client' && ws.roomCode) {
                const room = wsRelayRooms.get(ws.roomCode);
                if (room && room.host) {
                    try { room.host.send(JSON.stringify({ type: 'mc-disconnect', peerId: ws.peerId })); } catch(e){}
                }
            }
            break;
        }
        case 'list-rooms': {
            const rooms = [];
            wsRelayRooms.forEach((room, code) => {
                if (room.host) {
                    rooms.push({ code, name: room.roomName, hostPlayer: room.hostPlayer, peers: room.clients.size });
                }
            });
            ws.send(JSON.stringify({ type: 'room-list', rooms }));
            break;
        }
    }
}

[DATA_DIR, VERSIONS_DIR, LIBRARIES_DIR, ASSETS_DIR, JAVA_DIR, NATIVES_DIR, LOGS_DIR, ICON_CACHE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let cacheDirty = false;
(function loadDiskCacheLazy() {
    try {
        if (fs.existsSync(DISK_CACHE_PATH)) {
            const cached = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8'));
            if (cached && cached.data && cached.timestamp) {
                versionCache = cached.data;
                versionCacheTime = cached.timestamp;
            }
        }
    } catch (e) {}
})();

async function applyPerformanceOptimizations(pid) {
    if (!pid) return;

    let performanceBoost = true;
    try {
        const storePath = path.join(os.homedir(), '.versepc', 'app-store.json');
        if (fs.existsSync(storePath)) {
            const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const launchStr = store['versepc_launch_settings'];
            if (launchStr) {
                const launchSettings = JSON.parse(launchStr);
                if (launchSettings.performanceBoost !== undefined) performanceBoost = launchSettings.performanceBoost;
            }
        }
    } catch (e) {}

    if (!performanceBoost) {
        try { os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL); } catch(e) {}
        return;
    }

    try {
        os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
        console.log(`[Perf] 进程 ${pid} 优先级设为 HIGH`);
    } catch (e) {
        try {
            os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
            console.log(`[Perf] 进程 ${pid} 优先级设为 ABOVE_NORMAL`);
        } catch (e2) {
            console.log(`[Perf] 设置进程优先级失败: ${e2.message}`);
        }
    }

    try {
        const psScript = `
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($proc) {
    $cpu = Get-CimInstance Win32_Processor
    $coreCount = $cpu.NumberOfLogicalProcessors
    if ($coreCount -ge 8) {
        $pCores = [math]::Floor($coreCount * 0.75)
        $mask = [math]::Pow(2, $pCores) - 1
        $proc.ProcessorAffinity = $mask
    }
    try {
        $proc.PriorityClass = 'High'
    } catch {}
    try {
        $proc.IOPriority = [System.Diagnostics.ProcessPriorityClass]::High
    } catch {}
}
`.trim();
        const tmpScript = path.join(os.tmpdir(), `versepc_perf_${pid}.ps1`);
        fs.writeFileSync(tmpScript, psScript, 'utf8');
        exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`, { timeout: 10000 }, (err) => {
            try { fs.unlinkSync(tmpScript); } catch (e) {}
            if (err) {
                console.log(`[Perf] CPU亲和性设置失败: ${err.message}`);
            } else {
                console.log(`[Perf] CPU亲和性和I/O优先级已优化 for PID ${pid}`);
            }
        });
    } catch (e) {
        console.log(`[Perf] 性能优化脚本执行失败: ${e.message}`);
    }
}

function loadSettings() {
    const defaults = {
        javaPath: '',
        maxMemory: 4096,
        minMemory: 1024,
        gameDir: DATA_DIR,
        versionIsolation: true,
        javaArgs: '',
        fullscreen: false,
        resolution: '1920x1080',
        autoUpdate: true,
        closeOnLaunch: false,
        selectedVersion: '',
        selectedAccount: '',

        downloadSource: 'auto',
        versionSource: 'auto',
        maxThreads: 32,
        enableChunkDownload: true,
        maxChunksPerFile: 8,
        speedLimit: 0,
        targetDir: '',
        sslVerify: false,

        modSource: 'modrinth',
        filenameFormat: 'default',
        modStyle: 'title',
        ignoreQuilt: false,

        accentColor: '#4a9eff',
        blurBg: true,
        backgroundImage: '',
        avatarImage: '',
        autoSetChinese: true,
        jvmPreheat: true,
        enableCds: true
    };

    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
            return { ...defaults, ...saved };
        }
    } catch (e) {}
    return defaults;
}

let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 2000;

function loadSettingsCached() {
    const now = Date.now();
    if (_settingsCache && (now - _settingsCacheTime) < SETTINGS_CACHE_TTL) {
        return _settingsCache;
    }
    _settingsCache = loadSettings();
    _settingsCacheTime = now;
    return _settingsCache;
}

function invalidateSettingsCache() {
    _settingsCache = null;
    _settingsCacheTime = 0;
}

function saveSettings(settings) {
    invalidateSettingsCache();
    _settingsCache = settings;
    _settingsCacheTime = Date.now();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function resolveSavesDir(versionId) {
    if (!versionId) {
        const settings = loadSettingsCached();
        versionId = settings.selectedVersion || '';
    }
    if (!versionId) return path.join(DATA_DIR, 'saves');

    const gameDir = getVersionGameDir(versionId);
    if (gameDir) return path.join(gameDir, 'saves');
    return path.join(DATA_DIR, 'saves');
}

async function checkModUpdates(versionId) {
    const modsDir = getVersionModsDir(versionId);
    if (!modsDir || !fs.existsSync(modsDir)) return { updates: [], total: 0, checked: 0 };

    const modFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.jar.disabled'));
    if (modFiles.length === 0) return { updates: [], total: 0, checked: 0 };

    const hashes = {};
    for (const file of modFiles) {
        try {
            const filePath = path.join(modsDir, file);
            const hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
            hashes[hash] = { fileName: file, filePath, hash };
        } catch (e) {}
    }

    const hashList = Object.keys(hashes);
    if (hashList.length === 0) return { updates: [], total: modFiles.length, checked: 0 };

    try {
        const versionRes = await fetchJSONWithMethod(
            `${MODRINTH_API}/version_files`,
            'POST',
            JSON.stringify({ hashes: hashList, algorithm: 'sha1' }),
            { 'Content-Type': 'application/json', 'User-Agent': 'VersePC/2.0 (PCL2)' }
        );

        const projectIds = [...new Set(Object.values(versionRes).map(v => v.project_id))];
        let projectMap = {};
        if (projectIds.length > 0) {
            try {
                const projects = await fetchJSON(`${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`);
                projects.forEach(p => projectMap[p.id] = p);
            } catch (e) {}
        }

        const updates = [];
        for (const [hash, info] of Object.entries(versionRes)) {
            const local = hashes[hash];
            if (!local) continue;
            const project = projectMap[info.project_id];
            updates.push({
                fileName: local.fileName,
                modName: project?.title || info.project_id,
                currentVersion: info.version_number || '',
                currentVersionId: info.id || '',
                projectUrl: `https://modrinth.com/mod/${info.project_id}`,
                projectId: info.project_id
            });
        }

        return { updates, total: modFiles.length, checked: hashList.length };
    } catch (e) {
        return { updates: [], total: modFiles.length, checked: hashList.length, error: e.message };
    }
}

function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
            return raw.map(acc => {
                if (acc.accessToken && acc.accessToken.startsWith('enc:')) {
                    try { acc.accessToken = decryptToken(acc.accessToken.slice(4)); } catch (e) {}
                }
                if (acc.refreshToken && acc.refreshToken.startsWith('enc:')) {
                    try { acc.refreshToken = decryptToken(acc.refreshToken.slice(4)); } catch (e) {}
                }
                return acc;
            });
        }
    } catch (e) {}
    return [];
}

const TOKEN_ENC_ALGO = 'aes-256-cbc';
let _tokenEncKey = null;
function getTokenEncKey() {
    if (_tokenEncKey) return _tokenEncKey;
    const machineId = require('os').hostname() + require('os').userInfo().username + DATA_DIR;
    _tokenEncKey = crypto.createHash('sha256').update(machineId).digest();
    return _tokenEncKey;
}
function encryptToken(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(TOKEN_ENC_ALGO, getTokenEncKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decryptToken(data) {
    const [ivHex, encrypted] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(TOKEN_ENC_ALGO, getTokenEncKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function saveAccounts(accounts) {
    const toSave = accounts.map(acc => {
        const copy = { ...acc };
        if (copy.accessToken) copy.accessToken = 'enc:' + encryptToken(copy.accessToken);
        if (copy.refreshToken) copy.refreshToken = 'enc:' + encryptToken(copy.refreshToken);
        return copy;
    });
    const json = JSON.stringify(toSave, null, 2);
    const tmpFile = ACCOUNTS_FILE + '.tmp';
    try {
        fs.writeFileSync(tmpFile, json);
        fs.renameSync(tmpFile, ACCOUNTS_FILE);
    } catch (e) {
        try { fs.writeFileSync(ACCOUNTS_FILE, json); } catch (e2) {}
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e3) {}
    }
}

const VERSIONS_DATA_FILE = path.join(DATA_DIR, 'versions-data.json');
const EXTERNAL_FOLDERS_FILE = path.join(DATA_DIR, 'external-folders.json');

function loadVersions() {
    try {
        if (fs.existsSync(VERSIONS_DATA_FILE)) {
            return JSON.parse(fs.readFileSync(VERSIONS_DATA_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveVersions(versionsData) {
    fs.writeFileSync(VERSIONS_DATA_FILE, JSON.stringify(versionsData, null, 2));
}

function cleanupVersionChain(versionId) {
    const toDelete = [versionId];
    const dvJsonPath = path.join(VERSIONS_DIR, versionId, `${versionId}.json`);
    if (fs.existsSync(dvJsonPath)) {
        try {
            const dvJson = JSON.parse(fs.readFileSync(dvJsonPath, 'utf-8'));
            let currentId = dvJson.inheritsFrom;
            while (currentId) {
                if (toDelete.includes(currentId)) break;
                let hasOtherChildren = false;
                try {
                    const allDirs = fs.readdirSync(VERSIONS_DIR);
                    for (const d of allDirs) {
                        if (toDelete.includes(d)) continue;
                        const dJsonFile = path.join(VERSIONS_DIR, d, `${d}.json`);
                        if (fs.existsSync(dJsonFile)) {
                            try {
                                const dJson = JSON.parse(fs.readFileSync(dJsonFile, 'utf-8'));
                                if (dJson.inheritsFrom === currentId) {
                                    hasOtherChildren = true;
                                    break;
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
                if (hasOtherChildren) break;
                toDelete.push(currentId);
                const pJsonPath = path.join(VERSIONS_DIR, currentId, `${currentId}.json`);
                if (fs.existsSync(pJsonPath)) {
                    try {
                        const pJson = JSON.parse(fs.readFileSync(pJsonPath, 'utf-8'));
                        currentId = pJson.inheritsFrom || null;
                    } catch (e) { currentId = null; }
                } else { currentId = null; }
            }
        } catch (e) {}
    }
    for (const id of toDelete) {
        try {
            const dir = path.join(VERSIONS_DIR, id);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                console.log(`[Cleanup] Deleted version: ${id}`);
            }
        } catch (e) {
            console.error(`[Cleanup] Failed to delete ${id}:`, e.message);
        }
    }
    return toDelete;
}

function cleanupIncompleteVersion(versionDir) {
    if (!fs.existsSync(versionDir)) return;
    try {
        fs.rmSync(versionDir, { recursive: true, force: true });
        console.log(`[Cleanup] 删除不完整版本目录: ${path.basename(versionDir)}`);
    } catch (e) {
        console.error(`[Cleanup] 删除失败: ${versionDir} - ${e.message}`);
    }
}

function isVersionComplete(versionId) {
    const versionJson = resolveVersionJson(versionId);
    if (!versionJson) return false;

    if (versionJson.inheritsFrom) {
        const parentJsonPath = path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
        if (!fs.existsSync(parentJsonPath)) return false;
        const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
        if (!parentData.inheritsFrom) {
            const parentJarPath = path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`);
            if (!fs.existsSync(parentJarPath)) return false;
        }
    }

    const mainJarPath = path.join(VERSIONS_DIR, versionId, `${versionId}.jar`);
    if (!versionJson.inheritsFrom && !fs.existsSync(mainJarPath)) return false;

    const isForgeChain = versionId.toLowerCase().includes('forge') ||
        (versionJson.inheritsFrom && versionJson.inheritsFrom.toLowerCase().includes('forge'));
    if (isForgeChain && versionJson.libraries) {
        let forgeCoreMissing = 0;
        for (const lib of versionJson.libraries) {
            if (!lib.name) continue;
            const fp = lib.name.split(':');
            if (fp.length < 3) continue;
            const gp = fp[0].replace(/\./g, path.sep);
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const jn = `${fp[1]}-${fp[2]}${cl}.jar`;
            const libPath = path.join(LIBRARIES_DIR, gp, fp[1], fp[2], jn);
            const isForgeCore = (
                (fp[0] === 'net.minecraftforge' && fp[1] === 'forge') ||
                (fp[0] === 'net.minecraft' && fp[1] === 'client' && (fp[3] === 'srg' || fp[3] === 'extra'))
            );
            if (isForgeCore && !fs.existsSync(libPath)) {
                forgeCoreMissing++;
                console.log(`[isVersionComplete] ${versionId}: Forge核心库缺失: ${jn}`);
            }
        }
        if (forgeCoreMissing > 0) {
            console.log(`[isVersionComplete] ${versionId}: ${forgeCoreMissing}个Forge核心库缺失，标记为不完整`);
            return false;
        }
    }

    return true;
}

function validateInstalledVersions() {
    console.log('[Startup] 验证已安装版本完整性...');
    if (!fs.existsSync(VERSIONS_DIR)) return;

    const cleaned = [];
    try {
        const dirs = fs.readdirSync(VERSIONS_DIR);
        for (const dir of dirs) {
            const versionDir = path.join(VERSIONS_DIR, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
            } catch (e) { continue; }

            const jsonFile = findVersionJson(versionDir);
            if (!jsonFile) continue;

            try {
                const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                const verId = data.id || dir;

                if (!isVersionComplete(verId)) {
                    console.log(`[Startup] 检测到不完整版本: ${verId}`);
                    cleanupVersionChain(verId);
                    cleaned.push(verId);
                }
            } catch (e) {
                console.log(`[Startup] 版本JSON损坏: ${dir} - ${e.message}`);
                cleanupIncompleteVersion(versionDir);
                cleaned.push(dir);
            }
        }
    } catch (e) {
        console.error(`[Startup] 版本扫描失败: ${e.message}`);
    }

    if (cleaned.length > 0) {
        console.log(`[Startup] 已清理 ${cleaned.length} 个不完整版本: ${cleaned.join(', ')}`);
    }
}

function cleanupOnShutdown() {
    console.log('[Shutdown] 开始中断所有下载任务...');

    for (const [sessionId, session] of installSessions) {
        if (session.status === 'downloading' || session.status === 'preparing') {
            session.status = 'cancelled';
            session.stage = 'cancelled';
            session.message = '应用已关闭';

            if (session._abortController) {
                try { session._abortController.abort(); } catch (e) {}
            }

            if (session.versionId) {
                const versionDir = path.join(VERSIONS_DIR, session.versionId);
                cleanupIncompleteVersion(versionDir);
            }
        }
    }

    for (const [sessionId, session] of modDownloadSessions) {
        if (session.status === 'downloading' || session.status === 'install') {
            session.status = 'cancelled';
            session.message = '应用已关闭';

            if (session._abortController) {
                try { session._abortController.abort(); } catch (e) {}
            }
        }
    }

    console.log('[Shutdown] 下载任务清理完成');
}

function resolveLibraryPath(libName) {
    const parts = libName.split(':');
    if (parts.length < 3) return null;
    const groupPath = parts[0].replace(/\./g, '/');
    const name = parts[1];
    const version = parts[2];
    const fileName = `${name}-${version}.jar`;
    return path.join(LIBRARIES_DIR, groupPath, name, version, fileName);
}

function diagnoseVersion(versionId) {
    const issues = [];
    const cleanId = versionId.replace(' [外部]', '');
    let versionDir = null;
    const extFolders = loadExternalFolders();
    for (const folder of extFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const extVers = scanExternalFolder(folder.path);
        if (extVers.some(v => v.id === cleanId)) {
            versionDir = path.join(folder.path, cleanId);
            break;
        }
    }
    if (!versionDir) {
        versionDir = path.join(VERSIONS_DIR, cleanId);
    }

    if (!fs.existsSync(versionDir)) {
        return { issues: [{ type: 'critical', message: '版本目录不存在', solution: '请重新安装此版本' }] };
    }

    const versionJsonPath = findVersionJson(versionDir);
    if (!versionJsonPath) {
        issues.push({ type: 'critical', message: '版本 JSON 文件缺失', solution: '请重新安装此版本或修复版本文件' });
    } else {
        try {
            const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));

            if (!vj.mainClass) {
                issues.push({ type: 'critical', message: '主类缺失', solution: '版本 JSON 损坏，请重新安装' });
            }

            if (vj.libraries && Array.isArray(vj.libraries)) {
                let missingLibs = 0;
                for (const lib of vj.libraries) {
                    if (!lib.name) continue;
                    const libNameSuffix = lib.name.split(':').pop();
                    if (libNameSuffix.startsWith('natives-')) continue;
                    if (lib.rules && !evaluateRules(lib.rules)) continue;
                    if (lib.downloads && lib.downloads.artifact) {
                        const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                        if (!fs.existsSync(libPath)) {
                            missingLibs++;
                        }
                    } else {
                        const libPath = resolveLibraryPath(lib.name);
                        if (libPath && !fs.existsSync(libPath)) {
                            missingLibs++;
                        }
                    }
                }
                if (missingLibs > 0) {
                    issues.push({ type: 'warning', message: `${missingLibs} 个依赖库文件缺失`, solution: '点击修复以下载缺失的库文件' });
                }
            }

            if (vj.inheritsFrom) {
                const parentJsonPath = path.join(VERSIONS_DIR, vj.inheritsFrom, `${vj.inheritsFrom}.json`);
                if (!fs.existsSync(parentJsonPath)) {
                    issues.push({ type: 'critical', message: `缺少基础版本 ${vj.inheritsFrom}`, solution: `请先安装原版 ${vj.inheritsFrom}` });
                }
                const parentJarPath = path.join(VERSIONS_DIR, vj.inheritsFrom, `${vj.inheritsFrom}.jar`);
                if (!fs.existsSync(parentJarPath)) {
                    issues.push({ type: 'critical', message: '缺少基础版本 JAR 文件', solution: `重新安装原版 ${vj.inheritsFrom}` });
                }
            } else {
                const jarName = vj.jar || cleanId;
                const jarPath = path.join(versionDir, `${jarName}.jar`);
                if (!fs.existsSync(jarPath)) {
                    issues.push({ type: 'critical', message: '游戏主 JAR 文件缺失', solution: '请重新安装此版本' });
                }
            }

            if (vj.javaVersion) {
                const requiredVer = vj.javaVersion.majorVersion;
                const settings = loadSettingsCached();
                let javaPath = settings.javaPath;
                if (!javaPath) {
                    const allJava = [...detectBundledJava(), ...detectSystemJava()];
                    if (allJava.length > 0) javaPath = (allJava.find(j => j.majorVersion >= 17) || allJava[0]).path;
                }
                if (javaPath && fs.existsSync(javaPath)) {
                    try {
                        const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                        const verMatch = verOutput.match(/version "([^"]+)"/);
                        if (verMatch) {
                            const ver = verMatch[1];
                            const major = parseInt(ver.startsWith('1.') ? ver.split('.')[1] : ver.split('.')[0], 10);
                            if (major < requiredVer) {
                                issues.push({ type: 'warning', message: `此版本需要 Java ${requiredVer}+，当前 Java 版本: ${ver}`, solution: `请安装 Java ${requiredVer} 或更高版本` });
                            }
                        }
                    } catch (e) {}
                } else {
                    issues.push({ type: 'warning', message: `此版本需要 Java ${requiredVer}+，但未检测到 Java`, solution: '请在设置中配置 Java 路径或安装 Java' });
                }
            }
        } catch (e) {
            issues.push({ type: 'critical', message: '版本 JSON 格式错误', solution: '请重新安装此版本' });
        }
    }

    if (!fs.existsSync(ASSETS_DIR)) {
        issues.push({ type: 'warning', message: '资源文件目录不存在', solution: '启动游戏时会自动下载资源文件' });
    }

    const modsDir = path.join(versionDir, 'mods');
    if (fs.existsSync(modsDir)) {
        const disabledMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar.disabled') || f.endsWith('.jar.disabled_backup'));
        if (disabledMods.length > 0) {
            issues.push({ type: 'info', message: `${disabledMods.length} 个模组已被禁用`, solution: '如需启用，请在模组管理中操作' });
        }
    }

    const crashDir = path.join(versionDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
        const recentCrashes = fs.readdirSync(crashDir).filter(f => {
            try {
                const stat = fs.statSync(path.join(crashDir, f));
                return Date.now() - stat.mtimeMs < 86400000;
            } catch (e) { return false; }
        });
        if (recentCrashes.length > 0) {
            issues.push({ type: 'warning', message: `最近24小时有 ${recentCrashes.length} 次崩溃记录`, solution: '建议查看崩溃日志分析原因' });
        }
    }

    if (issues.length === 0) {
        issues.push({ type: 'info', message: '未发现问题', solution: '版本状态正常' });
    }

    return { issues };
}

async function performRepair(sessionId, versionId) {
    const session = repairSessions.get(sessionId);
    if (!session) return;

    const isAborted = () => session.status === 'cancelled' || (session._abortController && session._abortController.signal.aborted);

    try {
        if (isAborted()) return;

        // Phase 1: Create missing directories (0-3%)
        session.status = 'running';
        session.stage = 'directories';
        session.message = '正在检查目录结构...';
        session.progress = 1;
        const verDir = path.join(VERSIONS_DIR, versionId);
        const dirsToCheck = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'logs', 'crash-reports', 'natives'];
        for (const d of dirsToCheck) {
            const dp = path.join(verDir, d);
            if (!fs.existsSync(dp)) {
                fs.mkdirSync(dp, { recursive: true });
            }
        }
        session.progress = 3;

        if (isAborted()) return;

        // Phase 2: Resolve version JSON and collect all libraries (3-10%)
        session.stage = 'resolve';
        session.message = '正在解析版本JSON...';
        const versionJson = resolveVersionJson(versionId);
        if (!versionJson) {
            session.status = 'failed';
            session.stage = 'failed';
            session.message = '版本JSON文件缺失，无法修复';
            return;
        }
        session.progress = 8;

        if (isAborted()) return;

        // Phase 3: Scan all libraries for missing/corrupted files (10-25%)
        session.stage = 'scanning';
        session.message = '正在扫描库文件...';

        function collectAllLibraries(verId, visited = new Set()) {
            if (visited.has(verId)) return [];
            visited.add(verId);
            const jsonPath = path.join(VERSIONS_DIR, verId, `${verId}.json`);
            if (!fs.existsSync(jsonPath)) return [];
            let result = [];
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                const libs = (data.libraries || []).filter(lib => {
                    if (lib.rules && !evaluateRules(lib.rules)) return false;
                    return true;
                });
                result = libs;
                if (data.inheritsFrom) {
                    result = [...collectAllLibraries(data.inheritsFrom, visited), ...result];
                }
            } catch (e) {}
            return result;
        }

        const allLibs = collectAllLibraries(versionId);
        session.totalFiles = allLibs.length;
        session.message = `正在扫描 ${allLibs.length} 个库文件...`;

        const missingLibs = [];
        const corruptLibs = [];
        for (let i = 0; i < allLibs.length; i++) {
            if (isAborted()) return;
            const lib = allLibs[i];
            session.checkedFiles = i + 1;
            session.progress = 10 + (i / allLibs.length) * 15;
            if (i % 50 === 0) {
                session.message = `正在扫描库文件 (${i+1}/${allLibs.length})...`;
            }

            const libPath = resolveLibraryPath(lib);
            if (!libPath) continue;

            if (!fs.existsSync(libPath)) {
                missingLibs.push({ lib, path: libPath });
            } else if (libPath.endsWith('.jar') && !isJarIntact(libPath)) {
                corruptLibs.push({ lib, path: libPath });
            }
        }
        session.missingFiles = missingLibs.length + corruptLibs.length;
        session.checkedFiles = allLibs.length;
        session.progress = 25;

        if (isAborted()) return;

        // Phase 4: Check client JAR (25-30%)
        session.stage = 'client_jar';
        session.message = '正在检查客户端JAR...';
        const actualVerId = versionJson.inheritsFrom || versionId;
        const jarPath = path.join(VERSIONS_DIR, actualVerId, `${actualVerId}.jar`);
        const jarMissing = !fs.existsSync(jarPath);
        if (jarMissing) {
            missingLibs.push({ lib: { name: `${actualVerId}.jar`, downloads: { artifact: versionJson.downloads?.client } }, path: jarPath });
            session.missingFiles++;
        }
        session.progress = 30;

        if (isAborted()) return;

        // Phase 5: Download missing/corrupted files (30-95%)
        session.stage = 'downloading';
        const allMissing = [...corruptLibs, ...missingLibs];
        const uniqueMissing = [];
        const seen = new Set();
        for (const item of allMissing) {
            if (!seen.has(item.path)) { seen.add(item.path); uniqueMissing.push(item); }
        }

        session.missingFiles = uniqueMissing.length;
        session.totalFiles = uniqueMissing.length > 0 ? uniqueMissing.length : allLibs.length;

        let repaired = 0;
        let failed = 0;
        const failedList = [];

        for (let i = 0; i < uniqueMissing.length; i++) {
            if (isAborted()) { session.message = '修复已取消'; return; }

            const item = uniqueMissing[i];
            const lib = item.lib;
            const libPath = item.path;

            session.currentFile = path.basename(libPath);
            session.message = `正在修复 (${i+1}/${uniqueMissing.length}): ${session.currentFile}`;
            session.progress = 30 + (i / Math.max(uniqueMissing.length, 1)) * 65;
            session.repairedFiles = repaired;

            if (isJarIntact(libPath)) { repaired++; continue; }

            let url = null;
            if (lib.downloads?.artifact?.url) {
                url = lib.downloads.artifact.url;
            } else if (lib.name) {
                const p = lib.name.split(':');
                if (p.length >= 3) {
                    const mg = p[0].replace(/\./g, '/');
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const base = lib.url || (p[0].includes('forge') || p[0].includes('minecraftforge') || p[0].includes('neoforged') || p[0].includes('minecraft')
                        ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                    url = `${base}${mg}/${p[1]}/${p[2]}/${jn}`;
                }
            }
            if (!url && lib.downloads?.client?.url) {
                url = lib.downloads.client.url;
            }

            if (!url) {
                failed++;
                failedList.push(path.basename(libPath));
                continue;
            }

            try {
                if (fs.existsSync(libPath)) {
                    try { fs.unlinkSync(libPath); } catch (e) {}
                }
                if (!fs.existsSync(path.dirname(libPath))) {
                    fs.mkdirSync(path.dirname(libPath), { recursive: true });
                }

                await downloadFileWithMirror(url, libPath, null, 2, session._abortController ? session._abortController.signal : null);

                if (libPath.endsWith('.jar') && !isJarIntact(libPath)) {
                    failed++;
                    failedList.push(path.basename(libPath));
                    try { fs.unlinkSync(libPath); } catch (e) {}
                } else {
                    repaired++;
                }
            } catch (e) {
                failed++;
                failedList.push(path.basename(libPath));
                if (fs.existsSync(libPath) && !isJarIntact(libPath)) {
                    try { fs.unlinkSync(libPath); } catch (e2) {}
                }
            }
        }

        if (isAborted()) return;

        // Phase 6: Complete (95-100%)
        session.stage = 'complete';
        session.repairedFiles = repaired;
        session.progress = 100;

        if (failed > 0) {
            session.status = 'completed';
            session.message = `修复完成，成功 ${repaired} 个，失败 ${failed} 个`;
            session._failedList = failedList;
        } else {
            session.status = 'completed';
            session.message = `修复完成！共修复/验证 ${repaired} 个文件`;
        }
    } catch (e) {
        console.error('[Repair] Critical error:', e.stack || e.message || e);
        session.status = 'failed';
        session.stage = 'failed';
        session.message = '修复失败: ' + (e.message || '未知错误');
    }
}

function resolveLibraryPath(lib) {
    if (lib.downloads?.artifact?.path) {
        const rawPath = lib.downloads.artifact.path.replace(/\//g, path.sep);
        const resolved = path.resolve(LIBRARIES_DIR, rawPath);
        if (!resolved.startsWith(path.resolve(LIBRARIES_DIR) + path.sep) && resolved !== path.resolve(LIBRARIES_DIR)) {
            console.warn(`[Security] Blocked path traversal in library: ${lib.downloads.artifact.path}`);
            return null;
        }
        return resolved;
    }
    if (lib.name) {
        const p = lib.name.split(':');
        if (p.length >= 3) {
            const gp = p[0].replace(/\./g, path.sep);
            const cl = p.length >= 4 ? `-${p[3]}` : '';
            const jn = `${p[1]}-${p[2]}${cl}.jar`;
            return path.join(LIBRARIES_DIR, gp, p[1], p[2], jn);
        }
    }
    return null;
}

function loadExternalFolders() {
    try {
        if (fs.existsSync(EXTERNAL_FOLDERS_FILE)) {
            return JSON.parse(fs.readFileSync(EXTERNAL_FOLDERS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveExternalFolders(folders) {
    fs.writeFileSync(EXTERNAL_FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

function findVersionJson(versionDir) {
    if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) return null;
    const dirName = path.basename(versionDir);
    const primaryJson = path.join(versionDir, `${dirName}.json`);
    if (fs.existsSync(primaryJson)) return primaryJson;
    try {
        const jsonFiles = fs.readdirSync(versionDir).filter(f => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
            const fullPath = path.join(versionDir, jsonFile);
            try {
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                if (data.mainClass || data.libraries || data.inheritsFrom || data.minecraftArguments || data.arguments) return fullPath;
            } catch (e) { continue; }
        }
    } catch (e) {}
    const packInfoPath = path.join(versionDir, 'pack-info.json');
    if (fs.existsSync(packInfoPath)) {
        try {
            const packInfo = JSON.parse(fs.readFileSync(packInfoPath, 'utf-8'));
            if (packInfo.mcVersion || packInfo.name) {
                let inheritsFrom = packInfo.mcVersion;
                if (packInfo.forgeVersion) inheritsFrom = `${packInfo.mcVersion}-forge-${packInfo.forgeVersion}`;
                else if (packInfo.neoforgeVersion) inheritsFrom = `${packInfo.mcVersion}-neoforge-${packInfo.neoforgeVersion}`;
                else if (packInfo.fabricVersion) inheritsFrom = `fabric-loader-${packInfo.fabricVersion}-${packInfo.mcVersion}`;
                const versionJson = {
                    id: dirName,
                    inheritsFrom: inheritsFrom || undefined,
                    type: 'release',
                    mainClass: inheritsFrom ? undefined : 'net.minecraft.client.main.Main',
                    time: packInfo.importedAt || new Date().toISOString(),
                    releaseTime: packInfo.importedAt || new Date().toISOString()
                };
                const vjPath = path.join(versionDir, `${dirName}.json`);
                fs.writeFileSync(vjPath, JSON.stringify(versionJson, null, 2));
                console.log(`[findVersionJson] 从 pack-info.json 补建版本JSON: ${dirName}.json inheritsFrom=${inheritsFrom}`);
                return vjPath;
            }
        } catch (e) {}
    }
    return null;
}

function detectVersionInfo(data, dirName) {
    const versionIdLower = (data.id || dirName).toLowerCase();
    const mainClassLower = (data.mainClass || '').toLowerCase();
    const librariesStr = JSON.stringify(data.libraries || []).toLowerCase();
    const gameArgsStr = JSON.stringify(data.arguments?.game || []).toLowerCase();
    const isBootStrap = mainClassLower.includes('bootstraplauncher');
    const hasNeoForgeGameArg = gameArgsStr.includes('--fml.neoforgeversion');
    const hasForgeGameArg = gameArgsStr.includes('--fml.forgeversion');
    const isFabric = mainClassLower.includes('fabric') || versionIdLower.includes('fabric') ||
        librariesStr.includes('net.fabricmc:fabric-loader') || librariesStr.includes('org.quiltmc:quilt-loader');
    const isForge = (mainClassLower.includes('forge') || mainClassLower.includes('modlauncher') || versionIdLower.includes('forge') ||
        (isBootStrap && (hasForgeGameArg || librariesStr.includes('net.minecraftforge')))) &&
        !versionIdLower.includes('neoforge') && !librariesStr.includes('net.neoforge') && !hasNeoForgeGameArg;
    const isNeoForge = versionIdLower.includes('neoforge') || librariesStr.includes('net.neoforge') ||
        hasNeoForgeGameArg || (isBootStrap && librariesStr.includes('neoforged')) ||
        (isBootStrap && hasForgeGameArg && (librariesStr.includes('neoforge') || gameArgsStr.includes('neoforge')));
    const isOptiFine = versionIdLower.includes('optifine') || librariesStr.includes('optifine:optifine');
    const isLiteLoader = versionIdLower.includes('liteloader') || librariesStr.includes('liteloader');

    const bareMcPattern = /^\d+\.\d+(\.\d+)?$/;
    const loaderIdPattern = /^(?:fabric-loader-\d|quilt-loader-\d|\d+\.\d+(?:\.\d+)?-(?:forge|neoforge)-\d)/;
    const versionId = data.id || dirName;
    const isModpack = !bareMcPattern.test(versionId) && !loaderIdPattern.test(versionId);

    if (isModpack) {
        let loaderType = '';
        if (isForge) loaderType = 'Forge';
        else if (isFabric) loaderType = 'Fabric';
        else if (isNeoForge) loaderType = 'NeoForge';
        let resolvedIsForge = isForge, resolvedIsFabric = isFabric, resolvedIsNeoForge = isNeoForge;
        if (!loaderType && data.inheritsFrom) {
            const parentJsonPath = path.join(VERSIONS_DIR, data.inheritsFrom, `${data.inheritsFrom}.json`);
            if (fs.existsSync(parentJsonPath)) {
                try {
                    const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                    const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
                    if (parentInfo.isForge) { loaderType = 'Forge'; resolvedIsForge = true; }
                    else if (parentInfo.isFabric) { loaderType = 'Fabric'; resolvedIsFabric = true; }
                    else if (parentInfo.isNeoForge) { loaderType = 'NeoForge'; resolvedIsNeoForge = true; }
                } catch (_) {}
            }
        }
        let baseVersion = data.inheritsFrom || '';
        if (data.inheritsFrom) {
            const parentJsonPath = path.join(VERSIONS_DIR, data.inheritsFrom, `${data.inheritsFrom}.json`);
            if (fs.existsSync(parentJsonPath)) {
                try {
                    const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                    if (parentData.inheritsFrom && bareMcPattern.test(parentData.inheritsFrom)) {
                        baseVersion = parentData.inheritsFrom;
                    }
                } catch (_) {}
            }
        }
        if (!baseVersion) {
            const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?)/;
            if (isForge || isNeoForge) {
                const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
                if (forgeMatch) baseVersion = forgeMatch[1];
                else {
                    const fmlMatch = data.arguments?.game?.find(a => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
                    if (fmlMatch) {
                        const idx = data.arguments.game.indexOf(fmlMatch);
                        if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
                    }
                }
            } else if (isFabric) {
                const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
                if (fabricMatch) baseVersion = fabricMatch[1];
            }
            if (!baseVersion) {
                const idMatch = versionId.match(mcVersionPattern);
                if (idMatch) baseVersion = idMatch[1];
            }
        }
        return { isFabric: resolvedIsFabric, isForge: resolvedIsForge, isNeoForge: resolvedIsNeoForge, isOptiFine, isLiteLoader, isModpack, modpackLoader: loaderType, baseVersion };
    }

    if (data.inheritsFrom && !isFabric && !isForge && !isNeoForge && !isOptiFine && !isLiteLoader) {
        const parentJsonPath = path.join(VERSIONS_DIR, data.inheritsFrom, `${data.inheritsFrom}.json`);
        if (fs.existsSync(parentJsonPath)) {
            try {
                const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
                if (parentInfo.isForge || parentInfo.isFabric || parentInfo.isNeoForge || parentInfo.isOptiFine || parentInfo.isLiteLoader) {
                    return { ...parentInfo, baseVersion: parentInfo.baseVersion || data.inheritsFrom };
                }
            } catch (_) {}
        }
    }

    let baseVersion = data.inheritsFrom || data.id || dirName;
    if (!data.inheritsFrom) {
        const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?(?:[_-]pre\d*|[-_]rc\d*|[-_]snapshot[-_]?\d*w\d*a?)?)/i;
        if (isForge || isNeoForge) {
            const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
            if (forgeMatch) baseVersion = forgeMatch[1];
            else {
                const fmlMatch = data.arguments?.game?.find(a => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
                if (fmlMatch) {
                    const idx = data.arguments.game.indexOf(fmlMatch);
                    if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
                }
            }
        } else if (isFabric) {
            const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
            if (fabricMatch) baseVersion = fabricMatch[1];
        }
        if (baseVersion === data.id || baseVersion === dirName) {
            const idMatch = (data.id || dirName).match(mcVersionPattern);
            if (idMatch) baseVersion = idMatch[1];
        }
    }
    return { isFabric, isForge, isNeoForge, isOptiFine, isLiteLoader, isModpack: false, modpackLoader: '', baseVersion };
}

function scanExternalFolder(folderPath) {
    const versions = [];
    const versionsDir = path.join(folderPath, 'versions');
    if (!fs.existsSync(versionsDir)) return versions;
    const skipFolders = new Set(['cache', 'blclient', 'pcl', 'temp']);
    try {
        const dirs = fs.readdirSync(versionsDir);
        for (const dir of dirs) {
            const versionDir = path.join(versionsDir, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
                if (skipFolders.has(dir.toLowerCase())) continue;
                const hasAnyFile = fs.readdirSync(versionDir).some(f => !f.startsWith('.'));
                if (!hasAnyFile) continue;
            } catch (e) { continue; }
            const jsonFile = findVersionJson(versionDir);
            if (!jsonFile) continue;
            try {
                const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                const info = detectVersionInfo(data, dir);
                versions.push({
                    id: data.id || dir,
                    type: data.type || 'release',
                    releaseTime: data.releaseTime || '',
                    mainClass: data.mainClass || '',
                    installed: true,
                    inheritsFrom: data.inheritsFrom || null,
                    isFabric: info.isFabric,
                    isForge: info.isForge,
                    isNeoForge: info.isNeoForge,
                    isOptiFine: info.isOptiFine,
                    isLiteLoader: info.isLiteLoader,
                    isModpack: info.isModpack,
                    modpackLoader: info.modpackLoader,
                    baseVersion: info.baseVersion,
                    externalPath: folderPath,
                    externalVersionDir: versionDir,
                    isExternal: true
                });
            } catch (e) {
                versions.push({ id: dir, type: 'release', installed: true, externalPath: folderPath, externalVersionDir: versionDir, isExternal: true });
            }
        }
    } catch (e) {}
    return versions;
}

function loadVersionSettings(versionId) {
    const cleanId = versionId.replace(' [外部]', '');
    const isExternal = versionId.includes('[外部]');
    let settingsFile;
    if (isExternal) {
        const externalSettingsDir = path.join(DATA_DIR, 'external-settings');
        if (!fs.existsSync(externalSettingsDir)) fs.mkdirSync(externalSettingsDir, { recursive: true });
        settingsFile = path.join(externalSettingsDir, `${cleanId.replace(/[/\\?%*:|"<>]/g, '_')}-settings.json`);
    } else {
        if (cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
            return { versionId, customName: '', description: '', icon: 'auto', category: 'auto', favorite: false };
        }
        settingsFile = path.join(VERSIONS_DIR, cleanId, 'version-settings.json');
    }
    const defaults = {
        versionId: versionId,
        customName: '',
        description: '',
        icon: 'auto',
        category: 'auto',
        favorite: false,
        isolation: isExternal ? 'on' : 'global',
        windowTitle: '',
        customInfo: '',
        javaPath: 'global',
        memoryMode: 'global',
        memoryValue: 4096,
        memOptimize: 'global',
        jvmArgs: '',
        gameArgs: '',
        customMainClass: '',
        beforeLaunchCommand: '',
        afterLaunchCommand: '',
        fullscreen: 'global',
        resolution: ''
    };
    try {
        if (fs.existsSync(settingsFile)) {
            const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
            return { ...defaults, ...saved };
        }
    } catch (e) {}
    return defaults;
}

function saveVersionSettings(versionId, settings) {
    const cleanId = versionId.replace(' [外部]', '');
    const isExternal = versionId.includes('[外部]');
    let settingsFile;
    if (isExternal) {
        const externalSettingsDir = path.join(DATA_DIR, 'external-settings');
        if (!fs.existsSync(externalSettingsDir)) fs.mkdirSync(externalSettingsDir, { recursive: true });
        settingsFile = path.join(externalSettingsDir, `${cleanId.replace(/[/\\?%*:|"<>]/g, '_')}-settings.json`);
    } else {
        if (cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
            throw new Error('Invalid versionId');
        }
        const versionDir = path.join(VERSIONS_DIR, cleanId);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
        settingsFile = path.join(versionDir, 'version-settings.json');
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

const _apiCache = new Map();
function cachedFetchJSON(urlStr, cacheTTL, retriesOrHeaders, timeoutMs) {
    const cached = _apiCache.get(urlStr);
    if (cached && Date.now() - cached.ts < cacheTTL) return Promise.resolve(cached.data);
    return fetchJSON(urlStr, retriesOrHeaders, timeoutMs).then(data => {
        _apiCache.set(urlStr, { data, ts: Date.now() });
        if (_apiCache.size > 2000) {
            const now = Date.now();
            for (const [k, v] of _apiCache) {
                if (now - v.ts > cacheTTL * 2) _apiCache.delete(k);
            }
        }
        return data;
    });
}


function _fetchOnce(url, headers, timeout) {
    const mod = url.startsWith('https') ? https : http;
    const agent = url.startsWith('https') ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT;
    const reqHeaders = { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };
    return new Promise((resolve, reject) => {
        const req = mod.get(url, { headers: reqHeaders, agent, timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                req.destroy();
                return _fetchOnce(res.headers.location, headers, timeout).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { res.destroy(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            let stream = res;
            if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
            else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
            let data = '';
            stream.on('data', chunk => { data += chunk; });
            stream.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)); }
            });
            stream.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeout}ms)`)); });
        req.on('error', reject);
    });
}

const _mirrorHealth = { down: false, until: 0, fails: 0 };
function _isMirrorAvailable() {
    if (_mirrorHealth.down && Date.now() < _mirrorHealth.until) return false;
    if (_mirrorHealth.down && Date.now() >= _mirrorHealth.until) {
        _mirrorHealth.down = false;
        _mirrorHealth.fails = 0;
    }
    return true;
}
function _mirrorFailed() {
    _mirrorHealth.fails++;
    if (_mirrorHealth.fails >= 1) {
        _mirrorHealth.down = true;
        _mirrorHealth.until = Date.now() + 3 * 60 * 1000;
        console.warn(`[Mirror] 镜像连续失败${_mirrorHealth.fails}次，暂停使用3分钟`);
    }
}
function _mirrorSuccess() {
    _mirrorHealth.fails = 0;
    _mirrorHealth.down = false;
}

async function fetchJSON(urlStr, retriesOrHeaders = 3, timeoutMs) {
    let extraHeaders = {};
    if (typeof retriesOrHeaders === 'object' && retriesOrHeaders !== null) {
        extraHeaders = retriesOrHeaders;
    }
    const reqTimeout = typeof timeoutMs === 'number' ? timeoutMs : 15000;

    let mirrorUrl = null;
    if (urlStr.startsWith(MODRINTH_API)) {
        mirrorUrl = urlStr.replace(MODRINTH_API, MODRINTH_API_MIRROR);
    } else if (urlStr.startsWith(CURSEFORGE_API)) {
        mirrorUrl = urlStr.replace(CURSEFORGE_API, CURSEFORGE_API_MIRROR);
    }

    const headers = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive', ...extraHeaders };
    const useMirror = mirrorUrl && _isMirrorAvailable();
    const steps = useMirror
        ? [{ url: mirrorUrl, t: 3000, isMirror: true }, { url: urlStr, t: 5000 }, { url: mirrorUrl, t: 8000, isMirror: true }, { url: urlStr, t: Math.min(reqTimeout, 15000) }]
        : mirrorUrl
            ? [{ url: urlStr, t: Math.min(reqTimeout, 8000) }, { url: urlStr, t: reqTimeout }]
            : [{ url: urlStr, t: Math.min(reqTimeout, 10000) }, { url: urlStr, t: reqTimeout }];

    let lastErr = null;
    for (const step of steps) {
        try {
            const result = await _fetchOnce(step.url, headers, step.t);
            if (step.isMirror) _mirrorSuccess();
            return result;
        } catch (e) {
            lastErr = e;
            if (step.isMirror) _mirrorFailed();
            console.warn(`[fetchJSON] ${step.url.substring(0, 60)}... 超时${step.t}ms失败: ${e.message}`);
        }
    }
    throw lastErr || new Error('fetchJSON failed: ' + urlStr.substring(0, 80));
}

function fetchText(urlStr) {
    return new Promise((resolve, reject) => {
        const mod = urlStr.startsWith('https') ? https : http;
        const req = mod.get(urlStr, { headers: { 'User-Agent': 'VersePC/1.0' }, timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
    });
}

// ============================================================================
// PCL2风格多线程高速下载引擎 (Multi-Thread Chunk Download Engine)
// 参考PCL2 ModNet.vb：大文件Range Header分块 + 多连接并行下载 + 合并
// ============================================================================

const DownloadManager = {
    activeConnections: 0,
    connectionLimit: 512,
    speedHistory: [],
    totalBytesDownloaded: 0,
    lastBytesSnapshot: 0,
    lastSnapshotTime: 0,
    currentSpeed: 0,
    speedLimitBytes: 0,
    tokenBucket: 0,
    tokenBucketMax: 0,
    tokenBucketRefillRate: 0,
    lastTokenRefill: 0,
    downloadQueue: [],
    queueProcessing: false,
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    startTime: 0,

    acquireConnection() {
        // PCL2 style: no strict connection limit, just track
        this.activeConnections++;
        return true;
    },
    releaseConnection() {
        this.activeConnections = Math.max(0, this.activeConnections - 1);
    },
    recordProgress(bytes) {
        this.totalBytesDownloaded += bytes;
        if (this.speedLimitBytes > 0) {
            const now = Date.now();
            if (now - this.lastTokenRefill > 50) {
                const elapsed = now - this.lastTokenRefill;
                this.tokenBucket = Math.min(this.tokenBucketMax, this.tokenBucket + (this.tokenBucketRefillRate * elapsed / 1000));
                this.lastTokenRefill = now;
            }
            if (this.tokenBucket >= bytes) {
                this.tokenBucket -= bytes;
            }
        }
    },
    async waitForBandwidth(bytes) {
        if (this.speedLimitBytes <= 0) return;
        const maxWait = 30000;
        let waited = 0;
        while (waited < maxWait) {
            const now = Date.now();
            if (now - this.lastTokenRefill > 50) {
                const elapsed = now - this.lastTokenRefill;
                this.tokenBucket = Math.min(this.tokenBucketMax, this.tokenBucket + (this.tokenBucketRefillRate * elapsed / 1000));
                this.lastTokenRefill = now;
            }
            if (this.tokenBucket >= bytes) {
                this.tokenBucket -= bytes;
                return;
            }
            const deficit = bytes - this.tokenBucket;
            const waitMs = Math.min(Math.ceil(deficit / this.tokenBucketRefillRate * 1000), 200);
            await new Promise(r => setTimeout(r, waitMs));
            waited += waitMs;
        }
    },
    setSpeedLimit(mbps) {
        if (mbps <= 0) {
            this.speedLimitBytes = 0;
            this.tokenBucket = Infinity;
            this.tokenBucketMax = Infinity;
            this.tokenBucketRefillRate = Infinity;
        } else {
            this.speedLimitBytes = mbps * 1024 * 1024;
            this.tokenBucketMax = this.speedLimitBytes;
            this.tokenBucket = this.speedLimitBytes;
            this.tokenBucketRefillRate = this.speedLimitBytes;
            this.lastTokenRefill = Date.now();
        }
    },
    refreshSpeed() {
        const now = Date.now();
        if (this.lastSnapshotTime === 0) { this.lastSnapshotTime = now; this.lastBytesSnapshot = this.totalBytesDownloaded; return; }
        const delta = now - this.lastSnapshotTime;
        if (delta < 100) return;
        const instantSpeed = Math.max(0, (this.totalBytesDownloaded - this.lastBytesSnapshot) * 1000 / delta);
        this.speedHistory.unshift(instantSpeed);
        if (this.speedHistory.length > 30) this.speedHistory.pop();
        let wSum = 0, wSpeed = 0;
        for (let i = 0; i < this.speedHistory.length; i++) { const w = this.speedHistory.length - i; wSpeed += this.speedHistory[i] * w; wSum += w; }
        this.currentSpeed = wSum > 0 ? Math.round(wSpeed / wSum) : 0;
        this.lastSnapshotTime = now;
        this.lastBytesSnapshot = this.totalBytesDownloaded;
    },
    getSpeed() { return this.currentSpeed; },
    getStats() {
        const elapsed = this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0;
        return {
            activeConnections: this.activeConnections,
            connectionLimit: this.connectionLimit,
            currentSpeed: this.currentSpeed,
            totalBytesDownloaded: this.totalBytesDownloaded,
            totalFiles: this.totalFiles,
            completedFiles: this.completedFiles,
            failedFiles: this.failedFiles,
            skippedFiles: this.skippedFiles,
            elapsedSeconds: Math.round(elapsed),
            speedLimit: this.speedLimitBytes > 0 ? Math.round(this.speedLimitBytes / 1024 / 1024) : 0
        };
    },
    reset() {
        this.totalBytesDownloaded = 0;
        this.lastBytesSnapshot = 0;
        this.lastSnapshotTime = 0;
        this.speedHistory = [];
        this.currentSpeed = 0;
        this.totalFiles = 0;
        this.completedFiles = 0;
        this.failedFiles = 0;
        this.skippedFiles = 0;
        this.startTime = Date.now();
    }
};
setInterval(() => DownloadManager.refreshSpeed(), 100);

function httpGet(urlStr, opts = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = urlStr.startsWith('https');
        const mod = isHttps ? https : http;
        const agent = isHttps ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT;
        const headers = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive', ...opts.headers };
        if (opts.start !== undefined) {
            headers['Range'] = opts.end !== undefined ? `bytes=${opts.start}-${opts.end}` : `bytes=${opts.start}-`;
        }
        const req = mod.get(urlStr, { headers, agent }, (res) => {
            resolve({ stream: res, statusCode: res.statusCode, headers: res.headers,
                contentLength: parseInt(res.headers['content-length'] || '0', 10), request: req });
        });
        req.on('error', reject);
        req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

const NO_CHUNK_HOSTS = ['github.com', 'raw.githubusercontent.com', 'githubusercontent.com'];

async function downloadFileChunked(url, destPath, options = {}) {
    const { retries = 3, onProgress = null, sha1 = null, timeout = 120000, mirrors = null, abortSignal = null } = options;
    const minChunkSize = 512 * 1024;
    const CHUNK_THRESHOLD = 8 * 1024 * 1024;
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    const allUrls = mirrors ? [url, ...mirrors.filter(m => m !== url)] : getMirrorUrls(url);

    for (let ra = 0; ra <= retries; ra++) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
        for (let urlIdx = 0; urlIdx < allUrls.length; urlIdx++) {
            if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
            const currentUrl = allUrls[urlIdx];
            try {
                let fileSize = 0, supportsRange = false, workingUrl = currentUrl;
                const probeR = await httpGet(currentUrl, { start: 0, end: 0, timeout: 2000 });
                probeR.stream.destroy();
                if (probeR.statusCode === 206) {
                    supportsRange = true;
                    workingUrl = currentUrl;
                    const crMatch = (probeR.headers['content-range'] || '').match(/\/(\d+)/);
                    fileSize = crMatch ? parseInt(crMatch[1], 10) : probeR.contentLength;
                } else if (probeR.statusCode === 200) {
                    supportsRange = (probeR.headers['accept-ranges'] === 'bytes');
                    fileSize = probeR.contentLength;
                    workingUrl = currentUrl;
                }
                if (fileSize <= 0) {
                    for (let probeIdx = urlIdx + 1; probeIdx < allUrls.length; probeIdx++) {
                        try {
                            const r2 = await httpGet(allUrls[probeIdx], { start: 0, end: 0, timeout: 2000 });
                            r2.stream.destroy();
                            if (r2.statusCode === 206) {
                                supportsRange = true;
                                workingUrl = allUrls[probeIdx];
                                const crMatch = (r2.headers['content-range'] || '').match(/\/(\d+)/);
                                fileSize = crMatch ? parseInt(crMatch[1], 10) : r2.contentLength;
                            } else if (r2.statusCode === 200) {
                                supportsRange = (r2.headers['accept-ranges'] === 'bytes');
                                fileSize = r2.contentLength;
                                workingUrl = allUrls[probeIdx];
                            }
                            if (fileSize > 0) break;
                        } catch (e) { continue; }
                    }
                }
                const settings = loadSettingsCached();
                const useChunk = settings.enableChunkDownload && supportsRange && fileSize > CHUNK_THRESHOLD;
                if (!useChunk || fileSize <= 0) {
                    return await _dlSingle(workingUrl, destPath, { onProgress, sha1, timeout, abortSignal });
                }
                const maxC = Math.min(parseInt(settings.maxChunksPerFile, 10) || 16, 64);
                const cCount = Math.min(maxC, Math.ceil(fileSize / minChunkSize));
                const cSize = Math.ceil(fileSize / cCount);
                const chunks = [];
                for (let i = 0; i < cCount; i++) {
                    chunks.push({ i, s: i * cSize, e: Math.min((i + 1) * cSize - 1, fileSize - 1), tmp: `${destPath}.c${i}` });
                }
                const cProg = new Array(cCount).fill(0);
                let lastProgUpdate = Date.now();
                const dlChunk = async (c) => {
                    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
                    while (!DownloadManager.acquireConnection()) {
                        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
                        await new Promise(r => setTimeout(r, 50));
                    }
                    try {
                        const cr = await httpGet(workingUrl, { start: c.s, end: c.e, timeout });
                        if (abortSignal && abortSignal.aborted) {
                            cr.stream.destroy();
                            throw new Error('下载已中止');
                        }
                        if (cr.statusCode !== 200 && cr.statusCode !== 206) throw new Error(`Chunk ${c.i}: HTTP ${cr.statusCode}`);
                        const ws = fs.createWriteStream(c.tmp);
                        let dl = 0;
                        let aborted = false;
                        let stallTimer = null;
                        const resetStall = () => {
                            if (stallTimer) clearTimeout(stallTimer);
                            stallTimer = setTimeout(() => {
                                if (!aborted) {
                                    console.warn(`[Java] Chunk ${c.i} stall timeout (30s), aborting...`);
                                    try { cr.stream.destroy(); } catch (_) {}
                                    try { ws.destroy(); } catch (_) {}
                                }
                            }, 30000);
                        };
                        resetStall();
                        const onAbort = () => {
                            aborted = true;
                            if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                            if (cr.stream) cr.stream.destroy();
                            if (ws) ws.destroy();
                        };
                        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
                        return new Promise((resolve, reject) => {
                            cr.stream.on('data', (d) => {
                                dl += d.length;
                                DownloadManager.recordProgress(d.length);
                                cProg[c.i] = dl;
                                resetStall();
                                if (onProgress && Date.now() - lastProgUpdate > 50) {
                                    lastProgUpdate = Date.now();
                                    const t = cProg.reduce((a, b) => a + b, 0);
                                    onProgress({ bytesDownloaded: t, totalBytes: fileSize, speed: DownloadManager.getSpeed(),
                                        progress: Math.min(99.9, (t / fileSize) * 100), chunks: cCount, activeChunks: DownloadManager.activeConnections });
                                }
                            });
                            cr.stream.pipe(ws);
                            ws.on('finish', () => {
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                ws.close();
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                if (aborted) return;
                                resolve();
                            });
                            ws.on('error', (err) => {
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                reject(err);
                            });
                            cr.stream.on('error', (err) => {
                                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                                reject(err);
                            });
                        }).then(() => {
                            if (onProgress) {
                                const t = cProg.reduce((a, b) => a + b, 0);
                                onProgress({ bytesDownloaded: t, totalBytes: fileSize, speed: DownloadManager.getSpeed(),
                                    progress: Math.min(99.9, (t / fileSize) * 100), chunks: cCount, activeChunks: DownloadManager.activeConnections });
                            }
                        });
                    } finally { DownloadManager.releaseConnection(); }
                };
                try {
                await Promise.all(chunks.map(c => dlChunk(c)));
                await new Promise((resolve, reject) => {
                    const ws = fs.createWriteStream(destPath);
                    let idx = 0;
                    const writeNext = () => {
                        if (idx >= chunks.length) { ws.end(); return; }
                        const rs = fs.createReadStream(chunks[idx].tmp);
                        rs.on('end', () => { idx++; writeNext(); });
                        rs.on('error', reject);
                        rs.pipe(ws, { end: false });
                    };
                    ws.on('finish', resolve);
                    ws.on('error', reject);
                    writeNext();
                });
                for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (e) {} }
            } catch (e) {
                for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (e) {} }
                throw e;
            }
                if (sha1) {
                    const actual = await calculateSHA1(destPath);
                    if (actual !== sha1) {
                        console.warn(`[MultiThread] SHA1 mismatch on ${allUrls[urlIdx]}: ${path.basename(destPath)}`);
                        await fs.promises.unlink(destPath).catch(() => {});
                        if (urlIdx < allUrls.length - 1) {
                            console.log(`[MultiThread] Switching mirror: ${allUrls[urlIdx]} -> ${allUrls[urlIdx + 1]}`);
                            continue;
                        }
                        if (ra < retries) continue;
                        return { size: fileSize, path: destPath, sha1Match: false, chunks: cCount };
                    }
                }
                if (onProgress) onProgress({ bytesDownloaded: fileSize, totalBytes: fileSize, speed: 0, progress: 100 });
                console.log(`[MultiThread] Done: ${path.basename(destPath)} (${cCount}x, ${formatSize(fileSize)}) from ${workingUrl}`);
                return { size: fileSize, path: destPath, sha1Match: sha1 ? true : undefined, chunks: cCount };
            } catch (err) {
                console.warn(`[MultiThread] URL ${currentUrl} failed: ${err.message}`);
                if (urlIdx < allUrls.length - 1) {
                    console.log(`[MultiThread] Switching mirror: ${currentUrl} -> ${allUrls[urlIdx + 1]}`);
                    continue;
                }
                if (ra < retries) {
                    console.warn(`[MultiThread] Retry ${ra + 1}/${retries}`);
                    for (let i = 0; i < 16; i++) { try { fs.unlinkSync(`${destPath}.c${i}`); } catch (e) {} }
                    try { fs.unlinkSync(destPath); } catch (e) {}
                    await new Promise(r => setTimeout(r, Math.min(1000 * (ra + 1), 5000) + Math.floor(Math.random() * 500)));
                } else throw err;
            }
        }
    }
}

async function _dlSingle(urlStr, destPath, options = {}) {
    const { onProgress = null, sha1 = null, timeout = 60000, retries = 3, abortSignal = null, stallTimeout = 30000 } = options;
    const isHttps = urlStr.startsWith('https');
    const agent = isHttps ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT;
    while (!DownloadManager.acquireConnection()) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        await new Promise(r => setTimeout(r, 50));
    }
    let settled = false;
    try {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        return await new Promise((resolve, reject) => {
            const doReject = (e) => { if (!settled) { settled = true; reject(e); } };
            const doResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
            let currentAbortHandler = null;
            const removeAbortListener = () => {
                if (currentAbortHandler && abortSignal) {
                    try { abortSignal.removeEventListener('abort', currentAbortHandler); } catch (_) {}
                    currentAbortHandler = null;
                }
            };
            const attempt = (rc) => {
                if (settled) return;
                if (abortSignal && abortSignal.aborted) { doReject(new Error('下载已中止')); return; }
                removeAbortListener();
                const mod = urlStr.startsWith('https') ? https : http;
                ensureDir(destPath);
                const reqHeaders = { 'User-Agent': 'VersePC/2.0 (PCL2)', 'Connection': 'keep-alive' };
                let ws = null;
                let cleaned = false;
                let stallTimer = null;
                const clean = () => {
                    if (cleaned) return; cleaned = true;
                    try { if (ws) ws.destroy(); } catch (_) {}
                    fs.promises.unlink(destPath).catch(() => {});
                    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                };
                const resetStall = () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        if (!settled && !cleaned) {
                            try { req.destroy(); } catch (_) {}
                            clean();
                            if (rc > 0) {
                                setTimeout(() => attempt(rc - 1), 1000);
                            } else {
                                doReject(new Error(`Stall timeout: ${urlStr}`));
                            }
                        }
                    }, stallTimeout);
                };
                currentAbortHandler = () => {
                    try { req.destroy(); } catch (_) {}
                    clean();
                    doReject(new Error('下载已中止'));
                };
                if (abortSignal) {
                    if (abortSignal.aborted) { currentAbortHandler(); return; }
                    abortSignal.addEventListener('abort', currentAbortHandler, { once: true });
                }
                resetStall();
                const req = mod.get(urlStr, { headers: reqHeaders, agent }, (res) => {
                    if (settled) { res.destroy(); return; }
                    if (abortSignal && abortSignal.aborted) { res.destroy(); clean(); doReject(new Error('下载已中止')); return; }
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        clean();
                        const nu = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, urlStr).toString();
                        return _dlSingle(nu, destPath, { onProgress, sha1, timeout, retries: rc, abortSignal, stallTimeout }).then(doResolve).catch(doReject);
                    }
                    if (res.statusCode !== 200) { clean(); doReject(new Error(`HTTP ${res.statusCode} for ${urlStr}`)); return; }
                    const tSz = parseInt(res.headers['content-length'] || '0', 10);
                    let dl = 0;
                    ws = fs.createWriteStream(destPath);
                    res.on('data', (ch) => {
                        if (settled) { res.destroy(); return; }
                        dl += ch.length; DownloadManager.recordProgress(ch.length);
                        resetStall();
                        if (onProgress) onProgress({ bytesDownloaded: dl, totalBytes: tSz, speed: DownloadManager.getSpeed(), progress: tSz > 0 ? (dl / tSz * 100) : 0, downloaded: dl });
                    });
                    res.pipe(ws);
                    ws.on('finish', async () => {
                        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                        ws.close();
                        if (settled) return;
                        if (sha1) { const a = await calculateSHA1(destPath); if (a !== sha1) { clean(); if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); } else { doReject(new Error(`SHA1 mismatch: ${path.basename(destPath)}`)); } return; } }
                        doResolve({ size: dl, path: destPath });
                    });
                    ws.on('error', (e) => {
                        clean();
                        if (settled) return;
                        if (rc > 0) { setTimeout(() => attempt(rc - 1), 1000 + Math.random() * 500); }
                        else { doReject(e); }
                    });
                });
                req.on('error', (e) => {
                    clean();
                    if (settled) return;
                    if (rc > 0) { setTimeout(() => attempt(rc - 1), Math.min(2000 + (retries - rc) * 1000, 8000)); }
                    else { doReject(e); }
                });
                req.setTimeout(timeout, () => {
                    req.destroy(); clean();
                    if (settled) return;
                    if (rc > 0) { setTimeout(() => attempt(rc - 1), 2000); }
                    else { doReject(new Error(`Timeout: ${urlStr}`)); }
                });
            };
            attempt(retries);
        });
    } finally { DownloadManager.releaseConnection(); }
}

function downloadFile(urlStr, destPath, onProgress, retries = 3, abortSignal = null) {
    if (NO_CHUNK_HOSTS.some(d => urlStr.includes(d))) return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal });
    return downloadFileChunked(urlStr, destPath, { onProgress, retries, abortSignal }).catch(err => {
        if (abortSignal && abortSignal.aborted) throw err;
        console.log(`[MultiThread] Chunked failed, fallback single: ${err.message}`);
        return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isJarIntact(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const fd = fs.openSync(filePath, 'r');
        const hdr = Buffer.alloc(4);
        fs.readSync(fd, hdr, 0, 4, 0);
        const tail = Buffer.alloc(4);
        const stat = fs.fstatSync(fd);
        if (stat.size < 22) { fs.closeSync(fd); return false; }
        fs.readSync(fd, tail, 0, 4, stat.size - 22);
        fs.closeSync(fd);
        if (hdr[0] !== 0x50 || hdr[1] !== 0x4B || hdr[2] !== 0x03 || hdr[3] !== 0x04) return false;
        const eocdBase = tail.readUInt32LE(0);
        if (eocdBase === 0x06054B50) return true;
        const buf = Buffer.alloc(Math.min(65557, stat.size));
        const searchStart = Math.max(0, stat.size - buf.length);
        const fd2 = fs.openSync(filePath, 'r');
        fs.readSync(fd2, buf, 0, buf.length, searchStart);
        fs.closeSync(fd2);
        for (let i = buf.length - 22; i >= 0; i--) {
            if (buf.readUInt32LE(i) === 0x06054B50) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function downloadFileSync(urlStr, destPath) {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        execSync(`curl --silent --location --output "${destPath}" "${urlStr}"`, { timeout: 30000, windowsHide: true, stdio: 'ignore' });
    } catch (e) {
        if (process.platform === 'win32') {
            execSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                `try { Invoke-WebRequest -Uri '${urlStr.replace(/'/g, "''")}' -OutFile '${destPath.replace(/'/g, "''")}' -UseBasicParsing } catch { exit 1 }`],
                { timeout: 30000, windowsHide: true, stdio: 'ignore' });
        } else {
            throw new Error('curl failed and no fallback available: ' + e.message);
        }
    }
}

function downloadFileToBuffer(urlStr, onProgress, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const protocol = urlStr.startsWith('https') ? require('https') : require('http');
        const req = protocol.get(urlStr, { timeout: timeoutMs }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const redirectUrl = response.headers.location;
                const redirectProtocol = redirectUrl.startsWith('https') ? require('https') : require('http');
                redirectProtocol.get(redirectUrl, { timeout: timeoutMs }, (redirectRes) => {
                    if (redirectRes.statusCode !== 200) {
                        redirectRes.resume();
                        reject(new Error(`HTTP ${redirectRes.statusCode}`));
                        return;
                    }
                    const total = parseInt(redirectRes.headers['content-length']) || 0;
                    const chunks = [];
                    let received = 0;
                    redirectRes.on('data', (chunk) => {
                        chunks.push(chunk);
                        received += chunk.length;
                        if (total > 0 && onProgress) onProgress(received / total);
                    });
                    redirectRes.on('end', () => resolve(Buffer.concat(chunks)));
                    redirectRes.on('error', reject);
                }).on('timeout', function () { this.destroy(); reject(new Error('redirect timeout')); })
                  .on('error', reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const total = parseInt(response.headers['content-length']) || 0;
            const chunks = [];
            let received = 0;
            response.on('data', (chunk) => {
                chunks.push(chunk);
                received += chunk.length;
                if (total > 0 && onProgress) onProgress(received / total);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
        req.on('error', reject);
    });
}

function getMirrorUrls(originalUrl) {
    if (!originalUrl) return [originalUrl];
    const urls = [];
    let hasBmclapi = false;
    for (const [original, mirror] of Object.entries(BMCLAPI_MIRROR)) {
        if (originalUrl.startsWith(original)) {
            const mirrored = originalUrl.replace(original, mirror);
            if (mirrored !== originalUrl) {
                urls.push(mirrored);
                hasBmclapi = true;
            }
            break;
        }
    }
    for (const [original, mirror] of Object.entries(MCIM_MIRROR)) {
        if (originalUrl.startsWith(original)) {
            const mirrored = originalUrl.replace(original, mirror);
            if (mirrored !== originalUrl && !urls.includes(mirrored)) urls.push(mirrored);
            break;
        }
    }
    if (originalUrl.startsWith('https://libraries.minecraft.net/')) {
        const forgeMirror = originalUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
        if (!urls.includes(forgeMirror)) urls.push(forgeMirror);
    }
    urls.push(originalUrl);
    return urls;
}

function getMirrorUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    const urls = getMirrorUrls(originalUrl);
    return urls.length > 1 ? urls[1] : originalUrl;
}

async function downloadFileWithMirror(urlStr, destPath, onProgress, retries = 3, abortSignal = null) {
    const allUrls = getMirrorUrls(urlStr);

    try {
        const stat = await fs.promises.stat(destPath);
        if (stat.size > 0) {
            const isJarFile = destPath.endsWith('.jar');
            if (isJarFile && !isJarIntact(destPath)) {
                console.log(`[Mirror] 已存在JAR损坏 (${path.basename(destPath)}), 重新下载`);
                await fs.promises.unlink(destPath).catch(() => {});
            } else {
                return { size: stat.size, path: destPath, skipped: true };
            }
        }
    } catch (e) {}

    const isSmallAsset = (destPath.includes('/assets/') || destPath.includes('\\assets\\')) && !destPath.endsWith('.jar');
    if (isSmallAsset) {
        return _dlSingle(urlStr, destPath, { onProgress, retries, abortSignal, timeout: 30000, stallTimeout: 15000 });
    }

    if (!NO_CHUNK_HOSTS.some(d => urlStr.includes(d))) {
        try {
            const result = await downloadFileChunked(urlStr, destPath, { onProgress, retries, mirrors: allUrls, abortSignal });
            if (destPath.endsWith('.jar') && !isJarIntact(destPath)) {
                console.log(`[Mirror] Chunked下载后JAR损坏 (${path.basename(destPath)}), 回退顺序下载`);
                await fs.promises.unlink(destPath).catch(() => {});
                throw new Error('Chunked download produced invalid JAR');
            }
            return result;
        } catch (e) {
            if (abortSignal && abortSignal.aborted) throw e;
            console.log(`[Mirror] Chunked with mirrors failed, fallback sequential: ${e.message}`);
        }
    }

    let lastError = null;
    for (const tryUrl of allUrls) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
        try {
            const result = await downloadFile(tryUrl, destPath, onProgress, retries, abortSignal);
            if (destPath.endsWith('.jar') && !isJarIntact(destPath)) {
                console.log(`[Mirror] 顺序下载后JAR损坏 (${path.basename(destPath)}), 尝试下一镜像`);
                await fs.promises.unlink(destPath).catch(() => {});
                lastError = new Error(`Downloaded JAR is corrupt: ${tryUrl}`);
                continue;
            }
            return result;
        } catch (e) {
            if (abortSignal && abortSignal.aborted) throw e;
            lastError = e;
            if (allUrls.indexOf(tryUrl) < allUrls.length - 1) {
                console.log(`  Mirror fallback: ${tryUrl} failed, trying next...`);
            }
        }
    }
    throw lastError;
}

const launchSessions = new Map();

function getRequiredJavaVersion(versionId, versionJson = null) {
    if (!versionId) return 8;
    
    if (versionJson && versionJson.javaVersion && versionJson.javaVersion.majorVersion) {
        const majorVer = parseInt(versionJson.javaVersion.majorVersion, 10);
        if (majorVer > 0) return majorVer;
    }
    
    if (versionJson && versionJson.complianceLevel !== undefined) {
        const level = parseInt(versionJson.complianceLevel, 10);
        if (level === 0) return 8;
        if (level >= 1 && level <= 6) return 8;
        if (level === 7) return 17;
        if (level >= 8) return 21;
    }

    const baseVer = versionId.split('-')[0].split('_')[0];
    const parts = baseVer.split('.').map(Number);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    const patch = parts[2] || 0;
    if (major > 1 || (major === 1 && minor > 20) || (major === 1 && minor === 20 && patch >= 5)) return 21;
    if (major === 1 && minor >= 17) return 16;
    const loaderPart = versionId.split('-').slice(1).join('-').toLowerCase();
    if (loaderPart.includes('forge') && major === 1 && minor >= 16) return 11;
    return 8;
}

function getJavaMajorVersion(javaPath) {
    try {
        const output = execSync(`"${javaPath}" -version`, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
        const match = (output || '').match(/version "(\d+)/);
        if (match) {
            const ver = parseInt(match[1], 10);
            return ver === 1 ? 8 : ver;
        }
    } catch (e) {
        const errOutput = (e.stderr || e.stdout || '').toString();
        const match = errOutput.match(/version "(\d+)/);
        if (match) {
            const ver = parseInt(match[1], 10);
            return ver === 1 ? 8 : ver;
        }
    }
    return 8;
}

function createClasspathWrapperJar(classpathStr, wrapperJarPath, mainClass) {
    const separator = process.platform === 'win32' ? ';' : ':';
    const entries = classpathStr.split(separator).filter(e => e.trim());
    const classPathLine = entries.map(e => {
        let p = e.replace(/\\/g, '/');
        p = p.replace(/ /g, '%20');
        return p;
    }).join(' ');

    function wrapManifestLine(line) {
        if (line.length <= 70) return line;
        let result = line.substring(0, 70);
        line = line.substring(70);
        while (line.length > 0) {
            const chunkSize = Math.min(69, line.length);
            result += '\r\n ' + line.substring(0, chunkSize);
            line = line.substring(chunkSize);
        }
        return result;
    }

    const classPathWrapped = wrapManifestLine(classPathLine);
    const manifest = `Manifest-Version: 1.0\r\nClass-Path: ${classPathWrapped}\r\nMain-Class: ${mainClass}\r\n`;

    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifest, 'utf-8'));
    zip.writeZip(wrapperJarPath);

    console.log(`[Launch] Created wrapper JAR: ${wrapperJarPath}`);
    console.log(`[Launch] Wrapper: ${entries.length} classpath entries, mainClass=${mainClass}`);
    
    if (entries.length <= 20) {
        entries.forEach((e, i) => {
            const exists = fs.existsSync(e);
            console.log(`[Launch]   CP[${i}] ${exists ? 'OK' : 'MISS'} ${path.basename(e)}`);
        });
    } else {
        const missing = entries.filter(e => !fs.existsSync(e));
        console.log(`[Launch]   存在: ${entries.length - missing.length}, 缺失: ${missing.length}`);
        if (missing.length > 0) {
            missing.slice(0, 5).forEach(m => console.log(`[Launch]   MISSING: ${path.basename(m)}`));
        }
    }
}

function selectJavaForVersion(versionId, settings, versionJson = null) {
    const systemJava = detectSystemJava();
    const bundledJava = detectBundledJava();
    
    if (!versionJson) {
        versionJson = resolveVersionJson(versionId);
    }
    const requiredVersion = getRequiredJavaVersion(versionId, versionJson);
    console.log(`[Java] 版本 ${versionId} 需要Java ${requiredVersion}+`);
    console.log(`[Java] 检测到 bundled Java: ${bundledJava.length}个, system Java: ${systemJava.length}个`);
    
    let candidates = [...bundledJava, ...systemJava];
    console.log(`[Java] 合并后候选Java总数: ${candidates.length}`);
    candidates.forEach((j, i) => {
        console.log(`  ${i+1}. ${j.path} - 主版本: ${j.majorVersion}, 64位: ${j.is64Bit}, 来源: ${j.source}`);
    });
    
    let userJavaInfo = null;
    if (settings.javaPath && fs.existsSync(settings.javaPath)) {
        const setMajorVer = getJavaMajorVersion(settings.javaPath);
        console.log(`[Java] 用户设置的Java路径: ${settings.javaPath}, 主版本: ${setMajorVer}`);
        userJavaInfo = {
            path: settings.javaPath,
            majorVersion: setMajorVer,
            is64Bit: true,
            isJdk: true,
            source: 'user_setting'
        };
    }
    
    if (userJavaInfo && userJavaInfo.majorVersion >= requiredVersion) {
        candidates.push(userJavaInfo);
    } else if (userJavaInfo && userJavaInfo.majorVersion < requiredVersion) {
        console.warn(`[Java] ⚠️ 用户设置的Java版本(${userJavaInfo.majorVersion})低于要求(${requiredVersion}+)，将自动选择其他Java`);
    }
    
    const suitable = candidates.filter(j => j.majorVersion >= requiredVersion);
    console.log(`[Java] 满足要求的Java (${suitable.length}个):`);
    suitable.forEach((j, i) => {
        console.log(`  ${i+1}. ${j.path} - 主版本: ${j.majorVersion}, 来源: ${j.source}`);
    });
    
    if (suitable.length === 0) {
        console.log('[Java] 未找到满足要求的Java');
        if (userJavaInfo) {
            console.log(`[Java] 用户设置的Java(${userJavaInfo.majorVersion})不满足要求(${requiredVersion}+)`);
        }
        return null;
    }
    
    suitable.sort((a, b) => {
        const aDist = Math.abs(a.majorVersion - requiredVersion) - (a.source === 'user_setting' ? 1 : 0);
        const bDist = Math.abs(b.majorVersion - requiredVersion) - (b.source === 'user_setting' ? 1 : 0);
        if (aDist !== bDist) return aDist - bDist;
        
        const aInLauncher = (a.path || '').toLowerCase().includes(DATA_DIR.toLowerCase()) ? 0 : 1;
        const bInLauncher = (b.path || '').toLowerCase().includes(DATA_DIR.toLowerCase()) ? 0 : 1;
        if (aInLauncher !== bInLauncher) return aInLauncher - bInLauncher;
        
        if (a.is64Bit !== b.is64Bit) return a.is64Bit ? -1 : 1;
        if (a.source === 'user_setting' && b.source !== 'user_setting') return -1;
        if (b.source === 'user_setting' && a.source !== 'user_setting') return 1;
        if (a.isJdk !== b.isJdk) return a.isJdk ? 1 : -1;
        return a.majorVersion - b.majorVersion;
    });
    
    const chosen = suitable[0];
    console.log(`[Java] 选择Java: ${chosen.path} (主版本: ${chosen.majorVersion}, 来源: ${chosen.source})`);
    
    if (userJavaInfo && chosen.path !== userJavaInfo.path) {
        console.log(`[Java] 注意: 自动选择了更匹配的Java ${chosen.majorVersion}，而非用户设置的Java ${userJavaInfo.majorVersion}`);
    }
    
    return chosen.path;
}

async function checkDependencies(versionId, settings, externalVersionDir = null) {
    console.log(`[DepCheck] 开始检查版本 ${versionId} 的依赖`);
    
    const result = {
        java: { ok: false, path: '', version: '', required: 8, message: '' },
        versionJson: { ok: false, message: '' },
        mainJar: { ok: false, message: '' },
        libraries: { ok: true, missing: [], total: 0, message: '' },
        natives: { ok: true, missing: [], total: 0, message: '' },
        assets: { ok: true, missing: [], total: 0, message: '' },
        parentVersion: { ok: true, message: '' },
        forgeCore: { ok: true, missing: [], message: '' },
        ready: false,
        missingFiles: []
    };

    const versionJson = resolveVersionJson(versionId, externalVersionDir);
    if (!versionJson) {
        result.versionJson.ok = false;
        result.versionJson.message = `版本 ${versionId} 的JSON文件缺失或损坏`;
        return result;
    }
    result.versionJson.ok = true;
    
    if (versionJson.javaVersion) {
        console.log(`[DepCheck] version.json中的javaVersion字段:`, JSON.stringify(versionJson.javaVersion));
    }

    const requiredJavaVer = getRequiredJavaVersion(versionId, versionJson);
    result.java.required = requiredJavaVer;
    console.log(`[DepCheck] 需要的Java版本: ${requiredJavaVer}`);

    const javaPath = selectJavaForVersion(versionId, settings, versionJson);
    console.log(`[DepCheck] 选择的Java路径: ${javaPath}`);
    
    if (!javaPath) {
        result.java.ok = false;
        result.java.message = `未找到Java ${requiredJavaVer}+，请安装Java或配置Java路径`;
        console.log(`[DepCheck] 未找到Java，消息: ${result.java.message}`);
    } else {
        result.java.path = javaPath;
        try {
            const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
            const verMatch = verOutput.match(/version "([^"]+)"/) || verOutput.match(/version (\S+)/);
            result.java.version = verMatch ? verMatch[1] : 'unknown';
            const majorStr = result.java.version.startsWith('1.')
                ? result.java.version.split('.')[1]
                : result.java.version.split('.')[0];
            const majorVer = parseInt(majorStr, 10);
            console.log(`[DepCheck] 检测到的Java版本: ${result.java.version}, 主版本: ${majorVer}`);
            
            if (majorVer >= requiredJavaVer) {
                result.java.ok = true;
                result.java.message = `Java ${result.java.version} (满足要求 ${requiredJavaVer}+)`;
                console.log(`[DepCheck] Java满足要求`);
            } else {
                result.java.ok = false;
                result.java.message = `Java ${result.java.version} 不满足要求(需要 ${requiredJavaVer}+)，请在版本设置中更换Java或使用文件修复功能自动安装`;
                result.java.warning = true;
                console.log(`[DepCheck] Java不满足要求`);
            }
        } catch (e) {
            result.java.ok = false;
            result.java.message = '无法检测Java版本';
            console.error(`[DepCheck] 检测Java版本失败:`, e.message);
        }
    }

    if (versionJson.inheritsFrom) {
        const jarName = versionJson.jar || versionJson.inheritsFrom;
        let parentJsonFound = false;
        let parentJsonPath = null;

        const jsonSearchPaths = [];
        if (externalVersionDir) {
            const externalRoot = findExternalRoot(externalVersionDir);
            if (externalRoot) {
                jsonSearchPaths.push(path.join(externalRoot, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
            }
            jsonSearchPaths.push(path.join(path.dirname(externalVersionDir), versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));
        }
        jsonSearchPaths.push(path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`));

        for (const candidate of jsonSearchPaths) {
            if (fs.existsSync(candidate)) {
                parentJsonPath = candidate;
                parentJsonFound = true;
                break;
            }
        }

        const parentJarPath = findMainJar(versionJson, versionId, externalVersionDir);
        const parentJarFound = !!parentJarPath && fs.existsSync(parentJarPath);

        if (!parentJsonFound || !parentJarFound) {
            result.parentVersion.ok = false;
            result.parentVersion.message = `缺少基础版本 ${versionJson.inheritsFrom}，请先安装`;
            result.missingFiles.push({
                type: 'parent_version',
                id: versionJson.inheritsFrom,
                message: `缺少基础版本 ${versionJson.inheritsFrom} (JSON: ${parentJsonFound ? '有' : '无'}, JAR: ${parentJarFound ? '有' : '无'})`
            });
        }
    }

    const mainJarPath = findMainJar(versionJson, versionId, externalVersionDir);
    if (mainJarPath && fs.existsSync(mainJarPath)) {
        if (versionJson.downloads?.client?.sha1) {
            try {
                const sha1 = await calculateSHA1(mainJarPath);
                if (sha1 === versionJson.downloads.client.sha1) {
                    result.mainJar.ok = true;
                } else {
                    result.mainJar.ok = false;
                    result.mainJar.message = '主JAR文件SHA1校验失败';
                    result.missingFiles.push({
                        type: 'main_jar',
                        url: versionJson.downloads.client.url,
                        path: mainJarPath,
                        sha1: versionJson.downloads.client.sha1,
                        size: versionJson.downloads.client.size,
                        name: `${versionId}.jar`
                    });
                }
            } catch (e) {
                result.mainJar.ok = true;
            }
        } else {
            result.mainJar.ok = true;
        }
    } else if (versionJson.downloads?.client) {
        result.mainJar.ok = false;
        result.mainJar.message = '主JAR文件缺失';
        result.missingFiles.push({
            type: 'main_jar',
            url: versionJson.downloads.client.url,
            path: mainJarPath || path.join(VERSIONS_DIR, versionId, `${versionId}.jar`),
            sha1: versionJson.downloads.client.sha1,
            size: versionJson.downloads.client.size,
            name: `${versionId}.jar`
        });
    } else {
        result.mainJar.ok = false;
        result.mainJar.message = '主JAR文件缺失';
    }

    const libraries = versionJson.libraries || [];
    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';
    let libTotal = 0;
    for (const lib of libraries) {
        if (lib.rules && !evaluateRules(lib.rules)) continue;

        const hasNatives = lib.natives && lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
        const libNameSuffix = lib.name ? lib.name.split(':').pop() : '';
        const isNewFormatNative = !hasNatives && libNameSuffix.startsWith('natives-');

        if (isNewFormatNative) {
            const nameParts = lib.name.split(':');
            const nativeSuffix = nameParts[nameParts.length - 1];
            const platformNative = nativeSuffix.replace('natives-', '');
            let isValidPlatform = false;
            if (process.arch === 'x64') {
                isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
            } else if (process.arch === 'ia32') {
                isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
            } else if (process.arch === 'arm64') {
                isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
            }
            if (!isValidPlatform) continue;

            libTotal++;
            let nativePath = null;
            if (lib.downloads?.artifact?.path) {
                nativePath = safeLibPath(lib.downloads.artifact.path);
                if (!nativePath) continue;
                if (!fs.existsSync(nativePath) && externalVersionDir) {
                    const externalRoot = findExternalRoot(externalVersionDir);
                    if (externalRoot) {
                        const extPath = safeLibPath(lib.downloads.artifact.path, path.join(externalRoot, 'libraries'));
                        if (fs.existsSync(extPath)) nativePath = extPath;
                    }
                }
            }
            if (!nativePath || !fs.existsSync(nativePath)) {
                if (nameParts.length >= 4) {
                    const ngroupPath = nameParts[0].replace(/\./g, path.sep);
                    const nname = nameParts[1];
                    const nver = nameParts[2];
                    const nclassifier = nameParts[3];
                    const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                    nativePath = path.join(LIBRARIES_DIR, ngroupPath, nname, nver, njarName);
                    if (!fs.existsSync(nativePath) && externalVersionDir) {
                        const externalRoot = findExternalRoot(externalVersionDir);
                        if (externalRoot) {
                            const extPath = path.join(externalRoot, 'libraries', ngroupPath, nname, nver, njarName);
                            if (fs.existsSync(extPath)) nativePath = extPath;
                        }
                    }
                }
            }
            if (!nativePath || !fs.existsSync(nativePath)) {
                const ngroupMaven = nameParts[0].replace(/\./g, '/');
                const nname = nameParts[1];
                const nver = nameParts[2];
                const nclassifier = nameParts[3];
                const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                const baseUrl = lib.url || (lib.downloads?.artifact?.url ? lib.downloads.artifact.url.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\.jar$/, '/') : 'https://libraries.minecraft.net/');
                const nativeUrl = lib.downloads?.artifact?.url || `${baseUrl}${ngroupMaven}/${nname}/${nver}/${njarName}`;
                result.natives.missing.push({
                    type: 'native',
                    url: nativeUrl,
                    path: nativePath,
                    sha1: lib.downloads?.artifact?.sha1 || '',
                    size: lib.downloads?.artifact?.size || 0,
                    name: lib.name
                });
            } else if (lib.downloads?.artifact?.sha1) {
                try {
                    const sha1 = await calculateSHA1(nativePath);
                    if (sha1 !== lib.downloads.artifact.sha1) {
                        result.natives.missing.push({
                            type: 'native',
                            url: lib.downloads.artifact.url,
                            path: nativePath,
                            sha1: lib.downloads.artifact.sha1,
                            size: lib.downloads.artifact.size,
                            name: lib.name
                        });
                    }
                } catch (e) {}
            }
        } else if (lib.downloads?.artifact) {
            libTotal++;
            let libPath = safeLibPath(lib.downloads.artifact.path);
            if (!libPath) continue;
                        if (!fs.existsSync(libPath) && externalVersionDir) {
                const externalRoot = findExternalRoot(externalVersionDir);
                if (externalRoot) {
                    const extLibPath = safeLibPath(lib.downloads.artifact.path, path.join(externalRoot, 'libraries'));
                    if (fs.existsSync(extLibPath)) libPath = extLibPath;
                }
                if (!fs.existsSync(libPath)) {
                    const extLibPath2 = safeLibPath(lib.downloads.artifact.path, path.join(path.dirname(path.dirname(externalVersionDir)), 'libraries'));
                    if (fs.existsSync(extLibPath2)) libPath = extLibPath2;
                }
            }
            if (!fs.existsSync(libPath)) {
                let fixUrl = lib.downloads.artifact.url;
                if (!fixUrl && lib.name) {
                    const p = lib.name.split(':');
                    if (p.length >= 3) {
                        const gp = p[0].replace(/\./g, '/');
                        const nm = p[1]; const vr = p[2];
                        const cl = p.length >= 4 ? p[3] : '';
                        const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                        const base = lib.url || (p[0].includes('minecraftforge') || p[0].includes('forge') || p[0].includes('minecraft') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                        fixUrl = `${base}${gp}/${nm}/${vr}/${jn}`;
                    }
                }
                result.libraries.missing.push({
                    type: 'library',
                    url: fixUrl || '',
                    path: libPath,
                    sha1: lib.downloads.artifact.sha1,
                    size: lib.downloads.artifact.size,
                    name: lib.name || path.basename(lib.downloads.artifact.path)
                });
            } else if (lib.downloads.artifact.sha1) {
                try {
                    const sha1 = await calculateSHA1(libPath);
                    if (sha1 !== lib.downloads.artifact.sha1) {
                        let fixUrl = lib.downloads.artifact.url;
                        if (!fixUrl && lib.name) {
                            const p = lib.name.split(':');
                            if (p.length >= 3) {
                                const gp = p[0].replace(/\./g, '/');
                                const nm = p[1]; const vr = p[2];
                                const cl = p.length >= 4 ? p[3] : '';
                                const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                                const base = lib.url || (p[0].includes('minecraftforge') || p[0].includes('forge') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                                fixUrl = `${base}${gp}/${nm}/${vr}/${jn}`;
                            }
                        }
                        result.libraries.missing.push({
                            type: 'library',
                            url: fixUrl || '',
                            path: libPath,
                            sha1: lib.downloads.artifact.sha1,
                            size: lib.downloads.artifact.size,
                            name: lib.name || path.basename(lib.downloads.artifact.path)
                        });
                    }
                } catch (e) {}
            }
        } else if (lib.name && !hasNatives) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                libTotal++;
                const groupPath = parts[0].replace(/\./g, '/');
                const name = parts[1];
                const version = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${name}-${version}-${classifier}.jar` : `${name}-${version}.jar`;
                const localGroupPath = parts[0].replace(/\./g, path.sep);
                let libPath = path.join(LIBRARIES_DIR, localGroupPath, name, version, jarName);
                if (!fs.existsSync(libPath) && externalVersionDir) {
                    const externalRoot = findExternalRoot(externalVersionDir);
                    if (externalRoot) {
                        const extLibPath = path.join(externalRoot, 'libraries', localGroupPath, name, version, jarName);
                        if (fs.existsSync(extLibPath)) libPath = extLibPath;
                    }
                    if (!fs.existsSync(libPath)) {
                        const extLibPath2 = path.join(path.dirname(path.dirname(externalVersionDir)), 'libraries', localGroupPath, name, version, jarName);
                        if (fs.existsSync(extLibPath2)) libPath = extLibPath2;
                    }
                }
                if (!fs.existsSync(libPath)) {
                    let baseUrl = lib.url;
                    if (!baseUrl) {
                        if (lib.name.includes('fabric') || lib.name.includes('fabricmc')) {
                            baseUrl = 'https://maven.fabricmc.net/';
                        } else if (lib.name.includes('forge') || lib.name.includes('minecraftforge') || lib.name.includes('neoforged') || lib.name.startsWith('net.minecraft')) {
                            baseUrl = 'https://maven.minecraftforge.net/';
                        } else {
                            baseUrl = 'https://libraries.minecraft.net/';
                        }
                    }
                    const downloadUrl = `${baseUrl}${groupPath}/${name}/${version}/${jarName}`;
                    console.log(`[DepCheck] 库缺失，构造URL: ${lib.name} -> ${downloadUrl}`);
                    result.libraries.missing.push({
                        type: 'library',
                        url: downloadUrl,
                        path: libPath,
                        sha1: '',
                        size: 0,
                        name: lib.name
                    });
                }
            }
        }

        if (hasNatives) {
            const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
            const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
            const nativeDownload = lib.downloads?.classifiers?.[classifier];
            if (nativeDownload) {
                libTotal++;
                let nativePath = path.join(LIBRARIES_DIR, nativeDownload.path);
            if (!fs.existsSync(nativePath) && externalVersionDir) {
                const externalRoot = findExternalRoot(externalVersionDir);
                if (externalRoot) {
                    const extNativePath = path.join(externalRoot, 'libraries', nativeDownload.path);
                    if (fs.existsSync(extNativePath)) nativePath = extNativePath;
                }
            }
                if (!fs.existsSync(nativePath)) {
                    result.natives.missing.push({
                        type: 'native',
                        url: nativeDownload.url,
                        path: nativePath,
                        sha1: nativeDownload.sha1,
                        size: nativeDownload.size,
                        name: `${lib.name} (${classifier})`
                    });
                } else if (nativeDownload.sha1) {
                    try {
                        const sha1 = await calculateSHA1(nativePath);
                        if (sha1 !== nativeDownload.sha1) {
                            result.natives.missing.push({
                                type: 'native',
                                url: nativeDownload.url,
                                path: nativePath,
                                sha1: nativeDownload.sha1,
                                size: nativeDownload.size,
                                name: `${lib.name} (${classifier})`
                            });
                        }
                    } catch (e) {}
                }
            }
        }
    }
    result.libraries.total = libTotal;
    result.libraries.ok = result.libraries.missing.length === 0;
    if (result.libraries.missing.length > 0) {
        result.libraries.message = `${result.libraries.missing.length} 个库文件缺失或损坏`;
        result.missingFiles.push(...result.libraries.missing);
    }

    result.natives.total = result.natives.missing.length;
    result.natives.ok = result.natives.missing.length === 0;
    if (result.natives.missing.length > 0) {
        result.natives.message = `${result.natives.missing.length} 个原生库缺失或损坏`;
        result.missingFiles.push(...result.natives.missing);
    }

    const scanInheritsForge = (vid, visited) => {
        if (!vid || (visited && visited.has(vid))) return false;
        if (!visited) visited = new Set();
        if (vid.toLowerCase().includes('forge')) return true;
        visited.add(vid);
        const vjPath = path.join(VERSIONS_DIR, vid, `${vid}.json`);
        if (!fs.existsSync(vjPath)) return false;
        try {
            const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
            if (vj.inheritsFrom && !visited.has(vj.inheritsFrom)) {
                return scanInheritsForge(vj.inheritsFrom, visited);
            }
        } catch (_) {}
        return false;
    };

    const hasForgeLibs = (libs) => (libs || []).some(l =>
        l.name && (l.name.startsWith('net.minecraftforge:forge:') ||
                    l.name.startsWith('net.minecraftforge:fmlloader:') ||
                    (l.name.startsWith('net.minecraft:client:') && (l.name.endsWith(':srg') || l.name.endsWith(':extra')))));

    const isForgeVersion = versionId.toLowerCase().includes('forge') ||
        scanInheritsForge(versionId) ||
        hasForgeLibs(versionJson.libraries);
    result.forgeCore = { ok: true, missing: [], message: '' };

    if (isForgeVersion) {
        const forgeCoreLibs = [];
        const forgeLibraries = versionJson.libraries || [];

        const forgeClientLib = forgeLibraries.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
            (l.name.endsWith(':client') || l.name.split(':').length === 3));
        const forgeMainLib = forgeLibraries.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.split(':').length === 3);
        const srgLib = forgeLibraries.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = forgeLibraries.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));

        const forgeCoreDir = (fp) => path.join(LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);

        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            forgeCoreLibs.push({
                name: forgeClientLib.name,
                path: path.join(forgeCoreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`),
                desc: 'Forge客户端核心'
            });
        }
        if (forgeMainLib && forgeMainLib !== forgeClientLib) {
            const fp = forgeMainLib.name.split(':');
            forgeCoreLibs.push({
                name: forgeMainLib.name,
                path: path.join(forgeCoreDir(fp), `${fp[1]}-${fp[2]}.jar`),
                desc: 'Forge主核心'
            });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            forgeCoreLibs.push({
                name: srgLib.name,
                path: path.join(forgeCoreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`),
                desc: 'Minecraft SRG映射客户端'
            });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            forgeCoreLibs.push({
                name: extraLib.name,
                path: path.join(forgeCoreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`),
                desc: 'Minecraft额外客户端'
            });
        }

        if (forgeCoreLibs.length === 0) {
            const forgeVerMatch = versionId.match(/^(.+)-forge-(.+)$/);
            if (forgeVerMatch) {
                const mcVer = forgeVerMatch[1];
                const fVer = forgeVerMatch[2];
                const forgeDir = path.join(LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`);
                if (fs.existsSync(forgeDir)) {
                    try {
                        const files = fs.readdirSync(forgeDir);
                        const clientJar = files.find(f => f.endsWith('-client.jar'));
                        if (clientJar) forgeCoreLibs.push({ name: `forge-client:${mcVer}-${fVer}`, path: path.join(forgeDir, clientJar), desc: 'Forge客户端核心' });
                    } catch (_) {}
                }
                const clientDir = path.join(LIBRARIES_DIR, 'net', 'minecraft', 'client');
                if (fs.existsSync(clientDir)) {
                    try {
                        for (const sd of fs.readdirSync(clientDir)) {
                            const fullDir = path.join(clientDir, sd);
                            try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (_) { continue; }
                            const files = fs.readdirSync(fullDir);
                            const srgFile = files.find(f => f.endsWith('-srg.jar'));
                            if (srgFile) forgeCoreLibs.push({ name: `client-srg:${sd}`, path: path.join(fullDir, srgFile), desc: 'Minecraft SRG映射客户端' });
                            const extraFile = files.find(f => f.endsWith('-extra.jar'));
                            if (extraFile) forgeCoreLibs.push({ name: `client-extra:${sd}`, path: path.join(fullDir, extraFile), desc: 'Minecraft额外客户端' });
                        }
                    } catch (_) {}
                }
                if (forgeCoreLibs.length === 0) {
                    forgeCoreLibs.push({ name: `net.minecraftforge:forge:${mcVer}-${fVer}:client`, path: path.join(LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`, `forge-${mcVer}-${fVer}-client.jar`), desc: 'Forge客户端核心' });
                    forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:srg`, path: path.join(LIBRARIES_DIR, 'net', 'minecraft', 'client', `${mcVer}-20230612.114412`, `client-${mcVer}-20230612.114412-srg.jar`), desc: 'Minecraft SRG映射客户端' });
                    forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:extra`, path: path.join(LIBRARIES_DIR, 'net', 'minecraft', 'client', `${mcVer}-20230612.114412`, `client-${mcVer}-20230612.114412-extra.jar`), desc: 'Minecraft额外客户端' });
                }
            }
        }

        for (const fcl of forgeCoreLibs) {
            if (!fs.existsSync(fcl.path) || (fcl.path.endsWith('.jar') && !isJarIntact(fcl.path))) {
                result.forgeCore.missing.push(fcl);
                console.warn(`[DepCheck] Forge核心库缺失: ${fcl.name} (${fcl.desc})`);
            }
        }

        if (result.forgeCore.missing.length > 0) {
            result.forgeCore.ok = false;
            result.forgeCore.message = `${result.forgeCore.missing.length} 个Forge核心库文件缺失，请使用版本设置的"文件修复"功能或重新安装Forge版本`;
            for (const m of result.forgeCore.missing) {
                const existingEntry = result.missingFiles.find(f => f.path === m.path);
                if (!existingEntry) {
                    result.missingFiles.push({
                        type: 'forge_core',
                        url: '',
                        path: m.path,
                        sha1: '',
                        size: 0,
                        name: m.name,
                        desc: m.desc,
                        message: `Forge核心库缺失: ${m.desc} (${path.basename(m.path)})`
                    });
                }
            }
            console.warn(`[DepCheck] Forge核心检查不通过: ${result.forgeCore.message}`);
        } else {
            console.log(`[DepCheck] Forge核心库(共${forgeCoreLibs.length}个)全部就绪`);
        }
    }

    if (versionJson.assetIndex) {
        const assetIndexInfo = versionJson.assetIndex;
        const assetIndexPath = path.join(ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);

        if (!fs.existsSync(assetIndexPath)) {
            result.assets.ok = false;
            result.assets.message = '资源索引文件缺失';
            result.missingFiles.push({
                type: 'asset_index',
                url: assetIndexInfo.url,
                path: assetIndexPath,
                sha1: assetIndexInfo.sha1,
                size: assetIndexInfo.size,
                name: `${assetIndexInfo.id}.json`
            });
        } else {
            try {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                const assetObjects = assetIndexData.objects || {};
                const assetEntries = Object.entries(assetObjects);
                result.assets.total = assetEntries.length;

                let missingCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const assetPath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                    if (!fs.existsSync(assetPath)) {
                        missingCount++;
                        if (missingCount <= 50) {
                            result.assets.missing.push({
                                type: 'asset',
                                url: `https://resources.download.minecraft.net/${subDir}/${hash}`,
                                path: assetPath,
                                sha1: hash,
                                size: info.size,
                                name: name
                            });
                        }
                    }
                }
                if (missingCount > 50) {
                    result.assets.missing.push({
                        type: 'asset_batch',
                        count: missingCount - 50,
                        message: `还有 ${missingCount - 50} 个资源文件缺失`
                    });
                }
                result.assets.ok = missingCount === 0;
                if (missingCount > 0) {
                    result.assets.message = `${missingCount} 个资源文件缺失`;
                    result.missingFiles.push(...result.assets.missing.filter(f => f.type !== 'asset_batch'));
                }
            } catch (e) {
                result.assets.ok = false;
                result.assets.message = '无法解析资源索引文件';
            }
        }
    }

    result.ready = result.java.ok && result.versionJson.ok && result.mainJar.ok
        && result.libraries.ok && result.natives.ok && result.parentVersion.ok
        && result.assets.ok && result.forgeCore.ok;

    return result;
}

async function downloadMissingDependencies(missingFiles, onProgress, versionJson, maxThreads = null) {
    const parentVersions = missingFiles.filter(f => f.type === 'parent_version');
    for (const pv of parentVersions) {
        console.log(`[Download] Installing missing parent version: ${pv.id}`);
        if (onProgress) {
            onProgress({
                stage: 'parent_version',
                message: `正在安装基础版本 ${pv.id}...`,
                progress: 0
            });
        }
        const result = await ensureBaseVersionInstalled(pv.id);
        if (result.error) {
            console.error(`[Download] Failed to install parent version ${pv.id}:`, result.error);
        }
    }
    
    let allFiles = missingFiles.filter(f => f.type !== 'asset_batch' && f.type !== 'parent_version');
    allFiles = allFiles.filter(f => {
        if (!f.url) {
            console.warn(`[Download] 跳过无URL文件: ${f.name || f.path}`);
            return false;
        }
        return true;
    });

    if (versionJson?.assetIndex) {
        const assetIndexInfo = versionJson.assetIndex;
        const assetIndexPath = path.join(ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);

        if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !await verifyFileSha1(assetIndexPath, assetIndexInfo.sha1))) {
            const dir = path.dirname(assetIndexPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            try {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await downloadFileWithMirror(assetIndexInfo.url, assetIndexPath);
            } catch (e) {
                console.error(`[Download] 资源索引下载失败: ${e.message}`);
            }
        }

        if (fs.existsSync(assetIndexPath)) {
            try {
                const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
                const assetObjects = assetIndexData.objects || {};
                const existingAssetUrls = new Set(allFiles.filter(f => f.type === 'asset').map(f => f.url));

                for (const [name, info] of Object.entries(assetObjects)) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const assetPath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                    const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;

                    if (!fs.existsSync(assetPath) && !existingAssetUrls.has(assetUrl)) {
                        allFiles.push({
                            type: 'asset',
                            url: assetUrl,
                            path: assetPath,
                            sha1: hash,
                            size: info.size,
                            name: name
                        });
                        existingAssetUrls.add(assetUrl);
                    }
                }
            } catch (e) {}
        }
    }

    const settings = loadSettingsCached();
    const CONCURRENT_DOWNLOADS = maxThreads || parseInt(settings.maxThreads, 10) || 32;
    const PRELOAD_QUEUE_SIZE = CONCURRENT_DOWNLOADS * 2;

    DownloadManager.connectionLimit = Math.max(CONCURRENT_DOWNLOADS * 2, 32);
    DownloadManager.reset();
    DownloadManager.totalFiles = allFiles.length;

    const speedLimit = parseInt(settings.speedLimit, 10) || 0;
    DownloadManager.setSpeedLimit(speedLimit);

    const preCheckFiles = [];
    const skipFiles = [];
    for (const file of allFiles) {
        if (fs.existsSync(file.path)) {
            if (file.sha1) {
                try {
                    const actualSha1 = await calculateSHA1(file.path);
                    if (actualSha1 === file.sha1) {
                        skipFiles.push(file);
                        DownloadManager.skippedFiles++;
                        continue;
                    }
                } catch (e) {}
                try { fs.unlinkSync(file.path); } catch (e) {}
            } else {
                try {
                    const stat = fs.statSync(file.path);
                    if (stat.size > 0) {
                        if (file.path.endsWith('.jar') && !isJarIntact(file.path)) {
                            try { fs.unlinkSync(file.path); } catch (_) {}
                        } else {
                            skipFiles.push(file);
                            DownloadManager.skippedFiles++;
                            continue;
                        }
                    }
                } catch (e) {}
            }
        }
        preCheckFiles.push(file);
    }

    if (skipFiles.length > 0) {
        console.log(`[下载] 跳过 ${skipFiles.length} 个已存在的文件`);
    }

    allFiles = preCheckFiles;
    const total = allFiles.length + skipFiles.length;
    DownloadManager.totalFiles = total;

    if (allFiles.length === 0) {
        console.log(`[下载] 所有文件已存在，无需下载`);
        if (onProgress) {
            onProgress({
                status: 'completed',
                current: skipFiles.length,
                total: total,
                progress: 100,
                completedFiles: skipFiles.length,
                totalFiles: total,
                speed: 0
            });
        }
        return { completed: skipFiles.length, failed: 0, total: skipFiles.length, errors: [], failedFiles: [], skipped: skipFiles.length };
    }

    console.log(`[下载] 开始下载 ${allFiles.length} 个文件 (跳过 ${skipFiles.length}), 文件并发: ${CONCURRENT_DOWNLOADS}, 连接池: ${DownloadManager.connectionLimit}, 限速: ${speedLimit > 0 ? speedLimit + ' MB/s' : '无限制'}`);

    let completed = skipFiles.length;
    let failed = 0;
    const errors = [];
    const failedFiles = [];
    const activeDownloads = new Map();

    let fileIndex = 0;
    let activeCount = 0;
    let resolveAll = null;

    const prepareFile = (file) => {
        const dir = path.dirname(file.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    };

    const downloadSingleFile = async (file) => {
        const downloadId = `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        activeDownloads.set(downloadId, { name: file.name, progress: 0, speed: 0, bytesDownloaded: 0, totalBytes: 0 });

        try {
            await downloadFileWithMirror(file.url, file.path, (p) => {
                const active = activeDownloads.get(downloadId);
                if (active) {
                    active.progress = p.progress || 0;
                    active.speed = p.speed || 0;
                    active.bytesDownloaded = p.bytesDownloaded || 0;
                    active.totalBytes = p.totalBytes || 0;
                }
                if (onProgress) {
                    onProgress({
                        current: completed + failed + 1,
                        total,
                        file: file.name,
                        progress: Math.round(((completed + failed + (p.progress || 0) / 100) / total) * 100),
                        bytesDownloaded: p.bytesDownloaded || 0,
                        totalBytes: p.totalBytes || 0,
                        speed: DownloadManager.getSpeed() || p.speed || 0,
                        activeDownloads: Array.from(activeDownloads.values()),
                        completed,
                        failed,
                        queued: Math.min(PRELOAD_QUEUE_SIZE, allFiles.length - fileIndex - activeCount),
                        concurrentDownloads: CONCURRENT_DOWNLOADS,
                        activeConnections: DownloadManager.activeConnections,
                        connectionLimit: DownloadManager.connectionLimit,
                        chunks: p.chunks || 1,
                        activeChunks: p.activeChunks || 1
                    });
                }
            }, 3);

            if (file.sha1) {
                const actualSha1 = await calculateSHA1(file.path);
                if (actualSha1 !== file.sha1) {
                    console.warn(`[下载] SHA1校验失败: ${file.name} (期望: ${file.sha1}, 实际: ${actualSha1})`);
                    try { fs.unlinkSync(file.path); } catch (e) {}

                    const mirrorUrls = getMirrorUrls(file.url);
                    let retrySuccess = false;
                    for (let mi = 0; mi < mirrorUrls.length; mi++) {
                        try {
                            console.log(`[下载] SHA1重试镜像 ${mi + 1}/${mirrorUrls.length}: ${mirrorUrls[mi]}`);
                            await downloadFile(mirrorUrls[mi], file.path, null, 2);
                            const retrySha1 = await calculateSHA1(file.path);
                            if (retrySha1 === file.sha1) {
                                retrySuccess = true;
                                break;
                            }
                            try { fs.unlinkSync(file.path); } catch (e) {}
                        } catch (e2) {
                            console.warn(`[下载] 镜像重试失败: ${mirrorUrls[mi]} - ${e2.message}`);
                        }
                    }

                    if (retrySuccess) {
                        completed++;
                        DownloadManager.completedFiles++;
                    } else {
                        const errorMsg = `${file.name}: SHA1校验失败`;
                        errors.push(errorMsg);
                        failedFiles.push({ name: file.name, url: file.url, path: file.path, error: 'SHA1校验失败' });
                        console.error(`[下载] 所有镜像重试后SHA1仍然失败: ${file.name}`);
                        failed++;
                        DownloadManager.failedFiles++;
                    }
                } else {
                    completed++;
                    DownloadManager.completedFiles++;
                }
            } else {
                completed++;
                DownloadManager.completedFiles++;
            }
        } catch (e) {
            const errorMsg = `${file.name}: 下载失败 (${e.message})`;
            errors.push(errorMsg);
            failedFiles.push({ name: file.name, url: file.url, path: file.path, error: e.message });
            console.error(`[下载] 下载失败: ${file.name} - URL: ${file.url} - 错误: ${e.message}`);
            failed++;
            DownloadManager.failedFiles++;
        } finally {
            activeDownloads.delete(downloadId);
            activeCount--;

            while (activeCount < CONCURRENT_DOWNLOADS && fileIndex < allFiles.length) {
                const nextFile = allFiles[fileIndex++];
                prepareFile(nextFile);
                activeCount++;
                downloadSingleFile(nextFile);
            }

            if (onProgress) {
                onProgress({
                    current: completed + failed,
                    total,
                    file: `已完�?${completed + failed}/${total} 个文件`,
                    progress: Math.round(((completed + failed) / total) * 100),
                    bytesDownloaded: 0,
                    totalBytes: 0,
                    speed: DownloadManager.getSpeed(),
                    activeDownloads: Array.from(activeDownloads.values()),
                    completed,
                    failed,
                    skipped: skipFiles.length,
                    queued: Math.max(0, allFiles.length - fileIndex),
                    failedFiles,
                    stats: DownloadManager.getStats()
                });
            }

            if (activeCount === 0 && fileIndex >= allFiles.length && resolveAll) {
                resolveAll();
            }
        }
    };

    const initialBatch = Math.min(CONCURRENT_DOWNLOADS + PRELOAD_QUEUE_SIZE, allFiles.length);
    for (let i = 0; i < initialBatch; i++) {
        prepareFile(allFiles[i]);
    }

    const startPromise = new Promise((resolve) => {
        resolveAll = resolve;

        for (let i = 0; i < Math.min(CONCURRENT_DOWNLOADS, allFiles.length); i++) {
            fileIndex++;
            activeCount++;
            downloadSingleFile(allFiles[i]);
        }

        if (allFiles.length === 0) {
            resolve();
        }
    });

    await startPromise;

    console.log(`[下载] 下载完成: 成功 ${completed}, 失败 ${failed}, 总计 ${total}`);
    if (failedFiles.length > 0) {
        console.log(`[下载] 失败文件列表:`);
        failedFiles.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    }

    if (onProgress) {
        onProgress({
            status: failed > 0 ? 'completed_with_errors' : 'completed',
            current: completed + failed,
            total,
            progress: 100,
            completedFiles: completed,
            totalFiles: total,
            speed: 0,
            failed,
            failedFiles
        });
    }

    return { completed, failed, total, errors, failedFiles, skipped: skipFiles.length };
}

function calculateSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => {
            stream.destroy();
            reject(err);
        });
    });
}

async function getVersionManifest(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && versionCache && (now - versionCacheTime) < CACHE_DURATION) {
        return versionCache;
    }

    const urls = [
        VERSION_MANIFEST_MIRROR,
        'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
        'https://download.mcbbs.net/mc/game/version_manifest_v2.json',
        'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json',
        VERSION_MANIFEST_URL
    ];

    const fetchWithValidation = async (url) => {
        const manifest = await fetchJSON(url);
        if (manifest && manifest.versions && manifest.versions.length > 0) {
            return manifest;
        }
        throw new Error('Invalid manifest from ' + url);
    };

    try {
        const manifest = await Promise.any(urls.map(url =>
            fetchWithValidation(url).catch(() => { throw new Error(url + ' failed'); })
        ));
        versionCache = manifest;
        versionCacheTime = now;
        saveDiskCache();
        return manifest;
    } catch (e) {
        console.error('All version manifest sources failed');
    }

    if (!forceRefresh && versionCache) return versionCache;

    try {
        if (fs.existsSync(DISK_CACHE_PATH)) {
            const cached = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8'));
            if (cached && cached.data && cached.data.versions && cached.data.versions.length > 0) {
                versionCache = cached.data;
                versionCacheTime = cached.timestamp || 0;
                console.log('[VersionManifest] Using disk cache as fallback');
                return versionCache;
            }
        }
    } catch (e) {}

    throw new Error('无法获取版本列表，请检查网络连接');
}

async function getVersionDetails(versionUrl) {
    if (versionDetailsCache[versionUrl]) {
        return versionDetailsCache[versionUrl];
    }
    try {
        const details = await fetchJSON(versionUrl);
        versionDetailsCache[versionUrl] = details;
        return details;
    } catch (e) {
        console.error('Failed to fetch version details:', e.message);
        throw e;
    }
}

let _versionsCache = null;
let _versionsCacheTime = 0;
const VERSIONS_CACHE_TTL = 5000;

function getInstalledVersions(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && _versionsCache && (now - _versionsCacheTime) < VERSIONS_CACHE_TTL) {
        return _versionsCache;
    }
    const installed = [];
    if (!fs.existsSync(VERSIONS_DIR)) return installed;
    const skipFolders = new Set(['cache', 'blclient', 'pcl', 'temp']);
    try {
        const dirs = fs.readdirSync(VERSIONS_DIR);
        for (const dir of dirs) {
            const versionDir = path.join(VERSIONS_DIR, dir);
            try {
                if (!fs.statSync(versionDir).isDirectory()) continue;
                if (skipFolders.has(dir.toLowerCase())) continue;
            } catch (e) { continue; }
            const jsonFile = findVersionJson(versionDir);
            if (jsonFile) {
                try {
                    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                    const info = detectVersionInfo(data, dir);
                    installed.push({
                        id: data.id || dir,
                        type: data.type || 'release',
                        releaseTime: data.releaseTime || '',
                        mainClass: data.mainClass || '',
                        installed: true,
                        inheritsFrom: data.inheritsFrom || null,
                        isFabric: info.isFabric,
                        isForge: info.isForge,
                        isNeoForge: info.isNeoForge,
                        isOptiFine: info.isOptiFine,
                        isLiteLoader: info.isLiteLoader,
                        isModpack: info.isModpack,
                        modpackLoader: info.modpackLoader,
                        baseVersion: info.baseVersion,
                        isExternal: false
                    });
                } catch (e) {
                    installed.push({ id: dir, type: 'release', installed: true, isExternal: false });
                }
            }
        }
    } catch (e) {}

    const externalFolders = loadExternalFolders();
    for (const folder of externalFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const externalVersions = scanExternalFolder(folder.path);
        for (const ev of externalVersions) {
            ev.customName = folder.name || null;
            const existingIdx = installed.findIndex(v => v.id === ev.id);
            if (existingIdx >= 0) {
                ev.id = ev.id + ' [外部]';
                ev.originalId = ev.id.replace(' [外部]', '');
            }
            installed.push(ev);
        }
    }

    const bareMcVersionPattern = /^\d+\.\d+(\.\d+)?$/;
    const loaderIdPattern = /^(?:fabric-loader-\d|quilt-loader-\d|\d+\.\d+(?:\.\d+)?-(?:forge|neoforge)-\d)/;

    console.log(`[getInstalledVersions] Scanned ${installed.length} raw versions:`);
    for (const v of installed) {
        console.log(`  - ${v.id}  inheritsFrom=${v.inheritsFrom || 'none'}  isForge=${v.isForge}  isFabric=${v.isFabric}  isNeoForge=${v.isNeoForge}  isExternal=${v.isExternal}  loaderPattern=${loaderIdPattern.test(v.id)}`);
    }

    for (const v of installed) {
        if (!v.inheritsFrom || v.isExternal) continue;
        if (loaderIdPattern.test(v.id)) continue;
        if (!bareMcVersionPattern.test(v.inheritsFrom)) continue;
        const baseMcId = v.inheritsFrom;
        const parentLoader = installed.find(l =>
            l.inheritsFrom === baseMcId &&
            !l.isExternal &&
            l.id !== v.id &&
            (l.isForge || l.isFabric || l.isNeoForge || l.isOptiFine || l.isLiteLoader)
        );
        if (parentLoader) {
            const modpackJsonPath = path.join(VERSIONS_DIR, v.id, `${v.id}.json`);
            if (fs.existsSync(modpackJsonPath)) {
                try {
                    const modpackData = JSON.parse(fs.readFileSync(modpackJsonPath, 'utf-8'));
                    if (modpackData.inheritsFrom === baseMcId) {
                        modpackData.inheritsFrom = parentLoader.id;
                        fs.writeFileSync(modpackJsonPath, JSON.stringify(modpackData, null, 2));
                        v.inheritsFrom = parentLoader.id;
                        console.log(`[AutoRepair] Fixed ${v.id} inheritsFrom: ${baseMcId} -> ${parentLoader.id}`);
                    } else {
                        console.log(`[AutoRepair] Skip ${v.id}: JSON already has inheritsFrom=${modpackData.inheritsFrom}`);
                    }
                } catch (e) {
                    console.error(`[AutoRepair] Failed to fix ${v.id}: ${e.message}`);
                }
            } else {
                console.log(`[AutoRepair] Skip ${v.id}: JSON not found at ${modpackJsonPath}`);
            }
        } else {
            console.log(`[AutoRepair] No parent loader found for ${v.id} (inheritsFrom=${baseMcId})`);
        }
    }

    const inheritsFromIds = new Set();
    const installedMap = new Map();
    for (const v of installed) {
        installedMap.set(v.id, v);
        if (v.isExternal && v.id.includes(' [外部]')) {
            installedMap.set(v.id.replace(' [外部]', ''), v);
        }
    }
    for (const v of installed) {
        if (!v.inheritsFrom) continue;
        inheritsFromIds.add(v.inheritsFrom);
        let parentId = v.inheritsFrom;
        while (parentId) {
            const parent = installedMap.get(parentId);
            if (!parent || !parent.inheritsFrom) break;
            parentId = parent.inheritsFrom;
            inheritsFromIds.add(parentId);
        }
    }

    const externalIdMap = new Map();
    for (const v of installed) {
        if (v.isExternal && v.id.includes(' [外部]')) {
            externalIdMap.set(v.id.replace(' [外部]', ''), v.id);
        }
    }
    for (const baseId of [...inheritsFromIds]) {
        const externalId = externalIdMap.get(baseId);
        if (externalId) inheritsFromIds.add(externalId);
    }

    console.log(`[getInstalledVersions] inheritsFromIds (to hide): [${[...inheritsFromIds].join(', ')}]`);

    const result = installed.filter(v => {
        const shouldHide = inheritsFromIds.has(v.id);
        console.log(`[getInstalledVersions] Filter: ${v.id}  isExternal=${v.isExternal}  inSet=${inheritsFromIds.has(v.id)}  -> ${shouldHide ? 'HIDDEN' : 'SHOWN'}`);
        return !shouldHide;
    });

    console.log(`[getInstalledVersions] Final shown count: ${result.length}`);

    try {
        const debugInfo = {
            time: new Date().toISOString(),
            rawVersions: installed.map(v => ({
                id: v.id, inheritsFrom: v.inheritsFrom, isForge: v.isForge,
                isFabric: v.isFabric, isNeoForge: v.isNeoForge,
                isExternal: v.isExternal, isModpack: v.isModpack,
                modpackLoader: v.modpackLoader, baseVersion: v.baseVersion
            })),
            inheritsFromIds: [...inheritsFromIds],
            filteredIds: result.map(v => v.id)
        };
        const debugPath = path.join(DATA_DIR, 'debug-versions.json');
        fs.writeFileSync(debugPath, JSON.stringify(debugInfo, null, 2));
    } catch (_) {}

    _versionsCache = result;
    _versionsCacheTime = Date.now();
    return result;
}

function resolveVersionIsolation(versionId) {
    if (!versionId || versionId.includes('[外部]')) return !!versionId;

    const settings = loadSettingsCached();
    const verSettings = loadVersionSettings(versionId);

    let effectiveIsolation;
    if (verSettings.isolation === 'on') {
        effectiveIsolation = true;
    } else if (verSettings.isolation === 'off') {
        effectiveIsolation = false;
    } else {
        effectiveIsolation = settings.versionIsolation !== false;
    }

    if (!effectiveIsolation) {
        const versionDir = path.join(VERSIONS_DIR, versionId);
        const modsDir = path.join(versionDir, 'mods');
        const savesDir = path.join(versionDir, 'saves');
        const modsHasFiles = fs.existsSync(modsDir) && fs.readdirSync(modsDir).some(f => !f.startsWith('.'));
        const savesHasDirs = fs.existsSync(savesDir) && fs.readdirSync(savesDir).some(f => {
            try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch { return false; }
        });
        if (modsHasFiles || savesHasDirs) {
            effectiveIsolation = true;
        }
    }

    return effectiveIsolation;
}

function resolveExternalVersionDir(versionId) {
    if (!versionId || !versionId.includes('[外部]')) return null;
    const installed = getInstalledVersions();
    const ext = installed.find(v => v.id === versionId && v.isExternal);
    if (ext && ext.externalVersionDir) return ext.externalVersionDir;
    const cleanId = versionId.replace(/\s*\[外部\]/, '');
    const ext2 = installed.find(v => v.id === cleanId && v.isExternal);
    if (ext2 && ext2.externalVersionDir) return ext2.externalVersionDir;
    return null;
}

function getVersionGameDir(versionId) {
    if (!versionId) {
        const settings = loadSettingsCached();
        versionId = settings.selectedVersion || '';
    }
    if (!versionId) return null;

    const extDir = resolveExternalVersionDir(versionId);
    if (extDir) return extDir;

    if (resolveVersionIsolation(versionId)) {
        return path.join(VERSIONS_DIR, versionId);
    }

    const settings = loadSettingsCached();
    return settings.gameDir || DATA_DIR;
}

function getVersionModsDir(versionId) {
    const baseDir = getVersionGameDir(versionId);
    if (!baseDir) return null;
    return path.join(baseDir, 'mods');
}

function getVersionSubDir(versionId, subfolder) {
    const baseDir = getVersionGameDir(versionId);
    if (!baseDir) return null;
    return path.join(baseDir, subfolder);
}

const modIconCache = new Map();
const MOD_ICON_CACHE_MAX = 500;
const MOD_META_CACHE = new Map();
const MOD_META_CACHE_MAX = 500;

const DEFAULT_MOD_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="8" fill="#e2e8f0"/><g transform="translate(12,12)" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M21 11h-6a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4"/><circle cx="7.5" cy="12.5" r="1.5"/><circle cx="15.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="15.5" r="1.5"/></g></svg>');

function parseModJar(jarPath) {
    var cached = MOD_META_CACHE.get(jarPath);
    if (cached) return cached;
    if (MOD_META_CACHE.size > MOD_META_CACHE_MAX) {
        var keys = Array.from(MOD_META_CACHE.keys());
        for (var i = 0; i < 100; i++) MOD_META_CACHE.delete(keys[i]);
    }

    var result = { icon: '', name: '', desc: '', version: '1.0', author: '', projectId: '' };
    try {
        var stat = fs.statSync(jarPath);
        if (stat.size > 100 * 1024 * 1024) {
            MOD_META_CACHE.set(jarPath, result);
            return result;
        }
        var AdmZip = getAdmZip();
        var zip = new AdmZip(jarPath);
        var entries = zip.getEntries();
        var fabricModJson = null;
        var modsToml = null;
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.isDirectory) continue;
            var name = entry.entryName;
            if (name === 'fabric.mod.json') fabricModJson = entry;
            else if (name === 'META-INF/mods.toml') modsToml = entry;
        }

        var iconPath = null;

        if (fabricModJson) {
            try {
                var json = JSON.parse(fabricModJson.getData().toString('utf8'));
                result.name = json.name || '';
                result.desc = json.description || '';
                result.version = json.version || '1.0';
                result.author = (json.authors || []).map(function (a) { return typeof a === 'string' ? a : a.name; }).join(', ') || '';
                result.projectId = json.id || '';
                var rawIcon = json.icon || '';
                if (rawIcon) {
                    if (typeof rawIcon === 'object') {
                        var bestKey = null;
                        var bestSize = 0;
                        var iconKeys = Object.keys(rawIcon);
                        for (var ki = 0; ki < iconKeys.length; ki++) {
                            var k = iconKeys[ki];
                            var size = parseInt(k) || 0;
                            if (size <= 128 && size > bestSize) {
                                bestSize = size;
                                bestKey = k;
                            }
                        }
                        iconPath = bestKey ? rawIcon[bestKey] : rawIcon[iconKeys[0]] || '';
                    } else {
                        iconPath = rawIcon;
                    }
                }
                if (!iconPath && json.id) {
                    for (var ei = 0; ei < entries.length; ei++) {
                        var entryName = entries[ei].entryName;
                        if (entryName === 'assets/' + json.id + '/icon.png') {
                            iconPath = entryName;
                            break;
                        }
                    }
                }
            } catch (e) {}
        }

        if (modsToml) {
            try {
                var toml = modsToml.getData().toString('utf8');
                if (!result.name) { var nm = toml.match(/displayName\s*=\s*"([^"]+)"/); if (nm) result.name = nm[1]; }
                if (!result.desc) { var dm = toml.match(/description\s*=\s*"([^"]+)"/); if (dm) result.desc = dm[1]; }
                if (result.version === '1.0') { var vm = toml.match(/version\s*=\s*"([^"]+)"/); if (vm) result.version = vm[1]; }
                if (!result.author) { var am = toml.match(/author\s*=\s*"([^"]+)"/); if (am) result.author = am[1]; }
                if (!result.projectId) { var mm = toml.match(/modId\s*=\s*"([^"]+)"/); if (mm) result.projectId = mm[1]; }
                if (!iconPath) { var lm = toml.match(/logoFile\s*=\s*"([^"]+)"/); if (lm) iconPath = lm[1]; }
            } catch (e) {}
        }

        if (!iconPath) {
            for (var ei2 = 0; ei2 < entries.length; ei2++) {
                var en = entries[ei2].entryName;
                if (en === 'pack.png' || en === 'logo.png' || en === 'icon.png' || en.endsWith('/icon.png')) {
                    iconPath = en;
                    break;
                }
            }
        }

        if (iconPath) {
            iconPath = iconPath.replace(/\\/g, '/');
            var iconEntry = zip.getEntry(iconPath);
            if (!iconEntry) {
                for (var ei3 = 0; ei3 < entries.length; ei3++) {
                    if (entries[ei3].entryName.replace(/\\/g, '/') === iconPath) {
                        iconEntry = entries[ei3];
                        break;
                    }
                }
            }
            if (iconEntry && !iconEntry.isDirectory) {
                var data = iconEntry.getData();
                var hash = crypto.createHash('md5').update(jarPath + '|' + iconPath).digest('hex');
                var cacheFilePath = path.join(ICON_CACHE_DIR, hash + '.png');
                if (!fs.existsSync(cacheFilePath)) {
                    fs.writeFileSync(cacheFilePath, data);
                }
                result.icon = hash;
            }
        }

        MOD_META_CACHE.set(jarPath, result);
        return result;
    } catch (e) {
        MOD_META_CACHE.set(jarPath, result);
        return result;
    }
}

function extractModIcon(jarPath) {
    var parsed = parseModJar(jarPath);
    return parsed.icon || '';
}

function getInstalledMods() {
    const mods = [];
    const settings = loadSettingsCached();
    const versionId = settings.selectedVersion;
    const modsPath = getVersionModsDir(versionId);
    if (!modsPath || !fs.existsSync(modsPath)) return mods;

    fs.readdirSync(modsPath).forEach(file => {
        const isDisabled = file.endsWith('.disabled');
        const fileName = isDisabled ? file.replace('.disabled', '') : file;
        if (!fileName.endsWith('.jar')) return;

        const name = fileName.replace('.jar', '');
        const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const stat = fs.statSync(path.join(modsPath, file));
        const jarPath = path.join(modsPath, file);

        const parsed = parseModJar(jarPath);

        mods.push({
            id: id,
            name: parsed.name || name,
            fileName: file,
            description: parsed.desc || (isDisabled ? '已禁用' : '已安装的模组'),
            version: parsed.version || '1.0',
            enabled: !isDisabled,
            disabled: isDisabled,
            installed: true,
            size: formatSize(stat.size),
            source: '本地',
            icon: parsed.icon ? `/api/mod-icon?hash=${parsed.icon}` : '',
            author: parsed.author || '',
            projectId: parsed.projectId || ''
        });
    });

    const modIdMap = new Map();
    const warnings = [];
    for (const mod of mods) {
        if (mod.projectId) {
            if (modIdMap.has(mod.projectId)) {
                const existing = modIdMap.get(mod.projectId);
                if (existing.enabled && mod.enabled) {
                    warnings.push({
                        type: 'duplicate',
                        modId: mod.projectId,
                        message: `重复模组: ${mod.name} 与 ${existing.name} 使用相同的ID (${mod.projectId})`,
                        mods: [mod.fileName, existing.fileName]
                    });
                }
            } else {
                modIdMap.set(mod.projectId, mod);
            }
        }
    }

    const CONFLICT_GROUPS = [
        { ids: ['sodium', 'rubidium', 'embeddium'], name: '渲染优化', message: '多个渲染优化模组可能冲突' },
        { ids: ['lithium', 'canary', 'hamlib'], name: '服务端优化', message: '多个服务端优化模组可能冲突' },
        { ids: ['iris', 'oculus'], name: '光影', message: 'Iris和Oculus不能同时使用' },
        { ids: ['sodium', 'optifine', 'optifabric'], name: '渲染', message: 'Sodium和OptiFine不能同时使用' },
        { ids: ['fabric-api', 'fabric', 'quilted_fabric_api'], name: 'API', message: '多个Fabric/Quilt API可能冲突' },
        { ids: ['forge', 'neoforge', 'fmlloader'], name: '加载器', message: '不能同时使用多个模组加载器' },
    ];

    for (const group of CONFLICT_GROUPS) {
        const found = mods.filter(m => m.enabled && group.ids.some(id =>
            m.projectId.toLowerCase().includes(id) || m.name.toLowerCase().includes(id) || m.fileName.toLowerCase().includes(id)
        ));
        if (found.length > 1) {
            warnings.push({
                type: 'conflict',
                group: group.name,
                message: `${group.message}: ${found.map(m => m.name).join(', ')}`,
                mods: found.map(m => m.fileName)
            });
        }
    }

    if (warnings.length > 0) {
        console.log(`[Mods] 检测到 ${warnings.length} 个模组警告`);
    }

    return { mods, warnings };
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatPlayTime(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '0 分钟';
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    let result = '';
    if (days > 0) result += days + ' 天 ';
    if (hours > 0) result += hours + ' 小时 ';
    result += minutes + ' 分钟';
    return result;
}

function formatDriveSize(bytes) {
    if (!bytes || bytes === 0) return '';
    const tb = bytes / (1024 * 1024 * 1024 * 1024);
    if (tb >= 1) return tb.toFixed(1) + ' TB';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(0) + ' GB';
    return formatSize(bytes);
}

function getPlatformKey() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') {
        if (arch === 'x64') return 'windows-x64';
        if (arch === 'arm64') return 'windows-arm64';
        return 'windows-x86';
    }
    if (platform === 'darwin') {
        if (arch === 'arm64') return 'mac-os-arm64';
        return 'mac-os';
    }
    if (arch === 'x64') return 'linux';
    return 'linux-i386';
}

function detectSystemJava() {
    const results = [];
    const foundPaths = new Set();

    function addJavaEntry(javaExe, source) {
        const normalized = javaExe.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        if (foundPaths.has(normalized)) return;
        foundPaths.add(normalized);

        if (!fs.existsSync(javaExe)) return;

        try {
            const versionOutput = execSync(`"${javaExe}" -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
            const versionMatch = versionOutput.match(/version "([^"]+)"/) || versionOutput.match(/version (\S+)/);
            if (!versionMatch) return;
            const version = versionMatch[1];

            let majorVersion = 0;
            if (version.startsWith('1.')) {
                majorVersion = parseInt(version.split('.')[1], 10);
            } else {
                majorVersion = parseInt(version.split('.')[0], 10);
            }
            if (isNaN(majorVersion) || majorVersion <= 0) return;

            const javaHome = path.dirname(path.dirname(javaExe));
            const isJdk = fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));

            let is64Bit = false;
            try {
                const archOutput = execSync(`"${javaExe}" -XshowSettings:properties -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
                is64Bit = archOutput.includes('os.arch = x86_64') || archOutput.includes('os.arch = amd64') || archOutput.includes('64-bit');
            } catch (e) {
                is64Bit = versionOutput.includes('64-Bit') || versionOutput.includes('64-bit');
            }

            const folder = path.dirname(javaExe);
            const folderLower = folder.toLowerCase();
            if (folderLower.includes('finalshell') || folderLower.includes('paranoia')) return;
            if (fs.existsSync(path.join(folder, 'pdf-bookmark'))) return;

            results.push({
                path: javaExe,
                version: version,
                majorVersion: majorVersion,
                is64Bit: is64Bit,
                isJdk: isJdk,
                source: source,
                javaHome: javaHome
            });
        } catch (e) {}
    }

    function searchFolderForJava(basePath, depth) {
        if (depth <= 0 || !fs.existsSync(basePath)) return;
        try {
            const entries = fs.readdirSync(basePath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const dirName = entry.name.toLowerCase();
                const fullPath = path.join(basePath, entry.name);
                const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';

                if (dirName === 'bin') {
                    const javaExe = path.join(fullPath, javaExeName);
                    if (fs.existsSync(javaExe)) {
                        addJavaEntry(javaExe, 'system');
                    }
                    continue;
                }

                const isJavaRelated = ['java', 'jdk', 'jre', 'jvm', 'runtime', 'adopt', 'temurin', 'corretto', 'zulu', 'openjdk', 'graalvm', 'liberica', 'microsoft', 'amazon', 'sapmachine', 'dragonwell', 'bisheng'].some(kw => dirName.includes(kw));
                const isVersionDir = /^jdk[-_]?\d/i.test(dirName) || /^jre[-_]?\d/i.test(dirName) || /^\d+([._]\d+)*$/i.test(dirName);

                if (isJavaRelated || isVersionDir) {
                    const javaExe = path.join(fullPath, 'bin', javaExeName);
                    if (fs.existsSync(javaExe)) {
                        addJavaEntry(javaExe, 'system');
                    }
                    searchFolderForJava(fullPath, depth - 1);
                }
            }
        } catch (e) {}
    }

    if (process.env.JAVA_HOME) {
        const javaHome = process.env.JAVA_HOME.replace(/["']/g, '').replace(/\\$/, '').replace(/\/$/, '');
        const javaExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        addJavaEntry(javaExe, 'system');
    }

    if (process.env.JDK_HOME) {
        const jdkHome = process.env.JDK_HOME.replace(/["']/g, '').replace(/\\$/, '').replace(/\/$/, '');
        const javaExe = path.join(jdkHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        addJavaEntry(javaExe, 'system');
    }

    if (process.env.PATH) {
        const pathDirs = process.env.PATH.split(path.delimiter);
        for (const dir of pathDirs) {
            const trimmed = dir.trim().replace(/["']/g, '');
            if (!trimmed) continue;
            const javaExe = path.join(trimmed, process.platform === 'win32' ? 'java.exe' : 'java');
            if (fs.existsSync(javaExe)) {
                addJavaEntry(javaExe, 'system');
            }
            const parentDir = path.dirname(trimmed);
            if (trimmed.toLowerCase().includes('java') || trimmed.toLowerCase().includes('jdk')) {
                const parentJavaExe = path.join(parentDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
                addJavaEntry(parentJavaExe, 'system');
            }
        }
    }

    if (process.platform === 'win32') {
        try {
            const regOutput = execSync(
                `reg query "HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment" /s 2>nul || reg query "HKLM\\SOFTWARE\\JavaSoft\\JDK" /s 2>nul || reg query "HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit" /s 2>nul`,
                { encoding: 'utf8', timeout: 5000, windowsHide: true }
            );
            const javaHomeMatches = regOutput.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
            for (const m of javaHomeMatches) {
                const javaHome = m[1].trim();
                addJavaEntry(path.join(javaHome, 'bin', 'java.exe'), 'system');
            }
        } catch (e) {}

        try {
            const regOutput64 = execSync(
                `reg query "HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\Java Runtime Environment" /s 2>nul || reg query "HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\JDK" /s 2>nul`,
                { encoding: 'utf8', timeout: 5000, windowsHide: true }
            );
            const javaHomeMatches = regOutput64.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
            for (const m of javaHomeMatches) {
                const javaHome = m[1].trim();
                addJavaEntry(path.join(javaHome, 'bin', 'java.exe'), 'system');
            }
        } catch (e) {}

        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        for (const pf of [programFiles, programFilesX86]) {
            if (fs.existsSync(pf)) {
                try {
                    fs.readdirSync(pf).forEach(d => {
                        const dirLower = d.toLowerCase();
                        if (['java', 'jdk', 'jre', 'adopt', 'temurin', 'corretto', 'zulu', 'amazon', 'microsoft', 'sapmachine', 'bellsoft', 'graalvm', 'dragonwell'].some(kw => dirLower.includes(kw))) {
                            searchFolderForJava(path.join(pf, d), 2);
                        }
                    });
                } catch (e) {}
            }
        }

        const appData = process.env['APPDATA'] || '';
        const localAppData = process.env['LOCALAPPDATA'] || '';
        const userProfile = process.env['USERPROFILE'] || '';

        if (appData) searchFolderForJava(appData, 2);
        if (localAppData) searchFolderForJava(localAppData, 2);

        const minecraftRuntime = path.join(appData, '.minecraft', 'runtime');
        if (fs.existsSync(minecraftRuntime)) {
            searchFolderForJava(minecraftRuntime, 3);
        }

        const launcherRuntime = path.join(DATA_DIR, 'runtime');
        if (fs.existsSync(launcherRuntime)) {
            searchFolderForJava(launcherRuntime, 3);
        }

        const jbrPaths = [
            path.join(localAppData, 'JetBrains', 'Toolbox', 'apps', 'JBR'),
            path.join(programFiles, 'JetBrains'),
        ];
        for (const jbrPath of jbrPaths) {
            if (fs.existsSync(jbrPath)) {
                searchFolderForJava(jbrPath, 3);
            }
        }

        const additionalPaths = [
            'C:\\Java', 'D:\\Java', 'E:\\Java', 'F:\\Java',
            path.join(userProfile, 'Java'),
            path.join(userProfile, '.jdks'),
            path.join(localAppData, 'Programs'),
            path.join(userProfile, '.sdkman', 'candidates', 'java'),
            path.join(userProfile, 'scoop', 'apps', 'openjdk'),
            'C:\\ProgramData\\Oracle\\Java',
            path.join(appData, '.hmcl', 'runtime'),
            path.join(localAppData, 'BakaXL', 'JavaRuntime'),
            path.join(appData, '.minecraft', 'runtime'),
        ];

        for (const searchPath of additionalPaths) {
            if (fs.existsSync(searchPath)) {
                searchFolderForJava(searchPath, 2);
            }
        }

        try {
            const drives = execSync('wmic logicaldisk get caption /value 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true });
            const driveMatches = drives.matchAll(/Caption=(\w:)/gi);
            for (const dm of driveMatches) {
                const driveRoot = dm[1] + '\\';
                try {
                    fs.readdirSync(driveRoot).forEach(d => {
                        const dirLower = d.toLowerCase();
                        if (['java', 'jdk', 'jre', 'runtime'].some(kw => dirLower === kw || dirLower === kw + 's')) {
                            searchFolderForJava(path.join(driveRoot, d), 2);
                        }
                    });
                } catch (e) {}
            }
        } catch (e) {}
    }

    return results;
}

function getTemurinMirrorUrl(githubUrl, osName = 'windows', arch = 'x64') {
    if (!githubUrl || !githubUrl.includes('github.com/adoptium/')) return githubUrl;
    const match = githubUrl.match(/github\.com\/adoptium\/temurin(\d+)-binaries\/releases\/download\/(.+?)\/(.+)$/);
    if (!match) return githubUrl;
    const majorVer = match[1];
    const tag = decodeURIComponent(match[2]);
    const fileName = decodeURIComponent(match[3]);
    const mirrors = [
        `https://mirrors.ustc.edu.cn/adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`,
        `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`,
        `https://mirror.iscas.ac.cn/adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`
    ];
    return mirrors;
}

async function downloadJavaAsync(majorVersion, sessionId, sessionFile, mirrorIndex = 0) {
    const updateStatus = (status, progress, message = '', speed = 0, downloadedBytes = 0, totalBytes = 0) => {
        try {
            fs.writeFileSync(sessionFile, JSON.stringify({
                status: status,
                progress: progress,
                majorVersion: majorVersion,
                message: message,
                speed: speed,
                downloadedBytes: downloadedBytes,
                totalBytes: totalBytes,
                timestamp: Date.now()
            }));
        } catch (e) {}
    };

    let lastPct = 10;
    try {
        updateStatus('fetching', 5, '正在获取JDK下载信息...');
        
        const archMap = { 'windows-x64': 'x64', 'windows-arm64': 'aarch64', 'linux': 'x64', 'linux-i386': 'x86', 'mac-os': 'x64', 'mac-os-arm64': 'aarch64' };
        const platformKey = getPlatformKey();
        const arch = archMap[platformKey] || 'x64';
        const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
        
        let downloadUrl = '';
        let fileName = '';
        let totalSize = 0;
        
        const mirrorBases = [
            `https://mirrors.ustc.edu.cn/adoptium/releases/temurin${majorVersion}-binaries/`,
            `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/releases/temurin${majorVersion}-binaries/`,
            `https://mirror.iscas.ac.cn/adoptium/releases/temurin${majorVersion}-binaries/`
        ];
        
        const probeResults = await Promise.allSettled(mirrorBases.map(async (mirrorBase) => {
            const hostname = new URL(mirrorBase).hostname;
            const start = Date.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const resp = await fetch(mirrorBase, { signal: controller.signal });
                clearTimeout(timer);
                if (!resp.ok) return { hostname, ok: false, latency: Infinity };
                const html = await resp.text();
                const dirRegex = /href="[^"]*?(jdk-\d+\.\d+\.\d+%2B\d+)[^"]*?"/g;
                const dirs = [];
                let dm;
                while ((dm = dirRegex.exec(html)) !== null) dirs.push(decodeURIComponent(dm[1]));
                if (dirs.length === 0) return { hostname, ok: false, latency: Infinity };
                dirs.sort().reverse();
                const latestDir = dirs[0];
                const vm = latestDir.match(/jdk-(\d+)\.(\d+)\.(\d+)\+(\d+)/);
                if (!vm) return { hostname, ok: false, latency: Infinity };
                const testFileName = `OpenJDK${majorVersion}U-jdk_${arch}_${osName}_hotspot_${vm[2]}.${vm[3]}_${vm[4]}.zip`;
                const testUrl = mirrorBase + latestDir + '/' + testFileName;
                const h2 = new AbortController();
                const t2 = setTimeout(() => h2.abort(), 5000);
                const r2 = await fetch(testUrl, { method: 'HEAD', signal: h2.signal });
                clearTimeout(t2);
                if (!r2.ok) return { hostname, ok: false, latency: Infinity };
                const latency = Date.now() - start;
                let size = 0;
                if (r2.headers.get('content-length')) size = parseInt(r2.headers.get('content-length'), 10) || 0;
                return { hostname, ok: true, latency, dir: latestDir, fileName: testFileName, baseUrl: mirrorBase, size };
            } catch (e) {
                clearTimeout(timer);
                return { hostname, ok: false, latency: Infinity };
            }
        }));
        
        const available = probeResults.filter(r => r.status === 'fulfilled' && r.value.ok).map(r => r.value);
        available.sort((a, b) => a.latency - b.latency);
        
        if (available.length > 0) {
            const best = available[0];
            console.log(`[Java] 最快镜像: ${best.hostname} (${best.latency}ms)`);
            updateStatus('fetching', 5, `已选择最快镜像: ${best.hostname}`);
            downloadUrl = best.baseUrl + best.dir + '/' + best.fileName;
            fileName = best.fileName;
            totalSize = best.size;
        }
        
        if (!downloadUrl) {
            updateStatus('fetching', 5, '正在请求Adoptium官方API...');
            const apiUrl = `${TEMURIN_API}/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jdk&os=${osName}&vendor=eclipse`;
            console.log(`[Java] 请求Adoptium API: ${apiUrl}`);
            try {
                const apiResponse = await Promise.race([
                    fetchJSONWithMethod(apiUrl, 'GET'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('API timeout (20s)')), 20000))
                ]);
                if (apiResponse && apiResponse.length > 0 && apiResponse[0].binary && apiResponse[0].binary.package && apiResponse[0].binary.package.link) {
                    const latest = apiResponse[0];
                    downloadUrl = latest.binary.package.link;
                    fileName = latest.binary.package.name || `jdk-${majorVersion}.zip`;
                    totalSize = latest.binary.package.size || 0;
                    console.log(`[Java] API返回下载链接: ${downloadUrl.substring(0, 80)}...`);
                }
            } catch (e) {
                console.warn(`[Java] Adoptium API失败: ${e.message}`);
            }
        }
        
        if (!downloadUrl) {
            throw new Error(`未找到JDK ${majorVersion}的下载信息，所有源均不可用（请检查网络连接或VPN）`);
        }

        let downloadMirrors = [];
        if (downloadUrl.includes('github.com/adoptium/')) {
            const mirrors = getTemurinMirrorUrl(downloadUrl, osName, arch);
            if (Array.isArray(mirrors)) {
                downloadMirrors = mirrors;
                console.log(`[Java] GitHub URL检测到，生成${downloadMirrors.length}个国内镜像`);
                downloadMirrors.forEach(m => console.log(`  -> ${m.substring(0, 80)}`));
            }
        }

        console.log(`[Java] 文件大小: ${totalSize} bytes`);

        const tempFile = path.join(DATA_DIR, fileName);

        updateStatus('downloading', 10, `正在下载Temurin JDK ${majorVersion}...`);

        let peakBytes = 0;
        const calcPct = (progress) => {
            const tb = progress.totalBytes > 0 ? progress.totalBytes : totalSize;
            if (tb > 0) {
                const pct = Math.min(80, Math.floor((progress.bytesDownloaded / tb) * 70) + 10);
                lastPct = Math.max(lastPct, pct);
            } else {
                peakBytes = Math.max(peakBytes, progress.bytesDownloaded);
                const estimatedTotal = peakBytes * 1.15;
                if (estimatedTotal > 0) {
                    const pct = Math.min(79, Math.floor((progress.bytesDownloaded / estimatedTotal) * 70) + 10);
                    lastPct = Math.max(lastPct, pct);
                }
            }
            return lastPct;
        };
        const formatProgress = (progress) => {
            const tb = progress.totalBytes > 0 ? progress.totalBytes : totalSize;
            const dlMB = (progress.bytesDownloaded / 1024 / 1024).toFixed(1);
            if (tb > 0) {
                const totalMB = (tb / 1024 / 1024).toFixed(1);
                return `正在下载Temurin JDK ${majorVersion}... ${dlMB}MB / ${totalMB}MB`;
            }
            return `正在下载Temurin JDK ${majorVersion}... ${dlMB}MB 已下载`;
        };
        let _lastDlBytes = 0, _lastDlTime = Date.now(), _smoothSpeed = 0;
        const onDlProgress = (progress) => {
            const now = Date.now();
            const dt = (now - _lastDlTime) / 1000;
            let speed = progress.speed || 0;
            if (dt >= 0.5) {
                const localSpeed = (progress.bytesDownloaded - _lastDlBytes) / dt;
                speed = speed > 0 ? Math.max(speed, localSpeed) : localSpeed;
                _lastDlBytes = progress.bytesDownloaded;
                _lastDlTime = now;
            }
            _smoothSpeed = _smoothSpeed > 0 ? _smoothSpeed * 0.7 + speed * 0.3 : speed;
            updateStatus('downloading', calcPct(progress), formatProgress(progress), Math.max(_smoothSpeed, speed), progress.bytesDownloaded, progress.totalBytes || totalSize);
        };

        await downloadFileChunked(downloadMirrors.length > 0 ? downloadMirrors[0] : downloadUrl, tempFile, { onProgress: onDlProgress, timeout: 600000, retries: 3, mirrors: downloadMirrors.length > 0 ? downloadMirrors : null }).catch(async (err) => {
            console.log(`[Java] 分块下载失败: ${err.message}，回退单线程`);
            const fallbackUrls = downloadMirrors.length > 0 ? [...downloadMirrors, downloadUrl] : [downloadUrl];
            let lastErr = err;
            for (const url of fallbackUrls) {
                try {
                    console.log(`[Java] 尝试单线程下载: ${url.substring(0, 80)}...`);
                    await _dlSingle(url, tempFile, { onProgress: onDlProgress, timeout: 600000, retries: 2, stallTimeout: 30000 });
                    return;
                } catch (e) {
                    console.warn(`[Java] 单线程下载失败: ${e.message}`);
                    lastErr = e;
                }
            }
            throw lastErr;
        });
        
        updateStatus('extracting', 85, '正在解压JDK...');
        
        if (!fs.existsSync(JAVA_DIR)) fs.mkdirSync(JAVA_DIR, { recursive: true });
        
        const extractDir = path.join(JAVA_DIR, '_java_extract');
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });
        
        if (process.platform === 'win32') {
            await new Promise((resolve, reject) => {
                const psCmd = `Expand-Archive -Path '${tempFile.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
                const child = spawn('powershell', ['-Command', psCmd], { timeout: 300000, windowsHide: true });
                let stderr = '';
                child.stderr.on('data', (d) => { stderr += d.toString(); });
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else {
                        console.log(`[Java] PowerShell解压失败(code=${code}), 尝试adm-zip...`);
                        try {
                            const AdmZip = require('adm-zip');
                            const zip = new AdmZip(tempFile);
                            zip.extractAllTo(extractDir, true);
                            resolve();
                        } catch (e2) {
                            reject(new Error('解压失败: ' + (e2.message || stderr)));
                        }
                    }
                });
                child.on('error', (err) => {
                    console.log(`[Java] PowerShell启动失败, 尝试adm-zip...`);
                    try {
                        const AdmZip = require('adm-zip');
                        const zip = new AdmZip(tempFile);
                        zip.extractAllTo(extractDir, true);
                        resolve();
                    } catch (e2) {
                        reject(new Error('解压失败: ' + e2.message));
                    }
                });
            });
        } else {
            await new Promise((resolve, reject) => {
                const child = spawn('tar', ['-xzf', tempFile, '-C', extractDir], { timeout: 300000 });
                child.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`tar解压失败, code=${code}`)); });
                child.on('error', reject);
            });
        }
        
        const subDirs = fs.readdirSync(extractDir);
        const jreDir = subDirs.find(d => { const sub = path.join(extractDir, d); return fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')); });
        
        const targetPath = path.join(JAVA_DIR, `jdk-${majorVersion}`);
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
        
        if (jreDir) fs.renameSync(path.join(extractDir, jreDir), targetPath);
        else if (subDirs.length === 1) fs.renameSync(path.join(extractDir, subDirs[0]), targetPath);
        else fs.renameSync(extractDir, targetPath);
        
        try { fs.unlinkSync(tempFile); } catch (e) {}
        try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
        
        const javaExe = path.join(targetPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (!fs.existsSync(javaExe)) throw new Error('安装失败：找不到java可执行文件');
        
        updateStatus('configuring', 92, '正在配置Java环境变量...');
        try {
            configureJavaEnv(targetPath, majorVersion);
            console.log(`[Java] 环境变量配置成功: ${targetPath}`);
        } catch (envErr) {
            console.warn(`[Java] 环境变量配置失败(不影响使用): ${envErr.message}`);
        }
        
        updateStatus('completed', 100, `Temurin JDK ${majorVersion} 安装成功！环境变量已配置。`);
        console.log(`[Java] JDK ${majorVersion} 安装成功: ${targetPath}`);
        
        try {
            const settings = loadSettingsCached();
            const javaExeWin = path.join(targetPath, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java');
            if (!settings.javaPath || !fs.existsSync(settings.javaPath)) {
                settings.javaPath = javaExeWin;
                saveSettings(settings);
                console.log(`[Java] 已自动配置javaPath: ${javaExeWin}`);
            }
        } catch (setErr) {
            console.warn('[Java] 自动配置javaPath失败:', setErr.message);
        }
        
    } catch (e) {
        console.error('[Java] 下载失败:', e.message);
        updateStatus('error', lastPct, `安装失败: ${e.message}`);
    }
}


function configureJavaEnv(javaHome, majorVersion) {
    if (process.platform !== 'win32') {
        console.log('[JavaEnv] 非Windows平台，跳过系统环境变量配置');
        return { success: false, message: '非Windows平台，跳过环境变量配置' };
    }

    const javaBinDir = path.join(javaHome, 'bin');
    if (!fs.existsSync(javaBinDir)) {
        throw new Error(`Java bin目录不存在: ${javaBinDir}`);
    }

    try {
        const currentPath = execSync(
            `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine')"`,
            { encoding: 'utf8', timeout: 10000, windowsHide: true }
        ).trim();

        const pathEntries = currentPath.split(';').filter(p => p.trim() !== '');
        const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const alreadyInPath = pathEntries.some(p => 
            p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === normalizedJavaBin
        );

        if (alreadyInPath) {
            console.log(`[JavaEnv] ${javaBinDir} 已在系统PATH中，跳过`);
        } else {
            const newPath = currentPath.endsWith(';') 
                ? currentPath + javaBinDir 
                : currentPath + ';' + javaBinDir;
            execSync(
                `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newPath.replace(/'/g, "''")}', 'Machine')"`,
                { encoding: 'utf8', timeout: 15000, windowsHide: true }
            );
            console.log(`[JavaEnv] 已将 ${javaBinDir} 添加到系统PATH`);
        }

        const currentJavaHome = execSync(
            `powershell -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')"`,
            { encoding: 'utf8', timeout: 10000, windowsHide: true }
        ).trim();

        const normalizedJavaHome = javaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const currentJavaHomeNorm = currentJavaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

        if (currentJavaHome && currentJavaHomeNorm !== normalizedJavaHome) {
            const existingMajorMatch = currentJavaHome.match(/jdk[-]?(\d+)/i);
            const newMajorMatch = javaHome.match(/jdk[-]?(\d+)/i);
            const existingMajor = existingMajorMatch ? parseInt(existingMajorMatch[1], 10) : 0;
            const newMajor = newMajorMatch ? parseInt(newMajorMatch[1], 10) : 0;

            if (newMajor >= existingMajor) {
                execSync(
                    `powershell -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', '${javaHome.replace(/'/g, "''")}', 'Machine')"`,
                    { encoding: 'utf8', timeout: 15000, windowsHide: true }
                );
                console.log(`[JavaEnv] 已更新JAVA_HOME: ${javaHome}`);
            } else {
                console.log(`[JavaEnv] 现有JAVA_HOME(${currentJavaHome})版本更高，保留不变`);
            }
        } else if (!currentJavaHome) {
            execSync(
                `powershell -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', '${javaHome.replace(/'/g, "''")}', 'Machine')"`,
                { encoding: 'utf8', timeout: 15000, windowsHide: true }
            );
            console.log(`[JavaEnv] 已设置JAVA_HOME: ${javaHome}`);
        }

        try {
            const currentUserPath = execSync(
                `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`,
                { encoding: 'utf8', timeout: 10000, windowsHide: true }
            ).trim();
            const userPathEntries = currentUserPath.split(';').filter(p => p.trim() !== '');
            const inUserPath = userPathEntries.some(p => 
                p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === normalizedJavaBin
            );
            if (!inUserPath) {
                const newUserPath = currentUserPath.endsWith(';')
                    ? currentUserPath + javaBinDir
                    : currentUserPath + ';' + javaBinDir;
                execSync(
                    `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newUserPath.replace(/'/g, "''")}', 'User')"`,
                    { encoding: 'utf8', timeout: 15000, windowsHide: true }
                );
                console.log(`[JavaEnv] 已将 ${javaBinDir} 添加到用户PATH`);
            }
        } catch (userErr) {
            console.warn(`[JavaEnv] 用户PATH配置失败(不影响): ${userErr.message}`);
        }

        try {
            process.env.PATH = javaBinDir + ';' + (process.env.PATH || '');
            process.env.JAVA_HOME = javaHome;
            console.log(`[JavaEnv] 当前进程环境变量已更新`);
        } catch (procErr) {
            console.warn(`[JavaEnv] 进程环境变量更新失败: ${procErr.message}`);
        }

        return { success: true, javaHome: javaHome, binPath: javaBinDir };

    } catch (e) {
        throw new Error(`环境变量配置失败: ${e.message}`);
    }
}

function detectBundledJava() {
    const results = [];
    if (!fs.existsSync(JAVA_DIR)) return results;

    const findJavaInDir = (dir, maxDepth, currentDepth = 0) => {
        if (currentDepth > maxDepth || !fs.existsSync(dir)) return;
        try {
            const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
            const directJavaExe = path.join(dir, 'bin', javaExeName);
            if (fs.existsSync(directJavaExe)) {
                const javaHome = dir;
                const versionFile = path.join(javaHome, 'release');
                let version = 'unknown';
                let majorVersion = 0;

                if (fs.existsSync(versionFile)) {
                    const content = fs.readFileSync(versionFile, 'utf8');
                    const match = content.match(/JAVA_VERSION="([^"]+)"/);
                    if (match) {
                        version = match[1];
                        majorVersion = parseInt(version.split('.')[0], 10);
                    }
                }

                if (majorVersion <= 0) {
                    try {
                        const versionOutput = execSync(`"${directJavaExe}" -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
                        const versionMatch = versionOutput.match(/version "([^"]+)"/) || versionOutput.match(/version (\S+)/);
                        if (versionMatch) {
                            version = versionMatch[1];
                            if (version.startsWith('1.')) {
                                majorVersion = parseInt(version.split('.')[1], 10);
                            } else {
                                majorVersion = parseInt(version.split('.')[0], 10);
                            }
                        }
                    } catch (e) {}
                }

                const isJdk = fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));
                const normalized = directJavaExe.toLowerCase().replace(/\\/g, '/');
                if (!results.some(r => r.path.toLowerCase().replace(/\\/g, '/') === normalized)) {
                    results.push({
                        path: directJavaExe,
                        version: version,
                        majorVersion: majorVersion || 17,
                        is64Bit: true,
                        isJdk: isJdk,
                        source: 'bundled',
                        javaHome: javaHome
                    });
                }
                return;
            }
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    findJavaInDir(path.join(dir, entry.name), maxDepth, currentDepth + 1);
                }
            }
        } catch (e) {}
    };

    const javaDirs = fs.readdirSync(JAVA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    for (const javaDirName of javaDirs) {
        findJavaInDir(path.join(JAVA_DIR, javaDirName), 4);
    }

    // 也搜索 runtime 目录（Minecraft 官方 Java 运行时安装位置）
    const runtimeDir = path.join(DATA_DIR, 'runtime');
    if (fs.existsSync(runtimeDir)) {
        findJavaInDir(runtimeDir, 4);
    }

    return results;
}

async function getJavaRuntimeList() {
    const data = await fetchJSON(JAVA_RUNTIME_URL);
    const platformKey = getPlatformKey();
    return data[platformKey] || {};
}

function getJavaMirrorUrl(originalUrl, mirror) {
    if (!mirror || !mirror.urlMap) return originalUrl;
    for (const [original, replacement] of Object.entries(mirror.urlMap)) {
        if (originalUrl.startsWith(original)) {
            return originalUrl.replace(original, replacement);
        }
    }
    return originalUrl;
}

async function downloadJavaRuntime(component, onProgress, mirrorIndex = 0) {
    const mirror = JAVA_DOWNLOAD_MIRRORS[mirrorIndex] || JAVA_DOWNLOAD_MIRRORS[0];

    try {
        const runtimeList = await getJavaRuntimeList();
        const runtimeInfo = runtimeList[component];

        if (!runtimeInfo || runtimeInfo.length === 0) {
            throw new Error(`Java runtime ${component} not available for this platform`);
        }

        const runtime = runtimeInfo[0];
        let manifestUrl = runtime.manifest.url;
        if (mirror) {
            manifestUrl = getJavaMirrorUrl(manifestUrl, mirror);
        }

        if (onProgress) {
            onProgress({
                file: 'manifest',
                current: 0,
                total: 0,
                progress: 0,
                downloadedBytes: 0,
                totalBytes: 0,
                speed: 0,
                source: mirror ? mirror.name : 'Mojang官方'
            });
        }

        const manifest = await fetchJSON(manifestUrl);

        const targetDir = path.join(JAVA_DIR, component);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const files = manifest.files || {};
        const fileEntries = Object.entries(files);
        const totalFiles = fileEntries.length;
        let downloadedFiles = 0;
        let totalBytes = 0;
        let downloadedBytes = 0;
        let lastTime = Date.now();
        let lastSpeedBytes = 0;
        let speed = 0;
        const fileBytes = {};

        for (const [filePath, fileInfo] of fileEntries) {
            if (fileInfo.downloads && fileInfo.downloads.raw) {
                const sz = fileInfo.downloads.raw.size || 0;
                totalBytes += sz;
                fileBytes[filePath] = sz;
            }
        }

        const CONCURRENT = 8;
        let idx = 0;

        async function downloadNext() {
            while (idx < fileEntries.length) {
                const i = idx++;
                const [filePath, fileInfo] = fileEntries[i];
                const destPath = path.join(targetDir, filePath);
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                if (fileInfo.downloads && fileInfo.downloads.raw) {
                    const download = fileInfo.downloads.raw;
                    let downloadUrl = download.url;
                    if (mirror) downloadUrl = getJavaMirrorUrl(downloadUrl, mirror);

                    await downloadFile(downloadUrl, destPath, (progress) => {
                        const now = Date.now();
                        const elapsed = now - lastTime;
                        const incrementalBytes = (progress.bytesDownloaded || 0);
                        downloadedBytes += incrementalBytes;
                        if (elapsed >= 500) {
                            speed = Math.round((downloadedBytes - lastSpeedBytes) * 1000 / elapsed);
                            lastTime = now;
                            lastSpeedBytes = downloadedBytes;
                        }
                        if (onProgress) {
                            onProgress({
                                file: path.basename(filePath),
                                current: downloadedFiles + 1,
                                total: totalFiles,
                                progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                                downloadedBytes: downloadedBytes,
                                totalBytes: totalBytes,
                                speed: speed,
                                source: mirror ? mirror.name : 'Mojang官方'
                            });
                        }
                    }, 3, null);
                } else {
                    fs.writeFileSync(destPath, '');
                }

                if (fileInfo.executable && process.platform !== 'win32') {
                    try { fs.chmodSync(destPath, 0o755); } catch (e) {}
                }

                downloadedFiles++;
            }
        }

        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENT, totalFiles); w++) {
            workers.push(downloadNext());
        }
        await Promise.all(workers);

        return {
            path: path.join(targetDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
            version: runtime.version.name,
            component: component,
            source: mirror ? mirror.name : 'Mojang官方',
            javaHome: targetDir
        };
    } catch (e) {
        if (mirrorIndex < JAVA_DOWNLOAD_MIRRORS.length - 1) {
            console.log(`Java download from ${mirror ? mirror.name : 'default'} failed, trying next mirror...`);
            return downloadJavaRuntime(component, onProgress, mirrorIndex + 1);
        }
        throw e;
    }
}

async function autoInstallJava(requiredVersion = 17) {
    const systemJava = detectSystemJava();
    const bundledJava = detectBundledJava();
    const allJava = [...bundledJava, ...systemJava];

    const suitable = allJava.find(j => j.majorVersion >= requiredVersion);
    if (suitable) {
        return { installed: false, javaPath: suitable.path, version: suitable.version, majorVersion: suitable.majorVersion };
    }

    const componentMap = {
        8: 'java-runtime-alpha',
        16: 'java-runtime-gamma',
        17: 'java-runtime-gamma',
        21: 'java-runtime-delta'
    };
    const component = componentMap[requiredVersion] || 'java-runtime-gamma';

    const sessionId = `java-auto-${Date.now()}`;
    javaInstallSessions.set(sessionId, {
        status: 'pending',
        progress: 0,
        message: '正在准备Java安装...',
        component,
        source: '',
        speed: 0
    });

    try {
        const result = await downloadJavaRuntime(component, (progress) => {
            const session = javaInstallSessions.get(sessionId);
            if (session) {
                session.status = 'downloading';
                session.progress = progress.progress;
                session.message = `下载�? ${progress.file} (${progress.current}/${progress.total})`;
                session.source = progress.source || '';
                session.speed = progress.speed || 0;
                session.downloadedBytes = progress.downloadedBytes || 0;
                session.totalBytes = progress.totalBytes || 0;
            }
        });

        const session = javaInstallSessions.get(sessionId);
        if (session) {
            session.status = 'configuring';
            session.progress = 95;
            session.message = '正在配置Java环境变量...';
        }

        if (result.javaHome) {
            try {
                configureJavaEnv(result.javaHome, requiredVersion);
                console.log(`[Java] autoInstallJava 环境变量配置成功: ${result.javaHome}`);
            } catch (envErr) {
                console.warn(`[Java] autoInstallJava 环境变量配置失败(不影响使用): ${envErr.message}`);
            }
        }

        if (session) {
            session.status = 'completed';
            session.progress = 100;
            session.message = 'Java运行时安装完成！环境变量已配置。';
            session.result = result;
        }

        return { installed: true, javaPath: result.path, version: result.version, component: result.component, source: result.source, sessionId };
    } catch (e) {
        const session = javaInstallSessions.get(sessionId);
        if (session) {
            session.status = 'failed';
            session.message = `安装失败: ${e.message}`;
            session.error = e.message;
        }
        throw e;
    }
}

function findMainJar(versionJson, versionId, externalVersionDir = null, _visited = null) {
    const actualVersionId = versionId || versionJson.id || '';
    const jarName = versionJson.jar || versionJson.inheritsFrom || actualVersionId;
    
    const isExternal = !!externalVersionDir;
    let externalRoot = null;
    if (isExternal) {
        externalRoot = findExternalRoot(externalVersionDir);
        if (!externalRoot) externalRoot = path.dirname(path.dirname(externalVersionDir));
    }

    const searchPaths = [];

    if (versionJson.jar) {
        if (isExternal && externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', versionJson.jar, `${versionJson.jar}.jar`));
        }
        searchPaths.push(path.join(VERSIONS_DIR, versionJson.jar, `${versionJson.jar}.jar`));
    }

    if (versionJson.inheritsFrom) {
        if (isExternal && externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
            searchPaths.push(path.join(path.dirname(externalVersionDir), versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
        }
        searchPaths.push(path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
    }

    if (isExternal) {
        if (externalRoot) {
            searchPaths.push(path.join(externalRoot, 'versions', actualVersionId, `${actualVersionId}.jar`));
        }
        searchPaths.push(path.join(externalVersionDir, `${actualVersionId}.jar`));
        const dirName = path.basename(externalVersionDir);
        searchPaths.push(path.join(externalVersionDir, `${dirName}.jar`));
        if (externalRoot && dirName !== actualVersionId) {
            searchPaths.push(path.join(externalRoot, 'versions', dirName, `${dirName}.jar`));
        }
    }
    searchPaths.push(path.join(VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`));

    for (const p of searchPaths) {
        if (fs.existsSync(p)) return p;
    }

    if (isExternal && externalRoot) {
        for (const jarId of [versionJson.jar, versionJson.inheritsFrom, actualVersionId]) {
            if (!jarId) continue;
            const verDir = path.join(externalRoot, 'versions', jarId);
            if (fs.existsSync(verDir)) {
                try {
                    const jars = fs.readdirSync(verDir).filter(f => f.endsWith('.jar'));
                    if (jars.length > 0) return path.join(verDir, jars[0]);
                } catch (e) {}
            }
        }
    }

    // Follow inheritsFrom chain recursively
    if (versionJson.inheritsFrom && !isExternal) {
        if (!_visited) _visited = new Set();
        if (_visited.has(versionJson.inheritsFrom)) {
            console.warn(`[FindMainJar] 继承链循环: ${[..._visited].join(' -> ')} -> ${versionJson.inheritsFrom}`);
            return null;
        }
        _visited.add(versionJson.inheritsFrom);
        
        const parentJsonPath = path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
        if (fs.existsSync(parentJsonPath)) {
            try {
                const parentJson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                const parentJar = findMainJar(parentJson, versionJson.inheritsFrom, null, _visited);
                if (parentJar) return parentJar;
            } catch (e) {}
        }
        
        // Fallback: scan any jar in inherited version dir
        const parentDir = path.join(VERSIONS_DIR, versionJson.inheritsFrom);
        if (fs.existsSync(parentDir)) {
            try {
                const jars = fs.readdirSync(parentDir).filter(f => f.endsWith('.jar'));
                if (jars.length > 0) return path.join(parentDir, jars[0]);
            } catch (e) {}
        }
    }

    console.warn(`[FindMainJar] 未找到主JAR: versionId=${actualVersionId}, jar=${versionJson.jar || '无'}, inheritsFrom=${versionJson.inheritsFrom || '无'}`);
    return null;
}

function findExternalRoot(versionDir) {
    let dir = versionDir;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'libraries'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'assets'))) {
            return dir;
        }
        if (fs.existsSync(path.join(dir, 'versions'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}
// ============================================================================
// 版本JSON处理 - 解析、合并和修复版本配置文件
// ============================================================================

function detectModLoaderParent(data, externalVersionDir) {
    try {
    const versionId = data.id || '';
    if (versionId.toLowerCase().includes('forge') || versionId.toLowerCase().includes('neoforged') ||
        versionId.toLowerCase().includes('fabric') || versionId.toLowerCase().includes('quilt')) {
        return null;
    }

    const gameArgs = data.arguments?.game || [];
    const forgeVersionArg = gameArgs.find(a => typeof a === 'string' && a.startsWith('--fml.forgeVersion'));
    const mcVersionArg = gameArgs.find(a => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
    const launchTarget = gameArgs.find(a => typeof a === 'string' && a === 'forgeclient') ||
                          gameArgs.find(a => typeof a === 'string' && a === 'forge_server');
    const mainClass = data.mainClass || '';

    const isForge = forgeVersionArg || launchTarget || mainClass.includes('bootstraplauncher') || mainClass.includes('BootstrapLauncher');

    if (!isForge) return null;

    let forgeVersion = '';
    let mcVersion = '';

    if (forgeVersionArg) {
        const idx = gameArgs.indexOf(forgeVersionArg);
        if (idx >= 0 && idx + 1 < gameArgs.length) {
            forgeVersion = gameArgs[idx + 1];
        }
    }

    if (mcVersionArg) {
        const idx = gameArgs.indexOf(mcVersionArg);
        if (idx >= 0 && idx + 1 < gameArgs.length) {
            mcVersion = gameArgs[idx + 1];
        }
    }

    if (!mcVersion && data.clientVersion) {
        mcVersion = data.clientVersion;
    }

    if (!forgeVersion || !mcVersion) {
        const forgeLib = (data.libraries || []).find(l =>
            l.name && l.name.startsWith('net.minecraftforge:forge:') ||
            l.name && l.name.startsWith('net.minecraftforge:fmlloader:')
        );
        if (forgeLib) {
            const parts = forgeLib.name.split(':');
            if (parts.length >= 3) {
                const verPart = parts[2];
                const dashIdx = verPart.lastIndexOf('-');
                if (dashIdx > 0) {
                    mcVersion = verPart.substring(0, dashIdx);
                    forgeVersion = verPart.substring(dashIdx + 1);
                }
            }
        }
    }

    if (!forgeVersion || !mcVersion) return null;

    const candidateIds = [];
    candidateIds.push(`${mcVersion}-forge-${forgeVersion}`);
    candidateIds.push(`${mcVersion}-Forge_${forgeVersion}`);
    candidateIds.push(`forge-${forgeVersion}`);

    const searchDirs = [];
    if (externalVersionDir) {
        const externalRoot = findExternalRoot(externalVersionDir);
        if (externalRoot) {
            searchDirs.push(path.join(externalRoot, 'versions'));
        }
        searchDirs.push(path.dirname(externalVersionDir));
        const externalFolders = loadExternalFolders();
        for (const folder of externalFolders) {
            if (!fs.existsSync(folder.path)) continue;
            searchDirs.push(path.join(folder.path, 'versions'));
        }
    }
    searchDirs.push(VERSIONS_DIR);

    for (const candidateId of candidateIds) {
        for (const searchDir of searchDirs) {
            const candidateDir = path.join(searchDir, candidateId);
            if (findVersionJson(candidateDir)) {
                console.log(`[DetectParent] 自动检测到Forge父版本: ${candidateId} (在 ${searchDir})`);
                return candidateId;
            }
        }
    }

    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        try {
            const entries = fs.readdirSync(searchDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const versionDir = path.join(searchDir, entry.name);
                const jsonFile = findVersionJson(versionDir);
                if (!jsonFile) continue;
                try {
                    const jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                    const hasForgeLibs = (jsonData.libraries || []).some(l =>
                        l.name && l.name === `net.minecraftforge:forge:${mcVersion}-${forgeVersion}`
                    );
                    if (hasForgeLibs) {
                        console.log(`[DetectParent] 在版本 ${entry.name} 中发现Forge库`);
                        return entry.name;
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    return null;
    } catch (e) {
        console.error('[DetectParent] 异常:', e.message);
        return null;
    }
}

function resolveVersionJson(versionId, externalVersionDir = null, visited = null) {
    if (!visited) visited = new Set();
    if (visited.has(versionId)) return null;
    visited.add(versionId);

    let versionDir, jsonFile;
    if (externalVersionDir) {
        versionDir = externalVersionDir;
        jsonFile = findVersionJson(versionDir);
    } else {
        versionDir = path.join(VERSIONS_DIR, versionId);
        jsonFile = findVersionJson(versionDir);
    }
    if (!jsonFile || !fs.existsSync(jsonFile)) return null;

    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    if (!data.inheritsFrom) {
        const detectedParent = detectModLoaderParent(data, externalVersionDir);
        if (detectedParent) {
            data.inheritsFrom = detectedParent;
        }
    }
    if (data.inheritsFrom) {
        let parentVersionDir = null;
        const searchPaths = [];
        if (externalVersionDir) {
            const externalRoot = findExternalRoot(externalVersionDir);
            if (externalRoot) {
                searchPaths.push(path.join(externalRoot, 'versions', data.inheritsFrom));
            }
            searchPaths.push(path.join(path.dirname(externalVersionDir), data.inheritsFrom));
            const externalFolders = loadExternalFolders();
            for (const folder of externalFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const candidate = path.join(folder.path, 'versions', data.inheritsFrom);
                if (!searchPaths.includes(candidate)) searchPaths.push(candidate);
            }
        }
        searchPaths.push(path.join(VERSIONS_DIR, data.inheritsFrom));

        for (const searchDir of searchPaths) {
            if (findVersionJson(searchDir)) {
                parentVersionDir = searchDir;
                break;
            }
        }

        if (parentVersionDir) {
            const isParentExternal = parentVersionDir !== path.join(VERSIONS_DIR, data.inheritsFrom);
            const parentJson = resolveVersionJson(data.inheritsFrom, isParentExternal ? parentVersionDir : null, visited);
            if (parentJson) {
                return mergeVersionJson(parentJson, data);
            }
        }

        console.warn(`[ResolveVersion] Parent version not found: ${data.inheritsFrom}`);
    }
    return data;
}

function mergeVersionJson(parent, child) {
    const merged = { ...parent };
    const childKeys = Object.keys(child);

    for (const key of childKeys) {
        if (key === 'libraries') continue;
        if (key === 'arguments') continue;
        if (key === 'minecraftArguments') continue;
        if (key === 'downloads') continue;
        if (key === 'assetIndex') continue;
        if (key === 'javaVersion') {
            if (child[key] && child[key].majorVersion) {
                merged[key] = child[key];
            }
            continue;
        }
        if (child[key] !== undefined && child[key] !== null) {
            merged[key] = child[key];
        }
    }

    if (child.inheritsFrom) {
        merged.inheritsFrom = child.inheritsFrom;
    }
    if (child.id) {
        merged.id = child.id;
    }

    const childLibs = child.libraries || [];
    const parentLibs = parent.libraries || [];
    const childLibKeys = new Set();
    for (const lib of childLibs) {
        if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 2) childLibKeys.add(parts[0] + ':' + parts[1]);
        }
    }
    // 过滤父版本库：如果子版本已有相同 group:artifact 的库则跳过
    // 同时处理命名变体（如 bootstraplauncher vs bootstrapslauncher 带/不带 s）
    const normalizedChildKeys = new Set();
    for (const key of childLibKeys) {
        normalizedChildKeys.add(key);
        // 生成规范化 key（去掉尾部 s 变体，如 bootstraplauncher↔bootstrapslauncher）
        const parts = key.split(':');
        if (parts.length >= 2) {
            const base = parts[1].replace(/s$/, ''); // 去掉末尾的 s
            normalizedChildKeys.add(`${parts[0]}:${base}`);
            normalizedChildKeys.add(`${parts[0]}:${base}s`); // 加回 s
        }
    }

    const filteredParentLibs = parentLibs.filter(lib => {
        if (!lib.name) return true;
        const parts = lib.name.split(':');
        if (parts.length >= 2 && normalizedChildKeys.has(parts[0] + ':' + parts[1])) return false;
        // 也检查规范化后的名称
        if (parts.length >= 2) {
            const base = parts[1].replace(/s$/, '');
            if (normalizedChildKeys.has(`${parts[0]}:${base}`)) return false;
        }
        return true;
    });
    merged.libraries = [...childLibs, ...filteredParentLibs];

    merged.arguments = merged.arguments || {};
    const childJvm = child.arguments?.jvm || [];
    const parentJvm = parent.arguments?.jvm || [];
    const childGame = child.arguments?.game || [];
    const parentGame = parent.arguments?.game || [];

    if (child.minecraftArguments && !child.arguments?.jvm && !child.arguments?.game) {
        merged.arguments.jvm = parentJvm;
        merged.arguments.game = parentGame;
    } else {
        if (childJvm.length > 0 || parentJvm.length > 0) {
            merged.arguments.jvm = deduplicateJvmArgs([...childJvm, ...parentJvm]);
        }
        if (childGame.length > 0 || parentGame.length > 0) {
            merged.arguments.game = deduplicateGameArgs([...childGame, ...parentGame]);
        }
    }

    // PCL2-style: Also merge Fabric/NeoForge non-standard argument groups
    for (const argGroupKey of ['default-user-jvm', 'default-user-game', 'default-jvm', 'default-game']) {
        const childGroup = child.arguments?.[argGroupKey] || [];
        const parentGroup = parent.arguments?.[argGroupKey] || [];
        if (childGroup.length > 0 || parentGroup.length > 0) {
            merged.arguments[argGroupKey] = [...childGroup, ...parentGroup];
        }
    }

    if (child.minecraftArguments) {
        merged.minecraftArguments = child.minecraftArguments;
    } else if (parent.minecraftArguments) {
        merged.minecraftArguments = parent.minecraftArguments;
    }

    if (child.mainClass) {
        merged.mainClass = child.mainClass;
    }

    if (child.downloads) {
        merged.downloads = { ...parent.downloads, ...child.downloads };
    }
    if (child.assetIndex) {
        merged.assetIndex = child.assetIndex;
    } else if (parent.assetIndex) {
        merged.assetIndex = parent.assetIndex;
    }
    if (child.javaVersion) {
        merged.javaVersion = child.javaVersion;
    } else if (parent.javaVersion) {
        merged.javaVersion = parent.javaVersion;
    }
    if (child.jar) {
        merged.jar = child.jar;
    } else if (parent.jar) {
        merged.jar = parent.jar;
    }
    if (child.assets) {
        merged.assets = child.assets;
    } else if (parent.assets) {
        merged.assets = parent.assets;
    }
    if (child.type) {
        merged.type = child.type;
    }

    if (merged.mainClass && merged.mainClass.startsWith('net.fabricmc')) {
        const hasFabricLoader = (merged.libraries || []).some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
        if (!hasFabricLoader) {
            const versionId = child.id || merged.id || '';
            const fabricMatch = versionId.match(/-Fabric-(\d+\.\d+\.\d+)/);
            const loaderVer = fabricMatch ? fabricMatch[1] : '0.16.10';
            const loaderJarName = `fabric-loader-${loaderVer}.jar`;
            console.log(`[MergeJson] 自动修复: 添加 fabric-loader ${loaderVer}`);
            merged.libraries = [
                {
                    name: `net.fabricmc:fabric-loader:${loaderVer}`,
                    url: 'https://maven.fabricmc.net/',
                    downloads: {
                        artifact: {
                            path: `net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`,
                            url: `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`
                        }
                    }
                },
                ...(merged.libraries || [])
            ];
        }
    }

    return merged;
}

function deduplicateJvmArgs(args) {
    if (!args || !Array.isArray(args) || args.length === 0) {
        return args || [];
    }

    const SINGLE_VALUE_OPTIONS = new Set([
        '-Djava.net.preferIPv6Addresses', '-DignoreList', '-DmergeModules',
        '-DlibraryDirectory', '-p', '--add-modules', '--add-opens',
        '--add-exports', '--add-reads', '-Xms', '-Xmx', '-XX:'
    ]);

    const seenStringArgs = new Set();
    const result = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (typeof arg !== 'string') {
            result.push(arg);
            continue;
        }

        if (arg.startsWith('-D') || arg.startsWith('-X') || arg.startsWith('-XX')) {
            if (seenStringArgs.has(arg)) continue;
            seenStringArgs.add(arg);
            result.push(arg);
        } else {
            result.push(arg);
        }
    }

    const removedCount = args.length - result.length;
    if (removedCount > 0) {
        console.log(`[Dedup] Removed ${removedCount} duplicate JVM arguments`);
    }

    return result;
}

function deduplicateGameArgs(args) {
    if (!args || !Array.isArray(args) || args.length === 0) {
        return args || [];
    }

    const SINGLE_VALUE_OPTIONS = new Set([
        '--version', '--username', '--uuid', '--accessToken',
        '--userType', '--versionType', '--gameDir', '--assetsDir',
        '--assetIndex', '--width', '--height', '--server', '--port',
        '--xuid', '--clientId',
        '--launchTarget', '--fml.forgeVersion', '--fml.mcVersion',
        '--fml.forgeGroup', '--fml.mcpVersion', '--fml.neoForgeVersion',
        '--fml.neoFormVersion', '--fml.fmlVersion', '--fml.mcVersion'
    ]);

    const result = [];
    const seenOptions = new Set();

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (typeof arg !== 'string') {
            result.push(arg);
            continue;
        }

        if (SINGLE_VALUE_OPTIONS.has(arg)) {
            if (seenOptions.has(arg)) {
                if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
                    i++;
                }
                continue;
            }
            seenOptions.add(arg);
            result.push(arg);
            if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
                result.push(args[i + 1]);
                i++;
            }
        } else {
            result.push(arg);
        }
    }

    const removedCount = args.length - result.length;
    if (removedCount > 0) {
        console.log(`[Dedup] Removed ${removedCount} duplicate game arguments`);
    }

    return result;
}

function evaluateRules(rules, extraVars = {}) {
    if (!rules || rules.length === 0) return true;
    let allowed = null;
    let hasAllowRule = false;
    for (const rule of rules) {
        const action = rule.action;
        if (action === 'allow') hasAllowRule = true;
        let ruleMatched = true;
        
        if (rule.os) {
            const osName = rule.os.name;
            const isCurrentOS = (process.platform === 'win32' && osName === 'windows') ||
                               (process.platform === 'darwin' && osName === 'osx') ||
                               (process.platform === 'linux' && osName === 'linux');
            
            let osMatch = isCurrentOS;
            
            if (rule.os.arch) {
                const isCurrentArch = (rule.os.arch === 'x86' && process.arch === 'ia32') ||
                                     (rule.os.arch === 'x64' && process.arch === 'x64');
                osMatch = osMatch && isCurrentArch;
            }
            
            if (rule.os.version) {
                const osVersion = require('os').release();
                try {
                    const regex = new RegExp(rule.os.version);
                    const testResult = regex.test(osVersion);
                    osMatch = osMatch && testResult;
                } catch (e) {
                    osMatch = false;
                }
                if (osVersion.length > 256) {
                    osMatch = false;
                }
            }
            
            ruleMatched = osMatch;
        }
        
        if (rule.features) {
            if (rule.features.is_demo_user) {
                ruleMatched = ruleMatched && false;
            }
            if (rule.features.has_custom_resolution) {
                ruleMatched = ruleMatched && !!extraVars.hasCustomResolution;
            }
            if (rule.features.has_quick_plays_support) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_singleplayer) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_multiplayer) {
                ruleMatched = false;
            }
            if (rule.features.is_quick_play_realms) {
                ruleMatched = false;
            }
        }
        
        if (!rule.os && !rule.features) {
            ruleMatched = true;
        }
        
        if (ruleMatched) {
            allowed = action === 'allow';
        }
    }
    if (allowed !== null) return allowed;
    return !hasAllowRule;
}

function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const len = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

function findForgeCoreJars(versionJson, searchBases) {
    const gameArgs = versionJson.arguments?.game || [];
    const mainClass = versionJson.mainClass || '';
    const hasForgeLaunch = gameArgs.some(a => typeof a === 'string' && a === 'forgeclient');
    const isBootStrap = mainClass.includes('bootstraplauncher') || mainClass.includes('BootstrapLauncher');

    const isNeoForgeVersion = gameArgs.some(a => typeof a === 'string' && a === '--fml.neoForgeVersion') ||
        (versionJson.libraries || []).some(l => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader'));
    const isForge = hasForgeLaunch || isBootStrap;

    console.log(`[findForgeCoreJars] versionId=${versionJson.id} isNeoForge=${isNeoForgeVersion} isForge=${isForge} gameArgsLen=${gameArgs.length} hasForgeLaunch=${hasForgeLaunch} isBootStrap=${isBootStrap}`);

    if (!isForge && !isNeoForgeVersion) return [];

    if (isNeoForgeVersion) {
        return findNeoForgeCoreJars(versionJson, searchBases, gameArgs);
    }

    let forgeVersion = '';
    let mcVersion = '';

    const forgeVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.forgeVersion');
    const mcVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');

    if (forgeVerIdx >= 0 && forgeVerIdx + 1 < gameArgs.length) {
        forgeVersion = gameArgs[forgeVerIdx + 1];
    }
    if (mcVerIdx >= 0 && mcVerIdx + 1 < gameArgs.length) {
        mcVersion = gameArgs[mcVerIdx + 1];
    }
    if (!mcVersion && versionJson.clientVersion) {
        mcVersion = versionJson.clientVersion;
    }

    if (!forgeVersion || !mcVersion) {
        const forgeLib = (versionJson.libraries || []).find(l =>
            l.name && (l.name.startsWith('net.minecraftforge:fmlloader:') || l.name.startsWith('net.minecraftforge:forge:'))
        );
        if (forgeLib) {
            const parts = forgeLib.name.split(':');
            if (parts.length >= 3) {
                const verPart = parts[2];
                const dashIdx = verPart.lastIndexOf('-');
                if (dashIdx > 0) {
                    mcVersion = verPart.substring(0, dashIdx);
                    forgeVersion = verPart.substring(dashIdx + 1);
                }
            }
        }
    }

    if (!forgeVersion || !mcVersion) return [];

    const verStr = `${mcVersion}-${forgeVersion}`;
    const prefix = 'net/minecraftforge';

    const coreArtifacts = [
        { dir: `${prefix}/fmlcore/${verStr}`, file: `fmlcore-${verStr}.jar` },
        { dir: `${prefix}/javafmllanguage/${verStr}`, file: `javafmllanguage-${verStr}.jar` },
        { dir: `${prefix}/mclanguage/${verStr}`, file: `mclanguage-${verStr}.jar` },
        { dir: `${prefix}/lowcodelanguage/${verStr}`, file: `lowcodelanguage-${verStr}.jar` },
    ];

    const result = [];

    for (const artifact of coreArtifacts) {
        for (const base of searchBases) {
            if (!base) continue;
            const jarPath = path.join(base, artifact.dir, artifact.file);
            if (fs.existsSync(jarPath)) {
                if (!result.some(r => path.basename(r) === path.basename(jarPath))) {
                    result.push(jarPath);
                }
                break;
            }
        }
    }

    {
        const forgeDir = `${prefix}/forge/${verStr}`;
        for (const base of searchBases) {
            if (!base) continue;
            const dirPath = path.join(base, forgeDir);
            if (!fs.existsSync(dirPath)) continue;
            const candidates = [
                `forge-${verStr}-universal.jar`,
                `forge-${verStr}-client.jar`,
                `forge-${verStr}.jar`,
            ];
            let found = false;
            for (const candidate of candidates) {
                const jarPath = path.join(dirPath, candidate);
                if (fs.existsSync(jarPath)) {
                    result.push(jarPath);
                    found = true;
                    break;
                }
            }
            if (!found) {
                try {
                    const files = fs.readdirSync(dirPath)
                        .filter(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                    if (files.length > 0) {
                        result.push(path.join(dirPath, files[0]));
                    }
                } catch (e) {}
            }
            break;
        }
    }

    if (result.length > 0) {
        console.log(`[Classpath] 自动添加Forge核心JAR (${result.length}): ${result.map(r => path.basename(r)).join(', ')}`);
    }

    return result;
}

function findNeoForgeCoreJars(versionJson, searchBases, gameArgs) {
    console.log(`[findNeoForgeCoreJars] called, versionId=${versionJson.id}, gameArgsLen=${gameArgs.length}, searchBasesLen=${searchBases.length}`);
    let neoForgeVersion = '';
    let mcVersion = '';

    const neoForgeVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.neoForgeVersion');
    const mcVerIdx = gameArgs.findIndex(a => typeof a === 'string' && a === '--fml.mcVersion');

    console.log(`[findNeoForgeCoreJars] neoForgeVerIdx=${neoForgeVerIdx} mcVerIdx=${mcVerIdx}`);

    if (neoForgeVerIdx >= 0 && neoForgeVerIdx + 1 < gameArgs.length) {
        neoForgeVersion = gameArgs[neoForgeVerIdx + 1];
    }
    if (mcVerIdx >= 0 && mcVerIdx + 1 < gameArgs.length) {
        mcVersion = gameArgs[mcVerIdx + 1];
    }
    if (!mcVersion && versionJson.clientVersion) {
        mcVersion = versionJson.clientVersion;
    }

    if (!neoForgeVersion) {
        const neoLib = (versionJson.libraries || []).find(l =>
            l.name && l.name.startsWith('net.neoforged:neoforge:')
        );
        if (neoLib) {
            const parts = neoLib.name.split(':');
            if (parts.length >= 3) {
                neoForgeVersion = parts[2];
            }
        }
        if (!neoForgeVersion) {
            const versionDirName = versionJson.id || '';
            const neoMatch = versionDirName.match(/neoforge[_\-\s]*(\d+[\d.]*(?:\.\d+)*)/i);
            if (neoMatch) {
                neoForgeVersion = neoMatch[1];
            }
        }
        if (!neoForgeVersion) {
            const fmlLoaderLib = (versionJson.libraries || []).find(l =>
                l.name && l.name.startsWith('net.neoforged.fancymodloader:loader:')
            );
            if (fmlLoaderLib) {
                const parts = fmlLoaderLib.name.split(':');
                if (parts.length >= 3) {
                    neoForgeVersion = parts[2];
                }
            }
        }
    }

    if (!neoForgeVersion) {
        console.log(`[findNeoForgeCoreJars] neoForgeVersion empty, returning []`);
        return [];
    }

    console.log(`[findNeoForgeCoreJars] neoForgeVersion=${neoForgeVersion} mcVersion=${mcVersion}`);

    const result = [];
    const prefix = 'net/neoforged/neoforge';

    for (const base of searchBases) {
        if (!base) continue;
        const dirPath = path.join(base, prefix, neoForgeVersion);
        if (!fs.existsSync(dirPath)) continue;

        const candidates = [
            `neoforge-${neoForgeVersion}-universal.jar`,
            `neoforge-${neoForgeVersion}.jar`,
        ];
        let found = false;
        for (const candidate of candidates) {
            const jarPath = path.join(dirPath, candidate);
            if (fs.existsSync(jarPath)) {
                result.push(jarPath);
                found = true;
                break;
            }
        }
        if (!found) {
            try {
                const files = fs.readdirSync(dirPath)
                    .filter(f => f.startsWith('neoforge-') && f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                if (files.length > 0) {
                    result.push(path.join(dirPath, files[0]));
                }
            } catch (e) {}
        }
        break;
    }

    if (result.length > 0) {
        console.log(`[Classpath] 自动添加NeoForge核心JAR (${result.length}): ${result.map(r => path.basename(r)).join(', ')}`);
    } else {
        console.log(`[findNeoForgeCoreJars] no JAR found in searchBases, returning []`);
    }

    return result;
}

function buildClasspath(versionJson, versionId, externalVersionDir = null) {
    const classpath = [];
    const libraries = versionJson.libraries || [];
    const isExternal = !!externalVersionDir;
    
    let externalRoot = null;
    if (isExternal) {
        externalRoot = findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }

    const searchBases = [];
    if (isExternal && externalRoot) {
        searchBases.push(path.join(externalRoot, 'libraries'));
    }
    searchBases.push(LIBRARIES_DIR);

    function mavenNameToPath(name) {
        const parts = name.split(':');
        if (parts.length < 3) return null;
        const groupPath = parts[0].replace(/\./g, '/');
        const artifactId = parts[1];
        const version = parts[2];
        const classifier = parts.length >= 4 ? `-${parts[3]}` : '';
        const jarName = `${artifactId}-${version}${classifier}.jar`;
        return `${groupPath}/${artifactId}/${version}/${jarName}`;
    }

    function findLibFile(relPath) {
        for (const base of searchBases) {
            if (!base) continue;
            const p = path.join(base, relPath);
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    function findLibByMavenName(name) {
        const relPath = mavenNameToPath(name);
        if (!relPath) return null;
        return findLibFile(relPath);
    }

    function findLibByFallback(name) {
        const parts = name.split(':');
        if (parts.length < 3) return null;
        const groupPath = parts[0].replace(/\./g, path.sep);
        const artifactId = parts[1];
        const version = parts[2];
        const classifier = parts.length >= 4 ? parts[3] : null;
        for (const base of searchBases) {
            if (!base) continue;
            const dir = path.join(base, groupPath, artifactId, version);
            if (!fs.existsSync(dir)) continue;
            try {
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                if (files.length === 0) continue;
                if (classifier) {
                    const preferred = `${artifactId}-${version}-${classifier}.jar`;
                    const match = files.find(f => f === preferred);
                    if (match) return path.join(dir, match);
                }
                const preferred = `${artifactId}-${version}.jar`;
                const match = files.find(f => f === preferred);
                if (match) return path.join(dir, match);
                return path.join(dir, files[0]);
            } catch (e) {}
        }
        return null;
    }

    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';

    let foundCount = 0;
    let missingCount = 0;
    let missingList = [];

    for (const lib of libraries) {
        if (lib.rules && !evaluateRules(lib.rules)) continue;

        const libName = lib.name || '';
        const nameSuffix = libName ? libName.split(':').pop() : '';

        if (lib.natives) continue;

        if (nameSuffix.startsWith('natives-')) {
            const platformNative = nameSuffix.replace('natives-', '');
            let isValidPlatform = false;
            if (process.arch === 'x64') {
                isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
            } else if (process.arch === 'ia32') {
                isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
            } else if (process.arch === 'arm64') {
                isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
            }
            if (!isValidPlatform) continue;
        }

        let foundPath = null;

        if (lib.downloads?.artifact?.path) {
            foundPath = findLibFile(lib.downloads.artifact.path);
        }

        if (!foundPath && libName) {
            foundPath = findLibByMavenName(libName);
        }

        if (!foundPath && libName) {
            foundPath = findLibByFallback(libName);
        }

        if (foundPath) {
            classpath.push(foundPath);
            foundCount++;
        } else {
            missingCount++;
            missingList.push(libName);
        }
    }

    const forgeExtraJars = findForgeCoreJars(versionJson, searchBases);
    for (const jar of forgeExtraJars) {
        classpath.push(jar);
        foundCount++;
    }

    if (missingList.length > 0) {
        console.warn(`[Classpath] 缺失库 (${missingList.length}): ${missingList.slice(0, 20).join(', ')}`);
    }

    const dedupedClasspath = [];
    const seenLibBases = new Map();
    for (const cp of classpath) {
        const baseName = path.basename(cp, '.jar');
        const dashParts = baseName.split('-');
        if (dashParts.length >= 2) {
            const libKey = dashParts.slice(0, -1).join('-');
            if (seenLibBases.has(libKey)) {
                const existingIdx = seenLibBases.get(libKey);
                const existingBase = path.basename(dedupedClasspath[existingIdx], '.jar');
                const existingVer = existingBase.split('-').pop();
                const newVer = dashParts[dashParts.length - 1];
                if (newVer > existingVer) {
                    dedupedClasspath[existingIdx] = cp;
                }
                continue;
            }
            seenLibBases.set(libKey, dedupedClasspath.length);
        }
        dedupedClasspath.push(cp);
    }

    const actualVersionId = versionId || versionJson.id || '';
    const jarPath = findMainJar(versionJson, actualVersionId, externalVersionDir);

    if (jarPath && fs.existsSync(jarPath)) {
        dedupedClasspath.push(jarPath);
    } else {
        console.error(`[Classpath] 主JAR未找到: ${actualVersionId}, jar=${versionJson.jar || '无'}, inheritsFrom: ${versionJson.inheritsFrom || '无'}`);
    }

    console.log(`[Classpath] 构建: ${foundCount} 找到, ${missingCount} 缺失, 去重后: ${dedupedClasspath.length}`);
    return dedupedClasspath.join(process.platform === 'win32' ? ';' : ':');
}

function extractNatives(versionJson, versionId, externalVersionDir = null) {
    const nativesDir = path.join(VERSIONS_DIR, versionId, 'natives');
    if (fs.existsSync(nativesDir)) {
        try { fs.rmSync(nativesDir, { recursive: true, force: true }); } catch (e) {}
    }
    fs.mkdirSync(nativesDir, { recursive: true });

    const libraries = versionJson.libraries || [];
    const currentPlatform = process.platform === 'win32' ? 'windows' :
                             process.platform === 'darwin' ? 'osx' : 'linux';
    
    let externalRoot = null;
    if (externalVersionDir) {
        externalRoot = findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }

    const nativeSearchBases = [];
    if (externalRoot) {
        nativeSearchBases.push(path.join(externalRoot, 'libraries'));
    }
    nativeSearchBases.push(LIBRARIES_DIR);

    function findNativeJar(baseHref) {
        for (const base of nativeSearchBases) {
            if (!base) continue;
            const p = path.join(base, baseHref);
            if (fs.existsSync(p)) return p;
        }
        return null;
    }
    
    function extractNativeJar(jarPath) {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(jarPath);
            const entries = zip.getEntries();
            let extracted = 0;
            for (const entry of entries) {
                const entryName = entry.entryName;
                if (entryName.startsWith('META-INF')) continue;
                if (entryName.startsWith('.')) continue;
                if (entryName.includes('/.git')) continue;
                if (entryName.endsWith('.gitkeep') || entryName.endsWith('.gitignore')) continue;
                if (entryName.endsWith('.sha1') || entryName.endsWith('.git')) continue;
                const ext = path.extname(entryName).toLowerCase();
                const isNative = ext === '.dll' || ext === '.so' || ext === '.jnilib' || ext === '.dylib';
                const isConfig = ext === '.json' || ext === '.cfg' || ext === '.properties' || ext === '.toml';
                if (isNative || isConfig) {
                    const fileName = path.basename(entryName);
                    const destPath = path.join(nativesDir, fileName);
                    try {
                        const data = entry.getData();
                        if (data && data.length > 0) {
                            fs.writeFileSync(destPath, data);
                            extracted++;
                            console.log(`[Natives] 解压: ${fileName} (${data.length} bytes)`);
                        }
                    } catch (writeErr) {
                        console.log(`[Natives] 写入失败 ${fileName}: ${writeErr.message}`);
                    }
                }
            }
            return extracted;
        } catch (e) {
            console.log(`[Natives] AdmZip失败: ${e.message}，尝试系统解压`);
            try {
                const tempDir = nativesDir + '_temp';
                if (fs.existsSync(tempDir)) {
                    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e2) {}
                }
                fs.mkdirSync(tempDir, { recursive: true });
                
                if (process.platform === 'win32') {
                    execSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                        `Expand-Archive -Path '${jarPath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`],
                        { stdio: 'pipe', timeout: 120000, windowsHide: true });
                } else {
                    execSync('unzip', ['-o', jarPath, '-d', tempDir, '-x', 'META-INF/*'], { stdio: 'pipe', timeout: 120000 });
                }
                
                let extracted = 0;
                function collectFiles(dir) {
                    const items = fs.readdirSync(dir);
                    for (const item of items) {
                        const itemPath = path.join(dir, item);
                        const stat = fs.statSync(itemPath);
                        if (stat.isDirectory()) {
                            collectFiles(itemPath);
                        } else {
                            const ext = path.extname(item).toLowerCase();
                            const isNative = ext === '.dll' || ext === '.so' || ext === '.jnilib' || ext === '.dylib';
                            const isConfig = ext === '.json' || ext === '.cfg' || ext === '.properties' || ext === '.toml';
                            if (isNative || isConfig) {
                                const destPath = path.join(nativesDir, item);
                                fs.copyFileSync(itemPath, destPath);
                                extracted++;
                                console.log(`[Natives] 系统解压: ${item}`);
                            }
                        }
                    }
                }
                collectFiles(tempDir);
                
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e3) {}
                return extracted;
            } catch (e2) {
                console.log(`[Natives] 系统解压也失败: ${e2.message}`);
                return 0;
            }
        }
    }
    
    for (const lib of libraries) {
        if (lib.rules && !evaluateRules(lib.rules)) continue;
        
        let nativePath = null;
        
        if (lib.natives) {
            const nativeKey = lib.natives[currentPlatform];
            if (!nativeKey) continue;
            
            const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
            const nativeDownload = lib.downloads?.classifiers?.[classifier];
            if (!nativeDownload) continue;
            
            nativePath = findNativeJar(nativeDownload.path);
        } else if (lib.name && lib.name.includes(':natives-')) {
            const nameParts = lib.name.split(':');
            const nativeSuffix = nameParts[nameParts.length - 1];
            
            if (!nativeSuffix.startsWith('natives-')) continue;
            
            const platformNative = nativeSuffix.replace('natives-', '');
            
            let isValidPlatform = false;
            if (process.arch === 'x64') {
                isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
            } else if (process.arch === 'ia32') {
                isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
            } else if (process.arch === 'arm64') {
                isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
            }
            
            if (!isValidPlatform) continue;
            
            if (lib.downloads?.artifact?.path) {
                nativePath = findNativeJar(lib.downloads.artifact.path);
            }
            if (!nativePath && lib.name) {
                const nparts = lib.name.split(':');
                if (nparts.length >= 4) {
                    const ngroupPath = nparts[0].replace(/\./g, path.sep);
                    const nname = nparts[1];
                    const nver = nparts[2];
                    const nclassifier = nparts[3];
                    const njarName = `${nname}-${nver}-${nclassifier}.jar`;
                    nativePath = findNativeJar(`${ngroupPath}${path.sep}${nname}${path.sep}${nver}${path.sep}${njarName}`);
                } else if (nparts.length >= 3) {
                    const ngroupPath = nparts[0].replace(/\./g, path.sep);
                    const nname = nparts[1];
                    const nver = nparts[2];
                    const njarName = `${nname}-${nver}.jar`;
                    nativePath = findNativeJar(`${ngroupPath}${path.sep}${nname}${path.sep}${nver}${path.sep}${njarName}`);
                }
            }
        }
        
        if (!nativePath || !fs.existsSync(nativePath)) continue;

        console.log(`[Natives] 提取: ${path.basename(nativePath)}`);
        extractNativeJar(nativePath);
    }

    const extractedFiles = fs.existsSync(nativesDir) ? fs.readdirSync(nativesDir) : [];
    console.log(`[Natives] 提取完成，共 ${extractedFiles.length} 个文件: ${extractedFiles.join(', ')}`);
    
    return nativesDir;
}

function hasGarbageCollectorArg(args) {
    const gcPatterns = [
        /-XX:\+Use[A-Z]\w*GC/,
        /-XX:-Use[A-Z]\w*GC/,
        /-XX:\+Use.*Collector/,
        /-XX:-Use.*Collector/
    ];
    return args.some(arg => gcPatterns.some(pattern => pattern.test(arg)));
}

const SKIN_BACKUP_DIR = path.join(DATA_DIR, 'skin-backups');

function injectOfflineSkin(versionJson, account, assetsRoot) {
    const backups = [];
    try {
        if (!account || account.type !== 'offline' || !account.skinFile) return backups;
        const skinPath = path.join(__dirname, 'img', account.skinFile);
        if (!fs.existsSync(skinPath)) return backups;
        const skinBuf = fs.readFileSync(skinPath);
        if (!skinBuf || skinBuf.length < 64) return backups;

        if (!assetsRoot) assetsRoot = ASSETS_DIR;

        const skinModel = account.skinModel || 'default';
        const targetName = skinModel === 'slim' ? 'alex' : 'steve';
        const targetPath = `minecraft/textures/entity/${targetName}.png`;

        if (!fs.existsSync(SKIN_BACKUP_DIR)) fs.mkdirSync(SKIN_BACKUP_DIR, { recursive: true });

        const assetIndexId = versionJson.assetIndex?.id;
        if (assetIndexId) {
            const indexPath = path.join(ASSETS_DIR, 'indexes', `${assetIndexId}.json`);
            if (fs.existsSync(indexPath)) {
                const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
                const obj = indexData.objects?.[targetPath];
                if (obj && obj.hash) {
                    const hash = obj.hash;
                    const subDir = hash.substring(0, 2);
                    const objectPath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                    if (fs.existsSync(objectPath)) {
                        const backupName = `${assetIndexId}_${hash}`;
                        const backupPath = path.join(SKIN_BACKUP_DIR, backupName);
                        if (!fs.existsSync(backupPath)) {
                            fs.copyFileSync(objectPath, backupPath);
                        }
                        fs.copyFileSync(skinPath, objectPath);
                        backups.push({ type: 'object', path: objectPath, backup: backupPath });
                        console.log(`[Skin] 已注入 ${targetName}.png -> objects/${subDir}/${hash}`);
                    }
                }
                const altTarget = skinModel === 'slim' ? 'steve' : 'alex';
                const altPath = `minecraft/textures/entity/${altTarget}.png`;
                const altObj = indexData.objects?.[altPath];
                if (altObj && altObj.hash) {
                    const altHash = altObj.hash;
                    const altSub = altHash.substring(0, 2);
                    const altObjectPath = path.join(ASSETS_DIR, 'objects', altSub, altHash);
                    if (fs.existsSync(altObjectPath)) {
                        const altBackupName = `${assetIndexId}_${altHash}`;
                        const altBackupPath = path.join(SKIN_BACKUP_DIR, altBackupName);
                        if (!fs.existsSync(altBackupPath)) {
                            fs.copyFileSync(altObjectPath, altBackupPath);
                        }
                        backups.push({ type: 'object_no_replace', path: altObjectPath, backup: altBackupPath });
                    }
                }
            }
        }

        const virtualTargets = [
            path.join(assetsRoot, 'virtual', 'legacy', targetPath),
            path.join(ASSETS_DIR, 'virtual', 'legacy', targetPath)
        ];
        for (const vPath of virtualTargets) {
            if (fs.existsSync(vPath)) {
                const vBackup = path.join(SKIN_BACKUP_DIR, `virtual_${path.basename(vPath)}_${Date.now()}`);
                fs.copyFileSync(vPath, vBackup);
                fs.copyFileSync(skinPath, vPath);
                backups.push({ type: 'virtual', path: vPath, backup: vBackup });
                console.log(`[Skin] 已注入 virtual ${targetName}.png`);
            }
        }

        const gameDirTargets = [
            path.join(account.gameDir || '', 'resources', targetPath),
        ];
        for (const gPath of gameDirTargets) {
            const gDir = path.dirname(gPath);
            if (fs.existsSync(path.dirname(gDir))) {
                if (!fs.existsSync(gDir)) fs.mkdirSync(gDir, { recursive: true });
                if (fs.existsSync(gPath)) {
                    const gBackup = path.join(SKIN_BACKUP_DIR, `gamedir_${path.basename(gPath)}_${Date.now()}`);
                    fs.copyFileSync(gPath, gBackup);
                    backups.push({ type: 'gamedir', path: gPath, backup: gBackup });
                }
                fs.copyFileSync(skinPath, gPath);
                backups.push({ type: 'gamedir_inject', path: gPath, backup: null });
                console.log(`[Skin] 已注入 gamedir ${targetName}.png`);
            }
        }
    } catch (e) {
        console.error('[Skin] 注入失败:', e.message);
    }
    return backups;
}

function restoreOfflineSkin(backups) {
    if (!backups || backups.length === 0) return;
    for (const b of backups) {
        try {
            if (b.type === 'object_no_replace') continue;
            if (b.backup && fs.existsSync(b.backup)) {
                fs.copyFileSync(b.backup, b.path);
            }
        } catch (e) {
            console.error('[Skin] 恢复失败:', b.path, e.message);
        }
    }
}

function buildLaunchArguments(versionJson, settings, account, versionId, customGameDir = null, externalVersionDir = null) {
    const actualVersionId = versionId || versionJson.id || 'unknown';
    const isExternal = !!externalVersionDir;
    let externalRoot = null;
    if (isExternal) {
        externalRoot = findExternalRoot(externalVersionDir);
        if (!externalRoot) {
            externalRoot = path.dirname(path.dirname(externalVersionDir));
        }
    }
    
    const classpath = buildClasspath(versionJson, actualVersionId, externalVersionDir);
    const nativesDir = extractNatives(versionJson, actualVersionId, externalVersionDir);

    let gameDir;
    if (customGameDir) {
        gameDir = customGameDir;
    } else if (externalVersionDir) {
        gameDir = externalVersionDir;
    } else {
        if (resolveVersionIsolation(actualVersionId)) {
            gameDir = path.join(VERSIONS_DIR, actualVersionId);
        } else {
            gameDir = settings.gameDir || DATA_DIR;
        }
    }
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir, { recursive: true });
    const subDirs = ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports'];
    subDirs.forEach(d => {
        const p = path.join(gameDir, d);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });

    let assetsRoot = isExternal && externalRoot ? path.join(externalRoot, 'assets') : ASSETS_DIR;
    const assetIndex = versionJson.assetIndex?.id || actualVersionId;
    if (versionJson.assetIndex?.virtual) {
        const virtualDir = path.join(assetsRoot, 'virtual', 'legacy');
        if (fs.existsSync(virtualDir)) {
            assetsRoot = virtualDir;
        }
    }
    const playerName = account?.username || 'Player';
    let uuid = account?.uuid;
    if (!uuid) {
        const md5 = crypto.createHash('md5').update('OfflinePlayer:' + playerName).digest();
        md5[6] = (md5[6] & 0x0f) | 0x30;
        md5[8] = (md5[8] & 0x3f) | 0x80;
        uuid = md5.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    }
    // 离线账户使用兼容格式的伪令牌，避免自定义 BootstrapLauncher 的 Base64 解析崩溃
    // 某些整合包（如 YUMC 系）的定制 BootstrapLauncher 会尝试 Base64 解码 accessToken
    const rawAccessToken = account?.accessToken || '';
    let accessToken;
    if (!rawAccessToken || rawAccessToken === '0') {
        // 生成一个合法的 Base64 编码字符串作为离线令牌
        // 格式: base64({"alg":"none","typ":"JWT"}.{"sub":"<uuid>","iss":"VersePC"}.offline)
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            sub: uuid,
            iss: 'VersePC',
            name: playerName,
            offline: true
        })).toString('base64url');
        accessToken = `${header}.${payload}.offline`;
    } else {
        accessToken = rawAccessToken;
    }
    const userType = account?.type === 'microsoft' ? 'msa' : (account?.type === 'legacy' ? 'legacy' : 'mojang');

    const mainJarPath = findMainJar(versionJson, actualVersionId, externalVersionDir) || path.join(VERSIONS_DIR, actualVersionId, actualVersionId + '.jar');

    const variables = {
        auth_player_name: playerName,
        version_name: actualVersionId,
        game_directory: gameDir,
        assets_root: assetsRoot,
        assets_index_name: assetIndex,
        auth_uuid: uuid,
        auth_access_token: accessToken,
        user_type: userType,
        version_type: `VersePC - ${actualVersionId}`,
        resolution_width: settings.resolution?.split('x')[0] || '854',
        resolution_height: settings.resolution?.split('x')[1] || '480',
        library_directory: isExternal && externalRoot ? path.join(externalRoot, 'libraries') : LIBRARIES_DIR,
        classpath_separator: process.platform === 'win32' ? ';' : ':',
        natives_directory: nativesDir,
        launcher_name: 'VersePC',
        launcher_version: '1.0.0',
        classpath: classpath,
        clientid: uuid,
        auth_xuid: uuid,
        quickPlayPath: path.join(gameDir, 'quickPlay'),
        quickPlaySingleplayer: '',
        quickPlayMultiplayer: '',
        quickPlayRealms: ''
    };

    const jvmArgs = [];

    let maxMemMB = settings.maxMemory || 4096;
    try {
        const storePath = path.join(require('os').homedir(), '.versepc', 'app-store.json');
        if (fs.existsSync(storePath)) {
            const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            const launchStr = store['versepc_launch_settings'];
            if (launchStr) {
                const launchSettings = JSON.parse(launchStr);
                const memMode = launchSettings.memoryMode || 'auto';
                if (memMode === 'auto') {
                    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
                    const freeMB = Math.floor(os.freemem() / 1024 / 1024);
                    let autoMB;
                    if (totalMB <= 4096) autoMB = Math.min(1024, totalMB - 1024);
                    else if (totalMB <= 8192) autoMB = Math.floor(totalMB * 0.55);
                    else if (totalMB <= 16384) autoMB = Math.floor(totalMB * 0.6);
                    else autoMB = Math.floor(totalMB * 0.65);
                    if (freeMB < 1024 && totalMB > 4096) autoMB = Math.min(autoMB, freeMB + 512);
                    autoMB = Math.max(512, Math.min(autoMB, totalMB - 1536));
                    autoMB = Math.max(autoMB, 512);
                    autoMB = Math.min(autoMB, 32768);
                    autoMB = Math.floor(autoMB / 256) * 256;
                    maxMemMB = autoMB;
                } else if (memMode === 'custom') {
                    maxMemMB = parseInt(launchSettings.memoryValue, 10) || 4096;
                }
            }
        }
    } catch (e) {}
    const minMemMB = Math.min(1024, maxMemMB);
    jvmArgs.push(`-Xmx${maxMemMB}M`, `-Xms${minMemMB}M`);

    const hasUserGc = jvmArgs.some(a => /^-XX:\+?Use/.test(a) || /-XX:Use/.test(a));
    if (!hasUserGc) {
        const javaMajorVer = getJavaMajorVersion(selectJavaForVersion(actualVersionId, settings, versionJson) || 'java');
        let modCount = 0;
        try {
            const versionDir = path.join(VERSIONS_DIR, actualVersionId || versionId);
            const modsDir = path.join(versionDir, 'mods');
            if (fs.existsSync(modsDir)) {
                modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') && !f.endsWith('.jar.disabled')).length;
            }
        } catch(e) {}

        if (maxMemMB >= 8192 && javaMajorVer >= 21) {
            jvmArgs.push('-XX:+UseZGC', '-XX:+ZGenerational', '-XX:SoftMaxHeapSize=' + Math.floor(maxMemMB * 0.75) + 'M');
            if (modCount > 100) {
                jvmArgs.push('-XX:ZAllocationSpikeTolerance=2');
            }
        } else if (maxMemMB >= 4096 && javaMajorVer >= 15 && modCount > 80) {
            jvmArgs.push('-XX:+UseShenandoahGC', '-XX:ShenandoahGCHeuristics=compact');
        } else if (maxMemMB <= 1024) {
            jvmArgs.push('-XX:+UseSerialGC');
        } else {
            jvmArgs.push('-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200');
            if (maxMemMB >= 4096) {
                jvmArgs.push('-XX:G1HeapRegionSize=' + (maxMemMB >= 8192 ? '32m' : '16m'));
            }
            if (modCount > 50) {
                jvmArgs.push('-XX:G1MixedGCCountTarget=16', '-XX:G1HeapWastePercent=5');
            }
        }
        jvmArgs.push('-XX:+DisableExplicitGC');
    }
    const hasUserMemOpt = jvmArgs.some(a => a.includes('StringDeduplication') || a.includes('CompressedClassSpaceSize') || a.includes('MetaspaceSize'));
    if (!hasUserMemOpt && maxMemMB >= 2048) {
        jvmArgs.push('-XX:+UseStringDeduplication', '-XX:CompressedClassSpaceSize=256m', '-XX:MaxMetaspaceSize=512m');
    }

    if (settings.javaArgs && settings.javaArgs.trim()) {
        const userArgs = settings.javaArgs.split(' ').filter(a => a);
        for (const arg of userArgs) {
            const baseArg = arg.split('=')[0];
            const hasConflict = jvmArgs.some(existing => existing.startsWith(baseArg));
            const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
            const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(arg));
            let hasGcConflict = false;
            if (isGcArg) {
                hasGcConflict = jvmArgs.some(existing =>
                    gcPatterns.some(p => new RegExp(`^${p}`).test(existing))
                );
                if (hasGcConflict) continue;
            }
            if (!hasConflict) jvmArgs.push(arg);
        }
    }

    const cdsDir = path.join(DATA_DIR, 'cds');
    const cdsArchive = path.join(cdsDir, `${actualVersionId || versionId}.jsa`);
    const cdsClassList = path.join(cdsDir, `${actualVersionId || versionId}.cls`);
    const selectedJavaPath = selectJavaForVersion(actualVersionId, settings, versionJson) || 'java';
    const javaMajorVer = getJavaMajorVersion(selectedJavaPath);
    const enableCds = settings.enableCds !== false && javaMajorVer >= 8;

    if (enableCds && fs.existsSync(cdsArchive)) {
        try {
            const stat = fs.statSync(cdsArchive);
            if (stat.size > 1024) {
                jvmArgs.push(`-Xshare:on`, `-XX:SharedArchiveFile=${cdsArchive}`);
                console.log(`[CDS] 使用共享归档: ${cdsArchive} (${Math.round(stat.size/1024)}KB)`);
            }
        } catch (e) {
            console.log(`[CDS] 归档文件不可用: ${e.message}`);
        }
    }

    const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';
    const gameArgsForDetection = versionJson.arguments?.game || [];
    const hasForgeGameArg = gameArgsForDetection.some(a => typeof a === 'string' && a === 'forgeclient') ||
                             gameArgsForDetection.some(a => typeof a === 'string' && a === 'forge_server');
    const isForge = mainClass.includes('modlauncher') || mainClass.includes('fml') || mainClass.includes('forge') ||
                    mainClass.includes('bootstraplauncher') || mainClass.includes('BootstrapLauncher') ||
                    hasForgeGameArg;
    const isNeoForge = mainClass.includes('neoforged') || mainClass.includes('neoforge') ||
                       gameArgsForDetection.some(a => typeof a === 'string' && a === '--fml.neoForgeVersion') ||
                       (versionJson.libraries || []).some(l => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader'));
    const isFabric = mainClass.includes('fabricmc') || mainClass.includes('knot');

    // 离线账户禁用 Realms/Microsoft API 认证，避免 "Failed to parse into SignedJWT" 错误
    const isOfflineAccount = !rawAccessToken || rawAccessToken === '0' || account?.type === 'offline';
    if (isOfflineAccount) {
        jvmArgs.push('-Dminecraft.api.auth=off', '-Dminecraft.api.env=local');
    }

    if (isForge || isNeoForge) {
        jvmArgs.push(`-Dminecraft.client.jar=${mainJarPath}`);
        jvmArgs.push('-Dfml.ignoreInvalidMinecraftCertificates=true');
        jvmArgs.push('-Dfml.ignorePatchDiscrepancies=true');
        // Forge/NeoForge 必需的日志和兼容性属性（防止自定义 BootstrapLauncher 的 NoSuchElementException）
        if (!jvmArgs.some(a => a.includes('forge.logging.console.level'))) {
            jvmArgs.push('-Dforge.logging.console.level=info');
        }
        if (!jvmArgs.some(a => a.includes('forge.enableLoginPrompt'))) {
            jvmArgs.push('-Dforge.enableLoginPrompt=false');
        }
    }
    if (isNeoForge) {
        jvmArgs.push('-Dfml.earlyprogresswindow=false');
    }

    if (isForge || isNeoForge) {
        const jpmsFlags = [
            '--add-exports java.base/sun.security.util=ALL-UNNAMED',
            '--add-exports java.base/sun.security.x509=ALL-UNNAMED',
            '--add-opens java.base/java.lang=ALL-UNNAMED',
            '--add-opens java.base/java.lang.invoke=ALL-UNNAMED',
            '--add-opens java.base/java.lang.reflect=ALL-UNNAMED',
            '--add-opens java.base/java.io=ALL-UNNAMED',
            '--add-opens java.base/java.nio=ALL-UNNAMED',
            '--add-opens java.base/java.util=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent.atomic=ALL-UNNAMED',
            '--add-opens java.base/java.util.concurrent.locks=ALL-UNNAMED',
            '--add-opens java.base/sun.nio.ch=ALL-UNNAMED',
            '--add-opens java.base/sun.nio.fs=ALL-UNNAMED',
            '--add-opens java.base/sun.security.action=ALL-UNNAMED',
            '--add-opens java.base/sun.security.provider=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.loader=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.ref=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.reflect=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.math=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.misc=ALL-UNNAMED',
            '--add-opens java.base/jdk.internal.util=ALL-UNNAMED',
            '--add-opens java.management/sun.management=ALL-UNNAMED',
            '--add-opens java.management/com.sun.jmx.mbeanserver=ALL-UNNAMED',
            '--add-opens jdk.management/com.sun.management.internal=ALL-UNNAMED',
            '--add-opens java.rmi/sun.rmi.registry=ALL-UNNAMED',
            '--add-opens java.rmi/sun.rmi.server=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt.font=ALL-UNNAMED',
            '--add-opens java.desktop/java.awt.peer=ALL-UNNAMED',
            '--add-opens java.desktop/javax.swing=ALL-UNNAMED',
            '--add-opens java.desktop/sun.awt=ALL-UNNAMED',
            '--add-opens java.desktop/sun.java2d=ALL-UNNAMED',
            '--add-opens java.desktop/sun.font=ALL-UNNAMED',
            '--add-opens jdk.unsupported/sun.misc=ALL-UNNAMED'
        ];
        for (const combined of jpmsFlags) {
            const spaceIdx = combined.indexOf(' ');
            const flag = combined.substring(0, spaceIdx);
            const value = combined.substring(spaceIdx + 1);
            if (!jvmArgs.some((a, idx) => a === flag && jvmArgs[idx + 1] === value)) {
                jvmArgs.push(flag, value);
            }
        }
    }

    // PCL2-style: Collect JVM args from standard `jvm` and Fabric/NeoForge non-standard groups (`default-user-jvm`, etc.)
    const jvmArgSources = [];
    if (versionJson.arguments?.jvm) jvmArgSources.push(...versionJson.arguments.jvm);
    // Fabric meta API v2 uses "default-user-jvm" group
    if (versionJson.arguments?.['default-user-jvm']) jvmArgSources.push(...versionJson.arguments['default-user-jvm']);
    if (jvmArgSources.length > 0) {
        for (let i = 0; i < jvmArgSources.length; i++) {
            const arg = jvmArgSources[i];
            if (typeof arg === 'string') {
                const replaced = replaceVariables(arg, variables);
                // 跳过 -cp 和 classpath 字符串，始终使用我们自己的完整 classpath
                // Forge JSON 自带的 classpath 只有引导 JAR，不含所有库，会导致 ModuleLayer 启动失败
                if (replaced === '-cp') {
                    continue;
                }
                // 如果上一个被跳过的参数是 -cp，这个字符串就是 classpath 值，也跳过
                if (i > 0 && typeof jvmArgSources[i - 1] === 'string' && replaceVariables(jvmArgSources[i - 1], variables) === '-cp') {
                    continue;
                }
                const isMultiValueFlag = replaced === '--add-opens' || replaced === '--add-exports' ||
                    replaced === '--add-reads' || replaced === '--add-modules' ||
                    replaced === '--patch-module' || replaced === '-javaagent';
                if (isMultiValueFlag) {
                    jvmArgs.push(replaced);
                    if (i + 1 < jvmArgSources.length && typeof jvmArgSources[i + 1] === 'string') {
                        const nextReplaced = replaceVariables(jvmArgSources[i + 1], variables);
                        jvmArgs.push(nextReplaced);
                        i++;
                    }
                } else {
                    const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                    const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                    if (isGcArg && hasGarbageCollectorArg(jvmArgs)) {
                        console.log(`[Launch] 跳过重复GC参数: ${replaced}`);
                        continue;
                    }
                    if (replaced.startsWith('-Xmx') || replaced.startsWith('-Xms')) {
                        if (!jvmArgs.some(e => e.startsWith(replaced.substring(0, 4)))) {
                            jvmArgs.push(replaced);
                        }
                    } else if (!jvmArgs.some(existing => existing === replaced)) {
                        jvmArgs.push(replaced);
                    }
                }
            } else if (arg && (arg.value !== undefined)) {
                const rulesMatch = !arg.rules || evaluateRules(arg.rules, { hasCustomResolution: !!settings.resolution });
                if (rulesMatch) {
                    if (typeof arg.value === 'string') {
                        const replaced = replaceVariables(arg.value, variables);
                        const isMultiValueFlag = replaced === '--add-opens' || replaced === '--add-exports' ||
                            replaced === '--add-reads' || replaced === '--add-modules' ||
                            replaced === '--patch-module' || replaced === '-javaagent';
                        if (isMultiValueFlag) {
                            jvmArgs.push(replaced);
                        } else {
                            const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                            const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                            if (isGcArg && hasGarbageCollectorArg(jvmArgs)) continue;
                            if (!jvmArgs.some(existing => existing === replaced)) {
                                jvmArgs.push(replaced);
                            }
                        }
                    } else if (Array.isArray(arg.value)) {
                        for (const v of arg.value) {
                            const replaced = replaceVariables(String(v), variables);
                            const isMultiValueFlag = replaced === '--add-opens' || replaced === '--add-exports' ||
                                replaced === '--add-reads' || replaced === '--add-modules' ||
                                replaced === '--patch-module' || replaced === '-javaagent';
                            if (isMultiValueFlag) {
                                jvmArgs.push(replaced);
                            } else {
                                const gcPatterns = ['-XX:\\+Use', '-XX:-Use'];
                                const isGcArg = gcPatterns.some(p => new RegExp(`^${p}`).test(replaced));
                                if (isGcArg && hasGarbageCollectorArg(jvmArgs)) continue;
                                if (!jvmArgs.some(existing => existing === replaced)) {
                                    jvmArgs.push(replaced);
                                }
                            }
                        }
                    }
                }
            }
        }
    // NeoForge: 扩展 ignoreList，防止 ModLauncher 扫描 universal JAR（含 neoforge.mods.toml），
    // 让 ServiceLoader 的 IBindingsProvider 机制正确注册 neoforge 模组
    if (isNeoForge) {
        const ignoreIdx = jvmArgs.findIndex(a => typeof a === 'string' && a.startsWith('-DignoreList='));
        if (ignoreIdx >= 0) {
            const neoIgnoreAdditions = 'neoforge-,bootstraplauncher,securejarhandler,asm-commons,asm-util,asm-analysis,asm-tree,asm,JarJarFileSystems';
            const existing = jvmArgs[ignoreIdx];
            if (!existing.includes('neoforge-')) {
                jvmArgs[ignoreIdx] = existing + ',' + neoIgnoreAdditions;
                console.log(`[Launch] NeoForge: 扩展ignoreList`);
            }
        }
    }

    } else {
        if (!jvmArgs.some(a => a.includes('java.library.path') || a.includes('natives_directory'))) {
            jvmArgs.push(`-Djava.library.path=${nativesDir}`);
        }
        if (!jvmArgs.some(a => a.includes('minecraft.launcher.brand'))) {
            jvmArgs.push('-Dminecraft.launcher.brand=VersePC');
            jvmArgs.push('-Dminecraft.launcher.version=1.0.0');
        }
        if (!jvmArgs.some(a => a.includes('log4j2.formatMsgNoLookups'))) {
            jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
        }
    }

    // 始终使用我们自己的完整 classpath（用系统分隔符 join），跳过 JSON 自带的残缺 classpath
    const cpSeparator = process.platform === 'win32' ? ';' : ':';
    const classpathStr = Array.isArray(classpath) ? classpath.join(cpSeparator) : classpath;
    jvmArgs.push('-cp', classpathStr);

    if (account?.type === 'thirdparty' && account?.serverUrl) {
        const aiDir3 = path.join(DATA_DIR, 'authlib-injector');
        const aiFiles2 = fs.existsSync(aiDir3) ? fs.readdirSync(aiDir3).filter(f => f.endsWith('.jar')).sort() : [];
        if (aiFiles2.length > 0) {
            const aiJarPath = path.join(aiDir3, aiFiles2[aiFiles2.length - 1]);
            let serverUrlArg = account.serverUrl;
            if (serverUrlArg.includes('@@@') || serverUrlArg.includes('@@')) {
                serverUrlArg = serverUrlArg.split('@@@')[0].split('@@')[0];
                console.log(`[Launch] Cleaned serverUrl: ${account.serverUrl} -> ${serverUrlArg}`);
            }
            const javaAgentIdx = jvmArgs.findIndex(a => a.startsWith('-javaagent:'));
            if (javaAgentIdx === -1) {
                jvmArgs.unshift(`-javaagent:${aiJarPath}=${serverUrlArg}`);
            }
            console.log(`[Launch] authlib-injector: ${aiJarPath} -> ${serverUrlArg}`);
        } else {
            console.log('[Launch] authlib-injector not found');
        }
    }

    if (versionJson.logging?.client?.argument && versionJson.logging?.client?.file?.id) {
        const logConfigPath = path.join(VERSIONS_DIR, actualVersionId, versionJson.logging.client.file.id);
        if (!fs.existsSync(logConfigPath)) {
            const logDir = path.join(VERSIONS_DIR, actualVersionId);
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            if (versionJson.logging.client.file.url) {
                try {
                    downloadFileSync(versionJson.logging.client.file.url, logConfigPath);
                } catch (e) {
                    console.error('[Launch] log4j config download failed:', e.message);
                }
            }
        }
        if (fs.existsSync(logConfigPath)) {
            const logArg = versionJson.logging.client.argument
                .replace(/\$\{path\}/g, logConfigPath);
            if (!jvmArgs.some(a => a.includes('log4j2') || a.includes('Log4j') || a.includes('log4j.configurationFile'))) {
                jvmArgs.push(logArg);
            }
        }
    }

    jvmArgs.push(mainClass);

    const gameArgs = [];

    // PCL2-style: Collect game args from standard `game` and Fabric/NeoForge non-standard groups (`default-user-game`, etc.)
    const gameArgSources = [];
    if (versionJson.arguments?.game) gameArgSources.push(...versionJson.arguments.game);
    // Fabric meta API v2 uses "default-user-game" group
    if (versionJson.arguments?.['default-user-game']) gameArgSources.push(...versionJson.arguments['default-user-game']);
    if (gameArgSources.length > 0) {
        for (const arg of gameArgSources) {
            if (typeof arg === 'string') {
                gameArgs.push(replaceVariables(arg, variables));
            } else if (arg && (arg.value !== undefined)) {
                const rulesMatch = !arg.rules || evaluateRules(arg.rules, { hasCustomResolution: !!settings.resolution });
                if (rulesMatch) {
                    if (typeof arg.value === 'string') {
                        gameArgs.push(replaceVariables(arg.value, variables));
                    } else if (Array.isArray(arg.value)) {
                        gameArgs.push(...arg.value.map(v => replaceVariables(String(v), variables)));
                    }
                }
            }
        }
    }

    if (versionJson.minecraftArguments) {
        const template = versionJson.minecraftArguments;
        gameArgs.push(...replaceVariables(template, variables).split(' ').filter(a => a));
    }

    if (settings.fullscreen) {
        gameArgs.push('--fullscreen');
    } else {
        const resW = settings.resolution?.split('x')[0] || '854';
        const resH = settings.resolution?.split('x')[1] || '480';
        if (!gameArgs.some(a => a === '--width')) gameArgs.push('--width', resW);
        if (!gameArgs.some(a => a === '--height')) gameArgs.push('--height', resH);
    }

    let versionTypeIdx = gameArgs.indexOf('--versionType');
    if (versionTypeIdx === -1) {
        const ci = (settings.customInfo || '').trim();
        if (ci) {
            gameArgs.push('--versionType', ci);
        }
    }

    const finalGameArgs = deduplicateGameArgs(gameArgs);

    console.log(`[Launch] Args built: ${jvmArgs.length} JVM, ${finalGameArgs.length} game (${gameArgs.length - finalGameArgs.length} duplicates removed)`);
    console.log(`[Launch] mainClass: ${mainClass}`);
    console.log(`[Launch] classpath len: ${classpath.length}`);
    console.log(`[Launch] gameDir: ${gameDir}`);
    console.log(`[Launch] nativesDir: ${nativesDir}`);
    console.log(`[Launch] loader: ${isForge ? 'Forge' : isNeoForge ? 'NeoForge' : isFabric ? 'Fabric' : 'Vanilla'}`);
    return [...jvmArgs, ...finalGameArgs];
}

function setGameLanguage(gameDir, versionJson, settings) {
    if (!settings.autoSetChinese) {
        console.log('[Language] 自动设置中文已关闭，跳过语言设置');
        return;
    }

    let optionsPath = path.join(gameDir, 'options.txt');

    if (!fs.existsSync(optionsPath)) {
        const yosbrPath = path.join(gameDir, 'config', 'yosbr', 'options.txt');
        if (fs.existsSync(yosbrPath)) {
            console.log('[Language] 使用 Yosbr Mod 中的 options.txt');
            optionsPath = yosbrPath;
        } else {
            console.log('[Language] options.txt 不存在，将创建新文件');
        }
    }

    const releaseTime = versionJson.releaseTime || versionJson.time || '';
    let releaseDate = new Date(0);
    if (releaseTime) {
        try { releaseDate = new Date(releaseTime); } catch (e) {}
    }

    const mc1_1_date = new Date('2012-01-12');
    const mc1_11_date = new Date('2016-06-08');
    const mc1_13_date = new Date('2017-09-18');

    let requiredLang = 'zh_cn';

    if (releaseDate > new Date(0) && releaseDate <= mc1_1_date) {
        console.log('[Language] 1.0 及以下版本，无语言选项');
        return;
    } else if (releaseDate > mc1_1_date && releaseDate <= mc1_11_date) {
        requiredLang = 'zh_CN';
        console.log('[Language] 1.1~1.10 版本，使用 zh_CN 格式');
    } else if (releaseDate > mc1_11_date && releaseDate <= mc1_13_date) {
        requiredLang = 'zh_cn';
        console.log('[Language] 1.11~1.12 版本，使用 zh_cn 格式');
    } else {
        requiredLang = 'zh_cn';
        console.log('[Language] 1.13+ 版本，使用 zh_cn 格式');
    }

    let currentLang = 'none';
    let optionsContent = '';

    if (fs.existsSync(optionsPath)) {
        optionsContent = fs.readFileSync(optionsPath, 'utf-8');
        const langMatch = optionsContent.match(/^lang:(.+)$/m);
        if (langMatch) {
            currentLang = langMatch[1].trim();
        }
    }

    if (currentLang === requiredLang) {
        console.log(`[Language] 当前语言已为 ${requiredLang}，无需修改`);
    } else {
        const hasExistingSaves = fs.existsSync(path.join(gameDir, 'saves'));
        if (currentLang !== 'none' && hasExistingSaves) {
            console.log(`[Language] 已有存档且语言已设置 (${currentLang})，保留用户选择`);
        } else {
            if (optionsContent && currentLang !== 'none') {
                optionsContent = optionsContent.replace(/^lang:.+$/m, `lang:${requiredLang}`);
            } else if (optionsContent) {
                optionsContent += `\nlang:${requiredLang}`;
            } else {
                optionsContent = `lang:${requiredLang}\n`;
            }
            console.log(`[Language] 已将游戏语言设置为 ${requiredLang}`);
        }
    }

    const dir = path.dirname(optionsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(optionsPath, optionsContent, 'utf-8');
}

function applyWindowSettings(gameDir, settings) {
    try {
        let optionsPath = path.join(gameDir, 'options.txt');
        const yosbrPath = path.join(gameDir, 'config', 'yosbr', 'options.txt');
        if (!fs.existsSync(optionsPath) && fs.existsSync(yosbrPath)) {
            optionsPath = yosbrPath;
        }

        let optionsContent = '';
        if (fs.existsSync(optionsPath)) {
            optionsContent = fs.readFileSync(optionsPath, 'utf-8');
        }

        if (!settings.fullscreen) {
            if (optionsContent.match(/^fullscreen:/m)) {
                optionsContent = optionsContent.replace(/^fullscreen:.+$/m, 'fullscreen:false');
            } else if (optionsContent) {
                optionsContent += '\nfullscreen:false';
            } else {
                optionsContent = 'fullscreen:false\n';
            }
            console.log('[Options] 已设置 fullscreen:false (窗口化模式)');
        } else {
            if (optionsContent.match(/^fullscreen:/m)) {
                optionsContent = optionsContent.replace(/^fullscreen:.+$/m, 'fullscreen:true');
            } else if (optionsContent) {
                optionsContent += '\nfullscreen:true';
            } else {
                optionsContent = 'fullscreen:true\n';
            }
            console.log('[Options] 已设置 fullscreen:true (全屏模式)');
        }

        if (settings.resolution) {
            const [w, h] = settings.resolution.split('x');
            if (w && h) {
                if (optionsContent.match(/^overrideWidth:/m)) {
                    optionsContent = optionsContent.replace(/^overrideWidth:.+$/m, `overrideWidth:${w}`);
                } else {
                    optionsContent += `\noverrideWidth:${w}`;
                }
                if (optionsContent.match(/^overrideHeight:/m)) {
                    optionsContent = optionsContent.replace(/^overrideHeight:.+$/m, `overrideHeight:${h}`);
                } else {
                    optionsContent += `\noverrideHeight:${h}`;
                }
                console.log(`[Options] 已设置窗口大小: ${w}x${h}`);
            }
        }

        const dir = path.dirname(optionsPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(optionsPath, optionsContent, 'utf-8');
    } catch (e) {
        console.error('[Options] 写入窗口设置失败:', e.message);
    }
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeReplaceValue(str) {
    return str.replace(/\$/g, '$$$$');
}

function replaceVariables(str, vars) {
    let result = str;
    for (const [key, value] of Object.entries(vars)) {
        const escapedKey = escapeRegExp(key);
        const escapedValue = escapeReplaceValue(String(value));
        result = result.replace(new RegExp(`\\$\\{${escapedKey}\\}`, 'g'), escapedValue);
        result = result.replace(new RegExp(`\\$${escapedKey}(?![a-zA-Z0-9_])`, 'g'), escapedValue);
    }
    return result;
}

// ============================================================================
// 游戏启动核心 - JVM参数构建、Natives提取、进程启动和生命周期管理
// ============================================================================

async function launchGame(versionId, settings, account) {
    try {
    let externalVersionDir = null;
    const cleanVersionId = versionId.replace(' [外部]', '');

    const gameDirToCheck = settings.gameDir || DATA_DIR;
    const problematicChars = /[^\x00-\x7F]/;
    const dirBasename = path.basename(gameDirToCheck);
    if (problematicChars.test(dirBasename)) {
        const badChars = dirBasename.match(problematicChars);
        return { success: false, error: `游戏路径包含特殊字符（${[...new Set(badChars)].join(' ')}），可能导致游戏无法启动，请将游戏移到纯英文路径` };
    }
    const javaPathToCheck = settings.javaPath || '';
    if (javaPathToCheck && problematicChars.test(path.dirname(javaPathToCheck))) {
        return { success: false, error: 'Java路径包含特殊字符或中文，可能导致游戏无法启动，请将Java移到纯英文路径' };
    }

    const externalFolders = loadExternalFolders();
    for (const folder of externalFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const extVersions = scanExternalFolder(folder.path);
        const extVer = extVersions.find(v => v.id === cleanVersionId || v.id === versionId ||
            path.basename(v.externalVersionDir || '') === cleanVersionId ||
            path.basename(v.externalVersionDir || '') === versionId);
        if (extVer) {
            externalVersionDir = extVer.externalVersionDir;
            break;
        }
    }

    console.log(`[LaunchGame] 版本: ${versionId}, 外部目录: ${externalVersionDir || '无'}`);

    const versionJson = resolveVersionJson(cleanVersionId, externalVersionDir);
    if (!versionJson) {
        return { success: false, error: `找不到版本 ${versionId} 的JSON文件`, details: { versionId, externalVersionDir } };
    }

    console.log(`[LaunchGame] JSON已解析, mainClass: ${versionJson.mainClass}, inheritsFrom: ${versionJson.inheritsFrom}`);

    const depCheck = await checkDependencies(cleanVersionId, settings, externalVersionDir);

    const scanLibsRecursive = (verId, visited = new Set()) => {
        if (visited.has(verId)) return [];
        visited.add(verId);
        const jsonPath = path.join(VERSIONS_DIR, verId, `${verId}.json`);
        if (!fs.existsSync(jsonPath)) return [];
        let data;
        try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); } catch (e) { return []; }
        const libs = (data.libraries || []).map(l => {
            if (l.rules && !evaluateRules(l.rules)) return null;
            if (l.natives) return null;
            if (l.downloads?.artifact?.path) {
                return { name: l.name, path: path.join(LIBRARIES_DIR, l.downloads.artifact.path),
                    url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1,
                    size: l.downloads.artifact.size, maven: null };
            }
            if (l.name) {
                const p = l.name.split(':');
                if (p.length >= 3) {
                    const gp = p[0].replace(/\./g, path.sep);
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    return { name: l.name, path: path.join(LIBRARIES_DIR, gp, p[1], p[2], jn),
                        url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
                }
            }
            return null;
        }).filter(Boolean);

        const parentLibs = data.inheritsFrom ? scanLibsRecursive(data.inheritsFrom, visited) : [];
        return [...libs, ...parentLibs];
    };

    const allChainLibs = scanLibsRecursive(cleanVersionId);
    const extraMissing = [];
    for (const lib of allChainLibs) {
        if (!fs.existsSync(lib.path)) {
            let dlUrl = lib.url;
            if (!dlUrl && lib.maven) {
                const { group, artifact, version, classifier } = lib.maven;
                const mg = group.replace(/\./g, '/');
                const cl = classifier ? `-${classifier}` : '';
                const jn = `${artifact}-${version}${cl}.jar`;
                const base = (group.includes('forge') || group.includes('neoforged'))
                    ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/';
                dlUrl = `${base}${mg}/${artifact}/${version}/${jn}`;
            }
            if (dlUrl) {
                extraMissing.push({ type: 'library', url: dlUrl, path: lib.path, sha1: lib.sha1, size: lib.size, name: lib.name || path.basename(lib.path) });
            }
        }
    }

    if (extraMissing.length > 0) {
        console.log(`[Launch] 二次扫描发现 ${extraMissing.length} 个额外缺失库: ${extraMissing.map(f=>f.name).join(', ')}`);
        depCheck.missingFiles = [...depCheck.missingFiles.filter(f => f.type !== 'library'), ...extraMissing];
        depCheck.libraries.missing = extraMissing;
        depCheck.libraries.ok = false;
        depCheck.libraries.message = `二次扫描: ${extraMissing.length} 个库文件缺失`;
    }

    if (!depCheck.java.ok) {
        return { success: false, error: depCheck.java.message, needDownload: false, depCheck };
    }

    if (!depCheck.versionJson.ok) {
        return { success: false, error: depCheck.versionJson.message, needDownload: false, depCheck };
    }

    if (!depCheck.parentVersion.ok) {
        return { success: false, error: depCheck.parentVersion.message, needDownload: true, depCheck };
    }

    if (!depCheck.forgeCore.ok) {
        const forgeMissing = (depCheck.forgeCore.missing || [])
            .map(m => `  - ${m.desc}: ${path.basename(m.path)}`)
            .join('\n');
        console.warn(`[LaunchGame] Forge核心库缺失 (${depCheck.forgeCore.missing.length}个)，尝试自动修复...`);

        let forgeRepaired = false;
        for (const chainId of [cleanVersionId, versionJson.inheritsFrom].filter(Boolean)) {
            if (forgeRepaired) break;
            if (!chainId.toLowerCase().includes('forge')) continue;
            const forgeJsonPath = path.join(VERSIONS_DIR, chainId, `${chainId}.json`);
            if (!fs.existsSync(forgeJsonPath)) continue;
            try {
                const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf-8'));
                const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
                if (!forgeMatch) continue;
                const mcVer = forgeMatch[1];
                const forgeVer = forgeMatch[2];
                console.log(`[LaunchGame] 尝试重新安装Forge ${mcVer}-${forgeVer}来修复核心文件`);
                const repairResult = await installForge(mcVer, forgeVer, (p, msg) => {
                    console.log(`[LaunchGame] 修复进度: ${Math.round(p * 100)}% - ${msg || ''}`);
                });
                if (repairResult.success) {
                    const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                    if (stillMissing.length === 0) {
                        console.log(`[LaunchGame] Forge核心文件自动修复成功!`);
                        forgeRepaired = true;
                    } else {
                        console.warn(`[LaunchGame] 修复后仍有 ${stillMissing.length} 个文件缺失`);
                    }
                } else {
                    console.warn(`[LaunchGame] Forge自动修复失败: ${repairResult.error}`);
                }
            } catch (repairErr) {
                console.warn(`[LaunchGame] Forge自动修复异常: ${repairErr.message}`);
            }
        }

        if (!forgeRepaired) {
            const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
            if (fs.existsSync(altMinecraftDir)) {
                let altCopied = 0;
                for (const m of (depCheck.forgeCore.missing || [])) {
                    if (fs.existsSync(m.path)) continue;
                    const relPath = path.relative(LIBRARIES_DIR, m.path).replace(/\\/g, '/');
                    const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
                    if (fs.existsSync(altLibPath)) {
                        try {
                            if (!fs.existsSync(path.dirname(m.path))) fs.mkdirSync(path.dirname(m.path), { recursive: true });
                            fs.copyFileSync(altLibPath, m.path);
                            if (fs.existsSync(m.path) && (!m.path.endsWith('.jar') || isJarIntact(m.path))) {
                                altCopied++;
                            } else {
                                try { fs.unlinkSync(m.path); } catch (_) {}
                            }
                        } catch (_) {}
                    }
                }
                if (altCopied > 0) {
                    const stillMissing = (depCheck.forgeCore.missing || []).filter(m => !fs.existsSync(m.path));
                    if (stillMissing.length === 0) {
                        console.log(`[LaunchGame] 从.minecraft复制修复成功!`);
                        forgeRepaired = true;
                    }
                }
            }
        }

        if (!forgeRepaired) {
            const forgeErrorMsg = `Forge 核心库文件缺失 (${depCheck.forgeCore.missing.length}个)，无法启动游戏。\n` +
                `缺失文件:\n${forgeMissing}\n\n` +
                `请前往"版本设置 → 文件修复"功能修复此问题，或重新安装该 Forge 版本。`;
            console.error(`[LaunchGame] Forge核心库缺失，自动修复失败，拒绝启动`);
            return {
                success: false,
                error: forgeErrorMsg,
                needDownload: false,
                depCheck,
                repairHint: 'forge_core_missing'
            };
        }
    }

    // 兜底检查：直接扫描继承链中所有版本的libraries，确认Forge核心JAR存在
    const chainIds = [];
    {
        let current = cleanVersionId;
        const chainVisited = new Set();
        while (current && !chainVisited.has(current)) {
            chainVisited.add(current);
            chainIds.push(current);
            const vjPath = path.join(VERSIONS_DIR, current, `${current}.json`);
            if (fs.existsSync(vjPath)) {
                try {
                    const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
                    current = vj.inheritsFrom || null;
                } catch (_) { break; }
            } else { break; }
        }
    }
    const forgeSafeChain = chainIds.some(id => id.toLowerCase().includes('forge'));
    if (forgeSafeChain) {
        const forgeSafeMissing = [];
        for (const lib of (versionJson.libraries || [])) {
            if (!lib.name) continue;
            const fp = lib.name.split(':');
            if (fp.length < 3) continue;
            const gp = fp[0].replace(/\./g, path.sep);
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const jn = `${fp[1]}-${fp[2]}${cl}.jar`;
            const isForgeCore = (fp[0] === 'net.minecraftforge' && fp[1] === 'forge' && cl) ||
                                (fp[0] === 'net.minecraft' && fp[1] === 'client' && (cl === '-srg' || cl === '-extra'));
            if (isForgeCore) {
                const fp2 = path.join(LIBRARIES_DIR, gp, fp[1], fp[2], jn);
                if (!fs.existsSync(fp2) || !isJarIntact(fp2)) {
                    forgeSafeMissing.push({ desc: jn, path: fp2 });
                }
            }
        }
        if (forgeSafeMissing.length > 0) {
            const missingNames = forgeSafeMissing.map(f => f.desc).join(', ');
            console.warn(`[LaunchGame] 兜底检查发现Forge核心库缺失 (${forgeSafeMissing.length}个): ${missingNames}`);

            let safeRepaired = false;
            for (const chainId of chainIds) {
                if (safeRepaired) break;
                if (!chainId.toLowerCase().includes('forge')) continue;
                const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
                if (!forgeMatch) continue;
                const mcVer = forgeMatch[1];
                const forgeVer = forgeMatch[2];
                console.log(`[LaunchGame] 兜底修复: 重新安装Forge ${mcVer}-${forgeVer}`);
                try {
                    const repairResult = await installForge(mcVer, forgeVer, (p, msg) => {
                        console.log(`[LaunchGame] 兜底修复进度: ${Math.round(p * 100)}%`);
                    });
                    if (repairResult.success) {
                        const stillMissing = forgeSafeMissing.filter(f => !fs.existsSync(f.path) || !isJarIntact(f.path));
                        if (stillMissing.length === 0) {
                            console.log(`[LaunchGame] 兜底修复成功!`);
                            safeRepaired = true;
                        }
                    }
                } catch (_) {}
            }

            if (!safeRepaired) {
                const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
                if (fs.existsSync(altMinecraftDir)) {
                    for (const f of forgeSafeMissing) {
                        if (fs.existsSync(f.path)) continue;
                        const relPath = path.relative(LIBRARIES_DIR, f.path).replace(/\\/g, '/');
                        const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
                        if (fs.existsSync(altLibPath)) {
                            try {
                                if (!fs.existsSync(path.dirname(f.path))) fs.mkdirSync(path.dirname(f.path), { recursive: true });
                                fs.copyFileSync(altLibPath, f.path);
                                if (fs.existsSync(f.path) && (!f.path.endsWith('.jar') || isJarIntact(f.path))) {
                                    safeRepaired = true;
                                } else {
                                    try { fs.unlinkSync(f.path); } catch (_) {}
                                }
                            } catch (_) {}
                        }
                    }
                    if (safeRepaired) {
                        const stillMissing = forgeSafeMissing.filter(f => !fs.existsSync(f.path) || !isJarIntact(f.path));
                        if (stillMissing.length > 0) safeRepaired = false;
                    }
                }
            }

            if (!safeRepaired) {
                return {
                    success: false,
                    error: `Forge 核心库文件缺失 (${forgeSafeMissing.length}个)，无法启动游戏。\n缺失文件: ${missingNames}\n请在版本设置中使用"文件修复"功能，或重新安装该版本。`,
                    needDownload: false,
                    depCheck,
                    repairHint: 'forge_core_missing'
                };
            }
        }
    }

    const nonForgeCoreMissing = depCheck.missingFiles.filter(f => f.type !== 'forge_core');
    if (nonForgeCoreMissing.length > 0) {
        const sessionId = `launch-${Date.now()}`;
        launchSessions.set(sessionId, {
            status: 'downloading',
            progress: 0,
            message: `正在下载 ${nonForgeCoreMissing.length} 个缺失文件..`,
            totalFiles: nonForgeCoreMissing.length,
            completedFiles: 0,
            currentFile: '',
            errors: [],
            versionId
        });

        downloadMissingDependencies(nonForgeCoreMissing, (p) => {
            if (!launchSessions.has(sessionId)) return;
            const sess = launchSessions.get(sessionId);
            if (p.progress !== undefined) sess.progress = p.progress;
            if (p.file) sess.currentFile = p.file;
            if (p.current !== undefined) sess.completedFiles = p.current;
            if (p.total !== undefined) sess.totalFiles = p.total;
            if (p.speed !== undefined) sess.speed = p.speed;
            if (p.msg) sess.message = p.msg;
            if (p.message) sess.message = p.message;
            if (p.activeDownloads) sess.activeDownloads = p.activeDownloads;
            if (p.failed !== undefined) sess.failed = p.failed;
            if (p.status === 'completed' || p.status === 'completed_with_errors') sess.status = 'completed';
            if (p.status === 'failed') {
                sess.status = 'failed';
                sess.message = p.message || p.msg || '下载失败';
            }
        }).catch(err => {
            console.error('[LaunchGame] 异步下载失败:', err.message);
            if (launchSessions.has(sessionId)) {
                const sess = launchSessions.get(sessionId);
                sess.status = 'failed';
                sess.message = '下载失败: ' + err.message;
            }
        });

        return {
            success: false,
            needDownload: true,
            sessionId,
            missingCount: depCheck.missingFiles.length,
            depCheck: {
                java: depCheck.java,
                libraries: { missing: depCheck.libraries.missing.length, total: depCheck.libraries.total },
                natives: { missing: depCheck.natives.missing.length },
                assets: { missing: depCheck.assets.missing.length, total: depCheck.assets.total },
                mainJar: depCheck.mainJar
            }
        };
    }

    return doLaunch(cleanVersionId, versionJson, settings, account, externalVersionDir, versionId);
    } catch (e) {
        console.error(`[LaunchGame] 异常: ${e.message}`);
        console.error(`[LaunchGame] 堆栈: ${e.stack}`);
        return {
            success: false,
            error: `启动流程异常: ${e.message}`,
            details: {
                versionId,
                error: e.message,
                stack: e.stack
            }
        };
    }
}

async function doLaunch(versionId, versionJson, settings, account, externalVersionDir = null, fullVersionId = null) {
    console.log(`[Launch] ========== 开始启动流程 ==========`);
    console.log(`[Launch] 版本ID: ${versionId}`);
    console.log(`[Launch] 完整版本ID: ${fullVersionId || versionId}`);
    console.log(`[Launch] 外部版本目录: ${externalVersionDir || '无'}`);
    console.log(`[Launch] 主类: ${versionJson.mainClass || '未设置'}`);

    let javaPath = selectJavaForVersion(versionId, settings, versionJson);
    if (!javaPath) {
        const errorMsg = '未找到Java运行环境，请在设置中配置Java路径';
        console.error(`[Launch] 错误: ${errorMsg}`);
        return { success: false, error: errorMsg, details: { versionId, mainClass: versionJson.mainClass } };
    }
    console.log(`[Launch] Java路径: ${javaPath}`);

    if (process.platform === 'win32' && !javaPath.endsWith('javaw.exe') && fs.existsSync(javaPath.replace('java.exe', 'javaw.exe'))) {
        javaPath = javaPath.replace('java.exe', 'javaw.exe');
    }

    let gameDir;
    if (externalVersionDir) {
        gameDir = externalVersionDir;
        console.log(`[Launch] 外部版本游戏目录(版本隔离): ${gameDir}`);
    } else {
        const settingsVersionId = fullVersionId || versionId;
        const effectiveIsolation = resolveVersionIsolation(settingsVersionId);
        if (effectiveIsolation) {
            const sameVersionCount = [...gameInstances.values()].filter(g => g.versionId === versionId).length;
            if (sameVersionCount > 0) {
                gameDir = path.join(VERSIONS_DIR, versionId, `instance_${sameVersionCount + 1}`);
            } else {
                gameDir = path.join(VERSIONS_DIR, versionId);
            }
        } else {
            gameDir = settings.gameDir || DATA_DIR;
        }
        console.log(`[Launch] 游戏目录: ${gameDir}`);
        console.log(`[Launch] 版本隔离: ${effectiveIsolation ? '是' : '否'}`);
    }

    const args = buildLaunchArguments(versionJson, settings, account, versionId, gameDir, externalVersionDir);
    console.log(`[Launch] 启动参数数量: ${args.length}`);
    
    {
        const debugLogPath = path.join(LOGS_DIR, `launch-debug-${Date.now()}.log`);
        try {
            const debugLines = [];
            debugLines.push(`=== VersePC 启动调试日志 ===`);
            debugLines.push(`时间: ${new Date().toISOString()}`);
            debugLines.push(`版本: ${versionId}`);
            debugLines.push(`外部版本: ${!!externalVersionDir}`);
            debugLines.push(`游戏目录: ${gameDir}`);
            debugLines.push(`JVM参数总数: ${args.length}`);
            debugLines.push(``);
            debugLines.push(`=== 完整JVM参数 ===`);
            args.forEach((a, i) => debugLines.push(`[${i}] ${a}`));
            
            const cpIdx2 = args.indexOf('-cp');
            if (cpIdx2 >= 0 && cpIdx2 + 1 < args.length) {
                const sep = process.platform === 'win32' ? ';' : ':';
                const entries = args[cpIdx2 + 1].split(sep);
                debugLines.push(``);
                debugLines.push(`=== Classpath (${entries.length}条目) ===`);
                entries.forEach(e => debugLines.push(`  ${e}`));
                const missing = entries.filter(e => !fs.existsSync(e));
                if (missing.length > 0) {
                    debugLines.push(``);
                    debugLines.push(`=== 缺失文件 (${missing.length}) ===`);
                    missing.forEach(m => debugLines.push(`  ${m}`));
                }
            }
            
            fs.writeFileSync(debugLogPath, debugLines.join('\n'), 'utf-8');
            console.log(`[Launch] 调试日志已保存: ${debugLogPath}`);
        } catch (e) {
            console.error(`[Launch] 调试日志写入失败: ${e.message}`);
        }
    }
    
    const cpIdx = args.indexOf('-cp');
    if (cpIdx !== -1 && cpIdx + 1 < args.length) {
        const classpathStr = args[cpIdx + 1];
        const separator = process.platform === 'win32' ? ';' : ':';
        const classpathEntries = classpathStr.split(separator);
        console.log(`[Launch] Classpath 条目数: ${classpathEntries.length}`);
        
        const mainClass = versionJson.mainClass || '';
        const isForgeLike = mainClass.includes('modlauncher') || mainClass.includes('fmlloader') ||
            mainClass.includes('forge') || mainClass.includes('neoforge');
        
        if (isForgeLike) {
            const criticalLibs = ['securejarhandler', 'forge', 'neoforge', 'fmlloader', 'modlauncher'];
            for (const crit of criticalLibs) {
                const found = classpathEntries.some(e => e.toLowerCase().includes(crit));
                console.log(`[Launch] 关键库 [${crit}]: ${found ? '✓ 找到' : '✗ 缺失!'}`);
            }
            const missingEntries = classpathEntries.filter(e => !fs.existsSync(e));
            if (missingEntries.length > 0) {
                console.error(`[Launch] ⚠ ${missingEntries.length} 个classpath条目文件不存在!`);
                missingEntries.slice(0, 5).forEach(m =>
                    console.error(`[Launch]   不存在: ${path.basename(m)}`)
                );
            }
        }
        
        if (mainClass.includes('fabric') || mainClass.includes('knot')) {
            const fabricLibs = classpathEntries.filter(e => 
                e.includes('fabric') || e.includes('fabricmc') || e.includes('intermediary')
            );
            console.log(`[Launch] Fabric库数量: ${fabricLibs.length}`);
            if (fabricLibs.length === 0) {
                console.error(`[Launch] 警告: Fabric版本但没有找到Fabric库!`);
            }
            fabricLibs.forEach((lib, i) => {
                const exists = fs.existsSync(lib);
                console.log(`[Launch] Fabric库[${i}]: ${path.basename(lib)} - ${exists ? '存在' : '缺失!'}`);
            });
        }
    }

    gameInstanceCounter++;
    const sessionId = `game_${gameInstanceCounter}_${Date.now()}`;

    try {

        try {
            setGameLanguage(gameDir, versionJson, settings);
        } catch (langErr) {
            console.error('[Language] 设置游戏语言失败:', langErr.message);
        }

        applyWindowSettings(gameDir, settings);

        const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';
        
        console.log(`[Launch] 主类: ${mainClass}`);
        console.log(`[Launch] 参数总数: ${args.length}`);
        
        const cpIdx = args.indexOf('-cp');
        if (cpIdx !== -1 && cpIdx + 1 < args.length) {
            const cpStr = args[cpIdx + 1];
            const cpEntries = cpStr.split(';');
            const missingCp = cpEntries.filter(e => !fs.existsSync(e));
            console.log(`[Launch] Classpath: ${cpEntries.length}个条目, ${missingCp.length}个不存在`);
            if (missingCp.length > 0 && missingCp.length <= 10) {
                missingCp.forEach(m => console.log(`[Launch]   缺失: ${m}`));
            }
            
            const mainClassInCp = cpEntries.some(e => {
                const basename = path.basename(e).toLowerCase();
                if (mainClass.includes('knot') && basename.includes('fabric-loader')) return true;
                if (mainClass.includes('modlauncher') && basename.includes('securejarhandler')) return true;
                if (mainClass.includes('launchwrapper') && basename.includes('launchwrapper')) return true;
                return false;
            });
            console.log(`[Launch] 主类对应JAR在classpath中: ${mainClassInCp}`);
        }

        const spawnOptions = {
            cwd: gameDir,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        };

        try {
            const debugCmd = [javaPath, ...args].map(a => {
                if (a.includes(' ') || a.includes('"') || a.includes('=')) return `"${a}"`;
                return a;
            }).join(' ');
            const debugPath = path.join(DATA_DIR, 'launch-debug.txt');
            fs.writeFileSync(debugPath, filterSensitiveInfo(debugCmd), 'utf-8');
            console.log(`[Launch] 调试命令行已写入: ${debugPath}`);
        } catch (e) {}

        const totalCmdLength = args.reduce((sum, a) => sum + a.length + 3, javaPath.length + 3);
        
        if (totalCmdLength > 30000 || (process.platform === 'win32' && totalCmdLength > 25000)) {
            console.log(`[Launch] 命令行过长(${totalCmdLength}字符)，使用Manifest JAR方式启动`);
            const cpIdx = args.indexOf('-cp');
            let classpathStr = '';
            let jvmOnlyArgs = [];
            let gameOnlyArgs = [];
            const mainClassIdx = args.indexOf(mainClass);
            
            if (cpIdx !== -1 && cpIdx + 1 < args.length) {
                classpathStr = args[cpIdx + 1];
                jvmOnlyArgs = [...args.slice(0, cpIdx)];
                if (mainClassIdx !== -1 && mainClassIdx > cpIdx + 1) {
                    jvmOnlyArgs = [...jvmOnlyArgs, ...args.slice(cpIdx + 2, mainClassIdx)];
                    gameOnlyArgs = [...args.slice(mainClassIdx + 1)];
                } else {
                    jvmOnlyArgs = [...jvmOnlyArgs, ...args.slice(cpIdx + 2)];
                }
            } else {
                if (mainClassIdx !== -1) {
                    jvmOnlyArgs = args.slice(0, mainClassIdx);
                    gameOnlyArgs = args.slice(mainClassIdx + 1);
                } else {
                    jvmOnlyArgs = [...args];
                }
            }
            
            const tmpDir = path.join(os.tmpdir(), 'versepc-launch');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const wrapperJar = path.join(tmpDir, `launcher-${Date.now()}.jar`);
            
            try {
                const cpEntries = classpathStr.split(';');
                const manifestClassPath = cpEntries.map(p => {
                    let encoded = p;
                    if (path.isAbsolute(p)) {
                        encoded = p.replace(/\\/g, '/');
                    }
                    return encoded.replace(/%/g, '%25').replace(/ /g, '%20');
                }).join(' ');
                
                let manifest = 'Manifest-Version: 1.0\r\n';
                manifest += `Main-Class: ${mainClass}\r\n`;
                
                const classPathLine = `Class-Path: ${manifestClassPath}`;
                let manifestLine = '';
                for (let i = 0; i < classPathLine.length; i++) {
                    if (i > 0 && i % 71 === 0) {
                        manifestLine += '\r\n ';
                    }
                    manifestLine += classPathLine[i];
                }
                manifest += manifestLine + '\r\n\r\n';
                
                const manifestDir = path.join(tmpDir, 'META-INF');
                if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir, { recursive: true });
                fs.writeFileSync(path.join(manifestDir, 'MANIFEST.MF'), manifest);
                
                const AdmZip = require('adm-zip');
                const zip = new AdmZip();
                zip.addLocalFile(path.join(manifestDir, 'MANIFEST.MF'), 'META-INF');
                zip.writeZip(wrapperJar);
                
                const newArgs = [...jvmOnlyArgs, '-jar', wrapperJar, ...gameOnlyArgs];
                console.log(`[Launch] Manifest JAR: ${wrapperJar}, classpath条目: ${cpEntries.length}`);

                let skinBackups = [];
                try { skinBackups = injectOfflineSkin(versionJson, account, ASSETS_DIR); } catch (e) {}

                const gameProcess = spawn(javaPath, newArgs, spawnOptions);

                gameProcess.on('exit', () => {
                    try { fs.unlinkSync(wrapperJar); } catch (e) {}
                    try { fs.rmSync(manifestDir, { recursive: true, force: true }); } catch (e) {}
                    try { restoreOfflineSkin(skinBackups); } catch (e) {}
                });
                
                console.log(`[Launch] 进程已启动(Manifest JAR模式), PID: ${gameProcess.pid}`);
                
                applyPerformanceOptimizations(gameProcess.pid);
                
                const instanceInfo = {
                    sessionId,
                    process: gameProcess,
                    versionId,
                    pid: gameProcess.pid,
                    gameDir,
                    startTime: Date.now(),
                    logBuffer: [],
                    lanPort: null,
                    gameReady: false,
                    readyTime: null,
                    launchInfo: {
                        versionId,
                        fullVersionId: fullVersionId || versionId,
                        externalVersionDir,
                        mainClass: versionJson.mainClass,
                        javaPath,
                        gameDir
                    }
                };

                gameInstances.set(sessionId, instanceInfo);
                console.log(`[Launch] 游戏进程已创建, PID: ${gameProcess.pid}, Session: ${sessionId}`);

                gameProcess.stdout.on('data', (data) => {
                    const lines = data.toString().split('\n').filter(l => l.trim()).map(filterSensitiveInfo);
                    instanceInfo.logBuffer.push(...lines);
                    if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                    gameLogBuffer.push(...lines);
                    if (gameLogBuffer.length > 5000) gameLogBuffer = gameLogBuffer.slice(-3000);
                    for (const line of lines) {
                        const lanMatch = line.match(/Local game hosted on[:\s]+(\d{4,5})/i) ||
                                         line.match(/Started serving on[:\s]+(\d{4,5})/i) ||
                                         line.match(/Opening LAN server on[:\s]+(\d{4,5})/i) ||
                                         line.match(/LAN server started on[:\s]+(\d{4,5})/i);
                        if (lanMatch) {
                            instanceInfo.lanPort = parseInt(lanMatch[1], 10);
                            detectedLanPort = parseInt(lanMatch[1], 10);
                            console.log(`[LAN] Detected LAN port: ${instanceInfo.lanPort} (session: ${sessionId})`);
                        }
                        if (!instanceInfo.gameReady && (line.includes('Setting user:') || line.includes('LWJGL Version:') || line.includes('OpenAL initialized'))) {
                            instanceInfo.gameReady = true;
                            instanceInfo.readyTime = Date.now();
                            const launchDuration = instanceInfo.readyTime - instanceInfo.startTime;
                            console.log(`[Launch] 游戏窗口已就绪(Manifest模式), 耗时: ${(launchDuration / 1000).toFixed(1)}s`);
                        }
                    }
                });

                gameProcess.stderr.on('data', (data) => {
                    const lines = data.toString().split('\n').filter(l => l.trim()).map(filterSensitiveInfo);
                    instanceInfo.logBuffer.push(...lines);
                    if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
                    gameLogBuffer.push(...lines);
                    if (gameLogBuffer.length > 5000) gameLogBuffer = gameLogBuffer.slice(-3000);
                });

                gameProcess.unref();

                gameProcess.on('close', (code) => {
                    const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
                    let analysis = analyzeExitCode(code, launchVersionId || versionId);
                    if (!analysis.isCrash && code !== 0 && recentLogs.includes('Invalid paths argument')) {
                        analysis = {
                            code,
                            isCrash: true,
                            reason: 'Forge核心库文件缺失（Invalid paths argument）',
                            suggestion: 'Forge安装不完整，请前往版本设置使用"文件修复"功能，或重新安装该Forge版本'
                        };
                    }
                    if (analysis.isCrash && recentLogs.includes('Invalid paths argument')) {
                        analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                        analysis.suggestion = 'Forge安装不完整，请前往版本设置使用"文件修复"功能，或重新安装该Forge版本';
                    }
                    instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
                    gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
                    if (analysis.isCrash) {
                        instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                        instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
                        gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                    } else {
                        instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
                        gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
                    }
                    lastGameExitAnalysis = { 
                        ...analysis, 
                        launchInfo: instanceInfo.launchInfo,
                        logBuffer: instanceInfo.logBuffer.slice(-50)
                    };
                    try {
                        const playTimePath = path.join(DATA_DIR, 'play-time.json');
                        if (fs.existsSync(playTimePath)) {
                            if (!global._playTimeWriteQueue) global._playTimeWriteQueue = Promise.resolve();
                            global._playTimeWriteQueue = global._playTimeWriteQueue.then(() => {
                                let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                                const vData = ptData[launchVersionId || versionId];
                                if (vData && vData._launchTime) {
                                    const elapsed = (Date.now() - vData._launchTime) / 1000;
                                    vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
                                    delete vData._launchTime;
                                    fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                                }
                            });
                        }
                    } catch (e) {}
                    gameInstances.delete(sessionId);
                    if (gameInstances.size === 0) {
                        gameLogBuffer = [];
                    }
                });

                gameProcess.on('error', (err) => {
                    instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
                    gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
                    lastGameExitAnalysis = { 
                        code: -1, 
                        reason: `启动错误: ${err.message}`, 
                        suggestion: '请检查Java路径是否正确', 
                        isCrash: true,
                        launchInfo: instanceInfo.launchInfo
                    };
                    gameInstances.delete(sessionId);
                });

                return {
                    success: true,
                    sessionId,
                    pid: gameProcess.pid,
                    gameDir,
                    versionId
                };
            } catch (manifestErr) {
                console.error(`[Launch] Manifest JAR创建失败，回退到普通模式: ${manifestErr.message}`);
                try { fs.unlinkSync(wrapperJar); } catch (e) {}
            }
        }

        let skinBackups = [];
        try { skinBackups = injectOfflineSkin(versionJson, account, ASSETS_DIR); } catch (e) {}

        const gameProcess = spawn(javaPath, args, spawnOptions);

        console.log(`[Launch] 进程已启动, PID: ${gameProcess.pid}`);
        
        applyPerformanceOptimizations(gameProcess.pid);
        
        const instanceInfo = {
            sessionId,
            process: gameProcess,
            versionId,
            pid: gameProcess.pid,
            gameDir,
            startTime: Date.now(),
            logBuffer: [],
            lanPort: null,
            gameReady: false,
            readyTime: null,
            launchInfo: {
                versionId,
                fullVersionId: fullVersionId || versionId,
                externalVersionDir,
                mainClass: versionJson.mainClass,
                javaPath,
                gameDir
            }
        };

        gameInstances.set(sessionId, instanceInfo);
        console.log(`[Launch] 游戏进程已创建, PID: ${gameProcess.pid}, Session: ${sessionId}`);

        gameProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim()).map(filterSensitiveInfo);
            instanceInfo.logBuffer.push(...lines);
            if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
            gameLogBuffer.push(...lines);
            if (gameLogBuffer.length > 5000) gameLogBuffer = gameLogBuffer.slice(-3000);
            for (const line of lines) {
                const lanMatch = line.match(/Local game hosted on[:\s]+(\d{4,5})/i) ||
                                 line.match(/Started serving on[:\s]+(\d{4,5})/i) ||
                                 line.match(/Opening LAN server on[:\s]+(\d{4,5})/i) ||
                                 line.match(/LAN server started on[:\s]+(\d{4,5})/i);
                if (lanMatch) {
                    instanceInfo.lanPort = parseInt(lanMatch[1], 10);
                    detectedLanPort = parseInt(lanMatch[1], 10);
                    console.log(`[LAN] Detected LAN port: ${instanceInfo.lanPort} (session: ${sessionId})`);
                }
                if (!instanceInfo.gameReady && (line.includes('Setting user:') || line.includes('LWJGL Version:') || line.includes('OpenAL initialized'))) {
                    instanceInfo.gameReady = true;
                    instanceInfo.readyTime = Date.now();
                    const launchDuration = instanceInfo.readyTime - instanceInfo.startTime;
                    console.log(`[Launch] 游戏窗口已就绪, 耗时: ${(launchDuration / 1000).toFixed(1)}s`);
                    if (process.platform === 'win32') {
                        try {
                            const windowTitle = `Minecraft* - VersePC`;
                            execSync(`powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -like 'Minecraft*'} | ForEach-Object {$_.MainWindowTitle = '${windowTitle}'}"`, { timeout: 5000, stdio: 'pipe' });
                        } catch (e) {}
                    }
                }
            }
        });

        gameProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(l => l.trim()).map(filterSensitiveInfo);
            instanceInfo.logBuffer.push(...lines);
            if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
            gameLogBuffer.push(...lines);
            if (gameLogBuffer.length > 5000) gameLogBuffer = gameLogBuffer.slice(-3000);
        });

        let launchVersionId = versionId;

        gameProcess.on('close', (code) => {
            try { restoreOfflineSkin(skinBackups); } catch (e) {}
            const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
            let analysis = analyzeExitCode(code, launchVersionId);
            if (!analysis.isCrash && code !== 0 && recentLogs.includes('Invalid paths argument')) {
                analysis = {
                    code,
                    isCrash: true,
                    reason: 'Forge核心库文件缺失（Invalid paths argument）',
                    suggestion: 'Forge安装不完整，请前往版本设置使用"文件修复"功能，或重新安装该Forge版本'
                };
            }
            if (analysis.isCrash && recentLogs.includes('Invalid paths argument')) {
                analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                analysis.suggestion = 'Forge安装不完整，请前往版本设置使用"文件修复"功能，或重新安装该Forge版本';
            }
            instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
            gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
            if (analysis.isCrash) {
                instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
                instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
                gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
            } else {
                instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
                gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
            }
            lastGameExitAnalysis = { 
                ...analysis, 
                launchInfo: instanceInfo.launchInfo,
                logBuffer: instanceInfo.logBuffer.slice(-50)
            };
            try {
                const playTimePath = path.join(DATA_DIR, 'play-time.json');
                if (fs.existsSync(playTimePath)) {
                    let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                    const vData = ptData[launchVersionId];
                    if (vData && vData._launchTime) {
                        const elapsed = (Date.now() - vData._launchTime) / 1000;
                        vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
                        delete vData._launchTime;
                        fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                    }
                }
            } catch (e) {}
            gameInstances.delete(sessionId);
            if (gameInstances.size === 0) {
                gameLogBuffer = [];
            }
        });

        gameProcess.on('error', (err) => {
            instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
            gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
            lastGameExitAnalysis = { 
                code: -1, 
                reason: `启动错误: ${err.message}`, 
                suggestion: '请检查Java路径是否正确', 
                isCrash: true,
                launchInfo: instanceInfo.launchInfo
            };
            gameInstances.delete(sessionId);
        });

        return { success: true, pid: gameProcess.pid, sessionId, launchInfo: instanceInfo.launchInfo };
    } catch (e) {
        console.error(`[Launch] 启动异常: ${e.message}`);
        console.error(`[Launch] 堆栈: ${e.stack}`);
        return { 
            success: false, 
            error: '启动失败: ' + e.message,
            details: {
                versionId,
                mainClass: versionJson.mainClass,
                externalVersionDir,
                error: e.message,
                stack: e.stack
            }
        };
    }
}

async function verifyFileSha1(filePath, expectedSha1) {
    if (!expectedSha1) return true;
    try {
        const stat = await fs.promises.stat(filePath);
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        return await new Promise((resolve) => {
            stream.on('data', data => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex') === expectedSha1.toLowerCase()));
            stream.on('error', () => resolve(false));
        });
    } catch (e) {
        return false;
    }
}

async function ensureBaseVersionInstalled(gameVersion) {
    const baseJsonPath = path.join(VERSIONS_DIR, gameVersion, `${gameVersion}.json`);
    const baseJarPath = path.join(VERSIONS_DIR, gameVersion, `${gameVersion}.jar`);
    
    if (fs.existsSync(baseJsonPath) && fs.existsSync(baseJarPath)) {
        try {
            const existingJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf-8'));
            if (existingJson.downloads?.client?.sha1 && !await verifyFileSha1(baseJarPath, existingJson.downloads.client.sha1)) {
                console.warn(`[BaseVersion] ${gameVersion} JAR SHA1校验失败，重新下载`);
                fs.unlinkSync(baseJarPath);
            } else {
                let libsOk = true;
                const libs = existingJson.libraries || [];
                let checkedCount = 0;
                for (const lib of libs) {
                    if (checkedCount >= 3) break;
                    const artifactPath = lib.downloads?.artifact?.path;
                    if (artifactPath) {
                        checkedCount++;
                        const libFile = path.join(LIBRARIES_DIR, artifactPath);
                        if (!fs.existsSync(libFile)) {
                            console.log(`[BaseVersion] 库文件缺失: ${artifactPath}，需要重新下载`);
                            libsOk = false;
                            break;
                        }
                    }
                }
                if (libsOk) {
                    console.log(`[BaseVersion] ${gameVersion} already installed (verified)`);
                    return { alreadyInstalled: true };
                }
                console.log(`[BaseVersion] ${gameVersion} 库文件不完整，重新下载...`);
            }
        } catch (e) {
            console.warn(`[BaseVersion] ${gameVersion} 校验异常: ${e.message}`);
        }
    }
    
    console.log(`[BaseVersion] ${gameVersion} not found or corrupted, installing...`);
    
    try {
        const manifest = await getVersionManifest();
        const versionInfo = manifest.versions.find(v => v.id === gameVersion);
        
        if (!versionInfo) {
            return { alreadyInstalled: false, error: `找不到版本 ${gameVersion}` };
        }
        
        const versionDetails = await getVersionDetails(versionInfo.url);
        const versionDir = path.join(VERSIONS_DIR, gameVersion);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
        
        const jsonPath = path.join(versionDir, `${gameVersion}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(versionDetails, null, 2));
        
        if (versionDetails.downloads?.client) {
            const clientInfo = versionDetails.downloads.client;
            const clientJarPath = path.join(versionDir, `${gameVersion}.jar`);
            
            if (!fs.existsSync(clientJarPath) || (clientInfo.sha1 && !await verifyFileSha1(clientJarPath, clientInfo.sha1))) {
                console.log(`[BaseVersion] Downloading client JAR for ${gameVersion}...`);
                if (fs.existsSync(clientJarPath)) fs.unlinkSync(clientJarPath);
                await downloadFileWithMirror(clientInfo.url, clientJarPath);
                if (clientInfo.sha1 && !await verifyFileSha1(clientJarPath, clientInfo.sha1)) {
                    console.warn(`[BaseVersion] Client JAR SHA1 mismatch after download!`);
                }
            }
        }
        
        const libraries = versionDetails.libraries || [];
        for (const lib of libraries) {
            if (lib.rules && !evaluateRules(lib.rules)) continue;

            if (lib.downloads?.artifact) {
                const libPath = safeLibPath(lib.downloads.artifact.path);
                if (!libPath) continue;
                const needDownload = !fs.existsSync(libPath) ||
                    (lib.downloads.artifact.sha1 && !await verifyFileSha1(libPath, lib.downloads.artifact.sha1));
                if (needDownload && lib.downloads.artifact.url) {
                    try {
                        if (fs.existsSync(libPath)) fs.unlinkSync(libPath);
                        await downloadFileWithMirror(lib.downloads.artifact.url, libPath);
                    } catch (e) {
                        console.log(`[BaseVersion] Failed to download library ${lib.name}: ${e.message}`);
                    }
                }
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const groupPath = parts[0].replace(/\./g, '/');
                    const lname = parts[1];
                    const lversion = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${lname}-${lversion}-${classifier}.jar` : `${lname}-${lversion}.jar`;
                    const libFile = path.join(LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), lname, lversion, jarName);
                    if (!fs.existsSync(libFile)) {
                        const baseUrl = lib.url || 'https://libraries.minecraft.net/';
                        const downloadUrl = `${baseUrl}${groupPath}/${lname}/${lversion}/${jarName}`;
                        try {
                            await downloadFileWithMirror(downloadUrl, libFile);
                        } catch (e) {
                            console.log(`[BaseVersion] Failed to download library ${lib.name}: ${e.message}`);
                        }
                    }
                }
            }

            if (lib.natives) {
                const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                if (nativeKey) {
                    const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                    const nativeDownload = lib.downloads?.classifiers?.[classifier];
                    if (nativeDownload) {
                        const nativeFile = path.join(LIBRARIES_DIR, nativeDownload.path);
                        if (!fs.existsSync(nativeFile)) {
                            try {
                                await downloadFileWithMirror(nativeDownload.url, nativeFile);
                            } catch (e) {
                                console.log(`[BaseVersion] Failed to download native ${path.basename(nativeDownload.path)}: ${e.message}`);
                            }
                        }
                    }
                }
            }
        }
        
        if (versionDetails.assetIndex) {
            const assetIndexDir = path.join(ASSETS_DIR, 'indexes');
            if (!fs.existsSync(assetIndexDir)) fs.mkdirSync(assetIndexDir, { recursive: true });
            const assetIndexPath = path.join(assetIndexDir, `${versionDetails.assetIndex.id}.json`);
            if (!fs.existsSync(assetIndexPath) || (versionDetails.assetIndex.sha1 && !await verifyFileSha1(assetIndexPath, versionDetails.assetIndex.sha1))) {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await downloadFileWithMirror(versionDetails.assetIndex.url, assetIndexPath);
            }
        }
        
        const missingLibs = [];
        const libsToVerify = (versionDetails.libraries || []).filter(l => l.downloads?.artifact?.path);
        for (let i = 0; i < Math.min(3, libsToVerify.length); i++) {
            const lib = libsToVerify[i];
            const libFile = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
            if (!fs.existsSync(libFile)) {
                missingLibs.push(lib.downloads.artifact.path);
            }
        }
        if (missingLibs.length > 0) {
            const msg = `基础版本 ${gameVersion} 库文件下载后仍缺失 (${missingLibs.length}个): ${missingLibs[0]}`;
            console.error(`[BaseVersion] ${msg}`);
            return { error: msg };
        }
        
        console.log(`[BaseVersion] ${gameVersion} installed successfully`);
        return { alreadyInstalled: false, success: true };
    } catch (e) {
        console.error(`[BaseVersion] Failed to install ${gameVersion}:`, e.message);
        try {
            const versionDir = path.join(VERSIONS_DIR, gameVersion);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[BaseVersion] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[BaseVersion] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { alreadyInstalled: false, error: `基础版本 ${gameVersion} 安装失败: ${e.message}` };
    }
}

async function installFabric(gameVersion, loaderVersion, onProgress = null) {
    const versionId = `fabric-loader-${loaderVersion}-${gameVersion}`;

    try {
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) {
            return { success: false, error: baseResult.error };
        }
        
        const metaUrl = `${FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
        console.log(`[Fabric] Fetching profile from: ${metaUrl}`);
        const profileData = await fetchJSON(metaUrl);
        console.log(`[Fabric] Profile data keys: ${Object.keys(profileData).join(', ')}`);

        const versionDir = path.join(VERSIONS_DIR, versionId);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        const fullProfile = {
            id: versionId,
            inheritsFrom: gameVersion,
            mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
            type: 'release',
            libraries: [],
            arguments: {
                game: [],
                jvm: []
            }
        };

        if (profileData.launcherMeta) {
            const launcherMeta = profileData.launcherMeta;
            console.log(`[Fabric] launcherMeta keys: ${Object.keys(launcherMeta).join(', ')}`);

            if (launcherMeta.libraries) {
                const common = launcherMeta.libraries.common || [];
                const client = launcherMeta.libraries.client || [];
                const server = launcherMeta.libraries.server || [];
                fullProfile.libraries = [...common, ...client];
                console.log(`[Fabric] Libraries: ${common.length} common, ${client.length} client`);
            }

            // PCL2-style: launcherMeta.mainClass.client returns the VANILLA main class (net.minecraft.client.main.Main),
            // NOT the Fabric main class. Do NOT use it to override the Fabric KnotClient.
            if (launcherMeta.mainClass) {
                const metaMainClass = typeof launcherMeta.mainClass === 'string'
                    ? launcherMeta.mainClass
                    : launcherMeta.mainClass?.client;
                if (metaMainClass && metaMainClass.includes('fabricmc')) {
                    fullProfile.mainClass = metaMainClass;
                    console.log(`[Fabric] mainClass from launcherMeta: ${fullProfile.mainClass}`);
                } else {
                    console.log(`[Fabric] Ignoring launcherMeta.mainClass (${metaMainClass}) - not Fabric, keeping ${fullProfile.mainClass}`);
                }
            }
        }

        if (profileData.loader) {
            if (profileData.loader.mainClass) {
                fullProfile.mainClass = profileData.loader.mainClass;
                console.log(`[Fabric] mainClass from loader: ${fullProfile.mainClass}`);
            }
            if (profileData.loader.libraries && fullProfile.libraries.length === 0) {
                fullProfile.libraries = profileData.loader.libraries;
            }
        }

        // Also check top-level mainClass from Fabric meta API v2
        if (profileData.mainClass) {
            if (typeof profileData.mainClass === 'string') {
                fullProfile.mainClass = profileData.mainClass;
            } else if (profileData.mainClass.client) {
                fullProfile.mainClass = profileData.mainClass.client;
            }
            console.log(`[Fabric] mainClass from profileData: ${fullProfile.mainClass}`);
        }

        // PCL2-style: Collect arguments from all possible Fabric meta locations
        if (profileData.arguments) {
            for (const key of Object.keys(profileData.arguments)) {
                if (Array.isArray(profileData.arguments[key])) {
                    fullProfile.arguments[key] = profileData.arguments[key];
                }
            }
        }
        if (profileData.launcherMeta?.arguments) {
            for (const key of Object.keys(profileData.launcherMeta.arguments)) {
                if (Array.isArray(profileData.launcherMeta.arguments[key])) {
                    fullProfile.arguments[key] = profileData.launcherMeta.arguments[key];
                }
            }
        }

        console.log(`[Fabric] Final mainClass: ${fullProfile.mainClass}`);
        console.log(`[Fabric] Final libraries count: ${fullProfile.libraries.length}`);

        const fabLibsToDownload = [];
        for (const lib of fullProfile.libraries) {
            if (lib.downloads?.artifact?.url) {
                const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                if (!isJarIntact(libPath)) {
                    fabLibsToDownload.push({ lib, url: lib.downloads.artifact.url, libPath });
                }
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const mavenGroupPath = parts[0].replace(/\./g, '/');
                    const name = parts[1];
                    const ver = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${name}-${ver}-${classifier}.jar` : `${name}-${ver}.jar`;
                    const localGroupPath = parts[0].replace(/\./g, path.sep);
                    const libPath = path.join(LIBRARIES_DIR, localGroupPath, name, ver, jarName);

                    if (!lib.downloads) lib.downloads = {};
                    if (!lib.downloads.artifact) {
                        lib.downloads.artifact = {
                            path: `${mavenGroupPath}/${name}/${ver}/${jarName}`,
                            sha1: '', size: 0, url: ''
                        };
                    }

                    if (!isJarIntact(libPath)) {
                        const mavenBaseUrl = lib.url || 'https://maven.fabricmc.net/';
                        const downloadUrl = `${mavenBaseUrl}${mavenGroupPath}/${name}/${ver}/${jarName}`;
                        fabLibsToDownload.push({ lib, url: downloadUrl, libPath });
                    }
                }
            }
        }

        let fabLibFailures = 0;
        if (fabLibsToDownload.length > 0) {
            const settings = loadSettingsCached();
            const FAB_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 8, fabLibsToDownload.length);
            let completed = 0;
            let active = 0;
            let done = null;

            const scheduleNext = () => {
                while (active < FAB_PARALLEL && completed + active < fabLibsToDownload.length) {
                    const item = fabLibsToDownload[completed + active];
                    active++;
                    (async () => {
                        try {
                            if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath);
                            await downloadFileWithMirror(item.url, item.libPath);
                        } catch (e) {
                            fabLibFailures++;
                            console.log(`[Fabric] Failed to download ${item.lib.name}: ${e.message}`);
                        }
                    })().then(() => {
                        completed++;
                    }).catch(() => {}).finally(() => {
                        active--;
                        if (onProgress) {
                            onProgress(completed / fabLibsToDownload.length, `下载Fabric库 (${completed}/${fabLibsToDownload.length})...`);
                        }
                        if (active === 0 && completed >= fabLibsToDownload.length && done) done();
                        else if (active < FAB_PARALLEL && completed + active < fabLibsToDownload.length) scheduleNext();
                    });
                }
            };

            await new Promise(resolve => { done = resolve; scheduleNext(); });
        }

        const fabCoreLibs = [];
        const fabMainLib = fullProfile.libraries.find(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader:'));
        if (fabMainLib) {
            const fp = fabMainLib.name.split(':');
            const fj = `${fp[1]}-${fp[2]}.jar`;
            fabCoreLibs.push(path.join(LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2], fj));
        }
        const fabMissing = fabCoreLibs.filter(f => !fs.existsSync(f));
        if (fabMissing.length > 0) {
            console.warn(`[Fabric] 核心库文件暂缺 (${fabMissing.length}个): ${fabMissing.join(', ')}, 将由安装后验证补全`);
        }

        const jsonPath = path.join(versionDir, `${versionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(fullProfile, null, 2));

        console.log(`[Fabric] Installation complete: ${versionId}`);
        return { success: true, versionId: versionId, libsMissing: fabMissing.length };
    } catch (e) {
        console.error(`[Fabric] Installation failed: ${e.message}`);
        try {
            const versionDir = path.join(VERSIONS_DIR, `fabric-loader-${loaderVersion}-${gameVersion}`);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[Fabric] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[Fabric] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { success: false, error: e.message };
    }
}

function verifyLoaderLibs(versionId) {
    try {
        const jsonPath = path.join(VERSIONS_DIR, versionId, `${versionId}.json`);
        if (!fs.existsSync(jsonPath)) return false;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const libs = data.libraries || [];
        let checked = 0, missing = 0;
        const missingPaths = [];
        for (const lib of libs) {
            let libPath = null;
            if (lib.downloads?.artifact?.path) {
                libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const gp = parts[0].replace(/\./g, path.sep);
                    const nm = parts[1];
                    const vr = parts[2];
                    const cls = parts.length >= 4 ? parts[3] : '';
                    const jn = cls ? `${nm}-${vr}-${cls}.jar` : `${nm}-${vr}.jar`;
                    libPath = path.join(LIBRARIES_DIR, gp, nm, vr, jn);
                }
            }
            if (libPath) {
                checked++;
                if (!fs.existsSync(libPath)) {
                    missing++;
                    if (missingPaths.length < 3) missingPaths.push(lib.name || path.basename(libPath));
                }
            }
        }
        if (missing > 0) {
            console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库, ${missing}个缺失 (${missingPaths.join(', ')}...)`);
            return false;
        }

        const isForge = versionId.toLowerCase().includes('forge');
        if (isForge && checked > 0) {
            const forgeCoreFiles = [];
            for (const lib of libs) {
                if (!lib.name) continue;
                if (lib.name.startsWith('net.minecraftforge:forge:') && lib.name.split(':').length >= 4) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name === 'net.minecraftforge:forge' || lib.name.startsWith('net.minecraftforge:forge:')) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name.startsWith('net.minecraft:client:') && (lib.name.endsWith(':srg') || lib.name.endsWith(':extra'))) {
                    forgeCoreFiles.push(lib);
                }
            }
            let forgeCoreMissing = 0;
            const missingForgeCores = [];
            for (const lib of forgeCoreFiles) {
                const parts = lib.name.split(':');
                const gp = parts[0].replace(/\./g, path.sep);
                const nm = parts[1];
                const vr = parts[2];
                const cl = parts.length >= 4 ? parts[3] : '';
                const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                const fp = path.join(LIBRARIES_DIR, gp, nm, vr, jn);
                if (!fs.existsSync(fp)) {
                    forgeCoreMissing++;
                    missingForgeCores.push(path.basename(fp));
                }
            }
            if (forgeCoreMissing > 0) {
                console.log(`[verifyLoaderLibs] ${versionId}: 基础库存在但Forge核心文件缺失(${forgeCoreMissing}): ${missingForgeCores.join(', ')}`);
                return false;
            }
            console.log(`[verifyLoaderLibs] ${versionId}: 包含Forge核心文件(${forgeCoreFiles.length}个)全部存在`);
        }

        console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库全部存在`);
        return checked > 0;
    } catch (e) {
        console.log(`[verifyLoaderLibs] ${versionId}: error ${e.message}`);
        return false;
    }
}

async function verifyImportLibs(versionId, progress, abortSignal) {
    const mergedJson = resolveVersionJson(versionId);
    const allLibs = mergedJson ? (mergedJson.libraries || []) : [];
    const currentPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    let libChecked = 0, libMissing = 0;
    const missingLibFiles = [];

    for (const lib of allLibs) {
        if (lib.rules && !evaluateRules(lib.rules)) continue;
        if (lib.natives) continue;
        const nameSuffix = lib.name ? lib.name.split(':').pop() : '';
        if (nameSuffix.startsWith('natives-')) {
            let isValid = false;
            if (process.arch === 'x64') {
                const plat = nameSuffix.replace('natives-', '');
                isValid = plat === currentPlatform || plat === currentPlatform + '-x64';
            }
            if (!isValid) continue;
        }
        libChecked++;
        let libPath = null;
        if (lib.downloads?.artifact?.path) {
            libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
        } else if (lib.name) {
            const p = lib.name.split(':');
            if (p.length >= 3) {
                const gp = p[0].replace(/\./g, path.sep);
                const cl = p.length >= 4 ? `-${p[3]}` : '';
                const jn = `${p[1]}-${p[2]}${cl}.jar`;
                libPath = path.join(LIBRARIES_DIR, gp, p[1], p[2], jn);
            }
        }
        if (libPath && !fs.existsSync(libPath)) {
            libMissing++;
            let dlUrl = lib.downloads?.artifact?.url || '';
            if (!dlUrl && lib.name) {
                const p = lib.name.split(':');
                if (p.length >= 3) {
                    const mg = p[0].replace(/\./g, '/');
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const base = lib.url || (p[0].includes('forge') || p[0].includes('minecraftforge') || p[0].includes('neoforged') || p[0].includes('minecraft')
                        ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                    dlUrl = `${base}${mg}/${p[1]}/${p[2]}/${jn}`;
                }
            }
            missingLibFiles.push({
                type: 'library', url: dlUrl || '', path: libPath,
                sha1: lib.downloads?.artifact?.sha1 || '',
                size: lib.downloads?.artifact?.size || 0,
                name: lib.name || path.basename(libPath)
            });
        }
    }
    console.log(`[verifyImport] ${versionId}: 检查${libChecked}个库, 缺失${libMissing}个`);
    if (libMissing > 0) {
        if (progress) progress('verify', `正在补全 ${libMissing} 个缺失库文件...`, 91, [], '');
        const dlResult = await downloadMissingDependencies(missingLibFiles, (p) => {
            if (progress && p.progress !== undefined) {
                const pct = 91 + Math.round((p.progress / 100) * 6);
                progress('verify', `补全依赖 (${(p.completed || 0) + (p.failed || 0)}/${libMissing})`, Math.min(pct, 97), [], '');
            }
        });
        console.log(`[verifyImport] 补全结果: ${dlResult.completed}成功 ${dlResult.failed}失败`);
        return { ok: dlResult.failed === 0, checked: libChecked, missing: dlResult.failed };
    }
    if (progress) progress('verify', '完整性检查通过', 93, [], '');
    return { ok: true, checked: libChecked, missing: 0 };
}

async function installForge(gameVersion, forgeVersion, onProgress = null) {
    const versionId = `${gameVersion}-forge-${forgeVersion}`;

    try {
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) {
            return { success: false, error: baseResult.error };
        }
        
        const installerUrl = `${FORGE_MAVEN_URL}/${gameVersion}-${forgeVersion}/forge-${gameVersion}-${forgeVersion}-installer.jar`;
        const installerPath = path.join(DATA_DIR, 'temp', `forge-installer-${gameVersion}-${forgeVersion}.jar`);
        if (!fs.existsSync(path.dirname(installerPath))) fs.mkdirSync(path.dirname(installerPath), { recursive: true });

        if (onProgress) onProgress(0, '正在下载Forge安装包...');
        console.log(`[Forge] Downloading installer from: ${installerUrl}`);
        await downloadFileWithMirror(installerUrl, installerPath);

        const versionDir = path.join(VERSIONS_DIR, versionId);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        const AdmZip = require('adm-zip');
        const zip = new AdmZip(installerPath);

        let installProfile = null;
        let versionJsonData = null;

        try {
            const profileEntry = zip.getEntry('install_profile.json');
            if (profileEntry) installProfile = JSON.parse(profileEntry.getData().toString('utf8'));
        } catch (e) {}

        try {
            const versionEntry = zip.getEntry('version.json') || zip.getEntry(`${versionId}.json`);
            if (versionEntry) {
                versionJsonData = JSON.parse(versionEntry.getData().toString('utf8'));
            } else if (installProfile && typeof installProfile.json === 'object' && installProfile.json !== null) {
                versionJsonData = installProfile.json;
                console.log('[Forge] 使用 install_profile.json 内嵌的 version JSON');
            }
        } catch (e) {}

        console.log(`[Forge] installProfile: ${installProfile ? 'found' : 'not found'}, versionJson: ${versionJsonData ? 'found' : 'not found'}`);

        if (versionJsonData) {
            versionJsonData.id = versionId;
            versionJsonData.inheritsFrom = gameVersion;
            if (!versionJsonData.type) versionJsonData.type = 'release';

            console.log(`[Forge] mainClass: ${versionJsonData.mainClass}`);
            console.log(`[Forge] libraries: ${(versionJsonData.libraries || []).length}`);

            if (onProgress) onProgress(0.05, '正在提取Forge Maven文件...');
            console.log(`[Forge] 从安装包提取 maven 文件 (先提取，再下载剩余库)...`);
            const mavenEntries = zip.getEntries().filter(e => e.entryName.startsWith('maven/'));
            console.log(`[Forge] maven entries count: ${mavenEntries.length}`);
            let forgeYieldCounter = 0;
            for (const entry of mavenEntries) {
                const relativePath = entry.entryName.replace('maven/', '');
                const extractPath = path.join(LIBRARIES_DIR, relativePath);
                if (!isJarIntact(extractPath)) {
                    await asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                    try {
                        await fs.promises.writeFile(extractPath, entry.getData());
                        if (extractPath.endsWith('.jar') && !isJarIntact(extractPath)) {
                            console.error(`[Forge] Maven文件提取后损坏: ${relativePath}`);
                            try { await fs.promises.unlink(extractPath); } catch (_) {}
                        }
                    } catch (e) {
                        console.error(`[Forge] maven extract error: ${relativePath} - ${e.message}`);
                    }
                    if (++forgeYieldCounter % 30 === 0) await yieldToEventLoop();
                }
            }

            let forgeLibFailures = 0;
            const totalForgeLibs = (versionJsonData.libraries || []).length;
            const FORGE_LIB_PARALLEL = Math.min(parseInt(loadSettingsCached().maxThreads, 10) || 32, 32);

            const forgeLibTasks = [];
            for (const lib of (versionJsonData.libraries || [])) {
                const parts = lib.name ? lib.name.split(':') : [];
                let libPath = null;
                if (lib.downloads?.artifact?.path) {
                    libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                } else if (lib.name && parts.length >= 3) {
                    const groupPath = parts[0].replace(/\./g, path.sep);
                    const lname = parts[1];
                    const lver = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                    libPath = path.join(LIBRARIES_DIR, groupPath, lname, lver, jarName);
                }

                const needsDownload = libPath && !isJarIntact(libPath);
                if (!needsDownload) continue;

                forgeLibTasks.push({ lib, libPath, parts, type: lib.downloads?.artifact?.url ? 'artifact' : 'maven' });
            }

            console.log(`[Forge] 需要下载 ${forgeLibTasks.length}/${totalForgeLibs} 个库文件 (并行: ${FORGE_LIB_PARALLEL})`);

            let forgeLibDone = 0;
            let taskIdx = 0;

            const dlForgeLib = async () => {
                while (true) {
                    const idx = taskIdx++;
                    if (idx >= forgeLibTasks.length) return;
                    const task = forgeLibTasks[idx];
                    const { lib, libPath, parts } = task;

                    if (onProgress && forgeLibDone % 5 === 0) {
                        onProgress(0.10 + (forgeLibDone / totalForgeLibs) * 0.30, `正在下载Forge库文件 (${forgeLibDone}/${forgeLibTasks.length})`);
                    }

                    if (lib.downloads?.artifact?.url) {
                        try {
                            if (fs.existsSync(libPath)) fs.unlinkSync(libPath);
                            await downloadFileWithMirror(lib.downloads.artifact.url, libPath);
                        } catch (e) {
                            forgeLibFailures++;
                            console.log(`[Forge] Failed to download ${lib.name}: ${e.message}`);
                        }
                    } else if (parts.length >= 3) {
                        const mavenGroup = parts[0].replace(/\./g, '/');
                        const lname = parts[1];
                        const lver = parts[2];
                        const classifier = parts.length >= 4 ? parts[3] : '';
                        const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                        const isForgeLib = parts[0].includes('forge') || parts[0].includes('minecraftforge') || parts[0].includes('neoforged') || (parts[0] === 'net.minecraft' && lname === 'client');
                        const baseUrl = lib.url || (isForgeLib ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                        const dlUrl = `${baseUrl}${mavenGroup}/${lname}/${lver}/${jarName}`;
                        try {
                            if (fs.existsSync(libPath)) fs.unlinkSync(libPath);
                            await downloadFileWithMirror(dlUrl, libPath);
                        } catch (e2) {
                            if (isForgeLib) {
                                const altBase = 'https://libraries.minecraft.net/';
                                const altUrl = `${altBase}${mavenGroup}/${lname}/${lver}/${jarName}`;
                                try { await downloadFileWithMirror(altUrl, libPath); } catch (e3) {
                                    forgeLibFailures++;
                                    console.log(`[Forge] Failed to download ${lib.name}: ${e2.message} / ${e3.message}`);
                                }
                            } else {
                                const forgeMirrorUrl = `https://maven.minecraftforge.net/${mavenGroup}/${lname}/${lver}/${jarName}`;
                                try {
                                    await downloadFileWithMirror(forgeMirrorUrl, libPath);
                                } catch (e3) {
                                    forgeLibFailures++;
                                    console.log(`[Forge] Failed to download ${lib.name}: ${e2.message} / ${e3.message}`);
                                }
                            }
                        }
                    }
                    forgeLibDone++;
                }
            };

            const forgeLibPool = [];
            for (let p = 0; p < Math.min(FORGE_LIB_PARALLEL, forgeLibTasks.length || 1); p++) {
                forgeLibPool.push(dlForgeLib());
            }
            await Promise.all(forgeLibPool);

            if (onProgress) onProgress(0.80, '正在创建版本配置...');

            const jsonPath = path.join(versionDir, `${versionId}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(versionJsonData, null, 2));

            try { fs.unlinkSync(installerPath); } catch (e) {}
            try { fs.rmdirSync(path.join(DATA_DIR, 'temp'), { recursive: true }); } catch (e) {}

            console.log(`[Forge] Installation complete: ${versionId}`);
            return { success: true, versionId: versionId };
        } else if (installProfile) {
            const forgeUniversal = installProfile.install?.path;
            if (forgeUniversal) {
                const parts = forgeUniversal.split(':');
                if (parts.length >= 3) {
                    const groupPath = parts[0].replace(/\./g, path.sep);
                    const name = parts[1];
                    const ver = parts[2];
                    const jarName = `${name}-${ver}.jar`;
                    const libPath = path.join(LIBRARIES_DIR, groupPath, name, ver, jarName);

                    if (!fs.existsSync(path.dirname(libPath))) fs.mkdirSync(path.dirname(libPath), { recursive: true });

                    try {
                        const forgeEntry = zip.getEntry(`maven/${groupPath}/${name}/${ver}/${jarName}`);
                        if (forgeEntry && !isJarIntact(libPath)) {
                            try { await fs.promises.unlink(libPath); } catch (_) {}
                            await asyncEnsureDir(path.join(libPath, 'dummy.txt'));
                            await fs.promises.writeFile(libPath, forgeEntry.getData());
                        }
                    } catch (e) {}
                }
            }

            const mavenEntries = zip.getEntries().filter(e => e.entryName.startsWith('maven/'));
            let forgeYieldCounter2 = 0;
            for (const entry of mavenEntries) {
                const relativePath = entry.entryName.replace('maven/', '');
                const extractPath = path.join(LIBRARIES_DIR, relativePath);
                if (!isJarIntact(extractPath)) {
                    await asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                    try {
                        await fs.promises.writeFile(extractPath, entry.getData());
                    } catch (e) {}
                    if (++forgeYieldCounter2 % 30 === 0) await yieldToEventLoop();
                }
            }

            const fallbackJson = {
                id: versionId,
                inheritsFrom: gameVersion,
                mainClass: installProfile.install?.mainClass || 'cpw.mods.modlauncher.Launcher',
                type: 'release',
                libraries: installProfile.libraries || [],
                arguments: {
                    game: ['--fml.forgeVersion', forgeVersion, '--fml.mcVersion', gameVersion, '--fml.forgeGroup', 'net.minecraftforge', '--fml.mcpVersion', ''],
                    jvm: []
                }
            };

            console.log(`[Forge] Fallback mainClass: ${fallbackJson.mainClass}`);

            const fCoreLibs = [];
            if (forgeUniversal) {
                const fParts = forgeUniversal.split(':');
                if (fParts.length >= 3) {
                    const fj = `${fParts[1]}-${fParts[2]}.jar`;
                    fCoreLibs.push(path.join(LIBRARIES_DIR, fParts[0].replace(/\./g, path.sep), fParts[1], fParts[2], fj));
                }
            }
            const fMissing = fCoreLibs.filter(f => !fs.existsSync(f));
            if (fMissing.length > 0) {
                console.warn(`[Forge] Fallback核心库暂缺 (${fMissing.length}个): ${fMissing.join(', ')}, 将由安装后验证补全`);
            }

            const jsonPath = path.join(versionDir, `${versionId}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(fallbackJson, null, 2));
            return { success: true, versionId: versionId, libsMissing: fMissing.length };
        } else {
            throw new Error('Forge 安装包中未找到 version.json 或 install_profile.json，可能是损坏的安装包');
        }

    } catch (e) {
        console.error(`[Forge] Installation failed: ${e.message}`);
        try {
            const versionDir = path.join(VERSIONS_DIR, `${gameVersion}-forge-${forgeVersion}`);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[Forge] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[Forge] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { success: false, error: e.message };
    }
}

async function installNeoForge(gameVersion, neoVersion, onProgress = null) {
    const versionId = `${gameVersion}-neoforge-${neoVersion}`;

    try {
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) {
            return { success: false, error: baseResult.error };
        }

        const versionDir = path.join(VERSIONS_DIR, versionId);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        const neoUrl = `${NEOFORGE_API_URL}/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
        console.log(`[NeoForge] Fetching version data: ${neoUrl}`);
        let neoData;
        try {
            neoData = await fetchJSON(neoUrl);
        } catch (e) {
            const mirrorNeoUrl = `https://bmclapi2.bangbang93.com/maven/api/maven/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
            console.log(`[NeoForge] Retrying with mirror: ${mirrorNeoUrl}`);
            neoData = await fetchJSON(mirrorNeoUrl);
        }

        const versionJson = {
            id: versionId,
            inheritsFrom: gameVersion,
            mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
            type: 'release',
            libraries: [...(neoData.libraries || [])],
            arguments: {
                game: ['--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion],
                jvm: []
            }
        };

        const neoLibsToDownload = [];
        for (const lib of (versionJson.libraries || [])) {
            const parts = lib.name ? lib.name.split(':') : [];
            let libPath = null;
            if (lib.downloads?.artifact?.path) {
                libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
            } else if (lib.name && parts.length >= 3) {
                const groupPath = parts[0].replace(/\./g, path.sep);
                const lname = parts[1];
                const lver = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                libPath = path.join(LIBRARIES_DIR, groupPath, lname, lver, jarName);
            }

            if (!libPath || isJarIntact(libPath)) continue;

            if (lib.downloads?.artifact?.url) {
                neoLibsToDownload.push({ lib, url: lib.downloads.artifact.url, libPath });
            } else if (parts.length >= 3) {
                const mavenGroup = parts[0].replace(/\./g, '/');
                const lname = parts[1];
                const lver = parts[2];
                const classifier = parts.length >= 4 ? parts[3] : '';
                const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
                const baseUrl = lib.url || 'https://maven.neoforged.net/';
                const dlUrl = `${baseUrl}${mavenGroup}/${lname}/${lver}/${jarName}`;
                neoLibsToDownload.push({ lib, url: dlUrl, libPath });
            }
        }

        let neoLibFailures = 0;
        if (neoLibsToDownload.length > 0) {
            const settings = loadSettingsCached();
            const NEO_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 8, neoLibsToDownload.length);
            let completed = 0;
            let active = 0;
            let done = null;

            const scheduleNext = () => {
                while (active < NEO_PARALLEL && completed + active < neoLibsToDownload.length) {
                    const item = neoLibsToDownload[completed + active];
                    active++;
                    (async () => {
                        try {
                            if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath);
                            await downloadFileWithMirror(item.url, item.libPath);
                        } catch (e) {
                            neoLibFailures++;
                            console.log(`[NeoForge] Failed to download ${item.lib.name}: ${e.message}`);
                        }
                    })().then(() => {
                        completed++;
                    }).catch(() => {}).finally(() => {
                        active--;
                        if (onProgress) {
                            onProgress(completed / neoLibsToDownload.length, `下载NeoForge库 (${completed}/${neoLibsToDownload.length})...`);
                        }
                        if (active === 0 && completed >= neoLibsToDownload.length && done) done();
                        else if (active < NEO_PARALLEL && completed + active < neoLibsToDownload.length) scheduleNext();
                    });
                }
            };

            await new Promise(resolve => { done = resolve; scheduleNext(); });
        }

        const neoCoreLibs = [];
        const neoMainLib = versionJson.libraries.find(l => l.name && l.name.startsWith('net.neoforged:neoforge:'));
        if (neoMainLib) {
            const np = neoMainLib.name.split(':');
            const nj = `${np[1]}-${np[2]}.jar`;
            neoCoreLibs.push(path.join(LIBRARIES_DIR, np[0].replace(/\./g, path.sep), np[1], np[2], nj));
        }
        const neoMissing = neoCoreLibs.filter(f => !fs.existsSync(f));
        if (neoMissing.length > 0) {
            console.warn(`[NeoForge] 核心库文件暂缺 (${neoMissing.length}个): ${neoMissing.join(', ')}, 将由安装后验证补全`);
        }

        const jsonPath = path.join(versionDir, `${versionId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        console.log(`[NeoForge] JSON已写入, libs缺失=${neoMissing.length}`);
        return { success: true, versionId: versionId, libsMissing: neoMissing.length };
    } catch (e) {
        console.error(`[NeoForge] Installation failed: ${e.message}`);
        try {
            const versionDir = path.join(VERSIONS_DIR, `${gameVersion}-neoforge-${neoVersion}`);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[NeoForge] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[NeoForge] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { success: false, error: e.message };
    }
}

async function mergeFabricLoaderToVersion(versionId, gameVersion, loaderVersion, onProgress = null) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    const metaUrl = `${FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
    console.log(`[Fabric] Fetching profile for merge: ${metaUrl}`);
    let profileData;
    try {
        profileData = await fetchJSON(metaUrl);
    } catch (e) {
        const mirrorMetaUrl = `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${gameVersion}/${loaderVersion}`;
        console.log(`[Fabric] Retrying with mirror: ${mirrorMetaUrl}`);
        profileData = await fetchJSON(mirrorMetaUrl);
    }

    const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    if (profileData.launcherMeta) {
        const launcherMeta = profileData.launcherMeta;
        if (launcherMeta.mainClass) {
            versionJson.mainClass = typeof launcherMeta.mainClass === 'string'
                ? launcherMeta.mainClass
                : (launcherMeta.mainClass.client || versionJson.mainClass);
        }
        if (launcherMeta.libraries) {
            const common = launcherMeta.libraries.common || [];
            const client = launcherMeta.libraries.client || [];
            const fabricLibs = [...common, ...client];
            for (const lib of fabricLibs) {
                if (!lib.downloads || !lib.downloads.artifact || !lib.downloads.artifact.path) {
                    if (lib.name) {
                        const parts = lib.name.split(':');
                        if (parts.length >= 3) {
                            const groupPath = parts[0].replace(/\./g, '/');
                            const name = parts[1];
                            const ver = parts[2];
                            lib.downloads = lib.downloads || {};
                            lib.downloads.artifact = lib.downloads.artifact || {};
                            lib.downloads.artifact.path = `${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
                            const baseUrl = lib.url || 'https://maven.fabricmc.net/';
                            lib.downloads.artifact.url = `${baseUrl}${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
                            console.log(`[Fabric] 构造库URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
                        }
                    }
                } else if (lib.downloads?.artifact?.url) {
                    console.log(`[Fabric] 库已有URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
                }
            }
            versionJson.libraries = [...(versionJson.libraries || []), ...fabricLibs];
            console.log(`[Fabric] 添加了 ${fabricLibs.length} 个库到版本 ${versionId}`);

            if (profileData.loader && profileData.loader.maven) {
                const loaderMavenParts = profileData.loader.maven.split(':');
                if (loaderMavenParts.length >= 3) {
                    const loaderGroup = loaderMavenParts[0].replace(/\./g, '/');
                    const loaderName = loaderMavenParts[1];
                    const loaderVer = loaderMavenParts[2];
                    const loaderJarName = `${loaderName}-${loaderVer}.jar`;
                    versionJson.libraries.push({
                        name: profileData.loader.maven,
                        url: 'https://maven.fabricmc.net/',
                        downloads: {
                            artifact: {
                                path: `${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                                url: `https://maven.fabricmc.net/${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                                sha1: '',
                                size: 0
                            }
                        }
                    });
                    console.log(`[Fabric] 添加 fabric-loader: ${profileData.loader.maven}`);
                }
            }

            if (profileData.intermediary && profileData.intermediary.maven && profileData.intermediary.version !== '0.0.0') {
                const interMavenParts = profileData.intermediary.maven.split(':');
                if (interMavenParts.length >= 3) {
                    const interGroup = interMavenParts[0].replace(/\./g, '/');
                    const interName = interMavenParts[1];
                    const interVer = interMavenParts[2];
                    const interJarName = `${interName}-${interVer}.jar`;
                    versionJson.libraries.push({
                        name: profileData.intermediary.maven,
                        url: 'https://maven.fabricmc.net/',
                        downloads: {
                            artifact: {
                                path: `${interGroup}/${interName}/${interVer}/${interJarName}`,
                                url: `https://maven.fabricmc.net/${interGroup}/${interName}/${interVer}/${interJarName}`,
                                sha1: '',
                                size: 0
                            }
                        }
                    });
                    console.log(`[Fabric] 添加 intermediary: ${profileData.intermediary.maven}`);
                }
            }
        }
    }

    if (profileData.loader) {
        if (profileData.loader.mainClass && !versionJson.mainClass) {
            versionJson.mainClass = profileData.loader.mainClass;
        }
    }

    if (!versionJson.mainClass) {
        versionJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
    }

    console.log(`[Fabric] 主类: ${versionJson.mainClass}`);
    console.log(`[Fabric] 开始下载库文件...`);

    const libsToDownload = (versionJson.libraries || []).filter(lib => {
        if (!lib.downloads?.artifact?.path) return false;
        const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
        return !fs.existsSync(libPath);
    });

    const downloadErrors = [];
    if (libsToDownload.length > 0) {
        const settings = loadSettingsCached();
        const FABRIC_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 8, libsToDownload.length);
        let completed = 0;
        let active = 0;
        let done = null;

        const scheduleNext = () => {
            while (active < FABRIC_PARALLEL && completed + active < libsToDownload.length) {
                const lib = libsToDownload[completed + active];
                active++;
                (async () => {
                    const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                    const libUrl = lib.downloads.artifact.url
                        || `https://maven.fabricmc.net/${lib.downloads.artifact.path}`;
                    console.log(`[Fabric] 下载库: ${lib.name || lib.downloads.artifact.path}`);
                    try {
                        await downloadFileWithMirror(libUrl, libPath);
                        console.log(`[Fabric] 下载成功: ${lib.name}`);
                    } catch (e) {
                        console.error(`[Fabric] 下载失败: ${lib.name} - ${e.message}`);
                        downloadErrors.push({ name: lib.name, url: libUrl, error: e.message });
                    }
                })().then(() => {
                    completed++;
                }).catch(() => {}).finally(() => {
                    active--;
                    if (onProgress) {
                        onProgress(completed / libsToDownload.length, `下载Fabric库 (${completed}/${libsToDownload.length})...`);
                    }
                    if (active === 0 && completed >= libsToDownload.length && done) done();
                    else if (active < FABRIC_PARALLEL && completed + active < libsToDownload.length) scheduleNext();
                });
            }
        };

        await new Promise(resolve => { done = resolve; scheduleNext(); });
    }

    if (downloadErrors.length > 0) {
        console.error(`[Fabric] 有 ${downloadErrors.length} 个库下载失败:`);
        for (const err of downloadErrors) {
            console.error(`  - ${err.name}: ${err.url} (${err.error})`);
        }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
    console.log(`[Fabric] Loader merged into version: ${versionId}`);
}

async function mergeForgeLoaderToVersion(versionId, gameVersion, forgeVersion) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);
    const AdmZip = require('adm-zip');

    const installerUrl = `${FORGE_MAVEN_URL}/${gameVersion}-${forgeVersion}/forge-${gameVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(DATA_DIR, 'temp', `forge-installer-${gameVersion}-${forgeVersion}.jar`);
    if (!fs.existsSync(path.dirname(installerPath))) fs.mkdirSync(path.dirname(installerPath), { recursive: true });

    console.log(`[Forge] Downloading installer: ${installerUrl}`);
    await downloadFileWithMirror(installerUrl, installerPath);

    const zip = new AdmZip(installerPath);
    const versionEntry = zip.getEntry('version.json') || zip.getEntry(`${gameVersion}-forge-${forgeVersion}.json`);

    if (versionEntry) {
        const forgeJson = JSON.parse(versionEntry.getData().toString('utf8'));
        forgeJson.id = versionId;
        forgeJson.inheritsFrom = gameVersion;
        if (!forgeJson.type) forgeJson.type = 'release';

        const currentJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        mergeVersionJsonProperties(currentJson, forgeJson);

        fs.writeFileSync(jsonPath, JSON.stringify(currentJson, null, 2));

        const mavenEntries2 = zip.getEntries().filter(e => e.entryName.startsWith('maven/'));
        console.log(`[Forge-merge] 先提取 maven 文件: ${mavenEntries2.length} entries`);
        let mergeYieldCounter = 0;
        for (const entry of mavenEntries2) {
            const relativePath = entry.entryName.replace('maven/', '');
            const extractPath = path.join(LIBRARIES_DIR, relativePath);
            if (!fs.existsSync(extractPath)) {
                await asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                try { await fs.promises.writeFile(extractPath, entry.getData()); } catch (e) {
                    console.error(`[Forge-merge] 解压Maven文件失败: ${relativePath} - ${e.message}`);
                }
            } else if (extractPath.endsWith('.jar') && !isJarIntact(extractPath)) {
                try { await fs.promises.unlink(extractPath); } catch (_) {}
                await asyncEnsureDir(path.join(extractPath, 'dummy.txt'));
                try { await fs.promises.writeFile(extractPath, entry.getData()); } catch (e) {
                    console.error(`[Forge-merge] 重写损坏Maven文件失败: ${relativePath} - ${e.message}`);
                }
            }
            if (++mergeYieldCounter % 30 === 0) await yieldToEventLoop();
        }

        for (const lib of (currentJson.libraries || [])) {
            if (lib.downloads?.artifact?.path) {
                const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                if (!fs.existsSync(libPath) && lib.downloads.artifact.url) {
                    try {
                        await downloadFileWithMirror(lib.downloads.artifact.url, libPath);
                        if (libPath.endsWith('.jar') && !isJarIntact(libPath)) {
                            throw new Error(`下载后JAR损坏: ${path.basename(libPath)}`);
                        }
                    } catch (e) {
                        console.error(`[Forge-merge] 库下载失败: ${lib.downloads.artifact.path} - ${e.message}`);
                        try { fs.unlinkSync(libPath); } catch (_) {}
                    }
                }
            }
        }
    } else {
        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.mainClass = 'cpw.mods.modlauncher.Launcher';
        versionJson.arguments = versionJson.arguments || {};
        versionJson.arguments.game = versionJson.arguments.game || [];
        versionJson.arguments.game.push('--fml.forgeVersion', forgeVersion, '--fml.mcVersion', gameVersion, '--fml.forgeGroup', 'net.minecraftforge');
        versionJson.libraries = versionJson.libraries || [];
        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
    }

    try { fs.unlinkSync(installerPath); } catch (e) {}
    console.log(`[Forge] Loader merged into version: ${versionId}`);
}

// ============================================================================
// 模组加载器版本合并 - 将加载器特有的配置合并到版本JSON中
// ============================================================================

function mergeVersionJsonProperties(target, source) {
    if (source.mainClass) target.mainClass = source.mainClass;
    if (source.libraries) {
        target.libraries = [...(target.libraries || []), ...source.libraries];
    }
    if (source.arguments) {
        target.arguments = target.arguments || {};
        if (source.arguments.game) {
            target.arguments.game = [...(target.arguments.game || []), ...source.arguments.game];
        }
        if (source.arguments.jvm) {
            target.arguments.jvm = [...(target.arguments.jvm || []), ...source.arguments.jvm];
        }
    }
}

async function mergeNeoForgeLoaderToVersion(versionId, gameVersion, neoVersion, onProgress = null) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    const neoUrl = `${NEOFORGE_API_URL}/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
    console.log(`[NeoForge] Fetching: ${neoUrl}`);

    try {
        let neoData;
        try {
            neoData = await fetchJSON(neoUrl);
        } catch (e) {
            const mirrorNeoUrl = `https://bmclapi2.bangbang93.com/maven/api/maven/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
            console.log(`[NeoForge] Retrying with mirror: ${mirrorNeoUrl}`);
            neoData = await fetchJSON(mirrorNeoUrl);
        }
        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.mainClass = 'cpw.mods.bootstraplauncher.BootstrapLauncher';
        versionJson.libraries = [...(versionJson.libraries || []), ...(neoData.libraries || [])];
        versionJson.arguments = versionJson.arguments || {};
        versionJson.arguments.game = versionJson.arguments.game || [];
        versionJson.arguments.game.push('--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion);

        const libsToDownload = (versionJson.libraries || []).filter(lib => {
            if (!lib.downloads?.artifact?.url) return false;
            const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
            return !fs.existsSync(libPath);
        });

        if (libsToDownload.length > 0) {
            const settings = loadSettingsCached();
            const NEO_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 8, libsToDownload.length);
            let completed = 0;
            let active = 0;
            let done = null;

            const scheduleNext = () => {
                while (active < NEO_PARALLEL && completed + active < libsToDownload.length) {
                    const lib = libsToDownload[completed + active];
                    active++;
                    (async () => {
                        const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                        try {
                            await downloadFileWithMirror(lib.downloads.artifact.url, libPath);
                            if (libPath.endsWith('.jar') && !isJarIntact(libPath)) {
                                throw new Error(`下载后JAR损坏: ${path.basename(libPath)}`);
                            }
                        } catch (e) {
                            console.error(`[NeoForge] 库下载失败: ${lib.downloads.artifact.path} - ${e.message}`);
                            try { fs.unlinkSync(libPath); } catch (_) {}
                        }
                    })().then(() => {
                        completed++;
                    }).catch(() => {}).finally(() => {
                        active--;
                        if (onProgress) {
                            onProgress(completed / libsToDownload.length, `下载NeoForge库 (${completed}/${libsToDownload.length})...`);
                        }
                        if (active === 0 && completed >= libsToDownload.length && done) done();
                        else if (active < NEO_PARALLEL && completed + active < libsToDownload.length) scheduleNext();
                    });
                }
            };

            await new Promise(resolve => { done = resolve; scheduleNext(); });
        }

        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        console.log(`[NeoForge] Loader merged into version: ${versionId}`);
    } catch (e) {
        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.mainClass = 'cpw.mods.bootstraplauncher.BootstrapLauncher';
        versionJson.arguments = versionJson.arguments || {};
        versionJson.arguments.game = versionJson.arguments.game || [];
        versionJson.arguments.game.push('--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion);
        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
    }
}

async function mergeOptiFineToVersion(versionId, gameVersion, optiFineVersion, onProgress = null) {
    const versionDir = path.join(VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    try {
        if (onProgress) onProgress(0, '下载OptiFine...');
        const optiFineApiUrl = `https://optifine.net/downloadx?f=OptiFine_${gameVersion}_${optiFineVersion}.jar&x=${Date.now()}`;
        const optiFinePath = path.join(DATA_DIR, 'temp', `OptiFine-${gameVersion}-${optiFineVersion}.jar`);
        if (!fs.existsSync(path.dirname(optiFinePath))) fs.mkdirSync(path.dirname(optiFinePath), { recursive: true });

        await downloadFileWithMirror(optiFineApiUrl, optiFinePath);
        if (onProgress) onProgress(1, 'OptiFine下载完成');

        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.libraries = versionJson.libraries || [];
        const optiFineLib = {
            name: `optifine:OptiFine:${gameVersion}_${optiFineVersion}`,
            downloads: {
                artifact: {
                    path: `optifine/OptiFine/${gameVersion}_${optiFineVersion}/OptiFine-${gameVersion}_${optiFineVersion}.jar`,
                    sha1: '',
                    size: 0,
                    url: ''
                }
            }
        };

        const targetLibPath = path.join(LIBRARIES_DIR, optiFineLib.downloads.artifact.path);
        if (!fs.existsSync(path.dirname(targetLibPath))) fs.mkdirSync(path.dirname(targetLibPath), { recursive: true });
        fs.copyFileSync(optiFinePath, targetLibPath);
        try { fs.unlinkSync(optiFinePath); } catch (e) {}

        if (!versionJson.libraries.some(l => l.name === optiFineLib.name)) {
            versionJson.libraries.unshift(optiFineLib);
        }

        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        console.log(`[OptiFine] Installed into version: ${versionId}`);
    } catch (e) {
        console.log(`[OptiFine] Install failed: ${e.message}`);
    }
}

async function getFabricLoaderVersions() {
    try {
        const data = await fetchJSON(`${FABRIC_META_URL}/versions/loader`);
        return data.map(v => ({
            version: v.version,
            stable: v.stable
        }));
    } catch (e) {
        return [];
    }
}

async function getFabricLoaderVersionsForGame(gameVersion) {
    try {
        const data = await fetchJSON(`${FABRIC_META_URL}/versions/loader/${gameVersion}`);
        return data.map(v => ({
            version: v.loader.version,
            stable: v.loader.stable
        }));
    } catch (e) {
        return [];
    }
}

async function getNeoForgeVersionsForGame(gameVersion) {
    try {
        const apiUrl = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
        console.log('[NeoForge] Fetching versions from:', apiUrl);
        const data = await fetchJSON(apiUrl);
        const allVersions = data.versions || [];
        console.log('[NeoForge] API returned', allVersions.length, 'versions, first 5:', allVersions.slice(0, 5));
        
        const versions = [];
        const mcParts = gameVersion.split('.');
        const mcMajor = mcParts[1] || '0';
        const mcMinor = mcParts[2] || '0';
        const neoPrefix = mcMajor + '.' + mcMinor;
        
        for (const ver of allVersions) {
            if (typeof ver !== 'string') continue;
            if (ver.startsWith(neoPrefix + '.') || ver.startsWith(neoPrefix + '-')) {
                versions.push({ version: ver, gameVersion: gameVersion, type: 'release' });
            }
        }
        
        if (versions.length === 0) {
            console.log('[NeoForge] No versions with prefix', neoPrefix, ', returning latest 10');
            const latest = allVersions.filter(v => typeof v === 'string').slice(-10).reverse();
            for (const ver of latest) {
                versions.push({ version: ver, gameVersion: gameVersion, type: 'release' });
            }
        }
        
        console.log('[NeoForge] Found', versions.length, 'versions for MC', gameVersion);
        versions.reverse();
        if (versions.length > 0) {
            versions[0].type = '推荐';
        }
        
        return versions.slice(0, 10);
    } catch (e) {
        console.error('[NeoForge] Error fetching versions:', e.message);
        return [];
    }
}

async function autoDownloadFabricApi(gameVersion, versionId, onProgress = null) {
    try {
        if (onProgress) onProgress(0, '正在获取最新 Fabric API...');
        console.log(`[FabricAPI] 搜索兼容 MC ${gameVersion} 的 Fabric API...`);

        const searchUrl = `${MODRINTH_API}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
        let versions;
        try {
            versions = await fetchJSON(searchUrl);
        } catch (e) {
            const mirrorUrl = `${MODRINTH_API_MIRROR}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
            console.log(`[FabricAPI] 主API失败，尝试镜像: ${e.message}`);
            versions = await fetchJSON(mirrorUrl);
        }

        if (!versions || versions.length === 0) {
            console.log(`[FabricAPI] 未找到兼容 MC ${gameVersion} 的 Fabric API 版本`);
            return { success: false, message: '未找到兼容版本' };
        }

        const latestVersion = versions[0];
        const primaryFile = latestVersion.files?.find(f => f.primary) || latestVersion.files?.[0];
        if (!primaryFile) {
            console.log(`[FabricAPI] 版本 ${latestVersion.version_number} 没有可下载文件`);
            return { success: false, message: '无可下载文件' };
        }

        const modsDir = getVersionModsDir(versionId);
        if (!modsDir) {
            console.log(`[FabricAPI] 无法确定版本 ${versionId} 的 mods 目录`);
            return { success: false, message: '无法确定mods目录' };
        }
        if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

        const destPath = path.join(modsDir, primaryFile.filename);
        if (fs.existsSync(destPath)) {
            console.log(`[FabricAPI] ${primaryFile.filename} 已存在，跳过下载`);
            return { success: true, message: '已存在', fileName: primaryFile.filename };
        }

        if (onProgress) onProgress(0.3, `下载 Fabric API ${latestVersion.version_number}...`);
        console.log(`[FabricAPI] 下载: ${primaryFile.filename} (${primaryFile.url})`);

        await downloadFileWithMirror(primaryFile.url, destPath, (p) => {
            if (onProgress) onProgress(0.3 + p.progress * 0.007, `下载 Fabric API...`);
        });

        console.log(`[FabricAPI] 下载完成: ${primaryFile.filename}`);
        if (onProgress) onProgress(1, `Fabric API 安装完成`);
        return { success: true, fileName: primaryFile.filename, version: latestVersion.version_number };
    } catch (e) {
        console.error(`[FabricAPI] 自动下载失败: ${e.message}`);
        return { success: false, message: e.message };
    }
}

async function performInstallation(sessionId, versionDetails) {
    const session = installSessions.get(sessionId);
    if (!session) return;

    const isAborted = () => {
        return session.status === 'cancelled' || (session._abortController && session._abortController.signal.aborted);
    };
    const abortCleanup = () => {
        if (speedSyncTimer) clearInterval(speedSyncTimer);
        const vd = path.join(VERSIONS_DIR, versionDetails.id);
        fs.promises.rm(vd, { recursive: true, force: true }).then(() => {
            console.log(`[Install] 已清理中止的安装: ${versionDetails.id}`);
        }).catch(() => {});
    };

    if (isAborted()) { abortCleanup(); return; }

    const versionId = versionDetails.id;
    const versionDir = path.join(VERSIONS_DIR, versionId);
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    try {
        if (isAborted()) { abortCleanup(); return; }
        session.status = 'downloading';
        session.stage = 'version_json';
        session.message = '下载版本信息...';
        session.progress = 2;

        var speedSyncTimer = setInterval(() => {
            if (session.status === 'downloading') {
                session.speed = DownloadManager.getSpeed();
            }
        }, 200);

        const versionJsonPath = path.join(versionDir, `${versionId}.json`);
        fs.writeFileSync(versionJsonPath, JSON.stringify(versionDetails, null, 2));

        if (isAborted()) { abortCleanup(); return; }
        session.stage = 'client_jar';
        session.message = '下载游戏客户端..';
        session.progress = 5;

        if (versionDetails.downloads?.client) {
            const clientInfo = versionDetails.downloads.client;
            const clientJarPath = path.join(versionDir, `${versionId}.jar`);

            if (!fs.existsSync(clientJarPath) || fs.statSync(clientJarPath).size !== clientInfo.size) {
                await downloadFileWithMirror(clientInfo.url, clientJarPath, (p) => {
                    session.progress = 5 + p.progress * 0.2;
                    session.speed = p.speed;
                    session.bytesDownloaded = p.bytesDownloaded;
                    session.totalBytes = p.totalBytes;
                    session.currentFile = `${versionId}.jar`;
                    session.message = `下载客户�?${formatSize(p.bytesDownloaded)}/${formatSize(p.totalBytes)}`;
                });

                if (clientInfo.sha1) {
                    session.message = '校验客户端文件..';
                    const sha1 = await calculateSHA1(clientJarPath);
                    if (sha1 !== clientInfo.sha1) {
                        throw new Error(`客户端文件校验失�? SHA1不匹配`);
                    }
                }
            }
        }

        session.stage = 'libraries';
        session.message = '下载依赖库文件..';
        session.progress = 25;
        session.currentFile = '';
        session.speed = 0;

        const libraries = versionDetails.libraries || [];
        const validLibraries = libraries.filter(lib => {
            if (lib.rules) {
                return evaluateRules(lib.rules);
            }
            return true;
        });

        session.totalFiles = validLibraries.length;
        session.completedFiles = 0;

        const settings = loadSettingsCached();
        const LIB_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 16, validLibraries.length);
        let libCompleted = 0;

        const downloadOneLib = async (lib, idx) => {
            if (isAborted()) return;

            if (lib.downloads?.artifact) {
                const artifact = lib.downloads.artifact;
                const libPath = artifact.path;
                let libUrl = artifact.url;
                if (!libUrl && lib.url) {
                    libUrl = lib.url + (lib.url.endsWith('/') ? '' : '/') + libPath;
                }
                const libFile = path.join(LIBRARIES_DIR, libPath);

                if (!fs.existsSync(libFile) || (artifact.size && fs.statSync(libFile).size !== artifact.size)) {
                    try {
                        await downloadFileWithMirror(libUrl, libFile, (p) => {
                            const baseProgress = 25 + (idx / validLibraries.length) * 30;
                            const libProgress = (p.progress / 100) * (30 / validLibraries.length);
                            session.progress = baseProgress + libProgress;
                            session.speed = p.speed || DownloadManager.getSpeed();
                            session.bytesDownloaded = p.bytesDownloaded;
                            session.totalBytes = p.totalBytes;
                            session.message = `下载库文件 (${idx + 1}/${validLibraries.length}): ${path.basename(libPath)}`;
                        });

                        if (artifact.sha1) {
                            const sha1 = await calculateSHA1(libFile);
                            if (sha1 !== artifact.sha1) {
                                console.warn(`Library SHA1 mismatch: ${libPath}`);
                                try { fs.unlinkSync(libFile); } catch (_) {}
                                session.errors.push(`库文件校验失败: ${libPath}`);
                            }
                        } else if (libFile.endsWith('.jar') && !isJarIntact(libFile)) {
                            console.warn(`Library JAR corrupt after download: ${lib.name || libPath}`);
                            try { fs.unlinkSync(libFile); } catch (_) {}
                            session.errors.push(`库文件损坏: ${lib.name || libPath}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to download library ${libPath}: ${e.message}`);
                        session.errors.push(`库文件下载失败: ${libPath}`);
                    }
                }
            } else if (lib.name) {
                const parts = lib.name.split(':');
                const libNameSuffix = parts.length >= 4 ? parts[3] : '';
                if (libNameSuffix.startsWith('natives-')) {
                    const currentPlatform = process.platform === 'win32' ? 'windows' :
                                           process.platform === 'darwin' ? 'osx' : 'linux';
                    const platformNative = libNameSuffix.replace('natives-', '');
                    let isValidPlatform = false;
                    if (process.arch === 'x64') {
                        isValidPlatform = platformNative === currentPlatform || platformNative === currentPlatform + '-x64';
                    } else if (process.arch === 'ia32') {
                        isValidPlatform = platformNative === currentPlatform + '-x86' || platformNative === currentPlatform;
                    } else if (process.arch === 'arm64') {
                        isValidPlatform = platformNative === currentPlatform + '-arm64' || platformNative === currentPlatform;
                    }
                    if (isValidPlatform && parts.length >= 4) {
                        const nGroupPath = parts[0].replace(/\./g, '/');
                        const nName = parts[1];
                        const nVer = parts[2];
                        const nClassifier = parts[3];
                        const nJarName = `${nName}-${nVer}-${nClassifier}.jar`;
                        const nativeFile = path.join(LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), nName, nVer, nJarName);
                        if (!fs.existsSync(nativeFile)) {
                            const baseUrl = lib.url || 'https://libraries.minecraft.net/';
                            const nativeUrl = `${baseUrl}${nGroupPath}/${nName}/${nVer}/${nJarName}`;
                            try {
                                await downloadFileWithMirror(nativeUrl, nativeFile, (p) => {
                                    session.message = `下载原生库: ${nJarName}`;
                                });
                            } catch (e) {
                                console.warn(`Failed to download native ${lib.name}: ${e.message}`);
                                session.errors.push(`原生库下载失败: ${lib.name}`);
                            }
                        }
                    }
                } else if (parts.length >= 3) {
                    const groupPath = parts[0].replace(/\./g, '/');
                    const lname = parts[1];
                    const lversion = parts[2];
                    const classifier = parts.length >= 4 ? parts[3] : '';
                    const jarName = classifier ? `${lname}-${lversion}-${classifier}.jar` : `${lname}-${lversion}.jar`;
                    const libFile = path.join(LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), lname, lversion, jarName);

                    if (!fs.existsSync(libFile)) {
                        const isForgeLib = parts[0].includes('forge') || parts[0].includes('minecraftforge') || parts[0].includes('neoforged') || (parts[0] === 'net.minecraft' && lname !== 'client' && lname !== 'server');
                        const baseUrl = lib.url || (isForgeLib ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
                        const downloadUrl = `${baseUrl}${groupPath}/${lname}/${lversion}/${jarName}`;

                        try {
                            await downloadFileWithMirror(downloadUrl, libFile, (p) => {
                                const baseProgress = 25 + (idx / validLibraries.length) * 30;
                                const libProgress = (p.progress / 100) * (30 / validLibraries.length);
                                session.progress = baseProgress + libProgress;
                                session.message = `下载库文件 (${idx + 1}/${validLibraries.length}): ${jarName}`;
                            });
                            if (libFile.endsWith('.jar') && !isJarIntact(libFile)) {
                                console.warn(`Library JAR corrupt after download: ${lib.name}`);
                                try { fs.unlinkSync(libFile); } catch (_) {}
                                session.errors.push(`库文件损坏: ${lib.name}`);
                            }
                        } catch (e) {
                            console.warn(`Failed to download library ${lib.name}: ${e.message}`);
                            session.errors.push(`库文件下载失败: ${lib.name}`);
                        }
                    }
                }
            }

            if (lib.natives) {
                const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                if (nativeKey) {
                    const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                    const nativeDownload = lib.downloads?.classifiers?.[classifier];
                    if (nativeDownload) {
                        const nativeFile = path.join(LIBRARIES_DIR, nativeDownload.path);
                        if (!fs.existsSync(nativeFile)) {
                            try {
                                await downloadFileWithMirror(nativeDownload.url, nativeFile, (p) => {
                                    session.speed = p.speed || DownloadManager.getSpeed();
                                    session.bytesDownloaded = p.bytesDownloaded;
                                    session.totalBytes = p.totalBytes;
                                    session.message = `下载原生库: ${path.basename(nativeDownload.path)}`;
                                });
                            } catch (e) {
                                console.warn(`Failed to download native ${nativeDownload.path}: ${e.message}`);
                                session.errors.push(`原生库下载失败: ${path.basename(nativeDownload.path)}`);
                            }
                        }
                    }
                }
            }
        };

        {
            let libIndex = 0;
            let libActive = 0;
            let libDone = null;

            const scheduleNext = () => {
                while (libActive < LIB_PARALLEL && libIndex < validLibraries.length) {
                    if (isAborted()) break;
                    const curIdx = libIndex++;
                    libActive++;
                    session.currentFile = validLibraries[curIdx].name || 'unknown';
                    downloadOneLib(validLibraries[curIdx], curIdx).then(() => {
                        libCompleted++;
                        session.completedFiles = libCompleted;
                    }).catch(() => {}).finally(() => {
                        libActive--;
                        if (libActive === 0 && libIndex >= validLibraries.length && libDone) libDone();
                        else if (libActive < LIB_PARALLEL && libIndex < validLibraries.length) scheduleNext();
                    });
                }
            };

            await new Promise((resolve) => { libDone = resolve; scheduleNext(); });
        }

        session.completedFiles = validLibraries.length;
        session.progress = 60;

        session.stage = 'assets';
        session.message = '下载资源索引...';
        session.progress = 65;
        session.currentFile = '';
        session.speed = 0;

        if (versionDetails.assetIndex) {
            const assetIndexInfo = versionDetails.assetIndex;
            const assetIndexDir = path.join(ASSETS_DIR, 'indexes');
            if (!fs.existsSync(assetIndexDir)) fs.mkdirSync(assetIndexDir, { recursive: true });

            const assetIndexPath = path.join(assetIndexDir, `${assetIndexInfo.id}.json`);

            if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !await verifyFileSha1(assetIndexPath, assetIndexInfo.sha1))) {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await downloadFileWithMirror(assetIndexInfo.url, assetIndexPath);
            }

            session.message = '解析资源文件列表...';
            session.progress = 68;

            let assetIndexData;
            try {
                assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
            } catch (e) {
                throw new Error('无法解析资源索引文件');
            }

            const assetObjects = assetIndexData.objects || {};
            const assetEntries = Object.entries(assetObjects);
            const totalAssets = assetEntries.length;

            const assetSubDirs = new Set();
            for (const [, info] of assetEntries) {
                assetSubDirs.add(info.hash.substring(0, 2));
            }
            for (const sub of assetSubDirs) {
                await fs.promises.mkdir(path.join(ASSETS_DIR, 'objects', sub), { recursive: true });
            }

            session.totalFiles = totalAssets;
            session.completedFiles = 0;
            session.message = `下载资源文件 (0/${totalAssets})...`;

            const ASSET_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
            let assetIndex = 0;
            let assetActive = 0;
            let assetDone = null;
            let processedCount = 0;

            const scheduleNextAsset = () => {
                while (assetActive < ASSET_PARALLEL && assetIndex < assetEntries.length) {
                    if (isAborted()) break;
                    const [name, info] = assetEntries[assetIndex++];
                    assetActive++;
                    (async () => {
                        const hash = info.hash;
                        const subDir = hash.substring(0, 2);
                        const assetPath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                        const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;
                        let needDownload = false;
                        try {
                            const st = await fs.promises.stat(assetPath);
                            if (info.size && st.size !== info.size) needDownload = true;
                        } catch (e) {
                            needDownload = true;
                        }
                        if (needDownload) {
                            try {
                                await downloadFileWithMirror(assetUrl, assetPath, (p) => {
                                    session.speed = p.speed || DownloadManager.getSpeed();
                                    session.bytesDownloaded = p.bytesDownloaded;
                                    session.totalBytes = p.totalBytes;
                                });
                            } catch (e) {
                                session.errors.push(`资源下载失败: ${name}`);
                            }
                        }
                    })().then(() => {
                        processedCount++;
                        session.completedFiles = Math.min(processedCount, totalAssets);
                        session.progress = 68 + (processedCount / totalAssets) * 25;
                        session.currentFile = `资源 ${processedCount}/${totalAssets}`;
                    }).catch(() => {}).finally(() => {
                        assetActive--;
                        if (assetActive === 0 && assetIndex >= assetEntries.length && assetDone) assetDone();
                        else if (assetActive < ASSET_PARALLEL && assetIndex < assetEntries.length) scheduleNextAsset();
                    });
                }
            };

            await new Promise((resolve) => { assetDone = resolve; scheduleNextAsset(); });
            session.message = `下载资源文件 (${processedCount}/${totalAssets})...`;

            if (assetIndexData.map_to_resources) {
                const resourcesDir = path.join(ASSETS_DIR, 'resources');
                if (!fs.existsSync(resourcesDir)) fs.mkdirSync(resourcesDir, { recursive: true });
                session.message = '映射资源文件到resources目录...';
                let mappedCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const sourcePath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                    const destPath = path.join(resourcesDir, name);
                    if (fs.existsSync(sourcePath)) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                        try {
                            if (!fs.existsSync(destPath)) {
                                fs.copyFileSync(sourcePath, destPath);
                            }
                            mappedCount++;
                        } catch (e) {
                            console.warn(`[Assets] 映射资源失败: ${name}: ${e.message}`);
                        }
                    }
                }
                console.log(`[Assets] map_to_resources: 映射了 ${mappedCount} 个资源文件`);
            }

            if (assetIndexData.virtual) {
                const virtualDir = path.join(ASSETS_DIR, 'virtual', 'legacy');
                if (!fs.existsSync(virtualDir)) fs.mkdirSync(virtualDir, { recursive: true });
                session.message = '映射资源文件到virtual目录...';
                let virtualCount = 0;
                for (const [name, info] of assetEntries) {
                    const hash = info.hash;
                    const subDir = hash.substring(0, 2);
                    const sourcePath = path.join(ASSETS_DIR, 'objects', subDir, hash);
                    const destPath = path.join(virtualDir, name);
                    if (fs.existsSync(sourcePath)) {
                        const destDir = path.dirname(destPath);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                        try {
                            if (!fs.existsSync(destPath)) {
                                fs.copyFileSync(sourcePath, destPath);
                            }
                            virtualCount++;
                        } catch (e) {
                            console.warn(`[Assets] 映射虚拟资源失败: ${name}: ${e.message}`);
                        }
                    }
                }
                console.log(`[Assets] virtual: 映射了 ${virtualCount} 个虚拟资源文件`);
            }
        }

        session.stage = 'natives';
        session.message = '提取原生库..';
        session.progress = 93;
        session.currentFile = '';

        extractNatives(versionDetails, versionId);

        session.stage = 'finalizing';
        session.message = '完成安装...';
        session.progress = 90;

        await sleep(300);

        if (session.loaderInfo && session.loaderInfo.type && session.loaderInfo.version) {
            if (session.status === 'cancelled') return;

            const gameVersion = versionDetails.inheritsFrom || versionId;
            session.stage = 'loader';
            session.message = '安装基础版本...';
            session.progress = 91;

            try {
                const baseResult = await ensureBaseVersionInstalled(gameVersion);
                if (baseResult.error) {
                    session.errors.push(`基础版本安装失败: ${baseResult.error}`);
                }
            } catch (baseErr) {
                session.errors.push(`基础版本安装失败: ${baseErr.message}`);
            }

            if (session.status === 'cancelled') return;

            const loaderType = session.loaderInfo.type;
            const loaderVersion = session.loaderInfo.version;
            const forgeVersionId = `${gameVersion}-${loaderType}-${loaderVersion}`;

            session.progress = 94;
            session.message = `正在安装${loaderType === 'neoforge' ? 'NeoForge' : loaderType.charAt(0).toUpperCase() + loaderType.slice(1)}模组加载器...`;

            try {
                let loaderResult = { success: true };
                const loaderProgress = (p, msg) => {
                    if (session.status === 'cancelled') return;
                    session.progress = Math.min(94 + p * 4, 98);
                    if (msg) session.message = msg;
                };

                if (loaderType === 'fabric') {
                    await mergeFabricLoaderToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                } else if (loaderType === 'forge') {
                    loaderResult = await installForge(gameVersion, loaderVersion, (p, msg) => {
                        if (session.status === 'cancelled') return;
                        session.progress = Math.min(94 + p * 4, 98);
                        session.message = msg || `正在安装Forge ${loaderVersion}...`;
                    });
                    if (loaderResult.success && loaderResult.versionId) {
                        const versionJsonPath = path.join(VERSIONS_DIR, versionId, `${versionId}.json`);
                        if (fs.existsSync(versionJsonPath)) {
                            const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
                            vj.inheritsFrom = loaderResult.versionId;
                            fs.writeFileSync(versionJsonPath, JSON.stringify(vj, null, 2));
                            console.log(`[API-install] 设置 inheritsFrom: ${loaderResult.versionId}`);
                        }
                    }
                } else if (loaderType === 'neoforge') {
                    await mergeNeoForgeLoaderToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                } else if (loaderType === 'optifine') {
                    await mergeOptiFineToVersion(versionId, gameVersion, loaderVersion, loaderProgress);
                }

                if (!loaderResult.success) {
                    session.status = 'failed';
                    session.stage = 'failed';
                    session.message = `Forge安装失败: ${loaderResult.error}`;
                    session.errors.push(loaderResult.error);
                    console.error(`[API-install] Forge安装失败: ${loaderResult.error}`);
                    return;
                }

                session.progress = 98;
                session.message = '模组加载器安装完成';
            } catch (loaderErr) {
                session.status = 'failed';
                session.stage = 'failed';
                session.message = `模组加载器安装失败: ${loaderErr.message}`;
                session.errors.push(loaderErr.message);
                console.error(`[Loader] install failed:`, loaderErr.message);
                return;
            }

            const mergedJson = resolveVersionJson(versionId);
            if (mergedJson) {
                extractNatives(mergedJson, versionId);
            }
        }

        if (session.loaderInfo && session.loaderInfo.type === 'fabric') {
            if (session.status === 'cancelled') return;
            const gameVersionForApi = versionDetails.inheritsFrom || versionId.replace(/-.+$/, '');
            session.stage = 'fabric-api';
            session.message = '正在下载 Fabric API...';
            session.progress = 99;

            try {
                const apiResult = await autoDownloadFabricApi(gameVersionForApi, versionId, (p, msg) => {
                    if (session.status === 'cancelled') return;
                    session.progress = Math.min(98 + p, 99.5);
                    if (msg) session.message = msg;
                });
                if (apiResult.success && apiResult.fileName) {
                    console.log(`[Install] Fabric API 已安装: ${apiResult.fileName}`);
                }
            } catch (apiErr) {
                console.warn(`[Install] Fabric API 自动下载失败 (非致命): ${apiErr.message}`);
            }
        }

        session.status = 'completed';
        session.stage = 'completed';
        session.message = `${versionId} 安装完成！`;
        session.progress = 100;
        session.speed = 0;
        if (speedSyncTimer) clearInterval(speedSyncTimer);

        console.log(`Installation completed: ${versionId}`);

    } catch (e) {
        if (speedSyncTimer) clearInterval(speedSyncTimer);
        session.status = 'failed';
        session.stage = 'failed';
        session.message = `安装失败: ${e.message}`;
        session.errors.push(e.message);
        console.error(`Installation failed for ${versionId}:`, e.message);
        
        try {
            const versionDir = path.join(VERSIONS_DIR, versionId);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[Install] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[Install] Failed to cleanup version directory:`, cleanupErr.message);
        }
    }
}

function encodeVarInt(value) {
    const bytes = [];
    do {
        let temp = value & 0x7F;
        value >>>= 7;
        if (value !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (value !== 0);
    return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
        const b = buffer[offset + bytesRead];
        result |= (b & 0x7F) << shift;
        bytesRead++;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, bytesRead };
}

async function mcPing(host, port = 25565, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);

        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(result);
        };

        socket.on('timeout', () => finish({ online: false, error: 'timeout' }));
        socket.on('error', (err) => finish({ online: false, error: err.message }));

        socket.connect(port, host, () => {
            const pingStart = Date.now();

            const handshakeData = [
                encodeVarInt(0),
                encodeVarInt(772),
                encodeVarInt(host.length),
                Buffer.from(host, 'utf8'),
                Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
                encodeVarInt(1)
            ];
            const handshakeBody = Buffer.concat(handshakeData);
            const handshakePacket = Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody]);

            const statusBody = encodeVarInt(0);
            const statusPacket = Buffer.concat([encodeVarInt(statusBody.length), statusBody]);

            socket.write(handshakePacket);
            socket.write(statusPacket);

            const tsBuf = Buffer.alloc(8);
            tsBuf.writeBigInt64BE(BigInt(pingStart));
            const pingPkt = Buffer.concat([Buffer.from([9, 1]), tsBuf]);

            socket.write(pingPkt);

            let data = Buffer.alloc(0);
            socket.on('data', (chunk) => {
                data = Buffer.concat([data, chunk]);

                try {
                    let offset = 0;
                    const packetLen = decodeVarInt(data, offset);
                    offset += packetLen.bytesRead;

                    const packetId = decodeVarInt(data, offset);
                    offset += packetId.bytesRead;

                    if (packetId.value === 0) {
                        const jsonLen = decodeVarInt(data, offset);
                        offset += jsonLen.bytesRead;

                        if (offset + jsonLen.value <= data.length) {
                            const jsonStr = data.slice(offset, offset + jsonLen.value).toString('utf8');
                            const latency = Date.now() - pingStart;

                            try {
                                const status = JSON.parse(jsonStr);
                                finish({
                                    online: true,
                                    version: status.version?.name || 'Unknown',
                                    protocol: status.version?.protocol || 0,
                                    players: {
                                        online: status.players?.online || 0,
                                        max: status.players?.max || 0,
                                        sample: status.players?.sample || []
                                    },
                                    description: typeof status.description === 'string'
                                        ? status.description
                                        : JSON.stringify(status.description),
                                    favicon: status.favicon || null,
                                    latency: latency
                                });
                            } catch (e) {
                                finish({ online: false, error: 'parse error' });
                            }
                        }
                    }
                } catch (e) {
                }
            });
        });
    });
}

async function handleHttpRequest(pathname, req, res, parsedUrl) {
    await handleAPI(pathname, req, res, parsedUrl);
}

// ─── 整合包本地导入（拖拽安装入口）───
/**
 * 从本地文件路径导入整合包（.mrpack / CurseForge .zip）
 * @param {string} filePath  - 本地文件的绝对路径
 * @param {function} onProgress - 进度回调 ({ stage, message, progress: 0-100 })
 * @param {string} targetVersion - 目标版本ID（版本隔离）
 */
async function importModpackFromPath(filePath, onProgress, targetVersion = '', abortSignal = null) {
    const progress = (stage, message, pct, files, currentFile) => {
        if (typeof onProgress === 'function') onProgress({ stage, message, progress: pct, files: files || [], currentFile: currentFile || '' });
    };

    if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mrpack' && ext !== '.zip') {
        return { success: false, error: '不支持的文件格式，请拖入 .mrpack 或 .zip 整合包' };
    }

    progress('read', '正在读取整合包...', 5);

    let AdmZip;
    try { AdmZip = getAdmZip(); } catch (e) {
        return { success: false, error: e.message };
    }

    let zip;
    try { zip = new AdmZip(filePath); } catch (e) {
        return { success: false, error: '无法读取 ZIP 文件: ' + e.message };
    }

    const modrinthEntry = zip.getEntry('modrinth.index.json');
    const curseEntry    = zip.getEntry('manifest.json');

    let result;
    try {
        if (modrinthEntry) {
            result = await _importMrpack(zip, modrinthEntry, filePath, progress, targetVersion, abortSignal);
        } else if (curseEntry) {
            result = await _importCurseForge(zip, curseEntry, filePath, progress, targetVersion, abortSignal);
        } else {
            result = await _importRawZip(zip, filePath, progress, targetVersion, abortSignal);
        }
        
        if (!result.success && result.versionId) {
            cleanupVersionChain(result.versionId);
            console.log(`[Modpack] Cleaned up failed version chain: ${result.versionId}`);
        }
    } catch (e) {
        console.error(`[Modpack] Import failed:`, e.message, e.stack);
        return { success: false, error: '整合包导入失败: ' + e.message };
    }
    
    return result;
}

async function _importMrpack(zip, manifestEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    const settings = loadSettingsCached();
    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (e) {
        return { success: false, error: '解析 modrinth.index.json 失败: ' + e.message };
    }

    const packName    = (manifest.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    const mcVersion   = manifest.dependencies && manifest.dependencies.minecraft ? manifest.dependencies.minecraft : '';
    const fabricVer   = manifest.dependencies ? manifest.dependencies['fabric-loader'] : undefined;
    const forgeVer    = manifest.dependencies ? manifest.dependencies.forge : undefined;
    const neoforgeVer = manifest.dependencies ? manifest.dependencies.neoforge : undefined;

    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(' [外部]', '');
        const existingDir = path.join(VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[Modpack] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[Modpack] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = packName;
            versionDir = path.join(VERSIONS_DIR, versionId);
            console.log(`[Modpack] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = packName;
        versionDir = path.join(VERSIONS_DIR, versionId);
        console.log(`[Modpack] 未指定目标版本，创建新版本: ${versionId}`);
    }
    
    const isNewVersionDir = !fs.existsSync(path.join(versionDir, `${versionId}.json`));

    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
    }

    if (isNewVersionDir) {
        progress('base', '正在准备基础版本...', 10);
        console.log(`[mrpack] 确保基础版本存在: ${mcVersion}`);
        const baseResult = await ensureBaseVersionInstalled(mcVersion);
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        let loaderVersionId = null;
        if (forgeVer || neoforgeVer || fabricVer) {
            progress('loader-install', '正在安装模组加载器...', 12);
            try {
                if (forgeVer) {
                    loaderVersionId = `${mcVersion}-forge-${forgeVer}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[mrpack] Forge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] 安装模组加载器: Forge ${forgeVer} (MC ${mcVersion})`);
                        const ir = await installForge(mcVersion, forgeVer, (p, msg) => {
                            progress('loader-install', msg || '正在安装Forge...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] Forge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (neoforgeVer) {
                    loaderVersionId = `${mcVersion}-neoforge-${neoforgeVer}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[mrpack] NeoForge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] 安装模组加载器: NeoForge ${neoforgeVer} (MC ${mcVersion})`);
                        const ir = await installNeoForge(mcVersion, neoforgeVer, (p, msg) => {
                            progress('loader-install', msg || '正在安装NeoForge...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] NeoForge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (fabricVer) {
                    loaderVersionId = `fabric-loader-${fabricVer}-${mcVersion}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[mrpack] Fabric ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[mrpack] 安装模组加载器: Fabric ${fabricVer} (MC ${mcVersion})`);
                        const ir = await installFabric(mcVersion, fabricVer, (p, msg) => {
                            progress('loader-install', msg || '正在安装Fabric...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[mrpack] Fabric ${loaderVersionId} 已安装，跳过`);
                    }
                }
            } catch (e) {
                console.error(`[mrpack] 模组加载器安装失败:`, e.stack || e.message);
                try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                return { success: false, versionId, error: e.message };
            }
        }

        progress('version-config', '正在创建版本配置...', 14);

        if (loaderVersionId) {
            const versionJson = {
                id: versionId,
                inheritsFrom: loaderVersionId,
                type: 'release',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            console.log(`[mrpack] 创建版本JSON: ${versionId}.json (继承 ${loaderVersionId})`);
        } else {
            const versionJson = {
                id: versionId,
                inheritsFrom: mcVersion || undefined,
                type: 'release',
                mainClass: 'net.minecraft.client.main.Main',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            console.log(`[mrpack] 创建版本JSON: ${versionId}.json (无加载器)`);
        }

        progress('loader', '模组加载器就绪', 15);
    }

    try {
    progress('extract', '解压覆盖文件...', 17, [], '');
    const entries = zip.getEntries();
    const overrideFiles = [];
    let extractYieldCounter = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        let relPath = null;
        if (entryName.startsWith('overrides/')) {
            relPath = entryName.slice('overrides/'.length);
        } else if (entryName.startsWith('client-overrides/')) {
            relPath = entryName.slice('client-overrides/'.length);
        }
        if (relPath) {
            const destPath = path.join(versionDir, relPath);
            const resolvedDest = path.resolve(destPath);
            const resolvedBase = path.resolve(versionDir);
            if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
                console.warn(`[Modpack] 路径遍历攻击已拦截: ${relPath}`);
                continue;
            }
            await asyncEnsureDir(destPath);
            await fs.promises.writeFile(destPath, entry.getData());
            overrideFiles.push({ name: relPath, status: 'completed', progress: 100 });
            if (++extractYieldCounter % 50 === 0) await yieldToEventLoop();
        }
    }

    const filesList = (manifest.files || []).filter(f => {
        if (f.env && f.env.client === 'unsupported') return false;
        return true;
    });
    const modsDir = path.join(versionDir, 'mods');
    ensureDir(path.join(modsDir, 'dummy.txt'));

    const modFiles = filesList.map(f => {
        const downloads = f.downloads || [];
        const fileName = path.basename(f.path || (downloads[0] || 'unknown'));
        return { name: fileName, status: 'pending', progress: 0, size: f.fileSize || 0 };
    });

    progress('mods', `下载 Mod 文件 (共 ${filesList.length} 个)...`, 25, [...overrideFiles, ...modFiles], '');

    let okCount = 0, failCount = 0;
    let inFlight = 0;
    const PARALLEL_MODS = Math.min(parseInt(settings.maxThreads, 10) || 8, 8);
    let lastProgUpdate = 0;
    let lastReportedPct = 0;

    const getModTimeout = (sizeBytes) => {
        if (sizeBytes > 50 * 1024 * 1024) return 600000;
        if (sizeBytes > 20 * 1024 * 1024) return 300000;
        if (sizeBytes > 5 * 1024 * 1024) return 180000;
        return 120000;
    };

    const updateOverall = () => {
        const now = Date.now();
        let totalPct = 0;
        for (const mf of modFiles) {
            totalPct += (mf.status === 'completed' || mf.status === 'failed') ? 100 : (mf.progress || 0);
        }
        const overallPct = totalPct / Math.max(modFiles.length, 1);
        const pct = 25 + Math.round((overallPct / 100) * 65);
        const clamped = Math.min(pct, 95);
        if (clamped <= lastReportedPct && now - lastProgUpdate < 500) return;
        lastReportedPct = Math.max(lastReportedPct, clamped);
        lastProgUpdate = now;
        const totalDone = okCount + failCount;
        progress('mods', `下载 Mod (${totalDone}/${filesList.length}, ${inFlight}个进行中)`, lastReportedPct, [...overrideFiles, ...modFiles], '');
    };

    const dlMod = async (fileEntry, index) => {
        inFlight++;
        if (abortSignal && abortSignal.aborted) { inFlight--; updateOverall(); return; }
        const downloads = fileEntry.downloads || [];
        if (!downloads.length) {
            if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
            okCount++; inFlight--; updateOverall();
            return;
        }
        const fileName = path.basename(fileEntry.path || (downloads[0] || 'unknown'));
        const destPath = path.join(versionDir, fileEntry.path || path.join('mods', fileName));
        ensureDir(destPath);

        if (modFiles[index]) { modFiles[index].status = 'downloading'; modFiles[index].progress = 0; }
        updateOverall();

        if (!isJarIntact(destPath)) {
            const fileSize = fileEntry.fileSize || 0;
            let downloaded = false;
            const MAX_ROUNDS = 5;

            for (let round = 0; round < MAX_ROUNDS && !downloaded; round++) {
                if (abortSignal && abortSignal.aborted) break;
                if (round > 0) {
                    console.log(`[mrpack] Mod ${fileName} 第${round + 1}轮重试...`);
                    if (modFiles[index]) { modFiles[index].status = 'downloading'; modFiles[index].progress = 0; }
                    await new Promise(r => setTimeout(r, 3000 + round * 2000 + Math.random() * 2000));
                }

                for (let urlIdx = 0; urlIdx < downloads.length && !downloaded; urlIdx++) {
                    if (abortSignal && abortSignal.aborted) break;
                    const tryUrl = downloads[urlIdx];
                    const allUrls = getMirrorUrls(tryUrl);

                    for (const mirrorUrl of allUrls) {
                        if (downloaded || (abortSignal && abortSignal.aborted)) break;
                        const perTryAbort = new AbortController();
                        const perTryTimeout = setTimeout(() => { try { perTryAbort.abort(); } catch (_) {} },
                            round === 0 ? 120000 : 180000);
                        if (abortSignal) {
                            abortSignal.addEventListener('abort', () => { try { perTryAbort.abort(); } catch (_) {} }, { once: true });
                        }
                        try {
                            await _dlSingle(mirrorUrl, destPath, {
                                onProgress: (p) => {
                                    if (p && modFiles[index]) {
                                        modFiles[index].progress = Math.round(p.progress || 0);
                                        modFiles[index].downloaded = p.downloaded || 0;
                                        modFiles[index].speed = p.speed || '';
                                    }
                                    updateOverall();
                                },
                                retries: 3,
                                stallTimeout: 45000,
                                abortSignal: perTryAbort.signal,
                                timeout: getModTimeout(fileSize)
                            });
                            if (isJarIntact(destPath)) {
                                const expectedSha1 = fileEntry.hashes && fileEntry.hashes.sha1;
                                if (expectedSha1) {
                                    const actualSha1 = await calculateSHA1(destPath);
                                    if (actualSha1 === expectedSha1) {
                                        downloaded = true;
                                    } else {
                                        console.warn(`[mrpack] SHA1校验失败: ${fileName} 期望=${expectedSha1} 实际=${actualSha1}`);
                                        try { fs.unlinkSync(destPath); } catch (_) {}
                                    }
                                } else {
                                    downloaded = true;
                                }
                            } else {
                                try { fs.unlinkSync(destPath); } catch (_) {}
                            }
                        } catch (e) {
                            if (abortSignal && abortSignal.aborted) break;
                            try { fs.unlinkSync(destPath); } catch (_) {}
                        } finally {
                            clearTimeout(perTryTimeout);
                        }
                    }
                }
            }

            if (!downloaded && !(abortSignal && abortSignal.aborted)) {
                const projectId = fileEntry.downloads?.[0]?.match(/modrinth\.com\/mod\/([^\/]+)/)?.[1]
                    || fileEntry.modId || '';
                if (projectId) {
                    console.log(`[mrpack] Mod ${fileName} 常规下载失败，尝试通过Modrinth API重新获取下载链接...`);
                    try {
                        const apiRes = await fetchJSON(`https://api.modrinth.com/v2/project/${projectId}/version`);
                        if (apiRes && Array.isArray(apiRes) && apiRes.length > 0) {
                            for (const ver of apiRes) {
                                if (downloaded) break;
                                for (const f of (ver.files || [])) {
                                    if (downloaded) break;
                                    if (f.filename && f.filename === fileName && f.url) {
                                        try {
                                            await _dlSingle(f.url, destPath, {
                                                onProgress: (p) => {
                                                    if (p && modFiles[index]) {
                                                        modFiles[index].progress = Math.round(p.progress || 0);
                                                    }
                                                    updateOverall();
                                                },
                                                retries: 2,
                                                abortSignal,
                                                timeout: 300000
                                            });
                                            if (isJarIntact(destPath)) {
                                                downloaded = true;
                                                console.log(`[mrpack] 通过API重试成功: ${fileName}`);
                                            } else {
                                                try { fs.unlinkSync(destPath); } catch (_) {}
                                            }
                                        } catch (_) {
                                            try { fs.unlinkSync(destPath); } catch (_) {}
                                        }
                                    }
                                }
                            }
                        }
                    } catch (apiErr) {
                        console.warn(`[mrpack] Modrinth API查询失败: ${apiErr.message}`);
                    }
                }
            }

            if (!downloaded && !(abortSignal && abortSignal.aborted)) {
                console.log(`[mrpack] Mod ${fileName} 所有方法失败，尝试通过文件名在Modrinth搜索...`);
                const searchName = fileName.replace(/[-_]\d+[\d._-]*\.jar$/, '').replace(/[-_]/g, ' ').trim();
                if (searchName.length > 2) {
                    try {
                        const searchRes = await fetchJSON(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(searchName)}&facets=[["project_type:mod"]]`);
                        if (searchRes && searchRes.hits && searchRes.hits.length > 0) {
                            for (const hit of searchRes.hits.slice(0, 3)) {
                                if (downloaded) break;
                                try {
                                    const verRes = await fetchJSON(`https://api.modrinth.com/v2/project/${hit.project_id}/version?game_versions=["${mcVersion}"]`);
                                    if (verRes && Array.isArray(verRes) && verRes.length > 0) {
                                        for (const ver of verRes) {
                                            if (downloaded) break;
                                            for (const f of (ver.files || [])) {
                                                if (downloaded) break;
                                                if (f.primary && f.url) {
                                                    try {
                                                        await _dlSingle(f.url, destPath, {
                                                            onProgress: (p) => {
                                                                if (p && modFiles[index]) modFiles[index].progress = Math.round(p.progress || 0);
                                                                updateOverall();
                                                            },
                                                            retries: 2,
                                                            abortSignal,
                                                            timeout: 300000
                                                        });
                                                        if (isJarIntact(destPath)) {
                                                            downloaded = true;
                                                            console.log(`[mrpack] 通过搜索重试成功: ${fileName} -> ${f.filename}`);
                                                        } else {
                                                            try { fs.unlinkSync(destPath); } catch (_) {}
                                                        }
                                                    } catch (_) {
                                                        try { fs.unlinkSync(destPath); } catch (_) {}
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
            }

            if (downloaded) {
                if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
                okCount++;
            } else {
                if (abortSignal && abortSignal.aborted) {
                    if (modFiles[index]) { modFiles[index].status = 'failed'; modFiles[index].error = '已取消'; }
                } else {
                    console.error(`[mrpack] Mod ${fileName} 所有重试均失败，无法下载`);
                    if (modFiles[index]) { modFiles[index].status = 'failed'; modFiles[index].error = '下载失败'; }
                }
                failCount++;
            }
        } else {
            if (modFiles[index]) { modFiles[index].status = 'completed'; modFiles[index].progress = 100; }
            okCount++;
        }
        inFlight--;
        updateOverall();
    };

    let taskIdx = 0;
    const runNextMod = async () => {
        while (taskIdx < filesList.length) {
            if (abortSignal && abortSignal.aborted) break;
            const idx = taskIdx++;
            await dlMod(filesList[idx], idx);
        }
    };
    const pool = [];
    for (let p = 0; p < Math.min(PARALLEL_MODS, filesList.length); p++) {
        pool.push(runNextMod());
    }
    await Promise.all(pool);
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
    if (failCount > 0) {
        console.warn(`[mrpack] Mod下载汇总: ${okCount}成功 ${failCount}失败 (共${filesList.length}个)`);
    }

    progress('verify', '正在验证整合包完整性...', 90, [...overrideFiles, ...modFiles], '');
    const verifyResult = await verifyImportLibs(versionId, progress, abortSignal);
    if (!verifyResult.ok) {
        console.error(`[mrpack] 库文件补全失败: ${verifyResult.missing} 个文件缺失`);
        cleanupVersionChain(versionId);
        return { success: false, versionId, error: `整合包库文件补全失败: ${verifyResult.missing} 个文件缺失，请检查网络后重试` };
    }

    const mergedJson = resolveVersionJson(versionId);
    if (mergedJson && forgeVer) {
        const forgeCoreCheck = [];
        const mergedLibs = mergedJson.libraries || [];
        const forgeClientLib = mergedLibs.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
            (l.name.endsWith(':client') || l.name.split(':').length === 3));
        const srgLib = mergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = mergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));

        const coreDir = (fp) => path.join(LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const p = path.join(coreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) forgeCoreCheck.push({ name: `forge-client.jar`, path: p });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            const p = path.join(coreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) forgeCoreCheck.push({ name: `client-srg.jar`, path: p });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            const p = path.join(coreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) forgeCoreCheck.push({ name: `client-extra.jar`, path: p });
        }

        if (forgeCoreCheck.length > 0) {
            const missingNames = forgeCoreCheck.map(f => f.name).join(', ');
            console.error(`[mrpack] Forge核心文件验证失败: 缺失 ${forgeCoreCheck.length} 个文件: ${missingNames}`);
            for (const f of forgeCoreCheck) {
                console.error(`[mrpack]   缺失: ${f.path}`);
            }
            cleanupVersionChain(versionId);
            return {
                success: false, versionId,
                error: `Forge核心文件生成失败: 缺失 ${missingNames}。\n请检查Java环境是否正常，网络是否畅通，然后重试。\n缺失文件路径:\n${forgeCoreCheck.map(f => f.path).join('\n')}`
            };
        }
        console.log(`[mrpack] Forge核心文件验证通过 (${forgeCoreCheck.length > 0 ? '已检查' : '无需检查'})`);
    }

    const packInfo = {
        name: packName, versionId: versionId, mcVersion, packFormat: 'mrpack',
        fabricVersion: fabricVer, forgeVersion: forgeVer, neoforgeVersion: neoforgeVer,
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || ''
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    progress('done', `整合包 "${packName}" 导入完成！`, 100);
    if (failCount > 0) {
        const failedModNames = modFiles.filter(m => m.status === 'failed').map(m => m.name).join(', ');
        const warningMsg = `${failCount}/${filesList.length} 个Mod下载失败: ${failedModNames}。请在内部浏览器中手动下载缺失的Mod，或检查网络后重试。`;
        return { success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '', warning: warningMsg, failedMods: modFiles.filter(m => m.status === 'failed') };
    }
    return { success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '' };
    } catch (e) {
        console.error('[mrpack] 导入失败:', e);
        cleanupVersionChain(versionId);
        return { success: false, versionId, error: e.message || '未知错误' };
    }
}

async function _importCurseForge(zip, manifestEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    const settings = loadSettingsCached();
    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    } catch (e) {
        return { success: false, error: '解析 manifest.json 失败: ' + e.message };
    }

    const packName  = (manifest.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    const mcVersion = manifest.minecraft && manifest.minecraft.version ? manifest.minecraft.version : '';
    const loaders   = manifest.minecraft && manifest.minecraft.modLoaders ? manifest.minecraft.modLoaders : [];
    const modLoader = loaders.length > 0 ? loaders[0].id : '';

    const mlParts = (modLoader || '').split('-');
    let forgeVerCF = '', fabricVerCF = '', neoforgeVerCF = '';
    if (mlParts[0] === 'forge') forgeVerCF = mlParts.slice(1).join('-');
    else if (mlParts[0] === 'neoforge') neoforgeVerCF = mlParts.slice(1).join('-');
    else if (mlParts[0] === 'fabric') fabricVerCF = mlParts.slice(1).join('-');

    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(' [外部]', '');
        const existingDir = path.join(VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[Modpack] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[Modpack] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = packName;
            versionDir = path.join(VERSIONS_DIR, versionId);
            console.log(`[Modpack] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = packName;
        versionDir = path.join(VERSIONS_DIR, versionId);
        console.log(`[Modpack] 未指定目标版本，创建新版本: ${versionId}`);
    }
    
    const isNewVersionDirCF = !fs.existsSync(path.join(versionDir, `${versionId}.json`));

    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
    }

    const cfApiKey = settings.curseforgeApiKey || '';

    if (isNewVersionDirCF) {
        console.log(`[CurseForge] 确保基础版本存在: ${mcVersion}`);
        progress('base', '正在准备基础版本...', 10);
        const baseResult = await ensureBaseVersionInstalled(mcVersion);
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        let loaderVersionId = null;
        if (forgeVerCF || neoforgeVerCF || fabricVerCF) {
            progress('loader-install', '正在安装模组加载器...', 12);
            try {
                if (forgeVerCF) {
                    loaderVersionId = `${mcVersion}-forge-${forgeVerCF}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[CurseForge] Forge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: Forge ${forgeVerCF} (MC ${mcVersion})`);
                        const ir = await installForge(mcVersion, forgeVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装Forge...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] Forge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (neoforgeVerCF) {
                    loaderVersionId = `${mcVersion}-neoforge-${neoforgeVerCF}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[CurseForge] NeoForge ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: NeoForge ${neoforgeVerCF} (MC ${mcVersion})`);
                        const ir = await installNeoForge(mcVersion, neoforgeVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装NeoForge...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] NeoForge ${loaderVersionId} 已安装，跳过`);
                    }
                } else if (fabricVerCF) {
                    loaderVersionId = `fabric-loader-${fabricVerCF}-${mcVersion}`;
                    const lvJson = path.join(VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                    if (!fs.existsSync(lvJson) || !verifyLoaderLibs(loaderVersionId)) {
                        if (fs.existsSync(lvJson) && !verifyLoaderLibs(loaderVersionId)) {
                            console.log(`[CurseForge] Fabric ${loaderVersionId} 库文件缺失，重新安装`);
                            try { fs.rmSync(path.join(VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                        }
                        console.log(`[CurseForge] 安装模组加载器: Fabric ${fabricVerCF} (MC ${mcVersion})`);
                        const ir = await installFabric(mcVersion, fabricVerCF, (p, msg) => {
                            progress('loader-install', msg || '正在安装Fabric...', 12 + p * 3);
                        });
                        if (!ir.success) throw new Error(ir.error);
                    } else {
                        console.log(`[CurseForge] Fabric ${loaderVersionId} 已安装，跳过`);
                    }
                }
            } catch (e) {
                console.error(`[CurseForge] 模组加载器安装失败:`, e.message);
                try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
                return { success: false, versionId, error: e.message };
            }
        }

        progress('version-config', '正在创建版本配置...', 14);

        if (loaderVersionId) {
            const versionJson = {
                id: versionId,
                inheritsFrom: loaderVersionId,
                type: 'release',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            console.log(`[CurseForge] 创建版本JSON: ${versionId}.json (继承 ${loaderVersionId})`);
        } else {
            const versionJson = {
                id: versionId,
                inheritsFrom: mcVersion || undefined,
                type: 'release',
                mainClass: 'net.minecraft.client.main.Main',
                time: new Date().toISOString(),
                releaseTime: new Date().toISOString()
            };
            fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
            console.log(`[CurseForge] 创建版本JSON: ${versionId}.json (无加载器)`);
        }

        progress('loader', '模组加载器就绪', 15);
    }

    try {
    progress('extract', '解压覆盖文件...', 17, [], '');
    const entries = zip.getEntries();
    const overrideFiles = [];
    let cfExtractYieldCounter = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (entry.entryName.startsWith('overrides/')) {
            const relPath = entry.entryName.slice('overrides/'.length);
            const destPath = path.join(versionDir, relPath);
            const resolvedDest = path.resolve(destPath);
            const resolvedBase = path.resolve(versionDir);
            if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
                console.warn(`[Modpack] CurseForge路径遍历已拦截: ${relPath}`);
                continue;
            }
            await asyncEnsureDir(destPath);
            await fs.promises.writeFile(destPath, entry.getData());
            overrideFiles.push({ name: relPath, status: 'completed', progress: 100 });
            if (++cfExtractYieldCounter % 50 === 0) await yieldToEventLoop();
        }
    }

    const cfFiles = manifest.files || [];
    const modsDir = path.join(versionDir, 'mods');
    ensureDir(path.join(modsDir, 'dummy.txt'));

    const cfModFiles = cfFiles.map(f => ({ name: `Mod #${f.projectID}`, status: 'pending', progress: 0 }));
    progress('mods', `下载 Mod 文件 (共 ${cfFiles.length} 个)...`, 25, [...overrideFiles, ...cfModFiles], '');

    let cfDownloadedCount = 0;
    let cfInFlight = 0;
    const CF_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 8, 8);
    let cfLastProgUpdate = 0;
    let cfLastReportedPct = 0;

    const getCfModTimeout = (sizeBytes) => {
        if (sizeBytes > 50 * 1024 * 1024) return 600000;
        if (sizeBytes > 20 * 1024 * 1024) return 300000;
        if (sizeBytes > 5 * 1024 * 1024) return 180000;
        return 120000;
    };

    const cfUpdateOverall = () => {
        const now = Date.now();
        let totalPct = 0;
        for (const mf of cfModFiles) {
            totalPct += (mf.status === 'completed' || mf.status === 'failed') ? 100 : (mf.progress || 0);
        }
        const overallPct = totalPct / Math.max(cfModFiles.length, 1);
        const pct = 25 + Math.round((overallPct / 100) * 65);
        const clamped = Math.min(pct, 95);
        if (clamped <= cfLastReportedPct && now - cfLastProgUpdate < 500) return;
        cfLastReportedPct = Math.max(cfLastReportedPct, clamped);
        cfLastProgUpdate = now;
        progress('mods', `下载 Mod (${cfDownloadedCount}/${cfFiles.length}, ${cfInFlight}个进行中)`, cfLastReportedPct, [...overrideFiles, ...cfModFiles], '');
    };

    const dlCFMod = async (file, index) => {
        cfInFlight++;
        if (abortSignal && abortSignal.aborted) { cfInFlight--; cfUpdateOverall(); return; }
        const projectID = file.projectID;
        const fileID    = file.fileID;
        const fileSize  = file.fileLength || 0;
        if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
        cfUpdateOverall();

        let cfDownloaded = false;
        const MAX_CF_ROUNDS = 5;

        for (let round = 0; round < MAX_CF_ROUNDS && !cfDownloaded; round++) {
            if (abortSignal && abortSignal.aborted) break;
            if (round > 0) {
                console.log(`[CurseForge] Mod ${projectID}:${fileID} 第${round + 1}轮重试...`);
                if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
                await new Promise(r => setTimeout(r, 3000 + round * 2000 + Math.random() * 2000));
            }

            if (!cfApiKey) {
                if (cfModFiles[index]) { cfModFiles[index].status = 'failed'; cfModFiles[index].error = 'API Key 未设置'; }
                break;
            }

            try {
                if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
                const fileInfo = await fetchJSON(`${CURSEFORGE_API}/mods/${projectID}/files/${fileID}`, { 'x-api-key': cfApiKey });
                const downloadUrl = fileInfo && fileInfo.data ? fileInfo.data.downloadUrl : null;
                if (downloadUrl) {
                    const fileName = path.basename(downloadUrl);
                    const destPath = path.join(modsDir, fileName);
                    if (cfModFiles[index]) { cfModFiles[index].name = fileName; cfModFiles[index]._destPath = destPath; }

                    if (isJarIntact(destPath)) {
                        cfDownloaded = true;
                    } else {
                        const perTryAbort = new AbortController();
                        const perTryTimeout = setTimeout(() => { try { perTryAbort.abort(); } catch (_) {} }, 180000);
                        if (abortSignal) {
                            abortSignal.addEventListener('abort', () => { try { perTryAbort.abort(); } catch (_) {} }, { once: true });
                        }
                        try {
                            const allUrls = getMirrorUrls(downloadUrl);
                            for (const mirrorUrl of allUrls) {
                                if (cfDownloaded || perTryAbort.signal.aborted) break;
                                try {
                                    await _dlSingle(mirrorUrl, destPath, {
                                        onProgress: (p) => {
                                            if (p && cfModFiles[index]) {
                                                cfModFiles[index].progress = Math.round(p.progress || 0);
                                                cfModFiles[index].downloaded = p.downloaded || 0;
                                                cfModFiles[index].speed = p.speed || '';
                                            }
                                            cfUpdateOverall();
                                        },
                                        retries: 3,
                                        stallTimeout: 45000,
                                        abortSignal: perTryAbort.signal,
                                        timeout: getCfModTimeout(fileInfo?.data?.fileLength || 0)
                                    });
                                    if (isJarIntact(destPath)) {
                                        cfDownloaded = true;
                                        break;
                                    } else {
                                        try { fs.unlinkSync(destPath); } catch (_) {}
                                    }
                                } catch (e) {
                                    if (abortSignal && abortSignal.aborted) break;
                                    try { fs.unlinkSync(destPath); } catch (_) {}
                                }
                            }
                        } finally {
                            clearTimeout(perTryTimeout);
                        }
                    }
                } else {
                    console.warn(`[CurseForge] 无法获取下载URL: ${projectID}:${fileID}`);
                }
            } catch (e) {
                if (abortSignal && abortSignal.aborted) break;
                console.warn(`[CurseForge] 下载失败(round ${round + 1}):`, projectID, fileID, e.message);
            }
        }

        if (!cfDownloaded && !(abortSignal && abortSignal.aborted) && cfApiKey) {
            console.log(`[CurseForge] Mod ${projectID}:${fileID} 常规下载失败，尝试通过API获取其他版本...`);
            try {
                const allFilesRes = await fetchJSON(`${CURSEFORGE_API}/mods/${projectID}/files`, { 'x-api-key': cfApiKey });
                if (allFilesRes && allFilesRes.data && Array.isArray(allFilesRes.data)) {
                    const mcVer = mcVersion;
                    const matchingFiles = allFilesRes.data.filter(f =>
                        f.gameVersions && f.gameVersions.includes(mcVer) &&
                        f.downloadUrl && f.fileName && f.fileName.endsWith('.jar')
                    );
                    for (const altFile of matchingFiles.slice(0, 3)) {
                        if (cfDownloaded) break;
                        const destPath = path.join(modsDir, altFile.fileName);
                        if (cfModFiles[index]) { cfModFiles[index].name = altFile.fileName; cfModFiles[index]._destPath = destPath; }
                        if (isJarIntact(destPath)) { cfDownloaded = true; break; }
                        try {
                            await _dlSingle(altFile.downloadUrl, destPath, {
                                onProgress: (p) => {
                                    if (p && cfModFiles[index]) cfModFiles[index].progress = Math.round(p.progress || 0);
                                    cfUpdateOverall();
                                },
                                retries: 2,
                                abortSignal,
                                timeout: 300000
                            });
                            if (isJarIntact(destPath)) {
                                cfDownloaded = true;
                                console.log(`[CurseForge] 通过备用版本下载成功: ${altFile.fileName}`);
                            } else {
                                try { fs.unlinkSync(destPath); } catch (_) {}
                            }
                        } catch (_) {
                            try { fs.unlinkSync(destPath); } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        }

        if (cfDownloaded) {
            if (cfModFiles[index]) { cfModFiles[index].status = 'completed'; cfModFiles[index].progress = 100; }
        } else if (cfModFiles[index]) {
            if (abortSignal && abortSignal.aborted) {
                cfModFiles[index].status = 'failed'; cfModFiles[index].error = '已取消';
            } else {
                cfModFiles[index].status = 'failed'; cfModFiles[index].error = '下载失败';
                console.error(`[CurseForge] Mod ${projectID}:${fileID} 最终下载失败`);
            }
        }
        cfDownloadedCount++;
        cfInFlight--;
        cfUpdateOverall();
    };

    let cfTaskIdx = 0;
    const runNextCfMod = async () => {
        while (cfTaskIdx < cfFiles.length) {
            if (abortSignal && abortSignal.aborted) break;
            const idx = cfTaskIdx++;
            await dlCFMod(cfFiles[idx], idx);
        }
    };
    const cfPool = [];
    for (let p = 0; p < Math.min(CF_PARALLEL, cfFiles.length); p++) {
        cfPool.push(runNextCfMod());
    }
    await Promise.all(cfPool);
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');

    progress('verify', '正在验证整合包完整性...', 90, [...overrideFiles, ...cfModFiles], '');
    const cfVerifyResult = await verifyImportLibs(versionId, progress, abortSignal);
    if (!cfVerifyResult.ok) {
        console.error(`[CurseForge] 库文件补全失败: ${cfVerifyResult.missing} 个文件缺失`);
        cleanupVersionChain(versionId);
        return { success: false, versionId, error: `整合包库文件补全失败: ${cfVerifyResult.missing} 个文件缺失，请检查网络后重试` };
    }

    const cfMergedJson = resolveVersionJson(versionId);
    if (cfMergedJson && (forgeVerCF || neoforgeVerCF)) {
        const cfForgeCoreCheck = [];
        const cfMergedLibs = cfMergedJson.libraries || [];
        const forgeClientLib = cfMergedLibs.find(l =>
            l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
            (l.name.endsWith(':client') || l.name.split(':').length === 3));
        const srgLib = cfMergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
        const extraLib = cfMergedLibs.find(l =>
            l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));
        const coreDir = (fp) => path.join(LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
        if (forgeClientLib) {
            const fp = forgeClientLib.name.split(':');
            const cl = fp.length >= 4 ? `-${fp[3]}` : '';
            const p = path.join(coreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) cfForgeCoreCheck.push({ name: 'forge-client.jar', path: p });
        }
        if (srgLib) {
            const sp = srgLib.name.split(':');
            const p = path.join(coreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-srg.jar', path: p });
        }
        if (extraLib) {
            const ep = extraLib.name.split(':');
            const p = path.join(coreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`);
            if (!fs.existsSync(p) || !isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-extra.jar', path: p });
        }
        if (cfForgeCoreCheck.length > 0) {
            const missingNames = cfForgeCoreCheck.map(f => f.name).join(', ');
            console.error(`[CurseForge] Forge核心文件验证失败: ${cfForgeCoreCheck.length}个缺失: ${missingNames}`);
            cleanupVersionChain(versionId);
            return { success: false, versionId, error: `Forge核心文件生成失败: 缺失 ${missingNames}。请检查Java环境和网络后重试。` };
        }
    }

    const cfFailedMods = cfModFiles.filter(m => m.status === 'failed');
    const cfFailedCount = cfFailedMods.length;

    const packInfo = {
        name: packName, versionId: versionId, mcVersion, packFormat: 'curseforge',
        modLoader, forgeVersion: forgeVerCF || '', fabricVersion: fabricVerCF || '', neoforgeVersion: neoforgeVerCF || '',
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || '',
        pendingMods: cfApiKey ? [] : cfFiles.map(function(f) { return { projectID: f.projectID, fileID: f.fileID }; })
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    progress('done', `整合包 "${packName}" 导入完成！`, 100);
    const cfWarning = cfApiKey ? undefined : 'CurseForge Mod 文件需要 API Key，overrides 已解压。请在设置中配置 CurseForge API Key 后重新导入。';
    let failWarning = undefined;
    if (cfFailedCount > 0) {
        const failedModNames = cfFailedMods.map(m => m.name || m.projectID).join(', ');
        failWarning = `${cfFailedCount}/${cfFiles.length} 个Mod下载失败: ${failedModNames}。请检查网络后重试。`;
        console.warn(`[CurseForge] Mod下载汇总: ${cfFiles.length - cfFailedCount}成功 ${cfFailedCount}失败`);
    }
    return {
        success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '',
        warning: cfWarning || failWarning || undefined,
        failedMods: cfFailedCount > 0 ? cfFailedMods : undefined
    };
    } catch (e) {
        console.error('[CurseForge] 导入失败:', e);
        cleanupVersionChain(versionId);
        return { success: false, versionId, error: e.message || '未知错误' };
    }
}

async function _importRawZip(zip, filePath, progress, targetVersion = '', abortSignal = null) {
    const settings = loadSettingsCached();
    const packName   = path.basename(filePath, path.extname(filePath)).replace(/[<>:"/\\|?*]/g, '_');
    let versionId;
    let versionDir;
    
    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(' [外部]', '');
        const existingDir = path.join(VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[RawZip] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[RawZip] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = packName;
            versionDir = path.join(VERSIONS_DIR, versionId);
            console.log(`[RawZip] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = packName;
        versionDir = path.join(VERSIONS_DIR, versionId);
        console.log(`[RawZip] 未指定目标版本，创建新版本: ${versionId}`);
    }
    
    const isNewVersionDirRZ = !fs.existsSync(path.join(versionDir, `${versionId}.json`));
    let baseMcVersion = '';
    try {
        ensureDir(path.join(versionDir, 'dummy.txt'));

    progress('extract', `解压 ${packName}...`, 10);
    try {
        const entries = zip.getEntries();
        let rzExtractYieldCounter = 0;
        for (const entry of entries) {
            const entryName = entry.entryName;
            const destPath = path.resolve(versionDir, entryName);
            if (!destPath.startsWith(path.resolve(versionDir) + path.sep) && destPath !== path.resolve(versionDir)) {
                console.warn(`[Security] Blocked Zip Slip entry: ${entryName}`);
                continue;
            }
            if (entry.isDirectory) {
                await asyncEnsureDir(path.join(versionDir, entryName, 'dummy.txt'));
            } else {
                await asyncEnsureDir(path.join(versionDir, entryName));
                await fs.promises.writeFile(destPath, entry.getData());
                if (++rzExtractYieldCounter % 50 === 0) await yieldToEventLoop();
            }
        }
    } catch (e) {
        return { success: false, versionId, error: '解压失败: ' + e.message };
    }

    const packInfo = {
        name: packName, versionId: versionId, packFormat: 'raw',
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || ''
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (isNewVersionDirRZ) {
        try {
            const allInstalled = getInstalledVersions();
            const mcDirs = fs.readdirSync(VERSIONS_DIR).filter(d => {
                const dd = path.join(VERSIONS_DIR, d);
                if (!fs.statSync(dd).isDirectory()) return false;
                return /^\d+\.\d+(\.\d+)?$/.test(d);
            });
            if (mcDirs.length > 0) {
                baseMcVersion = mcDirs.sort((a, b) => {
                    const pa = a.split('.').map(Number);
                    const pb = b.split('.').map(Number);
                    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
                    return 0;
                })[0];
            }
        } catch (e) {}

        const versionJson = {
            id: versionId,
            inheritsFrom: baseMcVersion || undefined,
            type: 'release',
            time: new Date().toISOString(),
            releaseTime: new Date().toISOString()
        };
        if (baseMcVersion) {
            try {
                const baseResult = await ensureBaseVersionInstalled(baseMcVersion);
                if (baseResult.error) console.log(`[RawZip] 基础版本安装失败: ${baseResult.error}`);
            } catch (e) {
                console.log(`[RawZip] 基础版本安装异常: ${e.message}`);
            }
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
        console.log(`[RawZip] 创建版本JSON: ${versionId}.json (inheritsFrom: ${baseMcVersion || '无'})`);
    }

    if (baseMcVersion) {
        progress('verify', '正在验证依赖完整性...', 90, [], '');
        await verifyImportLibs(versionId, progress, abortSignal);
    }

    progress('done', `"${packName}" 解压完成！`, 100);
    return { success: true, name: packName, versionId, targetVersion: targetVersion || '' };
    } catch (e) {
        console.error('[RawZip] 导入失败:', e);
        try { if (fs.existsSync(versionDir)) { fs.rmSync(versionDir, { recursive: true, force: true }); console.log(`[RawZip] 清理失败目录: ${versionDir}`); } } catch (ce) {}
        return { success: false, versionId, error: e.message || '导入失败' };
    }
}

// ============================================================================
// 模块导出 - 向外部暴露的API接口
// ============================================================================
module.exports = { handleNativeAPI, handleNativeSSE, logStartupInfo, importModpackFromPath, cleanupOnShutdown, validateInstalledVersions, setMainWindow };

process.on('exit', () => saveDiskCache());
process.on('SIGINT', () => { saveDiskCache(); process.exit(); });
process.on('SIGTERM', () => { saveDiskCache(); process.exit(); });

/**
 * 原生 Electron API 处理器 — 不经过 HTTP 模拟层。
 * @param {string} pathname - API 路径 (如 '/api/versions')
 * @param {string} method - HTTP 方法 (GET/POST/DELETE)
 * @param {string|null} body - POST/PUT 请求体
 * @param {Object} query - URL 查询参数
 * @returns {Promise<{status: number, headers: Object, body: Buffer}>}
 */
async function handleNativeAPI(pathname, method, body, query) {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname + (query && Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : '');
    req.headers = { 'content-type': 'application/json' };

    const res = new EventEmitter();
    let statusCode = 200;
    let headers = {};
    let chunks = [];
    let finished = false;
    let finishResolve = null;
    const finishPromise = new Promise((resolve) => { finishResolve = resolve; });

    res.statusCode = 200;
    res.headersSent = false;
    res.finished = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.removeHeader = (name) => { delete headers[name.toLowerCase()]; };
    res.writeHead = (code, hdrs) => {
        statusCode = code;
        res.statusCode = code;
        res.headersSent = true;
        if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    };
    res.write = (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    };
    res.end = (data) => {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        finished = true;
        res.finished = true;
        res.emit('finish');
        if (finishResolve) { finishResolve(); finishResolve = null; }
    };
    res.flushHeaders = () => {};

    const parsedUrl = url.parse(req.url, true);

    const apiResult = handleAPI(pathname, req, res, parsedUrl);

    await new Promise(r => setImmediate(() => {
        if (body !== null && body !== undefined) {
            req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        req.emit('end');
        setImmediate(r);
    }));

    await apiResult;

    if (!finished) {
        await finishPromise;
    }

    return {
        status: statusCode,
        headers,
        body: Buffer.concat(chunks)
    };
}

/**
 * 原生 Electron SSE 处器 — 流式响应。
 * @param {string} pathname
 * @param {string} method
 * @param {string|null} body
 * @param {Object} query
 * @param {Function} onData - 收到数据块时回调 (chunk: Buffer) => void
 * @returns {Promise<{status: number, headers: Object}>}
 */
function handleNativeSSE(pathname, method, body, query, onData) {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname + (query && Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : '');
    req.headers = { 'content-type': 'application/json' };

    const res = new EventEmitter();
    let statusCode = 200;
    let headers = {};
    let finishResolve = null;
    const finishPromise = new Promise((resolve) => { finishResolve = resolve; });

    res.statusCode = 200;
    res.headersSent = false;
    res.finished = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => headers[name.toLowerCase()];
    res.writeHead = (code, hdrs) => {
        statusCode = code;
        if (hdrs) Object.entries(hdrs).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    };
    res.write = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (onData) onData(buf);
    };
    res.end = (data) => {
        if (data) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (onData) onData(buf);
        }
        res.finished = true;
        res.emit('finish');
        if (finishResolve) { finishResolve(); finishResolve = null; }
    };
    res.flushHeaders = () => {};

    const parsedUrl = url.parse(req.url, true);

    setImmediate(() => {
        if (body !== null && body !== undefined) {
            req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        req.emit('end');
    });

    handleAPI(pathname, req, res, parsedUrl).then(() => {
        if (!res.finished) {
            finishPromise.then(() => {
                if (onData) onData(null); // signal EOF
            });
        } else {
            if (onData) onData(null); // signal EOF
        }
    }).catch((e) => {
        console.error('SSE handler error:', e);
        if (onData) onData(null);
    });

    return { status: statusCode, headers, finishPromise };
}

async function handleAPI(pathname, req, res, parsedUrl) {
    const sendJSON = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    const sendError = (message, status = 500) => {
        sendJSON({ error: message }, status);
    };

    const readBody = () => new Promise((resolve) => {
        let body = '';
        let size = 0;
        const MAX_BODY = 1024 * 1024;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                req.destroy();
                resolve({});
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });

    try {
        await new Promise(r => setImmediate(r));
        switch (pathname) {
            case '/api/versions': {
                const forceRefresh = parsedUrl.query.refresh === 'true';
                const installedOnly = parsedUrl.query.installed === 'true';
                const installedList = getInstalledVersions();
                const installedIds = new Set();
                const installedBaseIds = new Set();
                for (const v of installedList) {
                    installedIds.add(v.id);
                    if (v.baseVersion) installedBaseIds.add(v.baseVersion);
                    if (v.inheritsFrom) installedBaseIds.add(v.inheritsFrom);
                }

                if (installedOnly) {
                    sendJSON({
                        latest: { release: '', snapshot: '' },
                        versions: installedList.map(v => ({ ...v, installed: true })),
                        installed: installedList
                    });
                    break;
                }

                if (forceRefresh || !versionCache) {
                    try {
                        const manifest = await getVersionManifest(forceRefresh);
                        const versions = manifest.versions.map(v => ({
                            id: v.id,
                            type: v.type,
                            url: v.url,
                            releaseTime: v.releaseTime,
                            complianceLevel: v.complianceLevel || 1,
                            installed: installedIds.has(v.id) || installedBaseIds.has(v.id),
                            size: ''
                        }));

                        sendJSON({
                            latest: manifest.latest,
                            versions: versions,
                            installed: installedList
                        });
                    } catch (e) {
                        sendJSON({
                            latest: { release: '', snapshot: '' },
                            versions: installedList.map(v => ({ ...v, installed: true })),
                            installed: installedList
                        });
                    }
                } else {
                    sendJSON({
                        latest: versionCache.latest || { release: '', snapshot: '' },
                        versions: (versionCache.versions || []).map(v => ({
                            id: v.id,
                            type: v.type,
                            url: v.url,
                            releaseTime: v.releaseTime,
                            complianceLevel: v.complianceLevel || 1,
                            installed: installedIds.has(v.id) || installedBaseIds.has(v.id),
                            size: ''
                        })),
                        installed: installedList
                    });

                    getVersionManifest(forceRefresh).then(manifest => {
                        versionCache = manifest;
                    }).catch(() => {});
                }
                break;
            }

            case '/api/debug/versions': {
                const rawDirs = [];
                if (fs.existsSync(VERSIONS_DIR)) {
                    const dirs = fs.readdirSync(VERSIONS_DIR);
                    for (const dir of dirs) {
                        const versionDir = path.join(VERSIONS_DIR, dir);
                        try {
                            if (!fs.statSync(versionDir).isDirectory()) continue;
                        } catch (e) { continue; }
                        const jsonFile = findVersionJson(versionDir);
                        const entry = { dir, jsonFile: jsonFile || null, jsonData: null, jsonFiles: [] };
                        if (fs.existsSync(versionDir)) {
                            try {
                                const allFiles = fs.readdirSync(versionDir);
                                entry.jsonFiles = allFiles.filter(f => f.endsWith('.json'));
                            } catch (_) {}
                        }
                        if (jsonFile && fs.existsSync(jsonFile)) {
                            try {
                                const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
                                entry.jsonData = {
                                    id: data.id,
                                    inheritsFrom: data.inheritsFrom || null,
                                    mainClass: data.mainClass || null,
                                    type: data.type || null,
                                    libraryCount: (data.libraries || []).length
                                };
                            } catch (_) {}
                        }
                        rawDirs.push(entry);
                    }
                }
                const filtered = getInstalledVersions();
                sendJSON({
                    rawDirs,
                    filteredIds: filtered.map(v => v.id),
                    filteredCount: filtered.length
                });
                break;
            }

            case '/api/version-details': {
                const versionUrl = parsedUrl.query.url;
                if (!versionUrl) { sendError('Missing url parameter', 400); break; }
                const details = await getVersionDetails(versionUrl);
                const result = {
                    id: details.id,
                    type: details.type,
                    mainClass: details.mainClass,
                    releaseTime: details.releaseTime,
                    javaVersion: details.javaVersion,
                    libraries: [],
                    downloads: {}
                };
                if (details.libraries) {
                    result.libraries = details.libraries.map(lib => ({
                        name: lib.name,
                        downloads: lib.downloads || {}
                    }));
                }
                if (details.downloads) {
                    result.downloads = {
                        client: details.downloads.client ? {
                            url: details.downloads.client.url,
                            size: details.downloads.client.size,
                            sha1: details.downloads.client.sha1
                        } : null,
                        server: details.downloads.server ? {
                            url: details.downloads.server.url,
                            size: details.downloads.server.size,
                            sha1: details.downloads.server.sha1
                        } : null
                    };
                }
                if (details.assetIndex) {
                    result.assetIndex = {
                        id: details.assetIndex.id,
                        url: details.assetIndex.url,
                        totalSize: details.assetIndex.totalSize,
                        size: details.assetIndex.size
                    };
                }
                sendJSON(result);
                break;
            }

            case '/api/mods': {
                const modResult = getInstalledMods();
                sendJSON(modResult);
                break;
            }

            case '/api/mod-icon': {
                const hash = (parsedUrl.query.hash || '').replace(/[^a-f0-9]/gi, '');
                const iconPath = hash ? path.join(ICON_CACHE_DIR, hash + '.png') : '';
                try {
                    if (iconPath && fs.existsSync(iconPath)) {
                        const data = fs.readFileSync(iconPath);
                        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
                        res.end(data);
                    } else {
                        res.writeHead(404);
                        res.end('');
                    }
                } catch (e) {
                    res.writeHead(404);
                    res.end('');
                }
                break;
            }

            case '/api/mods/search': {
                await new Promise(r => setImmediate(r));
                const query = parsedUrl.query.query || '';
                const source = parsedUrl.query.source || 'modrinth';
                const loader = parsedUrl.query.loader || '';
                const mcVersion = parsedUrl.query.version || '';
                const category = parsedUrl.query.category || '';
                const sort = parsedUrl.query.sort || 'relevance';
                const limit = parseInt(parsedUrl.query.limit || '15', 10);
                const offset = parseInt(parsedUrl.query.offset || '0', 10);

                try {
                    if (source === 'modrinth') {
                        const facets = [['project_type:mod']];
                        if (loader) facets.push([`categories:${loader}`]);
                        if (mcVersion) facets.push([`versions:${mcVersion}`]);
                        if (category) facets.push([`categories:${category}`]);
                        const sortMap = { relevance: 'relevance', downloads: 'downloads', newest: 'newest', updated: 'updated' };
                        const sortField = sortMap[sort] || (query ? 'relevance' : 'downloads');
                        let searchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&index=${sortField}&limit=${limit}&offset=${offset}`;
                        searchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                        const result = await cachedFetchJSON(searchUrl, 60000);
                        const hits = (result.hits || []).map(hit => ({
                            id: hit.project_id, slug: hit.slug, title: hit.title,
                            description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                            icon: hit.icon_url || '', downloads: hit.downloads || 0, followers: hit.followers || 0,
                            categories: hit.categories || [], versions: hit.versions || [],
                            dateCreated: hit.date_created || '', dateModified: hit.date_modified || '',
                            source: 'modrinth', installed: false
                        }));
                        sendJSON({ hits, total: result.total_hits || hits.length, offset });
                    } else if (source === 'curseforge') {
                        const gameId = '432';
                        const settings = loadSettingsCached();
                        const cfApiKey = settings.curseforgeApiKey || '';
                        const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                        let searchUrl = `${CURSEFORGE_API}/mods/search?gameId=${gameId}&searchFilter=${encodeURIComponent(query)}&sortOrder=Desc&pageSize=${limit}&index=${offset}`;
                        if (sort === 'downloads') searchUrl += '&sortField=TotalDownloads';
                        else if (sort === 'newest') searchUrl += '&sortField=dateReleased';
                        else if (sort === 'updated') searchUrl += '&sortField=dateModified';
                        const result = await fetchJSON(searchUrl, cfHeaders);
                        const hits = (result.data || []).map(mod => ({
                            id: String(mod.id), slug: mod.slug || '', title: mod.name || 'Unknown',
                            description: mod.summary || '', author: (mod.authors || [])[0] || 'Unknown',
                            icon: mod.logo?.url || '', downloads: mod.downloadCount || 0, followers: mod.followers || 0,
                            categories: (mod.categories || []).map(c => c.name),
                            dateCreated: mod.dateCreated || '', dateModified: mod.dateModified || '',
                            source: 'curseforge', installed: false
                        }));
                        sendJSON({ hits, total: result.pagination?.totalCount || hits.length, offset });
                    } else {
                        sendError('Invalid source', 400);
                    }
                } catch (e) {
                    sendError('搜索失败: ' + e.message);
                }
                break;
            }

            case '/api/mods/download': {
                const data = await readBody();
                const projectId = data.projectId;
                const source = data.source || 'modrinth';
                const loader = data.loader || '';
                const mcVersion = data.mcVersion || '';
                const versionId = data.versionId || '';
                if (!projectId) { sendError('Missing projectId', 400); break; }

                let modsDestDir = null;
                if (versionId) {
                    modsDestDir = getVersionModsDir(versionId);
                }
                if (!modsDestDir && mcVersion) {
                    const installedVersions = getInstalledVersions();
                    const matched = installedVersions.find(v =>
                        v.id === mcVersion || v.baseVersion === mcVersion ||
                        v.inheritsFrom === mcVersion || v.id.startsWith(mcVersion)
                    );
                    if (matched) {
                        modsDestDir = getVersionModsDir(matched.id);
                    }
                }
                if (!modsDestDir) {
                    const settings = loadSettingsCached();
                    modsDestDir = getVersionModsDir(settings.selectedVersion);
                }
                if (!modsDestDir) {
                    const installedVersions = getInstalledVersions();
                    if (installedVersions.length > 0) {
                        modsDestDir = getVersionModsDir(installedVersions[0].id);
                    }
                    if (!modsDestDir) {
                        sendError('请先安装一个游戏版本');
                        break;
                    }
                }
                if (!fs.existsSync(modsDestDir)) fs.mkdirSync(modsDestDir, { recursive: true });

                let downloadUrl = null;
                let fileName = null;

                try {
                    if (source === 'modrinth') {
                        const versionUrl = `${MODRINTH_API}/project/${projectId}/version`;
                        let versions = null;

                        if (loader && mcVersion) {
                            try {
                                versions = await fetchJSON(versionUrl + '?' + `loaders=["${loader}"]&game_versions=["${mcVersion}"]`);
                            } catch (e) {}
                        }
                        if (!versions || !versions.length) {
                            if (mcVersion) {
                                try {
                                    versions = await fetchJSON(versionUrl + '?' + `game_versions=["${mcVersion}"]`);
                                } catch (e) {}
                            }
                        }
                        if (!versions || !versions.length) {
                            try {
                                versions = await fetchJSON(versionUrl + '?limit=10');
                            } catch (e) {}
                        }

                        if (versions && versions.length) {
                            const primaryFile = versions[0].files?.find(f => f.primary === true);
                            const file = primaryFile || versions[0].files?.[0];
                            if (file) {
                                downloadUrl = file.url;
                                fileName = file.filename;
                            }
                        }
                    } else if (source === 'curseforge') {
                        const settings = loadSettingsCached();
                        const cfApiKey = settings.curseforgeApiKey || '';
                        let loaderType = 4;
                        if (loader === 'forge') loaderType = 1;
                        else if (loader === 'neoforge') loaderType = 5;
                        else if (loader === 'fabric') loaderType = 4;
                        else if (loader === 'quilt') loaderType = 5;

                        const cfVersionUrl = `${CURSEFORGE_API}/mods/${projectId}/files?gameVersion=${mcVersion}${loader ? '&modLoaderType=' + loaderType : ''}`;
                        const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                        const cfResult = await fetchJSON(cfVersionUrl, cfHeaders);
                        if (cfResult.data && cfResult.data.length > 0) {
                            const file = cfResult.data[0];
                            downloadUrl = file.downloadUrl;
                            fileName = file.fileName;
                        } else if (mcVersion) {
                            const cfFallbackUrl = `${CURSEFORGE_API}/mods/${projectId}/files`;
                            const cfFallbackResult = await fetchJSON(cfFallbackUrl, cfHeaders);
                            if (cfFallbackResult.data && cfFallbackResult.data.length > 0) {
                                const matching = cfFallbackResult.data.filter(f =>
                                    f.gameVersions && f.gameVersions.includes(mcVersion)
                                );
                                const file = matching.length > 0 ? matching[0] : cfFallbackResult.data[0];
                                downloadUrl = file.downloadUrl;
                                fileName = file.fileName;
                            }
                        }
                    }
                } catch (e) {}

                if (!downloadUrl) { sendError('未找到可下载的文件'); break; }

                const safeName = (fileName || `${projectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                const destPath = path.join(modsDestDir, safeName);
                await downloadFile(downloadUrl, destPath, null, 2);
                sendJSON({ success: true, message: `模组 ${safeName} 下载成功`, path: destPath, fileName: safeName });
                break;
            }

            case '/api/mods/toggle': {
                const data = await readBody();
                const modId = data.modId;
                const enabled = data.enabled;
                if (!modId) { sendError('Missing modId', 400); break; }
                const settings = loadSettingsCached();
                let modsPath = getVersionModsDir(settings.selectedVersion);
                if (!modsPath) {
                    const installedVersions = getInstalledVersions();
                    if (installedVersions.length > 0) modsPath = getVersionModsDir(installedVersions[0].id);
                    if (!modsPath) { sendError('请先安装一个游戏版本'); break; }
                }
                if (!fs.existsSync(modsPath)) { sendError('mods文件夹不存在'); break; }

                const enabledPath = path.join(modsPath, modId);
                const disabledPath = path.join(modsPath, modId + '.disabled');

                if (enabled) {
                    if (fs.existsSync(disabledPath)) {
                        fs.renameSync(disabledPath, enabledPath);
                    } else if (modId.endsWith('.disabled')) {
                        const realEnabledPath = path.join(modsPath, modId.replace('.disabled', ''));
                        if (fs.existsSync(enabledPath)) {
                            fs.renameSync(enabledPath, realEnabledPath);
                        }
                    }
                } else {
                    if (fs.existsSync(enabledPath)) {
                        fs.renameSync(enabledPath, disabledPath);
                    }
                }
                sendJSON({ success: true, enabled });
                break;
            }

            case '/api/mods/delete': {
                const data = await readBody();
                const modId = data.modId;
                if (!modId) { sendError('Missing modId', 400); break; }
                const settings = loadSettingsCached();
                let modsPath = getVersionModsDir(settings.selectedVersion);
                if (!modsPath) {
                    const installedVersions = getInstalledVersions();
                    if (installedVersions.length > 0) modsPath = getVersionModsDir(installedVersions[0].id);
                    if (!modsPath) { sendError('请先安装一个游戏版本'); break; }
                }
                if (!fs.existsSync(modsPath)) { sendError('mods文件夹不存在'); break; }
                const modFiles = fs.readdirSync(modsPath).filter(f => f.toLowerCase().includes(modId.toLowerCase()));
                modFiles.forEach(f => fs.unlinkSync(path.join(modsPath, f)));
                sendJSON({ success: true, message: `模组 ${modId} 已删除` });
                break;
            }

            case '/api/mods/check-updates': {
                const cuData = await readBody();
                const cuVersionId = cuData.versionId;
                if (!cuVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const result = await checkModUpdates(cuVersionId);
                    sendJSON(result);
                } catch (e) { sendJSON({ updates: [], error: e.message }); }
                break;
            }

            case '/api/launch': {
                const data = await readBody();
                const versionId = data.versionId;
                if (!versionId) { sendError('Missing versionId', 400); break; }
                const settings = loadSettingsCached();

                try {
                    const storePath = path.join(require('os').homedir(), '.versepc', 'app-store.json');
                    if (fs.existsSync(storePath)) {
                        const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
                        const launchStr = store['versepc_launch_settings'];
                        if (launchStr) {
                            const lsData = JSON.parse(launchStr);
                            if (lsData.windowSize) {
                                if (lsData.windowSize === 'default') {
                                    settings.resolution = '854x480';
                                } else {
                                    settings.resolution = lsData.windowSize;
                                }
                                console.log(`[Launch] 使用启动设置窗口大小: ${settings.resolution}`);
                            }
                        }
                    }
                } catch (e) {
                    console.log(`[Launch] 读取启动设置失败，使用全局设置: ${e.message}`);
                }

                const accounts = loadAccounts();
                let account = accounts.find(a => a.id === settings.selectedAccount) || accounts[0] || { username: 'Player', type: 'offline' };

                if (account.type === 'microsoft' && account.refreshToken) {
                    const tokenExpiresAt = account.tokenExpiresAt || 0;
                    const now = Date.now();
                    const shouldRefresh = !tokenExpiresAt || now > tokenExpiresAt - 5 * 60 * 1000;
                    if (shouldRefresh) {
                        console.log(`[Launch] 微软账号Token即将过期或已过期，尝试刷新...`);
                        try {
                            const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                            const postData = `grant_type=refresh_token&client_id=${MS_CLIENT_ID}&refresh_token=${encodeURIComponent(account.refreshToken)}&scope=XboxLive.signin+offline_access`;
                            const msTokenResult = await new Promise((resolve, reject) => {
                                const req = https.request(tokenUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
                                }, (res) => {
                                    let data = '';
                                    res.on('data', chunk => data += chunk);
                                    res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
                                });
                                req.on('error', reject);
                                req.write(postData);
                                req.end();
                            });
                            if (!msTokenResult.error && msTokenResult.access_token) {
                                const msAccessToken = msTokenResult.access_token;
                                const msRefreshTokenNew = msTokenResult.refresh_token || account.refreshToken;
                                const xblResult = await fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                                    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                                    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
                                }), { 'Content-Type': 'application/json' });
                                const xblToken = xblResult.Token;
                                const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';
                                const xstsResult = await fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                                    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                                    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
                                }), { 'Content-Type': 'application/json' });
                                if (!xstsResult.XErr) {
                                    const xstsToken = xstsResult.Token;
                                    const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;
                                    const mcResult = await fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                                        identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                                    }), { 'Content-Type': 'application/json' });
                                    if (mcResult.access_token) {
                                        const refreshNow = new Date();
                                        account.accessToken = mcResult.access_token;
                                        account.refreshToken = msRefreshTokenNew;
                                        account.tokenExpiresAt = refreshNow.getTime() + (msTokenResult.expires_in || 3600) * 1000;
                                        account.lastRefreshed = refreshNow.toISOString();
                                        const accts = loadAccounts();
                                        const idx = accts.findIndex(a => a.id === account.id);
                                        if (idx >= 0) { accts[idx] = { ...accts[idx], ...account }; saveAccounts(accts); }
                                        console.log(`[Launch] 微软账号Token刷新成功`);
                                    }
                                }
                            } else {
                                console.warn(`[Launch] 微软Token刷新失败: ${msTokenResult.error}, 使用旧Token尝试启动`);
                            }
                        } catch (refreshErr) {
                            console.warn(`[Launch] 微软Token刷新异常: ${refreshErr.message}, 使用旧Token尝试启动`);
                        }
                    }
                }

                const result = await launchGame(versionId, settings, account);
                if (result.success) {
                    try {
                        const playTimePath = path.join(DATA_DIR, 'play-time.json');
                        let ptData = {};
                        if (fs.existsSync(playTimePath)) {
                            try { ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8')); } catch (e) {}
                        }
                        if (!ptData[versionId]) ptData[versionId] = { totalSeconds: 0, playCount: 0, lastPlayed: null };
                        ptData[versionId].lastPlayed = new Date().toISOString();
                        ptData[versionId].playCount = (ptData[versionId].playCount || 0) + 1;
                        ptData[versionId]._launchTime = Date.now();
                        ensureDir(playTimePath);
                        fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
                    } catch (e) {
                        console.error('[PlayTime] 记录启动时间失败:', e.message);
                    }
                }
                sendJSON(result);
                break;
            }

            case '/api/launch/check': {
                const lcData = await readBody();
                const lcVersionId = lcData.versionId;
                if (!lcVersionId) { sendError('Missing versionId', 400); break; }
                const lcSettings = loadSettingsCached();
                const lcCleanId = lcVersionId.replace(' [外部]', '');
                let lcExternalDir = null;
                const lcExtFolders = loadExternalFolders();
                for (const folder of lcExtFolders) {
                    if (!fs.existsSync(folder.path)) continue;
                    const extVers = scanExternalFolder(folder.path);
                    const extV = extVers.find(v => v.id === lcCleanId);
                    if (extV) { lcExternalDir = extV.externalVersionDir; break; }
                }
                const depResult = await checkDependencies(lcCleanId, lcSettings, lcExternalDir);
                sendJSON({ success: true, ...depResult });
                break;
            }

            case '/api/launch/download-deps': {
                const ldData = await readBody();
                const ldVersionId = ldData.versionId;
                const ldSessionId = ldData.sessionId;
                if (!ldVersionId) { sendError('Missing versionId', 400); break; }

                const ldSettings = loadSettingsCached();
                const ldCleanId = ldVersionId.replace(' [外部]', '');
                let ldExternalDir = null;
                const ldExtFolders = loadExternalFolders();
                for (const folder of ldExtFolders) {
                    if (!fs.existsSync(folder.path)) continue;
                    const extVers = scanExternalFolder(folder.path);
                    const extV = extVers.find(v => v.id === ldCleanId);
                    if (extV) { ldExternalDir = extV.externalVersionDir; break; }
                }
                const ldDepCheck = await checkDependencies(ldCleanId, ldSettings, ldExternalDir);
                const ldVersionJson = resolveVersionJson(ldCleanId, ldExternalDir);

                if (ldDepCheck.missingFiles.length === 0) {
                    sendJSON({ success: true, message: '无需下载', completed: 0, failed: 0 });
                    break;
                }

                const dlSessionId = ldSessionId || `launch-${Date.now()}`;
                if (!launchSessions.has(dlSessionId)) {
                    launchSessions.set(dlSessionId, {
                        status: 'downloading',
                        progress: 0,
                        message: `正在下载 ${ldDepCheck.missingFiles.length} 个缺失文件..`,
                        totalFiles: ldDepCheck.missingFiles.length,
                        completedFiles: 0,
                        currentFile: '',
                        errors: [],
                        versionId: ldVersionId
                    });
                }

                sendJSON({ success: true, sessionId: dlSessionId, missingCount: ldDepCheck.missingFiles.length });

                downloadMissingDependencies(ldDepCheck.missingFiles, (progress) => {
                    const session = launchSessions.get(dlSessionId);
                    if (session) {
                        session.progress = progress.progress;
                        session.currentFile = progress.file;
                        session.completedFiles = progress.current;
                        session.message = `下载文件 (${progress.current}/${progress.total}): ${progress.file}`;
                        session.speed = progress.speed;
                        session.activeDownloads = progress.activeDownloads || [];
                        session.completed = progress.completed || 0;
                        session.failed = progress.failed || 0;
                        session.queued = progress.queued || 0;
                        session.concurrentDownloads = progress.concurrentDownloads || 10;
                        session.failedFiles = progress.failedFiles || [];
                    }
                }, ldVersionJson).then(async (result) => {
                    const session = launchSessions.get(dlSessionId);
                    if (session) {
                        session.errors = result.errors;
                        session.failedFiles = result.failedFiles || [];
                        if (result.failed > 0 && result.completed === 0) {
                            session.status = 'failed';
                            session.message = `下载失败: ${result.failed} 个文件下载失败`;
                        } else {
                            session.status = 'completed';
                            session.message = `下载完成: ${result.completed} 个成功, ${result.failed} 个失败`;

                            if (result.failed === 0) {
                                const versionJson = resolveVersionJson(ldVersionId, ldExternalDir);
                                const accounts = loadAccounts();
                                const account = accounts.find(a => a.id === ldSettings.selectedAccount) || accounts[0] || { username: 'Player', type: 'offline' };
                                const launchResult = await doLaunch(ldVersionId, versionJson, ldSettings, account, ldExternalDir);
                                session.launchResult = launchResult;
                                if (launchResult.success) {
                                    session.status = 'launched';
                                    session.message = '游戏启动成功';
                                } else {
                                    session.status = 'launch_failed';
                                    session.message = `启动失败: ${launchResult.error}`;
                                }
                            }
                        }
                    }
                }).catch((e) => {
                    const session = launchSessions.get(dlSessionId);
                    if (session) {
                        session.status = 'failed';
                        session.message = `下载失败: ${e.message}`;
                    }
                });

                break;
            }

            case '/api/launch/session-status': {
                const lsSessionId = parsedUrl.query.sessionId;
                if (!lsSessionId || !launchSessions.has(lsSessionId)) {
                    sendJSON({ status: 'unknown', progress: 0, message: '' });
                    break;
                }
                const lsSession = launchSessions.get(lsSessionId);
                const response = {
                    status: lsSession.status,
                    progress: lsSession.progress,
                    message: lsSession.message,
                    currentFile: lsSession.currentFile || '',
                    totalFiles: lsSession.totalFiles || 0,
                    completedFiles: lsSession.completedFiles || 0,
                    errors: lsSession.errors || [],
                    launchResult: lsSession.launchResult || null,
                    activeDownloads: lsSession.activeDownloads || [],
                    completed: lsSession.completed || 0,
                    failed: lsSession.failed || 0,
                    speed: DownloadManager.getSpeed() || lsSession.speed || 0,
                    queued: lsSession.queued || 0,
                    concurrentDownloads: lsSession.concurrentDownloads || 16,
                    activeConnections: DownloadManager.activeConnections,
                    connectionLimit: DownloadManager.connectionLimit,
                    failedFiles: lsSession.failedFiles || []
                };
                sendJSON(response);
                if (['launched', 'launch_failed', 'failed'].includes(lsSession.status)) {
                    setTimeout(() => launchSessions.delete(lsSessionId), 60000);
                }
                break;
            }

            case '/api/launch/diagnose': {
                const diagVersionId = parsedUrl.query.versionId;
                const diagExternal = parsedUrl.query.externalDir || '';
                if (!diagVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    const extDir = diagExternal || null;
                    const versionJson = resolveVersionJson(diagVersionId, extDir);
                    if (!versionJson) { sendError('版本JSON缺失', 400); break; }

                    const settings = loadSettingsCached();
                    const accounts = loadAccounts();
                    const account = accounts.find(a => a.id === settings.selectedAccount) || accounts[0] || { username: 'Player', type: 'offline' };

                    const diagResult = {
                        versionId: diagVersionId,
                        externalDir: extDir,
                        mainClass: versionJson.mainClass || 'N/A',
                        inheritsFrom: versionJson.inheritsFrom || null,
                        librariesCount: (versionJson.libraries || []).length,
                        javaPath: 'auto-detect',
                        classpathEntries: [],
                        missingLibraries: [],
                        criticalMissing: [],
                        mainJarFound: false,
                        mainJarPath: null,
                        argsPreview: null
                    };

                    const javaPath = findJavaPath(versionJson, settings);
                    diagResult.javaPath = javaPath;
                    diagResult.javaMajorVersion = getJavaMajorVersion(javaPath);

                    const classpathStr = buildClasspath(versionJson, diagVersionId, extDir);
                    const cpEntries = classpathStr.split(';');
                    diagResult.classpathEntries = cpEntries;

                    for (const entry of cpEntries) {
                        if (!fs.existsSync(entry)) {
                            diagResult.missingLibraries.push(entry);
                            const bn = path.basename(entry).toLowerCase();
                            if (bn.includes('securejarhandler') || bn.includes('forge') || bn.includes('neoforge') ||
                                bn.includes('fmlloader') || bn.includes('modlauncher') || bn.includes('fabric-loader') ||
                                bn.includes('launchwrapper') || bn.includes('log4j') || bn.includes('lwjgl')) {
                                diagResult.criticalMissing.push(entry);
                            }
                        }
                    }

                    const actualVersionId = diagVersionId || versionJson.id || '';
                    const jarSearchPaths = [];
                    if (extDir) {
                        const er = findExternalRoot(extDir);
                        if (er) jarSearchPaths.push(path.join(er, 'versions', actualVersionId, `${actualVersionId}.jar`));
                        jarSearchPaths.push(path.join(extDir, `${actualVersionId}.jar`));
                        jarSearchPaths.push(path.join(extDir, `${path.basename(extDir)}.jar`));
                    }
                    jarSearchPaths.push(path.join(VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`));
                    for (const p of jarSearchPaths) {
                        if (fs.existsSync(p)) {
                            diagResult.mainJarFound = true;
                            diagResult.mainJarPath = p;
                            break;
                        }
                    }

                    try {
                        const args = buildLaunchArguments(versionJson, settings, account, diagVersionId,
                            extDir ? path.dirname(extDir) : path.join(DATA_DIR, 'minecraft'),
                            extDir);
                        diagResult.argsPreview = args;
                        diagResult.argsCount = args.length;
                        diagResult.estimatedCmdLength = javaPath.length + args.reduce((sum, a) => sum + a.length + 3, 0);
                    } catch (e) {
                        diagResult.argsPreviewError = e.message;
                    }

                    sendJSON(diagResult);
                } catch (e) {
                    sendError('诊断失败: ' + e.message);
                }
                break;
            }

            case '/api/version/open-folder': {
                const vofVersionId = parsedUrl.query.versionId;
                const vofFolderType = parsedUrl.query.folderType || 'version';
                if (!vofVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const cleanVofId = vofVersionId.replace(' [外部]', '');
                    let externalVersionDir = null;
                    const extFolders = loadExternalFolders();
                    for (const folder of extFolders) {
                        if (!fs.existsSync(folder.path)) continue;
                        const extVers = scanExternalFolder(folder.path);
                        const extV = extVers.find(v => v.id === cleanVofId);
                        if (extV) {
                            externalVersionDir = extV.externalVersionDir;
                            break;
                        }
                    }
                    let targetPath;
                    const gameDir = getVersionGameDir(vofVersionId);
                    if (gameDir) {
                        switch (vofFolderType) {
                            case 'version': targetPath = gameDir; break;
                            case 'saves': targetPath = path.join(gameDir, 'saves'); break;
                            case 'mods': targetPath = path.join(gameDir, 'mods'); break;
                            default: targetPath = gameDir; break;
                        }
                    } else {
                        targetPath = path.join(VERSIONS_DIR, cleanVofId);
                    }
                    if (!fs.existsSync(targetPath)) { fs.mkdirSync(targetPath, { recursive: true }); }
                    const resolvedTarget = path.resolve(targetPath);
                    if (!resolvedTarget.startsWith(path.resolve(VERSIONS_DIR)) && !resolvedTarget.startsWith(path.resolve(DATA_DIR))) {
                        sendJSON({ success: false, error: '不允许访问该路径' }); break;
                    }
                    require('electron').shell.openPath(resolvedTarget);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/rename': {
                const body3 = await readBody();
                const { versionId: rvrId, newName } = body3;
                if (!rvrId || !newName) { sendError('Missing params', 400); break; }
                try {
                    const versionsData = loadVersions();
                    const ver = versionsData.find(v => v.id === rvrId);
                    if (ver) {
                        ver.customName = newName;
                        saveVersions(versionsData);
                        sendJSON({ success: true });
                    } else { sendError('Version not found', 404); }
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/export-script': {
                const body4 = await readBody();
                const { versionId: esId } = body4;
                if (!esId) { sendError('Missing versionId', 400); break; }
                try {
                    const verDir = path.join(VERSIONS_DIR, esId);
                    const verJsonPath = path.join(verDir, `${esId}.json`);
                    if (!fs.existsSync(verJsonPath)) { sendJSON({ success: false, error: 'Version JSON not found' }); break; }
                    const verJson = JSON.parse(fs.readFileSync(verJsonPath, 'utf-8'));
                    const globalSettings = loadSettingsCached();
                    const verSettings = loadVersionSettings(esId);

                    let actualVersionId = esId;
                    let mainClass = verJson.mainClass || 'net.minecraft.client.main.Main';
                    let libraries = verJson.libraries || [];
                    let gameArgs = verJson.minecraftArguments || '';
                    if (verJson.arguments) {
                        if (verJson.arguments.game) {
                            gameArgs = verJson.arguments.game.filter(a => typeof a === 'string').join(' ');
                        }
                    }

                    let classPathParts = [];
                    let parentJson = verJson;
                    if (verJson.inheritsFrom) {
                        actualVersionId = verJson.inheritsFrom;
                        const parentJsonPath = path.join(VERSIONS_DIR, verJson.inheritsFrom, `${verJson.inheritsFrom}.json`);
                        if (fs.existsSync(parentJsonPath)) {
                            parentJson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
                            mainClass = parentJson.mainClass || mainClass;
                            libraries = [...(parentJson.libraries || []), ...libraries];
                            if (!gameArgs) {
                                gameArgs = parentJson.minecraftArguments || '';
                                if (parentJson.arguments && parentJson.arguments.game) {
                                    gameArgs = parentJson.arguments.game.filter(a => typeof a === 'string').join(' ');
                                }
                            }
                        }
                    }

                    libraries.forEach(lib => {
                        if (lib.downloads && lib.downloads.artifact) {
                            const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path || '');
                            classPathParts.push(libPath);
                        } else if (lib.name) {
                            const parts = lib.name.split(':');
                            if (parts.length >= 3) {
                                const pkgPath = parts[0].replace(/\./g, '/');
                                const libPath = path.join(LIBRARIES_DIR, pkgPath, parts[1], parts[2], `${parts[1]}-${parts[2]}.jar`);
                                classPathParts.push(libPath);
                            }
                        }
                    });

                    const jarPath = path.join(VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`);
                    classPathParts.push(jarPath);

                    let maxMem = globalSettings.maxMemory || 4096;
                    try {
                        const storePath2 = path.join(require('os').homedir(), '.versepc', 'app-store.json');
                        if (fs.existsSync(storePath2)) {
                            const store2 = JSON.parse(fs.readFileSync(storePath2, 'utf8'));
                            const ls2 = store2['versepc_launch_settings'];
                            if (ls2) {
                                const lsObj = JSON.parse(ls2);
                                if (lsObj.memoryMode === 'auto') {
                                    const tMB = Math.floor(os.totalmem() / 1024 / 1024);
                                    let aMB;
                                    if (tMB <= 2500) aMB = 1024;
                                    else if (tMB <= 4500) aMB = tMB - 1500;
                                    else if (tMB <= 8500) aMB = tMB - 2048;
                                    else aMB = tMB - 4096;
                                    aMB = Math.max(512, Math.min(aMB, 32768));
                                    maxMem = Math.floor(aMB / 256) * 256;
                                } else if (lsObj.memoryMode === 'custom') {
                                    maxMem = parseInt(lsObj.memoryValue, 10) || 4096;
                                }
                            }
                        }
                    } catch (e2) {}
                    if (verSettings.memoryMode === 'custom') maxMem = verSettings.memoryValue || maxMem;
                    const minMem = Math.min(1024, maxMem);
                    const javaPath = verSettings.javaPath === 'global' ? (globalSettings.javaPath || 'java') : verSettings.javaPath;
                    const jvmArgs = verSettings.jvmArgs || globalSettings.javaArgs || '';
                    const customGameArgs = verSettings.gameArgs || '';
                    const assetsDir = path.join(DATA_DIR, 'assets');
                    const assetIndex = parentJson.assetIndex ? parentJson.assetIndex.id : actualVersionId;
                    const gameDir = resolveVersionIsolation(esId) ? verDir : DATA_DIR;

                    let scriptContent = `@echo off\r\n`;
                    scriptContent += `chcp 65001 >nul\r\n`;
                    scriptContent += `echo VersePC - Launch Script for ${esId}\r\n`;
                    scriptContent += `echo ============================================\r\n`;
                    scriptContent += `echo Version: ${esId}\r\n`;
                    scriptContent += `echo Max Memory: ${maxMem}MB\r\n`;
                    scriptContent += `echo ============================================\r\n`;
                    scriptContent += `echo.\r\n\r\n`;
                    scriptContent += `"${javaPath}" -Xmx${maxMem}M -Xms${minMem}M ${jvmArgs} -Djava.library.path="${path.join(verDir, 'natives')}" -Dminecraft.launcher.brand=VersePC -Dminecraft.launcher.version=1.0 -cp "${classPathParts.join(';')}" ${mainClass} --username Player --version ${esId} --gameDir "${gameDir}" --assetsDir "${assetsDir}" --assetIndex ${assetIndex} --uuid 00000000-0000-0000-0000-000000000000 --accessToken 0 --userType legacy ${gameArgs} ${customGameArgs}\r\n`;
                    scriptContent += `echo.\r\n`;
                    scriptContent += `echo Game exited.\r\n`;
                    scriptContent += `pause\r\n`;

                    const scriptPath = path.join(verDir, 'launch.bat');
                    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
                    sendJSON({ success: true, path: scriptPath });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            // ====================================================================
            // 版本文件修复功能
            // ====================================================================

            case '/api/version/repair-start': {
                const body5 = await readBody();
                const { versionId: rfId } = body5;
                if (!rfId) { sendError('Missing versionId', 400); break; }

                const verDir = path.join(VERSIONS_DIR, rfId);
                if (!fs.existsSync(verDir)) { sendError('Version not found', 404); break; }

                const sessionId = `repair_${rfId}_${Date.now()}`;
                repairSessions.set(sessionId, {
                    versionId: rfId, status: 'preparing', progress: 0, stage: 'preparing',
                    message: '准备修复...', startTime: Date.now(), checkedFiles: 0, totalFiles: 0,
                    missingFiles: 0, repairedFiles: 0, currentFile: '',
                    _abortController: new AbortController()
                });

                performRepair(sessionId, rfId);
                sendJSON({ success: true, sessionId });
                break;
            }

            case '/api/version/repair-progress': {
                const rpSessionId = parsedUrl.query.sessionId;
                if (!rpSessionId || !repairSessions.has(rpSessionId)) { sendError('Invalid session', 404); break; }
                const rpSession = repairSessions.get(rpSessionId);

                if (parsedUrl.query.sse === 'true') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                    const interval = setInterval(() => {
                        const s = repairSessions.get(rpSessionId);
                        if (!s || s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') {
                            if (s) res.write(`data: ${JSON.stringify({ status: s.status, progress: s.progress, message: s.message, stage: s.stage, checkedFiles: s.checkedFiles, totalFiles: s.totalFiles, missingFiles: s.missingFiles, repairedFiles: s.repairedFiles, currentFile: s.currentFile })}\n\n`);
                            res.end(); clearInterval(interval); return;
                        }
                        res.write(`data: ${JSON.stringify({ status: s.status, progress: s.progress, message: s.message, stage: s.stage, checkedFiles: s.checkedFiles, totalFiles: s.totalFiles, missingFiles: s.missingFiles, repairedFiles: s.repairedFiles, currentFile: s.currentFile })}\n\n`);
                    }, 300);
                    req.on('close', () => { clearInterval(interval); res.end(); });
                } else {
                    sendJSON({
                        status: rpSession.status, progress: rpSession.progress, message: rpSession.message,
                        stage: rpSession.stage, checkedFiles: rpSession.checkedFiles, totalFiles: rpSession.totalFiles,
                        missingFiles: rpSession.missingFiles, repairedFiles: rpSession.repairedFiles,
                        currentFile: rpSession.currentFile
                    });
                }
                break;
            }

            case '/api/version/repair-cancel': {
                const rcSessionId = parsedUrl.query.sessionId;
                if (!rcSessionId || !repairSessions.has(rcSessionId)) { sendError('Invalid session', 404); break; }
                const rcSession = repairSessions.get(rcSessionId);
                rcSession.status = 'cancelled'; rcSession.stage = 'cancelled'; rcSession.message = '修复已取消';
                if (rcSession._abortController) { try { rcSession._abortController.abort(); } catch (e) {} }
                sendJSON({ success: true });
                break;
            }

            case '/api/version/delete': {
                const body6 = await readBody();
                const { versionId: dvId } = body6;
                if (!dvId) { sendError('Missing versionId', 400); break; }
                try {
                    const toDelete = cleanupVersionChain(dvId);
                    
                    let versionsData = loadVersions();
                    versionsData = versionsData.filter(v => !toDelete.includes(v.id));
                    saveVersions(versionsData);
                    sendJSON({ success: true, deleted: toDelete });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/settings': {
                const vsVersionId = parsedUrl.query.versionId;
                if (!vsVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const vs = loadVersionSettings(vsVersionId);
                    sendJSON(vs);
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/settings/save': {
                const vsData = await readBody();
                const vsId = vsData.versionId;
                if (!vsId) { sendError('Missing versionId', 400); break; }
                try {
                    const existing = loadVersionSettings(vsId);
                    const merged = { ...existing, ...vsData, versionId: vsId };
                    saveVersionSettings(vsId, merged);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/description': {
                const descData = await readBody();
                const descId = descData.versionId;
                const descText = descData.description || '';
                if (!descId) { sendError('Missing versionId', 400); break; }
                try {
                    const vs = loadVersionSettings(descId);
                    vs.description = descText;
                    saveVersionSettings(descId, vs);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/favorite': {
                const favData = await readBody();
                const favId = favData.versionId;
                const favState = favData.favorite !== false;
                if (!favId) { sendError('Missing versionId', 400); break; }
                try {
                    const vs = loadVersionSettings(favId);
                    vs.favorite = favState;
                    saveVersionSettings(favId, vs);
                    sendJSON({ success: true, favorite: favState });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/icon': {
                const iconData = await readBody();
                const iconId = iconData.versionId;
                const iconType = iconData.icon || 'auto';
                if (!iconId) { sendError('Missing versionId', 400); break; }
                try {
                    const vs = loadVersionSettings(iconId);
                    vs.icon = iconType;
                    saveVersionSettings(iconId, vs);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/category': {
                const catData = await readBody();
                const catId = catData.versionId;
                const catType = catData.category || 'auto';
                if (!catId) { sendError('Missing versionId', 400); break; }
                try {
                    const vs = loadVersionSettings(catId);
                    vs.category = catType;
                    saveVersionSettings(catId, vs);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/add-folder': {
                const afData = await readBody();
                const afPath = afData.path;
                const afName = afData.name || '';
                if (!afPath) { sendError('Missing path', 400); break; }
                try {
                    if (!fs.existsSync(afPath)) {
                        sendJSON({ success: false, error: '文件夹不存在: ' + afPath });
                        break;
                    }
                    const stat = fs.statSync(afPath);
                    if (!stat.isDirectory()) {
                        sendJSON({ success: false, error: '路径不是文件夹: ' + afPath });
                        break;
                    }
                    const versionsDir = path.join(afPath, 'versions');
                    if (!fs.existsSync(versionsDir)) {
                        sendJSON({ success: false, error: '该文件夹下未找到 versions 子目录，请选择有效的 Minecraft 文件夹' });
                        break;
                    }
                    const folders = loadExternalFolders();
                    if (folders.some(f => f.path === afPath)) {
                        sendJSON({ success: false, error: '该文件夹已添加' });
                        break;
                    }
                    const scannedVersions = scanExternalFolder(afPath);
                    if (scannedVersions.length === 0) {
                        sendJSON({ success: false, error: '该文件夹下未找到有效的 Minecraft 版本' });
                        break;
                    }
                    const folderName = afName || path.basename(afPath);
                    folders.push({ path: afPath, name: folderName, addedAt: new Date().toISOString() });
                    saveExternalFolders(folders);
                    console.log(`[ExternalFolder] 添加外部文件夹: ${afPath}, 发现 ${scannedVersions.length} 个版本`);
                    sendJSON({
                        success: true,
                        folder: { path: afPath, name: folderName },
                        versions: scannedVersions.map(v => ({
                            id: v.id,
                            type: v.type,
                            isFabric: v.isFabric,
                            isForge: v.isForge,
                            isNeoForge: v.isNeoForge
                        }))
                    });
                } catch (e) {
                    console.error('[ExternalFolder] 添加失败:', e.message);
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/version/remove-folder': {
                const rfData = await readBody();
                const rfPath = rfData.path;
                if (!rfPath) { sendError('Missing path', 400); break; }
                try {
                    let folders = loadExternalFolders();
                    const before = folders.length;
                    folders = folders.filter(f => f.path !== rfPath);
                    if (folders.length === before) {
                        sendJSON({ success: false, error: '未找到该外部文件夹' });
                        break;
                    }
                    saveExternalFolders(folders);
                    console.log(`[ExternalFolder] 移除外部文件夹: ${rfPath}`);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/list-folders': {
                try {
                    const folders = loadExternalFolders();
                    const result = folders.map(f => {
                        const exists = fs.existsSync(f.path);
                        let versionCount = 0;
                        if (exists) {
                            const vDir = path.join(f.path, 'versions');
                            if (fs.existsSync(vDir)) {
                                versionCount = fs.readdirSync(vDir).filter(d => {
                                    const subDir = path.join(vDir, d);
                                    return fs.statSync(subDir).isDirectory() && fs.existsSync(path.join(subDir, d + '.json'));
                                }).length;
                            }
                        }
                        return { ...f, exists, versionCount };
                    });
                    sendJSON({ success: true, folders: result });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/select-folder': {
                try {
                    const { dialog, BrowserWindow: BW } = require('electron');
                    const win = BW.getAllWindows()[0] || null;
                    const result = await dialog.showOpenDialog(win, {
                        properties: ['openDirectory'],
                        title: '选择 Minecraft 文件夹'
                    });
                    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                        sendJSON({ success: false, cancelled: true });
                        break;
                    }
                    const selectedPath = result.filePaths[0];
                    sendJSON({ success: true, path: selectedPath });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/mods/open-save-folder': {
                try {
                    const settings = loadSettingsCached();
                    let modsDir = getVersionModsDir(settings.selectedVersion);
                    
                    if (!modsDir) {
                        const installedVersions = getInstalledVersions();
                        if (installedVersions.length > 0) {
                            modsDir = getVersionModsDir(installedVersions[0].id);
                        }
                        if (!modsDir) {
                            sendError('请先安装一个游戏版本');
                            break;
                        }
                    }
                    
                    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                    require('child_process').exec(`explorer "${modsDir}"`);
                    sendJSON({ success: true, path: modsDir });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/mods/installed': {
                await new Promise(r => setImmediate(r));
                const imVersionId = parsedUrl.query.versionId;
                if (!imVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const modsDir = getVersionModsDir(imVersionId);
                    if (!modsDir) { sendJSON({ mods: [], total: 0 }); break; }
                    const mods = [];
                    if (fs.existsSync(modsDir)) {
                        const MAX_MODS = 200;
                        const allFiles = await fs.promises.readdir(modsDir);
                        const jarFiles = allFiles.filter(f => (f.endsWith('.jar') || f.endsWith('.zip'))).slice(0, MAX_MODS);
                        for (let i = 0; i < jarFiles.length; i++) {
                            const f = jarFiles[i];
                            const isDisabled = f.endsWith('.disabled');
                            const realName = isDisabled ? f.replace('.disabled', '') : f;
                            const name = realName.replace(/\.(jar|zip)$/, '');
                            let stat;
                            try {
                                stat = await fs.promises.stat(path.join(modsDir, f));
                            } catch (e) { stat = { size: 0 }; }
                            const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

                            let icon = '', author = '', description = '', version = '', projectId = '';
                            const jarPath = path.join(modsDir, f);
                            if (realName.endsWith('.jar') && fs.existsSync(jarPath)) {
                                try {
                                    const parsed = parseModJar(jarPath);
                                    if (parsed.icon) icon = `/api/mod-icon?hash=${parsed.icon}`;
                                    if (parsed.author) author = parsed.author;
                                    if (parsed.description) description = parsed.description.substring(0, 200);
                                    if (parsed.version) version = parsed.version;
                                    if (parsed.id) projectId = parsed.id;
                                } catch (e) { /* fallback to empty */ }
                            }

                            mods.push({
                                id: id,
                                name: name,
                                fileName: f,
                                disabled: isDisabled,
                                description: description || (isDisabled ? '已禁用' : '已安装的模组'),
                                version: version || '1.0',
                                size: stat.size || 0,
                                source: '本地',
                                icon: icon,
                                author: author,
                                projectId: projectId
                            });

                            if (i % 30 === 29) {
                                await new Promise(r => setImmediate(r));
                            }
                        }
                    }
                    sendJSON(mods);
                } catch (e) { sendJSON([]); }
                break;
            }

            case '/api/mods/select-modpack-file': {
                try {
                    const result = await new Promise((resolve, reject) => {
                        const { dialog, BrowserWindow: BW } = require('electron');
                        dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
                            properties: ['openFile'],
                            filters: [
                                { name: 'Modpack Files', extensions: ['mrpack', 'zip'] },
                                { name: 'All Files', extensions: ['*'] }
                            ]
                        }).then(r => resolve(r)).catch(reject);
                    });
                    if (result.canceled || !result.filePaths.length) {
                        sendJSON(null);
                    } else {
                        sendJSON({ filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
                    }
                } catch (e) { sendJSON(null); }
                break;
            }

            case '/api/mods/select-file': {
                try {
                    const result = await new Promise((resolve, reject) => {
                        const { dialog, BrowserWindow: BW } = require('electron');
                        dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
                            properties: ['openFile'],
                            filters: [{ name: 'Mod Files', extensions: ['jar', 'zip'] }]
                        }).then(r => resolve(r)).catch(reject);
                    });
                    if (result.canceled || !result.filePaths.length) {
                        sendJSON(null);
                    } else {
                        sendJSON({ filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
                    }
                } catch (e) { sendJSON(null); }
                break;
            }

            case '/api/mods/select-save-folder': {
                try {
                    const ssfData = await readBody();
                    const ssfDefaultPath = ssfData.defaultPath || '';
                    const { ipcMain } = require('electron');
                    const allWindows = require('electron').BrowserWindow.getAllWindows();
                    const win = allWindows.length > 0 ? allWindows[0] : null;
                    let result;
                    if (win && win.webContents) {
                        result = await win.webContents.executeJavaScript(`window.electronAPI?.selectSaveFolder?.(${JSON.stringify(ssfDefaultPath)})`).catch(() => null);
                    }
                    if (!result) {
                        const { dialog } = require('electron');
                        result = await dialog.showOpenDialog(win, {
                            properties: ['openDirectory'],
                            title: '选择模组保存文件夹',
                            defaultPath: ssfDefaultPath || undefined
                        });
                        result = { cancelled: result.canceled || !result.filePaths.length, path: result.filePaths?.[0] || '' };
                    }
                    if (result.cancelled) {
                        sendJSON({ cancelled: true, error: result.error || '' });
                    } else {
                        sendJSON({ cancelled: false, path: result.path });
                    }
                } catch (e) {
                    console.error('[select-save-folder] dialog error:', e);
                    sendJSON({ cancelled: true, error: e.message });
                }
                break;
            }

            case '/api/mods/get-dependencies': {
                const gdData = await readBody();
                const gdVersionId = gdData.versionId;
                const gdSource = gdData.source || 'modrinth';
                const gdGameVersion = gdData.gameVersion || '';
                const gdLoader = gdData.loader || '';
                try {
                    let versionData = null;
                    if (gdSource === 'modrinth') {
                        if (gdVersionId) {
                            versionData = await cachedFetchJSON(`${MODRINTH_API}/version/${gdVersionId}`, 300000);
                        }
                    }
                    const deps = [];
                    if (versionData && versionData.dependencies) {
                        const requiredDeps = versionData.dependencies.filter(d =>
                            d.dependency_type === 'required' && d.project_id &&
                            d.project_id !== 'P7dR8mSH' && d.project_id !== 'qvIfYCYJ'
                        );
                        if (requiredDeps.length > 0) {
                            const depIds = requiredDeps.map(d => `"${d.project_id}"`).join(',');
                            try {
                                const depProjects = await cachedFetchJSON(`${MODRINTH_API}/projects?ids=[${depIds}]`, 300000);
                                const depVersionPromises = requiredDeps.map(async dep => {
                                    const proj = depProjects?.find(p => p.id === dep.project_id);
                                    let compatibleVersion = null;
                                    if (proj) {
                                        try {
                                            let depVerUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                                            const depParams = [];
                                            if (gdGameVersion) depParams.push(`game_versions=["${gdGameVersion}"]`);
                                            if (gdLoader) depParams.push(`loaders=["${gdLoader}"]`);
                                            depParams.push('limit=1');
                                            const depVersions = await cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                            if (depVersions?.length) {
                                                const depFile = depVersions[0].files?.find(f => f.primary) || depVersions[0].files?.[0];
                                                compatibleVersion = {
                                                    versionId: depVersions[0].id,
                                                    versionNumber: depVersions[0].version_number,
                                                    fileName: depFile?.filename,
                                                    downloadUrl: depFile?.url,
                                                    size: depFile?.size || 0
                                                };
                                            }
                                        } catch (e) {}
                                    }
                                    return {
                                        projectId: dep.project_id,
                                        title: proj?.title || dep.project_id,
                                        icon: proj?.icon_url || '',
                                        description: proj?.description || '',
                                        compatibleVersion
                                    };
                                });
                                const depResults = await Promise.all(depVersionPromises);
                                deps.push(...depResults);
                            } catch (e) {}
                        }
                    }
                    sendJSON({ dependencies: deps });
                } catch (e) {
                    sendJSON({ dependencies: [] });
                }
                break;
            }

            case '/api/mods/get-dependencies-recursive': {
                const gdrData = await readBody();
                const gdrVersionId = gdrData.versionId;
                const gdrSource = gdrData.source || 'modrinth';
                const gdrGameVersion = gdrData.gameVersion || '';
                const gdrLoader = gdrData.loader || '';
                try {
                    const allDeps = [];
                    const visited = new Set();
                    const SKIP_PROJECTS = new Set(['P7dR8mSH', 'qvIfYCYJ']);

                    async function resolveDeps(versionId, parentProjectId, depth) {
                        if (depth > 10) return;
                        let versionData = null;
                        if (gdrSource === 'modrinth') {
                            versionData = await cachedFetchJSON(`${MODRINTH_API}/version/${versionId}`, 300000);
                        }
                        if (!versionData || !versionData.dependencies) return;
                        const requiredDeps = versionData.dependencies.filter(d =>
                            d.dependency_type === 'required' && d.project_id &&
                            !SKIP_PROJECTS.has(d.project_id)
                        );
                        if (requiredDeps.length === 0) return;
                        const depIds = requiredDeps.map(d => `"${d.project_id}"`).join(',');
                        let depProjects = [];
                        try {
                            depProjects = await cachedFetchJSON(`${MODRINTH_API}/projects?ids=[${depIds}]`, 300000) || [];
                        } catch (e) {}
                        for (const dep of requiredDeps) {
                            if (visited.has(dep.project_id)) continue;
                            visited.add(dep.project_id);
                            const proj = depProjects.find(p => p.id === dep.project_id);
                            let compatibleVersion = null;
                            try {
                                let depVerUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                                const depParams = [];
                                if (gdrGameVersion) depParams.push(`game_versions=["${gdrGameVersion}"]`);
                                if (gdrLoader) depParams.push(`loaders=["${gdrLoader}"]`);
                                depParams.push('limit=1');
                                const depVersions = await cachedFetchJSON(depVerUrl + '?' + depParams.join('&'), 120000);
                                if (depVersions?.length) {
                                    const depFile = depVersions[0].files?.find(f => f.primary) || depVersions[0].files?.[0];
                                    compatibleVersion = {
                                        versionId: depVersions[0].id,
                                        versionNumber: depVersions[0].version_number,
                                        fileName: depFile?.filename,
                                        downloadUrl: depFile?.url,
                                        size: depFile?.size || 0
                                    };
                                    await resolveDeps(depVersions[0].id, dep.project_id, depth + 1);
                                }
                            } catch (e) {}
                            allDeps.push({
                                projectId: dep.project_id,
                                title: proj?.title || dep.project_id,
                                icon: proj?.icon_url || '',
                                description: proj?.description || '',
                                compatibleVersion,
                                depth,
                                parentProjectId: parentProjectId || null
                            });
                        }
                    }

                    await resolveDeps(gdrVersionId, null, 1);
                    sendJSON({ dependencies: allDeps });
                } catch (e) {
                    sendJSON({ dependencies: [] });
                }
                break;
            }

            case '/api/mods/project-versions': {
                const pvData = await readBody();
                const pvProjectId = pvData.projectId;
                const pvSource = pvData.source || 'modrinth';
                const pvGameVersion = pvData.gameVersion || '';
                const pvLoader = pvData.loader || '';
                try {
                    if (pvSource !== 'modrinth' || !pvProjectId) {
                        sendJSON({ versions: [] });
                        break;
                    }
                    let verUrl = `${MODRINTH_API}/project/${pvProjectId}/version`;
                    const verParams = [];
                    if (pvGameVersion) verParams.push(`game_versions=["${pvGameVersion}"]`);
                    if (pvLoader) verParams.push(`loaders=["${pvLoader}"]`);
                    if (verParams.length) verUrl += '?' + verParams.join('&');
                    const rawVersions = await cachedFetchJSON(verUrl, 600000);
                    const versions = (rawVersions || []).map(v => ({
                        versionId: v.id,
                        versionNumber: v.version_number,
                        gameVersions: v.game_versions || [],
                        loaders: v.loaders || [],
                        files: (v.files || []).map(f => ({
                            filename: f.filename,
                            url: f.url,
                            size: f.size || 0,
                            primary: !!f.primary
                        })),
                        datePublished: v.date_published,
                        changelog: v.changelog || ''
                    }));
                    sendJSON({ versions });
                } catch (e) {
                    sendJSON({ versions: [] });
                }
                break;
            }

            case '/api/mods/install-from-file': {
                const mifData = await readBody();
                const { versionId, filePath: mifFilePath } = mifData;
                if (!versionId || !mifFilePath) { sendError('Missing params', 400); break; }
                try {
                    const modsDir = getVersionSubDir(versionId, 'mods');
                    if (!modsDir) { sendError('无法确定模组目录'); break; }
                    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
                    const destPath = path.join(modsDir, path.basename(mifFilePath));
                    fs.copyFileSync(mifFilePath, destPath);
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/mods/remove': {
                const body7 = await readBody();
                const { versionId: rmVerId, fileName: rmFile } = body7;
                if (!rmVerId || !rmFile) { sendError('Missing params', 400); break; }
                if (rmFile.includes('..') || rmFile.includes('/') || rmFile.includes('\\')) { sendError('Invalid fileName', 400); break; }
                try {
                    const modsDir = getVersionModsDir(rmVerId);
                    if (!modsDir) { sendError('无法确定模组目录', 400); break; }
                    const rmFilePath = path.resolve(path.join(modsDir, rmFile));
                    if (!rmFilePath.startsWith(path.resolve(modsDir))) { sendError('Invalid path', 400); break; }
                    if (fs.existsSync(rmFilePath)) { fs.unlinkSync(rmFilePath); }
                    sendJSON({ success: true });
                } catch (e) { sendJSON({ success: false, error: e.message }); }
                break;
            }

            case '/api/version/export-info': {
                const eiVersionId = parsedUrl.query.versionId;
                if (!eiVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const cleanEiId = eiVersionId.replace(' [外部]', '');
                    const eiDir = getVersionGameDir(eiVersionId) || path.join(VERSIONS_DIR, cleanEiId);

                    const resourcePacks = [];
                    const rpDir = path.join(eiDir, 'resourcepacks');
                    if (fs.existsSync(rpDir)) {
                        resourcePacks.push(...fs.readdirSync(rpDir).filter(f => f.endsWith('.zip')).sort());
                    }

                    let modCount = 0;
                    const modDir = path.join(eiDir, 'mods');
                    if (fs.existsSync(modDir)) {
                        modCount = fs.readdirSync(modDir).filter(f => f.endsWith('.jar') || f.endsWith('.zip')).length;
                    }

                    let savesCount = 0;
                    const saves = [];
                    const savesDir = path.join(eiDir, 'saves');
                    if (fs.existsSync(savesDir)) {
                        const saveDirs = fs.readdirSync(savesDir).filter(d => {
                            const sd = path.join(savesDir, d);
                            return fs.statSync(sd).isDirectory() && fs.existsSync(path.join(sd, 'level.dat'));
                        });
                        savesCount = saveDirs.length;
                        saves.push(...saveDirs.sort().slice(0, 20));
                    }

                    let gameDesc = cleanEiId;
                    const jsonPath = path.join(eiDir, cleanEiId + '.json');
                    if (fs.existsSync(jsonPath)) {
                        try {
                            const vj = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                            if (vj.inheritsFrom) gameDesc = vj.inheritsFrom;
                            if (vj.libraries) {
                                for (const lib of vj.libraries) {
                                    if (lib.name && lib.name.startsWith('net.fabricmc')) {
                                        const parts = lib.name.split(':');
                                        if (parts.length >= 3) gameDesc += ` + Fabric ${parts[2]}`;
                                        break;
                                    }
                                    if (lib.name && lib.name.startsWith('net.neoforged')) {
                                        const parts = lib.name.split(':');
                                        if (parts.length >= 3) gameDesc += ` + NeoForge ${parts[2]}`;
                                        break;
                                    }
                                    if (lib.name && lib.name.startsWith('net.minecraftforge')) {
                                        const parts = lib.name.split(':');
                                        if (parts.length >= 3) gameDesc += ` + Forge ${parts[2]}`;
                                        break;
                                    }
                                }
                            }
                        } catch (e) {}
                    }

                    sendJSON({
                        gameDesc,
                        resourcePacks,
                        modCount,
                        savesCount,
                        saves
                    });
                } catch (e) { sendJSON({ gameDesc: '', resourcePacks: [], modCount: 0, savesCount: 0, saves: [] }); }
                break;
            }

            case '/api/modpack/import': {
                const importData = await readBody();
                const importFilePath = importData.filePath;
                const targetVersion = importData.targetVersion || '';
                if (!importFilePath) { sendError('Missing filePath', 400); break; }
                try {
                    const result = await importModpackFromPath(importFilePath, null, targetVersion);
                    sendJSON(result);
                } catch (e) {
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/version/export-modpack': {
                const body8 = await readBody();
                const { versionId: emId, name: emName, version: emVer, author: emAuthor, description: emDesc, selectedKeys } = body8;
                if (!emId || !emName) { sendError('Missing params', 400); break; }
                try {
                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip();

                    const exportDir = path.join(APP_DATA_PATH, 'exports');
                    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

                    const cleanEmId = emId.replace(' [外部]', '');
                    const srcDir = getVersionGameDir(emId) || path.join(VERSIONS_DIR, cleanEmId);

                    if (!fs.existsSync(srcDir)) {
                        sendJSON({ success: false, error: '版本目录不存在: ' + srcDir });
                        break;
                    }

                    const modrinthIndex = {
                        formatVersion: 1,
                        game: 'minecraft',
                        versionId: emVer || '1.0.0',
                        name: emName,
                        summary: emDesc || '',
                        files: [],
                        dependencies: { minecraft: cleanEmId }
                    };

                    const versionJsonPath = path.join(srcDir, cleanEmId + '.json');
                    if (fs.existsSync(versionJsonPath)) {
                        try {
                            const vj = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
                            if (vj.inheritsFrom) modrinthIndex.dependencies.minecraft = vj.inheritsFrom;
                            if (vj.libraries) {
                                for (const lib of vj.libraries) {
                                    if (lib.name) {
                                        const parts = lib.name.split(':');
                                        if (parts.length >= 3) {
                                            const loaderId = parts[1];
                                            if (loaderId === 'fabric' || loaderId === 'fabric-loader') {
                                                modrinthIndex.dependencies['fabric-loader'] = parts[2];
                                                break;
                                            } else if (loaderId === 'quilt-loader') {
                                                modrinthIndex.dependencies['quilt-loader'] = parts[2];
                                                break;
                                            } else if (loaderId === 'forge' || loaderId === 'fmlloader') {
                                                modrinthIndex.dependencies.forge = parts[2];
                                                break;
                                            } else if (loaderId === 'neoforge') {
                                                modrinthIndex.dependencies.neoforge = parts[2];
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.error('[Export] Failed to parse version json:', e);
                        }
                    }

                    console.log('[Export] Dependencies:', JSON.stringify(modrinthIndex.dependencies));

                    const addFileToZip = (filePath, zipPath) => {
                        if (fs.existsSync(filePath)) {
                            zip.addLocalFile(filePath, zipPath);
                        }
                    };

                    const addDirToZip = (dirPath, zipPath) => {
                        if (fs.existsSync(dirPath)) {
                            zip.addLocalFolder(dirPath, zipPath);
                        }
                    };

                    if (selectedKeys && selectedKeys.length > 0) {
                        if (selectedKeys.includes('game')) {
                            if (selectedKeys.includes('game_settings')) {
                                addFileToZip(path.join(srcDir, 'options.txt'), 'overrides');
                            }
                            if (selectedKeys.includes('servers')) {
                                addFileToZip(path.join(srcDir, 'servers.dat'), 'overrides');
                            }
                        }

                        if (selectedKeys.includes('mod_files')) {
                            const modsDir = path.join(srcDir, 'mods');
                            if (fs.existsSync(modsDir)) {
                                const modFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.zip') || f.endsWith('.jar.disabled'));
                                modFiles.forEach(f => {
                                    addFileToZip(path.join(modsDir, f), 'overrides/mods');
                                });
                            }
                        }

                        if (selectedKeys.includes('mod_configs')) {
                            addDirToZip(path.join(srcDir, 'config'), 'overrides/config');
                        }

                        if (selectedKeys.includes('resourcepacks')) {
                            addDirToZip(path.join(srcDir, 'resourcepacks'), 'overrides/resourcepacks');
                        }

                        if (selectedKeys.includes('shaderpacks')) {
                            addDirToZip(path.join(srcDir, 'shaderpacks'), 'overrides/shaderpacks');
                        }

                        if (selectedKeys.includes('saves')) {
                            addDirToZip(path.join(srcDir, 'saves'), 'overrides/saves');
                        }

                        if (selectedKeys.includes('screenshots')) {
                            addDirToZip(path.join(srcDir, 'screenshots'), 'overrides/screenshots');
                        }

                        if (selectedKeys.includes('defaultconfigs')) {
                            addDirToZip(path.join(srcDir, 'defaultconfigs'), 'overrides/defaultconfigs');
                        }

                        if (selectedKeys.includes('kubejs')) {
                            addDirToZip(path.join(srcDir, 'kubejs'), 'overrides/kubejs');
                        }

                        if (selectedKeys.includes('journeymap')) {
                            addDirToZip(path.join(srcDir, 'journeymap'), 'overrides/journeymap');
                        }

                        if (selectedKeys.includes('waystones')) {
                            addDirToZip(path.join(srcDir, 'waystones'), 'overrides/waystones');
                        }
                    }

                    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(modrinthIndex, null, 2)));

                    const zipPath = path.join(exportDir, `${emName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_')}.mrpack`);
                    zip.writeZip(zipPath);

                    console.log('[Export] Export completed:', zipPath);
                    sendJSON({ success: true, path: zipPath });
                } catch (e) {
                    console.error('[Export] Error:', e);
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/fs/browse': {
                await new Promise(r => setImmediate(r));
                const browsePath = parsedUrl.query.path || '';
                const browseType = parsedUrl.query.type || 'dir';
                const browsePattern = parsedUrl.query.pattern || '';

                if (!browsePath) {
                    const settings = loadSettingsCached();
                    const homeDir = os.homedir();
                    const defaultPaths = [
                        { name: 'VersePC 数据目录', path: DATA_DIR, type: 'app' },
                        { name: '用户主目录', path: homeDir, type: 'home' },
                    ];
                    if (settings.selectedVersion) {
                        const vDir = getVersionSubDir(settings.selectedVersion, '') || path.join(VERSIONS_DIR, settings.selectedVersion);
                        if (fs.existsSync(vDir)) {
                            defaultPaths.push({ name: `版本: ${settings.selectedVersion}`, path: vDir, type: 'version' });
                            const modsDir = path.join(vDir, 'mods');
                            if (fs.existsSync(modsDir)) {
                                defaultPaths.push({ name: '模组目录', path: modsDir, type: 'mods' });
                            }
                            const savesDir = path.join(vDir, 'saves');
                            if (fs.existsSync(savesDir)) {
                                defaultPaths.push({ name: '存档目录', path: savesDir, type: 'saves' });
                            }
                            const rpDir = path.join(vDir, 'resourcepacks');
                            if (fs.existsSync(rpDir)) {
                                defaultPaths.push({ name: '资源包目录', path: rpDir, type: 'resourcepacks' });
                            }
                        }
                    }
                    sendJSON({ success: true, quickAccess: defaultPaths });
                    break;
                }

                try {
                    const resolvedPath = path.resolve(browsePath);
                    const lowerPath = resolvedPath.toLowerCase();
                    const allowedPrefixes = [
                        DATA_DIR.toLowerCase(),
                        path.join(os.homedir(), '.minecraft').toLowerCase(),
                        os.homedir().toLowerCase(),
                        path.join(os.homedir(), 'Desktop').toLowerCase(),
                        path.join(os.homedir(), 'Documents').toLowerCase(),
                        path.join(os.homedir(), 'Downloads').toLowerCase()
                    ];
                    let allowed = false;
                    for (const prefix of allowedPrefixes) {
                        if (lowerPath.startsWith(prefix) || lowerPath === prefix) {
                            allowed = true;
                            break;
                        }
                    }
                    if (!allowed) {
                        sendJSON({ success: false, error: '无权访问该路径，仅限 VersePC 数据目录、.minecraft 目录和用户主目录' });
                        break;
                    }

                    if (!fs.existsSync(resolvedPath)) {
                        sendJSON({ success: false, error: '路径不存在' });
                        break;
                    }

                    const stat = await fs.promises.stat(resolvedPath);
                    if (!stat.isDirectory()) {
                        sendJSON({ success: false, error: '路径不是目录' });
                        break;
                    }

                    const MAX_ENTRIES = 300;
                    const entries = await fs.promises.readdir(resolvedPath);
                    const filtered = entries.filter(e => {
                        if (!e.startsWith('.') || e === '.minecraft') return true;
                        return false;
                    }).slice(0, MAX_ENTRIES);

                    const items = [];
                    for (let i = 0; i < filtered.length; i++) {
                        const entry = filtered[i];
                        const fullPath = path.join(resolvedPath, entry);
                        try {
                            const entryStat = await fs.promises.stat(fullPath);
                            const isDir = entryStat.isDirectory();
                            if (browseType === 'dir' && !isDir) continue;
                            if (browsePattern) {
                                const regex = new RegExp(browsePattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
                                if (!regex.test(entry)) continue;
                            }
                            items.push({
                                name: entry,
                                path: fullPath,
                                isDirectory: isDir,
                                size: isDir ? 0 : entryStat.size,
                                modified: entryStat.mtimeMs
                            });
                        } catch (e) {}

                        if (i % 50 === 49) {
                            await new Promise(r => setImmediate(r));
                        }
                    }

                    items.sort((a, b) => {
                        if (a.isDirectory !== b.isDirectory) return b.isDirectory ? 1 : -1;
                        return a.name.localeCompare(b.name);
                    });

                    sendJSON({
                        success: true,
                        path: resolvedPath,
                        parent: path.dirname(resolvedPath),
                        items,
                        total: items.length
                    });
                } catch (e) {
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/game/status': {
                const instances = [...gameInstances.values()].map(inst => ({
                    sessionId: inst.sessionId,
                    versionId: inst.versionId,
                    pid: inst.pid,
                    lanPort: inst.lanPort,
                    startTime: inst.startTime,
                    gameReady: inst.gameReady || false,
                    readyTime: inst.readyTime || null,
                    launchDuration: inst.readyTime ? (inst.readyTime - inst.startTime) : null,
                    running: true,
                }));
                sendJSON({
                    running: gameInstances.size > 0,
                    instances,
                    lanPort: detectedLanPort
                });
                break;
            }

            case '/api/game/stop': {
                const stopData = parsedUrl.query.sessionId ? { sessionId: parsedUrl.query.sessionId } : (req.method === 'POST' ? await readBody().catch(() => ({})) : {});
                if (stopData.sessionId) {
                    const inst = gameInstances.get(stopData.sessionId);
                    if (inst) {
                        try { inst.process.kill(); } catch (e) {}
                        gameInstances.delete(stopData.sessionId);
                        sendJSON({ success: true, message: '游戏实例已停止', sessionId: stopData.sessionId });
                    } else {
                        sendJSON({ success: false, error: '找不到该游戏实例' });
                    }
                } else if (gameInstances.size > 0) {
                    for (const [sid, inst] of gameInstances) {
                        try { inst.process.kill(); } catch (e) {}
                    }
                    gameInstances.clear();
                    sendJSON({ success: true, message: '所有游戏实例已停止' });
                } else {
                    sendJSON({ success: false, error: '游戏未在运行' });
                }
                break;
            }

            case '/api/game/log': {
                const logSessionId = parsedUrl.query.sessionId;
                const count = parseInt(parsedUrl.query.count || '100', 10);
                const offset = parseInt(parsedUrl.query.offset || '0', 10);
                if (logSessionId) {
                    const inst = gameInstances.get(logSessionId);
                    if (inst) {
                        sendJSON({
                            lines: inst.logBuffer.slice(-(count + offset)).slice(0, count),
                            total: inst.logBuffer.length,
                            sessionId: logSessionId
                        });
                    } else {
                        sendJSON({
                            lines: gameLogBuffer.filter(l => l.includes(logSessionId)).slice(-(count + offset)).slice(0, count),
                            total: gameLogBuffer.length,
                            sessionId: logSessionId
                        });
                    }
                } else {
                    sendJSON({
                        lines: gameLogBuffer.slice(-(count + offset)).slice(0, count),
                        total: gameLogBuffer.length
                    });
                }
                break;
            }

            case '/api/game/log/stream': {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                let lastLen = 0;
                const interval = setInterval(() => {
                    if (gameLogBuffer.length > lastLen) {
                        const newLines = gameLogBuffer.slice(lastLen);
                        newLines.forEach(line => {
                            res.write(`data: ${JSON.stringify({ line })}\n\n`);
                        });
                        lastLen = gameLogBuffer.length;
                    }
                    if (gameInstances.size === 0 && lastLen > 0) {
                        res.write(`data: ${JSON.stringify({ event: 'exited' })}\n\n`);
                    }
                }, 500);
                req.on('close', () => clearInterval(interval));
                break;
            }

            case '/api/crash/analyze': {
                if (req.method === 'POST') {
                    const data = await readBody();
                    const { CrashAnalyzer } = require('./crashAnalyzer');
                    
                    try {
                        const mcDir = data.minecraftDir || MINECRAFT_DIR;
                        const analyzer = new CrashAnalyzer(null, mcDir);
                        
                        if (data.filePath) {
                            await analyzer.importFile(data.filePath);
                        } else {
                            await analyzer.collect(data.versionPath || '', data.latestLog);
                        }
                        
                        if (analyzer.analyzeRawFiles.length === 0) {
                            sendJSON({
                                success: false,
                                error: '未找到任何日志文件。请确认 Minecraft 目录下存在 crash-reports 或 logs 文件夹，或手动导入日志文件。'
                            });
                            break;
                        }
                        
                        const prepared = analyzer.prepare();
                        if (!prepared) {
                            sendJSON({
                                success: false,
                                error: '未能从日志文件中提取有效信息。请确认日志文件内容完整。'
                            });
                            break;
                        }
                        
                        analyzer.analyze();
                        const result = await analyzer.output(false);
                        
                        sendJSON({
                            success: true,
                            result
                        });
                    } catch (e) {
                        console.error('[Crash] 分析崩溃失败:', e);
                        sendJSON({
                            success: false,
                            error: '分析崩溃失败: ' + e.message
                        });
                    }
                } else {
                    sendError('Method not allowed', 405);
                }
                break;
            }

            case '/api/crash/logs': {
                try {
                    const mcDir = parsedUrl.query.minecraftDir || MINECRAFT_DIR;
                    const crashLogs = [];
                    
                    const crashReportsDir = path.join(mcDir, 'crash-reports');
                    if (fs.existsSync(crashReportsDir)) {
                        const files = fs.readdirSync(crashReportsDir)
                            .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                            .map(f => ({
                                name: f,
                                path: path.join(crashReportsDir, f),
                                time: fs.statSync(path.join(crashReportsDir, f)).mtime.getTime()
                            }))
                            .sort((a, b) => b.time - a.time);
                        crashLogs.push(...files);
                    }
                    
                    const logsDir = path.join(mcDir, 'logs');
                    if (fs.existsSync(logsDir)) {
                        const logFiles = ['latest.log', 'debug.log'];
                        for (const logFile of logFiles) {
                            const logPath = path.join(logsDir, logFile);
                            if (fs.existsSync(logPath)) {
                                crashLogs.push({
                                    name: logFile,
                                    path: logPath,
                                    time: fs.statSync(logPath).mtime.getTime()
                                });
                            }
                        }
                    }
                    
                    try {
                        const mcFiles = fs.readdirSync(mcDir);
                        for (const file of mcFiles) {
                            if (file.startsWith('hs_err_pid') && file.endsWith('.log')) {
                                crashLogs.push({
                                    name: file,
                                    path: path.join(mcDir, file),
                                    time: fs.statSync(path.join(mcDir, file)).mtime.getTime()
                                });
                            }
                        }
                    } catch (ex) {}
                    
                    const versionPath = parsedUrl.query.version;
                    if (versionPath) {
                        const versionDir = path.join(mcDir, 'versions', versionPath);
                        if (fs.existsSync(versionDir)) {
                            const versionLogs = fs.readdirSync(versionDir)
                                .filter(f => f.endsWith('.log'))
                                .map(f => ({
                                    name: f,
                                    path: path.join(versionDir, f),
                                    time: fs.statSync(path.join(versionDir, f)).mtime.getTime()
                                }));
                            crashLogs.push(...versionLogs);
                        }
                    }
                    
                    sendJSON({
                        success: true,
                        logs: crashLogs.sort((a, b) => b.time - a.time)
                    });
                } catch (e) {
                    console.error('[Crash] 获取崩溃日志列表失败:', e);
                    sendJSON({
                        success: false,
                        error: '获取崩溃日志列表失败: ' + e.message,
                        logs: []
                    });
                }
                break;
            }

            case '/api/crash/log-content': {
                const logPath = parsedUrl.query.path;
                if (!logPath) {
                    sendError('Missing path parameter', 400);
                    break;
                }

                const resolvedLogPath = path.resolve(logPath);
                const allowedLogBases = [DATA_DIR, path.join(os.homedir(), '.minecraft'), ...Object.values(VERSIONS_DIR)].map(d => path.resolve(d));
                const isLogPathAllowed = allowedLogBases.some(base => resolvedLogPath.toLowerCase().startsWith(base.toLowerCase()));
                if (!isLogPathAllowed) {
                    sendError('Forbidden', 403);
                    break;
                }

                try {
                    if (!fs.existsSync(logPath)) {
                        sendError('Log file not found', 404);
                        break;
                    }
                    
                    const content = fs.readFileSync(logPath, 'utf8');
                    const stat = fs.statSync(logPath);
                    
                    sendJSON({
                        success: true,
                        content,
                        size: stat.size,
                        modified: stat.mtime
                    });
                } catch (e) {
                    console.error('[Crash] 读取日志文件失败:', e);
                    sendError('读取日志文件失败: ' + e.message);
                }
                break;
            }

            case '/api/crash/export': {
                if (req.method === 'POST') {
                    const data = await readBody();
                    const { files, analysis } = data;
                    
                    try {
                        const exportDir = path.join(MINECRAFT_DIR, 'crash-exports');
                        if (!fs.existsSync(exportDir)) {
                            fs.mkdirSync(exportDir, { recursive: true });
                        }
                        
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const exportFile = path.join(exportDir, `crash-report-${timestamp}.txt`);
                        
                        let exportContent = '=== VersePC 崩溃报告 ===\n';
                        exportContent += `导出时间: ${new Date().toLocaleString()}\n\n`;
                        
                        if (analysis) {
                            exportContent += '=== 崩溃分析结果 ===\n';
                            exportContent += analysis + '\n\n';
                        }
                        
                        if (files && files.length > 0) {
                            const allowedExportBases = [DATA_DIR, ...Object.values(VERSIONS_DIR)].map(d => path.resolve(d));
                            exportContent += '=== 相关日志文件 ===\n';
                            for (const file of files) {
                                const resolvedFile = path.resolve(file);
                                if (!allowedExportBases.some(base => resolvedFile.toLowerCase().startsWith(base.toLowerCase()))) continue;
                                if (fs.existsSync(file)) {
                                    exportContent += `\n--- ${path.basename(file)} ---\n`;
                                    exportContent += fs.readFileSync(file, 'utf8') + '\n';
                                }
                            }
                        }
                        
                        fs.writeFileSync(exportFile, exportContent, 'utf8');
                        
                        sendJSON({
                            success: true,
                            path: exportFile
                        });
                    } catch (e) {
                        console.error('[Crash] 导出崩溃报告失败:', e);
                        sendError('导出崩溃报告失败: ' + e.message);
                    }
                } else {
                    sendError('Method not allowed', 405);
                }
                break;
            }

            case '/api/settings': {
                if (req.method === 'POST') {
                    const data = await readBody();
                    const current = loadSettingsCached();
                    const updated = { ...current, ...data };
                    console.log(`[设置] 保存设置: maxThreads=${updated.maxThreads}`);
                    saveSettings(updated);
                    sendJSON({ success: true, settings: updated });
                } else {
                    sendJSON(loadSettingsCached());
                }
                break;
            }

            case '/api/settings/set': {
                if (req.method === 'POST') {
                    const data = await readBody();
                    const current = loadSettingsCached();
                    current[data.key] = data.value;
                    saveSettings(current);
                    sendJSON({ success: true });
                } else {
                    sendError('Method not allowed', 405);
                }
                break;
            }

            case '/api/settings/reset': {
                if (req.method === 'POST') {
                    try {
                        const defaults = {
                            javaPath: '',
                            maxMemory: 4096,
                            minMemory: 1024,
                            gameDir: DATA_DIR,
                            versionIsolation: true,
                            javaArgs: '',
                            fullscreen: false,
                            resolution: '1920x1080',
                            autoUpdate: true,
                            closeOnLaunch: false,
                            selectedVersion: '',
                            selectedAccount: '',
                            downloadSource: 'auto',
                            versionSource: 'auto',
                            maxThreads: 32,
                            enableChunkDownload: true,
                            maxChunksPerFile: 8,
                            speedLimit: 0,
                            targetDir: '',
                            sslVerify: false,
                            modSource: 'modrinth',
                            filenameFormat: 'default',
                            modStyle: 'title',
                            ignoreQuilt: false,
                            accentColor: '#4a9eff',
                            blurBg: true,
                            backgroundImage: '',
                            avatarImage: '',
                            autoSetChinese: true
                        };
                        saveSettings(defaults);
                        console.log('[设置] 已重置为默认值');
                        sendJSON({ success: true, settings: defaults });
                    } catch (e) {
                        console.error('[设置] 重置失败:', e);
                        sendJSON({ success: false, error: e.message });
                    }
                } else {
                    sendError('Method not allowed', 405);
                }
                break;
            }

            case '/api/accounts': {
                sendJSON(loadAccounts());
                break;
            }

            case '/api/accounts/add-offline': {
                const data = await readBody();
                const username = (data.username || '').trim();
                if (!username) { sendError('请输入用户名', 400); break; }
                if (username.length < 3 || username.length > 16) { sendError('用户名长度需为 3 - 16 位', 400); break; }
                if (!/^[A-Za-z0-9_]+$/.test(username)) { sendError('用户名只能包含英文字母、数字与下划线', 400); break; }
                const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
                md5[6] = (md5[6] & 0x0f) | 0x30;
                md5[8] = (md5[8] & 0x3f) | 0x80;
                const uuid = md5.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
                const accounts = loadAccounts();
                const newAccount = {
                    id: crypto.randomUUID(),
                    username: username,
                    uuid: uuid,
                    type: 'offline',
                    accessToken: '0',
                    createdAt: new Date().toISOString()
                };
                accounts.push(newAccount);
                saveAccounts(accounts);
                sendJSON({ success: true, account: newAccount });
                break;
            }

            case '/api/accounts/delete': {
                const data = await readBody();
                const accountId = data.accountId;
                if (!accountId) { sendError('Missing accountId', 400); break; }
                let accounts = loadAccounts();
                accounts = accounts.filter(a => a.id !== accountId);
                saveAccounts(accounts);
                sendJSON({ success: true });
                break;
            }

            case '/api/accounts/select': {
                const data = await readBody();
                const accountId = data.accountId;
                const settings = loadSettingsCached();
                settings.selectedAccount = accountId;
                saveSettings(settings);
                sendJSON({ success: true });
                break;
            }

            case '/api/msauth/device-code': {
                try {
                    const deviceCodeUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`;
                    const postData = `client_id=${MS_CLIENT_ID}&scope=XboxLive.signin+offline_access`;
                    const result = await new Promise((resolve, reject) => {
                        const req = https.request(deviceCodeUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Content-Length': Buffer.byteLength(postData)
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(e); }
                            });
                        });
                        req.on('error', reject);
                        req.write(postData);
                        req.end();
                    });
                    sendJSON({
                        success: true,
                        deviceCode: result.device_code,
                        userCode: result.user_code,
                        verificationUri: result.verification_uri || 'https://www.microsoft.com/link',
                        verificationUriComplete: result.verification_uri_complete || null,
                        expiresIn: result.expires_in,
                        interval: result.interval || 5,
                        message: result.message
                    });
                } catch (e) {
                    sendError('获取设备码失败 ' + e.message);
                }
                break;
            }

            case '/api/msauth/poll': {
                const data = await readBody();
                const deviceCode = data.deviceCode;
                if (!deviceCode) { sendError('Missing deviceCode', 400); break; }

                try {
                    const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                    const postData = `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=${MS_CLIENT_ID}&device_code=${deviceCode}`;

                    const msTokenResult = await new Promise((resolve, reject) => {
                        const req = https.request(tokenUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Content-Length': Buffer.byteLength(postData)
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(e); }
                            });
                        });
                        req.on('error', reject);
                        req.write(postData);
                        req.end();
                    });

                    if (msTokenResult.error) {
                        sendJSON({ success: false, pending: msTokenResult.error === 'authorization_pending', error: msTokenResult.error_description || msTokenResult.error });
                        break;
                    }

                    const msAccessToken = msTokenResult.access_token;
                    const msRefreshToken = msTokenResult.refresh_token;

                    const xblResult = await fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                        RelyingParty: 'http://auth.xboxlive.com',
                        TokenType: 'JWT'
                    }), { 'Content-Type': 'application/json' });

                    const xblToken = xblResult.Token;
                    const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';

                    const xstsResult = await fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                        RelyingParty: 'rp://api.minecraftservices.com/',
                        TokenType: 'JWT'
                    }), { 'Content-Type': 'application/json' });

                    if (xstsResult.XErr) {
                        const xerr = xstsResult.XErr;
                        const xerrMessages = {
                            2148916233: '该微软账号没有关联Xbox账号，请先在 xbox.com 创建',
                            2148916234: '该Xbox账号所在地区不可用',
                            2148916235: 'Xbox Live服务暂时不可用，请稍后重试',
                            2148916236: '该Xbox账号需要成人验证',
                            2148916237: '该Xbox账号是被封禁的',
                            2148916238: '该微软账号是儿童账号，需要成人账号关联'
                        };
                        const xerrMsg = xerrMessages[xerr] || `Xbox认证失败 (错误码: ${xerr})`;
                        sendJSON({ success: false, error: xerrMsg, xerr });
                        break;
                    }

                    const xstsToken = xstsResult.Token;
                    const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;

                    const mcResult = await fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                        identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                    }), { 'Content-Type': 'application/json' });

                    const mcAccessToken = mcResult.access_token;
                    if (!mcAccessToken) {
                        sendJSON({ success: false, error: 'Minecraft服务认证失败，未获取到访问令牌' });
                        break;
                    }

                    try {
                        const entitlements = await fetchJSONWithAuth('https://api.minecraftservices.com/entitlements/mcstore', mcAccessToken);
                        if (entitlements && Array.isArray(entitlements.items)) {
                            const hasGame = entitlements.items.some(item =>
                                item.name === 'product_minecraft' || item.name === 'game_minecraft'
                            );
                            if (!hasGame) {
                                sendJSON({ success: false, error: '该账号未购买Minecraft，请先购买游戏', needPurchase: true });
                                break;
                            }
                        }
                    } catch (entErr) {
                        console.warn('[MSAuth] 游戏所有权验证跳过:', entErr.message);
                    }

                    let profileResult;
                    try {
                        profileResult = await fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcAccessToken);
                    } catch (profileErr) {
                        if (profileErr.message && profileErr.message.includes('404')) {
                            sendJSON({ success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                            break;
                        }
                        throw profileErr;
                    }
                    if (!profileResult || !profileResult.id) {
                        sendJSON({ success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                        break;
                    }

                    const accounts = loadAccounts();
                    const now = new Date();
                    const newAccount = {
                        id: crypto.randomUUID(),
                        username: profileResult.name,
                        uuid: profileResult.id,
                        type: 'microsoft',
                        accessToken: mcAccessToken,
                        refreshToken: msRefreshToken,
                        tokenExpiresAt: now.getTime() + (msTokenResult.expires_in || 3600) * 1000,
                        lastRefreshed: now.toISOString(),
                        createdAt: new Date().toISOString()
                    };

                    const existingIdx = accounts.findIndex(a => a.uuid === newAccount.uuid);
                    if (existingIdx >= 0) {
                        newAccount.createdAt = accounts[existingIdx].createdAt || newAccount.createdAt;
                        accounts[existingIdx] = { ...accounts[existingIdx], ...newAccount };
                    } else {
                        accounts.push(newAccount);
                    }
                    saveAccounts(accounts);

                    const settings = loadSettingsCached();
                    settings.selectedAccount = newAccount.id;
                    saveSettings(settings);

                    sendJSON({ success: true, account: newAccount });
                } catch (e) {
                    if (e.isRateLimit) {
                        sendJSON({ success: false, error: e.message, isRateLimit: true, retryAfter: e.retryAfter });
                    } else {
                        sendError('微软登录失败: ' + e.message);
                    }
                }
                break;
            }

            case '/api/msauth/refresh': {
                const data = await readBody();
                const accountId = data.accountId;
                if (!accountId) { sendError('Missing accountId', 400); break; }

                const accounts = loadAccounts();
                const account = accounts.find(a => a.id === accountId);
                if (!account) { sendError('账号不存在', 404); break; }
                if (account.type !== 'microsoft') { sendError('仅支持刷新微软账号', 400); break; }
                if (!account.refreshToken) { sendJSON({ success: false, error: '无刷新令牌，请重新登录' }); break; }

                try {
                    const tokenUrl = `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`;
                    const postData = `grant_type=refresh_token&client_id=${MS_CLIENT_ID}&refresh_token=${encodeURIComponent(account.refreshToken)}&scope=XboxLive.signin+offline_access`;

                    const msTokenResult = await new Promise((resolve, reject) => {
                        const req = https.request(tokenUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Content-Length': Buffer.byteLength(postData)
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(e); }
                            });
                        });
                        req.on('error', reject);
                        req.write(postData);
                        req.end();
                    });

                    if (msTokenResult.error) {
                        const isExpired = msTokenResult.error === 'invalid_grant' || msTokenResult.error === 'expired_token';
                        sendJSON({
                            success: false,
                            error: isExpired ? '登录已过期，请重新登录' : `令牌刷新失败: ${msTokenResult.error_description || msTokenResult.error}`,
                            needRelogin: isExpired
                        });
                        break;
                    }

                    const msAccessToken = msTokenResult.access_token;
                    const msRefreshTokenNew = msTokenResult.refresh_token || account.refreshToken;

                    const xblResult = await fetchJSONWithMethod('https://user.auth.xboxlive.com/user/authenticate', 'POST', JSON.stringify({
                        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
                        RelyingParty: 'http://auth.xboxlive.com',
                        TokenType: 'JWT'
                    }), { 'Content-Type': 'application/json' });

                    const xblToken = xblResult.Token;
                    const xblUhs = xblResult.DisplayClaims?.xui?.[0]?.uhs || '';

                    const xstsResult = await fetchJSONWithMethod('https://xsts.auth.xboxlive.com/xsts/authorize', 'POST', JSON.stringify({
                        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
                        RelyingParty: 'rp://api.minecraftservices.com/',
                        TokenType: 'JWT'
                    }), { 'Content-Type': 'application/json' });

                    if (xstsResult.XErr) {
                        sendJSON({ success: false, error: `Xbox认证失败 (错误码: ${xstsResult.XErr})` });
                        break;
                    }

                    const xstsToken = xstsResult.Token;
                    const xstsUhs = xstsResult.DisplayClaims?.xui?.[0]?.uhs || xblUhs;

                    const mcResult = await fetchJSONWithMethod('https://api.minecraftservices.com/authentication/login_with_xbox', 'POST', JSON.stringify({
                        identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}`
                    }), { 'Content-Type': 'application/json' });

                    const mcAccessToken = mcResult.access_token;
                    if (!mcAccessToken) {
                        sendJSON({ success: false, error: 'Minecraft服务认证失败' });
                        break;
                    }

                    let profileResult;
                    try {
                        profileResult = await fetchJSONWithAuth('https://api.minecraftservices.com/minecraft/profile', mcAccessToken);
                    } catch (profileErr) {
                        if (profileErr.message && profileErr.message.includes('404')) {
                            sendJSON({ success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                            break;
                        }
                        throw profileErr;
                    }
                    if (!profileResult || !profileResult.id) {
                        sendJSON({ success: false, error: '未找到Minecraft档案，请先在 Minecraft.net 创建角色名', needCreateProfile: true });
                        break;
                    }

                    const now = new Date();
                    account.accessToken = mcAccessToken;
                    account.refreshToken = msRefreshTokenNew;
                    account.tokenExpiresAt = now.getTime() + (msTokenResult.expires_in || 3600) * 1000;
                    account.lastRefreshed = now.toISOString();
                    account.username = profileResult.name || account.username;
                    saveAccounts(accounts);

                    sendJSON({ success: true, account });
                } catch (e) {
                    if (e.isRateLimit) {
                        sendJSON({ success: false, error: e.message, isRateLimit: true, retryAfter: e.retryAfter });
                    } else {
                        sendError('令牌刷新失败: ' + e.message);
                    }
                }
                break;
            }

            case '/api/modpacks/search': {
                const mpQuery = parsedUrl.query.query || '';
                const mpLoader = parsedUrl.query.loader || '';
                const mpVersion = parsedUrl.query.version || '';
                const mpLimit = parseInt(parsedUrl.query.limit || '10', 10);
                const mpOffset = parseInt(parsedUrl.query.offset || '0', 10);
                try {
                    const facets = [['project_type:modpack']];
                    if (mpLoader) facets.push([`categories:${mpLoader}`]);
                    if (mpVersion) facets.push([`versions:${mpVersion}`]);
                    let mpSearchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(mpQuery)}&index=relevance&limit=${mpLimit}&offset=${mpOffset}`;
                    mpSearchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                    const mpResult = await cachedFetchJSON(mpSearchUrl, 60000);
                    const mpHits = (mpResult.hits || []).map(hit => ({
                        id: hit.project_id, slug: hit.slug, title: hit.title,
                        description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                        icon: hit.icon_url || '', downloads: hit.downloads || 0,
                        categories: hit.categories || [], versions: hit.versions || [],
                        source: 'modrinth'
                    }));
                    sendJSON({ hits: mpHits, total: mpResult.total_hits || mpHits.length, offset: mpOffset });
                } catch (e) {
                    sendJSON({ hits: [], total: 0, error: e.message });
                }
                break;
            }

            case '/api/modpacks/install': {
                const mpData = await readBody();
                const mpProjectId = mpData.projectId;
                const mpMcVersion = mpData.mcVersion || '';
                if (!mpProjectId) { sendError('Missing projectId', 400); break; }
                try {
                    let versionUrl = `${MODRINTH_API}/project/${mpProjectId}/version`;
                    const versionParams = [];
                    if (mpMcVersion) versionParams.push(`game_versions=["${mpMcVersion}"]`);
                    if (versionParams.length > 0) versionUrl += '?' + versionParams.join('&');
                    const versionData = await fetchJSON(versionUrl);
                    if (!versionData || versionData.length === 0) {
                        sendJSON({ success: false, error: '未找到可用版本' });
                        break;
                    }
                    const targetVersion = versionData[0];
                    const primaryFile = targetVersion.files?.find(f => f.primary) || targetVersion.files?.[0];
                    if (!primaryFile || !primaryFile.url) {
                        sendJSON({ success: false, error: '未找到下载链接' });
                        break;
                    }
                    const fileName = primaryFile.filename || `${mpProjectId}.mrpack`;
                    const downloadDir = path.join(DATA_DIR, 'modpacks');
                    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
                    const destPath = path.join(downloadDir, fileName);
                    const downloadUrl = primaryFile.url;
                    const modpackName = targetVersion.name || mpProjectId;

                    sendJSON({
                        success: true,
                        name: modpackName,
                        versionId: targetVersion.id,
                        fileName,
                        downloadUrl,
                        destPath,
                        size: primaryFile.size || 0,
                        mcVersion: targetVersion.game_versions?.[0] || mpMcVersion,
                        loaders: targetVersion.loaders || [],
                        message: '整合包下载链接已获取，请使用 modpack/import 接口导入'
                    });
                } catch (e) {
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/current-context': {
                await new Promise(r => setImmediate(r));
                try {
                    const ctxSettings = loadSettingsCached();
                    const ctxVersion = ctxSettings.selectedVersion || '';
                    let ctxVersionDir = '';
                    let ctxModsDir = '';
                    let ctxLoader = '';
                    let ctxLoaderVersion = '';
                    if (ctxVersion) {
                        ctxVersionDir = path.join(VERSIONS_DIR, ctxVersion);
                        ctxModsDir = getVersionModsDir(ctxVersion);
                        const forgeJson = path.join(ctxVersionDir, 'version.json');
                        const fabricJson = path.join(ctxVersionDir, 'fabric-loader.json');
                        const neoJson = path.join(ctxVersionDir, 'neoforge-loader.json');
                        if (await fs.promises.access(forgeJson).then(() => true).catch(() => false)) {
                            ctxLoader = 'forge';
                            try { const d = JSON.parse(await fs.promises.readFile(forgeJson, 'utf-8')); ctxLoaderVersion = d.id || ''; } catch (e) {}
                        } else if (await fs.promises.access(fabricJson).then(() => true).catch(() => false)) {
                            ctxLoader = 'fabric';
                            try { const d = JSON.parse(await fs.promises.readFile(fabricJson, 'utf-8')); ctxLoaderVersion = d.id || ''; } catch (e) {}
                        } else if (await fs.promises.access(neoJson).then(() => true).catch(() => false)) {
                            ctxLoader = 'neoforge';
                            try { const d = JSON.parse(await fs.promises.readFile(neoJson, 'utf-8')); ctxLoaderVersion = d.id || ''; } catch (e) {}
                        }
                    }
                    const ctxJavaPath = ctxSettings.javaPath || '';
                    const ctxMaxMemory = ctxSettings.maxMemory || '';
                    const ctxMinMemory = ctxSettings.minMemory || '';
                    const ctxJavaArgs = ctxSettings.javaArgs || '';
                    const ctxVersionIsolation = ctxSettings.versionIsolation !== false;
                    let ctxModsCount = 0;
                    let ctxModsEnabled = 0;
                    let ctxModsDisabled = 0;
                    if (ctxModsDir && await fs.promises.access(ctxModsDir).then(() => true).catch(() => false)) {
                        const jarFiles = (await fs.promises.readdir(ctxModsDir)).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
                        ctxModsCount = jarFiles.length;
                        ctxModsEnabled = jarFiles.filter(f => f.endsWith('.jar')).length;
                        ctxModsDisabled = jarFiles.filter(f => f.endsWith('.jar.disabled')).length;
                    }
                    sendJSON({
                        selectedVersion: ctxVersion,
                        versionDir: ctxVersionDir,
                        modsDir: ctxModsDir,
                        loader: ctxLoader,
                        loaderVersion: ctxLoaderVersion,
                        javaPath: ctxJavaPath,
                        maxMemory: ctxMaxMemory,
                        minMemory: ctxMinMemory,
                        javaArgs: ctxJavaArgs,
                        versionIsolation: ctxVersionIsolation,
                        modsCount: ctxModsCount,
                        modsEnabled: ctxModsEnabled,
                        modsDisabled: ctxModsDisabled
                    });
                } catch (e) {
                    sendError('Failed to load current context: ' + e.message, 500);
                }
                break;
            }

            case '/api/system/memory': {
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const totalMB = Math.floor(totalMem / 1024 / 1024);
                const freeMB = Math.floor(freeMem / 1024 / 1024);
                const usedMB = totalMB - freeMB;
                let autoMB;
                if (totalMB <= 2500) {
                    autoMB = 1024;
                } else if (totalMB <= 4500) {
                    autoMB = totalMB - 1500;
                } else if (totalMB <= 8500) {
                    autoMB = totalMB - 2048;
                } else {
                    autoMB = totalMB - 4096;
                }
                autoMB = Math.max(512, Math.min(autoMB, 32768));
                autoMB = Math.floor(autoMB / 256) * 256;
                sendJSON({
                    totalBytes: totalMem,
                    freeBytes: freeMem,
                    totalMB, freeMB, usedMB,
                    totalGB: Math.round(totalMem / 1024 / 1024 / 1024 * 10) / 10,
                    freeGB: Math.round(freeMem / 1024 / 1024 / 1024 * 10) / 10,
                    usedGB: Math.round(usedMB / 1024 * 10) / 10,
                    autoMB,
                    autoGB: Math.round(autoMB / 1024 * 10) / 10
                });
                break;
            }

            case '/api/jvm/preheat': {
                const preheatBody = await readBody();
                const preheatJavaPath = preheatBody.javaPath;
                const preheatMemMB = preheatBody.maxMemMB || 1024;
                if (preheatJavaPath && fs.existsSync(preheatJavaPath)) {
                    preheatJvm(preheatJavaPath, preheatMemMB);
                    sendJSON({ success: true });
                } else {
                    sendJSON({ success: false, error: 'Java path not found' });
                }
                break;
            }

            case '/api/jvm/generate-cds': {
                const cdsBody = await readBody();
                const cdsVersionId = cdsBody.versionId;
                if (!cdsVersionId) { sendJSON({ success: false, error: 'versionId required' }); break; }
                
                const cdsDir = path.join(DATA_DIR, 'cds');
                if (!fs.existsSync(cdsDir)) fs.mkdirSync(cdsDir, { recursive: true });
                
                const cdsArchive = path.join(cdsDir, `${cdsVersionId}.jsa`);
                const cdsClassList = path.join(cdsDir, `${cdsVersionId}.cls`);
                
                const cdsVersionJson = resolveVersionJson(cdsVersionId);
                if (!cdsVersionJson) { sendJSON({ success: false, error: 'Version not found' }); break; }
                
                const cdsSettings = loadSettingsCached();
                const cdsJavaPath = selectJavaForVersion(cdsVersionId, cdsSettings, cdsVersionJson) || 'java';
                if (!cdsJavaPath || !fs.existsSync(cdsJavaPath)) { sendJSON({ success: false, error: 'Java not found' }); break; }
                
                const cdsMajorVer = getJavaMajorVersion(cdsJavaPath);
                if (cdsMajorVer < 8) { sendJSON({ success: false, error: 'CDS requires Java 8+' }); break; }
                
                try {
                    console.log(`[CDS] 开始为 ${cdsVersionId} 生成类共享归档...`);
                    
                    const defaultJsa = path.join(path.dirname(path.dirname(cdsJavaPath)), 'lib', 'server', 'classes.jsa');
                    if (fs.existsSync(defaultJsa)) {
                        try {
                            fs.copyFileSync(defaultJsa, cdsArchive);
                            console.log(`[CDS] 已复制默认CDS归档: ${defaultJsa}`);
                            sendJSON({ success: true, archive: cdsArchive, source: 'default' });
                            break;
                        } catch(e) {}
                    }
                    
                    const dumpArgs = [cdsJavaPath, '-Xshare:dump', `-XX:SharedArchiveFile=${cdsArchive}`];
                    const dumpResult = execSync(dumpArgs.join(' '), { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
                    console.log(`[CDS] 默认归档生成完成`);
                    
                    if (fs.existsSync(cdsArchive) && fs.statSync(cdsArchive).size > 1024) {
                        sendJSON({ success: true, archive: cdsArchive, source: 'generated', sizeKB: Math.round(fs.statSync(cdsArchive).size / 1024) });
                    } else {
                        sendJSON({ success: false, error: 'Archive generation failed - file too small or missing' });
                    }
                } catch (e) {
                    const errMsg = e.stderr?.toString() || e.message;
                    console.error(`[CDS] 归档生成失败: ${errMsg}`);
                    if (fs.existsSync(cdsArchive) && fs.statSync(cdsArchive).size > 1024) {
                        sendJSON({ success: true, archive: cdsArchive, source: 'partial', warning: errMsg.substring(0, 200) });
                    } else {
                        sendJSON({ success: false, error: errMsg.substring(0, 300) });
                    }
                }
                break;
            }

            case '/api/jvm/cds-status': {
                const statusVersionId = url.query.versionId;
                if (!statusVersionId) { sendJSON({ available: false }); break; }
                const statusArchive = path.join(DATA_DIR, 'cds', `${statusVersionId}.jsa`);
                if (fs.existsSync(statusArchive)) {
                    const stat = fs.statSync(statusArchive);
                    sendJSON({ available: true, archive: statusArchive, sizeKB: Math.round(stat.size / 1024), modified: stat.mtimeMs });
                } else {
                    sendJSON({ available: false });
                }
                break;
            }

            case '/api/java/detect': {
                try {
                    const systemJava = detectSystemJava();
                    const bundledJava = detectBundledJava();
                    const allJava = [...bundledJava, ...systemJava];
                    sendJSON({
                        success: true,
                        platform: getPlatformKey(),
                        javaList: allJava,
                        hasJava: allJava.length > 0,
                        hasJava17: allJava.some(j => j.majorVersion >= 17),
                        hasJava21: allJava.some(j => j.majorVersion >= 21)
                    });
                } catch (e) {
                    sendError('Java检测失败 ' + e.message);
                }
                break;
            }

            case '/api/java/install': {
                const data = await readBody();
                const component = data.component || 'java-runtime-gamma';
                const sessionId = `java-${Date.now()}`;
                javaInstallSessions.set(sessionId, { status: 'pending', progress: 0, message: '准备下载Java运行时..', component });
                sendJSON({ success: true, sessionId });
                downloadJavaRuntime(component, (progress) => {
                    const session = javaInstallSessions.get(sessionId);
                    if (session) {
                        session.status = 'downloading';
                        session.progress = progress.progress;
                        session.message = `下载�? ${progress.file} (${progress.current}/${progress.total})`;
                    }
                }).then((result) => {
                    const session = javaInstallSessions.get(sessionId);
                    if (session) { session.status = 'completed'; session.progress = 100; session.message = 'Java运行时安装完成！'; session.result = result; }
                }).catch((e) => {
                    const session = javaInstallSessions.get(sessionId);
                    if (session) { session.status = 'failed'; session.message = `安装失败: ${e.message}`; session.error = e.message; }
                });
                break;
            }

            case '/api/java/install-status': {
                const sessionId = parsedUrl.query.sessionId;
                if (!sessionId || !javaInstallSessions.has(sessionId)) { sendError('无效的会话ID', 400); break; }
                const session = javaInstallSessions.get(sessionId);
                sendJSON({ success: true, ...session });
                if (session.status === 'completed' || session.status === 'failed') javaInstallSessions.delete(sessionId);
                break;
            }

            case '/api/java/auto-install': {
                const aiData = await readBody();
                const requiredVersion = aiData.requiredVersion || 17;
                const aiSessionId = `java-auto-${Date.now()}`;
                javaInstallSessions.set(aiSessionId, {
                    status: 'detecting',
                    progress: 0,
                    message: '正在检测Java环境...',
                    component: '',
                    source: '',
                    speed: 0,
                    downloadedBytes: 0,
                    totalBytes: 0
                });
                sendJSON({ success: true, sessionId: aiSessionId });

                (async () => {
                    try {
                        const systemJava = detectSystemJava();
                        const bundledJava = detectBundledJava();
                        const allJava = [...bundledJava, ...systemJava];
                        const suitable = allJava.find(j => j.majorVersion >= requiredVersion);

                        if (suitable) {
                            const s = javaInstallSessions.get(aiSessionId);
                            if (s) {
                                s.status = 'completed';
                                s.progress = 100;
                                s.message = `已找到Java ${suitable.version}`;
                                s.result = { path: suitable.path, version: suitable.version, majorVersion: suitable.majorVersion };
                            }
                            return;
                        }

                        const componentMap = { 8: 'java-runtime-alpha', 16: 'java-runtime-gamma', 17: 'java-runtime-gamma', 21: 'java-runtime-delta', 25: 'java-runtime-epsilon' };
                        const component = componentMap[requiredVersion] || 'java-runtime-gamma';

                        const s = javaInstallSessions.get(aiSessionId);
                        if (s) {
                            s.status = 'pending';
                            s.message = `未检测到Java ${requiredVersion}+，正在自动安�?..`;
                            s.component = component;
                        }

                        const result = await downloadJavaRuntime(component, (progress) => {
                            const session = javaInstallSessions.get(aiSessionId);
                            if (session) {
                                session.status = 'downloading';
                                session.progress = progress.progress;
                                session.message = `下载�? ${progress.file} (${progress.current}/${progress.total})`;
                                session.source = progress.source || '';
                                session.speed = progress.speed || 0;
                                session.downloadedBytes = progress.downloadedBytes || 0;
                                session.totalBytes = progress.totalBytes || 0;
                            }
                        });

                        const session = javaInstallSessions.get(aiSessionId);
                        if (session) {
                            session.status = 'configuring';
                            session.progress = 95;
                            session.message = '正在配置Java环境变量...';
                        }

                        if (result.javaHome) {
                            try {
                                configureJavaEnv(result.javaHome, requiredVersion);
                                console.log(`[Java] auto-install 环境变量配置成功: ${result.javaHome}`);
                            } catch (envErr) {
                                console.warn(`[Java] auto-install 环境变量配置失败(不影响使用): ${envErr.message}`);
                            }
                        }

                        session = javaInstallSessions.get(aiSessionId);
                        if (session) {
                            session.status = 'completed';
                            session.progress = 100;
                            session.message = 'Java运行时安装完成！环境变量已配置。';
                            session.result = result;
                        }
                    } catch (e) {
                        const errSession = javaInstallSessions.get(aiSessionId);
                        if (errSession) {
                            errSession.status = 'failed';
                            errSession.message = `安装失败: ${e.message}`;
                            errSession.error = e.message;
                        }
                    }
                })();
                break;
            }

            case '/api/java/download-sources': {
                sendJSON({
                    success: true,
                    sources: [
                        { id: 'bmclapi', name: 'BMCLAPI镜像', description: '国内加速镜像(bangbang93)' },
                        { id: 'mojang', name: 'Mojang官方源', description: 'Minecraft官方Java运行时' },
                        { id: 'temurin', name: 'Adoptium (Temurin)', description: 'Eclipse开源JDK' },
                    ]
                });
                break;
            }

            case '/api/install-start': {
                const data = await readBody();
                const versionUrl = data.url;
                let versionId = data.versionId;
                const loaderInfo = data.loaderInfo;
                const downloadSource = data.downloadSource || 'mojang';
                if (!versionUrl) { sendError('Missing version URL', 400); break; }

                const sessionId = crypto.randomUUID();
                let details = await getVersionDetails(versionUrl);
                
                if (loaderInfo && loaderInfo.type && loaderInfo.version) {
                    const loaderSuffix = loaderInfo.type === 'neoforge' ? 'NeoForge' : 
                                        loaderInfo.type.charAt(0).toUpperCase() + loaderInfo.type.slice(1);
                    const newVersionId = `${details.id}-${loaderSuffix}-${loaderInfo.version}`;
                    
                    const existingVersions = getInstalledVersions();
                    let finalVersionId = newVersionId;
                    let counter = 2;
                    while (existingVersions.some(v => v.id === finalVersionId) || 
                           fs.existsSync(path.join(VERSIONS_DIR, finalVersionId))) {
                        finalVersionId = `${newVersionId}-${counter}`;
                        counter++;
                    }
                    
                    details = JSON.parse(JSON.stringify(details));
                    details.id = finalVersionId;
                    details.inheritsFrom = data.versionId;
                    versionId = finalVersionId;
                } else {
                    const existingVersions = getInstalledVersions();
                    let finalVersionId = details.id;
                    let counter = 2;
                    while (existingVersions.some(v => v.id === finalVersionId) || 
                           fs.existsSync(path.join(VERSIONS_DIR, finalVersionId))) {
                        finalVersionId = `${details.id}-${counter}`;
                        counter++;
                    }
                    if (finalVersionId !== details.id) {
                        details = JSON.parse(JSON.stringify(details));
                        details.id = finalVersionId;
                        versionId = finalVersionId;
                    }
                }
                
                installSessions.set(sessionId, {
                    versionId: details.id, status: 'preparing', progress: 0, stage: 'preparing',
                    message: '准备安装...', startTime: Date.now(), details, errors: [],
                    loaderInfo, downloadSource,
                    _abortController: new AbortController()
                });
                sendJSON({ success: true, sessionId, versionId: details.id });
                performInstallation(sessionId, details).catch(err => {
                    const session = installSessions.get(sessionId);
                    if (session) { session.status = 'failed'; session.stage = 'failed'; session.message = `安装失败: ${err.message}`; session.errors.push(err.message); }
                });
                break;
            }

            case '/api/install-progress': {
                const sessionId = parsedUrl.query.sessionId;
                if (!sessionId || !installSessions.has(sessionId)) { sendError('Invalid session ID', 404); break; }
                const session = installSessions.get(sessionId);

                if (parsedUrl.query.sse === 'true') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                    const interval = setInterval(() => {
                        const s = installSessions.get(sessionId);
                        if (!s) { clearInterval(interval); res.end(); return; }
                        res.write(`data: ${JSON.stringify({
                            sessionId, versionId: s.versionId, status: s.status, progress: s.progress,
                            stage: s.stage, message: s.message, currentFile: s.currentFile || '',
                            totalFiles: s.totalFiles || 0, completedFiles: s.completedFiles || 0,
                            speed: s.speed || 0, bytesDownloaded: s.bytesDownloaded || 0,
                            totalBytes: s.totalBytes || 0, errors: s.errors || []
                        })}\n\n`);
                        if (s.status === 'completed' || s.status === 'failed') {
                            clearInterval(interval);
                            setTimeout(() => installSessions.delete(sessionId), 60000);
                            res.end();
                        }
                    }, 300);
                    req.on('close', () => clearInterval(interval));
                } else {
                    sendJSON({
                        sessionId, versionId: session.versionId, status: session.status, progress: session.progress,
                        stage: session.stage, message: session.message, currentFile: session.currentFile || '',
                        totalFiles: session.totalFiles || 0, completedFiles: session.completedFiles || 0,
                        speed: session.speed || 0, bytesDownloaded: session.bytesDownloaded || 0,
                        totalBytes: session.totalBytes || 0, errors: session.errors || []
                    });
                }
                break;
            }

            case '/api/install-cancel': {
                const sessionId = parsedUrl.query.sessionId;
                if (!sessionId) { sendError('Missing session ID', 400); break; }
                
                if (installSessions.has(sessionId)) {
                    const session = installSessions.get(sessionId);
                    session.status = 'cancelled'; session.stage = 'cancelled'; session.message = '安装已取消';
                    if (session._abortController) { try { session._abortController.abort(); } catch (e) {} }
                    sendJSON({ success: true });
                    if (session.versionId) {
                        const vd = path.join(VERSIONS_DIR, session.versionId);
                        fs.promises.rm(vd, { recursive: true, force: true }).then(() => {
                            console.log(`[Cancel] 已清理安装目录: ${session.versionId}`);
                        }).catch(() => {});
                    }
                } else if (modDownloadSessions.has(sessionId)) {
                    const session = modDownloadSessions.get(sessionId);
                    session.status = 'cancelled'; session.message = '下载已取消';
                    if (session._abortController) { try { session._abortController.abort(); } catch (e) {} }
                    sendJSON({ success: true });
                } else {
                    sendError('Invalid session ID', 404);
                }
                break;
            }

            case '/api/delete-version': {
                const data = await readBody();
                const versionId = data.versionId;
                if (!versionId) { sendError('Missing versionId', 400); break; }
                if (!versionId || /[\\/]|^\./.test(versionId)) { sendError('Invalid versionId', 400); break; }
                const versionDir = path.join(VERSIONS_DIR, versionId);
                const resolvedVersionDir = path.resolve(versionDir);
                if (!resolvedVersionDir.startsWith(path.resolve(VERSIONS_DIR))) { sendError('Invalid versionId path', 400); break; }
                if (fs.existsSync(versionDir)) {
                    fs.rmSync(versionDir, { recursive: true, force: true });
                    sendJSON({ success: true, message: `Version ${versionId} deleted` });
                } else {
                    sendError('Version not found', 404);
                }
                break;
            }

            case '/api/fabric/versions': {
                const gameVersion = parsedUrl.query.game;
                if (gameVersion) {
                    const versions = await getFabricLoaderVersionsForGame(gameVersion);
                    sendJSON({ versions });
                } else {
                    const versions = await getFabricLoaderVersions();
                    sendJSON({ versions });
                }
                break;
            }

            case '/api/fabric/install': {
                const data = await readBody();
                const gameVersion = data.gameVersion;
                const loaderVersion = data.loaderVersion;
                if (!gameVersion) { sendError('Missing gameVersion', 400); break; }

                if (!loaderVersion) {
                    const versions = await getFabricLoaderVersionsForGame(gameVersion);
                    if (versions.length === 0) { sendError('没有可用的Fabric Loader版本', 400); break; }
                    const stable = versions.find(v => v.stable) || versions[0];
                    const result = await installFabric(gameVersion, stable.version);
                    sendJSON(result);
                } else {
                    const result = await installFabric(gameVersion, loaderVersion);
                    sendJSON(result);
                }
                break;
            }

            case '/api/forge/versions': {
                const gameVersion = parsedUrl.query.game;
                if (!gameVersion) { sendError('Missing game parameter', 400); break; }
                try {
                    const metadataUrl = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
                    console.log('[Forge] Fetching metadata from:', metadataUrl);
                    const metadataXml = await fetchText(metadataUrl);
                    console.log('[Forge] Got metadata, length:', metadataXml?.length || 0);
                    const versions = [];
                    
                    const versionMatches = metadataXml.match(/<version>([^<]+)<\/version>/g) || [];
                    console.log('[Forge] Found', versionMatches.length, 'version tags');
                    
                    for (const match of versionMatches) {
                        const ver = match.replace(/<\/?version>/g, '');
                        if (ver.startsWith(gameVersion + '-')) {
                            const forgeVer = ver.split('-')[1];
                            if (forgeVer) {
                                versions.push({ version: forgeVer, gameVersion: gameVersion, type: 'release' });
                            }
                        }
                    }
                    
                    console.log('[Forge] Found', versions.length, 'versions for MC', gameVersion);
                    versions.reverse();
                    if (versions.length > 0) {
                        versions[0].type = '推荐';
                        if (versions.length > 1) versions[1].type = '最新';
                    }
                    
                    sendJSON({ versions: versions.slice(0, 10) });
                } catch (e) {
                    console.error('[Forge] Error fetching versions:', e.message);
                    sendJSON({ versions: [] });
                }
                break;
            }

            case '/api/forge/install': {
                const data = await readBody();
                const gameVersion = data.gameVersion;
                const forgeVersion = data.forgeVersion;
                if (!gameVersion || !forgeVersion) { sendError('Missing parameters', 400); break; }
                const result = await installForge(gameVersion, forgeVersion);
                sendJSON(result);
                break;
            }

            case '/api/neoforge/install': {
                const data = await readBody();
                const gameVersion = data.gameVersion;
                const neoVersion = data.neoVersion;
                if (!gameVersion || !neoVersion) { sendError('Missing parameters', 400); break; }
                try {
                    const baseResult = await ensureBaseVersionInstalled(gameVersion);
                    if (baseResult.error) {
                        sendJSON({ success: false, error: baseResult.error });
                        break;
                    }
                    
                    const versionId = `${gameVersion}-neoforge-${neoVersion}`;
                    const versionDir = path.join(VERSIONS_DIR, versionId);
                    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

                    const neoUrl = `${NEOFORGE_API_URL}/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
                    const neoData = await fetchJSON(neoUrl);

                    const versionJson = {
                        id: versionId,
                        inheritsFrom: gameVersion,
                        mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
                        type: 'release',
                        libraries: [...(neoData.libraries || [])],
                        arguments: {
                            game: ['--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion],
                            jvm: []
                        }
                    };

                    for (const lib of (versionJson.libraries || [])) {
                        if (lib.downloads?.artifact?.url) {
                            const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                            if (!fs.existsSync(libPath)) {
                                try { await downloadFile(lib.downloads.artifact.url, libPath); } catch (e) {}
                            }
                        }
                    }

                    const jsonPath = path.join(versionDir, `${versionId}.json`);
                    fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
                    sendJSON({ success: true, versionId });
                } catch (e) {
                    try {
                        const versionDir = path.join(VERSIONS_DIR, `${gameVersion}-neoforge-${neoVersion}`);
                        if (fs.existsSync(versionDir)) {
                            fs.rmSync(versionDir, { recursive: true, force: true });
                            console.log(`[NeoForge] Cleaned up failed version directory: ${versionDir}`);
                        }
                    } catch (cleanupErr) {
                        console.error(`[NeoForge] Failed to cleanup version directory:`, cleanupErr.message);
                    }
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/neoforge/versions': {
                const gameVersion = parsedUrl.query.game;
                if (!gameVersion) { sendError('Missing game parameter', 400); break; }
                try {
                    const neoForgeVersions = await getNeoForgeVersionsForGame(gameVersion);
                    sendJSON({ versions: neoForgeVersions });
                } catch (e) {
                    sendJSON({ versions: [] });
                }
                break;
            }

            case '/api/status': {
                sendJSON({
                    version: '1.0.0',
                    platform: getPlatformKey(),
                    dataDir: DATA_DIR,
                    minecraftDir: MINECRAFT_DIR,
                    gameRunning: gameInstances.size > 0,
                    gameInstanceCount: gameInstances.size,
                    uptime: process.uptime(),
                    latestRelease: versionCache?.latest?.release || 'unknown',
                    latestSnapshot: versionCache?.latest?.snapshot || 'unknown',
                    downloadEngine: {
                        activeConnections: DownloadManager.activeConnections,
                        connectionLimit: DownloadManager.connectionLimit,
                        speed: DownloadManager.getSpeed(),
                        totalBytesDownloaded: DownloadManager.totalBytesDownloaded
                    }
                });
                break;
            }

            case '/api/avatar': {
                const avatarUuid = parsedUrl.query.uuid || '';
                const avatarServerUrl = parsedUrl.query.serverUrl || '';
                const avatarUsername = parsedUrl.query.username || '';
                const isOfflineAccount = parsedUrl.query.offline === '1';
                if (!avatarUuid) { sendError('Missing uuid', 400); break; }

                const cleanUuid = avatarUuid.replace(/-/g, '');
                const cacheKey = `${cleanUuid}:${avatarServerUrl}:${avatarUsername}`;
                const cached = AVATAR_CACHE.get(cacheKey);

                const serveImage = (data, contentType) => {
                    res.writeHead(200, {
                        'Content-Type': contentType || 'image/png',
                        'Cache-Control': 'public, max-age=86400',
                        'X-Avatar-Cache': cached ? 'hit' : 'miss'
                    });
                    res.end(data);
                };
                const serveImageNoCache = (data, contentType) => {
                    res.writeHead(200, {
                        'Content-Type': contentType || 'image/png',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'X-Avatar-Fallback': 'true'
                    });
                    res.end(data);
                };

                if (cached) {
                    serveImage(cached.data, cached.contentType);
                    if (Date.now() - cached.time > AVATAR_CACHE_DURATION) {
                        refreshAvatarCache(cacheKey, cleanUuid, avatarServerUrl, avatarUsername);
                    }
                    break;
                }

                if (isOfflineAccount) {
                    let offlineHead = null;
                    try {
                        const accounts = loadAccounts();
                        const acc = accounts.find(a => (a.uuid || '').replace(/-/g, '') === cleanUuid);
                        if (acc && acc.skinFile) {
                            const skinPath = path.join(__dirname, 'img', acc.skinFile);
                            if (fs.existsSync(skinPath)) {
                                const skinBuf = fs.readFileSync(skinPath);
                                offlineHead = await cropSkinToHeadWithSharp(skinBuf);
                            }
                        }
                    } catch (e) {}
                    if (!offlineHead) offlineHead = await getSteveHeadLocal();
                    if (offlineHead) {
                        AVATAR_CACHE.set(cacheKey, { data: offlineHead, contentType: 'image/png', time: Date.now() });
                        serveImage(offlineHead, 'image/png');
                    } else {
                        res.writeHead(302, { Location: '/img/steve_head.png' });
                        res.end();
                    }
                    break;
                }

                try {
                    let storedSkinUrl = '';
                    try {
                        const accounts = loadAccounts();
                        const acc = accounts.find(a => (a.uuid || '').replace(/-/g, '') === cleanUuid);
                        if (acc && acc.skinUrl) storedSkinUrl = acc.skinUrl;
                    } catch (e) {}
                    const result = await fetchAvatarData(cleanUuid, avatarServerUrl, avatarUsername, storedSkinUrl);
                    if (result) {
                        AVATAR_CACHE.set(cacheKey, { data: result.data, contentType: result.contentType, time: Date.now() });
                        serveImage(result.data, result.contentType);
                    } else {
                        const defaultHead = await getSteveHeadLocal();
                        if (defaultHead) {
                            serveImageNoCache(defaultHead, 'image/png');
                        } else {
                            res.writeHead(302, { Location: '/img/steve_head.png' });
                            res.end();
                        }
                    }
                } catch (e) {
                    console.error('[Avatar] fetch error:', e);
                    const defaultHead = await getSteveHeadLocal();
                    if (defaultHead) {
                        serveImageNoCache(defaultHead, 'image/png');
                    } else {
                        res.writeHead(302, { Location: '/img/steve_head.png' });
                        res.end();
                    }
                }
                break;
            }

            case '/api/default-skins': {
                const skinDir = path.join(__dirname, 'img');
                const skinFiles = [
                    { id: 'steve', name: 'Steve', file: 'steve_skin.png', model: 'default' },
                    { id: 'alex', name: 'Alex', file: 'skin_alex.png', model: 'slim' },
                    { id: 'zombie', name: 'Zombie', file: 'skin_zombie.png', model: 'default' },
                    { id: 'enderman', name: 'Enderman', file: 'skin_enderman.png', model: 'default' },
                    { id: 'creeper', name: 'Creeper', file: 'skin_creeper.png', model: 'default' }
                ];
                const available = skinFiles.filter(s => fs.existsSync(path.join(skinDir, s.file)));
                sendJSON({ success: true, skins: available });
                break;
            }

            case '/api/skin-head': {
                const headId = parsedUrl.query.id || '';
                if (!headId) { sendError('Missing id', 400); break; }
                const headSkinMap = {
                    steve: 'steve_skin.png',
                    alex: 'skin_alex.png',
                    zombie: 'skin_zombie.png',
                    enderman: 'skin_enderman.png',
                    creeper: 'skin_creeper.png'
                };
                const headFile = headSkinMap[headId];
                if (!headFile) { sendError('Invalid skin id', 400); break; }
                const headPath = path.join(__dirname, 'img', headFile);
                if (!fs.existsSync(headPath)) { sendError('Skin not found', 404); break; }
                const headBuf = fs.readFileSync(headPath);
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
                res.end(headBuf);
                break;
            }

            case '/api/set-account-skin': {
                if (req.method !== 'POST') { sendError('Method not allowed', 405); break; }
                let skBody = '';
                req.on('data', c => skBody += c);
                req.on('end', async () => {
                    try {
                        const skData = JSON.parse(skBody);
                        const { accountId, skinId } = skData;
                        if (!accountId || !skinId) { sendError('Missing params', 400); return; }
                        const accounts = loadAccounts();
                        const acc = accounts.find(a => a.id === accountId);
                        if (!acc) { sendError('Account not found', 404); return; }
                        const skinMap = {
                            steve: { file: 'steve_skin.png', model: 'default' },
                            alex: { file: 'skin_alex.png', model: 'slim' },
                            zombie: { file: 'skin_zombie.png', model: 'default' },
                            enderman: { file: 'skin_enderman.png', model: 'default' },
                            creeper: { file: 'skin_creeper.png', model: 'default' }
                        };
                        const skinInfo = skinMap[skinId];
                        if (!skinInfo) { sendError('Invalid skin', 400); return; }
                        acc.skinFile = skinInfo.file;
                        acc.skinModel = skinInfo.model;
                        saveAccounts(accounts);
                        const cleanUuid = (acc.uuid || '').replace(/-/g, '');
                        for (const key of AVATAR_CACHE.keys()) {
                            if (key.includes(cleanUuid)) AVATAR_CACHE.delete(key);
                        }
                        sendJSON({ success: true });
                    } catch (e) {
                        sendError('Invalid JSON', 400);
                    }
                });
                break;
            }

            case '/api/upload-skin': {
                if (req.method !== 'POST') { sendError('Method not allowed', 405); break; }
                const contentType = req.headers['content-type'] || '';
                let uploadBody = Buffer.alloc(0);
                req.on('data', chunk => { uploadBody = Buffer.concat([uploadBody, chunk]); });
                req.on('end', async () => {
                    try {
                        let skinBuf, accountId, model = 'default';
                        if (contentType.includes('multipart/form-data')) {
                            const boundary = contentType.split('boundary=')[1];
                            if (!boundary) { sendError('Invalid multipart', 400); return; }
                            const boundaryBuf = Buffer.from('--' + boundary);
                            const headerSep = Buffer.from('\r\n\r\n');
                            let pos = 0;
                            while (pos < uploadBody.length) {
                                const start = uploadBody.indexOf(boundaryBuf, pos);
                                if (start === -1) break;
                                const afterBoundary = start + boundaryBuf.length;
                                if (uploadBody[afterBoundary] === 0x2D && uploadBody[afterBoundary + 1] === 0x2D) break;
                                const headerStart = afterBoundary + 2;
                                const headerEnd = uploadBody.indexOf(headerSep, headerStart);
                                if (headerEnd === -1) break;
                                const headers = uploadBody.slice(headerStart, headerEnd).toString('utf8');
                                const bodyStart = headerEnd + 4;
                                const nextBoundary = uploadBody.indexOf(boundaryBuf, bodyStart);
                                const bodyEnd = nextBoundary !== -1 ? nextBoundary - 2 : uploadBody.length;
                                const partBody = uploadBody.slice(bodyStart, bodyEnd);
                                if (headers.includes('name="file"')) {
                                    skinBuf = partBody;
                                } else if (headers.includes('name="accountId"')) {
                                    accountId = partBody.toString('utf8').trim();
                                } else if (headers.includes('name="model"')) {
                                    model = partBody.toString('utf8').trim();
                                }
                                pos = nextBoundary !== -1 ? nextBoundary : uploadBody.length;
                            }
                        } else {
                            const jsonData = JSON.parse(uploadBody.toString());
                            accountId = jsonData.accountId;
                            model = jsonData.model || 'default';
                            if (jsonData.fileBase64) {
                                skinBuf = Buffer.from(jsonData.fileBase64, 'base64');
                            }
                        }
                        if (!skinBuf || !accountId) { sendError('Missing file or accountId', 400); return; }
                        const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
                        if (!skinBuf.slice(0, 4).equals(PNG_MAGIC)) { sendError('File must be PNG', 400); return; }
                        const accounts = loadAccounts();
                        const acc = accounts.find(a => a.id === accountId);
                        if (!acc) { sendError('Account not found', 404); return; }
                        let metadata;
                        try {
                            metadata = await sharp(skinBuf).metadata();
                        } catch (e) { sendError('Invalid PNG', 400); return; }
                        if (!((metadata.width === 64 && metadata.height === 64) || (metadata.width === 64 && metadata.height === 32))) {
                            sendError('Skin must be 64x64 or 64x32 PNG', 400); return;
                        }
                        const fileName = `custom_${accountId}_${Date.now()}.png`;
                        const filePath = path.join(__dirname, 'img', fileName);
                        fs.writeFileSync(filePath, skinBuf);
                        acc.skinFile = fileName;
                        acc.skinModel = model === 'slim' ? 'slim' : 'default';
                        saveAccounts(accounts);
                        const cleanUuid = (acc.uuid || '').replace(/-/g, '');
                        for (const key of AVATAR_CACHE.keys()) {
                            if (key.includes(cleanUuid)) AVATAR_CACHE.delete(key);
                        }
                        sendJSON({ success: true, fileName });
                    } catch (e) {
                        sendError('Upload failed: ' + e.message, 500);
                    }
                });
                break;
            }

            case '/api/skin-texture': {
                const stUuid = parsedUrl.query.uuid || '';
                const stServerUrl = parsedUrl.query.serverUrl || '';
                const stUsername = parsedUrl.query.username || '';
                if (!stUuid) { sendError('Missing uuid', 400); break; }
                const stClean = stUuid.replace(/-/g, '');
                const stCacheKey = `skin:${stClean}:${stServerUrl}:${stUsername}`;
                const stCached = AVATAR_CACHE.get(stCacheKey);
                const serveStImage = (data, ct) => {
                    res.writeHead(200, { 'Content-Type': ct || 'image/png', 'Cache-Control': 'public, max-age=86400' });
                    res.end(data);
                };
                if (stCached) { serveStImage(stCached.data, stCached.contentType); break; }
                try {
                    let stStoredSkinUrl = '';
                    let stSkinFile = '';
                    try {
                        const accounts = loadAccounts();
                        const acc = accounts.find(a => (a.uuid || '').replace(/-/g, '') === stClean);
                        if (acc && acc.skinUrl) stStoredSkinUrl = acc.skinUrl;
                        if (acc && acc.skinFile) stSkinFile = acc.skinFile;
                    } catch (e) {}
                    if (stSkinFile) {
                        const skinPath = path.join(__dirname, 'img', stSkinFile);
                        if (fs.existsSync(skinPath)) {
                            const data = fs.readFileSync(skinPath);
                            AVATAR_CACHE.set(stCacheKey, { data, contentType: 'image/png', time: Date.now() });
                            serveStImage(data, 'image/png');
                            break;
                        }
                    }
                    const stResult = await fetchAvatarDataFull(stClean, stServerUrl, stUsername, stStoredSkinUrl);
                    if (stResult) {
                        AVATAR_CACHE.set(stCacheKey, { data: stResult.data, contentType: stResult.contentType, time: Date.now() });
                        serveStImage(stResult.data, stResult.contentType);
                    } else {
                        const dh = await getSteveSkinFull();
                        if (dh) serveStImage(dh, 'image/png');
                        else { res.writeHead(302, { Location: '/img/steve_head.png' }); res.end(); }
                    }
                } catch (e) {
                    const dh = await getSteveSkinFull();
                    if (dh) serveStImage(dh, 'image/png');
                    else { res.writeHead(302, { Location: '/img/steve_head.png' }); res.end(); }
                }
                break;
            }

            case '/api/version-icon': {
                const versionId = parsedUrl.query.id || '';
                if (!versionId) { sendError('Missing id', 400); break; }

                const cacheKey = `${versionId}_${parsedUrl.query.type || 'release'}_${parsedUrl.query.forge || ''}_${parsedUrl.query.fabric || ''}_${parsedUrl.query.neoforge || ''}`;
                const cached = VERSION_ICON_CACHE.get(cacheKey);
                if (cached && Date.now() - cached.time < VERSION_ICON_CACHE_DURATION) {
                    res.writeHead(200, {
                        'Content-Type': 'image/png',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0',
                        'X-VersionIcon-Cache': 'hit'
                    });
                    res.end(cached.data);
                    break;
                }

                try {
                    const blockIconMap = {
                        'snapshot': 'CobbleStone.png',
                        'release': 'Grass.png'
                    };
                    const versionType = parsedUrl.query.type || 'release';
                    const isForge = parsedUrl.query.forge === 'true';
                    const isFabric = parsedUrl.query.fabric === 'true';
                    const isNeoForge = parsedUrl.query.neoforge === 'true';
                    const isModpack = parsedUrl.query.modpack === 'true';
                    let blockFile = blockIconMap[versionType] || 'Grass.png';
                    
                    if (isModpack && !isForge && !isFabric && !isNeoForge) blockFile = 'Anvil.png';
                    else if (isNeoForge) blockFile = 'NeoForge.png';
                    else if (isForge) blockFile = 'CommandBlock.png';
                    else if (isFabric) blockFile = 'Fabric.png';

                    const blockPath = path.join(__dirname, 'img', blockFile);
                    if (fs.existsSync(blockPath)) {
                        const iconData = fs.readFileSync(blockPath);
                        VERSION_ICON_CACHE.set(cacheKey, { data: iconData, time: Date.now() });
                        res.writeHead(200, {
                            'Content-Type': 'image/png',
                            'Cache-Control': 'no-cache, no-store, must-revalidate',
                            'Pragma': 'no-cache',
                            'Expires': '0'
                        });
                        res.end(iconData);
                        console.log(`[VersionIcon] ${versionId} -> ${blockFile}`);
                    } else {
                        res.writeHead(302, { Location: '/img/Grass.png' });
                        res.end();
                    }
                } catch (e) {
                    console.log('[VersionIcon] 错误:', e.message);
                    res.writeHead(302, { Location: '/img/Grass.png' });
                    res.end();
                }
                break;
            }

            case '/api/lan/create': {
                const data = await readBody();
                const roomName = data.name || '';
                const gamePort = data.port || 25565;
                const playerName = data.playerName || '主机';
                
                try {
                    const result = createLANRoom(roomName, gamePort, playerName);
                    sendJSON({ success: true, code: result.code, relayPort: result.relayPort, name: result.name });
                } catch (e) {
                    sendError('创建房间失败: ' + e.message);
                }
                break;
            }

            case '/api/lan/join': {
                const data = await readBody();
                const code = (data.code || '').toUpperCase().trim();
                const playerName = data.playerName || '玩家';
                
                if (!code) { sendError('请输入房间号', 400); break; }
                
                const room = lanRooms.get(code);
                if (!room) { sendError('房间不存在', 404); break; }
                if (room.status !== 'active') { sendError('房间未就绪', 400); break; }
                
                const peerId = crypto.randomUUID();
                room.peers.set(peerId, { id: peerId, name: playerName, connectedAt: Date.now() });
                
                sendJSON({ 
                    success: true, 
                    code: room.code, 
                    name: room.name,
                    hostPlayer: room.hostPlayer,
                    relayPort: room.relayPort,
                    gamePort: room.gamePort,
                    peerId
                });
                break;
            }

            case '/api/lan/info': {
                const code = (parsedUrl.query.code || '').toUpperCase().trim();
                if (!code) { sendError('Missing code', 400); break; }
                
                const info = getLANRoomInfo(code);
                if (!info) { sendError('房间不存在', 404); break; }
                
                sendJSON({ success: true, room: info });
                break;
            }

            case '/api/lan/leave': {
                const data = await readBody();
                const code = (data.code || '').toUpperCase().trim();
                const peerId = data.peerId || '';
                
                const room = lanRooms.get(code);
                if (!room) { sendJSON({ success: true }); break; }
                
                if (peerId) {
                    const conn = room.connections.get(peerId);
                    if (conn) {
                        if (conn.client) conn.client.destroy();
                        if (conn.server) conn.server.destroy();
                        room.connections.delete(peerId);
                    }
                    room.peers.delete(peerId);
                }
                
                sendJSON({ success: true });
                break;
            }

            case '/api/lan/destroy': {
                const data = await readBody();
                const code = (data.code || '').toUpperCase().trim();
                destroyLANRoom(code);
                sendJSON({ success: true });
                break;
            }

            case '/api/lan/my-ip': {
                const nets = os.networkInterfaces();
                const ips = [];
                for (const name of Object.keys(nets)) {
                    for (const net of nets[name]) {
                        if (net.family === 'IPv4' && !net.internal) {
                            ips.push({ interface: name, address: net.address });
                        }
                    }
                }
                const publicIP = await getPublicIP();
                sendJSON({ success: true, ips, publicIP });
                break;
            }

            case '/api/lan/upnp-map': {
                const upnpData = await readBody();
                const internalPort = parseInt(upnpData.internalPort, 10) || 25565;
                const externalPort = parseInt(upnpData.externalPort, 10) || internalPort;
                const desc = upnpData.description || 'VersePC Minecraft';
                
                const result = await upnpAddPortMapping(internalPort, externalPort, desc);
                sendJSON(result);
                break;
            }

            case '/api/lan/upnp-unmap': {
                const unmapData = await readBody();
                const extPort = parseInt(unmapData.externalPort, 10);
                if (!extPort) { sendError('Missing externalPort', 400); break; }
                
                const result = await upnpDeletePortMapping(extPort);
                sendJSON(result);
                break;
            }

            case '/api/lan/upnp-status': {
                sendJSON({ 
                    success: true, 
                    mappings: Array.from(upnpMappings.entries()).map(([ext, int]) => ({
                        externalPort: ext, internalPort: int.internalPort, description: int.description, localIP: int.localIP
                    }))
                });
                break;
            }

            case '/api/lan/upnp-diagnose': {
                const diag = { platform: os.platform(), checks: [], canUseUPnP: false, recommendations: [] };
                
                diag.checks.push({ name: 'Platform', result: os.platform(), status: 'info' });
                
                const netIfs = os.networkInterfaces();
                const localIPs = [];
                for (const name of Object.keys(netIfs)) {
                    for (const net of netIfs[name]) {
                        if (net.family === 'IPv4' && !net.internal) {
                            localIPs.push({ address: net.address, interface: name });
                        }
                    }
                }
                diag.checks.push({ name: 'Local IPs', result: localIPs, status: localIPs.length > 0 ? 'ok' : 'warn' });
                
                if (localIPs.length === 0) {
                    diag.recommendations.push('No non-internal IPv4 addresses found. Check network connection.');
                } else {
                    const hasPrivateIP = localIPs.some(ip => {
                        const p = ip.address.split('.').map(Number);
                        return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
                    });
                    if (hasPrivateIP) {
                        diag.checks.push({ name: 'NAT Detection', result: 'Behind NAT (private IP)', status: 'info' });
                        diag.recommendations.push('You are behind NAT. UPnP port mapping is needed for remote connections.');
                    } else {
                        diag.checks.push({ name: 'NAT Detection', result: 'Public IP detected', status: 'ok' });
                    }
                }
                
                if (os.platform() === 'win32') {
                    try {
                        const ssdpSvc = execSync('sc query SSDPSRV', { encoding: 'utf8', timeout: 5000 });
                        const isRunning = ssdpSvc.includes('RUNNING');
                        diag.checks.push({ name: 'Windows SSDP Discovery Service', result: isRunning ? 'Running (may conflict)' : 'Not running', status: isRunning ? 'warn' : 'ok' });
                        if (isRunning) {
                            diag.recommendations.push('Windows SSDP Discovery service is running and may intercept UPnP responses. You can stop it with: sc stop SSDPSRV (requires admin)');
                        }
                    } catch (e) {
                        diag.checks.push({ name: 'Windows SSDP Discovery Service', result: 'Could not check', status: 'warn' });
                    }
                }
                
                try {
                    const gateway = await discoverUPnPGateway();
                    diag.checks.push({ name: 'UPnP Gateway Discovery', result: `Found: ${gateway.address}`, status: 'ok' });
                    
                    try {
                        const ctrlInfo = await getUPnPControlURL(gateway.location);
                        diag.checks.push({ name: 'WANIPConnection Service', result: ctrlInfo.serviceType || 'Found', status: 'ok' });
                        diag.canUseUPnP = true;
                    } catch (e) {
                        diag.checks.push({ name: 'WANIPConnection Service', result: e.message, status: 'fail' });
                        diag.recommendations.push('Gateway found but WANIPConnection service not available. Your router may not support UPnP port mapping.');
                    }
                } catch (e) {
                    diag.checks.push({ name: 'UPnP Gateway Discovery', result: e.message, status: 'fail' });
                    diag.recommendations.push('UPnP gateway not found. Please check:');
                    diag.recommendations.push('1. Router UPnP feature is enabled in router admin panel');
                    diag.recommendations.push('2. Windows Firewall allows UDP port 1900 (SSDP)');
                    diag.recommendations.push('3. Network type is set to "Private" not "Public"');
                    diag.recommendations.push('4. No other security software blocking multicast traffic');
                }
                
                try {
                    const publicIP = await getPublicIP();
                    diag.checks.push({ name: 'Public IP', result: publicIP, status: 'ok' });
                } catch (e) {
                    diag.checks.push({ name: 'Public IP', result: 'Could not detect', status: 'warn' });
                }
                
                if (diag.recommendations.length === 0 && diag.canUseUPnP) {
                    diag.recommendations.push('UPnP appears to be working correctly.');
                }
                
                sendJSON({ success: true, diagnosis: diag });
                break;
            }

            case '/api/lan/remote-create': {
                const rData = await readBody();
                const roomName = rData.name || '';
                const gamePort = parseInt(rData.port, 10) || 25565;
                const playerName = rData.playerName || '主机';
                const useUPnP = rData.useUPnP !== false;
                
                try {
                    let wsPort = 31000 + Math.floor(Math.random() * 100);
                    let wsResult = null;
                    
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            wsResult = startWSRelayServer(wsPort);
                            if (wsResult.success) break;
                        } catch (e) {
                            console.log('[LAN-Remote] WS port', wsPort, 'failed:', e.message);
                        }
                        wsPort = 31000 + Math.floor(Math.random() * 1000);
                    }
                    
                    if (!wsResult || !wsResult.success) {
                        sendError('WebSocket中继启动失败');
                        break;
                    }
                    
                    let upnpResult = null;
                    let publicIP = null;
                    
                    if (useUPnP) {
                        try {
                            upnpResult = await upnpAddPortMapping(gamePort, gamePort, 'VersePC Minecraft');
                        } catch (e) {
                            console.log('[LAN-Remote] UPnP failed:', e.message);
                            upnpResult = { success: false, error: e.message };
                        }
                    }
                    
                    try {
                        publicIP = await getPublicIP();
                    } catch (e) {
                        console.log('[LAN-Remote] Public IP detection failed:', e.message);
                    }
                    
                    const localIPs = [];
                    try {
                        const netIfs = os.networkInterfaces();
                        for (const name of Object.keys(netIfs)) {
                            for (const net of netIfs[name]) {
                                if (net.family === 'IPv4' && !net.internal) {
                                    localIPs.push(net.address);
                                }
                            }
                        }
                    } catch (e) {}
                    
                    sendJSON({
                        success: true,
                        wsPort: wsResult.port,
                        gamePort,
                        upnp: upnpResult,
                        publicIP,
                        localIPs,
                        connectInfo: publicIP ? `${publicIP}:${gamePort}` : (localIPs[0] ? `${localIPs[0]}:${gamePort}` : 'unknown')
                    });
                } catch (e) {
                    console.error('[LAN-Remote] Error:', e);
                    sendError('创建远程房间失败: ' + e.message);
                }
                break;
            }

            case '/api/lan/public-ip': {
                const pubIP = await getPublicIP();
                sendJSON({ success: true, publicIP: pubIP });
                break;
            }

            case '/api/easytier/status': {
                const terracottaState = await getTerracottaState();
                sendJSON({
                    success: true,
                    installed: isTerracottaInstalled(),
                    running: terracottaStatus.running,
                    mode: terracottaStatus.mode,
                    roomCode: terracottaStatus.roomCode,
                    virtualIP: terracottaStatus.virtualIP,
                    gamePort: terracottaStatus.gamePort,
                    state: terracottaState,
                    profiles: terracottaStatus.profiles || [],
                    difficulty: terracottaStatus.difficulty || null,
                    errorType: terracottaStatus.errorType || null,
                    errorMessage: terracottaStatus.errorMessage || null
                });
                break;
            }

            case '/api/easytier/host': {
                const etHostData = await readBody();
                const etGamePort = etHostData.gamePort || 25565;
                
                try {
                    const result = await terracottaStartHost(etGamePort);
                    sendJSON({ success: true, ...result });
                } catch (e) {
                    sendError('创建联机失败: ' + e.message);
                }
                break;
            }

            case '/api/easytier/guest': {
                const etGuestData = await readBody();
                const etGuestRoomCode = etGuestData.roomCode || etGuestData.invitationCode;
                
                if (!etGuestRoomCode) {
                    sendError('缺少房间码', 400);
                    break;
                }
                
                try {
                    const result = await terracottaStartGuest(etGuestRoomCode);
                    sendJSON({ success: true, ...result });
                } catch (e) {
                    sendError('加入联机失败: ' + e.message);
                }
                break;
            }

            case '/api/easytier/stop': {
                stopTerracotta();
                sendJSON({ success: true });
                break;
            }

            case '/api/easytier/peers': {
                const terracottaState = await getTerracottaState();
                sendJSON({ success: true, state: terracottaState, status: terracottaStatus });
                break;
            }

            case '/api/easytier/log': {
                if (!terracottaHttpPort) { sendJSON({ log: '' }); break; }
                try {
                    const logData = await terracottaHttpGet('/log?fetch=true');
                    sendJSON({ log: typeof logData === 'string' ? logData : JSON.stringify(logData) });
                } catch (e) {
                    sendJSON({ log: '', error: e.message });
                }
                break;
            }

            case '/api/open-folder': {
                const data = await readBody();
                const folder = data.folder || 'data';
                let targetPath = DATA_DIR;
                switch (folder) {
                    case 'minecraft': targetPath = MINECRAFT_DIR; break;
                    case 'versions': targetPath = VERSIONS_DIR; break;
                    case 'mods': {
                        const settings = loadSettingsCached();
                        const modsDir = getVersionModsDir(settings.selectedVersion);
                        targetPath = modsDir || path.join(DATA_DIR, 'mods');
                        break;
                    }
                    case 'assets': targetPath = ASSETS_DIR; break;
                    case 'logs': targetPath = LOGS_DIR; break;
                    case 'crash-reports': {
                        const crDir = getVersionSubDir(null, 'crash-reports');
                        targetPath = crDir || path.join(DATA_DIR, 'crash-reports');
                        break;
                    }
                    case 'shaderpacks': {
                        const spDir = getVersionSubDir(null, 'shaderpacks');
                        if (spDir) {
                            if (!fs.existsSync(spDir)) fs.mkdirSync(spDir, { recursive: true });
                            targetPath = spDir;
                        } else {
                            targetPath = path.join(DATA_DIR, 'shaderpacks');
                        }
                        break;
                    }
                    case 'resourcepacks': {
                        const rpDir = getVersionSubDir(null, 'resourcepacks');
                        if (rpDir) {
                            if (!fs.existsSync(rpDir)) fs.mkdirSync(rpDir, { recursive: true });
                            targetPath = rpDir;
                        } else {
                            targetPath = path.join(DATA_DIR, 'resourcepacks');
                        }
                        break;
                    }
                    case 'datapacks': {
                        const dpDir = getVersionSubDir(null, 'datapacks');
                        if (dpDir) {
                            if (!fs.existsSync(dpDir)) fs.mkdirSync(dpDir, { recursive: true });
                            targetPath = dpDir;
                        } else {
                            targetPath = path.join(DATA_DIR, 'datapacks');
                        }
                        break;
                    }
                    case 'game': {
                        const gameDir = getVersionSubDir(null, '');
                        if (gameDir) {
                            targetPath = gameDir;
                        } else {
                            const settings = loadSettingsCached();
                            targetPath = settings.gameDir || DATA_DIR;
                        }
                        break;
                    }
                }
                if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
                try {
                    if (process.platform === 'win32') {
                        const { shell } = require('electron');
                        shell.openPath(targetPath);
                    } else if (process.platform === 'darwin') {
                        require('child_process').execFile('open', [targetPath]);
                    } else {
                        require('child_process').execFile('xdg-open', [targetPath]);
                    }
                    sendJSON({ success: true, path: targetPath });
                } catch (e) {
                    sendJSON({ success: true, path: targetPath });
                }
                break;
            }

            case '/api/mods/detail': {
                const modProjectId = parsedUrl.query.projectId;
                const modSource = parsedUrl.query.source || 'modrinth';
                if (!modProjectId) { sendError('Missing projectId', 400); break; }

                try {
                    if (modSource === 'modrinth') {
                        const project = await cachedFetchJSON(`${MODRINTH_API}/project/${modProjectId}`, 300000);
                        const detail = {
                            id: project.id,
                            slug: project.slug,
                            title: project.title,
                            description: project.description || '',
                            body: project.body || '',
                            icon: project.icon_url || '',
                            downloads: project.downloads || 0,
                            followers: project.followers || 0,
                            categories: project.categories || [],
                            loaders: project.loaders || [],
                            gameVersions: project.game_versions || [],
                            clientSide: project.client_side || 'unknown',
                            serverSide: project.server_side || 'unknown',
                            license: project.license?.name || '',
                            sourceUrl: project.source_url || '',
                            issuesUrl: project.issues_url || '',
                            wikiUrl: project.wiki_url || '',
                            discordUrl: project.discord_url || '',
                            dateCreated: project.published || '',
                            dateModified: project.updated || '',
                            gallery: (project.gallery || []).map(g => typeof g === 'string' ? g : g.url || ''),
                            source: 'modrinth'
                        };
                        sendJSON(detail);
                    } else if (modSource === 'curseforge') {
                        const settings = loadSettingsCached();
                        const cfApiKey = settings.curseforgeApiKey || '';
                        const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                        const cfProject = await fetchJSON(`${CURSEFORGE_API}/mods/${modProjectId}`, cfHeaders);
                        const mod = cfProject.data || cfProject;
                        const detail = {
                            id: String(mod.id),
                            slug: mod.slug || '',
                            title: mod.name || 'Unknown',
                            description: mod.summary || '',
                            body: mod.description || mod.summary || '',
                            icon: mod.logo?.url || '',
                            downloads: mod.downloadCount || 0,
                            followers: mod.followers || mod.thumbsUpCount || 0,
                            categories: (mod.categories || []).map(c => typeof c === 'string' ? c : c.name || ''),
                            loaders: (mod.latestFilesIndexes || []).map(f => {
                                if (f.modLoader === 1) return 'forge';
                                if (f.modLoader === 4) return 'fabric';
                                if (f.modLoader === 5) return 'neoforge';
                                return '';
                            }).filter(Boolean),
                            gameVersions: [...new Set((mod.latestFilesIndexes || []).map(f => f.gameVersion))],
                            clientSide: 'unknown',
                            serverSide: 'unknown',
                            license: '',
                            sourceUrl: mod.links?.sourceUrl || '',
                            issuesUrl: mod.links?.issuesUrl || '',
                            wikiUrl: mod.links?.wikiUrl || '',
                            discordUrl: '',
                            dateCreated: mod.dateCreated || '',
                            dateModified: mod.dateModified || '',
                            gallery: (mod.screenshots || []).map(s => typeof s === 'string' ? s : s.url || ''),
                            source: 'curseforge'
                        };
                        sendJSON(detail);
                    } else {
                        sendError('Unsupported source', 400);
                    }
                } catch (e) {
                    sendError('获取模组详情失败: ' + e.message);
                }
                break;
            }

            case '/api/mods/versions': {
                const mvProjectId = parsedUrl.query.projectId;
                const mvSource = parsedUrl.query.source || 'modrinth';
                const mvLoader = parsedUrl.query.loader || '';
                const mvGameVer = parsedUrl.query.gameVersion || '';
                if (!mvProjectId) { sendError('Missing projectId', 400); break; }

                try {
                    if (mvSource === 'modrinth') {
                        const encodedId = encodeURIComponent(mvProjectId);
                        let versionUrl = `${MODRINTH_API}/project/${encodedId}/version`;
                        const params = [];
                        if (mvLoader) params.push(`loaders=["${encodeURIComponent(mvLoader)}"]`);
                        if (mvGameVer) params.push(`game_versions=["${encodeURIComponent(mvGameVer)}"]`);
                        if (params.length > 0) versionUrl += '?' + params.join('&');

                        let versions;
                        try {
                            versions = await cachedFetchJSON(versionUrl, 600000, 3, 25000);
                        } catch (mirrorErr) {
                            console.warn(`[Modrinth] 镜像请求失败，直接请求官方API: ${mirrorErr.message}`);
                            const officialUrl = `https://api.modrinth.com/v2/project/${encodedId}/version${params.length > 0 ? '?' + params.join('&') : ''}`;
                            versions = await fetchJSON(officialUrl, 2, 30000);
                        }
                        const result = (versions || []).map(v => ({
                            id: v.id,
                            versionNumber: v.version_number || '',
                            versionName: v.name || v.version_number || '',
                            gameVersions: v.game_versions || [],
                            loaders: v.loaders || [],
                            releaseType: v.version_type || 'release',
                            datePublished: v.date_published || '',
                            downloads: v.downloads || 0,
                            changelog: v.changelog || '',
                            files: (v.files || []).map(f => ({
                                id: f.id || f.hashes?.sha1 || '',
                                url: f.url,
                                filename: f.filename,
                                size: f.size || 0,
                                primary: f.primary || false,
                                sha1: f.hashes?.sha1 || ''
                            })),
                            dependencies: (v.dependencies || []).map(d => ({
                                projectId: d.project_id,
                                versionId: d.version_id,
                                dependencyType: d.dependency_type,
                                modName: d.project_id || ''
                            }))
                        }));
                        sendJSON({ versions: result });
                    } else if (mvSource === 'curseforge') {
                        const settings = loadSettingsCached();
                        const cfApiKey = settings.curseforgeApiKey || '';
                        const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
                        let cfUrl = `${CURSEFORGE_API}/mods/${mvProjectId}/files`;
                        const cfParams = [];
                        if (mvGameVer) cfParams.push(`gameVersion=${mvGameVer}`);
                        if (mvLoader) {
                            const loaderMap = { fabric: 4, forge: 1, neoforge: 6, quilt: 5 };
                            const loaderType = loaderMap[mvLoader.toLowerCase()];
                            if (loaderType) cfParams.push(`modLoaderType=${loaderType}`);
                        }
                        if (cfParams.length > 0) cfUrl += '?' + cfParams.join('&');

                        const cfRes = await fetchJSON(cfUrl, cfHeaders, 25000);
                        const cfFiles = cfRes.data || [];
                        const byVersion = new Map();
                        for (const f of cfFiles) {
                            const gv = (f.gameVersions || []).find(v => /^\d+\.\d+/.test(v)) || (f.gameVersions || [])[0] || '';
                            const key = gv || f.id;
                            if (!byVersion.has(key)) {
                                byVersion.set(key, {
                                    id: String(f.id),
                                    versionNumber: f.displayName || f.fileName || '',
                                    versionName: f.displayName || f.fileName || '',
                                    gameVersions: f.gameVersions || [],
                                    loaders: (f.gameVersions || []).filter(v => ['fabric','forge','neoforge','quilt','fabric-loader','forge-loader'].includes(v.toLowerCase())).map(v => v.toLowerCase().replace('-loader','')),
                                    releaseType: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
                                    datePublished: f.fileDate || '',
                                    downloads: 0,
                                    changelog: '',
                                    files: [],
                                    dependencies: (f.dependencies || []).map(d => ({
                                        projectId: String(d.modId || ''),
                                        versionId: String(d.fileId || ''),
                                        dependencyType: d.relationType === 3 ? 'required' : d.relationType === 2 ? 'optional' : 'incompatible',
                                        modName: ''
                                    }))
                                });
                            }
                            byVersion.get(key).files.push({
                                id: String(f.id),
                                url: f.downloadUrl || '',
                                filename: f.fileName || '',
                                size: f.fileLength || 0,
                                primary: byVersion.get(key).files.length === 0,
                                sha1: ''
                            });
                        }
                        sendJSON({ versions: Array.from(byVersion.values()) });
                    } else {
                        sendError('Unsupported source', 400);
                    }
                } catch (e) {
                    sendError('获取模组版本列表失败: ' + e.message);
                }
                break;
            }

            case '/api/mods/download-version': {
                const dvData = await readBody();
                const dvVersionId = dvData.versionId;
                const dvSource = dvData.source || 'modrinth';
                const dvProjectId = dvData.projectId;
                const dvGameVersion = dvData.gameVersion || '';
                const dvLoader = dvData.loader || '';
                const dvSavePath = dvData.savePath || '';
                const dvIncludeDeps = dvData.includeDeps !== false;

                if (!dvVersionId && !dvProjectId) { sendError('Missing versionId or projectId', 400); break; }

                let destDir = dvSavePath;
                if (!destDir && dvVersionId) {
                    destDir = getVersionModsDir(dvVersionId);
                }
                if (!destDir) {
                    const settings = loadSettingsCached();
                    destDir = getVersionModsDir(settings.selectedVersion);
                }
                
                if (!destDir) {
                    const installedVersions = getInstalledVersions();
                    if (installedVersions.length > 0) {
                        destDir = getVersionModsDir(installedVersions[0].id);
                    }
                    if (!destDir) {
                        sendError('请先安装一个游戏版本');
                        break;
                    }
                }
                
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                try {
                    let downloadUrl = null;
                    let fileName = null;
                    let fileSize = 0;

                    if (dvSource === 'modrinth') {
                        let versionData;
                        if (dvVersionId) {
                            versionData = await fetchJSON(`${MODRINTH_API}/version/${dvVersionId}`);
                        } else {
                            let versionApiUrl = `${MODRINTH_API}/project/${dvProjectId}/version`;
                            const params = [];
                            if (dvGameVersion) params.push(`game_versions=["${dvGameVersion}"]`);
                            if (dvLoader) params.push(`loaders=["${dvLoader}"]`);
                            if (params.length > 0) {
                                versionApiUrl += '?' + params.join('&');
                            } else {
                                versionApiUrl += '?limit=1';
                            }
                            const versions = await fetchJSON(versionApiUrl);
                            
                            if (dvGameVersion || dvLoader) {
                                const filtered = (versions || []).filter(v => {
                                    const gv = v.game_versions || [];
                                    const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                    let match = true;
                                    if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                                    if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                                    return match;
                                });
                                versionData = filtered[0] || versions?.[0];
                            } else {
                                versionData = versions?.[0];
                            }
                        }

                        if (!versionData) { sendError('未找到匹配的版本信息'); break; }

                        const primaryFile = versionData.files?.find(f => f.primary) || versionData.files?.[0];
                        if (!primaryFile) { sendError('未找到下载文件'); break; }

                        downloadUrl = primaryFile.url;
                        fileName = primaryFile.filename;
                        fileSize = primaryFile.size || 0;

                        const depDownloads = [];
                        if (dvIncludeDeps) {
                        for (const dep of (versionData.dependencies || [])) {
                            if (dep.dependency_type === 'required' && dep.project_id) {
                                try {
                                    let depVersionApiUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                                    const depParams = [];
                                    if (dvGameVersion) depParams.push(`game_versions=["${dvGameVersion}"]`);
                                    if (dvLoader) depParams.push(`loaders=["${dvLoader}"]`);
                                    if (depParams.length > 0) {
                                        depVersionApiUrl += '?' + depParams.join('&');
                                    } else {
                                        depVersionApiUrl += '?limit=1';
                                    }
                                    const depVersions = await fetchJSON(depVersionApiUrl);
                                    let depVersionData = null;
                                    if (dvGameVersion || dvLoader) {
                                        const depFiltered = (depVersions || []).filter(v => {
                                            const gv = v.game_versions || [];
                                            const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                            let match = true;
                                            if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                                            if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                                            return match;
                                        });
                                        depVersionData = depFiltered[0] || depVersions?.[0];
                                    } else {
                                        depVersionData = depVersions?.[0];
                                    }
                                    if (depVersionData?.files?.[0]) {
                                        const depFile = depVersionData.files.find(f => f.primary) || depVersionData.files[0];
                                        const depName = depFile.filename;
                                        const depDest = path.join(destDir, depName);
                                        if (!fs.existsSync(depDest)) {
                                            depDownloads.push({ url: depFile.url, fileName: depName, dest: depDest, size: depFile.size || 0 });
                                        }
                                    }
                                } catch (e) {}
                            }
                        }
                        }

                        const safeName = (fileName || `${dvProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                        const destPath = path.join(destDir, safeName);

                        const sessionId = `mod-${Date.now()}`;
                        modDownloadSessions.set(sessionId, {
                            status: 'downloading', progress: 0, message: '下载中..',
                            fileName: safeName, totalSize: fileSize, downloaded: 0,
                            dependencies: depDownloads.length, currentDep: 0
                        });

                        sendJSON({ success: true, sessionId, fileName: safeName });

                        try {
                            await downloadFile(downloadUrl, destPath, (p) => {
                                const session = modDownloadSessions.get(sessionId);
                                if (session) {
                                    session.progress = Math.round(p.progress);
                                    session.downloaded = p.bytesDownloaded || 0;
                                    session.message = `下载 ${safeName} ${p.progress.toFixed(0)}%`;
                                }
                            }, 2);

                            for (let di = 0; di < depDownloads.length; di++) {
                                const dep = depDownloads[di];
                                const session = modDownloadSessions.get(sessionId);
                                if (session) {
                                    session.currentDep = di + 1;
                                    session.message = `下载依赖 ${dep.fileName}`;
                                    session.progress = 50 + Math.round((di / depDownloads.length) * 50);
                                }
                                await downloadFile(dep.url, dep.dest, null, 2);
                            }

                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.status = 'completed';
                                session.progress = 100;
                                session.message = `${safeName} 下载完成！`;
                            }
                        } catch (e) {
                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                session.status = 'failed';
                                session.message = `下载失败: ${e.message}`;
                            }
                        }
                    } else {
                        sendError('Unsupported source', 400);
                    }
                } catch (e) {
                    sendError('下载失败: ' + e.message);
                }
                break;
            }

            case '/api/mods/download-status': {
                const dsSessionId = parsedUrl.query.sessionId;
                if (!dsSessionId || !modDownloadSessions.has(dsSessionId)) {
                    sendJSON({ status: 'unknown', progress: 0, message: '' });
                    break;
                }
                const dsSession = modDownloadSessions.get(dsSessionId);
                sendJSON({ ...dsSession });
                if (dsSession.status === 'completed' || dsSession.status === 'failed') {
                    setTimeout(() => modDownloadSessions.delete(dsSessionId), 30000);
                }
                break;
            }

            case '/api/mods/resolve-deps': {
                const depIds = parsedUrl.query.ids;
                if (!depIds) { sendJSON({}); break; }
                try {
                    const ids = depIds.split(',').filter(Boolean);
                    if (ids.length === 0) { sendJSON({}); break; }
                    const result = {};
                    try {
                        const batchIds = JSON.stringify(ids);
                        const projects = await cachedFetchJSON(`${MODRINTH_API}/projects?ids=${encodeURIComponent(batchIds)}`, 300000);
                        if (Array.isArray(projects)) {
                            for (const project of projects) {
                                result[project.id] = {
                                    id: project.id,
                                    title: project.title || project.id,
                                    icon: project.icon_url || '',
                                    description: (project.description || '').substring(0, 100),
                                    downloads: project.downloads || 0
                                };
                            }
                        }
                        for (const pid of ids) {
                            if (!result[pid]) {
                                result[pid] = { id: pid, title: pid, icon: '', description: '', downloads: 0 };
                            }
                        }
                    } catch (batchErr) {
                        await Promise.all(ids.map(async (pid) => {
                            try {
                                const project = await cachedFetchJSON(`${MODRINTH_API}/project/${pid}`, 300000);
                                result[pid] = {
                                    id: project.id,
                                    title: project.title || pid,
                                    icon: project.icon_url || '',
                                    description: (project.description || '').substring(0, 100),
                                    downloads: project.downloads || 0
                                };
                            } catch (e) {
                                result[pid] = { id: pid, title: pid, icon: '', description: '', downloads: 0 };
                            }
                        }));
                    }
                    sendJSON(result);
                } catch (e) { sendJSON({}); }
                break;
            }

            case '/api/mods/resolve-deps-versions': {
                const rdvData = await readBody();
                const rdvIds = rdvData.ids || [];
                const rdvGameVersion = rdvData.gameVersion || '';
                const rdvLoader = rdvData.loader || '';
                const rdvSource = rdvData.source || 'modrinth';
                if (!rdvIds.length) { sendJSON({}); break; }
                try {
                    const result = {};
                    let projectMap = {};
                    try {
                        const batchIds = JSON.stringify(rdvIds);
                        const projects = await cachedFetchJSON(`${MODRINTH_API}/projects?ids=${encodeURIComponent(batchIds)}`, 300000);
                        if (Array.isArray(projects)) {
                            for (const p of projects) {
                                projectMap[p.id] = p;
                            }
                        }
                    } catch (batchErr) {
                        const projectResults = await Promise.allSettled(rdvIds.map(pid => cachedFetchJSON(`${MODRINTH_API}/project/${pid}`, 300000)));
                        for (let i = 0; i < rdvIds.length; i++) {
                            if (projectResults[i].status === 'fulfilled') {
                                projectMap[rdvIds[i]] = projectResults[i].value;
                            }
                        }
                    }
                    const versionParams = [];
                    if (rdvGameVersion) versionParams.push(`game_versions=["${rdvGameVersion}"]`);
                    if (rdvLoader) versionParams.push(`loaders=["${rdvLoader}"]`);
                    const versionQueryString = versionParams.length > 0 ? '?' + versionParams.join('&') : '';
                    const versionResults = await Promise.allSettled(rdvIds.map(pid =>
                        cachedFetchJSON(`${MODRINTH_API}/project/${pid}/version${versionQueryString}`, 120000)
                    ));
                    for (let i = 0; i < rdvIds.length; i++) {
                        const pid = rdvIds[i];
                        const project = projectMap[pid];
                        const versionsRes = versionResults[i];
                        try {
                            const versions = versionsRes.status === 'fulfilled' ? versionsRes.value : [];
                            let compatibleVersion = null;
                            if (rdvGameVersion || rdvLoader) {
                                const filtered = (versions || []).filter(v => {
                                    const gv = v.game_versions || [];
                                    const loaders = (v.loaders || []).map(l => l.toLowerCase());
                                    let match = true;
                                    if (rdvGameVersion && !gv.includes(rdvGameVersion)) match = false;
                                    if (rdvLoader && !loaders.includes(rdvLoader.toLowerCase())) match = false;
                                    return match;
                                });
                                compatibleVersion = filtered[0] || null;
                            } else {
                                compatibleVersion = versions?.[0] || null;
                            }
                            result[pid] = {
                                id: project?.id || pid,
                                title: project?.title || pid,
                                icon: project?.icon_url || '',
                                description: (project?.description || '').substring(0, 100),
                                downloads: project?.downloads || 0,
                                hasCompatibleVersion: !!compatibleVersion,
                                versionId: compatibleVersion?.id || '',
                                versionNumber: compatibleVersion?.version_number || '',
                                fileName: compatibleVersion?.files?.find(f => f.primary)?.filename || compatibleVersion?.files?.[0]?.filename || '',
                                gameVersions: compatibleVersion?.game_versions || [],
                                loaders: compatibleVersion?.loaders || []
                            };
                        } catch (e) {
                            result[pid] = {
                                id: pid, title: pid, icon: '', description: '', downloads: 0,
                                hasCompatibleVersion: false, versionId: '', versionNumber: '',
                                fileName: '', gameVersions: [], loaders: []
                            };
                        }
                    }
                    sendJSON(result);
                } catch (e) { sendJSON({}); }
                break;
            }

            case '/api/mods/categories': {
                const catSource = parsedUrl.query.source || 'modrinth';
                try {
                    if (catSource === 'modrinth') {
                        const tags = await fetchJSON(`${MODRINTH_API}/tag/category`);
                        const categories = tags.filter(t => t.project_type === 'mod').map(t => ({
                            name: t.name,
                            icon: t.icon || ''
                        }));
                        sendJSON({ categories });
                    } else {
                        sendJSON({ categories: [] });
                    }
                } catch (e) {
                    sendJSON({ categories: [] });
                }
                break;
            }

            case '/api/mods/featured': {
                const ftLoader = parsedUrl.query.loader || '';
                const ftVersion = parsedUrl.query.gameVersion || '';
                try {
                    const facets = [['project_type:mod']];
                    if (ftLoader) facets.push([`categories:${ftLoader}`]);
                    if (ftVersion) facets.push([`versions:${ftVersion}`]);
                    let featUrl = `${MODRINTH_API}/search?query=&index=downloads&limit=10&offset=0`;
                    featUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;
                    const result = await fetchJSON(featUrl);
                    const hits = (result.hits || []).map(hit => ({
                        id: hit.project_id, slug: hit.slug, title: hit.title,
                        description: hit.description || '', icon: hit.icon_url || '',
                        downloads: hit.downloads || 0, author: (hit.author || '').replace(/_/g, ''),
                        categories: hit.categories || [], source: 'modrinth'
                    }));
                    sendJSON({ hits });
                } catch (e) {
                    sendJSON({ hits: [] });
                }
                break;
            }

            case '/api/favorites': {
                console.log('[Fav] GET /api/favorites hit');
                sendJSON(loadFavorites());
                break;
            }

            case '/api/favorites/create': {
                const body = await readBody();
                if (!body.name) { sendError('Missing name', 400); break; }
                const favorites = loadFavorites();
                const newFav = { name: body.name, id: generateUUID(), favs: [], notes: {} };
                favorites.push(newFav);
                saveFavorites(favorites);
                sendJSON({ success: true, favorite: newFav });
                break;
            }

            case '/api/favorites/rename': {
                const body = await readBody();
                if (!body.id || !body.name) { sendError('Missing id or name', 400); break; }
                const favorites = loadFavorites();
                const fav = favorites.find(f => f.id === body.id);
                if (!fav) { sendError('收藏夹不存在', 404); break; }
                fav.name = body.name;
                saveFavorites(favorites);
                sendJSON({ success: true });
                break;
            }

            case '/api/favorites/delete': {
                const body = await readBody();
                if (!body.id) { sendError('Missing id', 400); break; }
                const favorites = loadFavorites();
                if (favorites.length <= 1) { sendError('至少保留一个收藏夹', 400); break; }
                const idx = favorites.findIndex(f => f.id === body.id);
                if (idx < 0) { sendError('收藏夹不存在', 404); break; }
                favorites.splice(idx, 1);
                saveFavorites(favorites);
                sendJSON({ success: true });
                break;
            }

            case '/api/favorites/add': {
                const body = await readBody();
                if (!body.favId || !body.projectId) { sendError('Missing favId or projectId', 400); break; }
                const favorites = loadFavorites();
                const fav = favorites.find(f => f.id === body.favId);
                if (!fav) { sendError('收藏夹不存在', 404); break; }
                if (!fav.favs.includes(body.projectId)) fav.favs.push(body.projectId);
                saveFavorites(favorites);
                sendJSON({ success: true });
                break;
            }

            case '/api/favorites/remove': {
                const body = await readBody();
                if (!body.favId || !body.projectId) { sendError('Missing favId or projectId', 400); break; }
                const favorites = loadFavorites();
                const fav = favorites.find(f => f.id === body.favId);
                if (!fav) { sendError('收藏夹不存在', 404); break; }
                fav.favs = fav.favs.filter(id => id !== body.projectId);
                saveFavorites(favorites);
                sendJSON({ success: true });
                break;
            }

            case '/api/favorites/note': {
                const body = await readBody();
                if (!body.favId || !body.projectId) { sendError('Missing favId or projectId', 400); break; }
                const favorites = loadFavorites();
                const fav = favorites.find(f => f.id === body.favId);
                if (!fav) { sendError('收藏夹不存在', 404); break; }
                if (!fav.notes) fav.notes = {};
                if (body.note) fav.notes[body.projectId] = body.note;
                else delete fav.notes[body.projectId];
                saveFavorites(favorites);
                sendJSON({ success: true });
                break;
            }

            case '/api/favorites/export': {
                const exportId = parsedUrl.query.id;
                const favorites = loadFavorites();
                if (exportId) {
                    const fav = favorites.find(f => f.id === exportId);
                    if (fav) sendJSON({ success: true, data: fav.favs });
                    else sendError('收藏夹不存在', 404);
                } else {
                    sendJSON({ success: true, data: favorites });
                }
                break;
            }

            case '/api/favorites/import': {
                const body = await readBody();
                if (!body.data) { sendError('Missing data', 400); break; }
                const favorites = loadFavorites();
                let ids = [];
                if (Array.isArray(body.data)) ids = body.data;
                else if (typeof body.data === 'string') {
                    try {
                        const parsed = JSON.parse(body.data);
                        ids = Array.isArray(parsed) ? parsed : Object.keys(parsed).filter(k => parsed[k]);
                    } catch (e) {}
                }
                if (ids.length === 0) { sendError('无有效数据', 400); break; }
                let target = body.targetFavId ? favorites.find(f => f.id === body.targetFavId) : favorites[0];
                if (!target) target = favorites[0];
                ids.forEach(id => { if (!target.favs.includes(id)) target.favs.push(id); });
                saveFavorites(favorites);
                sendJSON({ success: true, imported: ids.length });
                break;
            }

            case '/api/favorites/check': {
                const checkId = parsedUrl.query.projectId;
                if (!checkId) { sendError('Missing projectId', 400); break; }
                const favorites = loadFavorites();
                const result = {};
                favorites.forEach(f => { result[f.id] = f.favs.includes(checkId); });
                sendJSON({ success: true, result });
                break;
            }

            case '/api/resources/search': {
                const resQuery = parsedUrl.query.query || '';
                const resType = parsedUrl.query.type || 'modpack';
                const resLoader = parsedUrl.query.loader || '';
                const resVersion = parsedUrl.query.version || '';
                const resCategory = parsedUrl.query.category || '';
                const resSort = parsedUrl.query.sort || 'downloads';
                const resLimit = parseInt(parsedUrl.query.limit || '15', 10);
                const resOffset = parseInt(parsedUrl.query.offset || '0', 10);

                try {
                    const facets = [[`project_type:${resType}`]];
                    if (resLoader) facets.push([`categories:${resLoader}`]);
                    if (resVersion) facets.push([`versions:${resVersion}`]);
                    if (resCategory) facets.push([`categories:${resCategory}`]);

                    const sortMap = { relevance: 'relevance', downloads: 'downloads', newest: 'newest', updated: 'updated' };
                    const sortField = sortMap[resSort] || (resQuery ? 'relevance' : 'downloads');

                    let searchUrl = `${MODRINTH_API}/search?query=${encodeURIComponent(resQuery)}&index=${sortField}&limit=${resLimit}&offset=${resOffset}`;
                    searchUrl += `&facets=${encodeURIComponent(JSON.stringify(facets))}`;

                    const result = await cachedFetchJSON(searchUrl, 60000);
                    const hits = (result.hits || []).map(hit => ({
                        id: hit.project_id, slug: hit.slug, title: hit.title,
                        description: hit.description || '', author: (hit.author || '').replace(/_/g, ''),
                        icon: hit.icon_url || '', downloads: hit.downloads || 0, followers: hit.followers || 0,
                        categories: hit.categories || [], versions: hit.versions || [],
                        dateCreated: hit.date_created || '', dateModified: hit.date_modified || '',
                        source: 'modrinth', projectType: resType
                    }));
                    sendJSON({ hits, total: result.total_hits || hits.length, offset: resOffset });
                } catch (e) {
                    sendError('搜索失败: ' + e.message);
                }
                break;
            }

            case '/api/resources/detail': {
                const resProjectId = parsedUrl.query.projectId;
                if (!resProjectId) { sendError('Missing projectId', 400); break; }
                try {
                    const project = await cachedFetchJSON(`${MODRINTH_API}/project/${resProjectId}`, 300000);
                    const detail = {
                        id: project.id, slug: project.slug, title: project.title,
                        description: project.description || '', body: project.body || '',
                        icon: project.icon_url || '', downloads: project.downloads || 0,
                        followers: project.followers || 0, categories: project.categories || [],
                        loaders: project.loaders || [], gameVersions: project.game_versions || [],
                        license: project.license?.name || '', sourceUrl: project.source_url || '',
                        dateCreated: project.published || '', dateModified: project.updated || '',
                        gallery: (project.gallery || []).map(g => typeof g === 'string' ? g : g.url || ''),
                        source: 'modrinth', projectType: project.project_type || ''
                    };
                    sendJSON(detail);
                } catch (e) {
                    sendError('获取详情失败: ' + e.message);
                }
                break;
            }

            case '/api/resources/versions': {
                const rvProjectId = parsedUrl.query.projectId;
                const rvLoader = parsedUrl.query.loader || '';
                const rvGameVer = parsedUrl.query.gameVersion || '';
                if (!rvProjectId) { sendError('Missing projectId', 400); break; }
                try {
                    let versionUrl = `${MODRINTH_API}/project/${rvProjectId}/version`;
                    const params = [];
                    if (rvLoader) params.push(`loaders=["${rvLoader}"]`);
                    if (rvGameVer) params.push(`game_versions=["${rvGameVer}"]`);
                    if (params.length > 0) versionUrl += '?' + params.join('&');

                    const versions = await cachedFetchJSON(versionUrl, 600000);
                    const result = (versions || []).map(v => ({
                        id: v.id, versionNumber: v.version_number || '',
                        versionName: v.name || v.version_number || '',
                        gameVersions: v.game_versions || [], loaders: v.loaders || [],
                        releaseType: v.version_type || 'release',
                        datePublished: v.date_published || '', downloads: v.downloads || 0,
                        changelog: v.changelog || '',
                        files: (v.files || []).map(f => ({
                            url: f.url, filename: f.filename, size: f.size || 0,
                            primary: f.primary || false, sha1: f.hashes?.sha1 || ''
                        })),
                        dependencies: (v.dependencies || []).map(d => ({
                            projectId: d.project_id, versionId: d.version_id,
                            dependencyType: d.dependency_type
                        }))
                    }));
                    sendJSON({ versions: result });
                } catch (e) {
                    sendError('获取版本列表失败: ' + e.message);
                }
                break;
            }

            case '/api/resources/download': {
                const rdData = await readBody();
                const rdVersionId = rdData.versionId;
                const rdProjectId = rdData.projectId;
                const rdType = rdData.projectType || 'mod';
                const rdSavePath = rdData.savePath || '';

                if (!rdVersionId && !rdProjectId) { sendError('Missing versionId or projectId', 400); break; }

                const settings = loadSettingsCached();
                let destDir;

                let targetVersionId = rdData.targetVersionId || '';
                if (!targetVersionId && rdType !== 'modpack') {
                    targetVersionId = settings.selectedVersion || '';
                }

                if (rdSavePath) {
                    destDir = rdSavePath;
                } else if (rdType === 'modpack') {
                    destDir = path.join(DATA_DIR, 'modpacks');
                } else if (rdType === 'resourcepack') {
                    destDir = targetVersionId ? getVersionSubDir(targetVersionId, 'resourcepacks') : null;
                    if (!destDir) destDir = path.join(DATA_DIR, 'resourcepacks');
                } else if (rdType === 'shader') {
                    destDir = targetVersionId ? getVersionSubDir(targetVersionId, 'shaderpacks') : null;
                    if (!destDir) destDir = path.join(DATA_DIR, 'shaderpacks');
                } else if (rdType === 'datapack') {
                    destDir = targetVersionId ? getVersionSubDir(targetVersionId, 'datapacks') : null;
                    if (!destDir) destDir = path.join(DATA_DIR, 'datapacks');
                } else {
                    destDir = getVersionModsDir(targetVersionId);
                    if (!destDir) {
                        sendError('请先安装一个游戏版本'); break;
                    }
                }
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                try {
                    let downloadUrl = null;
                    let fileName = null;
                    let fileSize = 0;
                    let mcVersion = '';
                    let packName = '';

                    let versionData;
                    if (rdVersionId) {
                        versionData = await fetchJSON(`${MODRINTH_API}/version/${rdVersionId}`);
                    } else {
                        const versions = await fetchJSON(`${MODRINTH_API}/project/${rdProjectId}/version?limit=1`);
                        versionData = versions?.[0];
                    }

                    if (!versionData) { sendError('未找到版本信息，请检查网络连接或稍后重试'); break; }
                    
                    console.log('[Download] Version data:', JSON.stringify(versionData).substring(0, 500));

                    const primaryFile = versionData.files?.find(f => f.primary) || versionData.files?.[0];
                    if (!primaryFile) { 
                        console.error('[Download] No files in version data, files:', versionData.files);
                        sendError('未找到下载文件，该版本可能已被下架或不存在'); 
                        break; 
                    }

                    downloadUrl = primaryFile.url;
                    fileName = primaryFile.filename;
                    fileSize = primaryFile.size || 0;

                    if (!downloadUrl) {
                        console.error('[Download] File URL is empty, file data:', JSON.stringify(primaryFile));
                        sendError('下载链接为空，该资源可能暂时不可用');
                        break;
                    }

                    // 获取整合包的 Minecraft 版本信息
                    if (rdType === 'modpack') {
                        mcVersion = versionData.game_versions?.[0] || '';
                        const projectInfo = await fetchJSON(`${MODRINTH_API}/project/${rdProjectId}`).catch(() => null);
                        packName = projectInfo?.title || rdProjectId;
                    }

                    const safeName = (fileName || `${rdProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
                    const destPath = path.join(destDir, safeName);

                    const sessionId = `res-${Date.now()}`;
                    const abortController = new AbortController();
                    modDownloadSessions.set(sessionId, {
                        status: 'downloading', progress: 0, message: '下载中..',
                        fileName: safeName, totalSize: fileSize, downloaded: 0,
                        downloadSpeed: 0, bytesDownloaded: 0,
                        projectType: rdType, projectId: rdProjectId, packName, mcVersion,
                        phase: 'download', currentFile: safeName, files: [{ name: safeName, status: 'downloading', progress: 0, size: fileSize }],
                        _abortController: abortController
                    });

                    sendJSON({ success: true, sessionId, fileName: safeName });

                    (async () => {
                        try {
                            await downloadFileChunked(downloadUrl, destPath, {
                                onProgress: (p) => {
                                    const session = modDownloadSessions.get(sessionId);
                                    if (session) {
                                        if (session.status === 'cancelled') {
                                            session._abortController?.abort();
                                            throw new Error('下载已取消');
                                        }
                                        session.progress = rdType === 'modpack' ? Math.round(p.progress * 0.45) : Math.round(p.progress);
                                        session.downloadSpeed = p.speed || 0;
                                        session.bytesDownloaded = p.bytesDownloaded || 0;
                                        session.totalSize = p.totalBytes || fileSize;
                                        session.message = `下载 ${safeName} ${p.progress.toFixed(0)}%`;
                                        session.currentFile = safeName;
                                        session.phase = 'download';
                                        if (session.files && session.files[0]) {
                                            session.files[0].progress = Math.round(p.progress);
                                            session.files[0].status = 'downloading';
                                            session.files[0].size = p.totalBytes || fileSize;
                                        }
                                    }
                                },
                                retries: 2,
                                abortSignal: abortController.signal,
                                timeout: 300000
                            });

                            const sessionBeforeImport = modDownloadSessions.get(sessionId);
                            if (sessionBeforeImport && sessionBeforeImport.status === 'cancelled') {
                                try { fs.unlinkSync(destPath); } catch (e) {}
                                return;
                            }

                            if (rdType === 'modpack' && (safeName.endsWith('.mrpack') || safeName.endsWith('.zip'))) {
                                try {
                                    const session = modDownloadSessions.get(sessionId);
                                    if (session) {
                                        if (session.status === 'cancelled') {
                                            try { fs.unlinkSync(destPath); } catch (e) {}
                                            return;
                                        }
                                        session.progress = 45;
                                        session.message = '正在解析整合包...';
                                        session.phase = 'install';
                                        if (session.files && session.files[0]) {
                                            session.files[0].status = 'completed';
                                            session.files[0].progress = 100;
                                        }
                                    }

                                    const importResult = await importModpackFromPath(destPath, (p) => {
                                        const s = modDownloadSessions.get(sessionId);
                                        if (s) {
                                            if (s.status === 'cancelled') return;
                                            const np = 45 + Math.round(p.progress * 0.55);
                                            s.progress = Math.max(s.progress || 0, np);
                                            s.message = p.message || '安装中...';
                                            s.phase = p.stage || 'install';
                                            s.currentFile = p.currentFile || '';
                                            if (p.files && p.files.length > 0) s.files = p.files;
                                        }
                                    }, rdType === 'modpack' ? '' : targetVersionId, abortController.signal);

                                    const s = modDownloadSessions.get(sessionId);
                                    if (s && s.status === 'cancelled') {
                                        try { fs.unlinkSync(destPath); } catch (e) {}
                                        return;
                                    }

                                    if (importResult.success) {
                                        if (s) {
                                            s.status = 'completed'; s.progress = 100;
                                            s.message = `整合包 "${importResult.name || packName}" 安装完成！`;
                                            if (importResult.warning) s.warning = importResult.warning;
                                        }
                                        try { fs.unlinkSync(destPath); } catch (e) {}
                                    } else {
                                        if (s) {
                                            s.status = 'failed'; s.progress = 100;
                                            s.message = `整合包导入失败: ${importResult.error || '未知错误'}`;
                                            console.error('[Modpack] importModpackFromPath failed:', importResult.error, 'versionId:', importResult.versionId);
                                        }
                                        try { fs.unlinkSync(destPath); } catch (e) {}
                                    }
                                } catch (e2) {
                                    console.error('[Modpack] importModpackFromPath error:', e2.stack || e2.message || e2);
                                    const s = modDownloadSessions.get(sessionId);
                                    if (s) { s.status = 'failed'; s.progress = 100; s.message = `整合包导入异常: ${e2.message || e2}`; }
                                    try { fs.unlinkSync(destPath); } catch (e) {}
                                }
                            } else {
                                const session = modDownloadSessions.get(sessionId);
                                if (session) { session.status = 'completed'; session.progress = 100; session.message = `${safeName} 下载完成！`; }
                            }
                        } catch (e) {
                            const session = modDownloadSessions.get(sessionId);
                            if (session) {
                                if (session.status === 'cancelled') {
                                    try { fs.unlinkSync(destPath); } catch (ex) {}
                                } else {
                                    session.status = 'failed'; session.progress = 100;
                                    session.message = `下载整合包文件失败: ${e.message}`;
                                    console.error('[Modpack] Download failed:', e.message, 'url:', downloadUrl);
                                }
                            }
                        }
                    })();
                } catch (e) {
                    console.error('[Modpack] Request error:', e.stack || e.message || e);
                    sendError('下载失败: ' + e.message);
                }
                break;
            }

            case '/api/optifine/versions': {
                const ofGameVer = parsedUrl.query.game;
                if (!ofGameVer) { sendError('Missing game parameter', 400); break; }
                try {
                    const ofData = await fetchJSON(`https://optifine.net/downloads?f=${ofGameVer}`);
                    const regex = new RegExp(`OptiFine_${ofGameVer.replace(/\./g, '\\.')}_(HD_U_[A-Za-z0-9]+)\\.jar`, 'g');
                    const versions = [];
                    let match;
                    const pageHtml = ofData;
                    while ((match = regex.exec(pageHtml)) !== null) {
                        versions.push({ version: match[1], gameVersion: ofGameVer });
                    }
                    if (versions.length === 0) {
                        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                        for (let i = letters.length - 1; i >= 0; i--) {
                            versions.push({ version: `HD_U_${letters[i]}`, gameVersion: ofGameVer });
                        }
                    }
                    sendJSON({ versions: versions.slice(0, 10) });
                } catch (e) {
                    sendJSON({ versions: [{ version: 'HD_U_Z', gameVersion: ofGameVer }] });
                }
                break;
            }

            case '/api/optifine/install': {
                const ofData2 = await readBody();
                const ofGameVer2 = ofData2.gameVersion;
                const ofType = ofData2.optifineType || 'HD_U_Z';
                if (!ofGameVer2) { sendError('Missing gameVersion', 400); break; }

                const ofVersionId = `OptiFine_${ofGameVer2}_${ofType}`;
                try {
                    const ofJarUrl = `https://optifine.net/downloadx?f=OptiFine_${ofGameVer2}_${ofType}.jar&k=`;
                    const ofInstallerPath = path.join(DATA_DIR, 'temp', `optifine-installer-${ofGameVer2}-${ofType}.jar`);
                    if (!fs.existsSync(path.dirname(ofInstallerPath))) fs.mkdirSync(path.dirname(ofInstallerPath), { recursive: true });

                    await downloadFile(ofJarUrl, ofInstallerPath, null, 2);

                    const ofVersionDir = path.join(VERSIONS_DIR, ofVersionId);
                    if (!fs.existsSync(ofVersionDir)) fs.mkdirSync(ofVersionDir, { recursive: true });

                    let ofVersionJson = null;
                    try {
                        const AdmZip = require('adm-zip');
                        const ofZip = new AdmZip(ofInstallerPath);
                        const ofEntry = ofZip.getEntry('version.json') || ofZip.getEntry(`${ofVersionId}.json`);
                        if (ofEntry) {
                            ofVersionJson = JSON.parse(ofEntry.getData().toString('utf8'));
                        }
                    } catch (e) {}

                    if (ofVersionJson) {
                        ofVersionJson.id = ofVersionId;
                        ofVersionJson.inheritsFrom = ofGameVer2;
                        if (!ofVersionJson.type) ofVersionJson.type = 'release';

                        for (const lib of (ofVersionJson.libraries || [])) {
                            if (lib.downloads?.artifact?.url) {
                                const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                                if (!fs.existsSync(libPath)) {
                                    try { await downloadFile(lib.downloads.artifact.url, libPath); } catch (e) {}
                                }
                            }
                        }

                        const ofLibName = `optifine:OptiFine:${ofGameVer2}_${ofType}`;
                        const ofLibPath = path.join(LIBRARIES_DIR, 'optifine', 'OptiFine', `${ofGameVer2}_${ofType}`, `OptiFine-${ofGameVer2}_${ofType}.jar`);
                        if (!fs.existsSync(path.dirname(ofLibPath))) fs.mkdirSync(path.dirname(ofLibPath), { recursive: true });
                        fs.copyFileSync(ofInstallerPath, ofLibPath);

                        if (!ofVersionJson.libraries) ofVersionJson.libraries = [];
                        ofVersionJson.libraries.push({
                            name: ofLibName,
                            downloads: { artifact: { path: `optifine/OptiFine/${ofGameVer2}_${ofType}/OptiFine-${ofGameVer2}_${ofType}.jar` } }
                        });

                        const jsonPath = path.join(ofVersionDir, `${ofVersionId}.json`);
                        fs.writeFileSync(jsonPath, JSON.stringify(ofVersionJson, null, 2));
                    } else {
                        const fallbackJson = {
                            id: ofVersionId, inheritsFrom: ofGameVer2,
                            mainClass: 'net.minecraft.client.main.Main', type: 'release',
                            libraries: [], arguments: { game: [], jvm: [] }
                        };
                        const ofLibPath = path.join(LIBRARIES_DIR, 'optifine', 'OptiFine', `${ofGameVer2}_${ofType}`, `OptiFine-${ofGameVer2}_${ofType}.jar`);
                        if (!fs.existsSync(path.dirname(ofLibPath))) fs.mkdirSync(path.dirname(ofLibPath), { recursive: true });
                        fs.copyFileSync(ofInstallerPath, ofLibPath);
                        const jsonPath = path.join(ofVersionDir, `${ofVersionId}.json`);
                        fs.writeFileSync(jsonPath, JSON.stringify(fallbackJson, null, 2));
                    }

                    try { fs.unlinkSync(ofInstallerPath); } catch (e) {}
                    sendJSON({ success: true, versionId: ofVersionId });
                } catch (e) {
                    sendError('OptiFine安装失败: ' + e.message);
                }
                break;
            }

            case '/api/authlib-injector/info': {
                try {
                    const aiData = await fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                    sendJSON({
                        version: aiData.version || 'unknown',
                        downloadUrl: aiData.download_url || '',
                        size: aiData.size || 0
                    });
                } catch (e) {
                    sendError('获取authlib-injector信息失败');
                }
                break;
            }

            case '/api/authlib-injector/download': {
                const aiDir = path.join(DATA_DIR, 'authlib-injector');
                if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir, { recursive: true });
                try {
                    const aiData2 = await fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                    const aiUrl = aiData2.download_url;
                    const aiPath = path.join(aiDir, `authlib-injector-${aiData2.version}.jar`);
                    if (!fs.existsSync(aiPath)) {
                        await downloadFile(aiUrl, aiPath);
                    }
                    sendJSON({ success: true, path: aiPath, version: aiData2.version });
                } catch (e) {
                    sendError('下载authlib-injector失败: ' + e.message);
                }
                break;
            }

            case '/api/accounts/thirdparty-verify': {
                const verifyUrl = parsedUrl.query.serverUrl;
                if (!verifyUrl) { sendError('Missing serverUrl', 400); break; }
                try {
                    let apiUrl = verifyUrl.replace(/\/$/, '');
                    const info = await fetchJSON(apiUrl);
                    const meta = {
                        serverName: info.meta?.serverName || info.serverName || '未知',
                        implementationName: info.meta?.implementationName || info.implementationName || '',
                        implementationVersion: info.meta?.implementationVersion || '',
                        serverIcon: info.meta?.serverIcon || info.icon || ''
                    };
                    sendJSON({ success: true, meta });
                } catch (e) {
                    sendJSON({ success: false, error: '无法连接到认证服务器' });
                }
                break;
            }

            case '/api/accounts/thirdparty-login': {
                const tlData = await readBody();
                const tlServerUrl = tlData.serverUrl;
                const tlUsername = tlData.username;
                const tlPassword = tlData.password;
                if (!tlServerUrl || !tlUsername || !tlPassword) {
                    sendError('Missing required fields', 400); break;
                }

                try {
                    let apiUrl = tlServerUrl.replace(/\/$/, '');
                    const authUrl = `${apiUrl}/authserver/authenticate`;

                    const authPayload = JSON.stringify({
                        username: tlUsername,
                        password: tlPassword,
                        requestUser: true,
                        agent: { name: 'Minecraft', version: 1 }
                    });

                    const authResult = await new Promise((resolve, reject) => {
                        const parsedUrl2 = new URL(authUrl);
                        const postData2 = authPayload;
                        const req = https.request({
                            hostname: parsedUrl2.hostname,
                            port: parsedUrl2.port || 443,
                            path: parsedUrl2.pathname + parsedUrl2.search,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(postData2)
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(new Error('Invalid response')); }
                            });
                        });
                        req.on('error', reject);
                        req.write(postData2);
                        req.end();
                    });

                    if (authResult.error) {
                        sendJSON({ success: false, error: authResult.errorMessage || authResult.error || '认证失败' });
                        break;
                    }

                    if (!authResult.accessToken) {
                        sendJSON({ success: false, error: '认证服务器未返回访问令牌' });
                        break;
                    }

                    let profile = authResult.selectedProfile;
                    const availableProfiles = authResult.availableProfiles || [];

                    if (!profile && availableProfiles.length === 0) {
                        sendJSON({ success: false, error: '未找到游戏角色，请先在皮肤站创建角色' });
                        break;
                    }

                    if (!profile && availableProfiles.length > 1) {
                        sendJSON({
                            success: false,
                            needSelectProfile: true,
                            accessToken: authResult.accessToken,
                            clientToken: authResult.clientToken,
                            serverUrl: tlServerUrl,
                            availableProfiles: availableProfiles.map(p => ({
                                id: p.id,
                                name: p.name,
                                skinUrl: `https://mc-heads.net/avatar/${p.id.replace(/-/g, '')}/64`
                            }))
                        });
                        break;
                    }

                    if (!profile && availableProfiles.length === 1) {
                        profile = availableProfiles[0];
                    }
                    let refreshResult = null;
                    try {
                        const refreshUrl = `${apiUrl}/authserver/refresh`;
                        const refreshPayload = JSON.stringify({
                            accessToken: authResult.accessToken,
                            clientToken: authResult.clientToken,
                            selectedProfile: profile,
                            requestUser: true
                        });
                        refreshResult = await new Promise((resolve, reject) => {
                            const rParsedUrl = new URL(refreshUrl);
                            const req = https.request({
                                hostname: rParsedUrl.hostname,
                                port: rParsedUrl.port || 443,
                                path: rParsedUrl.pathname + rParsedUrl.search,
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Content-Length': Buffer.byteLength(refreshPayload)
                                }
                            }, (res) => {
                                let data = '';
                                res.on('data', chunk => data += chunk);
                                res.on('end', () => {
                                    try { resolve(JSON.parse(data)); }
                                    catch (e) { reject(e); }
                                });
                            });
                            req.on('error', reject);
                            req.write(refreshPayload);
                            req.end();
                        });
                        if (refreshResult.accessToken) {
                            authResult.accessToken = refreshResult.accessToken;
                            if (refreshResult.selectedProfile) {
                                profile = refreshResult.selectedProfile;
                            }
                        }
                    } catch (e) {
                        console.log('[ThirdParty] refresh失败，使用原始token:', e.message);
                    }

                    if (!profile) {
                        sendJSON({ success: false, error: '未找到游戏角色，请先在皮肤站创建角色' });
                        break;
                    }

                    console.log(`[ThirdParty] 登录成功: ${profile.name} (${profile.id})`);
                    const extractedSkinUrl = extractSkinUrlFromAuthResult(refreshResult || authResult) || extractSkinUrlFromAuthResult(authResult);
                    if (extractedSkinUrl) {
                        console.log(`[ThirdParty] 从登录响应提取到皮肤URL: ${extractedSkinUrl.substring(0, 60)}...`);
                    }
                    const aiDir2 = path.join(DATA_DIR, 'authlib-injector');
                    const aiFiles = fs.existsSync(aiDir2) ? fs.readdirSync(aiDir2).filter(f => f.endsWith('.jar')) : [];
                    if (aiFiles.length === 0) {
                        try {
                            const aiData2 = await fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                            const aiUrl = aiData2.download_url;
                            if (!fs.existsSync(aiDir2)) fs.mkdirSync(aiDir2, { recursive: true });
                            const aiPath = path.join(aiDir2, `authlib-injector-${aiData2.version}.jar`);
                            await downloadFile(aiUrl, aiPath);
                        } catch (e2) {
                            console.log('[Authlib] 下载失败:', e2.message);
                        }
                    }

                    const accounts = loadAccounts();
                    const newAccount = {
                        id: crypto.randomUUID(),
                        username: profile.name,
                        uuid: profile.id,
                        type: 'thirdparty',
                        accessToken: authResult.accessToken,
                        clientToken: authResult.clientToken,
                        serverUrl: tlServerUrl,
                        skinUrl: extractedSkinUrl || null,
                        createdAt: new Date().toISOString()
                    };

                    const existingIdx = accounts.findIndex(a => a.uuid === newAccount.uuid && a.type === 'thirdparty');
                    if (existingIdx >= 0) {
                        accounts[existingIdx] = { ...accounts[existingIdx], ...newAccount };
                    } else {
                        accounts.push(newAccount);
                    }
                    saveAccounts(accounts);

                    const settings = loadSettingsCached();
                    settings.selectedAccount = newAccount.id;
                    saveSettings(settings);

                    sendJSON({ success: true, account: newAccount });
                } catch (e) {
                    sendJSON({ success: false, error: '登录失败: ' + e.message });
                }
                break;
            }

            case '/api/accounts/thirdparty-select-profile': {
                const spData = await readBody();
                const spAccessToken = spData.accessToken;
                const spClientToken = spData.clientToken;
                const spServerUrl = spData.serverUrl;
                const spProfileId = spData.profileId;
                const spProfileName = spData.profileName;
                if (!spAccessToken || !spProfileId || !spServerUrl) {
                    sendError('Missing required fields', 400); break;
                }

                try {
                    let spApiUrl = spServerUrl.replace(/\/$/, '');
                    const refreshUrl = `${spApiUrl}/authserver/refresh`;
                    const refreshPayload = JSON.stringify({
                        accessToken: spAccessToken,
                        clientToken: spClientToken,
                        selectedProfile: { id: spProfileId, name: spProfileName || '' },
                        requestUser: true
                    });

                    const refreshResult = await new Promise((resolve, reject) => {
                        const rParsedUrl = new URL(refreshUrl);
                        const req = https.request({
                            hostname: rParsedUrl.hostname,
                            port: rParsedUrl.port || 443,
                            path: rParsedUrl.pathname + rParsedUrl.search,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': Buffer.byteLength(refreshPayload)
                            }
                        }, (res) => {
                            let data = '';
                            res.on('data', chunk => data += chunk);
                            res.on('end', () => {
                                try { resolve(JSON.parse(data)); }
                                catch (e) { reject(e); }
                            });
                        });
                        req.on('error', reject);
                        req.write(refreshPayload);
                        req.end();
                    });

                    if (refreshResult.error) {
                        sendJSON({ success: false, error: refreshResult.errorMessage || '角色选择失败' });
                        break;
                    }

                    const spProfile = refreshResult.selectedProfile || { id: spProfileId, name: spProfileName || 'Player' };
                    const spNewAccessToken = refreshResult.accessToken || spAccessToken;
                    const spExtractedSkinUrl = extractSkinUrlFromAuthResult(refreshResult);
                    if (spExtractedSkinUrl) {
                        console.log(`[ThirdParty] 从角色选择响应提取到皮肤URL: ${spExtractedSkinUrl.substring(0, 60)}...`);
                    }

                    const aiDir4 = path.join(DATA_DIR, 'authlib-injector');
                    const aiFiles4 = fs.existsSync(aiDir4) ? fs.readdirSync(aiDir4).filter(f => f.endsWith('.jar')) : [];
                    if (aiFiles4.length === 0) {
                        try {
                            const aiData4 = await fetchJSON('https://authlib-injector.yushi.moe/artifact/latest.json');
                            if (!fs.existsSync(aiDir4)) fs.mkdirSync(aiDir4, { recursive: true });
                            const aiPath4 = path.join(aiDir4, `authlib-injector-${aiData4.version}.jar`);
                            await downloadFile(aiData4.download_url, aiPath4);
                        } catch (e4) {}
                    }

                    const accounts = loadAccounts();
                    const newAccount = {
                        id: crypto.randomUUID(),
                        username: spProfile.name,
                        uuid: spProfile.id,
                        type: 'thirdparty',
                        accessToken: spNewAccessToken,
                        clientToken: spClientToken,
                        serverUrl: spServerUrl,
                        skinUrl: spExtractedSkinUrl || null,
                        createdAt: new Date().toISOString()
                    };

                    const existingIdx = accounts.findIndex(a => a.uuid === newAccount.uuid && a.type === 'thirdparty');
                    if (existingIdx >= 0) {
                        accounts[existingIdx] = { ...accounts[existingIdx], ...newAccount };
                    } else {
                        accounts.push(newAccount);
                    }
                    saveAccounts(accounts);

                    const settings = loadSettingsCached();
                    settings.selectedAccount = newAccount.id;
                    saveSettings(settings);

                    sendJSON({ success: true, account: newAccount });
                } catch (e) {
                    sendJSON({ success: false, error: '角色选择失败: ' + e.message });
                }
                break;
            }

            case '/api/game/diagnose': {
                const dgVersionId = parsedUrl.query.versionId;
                const issues = [];

                try {
                    const settings = loadSettingsCached();
                    let javaPath = settings.javaPath;
                    if (!javaPath) {
                        const allJava = [...detectBundledJava(), ...detectSystemJava()];
                        if (allJava.length > 0) javaPath = (allJava.find(j => j.majorVersion >= 17) || allJava[0]).path;
                    }

                    if (!javaPath || !fs.existsSync(javaPath)) {
                        issues.push({ level: 'error', message: '未找到Java运行环境', fix: '请在设置中配置Java路径或安装Java' });
                    } else {
                        try {
                            const verOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                            const verMatch = verOutput.match(/version "([^"]+)"/);
                            if (verMatch) {
                                const ver = verMatch[1];
                                const major = parseInt(ver.startsWith('1.') ? ver.split('.')[1] : ver.split('.')[0], 10);
                                if (dgVersionId && !dgVersionId.includes('forge') && !dgVersionId.includes('fabric')) {
                                    const dgBaseVer = dgVersionId.split('-')[0];
                                    const dgVerParts = dgBaseVer.split('.').map(Number);
                                    const isAtLeast1205 = (dgVerParts[0] || 0) > 1 || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) > 20) || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) === 20 && (dgVerParts[2] || 0) >= 5);
                                    const isAtLeast117 = (dgVerParts[0] || 0) > 1 || ((dgVerParts[0] || 0) === 1 && (dgVerParts[1] || 0) >= 17);
                                    if (isAtLeast1205 && major < 21) {
                                        issues.push({ level: 'error', message: `Minecraft 1.20.5+ 需要Java 21，当前Java版本: ${ver}`, fix: '请安装Java 21或更高版本' });
                                    } else if (isAtLeast117 && major < 16) {
                                        issues.push({ level: 'error', message: `Minecraft 1.17+ 需要Java 16，当前Java版本: ${ver}`, fix: '请安装Java 16或更高版本' });
                                    }
                                }
                                try {
                                    const archOutput = execSync(`"${javaPath}" -XshowSettings:properties -version 2>&1`, { encoding: 'utf8', timeout: 5000 });
                                    if (!archOutput.includes('64') && settings.maxMemory > 1500) {
                                        issues.push({ level: 'warn', message: '32位Java最大只能分配约1.5GB内存', fix: '请安装64位Java或降低内存分配' });
                                    }
                                } catch (archErr) {
                                    issues.push({ level: 'info', message: '无法检测Java架构(32/64位)' });
                                }
                            }
                        } catch (e) {
                            issues.push({ level: 'warn', message: '无法检测Java版本', fix: '请确认Java安装正确' });
                        }
                    }

                    if (dgVersionId) {
                        const versionJson = resolveVersionJson(dgVersionId);
                        if (!versionJson) {
                            issues.push({ level: 'error', message: `版本 ${dgVersionId} 的JSON文件缺失或损坏`, fix: '请重新安装此版本' });
                        } else {
                            if (versionJson.inheritsFrom) {
                                const parentJsonPath = path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.json`);
                                if (!fs.existsSync(parentJsonPath)) {
                                    issues.push({ level: 'error', message: `缺少基础版本 ${versionJson.inheritsFrom}，请先安装`, fix: `安装原版 ${versionJson.inheritsFrom}` });
                                }
                                const parentJarPath = path.join(VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`);
                                if (!fs.existsSync(parentJarPath)) {
                                    issues.push({ level: 'error', message: `缺少基础版本JAR文件`, fix: `重新安装原版 ${versionJson.inheritsFrom}` });
                                }
                            }

                            const mainJar = path.join(VERSIONS_DIR, dgVersionId, `${dgVersionId}.jar`);
                            if (!fs.existsSync(mainJar) && !versionJson.inheritsFrom) {
                                issues.push({ level: 'error', message: '游戏主JAR文件缺失', fix: '请重新安装此版本' });
                            }

                            const missingLibs = [];
                            for (const lib of (versionJson.libraries || [])) {
                                const libNameSuffix = lib.name ? lib.name.split(':').pop() : '';
                                if (libNameSuffix.startsWith('natives-')) continue;
                                if (lib.rules && !evaluateRules(lib.rules)) continue;
                                if (lib.downloads?.artifact) {
                                    const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                                    if (!fs.existsSync(libPath)) {
                                        missingLibs.push(lib.name || lib.downloads.artifact.path);
                                    }
                                }
                            }
                            if (missingLibs.length > 0) {
                                issues.push({ level: 'warn', message: `${missingLibs.length} 个库文件缺失`, fix: '点击修复以重新下载缺失的库文件' });
                            }
                        }
                    }

                    if (settings.maxMemory < 1024) {
                        issues.push({ level: 'warn', message: '分配内存过小（低于1GB），可能导致游戏卡顿', fix: '建议将最大内存设置为2GB以上' });
                    }

                    const totalMem = os.totalmem();
                    if (settings.maxMemory > totalMem / (1024 * 1024) * 0.8) {
                        issues.push({ level: 'warn', message: `分配内存接近系统总内存(${(totalMem / (1024*1024*1024)).toFixed(1)}GB)`, fix: '建议降低内存分配' });
                    }

                    if (issues.length === 0) {
                        issues.push({ level: 'info', message: '未发现明显问题，可以尝试启动游戏', fix: '' });
                    }

                    sendJSON({ issues });
                } catch (e) {
                    sendError('诊断失败: ' + e.message);
                }
                break;
            }

            case '/api/version/repair': {
                const rpData = await readBody();
                const rpVersionId = rpData.versionId;
                if (!rpVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    const versionJson = resolveVersionJson(rpVersionId);
                    if (!versionJson) { sendError('版本JSON文件缺失', 400); break; }

                    let repaired = 0;
                    for (const lib of (versionJson.libraries || [])) {
                        const libNameSuffix = lib.name ? lib.name.split(':').pop() : '';
                        if (libNameSuffix.startsWith('natives-')) continue;
                        if (lib.rules && !evaluateRules(lib.rules)) continue;
                        if (lib.downloads?.artifact?.url) {
                            const libPath = path.join(LIBRARIES_DIR, lib.downloads.artifact.path);
                            if (!fs.existsSync(libPath)) {
                                try {
                                    await downloadFile(lib.downloads.artifact.url, libPath);
                                    repaired++;
                                } catch (e) {}
                            }
                        }
                    }

                    if (versionJson.downloads?.client?.url) {
                        const jarPath = path.join(VERSIONS_DIR, rpVersionId, `${rpVersionId}.jar`);
                        if (!fs.existsSync(jarPath)) {
                            await downloadFile(versionJson.downloads.client.url, jarPath);
                            repaired++;
                        }
                    }

                    sendJSON({ success: true, repaired });
                } catch (e) {
                    sendError('修复失败: ' + e.message);
                }
                break;
            }

            case '/api/version/cleanup': {
                const clVersionId = parsedUrl.query.versionId;
                if (!clVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    let freedSpace = 0;
                    const nativesDir = path.join(VERSIONS_DIR, clVersionId, 'natives');
                    if (fs.existsSync(nativesDir)) {
                        const size = getDirSize(nativesDir);
                        fs.rmSync(nativesDir, { recursive: true, force: true });
                        freedSpace += size;
                    }

                    const logFiles = path.join(VERSIONS_DIR, clVersionId, 'logs');
                    if (fs.existsSync(logFiles)) {
                        const size = getDirSize(logFiles);
                        fs.rmSync(logFiles, { recursive: true, force: true });
                        freedSpace += size;
                    }

                    const crashReports = path.join(VERSIONS_DIR, clVersionId, 'crash-reports');
                    if (fs.existsSync(crashReports)) {
                        const size = getDirSize(crashReports);
                        fs.rmSync(crashReports, { recursive: true, force: true });
                        freedSpace += size;
                    }

                    sendJSON({ success: true, freedSpace: formatSize(freedSpace) });
                } catch (e) {
                    sendError('清理失败: ' + e.message);
                }
                break;
            }

            case '/api/version/diagnose': {
                const diagVersionId = parsedUrl.query.versionId;
                if (!diagVersionId) { sendError('Missing versionId', 400); break; }
                try {
                    const diagResult = diagnoseVersion(diagVersionId);
                    sendJSON(diagResult);
                } catch (e) {
                    sendError('诊断失败: ' + e.message);
                }
                break;
            }

            case '/api/game/crash-log': {
                const crVersionId = parsedUrl.query.versionId;
                let crashLog = null;
                const searchDirs = [];

                if (crVersionId && resolveVersionIsolation(crVersionId)) {
                    searchDirs.push(path.join(VERSIONS_DIR, crVersionId, 'crash-reports'));
                }
                const settings = loadSettingsCached();
                searchDirs.push(path.join(settings.gameDir || DATA_DIR, 'crash-reports'));

                for (const dir of searchDirs) {
                    if (!fs.existsSync(dir)) continue;
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort().reverse();
                    if (files.length > 0) {
                        try {
                            const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
                            crashLog = { file: files[0], content: content.substring(0, 10000), path: path.join(dir, files[0]) };
                            break;
                        } catch (e) {}
                    }
                }

                sendJSON({ crashLog });
                break;
            }

            case '/api/game/exit-analysis': {
                sendJSON({ analysis: lastGameExitAnalysis });
                break;
            }

            case '/api/game/crash-analyze': {
                const caVersionId = parsedUrl.query.versionId;
                if (!caVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    const caSettings = loadSettingsCached();
                    let caVersionDir = null;
                    const caCleanId = caVersionId.replace(' [外部]', '');
                    const caExtFolders = loadExternalFolders();
                    for (const folder of caExtFolders) {
                        if (!fs.existsSync(folder.path)) continue;
                        const extVers = scanExternalFolder(folder.path);
                        if (extVers.some(v => v.id === caCleanId)) {
                            caVersionDir = path.join(folder.path, caCleanId);
                            break;
                        }
                    }
                    if (!caVersionDir) {
                        caVersionDir = path.join(VERSIONS_DIR, caCleanId);
                    }

                    let crashContent = '';
                    let latestLogContent = '';
                    let hsErrContent = '';
                    let logFile = null;

                    const crashReportsDir = path.join(caVersionDir, 'crash-reports');
                    if (fs.existsSync(crashReportsDir)) {
                        const crashFiles = fs.readdirSync(crashReportsDir)
                            .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                            .map(f => ({ name: f, mtime: fs.statSync(path.join(crashReportsDir, f)).mtime }))
                            .sort((a, b) => b.mtime - a.mtime);
                        for (const cf of crashFiles) {
                            const mtime = cf.mtime;
                            if (Math.abs((mtime - new Date()) / 60000) < 3) {
                                try {
                                    crashContent = fs.readFileSync(path.join(crashReportsDir, cf.name), 'utf8');
                                    logFile = 'crash-reports/' + cf.name;
                                    break;
                                } catch (e) {}
                            }
                        }
                    }

                    const latestLogPath = path.join(caVersionDir, 'logs', 'latest.log');
                    if (fs.existsSync(latestLogPath)) {
                        try {
                            const lines = fs.readFileSync(latestLogPath, 'utf8').split('\n');
                            latestLogContent = lines.slice(-500).join('\n');
                            if (!logFile) logFile = 'logs/latest.log';
                        } catch (e) {}
                    }

                    try {
                        const versionFiles = fs.readdirSync(caVersionDir);
                        for (const vf of versionFiles) {
                            if (vf.startsWith('hs_err_pid') && vf.endsWith('.log')) {
                                const hsPath = path.join(caVersionDir, vf);
                                const stat = fs.statSync(hsPath);
                                if (Math.abs((stat.mtime - new Date()) / 60000) < 10) {
                                    try {
                                        const hsLines = fs.readFileSync(hsPath, 'utf8').split('\n');
                                        hsErrContent = hsLines.slice(0, 200).join('\n');
                                        if (!logFile) logFile = vf;
                                        break;
                                    } catch (e) {}
                                }
                            }
                        }
                    } catch (e) {}

                    const allLog = crashContent + '\n' + latestLogContent + '\n' + hsErrContent;

                    if (!allLog.trim()) {
                        sendJSON({ found: false });
                        break;
                    }

                    const crashRules = [
                        { pattern: 'java.lang.OutOfMemoryError', reason: '内存不足', solution: '建议增加分配内存或减少模组数量。当前分配的内存可能不足以支撑游戏运行。', severity: 'high' },
                        { pattern: 'The driver does not appear to support OpenGL', reason: '显卡不支持OpenGL', solution: '请更新显卡驱动，或确认您的显卡支持OpenGL。老旧显卡可能无法运行Minecraft。', severity: 'high' },
                        { pattern: 'Pixel format not accelerated', reason: '显卡驱动不支持', solution: '显卡驱动不支持所需的像素格式。请更新显卡驱动至最新版本。', severity: 'high' },
                        { pattern: "Couldn't set pixel format", reason: '显卡驱动不支持', solution: '显卡驱动不支持所需的像素格式。请更新显卡驱动至最新版本。', severity: 'high' },
                        { pattern: 'Unsupported class file major version', reason: 'Java版本不兼容', solution: '当前Java版本过低，无法运行该版本的游戏或Mod。请安装更高版本的Java。', severity: 'high' },
                        { pattern: 'Unsupported major.minor version', reason: 'Java版本不兼容', solution: '当前Java版本过低，无法运行该版本的游戏或Mod。请安装更高版本的Java。', severity: 'high' },
                        { pattern: 'because module java.base does not export', reason: 'Java版本过高', solution: '当前Java版本过高，导致与游戏不兼容。请降低Java版本（推荐Java 8或11）。', severity: 'high' },
                        { pattern: 'NoSuchFieldException: ucp', reason: 'Java版本过高', solution: '当前Java版本过高，导致与游戏不兼容。请降低Java版本（推荐Java 8或11）。', severity: 'high' },
                        { pattern: 'Open J9 is not supported', reason: '使用OpenJ9', solution: 'Minecraft不支持OpenJ9虚拟机。请更换为HotSpot JVM（如Oracle JDK或OpenJDK HotSpot）。', severity: 'high' },
                        { pattern: 'The directories below appear to be extracted jar files', reason: 'Mod文件被解压', solution: '检测到Mod文件被解压到mods文件夹中。请删除解压后的文件夹，直接放入.jar文件。', severity: 'medium' },
                        { pattern: 'LoaderExceptionModCrash', reason: 'Mod导致崩溃', solution: '某个Mod导致了游戏崩溃。请查看详细信息中的Mod名称，尝试删除或更新该Mod。', severity: 'medium', modExtract: /Caught exception from (\S+)/ },
                        { pattern: 'Caught exception from ', reason: 'Mod导致崩溃', solution: '某个Mod导致了游戏崩溃。请查看详细信息中的Mod名称，尝试删除或更新该Mod。', severity: 'medium', modExtract: /Caught exception from (\S+)/ },
                        { pattern: 'Found duplicate mods', reason: 'Mod重复安装', solution: '检测到重复安装的Mod。请检查mods文件夹，删除重复的Mod文件。', severity: 'medium' },
                        { pattern: 'DuplicateModsFoundException', reason: 'Mod重复安装', solution: '检测到重复安装的Mod。请检查mods文件夹，删除重复的Mod文件。', severity: 'medium' },
                        { pattern: 'Incompatible mods found', reason: 'Mod互不兼容', solution: '检测到互不兼容的Mod。请查看详细信息，删除冲突的Mod之一。', severity: 'medium' },
                        { pattern: 'Shaders Mod detected. Please remove it', reason: 'ShadersMod与OptiFine冲突', solution: 'ShadersMod与OptiFine冲突。OptiFine已内置光影支持，请删除ShadersMod。', severity: 'medium' },
                        { pattern: '1282: Invalid operation', reason: '光影或资源包导致OpenGL错误', solution: '光影或资源包导致了OpenGL错误。请尝试移除当前光影或更换低分辨率资源包。', severity: 'medium' },
                        { pattern: 'Maybe try a lower resolution resourcepack', reason: '材质过大', solution: '当前使用的资源包分辨率过高，导致内存不足。请尝试使用更低分辨率的资源包。', severity: 'medium' },
                        { pattern: 'Out of Memory Error', reason: '内存不足', solution: 'JVM层面内存不足。建议增加分配内存或减少模组数量。', severity: 'high' },
                        { pattern: 'The system is out of physical RAM', reason: '内存不足', solution: '系统物理内存不足。建议关闭其他程序释放内存，或增加分配的内存。', severity: 'high' },
                        { pattern: 'Cannot find launch target fmlclient', reason: 'Forge安装不完整', solution: 'Forge安装不完整，缺少必要的启动文件。请重新安装Forge。', severity: 'high' },
                        { pattern: 'Missing or unsupported mandatory dependencies', reason: 'Mod缺少前置', solution: '某些Mod缺少必要的前置Mod。请查看详细信息，安装缺少的前置Mod。', severity: 'medium' },
                    ];

                    let result = { found: false };
                    for (const rule of crashRules) {
                        if (allLog.includes(rule.pattern)) {
                            let modName = null;
                            if (rule.modExtract) {
                                const match = allLog.match(rule.modExtract);
                                if (match) modName = match[1];
                            }
                            result = {
                                found: true,
                                reason: rule.reason,
                                solution: rule.solution,
                                modName: modName,
                                logFile: logFile,
                                severity: rule.severity
                            };
                            break;
                        }
                    }

                    if (!result.found) {
                        const { CrashAnalyzer } = require('./crashAnalyzer');
                        try {
                            const analyzer = new CrashAnalyzer(null, caVersionDir);
                            await analyzer.collect(caCleanId, []);
                            if (analyzer.analyzeRawFiles.length > 0) {
                                analyzer.prepare();
                                analyzer.analyze();
                                if (analyzer.crashReasons.size > 0) {
                                    const [reason, additional] = analyzer.crashReasons.entries().next().value;
                                    const detail = analyzer.getAnalyzeResult(false);
                                    result = {
                                        found: true,
                                        reason: reason,
                                        solution: detail || '',
                                        modName: additional && additional.length > 0 ? additional.join(', ') : null,
                                        logFile: logFile,
                                        severity: 'medium'
                                    };
                                }
                            }
                        } catch (e) {
                            console.error('[CrashAnalyze] CrashAnalyzer fallback failed:', e.message);
                        }
                    }

                    sendJSON(result);
                } catch (e) {
                    sendError('崩溃分析失败: ' + e.message);
                }
                break;
            }

            case '/api/game/play-time': {
                const ptVersionId = parsedUrl.query.versionId;
                if (!ptVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    const ptSettings = loadSettingsCached();
                    let ptVersionDir = null;
                    const ptCleanId = ptVersionId.replace(' [外部]', '');
                    const ptExtFolders = loadExternalFolders();
                    for (const folder of ptExtFolders) {
                        if (!fs.existsSync(folder.path)) continue;
                        const extVers = scanExternalFolder(folder.path);
                        if (extVers.some(v => v.id === ptCleanId)) {
                            ptVersionDir = path.join(folder.path, ptCleanId);
                            break;
                        }
                    }
                    if (!ptVersionDir) {
                        ptVersionDir = path.join(VERSIONS_DIR, ptCleanId);
                    }

                    const worlds = [];
                    const savesDir = path.join(ptVersionDir, 'saves');
                    if (fs.existsSync(savesDir)) {
                        const saves = fs.readdirSync(savesDir).filter(d => {
                            return fs.existsSync(path.join(savesDir, d, 'level.dat'));
                        });
                        for (const save of saves) {
                            try {
                                const levelDat = fs.readFileSync(path.join(savesDir, save, 'level.dat'));
                                const decompressed = zlib.gunzipSync(levelDat);
                                const timeStr = 'Time';
                                for (let i = 0; i < decompressed.length - 20; i++) {
                                    if (decompressed[i] === 4 &&
                                        decompressed[i + 1] === 0 && decompressed[i + 2] === 4) {
                                        const name = decompressed.slice(i + 3, i + 7).toString('ascii');
                                        if (name === timeStr) {
                                            const value = decompressed.readBigInt64BE(i + 7);
                                            const totalSeconds = Number(value) / 20;
                                            worlds.push({
                                                worldName: save,
                                                ticks: Number(value),
                                                seconds: totalSeconds,
                                                formatted: formatPlayTime(totalSeconds)
                                            });
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }

                    const playTimePath = path.join(DATA_DIR, 'play-time.json');
                    let sessionData = {};
                    try {
                        if (fs.existsSync(playTimePath)) {
                            sessionData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
                        }
                    } catch (e) {}

                    const versionSession = sessionData[ptVersionId] || {};
                    const totalSessionSeconds = versionSession.totalSeconds || 0;
                    const lastPlayed = versionSession.lastPlayed || null;
                    const playCount = versionSession.playCount || 0;

                    sendJSON({
                        worlds,
                        session: {
                            totalSeconds: totalSessionSeconds,
                            formatted: formatPlayTime(totalSessionSeconds),
                            lastPlayed: lastPlayed,
                            playCount: playCount
                        }
                    });
                } catch (e) {
                    sendError('获取游戏时间失败: ' + e.message);
                }
                break;
            }

            case '/api/game/log': {
                const logCount = parseInt(parsedUrl.query.count) || 100;
                const recentLogs = gameLogBuffer.slice(-logCount);
                sendJSON({ logs: recentLogs, total: gameLogBuffer.length });
                break;
            }

            case '/api/game/log/export': {
                try {
                    const exportVersionId = parsedUrl.query.versionId || '';
                    const exportParts = [];
                    exportParts.push('='.repeat(60));
                    exportParts.push('VersePC 游戏日志导出');
                    exportParts.push(`导出时间: ${new Date().toLocaleString()}`);
                    exportParts.push(`版本: ${exportVersionId || '未知'}`);
                    exportParts.push('='.repeat(60));
                    exportParts.push('');

                    const settings = loadSettingsCached();
                    exportParts.push(`[环境信息]`);
                    exportParts.push(`数据目录: ${DATA_DIR}`);
                    exportParts.push(`Java路径: ${settings.javaPath || '自动检测'}`);
                    exportParts.push(`最大内存: ${settings.maxMemory || 2048}MB`);
                    exportParts.push(`版本隔离: ${settings.versionIsolation ? '是' : '否'}`);
                    exportParts.push('');

                    if (lastGameExitAnalysis) {
                        exportParts.push(`[上次退出分析]`);
                        exportParts.push(`退出码: ${lastGameExitAnalysis.code}`);
                        exportParts.push(`原因: ${lastGameExitAnalysis.reason}`);
                        exportParts.push(`建议: ${lastGameExitAnalysis.suggestion}`);
                        exportParts.push(`是否崩溃: ${lastGameExitAnalysis.isCrash ? '是' : '否'}`);
                        if (lastGameExitAnalysis.versionId) exportParts.push(`版本ID: ${lastGameExitAnalysis.versionId}`);
                        exportParts.push('');
                    }

                    if (gameLogBuffer.length > 0) {
                        exportParts.push(`[游戏日志] (最近 ${Math.min(gameLogBuffer.length, 2000)} 行)`);
                        exportParts.push('-'.repeat(40));
                        const exportLogs = gameLogBuffer.slice(-2000);
                        exportParts.push(...exportLogs);
                        exportParts.push('');
                    }

                    if (exportVersionId) {
                        const crashReportsDir = getVersionSubDir(exportVersionId, 'crash-reports');
                        if (crashReportsDir && fs.existsSync(crashReportsDir)) {
                            const crashFiles = fs.readdirSync(crashReportsDir)
                                .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                                .sort().reverse();
                            if (crashFiles.length > 0) {
                                try {
                                    const crashContent = fs.readFileSync(path.join(crashReportsDir, crashFiles[0]), 'utf8');
                                    exportParts.push(`[最新崩溃报告] ${crashFiles[0]}`);
                                    exportParts.push('-'.repeat(40));
                                    exportParts.push(crashContent.substring(0, 5000));
                                    if (crashContent.length > 5000) exportParts.push(`... (已截断，共${crashContent.length}字符)`);
                                    exportParts.push('');
                                } catch (_) {}
                            }
                        }

                        const logsDir = getVersionSubDir(exportVersionId, 'logs');
                        const latestLogPath = path.join(logsDir, 'latest.log');
                        if (fs.existsSync(latestLogPath)) {
                            try {
                                const logContent = fs.readFileSync(latestLogPath, 'utf8');
                                exportParts.push(`[latest.log] (最后 2000 行)`);
                                exportParts.push('-'.repeat(40));
                                const logLines = logContent.split('\n');
                                exportParts.push(...logLines.slice(-2000));
                                exportParts.push('');
                            } catch (_) {}
                        }
                    }

                    const exportContent = exportParts.join('\n');
                    const exportFileName = `VersePC_Log_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.txt`;
                    const exportPath = path.join(DATA_DIR, 'temp', exportFileName);
                    if (!fs.existsSync(path.dirname(exportPath))) fs.mkdirSync(path.dirname(exportPath), { recursive: true });
                    fs.writeFileSync(exportPath, exportContent, 'utf8');

                    res.writeHead(200, {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Content-Disposition': `attachment; filename="${encodeURIComponent(exportFileName)}"`,
                        'Content-Length': Buffer.byteLength(exportContent, 'utf8')
                    });
                    res.end(exportContent);
                    try { fs.unlinkSync(exportPath); } catch (_) {}
                } catch (exportErr) {
                    sendError('导出日志失败: ' + exportErr.message, 500);
                }
                break;
            }

            case '/api/game/log/save-export': {
                try {
                    const seVersionId = parsedUrl.query.versionId || '';
                    const seParts = [];
                    seParts.push('='.repeat(60));
                    seParts.push('VersePC 游戏日志导出');
                    seParts.push(`导出时间: ${new Date().toLocaleString()}`);
                    seParts.push(`版本: ${seVersionId || '未知'}`);
                    seParts.push('='.repeat(60));
                    seParts.push('');

                    const seSettings = loadSettingsCached();
                    seParts.push(`[环境信息]`);
                    seParts.push(`数据目录: ${DATA_DIR}`);
                    seParts.push(`Java路径: ${seSettings.javaPath || '自动检测'}`);
                    seParts.push(`最大内存: ${seSettings.maxMemory || 2048}MB`);
                    seParts.push(`版本隔离: ${seSettings.versionIsolation ? '是' : '否'}`);
                    seParts.push('');

                    if (lastGameExitAnalysis) {
                        seParts.push(`[上次退出分析]`);
                        seParts.push(`退出码: ${lastGameExitAnalysis.code}`);
                        seParts.push(`原因: ${lastGameExitAnalysis.reason}`);
                        seParts.push(`建议: ${lastGameExitAnalysis.suggestion}`);
                        seParts.push(`是否崩溃: ${lastGameExitAnalysis.isCrash ? '是' : '否'}`);
                        if (lastGameExitAnalysis.versionId) seParts.push(`版本ID: ${lastGameExitAnalysis.versionId}`);
                        seParts.push('');
                    }

                    if (gameLogBuffer.length > 0) {
                        seParts.push(`[游戏日志] (最近 ${Math.min(gameLogBuffer.length, 2000)} 行)`);
                        seParts.push('-'.repeat(40));
                        seParts.push(...gameLogBuffer.slice(-2000));
                        seParts.push('');
                    }

                    if (seVersionId) {
                        const seCrashDir = getVersionSubDir(seVersionId, 'crash-reports');
                        if (seCrashDir && fs.existsSync(seCrashDir)) {
                            const seCrashFiles = fs.readdirSync(seCrashDir)
                                .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                                .sort().reverse();
                            if (seCrashFiles.length > 0) {
                                try {
                                    const seCrashContent = fs.readFileSync(path.join(seCrashDir, seCrashFiles[0]), 'utf8');
                                    seParts.push(`[最新崩溃报告] ${seCrashFiles[0]}`);
                                    seParts.push('-'.repeat(40));
                                    seParts.push(seCrashContent.substring(0, 5000));
                                    if (seCrashContent.length > 5000) seParts.push(`... (已截断，共${seCrashContent.length}字符)`);
                                    seParts.push('');
                                } catch (_) {}
                            }
                        }

                        const seLogsDir = getVersionSubDir(seVersionId, 'logs');
                        const seLatestLog = path.join(seLogsDir, 'latest.log');
                        if (fs.existsSync(seLatestLog)) {
                            try {
                                const seLogContent = fs.readFileSync(seLatestLog, 'utf8');
                                seParts.push(`[latest.log] (最后 2000 行)`);
                                seParts.push('-'.repeat(40));
                                seParts.push(...seLogContent.split('\n').slice(-2000));
                                seParts.push('');
                            } catch (_) {}
                        }
                    }

                    const seContent = seParts.join('\n');
                    const seFileName = `VersePC_Log_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.txt`;
                    const seTempDir = path.join(DATA_DIR, 'temp');
                    if (!fs.existsSync(seTempDir)) fs.mkdirSync(seTempDir, { recursive: true });
                    const seFilePath = path.join(seTempDir, seFileName);
                    fs.writeFileSync(seFilePath, seContent, 'utf8');

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, filePath: seFilePath, fileName: seFileName }));
                } catch (seErr) {
                    sendError('保存日志失败: ' + seErr.message, 500);
                }
                break;
            }

            case '/api/launch/args-preview': {
                const laData = await readBody();
                const laVersionId = laData.versionId;
                if (!laVersionId) { sendError('Missing versionId', 400); break; }

                try {
                    const versionJson = resolveVersionJson(laVersionId);
                    if (!versionJson) { sendError('版本JSON缺失', 400); break; }
                    const settings = loadSettingsCached();
                    const accounts = loadAccounts();
                    const account = accounts.find(a => a.id === settings.selectedAccount) || accounts[0] || { username: 'Player', type: 'offline' };
                    const args = buildLaunchArguments(versionJson, settings, account);
                    sendJSON({ args, javaPath: settings.javaPath || 'auto-detect' });
                } catch (e) {
                    sendError('预览失败: ' + e.message);
                }
                break;
            }

            case '/api/java/list': {
                try {
                    const requiredVersions = [8, 17, 21, 25];
                    const javaVersions = requiredVersions.map(v => ({
                        majorVersion: v,
                        version: `Java ${v}`,
                        source: 'Adoptium (Temurin)'
                    }));
                    sendJSON({ versions: javaVersions });
                } catch (e) {
                    console.error('[Java] 获取Java列表失败:', e.message);
                    sendError('获取Java列表失败: ' + e.message);
                }
                break;
            }

            case '/api/java/download': {
                try {
                    const body = await readBody();
                    const { majorVersion, mirrorIndex } = body;
                    
                    if (!majorVersion) {
                        sendError('缺少majorVersion参数', 400);
                        break;
                    }
                    
                    const sessionId = `java-${Date.now()}`;
                    const sessionFile = path.join(DATA_DIR, `java-download-${sessionId}.json`);
                    
                    fs.writeFileSync(sessionFile, JSON.stringify({
                        status: 'starting',
                        progress: 0,
                        majorVersion: majorVersion,
                        startTime: Date.now()
                    }));
                    
                    downloadJavaAsync(majorVersion, sessionId, sessionFile, mirrorIndex || 0);
                    
                    sendJSON({ sessionId: sessionId });
                } catch (e) {
                    sendError('启动Java下载失败: ' + e.message);
                }
                break;
            }

            case '/api/java/download-status': {
                const sessionId = parsedUrl.query.sessionId;
                if (!sessionId) {
                    sendError('缺少sessionId参数', 400);
                    break;
                }
                
                const sessionFile = path.join(DATA_DIR, `java-download-${sessionId}.json`);
                if (!fs.existsSync(sessionFile)) {
                    sendJSON({ status: 'not_found' });
                    break;
                }
                
                try {
                    const status = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                    sendJSON(status);
                    
                    if (status.status === 'completed' || status.status === 'error') {
                        setTimeout(() => {
                            try { fs.unlinkSync(sessionFile); } catch (e) {}
                        }, 60000);
                    }
                } catch (e) {
                    sendJSON({ status: 'error', error: e.message });
                }
                break;
            }

            case '/api/java/installed': {
                try {
                    const systemJava = detectSystemJava();
                    const bundledJava = detectBundledJava();
                    const allJava = [...bundledJava, ...systemJava];
                    
                    sendJSON({
                        java: allJava,
                        total: allJava.length
                    });
                } catch (e) {
                    sendError('获取已安装Java列表失败: ' + e.message);
                }
                break;
            }

            case '/api/java/configure-env': {
                try {
                    const envBody = await readBody();
                    const { javaHome, majorVersion } = envBody;
                    if (!javaHome) {
                        sendError('缺少javaHome参数', 400);
                        break;
                    }
                    if (!fs.existsSync(javaHome)) {
                        sendError('Java目录不存在: ' + javaHome, 400);
                        break;
                    }
                    const result = configureJavaEnv(javaHome, majorVersion || 17);
                    sendJSON({ success: true, ...result });
                } catch (e) {
                    sendError('配置环境变量失败: ' + e.message);
                }
                break;
            }

            case '/api/java/delete': {
                try {
                    const delBody = await readBody();
                    const { javaHome } = delBody;
                    if (!javaHome) {
                        sendError('缺少javaHome参数', 400);
                        break;
                    }

                    const normalizedJavaHome = javaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    const normalizedDataDir = DATA_DIR.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                    const normalizedJavaDir = JAVA_DIR.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

                    if (!normalizedJavaHome.startsWith(normalizedJavaDir)) {
                        sendError('只能删除启动器内置的Java，系统Java请通过系统设置卸载', 403);
                        break;
                    }

                    if (normalizedJavaHome === normalizedJavaDir || normalizedJavaHome === normalizedDataDir) {
                        sendError('不能删除Java根目录', 400);
                        break;
                    }

                    if (!fs.existsSync(javaHome)) {
                        sendError('Java目录不存在: ' + javaHome, 404);
                        break;
                    }

                    const javaExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
                    if (!fs.existsSync(javaExe)) {
                        sendError('指定目录不是有效的Java安装', 400);
                        break;
                    }

                    const settings = loadSettingsCached();
                    if (settings.javaPath) {
                        const normalizedSettingsPath = settings.javaPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                        if (normalizedSettingsPath.startsWith(normalizedJavaHome)) {
                            settings.javaPath = '';
                            saveSettings(settings);
                            console.log(`[Java] 已清除设置中引用的Java路径: ${javaHome}`);
                        }
                    }

                    try {
                        const currentPath = execSync(
                            `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine')"`,
                            { encoding: 'utf8', timeout: 10000, windowsHide: true }
                        ).trim();
                        const javaBinDir = path.join(javaHome, 'bin');
                        const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                        const pathEntries = currentPath.split(';').filter(p => {
                            const normalized = p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                            return normalized !== normalizedJavaBin && p.trim() !== '';
                        });
                        const newPath = pathEntries.join(';');
                        if (newPath !== currentPath) {
                            execSync(
                                `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newPath.replace(/'/g, "''")}', 'Machine')"`,
                                { encoding: 'utf8', timeout: 15000, windowsHide: true }
                            );
                            console.log(`[Java] 已从系统PATH移除: ${javaBinDir}`);
                        }
                    } catch (envErr) {
                        console.warn(`[Java] 从系统PATH移除失败(不影响): ${envErr.message}`);
                    }

                    try {
                        const currentUserPath = execSync(
                            `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`,
                            { encoding: 'utf8', timeout: 10000, windowsHide: true }
                        ).trim();
                        const javaBinDir = path.join(javaHome, 'bin');
                        const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                        const userPathEntries = currentUserPath.split(';').filter(p => {
                            const normalized = p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                            return normalized !== normalizedJavaBin && p.trim() !== '';
                        });
                        const newUserPath = userPathEntries.join(';');
                        if (newUserPath !== currentUserPath) {
                            execSync(
                                `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newUserPath.replace(/'/g, "''")}', 'User')"`,
                                { encoding: 'utf8', timeout: 15000, windowsHide: true }
                            );
                            console.log(`[Java] 已从用户PATH移除: ${javaBinDir}`);
                        }
                    } catch (envErr) {
                        console.warn(`[Java] 从用户PATH移除失败(不影响): ${envErr.message}`);
                    }

                    try {
                        const currentJavaHome = execSync(
                            `powershell -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')"`,
                            { encoding: 'utf8', timeout: 10000, windowsHide: true }
                        ).trim();
                        const normalizedCurrentJavaHome = currentJavaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
                        if (normalizedCurrentJavaHome === normalizedJavaHome) {
                            execSync(
                                `powershell -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', $null, 'Machine')"`,
                                { encoding: 'utf8', timeout: 15000, windowsHide: true }
                            );
                            console.log(`[Java] 已清除JAVA_HOME环境变量`);
                        }
                    } catch (envErr) {
                        console.warn(`[Java] 清除JAVA_HOME失败(不影响): ${envErr.message}`);
                    }

                    fs.rmSync(javaHome, { recursive: true, force: true });
                    console.log(`[Java] 已删除Java: ${javaHome}`);

                    sendJSON({ success: true, message: `已删除Java: ${path.basename(javaHome)}` });
                } catch (e) {
                    console.error('[Java] 删除失败:', e.message);
                    sendError('删除Java失败: ' + e.message);
                }
                break;
            }

            case '/api/jvm/optimize-args': {
                try {
                    const versionId = parsedUrl.query.versionId;
                    if (!versionId) {
                        sendError('缺少versionId参数', 400);
                        break;
                    }

                    const totalMem = os.totalmem();
                    const freeMem = os.freemem();
                    const availableGB = freeMem / 1073741824;

                    let modCount = 0;
                    const versionDir = path.join(VERSIONS_DIR, versionId);
                    const modsDir = path.join(versionDir, 'mods');
                    if (fs.existsSync(modsDir)) {
                        modCount = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length;
                    }

                    let t0, t1, t2, t3;
                    if (modCount > 0) {
                        t0 = 0.5 + modCount / 150;
                        t1 = 1.5 + modCount / 90;
                        t2 = 2.7 + modCount / 50;
                        t3 = 4.5 + modCount / 25;
                    } else {
                        t0 = 0.5; t1 = 1.5; t2 = 2.5; t3 = 4;
                    }

                    let ramGive = 0;
                    let ramAvailable = availableGB;

                    let delta = t1;
                    ramGive += Math.min(ramAvailable, delta);
                    ramAvailable -= delta;

                    delta = t2 - t1;
                    ramGive += Math.min(ramAvailable * 0.7, delta);
                    ramAvailable -= delta / 0.7;

                    delta = t3 - t2;
                    ramGive += Math.min(ramAvailable * 0.4, delta);
                    ramAvailable -= delta / 0.4;

                    delta = t3;
                    ramGive += Math.min(ramAvailable * 0.15, delta);

                    ramGive = Math.max(ramGive, t0);
                    ramGive = Math.round(ramGive * 10) / 10;

                    const maxGB = totalMem / 1073741824 * 0.7;
                    ramGive = Math.min(ramGive, maxGB);

                    const totalRamMB = Math.floor(ramGive * 1024);
                    const newGenMB = Math.floor(totalRamMB * 0.15);

                    const args = [
                        `-Xmx${totalRamMB}m`,
                        `-Xmn${newGenMB}m`,
                        '-XX:+UseG1GC',
                        '-XX:-UseAdaptiveSizePolicy',
                        '-XX:-OmitStackTraceInFastThrow',
                        '-Djdk.lang.Process.allowAmbiguousCommands=true',
                        '-Dfml.ignoreInvalidMinecraftCertificates=True',
                        '-Dfml.ignorePatchDiscrepancies=True',
                        '-Dlog4j2.formatMsgNoLookups=true'
                    ];

                    sendJSON({
                        args: args.join(' '),
                        xmxMB: totalRamMB,
                        xmnMB: newGenMB,
                        ramGB: ramGive,
                        modCount,
                        totalMemGB: totalMem / 1073741824,
                        freeMemGB: freeMem / 1073741824
                    });
                } catch (e) {
                    sendError('优化JVM参数失败: ' + e.message);
                }
                break;
            }

            // ===== 文件系统浏览 API (PCL2 风格文件浏览器) =====
            
            case '/api/filesystem/browse': {
                const fsBody = await readBody();
                const { path: browsePath, showHidden = false } = fsBody;
                
                if (!browsePath) {
                    sendError('Missing path parameter', 400);
                    break;
                }

                const resolvedBrowse = path.resolve(browsePath);
                const allowedBrowseBases = [DATA_DIR, ...Object.values(VERSIONS_DIR), os.homedir()].map(d => path.resolve(d));
                const isBrowseAllowed = allowedBrowseBases.some(base => resolvedBrowse.toLowerCase().startsWith(base.toLowerCase()));
                if (!isBrowseAllowed) {
                    sendError('Forbidden: 不允许访问此路径', 403);
                    break;
                }
                
                try {
                    if (!fs.existsSync(browsePath)) {
                        sendJSON({ error: 'Path does not exist', files: [], folders: [] });
                        break;
                    }
                    
                    const stat = fs.statSync(browsePath);
                    if (!stat.isDirectory()) {
                        sendJSON({ error: 'Path is not a directory', files: [], folders: [] });
                        break;
                    }
                    
                    const entries = fs.readdirSync(browsePath, { withFileTypes: true });
                    const files = [];
                    const folders = [];
                    
                    for (const entry of entries) {
                        // 跳过隐藏文件（如果未启用显示隐藏）
                        if (!showHidden && entry.name.startsWith('.')) continue;
                        
                        const entryPath = path.join(browsePath, entry.name);
                        let entryStat;
                        try {
                            entryStat = fs.statSync(entryPath);
                        } catch (e) {
                            continue; // 跳过无法访问的文件
                        }
                        
                        const item = {
                            name: entry.name,
                            path: entryPath,
                            modifiedTime: entryStat.mtime.getTime(),
                            size: entryStat.size,
                            extension: path.extname(entry.name).toLowerCase()
                        };
                        
                        if (entry.isDirectory()) {
                            folders.push(item);
                        } else {
                            files.push(item);
                        }
                    }
                    
                    // 排序：文件夹在前，然后按名称排序
                    folders.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
                    
                    sendJSON({ files, folders, currentPath: browsePath });
                } catch (e) {
                    sendJSON({ error: e.message, files: [], folders: [] });
                }
                break;
            }

            case '/api/filesystem/quick-access': {
                try {
                    const homeDir = os.homedir();
                    const quickAccessPaths = [
                        { name: '桌面', path: path.join(homeDir, 'Desktop'), icon: 'desktop' },
                        { name: '文档', path: path.join(homeDir, 'Documents'), icon: 'docs' },
                        { name: '下载', path: path.join(homeDir, 'Downloads'), icon: 'downloads' },
                        { name: '.minecraft', path: MINECRAFT_DIR, icon: 'minecraft' },
                        { name: 'VersePC 数据', path: DATA_DIR, icon: 'versepc' }
                    ];
                    
                    sendJSON(quickAccessPaths);
                } catch (e) {
                    sendError(e.message);
                }
                break;
            }

            case '/api/filesystem/drives': {
                try {
                    const drives = [];
                    
                    if (process.platform === 'win32') {
                        let output;
                        try {
                            output = execSync('wmic logicaldevice get name,size,description /format:list', { 
                                encoding: 'utf8',
                                timeout: 3000 
                            }).toString();
                        } catch (e) {
                            output = '';
                        }
                        
                        // 解析驱动器信息
                        const driveLetters = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];
                        for (const letter of driveLetters) {
                            try {
                                if (fs.existsSync(letter)) {
                                    const stats = fs.statSync(letter);
                                    drives.push({
                                        name: letter.replace(':', ''),
                                        path: letter,
                                        type: 'fixed',
                                        totalSize: formatDriveSize(stats.size || 0)
                                    });
                                }
                            } catch (e) {}
                        }
                    } else {
                        // macOS/Linux
                        drives.push({
                            name: '/',
                            path: '/',
                            type: 'fixed',
                            totalSize: ''
                        });
                        
                        // 添加常见挂载点
                        ['/home', '/mnt', '/Volumes'].forEach(mount => {
                            if (fs.existsSync(mount)) {
                                drives.push({
                                    name: mount.split('/').pop() || mount,
                                    path: mount,
                                    type: 'fixed',
                                    totalSize: ''
                                });
                            }
                        });
                    }
                    
                    sendJSON(drives);
                } catch (e) {
                    sendError(e.message);
                }
                break;
            }

            case '/api/filesystem/create-directory': {
                const cdBody = await readBody();
                const { parentPath, name } = cdBody;
                
                if (!parentPath || !name) {
                    sendError('Missing parameters', 400);
                    break;
                }
                
                try {
                    const newPath = path.join(parentPath, name);
                    if (fs.existsSync(newPath)) {
                        sendJSON({ success: false, error: 'Directory already exists' });
                        break;
                    }
                    
                    fs.mkdirSync(newPath, { recursive: true });
                    sendJSON({ success: true, path: newPath });
                } catch (e) {
                    sendJSON({ success: false, error: e.message });
                }
                break;
            }

            case '/api/filesystem/default-mod-path': {
                try {
                    const reqVid = parsedUrl.query.versionId || null;
                    let defaultPath = getVersionSubDir(reqVid, 'mods');
                    if (!defaultPath) {
                        const installedVersions = getInstalledVersions();
                        if (installedVersions.length > 0) {
                            defaultPath = getVersionSubDir(installedVersions[0].id, 'mods') || path.join(MINECRAFT_DIR, 'mods');
                        } else {
                            defaultPath = path.join(MINECRAFT_DIR, 'mods');
                        }
                    }
                    
                    if (!fs.existsSync(defaultPath)) {
                        fs.mkdirSync(defaultPath, { recursive: true });
                    }
                    
                    sendJSON(defaultPath);
                } catch (e) {
                    sendError(e.message);
                }
                break;
            }

            case '/api/filesystem/default-resource-path': {
                try {
                    const drpType = parsedUrl.query.type || '';
                    const folderMap = { resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
                    const folderName = folderMap[drpType];
                    if (!folderName) { sendError('Invalid resource type', 400); break; }

                    let defaultPath = getVersionSubDir(null, folderName);
                    if (!defaultPath) {
                        const installedVersions = getInstalledVersions();
                        if (installedVersions.length > 0) {
                            defaultPath = getVersionSubDir(installedVersions[0].id, folderName) || path.join(DATA_DIR, folderName);
                        } else {
                            defaultPath = path.join(DATA_DIR, folderName);
                        }
                    }

                    if (!fs.existsSync(defaultPath)) {
                        fs.mkdirSync(defaultPath, { recursive: true });
                    }

                    sendJSON(defaultPath);
                } catch (e) {
                    sendError(e.message);
                }
                break;
            }

            case '/api/filesystem/open-in-explorer': {
                const oieBody = await readBody();
                const { targetPath } = oieBody;
                
                if (!targetPath || !fs.existsSync(targetPath)) {
                    sendError('Invalid or non-existent path', 400);
                    break;
                }
                
                try {
                    const { shell } = require('electron');
                    await shell.openPath(targetPath);
                    sendJSON({ success: true });
                } catch (e) {
                    sendError(e.message);
                }
                break;
            }

            case '/api/create-shortcut': {
                const scBody = await readBody();
                const shortcutType = scBody.type || 'desktop';
                const shortcutVersion = scBody.versionId || '';

                const exePath = process.execPath;
                const shortcutName = shortcutVersion ? `VersePC - ${shortcutVersion}` : 'VersePC';

                let shortcutDir;
                if (shortcutType === 'desktop') {
                    shortcutDir = path.join(os.homedir(), 'Desktop');
                } else {
                    shortcutDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
                }

                const shortcutPath = path.join(shortcutDir, `${shortcutName.replace(/["$`]/g, '')}.lnk`);

                const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("${shortcutPath.replace(/"/g, '`"')}")
$sc.TargetPath = "${exePath.replace(/"/g, '`"')}"
$sc.WorkingDirectory = "${path.dirname(exePath).replace(/"/g, '`"')}"
$sc.Description = "VersePC Minecraft Launcher"
$sc.Save()
`.trim();

                const tmpScript = path.join(os.tmpdir(), 'versepc_shortcut.ps1');
                fs.writeFileSync(tmpScript, psScript, 'utf8');
                exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`, { timeout: 10000 }, (err) => {
                    try { fs.unlinkSync(tmpScript); } catch(e) {}
                    if (err) { sendError(err.message); return; }
                    sendJSON({ success: true, path: shortcutPath });
                });
                break;
            }

            case '/api/screenshots': {
                const ssVersionId = parsedUrl.query.versionId || '';
                const ssDir = resolveSavesDir(ssVersionId).replace('saves', 'screenshots');
                const globalSsDir = path.join(DATA_DIR, 'screenshots');
                const screenshots = [];

                for (const dir of [ssDir, globalSsDir]) {
                    if (!fs.existsSync(dir)) continue;
                    try {
                        fs.readdirSync(dir).forEach(f => {
                            if (/\.(png|jpg|jpeg|bmp)$/i.test(f)) {
                                const filePath = path.join(dir, f);
                                const stat = fs.statSync(filePath);
                                screenshots.push({
                                    name: f,
                                    path: filePath,
                                    size: stat.size,
                                    time: stat.mtimeMs,
                                    url: `/api/screenshot?path=${encodeURIComponent(filePath)}`
                                });
                            }
                        });
                    } catch(e) {}
                }

                screenshots.sort((a, b) => b.time - a.time);
                sendJSON({ screenshots });
                break;
            }

            case '/api/screenshot': {
                const SCREENSHOT_ALLOWED_BASES = [DATA_DIR, ...Object.values(VERSIONS_DIR)].map(d => path.resolve(d));
                function isScreenshotPathAllowed(p) {
                    const resolved = path.resolve(p);
                    return SCREENSHOT_ALLOWED_BASES.some(base => resolved.toLowerCase().startsWith(base.toLowerCase()));
                }
                if (method === 'DELETE') {
                    const delPath = decodeURIComponent(parsedUrl.query.path || '');
                    if (!delPath) { sendError('Missing path', 400); break; }
                    if (!isScreenshotPathAllowed(delPath)) { sendError('Forbidden', 403); break; }
                    try {
                        fs.unlinkSync(delPath);
                        sendJSON({ success: true });
                    } catch(e) {
                        sendError(e.message);
                    }
                    break;
                }

                const ssPath = decodeURIComponent(parsedUrl.query.path || '');
                if (!ssPath || !fs.existsSync(ssPath)) {
                    sendError('Not found', 404);
                    break;
                }
                if (!isScreenshotPathAllowed(ssPath)) { sendError('Forbidden', 403); break; }
                const ssExt = path.extname(ssPath).toLowerCase();
                const ssMime = ssExt === '.png' ? 'image/png' : ssExt === '.jpg' || ssExt === '.jpeg' ? 'image/jpeg' : 'image/bmp';
                const ssData = fs.readFileSync(ssPath);
                res.writeHead(200, { 'Content-Type': ssMime, 'Cache-Control': 'max-age=3600' });
                res.end(ssData);
                break;
            }

            case '/api/server/ping': {
                const pingHost = parsedUrl.query.host;
                const pingPort = parseInt(parsedUrl.query.port) || 25565;
                if (!pingHost) { sendJSON({ error: 'host required' }, 400); break; }
                const pingResult = await mcPing(pingHost, pingPort);
                sendJSON(pingResult);
                break;
            }

            case '/api/easytier/download': {
                try {
                    const etDir = path.join(DATA_DIR, 'easytier');
                    if (!fs.existsSync(etDir)) fs.mkdirSync(etDir, { recursive: true });
                    const etBin = path.join(etDir, 'easytier.exe');
                    if (fs.existsSync(etBin)) { sendJSON({ success: true, message: 'already installed' }); break; }
                    const etUrl = 'https://github.com/EasyTier/EasyTier/releases/latest/download/easytier-windows-x86_64.zip';
                    const etZip = path.join(etDir, 'easytier.zip');
                    const dlRes = await fetch(etUrl, { redirect: 'follow' });
                    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
                    const buffer = Buffer.from(await dlRes.arrayBuffer());
                    fs.writeFileSync(etZip, buffer);
                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip(etZip);
                    zip.extractAllTo(etDir, true);
                    fs.unlinkSync(etZip);
                    const extracted = fs.readdirSync(etDir).find(f => f.endsWith('.exe'));
                    if (extracted && extracted !== 'easytier.exe') {
                        fs.renameSync(path.join(etDir, extracted), etBin);
                    }
                    sendJSON({ success: true });
                } catch (e) {
                    sendJSON({ error: e.message });
                }
                break;
            }

            case '/api/easytier/download-status': {
                sendJSON({ status: 'completed', progress: 100 });
                break;
            }

            case '/api/system/memory-info': {
                const os = require('os');
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const usedMem = totalMem - freeMem;
                sendJSON({
                    totalMB: Math.round(totalMem / 1024 / 1024),
                    usedMB: Math.round(usedMem / 1024 / 1024),
                    freeMB: Math.round(freeMem / 1024 / 1024),
                    loadPercent: Math.round((usedMem / totalMem) * 100)
                });
                break;
            }

            case '/api/save-background': {
                const bgBody = await readBody();
                const bgData = bgBody.dataUrl;
                if (!bgData) { sendJSON({ error: 'dataUrl required' }, 400); break; }
                const bgMatch = bgData.match(/^data:image\/(\w+);base64,(.+)$/);
                if (!bgMatch) { sendJSON({ error: 'invalid dataUrl' }, 400); break; }
                const bgFile = path.join(DATA_DIR, `background.${bgMatch[1] === 'jpeg' ? 'jpg' : bgMatch[1]}`);
                fs.writeFileSync(bgFile, Buffer.from(bgMatch[2], 'base64'));
                sendJSON({ success: true, path: bgFile });
                break;
            }

            case '/api/save-avatar': {
                const avBody = await readBody();
                const avData = avBody.dataUrl;
                if (!avData) { sendJSON({ error: 'dataUrl required' }, 400); break; }
                const avMatch = avData.match(/^data:image\/(\w+);base64,(.+)$/);
                if (!avMatch) { sendJSON({ error: 'invalid dataUrl' }, 400); break; }
                const avFile = path.join(DATA_DIR, `avatar.${avMatch[1] === 'jpeg' ? 'jpg' : avMatch[1]}`);
                fs.writeFileSync(avFile, Buffer.from(avMatch[2], 'base64'));
                sendJSON({ success: true, path: avFile });
                break;
            }

            case '/api/clear-background': {
                const bgFiles = ['background.png', 'background.jpg', 'background.jpeg'].map(f => path.join(DATA_DIR, f));
                for (const f of bgFiles) { if (fs.existsSync(f)) fs.unlinkSync(f); }
                sendJSON({ success: true });
                break;
            }

            case '/api/clear-avatar': {
                const avFiles = ['avatar.png', 'avatar.jpg', 'avatar.jpeg'].map(f => path.join(DATA_DIR, f));
                for (const f of avFiles) { if (fs.existsSync(f)) fs.unlinkSync(f); }
                sendJSON({ success: true });
                break;
            }

            default:
                sendError('Not found', 404);
        }
    } catch (e) {
        console.error('API Error:', e.message);
        sendError(e.message);
    }
}

function fetchJSONWithMethod(urlStr, method, body, headers, _redirectCount) {
    if (!_redirectCount) _redirectCount = 0;
    return new Promise((resolve, reject) => {
        if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }
        const urlObj = new URL(urlStr);
        const isHttps = urlObj.protocol === 'https:';
        const mod = isHttps ? https : http;
        const agent = isHttps ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT;
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            agent: agent,
            headers: {
                'User-Agent': 'VersePC/1.0 (Minecraft Launcher)',
                'Accept': 'application/json',
                ...(headers || {})
            }
        };
        const req = mod.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                res.resume();
                fetchJSONWithMethod(redirectUrl, method, body, headers, _redirectCount + 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode === 429) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
                    const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                    err.isRateLimit = true;
                    err.retryAfter = retryAfter;
                    reject(err);
                });
                return;
            }
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
                    err.httpStatus = res.statusCode;
                    reject(err);
                });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}, data: ${data.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout: ' + urlStr)); });
        if (body) req.write(body);
        req.end();
    });
}

function fetchJSONWithAuth(urlStr, token) {
    return new Promise((resolve, reject) => {
        const req = https.get(urlStr, {
            headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'VersePC/1.0' }
        }, (res) => {
            if (res.statusCode === 429) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
                    const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
                    err.isRateLimit = true;
                    err.retryAfter = retryAfter;
                    reject(err);
                });
                return;
            }
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', chunk => errData += chunk);
                res.on('end', () => {
                    const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
                    err.httpStatus = res.statusCode;
                    reject(err);
                });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

function getDirSize(dirPath, depth = 0) {
    if (depth > 20) return 0;
    let size = 0;
    try {
        fs.readdirSync(dirPath).forEach(file => {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) size += getDirSize(filePath, depth + 1);
            else size += stat.size;
        });
    } catch (e) {}
    return size;
}

function analyzeExitCode(code, versionId) {
    const analysis = { code, reason: '', suggestion: '', isCrash: false };

    if (code === 0) {
        analysis.reason = '正常退出';
        analysis.suggestion = '';
        return analysis;
    }

    if (code === 1) {
        analysis.isCrash = true;
        analysis.reason = '游戏异常退出（通用错误）';
        analysis.suggestion = '可能是模组冲突或Java参数问题，请查看崩溃日志';
    } else if (code === -1) {
        analysis.isCrash = true;
        analysis.reason = '游戏进程被强制终止';
        analysis.suggestion = '可能是内存不足或用户手动结束进程';
    } else if (code === 137) {
        analysis.isCrash = true;
        analysis.reason = '内存不足（OOM Killer）';
        analysis.suggestion = '请增加分配内存或减少模组数量';
    } else if (code === 134) {
        analysis.isCrash = true;
        analysis.reason = '程序异常终止（SIGABRT）';
        analysis.suggestion = '可能是JVM内部错误，尝试更新Java版本';
    } else if (code === 139) {
        analysis.isCrash = true;
        analysis.reason = '段错误（SIGSEGV）';
        analysis.suggestion = '可能是JVM崩溃或原生库问题，尝试更新显卡驱动和Java';
    } else if (code === -7 || code === -1073741819) {
        analysis.isCrash = true;
        analysis.reason = 'JVM 崩溃（访问违规）';
        analysis.suggestion = '可能是显卡驱动不兼容或内存损坏，请更新显卡驱动和Java版本，尝试减少分配内存';
    } else {
        analysis.isCrash = true;
        analysis.reason = `异常退出（退出码: ${code}）`;
        analysis.suggestion = '请查看崩溃日志获取更多信息';
    }

    const searchDirs = [];
    if (versionId && resolveVersionIsolation(versionId)) {
        searchDirs.push(path.join(VERSIONS_DIR, versionId, 'crash-reports'));
    }
    const settings = loadSettingsCached();
    searchDirs.push(path.join(settings.gameDir || DATA_DIR, 'crash-reports'));

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort().reverse();
        if (files.length > 0) {
            try {
                const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
                if (content.includes('java.lang.OutOfMemoryError')) {
                    analysis.reason = '内存不足（OutOfMemoryError）';
                    analysis.suggestion = '请在设置中增加最大内存分配';
                } else if (content.includes('UnsupportedClassVersionError') || content.includes('Unsupported major.minor version')) {
                    analysis.reason = 'Java版本不兼容';
                    analysis.suggestion = '游戏需要更高版本的Java，请在设置中更换Java版本';
                } else if (content.includes('java.lang.NoSuchMethodError') || content.includes('NoClassDefFoundError')) {
                    analysis.reason = '模组版本不兼容';
                    analysis.suggestion = '请检查模组是否与当前游戏版本和加载器版本匹配';
                } else if (content.includes('Unable to make protected final') || content.includes('does not export')) {
                    analysis.reason = 'Java版本过高导致模块访问限制';
                    analysis.suggestion = '请降级Java版本或使用Java 8/17启动';
                } else if (content.includes('FMLCommonSetupEvent') || content.includes('fml')) {
                    analysis.reason = 'Forge/Fabric初始化失败';
                    analysis.suggestion = '请检查模组兼容性，尝试移除最近添加的模组';
                } else if (content.includes('ShaderCompilationException') || content.includes('shader')) {
                    analysis.reason = '着色器编译失败';
                    analysis.suggestion = '可能是光影模组问题，尝试移除光影模组';
                } else if (content.includes('Mixin') || content.includes('mixin')) {
                    analysis.reason = 'Mixin注入失败';
                    analysis.suggestion = '可能是模组与当前版本不兼容，检查Mixin相关模组';
                } else if (content.includes('OpenGL') || content.includes('GLFW')) {
                    analysis.reason = '图形驱动问题';
                    analysis.suggestion = '请更新显卡驱动或检查OpenGL支持';
                } else if (content.includes('Invalid paths argument') || content.includes('contained no existing paths')) {
                    analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
                    analysis.suggestion = 'Forge安装不完整，请前往版本设置使用"文件修复"功能，或重新安装该Forge版本';
                }
                analysis.crashLogFile = path.join(dir, files[0]);
                break;
            } catch (e) {}
        }
    }

    return analysis;
}

function logStartupInfo() {
    validateInstalledVersions();
    console.log(`\n  VersePC - Minecraft Launcher`);
    console.log(`  ────────────────────────────────────────`);
    console.log(`  Data:    ${DATA_DIR}`);
    console.log(`  Platform: ${getPlatformKey()}`);
    console.log(`  ────────────────────────────────────────`);

    const installed = getInstalledVersions();
    if (installed.length > 0) {
        console.log(`  Installed:       ${installed.map(v => v.id).join(', ')}`);
    }
    console.log('');

    setTimeout(() => {
        const javaList = [...detectBundledJava(), ...detectSystemJava()];
        if (javaList.length > 0) {
            console.log(`  Java:            ${javaList[0].version} (${javaList[0].path})`);
        } else {
            console.log('  Java:            未检测到');
        }

        getVersionManifest().then(manifest => {
            console.log(`  Latest Release:  ${manifest.latest.release}`);
            console.log(`  Latest Snapshot: ${manifest.latest.snapshot}`);
            console.log(`  Total Versions:  ${manifest.versions.length}`);
        }).catch(() => {
            console.log('  Warning: Could not fetch version manifest (will retry)');
        });
    }, 100);
}
/* @versepc-protected: anti-ai-plagiarism-v1.0 */
