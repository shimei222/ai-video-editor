class MP4DemuxerCache {
    constructor() {
        this._cache = new Map();
        this._promises = new Map();
        this._maxSize = 5;
    }

    async get(material) {
        const id = material.id;
        
        if (this._cache.has(id)) {
            return this._cache.get(id);
        }
        
        if (this._promises.has(id)) {
            return this._promises.get(id);
        }

        const promise = this._createDemuxer(material);
        this._promises.set(id, promise);

        try {
            const demuxer = await promise;
            this._cache.set(id, demuxer);
            this._promises.delete(id);
            this._cleanup();
            return demuxer;
        } catch (err) {
            this._promises.delete(id);
            throw err;
        }
    }

    async _createDemuxer(material) {
        const demuxer = new MP4Demuxer();
        let source = material._arrayBuffer;

        if (!source && material.file) {
            source = material.file;
        }

        if (!source) {
            throw new Error('No valid source available for: ' + material.name);
        }

        await demuxer.load(source);
        return demuxer;
    }

    release(materialId) {
        const demuxer = this._cache.get(materialId);
        if (demuxer) {
            demuxer.videoSamples = [];
            demuxer.audioSamples = [];
            demuxer.fileBuffer = null;
            this._cache.delete(materialId);
        }
        this._promises.delete(materialId);
    }

    _cleanup() {
        if (this._cache.size <= this._maxSize) return;
        
        const oldest = Array.from(this._cache.keys()).shift();
        this.release(oldest);
    }

    clear() {
        for (const id of this._cache.keys()) {
            this.release(id);
        }
        this._promises.clear();
    }
}

const mp4DemuxerCache = new MP4DemuxerCache();
