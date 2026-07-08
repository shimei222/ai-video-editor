/**
 * WebCodecs 快速导出器 v13 - 双阶段流水线（先全部解码，再编码）
 * 阶段1：解码所有片段到内存（解码器独占GPU）
 * 阶段2：渲染 + 编码（编码器独占GPU）
 */

class WebCodecsExporter {
    constructor(editor) {
        this.editor = editor;
        this.isExporting = false;
        this.abortController = null;
        this.onProgress = null;
        this.onComplete = null;
        this.onError = null;
        this.canvas = null;
        this.ctx = null;
        this.muxer = null;
        this.videoEncoder = null;
        this.audioEncoder = null;
        this._muxerFinalized = false;
    }

    static isSupported() {
        const hasVideo = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
        const hasAudio = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
        const hasMuxer = typeof WebMMuxer !== 'undefined';
        const hasDemuxer = typeof MP4Demuxer !== 'undefined';
        console.log(`[WebCodecs v13] isSupported: Video=${hasVideo} Audio=${hasAudio} Muxer=${hasMuxer} Demuxer=${hasDemuxer}`);
        return hasVideo && hasMuxer && hasDemuxer;
    }

    async export(options = {}) {
        const {
            filename = 'export',
            width = 1920,
            height = 1080,
            fps = 30,
            videoBitrate = 5000000,
            audioBitrate = 128000
        } = options;

        this.isExporting = true;
        this._muxerFinalized = false;
        this.abortController = new AbortController();

        const renderer = this.editor.videoRenderer || this.editor.videoEngine;
        let totalDuration = this.editor.totalDuration;
        if (!totalDuration || totalDuration <= 0) {
            const clips = this.editor.timelineClips || [];
            if (clips.length > 0) {
                totalDuration = Math.max(...clips.map(c => c.startTime + c.duration));
            }
        }

        console.log(`[WebCodecs v13] 开始导出: ${width}x${height} @ ${fps}fps, 总时长 ${totalDuration.toFixed(2)}s`);

        try {
            const result = await this._doExport(renderer, totalDuration, width, height, fps, filename, videoBitrate, audioBitrate);
            this.isExporting = false;
            return result;
        } catch (error) {
            console.error('[WebCodecs v13] 导出失败:', error);
            this.isExporting = false;
            if (this.onError) this.onError(error);
            throw error;
        }
    }

    async _doExport(renderer, totalDuration, width, height, fps, filename, videoBitrate, audioBitrate) {
        const startTime = performance.now();
        const outW = Math.floor(width);
        const outH = Math.floor(height);
        const outFps = Math.max(1, Math.floor(fps));

        // ====== 暂停主预览渲染循环 + 释放 WebGL ======
        const mainRenderer = this.editor.videoEngine || this.editor.videoRenderer;
        let wasPlaying = false;
        if (mainRenderer) {
            wasPlaying = mainRenderer.isPlaying;
            if (mainRenderer.pause) mainRenderer.pause();
            if (mainRenderer.releaseWebGL) {
                mainRenderer.releaseWebGL();
                console.log('[WebCodecs] 已释放主预览 WebGL 上下文');
            } else {
                if (mainRenderer._stopLoop) mainRenderer._stopLoop();
                if (mainRenderer.stop) mainRenderer.stop();
                console.log('[WebCodecs] 已暂停主预览渲染循环');
            }
        }

        let resultBlob = null;
        const videoElements = new Map();

        try {
            // 获取视频片段
            const clips = (this.editor.timelineClips || renderer.timelineClips || [])
                .filter(c => c.trackIndex < 100 && c.material && c.material.type === 'video')
                .sort((a, b) => b.trackIndex - a.trackIndex);

            if (clips.length === 0) throw new Error('没有可导出的视频片段');
            console.log(`[WebCodecs] 找到 ${clips.length} 个视频片段`);

            // ================================================================
            // 阶段1：解码 + 编码（使用 video 元素代替 VideoDecoder）
            // ================================================================
            console.log('[WebCodecs] 开始导出（video 元素解码模式）...');
            this.updateProgress(5, '准备视频...');

            // 创建渲染 Canvas
            this.canvas = document.createElement('canvas');
            this.canvas.width = outW;
            this.canvas.height = outH;
            this.canvas.style.display = 'none';
            document.body.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

            // 初始化视频编码器
            const videoCodecInfo = await this._initVideoEncoder(outW, outH, outFps, videoBitrate);
            if (!videoCodecInfo.supported) throw new Error('视频编码器初始化失败');
            
            const muxerVideoCodec = videoCodecInfo.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8';
            console.log(`[WebCodecs] 视频编码: ${videoCodecInfo.codec} -> ${muxerVideoCodec}`);

            // 初始化 muxer
            const muxerTarget = new WebMMuxer.ArrayBufferTarget();
            this.muxer = new WebMMuxer.Muxer({
                target: muxerTarget,
                video: { codec: muxerVideoCodec, width: outW, height: outH, frameRate: outFps },
                firstTimestampBehavior: 'permissive'
            });

            // 按时间排序所有片段
            const sortedClips = clips.sort((a, b) => a.startTime - b.startTime);
            const totalFrames = Math.ceil(totalDuration * outFps);
            const frameDurationUs = Math.floor(1000000 / outFps);

            console.log(`[WebCodecs] 开始编码 ${totalFrames} 帧...`);

            let renderedFrames = 0;
            let lastClipProgress = -1;

            // 处理每个片段
            for (const clip of sortedClips) {
                const videoUrl = clip.material.url;
                
                let video = videoElements.get(videoUrl);
                if (!video) {
                    video = document.createElement('video');
                    video.src = videoUrl;
                    video.muted = true;
                    video.playsInline = true;
                    video.preload = 'auto';
                    video.loop = false;
                    video.style.display = 'none';
                    video.crossOrigin = 'anonymous';
                    document.body.appendChild(video);
                    videoElements.set(videoUrl, video);
                    
                    await new Promise((resolve) => {
                        if (video.readyState >= 2) { resolve(); return; }
                        video.addEventListener('canplay', resolve, { once: true });
                        video.addEventListener('loadeddata', resolve, { once: true });
                        setTimeout(() => { if (video.readyState >= 1) resolve(); }, 500);
                    });
                }

                const clipStart = clip.startTime;
                const clipEnd = clip.startTime + clip.duration;
                const clipOffset = clip.offset || 0;
                
                const clipFrameStart = Math.max(0, Math.floor(clipStart * outFps));
                const clipFrameEnd = Math.min(totalFrames, Math.ceil(clipEnd * outFps));
                const clipFrameCount = clipFrameEnd - clipFrameStart;

                if (clipFrameCount <= 0) continue;

                console.log(`[导出] 片段 ${clip.material.name}: 帧 ${clipFrameStart}-${clipFrameEnd}`);

                // seek 到片段的其实时间（视频源时间）
                const seekTo = clipOffset;
                video.currentTime = seekTo;
                await new Promise((resolve) => {
                    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
                    video.addEventListener('seeked', onSeeked, { once: true });
                    setTimeout(resolve, 500);
                });

                // 以 2x 速度播放，通过轮询 currentTime 来捕获帧
                video.playbackRate = 2.0;
                await video.play();

                const clipDuration = clip.duration;
                const clipFrameInterval = 1.0 / outFps;
                let localFrameIdx = 0;
                let captureStartTime = performance.now();

                while (localFrameIdx < clipFrameCount) {
                    if (this.abortController.signal.aborted) { video.pause(); throw new Error('导出已取消'); }

                    const currentVideoTime = video.currentTime - clipOffset;
                    const targetTime = localFrameIdx * clipFrameInterval;
                    const drift = currentVideoTime - targetTime;

                    // 如果视频播放进度落后太多，重新 seek 对齐
                    if (drift < -clipFrameInterval * 3) {
                        const newSeek = clipOffset + targetTime;
                        video.currentTime = newSeek;
                        await new Promise(r => setTimeout(r, 50));
                        video.play();
                    }

                    // 如果当前时间 >= 目标时间，捕获这一帧
                    if (currentVideoTime >= targetTime - 0.001) {
                        const fi = clipFrameStart + localFrameIdx;
                        const frameTime = fi / outFps;
                        const frameTimeUs = fi * frameDurationUs;

                        this.ctx.fillStyle = '#000000';
                        this.ctx.fillRect(0, 0, outW, outH);
                        try { this.ctx.drawImage(video, 0, 0, outW, outH); } catch (e) {}

                        const vf = new VideoFrame(this.canvas, {
                            timestamp: frameTimeUs,
                            duration: frameDurationUs
                        });
                        while (this.videoEncoder.encodeQueueSize > 8) {
                            await new Promise(r => setTimeout(r, 2));
                        }
                        this.videoEncoder.encode(vf, { keyFrame: fi % 60 === 0 });
                        vf.close();
                        renderedFrames++;
                        localFrameIdx++;

                        if (renderedFrames % 20 === 0 || renderedFrames === totalFrames) {
                            const progress = Math.floor((renderedFrames / totalFrames) * 90);
                            const elapsed = (performance.now() - startTime) / 1000;
                            const speed = elapsed > 0 ? (frameTime / elapsed).toFixed(1) : '0';
                            this.updateProgress(progress, `编码 ${renderedFrames}/${totalFrames} 帧 (${frameTime.toFixed(1)}s) ${speed}x`);
                        }
                    }

                    // 短等待，让浏览器有时间解码下一帧
                    await new Promise(r => setTimeout(r, 2));
                }

                // 暂停当前片段
                video.pause();
            }

            console.log(`[WebCodecs] 编码完成, 共 ${renderedFrames} 帧`);

            // 刷新编码器
            console.log('[WebCodecs] 刷新编码器...');
            this.updateProgress(96, '刷新视频编码器...');
            await this.videoEncoder.flush();

            // Finalize muxer
            console.log('[WebCodecs] 生成视频文件...');
            this.updateProgress(98, '生成视频文件...');
            this._muxerFinalized = true;
            this.muxer.finalize();

            const blob = new Blob([muxerTarget.buffer], { type: 'video/webm' });
            console.log(`[WebCodecs] 输出: ${blob.size} bytes (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

            const totalTime = (performance.now() - startTime) / 1000;
            const avgSpeed = totalDuration / totalTime;
            console.log(`[WebCodecs] 完成: ${totalTime.toFixed(1)}s, ${avgSpeed.toFixed(2)}x 实时速度`);

            this.updateProgress(100, '导出完成！');

            // 下载
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.webm`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (this.onComplete) this.onComplete(blob);
            resultBlob = blob;

        } catch (error) {
            console.error('[WebCodecs] 导出异常:', error);
            throw error;
        } finally {
            // ====== 恢复主预览渲染循环 + 恢复 WebGL ======
            if (mainRenderer) {
                if (mainRenderer.restoreWebGL) {
                    mainRenderer.restoreWebGL();
                    console.log('[WebCodecs] 已恢复主预览 WebGL 上下文');
                } else {
                    if (mainRenderer._startLoop) mainRenderer._startLoop();
                    if (mainRenderer.start) mainRenderer.start();
                }
                if (wasPlaying) {
                    if (mainRenderer.play) mainRenderer.play();
                } else {
                    if (mainRenderer.seek) mainRenderer.seek(mainRenderer.currentTime || 0);
                }
                console.log('[WebCodecs] 已恢复主预览渲染循环');
            }
            // 清理离屏 Canvas
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
                this.canvas = null;
                this.ctx = null;
            }
            // 清理 video 元素
            if (videoElements) {
                for (const [url, ve] of videoElements) {
                    try { ve.pause(); ve.removeAttribute('src'); ve.load(); } catch (_) {}
                    if (ve.parentNode) ve.parentNode.removeChild(ve);
                }
            }
        }

        return resultBlob;
    }

    _drawFrame(ctx, frame, clip, canvasW, canvasH) {
        const effects = clip.effects || {};
        const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
        const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = effects.posX || 0;
        const posY = effects.posY || 0;
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const frameW = frame.displayWidth || frame.codedWidth || 1920;
        const frameH = frame.displayHeight || frame.codedHeight || 1080;

        const fitScale = Math.min(canvasW / frameW, canvasH / frameH);
        const drawW = frameW * fitScale * scaleX;
        const drawH = frameH * fitScale * scaleY;
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        ctx.drawImage(frame, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    }

    async _initVideoEncoder(width, height, fps, bitrate) {
        try {
            let videoBitrate;
            if (typeof bitrate === 'string') {
                const m = bitrate.match(/^(\d+(?:\.\d+)?)\s*[Mm]?$/);
                videoBitrate = m ? Math.round(parseFloat(m[1]) * 1000000) : 5000000;
            } else if (typeof bitrate === 'number') {
                videoBitrate = Math.floor(bitrate);
            } else {
                videoBitrate = 5000000;
            }
            if (isNaN(videoBitrate) || videoBitrate < 100000) videoBitrate = 5000000;

            const w = Math.floor(width);
            const h = Math.floor(height);
            const f = Math.max(1, Math.floor(fps));

            let usedCodec = 'vp8';
            let config = { codec: 'vp8', width: w, height: h, bitrate: videoBitrate, framerate: f };

            const s1 = await VideoEncoder.isConfigSupported(config);
            if (!s1.supported) {
                usedCodec = 'vp09.00.10.08';
                config = { codec: 'vp09.00.10.08', width: w, height: h, bitrate: videoBitrate, framerate: f };
                const s2 = await VideoEncoder.isConfigSupported(config);
                if (!s2.supported) return { supported: false, codec: null };
            }

            this._encodedVideoChunks = 0;
            this._encodedAudioChunks = 0;
            this.videoEncoder = new VideoEncoder({
                output: (chunk, meta) => {
                    this._encodedVideoChunks++;
                    if (this.muxer && !this._muxerFinalized) {
                        try { 
                            this.muxer.addVideoChunk(chunk, meta); 
                        } catch (e) {
                            console.error('[WebCodecs v13] muxer.addVideoChunk error:', e);
                        }
                    }
                },
                error: (e) => console.error('[WebCodecs v13] VideoEncoder error:', e)
            });
            this.videoEncoder.configure(config);
            console.log(`[WebCodecs v13] 视频编码器就绪: ${usedCodec}, ${videoBitrate}bps, ${f}fps`);
            return { supported: true, codec: usedCodec };
        } catch (e) {
            console.error('[WebCodecs v13] 视频编码器初始化失败:', e);
            return { supported: false, codec: null };
        }
    }

    async _initAudioEncoder(sampleRate, channels, bitrate) {
        try {
            const config = {
                codec: 'opus',
                sampleRate: Math.floor(sampleRate),
                numberOfChannels: Math.floor(channels),
                bitrate: Math.max(16000, Math.floor(bitrate))
            };
            const s = await AudioEncoder.isConfigSupported(config);
            if (!s.supported) return false;

            this.audioEncoder = new AudioEncoder({
                output: (chunk, meta) => {
                    this._encodedAudioChunks++;
                    if (this.muxer && !this._muxerFinalized) {
                        try { 
                            this.muxer.addAudioChunk(chunk, meta); 
                        } catch (e) {
                            console.error('[WebCodecs v13] muxer.addAudioChunk error:', e);
                        }
                    }
                },
                error: (e) => console.warn('[WebCodecs v13] AudioEncoder error:', e)
            });
            this.audioEncoder.configure(config);
            return true;
        } catch (e) {
            console.warn('[WebCodecs v13] 音频编码器初始化失败:', e);
            return false;
        }
    }

    updateProgress(percent, message) {
        if (this.onProgress) this.onProgress(percent, message);
    }

    cancel() {
        if (this.abortController) this.abortController.abort();
    }
}

window.WebCodecsExporter = WebCodecsExporter;
