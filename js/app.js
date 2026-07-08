const AppState = {
    currentPage: 'home',
    selectedParams: {
        shot: '特写',
        move: '固定镜头',
        tone: '暖色调',
        style: '超写实风格',
        lighting: '自然光',
        effect: '无特效'
    },
    selectedModel: 'jimeng',
    aiModel: 'template',
    apiKey: '',
    theme: 'dark',
    accentColor: 'indigo',
    userLevel: 1,
    userExp: 25,
    achievements: [],
    generatedPromptsCount: 0
};

const App = {
    init() {
        this.loadState();
        this.setupNavigation();
        this.setupParameterSelection();
        this.setupModelSelection();
        this.setupAIModelSelection();
        this.setupGenerateButton();
        this.setupSettingsPage();
        this.setupFeatureCards();
        this.setupEditorPage();
        this.updateUserInfo();
    },

    loadState() {
        const savedApiKey = localStorage.getItem('ai_director_api_key');
        if (savedApiKey) {
            AppState.apiKey = savedApiKey;
        }

        const savedAiModel = localStorage.getItem('ai_director_ai_model');
        if (savedAiModel) {
            AppState.aiModel = savedAiModel;
        }

        const savedTheme = localStorage.getItem('ai_director_theme');
        if (savedTheme) {
            AppState.theme = savedTheme;
        }

        const savedColor = localStorage.getItem('ai_director_accent_color');
        if (savedColor) {
            AppState.accentColor = savedColor;
        }

        const savedLevel = localStorage.getItem('ai_director_level');
        if (savedLevel) {
            AppState.userLevel = parseInt(savedLevel);
        }

        const savedExp = localStorage.getItem('ai_director_exp');
        if (savedExp) {
            AppState.userExp = parseInt(savedExp);
        }

        const savedPrompts = localStorage.getItem('ai_director_prompts_count');
        if (savedPrompts) {
            AppState.generatedPromptsCount = parseInt(savedPrompts);
        }
    },

    saveState() {
        localStorage.setItem('ai_director_api_key', AppState.apiKey);
        localStorage.setItem('ai_director_ai_model', AppState.aiModel);
        localStorage.setItem('ai_director_theme', AppState.theme);
        localStorage.setItem('ai_director_accent_color', AppState.accentColor);
        localStorage.setItem('ai_director_level', AppState.userLevel.toString());
        localStorage.setItem('ai_director_exp', AppState.userExp.toString());
        localStorage.setItem('ai_director_prompts_count', AppState.generatedPromptsCount.toString());
    },

    setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', () => {
                const page = item.dataset.page;
                this.navigateTo(page);
            });
        });
    },

    navigateTo(page) {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });

        document.querySelectorAll('.page').forEach(p => {
            p.classList.toggle('active', p.classList.contains(`page-${page}`));
        });

        AppState.currentPage = page;
    },

    setupFeatureCards() {
        document.querySelectorAll('.feature-card').forEach(card => {
            card.addEventListener('click', () => {
                const page = card.dataset.page;
                if (page) {
                    this.navigateTo(page);
                }
            });
        });
    },

    setupParameterSelection() {
        document.querySelectorAll('.param-options').forEach(group => {
            const paramName = group.dataset.param;
            const options = group.querySelectorAll('.param-option');
            
            options.forEach(option => {
                option.addEventListener('click', () => {
                    options.forEach(o => o.classList.remove('active'));
                    option.classList.add('active');
                    AppState.selectedParams[paramName] = option.dataset.value;
                });
            });
        });
    },

    setupModelSelection() {
        const modelOptions = document.querySelectorAll('.page-prompt .model-option');
        modelOptions.forEach(option => {
            option.addEventListener('click', () => {
                modelOptions.forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                AppState.selectedModel = option.dataset.model;
            });
        });
    },

    setupAIModelSelection() {
        const modelOptions = document.querySelectorAll('.settings-section .model-option');
        modelOptions.forEach(option => {
            option.addEventListener('click', () => {
                modelOptions.forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                AppState.aiModel = option.dataset.model;
                this.saveState();
                this.showToast('AI模型设置已保存');
            });
        });

        const savedModelOption = document.querySelector(`.settings-section .model-option[data-model="${AppState.aiModel}"]`);
        if (savedModelOption) {
            modelOptions.forEach(o => o.classList.remove('active'));
            savedModelOption.classList.add('active');
        }
    },

    setupGenerateButton() {
        const generateBtn = document.getElementById('generateBtn');
        const copyBtn = document.getElementById('copyBtn');
        const downloadBtn = document.getElementById('downloadBtn');

        if (generateBtn) {
            generateBtn.addEventListener('click', () => this.generatePrompt());
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', () => this.copyPrompt());
        }

        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => this.downloadPrompt());
        }
    },

    async generatePrompt() {
        const description = document.getElementById('sceneDescription').value.trim();
        
        if (!description) {
            this.showToast('请先描述你的场景', 'warning');
            return;
        }

        this.showLoading('正在生成专业提示词...');

        try {
            let prompt;
            
            if (AppState.aiModel === 'deepseek' && AppState.apiKey) {
                prompt = await PromptEngine.generateWithAI(description, AppState.selectedParams, AppState.selectedModel, AppState.apiKey);
            } else {
                prompt = PromptEngine.generateWithTemplate(description, AppState.selectedParams, AppState.selectedModel);
            }

            this.displayPrompt(prompt);
            this.addExp(5);
            AppState.generatedPromptsCount++;
            this.saveState();
            
        } catch (error) {
            console.error('生成失败:', error);
            this.showToast('生成失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    },

    displayPrompt(prompt) {
        const outputEl = document.getElementById('promptOutput');
        const breakdownEl = document.getElementById('promptBreakdown');
        
        if (outputEl) {
            outputEl.innerHTML = '';
            outputEl.textContent = prompt.text;
        }

        if (breakdownEl) {
            breakdownEl.style.display = 'block';
            
            const bdShot = document.getElementById('bd-shot');
            const bdMove = document.getElementById('bd-move');
            const bdTone = document.getElementById('bd-tone');
            const bdStyle = document.getElementById('bd-style');
            const bdLighting = document.getElementById('bd-lighting');
            const bdEffect = document.getElementById('bd-effect');

            if (bdShot) bdShot.textContent = AppState.selectedParams.shot;
            if (bdMove) bdMove.textContent = AppState.selectedParams.move;
            if (bdTone) bdTone.textContent = AppState.selectedParams.tone;
            if (bdStyle) bdStyle.textContent = AppState.selectedParams.style;
            if (bdLighting) bdLighting.textContent = AppState.selectedParams.lighting;
            if (bdEffect) bdEffect.textContent = AppState.selectedParams.effect;
        }

        this.currentPrompt = prompt.text;
    },

    copyPrompt() {
        if (!this.currentPrompt) {
            this.showToast('请先生成提示词', 'warning');
            return;
        }

        navigator.clipboard.writeText(this.currentPrompt).then(() => {
            this.showToast('已复制到剪贴板');
        }).catch(() => {
            this.showToast('复制失败', 'error');
        });
    },

    downloadPrompt() {
        if (!this.currentPrompt) {
            this.showToast('请先生成提示词', 'warning');
            return;
        }

        const blob = new Blob([this.currentPrompt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompt_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showToast('提示词已下载');
    },

    setupSettingsPage() {
        const apiKeyInput = document.getElementById('apiKeyInput');
        const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');

        if (apiKeyInput && AppState.apiKey) {
            apiKeyInput.value = AppState.apiKey;
        }

        if (saveApiKeyBtn) {
            saveApiKeyBtn.addEventListener('click', () => {
                const key = apiKeyInput.value.trim();
                AppState.apiKey = key;
                this.saveState();
                this.showToast('API Key 已保存');
            });
        }

        this.setupThemeOptions();
        this.setupColorOptions();
    },

    setupThemeOptions() {
        const themeOptions = document.querySelectorAll('.theme-option');
        themeOptions.forEach(option => {
            option.addEventListener('click', () => {
                themeOptions.forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                AppState.theme = option.dataset.theme;
                this.saveState();
                this.showToast('主题设置已保存');
            });
        });

        const savedThemeOption = document.querySelector(`.theme-option[data-theme="${AppState.theme}"]`);
        if (savedThemeOption) {
            themeOptions.forEach(o => o.classList.remove('active'));
            savedThemeOption.classList.add('active');
        }
    },

    setupColorOptions() {
        const colorOptions = document.querySelectorAll('.color-option');
        colorOptions.forEach(option => {
            option.addEventListener('click', () => {
                colorOptions.forEach(o => o.classList.remove('active'));
                option.classList.add('active');
                AppState.accentColor = option.dataset.color;
                this.saveState();
                this.showToast('强调色已更新');
            });
        });

        const savedColorOption = document.querySelector(`.color-option[data-color="${AppState.accentColor}"]`);
        if (savedColorOption) {
            colorOptions.forEach(o => o.classList.remove('active'));
            savedColorOption.classList.add('active');
        }
    },

    updateUserInfo() {
        const levelBadges = document.querySelectorAll('.level-badge, .user-level');
        const expFill = document.querySelector('.exp-fill');
        const expText = document.querySelector('.exp-text');

        levelBadges.forEach(el => {
            if (el.classList.contains('level-badge') || el.classList.contains('user-level')) {
                el.textContent = `Lv.${AppState.userLevel}`;
            }
        });

        if (expFill) {
            const expPercent = (AppState.userExp % 100);
            expFill.style.width = `${expPercent}%`;
        }

        if (expText) {
            expText.textContent = `${AppState.userExp % 100} / 100 EXP`;
        }
    },

    addExp(amount) {
        AppState.userExp += amount;
        const newLevel = Math.floor(AppState.userExp / 100) + 1;
        
        if (newLevel > AppState.userLevel) {
            AppState.userLevel = newLevel;
            this.showToast(`恭喜！升级到 Lv.${newLevel}！`, 'success');
        }
        
        this.updateUserInfo();
        this.saveState();
    },

    showLoading(text = '加载中...') {
        const overlay = document.getElementById('loadingOverlay');
        if (!overlay) return;
        
        const loadingText = overlay.querySelector('.loading-text') || overlay.querySelector('.loading-content p');
        if (loadingText) {
            loadingText.textContent = text;
        }
        
        // 隐藏进度条和详情（普通加载不需要）
        const progress = overlay.querySelector('.loading-progress');
        const detail = overlay.querySelector('.loading-detail');
        if (progress) progress.style.display = 'none';
        if (detail) detail.style.display = 'none';
        
        overlay.classList.add('show');
    },

    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.remove('show');
        }
    },

    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        const toastMessage = document.getElementById('toastMessage');
        
        if (!toast || !toastMessage) return;

        toastMessage.textContent = message;
        
        toast.style.background = type === 'success' ? 'var(--success-color)' :
                                 type === 'error' ? 'var(--danger-color)' :
                                 type === 'warning' ? 'var(--warning-color)' :
                                 'var(--success-color)';

        const icon = toast.querySelector('i');
        if (icon) {
            icon.className = type === 'success' ? 'fa-solid fa-check-circle' :
                            type === 'error' ? 'fa-solid fa-exclamation-circle' :
                            type === 'warning' ? 'fa-solid fa-exclamation-triangle' :
                            'fa-solid fa-check-circle';
        }

        toast.style.display = 'flex';
        
        setTimeout(() => {
            toast.style.display = 'none';
        }, 3000);
    },

    setupEditorPage() {
        // 左侧素材面板tab切换（仅切换视觉样式，功能逻辑由 VideoEditor 处理）
        document.querySelectorAll('.panel-tab-h').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.panel-tab-h').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                if (window.editor && window.editor.renderMaterials) {
                    window.editor.renderMaterials();
                }
            });
        });

        // 素材来源切换
        document.querySelectorAll('.source-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.source-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
        });

        // 镜像按钮视觉切换
        document.querySelectorAll('.mirror-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
            });
        });
    }
};

document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
