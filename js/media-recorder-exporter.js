/**
 * MediaRecorder 导出器 v1 - 使用系统硬件编码器加速导出
 * 
 * 核心原理：
 * - canvas.captureStream() 获取视频流
 * - MediaRecorder 录制该流（可能走系统硬件编码器）
 * - Web Audio API 混合音频后接入 MediaStream
 * 
 * 优势：
 * - 可能利用系统硬件编码器（Intel Quick Sync / NVIDIA NVENC / AMD AMF）
 * - 导出速度通常比 WebCodecs 软件编码快 2-5 倍
 * - 支持 MP4 (H.264) 和 WebM (VP8/VP9)
 */

class MediaRecorderExporter {
    constructor(editor) {
        this.editor = editor;
        this.isExporting = false;
        this.abortController = null;
        this.onProgress = null;
        this.onComplete = null;
        this.onError = null;
        this.canvas = null;
        this.ctx = null;
        this.mediaRecorder = null;
        this._recordedChunks = [];
        this._imageCache = new Map();
    }

    static isSupported() {
        const hasCanvas = typeof HTMLCanvasElement !== 'undefined';
        const hasMR = typeof MediaRecorder !== 'undefined';
        const hasCaptureStream = hasCanvas && typeof document.createElement('canvas').captureStream === 'function';
        console.log(`[MediaRecorder v1] isSupported: MediaRecorder=${hasMR}, captureStream=${hasCaptureStream}`);

        if (hasMR) {
            const testTypes = [
                'video/webm;codecs=vp9',
                'video/webm;codecs=vp8',
                'video/webm',
                'video/mp4;codecs=h264',
                'video/mp4'
            ];
            for (const t of testTypes) {
                try {
                    if (MediaRecorder.isTypeSupported(t)) {
                        console.log(`[MediaRecorder v1] 支持格式: ${t}`);
                    }
                } catch (e) {}
            }
        }

        return hasMR && hasCaptureStream;
    }

    static getSupportedMimeTypes() {
        if (typeof MediaRecorder === 'undefined') return [];
        const candidates = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4;codecs=h264,aac',
            'video/mp4'
        ];
        return candidates.filter(t => {
            try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; }
        });
    }

    async export(options = {}) {
        const {
            filename = 'export',
            width = 1920,
            height = 1080,
            fps = 30,
            videoBitrate = 8000000,
            audioBitrate = 192000,
            format = 'webm'
        } = options;

        this.isExporting = true;
        this._recordedChunks = [];
        this._imageCache = new Map();
        this.abortController = new AbortController();

        const renderer = this.editor.videoRenderer || this.editor.videoEngine;
        const mainRenderer = this.editor.videoEngine || this.editor.videoRenderer;
        let totalDuration = this.editor.totalDuration;

        let wasPlaying = false;
        if (mainRenderer) {
            wasPlaying = mainRenderer.isPlaying;
            if (mainRenderer.pause) mainRenderer.pause();
            if (mainRenderer.releaseWebGL) mainRenderer.releaseWebGL();
            console.log('[MediaRecorder] 已暂停主预览渲染');
        }

        const allClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex < 100 && c.material);

        const audioTrackClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex >= 100 && c.material && c.material.type === 'audio');

        const videoClips = allClips.filter(c => c.material.type === 'video');
        const imageClips = allClips.filter(c => c.material.type === 'image');
        const textClips = allClips.filter(c => c.material.type === 'text');

        if (allClips.length === 0 && audioTrackClips.length === 0) {
            this._restoreMainRenderer(mainRenderer, wasPlaying);
            throw new Error('没有可导出的素材');
        }

        if (!totalDuration || totalDuration <= 0) {
            const videoEnd = allClips.length > 0 ? Math.max(...allClips.map(c => c.startTime + c.duration)) : 0;
            const audioEnd = audioTrackClips.length > 0 ? Math.max(...audioTrackClips.map(c => c.startTime + c.duration)) : 0;
            totalDuration = Math.max(videoEnd, audioEnd);
        }

        const outW = Math.floor(width);
        const outH = Math.floor(height);
        const outFps = Math.max(1, Math.floor(fps));
        const totalFrames = Math.ceil(totalDuration * outFps);

        console.log(`[MediaRecorder v1] 开始导出: ${outW}x${outH} @ ${outFps}fps, ${totalDuration.toFixed(2)}s, 格式: ${format}`);

        const startTime = performance.now();
        let resultBlob = null;

        try {
            this.updateProgress(2, '创建 Canvas...');
            this.canvas = document.createElement('canvas');
            this.canvas.width = outW;
            this.canvas.height = outH;
            this.canvas.style.display = 'none';
            document.body.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });

            this.updateProgress(3, '加载图片...');
            await this._loadImages(imageClips);

            this.updateProgress(5, '准备视频...');
            const videoElements = await this._prepareVideos(videoClips);

            this.updateProgress(8, '初始化 MediaRecorder...');

            let videoBitrateNum;
            if (typeof videoBitrate === 'string') {
                const m = videoBitrate.match(/^(\d+(?:\.\d+)?)\s*[Mm]?$/);
                videoBitrateNum = m ? Math.round(parseFloat(m[1]) * 1000000) : 8000000;
            } else {
                videoBitrateNum = Math.floor(videoBitrate) || 8000000;
            }

            const mimeType = this._pickMimeType(format);
            console.log(`[MediaRecorder v1] 使用 MIME 类型: ${mimeType}`);

            const videoStream = this.canvas.captureStream(outFps);
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioDestination = audioContext.createMediaStreamDestination();

            const combinedStream = new MediaStream([
                ...videoStream.getVideoTracks(),
                ...audioDestination.stream.getAudioTracks()
            ]);

            const recorderOptions = {
                mimeType: mimeType,
                videoBitsPerSecond: videoBitrateNum,
                audioBitsPerSecond: audioBitrate
            };

            this.mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this._recordedChunks.push(event.data);
                }
            };

            const recorderReady = new Promise((resolve, reject) => {
                this.mediaRecorder.onstart = () => {
                    console.log('[MediaRecorder v1] 录制开始');
                    resolve();
                };
                this.mediaRecorder.onerror = (e) => {
                    console.error('[MediaRecorder v1] 录制错误:', e);
                    reject(e.error || new Error('MediaRecorder 错误'));
                };
            });

            this.mediaRecorder.start(100);
            await recorderReady;

            this.updateProgress(10, '开始渲染录制...');

            await this._renderAndRecord(
                videoClips, imageClips, textClips, audioTrackClips,
                videoElements, audioContext, audioDestination,
                totalDuration, outFps, totalFrames, startTime
            );

            console.log('[MediaRecorder v1] 停止录制...');
            this.updateProgress(95, '生成文件...');

            const stopped = new Promise((resolve) => {
                this.mediaRecorder.onstop = resolve;
            });
            this.mediaRecorder.stop();
            await stopped;

            const blobType = mimeType.split(';')[0];
            const blob = new Blob(this._recordedChunks, { type: blobType });
            console.log(`[MediaRecorder v1] 输出: ${blob.size} bytes (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

            const totalTime = (performance.now() - startTime) / 1000;
            const avgSpeed = totalDuration / totalTime;
            console.log(`[MediaRecorder v1] 完成: ${totalTime.toFixed(1)}s, ${avgSpeed.toFixed(2)}x 实时速度`);

            this.updateProgress(100, '导出完成！');

            const ext = blobType.includes('mp4') ? 'mp4' : 'webm';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (this.onComplete) this.onComplete(blob);
            resultBlob = blob;

            try { audioContext.close(); } catch (e) {}

        } catch (error) {
            console.error('[MediaRecorder v1] 导出失败:', error);
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                try { this.mediaRecorder.stop(); } catch (e) {}
            }
            throw error;
        } finally {
            this._restoreMainRenderer(mainRenderer, wasPlaying);
            this._cleanup(videoElements);
        }

        this.isExporting = false;
        return resultBlob;
    }

    _pickMimeType(format) {
        const supported = MediaRecorderExporter.getSupportedMimeTypes();
        console.log('[MediaRecorder v1] 支持的格式列表:', supported);

        if (format === 'mp4') {
            const mp4Types = supported.filter(t => t.includes('mp4'));
            if (mp4Types.length > 0) return mp4Types[0];
            console.warn('[MediaRecorder v1] 不支持 MP4，回退到 WebM');
        }

        const webmVP9 = supported.find(t => t.includes('vp9'));
        if (webmVP9) return webmVP9;

        const webmVP8 = supported.find(t => t.includes('vp8'));
        if (webmVP8) return webmVP8;

        if (supported.length > 0) return supported[0];

        return 'video/webm';
    }

    async _loadImages(imageClips) {
        for (const clip of imageClips) {
            const url = clip.material.url;
            if (this._imageCache.has(url)) continue;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = url;

            await new Promise((resolve) => {
                if (img.complete) { resolve(); return; }
                img.onload = resolve;
                img.onerror = () => { console.warn('[MediaRecorder] 图片加载失败:', url); resolve(); };
                setTimeout(resolve, 3000);
            });

            this._imageCache.set(url, img);
        }
    }

    async _prepareVideos(videoClips) {
        const videoElements = new Map();

        for (const clip of videoClips) {
            const url = clip.material.url;
            if (videoElements.has(url)) continue;

            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true;
            video.preload = 'auto';
            video.playsInline = true;
            video.src = url;
            video.style.display = 'none';
            document.body.appendChild(video);

            await new Promise((resolve) => {
                const onReady = () => {
                    video.removeEventListener('loadedmetadata', onReady);
                    video.removeEventListener('error', onError);
                    resolve();
                };
                const onError = () => {
                    console.warn('[MediaRecorder] 视频加载失败:', clip.material.name);
                    video.removeEventListener('loadedmetadata', onReady);
                    video.removeEventListener('error', onError);
                    resolve();
                };
                video.addEventListener('loadedmetadata', onReady);
                video.addEventListener('error', onError);
                setTimeout(resolve, 5000);
            });

            videoElements.set(url, video);
        }

        return videoElements;
    }

    async _renderAndRecord(
        videoClips, imageClips, textClips, audioTrackClips,
        videoElements, audioContext, audioDestination,
        totalDuration, outFps, totalFrames, startTime
    ) {
        const frameInterval = 1 / outFps;

        const activeVideoClips = videoClips.filter(c => {
            const v = videoElements.get(c.material.url);
            return v && v.readyState >= 1;
        });

        const sortedVideoClips = [...activeVideoClips].sort((a, b) => b.trackIndex - a.trackIndex);
        const sortedImageClips = [...imageClips].sort((a, b) => b.trackIndex - a.trackIndex);
        const sortedTextClips = [...textClips].sort((a, b) => b.trackIndex - a.trackIndex);

        const audioSources = [];

        const hasAudio = (videoClips.length > 0 && videoClips.some(c => {
            const v = videoElements.get(c.material.url);
            return v && v.mozHasAudio !== false;
        })) || audioTrackClips.length > 0;

        console.log(`[MediaRecorder v1] 模式: ${hasAudio ? '音视频同步（实时录制）' : '仅视频（实时录制）'}`);

        await this._setupAudioAndVideo(
            videoClips, audioTrackClips, videoElements,
            audioContext, audioDestination, audioSources
        );

        await this._startPlayback(audioSources);

        let renderedFrames = 0;
        let lastFrameRealTime = 0;
        const targetFrameMs = 1000 / outFps;

        while (renderedFrames < totalFrames) {
            if (this.abortController.signal.aborted) {
                throw new Error('导出已取消');
            }

            const now = performance.now();
            const elapsedMs = now - startTime;
            const frameTime = elapsedMs / 1000;

            if (frameTime >= totalDuration + 0.1) {
                break;
            }

            const expectedFrame = Math.floor(elapsedMs / targetFrameMs);
            if (expectedFrame <= renderedFrames) {
                const waitMs = Math.max(1, (renderedFrames + 1) * targetFrameMs - elapsedMs);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

            for (const clip of sortedImageClips) {
                const clipStart = clip.startTime;
                const clipEnd = clip.startTime + clip.duration;
                if (frameTime < clipStart || frameTime > clipEnd) continue;

                const img = this._imageCache.get(clip.material.url);
                if (!img) continue;

                this._drawClipElement(this.ctx, img, clip, frameTime, this.canvas.width, this.canvas.height);
            }

            for (const clip of sortedVideoClips) {
                const clipStart = clip.startTime;
                const clipEnd = clip.startTime + clip.duration;
                if (frameTime < clipStart || frameTime > clipEnd) continue;

                const video = videoElements.get(clip.material.url);
                if (!video) continue;

                this._drawClipElement(this.ctx, video, clip, frameTime, this.canvas.width, this.canvas.height);
            }

            for (const clip of sortedTextClips) {
                const clipStart = clip.startTime;
                const clipEnd = clip.startTime + clip.duration;
                if (frameTime < clipStart || frameTime > clipEnd) continue;

                if (!window.textManager) window.textManager = new TextManager();
                const cached = window.textManager.getOrCreateTextImage(clip.material);
                if (!cached || !cached.image) continue;

                this._drawClipElement(this.ctx, cached.image, clip, frameTime, this.canvas.width, this.canvas.height);
            }

            renderedFrames = expectedFrame;

            if (renderedFrames % Math.max(1, Math.floor(outFps)) === 0 || renderedFrames >= totalFrames) {
                const progress = 10 + Math.min(85, Math.floor((frameTime / totalDuration) * 85));
                const speed = frameTime > 0 ? (frameTime / ((now - startTime) / 1000)).toFixed(2) : '0';
                this.updateProgress(progress, `录制 ${frameTime.toFixed(1)}s/${totalDuration.toFixed(1)}s (${speed}x)`);
            }

            await new Promise(r => setTimeout(r, 0));
        }

        const totalTime = (performance.now() - startTime) / 1000;
        console.log(`[MediaRecorder v1] 录制完成: ${renderedFrames} 帧, 用时 ${totalTime.toFixed(1)}s`);

        for (const { video, audioElement } of audioSources) {
            const el = video || audioElement;
            if (el) {
                try { el.pause(); } catch (e) {}
            }
        }
    }

    async _setupAudioAndVideo(videoClips, audioTrackClips, videoElements, audioContext, audioDestination, audioSources) {
        for (const clip of videoClips) {
            const video = videoElements.get(clip.material.url);
            if (!video) continue;

            try {
                const source = audioContext.createMediaElementSource(video);
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 0;
                source.connect(gainNode);
                gainNode.connect(audioDestination);
                audioSources.push({ source, gainNode, clip, video });
            } catch (e) {
                console.warn('[MediaRecorder] 视频音频源创建失败:', e);
            }
        }

        for (const clip of audioTrackClips) {
            if (!clip.material || !clip.material.url) continue;
            try {
                const audio = new Audio();
                audio.crossOrigin = 'anonymous';
                audio.src = clip.material.url;
                audio.preload = 'auto';

                await new Promise(resolve => {
                    if (audio.readyState >= 1) { resolve(); return; }
                    audio.addEventListener('loadedmetadata', resolve, { once: true });
                    setTimeout(resolve, 3000);
                });

                const source = audioContext.createMediaElementSource(audio);
                const gainNode = audioContext.createGain();
                gainNode.gain.value = 0;
                source.connect(gainNode);
                gainNode.connect(audioDestination);
                audioSources.push({ source, gainNode, clip, audioElement: audio });
            } catch (e) {
                console.warn('[MediaRecorder] 音频轨道创建失败:', e);
            }
        }

        for (const { clip, video, audioElement } of audioSources) {
            const clipOffset = clip.offset || 0;
            const mediaEl = video || audioElement;
            if (!mediaEl) continue;

            try {
                mediaEl._clipOffset = clipOffset;
                mediaEl._clipStart = clip.startTime;
                mediaEl._clipEnd = clip.startTime + clip.duration;
                mediaEl._clipVolume = (clip.volume !== undefined ? clip.volume : 100) / 100;
                mediaEl.currentTime = clipOffset;
            } catch (e) {}
        }

        for (const [url, video] of videoElements) {
            const clip = videoClips.find(c => c.material.url === url);
            if (!video._clipStart && clip) {
                video._clipOffset = clip.offset || 0;
                video._clipStart = clip.startTime;
                video._clipEnd = clip.startTime + clip.duration;
            }
        }

        await new Promise(r => setTimeout(r, 300));
    }

    async _startPlayback(audioSources) {
        for (const { clip, video, audioElement, gainNode } of audioSources) {
            const mediaEl = video || audioElement;
            if (!mediaEl) continue;

            try {
                const volume = (clip.volume !== undefined ? clip.volume : 100) / 100;
                if (gainNode) {
                    gainNode.gain.value = volume;
                }
                const p = mediaEl.play();
                if (p && p.catch) p.catch(e => console.warn('[MediaRecorder] 播放失败:', e));
            } catch (e) {
                console.warn('[MediaRecorder] 播放启动失败:', e);
            }
        }

        await new Promise(r => setTimeout(r, 100));
    }

    _getInterpolatedEffects(clip, clipTime) {
        if (!clip.keyframes || clip.keyframes.length === 0) {
            return clip.effects || {
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
        }

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
            return base;
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

        return {
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
    }

    _getExportScale(canvasW, canvasH) {
        const mainRenderer = this.editor?.videoEngine || this.editor?.videoRenderer;
        const baseW = mainRenderer?.canvasW || canvasW;
        const baseH = mainRenderer?.canvasH || canvasH;
        if (baseW > 0 && baseH > 0) {
            return { x: canvasW / baseW, y: canvasH / baseH };
        }
        return { x: 1, y: 1 };
    }

    _drawClipElement(ctx, element, clip, currentTime, canvasW, canvasH) {
        const clipTime = currentTime - clip.startTime;
        const effects = this._getInterpolatedEffects(clip, clipTime);
        const exportScale = this._getExportScale(canvasW, canvasH);
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = (effects.posX || 0) * exportScale.x;
        const posY = (effects.posY || 0) * exportScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const isText = clip.material && clip.material.type === 'text';

        let frameW, frameH;
        if (element instanceof HTMLVideoElement) {
            frameW = element.videoWidth;
            frameH = element.videoHeight;
        } else {
            frameW = element.naturalWidth || element.width;
            frameH = element.naturalHeight || element.height;
        }

        if (!frameW || !frameH) return;

        let drawW, drawH;
        if (isText) {
            const uniformScale = ((effects.scale !== undefined ? effects.scale : Math.min(effects.scaleX || 100, effects.scaleY || 100)) || 100) / 100;
            const fitScale = Math.min(canvasW / frameW, canvasH / frameH);
            drawW = frameW * fitScale * uniformScale;
            drawH = frameH * fitScale * uniformScale;
        } else {
            const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
            const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
            const fitScale = Math.min(canvasW / frameW, canvasH / frameH);
            drawW = frameW * fitScale * scaleX;
            drawH = frameH * fitScale * scaleY;
        }
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        try {
            ctx.drawImage(element, -drawW / 2, -drawH / 2, drawW, drawH);
        } catch (e) {}
        ctx.restore();
    }

    _restoreMainRenderer(mainRenderer, wasPlaying) {
        if (mainRenderer) {
            if (mainRenderer.restoreWebGL) {
                mainRenderer.restoreWebGL();
            } else {
                if (mainRenderer._startLoop) mainRenderer._startLoop();
                if (mainRenderer.start) mainRenderer.start();
            }
            if (wasPlaying) {
                if (mainRenderer.play) mainRenderer.play();
            } else {
                if (mainRenderer.seek) mainRenderer.seek(mainRenderer.currentTime || 0);
            }
            console.log('[MediaRecorder] 已恢复主预览渲染循环');
        }
    }

    _cleanup(videoElements) {
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
            this.canvas = null;
            this.ctx = null;
        }

        if (videoElements) {
            for (const [url, video] of videoElements) {
                try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {}
                if (video.parentNode) video.parentNode.removeChild(video);
            }
        }

        this.mediaRecorder = null;
        this._recordedChunks = [];
    }

    updateProgress(percent, message) {
        if (this.onProgress) this.onProgress(percent, message);
    }

    cancel() {
        if (this.abortController) this.abortController.abort();
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (e) {}
        }
    }
}

window.MediaRecorderExporter = MediaRecorderExporter;
