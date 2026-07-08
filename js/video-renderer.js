class VideoRenderer {
    constructor(canvasContainer, placeholderEl) {
        this.canvasContainer = canvasContainer;
        this.placeholderEl = placeholderEl;
        this.canvas = null;
        this.ctx = null;
        // 画布逻辑尺寸（固定不变，如 1920x1080），用于视频渲染
        this.canvasW = 1920;
        this.canvasH = 1080;
        // 画布宽高比
        this.canvasAspectRatio = 16 / 9;
        // 画布在窗口中显示的尺寸（CSS像素，随窗口缩放）
        this.displayW = 0;
        this.displayH = 0;
        this.dpr = 1;

        this.videoPool = [];
        this.poolSize = 20;
        this.clipDecoders = new Map();
        this.activeClips = [];

        this.audioContext = null;
        this.masterGain = null;

        this.timelineClips = [];
        this.currentTime = 0;
        this.isPlaying = false;
        this.playbackRate = 1;

        this.rafId = null;
        this.lastFrameTime = 0;
        this._lastPreloadTime = 0;

        this.isSeeking = false;
        this.pendingSeekTime = -1;

        this.stats = {
            fps: 0,
            frameTime: 0,
            droppedFrames: 0,
            _frameCount: 0,
            _lastFpsUpdate: 0
        };

        this.isPageVisible = true;

        this.init();
    }

    init() {
        // 优先使用 HTML 中已有的 canvas（#previewLayers），如果没有再动态创建
        const existingCanvas = this.canvasContainer.querySelector('canvas');
        if (existingCanvas) {
            this.canvas = existingCanvas;
        } else {
            this.canvas = document.createElement('canvas');
            this.canvas.style.cssText = 'width:100%;height:100%;display:block;position:absolute;top:0;left:0;';
            this.canvasContainer.appendChild(this.canvas);
        }
        
        // canvasContainer 现在是 .preview-canvas 元素
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });

        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());

        // 创建视频池
        for (let i = 0; i < this.poolSize; i++) {
            const video = document.createElement('video');
            video.muted = false;
            video.preload = 'auto';
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            video.style.display = 'none';
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            document.body.appendChild(video);
            this.videoPool.push({
                video: video,
                url: null,
                audioConnected: false,
                lastUsed: 0,
                isBusy: false
            });
        }

        this.lastFrameTime = performance.now();
        this.startLoop();

        document.addEventListener('visibilitychange', () => {
            this.isPageVisible = !document.hidden;
            if (this.isPageVisible && this.isPlaying) {
                this.resumeAudio();
            }
        });
    }

    /**
     * 重置 canvas 的实际像素尺寸为画布逻辑尺寸
     * 这是画布的核心：固定宽高比，只缩放显示，不影响视频渲染的逻辑坐标
     */
    resizeCanvas() {
        if (!this.canvas || !this.canvasContainer) return;
        
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        
        // canvas 的实际像素 = 画布逻辑尺寸 * dpr（用于清晰渲染）
        this.canvas.width = Math.round(this.canvasW * this.dpr);
        this.canvas.height = Math.round(this.canvasH * this.dpr);
        
        // 缩放坐标系到画布逻辑尺寸（视频按画布逻辑坐标渲染）
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        
        // 根据父容器大小，计算画布在屏幕上的显示尺寸（保持比例，不超出容器）
        this._updateCanvasDisplaySize();
        
        console.log('[画布] 逻辑尺寸:', this.canvasW, 'x', this.canvasH, 
                    '| 实际像素:', this.canvas.width, 'x', this.canvas.height,
                    '| 显示尺寸:', Math.round(this.displayW), 'x', Math.round(this.displayH));
    }

    /**
     * 根据父容器（preview-screen）的大小，计算并设置画布的显示尺寸
     * 保证画布保持比例，且不超出容器
     */
    _updateCanvasDisplaySize() {
        // 找到预览窗口父容器（preview-screen）
        const parent = this.canvasContainer.parentElement;
        if (!parent) return;
        
        const parentRect = parent.getBoundingClientRect();
        const parentW = parentRect.width || 640;
        const parentH = parentRect.height || 360;
        const ratio = this.canvasAspectRatio;
        
        // 按比例缩放，确保画布在容器内（类似 object-fit: contain）
        let displayW, displayH;
        if (parentW / parentH > ratio) {
            // 容器更宽，以高度为基准
            displayH = parentH;
            displayW = parentH * ratio;
        } else {
            // 容器更高，以宽度为基准
            displayW = parentW;
            displayH = parentW / ratio;
        }
        
        // 用内联样式设置画布容器的显示尺寸
        this.canvasContainer.style.width = displayW + 'px';
        this.canvasContainer.style.height = displayH + 'px';
        this.canvasContainer.style.aspectRatio = 'auto'; // JS 控制尺寸，CSS 不参与
        
        this.displayW = displayW;
        this.displayH = displayH;
    }

    /**
     * 设置画布比例
     * @param {number} ratioW - 宽比（如 16）
     * @param {number} ratioH - 高比（如 9）
     * @param {number} baseSize - 基础尺寸（短边像素，默认 1080）
     */
    setCanvasRatio(ratioW, ratioH, baseSize = 1080) {
        const ratio = ratioW / ratioH;
        this.canvasAspectRatio = ratio;

        if (ratio >= 1) {
            // 横屏或正方形：以高为基准
            this.canvasH = baseSize;
            this.canvasW = Math.round(baseSize * ratio);
        } else {
            // 竖屏：以宽为基准
            this.canvasW = baseSize;
            this.canvasH = Math.round(baseSize / ratio);
        }

        // 重新调整 canvas 像素
        this.resizeCanvas();

        console.log(`[画布] 设置比例 ${ratioW}:${ratioH}，尺寸 ${this.canvasW} x ${this.canvasH}`);
    }

    /**
     * 进入导出模式（禁用视频自动播放，由导出器手动控制）
     */
    enterExportMode() {
        this.exportMode = true;
        this.isPlaying = false;
        // 暂停所有视频
        for (const [clipId, decoder] of this.clipDecoders) {
            try {
                if (!decoder.video.paused) {
                    decoder.video.pause();
                }
            } catch (e) {}
        }
        console.log('[导出模式] 已进入导出模式');
    }

    /**
     * 退出导出模式
     */
    exitExportMode() {
        this.exportMode = false;
        console.log('[导出模式] 已退出导出模式');
    }

    /**
     * 在指定时间渲染一帧（导出专用，不依赖视频播放）
     * @param {number} time - 时间轴上的时间
     * @returns {Promise<boolean>} - 是否成功渲染
     */
    async renderFrameAt(time) {
        this.currentTime = time;

        // 更新 activeClips
        this.activeClips = this.timelineClips.filter(clip => {
            if (clip.trackIndex >= 100) return false;
            return time >= clip.startTime && time < clip.startTime + clip.duration;
        }).sort((a, b) => b.trackIndex - a.trackIndex);

        if (this.activeClips.length === 0) {
            // 没有片段，清空画布（黑屏）
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);
            return true;
        }

        // 暂停非活动片段
        const activeIds = new Set(this.activeClips.map(c => c.id));
        for (const [clipId, decoder] of this.clipDecoders) {
            if (!activeIds.has(clipId)) {
                try {
                    if (!decoder.video.paused) decoder.video.pause();
                } catch (e) {}
            }
        }

        // 等待所有活动视频帧就绪
        const readyPromises = [];
        for (const clip of this.activeClips) {
            if (clip.material.type !== 'video') continue;
            const decoder = this.clipDecoders.get(clip.id);
            if (!decoder) continue;

            const video = decoder.video;
            const clipOffset = clip.offset || 0;
            const mediaTime = Math.round((clipOffset + (time - clip.startTime)) * 10000) / 10000;

            // 确保视频已加载
            if (video.readyState < 1 && clip.material.url) {
                video.src = clip.material.url;
            }

            // 设置视频时间
            if (Math.abs(video.currentTime - mediaTime) > 0.05) {
                video.currentTime = mediaTime;
            }

            // 暂停视频（导出时不自动播放）
            if (!video.paused) {
                try { video.pause(); } catch (e) {}
            }

            // 等待视频帧就绪
            if (video.readyState >= 2 && !video.seeking) {
                continue;
            }

            readyPromises.push(new Promise((resolve) => {
                const onReady = () => {
                    video.removeEventListener('seeked', onReady);
                    video.removeEventListener('loadeddata', onReady);
                    resolve();
                };
                video.addEventListener('seeked', onReady, { once: true });
                video.addEventListener('loadeddata', onReady, { once: true });
                setTimeout(() => {
                    video.removeEventListener('seeked', onReady);
                    video.removeEventListener('loadeddata', onReady);
                    resolve();
                }, 500);
            }));
        }

        // 等待所有视频就绪
        if (readyPromises.length > 0) {
            await Promise.all(readyPromises);
        }

        // 渲染
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);

        for (const clip of this.activeClips) {
            if (clip.material.type === 'video') {
                this._drawVideoFrameSync(clip, time);
            } else if (clip.material.type === 'image') {
                this.drawImageClip(clip);
            }
        }

        return true;
    }

    /**
     * 同步绘制视频帧（导出专用）
     */
    _drawVideoFrameSync(clip, time) {
        const decoder = this.clipDecoders.get(clip.id);
        if (!decoder) return;

        const video = decoder.video;
        // 导出模式下放宽要求：只要有元数据(readyState >= 1)就尝试绘制
        // 浏览器通常能吐出最近一帧画面，避免黑屏
        if (video.readyState < 1) return;

        const vw = video.videoWidth || 1920;
        const vh = video.videoHeight || 1080;
        const effects = clip.effects || {};

        this.ctx.save();

        const scale = (effects.scale || 100) / 100;
        const posX = effects.posX || 0;
        const posY = effects.posY || 0;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;

        const scaleToFit = Math.min(this.canvasW / vw, this.canvasH / vh);
        const drawW = vw * scaleToFit * scale;
        const drawH = vh * scaleToFit * scale;

        const centerX = this.canvasW / 2 + posX;
        const centerY = this.canvasH / 2 + posY;

        this.ctx.globalAlpha = opacity;
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(rotation);

        const brightness = (effects.brightness || 0) + 100;
        const contrast = (effects.contrast || 0) + 100;
        const saturation = (effects.saturation || 0) + 100;

        if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
            this.ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
        }

        try {
            this.ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
        } catch (e) {
            console.warn('[导出] 视频帧绘制失败:', e);
        }

        this.ctx.restore();
    }

    /**
     * 根据视频原始尺寸自动设置画布比例
     */
    setCanvasRatioFromVideo(videoW, videoH) {
        if (!videoW || !videoH) return;
        const ratioW = Math.round(videoW / Math.min(videoW, videoH) * 100) / 100;
        const ratioH = Math.round(videoH / Math.min(videoW, videoH) * 100) / 100;
        // 简化：取整成整数比
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(Math.round(videoW), Math.round(videoH));
        const w = Math.round(videoW / g);
        const h = Math.round(videoH / g);
        this.setCanvasRatio(w, h, 1080);
    }

    /**
     * 获取当前画布的字符串表示（如 "16:9 (1920 × 1080)"）
     */
    getCanvasRatioText() {
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(this.canvasW, this.canvasH);
        const w = this.canvasW / g;
        const h = this.canvasH / g;
        return `${w}:${h} (${this.canvasW} × ${this.canvasH})`;
    }

    initAudio() {
        if (this.audioContext) return;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 1;
            this.masterGain.connect(this.audioContext.destination);
        } catch (e) {
            console.warn('Web Audio not supported:', e);
        }
    }

    resumeAudio() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }
    }

    getDecoder(clip) {
        const clipId = clip.id;
        const url = clip.material.url;
        
        // 当前活动的 clip 有自己的专属解码器
        const isActive = this.activeClips.some(c => c.id === clipId);
        
        if (this.clipDecoders.has(clipId)) {
            const decoder = this.clipDecoders.get(clipId);
            decoder.lastUsed = Date.now();
            return decoder;
        }

        let poolItem = this.videoPool.find(p => !p.isBusy);
        if (poolItem) {
            poolItem.isBusy = true;
            poolItem.url = url;
            poolItem.clipId = clipId;
            poolItem.lastUsed = Date.now();
            poolItem.audioConnected = false;
            poolItem.video.src = url;
            this.clipDecoders.set(clipId, poolItem);
            return poolItem;
        }

        let oldest = null;
        let oldestTime = Infinity;
        const activeIds = new Set(this.activeClips.map(c => c.id));
        
        for (const [cid, d] of this.clipDecoders) {
            if (activeIds.has(cid)) continue;
            if (d.lastUsed < oldestTime) {
                oldestTime = d.lastUsed;
                oldest = d;
            }
        }
        
        if (oldest) {
            oldest.video.pause();
            this.clipDecoders.delete(oldest.clipId);
            
            oldest.url = url;
            oldest.clipId = clipId;
            oldest.lastUsed = Date.now();
            oldest.audioConnected = false;
            oldest.video.src = url;
            this.clipDecoders.set(clipId, oldest);
            return oldest;
        }

        return null;
    }

    // 连接音频（每个 URL 只能连接一次）
    connectAudio(decoder, volume) {
        if (!this.audioContext || !this.masterGain) return false;
        if (!decoder || decoder.audioConnected) return false;

        const vol = volume ?? 100;

        try {
            const source = this.audioContext.createMediaElementSource(decoder.video);
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = vol / 100;
            source.connect(gainNode);
            gainNode.connect(this.masterGain);
            decoder.audioConnected = true;
            return true;
        } catch (e) {
            console.warn('Audio connect failed:', e.message);
            return false;
        }
    }

    setClips(clips) {
        this.timelineClips = clips;
    }

    seek(time) {
        const wasPlaying = this.isPlaying;
        this.currentTime = Math.max(0, time);
        this.isSeeking = true;
        
        // 立即更新 activeClips 并同步视频
        this.activeClips = this.timelineClips.filter(clip => {
            if (clip.trackIndex >= 100) return false;
            return this.currentTime >= clip.startTime && this.currentTime < clip.startTime + clip.duration;
        }).sort((a, b) => b.trackIndex - a.trackIndex);
        
        // 同步所有活动的视频到正确位置
        this.syncPlayback();
        
        // 如果正在播放，确保视频开始播放
        if (wasPlaying) {
            this._ensurePlaying();
        }
        
        // 预加载
        this.preloadClips();
        
        setTimeout(() => {
            this.isSeeking = false;
        }, 50);
    }
    
    _ensurePlaying() {
        for (const clip of this.activeClips) {
            if (clip.material.type !== 'video') continue;
            const decoder = this.clipDecoders.get(clip.id);
            if (!decoder) continue;
            
            const video = decoder.video;
            if (video.paused) {
                video.play().catch(() => {});
            }
        }
    }

    play() {
        if (this.isPlaying) {
            this.preloadClips();
            return;
        }
        this.isPlaying = true;
        this.isSeeking = false;
        this.initAudio();
        this.resumeAudio();
        
        // 先更新 activeClips，确保 syncPlayback 能找到正确的片段
        this.activeClips = this.timelineClips.filter(clip => {
            if (clip.trackIndex >= 100) return false;
            return this.currentTime >= clip.startTime && this.currentTime < clip.startTime + clip.duration;
        }).sort((a, b) => b.trackIndex - a.trackIndex);
        
        // 立即预加载
        this.preloadClips();
        
        this.lastFrameTime = performance.now();
        this.startLoop();
        this.syncPlayback();
    }

    pause() {
        this.isPlaying = false;
        for (const clip of this.activeClips) {
            if (clip.material.type === 'video') {
                const decoder = this.clipDecoders.get(clip.id);
                if (decoder) {
                    try { decoder.video.pause(); } catch (e) {}
                }
            }
        }
        this.preloadClips();
    }

    setPlaybackRate(rate) {
        this.playbackRate = rate;
    }

    startLoop() {
        if (this.rafId) return;
        const loop = (now) => {
            this.rafId = requestAnimationFrame(loop);
            this.tick(now);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    stopLoop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    tick(now) {
        const deltaTime = now - this.lastFrameTime;
        this.lastFrameTime = now;

        if (!this.isPageVisible) {
            if (this.isPlaying) {
                this.currentTime += (deltaTime / 1000) * this.playbackRate;
            }
            return;
        }

        this.stats._frameCount++;
        if (now - this.stats._lastFpsUpdate >= 1000) {
            this.stats.fps = this.stats._frameCount;
            this.stats._frameCount = 0;
            this.stats._lastFpsUpdate = now;
        }

        // 播放时更新时间
        if (this.isPlaying) {
            this.currentTime += (deltaTime / 1000) * this.playbackRate;
        }

        // 导出模式下不自动渲染（由 renderFrameAt 控制）
        if (this.exportMode) {
            return;
        }

        this.renderFrame();
        
        // 持续预加载（每200ms）
        if (now - this._lastPreloadTime > 200) {
            this._lastPreloadTime = now;
            this.preloadClips();
        }
    }

    preloadClips() {
        const currentTime = this.currentTime;
        const preloadWindow = 30;
        
        const activeClipIds = new Set(this.activeClips.map(c => c.id));
        
        const clipsToPreload = this.timelineClips
            .filter(clip => {
                const clipEnd = clip.startTime + clip.duration;
                if (clip.startTime <= currentTime && clipEnd > currentTime) {
                    return false;
                }
                if (activeClipIds.has(clip.id)) {
                    return false;
                }
                return clip.startTime >= currentTime && clip.startTime <= currentTime + preloadWindow;
            })
            .map(clip => {
                const dist = clip.startTime - currentTime;
                return { clip, dist };
            })
            .sort((a, b) => a.dist - b.dist);

        const maxPreload = Math.min(clipsToPreload.length, this.poolSize);
        
        const now = Date.now();
        for (let i = 0; i < maxPreload; i++) {
            const { clip } = clipsToPreload[i];
            if (clip.material.type === 'video') {
                const decoder = this.getDecoder(clip);
                if (decoder) {
                    decoder.lastUsed = now + 10000;
                    
                    if (decoder.video.readyState >= 1) {
                        if (!decoder._lastPreloadSeek || now - decoder._lastPreloadSeek > 2000) {
                            try {
                                const clipOffset = clip.offset || 0;
                                const mediaTime = Math.round((clipOffset + Math.max(0, currentTime - clip.startTime)) * 10000) / 10000;
                                if (Math.abs(decoder.video.currentTime - mediaTime) > 2.0) {
                                    decoder.video.currentTime = mediaTime;
                                    decoder._lastPreloadSeek = now;
                                }
                            } catch (e) {}
                        }
                    }
                }
            }
        }
    }

    renderFrame() {
        if (!this.ctx || !this.canvas) return;

        this.ensureCanvasSize();

        // 获取当前活动的片段
        this.activeClips = this.timelineClips.filter(clip => {
            if (clip.trackIndex >= 100) return false;
            return this.currentTime >= clip.startTime && this.currentTime < clip.startTime + clip.duration;
        }).sort((a, b) => b.trackIndex - a.trackIndex); // 按轨道排序

        // 暂停所有非活动 clip 的视频（防止声音叠加）
        const activeIds = new Set(this.activeClips.map(c => c.id));
        const now = performance.now();
        if (!this._lastInactivePause || now - this._lastInactivePause > 100) {
            this._lastInactivePause = now;
            for (const [clipId, decoder] of this.clipDecoders) {
                if (!activeIds.has(clipId)) {
                    if (!decoder.video.paused) {
                        try { decoder.video.pause(); } catch (e) {}
                    }
                }
            }
        }

        if (this.activeClips.length === 0) {
            this.clearCanvas();
            if (this.placeholderEl) {
                this.placeholderEl.style.display = 'flex';
            }
            return;
        }

        if (this.placeholderEl) {
            this.placeholderEl.style.display = 'none';
        }

        // 检查是否所有活动视频都已就绪（防止闪烁）
        // 如果有视频正在 seek 或加载中，跳过这一帧，保持上一帧画面
        let allReady = true;
        for (const clip of this.activeClips) {
            if (clip.material.type !== 'video') continue;
            const decoder = this.clipDecoders.get(clip.id);
            if (!decoder) {
                allReady = false;
                break;
            }
            const video = decoder.video;
            // 导出模式下放宽要求：只要有元数据(readyState >= 1)就认为就绪
            // 预览模式保持严格检查，防止闪烁
            if (this.exportMode) {
                if (video.readyState < 1) {
                    allReady = false;
                    break;
                }
            } else {
                // seeking 或 readyState < 2 都算未就绪
                if (video.seeking || video.readyState < 2) {
                    allReady = false;
                    break;
                }
            }
        }

        // 未全部就绪时，最多等待 3 帧，避免长时间卡住
        if (!allReady) {
            this._pendingFrameCount = (this._pendingFrameCount || 0) + 1;
            if (this._pendingFrameCount < 3) {
                return; // 跳过这一帧，保持上一帧画面
            }
        }
        this._pendingFrameCount = 0;

        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);

        for (const clip of this.activeClips) {
            const clipOffset = clip.offset || 0;
            const mediaTime = Math.round((clipOffset + (this.currentTime - clip.startTime)) * 10000) / 10000;

            if (clip.material.type === 'video') {
                this.drawVideoClip(clip, mediaTime);
            } else if (clip.material.type === 'image') {
                this.drawImageClip(clip);
            }
        }
    }

    ensureCanvasSize() {
        // 画布逻辑尺寸是固定的，不需要根据容器大小调整
        // 只需要确保 canvas 实际像素与画布逻辑尺寸一致即可
        if (!this.canvas) return;
        const expectedW = Math.round(this.canvasW * this.dpr);
        const expectedH = Math.round(this.canvasH * this.dpr);
        if (this.canvas.width !== expectedW || this.canvas.height !== expectedH) {
            this.resizeCanvas();
        }
    }

    drawVideoClip(clip, mediaTime) {
        if (!this.ctx) return false;

        const decoder = this.getDecoder(clip);
        if (!decoder) return false;

        const video = decoder.video;
        const effects = clip.effects || {};

        if (video.readyState < 1) {
            if (!video.src || video.src === '') {
                video.src = clip.material.url;
            }
            return false;
        }

        // 导出模式下不调用 video.play()，由 renderFrameAt 直接控制
        if (this.exportMode) {
            // 确保视频已暂停
            if (!video.paused) {
                try { video.pause(); } catch (e) {}
            }
            // 设置视频时间（如果需要）
            if (Math.abs(video.currentTime - mediaTime) > 0.05) {
                try { video.currentTime = mediaTime; } catch (e) {}
            }
        } else if (this.isPlaying) {
            const rate = this.playbackRate * (effects.speed || 1);
            try {
                if (video.playbackRate !== rate) {
                    video.playbackRate = rate;
                }
                
                if (this.isSeeking) {
                    video.currentTime = mediaTime;
                    clip._lastSyncedTime = mediaTime;
                    clip._syncDriftAccum = 0;
                } else {
                    const diff = video.currentTime - mediaTime;
                    if (Math.abs(diff) > 2.0) {
                        video.currentTime = mediaTime;
                        clip._lastSyncedTime = mediaTime;
                        clip._syncDriftAccum = 0;
                    } else if (Math.abs(diff) > 0.3) {
                        const adjustedRate = rate * (1 - diff * 0.1);
                        try {
                            if (video.playbackRate !== adjustedRate && adjustedRate > 0.1 && adjustedRate < 10) {
                                video.playbackRate = adjustedRate;
                            }
                        } catch (e) {}
                    } else {
                        try {
                            if (video.playbackRate !== rate) {
                                video.playbackRate = rate;
                            }
                        } catch (e) {}
                    }
                }
                
                if (video.paused) {
                    video.play().then(() => {
                        this.connectAudio(decoder, effects.volume ?? 100);
                    }).catch(() => {});
                } else {
                    this.connectAudio(decoder, effects.volume ?? 100);
                }
            } catch (e) {}
        } else {
            try {
                if (!video.paused) video.pause();
                
                if (this.isSeeking) {
                    video.currentTime = mediaTime;
                    clip._lastPausedMediaTime = mediaTime;
                    clip._syncDriftAccum = 0;
                } else {
                    const lastPausedTime = clip._lastPausedMediaTime ?? -1;
                    if (Math.abs(mediaTime - lastPausedTime) > 0.01) {
                        if (Math.abs(video.currentTime - mediaTime) > 0.033) {
                            video.currentTime = mediaTime;
                        }
                        clip._lastPausedMediaTime = mediaTime;
                    }
                }
            } catch (e) {}
        }

        if (video.readyState < 2) return false;

        const vw = video.videoWidth || 1920;
        const vh = video.videoHeight || 1080;

        this.ctx.save();

        const scale = (effects.scale || 100) / 100;
        const posX = effects.posX || 0;
        const posY = effects.posY || 0;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;

        const scaleToFit = Math.min(this.canvasW / vw, this.canvasH / vh);
        const drawW = vw * scaleToFit * scale;
        const drawH = vh * scaleToFit * scale;

        const centerX = this.canvasW / 2 + posX;
        const centerY = this.canvasH / 2 + posY;

        this.ctx.globalAlpha = opacity;
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(rotation);

        const brightness = (effects.brightness || 0) + 100;
        const contrast = (effects.contrast || 0) + 100;
        const saturation = (effects.saturation || 0) + 100;

        if (brightness !== 100 || contrast !== 100 || saturation !== 100) {
            this.ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
        }

        this.ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);

        this.ctx.restore();
        
        return true;
    }

    syncPlayback() {
        for (const clip of this.activeClips) {
            if (clip.material.type !== 'video') continue;
            const decoder = this.clipDecoders.get(clip.id);
            if (!decoder) continue;
            
            const video = decoder.video;
            const clipOffset = clip.offset || 0;
            const mediaTime = Math.round((clipOffset + (this.currentTime - clip.startTime)) * 10000) / 10000;
            const effects = clip.effects || {};
            
            try {
                if (this.isPlaying) {
                    if (video.readyState >= 1) {
                        video.currentTime = mediaTime;
                        video.playbackRate = this.playbackRate * (effects.speed || 1);
                    }
                    if (video.paused) {
                        video.play().then(() => {
                            this.connectAudio(decoder, effects.volume ?? 100);
                        }).catch(() => {});
                    } else {
                        this.connectAudio(decoder, effects.volume ?? 100);
                    }
                } else {
                    if (video.readyState >= 1) {
                        video.currentTime = mediaTime;
                    }
                    if (!video.paused) video.pause();
                }
            } catch (e) {}
        }
    }

    pauseAllVideos() {
        for (const [, decoder] of this.clipDecoders) {
            try { decoder.video.pause(); } catch (e) {}
        }
    }

    clearCanvas() {
        if (!this.ctx || !this.canvas) return;
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvasW, this.canvasH);
    }

    drawImageClip(clip) {
        if (!this.ctx) return;

        const cacheKey = 'img_' + clip.material.id;
        let img = this._imageCache?.get(cacheKey);
        if (!img) {
            img = new Image();
            img.src = clip.material.url;
            if (!this._imageCache) this._imageCache = new Map();
            this._imageCache.set(cacheKey, img);
        }

        if (!img.complete || !img.naturalWidth) return;

        const effects = clip.effects || {};
        
        this.ctx.save();

        const scale = (effects.scale || 100) / 100;
        const posX = effects.posX || 0;
        const posY = effects.posY || 0;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;

        const scaleToFit = Math.min(this.canvasW / img.naturalWidth, this.canvasH / img.naturalHeight);
        const drawW = img.naturalWidth * scaleToFit * scale;
        const drawH = img.naturalHeight * scaleToFit * scale;

        const centerX = this.canvasW / 2 + posX;
        const centerY = this.canvasH / 2 + posY;

        this.ctx.globalAlpha = opacity;
        this.ctx.translate(centerX, centerY);
        this.ctx.rotate(rotation);
        this.ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);

        this.ctx.restore();
    }

    getStats() {
        return { ...this.stats };
    }

    destroy() {
        this.stopLoop();
        
        for (const poolItem of this.videoPool) {
            try { poolItem.video.pause(); } catch (e) {}
            try { poolItem.video.src = ''; } catch (e) {}
            try { poolItem.video.remove(); } catch (e) {}
        }
        this.videoPool = [];
        this.clipDecoders.clear();
        
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (e) {}
        }
        
        if (this.canvas) {
            try { this.canvas.remove(); } catch (e) {}
        }
        
        this._imageCache?.clear();
    }
}
