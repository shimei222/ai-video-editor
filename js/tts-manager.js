/**
 * TTS 语音合成管理器
 * 支持多种提供商：Web Speech API（免费预览）、Edge TTS（免费高质量）、微软 Azure Speech（高质量 MP3 导出）
 * Edge TTS 支持两种方式：
 *   1. 通过本地Node.js后端中转（推荐，稳定可靠）
 *   2. 直接WebSocket连接（可能在某些浏览器被阻止）
 */
class TTSManager {
    constructor() {
        // 后端服务器地址
        // 优先从环境变量读取，用于线上部署1111
        const envUrl = window.TTS_SERVER_URL || '';
        this.localServerUrl = envUrl || 'https://tts-api-nfjqrzits.cn-hongkong.fcapp.run';
        this.remoteServerUrl = this.localServerUrl;
        
        // 自动检测后端服务器是否可用
        this._serverAvailable = false;
        this._checkServerAvailable();

        this.providers = {
            webspeech: {
                name: '浏览器原生（免费）',
                voices: [],
                supportsExport: false
            },
            edgetts: {
                name: 'Edge TTS（免费高质量）',
                voices: [],
                supportsExport: true
            },
            azure: {
                name: '微软 Azure',
                voices: [],
                supportsExport: true
            }
        };
        this.currentProvider = 'webspeech'; // 默认使用浏览器原生语音
        this.azureKey = '';
        this.azureRegion = 'eastasia';
        this._speechSDKLoaded = false;
        this._initWebSpeechVoices();
        this._initEdgeTTSVoices();
        this._loadFromStorage();
        this._loadVoicesFromServer();
    }
    
    // 生成 RFC 1123 格式的 Date 头部
    _getDateHeader() {
        return new Date().toUTCString();
    }

    // 检测后端服务器是否可用
    async _checkServerAvailable() {
        const servers = [this.localServerUrl, this.remoteServerUrl];
        for (const serverUrl of servers) {
            try {
                const response = await fetch(`${serverUrl}/api/voices`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(3000),
                    headers: {
                        'Date': this._getDateHeader()
                    }
                });
                if (response.ok) {
                    this._serverAvailable = true;
                    this.localServerUrl = serverUrl; // 使用可用的服务器地址
                    this.currentProvider = 'edgetts';
                    console.log('[TTS] 后端服务器可用:', serverUrl);
                    return;
                }
            } catch (e) {
                console.log('[TTS] 服务器不可用:', serverUrl);
            }
        }
        this._serverAvailable = false;
        console.log('[TTS] 所有后端服务器都不可用，使用浏览器原生语音');
    }

    _loadFromStorage() {
        try {
            const saved = localStorage.getItem('tts_config');
            if (saved) {
                const cfg = JSON.parse(saved);
                this.currentProvider = cfg.provider || 'webspeech';
                this.azureKey = cfg.azureKey || '';
                this.azureRegion = cfg.azureRegion || 'eastasia';
            }
        } catch (e) {
            console.warn('[TTS] 读取配置失败:', e);
        }
    }

    _saveToStorage() {
        try {
            localStorage.setItem('tts_config', JSON.stringify({
                provider: this.currentProvider,
                azureKey: this.azureKey,
                azureRegion: this.azureRegion
            }));
        } catch (e) {
            console.warn('[TTS] 保存配置失败:', e);
        }
    }

    setProvider(provider) {
        this.currentProvider = provider;
        this._saveToStorage();
    }

    setAzureConfig(key, region) {
        this.azureKey = key;
        this.azureRegion = region || 'eastasia';
        this._saveToStorage();
    }

    _initWebSpeechVoices() {
        if (!('speechSynthesis' in window)) {
            console.warn('[TTS] 浏览器不支持 Web Speech API');
            return;
        }

        this._webSpeechReady = false;

        const loadVoices = () => {
            const voices = speechSynthesis.getVoices();
            this.providers.webspeech.voices = voices.map((v, i) => ({
                id: v.name,
                name: v.name + ' (' + v.lang + ')',
                lang: v.lang,
                gender: v.default ? '默认' : ''
            }));
            if (voices.length > 0) {
                this._webSpeechReady = true;
            }
        };

        loadVoices();
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.addEventListener('voiceschanged', loadVoices);
        }

        setTimeout(() => {
            if (!this._webSpeechReady) {
                const voices = speechSynthesis.getVoices();
                if (voices.length > 0) {
                    loadVoices();
                }
            }
        }, 1000);
    }

    async _loadVoicesFromServer(force = false) {
        if (!force && (this._voicesLoading || this._voicesLoaded)) return;
        if (this._voicesLoading) return;
        this._voicesLoading = true;
        try {
            const response = await fetch(`${this.localServerUrl}/api/voices`, {
                headers: {
                    'Date': this._getDateHeader()
                }
            });
            if (!response.ok) throw new Error('获取音色列表失败');
            const data = await response.json();
            if (data.voices && Array.isArray(data.voices) && data.voices.length > 0) {
                const voices = data.voices.map(v => ({
                    id: v.Name || v.ShortName,
                    name: `${v.FriendlyName || v.DisplayName}（${v.Gender === 'Female' ? '女' : '男'}声）`,
                    lang: v.Locale,
                    gender: v.Gender === 'Female' ? '女' : '男'
                }));
                voices.sort((a, b) => {
                    const aZH = a.lang.startsWith('zh-CN');
                    const bZH = b.lang.startsWith('zh-CN');
                    if (aZH && !bZH) return -1;
                    if (!aZH && bZH) return 1;
                    const aHK = a.lang.startsWith('zh-HK');
                    const bHK = b.lang.startsWith('zh-HK');
                    if (aHK && !bHK) return -1;
                    if (!aHK && bHK) return 1;
                    const aTW = a.lang.startsWith('zh-TW');
                    const bTW = b.lang.startsWith('zh-TW');
                    if (aTW && !bTW) return -1;
                    if (!aTW && bTW) return 1;
                    return a.name.localeCompare(b.name);
                });
                this.providers.edgetts.voices = voices;
                this._voicesLoaded = true;
                console.log('[TTS] 从后端加载音色列表成功，共', voices.length, '个音色');
                if (typeof window !== 'undefined' && window.editor && typeof window.editor.updateTtsVoiceSelect === 'function') {
                    window.editor.updateTtsVoiceSelect();
                }
            }
        } catch (e) {
            console.warn('[TTS] 从后端加载音色列表失败，使用默认列表:', e.message);
        } finally {
            this._voicesLoading = false;
        }
    }

    _initEdgeTTSVoices() {
        this.providers.edgetts.voices = [
            { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunxiNeural', name: '云希（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-YunjianNeural', name: '云健（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunyangNeural', name: '云扬（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-XiaohanNeural', name: '晓涵（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaomengNeural', name: '晓梦（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaochenNeural', name: '晓晨（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaoyanNeural', name: '晓颜（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunzeNeural', name: '云泽（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-HK-HiuMaanNeural', name: '曉曼（粤语女声）', lang: 'zh-HK', gender: '女' },
            { id: 'zh-HK-WanLungNeural', name: '雲龍（粤语男声）', lang: 'zh-HK', gender: '男' },
            { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（粤语女声）', lang: 'zh-HK', gender: '女' },
            { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台语女声）', lang: 'zh-TW', gender: '女' },
            { id: 'zh-TW-YunJheNeural', name: '雲哲（台语男声）', lang: 'zh-TW', gender: '男' },
            { id: 'zh-TW-HsiaoYuNeural', name: '曉雨（台语女声）', lang: 'zh-TW', gender: '女' },
            { id: 'en-US-JennyNeural', name: 'Jenny (English)', lang: 'en-US', gender: '女' },
            { id: 'en-US-GuyNeural', name: 'Guy (English)', lang: 'en-US', gender: '男' },
            { id: 'en-US-SaraNeural', name: 'Sara (English)', lang: 'en-US', gender: '女' },
            { id: 'en-US-RogerNeural', name: 'Roger (English)', lang: 'en-US', gender: '男' },
            { id: 'en-US-AriaNeural', name: 'Aria (English)', lang: 'en-US', gender: '女' },
            { id: 'ja-JP-NanamiNeural', name: '奈々美（日语女声）', lang: 'ja-JP', gender: '女' },
            { id: 'ja-JP-KeitaNeural', name: '慶太（日语男声）', lang: 'ja-JP', gender: '男' },
            { id: 'ko-KR-SunHiNeural', name: '선희（韩语女声）', lang: 'ko-KR', gender: '女' },
            { id: 'ko-KR-InJoonNeural', name: '인준（韩语男声）', lang: 'ko-KR', gender: '男' },
            { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓贝（东北话女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西话女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-henan-YundengNeural', name: '云登（河南话男声）', lang: 'zh-CN', gender: '男' }
        ];
    }

    getVoices(provider) {
        const p = provider || this.currentProvider;
        if (p === 'webspeech') {
            return this.providers.webspeech.voices;
        } else if (p === 'edgetts') {
            return this.providers.edgetts.voices;
        } else if (p === 'azure') {
            return this._getAzureVoices();
        }
        return [];
    }

    _getAzureVoices() {
        return [
            { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunxiNeural', name: '云希（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-YunjianNeural', name: '云健（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunyangNeural', name: '云扬（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-XiaohanNeural', name: '晓涵（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaomengNeural', name: '晓梦（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaochenNeural', name: '晓晨（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaoyanNeural', name: '晓颜（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaoyunNeural', name: '晓云（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-XiaoxuanNeural', name: '晓萱（女声）', lang: 'zh-CN', gender: '女' },
            { id: 'zh-CN-YunfengNeural', name: '云锋（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-YunlongNeural', name: '云龙（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-CN-YunzeNeural', name: '云泽（男声）', lang: 'zh-CN', gender: '男' },
            { id: 'zh-HK-HiuMaanNeural', name: '曉曼（粤语女声）', lang: 'zh-HK', gender: '女' },
            { id: 'zh-HK-WanLungNeural', name: '雲龍（粤语男声）', lang: 'zh-HK', gender: '男' },
            { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台语女声）', lang: 'zh-TW', gender: '女' },
            { id: 'zh-TW-YunJheNeural', name: '雲哲（台语男声）', lang: 'zh-TW', gender: '男' },
            { id: 'en-US-JennyNeural', name: 'Jenny (English)', lang: 'en-US', gender: '女' },
            { id: 'en-US-GuyNeural', name: 'Guy (English)', lang: 'en-US', gender: '男' },
            { id: 'en-US-SaraNeural', name: 'Sara (English)', lang: 'en-US', gender: '女' },
            { id: 'en-US-RogerNeural', name: 'Roger (English)', lang: 'en-US', gender: '男' },
            { id: 'ja-JP-NanamiNeural', name: '奈々美（日语女声）', lang: 'ja-JP', gender: '女' },
            { id: 'ja-JP-KeitaNeural', name: '慶太（日语男声）', lang: 'ja-JP', gender: '男' },
            { id: 'ko-KR-SunHiNeural', name: '선희（韩语女声）', lang: 'ko-KR', gender: '女' },
            { id: 'ko-KR-InJoonNeural', name: '인준（韩语男声）', lang: 'ko-KR', gender: '男' }
        ];
    }

    /**
     * 朗读文本（用于预览）
     */
    speak(text, options = {}) {
        const { voice, rate = 1, pitch = 1, volume = 1 } = options;

        if (this.currentProvider === 'webspeech') {
            return this._speakWebSpeech(text, { voice, rate, pitch, volume });
        } else if (this.currentProvider === 'edgetts') {
            return this._speakEdgeTTS(text, { voice, rate, pitch, volume });
        } else if (this.currentProvider === 'azure') {
            return this._speakAzure(text, { voice, rate, pitch, volume });
        }
        return Promise.resolve();
    }

    stop() {
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        // 停止当前正在播放的EdgeTTS音频
        if (this._currentAudio) {
            this._currentAudio.pause();
            this._currentAudio = null;
        }
    }

    _speakWebSpeech(text, options) {
        return new Promise((resolve, reject) => {
            if (!('speechSynthesis' in window)) {
                reject(new Error('浏览器不支持语音合成'));
                return;
            }

            if (!text || !text.trim()) {
                reject(new Error('文本内容为空'));
                return;
            }

            try {
                speechSynthesis.cancel();
            } catch (e) {
                console.warn('[TTS] cancel failed:', e);
            }

            try {
                const utterance = new SpeechSynthesisUtterance(text);
                if (options.voice) {
                    const voices = speechSynthesis.getVoices();
                    const v = voices.find(v => v.name === options.voice);
                    if (v) utterance.voice = v;
                }
                utterance.rate = options.rate || 1;
                utterance.pitch = options.pitch || 1;
                utterance.volume = options.volume || 1;
                utterance.lang = 'zh-CN';

                utterance.onend = () => resolve();
                utterance.onerror = (e) => {
                    console.error('[TTS] Web Speech error:', e);
                    reject(e.error || e);
                };

                speechSynthesis.speak(utterance);
            } catch (e) {
                reject(e);
            }
        });
    }

    async _speakAzure(text, options) {
        if (!this.azureKey) {
            throw new Error('请先配置 Azure 语音 API Key');
        }

        if (!text || !text.trim()) {
            throw new Error('文本内容为空');
        }

        try {
            const audioBlob = await this._synthesizeAzure(text, options);
            const url = URL.createObjectURL(audioBlob);
            const audio = new Audio();
            audio.src = url;
            audio.preload = 'auto';

            return new Promise((resolve, reject) => {
                audio.onended = () => {
                    URL.revokeObjectURL(url);
                    resolve();
                };
                audio.onerror = (e) => {
                    URL.revokeObjectURL(url);
                    console.error('[TTS] Azure audio play error:', e);
                    reject(new Error('音频播放失败'));
                };
                audio.oncanplay = () => {
                    const playPromise = audio.play();
                    if (playPromise && playPromise.catch) {
                        playPromise.catch(err => {
                            console.error('[TTS] Audio play rejected:', err);
                            URL.revokeObjectURL(url);
                            reject(err);
                        });
                    }
                };
                audio.load();
            });
        } catch (err) {
            console.error('[TTS] Azure speak failed:', err);
            throw err;
        }
    }

    /**
     * 合成语音并返回 MP3 Blob
     * @param {string} text 文本内容
     * @param {Object} options 选项
     * @returns {Promise<Blob>} MP3 音频 Blob
     */
    synthesizeToMP3(text, options = {}) {
        if (this.currentProvider === 'edgetts') {
            return this._synthesizeEdgeTTS(text, options);
        } else if (this.currentProvider === 'azure') {
            return this._synthesizeAzure(text, options);
        }
        return Promise.reject(new Error('当前提供商不支持导出 MP3，请使用 Edge TTS 或微软 Azure'));
    }

    async _speakEdgeTTS(text, options) {
        try {
            // 停止之前的音频
            this.stop();

            const audioBlob = await this._synthesizeEdgeTTS(text, options);
            const url = URL.createObjectURL(audioBlob);
            const audio = new Audio();
            audio.src = url;
            audio.preload = 'auto';

            // 存储当前音频对象
            this._currentAudio = audio;

            return new Promise((resolve, reject) => {
                audio.onended = () => {
                    URL.revokeObjectURL(url);
                    if (this._currentAudio === audio) {
                        this._currentAudio = null;
                    }
                    resolve();
                };
                audio.onerror = (e) => {
                    URL.revokeObjectURL(url);
                    if (this._currentAudio === audio) {
                        this._currentAudio = null;
                    }
                    console.error('[TTS] EdgeTTS audio play error:', e);
                    reject(new Error('音频播放失败'));
                };
                audio.oncanplay = () => {
                    const playPromise = audio.play();
                    if (playPromise && playPromise.catch) {
                        playPromise.catch(err => {
                            console.error('[TTS] Audio play rejected:', err);
                            URL.revokeObjectURL(url);
                            if (this._currentAudio === audio) {
                                this._currentAudio = null;
                            }
                            reject(err);
                        });
                    }
                };
                audio.load();
            });
        } catch (err) {
            console.error('[TTS] EdgeTTS speak failed:', err);
            throw err;
        }
    }

    async _synthesizeEdgeTTS(text, options = {}) {
        if (!text || !text.trim()) {
            throw new Error('文本内容为空');
        }

        const { voice = 'zh-CN-XiaoxiaoNeural', rate = 1, pitch = 1, volume = 1 } = options;

        // 将 rate/pitch/volume 转换为 edge-tts 需要的字符串格式
        // rate: +0%, volume: +0%, pitch: +0Hz (注意 pitch 必须是 Hz 单位)
        const rateStr = (rate === 1) ? '+0%' : (rate > 1 ? '+' : '') + Math.round((rate - 1) * 100) + '%';
        const volumeStr = (volume === 1) ? '+0%' : (volume > 1 ? '+' : '') + Math.round((volume - 1) * 100) + '%';
        const pitchStr = (pitch === 1) ? '+0Hz' : (pitch > 1 ? '+' : '') + Math.round((pitch - 1) * 50) + 'Hz';

        // 优先尝试本地后端服务器
        try {
            console.log('[EdgeTTS] 尝试连接本地后端服务器...');
            const audioBlob = await this._synthesizeViaLocalServer(text, voice, rateStr, pitchStr, volumeStr);
            console.log('[EdgeTTS] 本地后端服务器成功，音频大小:', audioBlob.size, 'bytes');
            return audioBlob;
        } catch (localError) {
            console.warn('[EdgeTTS] 本地后端服务器失败:', localError.message);
            const errMsg = localError.message || '';
            // 如果是音色不存在或参数错误，不回退到WebSocket，直接抛出（换连接方式也没用）
            if (errMsg.includes('No audio was received') || errMsg.includes('未收到音频数据') || errMsg.includes('verify that your parameters are correct')) {
                throw localError;
            }
            // 只有连接不上时才回退到WebSocket
            console.log('[EdgeTTS] 回退到WebSocket直接连接方式...');
            return await this._synthesizeViaWebSocket(text, voice, rateStr, pitchStr, volumeStr);
        }
    }

    /**
     * 通过本地Node.js后端服务器中转请求
     * 这是推荐的方式，稳定可靠，不受浏览器限制
     */
    async _synthesizeViaLocalServer(text, voice, rateStr, pitchStr, volumeStr) {
        const url = `${this.localServerUrl}/api/tts`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Date': this._getDateHeader()
            },
            body: JSON.stringify({
                text: text,
                voice: voice,
                rate: rateStr,
                pitch: pitchStr,
                volume: volumeStr
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '未知错误');
            if (response.status === 0 || response.status === 404) {
                throw new Error('本地后端服务器未启动。请先运行: cd tts-server && npm install && npm start');
            }
            throw new Error(`后端服务器错误 (${response.status}): ${errText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return new Blob([arrayBuffer], { type: 'audio/mpeg' });
    }

    /**
     * WebSocket直接连接方式（备用）
     * 可能在某些浏览器被安全策略阻止
     */
    async _synthesizeViaWebSocket(text, voice, rateStr, pitchStr, volumeStr) {
        const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
        const CHROMIUM_FULL_VERSION = '130.0.2849.68';
        const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
        const WIN_EPOCH = 11644473600;

        // 生成 Sec-MS-GEC token
        const generateSecMsGec = async () => {
            const ticks = Math.floor(new Date().getTime() / 1000);
            const ticksBase = ticks + WIN_EPOCH;
            const adjustedTicks = ticksBase - (ticksBase % 300);
            const str = `${Math.floor(adjustedTicks)}${TRUSTED_CLIENT_TOKEN}`;
            const data = new TextEncoder().encode(str);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('')
                .toUpperCase();
        };

        const generateConnectionId = () => {
            return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            }).toUpperCase();
        };

        const getTimestamp = () => {
            return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
        };

        const escapeXml = (s) => {
            return s.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case "'": return '&apos;';
                    case '"': return '&quot;';
                }
            });
        };

        const secMsGec = await generateSecMsGec();
        const connectionId = generateConnectionId();
        const requestId = generateConnectionId();

        const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
        const wsUrl = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;

        console.log('[EdgeTTS] WebSocket URL:', wsUrl);

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);

            const audioChunks = [];
            const boundaryEvents = [];
            let timeout;
            let isGetEnd = false;

            const cleanup = () => {
                clearTimeout(timeout);
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
                    try { ws.close(); } catch (e) {}
                }
            };

            timeout = setTimeout(() => {
                cleanup();
                if (audioChunks.length > 0) {
                    const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
                    resolve(blob);
                } else {
                    reject(new Error('Edge TTS WebSocket连接超时。建议启动本地后端服务器。'));
                }
            }, 30000);

            ws.onopen = () => {
                console.log('[EdgeTTS] WebSocket连接已打开');
                const speechConfig = {
                    context: {
                        synthesis: {
                            audio: {
                                metadataoptions: {
                                    sentenceBoundaryEnabled: false,
                                    wordBoundaryEnabled: true
                                },
                                outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
                            }
                        }
                    }
                };
                const configMsg = `X-Timestamp:${getTimestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(speechConfig)}`;
                ws.send(configMsg);

                const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='${pitchStr}' rate='${rateStr}' volume='${volumeStr}'>${escapeXml(text)}</prosody></voice></speak>`;
                const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${getTimestamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
                ws.send(ssmlMsg);
                console.log('[EdgeTTS] 已发送SSML消息');
            };

            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    const parts = event.data.split('\r\n\r\n');
                    const headers = parts[0];
                    const body = parts[1];
                    const headerObj = {};
                    headers.split('\r\n').forEach(line => {
                        const [k, v] = line.split(':', 2);
                        if (k && v) headerObj[k.trim()] = v.trim();
                    });

                    if (headerObj.Path === 'audio.metadata') {
                        try {
                            const meta = JSON.parse(body);
                            if (meta.Metadata && Array.isArray(meta.Metadata)) {
                                meta.Metadata.forEach(m => {
                                    if (m.Type === 'WordBoundary' && m.Data) {
                                        boundaryEvents.push({
                                            Offset: m.Data.Offset,
                                            Duration: m.Data.Duration,
                                            text: m.Data.text.Text
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            console.warn('[EdgeTTS] 解析 metadata 失败:', e);
                        }
                    } else if (headerObj.Path === 'turn.end') {
                        isGetEnd = true;
                        cleanup();
                        if (audioChunks.length > 0) {
                            const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
                            resolve(blob);
                        } else {
                            reject(new Error('未收到音频数据'));
                        }
                    }
                } else {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const arrayBuffer = reader.result;
                        const view = new Uint8Array(arrayBuffer);
                        const headerLength = (view[0] << 8) | view[1];
                        const audioOffset = 2 + headerLength;

                        if (audioOffset >= arrayBuffer.byteLength) return;

                        const headerStr = new TextDecoder().decode(arrayBuffer.slice(2, audioOffset));
                        if (!headerStr.includes('Path:audio')) return;

                        const audioData = arrayBuffer.slice(audioOffset);
                        if (audioData.byteLength > 0) {
                            audioChunks.push(audioData);
                        }
                    };
                    reader.readAsArrayBuffer(event.data);
                }
            };

            ws.onerror = (e) => {
                console.error('[EdgeTTS] WebSocket error:', e);
                cleanup();
                if (audioChunks.length > 0) {
                    const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
                    resolve(blob);
                } else {
                    reject(new Error('WebSocket连接失败。建议启动本地后端服务器：cd tts-server && npm install && npm start'));
                }
            };

            ws.onclose = (e) => {
                console.log('[EdgeTTS] WebSocket连接关闭, code:', e.code, 'reason:', e.reason);
                if (audioChunks.length > 0) {
                    const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
                    resolve(blob);
                } else if (!isGetEnd) {
                    reject(new Error('WebSocket连接被关闭。建议启动本地后端服务器以获得更稳定的体验。'));
                }
            };
        });
    }

    _generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    async _synthesizeAzure(text, options = {}) {
        if (!this.azureKey) {
            throw new Error('请先配置 Azure 语音 API Key');
        }

        const { voice = 'zh-CN-XiaoxiaoNeural', rate = 1, pitch = 1, volume = 1 } = options;

        const ssml = `
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">
    <voice name="${voice}">
        <prosody rate="${Math.round((rate - 1) * 100)}%" pitch="${Math.round((pitch - 1) * 100)}%" volume="${Math.round(volume * 100)}%">
            ${this._escapeXml(text)}
        </prosody>
    </voice>
</speak>`.trim();

        const endpoint = `https://${this.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': this.azureKey,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
                'User-Agent': 'ai-director'
            },
            body: ssml
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '未知错误');
            throw new Error(`语音合成失败 (${response.status}): ${errText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return new Blob([arrayBuffer], { type: 'audio/mpeg' });
    }

    _escapeXml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * 预估朗读时长（秒）
     * 用于没有实际合成时的时长估算
     */
    estimateDuration(text, rate = 1) {
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        const englishChars = (text.match(/[a-zA-Z]+/g) || []).length;
        // 使用更保守的语速估算，确保字幕不会重叠
        // 中文约 4 字/秒，英文约 8 字符/秒，再乘以 1.3 倍保守系数
        const chineseSpeed = 4;
        const englishSpeed = 8;
        const baseDuration = (chineseChars / chineseSpeed) + (englishChars / englishSpeed);
        return Math.max(0.8, baseDuration / rate * 1.3);
    }
}
