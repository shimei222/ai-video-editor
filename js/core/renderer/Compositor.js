class Compositor {
    constructor(renderer) {
        this.renderer = renderer;
        this.tracks = [];
    }

    addTrack(track) {
        this.tracks.push(track);
        this._sortTracks();
    }

    removeTrack(trackId) {
        this.tracks = this.tracks.filter(t => t.id !== trackId);
    }

    _sortTracks() {
        this.tracks.sort((a, b) => a.index - b.index);
    }

    render(timeSeconds, clips, canvasWidth, canvasHeight) {
        const activeClips = clips.filter(clip => {
            return timeSeconds >= clip.startTime && 
                   timeSeconds < clip.startTime + clip.duration &&
                   clip.trackIndex < 100;
        }).sort((a, b) => a.trackIndex - b.trackIndex);

        this.renderer.beginFrame();

        for (const clip of activeClips) {
            this._renderClip(clip, timeSeconds, canvasWidth, canvasHeight);
        }

        this.renderer.endFrame();
    }

    _renderClip(clip, timeSeconds, canvasWidth, canvasHeight) {
        const effects = clip.effects || {};
        const clipTime = timeSeconds - clip.startTime;
        
        const frame = this._getClipFrame(clip, clipTime);
        if (!frame) {
            // 如果没有解码出帧，使用占位黑帧
            console.warn('[Compositor] No frame available for:', clip?.material?.name);
            return;
        }

        let x = 0, y = 0, width = canvasWidth, height = canvasHeight;
        
        const posX = effects.posX || 0;
        const posY = effects.posY || 0;
        const scale = (effects.scale || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const rotation = (effects.rotation || 0) * Math.PI / 180;
        const brightness = effects.brightness || 0;
        const contrast = (effects.contrast || 0) + 100;
        const saturation = (effects.saturation || 0) + 100;

        const frameWidth = frame.codedWidth || frame.width || 1920;
        const frameHeight = frame.codedHeight || frame.height || 1080;
        
        const scaleToFit = Math.min(canvasWidth / frameWidth, canvasHeight / frameHeight);
        const drawW = frameWidth * scaleToFit * scale;
        const drawH = frameHeight * scaleToFit * scale;
        
        x = (canvasWidth - drawW) / 2 + posX;
        y = (canvasHeight - drawH) / 2 + posY;

        try {
            this.renderer.drawVideoFrame(frame, {
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
            console.warn('Failed to render frame:', e);
        }
    }

    _getClipFrame(clip, clipTime) {
        if (!clip._decoder) {
            console.warn('[Compositor] No decoder for clip:', clip?.material?.name);
            return null;
        }
        
        const timeUs = clipTime * 1000000;
        const offsetUs = (clip.offset || 0) * 1000000;
        const mediaTimeUs = offsetUs + timeUs;
        
        // 首先检查是否有已解码的帧
        let frame = clip._decoder.getFrame(mediaTimeUs);
        
        if (frame) {
            console.log('[Compositor] Frame found:', clip?.material?.name, 
                'timestamp:', frame.timestamp,
                'codedWidth:', frame.codedWidth,
                'codedHeight:', frame.codedHeight);
            return frame;
        }
        
        // 如果没有帧但有 pending 的解码，尝试 flush
        if (clip._decoder.pendingCount > 0) {
            console.log('[Compositor] Pending frames, triggering flush for:', clip?.material?.name);
            clip._decoder.flush();
            frame = clip._decoder.getFrame(mediaTimeUs);
            if (frame) return frame;
        }
        
        // 检查 frame count
        console.log('[Compositor] No frame found for clip:', clip?.material?.name, 
            'clipTime:', clipTime.toFixed(2),
            'mediaTimeUs:', mediaTimeUs,
            'decoded frames:', clip._decoder.frameCount,
            'pending:', clip._decoder.pendingCount,
            'decoderState:', clip._decoder.decoderState);
        
        return null;
    }

    destroy() {
        this.tracks = [];
    }
}

window.Compositor = Compositor;
