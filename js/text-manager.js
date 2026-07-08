/**
 * 文本素材管理模块
 * 负责文本的测量、渲染、虚拟素材生成
 */
class TextManager {
    constructor() {
        this._cache = new Map(); // materialId -> { image, width, height, textData }
        this._measureCanvas = document.createElement('canvas');
        this._measureCtx = this._measureCanvas.getContext('2d');
    }

    /**
     * 测量文本尺寸（根据当前 textData 设置）
     * @returns {{width: number, height: number, lineHeight: number}}
     */
    measureText(textData) {
        if (!textData) {
            textData = {};
        }
        const ctx = this._measureCtx;
        const fontSize = textData.fontSize || 48;
        const lineHeight = (textData.lineHeight || 1.05) * fontSize;
        const fontWeight = textData.fontWeight || 'normal';
        const fontStyle = textData.fontStyle || 'normal';
        const fontFamily = textData.fontFamily || 'Microsoft YaHei, sans-serif';
        const letterSpacing = textData.letterSpacing || 0;
        const padding = textData.padding || 0;

        ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;

        const frameWidth = textData.frameWidth || 800;
        const effectiveMaxWidth = Math.max(50, frameWidth - padding * 2);
        const lines = this._wrapText(ctx, textData.text || '', effectiveMaxWidth, textData);

        let contentWidth = 0;
        let maxAscent = 0;
        let maxDescent = 0;
        for (const line of lines) {
            const extra = Math.max(0, line.length - 1) * letterSpacing;
            const w = ctx.measureText(line).width + extra;
            if (w > contentWidth) contentWidth = w;
            const metrics = ctx.measureText(line || 'M');
            if (metrics.actualBoundingBoxAscent > maxAscent) maxAscent = metrics.actualBoundingBoxAscent;
            if (metrics.actualBoundingBoxDescent > maxDescent) maxDescent = metrics.actualBoundingBoxDescent;
        }

        if (maxAscent === 0) maxAscent = fontSize * 0.75;
        if (maxDescent === 0) maxDescent = fontSize * 0.25;

        const lineContentHeight = maxAscent + maxDescent;
        const extraLineSpace = Math.max(0, lineHeight - lineContentHeight);
        const linesTotalHeight = lines.length * lineContentHeight + (lines.length - 1) * extraLineSpace;
        const contentHeight = linesTotalHeight + padding * 2;

        const frameHeight = (textData.frameHeight !== undefined && textData.frameHeight !== null) ? textData.frameHeight : contentHeight;
        const finalHeight = Math.max(contentHeight, frameHeight);

        return {
            width: Math.ceil(frameWidth),
            height: Math.ceil(finalHeight),
            lines,
            fontSize,
            lineHeight,
            letterSpacing,
            ascent: maxAscent,
            descent: maxDescent,
            extraLineSpace,
            contentWidth: Math.ceil(contentWidth + padding * 2),
            contentHeight: Math.ceil(contentHeight)
        };
    }

    /**
     * 自动换行（简单实现，按 maxWidth 拆分）
     */
    _wrapText(ctx, text, maxWidth, textData) {
        if (!text) return [''];
        const letterSpacing = textData.letterSpacing || 0;
        const manualLines = text.split(/\r?\n/);
        const result = [];
        for (const manualLine of manualLines) {
            if (!manualLine) {
                result.push('');
                continue;
            }
            let current = '';
            for (const ch of manualLine) {
                const test = current + ch;
                const extra = Math.max(0, test.length - 1) * letterSpacing;
                const w = ctx.measureText(test).width + extra;
                if (w > maxWidth && current) {
                    result.push(current);
                    current = ch;
                } else {
                    current = test;
                }
            }
            if (current) result.push(current);
        }
        return result.length > 0 ? result : [''];
    }

    /**
     * 获取或生成文本对应的虚拟 image
     * @param {Object} material 文本素材（type='text'，textData=...）
     * @returns {HTMLCanvasElement}
     */
    getOrCreateTextImage(material) {
        if (!material || material.type !== 'text') return null;
        const cacheKey = this._getCacheKey(material);
        if (this._cache.has(material.id)) {
            const cached = this._cache.get(material.id);
            if (cached.key === cacheKey) {
                return cached;
            }
        }
        const measured = this.measureText(material.textData);
        const canvas = document.createElement('canvas');
        canvas.width = measured.width;
        canvas.height = measured.height;
        const ctx = canvas.getContext('2d');
        this._drawText(ctx, material.textData, measured);
        const cached = { image: canvas, ...measured, key: cacheKey };
        this._cache.set(material.id, cached);
        return cached;
    }

    /**
     * 主动失效缓存（文本属性变更后调用）
     */
    invalidate(materialId) {
        if (materialId !== undefined) {
            this._cache.delete(materialId);
        } else {
            this._cache.clear();
        }
    }

    _getCacheKey(material) {
        const td = material.textData || {};
        return JSON.stringify({
            t: td.text,
            fs: td.fontSize,
            lh: td.lineHeight,
            ls: td.letterSpacing,
            fw: td.fontWeight,
            fst: td.fontStyle,
            td: td.textDecoration,
            ff: td.fontFamily,
            c: td.color,
            mw: td.maxWidth,
            fwdt: td.frameWidth,
            fh: td.frameHeight,
            p: td.padding,
            a: td.align,
            s: td.stroke ? `${td.stroke.color}|${td.stroke.width}` : '',
            sh: td.shadow ? 1 : 0
        });
    }

    /**
     * 在指定 ctx 上绘制文本（保持左上角开始排版）
     */
    drawText(ctx, textData, x, y, w, h, options = {}) {
        const measured = this.measureText(textData);
        const scaleX = w / measured.width;
        const scaleY = h / measured.height;
        const fontScale = Math.min(scaleX, scaleY);
        // 调整字号以适应宽度/高度
        const effectiveFontSize = measured.fontSize * fontScale;
        const effectiveLineHeight = measured.lineHeight * fontScale;

        ctx.save();
        ctx.translate(x, y);
        ctx.font = `${textData.fontStyle || 'normal'} ${textData.fontWeight || 'normal'} ${effectiveFontSize}px ${textData.fontFamily || 'Microsoft YaHei, sans-serif'}`;
        ctx.fillStyle = textData.color || '#ffffff';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';

        // 阴影
        if (textData.shadow) {
            ctx.shadowColor = textData.shadow.color || 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = (textData.shadow.blur || 4) * fontScale;
            ctx.shadowOffsetX = (textData.shadow.offsetX || 0) * fontScale;
            ctx.shadowOffsetY = (textData.shadow.offsetY || 0) * fontScale;
        }

        // 描边
        if (textData.stroke && textData.stroke.width > 0) {
            ctx.strokeStyle = textData.stroke.color || '#000000';
            ctx.lineWidth = textData.stroke.width * fontScale;
        }

        const padding = (textData.padding || 0) * fontScale;
        for (let i = 0; i < measured.lines.length; i++) {
            const lineY = padding + i * effectiveLineHeight;
            if (textData.stroke && textData.stroke.width > 0) {
                ctx.strokeText(measured.lines[i], padding, lineY);
            }
            ctx.fillText(measured.lines[i], padding, lineY);
        }
        ctx.restore();
    }

    _drawText(ctx, textData, measured) {
        const padding = (textData.padding || 0);
        const align = textData.align || 'center';
        const letterSpacing = textData.letterSpacing || 0;
        const textDecoration = textData.textDecoration || 'none';
        ctx.font = `${textData.fontStyle || 'normal'} ${textData.fontWeight || 'normal'} ${measured.fontSize}px ${textData.fontFamily || 'Microsoft YaHei, sans-serif'}`;
        ctx.fillStyle = textData.color || '#ffffff';
        ctx.textBaseline = 'alphabetic';

        if (textData.shadow) {
            ctx.shadowColor = textData.shadow.color || 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = textData.shadow.blur || 4;
            ctx.shadowOffsetX = textData.shadow.offsetX || 0;
            ctx.shadowOffsetY = textData.shadow.offsetY || 0;
        }

        if (textData.stroke && textData.stroke.width > 0) {
            ctx.strokeStyle = textData.stroke.color || '#000000';
            ctx.lineWidth = textData.stroke.width;
        }

        ctx.textAlign = 'left';

        const frameWidth = textData.frameWidth || measured.width;
        const ascent = measured.ascent || measured.fontSize * 0.75;
        const descent = measured.descent || measured.fontSize * 0.25;

        for (let i = 0; i < measured.lines.length; i++) {
            const line = measured.lines[i];
            const lineMetrics = ctx.measureText(line || 'M');
            const lineAscent = lineMetrics.actualBoundingBoxAscent || ascent;
            const lineDescent = lineMetrics.actualBoundingBoxDescent || descent;

            const lineW = ctx.measureText(line).width + Math.max(0, line.length - 1) * letterSpacing;

            let startX;
            if (align === 'center') {
                startX = (frameWidth - lineW) / 2;
            } else if (align === 'right') {
                startX = frameWidth - padding - lineW;
            } else {
                startX = padding;
            }

            const baselineY = padding + lineAscent + i * (measured.lineHeight || measured.fontSize);

            let curX = startX;
            if (letterSpacing === 0) {
                if (textData.stroke && textData.stroke.width > 0) {
                    ctx.strokeText(line, startX, baselineY);
                }
                ctx.fillText(line, startX, baselineY);
            } else {
                for (let c = 0; c < line.length; c++) {
                    const ch = line[c];
                    if (textData.stroke && textData.stroke.width > 0) {
                        ctx.strokeText(ch, curX, baselineY);
                    }
                    ctx.fillText(ch, curX, baselineY);
                    curX += ctx.measureText(ch).width + letterSpacing;
                }
            }

            if (textDecoration === 'underline') {
                const underlineY = baselineY + lineDescent * 0.5;
                ctx.save();
                ctx.strokeStyle = textData.color || '#ffffff';
                ctx.lineWidth = Math.max(1, measured.fontSize / 16);
                ctx.beginPath();
                ctx.moveTo(startX, underlineY);
                ctx.lineTo(startX + lineW, underlineY);
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    /**
     * 创建默认文本素材对象
     */
    static createDefaultMaterial() {
        return {
            id: 'text_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
            name: '默认文本',
            type: 'text',
            size: 0,
            duration: 3,
            textData: {
                text: '默认文本',
                fontSize: 96,
                lineHeight: 1.05,
                letterSpacing: 0,
                fontWeight: 'normal',
                fontStyle: 'normal',
                textDecoration: 'none',
                fontFamily: 'Microsoft YaHei, sans-serif',
                color: '#ffffff',
                maxWidth: 1200,
                frameWidth: 800,
                frameHeight: null,
                padding: 20,
                align: 'center',
                stroke: { color: '#000000', width: 0 },
                shadow: null
            }
        };
    }

    /**
     * 创建字幕文本素材对象
     * @param {string} text 单句字幕文本
     * @param {string} style 样式预设：'default' | 'outline'
     * @returns {Object}
     */
    static createSubtitleMaterial(text, style = 'default') {
        const material = TextManager.createDefaultMaterial();
        material.name = text || '字幕';
        material.duration = Infinity;
        material.textData.text = text || '';
        material.textData.fontSize = 72;
        material.textData.maxWidth = 1400;
        material.textData.frameWidth = 1400;
        material.textData.frameHeight = null;
        material.textData.padding = 16;
        material.textData.align = 'center';
        material.textData.color = '#ffffff';
        material.textData.stroke = { color: '#000000', width: style === 'outline' ? 6 : 0 };
        material.textData.shadow = null;
        return material;
    }
}

// 全局实例
window.TextManager = TextManager;
