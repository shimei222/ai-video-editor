/**
 * MP4 Muxer - Light
 * 支持: H.264 + AAC
 * 用法：
 *   const muxer = new MP4Muxer({ width: 1920, height: 1080, fps: 30, sampleRate: 48000, channels: 2 });
 *   muxer.addVideoChunk(encodedVideoChunk, meta);
 *   muxer.addAudioChunk(encodedAudioChunk, meta);
 *   const buffer = muxer.finalize(); // Uint8Array
 */
(function(global) {
    'use strict';

    class MP4Muxer {
        constructor(opts = {}) {
            this.width = opts.width || 1920;
            this.height = opts.height || 1080;
            this.fps = opts.fps || 30;
            this.sampleRate = opts.sampleRate || 48000;
            this.channels = opts.channels || 2;

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

            const b = new Writer();

            // ftyp
            b.box('ftyp', () => {
                b.u32(0x69736F35); // isom
                b.u32(0); // minor version
                b.u32(0x69736F35); // isom
                b.u32(0x69736F6D); // isom
                b.u32(0x61766331); // avc1
                b.u32(0x6D703431); // mp41
            });

            // mdat
            const mdatStart = b.pos;
            b.skip(8);
            const mdatDataStart = b.pos;

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
            b.u32(0x6D646174); // 'mdat'
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
                // mvhd
                b.box('mvhd', () => {
                    b.u32(0); // version + flags
                    b.u32(0); b.u32(0); // creation / mod time
                    b.u32(MOVIE_TS); // timescale
                    b.u32(movieDurScaled); // duration
                    b.u32(0x00010000); // rate 1.0
                    b.u16(0x0100); // volume 1.0
                    b.u16(0); // reserved
                    b.u32(0); b.u32(0); // reserved
                    // matrix (unity)
                    b.u32(0x00010000); b.u32(0); b.u32(0);
                    b.u32(0); b.u32(0x00010000); b.u32(0);
                    b.u32(0); b.u32(0); b.u32(0x40000000);
                    for (let i = 0; i < 6; i++) b.u32(0); // pre-defined
                    b.u32(aLen > 0 ? 3 : 2); // next track id
                });

                // video trak
                if (vLen > 0) {
                    this._writeVideoTrack(b, v, vOffsets, VIDEO_TS, 1);
                }

                // audio trak
                if (aLen > 0) {
                    this._writeAudioTrack(b, a, aOffsets, VIDEO_TS, 2);
                }
            });

            return b.slice();
        }

        _writeVideoTrack(b, chunks, offsets, ts, trackId) {
            const len = chunks.length;
            const dur = len > 0 ? chunks[len - 1].timestamp + chunks[len - 1].duration : 0;

            b.box('trak', () => {
                // tkhd
                b.box('tkhd', () => {
                    b.u32(0x0000000F); // version + flags (enabled+in movie+in preview)
                    b.u32(0); b.u32(0);
                    b.u32(trackId);
                    b.u32(0); // reserved
                    b.u32(dur);
                    b.u32(0); b.u32(0); // reserved
                    b.u16(0); // layer
                    b.u16(0); // alternate group
                    b.u16(0); // volume
                    b.u16(0); // reserved
                    // matrix
                    b.u32(0x00010000); b.u32(0); b.u32(0);
                    b.u32(0); b.u32(0x00010000); b.u32(0);
                    b.u32(0); b.u32(0); b.u32(0x40000000);
                    b.u32(this.width << 16);
                    b.u32(this.height << 16);
                });

                b.box('mdia', () => {
                    // mdhd
                    b.box('mdhd', () => {
                        b.u32(0);
                        b.u32(0); b.u32(0);
                        b.u32(ts);
                        b.u32(dur);
                        b.u16(0x55C4); // language: und
                        b.u16(0); // quality
                    });

                    // hdlr
                    b.box('hdlr', () => {
                        b.u32(0); // version + flags
                        b.u32(0); // handler type (mhlr)
                        b.u32(0x76696465); // 'vide'
                        b.u32(0); b.u32(0); b.u32(0); // reserved
                        b.u8(0); // name (empty)
                    });

                    b.box('minf', () => {
                        // vmhd
                        b.box('vmhd', () => {
                            b.u32(0x00000001); // version + flags
                            b.u16(0); // graphics mode
                            b.u16(0); b.u16(0); b.u16(0); // opcolor
                        });

                        // dinf
                        b.box('dinf', () => {
                            b.box('dref', () => {
                                b.u32(0); // version + flags
                                b.u32(1); // entry count
                                b.box('url ', () => {
                                    b.u32(0x00000001); // version + flags (self-contained)
                                });
                            });
                        });

                        // stbl
                        b.box('stbl', () => {
                            // stsd
                            b.box('stsd', () => {
                                b.u32(0); // version + flags
                                b.u32(1); // entry count

                                // avc1
                                b.box('avc1', () => {
                                    // SampleEntry
                                    b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); // reserved(6)
                                    b.u16(1); // data_reference_index

                                    // VisualSampleEntry
                                    b.u16(0); // pre-defined
                                    b.u16(0); // reserved
                                    b.u32(0); b.u32(0); b.u32(0); // pre-defined(3)
                                    b.u16(this.width);
                                    b.u16(this.height);
                                    b.u32(0x00480000); // horizresolution: 72 dpi
                                    b.u32(0x00480000); // vertresolution
                                    b.u32(0); // reserved
                                    b.u16(1); // frame_count
                                    // compressorname (32 bytes, empty)
                                    for (let i = 0; i < 32; i++) b.u8(0);
                                    b.u16(0x0018); // depth: 24 bits
                                    b.s16(-1); // pre-defined

                                    // avcC
                                    const avcDesc = this.videoMeta?.decoderConfig?.description;
                                    if (avcDesc) {
                                        b.box('avcC', () => {
                                            b.bytes(new Uint8Array(avcDesc));
                                        });
                                    }
                                });
                            });

                            // stts
                            b.box('stts', () => {
                                b.u32(0);
                                const entries = this._sttsEntries(chunks);
                                b.u32(entries.length);
                                for (const e of entries) { b.u32(e.count); b.u32(e.delta); }
                            });

                            // stsc
                            b.box('stsc', () => {
                                b.u32(0);
                                b.u32(1);
                                b.u32(1); b.u32(1); b.u32(1);
                            });

                            // stsz
                            b.box('stsz', () => {
                                b.u32(0);
                                b.u32(0); // variable sizes
                                b.u32(len);
                                for (const c of chunks) b.u32(c.data.byteLength);
                            });

                            // stco
                            b.box('stco', () => {
                                b.u32(0);
                                b.u32(len);
                                for (const off of offsets) b.u32(off);
                            });

                            // stss (keyframes)
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
                // tkhd
                b.box('tkhd', () => {
                    b.u32(0x0000000F);
                    b.u32(0); b.u32(0);
                    b.u32(trackId);
                    b.u32(0);
                    b.u32(dur);
                    b.u32(0); b.u32(0);
                    b.u16(0); // layer
                    b.u16(0); // alternate group
                    b.u16(0x0100); // volume 1.0
                    b.u16(0); // reserved
                    // matrix
                    b.u32(0x00010000); b.u32(0); b.u32(0);
                    b.u32(0); b.u32(0x00010000); b.u32(0);
                    b.u32(0); b.u32(0); b.u32(0x40000000);
                    b.u32(0); b.u32(0);
                });

                b.box('mdia', () => {
                    // mdhd
                    b.box('mdhd', () => {
                        b.u32(0);
                        b.u32(0); b.u32(0);
                        b.u32(ts);
                        b.u32(dur);
                        b.u16(0x55C4);
                        b.u16(0);
                    });

                    // hdlr
                    b.box('hdlr', () => {
                        b.u32(0);
                        b.u32(0);
                        b.u32(0x736F756E); // 'soun'
                        b.u32(0); b.u32(0); b.u32(0);
                        b.u8(0);
                    });

                    b.box('minf', () => {
                        // smhd
                        b.box('smhd', () => {
                            b.u32(0);
                            b.u16(0); // balance
                            b.u16(0); // reserved
                        });

                        // dinf
                        b.box('dinf', () => {
                            b.box('dref', () => {
                                b.u32(0);
                                b.u32(1);
                                b.box('url ', () => b.u32(1));
                            });
                        });

                        // stbl
                        b.box('stbl', () => {
                            // stsd
                            b.box('stsd', () => {
                                b.u32(0);
                                b.u32(1);

                                // mp4a
                                b.box('mp4a', () => {
                                    // SampleEntry
                                    b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); b.u8(0); // reserved(6)
                                    b.u16(1); // data_ref_index

                                    // AudioSampleEntry
                                    b.u16(0); // version
                                    b.u16(0); // revision level
                                    b.u32(0); // vendor
                                    b.u16(this.channels);
                                    b.u16(16); // sample size
                                    b.u16(0); // compression id
                                    b.u16(0); // packet size
                                    b.u32(this.sampleRate << 16);

                                    // esds
                                    const aacDesc = this.audioMeta?.decoderConfig?.description;
                                    b.box('esds', () => {
                                        b.u32(0); // version+flags

                                        const aacSpecificData = aacDesc 
                                            ? new Uint8Array(aacDesc) 
                                            : new Uint8Array([0x11, 0x90]); // 48kHz stereo LC

                                        // DecoderSpecificInfo size
                                        const dsiSize = aacSpecificData.length;
                                        
                                        // DecoderConfigDescriptor size: 13 bytes + DSI(2 + dsiSize)
                                        // objectTypeIndication(1) + streamType+upStream+reserved(1) + bufferSizeDB(3) + maxBitrate(4) + avgBitrate(4) = 13
                                        // plus DecoderSpecificInfo: tag(1) + length(1) + data(dsiSize)
                                        const decCfgSize = 13 + 2 + dsiSize;
                                        
                                        // ES_Descriptor size: ES_ID(2) + flags(1) + DecoderConfigDescriptor(2 + decCfgSize) + SLConfigDescriptor(3)
                                        // SLConfigDescriptor: tag(1) + length(1) + predefined(1) = 3
                                        const esSize = 2 + 1 + (2 + decCfgSize) + 3;

                                        // ES_Descriptor
                                        b.u8(0x03); // ES_DescrTag
                                        b.u8(esSize); // length
                                        b.u16(trackId); // ES_ID
                                        b.u8(0); // streamDependenceFlag | URL_Flag | OCRstreamFlag | streamPriority

                                        // DecoderConfigDescriptor
                                        b.u8(0x04); // DecoderConfigDescrTag
                                        b.u8(decCfgSize); // length
                                        b.u8(0x40); // objectTypeIndication: Audio ISO/IEC 14496-3
                                        b.u8(0x14); // streamType(5) << 2 | upStream(0) << 1 | reserved(0) = 0x14
                                        b.u24(0); // bufferSizeDB
                                        b.u32(0); // maxBitrate
                                        b.u32(0); // avgBitrate

                                        // DecoderSpecificInfo
                                        b.u8(0x05); // DecoderSpecificInfoTag
                                        b.u8(dsiSize); // length
                                        b.bytes(aacSpecificData);

                                        // SLConfigDescriptor
                                        b.u8(0x06); // SLConfigDescrTag
                                        b.u8(0x01); // length
                                        b.u8(0x02); // predefined: MP4
                                    });
                            });

                            // stts
                            b.box('stts', () => {
                                b.u32(0);
                                const entries = this._sttsEntries(chunks);
                                b.u32(entries.length);
                                for (const e of entries) { b.u32(e.count); b.u32(e.delta); }
                            });

                            // stsc
                            b.box('stsc', () => {
                                b.u32(0);
                                b.u32(1);
                                b.u32(1); b.u32(1); b.u32(1);
                            });

                            // stsz
                            b.box('stsz', () => {
                                b.u32(0);
                                b.u32(0);
                                b.u32(len);
                                for (const c of chunks) b.u32(c.data.byteLength);
                            });

                            // stco
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

    class Writer {
        constructor(size = 4 * 1024 * 1024) {
            this.buf = new Uint8Array(size);
            this.view = new DataView(this.buf.buffer);
            this.pos = 0;
            this._boxStack = [];
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
            this.skip(8); // size + type
            fn();
            const end = this.pos;
            const size = end - start;
            const saved = this.pos;
            this.pos = start;
            this.u32(size);
            // type string
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

    global.MP4Muxer = MP4Muxer;
    global.MP4Writer = Writer;

})(typeof window !== 'undefined' ? window : globalThis);
