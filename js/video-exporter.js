/**
 * 视频导出器 - 统一导出入口
 * 优先级：FFmpeg（WebCodecs，速度快）> MediaRecorder（系统硬件编码，质量好） > WebCodecs
 * 
 * 说明：
 * - FFmpegExporter：使用 WebCodecs 软件编码，速度通常 > 1x（30fps 约 1.5x）
 * - MediaRecorderExporter：使用系统编码器，受限于实时速度（最多 1x），但质量可能更好
 */
class VideoExporter {
    constructor(editor) {
        this.editor = editor;
        this.isExporting = false;
        this.progress = 0;
        this.onProgress = null;
        this.onComplete = null;
        this.onError = null;
        this.abortController = null;

        this._exporter = null;
        this._exporterType = null;
        this._availableExporters = [];

        this._detectExporters();
    }

    _detectExporters() {
        const available = [];

        // FFmpeg（首选，WebCodecs 软件编码速度快）
        if (typeof FFmpegExporter !== 'undefined') {
            available.push({ type: 'ffmpeg', name: 'FFmpeg', cls: FFmpegExporter });
        }

        // MediaRecorder（备选，系统硬件编码质量好但速度 <= 1x）
        if (typeof MediaRecorderExporter !== 'undefined' && MediaRecorderExporter.isSupported()) {
            available.push({ type: 'mediarecorder', name: 'MediaRecorder', cls: MediaRecorderExporter });
        }

        // WebCodecs（备用）
        if (typeof WebCodecsExporter !== 'undefined' && WebCodecsExporter.isSupported()) {
            available.push({ type: 'webcodecs', name: 'WebCodecs', cls: WebCodecsExporter });
        }

        this._availableExporters = available;
        console.log(`[导出] 可用导出器: ${available.map(a => a.name).join(' > ')}`);

        if (available.length > 0) {
            const first = available[0];
            this._exporter = new first.cls(this.editor);
            this._exporterType = first.type;
            console.log(`[导出] 使用 ${first.name} 导出器`);
        } else {
            console.warn('[导出] 无可用导出方案');
        }
    }

    get exporterType() {
        return this._exporterType;
    }

    get availableExporters() {
        return this._availableExporters.map(e => ({ type: e.type, name: e.name }));
    }

    switchExporter(type) {
        const found = this._availableExporters.find(e => e.type === type);
        if (!found) {
            console.warn(`[导出] 不支持的导出器类型: ${type}`);
            return false;
        }
        if (this._exporterType === type) return true;

        this._exporter = new found.cls(this.editor);
        this._exporterType = type;
        console.log(`[导出] 切换到 ${found.name} 导出器`);
        return true;
    }

    async export(options = {}) {
        if (this.isExporting) return null;
        if (!this._exporter) throw new Error('无可用导出器');

        this.isExporting = true;

        this._exporter.onProgress = this.onProgress;
        this._exporter.onComplete = this.onComplete;
        this._exporter.onError = this.onError;

        try {
            const result = await this._exporter.export(options);
            this.isExporting = false;
            return result;
        } catch (error) {
            this.isExporting = false;
            if (this.onError) this.onError(error);
            throw error;
        }
    }

    cancel() {
        if (this._exporter) this._exporter.cancel();
    }

    parseBitrate(bitrate) {
        if (typeof bitrate === 'number') return bitrate;
        if (typeof bitrate === 'string') {
            const match = bitrate.match(/^(\d+)([MK]?)$/i);
            if (match) {
                const value = parseInt(match[1]);
                const unit = match[2].toUpperCase();
                return unit === 'M' ? value * 1000000 : unit === 'K' ? value * 1000 : value;
            }
        }
        return 5000000;
    }

    getSupportedMimeType(format) {
        const types = {
            'webm': 'video/webm;codecs=vp9,opus',
            'mp4': 'video/mp4'
        };
        return types[format] || types['mp4'];
    }
}

window.VideoExporter = VideoExporter;
