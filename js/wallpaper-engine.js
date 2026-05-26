function wpfilePath(filePath) {
    if (!filePath) return '';
    if (filePath.startsWith('wpfile://')) return filePath;
    return 'wpfile:///' + filePath.replace(/\\/g, '/');
}

class WallpaperEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.glCanvas = document.getElementById('wallpaper-canvas-gl');
        this.animationId = null;
        this.isRunning = false;
        this.mouseX = 0;
        this.mouseY = 0;
        this.lastTime = 0;
        this.isDarkTheme = true;
        this.currentMode = 'starry';
        this.renderer = null;
        this.transitionAlpha = 1;
        this.transitioning = false;
        this.wallpaperOpacity = 1;
        this.wallpaperBlur = 0;
        this.wallpaperFitMode = 'cover';
        this.customImagePath = null;
        this.customVideoPath = null;
        this.wallpaperBrightness = 0;
        this._brightnessCallback = null;

        this._onResize = this._onResize.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._animate = this._animate.bind(this);
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this._initRenderer();

        window.addEventListener('resize', this._onResize);
        window.addEventListener('mousemove', this._onMouseMove);

        this.lastTime = performance.now();
        this._animate(this.lastTime);
    }

    stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        window.removeEventListener('resize', this._onResize);
        window.removeEventListener('mousemove', this._onMouseMove);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    setTheme(isDark) {
        this.isDarkTheme = isDark;
        if (this.renderer && this.renderer.setTheme) {
            this.renderer.setTheme(isDark);
        }
    }

    switchMode(mode) {
        if (this.currentMode === mode) return;
        this.currentMode = mode;
        if (this.isRunning) {
            this.transitioning = true;
            this.transitionAlpha = 0;
            this._initRenderer();
        }
    }

    onBrightnessChange(callback) {
        this._brightnessCallback = callback;
    }

    _notifyBrightness(brightness) {
        this.wallpaperBrightness = brightness;
        if (this._brightnessCallback) {
            this._brightnessCallback(brightness);
        }
    }

    _initRenderer() {
        this._onResize();

        if (this.renderer && this.renderer.destroy) {
            this.renderer.destroy();
        }

        const isGL = this.currentMode === 'panorama';
        this.canvas.style.display = isGL ? 'none' : 'block';
        if (this.glCanvas) this.glCanvas.style.display = isGL ? 'block' : 'none';

        const factories = {
            starry: () => new StarryRenderer(this),
            panorama: () => new PanoramaRenderer(this),
            customImage: () => new CustomImageRenderer(this),
            customVideo: () => new CustomVideoRenderer(this)
        };
        this.renderer = (factories[this.currentMode] || factories.starry)();

        if (this.currentMode === 'starry') {
            this._notifyBrightness(0);
        } else if (this.currentMode === 'panorama') {
            this._notifyBrightness(0.5);
        }
    }

    _onResize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        if (this.renderer && this.renderer.onResize) {
            this.renderer.onResize();
        }
    }

    _onMouseMove(e) {
        this.mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
        this.mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    }

    _animate(timestamp) {
        if (!this.isRunning) return;
        const dt = Math.min(timestamp - this.lastTime, 50);
        this.lastTime = timestamp;

        if (this.transitioning) {
            this.transitionAlpha = Math.min(1, this.transitionAlpha + dt * 0.003);
            if (this.transitionAlpha >= 1) this.transitioning = false;
        }

        if (this.renderer) {
            this.renderer.render(dt, timestamp);
        }

        if (this.transitioning && this.currentMode !== 'panorama') {
            this.ctx.fillStyle = `rgba(10, 10, 10, ${1 - this.transitionAlpha})`;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        this.animationId = requestAnimationFrame(this._animate);
    }
}

function drawFitMode(ctx, source, sourceW, sourceH, canvasW, canvasH, fitMode) {
    let mode = fitMode || 'cover';
    if (mode === 'smart') {
        mode = (sourceW < canvasW / 2 && sourceH < canvasH / 2) ? 'tile' : 'cover';
    }

    switch (mode) {
        case 'center': {
            ctx.drawImage(source, (canvasW - sourceW) / 2, (canvasH - sourceH) / 2, sourceW, sourceH);
            break;
        }
        case 'cover': {
            const scale = Math.max(canvasW / sourceW, canvasH / sourceH);
            const sw = sourceW * scale;
            const sh = sourceH * scale;
            ctx.drawImage(source, (canvasW - sw) / 2, (canvasH - sh) / 2, sw, sh);
            break;
        }
        case 'stretch': {
            ctx.drawImage(source, 0, 0, canvasW, canvasH);
            break;
        }
        case 'tile': {
            for (let ty = 0; ty < canvasH; ty += sourceH) {
                for (let tx = 0; tx < canvasW; tx += sourceW) {
                    ctx.drawImage(source, tx, ty, sourceW, sourceH);
                }
            }
            break;
        }
        case 'topLeft': {
            ctx.drawImage(source, 0, 0, sourceW, sourceH);
            break;
        }
        case 'topRight': {
            ctx.drawImage(source, canvasW - sourceW, 0, sourceW, sourceH);
            break;
        }
        case 'bottomLeft': {
            ctx.drawImage(source, 0, canvasH - sourceH, sourceW, sourceH);
            break;
        }
        case 'bottomRight': {
            ctx.drawImage(source, canvasW - sourceW, canvasH - sourceH, sourceW, sourceH);
            break;
        }
        default: {
            const scale = Math.max(canvasW / sourceW, canvasH / sourceH);
            const sw = sourceW * scale;
            const sh = sourceH * scale;
            ctx.drawImage(source, (canvasW - sw) / 2, (canvasH - sh) / 2, sw, sh);
        }
    }
}

class StarryRenderer {
    constructor(engine) {
        this.engine = engine;
        this.particles = [];
        this.shootingStars = [];
        this.nebulaClouds = [];
        this.STAR_COUNT = 280;
        this.SHOOTING_STAR_INTERVAL = 4000;
        this.NEBULA_COUNT = 4;
        this.lastShootingStarTime = 0;
        this._initParticles();
        this._initNebula();
    }

    setTheme() { this._initNebula(); }
    onResize() { this._initNebula(); }

    _initParticles() {
        this.particles = [];
        for (let i = 0; i < this.STAR_COUNT; i++) {
            this.particles.push(this._createStar());
        }
    }

    _createStar() {
        const layer = Math.random();
        let size, speed, brightness;
        if (layer < 0.6) { size = Math.random() * 1.2 + 0.3; speed = Math.random() * 0.08 + 0.01; brightness = Math.random() * 0.4 + 0.2; }
        else if (layer < 0.9) { size = Math.random() * 1.8 + 0.8; speed = Math.random() * 0.15 + 0.05; brightness = Math.random() * 0.5 + 0.4; }
        else { size = Math.random() * 2.5 + 1.2; speed = Math.random() * 0.25 + 0.1; brightness = Math.random() * 0.3 + 0.7; }
        return { x: Math.random() * this.engine.canvas.width, y: Math.random() * this.engine.canvas.height, size, speed, brightness, baseBrightness: brightness, twinkleSpeed: Math.random() * 0.02 + 0.005, twinkleOffset: Math.random() * Math.PI * 2, parallaxFactor: speed * 3, color: this._getStarColor() };
    }

    _getStarColor() {
        const r = Math.random();
        if (r < 0.6) return { r: 255, g: 255, b: 255 };
        if (r < 0.75) return { r: 200, g: 220, b: 255 };
        if (r < 0.85) return { r: 255, g: 240, b: 200 };
        if (r < 0.93) return { r: 180, g: 200, b: 255 };
        return { r: 255, g: 200, b: 180 };
    }

    _initNebula() {
        this.nebulaClouds = [];
        for (let i = 0; i < this.NEBULA_COUNT; i++) {
            this.nebulaClouds.push({ x: Math.random() * this.engine.canvas.width, y: Math.random() * this.engine.canvas.height, radius: Math.random() * 250 + 150, opacity: Math.random() * 0.03 + 0.01, driftX: (Math.random() - 0.5) * 0.1, driftY: (Math.random() - 0.5) * 0.05, hue: this.engine.isDarkTheme ? (Math.random() * 60 + 200) : (Math.random() * 40 + 200) });
        }
    }

    _createShootingStar() {
        const angle = Math.random() * 0.5 + 0.3;
        const speed = Math.random() * 8 + 6;
        return { x: Math.random() * this.engine.canvas.width * 0.8, y: Math.random() * this.engine.canvas.height * 0.4, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1.0, decay: Math.random() * 0.015 + 0.01, length: Math.random() * 60 + 40, width: Math.random() * 1.5 + 0.5 };
    }

    render(dt, timestamp) {
        const ctx = this.engine.ctx;
        const w = this.engine.canvas.width;
        const h = this.engine.canvas.height;
        const mx = this.engine.mouseX;
        const my = this.engine.mouseY;
        const dark = this.engine.isDarkTheme;

        ctx.fillStyle = dark ? '#0a0a0a' : '#ffffff';
        ctx.fillRect(0, 0, w, h);

        for (const cloud of this.nebulaClouds) {
            cloud.x += cloud.driftX * dt * 0.01;
            cloud.y += cloud.driftY * dt * 0.01;
            if (cloud.x > w + cloud.radius) cloud.x = -cloud.radius;
            if (cloud.x < -cloud.radius) cloud.x = w + cloud.radius;
            if (cloud.y > h + cloud.radius) cloud.y = -cloud.radius;
            if (cloud.y < -cloud.radius) cloud.y = h + cloud.radius;
            const px = cloud.x + mx * 5;
            const py = cloud.y + my * 5;
            const gradient = ctx.createRadialGradient(px, py, 0, px, py, cloud.radius);
            if (dark) {
                gradient.addColorStop(0, `hsla(${cloud.hue}, 40%, 50%, ${cloud.opacity})`);
                gradient.addColorStop(0.5, `hsla(${cloud.hue}, 30%, 30%, ${cloud.opacity * 0.5})`);
            } else {
                gradient.addColorStop(0, `hsla(${cloud.hue}, 30%, 70%, ${cloud.opacity * 0.5})`);
                gradient.addColorStop(0.5, `hsla(${cloud.hue}, 20%, 80%, ${cloud.opacity * 0.2})`);
            }
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.fillRect(px - cloud.radius, py - cloud.radius, cloud.radius * 2, cloud.radius * 2);
        }

        for (const star of this.particles) {
            star.twinkleOffset += star.twinkleSpeed * dt * 0.1;
            star.brightness = Math.max(0.05, Math.min(1, star.baseBrightness + Math.sin(star.twinkleOffset) * 0.2));
            const px = star.x + mx * star.parallaxFactor;
            const py = star.y + my * star.parallaxFactor;
            const drawX = ((px % w) + w) % w;
            const drawY = ((py % h) + h) % h;
            const alpha = dark ? star.brightness : star.brightness * 0.3;
            const { r, g, b } = star.color;
            ctx.beginPath();
            ctx.arc(drawX, drawY, star.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            ctx.fill();
            if (star.size > 1.5 && star.brightness > 0.6) {
                const gs = star.size * 3;
                const grad = ctx.createRadialGradient(drawX, drawY, 0, drawX, drawY, gs);
                grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.15})`);
                grad.addColorStop(1, 'transparent');
                ctx.fillStyle = grad;
                ctx.fillRect(drawX - gs, drawY - gs, gs * 2, gs * 2);
            }
        }

        if (timestamp - this.lastShootingStarTime > this.SHOOTING_STAR_INTERVAL) {
            this.shootingStars.push(this._createShootingStar());
            this.lastShootingStarTime = timestamp;
        }
        for (let i = this.shootingStars.length - 1; i >= 0; i--) {
            const ss = this.shootingStars[i];
            ss.x += ss.vx * dt * 0.1;
            ss.y += ss.vy * dt * 0.1;
            ss.life -= ss.decay * dt * 0.1;
            if (ss.life <= 0) { this.shootingStars.splice(i, 1); continue; }
            const alpha = dark ? ss.life * 0.8 : ss.life * 0.3;
            const tailX = ss.x - ss.vx * ss.length / 10;
            const tailY = ss.y - ss.vy * ss.length / 10;
            const grad = ctx.createLinearGradient(tailX, tailY, ss.x, ss.y);
            grad.addColorStop(0, 'transparent');
            grad.addColorStop(0.7, `rgba(255,255,255,${alpha * 0.3})`);
            grad.addColorStop(1, `rgba(255,255,255,${alpha})`);
            ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(ss.x, ss.y);
            ctx.strokeStyle = grad; ctx.lineWidth = ss.width; ctx.lineCap = 'round'; ctx.stroke();
            ctx.beginPath(); ctx.arc(ss.x, ss.y, ss.width + 1, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${alpha * 0.6})`; ctx.fill();
        }
    }
}


class PanoramaRenderer {
    constructor(engine) {
        this.engine = engine;
        this.threeScene = null;
        this.threeCamera = null;
        this.threeRenderer = null;
        this.cube = null;
        this.loaded = false;
        this.autoRotation = 0;
        this.ROTATION_SPEED = 0.0003;
        this._initThree();
    }

    setTheme() {}
    onResize() { this._onThreeResize(); }

    _initThree() {
        const glCanvas = this.engine.glCanvas;
        if (!glCanvas || typeof THREE === 'undefined') {
            console.error('[PanoramaRenderer] WebGL canvas or THREE.js not available');
            return;
        }

        try {
            this.threeScene = new THREE.Scene();
            this.threeCamera = new THREE.PerspectiveCamera(75, glCanvas.clientWidth / glCanvas.clientHeight, 0.1, 1000);
            this.threeCamera.position.set(0, 0, 0);

            this.threeRenderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: false, antialias: true });
            this.threeRenderer.setSize(glCanvas.clientWidth, glCanvas.clientHeight);
            this.threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.threeRenderer.setClearColor(0x0a0a0a);

            const loader = new THREE.TextureLoader();
            const basePath = 'img/panorama/';
            const faceOrder = [1, 3, 4, 5, 0, 2];
            const materials = faceOrder.map(i => {
                const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x0a0a0a });
                loader.load(basePath + 'panorama_' + i + '.png', (texture) => {
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.minFilter = THREE.LinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    mat.map = texture;
                    mat.color = new THREE.Color(0xffffff);
                    mat.needsUpdate = true;
                    this.loaded = true;
                });
                return mat;
            });

            const geometry = new THREE.BoxGeometry(10, 10, 10);
            this.cube = new THREE.Mesh(geometry, materials);
            this.threeScene.add(this.cube);
        } catch (e) {
            console.error('[PanoramaRenderer] Three.js init error:', e);
        }
    }

    _onThreeResize() {
        if (!this.threeRenderer) return;
        const glCanvas = this.engine.glCanvas;
        if (!glCanvas) return;
        this.threeRenderer.setSize(glCanvas.clientWidth, glCanvas.clientHeight);
        this.threeCamera.aspect = glCanvas.clientWidth / glCanvas.clientHeight;
        this.threeCamera.updateProjectionMatrix();
    }

    render(dt, timestamp) {
        if (!this.threeRenderer || !this.cube) return;

        this.autoRotation += this.ROTATION_SPEED * dt * 0.06;

        const mouseInfluenceY = this.engine.mouseX * 0.4;
        const mouseInfluenceX = -this.engine.mouseY * 0.2;

        this.cube.rotation.y = this.autoRotation + mouseInfluenceY;
        this.cube.rotation.x = mouseInfluenceX;

        this.threeRenderer.render(this.threeScene, this.threeCamera);
    }

    destroy() {
        if (this.threeRenderer) {
            this.threeRenderer.dispose();
        }
        if (this.cube) {
            this.cube.geometry.dispose();
            this.cube.material.forEach(m => {
                if (m.map) m.map.dispose();
                m.dispose();
            });
        }
    }
}

class CustomImageRenderer {
    constructor(engine) {
        this.engine = engine;
        this.image = null;
        this.loaded = false;
        this._lastBrightness = -1;
        this._brightnessSampleCanvas = document.createElement('canvas');
        this._brightnessSampleCanvas.width = 32;
        this._brightnessSampleCanvas.height = 32;
        this._brightnessSampleCtx = this._brightnessSampleCanvas.getContext('2d', { willReadFrequently: true });
        if (engine.customImagePath) {
            this.loadImage(engine.customImagePath);
        }
    }

    setTheme() {}
    onResize() {}

    loadImage(filePath) {
        this.loaded = false;
        this._lastBrightness = -1;
        this.image = new Image();
        this.image.onload = () => {
            this.loaded = true;
            this._sampleBrightness();
        };
        this.image.onerror = () => { this.loaded = false; this.image = null; };
        this.image.src = wpfilePath(filePath);
    }

    _sampleBrightness() {
        if (!this.loaded || !this.image) return;
        try {
            const sCtx = this._brightnessSampleCtx;
            sCtx.drawImage(this.image, 0, 0, 32, 32);
            const data = sCtx.getImageData(0, 0, 32, 32).data;
            let total = 0;
            const pixelCount = 32 * 32;
            for (let i = 0; i < data.length; i += 4) {
                total += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
            }
            const brightness = total / pixelCount / 255;
            this._lastBrightness = brightness;
            this.engine._notifyBrightness(brightness);
        } catch (e) {
            this.engine._notifyBrightness(0.5);
        }
    }

    render(dt, timestamp) {
        const ctx = this.engine.ctx;
        const w = this.engine.canvas.width;
        const h = this.engine.canvas.height;

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, w, h);

        if (!this.loaded || !this.image) return;

        const opacity = this.engine.wallpaperOpacity != null ? this.engine.wallpaperOpacity : 1;
        const blur = this.engine.wallpaperBlur || 0;

        ctx.save();
        ctx.globalAlpha = opacity;

        if (blur > 0) {
            ctx.filter = `blur(${blur}px)`;
            const margin = blur * 2;
            ctx.translate(-margin, -margin);
            ctx.scale(1 + margin * 2 / w, 1 + margin * 2 / h);
        }

        const imgW = this.image.naturalWidth;
        const imgH = this.image.naturalHeight;
        drawFitMode(ctx, this.image, imgW, imgH, w, h, this.engine.wallpaperFitMode || 'smart');
        ctx.restore();
    }

    destroy() {
        this.image = null;
        this.loaded = false;
    }
}

class CustomVideoRenderer {
    constructor(engine) {
        this.engine = engine;
        this.video = null;
        this.loaded = false;
        this._lastBrightness = -1;
        this._brightnessSampleCanvas = document.createElement('canvas');
        this._brightnessSampleCanvas.width = 32;
        this._brightnessSampleCanvas.height = 32;
        this._brightnessSampleCtx = this._brightnessSampleCanvas.getContext('2d', { willReadFrequently: true });
        this._brightnessCheckInterval = null;
        if (engine.customVideoPath) {
            this.loadVideo(engine.customVideoPath);
        }
    }

    setTheme() {}
    onResize() {}

    loadVideo(filePath) {
        this.loaded = false;
        this._lastBrightness = -1;
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        if (this._brightnessCheckInterval) {
            clearInterval(this._brightnessCheckInterval);
            this._brightnessCheckInterval = null;
        }
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.loop = true;
        this.video.playsInline = true;
        this.video.preload = 'auto';
        this.video.oncanplay = () => {
            this.loaded = true;
            this.video.play().catch(() => {});
            this._startBrightnessSampling();
        };
        this.video.onerror = () => { this.loaded = false; };
        this.video.src = wpfilePath(filePath);
    }

    _startBrightnessSampling() {
        if (this._brightnessCheckInterval) clearInterval(this._brightnessCheckInterval);
        this._brightnessCheckInterval = setInterval(() => {
            this._sampleBrightness();
        }, 2000);
        this._sampleBrightness();
    }

    _sampleBrightness() {
        if (!this.loaded || !this.video || this.video.paused) return;
        try {
            const sCtx = this._brightnessSampleCtx;
            sCtx.drawImage(this.video, 0, 0, 32, 32);
            const data = sCtx.getImageData(0, 0, 32, 32).data;
            let total = 0;
            const pixelCount = 32 * 32;
            for (let i = 0; i < data.length; i += 4) {
                total += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
            }
            const brightness = total / pixelCount / 255;
            if (Math.abs(brightness - this._lastBrightness) > 0.05) {
                this._lastBrightness = brightness;
                this.engine._notifyBrightness(brightness);
            }
        } catch (e) {}
    }

    render(dt, timestamp) {
        const ctx = this.engine.ctx;
        const w = this.engine.canvas.width;
        const h = this.engine.canvas.height;

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, w, h);

        if (!this.loaded || !this.video || this.video.paused) return;

        const opacity = this.engine.wallpaperOpacity != null ? this.engine.wallpaperOpacity : 1;
        const blur = this.engine.wallpaperBlur || 0;

        ctx.save();
        ctx.globalAlpha = opacity;

        if (blur > 0) {
            ctx.filter = `blur(${blur}px)`;
            const margin = blur * 2;
            ctx.translate(-margin, -margin);
            ctx.scale(1 + margin * 2 / w, 1 + margin * 2 / h);
        }

        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        if (!vw || !vh) { ctx.restore(); return; }

        drawFitMode(ctx, this.video, vw, vh, w, h, this.engine.wallpaperFitMode || 'cover');
        ctx.restore();
    }

    destroy() {
        if (this._brightnessCheckInterval) {
            clearInterval(this._brightnessCheckInterval);
            this._brightnessCheckInterval = null;
        }
        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
            this.video = null;
        }
        this.loaded = false;
    }
}

let wallpaperEngine = null;

function initWallpaper() {
    const canvas = document.getElementById('wallpaper-canvas');
    if (!canvas) return;
    wallpaperEngine = new WallpaperEngine(canvas);
    wallpaperEngine.start();
}

function updateWallpaperTheme(isDark) {
    if (wallpaperEngine) wallpaperEngine.setTheme(isDark);
}

function switchWallpaperMode(mode) {
    if (wallpaperEngine) wallpaperEngine.switchMode(mode);
}

function setCustomWallpaperImage(filePath) {
    if (wallpaperEngine) {
        wallpaperEngine.customImagePath = filePath;
        if (wallpaperEngine.currentMode === 'customImage' && wallpaperEngine.renderer) {
            wallpaperEngine.renderer.loadImage(filePath);
        }
    }
}

function setCustomWallpaperVideo(filePath) {
    if (wallpaperEngine) {
        wallpaperEngine.customVideoPath = filePath;
        if (wallpaperEngine.currentMode === 'customVideo' && wallpaperEngine.renderer) {
            wallpaperEngine.renderer.loadVideo(filePath);
        }
    }
}

function setWallpaperOpacity(value) {
    if (wallpaperEngine) wallpaperEngine.wallpaperOpacity = value;
}

function setWallpaperBlur(value) {
    if (wallpaperEngine) wallpaperEngine.wallpaperBlur = value;
}

function setWallpaperFitMode(mode) {
    if (wallpaperEngine) wallpaperEngine.wallpaperFitMode = mode;
}

function onWallpaperBrightnessChange(callback) {
    if (wallpaperEngine) wallpaperEngine.onBrightnessChange(callback);
}
