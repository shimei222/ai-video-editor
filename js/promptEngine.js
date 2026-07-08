const PromptEngine = {
    modelConfigs: {
        jimeng: {
            name: '即梦',
            promptTemplate: '{description}，{shot}，{move}，{tone}，{style}，{lighting}，{effect}，电影级画面，4K高清，极致细节，专业摄影',
            negativePrompt: '模糊，低质量，变形，丑陋，不自然，噪点，像素化'
        },
        keling: {
            name: '可灵',
            promptTemplate: '【场景】{description}\n【景别】{shot}\n【运镜】{move}\n【色调】{tone}\n【风格】{style}\n【光影】{lighting}\n【特效】{effect}\n整体要求：电影质感，高分辨率，细节丰富，专业级视频效果',
            negativePrompt: '模糊不清，画质低劣，人物变形，色彩失真，构图混乱'
        },
        xiaoyunque: {
            name: '小云雀',
            promptTemplate: '{description}。画面采用{shot}，{move}，{tone}调色，{style}画风，{lighting}效果，{effect}加持。高质量视频生成，流畅自然，细节清晰。',
            negativePrompt: '模糊，低清，扭曲，不自然，瑕疵'
        },
        general: {
            name: '通用',
            promptTemplate: '{description}，{shot}，{move}，{tone}，{style}，{lighting}，{effect}，高品质，细节丰富，专业制作',
            negativePrompt: '低质量，模糊，变形'
        }
    },

    generateWithTemplate(description, params, model) {
        const config = this.modelConfigs[model] || this.modelConfigs.general;
        
        const promptText = config.promptTemplate
            .replace('{description}', description)
            .replace('{shot}', params.shot)
            .replace('{move}', params.move)
            .replace('{tone}', params.tone)
            .replace('{style}', params.style)
            .replace('{lighting}', params.lighting)
            .replace('{effect}', params.effect);

        const fullPrompt = `${promptText}\n\n---\n\n【负面提示词】\n${config.negativePrompt}`;

        return {
            text: fullPrompt,
            model: model,
            params: { ...params },
            description: description
        };
    },

    async generateWithAI(description, params, model, apiKey) {
        const config = this.modelConfigs[model] || this.modelConfigs.general;
        
        const systemPrompt = `你是一位专业的影视导演和AI提示词工程师。你的任务是将用户的简单描述转化为专业的、高质量的AI视频生成提示词。

请遵循以下规则：
1. 提示词要具体、生动，包含丰富的视觉细节
2. 融入专业的电影语言（景别、运镜、光影、色调等）
3. 针对目标模型（${config.name}）进行优化
4. 输出格式要清晰，便于直接复制使用
5. 同时提供正面提示词和负面提示词

当前参数：
- 景别：${params.shot}
- 运镜：${params.move}
- 色调：${params.tone}
- 画风：${params.style}
- 光影：${params.lighting}
- 特效：${params.effect}`;

        const userPrompt = `请基于以下描述生成专业的AI视频提示词：

"${description}"

请生成完整的正面提示词和负面提示词，直接输出结果，不要解释。`;

        try {
            const response = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.8,
                    max_tokens: 1000
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `API请求失败 (${response.status})`);
            }

            const data = await response.json();
            const aiGeneratedText = data.choices?.[0]?.message?.content || '';

            if (!aiGeneratedText) {
                throw new Error('API返回内容为空');
            }

            return {
                text: aiGeneratedText.trim(),
                model: model,
                params: { ...params },
                description: description,
                aiGenerated: true
            };

        } catch (error) {
            console.error('DeepSeek API调用失败:', error);
            
            if (error.message.includes('Failed to fetch') || error.message.includes('Network')) {
                throw new Error('网络连接失败，请检查网络或使用本地模板模式');
            }
            
            throw error;
        }
    },

    generateStoryboardPrompt(shots, model) {
        const config = this.modelConfigs[model] || this.modelConfigs.general;
        
        const shotPrompts = shots.map((shot, index) => {
            return `镜头 ${index + 1} (${shot.duration}s):
${shot.description}
景别: ${shot.shot}
运镜: ${shot.move}
转场: ${shot.transition}`;
        }).join('\n\n');

        return {
            text: `【分镜脚本】\n\n${shotPrompts}\n\n【整体风格】\n色调: 统一电影感色调\n画质: 4K高清，电影级质感`,
            shots: shots,
            model: model
        };
    }
};
