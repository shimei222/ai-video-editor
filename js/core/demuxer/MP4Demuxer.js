const BOX_HEADER_SIZE = 8;
const FULL_BOX_HEADER_SIZE = 12;

function _extractBoxBody(box) {
    if (!box) return null;
    if (box instanceof ArrayBuffer) return box;
    if (ArrayBuffer.isView(box)) {
        return box.buffer.slice(box.byteOffset, box.byteOffset + box.byteLength);
    }
    if (box.data instanceof ArrayBuffer) return box.data;
    if (ArrayBuffer.isView(box.data)) {
        return box.data.buffer.slice(box.data.byteOffset, box.data.byteOffset + box.data.byteLength);
    }
    const buffers = [];
    const collect = (b) => {
        if (b && b.data) {
            if (b.data instanceof ArrayBuffer) buffers.push(b.data);
            else if (ArrayBuffer.isView(b.data)) {
                buffers.push(b.data.buffer.slice(b.data.byteOffset, b.data.byteOffset + b.data.byteLength));
            }
        }
        if (b && b.boxes) b.boxes.forEach(collect);
    };
    collect(box);
    if (buffers.length === 0) return null;
    const total = buffers.reduce((s, b) => s + b.byteLength, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) { result.set(new Uint8Array(b), off); off += b.byteLength; }
    return result.buffer;
}

function _findBoxInBuffer(buffer, fourCC) {
    const target = new TextEncoder().encode(fourCC);
    const target0 = target[0], target1 = target[1], target2 = target[2], target3 = target[3];
    const view = new DataView(buffer);
    const len = buffer.byteLength;
    const bytes = new Uint8Array(buffer);
    
    // 暴力搜索：在整个文件中查找 fourCC，然后验证是否是合法的 box
    for (let i = 0; i < len - 8; i++) {
        if (bytes[i + 4] === target0 && bytes[i + 5] === target1 && 
            bytes[i + 6] === target2 && bytes[i + 7] === target3) {
            // 找到匹配，向前找 box size
            let pos = i;
            if (pos < 0 || pos + 8 > len) continue;
            const size = view.getUint32(pos);
            let boxSize = size;
            let headerSize = 8;
            if (size === 1 && pos + 16 <= len) {
                boxSize = Number(view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            if (boxSize < headerSize || pos + boxSize > len) continue;
            const bodySize = boxSize - headerSize;
            if (bodySize <= 0) continue;
            return buffer.slice(pos + headerSize, pos + headerSize + bodySize);
        }
    }
    return null;
}

class MP4Demuxer {
    constructor() {
        this.file = null;
        this.fileBuffer = null;
        this.view = null;
        this.offset = 0;
        
        this.videoTrack = null;
        this.audioTrack = null;
        this.videoSamples = [];
        this.audioSamples = [];
        
        this._onVideoConfig = null;
        this._onAudioConfig = null;
        this._onVideoChunk = null;
        this._onAudioChunk = null;
    }

    async load(fileOrBuffer) {
        this.videoTrack = null;
        this.audioTrack = null;
        this.videoSamples = [];
        this.audioSamples = [];

        if (fileOrBuffer instanceof File) {
            this.file = fileOrBuffer;
            this.fileBuffer = null;
            console.log('[MP4Demuxer] 开始切片解析大文件:', this.file.name,
                'size:', (this.file.size / 1024 / 1024).toFixed(1) + 'MB');
            await this._parseWithMP4BoxChunked(this.file);

            console.log('[MP4Demuxer] 切片解析完成:',
                'videoTrack:', !!this.videoTrack,
                'audioTrack:', !!this.audioTrack,
                'videoSamples:', this.videoSamples.length,
                'audioSamples:', this.audioSamples.length);

            return {
                videoTrack: this.videoTrack,
                audioTrack: this.audioTrack,
                videoSampleCount: this.videoSamples.length,
                audioSampleCount: this.audioSamples.length
            };
        }

        if (fileOrBuffer instanceof ArrayBuffer) {
            this.file = null;
            this.fileBuffer = fileOrBuffer;
        } else {
            this.file = fileOrBuffer;
            this.fileBuffer = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('File read failed'));
                reader.readAsArrayBuffer(fileOrBuffer);
            });
        }
        this.view = new DataView(this.fileBuffer);
        this.offset = 0;

        if (this.file) {
            console.log('[MP4Demuxer] Loading file:', this.file.name, 'size:', (this.file.size / 1024 / 1024).toFixed(2), 'MB');
        } else {
            console.log('[MP4Demuxer] Loading from ArrayBuffer, size:', (this.fileBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');
        }

        this._parseBoxes(0, this.fileBuffer.byteLength);
        this._buildSampleTables();

        console.log('[MP4Demuxer] Parse from start complete:',
            'videoTrack:', !!this.videoTrack,
            'videoSamples:', this.videoSamples.length);

        if (!this.videoTrack || this.videoSamples.length === 0) {
            console.log('[MP4Demuxer] Video track not found from start, trying _parseMoovFromEnd...');

            this.videoTrack = null;
            this.audioTrack = null;
            this.videoSamples = [];
            this.audioSamples = [];

            this._parseMoovFromEnd();
            this._buildSampleTables();

            console.log('[MP4Demuxer] Parse from end complete:',
                'videoTrack:', !!this.videoTrack,
                'videoSamples:', this.videoSamples.length);
        }

        if (!this.videoTrack || this.videoSamples.length === 0) {
            console.log('[MP4Demuxer] Video track still not found, trying MP4Box fallback...');

            this.videoTrack = null;
            this.audioTrack = null;
            this.videoSamples = [];
            this.audioSamples = [];

            await this._parseWithMP4Box();

            console.log('[MP4Demuxer] MP4Box parse complete:',
                'videoTrack:', !!this.videoTrack,
                'videoSamples:', this.videoSamples.length);
        }

        console.log('[MP4Demuxer] Load complete:',
            'videoTrack:', !!this.videoTrack,
            'audioTrack:', !!this.audioTrack,
            'videoSamples:', this.videoSamples.length,
            'audioSamples:', this.audioSamples.length);

        return {
            videoTrack: this.videoTrack,
            audioTrack: this.audioTrack,
            videoSampleCount: this.videoSamples.length,
            audioSampleCount: this.audioSamples.length
        };
    }
    
    _parseMoovFromEnd() {
        const fileSize = this.fileBuffer.byteLength;
        let pos = fileSize - BOX_HEADER_SIZE;
        const minPos = Math.max(0, fileSize - 100 * 1024 * 1024);
        
        console.log('[MP4Demuxer] _parseMoovFromEnd: scanning from end, fileSize:', fileSize);
        
        while (pos > minPos) {
            const size = this.view.getUint32(pos);
            const type = this._readBoxType(pos + 4);
            
            if (type === 'moov') {
                let moovSize = size;
                let headerSize = BOX_HEADER_SIZE;
                
                if (size === 1) {
                    if (pos + 16 > fileSize) break;
                    moovSize = Number(this.view.getBigUint64(pos + 8));
                    headerSize = 16;
                }
                
                const moovStart = pos;
                const dataStart = pos + headerSize;
                const dataSize = moovSize - headerSize;
                
                console.log('[MP4Demuxer] Found moov at offset:', moovStart, 'size:', moovSize);
                
                this._mdatOffset = this._findMdatOffset();
                
                this._parseBoxes(dataStart, dataStart + dataSize, 1);
                return;
            }
            
            pos--;
        }
        
        console.warn('[MP4Demuxer] _parseMoovFromEnd: moov not found from end');
    }
    
    _findMdatOffset() {
        let pos = 0;
        const fileSize = this.fileBuffer.byteLength;
        
        while (pos < fileSize) {
            if (pos + BOX_HEADER_SIZE > fileSize) break;
            
            let size = this.view.getUint32(pos);
            let type = this._readBoxType(pos + 4);
            let headerSize = BOX_HEADER_SIZE;
            
            if (size === 1) {
                if (pos + 16 > fileSize) break;
                size = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (size === 0) {
                size = fileSize - pos;
            }
            
            if (type === 'mdat') {
                return pos + headerSize;
            }
            
            pos += size;
            
            if (size <= 0) break;
        }
        
        return 0;
    }
    
    async _parseWithMP4Box() {
        return new Promise((resolve, reject) => {
            if (typeof MP4Box === 'undefined') {
                console.warn('[MP4Demuxer] MP4Box not available');
                resolve();
                return;
            }
            
            try {
                const mp4boxFile = MP4Box.createFile();
                let videoDone = false;
                let audioDone = false;
                let hasVideo = false;
                let hasAudio = false;
                
                const checkDone = () => {
                    const videoReady = !hasVideo || videoDone;
                    const audioReady = !hasAudio || audioDone;
                    if (videoReady && audioReady) {
                        mp4boxFile.stop();
                        resolve();
                    }
                };
                
                mp4boxFile.onReady = (info) => {
                    console.log('[MP4Demuxer] MP4Box onReady, tracks:', 
                        'video:', info.videoTracks.length, 
                        'audio:', info.audioTracks.length);
                    
                    hasVideo = info.videoTracks.length > 0;
                    hasAudio = info.audioTracks.length > 0;
                    
                    if (hasVideo) {
                        const vt = info.videoTracks[0];
                        // 提取视频解码配置：H.264 用 avcC，HEVC(H.265) 用 hvcC
                        let descriptionBuf = null;
                        const isHEVC = vt.codec.startsWith('hvc1') || vt.codec.startsWith('hev1') || vt.codec.startsWith('hvc3') || vt.codec.startsWith('hev3');
                        if (vt.codec.startsWith('avc1') || vt.codec.startsWith('avc3')) {
                            const cfg = vt.video?.config;
                            descriptionBuf = _extractBoxBody(cfg);
                            if (!descriptionBuf && this.fileBuffer) {
                                descriptionBuf = _findBoxInBuffer(this.fileBuffer, 'avcC');
                            }
                            console.log('[MP4Demuxer] avcC 提取结果:', descriptionBuf ? descriptionBuf.byteLength + ' bytes' : 'null');
                        } else if (isHEVC) {
                            const cfg = vt.video?.config;
                            descriptionBuf = _extractBoxBody(cfg);
                            if (!descriptionBuf && this.fileBuffer) {
                                descriptionBuf = _findBoxInBuffer(this.fileBuffer, 'hvcC');
                            }
                            console.log('[MP4Demuxer] hvcC 提取结果:', descriptionBuf ? descriptionBuf.byteLength + ' bytes' : 'null');
                        }
                        this.videoTrack = {
                            codec: vt.codec,
                            width: vt.video.width,
                            height: vt.video.height,
                            timescale: vt.timescale,
                            duration: vt.duration,
                            description: descriptionBuf,
                            avcC: vt.codec.startsWith('avc1') || vt.codec.startsWith('avc3') ? descriptionBuf : null,
                            hvcC: isHEVC ? descriptionBuf : null
                        };
                        console.log('[MP4Demuxer] MP4Box video track:', { codec: this.videoTrack.codec, width: this.videoTrack.width, height: this.videoTrack.height, descSize: descriptionBuf ? descriptionBuf.byteLength : 0 });
                        
                        mp4boxFile.setExtractionOptions(vt.id, 'video', { nbSamples: Infinity });
                    }
                    
                    if (hasAudio) {
                        const at = info.audioTracks[0];
                        let esdsBuf = null;
                        if (at.codec === 'mp4a' || at.codec.startsWith('mp4a.')) {
                            esdsBuf = _extractBoxBody(at.audio?.config);
                            if (!esdsBuf && this.fileBuffer) {
                                esdsBuf = _findBoxInBuffer(this.fileBuffer, 'esds');
                            }
                            console.log('[MP4Demuxer] esds 提取结果:', esdsBuf ? esdsBuf.byteLength + ' bytes' : 'null');
                        }
                        // 规范化 codec 字符串为 WebCodecs 可识别格式
                        let codec = at.codec;
                        if (codec === 'mp4a' || codec === 'mp4a.40' || !codec.includes('.')) {
                            const audioObjectType = this._getAACAudioObjectType(esdsBuf);
                            codec = 'mp4a.40.' + (audioObjectType || '2');
                        }
                        
                        this.audioTrack = {
                            codec: codec,
                            channels: at.audio.channel_count,
                            sampleRate: at.audio.sample_rate,
                            timescale: at.timescale,
                            duration: at.duration,
                            esds: esdsBuf,
                            audioObjectType: this._getAACAudioObjectType(esdsBuf)
                        };
                        console.log('[MP4Demuxer] MP4Box audio track:', { codec: this.audioTrack.codec, sampleRate: this.audioTrack.sampleRate, channels: this.audioTrack.channels, esdsSize: esdsBuf ? esdsBuf.byteLength : 0 });
                        
                        mp4boxFile.setExtractionOptions(at.id, 'audio', { nbSamples: Infinity });
                    }
                    
                    if (!hasVideo && !hasAudio) {
                        resolve();
                        return;
                    }
                    
                    mp4boxFile.start();
                };
                
                mp4boxFile.onSamples = (id, user, samples) => {
                    console.log('[MP4Demuxer] MP4Box onSamples:', user, samples.length);
                    
                    if (user === 'video') {
                        for (const sample of samples) {
                            this.videoSamples.push({
                                data: sample.data,
                                size: sample.size,
                                offset: sample.offset,
                                isKeyframe: sample.is_sync,
                                ctsUs: (sample.cts / sample.timescale) * 1000000,
                                dtsUs: (sample.dts / sample.timescale) * 1000000,
                                durationUs: (sample.duration / sample.timescale) * 1000000,
                                timescale: sample.timescale
                            });
                        }
                        videoDone = true;
                        console.log('[MP4Demuxer] Video samples:', this.videoSamples.length);
                    } else if (user === 'audio') {
                        for (const sample of samples) {
                            this.audioSamples.push({
                                data: sample.data,
                                size: sample.size,
                                offset: sample.offset,
                                ctsUs: (sample.cts / sample.timescale) * 1000000,
                                dtsUs: (sample.dts / sample.timescale) * 1000000,
                                durationUs: (sample.duration / sample.timescale) * 1000000,
                                timescale: sample.timescale
                            });
                        }
                        audioDone = true;
                        console.log('[MP4Demuxer] Audio samples:', this.audioSamples.length);
                    }
                    
                    checkDone();
                };
                
                mp4boxFile.onError = (e) => {
                    console.warn('[MP4Demuxer] MP4Box error:', e);
                    resolve();
                };
                
                const buf = this.fileBuffer;
                buf.fileStart = 0;
                mp4boxFile.appendBuffer(buf);
                mp4boxFile.flush();
                
            } catch (e) {
                console.warn('[MP4Demuxer] MP4Box parse failed:', e);
                resolve();
            }
        });
    }

    async _parseWithMP4BoxChunked(file) {
        // 策略：先读开头 10MB 探测 moov，如果没找到再读末尾 50MB
        // 找到 moov 后从 track.samples 构建样本表，不调用 start() 提取 data
        // 按需解码时用 file.slice() 读取单个样本
        return new Promise((resolve, reject) => {
            if (typeof MP4Box === 'undefined') {
                reject(new Error('大文件解析必须依赖 MP4Box.js'));
                return;
            }

            const mp4boxFile = MP4Box.createFile();
            let resolved = false;
            let searchBuffers = []; // 保存包含 moov 的 chunk，用于搜索 avcC/esds

            const finish = () => {
                if (resolved) return;
                resolved = true;
                try { mp4boxFile.stop(); } catch (e) {}
                resolve();
            };

            mp4boxFile.onReady = (info) => {
                console.log('[MP4Demuxer] 切片解析 onReady, tracks:',
                    'video:', info.videoTracks.length,
                    'audio:', info.audioTracks.length);

                const hasVideo = info.videoTracks.length > 0;
                const hasAudio = info.audioTracks.length > 0;

                if (hasVideo) {
                    const vt = info.videoTracks[0];
                    // 提取视频解码配置：H.264 用 avcC，HEVC(H.265) 用 hvcC
                    let descriptionBuf = null;
                    const isHEVC = vt.codec.startsWith('hvc1') || vt.codec.startsWith('hev1') || vt.codec.startsWith('hvc3') || vt.codec.startsWith('hev3');
                    if (vt.codec.startsWith('avc1') || vt.codec.startsWith('avc3')) {
                        descriptionBuf = _extractBoxBody(vt.video?.config);
                        if (!descriptionBuf) {
                            for (const buf of searchBuffers) {
                                descriptionBuf = _findBoxInBuffer(buf, 'avcC');
                                if (descriptionBuf) {
                                    console.log('[MP4Demuxer] 从切片中找到 avcC:', descriptionBuf.byteLength, 'bytes');
                                    break;
                                }
                            }
                        }
                    } else if (isHEVC) {
                        descriptionBuf = _extractBoxBody(vt.video?.config);
                        if (!descriptionBuf) {
                            for (const buf of searchBuffers) {
                                descriptionBuf = _findBoxInBuffer(buf, 'hvcC');
                                if (descriptionBuf) {
                                    console.log('[MP4Demuxer] 从切片中找到 hvcC:', descriptionBuf.byteLength, 'bytes');
                                    break;
                                }
                            }
                        }
                    }
                    console.log('[MP4Demuxer] description 提取结果:', descriptionBuf ? descriptionBuf.byteLength + ' bytes' : 'null');
                    this.videoTrack = {
                        codec: vt.codec,
                        width: vt.video.width,
                        height: vt.video.height,
                        timescale: vt.timescale,
                        duration: vt.duration,
                        description: descriptionBuf,
                        avcC: vt.codec.startsWith('avc1') || vt.codec.startsWith('avc3') ? descriptionBuf : null,
                        hvcC: isHEVC ? descriptionBuf : null
                    };

                    // 从 track.samples 构建样本表（不提取 data）
                    if (vt.samples && vt.samples.length > 0) {
                        for (const sample of vt.samples) {
                            this.videoSamples.push({
                                data: null, // 按需读取
                                size: sample.size,
                                offset: sample.offset,
                                isKeyframe: sample.is_sync,
                                ctsUs: (sample.cts / sample.timescale) * 1000000,
                                dtsUs: (sample.dts / sample.timescale) * 1000000,
                                durationUs: (sample.duration / sample.timescale) * 1000000,
                                timescale: sample.timescale
                            });
                        }
                        console.log('[MP4Demuxer] 从 track.samples 构建视频样本表:', this.videoSamples.length);
                    } else {
                        console.warn('[MP4Demuxer] track.samples 为空，无法构建视频样本表');
                        console.log('[MP4Demuxer] vt 所有属性:', Object.keys(vt).join(', '));
                        console.log('[MP4Demuxer] track.video 属性:', vt.video ? Object.keys(vt.video).join(', ') : 'null');
                        // 尝试从 MP4Box track 内部结构获取样本表
                        const boxes = this._extractSamplesFromMP4BoxTrack(vt, mp4boxFile);
                        if (boxes && boxes.stts && boxes.stsc && boxes.stsz && boxes.stco) {
                            const trackInfo = this._buildTrackInfoFromBoxes(vt, boxes);
                            if (trackInfo) {
                                this.videoTrack = { ...this.videoTrack, ...trackInfo };
                                this.videoSamples = this._buildSamplesFromBoxes(trackInfo, boxes, vt.timescale);
                                console.log('[MP4Demuxer] 从 MP4Box box 构建视频样本:', this.videoSamples.length);
                            }
                        }
                    }
                }

                if (hasAudio) {
                    const at = info.audioTracks[0];
                    let esdsBuf = null;
                    if (at.codec === 'mp4a' || at.codec.startsWith('mp4a.')) {
                        esdsBuf = _extractBoxBody(at.audio?.config);
                        if (!esdsBuf) {
                            for (const buf of searchBuffers) {
                                esdsBuf = _findBoxInBuffer(buf, 'esds');
                                if (esdsBuf) {
                                    console.log('[MP4Demuxer] 从切片中找到 esds:', esdsBuf.byteLength, 'bytes');
                                    break;
                                }
                            }
                        }
                    }
                    console.log('[MP4Demuxer] esds 提取结果:', esdsBuf ? esdsBuf.byteLength + ' bytes' : 'null');
                    let codec = at.codec;
                    if (codec === 'mp4a' || codec === 'mp4a.40' || !codec.includes('.')) {
                        const audioObjectType = this._getAACAudioObjectType(esdsBuf);
                        codec = 'mp4a.40.' + (audioObjectType || '2');
                    }
                    this.audioTrack = {
                        codec: codec,
                        channels: at.audio.channel_count,
                        sampleRate: at.audio.sample_rate,
                        timescale: at.timescale,
                        duration: at.duration,
                        esds: esdsBuf,
                        audioObjectType: this._getAACAudioObjectType(esdsBuf)
                    };

                    // 从 track.samples 构建音频样本表
                    if (at.samples && at.samples.length > 0) {
                        for (const sample of at.samples) {
                            this.audioSamples.push({
                                data: null,
                                size: sample.size,
                                offset: sample.offset,
                                ctsUs: (sample.cts / sample.timescale) * 1000000,
                                dtsUs: (sample.dts / sample.timescale) * 1000000,
                                durationUs: (sample.duration / sample.timescale) * 1000000,
                                timescale: sample.timescale
                            });
                        }
                        console.log('[MP4Demuxer] 从 track.samples 构建音频样本表:', this.audioSamples.length);
                    } else {
                        console.warn('[MP4Demuxer] track.samples 为空，无法构建音频样本表');
                        console.log('[MP4Demuxer] at 所有属性:', Object.keys(at).join(', '));
                        console.log('[MP4Demuxer] track.audio 属性:', at.audio ? Object.keys(at.audio).join(', ') : 'null');
                        const boxes = this._extractSamplesFromMP4BoxTrack(at, mp4boxFile);
                        if (boxes && boxes.stts && boxes.stsc && boxes.stsz && boxes.stco) {
                            const trackInfo = this._buildTrackInfoFromBoxes(at, boxes);
                            if (trackInfo) {
                                this.audioTrack = { ...this.audioTrack, ...trackInfo };
                                this.audioSamples = this._buildSamplesFromBoxes(trackInfo, boxes, at.timescale);
                                console.log('[MP4Demuxer] 从 MP4Box box 构建音频样本:', this.audioSamples.length);
                            }
                        }
                    }
                }

                // 如果 track.samples 不可用，用自己的解析器从 moov buffer 中提取
                if ((hasVideo && this.videoSamples.length === 0) ||
                    (hasAudio && this.audioSamples.length === 0)) {
                    console.log('[MP4Demuxer] track.samples 不可用，从 moov buffer 自解析样本表');

                    let parsed = false;
                    for (const buf of searchBuffers) {
                        const moovBody = _findBoxInBuffer(buf, 'moov');
                        if (moovBody && moovBody.byteLength > 0) {
                            console.log('[MP4Demuxer] 找到 moov body，大小:', moovBody.byteLength, 'bytes');
                            this._parseSamplesFromMoovBody(moovBody);
                            parsed = true;
                            break;
                        }
                    }

                    if (!parsed) {
                        console.warn('[MP4Demuxer] 未找到 moov body，无法构建样本表');
                    }
                }

                finish();
            };

            mp4boxFile.onError = (e) => {
                console.warn('[MP4Demuxer] 切片解析 MP4Box error:', e);
                finish();
            };

            const appendChunk = (buffer, fileStart) => {
                buffer.fileStart = fileStart;
                searchBuffers.push(buffer);
                try {
                    mp4boxFile.appendBuffer(buffer);
                    return true;
                } catch (err) {
                    console.warn('[MP4Demuxer] appendBuffer 异常:', err.message);
                    return false;
                }
            };

            const readRange = (start, end, callback) => {
                const slice = file.slice(start, end);
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (resolved) return;
                    const buffer = e.target.result;
                    callback(buffer);
                };
                reader.onerror = () => {
                    console.error('[MP4Demuxer] 切片读取失败:', start, '-', end);
                    finish();
                };
                reader.readAsArrayBuffer(slice);
            };

            // 步骤1：读开头 10MB 探测 moov
            const startSize = Math.min(10 * 1024 * 1024, file.size);
            readRange(0, startSize, (buffer) => {
                appendChunk(buffer, 0);
                console.log('[MP4Demuxer] 读取开头', (buffer.byteLength / 1024 / 1024).toFixed(1), 'MB');

                if (resolved) return;

                // 如果 onReady 没触发，说明 moov 在文件末尾
                // 步骤2：读末尾 50MB
                const endSize = Math.min(50 * 1024 * 1024, file.size);
                const endStart = Math.max(0, file.size - endSize);
                console.log('[MP4Demuxer] moov 未在开头找到，读取末尾', (endSize / 1024 / 1024).toFixed(1), 'MB');
                readRange(endStart, file.size, (buffer2) => {
                    appendChunk(buffer2, endStart);
                    console.log('[MP4Demuxer] 读取末尾', (buffer2.byteLength / 1024 / 1024).toFixed(1), 'MB');

                    if (resolved) {
                        return;
                    }

                    // 如果仍未触发 onReady，尝试 flush
                    try { mp4boxFile.flush(); } catch (e) {}
                    finish();
                });
            });
        });
    }

    _parseSamplesFromMoovBody(moovBody) {
        const savedBuffer = this.fileBuffer;
        const savedView = this.view;

        try {
            this.fileBuffer = moovBody;
            this.view = new DataView(moovBody);

            const savedVideoTrack = this.videoTrack;
            const savedAudioTrack = this.audioTrack;

            this.videoTrack = null;
            this.audioTrack = null;

            // 直接遍历 trak box，调试解析过程
            let pos = 0;
            let trakIndex = 0;
            while (pos < moovBody.byteLength - 8) {
                const size = this.view.getUint32(pos);
                const type = this._readBoxType(pos + 4);
                if (size <= 0 || pos + size > moovBody.byteLength) break;

                if (type === 'trak') {
                    trakIndex++;
                    const dataStart = pos + 8;
                    const dataEnd = pos + size;

                    // 手动解析 trak，打印调试信息
                    const trackDebug = this._debugParseTrack(dataStart, dataEnd);
                    console.log(`[MP4Demuxer] trak[${trakIndex}] 调试:`, trackDebug);

                    this._parseTrack(dataStart, dataEnd);
                }

                pos += size;
            }

            console.log('[MP4Demuxer] moov 自解析 - videoTrack:', !!this.videoTrack,
                'audioTrack:', !!this.audioTrack);
            if (this.videoTrack) {
                console.log('[MP4Demuxer] 视频轨道信息:', {
                    codec: this.videoTrack.codec,
                    width: this.videoTrack.width,
                    height: this.videoTrack.height,
                    timescale: this.videoTrack.timescale,
                    sampleCount: this.videoTrack.sampleSizes?.sampleCount || 0,
                    hasTimeToSample: !!this.videoTrack.timeToSample,
                    hasChunkOffsets: !!this.videoTrack.chunkOffsets,
                    hasSampleToChunk: !!this.videoTrack.sampleToChunk
                });
            }
            if (this.audioTrack) {
                console.log('[MP4Demuxer] 音频轨道信息:', {
                    codec: this.audioTrack.codec,
                    sampleRate: this.audioTrack.sampleRate,
                    channels: this.audioTrack.channels,
                    timescale: this.audioTrack.timescale,
                    sampleCount: this.audioTrack.sampleSizes?.sampleCount || 0
                });
            }

            this._buildSampleTables();

            console.log('[MP4Demuxer] moov 自解析结果:',
                'videoSamples:', this.videoSamples.length,
                'audioSamples:', this.audioSamples.length);

            if (this.videoSamples.length === 0 && savedVideoTrack) {
                this.videoTrack = savedVideoTrack;
            }
            if (this.audioSamples.length === 0 && savedAudioTrack) {
                this.audioTrack = savedAudioTrack;
            }
        } catch (e) {
            console.warn('[MP4Demuxer] moov 自解析失败:', e.message, e.stack);
        } finally {
            this.fileBuffer = savedBuffer;
            this.view = savedView;
        }
    }

    _debugParseTrack(start, end) {
        const result = { boxes: [] };
        let pos = start;
        while (pos < end - 8) {
            const size = this.view.getUint32(pos);
            const type = this._readBoxType(pos + 4);
            result.boxes.push(type + '(' + size + ')');
            if (size <= 0 || pos + size > end) break;
            pos += size;
        }
        return result;
    }

    _extractSamplesFromMP4BoxTrack(track, mp4boxFile) {
        if (!track) return null;

        console.log('[MP4Demuxer] 尝试从 MP4Box track 提取样本表...');
        const isVideo = !!track.video;

        let videoStbl = null;
        let audioStbl = null;

        const findStbl = (boxes, path = '') => {
            if (!boxes || !Array.isArray(boxes)) return;
            for (let i = 0; i < boxes.length; i++) {
                const box = boxes[i];
                if (!box) continue;
                const boxType = box.type || '';
                const curPath = path + '[' + i + '](' + boxType + ')';

                if (boxType === 'stbl') {
                    // 判断是视频还是音频 stbl: 视频有 stss (SyncSample), 音频没有
                    const hasStss = !!box.stss;
                    const hasCtts = !!box.ctts;
                    const isVideoStbl = hasStss || hasCtts;

                    if (isVideoStbl && !videoStbl) {
                        videoStbl = box;
                    } else if (!isVideoStbl && !audioStbl) {
                        audioStbl = box;
                    }
                    // 如果已经找到两种，跳过打印日志
                }

                if (videoStbl && audioStbl) return; // 两种都找到了，提前退出
                if (box.boxes) findStbl(box.boxes, curPath);
                if (box.traks) findStbl(box.traks, curPath);
            }
        };

        if (mp4boxFile && mp4boxFile.boxes) {
            findStbl(mp4boxFile.boxes, 'boxes');
        }

        const stbl = isVideo ? videoStbl : audioStbl;
        if (!stbl) {
            console.warn('[MP4Demuxer] 未找到合适的 stbl, isVideo:', isVideo);
            return null;
        }

        console.log('[MP4Demuxer] 使用', isVideo ? '视频' : '音频', 'stbl:',
            'stts:', !!stbl.stts, 'stsc:', !!stbl.stsc, 'stsz:', !!stbl.stsz,
            'stco:', !!(stbl.stco || stbl.co64), 'stss:', !!stbl.stss, 'ctts:', !!stbl.ctts);

        return {
            stts: stbl.stts || null,
            stsc: stbl.stsc || null,
            stsz: stbl.stsz || null,
            stco: stbl.stco || stbl.co64 || null,
            stss: stbl.stss || null,
            ctts: stbl.ctts || null
        };
    }

    _buildTrackInfoFromBoxes(track, boxes) {
        const info = {
            codec: track.codec,
            timescale: track.timescale,
            duration: track.duration,
            sampleSizes: { sampleCount: 0, sizes: [] }
        };

        if (track.video) {
            info.width = track.video.width;
            info.height = track.video.height;
        }
        if (track.audio) {
            info.sampleRate = track.audio.sample_rate;
            info.channels = track.audio.channel_count;
        }

        return info;
    }

    _buildSamplesFromBoxes(trackInfo, boxes, timescale) {
        const samples = [];
        const stts = boxes.stts;
        const stsc = boxes.stsc;
        const stsz = boxes.stsz;
        const stco = boxes.stco;
        const stss = boxes.stss;
        const ctts = boxes.ctts;

        if (!stts || !stsc || !stsz || !stco) return samples;

        const sampleCount = stsz.sample_count || stsz.sampleCount || stsz.nb_samples || 0;
        if (sampleCount === 0) return samples;

        const sampleSizes = [];
        if (stsz.sample_size && stsz.sample_size > 0) {
            for (let i = 0; i < sampleCount; i++) {
                sampleSizes.push(stsz.sample_size);
            }
        } else if (stsz.sample_sizes || stsz.entries) {
            const sizes = stsz.sample_sizes || stsz.entries;
            for (let i = 0; i < sampleCount && i < sizes.length; i++) {
                sampleSizes.push(sizes[i]);
            }
        }

        const syncSamples = {};
        if (stss && (stss.sample_numbers || stss.entries)) {
            const syncNums = stss.sample_numbers || stss.entries;
            for (let i = 0; i < syncNums.length; i++) {
                syncSamples[syncNums[i] - 1] = true;
            }
        }

        const sampleDeltas = [];
        let sttsTotal = 0;
        if (stts.sample_counts && stts.sample_deltas) {
            for (let i = 0; i < stts.sample_counts.length && sttsTotal < sampleCount; i++) {
                const count = stts.sample_counts[i];
                const delta = stts.sample_deltas[i];
                for (let j = 0; j < count && sttsTotal < sampleCount; j++) {
                    sampleDeltas.push(delta);
                    sttsTotal++;
                }
            }
        } else if (stts.entries) {
            for (let i = 0; i < stts.entries.length && sttsTotal < sampleCount; i++) {
                const entry = stts.entries[i];
                const count = entry.sample_count || entry.count;
                const delta = entry.sample_delta || entry.delta;
                for (let j = 0; j < count && sttsTotal < sampleCount; j++) {
                    sampleDeltas.push(delta);
                    sttsTotal++;
                }
            }
        }

        let chunkOffsets = [];
        if (stco.chunk_offsets || stco.entries) {
            chunkOffsets = stco.chunk_offsets || stco.entries;
        }

        const sampleToChunk = [];
        if (stsc.first_chunk && stsc.samples_per_chunk) {
            for (let i = 0; i < stsc.first_chunk.length; i++) {
                sampleToChunk.push({
                    firstChunk: stsc.first_chunk[i],
                    samplesPerChunk: stsc.samples_per_chunk[i]
                });
            }
        } else if (stsc.entries) {
            for (let i = 0; i < stsc.entries.length; i++) {
                const entry = stsc.entries[i];
                sampleToChunk.push({
                    firstChunk: entry.first_chunk || entry.firstChunk || entry.first_chunk_index,
                    samplesPerChunk: entry.samples_per_chunk || entry.samplesPerChunk
                });
            }
        }

        const ctsOffsets = [];
        let ctsTotal = 0;
        if (ctts) {
            if (ctts.sample_counts && ctts.sample_offsets) {
                for (let i = 0; i < ctts.sample_counts.length && ctsTotal < sampleCount; i++) {
                    const count = ctts.sample_counts[i];
                    const offset = ctts.sample_offsets[i];
                    for (let j = 0; j < count && ctsTotal < sampleCount; j++) {
                        ctsOffsets.push(offset);
                        ctsTotal++;
                    }
                }
            } else if (ctts.entries) {
                for (let i = 0; i < ctts.entries.length && ctsTotal < sampleCount; i++) {
                    const entry = ctts.entries[i];
                    const count = entry.sample_count || entry.count;
                    const offset = entry.sample_offset || entry.offset || entry.composition_offset;
                    for (let j = 0; j < count && ctsTotal < sampleCount; j++) {
                        ctsOffsets.push(offset);
                        ctsTotal++;
                    }
                }
            }
        }

        let sampleIndex = 0;
        let dts = 0;

        for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && sampleIndex < sampleCount; chunkIdx++) {
            let samplesInChunk = 1;
            for (let s = sampleToChunk.length - 1; s >= 0; s--) {
                if (chunkIdx + 1 >= sampleToChunk[s].firstChunk) {
                    samplesInChunk = sampleToChunk[s].samplesPerChunk;
                    break;
                }
            }

            let chunkOffset = chunkOffsets[chunkIdx];

            for (let s = 0; s < samplesInChunk && sampleIndex < sampleCount; s++) {
                const size = sampleSizes[sampleIndex] || 0;
                const delta = sampleDeltas[sampleIndex] || 0;
                const ctsOffset = ctsOffsets[sampleIndex] || 0;
                const isKey = stss ? (syncSamples[sampleIndex] || false) : (sampleIndex === 0);

                samples.push({
                    data: null,
                    size: size,
                    offset: chunkOffset,
                    isKeyframe: isKey,
                    dtsUs: (dts / timescale) * 1000000,
                    ctsUs: ((dts + ctsOffset) / timescale) * 1000000,
                    durationUs: (delta / timescale) * 1000000,
                    timescale: timescale
                });

                chunkOffset += size;
                dts += delta;
                sampleIndex++;
            }
        }

        return samples;
    }

    getVideoConfig() {
        if (!this.videoTrack) return null;

        const track = this.videoTrack;
        const config = {
            codec: track.codec,
            codedWidth: track.width,
            codedHeight: track.height,
            // description 统一存放解码配置：H.264 为 avcC 内容，HEVC 为 hvcC 内容
            description: track.description || track.avcC || track.hvcC || null
        };

        return config;
    }

    getAudioConfig() {
        if (!this.audioTrack) return null;
        
        const track = this.audioTrack;
        const config = {
            codec: track.codec,
            sampleRate: track.sampleRate,
            numberOfChannels: track.channels,
            description: this._getAudioSpecificConfig() || track.esds || null
        };
        
        return config;
    }

    /**
     * 从 esds box body 中提取 AudioSpecificConfig (ASC)
     * esds 结构：version(1) + flags(3) + ES_Descriptor(tag+size+content)
     * 其中 DecoderConfigDescriptor 中包含了 DecoderSpecificInfo (tag=5)，
     * 其内容就是 AudioSpecificConfig，通常为 2 字节。
     */
    _getAudioSpecificConfig() {
        if (!this.audioTrack || !this.audioTrack.esds) return null;
        
        const esds = new Uint8Array(this.audioTrack.esds);
        let pos = 0;
        
        // 跳过 esds version + flags
        if (esds.length < 4) return null;
        pos += 4;
        
        // 读取 ES_Descriptor tag
        if (pos >= esds.length || esds[pos] !== 0x03) return null;
        pos++;
        
        // 读取扩展长度
        let length = 0;
        for (let i = 0; i < 4 && pos < esds.length; i++) {
            const b = esds[pos++];
            length = (length << 7) | (b & 0x7F);
            if ((b & 0x80) === 0) break;
        }
        const esDescEnd = pos + length;
        if (esDescEnd > esds.length) return null;
        
        // 跳过 ES_ID 和 flags
        pos += 2; // ES_ID
        if (pos >= esDescEnd) return null;
        pos += 1; // streamDependenceFlag + URLFlag + OCRstreamFlag
        
        // 读取 DecoderConfigDescriptor (tag=4)
        if (pos >= esDescEnd || esds[pos] !== 0x04) return null;
        pos++;
        
        // 读取 DecoderConfigDescriptor 长度
        length = 0;
        for (let i = 0; i < 4 && pos < esDescEnd; i++) {
            const b = esds[pos++];
            length = (length << 7) | (b & 0x7F);
            if ((b & 0x80) === 0) break;
        }
        const decConfigEnd = pos + length;
        if (decConfigEnd > esDescEnd) return null;
        
        // 跳过 objectTypeIndication(1), streamType(1)+bufferSize(3), maxBitrate(4), avgBitrate(4)
        pos += 13;
        if (pos >= decConfigEnd) return null;
        
        // 读取 DecoderSpecificInfo (tag=5)
        if (esds[pos] !== 0x05) return null;
        pos++;
        
        // 读取 DecoderSpecificInfo 长度
        length = 0;
        for (let i = 0; i < 4 && pos < decConfigEnd; i++) {
            const b = esds[pos++];
            length = (length << 7) | (b & 0x7F);
            if ((b & 0x80) === 0) break;
        }
        if (pos + length > decConfigEnd) return null;
        
        // 返回 AudioSpecificConfig
        return esds.slice(pos, pos + length).buffer;
    }

    /**
     * 从 AudioSpecificConfig 中读取 AAC AudioObjectType
     */
    _getAACAudioObjectType(esdsBuffer) {
        if (!esdsBuffer) return null;
        
        // 优先从 esds 中解析 DecoderSpecificInfo
        try {
            const esds = new Uint8Array(esdsBuffer);
            let pos = 0;
            
            // 跳过 esds version + flags
            if (esds.length < 4) return null;
            pos += 4;
            
            // 读取 ES_Descriptor tag
            if (pos >= esds.length || esds[pos] !== 0x03) return null;
            pos++;
            
            // 读取扩展长度
            let length = 0;
            for (let i = 0; i < 4 && pos < esds.length; i++) {
                const b = esds[pos++];
                length = (length << 7) | (b & 0x7F);
                if ((b & 0x80) === 0) break;
            }
            const esDescEnd = pos + length;
            if (esDescEnd > esds.length) return null;
            
            // 跳过 ES_ID
            pos += 2;
            if (pos >= esDescEnd) return null;
            pos += 1;
            
            // 读取 DecoderConfigDescriptor
            if (pos >= esDescEnd || esds[pos] !== 0x04) return null;
            pos++;
            
            // 读取长度
            length = 0;
            for (let i = 0; i < 4 && pos < esDescEnd; i++) {
                const b = esds[pos++];
                length = (length << 7) | (b & 0x7F);
                if ((b & 0x80) === 0) break;
            }
            const decConfigEnd = pos + length;
            if (decConfigEnd > esDescEnd) return null;
            
            // objectTypeIndication
            pos += 1;
            if (pos >= decConfigEnd) return null;
            
            // 读取 DecoderSpecificInfo (tag=5)
            if (esds[pos] !== 0x05) return null;
            pos++;
            
            // 读取长度
            length = 0;
            for (let i = 0; i < 4 && pos < decConfigEnd; i++) {
                const b = esds[pos++];
                length = (length << 7) | (b & 0x7F);
                if ((b & 0x80) === 0) break;
            }
            if (pos + length > decConfigEnd) return null;
            
            const asc = esds.slice(pos, pos + length);
            if (asc.length === 0) return null;
            
            // 解析 AudioObjectType
            let aot = (asc[0] >> 3) & 0x1F;
            if (aot === 31 && asc.length >= 2) {
                aot = 32 + ((asc[0] & 0x07) << 3) | ((asc[1] >> 5) & 0x07);
            }
            return aot;
        } catch (e) {
            return null;
        }
    }

    async getVideoChunk(index) {
        if (index < 0 || index >= this.videoSamples.length) return null;
        const sample = this.videoSamples[index];
        // 如果 data 为 null（切片模式），按需从文件读取
        if (!sample.data && this.file && sample.offset !== undefined && sample.size > 0) {
            try {
                const slice = this.file.slice(sample.offset, sample.offset + sample.size);
                const buffer = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('File read failed'));
                    reader.readAsArrayBuffer(slice);
                });
                sample.data = new Uint8Array(buffer);
            } catch (err) {
                console.warn('[MP4Demuxer] 按需读取视频样本失败:', err.message);
                return null;
            }
        }
        return this._createVideoChunk(sample);
    }

    /**
     * 释放已消费样本的 data，防止大文件 OOM
     * @param {number} beforeIndex 释放 index < beforeIndex 的样本 data
     */
    releaseVideoSamplesBefore(beforeIndex) {
        if (beforeIndex <= 0) return;
        const end = Math.min(beforeIndex, this.videoSamples.length);
        let released = 0;
        for (let i = 0; i < end; i++) {
            const s = this.videoSamples[i];
            if (s && s.data) {
                s.data = null;
                released++;
            }
        }
        if (released > 0) {
            console.log(`[MP4Demuxer] 释放视频样本 data: 0-${end}, ${released} 个`);
        }
    }

    async getAudioChunk(index) {
        if (index < 0 || index >= this.audioSamples.length) return null;
        const sample = this.audioSamples[index];
        // 如果 data 为 null（切片模式），按需从文件读取
        if (!sample.data && this.file && sample.offset !== undefined && sample.size > 0) {
            try {
                // 批量读取连续样本，但限制最大批量大小（防止一次性读入整个文件导致 OOM）
                // MP4 音频样本通常连续存储，不加限制会一次性读入几 GB
                const MAX_BATCH_SAMPLES = 500;
                const MAX_BATCH_BYTES = 1 * 1024 * 1024; // 1MB
                let batchEnd = index;
                let expectedOffset = sample.offset + sample.size;
                for (let i = index + 1; i < this.audioSamples.length; i++) {
                    const next = this.audioSamples[i];
                    if (next.offset === expectedOffset) {
                        const batchBytes = (next.offset + next.size) - sample.offset;
                        if (i - index + 1 > MAX_BATCH_SAMPLES || batchBytes > MAX_BATCH_BYTES) break;
                        expectedOffset = next.offset + next.size;
                        batchEnd = i;
                    } else {
                        break;
                    }
                }

                const lastSample = this.audioSamples[batchEnd];
                const batchSize = (lastSample.offset + lastSample.size) - sample.offset;

                const slice = this.file.slice(sample.offset, sample.offset + batchSize);
                const buffer = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('File read failed'));
                    reader.readAsArrayBuffer(slice);
                });

                // 用读取的 batch buffer 填充所有连续样本的 data
                for (let i = index; i <= batchEnd; i++) {
                    const s = this.audioSamples[i];
                    const offsetInBatch = s.offset - sample.offset;
                    s.data = new Uint8Array(buffer, offsetInBatch, s.size);
                }
            } catch (err) {
                console.warn('[MP4Demuxer] 按需读取音频样本失败:', err.message);
                return null;
            }
        }
        return this._createAudioChunk(sample);
    }

    findKeyframeIndexBefore(timestampUs) {
        let result = -1;
        for (let i = 0; i < this.videoSamples.length; i++) {
            const sample = this.videoSamples[i];
            if (sample.ctsUs <= timestampUs && sample.isKeyframe) {
                result = i;
            }
        }
        if (result === -1 && this.videoSamples.length > 0) {
            result = 0;
        }
        return result;
    }

    /**
     * 找到指定时间最近的视频样本索引
     */
    findSampleIndexAtTime(timestampUs) {
        for (let i = 0; i < this.videoSamples.length; i++) {
            const sample = this.videoSamples[i];
            if (sample.ctsUs >= timestampUs) {
                return i;
            }
        }
        return this.videoSamples.length > 0 ? this.videoSamples.length - 1 : 0;
    }

    /**
     * 找到指定时间之前的音频样本索引
     */
    findAudioSampleIndexBefore(timestampUs) {
        for (let i = this.audioSamples.length - 1; i >= 0; i--) {
            if (this.audioSamples[i].ctsUs <= timestampUs) {
                return i;
            }
        }
        return 0;
    }

    /**
     * 找到指定时间之后的音频样本索引
     */
    findAudioSampleIndexAfter(timestampUs) {
        for (let i = 0; i < this.audioSamples.length; i++) {
            if (this.audioSamples[i].ctsUs >= timestampUs) {
                return i;
            }
        }
        return this.audioSamples.length > 0 ? this.audioSamples.length - 1 : 0;
    }

    get totalVideoDurationUs() {
        if (this.videoSamples.length === 0) return 0;
        const last = this.videoSamples[this.videoSamples.length - 1];
        return last.ctsUs + last.durationUs;
    }

    get totalAudioDurationUs() {
        if (this.audioSamples.length === 0) return 0;
        const last = this.audioSamples[this.audioSamples.length - 1];
        return last.ctsUs + last.durationUs;
    }

    _parseBoxes(start, end, depth = 0) {
        let pos = start;
        
        while (pos < end) {
            if (pos + BOX_HEADER_SIZE > end) break;
            
            let size = this.view.getUint32(pos);
            let type = this._readBoxType(pos + 4);
            
            let headerSize = BOX_HEADER_SIZE;
            
            if (size === 1) {
                if (pos + 16 > end) break;
                size = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (size === 0) {
                size = end - pos;
            }
            
            const boxEnd = pos + size;
            const dataStart = pos + headerSize;
            const dataSize = size - headerSize;
            
            this._handleBox(type, dataStart, dataSize, depth);
            
            pos = boxEnd;
        }
    }

    _handleBox(type, dataStart, dataSize, depth) {
        switch (type) {
            case 'moov':
                this._parseBoxes(dataStart, dataStart + dataSize, depth + 1);
                break;
            case 'trak':
                this._parseTrack(dataStart, dataStart + dataSize);
                break;
            case 'mdat':
                this._mdatOffset = dataStart;
                break;
            default:
                break;
        }
    }

    _parseTrack(start, end) {
        let pos = start;
        let trackType = null;
        let trackInfo = {};
        
        while (pos < end) {
            if (pos + BOX_HEADER_SIZE > end) break;
            
            let size = this.view.getUint32(pos);
            let type = this._readBoxType(pos + 4);
            let headerSize = BOX_HEADER_SIZE;
            
            if (size === 1) {
                if (pos + 16 > end) break;
                size = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (size === 0) break;
            
            const dataStart = pos + headerSize;
            const dataSize = size - headerSize;
            
            switch (type) {
                case 'tkhd':
                    trackInfo = { ...trackInfo, ...this._parseTkhd(dataStart, dataSize) };
                    break;
                case 'mdia':
                    const mdiaResult = this._parseMdia(dataStart, dataStart + dataSize);
                    if (mdiaResult) {
                        trackType = mdiaResult.type;
                        trackInfo = { ...trackInfo, ...mdiaResult.info };
                    }
                    break;
                default:
                    break;
            }
            
            pos += size;
        }
        
        if (trackType === 'video' && trackInfo.codec) {
            this.videoTrack = trackInfo;
        } else if (trackType === 'audio' && trackInfo.codec) {
            this.audioTrack = trackInfo;
        }
    }

    _parseTkhd(start, size) {
        const version = this.view.getUint8(start);
        const flags = this.view.getUint32(start) & 0xFFFFFF;
        
        let pos = start + FULL_BOX_HEADER_SIZE;
        
        let creationTime, modificationTime, trackId, duration;
        if (version === 1) {
            creationTime = Number(this.view.getBigUint64(pos));
            modificationTime = Number(this.view.getBigUint64(pos + 8));
            trackId = this.view.getUint32(pos + 16);
            pos += 24;
            duration = Number(this.view.getBigUint64(pos));
            pos += 8;
        } else {
            creationTime = this.view.getUint32(pos);
            modificationTime = this.view.getUint32(pos + 4);
            trackId = this.view.getUint32(pos + 8);
            pos += 16;
            duration = this.view.getUint32(pos);
            pos += 4;
        }
        
        pos += 8;
        
        const width = this.view.getUint16(pos + 48) >> 8;
        const height = this.view.getUint16(pos + 52) >> 8;
        
        return {
            trackId,
            duration,
            width,
            height
        };
    }

    _parseMdia(start, end) {
        let pos = start;
        let type = null;
        let info = {};
        let timescale = 0;
        let mdhdDuration = 0;
        
        while (pos < end) {
            if (pos + BOX_HEADER_SIZE > end) break;
            
            let size = this.view.getUint32(pos);
            let boxType = this._readBoxType(pos + 4);
            let headerSize = BOX_HEADER_SIZE;
            
            if (size === 1) {
                if (pos + 16 > end) break;
                size = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (size === 0) break;
            
            const dataStart = pos + headerSize;
            const dataSize = size - headerSize;
            
            switch (boxType) {
                case 'mdhd':
                    const mdhd = this._parseMdhd(dataStart, dataSize);
                    timescale = mdhd.timescale;
                    mdhdDuration = mdhd.duration;
                    info.timescale = timescale;
                    info.durationSeconds = mdhdDuration / timescale;
                    break;
                case 'hdlr':
                    type = this._parseHdlr(dataStart, dataSize);
                    break;
                case 'stbl':
                    const stblInfo = this._parseStbl(dataStart, dataStart + dataSize, type);
                    info = { ...info, ...stblInfo };
                    break;
                default:
                    break;
            }
            
            pos += size;
        }
        
        if (type) {
            return { type, info };
        }
        return null;
    }

    _parseMdhd(start, size) {
        const version = this.view.getUint8(start);
        let pos = start + FULL_BOX_HEADER_SIZE;
        
        let timescale, duration;
        if (version === 1) {
            pos += 16;
            timescale = this.view.getUint32(pos);
            pos += 4;
            duration = Number(this.view.getBigUint64(pos));
        } else {
            pos += 8;
            timescale = this.view.getUint32(pos);
            pos += 4;
            duration = this.view.getUint32(pos);
        }
        
        return { timescale, duration };
    }

    _parseHdlr(start, size) {
        const handlerType = this._readBoxType(start + 8);
        switch (handlerType) {
            case 'vide': return 'video';
            case 'soun': return 'audio';
            default: return null;
        }
    }

    _parseStbl(start, end, trackType) {
        let pos = start;
        let info = {};
        let samples = null;
        
        while (pos < end) {
            if (pos + BOX_HEADER_SIZE > end) break;
            
            let size = this.view.getUint32(pos);
            let type = this._readBoxType(pos + 4);
            let headerSize = BOX_HEADER_SIZE;
            
            if (size === 1) {
                if (pos + 16 > end) break;
                size = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (size === 0) break;
            
            const dataStart = pos + headerSize;
            const dataSize = size - headerSize;
            
            switch (type) {
                case 'stsd':
                    const stsdInfo = this._parseStsd(dataStart, dataSize, trackType);
                    info = { ...info, ...stsdInfo };
                    break;
                case 'stts':
                    info.timeToSample = this._parseStts(dataStart, dataSize);
                    break;
                case 'stss':
                    info.syncSamples = this._parseStss(dataStart, dataSize);
                    break;
                case 'stsc':
                    info.sampleToChunk = this._parseStsc(dataStart, dataSize);
                    break;
                case 'stsz':
                    info.sampleSizes = this._parseStsz(dataStart, dataSize);
                    break;
                case 'stco':
                    info.chunkOffsets = this._parseStco(dataStart, dataSize);
                    break;
                case 'ctts':
                    info.compositionOffset = this._parseCtts(dataStart, dataSize);
                    break;
                default:
                    break;
            }
            
            pos += size;
        }
        
        return info;
    }

    _parseStsd(start, size, trackType) {
        const version = this.view.getUint8(start);
        const entryCount = this.view.getUint32(start + 4);
        
        let pos = start + 8;
        const result = {};
        
        for (let i = 0; i < entryCount; i++) {
            const entrySize = this.view.getUint32(pos);
            const entryType = this._readBoxType(pos + 4);
            
            if (trackType === 'video') {
                if (entryType === 'avc1' || entryType === 'avc3') {
                    result.codec = 'avc1.' + this._getAvcCodecString(pos + 8, entrySize - 8);
                    result.width = this.view.getUint16(pos + 32);
                    result.height = this.view.getUint16(pos + 34);

                    const avcC = this._findBoxInBox(pos + 8, entrySize - 8, 'avcC');
                    if (avcC) {
                        const buf = new Uint8Array(this.fileBuffer, avcC.offset, avcC.size);
                        result.avcC = buf;
                        result.description = buf;
                    }
                } else if (entryType === 'hvc1' || entryType === 'hev1' || entryType === 'hvc3' || entryType === 'hev3') {
                    // HEVC (H.265) 支持
                    result.codec = entryType;
                    result.width = this.view.getUint16(pos + 32);
                    result.height = this.view.getUint16(pos + 34);

                    const hvcC = this._findBoxInBox(pos + 8, entrySize - 8, 'hvcC');
                    if (hvcC) {
                        const buf = new Uint8Array(this.fileBuffer, hvcC.offset, hvcC.size);
                        result.hvcC = buf;
                        result.description = buf;
                    }
                }
            } else if (trackType === 'audio') {
                if (entryType === 'mp4a') {
                    result.codec = 'mp4a.40.2';
                    result.channels = this.view.getUint16(pos + 24);
                    const sampleRateFixed = this.view.getUint32(pos + 32);
                    result.sampleRate = sampleRateFixed >> 16;
                    
                    const esds = this._findBoxInBox(pos + 8, entrySize - 8, 'esds');
                    if (esds) {
                        result.esds = new Uint8Array(this.fileBuffer, esds.offset, esds.size);
                    }
                }
            }
            
            pos += entrySize;
        }
        
        return result;
    }

    _getAvcCodecString(start, size) {
        const avcC = this._findBoxInBox(start, size, 'avcC');
        if (!avcC) return '42001e';
        
        const pos = avcC.offset;
        const profile = this.view.getUint8(pos + 1).toString(16).padStart(2, '0');
        const profileCompat = this.view.getUint8(pos + 2).toString(16).padStart(2, '0');
        const level = this.view.getUint8(pos + 3).toString(16).padStart(2, '0');
        
        return profile + profileCompat + level;
    }

    _findBoxInBox(start, size, targetType) {
        let pos = start;
        const end = start + size;
        
        while (pos < end) {
            if (pos + BOX_HEADER_SIZE > end) break;
            
            let boxSize = this.view.getUint32(pos);
            let boxType = this._readBoxType(pos + 4);
            let headerSize = BOX_HEADER_SIZE;
            
            if (boxSize === 1) {
                if (pos + 16 > end) break;
                boxSize = Number(this.view.getBigUint64(pos + 8));
                headerSize = 16;
            }
            
            if (boxSize === 0) break;
            
            if (boxType === targetType) {
                return { offset: pos + headerSize, size: boxSize - headerSize };
            }
            
            pos += boxSize;
        }
        
        return null;
    }

    _parseStts(start, size) {
        const entryCount = this.view.getUint32(start + 4);
        const entries = [];
        let pos = start + 8;
        
        for (let i = 0; i < entryCount; i++) {
            entries.push({
                count: this.view.getUint32(pos),
                duration: this.view.getUint32(pos + 4)
            });
            pos += 8;
        }
        
        return entries;
    }

    _parseStss(start, size) {
        const entryCount = this.view.getUint32(start + 4);
        const entries = [];
        let pos = start + 8;
        
        for (let i = 0; i < entryCount; i++) {
            entries.push(this.view.getUint32(pos));
            pos += 4;
        }
        
        return entries;
    }

    _parseStsc(start, size) {
        const entryCount = this.view.getUint32(start + 4);
        const entries = [];
        let pos = start + 8;
        
        for (let i = 0; i < entryCount; i++) {
            entries.push({
                firstChunk: this.view.getUint32(pos),
                samplesPerChunk: this.view.getUint32(pos + 4),
                sampleDescriptionIndex: this.view.getUint32(pos + 8)
            });
            pos += 12;
        }
        
        return entries;
    }

    _parseStsz(start, size) {
        const sampleSize = this.view.getUint32(start + 4);
        const sampleCount = this.view.getUint32(start + 8);
        let pos = start + 12;
        
        if (sampleSize > 0) {
            return { sampleSize, sampleCount, sizes: null };
        }
        
        const sizes = [];
        for (let i = 0; i < sampleCount; i++) {
            sizes.push(this.view.getUint32(pos));
            pos += 4;
        }
        
        return { sampleSize: 0, sampleCount, sizes };
    }

    _parseStco(start, size) {
        const entryCount = this.view.getUint32(start + 4);
        const offsets = [];
        let pos = start + 8;
        
        for (let i = 0; i < entryCount; i++) {
            offsets.push(this.view.getUint32(pos));
            pos += 4;
        }
        
        return offsets;
    }

    _parseCtts(start, size) {
        const version = this.view.getUint8(start);
        const entryCount = this.view.getUint32(start + 4);
        const entries = [];
        let pos = start + 8;
        
        for (let i = 0; i < entryCount; i++) {
            entries.push({
                count: this.view.getUint32(pos),
                offset: version === 0 
                    ? this.view.getUint32(pos + 4)
                    : this.view.getInt32(pos + 4)
            });
            pos += 8;
        }
        
        return entries;
    }

    _buildSampleTables() {
        if (this.videoTrack) {
            this.videoSamples = this._buildSamples(this.videoTrack, 'video');
        }
        if (this.audioTrack) {
            this.audioSamples = this._buildSamples(this.audioTrack, 'audio');
        }
    }

    _buildSamples(track, type) {
        const samples = [];
        const timescale = track.timescale || 1000;
        const timeToSample = track.timeToSample || [];
        const sampleSizes = track.sampleSizes || { sampleSize: 0, sampleCount: 0, sizes: null };
        const sampleToChunk = track.sampleToChunk || [];
        const chunkOffsets = track.chunkOffsets || [];
        const syncSamples = track.syncSamples || [];
        const compositionOffset = track.compositionOffset || [];
        
        let sampleCount = sampleSizes.sampleCount;
        if (sampleCount === 0) return samples;
        
        let dtsAccum = 0;
        let sampleIndex = 0;
        let chunkIndex = 0;
        let sampleInChunk = 0;
        let stscIndex = 0;
        let samplesPerChunk = sampleToChunk[0]?.samplesPerChunk || 1;
        let currentChunkOffset = chunkOffsets[0] || 0;
        let chunkOffsetInChunk = 0;
        
        const syncSet = new Set(syncSamples);
        
        const ctsOffsets = [];
        if (compositionOffset.length > 0) {
            for (const entry of compositionOffset) {
                for (let i = 0; i < entry.count; i++) {
                    ctsOffsets.push(entry.offset);
                }
            }
        }
        
        for (const sttsEntry of timeToSample) {
            for (let i = 0; i < sttsEntry.count; i++) {
                if (sampleIndex >= sampleCount) break;
                
                const size = sampleSizes.sizes 
                    ? sampleSizes.sizes[sampleIndex] 
                    : sampleSizes.sampleSize;
                
                const dtsUs = Math.floor(dtsAccum * 1000000 / timescale);
                const durationUs = Math.floor(sttsEntry.duration * 1000000 / timescale);
                const ctsOffset = ctsOffsets[sampleIndex] || 0;
                const ctsUs = dtsUs + Math.floor(ctsOffset * 1000000 / timescale);
                
                const sample = {
                    index: sampleIndex,
                    size: size,
                    dtsUs: dtsUs,
                    ctsUs: ctsUs,
                    durationUs: durationUs,
                    isKeyframe: type === 'audio' ? false : syncSet.has(sampleIndex + 1),
                    offset: currentChunkOffset + chunkOffsetInChunk
                };
                
                samples.push(sample);
                
                chunkOffsetInChunk += size;
                sampleInChunk++;
                
                if (sampleInChunk >= samplesPerChunk) {
                    chunkIndex++;
                    if (chunkIndex < chunkOffsets.length) {
                        currentChunkOffset = chunkOffsets[chunkIndex];
                    }
                    chunkOffsetInChunk = 0;
                    sampleInChunk = 0;
                    
                    if (stscIndex < sampleToChunk.length - 1) {
                        const nextEntry = sampleToChunk[stscIndex + 1];
                        if (chunkIndex + 1 >= nextEntry.firstChunk) {
                            stscIndex++;
                            samplesPerChunk = nextEntry.samplesPerChunk;
                        }
                    }
                }
                
                dtsAccum += sttsEntry.duration;
                sampleIndex++;
            }
        }
        
        return samples;
    }

    _createVideoChunk(sample) {
        let data;
        
        if (sample.data) {
            data = sample.data;
        } else if (this._mdatOffset) {
            data = new Uint8Array(this.fileBuffer, sample.offset, sample.size);
        } else {
            return null;
        }
        
        const type = sample.isKeyframe ? 'key' : 'delta';
        
        return new EncodedVideoChunk({
            type: type,
            timestamp: sample.ctsUs,
            duration: sample.durationUs,
            data: data
        });
    }

    _createAudioChunk(sample) {
        let data;
        
        if (sample.data) {
            data = sample.data;
        } else if (this._mdatOffset) {
            data = new Uint8Array(this.fileBuffer, sample.offset, sample.size);
        } else {
            return null;
        }
        
        return new EncodedAudioChunk({
            type: 'key',
            timestamp: sample.ctsUs,
            duration: sample.durationUs,
            data: data
        });
    }

    _readBoxType(offset) {
        return String.fromCharCode(
            this.view.getUint8(offset),
            this.view.getUint8(offset + 1),
            this.view.getUint8(offset + 2),
            this.view.getUint8(offset + 3)
        );
    }

    async decodeAudioToPCM(startSec = 0, durationSec = Infinity) {
        if (!this.audioTrack || this.audioSamples.length === 0) {
            throw new Error('No audio track');
        }

        const audioConfig = this.getAudioConfig();
        if (!audioConfig) throw new Error('No audio config');
        if (audioConfig.codec === 'mp4a' || audioConfig.codec === 'mp4a.40' || !audioConfig.codec.includes('.')) {
            audioConfig.codec = 'mp4a.40.2';
        }

        const support = await AudioDecoder.isConfigSupported(audioConfig);
        if (!support.supported) throw new Error('Audio config not supported: ' + audioConfig.codec);

        // 计算需要解码的样本范围（按时间过滤，避免全量解码导致内存爆炸）
        const startUs = startSec * 1000000;
        const endUs = (startSec + durationSec) * 1000000;
        const samples = this.audioSamples;
        let startIdx = 0;
        let endIdx = samples.length;
        for (let i = 0; i < samples.length; i++) {
            if (samples[i].ctsUs >= startUs) { startIdx = i; break; }
        }
        for (let i = startIdx; i < samples.length; i++) {
            if (samples[i].ctsUs >= endUs) { endIdx = i; break; }
        }
        const decodeCount = endIdx - startIdx;
        console.log(`[MP4Demuxer] 音频解码范围: ${startIdx}-${endIdx} (${decodeCount}/${samples.length}), ${startSec.toFixed(1)}s+${durationSec.toFixed(1)}s`);

        const sampleRate = this.audioTrack.sampleRate || 44100;
        const numChannels = this.audioTrack.channels || 2;

        // 预分配输出缓冲区（避免动态扩展和二次拷贝）
        const estimatedFrames = Math.ceil(durationSec * sampleRate) + sampleRate;
        const left = new Float32Array(estimatedFrames);
        const right = numChannels > 1 ? new Float32Array(estimatedFrames) : left;
        let writeOffset = 0;

        let decodeError = null;

        const decoder = new AudioDecoder({
            output: (frame) => {
                try {
                    const nf = frame.numberOfFrames;
                    const copyNf = Math.min(nf, left.length - writeOffset);
                    if (copyNf > 0) {
                        const tmp = new Float32Array(copyNf);
                        frame.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
                        left.set(tmp, writeOffset);
                        if (numChannels > 1) {
                            const tmp2 = new Float32Array(copyNf);
                            frame.copyTo(tmp2, { planeIndex: 1, format: 'f32-planar' });
                            right.set(tmp2, writeOffset);
                        }
                    }
                    writeOffset += nf;
                } catch (e) {
                    // 忽略单帧错误
                } finally {
                    // 立即关闭，防止内存积压
                    try { frame.close(); } catch (_) {}
                }
            },
            error: (e) => { decodeError = e; }
        });
        decoder.configure(audioConfig);

        // 先批量读取所有 chunk，再连续解码（避免异步读取打乱解码节奏导致浏览器崩溃）
        const chunks = [];
        for (let i = startIdx; i < endIdx; i++) {
            const chunk = await this.getAudioChunk(i);
            if (chunk) chunks.push(chunk);
            if (this._aborted) break;
        }

        // 连续解码（无 await 打断，保持解码节奏稳定）
        for (let i = 0; i < chunks.length && !decodeError; i++) {
            try {
                decoder.decode(chunks[i]);
            } catch (e) {
                // 忽略单帧解码错误
            }
        }

        // 等待所有解码完成
        while (decoder.decodeQueueSize > 0) {
            await new Promise(r => setTimeout(r, 5));
        }
        await decoder.flush();
        decoder.close();

        // 解码完成后释放本段音频样本的 data，防止大文件内存累积
        for (let i = startIdx; i < endIdx; i++) {
            if (this.audioSamples[i] && this.audioSamples[i].data) {
                this.audioSamples[i].data = null;
            }
        }

        if (decodeError) throw new Error('Audio decode error: ' + decodeError.message);
        if (writeOffset === 0) throw new Error('No decoded audio');

        // 截取实际使用的长度
        const finalLeft = left.subarray(0, writeOffset);
        const finalRight = numChannels > 1 ? right.subarray(0, writeOffset) : finalLeft;

        const actualDuration = writeOffset / sampleRate;
        return { left: finalLeft, right: finalRight, sampleRate, channels: numChannels, duration: actualDuration };
    }
}

window.MP4Demuxer = MP4Demuxer;
