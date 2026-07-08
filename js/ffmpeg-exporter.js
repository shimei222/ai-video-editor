/**
 * 全功能剪辑软件导出引擎 v21 - 时间轴驱动架构
 * 
 * 支持功能：
 * - 时间轴驱动主循环（完美黑屏填充）
 * - 多轨道视频合成（按 trackIndex 层级叠加）
 * - 图片轨道支持
 * - 关键帧效果（scale, opacity, posX, posY, rotation）
 * - 多轨音频混合（AudioDecoder + AudioEncoder）
 * - 预解码缓冲区（滑动窗口，避免内存爆炸）
 */

const PIPELINE_VERSION = 'v35';

// ================================================================
// 内置 MP4 Muxer (轻量级，H.264 + AAC)
// ================================================================
class _MP4MuxerWriter {
    constructor(size = 4 * 1024 * 1024) {
        this.buf = new Uint8Array(size);
        this.view = new DataView(this.buf.buffer);
        this.pos = 0;
    }

    _grow(n) {
        if (this.pos + n > this.buf.length) {
            const ns = Math.max(this.buf.length * 2, this.pos + n);
            const nb = new Uint8Array(ns);
            nb.set(this.buf.subarray(0, this.pos));
            this.buf = nb;
            this.view = new DataView(nb.buffer);
        }
    }

    box(type, fn) {
        const start = this.pos;
        this.skip(8);
        fn();
        const end = this.pos;
        const size = end - start;
        const saved = this.pos;
        this.pos = start;
        this.u32(size);
        for (let i = 0; i < 4; i++) {
            this.view.setUint8(this.pos + i, type.charCodeAt(i));
        }
        this.pos = saved;
    }

    u8(v) { this._grow(1); this.view.setUint8(this.pos, v); this.pos++; }
    u16(v) { this._grow(2); this.view.setUint16(this.pos, v); this.pos += 2; }
    u24(v) {
        this.u8((v >> 16) & 0xff);
        this.u8((v >> 8) & 0xff);
        this.u8(v & 0xff);
    }
    u32(v) { this._grow(4); this.view.setUint32(this.pos, v >>> 0); this.pos += 4; }
    u64(v) { this.u32(Math.floor(v / 0x100000000)); this.u32(v >>> 0); }
    s16(v) { this._grow(2); this.view.setInt16(this.pos, v); this.pos += 2; }
    s32(v) { this._grow(4); this.view.setInt32(this.pos, v); this.pos += 4; }
    skip(n) { this._grow(n); this.pos += n; }
    seek(p) { this.pos = p; }
    bytes(b) { this._grow(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
    slice() { return this.buf.slice(0, this.pos); }
}

class _MP4Muxer {
    constructor(opts = {}) {
        this.width = opts.width || 1920;
        this.height = opts.height || 1080;
        this.fps = opts.fps || 30;
        this.sampleRate = opts.sampleRate || 48000;
        this.channels = opts.channels || 2;
        this.videoCodec = opts.videoCodec || 'h264'; // 'h264' 或 'hevc'
        this.videoChunks = [];
        this.audioChunks = [];
        this.videoMeta = null;
        this.audioMeta = null;
    }

    addVideoChunk(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.videoChunks.push({
            data,
            duration: chunk.duration,
            timestamp: chunk.timestamp,
            isKey: chunk.type === 'key'
        });
        if (meta && !this.videoMeta) this.videoMeta = meta;
    }

    addAudioChunk(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.audioChunks.push({
            data,
            duration: chunk.duration,
            timestamp: chunk.timestamp,
            isKey: true
        });
        if (meta && !this.audioMeta) this.audioMeta = meta;
    }

    finalize() {
        const v = this.videoChunks;
        const a = this.audioChunks;
        const vLen = v.length;
        const aLen = a.length;
        const b = new _MP4MuxerWriter();

        // ftyp
        b.box('ftyp', () => {
            if (this.videoCodec === 'hevc') {
                // HEVC: 主品牌 hvc1，兼容品牌 hvc1/iso5/mp41
                b.u32(0x68766331); // hvc1
                b.u32(0);
                b.u32(0x68766331); // hvc1
                b.u32(0x69736F35); // iso5
                b.u32(0x69736F6D); // isom
                b.u32(0x6D703431); // mp41
            } else {
                // H.264: 主品牌 isom，兼容品牌 isom/avc1/mp41
                b.u32(0x69736F35); // isom
                b.u32(0);
                b.u32(0x69736F35); // isom
                b.u32(0x69736F6D); // isom
                b.u32(0x61766331); // avc1
                b.u32(0x6D703431); // mp41
            }
        });

        // mdat
        const mdatStart = b.pos;
        b.skip(8);
        const vOffsets = new Array(vLen);
        for (let i = 0; i < vLen; i++) {
            vOffsets[i] = b.pos;
            b.bytes(v[i].data);
        }
        const aOffsets = new Array(aLen);
        for (let i = 0; i < aLen; i++) {
            aOffsets[i] = b.pos;
            b.bytes(a[i].data);
        }
        const mdatEnd = b.pos;
        const mdatSize = mdatEnd - mdatStart;
        b.seek(mdatStart);
        b.u32(mdatSize);
        b.u32(0x6D646174);
        b.seek(mdatEnd);

        // moov
        const movieDur = Math.max(
            vLen > 0 ? v[vLen - 1].timestamp + v[vLen - 1].duration : 0,
            aLen > 0 ? a[aLen - 1].timestamp + a[aLen - 1].duration : 0
        );
        const VIDEO_TS = 1000000;
        const MOVIE_TS = 1000;
        const movieDurScaled = Math.floor(movieDur / (VIDEO_TS / MOVIE_TS));

        b.box('moov', () => {
            b.box('mvhd', () => {
                b.u32(0);
                b.u32(0); b.u32(0);
                b.u32(MOVIE_TS);
                b.u32(movieDurScaled);
                b.u32(0x00010000);
                b.u16(0x0100);
                b.u16(0);
                b.u32(0); b.u32(0);
                b.u32(0x00010000); b.u32(0); b.u32(0);
                b.u32(0); b.u32(0x00010000); b.u32(0);
                b.u32(0); b.u32(0); b.u32(0x40000000);
                for (let i = 0; i < 6; i++) b.u32(0);
                b.u32(aLen > 0 ? 3 : 2);
            });

            if (vLen > 0) this._writeVideoTrack(b, v, vOffsets, VIDEO_TS, 1);
            if (aLen > 0) this._writeAudioTrack(b, a, aOffsets, VIDEO_TS, 2);
        });

        return b.slice();
    }

    _writeVideoTrack(b, chunks, offsets, ts, trackId) {
        const len = chunks.length;
        const dur = len > 0 ? chunks[len - 1].timestamp + chunks[len - 1].duration : 0;

        b.box('trak', () => {
            b.box('tkhd', () => {
                b.u32(0x0000000F);
                b.u32(0); b.u32(0);
                b.u32(trackId);
                b.u32(0);
                b.u32(dur);
                b.u32(0); b.u32(0);
                b.u16(0);
                b.u16(0);
                b.u16(0);
                b.u16(0);
                b.u32(0x00010000); b.u32(0); b.u32(0);
                b.u32(0); b.u32(0x00010000); b.u32(0);
                b.u32(0); b.u32(0); b.u32(0x40000000);
                b.u32(this.width << 16);
                b.u32(this.height << 16);
            });

            b.box('mdia', () => {
                b.box('mdhd', () => {
                    b.u32(0);
                    b.u32(0); b.u32(0);
                    b.u32(ts);
                    b.u32(dur);
                    b.u16(0x55C4);
                    b.u16(0);
                });

                b.box('hdlr', () => {
                    b.u32(0);
                    b.u32(0);
                    b.u32(0x76696465);
                    b.u32(0); b.u32(0); b.u32(0);
                    b.u8(0);
                });

                b.box('minf', () => {
                    b.box('vmhd', () => {
                        b.u32(0x00000001);
                        b.u16(0);
                        b.u16(0); b.u16(0); b.u16(0);
                    });

                    b.box('dinf', () => {
                        b.box('dref', () => {
                            b.u32(0);
                            b.u32(1);
                            b.box('url ', () => {
                                b.u32(0x00000001);
                            });
                        });
                    });

                    b.box('stbl', () => {
                        b.box('stsd', () => {
                            b.u32(0);
                            b.u32(1);
                            const entryType = this.videoCodec === 'hevc' ? 'hvc1' : 'avc1';
                            b.box(entryType, () => {
                                b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0);
                                b.u16(1);
                                b.u16(0);
                                b.u16(0);
                                b.u32(0); b.u32(0); b.u32(0);
                                b.u16(this.width);
                                b.u16(this.height);
                                b.u32(0x00480000);
                                b.u32(0x00480000);
                                b.u32(0);
                                b.u16(1);
                                for (let i = 0; i < 32; i++) b.u8(0);
                                b.u16(0x0018);
                                b.s16(-1);

                                const desc = this.videoMeta?.decoderConfig?.description;
                                if (desc) {
                                    const descBox = this.videoCodec === 'hevc' ? 'hvcC' : 'avcC';
                                    b.box(descBox, () => {
                                        b.bytes(new Uint8Array(desc));
                                    });
                                }
                            });
                        });

                        b.box('stts', () => {
                            b.u32(0);
                            const entries = this._sttsEntries(chunks);
                            b.u32(entries.length);
                            for (const e of entries) { b.u32(e.count); b.u32(e.delta); }
                        });

                        b.box('stsc', () => {
                            b.u32(0);
                            b.u32(1);
                            b.u32(1); b.u32(1); b.u32(1);
                        });

                        b.box('stsz', () => {
                            b.u32(0);
                            b.u32(0);
                            b.u32(len);
                            for (const c of chunks) b.u32(c.data.byteLength);
                        });

                        b.box('stco', () => {
                            b.u32(0);
                            b.u32(len);
                            for (const off of offsets) b.u32(off);
                        });

                        const keys = [];
                        for (let i = 0; i < len; i++) {
                            if (chunks[i].isKey) keys.push(i + 1);
                        }
                        if (keys.length > 0) {
                            b.box('stss', () => {
                                b.u32(0);
                                b.u32(keys.length);
                                for (const k of keys) b.u32(k);
                            });
                        }
                    });
                });
            });
        });
    }

    _writeAudioTrack(b, chunks, offsets, ts, trackId) {
        const len = chunks.length;
        const dur = len > 0 ? chunks[len - 1].timestamp + chunks[len - 1].duration : 0;

        b.box('trak', () => {
            b.box('tkhd', () => {
                b.u32(0x0000000F);
                b.u32(0); b.u32(0);
                b.u32(trackId);
                b.u32(0);
                b.u32(dur);
                b.u32(0); b.u32(0);
                b.u16(0);
                b.u16(0);
                b.u16(0x0100);
                b.u16(0);
                b.u32(0x00010000); b.u32(0); b.u32(0);
                b.u32(0); b.u32(0x00010000); b.u32(0);
                b.u32(0); b.u32(0); b.u32(0x40000000);
                b.u32(0); b.u32(0);
            });

            b.box('mdia', () => {
                b.box('mdhd', () => {
                    b.u32(0);
                    b.u32(0); b.u32(0);
                    b.u32(ts);
                    b.u32(dur);
                    b.u16(0x55C4);
                    b.u16(0);
                });

                b.box('hdlr', () => {
                    b.u32(0);
                    b.u32(0);
                    b.u32(0x736F756E);
                    b.u32(0); b.u32(0); b.u32(0);
                    b.u8(0);
                });

                b.box('minf', () => {
                    b.box('smhd', () => {
                        b.u32(0);
                        b.u16(0);
                        b.u16(0);
                    });

                    b.box('dinf', () => {
                        b.box('dref', () => {
                            b.u32(0);
                            b.u32(1);
                            b.box('url ', () => b.u32(1));
                        });
                    });

                    b.box('stbl', () => {
                        b.box('stsd', () => {
                            b.u32(0);
                            b.u32(1);
                            b.box('mp4a', () => {
                                b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0);
                                b.u16(1);
                                b.u16(0);
                                b.u16(0);
                                b.u32(0);
                                b.u16(this.channels);
                                b.u16(16);
                                b.u16(0);
                                b.u16(0);
                                b.u32(this.sampleRate << 16);

                                const aacDesc = this.audioMeta?.decoderConfig?.description;
                                b.box('esds', () => {
                                    b.u32(0);

                                    const aacSpecificData = aacDesc 
                                        ? new Uint8Array(aacDesc) 
                                        : new Uint8Array([0x11, 0x90]);
                                    const dsiSize = aacSpecificData.length;
                                    const decCfgSize = 13 + 2 + dsiSize;
                                    const esSize = 2 + 1 + (2 + decCfgSize) + 3;

                                    b.u8(0x03);
                                    b.u8(esSize);
                                    b.u16(trackId);
                                    b.u8(0);

                                    b.u8(0x04);
                                    b.u8(decCfgSize);
                                    b.u8(0x40);
                                    b.u8(0x14);
                                    b.u24(0);
                                    b.u32(0);
                                    b.u32(0);

                                    b.u8(0x05);
                                    b.u8(dsiSize);
                                    b.bytes(aacSpecificData);

                                    b.u8(0x06);
                                    b.u8(0x01);
                                    b.u8(0x02);
                                });
                            });
                        });

                        b.box('stts', () => {
                            b.u32(0);
                            const entries = this._sttsEntries(chunks);
                            b.u32(entries.length);
                            for (const e of entries) { b.u32(e.count); b.u32(e.delta); }
                        });

                        b.box('stsc', () => {
                            b.u32(0);
                            b.u32(1);
                            b.u32(1); b.u32(1); b.u32(1);
                        });

                        b.box('stsz', () => {
                            b.u32(0);
                            b.u32(0);
                            b.u32(len);
                            for (const c of chunks) b.u32(c.data.byteLength);
                        });

                        b.box('stco', () => {
                            b.u32(0);
                            b.u32(len);
                            for (const off of offsets) b.u32(off);
                        });
                    });
                });
            });
        });
    }

    _sttsEntries(chunks) {
        const r = [];
        if (chunks.length === 0) return r;
        let d = chunks[0].duration, c = 1;
        for (let i = 1; i < chunks.length; i++) {
            if (chunks[i].duration === d) c++;
            else { r.push({ count: c, delta: d }); d = chunks[i].duration; c = 1; }
        }
        r.push({ count: c, delta: d });
        return r;
    }
}

class FFmpegExporter {
    constructor(editor) {
        this.editor = editor;
        this.isExporting = false;
        this.abortController = null;
        this.onProgress = null;
        this.onComplete = null;
        this.onError = null;
        this.canvas = null;
        this.ctx = null;
        this.videoEncoder = null;
        this.muxer = null;
        this._muxerFinalized = false;
        
        // 每个片段的帧缓冲区 Map<clipId, {frames: VideoFrame[], clip, demuxer, decoder}>
        this._clipBuffers = new Map();
        
        // 图片素材缓存 Map<url, Image>
        this._imageCache = new Map();
        
        // 解码器状态
        this._decodingClips = new Map(); // clipId -> {feeding: boolean, done: boolean}
    }

    static async isSupported() {
        return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
    }

    updateProgress(percent, message) {
        if (this.onProgress) this.onProgress(percent, message);
    }

    async export(options = {}) {
        const {
            filename = 'video_export',
            width = 1920,
            height = 1080,
            fps = 30,
            videoBitrate = '8M',
            format = '',
        } = options;

        // MP3 格式：仅导出音频
        if (format === 'mp3') {
            return await this._exportMP3(options);
        }

        this.isExporting = true;
        this._muxerFinalized = false;
        this._clipBuffers = new Map();
        this._imageCache = new Map();
        this._decodingClips = new Map();
        this.abortController = new AbortController();

        const renderer = this.editor.videoRenderer || this.editor.videoEngine;
        const mainRenderer = this.editor.videoEngine || this.editor.videoRenderer;
        this.mainRenderer = mainRenderer;
        let totalDuration = this.editor.totalDuration;

        // 暂停主预览渲染
        let wasPlaying = false;
        if (mainRenderer) {
            wasPlaying = mainRenderer.isPlaying;
            if (mainRenderer.pause) mainRenderer.pause();
            if (mainRenderer.releaseWebGL) mainRenderer.releaseWebGL();
        }

        // 获取所有片段（视频 + 图片 + 音频轨道）
        const allClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex < 100 && c.material);

        // 获取音频轨道片段（trackIndex >= 100）
        const audioTrackClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex >= 100 && c.material && c.material.type === 'audio');

        const videoClips = allClips.filter(c => c.material.type === 'video');
        const imageClips = allClips.filter(c => c.material.type === 'image');
        const textClips = allClips.filter(c => c.material.type === 'text');

        if (allClips.length === 0 && audioTrackClips.length === 0) throw new Error('没有可导出的素材');

        if (!totalDuration || totalDuration <= 0) {
            const videoEnd = allClips.length > 0 ? Math.max(...allClips.map(c => c.startTime + c.duration)) : 0;
            const audioEnd = audioTrackClips.length > 0 ? Math.max(...audioTrackClips.map(c => c.startTime + c.duration)) : 0;
            totalDuration = Math.max(videoEnd, audioEnd);
        }

        const outW = Math.floor(width);
        const outH = Math.floor(height);
        const outFps = Math.max(1, Math.floor(fps));
        const totalFrames = Math.ceil(totalDuration * outFps);
        const frameDurationUs = Math.floor(1000000 / outFps);

        console.log(`[PIPELINE ${PIPELINE_VERSION}] 开始导出: ${outW}x${outH} @ ${outFps}fps, ${totalDuration.toFixed(2)}s, 视频:${videoClips.length}, 图片:${imageClips.length}, 音频轨道:${audioTrackClips.length}`);

        const startTime = performance.now();
        let resultBlob = null;

        try {
            // ================================================================
            // 第1步：创建 Canvas + 初始化编码器 + Muxer
            // ================================================================
            this.updateProgress(2, '创建 Canvas...');
            this.canvas = document.createElement('canvas');
            this.canvas.width = outW;
            this.canvas.height = outH;
            this.canvas.style.display = 'none';
            document.body.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

            this.updateProgress(3, '初始化编码器...');
            
            let videoBitrateNum;
            if (typeof videoBitrate === 'string') {
                const m = videoBitrate.match(/^(\d+(?:\.\d+)?)\s*[Mm]?$/);
                videoBitrateNum = m ? Math.round(parseFloat(m[1]) * 1000000) : 8000000;
            } else {
                videoBitrateNum = Math.floor(videoBitrate);
            }

            const muxerTarget = new WebMMuxer.ArrayBufferTarget();
            
            // 根据用户选择的格式决定编码和容器
            let usedCodec = '';
            let containerFormat = 'webm';
            let vcfg = null;

            if (format === 'mp4') {
                containerFormat = 'mp4';
                usedCodec = 'h264';
                vcfg = {
                    codec: 'avc1.4d0028',
                    width: outW,
                    height: outH,
                    bitrate: videoBitrateNum,
                    framerate: outFps,
                    hardwareAcceleration: 'prefer-hardware'
                };

                // 尝试多种配置以兼容不同浏览器/硬件的编码能力
                const tryConfigs = async () => {
                    for (const f of [outFps, Math.min(outFps, 30), Math.min(outFps, 24)]) {
                        const cfg = { ...vcfg, framerate: f };
                        const sup = await VideoEncoder.isConfigSupported(cfg);
                        if (sup.supported) return sup.config || cfg;
                    }
                    const { framerate, ...cfgNoFps } = vcfg;
                    const sup = await VideoEncoder.isConfigSupported(cfgNoFps);
                    if (sup.supported) return sup.config || cfgNoFps;
                    return null;
                };
                const supportedCfg = await tryConfigs();
                if (supportedCfg) {
                    const hasHW = supportedCfg.hardwareAcceleration === 'required' ||
                                  supportedCfg.hardwareAcceleration === 'preferred';
                    console.log(`[PIPELINE] H.264 支持: ${hasHW ? '硬件加速' : '软件编码'}, MP4 输出 (fps:${supportedCfg.framerate || outFps})`);
                    vcfg = supportedCfg;
                    usedCodec = vcfg.codec || 'avc1.4d0028';
                } else {
                    // H.264 完全不可用时，回退到 WebM + VP9
                    console.warn('[PIPELINE] H.264 编码不支持，回退到 WebM VP9');
                    containerFormat = 'webm';
                    usedCodec = 'vp9';
                    vcfg = {
                        codec: 'vp09.00.10.08',
                        width: outW,
                        height: outH,
                        bitrate: videoBitrateNum,
                        framerate: outFps
                    };
                }
            } else {
                // WebM 格式：优先 VP9，降级 VP8
                containerFormat = 'webm';
                usedCodec = 'vp9';
                vcfg = {
                    codec: 'vp09.00.10.08',
                    width: outW,
                    height: outH,
                    bitrate: videoBitrateNum,
                    framerate: outFps,
                    hardwareAcceleration: 'prefer-hardware'
                };

                const vp9Support = await VideoEncoder.isConfigSupported(vcfg);
                if (vp9Support.supported) {
                    const hasHW = vp9Support.config?.hardwareAcceleration === 'required' ||
                                  vp9Support.config?.hardwareAcceleration === 'preferred';
                    console.log(`[PIPELINE] VP9 支持: ${hasHW ? '硬件加速' : '软件编码'}, WebM 输出`);
                    vcfg = vp9Support.config || vcfg;
                } else {
                    console.log('[PIPELINE] VP9 不支持，尝试 VP8...');
                    usedCodec = 'vp8';
                    vcfg = { codec: 'vp8', width: outW, height: outH, bitrate: videoBitrateNum, framerate: outFps };

                    const vp8Support = await VideoEncoder.isConfigSupported(vcfg);
                    if (!vp8Support.supported) {
                        throw new Error('浏览器不支持 VP9/VP8 视频编码，无法导出 WebM');
                    }
                    vcfg = vp8Support.config || vcfg;
                    console.log('[PIPELINE] VP8 支持: 软件编码, WebM 输出');
                }
            }
            
            this._containerFormat = containerFormat;
            this._usedCodec = usedCodec;
            this._muxerFinalized = false;
            
            if (containerFormat === 'mp4') {
                this.muxer = new _MP4Muxer({
                    width: outW,
                    height: outH,
                    fps: outFps,
                    sampleRate: 48000,
                    channels: 2
                });
                console.log('[PIPELINE] MP4 封装模式，使用 MP4Muxer');
            } else {
                let muxerVideoCodec = usedCodec === 'vp9' ? 'V_VP9' : 'V_VP8';
                this.muxer = new WebMMuxer.Muxer({
                    target: muxerTarget,
                    video: { codec: muxerVideoCodec, width: outW, height: outH, frameRate: outFps },
                    audio: { codec: 'A_OPUS', sampleRate: 48000, numberOfChannels: 2 },
                    firstTimestampBehavior: 'permissive'
                });
            }

            this.videoEncoder = new VideoEncoder({
                output: (chunk, meta) => {
                    // 确保第一个关键帧的 meta 被保存（包含 avcC/VP9 配置）
                    if (meta && chunk.type === 'key' && !this._firstVideoMeta) {
                        this._firstVideoMeta = meta;
                        console.log('[PIPELINE] 首个关键帧 meta:', {
                            hasDescription: !!meta.decoderConfig?.description,
                            descriptionSize: meta.decoderConfig?.description?.byteLength || 0
                        });
                    }
                    this._onVideoChunk(chunk, meta);
                },
                error: (e) => console.error('[ENCODER] error:', e)
            });
            this.videoEncoder.configure(vcfg);
            console.log(`[PIPELINE] 视频编码器就绪: ${usedCodec}`);

            // ================================================================
            // 第2步：加载图片素材
            // ================================================================
            this.updateProgress(4, '加载图片...');
            for (const clip of imageClips) {
                const url = clip.material.url;
                if (this._imageCache.has(url)) continue;
                
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.src = url;
                
                await new Promise((resolve) => {
                    if (img.complete) { resolve(); return; }
                    img.onload = resolve;
                    img.onerror = () => { console.warn('[PIPELINE] 图片加载失败:', url); resolve(); };
                    setTimeout(resolve, 3000);
                });
                
                this._imageCache.set(url, img);
                console.log(`[PIPELINE] 图片加载完成: ${clip.material.name}, ${img.width}x${img.height}`);
            }

            // ================================================================
            // 第3步：处理音频（多轨混合：视频自带音频 + 独立音频轨道）
            // ================================================================
            this.updateProgress(5, '处理音频...');
            await this._processAudio(videoClips, audioTrackClips, totalDuration);

            // ================================================================
            // 第4步：初始化视频解码器（并行）
            // ================================================================
            this.updateProgress(13, '初始化解码器...');
            const clipDecoders = await this._initDecoders(videoClips, renderer);

            // ================================================================
            // 第4.5步：为所有视频准备 video 元素回退（解码慢时兜底，避免开头黑屏）
            // ================================================================
            const fallbackVideos = new Map(); // clip.id -> video element
            if (videoClips.length > 0) {
                console.log(`[PIPELINE] 准备 ${videoClips.length} 个视频回退元素`);
                for (const clip of videoClips) {
                    if (fallbackVideos.has(clip.id)) continue;
                    const video = document.createElement('video');
                    video.crossOrigin = 'anonymous';
                    video.muted = true;
                    video.preload = 'auto';
                    video.playsInline = true;
                    video.src = clip.material.url;

                    await new Promise((resolve) => {
                        const onReady = () => {
                            video.removeEventListener('loadedmetadata', onReady);
                            video.removeEventListener('error', onError);
                            resolve();
                        };
                        const onError = () => {
                            console.warn('[PIPELINE] 回退视频加载失败:', clip.material.name);
                            video.removeEventListener('loadedmetadata', onReady);
                            video.removeEventListener('error', onError);
                            resolve();
                        };
                        video.addEventListener('loadedmetadata', onReady);
                        video.addEventListener('error', onError);
                        setTimeout(resolve, 5000);
                    });

                    if (video.readyState >= 1) {
                        // 预先 seek 到 clip 的 offset 位置，确保开头就能取到正确的帧
                        const offsetSec = clip.offset || 0;
                        if (offsetSec > 0) {
                            await new Promise((resolve) => {
                                const onSeeked = () => {
                                    video.removeEventListener('seeked', onSeeked);
                                    resolve();
                                };
                                const onErr = () => {
                                    video.removeEventListener('seeked', onSeeked);
                                    resolve();
                                };
                                video.addEventListener('seeked', onSeeked, { once: true });
                                video.addEventListener('error', onErr, { once: true });
                                try { video.currentTime = offsetSec; } catch (_) { resolve(); }
                                setTimeout(resolve, 3000);
                            });
                        }
                        fallbackVideos.set(clip.id, video);
                        console.log(`[PIPELINE] 回退视频就绪: ${clip.material.name}, offset=${offsetSec.toFixed(1)}s, ${video.videoWidth}x${video.videoHeight}`);
                    }
                }
            }

            // ================================================================
            // 第5步：启动解码器喂料循环（后台并行运行）
            // ================================================================
            this.updateProgress(15, '启动解码...');

            const feedPromises = [];
            for (const cd of clipDecoders) {
                this._decodingClips.set(cd.clip.id, { feeding: true, done: false });
                feedPromises.push(this._feedDecoderLoop(cd));
            }

            // ================================================================
            // 第6步：【时间轴驱动主循环】
            // ================================================================
            // 第5.5步：同步预热 WebCodecs 缓冲区 与 fallbackVideo 元素
            // ================================================================
            if (videoClips.length > 0) {
                this.updateProgress(17, '预热解码与画面同步中...');
                console.log(`[PIPELINE] 正在同步预热硬解码与回退视频画面...`);

                // 1. 先让所有 fallbackVideo 提前起跑，Seek 到它们的起始时间点
                for (const clip of videoClips) {
                    const fallbackVid = fallbackVideos.get(clip.id);
                    if (fallbackVid) {
                        // 计算这个片段在主时间轴第 0 帧时，对应的视频内部时间点
                        // 如果片段有播放偏移（比如从27秒开始），这里就是 27.0
                        const startClipInternalTime = Math.max(0, (clip.offset || 0));
                        console.log(`[PIPELINE] 命令 fallbackVideo 提前寻道至: ${startClipInternalTime}s`);
                        fallbackVid.isSeekReady = false;
                        fallbackVid.onseeked = () => {
                            fallbackVid.isSeekReady = true;
                            console.log(`[PIPELINE] fallbackVideo 寻道完毕，当前画面时间: ${fallbackVid.currentTime}s`);
                        };
                        try { fallbackVid.currentTime = startClipInternalTime; } catch (_) {}
                    }
                }

                // 2. 启动硬解码缓冲区和 HTMLVideoElement 双重死等机制
                let preheatWaited = 0;
                while (preheatWaited < 5000) {
                    if (this.abortController.signal.aborted) throw new Error('导出已取消');

                    let allReady = true;
                    for (const clip of videoClips) {
                        // A. 检查 WebCodecs 缓冲
                        const buf = this._clipBuffers.get(clip.id);
                        const decState = this._decodingClips.get(clip.id);
                        if (decState && !decState.done) {
                            const currentFrameCount = buf ? buf.frames.length : 0;
                            if (currentFrameCount < 5) {
                                allReady = false;
                                break;
                            }
                        }

                        // B. 核心新增：同步检查 fallbackVideo 是否 seek 完毕
                        const fallbackVid = fallbackVideos.get(clip.id);
                        if (fallbackVid && !fallbackVid.isSeekReady) {
                            allReady = false;
                            break; // 只要 fallbackVideo 还没准备好画面，主循环必须死等
                        }
                    }

                    if (allReady) break;

                    await new Promise(r => setTimeout(r, 50));
                    preheatWaited += 50;
                }

                for (const clip of videoClips) {
                    const buf = this._clipBuffers.get(clip.id);
                    console.log(`[PIPELINE] 预热检查 - 片段 ${clip.material.name} 最终获得缓冲帧数: ${buf ? buf.frames.length : 0}`);
                }
                console.log(`[PIPELINE] 双重预热全面结束，耗时 ${preheatWaited}ms，主循环放行！`);
            }

            // ================================================================
            // 终极加固：首帧物理级别锁定与安全挂载机制
            // ================================================================
            // 提前初始化 _lastDecodedFrame，避免首帧锁定时调用 set 报错
            this._lastDecodedFrame = new Map();

            if (videoClips.length > 0) {
                console.log(`[PIPELINE] 正在对首帧进行深度硬解锁定检查...`);

                for (const clip of videoClips) {
                    // 只有当时间轴 0s 在该视频片段生命周期内时才需要检查
                    if (clip.startTime <= 0 && 0 < clip.startTime + clip.duration) {
                        // 计算该 clip 在时间轴 0s 时对应的内部剪辑时间
                        const startTimeInClip = 0 - clip.startTime + (clip.offset || 0);

                        let firstFrame = this._getBestFrame(clip.id, startTimeInClip);
                        let checkCount = 0;
                        const maxChecks = 100;

                        while (!firstFrame && checkCount < maxChecks) {
                            await new Promise(r => setTimeout(r, 2));
                            firstFrame = this._getBestFrame(clip.id, startTimeInClip);
                            checkCount++;
                        }

                        if (firstFrame) {
                            console.log(`[PIPELINE] 成功锁定首帧纹理: ${clip.material.name}, 耗时: ${checkCount * 2}ms`);
                            // 精准锁定时也 clone 一份，避免被 _cleanupOldFrames 清理时连带销毁
                            try { firstFrame = firstFrame.clone(); } catch (_) {}
                            this._lastDecodedFrame.set(clip.id, firstFrame);
                        } else {
                            console.warn(`[PIPELINE] 首帧硬解超时，启动紧急安全机制...`);

                            const buf = this._clipBuffers.get(clip.id);
                            if (buf && buf.frames && buf.frames.length > 0) {
                                // 核心修正：选 timestamp 最接近 startTimeInClip 的帧，而不是 frames[0]
                                // 避免关键帧位于 offset 之前时，应急帧与目标时间偏差过大
                                const targetUs = Math.floor(startTimeInClip * 1000000);
                                let bestFrame = buf.frames[0];
                                let bestDiff = Math.abs(bestFrame.timestamp - targetUs);
                                for (let i = 1; i < buf.frames.length; i++) {
                                    const diff = Math.abs(buf.frames[i].timestamp - targetUs);
                                    if (diff < bestDiff) {
                                        bestDiff = diff;
                                        bestFrame = buf.frames[i];
                                    }
                                }
                                // clone 一份，避免被 _cleanupOldFrames 清理时连带销毁兜底帧
                                let emergencyFrame = null;
                                try { emergencyFrame = bestFrame.clone(); }
                                catch (_) { emergencyFrame = bestFrame; }
                                console.log(`[PIPELINE] 成功从缓冲区捞出物理第一帧进行应急挂载！选用时间: ${(bestFrame.timestamp / 1000000).toFixed(3)}s, 目标: ${startTimeInClip.toFixed(3)}s`);
                                this._lastDecodedFrame.set(clip.id, emergencyFrame);
                            }
                        }
                    }
                }
            }

            console.log(`[PIPELINE] 主循环开跑，硬解帧同步驱动已就绪...`);

            // 纯解码器渲染，精确时间轴，不使用 fallback video
            console.log(`[PIPELINE] 开始时间轴渲染: ${totalFrames} 帧`);
            this.updateProgress(18, '渲染中...');

            // 主循环
            for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
                if (this.abortController.signal.aborted) throw new Error('导出已取消');

                const frameTime = frameIndex / outFps;
                const targetTimeUs = frameIndex * frameDurationUs;

                // 1. 刷黑画布（完美黑屏填充）
                this.ctx.fillStyle = '#000000';
                this.ctx.fillRect(0, 0, outW, outH);

                // 2. 按 trackIndex 降序排序（大 trackIndex 先画在底层，小 trackIndex 后画覆盖在上层）
                const sortedClips = [...allClips].sort((a, b) => b.trackIndex - a.trackIndex);

                // 3. 遍历所有片段，渲染活跃的
                for (const clip of sortedClips) {
                    // 判断该片段在当前时间是否活跃
                    if (frameTime < clip.startTime || frameTime >= clip.startTime + clip.duration) {
                        continue;
                    }

                    // 计算片段内部时间
                    const clipInternalTime = frameTime - clip.startTime + (clip.offset || 0);

                    if (clip.material.type === 'video') {
                        let frame = this._getBestFrame(clip.id, clipInternalTime);

                        if (!frame) {
                            let waitRetry = 0;
                            while (!frame && waitRetry < 50) {
                                await new Promise(r => setTimeout(r, 2));
                                frame = this._getBestFrame(clip.id, clipInternalTime);
                                waitRetry++;
                            }
                        }

                        if (frame) {
                            // 更新缓存前先关闭旧的 clone 帧，避免内存泄漏
                            const oldFrame = this._lastDecodedFrame.get(clip.id);
                            if (oldFrame) {
                                try { oldFrame.close(); } catch (_) {}
                            }
                            // clone 一份存入缓存，避免被 _cleanupOldFrames 清理时连带销毁
                            let cachedFrame = null;
                            try { cachedFrame = frame.clone(); }
                            catch (_) { cachedFrame = frame; }
                            this._lastDecodedFrame.set(clip.id, cachedFrame);
                            this._drawVideoFrame(this.ctx, frame, clip, outW, outH, frameTime);
                        } else {
                            const lastFrame = this._lastDecodedFrame.get(clip.id);
                            if (lastFrame) {
                                this._drawVideoFrame(this.ctx, lastFrame, clip, outW, outH, frameTime);
                                console.log(`[PIPELINE] 提示：帧 ${frameIndex} 临时使用前一硬解帧兜底`);
                            } else {
                                this.ctx.fillStyle = '#000000';
                                this.ctx.fillRect(0, 0, outW, outH);
                            }
                        }
                    } else if (clip.material.type === 'image') {
                        // 图片片段：直接绘制
                        const img = this._imageCache.get(clip.material.url);
                        if (img && img.complete) {
                            this._drawImage(this.ctx, img, clip, outW, outH, frameTime);
                        }
                    } else if (clip.material.type === 'text') {
                        // 文本片段：绘制预渲染的文本 canvas
                        if (!window.textManager) window.textManager = new TextManager();
                        const cached = window.textManager.getOrCreateTextImage(clip.material);
                        if (cached && cached.image) {
                            this._drawText(this.ctx, cached.image, cached.width, cached.height, clip, outW, outH, frameTime);
                        }
                    }
                }

                // 4. 编码这一帧
                const vf = new VideoFrame(this.canvas, { timestamp: targetTimeUs, duration: frameDurationUs });
                while (this.videoEncoder.encodeQueueSize > 16) {
                    await new Promise(r => setTimeout(r, 1));
                }
                this.videoEncoder.encode(vf, { keyFrame: frameIndex % outFps === 0 });
                vf.close();

                // 5. 清理过期帧
                for (const clip of videoClips) {
                    let currentClipInternalTime = 0;
                    if (frameTime < clip.startTime) {
                        currentClipInternalTime = Math.max(0, (frameTime - clip.startTime) + (clip.offset || 0));
                    } else if (frameTime >= clip.startTime && frameTime < clip.startTime + clip.duration) {
                        currentClipInternalTime = frameTime - clip.startTime + (clip.offset || 0);
                    } else {
                        currentClipInternalTime = clip.duration + (clip.offset || 0);
                    }
                    this._cleanupOldFrames(clip.id, currentClipInternalTime);
                }

                // 6. 更新进度
                if (frameIndex % 30 === 0 || frameIndex === totalFrames - 1) {
                    const elapsed = (performance.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? (frameTime / elapsed).toFixed(1) : '0';
                    const pct = 18 + Math.floor((frameIndex / totalFrames) * 74);
                    this.updateProgress(pct, `渲染 ${frameIndex}/${totalFrames} 帧 (${frameTime.toFixed(1)}s) ${speed}x`);

                    // 打印缓冲区状态
                    const bufStats = clipDecoders.map(cd => {
                        const buf = this._clipBuffers.get(cd.clip.id);
                        return `${cd.clip.material.name}:${buf?.frames.length || 0}`;
                    }).join(', ');
                    console.log(`[PIPELINE] 帧 ${frameIndex}/${totalFrames}, 缓冲: ${bufStats}`);
                }
            }

            // ================================================================
            // 第7步：编码器收尾 + 输出文件
            // ================================================================
            console.log('[PIPELINE] 主循环完成，直接进入编码收尾阶段...');
            
            // 异步终止所有解码器（不需要等它们结束）
            for (const cd of clipDecoders) {
                try { cd.decoder.close(); } catch (_) {}
            }

            // 暂停所有 fallback video
            if (typeof fallbackVideos !== 'undefined') {
                for (const video of fallbackVideos.values()) {
                    try { video.pause(); } catch (_) {}
                }
            }
            
            this.updateProgress(92, '刷新视频编码器...');
            await this.videoEncoder.flush();
            
            this.updateProgress(98, '生成文件...');
            this._muxerFinalized = true;
            
            let blob;
            const ext = this._containerFormat === 'mp4' ? 'mp4' : 'webm';
            const mimeType = this._containerFormat === 'mp4' ? 'video/mp4' : 'video/webm';
            
            if (this._containerFormat === 'mp4') {
                const mp4Data = this.muxer.finalize();
                if (!mp4Data || mp4Data.length === 0) throw new Error('MP4 封装失败');
                blob = new Blob([mp4Data], { type: mimeType });
            } else {
                this.muxer.finalize();
                blob = new Blob([muxerTarget.buffer], { type: mimeType });
            }
            
            const totalTime = (performance.now() - startTime) / 1000;
            const speed = totalDuration / totalTime;
            console.log(`[PIPELINE] 完成: ${totalTime.toFixed(1)}s, ${speed.toFixed(2)}x, ${(blob.size / 1024 / 1024).toFixed(2)}MB, ${ext.toUpperCase()} 格式`);

            if (blob.size === 0) throw new Error('导出文件为 0 字节');

            this.updateProgress(100, '导出完成！');

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

        } catch (error) {
            console.error(`[PIPELINE ${PIPELINE_VERSION}] 导出失败:`, error);
            throw error;
        } finally {
            // 恢复主预览渲染
            if (mainRenderer) {
                if (mainRenderer.restoreWebGL) mainRenderer.restoreWebGL();
                if (wasPlaying && mainRenderer.play) mainRenderer.play();
                if (mainRenderer.seek) mainRenderer.seek(mainRenderer.currentTime || 0);
            }

            // 清理所有帧
            for (const [id, buf] of this._clipBuffers) {
                for (const f of buf.frames) { try { f.close(); } catch (_) {} }
            }
            this._clipBuffers.clear();
            this._imageCache.clear();

            // 清理回退视频元素
            if (typeof fallbackVideos !== 'undefined') {
                for (const video of fallbackVideos.values()) {
                    try {
                        video.pause();
                        video.src = '';
                        video.load();
                    } catch (_) {}
                }
                fallbackVideos.clear();
            }

            // 清理 Canvas
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
                this.canvas = null;
                this.ctx = null;
            }

            // 清理编码器
            if (this.videoEncoder) {
                try { this.videoEncoder.close(); } catch (_) {}
                this.videoEncoder = null;
            }

            // 清理已显示时间戳追踪（兼容旧代码）
            if (this._lastShownTs) {
                this._lastShownTs.clear();
            }
            if (this._lastDecodedFrame) {
                // 关闭所有缓存的 VideoFrame，避免内存泄漏
                for (const [, frame] of this._lastDecodedFrame) {
                    try { frame.close(); } catch (_) {}
                }
                this._lastDecodedFrame.clear();
            }
            if (this._switchedToDecoder) {
                this._switchedToDecoder.clear();
            }

            this.isExporting = false;
        }

        return resultBlob;
    }

    // ================================================================
    // 音频处理：流式分段解码 + 混合 + 编码（内存安全，支持超长视频）
    // ================================================================
    async _processAudio(videoClips, audioTrackClips, totalDuration) {
        try {
            if (typeof AudioEncoder === 'undefined') {
                console.warn('[PIPELINE] AudioEncoder 不支持，跳过音频');
                return;
            }

            const isMP4 = this._containerFormat === 'mp4';
            const audioCodec = isMP4 ? 'mp4a.40.2' : 'opus';
            const codecName = isMP4 ? 'AAC' : 'Opus';

            const audioSup = await AudioEncoder.isConfigSupported({
                codec: audioCodec,
                sampleRate: 48000,
                numberOfChannels: 2
            });
            if (!audioSup.supported) {
                console.warn(`[PIPELINE] ${codecName} 编码不支持，跳过音频`);
                return;
            }

            // 合并所有音频片段：视频自带音频 + 独立音频轨道
            const allAudioClips = [...videoClips, ...audioTrackClips];
            if (allAudioClips.length === 0) {
                console.log('[PIPELINE] 没有音频片段，跳过音频处理');
                return;
            }

            console.log(`[PIPELINE] 开始流式音频处理（分段解码 + ${codecName} 编码）, 视频:${videoClips.length}, 音频轨道:${audioTrackClips.length}, 总时长:${totalDuration.toFixed(1)}s`);

            const TARGET_SAMPLE_RATE = 48000;
            const FRAME_SIZE = isMP4 ? 1024 : 960;

            // 创建 AudioEncoder
            const audioEncoder = new AudioEncoder({
                output: (chunk, meta) => { this._onAudioChunk(chunk, meta); },
                error: (e) => console.warn('[PIPELINE] AudioEncoder 错误:', e)
            });
            audioEncoder.configure({ codec: audioCodec, sampleRate: TARGET_SAMPLE_RATE, numberOfChannels: 2 });

            // 预加载大文件的 demuxer（只加载一次）
            const demuxerCache = new Map();
            for (const clip of allAudioClips) {
                const fileSizeMB = (clip.material.size || 0) / 1024 / 1024;
                if (fileSizeMB > 100 && typeof mp4DemuxerCache !== 'undefined') {
                    try {
                        const demuxer = await mp4DemuxerCache.get(clip.material);
                        if (demuxer && demuxer.audioTrack && demuxer.audioSamples.length > 0) {
                            demuxerCache.set(clip.id, demuxer);
                        }
                    } catch (e) {
                        console.warn(`[PIPELINE] 预加载 demuxer 失败: ${clip.material.name}:`, e.message);
                    }
                }
            }

            // 分段处理：每段 SEGMENT_SEC 秒，内存使用恒定
            const SEGMENT_SEC = 30;
            const totalSegments = Math.ceil(totalDuration / SEGMENT_SEC);
            let encodedFrames = 0;
            const encodeStart = performance.now();

            console.log(`[PIPELINE] 分段数: ${totalSegments}, 每段 ${SEGMENT_SEC}s`);

            for (let segIdx = 0; segIdx < totalSegments; segIdx++) {
                if (this.abortController?.signal?.aborted) break;

                const segStart = segIdx * SEGMENT_SEC;
                const segEnd = Math.min(segStart + SEGMENT_SEC, totalDuration);
                const segSamples = Math.ceil((segEnd - segStart) * TARGET_SAMPLE_RATE);

                // 创建小段 mixBuffer（仅本段的内存）
                const segLeft = new Float32Array(segSamples);
                const segRight = new Float32Array(segSamples);

                // 对每个 clip，解码并混合到本段
                for (const clip of allAudioClips) {
                    // 判断 clip 是否与本段有时间重叠
                    const clipStart = clip.startTime;
                    const clipEnd = clip.startTime + clip.duration;
                    if (clipEnd <= segStart || clipStart >= segEnd) continue;

                    // 计算在本段内的范围
                    const overlapStart = Math.max(clipStart, segStart);
                    const overlapEnd = Math.min(clipEnd, segEnd);
                    const overlapDur = overlapEnd - overlapStart;
                    if (overlapDur <= 0) continue;

                    // clip 内部偏移 = (overlapStart - clipStart) + clip.offset
                    const clipInternalStart = (overlapStart - clipStart) + (clip.offset || 0);
                    const volume = (clip.effects?.volume || 100) / 100;

                    try {
                        let leftData, rightData, audioSampleRate;
                        const demuxer = demuxerCache.get(clip.id);

                        if (demuxer) {
                            // 大文件：用 MP4Demuxer 只解码本段
                            const pcm = await demuxer.decodeAudioToPCM(clipInternalStart, overlapDur);
                            leftData = pcm.left;
                            rightData = pcm.right;
                            audioSampleRate = pcm.sampleRate;
                        } else {
                            // 小文件：fetch + decodeAudioData（一次性，小文件不会崩）
                            if (!clip._audioBuffer) {
                                const response = await fetch(clip.material.url);
                                const arrayBuffer = await response.arrayBuffer();
                                const audioCtx = new AudioContext();
                                clip._audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
                                audioCtx.close();
                            }
                            const buf = clip._audioBuffer;
                            const startIdx = Math.floor(clipInternalStart * buf.sampleRate);
                            const endIdx = Math.min(buf.length, Math.floor((clipInternalStart + overlapDur) * buf.sampleRate));
                            const len = endIdx - startIdx;
                            leftData = buf.getChannelData(0).subarray(startIdx, endIdx);
                            rightData = buf.numberOfChannels > 1 ? buf.getChannelData(1).subarray(startIdx, endIdx) : leftData;
                            audioSampleRate = buf.sampleRate;
                        }

                        // 重采样到 48000Hz（如果需要）
                        let finalLeft = leftData;
                        let finalRight = rightData;
                        if (audioSampleRate !== TARGET_SAMPLE_RATE) {
                            const ratio = TARGET_SAMPLE_RATE / audioSampleRate;
                            const newLen = Math.floor(leftData.length * ratio);
                            finalLeft = new Float32Array(newLen);
                            finalRight = new Float32Array(newLen);
                            for (let i = 0; i < newLen; i++) {
                                const src = i / ratio;
                                const s0 = Math.floor(src);
                                const s1 = Math.min(s0 + 1, leftData.length - 1);
                                const frac = src - s0;
                                finalLeft[i] = leftData[s0] + (leftData[s1] - leftData[s0]) * frac;
                                finalRight[i] = rightData[s0] + (rightData[s1] - rightData[s0]) * frac;
                            }
                        }

                        // 混合到 segLeft/segRight
                        const mixOffset = Math.floor((overlapStart - segStart) * TARGET_SAMPLE_RATE);
                        const copyLen = Math.min(finalLeft.length, segSamples - mixOffset);
                        for (let i = 0; i < copyLen; i++) {
                            segLeft[mixOffset + i] += finalLeft[i] * volume;
                            segRight[mixOffset + i] += finalRight[i] * volume;
                        }
                    } catch (clipErr) {
                        console.warn(`[PIPELINE] 分段音频解码失败: ${clip.material.name} @${segStart.toFixed(0)}s:`, clipErr.message);
                    }
                }

                // 编码本段
                for (let offset = 0; offset < segSamples; offset += FRAME_SIZE) {
                    if (this.abortController?.signal?.aborted) break;

                    const frameLen = Math.min(FRAME_SIZE, segSamples - offset);
                    if (frameLen <= 0) break;

                    const interleaved = new Float32Array(frameLen * 2);
                    for (let i = 0; i < frameLen; i++) {
                        interleaved[i * 2] = segLeft[offset + i];
                        interleaved[i * 2 + 1] = segRight[offset + i];
                    }

                    const audioData = new AudioData({
                        format: 'f32',
                        sampleRate: TARGET_SAMPLE_RATE,
                        numberOfFrames: frameLen,
                        numberOfChannels: 2,
                        timestamp: Math.floor(((segStart * TARGET_SAMPLE_RATE + offset) / TARGET_SAMPLE_RATE) * 1000000),
                        data: interleaved,
                        transfer: [interleaved.buffer]
                    });

                    while (audioEncoder.encodeQueueSize > 30) {
                        await new Promise(r => setTimeout(r, 2));
                    }

                    try {
                        audioEncoder.encode(audioData);
                        encodedFrames++;
                    } catch (e) {}
                    audioData.close();
                }

                // 更新进度
                const pct = 5 + Math.floor((segIdx / totalSegments) * 8);
                this.updateProgress(pct, `音频 ${segIdx + 1}/${totalSegments} 段 (${segStart.toFixed(0)}s)`);

                // segLeft/segRight 在下一轮循环被覆盖，内存自动释放
            }

            // 清理缓存的 audioBuffer
            for (const clip of allAudioClips) {
                if (clip._audioBuffer) delete clip._audioBuffer;
            }

            await audioEncoder.flush();
            audioEncoder.close();

            const encodeElapsed = (performance.now() - encodeStart) / 1000;
            console.log(`[PIPELINE] 音频编码完成: ${encodedFrames} 帧, 耗时 ${encodeElapsed.toFixed(1)}s, ${totalDuration / encodeElapsed}x 实时`);

        } catch (globalAudioErr) {
            console.error('[PIPELINE] 音频处理失败，切换到无音轨模式:', globalAudioErr.message);
        }
    }

    // ================================================================
    // 初始化视频解码器
    // ================================================================
    async _initDecoders(videoClips, renderer) {
        const clipDecoders = [];

        for (const clip of videoClips) {
            // 尝试从 renderer 获取 demuxer，如果没有则主动加载
            let demuxerData = renderer.demuxers?.get(clip.material.url);
            if (!demuxerData?.demuxer) {
                console.log(`[PIPELINE] demuxer 未加载，尝试主动加载: ${clip.material.name}`);
                if (renderer.loadMaterial) {
                    try {
                        await renderer.loadMaterial(clip.material);
                        demuxerData = renderer.demuxers?.get(clip.material.url);
                    } catch (e) {
                        console.warn(`[PIPELINE] 主动加载 demuxer 失败: ${clip.material.name}`, e.message);
                    }
                }
            }
            if (!demuxerData?.demuxer) {
                console.warn(`[PIPELINE] 无 demuxer: ${clip.material.name}，将使用 video 元素回退`);
                continue;
            }
            const demuxer = demuxerData.demuxer;

            const videoConfig = demuxer.getVideoConfig();
            if (!videoConfig) {
                console.warn(`[PIPELINE] 无视频配置: ${clip.material.name}`);
                continue;
            }

            // 初始化帧缓冲区
            this._clipBuffers.set(clip.id, { frames: [], clip, demuxer });

            // 创建解码器
            const decoder = new VideoDecoder({
                output: (frame) => {
                    const buf = this._clipBuffers.get(clip.id);
                    if (buf) {
                        buf.frames.push(frame);
                        buf.frames.sort((a, b) => a.timestamp - b.timestamp);
                    } else {
                        frame.close();
                    }
                },
                error: (e) => console.error(`[PIPELINE] 解码错误 ${clip.material.name}:`, e)
            });

            // 配置解码器
            let fixedConfig = { ...videoConfig };
            if (videoConfig.description) {
                if (videoConfig.description instanceof ArrayBuffer) {
                    fixedConfig.description = videoConfig.description.slice(0);
                } else if (ArrayBuffer.isView(videoConfig.description)) {
                    fixedConfig.description = videoConfig.description.buffer.slice(
                        videoConfig.description.byteOffset,
                        videoConfig.description.byteOffset + videoConfig.description.byteLength
                    );
                } else {
                    delete fixedConfig.description;
                }
            }

            try {
                const sup = await VideoDecoder.isConfigSupported(fixedConfig);
                if (!sup.supported) {
                    const noDesc = { ...fixedConfig };
                    delete noDesc.description;
                    if (!(await VideoDecoder.isConfigSupported(noDesc)).supported) {
                        throw new Error('配置不支持');
                    }
                    decoder.configure(noDesc);
                } else {
                    decoder.configure(fixedConfig);
                }
                console.log(`[PIPELINE] 解码器就绪: ${clip.material.name}, ${fixedConfig.codec}`);
            } catch (e) {
                console.warn(`[PIPELINE] 解码器配置失败: ${clip.material.name}`, e.message);
                decoder.close();
                continue;
            }

            clipDecoders.push({ clip, demuxer, decoder });
        }

        return clipDecoders;
    }

    // ================================================================
    // 解码器喂料循环（后台运行）
    // ================================================================
    async _feedDecoderLoop(cd) {
        const { clip, demuxer, decoder } = cd;
        const samples = demuxer.videoSamples;
        const clipId = clip.id;

        // 从 clip.offset 对应的关键帧开始喂料，避免无谓解码前面不需要的帧
        const offsetSec = clip.offset || 0;
        let startIdx = 0;
        if (offsetSec > 0 && typeof demuxer.findKeyframeIndexBefore === 'function') {
            const offsetUs = Math.floor(offsetSec * 1000000);
            const kfIdx = demuxer.findKeyframeIndexBefore(offsetUs);
            if (kfIdx > 0) startIdx = kfIdx;
        }
        console.log(`[PIPELINE] 开始喂料: ${clip.material.name}, ${samples.length} 样本, 起始索引: ${startIdx} (offset: ${offsetSec.toFixed(1)}s)`);

        try {
            for (let j = startIdx; j < samples.length; j++) {
                if (this.abortController?.signal?.aborted) break;
                if (decoder.state !== 'configured') break; // 解码器已关闭

                // 双背压控制：解码队列 < 8 且 缓冲帧数 < 20
                const buf = this._clipBuffers.get(clipId);
                while (decoder.decodeQueueSize > 16 || (buf?.frames.length || 0) > 30) {
                    await new Promise(r => setTimeout(r, 5));
                    if (this.abortController?.signal?.aborted) break;
                    if (decoder.state !== 'configured') break;
                }
                if (this.abortController?.signal?.aborted) break;
                if (decoder.state !== 'configured') break;

                const chunk = await demuxer.getVideoChunk(j);
                if (chunk) {
                    if (decoder.state !== 'configured') break;
                    try {
                        decoder.decode(chunk);
                    } catch (decodeErr) {
                        if (decoder.state !== 'configured') break;
                        throw decodeErr;
                    }
                }

                // 每 500 帧释放已消费样本的 data，防止大文件 OOM
                // 保留 500 帧余量（解码队列 + 缓冲帧最大约 50），足够安全
                if (j > 0 && j % 500 === 0 && typeof demuxer.releaseVideoSamplesBefore === 'function') {
                    demuxer.releaseVideoSamplesBefore(j - 100);
                }

                if (j % 200 === 0 || j === samples.length - 1) {
                    const curBuf = this._clipBuffers.get(clipId);
                    console.log(`[PIPELINE] 喂料 ${clip.material.name}: ${j}/${samples.length}, 队列${decoder.decodeQueueSize}, 缓冲${curBuf?.frames.length || 0}`);
                    // 每 200 帧让出一次事件循环，让解码输出回调有机会执行
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (!this.abortController?.signal?.aborted && decoder.state === 'configured') {
                console.log(`[PIPELINE] 喂料完成: ${clip.material.name}, flush...`);
                await decoder.flush();
            }
        } catch (e) {
            if (decoder.state !== 'configured') {
                console.log(`[PIPELINE] 喂料停止: ${clip.material.name} (解码器已关闭，属正常行为)`);
            } else {
                console.error(`[PIPELINE] 喂料异常 [${clip.material.name}]:`, e);
            }
        } finally {
            try { decoder.close(); } catch (_) {}
            
            const state = this._decodingClips.get(clipId);
            if (state) {
                state.feeding = false;
                state.done = true;
            }

            const buf = this._clipBuffers.get(clipId);
            console.log(`[PIPELINE] 解码完成: ${clip.material.name}, 最终缓冲${buf?.frames.length || 0} 帧`);
        }
    }

    // ================================================================
    // 从缓冲区取最佳帧
    // ================================================================
    _getBestFrame(clipId, clipInternalTime) {
        const buf = this._clipBuffers.get(clipId);
        if (!buf || buf.frames.length === 0) return null;

        const targetUs = Math.floor(clipInternalTime * 1000000);

        // 二分查找：找 timestamp <= targetUs 的最后一帧（不超前）
        // 这是视频播放的标准做法，避免 B 帧导致画面顺序错乱（先跳后倒退）
        let lo = 0, hi = buf.frames.length - 1;
        let best = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const ts = buf.frames[mid].timestamp;

            if (ts <= targetUs) {
                best = mid;  // 记录最后一个 <= targetUs 的位置
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        // 没有任何帧 <= targetUs（所有帧都超前）
        // 这种情况发生在开头：解码器先输出了 cts 较大的 P 帧，B 帧还没出来
        if (best === -1) {
            // 核心修正：如果是视频开头的极早期（比如前 200ms 内），
            // 且缓冲区其实有帧，直接借用第一帧作为开头画面，防止 B 帧或首帧延迟导致黑屏卡顿
            if (targetUs < 200000 && buf.frames.length > 0) {
                return buf.frames[0];
            }
            return null;
        }

        // 如果最佳帧比目标时间落后太多（>500ms），返回 null
        // 确保解码帧时间足够接近目标，不使用过早的关键帧画面
        if (buf.frames[best].timestamp < targetUs - 500000) {
            return null;
        }

        return buf.frames[best];
    }

    // ================================================================
    // 清理过期帧（释放内存）
    // ================================================================
    _cleanupOldFrames(clipId, currentClipTime) {
        const buf = this._clipBuffers.get(clipId);
        if (!buf) return;

        const currentUs = Math.floor(currentClipTime * 1000000);
        const keepBefore = currentUs - 500000; // 保留 500ms 内的帧

        while (buf.frames.length > 0 && buf.frames[0].timestamp < keepBefore) {
            const old = buf.frames.shift();
            try { old.close(); } catch (_) {}
        }
    }

    // ================================================================
    // 渲染视频帧（带效果+关键帧插值）
    // ================================================================
    _getExportEffects(clip, time) {
        if (!this.mainRenderer) return clip.effects || {};
        const mainRenderer = this.mainRenderer;
        const savedTime = mainRenderer.currentTime;
        mainRenderer.currentTime = time;
        const result = mainRenderer._getInterpolatedEffects ?
            mainRenderer._getInterpolatedEffects(clip) :
            (clip.effects || {});
        mainRenderer.currentTime = savedTime;
        return result;
    }

    _getExportScale(canvasW, canvasH) {
        const baseW = this.mainRenderer?.canvasW || canvasW;
        const baseH = this.mainRenderer?.canvasH || canvasH;
        if (baseW > 0 && baseH > 0) {
            return { x: canvasW / baseW, y: canvasH / baseH };
        }
        return { x: 1, y: 1 };
    }

    _drawVideoFrame(ctx, frame, clip, canvasW, canvasH, time) {
        const effects = time !== undefined ? this._getExportEffects(clip, time) : (clip.effects || {});
        const exportScale = this._getExportScale(canvasW, canvasH);
        const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
        const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = (effects.posX || 0) * exportScale.x;
        const posY = (effects.posY || 0) * exportScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const frameW = frame.displayWidth || frame.codedWidth || canvasW;
        const frameH = frame.displayHeight || frame.codedHeight || canvasH;

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

    _drawVideoElement(ctx, video, clip, canvasW, canvasH, time) {
        const effects = time !== undefined ? this._getExportEffects(clip, time) : (clip.effects || {});
        const exportScale = this._getExportScale(canvasW, canvasH);
        const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
        const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = (effects.posX || 0) * exportScale.x;
        const posY = (effects.posY || 0) * exportScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const frameW = video.videoWidth || canvasW;
        const frameH = video.videoHeight || canvasH;

        const fitScale = Math.min(canvasW / frameW, canvasH / frameH);
        const drawW = frameW * fitScale * scaleX;
        const drawH = frameH * fitScale * scaleY;
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    }

    // ================================================================
    // 渲染图片（带效果+关键帧插值）
    // ================================================================
    _drawImage(ctx, img, clip, canvasW, canvasH, time) {
        const effects = time !== undefined ? this._getExportEffects(clip, time) : (clip.effects || {});
        const exportScale = this._getExportScale(canvasW, canvasH);
        const scaleX = ((effects.scaleX !== undefined ? effects.scaleX : effects.scale) || 100) / 100;
        const scaleY = ((effects.scaleY !== undefined ? effects.scaleY : effects.scale) || 100) / 100;
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = (effects.posX || 0) * exportScale.x;
        const posY = (effects.posY || 0) * exportScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const imgW = img.naturalWidth || img.width || canvasW;
        const imgH = img.naturalHeight || img.height || canvasH;

        const fitScale = Math.min(canvasW / imgW, canvasH / imgH);
        const drawW = imgW * fitScale * scaleX;
        const drawH = imgH * fitScale * scaleY;
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    }

    _drawText(ctx, textCanvas, textW, textH, clip, canvasW, canvasH, time) {
        const effects = time !== undefined ? this._getExportEffects(clip, time) : (clip.effects || {});
        const exportScale = this._getExportScale(canvasW, canvasH);
        const opacity = (effects.opacity !== undefined ? effects.opacity : 100) / 100;
        const posX = (effects.posX || 0) * exportScale.x;
        const posY = (effects.posY || 0) * exportScale.y;
        const rotation = (effects.rotation || 0) * Math.PI / 180;

        const uniformScale = ((effects.scale !== undefined ? effects.scale : Math.min(effects.scaleX || 100, effects.scaleY || 100)) || 100) / 100;
        const fitScale = Math.min(canvasW / textW, canvasH / textH);
        const drawW = textW * fitScale * uniformScale;
        const drawH = textH * fitScale * uniformScale;
        const x = (canvasW - drawW) / 2 + posX;
        const y = (canvasH - drawH) / 2 + posY;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(x + drawW / 2, y + drawH / 2);
        ctx.rotate(rotation);
        ctx.drawImage(textCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
    }

    // ================================================================
    // MP4 封装：视频 chunk 回调
    // ================================================================
    _onVideoChunk(chunk, meta) {
        if (this._muxerFinalized) return;

        if (this.muxer) {
            try {
                // 对于 MP4，确保第一个关键帧的 meta 被传递（包含 avcC）
                if (meta && chunk.type === 'key' && !this.muxer.videoMeta) {
                    this.muxer.videoMeta = meta;
                }
                this.muxer.addVideoChunk(chunk, meta);
            } catch (e) {
                console.warn('[PIPELINE] 视频 chunk 写入失败:', e);
            }
        }
    }

    // ================================================================
    // MP4 封装：音频 chunk 回调
    // ================================================================
    _onAudioChunk(chunk, meta) {
        if (this._muxerFinalized) return;
        
        if (this.muxer) {
            try { 
                this.muxer.addAudioChunk(chunk, meta);
            } catch (e) {
                console.warn('[PIPELINE] 音频 chunk 写入失败:', e);
            }
        }
    }

    // ================================================================
    // MP3 导出：仅音频，使用 lamejs 编码
    // ================================================================
    async _exportMP3(options = {}) {
        const { filename = 'video_export', audioBitrate = 192 } = options;

        if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
            throw new Error('MP3 编码库 (lamejs) 未加载');
        }

        this.isExporting = true;
        this.abortController = new AbortController();

        const renderer = this.editor.videoRenderer || this.editor.videoEngine;
        const mainRenderer = this.editor.videoEngine || this.editor.videoRenderer;
        let totalDuration = this.editor.totalDuration;

        // 暂停主预览渲染
        let wasPlaying = false;
        if (mainRenderer) {
            wasPlaying = mainRenderer.isPlaying;
            if (mainRenderer.pause) mainRenderer.pause();
        }

        const allClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex < 100 && c.material);

        // 获取音频轨道片段（trackIndex >= 100）
        const audioTrackClips = (this.editor.timelineClips || renderer.timelineClips || [])
            .filter(c => c.trackIndex >= 100 && c.material && c.material.type === 'audio');

        const videoClips = allClips.filter(c => c.material.type === 'video');

        // 合并所有音频片段
        const allAudioClips = [...videoClips, ...audioTrackClips];

        if (allAudioClips.length === 0) throw new Error('没有可导出的音频素材');

        if (!totalDuration || totalDuration <= 0) {
            const videoEnd = allClips.length > 0 ? Math.max(...allClips.map(c => c.startTime + c.duration)) : 0;
            const audioEnd = audioTrackClips.length > 0 ? Math.max(...audioTrackClips.map(c => c.startTime + c.duration)) : 0;
            totalDuration = Math.max(videoEnd, audioEnd);
        }

        console.log(`[PIPELINE] MP3 导出: ${totalDuration.toFixed(2)}s, 视频:${videoClips.length} 个, 音频轨道:${audioTrackClips.length} 个`);

        const startTime = performance.now();
        let resultBlob = null;

        try {
            this.updateProgress(2, '创建音频上下文...');

            const MP3_BITRATE = Math.max(32, Math.min(320, audioBitrate)); // kbps，限制 32-320
            const TARGET_SAMPLE_RATE = 44100; // MP3 标准采样率
            const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

            // 混合缓冲区
            const totalSamples = Math.ceil(totalDuration * TARGET_SAMPLE_RATE);
            const mixLeft = new Float32Array(totalSamples);
            const mixRight = new Float32Array(totalSamples);

            this.updateProgress(5, '解码音频...');

            for (let ci = 0; ci < allAudioClips.length; ci++) {
                const clip = allAudioClips[ci];
                try {
                    this.updateProgress(5 + Math.floor((ci / allAudioClips.length) * 30), `解码音频: ${clip.material.name}...`);

                    const response = await fetch(clip.material.url);
                    const arrayBuffer = await response.arrayBuffer();
                    const originalBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));

                    // 重采样到目标采样率
                    let resampledBuffer = originalBuffer;
                    if (originalBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                        const offlineCtx = new OfflineAudioContext(
                            2,
                            Math.ceil(originalBuffer.duration * TARGET_SAMPLE_RATE),
                            TARGET_SAMPLE_RATE
                        );
                        const source = offlineCtx.createBufferSource();
                        source.buffer = originalBuffer;
                        source.connect(offlineCtx.destination);
                        source.start(0);
                        resampledBuffer = await offlineCtx.startRendering();
                    }

                    // 切片并混合
                    const offset = clip.offset || 0;
                    const duration = clip.duration;
                    const startSample = Math.floor(offset * TARGET_SAMPLE_RATE);
                    const endSample = Math.min(
                        resampledBuffer.length,
                        Math.floor((offset + duration) * TARGET_SAMPLE_RATE)
                    );
                    const clipSamples = endSample - startSample;
                    const clipStartInTimeline = Math.floor(clip.startTime * TARGET_SAMPLE_RATE);

                    const leftData = resampledBuffer.getChannelData(0);
                    const rightData = resampledBuffer.numberOfChannels > 1
                        ? resampledBuffer.getChannelData(1) : leftData;

                    const volume = (clip.effects?.volume || 100) / 100;

                    for (let i = 0; i < clipSamples; i++) {
                        const timelineIdx = clipStartInTimeline + i;
                        if (timelineIdx >= totalSamples) break;
                        mixLeft[timelineIdx] += leftData[startSample + i] * volume;
                        mixRight[timelineIdx] += rightData[startSample + i] * volume;
                    }

                    console.log(`[PIPELINE] MP3 混合: ${clip.material.name}, ${clipSamples} 样本`);
                } catch (clipErr) {
                    console.warn(`[PIPELINE] MP3 音频解码失败: ${clip.material.name}:`, clipErr.message);
                }
            }

            audioCtx.close();

            this.updateProgress(40, '编码 MP3...');

            // 用 lamejs 编码
            const encoder = new lamejs.Mp3Encoder(2, TARGET_SAMPLE_RATE, MP3_BITRATE);
            const SAMPLES_PER_BLOCK = 1152; // MP3 帧大小
            const mp3Data = [];

            let encodedBlocks = 0;
            const totalBlocks = Math.ceil(totalSamples / SAMPLES_PER_BLOCK);

            for (let i = 0; i < totalSamples; i += SAMPLES_PER_BLOCK) {
                if (this.abortController?.signal?.aborted) break;

                const blockLen = Math.min(SAMPLES_PER_BLOCK, totalSamples - i);
                const leftBlock = new Int16Array(blockLen);
                const rightBlock = new Int16Array(blockLen);

                for (let j = 0; j < blockLen; j++) {
                    // 限幅 + 转为 16-bit PCM
                    const l = Math.max(-1, Math.min(1, mixLeft[i + j]));
                    const r = Math.max(-1, Math.min(1, mixRight[i + j]));
                    leftBlock[j] = l < 0 ? l * 0x8000 : l * 0x7FFF;
                    rightBlock[j] = r < 0 ? r * 0x8000 : r * 0x7FFF;
                }

                const mp3buf = encoder.encodeBuffer(leftBlock, rightBlock);
                if (mp3buf.length > 0) {
                    mp3Data.push(mp3buf);
                }

                encodedBlocks++;
                if (encodedBlocks % 50 === 0 || encodedBlocks === totalBlocks) {
                    const pct = 40 + Math.floor((encodedBlocks / totalBlocks) * 55);
                    const elapsed = (performance.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? (totalDuration / elapsed).toFixed(1) : '0';
                    this.updateProgress(pct, `编码 MP3 ${encodedBlocks}/${totalBlocks} 帧 ${speed}x`);
                }

                // 定期让出主线程
                if (encodedBlocks % 100 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            const flushBuf = encoder.flush();
            if (flushBuf.length > 0) {
                mp3Data.push(flushBuf);
            }

            this.updateProgress(97, '生成文件...');

            const blob = new Blob(mp3Data, { type: 'audio/mp3' });
            if (blob.size === 0) throw new Error('MP3 导出为 0 字节');

            const totalTime = (performance.now() - startTime) / 1000;
            console.log(`[PIPELINE] MP3 完成: ${totalTime.toFixed(1)}s, ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

            this.updateProgress(100, 'MP3 导出完成！');

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.mp3`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (this.onComplete) this.onComplete(blob);
            resultBlob = blob;

        } catch (error) {
            console.error(`[PIPELINE] MP3 导出失败:`, error);
            throw error;
        } finally {
            // 恢复主预览渲染
            if (mainRenderer) {
                if (wasPlaying && mainRenderer.play) mainRenderer.play();
                if (mainRenderer.seek) mainRenderer.seek(mainRenderer.currentTime || 0);
            }
            this.isExporting = false;
        }

        return resultBlob;
    }

    cancel() {
        if (this.abortController) this.abortController.abort();
    }
}

window.FFmpegExporter = FFmpegExporter;