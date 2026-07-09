class VideoEditor {
    static ANIMATION_PRESETS = {
        entry: {
            fadeIn: { label: '淡入' },
            shake: { label: '抖动' },
            zoomIn: { label: '放大' },
            zoomOutEntry: { label: '缩小' }
        },
        exit: {
            fadeOut: { label: '淡出' },
            zoomOutExit: { label: '缩小' },
            rotateOut: { label: '旋转' }
        }
    };

    static applyAnimationEffects(clipTime, clip, effects) {
        if (!clip) return;
        const applyPreset = (preset, progress) => {
            if (!preset) return;
            if (preset === 'fadeIn') {
                effects.opacity = progress * 100;
            } else if (preset === 'shake') {
                effects.posX = Math.sin(progress * Math.PI * 6) * 30 * (1 - progress);
            } else if (preset === 'zoomIn') {
                const s = progress * 100;
                effects.scale = s; effects.scaleX = s; effects.scaleY = s;
            } else if (preset === 'zoomOutEntry') {
                const s = 150 - progress * 50;
                effects.scale = s; effects.scaleX = s; effects.scaleY = s;
            } else if (preset === 'fadeOut') {
                effects.opacity = (1 - progress) * 100;
            } else if (preset === 'zoomOutExit') {
                const s = (1 - progress) * 100;
                effects.scale = s; effects.scaleX = s; effects.scaleY = s;
            } else if (preset === 'rotateOut') {
                effects.rotation = progress * 360;
            }
        };

        if (clip.entryAnimation && clip.entryAnimation.type && clip.entryAnimation.type !== 'none') {
            const dur = clip.entryAnimation.duration || 0.5;
            if (clipTime < dur) {
                applyPreset(clip.entryAnimation.type, clipTime / dur);
            } else {
                applyPreset(clip.entryAnimation.type, 1);
            }
        }
        if (clip.exitAnimation && clip.exitAnimation.type && clip.exitAnimation.type !== 'none') {
            const dur = clip.exitAnimation.duration || 0.5;
            const exitStart = Math.max(0, clip.duration - dur);
            if (clipTime >= exitStart) {
                const progress = Math.min(1, (clipTime - exitStart) / dur);
                applyPreset(clip.exitAnimation.type, progress);
            }
        }
    }

    constructor() {
        this.materials = [];
        this.timelineClips = [];
        this.selectedClipId = null;
        this.selectedClipIds = new Set();
        this.isPlaying = false;
        this.currentTime = 0;
        this.totalDuration = 0;
        this.zoomLevel = 100;
        this.pixelsPerSecond = 10;
        this.minPixelsPerSecond = 0.1;
        this.maxPixelsPerSecond = 1000;
        this.isDragging = false;
        this.isResizing = false;
        this.resizeHandle = null;
        this.dragClip = null;
        this.resizeClip = null;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.clipStartX = 0;
        this.clipStartTime = 0;
        this.clipStartDuration = 0;
        this.animationFrame = null;
        this.playheadStartTime = 0;
        this.playheadStartPos = 0;
        this.videoEngine = null;
        this.videoRenderer = null;
        this.currentClipEffects = {
            opacity: 100,
            scale: 100,
            scaleX: 100,
            scaleY: 100,
            posX: 0,
            posY: 0,
            rotation: 0,
            brightness: 0,
            contrast: 0,
            saturation: 0,
            speed: 1,
            volume: 100
        };
        this.mainTrackIndex = 0;
        this.minTrackIndex = -2;
        this.maxTrackIndex = 2;
        this.snapMainTrack = false;
        this.snapClips = true;
        this.snapThreshold = 0.05;
        this.selectedKeyframeIds = new Set();
        this.keyframesTabMode = 'current';
        this.exportFileName = 'project.mp4';
        this.playPreviewTimer = null;
        this.autoScrollTimer = null;
        this.autoScrollSpeed = 0;
        this.trackStates = {};
        this.selectedTrackIndex = null;
        this.waveformCache = new Map();
        this.thumbnailCache = new Map();
        this.thumbPreloader = null;
        this.shortcuts = {
            togglePlay: { key: ' ', ctrl: false, alt: false, shift: false, meta: false, display: 'Space' },
            splitClip: { key: 'b', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + B' },
            deleteClip: { key: 'Delete', ctrl: false, alt: false, shift: false, meta: false, display: 'Delete / Backspace' },
            undo: { key: 'z', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + Z' },
            redo: { key: 'y', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + Y' },
            selectAll: { key: 'a', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + A' },
            copyClip: { key: 'c', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + C' },
            pasteClip: { key: 'v', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + V' },
            zoomIn: { key: 'wheelUp', alt: true, ctrl: false, shift: false, meta: false, display: 'Alt + 滚轮上' },
            zoomOut: { key: 'wheelDown', alt: true, ctrl: false, shift: false, meta: false, display: 'Alt + 滚轮下' },
            export: { key: 'e', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + E' },
            save: { key: 's', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + S' },
            prevFrame: { key: 'ArrowLeft', ctrl: false, alt: false, shift: false, meta: false, display: '← 左方向键' },
            nextFrame: { key: 'ArrowRight', ctrl: false, alt: false, shift: false, meta: false, display: '→ 右方向键' },
            jumpPrev: { key: 'ArrowUp', ctrl: false, alt: false, shift: false, meta: false, display: '↑ 上方向键' },
            jumpNext: { key: 'ArrowDown', ctrl: false, alt: false, shift: false, meta: false, display: '↓ 下方向键' }
        };
        this.editingShortcut = null;
        // 撤销/重做管理器
        this.undoManager = new UndoManager(this, 50);
        // 项目存储管理器
        this.projectStorage = new ProjectStorage();
        // 项目名称
        this.projectName = '未命名项目';
        // 文件引用缓存（用户导入的原始 File 对象）
        this._fileReferences = new Map();
        this._boxSelectTimestamp = 0;
    }

    init() {
        this.initVideoRenderer();
        this.initThumbPreloader();
        this.bindPropTabs();
        this.bindImportEvents();
        this.bindPlaceholderEvents();
        this.bindTypeFilter();
        this.bindPlayControl();
        this.bindTimelineClick();
        this.bindTimelineRulerClick();
        this.bindTimelineDrop();
        this.bindToolbarButtons();
        this.bindZoomControl();
        this.bindResizers();
        this.bindPropertyControls();
        this.bindAnimationControls();
        this.bindTextPropertyEvents();
        this.bindKeyboardShortcuts();
        this.bindScrollSync();
        this.bindShortcutSettings();
        this.loadShortcuts();
        this.updateZoom();
        this.renderTimeline();
        this.updateTotalDuration();
        // 初始化撤销管理器基线
        this.undoManager.initBaseline('初始状态');
        // 初始化项目存储并尝试加载上次项目
        this._initProjectStorage();
        // 绑定工具栏按钮
        this.bindToolbarButtonsV2();
    }

    async _initProjectStorage() {
        const ok = await this.projectStorage.init();
        if (!ok) return;
        // 启动自动保存
        this.projectStorage.startAutoSave(this);
        // 尝试加载上次的项目（异步，不阻塞 UI）
        this._loadLastProject();
    }

    async _loadLastProject() {
        try {
            const data = await this.projectStorage.loadProject(this);
            if (!data || !data.clips || data.clips.length === 0) return;
            // 有历史项目，询问用户是否恢复
            const savedTime = new Date(data.savedAt).toLocaleString('zh-CN');
            const confirm = window.confirm(`检测到上次未保存完成的项目（${data.name}，保存于 ${savedTime}）\n是否恢复？\n\n点击"取消"将开始新项目。`);
            if (!confirm) return;

            // 暂停历史记录
            this.undoManager.suspend();
            try {
                // 恢复项目
                this.timelineClips = [];
                this.materials = [];
                for (const m of (data.materials || [])) {
                    const material = { ...m };
                    // 尝试从 IndexedDB 恢复素材二进制
                    if (this.projectStorage.db) {
                        try {
                            const blob = await this.projectStorage.loadMaterialBlob(m.id);
                            if (blob) {
                                material.file = blob;
                                material.url = URL.createObjectURL(blob);
                                material.needsRelocation = false;
                            } else {
                                material.needsRelocation = true;
                            }
                        } catch (e) {
                            material.needsRelocation = true;
                        }
                    } else {
                        material.needsRelocation = !m.url;
                    }
                    this.materials.push(material);
                }

                // 修复缺失 textData 的字幕文本素材（兼容旧存档）
                for (const m of this.materials) {
                    // 先恢复 isSubtitleText 标记（通过 clip 的 subtitleGroupId 推断）
                    if (m.type === 'text' && m.isSubtitleText === undefined) {
                        const linkedClips = data.clips.filter(c => c.materialId === m.id && c.subtitleGroupId);
                        if (linkedClips.length > 0) {
                            m.isSubtitleText = true;
                        }
                    }
                    // 恢复 isSubtitleAudio 标记
                    if (m.type === 'audio' && m.isSubtitleAudio === undefined) {
                        const linkedClips = data.clips.filter(c => c.materialId === m.id && c.subtitleGroupId);
                        if (linkedClips.length > 0) {
                            m.isSubtitleAudio = true;
                        }
                    }
                    // 修复 textData 问题：缺失或已有的 fontSize 不正确
                    if (m.type === 'text') {
                        if (!m.textData) {
                            const defaultMat = window.TextManager ? TextManager.createDefaultMaterial() : null;
                            if (defaultMat) {
                                m.textData = defaultMat.textData;
                                m.textData.text = m.name || '字幕';
                            }
                        }
                        if (m.textData && m.isSubtitleText && m.textData.fontSize > 72) {
                            m.textData.fontSize = 72;
                        }
                    }
                }

                for (const clip of data.clips) {
                    const material = this.materials.find(m => m.id === clip.materialId);
                    this.timelineClips.push({
                        ...clip,
                        material: material || null,
                        effects: clip.effects ? { ...clip.effects } : null,
                        keyframes: clip.keyframes ? clip.keyframes.map(k => ({ ...k, props: { ...k.props } })) : null
                    });
                }
                if (data.canvas && this.videoEngine) {
                    const w = data.canvas.width;
                    const h = data.canvas.height;
                    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
                    const g = gcd(w, h);
                    this.videoEngine.setCanvasRatio(w / g, h / g, Math.min(w, h));
                    this.updateCanvasRatioLabel();
                }
                if (data.mainTrackIndex !== undefined) this.mainTrackIndex = data.mainTrackIndex;
                if (data.minTrackIndex !== undefined) this.minTrackIndex = data.minTrackIndex;
                if (data.maxTrackIndex !== undefined) this.maxTrackIndex = data.maxTrackIndex;
                if (data.trackStates) this.trackStates = { ...data.trackStates };
                if (data.name) this.projectName = data.name;
                if (this.videoRenderer) this.videoRenderer.setClips(this.timelineClips);
                this.renderTimeline();
                this.updateTotalDuration();
                this.renderMaterials();
                this.updatePropertiesPanel();
                this.renderKeyframesList();
            } finally {
                this.undoManager.resume();
            }
            // 重置历史栈
            this.undoManager.clear();
            this.undoManager.initBaseline('恢复上次项目');
            // 检查缺失素材
            const missing = this.materials.filter(m => m.needsRelocation);
            if (missing.length > 0) {
                this.showToast(`有 ${missing.length} 个素材需要重新导入`, 'warning');
            } else {
                this.showToast('项目已恢复', 'success');
            }
        } catch (e) {
            console.warn('[Editor] 加载上次项目失败:', e);
        }
    }

    bindToolbarButtonsV2() {
        // 撤销/重做按钮
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.addEventListener('click', () => this.undo());
        if (redoBtn) redoBtn.addEventListener('click', () => this.redo());

        // 项目保存/导入/导出按钮（如果存在）
        const saveProjectBtn = document.getElementById('saveProjectBtn');
        if (saveProjectBtn) saveProjectBtn.addEventListener('click', () => this.saveProject());

        const addTextBtn = document.getElementById('addTextBtn');
        if (addTextBtn) addTextBtn.addEventListener('click', () => this.addTextToTimeline());

        const createSubtitleBtn = document.getElementById('createSubtitleBtn');
        if (createSubtitleBtn) createSubtitleBtn.addEventListener('click', () => this.openSubtitleModal());

        const exportProjectBtn = document.getElementById('exportProjectBtn');
        if (exportProjectBtn) exportProjectBtn.addEventListener('click', () => this.exportProject());

        const importProjectBtn = document.getElementById('importProjectBtn');
        const projectFileInput = document.getElementById('projectFileInput');
        if (importProjectBtn && projectFileInput) {
            importProjectBtn.addEventListener('click', () => projectFileInput.click());
            projectFileInput.addEventListener('change', (e) => {
                if (e.target.files[0]) this.importProject(e.target.files[0]);
                e.target.value = '';
            });
        }
    }

    // ============= 撤销/重做 =============
    undo() {
        if (this.undoManager.undo()) {
            this.showToast('已撤销', 'info', 1000);
        }
    }

    redo() {
        if (this.undoManager.redo()) {
            this.showToast('已重做', 'info', 1000);
        }
    }

    /**
     * 记录一次操作到历史栈
     * 调用时机：操作完成、UI 已刷新后
     */
    pushHistory(description = '') {
        this.undoManager.push(description);
    }

    // ============= 项目保存/导入/导出 =============
    async saveProject() {
        const ok = await this.projectStorage.saveProject(this);
        if (ok) {
            this.showToast(`项目已保存：${this.projectName}`, 'success');
        } else {
            this.showToast('保存失败', 'error');
        }
    }

    exportProject() {
        const name = prompt('请输入项目名称', this.projectName);
        if (name === null) return;
        this.projectName = name;
        this.projectStorage.exportProjectAsFile(this, name);
        this.showToast('项目文件已导出', 'success');
    }

    async importProject(file) {
        try {
            const data = await this.projectStorage.importProjectFromFile(file);

            // 收集项目需要的素材 id
            const neededMaterialIds = new Set((data.materials || []).map(m => m.id));

            // 尝试从 IndexedDB 恢复素材二进制
            const materialResolver = async (materialId, meta) => {
                // 优先匹配同名同大小的本地素材
                const existing = this.materials.find(m =>
                    m.name === meta.name && m.size === meta.size && !neededMaterialIds.has(m.id)
                );
                if (existing) {
                    return { material: existing, url: existing.url, file: existing.file };
                }
                // 尝试从 IndexedDB 读取缓存的二进制
                const blob = await this.projectStorage.loadMaterialBlob(materialId);
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    return { url, file: blob };
                }
                return null;
            };

            const result = await this.projectStorage.applyProjectToEditor(this, data, materialResolver);
            this.projectName = data.name || '导入的项目';
            this.showToast(`项目已导入${result.missingMaterials.length > 0 ? `（${result.missingMaterials.length} 个素材需重新导入）` : ''}`, 'success');
        } catch (e) {
            console.error('[Editor] 导入项目失败:', e);
            this.showToast('导入失败: ' + e.message, 'error');
        }
    }

    initVideoRenderer() {
        // 传入画布容器（.preview-canvas），不再是 previewLayers
        const canvasContainer = document.getElementById('previewCanvas');
        const placeholder = document.getElementById('previewPlaceholder');
        if (canvasContainer) {
            // 使用 VideoEngine（WebGL 渲染）作为主渲染引擎
            this.videoEngine = new VideoEngine(canvasContainer, placeholder);
            this.videoRenderer = this.videoEngine; // 兼容别名

            // 初始化 TextManager（文本素材管理）
            if (!window.textManager) {
                window.textManager = new TextManager();
            }
            
            this.videoEngine.onClipTransform = (transform) => {
                const clip = this.timelineClips.find(c => c.id === transform.clipId);
                if (!clip) return;

                if (transform.scale !== undefined) {
                    this.currentClipEffects.scale = transform.scale;
                }
                if (transform.scaleX !== undefined) {
                    this.currentClipEffects.scaleX = transform.scaleX;
                }
                if (transform.scaleY !== undefined) {
                    this.currentClipEffects.scaleY = transform.scaleY;
                }
                if (transform.posX !== undefined) {
                    this.currentClipEffects.posX = transform.posX;
                }
                if (transform.posY !== undefined) {
                    this.currentClipEffects.posY = transform.posY;
                }
                if (transform.rotation !== undefined) {
                    this.currentClipEffects.rotation = transform.rotation;
                }

                // 文本片段：同步 VideoEngine 写入 material.textData 的属性
                if (clip.material && clip.material.type === 'text' && clip.material.textData) {
                    if (transform.fontSize !== undefined) {
                        clip.material.textData.fontSize = transform.fontSize;
                    }
                    if (transform.maxWidth !== undefined) {
                        clip.material.textData.maxWidth = transform.maxWidth;
                    }
                    if (transform.lineHeight !== undefined) {
                        clip.material.textData.lineHeight = transform.lineHeight;
                    }
                    if (this.selectedClipId === clip.id) {
                        this._syncTextPropertiesPanel(clip.material.textData);
                    }
                    // 重新渲染时间轴缩略图
                    this._refreshTextClipThumb(clip);
                    // 让视频引擎立即重绘
                    if (this.videoEngine && this.videoEngine._needsRender !== undefined) {
                        this.videoEngine._needsRender = true;
                    }
                }

                // 字幕组同步：将变换属性同步到同组其他字幕
                if (clip.subtitleGroupId) {
                    this._syncSubtitleTransforms(clip, transform);
                }

                this.updateSelectedClipEffects();
                this.updatePropertiesPanel();
            };

            // 预览画面变换结束（缩放/拖动/旋转松手时）→ 记录历史
            this.videoEngine.onClipTransformEnd = () => {
                this.pushHistory('预览变换');
            };

            this.videoEngine.onClipClick = (clipId) => {
                if (clipId) {
                    this.selectClip(clipId);
                } else {
                    this.selectClip(null);
                }
            };

            this.videoEngine.setClips(this.timelineClips);
            
            // 设置默认画布比例 16:9
            this.videoEngine.setCanvasRatio(16, 9, 1080);
            
            // 更新画布比例标签
            this.updateCanvasRatioLabel();
            
            setTimeout(() => {
                if (this.videoEngine && this.videoEngine.resizeCanvas) {
                    this.videoEngine.resizeCanvas();
                }
            }, 100);
            
            setTimeout(() => {
                if (this.videoRenderer) {
                    console.log('[Editor] Forcing first frame render via seek(0)');
                    this.videoRenderer.seek(0);
                }
            }, 500);
        }
    }

    updateCanvasRatioLabel() {
        const label = document.getElementById('canvasRatioLabel');
        if (label && this.videoRenderer) {
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            const g = gcd(this.videoRenderer.canvasW, this.videoRenderer.canvasH);
            const w = this.videoRenderer.canvasW / g;
            const h = this.videoRenderer.canvasH / g;
            label.textContent = `${w}:${h}`;
        }
    }

    bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (this.editingShortcut) return;
            
            const activeTag = document.activeElement.tagName;
            if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') {
                return;
            }

            const matchShortcut = (action) => {
                const s = this.shortcuts[action];
                if (!s) return false;
                const keyMatch = e.key.toLowerCase() === s.key.toLowerCase();
                const ctrlMatch = (e.ctrlKey || e.metaKey) === s.ctrl || (!s.ctrl && !e.ctrlKey && !e.metaKey);
                const altMatch = e.altKey === s.alt;
                const shiftMatch = e.shiftKey === s.shift;
                return keyMatch && ctrlMatch && altMatch && shiftMatch;
            };

            if (matchShortcut('togglePlay')) {
                e.preventDefault();
                this.togglePlay();
            } else if (matchShortcut('splitClip')) {
                e.preventDefault();
                this.splitSelectedClipAtPlayhead();
            } else if (matchShortcut('deleteClip')) {
                if (this.selectedKeyframeIds.size > 0) {
                    this.deleteSelectedKeyframes();
                    e.preventDefault();
                } else if (this.selectedClipId || this.selectedClipIds.size > 0) {
                    this.deleteSelectedClip();
                    e.preventDefault();
                }
            } else if (matchShortcut('undo')) {
                e.preventDefault();
                this.undo();
            } else if (matchShortcut('redo')) {
                e.preventDefault();
                this.redo();
            } else if (matchShortcut('selectAll')) {
                e.preventDefault();
                this.selectAllClips();
            } else if (matchShortcut('copyClip')) {
                e.preventDefault();
                this.copyClips();
            } else if (matchShortcut('pasteClip')) {
                e.preventDefault();
                this.pasteClips();
            } else if (matchShortcut('zoomIn')) {
                e.preventDefault();
                this.zoomTimeline(1);
            } else if (matchShortcut('zoomOut')) {
                e.preventDefault();
                this.zoomTimeline(-1);
            } else if (matchShortcut('export')) {
                e.preventDefault();
                this.showExportDialog();
            } else if (matchShortcut('save')) {
                e.preventDefault();
                this.saveProject();
            } else if (matchShortcut('prevFrame')) {
                e.preventDefault();
                this.stepFrame(-1);
            } else if (matchShortcut('nextFrame')) {
                e.preventDefault();
                this.stepFrame(1);
            } else if (matchShortcut('jumpPrev')) {
                e.preventDefault();
                this.jumpToMarker(-1);
            } else if (matchShortcut('jumpNext')) {
                e.preventDefault();
                this.jumpToMarker(1);
            }
        });
    }

    bindAnimationControls() {
        const playAnimationPreview = (clip, animKind) => {
            if (!clip) return;
            if (this.playPreviewTimer) {
                clearTimeout(this.playPreviewTimer);
                this.playPreviewTimer = null;
            }
            if (this.isPlaying) this.togglePlay();

            if (animKind === 'entry') {
                this.currentTime = clip.startTime;
                this.updatePlayheadPosition();
                this.updatePreviewLayers(true);
                this.togglePlay();
                const dur = clip.entryAnimation ? clip.entryAnimation.duration : 0.5;
                this.playPreviewTimer = setTimeout(() => {
                    if (this.isPlaying) this.togglePlay();
                    this.playPreviewTimer = null;
                }, dur * 1000 + 200);
            } else if (animKind === 'exit') {
                const dur = clip.exitAnimation ? clip.exitAnimation.duration : 0.5;
                this.currentTime = Math.max(0, clip.startTime + clip.duration - dur);
                this.updatePlayheadPosition();
                this.updatePreviewLayers(true);
                this.togglePlay();
                this.playPreviewTimer = setTimeout(() => {
                    if (this.isPlaying) this.togglePlay();
                    this.playPreviewTimer = null;
                }, dur * 1000 + 200);
            }
        };

        // 入场动画按钮
        document.querySelectorAll('#entryAnimButtons .anim-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip) return;
                if (!clip.entryAnimation) clip.entryAnimation = { type: 'none', duration: 0.5 };
                clip.entryAnimation.type = type;
                this._syncAnimationUI(clip);
                this.updatePreviewLayers(true);
                this.pushHistory('入场动画');
                if (type !== 'none') playAnimationPreview(clip, 'entry');
            });
        });

        // 出场动画按钮
        document.querySelectorAll('#exitAnimButtons .anim-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip) return;
                if (!clip.exitAnimation) clip.exitAnimation = { type: 'none', duration: 0.5 };
                clip.exitAnimation.type = type;
                this._syncAnimationUI(clip);
                this.updatePreviewLayers(true);
                this.pushHistory('出场动画');
                if (type !== 'none') playAnimationPreview(clip, 'exit');
            });
        });

        // 动画时长滑块/输入框
        document.querySelectorAll('.anim-duration-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const anim = e.target.dataset.anim;
                const val = parseFloat(e.target.value);
                const input = e.target.parentElement.querySelector('.anim-duration-input');
                if (input) input.value = val.toFixed(1);

                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip) return;
                if (anim === 'entry' && clip.entryAnimation) {
                    clip.entryAnimation.duration = val;
                    if (clip.entryAnimation.type && clip.entryAnimation.type !== 'none') {
                        playAnimationPreview(clip, 'entry');
                    }
                } else if (anim === 'exit' && clip.exitAnimation) {
                    clip.exitAnimation.duration = val;
                    if (clip.exitAnimation.type && clip.exitAnimation.type !== 'none') {
                        playAnimationPreview(clip, 'exit');
                    }
                }
                this.updatePreviewLayers(true);
            });
        });

        document.querySelectorAll('.anim-duration-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const anim = e.target.dataset.anim;
                const val = Math.max(0.1, Math.min(3, parseFloat(e.target.value) || 0.5));
                e.target.value = val.toFixed(1);
                const slider = e.target.parentElement.querySelector('.anim-duration-slider');
                if (slider) slider.value = val;

                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip) return;
                if (anim === 'entry' && clip.entryAnimation) {
                    clip.entryAnimation.duration = val;
                    if (clip.entryAnimation.type && clip.entryAnimation.type !== 'none') {
                        playAnimationPreview(clip, 'entry');
                    }
                } else if (anim === 'exit' && clip.exitAnimation) {
                    clip.exitAnimation.duration = val;
                    if (clip.exitAnimation.type && clip.exitAnimation.type !== 'none') {
                        playAnimationPreview(clip, 'exit');
                    }
                }
                this.updatePreviewLayers(true);
            });
        });
    }

    _syncAnimationUI(clip) {
        ['entry', 'exit'].forEach(kind => {
            const anim = kind === 'entry' ? clip.entryAnimation : clip.exitAnimation;
            const container = document.getElementById(kind + 'AnimButtons');
            const durationRow = document.getElementById(kind + 'AnimDuration');
            if (!container) return;

            container.querySelectorAll('.anim-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.type === (anim ? anim.type : 'none'));
            });

            if (durationRow) {
                const hasAnim = anim && anim.type && anim.type !== 'none';
                durationRow.style.display = hasAnim ? '' : 'none';
                if (hasAnim) {
                    const slider = durationRow.querySelector('.anim-duration-slider');
                    const input = durationRow.querySelector('.anim-duration-input');
                    if (slider) slider.value = anim.duration || 0.5;
                    if (input) input.value = (anim.duration || 0.5).toFixed(1);
                }
            }
        });
    }

    selectAllClips() {
        this.selectedClipIds.clear();
        this.timelineClips.forEach(c => this.selectedClipIds.add(c.id));
        this.selectedClipId = this.timelineClips.length > 0 ? this.timelineClips[0].id : null;
        this.renderTimeline();
    }

    copyClips() {
        if (this.selectedClipIds.size === 0) return;
        
        const clips = Array.from(this.selectedClipIds)
            .map(id => this.timelineClips.find(c => c.id === id))
            .filter(c => c);
        
        if (clips.length === 0) return;

        const minStartTime = Math.min(...clips.map(c => c.startTime));
        
        this._copiedClips = clips.map(clip => ({
            materialId: clip.materialId,
            material: clip.material,
            duration: clip.duration,
            offset: clip.offset,
            trackIndex: clip.trackIndex,
            effects: { ...clip.effects },
            keyframes: clip.keyframes ? JSON.parse(JSON.stringify(clip.keyframes)) : [],
            subtitleGroupId: clip.subtitleGroupId,
            subtitleIndex: clip.subtitleIndex,
            startTimeOffset: clip.startTime - minStartTime
        }));

        this.showToast(`已复制 ${clips.length} 个片段`, 'success');
    }

    pasteClips() {
        if (!this._copiedClips || this._copiedClips.length === 0) {
            this.showToast('没有可粘贴的片段', 'warning');
            return;
        }

        const previewPlayhead = document.getElementById('previewPlayhead');
        let pasteTime = this.currentTime;
        
        if (previewPlayhead) {
            const scrollContainer = document.getElementById('tracksScrollContainer');
            const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
            const rect = previewPlayhead.getBoundingClientRect();
            const tracksLanes = document.getElementById('tracksContainer');
            const containerRect = tracksLanes ? tracksLanes.getBoundingClientRect() : null;
            
            if (containerRect) {
                const x = rect.left - containerRect.left + scrollLeft;
                pasteTime = Math.max(0, x / this.pixelsPerSecond);
            }
        }

        const trackOffsets = [...new Set(this._copiedClips.map(c => c.trackIndex))];
        const minTrack = Math.min(...trackOffsets);
        const maxTrack = Math.max(...trackOffsets);
        const trackSpan = maxTrack - minTrack + 1;

        const pasteEndTime = pasteTime + Math.max(...this._copiedClips.map(c => c.startTimeOffset + c.duration));

        const findAvailableTrack = (preferredTrack) => {
            let track = preferredTrack;
            
            const hasOverlap = (trackIndex) => {
                return this.timelineClips.some(clip => {
                    if (clip.trackIndex !== trackIndex) return false;
                    return !(clip.startTime + clip.duration <= pasteTime || clip.startTime >= pasteEndTime);
                });
            };

            if (!hasOverlap(track)) {
                return track;
            }

            for (let offset = 1; offset < 20; offset++) {
                if (track - offset >= -10 && !hasOverlap(track - offset)) {
                    return track - offset;
                }
                if (!hasOverlap(track + offset)) {
                    return track + offset;
                }
            }

            return track;
        };

        const baseTrack = findAvailableTrack(minTrack);
        const trackDelta = baseTrack - minTrack;

        const newClipIds = [];
        
        this._copiedClips.forEach((copyData, index) => {
            const material = this.materials.find(m => m.id === copyData.materialId);
            if (!material) return;

            const newClip = {
                id: 'clip_' + Date.now() + '_' + index + '_' + Math.floor(Math.random() * 1000000),
                materialId: copyData.materialId,
                material: material,
                startTime: pasteTime + copyData.startTimeOffset,
                duration: copyData.duration,
                offset: copyData.offset,
                trackIndex: copyData.trackIndex + trackDelta,
                effects: { ...copyData.effects },
                keyframes: copyData.keyframes ? JSON.parse(JSON.stringify(copyData.keyframes)) : [],
                subtitleGroupId: copyData.subtitleGroupId,
                subtitleIndex: copyData.subtitleIndex
            };

            this.timelineClips.push(newClip);
            newClipIds.push(newClip.id);
        });

        this.selectedClipIds.clear();
        newClipIds.forEach(id => this.selectedClipIds.add(id));
        this.selectedClipId = newClipIds[0] || null;

        this.updateTotalDuration();
        this.renderTimeline();
        
        if (this.videoRenderer) {
            this.videoRenderer.setClips(this.timelineClips);
        }

        this.showToast(`已粘贴 ${newClipIds.length} 个片段`, 'success');
    }

    /**
     * 逐帧步进
     * @param {number} direction -1 上一帧，1 下一帧
     */
    stepFrame(direction) {
        if (this.isPlaying) {
            this.togglePlay();
        }
        const fps = 30;
        const frameDuration = 1 / fps;
        let newTime = this.currentTime + direction * frameDuration;
        newTime = Math.max(0, Math.min(newTime, this.totalDuration));
        // 吸附到帧
        newTime = Math.round(newTime * fps) / fps;
        this.seekTo(newTime);
    }

    /**
     * 跳转到最近的素材标记点
     * 标记点包括：所有素材的开头、结尾（断点=两个素材首尾相连的位置）
     * @param {number} direction -1 向前（左），1 向后（右）
     */
    jumpToMarker(direction) {
        if (this.isPlaying) {
            this.togglePlay();
        }
        const markers = this._getSortedMarkers();
        if (markers.length === 0) return;

        const current = this.currentTime;
        // 找最近的标记点
        if (direction > 0) {
            // 向后找第一个 > current 的标记
            const next = markers.find(t => t > current + 0.001);
            if (next !== undefined) {
                this.seekTo(next);
            }
        } else {
            // 向前找最后一个 < current 的标记
            let prev = null;
            for (const t of markers) {
                if (t < current - 0.001) {
                    prev = t;
                } else {
                    break;
                }
            }
            if (prev !== null) {
                this.seekTo(prev);
            } else if (markers.length > 0 && current > 0.001) {
                // 已经在第一个标记之前，跳到开头
                this.seekTo(0);
            }
        }
    }

    /**
     * 收集所有时间轴上的标记点（去重并排序）
     * 每个素材的 startTime 和 startTime + duration 都是一个标记点
     * 断点（两个素材首尾相连的位置）也包含在内（本质上就是某个素材的结束=另一个的开始）
     */
    _getSortedMarkers() {
        const set = new Set();
        set.add(0);
        for (const clip of this.timelineClips) {
            set.add(clip.startTime);
            set.add(clip.startTime + clip.duration);
        }
        // 也加上总时长末尾
        if (this.totalDuration > 0) {
            set.add(this.totalDuration);
        }
        return Array.from(set).sort((a, b) => a - b);
    }

    /**
     * 跳转到指定时间（带 UI 更新）
     */
    seekTo(time) {
        this.currentTime = Math.max(0, Math.min(time, this.totalDuration));
        if (this.videoRenderer) {
            this.videoRenderer.seek(this.currentTime);
        }
        this.updatePlayheadPosition();
        this._ensurePlayheadVisible();
    }

    _ensurePlayheadVisible() {
        const scrollContainer = document.getElementById('tracksScrollContainer');
        if (!scrollContainer) return;
        const playheadX = this.currentTime * this.pixelsPerSecond;
        const visibleLeft = scrollContainer.scrollLeft;
        const visibleRight = visibleLeft + scrollContainer.clientWidth;
        if (playheadX < visibleLeft + 50) {
            scrollContainer.scrollLeft = Math.max(0, playheadX - 100);
        } else if (playheadX > visibleRight - 50) {
            scrollContainer.scrollLeft = playheadX - scrollContainer.clientWidth + 100;
        }
    }

    bindScrollSync() {
        const scrollContainer = document.getElementById('tracksScrollContainer');
        const rulerScroll = document.querySelector('.ruler-scroll-container');
        const tracksHeaderCol = document.getElementById('tracksHeaderCol');
        if (!scrollContainer || !rulerScroll || !tracksHeaderCol) return;

        let scrollThrottle = null;
        scrollContainer.addEventListener('scroll', () => {
            rulerScroll.scrollLeft = scrollContainer.scrollLeft;
            tracksHeaderCol.scrollTop = scrollContainer.scrollTop;

            if (!scrollThrottle) {
                scrollThrottle = setTimeout(() => {
                    scrollThrottle = null;
                    this.requestVisibleThumbs();
                }, 80);
            }
        });
    }

    bindShortcutSettings() {
        const resetBtn = document.getElementById('resetShortcutsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetShortcuts());
        }

        const editBtns = document.querySelectorAll('.shortcut-edit-btn');
        editBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const shortcutKey = e.target.closest('.shortcut-key');
                const action = shortcutKey?.dataset.action;
                if (action) {
                    this.startShortcutEdit(action);
                }
            });
        });
    }

    startShortcutEdit(action) {
        if (this.editingShortcut === action) {
            this.cancelShortcutEdit();
            return;
        }

        this.editingShortcut = action;
        const keyDisplay = document.querySelector(`.shortcut-key[data-action="${action}"] .key-display`);
        if (keyDisplay) {
            keyDisplay.textContent = '按任意键...';
            keyDisplay.style.background = 'var(--primary-color)';
            keyDisplay.style.color = 'white';
        }

        const onKeyDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (e.key === 'Escape') {
                this.cancelShortcutEdit();
                document.removeEventListener('keydown', onKeyDown, true);
                return;
            }

            const shortcut = {
                key: e.key,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey,
                display: this.formatShortcutDisplay(e)
            };

            this.shortcuts[action] = shortcut;
            this.saveShortcuts();
            this.updateShortcutDisplay(action);
            this.cancelShortcutEdit();
            document.removeEventListener('keydown', onKeyDown, true);
        };

        document.addEventListener('keydown', onKeyDown, true);
    }

    cancelShortcutEdit() {
        if (this.editingShortcut) {
            this.updateShortcutDisplay(this.editingShortcut);
            this.editingShortcut = null;
        }
    }

    formatShortcutDisplay(e) {
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        
        let key = e.key;
        if (key === ' ') key = 'Space';
        else if (key === 'ArrowUp') key = '↑';
        else if (key === 'ArrowDown') key = '↓';
        else if (key === 'ArrowLeft') key = '←';
        else if (key === 'ArrowRight') key = '→';
        else if (key.length === 1) key = key.toUpperCase();
        
        parts.push(key);
        return parts.join(' + ');
    }

    updateShortcutDisplay(action) {
        const keyDisplay = document.querySelector(`.shortcut-key[data-action="${action}"] .key-display`);
        if (keyDisplay && this.shortcuts[action]) {
            keyDisplay.textContent = this.shortcuts[action].display;
            keyDisplay.style.background = '';
            keyDisplay.style.color = '';
        }
    }

    saveShortcuts() {
        try {
            localStorage.setItem('videoEditor_shortcuts', JSON.stringify(this.shortcuts));
        } catch (e) {
            console.warn('保存快捷键失败:', e);
        }
    }

    loadShortcuts() {
        try {
            const saved = localStorage.getItem('videoEditor_shortcuts');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.shortcuts = { ...this.shortcuts, ...parsed };
                
                Object.keys(this.shortcuts).forEach(action => {
                    this.updateShortcutDisplay(action);
                });
            }
        } catch (e) {
            console.warn('加载快捷键失败:', e);
        }
    }

    resetShortcuts() {
        this.shortcuts = {
            togglePlay: { key: ' ', ctrl: false, alt: false, shift: false, meta: false, display: 'Space' },
            splitClip: { key: 'b', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + B' },
            deleteClip: { key: 'Delete', ctrl: false, alt: false, shift: false, meta: false, display: 'Delete / Backspace' },
            undo: { key: 'z', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + Z' },
            redo: { key: 'y', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + Y' },
            selectAll: { key: 'a', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + A' },
            copyClip: { key: 'c', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + C' },
            pasteClip: { key: 'v', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + V' },
            zoomIn: { key: 'wheelUp', alt: true, ctrl: false, shift: false, meta: false, display: 'Alt + 滚轮上' },
            zoomOut: { key: 'wheelDown', alt: true, ctrl: false, shift: false, meta: false, display: 'Alt + 滚轮下' },
            export: { key: 'e', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + E' },
            save: { key: 's', ctrl: true, alt: false, shift: false, meta: false, display: 'Ctrl + S' }
        };
        this.saveShortcuts();
        
        Object.keys(this.shortcuts).forEach(action => {
            this.updateShortcutDisplay(action);
        });
        
        this.showToast('快捷键已恢复默认');
    }

    bindToolbarButtons() {
        const tlBtns = document.querySelectorAll('.tl-tool-btn');
        tlBtns.forEach(btn => {
            const title = btn.getAttribute('title');
            if (title === '分割') {
                btn.addEventListener('click', () => this.splitSelectedClipAtPlayhead());
            } else if (title === '删除') {
                btn.addEventListener('click', () => this.deleteSelectedClip());
            } else if (title === '关键帧') {
                btn.addEventListener('click', () => this.toggleKeyframeAtCurrentTime());
            }
        });

        // 绑定导出按钮
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.showExportDialog());
        }
        
        // 绑定截图按钮
        const exportFrameBtn = document.getElementById('exportFrameBtn');
        if (exportFrameBtn) {
            exportFrameBtn.addEventListener('click', () => this.showExportFrameDialog());
        }

        // 绑定截图弹窗按钮
        const exportFrameModalClose = document.getElementById('exportFrameModalClose');
        const exportFrameCancelBtn = document.getElementById('exportFrameCancelBtn');
        const exportFrameConfirmBtn = document.getElementById('exportFrameConfirmBtn');
        
        if (exportFrameModalClose) {
            exportFrameModalClose.addEventListener('click', () => this.hideExportFrameDialog());
        }
        if (exportFrameCancelBtn) {
            exportFrameCancelBtn.addEventListener('click', () => this.hideExportFrameDialog());
        }
        if (exportFrameConfirmBtn) {
            exportFrameConfirmBtn.addEventListener('click', () => this.confirmExportFrame());
        }
        
        // 绑定导出对话框按钮
        const exportModalClose = document.getElementById('exportModalClose');
        const exportCancelBtn = document.getElementById('exportCancelBtn');
        const exportConfirmBtn = document.getElementById('exportConfirmBtn');
        
        if (exportModalClose) {
            exportModalClose.addEventListener('click', () => this.hideExportDialog());
        }
        if (exportCancelBtn) {
            exportCancelBtn.addEventListener('click', () => this.hideExportDialog());
        }
        if (exportConfirmBtn) {
            exportConfirmBtn.addEventListener('click', () => this.confirmExport());
        }

        this._initCustomSelect('exportFormat', (value) => {
            this._onExportFormatChange();
        });

        // 绑定画布比例设置按钮
        const canvasRatioBtn = document.getElementById('canvasRatioBtn');
        if (canvasRatioBtn) {
            canvasRatioBtn.addEventListener('click', () => this.showCanvasRatioDialog());
        }
        
        // 绑定画布比例弹窗按钮
        const canvasRatioModalClose = document.getElementById('canvasRatioModalClose');
        const canvasRatioCancelBtn = document.getElementById('canvasRatioCancelBtn');
        const canvasRatioConfirmBtn = document.getElementById('canvasRatioConfirmBtn');
        const applyCustomRatio = document.getElementById('applyCustomRatio');
        
        if (canvasRatioModalClose) {
            canvasRatioModalClose.addEventListener('click', () => this.hideCanvasRatioDialog());
        }
        if (canvasRatioCancelBtn) {
            canvasRatioCancelBtn.addEventListener('click', () => this.hideCanvasRatioDialog());
        }
        if (canvasRatioConfirmBtn) {
            canvasRatioConfirmBtn.addEventListener('click', () => this.confirmCanvasRatio());
        }
        if (applyCustomRatio) {
            applyCustomRatio.addEventListener('click', () => this.applyCustomCanvasRatio());
        }
    }

    _initCustomSelect(id, onChange) {
        const select = document.getElementById(id);
        if (!select) return;

        const header = select.querySelector('.custom-select-header');
        const valueSpan = select.querySelector('.custom-select-value');
        const dropdown = select.querySelector('.custom-select-dropdown');
        const options = select.querySelectorAll('.custom-select-option');

        // 设置初始选中态
        const initialValue = valueSpan.dataset.value;
        options.forEach(opt => {
            if (opt.dataset.value === initialValue) {
                opt.classList.add('selected');
            }
        });

        // 点击头部切换展开
        header.addEventListener('click', (e) => {
            e.stopPropagation();
            // 关闭其他下拉
            document.querySelectorAll('.custom-select.open').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            select.classList.toggle('open');
        });

        // 点击选项
        options.forEach(option => {
            option.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = option.dataset.value;
                const text = option.querySelector('span').textContent;

                valueSpan.dataset.value = value;
                valueSpan.textContent = text;

                options.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');

                select.classList.remove('open');

                if (onChange) onChange(value);
            });
        });

        // 点击外部关闭
        document.addEventListener('click', () => {
            select.classList.remove('open');
        });
    }

    _getCustomSelectValue(id) {
        const select = document.getElementById(id);
        if (!select) return '';
        const valueSpan = select.querySelector('.custom-select-value');
        return valueSpan ? valueSpan.dataset.value : '';
    }

    _onExportFormatChange() {
        const format = this._getCustomSelectValue('exportFormat') || 'webm';
        const isAudio = format === 'mp3';

        const qualityGroup = document.getElementById('exportQualityGroup');
        const audioQualityGroup = document.getElementById('exportAudioQualityGroup');
        const fpsGroup = document.getElementById('exportFpsGroup');
        const videoTip = document.getElementById('exportVideoTip');

        if (qualityGroup) qualityGroup.style.display = isAudio ? 'none' : '';
        if (audioQualityGroup) audioQualityGroup.style.display = isAudio ? '' : 'none';
        if (fpsGroup) fpsGroup.style.display = isAudio ? 'none' : '';
        if (videoTip) videoTip.style.display = isAudio ? 'none' : '';
    }

    showExportDialog() {
        if (!this.videoRenderer || this.timelineClips.length === 0) {
            this.showToast('请先添加素材到时间轴');
            return;
        }
        
        const modal = document.getElementById('exportModal');
        if (modal) {
            modal.style.display = 'flex';
        }
        
        this._onExportFormatChange();
    }
    
    hideExportDialog() {
        const modal = document.getElementById('exportModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    confirmExport() {
        const filenameInput = document.getElementById('exportFilename');
        const qualityInput = document.querySelector('input[name="exportQuality"]:checked');
        const fpsInput = document.querySelector('input[name="exportFps"]:checked');
        const customFpsInput = document.getElementById('customFpsInput');
        const audioQualityInput = document.querySelector('input[name="exportAudioQuality"]:checked');
        
        const filename = filenameInput ? filenameInput.value.trim() : 'video_export';
        const quality = qualityInput ? qualityInput.value : '1080';
        const format = this._getCustomSelectValue('exportFormat') || 'webm';
        const audioBitrate = audioQualityInput ? parseInt(audioQualityInput.value) : 192;
        
        // 获取帧率
        let fps = 30;
        if (fpsInput) {
            if (fpsInput.value === 'custom') {
                fps = parseInt(customFpsInput?.value) || 30;
            } else {
                fps = parseInt(fpsInput.value) || 30;
            }
        }
        fps = Math.max(1, Math.min(120, fps)); // 限制范围
        
        if (!filename) {
            this.showToast('请输入文件名');
            return;
        }
        
        this.hideExportDialog();
        this.startExport({ filename, quality, format, fps, audioBitrate });
    }

    showExportFrameDialog() {
        if (!this.videoRenderer || !this.videoRenderer.canvas) {
            this.showToast('请先添加素材到时间轴');
            return;
        }
        
        // 更新弹窗中的画布比例显示
        const ratioDisplay = document.getElementById('frameCanvasRatioDisplay');
        if (ratioDisplay && this.videoRenderer) {
            ratioDisplay.textContent = this.videoRenderer.getCanvasRatioText();
        }
        
        // 更新分辨率选项中的尺寸描述
        this.updateFrameQualityDescs();
        
        const modal = document.getElementById('exportFrameModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    /**
     * 根据当前画布比例，更新分辨率选项的尺寸描述
     */
    updateFrameQualityDescs() {
        if (!this.videoRenderer) return;
        const ratio = this.videoRenderer.canvasAspectRatio;
        const canvasW = this.videoRenderer.canvasW;
        const canvasH = this.videoRenderer.canvasH;
        
        // 原始尺寸
        const originalDesc = document.querySelector('.quality-desc[data-desc="original"]');
        if (originalDesc) originalDesc.textContent = `${canvasW} × ${canvasH}`;
        
        // 480P/720P/1080P：以短边为基准
        const sizeConfigs = {
            '480': 480,
            '720': 720,
            '1080': 1080
        };
        
        Object.keys(sizeConfigs).forEach(key => {
            const desc = document.querySelector(`.quality-desc[data-desc="${key}"]`);
            if (!desc) return;
            const shortSide = sizeConfigs[key];
            let w, h;
            if (ratio >= 1) {
                // 横屏：短边是高
                h = shortSide;
                w = Math.round(shortSide * ratio);
            } else {
                // 竖屏：短边是宽
                w = shortSide;
                h = Math.round(shortSide / ratio);
            }
            desc.textContent = `${w} × ${h}`;
        });
    }
    
    hideExportFrameDialog() {
        const modal = document.getElementById('exportFrameModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    confirmExportFrame() {
        const qualityInput = document.querySelector('input[name="frameQuality"]:checked');
        const filenameInput = document.getElementById('frameFilename');
        
        const quality = qualityInput ? qualityInput.value : 'original';
        const filename = filenameInput ? filenameInput.value.trim() : 'frame_export';
        
        if (!filename) {
            this.showToast('请输入文件名');
            return;
        }
        
        this.hideExportFrameDialog();
        
        if (typeof exportCurrentFrame === 'function') {
            exportCurrentFrame({ quality, filename });
        }
    }

    /**
     * 画布比例弹窗
     */
    showCanvasRatioDialog() {
        const modal = document.getElementById('canvasRatioModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    hideCanvasRatioDialog() {
        const modal = document.getElementById('canvasRatioModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    /**
     * 解析并应用选中的画布比例
     */
    parseAndApplyRatio(ratioValue) {
        if (!this.videoRenderer) return false;
        
        // 设备预设
        const devicePresets = {
            'device:iphone': [9, 19.5],
            'device:android': [9, 20],
            'device:ipad': [4, 3],
            'device:macbook': [16, 10],
            'device:pc': [16, 9],
            'device:tv': [16, 9]
        };
        
        let w, h;
        if (devicePresets[ratioValue]) {
            [w, h] = devicePresets[ratioValue];
        } else if (ratioValue.includes(':')) {
            [w, h] = ratioValue.split(':').map(Number);
        } else {
            return false;
        }
        
        if (!w || !h) return false;
        
        this.videoRenderer.setCanvasRatio(w, h, 1080);
        this.updateCanvasRatioLabel();
        return true;
    }

    confirmCanvasRatio() {
        const ratioInput = document.querySelector('input[name="canvasRatio"]:checked');
        if (!ratioInput) {
            this.showToast('请选择画布比例');
            return;
        }
        
        const success = this.parseAndApplyRatio(ratioInput.value);
        if (success) {
            this.hideCanvasRatioDialog();
            this.showToast('画布比例已更新');
        } else {
            this.showToast('画布比例设置失败', 'error');
        }
    }

    applyCustomCanvasRatio() {
        const wInput = document.getElementById('customRatioW');
        const hInput = document.getElementById('customRatioH');
        if (!wInput || !hInput) return;
        
        const w = parseInt(wInput.value);
        const h = parseInt(hInput.value);
        
        if (!w || !h || w <= 0 || h <= 0) {
            this.showToast('请输入有效的宽高比', 'error');
            return;
        }
        
        this.videoRenderer.setCanvasRatio(w, h, 1080);
        this.updateCanvasRatioLabel();
        this.hideCanvasRatioDialog();
        this.showToast(`画布比例已设置为 ${w}:${h}`);
    }

    startExport(options = {}) {
        const { filename = 'video_export', quality = '原始', format = 'mp4', fps = 60, audioBitrate = 192 } = options;
        
        // 根据画布比例和画质计算分辨率
        let canvasW, canvasH, videoBitrate;
        if (this.videoRenderer) {
            const canvasAR = this.videoRenderer.canvasAspectRatio;
            const canvasBaseW = this.videoRenderer.canvasW;
            const canvasBaseH = this.videoRenderer.canvasH;
            
            if (quality === '720') {
                if (canvasAR >= 1) {
                    canvasH = 720;
                    canvasW = Math.round(720 * canvasAR);
                } else {
                    canvasW = 720;
                    canvasH = Math.round(720 / canvasAR);
                }
                videoBitrate = '4M';
            } else if (quality === '4k') {
                if (canvasAR >= 1) {
                    canvasH = 2160;
                    canvasW = Math.round(2160 * canvasAR);
                } else {
                    canvasW = 2160;
                    canvasH = Math.round(2160 / canvasAR);
                }
                videoBitrate = '20M';
            } else {
                // 默认 1080
                if (canvasAR >= 1) {
                    canvasH = 1080;
                    canvasW = Math.round(1080 * canvasAR);
                } else {
                    canvasW = 1080;
                    canvasH = Math.round(1080 / canvasAR);
                }
                videoBitrate = '8M';
            }
            
            // 确保是偶数（H.264 等编码要求）
            canvasW = canvasW + (canvasW % 2);
            canvasH = canvasH + (canvasH % 2);
        } else {
            canvasW = 1920;
            canvasH = 1080;
            videoBitrate = '8M';
        }
        
        console.log(`[导出] 画布比例: ${this.videoRenderer?.canvasAspectRatio.toFixed(3) || '?'}, 目标分辨率: ${canvasW} x ${canvasH}, 帧率: ${fps} FPS`);
        
        // 显示导出进度弹窗
        const progressModal = document.getElementById('exportProgressModal');
        const progressDesc = document.getElementById('exportProgressDesc');
        const progressBarFill = document.getElementById('exportProgressBarFill');
        const progressPercent = document.getElementById('exportProgressPercent');
        
        if (progressModal) {
            progressModal.style.display = 'flex';
        }
        if (progressDesc) progressDesc.textContent = '准备中...';
        if (progressBarFill) progressBarFill.style.width = '0%';
        if (progressPercent) progressPercent.textContent = '0%';

        const exporter = new VideoExporter(this);
        
        let exportStartTime = 0;
        let exportCancelled = false;
        
        const cancelBtn = document.getElementById('exportProgressCancelBtn');
        const handleCancel = () => {
            if (exportCancelled) return;
            exportCancelled = true;
            console.log('[导出] 用户取消导出');
            if (exporter && typeof exporter.cancel === 'function') {
                exporter.cancel();
            }
            if (progressDesc) {
                progressDesc.textContent = '正在取消...';
            }
            if (cancelBtn) {
                cancelBtn.disabled = true;
                cancelBtn.style.opacity = '0.5';
                cancelBtn.style.cursor = 'not-allowed';
            }
        };
        
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.style.opacity = '1';
            cancelBtn.style.cursor = 'pointer';
            cancelBtn.onclick = handleCancel;
        }
        
        exporter.onProgress = (progress, message) => {
            console.log(`导出进度: ${progress}% - ${message}`);
            
            if (progressBarFill) {
                progressBarFill.style.width = progress + '%';
            }
            if (progressPercent) {
                progressPercent.textContent = Math.round(progress) + '%';
            }
            if (progressDesc) {
                progressDesc.textContent = message;
            }
            
            // 计算剩余时间
            const etaEl = document.getElementById('exportProgressEta');
            if (etaEl) {
                if (exportStartTime === 0) {
                    exportStartTime = Date.now();
                    etaEl.textContent = '剩余时间: 计算中...';
                } else if (progress > 2 && progress < 100) {
                    const elapsed = (Date.now() - exportStartTime) / 1000;
                    const totalEst = elapsed / (progress / 100);
                    const remaining = Math.max(0, totalEst - elapsed);
                    
                    if (remaining < 60) {
                        etaEl.textContent = `剩余时间: 约 ${Math.round(remaining)} 秒`;
                    } else if (remaining < 3600) {
                        const mins = Math.floor(remaining / 60);
                        const secs = Math.round(remaining % 60);
                        etaEl.textContent = `剩余时间: 约 ${mins}分${secs}秒`;
                    } else {
                        const hours = Math.floor(remaining / 3600);
                        const mins = Math.floor((remaining % 3600) / 60);
                        etaEl.textContent = `剩余时间: 约 ${hours}时${mins}分`;
                    }
                } else if (progress >= 100) {
                    etaEl.textContent = '导出完成';
                }
            }
        };

        exporter.onComplete = (blob) => {
            console.log('导出完成', blob);
            if (cancelBtn) {
                cancelBtn.onclick = null;
            }
            if (progressModal) {
                setTimeout(() => {
                    progressModal.style.display = 'none';
                }, 1000);
            }
            this.showToast(`导出完成！${canvasW}×${canvasH} @ ${fps} FPS 文件已保存到下载目录`);
        };

        exporter.onError = (error) => {
            console.error('导出失败:', error);
            if (cancelBtn) {
                cancelBtn.onclick = null;
            }
            if (progressModal) {
                progressModal.style.display = 'none';
            }
            const isCancelled = error.message && (
                error.message.includes('取消') || 
                error.message.includes('cancel') ||
                error.message.includes('abort') ||
                error.message.includes('Abort')
            );
            if (!isCancelled) {
                this.showToast('导出失败: ' + error.message, 'error');
            } else {
                this.showToast('导出已取消', 'warning');
            }
        };

        exporter.export({ 
            filename, 
            format,
            width: canvasW,
            height: canvasH,
            videoBitrate: videoBitrate,
            fps: fps,
            audioBitrate: audioBitrate
        }).catch(err => {
            console.error('导出出错:', err);
            if (cancelBtn) {
                cancelBtn.onclick = null;
            }
            if (progressModal) {
                progressModal.style.display = 'none';
            }
            const isCancelled = err.message && (
                err.message.includes('取消') || 
                err.message.includes('cancel') ||
                err.message.includes('abort') ||
                err.message.includes('Abort')
            );
            if (!isCancelled) {
                this.showToast('导出出错: ' + err.message, 'error');
            } else {
                this.showToast('导出已取消', 'warning');
            }
        });
    }

    splitSelectedClipAtPlayhead() {
        if (!this.selectedClipId) return;
        
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip) return;
        
        const splitTime = this.currentTime;
        
        if (splitTime <= clip.startTime || splitTime >= clip.startTime + clip.duration) {
            return;
        }
        
        const leftDuration = splitTime - clip.startTime;
        const rightDuration = clip.duration - leftDuration;
        
        if (leftDuration < 0.1 || rightDuration < 0.1) {
            return;
        }
        
        const clipOffset = clip.offset || 0;
        const rightOffset = clipOffset + leftDuration;
        
        const rightClip = {
            id: Date.now() + Math.random(),
            materialId: clip.materialId,
            material: clip.material,
            startTime: splitTime,
            duration: rightDuration,
            offset: rightOffset,
            trackIndex: clip.trackIndex,
            effects: { ...clip.effects }
        };
        
        clip.duration = leftDuration;
        
        if (clip.keyframes && clip.keyframes.length > 0) {
            const splitRelTime = leftDuration;
            const sortedKfs = [...clip.keyframes].sort((a, b) => a.time - b.time);
            
            let prevKf = null;
            let nextKf = null;
            
            for (const kf of sortedKfs) {
                if (kf.time <= splitRelTime) prevKf = kf;
                if (kf.time >= splitRelTime && !nextKf) nextKf = kf;
            }
            
            const leftKfs = [];
            const rightKfs = [];
            
            for (const kf of sortedKfs) {
                if (kf.time < splitRelTime) {
                    leftKfs.push(kf);
                } else if (kf.time > splitRelTime) {
                    rightKfs.push({
                        ...kf,
                        time: kf.time - splitRelTime
                    });
                }
            }
            
            if (!prevKf && !nextKf) {
                clip.keyframes = null;
            } else if (prevKf && nextKf && prevKf.time < splitRelTime && nextKf.time > splitRelTime) {
                const t = (splitRelTime - prevKf.time) / (nextKf.time - prevKf.time);
                const boundaryProps = {};
                const allProps = ['opacity', 'scale', 'scaleX', 'scaleY', 'posX', 'posY', 'rotation', 'brightness', 'contrast', 'saturation', 'volume'];
                for (const prop of allProps) {
                    const defaultVal = (prop === 'scale' || prop === 'scaleX' || prop === 'scaleY' || prop === 'opacity' || prop === 'volume') ? 100 : 0;
                    const start = prevKf.props[prop] !== undefined ? prevKf.props[prop] : 
                        (clip.effects && clip.effects[prop] !== undefined ? clip.effects[prop] : defaultVal);
                    const end = nextKf.props[prop] !== undefined ? nextKf.props[prop] : 
                        (clip.effects && clip.effects[prop] !== undefined ? clip.effects[prop] : defaultVal);
                    boundaryProps[prop] = start + (end - start) * t;
                }
                
                rightKfs.unshift({
                    id: 'kf_split_r_' + Math.random().toString(36).substr(2, 9),
                    time: 0,
                    props: { ...boundaryProps }
                });
                
                leftKfs.push({
                    id: 'kf_split_l_' + Math.random().toString(36).substr(2, 9),
                    time: splitRelTime,
                    props: { ...boundaryProps }
                });
            }
            
            clip.keyframes = leftKfs.length > 0 ? leftKfs : null;
            if (rightKfs.length > 0) rightClip.keyframes = rightKfs;
        }
        
        this.timelineClips.push(rightClip);
        this.selectedClipId = rightClip.id;
        this.renderTimeline();
        this.updateTotalDuration();
        this.pushHistory('分割素材');
    }

    bindPropTabs() {
        document.querySelectorAll('.prop-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.proptab;
                document.querySelectorAll('.prop-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.prop-section').forEach(s => s.classList.remove('active'));
                const targetId = 'prop' + targetTab.charAt(0).toUpperCase() + targetTab.slice(1);
                const targetSection = document.getElementById(targetId);
                if (targetSection) targetSection.classList.add('active');
            });
        });

        document.querySelectorAll('.keyframes-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const mode = tab.dataset.kftab;
                this.keyframesTabMode = mode;
                document.querySelectorAll('.keyframes-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.renderKeyframesList();
            });
        });
    }

    bindImportEvents() {
        const importBtn = document.getElementById('importBtn');
        const fileInput = document.getElementById('fileInput');
        if (importBtn && fileInput) {
            importBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));
        }

        const dropZone = document.getElementById('materialGrid');
        if (dropZone) {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('drag-over');
            });
            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('drag-over');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                this.handleFiles(e.dataTransfer.files);
            });
        }
    }

    handleFiles(files) {
        if (!this._fileReferences) {
            this._fileReferences = new Map();
        }

        const fileList = Array.from(files);
        let relocatedCount = 0;

        // 先尝试匹配需要重新定位的素材（按文件名+大小匹配）
        const remainingFiles = [];
        for (const file of fileList) {
            const matched = this._tryRelocateByFile(file);
            if (matched) {
                relocatedCount++;
            } else {
                remainingFiles.push(file);
            }
        }

        // 没匹配上的文件按正常流程添加为新素材
        remainingFiles.forEach(file => {
            const type = this.getFileType(file);
            if (!type) return;

            const fileId = Date.now() + Math.random();
            this._fileReferences.set(fileId, file);

            const material = {
                id: fileId,
                name: file.name,
                type: type,
                file: file,
                url: null,
                size: file.size,
                duration: 0,
                width: 0,
                height: 0
            };

            this.materials.push(material);

            // 异步缓存小文件二进制到 IndexedDB（便于项目恢复，大文件跳过避免膨胀）
            if (this.projectStorage && this.projectStorage.db) {
                this.projectStorage.saveMaterialBlob(fileId, file).catch(() => {});
            }

            if (type === 'video' || type === 'audio') {
                this._initMediaMaterial(material, file, type);
            } else {
                material.url = URL.createObjectURL(file);
                console.log('[Editor] handleFiles: created material', material.name);
            }
        });
        this.renderMaterials();
        this.updateTypeCounts();

        // 如果有素材通过自动匹配重新定位了，提示用户
        if (relocatedCount > 0) {
            this.showToast(`已自动重新定位 ${relocatedCount} 个素材`, 'success');
            this.renderTimeline();
        }
    }

    /**
     * 尝试用拖入/选择的文件自动匹配并重新定位 needsRelocation 的素材
     * 匹配规则：文件名完全相同（大小写不敏感）
     * @returns {boolean} 是否匹配成功
     */
    _tryRelocateByFile(file) {
        // 没有需要重新定位的素材，直接返回 false
        const needRelocate = this.materials.filter(m => m.needsRelocation);
        if (needRelocate.length === 0) return false;

        // 按文件名匹配（大小写不敏感）
        const fileNameLower = file.name.toLowerCase();
        const matched = needRelocate.find(m => m.name.toLowerCase() === fileNameLower);

        if (matched) {
            // 直接调用 relocateMaterial 的核心逻辑
            this._applyRelocateMaterial(matched, file);
            return true;
        }
        return false;
    }

    /**
     * 批量重新定位：打开文件选择器，用户可多选文件，按文件名自动匹配
     */
    relocateAllMaterials() {
        const needRelocate = this.materials.filter(m => m.needsRelocation);
        if (needRelocate.length === 0) {
            this.showToast('没有需要重新定位的素材', 'info');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        // 综合 accept
        const types = new Set(needRelocate.map(m => m.type));
        const accepts = [];
        if (types.has('video')) accepts.push('video/*');
        if (types.has('audio')) accepts.push('audio/*');
        if (types.has('image')) accepts.push('image/*');
        input.accept = accepts.join(',');

        input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            let matchedCount = 0;
            let unmatchedFiles = [];

            for (const file of files) {
                const fileNameLower = file.name.toLowerCase();
                const target = this.materials.find(m =>
                    m.needsRelocation && m.name.toLowerCase() === fileNameLower
                );
                if (target) {
                    this._applyRelocateMaterial(target, file);
                    matchedCount++;
                } else {
                    unmatchedFiles.push(file.name);
                }
            }

            this.renderMaterials();
            this.renderTimeline();

            if (matchedCount > 0) {
                let msg = `成功重新定位 ${matchedCount} 个素材`;
                if (unmatchedFiles.length > 0) {
                    msg += `\n以下文件未匹配到素材：${unmatchedFiles.join('、')}`;
                }
                this.showToast(msg, 'success', 4000);
            } else {
                this.showToast(`没有匹配到任何素材（文件名需一致）`, 'warning', 4000);
            }
        };
        input.click();
    }

    /**
     * 重新定位素材的核心逻辑（共用）
     */
    _applyRelocateMaterial(material, file) {
        // 保存文件引用和 url
        if (this._fileReferences) this._fileReferences.set(material.id, file);
        material.file = file;
        material.size = file.size;
        // 释放旧的 url
        if (material.url) URL.revokeObjectURL(material.url);
        material.url = URL.createObjectURL(file);
        material.needsRelocation = false;

        // 缓存到 IndexedDB（如果是小文件）
        if (this.projectStorage && this.projectStorage.db) {
            this.projectStorage.saveMaterialBlob(material.id, file).catch(() => {});
        }

        // 刷新所有使用此素材的 clip 的 material 引用
        this.timelineClips.forEach(clip => {
            if (clip.materialId === material.id) {
                clip.material = material;
            }
        });

        // 清除 VideoEngine 的旧缓存（强制重新创建 video element）
        if (this.videoEngine) {
            if (this.videoEngine._videoElements) {
                const keysToDelete = [];
                for (const key of this.videoEngine._videoElements.keys()) {
                    if (key.includes('mat_' + material.id + '|') || key.includes('mat_' + material.id + '_')) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(k => {
                    const v = this.videoEngine._videoElements.get(k);
                    if (v && v.src) URL.revokeObjectURL(v.src);
                    this.videoEngine._videoElements.delete(k);
                });
            }
            // 清除警告标记
            if (this.videoEngine._warnedNullUrls) {
                this.videoEngine._warnedNullUrls.delete(material.id);
            }
            this.videoEngine.setClips(this.timelineClips);
        }

        // 异步重新读取时长和尺寸
        if (material.type === 'video' || material.type === 'audio') {
            this._reinitMediaMaterial(material, file, material.type);
        }
    }

    async _initMediaMaterial(material, file, type) {
        const fileSizeMB = file.size / 1024 / 1024;
        const LARGE_FILE_THRESHOLD = 100; // 超过 100MB 视为大文件，开启底层切片模式

        try {
            material.file = file;

            if (fileSizeMB < LARGE_FILE_THRESHOLD) {
                const arrayBuffer = await this._readFileSafely(file);
                material._arrayBuffer = arrayBuffer;

                const blob = new Blob([arrayBuffer], { type: file.type });
                material.url = URL.createObjectURL(blob);

                console.log('[Editor] 小文件全量加载:', material.name,
                    'size:', fileSizeMB.toFixed(1) + 'MB');
            } else {
                console.log(`[Editor] 大文件(${fileSizeMB.toFixed(0)}MB)开启底层切片模式:`, material.name);
                material._arrayBuffer = null;
                material._isLargeFile = true;
                material.url = URL.createObjectURL(file);
            }

            this.getMediaDuration(material.url, type).then(dur => {
                material.duration = dur;
                this.renderMaterials();
                this._startAudioPreload(material);
            });

            if (type === 'video') {
                this.getMediaSize(material.url).then(size => {
                    if (size.w && size.h) {
                        material.width = size.w;
                        material.height = size.h;
                        console.log(`[素材] ${material.name} 原始尺寸: ${size.w} x ${size.h}`);
                    }
                });

                if (this.videoRenderer && this.videoRenderer.loadMaterial) {
                    this.videoRenderer.loadMaterial(material).then(() => {
                        console.log(`[Editor] Material loaded: ${material.name}`);
                    }).catch(err => {
                        console.error(`[Editor] Material load failed: ${material.name}`, err);
                    });
                }

                if (this.thumbPreloader) {
                    this.thumbPreloader.startPreload(material, null);
                }
            }
        } catch (err) {
            console.error('[Editor] 读取文件失败，降级为直接 File blob URL:', material.name, err.message);
            material.url = URL.createObjectURL(file);
            this.renderMaterials();
        }
    }

    async _readFileSafely(file) {
        try {
            return await file.arrayBuffer();
        } catch (e) {
            console.warn('[Editor] file.arrayBuffer() 失败，尝试 FileReader:', e.message);
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('File read failed'));
                reader.readAsArrayBuffer(file);
            });
        }
    }

    _startAudioPreload(material) {
        this.generateAudioWaveform(material).then(waveformData => {
            if (waveformData) {
                console.log('[音频波形] 预加载完成:', material.name, '点数:', waveformData.length);
                // 通知缩略图预加载可以继续级别2-5
                if (this.thumbPreloader) {
                    this.thumbPreloader.notifyAudioComplete(material.id);
                }
                // 如果时间轴已有该素材的 clip，立即重绘波形
                const clip = this.timelineClips.find(c => c.materialId === material.id);
                if (clip) {
                    this.renderTimeline();
                }
            }
        }).catch(e => {
            console.warn('[音频波形] 预加载失败:', material.name, e.message || e);
            if (this.thumbPreloader) {
                this.thumbPreloader.notifyAudioComplete(material.id);
            }
        });
    }

    /**
     * 获取媒体（视频/图片）的原始尺寸
     */
    getMediaSize(url) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.src = url;
            
            let resolved = false;
            const finish = (w, h) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                video.remove();
                resolve({ w, h });
            };
            
            const timer = setTimeout(() => finish(0, 0), 5000);
            
            video.addEventListener('loadedmetadata', () => {
                finish(video.videoWidth, video.videoHeight);
            });
            
            video.addEventListener('error', () => finish(0, 0));
        });
    }

    getFileType(file) {
        if (file.type.startsWith('video/')) return 'video';
        if (file.type.startsWith('audio/')) return 'audio';
        if (file.type.startsWith('image/')) return 'image';
        return null;
    }

    getMediaDuration(url, type) {
        return new Promise((resolve) => {
            const element = type === 'video' 
                ? document.createElement('video') 
                : document.createElement('audio');
            element.preload = 'metadata';
            element.muted = true;
            element.src = url;
            
            let resolved = false;
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(0);
                }
            }, 5000);
            
            element.addEventListener('loadedmetadata', () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(element.duration);
                }
            });
            
            element.addEventListener('error', () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(0);
                }
            });
        });
    }

    _getMaterialDurationFromVideo(material) {
        if (!material || !material.url) return 0;

        if (this.videoRenderer && this.videoRenderer._videoElements) {
            for (const [key, video] of this.videoRenderer._videoElements) {
                if (video._material && video._material.id === material.id && video.duration) {
                    return video.duration;
                }
            }
        }

        if (this.videoRenderer && this.videoRenderer.demuxers) {
            const demuxerInfo = this.videoRenderer.demuxers.get(material.url);
            if (demuxerInfo && demuxerInfo.demuxer && demuxerInfo.demuxer.videoTrack) {
                const track = demuxerInfo.demuxer.videoTrack;
                if (track.duration && track.timescale) {
                    return track.duration / track.timescale;
                }
            }
        }

        return 0;
    }

    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    showToast(message, type = 'success', duration = 3000) {
        const toast = document.getElementById('toast');
        const toastMessage = document.getElementById('toastMessage');

        if (!toast || !toastMessage) return;

        toastMessage.textContent = message;

        toast.style.background = type === 'success' ? 'var(--success-color)' :
                                 type === 'error' ? 'var(--danger-color)' :
                                 type === 'warning' ? 'var(--warning-color)' :
                                 type === 'info' ? 'var(--info-color, #4a90e2)' :
                                 'var(--success-color)';

        const icon = toast.querySelector('i');
        if (icon) {
            icon.className = type === 'success' ? 'fa-solid fa-check-circle' :
                            type === 'error' ? 'fa-solid fa-exclamation-circle' :
                            type === 'warning' ? 'fa-solid fa-exclamation-triangle' :
                            type === 'info' ? 'fa-solid fa-info-circle' :
                            'fa-solid fa-check-circle';
        }

        toast.style.display = 'flex';

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.style.display = 'none';
        }, duration);
    }

    formatDuration(seconds) {
        if (!seconds) return '--:--';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    formatTimeFull(seconds) {
        const fps = 30;
        const totalFrames = Math.floor(seconds * fps);
        const mins = Math.floor(totalFrames / (fps * 60));
        const secs = Math.floor((totalFrames % (fps * 60)) / fps);
        const frames = totalFrames % fps;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${frames.toString().padStart(2, '0')}`;
    }

    snapToFrame(time) {
        const fps = 30;
        const frameDuration = 1 / fps;
        return Math.round(time / frameDuration) * frameDuration;
    }

    /**
     * 预览播放头磁吸到最近的素材标记点（开头/结尾/断点）
     * 只在磁吸功能开启时生效，阈值比素材间磁吸更小（10px）
     */
    _snapPreviewPlayhead(time) {
        if (!this.snapClips) return time;

        const pixelThreshold = 10;
        const threshold = pixelThreshold / this.pixelsPerSecond;
        const markers = this._getSortedMarkers();

        let closest = time;
        let minDist = threshold;

        for (const marker of markers) {
            const dist = Math.abs(time - marker);
            if (dist < minDist) {
                minDist = dist;
                closest = marker;
            }
        }

        return closest;
    }

    deleteMaterial(id) {
        const index = this.materials.findIndex(m => m.id === id);
        if (index > -1) {
            URL.revokeObjectURL(this.materials[index].url);
            this.materials.splice(index, 1);
            this.renderMaterials();
            this.updateTypeCounts();
        }
    }

    renderMaterials() {
        const grid = document.getElementById('materialGrid');
        if (!grid) return;

        const activeTab = document.querySelector('.panel-tab-h.active')?.dataset.tab || 'material';
        const activeFilter = document.querySelector('.type-tag.active')?.dataset.type || 'all';

        let filtered = this.materials;

        if (activeTab === 'material') {
            filtered = filtered.filter(m => m.type !== 'text' && !m.isSubtitleAudio);
        } else if (activeTab === 'text') {
            filtered = filtered.filter(m => m.type === 'text' && !m.isSubtitleText);
        }

        if (activeFilter !== 'all') {
            filtered = filtered.filter(m => m.type === activeFilter);
        }

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="material-placeholder">
                <i class="fa-solid fa-cloud-arrow-up"></i>
                <p>点击"导入素材"按钮<br>或拖拽文件到此处</p>
            </div>`;
            return;
        }

        // 如果有需要重新定位的素材，显示批量重新定位按钮
        const needRelocateList = filtered.filter(m => m.needsRelocation);
        let headerHtml = '';
        if (needRelocateList.length > 0) {
            headerHtml = `
                <div class="relocate-all-banner">
                    <div class="relocate-all-info">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>${needRelocateList.length} 个素材需要重新定位</span>
                    </div>
                    <button class="relocate-all-btn" id="relocateAllBtn">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 一键重新定位
                    </button>
                </div>
            `;
        }

        grid.innerHTML = headerHtml + filtered.map(m => `
            <div class="material-item ${m.needsRelocation ? 'needs-relocation' : ''}" draggable="${m.needsRelocation ? 'false' : 'true'}" data-id="${m.id}">
                <div class="material-thumb">
                    ${this.getThumbContent(m)}
                    ${m.needsRelocation ? '' : `<button class="material-delete material-delete-btn" data-id="${m.id}">
                        <i class="fa-solid fa-xmark"></i>
                    </button>`}
                    ${m.needsRelocation ? '' : `<button class="material-add-btn" data-id="${m.id}">
                        <i class="fa-solid fa-plus"></i>
                    </button>`}
                    ${this.timelineClips.some(c => c.materialId === m.id)
                        ? '<div class="material-added-badge">已添加</div>' : ''}
                    ${m.needsRelocation ? `<button class="material-relocate-btn" data-id="${m.id}" title="点击选择本地文件恢复此素材">
                        <i class="fa-solid fa-link"></i> 重新定位
                    </button>` : ''}
                </div>
                <div class="material-info">
                    <div class="material-name" title="${m.name}">${m.name}${m.needsRelocation ? ' <i class="fa-solid fa-triangle-exclamation" style="color:var(--warning-color);font-size:11px;"></i>' : ''}</div>
                    <div class="material-meta">
                        <span>${this.getTypeLabel(m.type)}</span>
                        ${m.duration ? `<span>${this.formatDuration(m.duration)}</span>` : ''}
                        ${m.needsRelocation ? '<span style="color:var(--warning-color);">需重新定位</span>' : ''}
                    </div>
                </div>
            </div>
        `).join('');

        grid.querySelectorAll('.material-item').forEach(item => {
            const id = parseFloat(item.dataset.id);

            item.addEventListener('click', () => {
                this.previewMaterial(id);
            });

            if (!item.classList.contains('needs-relocation')) {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('materialId', id);
                    e.dataTransfer.effectAllowed = 'copy';
                });

                item.addEventListener('dblclick', () => {
                    this.addToTimeline(id);
                });
            }
        });

        grid.querySelectorAll('.material-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteMaterial(parseFloat(btn.dataset.id));
            });
        });

        grid.querySelectorAll('.material-add-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addToTimeline(parseFloat(btn.dataset.id));
            });
        });

        // 重新定位素材按钮
        grid.querySelectorAll('.material-relocate-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.relocateMaterial(parseFloat(btn.dataset.id));
            });
        });

        // 一键重新定位全部按钮
        const relocateAllBtn = grid.querySelector('#relocateAllBtn');
        if (relocateAllBtn) {
            relocateAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.relocateAllMaterials();
            });
        }
    }

    /**
     * 重新定位素材：用户选择本地文件，把它绑定到缺失的素材上
     */
    relocateMaterial(materialId) {
        const material = this.materials.find(m => m.id === materialId);
        if (!material) return;

        const input = document.createElement('input');
        input.type = 'file';
        // 根据素材类型设置 accept
        if (material.type === 'video') input.accept = 'video/*';
        else if (material.type === 'audio') input.accept = 'audio/*';
        else if (material.type === 'image') input.accept = 'image/*';
        else input.accept = '*/*';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // 简单校验：建议选择同名文件，但不强制
            if (file.name !== material.name) {
                const ok = confirm(`选择的文件名"${file.name}"与原素材"${material.name}"不一致，是否仍要使用此文件？`);
                if (!ok) return;
            }

            this._applyRelocateMaterial(material, file);
            this.renderMaterials();
            this.renderTimeline();
            this.showToast(`素材已重新定位: ${material.name}`, 'success');
        };
        input.click();
    }

    async _reinitMediaMaterial(material, file, type) {
        return new Promise((resolve) => {
            if (type === 'video') {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    material.duration = video.duration;
                    material.width = video.videoWidth;
                    material.height = video.videoHeight;
                    URL.revokeObjectURL(video.src);
                    resolve();
                };
                video.onerror = () => { URL.revokeObjectURL(video.src); resolve(); };
                video.src = URL.createObjectURL(file);
            } else if (type === 'audio') {
                const audio = document.createElement('audio');
                audio.preload = 'metadata';
                audio.onloadedmetadata = () => {
                    material.duration = audio.duration;
                    URL.revokeObjectURL(audio.src);
                    resolve();
                };
                audio.onerror = () => { URL.revokeObjectURL(audio.src); resolve(); };
                audio.src = URL.createObjectURL(file);
            } else {
                resolve();
            }
        });
    }

    getThumbContent(material) {
        if (material.type === 'video') {
            const cachedThumb = this.getCachedThumb(material.id, 1.0) || this.getCachedThumb(material.id, 0) || this.getCachedThumb(material.id, 2.0);
            if (cachedThumb) {
                return `<img src="${cachedThumb}" alt="${material.name}" class="material-thumb-img">`;
            }
            return `
                <div class="material-thumb-placeholder">
                    <i class="fa-solid fa-film"></i>
                    <span class="material-thumb-name">${material.name}</span>
                </div>
            `;
        } else if (material.type === 'image') {
            return `<img src="${material.url}" alt="${material.name}">`;
        } else if (material.type === 'audio') {
            return `<i class="fa-solid fa-music"></i>`;
        } else if (material.type === 'text') {
            // 文本素材：在素材库显示一个 canvas 缩略图，渲染该文字
            if (!window.textManager) window.textManager = new TextManager();
            const cached = window.textManager.getOrCreateTextImage(material);
            if (cached) {
                return `<img src="${cached.image.toDataURL('image/png')}" alt="${material.name}" class="material-thumb-img">`;
            }
            return `<div class="material-thumb-placeholder">
                <i class="fa-solid fa-font"></i>
                <span class="material-thumb-name">${material.name}</span>
            </div>`;
        }
        return '';
    }

    getTypeLabel(type) {
        const labels = { video: '视频', audio: '音频', image: '图片', text: '文本' };
        return labels[type] || type;
    }

    bindPlaceholderEvents() {
        const placeholder = document.querySelector('.material-placeholder');
        if (placeholder) {
            placeholder.addEventListener('click', () => {
                document.getElementById('fileInput')?.click();
            });
        }
    }

    bindTypeFilter() {
        document.querySelectorAll('.type-tag').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.type-tag').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                this.renderMaterials();
            });
        });
    }

    updateTypeCounts() {
        const counts = { video: 0, image: 0, audio: 0, text: 0 };
        this.materials.forEach(m => { if (counts[m.type] !== undefined) counts[m.type]++; });
        const total = this.materials.length;

        document.querySelectorAll('.type-tag').forEach(item => {
            const type = item.dataset.type;
            if (type === 'all') {
                item.textContent = `全部(${total})`;
            } else if (counts[type] !== undefined) {
                const label = this.getTypeLabel(type);
                item.textContent = `${label}(${counts[type]})`;
            }
        });
    }

    getTypeLabelFromTag(tag) {
        return this.getTypeLabel(tag);
    }

    previewMaterial(id) {
        const material = this.materials.find(m => m.id === id);
        if (!material) return;

        const placeholder = document.getElementById('previewPlaceholder');
        if (placeholder) placeholder.style.display = 'none';
        
        this.updatePreviewLayers();
    }

    bindPlayControl() {
        const playBtn = document.getElementById('playBtn');
        if (playBtn) {
            playBtn.addEventListener('click', () => this.togglePlay());
        }
    }

    startPlayheadAnimation() {
        this.playheadStartTime = performance.now();
        this.playheadStartPos = this.currentTime;
        this.animatePlayhead();
    }

    stopPlayheadAnimation() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    animatePlayhead() {
        if (!this.isPlaying) return;
        
        if (this.videoRenderer) {
            this.currentTime = this.videoRenderer.currentTime;
        } else {
            const now = performance.now();
            const elapsed = (now - this.playheadStartTime) / 1000;
            this.currentTime = this.playheadStartPos + elapsed;
        }

        if (this.currentTime >= this.totalDuration) {
            this.currentTime = this.totalDuration;
            this.togglePlay();
            return;
        }

        this.updatePlayheadPosition();
        this.animationFrame = requestAnimationFrame(() => this.animatePlayhead());
    }

    updatePlayheadPosition() {
        const playhead = document.getElementById('playhead');
        if (playhead) {
            playhead.style.left = (this.currentTime * this.pixelsPerSecond) + 'px';
        }

        const timeDisplay = document.getElementById('timeCurrent');
        if (timeDisplay) {
            timeDisplay.textContent = this.formatTimeFull(this.currentTime);
        }

        const totalDisplay = document.getElementById('timeTotal');
        if (totalDisplay) {
            totalDisplay.textContent = this.formatTimeFull(this.totalDuration);
        }

        this._updateKeyframeButtonState();
    }

    _updateKeyframeButtonState() {
        const kfBtn = document.querySelector('.tl-tool-btn[title="关键帧"]');
        if (!kfBtn) return;
        if (!this.selectedClipId) {
            kfBtn.classList.remove('active');
            return;
        }
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip || !clip.keyframes || clip.keyframes.length === 0) {
            kfBtn.classList.remove('active');
            return;
        }
        const clipTime = this.currentTime - clip.startTime;
        if (clipTime < 0 || clipTime > clip.duration) {
            kfBtn.classList.remove('active');
            return;
        }
        const hasKf = clip.keyframes.some(k => Math.abs(k.time - clipTime) < 0.05);
        kfBtn.classList.toggle('active', hasKf);
    }

    updatePreviewLayers() {
        if (!this.videoRenderer) return;

        this.videoRenderer.setClips(this.timelineClips);
        this.videoRenderer.seek(this.currentTime);
    }

    syncCurrentClipEffectsFromKeyframes() {
        if (!this.selectedClipId) return;
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip || !clip.keyframes || clip.keyframes.length === 0) return;
        
        const interpolated = this.getInterpolatedEffects(clip, this.currentTime);
        this.currentClipEffects = { ...interpolated };
        if (this.currentClipEffects.scaleX === undefined) {
            this.currentClipEffects.scaleX = this.currentClipEffects.scale || 100;
        }
        if (this.currentClipEffects.scaleY === undefined) {
            this.currentClipEffects.scaleY = this.currentClipEffects.scale || 100;
        }
        this.updatePropertiesPanel();
    }

    togglePlay() {
        this.isPlaying = !this.isPlaying;
        this.updatePlayButton();
        
        if (this.isPlaying) {
            if (this.videoRenderer) {
                this.videoRenderer.setClips(this.timelineClips);
                this.videoRenderer.initAudio();
                this.videoRenderer.resumeAudio();
                this.videoRenderer.play();
            }
            this.startPlayheadAnimation();
        } else {
            this.stopPlayheadAnimation();
            if (this.videoRenderer) {
                this.videoRenderer.pause();
                this.currentTime = this.videoRenderer.currentTime;
            }
        }
    }

    updatePlayButton() {
        const playBtn = document.getElementById('playBtn');
        if (!playBtn) return;
        const icon = playBtn.querySelector('i');
        if (!icon) return;
        
        if (this.isPlaying) {
            icon.classList.remove('fa-play');
            icon.classList.add('fa-pause');
        } else {
            icon.classList.remove('fa-pause');
            icon.classList.add('fa-play');
        }
    }

    addToTimeline(materialId, trackIndex = 0) {
        const material = this.materials.find(m => m.id === materialId);
        if (!material) return;

        let duration = material.duration;
        if (!duration) {
            duration = this._getMaterialDurationFromVideo(material);
        }
        if (!duration) {
            duration = 5;
        }
        
        // 根据素材类型自动选择轨道和起始时间
        let startTime = this.currentTime; // 默认对齐播放头
        let finalTrack = trackIndex;

        if (material.type === 'audio') {
            // 音频素材：找第一个有空间的音频轨道
            finalTrack = this._findAvailableAudioTrack(startTime, duration);
        } else if (trackIndex === 0 && material.type !== 'video') {
            // 非视频素材且未指定轨道：找主轨道上方第一个有空间的画中画轨道
            finalTrack = this._findAvailableVideoTrack(startTime, duration);
        } else if (trackIndex === 0 && material.type === 'video') {
            // 视频素材且未指定轨道：先检查主轨道是否有空间，没有则找画中画
            const hasSpace = !this._hasOverlapOnTrack(0, startTime, duration, null);
            if (!hasSpace) {
                finalTrack = this._findAvailableVideoTrack(startTime, duration);
            }
        }
        
        const sameTrackClips = this.timelineClips.filter(c => c.trackIndex === finalTrack);
        // 如果指定了 trackIndex=0 且调用方未指定时间，追加到末尾
        if (trackIndex !== undefined && arguments.length > 1 && startTime === 0 && sameTrackClips.length > 0) {
            const lastClip = sameTrackClips.reduce((a, b) => 
                (a.startTime + a.duration) > (b.startTime + b.duration) ? a : b
            );
            startTime = lastClip.startTime + lastClip.duration;
        }

        const clip = {
            id: Date.now() + Math.random(),
            materialId: materialId,
            material: material,
            startTime: startTime,
            duration: duration,
            offset: 0,
            trackIndex: finalTrack,
            effects: { ...this.currentClipEffects }
        };

        this.timelineClips.push(clip);
        
        if (finalTrack < 100 && finalTrack >= this.videoTrackCount) {
            this.videoTrackCount = finalTrack + 1;
        }

        // 如果是第一个视频素材添加到时间轴，自动根据视频原始尺寸设置画布比例
        if (material.type === 'video') {
            const hasVideoInTimeline = this.timelineClips.some(c => c.id !== clip.id && c.material && c.material.type === 'video');
            if (!hasVideoInTimeline && this.videoRenderer) {
                this._autoSetCanvasRatioFromMaterial(material);
            }
        }
        
        this.selectClip(clip.id);
        this.updateTotalDuration();
        this.renderMaterials();

        if (this.snapMainTrack && clip.trackIndex === this.mainTrackIndex) {
            this.applyMainTrackSnap();
        }

        // 更新视频引擎的片段列表
        if (this.videoRenderer) {
            this.videoRenderer.setClips(this.timelineClips);
        }

        this.pushHistory('添加素材');
    }

    addTextToTimeline() {
        if (!window.textManager) {
            window.textManager = new TextManager();
        }

        // 创建默认文本素材
        const material = TextManager.createDefaultMaterial();
        // 让默认文本根据画布宽度自适应
        material.textData.maxWidth = Math.max(400, Math.min(1600, this.videoEngine ? (this.videoEngine.canvasW * 0.6) : 1200));
        this.materials.push(material);
        if (window.textManager) window.textManager.invalidate(material.id);

        // 选择一个可用的视频轨道
        const startTime = this.currentTime;
        const duration = material.duration;
        let finalTrack = this._findAvailableVideoTrack(startTime, duration);

        const clip = {
            id: Date.now() + Math.random(),
            materialId: material.id,
            material: material,
            startTime: startTime,
            duration: duration,
            offset: 0,
            trackIndex: finalTrack,
            effects: {
                ...this.currentClipEffects,
                posX: 0,
                posY: 0
            },
            keyframes: []
        };

        this.timelineClips.push(clip);

        if (finalTrack < 100 && finalTrack >= this.videoTrackCount) {
            this.videoTrackCount = finalTrack + 1;
        }

        this.selectClip(clip.id);
        this.updateTotalDuration();
        this.renderMaterials();

        if (this.snapMainTrack && clip.trackIndex === this.mainTrackIndex) {
            this.applyMainTrackSnap();
        }

        if (this.videoRenderer) {
            this.videoRenderer.setClips(this.timelineClips);
        }

        this.updatePropertiesPanel();
        this.pushHistory('添加文本');
    }

    // ============= 字幕功能 =============
    _ensureTtsManager() {
        if (!window.ttsManager) {
            window.ttsManager = new TTSManager();
        }
        return window.ttsManager;
    }

    updateTtsVoiceSelect() {
        const voiceSelect = document.getElementById('subtitleTtsVoice');
        const providerSelect = document.getElementById('subtitleTtsProvider');
        if (!voiceSelect) return;

        const tts = this._ensureTtsManager();
        const provider = providerSelect ? providerSelect.value : tts.currentProvider;
        const voices = tts.getVoices(provider);

        const currentValue = voiceSelect.value;
        voiceSelect.innerHTML = '';
        voices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.name;
            voiceSelect.appendChild(opt);
        });

        if (currentValue && voices.some(v => v.id === currentValue)) {
            voiceSelect.value = currentValue;
        }
    }

    _initSubtitleModal() {
        if (this._subtitleModalInited) return;
        this._subtitleModalInited = true;

        const modal = document.getElementById('subtitleModal');
        if (!modal) return;

        const tts = this._ensureTtsManager();

        const providerSelect = document.getElementById('subtitleTtsProvider');
        const azureConfigGroup = document.getElementById('azureConfigGroup');
        const voiceSelect = document.getElementById('subtitleTtsVoice');
        const azureKeyInput = document.getElementById('azureKey');
        const azureRegionSelect = document.getElementById('azureRegion');

        const refreshVoices = () => {
            if (!voiceSelect) return;
            voiceSelect.innerHTML = '';
            const provider = providerSelect ? providerSelect.value : 'webspeech';
            tts.setProvider(provider);
            const voices = tts.getVoices(provider);
            voices.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = v.name;
                voiceSelect.appendChild(opt);
            });
            if (azureConfigGroup) {
                azureConfigGroup.style.display = provider === 'azure' ? 'block' : 'none';
            }
        };

        this._refreshSubtitleVoices = refreshVoices;

        // 配音开关切换
        const ttsEnabled = document.getElementById('subtitleTtsEnabled');
        const ttsOptions = document.getElementById('subtitleTtsOptions');

        const updateTtsOptionsState = () => {
            if (!ttsOptions) return;
            const enabled = ttsEnabled && ttsEnabled.checked;
            ttsOptions.style.opacity = enabled ? '1' : '0.4';
            ttsOptions.style.pointerEvents = enabled ? 'auto' : 'none';
            ttsOptions.style.userSelect = enabled ? 'auto' : 'none';
        };

        this._updateTtsOptionsState = updateTtsOptionsState;

        if (ttsEnabled) {
            ttsEnabled.addEventListener('change', updateTtsOptionsState);
        }
        updateTtsOptionsState();

        // 绑定单选切换：显示/隐藏每句字数输入
        const modeRadios = document.querySelectorAll('input[name="subtitleSplitMode"]');
        const charCountGroup = document.getElementById('subtitleCharCountGroup');
        modeRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                if (charCountGroup) {
                    charCountGroup.style.display = radio.value === 'charCount' && radio.checked ? 'block' : 'none';
                }
            });
        });

        // 配音提供商切换
        if (providerSelect) {
            providerSelect.addEventListener('change', refreshVoices);
        }

        // 保存 Azure 配置
        const saveAzureBtn = document.getElementById('saveAzureConfigBtn');
        if (saveAzureBtn) {
            saveAzureBtn.addEventListener('click', () => {
                const key = azureKeyInput ? azureKeyInput.value.trim() : '';
                const region = azureRegionSelect ? azureRegionSelect.value : 'eastasia';
                if (!key) {
                    this.showToast('请输入 API Key', 'error');
                    return;
                }
                tts.setAzureConfig(key, region);
                this.showToast('配置已保存', 'success');
                refreshVoices();
            });
        }

        // 试听按钮
        const previewBtn = document.getElementById('subtitleTtsPreviewBtn');
        if (previewBtn) {
            previewBtn.addEventListener('click', async () => {
                const textArea = document.getElementById('subtitleText');
                if (!textArea || !textArea.value.trim()) {
                    this.showToast('请先输入字幕文本', 'warning');
                    return;
                }
                const firstSentence = this._stripPunctuation(textArea.value.trim().split(/[，。！？,.!?\n]/)[0] || textArea.value.trim().slice(0, 20));
                if (!firstSentence) {
                    this.showToast('没有可试听的内容', 'warning');
                    return;
                }
                try {
                    const provider = providerSelect ? providerSelect.value : 'webspeech';
                    const voice = voiceSelect ? voiceSelect.value : '';
                    const rate = parseFloat(document.getElementById('subtitleTtsRate')?.value || 1);
                    const pitch = parseFloat(document.getElementById('subtitleTtsPitch')?.value || 1);
                    const volume = parseFloat(document.getElementById('subtitleTtsVolume')?.value || 1);

                    if (provider === 'azure') {
                        const currentKey = azureKeyInput ? azureKeyInput.value.trim() : '';
                        const currentRegion = azureRegionSelect ? azureRegionSelect.value : 'eastasia';
                        
                        if (!currentKey && !tts.azureKey) {
                            this.showToast('请先输入 Azure API Key 并保存配置', 'error');
                            return;
                        }
                        
                        if (currentKey) {
                            tts.setAzureConfig(currentKey, currentRegion);
                        }
                    }

                    tts.setProvider(provider);

                    previewBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 试听中...';
                    previewBtn.disabled = true;

                    await tts.speak(firstSentence, { voice, rate, pitch, volume });
                } catch (e) {
                    console.error('[TTS] 试听失败:', e);
                    const errMsg = (e.message || e) + '';
                    if (errMsg.includes('No audio was received') || 
                        errMsg.includes('未收到音频数据') || 
                        errMsg.includes('verify that your parameters are correct') ||
                        errMsg.includes('语音合成失败')) {
                        this.showToast('暂无这个音色，试试其他音色吧', 'warning');
                    } else if (errMsg.includes('超时') || 
                               errMsg.includes('暂时不可用') ||
                               errMsg.includes('502') ||
                               errMsg.includes('504')) {
                        this.showToast('当前音色暂时不可用，请换一个音色试试，或请使用国内网络', 'warning');
                    } else {
                        this.showToast('试听失败: ' + errMsg, 'error');
                    }
                } finally {
                    previewBtn.innerHTML = '<i class="fa-solid fa-play"></i> 试听第一句';
                    previewBtn.disabled = false;
                }
            });
        }

        // 绑定关闭/取消/确认
        const closeBtn = document.getElementById('subtitleModalClose');
        const cancelBtn = document.getElementById('subtitleCancelBtn');
        const confirmBtn = document.getElementById('subtitleConfirmBtn');

        const closeModal = () => {
            modal.style.display = 'none';
            tts.stop();
        };

        if (closeBtn) closeBtn.onclick = closeModal;
        if (cancelBtn) cancelBtn.onclick = closeModal;
        if (confirmBtn) confirmBtn.onclick = () => {
            this.createSubtitlesFromModal();
            closeModal();
        };

        // 点击遮罩关闭
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };
    }

    openSubtitleModal() {
        this._initSubtitleModal();

        const modal = document.getElementById('subtitleModal');
        if (!modal) return;
        modal.style.display = 'flex';
        const textArea = document.getElementById('subtitleText');
        if (textArea) textArea.focus();

        const tts = this._ensureTtsManager();

        // 填充 Azure 配置
        const azureKeyInput = document.getElementById('azureKey');
        const azureRegionSelect = document.getElementById('azureRegion');
        if (azureKeyInput) azureKeyInput.value = tts.azureKey || '';
        if (azureRegionSelect) azureRegionSelect.value = tts.azureRegion || 'eastasia';

        const providerSelect = document.getElementById('subtitleTtsProvider');
        if (providerSelect) {
            providerSelect.value = tts.currentProvider || 'edgetts';
        }
        if (this._refreshSubtitleVoices) {
            this._refreshSubtitleVoices();
        }

        // 更新配音开关状态
        if (typeof this._updateTtsOptionsState === 'function') {
            this._updateTtsOptionsState();
        }

        // 尝试从后端服务器刷新音色列表（异步，不阻塞UI）
        if (tts.currentProvider === 'edgetts' && typeof tts._loadVoicesFromServer === 'function') {
            (async () => {
                try {
                    await tts._loadVoicesFromServer(true);
                    if (this._refreshSubtitleVoices) {
                        this._refreshSubtitleVoices();
                    }
                } catch (e) {
                    // 静默失败，使用默认列表
                }
            })();
        }
    }

    createSubtitlesFromModal() {
        const textArea = document.getElementById('subtitleText');
        const modeRadios = document.querySelectorAll('input[name="subtitleSplitMode"]');
        const charCountInput = document.getElementById('subtitleCharCount');
        const durationInput = document.getElementById('subtitleDuration');
        const styleRadios = document.querySelectorAll('input[name="subtitleStyle"]');
        const ttsEnabled = document.getElementById('subtitleTtsEnabled');
        const providerSelect = document.getElementById('subtitleTtsProvider');
        const voiceSelect = document.getElementById('subtitleTtsVoice');
        const rateInput = document.getElementById('subtitleTtsRate');
        const pitchInput = document.getElementById('subtitleTtsPitch');
        const volumeInput = document.getElementById('subtitleTtsVolume');

        const text = textArea ? textArea.value.trim() : '';
        if (!text) {
            this.showToast('请输入字幕文本', 'error');
            return;
        }

        let mode = 'punctuation';
        modeRadios.forEach(r => { if (r.checked) mode = r.value; });

        let style = 'default';
        styleRadios.forEach(r => { if (r.checked) style = r.value; });

        const charCount = charCountInput ? parseInt(charCountInput.value, 10) || 20 : 20;
        const perCharDuration = durationInput ? parseFloat(durationInput.value) || 0.25 : 0.25;

        const useTts = ttsEnabled && ttsEnabled.checked;
        let ttsConfig = null;

        if (useTts) {
            const tts = this._ensureTtsManager();
            const provider = providerSelect ? providerSelect.value : 'webspeech';
            const voice = voiceSelect ? voiceSelect.value : '';
            const rate = rateInput ? parseFloat(rateInput.value) || 1 : 1;
            const pitch = pitchInput ? parseFloat(pitchInput.value) || 1 : 1;
            const volume = volumeInput ? parseFloat(volumeInput.value) || 1 : 1;

            tts.setProvider(provider);

            ttsConfig = {
                provider: provider,
                voice: voice,
                rate: rate,
                pitch: pitch,
                volume: volume
            };

            if (provider === 'azure') {
                const azureKeyInput = document.getElementById('azureKey');
                const azureRegionSelect = document.getElementById('azureRegion');
                const currentKey = azureKeyInput ? azureKeyInput.value.trim() : '';
                const currentRegion = azureRegionSelect ? azureRegionSelect.value : 'eastasia';

                if (!currentKey && !tts.azureKey) {
                    this.showToast('请先配置 Azure API Key', 'error');
                    return;
                }

                if (currentKey) {
                    tts.setAzureConfig(currentKey, currentRegion);
                }
            }
        }

        const sentences = this._splitSubtitleText(text, mode, charCount);
        if (sentences.length === 0) {
            this.showToast('没有可生成的字幕内容', 'error');
            return;
        }

        this.createSubtitles(sentences, { perCharDuration, style, tts: ttsConfig });
        if (textArea) textArea.value = '';
    }

    /**
     * 分割字幕文本
     */
    _splitSubtitleText(text, mode, charCount) {
        if (mode === 'charCount') {
            const result = [];
            for (let i = 0; i < text.length; i += charCount) {
                const chunk = text.slice(i, i + charCount).trim();
                if (chunk) result.push(chunk);
            }
            return result;
        }

        // 按标点分割：先按换行/句号/问号/感叹号分割，再按逗号细分过长的句子
        const rawSentences = text
            .replace(/\r\n/g, '\n')
            .split(/[。！？\n]+/)
            .map(s => s.trim())
            .filter(s => s.length > 0);

        const result = [];
        for (const sentence of rawSentences) {
            // 如果整句不超过 40 字且包含逗号，按逗号再分细一点
            if (sentence.length <= 40 && sentence.includes('，')) {
                const commaParts = sentence.split('，').map(s => s.trim()).filter(s => s);
                for (const part of commaParts) {
                    if (part) result.push(part);
                }
            } else if (sentence.length > 40) {
                // 长句按逗号切，避免单句过长
                const commaParts = sentence.split('，').map(s => s.trim()).filter(s => s);
                for (const part of commaParts) {
                    if (part) result.push(part);
                }
            } else {
                result.push(sentence);
            }
        }
        return result.length > 0 ? result : [text];
    }

    /**
     * 批量创建字幕并添加到时间轴
     * @param {string[]} sentences 字幕句子数组
     * @param {Object} options { perCharDuration, style, tts }
     */
    createSubtitles(sentences, options = {}) {
        if (!window.textManager) window.textManager = new TextManager();

        const { perCharDuration = 0.25, style = 'default', tts = null } = options;
        const groupId = 'subgroup_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
        const startTime = this.currentTime;

        const createdClipIds = [];
        let currentStart = startTime;
        let totalDuration = 0;
        const clipDurations = [];
        const ttsTexts = [];

        // 先计算每句时长和总时长
        for (let i = 0; i < sentences.length; i++) {
            const cleanText = this._stripPunctuation(sentences[i]);
            ttsTexts.push(cleanText);
            let dur;
            if (tts) {
                const ttsMgr = this._ensureTtsManager();
                dur = Math.max(0.5, ttsMgr.estimateDuration(cleanText, tts.rate || 1));
            } else {
                const charCount = Math.max(1, cleanText.length);
                dur = Math.max(0.5, charCount * perCharDuration);
            }
            clipDurations.push(dur);
            totalDuration += dur;
        }

        let finalTrack = this._findAvailableVideoTrack(startTime, totalDuration);

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            const cleanText = ttsTexts[i];
            const duration = clipDurations[i];
            const material = TextManager.createSubtitleMaterial(cleanText, style);
            material.duration = duration;
            material.isSubtitleText = true;
            this.materials.push(material);
            if (window.textManager) window.textManager.invalidate(material.id);

            const clip = {
                id: 'clip_' + Date.now() + '_' + Math.floor(Math.random() * 1000000) + '_' + i,
                materialId: material.id,
                material: material,
                startTime: currentStart,
                duration: duration,
                offset: 0,
                trackIndex: finalTrack,
                effects: {
                    posX: 0,
                    posY: 0,
                    scale: 100,
                    scaleX: 100,
                    scaleY: 100,
                    rotation: 0,
                    opacity: 100,
                    brightness: 0,
                    contrast: 0,
                    saturation: 0,
                    speed: 1,
                    volume: 100,
                    blur: 0
                },
                keyframes: [],
                subtitleGroupId: groupId,
                subtitleIndex: i
            };

            this.timelineClips.push(clip);
            createdClipIds.push(clip.id);
            currentStart += duration;
        }

        if (finalTrack < 100 && finalTrack >= this.videoTrackCount) {
            this.videoTrackCount = finalTrack + 1;
        }

        this.updateTotalDuration();
        this.renderMaterials();

        if (this.snapMainTrack) {
            this.applyMainTrackSnap();
        }

        if (this.videoRenderer) {
            this.videoRenderer.setClips(this.timelineClips);
        }

        if (createdClipIds.length > 0) {
            this.selectClip(createdClipIds[0]);
        }
        this.updatePropertiesPanel();
        this.pushHistory('新建字幕');

        if (tts && (tts.provider === 'edgetts' || tts.provider === 'azure')) {
            console.log('[字幕配音] 开始生成配音，provider:', tts.provider, '句子数:', ttsTexts.length);
            const ttsMgr = this._ensureTtsManager();
            if (tts.provider === 'azure') {
                console.log('[字幕配音] Azure Key 状态:', ttsMgr.azureKey ? '已配置' : '未配置', '区域:', ttsMgr.azureRegion);
            }

            const testText = ttsTexts[0] ? ttsTexts[0].slice(0, 5) : '测试';
            const loadingOverlay = document.getElementById('loadingOverlay');
            const loadingText = document.querySelector('.loading-text') || document.querySelector('.loading-content p');
            const loadingProgress = document.querySelector('.loading-progress');
            const loadingDetail = document.querySelector('.loading-detail');

            if (loadingOverlay) {
                if (loadingText) loadingText.textContent = '正在测试音色...';
                if (loadingProgress) loadingProgress.style.display = 'none';
                if (loadingDetail) {
                    loadingDetail.style.display = 'block';
                    loadingDetail.textContent = '请稍候';
                }
                loadingOverlay.classList.add('show');
            }

            ttsMgr.synthesizeToMP3(testText, {
                voice: tts.voice,
                rate: tts.rate,
                pitch: tts.pitch,
                volume: tts.volume
            }).then(() => {
                if (loadingOverlay) loadingOverlay.classList.remove('show');

                this.showToast(`已生成 ${sentences.length} 句字幕，正在生成配音...`, 'info', 3000);
                this._generateSubtitleAudio(groupId, ttsTexts, tts, startTime, finalTrack)
                    .then(result => {
                        console.log('[字幕配音] 生成完成，成功:', result.generated, '失败:', result.failed, '共:', result.total);
                        if (result.failed === 0) {
                            this.showToast(`配音生成完成，共 ${result.generated} 段音频`, 'success');
                        } else if (result.generated > 0) {
                            this.showToast(`配音生成完成：成功 ${result.generated} 段，失败 ${result.failed} 段（部分音色可能暂不可用）`, 'warning');
                        } else {
                            this.showToast('配音生成失败，建议更换音色后重试', 'error');
                        }
                    })
                    .catch(err => {
                        console.error('[字幕配音] 生成失败:', err);
                        this.showToast('配音生成失败: ' + (err.message || err), 'error');
                    });
            }).catch(err => {
                if (loadingOverlay) loadingOverlay.classList.remove('show');

                console.warn('[字幕配音] 音色测试失败:', err);
                const errMsg = err.message || String(err);
                const isVoiceError = errMsg.includes('No audio was received') ||
                    errMsg.includes('verify that your parameters are correct') ||
                    errMsg.includes('未收到音频数据') ||
                    errMsg.includes('语音合成失败') ||
                    errMsg.includes('超时') ||
                    errMsg.includes('暂时不可用') ||
                    errMsg.includes('502') ||
                    errMsg.includes('504');

                if (isVoiceError) {
                    this.showToast('当前音色暂不可用，请更换其他音色后重试，或请使用国内网络', 'warning');
                } else {
                    this.showToast('音色测试失败: ' + (err.message || err), 'error');
                }
            });
        } else {
            console.log('[字幕] 不生成配音，tts config:', tts);
            this.showToast(`已生成 ${sentences.length} 句关联字幕`, 'success');
        }
    }

    /**
     * 裁剪音频Blob末尾的静音部分
     * 使用Web Audio API分析采样数据，找到实际的语音结束点
     * @param {Blob} audioBlob 原始音频Blob
     * @param {number} silenceThreshold 静音阈值 (0-1)
     * @returns {Promise<{blob: Blob, duration: number}>} 裁剪后的音频和实际时长
     */
    async _trimAudioSilence(audioBlob, silenceThreshold = 0.01) {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const audioContext = new AudioContext();

        try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const sampleRate = audioBuffer.sampleRate;
            const channels = audioBuffer.numberOfChannels;
            const totalSamples = audioBuffer.length;
            const originalDuration = audioBuffer.duration;

            // 合并所有声道的采样数据（取平均值）
            const mixedData = new Float32Array(totalSamples);
            for (let ch = 0; ch < channels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < totalSamples; i++) {
                    mixedData[i] += channelData[i] / channels;
                }
            }

            // 从末尾开始扫描，找到最后一个超过阈值的样本点
            let lastNonSilentIndex = -1;
            for (let i = totalSamples - 1; i >= 0; i--) {
                if (Math.abs(mixedData[i]) >= silenceThreshold) {
                    lastNonSilentIndex = i;
                    break;
                }
            }

            // 如果没有找到任何非静音样本，或者音频太短，返回原音频
            if (lastNonSilentIndex < 0 || lastNonSilentIndex < totalSamples * 0.5) {
                return { blob: audioBlob, duration: originalDuration };
            }

            // 添加50ms的淡出过渡
            const fadeOutSamples = Math.floor(0.05 * sampleRate);
            const newLength = lastNonSilentIndex + 1 + fadeOutSamples;
            const newDuration = newLength / sampleRate;

            // 只在确实有静音需要裁剪时才处理（至少裁剪0.1秒）
            if (newDuration >= originalDuration - 0.1) {
                return { blob: audioBlob, duration: originalDuration };
            }

            // 创建新的AudioBuffer
            const newAudioBuffer = audioContext.createBuffer(
                channels,
                newLength,
                sampleRate
            );

            for (let ch = 0; ch < channels; ch++) {
                const oldData = audioBuffer.getChannelData(ch);
                const newData = newAudioBuffer.getChannelData(ch);
                for (let i = 0; i < newLength; i++) {
                    // 添加淡出效果，避免裁剪处有爆音
                    let gain = 1;
                    if (i > lastNonSilentIndex) {
                        gain = 1 - (i - lastNonSilentIndex) / fadeOutSamples;
                    }
                    newData[i] = oldData[i] * gain;
                }
            }

            // 将AudioBuffer编码为WAV格式
            const wavBlob = this._audioBufferToWav(newAudioBuffer);
            console.log('[配音] 静音裁剪: 原始时长', originalDuration.toFixed(2), '→', newDuration.toFixed(2), '秒, 裁剪了', (originalDuration - newDuration).toFixed(2), '秒');
            return { blob: wavBlob, duration: newDuration };

        } finally {
            audioContext.close();
        }
    }

    /**
     * 将AudioBuffer转换为WAV格式的Blob
     */
    _audioBufferToWav(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const format = 1; // PCM
        const bitDepth = 16;
        const bytesPerSample = bitDepth / 8;
        const blockAlign = numChannels * bytesPerSample;

        const dataLength = audioBuffer.length * numChannels * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);

        // WAV文件头
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeString(36, 'data');
        view.setUint32(40, dataLength, true);

        // 写入PCM数据
        const offset = 44;
        for (let i = 0; i < audioBuffer.length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                const sample = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
                const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(offset + (i * numChannels + ch) * bytesPerSample, intSample, true);
            }
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    /**
     * 异步生成字幕配音
     * 确保每段音频与对应的字幕在时间轴上完全对齐
     */
    async _generateSubtitleAudio(groupId, texts, ttsConfig, startTime, subtitleTrack) {
        const loadingOverlay = document.getElementById('loadingOverlay');
        const loadingProgressBar = document.querySelector('.loading-progress-bar');
        const loadingDetail = document.querySelector('.loading-detail');
        const loadingProgress = document.querySelector('.loading-progress');
        const loadingText = document.querySelector('.loading-text') || document.querySelector('.loading-content p');

        if (loadingOverlay) {
            if (loadingText) loadingText.textContent = '正在生成配音...';
            if (loadingProgress) loadingProgress.style.display = 'block';
            if (loadingDetail) loadingDetail.style.display = 'block';
            if (loadingProgressBar) loadingProgressBar.style.width = '0%';
            if (loadingDetail) loadingDetail.textContent = `第 1/${texts.length} 句`;
            loadingOverlay.classList.add('show');
        }

        try {
            const tts = this._ensureTtsManager();
            const subtitleClips = this.timelineClips.filter(c => c.subtitleGroupId === groupId && c.material?.type === 'text');

            let generatedCount = 0;
            let failedCount = 0;
            const audioTrackStart = 100;

            for (let i = 0; i < texts.length; i++) {
                const text = texts[i];
                if (!text) continue;

                if (loadingDetail) {
                    loadingDetail.textContent = `第 ${i + 1}/${texts.length} 句`;
                }

                try {
                    const audioBlob = await tts.synthesizeToMP3(text, {
                        voice: ttsConfig.voice,
                        rate: ttsConfig.rate,
                        pitch: ttsConfig.pitch,
                        volume: ttsConfig.volume
                    });

                    const trimmedResult = await this._trimAudioSilence(audioBlob, 0.008, 0.25);
                    const finalBlob = trimmedResult.blob;
                    const finalDuration = trimmedResult.duration;

                    const audioUrl = URL.createObjectURL(finalBlob);
                    const audioArrayBuffer = await finalBlob.arrayBuffer();
                    const audioMat = {
                        id: 'audio_sub_' + groupId + '_' + i,
                        name: '配音 ' + (i + 1) + ': ' + text.slice(0, 10) + (text.length > 10 ? '...' : ''),
                        type: 'audio',
                        size: finalBlob.size,
                        url: audioUrl,
                        duration: finalDuration,
                        _blob: finalBlob,
                        _arrayBuffer: audioArrayBuffer,
                        isSubtitleAudio: true
                    };

                    this.materials.push(audioMat);

                    // 立即将音频blob持久化到IndexedDB，防止刷新后丢失
                    if (this.projectStorage && this.projectStorage.db) {
                        this.projectStorage.saveMaterialBlob(audioMat.id, finalBlob).catch(() => {});
                    }

                    const subClip = subtitleClips.find(c => c.subtitleIndex === i);

                    let audioStartTime;
                    if (subClip) {
                        audioStartTime = subClip.startTime;
                    } else {
                        audioStartTime = startTime;
                    }

                    const audioClip = {
                        id: 'audioclip_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 10000),
                        materialId: audioMat.id,
                        material: audioMat,
                        startTime: audioStartTime,
                        duration: finalDuration,
                        offset: 0,
                        trackIndex: audioTrackStart,
                        effects: {
                            posX: 0, posY: 0,
                            scale: 100, scaleX: 100, scaleY: 100,
                            rotation: 0,
                            opacity: 100,
                            brightness: 0, contrast: 0, saturation: 0,
                            speed: 1,
                            volume: 100,
                            blur: 0
                        },
                        keyframes: [],
                        subtitleGroupId: groupId,
                        subtitleIndex: i,
                        isSubtitleAudio: true
                    };

                    this.timelineClips.push(audioClip);

                    if (subClip) {
                        subClip.duration = finalDuration;
                    }

                    generatedCount++;

                    if (typeof this._startAudioPreload === 'function') {
                        this._startAudioPreload(audioMat);
                    }

                } catch (err) {
                    console.warn('[配音] 第', i + 1, '句生成失败:', err);
                    failedCount++;
                }

                if (loadingProgressBar) {
                    loadingProgressBar.style.width = `${((i + 1) / texts.length) * 100}%`;
                }
            }

            this._repositionSubtitleGroup(groupId);

            this.updateTotalDuration();
            this.renderMaterials();
            this.renderTimeline();

            if (this.videoRenderer) {
                this.videoRenderer.setClips(this.timelineClips);
            }

            return { generated: generatedCount, failed: failedCount, total: texts.length };
        } finally {
            if (loadingOverlay) {
                loadingOverlay.classList.remove('show');
            }
        }
    }

    /**
     * 重新定位字幕组内所有clip的位置，确保它们连续排列
     * 只处理字幕clips（文本类型），音频clips跟随对应字幕
     */
    _repositionSubtitleGroup(groupId) {
        // 只获取字幕clips（文本类型）
        const subtitleClips = this.timelineClips.filter(c =>
            c.subtitleGroupId === groupId &&
            c.material?.type === 'text'
        );

        if (subtitleClips.length === 0) return;

        // 按subtitleIndex排序
        subtitleClips.sort((a, b) => (a.subtitleIndex || 0) - (b.subtitleIndex || 0));

        // 获取第一个字幕的起始时间作为基准
        const firstStartTime = subtitleClips[0].startTime;
        let currentTime = firstStartTime;

        // 更新每个字幕及其对应音频的位置
        for (let i = 0; i < subtitleClips.length; i++) {
            const subClip = subtitleClips[i];
            const index = subClip.subtitleIndex;
            const duration = subClip.duration;

            // 更新字幕clip的位置
            subClip.startTime = currentTime;

            // 找到对应的音频clip并更新位置
            const audioClip = this.timelineClips.find(c =>
                c.subtitleGroupId === groupId &&
                c.subtitleIndex === index &&
                c.isSubtitleAudio
            );
            if (audioClip) {
                audioClip.startTime = currentTime;
                audioClip.duration = duration;
                // 确保音频clip在音频轨道上显示
                audioClip.trackIndex = 100;
            }

            // 下一个clip的起始时间
            currentTime += duration;
        }
    }

    /**
     * 同步字幕组内的变换属性
     * @param {Object} sourceClip 触发同步的源字幕 clip
     * @param {Object} transform 变换属性对象
     */
    _syncSubtitleTransforms(sourceClip, transform) {
        if (!sourceClip || !sourceClip.subtitleGroupId) return;
        const groupId = sourceClip.subtitleGroupId;
        const propsToSync = ['posX', 'posY', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity'];

        for (const clip of this.timelineClips) {
            if (clip.id === sourceClip.id || clip.subtitleGroupId !== groupId) continue;

            for (const prop of propsToSync) {
                if (transform[prop] !== undefined) {
                    clip.effects[prop] = transform[prop];
                }
            }

            // 同步 textData 的样式属性（四角缩放时字号/maxWidth/lineHeight 会变化）
            if (clip.material && clip.material.type === 'text' && clip.material.textData && sourceClip.material && sourceClip.material.textData) {
                const styleProps = ['fontSize', 'maxWidth', 'lineHeight', 'frameWidth', 'frameHeight', 'padding', 'letterSpacing'];
                for (const prop of styleProps) {
                    if (transform[prop] !== undefined) {
                        clip.material.textData[prop] = transform[prop];
                    }
                }
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._refreshTextClipThumb(clip);
            }
        }

        // 让视频引擎立即重绘
        if (this.videoEngine && this.videoEngine._needsRender !== undefined) {
            this.videoEngine._needsRender = true;
        }
    }

    /**
     * 同步字幕组内的文本样式属性
     * @param {Object} sourceClip 触发同步的源字幕 clip
     */
    _syncSubtitleStyles(sourceClip) {
        if (!sourceClip || !sourceClip.subtitleGroupId || !sourceClip.material || !sourceClip.material.textData) return;
        const groupId = sourceClip.subtitleGroupId;
        const sourceTd = sourceClip.material.textData;
        const styleProps = ['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'fontStyle', 'textDecoration', 'fontFamily', 'color', 'maxWidth', 'frameWidth', 'frameHeight', 'padding', 'align', 'stroke', 'shadow'];

        for (const clip of this.timelineClips) {
            if (clip.id === sourceClip.id || clip.subtitleGroupId !== groupId) continue;
            if (!clip.material || !clip.material.textData) continue;

            for (const prop of styleProps) {
                if (sourceTd[prop] !== undefined) {
                    clip.material.textData[prop] = sourceTd[prop];
                }
            }
            if (window.textManager) window.textManager.invalidate(clip.material.id);
            this._refreshTextClipThumb(clip);
        }

        if (this.videoEngine && this.videoEngine._needsRender !== undefined) {
            this.videoEngine._needsRender = true;
        }
    }

    /**
     * 去除文本中的标点符号（中英文标点、空格、换行等）
     */
    _stripPunctuation(text) {
        if (!text) return '';
        return text.replace(/[\s，。！？、；：""''「」『』（）【】《》〈〉…—·,.!?;:"'()\[\]<>\\-—_/\\]/g, '').trim();
    }

    _hasOverlapOnTrack(trackIdx, startTime, duration, excludeClipId) {
        const endTime = startTime + duration;
        return this.timelineClips.some(c => {
            if (excludeClipId && c.id === excludeClipId) return false;
            if (c.trackIndex !== trackIdx) return false;
            const cEnd = c.startTime + c.duration;
            return !(endTime <= c.startTime || startTime >= cEnd);
        });
    }

    _findAvailableAudioTrack(startTime, duration) {
        const audioTrackStart = 100;
        // 先检查已有的音频轨道
        for (let i = 0; i < 10; i++) {
            const trackIdx = audioTrackStart + i;
            if (!this._hasOverlapOnTrack(trackIdx, startTime, duration, null)) {
                return trackIdx;
            }
        }
        // 都满了，返回最后一个
        return audioTrackStart + 9;
    }

    _findAvailableVideoTrack(startTime, duration) {
        // 从主轨道上方（-1, -2, ...）开始找第一个有空间的轨道
        for (let i = 1; i <= 20; i++) {
            const trackIdx = this.mainTrackIndex - i;
            if (!this._hasOverlapOnTrack(trackIdx, startTime, duration, null)) {
                // 更新 minTrackIndex
                if (trackIdx < this.minTrackIndex) {
                    this.minTrackIndex = trackIdx;
                }
                return trackIdx;
            }
        }
        // 都满了，返回最上面的
        return this.mainTrackIndex - 20;
    }

    /**
     * 根据素材自动设置画布比例（带尺寸检测和延时重试）
     */
    async _autoSetCanvasRatioFromMaterial(material) {
        if (!material) return;
        
        // 如果素材已经有尺寸信息，直接使用
        if (material.width && material.height) {
            this.videoRenderer.setCanvasRatioFromVideo(material.width, material.height);
            this.updateCanvasRatioLabel();
            this.showToast(`已根据视频比例自动设置画布为 ${this.videoRenderer.getCanvasRatioText()}`);
            return;
        }
        
        // 否则动态检测视频尺寸
        try {
            const size = await this.getMediaSize(material.url);
            if (size.w && size.h) {
                material.width = size.w;
                material.height = size.h;
                this.videoRenderer.setCanvasRatioFromVideo(size.w, size.h);
                this.updateCanvasRatioLabel();
                this.showToast(`已根据视频比例自动设置画布为 ${this.videoRenderer.getCanvasRatioText()}`);
            }
        } catch (e) {
            console.warn('自动检测视频尺寸失败:', e);
        }
    }

    generateWaveformBars(count, clip) {
        const bars = [];
        for (let i = 0; i < count; i++) {
            const height = Math.random() * 80 + 20;
            bars.push(`<div class="clip-waveform-bar" style="height: ${height}%"></div>`);
        }
        return bars.join('');
    }

    async generateAudioWaveform(material) {
        if (this.waveformCache.has(material.id)) {
            return this.waveformCache.get(material.id);
        }

        if (this._waveformPending && this._waveformPending.has(material.id)) {
            return this._waveformPending.get(material.id);
        }

        const isMP4 = material.name?.toLowerCase().endsWith('.mp4');
        const fileSizeMB = (material.size || (material._arrayBuffer?.byteLength || 0)) / 1024 / 1024;

        console.log(`[音频波形] 生成波形: ${material.name}, isMP4: ${isMP4}, size: ${fileSizeMB.toFixed(1)}MB`);

        const pendingPromise = (async () => {
            try {
                if (material.type === 'video' && typeof AudioDecoder !== 'undefined' && isMP4) {
                    try {
                        const waveformData = await this._extractAudioWaveformFromMP4(material);
                        if (waveformData) {
                            this.waveformCache.set(material.id, waveformData);
                            return waveformData;
                        }
                        console.log('[音频波形] MP4 无音频或解码失败，回退到 AudioContext');
                    } catch (e) {
                        console.warn('[音频波形] WebCodecs 解码失败，尝试 AudioContext:', e.message || e);
                    }
                }

                if (fileSizeMB > 200) {
                    console.warn(`[音频波形] 文件过大(${fileSizeMB.toFixed(0)}MB)，AudioContext 可能内存不足`);
                    const fallbackWaveform = new Array(1000).fill(0.02);
                    this.waveformCache.set(material.id, fallbackWaveform);
                    return fallbackWaveform;
                }

                console.log('[音频波形] 使用 AudioContext.decodeAudioData 解码...');
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                let arrayBuffer;

                if (material._arrayBuffer) {
                    arrayBuffer = material._arrayBuffer.slice(0);
                } else {
                    const response = await fetch(material.url);
                    arrayBuffer = await response.arrayBuffer();
                }

                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

                const channelData = audioBuffer.getChannelData(0);
                const duration = audioBuffer.duration;
                const samples = Math.min(12000, Math.max(500, Math.floor(duration * 100)));
                const waveformData = this._computeWaveformFromPCM(channelData, samples);

                console.log(`[音频波形] AudioContext 解码完成: ${duration.toFixed(1)}s, ${waveformData.length} 点`);
                this.waveformCache.set(material.id, waveformData);
                audioContext.close();
                return waveformData;
            } catch (e) {
                console.warn('[音频波形] 解码失败:', e.message || e);
                const fallbackWaveform = new Array(1000).fill(0.02);
                this.waveformCache.set(material.id, fallbackWaveform);
                return fallbackWaveform;
            } finally {
                if (this._waveformPending) {
                    this._waveformPending.delete(material.id);
                }
            }
        })();

        if (!this._waveformPending) {
            this._waveformPending = new Map();
        }
        this._waveformPending.set(material.id, pendingPromise);
        return pendingPromise;
    }

    // 从 PCM 数据计算专业级波形（RMS + 峰值包络，供 MP3 和 MP4 共用）
    _computeWaveformFromPCM(channelData, pointsCount = 1000) {
        if (!channelData || channelData.length === 0) {
            return new Array(pointsCount).fill(0.02);
        }

        const waveform = [];
        const total = channelData.length;
        const step = Math.floor(total / pointsCount);
        if (step <= 0) return new Array(pointsCount).fill(0.02);

        for (let i = 0; i < pointsCount; i++) {
            const start = i * step;
            const end = Math.min(start + step, total);
            const count = end - start || 1;

            let sumOfSquares = 0;
            let peak = 0;
            for (let j = start; j < end; j++) {
                const val = channelData[j];
                sumOfSquares += val * val;
                const abs = Math.abs(val);
                if (abs > peak) peak = abs;
            }

            // RMS 结合峰值包络，让小声音也有视觉立体感
            const rms = Math.sqrt(sumOfSquares / count);
            const amplitude = (rms * 0.7) + (peak * 0.3);
            waveform.push(amplitude);
        }

        // 整体归一化并保留最小可视高度，避免静音断层
        const maxVal = Math.max(...waveform, 0.01);
        return waveform.map(v => Math.max(0.02, v / maxVal));
    }

    // WebCodecs 方式从 MP4 提取音频波形（分段解码，适合大文件）
    async _extractAudioWaveformFromMP4(material) {
        if (typeof MP4Demuxer === 'undefined') {
            throw new Error('MP4Demuxer 未定义');
        }

        const demuxer = await mp4DemuxerCache.get(material);

        if (!demuxer.audioTrack || demuxer.audioSamples.length === 0) {
            console.log('[音频波形] 该 MP4 无音频轨道');
            return null;
        }

        console.log('[音频波形] MP4 音频轨道:', demuxer.audioTrack.codec,
            '样本数:', demuxer.audioSamples.length,
            '采样率:', demuxer.audioTrack.sampleRate);

        const audioConfig = demuxer.getAudioConfig();
        if (!audioConfig) {
            throw new Error('无法获取音频配置');
        }

        // 规范化 codec 字符串
        if (audioConfig.codec === 'mp4a' || audioConfig.codec === 'mp4a.40' || !audioConfig.codec.includes('.')) {
            audioConfig.codec = 'mp4a.40.2';
        }

        console.log('[音频波形] AudioDecoder 配置:', {
            codec: audioConfig.codec,
            sampleRate: audioConfig.sampleRate,
            numberOfChannels: audioConfig.numberOfChannels,
            descriptionSize: audioConfig.description ? audioConfig.description.byteLength : 0
        });

        // 1. 先检查浏览器是否支持该配置
        const support = await AudioDecoder.isConfigSupported(audioConfig);
        if (!support.supported) {
            throw new Error(`浏览器不支持该音频配置: ${audioConfig.codec}`);
        }

        // 计算音频总时长
        const sampleRate = demuxer.audioTrack.sampleRate || 44100;
        const audioDuration = demuxer.audioTrack.duration
            ? demuxer.audioTrack.duration / (demuxer.audioTrack.timescale || 1)
            : demuxer.audioSamples.length / sampleRate;

        // 目标波形点数：每秒100点，最少500，最多12000
        const totalPoints = Math.min(12000, Math.max(500, Math.floor(audioDuration * 100)));

        // 分段解码：每段最多30秒，降低单次内存占用
        const SEGMENT_SECONDS = 30;
        const segmentCount = Math.max(1, Math.ceil(audioDuration / SEGMENT_SECONDS));
        const pointsPerSegment = Math.ceil(totalPoints / segmentCount);

        console.log(`[音频波形] 分段解码: ${segmentCount}段, 每段${SEGMENT_SECONDS}s, 总${totalPoints}点`);

        const allWaveform = new Array(totalPoints).fill(0.02);
        this.waveformCache.set(material.id, allWaveform);

        // 按时间段逐段解码
        for (let segIdx = 0; segIdx < segmentCount; segIdx++) {
            const segStartTime = segIdx * SEGMENT_SECONDS;
            const segEndTime = Math.min((segIdx + 1) * SEGMENT_SECONDS, audioDuration);
            const segStartUs = segStartTime * 1000000;
            const segEndUs = segEndTime * 1000000;

            // 找到本段的音频样本范围
            const samples = demuxer.audioSamples;
            let startIdx = -1;
            let endIdx = -1;
            for (let i = 0; i < samples.length; i++) {
                const cts = samples[i].ctsUs;
                if (startIdx === -1 && cts >= segStartUs && cts < segEndUs) {
                    startIdx = i;
                }
                if (cts >= segEndUs) {
                    endIdx = i - 1;
                    break;
                }
            }
            if (startIdx === -1) continue;
            if (endIdx === -1) endIdx = samples.length - 1;

            // 本段稀疏采样：每段最多解码 800 个样本
            const segSampleCount = endIdx - startIdx + 1;
            const step = Math.max(1, Math.floor(segSampleCount / 800));

            // 创建本段专属解码器
            let decodeError = null;
            const segFrames = [];

            const audioDecoder = new AudioDecoder({
                output: (audioData) => {
                    segFrames.push(audioData);
                },
                error: (e) => {
                    decodeError = e;
                    console.warn('[音频解码错误]', e.message || e);
                }
            });

            audioDecoder.configure(audioConfig);

            // 解码本段样本
            for (let i = startIdx; i <= endIdx && !decodeError; i += step) {
                const chunk = await demuxer.getAudioChunk(i);
                if (chunk) {
                    try {
                        audioDecoder.decode(chunk);
                    } catch (e) {
                        if (!decodeError) {
                            decodeError = e;
                            console.warn('[音频解码] decode 调用失败:', e.message);
                        }
                        break;
                    }
                }
                // 每100个样本让出一次
                if ((i - startIdx) % 100 < step) {
                    await new Promise(r => setTimeout(r, 5));
                }
            }

            try {
                await audioDecoder.flush();
            } catch (e) {
                if (!decodeError) {
                    decodeError = e;
                    console.warn('[音频解码] flush 失败:', e.message);
                }
            }
            audioDecoder.close();

            // 计算本段波形点
            const segWaveform = (() => {
                if (decodeError || segFrames.length === 0) {
                    return new Array(pointsPerSegment).fill(0.02);
                }
                let segFrames2 = 0;
                for (const frame of segFrames) {
                    segFrames2 += frame.numberOfFrames;
                }
                const segPCM = new Float32Array(segFrames2);
                let offset = 0;
                for (const audioData of segFrames) {
                    const numFrames = audioData.numberOfFrames;
                    const channelData = new Float32Array(numFrames);
                    audioData.copyTo(channelData, { planeIndex: 0, format: 'f32-planar' });
                    segPCM.set(channelData, offset);
                    offset += numFrames;
                    audioData.close();
                }
                const result = this._computeWaveformFromPCM(segPCM, pointsPerSegment);
                segPCM.fill(0);
                return result;
            })();

            // 更新到波形数组（流式更新）
            const segStartIdx = segIdx * pointsPerSegment;
            const segEndIdx = Math.min(segStartIdx + pointsPerSegment, totalPoints);
            for (let i = 0; i < segWaveform.length && segStartIdx + i < segEndIdx; i++) {
                allWaveform[segStartIdx + i] = segWaveform[i];
            }

            console.log(`[音频波形] 段${segIdx + 1}/${segmentCount}完成: ${pointsPerSegment}点, 累计${segEndIdx}点`);

            // 每3段触发一次渲染刷新（避免过于频繁）
            if ((segIdx + 1) % 3 === 0 || segIdx === segmentCount - 1) {
                this.renderTimeline();
            }

            // 段间让出，避免阻塞 UI
            await new Promise(r => setTimeout(r, 10));
        }

        if (allWaveform.length === 0) {
            throw new Error('音频解码后没有输出');
        }

        // 释放音频样本缓存
        if (demuxer && demuxer.audioSamples) {
            for (const sample of demuxer.audioSamples) {
                if (sample && sample.data) sample.data = null;
            }
        }

        console.log(`[音频波形] 全部段完成: ${allWaveform.length}点`);
        return allWaveform;
    }

    drawWaveformOnCanvas(canvas, waveformData, volume = 100, options = {}) {
        if (!waveformData || waveformData.length === 0) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const midY = height / 2;
        
        ctx.clearRect(0, 0, width, height);
        
        const volumeScale = volume / 100;
        const samplesPerPixel = options.samplesPerPixel || Math.max(1, waveformData.length / width);
        const color = options.color || 'rgba(255, 255, 255, 0.65)';
        
        // 重新采样到画布宽度，使用线性插值确保平滑
        const resampled = new Float32Array(width);
        const maxIndex = waveformData.length - 1;
        for (let x = 0; x < width; x++) {
            const samplePos = x * samplesPerPixel;
            const i0 = Math.floor(samplePos);
            const i1 = Math.min(maxIndex, i0 + 1);
            const frac = samplePos - i0;

            if (i0 >= waveformData.length) {
                resampled[x] = waveformData[maxIndex] || 0;
            } else {
                // 线性插值 + 峰值保持，既平滑又保留细节
                const v0 = waveformData[i0] || 0;
                const v1 = waveformData[i1] || 0;
                const interpolated = v0 + (v1 - v0) * frac;
                // 同时考虑插值和峰值，取较大者保持波形尖锐感
                resampled[x] = Math.max(interpolated, Math.max(v0, v1) * 0.85);
            }
        }

        ctx.fillStyle = color;
        ctx.beginPath();

        // 绘制上半部分轮廓（从左到右）
        ctx.moveTo(0, midY);
        for (let x = 0; x < width; x++) {
            const amp = resampled[x] * 0.85 * volumeScale;
            const y = midY - amp * midY;
            ctx.lineTo(x, y);
        }

        // 绘制下半部分轮廓（从右到左）
        ctx.lineTo(width, midY);
        for (let x = width - 1; x >= 0; x--) {
            const amp = resampled[x] * 0.85 * volumeScale;
            const y = midY + amp * midY;
            ctx.lineTo(x, y);
        }
        
        ctx.closePath();
        ctx.fill();
    }

    initThumbPreloader() {
        if (typeof ThumbnailPreloader === 'undefined') {
            console.log('[ThumbPreloader] ThumbnailPreloader 类未定义，跳过 WebCodecs 预解码');
            return;
        }
        if (!ThumbnailPreloader.isSupported()) {
            console.log('[ThumbPreloader] 当前浏览器不支持 WebCodecs，使用 video seek 兜底');
            return;
        }
        this.thumbPreloader = new ThumbnailPreloader(this);
        console.log('[ThumbPreloader] WebCodecs 缩略图预加载器已初始化');
    }

    getThumbCacheKey(materialId, time) {
        const t = Math.round(time * 10) / 10;
        return `${materialId}_${t}`;
    }

    getCachedThumb(materialId, time) {
        const key = this.getThumbCacheKey(materialId, time);
        if (this.thumbnailCache.has(key)) {
            return this.thumbnailCache.get(key);
        }

        const intervals = [2.0, 1.0, 0.5, 0.25, 0.1];

        for (const interval of intervals) {
            const snappedTime = Math.round(time / interval) * interval;
            
            const candidates = [snappedTime, snappedTime - interval, snappedTime + interval];
            
            for (const t of candidates) {
                if (t < 0) continue;
                const candidateKey = this.getThumbCacheKey(materialId, t);
                if (this.thumbnailCache.has(candidateKey)) {
                    return this.thumbnailCache.get(candidateKey);
                }
            }
        }

        return null;
    }

    setCachedThumb(materialId, time, dataUrl) {
        const key = this.getThumbCacheKey(materialId, time);
        this.thumbnailCache.set(key, dataUrl);
    }

    _loadLeftExtensionThumbs(clip, clipEl, thumbContainer, state) {
        const material = clip.material;
        if (!material || material.type !== 'video') return;

        const clipElHeight = clipEl.clientHeight || 80;
        const aspectRatio = (material.width || 1920) / (material.height || 1080);
        const baseThumbWidth = Math.round(clipElHeight * aspectRatio);
        const pps = this.pixelsPerSecond;

        const oldThumbWidth = baseThumbWidth;
        const oldThumbInterval = (state.duration * pps) / thumbContainer.children.length / pps || 0.5;
        const oldCount = thumbContainer.children.length;

        const extensionTime = state.offset - clip.offset;
        if (extensionTime <= 0) return;

        const newThumbCount = Math.ceil(extensionTime / oldThumbInterval);
        if (newThumbCount <= 0) return;

        const existingThumbs = thumbContainer.querySelectorAll('.clip-thumbnail');
        const firstThumb = existingThumbs[0];
        const firstThumbTime = firstThumb ? parseFloat(firstThumb.dataset.time || '0') : state.offset;

        for (let i = 1; i <= newThumbCount; i++) {
            const materialTime = firstThumbTime - i * oldThumbInterval;
            if (materialTime < 0) break;

            const timeKey = materialTime.toFixed(3);
            const existingImg = thumbContainer.querySelector(`img[data-time="${timeKey}"]`);
            if (existingImg) continue;

            const img = document.createElement('img');
            img.className = 'clip-thumbnail';
            img.style.cssText = `width:${oldThumbWidth}px;height:100%;flex-shrink:0;object-fit:cover;background:#18181c;transition:opacity 0.2s;`;
            img.dataset.time = timeKey;

            thumbContainer.insertBefore(img, thumbContainer.firstChild);

            const cached = this.getCachedThumb(material.id, materialTime);
            if (cached) {
                img.src = cached;
            } else {
                this.requestThumbnail(material, materialTime, (dataUrl) => {
                    if (dataUrl && img && img.isConnected) {
                        img.src = dataUrl;
                    }
                }, 15);
            }
        }
    }

    _loadRightExtensionThumbs(clip, clipEl, thumbContainer, state) {
        const material = clip.material;
        if (!material || material.type !== 'video') return;

        const clipElHeight = clipEl.clientHeight || 80;
        const aspectRatio = (material.width || 1920) / (material.height || 1080);
        const baseThumbWidth = Math.round(clipElHeight * aspectRatio);
        const pps = this.pixelsPerSecond;

        const oldThumbWidth = baseThumbWidth;
        const oldThumbInterval = (state.duration * pps) / thumbContainer.children.length / pps || 0.5;

        const oldEndTime = state.offset + state.duration;
        const newEndTime = clip.offset + clip.duration;
        const extensionTime = newEndTime - oldEndTime;
        if (extensionTime <= 0) return;

        const newThumbCount = Math.ceil(extensionTime / oldThumbInterval);
        if (newThumbCount <= 0) return;

        const existingThumbs = thumbContainer.querySelectorAll('.clip-thumbnail');
        const lastThumb = existingThumbs[existingThumbs.length - 1];
        const lastThumbTime = lastThumb ? parseFloat(lastThumb.dataset.time || '0') : oldEndTime - oldThumbInterval;

        for (let i = 1; i <= newThumbCount; i++) {
            const materialTime = lastThumbTime + i * oldThumbInterval;
            if (materialTime > newEndTime) break;

            const timeKey = materialTime.toFixed(3);
            const existingImg = thumbContainer.querySelector(`img[data-time="${timeKey}"]`);
            if (existingImg) continue;

            const img = document.createElement('img');
            img.className = 'clip-thumbnail';
            img.style.cssText = `width:${oldThumbWidth}px;height:100%;flex-shrink:0;object-fit:cover;background:#18181c;transition:opacity 0.2s;`;
            img.dataset.time = timeKey;

            thumbContainer.appendChild(img);

            const cached = this.getCachedThumb(material.id, materialTime);
            if (cached) {
                img.src = cached;
            } else {
                this.requestThumbnail(material, materialTime, (dataUrl) => {
                    if (dataUrl && img && img.isConnected) {
                        img.src = dataUrl;
                    }
                }, 15);
            }
        }
    }

    initThumbSystem() {
        if (this.thumbRequestQueue) return;
        this.thumbRequestQueue = [];
        this.thumbVideo = null;
        this.thumbCanvas = null;
        this.thumbCtx = null;
        this.thumbProcessing = false;
        this.thumbWidth = 64;
        this.thumbHeight = 36;
        this._thumbStats = {
            framesDecoded: 0,
            lastLogTime: performance.now(),
            totalDecoded: 0,
            peakQueue: 0
        };
    }

    clearThumbQueue() {
        if (this.thumbRequestQueue) {
            this.thumbRequestQueue.length = 0;
        }
    }

    _logThumbStats() {
        const now = performance.now();
        const elapsed = (now - this._thumbStats.lastLogTime) / 1000;
        if (elapsed >= 1) {
            const fps = this._thumbStats.framesDecoded / elapsed;
            const queueLen = this.thumbRequestQueue ? this.thumbRequestQueue.length : 0;
            this._thumbStats.peakQueue = Math.max(this._thumbStats.peakQueue, queueLen);
            console.log(`[Thumbnail] ${fps.toFixed(1)} fps, total: ${this._thumbStats.totalDecoded}, queue: ${queueLen}, peak: ${this._thumbStats.peakQueue}`);
            this._thumbStats.framesDecoded = 0;
            this._thumbStats.lastLogTime = now;
        }
    }

    requestThumbnail(material, time, callback, priority = 0) {
        if (!material || material.type !== 'video') return;

        const cached = this.getCachedThumb(material.id, time);
        if (cached) {
            callback(cached);
            return;
        }

        this.initThumbSystem();

        const exists = this.thumbRequestQueue.find(r => 
            r.material.id === material.id && 
            Math.abs(r.time - time) < 0.07
        );
        if (exists) {
            const oldCb = exists.callback;
            exists.callback = (url) => {
                oldCb(url);
                callback(url);
            };
            if (priority > exists.priority) {
                exists.priority = priority;
            }
            return;
        }

        this.thumbRequestQueue.push({ material, time, callback, priority });
        this.thumbRequestQueue.sort((a, b) => b.priority - a.priority);
        
        if (!this.thumbProcessing) {
            this.processThumbQueue();
        }
    }

    processThumbQueue() {
        if (this.thumbProcessing || this.thumbRequestQueue.length === 0) return;

        const req = this.thumbRequestQueue.shift();
        this.thumbProcessing = true;

        if (!this.thumbCanvas) {
            this.thumbCanvas = document.createElement('canvas');
            this.thumbCanvas.width = this.thumbWidth;
            this.thumbCanvas.height = this.thumbHeight;
            this.thumbCtx = this.thumbCanvas.getContext('2d', { willReadFrequently: true });
        }

        if (!this.thumbVideo || this.thumbVideo.dataset.matId !== req.material.id) {
            if (this.thumbVideo) {
                this.thumbVideo.pause();
                this.thumbVideo.removeAttribute('src');
                this.thumbVideo.load();
                this.thumbVideo.remove();
            }
            this.thumbVideo = document.createElement('video');
            this.thumbVideo.crossOrigin = 'anonymous';
            this.thumbVideo.src = req.material.url;
            this.thumbVideo.preload = 'auto';
            this.thumbVideo.muted = true;
            this.thumbVideo.playsInline = true;
            this.thumbVideo.dataset.matId = req.material.id;

            const onMeta = () => {
                req.material.duration = this.thumbVideo.duration;
                this.seekAndCapture(req);
            };
            this.thumbVideo.addEventListener('loadedmetadata', onMeta, { once: true });
            
            this.thumbVideo.addEventListener('error', () => {
                this.thumbProcessing = false;
                setTimeout(() => this.processThumbQueue(), 100);
            }, { once: true });
        } else {
            this.seekAndCapture(req);
        }
    }

    seekAndCapture(req) {
        if (!this.thumbVideo) {
            this.thumbProcessing = false;
            setTimeout(() => this.processThumbQueue(), 20);
            return;
        }

        const cached = this.getCachedThumb(req.material.id, req.time);
        if (cached) {
            req.callback(cached);
            this.thumbProcessing = false;
            setTimeout(() => this.processThumbQueue(), 0);
            return;
        }

        const duration = req.material.duration || this.thumbVideo.duration || 10;
        const targetTime = Math.min(Math.max(0, req.time), duration - 0.05);

        const onSeeked = () => {
            try {
                this.thumbCtx.drawImage(this.thumbVideo, 0, 0, this.thumbWidth, this.thumbHeight);
                const dataUrl = this.thumbCanvas.toDataURL('image/jpeg', 0.5);
                this.setCachedThumb(req.material.id, req.time, dataUrl);
                req.callback(dataUrl);
                
                this._thumbStats.framesDecoded++;
                this._thumbStats.totalDecoded++;
                this._logThumbStats();
            } catch (e) {
                req.callback(null);
            }
            
            this.thumbProcessing = false;
            requestAnimationFrame(() => this.processThumbQueue());
        };

        this.thumbVideo.addEventListener('seeked', onSeeked, { once: true });
        
        try {
            this.thumbVideo.currentTime = targetTime;
        } catch (e) {
            this.thumbProcessing = false;
            setTimeout(() => this.processThumbQueue(), 100);
        }
    }

    getThumbnailLevel() {
        const pps = this.pixelsPerSecond;
        const minThumbWidth = 40;
        
        const fixedIntervals = [2.0, 1.0, 0.5, 0.25, 0.1, 1/30];
        const desiredInterval = minThumbWidth / pps;
        
        let bestInterval = 0.5;
        for (let i = fixedIntervals.length - 1; i >= 0; i--) {
            if (fixedIntervals[i] >= desiredInterval) {
                bestInterval = fixedIntervals[i];
                break;
            }
        }
        
        const level = fixedIntervals.indexOf(bestInterval) + 1;
        return { interval: bestInterval, level: level };
    }

    renderClipThumbnails(clip, clipEl, container) {
        if (!container) return;

        const material = clip.material;
        if (!material || material.type !== 'video') return;

        const pps = this.pixelsPerSecond;
        const clipDuration = clip.duration;
        const clipWidthPx = clipDuration * pps;

        const aspectRatio = (material.width && material.height) 
            ? material.width / material.height 
            : 16 / 9;

        const containerHeight = container.clientHeight || clipEl.clientHeight || 80;
        const baseThumbWidth = Math.round(containerHeight * aspectRatio);
        const thumbCount = Math.max(1, Math.ceil(clipWidthPx / baseThumbWidth));
        const thumbWidth = clipWidthPx / thumbCount;
        const thumbInterval = clipDuration / thumbCount;

        container.dataset.thumbCount = thumbCount;
        container.dataset.interval = thumbInterval;
        container.dataset.thumbWidth = thumbWidth;

        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = clipWidthPx + 'px';
        container.style.overflow = 'hidden';
        container.style.display = 'flex';
        container.style.zIndex = '1';

        const imgs = container.querySelectorAll('.clip-thumbnail');
        
        if (imgs.length < thumbCount) {
            const frag = document.createDocumentFragment();
            for (let i = imgs.length; i < thumbCount; i++) {
                const img = document.createElement('img');
                img.className = 'clip-thumbnail';
                img.style.flexShrink = '0';
                img.style.width = thumbWidth + 'px';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                img.style.userSelect = 'none';
                img.style.pointerEvents = 'none';
                img.style.display = 'block';
                img.style.background = '#1a1a2e';
                frag.appendChild(img);
            }
            container.appendChild(frag);
        } else if (imgs.length > thumbCount) {
            for (let i = imgs.length - 1; i >= thumbCount; i--) {
                imgs[i].remove();
            }
        }
    }

    requestVisibleThumbs() {
        const scrollContainer = document.getElementById('tracksScrollContainer');
        if (!scrollContainer) return;

        const pps = this.pixelsPerSecond;
        const viewportLeft = scrollContainer.scrollLeft;
        const viewportRight = viewportLeft + scrollContainer.clientWidth;
        const viewStart = Math.max(0, viewportLeft / pps - 1);
        const viewEnd = (viewportRight / pps) + 1;

        this.clearThumbQueue();

        const tasks = [];
        let cachedCount = 0;
        let missingCount = 0;

        this.timelineClips.forEach(clip => {
            if (clip.material.type !== 'video') return;

            const clipStart = clip.startTime || 0;
            const clipEnd = clipStart + clip.duration;
            if (clipEnd < viewStart || clipStart > viewEnd) return;

            const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
            if (!clipEl) return;

            const thumbContainer = clipEl.querySelector('.clip-thumbnails');
            if (!thumbContainer) return;

            const clipOffset = clip.offset || 0;
            const imgs = thumbContainer.querySelectorAll('.clip-thumbnail');
            if (imgs.length === 0) return;

            const thumbInterval = parseFloat(thumbContainer.dataset.interval || '0.5');
            
            const overlapStart = Math.max(viewStart, clipStart);
            const overlapEnd = Math.min(viewEnd, clipEnd);
            
            const startIdx = Math.max(0, Math.floor((overlapStart - clipStart) / thumbInterval));
            const endIdx = Math.min(imgs.length - 1, Math.ceil((overlapEnd - clipStart) / thumbInterval));

            for (let i = startIdx; i <= endIdx && i < imgs.length; i++) {
                const img = imgs[i];
                const materialTime = clipOffset + i * thumbInterval;
                const timeKey = materialTime.toFixed(3);
                
                if (img.dataset.time === timeKey && img.src) {
                    cachedCount++;
                    continue;
                }
                img.dataset.time = timeKey;

                const cached = this.getCachedThumb(clip.material.id, materialTime);
                if (cached) {
                    if (img.src !== cached) {
                        img.src = cached;
                    }
                    cachedCount++;
                    continue;
                }

                if (this.thumbPreloader && this.thumbPreloader.hasActivePreloads()) {
                    continue;
                }

                missingCount++;
                tasks.push({
                    material: clip.material,
                    time: materialTime,
                    img: img,
                    timeKey: timeKey,
                    priority: 10
                });
            }
        });

        if (tasks.length === 0) return;

        tasks.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            const aCenter = a.time;
            const bCenter = b.time;
            const viewCenter = (viewStart + viewEnd) / 2;
            return Math.abs(aCenter - viewCenter) - Math.abs(bCenter - viewCenter);
        });

        tasks.forEach((task, idx) => {
            if (this.thumbPreloader && ThumbnailPreloader.isSupported()) {
                this.thumbPreloader.requestFrame(task.material, task.time, (dataUrl) => {
                    if (dataUrl && task.img && task.img.isConnected && task.img.dataset.time === task.timeKey) {
                        task.img.src = dataUrl;
                    }
                });
            } else {
                this.requestThumbnail(task.material, task.time, (dataUrl) => {
                    if (dataUrl && task.img && task.img.isConnected && task.img.dataset.time === task.timeKey) {
                        task.img.src = dataUrl;
                    }
                }, task.priority - Math.min(5, Math.floor(idx / 10)));
            }
        });

        if (this.thumbPreloader && this.thumbPreloader.hasActivePreloads()) {
            this._scheduleThumbRefresh();
        }
    }

    _scheduleThumbRefresh() {
        if (this._thumbRefreshTimer) return;
        this._thumbRefreshTimer = setTimeout(() => {
            this._thumbRefreshTimer = null;
            if (this.thumbPreloader && this.thumbPreloader.hasActivePreloads()) {
                this.requestVisibleThumbs();
            }
        }, 500);
    }

    updateClipThumbnailMask(clip, clipEl) {
        // 缩略图现在使用固定大小和固定位置，不需要动态更新遮罩
    }

    renderTimeline() {
        const tracksLanes = document.getElementById('tracksContainer');
        const tracksHeaderCol = document.getElementById('tracksHeaderCol');
        if (!tracksLanes || !tracksHeaderCol) return;

        const oldUpperClips = this.timelineClips.filter(c => c.trackIndex > 0 && c.trackIndex < 100);
        if (oldUpperClips.length > 0) {
            const oldTracks = [...new Set(oldUpperClips.map(c => c.trackIndex))].sort((a, b) => a - b);
            oldTracks.forEach((oldTrack, idx) => {
                const newTrack = this.mainTrackIndex - 1 - idx;
                this.timelineClips.forEach(c => {
                    if (c.trackIndex === oldTrack) {
                        c.trackIndex = newTrack;
                    }
                });
            });
        }

        const clipTracks = this.timelineClips
            .filter(c => c.trackIndex < 100)
            .map(c => c.trackIndex);
        
        if (clipTracks.length > 0) {
            this.minTrackIndex = Math.min(this.minTrackIndex, ...clipTracks);
            this.maxTrackIndex = Math.max(this.maxTrackIndex, ...clipTracks);
        }

        const audioTrackStart = 100;
        const audioTrackCount = 3;

        const videoTrackIndices = [];
        for (let i = this.minTrackIndex; i <= this.mainTrackIndex; i++) {
            videoTrackIndices.push(i);
        }

        const allTracks = [];
        for (const i of videoTrackIndices) {
            allTracks.push({ index: i, type: 'video' });
        }
        for (let i = 0; i < audioTrackCount; i++) {
            allTracks.push({ index: audioTrackStart + i, type: 'audio' });
        }

        const trackKey = allTracks.map(t => `${t.index}:${t.type}`).join(',');
        const needsRebuild = tracksLanes.dataset.trackKey !== trackKey;

        if (needsRebuild) {
            let lanesHTML = '';
            let headersHTML = '';
            const audioNames = ['音频 1', '音频 2', '背景音乐'];

            for (const track of allTracks) {
                const i = track.index;
                const isMainTrack = i === this.mainTrackIndex;
                const isAudio = track.type === 'audio';
                const trackLabel = isMainTrack ? '视频轨道' :
                                  isAudio ? audioNames[i - audioTrackStart] || '音频 ' + (i - audioTrackStart + 1) :
                                  '画中画 ' + (this.mainTrackIndex - i);
                const trackState = this.trackStates[i] || { visible: true, locked: false };
                const visibleClass = trackState.visible ? '' : ' hidden';
                const lockedClass = trackState.locked ? ' locked' : '';
                const mainClass = isMainTrack ? ' main-track' : '';

                lanesHTML += `
                    <div class="track-row${mainClass}${visibleClass}${lockedClass}" data-track-index="${i}" data-track-type="${track.type}">
                        <div class="track-lane ${isAudio ? 'audio-lane' : ''}" data-track="${i}" data-track-type="${track.type}"></div>
                    </div>
                `;

                headersHTML += `
                    <div class="track-row${mainClass}${visibleClass}${lockedClass}" data-track-index="${i}" data-track-type="${track.type}">
                        <div class="track-header">
                            <span class="track-visibility${trackState.visible ? '' : ' hidden'}" data-track-action="visibility" data-track-index="${i}">
                                <i class="fa-solid ${trackState.visible ? 'fa-eye' : 'fa-eye-slash'}"></i>
                            </span>
                            <span class="track-lock${trackState.locked ? ' locked' : ''}" data-track-action="lock" data-track-index="${i}">
                                <i class="fa-solid ${trackState.locked ? 'fa-lock' : 'fa-lock-open'}"></i>
                            </span>
                            <span class="track-name">${trackLabel}</span>
                        </div>
                    </div>
                `;
            }

            tracksLanes.innerHTML = lanesHTML;
            tracksHeaderCol.innerHTML = headersHTML;
            tracksLanes.dataset.trackKey = trackKey;

            tracksHeaderCol.querySelectorAll('.track-header').forEach(header => {
                const existingHandler = header._trackHeaderClickHandler;
                if (existingHandler) header.removeEventListener('click', existingHandler);

                const handler = (e) => {
                    const action = e.target.closest('[data-track-action]');
                    if (action) {
                        e.preventDefault();
                        e.stopPropagation();
                        const trackIndex = parseInt(action.dataset.trackIndex);
                        const trackAction = action.dataset.trackAction;

                        if (!this.trackStates[trackIndex]) {
                            this.trackStates[trackIndex] = { visible: true, locked: false };
                        }

                        const trackRow = header.parentElement;
                        const laneRow = tracksLanes.querySelector(`.track-row[data-track-index="${trackIndex}"]`);

                        if (trackAction === 'visibility') {
                            const newVisible = !this.trackStates[trackIndex].visible;
                            this.trackStates[trackIndex].visible = newVisible;

                            // 更新图标
                            const icon = action.querySelector('i');
                            if (icon) {
                                icon.className = `fa-solid ${newVisible ? 'fa-eye' : 'fa-eye-slash'}`;
                            }
                            action.classList.toggle('hidden', !newVisible);

                            // 更新轨道行视觉状态
                            if (trackRow) trackRow.classList.toggle('hidden', !newVisible);
                            if (laneRow) laneRow.classList.toggle('hidden', !newVisible);

                            // 更新所有相关clip的可见性
                            this.timelineClips.forEach(clip => {
                                if (clip.trackIndex === trackIndex) {
                                    const clipEl = tracksLanes.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
                                    if (clipEl) {
                                        clipEl.style.opacity = newVisible ? '1' : '0.1';
                                        clipEl.style.pointerEvents = newVisible ? 'auto' : 'none';
                                    }
                                }
                            });
                        } else if (trackAction === 'lock') {
                            const newLocked = !this.trackStates[trackIndex].locked;
                            this.trackStates[trackIndex].locked = newLocked;

                            // 更新图标
                            const icon = action.querySelector('i');
                            if (icon) {
                                icon.className = `fa-solid ${newLocked ? 'fa-lock' : 'fa-lock-open'}`;
                            }
                            action.classList.toggle('locked', newLocked);

                            // 更新轨道行视觉状态
                            if (trackRow) trackRow.classList.toggle('locked', newLocked);
                            if (laneRow) laneRow.classList.toggle('locked', newLocked);

                            // 更新轨道lane的可交互状态
                            const lane = laneRow ? laneRow.querySelector('.track-lane') : null;
                            if (lane) {
                                lane.dataset.locked = newLocked ? 'true' : 'false';
                            }
                        }
                    } else {
                        const trackRow = header.parentElement;
                        const trackIndex = parseInt(trackRow.dataset.trackIndex);
                        this.selectClipsInTrack(trackIndex);
                    }
                };
                header._trackHeaderClickHandler = handler;
                header.addEventListener('click', handler);
            });
        }

    const totalWidth = this._getTotalWidthWithPadding();
    const allLanes = tracksLanes.querySelectorAll('.track-lane');
    allLanes.forEach(lane => {
        lane.style.minWidth = totalWidth + 'px';
    });

    const scrollContainer = document.getElementById('tracksScrollContainer');
    const playhead = document.getElementById('playhead');
    const previewPlayhead = document.getElementById('previewPlayhead');
    if (scrollContainer && playhead && playhead.parentElement !== scrollContainer) {
        scrollContainer.appendChild(playhead);
    }
    if (scrollContainer && previewPlayhead && previewPlayhead.parentElement !== scrollContainer) {
        scrollContainer.appendChild(previewPlayhead);
    }

    const lanesHeight = tracksLanes.offsetHeight;
    if (playhead) {
        playhead.style.height = lanesHeight + 'px';
    }
    if (previewPlayhead) {
        previewPlayhead.style.height = lanesHeight + 'px';
    }

    const existingClipIds = new Set();
    tracksLanes.querySelectorAll('.timeline-clip').forEach(el => {
        existingClipIds.add(el.dataset.clipId);
    });

    const currentClipIds = new Set(this.timelineClips.map(c => c.id));

    existingClipIds.forEach(id => {
        if (!currentClipIds.has(id)) {
            const el = tracksLanes.querySelector(`.timeline-clip[data-clip-id="${id}"]`);
            if (el) el.remove();
        }
    });

    this.timelineClips.forEach(clip => {
        // 确保动画配置
        if (!clip.entryAnimation) clip.entryAnimation = { type: 'none', duration: 0.5 };
        if (!clip.exitAnimation) clip.exitAnimation = { type: 'none', duration: 0.5 };

        const lane = tracksLanes.querySelector(`.track-lane[data-track="${clip.trackIndex}"]`);
        if (!lane) return;

        const left = clip.startTime * this.pixelsPerSecond;
        const width = clip.duration * this.pixelsPerSecond;
        const isAudio = clip.trackIndex >= audioTrackStart;
        const isVideo = clip.material.type === 'video';
        const isImage = clip.material.type === 'image';
        const isText = clip.material.type === 'text';
        const volume = clip.effects?.volume || 100;

        let clipEl = tracksLanes.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);

        if (!clipEl) {
            clipEl = document.createElement('div');
            clipEl.className = 'timeline-clip';
            clipEl.dataset.clipId = clip.id;
            clipEl.draggable = false;

            if (isAudio) {
                clipEl.classList.add('audio-clip');
            } else if (isImage) {
                clipEl.classList.add('image-clip');
            } else if (isVideo) {
                clipEl.classList.add('video-clip');
            } else if (isText) {
                clipEl.classList.add('text-clip');
            }

            // 文本片段使用 canvas 渲染一张小缩略图
            const textThumbHTML = isText
                ? `<canvas class="clip-text-thumb" data-clip-id="${clip.id}" width="200" height="60"></canvas>`
                : '';
            const thumbContent = isText
                ? textThumbHTML
                : isImage
                ? `<img src="${clip.material.url}" class="clip-thumb" draggable="false">`
                : isVideo
                ? ''
                : `<div class="clip-audio-wave"><i class="fa-solid fa-music"></i></div>`;

            const thumbnailsHTML = isVideo ? `<div class="clip-thumbnails" data-clip-id="${clip.id}"></div>` : '';
            const waveformHTML = (isAudio || isVideo)
                ? `<canvas class="${isVideo ? 'clip-audio-waveform' : 'clip-waveform-canvas'}" data-clip-id="${clip.id}"></canvas>`
                : '';
            
            const keyframesHTML = clip.keyframes && clip.keyframes.length > 0
                ? `<div class="clip-keyframes" data-clip-id="${clip.id}">
                    ${clip.keyframes.map(kf => `
                        <div class="keyframe-marker ${this.selectedKeyframeIds.has(kf.id) ? 'selected' : ''}" data-keyframe-id="${kf.id}" data-clip-id="${clip.id}" data-kf-time="${kf.time}" style="left: ${(kf.time / clip.duration) * 100}%">
                        </div>
                    `).join('')}
                   </div>`
                : '';

            clipEl.innerHTML = `
                <div class="clip-resize-handle clip-resize-left" data-handle="left"></div>
                <div class="clip-content-mask">
                    ${thumbnailsHTML}
                    ${waveformHTML}
                </div>
                ${keyframesHTML}
                <div class="clip-content">
                    ${thumbContent}
                    <span class="clip-name">${isText ? '字幕' : clip.material.name}</span>
                </div>
                ${(isAudio || isVideo) ? `<div class="clip-volume-control" data-clip-id="${clip.id}">
                    <div class="clip-volume-handle"></div>
                </div>` : ''}
                <div class="clip-resize-handle clip-resize-right" data-handle="right"></div>
            `;

            lane.appendChild(clipEl);

            clipEl.addEventListener('mousedown', (e) => {
                const trackState = this.trackStates[clip.trackIndex];
                if (trackState && trackState.locked) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                const keyframeMarker = e.target.closest('.keyframe-marker');
                if (keyframeMarker) {
                    const kfId = keyframeMarker.dataset.keyframeId;
                    const kf = clip.keyframes?.find(k => k.id === kfId);
                    if (kf) {
                        this.currentTime = clip.startTime + kf.time;
                        this.updatePlayheadPosition();
                        this.updatePreviewLayers(true);
                        this.syncCurrentClipEffectsFromKeyframes();
                    }

                    if (e.ctrlKey || e.metaKey) {
                        if (this.selectedKeyframeIds.has(kfId)) {
                            this.selectedKeyframeIds.delete(kfId);
                        } else {
                            this.selectedKeyframeIds.add(kfId);
                        }
                    } else {
                        if (!this.selectedKeyframeIds.has(kfId)) {
                            this.selectedKeyframeIds.clear();
                            this.selectedKeyframeIds.add(kfId);
                        }
                    }

                    this.updateKeyframeSelectionVisuals();
                    this.startKeyframeDrag(e, clip.id, kfId);
                    return;
                }

                if (e.target.classList.contains('clip-resize-handle')) {
                    this.startClipResize(e, clip.id, e.target.dataset.handle);
                } else if (e.target.classList.contains('clip-volume-handle') || e.target.closest('.clip-volume-handle')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.startVolumeDrag(e, clip.id);
                } else {
                    this.startClipDrag(e, clip.id);
                }
            });

            if ((isAudio || isVideo) && clip.material.url) {
                this.generateAudioWaveform(clip.material).then(waveformData => {
                    const canvas = clipEl.querySelector(isVideo ? '.clip-audio-waveform' : '.clip-waveform-canvas');
                    if (canvas && waveformData) {
                        requestAnimationFrame(() => {
                            const maxCanvasWidth = 8192;
                            const displayWidth = clipEl.clientWidth;
                            const containerHeight = isVideo ? Math.round(clipEl.clientHeight * 0.25) : clipEl.clientHeight;
                            const effectiveWidth = Math.min(displayWidth, maxCanvasWidth);
                            canvas.width = effectiveWidth;
                            canvas.height = containerHeight;
                            canvas.style.width = '100%';
                            canvas.style.height = containerHeight + 'px';
                            this.drawWaveformOnCanvas(canvas, waveformData, volume, {
                                samplesPerPixel: waveformData.length / effectiveWidth
                            });
                        });
                    }
                });
            } else if (isText) {
                // 文本片段：直接用 canvas 渲染缩略图
                requestAnimationFrame(() => {
                    this._renderTextClipThumb(clip, clipEl);
                });
            }
        } else if (isText) {
            // 已有 DOM 的文本片段也要刷新缩略图（项目加载后字体变化时）
            requestAnimationFrame(() => {
                this._renderTextClipThumb(clip, clipEl);
            });
        }

        clipEl.style.left = left + 'px';
        clipEl.style.width = width + 'px';
        
        if (clip.keyframes && clip.keyframes.length > 0) {
            let kfContainer = clipEl.querySelector('.clip-keyframes');
            const newKfHTML = clip.keyframes.map(kf => `
                <div class="keyframe-marker ${this.selectedKeyframeIds.has(kf.id) ? 'selected' : ''}" data-keyframe-id="${kf.id}" data-clip-id="${clip.id}" data-kf-time="${kf.time}" style="left: ${(kf.time / clip.duration) * 100}%">
                </div>
            `).join('');
            if (kfContainer) {
                kfContainer.innerHTML = newKfHTML;
            } else {
                kfContainer = document.createElement('div');
                kfContainer.className = 'clip-keyframes';
                kfContainer.innerHTML = newKfHTML;
                clipEl.appendChild(kfContainer);
            }
        } else {
            const oldKfContainer = clipEl.querySelector('.clip-keyframes');
            if (oldKfContainer) oldKfContainer.remove();
        }

        if (this.selectedClipIds.has(clip.id)) {
            clipEl.classList.add('selected');
        } else {
            clipEl.classList.remove('selected');
        }

        const volumeHandle = clipEl.querySelector('.clip-volume-handle');
        if (volumeHandle) {
            if (isVideo) {
                const volumeFraction = volume / 200;
                volumeHandle.style.top = ((1 - volumeFraction) * 100) + '%';
            } else {
                const volumePercent = Math.min(100, volume / 2);
                volumeHandle.style.top = (100 - volumePercent) + '%';
            }
        }

        if (isVideo && clip.material.url && width > 50) {
            const thumbnailsContainer = clipEl.querySelector('.clip-thumbnails');
            if (thumbnailsContainer) {
                this.renderClipThumbnails(clip, clipEl, thumbnailsContainer);
            }
        }
    });

    this.renderRuler();
    this.requestVisibleThumbs();
}

addToTimelineAt(materialId, time, trackIndex = 0) {
    const material = this.materials.find(m => m.id === materialId);
    if (!material) return;

    let duration = material.duration;
    if (!duration) {
        duration = this._getMaterialDurationFromVideo(material);
    }
    if (!duration) {
        duration = 5;
    }

    const clip = {
        id: Date.now() + Math.random(),
        materialId: materialId,
        material: material,
        startTime: time,
        duration: duration,
        offset: 0,
        trackIndex: trackIndex,
        effects: { ...this.currentClipEffects }
    };

    this.timelineClips.push(clip);
    
    if (trackIndex < 100 && trackIndex >= this.videoTrackCount) {
        this.videoTrackCount = trackIndex + 1;
    }

    if (material.type === 'video') {
        const hasVideoInTimeline = this.timelineClips.some(c => c.id !== clip.id && c.material && c.material.type === 'video');
        if (!hasVideoInTimeline && this.videoRenderer) {
            this._autoSetCanvasRatioFromMaterial(material);
        }
    }
    
    this.selectClip(clip.id);
    this.updateTotalDuration();
    this.renderMaterials();

    if (editor.snapMainTrack && clip.trackIndex === editor.mainTrackIndex) {
        editor.applyMainTrackSnap();
    }
    
    if (this.videoRenderer) {
        this.videoRenderer.setClips(this.timelineClips);
    }

    this.pushHistory('添加素材');
}

renderRuler() {
    const ruler = document.getElementById('rulerScale');
    if (!ruler) return;

        const totalWidth = this._getTotalWidthWithPadding();
        ruler.style.width = totalWidth + 'px';

        const pps = this.pixelsPerSecond;
        const fps = 30;
        const frameTime = 1 / fps;
        const minuteTime = 60;

        const tiers = [
            { minor: minuteTime * 5, major: minuteTime * 10, label: 'mm',       minPx: 30, medium: 0,              frameLabels: [] },
            { minor: minuteTime * 2, major: minuteTime * 10, label: 'mm',       minPx: 20, medium: 0,              frameLabels: [] },
            { minor: minuteTime,     major: minuteTime * 5,  label: 'mm',       minPx: 10, medium: 0,              frameLabels: [] },
            { minor: 30,             major: minuteTime,     label: 'mm:ss',    minPx: 15, medium: 0,              frameLabels: [] },
            { minor: 15,             major: minuteTime,     label: 'mm:ss',    minPx: 8,  medium: 0,              frameLabels: [] },
            { minor: 10,             major: minuteTime,     label: 'mm:ss',    minPx: 5,  medium: 0,              frameLabels: [] },
            { minor: 5,              major: 30,             label: 'mm:ss',    minPx: 8,  medium: 0,              frameLabels: [] },
            { minor: 2,              major: 10,             label: 'mm:ss',    minPx: 8,  medium: 0,              frameLabels: [] },
            { minor: 1,              major: 5,              label: 'mm:ss',    minPx: 8,  medium: 0,              frameLabels: [] },
            { minor: 0.5,            major: 5,              label: 'mm:ss',    minPx: 6,  medium: 0,              frameLabels: [] },
            { minor: 0.25,           major: 2,              label: 'mm:ss',    minPx: 4,  medium: 0,              frameLabels: [] },
            { minor: 0.1,            major: 1,              label: 'mm:ss',    minPx: 4,  medium: 0,              frameLabels: [] },
            { minor: frameTime * 20, major: 1,              label: 'mm:ss',    minPx: 25, medium: 0,              frameLabels: [] },
            { minor: frameTime * 15, major: 1,              label: 'mm:ss',    minPx: 22, medium: 0,              frameLabels: [] },
            { minor: frameTime * 10, major: 1,              label: 'mm:ss',    minPx: 20, medium: 0,              frameLabels: [] },
            { minor: frameTime * 8,  major: 1,              label: 'mm:ss',    minPx: 18, medium: 0,              frameLabels: [] },
            { minor: frameTime * 5,  major: 1,              label: 'mm:ss',    minPx: 15, medium: 0,              frameLabels: [] },
            { minor: frameTime * 5,  major: 1,              label: 'mm:ss',    minPx: 12, medium: 0,              frameLabels: [] },
            { minor: frameTime * 3,  major: 1,              label: 'mm:ss',    minPx: 15, medium: 0,              frameLabels: [] },
            { minor: frameTime * 3,  major: 1,              label: 'mm:ss',    minPx: 12, medium: frameTime * 15,  frameLabels: [15] },
            { minor: frameTime * 2,  major: 1,              label: 'mm:ss',    minPx: 15, medium: frameTime * 10,  frameLabels: [15] },
            { minor: frameTime * 2,  major: 1,              label: 'mm:ss',    minPx: 12, medium: frameTime * 10,  frameLabels: [10, 20] },
            { minor: frameTime,      major: 1,              label: 'mm:ss',    minPx: 15, medium: frameTime * 5,   frameLabels: [10, 15, 20] },
            { minor: frameTime,      major: 1,              label: 'mm:ss',    minPx: 10, medium: frameTime * 5,   frameLabels: [5, 10, 15, 20, 25] },
            { minor: frameTime,      major: 1,              label: 'mm:ss',    minPx: 5,  medium: frameTime * 5,   frameLabels: [5, 10, 15, 20, 25] },
        ];

        let tier = tiers[0];
        for (let i = 0; i < tiers.length; i++) {
            if (pps * tiers[i].minor >= tiers[i].minPx) {
                tier = tiers[i];
            } else {
                break;
            }
        }

        const minorInterval = tier.minor;
        const majorInterval = tier.major;
        const mediumInterval = tier.medium || 0;
        const labelFormat = tier.label;
        const frameLabels = tier.frameLabels || [];
        const showFrameLabel = frameLabels.length > 0;

        let html = '';
        const totalIntervals = Math.ceil(this.totalDuration / minorInterval);
        const labelWidth = labelFormat === 'mm:ss.ff' ? 70 : 50;
        const frameLabelWidth = 30;
        let lastLabelX = -labelWidth;
        let lastFrameLabelX = -frameLabelWidth;

        for (let i = 0; i <= totalIntervals + 1; i++) {
            const t = i * minorInterval;
            const left = t * pps;
            if (left > totalWidth + 500) break;

            const totalFrames = Math.floor(t * fps + 0.0001);
            const mins = Math.floor(totalFrames / (fps * 60));
            const secs = Math.floor((totalFrames % (fps * 60)) / fps);
            const frames = totalFrames % fps;

            const isMajor = Math.abs(t % majorInterval) < minorInterval * 0.1 ||
                            Math.abs((t % majorInterval) - majorInterval) < minorInterval * 0.1;
            const isMedium = mediumInterval > 0 && !isMajor &&
                             (Math.abs(t % mediumInterval) < minorInterval * 0.1 ||
                              Math.abs((t % mediumInterval) - mediumInterval) < minorInterval * 0.1);

            if (isMajor) {
                let label;
                if (labelFormat === 'mm') {
                    label = `${mins}`;
                } else if (labelFormat === 'mm:ss') {
                    label = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                } else {
                    label = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${frames.toString().padStart(2, '0')}`;
                }

                if (left - lastLabelX >= labelWidth) {
                    html += `<div class="ruler-mark ruler-mark-major" style="left: ${left}px;">${label}</div>`;
                    lastLabelX = left;
                } else {
                    html += `<div class="ruler-mark ruler-mark-major" style="left: ${left}px;"></div>`;
                }
            } else if (isMedium) {
                if (showFrameLabel && frameLabels.includes(frames) &&
                    left - lastFrameLabelX >= frameLabelWidth &&
                    left - lastLabelX >= labelWidth * 0.3) {
                    html += `<div class="ruler-mark ruler-mark-medium" style="left: ${left}px;">${frames}f</div>`;
                    lastFrameLabelX = left;
                } else {
                    html += `<div class="ruler-mark ruler-mark-medium" style="left: ${left}px;"></div>`;
                }
            } else {
                html += `<div class="ruler-mark ruler-mark-minor" style="left: ${left}px;"></div>`;
            }
        }
        ruler.innerHTML = html;
    }

    startKeyframeDrag(e, clipId, keyframeId) {
        e.preventDefault();
        e.stopPropagation();

        const clip = this.timelineClips.find(c => c.id === clipId);
        if (!clip || !clip.keyframes) return;

        const keyframe = clip.keyframes.find(k => k.id === keyframeId);
        if (!keyframe) return;

        const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
        if (!clipEl) return;

        const dragKeyframes = clip.keyframes.filter(k => this.selectedKeyframeIds.has(k.id));
        const isMultiDrag = dragKeyframes.length > 1 && this.selectedKeyframeIds.has(keyframeId);

        const dragStartTimes = {};
        if (isMultiDrag) {
            dragKeyframes.forEach(k => { dragStartTimes[k.id] = k.time; });
        }

        this.isDraggingKeyframe = true;
        this.dragKeyframeClip = clip;
        this.dragKeyframe = keyframe;
        this.dragStartX = e.clientX;
        this.dragStartKeyframeTime = keyframe.time;

        const onMouseMove = (ev) => {
            if (!this.isDraggingKeyframe) return;

            const clipRect = clipEl.getBoundingClientRect();
            const relativeX = ev.clientX - clipRect.left;
            const pct = relativeX / clipRect.width;
            const time = pct * clip.duration;
            const mouseDelta = (ev.clientX - this.dragStartX) / this.pixelsPerSecond;

            if (isMultiDrag) {
                dragKeyframes.forEach(k => {
                    k.time = Math.max(0, Math.min(clip.duration, dragStartTimes[k.id] + mouseDelta));
                });
                clip.keyframes.sort((a, b) => a.time - b.time);

                this.currentTime = clip.startTime + keyframe.time;
                this.updatePreviewLayers(true);

                dragKeyframes.forEach(k => {
                    const m = clipEl.querySelector(`.keyframe-marker[data-keyframe-id="${k.id}"]`);
                    if (m) m.style.left = (k.time / clip.duration) * 100 + '%';
                });
            } else {
                keyframe.time = Math.max(0, Math.min(clip.duration, time));
                clip.keyframes.sort((a, b) => a.time - b.time);

                this.currentTime = clip.startTime + keyframe.time;
                this.updatePreviewLayers(true);

                const marker = clipEl.querySelector(`.keyframe-marker[data-keyframe-id="${keyframeId}"]`);
                if (marker) {
                    marker.style.left = (keyframe.time / clip.duration) * 100 + '%';
                }
            }
        };

        const onMouseUp = () => {
            this.isDraggingKeyframe = false;
            this.dragKeyframeClip = null;
            this.dragKeyframe = null;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            this.renderKeyframesList();
            this.renderTimeline();
            // 检查关键帧是否实际移动了
            let changed = false;
            if (isMultiDrag) {
                for (const k of dragKeyframes) {
                    if (dragStartTimes[k.id] !== k.time) { changed = true; break; }
                }
            } else {
                changed = this.dragStartKeyframeTime !== keyframe.time;
            }
            if (changed) this.pushHistory('移动关键帧');
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    getDynamicSnapThreshold() {
        // 根据缩放级别动态调整磁吸阈值（像素阈值固定为20px）
        const pixelThreshold = 20;
        const threshold = pixelThreshold / this.pixelsPerSecond;
        return Math.min(Math.max(threshold, 0.05), 5);
    }

    getSnappedStartTime(clip, desiredStartTime, trackIdx, excludeClipIds = []) {
        if (!this.snapClips && !this.snapMainTrack) return desiredStartTime;

        const snapThreshold = this.getDynamicSnapThreshold();

        const isMainTrack = trackIdx === this.mainTrackIndex;
        if (this.snapMainTrack && isMainTrack) {
            const mainClips = this.timelineClips.filter(c =>
                c.trackIndex === this.mainTrackIndex && !excludeClipIds.includes(c.id)
            ).sort((a, b) => a.startTime - b.startTime);

            let prevEnd = 0;
            for (const other of mainClips) {
                const otherEnd = other.startTime + other.duration;
                if (otherEnd <= desiredStartTime + snapThreshold) {
                    prevEnd = otherEnd;
                } else {
                    break;
                }
            }
            if (Math.abs(desiredStartTime - prevEnd) <= snapThreshold) {
                return prevEnd;
            }
            if (desiredStartTime < prevEnd) {
                return prevEnd;
            }
        }

        if (this.snapClips) {
            const others = this.timelineClips.filter(c =>
                c.id !== clip.id && c.trackIndex === trackIdx && !excludeClipIds.includes(c.id)
            );

            let closest = desiredStartTime;
            let minDist = snapThreshold;

            for (const other of others) {
                const otherEnd = other.startTime + other.duration;
                const distToStart = Math.abs(desiredStartTime - otherEnd);
                const distToEnd = Math.abs(desiredStartTime + clip.duration - other.startTime);

                if (distToStart < minDist) {
                    minDist = distToStart;
                    closest = otherEnd;
                }
                if (distToEnd < minDist) {
                    minDist = distToEnd;
                    closest = other.startTime - clip.duration;
                }
            }

            if (closest < 0) closest = 0;
            return closest;
        }

        return desiredStartTime;
    }

    applyMainTrackSnap() {
        if (!this.snapMainTrack) return;

        const mainClips = this.timelineClips.filter(c =>
            c.trackIndex === this.mainTrackIndex
        ).sort((a, b) => a.startTime - b.startTime);

        let currentTime = 0;
        for (const clip of mainClips) {
            clip.startTime = currentTime;
            currentTime += clip.duration;
        }

        this.renderTimeline();
        this.updateTotalDuration();
    }

    startClipDrag(e, clipId) {
        e.preventDefault();
        e.stopPropagation();
        
        const clip = this.timelineClips.find(c => c.id === clipId);
        if (!clip) return;
        
        const trackState = this.trackStates[clip.trackIndex];
        if (trackState && trackState.locked) {
            return;
        }
        
        if (!this.selectedClipIds.has(clipId)) {
            if (e.ctrlKey || e.metaKey) {
                this.selectClip(clipId, true);
            } else {
                this.selectClip(clipId);
            }
        } else if (e.ctrlKey || e.metaKey) {
            this.selectClip(clipId, true);
            if (!this.selectedClipIds.has(clipId)) {
                return;
            }
        }
        
        this.isDragging = true;
        this.dragClip = clip;

        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.clipStartTime = this.dragClip.startTime;
        this.clipStartTrackIndex = this.dragClip.trackIndex;

        const dragClips = Array.from(this.selectedClipIds)
            .map(id => this.timelineClips.find(c => c.id === id))
            .filter(c => c && !(this.trackStates[c.trackIndex] && this.trackStates[c.trackIndex].locked));
        
        const dragStartTimes = {};
        const dragStartTracks = {};
        dragClips.forEach(c => {
            dragStartTimes[c.id] = c.startTime;
            dragStartTracks[c.id] = c.trackIndex;
        });

        const scrollContainer = document.getElementById('tracksScrollContainer');
        const tracksLanes = document.getElementById('tracksContainer');
        
        const startAutoScroll = (direction) => {
            if (this.autoScrollTimer && this.autoScrollSpeed === direction) return;
            
            if (this.autoScrollTimer) {
                cancelAnimationFrame(this.autoScrollTimer);
                this.autoScrollTimer = null;
            }
            
            this.autoScrollSpeed = direction;
            let trackCreationCount = 0;
            const maxTracksPerScroll = 3;
            const scrollStep = () => {
                if (!this.isDragging) {
                    this.autoScrollTimer = null;
                    return;
                }
                if (scrollContainer) {
                    const scrollAmount = this.autoScrollSpeed * 2;
                    scrollContainer.scrollTop += scrollAmount;
                    
                    if (this.autoScrollSpeed < 0 && scrollContainer.scrollTop <= 0) {
                        if (trackCreationCount < maxTracksPerScroll) {
                            this.minTrackIndex--;
                            trackCreationCount++;
                            this.renderTimeline();
                        }
                    } else if (this.autoScrollSpeed > 0) {
                        const scrollBottom = scrollContainer.scrollTop + scrollContainer.clientHeight;
                        if (scrollBottom >= scrollContainer.scrollHeight - 10) {
                            if (trackCreationCount < maxTracksPerScroll) {
                                this.maxTrackIndex++;
                                trackCreationCount++;
                                this.renderTimeline();
                            }
                        }
                    }
                }
                this.autoScrollTimer = requestAnimationFrame(scrollStep);
            };
            this.autoScrollTimer = requestAnimationFrame(scrollStep);
        };

        const stopAutoScroll = () => {
            if (this.autoScrollTimer) {
                cancelAnimationFrame(this.autoScrollTimer);
                this.autoScrollTimer = null;
            }
            this.autoScrollSpeed = 0;
        };

        const onMouseMove = (moveE) => {
            if (!this.isDragging || !this.dragClip) return;

            if (scrollContainer) {
                const containerRect = scrollContainer.getBoundingClientRect();
                const mouseY = moveE.clientY - containerRect.top;
                const edgeThreshold = 40;
                
                if (mouseY < edgeThreshold) {
                    startAutoScroll(-1);
                } else if (mouseY > containerRect.height - edgeThreshold) {
                    startAutoScroll(1);
                } else {
                    stopAutoScroll();
                }
            }

            const deltaX = moveE.clientX - this.dragStartX;
            const deltaTime = deltaX / this.pixelsPerSecond;

            let newTrackIndex = this.dragClip.trackIndex;
            const isAudioClip = this.dragClip.material?.type === 'audio';
            if (tracksLanes) {
                const lanes = tracksLanes.querySelectorAll('.track-lane');
                lanes.forEach((lane) => {
                    const laneRect = lane.getBoundingClientRect();
                    if (moveE.clientY >= laneRect.top && moveE.clientY <= laneRect.bottom) {
                        const trackAttr = lane.dataset.track;
                        if (!isNaN(parseInt(trackAttr))) {
                            const trackIdx = parseInt(trackAttr);
                            const isAudioTrack = trackIdx >= 100;
                            if (isAudioClip === isAudioTrack) {
                                newTrackIndex = trackIdx;
                            }
                        }
                    }
                });
            }

            const trackDelta = newTrackIndex - this.clipStartTrackIndex;
            const excludeIds = dragClips.map(c => c.id);

            const hasOverlapOnTrack = (trackIdx, clipsToCheck) => {
                const others = this.timelineClips.filter(c =>
                    !excludeIds.includes(c.id) && c.trackIndex === trackIdx
                );
                for (const c of clipsToCheck) {
                    const clipStart = c.startTime;
                    const clipEnd = clipStart + c.duration;
                    for (const other of others) {
                        const otherEnd = other.startTime + other.duration;
                        if (!(clipEnd <= other.startTime || clipStart >= otherEnd)) {
                            return true;
                        }
                    }
                }
                return false;
            };

            // 先按原始轨道分组，再在每组内按时间排序，划分连续组（相邻且无间隙）
            const byOrigTrack = {};
            dragClips.forEach(c => {
                const t = dragStartTracks[c.id];
                if (!byOrigTrack[t]) byOrigTrack[t] = [];
                byOrigTrack[t].push(c);
            });

            for (const origTrackStr in byOrigTrack) {
                const origTrack = parseInt(origTrackStr);
                const clips = byOrigTrack[origTrack].sort((a, b) =>
                    dragStartTimes[a.id] - dragStartTimes[b.id]
                );

                // 划分连续组
                const groups = [];
                let currentGroup = [clips[0]];
                for (let i = 1; i < clips.length; i++) {
                    const prev = clips[i - 1];
                    const curr = clips[i];
                    const prevEnd = dragStartTimes[prev.id] + prev.duration;
                    const currStart = dragStartTimes[curr.id];
                    if (Math.abs(currStart - prevEnd) < 0.01) {
                        currentGroup.push(curr);
                    } else {
                        groups.push(currentGroup);
                        currentGroup = [curr];
                    }
                }
                groups.push(currentGroup);

                const destTrack = origTrack + trackDelta;
                const clipIsAudio = clips[0].material?.type === 'audio';
                const destIsAudio = destTrack >= 100;
                const finalDestTrack = (clipIsAudio !== destIsAudio) ? origTrack : destTrack;

                groups.forEach((group, gIdx) => {
                    const firstClip = group[0];
                    const lastClip = group[group.length - 1];
                    const groupStart = dragStartTimes[firstClip.id];
                    const groupEnd = dragStartTimes[lastClip.id] + lastClip.duration;
                    const groupDuration = groupEnd - groupStart;

                    const desiredGroupStart = Math.max(0, groupStart + deltaTime);
                    const desiredGroupEnd = desiredGroupStart + groupDuration;

                    const snapThreshold = this.getDynamicSnapThreshold();
                    let bestOffset = 0;
                    let bestDist = snapThreshold;

                    const others = this.timelineClips.filter(c =>
                        !excludeIds.includes(c.id) && c.trackIndex === finalDestTrack
                    );

                    for (const other of others) {
                        const otherEnd = other.startTime + other.duration;
                        const dist = Math.abs(desiredGroupStart - otherEnd);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestOffset = otherEnd - desiredGroupStart;
                        }
                    }

                    for (const other of others) {
                        const dist = Math.abs(desiredGroupEnd - other.startTime);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestOffset = other.startTime - desiredGroupEnd;
                        }
                    }

                    if (Math.abs(desiredGroupStart - this.currentTime) < bestDist) {
                        bestDist = Math.abs(desiredGroupStart - this.currentTime);
                        bestOffset = this.currentTime - desiredGroupStart;
                    }

                    group.forEach(c => { c._snapOffset = bestOffset; });
                });
            }

            // 计算每个 clip 的暂定位置
            const tentativePositions = [];
            let canMove = true;

            dragClips.forEach(dragClip => {
                const origTrack = dragStartTracks[dragClip.id];
                const desiredTrack = origTrack + trackDelta;

                const clipIsAudio = dragClip.material?.type === 'audio';
                const desiredIsAudio = desiredTrack >= 100;
                const finalTrack = (clipIsAudio !== desiredIsAudio) ? origTrack : desiredTrack;

                let snapOffset = dragClip._snapOffset || 0;

                const desiredStartTime = Math.max(0, dragStartTimes[dragClip.id] + deltaTime + snapOffset);

                tentativePositions.push({
                    clip: dragClip,
                    startTime: desiredStartTime,
                    trackIndex: finalTrack
                });
            });

            // 按轨道分组检查与外部素材的重叠
            const byTrack = {};
            tentativePositions.forEach(p => {
                if (!byTrack[p.trackIndex]) byTrack[p.trackIndex] = [];
                byTrack[p.trackIndex].push(p);
            });

            for (const trackIdx in byTrack) {
                const clipsInTrack = byTrack[trackIdx].map(p => ({ startTime: p.startTime, duration: p.clip.duration }));
                if (hasOverlapOnTrack(parseInt(trackIdx), clipsInTrack)) {
                    canMove = false;
                    break;
                }
            }

            if (!canMove) {
                tentativePositions.forEach(p => {
                    p.startTime = dragStartTimes[p.clip.id];
                    p.trackIndex = dragStartTracks[p.clip.id];
                });
            }

            // 应用最终位置
            tentativePositions.forEach(p => {
                const dragClip = p.clip;
                const finalStartTime = p.startTime;
                const finalTrack = p.trackIndex;

                dragClip.startTime = finalStartTime;
                dragClip.trackIndex = finalTrack;

                this.minTrackIndex = Math.min(this.minTrackIndex, finalTrack);
                this.maxTrackIndex = Math.max(this.maxTrackIndex, finalTrack);

                const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${dragClip.id}"]`);
                if (clipEl) {
                    clipEl.style.left = (finalStartTime * this.pixelsPerSecond) + 'px';

                    const newLane = tracksLanes.querySelector(`.track-lane[data-track="${finalTrack}"]`);
                    if (newLane && clipEl.parentElement !== newLane) {
                        newLane.appendChild(clipEl);
                    }
                }
            });
        };

        const onMouseUp = () => {
            this.isDragging = false;
            stopAutoScroll();
            this.dragClip = null;
            
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            
            if (this.snapMainTrack) {
                this.applyMainTrackSnap();
            }
            
            this.renderTimeline();
            this.updateTotalDuration();

            // 检查是否实际发生了移动
            let changed = false;
            for (const c of dragClips) {
                if (dragStartTimes[c.id] !== c.startTime || dragStartTracks[c.id] !== c.trackIndex) {
                    changed = true;
                    break;
                }
            }
            if (changed) {
                this.pushHistory('移动素材');
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    startClipResize(e, clipId, handle) {
        e.preventDefault();
        e.stopPropagation();
        
        const clip = this.timelineClips.find(c => c.id === clipId);
        if (!clip) return;
        
        const trackState = this.trackStates[clip.trackIndex];
        if (trackState && trackState.locked) {
            return;
        }

        if (!this.selectedClipIds.has(clipId)) {
            if (e.ctrlKey || e.metaKey) {
                this.selectClip(clipId, true);
            } else {
                this.selectClip(clipId);
            }
        } else if (e.ctrlKey || e.metaKey) {
            this.selectClip(clipId, true);
            if (!this.selectedClipIds.has(clipId)) {
                return;
            }
        }
        
        this.isResizing = true;
        this.resizeHandle = handle;
        this.resizeClip = clip;

        this.dragStartX = e.clientX;
        this.clipStartTime = this.resizeClip.startTime;
        this.clipStartDuration = this.resizeClip.duration;
        this.clipStartOffset = this.resizeClip.offset || 0;

        const selectedClips = Array.from(this.selectedClipIds)
            .map(id => this.timelineClips.find(c => c.id === id))
            .filter(c => c && !(this.trackStates[c.trackIndex] && this.trackStates[c.trackIndex].locked));

        const allClipsOnTracks = {};
        selectedClips.forEach(sc => {
            if (!allClipsOnTracks[sc.trackIndex]) {
                allClipsOnTracks[sc.trackIndex] = this.timelineClips.filter(c =>
                    c.trackIndex === sc.trackIndex && !selectedClips.find(s => s.id === c.id)
                );
            }
        });

        const clipStartStates = {};
        selectedClips.forEach(c => {
            clipStartStates[c.id] = {
                startTime: c.startTime,
                duration: c.duration,
                offset: c.offset || 0,
                firstThumbTime: null,
                thumbPrepared: false,
                contentWidth: null
            };
        });

        if (handle === 'left') {
            selectedClips.forEach(c => {
                const state = clipStartStates[c.id];
                const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${c.id}"]`);
                if (!clipEl) return;
                const thumbContainer = clipEl.querySelector('.clip-thumbnails');
                if (!thumbContainer || !c.material || c.material.type !== 'video') return;

                const pps = this.pixelsPerSecond;
                const clipElHeight = clipEl.clientHeight || 80;
                const aspectRatio = (c.material.width || 1920) / (c.material.height || 1080);
                const baseThumbWidth = Math.round(clipElHeight * aspectRatio);
                const existingThumbs = thumbContainer.querySelectorAll('.clip-thumbnail');
                const firstThumb = existingThumbs[0];
                const currentFirstTime = firstThumb ? parseFloat(firstThumb.dataset.time || '0') : state.offset;

                const thumbInterval = parseFloat(thumbContainer.dataset.interval) || 
                    (state.duration / existingThumbs.length) || 0.5;
                const thumbWidth = parseFloat(thumbContainer.dataset.thumbWidth) || baseThumbWidth;

                const leftTime = currentFirstTime;
                if (leftTime <= 0) {
                    state.firstThumbTime = currentFirstTime;
                    state.thumbPrepared = true;
                    return;
                }

                const newCount = Math.ceil(leftTime / thumbInterval);
                for (let i = 1; i <= newCount; i++) {
                    const materialTime = currentFirstTime - i * thumbInterval;
                    if (materialTime < 0) break;

                    const timeKey = materialTime.toFixed(3);
                    const existingImg = thumbContainer.querySelector(`img[data-time="${timeKey}"]`);
                    if (existingImg) continue;

                    const img = document.createElement('img');
                    img.className = 'clip-thumbnail';
                    img.style.cssText = `width:${thumbWidth}px;height:100%;flex-shrink:0;object-fit:cover;background:#1a1a2e;display:block;user-select:none;pointer-events:none;`;
                    img.dataset.time = timeKey;

                    thumbContainer.insertBefore(img, thumbContainer.firstChild);

                    const cached = this.getCachedThumb(c.material.id, materialTime);
                    if (cached) {
                        img.src = cached;
                    } else {
                        this.requestThumbnail(c.material, materialTime, (dataUrl) => {
                            if (dataUrl && img && img.isConnected) {
                                img.src = dataUrl;
                            }
                        }, 10);
                    }
                }

                const newFirstThumb = thumbContainer.querySelector('.clip-thumbnail');
                state.firstThumbTime = newFirstThumb ? parseFloat(newFirstThumb.dataset.time || '0') : 0;
                state.thumbPrepared = true;

                const contentWidth = thumbContainer.children.length * thumbWidth;
                state.contentWidth = contentWidth;
                const initialOffsetPx = (state.offset - state.firstThumbTime) * pps;
                thumbContainer.style.left = (-initialOffsetPx) + 'px';
                thumbContainer.style.width = contentWidth + 'px';
            });
        }

        const getMaterialDuration = (c) => {
            if (c.material?.type === 'text' || c.material?.type === 'image') {
                return Infinity;
            }
            if (c.material?.duration && c.material.duration > 0) {
                return c.material.duration;
            }
            return Infinity;
        };

        const onMouseMove = (moveE) => {
            if (!this.isResizing || !this.resizeClip) return;

            const deltaX = moveE.clientX - this.dragStartX;
            const deltaTime = deltaX / this.pixelsPerSecond;

            let minDelta = deltaTime;
            let maxDelta = deltaTime;

            selectedClips.forEach(c => {
                const state = clipStartStates[c.id];
                if (!state) return;

                const matDur = getMaterialDuration(c);

                if (handle === 'right') {
                    const desiredEnd = state.startTime + state.duration + deltaTime;
                    const maxEnd = state.startTime + (matDur - (state.offset || 0));
                    
                    const trackClips = allClipsOnTracks[c.trackIndex] || [];
                    const rightClips = trackClips.filter(oc => oc.startTime >= state.startTime + state.duration);
                    let limitEnd = maxEnd;
                    if (rightClips.length > 0) {
                        const nearestRight = rightClips.reduce((n, oc) =>
                            oc.startTime < n.startTime ? oc : n, rightClips[0]);
                        limitEnd = Math.min(limitEnd, nearestRight.startTime);
                    }
                    
                    let actualEnd = Math.min(desiredEnd, limitEnd);
                    actualEnd = Math.max(actualEnd, state.startTime + 0.5);
                    const actualDelta = actualEnd - (state.startTime + state.duration);
                    if (actualDelta < maxDelta) maxDelta = actualDelta;
                    
                } else if (handle === 'left') {
                    const desiredStart = state.startTime + deltaTime;
                    const minStart = state.offset === 0 ? 0 : -state.offset / 1;
                    
                    const trackClips = allClipsOnTracks[c.trackIndex] || [];
                    const leftClips = trackClips.filter(oc => {
                        const ocEnd = oc.startTime + oc.duration;
                        return ocEnd <= state.startTime;
                    });
                    let limitStart = Math.max(0, desiredStart);
                    if (leftClips.length > 0) {
                        const nearestLeft = leftClips.reduce((n, oc) => {
                            const ocEnd = oc.startTime + oc.duration;
                            const nEnd = n.startTime + n.duration;
                            return ocEnd > nEnd ? oc : n;
                        }, leftClips[0]);
                        limitStart = Math.max(limitStart, nearestLeft.startTime + nearestLeft.duration);
                    }
                    
                    const minDurationStart = state.startTime + state.duration - 0.5;
                    limitStart = Math.min(limitStart, minDurationStart);
                    
                    const actualStart = Math.max(desiredStart, limitStart, 0);
                    const actualDelta = actualStart - state.startTime;
                    if (actualDelta > minDelta) minDelta = actualDelta;
                }
            });

            selectedClips.forEach(c => {
                const state = clipStartStates[c.id];
                if (!state) return;

                if (handle === 'right') {
                    const newDuration = state.duration + maxDelta;
                    c.duration = Math.max(0.5, newDuration);
                } else if (handle === 'left') {
                    const newStartTime = state.startTime + minDelta;
                    const newDuration = state.duration - minDelta;
                    const newOffset = state.offset + minDelta;
                    
                    if (newDuration >= 0.5 && newOffset >= 0) {
                        c.startTime = newStartTime;
                        c.duration = newDuration;
                        c.offset = newOffset;
                    }
                }

                const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${c.id}"]`);
                if (clipEl) {
                    clipEl.style.left = (c.startTime * this.pixelsPerSecond) + 'px';
                    clipEl.style.width = (c.duration * this.pixelsPerSecond) + 'px';
                    
                    if (handle === 'left') {
                        const thumbContainer = clipEl.querySelector('.clip-thumbnails');
                        if (thumbContainer && state.thumbPrepared && state.firstThumbTime !== null) {
                            const offsetPx = (c.offset - state.firstThumbTime) * this.pixelsPerSecond;
                            thumbContainer.style.left = (-offsetPx) + 'px';
                            thumbContainer.style.width = state.contentWidth + 'px';
                            thumbContainer.style.transform = 'none';
                        } else if (thumbContainer) {
                            const offsetDelta = c.offset - state.offset;
                            if (offsetDelta >= 0) {
                                thumbContainer.style.left = (-offsetDelta * this.pixelsPerSecond) + 'px';
                                thumbContainer.style.width = (state.duration * this.pixelsPerSecond) + 'px';
                                thumbContainer.style.transform = 'none';
                            } else {
                                thumbContainer.style.left = '0px';
                                thumbContainer.style.width = (c.duration * this.pixelsPerSecond) + 'px';
                                thumbContainer.style.transform = 'none';
                                this._loadLeftExtensionThumbs(c, clipEl, thumbContainer, state);
                            }
                        }
                    } else if (handle === 'right') {
                        const thumbContainer = clipEl.querySelector('.clip-thumbnails');
                        if (thumbContainer) {
                            const widthDelta = c.duration - state.duration;
                            if (widthDelta > 0) {
                                thumbContainer.style.width = (c.duration * this.pixelsPerSecond) + 'px';
                                this._loadRightExtensionThumbs(c, clipEl, thumbContainer, state);
                            }
                        }
                    }
                    
                    const kfContainer = clipEl.querySelector('.clip-keyframes');
                    if (kfContainer) {
                        const markers = kfContainer.querySelectorAll('.keyframe-marker');
                        markers.forEach(m => {
                            const kfTime = parseFloat(m.dataset.kfTime);
                            if (isNaN(kfTime)) return;
                            const trimSoFar = c.startTime - state.startTime;
                            const appliedTime = Math.max(0, kfTime - trimSoFar);
                            const pct = (appliedTime / c.duration) * 100;
                            m.style.left = Math.min(100, Math.max(0, pct)) + '%';
                        });
                    }
                    
                    this.updatePreviewLayers();
                }
            });
        };

        const onMouseUp = () => {
            this.isResizing = false;
            this.resizeClip = null;
            this.resizeHandle = null;
            
            selectedClips.forEach(c => {
                const state = clipStartStates[c.id];
                if (!state) return;
                
                if (!c.keyframes || c.keyframes.length === 0) return;
                
                if (handle === 'left') {
                    const trimDelta = c.startTime - state.startTime;
                    if (Math.abs(trimDelta) <= 0.01) return;
                    
                    const newKeyframes = [];
                    let beforeCutKf = null;
                    let afterCutKf = null;
                    
                    for (const kf of c.keyframes) {
                        if (kf.time < trimDelta) {
                            beforeCutKf = kf;
                        } else {
                            kf.time = Math.max(0, kf.time - trimDelta);
                            if (kf.time <= c.duration) {
                                newKeyframes.push(kf);
                                if (!afterCutKf) afterCutKf = kf;
                            }
                        }
                    }
                    
                    if (beforeCutKf && afterCutKf) {
                        newKeyframes.unshift({
                            id: 'kf_trim_' + Math.random().toString(36).substr(2, 9),
                            time: 0,
                            props: { ...beforeCutKf.props }
                        });
                    } else if (!afterCutKf && beforeCutKf) {
                        newKeyframes.push({
                            id: 'kf_trim_' + Math.random().toString(36).substr(2, 9),
                            time: 0,
                            props: { ...beforeCutKf.props }
                        });
                    }
                    
                    c.keyframes = newKeyframes.length > 0 ? newKeyframes : null;
                    if (c.keyframes) c.keyframes.sort((a, b) => a.time - b.time);
                    
                } else if (handle === 'right') {
                    c.keyframes = c.keyframes.filter(kf => kf.time <= c.duration);
                    if (c.keyframes.length === 0) c.keyframes = null;
                }
            });
            
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            this.renderTimeline();
            this.updateTotalDuration();

            // 检查是否实际发生了裁剪
            let changed = false;
            for (const c of selectedClips) {
                const st = clipStartStates[c.id];
                if (st && (st.startTime !== c.startTime || st.duration !== c.duration || st.offset !== (c.offset || 0))) {
                    changed = true;
                    break;
                }
            }
            if (changed) {
                this.pushHistory('裁剪素材');
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    startVolumeDrag(e, clipId) {
        e.preventDefault();
        e.stopPropagation();
        
        const clip = this.timelineClips.find(c => c.id === clipId);
        if (!clip) return;

        const clipEl = document.querySelector(`.timeline-clip[data-clip-id="${clipId}"]`);
        if (!clipEl) return;

        const volControl = clipEl.querySelector('.clip-volume-control');
        if (!volControl) return;

        const controlRect = volControl.getBoundingClientRect();
        const controlHeight = controlRect.height;
        const isVideoClip = clipEl.classList.contains('video-clip');
        const waveformCanvas = clipEl.querySelector(isVideoClip ? '.clip-audio-waveform' : '.clip-waveform-canvas');
        const waveformData = this.waveformCache.get(clip.material.id);

        const updateVolumeFromY = (clientY) => {
            const relativeY = clientY - controlRect.top;
            const percent = 1 - (relativeY / controlHeight);
            let newVolume = Math.max(0, Math.min(200, percent * 200));

            clip.effects = clip.effects || {};
            clip.effects.volume = newVolume;

            if (clipId === this.selectedClipId || this.selectedClipIds.has(clipId)) {
                this.currentClipEffects.volume = newVolume;
                this.updatePropertiesPanel();
            }

            this.applyEffectsToPreview();

            const volumeHandle = clipEl.querySelector('.clip-volume-handle');
            if (volumeHandle) {
                if (isVideoClip) {
                    const volumeFraction = newVolume / 200;
                    volumeHandle.style.top = ((1 - volumeFraction) * 100) + '%';
                } else {
                    const volumePercent = Math.min(100, newVolume / 2);
                    volumeHandle.style.top = (100 - volumePercent) + '%';
                }
                volumeHandle.style.bottom = 'auto';
            }

            if (waveformCanvas && waveformData) {
                this.drawWaveformOnCanvas(waveformCanvas, waveformData, newVolume);
            }
        };

        const startVolume = clip.effects ? (clip.effects.volume || 100) : 100;
        updateVolumeFromY(e.clientY);

        const onMouseMove = (moveE) => {
            updateVolumeFromY(moveE.clientY);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            // 音量有变化才记录
            const endVolume = clip.effects ? (clip.effects.volume || 100) : 100;
            if (Math.abs(endVolume - startVolume) > 0.1) {
                this.pushHistory('调整音量');
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    selectClip(clipId, multiSelect = false) {
        if (multiSelect) {
            if (this.selectedClipIds.has(clipId)) {
                this.selectedClipIds.delete(clipId);
                if (this.selectedClipId === clipId) {
                    this.selectedClipId = this.selectedClipIds.size > 0 ? Array.from(this.selectedClipIds)[0] : null;
                }
            } else {
                this.selectedClipIds.add(clipId);
                this.selectedClipId = clipId;
            }
        } else {
            this.selectedClipId = clipId;
            this.selectedClipIds.clear();
            if (clipId !== null) {
                this.selectedClipIds.add(clipId);
            }
        }
        
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        
        if (clip) {
            this.currentClipEffects = { ...clip.effects };
            if (this.currentClipEffects.scaleX === undefined) {
                this.currentClipEffects.scaleX = this.currentClipEffects.scale || 100;
            }
            if (this.currentClipEffects.scaleY === undefined) {
                this.currentClipEffects.scaleY = this.currentClipEffects.scale || 100;
            }
            this.updatePropertiesPanel();
            this.renderKeyframesList();
            this.applyEffectsToPreview();
            
            if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                this.videoRenderer.setSelectedClip(clip.id);
            }
        } else {
            this.updatePropertiesPanel();
            this.renderKeyframesList();
            if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                this.videoRenderer.setSelectedClip(null);
            }
        }

        this.renderTimeline();
        this._updateKeyframeButtonState();
    }
    
    selectClipsInTrack(trackIndex) {
        const trackClips = this.timelineClips.filter(c => c.trackIndex === trackIndex);
        this.selectedClipIds.clear();
        trackClips.forEach(clip => this.selectedClipIds.add(clip.id));
        this.selectedClipId = trackClips.length > 0 ? trackClips[0].id : null;
        
        if (this.selectedClipId) {
            const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
            if (clip) {
                this.currentClipEffects = { ...clip.effects };
                if (this.currentClipEffects.scaleX === undefined) {
                    this.currentClipEffects.scaleX = this.currentClipEffects.scale || 100;
                }
                if (this.currentClipEffects.scaleY === undefined) {
                    this.currentClipEffects.scaleY = this.currentClipEffects.scale || 100;
                }
                this.updatePropertiesPanel();
                this.renderKeyframesList();
                this.applyEffectsToPreview();
            }
            if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                this.videoRenderer.setSelectedClip(this.selectedClipId);
            }
        } else {
            if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                this.videoRenderer.setSelectedClip(null);
            }
        }
        
        this.renderTimeline();
    }

    deleteSelectedClip() {
        const idsToDelete = this.selectedClipIds.size > 0
            ? Array.from(this.selectedClipIds)
            : (this.selectedClipId ? [this.selectedClipId] : []);
        
        if (idsToDelete.length === 0) return;
        
        const materialIdsToCheck = new Set();
        idsToDelete.forEach(id => {
            const index = this.timelineClips.findIndex(c => c.id === id);
            if (index > -1) {
                materialIdsToCheck.add(this.timelineClips[index].materialId);
                this.timelineClips.splice(index, 1);
            }
        });
        
        this.selectedClipId = null;
        this.selectedClipIds.clear();
        this.renderTimeline();
        this.updateTotalDuration();
        
        if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
            this.videoRenderer.setSelectedClip(null);
        }
        
        // 检查被删除素材是否还被其他 clip 使用
        for (const matId of materialIdsToCheck) {
            const stillUsed = this.timelineClips.some(c => c.materialId === matId);
            if (!stillUsed) {
                this.renderMaterials();
                break;
            }
        }

        this.pushHistory('删除素材');
    }

    bindTimelineClick() {
        const tracksArea = document.querySelector('.timeline-tracks-area');
        if (!tracksArea) return;

        let isSelecting = false;
        let selectStartX = 0;
        let selectStartY = 0;
        let selectRect = null;

        const tracksLanes = document.getElementById('tracksContainer');
        const scrollContainer = document.getElementById('tracksScrollContainer');

        const clearSelectionRect = () => {
            if (selectRect) {
                selectRect.remove();
                selectRect = null;
            }
        };

        tracksArea.addEventListener('mousedown', (e) => {
            if (e.target.closest('.timeline-clip')) return;
            if (e.target.closest('.track-header')) return;
            if (e.target.closest('.playhead')) return;
            
            const trackLane = e.target.closest('.track-lane');
            if (trackLane) {
                e.preventDefault();
                e.stopPropagation();
                
                isSelecting = true;
                const rect = tracksLanes ? tracksLanes.getBoundingClientRect() : { left: 0, top: 0 };
                selectStartX = e.clientX - rect.left;
                selectStartY = e.clientY - rect.top;

                selectRect = document.createElement('div');
                selectRect.className = 'selection-rect';
                selectRect.style.cssText = `
                    position: absolute;
                    border: 2px solid var(--primary-color);
                    background: rgba(99, 102, 241, 0.2);
                    pointer-events: none;
                    z-index: 1000;
                    left: ${selectStartX}px;
                    top: ${selectStartY}px;
                    width: 0;
                    height: 0;
                `;
                if (tracksLanes) {
                    tracksLanes.appendChild(selectRect);
                }
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isSelecting || !selectRect) return;

            const rect = tracksLanes ? tracksLanes.getBoundingClientRect() : { left: 0, top: 0 };
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;

            const left = Math.min(selectStartX, currentX);
            const top = Math.min(selectStartY, currentY);
            const width = Math.abs(currentX - selectStartX);
            const height = Math.abs(currentY - selectStartY);

            selectRect.style.left = left + 'px';
            selectRect.style.top = top + 'px';
            selectRect.style.width = width + 'px';
            selectRect.style.height = height + 'px';
        });

        document.addEventListener('mouseup', (e) => {
            if (!isSelecting || !selectRect) return;
            isSelecting = false;

            const rect = selectRect.getBoundingClientRect();

            if (rect.width > 5 && rect.height > 5) {
                const newSelectedIds = new Set();

                console.log('[框选] 框选矩形:', rect.width.toFixed(0)+'x'+rect.height.toFixed(0),
                    'timeStart/End:', 'N/A', '(先用DOM方式)');

                // 先用 DOM 元素的 BoundingRect 做命中检测
                this.timelineClips.forEach(clip => {
                    const clipEl = tracksLanes.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
                    if (!clipEl) {
                        console.log('[框选] 找不到DOM:', clip.id, clip.material?.name);
                        return;
                    }
                    const clipRect = clipEl.getBoundingClientRect();
                    const overlapX = !(clipRect.right < rect.left || clipRect.left > rect.right);
                    const overlapY = !(clipRect.bottom < rect.top || clipRect.top > rect.bottom);
                    if (overlapX && overlapY) {
                        newSelectedIds.add(clip.id);
                    }
                });

                console.log('[框选] 全部素材数:', this.timelineClips.length,
                    '命中素材数:', newSelectedIds.size,
                    '命中IDs:', Array.from(newSelectedIds).map(id => {
                        const c = this.timelineClips.find(x => x.id === id);
                        return c ? c.material?.name : id;
                    }));

                if (newSelectedIds.size > 0) {
                    this._boxSelectTimestamp = Date.now();
                    this.selectedClipIds = newSelectedIds;
                    this.selectedClipId = Array.from(newSelectedIds)[0];
                    
                    const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                    if (clip) {
                        this.currentClipEffects = { ...clip.effects };
                        if (this.currentClipEffects.scaleX === undefined) {
                            this.currentClipEffects.scaleX = this.currentClipEffects.scale || 100;
                        }
                        if (this.currentClipEffects.scaleY === undefined) {
                            this.currentClipEffects.scaleY = this.currentClipEffects.scale || 100;
                        }
                        this.updatePropertiesPanel();
                        this.renderKeyframesList();
                        this.applyEffectsToPreview();
                        
                        if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                            this.videoRenderer.setSelectedClip(this.selectedClipId);
                        }
                    }
                    
                    this.renderTimeline();
                    // renderTimeline 可能会意外清除选中，重新恢复
                    this.selectedClipIds = new Set(Array.from(newSelectedIds));
                    // 重新给 clip DOM 添加 selected 类
                    setTimeout(() => {
                        const lanes = document.getElementById('tracksContainer');
                        if (lanes) {
                            this.selectedClipIds.forEach(id => {
                                const el = lanes.querySelector(`.timeline-clip[data-clip-id="${id}"]`);
                                if (el) el.classList.add('selected');
                            });
                        }
                    }, 0);
                    console.log('[框选] 选中完成，selectedClipIds.size:', this.selectedClipIds.size);
                } else {
                    this.selectedClipIds.clear();
                    this.selectedClipId = null;
                    this.renderTimeline();
                    console.log('[框选] 未选中任何素材');
                }
            }

            clearSelectionRect();
            // 框选后延迟重置标记，确保后续可能触发的 click 事件不会清空选中
            setTimeout(() => { this._boxSelectTimestamp = 0; }, 500);
        });

        tracksArea.addEventListener('click', (e) => {
            if (this._boxSelectTimestamp && Date.now() - this._boxSelectTimestamp < 500) {
                console.log('[框选] click被标记阻拦，跳过');
                return;
            }
            console.log('[框选-click] 触发清除选中');
            if (e.target.classList.contains('track-lane') || e.target.classList.contains('tracks-container')) {
                this.selectedClipId = null;
                this.selectedClipIds.clear();
                this.selectedKeyframeIds.clear();
                this.renderTimeline();
                if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                    this.videoRenderer.setSelectedClip(null);
                }
                this.updatePropertiesPanel();
            }
        });
    }

    bindTimelineRulerClick() {
        const rulerArea = document.querySelector('.timeline-ruler-area');
        if (!rulerArea) return;

        const headerWidth = 120;
        const scrollContainer = document.getElementById('tracksScrollContainer');

        const handleSeek = (clientX, container = null) => {
            let clickX;
            if (container) {
                const containerRect = container.getBoundingClientRect();
                clickX = clientX - containerRect.left;
                if (scrollContainer) {
                    clickX += scrollContainer.scrollLeft;
                }
            } else {
                const rect = rulerArea.getBoundingClientRect();
                clickX = clientX - rect.left - headerWidth;
                const rulerScroll = document.querySelector('.ruler-scroll-container');
                if (rulerScroll) {
                    clickX += rulerScroll.scrollLeft;
                }
            }
            this.currentTime = Math.max(0, clickX / this.pixelsPerSecond);
            if (this.currentTime > this.totalDuration) {
                this.currentTime = this.totalDuration;
            }

            const fps = 30;
            if (this.pixelsPerSecond >= fps) {
                this.currentTime = this.snapToFrame(this.currentTime);
            }

            this.currentTime = this._snapPreviewPlayhead(this.currentTime);

            if (this.isPlaying) {
                this.playheadStartTime = performance.now();
                this.playheadStartPos = this.currentTime;
                if (this.videoRenderer) {
                    this.videoRenderer.seek(this.currentTime);
                }
            } else {
                if (this.videoRenderer) {
                    this.videoRenderer.seek(this.currentTime);
                }
            }
            this.updatePlayheadPosition();
            this.updatePreviewLayers(true);
            this.syncCurrentClipEffectsFromKeyframes();
        };

        rulerArea.addEventListener('click', (e) => {
            handleSeek(e.clientX);
        });

        const playhead = document.getElementById('playhead');
        if (playhead) {
            let isDragging = false;
            
            playhead.style.pointerEvents = 'auto';
            playhead.style.cursor = 'ew-resize';
            
            playhead.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                isDragging = true;
                
                const onMouseMove = (moveE) => {
                    if (!isDragging) return;
                    handleSeek(moveE.clientX);
                };
                
                const onMouseUp = () => {
                    isDragging = false;
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }

        if (scrollContainer) {
            scrollContainer.addEventListener('click', (e) => {
                if (this._boxSelectTimestamp && Date.now() - this._boxSelectTimestamp < 500) {
                    console.log('[scroll-click] 框选标记阻拦');
                    return;
                }
                if (e.target.closest('.timeline-clip')) return;
                if (e.target.closest('.track-header')) return;
                
                console.log('[scroll-click] 触发清除选中，当前selectedClipIds.size:', this.selectedClipIds.size);
                if (this.selectedClipId !== null || this.selectedClipIds.size > 0) {
                    this.selectedClipIds.clear();
                    this.selectedClipId = null;
                    this.currentClipEffects = {
                        opacity: 100,
                        scale: 100,
                        posX: 0,
                        posY: 0,
                        rotation: 0,
                        brightness: 0,
                        contrast: 0,
                        saturation: 0,
                        speed: 1,
                        volume: 100
                    };
                    this.updatePropertiesPanel();
                    this.renderTimeline();
                    
                    if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                        this.videoRenderer.setSelectedClip(null);
                    }
                }
                
                const containerRect = scrollContainer.getBoundingClientRect();
                const clickX = e.clientX - containerRect.left + scrollContainer.scrollLeft;
                this.currentTime = Math.max(0, clickX / this.pixelsPerSecond);
                if (this.currentTime > this.totalDuration) {
                    this.currentTime = this.totalDuration;
                }

                const fps = 30;
                if (this.pixelsPerSecond >= fps) {
                    this.currentTime = this.snapToFrame(this.currentTime);
                }

                this.currentTime = this._snapPreviewPlayhead(this.currentTime);

                if (this.isPlaying) {
                    this.playheadStartTime = performance.now();
                    this.playheadStartPos = this.currentTime;
                }
                if (this.videoRenderer) {
                    this.videoRenderer.seek(this.currentTime);
                }
                this.updatePlayheadPosition();
            });

            scrollContainer.addEventListener('wheel', (e) => {
                if (e.altKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    const delta = e.deltaY > 0 ? -1 : 1;
                    this.zoomTimeline(delta, e.clientX);
                }
            }, { passive: false });

            this.bindPreviewPlayhead(scrollContainer);
            this.bindMarqueeSelection(scrollContainer);
        }
    }

    bindPreviewPlayhead(scrollContainer) {
        if (!scrollContainer) return;
        
        const previewPlayhead = document.getElementById('previewPlayhead');
        if (!previewPlayhead) return;

        let previewTime = 0;
        let lastSeekTime = 0;
        const seekThrottleMs = 120;
        let pendingSeek = null;
        let seekTimer = null;

        const doSeek = (time) => {
            lastSeekTime = performance.now();
            if (this.videoRenderer) {
                this.videoRenderer.seek(time);
            }
        };

        const throttledSeek = (time) => {
            const now = performance.now();
            if (now - lastSeekTime >= seekThrottleMs) {
                doSeek(time);
                pendingSeek = null;
                if (seekTimer) {
                    clearTimeout(seekTimer);
                    seekTimer = null;
                }
            } else {
                pendingSeek = time;
                if (!seekTimer) {
                    seekTimer = setTimeout(() => {
                        seekTimer = null;
                        if (pendingSeek !== null) {
                            doSeek(pendingSeek);
                            pendingSeek = null;
                        }
                    }, seekThrottleMs - (now - lastSeekTime));
                }
            }
        };

        const updatePreview = (clientX) => {
            if (this.isPlaying) return;
            
            const containerRect = scrollContainer.getBoundingClientRect();
            const clickX = clientX - containerRect.left + scrollContainer.scrollLeft;
            previewTime = Math.max(0, clickX / this.pixelsPerSecond);
            if (previewTime > this.totalDuration) {
                previewTime = this.totalDuration;
            }

            const fps = 30;
            if (this.pixelsPerSecond >= fps) {
                previewTime = this.snapToFrame(previewTime);
            }

            previewTime = this._snapPreviewPlayhead(previewTime);

            previewPlayhead.style.left = (previewTime * this.pixelsPerSecond) + 'px';

            throttledSeek(previewTime);
        };

        scrollContainer.addEventListener('mousemove', (e) => {
            if (this.isPlaying) return;
            if (this.isSelecting) return;
            if (e.target.closest('.track-header')) return;
            
            if (previewPlayhead.style.display === 'none') {
                previewPlayhead.style.display = 'block';
            }
            updatePreview(e.clientX);
        });

        scrollContainer.addEventListener('mouseleave', () => {
            if (this.isPlaying) return;
            if (this.isSelecting) return;
            previewPlayhead.style.display = 'none';
            
            if (seekTimer) {
                clearTimeout(seekTimer);
                seekTimer = null;
            }
            pendingSeek = null;
            
            if (this.videoRenderer) {
                this.videoRenderer.seek(this.currentTime);
            }
        });
    }

    bindMarqueeSelection(scrollContainer) {
        if (!scrollContainer) return;

        let marqueeEl = null;
        let startX = 0;
        let startY = 0;
        let isMarquee = false;
        let initiallySelected = new Set();

        const createMarquee = () => {
            marqueeEl = document.createElement('div');
            marqueeEl.style.position = 'absolute';
            marqueeEl.style.border = '1px solid var(--primary-color)';
            marqueeEl.style.background = 'rgba(99, 102, 241, 0.15)';
            marqueeEl.style.pointerEvents = 'none';
            marqueeEl.style.zIndex = '50';
            scrollContainer.appendChild(marqueeEl);
        };

        const removeMarquee = () => {
            if (marqueeEl && marqueeEl.parentNode) {
                marqueeEl.parentNode.removeChild(marqueeEl);
            }
            marqueeEl = null;
        };

        const getClipsInRect = (rectLeft, rectTop, rectRight, rectBottom) => {
            const clips = [];
            const clipEls = scrollContainer.querySelectorAll('.timeline-clip');
            clipEls.forEach(clipEl => {
                const clipRect = clipEl.getBoundingClientRect();
                const containerRect = scrollContainer.getBoundingClientRect();
                const clipLeft = clipRect.left - containerRect.left + scrollContainer.scrollLeft;
                const clipRight = clipLeft + clipRect.width;
                const clipTop = clipRect.top - containerRect.top + scrollContainer.scrollTop;
                const clipBottom = clipTop + clipRect.height;

                if (clipLeft < rectRight && clipRight > rectLeft &&
                    clipTop < rectBottom && clipBottom > rectTop) {
                    const clipId = parseFloat(clipEl.dataset.clipId);
                    clips.push(clipId);
                }
            });
            return clips;
        };

        scrollContainer.addEventListener('mousedown', (e) => {
            if (e.target.closest('.timeline-clip')) return;
            if (e.target.closest('.track-header')) return;
            if (e.target.closest('.playhead')) return;
            if (e.button !== 0) return;

            const previewPlayhead = document.getElementById('previewPlayhead');
            if (previewPlayhead) {
                previewPlayhead.style.display = 'none';
            }

            this.isSelecting = true;
            isMarquee = true;
            const containerRect = scrollContainer.getBoundingClientRect();
            startX = e.clientX - containerRect.left + scrollContainer.scrollLeft;
            startY = e.clientY - containerRect.top + scrollContainer.scrollTop;
            const downClientX = e.clientX;
            const downClientY = e.clientY;

            initiallySelected = new Set(this.selectedClipIds);

            if (!e.shiftKey) {
                this.selectedClipIds.clear();
                this.selectedClipId = null;
            }

            createMarquee();
            
            let hasMoved = false;

            const onMouseMove = (moveE) => {
                if (!isMarquee) return;

                const moveRect = scrollContainer.getBoundingClientRect();
                const currentX = moveE.clientX - moveRect.left + scrollContainer.scrollLeft;
                const currentY = moveE.clientY - moveRect.top + scrollContainer.scrollTop;

                const rectLeft = Math.min(startX, currentX);
                const rectTop = Math.min(startY, currentY);
                const rectWidth = Math.abs(currentX - startX);
                const rectHeight = Math.abs(currentY - startY);

                if (rectWidth < 3 && rectHeight < 3) return;
                
                hasMoved = true;

                marqueeEl.style.left = rectLeft + 'px';
                marqueeEl.style.top = rectTop + 'px';
                marqueeEl.style.width = rectWidth + 'px';
                marqueeEl.style.height = rectHeight + 'px';

                const clipsInRect = getClipsInRect(rectLeft, rectTop, rectLeft + rectWidth, rectTop + rectHeight);
                
                this.selectedClipIds = new Set(initiallySelected);
                clipsInRect.forEach(id => this.selectedClipIds.add(id));
                
                if (this.selectedClipIds.size > 0) {
                    this.selectedClipId = clipsInRect[0];
                } else {
                    this.selectedClipId = null;
                }

                this.updateClipSelectionVisual();
            };

            const onMouseUp = (upE) => {
                isMarquee = false;
                this.isSelecting = false;
                removeMarquee();
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                if (!hasMoved) {
                    const clickX = downClientX - containerRect.left + scrollContainer.scrollLeft;
                    this.currentTime = Math.max(0, clickX / this.pixelsPerSecond);
                    if (this.currentTime > this.totalDuration) {
                        this.currentTime = this.totalDuration;
                    }

                    const fps = 30;
                    if (this.pixelsPerSecond >= fps) {
                        this.currentTime = this.snapToFrame(this.currentTime);
                    }

                    this.currentTime = this._snapPreviewPlayhead(this.currentTime);

                    if (this.isPlaying) {
                        this.playheadStartTime = performance.now();
                        this.playheadStartPos = this.currentTime;
                    }
                    if (this.videoRenderer) {
                        this.videoRenderer.seek(this.currentTime);
                    }
                    this.updatePlayheadPosition();
                    this.updatePreviewLayers(true);
                }

                if (this.selectedClipIds.size > 0) {
                    const firstClip = this.timelineClips.find(c => c.id === this.selectedClipId);
                    if (firstClip) {
                        this.currentClipEffects = { ...firstClip.effects };
                        this.updatePropertiesPanel();
                    }
                    if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                        this.videoRenderer.setSelectedClip(this.selectedClipId);
                    }
                } else {
                    this.currentClipEffects = {
                        opacity: 100,
                        scale: 100,
                        posX: 0,
                        posY: 0,
                        rotation: 0,
                        brightness: 0,
                        contrast: 0,
                        saturation: 0,
                        speed: 1,
                        volume: 100
                    };
                    this.updatePropertiesPanel();
                    if (this.videoRenderer && this.videoRenderer.setSelectedClip) {
                        this.videoRenderer.setSelectedClip(null);
                    }
                }
                this.renderTimeline();
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    updateClipSelectionVisual() {
        const clipEls = document.querySelectorAll('.timeline-clip');
        clipEls.forEach(clipEl => {
            const clipId = parseFloat(clipEl.dataset.clipId);
            if (this.selectedClipIds.has(clipId)) {
                clipEl.classList.add('selected');
            } else {
                clipEl.classList.remove('selected');
            }
        });
    }

    zoomTimeline(direction, anchorClientX = null) {
        const minPps = 10;
        const maxPps = 1000;
        const factor = 1.2;

        let newPps = this.pixelsPerSecond * (direction > 0 ? factor : 1 / factor);
        newPps = Math.max(minPps, Math.min(maxPps, newPps));
        
        if (newPps === this.pixelsPerSecond) return;

        const scrollContainer = document.getElementById('tracksScrollContainer');
        let anchorTime = this.currentTime;
        
        if (anchorClientX !== null && scrollContainer) {
            const containerRect = scrollContainer.getBoundingClientRect();
            const relativeX = anchorClientX - containerRect.left + scrollContainer.scrollLeft;
            anchorTime = relativeX / this.pixelsPerSecond;
        }

        this.pixelsPerSecond = newPps;

        if (scrollContainer) {
            const newScrollLeft = anchorTime * newPps - (anchorClientX !== null && scrollContainer ? anchorClientX - scrollContainer.getBoundingClientRect().left : 0);
            scrollContainer.scrollLeft = Math.max(0, newScrollLeft);
            
            const rulerScroll = document.querySelector('.ruler-scroll-container');
            if (rulerScroll) {
                rulerScroll.scrollLeft = scrollContainer.scrollLeft;
            }
        }

        this.renderTimeline();
        this.updatePlayheadPosition();
        this.requestVisibleThumbs();
    }

    bindTimelineDrop() {
        const tracksArea = document.querySelector('.timeline-tracks-area');
        const scrollContainer = document.getElementById('tracksScrollContainer');
        if (!tracksArea || !scrollContainer) return;

        const tracksLanes = document.getElementById('tracksContainer');

        tracksArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        tracksArea.addEventListener('drop', (e) => {
            e.preventDefault();
            const materialId = parseFloat(e.dataTransfer.getData('materialId'));
            if (!materialId) return;

            const material = this.materials.find(m => m.id === materialId);
            if (!material) return;

            const lanes = tracksLanes.querySelectorAll('.track-lane');
            let targetTrack = 0;
            let dropTime = this.currentTime;

            const firstLane = lanes[0];
            let timeOffset = this.currentTime;
            
            if (firstLane) {
                const laneRect = firstLane.getBoundingClientRect();
                const clickX = e.clientX - laneRect.left + scrollContainer.scrollLeft;
                timeOffset = Math.max(0, clickX / this.pixelsPerSecond);
            }

            let droppedOnValidLane = false;
            lanes.forEach((lane) => {
                const laneRect = lane.getBoundingClientRect();
                if (e.clientY >= laneRect.top && e.clientY <= laneRect.bottom) {
                    const trackAttr = lane.dataset.track;
                    const trackType = lane.dataset.trackType;
                    if (!isNaN(parseInt(trackAttr))) {
                        const trackIdx = parseInt(trackAttr);
                        const isAudioTrack = trackType === 'audio' || trackIdx >= 100;
                        const isAudioMaterial = material.type === 'audio';
                        if (isAudioMaterial === isAudioTrack) {
                            targetTrack = trackIdx;
                            dropTime = timeOffset;
                            droppedOnValidLane = true;
                        }
                    }
                }
            });

            if (!droppedOnValidLane) {
                dropTime = this.currentTime;
                if (material.type === 'audio') {
                    targetTrack = this._findAvailableAudioTrack(dropTime, material.duration || 5);
                } else {
                    targetTrack = this._findAvailableVideoTrack(dropTime, material.duration || 5);
                }
            }

            this.addToTimelineAt(materialId, dropTime, targetTrack);
        });
    }

    _getExtraScrollTime() {
        const pps = this.pixelsPerSecond;
        const fps = 30;
        const frameTime = 1 / fps;

        if (pps >= fps) {
            return frameTime * 10;
        } else if (pps >= 1) {
            return 10;
        } else if (pps >= 1 / 6) {
            return 60;
        } else {
            return 600;
        }
    }

    _getTotalWidthWithPadding() {
        const extraTime = this._getExtraScrollTime();
        const contentWidth = (this.totalDuration + extraTime) * this.pixelsPerSecond;
        return Math.max(contentWidth, 2000);
    }

    updateTotalDuration() {
        if (this.timelineClips.length === 0) {
            this.totalDuration = 0;
        } else {
            const maxEnd = Math.max(...this.timelineClips.map(c => c.startTime + c.duration));
            this.totalDuration = maxEnd;
        }
        this.renderRuler();
        this.updatePlayheadPosition();
    }

    bindZoomControl() {
        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');
        
        if (zoomIn) {
            zoomIn.addEventListener('click', () => {
                this.zoomLevel = Math.min(this.zoomLevel + 25, 400);
                this.updateZoom();
            });
        }
        if (zoomOut) {
            zoomOut.addEventListener('click', () => {
                this.zoomLevel = Math.max(this.zoomLevel - 25, 25);
                this.updateZoom();
            });
        }

        const snapMainTrackBtn = document.getElementById('snapMainTrackBtn');
        if (snapMainTrackBtn) {
            snapMainTrackBtn.addEventListener('click', () => {
                this.snapMainTrack = !this.snapMainTrack;
                snapMainTrackBtn.classList.toggle('active', this.snapMainTrack);
                if (this.snapMainTrack) {
                    this.applyMainTrackSnap();
                }
            });
        }

        const snapClipsBtn = document.getElementById('snapClipsBtn');
        if (snapClipsBtn) {
            snapClipsBtn.addEventListener('click', () => {
                this.snapClips = !this.snapClips;
                snapClipsBtn.classList.toggle('active', this.snapClips);
            });
        }
    }

    updateZoom() {
        const basePps = 10;
        this.pixelsPerSecond = basePps * (this.zoomLevel / 100);
        
        const zoomValue = document.getElementById('zoomValue');
        if (zoomValue) {
            zoomValue.textContent = this.zoomLevel + '%';
        }
        
        this.renderTimeline();
        this.updatePlayheadPosition();
    }

    bindResizers() {
        this.setupHorizontalResizer();
        this.setupVerticalResizers();
    }

    setupVerticalResizers() {
        const leftResizer = document.getElementById('leftResizer');
        const rightResizer = document.getElementById('rightResizer');
        const leftPanel = document.querySelector('.editor-left-panel');
        const rightPanel = document.querySelector('.editor-right-panel');
        const centerPanel = document.querySelector('.editor-center');
        
        if (!leftResizer || !rightResizer || !leftPanel || !rightPanel || !centerPanel) return;

        let isResizing = null;
        let startX = 0;
        let startLeftWidth = 0;
        let startRightWidth = 0;

        const onMouseDown = (side) => (e) => {
            isResizing = side;
            startX = e.clientX;
            startLeftWidth = leftPanel.offsetWidth;
            startRightWidth = rightPanel.offsetWidth;
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        };

        leftResizer.addEventListener('mousedown', onMouseDown('left'));
        rightResizer.addEventListener('mousedown', onMouseDown('right'));

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const delta = e.clientX - startX;
            
            if (isResizing === 'left') {
                const newWidth = Math.max(180, Math.min(400, startLeftWidth + delta));
                leftPanel.style.width = newWidth + 'px';
                leftPanel.style.flex = 'none';
            } else if (isResizing === 'right') {
                const newWidth = Math.max(200, Math.min(400, startRightWidth - delta));
                rightPanel.style.width = newWidth + 'px';
                rightPanel.style.flex = 'none';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    setupHorizontalResizer() {
        const resizer = document.getElementById('bottomResizer');
        const timelineArea = document.querySelector('.timeline-area');
        if (!resizer || !timelineArea) return;

        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            startY = e.clientY;
            startHeight = timelineArea.offsetHeight;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const delta = startY - e.clientY;
            const newHeight = Math.max(60, Math.min(600, startHeight + delta));
            timelineArea.style.height = newHeight + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    bindPropertyControls() {
        const opacitySlider = document.getElementById('opacitySlider');
        const opacityInput = document.getElementById('opacityInput');
        const scaleSlider = document.getElementById('scaleSlider');
        const scaleInput = document.getElementById('scaleInput');
        const rotateSlider = document.getElementById('rotateSlider');
        const rotateInput = document.getElementById('rotateInput');
        const posXInput = document.getElementById('posX');
        const posYInput = document.getElementById('posY');

        const syncSliderAndInput = (slider, input, propName, formatter = v => v, parser = v => parseInt(v) || 0) => {
            if (slider && input) {
                slider.addEventListener('input', (e) => {
                    const val = parser(e.target.value);
                    input.value = formatter(val);
                    this.currentClipEffects[propName] = val;
                    this.updateSelectedClipEffects();
                });
                input.addEventListener('input', (e) => {
                    const val = parser(e.target.value);
                    slider.value = val;
                    this.currentClipEffects[propName] = val;
                    this.updateSelectedClipEffects();
                });
                input.addEventListener('change', (e) => {
                    const val = parser(e.target.value);
                    slider.value = val;
                    e.target.value = formatter(val);
                    this.currentClipEffects[propName] = val;
                    this.updateSelectedClipEffects();
                });
            }
        };

        syncSliderAndInput(opacitySlider, opacityInput, 'opacity', v => v, v => Math.max(0, Math.min(100, parseInt(v) || 0)));
        
        const updateScale = (val) => {
            const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
            if (clip && clip.material && clip.material.type === 'text') {
                // 文本通过字号/排版归一化缩放，不使用 scaleX/scaleY 拉伸
                const td = clip.material.textData || {};
                const oldUniform = ((clip.effects.scale !== undefined ? clip.effects.scale : Math.min(clip.effects.scaleX || 100, clip.effects.scaleY || 100)) || 100) / 100;
                const ratio = val / Math.max(oldUniform, 0.01);
                td.fontSize = Math.max(8, Math.round((td.fontSize || 96) * ratio));
                td.maxWidth = Math.max(50, Math.round((td.maxWidth || 1200) * ratio));
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._refreshTextClipThumb(clip);
                val = 100;
            }
            this.currentClipEffects.scale = val;
            this.currentClipEffects.scaleX = val;
            this.currentClipEffects.scaleY = val;
            this.updateSelectedClipEffects();
        };
        
        if (scaleSlider && scaleInput) {
            scaleSlider.addEventListener('input', (e) => {
                const val = Math.max(0, Math.min(200, parseInt(e.target.value) || 0));
                scaleInput.value = val;
                updateScale(val);
            });
            scaleInput.addEventListener('input', (e) => {
                const val = Math.max(0, Math.min(200, parseInt(e.target.value) || 0));
                scaleSlider.value = val;
                updateScale(val);
            });
            scaleInput.addEventListener('change', (e) => {
                const val = Math.max(0, Math.min(200, parseInt(e.target.value) || 0));
                scaleSlider.value = val;
                e.target.value = val;
                updateScale(val);
            });
        }
        
        syncSliderAndInput(rotateSlider, rotateInput, 'rotation', v => v, v => Math.max(-180, Math.min(180, parseInt(v) || 0)));

        if (posXInput) {
            posXInput.addEventListener('input', (e) => {
                this.currentClipEffects.posX = parseInt(e.target.value) || 0;
                this.updateSelectedClipEffects();
            });
        }

        if (posYInput) {
            posYInput.addEventListener('input', (e) => {
                this.currentClipEffects.posY = parseInt(e.target.value) || 0;
                this.updateSelectedClipEffects();
            });
        }

        const addKeyframeBtn = document.getElementById('addKeyframeBtn');
        if (addKeyframeBtn) {
            addKeyframeBtn.addEventListener('click', () => {
                this.addKeyframe();
            });
        }

        const deleteClipBtn = document.getElementById('deleteClipBtn');
        if (deleteClipBtn) {
            deleteClipBtn.addEventListener('click', () => {
                this.deleteSelectedClip();
            });
        }

        const speedSlider = document.getElementById('speedSlider');
        if (speedSlider) {
            speedSlider.addEventListener('input', (e) => {
                this.currentClipEffects.speed = parseInt(e.target.value) / 100;
                const valSpan = e.target.parentElement.querySelector('.slider-value');
                if (valSpan) valSpan.textContent = (this.currentClipEffects.speed).toFixed(1) + 'x';
                
                document.querySelectorAll('#propSpeed .speed-btn').forEach(btn => {
                    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === this.currentClipEffects.speed);
                });
                
                this.updateSelectedClipEffects();
            });
        }

        document.querySelectorAll('#propSpeed .speed-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#propSpeed .speed-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const speed = parseFloat(btn.dataset.speed);
                this.currentClipEffects.speed = speed;
                
                if (speedSlider) {
                    speedSlider.value = speed * 100;
                    const valSpan = speedSlider.parentElement.querySelector('.slider-value');
                    if (valSpan) valSpan.textContent = speed.toFixed(1) + 'x';
                }
                
                this.updateSelectedClipEffects();
                this.pushHistory('修改速度');
            });
        });

        const audioSection = document.getElementById('propAudio');
        if (audioSection) {
            const volumeSlider = audioSection.querySelector('.slider');
            if (volumeSlider) {
                volumeSlider.addEventListener('input', (e) => {
                    this.currentClipEffects.volume = parseInt(e.target.value);
                    const valSpan = e.target.parentElement.querySelector('.slider-value');
                    if (valSpan) valSpan.textContent = e.target.value + '%';
                    this.updateSelectedClipEffects();
                });
            }
        }

        const colorSection = document.getElementById('propColor');
        if (colorSection) {
            const sliders = colorSection.querySelectorAll('.slider');
            if (sliders[0]) {
                sliders[0].addEventListener('input', (e) => {
                    this.currentClipEffects.brightness = parseInt(e.target.value);
                    const valSpan = e.target.parentElement.querySelector('.slider-value');
                    if (valSpan) valSpan.textContent = e.target.value;
                    this.updateSelectedClipEffects();
                });
            }
            if (sliders[1]) {
                sliders[1].addEventListener('input', (e) => {
                    this.currentClipEffects.contrast = parseInt(e.target.value);
                    const valSpan = e.target.parentElement.querySelector('.slider-value');
                    if (valSpan) valSpan.textContent = e.target.value;
                    this.updateSelectedClipEffects();
                });
            }
            if (sliders[2]) {
                sliders[2].addEventListener('input', (e) => {
                    this.currentClipEffects.saturation = parseInt(e.target.value);
                    const valSpan = e.target.parentElement.querySelector('.slider-value');
                    if (valSpan) valSpan.textContent = e.target.value;
                    this.updateSelectedClipEffects();
                });
            }
        }

        // 为所有属性滑块/输入框添加 change 事件，用于记录历史（input 事件只做实时预览，change 在松手时触发）
        this._bindPropertyChangeHistory();
    }

    /**
     * 为属性面板的所有滑块和输入框添加 change 事件监听，用于撤销历史记录
     * change 事件在用户松手/失焦时触发，比 input 事件更适合做历史记录
     */
    _bindPropertyChangeHistory() {
        const propPanel = document.querySelector('.editor-right-panel') || document.getElementById('propertiesPanel');
        if (!propPanel) return;
        // 委托：监听 change 事件冒泡
        propPanel.addEventListener('change', (e) => {
            const target = e.target;
            if (!target) return;
            // 只对滑块、数字输入框、单选框等响应
            const tag = target.tagName;
            if (tag === 'INPUT' && (target.type === 'range' || target.type === 'number' || target.type === 'text')) {
                this.pushHistory('修改属性');
            } else if (tag === 'SELECT') {
                this.pushHistory('修改属性');
            }
        });
    }

    updateSelectedClipEffects() {
        if (!this.selectedClipId) return;

        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (clip) {
            clip.effects = { ...this.currentClipEffects };

            // 字幕组同步：将当前 effects 同步到同组其他字幕
            if (clip.subtitleGroupId) {
                this._syncSubtitleEffects(clip);
            }

            if (clip.keyframes && clip.keyframes.length > 0) {
                const clipTime = this.currentTime - clip.startTime;
                if (clipTime >= 0 && clipTime <= clip.duration) {
                    const existingKf = clip.keyframes.find(k => Math.abs(k.time - clipTime) < 0.1);
                    if (existingKf) {
                        existingKf.props = { ...this.currentClipEffects };
                    } else {
                        clip.keyframes.push({
                            id: 'kf_' + Math.random().toString(36).substr(2, 9),
                            time: clipTime,
                            props: { ...this.currentClipEffects }
                        });
                    }
                    clip.keyframes.sort((a, b) => a.time - b.time);
                    this.renderKeyframesList();
                    this.renderTimeline();
                }
            }
        }

        this.applyEffectsToPreview();
    }

    /**
     * 同步字幕组内的 effects 属性
     * @param {Object} sourceClip 触发同步的源字幕 clip
     */
    _syncSubtitleEffects(sourceClip) {
        if (!sourceClip || !sourceClip.subtitleGroupId) return;
        const groupId = sourceClip.subtitleGroupId;
        const propsToSync = ['posX', 'posY', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'brightness', 'contrast', 'saturation'];

        for (const clip of this.timelineClips) {
            if (clip.id === sourceClip.id || clip.subtitleGroupId !== groupId) continue;
            if (!clip.effects) clip.effects = {};

            for (const prop of propsToSync) {
                if (sourceClip.effects[prop] !== undefined) {
                    clip.effects[prop] = sourceClip.effects[prop];
                }
            }
        }

        if (this.videoEngine && this.videoEngine._needsRender !== undefined) {
            this.videoEngine._needsRender = true;
        }
    }

    addKeyframe() {
        if (!this.selectedClipId) return;
        
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip) return;
        
        if (!clip.keyframes) {
            clip.keyframes = [];
        }
        
        const clipTime = this.currentTime - clip.startTime;
        if (clipTime < 0 || clipTime > clip.duration) return;
        
        const existingKeyframe = clip.keyframes.find(k => Math.abs(k.time - clipTime) < 0.01);
        if (existingKeyframe) {
            existingKeyframe.props = { ...this.currentClipEffects };
        } else {
            clip.keyframes.push({
                id: 'kf_' + Math.random().toString(36).substr(2, 9),
                time: clipTime,
                props: { ...this.currentClipEffects }
            });
            clip.keyframes.sort((a, b) => a.time - b.time);
        }
        
        this.renderKeyframesList();
        this.renderTimeline();
        this.pushHistory('添加关键帧');
    }

    toggleKeyframeAtCurrentTime() {
        if (!this.selectedClipId) {
            this.showToast('请先选择一个素材');
            return;
        }
        
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip) return;
        
        const clipTime = this.currentTime - clip.startTime;
        if (clipTime < 0 || clipTime > clip.duration) {
            this.showToast('播放头不在选中素材范围内');
            return;
        }
        
        if (!clip.keyframes || clip.keyframes.length === 0) {
            this.addKeyframe();
            return;
        }
        
        const existingKeyframe = clip.keyframes.find(k => Math.abs(k.time - clipTime) < 0.05);
        if (existingKeyframe) {
            this.deleteKeyframe(existingKeyframe.id);
        } else {
            this.addKeyframe();
        }
    }

    deleteKeyframe(keyframeId, clipId = null) {
        const targetClipId = clipId || this.selectedClipId;
        if (!targetClipId) return;

        const clip = this.timelineClips.find(c => c.id === targetClipId);
        if (!clip || !clip.keyframes) return;

        if (this.selectedKeyframeIds.has(keyframeId) && this.selectedKeyframeIds.size > 1) {
            const idsToDelete = new Set(this.selectedKeyframeIds);
            clip.keyframes = clip.keyframes.filter(k => !idsToDelete.has(k.id));
            this.selectedKeyframeIds.clear();
        } else {
            clip.keyframes = clip.keyframes.filter(k => k.id !== keyframeId);
            this.selectedKeyframeIds.delete(keyframeId);
        }

        if (clip.keyframes.length === 0) clip.keyframes = null;
        this.renderKeyframesList();
        this.renderTimeline();
        this.pushHistory('删除关键帧');
    }

    deleteSelectedKeyframes() {
        if (this.selectedKeyframeIds.size === 0 || !this.selectedClipId) return;

        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip || !clip.keyframes) return;

        const idsToDelete = new Set(this.selectedKeyframeIds);
        clip.keyframes = clip.keyframes.filter(k => !idsToDelete.has(k.id));
        this.selectedKeyframeIds.clear();

        if (clip.keyframes.length === 0) clip.keyframes = null;
        this.renderKeyframesList();
        this.renderTimeline();
        this.pushHistory('删除关键帧');
    }

    renderKeyframesList() {
        const list = document.getElementById('keyframesList');
        if (!list) return;

        if (this.keyframesTabMode === 'all') {
            const allKeyframes = [];
            this.timelineClips.forEach(clip => {
                if (clip.keyframes && clip.keyframes.length > 0) {
                    clip.keyframes.forEach(kf => {
                        allKeyframes.push({
                            ...kf,
                            clipId: clip.id,
                            clipName: clip.material?.name || '未知素材',
                            globalTime: clip.startTime + kf.time
                        });
                    });
                }
            });

            if (allKeyframes.length === 0) {
                list.innerHTML = '<div class="keyframes-empty">暂无关键帧</div>';
                return;
            }

            allKeyframes.sort((a, b) => a.globalTime - b.globalTime);

            list.innerHTML = allKeyframes.map(kf => {
                const sx = kf.props.scaleX !== undefined ? kf.props.scaleX : kf.props.scale;
                const sy = kf.props.scaleY !== undefined ? kf.props.scaleY : kf.props.scale;
                const scaleText = (sx === sy) ? `${sx}%` : `${sx}%×${sy}%`;
                const selectedClass = this.selectedKeyframeIds.has(kf.id) ? ' selected' : '';
                const globalMin = Math.floor(kf.globalTime / 60);
                const globalSec = (kf.globalTime % 60).toFixed(2);
                return `
                <div class="keyframe-item${selectedClass}" data-keyframe-id="${kf.id}" data-clip-id="${kf.clipId}">
                    <div>
                        <div class="keyframe-clip-name">${kf.clipName}</div>
                        <div class="keyframe-time">全局: ${globalMin}:${globalSec.padStart(5, '0')} · 片段内: ${kf.time.toFixed(2)}s</div>
                        <div class="keyframe-props">
                            缩放:${scaleText} 旋转:${kf.props.rotation}° 位置:(${kf.props.posX},${kf.props.posY})
                        </div>
                    </div>
                    <span class="keyframe-delete" onclick="event.stopPropagation(); editor.deleteKeyframe('${kf.id}', '${kf.clipId}')">
                        <i class="fa-solid fa-trash"></i>
                    </span>
                </div>
            `}).join('');

            list.querySelectorAll('.keyframe-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const kfId = item.dataset.keyframeId;
                    const clipId = item.dataset.clipId;
                    const clip = this.timelineClips.find(c => c.id === clipId);
                    if (!clip) return;
                    const kf = clip.keyframes?.find(k => k.id === kfId);
                    if (kf) {
                        if (this.selectedClipId !== clipId) {
                            this.selectClip(clipId);
                        }
                        this.currentTime = clip.startTime + kf.time;
                        this.updatePlayheadPosition();
                        this.updatePreviewLayers(true);
                        this.syncCurrentClipEffectsFromKeyframes();

                        if (e.ctrlKey || e.metaKey) {
                            if (this.selectedKeyframeIds.has(kfId)) {
                                this.selectedKeyframeIds.delete(kfId);
                            } else {
                                this.selectedKeyframeIds.add(kfId);
                            }
                        } else {
                            this.selectedKeyframeIds.clear();
                            this.selectedKeyframeIds.add(kfId);
                        }
                        this.renderKeyframesList();
                        this.updateKeyframeSelectionVisuals();
                    }
                });
            });
        } else {
            const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
            if (!clip || !clip.keyframes || clip.keyframes.length === 0) {
                list.innerHTML = '<div class="keyframes-empty">暂无关键帧</div>';
                return;
            }

            list.innerHTML = clip.keyframes.map(kf => {
                const sx = kf.props.scaleX !== undefined ? kf.props.scaleX : kf.props.scale;
                const sy = kf.props.scaleY !== undefined ? kf.props.scaleY : kf.props.scale;
                const scaleText = (sx === sy) ? `${sx}%` : `${sx}%×${sy}%`;
                const selectedClass = this.selectedKeyframeIds.has(kf.id) ? ' selected' : '';
                return `
                <div class="keyframe-item${selectedClass}" data-keyframe-id="${kf.id}" data-clip-id="${clip.id}">
                    <div>
                        <div class="keyframe-time">${kf.time.toFixed(2)}s</div>
                        <div class="keyframe-props">
                            缩放:${scaleText} 旋转:${kf.props.rotation}° 位置:(${kf.props.posX},${kf.props.posY})
                        </div>
                    </div>
                    <span class="keyframe-delete" onclick="event.stopPropagation(); editor.deleteKeyframe('${kf.id}', '${clip.id}')">
                        <i class="fa-solid fa-trash"></i>
                    </span>
                </div>
            `}).join('');

            list.querySelectorAll('.keyframe-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const kfId = item.dataset.keyframeId;
                    const kf = clip.keyframes.find(k => k.id === kfId);
                    if (kf) {
                        this.currentTime = clip.startTime + kf.time;
                        this.updatePlayheadPosition();
                        this.updatePreviewLayers(true);
                        this.syncCurrentClipEffectsFromKeyframes();

                        if (e.ctrlKey || e.metaKey) {
                            if (this.selectedKeyframeIds.has(kfId)) {
                                this.selectedKeyframeIds.delete(kfId);
                            } else {
                                this.selectedKeyframeIds.add(kfId);
                            }
                        } else {
                            this.selectedKeyframeIds.clear();
                            this.selectedKeyframeIds.add(kfId);
                        }
                        this.renderKeyframesList();
                        this.updateKeyframeSelectionVisuals();
                    }
                });
            });
        }
    }

    getInterpolatedEffects(clip, time) {
        if (!clip.keyframes || clip.keyframes.length === 0) {
            const result = { ...(clip.effects || this.currentClipEffects) };
            if (result.scaleX === undefined) result.scaleX = result.scale || 100;
            if (result.scaleY === undefined) result.scaleY = result.scale || 100;
            const clipTime = time - clip.startTime;
            VideoEditor.applyAnimationEffects(clipTime, clip, result);
            return result;
        }
        
        const clipTime = time - clip.startTime;
        let prevKeyframe = null;
        let nextKeyframe = null;
        
        for (let i = 0; i < clip.keyframes.length; i++) {
            if (clip.keyframes[i].time <= clipTime) {
                prevKeyframe = clip.keyframes[i];
            }
            if (clip.keyframes[i].time >= clipTime && !nextKeyframe) {
                nextKeyframe = clip.keyframes[i];
            }
        }
        
        const base = clip.effects || this.currentClipEffects;
        if (base.scaleX === undefined) base.scaleX = base.scale || 100;
        if (base.scaleY === undefined) base.scaleY = base.scale || 100;
        
        if (!prevKeyframe && !nextKeyframe) {
            const result = { ...base };
            VideoEditor.applyAnimationEffects(clipTime, clip, result);
            return result;
        }
        
        if (!prevKeyframe) {
            const result = { ...base };
            for (const prop in nextKeyframe.props) {
                if (nextKeyframe.props[prop] !== undefined) {
                    result[prop] = nextKeyframe.props[prop];
                }
            }
            if (result.scaleX === undefined) result.scaleX = result.scale || base.scaleX;
            if (result.scaleY === undefined) result.scaleY = result.scale || base.scaleY;
            VideoEditor.applyAnimationEffects(clipTime, clip, result);
            return result;
        }
        
        if (!nextKeyframe) {
            const result = { ...base };
            for (const prop in prevKeyframe.props) {
                if (prevKeyframe.props[prop] !== undefined) {
                    result[prop] = prevKeyframe.props[prop];
                }
            }
            if (result.scaleX === undefined) result.scaleX = result.scale || base.scaleX;
            if (result.scaleY === undefined) result.scaleY = result.scale || base.scaleY;
            VideoEditor.applyAnimationEffects(clipTime, clip, result);
            return result;
        }
        
        const dur = nextKeyframe.time - prevKeyframe.time;
        const t = dur > 0.001 ? (clipTime - prevKeyframe.time) / dur : 0;
        
        const interpolate = (prop) => {
            const start = prevKeyframe.props[prop] !== undefined ? prevKeyframe.props[prop] : base[prop];
            const end = nextKeyframe.props[prop] !== undefined ? nextKeyframe.props[prop] : base[prop];
            return start + (end - start) * t;
        };
        
        const scaleX = interpolate('scaleX');
        const scaleY = interpolate('scaleY');
        
        const result = {
            opacity: interpolate('opacity'),
            scale: interpolate('scale'),
            scaleX,
            scaleY,
            posX: interpolate('posX'),
            posY: interpolate('posY'),
            rotation: interpolate('rotation'),
            brightness: interpolate('brightness'),
            contrast: interpolate('contrast'),
            saturation: interpolate('saturation'),
            volume: interpolate('volume'),
            speed: prevKeyframe.props.speed !== undefined ? prevKeyframe.props.speed : (base.speed !== undefined ? base.speed : 1)
        };
        VideoEditor.applyAnimationEffects(clipTime, clip, result);
        return result;
    }

    applyEffectsToPreview() {
        this.updatePreviewLayers();
    }

    updateKeyframeSelectionVisuals() {
        document.querySelectorAll('.keyframe-marker').forEach(marker => {
            const kfId = marker.dataset.keyframeId;
            if (this.selectedKeyframeIds.has(kfId)) {
                marker.classList.add('selected');
            } else {
                marker.classList.remove('selected');
            }
        });
    }

    updatePropertiesPanel() {
        if (!this.selectedClipId) {
            this.showProjectInfoPanel();
            return;
        }

        const effects = this.currentClipEffects;
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        const isText = clip && clip.material && clip.material.type === 'text';

        document.querySelectorAll('.prop-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.prop-section').forEach(s => s.classList.remove('active'));

        // 文本 tab 仅在选中片段为文本时显示
        const textTab = document.getElementById('propTextTab');
        if (textTab) {
            textTab.style.display = isText ? '' : 'none';
        }

        if (isText) {
            const textTabActive = document.querySelector('.prop-tab[data-proptab="text"]');
            if (textTabActive) textTabActive.classList.add('active');
            const propText = document.getElementById('propText');
            if (propText) {
                propText.classList.add('active');
                propText.style.display = '';
            }
        } else {
            const videoTab = document.querySelector('.prop-tab[data-proptab="video"]');
            if (videoTab) videoTab.classList.add('active');
            const propVideo = document.getElementById('propVideo');
            if (propVideo) propVideo.classList.add('active');
        }

        const opacitySlider = document.getElementById('opacitySlider');
        const opacityInput = document.getElementById('opacityInput');
        const scaleSlider = document.getElementById('scaleSlider');
        const scaleInput = document.getElementById('scaleInput');
        const rotateSlider = document.getElementById('rotateSlider');
        const rotateInput = document.getElementById('rotateInput');
        const posXInput = document.getElementById('posX');
        const posYInput = document.getElementById('posY');

        if (opacitySlider) opacitySlider.value = effects.opacity;
        if (opacityInput) opacityInput.value = effects.opacity;
        if (scaleSlider) scaleSlider.value = effects.scale;
        if (scaleInput) scaleInput.value = effects.scale;
        if (rotateSlider) rotateSlider.value = effects.rotation;
        if (rotateInput) rotateInput.value = effects.rotation;
        if (posXInput) posXInput.value = effects.posX;
        if (posYInput) posYInput.value = effects.posY;

        const speedSlider = document.getElementById('speedSlider');
        if (speedSlider) {
            speedSlider.value = effects.speed * 100;
            const valSpan = speedSlider.parentElement.querySelector('.slider-value');
            if (valSpan) valSpan.textContent = effects.speed.toFixed(1) + 'x';
        }

        document.querySelectorAll('#propSpeed .speed-btn').forEach(btn => {
            btn.classList.toggle('active', parseFloat(btn.dataset.speed) === effects.speed);
        });

        const audioSection = document.getElementById('propAudio');
        if (audioSection) {
            const volumeSlider = audioSection.querySelector('.slider');
            if (volumeSlider) {
                volumeSlider.value = effects.volume;
                const valSpan = volumeSlider.parentElement.querySelector('.slider-value');
                if (valSpan) valSpan.textContent = effects.volume + '%';
            }
        }

        const colorSection = document.getElementById('propColor');
        if (colorSection) {
            const sliders = colorSection.querySelectorAll('.slider');
            if (sliders[0]) {
                sliders[0].value = effects.brightness;
                const valSpan = sliders[0].parentElement.querySelector('.slider-value');
                if (valSpan) valSpan.textContent = effects.brightness;
            }
            if (sliders[1]) {
                sliders[1].value = effects.contrast;
                const valSpan = sliders[1].parentElement.querySelector('.slider-value');
                if (valSpan) valSpan.textContent = effects.contrast;
            }
            if (sliders[2]) {
                sliders[2].value = effects.saturation;
                const valSpan = sliders[2].parentElement.querySelector('.slider-value');
                if (valSpan) valSpan.textContent = effects.saturation;
            }
        }

        // 文本属性同步
        if (isText && clip && clip.material && clip.material.textData) {
            this._syncTextPropertiesPanel(clip.material.textData);
        }

        // 动画UI同步
        if (clip) {
            this._syncAnimationUI(clip);
        }
    }

    _syncTextPropertiesPanel(textData) {
        const textContent = document.getElementById('textContent');
        const textFontFamily = document.getElementById('textFontFamily');
        const textFontSize = document.getElementById('textFontSize');
        const textFontSizeInput = document.getElementById('textFontSizeInput');
        const textLetterSpacing = document.getElementById('textLetterSpacing');
        const textLetterSpacingInput = document.getElementById('textLetterSpacingInput');
        const textLineHeight = document.getElementById('textLineHeight');
        const textLineHeightInput = document.getElementById('textLineHeightInput');
        const textColor = document.getElementById('textColor');
        const textBoldBtn = document.getElementById('textBoldBtn');
        const textItalicBtn = document.getElementById('textItalicBtn');
        const textUnderlineBtn = document.getElementById('textUnderlineBtn');
        const textStrokeColor = document.getElementById('textStrokeColor');
        const textStrokeWidth = document.getElementById('textStrokeWidth');
        const textStrokeWidthInput = document.getElementById('textStrokeWidthInput');

        if (textContent) textContent.value = textData.text || '';
        if (textFontFamily) textFontFamily.value = textData.fontFamily || 'Microsoft YaHei, sans-serif';
        if (textFontSize) textFontSize.value = textData.fontSize || 96;
        if (textFontSizeInput) textFontSizeInput.value = textData.fontSize || 96;
        if (textLetterSpacing) textLetterSpacing.value = textData.letterSpacing || 0;
        if (textLetterSpacingInput) textLetterSpacingInput.value = textData.letterSpacing || 0;
        if (textLineHeight) textLineHeight.value = textData.lineHeight || 1.2;
        if (textLineHeightInput) textLineHeightInput.value = (textData.lineHeight || 1.2).toFixed(2);
        if (textColor) textColor.value = textData.color || '#ffffff';
        if (textBoldBtn) textBoldBtn.style.background = (textData.fontWeight === 'bold' || textData.fontWeight === '700') ? '#00d4ff' : '#2a2a35';
        if (textItalicBtn) textItalicBtn.style.background = (textData.fontStyle === 'italic') ? '#00d4ff' : '#2a2a35';
        if (textUnderlineBtn) textUnderlineBtn.style.background = (textData.textDecoration === 'underline') ? '#00d4ff' : '#2a2a35';

        document.querySelectorAll('.text-align-btn').forEach(btn => {
            const align = btn.dataset.align;
            btn.style.background = (textData.align === align) ? '#00d4ff' : '#2a2a35';
        });

        if (textData.stroke) {
            if (textStrokeColor) textStrokeColor.value = textData.stroke.color || '#000000';
            if (textStrokeWidth) textStrokeWidth.value = textData.stroke.width || 0;
            if (textStrokeWidthInput) textStrokeWidthInput.value = textData.stroke.width || 0;
        } else {
            if (textStrokeColor) textStrokeColor.value = '#000000';
            if (textStrokeWidth) textStrokeWidth.value = 0;
            if (textStrokeWidthInput) textStrokeWidthInput.value = 0;
        }
    }

    _normalizeTextScale(clip) {
        if (!clip || !clip.material || clip.material.type !== 'text') return;
        const effects = clip.effects || {};
        const scale = ((effects.scale !== undefined ? effects.scale : Math.min(effects.scaleX || 100, effects.scaleY || 100)) || 100) / 100;
        if (Math.abs(scale - 1) < 0.001) return;
        const td = clip.material.textData || {};
        td.fontSize = Math.max(8, Math.round((td.fontSize || 96) * scale));
        td.maxWidth = Math.max(50, Math.round((td.maxWidth || 1200) * scale));
        effects.scale = 100;
        effects.scaleX = 100;
        effects.scaleY = 100;
        if (window.textManager) window.textManager.invalidate(clip.material.id);
    }

    _updateTextProperty(propName, value) {
        if (!this.selectedClipId) return;
        const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
        if (!clip || !clip.material || clip.material.type !== 'text') return;
        if (!clip.material.textData) clip.material.textData = {};

        clip.material.textData[propName] = value;

        if (window.textManager) {
            window.textManager.invalidate(clip.material.id);
        }

        // 字幕组样式同步：修改文本样式时同步到同组其他字幕
        if (clip.subtitleGroupId && propName !== 'text') {
            this._syncSubtitleStyles(clip);
        }

        this._refreshTextClipThumb(clip);

        this.updateSelectedClipEffects();
        this.applyEffectsToPreview();
        this.updatePropertiesPanel();
        this.pushHistory('修改文本属性');
    }

    _refreshTextClipThumb(clip) {
        const tracksLanes = document.getElementById('tracksContainer');
        if (!tracksLanes) return;
        const clipEl = tracksLanes.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
        if (!clipEl) return;
        this._renderTextClipThumb(clip, clipEl);
    }

    _renderTextClipThumb(clip, clipEl) {
        if (!clip || !clip.material || clip.material.type !== 'text') return;
        if (!window.textManager) window.textManager = new TextManager();
        const canvas = clipEl.querySelector('.clip-text-thumb');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = clipEl.clientWidth || 200;
        const h = clipEl.clientHeight || 60;
        canvas.width = Math.max(50, Math.floor(w * dpr));
        canvas.height = Math.max(20, Math.floor(h * dpr));
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const td = clip.material.textData || {};
        const text = (td.text || '默认文本');
        const fontSize = Math.max(8, Math.min(28, (h - 12) * 0.6));
        const fontFamily = td.fontFamily || 'Microsoft YaHei, sans-serif';
        const fontWeight = td.fontWeight || 'normal';
        const fontStyle = td.fontStyle || 'normal';
        const color = td.color || '#ffffff';

        ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        const maxWidth = w - 16;
        let displayText = text;
        const metrics = ctx.measureText(displayText);
        if (metrics.width > maxWidth) {
            while (displayText.length > 1 && ctx.measureText(displayText + '…').width > maxWidth) {
                displayText = displayText.slice(0, -1);
            }
            displayText += '…';
        }
        ctx.fillText(displayText, 8, h / 2);

        if (td.stroke && td.stroke.width > 0) {
            ctx.strokeStyle = td.stroke.color || '#000000';
            ctx.lineWidth = td.stroke.width;
            ctx.strokeText(displayText, 8, h / 2);
        }
    }

    bindTextPropertyEvents() {
        const textContent = document.getElementById('textContent');
        if (textContent) {
            textContent.addEventListener('input', (e) => {
                this._updateTextProperty('text', e.target.value);
            });
            textContent.addEventListener('change', (e) => {
                this._updateTextProperty('text', e.target.value);
            });
        }

        const textFontFamily = document.getElementById('textFontFamily');
        if (textFontFamily) {
            textFontFamily.addEventListener('change', (e) => {
                this._updateTextProperty('fontFamily', e.target.value);
            });
        }

        const textFontSize = document.getElementById('textFontSize');
        const textFontSizeInput = document.getElementById('textFontSizeInput');
        if (textFontSize) {
            textFontSize.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (textFontSizeInput) textFontSizeInput.value = val;
                this._updateTextProperty('fontSize', val);
            });
        }
        if (textFontSizeInput) {
            textFontSizeInput.addEventListener('change', (e) => {
                const val = parseInt(e.target.value) || 96;
                if (textFontSize) textFontSize.value = val;
                this._updateTextProperty('fontSize', val);
            });
        }

        const textLetterSpacing = document.getElementById('textLetterSpacing');
        const textLetterSpacingInput = document.getElementById('textLetterSpacingInput');
        if (textLetterSpacing) {
            textLetterSpacing.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (textLetterSpacingInput) textLetterSpacingInput.value = val;
                this._updateTextProperty('letterSpacing', val);
            });
        }
        if (textLetterSpacingInput) {
            textLetterSpacingInput.addEventListener('change', (e) => {
                const val = parseInt(e.target.value) || 0;
                if (textLetterSpacing) textLetterSpacing.value = val;
                this._updateTextProperty('letterSpacing', val);
            });
        }

        const textLineHeight = document.getElementById('textLineHeight');
        const textLineHeightInput = document.getElementById('textLineHeightInput');
        if (textLineHeight) {
            textLineHeight.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                if (textLineHeightInput) textLineHeightInput.value = val.toFixed(2);
                this._updateTextProperty('lineHeight', val);
            });
        }
        if (textLineHeightInput) {
            textLineHeightInput.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value) || 1.2;
                if (textLineHeight) textLineHeight.value = val;
                this._updateTextProperty('lineHeight', val);
            });
        }

        const textColor = document.getElementById('textColor');
        if (textColor) {
            textColor.addEventListener('input', (e) => {
                this._updateTextProperty('color', e.target.value);
            });
        }

        const textBoldBtn = document.getElementById('textBoldBtn');
        if (textBoldBtn) {
            textBoldBtn.addEventListener('click', () => {
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                const isBold = clip.material.textData.fontWeight === 'bold' || clip.material.textData.fontWeight === '700';
                clip.material.textData.fontWeight = isBold ? 'normal' : 'bold';
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._syncTextPropertiesPanel(clip.material.textData);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('切换加粗');
            });
        }

        const textItalicBtn = document.getElementById('textItalicBtn');
        if (textItalicBtn) {
            textItalicBtn.addEventListener('click', () => {
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                const isItalic = clip.material.textData.fontStyle === 'italic';
                clip.material.textData.fontStyle = isItalic ? 'normal' : 'italic';
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._syncTextPropertiesPanel(clip.material.textData);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('切换斜体');
            });
        }

        const textUnderlineBtn = document.getElementById('textUnderlineBtn');
        if (textUnderlineBtn) {
            textUnderlineBtn.addEventListener('click', () => {
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                const isUnderline = clip.material.textData.textDecoration === 'underline';
                clip.material.textData.textDecoration = isUnderline ? 'none' : 'underline';
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._syncTextPropertiesPanel(clip.material.textData);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('切换下划线');
            });
        }

        document.querySelectorAll('.text-align-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const align = btn.dataset.align;
                this._updateTextProperty('align', align);
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (clip && clip.material && clip.material.textData) {
                    this._syncTextPropertiesPanel(clip.material.textData);
                }
            });
        });

        const textStrokeColor = document.getElementById('textStrokeColor');
        if (textStrokeColor) {
            textStrokeColor.addEventListener('input', (e) => {
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                if (!clip.material.textData.stroke) clip.material.textData.stroke = { color: '#000000', width: 0 };
                clip.material.textData.stroke.color = e.target.value;
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('修改描边颜色');
            });
        }

        const textStrokeWidth = document.getElementById('textStrokeWidth');
        const textStrokeWidthInput = document.getElementById('textStrokeWidthInput');
        if (textStrokeWidth) {
            textStrokeWidth.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (textStrokeWidthInput) textStrokeWidthInput.value = val;
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                if (!clip.material.textData.stroke) clip.material.textData.stroke = { color: '#000000', width: 0 };
                clip.material.textData.stroke.width = val;
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('修改描边宽度');
            });
        }
        if (textStrokeWidthInput) {
            textStrokeWidthInput.addEventListener('change', (e) => {
                const val = parseInt(e.target.value) || 0;
                if (textStrokeWidth) textStrokeWidth.value = val;
                if (!this.selectedClipId) return;
                const clip = this.timelineClips.find(c => c.id === this.selectedClipId);
                if (!clip || !clip.material || clip.material.type !== 'text' || !clip.material.textData) return;
                if (!clip.material.textData.stroke) clip.material.textData.stroke = { color: '#000000', width: 0 };
                clip.material.textData.stroke.width = val;
                if (window.textManager) window.textManager.invalidate(clip.material.id);
                this._refreshTextClipThumb(clip);
                this.applyEffectsToPreview();
                this.pushHistory('修改描边宽度');
            });
        }
    }

    showProjectInfoPanel() {
        document.querySelectorAll('.prop-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.prop-section').forEach(s => s.classList.remove('active'));

        let infoPanel = document.getElementById('propProjectInfo');
        if (!infoPanel) {
            infoPanel = document.createElement('div');
            infoPanel.id = 'propProjectInfo';
            infoPanel.className = 'prop-section';
            document.querySelector('.prop-content').appendChild(infoPanel);
        }

        const totalDuration = this.totalDuration || 0;
        const formatTime = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = Math.floor(sec % 60);
            if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        const clipCount = this.timelineClips.length;
        const videoClips = this.timelineClips.filter(c => c.material?.type === 'video').length;
        const imageClips = this.timelineClips.filter(c => c.material?.type === 'image').length;
        const audioClips = this.timelineClips.filter(c => c.material?.type === 'audio').length;

        infoPanel.innerHTML = `
            <div class="prop-group">
                <h4>项目信息</h4>
                <div class="project-info-row">
                    <label>导出文件名</label>
                    <div class="project-info-value">
                        <input type="text" id="exportFileName" value="${this.exportFileName || 'project.mp4'}" placeholder="输入文件名">
                    </div>
                </div>
                <div class="project-info-row">
                    <label>总时长</label>
                    <div class="project-info-value">${formatTime(totalDuration)}</div>
                </div>
                <div class="project-info-row">
                    <label>片段数量</label>
                    <div class="project-info-value">${clipCount} 个</div>
                </div>
                <div class="project-info-row">
                    <label>视频片段</label>
                    <div class="project-info-value">${videoClips} 个</div>
                </div>
                <div class="project-info-row">
                    <label>图片片段</label>
                    <div class="project-info-value">${imageClips} 个</div>
                </div>
                <div class="project-info-row">
                    <label>音频片段</label>
                    <div class="project-info-value">${audioClips} 个</div>
                </div>
            </div>
            <div class="prop-group">
                <h4>快捷操作</h4>
                <div class="quick-actions">
                    <button class="quick-action-btn" onclick="editor.exportProject()"><i class="fa-solid fa-download"></i> 导出视频</button>
                    <button class="quick-action-btn" onclick="editor.showExportDialog()"><i class="fa-solid fa-cog"></i> 导出设置</button>
                </div>
            </div>
        `;

        const fileNameInput = document.getElementById('exportFileName');
        if (fileNameInput) {
            fileNameInput.addEventListener('input', (e) => {
                this.exportFileName = e.target.value;
            });
        }

        infoPanel.classList.add('active');
    }
}

class ThumbnailPreloader {
    constructor(editor) {
        this.editor = editor;
        this.preloadQueue = [];
        this.isProcessing = false;
        this.thumbWidth = 160;
        this.thumbHeight = 90;
        this.preloadInterval = 0.5;
        this.activeDecoders = new Map();
        this.maxActiveDecoders = 2;
        this.audioPromises = new Map(); // 存储音频解码 Promise
    }

    static isSupported() {
        return typeof VideoDecoder !== 'undefined' &&
               typeof MP4Demuxer !== 'undefined' &&
               typeof VideoFrame !== 'undefined';
    }

    hasActivePreloads() {
        return this.activeDecoders.size > 0 || this.preloadQueue.length > 0;
    }

    notifyAudioComplete(materialId) {
        // 音频完成后，唤醒可能正在等待的缩略图预加载
        const resolver = this.audioPromises.get(materialId);
        if (resolver) {
            resolver();
            this.audioPromises.delete(materialId);
        }
    }

    startPreload(material, audioPromise = null) {
        if (!material || material.type !== 'video') return;
        
        const isMP4 = (material.file && material.file.type === 'video/mp4') ||
            material.name.toLowerCase().endsWith('.mp4');
        
        const existing = this.preloadQueue.find(m => m.id === material.id);
        if (existing || this.activeDecoders.has(material.id)) {
            return;
        }

        console.log(`[ThumbPreloader] 加入预加载队列: ${material.name} (${isMP4 ? 'MP4' : '非MP4'})`);
        material._audioPromise = audioPromise;
        material._useVideoElement = !isMP4;
        this.preloadQueue.push(material);
        
        setTimeout(() => this._processQueue(), 100);
    }

    async _processQueue() {
        if (this.isProcessing) return;
        if (this.preloadQueue.length === 0) return;
        if (this.activeDecoders.size >= this.maxActiveDecoders) return;

        this.isProcessing = true;

        while (this.preloadQueue.length > 0 && this.activeDecoders.size < this.maxActiveDecoders) {
            const material = this.preloadQueue.shift();
            this._preloadMaterial(material, material._audioPromise).catch(err => {
                console.warn(`[ThumbPreloader] 预加载失败: ${material.name}`, err);
                this.activeDecoders.delete(material.id);
            });
        }

        this.isProcessing = false;
    }

    async _preloadMaterial(material, audioPromise = null) {
        if (this.activeDecoders.has(material.id)) return;
        this.activeDecoders.set(material.id, true);

        const startTime = performance.now();
        console.log(`[ThumbPreloader] 开始预解码: ${material.name}`);

        // 非 MP4 文件：使用 video 元素生成缩略图
        if (material._useVideoElement) {
            try {
                await this._preloadWithVideoElement(material);
            } catch (err) {
                console.warn(`[ThumbPreloader] video 元素缩略图失败: ${material.name}`, err);
            } finally {
                this.activeDecoders.delete(material.id);
                this._processQueue();
            }
            return;
        }

        try {
            const demuxer = await mp4DemuxerCache.get(material);

            if (!demuxer.videoTrack || demuxer.videoSamples.length === 0) {
                console.warn(`[ThumbPreloader] 无视频轨道: ${material.name}`);
                return;
            }

            const videoConfig = demuxer.getVideoConfig();
            if (!videoConfig || !videoConfig.description) {
                console.warn(`[ThumbPreloader] 无效的视频配置: ${material.name}`);
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = this.thumbWidth;
            canvas.height = this.thumbHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            const intervals = [2.0, 1.0, 0.5, 0.25, 0.1];
            const totalSamples = demuxer.videoSamples.length;

            // ===== 阶段1：只解码关键帧，快速生成级别1（2秒间隔）=====
            const keyframeInterval = intervals[0];
            const keyframeSamples = [];
            for (let i = 0; i < totalSamples; i++) {
                if (demuxer.videoSamples[i].isKeyframe) {
                    keyframeSamples.push(i);
                }
            }
            console.log(`[ThumbPreloader] 关键帧数量: ${keyframeSamples.length}/${totalSamples}`);

            let lastCapturedTime = -Infinity;
            const level1Decoder = new VideoDecoder({
                output: (frame) => {
                    const timestampSec = frame.timestamp / 1000000;
                    if (timestampSec - lastCapturedTime >= keyframeInterval - 0.1) {
                        lastCapturedTime = timestampSec;
                        const snappedTime = Math.round(timestampSec / keyframeInterval) * keyframeInterval;
                        ctx.drawImage(frame, 0, 0, this.thumbWidth, this.thumbHeight);
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.4);
                        this.editor.setCachedThumb(material.id, snappedTime, dataUrl);
                    }
                    frame.close();
                },
                error: (err) => console.error(`[ThumbPreloader] 级别1解码错误:`, err)
            });

            level1Decoder.configure(videoConfig);

            for (let i = 0; i < keyframeSamples.length; i++) {
                const chunk = await demuxer.getVideoChunk(keyframeSamples[i]);
                if (chunk) level1Decoder.decode(chunk);

                if (level1Decoder.decodeQueueSize > 10) {
                    await new Promise(resolve => {
                        const check = () => {
                            if (level1Decoder.decodeQueueSize <= 5) resolve();
                            else requestAnimationFrame(check);
                        };
                        requestAnimationFrame(check);
                    });
                }

                // 每处理16个关键帧让出一次，避免阻塞音频解码
                if (i % 16 === 15) {
                    await this._yieldToMainThread();
                }
            }

            await level1Decoder.flush();
            level1Decoder.close();

            const level1Elapsed = (performance.now() - startTime) / 1000;
            console.log(`[ThumbPreloader] ✅ 级别1完成(${keyframeInterval}s): ${material.name}, ${level1Elapsed.toFixed(1)}s`);

            // 大文件限制：超过100MB只预加载级别1，避免内存爆炸
            const fileSizeMB = (material.size || (material._arrayBuffer?.byteLength || 0)) / 1024 / 1024;
            if (fileSizeMB > 100) {
                console.log(`[ThumbPreloader] ⚠️ 大文件(${fileSizeMB.toFixed(0)}MB)跳过级别2-5预加载`);
                this.activeDecoders.delete(material.id);
                return;
            }

            // 级别1完成后立即刷新UI
            if (this.editor._scheduleThumbRefresh) {
                this.editor._scheduleThumbRefresh();
            }

            // ===== 等待音频解码完成通知后再继续级别2-5 =====
            // 级别2-5 解码很密集，会阻塞音频解码，所以必须等音频完成
            if (!this.audioPromises.has(material.id)) {
                const audioWaitPromise = new Promise(resolve => {
                    this.audioPromises.set(material.id, resolve);
                });
                console.log(`[ThumbPreloader] 等待音频解码完成: ${material.name}`);
                await audioWaitPromise;
                console.log(`[ThumbPreloader] 音频完成，按需解码模式: ${material.name}`);
            }

            this.activeDecoders.delete(material.id);

            // 大文件只保留级别1，小文件触发按需解码检查
            if (fileSizeMB <= 100) {
                if (this.editor._scheduleThumbRefresh) {
                    this.editor._scheduleThumbRefresh();
                }
            }

            const totalElapsed = (performance.now() - startTime) / 1000;
            console.log(`[ThumbPreloader] 全部完成: ${material.name}, ${totalElapsed.toFixed(1)}s`);

        } catch (err) {
            console.error(`[ThumbPreloader] 预解码异常: ${material.name}`, err);
        } finally {
            this.activeDecoders.delete(material.id);
            this._processQueue();
        }
    }

    _yieldToMainThread() {
        return new Promise(resolve => {
            setTimeout(resolve, 50);
        });
    }

    async _preloadWithVideoElement(material) {
        const startTime = performance.now();
        const url = material.url;
        const duration = material.duration || 10;

        console.log(`[ThumbPreloader] 使用 video 元素生成缩略图: ${material.name}`);

        const video = document.createElement('video');
        video.src = url;
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.style.display = 'none';
        document.body.appendChild(video);

        try {
            await new Promise((resolve, reject) => {
                const onLoaded = () => {
                    video.removeEventListener('loadedmetadata', onLoaded);
                    video.removeEventListener('error', onError);
                    resolve();
                };
                const onError = () => {
                    video.removeEventListener('loadedmetadata', onLoaded);
                    video.removeEventListener('error', onError);
                    reject(new Error('视频加载失败'));
                };
                video.addEventListener('loadedmetadata', onLoaded);
                video.addEventListener('error', onError);
                setTimeout(() => reject(new Error('加载超时')), 10000);
            });

            const videoDuration = video.duration || duration;
            material.duration = videoDuration;

            const canvas = document.createElement('canvas');
            canvas.width = this.thumbWidth;
            canvas.height = this.thumbHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            const fileSizeMB = (material.size || (material._arrayBuffer?.byteLength || 0)) / 1024 / 1024;

            const levels = [
                { interval: 2.0, quality: 0.5, label: '级别1' },
            ];

            if (fileSizeMB <= 100) {
                levels.push(
                    { interval: 1.0, quality: 0.4, label: '级别2' },
                    { interval: 0.5, quality: 0.35, label: '级别3' },
                );
            }

            for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
                const level = levels[levelIdx];
                const levelStart = performance.now();

                const thumbCount = Math.min(60, Math.max(5, Math.floor(videoDuration / level.interval)));
                const actualInterval = videoDuration / thumbCount;

                let captured = 0;
                for (let i = 0; i < thumbCount; i++) {
                    const time = i * actualInterval;
                    try {
                        const snappedTime = Math.round(time / level.interval) * level.interval;
                        
                        const existing = this.editor.getCachedThumb(material.id, snappedTime);
                        if (existing) continue;

                        video.currentTime = Math.min(time, videoDuration - 0.1);
                        await new Promise((resolve) => {
                            const onSeeked = () => {
                                video.removeEventListener('seeked', onSeeked);
                                resolve();
                            };
                            video.addEventListener('seeked', onSeeked);
                            setTimeout(() => {
                                video.removeEventListener('seeked', onSeeked);
                                resolve();
                            }, 2000);
                        });

                        if (video.readyState >= 2) {
                            ctx.drawImage(video, 0, 0, this.thumbWidth, this.thumbHeight);
                            const dataUrl = canvas.toDataURL('image/jpeg', level.quality);
                            this.editor.setCachedThumb(material.id, snappedTime, dataUrl);
                            captured++;
                        }
                    } catch (e) {}

                    if (i % 5 === 4) {
                        await new Promise(r => setTimeout(r, 5));
                    }
                }

                const levelElapsed = (performance.now() - levelStart) / 1000;
                console.log(`[ThumbPreloader] ✅ ${level.label}完成(${level.interval}s): ${material.name}, ${captured}张, ${levelElapsed.toFixed(1)}s`);

                if (levelIdx === 0) {
                    if (this.editor._scheduleThumbRefresh) {
                        this.editor._scheduleThumbRefresh();
                    }
                    this.editor.renderMaterials();

                    if (fileSizeMB > 100) {
                        console.log(`[ThumbPreloader] ⚠️ 大文件(${fileSizeMB.toFixed(0)}MB)跳过更高级别预加载`);
                        break;
                    }

                    if (this.audioPromises.has(material.id)) {
                        console.log(`[ThumbPreloader] 等待音频解码完成: ${material.name}`);
                        await this.audioPromises.get(material.id);
                        console.log(`[ThumbPreloader] 音频完成，继续级别2+: ${material.name}`);
                    }
                }
            }

            const totalElapsed = (performance.now() - startTime) / 1000;
            console.log(`[ThumbPreloader] ✅ 全部完成: ${material.name}, ${totalElapsed.toFixed(1)}s`);

        } finally {
            try { video.pause(); } catch (e) {}
            try { video.removeAttribute('src'); video.load(); } catch (e) {}
            if (video.parentNode) video.parentNode.removeChild(video);
        }
    }

    async requestFrame(material, targetTime, callback) {
        if (!material || material.type !== 'video') {
            callback(null);
            return;
        }

        const cached = this.editor.getCachedThumb(material.id, targetTime);
        if (cached) {
            callback(cached);
            return;
        }

        try {
            const demuxer = await mp4DemuxerCache.get(material);

            if (!demuxer.videoTrack || demuxer.videoSamples.length === 0) {
                callback(null);
                return;
            }

            const videoConfig = demuxer.getVideoConfig();
            if (!videoConfig) {
                callback(null);
                return;
            }

            const sampleIndex = this._findSampleIndex(demuxer, targetTime);
            if (sampleIndex === -1) {
                callback(null);
                return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = this.thumbWidth;
            canvas.height = this.thumbHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            let result = null;
            const decoder = new VideoDecoder({
                output: (frame) => {
                    ctx.drawImage(frame, 0, 0, this.thumbWidth, this.thumbHeight);
                    result = canvas.toDataURL('image/jpeg', 0.4);
                    this.editor.setCachedThumb(material.id, targetTime, result);
                    frame.close();
                },
                error: () => { result = null; }
            });

            decoder.configure(videoConfig);

            const chunk = await demuxer.getVideoChunk(sampleIndex);
            if (chunk) {
                decoder.decode(chunk);
            }

            await decoder.flush();
            decoder.close();

            callback(result);
        } catch (err) {
            console.warn(`[ThumbPreloader] 按需解码失败: ${material.name}`, err.message);
            callback(null);
        }
    }

    _findSampleIndex(demuxer, targetTime) {
        const samples = demuxer.videoSamples;
        if (!samples || samples.length === 0) return -1;

        let low = 0;
        let high = samples.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const sample = samples[mid];
            const sampleTime = sample.cts / 1000000;

            if (sampleTime <= targetTime) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return Math.max(0, high);
    }
}

const videoEditor = new VideoEditor();
window.editor = videoEditor; // 挂载到全局供截图等功能使用

document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.page-editor')) {
        videoEditor.init();
    }
});
