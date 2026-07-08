class FrameBuffer {
    constructor(maxFrames = 60) {
        this.maxFrames = maxFrames;
        this.frames = new Map();
        this.frameList = [];
        this._totalSize = 0;
    }

    addFrame(frame, timestampUs) {
        if (this.frames.has(timestampUs)) {
            return;
        }

        const frameInfo = {
            frame: frame,
            timestampUs: timestampUs,
            size: this._estimateFrameSize(frame)
        };

        this.frames.set(timestampUs, frameInfo);
        this.frameList.push(frameInfo);
        this._totalSize += frameInfo.size;

        while (this.frameList.length > this.maxFrames) {
            const oldest = this.frameList.shift();
            this.frames.delete(oldest.timestampUs);
            this._totalSize -= oldest.size;
            try {
                oldest.frame.close();
            } catch (e) {}
        }
    }

    getFrame(timestampUs) {
        if (this.frames.has(timestampUs)) {
            return this.frames.get(timestampUs).frame;
        }
        
        let bestFrame = null;
        let bestDiff = Infinity;
        
        for (const [ts, info] of this.frames) {
            const diff = Math.abs(ts - timestampUs);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestFrame = info.frame;
            }
        }
        
        return bestFrame;
    }

    getFrameAtOrBefore(timestampUs) {
        let bestFrame = null;
        let bestTs = -Infinity;
        
        for (const [ts, info] of this.frames) {
            if (ts <= timestampUs && ts > bestTs) {
                bestTs = ts;
                bestFrame = info.frame;
            }
        }
        
        return bestFrame;
    }

    hasFrame(timestampUs) {
        return this.frames.has(timestampUs);
    }

    clear() {
        for (const info of this.frameList) {
            try {
                info.frame.close();
            } catch (e) {}
        }
        this.frames.clear();
        this.frameList = [];
        this._totalSize = 0;
    }

    get frameCount() {
        return this.frameList.length;
    }

    get totalSize() {
        return this._totalSize;
    }

    _estimateFrameSize(frame) {
        try {
            return frame.codedWidth * frame.codedHeight * 1.5;
        } catch (e) {
            return 1920 * 1080 * 1.5;
        }
    }

    destroy() {
        this.clear();
    }
}

window.FrameBuffer = FrameBuffer;
