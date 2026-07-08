/**
 * 项目存储管理器
 *
 * 浏览器端项目持久化方案（混合策略）：
 * 1. 项目数据（clips、关键帧、画布设置等）→ IndexedDB 自动保存（防丢失）
 * 2. 素材文件本身：
 *    - 小文件（< 50MB，图片/短视频）→ Blob 存 IndexedDB（刷新不丢失）
 *    - 大文件（长视频）→ 只存元数据，刷新后提示重新定位素材
 * 3. 提供"导出项目"功能：导出为 .ai-director JSON 文件（不含素材二进制，方便分享）
 * 4. 提供"导入项目"功能：从 JSON 文件恢复项目，自动匹配本地已有素材
 *
 * IndexedDB 结构：
 *  - database: ai_director_db
 *  - objectStore: projects (keyPath: id)
 *  - objectStore: materials_blob (keyPath: materialId)  // 素材二进制缓存
 */
class ProjectStorage {
    constructor() {
        this.dbName = 'ai_director_db';
        this.dbVersion = 1;
        this.db = null;
        this._autoSaveTimer = null;
        this._autoSaveInterval = 30000;  // 30 秒自动保存一次
        this._currentProjectId = 'default';
    }

    async init() {
        if (typeof indexedDB === 'undefined') {
            console.warn('[ProjectStorage] IndexedDB 不支持，自动保存功能不可用');
            return false;
        }
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, this.dbVersion);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('projects')) {
                    db.createObjectStore('projects', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('materials_blob')) {
                    db.createObjectStore('materials_blob', { keyPath: 'materialId' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                console.log('[ProjectStorage] IndexedDB 初始化成功');
                resolve(true);
            };
            req.onerror = () => {
                console.error('[ProjectStorage] IndexedDB 初始化失败', req.error);
                resolve(false);
            };
        });
    }

    /**
     * 收集当前编辑器的项目数据（不含素材二进制）
     */
    serializeProject(editor) {
        return {
            id: this._currentProjectId,
            version: 1,
            name: editor.projectName || '未命名项目',
            savedAt: Date.now(),
            canvas: {
                width: editor.videoEngine ? editor.videoEngine.canvasW : 1920,
                height: editor.videoEngine ? editor.videoEngine.canvasH : 1080
            },
            // 素材元数据（不含 file/url/_blob/_arrayBuffer 等运行时状态）
            materials: (editor.materials || []).map(m => {
                const mat = { ...m };
                delete mat.url;
                delete mat.file;
                delete mat._blob;
                delete mat._arrayBuffer;
                delete mat._canvas;
                return mat;
            }),
            // 时间轴素材（剥离 material 引用）
            clips: editor.timelineClips.map(c => {
                const clip = { ...c };
                if (clip.keyframes) {
                    clip.keyframes = clip.keyframes.map(k => ({ ...k, props: { ...k.props } }));
                }
                if (clip.effects) clip.effects = { ...clip.effects };
                delete clip.material;  // 不存引用，加载时再挂回
                return clip;
            }),
            // 其他状态
            mainTrackIndex: editor.mainTrackIndex,
            minTrackIndex: editor.minTrackIndex,
            maxTrackIndex: editor.maxTrackIndex,
            trackStates: { ...editor.trackStates }
        };
    }

    /**
     * 保存项目到 IndexedDB
     */
    async saveProject(editor, name = null) {
        if (!this.db) {
            console.warn('[ProjectStorage] 数据库未初始化，无法保存');
            return false;
        }
        const data = this.serializeProject(editor);
        if (name) data.name = name;
        editor.projectName = data.name;

        // 同步保存所有带有 _blob 的素材二进制数据
        const blobPromises = (editor.materials || [])
            .filter(m => m._blob && m._blob instanceof Blob && !m._blobPersisted)
            .map(m => this.saveMaterialBlob(m.id, m._blob).then(ok => {
                if (ok) m._blobPersisted = true;
            }));

        await Promise.allSettled(blobPromises);

        return new Promise((resolve) => {
            const tx = this.db.transaction(['projects'], 'readwrite');
            const store = tx.objectStore('projects');
            const req = store.put(data);
            req.onsuccess = () => {
                console.log(`[ProjectStorage] 项目已保存: ${data.name}`);
                resolve(true);
            };
            req.onerror = () => {
                console.error('[ProjectStorage] 保存失败', req.error);
                resolve(false);
            };
        });
    }

    /**
     * 从 IndexedDB 加载项目
     */
    async loadProject(editor, projectId = 'default') {
        if (!this.db) return null;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['projects'], 'readonly');
            const store = tx.objectStore('projects');
            const req = store.get(projectId);
            req.onsuccess = () => {
                if (req.result) {
                    console.log(`[ProjectStorage] 加载项目: ${req.result.name}`);
                    resolve(req.result);
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        });
    }

    /**
     * 列出所有已保存的项目
     */
    async listProjects() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction(['projects'], 'readonly');
            const store = tx.objectStore('projects');
            const req = store.getAll();
            req.onsuccess = () => {
                const projects = (req.result || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    savedAt: p.savedAt,
                    clipCount: p.clips ? p.clips.length : 0
                }));
                resolve(projects);
            };
            req.onerror = () => resolve([]);
        });
    }

    /**
     * 删除项目
     */
    async deleteProject(projectId) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['projects'], 'readwrite');
            const store = tx.objectStore('projects');
            const req = store.delete(projectId);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    /**
     * 保存素材二进制（用于小文件持久化）
     */
    async saveMaterialBlob(materialId, blob) {
        if (!this.db) return false;
        // 超过 50MB 的文件不存（避免 IndexedDB 膨胀）
        if (blob.size > 50 * 1024 * 1024) return false;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['materials_blob'], 'readwrite');
            const store = tx.objectStore('materials_blob');
            const req = store.put({ materialId, blob, size: blob.size });
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    /**
     * 读取素材二进制
     */
    async loadMaterialBlob(materialId) {
        if (!this.db) return null;
        return new Promise((resolve) => {
            const tx = this.db.transaction(['materials_blob'], 'readonly');
            const store = tx.objectStore('materials_blob');
            const req = store.get(materialId);
            req.onsuccess = () => {
                resolve(req.result ? req.result.blob : null);
            };
            req.onerror = () => resolve(null);
        });
    }

    /**
     * 启动自动保存
     */
    startAutoSave(editor) {
        this.stopAutoSave();
        this._autoSaveTimer = setInterval(async () => {
            if (editor.timelineClips.length > 0 || editor.materials.length > 0) {
                await this.saveProject(editor);
            }
        }, this._autoSaveInterval);
        console.log(`[ProjectStorage] 自动保存已启动（每 ${this._autoSaveInterval / 1000} 秒）`);
    }

    stopAutoSave() {
        if (this._autoSaveTimer) {
            clearInterval(this._autoSaveTimer);
            this._autoSaveTimer = null;
        }
    }

    /**
     * 导出项目为 JSON 文件（不含素材二进制）
     */
    exportProjectAsFile(editor, filename = null) {
        const data = this.serializeProject(editor);
        // 标记为导出版本（不含素材二进制，方便分享）
        data.exportedAt = Date.now();

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (filename || data.name || 'project') + '.ai-director';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`[ProjectStorage] 项目已导出: ${a.download}`);
        return true;
    }

    /**
     * 从 JSON 文件导入项目
     * 返回项目数据，调用方负责应用到编辑器
     */
    async importProjectFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data.clips || !Array.isArray(data.clips)) {
                        throw new Error('无效的项目文件格式');
                    }
                    console.log(`[ProjectStorage] 项目文件已解析: ${data.name || '未命名'}`);
                    resolve(data);
                } catch (err) {
                    reject(new Error('项目文件解析失败: ' + err.message));
                }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }

    /**
     * 将项目数据应用到编辑器
     * @param editor 编辑器实例
     * @param data 项目数据
     * @param materialResolver 素材解析函数 (materialId) => { material, url, file }
     */
    async applyProjectToEditor(editor, data, materialResolver = null) {
        // 暂停历史记录，避免加载过程被记录
        if (editor.undoManager) editor.undoManager.suspend();

        try {
            // 清空当前状态
            editor.timelineClips = [];
            editor.materials = [];
            editor.selectedClipId = null;
            editor.selectedClipIds.clear();
            editor.selectedKeyframeIds.clear();

            // 恢复素材库
            for (const m of (data.materials || [])) {
                let material = { ...m };
                let resolved = null;
                if (materialResolver) {
                    resolved = await materialResolver(m.id, m);
                }
                if (resolved) {
                    material = { ...material, ...resolved };
                } else {
                    // 没有解析到本地文件，标记为需要重新定位
                    material.url = null;
                    material.file = null;
                    material.needsRelocation = true;
                }
                editor.materials.push(material);
            }

            // 修复缺失 textData 的字幕文本素材
            for (const m of editor.materials) {
                // 先恢复 isSubtitleText 标记（通过 clip 的 subtitleGroupId 推断）
                if (m.type === 'text' && m.isSubtitleText === undefined) {
                    const linkedClips = (data.clips || []).filter(c => c.materialId === m.id && c.subtitleGroupId);
                    if (linkedClips.length > 0) {
                        m.isSubtitleText = true;
                    }
                }
                if (m.type === 'audio' && m.isSubtitleAudio === undefined) {
                    const linkedClips = (data.clips || []).filter(c => c.materialId === m.id && c.subtitleGroupId);
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

            // 恢复时间轴素材
            for (const clip of (data.clips || [])) {
                const material = editor.materials.find(m => m.id === clip.materialId);
                editor.timelineClips.push({
                    ...clip,
                    material: material || null,
                    effects: clip.effects ? { ...clip.effects } : null,
                    keyframes: clip.keyframes ? clip.keyframes.map(k => ({ ...k, props: { ...k.props } })) : null
                });
            }

            // 恢复画布
            if (data.canvas && editor.videoEngine) {
                const w = data.canvas.width;
                const h = data.canvas.height;
                const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
                const g = gcd(w, h);
                editor.videoEngine.setCanvasRatio(w / g, h / g, Math.min(w, h));
            }

            // 恢复其他状态
            if (data.mainTrackIndex !== undefined) editor.mainTrackIndex = data.mainTrackIndex;
            if (data.minTrackIndex !== undefined) editor.minTrackIndex = data.minTrackIndex;
            if (data.maxTrackIndex !== undefined) editor.maxTrackIndex = data.maxTrackIndex;
            if (data.trackStates) editor.trackStates = { ...data.trackStates };
            if (data.name) editor.projectName = data.name;

            // 刷新 UI
            if (editor.videoRenderer) {
                editor.videoRenderer.setClips(editor.timelineClips);
            }
            editor.renderTimeline();
            editor.updateTotalDuration();
            editor.renderMaterials();
            editor.updatePropertiesPanel();
            editor.renderKeyframesList();

            // 重置历史栈，建立新基线
            if (editor.undoManager) {
                editor.undoManager.clear();
                editor.undoManager.initBaseline('导入项目');
            }

            // 提示需要重新定位的素材
            const missingMats = editor.materials.filter(m => m.needsRelocation);
            if (missingMats.length > 0) {
                console.warn(`[ProjectStorage] ${missingMats.length} 个素材需要重新定位:`, missingMats.map(m => m.name));
            }

            return { success: true, missingMaterials: missingMats };
        } finally {
            if (editor.undoManager) editor.undoManager.resume();
        }
    }
}

window.ProjectStorage = ProjectStorage;
