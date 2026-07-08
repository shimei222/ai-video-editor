class VideoDecoderPool {
    constructor(maxDecoders = 8) {
        this.maxDecoders = maxDecoders;
        this.decoders = new Map();
        this.lruList = [];
        this.pendingDecodes = new Map();
    }

    getDecoder(sourceId, config) {
        if (this.decoders.has(sourceId)) {
            const decoder = this.decoders.get(sourceId);
            this._touchLRU(sourceId);
            return decoder;
        }

        if (this.decoders.size >= this.maxDecoders) {
            this._evictOldest();
        }

        const decoder = this._createDecoder(sourceId, config);
        this.decoders.set(sourceId, decoder);
        this.lruList.push(sourceId);

        return decoder;
    }

    _createDecoder(sourceId, config) {
        const frameBuffer = new FrameBuffer(60);
        let decoder = null;
        let isReady = false;
        let pendingChunks = [];
        let outputCallback = null;
        let errorCallback = null;
        let lastFrameTs = -1;
        let decoderState = 'created';

        const init = {
            output: (frame) => {
                frameBuffer.addFrame(frame, frame.timestamp);
                lastFrameTs = frame.timestamp;
                decoderState = 'output';
                
                if (outputCallback) {
                    outputCallback(frame);
                }
            },
            error: (error) => {
                console.error('VideoDecoder error:', error);
                decoderState = 'error';
                if (errorCallback) {
                    errorCallback(error);
                }
            }
        };

        try {
            decoder = new VideoDecoder(init);
            decoder.configure(config);
            isReady = true;
            decoderState = 'configured';
        } catch (e) {
            console.error('Failed to create VideoDecoder:', e);
            isReady = false;
            decoderState = 'failed';
        }

        return {
            decoder,
            frameBuffer,
            config,
            isReady,
            pendingChunks,
            lastFrameTs,
            decoderState,
            isSeeking: false,
            targetTimestamp: -1,
            sourceId,
            
            getFrame(timestampUs) {
                return frameBuffer.getFrameAtOrBefore(timestampUs);
            },

            hasFrame(timestampUs) {
                return frameBuffer.getFrameAtOrBefore(timestampUs) !== null;
            },

            decodeChunk(chunk) {
                if (!decoder || !isReady) return false;
                if (decoderState === 'error' || decoderState === 'failed') return false;
                
                try {
                    decoder.decode(chunk);
                    decoderState = 'decoding';
                    pendingChunks.push(chunk);
                    return true;
                } catch (e) {
                    console.warn('Decode error:', e);
                    return false;
                }
            },

            async flush() {
                if (!decoder || !isReady) return;
                try {
                    decoderState = 'flushing';
                    await decoder.flush();
                    decoderState = 'flushed';
                    pendingChunks = [];
                } catch (e) {
                    console.warn('Flush error:', e);
                    decoderState = 'error';
                }
            },

            reset() {
                if (!decoder || !isReady) return;
                try {
                    decoder.reset();
                    frameBuffer.clear();
                    lastFrameTs = -1;
                    pendingChunks = [];
                    decoderState = 'reset';
                } catch (e) {
                    console.warn('Reset error:', e);
                }
            },

            setOutputCallback(cb) {
                outputCallback = cb;
            },

            setErrorCallback(cb) {
                errorCallback = cb;
            },

            get frameCount() {
                return frameBuffer.frameCount;
            },
            
            get pendingCount() {
                return pendingChunks.length;
            }
        };
    }

    _evictOldest() {
        if (this.lruList.length === 0) return;
        
        const oldestId = this.lruList.shift();
        const decoder = this.decoders.get(oldestId);
        
        if (decoder) {
            try {
                decoder.reset();
                if (decoder.decoder) {
                    decoder.decoder.close();
                }
            } catch (e) {}
            this.decoders.delete(oldestId);
        }
    }

    _touchLRU(id) {
        const index = this.lruList.indexOf(id);
        if (index > -1) {
            this.lruList.splice(index, 1);
            this.lruList.push(id);
        }
    }

    releaseDecoder(sourceId) {
        const decoder = this.decoders.get(sourceId);
        if (decoder) {
            try {
                decoder.reset();
                if (decoder.decoder) {
                    decoder.decoder.close();
                }
            } catch (e) {}
            this.decoders.delete(sourceId);
            const index = this.lruList.indexOf(sourceId);
            if (index > -1) {
                this.lruList.splice(index, 1);
            }
        }
    }

    clear() {
        for (const [id, decoder] of this.decoders) {
            try {
                decoder.reset();
                if (decoder.decoder) {
                    decoder.decoder.close();
                }
            } catch (e) {}
        }
        this.decoders.clear();
        this.lruList = [];
    }

    destroy() {
        this.clear();
    }
}

window.VideoDecoderPool = VideoDecoderPool;
