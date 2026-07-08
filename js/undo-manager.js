/**
 * 撤销/重做管理器
 * 采用快照式存储：每次操作完成后保存当前 timelineClips 状态
 * 最多保留 50 步历史，超出后丢弃最早的记录
 *
 * 内存估算：单个 clip 约 1-2 KB，50 步 × 50 clip ≈ 5 MB（完全可接受）
 */
class UndoManager {
    constructor(editor, maxHistory = 50) {
        this.editor = editor;
        this.maxHistory = maxHistory;
        this.stack = [];          // 历史快照数组
        this.currentIndex = -1;   // 当前有效状态在 stack 中的索引
        this.isUndoing = false;   // 撤销/重做进行中标志，防止回调污染历史
        this._suspendDepth = 0;   // 暂存历史记录的嵌套计数（事务支持）
    }

    /**
     * 拍摄当前状态快照
     * 注意：material 对象只保留引用，不深拷贝（避免重复存储大文件对象）
     */
    snapshot() {
        return {
            clips: this.editor.timelineClips.map(c => this._cloneClip(c)),
            selectedClipId: this.editor.selectedClipId,
            selectedClipIds: Array.from(this.editor.selectedClipIds),
            selectedKeyframeIds: Array.from(this.editor.selectedKeyframeIds),
            currentTime: this.editor.currentTime
        };
    }

    _cloneClip(clip) {
        const clone = { ...clip };
        if (clip.keyframes) {
            clone.keyframes = clip.keyframes.map(k => ({
                ...k,
                props: { ...k.props }
            }));
        }
        if (clip.effects) clone.effects = { ...clip.effects };
        // material 不深拷贝，保持引用共享（素材库不变）
        return clone;
    }

    /**
     * 恢复到指定快照
     */
    restore(snapshot) {
        // 保留 material 引用映射，避免恢复后素材丢失
        const oldClips = this.editor.timelineClips || [];
        const materialMap = new Map();
        for (const c of oldClips) {
            if (c.material) materialMap.set(c.id, c.material);
        }

        this.editor.timelineClips = snapshot.clips.map(c => {
            const clone = this._cloneClip(c);
            // 重新挂载 material 引用
            clone.material = materialMap.get(c.id) ||
                (this.editor.materials || []).find(m => m.id === c.materialId) ||
                null;
            return clone;
        });

        this.editor.selectedClipId = snapshot.selectedClipId;
        this.editor.selectedClipIds = new Set(snapshot.selectedClipIds);
        this.editor.selectedKeyframeIds = new Set(snapshot.selectedKeyframeIds);

        // 同步渲染器
        if (this.editor.videoRenderer) {
            this.editor.videoRenderer.setClips(this.editor.timelineClips);
            if (this.editor.videoRenderer.setSelectedClip) {
                this.editor.videoRenderer.setSelectedClip(snapshot.selectedClipId);
            }
        }

        // 刷新 UI
        if (this.editor.renderTimeline) this.editor.renderTimeline();
        if (this.editor.updateTotalDuration) this.editor.updateTotalDuration();
        if (this.editor.updatePropertiesPanel) this.editor.updatePropertiesPanel();
        if (this.editor.renderKeyframesList) this.editor.renderKeyframesList();
    }

    /**
     * 记录一次操作完成后的状态
     * 调用时机：操作完成后立即调用
     */
    push(description = '') {
        // 撤销/重做期间或暂停期间不记录
        if (this.isUndoing || this._suspendDepth > 0) return;

        const snap = this.snapshot();

        // 截断重做栈（撤销后又有新操作，丢弃后面的）
        this.stack = this.stack.slice(0, this.currentIndex + 1);
        this.stack.push({ state: snap, description });

        // 超出最大历史时丢弃最早的
        if (this.stack.length > this.maxHistory) {
            this.stack.shift();
        } else {
            this.currentIndex++;
        }

        this._updateUI();
    }

    /**
     * 撤销
     */
    undo() {
        if (!this.canUndo()) return false;
        this.isUndoing = true;
        try {
            this.currentIndex--;
            this.restore(this.stack[this.currentIndex].state);
        } finally {
            this.isUndoing = false;
        }
        this._updateUI();
        return true;
    }

    /**
     * 重做
     */
    redo() {
        if (!this.canRedo()) return false;
        this.isUndoing = true;
        try {
            this.currentIndex++;
            this.restore(this.stack[this.currentIndex].state);
        } finally {
            this.isUndoing = false;
        }
        this._updateUI();
        return true;
    }

    canUndo() { return this.currentIndex > 0; }
    canRedo() { return this.currentIndex < this.stack.length - 1; }

    /**
     * 初始化基线快照（项目打开/清空时调用）
     */
    initBaseline(description = '初始状态') {
        this.stack = [{ state: this.snapshot(), description }];
        this.currentIndex = 0;
        this._updateUI();
    }

    /**
     * 清空所有历史（导入新项目时使用）
     */
    clear() {
        this.stack = [];
        this.currentIndex = -1;
        this._updateUI();
    }

    /**
     * 暂停历史记录（事务开始）
     * 用于批量操作期间不记录中间态
     */
    suspend() {
        this._suspendDepth++;
    }

    /**
     * 恢复历史记录（事务结束）
     */
    resume() {
        if (this._suspendDepth > 0) this._suspendDepth--;
    }

    _updateUI() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) {
            undoBtn.disabled = !this.canUndo();
            undoBtn.classList.toggle('disabled', !this.canUndo());
        }
        if (redoBtn) {
            redoBtn.disabled = !this.canRedo();
            redoBtn.classList.toggle('disabled', !this.canRedo());
        }
    }

    getStats() {
        return {
            stackSize: this.stack.length,
            currentIndex: this.currentIndex,
            canUndo: this.canUndo(),
            canRedo: this.canRedo()
        };
    }
}

window.UndoManager = UndoManager;
