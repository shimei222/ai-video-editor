class VideoEngine {
    constructor(canvasContainer, placeholderEl) {
        this.canvasContainer = canvasContainer;
        this.placeholderEl = placeholderEl;
        this.canvas = null;
        this.mode = 'video-webgl';
        
        this.canvasW = 1920;
        this.canvasH = 1080;
        this.canvasAspectRatio = 16 / 9;
        
        this.demuxers = new Map();
        this.renderer = null;
        this.compositor = null;
        
        this._videoElements = new Map();
        this._imageElements = new Map(); // 图片素材缓存
        
        this.timelineClips = [];
        this.currentTime = 0;
        this.isPlaying = false;
        this.playbackRate = 1;
        
        this.rafId = null;
        this.lastFrameTime = 0;
        
        this.isSeeking = false;
        this._seekTarget = -1;
        this._needsRender = false;
        
        this.audioContext = null;
        this.masterGain = null;
        
        // 音频轨道元素缓存
        this._audioElements = new Map();
        
        this._webcodecsReady = false;
        this._supported = null;
        
        this._init();
    }

    async _init() {
        const existingCanvas = this.canvasContainer.querySelector('canvas');
        if (existingCanvas) {
            this.canvas = existingCanvas;
            console.log('[VideoEngine] Using existing canvas:', existingCanvas.id);
        } else {
            this.canvas = document.createElement('canvas');
            this.canvasContainer.appendChild(this.canvas);
            console.log('[VideoEngine] Created new canvas');
        }
        
        this.canvas.style.display = 'block';
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        
        this._createOverlayCanvas();
        
        this._ensureCanvasSize();
        
        try {
            this.renderer = new WebGLRenderer(this.canvas);
            this.compositor = new Compositor(this.renderer);
            console.log('[VideoEngine] WebGL renderer initialized');
        } catch (e) {
            console.error('[VideoEngine] WebGL init failed:', e);
            this.mode = 'fallback';
            if (typeof VideoRenderer !== 'undefined') {
                this._fallbackRenderer = new VideoRenderer(this.canvasContainer, this.placeholderEl);
            }
            return;
        }
        
        this._checkWebCodecsSupport();
        
        this.lastFrameTime = performance.now();
        this._startLoop();
        
        console.log('[VideoEngine] ========================================');
        console.log('[VideoEngine] Init complete - mode:', this.mode);
        console.log('[VideoEngine] Canvas size:', this.canvas.width, 'x', this.canvas.height);
        console.log('[VideoEngine] Canvas CSS size:', this.canvas.offsetWidth, 'x', this.canvas.offsetHeight);
        console.log('[VideoEngine] Container size:', this.canvasContainer?.clientWidth, 'x', this.canvasContainer?.clientHeight);
        console.log('[VideoEngine] WebCodecs supported:', this._supported);
        console.log('[VideoEngine] ========================================');
        
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.isPlaying) {
                this._resumeAudio();
            }
        });
    }

    async _checkWebCodecsSupport() {
        if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
            this._supported = false;
            console.log('[VideoEngine] WebCodecs not supported');
            return;
        }
        
        try {
            const config = {
                codec: 'avc1.42001e',
                codedWidth: 1920,
                codedHeight: 1080
            };
            const support = await VideoDecoder.isConfigSupported(config);
            this._supported = support.supported;
            console.log('[VideoEngine] WebCodecs supported:', support.supported);
        } catch (e) {
            this._supported = false;
            console.log('[VideoEngine] WebCodecs check failed:', e);
        }
    }

    _getImageElement(clip) {
        const material = clip.material;
        const url = material.url;
        if (!url) return null;

        if (this._imageElements.has(url)) {
            return this._imageElements.get(url);
        }

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img._loaded = false;
        img._error = false;

        img.onload = () => {
            img._loaded = true;
            this._needsRender = true;
        };
        img.onerror = () => {
            img._error = true;
            console.warn('[VideoEngine] Image load failed:', material.name);
        };

        img.src = url;

        this._imageElements.set(url, img);
        return img;
    }

    _getVideoElement(clip) {
        const material = clip.material;
        const type = material.type;
        if (type === 'image' || type === 'text' || type === 'audio') {
            return null;
        }
        const url = material.url;
        const trackIndex = clip.trackIndex ?? 0;
        if (!url) {
            // 同一素材只警告一次，避免每帧刷屏
            if (!this._warnedNullUrls) this._warnedNullUrls = new Set();
            if (!this._warnedNullUrls.has(material.id)) {
                this._warnedNullUrls.add(material.id);
                console.warn('[VideoEngine] _getVideoElement: url is null for', material.name, '（此警告只显示一次，请通过素材库右键"重新定位素材"恢复）');
            }
            return null;
        } else {
            // url 恢复后清除警告标记
            if (this._warnedNullUrls && this._warnedNullUrls.has(material.id)) {
                this._warnedNullUrls.delete(material.id);
            }
        }
        
        const trackMatKey = 'track_' + trackIndex + '|mat_' + material.id + '|' + url;
        
        if (this._videoElements.has(trackMatKey)) {
            const video = this._videoElements.get(trackMatKey);
            if (clip.id) {
                this._videoElements.set('clip_' + clip.id, video);
            }
            return video;
        }
        
        let videoKey;
        if (clip._isPreload) {
            videoKey = trackMatKey;
        } else {
            if (clip.id) {
                videoKey = 'clip_' + clip.id;
            } else {
                clip.id = 'clip_' + Math.random().toString(36).substr(2, 9);
                videoKey = 'clip_' + clip.id;
            }
        }
        
        if (this._videoElements.has(videoKey)) {
            const cachedVideo = this._videoElements.get(videoKey);
            if (cachedVideo._trackIndex === trackIndex) {
                this._videoElements.set(trackMatKey, cachedVideo);
                return cachedVideo;
            }
            console.log('[VideoEngine] Clip moved to new track', cachedVideo._trackIndex, '->', trackIndex,
                ', creating new video element for:', material.name);
        }
        
        console.log('[VideoEngine] Creating video element for track', trackIndex, ':', material.name);
        
        const video = document.createElement('video');

        // blob URL 已从 ArrayBuffer 创建（在 _initMediaMaterial 中），不再依赖 File 句柄
        // 无需创建独立副本，多个 video 元素可共享同一 blob URL
        video.src = url;
        video.preload = 'auto';
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        
        video._material = material;
        video._key = videoKey;
        video._trackIndex = trackIndex;
        
        this._videoElements.set(trackMatKey, video);
        this._videoElements.set(videoKey, video);
        
        video.addEventListener('loadedmetadata', () => {
            this._needsRender = true;
        });
        
        video.addEventListener('canplaythrough', () => {
            this._needsRender = true;
        });
        
        video.addEventListener('canplay', () => {
            this._needsRender = true;
        });
        
        video.addEventListener('error', (e) => {
        });
        
        video.addEventListener('abort', (e) => {
        });
        
        video.addEventListener('stalled', () => {
        });
        
        video.addEventListener('waiting', () => {
        });
        
        video.addEventListener('playing', () => {
        });
        
        return video;
    }

    _disposeVideoElement(video, key) {
        try { video.pause(); } catch (e) {}
        try { video.removeAttribute('src'); video.load(); } catch (e) {}
        if (video.parentNode) video.parentNode.removeChild(video);
        this._videoElements.delete(key);
        console.log('[VideoEngine] Disposed video element:', key);
    }

    // 获取音频轨道的音频元素
    _getAudioElement(clip) {
        const material = clip.material;
        const url = material && material.url;
        if (!url) {
            return null;
        }
        const trackIndex = clip.trackIndex;
        const audioKey = 'audio_' + trackIndex + '_' + material.id;
        
        // 检查缓存
        if (this._audioElements.has(audioKey)) {
            return this._audioElements.get(audioKey);
        }
        
        // 创建音频元素
        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';

        audio._material = material;
        audio._key = audioKey;
        audio._trackIndex = trackIndex;

        audio.src = url;
        
        this._audioElements.set(audioKey, audio);
        
        audio.addEventListener('loadedmetadata', () => {
            console.log('[VideoEngine] Audio loaded:', material.name, 'duration:', audio.duration);
        });
        
        audio.addEventListener('error', (e) => {
            console.error('[VideoEngine] Audio error:', material.name, audio.error?.message);
        });
        
        return audio;
    }

    // 获取活动的音频轨道片段
    _getActiveAudioClips() {
        return this.timelineClips.filter(clip => {
            if (clip.trackIndex < 100) return false; // 只处理音频轨道
            if (clip.material.type !== 'audio') return false;
            return this.currentTime >= clip.startTime && 
                   this.currentTime < clip.startTime + clip.duration;
        });
    }

    async loadMaterial(material) {
        const url = material.url;
        
        if (this.demuxers.has(url)) {
            return this.demuxers.get(url);
        }
        
        if (material.type !== 'video') {
            return null;
        }
        
        const video = this._getVideoElement({ material, _isPreload: true });
        
        if (this._supported && (material._arrayBuffer || material.file)) {
            try {
                console.log('[VideoEngine] Loading with MP4Demuxer:', material.name);
                const demuxer = await mp4DemuxerCache.get(material);
                
                if (demuxer.videoTrack && demuxer.videoSamples.length > 0) {
                    const info = { videoTrack: demuxer.videoTrack };
                    this.demuxers.set(url, {
                        demuxer,
                        info,
                        material
                    });
                    console.log('[VideoEngine] Demuxer loaded:', material.name,
                        'samples:', demuxer.videoSamples.length);
                    return { demuxer, info };
                }
            } catch (e) {
                console.warn('[VideoEngine] Demuxer failed, using video element only:', e);
            }
        }
        
        this.demuxers.set(url, {
            demuxer: null,
            info: { videoTrack: null },
            material
        });
        
        return { demuxer: null, info: { videoTrack: null } };
    }

    setClips(clips) {
        this.timelineClips = clips;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.setClips(clips);
            return;
        }
        
        const activeClipIds = new Set();
        const activeMaterials = new Set();
        
        for (const clip of clips) {
            if (clip.material.type === 'video') {
                this._getVideoElement(clip);
                if (clip.id) activeClipIds.add(clip.id);
                activeMaterials.add(clip.material.id);
            } else if (clip.material.type === 'image') {
                this._getImageElement(clip);
            }
        }
        
        for (const [key, video] of this._videoElements) {
            if (key.startsWith('preload_')) continue;
            
            const clipMatch = key.match(/^clip_(\w+)$/);
            const matMatch = key.match(/^(\d+)_(\w+)$/);
            
            if (clipMatch) {
                if (!activeClipIds.has(clipMatch[1])) {
                    this._disposeVideoElement(video, key);
                }
            } else if (matMatch) {
                if (!activeMaterials.has(matMatch[2])) {
                    this._disposeVideoElement(video, key);
                }
            }
        }
        
        this._needsRender = true;
        
        for (const clip of clips) {
            const video = clip.material.type === 'video' ? this._getVideoElement(clip) : null;
            if (video) {
                const effects = clip.effects || {};
                const volumePercent = (effects.volume !== undefined ? effects.volume : 100);
                const volume = Math.max(0, Math.min(1, volumePercent / 100));
                video.volume = volume;
            }
        }
        
        console.log('[VideoEngine] setClips:', clips.length, 'clips');
    }

    async seek(time) {
        this.currentTime = Math.max(0, time);
        this.isSeeking = true;
        this._needsRender = true;
        this._renderFrameLogged = false;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.seek(time);
            return;
        }
        
        const activeClips = this._getActiveClips();
        for (const clip of activeClips) {
            if (clip.material.type === 'image' || clip.material.type === 'text') continue; // 图片和文本不需要 seek

            const video = this._getVideoElement(clip);
            if (video && video.readyState >= 1) {
                const clipTime = Math.max(0, this.currentTime - clip.startTime);
                const mediaTime = (clip.offset || 0) + clipTime;
                video.currentTime = Math.min(mediaTime, video.duration || Infinity);
                
                const effects = clip.effects || {};
                const volumePercent = (effects.volume !== undefined ? effects.volume : 100);
                const volume = Math.max(0, Math.min(1, volumePercent / 100));
                video.volume = volume;
                

            }
        }
        
        // seek 音频轨道
        const activeAudioClips = this._getActiveAudioClips();
        for (const clip of activeAudioClips) {
            const audio = this._getAudioElement(clip);
            if (audio && audio.readyState >= 1) {
                const clipTime = Math.max(0, this.currentTime - clip.startTime);
                const mediaTime = (clip.offset || 0) + clipTime;
                audio.currentTime = Math.min(mediaTime, audio.duration || Infinity);
                
                const effects = clip.effects || {};
                const volumePercent = (effects.volume !== undefined ? effects.volume : 100);
                const volume = Math.max(0, Math.min(1, volumePercent / 100));
                audio.volume = volume;
            }
        }
        
        setTimeout(() => {
            this.isSeeking = false;
            this._needsRender = true;
        }, 50);
        
        await this._waitForFramesSync(500);
        this._needsRender = true;
    }

    async play() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        this.isSeeking = false;
        this._needsRender = true;
        this._renderFrameLogged = false;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.play();
            return;
        }
        
        this._initAudio();
        this._resumeAudio();
        this.lastFrameTime = performance.now();
        
        const activeClips = this._getActiveClips();
        for (let i = 0; i < activeClips.length; i++) {
            const clip = activeClips[i];
            if (clip.material.type === 'image' || clip.material.type === 'text') continue; // 图片和文本不需要播放

            const video = this._getVideoElement(clip);
            if (video && video.paused) {
                const clipTime = Math.max(0, this.currentTime - clip.startTime);
                const mediaTime = (clip.offset || 0) + clipTime;
                video.currentTime = Math.min(mediaTime, video.duration || Infinity);
                video.muted = i > 0;
                video.play().catch(e => {
                    console.warn('Video play failed:', clip.material.name, e);
                });
            } else if (video) {
                video.muted = i > 0;
            }
        }
        
        // 启动音频轨道播放
        const activeAudioClips = this._getActiveAudioClips();
        for (const clip of activeAudioClips) {
            const audio = this._getAudioElement(clip);
            if (audio && audio.paused) {
                const clipTime = Math.max(0, this.currentTime - clip.startTime);
                const mediaTime = (clip.offset || 0) + clipTime;
                audio.currentTime = Math.min(mediaTime, audio.duration || Infinity);
                audio.play().catch(e => {
                    console.warn('Audio play failed:', clip.material.name, e);
                });
            }
        }
    }

    pause() {
        this.isPlaying = false;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.pause();
            return;
        }
        
        const allVideos = new Set();
        for (const [key, video] of this._videoElements) {
            allVideos.add(video);
        }
        for (const video of allVideos) {
            if (!video.paused) {
                video.pause();
            }
        }
        
        // 暂停所有音频轨道
        for (const [key, audio] of this._audioElements) {
            if (!audio.paused) {
                audio.pause();
            }
        }
        
        this._needsRender = true;
    }

    setPlaybackRate(rate) {
        this.playbackRate = rate;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.setPlaybackRate(rate);
            return;
        }
        
        const allVideos = new Set();
        for (const [key, video] of this._videoElements) {
            allVideos.add(video);
        }
        for (const video of allVideos) {
            video.playbackRate = rate;
        }
        
        // 同步音频轨道播放速率
        for (const [key, audio] of this._audioElements) {
            audio.playbackRate = rate;
        }
    }

    initAudio() {
        this._initAudio();
    }

    resumeAudio() {
        this._resumeAudio();
    }

    _initAudio() {
        if (this.audioContext) return;
        
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 1;
            this.masterGain.connect(this.audioContext.destination);
        } catch (e) {
            console.warn('Audio init failed:', e);
        }
    }

    _resumeAudio() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }
    }

    _startLoop() {
        if (this.rafId) return;
        
        const loop = (now) => {
            this.rafId = requestAnimationFrame(loop);
            this._tick(now);
        };
        
        this.rafId = requestAnimationFrame(loop);
    }

    _stopLoop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    releaseWebGL() {
        if (this.mode === 'fallback') return;
        this._stopLoop();
        // 不使用 loseContext，而是标记需要释放，在 restore 时检查
        this._webglReleased = true;
        console.log('[VideoEngine] WebGL render loop stopped');
    }

    restoreWebGL() {
        if (this.mode === 'fallback') return;
        if (this._webglReleased) {
            // 检查 WebGL context 是否还有效
            if (this.renderer && this.renderer.gl && this.renderer.gl.isContextLost()) {
                console.warn('[VideoEngine] WebGL context lost, cannot restore automatically');
                // 标记需要用户刷新
                this._needsRefresh = true;
            }
            this._webglReleased = false;
        }
        this._startLoop();
        this._needsRender = true;
    }

    _tick(now) {
        const deltaTime = now - this.lastFrameTime;
        this.lastFrameTime = now;
        
        if (this.mode === 'fallback') {
            return;
        }
        
        const activeClips = this._getActiveClips();
        const hasActiveClips = activeClips.length > 0;
        const activeAudioClips = this._getActiveAudioClips();
        const hasActiveAudio = activeAudioClips.length > 0;
        
        if (this.isPlaying) {
            this.currentTime = Math.max(0, this.currentTime + (deltaTime / 1000) * this.playbackRate);
        }
        
        if (this.isPlaying && hasActiveClips) {
            
            const activeVideos = new Set();
            for (let i = 0; i < activeClips.length; i++) {
                const clip = activeClips[i];
                if (clip.material.type === 'image' || clip.material.type === 'text' || clip.material.type === 'audio') continue;
                const video = this._getVideoElement(clip);
                if (!video) continue;
                
                if (video.error) {
                    console.warn('[VideoEngine] Video error, reloading:', clip.material.name,
                        'error:', video.error.message);
                    if (video._ownBlobUrl) {
                        video.src = video._ownBlobUrl;
                    } else {
                        video.src = clip.material.url;
                    }
                    video.load();
                    continue;
                }
                
                activeVideos.add(video);
                
                if (video.paused) {
                    video.play().catch(e => console.warn('Auto play failed:', clip.material.name, e));
                }
                video.muted = false;
                
                const effects = clip.effects || {};
                const volumePercent = (effects.volume !== undefined ? effects.volume : 100);
                const volume = Math.max(0, Math.min(1, volumePercent / 100));
                if (video.volume !== volume) {
                    video.volume = volume;
                }
                
                if (video.readyState >= 2 && !video.paused && !video.error) {
                    const clipTime = this.currentTime - clip.startTime;
                    const mediaTime = (clip.offset || 0) + clipTime;
                    const diff = video.currentTime - mediaTime;
                    const timeDiff = Math.abs(diff);
                    
                    if (timeDiff > 1.5) {
                        const now = performance.now();
                        const lastSeek = video._lastSeekTime || 0;
                        if (now - lastSeek > 800) {
                            try {
                                video.currentTime = Math.min(Math.max(0, mediaTime), video.duration || Infinity);
                                video._lastSeekTime = now;
                                video.playbackRate = 1;
                            } catch (e) {
                                console.warn('[VideoEngine] Seek failed:', clip.material.name, e);
                            }
                        }
                    } else if (timeDiff > 0.1) {
                        const speedAdj = Math.min(timeDiff * 0.3, 0.5);
                        const rate = diff > 0 
                            ? Math.max(0.5, 1 - speedAdj)
                            : Math.min(1.5, 1 + speedAdj);
                        if (Math.abs(video.playbackRate - rate) > 0.05) {
                            video.playbackRate = rate;
                        }
                    } else {
                        if (video.playbackRate !== 1) {
                            video.playbackRate = 1;
                        }
                    }
                }
            }
            
            const allVideos = new Set();
            for (const [key, video] of this._videoElements) {
                allVideos.add(video);
            }
            for (const video of allVideos) {
                if (!activeVideos.has(video)) {
                    if (!video.paused) {
                        video.pause();
                    }
                    if (video.playbackRate !== 1) {
                        video.playbackRate = 1;
                    }
                }
            }
            
            // 处理音频轨道播放
            const activeAudios = new Set();
            for (let i = 0; i < activeAudioClips.length; i++) {
                const clip = activeAudioClips[i];
                const audio = this._getAudioElement(clip);
                if (!audio) continue;
                
                activeAudios.add(audio);
                
                if (audio.paused) {
                    audio.play().catch(e => console.warn('Audio play failed:', clip.material.name, e));
                }
                
                const effects = clip.effects || {};
                const volumePercent = (effects.volume !== undefined ? effects.volume : 100);
                const volume = Math.max(0, Math.min(1, volumePercent / 100));
                if (audio.volume !== volume) {
                    audio.volume = volume;
                }
                
                // 同步音频时间
                if (audio.readyState >= 1 && !audio.paused) {
                    const clipTime = this.currentTime - clip.startTime;
                    const mediaTime = (clip.offset || 0) + clipTime;
                    const diff = Math.abs(audio.currentTime - mediaTime);
                    
                    if (diff > 0.5) {
                        try {
                            audio.currentTime = Math.min(Math.max(0, mediaTime), audio.duration || Infinity);
                        } catch (e) {
                            console.warn('[VideoEngine] Audio seek failed:', clip.material.name, e);
                        }
                    }
                    
                    // 同步播放速率
                    if (audio.playbackRate !== this.playbackRate) {
                        audio.playbackRate = this.playbackRate;
                    }
                }
            }
            
            // 停止非活动的音频
            for (const [key, audio] of this._audioElements) {
                if (!activeAudios.has(audio)) {
                    if (!audio.paused) {
                        audio.pause();
                    }
                }
            }
        } else if (this.isPlaying && !hasActiveClips) {
            const allVideos = new Set();
            for (const [key, video] of this._videoElements) {
                allVideos.add(video);
            }
            for (const video of allVideos) {
                if (!video.paused) {
                    video.pause();
                }
                if (video.playbackRate !== 1) {
                    video.playbackRate = 1;
                }
            }
            // 停止所有音频轨道
            for (const [key, audio] of this._audioElements) {
                if (!audio.paused) {
                    audio.pause();
                }
            }
        } else if (!this.isPlaying) {
            const allVideos = new Set();
            for (const [key, video] of this._videoElements) {
                allVideos.add(video);
            }
            for (const video of allVideos) {
                if (!video.paused) {
                    video.pause();
                }
                if (video.playbackRate !== 1) {
                    video.playbackRate = 1;
                }
            }
            // 停止所有音频轨道
            for (const [key, audio] of this._audioElements) {
                if (!audio.paused) {
                    audio.pause();
                }
            }
        }
        
        this._ensureCanvasSize();
        
        if (hasActiveClips) {
            this._renderFrame();
            this._needsRender = false;
        } else {
            // 没有活跃片段时清屏黑屏（和导出一致）
            if (this.renderer && this.renderer.gl) {
                const gl = this.renderer.gl;
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            if (this.placeholderEl) {
                this.placeholderEl.style.display = 'none';
            }
            this._needsRender = false;
        }
    }

    _getActiveClips() {
        return this.timelineClips.filter(clip => {
            if (clip.trackIndex >= 100) return false;
            return this.currentTime >= clip.startTime && 
                   this.currentTime < clip.startTime + clip.duration;
        }).sort((a, b) => b.trackIndex - a.trackIndex);
    }

    _ensureCanvasSize() {
        if (!this.canvas || !this.canvasContainer) return;
        
        const now = performance.now();
        if (this._lastCanvasSizeCheck && now - this._lastCanvasSizeCheck < 500) {
            return;
        }
        this._lastCanvasSizeCheck = now;
        
        const parent = this.canvasContainer.parentElement;
        let containerW = 0;
        let containerH = 0;
        
        if (parent) {
            const parentRect = parent.getBoundingClientRect();
            const style = getComputedStyle(parent);
            const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            containerW = Math.max(0, parentRect.width - paddingX);
            containerH = Math.max(0, parentRect.height - paddingY);
        }
        
        if (containerW <= 0 || containerH <= 0) {
            const containerRect = this.canvasContainer.getBoundingClientRect();
            containerW = containerRect.width;
            containerH = containerRect.height;
        }
        
        if (containerW <= 0 || containerH <= 0) {
            containerW = this.canvasContainer.clientWidth;
            containerH = this.canvasContainer.clientHeight;
        }
        
        if (containerW <= 0 || containerH <= 0) {
            containerW = 1280;
            containerH = 720;
        }
        
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const maxPixelW = 1920;
        const maxPixelH = 1080;
        
        let targetW, targetH;
        
        if (this.canvasAspectRatio) {
            const containerRatio = containerW / containerH;
            
            if (containerRatio > this.canvasAspectRatio) {
                targetH = containerH;
                targetW = targetH * this.canvasAspectRatio;
            } else {
                targetW = containerW;
                targetH = targetW / this.canvasAspectRatio;
            }
        } else {
            targetW = containerW;
            targetH = containerH;
        }
        
        const pixelW = Math.min(Math.floor(targetW * dpr), maxPixelW);
        const pixelH = Math.min(Math.floor(targetH * dpr), maxPixelH);
        
        if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
            this.canvas.width = pixelW;
            this.canvas.height = pixelH;
            this.canvas.style.width = Math.round(targetW) + 'px';
            this.canvas.style.height = Math.round(targetH) + 'px';
            
            this.canvasContainer.style.width = Math.round(targetW) + 'px';
            this.canvasContainer.style.height = Math.round(targetH) + 'px';
            
            if (this.overlayCanvas) {
                this.overlayCanvas.width = pixelW;
                this.overlayCanvas.height = pixelH;
                this.overlayCanvas.style.width = Math.round(targetW) + 'px';
                this.overlayCanvas.style.height = Math.round(targetH) + 'px';
            }
            
            if (this.renderer?.gl) {
                this.renderer.gl.viewport(0, 0, pixelW, pixelH);
            }
            
            if (this.renderer && this.renderer._resize) {
                this.renderer._resize();
            }
            
            console.log('[VideoEngine] Canvas resized to:', pixelW, 'x', pixelH, 
                '(CSS:', Math.round(targetW), 'x', Math.round(targetH), 'container:', containerW, 'x', containerH, 'DPR:', dpr, ')');
        }
    }
    
    _waitForFramesSync(timeoutMs = 500) {
        return new Promise((resolve) => {
            const startTime = performance.now();
            const checkReady = () => {
                const activeClips = this._getActiveClips();
                let allReady = activeClips.length > 0;
                
                for (const clip of activeClips) {
                    if (clip.material.type === 'image') {
                        const img = this._getImageElement(clip);
                        if (img && img._loaded) continue;
                        if (img && img._error) continue; // 加载失败的也跳过等待
                        allReady = false;
                        break;
                    }
                    if (clip.material.type === 'text') {
                        // 文本素材没有异步加载，立即就绪
                        continue;
                    }
                    const video = clip.material.type === 'video' ? this._getVideoElement(clip) : null;
                    if (video && video.readyState >= 2) {
                        continue;
                    }
                    const decoder = clip._decoder;
                    if (decoder && decoder.isReady && decoder.frameBuffer && decoder.frameBuffer.length > 0) {
                        continue;
                    }
                    allReady = false;
                    break;
                }
                
                if (allReady) {
                    resolve(true);
                    return;
                }
                
                if (performance.now() - startTime > timeoutMs) {
                    resolve(false);
                    return;
                }
                
                requestAnimationFrame(checkReady);
            };
            checkReady();
        });
    }

    _getMediaSource(clip) {
        if (!clip || !clip.material) return null;
        if (clip.material.type === 'text') {
            if (!window.textManager) {
                window.textManager = new TextManager();
            }
            const cached = window.textManager.getOrCreateTextImage(clip.material);
            if (cached) {
                return {
                    source: cached.image,
                    width: cached.width,
                    height: cached.height
                };
            }
            return { source: null, width: 800, height: 200 };
        } else if (clip.material.type === 'image') {
            const img = this._getImageElement(clip);
            if (img) {
                return {
                    source: img,
                    width: img.naturalWidth || img.width,
                    height: img.naturalHeight || img.height
                };
            }
            return { source: null, width: 1920, height: 1080 };
        } else {
            const video = this._getVideoElement(clip);
            if (video) {
                return {
                    source: video,
                    width: video.videoWidth || 1920,
                    height: video.videoHeight || 1080
                };
            }
            return { source: null, width: 1920, height: 1080 };
        }
    }

    _getRenderScale() {
        const canvasW = this.canvas.width || 1280;
        const canvasH = this.canvas.height || 720;
        if (this.canvasW > 0 && this.canvasH > 0) {
            return {
                x: canvasW / this.canvasW,
                y: canvasH / this.canvasH
            };
        }
        return { x: 1, y: 1 };
    }

    _renderFrame() {
        const canvasW = this.canvas.width || 1280;
        const canvasH = this.canvas.height || 720;
        
        if (this.mode === 'fallback' && this._fallbackRenderer) {
            this._fallbackRenderer.renderFrame();
            return;
        }
        
        if (!this.renderer || !this.compositor) {
            return;
        }
        
        const activeClips = this._getActiveClips();
        
        if (activeClips.length === 0) {
            if (this.placeholderEl) {
                this.placeholderEl.style.display = 'flex';
            }
            const gl = this.renderer.gl;
            if (gl) {
                gl.viewport(0, 0, canvasW, canvasH);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            return;
        }
        
        if (this.placeholderEl) {
            this.placeholderEl.style.display = 'none';
        }
        
        this.renderer.beginFrame();
        
        for (const clip of activeClips) {
            const isImage = clip.material.type === 'image';
            const isText = clip.material.type === 'text';
            if (isImage || isText) {
                this._renderClip(clip, canvasW, canvasH);
                continue;
            }
            const decoder = clip._decoder;
            if (decoder && decoder.isReady && decoder.frameBuffer && decoder.frameBuffer.length > 0) {
                this._renderClipWithDecoder(clip, canvasW, canvasH);
            } else {
                this._renderClip(clip, canvasW, canvasH);
            }
        }
        
        this.renderer.endFrame();
        
        if (typeof this.renderer.clearTempTextures === 'function') {
            this.renderer.clearTempTextures();
        }
        
        this._drawSelectionBorder();
        
        this._lastRenderTime = performance.now();
    }

    _drawSelectionBorder() {
        if (!this.overlayCanvas) return;
        
        const canvasW = this.canvas.width || 1280;
        const canvasH = this.canvas.height || 720;
        
        if (this.overlayCanvas.width !== canvasW || this.overlayCanvas.height !== canvasH) {
            this.overlayCanvas.width = canvasW;
            this.overlayCanvas.height = canvasH;
        }
        
        const ctx = this.overlayCanvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvasW, canvasH);
        
        if (!this._selectedClipId) return;
        
        const clip = this.timelineClips.find(c => c.id === this._selectedClipId);
        if (!clip) return;
        
        if (this.currentTime < clip.startTime || this.currentTime >= clip.startTime + clip.duration) {
            return;
        }
        
        const effects = this._getInterpolatedEffects(clip);
        const renderScale = this._getRenderScale();
        const posX = (effects.posX || 0) * renderScale.x;
        const posY = (effects.posY || 0) * renderScale.y;
        const isText = this._isTextClip(clip);
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const mediaInfo = this._getMediaSource(clip);
        const sourceW = mediaInfo.width;
        const sourceH = mediaInfo.height;

        let drawW, drawH;
        if (isText) {
            const uniformScale = this._getTextUniformScale(effects);
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * uniformScale;
            drawH = sourceH * scaleToFit * uniformScale;
        } else {
            const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
            const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * scaleX;
            drawH = sourceH * scaleToFit * scaleY;
        }

        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
        ctx.setLineDash([]);

        const handleSize = 12;
        const halfW = drawW / 2;
        const halfH = drawH / 2;
        const hs = handleSize / 2;
        const handlePositions = [
            { pos: 'nw', dx: -halfW, dy: -halfH },
            { pos: 'n', dx: 0, dy: -halfH },
            { pos: 'ne', dx: halfW, dy: -halfH },
            { pos: 'e', dx: halfW, dy: 0 },
            { pos: 'se', dx: halfW, dy: halfH },
            { pos: 's', dx: 0, dy: halfH },
            { pos: 'sw', dx: -halfW, dy: halfH },
            { pos: 'w', dx: -halfW, dy: 0 }
        ];
        
        for (const h of handlePositions) {
            ctx.fillStyle = '#00d4ff';
            ctx.fillRect(h.dx - hs, h.dy - hs, handleSize, handleSize);
            ctx.fillStyle = 'white';
            ctx.fillRect(h.dx - hs + 2, h.dy - hs + 2, handleSize - 4, handleSize - 4);
        }
        
        ctx.restore();
    }

    setSelectedClip(clipId) {
        this._selectedClipId = clipId;
    }
    
    _renderClipWithDecoder(clip, canvasW, canvasH) {
        const decoder = clip._decoder;
        if (!decoder || !decoder.frameBuffer || decoder.frameBuffer.length === 0) {
            this._renderClip(clip, canvasW, canvasH);
            return;
        }
        
        const effects = this._getInterpolatedEffects(clip);
        const clipTime = this.currentTime - clip.startTime;
        const mediaTime = (clip.offset || 0) + clipTime;
        const timeUs = mediaTime * 1000000;
        
        let bestFrame = null;
        let bestDiff = Infinity;
        for (const frame of decoder.frameBuffer) {
            const diff = Math.abs(frame.timestamp - timeUs);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestFrame = frame;
            }
        }
        
        if (!bestFrame) {
            this._renderClip(clip, canvasW, canvasH);
            return;
        }
        
        const renderScale = this._getRenderScale();
        const posX = (effects.posX || 0) * renderScale.x;
        const posY = (effects.posY || 0) * renderScale.y;
        const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
        const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const brightness = effects.brightness || 0;
        const contrast = (effects.contrast || 0) / 100 + 1;
        const saturation = (effects.saturation || 0) / 100 + 1;
        
        const frameW = bestFrame.codedWidth || bestFrame.width || 1920;
        const frameH = bestFrame.codedHeight || bestFrame.height || 1080;
        
        const scaleToFit = Math.min(canvasW / frameW, canvasH / frameH);
        const drawW = frameW * scaleToFit * scaleX;
        const drawH = frameH * scaleToFit * scaleY;
        
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;
        
        try {
            this.renderer.drawVideoFrame(bestFrame, {
                x, y,
                width: drawW,
                height: drawH,
                opacity,
                brightness,
                contrast,
                saturation,
                rotation,
                scale: 1.0
            });
        } catch (e) {
            console.warn('[VideoEngine] Render clip with decoder failed, falling back to video element:', e);
            this._renderClip(clip, canvasW, canvasH);
        }
    }

    _renderClip(clip, canvasW, canvasH) {
        const isImage = clip.material.type === 'image';
        const isText = clip.material.type === 'text';

        let sourceElement = null;
        let sourceW = 0;
        let sourceH = 0;

        if (isText) {
            const mediaInfo = this._getMediaSource(clip);
            sourceElement = mediaInfo.source;
            sourceW = mediaInfo.width;
            sourceH = mediaInfo.height;
            if (!sourceElement) return;
        } else if (isImage) {
            const img = this._getImageElement(clip);
            if (!img || !img._loaded || img._error) return;
            sourceElement = img;
            sourceW = img.naturalWidth || img.width;
            sourceH = img.naturalHeight || img.height;
        } else {
            const video = this._getVideoElement(clip);
            if (!video) return;
            
            if (video.error) {
                if (video._ownBlobUrl) {
                    console.warn('[VideoEngine] Video error, reloading with own blob URL:', clip.material.name);
                    video.src = video._ownBlobUrl;
                } else {
                    video.src = clip.material.url;
                }
                video.load();
                return;
            }
            
            if (video.readyState < 1 || video.videoWidth === 0 || video.videoHeight === 0) {
                if (video.readyState === 0 && video.networkState === 0 && !video._ownBlobUrl) {
                    if (video.src !== clip.material.url) {
                        video.src = clip.material.url;
                        video.load();
                    }
                }
                return;
            }
            
            sourceElement = video;
            sourceW = video.videoWidth || 1920;
            sourceH = video.videoHeight || 1080;
        }
        
        const effects = this._getInterpolatedEffects(clip);
        const renderScale = this._getRenderScale();
        const posX = (effects.posX || 0) * renderScale.x;
        const posY = (effects.posY || 0) * renderScale.y;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const brightness = effects.brightness || 0;
        const contrast = (effects.contrast || 0) / 100 + 1;
        const saturation = (effects.saturation || 0) / 100 + 1;

        let drawW, drawH;
        if (isText) {
            const uniformScale = this._getTextUniformScale(effects);
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * uniformScale;
            drawH = sourceH * scaleToFit * uniformScale;
        } else {
            const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
            const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * scaleX;
            drawH = sourceH * scaleToFit * scaleY;
        }

        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        try {
            this.renderer.drawVideoFrame(sourceElement, {
                x, y,
                width: drawW,
                height: drawH,
                opacity,
                brightness,
                contrast,
                saturation,
                rotation,
                scale: 1.0
            });
        } catch (e) {
            console.warn('[VideoEngine] Render clip failed:', e);
        }
    }

    _getInterpolatedEffects(clip) {
        if (!clip.keyframes || clip.keyframes.length === 0) {
            const base = clip.effects || {
                opacity: 100,
                scale: 100,
                posX: 0,
                posY: 0,
                rotation: 0,
                brightness: 0,
                contrast: 0,
                saturation: 0,
                speed: 1,
                volume: 100
            };
            const result = { ...base };
            if (result.scaleX === undefined) result.scaleX = result.scale || 100;
            if (result.scaleY === undefined) result.scaleY = result.scale || 100;
            const clipTime = this.currentTime - clip.startTime;
            if (typeof VideoEditor !== 'undefined' && VideoEditor.applyAnimationEffects) {
                VideoEditor.applyAnimationEffects(clipTime, clip, result);
            }
            return result;
        }
        
        const clipTime = this.currentTime - clip.startTime;
        let prevKeyframe = null;
        let nextKeyframe = null;
        
        for (let i = 0; i < clip.keyframes.length; i++) {
            if (clip.keyframes[i].time <= clipTime) {
                prevKeyframe = clip.keyframes[i];
            }
            if (clip.keyframes[i].time >= clipTime && !nextKeyframe) {
                nextKeyframe = clip.keyframes[i];
            }
        }
        
        const base = clip.effects || {
            opacity: 100,
            scale: 100,
            scaleX: 100,
            scaleY: 100,
            posX: 0,
            posY: 0,
            rotation: 0,
            brightness: 0,
            contrast: 0,
            saturation: 0,
            speed: 1,
            volume: 100
        };
        
        if (base.scaleX === undefined) base.scaleX = base.scale || 100;
        if (base.scaleY === undefined) base.scaleY = base.scale || 100;
        
        if (!prevKeyframe && !nextKeyframe) {
            const result = { ...base };
            if (typeof VideoEditor !== 'undefined' && VideoEditor.applyAnimationEffects) {
                VideoEditor.applyAnimationEffects(clipTime, clip, result);
            }
            return result;
        }
        
        if (!prevKeyframe) {
            const result = { ...base };
            for (const prop in nextKeyframe.props) {
                if (nextKeyframe.props[prop] !== undefined) {
                    result[prop] = nextKeyframe.props[prop];
                }
            }
            if (result.scaleX === undefined) result.scaleX = result.scale || base.scaleX;
            if (result.scaleY === undefined) result.scaleY = result.scale || base.scaleY;
            if (typeof VideoEditor !== 'undefined' && VideoEditor.applyAnimationEffects) {
                VideoEditor.applyAnimationEffects(clipTime, clip, result);
            }
            return result;
        }
        
        if (!nextKeyframe) {
            const result = { ...base };
            for (const prop in prevKeyframe.props) {
                if (prevKeyframe.props[prop] !== undefined) {
                    result[prop] = prevKeyframe.props[prop];
                }
            }
            if (result.scaleX === undefined) result.scaleX = result.scale || base.scaleX;
            if (result.scaleY === undefined) result.scaleY = result.scale || base.scaleY;
            if (typeof VideoEditor !== 'undefined' && VideoEditor.applyAnimationEffects) {
                VideoEditor.applyAnimationEffects(clipTime, clip, result);
            }
            return result;
        }
        
        const dur = nextKeyframe.time - prevKeyframe.time;
        const t = dur > 0.001 ? (clipTime - prevKeyframe.time) / dur : 0;
        
        const interpolate = (prop) => {
            const start = prevKeyframe.props[prop] !== undefined ? prevKeyframe.props[prop] : base[prop];
            const end = nextKeyframe.props[prop] !== undefined ? nextKeyframe.props[prop] : base[prop];
            return start + (end - start) * t;
        };
        
        const scaleX = interpolate('scaleX');
        const scaleY = interpolate('scaleY');
        
        const result = {
            opacity: interpolate('opacity'),
            scale: interpolate('scale'),
            scaleX,
            scaleY,
            posX: interpolate('posX'),
            posY: interpolate('posY'),
            rotation: interpolate('rotation'),
            brightness: interpolate('brightness'),
            contrast: interpolate('contrast'),
            saturation: interpolate('saturation'),
            volume: interpolate('volume'),
            speed: prevKeyframe.props.speed !== undefined ? prevKeyframe.props.speed : (base.speed !== undefined ? base.speed : 1)
        };
        if (typeof VideoEditor !== 'undefined' && VideoEditor.applyAnimationEffects) {
            VideoEditor.applyAnimationEffects(clipTime, clip, result);
        }
        return result;
    }

    getInterpolatedEffects(clip, time) {
        const savedTime = this.currentTime;
        if (time !== undefined) {
            this.currentTime = time;
        }
        const result = this._getInterpolatedEffects(clip);
        if (time !== undefined) {
            this.currentTime = savedTime;
        }
        return result;
    }

    destroy() {
        this._stopLoop();
        
        const allVideos = new Set();
        for (const [key, video] of this._videoElements) {
            allVideos.add(video);
        }
        for (const video of allVideos) {
            video.pause();
            video.src = '';
            video.load();
            if (video._ownBlobUrl) {
                URL.revokeObjectURL(video._ownBlobUrl);
                video._ownBlobUrl = null;
            }
        }
        this._videoElements.clear();
        
        // 释放图片资源
        for (const [key, img] of this._imageElements) {
            if (img._ownBlobUrl) {
                URL.revokeObjectURL(img._ownBlobUrl);
                img._ownBlobUrl = null;
            }
            img.src = '';
        }
        this._imageElements.clear();
        
        if (this._fileCopyCache) {
            for (const [key, cached] of this._fileCopyCache) {
                if (cached.url) {
                    URL.revokeObjectURL(cached.url);
                }
            }
            this._fileCopyCache.clear();
            this._fileCopyCache = null;
        }
        
        if (this.renderer) {
            this.renderer.destroy();
            this.renderer = null;
        }
        
        if (this.compositor) {
            this.compositor.destroy();
            this.compositor = null;
        }
        
        if (this._fallbackRenderer) {
            this._fallbackRenderer.destroy();
            this._fallbackRenderer = null;
        }
        
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (e) {}
        }
        
        this.demuxers.clear();
    }

    getStats() {
        return {
            mode: this.mode,
            currentTime: this.currentTime,
            isPlaying: this.isPlaying
        };
    }

    _createOverlayCanvas() {
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.style.display = 'block';
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'auto';
        this.overlayCanvas.style.zIndex = '10';
        this.canvasContainer.appendChild(this.overlayCanvas);
        
        this._initOverlayEvents();
    }
    
    _getClipBounds(clip) {
        const effects = this._getInterpolatedEffects(clip);
        const renderScale = this._getRenderScale();
        const posX = (effects.posX || 0) * renderScale.x;
        const posY = (effects.posY || 0) * renderScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const isText = this._isTextClip(clip);

        const mediaInfo = this._getMediaSource(clip);
        const sourceW = mediaInfo.width;
        const sourceH = mediaInfo.height;

        const canvasW = this.canvas.width || 1280;
        const canvasH = this.canvas.height || 720;

        let drawW, drawH;
        if (isText) {
            const uniformScale = this._getTextUniformScale(effects);
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * uniformScale;
            drawH = sourceH * scaleToFit * uniformScale;
        } else {
            const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
            const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
            const scaleToFit = Math.min(canvasW / sourceW, canvasH / sourceH);
            drawW = sourceW * scaleToFit * scaleX;
            drawH = sourceH * scaleToFit * scaleY;
        }
        const clipX = (canvasW - drawW) / 2 + posX;
        const clipY = (canvasH - drawH) / 2 + posY;

        return { x: clipX, y: clipY, w: drawW, h: drawH, rotation, canvasW, canvasH };
    }
    
    _getHandlePositions(bounds) {
        const hs = 12;
        const hw = bounds.w / 2;
        const hh = bounds.h / 2;
        const cx = bounds.x + hw;
        const cy = bounds.y + hh;
        const cos = Math.cos(bounds.rotation);
        const sin = Math.sin(bounds.rotation);
        
        const rotatePoint = (px, py) => {
            const dx = px - cx;
            const dy = py - cy;
            return {
                x: cx + dx * cos - dy * sin,
                y: cy + dx * sin + dy * cos
            };
        };
        
        const handles = [
            { pos: 'nw', cursor: 'nwse-resize', lx: bounds.x, ly: bounds.y },
            { pos: 'n', cursor: 'ns-resize', lx: cx, ly: bounds.y },
            { pos: 'ne', cursor: 'nesw-resize', lx: bounds.x + bounds.w, ly: bounds.y },
            { pos: 'e', cursor: 'ew-resize', lx: bounds.x + bounds.w, ly: cy },
            { pos: 'se', cursor: 'nwse-resize', lx: bounds.x + bounds.w, ly: bounds.y + bounds.h },
            { pos: 's', cursor: 'ns-resize', lx: cx, ly: bounds.y + bounds.h },
            { pos: 'sw', cursor: 'nesw-resize', lx: bounds.x, ly: bounds.y + bounds.h },
            { pos: 'w', cursor: 'ew-resize', lx: bounds.x, ly: cy }
        ];
        
        return handles.map(h => {
            const p = rotatePoint(h.lx, h.ly);
            return { ...h, hx: p.x, hy: p.y };
        });
    }
    
    _worldToLocal(wx, wy, bounds) {
        const cx = bounds.x + bounds.w / 2;
        const cy = bounds.y + bounds.h / 2;
        const cos = Math.cos(-bounds.rotation);
        const sin = Math.sin(-bounds.rotation);
        const dx = wx - cx;
        const dy = wy - cy;
        return {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos
        };
    }
    
    _getOverlayMousePos(e) {
        const rect = this.overlayCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.overlayCanvas.width / rect.width),
            y: (e.clientY - rect.top) * (this.overlayCanvas.height / rect.height)
        };
    }
    
    _initOverlayEvents() {
        this.overlayCanvas.addEventListener('mousemove', (e) => {
            const pos = this._getOverlayMousePos(e);

            const topClip = this._findClipAtPosition(pos.x, pos.y);

            if (!topClip) {
                this.overlayCanvas.style.cursor = 'default';
                return;
            }

            if (topClip.id !== this._selectedClipId) {
                this.overlayCanvas.style.cursor = 'pointer';
                return;
            }

            const clip = topClip;
            const bounds = this._getClipBounds(clip);
            const handles = this._getHandlePositions(bounds);

            for (const h of handles) {
                if (Math.abs(pos.x - h.hx) <= 8 && Math.abs(pos.y - h.hy) <= 8) {
                    this.overlayCanvas.style.cursor = h.cursor;
                    return;
                }
            }

            this.overlayCanvas.style.cursor = 'move';
        });

        this.overlayCanvas.addEventListener('mouseleave', () => {
            this.overlayCanvas.style.cursor = 'default';
        });

        this.overlayCanvas.addEventListener('mousedown', (e) => {
            const pos = this._getOverlayMousePos(e);

            const topClip = this._findClipAtPosition(pos.x, pos.y);

            if (!topClip) {
                if (this.onClipClick) {
                    this.onClipClick(null);
                } else {
                    this.setSelectedClip(null);
                }
                return;
            }

            if (topClip.id !== this._selectedClipId) {
                if (this.onClipClick) {
                    this.onClipClick(topClip.id);
                } else {
                    this.setSelectedClip(topClip.id);
                }
                return;
            }

            const clip = topClip;
            const bounds = this._getClipBounds(clip);
            const handles = this._getHandlePositions(bounds);

            let activeHandle = null;
            for (const h of handles) {
                if (Math.abs(pos.x - h.hx) <= 8 && Math.abs(pos.y - h.hy) <= 8) {
                    activeHandle = h.pos;
                    break;
                }
            }

            if (activeHandle) {
                this._startResizing(activeHandle, pos.x, pos.y, clip);
            } else {
                this._startDragging(pos.x, pos.y, clip);
            }
        });
    }

    _findClipAtPosition(x, y) {
        const activeClips = this._getActiveClips();

        // 轨道优先级说明（重要！容易搞反，每次看这里）：
        // - 渲染顺序：高 trackIndex 先画，低 trackIndex 后画（后画的覆盖在上，显示在最顶层）
        // - 所以视觉上"最上面的画面" = trackIndex 最小的素材
        // - 点击检测时应该优先返回最顶层（视觉最上面）的素材
        // - 因此排序用升序：a.trackIndex - b.trackIndex（小的在前）
        const sortedClips = [...activeClips].sort((a, b) => a.trackIndex - b.trackIndex);

        for (const clip of sortedClips) {
            const bounds = this._getClipBounds(clip);
            const local = this._worldToLocal(x, y, bounds);
            if (local.x >= bounds.x && local.x <= bounds.x + bounds.w &&
                local.y >= bounds.y && local.y <= bounds.y + bounds.h) {
                return clip;
            }
        }
        return null;
    }
    
    _estimateLineCount(line, maxWidth, fontSize) {
        // 简单估算：每行约每 fontSize*1.2 像素宽度为 1 个中文字符
        // 实际行数约等于 (line.length * fontSize * 0.6) / maxWidth + 1
        if (!line) return 0;
        const avgCharWidth = fontSize * 0.6;
        return Math.max(1, Math.ceil((line.length * avgCharWidth) / maxWidth));
    }

    _getClipSourceSize(clip) {
        if (clip.material.type === 'image') {
            const img = this._getImageElement(clip);
            return { w: img ? (img.naturalWidth || img.width) : 1920, h: img ? (img.naturalHeight || img.height) : 1080 };
        } else if (clip.material.type === 'text') {
            const textData = clip.material.textData || {};
            if (textData.frameWidth && (textData.frameHeight !== undefined && textData.frameHeight !== null)) {
                return { w: textData.frameWidth, h: textData.frameHeight };
            }
            if (window.textManager) {
                const cached = window.textManager.getOrCreateTextImage(clip.material);
                if (cached) return { w: cached.width, h: cached.height };
            }
            return { w: 800, h: 200 };
        } else {
            const video = this._getVideoElement(clip);
            return { w: video ? (video.videoWidth || 1920) : 1920, h: video ? (video.videoHeight || 1080) : 1080 };
        }
    }

    _isTextClip(clip) {
        return clip && clip.material && clip.material.type === 'text';
    }

    _getTextUniformScale(effects) {
        if (effects.scale !== undefined) return effects.scale / 100;
        const sx = (effects.scaleX || 100) / 100;
        const sy = (effects.scaleY || 100) / 100;
        return Math.min(sx, sy);
    }

    _normalizeTextClipScale(clip) {
        if (!clip || !clip.material || clip.material.type !== 'text') return;
        const effects = clip.effects || {};
        const scale = this._getTextUniformScale(effects);
        if (Math.abs(scale - 1) < 0.001) return;
        const td = clip.material.textData || {};
        td.fontSize = Math.max(8, Math.round((td.fontSize || 96) * scale));
        td.maxWidth = Math.max(50, Math.round((td.maxWidth || 1200) * scale));
        effects.scale = 100;
        effects.scaleX = 100;
        effects.scaleY = 100;
        if (window.textManager) window.textManager.invalidate(clip.material.id);
    }
    
    _startResizing(handle, startWorldX, startWorldY, clip) {
        const effects = this._getInterpolatedEffects(clip);
        const bounds = this._getClipBounds(clip);
        const renderScale = this._getRenderScale();
        const sourceSize = this._getClipSourceSize(clip);
        const canvasW = bounds.canvasW;
        const canvasH = bounds.canvasH;
        const scaleToFit = Math.min(canvasW / sourceSize.w, canvasH / sourceSize.h);

        const isText = clip.material.type === 'text';

        const handleMap = {
            nw: { x: bounds.x,              y: bounds.y },
            n:  { x: bounds.x + bounds.w/2, y: bounds.y },
            ne: { x: bounds.x + bounds.w,   y: bounds.y },
            e:  { x: bounds.x + bounds.w,   y: bounds.y + bounds.h/2 },
            se: { x: bounds.x + bounds.w,   y: bounds.y + bounds.h },
            s:  { x: bounds.x + bounds.w/2, y: bounds.y + bounds.h },
            sw: { x: bounds.x,              y: bounds.y + bounds.h },
            w:  { x: bounds.x,              y: bounds.y + bounds.h/2 }
        };

        const anchorMap = {
            nw: { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
            n:  { x: bounds.x + bounds.w/2, y: bounds.y + bounds.h },
            ne: { x: bounds.x, y: bounds.y + bounds.h },
            e:  { x: bounds.x, y: bounds.y + bounds.h/2 },
            se: { x: bounds.x, y: bounds.y },
            s:  { x: bounds.x + bounds.w/2, y: bounds.y },
            sw: { x: bounds.x + bounds.w, y: bounds.y },
            w:  { x: bounds.x + bounds.w, y: bounds.y + bounds.h/2 }
        };

        const handlePos = handleMap[handle];
        const anchor = anchorMap[handle];
        const isCorner = ['nw', 'ne', 'sw', 'se'].includes(handle);
        const origW = bounds.w;
        const origH = bounds.h;

        const origDx = handlePos.x - anchor.x;
        const origDy = handlePos.y - anchor.y;

        this._isResizing = true;
        this._resizeInfo = { handle, clip };

        const onMouseMove = (e) => {
            if (!this._isResizing) return;
            const pos = this._getOverlayMousePos(e);
            const local = this._worldToLocal(pos.x, pos.y, bounds);

            let newW = origW;
            let newH = origH;
            let newX = bounds.x;
            let newY = bounds.y;

            if (isCorner) {
                const dx = local.x - anchor.x;
                const dy = local.y - anchor.y;

                let ratioX = origDx !== 0 ? dx / origDx : 1;
                let ratioY = origDy !== 0 ? dy / origDy : 1;

                const ratio = Math.max(0.05, Math.max(
                    Math.abs(ratioX),
                    Math.abs(ratioY)
                ));

                newW = Math.max(20, origW * ratio);
                newH = Math.max(20, origH * ratio);

                if (handle === 'nw') {
                    newX = anchor.x - newW;
                    newY = anchor.y - newH;
                } else if (handle === 'ne') {
                    newX = anchor.x;
                    newY = anchor.y - newH;
                } else if (handle === 'sw') {
                    newX = anchor.x - newW;
                    newY = anchor.y;
                } else if (handle === 'se') {
                    newX = anchor.x;
                    newY = anchor.y;
                }
            } else {
                if (handle === 'n') {
                    newH = Math.max(20, anchor.y - local.y);
                    newY = anchor.y - newH;
                } else if (handle === 's') {
                    newH = Math.max(20, local.y - anchor.y);
                    newY = anchor.y;
                } else if (handle === 'w') {
                    newW = Math.max(20, anchor.x - local.x);
                    newX = anchor.x - newW;
                } else if (handle === 'e') {
                    newW = Math.max(20, local.x - anchor.x);
                    newX = anchor.x;
                }
            }

            if (isText) {
                const textData = clip.material.textData || {};
                const paddingTotal = (textData.padding || 0) * 2;

                if (isCorner) {
                    // ===== 四角缩放 =====
                    // 只改变显示大小（scale），不修改字号、排版参数
                    // 用户拖动四角时，蓝框等比例放大/缩小，文字大小跟着变但字号不变
                    const ratio = Math.max(newW / origW, newH / origH);
                    const newScale = Math.max(10, Math.round(ratio * 100));
                    
                    clip.effects.scale = newScale;
                    clip.effects.scaleX = newScale;
                    clip.effects.scaleY = newScale;

                    const actualW = origW * (newScale / 100);
                    const actualH = origH * (newScale / 100);

                    let actualX = bounds.x;
                    let actualY = bounds.y;
                    if (handle === 'nw') {
                        actualX = anchor.x - actualW;
                        actualY = anchor.y - actualH;
                    } else if (handle === 'ne') {
                        actualX = anchor.x;
                        actualY = anchor.y - actualH;
                    } else if (handle === 'sw') {
                        actualX = anchor.x - actualW;
                        actualY = anchor.y;
                    } else if (handle === 'se') {
                        actualX = anchor.x;
                        actualY = anchor.y;
                    }

                    const newPosX = Math.round((actualX - (canvasW - actualW) / 2) / renderScale.x);
                    const newPosY = Math.round((actualY - (canvasH - actualH) / 2) / renderScale.y);

                    if (this.onClipTransform) {
                        this.onClipTransform({
                            clipId: clip.id,
                            scale: newScale,
                            scaleX: newScale,
                            scaleY: newScale,
                            posX: newPosX,
                            posY: newPosY
                        });
                    }
                    return;
                }

                // ===== 四边调整 =====
                if (handle === 'w' || handle === 'e') {
                    // 左右边：调整宽度 → 修改 maxWidth → 文字重新排版
                    // 高度由 TextManager 根据新宽度自动计算，以宽度为基准
                    textData.maxWidth = Math.max(50, newW - paddingTotal);
                    
                    // 清除缓存，让 TextManager 重新计算文本高度
                    if (window.textManager) {
                        window.textManager.invalidate(clip.material.id);
                    }

                    // 更新 frameWidth，frameHeight 由 TextManager 计算后再更新
                    textData.frameWidth = newW;
                } else if (handle === 'n' || handle === 's') {
                    // 上下边：只调整高度，不修改字号和排版
                    // 用户拖动上下边只是改变蓝框高度，文字排版不变
                    textData.frameHeight = Math.max(20, newH);
                }

                // 四边调整时 scale 保持 100
                const newScale = 100;
                clip.effects.scale = newScale;
                clip.effects.scaleX = newScale;
                clip.effects.scaleY = newScale;

                // 获取实际尺寸（可能已由 TextManager 更新）
                let actualW = textData.frameWidth || newW;
                let actualH = textData.frameHeight || newH;

                // 重新获取 TextManager 计算的实际高度（以宽度为基准）
                if (window.textManager && (handle === 'w' || handle === 'e')) {
                    const cached = window.textManager.getOrCreateTextImage(clip.material);
                    if (cached) {
                        actualH = cached.height;
                        textData.frameHeight = actualH;
                    }
                }

                let actualX = bounds.x;
                let actualY = bounds.y;
                if (handle === 'nw') {
                    actualX = anchor.x - actualW;
                    actualY = anchor.y - actualH;
                } else if (handle === 'n') {
                    actualX = anchor.x - actualW / 2;
                    actualY = anchor.y - actualH;
                } else if (handle === 'ne') {
                    actualX = anchor.x;
                    actualY = anchor.y - actualH;
                } else if (handle === 'e') {
                    actualX = anchor.x;
                    actualY = anchor.y - actualH / 2;
                } else if (handle === 'se') {
                    actualX = anchor.x;
                    actualY = anchor.y;
                } else if (handle === 's') {
                    actualX = anchor.x - actualW / 2;
                    actualY = anchor.y;
                } else if (handle === 'sw') {
                    actualX = anchor.x - actualW;
                    actualY = anchor.y;
                } else if (handle === 'w') {
                    actualX = anchor.x - actualW;
                    actualY = anchor.y - actualH / 2;
                }

                const newPosX = Math.round((actualX - (canvasW - actualW) / 2) / renderScale.x);
                const newPosY = Math.round((actualY - (canvasH - actualH) / 2) / renderScale.y);

                if (this.onClipTransform) {
                    this.onClipTransform({
                        clipId: clip.id,
                        scale: newScale,
                        scaleX: newScale,
                        scaleY: newScale,
                        posX: newPosX,
                        posY: newPosY,
                        fontSize: textData.fontSize,
                        maxWidth: textData.maxWidth,
                        lineHeight: textData.lineHeight
                    });
                }
                return;
            }

            const newScaleX = Math.round((newW / (sourceSize.w * scaleToFit)) * 100);
            const newScaleY = Math.round((newH / (sourceSize.h * scaleToFit)) * 100);
            const newPosX = Math.round((newX - (canvasW - newW) / 2) / renderScale.x);
            const newPosY = Math.round((newY - (canvasH - newH) / 2) / renderScale.y);

            if (this.onClipTransform) {
                this.onClipTransform({
                    clipId: clip.id,
                    scaleX: newScaleX,
                    scaleY: newScaleY,
                    scale: Math.round((newScaleX + newScaleY) / 2),
                    posX: newPosX,
                    posY: newPosY
                });
            }
        };

        const onMouseUp = () => {
            this._isResizing = false;
            this._resizeInfo = null;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            // 通知编辑器：变换结束，可记录历史
            if (this.onClipTransformEnd) this.onClipTransformEnd({ clipId: clip.id });
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }
    
    _startDragging(startWorldX, startWorldY, clip) {
        const effects = this._getInterpolatedEffects(clip);
        const renderScale = this._getRenderScale();
        this._isDragging = true;
        this._dragInfo = {
            clip,
            startX: startWorldX,
            startY: startWorldY,
            startPosX: effects.posX || 0,
            startPosY: effects.posY || 0,
            renderScale
        };
        
        const onMouseMove = (e) => {
            if (!this._isDragging) return;
            const info = this._dragInfo;
            const pos = this._getOverlayMousePos(e);
            const dx = (pos.x - info.startX) / info.renderScale.x;
            const dy = (pos.y - info.startY) / info.renderScale.y;
            
            if (this.onClipTransform) {
                this.onClipTransform({
                    clipId: clip.id,
                    posX: Math.round(info.startPosX + dx),
                    posY: Math.round(info.startPosY + dy)
                });
            }
        };
        
        const onMouseUp = () => {
            this._isDragging = false;
            this._dragInfo = null;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            // 通知编辑器：变换结束，可记录历史
            if (this.onClipTransformEnd) this.onClipTransformEnd({ clipId: clip.id });
        };
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    resizeCanvas() {
        this._ensureCanvasSize();
        if (this.renderer && this.renderer._resize) {
            this.renderer._resize();
        }
    }

    setCanvasRatio(ratioW, ratioH, baseSize = 1080) {
        const ratio = ratioW / ratioH;
        this.canvasAspectRatio = ratio;

        this._ensureCanvasSize();
        this._needsRender = true;
    }

    setCanvasRatioFromVideo(width, height) {
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(width, height);
        const ratioW = width / g;
        const ratioH = height / g;
        this.setCanvasRatio(ratioW, ratioH, Math.min(width, height));
    }

    getCanvasRatioText() {
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const g = gcd(this.canvasW, this.canvasH);
        return `${this.canvasW / g}:${this.canvasH / g}`;
    }

    enterExportMode() {
        this.isPlaying = false;
        this.isSeeking = false;
    }

    exitExportMode() {
    }

    async renderFrameAt(time, width, height) {
        this.currentTime = Math.max(0, time);

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        const activeClips = this._getActiveClips();

        if (activeClips.length === 0) {
            const gl = this.renderer?.gl;
            if (gl) {
                gl.viewport(0, 0, width, height);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            return true;
        }

        if (this._supported && activeClips.every(c => {
            const loaded = this.demuxers.get(c.material.url);
            return loaded?.demuxer && c._decoder;
        })) {
            for (const clip of activeClips) {
                await this._decodeClipAtTime(clip, time);
            }
            if (this.compositor && this.renderer) {
                this.compositor.render(time, this.timelineClips, width, height);
            }
            return true;
        }

        this.renderer.beginFrame();
        for (const clip of activeClips) {
            this._renderClip(clip, width, height);
        }
        this.renderer.endFrame();
        
        return true;
    }

    async _decodeClipAtTime(clip, time) {
        const loaded = this.demuxers.get(clip.material.url);
        if (!loaded?.demuxer) return;
        const demuxer = loaded.demuxer;

        if (!clip._decoder) {
            const config = demuxer.getVideoConfig();
            if (!config) return;
            clip._decoder = {
                decoder: new VideoDecoder({
                    output: (frame) => {
                        if (!clip._frameBuffer) clip._frameBuffer = [];
                        clip._frameBuffer.push(frame);
                    },
                    error: (e) => console.warn('Decode error:', e)
                }),
                isReady: false,
                frameBuffer: [],
                _decodedUntil: -1
            };
            clip._decoder.decoder.configure(config);
            clip._decoder.isReady = true;
        }

        const clipTime = time - clip.startTime;
        const offsetTime = (clip.offset || 0) + clipTime;
        const timeUs = offsetTime * 1000000;

        const keyframeIndex = demuxer.findKeyframeIndexBefore(timeUs);
        if (keyframeIndex < 0) return;

        clip._decoder.decoder.reset();
        clip._frameBuffer = [];

        const targetIndex = Math.min(keyframeIndex + 30, demuxer.videoSamples.length - 1);
        for (let i = keyframeIndex; i <= targetIndex; i++) {
            const chunk = await demuxer.getVideoChunk(i);
            if (chunk) {
                clip._decoder.decoder.decode(chunk);
            }
        }
        
        await clip._decoder.decoder.flush();
    }

    async getAudioDataForClip(clip, startTime, endTime) {
        const loaded = this.demuxers.get(clip.material.url);
        if (!loaded?.demuxer) return [];
        const demuxer = loaded.demuxer;
        if (!demuxer.audioTrack || demuxer.audioSamples.length === 0) return [];

        const clipOffset = clip.offset || 0;
        const clipStartTime = startTime - clip.startTime;
        const clipEndTime = endTime - clip.startTime;
        const audioStartTimeUs = (clipOffset + Math.max(0, clipStartTime)) * 1000000;
        const audioEndTimeUs = (clipOffset + Math.min(clip.duration, clipEndTime)) * 1000000;

        const audioConfig = demuxer.getAudioConfig();
        if (!audioConfig) return [];

        const frames = [];
        const audioDecoder = new AudioDecoder({
            output: (audioData) => frames.push(audioData),
            error: (e) => console.warn('[音频解码错误]', e)
        });

        audioDecoder.configure(audioConfig);

        let startIdx = 0;
        let endIdx = demuxer.audioSamples.length - 1;
        for (let i = 0; i < demuxer.audioSamples.length; i++) {
            if (demuxer.audioSamples[i].ctsUs >= audioStartTimeUs) {
                startIdx = Math.max(0, i - 1);
                break;
            }
        }
        for (let i = startIdx; i < demuxer.audioSamples.length; i++) {
            if (demuxer.audioSamples[i].ctsUs >= audioEndTimeUs) {
                endIdx = i;
                break;
            }
        }

        for (let i = startIdx; i <= endIdx && i < demuxer.audioSamples.length; i++) {
            const chunk = await demuxer.getAudioChunk(i);
            if (chunk) audioDecoder.decode(chunk);
        }

        await audioDecoder.flush();
        audioDecoder.close();

        return frames;
    }

    getAudioConfigs() {
        const configs = [];
        for (const clip of this.timelineClips) {
            if (clip.trackIndex >= 100) continue;
            if (clip.material.type !== 'video') continue;
            const loaded = this.demuxers.get(clip.material.url);
            if (!loaded?.demuxer) continue;
            const config = loaded.demuxer.getAudioConfig();
            if (config) {
                configs.push({ clip, config, demuxer: loaded.demuxer });
            }
        }
        return configs;
    }
}

window.VideoEngine = VideoEngine;
